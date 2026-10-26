// 6.93.0: the I/O half of live Mac window replay (mac-window-voices.ts is the pure half).
//
// Reads the durable raw chunks the route already wrote, joins the planned window
// into one private temp WAV, runs the injected diarizer once inside its usual
// budget, removes the temp WAV, and crosswalks. Any failure is the normal live
// fallback (today's `Ext`); nothing here throws into the chunk route.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NEMOTRON_TMP_PREFIX, trackNemotronDir, untrackNemotronDir } from './nemotron-cli.js'
import { pcm16ToWav, readPcm16Mono } from './nemotron-segments.js'
import type { LiveDiarizeOutcome } from './nemotron-live.js'
import { isVoiceLabel } from './mac-voice-labels.js'
import {
  crosswalkMacWindow,
  emptyMacWindowVoices,
  planMacWindow,
  validMacWindowVoices,
  type MacWindowResult,
  type MacWindowVoiceState,
} from './mac-window-voices.js'

interface LabeledChunk { speaker?: unknown; segments?: Array<{ speaker?: unknown }> }

/**
 * The state this capture may continue from, or null to withhold window labels.
 * Corrupt state stays as it is (never replaced by a fresh start). A capture that
 * already shows Voice labels without window state (switch flipped mid-capture, or
 * an older server) never restarts numbering at Voice 1.
 */
export function macWindowStateFor(saved: unknown, chunks: ReadonlyArray<LabeledChunk | null | undefined>): MacWindowVoiceState | null {
  if (saved !== undefined) return validMacWindowVoices(saved) ? saved : null
  if (chunks.some(c => isVoiceLabel(c?.speaker) || c?.segments?.some(s => isVoiceLabel(s?.speaker)))) return null
  return emptyMacWindowVoices()
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
 */
export function startMacWindowDiarize(input: {
  sessionDir: string
  chunkIndex: number
  audio: Buffer
  audioSha256: string
  state: MacWindowVoiceState
  diarize: (wavPath: string) => Promise<LiveDiarizeOutcome>
  tmpRoot?: string
}): MacWindowJob | null {
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
  const cleanup = () => { untrackNemotronDir(work); try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ } }
  let result: MacWindowResult | null = null
  let run: Promise<LiveDiarizeOutcome>
  try { run = input.diarize(wavPath) } catch { cleanup(); return null }
  const diarize = run.then((outcome): LiveDiarizeOutcome => {
    if (!outcome.ok) return outcome
    let crossed: MacWindowResult | null = null
    try { crossed = crosswalkMacWindow({ state: input.state, window: outcome.run, plan, audioSha256: input.audioSha256 }) } catch { crossed = null }
    if (!crossed) return { ok: false, reason: 'bad_output', detail: 'mac_window_geometry', ms: outcome.run.wallMs }
    result = crossed
    return { ok: true, run: { ...outcome.run, frames: crossed.chunkActivity.frames, probs: crossed.chunkActivity.probs } }
  }).finally(cleanup)
  return { diarize, result: () => result }
}
