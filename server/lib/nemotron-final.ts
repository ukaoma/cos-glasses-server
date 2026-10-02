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
// SAFETY. Nothing is written unless the relabelled transcript holds exactly the
// same words, in the same order, as the transcript it replaces. The original
// labels stay recoverable: every changed batch word carries `originalSpeaker`,
// every changed chunk carries `originalSpeaker`, and the sidecar keeps the whole
// pre-relabel transcript under `diarization.originalTranscript`. Any failure
// leaves the meeting exactly as it was saved. A human correction always wins:
// a sidecar with correctionRevision > 0 is never relabelled.
//
// No LLM anywhere. Transcription must never call `claude -p`.

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
import { cleanTranscriptLines } from './hallucination-filter.js'
import { isUnattributed } from './meeting-speaker-review.js'
import { NemotronRunError, runNemotronCli, type NemotronPreds, type RunNemotronOptions } from './nemotron-cli.js'
import type { ChunkSpeakerSegment } from './nemotron-live.js'
import {
  channelForSpan,
  estimateTokenTimes,
  frameRange,
  isActive,
  isWordToken,
  pcm16ToWav,
  readPcm16Mono,
  splitTokens,
  tokenTimesFromWords,
  type Activity,
  type TokenTime,
} from './nemotron-segments.js'
import { NEMOTRON_CHANNELS } from './nemotron-cli.js'
import type { WhisperWord } from './whisper-local.js'

export const FINAL_MIN_SIMILARITY = 0.65
export const FINAL_ONE_SIDED = 0.8
export const FINAL_MIN_SUPPORT = 3
export const FINAL_PURITY = 0.8
const SR = 16_000
const WAV_HEADER = 44

interface EvenRole { frames?: number; self?: number; other?: number }

export interface SidecarChunk {
  text: string
  speaker: string
  elapsed: number
  similarity: number
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
}

const chunkFile = (audioDir: string, index: number): string => join(audioDir, `chunk_${String(index).padStart(4, '0')}.wav`)

/** The canary's timeline: each WAV at its real elapsed, only the overlapping tail trimmed. */
export function buildMeetingTimeline(entries: SidecarEntry[], audioDir: string): MeetingTimeline {
  const excluded = { missing: 0, hashMismatch: 0, unreadable: 0 }
  const placed: Array<{ entry: SidecarEntry; pcm: Buffer; at: number }> = []
  const fileSamples = new Map<number, number>()
  const indices = entries.map(entry => entry.chunkIndex)
  const maxIndex = indices.length ? Math.max(...indices) : -1
  for (let index = 0; index <= maxIndex; index++) {
    const path = chunkFile(audioDir, index)
    if (!existsSync(path)) continue
    try {
      const wav = readFileSync(path)
      if (wav.length > WAV_HEADER && wav.toString('ascii', 0, 4) === 'RIFF') fileSamples.set(index, Math.floor((wav.length - WAV_HEADER) / 2))
    } catch { /* unreadable: absent from both */ }
  }
  for (const entry of entries) {
    const path = chunkFile(audioDir, entry.chunkIndex)
    if (!existsSync(path)) { excluded.missing++; continue }
    let wav: Buffer
    try { wav = readFileSync(path) } catch { excluded.unreadable++; continue }
    const expected = entry.chunk.audioSha256
    if (expected && createHash('sha256').update(wav).digest('hex') !== expected) { excluded.hashMismatch++; continue }
    const pcm = readPcm16Mono(wav)
    if (!pcm || pcm.sampleRate !== SR || !Number.isFinite(entry.chunk.elapsed)) { excluded.unreadable++; continue }
    placed.push({ entry, pcm: pcm.pcm, at: Math.max(0, Math.round((entry.chunk.elapsed / 1000) * SR)) })
  }
  placed.sort((x, y) => x.at - y.at || x.entry.chunkIndex - y.entry.chunkIndex)
  let total = 0
  for (const item of placed) total = Math.max(total, item.at + item.pcm.length / 2)
  total += SR
  const pcm = Buffer.alloc(total * 2)
  const windows: TimelineWindow[] = []
  for (let i = 0; i < placed.length; i++) {
    const item = placed[i]
    const next = i + 1 < placed.length ? placed[i + 1].at : item.at + item.pcm.length / 2
    const room = Math.max(0, next - item.at)
    const use = Math.min(item.pcm.length / 2, room)
    item.pcm.copy(pcm, item.at * 2, 0, use * 2)
    windows.push({ chunkIndex: item.entry.chunkIndex, start: item.at / SR, end: (item.at + use) / SR, chunk: item.entry.chunk })
  }
  return {
    wav: pcm16ToWav(pcm, SR),
    durationSec: total / SR,
    windows,
    byIndex: new Map(windows.map(window => [window.chunkIndex, window])),
    fileSamples,
    excluded,
  }
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
function liveSpeakerAt(chunk: SidecarChunk, t: number): string | null {
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
  return best && typeof best.speaker === 'string' ? best.speaker : null
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
function batchWordToTimeline(segment: SidecarBatchSegment, t: number, timeline: MeetingTimeline): { window: TimelineWindow; inChunk: number; at: number } | null {
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
): { segments: SidecarBatchSegment[]; stats: RelabelStats } {
  const stats: RelabelStats = { total: 0, relabeled: 0, viaChannel: 0, kept: 0 }
  const out = segments.map(segment => ({
    ...segment,
    speakerWords: (segment.speakerWords ?? []).map(word => {
      stats.total++
      const original = typeof word.originalSpeaker === 'string' ? word.originalSpeaker : word.speaker
      const start = batchWordToTimeline(segment, Number(word.start), timeline)
      const end = batchWordToTimeline(segment, Number(word.end), timeline)
      let name: string | null = null
      if (start) {
        const channel = channelForSpan(a, start.at, Math.max(start.at, end?.window === start.window ? end.at : start.at + 0.01))
        if (channel !== null && map.has(channel)) { name = map.get(channel)!; stats.viaChannel++ }
      }
      if (name === null) {
        stats.kept++
        name = (start && liveSpeakerAt(start.window.chunk, start.inChunk)) ?? original
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
): { finals: Map<number, { speaker: string; segments: ChunkSpeakerSegment[] }>; stats: RelabelStats } {
  const stats: RelabelStats = { total: 0, relabeled: 0, viaChannel: 0, kept: 0 }
  const finals = new Map<number, { speaker: string; segments: ChunkSpeakerSegment[] }>()
  for (const window of timeline.windows) {
    const chunk = window.chunk
    if (typeof chunk.text !== 'string' || !chunk.text.trim()) continue
    const tokens = splitTokens(chunk.text)
    const times = streamingTokenTimes(chunk, tokens, window, a)
    const base = typeof chunk.originalSpeaker === 'string' ? chunk.originalSpeaker : chunk.speaker
    const labels: string[] = []
    let carry: string | null = null
    for (let i = 0; i < tokens.length; i++) {
      if (!isWordToken(tokens[i]) || !times) { labels.push(carry ?? liveSpeakerAt(chunk, 0) ?? base); continue }
      stats.total++
      const span = times[i]
      const channel = channelForSpan(a, window.start + span.start, window.start + Math.max(span.end, span.start + 0.01))
      let name: string
      if (channel !== null && map.has(channel)) { name = map.get(channel)!; stats.viaChannel++ }
      else { name = liveSpeakerAt(chunk, span.start) ?? base; stats.kept++ }
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

function cleanFinal(transcript: string): string {
  try {
    return process.env.COS_WHISPER_STRIP_BRAND_URLS === '0' ? transcript : cleanTranscriptLines(transcript)
  } catch {
    return transcript
  }
}

export type FinalPassStatus = 'applied' | 'skipped' | 'failed'

export interface FinalPassOutcome {
  status: FinalPassStatus
  reason?: string
  mode?: 'batch' | 'streaming'
  ms?: number
  audioSec?: number
  channels?: number
  mapped?: Record<string, string>
  words?: RelabelStats
  /** Distinct speakers in the transcript before and after. */
  speakersBefore?: number
  speakersAfter?: number
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
}

let finalLane: Promise<unknown> = Promise.resolve()
let lastFinal: (FinalPassOutcome & { at: string }) | null = null
const finalCounts: Record<string, number> = {}

export function finalPassSnapshot(): { last: (FinalPassOutcome & { at: string }) | null; counts: Record<string, number> } {
  return { last: lastFinal, counts: { ...finalCounts } }
}

/** One meeting's final pass, serialised with every other final pass. Never throws. */
export function runNemotronFinalPass(options: FinalPassOptions): Promise<FinalPassOutcome> {
  const job = finalLane.then(() => finalPassNow(options)).catch(error => ({
    status: 'failed' as const,
    reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
  }))
  finalLane = job.then(() => undefined, () => undefined)
  return job.then(outcome => {
    const key = outcome.status === 'applied' ? 'applied' : `${outcome.status}:${outcome.reason ?? 'unknown'}`
    finalCounts[key] = (finalCounts[key] ?? 0) + 1
    lastFinal = { ...outcome, at: new Date((options.now ?? Date.now)()).toISOString() }
    const log = options.log ?? console.log
    if (outcome.status === 'applied') {
      log(`[diarizer] final pass applied (${outcome.mode}) in ${outcome.ms} ms: ${outcome.channels} channels, mapped ${JSON.stringify(outcome.mapped)}, ${outcome.words?.relabeled}/${outcome.words?.total} words relabelled, speakers ${outcome.speakersBefore} -> ${outcome.speakersAfter}`)
    } else {
      log(`[diarizer] final pass ${outcome.status}: ${outcome.reason}; the saved transcript is unchanged`)
    }
    return outcome
  })
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
  if (Number(sidecar.correctionRevision ?? 0) > 0) return { status: 'skipped', reason: 'human_corrected' }
  const markdown = readFileSync(options.meetingPath, 'utf8')
  const transcript = readTranscriptSection(markdown)
  if (transcript === null) return { status: 'skipped', reason: 'no_transcript' }
  if (sidecar.diarization?.status === 'applied' && sidecar.diarization?.outputSha256 === sha(transcript)) {
    return { status: 'skipped', reason: 'already_applied' }
  }
  const entries = (Array.isArray(sidecar.chunkEntries) ? sidecar.chunkEntries : []) as SidecarEntry[]
  if (!entries.length) return { status: 'skipped', reason: 'no_chunks' }

  const timeline = buildMeetingTimeline(entries, options.audioDir)
  if (!timeline.windows.length) return { status: 'skipped', reason: 'no_audio' }

  const cli = nemotronCliPath(env, home)
  const modelsDir = prepareNemotronModelsDir(env, home)
  if (!cli || !modelsDir) return { status: 'skipped', reason: !cli ? 'cli_missing' : 'models_missing' }

  const work = mkdtempSync(join(options.tmpRoot ?? tmpdir(), 'cos-nemotron-final-'))
  let run: NemotronPreds
  try {
    try { chmodSync(work, 0o700) } catch { /* mkdtemp is already 0700 */ }
    const wavPath = join(work, 'meeting.wav')
    writeFileSync(wavPath, timeline.wav, { mode: 0o600 })
    try {
      // 20x realtime is the floor (the canary ran 155x), plus room for a cold compile.
      run = await (options.run ?? runNemotronCli)({
        cli,
        modelsDir,
        wavPath,
        timeoutMs: 120_000 + Math.round((timeline.durationSec * 1000) / 20),
        computeUnits: 'ane',
        niceness: 10,
        tmpRoot: options.tmpRoot,
      })
    } catch (error) {
      return { status: 'failed', reason: error instanceof NemotronRunError ? `nemotron_${error.reason}` : 'nemotron_error' }
    }
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  const activity: Activity = run
  const mapping = mapChannelsToNames(timeline.windows, activity)
  const channelsUsed = new Set<number>()
  for (let f = 0; f < activity.frames; f++) for (let c = 0; c < NEMOTRON_CHANNELS; c++) if (isActive(activity, f, c)) channelsUsed.add(c)

  let mode: 'batch' | 'streaming'
  let next: string
  let stats: RelabelStats
  const nextSidecar: Record<string, any> = JSON.parse(sidecarText)
  if (sidecar.batchApplied === true) {
    mode = 'batch'
    const segments = (Array.isArray(sidecar.batchSegments) ? sidecar.batchSegments : []) as SidecarBatchSegment[]
    if (!segments.length) return { status: 'skipped', reason: 'no_speaker_words' }
    const relabeled = relabelBatchSegments(segments, timeline, activity, mapping.map)
    stats = relabeled.stats
    const selected = selectBatchTranscriptForPersistence(
      String(sidecar.batchTranscript ?? ''),
      relabeled.segments.map(segment => ({ text: segment.text, speakerWords: segment.speakerWords })),
    )
    if (selected.source !== 'speaker-words') return { status: 'skipped', reason: 'no_speaker_words' }
    next = cleanFinal(selected.text)
    nextSidecar.batchSegments = relabeled.segments
    // finalizeBatch records the exact canonical text here; keep that true.
    if (typeof sidecar.batchTranscript === 'string') nextSidecar.batchTranscript = next
  } else {
    mode = 'streaming'
    const relabeled = relabelStreamingChunks(timeline, activity, mapping.map)
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

  if (!sameWords(transcript, next)) return { status: 'skipped', reason: 'word_mismatch', mode }
  if (next === transcript) return { status: 'skipped', reason: 'no_change', mode, words: stats }

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

  // Sidecar first, markdown second, as the store does: the markdown is the
  // visible commit. If the markdown write fails, put the sidecar back.
  durableAtomicWriteFileSync(options.sidecarPath, JSON.stringify(nextSidecar, null, 2), { mode: 0o600 })
  try {
    durableAtomicWriteFileSync(options.meetingPath, nextMarkdown, { mode: 0o600 })
  } catch (error) {
    try { durableAtomicWriteFileSync(options.sidecarPath, sidecarText, { mode: 0o600 }) } catch { /* reported below */ }
    return { status: 'failed', reason: `markdown_write: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) }
  }
  return {
    status: 'applied',
    mode,
    ms,
    audioSec: Math.round(timeline.durationSec),
    channels: channelsUsed.size,
    mapped,
    words: stats,
    speakersBefore: distinctSpeakers(transcript),
    speakersAfter: distinctSpeakers(next),
  }
}
