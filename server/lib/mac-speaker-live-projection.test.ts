import { describe, expect, it } from 'vitest'
import { projectMacSpeakerLiveChunks, type MacSpeakerLiveProjectionSpan } from './mac-speaker-live-projection.js'
const captureId = 'mac_11111111-1111-4111-8111-111111111111'
const chunk = (i = 0) => ({ i, c: { text: 'Original words, punctuation intact.', speaker: 'Voice 7', elapsed: i * 6000,
  audioDurationMs: 6000, audioSha256: 'a'.repeat(64), similarity: 0,
  segments: [{ speaker: 'Voice 7', text: 'Original words, punctuation intact.', startSec: 0, endSec: 6, similarity: 0 }],
  finalSegments: [{ speaker: 'Voice 7', text: 'Original words, punctuation intact.', startSec: 0, endSec: 6 }],
  words: [{ word: 'Original', start: 0, end: 1 }, { word: 'words,', start: 1, end: 2, speaker: 'Voice 7' }], originalSpeaker: 'Ext' } })
const span = (i = 0): MacSpeakerLiveProjectionSpan => ({ rawChunkIndex: i, audioSHA256: 'a'.repeat(64), pcmSHA256: 'b'.repeat(64),
  startSample: i * 96000, endSample: (i + 1) * 96000, identityId: `acoustic_${'c'.repeat(64)}`, displayLabel: 'Qualified Person', profileName: 'Qualified Person', evidenceIds: ['window_one', 'window_two'] })
const input = () => ({ captureId, generation: 'generation-one', chunksIndexed: [chunk()], projections: [span()] })
describe('source-bound Mac live label projection', () => {
  it('backpatches only speaker fields, retaining capture diagnostics, words and clocks byte for byte', () => {
    const source = input(), before = JSON.stringify(source), out = projectMacSpeakerLiveChunks(source)
    expect(JSON.stringify(source)).toBe(before)
    const original = chunk(), expected = { ...original, c: { ...original.c, speaker: 'Qualified Person',
      segments: original.c.segments.map(s => ({ ...s, speaker: 'Qualified Person' })),
      finalSegments: original.c.finalSegments.map(s => ({ ...s, speaker: 'Qualified Person' })),
      words: original.c.words.map((w, i) => i === 1 ? { ...w, speaker: 'Qualified Person' } : w) } }
    expect(out.speakerProjectedChunksIndexed).toEqual([expected])
    expect(out.appliedRawChunkIndices).toEqual([0]); expect(out.withheld).toEqual([])
    expect(out.speakerProjectedChunksIndexed[0].c.similarity).toBe(0)
    expect(out.speakerProjectedChunksIndexed[0].c.originalSpeaker).toBe('Ext')
    expect(projectMacSpeakerLiveChunks(source)).toEqual(out)
  })
  it('withdraws an earlier claim by returning original rows in the full replacement', () => {
    const source = input(), named = projectMacSpeakerLiveChunks(source)
    const clear = projectMacSpeakerLiveChunks({ ...source, projections: [] })
    expect(clear.speakerProjectedChunksIndexed).toEqual(source.chunksIndexed)
    expect(clear.effectiveOverlaySHA256).not.toBe(named.effectiveOverlaySHA256)
  })
  it('does not change the effective revision digest for unrelated new ASR', () => {
    const source = input(), before = projectMacSpeakerLiveChunks(source)
    const after = projectMacSpeakerLiveChunks({ ...source, chunksIndexed: [...source.chunksIndexed, chunk(1)] })
    expect(after.effectiveOverlaySHA256).toBe(before.effectiveOverlaySHA256)
    expect(after.sourceBindingSHA256).not.toBe(before.sourceBindingSHA256)
    expect(after.speakerProjectedChunksIndexed).toHaveLength(2)
  })
  it.each(['audioSha256', 'audioDurationMs', 'elapsed'] as const)('withdraws on source %s drift', key => {
    const source = input(); Object.assign(source.chunksIndexed[0].c, { [key]: key === 'audioSha256' ? 'd'.repeat(64) : 123 })
    const out = projectMacSpeakerLiveChunks(source)
    expect(out.appliedRawChunkIndices).toEqual([])
    expect(out.speakerProjectedChunksIndexed).toEqual(source.chunksIndexed)
    expect(out.withheld).toEqual([{ rawChunkIndex: 0, reason: 'original_binding_changed' }])
  })
  for (const surface of ['root', 'segments', 'finalSegments', 'words']) for (const marker of ['speakerOrigin', 'manuallyCorrected']) {
    it(`protects ${marker} on ${surface}, including unlabeled words`, () => {
      const source = input(), c = source.chunksIndexed[0].c as any
      const row = surface === 'root' ? c : c[surface][0]
      row[marker] = marker === 'speakerOrigin' ? 'manual' : true
      const out = projectMacSpeakerLiveChunks(source)
      expect(out.speakerProjectedChunksIndexed).toEqual(source.chunksIndexed)
      expect(out.withheld[0].reason).toBe('protected_or_mixed_original')
    })
  }
  it.each(['root', 'segments', 'finalSegments', 'words'])('protects existing names on %s', surface => {
    const source = input(), c = source.chunksIndexed[0].c as any
    ;(surface === 'root' ? c : c[surface][0]).speaker = 'Existing Person'
    expect(projectMacSpeakerLiveChunks(source).appliedRawChunkIndices).toEqual([])
  })
  it('refuses mixed automatic tracks rather than extending a full-chunk claim across another voice', () => {
    const source = input(); source.chunksIndexed[0].c.segments[0].speaker = 'Voice 8'
    expect(projectMacSpeakerLiveChunks(source).appliedRawChunkIndices).toEqual([])
  })
  it('allows backend-allocated stable anonymous labels and rejects identity/number collisions', () => {
    const source = input(); delete source.projections[0].profileName; source.projections[0].displayLabel = 'Voice 31'
    expect(projectMacSpeakerLiveChunks(source).speakerProjectedChunksIndexed[0].c.speaker).toBe('Voice 31')
    const second = { ...source.projections[0], rawChunkIndex: 1, startSample: 96000, endSample: 192000, identityId: `acoustic_${'d'.repeat(64)}` }
    expect(() => projectMacSpeakerLiveChunks({ ...source, chunksIndexed: [...source.chunksIndexed, chunk(1)], projections: [...source.projections, second] })).toThrow('duplicate Mac live voice label')
  })
  it('refuses overlapping raw clocks and collisions with unsupported original labels', () => {
    const source = input(), other = { ...span(1), startSample: 0, endSample: 96000 }
    expect(() => projectMacSpeakerLiveChunks({ ...source, chunksIndexed: [...source.chunksIndexed, chunk(1)], projections: [...source.projections, other] })).toThrow('overlapping Mac live originals')
    delete source.projections[0].profileName; source.projections[0].displayLabel = 'Voice 7'
    expect(() => projectMacSpeakerLiveChunks({ ...source, chunksIndexed: [...source.chunksIndexed, chunk(1)] })).toThrow('collides with original')
  })
  it.each(['duplicate', 'missing evidence', 'partial', 'wrong name'])('fails closed on malformed %s claims', kind => {
    const source = input()
    if (kind === 'duplicate') source.projections.push(span())
    if (kind === 'missing evidence') source.projections[0].evidenceIds = ['only_one']
    if (kind === 'partial') source.projections[0].endSample = 90000
    if (kind === 'wrong name') source.projections[0].displayLabel = 'Different Person'
    if (kind === 'partial') expect(projectMacSpeakerLiveChunks(source).appliedRawChunkIndices).toEqual([])
    else expect(() => projectMacSpeakerLiveChunks(source)).toThrow('invalid Mac live projection span')
  })
})
