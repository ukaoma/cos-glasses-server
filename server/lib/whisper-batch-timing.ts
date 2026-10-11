import type { WhisperWord } from './whisper-local.js'

/** Canary-only until human-corrected meeting/fact and native contention gates pass.
 * Live HTTP keeps compact JSON; interactive HQ and DTW are unchanged. */
export function batchTimestampCanaryEnabled(): boolean {
  return process.env.COS_BATCH_HQ_TIMESTAMPS === '1'
}

export interface VadTimeSegment {
  originalStart: number
  originalEnd: number
  processedStart: number
  processedEnd: number
}

/** Read the mapping emitted by the SAME native decode, rather than run a second
 * VAD with potentially different weights, padding or thresholds. whisper.cpp
 * 1.9.1/1.9.5 emit this centisecond table, even though CLI -ojf token offsets
 * still use the compressed clock. Unknown/truncated diagnostics fail closed. */
export function parseNativeVadTimeline(stderr: string): VadTimeSegment[] {
  const count = [...stderr.matchAll(/^whisper_vad: detected (\d+) speech segments\s*$/gm)]
  const reduced = [...stderr.matchAll(/^whisper_vad: Reduced audio from (\d+) to (\d+) samples .+$/gm)]
  const rows = [...stderr.matchAll(/^whisper_vad: vad_segment_info: orig_start: ([\d.]+), orig_end: ([\d.]+), vad_start: ([\d.]+), vad_end: ([\d.]+)\s*$/gm)]
  if (count.length !== 1 || reduced.length !== 1 || rows.length !== Number(count[0][1]) || !rows.length) {
    throw new Error('HQ VAD timing evidence missing or incomplete')
  }
  const duration = Number(reduced[0][1]) / 16000
  const processedDuration = Number(reduced[0][2]) / 16000
  const table = rows.map(row => ({
    originalStart: Number(row[1]), originalEnd: Number(row[2]),
    processedStart: Number(row[3]), processedEnd: Number(row[4]),
  }))
  for (let i = 0; i < table.length; i++) {
    const s = table[i], prior = table[i - 1]
    if (!Object.values(s).every(Number.isFinite)
      || s.originalStart < 0 || s.processedStart < 0
      || s.originalEnd <= s.originalStart || s.processedEnd <= s.processedStart
      // Silero's final speech padding can extend the reported original end
      // beyond the last sample by up to 30 ms (+ centisecond rounding).
      || s.originalEnd > duration + 0.041 || s.processedEnd > processedDuration + 0.011
      || (i === 0 && s.processedStart !== 0)
      || (prior && (s.originalStart < prior.originalEnd || s.processedStart <= prior.processedEnd))) {
      throw new Error('HQ VAD timing evidence inconsistent')
    }
  }
  if (Math.abs(table.at(-1)!.processedEnd - processedDuration) > 0.011) {
    throw new Error('HQ VAD timing evidence does not cover the decoded audio')
  }
  table.at(-1)!.originalEnd = Math.min(table.at(-1)!.originalEnd, duration)
  return table
}

/** Replica of whisper_map_token_time_segment_aware. A token in an inserted gap
 * snaps to the nearest speech boundary; a linear map through the gap would put
 * words into silence. The native table already includes overlap and padding. */
export function mapVadTime(time: number, table: readonly VadTimeSegment[]): number {
  if (!Number.isFinite(time) || time < 0 || !table.length) throw new Error('Invalid HQ word clock')
  if (time <= table[0].processedStart) return table[0].originalStart
  if (time >= table.at(-1)!.processedEnd) return table.at(-1)!.originalEnd
  for (let i = 0; i < table.length; i++) {
    const s = table[i], next = table[i + 1]
    if (time >= s.processedStart && time <= s.processedEnd) {
      return s.originalStart + (time - s.processedStart) *
        (s.originalEnd - s.originalStart) / (s.processedEnd - s.processedStart)
    }
    if (next && time > s.processedEnd && time < next.processedStart) {
      return time <= (s.processedEnd + next.processedStart) / 2 ? s.originalEnd : next.originalStart
    }
  }
  throw new Error('Unmapped HQ word clock')
}

export function remapBatchWords(words: readonly WhisperWord[], stderr: string, useVad: boolean): WhisperWord[] {
  // VAD-empty CLI output is a normal empty array, not a request for a new decode.
  if (!words.length) return []
  const table = useVad ? parseNativeVadTimeline(stderr) : []
  return words.map(word => {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end)
      || word.start < 0 || word.end < 0) throw new Error('Invalid HQ word clock')
    const start = useVad ? mapVadTime(word.start, table) : word.start
    // Match whisper.cpp's mapped t1 getter: token heuristics can emit t1 < t0.
    // A zero-duration token is not evidence of a precisely timed spoken word.
    const end = Math.max(start, useVad ? mapVadTime(word.end, table) : word.end)
    return { ...word, start, end }
  })
}
