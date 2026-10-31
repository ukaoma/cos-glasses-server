// The display-only voice grouping behind GET /speakers `voiceDisplay` (6.96.3). Every label and number here is
// invented; the record SHAPE is the real one (schema 1, status proposed, proposals.accepted/rejected/untouched).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  VOICE_DISPLAY_FOLD_UNDER_SECONDS,
  __clearVoiceDisplayCacheForTests,
  buildVoiceDisplay,
  readVoiceDisplay,
  readVoiceDisplayEvidence,
  voiceDisplayEvidence,
  voiceDisplayScopes,
  type VoiceDisplay,
} from './mac-voice-display.js'

const SESSION = 'mac_1b2c3d4e-0000-4000-8000-00000000abcd'
const OTHER = 'mac_1b2c3d4e-0000-4000-8000-00000000ffff'

const voiceRow = (voice: string, seconds: number) => ({ voice, seconds, coveredFraction: 0.7, topCluster: 'S1', majority: 1, outlierPass: true, outlierDistance: 0.03, outlierP95: 0.4, outlierNote: null, anchorRatio: null, anchorRatioPostHoc: null, eligible: true, reasons: [], listen: [{ chunkIndex: 3, inFileStart: 0.1, inFileEnd: 5.9, callTime: '0:18' }] })

function record(overrides: Record<string, unknown> = {}, proposals: Record<string, unknown> = {}) {
  return {
    schema: 1, kind: 'speaker_shadow', logOnly: true, recordedAt: '2026-10-29T15:26:39.075Z', serverVersion: '6.96.0', sessionId: SESSION,
    enqueuedAt: '2026-10-29T15:20:00.000Z', status: 'proposed', reason: null, detail: null,
    gates: { majority: 0.8, minCoveredFraction: 0.5, floorSeconds: 15, outlier: 'leave-fragment-out cluster p95', anchorRatioMax: 1.5 },
    proposals: {
      productionVoices: 7, voicesAfter: 4, frozenOtherLabels: ['Ext'], fluidAudioClusters: 3, proposedMerges: 3, acceptedMerges: 2, rejectedMerges: 1, embeddingClusterAgreement: [9, 9, 9],
      accepted: [
        { cluster: 'S1', keepLabel: 'Voice 1', merge: ['Voice 2'], voices: [voiceRow('Voice 1', 200.5), voiceRow('Voice 2', 40.25)], otherLabelsInCluster: [{ label: 'Ext', seconds: 12 }] },
        { cluster: 'S2', keepLabel: 'Voice 3', merge: ['Voice 4', 'Voice 5'], voices: [voiceRow('Voice 3', 500), voiceRow('Voice 4', 30), voiceRow('Voice 5', 20)], otherLabelsInCluster: [] },
      ],
      rejected: [{ cluster: 'S1', wouldJoin: 'Voice 1', ...voiceRow('Voice 6', 14.99) }],
      untouched: [{ voice: 'Voice 7', seconds: 15, why: 'its own cluster' }],
      ...proposals,
    },
    ...overrides,
  }
}

const ALL = ['Voice 1', 'Voice 2', 'Voice 3', 'Voice 4', 'Voice 5', 'Voice 6', 'Voice 7']
const build = (rec: unknown, labels: readonly string[]): VoiceDisplay => buildVoiceDisplay(voiceDisplayEvidence(rec)!, labels)
const placed = (d: VoiceDisplay) => [...d.groups.flatMap(g => g.labels), ...d.singles.map(s => s.label), ...d.short.map(s => s.label)]

describe('buildVoiceDisplay', () => {
  it('shows merged groups largest first, then rows with the short ones folded apart', () => {
    expect(build(record(), [...ALL, 'Ext', 'Neva Sharpe'])).toEqual({
      source: 'speaker-shadow',
      recordedAt: '2026-10-29T15:26:39.075Z',
      foldUnderSeconds: 15,
      groups: [
        { id: 'shadow-S2', labels: ['Voice 3', 'Voice 4', 'Voice 5'], seconds: 550 },
        { id: 'shadow-S1', labels: ['Voice 1', 'Voice 2'], seconds: 240.75 },
      ],
      singles: [{ label: 'Voice 7', seconds: 15 }],
      short: [{ label: 'Voice 6', seconds: 14.99 }],
    })
  })

  it('folds strictly under 15 s: exactly 15 stays a row of its own, 14.99 folds', () => {
    expect(VOICE_DISPLAY_FOLD_UNDER_SECONDS).toBe(15)
    const d = build(record(), ALL)
    expect(d.singles.map(s => s.seconds)).toContain(15)
    expect(d.short.map(s => s.seconds)).toEqual([14.99])
    const zero = build(record({}, { untouched: [{ voice: 'Voice 7', seconds: 0, why: 'x' }] }), ALL)
    expect(zero.short.map(s => s.label)).toContain('Voice 7')
  })

  it('never includes Ext or a named label, even if the record claims one', () => {
    const rec = record({}, { untouched: [{ voice: 'Ext', seconds: 900, why: 'x' }, { voice: 'Neva Sharpe', seconds: 40, why: 'x' }] })
    const d = build(rec, [...ALL, 'Ext', 'Neva Sharpe', 'Unidentified 2'])
    expect(placed(d)).not.toContain('Ext')
    expect(placed(d)).not.toContain('Neva Sharpe')
    expect(placed(d)).not.toContain('Unidentified 2')
  })

  it('a voice named since then leaves its group; a group left with one label becomes a row', () => {
    const named = ALL.filter(l => l !== 'Voice 2')
    const d = build(record(), [...named, 'Neva Sharpe'])
    expect(d.groups.map(g => g.id)).toEqual(['shadow-S2'])
    expect(d.singles).toContainEqual({ label: 'Voice 1', seconds: 200.5 })

    // A surviving single from a merged group can land in the fold when its own seconds are short.
    const small = record({}, { accepted: [{ cluster: 'S9', keepLabel: 'Voice 1', merge: ['Voice 2'], voices: [voiceRow('Voice 1', 9), voiceRow('Voice 2', 40)] }], rejected: [], untouched: [] })
    expect(build(small, ['Voice 1']).short).toEqual([{ label: 'Voice 1', seconds: 9 }])

    // Group seconds count only who is left.
    const three = build(record(), ALL.filter(l => l !== 'Voice 5'))
    expect(three.groups.find(g => g.id === 'shadow-S2')).toEqual({ id: 'shadow-S2', labels: ['Voice 3', 'Voice 4'], seconds: 530 })
  })

  it('a group with nobody left disappears', () => {
    const d = build(record(), ['Voice 6', 'Voice 7'])
    expect(d.groups).toEqual([])
    expect(placed(d).sort()).toEqual(['Voice 6', 'Voice 7'])
  })

  it('never hides a row: a current voice the record never saw is a single with unknown seconds', () => {
    const d = build(record(), [...ALL, 'Voice 40'])
    expect(d.singles).toContainEqual({ label: 'Voice 40', seconds: null })
    expect(d.singles[d.singles.length - 1]).toEqual({ label: 'Voice 40', seconds: null })
    expect(placed(d).sort()).toEqual([...ALL, 'Voice 40'].sort())
  })

  it('places every anonymous label in exactly one bucket whatever the record holds', () => {
    for (const labels of [ALL, ALL.slice(0, 3), ['Voice 2', 'Voice 5', 'Voice 6'], ['Voice 90', 'Voice 91'], []]) {
      const d = build(record(), [...labels, 'Ext'])
      expect(placed(d).sort()).toEqual([...labels].sort())
      expect(new Set(placed(d)).size).toBe(labels.length)
    }
  })

  it('a label a voices row omits leaves its group seconds unknown, sorted last', () => {
    const rec = record({}, { accepted: [
      { cluster: 'S1', keepLabel: 'Voice 1', merge: ['Voice 2'], voices: [voiceRow('Voice 1', 1000)] },
      { cluster: 'S2', keepLabel: 'Voice 3', merge: ['Voice 4'], voices: [voiceRow('Voice 3', 20), voiceRow('Voice 4', 20)] },
    ], rejected: [], untouched: [] })
    const d = build(rec, ALL)
    expect(d.groups).toEqual([{ id: 'shadow-S2', labels: ['Voice 3', 'Voice 4'], seconds: 40 }, { id: 'shadow-S1', labels: ['Voice 1', 'Voice 2'], seconds: null }])
  })

  it('orders ties by voice number, so the list does not reshuffle between reads', () => {
    const rec = record({}, { accepted: [], rejected: [], untouched: [{ voice: 'Voice 10', seconds: 20, why: 'x' }, { voice: 'Voice 9', seconds: 20, why: 'x' }] })
    expect(build(rec, ['Voice 10', 'Voice 9']).singles.map(s => s.label)).toEqual(['Voice 9', 'Voice 10'])
  })
})

describe('voiceDisplayEvidence fails to absent', () => {
  const broken: Array<[string, unknown]> = [
    ['not an object', 'x'],
    ['null', null],
    ['skipped status', record({ status: 'skipped' })],
    ['no recordedAt', record({ recordedAt: undefined })],
    ['no proposals', record({ proposals: undefined })],
    ['accepted not a list', record({}, { accepted: {} })],
    ['rejected missing', record({}, { rejected: undefined })],
    ['untouched missing', record({}, { untouched: undefined })],
    ['group without a cluster', record({}, { accepted: [{ keepLabel: 'Voice 1', merge: [], voices: [] }] })],
    ['repeated cluster', record({}, { accepted: [{ cluster: 'S1', keepLabel: 'Voice 1', merge: [], voices: [] }, { cluster: 'S1', keepLabel: 'Voice 2', merge: [], voices: [] }], rejected: [], untouched: [] })],
    ['merge not a list', record({}, { accepted: [{ cluster: 'S1', keepLabel: 'Voice 1', merge: 'Voice 2', voices: [] }] })],
    ['a label in two groups', record({}, { accepted: [{ cluster: 'S1', keepLabel: 'Voice 1', merge: ['Voice 2'], voices: [] }, { cluster: 'S2', keepLabel: 'Voice 3', merge: ['Voice 2'], voices: [] }], rejected: [], untouched: [] })],
    ['a label both merged and rejected', record({}, { rejected: [voiceRow('Voice 2', 3)] })],
    ['non-string keepLabel', record({}, { accepted: [{ cluster: 'S1', keepLabel: 7, merge: [], voices: [] }] })],
    ['negative seconds', record({}, { untouched: [{ voice: 'Voice 9', seconds: -1 }] })],
    ['string seconds', record({}, { untouched: [{ voice: 'Voice 9', seconds: '20' }] })],
    ['NaN seconds on a merged voice', record({}, { accepted: [{ cluster: 'S1', keepLabel: 'Voice 1', merge: [], voices: [voiceRow('Voice 1', Number.NaN)] }] })],
    ['a voices row for a label outside the group', record({}, { accepted: [{ cluster: 'S1', keepLabel: 'Voice 1', merge: [], voices: [voiceRow('Voice 9', 20)] }], rejected: [], untouched: [] })],
  ]
  it.each(broken)('%s', (_name, value) => {
    expect(voiceDisplayEvidence(value)).toBeNull()
  })
})

describe('voiceDisplayScopes', () => {
  it('one result per group, single and short when a display exists', () => {
    const d = build(record(), [...ALL, 'Ext', 'Neva Sharpe'])
    expect(voiceDisplayScopes(d, [...ALL, 'Ext', 'Neva Sharpe'])).toEqual([['Voice 3', 'Voice 4', 'Voice 5'], ['Voice 1', 'Voice 2'], ['Voice 7'], ['Voice 6']])
  })
  it('one result per anonymous label when there is no display, and never Ext or a name', () => {
    expect(voiceDisplayScopes(null, ['Voice 2', 'Ext', 'Neva Sharpe', 'Voice 2', 'Voice 5', 'Unidentified 1'])).toEqual([['Voice 2'], ['Voice 5']])
  })
})

describe('reading the shadow store', () => {
  let root = ''
  const jsonl = (...rows: unknown[]) => rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n'
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'voice-display-'))
    __clearVoiceDisplayCacheForTests()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('no store, no field', async () => {
    expect(await readVoiceDisplay(SESSION, ALL, join(root, 'nope'))).toBeNull()
    expect(await readVoiceDisplay(SESSION, ALL, root)).toBeNull()
  })

  it('no record for this session, no field', async () => {
    writeFileSync(join(root, 'proposals.jsonl'), jsonl(record({ sessionId: OTHER })))
    expect(await readVoiceDisplay(SESSION, ALL, root)).toBeNull()
  })

  it('skips newer non-proposed records and reads the latest proposed one', async () => {
    writeFileSync(join(root, 'proposals.jsonl'), jsonl(
      record({ recordedAt: '2026-10-29T10:00:00.000Z' }),
      record({ recordedAt: '2026-10-29T11:00:00.000Z' }),
      record({ recordedAt: '2026-10-29T12:00:00.000Z', status: 'failed', proposals: undefined }),
    ))
    expect((await readVoiceDisplay(SESSION, ALL, root))?.recordedAt).toBe('2026-10-29T11:00:00.000Z')
  })

  it('a session whose only records failed has no field', async () => {
    writeFileSync(join(root, 'proposals.jsonl'), jsonl(record({ status: 'failed', proposals: undefined })))
    expect(await readVoiceDisplay(SESSION, ALL, root)).toBeNull()
  })

  it('reads through a rotated proposals file, and the live file beats it', async () => {
    writeFileSync(join(root, 'proposals-2026-10-01T00-00-00-000Z.jsonl'), jsonl(record({ recordedAt: '2026-10-01T00:00:00.000Z' })))
    expect((await readVoiceDisplay(SESSION, ALL, root))?.recordedAt).toBe('2026-10-01T00:00:00.000Z')
    writeFileSync(join(root, 'proposals.jsonl'), jsonl(record({ sessionId: OTHER, recordedAt: '2026-10-02T00:00:00.000Z' })))
    expect((await readVoiceDisplay(SESSION, ALL, root))?.recordedAt).toBe('2026-10-01T00:00:00.000Z')
    writeFileSync(join(root, 'proposals.jsonl'), jsonl(record({ recordedAt: '2026-10-03T00:00:00.000Z' })))
    expect((await readVoiceDisplay(SESSION, ALL, root))?.recordedAt).toBe('2026-10-03T00:00:00.000Z')
  })

  it('a malformed line is skipped; a malformed newest proposed record omits the field rather than falling back', async () => {
    writeFileSync(join(root, 'proposals.jsonl'), jsonl(record({ recordedAt: '2026-10-01T00:00:00.000Z' }), '{ not json', record({ recordedAt: '2026-10-02T00:00:00.000Z' }, { accepted: 'bad' })))
    expect(await readVoiceDisplay(SESSION, ALL, root)).toBeNull()
  })

  it('caches by mtime: a repeat read does not re-parse, a changed store does', async () => {
    const path = join(root, 'proposals.jsonl')
    writeFileSync(path, jsonl(record()))
    const first = await readVoiceDisplayEvidence(SESSION, root)
    expect(first).not.toBeNull()
    expect(await readVoiceDisplayEvidence(SESSION, root)).toBe(first)
    const none = await readVoiceDisplayEvidence(OTHER, root)
    expect(none).toBeNull()

    const body = readFileSync(path)
    writeFileSync(path, jsonl(record({ recordedAt: '2026-10-29T16:00:00.000Z' })))
    expect((await readVoiceDisplayEvidence(SESSION, root))?.recordedAt).toBe('2026-10-29T16:00:00.000Z')
    writeFileSync(path, body)
    const later = new Date(statSync(path).mtimeMs + 5_000)
    utimesSync(path, later, later)
    expect((await readVoiceDisplayEvidence(SESSION, root))?.recordedAt).toBe('2026-10-29T15:26:39.075Z')
  })

  it('never throws, including when the store is a file', async () => {
    const file = join(root, 'proposals.jsonl')
    writeFileSync(file, 'x')
    await expect(readVoiceDisplay(SESSION, ALL, file)).resolves.toBeNull()
    mkdirSync(join(root, 'dir'))
    mkdirSync(join(root, 'dir', 'proposals.jsonl'))
    await expect(readVoiceDisplay(SESSION, ALL, join(root, 'dir'))).resolves.toBeNull()
  })
})
