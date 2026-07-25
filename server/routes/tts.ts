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
import { getOpenAIKey, tryGetOpenAIKey } from '../lib/openai-key.js'
import {
  assertOpenAITtsBudget,
  recordOpenAITtsUsage,
  OpenAITtsBudgetExhaustedError,
  getOpenAITtsBudgetState,
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
  rebindSessionHash,
  reapExpiredSessions,
  waitForInFlight,
  getCacheStats,
} from '../lib/tts-cache.js'
import {
  canFallbackToLocal,
  canFallbackToOpenAI,
  decideInitialBackend,
  getTtsEngineMode,
  isKokoroVoiceId,
  isOpenAIVoiceId,
  KOKORO_VOICE_OPTIONS,
  mapOpenAIVoiceToLocal,
  OPENAI_VOICE_OPTIONS,
  type TtsEnginePreference,
  type TtsRouteDecision,
} from '../lib/tts-engine.js'
import {
  isLocalTtsReady,
  synthesizeLocalTts,
  recordLocalTtsFallbackToOpenAI,
} from '../lib/tts-local.js'
import { applyLocalPronunciation, applyOpenAIPronunciation } from '../lib/tts-pronounce.js'
import { emitDisplay } from '../lib/display-bus.js'
import { spawn } from 'node:child_process'

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

function openaiBudgetOk(): boolean {
  try {
    assertOpenAITtsBudget()
    return true
  } catch (err) {
    if (err instanceof OpenAITtsBudgetExhaustedError) return false
    throw err
  }
}

function resolveDecision(
  requestedVoice: string,
  enginePreference: TtsEnginePreference | null = null,
): TtsRouteDecision {
  const localReady = isLocalTtsReady()
  const preferOpenAI = enginePreference === 'openai'
  return decideInitialBackend({
    openaiVoice: requestedVoice,
    openaiKeyPresent: !!tryGetOpenAIKey(),
    openaiBudgetOk: openaiBudgetOk(),
    localReady,
    preferOpenAI,
    enginePreference,
  })
}

/** Settings / API: engine local|kokoro|openai|cloud. Null = daemon default. */
function parseEnginePreference(body: unknown): TtsEnginePreference | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b.engine === 'string') {
    const eng = b.engine.trim().toLowerCase()
    if (eng === 'local' || eng === 'kokoro') return 'local'
    if (eng === 'openai' || eng === 'cloud') return 'openai'
  }
  if (b.preferOpenAI === true || b.prefer_openai === true) return 'openai'
  if (b.forceLocal === true || b.force_local === true) return 'local'
  return null
}

function normalizeRequestedVoice(
  voice: unknown,
  enginePreference: TtsEnginePreference | null,
): string {
  const raw = typeof voice === 'string' ? voice.trim() : ''
  if (enginePreference === 'local') {
    if (raw && (isKokoroVoiceId(raw) || isOpenAIVoiceId(raw))) return raw
    return 'am_echo'
  }
  if (enginePreference === 'openai') {
    if (raw && isOpenAIVoiceId(raw)) return raw
    return DEFAULT_VOICE
  }
  // Daemon default / legacy clients: accept either catalog.
  if (raw && (isOpenAIVoiceId(raw) || isKokoroVoiceId(raw))) return raw
  return DEFAULT_VOICE
}

function hashForDecision(
  decision: TtsRouteDecision,
  format: string,
  text: string,
  instructions: string,
): string {
  const instr = decision.backend === 'openai' ? instructions : undefined
  // Hash the spoken form so operator lexicon updates invalidate stale cache.
  const spoken =
    decision.backend === 'local'
      ? applyLocalPronunciation(text)
      : applyOpenAIPronunciation(text)
  return hashKey(decision.engineTag, decision.backendVoice, format, spoken, instr)
}

/** Incident dedupe — /prepare can resolve the same outage 2–3× (prefix/tail). */
let lastFallbackNotifyAt = 0
const FALLBACK_NOTIFY_DEDUPE_MS = 30_000

/** Log an attempted escape without mutating the successful-fallback health field. */
function noteKokoroFallbackPending(reason: string): void {
  console.warn('[tts] Kokoro unavailable; attempting OpenAI fallback:', reason.slice(0, 160))
}

/** User-visible alert after OpenAI fallback audio actually succeeds. */
function announceKokoroFallbackToOpenAI(reason: string): void {
  recordLocalTtsFallbackToOpenAI(reason)
  const now = Date.now()
  if (now - lastFallbackNotifyAt < FALLBACK_NOTIFY_DEDUPE_MS) {
    console.warn('[tts] fallback notify deduped:', reason.slice(0, 120))
    return
  }
  lastFallbackNotifyAt = now

  try {
    emitDisplay({
      type: 'tool_status',
      data: { message: 'TTS: Kokoro failed -> OpenAI' },
    })
  } catch { /* display bus optional */ }
  try {
    spawn(
      'osascript',
      [
        '-e',
        'display notification "Kokoro TTS failed — using OpenAI" with title "COS Glasses" sound name "Basso"',
      ],
      { stdio: 'ignore', detached: true },
    ).unref()
  } catch { /* notification optional */ }
}

async function generateOpenAIIntoCache(
  hash: string,
  text: string,
  voice: string,
  format: string,
  instructions: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  let key: string
  try {
    key = getOpenAIKey()
  } catch (err) {
    return { ok: false, status: 503, message: errMsg(err) }
  }

  try {
    assertOpenAITtsBudget()
  } catch (err) {
    if (err instanceof OpenAITtsBudgetExhaustedError) {
      return { ok: false, status: 429, message: err.message }
    }
    throw err
  }

  const spoken = applyOpenAIPronunciation(text)
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
        input: spoken,
        response_format: format,
        ...(instructions ? { instructions } : {}),
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
          recordOpenAITtsUsage(spoken.length)
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

async function generateLocalIntoCache(
  hash: string,
  text: string,
  voice: string,
  format: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (!isLocalTtsReady()) {
    return { ok: false, status: 503, message: 'local TTS sidecar not ready' }
  }
  const spoken = applyLocalPronunciation(text)
  const slot = startEntry(hash, voice, format)
  if (!slot) {
    const served = await waitForInFlight(hash, 30_000)
    if (served) return { ok: true }
    return { ok: false, status: 502, message: 'in-flight peer failed or timed out' }
  }
  try {
    // Local path ignores COS_VOICE_INSTRUCTIONS / per-request instructions.
    const bytes = await synthesizeLocalTts({ text: spoken, voice, format, signal })
    if (!bytes.length) {
      abortEntry(hash)
      return { ok: false, status: 502, message: 'local TTS returned empty body' }
    }
    appendBytes(hash, bytes)
    completeEntry(hash)
    return { ok: true }
  } catch (err) {
    abortEntry(hash)
    if ((err as { name?: string })?.name === 'AbortError') {
      return { ok: false, status: 499, message: 'client closed request' }
    }
    return { ok: false, status: 502, message: `local TTS failed: ${errMsg(err)}` }
  }
}

/** Drain TTS audio into cache for a resolved backend decision. */
async function generateIntoCache(
  hash: string,
  text: string,
  decision: TtsRouteDecision,
  format: string,
  instructions: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (getCached(hash)) return { ok: true }
  if (decision.backend === 'local') {
    return generateLocalIntoCache(hash, text, decision.backendVoice, format, signal)
  }
  return generateOpenAIIntoCache(
    hash,
    text,
    decision.backendVoice,
    format,
    instructions,
    signal,
  )
}

/** Resolve → hash → generate, with local↔OpenAI fallbacks. */
async function generateWithFallback(opts: {
  text: string
  openaiVoice: string
  format: string
  instructions: string
  enginePreference?: TtsEnginePreference | null
  signal?: AbortSignal
  sessionId?: string
}): Promise<{ ok: true; hash: string } | { ok: false; status: number; message: string }> {
  const enginePreference = opts.enginePreference ?? null
  const preferOpenAI = enginePreference === 'openai'
  const forceLocal = enginePreference === 'local'
  let decision: TtsRouteDecision
  try {
    decision = resolveDecision(opts.openaiVoice, enginePreference)
  } catch (err) {
    return { ok: false, status: 503, message: errMsg(err) }
  }

  // Soft-escape: wanted Kokoro (daemon local_first or forced local) but got OpenAI.
  const softEscapedToOpenAI =
    decision.backend === 'openai' &&
    !preferOpenAI &&
    (forceLocal || getTtsEngineMode() === 'local_first') &&
    !isLocalTtsReady()
  if (softEscapedToOpenAI) {
    noteKokoroFallbackPending(
      forceLocal
        ? 'Local selected but sidecar not ready'
        : 'sidecar not ready at request time',
    )
  }

  const hash = hashForDecision(decision, opts.format, opts.text, opts.instructions)
  const primary = await generateIntoCache(
    hash,
    opts.text,
    decision,
    opts.format,
    opts.instructions,
    opts.signal,
  )
  if (primary.ok) {
    if (softEscapedToOpenAI) {
      announceKokoroFallbackToOpenAI(
        forceLocal
          ? 'Local selected but sidecar not ready'
          : 'sidecar not ready at request time',
      )
    }
    return { ok: true, hash }
  }

  const mode = getTtsEngineMode()
  if (
    decision.backend === 'openai' &&
    primary.status !== 499 &&
    canFallbackToLocal(mode, isLocalTtsReady(), preferOpenAI)
  ) {
    console.warn('[tts] OpenAI failed; falling back to local Kokoro:', primary.status, primary.message)
    const localDecision: TtsRouteDecision = {
      backend: 'local',
      engineTag: 'kokoro',
      backendVoice: mapOpenAIVoiceToLocal(opts.openaiVoice),
      openaiVoice: opts.openaiVoice,
    }
    const localHash = hashForDecision(localDecision, opts.format, opts.text, opts.instructions)
    const localResult = await generateIntoCache(
      localHash,
      opts.text,
      localDecision,
      opts.format,
      opts.instructions,
      opts.signal,
    )
    if (localResult.ok) {
      if (opts.sessionId) rebindSessionHash(opts.sessionId, localHash)
      return { ok: true, hash: localHash }
    }
    return localResult
  }

  if (
    decision.backend === 'local' &&
    primary.status !== 499 &&
    canFallbackToOpenAI(mode, !!tryGetOpenAIKey(), openaiBudgetOk(), forceLocal)
  ) {
    const failReason = `${primary.status}: ${primary.message}`
    noteKokoroFallbackPending(failReason)
    const openaiVoice = isOpenAIVoiceId(opts.openaiVoice) ? opts.openaiVoice : DEFAULT_VOICE
    const openaiDecision: TtsRouteDecision = {
      backend: 'openai',
      engineTag: 'openai',
      backendVoice: openaiVoice,
      openaiVoice: opts.openaiVoice,
    }
    const openaiHash = hashForDecision(openaiDecision, opts.format, opts.text, opts.instructions)
    const openaiResult = await generateIntoCache(
      openaiHash,
      opts.text,
      openaiDecision,
      opts.format,
      opts.instructions,
      opts.signal,
    )
    if (openaiResult.ok) {
      announceKokoroFallbackToOpenAI(failReason)
      if (opts.sessionId) rebindSessionHash(opts.sessionId, openaiHash)
      return { ok: true, hash: openaiHash }
    }
    return openaiResult
  }

  return primary
}

ttsRouter.get('/tts/voices', (_req, res) => {
  res.json({
    defaultEngine: getTtsEngineMode() === 'openai' || getTtsEngineMode() === 'openai_primary'
      ? 'openai'
      : 'local',
    localReady: isLocalTtsReady(),
    openai: OPENAI_VOICE_OPTIONS,
    local: KOKORO_VOICE_OPTIONS,
  })
})

/** Preserve the legacy /tts/stream first-byte contract for OpenAI-backed
 * playback. Fallback alerts fire only after a real audio byte succeeds. */
async function streamOpenAIToResponse(
  res: import('express').Response,
  opts: {
    text: string
    voice: string
    format: string
    instructions: string
    signal: AbortSignal
    onFirstByte?: () => void
  },
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  let key: string
  try {
    key = getOpenAIKey()
    assertOpenAITtsBudget()
  } catch (err) {
    if (err instanceof OpenAITtsBudgetExhaustedError) {
      return { ok: false, status: 429, message: err.message }
    }
    return { ok: false, status: 503, message: errMsg(err) }
  }

  const spoken = applyOpenAIPronunciation(opts.text)
  let upstream: Response
  try {
    upstream = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice: opts.voice,
        input: spoken,
        response_format: opts.format,
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
      }),
      signal: opts.signal,
    })
  } catch (err) {
    if (opts.signal.aborted || (err as { name?: string })?.name === 'AbortError') {
      return { ok: false, status: 499, message: 'client closed request' }
    }
    return { ok: false, status: 502, message: `OpenAI TTS fetch failed: ${errMsg(err)}` }
  }
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => '')
    return {
      ok: false,
      status: upstream.status || 502,
      message: `OpenAI TTS ${upstream.status}: ${body.slice(0, 300)}`,
    }
  }

  res.writeHead(200, {
    'Content-Type': FORMAT_MIME[opts.format] ?? 'audio/mpeg',
    'Cache-Control': 'no-cache',
    'Transfer-Encoding': 'chunked',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  })
  res.flushHeaders()
  const reader = upstream.body.getReader()
  let firstByte = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.length) continue
      if (!firstByte) {
        firstByte = true
        recordOpenAITtsUsage(spoken.length)
        opts.onFirstByte?.()
      }
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => res.once('drain', resolve))
      }
    }
    res.end()
    return { ok: true }
  } catch (err) {
    if (!res.writableEnded) res.end()
    if (opts.signal.aborted || (err as { name?: string })?.name === 'AbortError') {
      return { ok: false, status: 499, message: 'client closed request' }
    }
    return { ok: false, status: 502, message: `OpenAI TTS stream failed: ${errMsg(err)}` }
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

ttsRouter.post('/tts/stream', async (req, res) => {
  try {
    const { text, format, instructions } = req.body ?? {}
    const enginePreference = parseEnginePreference(req.body)

    if (typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'text is required (non-empty string)' })
    }

    const requestedVoice = normalizeRequestedVoice(req.body?.voice, enginePreference)
    const requestedFormat = typeof format === 'string' && SUPPORTED_FORMATS.has(format)
      ? format : 'mp3'
    const requestedInstructions = typeof instructions === 'string' && instructions.trim().length > 0
      ? instructions : DEFAULT_INSTRUCTIONS

    const cleaned = stripMarkdownLight(text).trim()
    const capped = trimToCap(cleaned)

    const upstreamController = new AbortController()
    res.once('close', () => {
      if (!res.writableEnded) upstreamController.abort()
    })

    let decision: TtsRouteDecision
    try {
      decision = resolveDecision(requestedVoice, enginePreference)
    } catch (err) {
      return res.status(503).json({ error: errMsg(err) })
    }

    const streamOpenAI = (fallbackReason?: string) => streamOpenAIToResponse(res, {
      text: capped,
      voice: isOpenAIVoiceId(requestedVoice) ? requestedVoice : DEFAULT_VOICE,
      format: requestedFormat,
      instructions: requestedInstructions,
      signal: upstreamController.signal,
      ...(fallbackReason
        ? { onFirstByte: () => announceKokoroFallbackToOpenAI(fallbackReason) }
        : {}),
    })

    if (decision.backend === 'openai') {
      const escapedLocalFirst = enginePreference !== 'openai' && getTtsEngineMode() === 'local_first'
      if (escapedLocalFirst) noteKokoroFallbackPending('sidecar not ready at request time')
      const streamed = await streamOpenAI(escapedLocalFirst ? 'sidecar not ready at request time' : undefined)
      if (!streamed.ok && !res.headersSent) {
        return res.status(streamed.status).json({ error: streamed.message })
      }
      return
    }

    try {
      const spoken = applyLocalPronunciation(capped)
      const bytes = await synthesizeLocalTts({
        text: spoken,
        voice: decision.backendVoice,
        format: requestedFormat,
        signal: upstreamController.signal,
      })
      if (upstreamController.signal.aborted) return
      res.writeHead(200, {
        'Content-Type': FORMAT_MIME[requestedFormat] ?? 'audio/mpeg',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(bytes)
      return
    } catch (err) {
      if (upstreamController.signal.aborted || (err as { name?: string })?.name === 'AbortError') {
        if (!res.headersSent) res.status(499).json({ error: 'client closed request' })
        return
      }
      const reason = `local TTS failed: ${errMsg(err)}`
      const forceLocal = enginePreference === 'local'
      if (!canFallbackToOpenAI(
        getTtsEngineMode(),
        !!tryGetOpenAIKey(),
        openaiBudgetOk(),
        forceLocal,
      )) {
        return res.status(502).json({ error: reason })
      }
      noteKokoroFallbackPending(reason)
      const streamed = await streamOpenAI(reason)
      if (!streamed.ok && !res.headersSent) {
        return res.status(streamed.status).json({ error: streamed.message })
      }
      return
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
    const { text, format, instructions, fast } = req.body ?? {}
    const enginePreference = parseEnginePreference(req.body)

    if (typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'text is required (non-empty string)' })
    }

    const requestedVoice = normalizeRequestedVoice(req.body?.voice, enginePreference)
    const requestedFormat = typeof format === 'string' && SUPPORTED_FORMATS.has(format)
      ? format : 'mp3'
    const requestedInstructions = typeof instructions === 'string' && instructions.trim().length > 0
      ? instructions : DEFAULT_INSTRUCTIONS
    const fastMode = fast === true

    // Fail closed only when NEITHER OpenAI nor local can serve.
    let decision: TtsRouteDecision
    try {
      decision = resolveDecision(requestedVoice, enginePreference)
    } catch (err) {
      const budget = getOpenAITtsBudgetState()
      if (!tryGetOpenAIKey()) {
        return res.status(503).json({ error: errMsg(err) })
      }
      if (!openaiBudgetOk() && !isLocalTtsReady()) {
        return res.status(429).json({
          error: errMsg(err),
          spentTodayUsd: budget.usdToday,
          capUsd: budget.capUsd,
        })
      }
      return res.status(503).json({ error: errMsg(err) })
    }

    const cleaned = stripMarkdownLight(text).trim()
    const capped = trimToCap(cleaned)
    const preferOpenAI = enginePreference === 'openai'
    const forceLocal = enginePreference === 'local'

    const mintAndWarm = (chunk: string) => {
      const hash = hashForDecision(decision, requestedFormat, chunk, requestedInstructions)
      const uuid = createSession({
        hash,
        text: chunk,
        voice: requestedVoice,
        format: requestedFormat,
        preferOpenAI,
        forceLocal,
      })
      // Detached preparation is deliberately local-only. It must never retain
      // authority to spend cloud budget after the client cancels or closes.
      // OpenAI generation (including Kokoro fallback) begins only from the
      // live /play request, whose AbortSignal follows the connected client.
      if (decision.backend === 'local') {
        void generateIntoCache(
          hash,
          chunk,
          decision,
          requestedFormat,
          requestedInstructions,
        ).then((r) => {
          if (!r.ok && r.status !== 499) {
            console.warn('[tts/prepare] local pre-warm failed:', r.status, r.message)
          }
        })
      }
      return { hash, uuid }
    }

    const engineMeta = {
      engine: decision.engineTag,
      backend: decision.backend,
      voice: decision.backendVoice,
      localReady: isLocalTtsReady(),
    }

    if (!fastMode) {
      const { uuid } = mintAndWarm(capped)
      return res.json({ url: `/api/tts/play/${uuid}`, ...engineMeta })
    }

    const { prefix, tail } = splitForFastPrefix(capped)
    const prefixMint = mintAndWarm(prefix)
    if (tail.length === 0) {
      return res.json({ url: `/api/tts/play/${prefixMint.uuid}`, ...engineMeta })
    }
    const tailMint = mintAndWarm(tail)
    res.json({
      url: `/api/tts/play/${prefixMint.uuid}`,
      tailUrl: `/api/tts/play/${tailMint.uuid}`,
      ...engineMeta,
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

  // True cold miss: no cache entry, no pre-warm. Resolve engine + generate
  // (with openai_primary → local fallback). Session hash may rebind on fallback.
  const upstreamController = new AbortController()
  res.once('close', () => {
    if (!res.writableEnded) upstreamController.abort()
  })

  const enginePreference: TtsEnginePreference | null = session.forceLocal
    ? 'local'
    : session.preferOpenAI
      ? 'openai'
      : null
  const result = await generateWithFallback({
    text: session.text,
    openaiVoice: session.voice,
    format: session.format,
    instructions: DEFAULT_INSTRUCTIONS,
    enginePreference,
    signal: upstreamController.signal,
    sessionId: req.params.session,
  })

  if (!result.ok) {
    if (result.status !== 499 && result.status !== 502) {
      console.error('[tts/play] generateWithFallback failed:', result.status, result.message)
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

  const served = getCached(result.hash)
  if (!served) {
    return res.status(502).json({ error: 'cache entry vanished post-write' })
  }
  serveCachedBody(req, res, served.bytes, served.sizeBytes, mime)
})

// GET /api/tts/budget — diagnostics for the daily TTS spend + cache stats.
ttsRouter.get('/tts/budget', async (_req, res) => {
  try {
    const { getLocalTtsHealth } = await import('../lib/tts-local.js')
    res.json({
      ...getOpenAITtsBudgetState(),
      engineMode: getTtsEngineMode(),
      tts_local: getLocalTtsHealth(),
      cache: getCacheStats(),
    })
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})
