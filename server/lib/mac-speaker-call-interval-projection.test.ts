import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { MacSpeaker256Group } from './mac-speaker-live-memory.js'
import { createMacSpeakerCallIntervalProjector, prepareMacSpeakerCallIntervalSupport, validateMacSpeakerCallIntervalSupport, type MacSpeakerCallIntervalContext, type MacSpeakerCallIntervalSupport, type MacSpeakerCallNativeInterval } from './mac-speaker-call-interval-projection.js'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const seal = (s: MacSpeakerCallIntervalSupport) => { const { supportSHA256: _, ...body } = s; s.supportSHA256 = hash(JSON.stringify(body)); return s }
function fixture(starts = [0, 16000, 32000]) {
  const rawBindings = starts.map((startSample, rawChunkIndex) => ({ rawChunkIndex, startSample, endSample: startSample + 16000, audioSHA256: hash(`wav${rawChunkIndex}`), pcmSHA256: hash(`pcm${rawChunkIndex}`), originalRowSHA256: hash(`row${rawChunkIndex}`) }))
  const id = `fluid256_${hash('one')}`, other = `fluid256_${hash('two')}`
  const witnesses = [0, 2].map((raw, i) => ({ evidenceId: hash(`evidence${i}`), startSample: starts[raw], endSample: starts[raw] + 16000, originalVoice: `Voice ${i + 1}`, rawChunkIndices: [raw], pcmSHA256s: [rawBindings[raw].pcmSHA256] }))
  const group: MacSpeaker256Group = { identityId: id, nativeCluster: 'S1', memberVoices: ['Voice 1', 'Voice 2'], keepVoiceHint: 'Voice 1', groupSHA256: hash('group'), witnesses, intervals: rawBindings.map(r => ({ ...r, identityId: id, originalVoice: 'Voice 1', evidenceIds: witnesses.map(w => w.evidenceId), timingBasis: 'native-exclusive-intersect-machine-production' })) }
  const context: MacSpeakerCallIntervalContext = { rawBindings, groups: [group], displayLabels: { [id]: 'Anonymous group 1' }, protectedRawChunkIndices: [] }
  const nativeIntervals: MacSpeakerCallNativeInterval[] = rawBindings.map(r => ({ startSample: r.startSample, endSample: r.endSample, nativeCluster: 'S1' }))
  const source = { version: 1 as const, membership: 'accepted-only' as const, sourceSHA256: hash('bound-source-state-model-ledger'), nativeSHA256: hash('native'), timelinePCMSHA256: hash('timeline'), totalSamples: Math.max(...rawBindings.map(r => r.endSample)), rawUsedSamples: rawBindings.map(r => r.endSample - r.startSample), nativeIntervals }
  const doc: any = { correctionRevision: 1, speakerRepair: { machineEvidence: { untouched: hash('proof') } }, chunkEntries: rawBindings.map(r => ({ chunkIndex: r.rawChunkIndex, chunk: { text: `raw ${r.rawChunkIndex}`, speaker: 'Voice 1', elapsed: r.startSample / 16, segments: [{ speaker: 'Voice 1', startSec: 0, endSec: 1 }] } })), chunks: [], batchSegments: [{ startChunkIdx: 0, endChunkIdx: rawBindings.length - 1, speakerWords: [] }] }
  doc.chunks = structuredClone(doc.chunkEntries.map((e: any) => e.chunk))
  return { context, source, id, other, doc }
}
const word = (start: number, end: number, speaker = 'Ext') => ({ word: 'unchanged token', start, end, speaker, confidence: .91, language: 'en' })

describe('source-bound interval projection geometry', () => {
  it('exposes unprotected HQ source geometry without claiming a native identity', () => {
    const f = fixture(); f.context.groups[0].intervals = []
    f.doc.batchSegments[0].speakerWords = [word(.1, .2), word(.3, .4, 'Human Example'), { ...word(.5, .6), speaker: undefined }, { ...word(.7, .8), manuallyCorrected: true }]
    const p = createMacSpeakerCallIntervalProjector(f.context, prepareMacSpeakerCallIntervalSupport(f.context, f.source))
    expect(p.hqWords(f.doc)).toEqual([])
    const sources = p.hqWordSources(f.doc)
    expect(sources.map(w => w.wordIndex)).toEqual([0, 1, 2])
    expect(sources.every(w => !('identityId' in w) && w.pieces.length === 1)).toBe(true)
    expect(sources[0]).toMatchObject({ startElapsedMs: 100, endElapsedMs: 200, rawChunkIndices: [0] })
    sources[0].pieces[0].audioSHA256 = hash('mutated-return')
    expect(p.hqWordSources(f.doc)[0].pieces[0].audioSHA256).toBe(f.context.rawBindings[0].audioSHA256)
  })
  it.each([[0, 16001, 32001], [0, 15999, 32000]])('refuses manual source geometry over a gap or overlap %j', (...starts) => {
    const f = fixture(starts); f.context.groups[0].intervals = []; f.doc.batchSegments[0].speakerWords = [word(.9, 1.1)]
    f.source.rawUsedSamples = f.context.rawBindings.map((r, i, a) => Math.min(16000, i + 1 < a.length ? a[i + 1].startSample - r.startSample : Infinity))
    const p = createMacSpeakerCallIntervalProjector(f.context, prepareMacSpeakerCallIntervalSupport(f.context, f.source))
    expect(p.hqWordSources(f.doc)).toEqual([])
  })
  it('refuses manual source geometry on protected raw rows and truncated overlapping tails', () => {
    const f = fixture([0, 15999, 32000]); f.context.groups[0].intervals = []; f.context.protectedRawChunkIndices = [1]
    f.source.rawUsedSamples = [15999, 16000, 16000]
    f.doc.batchSegments[0].speakerWords = [word(.9999, 1), word(1.1, 1.2), word(2.1, 2.2)]
    const p = createMacSpeakerCallIntervalProjector(f.context, prepareMacSpeakerCallIntervalSupport(f.context, f.source))
    expect(p.hqWordSources(f.doc).map(w => w.wordIndex)).toEqual([2])
  })
  it('projects an Ext HQ word with no old-label alias and preserves every non-speaker byte', () => {
    const f = fixture(); f.doc.batchSegments[0].speakerWords = [word(.2, .4), word(1.2, 1.4, 'Voice 88')]
    const before = structuredClone(f.doc), support = prepareMacSpeakerCallIntervalSupport(f.context, f.source)
    const out = createMacSpeakerCallIntervalProjector(f.context, support).project(f.doc)
    expect(out.changedWords).toBe(2)
    expect(out.doc.batchSegments[0].speakerWords).toEqual(before.batchSegments[0].speakerWords.map((w: any) => ({ ...w, speaker: 'Anonymous group 1' })))
    expect(out.doc.correctionRevision).toBe(1); expect(out.doc.speakerRepair).toEqual(before.speakerRepair)
    expect(f.doc).toEqual(before)
  })
  it('covers a word crossing raw files only when every integer sample has the same identity', () => {
    const f = fixture(); f.doc.batchSegments[0].speakerWords = [word(.9, 1.1)]
    const s = prepareMacSpeakerCallIntervalSupport(f.context, f.source)
    expect(createMacSpeakerCallIntervalProjector(f.context, s).project(f.doc).changedWords).toBe(1)
    f.context.groups[0].intervals = f.context.groups[0].intervals.filter(i => i.rawChunkIndex !== 1)
    const gap = prepareMacSpeakerCallIntervalSupport(f.context, f.source)
    expect(createMacSpeakerCallIntervalProjector(f.context, gap).project(f.doc).changedWords).toBe(0)
  })
  it('rejects a cross-file word between different admitted identities even when an old number is reused', () => {
    const f = fixture([0, 16000, 32000, 48000, 64000]), first = f.context.groups[0]
    const second: MacSpeaker256Group = { ...structuredClone(first), identityId: f.other, nativeCluster: 'S2', memberVoices: ['Voice 3', 'Voice 4'], keepVoiceHint: 'Voice 3', groupSHA256: hash('group-two'), witnesses: [1, 3].map((raw, i) => ({ evidenceId: hash(`other-evidence${i}`), startSample: raw * 16000, endSample: (raw + 1) * 16000, originalVoice: `Voice ${i + 3}`, rawChunkIndices: [raw], pcmSHA256s: [f.context.rawBindings[raw].pcmSHA256] })), intervals: [] }
    f.context.groups = [first, second]; f.context.displayLabels = { [f.id]: 'Anonymous group 1', [f.other]: 'Anonymous group 2' }
    f.source.nativeIntervals = f.context.rawBindings.map(r => ({ startSample: r.startSample, endSample: r.endSample, nativeCluster: r.rawChunkIndex % 2 ? 'S2' : 'S1' }))
    f.doc.batchSegments[0].speakerWords = [word(.2, .4, 'Voice 1'), word(.9, 1.1, 'Voice 1'), word(1.2, 1.4, 'Voice 1')]
    const support = prepareMacSpeakerCallIntervalSupport(f.context, { ...f.source, membership: 'native-exclusive-members' })
    expect(createMacSpeakerCallIntervalProjector(f.context, support).project(f.doc).doc.batchSegments[0].speakerWords.map((w: any) => w.speaker)).toEqual(['Anonymous group 1', 'Voice 1', 'Anonymous group 2'])
  })
  it.each([[0, 16001, 32001], [0, 15999, 32000]])('rejects a cross-file word over capture gap/overlap %j', (...starts) => {
    const f = fixture(starts); f.doc.batchSegments[0].speakerWords = [word(.9, 1.1)]
    f.source.rawUsedSamples = f.context.rawBindings.map((r, i, a) => Math.min(16000, i + 1 < a.length ? a[i + 1].startSample - r.startSample : Infinity))
    f.context.groups[0].intervals = []
    const support = prepareMacSpeakerCallIntervalSupport(f.context, { ...f.source, membership: 'native-exclusive-members' })
    expect(createMacSpeakerCallIntervalProjector(f.context, support).project(f.doc).changedWords).toBe(0)
  })
  it('separates identity admission from optional native-exclusive member geometry', () => {
    const f = fixture(); f.context.groups[0].intervals = f.context.groups[0].intervals.filter(i => i.rawChunkIndex !== 1)
    f.doc.batchSegments[0].speakerWords = [word(1.2, 1.4)]
    const strict = prepareMacSpeakerCallIntervalSupport(f.context, f.source)
    expect(createMacSpeakerCallIntervalProjector(f.context, strict).project(f.doc).changedWords).toBe(0)
    const member = prepareMacSpeakerCallIntervalSupport(f.context, { ...f.source, membership: 'native-exclusive-members' })
    expect(createMacSpeakerCallIntervalProjector(f.context, member).project(f.doc).changedWords).toBe(1)
    expect(new Set(member.intervals.map(i => i.identityId))).toEqual(new Set([f.id]))
    expect(member.intervals.every(i => i.origin === 'native-exclusive-member' && i.evidenceIds.length === 2)).toBe(true)
  })
  it('subtracts a foreign unadmitted cluster and overlap without admitting it or bridging gaps', () => {
    const f = fixture(); f.doc.batchSegments[0].speakerWords = [word(1.2, 1.4), word(1.4, 1.6), word(1.6, 1.8)]
    f.source.nativeIntervals.push({ startSample: 1.4 * 16000, endSample: 1.6 * 16000, nativeCluster: 'S9' })
    const support = prepareMacSpeakerCallIntervalSupport(f.context, { ...f.source, membership: 'native-exclusive-members' })
    const projector = createMacSpeakerCallIntervalProjector(f.context, support), out = projector.project(f.doc)
    expect(out.doc.batchSegments[0].speakerWords.map((w: any) => w.speaker)).toEqual(['Anonymous group 1', 'Ext', 'Anonymous group 1'])
    expect(projector.identityFor(1, 1.39 * 16000, 1.61 * 16000)).toBeNull()
    expect(support.intervals.every(i => i.endSample <= 22400 || i.startSample >= 25600)).toBe(true)
  })
  it('never assigns a mixed root while retaining eligible sample-scoped nested/word fields', () => {
    const f = fixture(); f.context.groups[0].intervals[0].endSample = 8000
    f.doc.chunkEntries[0].chunk.segments = [{ speaker: 'Ext', startSec: 0, endSec: .5 }, { speaker: 'Voice 1', startSec: .5, endSec: 1 }]
    f.doc.chunks[0] = structuredClone(f.doc.chunkEntries[0].chunk)
    const out = createMacSpeakerCallIntervalProjector(f.context, prepareMacSpeakerCallIntervalSupport(f.context, f.source)).project(f.doc)
    expect(out.doc.chunks[0].speaker).toBe('Voice 1')
    expect(out.doc.chunks[0].segments.map((r: any) => r.speaker)).toEqual(['Anonymous group 1', 'Voice 1'])
  })
  it('keeps a long-gap return and short supported word without extending an old Voice outside support', () => {
    const f = fixture([0, 16000, 32000 + 60 * 16000]); f.context.groups[0].intervals = f.context.groups[0].intervals.filter(i => i.rawChunkIndex !== 1)
    f.doc.batchSegments[0].speakerWords = [word(.01, .02, 'Voice 77'), word(1.01, 1.02, 'Voice 77'), word(2.01, 2.02, 'Voice 77')]
    const out = createMacSpeakerCallIntervalProjector(f.context, prepareMacSpeakerCallIntervalSupport(f.context, f.source)).project(f.doc)
    expect(out.doc.batchSegments[0].speakerWords.map((r: any) => r.speaker)).toEqual(['Anonymous group 1', 'Voice 77', 'Anonymous group 1'])
  })
  it('preserves named words, human anonymous corrections and every field on protected raw rows', () => {
    const f = fixture(); f.context.protectedRawChunkIndices = [0]
    f.doc.batchSegments[0].speakerWords = [word(.1, .2), word(1.1, 1.2, 'Human Example'), { ...word(2.1, 2.2, 'Voice 77'), manuallyCorrected: true }]
    const before = structuredClone(f.doc), out = createMacSpeakerCallIntervalProjector(f.context, prepareMacSpeakerCallIntervalSupport(f.context, f.source)).project(f.doc)
    expect(out.doc.chunkEntries[0]).toEqual(before.chunkEntries[0]); expect(out.doc.chunks[0]).toEqual(before.chunks[0])
    expect(out.doc.batchSegments).toEqual(before.batchSegments)
  })
  it.each([100, 1024])('retains ordinal %i display labels independently of active group cardinality', ordinal => {
    const f = fixture(); f.context.displayLabels = { [f.id]: `Anonymous group ${ordinal}` }; f.doc.batchSegments[0].speakerWords = [word(.1, .2)]
    const out = createMacSpeakerCallIntervalProjector(f.context, prepareMacSpeakerCallIntervalSupport(f.context, f.source)).project(f.doc)
    expect(out.doc.batchSegments[0].speakerWords[0].speaker).toBe(`Anonymous group ${ordinal}`)
  })
  it.each(['missing', 'expanded', 'identity', 'audio', 'pcm', 'witness', 'used-prefix', 'native'])('rejects %s counterfeit support after an outer self-reseal', kind => {
    const f = fixture(), s = prepareMacSpeakerCallIntervalSupport(f.context, f.source)
    if (kind === 'missing') s.intervals.pop()
    if (kind === 'expanded') s.intervals[0].endSample++
    if (kind === 'identity') s.intervals[0].identityId = f.other
    if (kind === 'audio') s.intervals[0].audioSHA256 = hash('wrong-audio')
    if (kind === 'pcm') s.intervals[0].pcmSHA256 = hash('wrong-pcm')
    if (kind === 'witness') s.intervals[0].evidenceIds = []
    if (kind === 'used-prefix') s.rawUsedSamples[0]--
    if (kind === 'native') s.nativeIntervals[0].endSample--
    seal(s)
    expect(() => validateMacSpeakerCallIntervalSupport(f.context, s)).toThrow()
  })
  it('abstains on nonfinite, out-of-range, zero and ambiguous clocks while preserving token order', () => {
    const f = fixture(); f.doc.batchSegments[0].speakerWords = [word(NaN, .2), word(.1, Infinity), word(-.1, .2), word(.3, .3), word(2.9, 3.1), word(1e308, 1.1e308)]
    const before = structuredClone(f.doc), out = createMacSpeakerCallIntervalProjector(f.context, prepareMacSpeakerCallIntervalSupport(f.context, f.source)).project(f.doc)
    expect(out.changedWords).toBe(0); expect(out.doc.batchSegments).toEqual(before.batchSegments)
  })
  it('assigns zero unique samples outside admitted support across dense boundary queries', () => {
    const f = fixture(); f.context.groups[0].intervals = [{ ...f.context.groups[0].intervals[0], startSample: 2000, endSample: 8000 }, { ...f.context.groups[0].intervals[0], startSample: 9000, endSample: 12000 }]
    const p = createMacSpeakerCallIntervalProjector(f.context, prepareMacSpeakerCallIntervalSupport(f.context, f.source))
    const changed = new Set<number>()
    for (let lo = 0; lo < 16000; lo += 1000) for (let hi = lo + 1000; hi <= 16000; hi += 1000) if (p.identityFor(0, lo, hi)) for (let sample = lo; sample < hi; sample++) changed.add(sample)
    const outside = [...changed].filter(sample => !(sample >= 2000 && sample < 8000 || sample >= 9000 && sample < 12000))
    expect(changed.size).toBe(9000); expect(outside).toHaveLength(0)
  })
})
