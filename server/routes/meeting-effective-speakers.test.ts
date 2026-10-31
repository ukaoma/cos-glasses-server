/** Actual HTTP reviewer/content adapter, with the acoustic producer boundary frozen.
 * Projection geometry is exercised in the interval module tests and cached pair;
 * this fixture proves both readers consume its final words rather than old roots. */
import express from 'express'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({ enabled: true }))
let root = '', server: Server | undefined
vi.mock('../lib/profile.js', () => ({ getOwnerSpeakerLabel: () => 'MU', getOwnerName: () => 'Fixture Owner',
  getVocabulary: () => [], getTranscriptionProfileStatus: () => ({}) }))
vi.mock('../lib/mac-speaker-call-view.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/mac-speaker-call-view.js')>()
  return { ...actual, readMacSpeakerCallView: (_path: string, baseJSON: string) => {
    const doc = JSON.parse(baseJSON)
    if (!control.enabled) return actual.resolveMacSpeakerCallView(baseJSON, '', null)
    doc.batchSegments[0].speakerWords[0].speaker = 'Anonymous group 1'
    return { doc, markdown: '# Synthetic call\n\n## Transcript\n\n[Anonymous group 1]: First word.\n[Ext]: Remainder word.\n[Named Example]: Named word.\n', metadata: {
      status: 'applied', reason: 'source-bound-anonymous-interval-view', mode: 'source-bound-intervals', changedWords: 1, changedChunks: 0,
      localization: 'estimated-ASR-with-native-support', speakerPurityVerified: false,
      groups: [{ identityId: 'acoustic_fixture', label: 'Anonymous group 1', memberVoices: [], intervals: [] }],
      effectiveWordView: { version: 1, anonymousGroups: [{ identityId: 'acoustic_fixture', label: 'Anonymous group 1' }], unresolvedLabel: 'Ext' },
    } }
  } }
})

afterEach(async () => {
  if (server) await new Promise<void>(done => server!.close(() => done()))
  server = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = ''
  control.enabled = true; vi.unstubAllEnvs(); vi.resetModules()
})

async function fixture() {
  root = mkdtempSync(join(tmpdir(), 'cos-effective-review-'))
  vi.stubEnv('COS_DATA_DIR', join(root, 'data'))
  vi.stubEnv('COS_PROFILE_PATH', join(root, 'private-profile.json'))
  vi.stubEnv('COS_SCRIPTS_DIR', '')
  delete process.env.COS_SCRIPTS_DIR
  const recordings = join(root, 'recordings'), month = join(recordings, '2026-10'); mkdirSync(month, { recursive: true })
  const sid = 'mac_11111111-1111-4111-8111-111111111111'
  const sidecarPath = join(month, '2026-10-30_Synthetic_call.g2-chunks.json'), mdPath = sidecarPath.replace('.g2-chunks.json', '.md')
  const chunks = [...Array.from({ length: 59 }, (_, i) => ({ speaker: `Voice ${i + 1}`, text: `Source phrase ${i}`, elapsed: i * 1000 })),
    ...Array.from({ length: 3 }, (_, i) => ({ speaker: 'Named Example', text: `Named source ${i}`, elapsed: 60_000 + i * 1000, similarity: .9 }))]
  const doc = { sessionId: sid, title: 'Synthetic call', startTime: Date.UTC(2026, 9, 30), durationMs: 70_000, correctionRevision: 1, chunks,
    batchSegments: [{ startElapsed: 10_000, speakerWords: [
      { word: 'First word.', start: 0, end: 1, speaker: 'Ext' },
      { word: 'Remainder word.', start: 2, end: 3, speaker: 'Ext' },
      { word: 'Named word.', start: 4, end: 5, speaker: 'Named Example' },
    ] }] }
  const original = JSON.stringify(doc), markdown = '# Synthetic call\n\n## Transcript\n\n[Ext]: First word.\n[Ext]: Remainder word.\n[Named Example]: Named word.\n'
  writeFileSync(sidecarPath, original); writeFileSync(mdPath, markdown)
  const { MeetingStore } = await import('../lib/meeting-store.js')
  const { createMeetingRouter } = await import('./meeting.js')
  const app = express(); app.use(express.json()); app.use('/api', createMeetingRouter({ store: new MeetingStore(recordings) }))
  server = await new Promise<Server>(done => { const s = app.listen(0, '127.0.0.1', () => done(s)) })
  const addr = server.address(); if (!addr || typeof addr === 'string') throw Error('private loopback unavailable')
  const get = async (path: string) => { const r = await fetch(`http://127.0.0.1:${addr.port}/api/meeting/${sid}${path}`); return { status: r.status, body: await r.json() as any } }
  return { get, sidecarPath, mdPath, original, markdown }
}

describe('effective final-word review HTTP consumers', () => {
  it('returns the same effective rows/timeline for Speakers and saved content; copy reaches the actual projected prefix', async () => {
    const f = await fixture(), speakers = await f.get('/speakers'), content = await f.get('/content')
    expect(speakers.status).toBe(200); expect(content.status).toBe(200)
    expect(speakers.body.voices.map((v: any) => v.label).sort()).toEqual(['Anonymous group 1', 'Ext', 'Named Example'])
    expect(speakers.body.effectiveSpeakerSummary).toMatchObject({ anonymousGroupCount: 1, namedVoiceCount: 1, unresolvedSpeakingMs: 1000, unresolvedWordCount: 1, displayRowCount: 3 })
    expect(content.body.effectiveSpeakerSummary).toEqual(speakers.body.effectiveSpeakerSummary)
    expect(speakers.body.timeline.map((t: any) => [t.speaker, t.startMs, t.endMs])).toEqual([
      ['Anonymous group 1', 10_000, 11_000], ['Ext', 12_000, 13_000], ['Named Example', 14_000, 15_000]])
    expect(content.body.attendees.map((v: any) => v.label).sort()).toEqual(['Anonymous group 1', 'Ext', 'Named Example'])
    expect(content.body.clipboardFull).toContain('[Anonymous group 1]: First word.')
    expect(content.body.clipboardFull).toContain('[Ext]: Remainder word.')
    expect(content.body.clipboardFull).toContain('[Named Example]: Named word.')
    expect(content.body.clipboardFull).not.toContain('Voice 59')
    expect(speakers.body.mutable).toBe(false); expect(content.body.mutable).toBe(false)
    expect(speakers.body.groupScopes).toEqual([])
    expect((await f.get('/speaker-groups')).body.groupScopes).toEqual([])
    expect(readFileSync(f.sidecarPath, 'utf8')).toBe(f.original); expect(readFileSync(f.mdPath, 'utf8')).toBe(f.markdown)
  }, 30_000)

  it('withdraws effective inventory and projected copy when the new policy is off', async () => {
    const f = await fixture(); control.enabled = false
    const speakers = await f.get('/speakers'), content = await f.get('/content')
    expect(speakers.status).toBe(200); expect(speakers.body.voices).toHaveLength(60)
    expect(speakers.body.effectiveSpeakerSummary).toBeUndefined(); expect(content.body.effectiveSpeakerSummary).toBeUndefined()
    expect(content.body.clipboardFull).not.toContain('Anonymous group 1')
    expect(content.body.clipboardFull).toContain('[Ext]: First word.')
    expect(readFileSync(f.sidecarPath, 'utf8')).toBe(f.original)
  }, 30_000)
})
