// Archive endpoints — daily conversation archive for glasses history browser
import { Router } from 'express'
import { listArchiveDateStrings, archiveDir, archiveIndexPath, loadArchive, getArchiveChats, getArchiveDayMessages, appendToArchive } from '../lib/archive.js'
import { getArchiveChatMessagesNumbered } from './message-ref.js'
import { searchArchive, MAX_LIMIT, DEFAULT_LIMIT } from '../lib/archive-search.js'
import { refreshArchiveIndex } from '../lib/archive-index.js'
import { getActiveSessions } from '../lib/conversation.js'

export const archiveRouter = Router()

// v5.15.6 / pkg v6.3.1 — SECURITY: :date is used to build filesystem paths
// (loadArchive/getArchiveChats/getArchiveDayMessages/getArchiveChatMessagesNumbered
// all resolve `<dir>/${date}.json`). Without validation, an encoded traversal
// (e.g. /api/archive/..%2F..%2Fetc%2Fhosts) reads/renames arbitrary *.json on
// the host. Validate the segment as a strict YYYY-MM-DD once for every :date
// route before any fs access.
archiveRouter.param('date', (req, res, next, date) => {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date' })
    return
  }
  next()
})

// GET /api/archive — list all archive dates with summaries
archiveRouter.get('/archive', async (_req, res) => {
  // Index-backed. The previous implementation parsed every day file to reach four
  // summary fields; see archive-index.ts for the measurements that killed it.
  const { entries, rebuilt, fromCache } = await refreshArchiveIndex(archiveDir(), archiveIndexPath())
  res.json({
    archives: entries.map(e => ({
      date: e.date,
      summary: e.summary,
      chatCount: e.chatCount,
      exchangeCount: e.exchangeCount,
    })),
    index: { rebuilt: rebuilt.length, fromCache },
  })
})

// POST /api/archive/now — snapshot active sessions into today's archive (non-destructive)
archiveRouter.post('/archive/now', async (_req, res) => {
  const activeSessions = getActiveSessions()
  if (activeSessions.length === 0) {
    res.json({ archived: 0, date: new Date().toISOString().slice(0, 10) })
    return
  }

  const todayDate = new Date().toISOString().slice(0, 10)
  let archived = 0
  for (const session of activeSessions) {
    await appendToArchive(todayDate, session, { skipLLM: true }) // public thrift: no surprise LLM spend on a manual snapshot
    archived++
  }

  res.json({ archived, date: todayDate })
})

// GET /api/archive/search — literal text search across archived days.
//
// REGISTRATION ORDER IS LOAD-BEARING. It must sit ABOVE /archive/:date: Express
// matches in order, so declared after it this path arrives as :date === 'search'
// and the param validator rejects it with 400 "Invalid date". That is exactly why
// /api/archive/dates has always looked like an empty archive.
//
// The scan never parses a day file — see archive-search.ts for why (one real day
// costs 1.2 GB of heap to materialise). Hits are attributed to a DATE plus text
// snippets; callers open /archive/:date/chats for structure.
archiveRouter.get('/archive/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  const from = typeof req.query.from === 'string' ? req.query.from : undefined
  const to = typeof req.query.to === 'string' ? req.query.to : undefined
  const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10)
  const limit = Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT

  for (const [name, value] of [['from', from], ['to', to]] as const) {
    if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      res.status(400).json({ error: `Invalid ${name}`, expected: 'YYYY-MM-DD' })
      return
    }
  }

  const started = Date.now()
  try {
    const result = await searchArchive({
      dir: archiveDir(),
      dates: listArchiveDateStrings(),
      query: q,
      from,
      to,
      limit: Math.min(limit, MAX_LIMIT),
    })
    res.json({ query: q.trim(), ...result, elapsedMs: Date.now() - started })
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
})

// GET /api/archive/:date — full daily archive
archiveRouter.get('/archive/:date', (req, res) => {
  const archive = loadArchive(req.params.date)
  if (!archive) {
    res.status(404).json({ error: 'Archive not found for date' })
    return
  }
  res.json(archive)
})

// GET /api/archive/:date/chats — chat summaries for a day
archiveRouter.get('/archive/:date/chats', (req, res) => {
  const chats = getArchiveChats(req.params.date)
  res.json({ chats })
})

// GET /api/archive/:date/chats/:index/messages — paired Q&A for a specific chat
archiveRouter.get('/archive/:date/chats/:index/messages', (req, res) => {
  const index = parseInt(req.params.index, 10)
  if (isNaN(index)) {
    res.status(400).json({ error: 'Invalid chat index' })
    return
  }
  // v5.15.1 — numbered form so the browser can show the durable Msg #N
  const messages = getArchiveChatMessagesNumbered(req.params.date, index)
  res.json({ messages })
})

// GET /api/archive/:date/messages — all messages for a day (flat)
archiveRouter.get('/archive/:date/messages', (req, res) => {
  const messages = getArchiveDayMessages(req.params.date)
  res.json({ messages })
})
