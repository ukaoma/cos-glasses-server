// POST /api/tts/stream — proxy OpenAI gpt-4o-mini-tts streaming bytes to the
// companion app so Voice Mode can read responses aloud over the user's paired
// Bluetooth/AirPods.
//
// Why proxy: the OPENAI_API_KEY must never reach the client. We also enforce a
// per-day budget cap (mirrors the Whisper budget) so a runaway voice loop can't
// silently rack up cost.
//
// Why streaming: gpt-4o-mini-tts can stream audio bytes as they're generated
// (Chunked Transfer-Encoding). We pipe OpenAI's response body straight to our
// HTTP response — first byte from OpenAI = first byte to the companion. That
// gets first-audio under ~1s for typical responses.

import { Router } from 'express'
import { errMsg } from '../lib/utils.js'
import { getOpenAIKey } from '../lib/openai-key.js'
import {
  assertOpenAITtsBudget,
  recordOpenAITtsUsage,
  OpenAITtsBudgetExhaustedError,
} from '../lib/openai-tts-budget.js'
import {
  hashKey,
  getCached,
  startEntry,
  appendBytes,
  completeEntry,
  abortEntry,
  createSession,
  peekSession,
  reapExpiredSessions,
  waitForInFlight,
  getCacheStats,
} from '../lib/tts-cache.js'

export const ttsRouter = Router()

// Sweep expired sessions every 30s. Cheap O(N) scan over a tiny map (sessions
// live <= 60s and arrive at human-tap rate). Single interval lives for the
// process lifetime — no teardown needed.
setInterval(reapExpiredSessions, 30_000).unref()

// Hard text length cap — OpenAI gpt-4o-mini-tts accepts up to 4096 input chars.
// Anything longer would be rejected; we trim defensively at a sentence boundary
// near the cap so the audio doesn't end mid-word.
const MAX_TTS_CHARS = 4000

// OpenAI voice IDs supported by gpt-4o-mini-tts. Default is alloy (warm,
// neutral, gender-neutral). Voice can be overridden per-request and the
// server-side default is configurable via COS_VOICE_DEFAULT.
const SUPPORTED_VOICES = new Set([
  'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'ash', 'sage', 'coral',
])
const DEFAULT_VOICE = (() => {
  const env = process.env.COS_VOICE_DEFAULT
  return env && SUPPORTED_VOICES.has(env) ? env : 'echo'
})()

const DEFAULT_INSTRUCTIONS = process.env.COS_VOICE_INSTRUCTIONS || ''

// Audio output formats. mp3 is the safest cross-platform default (HTML5 audio
// + iOS WKWebView both decode it natively). opus is smaller but MSE support is
// patchier on iOS Safari.
const SUPPORTED_FORMATS = new Set(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'])
const FORMAT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
}

/** Trim text to MAX_TTS_CHARS at a sentence boundary if possible. */
function trimToCap(text: string): string {
  if (text.length <= MAX_TTS_CHARS) return text
  const slice = text.slice(0, MAX_TTS_CHARS)
  // Walk back to the last sentence terminator (.!?) to avoid mid-word cuts.
  const lastTerm = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '))
  if (lastTerm > MAX_TTS_CHARS * 0.6) return slice.slice(0, lastTerm + 1)
  // Fall back to the last word boundary.
  const lastSpace = slice.lastIndexOf(' ')
  return lastSpace > 0 ? slice.slice(0, lastSpace) : slice
}

/** Defensive markdown strip — client should already have done this, but a
 *  caller (or future archive playback) might pass raw markdown. Cheap regex set,
 *  matches the client-side stripMarkdown() at src/lib/display-pages.ts. */
function stripMarkdownLight(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/^[-*+]\s/gm, '- ')
}

// ── v5.9.6 fast-prefix splitter ───────────────────────────────────────────
//
// The "fast first-audio" path (POST /api/tts/prepare with fast: true) wants
// to start playing audio in ~1-2s instead of the 8-15s a full-message OpenAI
// render takes for long replies. We do that by splitting the input into a
// short prefix the client can play immediately, and a tail that gets
// generated in parallel and chained on prefix `ended`.
//
// Heuristic-only — no NLP dependency. Markdown is already stripped above.
// Boundary detection uses the same .!? + whitespace rule as trimToCap so the
// two stay consistent. Bounded lengths protect against pathological inputs:
//   - MIN_PREFIX_CHARS: short greetings ("Hi.") get padded with the next
//     sentence so the prefix is long enough to mask tail-render latency.
//   - MAX_PREFIX_CHARS: a single long sentence ("So basically I think we…
//     spanning 600 chars") gets cut at a word boundary instead of running on.
const MIN_PREFIX_CHARS = 60
const MAX_PREFIX_CHARS = 250

/** Split `text` into a fast-playable prefix + a tail.
 *
 *  Contract:
 *  - Returns `{ prefix, tail }` with `prefix` non-empty and `tail` either ''
 *    (the message fits in one chunk and the route should fall back to v5.9.5
 *    single-URL behavior) or the remainder.
 *  - Prefix targets the first ~2 sentences but expands if either is short
 *    (to clear MIN_PREFIX_CHARS) and contracts if a single sentence exceeds
 *    MAX_PREFIX_CHARS (cut at the last word boundary inside the cap).
 *  - Caller is responsible for trimToCap'ping the input first. */
export function splitForFastPrefix(text: string): { prefix: string; tail: string } {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { prefix: '', tail: '' }
  // Short enough to play as a single chunk — no benefit from splitting.
  if (trimmed.length <= MIN_PREFIX_CHARS) return { prefix: trimmed, tail: '' }

  // Walk sentence terminators forward, accumulating sentences until we cover
  // at least MIN_PREFIX_CHARS. Up to 2 sentences if both are reasonably sized,
  // more if the first ones are tiny. Indices point to the boundary AFTER the
  // terminator + whitespace (the start of the next sentence).
  const sentenceBoundaries: number[] = []
  const re = /[.!?]\s+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(trimmed)) !== null) {
    sentenceBoundaries.push(m.index + m[0].length)
  }

  if (sentenceBoundaries.length === 0) {
    // No sentence terminators (one giant run-on). Fall back to a word-boundary
    // cut at MAX_PREFIX_CHARS. If the whole thing fits in MAX, it's a single chunk.
    if (trimmed.length <= MAX_PREFIX_CHARS) return { prefix: trimmed, tail: '' }
    const slice = trimmed.slice(0, MAX_PREFIX_CHARS)
    const lastSpace = slice.lastIndexOf(' ')
    const cut = lastSpace > MIN_PREFIX_CHARS ? lastSpace : MAX_PREFIX_CHARS
    return {
      prefix: trimmed.slice(0, cut).trim(),
      tail: trimmed.slice(cut).trim(),
    }
  }

  // Pick the smallest cut that satisfies (length >= MIN_PREFIX_CHARS) AND
  // covers >= 2 sentences when possible. Stop early once a candidate also
  // exceeds MAX_PREFIX_CHARS — the previous candidate is the best fit.
  let chosenCut = sentenceBoundaries[sentenceBoundaries.length - 1]
  for (let i = 0; i < sentenceBoundaries.length; i++) {
    const cut = sentenceBoundaries[i]
    const sentencesCovered = i + 1
    const longEnough = cut >= MIN_PREFIX_CHARS
    const tooLong = cut > MAX_PREFIX_CHARS
    const hasTwo = sentencesCovered >= 2
    if (tooLong) {
      // Previous boundary (if any) was the best fit; if this is the first
      // boundary AND it already overshoots MAX, fall back to a word-boundary
      // cut inside the first sentence so the prefix doesn't blow past the cap.
      if (i === 0) {
        const slice = trimmed.slice(0, MAX_PREFIX_CHARS)
        const lastSpace = slice.lastIndexOf(' ')
        const cutAt = lastSpace > MIN_PREFIX_CHARS ? lastSpace : MAX_PREFIX_CHARS
        chosenCut = cutAt
      } else {
        chosenCut = sentenceBoundaries[i - 1]
      }
      break
    }
    if (longEnough && hasTwo) {
      chosenCut = cut
      break
    }
    chosenCut = cut
  }

  const prefix = trimmed.slice(0, chosenCut).trim()
  const tail = trimmed.slice(chosenCut).trim()
  if (tail.length === 0) return { prefix: trimmed, tail: '' }
  return { prefix, tail }
}

/** Drain an OpenAI TTS response into the in-memory + disk cache for the given
 *  hash. Used by both the play-route cache-miss path and the prepare-route
 *  pre-warm path. Returns true on success, false if anything aborted/failed —
 *  the cache entry is rolled back via abortEntry on failure so the next request
 *  for the same hash can try again from a clean slate.
 *
 *  Does NOT write to any HTTP response; callers serve out of the cache after
 *  this resolves. Budget billing fires on first byte (same rule as today). */
async function generateIntoCache(
  hash: string,
  text: string,
  voice: string,
  format: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  // Cheap pre-check — if it's already cached, skip everything.
  if (getCached(hash)) return { ok: true }

  let key: string
  try {
    key = getOpenAIKey()
  } catch (err) {
    return { ok: false, status: 503, message: errMsg(err) }
  }

  // Try to reserve the slot. Null means another writer beat us to it; wait
  // for them rather than racing OpenAI. This is the dedup mechanism that
  // makes parallel /prepare pre-warm + concurrent /play GETs safe.
  const slot = startEntry(hash, voice, format)
  if (!slot) {
    const served = await waitForInFlight(hash, 30_000)
    if (served) return { ok: true }
    return { ok: false, status: 502, message: 'in-flight peer failed or timed out' }
  }
  let succeeded = false

  let openaiRes: Response
  try {
    openaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice,
        input: text,
        response_format: format,
        ...(DEFAULT_INSTRUCTIONS ? { instructions: DEFAULT_INSTRUCTIONS } : {}),
      }),
      signal,
    })
  } catch (err) {
    abortEntry(hash)
    return { ok: false, status: 502, message: `OpenAI TTS fetch failed: ${errMsg(err)}` }
  }

  if (!openaiRes.ok || !openaiRes.body) {
    abortEntry(hash)
    const errText = await openaiRes.text().catch(() => '')
    return {
      ok: false,
      status: openaiRes.status || 502,
      message: `OpenAI TTS ${openaiRes.status}: ${errText.slice(0, 300)}`,
    }
  }

  const reader = openaiRes.body.getReader()
  let firstByteSeen = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.length > 0) {
        const buf = Buffer.from(value)
        if (!firstByteSeen) {
          firstByteSeen = true
          recordOpenAITtsUsage(text.length)
        }
        appendBytes(hash, buf)
      }
    }
    completeEntry(hash)
    succeeded = true
    return { ok: true }
  } catch (err) {
    if (!succeeded) abortEntry(hash)
    if ((err as { name?: string })?.name === 'AbortError') {
      return { ok: false, status: 499, message: 'client closed request' }
    }
    return { ok: false, status: 502, message: `OpenAI TTS drain failed: ${errMsg(err)}` }
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

ttsRouter.post('/tts/stream', async (req, res) => {
  try {
    const { text, voice, format, instructions } = req.body ?? {}

    if (typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'text is required (non-empty string)' })
    }

    const requestedVoice = typeof voice === 'string' && SUPPORTED_VOICES.has(voice)
      ? voice : DEFAULT_VOICE
    const requestedFormat = typeof format === 'string' && SUPPORTED_FORMATS.has(format)
      ? format : 'mp3'
    const requestedInstructions = typeof instructions === 'string' && instructions.trim().length > 0
      ? instructions : DEFAULT_INSTRUCTIONS

    // Budget gate — throw before the OpenAI call so we don't bill an aborted request.
    try {
      assertOpenAITtsBudget()
    } catch (err) {
      if (err instanceof OpenAITtsBudgetExhaustedError) {
        return res.status(429).json({
          error: err.message,
          spentTodayUsd: err.spentTodayUsd,
          capUsd: err.capUsd,
        })
      }
      throw err
    }

    // Resolve the OpenAI key — surfaces a clean 503 if no key is reachable.
    let key: string
    try {
      key = getOpenAIKey()
    } catch (err) {
      return res.status(503).json({ error: errMsg(err) })
    }

    const cleaned = stripMarkdownLight(text).trim()
    const capped = trimToCap(cleaned)
    const charCount = capped.length

    // Abort the upstream OpenAI request if the client disconnects mid-stream
    // (e.g. user toggled Voice Mode off, or started a new query).
    const upstreamController = new AbortController()
    res.once('close', () => {
      if (!res.writableEnded) upstreamController.abort()
    })

    const openaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice: requestedVoice,
        input: capped,
        response_format: requestedFormat,
        ...(requestedInstructions ? { instructions: requestedInstructions } : {}),
      }),
      signal: upstreamController.signal,
    })

    if (!openaiRes.ok || !openaiRes.body) {
      const errText = await openaiRes.text().catch(() => '')
      return res.status(openaiRes.status || 502).json({
        error: `OpenAI TTS ${openaiRes.status}: ${errText.slice(0, 300)}`,
      })
    }

    // Set headers for the audio stream — flush immediately so the browser can
    // start consuming bytes as soon as they arrive.
    res.writeHead(200, {
      'Content-Type': FORMAT_MIME[requestedFormat] ?? 'audio/mpeg',
      'Cache-Control': 'no-cache',
      'Transfer-Encoding': 'chunked',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    })
    res.flushHeaders()

    // Pipe the upstream Web ReadableStream to the Express response. We track
    // first-byte success so the budget ledger only ticks on a real (billable)
    // response — aborts before any bytes don't count.
    const reader = openaiRes.body.getReader()
    let firstByteSeen = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length > 0) {
          if (!firstByteSeen) {
            firstByteSeen = true
            recordOpenAITtsUsage(charCount)
          }
          if (!res.write(Buffer.from(value))) {
            // Backpressure — wait for drain before pulling more bytes.
            await new Promise<void>((resolve) => res.once('drain', () => resolve()))
          }
        }
      }
      res.end()
    } catch (err) {
      // AbortError = client closed the stream; not an error worth logging loudly.
      if ((err as { name?: string })?.name !== 'AbortError') {
        console.error('[tts] Stream pipe error:', errMsg(err))
      }
      if (!res.writableEnded) res.end()
    } finally {
      try { reader.releaseLock() } catch { /* already released */ }
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: errMsg(err) })
    } else if (!res.writableEnded) {
      res.end()
    }
  }
})

// POST /api/tts/prepare — v5.9.2 progressive-playback path.
//
// Why this exists alongside /tts/stream: iOS WKWebView cannot progressively
// decode an audio/mpeg stream that we feed via MediaSource Extensions, AND it
// won't play() a Blob until the entire blob is built. The only path that gets
// fast first-audio on iOS is setting audio.src to a URL the browser can GET
// directly, so iOS does its own native progressive MP3 decode.
//
// Flow:
//   1. Client POSTs {text, voice, format} here. We strip+trim+budget-check,
//      hash the (text, voice, format) tuple, and return a session URL.
//   2. Client sets audio.src = `${apiBase}${sessionUrl}` and calls .play().
//   3. The browser GETs /api/tts/play/:session, which consumes the session
//      and either serves cached bytes (instant) or kicks off OpenAI fresh.
//
// The two-step pattern is required because authentication on the play route
// would force XHR (no Range support, no progressive decoding). The session
// UUID IS the auth — short-lived (60s) and one-shot.
ttsRouter.post('/tts/prepare', async (req, res) => {
  try {
    const { text, voice, format, instructions, fast } = req.body ?? {}

    if (typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'text is required (non-empty string)' })
    }

    const requestedVoice = typeof voice === 'string' && SUPPORTED_VOICES.has(voice)
      ? voice : DEFAULT_VOICE
    const requestedFormat = typeof format === 'string' && SUPPORTED_FORMATS.has(format)
      ? format : 'mp3'
    const requestedInstructions = typeof instructions === 'string' && instructions.trim().length > 0
      ? instructions : DEFAULT_INSTRUCTIONS
    const fastMode = fast === true

    // Budget gate — fail fast on prepare so we don't even hand out a session
    // that would 429 on play. Cache hits intentionally still go through the
    // full /play path (which short-circuits before billing), so we don't
    // double-check budget here for hits — prepare is cheap regardless.
    try {
      assertOpenAITtsBudget()
    } catch (err) {
      if (err instanceof OpenAITtsBudgetExhaustedError) {
        return res.status(429).json({
          error: err.message,
          spentTodayUsd: err.spentTodayUsd,
          capUsd: err.capUsd,
        })
      }
      throw err
    }

    // requestedInstructions is intentionally NOT part of the session entry or
    // the cache key today — no client surface passes it, and the server-side
    // DEFAULT_INSTRUCTIONS is read at OpenAI-call time. If we ever surface
    // per-message instructions, both must change in lockstep.
    void requestedInstructions

    const cleaned = stripMarkdownLight(text).trim()
    const capped = trimToCap(cleaned)

    // v5.9.5 path (or fast=true with a short message that doesn't split):
    // single session, behavior unchanged from v5.9.5. The play route will
    // either hit the cache or call OpenAI on demand.
    if (!fastMode) {
      const hash = hashKey(capped, requestedVoice, requestedFormat)
      const uuid = createSession({ hash, text: capped, voice: requestedVoice, format: requestedFormat })
      return res.json({ url: `/api/tts/play/${uuid}` })
    }

    // v5.9.6 fast path: split into prefix + tail, mint 1-2 sessions, and
    // pre-warm OpenAI for both in parallel. The very next GET on either
    // session piggybacks on the in-flight pre-warm via waitForInFlight
    // (no double-bill), so first-audio drops from ~10s to ~1.5s on long
    // replies. Falls back to single-URL behavior automatically when the
    // splitter decides the message is too short to benefit from chunking.
    const { prefix, tail } = splitForFastPrefix(capped)

    const prefixHash = hashKey(prefix, requestedVoice, requestedFormat)
    const prefixUuid = createSession({
      hash: prefixHash,
      text: prefix,
      voice: requestedVoice,
      format: requestedFormat,
    })

    // Pre-warm OpenAI for the prefix. fire-and-forget; generateIntoCache
    // dedups internally if another caller (parallel /prepare or a racing
    // /play GET) is already on this hash, so we can call it unconditionally.
    void generateIntoCache(prefixHash, prefix, requestedVoice, requestedFormat)
      .then((r) => {
        if (!r.ok && r.status !== 499) {
          console.warn('[tts/prepare] prefix pre-warm failed:', r.status, r.message)
        }
      })

    if (tail.length === 0) {
      // Short message — single chunk, no tailUrl. Client falls back to the
      // v5.9.5 single-URL playback path automatically.
      return res.json({ url: `/api/tts/play/${prefixUuid}` })
    }

    const tailHash = hashKey(tail, requestedVoice, requestedFormat)
    const tailUuid = createSession({
      hash: tailHash,
      text: tail,
      voice: requestedVoice,
      format: requestedFormat,
    })

    void generateIntoCache(tailHash, tail, requestedVoice, requestedFormat)
      .then((r) => {
        if (!r.ok && r.status !== 499) {
          console.warn('[tts/prepare] tail pre-warm failed:', r.status, r.message)
        }
      })

    res.json({
      url: `/api/tts/play/${prefixUuid}`,
      tailUrl: `/api/tts/play/${tailUuid}`,
    })
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

/** Serve a fully-buffered audio body, honoring HTTP Range if the client asked
 *  for one. Used by both the cache-hit fast path and the cache-miss path
 *  (after we've drained OpenAI fully into memory).
 *
 *  Why this matters (v5.9.4): iOS WKWebView's HTML5 audio element issues
 *  Range requests (Range: bytes=N-) every few seconds during playback to
 *  refill its decoder buffer. Without 206/Content-Range support, iOS returns
 *  to the same audio.src URL, gets a 200 with the full body again (or worse,
 *  a 404 if the session was one-shot), and stalls. The result on the user
 *  side was "first ~10s plays, then silence" — exactly one decoder-buffer's
 *  worth of audio. We always advertise Accept-Ranges so iOS knows it's safe
 *  to issue Range requests, and we slice the cached buffer to satisfy them. */
function serveCachedBody(
  req: import('express').Request,
  res: import('express').Response,
  bytes: Buffer,
  totalSize: number,
  mime: string,
): void {
  if (!Buffer.isBuffer(bytes)) {
    res.status(502).json({ error: 'TTS cache body unavailable' })
    return
  }
  const rangeHeader = req.headers.range
  if (typeof rangeHeader === 'string' && rangeHeader.startsWith('bytes=')) {
    const m = rangeHeader.match(/^bytes=(\d+)-(\d*)$/)
    if (!m) {
      res.writeHead(416, {
        'Content-Range': `bytes */${totalSize}`,
        'Access-Control-Allow-Origin': '*',
      })
      res.end()
      return
    }
    const start = Number(m[1])
    const end = m[2] ? Math.min(Number(m[2]), totalSize - 1) : totalSize - 1
    if (start >= totalSize || start > end) {
      res.writeHead(416, {
        'Content-Range': `bytes */${totalSize}`,
        'Access-Control-Allow-Origin': '*',
      })
      res.end()
      return
    }
    const slice = bytes.subarray(start, end + 1)
    res.writeHead(206, {
      'Content-Type': mime,
      'Content-Length': String(slice.length),
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(slice)
    return
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': String(totalSize),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(bytes)
}

// GET /api/tts/play/:session — unauthenticated, set as audio.src by the client.
//
// Cache hit: serves the cached body with Content-Length + Accept-Ranges so
// iOS's audio engine can range-fetch its play buffer (the ~10s truncation in
// v5.9.3 was caused by the absence of these headers + a one-shot session).
//
// Cache miss (still v5.9.3 buffered behavior): we fully drain OpenAI's audio
// body into memory, populate the cache, THEN respond with Content-Length set.
// Why not stream straight through? iOS WKWebView's audio engine refuses to
// start playback when neither Content-Length nor Range is available, so the
// v5.9.2 chunked-transfer-encoding path went silent on iOS. Buffering trades
// back the progressive-download latency, but it actually plays — and the
// dual-purpose write into the cache means every subsequent REPLAY of the same
// (text, voice, format) tuple short-circuits to the instant cache-hit path.
// True low-latency progressive playback requires per-sentence chunking; punted
// to a follow-up release.
ttsRouter.get('/tts/play/:session', async (req, res) => {
  // peekSession (v5.9.4) — non-destructive lookup so iOS WKWebView can issue
  // its routine HTTP Range requests for audio buffer refill without 404ing
  // halfway through a long playback. Sessions still TTL out at 60s.
  const session = peekSession(req.params.session)
  if (!session) {
    return res.status(404).json({ error: 'session expired or unknown' })
  }

  const mime = FORMAT_MIME[session.format] ?? 'audio/mpeg'

  // Fast path: cache hit. Content-Length + Accept-Ranges lets iOS compute
  // duration immediately, manage its decode buffer, and seek/refill via
  // Range requests over the same session URL.
  const cachedHit = getCached(session.hash)
  if (cachedHit) {
    return serveCachedBody(req, res, cachedHit.bytes, cachedHit.sizeBytes, mime)
  }

  // Race-protection path (v5.9.6): if /prepare just kicked off a pre-warm
  // for this hash, the entry is in-flight in the cache. Wait for it to
  // complete instead of starting our own OpenAI call (which would double-bill
  // and race the writer). waitForInFlight returns null immediately if no
  // entry exists, so cold misses fall through with no extra latency.
  const inFlight = await waitForInFlight(session.hash, 30_000)
  if (inFlight) {
    if (res.writableEnded) return
    return serveCachedBody(req, res, inFlight.bytes, inFlight.sizeBytes, mime)
  }

  // True cold miss: no cache entry, no pre-warm. Drive OpenAI ourselves.
  // generateIntoCache handles abort/budget/upstream errors and writes into
  // the cache; we serve out of the cache after it completes. Identical
  // behavior to v5.9.5, just refactored through the shared helper.
  const upstreamController = new AbortController()
  res.once('close', () => {
    // Client bailed before we wrote a response (e.g. user toggled SPEAK off
    // mid-generation, or REPLAY was cancelled). Tear down the upstream
    // OpenAI request — abortEntry inside generateIntoCache rolls back the
    // cache slot so the next request for this hash regenerates from scratch.
    if (!res.writableEnded) upstreamController.abort()
  })

  const result = await generateIntoCache(
    session.hash,
    session.text,
    session.voice,
    session.format,
    upstreamController.signal,
  )

  if (!result.ok) {
    if (result.status !== 499 && result.status !== 502) {
      // 499 = client hung up, already handled. 502 includes drain errors
      // we already log inside generateIntoCache for non-aborts.
      console.error('[tts/play] generateIntoCache failed:', result.status, result.message)
    }
    if (!res.headersSent) {
      return res.status(result.status === 499 ? 499 : (result.status || 502))
        .json({ error: result.message })
    } else if (!res.writableEnded) {
      return res.end()
    }
    return
  }

  if (res.writableEnded) return

  const served = getCached(session.hash)
  if (!served) {
    // Vanishingly unlikely — generateIntoCache reported ok but the entry was
    // evicted between completeEntry and our read. Fall through with a 502
    // so the client can REPLAY (which will regenerate cleanly).
    return res.status(502).json({ error: 'cache entry vanished post-write' })
  }
  serveCachedBody(req, res, served.bytes, served.sizeBytes, mime)
})

// GET /api/tts/budget — diagnostics for the daily TTS spend + cache stats.
ttsRouter.get('/tts/budget', async (_req, res) => {
  try {
    const { getOpenAITtsBudgetState } = await import('../lib/openai-tts-budget.js')
    res.json({
      ...getOpenAITtsBudgetState(),
      cache: getCacheStats(),
    })
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})
