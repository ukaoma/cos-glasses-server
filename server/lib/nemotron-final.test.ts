import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { selectBatchTranscriptForPersistence } from './batch-transcript-quality.js'
import { cleanTranscriptLines } from './hallucination-filter.js'
import { NemotronRunError, type RunNemotronOptions } from './nemotron-cli.js'
import {
  buildMeetingTimeline,
  mapChannelsToNames,
  readTranscriptSection,
  runNemotronFinalPass,
  sameWords,
  transcriptWords,
  type SidecarBatchSegment,
  type SidecarEntry,
} from './nemotron-final.js'
import { activityOf, fakeNemotronHome, wavOf } from './__fixtures__/nemotron-helpers.js'

const roots: string[] = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir }

// Eight 6 s chunks. MU on channel 0, Silas on channel 1, every time.
//   chunks 0,1,4: MU, sure, one-sided (self)      chunks 2,3,6: Silas, sure, one-sided (other)
//   chunk 5: MU 0-2.5 s then Silas 2.5-6 s, labelled MU (Even Hub mixed, so not mapping evidence)
//   chunk 7: Silas, but the voiceprint was unsure (Ext, 0)
const SPANS: Array<[number, number, number]> = [[0, 0, 12], [1, 12, 24], [0, 24, 32.5], [1, 32.5, 48]]
const WHO = ['MU', 'MU', 'Silas Larson', 'Silas Larson', 'MU', 'MU', 'Silas Larson', 'Ext']
const SIM = [0.8, 0.78, 0.71, 0.74, 0.9, 0.82, 0.7, 0]
const ROLE = (i: number) => i === 5 ? { schema: 1, frames: 120, self: 60, other: 60 } : i === 7 ? { schema: 1, frames: 120, self: 10, other: 110 }
  : { schema: 1, frames: 120, self: WHO[i] === 'MU' ? 110 : 8, other: WHO[i] === 'MU' ? 10 : 112 }
const WORD_AT = [0.5, 1.8, 3.2, 4.6]
const wordsOf = (i: number) => ['alpha', 'bravo', 'charlie', 'delta'].map(w => `${w}${i}`)

interface Fixture {
  dir: string
  audioDir: string
  meetingPath: string
  sidecarPath: string
  home: string
  transcript: string
  sidecarText: string
  markdownText: string
}

function meeting(options: { batch: boolean; correctionRevision?: number; tamperWav?: number; liveSegments?: boolean } = { batch: true }): Fixture {
  const dir = temp('nemotron-final-')
  const audioDir = join(dir, 'pending')
  mkdirSync(audioDir)
  const entries: SidecarEntry[] = []
  for (let i = 0; i < 8; i++) {
    const wav = wavOf(6, () => (i + 1) * 10)
    writeFileSync(join(audioDir, `chunk_${String(i).padStart(4, '0')}.wav`), wav)
    const text = wordsOf(i).join(' ')
    const chunk: Record<string, unknown> = {
      text,
      speaker: WHO[i],
      elapsed: i * 6000,
      similarity: SIM[i],
      evenHubSpeakerRole: ROLE(i),
      audioSha256: createHash('sha256').update(i === options.tamperWav ? Buffer.from('other bytes') : wav).digest('hex'),
    }
    if (options.liveSegments && i === 5) {
      chunk.segments = [
        { speaker: 'MU', text: 'alpha5 bravo5', startSec: 0, endSec: 3, similarity: 0.82 },
        { speaker: 'Silas Larson', text: 'charlie5 delta5', startSec: 3, endSec: 6, similarity: 0.7 },
      ]
    }
    entries.push({ chunkIndex: i, chunk: chunk as never })
  }
  const batchSegments: SidecarBatchSegment[] = [0, 4].map(first => {
    const speakerWords = [] as SidecarBatchSegment['speakerWords']
    for (let i = first; i < first + 4; i++) {
      wordsOf(i).forEach((word, k) => {
        const start = (i - first) * 6 + WORD_AT[k]
        speakerWords.push({ word, start, end: start + 0.6, speaker: WHO[i], similarity: SIM[i] })
      })
    }
    return {
      startChunkIdx: first, endChunkIdx: first + 3, startElapsed: first * 6000, endElapsed: (first + 3) * 6000,
      text: speakerWords.map(w => w.word).join(' '), words: [], speakerWords,
    }
  })
  const transcript = options.batch
    ? cleanTranscriptLines(selectBatchTranscriptForPersistence('', batchSegments).text)
    : entries.map(e => `[${e.chunk.speaker}]: ${e.chunk.text}`).join('\n')
  const sidecar = {
    schemaVersion: 2,
    sessionId: 'meeting_final_fixture',
    speakers: ['MU', 'Silas Larson'],
    chunks: entries.map(e => e.chunk),
    chunkEntries: entries,
    batchApplied: options.batch,
    ...(options.batch ? { batchSegments, batchTranscript: transcript } : {}),
    ...(options.correctionRevision ? { correctionRevision: options.correctionRevision } : {}),
  }
  const meetingPath = join(dir, '2026-10-02_Final_fixture.md')
  const sidecarPath = meetingPath.replace(/\.md$/, '.g2-chunks.json')
  const sidecarText = JSON.stringify(sidecar, null, 2)
  const markdownText = `# Final fixture\n\n| Field | Value |\n|-------|-------|\n| **Transcription quality** | ${options.batch ? 'batch' : 'streaming'} |\n\n## Transcript\n\n${transcript}\n`
  writeFileSync(sidecarPath, sidecarText)
  writeFileSync(meetingPath, markdownText)
  const home = fakeNemotronHome()
  roots.push(home)
  return { dir, audioDir, meetingPath, sidecarPath, home, transcript, sidecarText, markdownText }
}

/** The fake CLI: the timeline WAV must be 8 x 6 s placed at elapsed (+1 s pad); answers with SPANS. */
function fakeRun(seen: { wavSec?: number; options?: RunNemotronOptions } = {}) {
  return vi.fn(async (options: RunNemotronOptions) => {
    seen.options = options
    seen.wavSec = (readFileSync(options.wavPath).length - 44) / 32_000
    return activityOf(49, SPANS)
  })
}

const opts = (f: Fixture, run: ReturnType<typeof fakeRun>, extra: Record<string, unknown> = {}) => ({
  meetingPath: f.meetingPath, sidecarPath: f.sidecarPath, audioDir: f.audioDir,
  env: { COS_DIARIZER: 'nemotron' }, home: f.home, run, log: () => {}, ...extra,
})

describe('the save-time final pass', () => {
  it('final relabel with consistent tracks: one map for the whole meeting, original labels kept', async () => {
    const f = meeting({ batch: true })
    const seen: { wavSec?: number; options?: RunNemotronOptions } = {}
    const outcome = await runNemotronFinalPass(opts(f, fakeRun(seen)))
    expect(outcome).toMatchObject({ status: 'applied', mode: 'batch', mapped: { 0: 'MU', 1: 'Silas Larson' } })
    expect(seen.wavSec).toBeCloseTo(49, 3)
    expect(seen.options).toMatchObject({ computeUnits: 'ane' })
    expect(seen.options!.modelsDir).toBe(join(f.home, '.cos-glasses', 'models', 'nemotron-3-diarization'))

    const sidecar = JSON.parse(readFileSync(f.sidecarPath, 'utf8'))
    const words = sidecar.batchSegments.flatMap((s: any) => s.speakerWords)
    const label = (w: string) => words.find((x: any) => x.word === w)
    // The second half of chunk 5 was Silas all along; chunk 7's unsure Ext is Silas's channel.
    expect(label('charlie5')).toMatchObject({ speaker: 'Silas Larson', originalSpeaker: 'MU' })
    expect(label('delta5')).toMatchObject({ speaker: 'Silas Larson', originalSpeaker: 'MU' })
    expect(label('alpha5')).toEqual(expect.objectContaining({ speaker: 'MU' }))
    expect(label('alpha5').originalSpeaker).toBeUndefined()
    for (const w of wordsOf(7)) expect(label(w)).toMatchObject({ speaker: 'Silas Larson', originalSpeaker: 'Ext' })
    // Everything the voiceprint was sure of is untouched.
    for (const i of [0, 1, 2, 3, 4, 6]) for (const w of wordsOf(i)) expect(label(w)).toMatchObject({ speaker: WHO[i] })
    expect(outcome.words).toMatchObject({ total: 32, relabeled: 6 })

    const markdown = readFileSync(f.meetingPath, 'utf8')
    expect(markdown).toContain('[MU]: alpha4 bravo4 charlie4 delta4 alpha5 bravo5\n[Silas Larson]: charlie5 delta5 alpha6 bravo6 charlie6 delta6 alpha7 bravo7 charlie7 delta7\n')
    expect(markdown).toContain('| **Transcription quality** | batch |')
    expect(sameWords(f.transcript, markdown.split('## Transcript\n\n')[1])).toBe(true)
    expect(sidecar.diarization).toMatchObject({
      engine: 'nemotron3', variant: 'fast32', status: 'applied', mode: 'batch',
      channelMap: { 0: 'MU', 1: 'Silas Larson' }, originalTranscript: f.transcript,
    })
    expect(sidecar.batchTranscript).toBe(markdown.split('## Transcript\n\n')[1].replace(/\n$/, ''))
    expect(sidecar.lifecycleRevision).toBe(1)
    // A second run is a no-op.
    expect(await runNemotronFinalPass(opts(f, fakeRun()))).toMatchObject({ status: 'skipped', reason: 'already_applied' })
  })

  it('a failed relabel saves as today: a crashed or timed-out CLI changes no byte', async () => {
    for (const error of [new NemotronRunError('timeout', 'slow'), new NemotronRunError('cli_failed', 'exit 1')]) {
      const f = meeting({ batch: true })
      const run = vi.fn(async () => { throw error })
      const outcome = await runNemotronFinalPass(opts(f, run as never))
      expect(outcome).toMatchObject({ status: 'failed', reason: `nemotron_${error.reason}` })
      expect(readFileSync(f.sidecarPath, 'utf8')).toBe(f.sidecarText)
      expect(readFileSync(f.meetingPath, 'utf8')).toBe(f.markdownText)
    }
  })

  it('never loses a word: words cleaning changed or removed stay exactly as saved, and labels stay in step', async () => {
    // An inserted word (cleaning replaced one) keeps the turn it is in.
    const f = meeting({ batch: true })
    writeFileSync(f.meetingPath, f.markdownText.replace('alpha3', 'alpha3 inserted'))
    const edited = readTranscriptSection(readFileSync(f.meetingPath, 'utf8'))!
    expect(await runNemotronFinalPass(opts(f, fakeRun()))).toMatchObject({ status: 'applied' })
    const after = readTranscriptSection(readFileSync(f.meetingPath, 'utf8'))!
    expect(transcriptWords(after)).toEqual(transcriptWords(edited))
    expect(after).toContain('[Silas Larson]: alpha2 bravo2 charlie2 delta2 alpha3 inserted bravo3')

    // Sixteen words cleaning removed (more than the match window): never resurrected,
    // and the words after them still take their own channel's name.
    const g = meeting({ batch: true })
    const removed = [2, 3, 4, 5].flatMap(i => wordsOf(i))
    const trimmed = g.transcript.split('\n').map(line => {
      const [label, rest] = line.split(/(?<=\]):\s*/)
      const kept = rest.split(' ').filter(word => !removed.includes(word))
      return kept.length ? `${label}: ${kept.join(' ')}` : null
    }).filter(Boolean).join('\n')
    writeFileSync(g.meetingPath, g.markdownText.replace(g.transcript, trimmed))
    expect(await runNemotronFinalPass(opts(g, fakeRun()))).toMatchObject({ status: 'applied' })
    const relabelled = readTranscriptSection(readFileSync(g.meetingPath, 'utf8'))!
    expect(transcriptWords(relabelled)).toEqual(transcriptWords(trimmed))
    expect(relabelled).toBe('[MU]: alpha0 bravo0 charlie0 delta0 alpha1 bravo1 charlie1 delta1\n[Silas Larson]: alpha6 bravo6 charlie6 delta6 alpha7 bravo7 charlie7 delta7')
  })

  it('a human correction always wins: a corrected meeting is never relabelled', async () => {
    const f = meeting({ batch: true, correctionRevision: 1 })
    const run = fakeRun()
    expect(await runNemotronFinalPass(opts(f, run))).toMatchObject({ status: 'skipped', reason: 'human_corrected' })
    expect(run).not.toHaveBeenCalled()
    expect(readFileSync(f.meetingPath, 'utf8')).toBe(f.markdownText)
  })

  it('the voiceprint selected by COS_DIARIZER skips the pass without running anything', async () => {
    const f = meeting({ batch: true })
    const run = fakeRun()
    expect(await runNemotronFinalPass(opts(f, run, { env: { COS_DIARIZER: 'embedding' } }))).toMatchObject({ status: 'skipped', reason: 'embedding_requested' })
    expect(run).not.toHaveBeenCalled()
  })

  it('a streaming meeting is relabelled per chunk line, with originalSpeaker on the chunks', async () => {
    const f = meeting({ batch: false, liveSegments: true })
    const outcome = await runNemotronFinalPass(opts(f, fakeRun()))
    expect(outcome).toMatchObject({ status: 'applied', mode: 'streaming' })
    const markdown = readFileSync(f.meetingPath, 'utf8')
    expect(markdown).toContain('[MU]: alpha5 bravo5\n[Silas Larson]: charlie5 delta5\n[Silas Larson]: alpha6')
    expect(markdown).toContain('[Silas Larson]: alpha7 bravo7 charlie7 delta7')
    expect(markdown).toContain('| **Transcription quality** | streaming |')
    const sidecar = JSON.parse(readFileSync(f.sidecarPath, 'utf8'))
    const chunk7 = sidecar.chunkEntries[7].chunk
    expect(chunk7).toMatchObject({ speaker: 'Silas Larson', originalSpeaker: 'Ext' })
    expect(sidecar.chunks[7]).toMatchObject({ speaker: 'Silas Larson', originalSpeaker: 'Ext' })
    expect(sidecar.chunkEntries[5].chunk.finalSegments.map((s: any) => s.speaker)).toEqual(['MU', 'Silas Larson'])
    expect(sidecar.chunkEntries[0].chunk.originalSpeaker).toBeUndefined()
  })
})

describe('the meeting timeline and the channel map', () => {
  it('places each WAV at its real elapsed and drops a chunk whose audio hash disagrees', () => {
    const f = meeting({ batch: true, tamperWav: 3 })
    const entries = JSON.parse(readFileSync(f.sidecarPath, 'utf8')).chunkEntries as SidecarEntry[]
    const timeline = buildMeetingTimeline(entries, f.audioDir)
    expect(timeline.excluded).toEqual({ missing: 0, hashMismatch: 1, unreadable: 0 })
    expect(timeline.windows.map(w => w.chunkIndex)).toEqual([0, 1, 2, 4, 5, 6, 7])
    expect(timeline.byIndex.get(4)!.start).toBe(24)
    // Chunk 2 has no successor on the timeline until chunk 4, so it is not trimmed.
    expect(timeline.byIndex.get(2)!.end).toBe(18)
  })

  it('trims only the tail that would run into the next chunk', () => {
    const f = meeting({ batch: true })
    const entries = JSON.parse(readFileSync(f.sidecarPath, 'utf8')).chunkEntries as SidecarEntry[]
    entries[1].chunk.elapsed = 4000 // chunk 0 is 6 s long; chunk 1 now starts at 4 s
    const timeline = buildMeetingTimeline(entries, f.audioDir)
    expect(timeline.byIndex.get(0)!.end).toBe(4)
    expect(timeline.byIndex.get(1)!.start).toBe(4)
  })

  it('a channel two people share stays unmapped, and too little evidence maps nothing', () => {
    const a = activityOf(30, [[0, 0, 30]])
    const window = (i: number, speaker: string) => ({ chunkIndex: i, start: i * 6, end: i * 6 + 6, chunk: { text: 'x', speaker, similarity: 0.8, elapsed: i * 6000 } as never })
    const shared = mapChannelsToNames([window(0, 'MU'), window(1, 'MU'), window(2, 'Silas Larson'), window(3, 'MU'), window(4, 'Silas Larson')], a)
    expect(shared.map.size).toBe(0)
    expect(shared.evidence[0]).toMatchObject({ channel: 0, name: null, support: 5, top: 'MU' })
    const thin = mapChannelsToNames([window(0, 'MU'), window(1, 'MU')], a)
    expect(thin.map.size).toBe(0)
    const sure = mapChannelsToNames([window(0, 'MU'), window(1, 'MU'), window(2, 'MU')], a)
    expect(sure.map.get(0)).toBe('MU')
    // Unsure or unnamed chunks are never evidence.
    const unsure = mapChannelsToNames([0, 1, 2].map(i => ({ ...window(i, 'MU'), chunk: { text: 'x', speaker: 'MU', similarity: 0.6, elapsed: 0 } as never })), a)
    expect(unsure.eligible).toBe(0)
  })
})
