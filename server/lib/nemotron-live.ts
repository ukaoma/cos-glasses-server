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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NEMOTRON_VARIANT,
  activeDiarizer,
  nemotronCliPath,
  prepareNemotronModelsDir,
  requestedDiarizer,
} from './diarizer-backend.js'
import { NemotronRunError, runNemotronCli, type NemotronRun, type RunNemotronOptions } from './nemotron-cli.js'
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

  // Dominant NAME by voiced time: two channels can carry one person.
  const voiced = new Map<string, number>()
  for (const track of tracks) {
    if (!names.has(track.channel)) continue
    const name = names.get(track.channel)!.speaker
    voiced.set(name, (voiced.get(name) ?? 0) + track.activeSec)
  }
  let speaker = nameOf(dominant).speaker
  let best = -1
  for (const [name, sec] of voiced) if (sec > best) { best = sec; speaker = name }
  const similarity = [...names.values()].find(named => named.speaker === speaker)?.similarity ?? 0
  return { ok: true, speaker, similarity: round(similarity, 3), segments, tracks: tracks.length, timing, identified }
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
    if (outcome.reason === 'embedding_requested') return { speaker: input.voiceprint.speaker, similarity: input.voiceprint.similarity }
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

export type LiveState = 'off' | 'idle' | 'warming' | 'ready' | 'failed'

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
}

export const LIVE_BUDGET_MS = 1500
export const LIVE_MAX_CONCURRENT = 2
const WARM_TIMEOUT_MS = 180_000
const WARM_RETRY_DELAYS_MS = [5_000, 30_000]
/** After this many consecutive timeouts the compiled model is presumed evicted. */
const REWARM_AFTER_TIMEOUTS = 3
const REWARM_MIN_INTERVAL_MS = 10 * 60_000

export interface LiveSnapshot {
  requested: 'nemotron' | 'embedding'
  /** What labels a chunk right now. */
  active: 'nemotron' | 'warming' | 'embedding'
  fallback: string | null
  variant: string
  computeUnits: 'ane'
  budgetMs: number
  maxConcurrent: number
  inFlight: number
  warm: { state: LiveState; ms: number | null; loadSec: number | null; error: string | null }
  chunks: { nemotron: number; voiceprint: number; reasons: Record<string, number> }
  last: { at: string; outcome: 'nemotron' | 'voiceprint'; reason: string | null; ms: number | null } | null
}

export class NemotronLiveRuntime {
  private state: LiveState = 'idle'
  private inFlight = 0
  private consecutiveTimeouts = 0
  private warming: Promise<void> | null = null
  private lastWarmEndedAt = 0
  private warmMs: number | null = null
  private warmLoadSec: number | null = null
  private warmError: string | null = null
  private cli: string | null = null
  private modelsDir: string | null = null
  private counts = { nemotron: 0, voiceprint: 0, reasons: {} as Record<string, number> }
  private last: LiveSnapshot['last'] = null

  constructor(private readonly deps: NemotronLiveDeps = {}) {}

  private env(): NodeJS.ProcessEnv { return this.deps.env?.() ?? process.env }
  private home(): string { return this.deps.home?.() ?? homedir() }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private log(line: string): void { (this.deps.log ?? console.log)(line) }
  private budget(): number { return this.deps.budgetMs ?? LIVE_BUDGET_MS }
  private maxConcurrent(): number { return this.deps.maxConcurrent ?? LIVE_MAX_CONCURRENT }

  /** Start (or restart) the background warm-up. Never throws, never blocks a chunk. */
  startWarmup(): Promise<void> {
    if (requestedDiarizer(this.env()) === 'embedding') {
      this.state = 'off'
      this.log('[diarizer] tracks=voiceprint names=voiceprint (COS_DIARIZER selects the voiceprint)')
      return Promise.resolve()
    }
    if (this.warming) return this.warming
    this.state = 'warming'
    this.warming = this.warm().finally(() => {
      this.warming = null
      this.lastWarmEndedAt = this.now()
    })
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
        // Static: retrying cannot install a binary or download a model.
        this.state = 'failed'
        this.warmError = choice.fallback ?? 'models_missing'
        this.log(`[diarizer] tracks=voiceprint names=voiceprint fallback=${this.warmError} (Nemotron requested)`)
        return
      }
      const work = mkdtempSync(join(this.deps.tmpRoot?.() ?? tmpdir(), 'cos-nemotron-warm-'))
      const wav = join(work, 'warm.wav')
      const started = this.now()
      try {
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
        this.consecutiveTimeouts = 0
        this.log(`[diarizer] tracks=nemotron names=voiceprint warm in ${this.warmMs} ms (model load ${run.loadSec ?? '?'} s, ${NEMOTRON_VARIANT}, ane)`)
        return
      } catch (error) {
        this.warmError = error instanceof NemotronRunError ? error.reason : 'error'
        this.log(`[diarizer] Nemotron warm-up attempt ${attempt}/${attempts} failed (${this.warmError}): ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
      }
      if (attempt < attempts) await (this.deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms).unref?.())))(delays[attempt - 1])
    }
    this.state = 'failed'
    this.log(`[diarizer] tracks=voiceprint names=voiceprint fallback=warmup_failed (${this.warmError})`)
  }

  /** Why Nemotron cannot take this chunk, or null when it can. */
  private gate(): LiveFallbackReason | 'embedding_requested' | null {
    if (requestedDiarizer(this.env()) === 'embedding') return 'embedding_requested'
    if (this.state === 'idle' || this.state === 'off') { void this.startWarmup(); return 'warming' }
    if (this.state === 'warming') return 'warming'
    if (this.state === 'failed') {
      // Bounded self-healing: one more warm-up at most every ten minutes.
      if (this.now() - this.lastWarmEndedAt > REWARM_MIN_INTERVAL_MS) void this.startWarmup()
      return this.warmError === 'cli_missing' || this.warmError === 'models_missing' ? this.warmError : 'warmup_failed'
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
      this.consecutiveTimeouts = 0
      return { ok: true, run }
    } catch (error) {
      const reason: LiveFallbackReason = error instanceof NemotronRunError ? error.reason : 'error'
      if (reason === 'timeout') {
        this.consecutiveTimeouts++
        if (this.consecutiveTimeouts >= REWARM_AFTER_TIMEOUTS && this.now() - this.lastWarmEndedAt > REWARM_MIN_INTERVAL_MS) {
          // A warm run takes about 0.15 s, so repeated budget kills mean the
          // compiled model is gone. Each kill aborts the compile it would need,
          // so re-warm without a budget while chunks keep the voiceprint.
          this.consecutiveTimeouts = 0
          this.log('[diarizer] repeated Nemotron timeouts; re-warming in the background')
          this.state = 'warming'
          void this.startWarmup()
        }
      }
      return { ok: false, reason, detail: error instanceof Error ? error.message : String(error), ms: this.now() - started }
    } finally {
      this.inFlight--
    }
  }

  /** Record one chunk's outcome and log it. Every fallback is logged with its reason. */
  record(chunk: { sessionId: string; chunkIndex: number }, outcome:
    | { outcome: 'nemotron'; ms: number; segments: number; tracks: number; timing: string; identified: number }
    | { outcome: 'voiceprint'; reason: string; ms: number | null; detail?: string },
  ): void {
    const at = new Date(this.now()).toISOString()
    if (outcome.outcome === 'nemotron') {
      this.counts.nemotron++
      this.last = { at, outcome: 'nemotron', reason: null, ms: outcome.ms }
      this.log(`[diarizer] chunk #${chunk.chunkIndex} nemotron ${outcome.ms} ms tracks=${outcome.tracks} segments=${outcome.segments} timing=${outcome.timing} named=${outcome.identified}`)
      return
    }
    this.counts.voiceprint++
    this.counts.reasons[outcome.reason] = (this.counts.reasons[outcome.reason] ?? 0) + 1
    this.last = { at, outcome: 'voiceprint', reason: outcome.reason, ms: outcome.ms }
    this.log(`[diarizer] chunk #${chunk.chunkIndex} fallback=${outcome.reason}${outcome.ms !== null ? ` after ${outcome.ms} ms` : ''} -> voiceprint${outcome.detail ? ` (${outcome.detail.slice(0, 160)})` : ''}`)
  }

  snapshot(): LiveSnapshot {
    const choice = activeDiarizer(this.env(), this.home())
    const requested = choice.requested
    let active: LiveSnapshot['active']
    let fallback: string | null = null
    if (requested === 'embedding') active = 'embedding'
    else if (choice.fallback) { active = 'embedding'; fallback = choice.fallback }
    else if (this.state === 'ready') active = 'nemotron'
    else if (this.state === 'warming' || this.state === 'idle') { active = 'warming'; fallback = 'warming' }
    else { active = 'embedding'; fallback = this.warmError === 'cli_missing' || this.warmError === 'models_missing' ? this.warmError : 'warmup_failed' }
    return {
      requested,
      active,
      fallback,
      variant: NEMOTRON_VARIANT,
      computeUnits: 'ane',
      budgetMs: this.budget(),
      maxConcurrent: this.maxConcurrent(),
      inFlight: this.inFlight,
      warm: { state: this.state, ms: this.warmMs, loadSec: this.warmLoadSec, error: this.warmError },
      chunks: { nemotron: this.counts.nemotron, voiceprint: this.counts.voiceprint, reasons: { ...this.counts.reasons } },
      last: this.last,
    }
  }
}

export const nemotronLive = new NemotronLiveRuntime()

/** Server start: warm the model in the background. */
export function startNemotronWarmup(): void {
  void nemotronLive.startWarmup().catch(error => console.warn(`[diarizer] warm-up error: ${error instanceof Error ? error.message : String(error)}`))
}
