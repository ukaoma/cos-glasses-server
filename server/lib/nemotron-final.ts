// The final transcript: one Nemotron pass over the whole meeting at save time.
//
// Live chunks are diarized one at a time, so a chunk's Nemotron channels mean
// nothing in the next chunk. Run once over the meeting, the channels are
// consistent for the whole call, and the canary's method maps each to a name:
//   1. place every chunk WAV at its real `elapsed` on one timeline (join
//      chunkEntries[].chunkIndex to chunk_NNNN.wav, check audioSha256, trim only
//      the tail that would run into the next chunk);
//   2. score the raw 10 ms probabilities at 0.5, 8 channels;
//   3. a channel takes a name only from chunks the voiceprint is sure of
//      (similarity >= 0.65, a real name, one-sided by Even Hub, or by Nemotron
//      itself when the chunk has no Even Hub histogram), with at least
//      FINAL_MIN_SUPPORT such chunks and FINAL_PURITY of them agreeing. A channel
//      two people share stays unmapped.
// Every word then takes its channel's name, or keeps its per-chunk name (the
// live segment it sat in, else its existing label) where the channel is unmapped.
//
// SAFETY. Only labels change. The saved transcript's words are relabelled in
// place (never regenerated and re-cleaned), and nothing is written unless the
// result holds exactly the same words, in the same order. The original
// labels stay recoverable: every changed batch word carries `originalSpeaker`,
// every changed chunk carries `originalSpeaker`, and the sidecar keeps the whole
// pre-relabel transcript under `diarization.originalTranscript`. Any failure
// leaves the meeting exactly as it was saved. A human correction always wins:
// a sidecar with correctionRevision > 0 is never relabelled.
//
// No LLM anywhere. Transcription must never call `claude -p`.

import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { selectBatchTranscriptForPersistence } from './batch-transcript-quality.js'
import {
  NEMOTRON_BUNDLE,
  NEMOTRON_VARIANT,
  activeDiarizer,
  nemotronCliPath,
  prepareNemotronModelsDir,
} from './diarizer-backend.js'
import { CONFIDENT_SIMILARITY, isUnattributed } from './meeting-speaker-review.js'
import { getOwnerSpeakerLabel } from './profile.js'
import { OWNER_VERIFY_SIMILARITY } from './voiceprint-floor.js'
import {
  NEMOTRON_TMP_PREFIX,
  NemotronRunError,
  runNemotronCli,
  trackNemotronDir,
  untrackNemotronDir,
  type NemotronPreds,
  type RunNemotronOptions,
} from './nemotron-cli.js'
import type { ChunkSpeakerSegment } from './nemotron-live.js'
import {
  channelForSpan,
  estimateTokenTimes,
  frameRange,
  isActive,
  isWordToken,
  readPcm16Mono,
  splitTokens,
  tokenTimesFromWords,
  tracksIn,
  type Activity,
  type TokenTime,
  wavHeader,
} from './nemotron-segments.js'
import { captureSpeakerMode, type SpeakerMode } from './meeting-speaker-policy.js'
import { isMacCaptureSidecar, isVoiceLabel, macVoiceLabelsEnabled, voiceLabel } from './mac-voice-labels.js'
import { NEMOTRON_CHANNELS } from './nemotron-cli.js'
import type { WhisperWord } from './whisper-local.js'

/** A name is evidence only from a chunk the voiceprint was sure of: the review panel's own floor. */
export const FINAL_MIN_SIMILARITY = CONFIDENT_SIMILARITY
export const FINAL_ONE_SIDED = 0.8
export const FINAL_MIN_SUPPORT = 3
export const FINAL_PURITY = 0.8
/** The canary's eligibility for a meeting-wide map: at most this many identities... */
export const FINAL_MAX_IDENTITIES = 4
/** ...and fewer channels in use than Nemotron has, or two people already share one. */
export const FINAL_MAX_CHANNELS = NEMOTRON_CHANNELS
/** A timeline longer than this many times the audio it holds (plus slack) is a bad clock, not a meeting. */
export const FINAL_MAX_SPAN_RATIO = 1.5
export const FINAL_SPAN_SLACK_SEC = 600
const SR = 16_000
const WAV_HEADER = 44

interface EvenRole { frames?: number; self?: number; other?: number }

export interface SidecarChunk {
  text: string
  speaker: string
  elapsed: number
  similarity: number
  speakerPolicy?: SpeakerMode
  words?: WhisperWord[]
  segments?: ChunkSpeakerSegment[]
  evenHubSpeakerRole?: EvenRole
  audioSha256?: string
  originalSpeaker?: string
  finalSegments?: ChunkSpeakerSegment[]
  [key: string]: unknown
}

export interface SidecarEntry { chunkIndex: number; chunk: SidecarChunk }

export interface SpeakerWord {
  word: string
  start: number
  end: number
  speaker: string
  similarity: number
  originalSpeaker?: string
  [key: string]: unknown
}

export interface SidecarBatchSegment {
  startChunkIdx: number
  endChunkIdx: number
  startElapsed: number
  endElapsed: number
  text: string
  words?: WhisperWord[]
  speakerWords: SpeakerWord[]
}

export interface TimelineWindow {
  chunkIndex: number
  /** Seconds on the meeting timeline. */
  start: number
  end: number
  chunk: SidecarChunk
}

export interface MeetingTimeline {
  /** A complete 16 kHz mono WAV. */
  wav: Buffer
  durationSec: number
  windows: TimelineWindow[]
  byIndex: Map<number, TimelineWindow>
  /** PCM samples each chunk file holds as concatenateWavChunks reads it (bytes after a 44-byte header). */
  fileSamples: Map<number, number>
  excluded: { missing: number; hashMismatch: number; unreadable: number }
  /** Seconds of chunk audio placed on the timeline. */
  audioSec: number
  /** True when the span is far beyond the audio: no WAV was built. */
  tooLong: boolean
}

const chunkFile = (audioDir: string, index: number): string => join(audioDir, `chunk_${String(index).padStart(4, '0')}.wav`)

/** lstat, so a symlink or a FIFO in the audio directory is never read. */
function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile() } catch { return false }
}

/** Samples concatenateWavChunks reads from a chunk file: everything after a 44-byte header, if it is RIFF. */
function concatSamples(path: string): number | null {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size <= WAV_HEADER) return null
    const size = stat.size
    // Non-blocking and no symlinks: a FIFO planted in its place must never hang the server.
    const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW)
    try {
      const head = Buffer.alloc(4)
      readSync(fd, head, 0, 4, 0)
      return head.toString('ascii') === 'RIFF' ? Math.floor((size - WAV_HEADER) / 2) : null
    } finally { closeSync(fd) }
  } catch {
    return null
  }
}

/**
 * The canary's timeline: each WAV at its real elapsed, only the overlapping tail
 * trimmed. Two passes so that only the timeline itself is held in memory (a
 * 90-minute meeting is about 170 MB of 16-bit audio): the first checks every
 * chunk and keeps its place, the second copies its audio in.
 */
/** Give the event loop back every this many chunks while the timeline is built. */
const TIMELINE_YIELD_EVERY = 25
const yieldToLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/**
 * Async and chunked (QA 6.61.0, N7): reads are non-blocking and the loop is given
 * back every TIMELINE_YIELD_EVERY chunks, so a long meeting's timeline does not
 * freeze live chunk uploads while it is built.
 *
 * Returns `tooLong` instead of a timeline when the span the clocks claim is far
 * beyond the audio the chunks hold (QA W5: one chunk stamped three hours late
 * made a 346 MB timeline out of 12 s of audio). Nothing is allocated then.
 */
export async function buildMeetingTimeline(entries: SidecarEntry[], audioDir: string): Promise<MeetingTimeline> {
  const excluded = { missing: 0, hashMismatch: 0, unreadable: 0 }
  const fileSamples = new Map<number, number>()
  const indices = entries.map(entry => entry.chunkIndex)
  const maxIndex = indices.length ? Math.max(...indices) : -1
  for (let index = 0; index <= maxIndex; index++) {
    const samples = concatSamples(chunkFile(audioDir, index))
    if (samples !== null) fileSamples.set(index, samples)
  }
  const placed: Array<{ entry: SidecarEntry; at: number; samples: number; dataOffset: number }> = []
  let seen = 0
  for (const entry of entries) {
    if (++seen % TIMELINE_YIELD_EVERY === 0) await yieldToLoop()
    const path = chunkFile(audioDir, entry.chunkIndex)
    if (!existsSync(path)) { excluded.missing++; continue }
    if (!isRegularFile(path)) { excluded.unreadable++; continue }
    let wav: Buffer
    try { wav = await readFile(path) } catch { excluded.unreadable++; continue }
    const expected = entry.chunk.audioSha256
    if (expected && createHash('sha256').update(wav).digest('hex') !== expected) { excluded.hashMismatch++; continue }
    const pcm = readPcm16Mono(wav)
    if (!pcm || pcm.sampleRate !== SR || !Number.isFinite(entry.chunk.elapsed)) { excluded.unreadable++; continue }
    placed.push({ entry, at: Math.max(0, Math.round((entry.chunk.elapsed / 1000) * SR)), samples: pcm.pcm.length / 2, dataOffset: pcm.pcm.byteOffset - wav.byteOffset })
  }
  placed.sort((x, y) => x.at - y.at || x.entry.chunkIndex - y.entry.chunkIndex)
  let total = 0
  let audio = 0
  for (const item of placed) { total = Math.max(total, item.at + item.samples); audio += item.samples }
  total += SR
  const empty = { wav: Buffer.alloc(0), windows: [], byIndex: new Map<number, TimelineWindow>(), fileSamples, excluded }
  if (total / SR > (audio / SR) * FINAL_MAX_SPAN_RATIO + FINAL_SPAN_SLACK_SEC) {
    return { ...empty, durationSec: total / SR, audioSec: audio / SR, tooLong: true }
  }
  const out = Buffer.alloc(WAV_HEADER + total * 2)
  wavHeader(total * 2, SR).copy(out, 0)
  const windows: TimelineWindow[] = []
  for (let i = 0; i < placed.length; i++) {
    if ((i + 1) % TIMELINE_YIELD_EVERY === 0) await yieldToLoop()
    const item = placed[i]
    const next = i + 1 < placed.length ? placed[i + 1].at : item.at + item.samples
    const room = Math.max(0, next - item.at)
    const use = Math.min(item.samples, room)
    let copied = 0
    try {
      if (!isRegularFile(chunkFile(audioDir, item.entry.chunkIndex))) throw new Error('not a regular file')
      const wav = await readFile(chunkFile(audioDir, item.entry.chunkIndex))
      copied = wav.copy(out, WAV_HEADER + item.at * 2, item.dataOffset, Math.min(wav.length, item.dataOffset + use * 2)) / 2
    } catch { /* vanished between passes: its window stays silent */ }
    windows.push({ chunkIndex: item.entry.chunkIndex, start: item.at / SR, end: (item.at + Math.floor(copied)) / SR, chunk: item.entry.chunk })
  }
  return {
    wav: out,
    durationSec: total / SR,
    audioSec: audio / SR,
    tooLong: false,
    windows,
    byIndex: new Map(windows.map(window => [window.chunkIndex, window])),
    fileSamples,
    excluded,
  }
}

/** Too full for one meeting-wide map: more than four identities, or every channel in use. */
export function isCrowded(identities: number, channelsUsed: number): boolean {
  return identities > FINAL_MAX_IDENTITIES || channelsUsed >= FINAL_MAX_CHANNELS
}

/** Names with at least three chunks the voiceprint is sure of: the canary's identity count. */
export function crowdIdentities(windows: TimelineWindow[]): number {
  const counts = new Map<string, number>()
  for (const window of windows) {
    const chunk = window.chunk
    if (isName(chunk.speaker) && Number(chunk.similarity) >= FINAL_MIN_SIMILARITY) counts.set(chunk.speaker, (counts.get(chunk.speaker) ?? 0) + 1)
  }
  return [...counts.values()].filter(count => count >= FINAL_MIN_SUPPORT).length
}

function ownerLabelOrNull(): string | null {
  try { return getOwnerSpeakerLabel() } catch { return null }
}

function isName(label: unknown): label is string {
  return typeof label === 'string' && !isUnattributed(label.trim())
}

export interface ChannelMapping {
  map: Map<number, string>
  evidence: Array<{ channel: number; name: string | null; support: number; purity: number; top: string | null }>
  eligible: number
}

/** The canary's dominant-channel map, made many-to-one with a purity floor. */
export function mapChannelsToNames(windows: TimelineWindow[], a: Activity, options: {
  minSimilarity?: number
  oneSided?: number
  minSupport?: number
  purity?: number
} = {}): ChannelMapping {
  const minSimilarity = options.minSimilarity ?? FINAL_MIN_SIMILARITY
  const oneSided = options.oneSided ?? FINAL_ONE_SIDED
  const minSupport = options.minSupport ?? FINAL_MIN_SUPPORT
  const purity = options.purity ?? FINAL_PURITY
  const tallies = new Map<number, Map<string, number>>()
  let eligible = 0
  for (const window of windows) {
    const chunk = window.chunk
    if (!isName(chunk.speaker) || !(Number(chunk.similarity) >= minSimilarity)) continue
    const [f0, f1] = frameRange(a, window.start, window.end)
    const counts = new Array<number>(NEMOTRON_CHANNELS).fill(0)
    let speech = 0
    for (let f = f0; f < f1; f++) {
      let any = false
      for (let c = 0; c < NEMOTRON_CHANNELS; c++) if (isActive(a, f, c)) { counts[c]++; any = true }
      if (any) speech++
    }
    if (speech === 0) continue
    let dom = 0
    for (let c = 1; c < NEMOTRON_CHANNELS; c++) if (counts[c] > counts[dom]) dom = c
    const role = chunk.evenHubSpeakerRole
    const frames = Number(role?.frames ?? 0)
    const sided = frames > 0
      ? Math.max(Number(role?.self ?? 0), Number(role?.other ?? 0)) / frames >= oneSided
      : counts[dom] / speech >= oneSided
    if (!sided) continue
    eligible++
    const tally = tallies.get(dom) ?? new Map<string, number>()
    tally.set(chunk.speaker, (tally.get(chunk.speaker) ?? 0) + 1)
    tallies.set(dom, tally)
  }
  const map = new Map<number, string>()
  const evidence: ChannelMapping['evidence'] = []
  for (const [channel, tally] of [...tallies.entries()].sort((x, y) => x[0] - y[0])) {
    let top: string | null = null
    let topCount = 0
    let support = 0
    for (const [name, count] of tally) {
      support += count
      if (count > topCount || (count === topCount && top !== null && name < top)) { top = name; topCount = count }
    }
    const share = support ? topCount / support : 0
    const accepted = top !== null && support >= minSupport && share >= purity
    if (accepted) map.set(channel, top!)
    evidence.push({ channel, name: accepted ? top : null, support, purity: Math.round(share * 1000) / 1000, top })
  }
  return { map, evidence, eligible }
}

/** The live segment that held chunk-relative time t, else null. */
/**
 * 6.61.1 owner guard for per-chunk names. 6.61.0 named split tracks as the wearer
 * from the glasses' default label (similarity 0) or a weak search match
 * (0.55 to 0.65). In a chunk with more than one live turn, the wearer's name
 * counts only at owner-verify confidence; otherwise it is Ext. A one-turn chunk
 * keeps its label exactly as 6.60.0 gave it.
 */
export function guardOwnerName(name: string, similarity: unknown, chunk: SidecarChunk, owner: string | null | undefined): string {
  if (!owner || name !== owner) return name
  const split = Array.isArray(chunk.segments) && chunk.segments.length > 1
  if (!split) return name
  return Number(similarity) >= OWNER_VERIFY_SIMILARITY ? name : 'Ext'
}

function liveSpeakerAt(chunk: SidecarChunk, t: number, owner?: string | null): string | null {
  const segments = chunk.segments
  if (!Array.isArray(segments) || segments.length === 0) return null
  let best: ChunkSpeakerSegment | null = null
  let distance = Number.POSITIVE_INFINITY
  for (const segment of segments) {
    const s = Number(segment.startSec)
    const e = Number(segment.endSec)
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue
    const d = t < s ? s - t : t > e ? t - e : 0
    if (d < distance) { distance = d; best = segment }
  }
  return best && typeof best.speaker === 'string' ? guardOwnerName(best.speaker, best.similarity, chunk, owner) : null
}

export interface RelabelStats {
  total: number
  /** Words whose label changed. */
  relabeled: number
  /** Words labelled through a mapped channel. */
  viaChannel: number
  /** Words whose channel was unmapped or silent, kept on their per-chunk name. */
  kept: number
}

/** Word times in a batch segment are relative to its concatenated chunk files. Put them on the timeline. */
export function batchWordToTimeline(segment: SidecarBatchSegment, t: number, timeline: MeetingTimeline): { window: TimelineWindow; inChunk: number; at: number } | null {
  let offset = 0
  let lastWindow: { window: TimelineWindow; inChunk: number; at: number } | null = null
  for (let index = segment.startChunkIdx; index <= segment.endChunkIdx; index++) {
    const samples = timeline.fileSamples.get(index)
    if (samples === undefined) continue
    const length = samples / SR
    const window = timeline.byIndex.get(index)
    if (t < offset + length || index === segment.endChunkIdx) {
      if (!window) return null
      const inChunk = Math.max(0, t - offset)
      const span = Math.max(0, window.end - window.start - 0.005)
      return { window, inChunk, at: window.start + Math.min(inChunk, span) }
    }
    if (window) lastWindow = { window, inChunk: length, at: window.end - 0.005 }
    offset += length
  }
  return lastWindow
}

export function relabelBatchSegments(
  segments: SidecarBatchSegment[],
  timeline: MeetingTimeline,
  a: Activity,
  map: Map<number, string>,
  owner?: string | null,
): { segments: SidecarBatchSegment[]; stats: RelabelStats } {
  const stats: RelabelStats = { total: 0, relabeled: 0, viaChannel: 0, kept: 0 }
  const out = segments.map(segment => ({
    ...segment,
    speakerWords: (segment.speakerWords ?? []).map(word => {
      stats.total++
      const original = typeof word.originalSpeaker === 'string' ? word.originalSpeaker : word.speaker
      const start = batchWordToTimeline(segment, Number(word.start), timeline)
      const end = batchWordToTimeline(segment, Number(word.end), timeline)
      // Existing live anonymous turns are established capture evidence. A
      // meeting-wide channel may refine unknown speech, never overwrite them.
      const live = start ? liveSpeakerAt(start.window.chunk, start.inChunk, owner) : null
      let name: string | null = isVoiceLabel(live) ? live : null
      if (name === null && start) {
        const channel = channelForSpan(a, start.at, Math.max(start.at, end?.window === start.window ? end.at : start.at + 0.01))
        if (channel !== null && map.has(channel)) { name = map.get(channel)!; stats.viaChannel++ }
      }
      if (isVoiceLabel(live)) stats.kept++
      if (name === null) {
        stats.kept++
        name = live
          ?? (start ? guardOwnerName(original, start.window.chunk.similarity, start.window.chunk, owner) : original)
      }
      if (name !== word.speaker) stats.relabeled++
      const next: SpeakerWord = { ...word, speaker: name }
      if (name !== original) next.originalSpeaker = original
      else delete next.originalSpeaker
      return next
    }),
  }))
  return { segments: out, stats }
}

/** Token times for a streaming chunk, chunk-relative seconds. */
function streamingTokenTimes(chunk: SidecarChunk, tokens: string[], window: TimelineWindow, a: Activity): TokenTime[] | null {
  if (Array.isArray(chunk.words) && chunk.words.length) {
    const fromWords = tokenTimesFromWords(tokens, chunk.words)
    if (fromWords) return fromWords
  }
  const shift = (times: TokenTime[] | null): TokenTime[] | null => times && times.map(time => ({ start: time.start - window.start, end: time.end - window.start }))
  const segments = Array.isArray(chunk.segments) ? chunk.segments : []
  const counts = segments.map(segment => splitTokens(String(segment.text ?? '')).length)
  if (segments.length && counts.reduce((sum, n) => sum + n, 0) === tokens.length && segments.map(s => s.text).join(' ') === chunk.text) {
    const out: TokenTime[] = []
    let from = 0
    for (let i = 0; i < segments.length; i++) {
      const piece = tokens.slice(from, from + counts[i])
      const s = window.start + Number(segments[i].startSec ?? 0)
      const e = window.start + Number(segments[i].endSec ?? (window.end - window.start))
      const times = shift(estimateTokenTimes(piece, a, s, Math.max(s + 0.01, e)))
        ?? piece.map(() => ({ start: s - window.start, end: e - window.start }))
      out.push(...times)
      from += counts[i]
    }
    return out
  }
  return shift(estimateTokenTimes(tokens, a, window.start, window.end))
}

export function relabelStreamingChunks(
  timeline: MeetingTimeline,
  a: Activity,
  map: Map<number, string>,
  owner?: string | null,
): { finals: Map<number, { speaker: string; segments: ChunkSpeakerSegment[] }>; stats: RelabelStats } {
  const stats: RelabelStats = { total: 0, relabeled: 0, viaChannel: 0, kept: 0 }
  const finals = new Map<number, { speaker: string; segments: ChunkSpeakerSegment[] }>()
  for (const window of timeline.windows) {
    const chunk = window.chunk
    if (typeof chunk.text !== 'string' || !chunk.text.trim()) continue
    const tokens = splitTokens(chunk.text)
    const times = streamingTokenTimes(chunk, tokens, window, a)
    const base = guardOwnerName(typeof chunk.originalSpeaker === 'string' ? chunk.originalSpeaker : chunk.speaker, chunk.similarity, chunk, owner)
    const labels: string[] = []
    const liveTokens = (chunk.segments ?? []).flatMap(segment => splitTokens(String(segment.text ?? '')).map(token => ({ token, speaker: segment.speaker })))
    const exactLive = liveTokens.length === tokens.length && liveTokens.every((part, i) => part.token === tokens[i]) ? liveTokens : null
    let carry: string | null = null
    for (let i = 0; i < tokens.length; i++) {
      const established = exactLive?.[i].speaker
      if (!isWordToken(tokens[i]) || !times) { labels.push(isVoiceLabel(established) ? established! : carry ?? liveSpeakerAt(chunk, 0, owner) ?? base); continue }
      stats.total++
      const span = times[i]
      const channel = channelForSpan(a, window.start + span.start, window.start + Math.max(span.end, span.start + 0.01))
      let name: string
      const live = isVoiceLabel(established) ? established! : liveSpeakerAt(chunk, span.start, owner)
      if (isVoiceLabel(live)) { name = live!; stats.kept++ }
      else if (channel !== null && map.has(channel)) { name = map.get(channel)!; stats.viaChannel++ }
      else { name = live ?? base; stats.kept++ }
      labels.push(name)
      carry = name
    }
    const segments: ChunkSpeakerSegment[] = []
    for (let i = 0; i < tokens.length; i++) {
      const last = segments.at(-1)
      if (last && last.speaker === labels[i]) { last.text += ` ${tokens[i]}`; if (times) last.endSec = Math.round(times[i].end * 100) / 100; continue }
      segments.push({
        speaker: labels[i],
        text: tokens[i],
        ...(times ? { startSec: Math.round(times[i].start * 100) / 100, endSec: Math.round(times[i].end * 100) / 100 } : {}),
      })
    }
    const wordsBy = new Map<string, number>()
    for (const segment of segments) wordsBy.set(segment.speaker, (wordsBy.get(segment.speaker) ?? 0) + splitTokens(segment.text).filter(isWordToken).length)
    let speaker = chunk.speaker
    let most = -1
    for (const [name, count] of wordsBy) if (count > most) { most = count; speaker = name }
    const liveLabels = Array.isArray(chunk.segments) && chunk.segments.length
      ? chunk.segments.flatMap(segment => splitTokens(String(segment.text ?? '')).map(() => segment.speaker))
      : tokens.map(() => chunk.speaker)
    for (let i = 0; i < tokens.length; i++) if (isWordToken(tokens[i]) && labels[i] !== (liveLabels[i] ?? chunk.speaker)) stats.relabeled++
    finals.set(window.chunkIndex, { speaker, segments })
  }
  return { finals, stats }
}

const LABEL_PREFIX = /^\[[^\]\n]+\]:\s*/

/** The words of a transcript with speaker labels removed. Gap markers stay words. */
export function transcriptWords(transcript: string): string[] {
  return transcript.split('\n').flatMap(line => line.replace(LABEL_PREFIX, '').split(/\s+/).filter(Boolean))
}

export function sameWords(before: string, after: string): boolean {
  const x = transcriptWords(before)
  const y = transcriptWords(after)
  return x.length === y.length && x.every((word, i) => word === y[i])
}

/** Re-render a streaming transcript: each `[X]: text` line that is exactly one chunk's text becomes that chunk's final turns. */
export function relabelStreamingTranscript(
  transcript: string,
  chunksInOrder: Array<{ chunkIndex: number; text: string }>,
  finals: Map<number, { speaker: string; segments: ChunkSpeakerSegment[] }>,
): string {
  const out: string[] = []
  let pointer = 0
  for (const line of transcript.split('\n')) {
    const match = /^\[([^\]\n]+)\]: ([\s\S]*)$/.exec(line)
    if (!match) { out.push(line); continue }
    let found = -1
    for (let k = pointer; k < Math.min(chunksInOrder.length, pointer + 8); k++) {
      if (chunksInOrder[k].text === match[2]) { found = k; break }
    }
    if (found < 0) { out.push(line); continue }
    pointer = found + 1
    const final = finals.get(chunksInOrder[found].chunkIndex)
    if (!final) { out.push(line); continue }
    for (const segment of final.segments) out.push(`[${segment.speaker}]: ${segment.text}`)
  }
  return out.join('\n')
}

/**
 * Relabel a transcript that is already on disk, word by word, without touching a
 * word. The saved batch transcript is the speaker-words grouping AFTER cleaning
 * (URL-only lines dropped, negative rules applied), so regenerating it from the
 * relabelled words and cleaning again can change which words survive when the
 * groups change. Instead each transcript word is matched, in order, to the next
 * relabelled word with the same text (a small window, then a three-word anchor
 * to resynchronise past anything cleaning removed). A word with no match keeps
 * the turn it is in. Gap markers and other unlabelled lines are kept as they are.
 */
export function relabelTranscriptWords(transcript: string, sequence: Array<{ word: string; speaker: string }>): string {
  const WINDOW = 12
  const ANCHOR = 3
  const RESYNC = 600
  const lines = transcript.split('\n')
  const parsed = lines.map(line => {
    const match = /^\[([^\]\n]+)\]:\s*([\s\S]*)$/.exec(line)
    return match ? { speaker: match[1], words: match[2].split(/\s+/).filter(Boolean) } : null
  })
  const flat: string[] = parsed.flatMap(line => line?.words ?? [])
  const out: string[] = []
  let pointer = 0
  let flatIndex = 0
  for (let li = 0; li < lines.length; li++) {
    const line = parsed[li]
    if (!line) { out.push(lines[li]); continue }
    // Line breaks are kept (QA 6.61.0 W4): a line splits where its words change
    // speaker and is never merged with its neighbour, so a pass that changes no
    // label reproduces the transcript byte for byte.
    const turns: Array<{ speaker: string; words: string[] }> = []
    for (const word of line.words) {
      let speaker: string | null = null
      for (let k = pointer; k < Math.min(sequence.length, pointer + WINDOW); k++) {
        if (sequence[k].word === word) { speaker = sequence[k].speaker; pointer = k + 1; break }
      }
      if (speaker === null) {
        const anchor = flat.slice(flatIndex, flatIndex + ANCHOR)
        if (anchor.length === ANCHOR) {
          for (let k = pointer; k <= Math.min(sequence.length - ANCHOR, pointer + RESYNC); k++) {
            if (anchor.every((w, a) => sequence[k + a].word === w)) { speaker = sequence[k].speaker; pointer = k + 1; break }
          }
        }
      }
      if (speaker === null) speaker = turns.at(-1)?.speaker ?? line.speaker
      const turn = turns.at(-1)
      if (turn && turn.speaker === speaker) turn.words.push(word)
      else turns.push({ speaker, words: [word] })
      flatIndex++
    }
    if (turns.length === 1 && turns[0].speaker === line.speaker) { out.push(lines[li]); continue }
    for (const turn of turns) out.push(`[${turn.speaker}]: ${turn.words.join(' ')}`)
  }
  return out.join('\n')
}

const TRANSCRIPT_SECTION = /## Transcript\n\n([\s\S]*)$/

export function readTranscriptSection(markdown: string): string | null {
  const match = TRANSCRIPT_SECTION.exec(markdown)
  return match ? match[1].replace(/\n+$/, '') : null
}

/** Replace the transcript section and nothing else (the quality row stays as saved). */
export function replaceTranscriptSection(markdown: string, transcript: string): string | null {
  if (!TRANSCRIPT_SECTION.test(markdown)) return null
  return markdown.replace(TRANSCRIPT_SECTION, () => `## Transcript\n\n${transcript}\n`)
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

export type FinalPassStatus = 'applied' | 'skipped' | 'failed'

/**
 * Every reason a final pass can give, a fixed set. `/api/health` is public (no
 * token) and the server listens on the LAN, so health may carry only these codes
 * and counts: never a speaker name, a path, a meeting title or a raw error
 * message (QA 6.61.0 blocker). Anything else is reported as `error`, and the raw
 * text goes to server.log only.
 */
export const FINAL_REASON_CODES = [
  'embedding_requested', 'cli_missing', 'models_missing', 'meeting_missing', 'no_audio', 'human_corrected',
  'no_transcript', 'already_applied', 'no_chunks', 'nemotron_timeout', 'nemotron_cli_failed',
  'nemotron_bad_output', 'nemotron_spawn_failed', 'nemotron_error', 'no_speaker_words', 'chunk_map_ambiguous',
  'word_mismatch', 'no_change', 'changed_during_pass', 'markdown_write', 'sidecar_restore_failed', 'too_long',
  'metadata_not_persisted', 'speaker_policy', 'voices_crowded', 'voices_unconfident', 'error',
] as const
export type FinalReasonCode = typeof FINAL_REASON_CODES[number]
const REASON_SET: ReadonlySet<string> = new Set(FINAL_REASON_CODES)
export const finalReasonCode = (reason: string | undefined): FinalReasonCode | null =>
  reason === undefined ? null : REASON_SET.has(reason) ? reason as FinalReasonCode : 'error'

export interface FinalPassOutcome {
  status: FinalPassStatus
  reason?: string
  /** Raw failure text for server.log. Never published. */
  detail?: string
  mode?: 'batch' | 'streaming'
  /** True when the room was too full for a meeting-wide map (only per-chunk turns applied). */
  crowded?: boolean
  identities?: number
  ms?: number
  audioSec?: number
  channels?: number
  mapped?: Record<string, string>
  words?: RelabelStats
  /** Chunks left off the timeline: no file, a hash that disagrees, unreadable. */
  excluded?: { missing: number; hashMismatch: number; unreadable: number }
  /** Distinct speakers in the transcript before and after. */
  speakersBefore?: number
  speakersAfter?: number
  /** 6.90.0: a Mac recording labelled with unnamed `Voice N` turns (no profile was read). */
  unnamed?: boolean
  /** How many `Voice N` labels the meeting carries after an unnamed pass. */
  voices?: number
}

export interface FinalPassOptions {
  meetingPath: string
  sidecarPath: string
  audioDir: string
  env?: NodeJS.ProcessEnv
  home?: string
  run?: (options: RunNemotronOptions) => Promise<NemotronPreds & { loadSec?: number | null }>
  tmpRoot?: string
  log?: (line: string) => void
  now?: () => number
  /** The wearer's label, for the 6.61.1 owner guard (default: the profile's). */
  owner?: string | null
  /** Seam: how files are written (durable atomic by default). */
  write?: (path: string, data: string) => void
  /** Seam: the batch relabeller (word-aligned in place by default). */
  relabelWords?: (transcript: string, sequence: Array<{ word: string; speaker: string }>) => string
}

/** 20x realtime is the floor (the canary ran 155x), plus two minutes for a cold Neural Engine compile. */
export function finalPassTimeoutMs(durationSec: number): number {
  return 120_000 + Math.round((durationSec * 1000) / 20)
}

/** What `/api/health` may say about the last final pass: codes and counts only. */
export interface PublicFinalOutcome {
  status: FinalPassStatus
  reasonCode: FinalReasonCode | null
  mode: 'batch' | 'streaming' | null
  crowded: boolean | null
  channels: number | null
  mappedChannels: number | null
  wordsRelabeled: number | null
  wordsTotal: number | null
  excludedChunks: number | null
  ms: number | null
  at: string
}

let finalLane: Promise<unknown> = Promise.resolve()
let lastFinal: PublicFinalOutcome | null = null
const finalCounts: Record<string, number> = {}

export function publicFinalOutcome(outcome: FinalPassOutcome, at: string): PublicFinalOutcome {
  return {
    status: outcome.status,
    reasonCode: finalReasonCode(outcome.reason),
    mode: outcome.mode ?? null,
    crowded: typeof outcome.crowded === 'boolean' ? outcome.crowded : null,
    channels: typeof outcome.channels === 'number' ? outcome.channels : null,
    mappedChannels: outcome.mapped ? Object.keys(outcome.mapped).length : null,
    wordsRelabeled: outcome.words?.relabeled ?? null,
    wordsTotal: outcome.words?.total ?? null,
    excludedChunks: outcome.excluded ? outcome.excluded.missing + outcome.excluded.hashMismatch + outcome.excluded.unreadable : null,
    ms: typeof outcome.ms === 'number' ? outcome.ms : null,
    at,
  }
}

export function finalPassSnapshot(): { last: PublicFinalOutcome | null; counts: Record<string, number> } {
  return { last: lastFinal ? { ...lastFinal } : null, counts: { ...finalCounts } }
}

/** One meeting's final pass, serialised with every other final pass. Never throws. */
export function runNemotronFinalPass(options: FinalPassOptions): Promise<FinalPassOutcome> {
  const job = finalLane.then(() => finalPassNow(options)).catch((error): FinalPassOutcome => ({
    status: 'failed',
    reason: 'error',
    detail: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
  }))
  finalLane = job.then(() => undefined, () => undefined)
  return job.then(outcome => {
    const published = publicFinalOutcome(outcome, new Date((options.now ?? Date.now)()).toISOString())
    const key = outcome.status === 'applied' ? 'applied' : `${outcome.status}:${published.reasonCode ?? 'error'}`
    finalCounts[key] = (finalCounts[key] ?? 0) + 1
    lastFinal = published
    const log = options.log ?? console.log
    if (outcome.status === 'applied') {
      log(`[diarizer] final pass applied (${outcome.mode}${outcome.unnamed ? `, unnamed: ${outcome.voices} voices, no profile read` : ''}${outcome.crowded ? `, crowded: ${outcome.identities} identities, per-chunk turns only` : ''}) in ${outcome.ms} ms: ${outcome.channels} channels, mapped ${JSON.stringify(outcome.mapped)}, ${outcome.words?.relabeled}/${outcome.words?.total} words relabelled, speakers ${outcome.speakersBefore} -> ${outcome.speakersAfter}${excludedNote(outcome)}`)
    } else if (outcome.reason === 'sidecar_restore_failed') {
      log(`[diarizer] final pass FAILED and could not restore the sidecar: ${outcome.detail}`)
    } else {
      log(`[diarizer] final pass ${outcome.status}: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}${excludedNote(outcome)}; the saved transcript is unchanged`)
    }
    return outcome
  })
}

function excludedNote(outcome: FinalPassOutcome): string {
  const e = outcome.excluded
  if (!e || e.missing + e.hashMismatch + e.unreadable === 0) return ''
  return `; chunks left off the timeline: ${e.missing} missing, ${e.hashMismatch} hash mismatch, ${e.unreadable} unreadable`
}

/** A pass the caller decided not to run (the save path's metadata guard): counted and logged like any other. */
export function recordFinalPassSkip(reason: FinalReasonCode, detail: string, options: { log?: (line: string) => void; now?: () => number } = {}): void {
  const outcome: FinalPassOutcome = { status: 'skipped', reason, detail }
  const published = publicFinalOutcome(outcome, new Date((options.now ?? Date.now)()).toISOString())
  const key = `skipped:${published.reasonCode ?? 'error'}`
  finalCounts[key] = (finalCounts[key] ?? 0) + 1
  lastFinal = published
  ;(options.log ?? console.log)(`[diarizer] final pass skipped: ${reason} (${detail}); the saved transcript is unchanged`)
}

function distinctSpeakers(transcript: string): number {
  const names = new Set<string>()
  for (const line of transcript.split('\n')) {
    const match = /^\[([^\]\n]+)\]:/.exec(line)
    if (match) names.add(match[1])
  }
  return names.size
}

async function finalPassNow(options: FinalPassOptions): Promise<FinalPassOutcome> {
  const started = (options.now ?? Date.now)()
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const choice = activeDiarizer(env, home)
  if (choice.requested === 'embedding') return { status: 'skipped', reason: 'embedding_requested' }
  if (choice.fallback) return { status: 'skipped', reason: choice.fallback }
  if (!existsSync(options.sidecarPath) || !existsSync(options.meetingPath)) return { status: 'skipped', reason: 'meeting_missing' }
  if (!existsSync(options.audioDir)) return { status: 'skipped', reason: 'no_audio' }

  const sidecarText = readFileSync(options.sidecarPath, 'utf8')
  const sidecar = JSON.parse(sidecarText) as Record<string, any>
  const owner = options.owner !== undefined ? options.owner : ownerLabelOrNull()
  if (Number(sidecar.correctionRevision ?? 0) > 0) return { status: 'skipped', reason: 'human_corrected' }
  const markdown = readFileSync(options.meetingPath, 'utf8')
  const transcript = readTranscriptSection(markdown)
  if (transcript === null) return { status: 'skipped', reason: 'no_transcript' }
  if (sidecar.diarization?.status === 'applied' && sidecar.diarization?.outputSha256 === sha(transcript)) {
    return { status: 'skipped', reason: 'already_applied' }
  }
  const entries = (Array.isArray(sidecar.chunkEntries) ? sidecar.chunkEntries : []) as SidecarEntry[]
  if (!entries.length) return { status: 'skipped', reason: 'no_chunks' }
  // Final diarization builds meeting-wide channel/name maps. Earlier Standard
  // identities cannot safely authorize names for later strict-policy audio.
  // Preserve the canonical transcript (including earlier names) byte-for-byte.
  const sidecarChunks = (Array.isArray(sidecar.chunks) ? sidecar.chunks : []) as SidecarChunk[]
  let unnamed = false
  if (entries.some(entry => captureSpeakerMode(entry.chunk.speakerPolicy) !== 'standard')
    || sidecarChunks.some(chunk => captureSpeakerMode(chunk.speakerPolicy) !== 'standard')) {
    // 6.90.0: a Mac recording may still take UNNAMED voices (see unnamedVoicePass).
    // Every other strict capture keeps the 6.73.6 skip, byte for byte.
    if (!unnamedVoicesEligible(sidecar, entries, sidecarChunks, env)) return { status: 'skipped', reason: 'speaker_policy' }
    unnamed = true
  }

  const timeline = await buildMeetingTimeline(entries, options.audioDir)
  const excluded = timeline.excluded
  if (timeline.tooLong) {
    return { status: 'skipped', reason: 'too_long', excluded, detail: `timeline ${Math.round(timeline.durationSec)} s for ${Math.round(timeline.audioSec)} s of audio` }
  }
  if (!timeline.windows.length) return { status: 'skipped', reason: 'no_audio', excluded }

  const cli = nemotronCliPath(env, home)
  const modelsDir = prepareNemotronModelsDir(env, home)
  if (!cli || !modelsDir) return { status: 'skipped', reason: !cli ? 'cli_missing' : 'models_missing' }

  // Tracked, so a server exit mid-run kills the CLI and deletes this directory
  // (it holds the whole meeting's audio); a sweep at the next start catches a crash.
  const work = mkdtempSync(join(options.tmpRoot ?? tmpdir(), `${NEMOTRON_TMP_PREFIX}final-`))
  trackNemotronDir(work)
  let run: NemotronPreds
  try {
    try { chmodSync(work, 0o700) } catch { /* mkdtemp is already 0700 */ }
    const wavPath = join(work, 'meeting.wav')
    await writeFile(wavPath, timeline.wav, { mode: 0o600 })
    try {
      run = await (options.run ?? runNemotronCli)({
        cli,
        modelsDir,
        wavPath,
        timeoutMs: finalPassTimeoutMs(timeline.durationSec),
        computeUnits: 'ane',
        niceness: 10,
        tmpRoot: options.tmpRoot,
      })
    } catch (error) {
      return {
        status: 'failed',
        reason: error instanceof NemotronRunError ? `nemotron_${error.reason}` : 'nemotron_error',
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        excluded,
      }
    }
  } finally {
    untrackNemotronDir(work)
    try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  const activity: Activity = run
  // A channel is in use once it holds a track's worth of speech (QA 6.61.0 N2:
  // one 10 ms blip on a third channel made a two-person call "crowded").
  const channelsUsed = new Set(tracksIn(activity, 0, activity.frames).map(track => track.channel))
  if (unnamed) {
    return unnamedVoicePass({ options, sidecar, sidecarText, markdown, transcript, entries, timeline, activity, run, channelsUsed: channelsUsed.size, started })
  }
  // The canary's rule for a meeting-wide map (OUTCOME_2026-10-01, retro plan 4):
  // four or fewer identities and fewer than eight channels. A crowded room
  // (Wed 07:31 filled all eight with five names) gets no channel map; its words
  // keep their per-chunk names, which are the live Nemotron turns where those exist.
  const identities = crowdIdentities(timeline.windows)
  const crowded = isCrowded(identities, channelsUsed.size)
  const mapping = crowded
    ? { ...mapChannelsToNames(timeline.windows, activity), map: new Map<number, string>() }
    : mapChannelsToNames(timeline.windows, activity)

  let mode: 'batch' | 'streaming'
  let next: string
  let stats: RelabelStats
  const nextSidecar: Record<string, any> = JSON.parse(sidecarText)
  if (sidecar.batchApplied === true) {
    mode = 'batch'
    const segments = (Array.isArray(sidecar.batchSegments) ? sidecar.batchSegments : []) as SidecarBatchSegment[]
    if (!segments.length) return { status: 'skipped', reason: 'no_speaker_words' }
    const relabeled = relabelBatchSegments(segments, timeline, activity, mapping.map, owner)
    stats = relabeled.stats
    // finalizeBatch wrote labelled turns only when every segment had speaker words.
    const selected = selectBatchTranscriptForPersistence(
      String(sidecar.batchTranscript ?? ''),
      segments.map(segment => ({ text: segment.text, speakerWords: segment.speakerWords })),
    )
    if (selected.source !== 'speaker-words') return { status: 'skipped', reason: 'no_speaker_words' }
    const sequence = relabeled.segments.flatMap(segment => segment.speakerWords
      .map(word => ({ word: String(word.word ?? '').trim(), speaker: word.speaker || 'Ext' }))
      .filter(word => word.word))
    next = (options.relabelWords ?? relabelTranscriptWords)(transcript, sequence)
    nextSidecar.batchSegments = relabeled.segments
    // finalizeBatch records the exact canonical text here; keep that true.
    if (typeof sidecar.batchTranscript === 'string') nextSidecar.batchTranscript = next
  } else {
    mode = 'streaming'
    const relabeled = relabelStreamingChunks(timeline, activity, mapping.map, owner)
    stats = relabeled.stats
    const textEntries = entries.filter(entry => typeof entry.chunk?.text === 'string' && entry.chunk.text.trim())
    next = relabelStreamingTranscript(transcript, textEntries.map(entry => ({ chunkIndex: entry.chunkIndex, text: entry.chunk.text })), relabeled.finals)
    const chunks = Array.isArray(nextSidecar.chunks) ? nextSidecar.chunks as SidecarChunk[] : []
    const nextEntries = (Array.isArray(nextSidecar.chunkEntries) ? nextSidecar.chunkEntries : []) as SidecarEntry[]
    const textNext = nextEntries.filter(entry => typeof entry.chunk?.text === 'string' && entry.chunk.text.trim())
    const aligned = textNext.length === chunks.length && textNext.every((entry, i) => entry.chunk.text === chunks[i]?.text)
    if (!aligned) return { status: 'skipped', reason: 'chunk_map_ambiguous' }
    textNext.forEach((entry, i) => {
      const final = relabeled.finals.get(entry.chunkIndex)
      if (!final) return
      for (const chunk of [entry.chunk, chunks[i]]) {
        const original = typeof chunk.originalSpeaker === 'string' ? chunk.originalSpeaker : chunk.speaker
        chunk.finalSegments = final.segments
        chunk.speaker = final.speaker
        if (final.speaker !== original) chunk.originalSpeaker = original
        else delete chunk.originalSpeaker
      }
    })
  }

  // Both relabelers keep every word by construction (the batch one matches the
  // saved words, the streaming one splits a line only into its own chunk text).
  // This check is the last line of defence should either ever change.
  if (!sameWords(transcript, next)) return { status: 'skipped', reason: 'word_mismatch', mode, excluded }
  // Both relabellers keep line breaks, so an unchanged transcript means no label
  // changed: nothing is written and no revision moves.
  if (next === transcript) return { status: 'skipped', reason: 'no_change', mode, words: stats, excluded, crowded, identities, channels: channelsUsed.size }

  const speakers = new Set<string>(Array.isArray(sidecar.speakers) ? sidecar.speakers : [])
  for (const line of next.split('\n')) {
    const match = /^\[([^\]\n]+)\]:/.exec(line)
    if (match && isName(match[1])) speakers.add(match[1])
  }
  const ms = (options.now ?? Date.now)() - started
  const mapped = Object.fromEntries([...mapping.map.entries()].map(([channel, name]) => [String(channel), name]))
  nextSidecar.speakers = [...speakers]
  nextSidecar.lifecycleRevision = Number(sidecar.lifecycleRevision ?? 0) + 1
  nextSidecar.diarization = {
    engine: 'nemotron3',
    variant: NEMOTRON_VARIANT,
    bundle: NEMOTRON_BUNDLE,
    computeUnits: 'ane',
    status: 'applied',
    mode,
    appliedAt: new Date((options.now ?? Date.now)()).toISOString(),
    ms,
    audioSec: Math.round(timeline.durationSec * 10) / 10,
    frames: run.frames,
    channelsUsed: channelsUsed.size,
    channelMap: mapped,
    mapping: {
      crowded,
      identities,
      eligibleChunks: mapping.eligible,
      minSimilarity: FINAL_MIN_SIMILARITY,
      oneSided: FINAL_ONE_SIDED,
      minSupport: FINAL_MIN_SUPPORT,
      purity: FINAL_PURITY,
      evidence: mapping.evidence,
    },
    words: stats,
    excludedChunks: timeline.excluded,
    originalTranscript: transcript,
    outputSha256: sha(next),
  }
  const nextMarkdown = replaceTranscriptSection(markdown, next)
  if (nextMarkdown === null) return { status: 'skipped', reason: 'no_transcript' }

  const committed = commitFinalPass(options, sidecarText, markdown, nextSidecar, nextMarkdown, excluded)
  if (committed) return committed
  return {
    status: 'applied',
    mode,
    crowded,
    identities,
    ms,
    audioSec: Math.round(timeline.durationSec),
    channels: channelsUsed.size,
    mapped,
    words: stats,
    excluded,
    speakersBefore: distinctSpeakers(transcript),
    speakersAfter: distinctSpeakers(next),
  }
}

/**
 * Write a computed pass: re-read both files first (a human edit during the CLI
 * run makes the pass stale), then sidecar, then markdown, restoring the sidecar
 * if the markdown write fails. Null means both files were written.
 */
function commitFinalPass(
  options: FinalPassOptions,
  sidecarText: string,
  markdown: string,
  nextSidecar: Record<string, any>,
  nextMarkdown: string,
  excluded: MeetingTimeline['excluded'],
): FinalPassOutcome | null {
  // The CLI ran for tens of seconds. A human relabel or deattribution, or a
  // summary, may have landed meanwhile; writing from the copy read before the
  // run would erase it. Re-read both files: any change and this pass is stale.
  // Everything from here to the writes is synchronous, so no request handled by
  // this process can land in between.
  let sidecarNow: string
  let markdownNow: string
  try {
    sidecarNow = readFileSync(options.sidecarPath, 'utf8')
    markdownNow = readFileSync(options.meetingPath, 'utf8')
  } catch (error) {
    return { status: 'skipped', reason: 'changed_during_pass', detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) }
  }
  if (sidecarNow !== sidecarText || markdownNow !== markdown) {
    return { status: 'skipped', reason: 'changed_during_pass', detail: sidecarNow !== sidecarText ? 'sidecar changed' : 'markdown changed' }
  }

  // Sidecar first, markdown second, as the store does: the markdown is the
  // visible commit. If the markdown write fails, put the sidecar back, and say
  // so loudly if even that fails (the two files then disagree).
  const write = options.write ?? ((path: string, data: string) => durableAtomicWriteFileSync(path, data, { mode: 0o600 }))
  try {
    write(options.sidecarPath, JSON.stringify(nextSidecar, null, 2))
  } catch (error) {
    return { status: 'failed', reason: 'markdown_write', detail: `sidecar write: ${(error instanceof Error ? error.message : String(error)).slice(0, 280)}`, excluded }
  }
  try {
    write(options.meetingPath, nextMarkdown)
  } catch (error) {
    const why = (error instanceof Error ? error.message : String(error)).slice(0, 200)
    try {
      write(options.sidecarPath, sidecarText)
    } catch (restoreError) {
      return {
        status: 'failed',
        reason: 'sidecar_restore_failed',
        detail: `markdown write: ${why}; sidecar restore: ${(restoreError instanceof Error ? restoreError.message : String(restoreError)).slice(0, 200)}; the sidecar holds the relabel and the markdown does not`,
        excluded,
      }
    }
    return { status: 'failed', reason: 'markdown_write', detail: `${why}; sidecar restored`, excluded }
  }
  return null
}

// ── 6.90.0: unnamed, meeting-stable voices for Mac recordings ───────────────────
//
// The named pass above maps a channel to a name from chunks the voiceprint was
// sure of. A Mac recording has no such chunks (every one is `Ext` at the 0.88
// floor) and must never borrow a name, so it skips that pass (`speaker_policy`).
// This pass keeps the channels and drops the names: each channel that holds the
// floor in enough chunks becomes `Voice 1`, `Voice 2`, ... in order of first
// speech. No profile is read or written anywhere below; `owner` is never passed,
// so the wearer guard cannot fire and no name can enter. A crowded room (more
// than FINAL_MAX_IDENTITIES voices, or every channel in use) and a room with no
// confident channel stay `Ext` exactly as saved.

/** A channel becomes a voice only if it holds the floor, one-sided, in at least this many chunks. */
export const VOICE_MIN_SUPPORT = FINAL_MIN_SUPPORT

/**
 * Unnamed mode applies to a Mac recording, with the switch on, when every chunk
 * that carries words is the Mac strict policy and none already carries a real
 * name (a 0.88 match is rare, and a pass must never overwrite one with a
 * placeholder).
 */
export function unnamedVoicesEligible(
  sidecar: Record<string, unknown>,
  entries: SidecarEntry[],
  chunks: SidecarChunk[],
  env: NodeJS.ProcessEnv,
): boolean {
  if (!macVoiceLabelsEnabled(env) || !isMacCaptureSidecar(sidecar)) return false
  const hasText = (chunk: SidecarChunk) => typeof chunk?.text === 'string' && chunk.text.trim().length > 0
  const spoken = [...entries.map(entry => entry.chunk), ...chunks].filter(hasText)
  if (!spoken.length) return false
  // Measured on the six 10/16-10/22 Mac recordings: every text-less entry (an
  // empty completion) is stored with no policy marker, so only the chunks that
  // carry words must prove the Mac pin. A text-less entry may be unmarked or
  // strict; anything else (anonymous, a malformed marker) still refuses.
  const silentOk = entries.filter(entry => !hasText(entry.chunk))
    .every(entry => entry.chunk?.speakerPolicy === undefined || entry.chunk.speakerPolicy === 'high-confidence')
  return silentOk && spoken.every(chunk => chunk.speakerPolicy === 'high-confidence' && !isName(chunk.speaker))
}

export interface VoiceChannels {
  /** Accepted channels, in order of first supporting chunk. */
  channels: number[]
  evidence: Array<{ channel: number; support: number; firstSec: number; accepted: boolean }>
  eligible: number
}

/** Channels that hold the floor, one-sided, in VOICE_MIN_SUPPORT or more chunks. Names are never read. */
export function mapChannelsToVoices(windows: TimelineWindow[], a: Activity, options: { oneSided?: number; minSupport?: number } = {}): VoiceChannels {
  const oneSided = options.oneSided ?? FINAL_ONE_SIDED
  const minSupport = options.minSupport ?? VOICE_MIN_SUPPORT
  const support = new Map<number, { support: number; firstSec: number }>()
  let eligible = 0
  for (const window of windows) {
    const [f0, f1] = frameRange(a, window.start, window.end)
    const counts = new Array<number>(NEMOTRON_CHANNELS).fill(0)
    let speech = 0
    for (let f = f0; f < f1; f++) {
      let any = false
      for (let c = 0; c < NEMOTRON_CHANNELS; c++) if (isActive(a, f, c)) { counts[c]++; any = true }
      if (any) speech++
    }
    if (speech === 0) continue
    let dom = 0
    for (let c = 1; c < NEMOTRON_CHANNELS; c++) if (counts[c] > counts[dom]) dom = c
    if (counts[dom] / speech < oneSided) continue
    eligible++
    const row = support.get(dom) ?? { support: 0, firstSec: window.start }
    row.support++
    row.firstSec = Math.min(row.firstSec, window.start)
    support.set(dom, row)
  }
  const ordered = [...support.entries()].sort((x, y) => x[1].firstSec - y[1].firstSec || x[0] - y[0])
  const evidence = ordered.map(([channel, row]) => ({ channel, support: row.support, firstSec: Math.round(row.firstSec * 100) / 100, accepted: row.support >= minSupport }))
  return { channels: evidence.filter(row => row.accepted).map(row => row.channel), evidence, eligible }
}

/**
 * The label a chunk had LIVE. A final pass rewrites `speaker` and keeps the live one in
 * `originalSpeaker`, so a re-run (resumed finalization, nemotron-replay) must read that,
 * or it takes its own earlier numbers for live evidence and numbers from max + 1.
 */
function liveLabelOf(chunk: { speaker?: unknown; originalSpeaker?: unknown } | null | undefined): unknown {
  return typeof chunk?.originalSpeaker === 'string' ? chunk.originalSpeaker : chunk?.speaker
}

/** Which final channels each established live turn overlaps (a turn is a claim on every channel active inside it). */
function liveClaims(windows: TimelineWindow[], a: Activity): Map<number, Set<string>> {
  const claims = new Map<number, Set<string>>()
  for (const window of windows) for (const segment of window.chunk.segments ?? []) {
    if (!isVoiceLabel(segment.speaker)) continue
    const timed = Number.isFinite(segment.startSec) && Number.isFinite(segment.endSec)
      && Number(segment.startSec) >= 0 && Number(segment.endSec) <= window.end - window.start
      && Number(segment.endSec) > Number(segment.startSec)
    const start = timed ? window.start + Math.max(0, Number(segment.startSec)) : window.start
    const end = timed ? Math.min(window.end, window.start + Number(segment.endSec)) : window.end
    const [f0,f1] = frameRange(a, start, end)
    for (let channel = 0; channel < NEMOTRON_CHANNELS; channel++) {
      let overlaps = false
      for (let f=f0;f<f1;f++) if (isActive(a,f,channel)) { overlaps = true; break }
      if (!overlaps) continue
      const labels = claims.get(channel) ?? new Set<string>()
      labels.add(segment.speaker); claims.set(channel, labels)
    }
  }
  return claims
}

/** Crosswalk final channels to EXISTING live placeholders. A pure live chunk
 * must belong overwhelmingly to one final channel. Contradictory channels or a
 * live label split across channels are withheld; no numbers are reassigned. */
export function mapChannelsToLiveVoices(windows: TimelineWindow[], a: Activity): Map<number, string> {
  const votes = new Map<number, Set<string>>()
  for (const window of windows) {
    const chunk = window.chunk
    const liveLabel = liveLabelOf(chunk) as string
    if (!isVoiceLabel(liveLabel) || !chunk.segments?.length || chunk.segments.some(s => s.speaker !== liveLabel)) continue
    const [f0,f1] = frameRange(a, window.start, window.end)
    let speech = 0
    const exclusive = new Array<number>(NEMOTRON_CHANNELS).fill(0)
    for (let f=f0;f<f1;f++) {
      const active: number[]=[]
      for (let c=0;c<NEMOTRON_CHANNELS;c++) if(isActive(a,f,c)) active.push(c)
      if(active.length) speech++
      if(active.length===1) exclusive[active[0]]++
    }
    const channel = exclusive.indexOf(Math.max(...exclusive))
    if(!speech || exclusive[channel]/speech < 0.9) continue
    const labels = votes.get(channel) ?? new Set<string>()
    labels.add(liveLabel); votes.set(channel,labels)
  }
  // A mixed live chunk cannot establish a crosswalk, but every established
  // turn in it CAN contradict one. A final diarizer that merges two live
  // voices into one channel must not transfer one voice's label to the other.
  const claims = liveClaims(windows, a)
  const proposed = [...votes].filter(([,labels])=>labels.size===1).map(([channel,labels])=>[channel,[...labels][0]] as const)
  // Count claims on conflicting channels too. Dropping a contradictory channel
  // must not make its label appear exclusive to a different channel.
  return new Map(proposed.filter(([channel,label]) =>
    [...votes.values()].filter(labels=>labels.has(label)).length===1
      && [...(claims.get(channel) ?? [])].every(claim => claim === label)
      && [...claims.values()].filter(labels=>labels.has(label)).length===1))
}

/**
 * 6.93.0 QA W3: confident final channels that NO established live turn touches.
 * A capture whose live labels missed a voice (a track the live path never proved,
 * or one it lost) still gets that voice numbered at save, above every live number,
 * as 6.92.0 would have numbered it. A channel any live `Voice N` turn overlaps is
 * never in this set: its words keep the live label, and the rest stay `Ext`.
 */
export function unclaimedFinalChannels(windows: TimelineWindow[], a: Activity, channels: number[]): number[] {
  const claims = liveClaims(windows, a)
  return channels.filter(channel => !claims.has(channel))
}

/** `Voice 1` for the first channel, `Voice 2` for the next, and so on. */
export function numberVoices(channels: number[]): Map<number, string> {
  return new Map(channels.map((channel, i) => [channel, voiceLabel(i + 1)]))
}

function voicesIn(transcript: string): Set<string> {
  const out = new Set<string>()
  for (const line of transcript.split('\n')) {
    const match = /^\[([^\]\n]+)\]:/.exec(line)
    if (match && isVoiceLabel(match[1])) out.add(match[1])
  }
  return out
}

/** The label with the most words, ties to the earlier label. */
function mostWords(counts: Map<string, number>): string | null {
  let best: string | null = null
  let n = -1
  for (const [label, count] of counts) if (count > n) { best = label; n = count }
  return best
}

interface UnnamedInput {
  options: FinalPassOptions
  sidecar: Record<string, any>
  sidecarText: string
  markdown: string
  transcript: string
  entries: SidecarEntry[]
  timeline: MeetingTimeline
  activity: Activity
  run: NemotronPreds
  channelsUsed: number
  started: number
}

interface UnnamedLabelling {
  next: string
  stats: RelabelStats
  /** chunkIndex -> the chunk's label (the one with the most words). */
  chunkSpeakers: Map<number, string>
  batchSegments?: SidecarBatchSegment[]
  finals?: Map<number, { speaker: string; segments: ChunkSpeakerSegment[] }>
}

function labelUnnamed(input: UnnamedInput, mode: 'batch' | 'streaming', map: Map<number, string>): UnnamedLabelling | FinalPassOutcome {
  const { sidecar, timeline, activity, transcript, entries } = input
  if (mode === 'batch') {
    const segments = (Array.isArray(sidecar.batchSegments) ? sidecar.batchSegments : []) as SidecarBatchSegment[]
    if (!segments.length) return { status: 'skipped', reason: 'no_speaker_words' }
    const selected = selectBatchTranscriptForPersistence(
      String(sidecar.batchTranscript ?? ''),
      segments.map(segment => ({ text: segment.text, speakerWords: segment.speakerWords })),
    )
    if (selected.source !== 'speaker-words') return { status: 'skipped', reason: 'no_speaker_words' }
    const relabeled = relabelBatchSegments(segments, timeline, activity, map, null)
    const sequence = relabeled.segments.flatMap(segment => segment.speakerWords
      .map(word => ({ word: String(word.word ?? '').trim(), speaker: word.speaker || 'Ext' }))
      .filter(word => word.word))
    const next = (input.options.relabelWords ?? relabelTranscriptWords)(transcript, sequence)
    const perChunk = new Map<number, Map<string, number>>()
    for (const segment of relabeled.segments) {
      for (const word of segment.speakerWords) {
        const at = batchWordToTimeline(segment, Number(word.start), timeline)
        if (!at) continue
        const counts = perChunk.get(at.window.chunkIndex) ?? new Map<string, number>()
        counts.set(word.speaker || 'Ext', (counts.get(word.speaker || 'Ext') ?? 0) + 1)
        perChunk.set(at.window.chunkIndex, counts)
      }
    }
    const chunkSpeakers = new Map<number, string>()
    for (const [index, counts] of perChunk) { const top = mostWords(counts); if (top) chunkSpeakers.set(index, top) }
    return { next, stats: relabeled.stats, chunkSpeakers, batchSegments: relabeled.segments }
  }
  const relabeled = relabelStreamingChunks(timeline, activity, map, null)
  const textEntries = entries.filter(entry => typeof entry.chunk?.text === 'string' && entry.chunk.text.trim())
  const next = relabelStreamingTranscript(transcript, textEntries.map(entry => ({ chunkIndex: entry.chunkIndex, text: entry.chunk.text })), relabeled.finals)
  const chunkSpeakers = new Map<number, string>([...relabeled.finals.entries()].map(([index, final]) => [index, final.speaker]))
  return { next, stats: relabeled.stats, chunkSpeakers, finals: relabeled.finals }
}

/**
 * The unnamed pass. Labels are kept consistent between the transcript and the
 * chunks the relabel route edits: a voice that would appear in turns but lead no
 * chunk (or lead a chunk but have no turn, or neither) could never be renamed in
 * one action, so its channel is dropped back to `Ext` and the rest are
 * renumbered. A pass with no voice left is `voices_unconfident`.
 */
async function unnamedVoicePass(input: UnnamedInput): Promise<FinalPassOutcome> {
  const { options, sidecar, sidecarText, markdown, transcript, entries, timeline, activity, run, channelsUsed, started } = input
  const excluded = timeline.excluded
  const mode: 'batch' | 'streaming' = sidecar.batchApplied === true ? 'batch' : 'streaming'
  const found = mapChannelsToVoices(timeline.windows, activity)
  const crowded = isCrowded(found.channels.length, channelsUsed)
  if (crowded) {
    return { status: 'skipped', reason: 'voices_crowded', unnamed: true, mode, crowded: true, identities: found.channels.length, channels: channelsUsed, excluded }
  }

  const nextSidecar: Record<string, any> = JSON.parse(sidecarText)
  const chunks = Array.isArray(nextSidecar.chunks) ? nextSidecar.chunks as SidecarChunk[] : []
  const nextEntries = (Array.isArray(nextSidecar.chunkEntries) ? nextSidecar.chunkEntries : []) as SidecarEntry[]
  const textNext = nextEntries.filter(entry => typeof entry.chunk?.text === 'string' && entry.chunk.text.trim())
  const aligned = textNext.length === chunks.length && textNext.every((entry, i) => entry.chunk.text === chunks[i]?.text)
  if (!aligned) return { status: 'skipped', reason: 'chunk_map_ambiguous', unnamed: true, mode, excluded }

  // With no live Voice label (COS_MAC_LIVE_VOICES=off, or a capture the live path never
  // numbered) nothing is restricted and every confident channel is numbered, exactly as 6.92.0.
  const liveNumbers = entries.flatMap(entry => [liveLabelOf(entry.chunk), ...(Array.isArray(entry.chunk?.segments) ? entry.chunk.segments : []).map(segment => segment?.speaker)])
    .filter(isVoiceLabel).map(label => Number(String(label).slice(6)))
  const liveMap = liveNumbers.length ? mapChannelsToLiveVoices(timeline.windows, activity) : null
  // W3: a channel the live path never proved is numbered above every live number
  // unless a live turn contradicts it. Words that already carry a live number keep it.
  const unproven = liveMap
    ? unclaimedFinalChannels(timeline.windows, activity, found.channels.filter(channel => !liveMap.has(channel))).slice(0, Math.max(0, 99 - Math.max(...liveNumbers)))
    : []
  let channels = found.channels.filter(channel => !liveMap || liveMap.has(channel) || unproven.includes(channel))
  const labelsFor = (kept: number[]) => {
    if (!liveMap) return numberVoices(kept)
    const out = new Map<number, string>()
    let next = Math.max(...liveNumbers)
    for (const channel of kept) out.set(channel, liveMap.get(channel) ?? voiceLabel(++next))
    return out
  }
  let map = labelsFor(channels)
  let labelled: UnnamedLabelling | null = null
  for (let round = 0; round <= NEMOTRON_CHANNELS && channels.length; round++) {
    map = labelsFor(channels)
    const attempt = labelUnnamed(input, mode, map)
    if ('status' in attempt) return { ...attempt, unnamed: true, mode, excluded }
    const inTurns = voicesIn(attempt.next)
    const leading = new Set(textNext.map(entry => attempt.chunkSpeakers.get(entry.chunkIndex)).filter((label): label is string => isVoiceLabel(label)))
    // A voice must both speak a turn and lead a chunk. One that does neither (a
    // channel with no words) is dropped too, so numbering never skips a voice.
    const kept = channels.filter(channel => inTurns.has(map.get(channel)!) && leading.has(map.get(channel)!))
    if (kept.length === channels.length) { labelled = attempt; break }
    channels = kept
  }
  // No confident channel at all, or none left once orphans are dropped: the room stays Ext.
  if (!labelled || !channels.length) return { status: 'skipped', reason: 'voices_unconfident', unnamed: true, mode, channels: channelsUsed, excluded }
  const { next, stats } = labelled

  if (!sameWords(transcript, next)) return { status: 'skipped', reason: 'word_mismatch', unnamed: true, mode, excluded }
  if (next === transcript) return { status: 'skipped', reason: 'no_change', unnamed: true, mode, words: stats, excluded, channels: channelsUsed }

  textNext.forEach((entry, i) => {
    const label = labelled!.chunkSpeakers.get(entry.chunkIndex)
    if (!label) return
    const final = labelled!.finals?.get(entry.chunkIndex)
    for (const chunk of [entry.chunk, chunks[i]]) {
      const original = typeof chunk.originalSpeaker === 'string' ? chunk.originalSpeaker : chunk.speaker
      if (final) chunk.finalSegments = final.segments
      chunk.speaker = label
      if (label !== original) chunk.originalSpeaker = original
      else delete chunk.originalSpeaker
    }
  })
  if (labelled.batchSegments) {
    nextSidecar.batchSegments = labelled.batchSegments
    if (typeof sidecar.batchTranscript === 'string') nextSidecar.batchTranscript = next
  }

  const voices = voicesIn(next).size
  const ms = (options.now ?? Date.now)() - started
  const mapped = Object.fromEntries([...map.entries()].map(([channel, label]) => [String(channel), label]))
  // `speakers` is left exactly as saved: a `Voice N` placeholder is never a speaker name.
  nextSidecar.lifecycleRevision = Number(sidecar.lifecycleRevision ?? 0) + 1
  nextSidecar.diarization = {
    engine: 'nemotron3',
    variant: NEMOTRON_VARIANT,
    bundle: NEMOTRON_BUNDLE,
    computeUnits: 'ane',
    status: 'applied',
    mode,
    labels: 'unnamed',
    appliedAt: new Date((options.now ?? Date.now)()).toISOString(),
    ms,
    audioSec: Math.round(timeline.durationSec * 10) / 10,
    frames: run.frames,
    channelsUsed,
    channelMap: mapped,
    mapping: {
      unnamed: true,
      crowded: false,
      voices,
      eligibleChunks: found.eligible,
      oneSided: FINAL_ONE_SIDED,
      minSupport: VOICE_MIN_SUPPORT,
      evidence: found.evidence,
    },
    words: stats,
    excludedChunks: timeline.excluded,
    originalTranscript: transcript,
    outputSha256: sha(next),
  }
  const nextMarkdown = replaceTranscriptSection(markdown, next)
  if (nextMarkdown === null) return { status: 'skipped', reason: 'no_transcript' }
  const committed = commitFinalPass(options, sidecarText, markdown, nextSidecar, nextMarkdown, excluded)
  if (committed) return { ...committed, unnamed: true }
  return {
    status: 'applied',
    unnamed: true,
    voices,
    mode,
    crowded: false,
    identities: 0,
    ms,
    audioSec: Math.round(timeline.durationSec),
    channels: channelsUsed,
    mapped,
    words: stats,
    excluded,
    speakersBefore: distinctSpeakers(transcript),
    speakersAfter: distinctSpeakers(next),
  }
}
