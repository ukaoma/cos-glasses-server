// 6.93.0: the I/O half of live Mac window replay (mac-window-voices.ts is the pure half).
//
// Reads the durable raw chunks the route already wrote, joins the planned window
// into one private temp WAV, runs the injected diarizer once with a budget sized
// from the window's audio length, removes the temp WAV, and crosswalks. When a
// carried slot needs the current chunk's agreement (QA W1) the chunk is diarized
// alone as well, after the window run. A window run that times out or whose
// geometry is refused falls back to the plain per-chunk run (QA W4). Any failure
// is the normal live fallback (`Ext`); nothing here throws into the chunk route.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MAC_AUDIO } from './mac-recording.js'
import { NEMOTRON_TMP_PREFIX, trackNemotronDir, untrackNemotronDir } from './nemotron-cli.js'
import { pcm16ToWav, readPcm16Mono, type Activity } from './nemotron-segments.js'
import { liveBudgetForAudioSec, type LiveDiarizeOutcome } from './nemotron-live.js'
import { chunkShowsVoiceLabel, macLiveVoicesMode, type MacLiveVoicesMode } from './mac-voice-labels.js'
import {
  crosswalkMacWindow,
  emptyMacWindowVoices,
  planMacWindow,
  validMacWindowVoices,
  type MacWindowPlan,
  type MacWindowResult,
  type MacWindowStats,
  type MacWindowVoiceState,
} from './mac-window-voices.js'

interface LabeledChunk { speaker?: unknown; segments?: unknown }

/** Why a capture's window labels are withheld, or null when they may run. */
export type MacWindowWithheld = 'corrupt_state' | 'earlier_voice_labels'

export function macWindowWithheldReason(saved: unknown, chunks: ReadonlyArray<LabeledChunk | null | undefined>): MacWindowWithheld | null {
  if (saved !== undefined) return validMacWindowVoices(saved) ? null : 'corrupt_state'
  return chunks.some(chunkShowsVoiceLabel) ? 'earlier_voice_labels' : null
}

/**
 * The state this capture may continue from, or null to withhold window labels.
 * Corrupt state stays as it is (never replaced by a fresh start). A capture that
 * already shows Voice labels without window state (switch flipped mid-capture, or
 * an older server) never restarts numbering at Voice 1.
 */
export function macWindowStateFor(saved: unknown, chunks: ReadonlyArray<LabeledChunk | null | undefined>): MacWindowVoiceState | null {
  if (macWindowWithheldReason(saved, chunks)) return null
  return saved === undefined ? emptyMacWindowVoices() : saved as MacWindowVoiceState
}

// ── Counts (never text): one log line per window run, health totals since start ──

const counters = {
  runs: 0,
  fallbackTimeout: 0,
  fallbackGeometry: 0,
  agreementUnavailable: 0,
  carried: 0,
  withheld: 0,
  created: 0,
  confirmed: 0,
  evicted: 0,
  capped: 0,
  disabledCaptures: 0,
  stateWithheld: { corrupt_state: 0, earlier_voice_labels: 0 } as Record<MacWindowWithheld, number>,
}

/**
 * QA R3 and W11: the window is switched off for a capture when MAC_WINDOW_BACKOFF_TIMEOUTS of its last
 * MAC_WINDOW_BACKOFF_OF_LAST window runs timed out. After that the capture uses per-chunk runs only (`Ext`) until
 * the server restarts, because a window timeout is exempt from the shared breaker and would otherwise cost its full
 * wait on every chunk, for ever. A rolling count, not a streak: a loaded Mac that alternates a timeout with a
 * run that just fits still pays most of a 6 s cadence on every other chunk, and a streak never trips on it.
 */
export const MAC_WINDOW_BACKOFF_TIMEOUTS = 2
export const MAC_WINDOW_BACKOFF_OF_LAST = 3
const recentWindowRuns = new Map<string, boolean[]>()
const windowDisabled = new Set<string>()
const CAPTURE_MEMORY_MAX = 256

function remember<T>(set: Set<T>, value: T): void {
  if (set.size >= CAPTURE_MEMORY_MAX) set.delete(set.values().next().value as T)
  set.add(value)
}

/** True once this capture's window has timed out too often. */
export function macWindowDisabledFor(sessionId: string): boolean {
  return windowDisabled.has(sessionId)
}

function noteWindowRun(sessionId: string, timedOut: boolean, log: (line: string) => void): void {
  if (!recentWindowRuns.has(sessionId) && recentWindowRuns.size >= CAPTURE_MEMORY_MAX) recentWindowRuns.delete(recentWindowRuns.keys().next().value as string)
  const recent = [...(recentWindowRuns.get(sessionId) ?? []), timedOut].slice(-MAC_WINDOW_BACKOFF_OF_LAST)
  recentWindowRuns.set(sessionId, recent)
  const timeouts = recent.filter(Boolean).length
  if (timeouts >= MAC_WINDOW_BACKOFF_TIMEOUTS && !windowDisabled.has(sessionId)) {
    remember(windowDisabled, sessionId)
    counters.disabledCaptures++
    log(`[mac-window] capture ${sessionId} window disabled after ${timeouts} of the last ${recent.length} window runs timed out; per-chunk runs only for the rest of this capture (Ext)`)
  }
}

export function __resetMacWindowCountersForTests(): void {
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) {
    if (key === 'stateWithheld') counters.stateWithheld = { corrupt_state: 0, earlier_voice_labels: 0 }
    else (counters[key] as number) = 0
  }
  seenWithheld.clear()
  recentWindowRuns.clear()
  windowDisabled.clear()
}

const seenWithheld = new Set<string>()
const SEEN_WITHHELD_MAX = 256

/** A capture whose window labels are withheld says so once per reason, so `Ext` for a whole meeting is never silent. */
export function noteMacWindowWithheld(sessionId: string, reason: MacWindowWithheld, log: (line: string) => void = console.log): void {
  const key = `${sessionId}:${reason}`
  if (seenWithheld.has(key)) return
  if (seenWithheld.size >= SEEN_WITHHELD_MAX) seenWithheld.delete(seenWithheld.values().next().value as string)
  seenWithheld.add(key)
  counters.stateWithheld[reason]++
  log(`[mac-window] capture ${sessionId} window labels withheld (${reason}); its chunks stay Ext for the rest of this capture`)
}

export interface MacLiveVoicesSnapshot {
  /** Which live Voice path is on: window (6.93.0, the default), anchors (6.92.1) or off (COS_MAC_LIVE_VOICES=off). */
  mode: MacLiveVoicesMode
  /** Totals since this server started; present only while the window path is on. */
  window?: {
    runs: number
    fallbacks: { timeout: number; geometry: number }
    agreementUnavailable: number
    carried: number
    withheld: number
    created: number
    confirmed: number
    evicted: number
    capped: number
    /** Captures that stopped using the window after repeated window timeouts (QA R3). */
    disabledCaptures: number
    stateWithheld: Record<MacWindowWithheld, number>
  }
}

/** For `/api/health` capabilities: the switch state, and the window path's counts when it is on. */
export function macLiveVoicesSnapshot(env: NodeJS.ProcessEnv = process.env): MacLiveVoicesSnapshot {
  const mode = macLiveVoicesMode(env)
  if (mode !== 'window') return { mode }
  return {
    mode,
    window: {
      runs: counters.runs,
      fallbacks: { timeout: counters.fallbackTimeout, geometry: counters.fallbackGeometry },
      agreementUnavailable: counters.agreementUnavailable,
      carried: counters.carried,
      withheld: counters.withheld,
      created: counters.created,
      confirmed: counters.confirmed,
      evicted: counters.evicted,
      capped: counters.capped,
      disabledCaptures: counters.disabledCaptures,
      stateWithheld: { ...counters.stateWithheld },
    },
  }
}

export interface MacWindowJob {
  diarize: Promise<LiveDiarizeOutcome>
  /** Set once `diarize` settles with a trusted crosswalk; null otherwise. */
  result: () => MacWindowResult | null
}

const chunkName = (index: number): string => `chunk_${String(index).padStart(4, '0')}.wav`

/**
 * Start chunk `chunkIndex`'s window run. `audio` is the chunk's own WAV (already
 * durable at `sessionDir`). Returns null when no window can be planned; the caller
 * then runs the plain per-chunk diarizer.
 *  - `diarizeWindow` runs the CLI on the window WAV within `timeoutMs`.
 *  - `diarizeChunk` runs it on one durable chunk WAV within the per-chunk budget:
 *    the agreement view, and the fallback after a window timeout or refusal.
 */
export function startMacWindowDiarize(input: {
  sessionId: string
  sessionDir: string
  chunkIndex: number
  audio: Buffer
  audioSha256: string
  state: MacWindowVoiceState
  diarizeWindow: (wavPath: string, timeoutMs: number) => Promise<LiveDiarizeOutcome>
  diarizeChunk: (wavPath: string) => Promise<LiveDiarizeOutcome>
  tmpRoot?: string
  log?: (line: string) => void
}): MacWindowJob | null {
  const log = input.log ?? console.log
  const pcmOf = new Map<number, Buffer>()
  const own = readPcm16Mono(input.audio)
  if (!own) return null
  pcmOf.set(input.chunkIndex, own.pcm)
  const plan = planMacWindow(input.chunkIndex, chunk => {
    if (pcmOf.has(chunk)) return pcmOf.get(chunk)!.length / 2
    try {
      const pcm = readPcm16Mono(readFileSync(resolve(input.sessionDir, chunkName(chunk))))
      if (!pcm) return null
      pcmOf.set(chunk, pcm.pcm)
      return pcm.pcm.length / 2
    } catch { return null }
  })
  if (!plan) return null
  const windowSamples = plan.chunks.reduce((sum, c) => sum + c.samples, 0)
  const windowSec = windowSamples / MAC_AUDIO.sampleRate
  let work: string
  let wavPath: string
  try {
    work = mkdtempSync(join(input.tmpRoot ?? tmpdir(), `${NEMOTRON_TMP_PREFIX}window-`))
    trackNemotronDir(work)
    wavPath = join(work, 'window.wav')
    writeFileSync(wavPath, pcm16ToWav(Buffer.concat(plan.chunks.map(c => pcmOf.get(c.chunk)!))), { mode: 0o600 })
  } catch {
    return null
  }
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    untrackNemotronDir(work)
    try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  const chunkPath = resolve(input.sessionDir, chunkName(input.chunkIndex))
  let result: MacWindowResult | null = null
  const cross = (window: Activity, chunkAlone: Activity | null, planned: MacWindowPlan): MacWindowResult | null => {
    try { return crosswalkMacWindow({ state: input.state, window, plan: planned, audioSha256: input.audioSha256, chunkAlone }) } catch { return null }
  }
  const timeoutMs = liveBudgetForAudioSec(windowSec)

  const fallback = async (why: 'timeout' | 'geometry', ms: number | undefined): Promise<LiveDiarizeOutcome> => {
    cleanup()
    counters[why === 'timeout' ? 'fallbackTimeout' : 'fallbackGeometry']++
    log(`[mac-window] chunk #${input.chunkIndex} window ${windowSec.toFixed(1)}s fallback=${why}${ms !== undefined ? ` after ${ms} ms` : ''} (budget ${timeoutMs} ms) -> per-chunk run, no window state committed`)
    return input.diarizeChunk(chunkPath)
  }

  const go = async (): Promise<LiveDiarizeOutcome> => {
    let outcome: LiveDiarizeOutcome
    try { outcome = await input.diarizeWindow(wavPath, timeoutMs) } finally { cleanup() }
    noteWindowRun(input.sessionId, !outcome.ok && outcome.reason === 'timeout', log)
    if (!outcome.ok) return outcome.reason === 'timeout' ? fallback('timeout', outcome.ms) : outcome
    let crossed = cross(outcome.run, null, plan)
    if (!crossed) return fallback('geometry', undefined)
    let alone = 'none'
    if (crossed.stats.carried > 0) {
      // A carried slot is used only if this chunk, diarized alone, agrees with it.
      const solo = existsSync(chunkPath) ? await input.diarizeChunk(chunkPath) : { ok: false as const, reason: 'error' as const }
      alone = solo.ok ? 'ok' : solo.reason
      if (!solo.ok) counters.agreementUnavailable++
      crossed = cross(outcome.run, solo.ok ? solo.run : null, plan)
      if (!crossed) return fallback('geometry', undefined)
    }
    result = crossed
    const s: MacWindowStats = crossed.stats
    counters.runs++
    for (const key of ['carried', 'withheld', 'created', 'confirmed', 'evicted', 'capped'] as const) counters[key] += s[key]
    log(`[mac-window] chunk #${input.chunkIndex} window ${plan.chunks.length} chunks ${windowSec.toFixed(1)}s ${Math.round(outcome.run.wallMs ?? 0)} ms overlap=${s.overlapChunks} carried=${s.carried} withheld=${s.withheld} created=${s.created} confirmed=${s.confirmed} evicted=${s.evicted} capped=${s.capped} tracks=${crossed.state.tracks.length} voices=${crossed.state.voices} alone=${alone}`)
    return { ok: true, run: { ...outcome.run, frames: crossed.chunkActivity.frames, probs: crossed.chunkActivity.probs } }
  }
  const diarize = go().catch((error): LiveDiarizeOutcome => {
    cleanup()
    return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) }
  })
  return { diarize, result: () => result }
}
