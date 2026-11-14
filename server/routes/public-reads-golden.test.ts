/**
 * 7.0.39 (persistent COS thread, candidate 2): the reads the PUBLIC Mac app and glasses app make are byte for byte what
 * the 7.0.38 release (1737c815) answers, with no thread chat AND with thread chats on disk.
 *
 * HOW THE GOLDEN WAS MADE. The first describe imports only what 1737c815 already exports (the sessions, archive and
 * message-ref routers over a data directory), so this SAME file runs unchanged on 1737c815. Run there with
 * S1_WRITE_GOLDEN=1 and `-t "no thread chat"`, it wrote __fixtures__/public-reads-golden-7038.json (lanes evidence:
 * S1_evidence/cos_thread_c2/). Here both describes must equal that file:
 *   1. the fixture alone (nothing of mine changed these reads);
 *   2. the fixture plus two COS thread conversations, one today and one from yesterday that the boot's archive mirror
 *      would file (a thread chat reaches none of these reads, takes no number, and is never archived).
 * Frozen clock (Date only), placeholder words.
 */
import express from 'express'
import type { Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const NOW = Date.parse('2026-11-14T18:00:00.000Z')
const H = 3600_000
const GOLDEN = join(__dirname, '..', 'lib', '__fixtures__', 'public-reads-golden-7038.json')
const pair = (q: string, a: string, t: number, no?: number) => [
  { role: 'user', content: q, timestamp: t, ...(no ? { globalMsgNum: no } : {}) },
  { role: 'assistant', content: a, timestamp: t + 1000, ...(no ? { globalMsgNum: no } : {}) },
]
const session = (id: string, exchanges: unknown[], at: number, extra: Record<string, unknown> = {}) =>
  ({ id, exchanges, createdAt: at - 60_000, lastActivity: at + 1000, modelPreference: null, contextBreaks: [], ...extra })
/** The 7.0.38 world: numbered and unnumbered chats today, one yesterday the mirror files, two archived days. */
function baseSessions(): Record<string, unknown> {
  return {
    a1111111: session('a1111111', [...pair('question forty-one', 'answer forty-one', NOW - 3 * H, 41), ...pair('question forty-two', 'answer forty-two', NOW - 2 * H, 42)], NOW - 2 * H),
    a2222222: session('a2222222', pair('question without a number', 'answer without a number', NOW - H), NOW - H),
    a3333333: session('a3333333', pair('question thirty-nine', 'answer thirty-nine', NOW - 26 * H, 39), NOW - 26 * H),
  }
}
function threadSessions(): Record<string, unknown> {
  return {
    t4444444: session('t4444444', [...pair('thread question today', 'thread answer today', NOW - 90 * 60_000), ...pair('thread follow-up', 'thread follow-up answer', NOW - 30 * 60_000)], NOW - 30 * 60_000, { cosThread: true }),
    t5555555: session('t5555555', pair('thread question yesterday', 'thread answer yesterday', NOW - 27 * H), NOW - 27 * H, { cosThread: true }),
  }
}
function archiveDay(date: string, sessionId: string, no: number, at: number) {
  return { date, summary: 'placeholder day', archivedAt: new Date(at + H).toISOString(), chats: [{
    id: 0, sessionId, exchanges: pair(`question ${no}`, `answer ${no}`, at, no), startedAt: at, endedAt: at + 1000, exchangeCount: 2, summary: `placeholder chat ${no}`,
  }] }
}

const roots: string[] = []
let server: Server | null = null
afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()))
  server = null
  vi.useRealTimers()
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true }))
  vi.resetModules()
})

/** Every public read, in a fixed order, through the real routers over a fresh data directory holding `sessions`. */
async function readAll(sessions: Record<string, unknown>): Promise<Record<string, { status: number; body: unknown }>> {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  vi.resetModules()
  const root = mkdtempSync(join(tmpdir(), 'cos-public-reads-')); roots.push(root)
  mkdirSync(join(root, 'archive'), { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'sessions.json'), JSON.stringify({ sessions, savedAt: new Date(NOW).toISOString() }), { mode: 0o600 })
  writeFileSync(join(root, 'archive', '2026-11-11.json'), JSON.stringify(archiveDay('2026-11-11', 'b6666666', 30, NOW - 3 * 24 * H)), { mode: 0o600 })
  writeFileSync(join(root, 'archive', '2026-11-12.json'), JSON.stringify(archiveDay('2026-11-12', 'b7777777', 35, NOW - 2 * 24 * H)), { mode: 0o600 })
  process.env.COS_DATA_DIR = root
  const { sessionsRouter } = await import('./sessions.js')
  const { archiveRouter } = await import('./archive.js')
  const { messageRefRouter } = await import('./message-ref.js')
  const app = express(); app.use(express.json()); app.use('/api', sessionsRouter, archiveRouter, messageRefRouter)
  server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}/api`
  const out: Record<string, { status: number; body: unknown }> = {}
  // all-messages first: it waits for the boot's archive mirror to file yesterday, as on a real first read.
  for (const path of ['/sessions/today/all-messages', '/sessions/today/all-messages?limit=100', '/sessions/today/live-chats', '/sessions/recent',
    '/archive', '/archive/search?q=question', '/archive/2026-11-13', '/archive/2026-11-13/chats', '/archive/2026-11-13/chats/0/messages',
    '/archive/2026-11-13/messages', '/archive/2026-11-12/messages', '/archive/2026-11-11/chats/0/messages', '/message-counter', '/message/41', '/message/30']) {
    const res = await fetch(base + path)
    out[path] = { status: res.status, body: await res.json() }
  }
  return out
}

describe('the public reads, no thread chat', () => {
  it('equal the 7.0.38 golden', async () => {
    const reads = await readAll(baseSessions())
    if (process.env.S1_WRITE_GOLDEN === '1') writeFileSync(GOLDEN, JSON.stringify(reads, null, 1) + '\n')
    expect(reads).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')))
  })
})

describe('the public reads, with thread conversations on disk (7.0.39)', () => {
  it('still equal the 7.0.38 golden: no row, no chat, no number, nothing archived', async () => {
    const reads = await readAll({ ...baseSessions(), ...threadSessions() })
    expect(reads).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')))
    expect(JSON.stringify(reads)).not.toContain('thread')
  })
})
