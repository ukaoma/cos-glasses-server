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

    expect(conversation.logActiveSessionsOnShutdown()).toEqual({ written: 1, unchanged: 0, unconfigured: 0, failed: 0 })
    expect(ledgerLines()).toHaveLength(1)

    for (let restart = 0; restart < 3; restart++) {
      ;({ conversation } = await boot())
      expect(conversation.getSessionRaw(id)?.exchanges).toHaveLength(2) // restored from sessions.json
      // The first snapshot after a boot used to re-append every session.
      expect(conversation.runAutoSnapshotOnce()).toEqual({ written: 0, unchanged: 1, unconfigured: 0, failed: 0 })
      expect(conversation.logActiveSessionsOnShutdown()).toEqual({ written: 0, unchanged: 1, unconfigured: 0, failed: 0 })
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
    expect(conversation.runAutoSnapshotOnce()).toEqual({ written: 1, unchanged: 0, unconfigured: 0, failed: 0 })
    expect(conversation.runAutoSnapshotOnce()).toEqual({ written: 0, unchanged: 0, unconfigured: 0, failed: 0 }) // count pre-check
    expect(conversation.logActiveSessionsOnShutdown()).toEqual({ written: 0, unchanged: 1, unconfigured: 0, failed: 0 })
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
    expect(ranges.get('s1')).toEqual({
      start: Date.parse('2026-11-01T10:00:00.000Z'),
      firstEnd: Date.parse('2026-11-01T10:30:00.000Z'),
      end: Date.parse('2026-11-01T11:00:00.000Z'),
    })
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

// Q1 review M1 (2026-11-09): the lookup's range rule from before S1, unchanged. The old loop never
// widened a session still in memory, and every boot snapshot of a restored session is stamped
// ended_at = now; widening would let an old session claim today's timestamps, and the glasses
// companion stores the answer permanently (cos-glasses-app Main.ts retro-stamping).
describe('lookup ranges keep the old rule (M1)', () => {
  const T = (iso: string) => Date.parse(iso)
  it('a session in memory keeps its FIRST line end; one not in memory is widened to its latest end', async () => {
    const { sessionLog } = await boot()
    const history = new Map([
      ['restored', { start: T('2026-10-01T10:00:00Z'), firstEnd: T('2026-10-01T10:30:00Z'), end: T('2026-11-09T19:00:00Z') }],
      ['gone', { start: T('2026-10-02T10:00:00Z'), firstEnd: T('2026-10-02T10:30:00Z'), end: T('2026-10-02T12:00:00Z') }],
      ['live', { start: T('2026-11-09T18:00:00Z'), firstEnd: T('2026-11-09T18:10:00Z'), end: T('2026-11-09T19:00:00Z') }],
    ])
    expect(sessionLog.lookupRangesFromHistory(history, sid => sid === 'restored' || sid === 'live', new Set(['live']))).toEqual([
      { sid: 'restored', start: T('2026-10-01T10:00:00Z'), end: T('2026-10-01T10:30:00Z') },
      { sid: 'gone', start: T('2026-10-02T10:00:00Z'), end: T('2026-10-02T12:00:00Z') },
    ])
  })

  it('a later line never moves a session’s start (the old loop kept the first line’s)', async () => {
    const { sessionLog } = await boot()
    const line = (created: string, ended: string) => JSON.stringify({ session_id: 'x', device_id: 'COS-Glasses', created_at: created, ended_at: ended }) + '\n'
    writeFileSync(ledger(), line('2026-10-05T10:00:00Z', '2026-10-05T11:00:00Z') + line('2026-10-01T10:00:00Z', '2026-10-05T12:00:00Z'))
    const ranges = await sessionLog.readSessionLogRanges()
    expect(ranges.get('x')).toEqual({ start: T('2026-10-05T10:00:00Z'), firstEnd: T('2026-10-05T11:00:00Z'), end: T('2026-10-05T12:00:00Z') })
  })

  it('through the real route: a restored October session does not claim a timestamp from its boot snapshot', async () => {
    const { conversation } = await boot()
    const express = (await import('express')).default
    const { sessionsRouter } = await import('../routes/sessions.js')
    // A session from October, restored in memory (sessions.json keeps every age).
    const id = conversation.createSession()
    conversation.addExchange(id, 'user', 'October question')
    conversation.addExchange(id, 'assistant', 'October answer')
    const raw = conversation.getSessionRaw(id)!
    raw.createdAt = T('2026-10-01T10:00:00Z')
    raw.lastActivity = T('2026-10-01T10:30:00Z')
    for (const e of raw.exchanges) e.timestamp = T('2026-10-01T10:20:00Z')
    // Its original end, then the boot snapshot this server really writes (ended_at = now).
    writeFileSync(ledger(), JSON.stringify({ session_id: id, device_id: 'COS-Glasses', created_at: '2026-10-01T10:00:00.000Z', ended_at: '2026-10-01T10:30:00.000Z' }) + '\n')
    expect(conversation.runAutoSnapshotOnce().written).toBe(1)
    const snapshot = ledgerLines().at(-1)!
    expect(Date.parse(snapshot.ended_at)).toBeGreaterThan(Date.now() - 60_000) // stamped now
    // A session no longer in memory still widens to its latest end, as before.
    appendFileSync(ledger(),
      JSON.stringify({ session_id: 'gone0001', device_id: 'COS-Glasses', created_at: '2026-10-02T10:00:00.000Z', ended_at: '2026-10-02T10:30:00.000Z' }) + '\n'
      + JSON.stringify({ session_id: 'gone0001', device_id: 'COS-Glasses', created_at: '2026-10-02T10:00:00.000Z', ended_at: '2026-10-02T12:00:00.000Z' }) + '\n')

    const app = express(); app.use(express.json()); app.use('/api', sessionsRouter)
    const server = await new Promise<import('node:http').Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    try {
      const port = (server.address() as import('node:net').AddressInfo).port
      const anHourAgo = Date.now() - 60 * 60_000
      const inOctober = T('2026-10-01T10:15:00Z')
      const widened = T('2026-10-02T11:30:00Z')
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions/lookup`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timestamps: [anHourAgo, inOctober, widened] }),
      })
      const body = await res.json() as { results: Record<string, string | null> }
      expect(body.results[String(anHourAgo)]).toBeNull()      // before S1's fix-of-the-fix: the October id
      expect(body.results[String(inOctober)]).toBe(id)
      expect(body.results[String(widened)]).toBe('gone0001')
    } finally {
      await new Promise(r => server.close(r))
    }
  })
})

// Q1 review M2 (2026-11-09): COS Control's generated .env has no COS_SCRIPTS_DIR, so a new install
// has no ledger. That must not print a line per session every 5 minutes.
describe('no ledger configured: the new-install default (M2)', () => {
  it('says so once per process; snapshots record the count and stay quiet; shutdown reports nothing', async () => {
    delete process.env.COS_SCRIPTS_DIR
    const log = vi.spyOn(console, 'log')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { conversation, sessionLog } = await boot()
    const a = conversation.createSession(); conversation.addExchange(a, 'user', 'q'); conversation.addExchange(a, 'assistant', 'r')
    const b = conversation.createSession(); conversation.addExchange(b, 'user', 'q2'); conversation.addExchange(b, 'assistant', 'r2')
    expect(conversation.runAutoSnapshotOnce()).toEqual({ written: 0, unchanged: 0, unconfigured: 2, failed: 0 })
    for (let tick = 0; tick < 5; tick++) expect(conversation.runAutoSnapshotOnce()).toEqual({ written: 0, unchanged: 0, unconfigured: 0, failed: 0 })
    expect(conversation.logActiveSessionsOnShutdown()).toEqual({ written: 0, unchanged: 0, unconfigured: 2, failed: 0 })
    sessionLog.logSessionEnd({ id: 'x', exchanges: [{ role: 'user', content: 'q', timestamp: 1 }], createdAt: 1, lastActivity: 2, modelPreference: null, endReason: 'ttl_expiry' })
    const cache = await import('./session-cache-writer.js')
    for (let i = 0; i < 3; i++) cache.updateGlassesSessionCache() // ran after every exchange before; said each time
    const lines = [...log.mock.calls, ...warn.mock.calls].map(c => String(c[0])).filter(l => l.includes('COS_SCRIPTS_DIR') && /^\[session-(log|cache)\]/.test(l))
    expect(lines).toEqual([
      '[session-log] COS_SCRIPTS_DIR not set: no .glasses_sessions.jsonl ledger on this install (said once)',
      '[session-cache] COS_SCRIPTS_DIR not set — skipping cache writes (said once)',
    ])
    expect(log.mock.calls.some(c => String(c[0]).startsWith('[session-log] shutdown:'))).toBe(false)
    expect(existsSync(join(dataDir, 'session-log-state.json'))).toBe(false)
  })

  it('a failed write is recorded too, so it is retried only after the session changes (as before S1)', async () => {
    const { conversation } = await boot()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const id = conversation.createSession(); conversation.addExchange(id, 'user', 'q'); conversation.addExchange(id, 'assistant', 'r')
    rmSync(scriptsDir, { recursive: true, force: true })
    writeFileSync(scriptsDir, 'not a folder') // every append now fails
    expect(conversation.runAutoSnapshotOnce().failed).toBe(1)
    expect(conversation.runAutoSnapshotOnce()).toEqual({ written: 0, unchanged: 0, unconfigured: 0, failed: 0 })
    rmSync(scriptsDir, { force: true })
  })
})

describe('ledger state follows the file it describes (Q1 S5)', () => {
  it('a replaced or deleted ledger gets every session again on the next pass', async () => {
    let { conversation } = await boot()
    const id = conversation.createSession(); conversation.addExchange(id, 'user', 'q'); conversation.addExchange(id, 'assistant', 'r')
    conversation.flushConversationToDisk()
    expect(conversation.logActiveSessionsOnShutdown().written).toBe(1)
    // Replaced (a compaction's atomic rename, or a restore): a new file without this session.
    const replacement = join(scriptsDir, 'restored.jsonl')
    writeFileSync(replacement, '')
    renameSync(replacement, ledger())
    ;({ conversation } = await boot())
    expect(conversation.logActiveSessionsOnShutdown()).toMatchObject({ written: 1, unchanged: 0 })
    expect(ledgerLines()).toHaveLength(1)
    // Unchanged file: unchanged again.
    ;({ conversation } = await boot())
    expect(conversation.logActiveSessionsOnShutdown()).toMatchObject({ written: 0, unchanged: 1 })
    // Deleted: written again.
    rmSync(ledger())
    ;({ conversation } = await boot())
    expect(conversation.logActiveSessionsOnShutdown()).toMatchObject({ written: 1, unchanged: 0 })
  })
})
