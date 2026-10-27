// Direct tests for the guards inside planMacVoiceAssignment and commitMacVoiceAssignment.
// The route test drives the happy path over HTTP; these pin each refusal at the library
// boundary, so a caller other than the relabel route cannot skip one. Fictional names only.
// commitMacVoiceAssignment runs the REAL batched enrolment against a temp store (fake sherpa runtime).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fakeSpeakerRuntime } from './__fixtures__/fake-speaker-runtime.js'

const MAC_ID = 'mac_1b2c3d4e-0000-4000-8000-00000000abcd'
let dataDir = ''
const written: string[] = []
let runtime = true
let batchCalls = 0
let extract: (audio: Buffer) => Float32Array | null = () => null
let extractCalls = 0

const MAC_SIDECAR = { sessionId: MAC_ID, chunks: [{ text: 'a', speaker: 'Voice 2' }], chunkEntries: [{ chunkIndex: 0, chunk: { text: 'a', speaker: 'Voice 2' } }] }

async function lib() {
  vi.resetModules()
  written.length = 0
  batchCalls = 0
  extractCalls = 0
  extract = () => null
  runtime = true
  vi.doMock('./speaker-embeddings.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('./speaker-embeddings.js')
    ;(actual.__installSpeakerRuntimeForTests as (r: unknown) => void)(fakeSpeakerRuntime())
    return {
      ...actual,
      isEmbeddingAvailable: () => runtime,
      extractEmbedding: (audio: Buffer) => { extractCalls += 1; return extract(audio) },
      enrollEmbeddingsBatch: (name: string, items: Array<{ embedding: Float32Array; source: string }>) => {
        batchCalls += 1
        for (const item of items) written.push(`${name}|${item.source}`)
        return (actual.enrollEmbeddingsBatch as (n: string, i: unknown) => unknown)(name, items)
      },
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
    const plan = await planMacVoiceAssignment(input(over))
    expect(plan.report.skipped).toBe(skipped)
    expect(plan.report.enrolled).toBe(0)
    expect(plan.selected).toEqual([])
  })

  it('with embeddings switched off by COS_CHUNK_EMBEDDINGS=0', async () => {
    process.env.COS_CHUNK_EMBEDDINGS = '0'
    const { planMacVoiceAssignment } = await lib()
    expect((await planMacVoiceAssignment(input())).report.skipped).toBe('disabled')
  })

  it('without the speaker model', async () => {
    const { planMacVoiceAssignment } = await lib()
    runtime = false
    expect((await planMacVoiceAssignment(input())).report.skipped).toBe('store_unavailable')
  })

  it('B3: the wearer profile, in any case or Unicode form, is refused at the library boundary', async () => {
    const { planMacVoiceAssignment } = await lib()
    writeFileSync(join(dataDir, 'voice-profiles.json'), JSON.stringify({ profiles: [{ name: 'MU', embeddings: [new Array(192).fill(0.1)], sources: ['manual'] }] }))
    for (const to of ['MU', 'mu', 'ＭＵ']) {
      const plan = await planMacVoiceAssignment(input({ to, ownerLabel: 'MU' }))
      expect(plan.report.skipped).toBe('owner_profile')
      expect(plan.selected).toEqual([])
    }
    // Without an owner label the guard has nothing to compare, so a caller that omits it is not protected: the route always passes it.
    expect((await planMacVoiceAssignment(input({ to: 'MU' }))).report.skipped).not.toBe('owner_profile')
  })

  it('a profile with no usable stored voice is refused, not compared against nothing', async () => {
    const { planMacVoiceAssignment } = await lib()
    writeFileSync(join(dataDir, 'voice-profiles.json'), JSON.stringify({ profiles: [{ name: 'Dana Reyes', embeddings: [], sources: [] }] }))
    expect((await planMacVoiceAssignment(input())).report.skipped).toBe('no_stored_voice')
  })

  it('with no archived audio it says audio_not_retained and counts the chunk', async () => {
    const { planMacVoiceAssignment } = await lib()
    const plan = await planMacVoiceAssignment(input())
    expect(plan.report).toMatchObject({ skipped: 'audio_not_retained', missingAudio: 1, enrolled: 0, created: false })
  })
})

function axisVector(axis: number, texture: number): Float32Array {
  const v = new Float32Array(192)
  for (let k = axis; k < 128; k += 4) v[k] = 100
  v[128 + (texture % 63)] = 200
  return v
}
function chunkWav(sec: number, rate = 16_000): Buffer {
  const n = Math.round(sec * rate)
  const pcm = Buffer.alloc(n * 2, 1)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
function archiveChunks(raws: number[], sec = 4): void {
  const dir = join(dataDir, 'meeting-audio', MAC_ID)
  mkdirSync(dir, { recursive: true })
  for (const raw of raws) writeFileSync(join(dir, `chunk_${String(raw).padStart(4, '0')}.wav`), chunkWav(sec))
}
const meeting = (raws: number[]) => ({
  sessionId: MAC_ID,
  chunks: raws.map(() => ({ text: 'a', speaker: 'Voice 2' })),
  chunkEntries: raws.map(raw => ({ chunkIndex: raw, chunk: { text: 'a', speaker: 'Voice 2' } })),
})
const nextTexture = () => { let n = 0; return () => n++ }

describe('B4: the plan yields, has a deadline, and keeps its vectors', () => {
  it('yields to the event loop before every unit', async () => {
    const { planMacVoiceAssignment } = await lib()
    const raws = [0, 2, 4, 6, 8]
    archiveChunks(raws)
    const t = nextTexture(); extract = () => axisVector(0, t())
    let yields = 0
    const plan = await planMacVoiceAssignment(input({ changed: raws.map((_, i) => i), sidecar: meeting(raws), yieldToLoop: async () => { yields += 1 } }))
    expect(plan.report.skipped).toBeNull()
    expect(yields).toBe(5)
    expect(plan.stats).toMatchObject({ units: 5, embedded: 5, reused: 0 })
  })

  it('the real yield lets other timers run mid-plan (not just a call counted)', async () => {
    const { planMacVoiceAssignment } = await lib()
    const raws = Array.from({ length: 12 }, (_, i) => i * 2)
    archiveChunks(raws)
    const t = nextTexture(); extract = () => axisVector(0, t())
    let ticks = 0
    let running = true
    const spin = () => { if (!running) return; ticks += 1; setImmediate(spin) }
    setImmediate(spin)
    try { await planMacVoiceAssignment(input({ changed: raws.map((_, i) => i), sidecar: meeting(raws) })) } finally { running = false }
    expect(ticks).toBeGreaterThanOrEqual(raws.length - 1)
  })

  it('stops at the deadline with a named reason and no partial answer, and keeps what it embedded', async () => {
    const { planMacVoiceAssignment } = await lib()
    const raws = [0, 2, 4, 6, 8, 10]
    archiveChunks(raws)
    const t = nextTexture(); extract = () => axisVector(0, t())
    let clock = 0
    const first = await planMacVoiceAssignment(input({ changed: raws.map((_, i) => i), sidecar: meeting(raws), deadlineMs: 1000, now: () => { clock += 400; return clock } }))
    expect(first.report.skipped).toBe('deadline')
    expect(first.selected).toEqual([])
    expect(first.report.enrolled).toBe(0)
    const embeddedFirst = extractCalls
    expect(embeddedFirst).toBeGreaterThan(0)
    expect(embeddedFirst).toBeLessThan(raws.length)
    // Asking again continues: the vectors already made are reused, only the rest is embedded, and the plan completes.
    const second = await planMacVoiceAssignment(input({ changed: raws.map((_, i) => i), sidecar: meeting(raws), deadlineMs: 60_000 }))
    expect(second.report.skipped).toBeNull()
    expect(second.stats.reused).toBe(embeddedFirst)
    expect(extractCalls).toBe(raws.length)
  })

  it('a second plan over the same files re-embeds nothing; a changed file is embedded again', async () => {
    const { planMacVoiceAssignment } = await lib()
    const raws = [0, 2, 4]
    archiveChunks(raws)
    const t = nextTexture(); extract = () => axisVector(0, t())
    const args = () => input({ changed: raws.map((_, i) => i), sidecar: meeting(raws) })
    await planMacVoiceAssignment(args())
    expect(extractCalls).toBe(3)
    const again = await planMacVoiceAssignment(args())
    expect(extractCalls).toBe(3)
    expect(again.stats).toMatchObject({ embedded: 0, reused: 3 })
    writeFileSync(join(dataDir, 'meeting-audio', MAC_ID, 'chunk_0002.wav'), chunkWav(4.5))
    await planMacVoiceAssignment(args())
    expect(extractCalls).toBe(4)
  })

  it('an env deadline outside 1 s to 25 s is ignored', async () => {
    const { planMacVoiceAssignment, MAC_ASSIGN_DEADLINE_MS } = await lib()
    expect(MAC_ASSIGN_DEADLINE_MS).toBe(12_000)
    process.env.COS_MAC_ASSIGN_DEADLINE_MS = '5'
    const raws = [0, 2]
    archiveChunks(raws)
    const t = nextTexture(); extract = () => axisVector(0, t())
    try {
      const plan = await planMacVoiceAssignment(input({ changed: [0, 1], sidecar: meeting(raws) }))
      expect(plan.report.skipped).toBeNull() // 5 ms would have tripped the deadline on the first unit
    } finally { delete process.env.COS_MAC_ASSIGN_DEADLINE_MS }
  })
})

describe('B1 at the library boundary: gates are reported, never silently passed', () => {
  async function planWith(vectors: Array<[number, number]>, sec = 4, stored: Float32Array = axisVector(0, 60)) {
    const { planMacVoiceAssignment } = await lib()
    writeFileSync(join(dataDir, 'voice-profiles.json'), JSON.stringify({ profiles: [{ name: 'Dana Reyes', embeddings: [Array.from(stored)], sources: ['manual'] }] }))
    const raws = vectors.map((_, i) => i * 2)
    archiveChunks(raws, sec)
    let i = 0; extract = () => axisVector(vectors[i][0], vectors[i++][1])
    return planMacVoiceAssignment(input({ changed: raws.map((_, k) => k), sidecar: meeting(raws) }))
  }

  it('a clean same-voice plan has no gates', async () => {
    const plan = await planWith([[0, 1], [0, 2], [0, 3]])
    expect(plan.report).toMatchObject({ attempted: 3, groupSize: 3, clusterSkipped: 0, belowFloor: false, gates: [], enrolled: 3 })
    expect(plan.report.groupSec).toBe(12)
  })

  it('below the floor, mixed, and too little are each reported, in that order', async () => {
    const plan = await planWith([[1, 1], [1, 2]], 2.5) // two short units of another voice than the stored one
    expect(plan.report.gates).toEqual(['below_floor'])
    expect(plan.report.groupSec).toBe(5)
    const mixed = await planWith([[1, 1], [1, 2], [0, 3], [0, 4], [2, 5]])
    expect(mixed.report.gates).toEqual(['below_floor', 'mixed_voice'])
    const thin = await planWith([[0, 1]], 2.5)
    expect(thin.report.gates).toEqual(['too_little_audio'])
  })

  it('exactly two thirds is not mixed; one unit under it is', async () => {
    const edge = await planWith([[0, 1], [0, 2], [1, 3]]) // 2 of 3
    expect(edge.report).toMatchObject({ groupSize: 2, clusterSkipped: 1 })
    expect(edge.report.gates).toEqual([])
    const under = await planWith([[0, 1], [0, 2], [1, 3], [2, 4]]) // 2 of 4
    expect(under.report.gates).toEqual(['mixed_voice'])
  })

  it('a unit count of one passes only at 6 s or more', async () => {
    expect((await planWith([[0, 1]], 5.9)).report.gates).toEqual(['too_little_audio'])
    expect((await planWith([[0, 1]], 6)).report.gates).toEqual([])
  })
})

describe('commitMacVoiceAssignment', () => {
  const report = (over: Record<string, unknown> = {}) => ({ person: 'Dana Reyes', enrolled: 1, attempted: 1, created: false as const, clusterSkipped: 0, multiVoiceSkipped: 0, shortSkipped: 0, missingAudio: 0, similarity: null, belowFloor: false, floor: 0.55, groupSize: 1, groupSec: 6, gates: [], skipped: null, ...over })
  const stats = { units: 0, embedded: 0, reused: 0, ms: 0 }

  it('writes nothing for a plan that was refused, even if it somehow carries vectors', async () => {
    const { commitMacVoiceAssignment } = await lib()
    const out = commitMacVoiceAssignment(MAC_ID, { report: report({ skipped: 'audio_not_retained' }), selected: [new Float32Array(192)], stats })
    expect(written).toEqual([])
    expect(batchCalls).toBe(0)
    expect(out.enrolled).toBe(0)
  })

  it('writes every selected vector in ONE store write, tagged mac-assign:<session>, never correction:', async () => {
    const { commitMacVoiceAssignment } = await lib()
    const out = commitMacVoiceAssignment(MAC_ID, { report: report({ enrolled: 2 }), selected: [axisVector(1, 1), axisVector(2, 2)], stats })
    expect(batchCalls).toBe(1)
    expect(written).toEqual([`Dana Reyes|mac-assign:${MAC_ID}`, `Dana Reyes|mac-assign:${MAC_ID}`])
    expect(out.enrolled).toBe(2)
    const stored = JSON.parse(readFileSync(join(dataDir, 'voice-profiles.json'), 'utf-8')).profiles.find((p: { name: string }) => p.name === 'Dana Reyes')
    expect(stored.sources.slice(-2)).toEqual([`mac-assign:${MAC_ID}`, `mac-assign:${MAC_ID}`])
    expect(stored.sources.some((src: string) => src.startsWith('correction'))).toBe(false)
  })

  it('a store that cannot be written reports 0 enrolled and store_unavailable, and the profile is unchanged', async () => {
    const { commitMacVoiceAssignment } = await lib()
    const path = join(dataDir, 'voice-profiles.json')
    const before = readFileSync(path, 'utf-8')
    const speaker = await import('./speaker-embeddings.js')
    expect(speaker.readVoiceProfiles().profiles.find(p => p.name === 'Dana Reyes')?.embeddings).toHaveLength(1)
    rmSync(path); mkdirSync(path)
    const out = commitMacVoiceAssignment(MAC_ID, { report: report({ enrolled: 2 }), selected: [axisVector(1, 1), axisVector(2, 2)], stats })
    expect(out).toMatchObject({ enrolled: 0, skipped: 'store_unavailable' })
    rmSync(path, { recursive: true }); writeFileSync(path, before)
    ;(speaker as unknown as { __installSpeakerRuntimeForTests: (r: unknown) => void }).__installSpeakerRuntimeForTests(fakeSpeakerRuntime())
    expect(speaker.readVoiceProfiles().profiles.find(p => p.name === 'Dana Reyes')?.embeddings).toHaveLength(1)
  })
})
