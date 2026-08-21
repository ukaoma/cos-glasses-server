// Behavioral tests for the real occupancy probes, against a real filesystem.
//
// WHY A DOT-DIRECTORY FIXTURE. Both production data roots are dot directories
// (`~/.claude`, `~/.codex`). A bare `mkdtemp` root cannot contain a dot component,
// and this repo has already shipped a bug that was invisible for exactly that
// reason: `res.sendFile` refuses any absolute path containing a dot component, so
// every audio route 404'd on a default install while a mktemp-rooted suite stayed
// green. So the fixture root here is `<mkdtemp>/.claude/...` and
// `<mkdtemp>/.codex/...`, mirroring the real shape.
//
// WHAT IS ASSERTED. The outcome a caller depends on, which for this module is
// almost always `threadOccupancy(...).attachable` and its reason — not the
// intermediate value a probe returned. A test that pinned "readDir returned []"
// would pin the fail-open as correct, so the readDir tests assert that it THROWS
// and the integration tests assert the refusal that throw produces.
//
// NO SOURCE-SHAPE ASSERTIONS. Every check here runs the code.

import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  claudeSessionsDir,
  codexLocksDir,
  dirExists,
  fileExists,
  interpretLockHolders,
  interpretPsLstart,
  isAlive,
  lockHolders,
  type ProbeOutcome,
  processStartMs,
  readDir,
  readFile,
  buildOccupancyProbes,
  realOccupancyDirs,
  realOccupancyProbes,
  withTranscriptClock,
} from './occupancy-probes.js'
import { realNativeHeadDeps, type NativeHeadDeps } from './native-head.js'
import {
  holderActivity,
  processStartMatches,
  threadOccupancy,
  type OccupancyDirs,
} from './thread-occupancy.js'

const THREAD_A = '096fc233-689b-4a88-aa97-9353813c7e7d'
const THREAD_B = '019fc80a-cc79-7921-8541-298e71695afd'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Render epoch ms the way `ps -o lstart=` does under TZ=UTC. */
function psLstartUtc(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}

/**
 * This process's start, from a source that is NOT `ps`.
 *
 * `process.uptime()` is measured inside Node from its own start, so comparing the
 * probe against it is an independent oracle rather than a restatement of the same
 * subprocess. It is what makes a timezone regression in `processStartMs` visible:
 * a local-time reading would land whole hours away from this.
 */
function selfStartMsFromNode(): number {
  return Date.now() - process.uptime() * 1000
}

/** A pid that is definitely gone and definitely was real. */
async function reapedPid(): Promise<number> {
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  const pid = child.pid!
  await new Promise<void>(resolve => {
    child.on('exit', () => resolve())
    child.kill('SIGKILL')
  })
  return pid
}

interface Fixture {
  root: string
  sessionsDir: string
  locksDir: string
  dirs: OccupancyDirs
}

let fx: Fixture
const restoreEnv: Array<[string, string | undefined]> = []
const openFds: number[] = []
const chmodRestore: string[] = []

function setEnv(key: string, value: string | undefined): void {
  restoreEnv.push([key, process.env[key]])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'cos-occupancy-'))
  // Dot components, exactly like the production roots.
  const sessionsDir = join(root, '.claude', 'sessions')
  const locksDir = join(root, '.codex', 'thread-writer-locks')
  fx = {
    root,
    sessionsDir,
    locksDir,
    dirs: {
      claudeSessionsDir: sessionsDir,
      codexLocksDir: locksDir,
      cursorChatsDir: join(homedir(), '.cursor', 'chats'),
    },
  }
})

afterEach(() => {
  for (const fd of openFds.splice(0)) {
    try { closeSync(fd) } catch { /* already closed */ }
  }
  for (const dir of chmodRestore.splice(0)) {
    try { chmodSync(dir, 0o755) } catch { /* gone */ }
  }
  while (restoreEnv.length > 0) {
    const [key, value] = restoreEnv.pop()!
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { rmSync(fx.root, { recursive: true, force: true }) } catch { /* best effort */ }
})

function denyAccess(dir: string): void {
  chmodRestore.push(dir)
  chmodSync(dir, 0o000)
}

interface RecordFields {
  pid?: unknown
  sessionId?: unknown
  procStart?: unknown
  messagingSocketPath?: unknown
}

/** Write a registry record, defaulting every field to a live, self-consistent one. */
function writeRecord(fields: RecordFields = {}): { pid: number; socketPath: string } {
  mkdirSync(fx.sessionsDir, { recursive: true })
  const pid = (fields.pid ?? process.pid) as number
  const socketPath = (fields.messagingSocketPath ?? join(fx.root, '.claude', `${pid}.sock`)) as string
  if (fields.messagingSocketPath === undefined) writeFileSync(socketPath, '')
  const record = {
    pid,
    sessionId: fields.sessionId ?? THREAD_A,
    procStart: fields.procStart ?? psLstartUtc(selfStartMsFromNode()),
    messagingSocketPath: socketPath,
    cwd: fx.root,
    kind: 'interactive',
    entrypoint: 'claude-desktop',
  }
  writeFileSync(join(fx.sessionsDir, `${pid}.json`), JSON.stringify(record))
  return { pid, socketPath }
}

const emptyLedger = () => new Map<number, number>()
const probesWith = (ledger: () => unknown) =>
  realOccupancyProbes(ledger as () => ReadonlyMap<number, number>)

// ---------------------------------------------------------------- resolvers

describe('directory resolvers', () => {
  it('prefers COS_CLAUDE_SESSIONS_DIR over CLAUDE_CONFIG_DIR', () => {
    setEnv('COS_CLAUDE_SESSIONS_DIR', fx.sessionsDir)
    setEnv('CLAUDE_CONFIG_DIR', join(fx.root, 'ignored'))
    expect(claudeSessionsDir()).toBe(fx.sessionsDir)
  })

  it('falls back to <CLAUDE_CONFIG_DIR>/sessions', () => {
    setEnv('COS_CLAUDE_SESSIONS_DIR', undefined)
    setEnv('CLAUDE_CONFIG_DIR', join(fx.root, '.claude'))
    expect(claudeSessionsDir()).toBe(fx.sessionsDir)
  })

  it('resolves codex locks under CODEX_HOME', () => {
    setEnv('CODEX_HOME', join(fx.root, '.codex'))
    expect(codexLocksDir()).toBe(fx.locksDir)
  })

  it('defaults codex locks to ~/.codex/thread-writer-locks when CODEX_HOME is unset or empty', () => {
    const expected = join(homedir(), '.codex', 'thread-writer-locks')
    setEnv('CODEX_HOME', undefined)
    expect(codexLocksDir()).toBe(expected)
    setEnv('CODEX_HOME', '')
    expect(codexLocksDir()).toBe(expected)
  })

  it('composes both into the dirs the detector takes', () => {
    setEnv('COS_CLAUDE_SESSIONS_DIR', fx.sessionsDir)
    setEnv('CODEX_HOME', join(fx.root, '.codex'))
    expect(realOccupancyDirs()).toEqual(fx.dirs)
  })
})

// ------------------------------------------------------------------- dirExists

describe('dirExists', () => {
  it('is true for a directory and false for a file or a missing path', () => {
    mkdirSync(fx.sessionsDir, { recursive: true })
    const file = join(fx.sessionsDir, 'plain.json')
    writeFileSync(file, '{}')
    expect(dirExists(fx.sessionsDir)).toBe(true)
    expect(dirExists(file)).toBe(false)
    expect(dirExists(join(fx.root, '.claude', 'nope'))).toBe(false)
  })
})

// --------------------------------------------------------------------- readDir

describe('readDir', () => {
  it('lists entries', () => {
    mkdirSync(fx.sessionsDir, { recursive: true })
    writeFileSync(join(fx.sessionsDir, '4242.json'), '{}')
    expect(readDir(fx.sessionsDir)).toContain('4242.json')
  })

  it('throws on a missing directory instead of reporting an empty registry', () => {
    expect(() => readDir(join(fx.root, '.claude', 'never-created'))).toThrow()
  })

  it.skipIf(isRoot)('throws on an unreadable directory instead of reporting an empty registry', () => {
    mkdirSync(fx.sessionsDir, { recursive: true })
    writeFileSync(join(fx.sessionsDir, '4242.json'), '{}')
    denyAccess(fx.sessionsDir)
    expect(() => readDir(fx.sessionsDir)).toThrow()
  })
})

// -------------------------------------------------------------------- readFile

describe('readFile cannot wedge the server', () => {
  it('returns null for a FIFO instead of blocking forever', () => {
    // NOT hypothetical. `openSync` on a FIFO with no writer never returns, and it
    // is a SYNCHRONOUS syscall on Node's single thread — so one planted
    // `<pid>.json` FIFO wedges the ENTIRE glasses server (health, meeting save,
    // transcribe-stream), not just this request. Express requestTimeout cannot
    // interrupt a blocked syscall, and readFile's own `isFile()` guard runs AFTER
    // the open, so it cannot prevent this alone. O_NONBLOCK is the fix.
    //
    // If this regresses the suite HANGS rather than failing cleanly, which is the
    // correct signal: a hang here is precisely the production symptom.
    mkdirSync(fx.sessionsDir, { recursive: true })
    const fifo = join(fx.sessionsDir, '4242.json')
    execFileSync('/usr/bin/mkfifo', [fifo])

    const started = Date.now()
    expect(readFile(fifo)).toBeNull()
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('still reads an ordinary record', () => {
    // Pairs with the FIFO case: proves O_NONBLOCK did not break the normal path.
    mkdirSync(fx.sessionsDir, { recursive: true })
    const real = join(fx.sessionsDir, '4243.json')
    writeFileSync(real, '{"pid":4243}')
    expect(readFile(real)).toBe('{"pid":4243}')
  })
})

describe('readFile', () => {
  beforeEach(() => mkdirSync(fx.sessionsDir, { recursive: true }))

  it('reads a regular file', () => {
    const p = join(fx.sessionsDir, '1.json')
    writeFileSync(p, '{"a":1}')
    expect(readFile(p)).toBe('{"a":1}')
  })

  it('returns null for a missing file', () => {
    expect(readFile(join(fx.sessionsDir, 'absent.json'))).toBeNull()
  })

  it('returns null for a symlink even when its target is perfectly readable', () => {
    const target = join(fx.root, 'elsewhere.json')
    writeFileSync(target, '{"sessionId":"anything"}')
    const link = join(fx.sessionsDir, '99.json')
    symlinkSync(target, link)
    expect(readFile(link)).toBeNull()
  })

  it('returns null for a directory', () => {
    const sub = join(fx.sessionsDir, 'sub')
    mkdirSync(sub)
    expect(readFile(sub)).toBeNull()
  })

  it('returns null for a file too large to be a registry record', () => {
    const p = join(fx.sessionsDir, '2.json')
    writeFileSync(p, 'x'.repeat(300 * 1024))
    expect(readFile(p)).toBeNull()
  })
})

// ------------------------------------------------------------------ fileExists

describe('fileExists', () => {
  it('is true for a regular file and for a real unix socket', async () => {
    mkdirSync(join(fx.root, '.claude'), { recursive: true })
    const plain = join(fx.root, '.claude', 'plain')
    writeFileSync(plain, '')
    expect(fileExists(plain)).toBe(true)

    const sockPath = join(fx.root, '.claude', 'live.sock')
    const server = createServer()
    await new Promise<void>(resolve => server.listen(sockPath, resolve))
    try {
      expect(fileExists(sockPath)).toBe(true)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('is false for a dangling symlink and for a missing path', () => {
    mkdirSync(join(fx.root, '.claude'), { recursive: true })
    const dangling = join(fx.root, '.claude', 'dangling.sock')
    symlinkSync(join(fx.root, '.claude', 'never-existed'), dangling)
    expect(fileExists(dangling)).toBe(false)
    expect(fileExists(join(fx.root, '.claude', 'absent'))).toBe(false)
  })
})

// --------------------------------------------------------------------- isAlive

describe('isAlive', () => {
  it('is true for this process', () => {
    expect(isAlive(process.pid)).toBe(true)
  })

  it('is false for a reaped process', async () => {
    expect(isAlive(await reapedPid())).toBe(false)
  })

  it('is false for pids that would signal a group rather than a process', () => {
    // process.kill(0, 0) hits this process GROUP and -1 broadcasts; neither is a
    // liveness answer about a specific owner.
    expect(isAlive(0)).toBe(false)
    expect(isAlive(-1)).toBe(false)
    expect(isAlive(1.5)).toBe(false)
    expect(isAlive(Number.NaN)).toBe(false)
  })
})

// -------------------------------------------------------------- processStartMs

describe('processStartMs', () => {
  it('agrees with a non-ps reading of this process start', () => {
    const probed = processStartMs(process.pid)
    expect(probed).not.toBeNull()
    // 2s covers ps truncating to the whole second. A timezone misread would be
    // hours out, and a bad epoch conversion further still.
    expect(Math.abs(probed! - selfStartMsFromNode())).toBeLessThan(2_000)
  })

  it('matches a registry procStart string built from that independent reading', () => {
    // This is the contract that actually matters: the value this probe returns has
    // to satisfy the detector's comparison against Claude's recorded UTC string.
    const recorded = psLstartUtc(selfStartMsFromNode())
    expect(processStartMatches(recorded, processStartMs(process.pid))).toBe(true)
  })

  it('does not match a procStart shifted by an hour', () => {
    const shifted = psLstartUtc(selfStartMsFromNode() - 3_600_000)
    expect(processStartMatches(shifted, processStartMs(process.pid))).toBe(false)
  })

  // Readings the real `ps` cannot be asked to produce, run through the same
  // function the live probe uses.
  it('refuses output that describes more than one process', () => {
    const one = psLstartUtc(Date.now() - 60_000)
    expect(interpretPsLstart(one, Date.now())).not.toBeNull()
    // Guessing which line is the right one is how a wrong start forges identity.
    expect(interpretPsLstart(`${one}\n${psLstartUtc(Date.now() - 120_000)}\n`, Date.now())).toBeNull()
  })

  it('refuses a start in the future, which is what an ignored TZ looks like', () => {
    const now = Date.now()
    // A `ps` that ignored TZ=UTC in, say, UTC+9 reports nine hours ahead.
    expect(interpretPsLstart(psLstartUtc(now + 9 * 3_600_000), now)).toBeNull()
    expect(interpretPsLstart(psLstartUtc(now + 60_000), now)).toBeNull()
    // Inside the truncation slack it is still a legitimate reading.
    expect(interpretPsLstart(psLstartUtc(now - 1_000), now)).not.toBeNull()
  })

  it('refuses an implausibly old epoch and unparseable text', () => {
    const now = Date.now()
    expect(interpretPsLstart(psLstartUtc(Date.UTC(1999, 11, 31)), now)).toBeNull()
    expect(interpretPsLstart('not a date\n', now)).toBeNull()
    expect(interpretPsLstart('   \n', now)).toBeNull()
    expect(interpretPsLstart('', now)).toBeNull()
  })

  it('returns null rather than a guess for a reaped or impossible pid', async () => {
    expect(processStartMs(await reapedPid())).toBeNull()
    expect(processStartMs(0)).toBeNull()
    expect(processStartMs(-1)).toBeNull()
    expect(processStartMs(Number.NaN)).toBeNull()
  })
})

// ---------------------------------------------------------------- lockHolders

describe('lockHolders', () => {
  beforeEach(() => mkdirSync(fx.locksDir, { recursive: true }))

  const lockPath = () => join(fx.locksDir, `${THREAD_B}.lock`)

  it('reports the pid holding an open descriptor', () => {
    const p = lockPath()
    writeFileSync(p, '')
    openFds.push(openSync(p, 'r+'))
    expect(lockHolders(p)).toContain(process.pid)
  })

  it('returns no holders for a lock file nobody has open', () => {
    const p = lockPath()
    writeFileSync(p, '')
    expect(lockHolders(p)).toEqual([])
  })

  it('returns no holders when the lock file does not exist', () => {
    expect(lockHolders(lockPath())).toEqual([])
  })

  it.skipIf(isRoot)('throws when it cannot inspect the lock, rather than reporting no holders', () => {
    const p = lockPath()
    writeFileSync(p, '')
    denyAccess(fx.locksDir)
    // lsof exits 1 with empty stdout here too — same shape as "no holders" — and
    // the only thing separating them is our own lstat saying the path is not
    // provably absent.
    expect(() => lockHolders(p)).toThrow()
  })

  // The outcomes a real filesystem cannot be made to produce on demand. Same
  // function the end-to-end tests above run through, fed the exit shapes measured
  // from lsof 4.91 on this machine.
  const outcome = (o: Partial<ProbeOutcome>): ProbeOutcome =>
    ({ ok: false, stdout: '', stderr: '', status: 1, killed: false, spawnError: null, ...o })

  it('throws when lsof itself is missing rather than reporting no holders', () => {
    expect(() => interpretLockHolders(outcome({ spawnError: 'ENOENT', status: null }), lockPath())).toThrow()
  })

  it('throws when lsof is killed by the hard timeout', () => {
    expect(() => interpretLockHolders(outcome({ killed: true, status: null }), lockPath())).toThrow()
  })

  it('throws on any exit status other than the measured no-matches 1', () => {
    expect(() => interpretLockHolders(outcome({ status: 2 }), lockPath())).toThrow()
    expect(() => interpretLockHolders(outcome({ status: null }), lockPath())).toThrow()
  })

  it('reads exit 1 with empty output as no holders', () => {
    writeFileSync(lockPath(), '')
    expect(interpretLockHolders(outcome({ status: 1 }), lockPath())).toEqual([])
  })

  it('reads a status error on a provably absent path as no holders', () => {
    expect(interpretLockHolders(
      outcome({ status: 1, stderr: 'lsof: status error on x: No such file or directory' }),
      lockPath(),
    )).toEqual([])
  })

  it('throws on a status error when the path is not provably absent', () => {
    writeFileSync(lockPath(), '')
    expect(() => interpretLockHolders(
      outcome({ status: 1, stderr: 'lsof: status error on x: Permission denied' }),
      lockPath(),
    )).toThrow()
  })

  it('throws on unrecognised stdout rather than silently reading it as empty', () => {
    expect(() => interpretLockHolders(
      { ok: true, stdout: 'lsof: WARNING something\n', stderr: '', status: 0, killed: false, spawnError: null },
      lockPath(),
    )).toThrow()
  })

  it('throws on an implausible pid and dedupes a repeated one', () => {
    const ok = (stdout: string): ProbeOutcome =>
      ({ ok: true, stdout, stderr: '', status: 0, killed: false, spawnError: null })
    expect(() => interpretLockHolders(ok('0\n'), lockPath())).toThrow()
    expect(() => interpretLockHolders(ok('-4\n'), lockPath())).toThrow()
    expect(interpretLockHolders(ok('4224\n4224\n'), lockPath())).toEqual([4224])
  })

  it('refuses a path that is not a <native-thread-id>.lock', () => {
    expect(() => lockHolders(join(fx.locksDir, '.coordination.lock'))).toThrow()
    expect(() => lockHolders(join(fx.locksDir, 'not-a-uuid.lock'))).toThrow()
    expect(() => lockHolders(join(fx.locksDir, `${THREAD_B.slice(0, 8)}.lock`))).toThrow()
    expect(() => lockHolders(join(fx.locksDir, `${THREAD_B}.txt`))).toThrow()
    expect(() => lockHolders('')).toThrow()
    expect(() => lockHolders(`${lockPath()}\0evil`)).toThrow()
    // A NUL in the DIRECTORY part survives basename(), so only the path guard
    // stands between it and execFileSync.
    expect(() => lockHolders(join(`${fx.locksDir}\0evil`, `${THREAD_B}.lock`))).toThrow()
  })
})

// ------------------------------------------------------------- cosSpawnedPids

describe('cosSpawnedPids', () => {
  it('passes a real ledger through', () => {
    const probes = probesWith(() => new Map([[process.pid, 1_700_000_000_000]]))
    expect(probes.cosSpawnedPids().get(process.pid)).toBe(1_700_000_000_000)
  })

  it('drops entries that cannot describe a process start', () => {
    const probes = probesWith(() => new Map<number, number>([
      [process.pid, Number.NaN],
      [-3, 1_700_000_000_000],
    ]))
    const clean = probes.cosSpawnedPids()
    expect(clean.has(process.pid)).toBe(false)
    expect(clean.has(-3)).toBe(false)
  })

  it('throws on a Map-like object that would grant self-ownership to any pid', () => {
    // The forger: `get` answers every pid with a start that will match. Accepting
    // it would turn any live desktop owner into "ours" and therefore attachable.
    const forger = { get: () => Date.now(), has: () => true, [Symbol.iterator]: function* () {} }
    expect(() => probesWith(() => forger).cosSpawnedPids()).toThrow()
  })

  it('throws when the ledger is missing entirely', () => {
    expect(() => probesWith(() => null).cosSpawnedPids()).toThrow()
    expect(() => probesWith(() => undefined).cosSpawnedPids()).toThrow()
  })
})

// -------------------------------------------------- detector, end to end

describe('threadOccupancy on a real filesystem (claude)', () => {
  it('refuses with detector_unavailable when this install has no registry directory', () => {
    // The build-without-sessions case. "No directory" must never read as "empty".
    expect(threadOccupancy('claude', THREAD_A, probesWith(emptyLedger), fx.dirs)).toEqual({
      attachable: false,
      owners: [],
      reason: 'detector_unavailable',
    })
  })

  it('attaches once the registry provably exists and is empty', () => {
    // The one legitimate attachable verdict: the mechanism is present here AND it
    // read everything and found nobody.
    mkdirSync(fx.sessionsDir, { recursive: true })
    expect(threadOccupancy('claude', THREAD_A, probesWith(emptyLedger), fx.dirs)).toEqual({
      attachable: true,
      owners: [],
      reason: null,
    })
  })

  it('refuses while a live foreign process owns the thread', () => {
    const { pid } = writeRecord()
    const result = threadOccupancy('claude', THREAD_A, probesWith(emptyLedger), fx.dirs)
    expect(result.attachable).toBe(false)
    expect(result.reason).toBe('live_desktop_process')
    expect(result.owners).toHaveLength(1)
    expect(result.owners[0]).toMatchObject({ pid, selfOwned: false, source: 'claude-registry' })
  })

  it('attaches when the live owner is provably one of ours', () => {
    const { pid } = writeRecord()
    const ledger = () => new Map([[pid, selfStartMsFromNode()]])
    const result = threadOccupancy('claude', THREAD_A, probesWith(ledger), fx.dirs)
    expect(result.attachable).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.owners[0]?.selfOwned).toBe(true)
  })

  it('does not credit the ledger when the recorded spawn start disagrees', () => {
    const { pid } = writeRecord()
    // Same pid, different process: PID reuse must not forge self-ownership.
    const ledger = () => new Map([[pid, selfStartMsFromNode() - 86_400_000]])
    const result = threadOccupancy('claude', THREAD_A, probesWith(ledger), fx.dirs)
    expect(result.attachable).toBe(false)
    expect(result.reason).toBe('live_desktop_process')
  })

  it('refuses when a record for the thread is a symlink', () => {
    mkdirSync(fx.sessionsDir, { recursive: true })
    // The planted target is a perfectly valid record for a DIFFERENT session, so
    // following it would parse cleanly, match nothing, and look free.
    const target = join(fx.root, 'planted.json')
    writeFileSync(target, JSON.stringify({ pid: 424242, sessionId: THREAD_B, procStart: 'x' }))
    symlinkSync(target, join(fx.sessionsDir, '424242.json'))
    const result = threadOccupancy('claude', THREAD_A, probesWith(emptyLedger), fx.dirs)
    expect(result.attachable).toBe(false)
    expect(result.reason).toBe('registry_unreadable')
  })

  it('refuses when any record is unparseable', () => {
    mkdirSync(fx.sessionsDir, { recursive: true })
    writeFileSync(join(fx.sessionsDir, '4242.json'), '{ truncated')
    const result = threadOccupancy('claude', THREAD_A, probesWith(emptyLedger), fx.dirs)
    expect(result.attachable).toBe(false)
    expect(result.reason).toBe('registry_unreadable')
  })

  it('treats a record whose process is gone as no owner at all', async () => {
    const pid = await reapedPid()
    writeRecord({ pid, procStart: psLstartUtc(Date.now() - 60_000) })
    expect(threadOccupancy('claude', THREAD_A, probesWith(emptyLedger), fx.dirs)).toEqual({
      attachable: true,
      owners: [],
      reason: null,
    })
  })

  it('refuses when the owner process start cannot be corroborated', () => {
    writeRecord({ procStart: 'not a date' })
    const result = threadOccupancy('claude', THREAD_A, probesWith(emptyLedger), fx.dirs)
    expect(result.attachable).toBe(false)
    expect(result.reason).toBe('unverifiable_process_start')
  })

  it('refuses when the liveness socket is a dangling symlink', () => {
    mkdirSync(join(fx.root, '.claude'), { recursive: true })
    const dangling = join(fx.root, '.claude', 'dangling.sock')
    symlinkSync(join(fx.root, '.claude', 'never-existed'), dangling)
    writeRecord({ messagingSocketPath: dangling })
    const result = threadOccupancy('claude', THREAD_A, probesWith(emptyLedger), fx.dirs)
    expect(result.attachable).toBe(false)
    expect(result.reason).toBe('unverifiable_liveness_socket')
  })

  it.skipIf(isRoot)('refuses with probe_failed when the registry exists but cannot be read', () => {
    writeRecord()
    denyAccess(fx.sessionsDir)
    const result = threadOccupancy('claude', THREAD_A, probesWith(emptyLedger), fx.dirs)
    expect(result.attachable).toBe(false)
    expect(result.reason).toBe('probe_failed')
  })

  it('refuses with probe_failed when the spawn ledger itself is broken', () => {
    writeRecord()
    const result = threadOccupancy('claude', THREAD_A, probesWith(() => null), fx.dirs)
    expect(result.attachable).toBe(false)
    expect(result.reason).toBe('probe_failed')
  })
})

describe('threadOccupancy on a real filesystem (codex)', () => {
  it('refuses with detector_unavailable when there is no writer-lock directory', () => {
    expect(threadOccupancy('codex', THREAD_B, probesWith(emptyLedger), fx.dirs)).toEqual({
      attachable: false,
      owners: [],
      reason: 'detector_unavailable',
    })
  })

  it('attaches when the lock file is absent', () => {
    mkdirSync(fx.locksDir, { recursive: true })
    expect(threadOccupancy('codex', THREAD_B, probesWith(emptyLedger), fx.dirs)).toEqual({
      attachable: true,
      owners: [],
      reason: null,
    })
  })

  it('attaches when the lock file exists but nobody holds it open', () => {
    mkdirSync(fx.locksDir, { recursive: true })
    // The documented trap: the file outlives the run by minutes.
    writeFileSync(join(fx.locksDir, `${THREAD_B}.lock`), '')
    expect(threadOccupancy('codex', THREAD_B, probesWith(emptyLedger), fx.dirs)).toEqual({
      attachable: true,
      owners: [],
      reason: null,
    })
  })

  it('refuses while a descriptor is genuinely held', () => {
    mkdirSync(fx.locksDir, { recursive: true })
    const p = join(fx.locksDir, `${THREAD_B}.lock`)
    writeFileSync(p, '')
    openFds.push(openSync(p, 'r+'))
    const result = threadOccupancy('codex', THREAD_B, probesWith(emptyLedger), fx.dirs)
    expect(result.attachable).toBe(false)
    expect(result.reason).toBe('live_desktop_process')
    expect(result.owners.map(o => o.pid)).toContain(process.pid)
  })

  it('attaches when the held descriptor is provably ours', () => {
    mkdirSync(fx.locksDir, { recursive: true })
    const p = join(fx.locksDir, `${THREAD_B}.lock`)
    writeFileSync(p, '')
    openFds.push(openSync(p, 'r+'))
    const ledger = () => new Map([[process.pid, selfStartMsFromNode()]])
    const result = threadOccupancy('codex', THREAD_B, probesWith(ledger), fx.dirs)
    expect(result.attachable).toBe(true)
    expect(result.owners[0]?.selfOwned).toBe(true)
  })

  it.skipIf(isRoot)('refuses with probe_failed when the lock cannot be inspected', () => {
    mkdirSync(fx.locksDir, { recursive: true })
    writeFileSync(join(fx.locksDir, `${THREAD_B}.lock`), '')
    denyAccess(fx.locksDir)
    const result = threadOccupancy('codex', THREAD_B, probesWith(emptyLedger), fx.dirs)
    expect(result.attachable).toBe(false)
    expect(result.reason).toBe('probe_failed')
  })
})

// ===========================================================================
// The transcript clock that powers the idle-holder relaxation (6.32.0)
// ===========================================================================

describe('withTranscriptClock on a real filesystem', () => {
  const THREAD = THREAD_A

  /** Real projects layout, dot component and all, like the production root. */
  function headDeps(): NativeHeadDeps {
    const projects = join(fx.root, '.claude', 'projects')
    return {
      ...realNativeHeadDeps({
        claudeProjectsDir: projects,
        codexSessionsDir: join(fx.root, '.codex', 'sessions'),
        cursorProjectsDir: join(fx.root, '.cursor', 'projects'),
      }),
      dirs: {
        claudeProjectsDir: projects,
        codexSessionsDir: join(fx.root, '.codex', 'sessions'),
        cursorProjectsDir: join(fx.root, '.cursor', 'projects'),
      },
    }
  }

  function writeTranscript(): string {
    const dir = join(fx.root, '.claude', 'projects', '-Users-someone-repo')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${THREAD}.jsonl`)
    writeFileSync(file, '{"type":"user"}\n')
    return file
  }

  it('reads the real mtime of the real transcript', () => {
    const file = writeTranscript()
    const clocked = withTranscriptClock(realOccupancyProbes(emptyLedger), headDeps())
    const got = clocked.transcriptMtimeMs?.('claude', THREAD)
    expect(got).toBe(statSync(file).mtimeMs)
    // And that reading is fresh enough to read as WORKING, which is what makes
    // this wiring able to block a live writer at all.
    expect(holderActivity(got, Date.now())).toBe('working')
  })

  it('answers null when there is no transcript, which the gate reads as unknown', () => {
    const clocked = withTranscriptClock(realOccupancyProbes(emptyLedger), headDeps())
    expect(clocked.transcriptMtimeMs?.('claude', THREAD)).toBeNull()
    expect(holderActivity(null, Date.now())).toBe('unknown')
  })

  it('answers null for an invalid id rather than reaching the filesystem with it', () => {
    const clocked = withTranscriptClock(realOccupancyProbes(emptyLedger), headDeps())
    for (const bad of ['nope', '../../etc/passwd', '']) {
      expect(clocked.transcriptMtimeMs?.('claude', bad)).toBeNull()
    }
  })

  it('leaves the wrapped probes otherwise untouched', () => {
    const base = realOccupancyProbes(emptyLedger)
    const clocked = withTranscriptClock(base, headDeps())
    expect(base.transcriptMtimeMs).toBeUndefined()
    for (const k of ['isAlive', 'processStartMs', 'fileExists', 'dirExists', 'readDir', 'readFile', 'lockHolders'] as const) {
      expect(clocked[k]).toBe(base[k])
    }
  })

  it('is what turns a real live foreign holder from refused into attachable', () => {
    // End to end on a real filesystem: a real registry record for THIS process
    // (so it is genuinely alive), an empty spawn ledger (so it is foreign), and a
    // real transcript. The only difference between the two verdicts is the clock.
    writeRecord({ sessionId: THREAD })
    const file = writeTranscript()

    const strict = threadOccupancy('claude', THREAD, realOccupancyProbes(emptyLedger), fx.dirs)
    expect({ attachable: strict.attachable, reason: strict.reason })
      .toEqual({ attachable: false, reason: 'live_desktop_process' })

    const clocked = withTranscriptClock(realOccupancyProbes(emptyLedger), headDeps())
    const working = threadOccupancy('claude', THREAD, clocked, fx.dirs)
    expect({ attachable: working.attachable, reason: working.reason })
      .toEqual({ attachable: false, reason: 'native_thread_working' })

    // Age the transcript past the window. Same registry, same live process, and
    // now the gate lets it through.
    const old = Date.now() - 10 * 60_000
    utimesSync(file, new Date(old), new Date(old))
    const idle = threadOccupancy('claude', THREAD, clocked, fx.dirs)
    expect({ attachable: idle.attachable, reason: idle.reason, idleHolder: idle.idleHolder })
      .toEqual({ attachable: true, reason: null, idleHolder: true })
  })
})

// ===========================================================================
// One flag decides both halves of Continue (6.33.0)
// ===========================================================================
//
// These run the composition itself rather than reading a source file, because
// the thing that broke in the field was a wiring answer, not a parse: COS
// Control set `COS_THREAD_ATTACH_ENABLED`, health reported the feature ON, and
// every Continue was still refused because a second key was needed to wire the
// clock. The strict `=== '1'` reading of that key stays covered where the key
// itself lives, in routes/agent-session-bindings.test.ts.

describe('buildOccupancyProbes', () => {
  const THREAD = THREAD_A

  function headDeps(): NativeHeadDeps {
    const projects = join(fx.root, '.claude', 'projects')
    return {
      ...realNativeHeadDeps({
        claudeProjectsDir: projects,
        codexSessionsDir: join(fx.root, '.codex', 'sessions'),
        cursorProjectsDir: join(fx.root, '.cursor', 'projects'),
      }),
      dirs: {
        claudeProjectsDir: projects,
        codexSessionsDir: join(fx.root, '.codex', 'sessions'),
        cursorProjectsDir: join(fx.root, '.cursor', 'projects'),
      },
    }
  }

  function writeIdleTranscript(): void {
    const dir = join(fx.root, '.claude', 'projects', '-Users-someone-repo')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${THREAD}.jsonl`)
    writeFileSync(file, '{"type":"user"}\n')
    const old = Date.now() - 10 * 60_000
    utimesSync(file, new Date(old), new Date(old))
  }

  it('wires the clock when attach is on, so an idle Mac window is continuable', () => {
    // The whole point of the collapse: turning Continue on is sufficient. A real
    // registry record for a live process (foreign, since the ledger is empty)
    // plus a stale transcript is exactly Miles's case — window open, nothing
    // running in it.
    writeRecord({ sessionId: THREAD })
    writeIdleTranscript()
    const probes = buildOccupancyProbes(emptyLedger, headDeps(), true)
    const verdict = threadOccupancy('claude', THREAD, probes, fx.dirs)
    expect({ attachable: verdict.attachable, reason: verdict.reason, idleHolder: verdict.idleHolder })
      .toEqual({ attachable: true, reason: null, idleHolder: true })
  })

  it('blocks a WORKING holder even with attach on', () => {
    // The relaxation is not a bypass. Same wiring, fresh transcript.
    writeRecord({ sessionId: THREAD })
    const dir = join(fx.root, '.claude', 'projects', '-Users-someone-repo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${THREAD}.jsonl`), '{"type":"user"}\n')
    const probes = buildOccupancyProbes(emptyLedger, headDeps(), true)
    const verdict = threadOccupancy('claude', THREAD, probes, fx.dirs)
    expect({ attachable: verdict.attachable, reason: verdict.reason })
      .toEqual({ attachable: false, reason: 'native_thread_working' })
  })

  it('leaves the clock off when attach is off, so every foreign holder refuses', () => {
    // Attach off is the pre-6.28 gate byte for byte: no clock at all, so even a
    // provably idle holder reads unknown and is refused.
    writeRecord({ sessionId: THREAD })
    writeIdleTranscript()
    const probes = buildOccupancyProbes(emptyLedger, headDeps(), false)
    expect(probes.transcriptMtimeMs).toBeUndefined()
    const verdict = threadOccupancy('claude', THREAD, probes, fx.dirs)
    expect({ attachable: verdict.attachable, reason: verdict.reason })
      .toEqual({ attachable: false, reason: 'live_desktop_process' })
  })

  it('treats a non-boolean answer as off rather than as a yes', () => {
    // A caller that hands over something truthy has not answered the question,
    // and the permissive branch must be earned by a real `true`.
    for (const notTrue of [1, 'true', {}] as unknown as boolean[]) {
      expect(buildOccupancyProbes(emptyLedger, headDeps(), notTrue).transcriptMtimeMs).toBeUndefined()
    }
  })
})
