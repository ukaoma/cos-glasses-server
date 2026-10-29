import { describe, expect, it } from 'vitest'
import { buildMacSpeakerShadowRepair, bindMacSpeakerShadowRepair, type MacShadowRepairInput, type MacShadowRepairSource } from './mac-speaker-shadow-repair.js'
import { applyMacSpeakerRepair, projectMacSpeakerRepair, hashMacSpeakerDocument, hashMacSpeakerMachineBinding } from './mac-speaker-repair-projection.js'
import { readMacSpeakerMachineEvidence } from './mac-speaker-machine-evidence.js'
import { SYNTHETIC_SPANS, SYNTHETIC_SECONDS, syntheticEmbeddings, syntheticNative } from './__fixtures__/speaker-shadow/synthetic-meeting.js'

const H = 'a'.repeat(64)
const seal = (source: MacShadowRepairSource): MacShadowRepairInput => ({ ...source, sourceBindingSHA256: bindMacSpeakerShadowRepair(source) })
function fixture(): MacShadowRepairSource {
  const chunkEntries: any[] = []
  for (const span of SYNTHETIC_SPANS) for (let start = span.start; start < span.end; start += 6) {
    const seconds = Math.min(6, span.end - start), raw = chunkEntries.length
    const chunk = { text: `words for raw ${raw}`, speaker: span.label, elapsed: start * 1000, audioDurationMs: seconds * 1000, audioSha256: raw.toString(16).padStart(64, '0'), similarity: 0, segments: [{ speaker: span.label, startSec: 0, endSec: seconds }], finalSegments: [{ speaker: span.label, startSec: 0, endSec: seconds }], words: [{ word: `raw${raw}`, start: 0, end: seconds }] }
    chunkEntries.push({ chunkIndex: raw, chunk })
  }
  let offset = 0
  const speakerWords = chunkEntries.map(({ chunk }) => {
    const start = offset; offset += chunk.audioDurationMs / 1000
    return { word: chunk.text, speaker: chunk.speaker, start, end: offset }
  })
  const doc = { sessionId: 'mac_synthetic', sourceType: 'mac_system_audio', finalizationState: 'complete', chunks: chunkEntries.map(e => structuredClone(e.chunk)), chunkEntries, speakers: ['Dana Fictional'], batchSegments: [{ startChunkIdx: 0, endChunkIdx: chunkEntries.length - 1, speakerWords }] }
  const rawAudio = chunkEntries.map(e => ({ rawChunkIndex: e.chunkIndex, wavSHA256: e.chunk.audioSha256, pcmSHA256: H, sampleCount: e.chunk.audioDurationMs * 16 }))
  const rows = rawAudio.map((a, i) => ({ rawChunkIndex: i, startSample: chunkEntries[i].chunk.elapsed * 16, sampleCount: a.sampleCount, usedSampleCount: a.sampleCount }))
  return { originalJSON: JSON.stringify(doc), currentJSON: JSON.stringify(doc), ledgerJSONL: '', rawAudio, timeline: { rows, total: SYNTHETIC_SECONDS * 16000, pcmSHA256: H }, cohort: { nativeJSON: JSON.stringify(syntheticNative()), embeddingsJSON: JSON.stringify(syntheticEmbeddings()), modelSHA256: H, cliSHA256: 'b'.repeat(64) } }
}
function edit(source: MacShadowRepairSource, which: 'originalJSON' | 'currentJSON', change: (d: any) => void) { const d = JSON.parse(source[which]); change(d); source[which] = JSON.stringify(d) }
const first = (source: MacShadowRepairSource, label = 'Voice 2') => JSON.parse(source.originalJSON).chunkEntries.findIndex((e: any) => e.chunk.speaker === label)
const applied = (position: number) => [
  { id: 'human1', phase: 'intent', from: 'Voice 2', to: 'Human Name', chunks: [position] },
  { id: 'human1', phase: 'applied', from: 'Voice 2', to: 'Human Name', chunks: [position] },
].map(r => JSON.stringify(r)).join('\n')
/** Positive synthetic prior192d-reader fixture, with real strict-projector
 * receipts. Scores are fictional; no native authentication is implied. */
function withPriorQualifiedProof(source: MacShadowRepairSource): any {
  const original = JSON.parse(source.originalJSON), starts = [0, 11]
  const counts = Object.fromEntries(source.rawAudio.map(a => [a.rawChunkIndex, a.sampleCount]))
  const windows = starts.map((start, i) => ({ id: `priorwindow${i}`, captureStartSample: original.chunkEntries[start].chunk.elapsed * 16, captureEndSample: original.chunkEntries[start].chunk.elapsed * 16 + 480000, pcmSha256: String(i + 1).repeat(64), similarity: .95, runnerUpSimilarity: .1, rawChunks: Array.from({ length: 5 }, (_, j) => ({ rawChunkIndex: start + j, audioSha256: source.rawAudio[start + j].wavSHA256, sampleCount: 96000 })) }))
  const proof = { kind: 'profile-match' as const, profileName: 'Jeremy Example', profileSha256: 'c'.repeat(64), modelSha256: 'd'.repeat(64), algorithmVersion: 'synthetic-prior-proof', crossWindowCosines: [[1, .95], [.95, 1]], windows }
  const assignments = starts.flatMap(start => Array.from({ length: 5 }, (_, j) => start + j)).map(raw => {
    const word = original.batchSegments[0].speakerWords[raw]
    return { rawChunkIndex: raw, from: original.chunks[raw].speaker, to: 'Jeremy Example', evidenceId: 'prior_named', targetEvidence: proof, batchWords: [{ segmentIndex: 0, wordIndex: raw, from: word.speaker, word: word.word, start: word.start, end: word.end }] }
  })
  const prior = projectMacSpeakerRepair(original, { id: 'prior_named', evidenceHash: H, expectedDocumentHash: hashMacSpeakerDocument(original), protectedRawChunkIndices: [], rawAudioSampleCounts: counts, assignments })
  const named = prior.doc
  named.correctionRevision = 1
  named.speakerRepair = { id: 'prior_named', evidenceHash: H, machineEvidence: { version: 1, correctionRevision: 1, documentBinding: hashMacSpeakerMachineBinding(named), receipt: prior.receipt, rawAudioSampleCounts: counts } }
  named.speakerProfilePass = { version: 1, status: 'applied' }
  return named
}

describe('qualified256 shadow repair pure preparation', () => {
  it('declines a currently qualified prior proof instead of invalidating its reader assertions', () => {
    const source = fixture(), named = withPriorQualifiedProof(source)
    expect(readMacSpeakerMachineEvidence(named).status).toBe('qualified')
    source.currentJSON = JSON.stringify(named)
    const before = source.currentJSON
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/requires proof composition/)
    expect(source.currentJSON).toBe(before)
    expect(readMacSpeakerMachineEvidence(JSON.parse(source.currentJSON)).status).toBe('qualified')
  })
  for (const which of ['originalJSON', 'currentJSON'] as const) for (const key of ['speakerRepair', 'speakerProfilePass']) it(`refuses even malformed/empty ${which} ${key} receipts`, () => {
    const source = fixture(); edit(source, which, d => { d[key] = null })
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/requires proof composition/)
  })
  it('rejects original root/raw segment disagreement even if current rows agree with altered original roots', () => {
    const source = fixture(), raw = first(source)
    edit(source, 'originalJSON', d => { d.chunks[raw].segments[0].endSec = 1 })
    edit(source, 'currentJSON', d => { d.chunks[raw].segments[0].endSec = 1; d.chunkEntries[raw].chunk.segments[0].endSec = 1 })
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/original root\/raw source geometry/)
  })
  for (const key of ['segments', 'finalSegments', 'words']) it(`rejects current ${key} geometry drift on an anchor outside selected assignments`, () => {
    const source = fixture()
    if (key === 'finalSegments') for (const which of ['originalJSON', 'currentJSON'] as const) edit(source, which, d => {
      for (const row of [...d.chunks, ...d.chunkEntries.map((e: any) => e.chunk)]) row.finalSegments = structuredClone(row.segments)
    })
    edit(source, 'currentJSON', d => {
      for (let raw = 0; raw < 7; raw++) for (const row of [d.chunks[raw], d.chunkEntries[raw].chunk]) delete row[key]
    })
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/current compacted source geometry/)
  })
  it('rejects raw-only competitor word-time drift rather than silently excluding that competitor', () => {
    const source = fixture(), raw = first(source, 'Voice 5')
    edit(source, 'currentJSON', d => { d.chunkEntries[raw].chunk.words[0].start = .5 })
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/current raw source geometry/)
  })
  it('rejects a changed top-level capture clock despite unchanged per-chunk source joins', () => {
    const source = fixture(); edit(source, 'currentJSON', d => { d.startTime = 1234 })
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/capture clock/)
  })
  it('permits protected human label differences without treating them as geometry drift', () => {
    const source = fixture(), raw = first(source)
    edit(source, 'currentJSON', d => {
      d.chunks[raw].speaker = 'Human Example'; d.chunks[raw].segments[0].speaker = 'Human Example'
      d.chunks[raw].segments[0].speakerOrigin = 'manual'
    })
    const result = buildMacSpeakerShadowRepair(seal(source))
    expect(result.protectedRawChunkIndices).toContain(raw)
    expect(result.plan!.assignments.some(a => a.rawChunkIndex === raw)).toBe(false)
  })
  it('recomputes real gates, yields strict anonymous plans and preserves source bytes/text/times', () => {
    const source = fixture(), frozen = JSON.stringify(source), result = buildMacSpeakerShadowRepair(seal(source))
    expect(result.counts.acousticAcceptedMerges).toBe(3)
    expect(result.plan).not.toBeNull()
    expect([...new Set(result.plan!.assignments.map(a => `${a.from}>${a.to}`))]).toEqual(['Voice 2>Voice 1', 'Voice 10>Voice 3', 'Voice 13>Voice 1'])
    expect(result.provenance).toMatchObject({ productionQualified: false, nativeAuthenticated: false })
    const before = JSON.parse(source.currentJSON), { doc, receipt } = projectMacSpeakerRepair(before, result.plan!)
    expect(doc.chunks.map((c: any) => [c.text, c.elapsed, c.audioDurationMs, c.words])).toEqual(before.chunks.map((c: any) => [c.text, c.elapsed, c.audioDurationMs, c.words]))
    expect(doc.chunks.map((c: any) => c.similarity)).toEqual(before.chunks.map((c: any) => c.similarity))
    expect(applyMacSpeakerRepair(doc, receipt, 'reverse')).toEqual(before)
    expect(applyMacSpeakerRepair(doc, receipt)).toEqual(doc)
    expect(JSON.stringify(source)).toBe(frozen)
    expect(result.counts.afterLabels).toBeLessThan(result.counts.beforeLabels)
  })
  it('has no remap/name proposal input even if a caller rehashes the injected field', () => {
    const source: any = fixture(); source.remap = { 'Voice 2': 'A Real Name' }
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/unsupported proposal/)
  })
  for (const field of ['originalJSON', 'currentJSON', 'ledgerJSONL', 'rawAudio', 'timeline', 'cohort'] as const) {
    it(`refuses stale full bindings after ${field} changes`, () => {
      const input = seal(fixture())
      if (field === 'originalJSON' || field === 'currentJSON' || field === 'ledgerJSONL') input[field] += ' '
      else if (field === 'rawAudio') input.rawAudio[0].pcmSHA256 = 'c'.repeat(64)
      else if (field === 'timeline') input.timeline.pcmSHA256 = 'c'.repeat(64)
      else input.cohort.cliSHA256 = 'c'.repeat(64)
      expect(() => buildMacSpeakerShadowRepair(input)).toThrow(/full source binding drift/)
    })
  }
  it('protects a current root-only human name despite identical raw automatic labels', () => {
    const source = fixture(), raw = first(source)
    edit(source, 'currentJSON', d => { d.chunks[raw].speaker = 'Human Name' })
    const result = buildMacSpeakerShadowRepair(seal(source))
    expect(result.protectedRawChunkIndices).toContain(raw)
    expect(result.plan!.assignments.some(a => a.rawChunkIndex === raw)).toBe(false)
    expect(JSON.parse(source.currentJSON).chunkEntries[raw].chunk.speaker).toBe('Voice 2')
  })
  it('protects ledger-applied anonymous rows even without current name/marker propagation', () => {
    const source = fixture(), raw = first(source); source.ledgerJSONL = applied(raw)
    const result = buildMacSpeakerShadowRepair(seal(source))
    expect(result.protectedRawChunkIndices).toContain(raw)
    expect(result.plan!.assignments.some(a => a.rawChunkIndex === raw)).toBe(false)
  })
  it('maps ledger compacted positions through silent raw originals without an off-by-one', () => {
    const source = fixture(), raw = first(source)
    for (const which of ['originalJSON', 'currentJSON'] as const) edit(source, which, d => { d.chunkEntries[0].chunk.text = ''; d.chunkEntries[0].chunk.segments = []; d.chunks.splice(0, 1) })
    source.ledgerJSONL = applied(raw - 1)
    const result = buildMacSpeakerShadowRepair(seal(source))
    expect(result.protectedRawChunkIndices).toContain(raw)
    expect(result.protectedRawChunkIndices).not.toContain(raw - 1)
  })
  it('retains empty-confirmation protect-all behavior and returns an honest empty preview', () => {
    const source = fixture(); source.ledgerJSONL = JSON.stringify({ id: 'confirm', phase: 'confirmed', chunks: [], to: 'Human Name' })
    const result = buildMacSpeakerShadowRepair(seal(source))
    expect(result.plan).toBeNull()
    expect(result.counts).toMatchObject({ acousticAcceptedMerges: 3, assignedChunks: 0, protectedChunks: JSON.parse(source.currentJSON).chunks.length })
  })
  it('refuses a re-bound ledger whose compacted positions do not carry the historical from label', () => {
    const source = fixture(); source.ledgerJSONL = applied(0)
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/history source label mismatch/)
  })
  it('does not allow a confirmation to hide a pending correction intent', () => {
    const source = fixture(), raw = first(source), intent = applied(raw).split('\n')[0]
    source.ledgerJSONL = `${intent}\n${JSON.stringify({ id: 'human1', phase: 'confirmed', chunks: [] })}`
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/incomplete correction intent/)
  })
  it('resolves documented empty intent to the complete original from-label positions', () => {
    const source = fixture(), doc = JSON.parse(source.originalJSON)
    const positions = doc.chunks.flatMap((c: any, i: number) => c.speaker === 'Voice 2' ? [i] : [])
    source.ledgerJSONL = [
      { id: 'all', phase: 'intent', from: 'Voice 2', to: 'Human', chunks: [] },
      { id: 'all', phase: 'applied', from: 'Voice 2', to: 'Human', chunks: positions },
    ].map(x => JSON.stringify(x)).join('\n')
    const result = buildMacSpeakerShadowRepair(seal(source))
    for (const position of positions) expect(result.protectedRawChunkIndices).toContain(position)
    const rows = source.ledgerJSONL.split('\n').map(x => JSON.parse(x)); rows[1].chunks.pop()
    source.ledgerJSONL = rows.map(x => JSON.stringify(x)).join('\n')
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/history/)
  })
  it('accepts explicit confirmed-chunks protection but refuses an omitted chunks field', () => {
    const source = fixture(), raw = first(source)
    source.ledgerJSONL = JSON.stringify({ id: 'scoped', phase: 'confirmed-chunks', chunks: [raw], from: 'Voice 2', to: 'Voice 2' })
    expect(buildMacSpeakerShadowRepair(seal(source)).protectedRawChunkIndices).toContain(raw)
    source.ledgerJSONL = JSON.stringify({ id: 'ambiguous', phase: 'intent', from: 'Voice 2', to: 'Human' })
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/ledger/)
  })
  it.each(['intent', 'applied-without-intent', 'bad-position', 'different-apply-position'])('refuses ambiguous/incomplete ledger %s', kind => {
    const source = fixture(), raw = first(source)
    const events = applied(raw).split('\n').map(x => JSON.parse(x))
    if (kind === 'intent') events.pop()
    if (kind === 'applied-without-intent') events.shift()
    if (kind === 'bad-position') for (const e of events) e.chunks = [99999]
    if (kind === 'different-apply-position') events[1].chunks = [raw + 1]
    source.ledgerJSONL = events.map(x => JSON.stringify(x)).join('\n')
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/correction/)
  })
  for (const surface of ['root', 'segments', 'finalSegments', 'words', 'raw'] as const) it(`preserves human marker on ${surface}`, () => {
    const source = fixture(), raw = first(source)
    edit(source, 'currentJSON', d => {
      if (surface === 'raw') d.chunkEntries[raw].chunk.manuallyCorrected = true
      else if (surface === 'root') d.chunks[raw].manuallyCorrected = true
      else { if (surface === 'finalSegments') d.chunks[raw].finalSegments = structuredClone(d.chunks[raw].segments); d.chunks[raw][surface][0].speakerOrigin = 'manual' }
    })
    expect(buildMacSpeakerShadowRepair(seal(source)).protectedRawChunkIndices).toContain(raw)
  })
  it('withholds changed anonymous current surfaces rather than normalizing them from original', () => {
    const source = fixture(), raw = first(source)
    edit(source, 'currentJSON', d => { d.chunks[raw].speaker = 'Voice 99' })
    const result = buildMacSpeakerShadowRepair(seal(source))
    expect(result.withheld).toContainEqual({ rawChunkIndex: raw, reason: 'mixed-or-current-surfaces-differ' })
  })
  it('does not discard short or wrong-dimension confuser rows before validation', () => {
    const source = fixture(), e = JSON.parse(source.cohort.embeddingsJSON)
    e.push({ startTime: 0, endTime: .01, cluster: 99, embedding256: Array(192).fill(.01) })
    source.cohort.embeddingsJSON = JSON.stringify(e)
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/256d/)
  })
  it.each([Array(256).fill(0), Array(256).fill(null), Array(257).fill(1)])('rejects invalid export vectors', vector => {
    const source = fixture(), e = JSON.parse(source.cohort.embeddingsJSON); e[0].embedding256 = vector
    source.cohort.embeddingsJSON = JSON.stringify(e)
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/256d/)
  })
  it('keeps the real short confuser and existing floor/ratio rejections', () => {
    const source = fixture(), result = buildMacSpeakerShadowRepair(seal(source))
    const doc = JSON.parse(source.currentJSON)
    const assigned = new Set(result.plan!.assignments.map(a => doc.chunkEntries[a.rawChunkIndex].chunk.speaker))
    expect(assigned.has('Voice 4')).toBe(false)
    expect(assigned.has('Voice 5')).toBe(false)
    expect(assigned.has('Voice 12')).toBe(false)
  })
  it('uses concatenated raw durations for exact batch bindings and excludes a crossing into an unqualified raw', () => {
    const source = fixture(), raw = first(source)
    edit(source, 'currentJSON', d => {
      const word = d.batchSegments[0].speakerWords[raw]; word.start -= .1
    })
    const result = buildMacSpeakerShadowRepair(seal(source))
    expect(result.withheld).toContainEqual({ rawChunkIndex: raw, reason: 'batch-protected-or-crosses-unqualified-boundary' })
    expect(result.plan!.assignments.some(a => a.rawChunkIndex === raw)).toBe(false)
    const next = result.plan!.assignments.find(a => a.rawChunkIndex === raw + 1)!
    expect(next.batchWords[0].start).toBe(JSON.parse(source.currentJSON).chunkEntries[raw + 1].chunk.elapsed / 1000)
    expect(() => projectMacSpeakerRepair(JSON.parse(source.currentJSON), result.plan!)).not.toThrow()
  })
  it('preserves a manual or named batch word and withholds every overlapping chunk', () => {
    const source = fixture(), raw = first(source)
    edit(source, 'currentJSON', d => { d.batchSegments[0].speakerWords[raw].speaker = 'Human Name' })
    const result = buildMacSpeakerShadowRepair(seal(source))
    expect(result.plan!.assignments.some(a => a.rawChunkIndex === raw)).toBe(false)
  })
  it('preserves a current batch-only anonymous correction without ledger/markers', () => {
    const source = fixture(), raw = first(source)
    edit(source, 'currentJSON', d => { d.batchSegments[0].speakerWords[raw].speaker = 'Voice 99' })
    const result = buildMacSpeakerShadowRepair(seal(source))
    expect(result.protectedRawChunkIndices).toContain(raw)
    expect(result.plan!.assignments.some(a => a.rawChunkIndex === raw)).toBe(false)
    expect(projectMacSpeakerRepair(JSON.parse(source.currentJSON), result.plan!).doc.batchSegments[0].speakerWords[raw].speaker).toBe('Voice 99')
  })
  it('recomputes geometry instead of trusting a newly rehashed supplied timeline digest', () => {
    const source = fixture(); source.timeline.rows[0].usedSampleCount--
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/timeline geometry/)
  })
  it('requires complete all-raw bindings and exact current text/time source joins', () => {
    const source = fixture(); source.rawAudio.pop()
    expect(() => buildMacSpeakerShadowRepair(seal(source))).toThrow(/all raw/)
    const changed = fixture(); edit(changed, 'currentJSON', d => { d.chunks[0].text += ' changed' })
    expect(() => buildMacSpeakerShadowRepair(seal(changed))).toThrow(/join/)
  })
  it('all unknown/no evidence gives an empty plan without inventing an identity', () => {
    const source = fixture(); source.cohort.nativeJSON = '{"segments":[]}'; source.cohort.embeddingsJSON = '[]'
    const result = buildMacSpeakerShadowRepair(seal(source))
    expect(result.plan).toBeNull()
    expect(result.counts).toMatchObject({ acousticAcceptedMerges: 0, assignedChunks: 0 })
    expect(result.counts.beforeLabels).toBe(result.counts.afterLabels)
  })
  it('withholds an acoustically accepted partial rewrite that cannot reduce current root labels', () => {
    const source = fixture(), doc = JSON.parse(source.currentJSON)
    const voice2 = doc.chunks.map((c: any, i: number) => c.speaker === 'Voice 2' ? i : -1).filter((i: number) => i >= 0)
    const protect = doc.chunks.map((c: any, i: number) => ['Voice 10', 'Voice 13'].includes(c.speaker) ? i : -1).filter((i: number) => i >= 0)
    protect.push(voice2.at(-1))
    source.ledgerJSONL = protect.flatMap((position: number) => [
      { id: `protect${position}`, phase: 'intent', from: doc.chunks[position].speaker, to: 'Still Human Protected', chunks: [position] },
      { id: `protect${position}`, phase: 'applied', from: doc.chunks[position].speaker, to: 'Still Human Protected', chunks: [position] },
    ]).map((r: any) => JSON.stringify(r)).join('\n')
    const result = buildMacSpeakerShadowRepair(seal(source))
    expect(result.counts.acousticAcceptedMerges).toBe(3)
    expect(result.plan).toBeNull()
    expect(result.withheld.some(w => w.reason === 'non-reducing-plan')).toBe(true)
    expect(result.counts.afterRootLabels).toBe(result.counts.beforeRootLabels)
    expect(result.counts.afterLabels).toBe(result.counts.beforeLabels)
    expect(result.counts.assignedChunks).toBe(0)
  })
})
