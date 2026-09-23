import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { defaultPidStartProbe, fenceLiveness, makePidStartProbe, psLstartRunner, PS_PROBE_TIMEOUT_MS, START_MATCH_TOLERANCE_MS, type PsExec } from './fence-liveness.js'

const START = 1_700_000_000_000

describe('fenceLiveness', () => {
  it('reports none_running only when every recorded child is provably gone', () => {
    const v = fenceLiveness(
      [{ pid: 10, startMs: START }, { pid: 11, startMs: START }],
      { pidStartMs: () => null },
    )
    expect(v).toMatchObject({ state: 'none_running', recorded: 2, running: 0, unverifiable: 0 })
  })

  it('reports running when a live pid matches its recorded start', () => {
    const v = fenceLiveness([{ pid: 10, startMs: START }], { pidStartMs: () => START })
    expect(v.state).toBe('running')
    expect(v.running).toBe(1)
  })

  // The reason spawns records a start at all. FenceRecord: "a pid alone cannot be
  // distinguished from a recycled one."
  it('does not mistake a RECYCLED pid for our child', () => {
    const v = fenceLiveness(
      [{ pid: 10, startMs: START }],
      { pidStartMs: () => START + 60 * 60 * 1000 },  // same pid, an hour later
    )
    expect(v.state).toBe('none_running')
    expect(v.running).toBe(0)
    expect(v.recycled).toBe(1)
  })

  it('tolerates ps one-second rounding but not a real gap', () => {
    const near = fenceLiveness([{ pid: 10, startMs: START }],
      { pidStartMs: () => START + START_MATCH_TOLERANCE_MS - 1 })
    expect(near.state).toBe('running')
    const far = fenceLiveness([{ pid: 10, startMs: START }],
      { pidStartMs: () => START + START_MATCH_TOLERANCE_MS + 1 })
    expect(far.state).toBe('none_running')
    expect(far.recycled).toBe(1)
  })

  // FenceRecord: "An EMPTY list means no child was ever spawned, which no resolver
  // may ever read as 'nothing landed'."
  it('never reads an empty or missing spawn list as none_running', () => {
    for (const input of [[], undefined, null]) {
      const v = fenceLiveness(input, { pidStartMs: () => null })
      expect(v.state, JSON.stringify(input)).toBe('unknown')
      expect(v.recorded).toBe(0)
    }
  })

  it('fails closed when a probe throws', () => {
    const v = fenceLiveness(
      [{ pid: 10, startMs: START }],
      { pidStartMs: () => { throw new Error('ps unavailable') } },
    )
    expect(v.state).toBe('unknown')
    expect(v.unverifiable).toBe(1)
  })

  it('a live child outranks an unreadable probe', () => {
    // One certain "still writing" is worth more than one "cannot tell": the caller
    // is deciding whether to admit a second writer to the same transcript.
    const v = fenceLiveness(
      [{ pid: 10, startMs: START }, { pid: 11, startMs: START }],
      { pidStartMs: (pid) => { if (pid === 11) throw new Error('nope'); return START } },
    )
    expect(v.state).toBe('running')
    expect(v.running).toBe(1)
    expect(v.unverifiable).toBe(1)
  })

  it('treats a malformed spawn row as unverifiable, not as gone', () => {
    const v = fenceLiveness(
      [{ pid: 0, startMs: START }, { pid: 5, startMs: Number.NaN }],
      { pidStartMs: () => null },
    )
    expect(v.state).toBe('unknown')
    expect(v.unverifiable).toBe(2)
  })
})

describe('makePidStartProbe', () => {
  it('returns null for a pid that is not running, and throws on an empty answer', () => {
    expect(makePidStartProbe(() => null)(999)).toBeNull()
    // 6.53.3 /qa: only the runner's null means gone. A clean exit that printed nothing is
    // not an answer, so it is unverifiable rather than "not running".
    expect(() => makePidStartProbe(() => '   ')(999)).toThrow(/empty/)
  })

  it('THROWS on unparseable output rather than reporting the child gone', () => {
    // Silently returning null here would read a live child as ended, which is the
    // one direction this whole module must not fail in.
    expect(() => makePidStartProbe(() => 'not a date')(10)).toThrow(/unparseable/)
  })

  // Execution against the real thing: `ps -o lstart=` is the only start-time
  // keyword macOS offers (`etimes` is not a valid keyword), so the format this
  // parses is worth pinning against the actual binary rather than a fixture.
  it('parses this very process out of real ps output', () => {
    const probe = makePidStartProbe((pid) => {
      try {
        return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' })
      } catch {
        return null
      }
    })
    const started = probe(process.pid)
    expect(started).not.toBeNull()
    // Within a day of now, and not in the future beyond ps's one-second rounding.
    expect(started as number).toBeLessThanOrEqual(Date.now() + 1_000)
    expect(started as number).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000)

    // And a pid that cannot exist reads as not running, not as a throw.
    expect(probe(0)).toBeNull()
  })
})

// 6.53.3 /qa BLOCKER: the production probe returned null (gone) on ANY execFileSync error, and
// null is `none_running`, which releases a cancel fence. The error shapes below are the ones
// Node's execFileSync throws, measured on this Mac (node 24, 2026-09-23):
//   no such pid   {status:1, signal:null, stdout:'', stderr:''} and no `code`/`error`
//   timeout kill  {status:null, signal:'SIGTERM', code:'ETIMEDOUT', error:<Error>, stdout:'', stderr:''}
//   no ps binary  {status:null, signal:null, code:'ENOENT', error:<Error>}
//   killed        {status:null, signal:'SIGKILL', stdout:'', stderr:''}
//   bad keyword   {status:1, signal:null, stdout:'<keyword list>', stderr:'ps: nosuchkw: keyword not found ...'}
describe('the production ps probe: only a definitive "no such process" is gone', () => {
  const START_TEXT = 'Fri Jan  2 09:29:55 2026'
  function nodeError(message: string, fields: Record<string, unknown>): Error {
    return Object.assign(new Error(message), { output: [null, fields.stdout ?? null, fields.stderr ?? null], pid: 4242, ...fields })
  }
  const spawnError = (code: string, errno: number) => Object.assign(new Error(`spawnSync /bin/ps ${code}`), { code, errno, syscall: 'spawnSync /bin/ps' })
  const shapes: Array<[string, Error]> = [
    ['a timeout kill (ETIMEDOUT, SIGTERM)', nodeError('spawnSync /bin/ps ETIMEDOUT', { status: null, signal: 'SIGTERM', code: 'ETIMEDOUT', errno: -60, error: spawnError('ETIMEDOUT', -60), stdout: '', stderr: '' })],
    ['no ps binary (ENOENT)', nodeError('spawnSync ps ENOENT', { status: null, signal: null, code: 'ENOENT', errno: -2, error: spawnError('ENOENT', -2) })],
    ['a fork that failed (EAGAIN)', nodeError('spawnSync /bin/ps EAGAIN', { status: null, signal: null, code: 'EAGAIN', errno: -35, error: spawnError('EAGAIN', -35) })],
    ['ps killed by a signal', nodeError('Command failed: /bin/ps -p 3670 -o lstart=', { status: null, signal: 'SIGKILL', stdout: '', stderr: '' })],
    ['exit 1 but killed', nodeError('Command failed', { status: 1, signal: null, killed: true, stdout: '', stderr: '' })],
    ['exit 1 with a code', nodeError('Command failed', { status: 1, signal: null, code: 'EAGAIN', stdout: '', stderr: '' })],
    ['exit 1 with output (a keyword ps refused)', nodeError('Command failed', { status: 1, signal: null, stdout: '%cpu %mem acflag', stderr: 'ps: lstart: keyword not found' })],
    ['exit 1 with a complaint on stderr', nodeError('Command failed', { status: 1, signal: null, stdout: '', stderr: 'ps: illegal option -- p' })],
    ['exit 1 with no captured output at all', nodeError('Command failed', { status: 1, signal: null })],
    ['exit 2', nodeError('Command failed', { status: 2, signal: null, stdout: '', stderr: '' })],
    ['something that is not an exec error', new TypeError('exec is not a function')],
  ]
  const throwing = (error: unknown): PsExec => () => { throw error }

  it.each(shapes)('%s: unknown, never gone, and the fence stays', (_label, error) => {
    const probe = defaultPidStartProbe(throwing(error))
    expect(() => probe(3670)).toThrow()
    const v = fenceLiveness([{ pid: 3670, startMs: START }], { pidStartMs: probe })
    expect(v.state).toBe('unknown')
    expect(v.unverifiable).toBe(1)
  })

  it('exit 1, no signal, not killed, nothing on stdout or stderr: gone', () => {
    const gone = nodeError('Command failed: /bin/ps -p 3670 -o lstart=', { status: 1, signal: null, stdout: '', stderr: '' })
    const probe = defaultPidStartProbe(throwing(gone))
    expect(probe(3670)).toBeNull()
    expect(fenceLiveness([{ pid: 3670, startMs: START }], { pidStartMs: probe }).state).toBe('none_running')
    // Buffers (no encoding) read the same way.
    const buffers = nodeError('Command failed', { status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
    expect(defaultPidStartProbe(throwing(buffers))(3670)).toBeNull()
  })

  it('a clean exit with nothing printed is not an answer either', () => {
    expect(() => defaultPidStartProbe(() => '')(3670)).toThrow()
    expect(() => defaultPidStartProbe(() => '  \n')(3670)).toThrow()
    expect(fenceLiveness([{ pid: 3670, startMs: START }], { pidStartMs: defaultPidStartProbe(() => '') }).state).toBe('unknown')
  })

  it('a live answer is parsed, and the runner asks ps for exactly this pid with the timeout', () => {
    const calls: Array<{ file: string; args: readonly string[]; timeout: number }> = []
    const run = psLstartRunner((file, args, options) => { calls.push({ file, args, timeout: options.timeout }); return `${START_TEXT}\n` })
    expect(run(3670)).toBe(`${START_TEXT}\n`)
    expect(calls).toEqual([{ file: expect.stringMatching(/(^|\/)ps$/), args: ['-p', '3670', '-o', 'lstart='], timeout: PS_PROBE_TIMEOUT_MS }])
    expect(defaultPidStartProbe(() => `${START_TEXT}\n`)(3670)).toBe(Date.parse(START_TEXT))
  })

  // The real binary, both answers: this process is alive, and a child that has exited is gone.
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('against the real ps: alive is a start time, an exited child is gone', () => {
    const probe = defaultPidStartProbe()
    expect(probe(process.pid)).toEqual(expect.any(Number))
    const child = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
    expect(probe(Number(child))).toBeNull()
  })
})
