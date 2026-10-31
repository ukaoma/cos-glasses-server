// Batch naming and its Undo, executed against real files under a scratch data home: the real relabel primitives, the
// real plan and commit, the real profile store and eviction, the real ledger and journal. Only the embedding extractor
// and the sherpa runtime are fake. Every name and word here is invented.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fakeSpeakerRuntime } from './__fixtures__/fake-speaker-runtime.js'
import { bindMacSpeakerShadowRepair, inspectMacSpeakerShadowCallSource, type MacShadowRepairSource } from './mac-speaker-shadow-repair.js'
import { SYNTHETIC_SECONDS, SYNTHETIC_SPANS, syntheticEmbeddings, syntheticNative } from './__fixtures__/speaker-shadow/synthetic-meeting.js'

const SESSION = 'mac_1b2c3d4e-0000-4000-8000-00000000abcd'
const OTHER_SESSION = 'mac_9f8e7d6c-0000-4000-8000-00000000dcba'
const DIM = 192
const SOURCE = `mac-assign:${SESSION}`
type Axis = 0 | 1 | 2 | 3 | 4
const DANA: Axis = 0, THEO: Axis = 1, NEVA: Axis = 2, IVO: Axis = 3, OWNER: Axis = 4

let home = ''
let sidecarPath = ''
let meetingPath = ''
const calls = new Map<string, { sidecarPath: string; filepath: string }>()
const flags = { capture: false, lease: false, open: true, finalizing: false }
/** Faults only real I/O or a future store could produce. */
const faults = { failWrite: null as string | null, skipWrites: 0, reverseRetractWalk: false, dieOnAppend: null as string | null, refuseAppend: null as string | null }
const library = { operations: null as null | Record<string, unknown>, direct: null as null | Record<string, unknown> }
const identity = { label: 'MU', name: 'Miles' }
const data = (...parts: string[]) => join(process.env.COS_DATA_DIR as string, ...parts)

/** Same voice about .89 apart (real near-duplicate gate is .95), different voices orthogonal. */
function voiceprint(marker: number, axis: Axis): Float32Array {
  const v = new Float32Array(DIM)
  for (let k = axis; k < 120; k += 5) v[k] = 100
  v[120 + (marker % 63)] = 170
  v[DIM - 1] = marker
  return v
}
const rows = (axis: Axis, markers: number[]) => markers.map(marker => Array.from(voiceprint(marker, axis)))
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i)
const hashOf = (vector: ArrayLike<number>) => createHash('sha256').update(Buffer.from(Float32Array.from(vector).buffer)).digest('hex')

function wav(axis: Axis, marker: number, seconds = 3): Buffer {
  const samples = seconds * 16_000
  const b = Buffer.alloc(44 + samples * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16_000, 24); b.writeUInt32LE(32_000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40)
  for (let at = 44; at < b.length; at += 2) b.writeInt16LE((axis + 1) * 100 + marker, at)
  return b
}

interface SeedVoice { label: string; axis: Axis; chunks: number }
const VOICES: SeedVoice[] = [
  { label: 'Voice 1', axis: DANA, chunks: 4 },
  { label: 'Voice 2', axis: THEO, chunks: 4 },
  { label: 'Voice 3', axis: NEVA, chunks: 3 },
  { label: 'Voice 4', axis: NEVA, chunks: 3 },
  { label: 'Voice 5', axis: IVO, chunks: 3 },
  { label: 'Voice 6', axis: OWNER, chunks: 3 },
  { label: 'Ext', axis: IVO, chunks: 1 },
  { label: 'Neva Sharpe', axis: NEVA, chunks: 1 },
]

/** The shape of a real saved Mac sidecar: compacted chunks, a raw index map with a silent gap, turns, words and HQ segments. */
function seedMeeting(options: { voices?: SeedVoice[]; noAudioFor?: string[]; session?: string; markerBase?: number } = {}): void {
  const voices = options.voices ?? VOICES
  const session = options.session ?? SESSION
  const markerBase = options.markerBase ?? 0
  const chunks: unknown[] = []
  const chunkEntries: unknown[] = []
  let raw = 0
  const turns: string[] = []
  rmSync(data('meeting-audio', session), { recursive: true, force: true })
  mkdirSync(data('meeting-audio', session), { recursive: true })
  for (const voice of voices) {
    for (let i = 0; i < voice.chunks; i++) {
      const text = `invented remark ${raw} about shelf labels`
      const chunk = {
        speaker: voice.label, elapsed: raw * 3000, similarity: 0.4, text, audioDurationMs: 3000, backend: 'nemotron',
        segments: [{ speaker: voice.label, startSec: 0, endSec: 3, text, similarity: 0.4 }],
        words: [{ word: 'invented', start: 0, end: 0.5 }],
      }
      chunks.push(chunk)
      chunkEntries.push({ chunkIndex: raw, chunk })
      if (!options.noAudioFor?.includes(voice.label)) writeFileSync(data('meeting-audio', session, `chunk_${String(raw).padStart(4, '0')}.wav`), wav(voice.axis, markerBase + raw + 1))
      raw++
      if (i === 0) chunkEntries.push({ chunkIndex: 900 + raw, chunk: { text: '', speaker: 'Ext', elapsed: raw * 3000 } })
      // Words repeat across people on every real call, and a person may already be named here.
      turns.push(`[${voice.label}]: ${i === 0 ? 'Yeah.' : text}`)
    }
  }
  const doc = {
    schemaVersion: 2, sessionId: session, sourceType: 'mac_system_audio', startTime: 1_790_000_000_000, durationMs: raw * 3000, finalizationState: 'complete', syncState: 'finalized',
    speakers: ['Neva Sharpe'], chunks, chunkEntries, batchSegments: [{ startChunkIdx: 0, endChunkIdx: raw, startElapsed: 0, speakerWords: [{ word: 'invented', start: 0, speaker: 'Voice 1' }] }],
  }
  mkdirSync(join(home, 'meetings'), { recursive: true })
  const stem = session === SESSION ? 'call' : `call-${session}`
  const files = { sidecarPath: join(home, 'meetings', `${stem}.g2-chunks.json`), filepath: join(home, 'meetings', `${stem}.md`) }
  calls.set(session, files)
  if (session === SESSION) { sidecarPath = files.sidecarPath; meetingPath = files.filepath }
  writeFileSync(files.sidecarPath, `${JSON.stringify(doc, null, 2)}\n`)
  writeFileSync(files.filepath, `# Invented review\n\n| **Date** | 2026-10-28 |\n\n## Attendees\n\n- Neva Sharpe\n\n## Summary\n\nInvented summary.\n\n## Transcript\n\n${turns.join('\n')}\n`)
}

interface SeedProfile { name: string; embeddings: number[][]; sources: string[] }
function ordinary(name: string, axis: Axis, extra: Array<{ marker: number; source: string }> = []): SeedProfile {
  const base = range(30, 12)
  return { name, embeddings: [...rows(axis, base), ...extra.map(e => Array.from(voiceprint(e.marker, axis)))], sources: [...base.map(() => 'g2-training'), ...extra.map(e => e.source)] }
}
function seedProfiles(overrides: SeedProfile[] = []): void {
  const byName = new Map([ordinary('Dana Reyes', DANA), ordinary('Theo Marsh', THEO), ordinary('Neva Sharpe', NEVA), ordinary('Ivo Lund', IVO), ordinary('MU', OWNER), ordinary('Miles', OWNER)].map(p => [p.name, p]))
  for (const p of overrides) byName.set(p.name, p)
  writeFileSync(data('voice-profiles.json'), JSON.stringify({ profiles: [...byName.values()] }))
}
const store = (): SeedProfile[] => JSON.parse(readFileSync(data('voice-profiles.json'), 'utf-8')).profiles
const profile = (name: string): SeedProfile => store().find(p => p.name === name) as SeedProfile
const speakers = (): string[] => JSON.parse(readFileSync(sidecarPath, 'utf-8')).chunks.map((c: { speaker: string }) => c.speaker)
const labelCount = (label: string): number => speakers().filter(s => s === label).length
const markdown = (): string => readFileSync(meetingPath, 'utf-8')
const ledger = (id = SESSION): Array<Record<string, unknown>> => { try { return readFileSync(data('meeting-corrections', `${id}.jsonl`), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const journalFiles = (): string[] => { try { return readdirSync(data('mac-voice-naming-batches', SESSION)) } catch { return [] } }
const journal = (batchId: string) => JSON.parse(readFileSync(data('mac-voice-naming-batches', SESSION, `${batchId}.json`), 'utf-8'))
const revisionOf = (md: string, sidecar: string): string => createHash('sha256').update(readFileSync(md)).update(readFileSync(sidecar)).digest('hex')
const revision = (): string => revisionOf(meetingPath, sidecarPath)
const revisionFor = (session: string): string => { const call = calls.get(session)!; return revisionOf(call.filepath, call.sidecarPath) }
const fingerprint = () => ({ md: markdown(), sidecar: readFileSync(sidecarPath, 'utf-8'), store: readFileSync(data('voice-profiles.json'), 'utf-8'), ledger: ledger(), journals: journalFiles() })

const SUGGESTED = [
  { labels: ['Voice 1'], name: 'Dana Reyes', score: 0.93, margin: 0.4, highConfidence: true },
  { labels: ['Voice 2'], name: 'Theo Marsh', score: 0.91, margin: 0.3, highConfidence: true },
  { labels: ['Voice 3', 'Voice 4'], name: 'Neva Sharpe', score: 0.9, margin: 0.2, highConfidence: true },
  { labels: ['Voice 5'], name: 'Ivo Lund', score: 0.74, margin: 0.2, highConfidence: false },
  { labels: ['Voice 6'], name: 'MU', score: 0.97, margin: 0.5, highConfidence: true },
  { labels: ['Voice 6'], name: 'Miles', score: 0.97, margin: 0.5, highConfidence: true },
  { labels: ['Ext'], name: 'Ivo Lund', score: 0.9, margin: 0.5, highConfidence: true },
].map(s => ({ ...s, units: 4, kept: 4, requiresConfirmation: true as const }))

const ITEM_1 = { labels: ['Voice 1'], name: 'Dana Reyes' }
const ITEM_2 = { labels: ['Voice 2'], name: 'Theo Marsh' }
const MERGED = { labels: ['Voice 3', 'Voice 4'], name: 'Neva Sharpe' }

/** The real plan, resolved after load() installed the fake runtime. importActual would bypass it. */
const realPlan: NonNullable<Parameters<Lib['createMacVoiceNamingBatches']>[0]['plan']> = async input => (await import('./mac-voice-assignment.js')).planMacVoiceAssignment(input)

type Lib = typeof import('./mac-voice-naming-batch.js')
type Deps = Parameters<Lib['createMacVoiceNamingBatches']>[0]

async function load(overrides: Partial<Deps> = {}) {
  vi.resetModules()
  vi.doMock('./profile.js', () => ({ getOwnerSpeakerLabel: () => identity.label, getOwnerName: () => identity.name, getVocabulary: () => [], getTranscriptionProfileStatus: () => ({}) }))
  vi.doMock('./meeting-corrections.js', async () => {
    const actual = await vi.importActual<typeof import('./meeting-corrections.js')>('./meeting-corrections.js')
    return {
      ...actual,
      appendCorrection: (session: string, row: { phase: string }) => {
        if (faults.dieOnAppend === row.phase) throw new Error('process died')
        if (faults.refuseAppend === row.phase) return false
        return actual.appendCorrection(session, row as Parameters<typeof actual.appendCorrection>[1])
      },
    }
  })
  vi.doMock('./atomic-fs.js', async () => {
    const actual = await vi.importActual<typeof import('./atomic-fs.js')>('./atomic-fs.js')
    return { ...actual, durableAtomicWriteFileSync: (path: string, ...rest: [string | Buffer, { mode?: number }?]) => { if (faults.failWrite && path.endsWith(faults.failWrite) && faults.skipWrites-- <= 0) throw new Error('disk refused'); return actual.durableAtomicWriteFileSync(path, ...rest) } }
  })
  vi.doMock('./cos-operations-meetings.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('./cos-operations-meetings.js')
    return { ...actual, cosOperationsMeetingsConfigured: () => library.operations !== null, findCosOperationsMeetingBySessionId: () => library.operations, findDirectLibraryMeetingBySessionId: () => library.direct }
  })
  vi.doMock('./speaker-embeddings.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('./speaker-embeddings.js')
    ;(actual.__installSpeakerRuntimeForTests as (r: unknown) => void)(fakeSpeakerRuntime())
    const retract = actual.retractEmbeddingsBySource as (name: string, matches: (source: string) => boolean) => { removed: number; remaining: number }
    return {
      ...actual,
      // A store that walks its samples newest first, which the predicate must not trust blindly.
      retractEmbeddingsBySource: (name: string, matches: (source: string) => boolean) => {
        if (!faults.reverseRetractWalk) return retract(name, matches)
        const sources = (actual.readVoiceProfiles as () => { profiles: SeedProfile[] })().profiles.find(p => p.name === name)?.sources ?? []
        const verdicts = [...sources].reverse().map(matches).reverse()
        let at = 0
        return retract(name, () => verdicts[at++])
      },
      isEmbeddingAvailable: () => true,
      extractEmbedding: (audio: Buffer) => { const code = audio.readInt16LE(44); return voiceprint(code % 100, (Math.floor(code / 100) - 1) as Axis) },
    }
  })
  const lib = await import('./mac-voice-naming-batch.js')
  const deps: Deps = {
    store: { findBySessionId: id => calls.get(id) ?? null },
    captureActive: () => flags.capture,
    reviewRevision: revisionOf,
    callViewMutationRefusal: () => null,
    finalizingRefusal: () => (flags.finalizing ? { status: 409, body: { reason: 'meeting_finalizing' } } : null),
    suggestions: id => ({ sourceRevision: revisionFor(id), suggestions: SUGGESTED }),
    recordingLease: () => flags.lease,
    admissionsOpen: () => flags.open,
    acquireLock: async () => ({ release: () => {} }),
    acquireWork: () => ({ release: () => {} }),
    log: () => {},
    ...overrides,
  }
  return { lib, batches: lib.createMacVoiceNamingBatches(deps) }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cos-naming-batch-'))
  mkdirSync(join(home, 'data'), { recursive: true })
  vi.stubEnv('HOME', home)
  vi.stubEnv('COS_DATA_DIR', join(home, 'data'))
  vi.stubEnv('COS_PROFILE_PATH', join(home, 'profile.json'))
  vi.stubEnv('COS_OPERATIONS_DIR', '')
  vi.stubEnv('COS_SCRIPTS_DIR', '')
  Object.assign(flags, { capture: false, lease: false, open: true, finalizing: false })
  Object.assign(faults, { failWrite: null, skipWrites: 0, reverseRetractWalk: false, dieOnAppend: null, refuseAppend: null })
  calls.clear()
  Object.assign(library, { operations: null, direct: null })
  Object.assign(identity, { label: 'MU', name: 'Miles' })
  seedMeeting()
  seedProfiles()
})
afterEach(() => {
  vi.resetModules()
  vi.doUnmock('./profile.js')
  vi.doUnmock('./speaker-embeddings.js')
  vi.doUnmock('./atomic-fs.js')
  vi.doUnmock('./meeting-corrections.js')
  vi.doUnmock('./cos-operations-meetings.js')
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('apply', () => {
  it('names every item through the normal path, in the one copy, with samples and ledger rows', async () => {
    const { batches } = await load()
    const before = { dana: profile('Dana Reyes').embeddings.length, neva: profile('Neva Sharpe').embeddings.length }
    const out = await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1, ITEM_2, MERGED], confirm: true })

    expect(out.state).toBe('applied')
    expect(out.reason).toBeUndefined()
    expect(out.notNamed).toEqual([])
    expect(out.named.map(n => [n.labels, n.name])).toEqual([[['Voice 1'], 'Dana Reyes'], [['Voice 2'], 'Theo Marsh'], [['Voice 3', 'Voice 4'], 'Neva Sharpe']])
    expect(out.named.every(n => n.samplesAdded > 0)).toBe(true)
    expect(out.undoAvailable).toBe(true)
    expect(out.sourceRevision).toBe(revision())
    // Labels and transcript agree, and the person already named here keeps their own turn.
    expect(labelCount('Voice 1')).toBe(0)
    expect(labelCount('Dana Reyes')).toBe(4)
    expect(labelCount('Neva Sharpe')).toBe(7)
    expect(markdown()).not.toMatch(/^\[Voice [1-4]\]:/m)
    expect(markdown().match(/^\[Neva Sharpe\]:/gm)).toHaveLength(7)
    expect(markdown()).toContain('[Voice 5]:')
    // Mac-assigned samples with the ordinary provenance, in the right profiles.
    const added = out.named[0].samplesAdded
    expect(profile('Dana Reyes').embeddings).toHaveLength(before.dana + added)
    expect(profile('Dana Reyes').sources.slice(-added)).toEqual(Array(added).fill(SOURCE))
    expect(profile('Neva Sharpe').embeddings).toHaveLength(before.neva + out.named[2].samplesAdded)
    // Every correction opened and closed, once per label.
    const rowsNow = ledger()
    expect(rowsNow.filter(r => r.phase === 'intent').map(r => r.from)).toEqual(['Voice 1', 'Voice 2', 'Voice 3', 'Voice 4'])
    expect(rowsNow.filter(r => r.phase === 'applied').map(r => r.to)).toEqual(['Dana Reyes', 'Theo Marsh', 'Neva Sharpe', 'Neva Sharpe'])
    expect(journal(out.batchId).state).toBe('applied')
  })

  it('preview reports what it would do and writes nothing, not even a journal', async () => {
    const { batches } = await load()
    const before = fingerprint()
    const out = await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1, MERGED] })
    expect(out).toMatchObject({ state: 'applied', dryRun: true, batchId: '', undoAvailable: false })
    expect(out.named.map(n => n.labels)).toEqual([['Voice 1'], ['Voice 3', 'Voice 4']])
    expect(out.named.every(n => n.samplesAdded > 0)).toBe(true)
    expect(fingerprint()).toEqual(before)
    expect(existsSync(data('mac-voice-naming-batches'))).toBe(false)
  })
})

describe('refused before any write', () => {
  const refused = async (overrides: Partial<Deps>, request: { sourceRevision?: string; items: Array<{ labels: string[]; name: string }> }) => {
    const { batches } = await load(overrides)
    const before = fingerprint()
    const out = await batches.run(SESSION, { sourceRevision: request.sourceRevision ?? revision(), items: request.items, confirm: true })
    expect(fingerprint()).toEqual(before)
    expect(out).toMatchObject({ state: 'refused', named: [], batchId: '', undoAvailable: false })
    return out
  }

  it('the caller holds an older revision', async () => {
    expect((await refused({}, { sourceRevision: 'older', items: [ITEM_1] })).reason).toBe('suggestions_stale')
  })
  it('the suggestions were computed from an older revision than the caller and the files agree on', async () => {
    expect((await refused({ suggestions: () => ({ sourceRevision: 'older', suggestions: SUGGESTED }) }, { sourceRevision: 'older', items: [ITEM_1] })).reason).toBe('suggestions_stale')
  })
  it('the meeting moved after the suggestions, even if the caller read the new revision', async () => {
    expect((await refused({ suggestions: () => ({ sourceRevision: 'older', suggestions: SUGGESTED }) }, { items: [ITEM_1] })).reason).toBe('suggestions_stale')
  })
  it('a restart lost the suggestions', async () => {
    expect((await refused({ suggestions: () => null }, { items: [ITEM_1] })).reason).toBe('suggestions_stale')
  })
  it('one item is not high confidence, and the good items around it wait too', async () => {
    const out = await refused({}, { items: [ITEM_1, { labels: ['Voice 5'], name: 'Ivo Lund' }] })
    expect(out.reason).toBe('not_high_confidence')
    expect(out.notNamed).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'not_attempted' }, { labels: ['Voice 5'], name: 'Ivo Lund', reason: 'not_high_confidence' }])
  })
  it('an item is not what was suggested: another name, or part of a merged group', async () => {
    expect((await refused({}, { items: [{ labels: ['Voice 1'], name: 'Theo Marsh' }] })).reason).toBe('not_high_confidence')
    expect((await refused({}, { items: [{ labels: ['Voice 3'], name: 'Neva Sharpe' }] })).reason).toBe('not_high_confidence')
  })
  it('a merged-row member that was not itself suggested: the wrong voice would get a wrong name and wrong samples', async () => {
    const onlyOne = () => ({ sourceRevision: revision(), suggestions: [{ ...SUGGESTED[2], labels: ['Voice 3'] }] })
    expect((await refused({ suggestions: onlyOne }, { items: [MERGED] })).reason).toBe('not_high_confidence')
    expect((await refused({ suggestions: onlyOne }, { items: [{ labels: ['Voice 4'], name: 'Neva Sharpe' }] })).reason).toBe('not_high_confidence')
  })
  it.each([['MU'], ['mu '], ['Miles'], ['MILES']])('the owner %s, even as a high-confidence suggestion', async name => {
    const out = await refused({ suggestions: () => ({ sourceRevision: revision(), suggestions: [{ ...SUGGESTED[0], labels: ['Voice 6'], name }] }) }, { items: [{ labels: ['Voice 6'], name }] })
    expect(out.reason).toBe('owner_refused')
  })
  it('Ext and a label that already names someone', async () => {
    expect((await refused({}, { items: [{ labels: ['Ext'], name: 'Ivo Lund' }] })).reason).toBe('label_not_anonymous')
    expect((await refused({ suggestions: () => ({ sourceRevision: revision(), suggestions: [{ ...SUGGESTED[0], labels: ['Neva Sharpe'], name: 'Ivo Lund' }] }) }, { items: [{ labels: ['Neva Sharpe'], name: 'Ivo Lund' }] })).reason).toBe('label_not_anonymous')
  })
  it('a Voice label no chunk carries any more', async () => {
    const out = await refused({ suggestions: () => ({ sourceRevision: revision(), suggestions: [{ ...SUGGESTED[0], labels: ['Voice 9'] }] }) }, { items: [{ labels: ['Voice 9'], name: 'Dana Reyes' }] })
    expect(out.reason).toBe('label_not_anonymous')
  })
  it('one label twice', async () => {
    expect((await refused({}, { items: [ITEM_1, ITEM_1] })).reason).toBe('duplicate_label')
  })
  it('a correction on this meeting never closed', async () => {
    mkdirSync(data('meeting-corrections'), { recursive: true })
    writeFileSync(data('meeting-corrections', `${SESSION}.jsonl`), `${JSON.stringify({ id: 'stuck', phase: 'intent', at: '2026-10-28T00:00:00.000Z', from: 'Voice 9', to: 'Dana Reyes', chunks: [1], scope: 'meeting' })}\n`)
    expect((await refused({}, { items: [ITEM_1] })).reason).toBe('correction_pending')
  })
  it.each([['capture', 'recording_active', { capture: true }], ['a live lease', 'recording_active', { lease: true }], ['a drain', 'maintenance', { open: false }], ['finalizing', 'meeting_finalizing', { finalizing: true }]])('while %s', async (_what, reason, set) => {
    Object.assign(flags, set)
    expect((await refused({}, { items: [ITEM_1] })).reason).toBe(reason)
  })
  it('while a derived call view is in force', async () => {
    const out = await refused({ callViewMutationRefusal: () => ({ status: 409, body: { reason: 'derived_call_view_requires_scoped_action' } }) }, { items: [ITEM_1] })
    expect(out.reason).toBe('derived_call_view_requires_scoped_action')
  })
  it('a session that is not a saved Mac capture', async () => {
    const { batches } = await load()
    const out = await batches.run('meeting_1786628481833_eagkaz', { sourceRevision: 'x', items: [ITEM_1], confirm: true })
    expect(out).toMatchObject({ state: 'refused', reason: 'not_saved_mac_capture' })
    expect((await batches.run(OTHER_SESSION, { sourceRevision: 'x', items: [ITEM_1], confirm: true })).reason).toBe('not_saved_mac_capture')
  })
})

describe('stopping', () => {
  it('stops at the first refusal: earlier items stay named, later ones are not attempted', async () => {
    seedMeeting({ noAudioFor: ['Voice 2'] })
    const { batches } = await load()
    const out = await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1, ITEM_2, MERGED], confirm: true })
    expect(out).toMatchObject({ state: 'partial', reason: 'audio_not_retained', undoAvailable: true })
    expect(out.named.map(n => n.labels)).toEqual([['Voice 1']])
    expect(out.notNamed).toEqual([
      { labels: ['Voice 2'], name: 'Theo Marsh', reason: 'audio_not_retained' },
      { labels: ['Voice 3', 'Voice 4'], name: 'Neva Sharpe', reason: 'not_attempted' },
    ])
    expect(labelCount('Dana Reyes')).toBe(4)
    expect(labelCount('Voice 2')).toBe(4)
    expect(labelCount('Voice 3')).toBe(3)
    expect(journal(out.batchId).state).toBe('partial')
  })

  it('names each label of a merged item, and says exactly which landed when one is refused', async () => {
    seedMeeting({ noAudioFor: ['Voice 4'] })
    const { batches } = await load()
    const out = await batches.run(SESSION, { sourceRevision: revision(), items: [MERGED, ITEM_1], confirm: true })
    expect(out.state).toBe('partial')
    expect(out.named.map(n => [n.labels, n.name])).toEqual([[['Voice 3'], 'Neva Sharpe']])
    expect(out.notNamed).toEqual([
      { labels: ['Voice 4'], name: 'Neva Sharpe', reason: 'audio_not_retained' },
      { labels: ['Voice 1'], name: 'Dana Reyes', reason: 'not_attempted' },
    ])
    expect(labelCount('Voice 3')).toBe(0)
    expect(labelCount('Voice 4')).toBe(3)
    expect(markdown()).toContain('[Voice 4]:')
  })

  it('uses the same gates as one voice, with no force: a mixed label is refused', async () => {
    seedMeeting({ voices: [{ label: 'Voice 1', axis: DANA, chunks: 2 }, { label: 'Voice 2', axis: THEO, chunks: 2 }, { label: 'Voice 1', axis: THEO, chunks: 3 }] })
    const { batches } = await load()
    const before = fingerprint()
    const out = await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1], confirm: true })
    expect(out).toMatchObject({ state: 'refused', batchId: '' })
    expect(['mixed_voice', 'below_floor']).toContain(out.reason)
    expect(fingerprint()).toEqual(before)
  })

  it('hands the plan the owner label, so its own refusal stands behind the first check', async () => {
    const seen: Array<string | undefined> = []
    const { batches } = await load({ plan: input => { seen.push(input.ownerLabel); return realPlan(input) } })
    await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1] })
    expect(seen).toEqual(['MU'])
  })

  it('takes one batch per session at a time', async () => {
    let finishPlan: () => void = () => {}
    const planning = new Promise<void>(resolve => { finishPlan = resolve })
    const { batches } = await load({ plan: async input => { await planning; return realPlan(input) } })
    const first = batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1], confirm: true })
    await new Promise(resolve => setImmediate(resolve))
    const second = await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1], confirm: true })
    expect(second).toMatchObject({ state: 'refused', reason: 'batch_running' })
    finishPlan()
    expect((await first).state).toBe('applied')
  })

  it('a recording that starts while a plan runs stops the batch before that write', async () => {
    let plans = 0
    const { batches } = await load({ plan: async input => { const planned = await realPlan(input); if (++plans === 2) flags.capture = true; return planned } })
    const out = await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1, ITEM_2], confirm: true })
    expect(out).toMatchObject({ state: 'partial', reason: 'recording_active' })
    expect(out.named.map(n => n.labels)).toEqual([['Voice 1']])
    expect(labelCount('Voice 2')).toBe(4)
    expect(ledger().filter(r => r.from === 'Voice 2')).toEqual([])
  })

  it('never writes over a change made while its plan ran', async () => {
    let plans = 0
    const { batches } = await load({
      plan: async input => {
        const planned = await realPlan(input)
        if (++plans === 2) { const doc = JSON.parse(readFileSync(sidecarPath, 'utf-8')); doc.chunks[20].speaker = 'Someone Else'; writeFileSync(sidecarPath, `${JSON.stringify(doc, null, 2)}\n`) }
        return planned
      },
    })
    const out = await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1, ITEM_2], confirm: true })
    expect(out).toMatchObject({ state: 'partial', reason: 'meeting_changed' })
    expect(labelCount('Voice 2')).toBe(4)
    expect(labelCount('Someone Else')).toBe(1)
  })

  it('refuses when the drain lease or the sync lock is not available, with nothing written', async () => {
    const before = fingerprint()
    const drained = await load({ acquireWork: () => { throw new Error('maintenance_drain_active') } })
    expect(await drained.batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1], confirm: true })).toMatchObject({ state: 'refused', reason: 'maintenance' })
    const synced = await load({ acquireLock: async () => { throw new Error('sync running, retry') } })
    expect(await synced.batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1], confirm: true })).toMatchObject({ state: 'refused', reason: 'sync_running' })
    expect(fingerprint()).toEqual(before)
  })

  it('reports a label that landed when the store then refused the samples, and stops', async () => {
    const { batches } = await load({ commit: (_session, plan) => ({ ...plan.report, enrolled: 0, skipped: 'store_unavailable' }) })
    const out = await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1, ITEM_2], confirm: true })
    expect(out).toMatchObject({ state: 'partial', reason: 'store_unavailable' })
    expect(out.named).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', samplesAdded: 0 }])
    expect(labelCount('Dana Reyes')).toBe(4)
    expect(labelCount('Voice 2')).toBe(4)
  })

  it('stops if the journal cannot be written, before touching the meeting', async () => {
    writeFileSync(data('mac-voice-naming-batches'), 'in the way')
    const { batches } = await load()
    const before = { sidecar: readFileSync(sidecarPath, 'utf-8'), md: markdown(), rows: ledger() }
    const out = await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1], confirm: true })
    expect(out).toMatchObject({ state: 'refused', reason: 'journal_unwritable', batchId: '' })
    expect({ sidecar: readFileSync(sidecarPath, 'utf-8'), md: markdown(), rows: ledger() }).toEqual(before)
  })
})

describe('the suggestions are checked again before each write', () => {
  /** What the real source does: null as soon as the profile store differs from what the job scored against. */
  const nullOnceStoreChanges = () => {
    const atJob = readFileSync(data('voice-profiles.json'), 'utf-8')
    return () => (readFileSync(data('voice-profiles.json'), 'utf-8') === atJob ? { sourceRevision: revision(), suggestions: SUGGESTED } : null)
  }

  it('this batch does not trip over its own commits', async () => {
    const { batches } = await load({ suggestions: nullOnceStoreChanges() })
    const out = await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1, ITEM_2, MERGED], confirm: true })
    expect(out.state).toBe('applied')
    expect(out.named).toHaveLength(3)
  })

  it('a profile change during the first plan stops the batch before anything is written', async () => {
    const { batches } = await load({
      suggestions: nullOnceStoreChanges(),
      plan: async input => { const planned = await realPlan(input); writeFileSync(data('voice-profiles.json'), JSON.stringify({ profiles: store().filter(p => p.name !== 'Ivo Lund') })); return planned },
    })
    const mdBefore = markdown()
    const sidecarBefore = readFileSync(sidecarPath, 'utf-8')
    const out = await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1, ITEM_2], confirm: true })
    expect(out).toMatchObject({ state: 'refused', reason: 'suggestions_stale', batchId: '', named: [] })
    expect(markdown()).toBe(mdBefore)
    expect(readFileSync(sidecarPath, 'utf-8')).toBe(sidecarBefore)
    expect(journalFiles()).toEqual([])
    expect(ledger()).toEqual([])
  })

  it('the suggestion itself is re-read: an item no longer suggested when the write comes is not written', async () => {
    let current = SUGGESTED
    const { batches } = await load({
      suggestions: () => ({ sourceRevision: revision(), suggestions: current }),
      plan: async input => { const planned = await realPlan(input); current = SUGGESTED.filter(s => s.name !== 'Dana Reyes'); return planned },
    })
    const out = await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1], confirm: true })
    expect(out).toMatchObject({ state: 'refused', reason: 'suggestions_stale' })
    expect(labelCount('Voice 1')).toBe(4)
  })

  it('a profile change later in the batch stops it there: what landed stays, the rest is stale', async () => {
    let plans = 0
    const { batches } = await load({
      suggestions: nullOnceStoreChanges(),
      plan: async input => {
        const planned = await realPlan(input)
        if (++plans === 2) writeFileSync(data('voice-profiles.json'), JSON.stringify({ profiles: store().filter(p => p.name !== 'Ivo Lund') }))
        return planned
      },
    })
    const out = await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1, ITEM_2, MERGED], confirm: true })
    expect(out).toMatchObject({ state: 'partial', reason: 'suggestions_stale' })
    expect(out.named.map(n => n.labels)).toEqual([['Voice 1']])
    expect(out.notNamed).toEqual([
      { labels: ['Voice 2'], name: 'Theo Marsh', reason: 'suggestions_stale' },
      { labels: ['Voice 3', 'Voice 4'], name: 'Neva Sharpe', reason: 'not_attempted' },
    ])
    expect(labelCount('Voice 2')).toBe(4)
  })
})

let commitNow: Deps['commit'] | undefined
const samplesOf = (name: string) => { const p = profile(name); return p.embeddings.map((e, i) => `${p.sources[i]}#${hashOf(e)}`) }
const named = (batches: Awaited<ReturnType<typeof load>>['batches'], items: Array<{ labels: string[]; name: string }>) => batches.run(SESSION, { sourceRevision: revision(), items, confirm: true })

describe('a crash', () => {
  it('between items reads as interrupted, and Undo takes back what landed', async () => {
    let plans = 0
    const { batches } = await load({ plan: async input => { if (++plans === 2) throw new Error('process died'); return realPlan(input) } })
    const originalSidecar = readFileSync(sidecarPath, 'utf-8')
    const originalMarkdown = markdown()
    const danaBefore = samplesOf('Dana Reyes')
    const out = await named(batches, [ITEM_1, ITEM_2])
    expect(out).toMatchObject({ state: 'partial', reason: 'interrupted', undoAvailable: true })
    expect(journal(out.batchId).state).toBe('running')
    expect(batches.list(SESSION).batches).toEqual([expect.objectContaining({ batchId: out.batchId, state: 'interrupted', undoAvailable: true, named: [expect.objectContaining({ labels: ['Voice 1'] })] })])
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone).toMatchObject({ state: 'undone', left: [] })
    expect(undone.reverted).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes' }])
    expect(readFileSync(sidecarPath, 'utf-8')).toBe(originalSidecar)
    expect(markdown()).toBe(originalMarkdown)
    expect(samplesOf('Dana Reyes')).toEqual(danaBefore)
  })

  it('reads as interrupted to a new server process too', async () => {
    let plans = 0
    const first = await load({ plan: async input => { if (++plans === 2) throw new Error('process died'); return realPlan(input) } })
    const out = await named(first.batches, [ITEM_1, ITEM_2])
    const second = await load()
    expect(second.batches.list(SESSION).batches[0]).toMatchObject({ batchId: out.batchId, state: 'interrupted', undoAvailable: true })
    expect((await second.batches.undo(SESSION, out.batchId, true)).state).toBe('undone')
    expect(labelCount('Voice 1')).toBe(4)
  })

  it('after the label and before the samples: Undo puts the label back and closes the open ledger row', async () => {
    const originalSidecar = readFileSync(sidecarPath, 'utf-8')
    const danaBefore = samplesOf('Dana Reyes')
    const { batches } = await load({ commit: () => { throw new Error('process died') } })
    const out = await named(batches, [ITEM_1])
    expect(journal(out.batchId).steps[0].state).toBe('intent')
    expect(labelCount('Dana Reyes')).toBe(4)
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone).toMatchObject({ state: 'undone', samplesRemoved: 0 })
    expect(readFileSync(sidecarPath, 'utf-8')).toBe(originalSidecar)
    expect(samplesOf('Dana Reyes')).toEqual(danaBefore)
    const { pendingCorrections } = await import('./meeting-corrections.js')
    expect(pendingCorrections(SESSION)).toEqual([])
  })

  it('after the commit and before the journal: Undo still removes exactly those samples and restores what they evicted', async () => {
    const mac = range(42, 12).map(marker => ({ marker, source: `mac-assign:${OTHER_SESSION}` }))
    seedProfiles([ordinary('Dana Reyes', DANA, [...mac.slice(0, 9), { marker: 2, source: SOURCE }])])
    const danaBefore = samplesOf('Dana Reyes')
    const { batches } = await load({ commit: (session, plan) => { commitNow?.(session, plan); throw new Error('process died') } })
    commitNow = (await import('./mac-voice-assignment.js')).commitMacVoiceAssignment
    const out = await named(batches, [ITEM_1])
    expect(journal(out.batchId).steps[0].state).toBe('intent')
    expect(samplesOf('Dana Reyes')).not.toEqual(danaBefore)
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone.state).toBe('undone')
    expect(undone.samplesRemoved).toBeGreaterThan(0)
    expect([...samplesOf('Dana Reyes')].sort()).toEqual([...danaBefore].sort())
  })

  it('before anything landed: Undo is safe and does not claim to have reverted it', async () => {
    const before = fingerprint()
    const { batches } = await load({ commit: () => { throw new Error('process died') } })
    const out = await named(batches, [ITEM_1])
    // Rewind the files to what a death between the journal's intent and the first write leaves.
    writeFileSync(sidecarPath, before.sidecar)
    writeFileSync(meetingPath, before.md)
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone).toMatchObject({ state: 'undone', reverted: [], samplesRemoved: 0 })
    expect(readFileSync(sidecarPath, 'utf-8')).toBe(before.sidecar)
  })
})

describe('undo', () => {
  /** Ten older Mac samples on Dana, so a batch's samples evict some of them. */
  const macHistory = (session = OTHER_SESSION) => range(42, 10).map(marker => ({ marker, source: `mac-assign:${session}` }))

  it('reverses the whole batch newest first and leaves every byte and sample as it was', async () => {
    const before = { sidecar: readFileSync(sidecarPath, 'utf-8'), md: markdown(), dana: samplesOf('Dana Reyes'), theo: samplesOf('Theo Marsh'), neva: samplesOf('Neva Sharpe') }
    const { batches } = await load()
    const out = await named(batches, [ITEM_1, ITEM_2, MERGED])
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone).toMatchObject({ state: 'undone', left: [], sourceRevision: revision() })
    expect(undone.reverted).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes' }, { labels: ['Voice 2'], name: 'Theo Marsh' }, { labels: ['Voice 3', 'Voice 4'], name: 'Neva Sharpe' }])
    expect(undone.samplesRemoved).toBe(4 + 4 + 3 + 3)
    expect({ sidecar: readFileSync(sidecarPath, 'utf-8'), md: markdown(), dana: samplesOf('Dana Reyes'), theo: samplesOf('Theo Marsh'), neva: samplesOf('Neva Sharpe') }).toEqual(before)
    // The ledger agrees: the corrections no longer count as landed, and each undo row closed.
    const { appliedCorrections, pendingCorrections } = await import('./meeting-corrections.js')
    expect(appliedCorrections(SESSION)).toEqual([])
    expect(pendingCorrections(SESSION)).toEqual([])
    expect(ledger().filter(r => r.phase === 'reverted').map(r => r.to)).toEqual(['Voice 4', 'Voice 3', 'Voice 2', 'Voice 1'])
    expect(batches.list(SESSION).batches[0]).toMatchObject({ state: 'undone', undoAvailable: false })
  })

  it('keeps a prior single naming of the same call, including a sample identical to one the batch planned', async () => {
    const prior = [{ marker: 50, source: SOURCE }, { marker: 2, source: SOURCE }]
    seedProfiles([ordinary('Dana Reyes', DANA, prior)])
    const danaBefore = samplesOf('Dana Reyes')
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    expect(out.named[0].samplesAdded).toBe(3)
    expect(profile('Dana Reyes').sources.filter(s => s === SOURCE)).toHaveLength(5)
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone.samplesRemoved).toBe(3)
    expect(samplesOf('Dana Reyes')).toEqual(danaBefore)
    expect(profile('Dana Reyes').sources.filter(s => s === SOURCE)).toHaveLength(2)
  })

  it('takes back the samples of one voice in a batch naming one person twice, in the right order', async () => {
    seedProfiles([ordinary('Neva Sharpe', NEVA, macHistory())])
    const nevaBefore = samplesOf('Neva Sharpe')
    const { batches } = await load()
    const out = await named(batches, [MERGED])
    expect(out.named[0].samplesAdded).toBe(6)
    expect((await batches.undo(SESSION, out.batchId, true)).state).toBe('undone')
    expect([...samplesOf('Neva Sharpe')].sort()).toEqual([...nevaBefore].sort())
  })

  it('leaves a label a person changed afterwards and returns partial, still removing what the batch wrote for it', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1, ITEM_2])
    const { relabelSidecarJson } = await import('./meeting-relabel.js')
    const { appendCorrection } = await import('./meeting-corrections.js')
    const person = relabelSidecarJson(readFileSync(sidecarPath, 'utf-8'), 'Dana Reyes', 'Rae Quill', [])
    if (!person.ok) throw new Error(person.error)
    writeFileSync(sidecarPath, person.value.json)
    appendCorrection(SESSION, { id: 'person-1', phase: 'applied', at: new Date().toISOString(), from: 'Dana Reyes', to: 'Rae Quill', chunks: person.value.changed, scope: 'meeting' })
    const danaBaseline = profile('Dana Reyes').embeddings.length - out.named[0].samplesAdded
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone.state).toBe('partial')
    expect(undone.left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'label_changed_by_person' }])
    expect(undone.reverted).toEqual([{ labels: ['Voice 2'], name: 'Theo Marsh' }])
    expect(labelCount('Rae Quill')).toBe(4)
    expect(labelCount('Voice 2')).toBe(4)
    expect(profile('Dana Reyes').embeddings).toHaveLength(danaBaseline)
    expect(batches.list(SESSION).batches[0]).toMatchObject({ state: 'undo_partial', undoAvailable: false })
  })

  it('sees a person change that touched only part of a label, read from chunks[] and not chunkEntries', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const doc = JSON.parse(readFileSync(sidecarPath, 'utf-8'))
    doc.chunks[1].speaker = 'Rae Quill'
    writeFileSync(sidecarPath, `${JSON.stringify(doc, null, 2)}\n`)
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone.left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'label_changed_by_person' }])
    expect(speakers().slice(0, 4)).toEqual(['Dana Reyes', 'Rae Quill', 'Dana Reyes', 'Dana Reyes'])
  })

  it('leaves a label a person changed by a ledger row alone even when the words read as if nothing happened', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const { appendCorrection } = await import('./meeting-corrections.js')
    const { changed } = journal(out.batchId).steps[0]
    appendCorrection(SESSION, { id: 'person-2', phase: 'applied', at: new Date().toISOString(), from: 'Rae Quill', to: 'Dana Reyes', chunks: [changed[0]], scope: 'meeting' })
    expect((await batches.undo(SESSION, out.batchId, true)).left[0]).toMatchObject({ reason: 'label_changed_by_person' })
    expect(labelCount('Dana Reyes')).toBe(4)
  })

  it.each([
    ['the whole label', { phase: 'confirmed', chunks: [] as number[] }],
    ['the chunks', { phase: 'confirmed-chunks', chunks: [0] }],
  ])('keeps a name and its samples when a person confirmed %s afterwards', async (_what, row) => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const samples = samplesOf('Dana Reyes')
    const { appendCorrection } = await import('./meeting-corrections.js')
    appendCorrection(SESSION, { id: 'person-3', at: new Date().toISOString(), from: 'Dana Reyes', to: 'Dana Reyes', scope: 'meeting', ...row } as Parameters<typeof appendCorrection>[1])
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone).toMatchObject({ state: 'partial', samplesRemoved: 0 })
    expect(undone.left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'confirmed_by_person' }])
    expect(samplesOf('Dana Reyes')).toEqual(samples)
    expect(labelCount('Dana Reyes')).toBe(4)
  })

  it('does not count a person action that was itself taken back, or one on other chunks', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const { appendCorrection } = await import('./meeting-corrections.js')
    const at = new Date().toISOString()
    appendCorrection(SESSION, { id: 'person-4', phase: 'applied', at, from: 'Dana Reyes', to: 'Rae Quill', chunks: [0], scope: 'meeting' })
    appendCorrection(SESSION, { id: 'person-4', phase: 'reverted', at, from: 'Rae Quill', to: 'Dana Reyes', chunks: [0], scope: 'meeting' })
    appendCorrection(SESSION, { id: 'person-5', phase: 'applied', at, from: 'Voice 5', to: 'Ivo Lund', chunks: [15], scope: 'meeting' })
    expect((await batches.undo(SESSION, out.batchId, true)).state).toBe('undone')
    expect(labelCount('Voice 1')).toBe(4)
  })

  it('reverts the transcript by turn order after a later rename, even where the words repeat', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1, ITEM_2])
    // A person renames another voice: the markdown is no longer what the batch left, and "Yeah." is in every voice's turns.
    writeFileSync(meetingPath, markdown().replace(/^\[Voice 5\]:/gm, '[Ivo Lund]:'))
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone.state).toBe('undone')
    expect(markdown().match(/^\[Voice 1\]:/gm)).toHaveLength(4)
    expect(markdown().match(/^\[Voice 2\]:/gm)).toHaveLength(4)
    expect(markdown()).not.toMatch(/^\[(Dana Reyes|Theo Marsh)\]:/m)
    expect(markdown().match(/^\[Ivo Lund\]:/gm)).toHaveLength(3)
    expect(markdown().match(/^\[Neva Sharpe\]:/gm)).toHaveLength(1)
    expect(markdown().match(/^\[[^\]]+\]: Yeah\.$/gm)).toHaveLength(8)
  })

  it('never renames a turn that already had the name, when the batch gave the same person more turns', async () => {
    const { batches } = await load()
    const out = await named(batches, [MERGED])
    writeFileSync(meetingPath, markdown().replace(/^\[Voice 5\]:/gm, '[Ivo Lund]:'))
    expect((await batches.undo(SESSION, out.batchId, true)).state).toBe('undone')
    expect(markdown().match(/^\[Neva Sharpe\]:/gm)).toHaveLength(1)
    expect(markdown().match(/^\[Voice 3\]:/gm)).toHaveLength(3)
    expect(markdown().match(/^\[Voice 4\]:/gm)).toHaveLength(3)
  })

  it.each([
    ['turns were added', (md: string) => `${md}[Voice 5]: one more invented remark\n`],
    ['a turn of this voice now says someone else', (md: string) => md.replace('[Dana Reyes]: Yeah.', '[Rae Quill]: Yeah.')],
  ])('leaves the voice when %s, rather than guess', async (_what, edit) => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    writeFileSync(meetingPath, edit(markdown()))
    const edited = markdown()
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone.left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'transcript_changed' }])
    expect(markdown()).toBe(edited)
    expect(labelCount('Dana Reyes')).toBe(4)
    expect(batches.list(SESSION).batches[0].undoAvailable).toBe(true)
  })

  it('a second Undo changes nothing and answers the same', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1, MERGED])
    const first = await batches.undo(SESSION, out.batchId, true)
    const after = fingerprint()
    const second = await batches.undo(SESSION, out.batchId, true)
    expect(second).toEqual(first)
    expect(fingerprint()).toEqual(after)
  })

  it('answers a repeat even while a recording is running', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const first = await batches.undo(SESSION, out.batchId, true)
    flags.capture = true
    expect(await batches.undo(SESSION, out.batchId, true)).toEqual(first)
  })

  it('stops for a recording that starts partway, and a retry finishes the rest', async () => {
    const before = fingerprint()
    let works = 0
    const { batches } = await load({ acquireWork: () => { if (++works === 4) flags.capture = true; return { release: () => {} } } })
    const out = await named(batches, [ITEM_1, ITEM_2])
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone.state).toBe('partial')
    expect(undone.reverted).toEqual([{ labels: ['Voice 2'], name: 'Theo Marsh' }])
    expect(undone.left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'recording_active' }])
    flags.capture = false
    const retried = await batches.undo(SESSION, out.batchId, true)
    expect(retried.state).toBe('undone')
    expect(retried.reverted).toHaveLength(2)
    expect(retried.samplesRemoved).toBe(8)
    expect(readFileSync(sidecarPath, 'utf-8')).toBe(before.sidecar)
  })

  it.each([
    ['a recording', { capture: true }, 'recording_active'],
    ['a drain', { open: false }, 'maintenance'],
  ])('refuses during %s, with nothing changed', async (_what, set, reason) => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const before = fingerprint()
    Object.assign(flags, set)
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'refused', reason, reverted: [] })
    expect(fingerprint()).toEqual(before)
  })

  it('refuses an unknown batch, an open correction of someone else, and a lost lease or lock', async () => {
    const before = fingerprint()
    const works = { fail: false, lock: false }
    const { batches } = await load({ acquireWork: () => { if (works.fail) throw new Error('drain'); return { release: () => {} } }, acquireLock: async () => { if (works.lock) throw new Error('sync'); return { release: () => {} } } })
    expect(await batches.undo(SESSION, '00000000-0000-4000-8000-000000000000', true)).toMatchObject({ state: 'refused', reason: 'batch_not_found' })
    expect(fingerprint()).toEqual(before)
    const out = await named(batches, [ITEM_1])
    works.fail = true
    expect((await batches.undo(SESSION, out.batchId, true)).left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'maintenance' }])
    works.fail = false
    works.lock = true
    expect((await batches.undo(SESSION, out.batchId, true)).left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'sync_running' }])
    expect(labelCount('Dana Reyes')).toBe(4)
    works.lock = false
    const { appendCorrection } = await import('./meeting-corrections.js')
    appendCorrection(SESSION, { id: 'someone-else', phase: 'intent', at: new Date().toISOString(), from: 'Voice 6', to: 'Ivo Lund', chunks: [], scope: 'meeting' })
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'refused', reason: 'correction_pending' })
  })

  it('previews what it would do and writes nothing', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1, ITEM_2])
    const doc = JSON.parse(readFileSync(sidecarPath, 'utf-8'))
    doc.chunks[0].speaker = 'Rae Quill'
    writeFileSync(sidecarPath, `${JSON.stringify(doc, null, 2)}\n`)
    const before = fingerprint()
    const journalBefore = journal(out.batchId)
    const preview = await batches.undo(SESSION, out.batchId, false)
    expect(preview).toMatchObject({ state: 'partial', dryRun: true, samplesRemoved: 8 })
    expect(preview.reverted).toEqual([{ labels: ['Voice 2'], name: 'Theo Marsh' }])
    expect(preview.left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'label_changed_by_person' }])
    expect(fingerprint()).toEqual(before)
    expect(journal(out.batchId)).toEqual(journalBefore)
  })
})

describe('evicted samples', () => {
  const history = range(42, 10).map(marker => ({ marker, source: `mac-assign:${OTHER_SESSION}` }))
  const seedDana = () => seedProfiles([ordinary('Dana Reyes', DANA, history)])

  it('go back from the journal when nothing would be displaced', async () => {
    seedDana()
    const before = samplesOf('Dana Reyes')
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    expect(profile('Dana Reyes').embeddings).toHaveLength(before.length)
    const evicted = journal(out.batchId).steps[0].evicted
    expect(evicted).toHaveLength(4)
    expect(evicted.every((s: { source: string }) => s.source.startsWith('mac-assign:'))).toBe(true)
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone).toMatchObject({ state: 'undone', samplesRemoved: 4, evictedRestored: 4, evictedNotRestored: 0 })
    expect([...samplesOf('Dana Reyes')].sort()).toEqual([...before].sort())
    // The sample copies have done their job.
    expect(journal(out.batchId).steps[0].evicted).toEqual([])
  })

  it('stay out and are counted when the profile has no room for them now', async () => {
    seedDana()
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    // Something else has taken the Mac allowance since: every slot is a newer Mac sample, and it must not be displaced.
    const p = profile('Dana Reyes')
    const newer = range(10, 4).map(marker => ({ s: 'mac-assign:mac_77777777-0000-4000-8000-000000000000', e: Array.from(voiceprint(marker, DANA)) }))
    const { __installSpeakerRuntimeForTests } = await import('./speaker-embeddings.js')
    const all = store().map(x => (x.name === 'Dana Reyes' ? { ...x, embeddings: [...p.embeddings, ...newer.map(n => n.e)], sources: [...p.sources, ...newer.map(n => n.s)] } : x))
    writeFileSync(data('voice-profiles.json'), JSON.stringify({ profiles: all }))
    __installSpeakerRuntimeForTests(fakeSpeakerRuntime()) // also drops the store's cache
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone).toMatchObject({ state: 'undone', samplesRemoved: 4, evictedRestored: 0, evictedNotRestored: 4 })
    expect(profile('Dana Reyes').sources.filter(s => s.startsWith('mac-assign:mac_7777'))).toHaveLength(4)
  })

  it('never bring back a deleted person', async () => {
    seedDana()
    const { batches, lib } = await load()
    const out = await named(batches, [ITEM_1])
    const { removeSpeakerProfile } = await import('./speaker-embeddings.js')
    removeSpeakerProfile('Dana Reyes')
    expect(lib.forgetMacVoiceNamingPerson('Dana Reyes')).toEqual({ batches: 1, vectors: 4 })
    expect(journal(out.batchId).steps[0].evicted).toEqual([])
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone).toMatchObject({ state: 'partial', samplesRemoved: 0, evictedRestored: 0, evictedNotRestored: 4 })
    expect(undone.left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'samples_not_found' }])
    expect(store().some(p => p.name === 'Dana Reyes')).toBe(false)
  })

  it('never bring back a deleted person whose vectors were not scrubbed', async () => {
    seedDana()
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const { removeSpeakerProfile } = await import('./speaker-embeddings.js')
    removeSpeakerProfile('Dana Reyes')
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone).toMatchObject({ evictedRestored: 0, evictedNotRestored: 4 })
    expect(undone.left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'samples_not_found' }])
    expect(store().some(p => p.name === 'Dana Reyes')).toBe(false)
  })

  it('stay out when a person has since moved that name in the meeting they came from', async () => {
    seedDana()
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const { appendCorrection } = await import('./meeting-corrections.js')
    appendCorrection(OTHER_SESSION, { id: 'elsewhere', phase: 'applied', at: new Date().toISOString(), from: 'Dana Reyes', to: 'Rae Quill', chunks: [3], scope: 'meeting' })
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'undone', evictedRestored: 0, evictedNotRestored: 4 })
  })
})

describe('guards that need a fault to reach', () => {
  it('does not embed at all once a recording has started between items', async () => {
    let plans = 0
    let releases = 0
    const { batches } = await load({
      plan: input => { plans++; return realPlan(input) },
      acquireLock: async () => ({ release: () => { if (++releases === 1) flags.capture = true } }),
    })
    const out = await named(batches, [ITEM_1, ITEM_2])
    expect(out).toMatchObject({ state: 'partial', reason: 'recording_active' })
    expect(plans).toBe(1)
  })

  it('stops if a correction opened while it waited for the lock', async () => {
    const { batches } = await load({
      acquireLock: async () => {
        (await import('./meeting-corrections.js')).appendCorrection(SESSION, { id: 'open', phase: 'intent', at: new Date().toISOString(), from: 'Voice 6', to: 'Ivo Lund', chunks: [], scope: 'meeting' })
        return { release: () => {} }
      },
    })
    expect(await named(batches, [ITEM_1])).toMatchObject({ state: 'refused', reason: 'correction_pending' })
    expect(labelCount('Voice 1')).toBe(4)
  })

  it('stops if a correction opened while its plan ran', async () => {
    let plans = 0
    const { batches } = await load({
      plan: async input => {
        const planned = await realPlan(input)
        if (++plans === 1) (await import('./meeting-corrections.js')).appendCorrection(SESSION, { id: 'open', phase: 'intent', at: new Date().toISOString(), from: 'Voice 6', to: 'Ivo Lund', chunks: [], scope: 'meeting' })
        return planned
      },
    })
    expect(await named(batches, [ITEM_1])).toMatchObject({ state: 'refused', reason: 'correction_pending' })
    expect(labelCount('Voice 1')).toBe(4)
  })

  it('checks the revision at the write, which covers state the bytes do not', async () => {
    let moved = false
    const { batches } = await load({
      reviewRevision: () => (moved ? 'other' : revision()),
      suggestions: () => ({ sourceRevision: revision(), suggestions: SUGGESTED }),
      plan: async input => { const planned = await realPlan(input); moved = true; return planned },
    })
    expect(await named(batches, [ITEM_1])).toMatchObject({ reason: 'suggestions_stale' })
    expect(labelCount('Voice 1')).toBe(4)
  })

  it('stops before writing if the ledger cannot take the intent', async () => {
    const { batches } = await load()
    const before = { sidecar: readFileSync(sidecarPath, 'utf-8'), md: markdown(), store: readFileSync(data('voice-profiles.json'), 'utf-8') }
    writeFileSync(data('meeting-corrections'), 'in the way')
    const out = await named(batches, [ITEM_1, ITEM_2])
    expect(out).toMatchObject({ state: 'refused', reason: 'ledger_unwritable', undoAvailable: false })
    expect(out.named).toEqual([])
    expect({ sidecar: readFileSync(sidecarPath, 'utf-8'), md: markdown(), store: readFileSync(data('voice-profiles.json'), 'utf-8') }).toEqual(before)
  })

  it('a failed sidecar write stops the batch, closes the ledger, adds no samples and Undo has nothing to do', async () => {
    const danaBefore = samplesOf('Dana Reyes')
    const { batches } = await load()
    faults.failWrite = 'call.g2-chunks.json'
    const out = await named(batches, [ITEM_1, ITEM_2])
    expect(out).toMatchObject({ state: 'partial', reason: 'write_failed', named: [] })
    expect(samplesOf('Dana Reyes')).toEqual(danaBefore)
    expect(ledger().map(r => r.phase)).toEqual(['intent', 'failed'])
    faults.failWrite = null
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'undone', reverted: [] })
  })

  it('a failed markdown write after the sidecar landed stays undoable', async () => {
    const original = readFileSync(sidecarPath, 'utf-8')
    const { batches } = await load()
    faults.failWrite = 'call.md'
    const out = await named(batches, [ITEM_1])
    expect(out).toMatchObject({ reason: 'write_failed', undoAvailable: true })
    expect(labelCount('Dana Reyes')).toBe(4)
    faults.failWrite = null
    expect((await batches.undo(SESSION, out.batchId, true)).state).toBe('undone')
    expect(readFileSync(sidecarPath, 'utf-8')).toBe(original)
  })

  it('does not mistake an eviction by someone else for this batch, when its commit never ran', async () => {
    seedProfiles([ordinary('Dana Reyes', DANA, range(42, 2).map(marker => ({ marker, source: `mac-assign:${OTHER_SESSION}` })))])
    const { batches } = await load({ commit: () => { throw new Error('process died') } })
    const out = await named(batches, [ITEM_1])
    const { retractEmbeddingsBySource } = await import('./speaker-embeddings.js')
    retractEmbeddingsBySource('Dana Reyes', source => source === `mac-assign:${OTHER_SESSION}`)
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'undone', evictedRestored: 0, evictedNotRestored: 0 })
    expect(profile('Dana Reyes').sources.filter(s => s.startsWith('mac-assign:'))).toEqual([])
  })

  it('never removes anything but the batch sample if the store walks its samples in another order, and says so', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    faults.reverseRetractWalk = true
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(profile('Dana Reyes').sources.filter(s => s === 'g2-training')).toHaveLength(12)
    expect(undone.left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'profile_store_unavailable' }])
    faults.reverseRetractWalk = false
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'undone', samplesRemoved: 4 })
    expect(profile('Dana Reyes').embeddings).toHaveLength(12)
  })

  it('a person action from before the batch does not stop its Undo', async () => {
    const { appendCorrection } = await import('./meeting-corrections.js')
    appendCorrection(SESSION, { id: 'earlier', phase: 'applied', at: '2020-01-01T00:00:00.000Z', from: 'Ext', to: 'Voice 1', chunks: [0], scope: 'meeting' })
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    expect((await batches.undo(SESSION, out.batchId, true)).state).toBe('undone')
  })

  it('leaves the voice if the ledger cannot take the undo intent or a write fails, and a retry finishes', async () => {
    const original = readFileSync(sidecarPath, 'utf-8')
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    faults.failWrite = 'call.g2-chunks.json'
    expect((await batches.undo(SESSION, out.batchId, true)).left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'write_failed' }])
    expect(labelCount('Dana Reyes')).toBe(4)
    expect(ledger().at(-1)).toMatchObject({ phase: 'failed', error: expect.stringContaining('disk refused') })
    faults.failWrite = null
    const ledgerFile = data('meeting-corrections', `${SESSION}.jsonl`)
    const rows = readFileSync(ledgerFile, 'utf-8')
    rmSync(ledgerFile)
    mkdirSync(ledgerFile)
    expect((await batches.undo(SESSION, out.batchId, true)).left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'ledger_unwritable' }])
    expect(labelCount('Dana Reyes')).toBe(4)
    rmSync(ledgerFile, { recursive: true })
    writeFileSync(ledgerFile, rows)
    expect((await batches.undo(SESSION, out.batchId, true)).state).toBe('undone')
    expect(readFileSync(sidecarPath, 'utf-8')).toBe(original)
  })

  it('restores an attendee bullet byte for byte, after a later edit too, and will not guess once a person changed the section', async () => {
    seedMeeting()
    writeFileSync(meetingPath, markdown().replace('- Neva Sharpe', '- Neva Sharpe\n- Voice 1'))
    const original = markdown()
    const { batches } = await load()
    const first = await named(batches, [ITEM_1])
    expect(markdown()).toContain('- Dana Reyes')
    expect((await batches.undo(SESSION, first.batchId, true)).state).toBe('undone')
    expect(markdown()).toBe(original)
    expect(journal(first.batchId).steps[0].attendeesBefore).toBeNull()

    const second = await named((await load()).batches, [ITEM_1])
    writeFileSync(meetingPath, markdown().replace(/^\[Voice 5\]:/gm, '[Ivo Lund]:'))
    const moved = await load()
    expect((await moved.batches.undo(SESSION, second.batchId, true)).state).toBe('undone')
    expect(markdown()).toBe(original.replace(/^\[Voice 5\]:/gm, '[Ivo Lund]:'))

    writeFileSync(meetingPath, original)
    const third = await named((await load()).batches, [ITEM_1])
    writeFileSync(meetingPath, markdown().replace('- Neva Sharpe', '- Neva Sharpe\n- Rae Quill'))
    expect((await (await load()).batches.undo(SESSION, third.batchId, true)).left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'transcript_changed' }])
  })

  it('accepts a turn a person already put back, and only that', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    writeFileSync(meetingPath, markdown().replace('[Dana Reyes]: Yeah.', '[Voice 1]: Yeah.'))
    expect((await batches.undo(SESSION, out.batchId, true)).state).toBe('undone')
    expect(markdown().match(/^\[Voice 1\]:/gm)).toHaveLength(4)
  })

  it('does not restore a sample twice when a retry runs over one it already put back', async () => {
    seedProfiles([ordinary('Dana Reyes', DANA, range(42, 10).map(marker => ({ marker, source: `mac-assign:${OTHER_SESSION}` })))])
    const before = samplesOf('Dana Reyes')
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const edited = markdown().replace('[Dana Reyes]: Yeah.', '[Rae Quill]: Yeah.')
    writeFileSync(meetingPath, edited)
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'partial', evictedRestored: 4 })
    writeFileSync(meetingPath, edited.replace('[Rae Quill]: Yeah.', '[Dana Reyes]: Yeah.'))
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'undone', evictedRestored: 4, evictedNotRestored: 0 })
    expect([...samplesOf('Dana Reyes')].sort()).toEqual([...before].sort())
  })

  it('keeps no copy of samples that were never evicted once the commit reported', async () => {
    seedProfiles([ordinary('Dana Reyes', DANA, range(42, 2).map(marker => ({ marker, source: `mac-assign:${OTHER_SESSION}` })))])
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const step = journal(out.batchId).steps[0]
    expect(step.macBefore).toBeUndefined()
    expect(step.evicted).toEqual([])
    expect(step.added).toHaveLength(4)
    expect(JSON.stringify(step.added)).not.toContain('embedding')
  })

  it('a batch in flight reads as running, offers no Undo, and refuses one', async () => {
    let plans = 0
    let during: unknown
    let refused: unknown
    const made = await load({
      plan: async input => {
        if (++plans === 2) {
          during = made.batches.list(SESSION).batches[0]
          refused = await made.batches.undo(SESSION, (during as { batchId: string }).batchId, true)
        }
        return realPlan(input)
      },
    })
    await named(made.batches, [ITEM_1, ITEM_2])
    expect(during).toMatchObject({ state: 'running', undoAvailable: false })
    expect(refused).toMatchObject({ state: 'refused', reason: 'batch_running' })
  })
})

describe('which copy of the meeting', () => {
  it('writes the operations copy first, as relabel does, and never the local one', async () => {
    const opsSidecar = join(home, 'ops.g2-chunks.json')
    const opsMarkdown = join(home, 'ops.md')
    writeFileSync(opsSidecar, readFileSync(sidecarPath))
    writeFileSync(opsMarkdown, markdown())
    const localSidecar = readFileSync(sidecarPath, 'utf-8')
    library.operations = { sidecarPath: opsSidecar, meetingPath: opsMarkdown }
    const { batches } = await load({
      reviewRevision: (m, s) => createHash('sha256').update(readFileSync(m)).update(readFileSync(s)).digest('hex'),
      suggestions: () => ({ sourceRevision: createHash('sha256').update(readFileSync(opsMarkdown)).update(readFileSync(opsSidecar)).digest('hex'), suggestions: SUGGESTED }),
    })
    const sourceRevision = createHash('sha256').update(readFileSync(opsMarkdown)).update(readFileSync(opsSidecar)).digest('hex')
    expect((await batches.run(SESSION, { sourceRevision, items: [ITEM_1], confirm: true })).state).toBe('applied')
    expect(readFileSync(opsSidecar, 'utf-8')).toContain('Dana Reyes')
    expect(readFileSync(sidecarPath, 'utf-8')).toBe(localSidecar)
  })

  it.each([
    ['a read-only library copy', () => { library.direct = { recordId: 'direct:x' } }, 'direct_library_read_only'],
    ['two meetings claiming one session', () => { library.operations = { sidecarPath, meetingPath, mergedScribeConflict: ['a.md', 'b.md'] } }, 'record_source_mismatch'],
  ])('refuses %s', async (_what, arrange, reason) => {
    arrange()
    const { batches } = await load()
    const before = fingerprint()
    expect(await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1], confirm: true })).toMatchObject({ state: 'refused', reason })
    expect(fingerprint()).toEqual(before)
  })
})

describe('findings from the mutation run', () => {
  it('a preview holds the same whole-batch checks, since it has no write to be stopped at', async () => {
    const stale = await load({ suggestions: () => ({ sourceRevision: 'older', suggestions: SUGGESTED }) })
    expect(await stale.batches.run(SESSION, { sourceRevision: 'older', items: [ITEM_1] })).toMatchObject({ state: 'refused', reason: 'suggestions_stale', dryRun: true })
    const { appendCorrection } = await import('./meeting-corrections.js')
    appendCorrection(SESSION, { id: 'stuck', phase: 'intent', at: new Date().toISOString(), from: 'Voice 6', to: 'Ivo Lund', chunks: [], scope: 'meeting' })
    const pending = await load()
    expect(await pending.batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1] })).toMatchObject({ state: 'refused', reason: 'correction_pending', dryRun: true })
  })

  it('refuses an owner whose speaker label is not MU', async () => {
    identity.label = 'Wren Hale'
    const { batches } = await load({ suggestions: () => ({ sourceRevision: revision(), suggestions: [{ ...SUGGESTED[0], name: 'Wren Hale' }] }) })
    expect((await batches.run(SESSION, { sourceRevision: revision(), items: [{ labels: ['Voice 1'], name: 'Wren Hale' }], confirm: true })).reason).toBe('owner_refused')
  })

  it('one label no chunk carries refuses the whole batch, not just its own turn', async () => {
    const { batches } = await load({ suggestions: () => ({ sourceRevision: revision(), suggestions: [SUGGESTED[0], { ...SUGGESTED[1], labels: ['Voice 9'] }] }) })
    const before = fingerprint()
    expect(await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_1, { labels: ['Voice 9'], name: 'Theo Marsh' }], confirm: true })).toMatchObject({ state: 'refused', reason: 'label_not_anonymous', named: [] })
    expect(fingerprint()).toEqual(before)
  })

  it('a full profile takes no sample back, even with Mac allowance to spare', async () => {
    seedProfiles([ordinary('Dana Reyes', DANA, range(42, 10).map(marker => ({ marker, source: `mac-assign:${OTHER_SESSION}` })))])
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const others = range(100, 38).map(marker => Array.from(voiceprint(marker, DANA)))
    const mac = [Array.from(voiceprint(142, DANA)), Array.from(voiceprint(143, DANA))]
    const full = { name: 'Dana Reyes', embeddings: [...others, ...mac], sources: [...others.map(() => 'g2-training'), 'mac-assign:mac_77777777-0000-4000-8000-000000000000', 'mac-assign:mac_77777777-0000-4000-8000-000000000000'] }
    writeFileSync(data('voice-profiles.json'), JSON.stringify({ profiles: store().map(p => (p.name === 'Dana Reyes' ? full : p)) }))
    ;(await import('./speaker-embeddings.js')).__installSpeakerRuntimeForTests(fakeSpeakerRuntime())
    const held = samplesOf('Dana Reyes')
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ evictedRestored: 0, evictedNotRestored: 4 })
    expect(samplesOf('Dana Reyes')).toEqual(held)
  })

  it('after a crash, leaves a sample someone added later from the same call', async () => {
    const { batches } = await load({ commit: () => { throw new Error('process died') } })
    const out = await named(batches, [ITEM_1])
    const later = voiceprint(55, DANA)
    const { enrollEmbedding } = await import('./speaker-embeddings.js')
    expect(enrollEmbedding('Dana Reyes', later, SOURCE, true).success).toBe(true)
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'undone', samplesRemoved: 0 })
    expect(profile('Dana Reyes').sources.filter(s => s === SOURCE)).toHaveLength(1)
  })

  it('a person vouching for a different name does not hold this one', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const { appendCorrection } = await import('./meeting-corrections.js')
    appendCorrection(SESSION, { id: 'vouch', phase: 'confirmed', at: new Date().toISOString(), from: 'Neva Sharpe', to: 'Neva Sharpe', chunks: [], scope: 'meeting' })
    expect((await batches.undo(SESSION, out.batchId, true)).state).toBe('undone')
    expect(labelCount('Voice 1')).toBe(4)
  })

  it('closes the ledger row of a process that died between its intent and its outcome', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const file = data('meeting-corrections', `${SESSION}.jsonl`)
    writeFileSync(file, `${readFileSync(file, 'utf-8').split('\n').filter(Boolean).filter(line => JSON.parse(line).phase === 'intent').join('\n')}\n`)
    const { pendingCorrections } = await import('./meeting-corrections.js')
    expect(pendingCorrections(SESSION)).toHaveLength(1)
    expect((await batches.undo(SESSION, out.batchId, true)).state).toBe('undone')
    expect(pendingCorrections(SESSION)).toEqual([])
    // Nothing was ever applied as far as the ledger knows, so there is nothing to mark reverted: the reader refuses that.
    expect(ledger().filter(row => row.phase === 'reverted')).toEqual([])
  })

  it('a second Undo does not recount a voice a person kept', async () => {
    seedProfiles([ordinary('Dana Reyes', DANA, range(42, 10).map(marker => ({ marker, source: `mac-assign:${OTHER_SESSION}` })))])
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const { appendCorrection } = await import('./meeting-corrections.js')
    const at = new Date().toISOString()
    appendCorrection(OTHER_SESSION, { id: 'elsewhere', phase: 'applied', at, from: 'Dana Reyes', to: 'Rae Quill', chunks: [3], scope: 'meeting' })
    appendCorrection(SESSION, { id: 'person', phase: 'applied', at, from: 'Dana Reyes', to: 'Rae Quill', chunks: [0], scope: 'meeting' })
    const first = await batches.undo(SESSION, out.batchId, true)
    expect(first).toMatchObject({ state: 'partial', samplesRemoved: 4, evictedNotRestored: 4 })
    expect(await batches.undo(SESSION, out.batchId, true)).toEqual(first)
  })

  it('refuses a session that is not a Mac capture even when a saved copy exists', async () => {
    const { batches } = await load({ store: { findBySessionId: () => ({ sidecarPath, filepath: meetingPath }) } })
    const before = fingerprint()
    expect((await batches.run('meeting_1786628481833_eagkaz', { sourceRevision: revision(), items: [ITEM_1], confirm: true })).reason).toBe('not_saved_mac_capture')
    expect(fingerprint()).toEqual(before)
  })
})

describe('review: two batches on one person', () => {
  const OLDER = 'mac_55555555-0000-4000-8000-000000000000'
  const setup = async () => {
    seedProfiles([ordinary('Dana Reyes', DANA, range(42, 10).map(marker => ({ marker, source: `mac-assign:${OLDER}` })))])
    seedMeeting({ voices: [{ label: 'Voice 1', axis: DANA, chunks: 10 }] })
    seedMeeting({ voices: [{ label: 'Voice 1', axis: DANA, chunks: 10 }], session: OTHER_SESSION, markerBase: 10 })
    const original = [...samplesOf('Dana Reyes')].sort()
    const { batches } = await load()
    const a = await named(batches, [ITEM_1])
    const b = await batches.run(OTHER_SESSION, { sourceRevision: revisionFor(OTHER_SESSION), items: [ITEM_1], confirm: true })
    expect(a.named[0].samplesAdded).toBe(10)
    expect(b.named[0].samplesAdded).toBe(10)
    expect(profile('Dana Reyes').sources.filter(source => source === `mac-assign:${OTHER_SESSION}`)).toHaveLength(10)
    expect(profile('Dana Reyes').sources.filter(source => source === SOURCE)).toHaveLength(0)
    return { batches, a, b, original }
  }

  it('Undo the first, then the second: her older samples come back and the undone batch stays out', async () => {
    const { batches, a, b, original } = await setup()
    const first = await batches.undo(SESSION, a.batchId, true)
    expect(first.state).toBe('partial')
    expect(first.left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'samples_not_found' }])
    expect(first).toMatchObject({ samplesRemoved: 0, evictedRestored: 0, evictedNotRestored: 10 })
    expect(labelCount('Voice 1')).toBe(10)
    const second = await batches.undo(OTHER_SESSION, b.batchId, true)
    expect(second).toMatchObject({ state: 'undone', samplesRemoved: 10, evictedRestored: 0, evictedNotRestored: 10 })
    expect(profile('Dana Reyes').sources.filter(source => source === SOURCE)).toEqual([])
    expect([...samplesOf('Dana Reyes')].sort()).toEqual(original)
    expect(journal(a.batchId).steps[0].evicted).toEqual([])
  })

  it('Undo the second, then the first: the same samples at the end', async () => {
    const { batches, a, b, original } = await setup()
    expect(await batches.undo(OTHER_SESSION, b.batchId, true)).toMatchObject({ state: 'undone', samplesRemoved: 10, evictedRestored: 10, evictedNotRestored: 0 })
    expect(profile('Dana Reyes').sources.filter(source => source === SOURCE)).toHaveLength(10)
    expect(await batches.undo(SESSION, a.batchId, true)).toMatchObject({ state: 'undone', samplesRemoved: 10, evictedRestored: 10, evictedNotRestored: 0 })
    expect([...samplesOf('Dana Reyes')].sort()).toEqual(original)
  })

  it('its own revert does not block a sample of an earlier naming on the same call', async () => {
    seedProfiles([ordinary('Dana Reyes', DANA, range(42, 10).map(marker => ({ marker, source: SOURCE })))])
    const original = [...samplesOf('Dana Reyes')].sort()
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    expect(journal(out.batchId).steps[0].evicted).toHaveLength(4)
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'undone', evictedRestored: 4, evictedNotRestored: 0 })
    expect([...samplesOf('Dana Reyes')].sort()).toEqual(original)
  })
})

describe('review: the ledger after an Undo', () => {
  /** The repair suite's synthetic meeting, under a real capture id, so its reader judges a ledger this code really wrote. */
  function syntheticSource(): MacShadowRepairSource {
    const chunkEntries: any[] = []
    for (const span of SYNTHETIC_SPANS) for (let start = span.start; start < span.end; start += 6) {
      const seconds = Math.min(6, span.end - start), raw = chunkEntries.length
      const chunk = { text: `words for raw ${raw}`, speaker: span.label, elapsed: start * 1000, audioDurationMs: seconds * 1000, audioSha256: raw.toString(16).padStart(64, '0'), similarity: 0, segments: [{ speaker: span.label, startSec: 0, endSec: seconds }], finalSegments: [{ speaker: span.label, startSec: 0, endSec: seconds }], words: [{ word: `raw${raw}`, start: 0, end: seconds }] }
      chunkEntries.push({ chunkIndex: raw, chunk })
    }
    let offset = 0
    const speakerWords = chunkEntries.map(({ chunk }) => { const start = offset; offset += chunk.audioDurationMs / 1000; return { word: chunk.text, speaker: chunk.speaker, start, end: offset } })
    const doc = { sessionId: SESSION, sourceType: 'mac_system_audio', finalizationState: 'complete', chunks: chunkEntries.map(e => structuredClone(e.chunk)), chunkEntries, speakers: ['Dana Fictional'], batchSegments: [{ startChunkIdx: 0, endChunkIdx: chunkEntries.length - 1, speakerWords }] }
    const H = 'a'.repeat(64)
    const rawAudio = chunkEntries.map(e => ({ rawChunkIndex: e.chunkIndex, wavSHA256: e.chunk.audioSha256, pcmSHA256: H, sampleCount: e.chunk.audioDurationMs * 16 }))
    const timelineRows = rawAudio.map((a, i) => ({ rawChunkIndex: i, startSample: chunkEntries[i].chunk.elapsed * 16, sampleCount: a.sampleCount, usedSampleCount: a.sampleCount }))
    return { originalJSON: JSON.stringify(doc), currentJSON: JSON.stringify(doc), ledgerJSONL: '', rawAudio, timeline: { rows: timelineRows, total: SYNTHETIC_SECONDS * 16000, pcmSHA256: H }, cohort: { nativeJSON: JSON.stringify(syntheticNative()), embeddingsJSON: JSON.stringify(syntheticEmbeddings()), modelSHA256: H, cliSHA256: 'b'.repeat(64) } }
  }
  const readLedger = (source: MacShadowRepairSource, ledgerJSONL: string) => {
    const input = { ...source, currentJSON: JSON.stringify(JSON.parse(readFileSync(sidecarPath, 'utf-8'))), ledgerJSONL }
    return inspectMacSpeakerShadowCallSource({ ...input, sourceBindingSHA256: bindMacSpeakerShadowRepair(input) })
  }

  it('is one the shadow repair reader accepts, and that reader does refuse the shape this used to write', async () => {
    const source = syntheticSource()
    const doc = JSON.parse(source.originalJSON)
    writeFileSync(sidecarPath, `${JSON.stringify(doc, null, 2)}\n`)
    writeFileSync(meetingPath, '# Invented\n\n## Transcript\n\n[Voice 2]: invented words\n')
    doc.chunkEntries.forEach((entry: { chunkIndex: number; chunk: { speaker: string } }) => {
      if (entry.chunk.speaker === 'Voice 2') writeFileSync(data('meeting-audio', SESSION, `chunk_${String(entry.chunkIndex).padStart(4, '0')}.wav`), wav(DANA, (entry.chunkIndex % 25) + 1))
    })
    const { batches } = await load({ suggestions: () => ({ sourceRevision: revision(), suggestions: [{ ...SUGGESTED[0], labels: ['Voice 2'] }] }) })
    const out = await named(batches, [{ labels: ['Voice 2'], name: 'Dana Reyes' }])
    expect(out.state).toBe('applied')
    expect((await batches.undo(SESSION, out.batchId, true)).state).toBe('undone')
    const ledgerText = readFileSync(data('meeting-corrections', `${SESSION}.jsonl`), 'utf-8')
    expect(() => readLedger(source, ledgerText)).not.toThrow()
    // Positive control: the old shape, an undo intent reverted under its own new id.
    const { id, chunks } = JSON.parse(ledgerText.split('\n')[0])
    const oldShape = [{ id: `${id}:old`, phase: 'intent', from: 'Voice 2', to: 'Dana Reyes', chunks }, { id: `${id}:old`, phase: 'reverted', from: 'Voice 2', to: 'Dana Reyes', chunks }].map(row => JSON.stringify(row)).join('\n')
    expect(() => readLedger(source, `${ledgerText}${oldShape}\n`)).toThrow(/correction/)
  })

  it('writes reverted on the applied row and closes the undo intent failed', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    await batches.undo(SESSION, out.batchId, true)
    const rows = ledger()
    const correction = rows[0].id as string
    expect(rows.filter(row => row.id === correction).map(row => row.phase)).toEqual(['intent', 'applied', 'reverted'])
    const undoRows = rows.filter(row => row.id !== correction)
    expect(undoRows.map(row => row.phase)).toEqual(['intent', 'failed'])
    expect(new Set(undoRows.map(row => row.id)).size).toBe(1)
  })

  it('a kill after the files revert and before the row: the retry still takes the naming out of the ledger', async () => {
    const original = readFileSync(sidecarPath, 'utf-8')
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    faults.dieOnAppend = 'reverted'
    await expect(batches.undo(SESSION, out.batchId, true)).rejects.toThrow('process died')
    faults.dieOnAppend = null
    const { appliedCorrections, pendingCorrections } = await import('./meeting-corrections.js')
    expect(readFileSync(sidecarPath, 'utf-8')).toBe(original)
    expect(appliedCorrections(SESSION)).toHaveLength(1)
    expect(pendingCorrections(SESSION)).toHaveLength(1)
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'undone', samplesRemoved: 4 })
    expect(appliedCorrections(SESSION)).toEqual([])
    expect(pendingCorrections(SESSION)).toEqual([])
  })

  it.each([['reverted'], ['failed']])('a %s row the ledger refuses is a failure, and a retry finishes', async phase => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    faults.refuseAppend = phase
    const refused = await batches.undo(SESSION, out.batchId, true)
    expect(refused.state).toBe('partial')
    expect(refused.left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'ledger_unwritable' }])
    faults.refuseAppend = null
    expect((await batches.undo(SESSION, out.batchId, true)).state).toBe('undone')
    const { appliedCorrections, pendingCorrections } = await import('./meeting-corrections.js')
    expect(appliedCorrections(SESSION)).toEqual([])
    expect(pendingCorrections(SESSION)).toEqual([])
  })
})

describe('review: samples a later change moved or removed', () => {
  it('finds them in the profile a merge moved them to', async () => {
    seedProfiles([ordinary('Rae Quill', DANA)])
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const { mergeSpeakerProfiles } = await import('./speaker-embeddings.js')
    mergeSpeakerProfiles('Rae Quill', ['Dana Reyes'], { force: true })
    expect(profile('Rae Quill').sources.filter(source => source === SOURCE)).toHaveLength(4)
    const preview = await batches.undo(SESSION, out.batchId, false)
    expect(preview).toMatchObject({ state: 'undone', samplesRemoved: 4 })
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'undone', samplesRemoved: 4 })
    expect(profile('Rae Quill').sources.filter(source => source === SOURCE)).toEqual([])
    expect(profile('Rae Quill').embeddings).toHaveLength(24)
  })

  it('says so when no profile holds them: partial, label back, nothing offered again', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const { retractEmbeddingsBySource } = await import('./speaker-embeddings.js')
    retractEmbeddingsBySource('Dana Reyes', source => source === SOURCE)
    expect((await batches.undo(SESSION, out.batchId, false)).left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'samples_not_found' }])
    const undone = await batches.undo(SESSION, out.batchId, true)
    expect(undone).toMatchObject({ state: 'partial', samplesRemoved: 0 })
    expect(undone.reverted).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes' }])
    expect(undone.left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'samples_not_found' }])
    expect(labelCount('Voice 1')).toBe(4)
    expect(batches.list(SESSION).batches[0]).toMatchObject({ state: 'undo_partial', undoAvailable: false })
    expect(await batches.undo(SESSION, out.batchId, true)).toEqual(undone)
  })
})

describe('review: checks after a wait', () => {
  it('a recording that starts during the lock wait stops the write', async () => {
    const before = fingerprint()
    const { batches } = await load({ acquireLock: async () => { flags.capture = true; return { release: () => {} } } })
    expect(await named(batches, [ITEM_1])).toMatchObject({ state: 'refused', reason: 'recording_active' })
    expect(fingerprint()).toEqual(before)
  })

  it('and stops an Undo the same way', async () => {
    const original = { store: readFileSync(data('voice-profiles.json'), 'utf-8') }
    let locks = 0
    const { batches } = await load({ acquireLock: async () => { if (++locks === 2) flags.capture = true; return { release: () => {} } } })
    const out = await named(batches, [ITEM_1])
    const named1 = readFileSync(data('voice-profiles.json'), 'utf-8')
    expect(named1).not.toBe(original.store)
    expect((await batches.undo(SESSION, out.batchId, true)).left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'recording_active' }])
    expect(readFileSync(data('voice-profiles.json'), 'utf-8')).toBe(named1)
    expect(labelCount('Dana Reyes')).toBe(4)
  })

  it('from the second label on, a ledger-only confirmation during a plan stops the batch', async () => {
    let plans = 0
    const withLedger = (md: string, sidecar: string) => createHash('sha256').update(revisionOf(md, sidecar)).update(JSON.stringify(ledger().filter(row => row.phase === 'confirmed'))).digest('hex')
    const { batches } = await load({
      reviewRevision: withLedger,
      suggestions: () => ({ sourceRevision: withLedger(meetingPath, sidecarPath), suggestions: SUGGESTED }),
      plan: async input => {
        const planned = await realPlan(input)
        if (++plans === 2) (await import('./meeting-corrections.js')).appendCorrection(SESSION, { id: 'vouch', phase: 'confirmed', at: new Date().toISOString(), from: 'Neva Sharpe', to: 'Neva Sharpe', chunks: [], scope: 'meeting' })
        return planned
      },
    })
    const out = await batches.run(SESSION, { sourceRevision: withLedger(meetingPath, sidecarPath), items: [ITEM_1, ITEM_2], confirm: true })
    expect(out).toMatchObject({ state: 'partial', reason: 'suggestions_stale' })
    expect(labelCount('Voice 2')).toBe(4)
  })
})

describe('review: restoring', () => {
  it('a name moved in that meeting before this batch does not hold back its sample', async () => {
    const { appendCorrection } = await import('./meeting-corrections.js')
    appendCorrection(OTHER_SESSION, { id: 'earlier-move', phase: 'applied', at: '2020-01-01T00:00:00.000Z', from: 'Dana Reyes', to: 'Rae Quill', chunks: [1], scope: 'meeting' })
    appendCorrection(OTHER_SESSION, { id: 'earlier-back', phase: 'reverted', at: '2020-01-02T00:00:00.000Z', from: 'Dana Reyes', to: 'Voice 8', chunks: [2], scope: 'meeting' })
    seedProfiles([ordinary('Dana Reyes', DANA, range(42, 10).map(marker => ({ marker, source: `mac-assign:${OTHER_SESSION}` })))])
    const before = [...samplesOf('Dana Reyes')].sort()
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'undone', evictedRestored: 4, evictedNotRestored: 0 })
    expect([...samplesOf('Dana Reyes')].sort()).toEqual(before)
  })

  it('a name moved in that meeting and then taken back by the person is still a move', async () => {
    const { batches } = await load()
    seedProfiles([ordinary('Dana Reyes', DANA, range(42, 10).map(marker => ({ marker, source: `mac-assign:${OTHER_SESSION}` })))])
    ;(await import('./speaker-embeddings.js')).__installSpeakerRuntimeForTests(fakeSpeakerRuntime())
    const out = await named(batches, [ITEM_1])
    const { appendCorrection } = await import('./meeting-corrections.js')
    const at = new Date().toISOString()
    appendCorrection(OTHER_SESSION, { id: 'later', phase: 'reverted', at, from: 'Dana Reyes', to: 'Voice 8', chunks: [2], scope: 'meeting' })
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ evictedRestored: 0, evictedNotRestored: 4 })
  })
})

describe('review: second mutation pass', () => {
  const history = range(42, 10).map(marker => ({ marker, source: `mac-assign:${OTHER_SESSION}` }))

  it('takes the copy in the named profile when another profile also holds that exact sample', async () => {
    seedProfiles([ordinary('Rae Quill', DANA)])
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const dana = profile('Dana Reyes')
    const rae = profile('Rae Quill')
    const twin = { ...rae, embeddings: [...rae.embeddings, dana.embeddings.at(-1)!], sources: [...rae.sources, SOURCE] }
    writeFileSync(data('voice-profiles.json'), JSON.stringify({ profiles: store().map(p => (p.name === 'Rae Quill' ? twin : p)) }))
    ;(await import('./speaker-embeddings.js')).__installSpeakerRuntimeForTests(fakeSpeakerRuntime())
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'undone', samplesRemoved: 4 })
    expect(profile('Rae Quill').sources.filter(source => source === SOURCE)).toHaveLength(1)
    expect(profile('Dana Reyes').sources.filter(source => source === SOURCE)).toEqual([])
  })

  it('a crash after the restore and before the journal: the retry does not count them as missing or lost', async () => {
    seedProfiles([ordinary('Dana Reyes', DANA, history)])
    const before = [...samplesOf('Dana Reyes')].sort()
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    faults.failWrite = `${out.batchId}.json`
    faults.skipWrites = 1
    await expect(batches.undo(SESSION, out.batchId, true)).rejects.toThrow('disk refused')
    faults.failWrite = null
    expect([...samplesOf('Dana Reyes')].sort()).toEqual(before)
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'undone', left: [], evictedNotRestored: 0 })
    expect([...samplesOf('Dana Reyes')].sort()).toEqual(before)
  })

  it('a later move of another name in that meeting does not hold back this sample', async () => {
    seedProfiles([ordinary('Dana Reyes', DANA, history)])
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const { appendCorrection } = await import('./meeting-corrections.js')
    appendCorrection(OTHER_SESSION, { id: 'elsewhere', phase: 'applied', at: new Date().toISOString(), from: 'Theo Marsh', to: 'Rae Quill', chunks: [3], scope: 'meeting' })
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ evictedRestored: 4, evictedNotRestored: 0 })
  })

  it('does not retry kept samples into the store while a recording runs', async () => {
    seedProfiles([ordinary('Dana Reyes', DANA, range(42, 10).map(marker => ({ marker, source: 'mac-assign:mac_55555555-0000-4000-8000-000000000000' })))])
    seedMeeting({ voices: [{ label: 'Voice 1', axis: DANA, chunks: 10 }] })
    seedMeeting({ voices: [{ label: 'Voice 1', axis: DANA, chunks: 10 }], session: OTHER_SESSION, markerBase: 10 })
    const lock = { flip: false }
    const { batches } = await load({ acquireLock: async () => ({ release: () => { if (lock.flip) flags.capture = true } }) })
    const a = await named(batches, [ITEM_1])
    const b = await batches.run(OTHER_SESSION, { sourceRevision: revisionFor(OTHER_SESSION), items: [ITEM_1], confirm: true })
    await batches.undo(SESSION, a.batchId, true)
    lock.flip = true
    await batches.undo(OTHER_SESSION, b.batchId, true)
    expect(profile('Dana Reyes').sources.filter(source => source.startsWith('mac-assign:'))).toEqual([])
    expect(journal(a.batchId).steps[0].evicted).toHaveLength(10)
  })

  it('a step that died in its commit, then an Undo with enrolment down: the retry still has what it evicted', async () => {
    seedProfiles([ordinary('Dana Reyes', DANA, history)])
    const before = [...samplesOf('Dana Reyes')].sort()
    const { batches } = await load({ commit: (session, plan) => { commitNow?.(session, plan); throw new Error('process died') } })
    commitNow = (await import('./mac-voice-assignment.js')).commitMacVoiceAssignment
    const out = await named(batches, [ITEM_1])
    expect(journal(out.batchId).steps[0].state).toBe('intent')
    const embeddings = await import('./speaker-embeddings.js')
    embeddings.__installSpeakerRuntimeForTests(null)
    expect((await batches.undo(SESSION, out.batchId, true)).left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'profile_store_unavailable' }])
    embeddings.__installSpeakerRuntimeForTests(fakeSpeakerRuntime())
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'undone', evictedRestored: 4, evictedNotRestored: 0 })
    expect([...samplesOf('Dana Reyes')].sort()).toEqual(before)
  })
})

describe('review: what the journal keeps, and for how long', () => {
  const history = range(42, 10).map(marker => ({ marker, source: `mac-assign:${OTHER_SESSION}` }))

  it('holds no words of the transcript', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1, MERGED])
    const text = readFileSync(data('mac-voice-naming-batches', SESSION, `${out.batchId}.json`), 'utf-8')
    expect(text).not.toContain('invented remark')
    expect(text).not.toContain('Yeah')
    expect(text).not.toContain('Invented summary')
  })

  it('a delete during a batch is not written back by the batch in memory', async () => {
    seedProfiles([ordinary('Dana Reyes', DANA, history)])
    let plans = 0
    const made = await load({
      plan: async input => {
        if (++plans === 2) {
          expect(made.lib.forgetMacVoiceNamingPerson('Dana Reyes').vectors).toBe(4)
        }
        return realPlan(input)
      },
    })
    const out = await named(made.batches, [ITEM_1, ITEM_2])
    const step = journal(out.batchId).steps[0]
    expect(step.name).toBe('Dana Reyes')
    expect(step.evicted).toEqual([])
    expect(step.evictedForgotten).toBe(4)
  })

  it('a person of the same name named later keeps their own evicted samples', async () => {
    seedProfiles([ordinary('Dana Reyes', DANA, history)])
    const { batches, lib } = await load()
    lib.forgetMacVoiceNamingPerson('Dana Reyes')
    await new Promise(resolve => setTimeout(resolve, 5))
    const out = await named(batches, [ITEM_1])
    expect(journal(out.batchId).steps[0].evicted).toHaveLength(4)
  })

  it('a delete also drops an attendee copy that names them, and Undo then says it cannot restore that', async () => {
    writeFileSync(meetingPath, markdown().replace('- Neva Sharpe', '- Neva Sharpe\n- Voice 1'))
    const { batches, lib } = await load()
    const out = await named(batches, [ITEM_1])
    expect(journal(out.batchId).steps[0].attendeesBefore).toContain('Neva Sharpe')
    lib.forgetMacVoiceNamingPerson('Neva Sharpe')
    expect(journal(out.batchId).steps[0].attendeesBefore).toBeNull()
    expect((await batches.undo(SESSION, out.batchId, true)).left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'transcript_changed' }])
  })

  it('a crash between the sidecar and markdown writes with an attendee bullet present does not refuse forever', async () => {
    writeFileSync(meetingPath, markdown().replace('- Neva Sharpe', '- Neva Sharpe\n- Voice 1'))
    const original = { md: markdown(), sidecar: readFileSync(sidecarPath, 'utf-8') }
    const { batches } = await load()
    faults.failWrite = 'call.md'
    const out = await named(batches, [ITEM_1])
    faults.failWrite = null
    expect(markdown()).toBe(original.md)
    expect((await batches.undo(SESSION, out.batchId, true)).state).toBe('undone')
    expect({ md: markdown(), sidecar: readFileSync(sidecarPath, 'utf-8') }).toEqual(original)
  })

  it('keeps evicted originals when enrolment is down, and a retry puts them back', async () => {
    seedProfiles([ordinary('Dana Reyes', DANA, history)])
    const before = [...samplesOf('Dana Reyes')].sort()
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    const embeddings = await import('./speaker-embeddings.js')
    const runtime = fakeSpeakerRuntime()
    embeddings.__installSpeakerRuntimeForTests(null)
    const first = await batches.undo(SESSION, out.batchId, true)
    expect(first.left).toEqual([{ labels: ['Voice 1'], name: 'Dana Reyes', reason: 'profile_store_unavailable' }])
    expect(journal(out.batchId).steps[0].evicted).toHaveLength(4)
    expect(batches.list(SESSION).batches[0].undoAvailable).toBe(true)
    embeddings.__installSpeakerRuntimeForTests(runtime)
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'undone', samplesRemoved: 4, evictedRestored: 4, evictedNotRestored: 0 })
    expect([...samplesOf('Dana Reyes')].sort()).toEqual(before)
    expect(journal(out.batchId).steps[0].evicted).toEqual([])
  })

  it('scrubs when a person confirmed the name, since nothing will be restored', async () => {
    seedProfiles([ordinary('Dana Reyes', DANA, history)])
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    expect(journal(out.batchId).steps[0].evicted).toHaveLength(4)
    const { appendCorrection } = await import('./meeting-corrections.js')
    appendCorrection(SESSION, { id: 'vouch', phase: 'confirmed', at: new Date().toISOString(), from: 'Dana Reyes', to: 'Dana Reyes', chunks: [], scope: 'meeting' })
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'partial', evictedRestored: 0, evictedNotRestored: 4, samplesRemoved: 0 })
    expect(journal(out.batchId).steps[0].evicted).toEqual([])
  })

  it('ends a batch at retention: no Undo, no listing, and the file goes', async () => {
    const { batches, lib } = await load()
    const out = await named(batches, [ITEM_1])
    const file = data('mac-voice-naming-batches', SESSION, `${out.batchId}.json`)
    const fresh = new Date(Date.now() - lib.MAC_VOICE_NAMING_RETENTION_MS + 60_000)
    utimesSync(file, fresh, fresh)
    expect(batches.list(SESSION).batches).toHaveLength(1)
    const old = new Date(Date.now() - lib.MAC_VOICE_NAMING_RETENTION_MS - 60_000)
    utimesSync(file, old, old)
    expect(batches.list(SESSION).batches).toEqual([])
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'refused', reason: 'batch_not_found' })
    expect(existsSync(file)).toBe(true)
    expect((await named(batches, [ITEM_2])).state).toBe('applied')
    expect(existsSync(file)).toBe(false)
  })

  it('prunes at route registration and on an Undo, not on a preview', async () => {
    const { batches, lib } = await load()
    const out = await named(batches, [ITEM_1])
    const file = data('mac-voice-naming-batches', SESSION, `${out.batchId}.json`)
    const old = new Date(Date.now() - lib.MAC_VOICE_NAMING_RETENTION_MS - 60_000)
    utimesSync(file, old, old)
    await batches.run(SESSION, { sourceRevision: revision(), items: [ITEM_2] })
    expect(existsSync(file)).toBe(true)
    const routes: string[] = []
    lib.registerMacVoiceNamingBatchRoutes({ get: (path: string) => routes.push(path), post: (path: string) => routes.push(path) } as never, { store: { findBySessionId: () => null }, captureActive: () => false, reviewRevision: () => '', callViewMutationRefusal: () => null, finalizingRefusal: () => null })
    expect(routes).toHaveLength(3)
    expect(existsSync(file)).toBe(false)
  })

  it('a corrupt journal reads as unreadable, and naming is not blocked by it', async () => {
    const { batches } = await load()
    const out = await named(batches, [ITEM_1])
    writeFileSync(data('mac-voice-naming-batches', SESSION, `${out.batchId}.json`), '{ not json')
    expect(await batches.undo(SESSION, out.batchId, true)).toMatchObject({ state: 'refused', reason: 'journal_unreadable' })
    expect(batches.list(SESSION).batches).toEqual([expect.objectContaining({ batchId: out.batchId, state: 'unreadable', undoAvailable: false })])
    expect((await named(batches, [ITEM_2])).state).toBe('applied')
  })
})
