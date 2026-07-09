// Global message reference resolution (v5.15.0) — the server half of
// "reference message N" across days. Numbers are stamped at exchange time
// (client-sent, stored via conversation.addExchange) and persist durably in
// the day archives; this router resolves a number the client no longer holds
// in its local list, and publishes the numbering ceiling so a cleared or
// fresh client continues the sequence instead of reusing numbers.
//
//   GET /api/message/:num     → { globalMsgNum, date, query, response }  (404 when unknown)
//   GET /api/message-counter  → { max }
//
// Resolution order (per the prompt-queue/archive plan): live in-memory
// sessions first (covers the mirror's 15-minute lag), then day archives
// newest-first. Day files are read as plain data — their write path belongs
// to the archive workstream and is not touched here.
import { Router } from 'express'
import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { getActiveSessions } from '../lib/conversation.js'
import { dataPath } from '../lib/data-dir.js'

// v6.3.0 — read archives from the SAME persistent location the archive-mirror
// writes to (~/.cos-glasses/data/archive via dataPath), not a package-relative
// dir. The app repo uses server/data/archive; the public package uses dataPath,
// so this file must match the package's lib/archive.ts, or npx users' cross-day
// references + archive-chat detail read an empty/nonexistent directory.
const ARCHIVE_DIR = dataPath('archive')

export interface ResolvedGlobalMessage {
  globalMsgNum: number
  date: string
  query: string
  response: string
}

interface ExchangeLike {
  role?: string
  content?: string
  timestamp?: number
  globalMsgNum?: number
}

/** Pair the stamped exchange with its other half: a user turn pairs forward
 *  to the next assistant turn; an assistant turn pairs backward. */
function pairExchange(exchanges: ExchangeLike[], i: number): { query: string; response: string } {
  const hit = exchanges[i]
  const user = hit.role === 'user'
    ? hit
    : [...exchanges.slice(0, i)].reverse().find((e) => e?.role === 'user')
  const assistant = hit.role === 'assistant'
    ? hit
    : exchanges.slice(i + 1).find((e) => e?.role === 'assistant')
  return { query: user?.content ?? '', response: assistant?.content ?? '' }
}

function scanExchanges(exchanges: ExchangeLike[], num: number, date: string): ResolvedGlobalMessage | null {
  for (let i = 0; i < exchanges.length; i++) {
    if (exchanges[i]?.globalMsgNum !== num) continue
    const { query, response } = pairExchange(exchanges, i)
    return { globalMsgNum: num, date, query, response }
  }
  return null
}

/** Resolve a global message number from the day archives, newest-first.
 *  Exported with an explicit dir for tests. */
export function resolveFromArchiveDir(dir: string, num: number): ResolvedGlobalMessage | null {
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse()
  } catch {
    return null
  }
  for (const f of files) {
    try {
      const day = JSON.parse(readFileSync(resolve(dir, f), 'utf8'))
      const chats = Array.isArray(day?.chats) ? day.chats : []
      for (const chat of chats) {
        const exchanges = Array.isArray(chat?.exchanges) ? chat.exchanges : []
        const hit = scanExchanges(exchanges, num, typeof day?.date === 'string' ? day.date : f.slice(0, 10))
        if (hit) return hit
      }
    } catch {
      // Unreadable/corrupt day file — skip; the archive workstream owns repair.
    }
  }
  return null
}

/** Read a specific archived chat's paired Q&A messages WITH their durable
 *  global numbers (the archive-lib read path strips globalMsgNum; the browser
 *  needs it so "reference message N" is self-evident from the screen). Same
 *  user->next-assistant pairing as the lib; the pair's number is the user
 *  turn's stamp (falling back to the assistant's). Dir-param form for tests. */
export function readArchiveChatNumbered(
  dir: string,
  date: string,
  chatIndex: number,
): Array<{ query: string; text: string; timestamp: number; no?: number }> {
  // Defense-in-depth against path traversal — `date` builds a `${date}.json`
  // path. The archive route also validates, but this is exported/reused.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
  let day: { chats?: Array<{ id?: number; exchanges?: ExchangeLike[] }> }
  try {
    day = JSON.parse(readFileSync(resolve(dir, `${date}.json`), 'utf8'))
  } catch {
    return []
  }
  const chat = (Array.isArray(day?.chats) ? day.chats : []).find((c) => c?.id === chatIndex)
  if (!chat) return []
  const exchanges: ExchangeLike[] = Array.isArray(chat.exchanges) ? chat.exchanges : []
  const out: Array<{ query: string; text: string; timestamp: number; no?: number }> = []
  for (let i = 0; i < exchanges.length; i++) {
    const ex = exchanges[i]
    if (ex?.role !== 'user') continue
    const next = exchanges[i + 1]
    if (next?.role !== 'assistant') continue
    out.push({
      query: ex.content ?? '',
      text: next.content ?? '',
      timestamp: next.timestamp ?? ex.timestamp ?? 0,
      no: ex.globalMsgNum ?? next.globalMsgNum,
    })
    i++
  }
  return out
}

/** ARCHIVE_DIR-bound form for the route. */
export function getArchiveChatMessagesNumbered(date: string, chatIndex: number) {
  return readArchiveChatNumbered(ARCHIVE_DIR, date, chatIndex)
}

/** Highest stamped number across the day archives (0 when none). */
export function maxGlobalMsgNumInDir(dir: string): number {
  let max = 0
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  } catch {
    return 0
  }
  for (const f of files) {
    try {
      const day = JSON.parse(readFileSync(resolve(dir, f), 'utf8'))
      for (const chat of Array.isArray(day?.chats) ? day.chats : []) {
        for (const ex of Array.isArray(chat?.exchanges) ? chat.exchanges : []) {
          if (typeof ex?.globalMsgNum === 'number' && ex.globalMsgNum > max) max = ex.globalMsgNum
        }
      }
    } catch { /* skip */ }
  }
  return max
}

function resolveFromLiveSessions(num: number): ResolvedGlobalMessage | null {
  const today = new Date().toISOString().slice(0, 10)
  for (const session of getActiveSessions()) {
    const exchanges = (session as { exchanges?: ExchangeLike[] }).exchanges ?? []
    const hit = scanExchanges(exchanges, num, today)
    if (hit) return hit
  }
  return null
}

export const messageRefRouter = Router()

messageRefRouter.get('/message/:num', (req, res) => {
  const num = Number.parseInt(req.params.num, 10)
  if (!Number.isFinite(num) || num < 1) {
    res.status(400).json({ error: 'invalid message number' })
    return
  }
  const hit = resolveFromLiveSessions(num) ?? resolveFromArchiveDir(ARCHIVE_DIR, num)
  if (!hit) {
    res.status(404).json({ error: `message ${num} not found` })
    return
  }
  res.json(hit)
})

messageRefRouter.get('/message-counter', (_req, res) => {
  let liveMax = 0
  for (const session of getActiveSessions()) {
    for (const ex of ((session as { exchanges?: ExchangeLike[] }).exchanges ?? [])) {
      if (typeof ex?.globalMsgNum === 'number' && ex.globalMsgNum > liveMax) liveMax = ex.globalMsgNum
    }
  }
  res.json({ max: Math.max(liveMax, maxGlobalMsgNumInDir(ARCHIVE_DIR)) })
})
