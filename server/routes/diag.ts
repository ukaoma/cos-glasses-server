// POST /api/diag/client — Client-side diagnostic log sink.
//
// Accepts JSON blobs from the COS Glasses WebView and appends them to a
// JSONL file for post-crash analysis. Unauth'd (same whitelist as /health)
// so it works during the boot-time heartbeat before the wizard has supplied
// an API token.
//
// Shipped in v5.3.4 to debug the "45-chunk mystery crash" (2026-04-11).
// Volume is expected to be tiny: ~6 heartbeats/minute during meetings + a
// handful of error events on failures. The server caps file size at 10 MB
// and rotates to `.1` when full (keeps only 1 rotation — this is a
// debug-only facility, not a long-term archive).

import { Router } from 'express'
import { writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
import { dataPath } from '../lib/data-dir.js'
import { recordSessionHeartbeat } from '../lib/session-heartbeats.js'
const DIAG_DIR = dataPath()
const DIAG_FILE = resolve(DIAG_DIR, 'client-diagnostics.jsonl')
const MAX_FILE_BYTES = 10 * 1024 * 1024  // 10 MB cap

if (!existsSync(DIAG_DIR)) mkdirSync(DIAG_DIR, { recursive: true })
if (!existsSync(DIAG_FILE)) writeFileSync(DIAG_FILE, '')

export const diagRouter = Router()

// In-memory rate limit: max 30 entries per 10 s window per sessionId (or anon).
// Prevents a runaway error loop from flooding the log.
const rateWindows = new Map<string, { windowStart: number; count: number }>()
const RATE_WINDOW_MS = 10_000
const RATE_MAX_PER_WINDOW = 30

function rateLimited(key: string): boolean {
  const now = Date.now()
  const bucket = rateWindows.get(key)
  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    rateWindows.set(key, { windowStart: now, count: 1 })
    return false
  }
  bucket.count++
  return bucket.count > RATE_MAX_PER_WINDOW
}

function rotateIfOversized(): void {
  try {
    const stats = statSync(DIAG_FILE)
    if (stats.size > MAX_FILE_BYTES) {
      const rotated = DIAG_FILE + '.1'
      renameSync(DIAG_FILE, rotated)
      writeFileSync(DIAG_FILE, '')
      console.log(`[diag] Rotated ${DIAG_FILE} → ${rotated} (was ${stats.size} bytes)`)
    }
  } catch { /* best-effort */ }
}

diagRouter.post('/diag/client', async (req, res) => {
  const body = req.body as Record<string, unknown>

  // Must have a timestamp and an event name — everything else is optional
  const ts = typeof body.ts === 'number' ? body.ts : Date.now()
  const level = typeof body.level === 'string' ? body.level : 'info'
  const event = typeof body.event === 'string' ? body.event : 'unknown'
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
  const data = (body.data && typeof body.data === 'object') ? body.data : {}

  // Reject orphan heartbeats from zombie clients (session was deleted/saved already).
  // 410 Gone tells client to stop hitting this endpoint and reset its session state.
  if (sessionId && event === 'heartbeat') {
    try {
      const { isSessionDeleted } = await import('./transcribe-stream.js')
      if (isSessionDeleted(sessionId)) {
        return res.status(410).json({ error: 'session_deleted', sessionId })
      }
    } catch { /* import failure: fall through to normal logging */ }
    // Positive liveness for the stranded-session sweeper. A phone can be capturing
    // while its uploads are blocked, so chunk silence alone must not mark a
    // session stale — this is the only signal that can say "still recording".
    // Lossy by nature (fire-and-forget, 3s abort, silent catch), which is why it
    // may only VETO a stale verdict and never cause one.
    const heartbeatData = data as Record<string, unknown>
    recordSessionHeartbeat(sessionId, {
      at: ts,
      audioState: typeof heartbeatData.audioState === 'string' ? heartbeatData.audioState : null,
      visibilityState: typeof heartbeatData.visibilityState === 'string'
        ? heartbeatData.visibilityState
        : null,
    })
  }

  // Rate limit per sessionId (or remote address as fallback)
  const rateKey = sessionId || req.ip || 'anon'
  if (rateLimited(rateKey)) {
    return res.status(429).json({ error: 'rate_limited' })
  }

  // Rotate if oversized (cheap — stat call + optional rename)
  rotateIfOversized()

  const line = JSON.stringify({
    ts,
    level,
    event,
    sessionId,
    data,
    server_received: Date.now(),
  }) + '\n'

  try {
    appendFileSync(DIAG_FILE, line)
    res.status(204).end()
  } catch (err: any) {
    console.error(`[diag] Failed to append: ${err?.message ?? err}`)
    res.status(500).json({ error: 'write_failed' })
  }
})

// GET /api/diag/health — quick check that the diag endpoint is reachable.
// Also returns current file size so clients can verify writes are landing.
diagRouter.get('/diag/health', (_req, res) => {
  let size = 0
  try {
    size = statSync(DIAG_FILE).size
  } catch { /* file missing is OK, will be created on next POST */ }
  res.json({ ok: true, file: DIAG_FILE, size })
})
