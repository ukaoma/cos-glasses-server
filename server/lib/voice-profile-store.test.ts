// voice-profiles.json durability + integrity, exercised by execution.
//
// Every test here writes real files to a temp dir and calls the real functions.
// Source-shape assertions were deliberately avoided: the failures this guards
// against (a torn write, a load that returns empty and is then committed over
// the only copy, a sources[] that drifts one index at a time) are all runtime
// behaviours that a grep for a string cannot observe.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendEmbedding,
  backupDirFor,
  backupProfileStore,
  deleteProfileFromStore,
  describeRepairs,
  dropOldestEmbedding,
  hasRepairs,
  listProfileStoreBackups,
  loadVoiceProfileStore,
  modalDimension,
  normalizeProfileStore,
  PROFILE_STORE_BACKUP_KEEP,
  removeEmbeddingsBySource,
  saveVoiceProfileStore,
  type ProfileStore,
  type VoiceProfile,
} from './voice-profile-store.js'

let dir: string
let storePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cos-voice-store-'))
  storePath = join(dir, 'voice-profiles.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** A dim-4 row so the fixtures stay readable; production is 192. */
function row(seed: number, dim = 4): number[] {
  return Array.from({ length: dim }, (_, i) => seed + i / 10)
}

function profile(name: string, count: number, sources?: unknown): VoiceProfile {
  return {
    name,
    embeddings: Array.from({ length: count }, (_, i) => row(i + 1)),
    sources: sources as string[] | undefined,
  }
}

describe('sources[] stays aligned with embeddings', () => {
  it('pads a short sources[] and reports the realignment', () => {
    // The live store shape: 3 embeddings, 1 source. Every provenance lookup
    // past index 0 was reading the wrong sample.
    const { store, repairs } = normalizeProfileStore({
      profiles: [profile('Clem Ukaoma', 3, ['manual'])],
    })
    expect(store.profiles[0].embeddings).toHaveLength(3)
    expect(store.profiles[0].sources).toEqual(['manual', 'unknown', 'unknown'])
    expect(repairs.sourcesRealigned).toBe(1)
    expect(hasRepairs(repairs)).toBe(true)
  })

  it('truncates a long sources[]', () => {
    const { store, repairs } = normalizeProfileStore({
      profiles: [profile('Justin', 2, ['manual', 'fireflies', 'g2-training', 'auto:x'])],
    })
    expect(store.profiles[0].sources).toEqual(['manual', 'fireflies'])
    expect(repairs.sourcesRealigned).toBe(1)
  })

  it('coerces a null slot rather than shifting every later source by one', () => {
    // A null WAS found inside a live sources array. Filtering it out would
    // silently re-map source[2] onto embedding[1].
    const { store, repairs } = normalizeProfileStore({
      profiles: [profile('Nate Williams', 3, ['manual', null, 'auto:s1'])],
    })
    expect(store.profiles[0].sources).toEqual(['manual', 'unknown', 'auto:s1'])
    expect(repairs.sourcesCoerced).toBe(1)
    // Alignment itself was fine — lengths matched.
    expect(repairs.sourcesRealigned).toBe(0)
  })

  it('drops an unusable embedding row AND its source together', () => {
    const { store, repairs } = normalizeProfileStore({
      profiles: [{
        name: 'Joe Karbowski',
        embeddings: [row(1), 'not-an-embedding' as unknown as number[], row(3)],
        sources: ['manual', 'bad', 'g2-training'],
      }],
    })
    expect(store.profiles[0].embeddings).toHaveLength(2)
    // 'bad' must go with the row it described, or 'g2-training' would land on
    // the wrong sample.
    expect(store.profiles[0].sources).toEqual(['manual', 'g2-training'])
    expect(repairs.embeddingsDropped).toBe(1)
  })

  it('treats a missing sources[] as a realignment, not silence', () => {
    const { repairs } = normalizeProfileStore({
      profiles: [{ name: 'A', embeddings: [row(1), row(2)] }],
    })
    expect(repairs.sourcesRealigned).toBe(1)
  })

  it('drops NaN/Infinity rows — they poison every centroid they average into', () => {
    const { store, repairs } = normalizeProfileStore({
      profiles: [{ name: 'A', embeddings: [row(1), [1, NaN, 3, 4], [1, Infinity, 3, 4]] }],
    })
    expect(store.profiles[0].embeddings).toHaveLength(1)
    expect(repairs.embeddingsDropped).toBe(2)
  })

  it('merges duplicate profile names instead of stranding the later rows', () => {
    // The manager holds ONE vector per name, so a second profile with the same
    // name was simply invisible.
    const { store, repairs } = normalizeProfileStore({
      profiles: [profile('MU', 2, ['manual', 'manual']), profile('MU', 3, ['fireflies', 'fireflies', 'fireflies'])],
    })
    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0].embeddings).toHaveLength(5)
    expect(store.profiles[0].sources).toHaveLength(5)
    expect(repairs.profilesDropped).toBe(1)
  })

  it('skips nameless entries and survives a non-store shape', () => {
    expect(normalizeProfileStore({ profiles: [{ name: '   ', embeddings: [] }] }).repairs.profilesDropped).toBe(1)
    expect(normalizeProfileStore(null).store.profiles).toEqual([])
    expect(normalizeProfileStore({ profiles: 'nope' }).store.profiles).toEqual([])
  })

  it('describeRepairs names what happened', () => {
    const { repairs } = normalizeProfileStore({ profiles: [profile('A', 3, ['manual', null])] })
    expect(describeRepairs(repairs)).toMatch(/misaligned sources/)
  })
})

describe('modal dimension, not row zero', () => {
  it('picks the majority dimension even when row 0 is the corrupt one', () => {
    // embeddings[0].length would declare 2 the truth and mark all 192-dim rows
    // as mismatches, emptying the profile.
    expect(modalDimension([row(1, 2), row(2, 192), row(3, 192)])).toBe(192)
  })

  it('flags mismatched rows but keeps them on disk', () => {
    const { store, repairs } = normalizeProfileStore({
      profiles: [{ name: 'A', embeddings: [row(1, 192), row(2, 192), row(3, 64)] }],
    })
    expect(repairs.dimensionMismatch).toBe(1)
    expect(store.profiles[0].embeddings).toHaveLength(3)   // nothing deleted
  })
})

describe('FIFO eviction keeps both arrays in lockstep', () => {
  it('drops the oldest source with the oldest embedding', () => {
    const p = profile('A', 3, ['first', 'second', 'third'])
    expect(dropOldestEmbedding(p).droppedSource).toBe('first')
    expect(p.embeddings).toHaveLength(2)
    expect(p.sources).toEqual(['second', 'third'])
  })

  it('does not desync when sources is undefined — the original bug', () => {
    // `embeddings.shift()` then `sources?.shift()`: the second call no-ops, so
    // from here on source[i] describes embedding[i+1] forever.
    const p: VoiceProfile = { name: 'A', embeddings: [row(1), row(2), row(3)] }
    dropOldestEmbedding(p)
    expect(p.embeddings).toHaveLength(2)
    expect(p.sources).toHaveLength(2)
  })

  it('does not desync when sources is shorter than embeddings', () => {
    const p = profile('A', 3, ['only-one'])
    dropOldestEmbedding(p)
    expect(p.sources).toHaveLength(p.embeddings.length)
  })

  it('is a no-op on an empty profile', () => {
    const p: VoiceProfile = { name: 'A', embeddings: [], sources: [] }
    expect(dropOldestEmbedding(p).droppedSource).toBeNull()
  })

  it('append keeps lengths equal even from a desynced start', () => {
    const p = profile('A', 3, [])
    appendEmbedding(p, row(9), 'correction:m1')
    expect(p.embeddings).toHaveLength(4)
    expect(p.sources).toHaveLength(4)
    expect(p.sources!.at(-1)).toBe('correction:m1')
  })
})

describe('per-source retraction', () => {
  it('removes only the matching provenance and returns the count', () => {
    const p = profile('Clem Ukaoma', 4, ['manual', 'auto:s1', 'auto:s1', 'fireflies'])
    expect(removeEmbeddingsBySource(p, s => s.startsWith('auto:'))).toBe(2)
    expect(p.embeddings).toHaveLength(2)
    expect(p.sources).toEqual(['manual', 'fireflies'])
  })

  it('removes nothing when nothing matches', () => {
    const p = profile('A', 2, ['manual', 'manual'])
    expect(removeEmbeddingsBySource(p, s => s === 'auto:x')).toBe(0)
    expect(p.embeddings).toHaveLength(2)
  })
})

describe('saving is atomic, backed up, and cannot zero the store', () => {
  it('writes a readable store and no leftover temp files', () => {
    const store: ProfileStore = { profiles: [profile('A', 2, ['manual', 'manual'])] }
    expect(saveVoiceProfileStore(storePath, store).written).toBe(true)
    expect(JSON.parse(readFileSync(storePath, 'utf-8')).profiles).toHaveLength(1)
    const leftovers = require('node:fs').readdirSync(dir).filter((f: string) => f.includes('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('REFUSES to overwrite a populated store with an empty one', () => {
    // This is the catastrophic path: a failed load returns {profiles: []} and a
    // routine save then durably commits it over months of training.
    saveVoiceProfileStore(storePath, { profiles: [profile('A', 3, ['m', 'm', 'm'])] })
    const result = saveVoiceProfileStore(storePath, { profiles: [] })
    expect(result.written).toBe(false)
    expect(result.refusedReason).toMatch(/refusing to overwrite 1 stored profile/)
    expect(JSON.parse(readFileSync(storePath, 'utf-8')).profiles).toHaveLength(1)
  })

  it('allows an intentional reset via allowEmpty', () => {
    saveVoiceProfileStore(storePath, { profiles: [profile('A', 1, ['m'])] })
    expect(saveVoiceProfileStore(storePath, { profiles: [] }, { allowEmpty: true }).written).toBe(true)
    expect(JSON.parse(readFileSync(storePath, 'utf-8')).profiles).toEqual([])
  })

  it('writes an empty store happily when there is nothing to lose', () => {
    expect(saveVoiceProfileStore(storePath, { profiles: [] }).written).toBe(true)
  })

  it('takes a backup before the first overwrite, then throttles', () => {
    const t0 = 1_000_000_000_000
    saveVoiceProfileStore(storePath, { profiles: [profile('A', 1, ['m'])] }, { nowMs: t0 })
    expect(listProfileStoreBackups(storePath)).toHaveLength(0)   // nothing existed to back up

    const second = saveVoiceProfileStore(storePath, { profiles: [profile('A', 2, ['m', 'm'])] }, { nowMs: t0 + 1000 })
    expect(second.backup).not.toBeNull()
    expect(listProfileStoreBackups(storePath)).toHaveLength(1)
    // The backup holds the PREVIOUS content, which is the point.
    expect(JSON.parse(readFileSync(second.backup!, 'utf-8')).profiles[0].embeddings).toHaveLength(1)

    // A save moments later must not copy 7.8 MB again.
    const third = saveVoiceProfileStore(storePath, { profiles: [profile('A', 3, ['m', 'm', 'm'])] }, { nowMs: t0 + 2000 })
    expect(third.backup).toBeNull()
    expect(listProfileStoreBackups(storePath)).toHaveLength(1)
  })

  it('prunes to the keep limit', () => {
    saveVoiceProfileStore(storePath, { profiles: [profile('A', 1, ['m'])] })
    for (let i = 0; i < PROFILE_STORE_BACKUP_KEEP + 3; i++) {
      backupProfileStore(storePath, { force: true, nowMs: 1_700_000_000_000 + i * 60_000 })
    }
    expect(listProfileStoreBackups(storePath).length).toBeLessThanOrEqual(PROFILE_STORE_BACKUP_KEEP)
  })

  it('never backs up a zero-byte or absent file', () => {
    expect(backupProfileStore(storePath, { force: true })).toBeNull()
    writeFileSync(storePath, '')
    expect(backupProfileStore(storePath, { force: true })).toBeNull()
  })

  it('does not let a failed backup block the write', () => {
    saveVoiceProfileStore(storePath, { profiles: [profile('A', 1, ['m'])] })
    // A FILE where the backup directory belongs makes mkdirSync throw.
    writeFileSync(backupDirFor(storePath), 'in the way')
    const result = saveVoiceProfileStore(storePath, { profiles: [profile('A', 2, ['m', 'm'])] }, { nowMs: Date.now() + 7_200_000 })
    expect(result.backup).toBeNull()
    expect(result.written).toBe(true)
    expect(JSON.parse(readFileSync(storePath, 'utf-8')).profiles[0].embeddings).toHaveLength(2)
  })
})

describe('loading distinguishes missing, ok, and corrupt', () => {
  it('missing is silent and normal', () => {
    const load = loadVoiceProfileStore(storePath)
    expect(load.status).toBe('missing')
    expect(load.store.profiles).toEqual([])
  })

  it('ok returns the store and any repairs it had to make', () => {
    writeFileSync(storePath, JSON.stringify({ profiles: [profile('A', 2, ['manual'])] }))
    const load = loadVoiceProfileStore(storePath)
    expect(load.status).toBe('ok')
    expect(load.repairs.sourcesRealigned).toBe(1)
  })

  it('quarantines a corrupt file and RECOVERS from the newest backup', () => {
    saveVoiceProfileStore(storePath, { profiles: [profile('Miles', 4, ['m', 'm', 'm', 'm'])] })
    backupProfileStore(storePath, { force: true })
    writeFileSync(storePath, '{"profiles":[{"name":"Mil')      // truncated mid-write

    const load = loadVoiceProfileStore(storePath)
    expect(load.status).toBe('corrupt')
    expect(load.quarantinedAs).toBeTruthy()
    expect(load.recoveredFromBackup).toBeTruthy()
    expect(load.store.profiles[0].name).toBe('Miles')
    expect(load.store.profiles[0].embeddings).toHaveLength(4)
    expect(existsSync(load.quarantinedAs!)).toBe(true)          // evidence retained
  })

  it('skips an empty backup and keeps looking for a usable one', () => {
    saveVoiceProfileStore(storePath, { profiles: [profile('Miles', 2, ['m', 'm'])] })
    backupProfileStore(storePath, { force: true, nowMs: 1_000 })
    // A newer but useless backup must not win.
    const bdir = backupDirFor(storePath)
    mkdirSync(bdir, { recursive: true })
    writeFileSync(join(bdir, 'voice-profiles.9999-newest.json'), JSON.stringify({ profiles: [] }))
    writeFileSync(storePath, 'not json')

    const load = loadVoiceProfileStore(storePath)
    expect(load.status).toBe('corrupt')
    expect(load.store.profiles[0].name).toBe('Miles')
  })

  it('reports corrupt with no recovery when there is no backup at all', () => {
    writeFileSync(storePath, 'not json')
    const load = loadVoiceProfileStore(storePath)
    expect(load.status).toBe('corrupt')
    expect(load.recoveredFromBackup).toBeUndefined()
    expect(load.store.profiles).toEqual([])
  })
})

describe('delete-person is auditable', () => {
  it('returns per-store counts rather than a bare boolean', () => {
    const store: ProfileStore = {
      profiles: [profile('Clem Ukaoma', 14, undefined), profile('MU', 20, undefined)],
    }
    const result = deleteProfileFromStore(store, 'Clem Ukaoma')
    expect(result).toEqual({ removedProfiles: 1, removedEmbeddings: 14 })
    expect(store.profiles.map(p => p.name)).toEqual(['MU'])
  })

  it('reports zero for an unknown name', () => {
    const store: ProfileStore = { profiles: [profile('MU', 2, undefined)] }
    expect(deleteProfileFromStore(store, 'Nobody')).toEqual({ removedProfiles: 0, removedEmbeddings: 0 })
    expect(store.profiles).toHaveLength(1)
  })
})
