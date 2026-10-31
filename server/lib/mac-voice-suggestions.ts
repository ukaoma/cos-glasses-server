// 6.96.3: on-click voice suggestions for a saved Mac recording's anonymous voices.
//
// WHY. A 6 s Mac chunk almost never clears the .88 bar automatic names use, so Mac recordings stay full of
// `Voice N`. The fresh-ear study (speaker-diarization-claude-20261030/fresh-ear-192-v1) judged whole voices
// against the shared 192d profiles instead: on 12 voices Miles judged by ear, the rule below gave 10 right,
// 0 wrong and 2 no suggestion, with 0 false names when the person was removed from the profiles.
//
// A SUGGESTION, NEVER A NAME. Every result carries `requiresConfirmation`. A person confirms through the
// normal naming path, which is the only thing that writes. Automatic names keep their own rule untouched:
// this file does not read or change meeting-speaker-policy.ts, identifySpeaker, SEARCH_THRESHOLD or
// AUTO_ENROLL_THRESHOLD.
//
// ON CLICK ONLY. POST /meeting/:sessionId/voice-suggestions is the one caller of `start`. Nothing here runs
// from GET /speakers, at save, on a sweep or at startup.
//
// WRITES NOTHING. No profile, label, sidecar or vector file. Results live in memory, bound to the meeting's
// sourceRevision, and vectors are dropped as soon as a voice is decided. A restart means clicking again.
//
// UNITS AND GATES ARE THE STUDY'S. Audio selection is shared with mac-voice-assignment.ts. Parity with the
// study's predictions.json is proven by a canary on copied audio; see the 6.96.3 report.
//
// DOES NOT STALL THE SERVER. Embedding is a synchronous native call (about 130 ms a unit). The job yields to
// the event loop between units, as mac-assign does, and stops at a 6 minute deadline. A recording or a
// maintenance drain that starts mid-run ends it as `refused`. Dictation only pauses it, because a person
// dictates often and a job that dies each time could never finish.
//
// HOW IT STOPS. One job at a time machine-wide, one user click per job, the deadline, and the live-work
// probes. No LLM, no network, no retained data.

import { readFileSync } from 'node:fs'
import { chunkEmbeddingsEnabled } from './chunk-embedding-store.js'
import { maintenanceLifecycle } from './maintenance-lifecycle.js'
import {
  MAC_ASSIGN_MAX_UNITS,
  MAC_ASSIGN_MIN_SINGLE_SEC,
  MAC_ASSIGN_MIN_UNITS,
  MAC_ASSIGN_MIXED_FRACTION,
  macVoiceChunkUnits,
  macVoiceTurnsOf,
  macVoiceUnitAudio,
  spreadMacVoiceUnits,
  type MacVoiceSlice,
} from './mac-voice-assignment.js'
import { meetingAudioChunkPath } from './meeting-audio-archive.js'
import { getOwnerSpeakerLabel } from './profile.js'
import { extractEmbedding, isEmbeddingAvailable, readVoiceProfiles } from './speaker-embeddings.js'
import { SPEAKER_SHADOW_LIVE_LEASES } from './speaker-shadow.js'
import { dominantCoherentCluster } from './voice-enrolment-selection.js'
import { VOICEPRINT_MIN_AUDIO_SEC } from './voiceprint-floor.js'

/** Frozen in fresh-ear-192-v1/policy.json before the fresh run. Not a tuning knob. */
export const VOICE_SUGGESTION_FLOOR = 0.7
export const VOICE_SUGGESTION_MARGIN = 0.05
/** Marks a suggestion the batch naming flow may offer. Scores from .70 to .80 stay plain suggestions. Names nothing by itself. */
export const HIGH_CONFIDENCE_FLOOR = 0.8
export const HIGH_CONFIDENCE_MARGIN = 0.05
/** Never suggested, though they stay in the bank: their score still has to lose to the suggested person's. */
export const VOICE_SUGGESTION_NEVER_NAMES: readonly string[] = ['MU']
export const VOICE_SUGGESTION_DEADLINE_MS = 6 * 60_000
export const VOICE_SUGGESTION_MODEL_DIM = 192
const RESULT_CACHE_MAX = 16
const PLAN_YIELD_EVERY = 16
const PAUSE_POLL_MS = 250

export type VoiceSuggestionState = 'idle' | 'running' | 'done' | 'refused' | 'failed'
export type VoiceSuggestionGate = 'mixed_voice' | 'too_little_audio' | 'no_dominant_voice' | 'no_usable_audio' | 'below_rule'
export type VoiceSuggestionBlock = 'recording_active' | 'maintenance' | 'meeting_finalizing'

export interface VoiceSuggestion {
  labels: string[]
  name: string
  score: number
  margin: number
  units: number
  kept: number
  requiresConfirmation: true
  /** Unrounded score and margin both clear the high-confidence bar. Only a voice past every gate has a suggestion at all. */
  highConfidence: boolean
}
export interface VoiceSuggestionUnmatched { labels: string[]; gate: VoiceSuggestionGate }

export interface VoiceSuggestionsBody {
  state: VoiceSuggestionState
  reason?: string
  progress?: { done: number; total: number }
  rule: { floor: number; margin: number }
  modelSpace: '192d'
  sourceRevision: string
  suggestions?: VoiceSuggestion[]
  unmatched?: VoiceSuggestionUnmatched[]
}

// ── The bank ─────────────────────────────────────────────────────────────────

export interface StoredVoiceProfile { name: string; embeddings: ArrayLike<number>[]; sources?: string[] }
export interface VoiceBankEntry { name: string; centroid: number[]; samples: number }

function toUnit(vector: ArrayLike<number>): number[] | null {
  const out = new Array<number>(vector.length)
  let sum = 0
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i]
    if (!Number.isFinite(value)) return null
    out[i] = value
    sum += value * value
  }
  if (!(sum > 0)) return null
  const norm = Math.sqrt(sum)
  for (let i = 0; i < out.length; i++) out[i] /= norm
  return out
}

function meanDirection(vectors: number[][]): number[] | null {
  if (vectors.length === 0) return null
  const sum = new Array<number>(vectors[0].length).fill(0)
  for (const vector of vectors) for (let i = 0; i < sum.length; i++) sum[i] += vector[i]
  return toUnit(sum)
}

/**
 * Unit-normalized mean per profile, from 192d samples only. Samples whose source contains this capture's id
 * are dropped first, so a name given on this very call cannot vouch for itself. A profile with nothing left
 * leaves the bank; MU stays in it.
 */
export function buildVoiceBank(profiles: readonly StoredVoiceProfile[], captureId: string): VoiceBankEntry[] {
  const bank: VoiceBankEntry[] = []
  for (const profile of profiles) {
    const units: number[][] = []
    profile.embeddings.forEach((embedding, i) => {
      if (embedding.length !== VOICE_SUGGESTION_MODEL_DIM) return
      if (String(profile.sources?.[i] ?? '').includes(captureId)) return
      const unit = toUnit(embedding)
      if (unit) units.push(unit)
    })
    const centroid = meanDirection(units)
    if (centroid) bank.push({ name: profile.name, centroid, samples: units.length })
  }
  return bank
}

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

// ── One voice's decision ─────────────────────────────────────────────────────

export interface VoiceUnitVector { unit: number[]; sec: number }

export interface VoiceDecision {
  labels: string[]
  units: number
  kept: number
  keptSec: number
  /** Null means this voice earned a suggestion. */
  gate: VoiceSuggestionGate | null
  /** Unrounded, for tests and the parity canary. Present whenever any audio survived the coherence gate. */
  top: { name: string; score: number } | null
  margin: number | null
}

const sameName = (a: string, b: string): boolean => a.normalize('NFKC').trim().toLowerCase() === b.normalize('NFKC').trim().toLowerCase()

/** MU, and whoever this Mac's owner label says the wearer is. A Mac recording has no microphone on the owner. */
export function neverSuggested(name: string, ownerLabel?: string): boolean {
  return VOICE_SUGGESTION_NEVER_NAMES.some(never => sameName(never, name)) || (!!ownerLabel && sameName(ownerLabel, name))
}

/** The frozen rule, on unrounded values. */
export function passesVoiceSuggestionRule(score: number, margin: number): boolean {
  return score >= VOICE_SUGGESTION_FLOOR && margin >= VOICE_SUGGESTION_MARGIN
}

/** On unrounded values, so a .7996 that displays as .800 is not high confidence. */
export function isHighConfidenceVoiceSuggestion(score: number, margin: number): boolean {
  return score >= HIGH_CONFIDENCE_FLOOR && margin >= HIGH_CONFIDENCE_MARGIN
}

/** Gates in the study's order, then the frozen rule. Pure. */
export function decideVoiceSuggestion(labels: string[], vectors: readonly VoiceUnitVector[], bank: readonly VoiceBankEntry[], ownerLabel?: string): VoiceDecision {
  const none = (gate: VoiceSuggestionGate): VoiceDecision => ({ labels, units: vectors.length, kept: 0, keptSec: 0, gate, top: null, margin: null })
  if (vectors.length === 0) return none('no_usable_audio')
  const cluster = dominantCoherentCluster(vectors.map(v => Float32Array.from(v.unit)))
  if (cluster.members.length === 0) return none('no_dominant_voice')
  const kept = cluster.members.map(i => vectors[i])
  const keptSec = kept.reduce((sum, v) => sum + v.sec, 0)
  const voice = meanDirection(kept.map(v => v.unit))
  const ranked = voice ? bank.map(entry => ({ name: entry.name, score: dot(voice, entry.centroid) })).sort((a, b) => b.score - a.score) : []
  const top = ranked[0] ?? null
  const margin = ranked.length >= 2 ? ranked[0].score - ranked[1].score : null
  let gate: VoiceSuggestionGate | null = null
  if (kept.length < vectors.length && kept.length / vectors.length < MAC_ASSIGN_MIXED_FRACTION) gate = 'mixed_voice'
  else if (kept.length < MAC_ASSIGN_MIN_UNITS && keptSec < MAC_ASSIGN_MIN_SINGLE_SEC) gate = 'too_little_audio'
  else if (!top || margin === null || !passesVoiceSuggestionRule(top.score, margin) || neverSuggested(top.name, ownerLabel)) gate = 'below_rule'
  return { labels, units: vectors.length, kept: kept.length, keptSec, gate, top, margin }
}

// ── Which audio ──────────────────────────────────────────────────────────────

export interface VoiceSidecarEntry { chunkIndex: number; chunk: Record<string, unknown> }
export interface VoiceUnitRef { raw: number; slice: MacVoiceSlice | null }

/** Valid `chunkEntries` rows. Nothing else addresses retained audio: a chunk's array position is not its WAV number. */
export function voiceSidecarEntries(sidecar: Record<string, unknown>): VoiceSidecarEntry[] {
  const rows = Array.isArray(sidecar.chunkEntries) ? sidecar.chunkEntries as Array<Record<string, unknown>> : []
  return rows.filter((row): row is Record<string, unknown> & VoiceSidecarEntry => typeof row?.chunkIndex === 'number' && !!row.chunk && typeof row.chunk === 'object')
}

/** Every candidate unit of one voice, in call order, before the duration filter and the spread. */
export function voiceUnitCandidates(entries: readonly VoiceSidecarEntry[], label: string): VoiceUnitRef[] {
  const out: VoiceUnitRef[] = []
  for (const entry of entries) {
    const turns = macVoiceTurnsOf(entry.chunk)
    if (entry.chunk.speaker !== label && !turns.some(t => t.speaker === label)) continue
    const units = macVoiceChunkUnits(turns, label)
    if (units === 'whole') out.push({ raw: entry.chunkIndex, slice: null })
    else for (const slice of units) out.push({ raw: entry.chunkIndex, slice })
  }
  return out.sort((a, b) => a.raw - b.raw || (a.slice?.startSec ?? 0) - (b.slice?.startSec ?? 0))
}

// ── Probes ───────────────────────────────────────────────────────────────────

/** Live work that pauses a job rather than ending it. Everything else in SPEAKER_SHADOW_LIVE_LEASES ends it. */
export const VOICE_SUGGESTION_PAUSE_LEASES: readonly string[] = ['one_shot_transcription', 'prompt_draft_write', 'prompt_draft_warm', 'prompt_draft_finalize']

const defaultActiveByKind = (): Record<string, number> => maintenanceLifecycle.snapshot().activeByKind as Record<string, number>

export function voiceSuggestionRecordingLease(activeByKind: () => Record<string, number> = defaultActiveByKind): boolean {
  const byKind = activeByKind()
  return SPEAKER_SHADOW_LIVE_LEASES.some(kind => !VOICE_SUGGESTION_PAUSE_LEASES.includes(kind) && (byKind[kind] ?? 0) > 0)
}

export function voiceSuggestionPauseLease(activeByKind: () => Record<string, number> = defaultActiveByKind): boolean {
  const byKind = activeByKind()
  return VOICE_SUGGESTION_PAUSE_LEASES.some(kind => (byKind[kind] ?? 0) > 0)
}

// ── The job ──────────────────────────────────────────────────────────────────

export interface VoiceSuggestionDeps {
  now: () => number
  yieldToLoop: () => Promise<void>
  sleep: (ms: number) => Promise<void>
  /** The speaker runtime is up and the embedding master switch is on. */
  available: () => boolean
  extract: (audio: Buffer, unit: VoiceUnitRef) => Float32Array | null
  readProfiles: () => { profiles: StoredVoiceProfile[] }
  audioPath: (sessionId: string, raw: number) => string | null
  ownerLabel: () => string | undefined
  log: (line: string) => void
  /** Sees each voice's unrounded decision. For the parity canary; the server passes nothing. */
  observe?: (decision: VoiceDecision) => void
}

export function defaultVoiceSuggestionDeps(): VoiceSuggestionDeps {
  return {
    now: Date.now,
    yieldToLoop: () => new Promise<void>(resolve => setImmediate(resolve)),
    sleep: ms => new Promise<void>(resolve => { setTimeout(resolve, ms) }),
    available: () => chunkEmbeddingsEnabled() && isEmbeddingAvailable(),
    extract: audio => extractEmbedding(audio),
    readProfiles: readVoiceProfiles,
    audioPath: meetingAudioChunkPath,
    ownerLabel: () => { try { return getOwnerSpeakerLabel() } catch { return undefined } },
    log: line => console.log(`[voice-suggestions] ${line}`),
  }
}

export interface VoiceSuggestionStartInput {
  sessionId: string
  sourceRevision: string
  entries: VoiceSidecarEntry[]
  /** Read once the job has started, so the click answers before a large review is built. Refused when it says so. */
  loadScopes: () => Promise<{ scopes: string[][] } | { refused: string }>
  /** Why a job may not start or continue right now. Called before every unit. */
  block: () => VoiceSuggestionBlock | null
  /** Live work a job waits out instead of ending. */
  pause: () => boolean
}

interface Job {
  sessionId: string
  sourceRevision: string
  state: Exclude<VoiceSuggestionState, 'idle'>
  reason?: string
  progress: { done: number; total: number }
  suggestions?: VoiceSuggestion[]
  unmatched?: VoiceSuggestionUnmatched[]
  cancelled: boolean
}

class JobStop extends Error {
  constructor(readonly state: 'refused' | 'failed' | 'cancelled', readonly reason: string) { super(reason) }
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000

export class VoiceSuggestionRunner {
  private readonly deps: VoiceSuggestionDeps
  private readonly jobs = new Map<string, Job>()
  private active: Job | null = null

  constructor(deps: Partial<VoiceSuggestionDeps> = {}) {
    this.deps = { ...defaultVoiceSuggestionDeps(), ...deps }
  }

  private idle(sourceRevision: string): VoiceSuggestionsBody {
    return { state: 'idle', rule: { floor: VOICE_SUGGESTION_FLOOR, margin: VOICE_SUGGESTION_MARGIN }, modelSpace: '192d', sourceRevision }
  }

  private body(job: Job): VoiceSuggestionsBody {
    return {
      ...this.idle(job.sourceRevision),
      state: job.state,
      ...(job.reason ? { reason: job.reason } : {}),
      ...(job.state === 'running' || job.state === 'done' ? { progress: { ...job.progress } } : {}),
      ...(job.suggestions ? { suggestions: job.suggestions } : {}),
      ...(job.unmatched ? { unmatched: job.unmatched } : {}),
    }
  }

  /** The body for a refusal with no job behind it. */
  refusal(reason: string, sourceRevision: string): VoiceSuggestionsBody {
    return { ...this.idle(sourceRevision), state: 'refused', reason }
  }

  private remember(job: Job): void {
    this.jobs.delete(job.sessionId)
    this.jobs.set(job.sessionId, job)
    while (this.jobs.size > RESULT_CACHE_MAX) this.jobs.delete(this.jobs.keys().next().value as string)
  }

  /** The state of a job in flight, so polling does not re-hash a large meeting. Null when none is running. */
  running(sessionId: string): VoiceSuggestionsBody | null {
    const job = this.jobs.get(sessionId)
    return job?.state === 'running' && !job.cancelled ? this.body(job) : null
  }

  /** A result counts only for the revision it was computed from. Starts nothing. */
  read(sessionId: string, sourceRevision: string): VoiceSuggestionsBody {
    const job = this.jobs.get(sessionId)
    return job && job.sourceRevision === sourceRevision && !job.cancelled ? this.body(job) : this.idle(sourceRevision)
  }

  /** The result of a finished job, as a copy. Null for anything else, including a job still running. */
  finished(sessionId: string): { sourceRevision: string; suggestions: VoiceSuggestion[] } | null {
    const job = this.jobs.get(sessionId)
    if (job?.state !== 'done' || job.cancelled || !job.suggestions) return null
    return { sourceRevision: job.sourceRevision, suggestions: job.suggestions.map(suggestion => ({ ...suggestion, labels: [...suggestion.labels] })) }
  }

  /** Called by POST and nothing else. Returns the current job when there is one for this revision. */
  start(input: VoiceSuggestionStartInput): VoiceSuggestionsBody {
    const existing = this.jobs.get(input.sessionId)
    if (existing && existing.sourceRevision === input.sourceRevision && !existing.cancelled && (existing.state === 'running' || existing.state === 'done')) return this.body(existing)
    const refuse = (reason: string): VoiceSuggestionsBody => {
      const job: Job = { sessionId: input.sessionId, sourceRevision: input.sourceRevision, state: 'refused', reason, progress: { done: 0, total: 0 }, cancelled: false }
      // A refusal must not wipe the running job of an older revision: only a job that actually starts replaces it.
      if (!(existing?.state === 'running')) this.remember(job)
      return this.body(job)
    }
    const blocked = input.block()
    if (blocked) return refuse(blocked)
    if (!this.deps.available()) return refuse('speaker_model_unavailable')
    if (!input.entries.some(entry => this.deps.audioPath(input.sessionId, entry.chunkIndex))) return refuse('audio_not_retained')
    // The same meeting at a newer revision replaces its own stale job; another meeting has to wait.
    if (this.active && this.active.sessionId !== input.sessionId) return refuse('job_running_elsewhere')
    if (this.active) this.active.cancelled = true

    const job: Job = { sessionId: input.sessionId, sourceRevision: input.sourceRevision, state: 'running', progress: { done: 0, total: 0 }, cancelled: false }
    this.active = job
    this.remember(job)
    void this.run(job, input).catch(error => this.settle(job, 'failed', 'internal_error', error))
    return this.body(job)
  }

  private settle(job: Job, state: 'refused' | 'failed', reason: string, error?: unknown): void {
    if (job.cancelled) return
    job.state = state
    job.reason = reason
    if (this.active === job) this.active = null
    this.deps.log(`${state} ${job.sessionId} (${reason})${error ? `: ${error instanceof Error ? error.message : String(error)}` : ''}`)
  }

  private async run(job: Job, input: VoiceSuggestionStartInput): Promise<void> {
    const { now, yieldToLoop, sleep } = this.deps
    const started = now()
    const deadline = started + VOICE_SUGGESTION_DEADLINE_MS
    /** Between units: end on anything that says stop, wait out dictation, then let the server breathe. */
    const checkpoint = async (): Promise<void> => {
      for (;;) {
        if (job.cancelled) throw new JobStop('cancelled', 'superseded')
        if (now() >= deadline) throw new JobStop('failed', 'deadline')
        const blocked = input.block()
        if (blocked) throw new JobStop('refused', blocked)
        if (!input.pause()) break
        await sleep(PAUSE_POLL_MS)
      }
      await yieldToLoop()
    }
    try {
      await yieldToLoop()
      const loaded = await input.loadScopes()
      if ('refused' in loaded) throw new JobStop('refused', loaded.refused)
      let profiles: StoredVoiceProfile[]
      try { profiles = this.deps.readProfiles().profiles } catch { throw new JobStop('failed', 'profile_store_unreadable') }
      const bank = buildVoiceBank(profiles, input.sessionId)
      if (bank.length < 2) throw new JobStop('refused', 'not_enough_voice_profiles')
      const ownerLabel = this.deps.ownerLabel()

      // Plan first: the 40 units are spread over audio that can actually be used, as in the study.
      const planned: Array<{ labels: string[]; units: Array<VoiceUnitRef & { sec: number }> }> = []
      let reads = 0
      for (const labels of loaded.scopes) {
        const usable: Array<VoiceUnitRef & { sec: number }> = []
        for (const label of labels) {
          for (const unit of voiceUnitCandidates(input.entries, label)) {
            if (++reads % PLAN_YIELD_EVERY === 0) await checkpoint()
            const path = this.deps.audioPath(input.sessionId, unit.raw)
            if (!path) continue
            let cut: { sec: number } | null = null
            try { cut = macVoiceUnitAudio(readFileSync(path), unit.slice) } catch { continue }
            if (cut && cut.sec >= VOICEPRINT_MIN_AUDIO_SEC) usable.push({ ...unit, sec: cut.sec })
          }
        }
        planned.push({ labels, units: spreadMacVoiceUnits(usable, MAC_ASSIGN_MAX_UNITS) })
      }
      job.progress.total = planned.reduce((sum, plan) => sum + plan.units.length, 0)

      const decisions: VoiceDecision[] = []
      for (const plan of planned) {
        const vectors: VoiceUnitVector[] = []
        for (const unit of plan.units) {
          await checkpoint()
          const path = this.deps.audioPath(input.sessionId, unit.raw)
          let embedding: Float32Array | null = null
          if (path) {
            let cut: { audio: Buffer; sec: number } | null = null
            try { cut = macVoiceUnitAudio(readFileSync(path), unit.slice) } catch { /* evicted mid-run */ }
            if (cut) embedding = this.deps.extract(cut.audio, { raw: unit.raw, slice: unit.slice })
          }
          job.progress.done += 1
          if (embedding?.length !== VOICE_SUGGESTION_MODEL_DIM) continue
          const asUnit = toUnit(embedding)
          if (asUnit) vectors.push({ unit: asUnit, sec: unit.sec })
        }
        const decision = decideVoiceSuggestion(plan.labels, vectors, bank, ownerLabel)
        this.deps.observe?.(decision)
        decisions.push(decision)
      }

      if (job.cancelled) throw new JobStop('cancelled', 'superseded')
      job.suggestions = []
      job.unmatched = []
      for (const decision of decisions) {
        if (decision.gate === null && decision.top && decision.margin !== null) {
          job.suggestions.push({ labels: decision.labels, name: decision.top.name, score: round3(decision.top.score), margin: round3(decision.margin), units: decision.units, kept: decision.kept, requiresConfirmation: true, highConfidence: isHighConfidenceVoiceSuggestion(decision.top.score, decision.margin) })
        } else {
          job.unmatched.push({ labels: decision.labels, gate: decision.gate ?? 'below_rule' })
        }
      }
      job.state = 'done'
      if (this.active === job) this.active = null
      this.deps.log(`done ${job.sessionId} in ${now() - started} ms: units=${job.progress.done} suggestions=${job.suggestions.length} unmatched=${job.unmatched.length}`)
    } catch (error) {
      if (error instanceof JobStop) {
        if (error.state === 'cancelled') { if (this.active === job) this.active = null; return }
        this.settle(job, error.state, error.reason)
        return
      }
      throw error
    }
  }
}

let shared: VoiceSuggestionRunner | null = null
/** One per server process, which is what makes it one job at a time machine-wide. */
export function getVoiceSuggestionRunner(): VoiceSuggestionRunner {
  shared ??= new VoiceSuggestionRunner()
  return shared
}
export function resetVoiceSuggestionRunnerForTests(runner: VoiceSuggestionRunner | null = null): void {
  shared = runner
}

/**
 * The in-memory result of this session's finished job, or null. Batch naming reads this to confirm each item is a
 * current high-confidence suggestion; it must still compare `sourceRevision` with the meeting as it is now.
 */
export function currentVoiceSuggestions(sessionId: string): { sourceRevision: string; suggestions: VoiceSuggestion[] } | null {
  return shared?.finished(sessionId) ?? null
}
