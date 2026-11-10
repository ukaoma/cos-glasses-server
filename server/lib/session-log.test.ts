// S1 (2026-11-09): the session ledger (.glasses_sessions.jsonl) must not grow on every restart.
// Field evidence: 1.94 GB, 118,221 entries for 588 sessions, one session copied 1,254 times,
// because every shutdown appended every session and the first snapshot after each boot
// appended them all again. These tests execute the real writers against scratch
// COS_DATA_DIR and COS_SCRIPTS_DIR directories and simulate a restart with vi.resetModules().
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let dataDir = ''
let scriptsDir = ''
const ledger = () => join(scriptsDir, '.glasses_sessions.jsonl')
const ledgerLines = () => existsSync(ledger())
  ? readFileSync(ledger(), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : []

beforeEach(() => {
  vi.resetModules()
  dataDir = mkdtempSync(join(tmpdir(), 'cos-session-log-data-'))
  scriptsDir = mkdtempSync(join(tmpdir(), 'cos-session-log-scripts-'))
  process.env.COS_DATA_DIR = dataDir
  process.env.COS_SCRIPTS_DIR = scriptsDir
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
const loadedLogs: Array<{ __resetSessionLogForTests(): void }> = []
afterEach(() => {
  // Each boot is a separate module instance with its own flush timer; stop them all
  // before the scratch directories go away.
  for (const instance of loadedLogs.splice(0)) instance.__resetSessionLogForTests()
  vi.restoreAllMocks()
  vi.resetModules()
  delete process.env.COS_SCRIPTS_DIR
  delete process.env.COS_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(scriptsDir, { recursive: true, force: true })
})

/** A "boot": fresh module instances over the same data and scripts directories. */
async function boot() {
  vi.resetModules()
  const conversation = await import('./conversation.js')
  const sessionLog = await import('./session-log.js')
  loadedLogs.push(sessionLog)
  conversation.__resetAutoSnapshotForTests()
  return { conversation, sessionLog }
}

describe('session ledger across restarts', () => {
  it('appends an unchanged session once, however many restarts and snapshots follow', async () => {
    let { conversation } = await boot()
    const id = conversation.createSession()
    conversation.addExchange(id, 'user', 'What is on my calendar today?')
    conversation.addExchange(id, 'assistant', 'Two meetings and a dentist appointment.')
    conversation.flushConversationToDisk()

    expect(conversation.logActiveSessionsOnShutdown()).toEqual({ written: 1, unchanged: 0, failed: 0 })
    expect(ledgerLines()).toHaveLength(1)

    for (let restart = 0; restart < 3; restart++) {
      ;({ conversation } = await boot())
      expect(conversation.getSessionRaw(id)?.exchanges).toHaveLength(2) // restored from sessions.json
      // The first snapshot after a boot used to re-append every session.
      expect(conversation.runAutoSnapshotOnce()).toEqual({ written: 0, unchanged: 1, failed: 0 })
      expect(conversation.logActiveSessionsOnShutdown()).toEqual({ written: 0, unchanged: 1, failed: 0 })
    }
    expect(ledgerLines()).toHaveLength(1)
  })

  it('appends again when the session changed, and only then', async () => {
    let { conversation } = await boot()
    const id = conversation.createSession()
    conversation.addExchange(id, 'user', 'first question')
    conversation.addExchange(id, 'assistant', 'first answer')
    conversation.flushConversationToDisk()
    conversation.logActiveSessionsOnShutdown()

    ;({ conversation } = await boot())
    conversation.addExchange(id, 'user', 'second question')
    conversation.addExchange(id, 'assistant', 'second answer')
    expect(conversation.runAutoSnapshotOnce()).toEqual({ written: 1, unchanged: 0, failed: 0 })
    expect(conversation.runAutoSnapshotOnce()).toEqual({ written: 0, unchanged: 0, failed: 0 }) // count pre-check
    expect(conversation.logActiveSessionsOnShutdown()).toEqual({ written: 0, unchanged: 1, failed: 0 })
    const lines = ledgerLines()
    expect(lines.map(l => l.total_message_count)).toEqual([2, 4])
    expect(lines[1].slug).toMatch(/^\[LIVE\] /)
  })

  it('still writes a real end after a snapshot of the same content, but never twice', async () => {
    const { sessionLog } = await boot()
    const input = {
      id: 'abcd1234',
      exchanges: [
        { role: 'user' as const, content: 'q', timestamp: 1_000 },
        { role: 'assistant' as const, content: 'a', timestamp: 2_000 },
      ],
      createdAt: 1_000,
      lastActivity: 2_000,
      modelPreference: null,
    }
    const snapshot = sessionLog.buildSessionLogEntry({ ...input, endReason: 'explicit_end', slug: '[LIVE] q' })
    expect(sessionLog.writeSessionLogIfChanged(snapshot, 'snapshot')).toBe('written')
    sessionLog.logSessionEnd({ ...input, endReason: 'ttl_expiry' })
    sessionLog.logSessionEnd({ ...input, endReason: 'ttl_expiry' })
    expect(ledgerLines().map(l => [l.end_reason, l.slug])).toEqual([
      ['explicit_end', '[LIVE] q'],
      ['ttl_expiry', 'q'],
    ])
  })

  it('a snapshot whose only difference is its invented ended_at is unchanged', async () => {
    const { sessionLog } = await boot()
    const base = {
      id: 'feed0001',
      exchanges: [
        { role: 'user' as const, content: 'q', timestamp: 1_000 },
        { role: 'assistant' as const, content: 'a', timestamp: 2_000 },
      ],
      createdAt: 1_000,
      modelPreference: null,
      endReason: 'explicit_end' as const,
    }
    const a = sessionLog.buildSessionLogEntry({ ...base, lastActivity: 10_000 })
    const b = sessionLog.buildSessionLogEntry({ ...base, lastActivity: 99_000 })
    expect(sessionLog.sessionLogSignature(a)).toBe(sessionLog.sessionLogSignature(b))
    expect(sessionLog.writeSessionLogIfChanged(a, 'snapshot')).toBe('written')
    expect(sessionLog.writeSessionLogIfChanged(b, 'snapshot')).toBe('unchanged')
    // An edited answer (same counts) is a change.
    const edited = sessionLog.buildSessionLogEntry({
      ...base, lastActivity: 99_000,
      exchanges: [base.exchanges[0], { ...base.exchanges[1], content: 'a, revised' }],
    })
    expect(sessionLog.writeSessionLogIfChanged(edited, 'snapshot')).toBe('written')
  })

  it('a state written for another ledger path does not suppress writes to this one', async () => {
    const { sessionLog } = await boot()
    writeFileSync(join(dataDir, 'session-log-state.json'), JSON.stringify({
      version: 1, logPath: '/elsewhere/.glasses_sessions.jsonl', sessions: {},
    }))
    const entry = sessionLog.buildSessionLogEntry({
      id: 'x1', exchanges: [{ role: 'user', content: 'q', timestamp: 1 }, { role: 'assistant', content: 'a', timestamp: 2 }],
      createdAt: 1, lastActivity: 2, modelPreference: null, endReason: 'server_shutdown',
    })
    // Seed the other path's state with this exact signature: it must not count.
    writeFileSync(join(dataDir, 'session-log-state.json'), JSON.stringify({
      version: 1, logPath: '/elsewhere/.glasses_sessions.jsonl',
      sessions: { x1: { sig: sessionLog.sessionLogSignature(entry), kind: 'shutdown', at: 1 } },
    }))
    expect(sessionLog.writeSessionLogIfChanged(entry, 'shutdown')).toBe('written')
  })
})

describe('session ledger reader (/api/sessions/lookup)', () => {
  const line = (id: string, created: string, ended: string, extra = '') =>
    JSON.stringify({ session_id: id, device_id: 'COS-Glasses', created_at: created, ended_at: ended, note: extra }) + '\n'

  it('collapses duplicates to one widest range per session', async () => {
    const { sessionLog } = await boot()
    writeFileSync(ledger(),
      line('s1', '2026-11-01T10:00:00.000Z', '2026-11-01T10:30:00.000Z')
      + line('s1', '2026-11-01T10:00:00.000Z', '2026-11-01T11:00:00.000Z')
      + line('s1', '2026-11-01T10:00:00.000Z', '2026-11-01T10:45:00.000Z')
      + line('s2', '2026-11-02T09:00:00.000Z', '2026-11-02T09:05:00.000Z'))
    const ranges = await sessionLog.readSessionLogRanges()
    expect(ranges.size).toBe(2)
    expect(ranges.get('s1')).toEqual({ start: Date.parse('2026-11-01T10:00:00.000Z'), end: Date.parse('2026-11-01T11:00:00.000Z') })
  })

  it('reads lines longer than one read chunk, legacy key order, and skips garbage', async () => {
    const { sessionLog } = await boot()
    const big = 'x'.repeat(3 * 1024 * 1024) // spans several 1 MB stream chunks
    writeFileSync(ledger(),
      line('big', '2026-11-03T08:00:00.000Z', '2026-11-03T08:10:00.000Z', big)
      + 'not json at all\n'
      + JSON.stringify({ created_at: '2026-11-04T08:00:00.000Z', session_id: 'legacy', ended_at: '2026-11-04T08:20:00.000Z' }) + '\n'
      + JSON.stringify({ session_id: 'noend', device_id: 'COS-Glasses', created_at: '2026-11-05T08:00:00.000Z' }) + '\n')
    const ranges = await sessionLog.readSessionLogRanges()
    expect([...ranges.keys()].sort()).toEqual(['big', 'legacy', 'noend'])
    expect(ranges.get('legacy')!.end).toBe(Date.parse('2026-11-04T08:20:00.000Z'))
    expect(ranges.get('noend')!.end - ranges.get('noend')!.start).toBe(7_200_000) // the route's 2 h default
  })

  it('reads only appended bytes, waits for a half-written line, and restarts on a replaced file', async () => {
    const { sessionLog } = await boot()
    writeFileSync(ledger(), line('a', '2026-11-01T10:00:00.000Z', '2026-11-01T10:30:00.000Z'))
    expect((await sessionLog.readSessionLogRanges()).size).toBe(1)

    const next = line('b', '2026-11-02T10:00:00.000Z', '2026-11-02T10:30:00.000Z')
    appendFileSync(ledger(), next.slice(0, 20)) // a writer mid-append
    expect([...(await sessionLog.readSessionLogRanges()).keys()]).toEqual(['a'])
    appendFileSync(ledger(), next.slice(20))
    expect([...(await sessionLog.readSessionLogRanges()).keys()].sort()).toEqual(['a', 'b'])

    // Compaction replaces the file with a smaller one (new inode): rebuilt, not appended to.
    const replacement = join(scriptsDir, 'replacement.jsonl')
    writeFileSync(replacement, line('c', '2026-11-03T10:00:00.000Z', '2026-11-03T10:30:00.000Z'))
    renameSync(replacement, ledger())
    expect([...(await sessionLog.readSessionLogRanges()).keys()]).toEqual(['c'])

    // A replacement LARGER than what was read is still a new file (new inode): read from 0.
    writeFileSync(replacement,
      line('d', '2026-11-04T10:00:00.000Z', '2026-11-04T10:30:00.000Z', 'y'.repeat(4_096))
      + line('e', '2026-11-05T10:00:00.000Z', '2026-11-05T10:30:00.000Z'))
    renameSync(replacement, ledger())
    expect([...(await sessionLog.readSessionLogRanges()).keys()].sort()).toEqual(['d', 'e'])
  })

  it('a missing ledger is an empty map, not an error', async () => {
    const { sessionLog } = await boot()
    expect((await sessionLog.readSessionLogRanges()).size).toBe(0)
  })
})
