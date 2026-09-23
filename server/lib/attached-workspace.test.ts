import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
import {
  WORKSPACE_SCAN_BYTES,
  WORKSPACE_SCAN_BYTES_MAX,
  realAttachedWorkspaceDeps,
  cwdFromTranscript,
  fingerprint,
  resolveAttachedWorkspace,
  scanForCwd,
  type AttachedWorkspaceDeps,
} from './attached-workspace'

// Every temp root this file makes is removed when the file ends (6.53.3 /qa W3: the suites
// had left ~150,000 `cos-*` folders in $TMPDIR). Tracked at the mkdtemp call, so a new test
// cannot forget it.
const trackedTempRoots: string[] = []
function trackedTemp<T extends string>(root: T): T {
  trackedTempRoots.push(root)
  return root
}
afterAll(() => {
  for (const root of trackedTempRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* a chmod'ed tree: best effort */ }
  }
})

// The real path on this machine, kept verbatim because it is the fixture that
// matters: it contains BOTH a space and hyphens, which is what makes decoding the
// project slug back into a path impossible and this module necessary.
const REAL_CWD = '/Users/ukaoma/Documents/GitHub/Ukaoma Chief Of Staff/MU-Chief-Staff'
const THREAD = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const TRANSCRIPT = `/Users/ukaoma/.claude/projects/-Users-ukaoma-Documents-GitHub-Ukaoma-Chief-Of-Staff-MU-Chief-Staff/${THREAD}.jsonl`

const claudeRows = (cwd = REAL_CWD) => [
  JSON.stringify({ type: 'queue-operation', sessionId: THREAD, timestamp: 't' }),
  JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } }),
  JSON.stringify({ type: 'assistant', cwd, message: { role: 'assistant', content: 'ok' } }),
].join('\n')

const codexRows = (cwd = '/private/tmp') => [
  JSON.stringify({ type: 'session_meta', timestamp: 't', payload: { cwd, id: '01a0', cli_version: '0.148.0' } }),
  JSON.stringify({ type: 'event_msg', timestamp: 't', payload: { type: 'agent_message', content: 'hi' } }),
].join('\n')

function deps(over: Partial<AttachedWorkspaceDeps> = {}): AttachedWorkspaceDeps {
  return {
    transcriptPath: () => TRANSCRIPT,
    readHead: () => claudeRows(),
    dirExists: () => true,
    ...over,
  }
}

describe('reading the cwd out of a transcript', () => {
  it('reads a Claude top-level cwd, spaces and hyphens intact', () => {
    // Slug-decoding this path yields ".../Ukaoma/Chief/Of/Staff/MU/Chief/Staff",
    // which is why the value is read rather than derived.
    expect(cwdFromTranscript(claudeRows())).toBe(REAL_CWD)
  })

  it('reads a Codex cwd out of payload on the session meta row', () => {
    expect(cwdFromTranscript(codexRows())).toBe('/private/tmp')
  })

  it('survives a torn trailing line, which is normal for an appended file', () => {
    expect(cwdFromTranscript(`${claudeRows()}\n{"type":"assis`)).toBe(REAL_CWD)
  })

  it('skips unparseable and non-object rows without giving up', () => {
    const noisy = ['not json', '[]', '"scalar"', '', claudeRows()].join('\n')
    expect(cwdFromTranscript(noisy)).toBe(REAL_CWD)
  })

  it('returns null when NO row records a cwd', () => {
    expect(cwdFromTranscript(JSON.stringify({ type: 'user', message: {} }))).toBeNull()
  })

  it('the FIRST cwd is the workspace when later rows moved (a cd inside a turn), 6.48.2', () => {
    // Until 6.48.1 this refused as a disagreement. On the release Mac every such
    // transcript was one session whose shell cd-ed into a subfolder mid-turn; the
    // directory the session started in keys its project folder and is the only place
    // --resume finds it.
    const moved = [claudeRows(REAL_CWD), claudeRows(`${REAL_CWD}/operations/scripts`)].join('\n')
    expect(cwdFromTranscript(moved)).toBe(REAL_CWD)
    const codexMoved = [codexRows('/private/tmp'), codexRows('/private/tmp/sub')].join('\n')
    expect(cwdFromTranscript(codexMoved)).toBe('/private/tmp')
  })

  it('reports whether the window ended inside a row before any cwd, so the resolver can widen (6.48.2)', () => {
    const bookkeeping = [
      JSON.stringify({ type: 'mode', sessionId: THREAD }),
      JSON.stringify({ type: 'permission-mode', sessionId: THREAD }),
    ].join('\n')
    // A 952 KB first prompt (three pasted screenshots) cut by a 512 KiB window: no cwd, torn.
    const torn = `${bookkeeping}\n{"type":"user","cwd":"${REAL_CWD}","message":{"content":[{"type":"image","data":"${'A'.repeat(200)}`
    expect(scanForCwd(torn)).toMatchObject({ cwd: null, endedMidRow: true })
    // The same rows ending on a row boundary: nothing wider would help.
    expect(scanForCwd(`${bookkeeping}\n`)).toMatchObject({ cwd: null, endedMidRow: false })
    expect(scanForCwd('')).toMatchObject({ cwd: null, endedMidRow: false })
    expect(scanForCwd(claudeRows())).toMatchObject({ cwd: REAL_CWD, endedMidRow: false })
  })

  it('returns null for empty input', () => {
    expect(cwdFromTranscript('')).toBeNull()
  })
})

describe('resolveAttachedWorkspace refuses rather than guessing', () => {
  it('resolves a real workspace', () => {
    const r = resolveAttachedWorkspace('claude', THREAD, deps())!
    expect(r.path).toBe(REAL_CWD)
    expect(r.workspaceFingerprint).toBe(fingerprint(REAL_CWD))
    expect(r.sourceFingerprint).toBe(fingerprint(TRANSCRIPT))
  })

  it('resolves Codex the same way', () => {
    const r = resolveAttachedWorkspace('codex', THREAD, deps({ readHead: () => codexRows() }))!
    expect(r.path).toBe('/private/tmp')
  })

  it('refuses when the transcript is ambiguous or missing', () => {
    // transcriptPath returns null for "not exactly one match" - the caller must
    // not attach to a thread it cannot uniquely locate.
    expect(resolveAttachedWorkspace('claude', THREAD, deps({ transcriptPath: () => null }))).toBeNull()
  })

  it('refuses when the transcript cannot be read', () => {
    expect(resolveAttachedWorkspace('claude', THREAD, deps({ readHead: () => null }))).toBeNull()
  })

  it('widens the head read past a giant first row until the cwd appears, and stops at the cap (6.48.2)', () => {
    // The production shape: four tiny bookkeeping rows, then one ~1 MB user row that
    // carries the cwd. A fixed 512 KiB window sees no cwd; the second read does.
    const bookkeeping = ['{"type":"mode"}', '{"type":"permission-mode"}', '{"type":"atis-latch"}', '{"type":"file-history-snapshot"}'].join('\n') + '\n'
    const giant = JSON.stringify({ type: 'user', cwd: REAL_CWD, message: { content: [{ type: 'image', data: 'A'.repeat(950 * 1024) }] } }) + '\n'
    const file = Buffer.from(bookkeeping + giant + claudeRows() + '\n', 'utf8')
    const windows: number[] = []
    const readHead = (_p: string, max: number) => { windows.push(max); return file.subarray(0, max).toString('utf8') }
    const r = resolveAttachedWorkspace('claude', THREAD, deps({ readHead }))
    expect(r?.path).toBe(REAL_CWD)
    expect(windows).toEqual([WORKSPACE_SCAN_BYTES, WORKSPACE_SCAN_BYTES * 4])
    // A file that is shorter than the window is read once: nothing wider exists.
    const shortWindows: number[] = []
    const short = Buffer.from(bookkeeping, 'utf8')
    expect(resolveAttachedWorkspace('claude', THREAD, deps({ readHead: (_p, max) => { shortWindows.push(max); return short.subarray(0, max).toString('utf8') } }))).toBeNull()
    expect(shortWindows).toEqual([WORKSPACE_SCAN_BYTES])
    // A first row wider than the cap is still a refusal, after the cap and not before.
    const tooBig = Buffer.from(bookkeeping + '{"type":"user","message":{"content":[{"type":"image","data":"' + 'A'.repeat(WORKSPACE_SCAN_BYTES_MAX + 1024), 'utf8')
    const bigWindows: number[] = []
    expect(resolveAttachedWorkspace('claude', THREAD, deps({ readHead: (_p, max) => { bigWindows.push(max); return tooBig.subarray(0, max).toString('utf8') } }))).toBeNull()
    expect(bigWindows.at(-1)).toBe(WORKSPACE_SCAN_BYTES_MAX)
    expect(bigWindows.length).toBeLessThanOrEqual(4)
  })

  it('refuses a RELATIVE cwd instead of resolving it against the server', () => {
    // Resolving this would run the user's turn in whatever directory the
    // LaunchAgent started in.
    const rel = resolveAttachedWorkspace('claude', THREAD, deps({ readHead: () => claudeRows('relative/path') }))
    expect(rel).toBeNull()
  })

  it('refuses when the workspace no longer exists', () => {
    expect(resolveAttachedWorkspace('claude', THREAD, deps({ dirExists: () => false }))).toBeNull()
  })

  it('refuses when a probe throws rather than letting it escape', () => {
    for (const over of [
      { transcriptPath: () => { throw new Error('EACCES') } },
      { readHead: () => { throw new Error('EIO') } },
      { dirExists: () => { throw new Error('ELOOP') } },
    ] as Partial<AttachedWorkspaceDeps>[]) {
      expect(resolveAttachedWorkspace('claude', THREAD, deps(over))).toBeNull()
    }
  })

  it('refuses an unsupported provider', () => {
    for (const p of ['gemini', '']) {
      expect(resolveAttachedWorkspace(p, THREAD, deps())).toBeNull()
    }
  })

  it('resolves cursor from spawn spelling plus the jsonl path', () => {
    const cwd = '/tmp/cursor-ws'
    const jsonl = '/home/.cursor/projects/tmp-cursor-ws/agent-transcripts/id/id.jsonl'
    const r = resolveAttachedWorkspace('cursor', THREAD, deps({
      cursorSpawnWorkspace: () => cwd,
      transcriptPath: () => jsonl,
      dirExists: () => true,
    }))!
    expect(r.path).toBe(cwd)
    expect(r.workspaceFingerprint).toBe(fingerprint(cwd))
    expect(r.sourceFingerprint).toBe(fingerprint(jsonl))
  })

  it('refuses cursor without a spawn workspace', () => {
    expect(resolveAttachedWorkspace('cursor', THREAD, deps({
      cursorSpawnWorkspace: () => null,
      transcriptPath: () => '/x.jsonl',
    }))).toBeNull()
  })

  it('never returns the path on a fingerprint', () => {
    // The fingerprints go on the wire; the path must not be recoverable from them.
    const r = resolveAttachedWorkspace('claude', THREAD, deps())!
    expect(r.workspaceFingerprint).not.toContain('/')
    expect(r.workspaceFingerprint).not.toContain('Ukaoma')
    expect(r.sourceFingerprint).not.toContain('/')
  })
})

describe('realAttachedWorkspaceDeps touches the real filesystem safely', () => {
  // This factory had ZERO coverage: neutering its return to null left all 250
  // relevant tests green, so the guards in the function whose own header says
  // "one planted path would wedge the whole server" were entirely unexercised.
  // That asymmetry is exactly why the identical bug shipped in native-head.
  const root = () => trackedTemp(mkdtempSync(join(tmpdir(), 'aw-real-')))

  it('reads the HEAD of a real transcript, not the tail', () => {
    // The cwd is in the EARLY rows; a tail read of a 13 GB rollout would miss it.
    const dir = root()
    const file = join(dir, 'x.jsonl')
    const cwd = join(dir, 'work space')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(file, `${JSON.stringify({ type: 'user', cwd })}\n${'{"pad":1}\n'.repeat(500)}`)
    expect(realAttachedWorkspaceDeps().readHead(file, 512 * 1024)).toContain(cwd)
  })

  it('returns null for a FIFO instead of blocking forever', () => {
    // O_NONBLOCK. A regression HANGS the suite, which is the production symptom.
    const dir = root()
    const fifo = join(dir, 'fifo.jsonl')
    execFileSync('/usr/bin/mkfifo', [fifo])
    const started = Date.now()
    expect(realAttachedWorkspaceDeps().readHead(fifo, 1024)).toBeNull()
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('refuses to follow a symlinked transcript', () => {
    // O_NOFOLLOW. A symlinked <id>.jsonl could point at any file on disk and be
    // parsed for a cwd we would then spawn in.
    const dir = root()
    const real = join(dir, 'real.jsonl')
    writeFileSync(real, JSON.stringify({ type: 'user', cwd: '/tmp' }))
    const link = join(dir, 'link.jsonl')
    symlinkSync(real, link)
    expect(realAttachedWorkspaceDeps().readHead(link, 1024)).toBeNull()
  })

  it('dirExists distinguishes absent from unreadable', () => {
    const dir = root()
    expect(realAttachedWorkspaceDeps().dirExists(dir)).toBe(true)
    expect(realAttachedWorkspaceDeps().dirExists(join(dir, 'nope'))).toBe(false)
    // A FILE is not a directory - the resolver must not spawn into one.
    const file = join(dir, 'f.txt')
    writeFileSync(file, 'x')
    expect(realAttachedWorkspaceDeps().dirExists(file)).toBe(false)
  })
})
