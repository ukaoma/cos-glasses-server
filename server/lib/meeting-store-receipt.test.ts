import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MeetingStore } from './meeting-store.js'
import { MAX_MEETING_BYTES } from './meeting-file-guards.js'

const roots: string[] = []
const macId = 'mac_5c820d63-4ed8-4a39-8b9c-0072dd4bdf54'
const legacyId = 'meeting_receipt_legacy'

function fixture(sessionId = macId) {
  const root = mkdtempSync(join(tmpdir(), 'cos-store-receipt-'))
  roots.push(root)
  const recordings = join(root, 'recordings')
  const store = new MeetingStore(recordings)
  const saved = store.save({
    sessionId,
    title: 'Long call',
    domain: 'personal',
    transcript: '[Ext]: Fixture transcript.',
    startTime: new Date(2026, 9, 30, 11, 9).getTime(),
    durationMs: 88 * 60_000,
    chunks: [],
    transferIntegrity: { received: 882, stored: 882, maxIndex: 881, expected: 882, missingIndices: [], completeness: 1 },
  })
  const sidecar = JSON.parse(readFileSync(saved.sidecarPath, 'utf8'))
  if (sessionId === macId) {
    sidecar.sourceType = 'mac_system_audio'
    sidecar.captureSource = { version: 1, captureId: sessionId, sessionId, sourceType: 'mac_system_audio', speakerPolicy: 'high-confidence' }
  }
  return { root, recordings, store, saved, sidecar }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('MeetingStore durable save receipt readback', () => {
  it('replays a completed long Mac call after batch metadata grows beyond the markdown ceiling', () => {
    const { recordings, saved, sidecar } = fixture()
    sidecar.batchApplied = true
    sidecar.batchTranscript = 'x'.repeat(MAX_MEETING_BYTES)
    sidecar.finalizationState = 'complete'
    writeFileSync(saved.sidecarPath, JSON.stringify(sidecar))
    expect(statSync(saved.sidecarPath).size).toBeGreaterThan(MAX_MEETING_BYTES)

    const restarted = new MeetingStore(recordings)
    expect(restarted.findBySessionId(macId)).toMatchObject({
      captureId: macId,
      sourceType: 'mac_system_audio',
      filename: saved.filename,
      month: saved.month,
      title: 'Long call',
      domain: 'personal',
      durationMin: 88,
      transferIntegrity: { missingIndices: [], completeness: 1 },
    })
    // Repeated old-client retries resolve the same canonical file without writes.
    expect(restarted.findBySessionId(macId)).toEqual(restarted.findBySessionId(macId))
  })

  it('retains receipt readback for older G2 sidecars without capture metadata', () => {
    const { recordings, saved } = fixture(legacyId)
    expect(new MeetingStore(recordings).findBySessionId(legacyId)).toMatchObject({ filename: saved.filename })
    expect(new MeetingStore(recordings).findBySessionId(legacyId)).not.toHaveProperty('captureId')
  })

  it('rejects a traversal session id before looking up a receipt', () => {
    const { store } = fixture()
    expect(() => store.findBySessionId('../outside')).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_session_id' }))
  })

  it.each(['malformed', 'mismatched', 'nested', 'oversize', 'orphan'] as const)('refuses a %s sidecar as a save receipt', kind => {
    const { store, saved, sidecar } = fixture()
    if (kind === 'malformed') writeFileSync(saved.sidecarPath, JSON.stringify(sidecar).slice(0, -1))
    if (kind === 'mismatched') writeFileSync(saved.sidecarPath, JSON.stringify({ ...sidecar, sessionId: legacyId }))
    if (kind === 'nested') writeFileSync(saved.sidecarPath, JSON.stringify({ captureSource: sidecar }))
    // Valid JSON with trailing whitespace: dropping the read bound would wrongly
    // return a receipt, rather than merely encountering a parse error.
    if (kind === 'oversize') writeFileSync(saved.sidecarPath, JSON.stringify(sidecar) + ' '.repeat(32 * 1024 * 1024))
    if (kind === 'orphan') unlinkSync(saved.filepath)
    expect(store.findBySessionId(macId)).toBeNull()
  })

  it.each(['sidecar', 'markdown', 'month', 'root'] as const)('refuses a symlinked %s when reading back a receipt', kind => {
    const { root, recordings, store, saved } = fixture()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    if (kind === 'sidecar' || kind === 'markdown') {
      const original = kind === 'sidecar' ? saved.sidecarPath : saved.filepath
      const target = join(outside, 'target')
      writeFileSync(target, readFileSync(original))
      unlinkSync(original)
      symlinkSync(target, original)
    } else {
      const original = kind === 'month' ? join(recordings, saved.month) : recordings
      const target = join(outside, saved.month)
      mkdirSync(target)
      writeFileSync(join(target, saved.filename), readFileSync(saved.filepath))
      writeFileSync(join(target, saved.filename.replace(/\.md$/, '.g2-chunks.json')), readFileSync(saved.sidecarPath))
      rmSync(original, { recursive: true })
      symlinkSync(kind === 'month' ? target : outside, original)
    }
    if (kind === 'root') expect(() => store.findBySessionId(macId)).toThrowError(expect.objectContaining({ code: 'unsafe_recordings_store' }))
    else expect(store.findBySessionId(macId)).toBeNull()
  })
})
