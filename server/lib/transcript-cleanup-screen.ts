// Screen context for a meeting (6.77.0): on-screen text lines COS Control reads during a
// meeting, kept so the post-save transcript cleanup can see what was on screen near a
// doubtful passage (a name on a slide, a participant tile, a shared document title).
//
// TEXT ONLY. Images never reach the server through this store. Every line is checked
// with the same secret detector the meeting image OCR uses (imageTextHasSecrets): a
// line that reads like a password, key or token is HELD (counted, never stored), and
// what is stored is also passed through redactSecrets.
//
// BOUNDED. Per request: 100 lines and 32 KB of text. Per line: 400 characters (longer
// lines are cut and counted). Per meeting: 2,000 lines and 400 KB; past either the rest
// of a request is dropped and the response says so. A line repeating one stored in the
// last 30 seconds is a duplicate and is not stored again (OCR re-reads a still screen).
//
// THE MEETING'S OWN DATA. One file per meeting, `transcript-cleanup/screen/<id>.jsonl`,
// beside the meeting's cleanup ledger. It is deleted with the meeting: by
// DELETE /api/meeting/:id/screen-context, by sweepTranscriptCleanupData once no saved
// meeting, live session or pending finalization still carries the id, and in any case
// after the retention window (default 30 days), because screen text is the most
// sensitive thing this feature keeps.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dataPath } from './data-dir.js'
import { redactSecrets } from './lens-gist-engines.js'
import { imageTextHasSecrets } from './meeting-image-ocr.js'

export const SCREEN_LIMITS = {
  linesPerRequest: 100,
  bytesPerRequest: 32 * 1024,
  charsPerLine: 400,
  linesPerMeeting: 2_000,
  bytesPerMeeting: 400 * 1024,
  duplicateWindowMs: 30_000,
  /** A line may be stamped at most this far before the session started or after now. */
  clockSlackMs: 5 * 60_000,
  appChars: 40,
} as const

export const SESSION_ID = /^[A-Za-z0-9:_-]{3,96}$/

export interface ScreenLine {
  /** Epoch ms. */
  at: number
  text: string
  app?: string
}

export interface ScreenAppendResult {
  accepted: number
  duplicates: number
  /** Lines the secret detector held back. Never stored. */
  held: number
  truncated: number
  /** Lines refused for a bad shape or clock. */
  invalid: number
  /** Lines past the per-meeting cap. */
  dropped: number
  stored: number
}

export class ScreenContextError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

export function cleanupDir(...parts: string[]): string {
  return dataPath('transcript-cleanup', ...parts)
}

/** The file for one meeting, or null for an id that could escape the directory. */
export function sessionFile(kind: 'screen' | 'ledger', sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null
  const dir = cleanupDir(kind)
  const path = join(dir, `${sessionId.replace(/:/g, '%3A')}.jsonl`)
  return resolve(path).startsWith(resolve(dir) + '/') ? path : null
}

function parseAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value)
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

const norm = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

export function readScreenContext(sessionId: string): ScreenLine[] {
  const path = sessionFile('screen', sessionId)
  if (!path || !existsSync(path)) return []
  let raw = ''
  try { raw = readFileSync(path, 'utf8') } catch { return [] }
  const out: ScreenLine[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      if (typeof o.at !== 'number' || typeof o.text !== 'string') continue
      out.push({ at: o.at, text: o.text, ...(typeof o.app === 'string' ? { app: o.app } : {}) })
    } catch { /* a torn last line is skipped */ }
  }
  return out
}

export function screenContextStats(sessionId: string): { lines: number; bytes: number; firstAt: number | null; lastAt: number | null } {
  const lines = readScreenContext(sessionId)
  const path = sessionFile('screen', sessionId)
  let bytes = 0
  try { if (path && existsSync(path)) bytes = statSync(path).size } catch { bytes = 0 }
  return { lines: lines.length, bytes, firstAt: lines[0]?.at ?? null, lastAt: lines.at(-1)?.at ?? null }
}

/**
 * Validate and append one request's lines. Throws ScreenContextError for a request the
 * route must refuse whole (bad session id or body shape, too many lines or bytes); a
 * single bad line inside a good request is counted, not fatal.
 */
export function appendScreenContext(
  sessionId: string,
  body: unknown,
  opts: { now: number; sessionStartedAt?: number | null },
): ScreenAppendResult {
  const path = sessionFile('screen', sessionId)
  if (!path) throw new ScreenContextError('invalid_session_id', 400)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ScreenContextError('invalid_request', 400)
  const lines = (body as { lines?: unknown }).lines
  if (!Array.isArray(lines) || lines.length === 0) throw new ScreenContextError('lines_required', 400)
  if (lines.length > SCREEN_LIMITS.linesPerRequest) throw new ScreenContextError('too_many_lines', 413)
  let requestBytes = 0
  for (const line of lines) {
    const text = line && typeof line === 'object' ? (line as { text?: unknown }).text : undefined
    if (typeof text === 'string') requestBytes += Buffer.byteLength(text, 'utf8')
  }
  if (requestBytes > SCREEN_LIMITS.bytesPerRequest) throw new ScreenContextError('request_too_large', 413)

  const existing = readScreenContext(sessionId)
  let storedBytes = 0
  try { if (existsSync(path)) storedBytes = statSync(path).size } catch { storedBytes = SCREEN_LIMITS.bytesPerMeeting }
  const result: ScreenAppendResult = { accepted: 0, duplicates: 0, held: 0, truncated: 0, invalid: 0, dropped: 0, stored: existing.length }
  const recent = existing.slice(-50)
  const earliest = (opts.sessionStartedAt ?? 0) - SCREEN_LIMITS.clockSlackMs
  const latest = opts.now + SCREEN_LIMITS.clockSlackMs
  const rows: string[] = []
  for (const line of lines) {
    if (!line || typeof line !== 'object' || Array.isArray(line)) { result.invalid++; continue }
    const o = line as { at?: unknown; text?: unknown; app?: unknown }
    const at = parseAt(o.at)
    if (at === null || at < earliest || at > latest || typeof o.text !== 'string') { result.invalid++; continue }
    let text = o.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!text) { result.invalid++; continue }
    if (imageTextHasSecrets(o.text) || imageTextHasSecrets(text)) { result.held++; continue }
    text = redactSecrets(text)
    if (text.length > SCREEN_LIMITS.charsPerLine) { text = text.slice(0, SCREEN_LIMITS.charsPerLine); result.truncated++ }
    const key = norm(text)
    if (recent.some(r => norm(r.text) === key && Math.abs(r.at - at) <= SCREEN_LIMITS.duplicateWindowMs)) { result.duplicates++; continue }
    const app = typeof o.app === 'string' ? o.app.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, SCREEN_LIMITS.appChars) : ''
    const row = JSON.stringify({ at, text, ...(app ? { app } : {}) })
    const rowBytes = Buffer.byteLength(row, 'utf8') + 1
    if (result.stored >= SCREEN_LIMITS.linesPerMeeting || storedBytes + rowBytes > SCREEN_LIMITS.bytesPerMeeting) { result.dropped++; continue }
    rows.push(row)
    recent.push({ at, text })
    storedBytes += rowBytes
    result.stored++
    result.accepted++
  }
  if (rows.length) {
    mkdirSync(cleanupDir('screen'), { recursive: true, mode: 0o700 })
    appendFileSync(path, rows.join('\n') + '\n', { mode: 0o600 })
  }
  return result
}

export function deleteScreenContext(sessionId: string): boolean {
  const path = sessionFile('screen', sessionId)
  if (!path) throw new ScreenContextError('invalid_session_id', 400)
  if (!existsSync(path)) return false
  rmSync(path, { force: true })
  return true
}

/** The screen lines to show next to one doubtful passage: the nearest in time, then any naming one of its targets. */
export function screenLinesFor(
  lines: readonly ScreenLine[],
  atMs: number | undefined,
  targets: readonly string[],
  opts: { windowMs?: number; max?: number } = {},
): ScreenLine[] {
  const windowMs = opts.windowMs ?? 45_000
  const max = opts.max ?? 3
  const picked: ScreenLine[] = []
  if (atMs !== undefined) {
    const near = lines.filter(l => Math.abs(l.at - atMs) <= windowMs).sort((a, b) => Math.abs(a.at - atMs) - Math.abs(b.at - atMs))
    for (const line of near) if (picked.length < max && !picked.includes(line)) picked.push(line)
  }
  if (picked.length < max && targets.length) {
    const wanted = targets.map(t => t.toLowerCase()).filter(t => t.length >= 4)
    for (const line of lines) {
      if (picked.length >= max) break
      const lower = line.text.toLowerCase()
      if (!picked.includes(line) && wanted.some(t => lower.includes(t))) picked.push(line)
    }
  }
  return picked
}

/** Days screen text is kept even while its meeting exists. */
export function screenRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.COS_TRANSCRIPT_SCREEN_RETENTION_DAYS)
  return Number.isFinite(raw) && raw >= 1 && raw <= 365 ? Math.floor(raw) : 30
}

/**
 * Delete cleanup data whose meeting is gone, and screen text past its retention.
 * `known(sessionId)` answers whether a saved meeting, a live session or a pending
 * finalization still carries the id. A file younger than `graceMs` is always kept, so a
 * capture still being recovered from quarantine does not lose its screen context.
 */
export function sweepTranscriptCleanupData(opts: {
  now: number
  known: (sessionId: string) => boolean
  retentionDays?: number
  graceMs?: number
}): { screenDeleted: number; ledgersDeleted: number } {
  const graceMs = opts.graceMs ?? 72 * 3_600_000
  const retentionMs = (opts.retentionDays ?? screenRetentionDays()) * 86_400_000
  const out = { screenDeleted: 0, ledgersDeleted: 0 }
  for (const kind of ['screen', 'ledger'] as const) {
    const dir = cleanupDir(kind)
    if (!existsSync(dir)) continue
    let names: string[] = []
    try { names = readdirSync(dir).filter(n => n.endsWith('.jsonl')) } catch { continue }
    for (const name of names) {
      const path = join(dir, name)
      let mtime = 0
      try { mtime = statSync(path).mtimeMs } catch { continue }
      const sessionId = name.slice(0, -'.jsonl'.length).replace(/%3A/g, ':')
      const age = opts.now - mtime
      const expired = kind === 'screen' && age > retentionMs
      let gone = false
      if (!expired && age > graceMs) {
        try { gone = !opts.known(sessionId) } catch { gone = false }
      }
      if (!expired && !gone) continue
      try { rmSync(path, { force: true }); kind === 'screen' ? out.screenDeleted++ : out.ledgersDeleted++ } catch { /* next sweep */ }
    }
  }
  return out
}
