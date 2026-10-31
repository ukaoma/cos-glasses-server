import { describe, expect, it } from 'vitest'
import { reviewMeetingSpeakers, type EffectiveSpeakerWordView, type ReviewChunk } from './meeting-speaker-review.js'

const effectiveWordView: EffectiveSpeakerWordView = { version: 1, unresolvedLabel: 'Ext', anonymousGroups: [
  { identityId: 'acoustic_a', label: 'Anonymous group 1' },
  { identityId: 'acoustic_b', label: 'Anonymous group 2' },
] }
const roots = (): ReviewChunk[] => [
  ...Array.from({ length: 59 }, (_, i) => ({ speaker: `Voice ${i + 1}`, text: `Original phrase ${i}`, elapsed: i * 1000, chunkIndex: i })),
  { speaker: 'Named Example', text: 'Original named phrase', elapsed: 60_000, chunkIndex: 70, similarity: .1 },
]
const words = () => [{ startElapsed: 10_000, speakerWords: [
  { start: 0, end: .5, speaker: 'Anonymous group 1' },
  { start: .4, end: .8, speaker: 'Anonymous group 1' },
  { start: 1, end: 1.5, speaker: 'Voice 39' },
  { start: 2, end: 2.5, speaker: 'Ext' },
  { start: 3, end: 3.5, speaker: 'Anonymous group 2' },
  { start: 5, end: 5.5, speaker: 'Named Example' },
] }]

describe('explicit interval view final-word review', () => {
  it('replaces the 59-number inventory with actual groups, preserved name and ONE speech remainder', () => {
    const chunks = roots(), batchSegments = words(), before = JSON.stringify({ chunks, batchSegments })
    const review = reviewMeetingSpeakers(chunks, { effectiveWordView, batchSegments,
      durationMs: 70_000, confirmed: new Set(['Named Example']) })
    expect(review.voices.map(v => v.label).sort()).toEqual(['Anonymous group 1', 'Anonymous group 2', 'Ext', 'Named Example'])
    expect(review.effectiveSpeakerSummary).toEqual({ version: 1, basis: 'source-bound-hq-words',
      anonymousGroupCount: 2, preservedAnonymousGroupCount: 0, namedVoiceCount: 1, withheldNameCount: 0,
      unresolvedSpeakingMs: 1000, unresolvedWordCount: 2, displayRowCount: 4 })
    expect(review.voices.find(v => v.label === 'Ext')).toMatchObject({ kind: 'unresolved', displayName: 'Unresolved speech', nameAsserted: false, speakingMs: 1000, phrases: [] })
    expect(review.voices.find(v => v.label === 'Anonymous group 1')).toMatchObject({ kind: 'anonymous-group', identityId: 'acoustic_a', nameAsserted: false, reliability: 'unattributed', machineQualified: false, speakingMs: 800, wordCount: 2, phrases: [] })
    expect(review.voices.find(v => v.label === 'Named Example')).toMatchObject({ nameAsserted: true, confirmedByHuman: true, segments: 1 })
    expect(JSON.stringify({ chunks, batchSegments })).toBe(before)
  })

  it('uses exactly the word clock for timeline and buckets, retaining silent gaps and overlapping labels', () => {
    const batchSegments = words()
    batchSegments[0].speakerWords.push({ start: .2, end: .6, speaker: 'Anonymous group 2' })
    const review = reviewMeetingSpeakers(roots(), { effectiveWordView, batchSegments, durationMs: 70_000 })
    expect(review.timeline).toEqual([
      { speaker: 'Anonymous group 1', startMs: 10_000, endMs: 10_800, segments: 2 },
      { speaker: 'Anonymous group 2', startMs: 10_200, endMs: 10_600, segments: 1 },
      { speaker: 'Ext', startMs: 11_000, endMs: 11_500, segments: 1 },
      { speaker: 'Ext', startMs: 12_000, endMs: 12_500, segments: 1 },
      { speaker: 'Anonymous group 2', startMs: 13_000, endMs: 13_500, segments: 1 },
      { speaker: 'Named Example', startMs: 15_000, endMs: 15_500, segments: 1 },
    ])
    expect(review.voicedMs).toBe(2800)
    expect(review.voicedMs + review.notCapturedMs).toBe(70_000)
    expect(review.timeline.some(t => /^Voice /.test(t.speaker))).toBe(false)
  })

  it('keeps the ten source-bound machine proof positions separate from anonymous word groups', () => {
    const chunks = roots().slice(0, 59)
    for (let i = 0; i < 10; i++) chunks.push({ speaker: 'Named Example', text: `Named original ${i}`, elapsed: 60_000 + i * 1000, chunkIndex: 100 + i, similarity: 0 })
    const proof = new Map(Array.from({ length: 10 }, (_, i) => [59 + i, { label: 'Named Example', rawChunkIndex: 100 + i,
      independentWindows: 2, minimumSimilarity: .9, minimumMargin: .08 }] as const))
    const before = JSON.stringify({ chunks, proof: [...proof] })
    const review = reviewMeetingSpeakers(chunks, { effectiveWordView, batchSegments: words(),
      machineEvidenceStatus: 'qualified', machineQualifiedPositions: proof as any })
    expect(review.voices.find(v => v.label === 'Named Example')).toMatchObject({ machineQualified: true, machineQualifiedSegments: 10, nameAsserted: true, assertionSource: 'qualified-profile' })
    expect(review.voices.filter(v => v.kind === 'anonymous-group').every(v => !v.machineQualified && !v.nameAsserted)).toBe(true)
    expect(JSON.stringify({ chunks, proof: [...proof] })).toBe(before)
  })

  it('preserves human numbered de-attribution rather than folding it into generic speech', () => {
    const batchSegments: any[] = words(); batchSegments[0].speakerWords.push({ start: 7, end: 8, speaker: 'Unidentified 3', manualSpeaker: true })
    const review = reviewMeetingSpeakers(roots(), { effectiveWordView, batchSegments })
    expect(review.voices.find(v => v.label === 'Unidentified 3')).toMatchObject({ kind: 'preserved-anonymous', nameAsserted: false, speakingMs: 1000 })
    expect(review.effectiveSpeakerSummary).toMatchObject({ preservedAnonymousGroupCount: 1, unresolvedWordCount: 2 })
  })

  it('normalizes every automatic projector placeholder to one remainder, including root-only Speaker 4', () => {
    const chunks = [...roots(), { speaker: 'Speaker 4', text: 'Automatic placeholder', elapsed: 64_000 },
      { speaker: 'Unidentified voice', text: 'Other automatic placeholder', elapsed: 66_000 }]
    const batchSegments = [{ speakerWords: ['Speaker 4', 'Unknown', 'Unidentified', 'Unidentified 7', 'unknown', 'Ext', 'Unidentified voice']
      .map((speaker, i) => ({ start: i * 2, end: i * 2 + 1, speaker })) }]
    const review = reviewMeetingSpeakers(chunks, { effectiveWordView, batchSegments })
    expect(review.voices.map(v => v.label).sort()).toEqual(['Ext', 'Named Example'])
    expect(review.voices.find(v => v.label === 'Ext')).toMatchObject({ kind: 'unresolved', wordCount: 7, speakingMs: 7000, nameAsserted: false })
    expect(review.effectiveSpeakerSummary).toMatchObject({ unresolvedWordCount: 7, anonymousGroupCount: 0 })
    expect(review.timeline.every(span => span.speaker === 'Ext')).toBe(true)
  })

  it('keeps a manually protected numbered word distinct without aliasing its unprotected siblings', () => {
    const batchSegments = [{ startElapsed: 10_000, speakerWords: [
      { start: 0, end: 1, speaker: 'Voice 39', manualSpeaker: true },
      { start: 2, end: 3, speaker: 'Voice 39' },
    ] }]
    const review = reviewMeetingSpeakers(roots(), { effectiveWordView, batchSegments })
    expect(review.voices.find(v => v.label === 'Voice 39')).toMatchObject({ kind: 'preserved-anonymous', speakingMs: 1000, wordCount: 1, phrases: [] })
    expect(review.voices.find(v => v.label === 'Ext')).toMatchObject({ kind: 'unresolved', speakingMs: 1000, wordCount: 1 })
    expect(review.effectiveSpeakerSummary).toMatchObject({ preservedAnonymousGroupCount: 1, unresolvedWordCount: 1 })
  })

  it('does not invent unused packet groups or erase a preserved named source row without HQ words', () => {
    const batchSegments = [{ speakerWords: [{ start: 0, end: 1, speaker: 'Ext' }] }]
    const review = reviewMeetingSpeakers(roots(), { effectiveWordView, batchSegments })
    expect(review.voices.map(v => v.label).sort()).toEqual(['Ext', 'Named Example'])
    expect(review.effectiveSpeakerSummary).toMatchObject({ anonymousGroupCount: 0, namedVoiceCount: 0, withheldNameCount: 1 })
  })

  it('retains stable ordinals after retired identities without counting them as names', () => {
    const effectiveWordView: EffectiveSpeakerWordView = { version: 1, unresolvedLabel: 'Ext', anonymousGroups: [
      { identityId: 'acoustic_a', label: 'Anonymous group 100' }, { identityId: 'acoustic_b', label: 'Anonymous group 1024' },
    ] }
    const review = reviewMeetingSpeakers(roots(), { effectiveWordView, batchSegments: [{ speakerWords: [
      { start: 0, end: 1, speaker: 'Anonymous group 100' }, { start: 2, end: 3, speaker: 'Anonymous group 1024' },
    ] }] })
    expect(review.effectiveSpeakerSummary?.anonymousGroupCount).toBe(2)
    expect(review.voices.filter(v => v.kind === 'anonymous-group').map(v => v.label)).toEqual(['Anonymous group 100', 'Anonymous group 1024'])
    expect(review.voices.filter(v => v.kind === 'anonymous-group').every(v => !v.nameAsserted)).toBe(true)
  })

  it('leaves all old review semantics unchanged without explicit applied word-view metadata', () => {
    const review = reviewMeetingSpeakers(roots(), { batchSegments: [{ speakerWords: [{ start: 0, end: 1, speaker: 'Ext' }] }] })
    expect(review.voices).toHaveLength(60)
    expect(review.effectiveSpeakerSummary).toBeUndefined()
    expect(review.timeline.some(t => t.speaker === 'Voice 59')).toBe(true)
    const noWords = reviewMeetingSpeakers(roots(), { effectiveWordView })
    expect(noWords.voices).toHaveLength(60)
    expect(noWords.effectiveSpeakerSummary).toBeUndefined()
  })

  it('rejects alias-shaped or duplicate group metadata instead of granting an identity to an old label', () => {
    expect(() => reviewMeetingSpeakers(roots(), { batchSegments: words(), effectiveWordView: {
      ...effectiveWordView, anonymousGroups: [{ identityId: 'a', label: 'Voice 39' }] } })).toThrow('Invalid effective speaker word view')
    expect(() => reviewMeetingSpeakers(roots(), { batchSegments: words(), effectiveWordView: {
      ...effectiveWordView, anonymousGroups: [effectiveWordView.anonymousGroups[0], effectiveWordView.anonymousGroups[0]] } })).toThrow('Invalid effective speaker word view')
    for (const forged of [
      { ...effectiveWordView, version: 2 }, { ...effectiveWordView, unresolvedLabel: 'Voice 39' },
      { ...effectiveWordView, anonymousGroups: null }, { ...effectiveWordView, anonymousGroups: [null] },
      { ...effectiveWordView, anonymousGroups: [{ identityId: '../../source', label: 'Anonymous group 1' }] },
    ]) expect(() => reviewMeetingSpeakers(roots(), { batchSegments: words(), effectiveWordView: forged as any })).toThrow('Invalid effective speaker word view')
  })
})

describe('reader-validated exact human HQ word proof', () => {
  const exact = (wordIndex: number, label = 'Human Example', batchIndex = 0) => ({ batchIndex, wordIndex, label })
  const selectedWords = () => [{ startElapsed: 10_000, speakerWords: [
    { word: 'Selected', start: 0, end: .4, speaker: 'Human Example' },
    { word: 'phrase.', start: .4, end: .8, speaker: 'Human Example' },
    { word: 'Unreviewed.', start: 1, end: 2, speaker: 'Human Example' },
    { word: 'Anonymous.', start: 3, end: 4, speaker: 'Voice 39' },
  ] }]

  it('asserts only selected words, never same-name roots, with exact phrase/time/count and conserved buckets', () => {
    const chunks = [{ speaker: 'Human Example', text: 'A whole raw chunk must not be borrowed', elapsed: 1000, chunkIndex: 7, similarity: .1 }]
    const batchSegments = selectedWords(), before = JSON.stringify({ chunks, batchSegments })
    const review = reviewMeetingSpeakers(chunks, { effectiveWordView, batchSegments, durationMs: 20_000,
      exactConfirmedWords: [exact(0), exact(1)] })
    expect(review.voices.find(v => v.label === 'Human Example')).toMatchObject({ kind: 'name', nameAsserted: true,
      confirmedByHuman: true, assertionSource: 'human', segments: 0, confirmedSegments: 0, confirmedWordCount: 2,
      wordCount: 2, speakingMs: 800, machineQualified: false, machineQualifiedSegments: 0,
      phrases: [{ text: 'Selected phrase.', atMs: 10_000, chunkIndex: null, similarity: null }] })
    expect(review.voices.find(v => v.label === 'Ext')).toMatchObject({ wordCount: 2, speakingMs: 2000, nameAsserted: false, confirmedWordCount: 0 })
    expect(review.assertedSegments).toBe(0)
    expect(review.attributedSpeakingMs).toBe(800)
    expect(review.unattributedSpeakingMs).toBe(2000)
    expect(review.voicedMs).toBe(2800)
    expect(review.voicedMs + review.notCapturedMs).toBe(20_000)
    expect(review.timeline).toEqual([
      { speaker: 'Human Example', startMs: 10_000, endMs: 10_800, segments: 2 },
      { speaker: 'Ext', startMs: 11_000, endMs: 12_000, segments: 1 },
      { speaker: 'Ext', startMs: 13_000, endMs: 14_000, segments: 1 },
    ])
    expect(review.effectiveSpeakerSummary).toMatchObject({ namedVoiceCount: 1, unresolvedWordCount: 2, unresolvedSpeakingMs: 2000 })
    expect(JSON.stringify({ chunks, batchSegments })).toBe(before)
  })

  it('keeps the HQ inventory and active human names after packet withdrawal and partial undo', () => {
    const batchSegments = selectedWords()
    batchSegments[0].speakerWords[1].speaker = 'Ext' // annotation undo restored this word's source label
    const review = reviewMeetingSpeakers(roots(), { batchSegments, durationMs: 70_000, exactConfirmedWords: [exact(0)] })
    expect(review.voices.find(v => v.label === 'Human Example')).toMatchObject({ nameAsserted: true, wordCount: 1, confirmedWordCount: 1, speakingMs: 400,
      phrases: [{ text: 'Selected', atMs: 10_000, chunkIndex: null, similarity: null }] })
    expect(review.effectiveSpeakerSummary).toMatchObject({ anonymousGroupCount: 0, namedVoiceCount: 1, unresolvedWordCount: 3 })
    expect(review.timeline.some(t => /^Voice /.test(t.speaker))).toBe(false)
    expect(review.voicedMs + review.notCapturedMs).toBe(70_000)
  })

  it('preserves protected same-name words and older human and machine claims without expanding the new word grant', () => {
    const batchSegments: any = selectedWords()
    batchSegments[0].speakerWords[2].manualSpeaker = true
    const review = reviewMeetingSpeakers(roots(), { effectiveWordView, batchSegments,
      confirmed: new Set(['Named Example']), exactConfirmedWords: [exact(0), exact(1)] })
    expect(review.voices.find(v => v.label === 'Human Example')).toMatchObject({ wordCount: 3, speakingMs: 1800, confirmedWordCount: 2 })
    expect(review.voices.find(v => v.label === 'Named Example')).toMatchObject({ nameAsserted: true, confirmedByHuman: true, segments: 1 })
    expect(review.voices.find(v => v.label === 'Human Example')?.phrases.map(p => p.text)).toEqual(['Selected phrase.'])

    const chunks = [{ speaker: 'Human Example', text: 'Old independently qualified chunk', elapsed: 0, chunkIndex: 0, similarity: 0 },
      { speaker: 'Human Example', text: 'Old unsupported chunk', elapsed: 1000, chunkIndex: 1, similarity: 0 }]
    const proof = new Map([[0, { label: 'Human Example', rawChunkIndex: 0, independentWindows: 2, minimumSimilarity: .9, minimumMargin: .08 }]])
    const mixed = reviewMeetingSpeakers(chunks, { effectiveWordView, batchSegments, machineEvidenceStatus: 'qualified', machineQualifiedPositions: proof as any,
      exactConfirmedWords: [exact(0), exact(1)] })
    expect(mixed.voices.find(v => v.label === 'Human Example')).toMatchObject({ nameAsserted: false, confirmedByHuman: false,
      segments: 2, machineQualifiedSegments: 1, confirmedWordCount: 2, wordCount: 3 })
    expect(mixed.voices.find(v => v.label === 'Human Example')?.assertionBlockers.join(' ')).toContain('lack current scoped speaker evidence')
  })

  it('does not turn a partial older chunk confirmation into a label-wide vouch', () => {
    const chunks = [{ speaker: 'Human Example', text: 'Previously confirmed root', elapsed: 0 },
      { speaker: 'Human Example', text: 'Still unconfirmed root', elapsed: 1000 }]
    const review = reviewMeetingSpeakers(chunks, { batchSegments: selectedWords(), confirmedChunks: new Map([[0, 'Human Example']]), exactConfirmedWords: [exact(0)] })
    expect(review.voices.find(v => v.label === 'Human Example')).toMatchObject({ nameAsserted: false, confirmedByHuman: false,
      confirmedSegments: 1, confirmedWordCount: 1, wordCount: 3 })
    expect(review.assertedSegments).toBe(1)
  })

  it('retains 253 prior human HQ words and ten qualified machine positions beside a new exact name', () => {
    const chunks: ReviewChunk[] = [{ speaker: 'Prior Human', text: 'Existing human correction', elapsed: 0, chunkIndex: 0 }]
    for (let i = 0; i < 10; i++) chunks.push({ speaker: 'Named Example', text: `Qualified source ${i}`, elapsed: 40_000 + i * 1000, chunkIndex: i + 1, similarity: 0 })
    chunks.push({ speaker: 'Voice 1', text: 'Raw mixed chunk', elapsed: 60_000, chunkIndex: 11 })
    const proof = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, { label: 'Named Example', rawChunkIndex: i + 1,
      independentWindows: 2, minimumSimilarity: .9, minimumMargin: .08 }]))
    const batchSegments = [{ speakerWords: [
      ...Array.from({ length: 253 }, (_, i) => ({ word: `Prior${i}`, start: i * .15, end: i * .15 + .1, speaker: 'Prior Human', manualSpeaker: true })),
      ...Array.from({ length: 10 }, (_, i) => ({ word: `Qualified${i}`, start: 40 + i, end: 40.5 + i, speaker: 'Named Example' })),
      { word: 'Selected', start: 60, end: 61, speaker: 'Human Example' },
      { word: 'Unselected', start: 62, end: 63, speaker: 'Voice 1' },
    ] }]
    const before = JSON.stringify({ chunks, batchSegments, proof: [...proof] })
    const review = reviewMeetingSpeakers(chunks, { effectiveWordView, batchSegments, durationMs: 70_000,
      confirmedChunks: new Map([[0, 'Prior Human']]), machineEvidenceStatus: 'qualified', machineQualifiedPositions: proof as any,
      exactConfirmedWords: [exact(263)] })
    expect(review.voices.find(v => v.label === 'Prior Human')).toMatchObject({ wordCount: 253, nameAsserted: true, confirmedByHuman: true, confirmedSegments: 1 })
    expect(review.voices.find(v => v.label === 'Named Example')).toMatchObject({ machineQualified: true, machineQualifiedSegments: 10, nameAsserted: true, assertionSource: 'qualified-profile' })
    expect(review.voices.find(v => v.label === 'Human Example')).toMatchObject({ confirmedWordCount: 1, segments: 0, wordCount: 1, nameAsserted: true })
    expect(review.assertedSegments).toBe(11)
    expect(review.voicedMs + review.notCapturedMs).toBe(70_000)
    expect(JSON.stringify({ chunks, batchSegments, proof: [...proof] })).toBe(before)
  })

  it('uses an explicitly empty list as closed inventory after the last undo; absence retains legacy behavior', () => {
    const options = { batchSegments: selectedWords(), durationMs: 70_000 }
    const legacy = reviewMeetingSpeakers(roots(), options)
    expect(legacy.effectiveSpeakerSummary).toBeUndefined()
    expect(legacy.voices.some(v => v.label === 'Voice 59')).toBe(true)
    const undone = reviewMeetingSpeakers(roots(), { ...options, exactConfirmedWords: [] })
    expect(undone.effectiveSpeakerSummary).toMatchObject({ anonymousGroupCount: 0, namedVoiceCount: 0, unresolvedWordCount: 1 })
    expect(undone.voices.some(v => /^Voice /.test(v.label))).toBe(false)
    expect(undone.voices.find(v => v.label === 'Human Example')).toMatchObject({ nameAsserted: false, confirmedByHuman: false })
    const intervalOptions = { ...options, effectiveWordView }
    expect(reviewMeetingSpeakers(roots(), { ...intervalOptions, exactConfirmedWords: [] })).toEqual(reviewMeetingSpeakers(roots(), intervalOptions))
  })

  it('rejects stale, duplicate, malformed or non-name proof instead of trusting a word index alone', () => {
    for (const proof of [[exact(0), exact(0)], [exact(0, 'Other Person')], [exact(99)], [exact(.5)], [exact(0, 'Voice 1')], [exact(0, 'Ext')], [exact(0, 'unknown')], [exact(0, 'Speaker')], [exact(0, 'MU')], [exact(0, 'Anonymous group 1')], [exact(0, 'Human Example', -1)]]) {
      expect(() => reviewMeetingSpeakers(roots(), { batchSegments: selectedWords(), exactConfirmedWords: proof })).toThrow('Invalid exact confirmed speaker words')
    }
    const invalid: any = selectedWords(); invalid[0].speakerWords[0].end = Infinity
    expect(() => reviewMeetingSpeakers(roots(), { batchSegments: invalid, exactConfirmedWords: [exact(0)] })).toThrow('Invalid exact confirmed speaker words')
  })
})
