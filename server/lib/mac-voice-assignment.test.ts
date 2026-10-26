// Direct tests for the guards inside planMacVoiceAssignment and commitMacVoiceAssignment.
// The route test drives the happy path over HTTP; these pin each refusal at the library
// boundary, so a caller other than the relabel route cannot skip one. Fictional names only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const MAC_ID = 'mac_1b2c3d4e-0000-4000-8000-00000000abcd'
let dataDir = ''
const written: string[] = []
let runtime = true

const MAC_SIDECAR = { sessionId: MAC_ID, chunks: [{ text: 'a', speaker: 'Voice 2' }], chunkEntries: [{ chunkIndex: 0, chunk: { text: 'a', speaker: 'Voice 2' } }] }

async function lib() {
  vi.resetModules()
  written.length = 0
  runtime = true
  vi.doMock('./speaker-embeddings.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('./speaker-embeddings.js')
    return {
      ...actual,
      isEmbeddingAvailable: () => runtime,
      extractEmbedding: () => null,
      enrollEmbedding: (name: string) => { written.push(name); return { success: true, dim: 192 } },
    }
  })
  return import('./mac-voice-assignment.js')
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cos-mac-assign-lib-'))
  process.env.COS_DATA_DIR = dataDir
  writeFileSync(join(dataDir, 'voice-profiles.json'), JSON.stringify({ profiles: [{ name: 'Dana Reyes', embeddings: [new Array(192).fill(0.1)], sources: ['g2-training'] }, { name: 'Voice 1', embeddings: [new Array(192).fill(0.1)], sources: ['g2-training'] }] }))
})
afterEach(() => {
  vi.resetModules()
  vi.doUnmock('./speaker-embeddings.js')
  delete process.env.COS_DATA_DIR
  delete process.env.COS_CHUNK_EMBEDDINGS
  rmSync(dataDir, { recursive: true, force: true })
})

const input = (over: Record<string, unknown> = {}) => ({ sessionId: MAC_ID, from: 'Voice 2', to: 'Dana Reyes', changed: [0], sidecar: MAC_SIDECAR as Record<string, unknown>, ...over })

describe('planMacVoiceAssignment refuses, each for its own reason, and selects nothing', () => {
  it.each([
    ['a glasses meeting', { sessionId: 'meeting_plain', sidecar: { sessionId: 'meeting_plain', chunks: [], chunkEntries: [] } }, 'not_mac_capture'],
    ['a named voice', { from: 'Casey Lin' }, 'not_a_voice_label'],
    ['a placeholder target', { to: 'Voice 1' }, 'unknown_profile'],
    ['an unenrolled name', { to: 'Nobody Known' }, 'unknown_profile'],
    ['no relabelled chunk', { changed: [] }, 'no_usable_audio'],
    ['a sidecar with no raw-index mapping', { sidecar: { sessionId: MAC_ID, chunks: [{ text: 'a', speaker: 'Voice 2' }] } }, 'no_index_mapping'],
  ])('%s', async (_name, over, skipped) => {
    const { planMacVoiceAssignment } = await lib()
    const plan = planMacVoiceAssignment(input(over))
    expect(plan.report.skipped).toBe(skipped)
    expect(plan.report.enrolled).toBe(0)
    expect(plan.selected).toEqual([])
  })

  it('with embeddings switched off by COS_CHUNK_EMBEDDINGS=0', async () => {
    process.env.COS_CHUNK_EMBEDDINGS = '0'
    const { planMacVoiceAssignment } = await lib()
    expect(planMacVoiceAssignment(input()).report.skipped).toBe('disabled')
  })

  it('without the speaker model', async () => {
    const { planMacVoiceAssignment } = await lib()
    runtime = false
    expect(planMacVoiceAssignment(input()).report.skipped).toBe('store_unavailable')
  })

  it('with no archived audio it says audio_not_retained and counts the chunk', async () => {
    const { planMacVoiceAssignment } = await lib()
    const plan = planMacVoiceAssignment(input())
    expect(plan.report).toMatchObject({ skipped: 'audio_not_retained', missingAudio: 1, enrolled: 0, created: false })
  })
})

describe('commitMacVoiceAssignment', () => {
  it('writes nothing for a plan that was refused, even if it somehow carries vectors', async () => {
    const { commitMacVoiceAssignment } = await lib()
    const report = commitMacVoiceAssignment(MAC_ID, {
      report: { person: 'Dana Reyes', enrolled: 1, attempted: 1, created: false, clusterSkipped: 0, multiVoiceSkipped: 0, shortSkipped: 0, missingAudio: 0, similarity: null, belowFloor: false, floor: 0.55, skipped: 'audio_not_retained' },
      selected: [new Float32Array(192)],
    })
    expect(written).toEqual([])
    expect(report.enrolled).toBe(0)
  })

  it('writes each selected vector to the named person once', async () => {
    const { commitMacVoiceAssignment } = await lib()
    const report = commitMacVoiceAssignment(MAC_ID, {
      report: { person: 'Dana Reyes', enrolled: 2, attempted: 2, created: false, clusterSkipped: 0, multiVoiceSkipped: 0, shortSkipped: 0, missingAudio: 0, similarity: 0.9, belowFloor: false, floor: 0.55, skipped: null },
      selected: [new Float32Array(192), new Float32Array(192)],
    })
    expect(written).toEqual(['Dana Reyes', 'Dana Reyes'])
    expect(report.enrolled).toBe(2)
  })
})
