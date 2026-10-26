// 6.90.0: unnamed, meeting-stable `Voice N` labels for Mac recordings.
//
// Every fixture is a Mac recording as the save path writes it: `sourceType`
// mac_system_audio, a `mac_` id, every chunk strict (`high-confidence`) and `Ext`
// at similarity 0, no Even Hub role. The fake CLI answers with fixed channel
// spans. Fictional content only; no transcript text from a real meeting.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { selectBatchTranscriptForPersistence } from './batch-transcript-quality.js'
import { cleanTranscriptLines } from './hallucination-filter.js'
import type { RunNemotronOptions } from './nemotron-cli.js'
import {
  buildMeetingTimeline,
  mapChannelsToVoices,
  mapChannelsToLiveVoices,
  numberVoices,
  readTranscriptSection,
  runNemotronFinalPass,
  sameWords,
  unnamedVoicesEligible,
  VOICE_MIN_SUPPORT,
  type SidecarBatchSegment,
  type SidecarEntry,
} from './nemotron-final.js'
import { activityOf, fakeNemotronHome, wavOf } from './__fixtures__/nemotron-helpers.js'

const roots: string[] = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir }

const MAC_ID = 'mac_0a1b2c3d-0000-4000-8000-000000000001'
const CHUNK_SEC = 6
const WORD_AT = [0.5, 1.8, 3.2, 4.6]
const wordsOf = (i: number) => ['alpha', 'bravo', 'charlie', 'delta'].map(w => `${w}${i}`)

// Eight 6 s chunks: channel 0 holds 0-12 s and 24-32.5 s, channel 1 holds 12-24 s and 32.5-48 s.
// One-sided chunks: channel 0 in 0, 1, 4; channel 1 in 2, 3, 6, 7. Chunk 5 is split (2.5 s / 3.5 s).
const TWO_VOICES: Array<[number, number, number]> = [[0, 0, 12], [1, 12, 24], [0, 24, 32.5], [1, 32.5, 48]]

interface Fixture { dir: string; audioDir: string; meetingPath: string; sidecarPath: string; home: string; transcript: string; sidecarText: string; markdownText: string }

function macMeeting(options: {
  batch: boolean
  chunks?: number
  mutate?: (chunk: Record<string, unknown>, i: number) => void
  sidecarExtra?: Record<string, unknown>
} = { batch: true }): Fixture {
  const n = options.chunks ?? 8
  const dir = temp('mac-voices-')
  const audioDir = join(dir, 'pending')
  mkdirSync(audioDir)
  const entries: SidecarEntry[] = []
  for (let i = 0; i < n; i++) {
    const wav = wavOf(CHUNK_SEC, () => (i + 1) * 10)
    writeFileSync(join(audioDir, `chunk_${String(i).padStart(4, '0')}.wav`), wav)
    const chunk: Record<string, unknown> = {
      text: wordsOf(i).join(' '),
      speaker: 'Ext',
      elapsed: i * CHUNK_SEC * 1000,
      similarity: 0,
      speakerPolicy: 'high-confidence',
      segments: [{ speaker: 'Ext', text: wordsOf(i).join(' '), startSec: 0, endSec: CHUNK_SEC, similarity: 0 }],
      audioSha256: createHash('sha256').update(wav).digest('hex'),
    }
    options.mutate?.(chunk, i)
    entries.push({ chunkIndex: i, chunk: chunk as never })
  }
  const batchSegments: SidecarBatchSegment[] = []
  for (let first = 0; first < n; first += 4) {
    const last = Math.min(n, first + 4) - 1
    const speakerWords = [] as SidecarBatchSegment['speakerWords']
    for (let i = first; i <= last; i++) {
      wordsOf(i).forEach((word, k) => {
        const start = (i - first) * CHUNK_SEC + WORD_AT[k]
        speakerWords.push({ word, start, end: start + 0.6, speaker: 'Ext', similarity: 0 })
      })
    }
    batchSegments.push({
      startChunkIdx: first, endChunkIdx: last, startElapsed: first * CHUNK_SEC * 1000, endElapsed: last * CHUNK_SEC * 1000,
      text: speakerWords.map(w => w.word).join(' '), words: [], speakerWords,
    })
  }
  const transcript = options.batch
    ? cleanTranscriptLines(selectBatchTranscriptForPersistence('', batchSegments).text)
    : entries.map(e => `[${e.chunk.speaker}]: ${e.chunk.text}`).join('\n')
  const sidecar = {
    schemaVersion: 2,
    sourceType: 'mac_system_audio',
    captureSource: 'mac_system_audio',
    sessionId: MAC_ID,
    speakers: [],
    chunks: entries.map(e => e.chunk),
    chunkEntries: entries,
    batchApplied: options.batch,
    ...(options.batch ? { batchSegments, batchTranscript: transcript } : {}),
    ...(options.sidecarExtra ?? {}),
  }
  const meetingPath = join(dir, '2026-10-23_Mac_fixture.md')
  const sidecarPath = meetingPath.replace(/\.md$/, '.g2-chunks.json')
  const sidecarText = JSON.stringify(sidecar, null, 2)
  const markdownText = `# Mac fixture\n\n| Field | Value |\n|-------|-------|\n| **Capture source** | mac_system_audio |\n\n## Transcript\n\n${transcript}\n`
  writeFileSync(sidecarPath, sidecarText)
  writeFileSync(meetingPath, markdownText)
  const home = fakeNemotronHome()
  roots.push(home)
  return { dir, audioDir, meetingPath, sidecarPath, home, transcript, sidecarText, markdownText }
}

function fakeRun(spans: Array<[number, number, number]>, durationSec = 49) {
  return vi.fn(async (_options: RunNemotronOptions) => activityOf(durationSec, spans))
}

const opts = (f: Fixture, run: ReturnType<typeof fakeRun>, env: Record<string, string> = {}) => ({
  meetingPath: f.meetingPath, sidecarPath: f.sidecarPath, audioDir: f.audioDir,
  env: { COS_DIARIZER: 'nemotron', ...env }, home: f.home, run, log: () => {},
  // The wearer exists on this Mac. Unnamed mode must never consult it.
  owner: 'Rowan Vale',
})

const unchanged = (f: Fixture) => {
  expect(readFileSync(f.sidecarPath, 'utf8')).toBe(f.sidecarText)
  expect(readFileSync(f.meetingPath, 'utf8')).toBe(f.markdownText)
}
const labelsOf = (transcript: string) => transcript.split('\n').map(line => /^\[([^\]]+)\]:/.exec(line)?.[1] ?? null)

describe('6.90.0 Mac recordings: unnamed meeting-stable voices', () => {
  it('batch: two channels become Voice 1 and Voice 2 by first speech; nothing names anyone', async () => {
    const f = macMeeting({ batch: true })
    const run = fakeRun(TWO_VOICES)
    const outcome = await runNemotronFinalPass(opts(f, run))
    expect(run).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ status: 'applied', unnamed: true, voices: 2, mode: 'batch', crowded: false, mapped: { 0: 'Voice 1', 1: 'Voice 2' } })

    const after = readTranscriptSection(readFileSync(f.meetingPath, 'utf8'))!
    expect(sameWords(f.transcript, after)).toBe(true)
    expect(after).toBe([
      '[Voice 1]: alpha0 bravo0 charlie0 delta0 alpha1 bravo1 charlie1 delta1',
      '[Voice 2]: alpha2 bravo2 charlie2 delta2 alpha3 bravo3 charlie3 delta3',
      '[Voice 1]: alpha4 bravo4 charlie4 delta4 alpha5 bravo5',
      '[Voice 2]: charlie5 delta5 alpha6 bravo6 charlie6 delta6 alpha7 bravo7 charlie7 delta7',
    ].join('\n'))

    const sidecar = JSON.parse(readFileSync(f.sidecarPath, 'utf8'))
    // Chunk labels lead the relabel route: each chunk takes the voice with most of its words.
    const expected = ['Voice 1', 'Voice 1', 'Voice 2', 'Voice 2', 'Voice 1', 'Voice 1', 'Voice 2', 'Voice 2']
    expect(sidecar.chunks.map((c: any) => c.speaker)).toEqual(expected)
    expect(sidecar.chunkEntries.map((e: any) => e.chunk.speaker)).toEqual(expected)
    for (const chunk of sidecar.chunks) expect(chunk.originalSpeaker).toBe('Ext')
    // A placeholder is never a speaker name, and the wearer was never borrowed.
    expect(sidecar.speakers).toEqual([])
    expect(JSON.stringify(sidecar)).not.toContain('Rowan Vale')
    expect(sidecar.diarization).toMatchObject({ status: 'applied', labels: 'unnamed', mode: 'batch', channelMap: { 0: 'Voice 1', 1: 'Voice 2' }, originalTranscript: f.transcript })
    expect(sidecar.diarization.mapping).toMatchObject({ unnamed: true, voices: 2, minSupport: VOICE_MIN_SUPPORT })
    expect(sidecar.batchTranscript).toBe(after)
    // Every batch word keeps where it came from.
    const words = sidecar.batchSegments.flatMap((s: any) => s.speakerWords)
    expect(words.find((w: any) => w.word === 'charlie5')).toMatchObject({ speaker: 'Voice 2', originalSpeaker: 'Ext' })
    // Meeting-stable: a second run changes nothing.
    expect(await runNemotronFinalPass(opts(f, fakeRun(TWO_VOICES)))).toMatchObject({ status: 'skipped', reason: 'already_applied' })
  })

  it('streaming: the same voices, written into chunk turns and the transcript', async () => {
    const f = macMeeting({ batch: false })
    const outcome = await runNemotronFinalPass(opts(f, fakeRun(TWO_VOICES)))
    expect(outcome).toMatchObject({ status: 'applied', unnamed: true, voices: 2, mode: 'streaming' })
    const after = readTranscriptSection(readFileSync(f.meetingPath, 'utf8'))!
    expect(sameWords(f.transcript, after)).toBe(true)
    expect(labelsOf(after)).toEqual(['Voice 1', 'Voice 1', 'Voice 2', 'Voice 2', 'Voice 1', 'Voice 1', 'Voice 2', 'Voice 2', 'Voice 2'])
    const sidecar = JSON.parse(readFileSync(f.sidecarPath, 'utf8'))
    expect(sidecar.chunks[5].finalSegments.map((s: any) => s.speaker)).toEqual(['Voice 1', 'Voice 2'])
    expect(sidecar.speakers).toEqual([])
  })

  it.each(['0', 'false', 'off', 'no', ' OFF '])('COS_MAC_VOICE_LABELS=%j: the 6.89.0 skip, the CLI never runs, no byte changes', async value => {
    const f = macMeeting({ batch: true })
    const run = fakeRun(TWO_VOICES)
    expect(await runNemotronFinalPass(opts(f, run, { COS_MAC_VOICE_LABELS: value }))).toMatchObject({ status: 'skipped', reason: 'speaker_policy' })
    expect(run).not.toHaveBeenCalled()
    unchanged(f)
  })

  it('on by default: unset, empty or 1 all run the pass', async () => {
    for (const env of [{}, { COS_MAC_VOICE_LABELS: '' }, { COS_MAC_VOICE_LABELS: '1' }] as Array<Record<string, string>>) {
      const f = macMeeting({ batch: true })
      expect(await runNemotronFinalPass(opts(f, fakeRun(TWO_VOICES), env))).toMatchObject({ status: 'applied', unnamed: true })
    }
  })

  it('a crowded room stays Ext: five confident voices is more than one meeting-wide map holds', async () => {
    const f = macMeeting({ batch: true, chunks: 15 })
    const spans: Array<[number, number, number]> = [0, 1, 2, 3, 4].map(c => [c, c * 18, c * 18 + 18])
    const outcome = await runNemotronFinalPass(opts(f, fakeRun(spans, 91)))
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'voices_crowded', crowded: true, identities: 5 })
    unchanged(f)
  })

  it('a room with no confident channel stays Ext: two supporting chunks each is not enough', async () => {
    const f = macMeeting({ batch: true })
    const outcome = await runNemotronFinalPass(opts(f, fakeRun([[0, 0, 12], [1, 12, 24]])))
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'voices_unconfident' })
    unchanged(f)
  })

  it('a quiet second voice stays Ext while the confident one is Voice 1', async () => {
    const f = macMeeting({ batch: true })
    // Channel 1 holds only chunks 2 and 3: below the support floor.
    const outcome = await runNemotronFinalPass(opts(f, fakeRun([[0, 0, 12], [1, 12, 24], [0, 24, 48]])))
    expect(outcome).toMatchObject({ status: 'applied', voices: 1, mapped: { 0: 'Voice 1' } })
    const after = readTranscriptSection(readFileSync(f.meetingPath, 'utf8'))!
    expect(new Set(labelsOf(after))).toEqual(new Set(['Voice 1', 'Ext']))
    expect(after).toContain('[Ext]: alpha2 bravo2 charlie2 delta2 alpha3 bravo3 charlie3 delta3')
  })

  it('a channel that leads chunks but carries no words is dropped, and numbering never skips', async () => {
    const f = macMeeting({ batch: true })
    // Channel 3 alone, 5.8-6.0 s, in chunks 0-2 (first to speak, no word under it); channel 0 holds 18-48 s.
    const spans: Array<[number, number, number]> = [[3, 5.8, 6], [3, 11.8, 12], [3, 17.8, 18], [0, 18, 48]]
    const outcome = await runNemotronFinalPass(opts(f, fakeRun(spans)))
    expect(outcome).toMatchObject({ status: 'applied', voices: 1, mapped: { 0: 'Voice 1' } })
    const after = readTranscriptSection(readFileSync(f.meetingPath, 'utf8'))!
    expect(after).not.toContain('Voice 2')
    expect(after).toContain('[Voice 1]: alpha3')
  })

  it('a Mac chunk that already carries a real name is never overwritten with a placeholder', async () => {
    const f = macMeeting({ batch: true, mutate: (chunk, i) => { if (i === 3) { chunk.speaker = 'Dana Reyes'; chunk.similarity = 0.91 } } })
    const run = fakeRun(TWO_VOICES)
    expect(await runNemotronFinalPass(opts(f, run))).toMatchObject({ status: 'skipped', reason: 'speaker_policy' })
    expect(run).not.toHaveBeenCalled()
    unchanged(f)
  })

  it('a Mac sidecar with a Standard chunk is not a Mac strict capture: the 6.73.6 skip holds', async () => {
    const f = macMeeting({ batch: true, mutate: (chunk, i) => { if (i === 6) delete chunk.speakerPolicy } })
    const run = fakeRun(TWO_VOICES)
    expect(await runNemotronFinalPass(opts(f, run))).toMatchObject({ status: 'skipped', reason: 'speaker_policy' })
    expect(run).not.toHaveBeenCalled()
  })

  it('a strict glasses capture never takes Voice labels, switch on or off', async () => {
    const f = macMeeting({ batch: true, sidecarExtra: { sourceType: undefined, captureSource: undefined, sessionId: 'meeting_strict_g2' } })
    const run = fakeRun(TWO_VOICES)
    expect(await runNemotronFinalPass(opts(f, run, { COS_MAC_VOICE_LABELS: '1' }))).toMatchObject({ status: 'skipped', reason: 'speaker_policy' })
    expect(run).not.toHaveBeenCalled()
    unchanged(f)
  })

  it('a human correction still wins: a renamed Mac meeting is never relabelled', async () => {
    const f = macMeeting({ batch: true, sidecarExtra: { correctionRevision: 1 } })
    const run = fakeRun(TWO_VOICES)
    expect(await runNemotronFinalPass(opts(f, run))).toMatchObject({ status: 'skipped', reason: 'human_corrected' })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the pieces', () => {
  it('eligibility: Mac, switch on, every chunk strict, no real name', () => {
    const chunk = (over: Record<string, unknown> = {}) => ({ text: 'x', speaker: 'Ext', elapsed: 0, similarity: 0, speakerPolicy: 'high-confidence', ...over }) as never
    const entries = [{ chunkIndex: 0, chunk: chunk() }]
    const mac = { sourceType: 'mac_system_audio' }
    expect(unnamedVoicesEligible(mac, entries, [chunk()], {})).toBe(true)
    expect(unnamedVoicesEligible({ sessionId: MAC_ID }, entries, [chunk()], {})).toBe(true)
    expect(unnamedVoicesEligible({ sessionId: 'meeting_x' }, entries, [chunk()], {})).toBe(false)
    expect(unnamedVoicesEligible(mac, entries, [chunk()], { COS_MAC_VOICE_LABELS: '0' })).toBe(false)
    expect(unnamedVoicesEligible(mac, entries, [chunk({ speakerPolicy: 'anonymous' })], {})).toBe(false)
    expect(unnamedVoicesEligible(mac, entries, [chunk({ speaker: 'Dana Reyes' })], {})).toBe(false)
    // Placeholders are not names: Unknown, Unidentified 2 and an earlier Voice label all pass.
    for (const speaker of ['Unknown', 'Unidentified 2', 'Voice 3']) expect(unnamedVoicesEligible(mac, entries, [chunk({ speaker })], {})).toBe(true)
    expect(unnamedVoicesEligible(mac, [], [], {})).toBe(false)
    // A text-less entry (an empty completion) is saved with no policy marker: allowed. A text-less
    // entry marked anything but strict, or a spoken chunk with no marker, still refuses.
    const silent = (over: Record<string, unknown> = {}) => ({ chunkIndex: 1, chunk: { text: '', speaker: 'Ext', elapsed: 6000, similarity: 0, ...over } as never })
    expect(unnamedVoicesEligible(mac, [...entries, silent()], [chunk()], {})).toBe(true)
    expect(unnamedVoicesEligible(mac, [...entries, silent({ speakerPolicy: 'high-confidence' })], [chunk()], {})).toBe(true)
    expect(unnamedVoicesEligible(mac, [...entries, silent({ speakerPolicy: 'anonymous' })], [chunk()], {})).toBe(false)
    expect(unnamedVoicesEligible(mac, [...entries, silent({ speakerPolicy: 'standard' })], [chunk()], {})).toBe(false)
    expect(unnamedVoicesEligible(mac, [{ chunkIndex: 0, chunk: chunk({ speakerPolicy: undefined }) }], [chunk()], {})).toBe(false)
    expect(unnamedVoicesEligible(mac, [{ chunkIndex: 0, chunk: silent().chunk }], [], {})).toBe(false)
  })

  it('a real Mac sidecar shape: text-less entries with no policy marker still get voices', async () => {
    const f = macMeeting({ batch: false, chunks: 9, mutate: (chunk, i) => { if (i === 8) { chunk.text = ''; delete chunk.speakerPolicy; delete chunk.segments } } })
    // As the store writes it: `chunks` holds text-bearing chunks only, and so does the transcript.
    const doc = JSON.parse(f.sidecarText)
    doc.chunks = doc.chunks.filter((c: any) => c.text)
    writeFileSync(f.sidecarPath, JSON.stringify(doc, null, 2))
    writeFileSync(f.meetingPath, f.markdownText.replace(/\n\[Ext\]: \n/, '\n'))
    expect(readFileSync(f.meetingPath, 'utf8')).not.toContain('[Ext]: \n')
    const outcome = await runNemotronFinalPass(opts(f, fakeRun(TWO_VOICES, 55)))
    expect(outcome).toMatchObject({ status: 'applied', unnamed: true, voices: 2, mode: 'streaming' })
  })

  it('voices are numbered by first speech, and a split chunk is never support', async () => {
    const f = macMeeting({ batch: true })
    const entries = JSON.parse(f.sidecarText).chunkEntries as SidecarEntry[]
    const timeline = await buildMeetingTimeline(entries, f.audioDir)
    // Channel 5 speaks first here, so it is Voice 1 although its number is higher.
    const a = activityOf(49, [[5, 0, 12], [2, 12, 24], [5, 24, 32.5], [2, 32.5, 48]])
    const found = mapChannelsToVoices(timeline.windows, a)
    expect(found.channels).toEqual([5, 2])
    expect(found.evidence).toEqual([
      { channel: 5, support: 3, firstSec: 0, accepted: true },
      { channel: 2, support: 4, firstSec: 12, accepted: true },
    ])
    expect(found.eligible).toBe(7)
    expect([...numberVoices(found.channels)]).toEqual([[5, 'Voice 1'], [2, 'Voice 2']])
    expect(mapChannelsToVoices(timeline.windows, a, { minSupport: 4 }).channels).toEqual([2])
  })
})


describe('final pass preserves live anonymous label numbers', () => {
  it.each([true,false])('never renumbers established voices after save (batch=%s)',async batch=>{
    const f=macMeeting({batch,mutate:(chunk,i)=>{
      const label=[0,1,4,5].includes(i)?'Voice 2':'Voice 1'
      chunk.speaker=label
      chunk.segments=[{speaker:label,text:chunk.text,startSec:0,endSec:6,similarity:0}]
    }})
    const outcome=await runNemotronFinalPass(opts(f,fakeRun(TWO_VOICES)))
    expect(outcome).toMatchObject({status:'applied',mapped:{0:'Voice 2',1:'Voice 1'}})
    const sidecar=JSON.parse(readFileSync(f.sidecarPath,'utf8'))
    expect(sidecar.chunks[0].speaker).toBe('Voice 2')
    expect(sidecar.chunks[2].speaker).toBe('Voice 1')
    expect(sidecar.speakers).toEqual([])
  })
  it('withholds conflicting channel claims and a live voice split across channels',async()=>{
    const f=macMeeting({batch:false,mutate:(chunk,i)=>{
      chunk.speaker=i%2?'Voice 2':'Voice 1'
      chunk.segments=[{speaker:chunk.speaker,text:chunk.text,startSec:0,endSec:6,similarity:0}]
    }})
    const sidecar=JSON.parse(f.sidecarText)
    const timeline=await buildMeetingTimeline(sidecar.chunkEntries,f.audioDir)
    expect([...mapChannelsToLiveVoices(timeline.windows,activityOf(49,TWO_VOICES))]).toEqual([])
    expect(await runNemotronFinalPass(opts(f,fakeRun(TWO_VOICES)))).toMatchObject({status:'skipped',reason:'voices_unconfident'})
    unchanged(f)
    for(const w of timeline.windows){
      const label=w.chunkIndex===1||w.chunkIndex===4?'Voice 2':'Voice 1'
      w.chunk.speaker=label;w.chunk.segments=[{speaker:label,text:w.chunk.text}]
    }
    // Channel 0 conflicts between both voices. Voice 1 is therefore NOT safe to
    // promote on channel 1 just because that channel alone has no contradiction.
    expect([...mapChannelsToLiveVoices(timeline.windows,activityOf(49,TWO_VOICES))]).toEqual([])
    for(const w of timeline.windows){w.chunk.speaker='Voice 1';w.chunk.segments=[{speaker:'Voice 1',text:w.chunk.text}]}
    expect([...mapChannelsToLiveVoices(timeline.windows,activityOf(49,TWO_VOICES))]).toEqual([])
  })
  it('never numbers an unproven final channel in a capture with a live voice',async()=>{
    const f=macMeeting({batch:true,mutate:(chunk,i)=>{
      if(![0,1,4].includes(i))return
      chunk.speaker='Voice 3';chunk.segments=[{speaker:'Voice 3',text:chunk.text,startSec:0,endSec:6,similarity:0}]
    }})
    expect(await runNemotronFinalPass(opts(f,fakeRun(TWO_VOICES)))).toMatchObject({status:'applied',mapped:{0:'Voice 3'},voices:1})
    const after=readTranscriptSection(readFileSync(f.meetingPath,'utf8'))!
    expect(after).toContain('[Voice 3]');expect(after).not.toContain('[Voice 1]');expect(after).not.toContain('[Voice 2]')
  })
})
