// Archive endpoints — daily conversation archive for glasses history browser
import { Router } from 'express'
import { listArchiveDates, loadArchive, getArchiveChats, getArchiveDayMessages, appendToArchive } from '../lib/archive.js'
import { getArchiveChatMessagesNumbered } from './message-ref.js'
import { getActiveSessions } from '../lib/conversation.js'

export const archiveRouter = Router()

// GET /api/archive — list all archive dates with summaries
archiveRouter.get('/archive', (_req, res) => {
  const archives = listArchiveDates()
  res.json({ archives })
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
    await appendToArchive(todayDate, session)
    archived++
  }

  res.json({ archived, date: todayDate })
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
