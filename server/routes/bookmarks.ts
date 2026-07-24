// Bookmark endpoints — save/retrieve individual messages
import { Router } from 'express'
import { loadBookmarks, addBookmark, deleteBookmark, getBookmark } from '../lib/bookmarks.js'

export const bookmarksRouter = Router()

// GET /api/bookmarks — list all bookmarks (newest first)
bookmarksRouter.get('/bookmarks', (_req, res) => {
  const bookmarks = loadBookmarks()
  // Return newest first
  res.json({ bookmarks: [...bookmarks].reverse() })
})

// GET /api/bookmarks/:id — get a single bookmark
bookmarksRouter.get('/bookmarks/:id', (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid bookmark ID' })
    return
  }
  const bookmark = getBookmark(id)
  if (!bookmark) {
    res.status(404).json({ error: 'Bookmark not found' })
    return
  }
  res.json(bookmark)
})

// POST /api/bookmarks — save a new bookmark (optional attachment refs)
bookmarksRouter.post('/bookmarks', (req, res) => {
  const { query, text, messageIndex, originalTimestamp, attachments } = req.body
  if (!query || !text) {
    res.status(400).json({ error: 'query and text are required' })
    return
  }
  const bookmark = addBookmark(
    query,
    text,
    messageIndex ?? 0,
    originalTimestamp ?? Date.now(),
    attachments,
  )
  res.json({ bookmark })
})

// DELETE /api/bookmarks/:id — delete a bookmark
bookmarksRouter.delete('/bookmarks/:id', (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid bookmark ID' })
    return
  }
  const deleted = deleteBookmark(id)
  if (!deleted) {
    res.status(404).json({ error: 'Bookmark not found' })
    return
  }
  res.json({ deleted: true })
})
