// The REAL enrollEmbedding / enrollEmbeddingsBatch / persistProfile against a real temp profile store.
// Only the sherpa runtime is a stand-in (fake-speaker-runtime.ts), so the dedup gate, the provenance
// eviction, the single batched write and the write-failure handling are the production code.
// Fictional names only: this file is in a public repository.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeSpeakerRuntime, type FakeSpeakerRuntime } from './__fixtures__/fake-speaker-runtime.js'

let dataDir = ''
let storeWrites = 0
let runtime: FakeSpeakerRuntime

/** A voice on lane `lane` with a distinct texture: samples with different textures are about 0.89 apart, equal textures are identical. */
function vec(lane: number, texture: number): Float32Array {
  const v = new Float32Array(192)
  for (let k = lane; k < 128; k += 4) v[k] = 100
  v[128 + (texture % 63)] = 200
  return v
}
const storePath = () => join(dataDir, 'voice-profiles.json')
// A REAL filesystem failure: the data directory stops accepting new files, so the store's temp-file-then-rename write
// fails with EACCES while the store itself stays readable. Root ignores the mode, so those tests skip there.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const refuseWrites = (): void => chmodSync(dataDir, 0o500)
const allowWrites = (): void => chmodSync(dataDir, 0o700)
const onDisk = () => JSON.parse(readFileSync(storePath(), 'utf-8')).profiles as Array<{ name: string; embeddings: number[][]; sources: string[] }>

function seed(name: string, sources: string[]): void {
  writeFileSync(storePath(), JSON.stringify({ profiles: [{ name, embeddings: sources.map((_, i) => Array.from(vec(0, 100 + i))), sources }] }))
}

async function lib() {
  vi.resetModules()
  storeWrites = 0
  vi.doMock('./atomic-fs.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('./atomic-fs.js')
    return {
      ...actual,
      durableAtomicWriteFileSync: (path: string, ...rest: unknown[]) => {
        if (String(path).endsWith('/voice-profiles.json')) storeWrites += 1
        return (actual.durableAtomicWriteFileSync as (...a: unknown[]) => unknown)(path, ...rest)
      },
    }
  })
  const speaker = await import('./speaker-embeddings.js')
  runtime = fakeSpeakerRuntime()
  speaker.__installSpeakerRuntimeForTests(runtime)
  return speaker
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cos-enroll-real-'))
  process.env.COS_DATA_DIR = dataDir
})
afterEach(() => {
  try { allowWrites() } catch { /* already gone */ }
  vi.resetModules()
  vi.doUnmock('./atomic-fs.js')
  delete process.env.COS_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

describe('enrollEmbedding, real store', () => {
  it('adds a sample with its provenance, and refuses a near duplicate', async () => {
    seed('Dana Reyes', ['manual'])
    const speaker = await lib()
    expect(speaker.enrollEmbedding('Dana Reyes', vec(0, 7), 'correction:meeting_a').success).toBe(true)
    expect(speaker.enrollEmbedding('Dana Reyes', vec(0, 7), 'correction:meeting_b')).toMatchObject({ success: false, error: expect.stringContaining('Too similar') })
    expect(onDisk()[0].sources).toEqual(['manual', 'correction:meeting_a'])
  })

  it.skipIf(isRoot)('W8: a write the disk refuses is reported as a failure, not success, and leaves memory and the manager as the disk is', async () => {
    seed('Dana Reyes', ['manual', 'g2-training'])
    const speaker = await lib()
    expect(speaker.readVoiceProfiles().profiles[0].embeddings).toHaveLength(2) // primes the in-memory cache
    refuseWrites()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = speaker.enrollEmbedding('Dana Reyes', vec(0, 7), 'manual')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Profile store write failed')
    } finally { errors.mockRestore(); allowWrites() }
    // No runtime reinstall here: that would drop the cache and hide a cache that kept the failed sample.
    expect(onDisk()[0].embeddings).toHaveLength(2)
    expect(speaker.readVoiceProfiles().profiles[0].embeddings).toHaveLength(2)
    expect(runtime.speakers.has('Dana Reyes')).toBe(true)
  })

  it.skipIf(isRoot)('W8: the force-add path (the name is already in the manager) reports a refused disk write too', async () => {
    seed('Dana Reyes', ['manual'])
    const speaker = await lib()
    expect(speaker.enrollEmbedding('Dana Reyes', vec(0, 7), 'manual').success).toBe(true) // registers the name in the manager
    refuseWrites()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = speaker.enrollEmbedding('Dana Reyes', vec(0, 9), 'manual') // manager.add is false now: persist, then rebuild
      expect(result.success).toBe(false)
      expect(result.error).toContain('Profile store write failed')
    } finally { errors.mockRestore(); allowWrites() }
    expect(speaker.readVoiceProfiles().profiles[0].embeddings).toHaveLength(2)
    expect(onDisk()[0].embeddings).toHaveLength(2)
  })

  it.skipIf(isRoot)('W8: the same failure for a NEW name leaves no phantom speaker in the manager', async () => {
    seed('Dana Reyes', ['manual'])
    const speaker = await lib()
    speaker.readVoiceProfiles()
    refuseWrites()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try { expect(speaker.enrollEmbedding('Casey Lin', vec(1, 3), 'manual').success).toBe(false) } finally { errors.mockRestore(); allowWrites() }
    expect(runtime.manager.contains('Casey Lin')).toBe(false)
  })

  it('a Mac-assigned sample cannot take a slot in a full profile of other evidence', async () => {
    seed('Dana Reyes', [...Array(20).fill('correction:m'), ...Array(20).fill('g2-training')])
    const speaker = await lib()
    const before = onDisk()[0].sources
    const result = speaker.enrollEmbedding('Dana Reyes', vec(0, 400), 'mac-assign:mac_x')
    expect(result.success).toBe(false)
    expect(result.error).toContain('no Mac-assigned sample to replace')
    expect(onDisk()[0].sources).toEqual(before)
  })

  it('a G2 correction into a full profile evicts a Mac-assigned sample before an older g2-training one', async () => {
    seed('Dana Reyes', ['g2-training', 'mac-assign:mac_x', ...Array(38).fill('g2-training')])
    const speaker = await lib()
    expect(speaker.enrollEmbedding('Dana Reyes', vec(0, 400), 'correction:meeting_a').success).toBe(true)
    const sources = onDisk()[0].sources
    expect(sources).toHaveLength(40)
    expect(sources.some(s => s.startsWith('mac-assign:'))).toBe(false)
    expect(sources[39]).toBe('correction:meeting_a')
  })
})

describe('enrollEmbeddingsBatch, real store', () => {
  it('writes the store ONCE for many samples; per-sample enrolment writes once each', async () => {
    seed('Dana Reyes', ['manual'])
    const speaker = await lib()
    const items = Array.from({ length: 8 }, (_, i) => ({ embedding: vec(0, i + 1), source: 'mac-assign:mac_x' }))
    const result = speaker.enrollEmbeddingsBatch('Dana Reyes', items)
    expect(result).toMatchObject({ enrolled: 8, declined: 0, persisted: true })
    expect(storeWrites).toBe(1)
    expect(onDisk()[0].embeddings).toHaveLength(9)

    seed('Casey Lin', ['manual'])
    const other = await lib()
    for (let i = 0; i < 8; i++) other.enrollEmbedding('Casey Lin', vec(0, i + 1), 'manual')
    expect(storeWrites).toBe(8)
  })

  it('applies the real dedup gate, within the batch and against the stored samples', async () => {
    seed('Dana Reyes', ['manual']) // stored texture 100
    const speaker = await lib()
    const result = speaker.enrollEmbeddingsBatch('Dana Reyes', [
      { embedding: vec(0, 100), source: 'mac-assign:mac_x' }, // identical to the stored one
      { embedding: vec(0, 5), source: 'mac-assign:mac_x' },
      { embedding: vec(0, 5), source: 'mac-assign:mac_x' }, // identical to the one just added
    ])
    expect(result).toMatchObject({ enrolled: 1, declined: 2, persisted: true })
  })

  it('caps Mac-assigned samples at ten per profile by replacing the oldest of them, and touches nothing else', async () => {
    seed('Dana Reyes', ['correction:m', 'g2-training', ...Array.from({ length: 10 }, (_, i) => `mac-assign:old${i}`)])
    const speaker = await lib()
    const result = speaker.enrollEmbeddingsBatch('Dana Reyes', Array.from({ length: 3 }, (_, i) => ({ embedding: vec(0, i + 1), source: 'mac-assign:new' })))
    expect(result.enrolled).toBe(3)
    const sources = onDisk()[0].sources
    expect(sources).toHaveLength(12)
    expect(sources.slice(0, 2)).toEqual(['correction:m', 'g2-training'])
    expect(sources.filter(s => s === 'mac-assign:new')).toHaveLength(3)
    expect(sources.filter(s => s.startsWith('mac-assign:old'))).toHaveLength(7)
    expect(sources).not.toContain('mac-assign:old0')
  })

  it('into a full profile with nothing to replace: declined, no write at all', async () => {
    seed('Dana Reyes', Array(40).fill('g2-training'))
    const speaker = await lib()
    const result = speaker.enrollEmbeddingsBatch('Dana Reyes', [{ embedding: vec(0, 7), source: 'mac-assign:mac_x' }])
    expect(result).toMatchObject({ enrolled: 0, declined: 1, persisted: true })
    expect(storeWrites).toBe(0)
  })

  it.skipIf(isRoot)('a refused write is reported, enrolled is 0, and nothing from the batch remains in memory', async () => {
    seed('Dana Reyes', ['manual'])
    const speaker = await lib()
    speaker.readVoiceProfiles()
    refuseWrites()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let result
    try { result = speaker.enrollEmbeddingsBatch('Dana Reyes', [{ embedding: vec(0, 7), source: 'mac-assign:mac_x' }, { embedding: vec(0, 8), source: 'mac-assign:mac_x' }]) } finally { errors.mockRestore(); allowWrites() }
    expect(result).toMatchObject({ enrolled: 0, persisted: false })
    expect(result.error).toContain('Profile store write failed')
    expect(onDisk()[0].embeddings).toHaveLength(1)
    // No runtime reinstall: the in-memory store must already agree with the disk it failed to write.
    expect(speaker.readVoiceProfiles().profiles[0].embeddings).toHaveLength(1)
  })

  it('refuses an unknown profile and a missing runtime without writing', async () => {
    seed('Dana Reyes', ['manual'])
    const speaker = await lib()
    expect(speaker.enrollEmbeddingsBatch('Nobody Known', [{ embedding: vec(0, 1), source: 'mac-assign:x' }])).toMatchObject({ enrolled: 0, persisted: false })
    speaker.__installSpeakerRuntimeForTests(null)
    expect(speaker.enrollEmbeddingsBatch('Dana Reyes', [{ embedding: vec(0, 1), source: 'mac-assign:x' }])).toMatchObject({ enrolled: 0, persisted: false })
    expect(storeWrites).toBe(0)
  })
})

// The store can also ANSWER that it did not write (saveVoiceProfileStore returns written: false, e.g. it refuses to
// overwrite a populated file with an empty one). That is a documented return of the real function, not an invented throw.
describe('a store that refuses the write by returning written:false', () => {
  async function libRefusing() {
    vi.resetModules()
    vi.doMock('./voice-profile-store.js', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('./voice-profile-store.js')
      return { ...actual, saveVoiceProfileStore: () => ({ written: false, backup: null, refusedReason: 'refusing to overwrite 1 stored profile(s) with an empty store' }) }
    })
    const speaker = await import('./speaker-embeddings.js')
    runtime = fakeSpeakerRuntime()
    speaker.__installSpeakerRuntimeForTests(runtime)
    return speaker
  }
  afterEach(() => { vi.doUnmock('./voice-profile-store.js') })

  it('enrollEmbedding does not report success', async () => {
    seed('Dana Reyes', ['manual'])
    const speaker = await libRefusing()
    speaker.readVoiceProfiles()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try { expect(speaker.enrollEmbedding('Dana Reyes', vec(0, 7), 'manual')).toMatchObject({ success: false, error: expect.stringContaining('Profile store write failed') }) } finally { errors.mockRestore() }
    expect(speaker.readVoiceProfiles().profiles[0].embeddings).toHaveLength(1)
  })

  it('the force-add path does not report success either', async () => {
    seed('Dana Reyes', ['manual'])
    const speaker = await libRefusing()
    runtime.manager.add({ name: 'Dana Reyes', v: vec(0, 1) }) // the name is already registered, so manager.add is false
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try { expect(speaker.enrollEmbedding('Dana Reyes', vec(0, 7), 'manual').success).toBe(false) } finally { errors.mockRestore() }
    expect(speaker.readVoiceProfiles().profiles[0].embeddings).toHaveLength(1)
  })

  it('enrollEmbeddingsBatch reports persisted:false and enrolled 0, and the cache is the disk again', async () => {
    seed('Dana Reyes', ['manual'])
    const speaker = await libRefusing()
    speaker.readVoiceProfiles()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let result
    try { result = speaker.enrollEmbeddingsBatch('Dana Reyes', [{ embedding: vec(0, 7), source: 'mac-assign:mac_x' }, { embedding: vec(0, 8), source: 'mac-assign:mac_x' }]) } finally { errors.mockRestore() }
    expect(result).toMatchObject({ enrolled: 0, persisted: false })
    expect(result.error).toContain('Profile store write failed')
    expect(speaker.readVoiceProfiles().profiles[0].embeddings).toHaveLength(1)
  })
})
