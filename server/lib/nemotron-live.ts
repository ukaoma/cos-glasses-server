// Live, per chunk: Nemotron separates the voices, the voiceprint names them.
//
// THE FALLBACK-EXPERIENCE HARD RULE. A live chunk must never stall or be lost
// because of this file. Every path that is not a clean Nemotron result returns a
// reason, and the caller keeps today's voiceprint label for that chunk:
//   - the model is warmed at server start in the background; until it is warm
//     chunks report `warming` and use the voiceprint;
//   - each run has a hard budget (SIGKILL at the deadline) and at most
//     MAX_CONCURRENT runs exist at once; a chunk that finds the lane full is
//     `busy`, never queued;
//   - a missing CLI, missing models, a crash or unreadable output all fall back.
// Whisper keeps priority: the run starts in parallel with Whisper, on the Neural
// Engine (`--compute-units ane`, so the GPU stays Whisper's) at a lower CPU
// priority, and the chunk waits for it only up to its budget.
//
// No LLM anywhere. Transcription must never call `claude -p`.

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NEMOTRON_VARIANT,
  activeDiarizer,
  nemotronCliPath,
  prepareNemotronModelsDir,
  requestedDiarizer,
} from './diarizer-backend.js'
import {
  NEMOTRON_TMP_PREFIX,
  NemotronRunError,
  runNemotronCli,
  sweepStaleNemotron,
  trackNemotronDir,
  untrackNemotronDir,
  type NemotronRun,
  type RunNemotronOptions,
} from './nemotron-cli.js'
import {
  NAME_TRACK_MIN_SEC,
  absorbFlickers,
  channelForSpan,
  estimateTokenTimes,
  exclusiveTrackWav,
  fillLabels,
  isWordToken,
  pcm16ToWav,
  readPcm16Mono,
  runsOf,
  snapToPunctuation,
  splitTokens,
  tokenTimesFromWords,
  tracksIn,
  type Activity,
  type TokenTime,
} from './nemotron-segments.js'
import type { WhisperWord } from './whisper-local.js'

/** The chunk response contract shared with COS Glasses 6.9.567. Keep this shape. */
export interface ChunkSpeakerSegment {
  speaker: string
  text: string
  startSec?: number
  endSec?: number
  similarity?: number
}

export interface VoiceprintResult {
  speaker: string
  similarity: number
}

export interface LiveNamingInput {
  activity: Activity
  text: string
  words?: WhisperWord[]
  /** The chunk's WAV, the same bytes Nemotron read. */
  audio: Buffer
  /** Today's whole-chunk voiceprint result. */
  chunkVoiceprint: VoiceprintResult
  /** The client's own label (amplitude / Even Hub), e.g. the owner or Ext. */
  clientSpeaker: string
  identify: (wav: Buffer) => VoiceprintResult | null
}

export type LiveNamingResult =
  | {
      ok: true
      speaker: string
      similarity: number
      segments: ChunkSpeakerSegment[]
      tracks: number
      timing: 'words' | 'estimated'
      identified: number
    }
  | { ok: false; reason: 'no_text' | 'no_speech' }

const round = (value: number, places = 2): number => Math.round(value * 10 ** places) / 10 ** places

function isRealLabel(label: string): boolean {
  const value = label.trim()
  return value.length > 0 && value !== 'Unknown' && value !== 'Ext'
}

/**
 * Split one chunk's text into named segments. Pure apart from `identify`.
 *
 * Naming rules (2026-10-02 brief):
 *  - one track: it is the whole chunk, so it takes the chunk's voiceprint result;
 *  - two or more: each track with at least NAME_TRACK_MIN_SEC of its own audio is
 *    named by the voiceprint on that audio;
 *  - a shorter track takes the chunk's voiceprint when it is the dominant track,
 *    otherwise the client's label when that is a real name different from the
 *    dominant one, otherwise Ext. A name is never invented and the voiceprint's
 *    own thresholds decide every name it gives.
 * The segments' texts joined with one space equal `text` exactly.
 */
export function nameChunkSegments(input: LiveNamingInput): LiveNamingResult {
  const { activity, text } = input
  if (!text.trim()) return { ok: false, reason: 'no_text' }
  const tracks = tracksIn(activity, 0, activity.frames)
  if (tracks.length === 0) return { ok: false, reason: 'no_speech' }
  const tokens = splitTokens(text)
  const allowed = new Set(tracks.map(track => track.channel))
  const dominant = tracks[0].channel

  let timing: 'words' | 'estimated' = 'estimated'
  let times: TokenTime[] | null = input.words?.length ? tokenTimesFromWords(tokens, input.words) : null
  if (times) timing = 'words'
  else times = estimateTokenTimes(tokens, activity, 0, activity.frames / 100)
  if (!times) return { ok: false, reason: 'no_speech' }

  const raw = tokens.map((token, i) => isWordToken(token)
    ? channelForSpan(activity, times![i].start, times![i].end, allowed)
    : null)
  let labels = fillLabels(raw, dominant)
  if (timing === 'estimated') labels = snapToPunctuation(tokens, labels)
  labels = absorbFlickers(tokens, labels, times)
  const used = new Set(labels)

  const names = new Map<number, VoiceprintResult>()
  let identified = 0
  const pcm = readPcm16Mono(input.audio)
  const ordered = tracks.filter(track => used.has(track.channel))
  if (!ordered.some(track => track.channel === dominant)) ordered.unshift(tracks[0])
  if (ordered.length === 1) {
    names.set(ordered[0].channel, input.chunkVoiceprint)
  } else {
    for (const track of ordered) {
      if (track.exclusiveSec >= NAME_TRACK_MIN_SEC && pcm) {
        const wav = exclusiveTrackWav(activity, track.channel, pcm)
        const named = wav ? input.identify(wav) : null
        if (named) { names.set(track.channel, named); identified++; continue }
      }
      if (track.channel === dominant) { names.set(track.channel, input.chunkVoiceprint); continue }
      const dominantName = names.get(dominant)?.speaker ?? input.chunkVoiceprint.speaker
      const client = input.clientSpeaker.trim()
      names.set(track.channel, { speaker: isRealLabel(client) && client !== dominantName ? client : 'Ext', similarity: 0 })
    }
  }

  const segments: ChunkSpeakerSegment[] = []
  const nameOf = (channel: number): VoiceprintResult => names.get(channel) ?? input.chunkVoiceprint
  for (const run of runsOf(labels)) {
    const named = nameOf(run.label)
    const piece: ChunkSpeakerSegment = {
      speaker: named.speaker,
      text: tokens.slice(run.from, run.to).join(' '),
      startSec: round(times[run.from].start),
      endSec: round(times[run.to - 1].end),
      similarity: round(named.similarity, 3),
    }
    const last = segments.at(-1)
    // Estimated neighbours can share a 10 ms frame; turns never overlap in time order.
    if (last && (piece.startSec ?? 0) < (last.endSec ?? 0)) piece.startSec = last.endSec
    if ((piece.endSec ?? 0) < (piece.startSec ?? 0)) piece.endSec = piece.startSec
    if (last && last.speaker === piece.speaker) {
      last.text = `${last.text} ${piece.text}`
      last.endSec = Math.max(last.endSec ?? 0, piece.endSec ?? 0)
      last.similarity = Math.max(last.similarity ?? 0, piece.similarity ?? 0)
    } else {
      segments.push(piece)
    }
  }

  // Dominant NAME by voiced time among the tracks that carry the text: two
  // channels can carry one person, and a voice with no words here is not who
  // said this chunk.
  const voiced = new Map<string, number>()
  for (const track of tracks) {
    if (!names.has(track.channel) || !used.has(track.channel)) continue
    const name = names.get(track.channel)!.speaker
    voiced.set(name, (voiced.get(name) ?? 0) + track.activeSec)
  }
  let speaker = nameOf(dominant).speaker
  let best = -1
  for (const [name, sec] of voiced) if (sec > best) { best = sec; speaker = name }
  const similarity = [...names.values()].find(named => named.speaker === speaker)?.similarity ?? 0
  return { ok: true, speaker, similarity: round(similarity, 3), segments, tracks: tracks.length, timing, identified }
}

/**
 * Fit stored turns to a text that lost some words (session recovery strips inline
 * hallucinations from `text` after the fact). Each surviving word keeps the turn
 * it was in; a turn left empty goes; neighbours with one name merge. Returns
 * undefined when the words cannot be matched in order, and the caller then drops
 * the turns: joined turns must always equal the text.
 */
export function resplitSegments(segments: ChunkSpeakerSegment[], text: string): ChunkSpeakerSegment[] | undefined {
  const old: Array<{ token: string; seg: number }> = []
  segments.forEach((segment, seg) => { for (const token of splitTokens(String(segment.text ?? ''))) old.push({ token, seg }) })
  const fresh = splitTokens(text)
  const owner: number[] = []
  let pointer = 0
  for (const token of fresh) {
    let found = -1
    for (let k = pointer; k < Math.min(old.length, pointer + 40); k++) if (old[k].token === token) { found = k; break }
    if (found < 0) return undefined
    owner.push(old[found].seg)
    pointer = found + 1
  }
  const out: ChunkSpeakerSegment[] = []
  fresh.forEach((token, i) => {
    const from = segments[owner[i]]
    const last = out.at(-1)
    if (last && last.speaker === from.speaker) {
      last.text = `${last.text} ${token}`
      if (typeof from.endSec === 'number') last.endSec = Math.max(last.endSec ?? 0, from.endSec)
      if (typeof from.similarity === 'number') last.similarity = Math.max(last.similarity ?? 0, from.similarity)
    } else {
      out.push({ ...from, text: token })
    }
  })
  return out.map(segment => segment.text).join(' ') === text ? out : undefined
}

export interface LiveLabelInput {
  /** The run started before Whisper; awaited here, bounded by its own budget. */
  diarize: Promise<LiveDiarizeOutcome>
  /** performance.now() when the run was started. */
  startedAt: number
  text: string
  words?: WhisperWord[]
  audio: Buffer
  voiceprint: VoiceprintResult
  clientSpeaker: string
  identify: (wav: Buffer) => VoiceprintResult | null
  clock?: () => number
}

export interface LiveLabels {
  speaker: string
  similarity: number
  segments?: ChunkSpeakerSegment[]
  diarizer?: {
    engine: 'nemotron' | 'voiceprint'
    fallback?: string
    voiceprintSpeaker?: string
    voiceprintSimilarity?: number
    tracks?: number
    timing?: 'words' | 'estimated'
    ms?: number
  }
  /** What NemotronLiveRuntime.record should log; absent when the voiceprint was chosen by config. */
  record?:
    | { outcome: 'nemotron'; ms: number; segments: number; tracks: number; timing: string; identified: number }
    | { outcome: 'voiceprint'; reason: string; ms: number | null; detail?: string }
}

/**
 * The chunk's final labels. Never throws: any failure returns today's voiceprint
 * label with the reason, so the chunk is answered and stored exactly as before.
 */
export async function resolveLiveLabels(input: LiveLabelInput): Promise<LiveLabels> {
  const clock = input.clock ?? (() => performance.now())
  const voiceprintOnly = (reason: string, ms: number | null, detail?: string): LiveLabels => ({
    speaker: input.voiceprint.speaker,
    similarity: input.voiceprint.similarity,
    diarizer: { engine: 'voiceprint', fallback: reason },
    record: { outcome: 'voiceprint', reason, ms, ...(detail ? { detail } : {}) },
  })
  let outcome: LiveDiarizeOutcome
  try {
    outcome = await input.diarize
  } catch (error) {
    return voiceprintOnly('error', null, error instanceof Error ? error.message : String(error))
  }
  // Nemotron's own run time, not how long the chunk waited: the run started
  // before Whisper, so most of it is hidden behind Whisper.
  const waited = Math.round(clock() - input.startedAt)
  if (!outcome.ok) {
    // The voiceprint by choice, or an install with no CLI or models: today's label,
    // no per-chunk stamp and no per-chunk log (the warm-up logged it once).
    if (outcome.reason === 'embedding_requested' || STATIC_REASONS.has(outcome.reason)) {
      return { speaker: input.voiceprint.speaker, similarity: input.voiceprint.similarity }
    }
    const ran = outcome.reason === 'timeout' || outcome.reason === 'cli_failed' || outcome.reason === 'bad_output' || outcome.reason === 'spawn_failed' || outcome.reason === 'error'
    return voiceprintOnly(outcome.reason, ran ? (outcome.ms ?? waited) : null, outcome.detail)
  }
  const ms = Math.round(outcome.run.wallMs ?? waited)
  try {
    const named = nameChunkSegments({
      activity: outcome.run,
      text: input.text,
      words: input.words,
      audio: input.audio,
      chunkVoiceprint: input.voiceprint,
      clientSpeaker: input.clientSpeaker,
      identify: input.identify,
    })
    if (!named.ok) return voiceprintOnly(named.reason, ms)
    const changed = named.speaker !== input.voiceprint.speaker
    return {
      speaker: named.speaker,
      similarity: named.similarity,
      segments: named.segments,
      diarizer: {
        engine: 'nemotron',
        tracks: named.tracks,
        timing: named.timing,
        ms,
        ...(changed ? { voiceprintSpeaker: input.voiceprint.speaker, voiceprintSimilarity: input.voiceprint.similarity } : {}),
      },
      record: { outcome: 'nemotron', ms, segments: named.segments.length, tracks: named.tracks, timing: named.timing, identified: named.identified },
    }
  } catch (error) {
    return voiceprintOnly('error', ms, error instanceof Error ? error.message : String(error))
  }
}

// ── Runtime: warm-up, lane, budget, honest counts ─────────────────────────────

export type LiveFallbackReason =
  | 'cli_missing'
  | 'models_missing'
  | 'warming'
  | 'warmup_failed'
  | 'cooling'
  | 'busy'
  | 'timeout'
  | 'cli_failed'
  | 'bad_output'
  | 'spawn_failed'
  | 'no_speech'
  | 'error'

export type LiveDiarizeOutcome =
  | { ok: true; run: NemotronRun }
  | { ok: false; reason: LiveFallbackReason | 'embedding_requested'; detail?: string; ms?: number }

/** A run was attempted and failed. Consecutive ones open the breaker. */
const RUN_FAILURES: ReadonlySet<string> = new Set(['timeout', 'cli_failed', 'bad_output', 'spawn_failed', 'error'])
/** Install-level reasons: logged once by the warm-up, never stamped on a chunk. */
export const STATIC_REASONS: ReadonlySet<string> = new Set(['cli_missing', 'models_missing'])
/** State-level reasons: counted per chunk, logged once per change of state. */
const STATE_REASONS: ReadonlySet<string> = new Set(['warming', 'warmup_failed', 'cooling', 'cli_missing', 'models_missing'])

export type LiveState = 'off' | 'idle' | 'warming' | 'ready' | 'cooling' | 'failed'

export interface NemotronLiveDeps {
  env?: () => NodeJS.ProcessEnv
  home?: () => string
  run?: (options: RunNemotronOptions) => Promise<NemotronRun>
  log?: (line: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  tmpRoot?: () => string
  maxConcurrent?: number
  budgetMs?: number
  warmTimeoutMs?: number
  warmRetryDelaysMs?: number[]
  /** Hash of the CLI binary, for the startup identity line. */
  cliIdentity?: (path: string) => { sha256: string; known: boolean } | null
}

export const LIVE_BUDGET_MS = 1500
export const LIVE_MAX_CONCURRENT = 2
export const WARM_TIMEOUT_MS = 180_000
export const WARM_RETRY_DELAYS_MS = [5_000, 30_000]
/** Consecutive failed runs (a budget kill, a crash) that open the breaker. */
export const BREAKER_FAILURES = 3
/**
 * How long Nemotron rests after the breaker opens or a warm-up gives up, by
 * consecutive trip: 2, 4, 8, 16, 32 minutes, then 60 at most. While it rests no
 * CLI is spawned and every chunk takes the voiceprint at once (no 1.5 s wait);
 * then one fresh warm-up decides. A clean chunk resets the trips.
 */
export const BREAKER_BACKOFF_MS = [120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000]
/** Install-level checks (a CLI or models that appear later) are retried on this interval, without spawning. */
export const STATIC_RECHECK_MS = 120_000
/** The recent chunk outcomes `active` is read from. */
export const RECENT_WINDOW = 5
/** fluidaudiocli built from FluidAudio v0.17.4 (the 2026-10-01 canary's build). */
export const KNOWN_CLI_SHA256 = '4714154623b59c40404563828cb0fbeb4da6878e90f582ad776c1c2cd061d35a'

export interface LiveSnapshot {
  requested: 'nemotron' | 'embedding'
  /**
   * What is labelling chunks right now. `nemotron` only while the model is warm,
   * the breaker is closed and at least half the recent chunks really were
   * labelled by Nemotron; otherwise `warming` or `embedding` with the reason.
   */
  active: 'nemotron' | 'warming' | 'embedding'
  fallback: string | null
  /** The last RECENT_WINDOW chunk outcomes: who actually labelled them. */
  recent: { window: number; nemotron: number; voiceprint: number }
  breaker: { open: boolean; trips: number; consecutiveFailures: number; retryAt: string | null }
  variant: string
  computeUnits: 'ane'
  budgetMs: number
  maxConcurrent: number
  inFlight: number
  warm: { state: LiveState; ms: number | null; loadSec: number | null; error: string | null }
  /** Whether the CLI binary is the v0.17.4 build the offline guarantee was verified on. */
  cliKnown: boolean | null
  chunks: { nemotron: number; voiceprint: number; reasons: Record<string, number> }
  last: { at: string; outcome: 'nemotron' | 'voiceprint'; reason: string | null; ms: number | null } | null
}

export function cliIdentity(path: string): { sha256: string; known: boolean } | null {
  try {
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
    return { sha256, known: sha256 === KNOWN_CLI_SHA256 }
  } catch {
    return null
  }
}

export class NemotronLiveRuntime {
  private state: LiveState = 'idle'
  private inFlight = 0
  private consecutiveFailures = 0
  private trips = 0
  private retryAt = 0
  private warming: Promise<void> | null = null
  private warmMs: number | null = null
  private warmLoadSec: number | null = null
  private warmError: string | null = null
  private cli: string | null = null
  private modelsDir: string | null = null
  private identity: { path: string; sha256: string; known: boolean } | null = null
  private counts = { nemotron: 0, voiceprint: 0, reasons: {} as Record<string, number> }
  private recent: Array<{ outcome: 'nemotron' | 'voiceprint'; reason: string | null }> = []
  private last: LiveSnapshot['last'] = null
  private lastStateLog: string | null = null

  constructor(private readonly deps: NemotronLiveDeps = {}) {}

  private env(): NodeJS.ProcessEnv { return this.deps.env?.() ?? process.env }
  private home(): string { return this.deps.home?.() ?? homedir() }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private log(line: string): void { (this.deps.log ?? console.log)(line) }
  private budget(): number { return this.deps.budgetMs ?? LIVE_BUDGET_MS }
  private maxConcurrent(): number { return this.deps.maxConcurrent ?? LIVE_MAX_CONCURRENT }
  private backoff(): number { return BREAKER_BACKOFF_MS[Math.min(this.trips, BREAKER_BACKOFF_MS.length - 1)] }

  /** Start (or restart) the background warm-up. Never throws, never rejects, never blocks a chunk. */
  startWarmup(): Promise<void> {
    if (requestedDiarizer(this.env()) === 'embedding') {
      if (this.state !== 'off') this.log('[diarizer] tracks=voiceprint names=voiceprint (COS_DIARIZER selects the voiceprint)')
      this.state = 'off'
      return Promise.resolve()
    }
    if (this.warming) return this.warming
    this.state = 'warming'
    this.warming = this.warm()
      .catch(error => {
        // Unreachable by design (warm catches per attempt); a warm-up must still never be left `warming`.
        this.state = 'failed'
        this.warmError = 'error'
        this.retryAt = this.now() + this.backoff()
        this.log(`[diarizer] Nemotron warm-up error: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => { this.warming = null })
    return this.warming
  }

  private async warm(): Promise<void> {
    const delays = this.deps.warmRetryDelaysMs ?? WARM_RETRY_DELAYS_MS
    const attempts = delays.length + 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const choice = activeDiarizer(this.env(), this.home())
      this.cli = nemotronCliPath(this.env(), this.home())
      this.modelsDir = choice.fallback ? null : prepareNemotronModelsDir(this.env(), this.home())
      if (!this.cli || !this.modelsDir) {
        // Static: retrying cannot install a binary or download a model. Checked
        // again every STATIC_RECHECK_MS without spawning; logged once.
        const reason = choice.fallback ?? 'models_missing'
        this.state = 'failed'
        if (this.warmError !== reason) this.log(`[diarizer] tracks=voiceprint names=voiceprint fallback=${reason} (Nemotron requested)`)
        this.warmError = reason
        this.retryAt = this.now() + STATIC_RECHECK_MS
        return
      }
      if (!this.identity || this.identity.path !== this.cli) {
        const id = (this.deps.cliIdentity ?? cliIdentity)(this.cli)
        if (id) {
          this.identity = { path: this.cli, ...id }
          this.log(`[diarizer] fluidaudiocli sha256 ${id.sha256} ${id.known ? '(FluidAudio v0.17.4, the verified build)' : '(an unverified build: offline use rests on --models; check its download behaviour)'}`)
        }
      }
      const started = this.now()
      let work: string | null = null
      try {
        // Inside the try (QA 6.61.0): a temp dir that cannot be made is a failed
        // attempt with a reason, never a warm-up stuck on `warming`.
        work = mkdtempSync(join(this.deps.tmpRoot?.() ?? tmpdir(), `${NEMOTRON_TMP_PREFIX}warm-`))
        trackNemotronDir(work)
        const wav = join(work, 'warm.wav')
        // One second of silence: enough to load and compile, nothing to diarize.
        writeFileSync(wav, pcm16ToWav(Buffer.alloc(32_000)), { mode: 0o600 })
        const run = await (this.deps.run ?? runNemotronCli)({
          cli: this.cli,
          modelsDir: this.modelsDir,
          wavPath: wav,
          timeoutMs: this.deps.warmTimeoutMs ?? WARM_TIMEOUT_MS,
          computeUnits: 'ane',
          niceness: 10,
          tmpRoot: this.deps.tmpRoot?.(),
        })
        this.state = 'ready'
        this.warmMs = this.now() - started
        this.warmLoadSec = run.loadSec
        this.warmError = null
        this.consecutiveFailures = 0
        this.lastStateLog = null
        this.log(`[diarizer] tracks=nemotron names=voiceprint warm in ${this.warmMs} ms (model load ${run.loadSec ?? '?'} s, ${NEMOTRON_VARIANT}, ane)`)
        return
      } catch (error) {
        this.warmError = error instanceof NemotronRunError ? error.reason : 'temp_dir'
        this.log(`[diarizer] Nemotron warm-up attempt ${attempt}/${attempts} failed (${this.warmError}): ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        if (work) {
          untrackNemotronDir(work)
          try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
        }
      }
      if (attempt < attempts) await (this.deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms).unref?.())))(delays[attempt - 1])
    }
    const wait = this.backoff()
    this.trips++
    this.state = 'failed'
    this.retryAt = this.now() + wait
    this.log(`[diarizer] tracks=voiceprint names=voiceprint fallback=warmup_failed (${this.warmError}); next warm-up in ${Math.round(wait / 60_000)} min`)
  }

  /** Why Nemotron cannot take this chunk, or null when it can. */
  private gate(): LiveFallbackReason | 'embedding_requested' | null {
    if (requestedDiarizer(this.env()) === 'embedding') return 'embedding_requested'
    if (this.state === 'idle' || this.state === 'off') { void this.startWarmup(); return 'warming' }
    if (this.state === 'warming') return 'warming'
    if (this.state === 'cooling' || this.state === 'failed') {
      const reason: LiveFallbackReason = this.state === 'cooling'
        ? 'cooling'
        : this.warmError === 'cli_missing' || this.warmError === 'models_missing' ? this.warmError : 'warmup_failed'
      if (this.now() < this.retryAt) return reason
      // The rest is over: one fresh warm-up decides.
      void this.startWarmup()
      return STATIC_REASONS.has(reason) ? reason : 'warming'
    }
    if (this.inFlight >= this.maxConcurrent()) return 'busy'
    return null
  }

  /** Run Nemotron on one chunk WAV within the live budget. Never throws. */
  async diarize(wavPath: string): Promise<LiveDiarizeOutcome> {
    const blocked = this.gate()
    if (blocked) return { ok: false, reason: blocked }
    this.inFlight++
    const started = this.now()
    try {
      const run = await (this.deps.run ?? runNemotronCli)({
        cli: this.cli!,
        modelsDir: this.modelsDir!,
        wavPath,
        timeoutMs: this.budget(),
        computeUnits: 'ane',
        niceness: 10,
        tmpRoot: this.deps.tmpRoot?.(),
      })
      this.consecutiveFailures = 0
      this.trips = 0
      return { ok: true, run }
    } catch (error) {
      const reason: LiveFallbackReason = error instanceof NemotronRunError ? error.reason : 'error'
      if (RUN_FAILURES.has(reason)) {
        this.consecutiveFailures++
        if (this.consecutiveFailures >= BREAKER_FAILURES && this.state === 'ready') {
          // The breaker (QA 6.61.0): stop spawning. Every chunk takes the voiceprint
          // at once instead of waiting out a budget it will not meet.
          const wait = this.backoff()
          this.trips++
          this.state = 'cooling'
          this.retryAt = this.now() + wait
          this.warmError = reason
          this.log(`[diarizer] breaker open: ${this.consecutiveFailures} Nemotron runs failed in a row (last: ${reason}); voiceprint labels for ${Math.round(wait / 60_000)} min, then a fresh warm-up`)
          this.consecutiveFailures = 0
        }
      }
      return { ok: false, reason, detail: error instanceof Error ? error.message : String(error), ms: this.now() - started }
    } finally {
      this.inFlight--
    }
  }

  /** Record one chunk's outcome. Run failures are logged per chunk; state reasons once per change. */
  record(chunk: { sessionId: string; chunkIndex: number }, outcome:
    | { outcome: 'nemotron'; ms: number; segments: number; tracks: number; timing: string; identified: number }
    | { outcome: 'voiceprint'; reason: string; ms: number | null; detail?: string },
  ): void {
    const at = new Date(this.now()).toISOString()
    if (outcome.outcome === 'nemotron') {
      this.counts.nemotron++
      this.last = { at, outcome: 'nemotron', reason: null, ms: outcome.ms }
      this.pushRecent('nemotron', null)
      this.lastStateLog = null
      this.log(`[diarizer] chunk #${chunk.chunkIndex} nemotron ${outcome.ms} ms tracks=${outcome.tracks} segments=${outcome.segments} timing=${outcome.timing} named=${outcome.identified}`)
      return
    }
    this.counts.voiceprint++
    this.counts.reasons[outcome.reason] = (this.counts.reasons[outcome.reason] ?? 0) + 1
    this.last = { at, outcome: 'voiceprint', reason: outcome.reason, ms: outcome.ms }
    // Nemotron ran and heard nobody: not a failure of Nemotron.
    if (outcome.reason !== 'no_speech') this.pushRecent('voiceprint', outcome.reason)
    if (STATE_REASONS.has(outcome.reason)) {
      if (this.lastStateLog === outcome.reason) return
      this.lastStateLog = outcome.reason
      this.log(`[diarizer] chunk #${chunk.chunkIndex} fallback=${outcome.reason} -> voiceprint (and every chunk after it until the state changes; counted in health)`)
      return
    }
    this.log(`[diarizer] chunk #${chunk.chunkIndex} fallback=${outcome.reason}${outcome.ms !== null ? ` after ${outcome.ms} ms` : ''} -> voiceprint${outcome.detail ? ` (${outcome.detail.slice(0, 160)})` : ''}`)
  }

  private pushRecent(outcome: 'nemotron' | 'voiceprint', reason: string | null): void {
    this.recent.push({ outcome, reason })
    if (this.recent.length > RECENT_WINDOW) this.recent.shift()
  }

  snapshot(): LiveSnapshot {
    const choice = activeDiarizer(this.env(), this.home())
    const requested = choice.requested
    const recentNemotron = this.recent.filter(r => r.outcome === 'nemotron').length
    const recentVoiceprint = this.recent.length - recentNemotron
    let active: LiveSnapshot['active']
    let fallback: string | null = null
    if (requested === 'embedding') active = 'embedding'
    else if (choice.fallback) { active = 'embedding'; fallback = choice.fallback }
    else if (this.state === 'warming' || this.state === 'idle') { active = 'warming'; fallback = 'warming' }
    else if (this.state === 'cooling') { active = 'embedding'; fallback = 'cooling' }
    else if (this.state === 'failed' || this.state === 'off') {
      active = 'embedding'
      fallback = this.warmError === 'cli_missing' || this.warmError === 'models_missing' ? this.warmError : 'warmup_failed'
    } else if (this.recent.length > 0 && recentVoiceprint * 2 > this.recent.length) {
      // Warm, but most recent chunks fell back: say so, and why.
      active = 'embedding'
      const tally = new Map<string, number>()
      for (const r of this.recent) if (r.reason) tally.set(r.reason, (tally.get(r.reason) ?? 0) + 1)
      fallback = [...tally.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'error'
    } else active = 'nemotron'
    return {
      requested,
      active,
      fallback,
      recent: { window: RECENT_WINDOW, nemotron: recentNemotron, voiceprint: recentVoiceprint },
      breaker: {
        open: this.state === 'cooling',
        trips: this.trips,
        consecutiveFailures: this.consecutiveFailures,
        retryAt: (this.state === 'cooling' || this.state === 'failed') && this.retryAt ? new Date(this.retryAt).toISOString() : null,
      },
      variant: NEMOTRON_VARIANT,
      computeUnits: 'ane',
      budgetMs: this.budget(),
      maxConcurrent: this.maxConcurrent(),
      inFlight: this.inFlight,
      warm: { state: this.state, ms: this.warmMs, loadSec: this.warmLoadSec, error: this.warmError },
      cliKnown: this.identity ? this.identity.known : null,
      chunks: { nemotron: this.counts.nemotron, voiceprint: this.counts.voiceprint, reasons: { ...this.counts.reasons } },
      last: this.last,
    }
  }
}

export const nemotronLive = new NemotronLiveRuntime()

/** Server start: sweep what a previous process left, then warm the model in the background. */
export function startNemotronWarmup(): void {
  try {
    const swept = sweepStaleNemotron()
    if (swept.dirs || swept.processes) console.log(`[diarizer] startup sweep: removed ${swept.dirs} stale temp dir(s), killed ${swept.processes} orphaned CLI run(s)`)
  } catch { /* the sweep is housekeeping, never a reason not to start */ }
  void nemotronLive.startWarmup()
}
