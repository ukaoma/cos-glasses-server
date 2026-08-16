import { describe, it, expect } from 'vitest'
import {
  cwdFromTranscript,
  fingerprint,
  resolveAttachedWorkspace,
  type AttachedWorkspaceDeps,
} from './attached-workspace'

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

  it('returns null when rows DISAGREE rather than picking one', () => {
    // Two working directories in one transcript is not something to guess at.
    const conflicted = [claudeRows('/a'), claudeRows('/b')].join('\n')
    expect(cwdFromTranscript(conflicted)).toBeNull()
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
    for (const p of ['cursor', 'gemini', '']) {
      expect(resolveAttachedWorkspace(p, THREAD, deps())).toBeNull()
    }
  })

  it('never returns the path on a fingerprint', () => {
    // The fingerprints go on the wire; the path must not be recoverable from them.
    const r = resolveAttachedWorkspace('claude', THREAD, deps())!
    expect(r.workspaceFingerprint).not.toContain('/')
    expect(r.workspaceFingerprint).not.toContain('Ukaoma')
    expect(r.sourceFingerprint).not.toContain('/')
  })
})
