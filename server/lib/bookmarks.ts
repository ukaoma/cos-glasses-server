// Bookmarks — save individual messages for quick reference from glasses
// Stored as a flat JSON array in server/data/bookmarks.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMediaAttachmentRefs, type MediaAttachmentRef } from '../../shared/media-attachment.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = resolve(__dirname, '..', 'data')
const BOOKMARKS_PATH = resolve(DATA_DIR, 'bookmarks.json')

// ── Interfaces ──────────────────────────────────────────────

export interface Bookmark {
  id: number
  query: string              // original user query
  text: string               // COS response (plain text, markdown stripped)
  label: string              // short label for list display
  savedAt: number            // when bookmarked (epoch ms)
  originalTimestamp: number  // when message was originally received
  messageIndex: number       // which message # it was in the session
  attachments?: MediaAttachmentRef[]  // Release A — refs only, never bytes
}

// ── Read/Write ──────────────────────────────────────────────

function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true })
}

export function loadBookmarks(): Bookmark[] {
  try {
    const raw = readFileSync(BOOKMARKS_PATH, 'utf-8')
    return JSON.parse(raw) as Bookmark[]
  } catch {
    return []
  }
}

function saveBookmarks(bookmarks: Bookmark[]): void {
  ensureDataDir()
  writeFileSync(BOOKMARKS_PATH, JSON.stringify(bookmarks, null, 2))
}

// ── Operations ──────────────────────────────────────────────

/** Save a message as a bookmark. Returns the new bookmark. Attachment refs
 *  are optional, validated through the strict parser (refs only, no bytes). */
export function addBookmark(
  query: string,
  text: string,
  messageIndex: number,
  originalTimestamp: number,
  attachments?: unknown,
): Bookmark {
  const bookmarks = loadBookmarks()

  // Auto-generate label from query (first 50 chars)
  const label = query.length > 50 ? query.slice(0, 47) + '...' : query

  // Next ID = max existing + 1
  const nextId = bookmarks.length > 0 ? Math.max(...bookmarks.map(b => b.id)) + 1 : 1

  const validRefs = parseMediaAttachmentRefs(attachments)
  const bookmark: Bookmark = {
    id: nextId,
    query,
    text,
    label,
    savedAt: Date.now(),
    originalTimestamp,
    messageIndex,
    ...(validRefs.length > 0 ? { attachments: validRefs } : {}),
  }

  bookmarks.push(bookmark)
  saveBookmarks(bookmarks)
  return bookmark
}

/** Delete a bookmark by ID. Returns true if found and deleted. */
export function deleteBookmark(id: number): boolean {
  const bookmarks = loadBookmarks()
  const idx = bookmarks.findIndex(b => b.id === id)
  if (idx === -1) return false
  bookmarks.splice(idx, 1)
  saveBookmarks(bookmarks)
  return true
}

/** Get a single bookmark by ID */
export function getBookmark(id: number): Bookmark | null {
  const bookmarks = loadBookmarks()
  return bookmarks.find(b => b.id === id) ?? null
}
