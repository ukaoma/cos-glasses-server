import { describe, expect, it } from 'vitest'
import { planMacSpeakerWindows, qualifyMacSpeakerWindows, type MacSpeakerWindowInput, type MacWindowEmbeddingReceipt } from './mac-speaker-windows.js'
import type { SidecarEntry } from './nemotron-final.js'
const sha = (n: number) => n.toString(16).padStart(64, '0')
const A = [1, 0, 0], B = [0, 1, 0]
const vector = (d: number) => [Math.cos(d * Math.PI / 180), Math.sin(d * Math.PI / 180), 0]
function fixture(windows = 2, hint: (index: number) => string = () => 'Voice 1'): MacSpeakerWindowInput {
  const entries: SidecarEntry[] = Array.from({ length: windows * 5 }, (_, index) => ({ chunkIndex: index, chunk: {
    text: `fixture words ${index}`, elapsed: index * 6000, speaker: hint(index), similarity: 0, speakerPolicy: 'high-confidence', audioSha256: sha(index * 2 + 1),
    segments: [{ text: `fixture words ${index}`, speaker: hint(index), startSec: 0, endSec: 6, similarity: 0 }],
  } }))
  return { sidecar: { sessionId: 'mac-fixture', correctionRevision: 0, chunkEntries: entries }, correctionHistory: 'verified-clear',
    rawChunks: entries.map(e => ({ chunkIndex: e.chunkIndex, audioSHA256: sha(e.chunkIndex * 2 + 1), pcmSHA256: sha(e.chunkIndex * 2 + 2), sampleRate: 16000, channels: 1, format: 'pcm_s16le', sampleCount: 96_000, verified: true })) }
}
function prepared(input = fixture(), embedding: (index: number) => number[] = () => A) {
  const plan = planMacSpeakerWindows(input)
  const receipts: MacWindowEmbeddingReceipt[] = plan.windows.map((w, i) => ({ windowId: w.id, windowBindingSHA256: w.bindingSHA256, modelSHA256: sha(5000),
    audioSHA256: sha(10000 + i * 2), pcmSHA256: sha(10001 + i * 2), sampleCount: w.sampleCount, embedding: embedding(i) }))
  return { plan, receipts }
}
const qualify = ({ plan, receipts }: ReturnType<typeof prepared>, profiles = [] as { name: string; embeddings: number[][]; profileSHA256: string }[]) => qualifyMacSpeakerWindows(plan, receipts, profiles, sha(5000), 3)

describe('verified long-span speaker window preparation', () => {
  it('reads actual chunkEntries and makes disjoint exact 30s windows with immutable raw lineage', () => {
    const input = fixture(3), before = JSON.stringify(input)
    const plan = planMacSpeakerWindows(input)
    expect(plan.windows).toHaveLength(3)
    expect(plan.windows.map(w => [w.startSample, w.endSample, w.sources.length])).toEqual([[0, 480000, 5], [480000, 960000, 5], [960000, 1440000, 5]])
    expect(plan.windows[0].sources[0]).toMatchObject({ audioSHA256: sha(1), pcmSHA256: sha(2), chunkIndex: 0, sampleCount: 96000 })
    expect(plan.families).toEqual([{ originalVoiceHint: 'Voice 1', windowIds: plan.windows.map(w => w.id) }])
    expect(JSON.stringify(input)).toBe(before)
    input.rawChunks[0].audioSHA256 = sha(99)
    expect(plan.windows[0].sources[0].audioSHA256).toBe(sha(1))
  })
  it('prepares natural whole chunks just under six seconds without requiring a crop or fabricated padding', () => {
    const input = fixture()
    for (let i = 0; i < input.rawChunks.length; i++) {
      input.rawChunks[i].sampleCount = 95_952
      input.sidecar.chunkEntries![i].chunk.elapsed = i * 95_952 / 16
      input.sidecar.chunkEntries![i].chunk.segments![0].endSec = 95_952 / 16_000
    }
    const p = prepared(input)
    expect(p.plan.windows).toHaveLength(2)
    expect(p.plan.windows.map(w => w.sampleCount)).toEqual([479760, 479760])
    expect(qualify(p).every(r => r.status === 'qualified')).toBe(true)
  })
  it('never bridges a clock gap or overlapping original clock', () => {
    const input = fixture(); input.sidecar.chunkEntries![2].chunk.elapsed += 1000
    const plan = planMacSpeakerWindows(input)
    expect(plan.windows.every(w => w.sources.every((s, i) => i === 0 || s.startSample === w.sources[i - 1].endSample))).toBe(true)
    expect(plan.windows).toHaveLength(1)
    expect(plan.rejected.some(r => r.reason === 'clock_or_raw_gap')).toBe(true)
    expect(plan.rejected.some(r => r.reason === 'clock_overlap')).toBe(true)
  })
  it('holds partial windows instead of cropping/reusing short tails', () => {
    const input = fixture(); input.sidecar.chunkEntries!.pop()
    const plan = planMacSpeakerWindows(input)
    expect(plan.windows).toHaveLength(1)
    expect(plan.rejected).toContainEqual({ chunkIndexes: [5, 6, 7, 8], reason: 'partial_window' })
  })
  it.each(['unavailable', 'human-corrected'] as const)('holds recording when correction history is %s', correctionHistory => {
    expect(planMacSpeakerWindows({ ...fixture(), correctionHistory }).windows).toEqual([])
  })
  it('holds revised recordings and explicit manual spans', () => {
    const input = fixture(); input.sidecar.correctionRevision = 1
    expect(planMacSpeakerWindows(input).windows).toEqual([])
    input.sidecar.correctionRevision = 0; input.correctedChunkIndexes = [0]
    expect(planMacSpeakerWindows(input).windows.flatMap(w => w.sources).some(s => s.chunkIndex === 0)).toBe(false)
  })
  it.each(['name', 'mixed', 'raw_hash', 'format', 'unverified', 'overlap', 'silence'])('rejects unsafe source %s', unsafe => {
    const input = fixture(1), c = input.sidecar.chunkEntries![0].chunk
    if (unsafe === 'name') c.speaker = 'Gina'
    if (unsafe === 'mixed') c.segments!.push({ text: 'other voice', speaker: 'Voice 2', startSec: 3, endSec: 6 })
    if (unsafe === 'raw_hash') c.audioSha256 = sha(777)
    if (unsafe === 'format') (input.rawChunks[0] as unknown as Record<string, unknown>).sampleRate = 8000
    if (unsafe === 'unverified') (input.rawChunks[0] as unknown as Record<string, unknown>).verified = false
    if (unsafe === 'overlap') c.segments!.push({ ...c.segments![0], startSec: 2 })
    if (unsafe === 'silence') for (const e of input.sidecar.chunkEntries!) e.chunk.segments![0].endSec = 1
    expect(planMacSpeakerWindows(input).windows).toEqual([])
  })
  it('rejects duplicate original index and reused PCM even across completed windows', () => {
    const input = fixture(); input.rawChunks[5].pcmSHA256 = input.rawChunks[0].pcmSHA256
    const plan = planMacSpeakerWindows(input)
    expect(plan.windows).toHaveLength(1)
    expect(plan.rejected.some(r => r.reason === 'duplicate_audio')).toBe(true)
    const duplicate = fixture(); duplicate.sidecar.chunkEntries!.push(duplicate.sidecar.chunkEntries![0])
    expect(planMacSpeakerWindows(duplicate).windows.flatMap(w => w.sources).some(s => s.chunkIndex === 0)).toBe(false)
  })
  it('does not concatenate across changing anonymous hints', () => {
    const plan = planMacSpeakerWindows(fixture(2, i => i % 2 ? 'Voice 2' : 'Voice 1'))
    expect(plan.windows).toEqual([])
    expect(plan.rejected.some(r => r.reason === 'hint_changed')).toBe(true)
  })
})

describe('exact-span acoustic candidates, not global Voice renames', () => {
  it('qualifies returning voice across old labels only from two independent whole-window vectors', () => {
    const p = prepared(fixture(2, i => i < 5 ? 'Voice 1' : 'Voice 46'))
    const result = qualify(p)
    expect(result.map(r => r.status)).toEqual(['qualified', 'qualified'])
    expect(result[0].acousticIdentity).toBe(result[1].acousticIdentity)
    expect(result[0].originalVoiceHint).toBe('Voice 1')
    expect(result[1].originalVoiceHint).toBe('Voice 46')
    expect(result.every(r => r.profileName === undefined)).toBe(true)
    expect(result.map(r => [r.startSample, r.endSample])).toEqual([[0, 480000], [480000, 960000]])
  })
  it('same old Voice hint supplies no identity proof for genuinely different vectors', () => {
    const result = qualify(prepared(fixture(2), i => i ? B : A))
    expect(result.every(r => r.status === 'preserve')).toBe(true)
    expect(result.every(r => r.acousticIdentity === undefined)).toBe(true)
  })
  it('distinct repeated voices form separate anonymous cohorts', () => {
    const result = qualify(prepared(fixture(4), i => i < 2 ? A : B))
    expect(result.every(r => r.status === 'qualified')).toBe(true)
    expect(result[0].acousticIdentity).not.toBe(result[2].acousticIdentity)
  })
  it('rejects transitive bridges and retains unqualified exact spans', () => {
    const result = qualify(prepared(fixture(3), i => vector(i * 20)))
    expect(result[0].status).toBe('qualified')
    expect(result[2]).toMatchObject({ status: 'preserve', reason: 'inconsistent_anchors' })
  })
  it('requires two entire 30s windows for a real name at the existing .88 floor and .05 margin', () => {
    const profiles = [{ name: 'Gina', embeddings: [[12, 0, 0]], profileSHA256: sha(999) }]
    const result = qualify(prepared(), profiles)
    expect(result.every(r => r.profileName === 'Gina')).toBe(true)
    expect(result[0].provenance).toMatchObject({ identityCosine: .88, identityMargin: .05, profileSHA256: sha(999) })
    expect(qualify(prepared(fixture(1)), profiles)[0]).toMatchObject({ status: 'preserve' })
    const weak = qualify(prepared(), [{ name: 'Gina', embeddings: [vector(30)], profileSHA256: sha(999) }])
    expect(weak.every(r => r.profileName === undefined)).toBe(true)
  })
  it('profile ambiguity preserves anonymity and never changes the frozen profile cohort', () => {
    const profiles = [{ name: 'Gina', embeddings: [A], profileSHA256: sha(999) }, { name: 'Ryan', embeddings: [vector(10)], profileSHA256: sha(998) }]
    const before = JSON.stringify(profiles), result = qualify(prepared(), profiles)
    expect(result.every(r => r.profileName === undefined)).toBe(true)
    expect(JSON.stringify(profiles)).toBe(before)
  })
  it('half coherence can reject a mixed window but cannot supply independent support', () => {
    const p = prepared(fixture(1)); p.receipts[0].halfEmbeddings = [A, A]
    expect(qualify(p)[0].status).toBe('preserve')
    const mixed = prepared(); mixed.receipts[1].halfEmbeddings = [A, B]
    expect(qualify(mixed)[1]).toMatchObject({ status: 'preserve', reason: 'incoherent_halves' })
    expect(qualify(mixed)[0].status).toBe('preserve')
  })
  it.each(['binding', 'model', 'crop', 'repeat_pcm', 'vector', 'duplicate_receipt'])('withholds invalid extraction receipt %s', bad => {
    const p = prepared()
    if (bad === 'binding') p.receipts[1].windowBindingSHA256 = sha(777)
    if (bad === 'model') p.receipts[1].modelSHA256 = sha(777)
    if (bad === 'crop') p.receipts[1].sampleCount = 64_000
    if (bad === 'repeat_pcm') p.receipts[1].pcmSHA256 = p.receipts[0].pcmSHA256
    if (bad === 'vector') p.receipts[1].embedding = [NaN, 0, 0]
    if (bad === 'duplicate_receipt') p.receipts.push(p.receipts[1])
    expect(qualify(p).every(r => r.status === 'preserve')).toBe(true)
  })
  it('rejects modified prepared raw lineage even when an old embedding receipt exists', () => {
    const p = prepared(); p.plan.windows[1].sources[0].audioSHA256 = sha(777)
    expect(qualify(p)[1]).toMatchObject({ status: 'preserve', reason: 'receipt_or_lineage_conflict' })
  })
})
