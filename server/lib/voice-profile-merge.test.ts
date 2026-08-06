// Profile merging — two names, one voice.
//
// The safety property under test is that a WRONG merge is refused. A wrong merge
// destroys both identities at once and cannot be undone from the store alone, so
// the similarity floor is the only thing standing between "Luke H is Luke Henry"
// (0.843, correct) and "Miles Mallard is Miles" (a name heuristic, catastrophic).
//
// Both layers are exercised by execution: the pure store functions directly, and
// mergeSpeakerProfiles against a real seeded voice-profiles.json under an
// isolated COS_DATA_DIR. No sherpa model is needed — the manager is absent, and
// its absence is itself part of the contract (the durable half must still land).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mergeProfilesInStore,
  profileCentroid,
  profileSimilarity,
  rowCosine,
  selectDiverseIndices,
  type ProfileStore,
  type VoiceProfile,
} from './voice-profile-store.js'

/** Rows clustered tightly around a direction, so two clusters can be made
 *  deliberately similar (same person) or orthogonal (different people). */
function cluster(seedAxis: number, count: number, jitter = 0.05, dim = 8): number[][] {
  return Array.from({ length: count }, (_, k) => {
    const row = new Array<number>(dim).fill(0)
    row[seedAxis] = 1
    row[(seedAxis + 1) % dim] = jitter * (k + 1)
    row[(seedAxis + 2) % dim] = jitter * ((k % 3) - 1)
    return row
  })
}

function profile(name: string, embeddings: number[][], source = 'manual'): VoiceProfile {
  return { name, embeddings, sources: embeddings.map((_, i) => `${source}-${i}`) }
}

describe('similarity is measured, never inferred from names', () => {
  it('scores two clusters of the same voice high', () => {
    const a = profile('Luke Henry', cluster(0, 20))
    const b = profile('Luke H', cluster(0, 20, 0.08))
    expect(profileSimilarity(a, b)).toBeGreaterThan(0.9)
  })

  it('scores two different voices below the accept floor', () => {
    const a = profile('Nate Williams', cluster(0, 20))
    const b = profile('Nate Winne', cluster(4, 20))
    expect(profileSimilarity(a, b)).toBeLessThan(0.55)
  })

  it('centroid is L2-normalized and dimension-safe', () => {
    const c = profileCentroid([...cluster(0, 5), [1, 2]])   // one wrong-length row
    expect(c).toHaveLength(8)
    expect(Math.sqrt(c.reduce((s, v) => s + v * v, 0))).toBeCloseTo(1, 6)
  })

  it('returns 0 rather than throwing on empty or mismatched input', () => {
    expect(profileCentroid([])).toEqual([])
    expect(rowCosine([], [])).toBe(0)
    expect(rowCosine([1, 2, 3], [1, 2])).toBe(0)
    expect(profileSimilarity(profile('A', []), profile('B', cluster(0, 3)))).toBe(0)
  })
})

describe('diversity selection decides WHICH samples survive the cap', () => {
  it('returns everything when under the cap', () => {
    expect(selectDiverseIndices(cluster(0, 5), 20)).toEqual([0, 1, 2, 3, 4])
  })

  it('keeps exactly the cap, in ascending order', () => {
    const picked = selectDiverseIndices([...cluster(0, 20), ...cluster(1, 20)], 20)
    expect(picked).toHaveLength(20)
    expect([...picked].sort((a, b) => a - b)).toEqual(picked)
    expect(new Set(picked).size).toBe(20)
  })

  it('draws from BOTH source profiles rather than keeping one whole', () => {
    // Taking the first 20 would keep profile A entirely and discard every sample
    // of B — the opposite of what merging is for, and invisible in a count.
    const merged = [...cluster(0, 20), ...cluster(4, 20)]
    const picked = selectDiverseIndices(merged, 20)
    const fromA = picked.filter(i => i < 20).length
    const fromB = picked.filter(i => i >= 20).length
    expect(fromA).toBeGreaterThan(3)
    expect(fromB).toBeGreaterThan(3)
  })
})

describe('merging in the store', () => {
  it('combines samples, keeps sources aligned, and removes the absorbed profile', () => {
    const store: ProfileStore = {
      profiles: [profile('Luke Henry', cluster(0, 8), 'fireflies'), profile('Luke H', cluster(0, 6, 0.07), 'g2-training')],
    }
    const out = mergeProfilesInStore(store, 'Luke Henry', ['Luke H'], { cap: 20 })

    expect(out.mergedFrom).toEqual(['Luke H'])
    expect(out.samplesBefore).toBe(8)
    expect(out.samplesAfter).toBe(14)
    expect(out.droppedToCap).toBe(0)
    expect(store.profiles.map(p => p.name)).toEqual(['Luke Henry'])
    const target = store.profiles[0]
    expect(target.sources).toHaveLength(target.embeddings.length)
  })

  it('PRESERVES original provenance instead of restamping it', () => {
    // Per-source retraction is what makes a poisoned auto:<sessionId> sample
    // removable later. Overwriting it with a bookkeeping label would trade a
    // useful fact for a useless one.
    const store: ProfileStore = {
      profiles: [
        profile('Luke Henry', cluster(0, 3), 'fireflies'),
        { name: 'Luke H', embeddings: cluster(0, 2, 0.06), sources: ['auto:sess-77', 'manual'] },
      ],
    }
    mergeProfilesInStore(store, 'Luke Henry', ['Luke H'], { cap: 20 })
    const sources = store.profiles[0].sources!
    expect(sources).toContain('auto:sess-77')
    expect(sources.some(s => s.startsWith('merged'))).toBe(false)
  })

  it('caps the union and reports what the CAP dropped, not the merge', () => {
    const store: ProfileStore = {
      profiles: [profile('Luke Henry', cluster(0, 20)), profile('Luke H', cluster(0, 20, 0.09))],
    }
    const out = mergeProfilesInStore(store, 'Luke Henry', ['Luke H'], { cap: 20 })
    expect(out.samplesAfter).toBe(20)
    expect(out.droppedToCap).toBe(20)
    expect(store.profiles[0].sources).toHaveLength(20)
  })

  it('the CAPPED survivors come from BOTH profiles, not the first one whole', () => {
    // Taking the first `cap` indices keeps the target intact and discards every
    // absorbed sample — the counts look identical and the merge accomplishes
    // nothing. Provenance prefixes make the split visible.
    const store: ProfileStore = {
      profiles: [
        profile('Luke Henry', cluster(0, 20), 'fireflies'),
        profile('Luke H', cluster(4, 20), 'g2-training'),
      ],
    }
    mergeProfilesInStore(store, 'Luke Henry', ['Luke H'], { cap: 20 })
    const sources = store.profiles[0].sources!
    const fromTarget = sources.filter(x => x.startsWith('fireflies')).length
    const fromAbsorbed = sources.filter(x => x.startsWith('g2-training')).length
    expect(fromTarget).toBeGreaterThan(3)
    expect(fromAbsorbed).toBeGreaterThan(3)
    expect(fromTarget + fromAbsorbed).toBe(20)
  })

  it('realigns a SHORT target sources[] before absorbing', () => {
    // Without the pre-pad, the absorbed provenance lands at the wrong indices
    // and every later per-source retraction removes the wrong samples.
    const store: ProfileStore = {
      profiles: [
        { name: 'Luke Henry', embeddings: cluster(0, 5), sources: ['fireflies', 'fireflies'] },
        profile('Luke H', cluster(0, 3, 0.06), 'g2'),
      ],
    }
    mergeProfilesInStore(store, 'Luke Henry', ['Luke H'], { cap: 20 })
    const target = store.profiles[0]
    expect(target.embeddings).toHaveLength(8)
    expect(target.sources).toHaveLength(8)
    // The three absorbed samples keep their own provenance, at the END.
    expect(target.sources!.slice(5)).toEqual(['g2-0', 'g2-1', 'g2-2'])
  })

  it('records similarity per absorbed profile', () => {
    const store: ProfileStore = {
      profiles: [profile('A', cluster(0, 5)), profile('B', cluster(0, 5, 0.06)), profile('C', cluster(4, 5))],
    }
    const out = mergeProfilesInStore(store, 'A', ['B', 'C'], { cap: 20 })
    expect(Object.keys(out.similarity).sort()).toEqual(['B', 'C'])
    expect(out.similarity.B).toBeGreaterThan(out.similarity.C)
  })

  it('reports a missing name without touching anything', () => {
    const store: ProfileStore = { profiles: [profile('A', cluster(0, 4))] }
    const out = mergeProfilesInStore(store, 'A', ['Ghost'], { cap: 20 })
    expect(out.missing).toEqual(['Ghost'])
    expect(out.mergedFrom).toEqual([])
    expect(store.profiles[0].embeddings).toHaveLength(4)
  })

  it('is a no-op when the target does not exist', () => {
    const store: ProfileStore = { profiles: [profile('A', cluster(0, 4))] }
    const out = mergeProfilesInStore(store, 'Nobody', ['A'], { cap: 20 })
    expect(out.mergedFrom).toEqual([])
    expect(store.profiles).toHaveLength(1)
  })

  it('ignores a self-merge instead of deleting the target', () => {
    const store: ProfileStore = { profiles: [profile('A', cluster(0, 4))] }
    const out = mergeProfilesInStore(store, 'A', ['A'], { cap: 20 })
    expect(out.mergedFrom).toEqual([])
    expect(store.profiles.map(p => p.name)).toEqual(['A'])
    expect(store.profiles[0].embeddings).toHaveLength(4)
  })
})

describe('mergeSpeakerProfiles enforces the floor against a real store file', () => {
  let dir = ''
  let storePath = ''
  let merge: typeof import('./speaker-embeddings.js').mergeSpeakerProfiles
  let floor = 0

  function seed(profiles: VoiceProfile[]): void {
    writeFileSync(storePath, JSON.stringify({ profiles }))
  }
  function readStore(): ProfileStore {
    return JSON.parse(readFileSync(storePath, 'utf-8')) as ProfileStore
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cos-merge-'))
    storePath = join(dir, 'voice-profiles.json')
    process.env.COS_DATA_DIR = dir
    // data-dir.ts resolves DATA_DIR at module scope, and speaker-embeddings
    // caches the store in a module-level variable — so the module graph must be
    // reset per test or the second test reads the first test's temp dir.
    vi.resetModules()
    const mod = await import('./speaker-embeddings.js')
    merge = mod.mergeSpeakerProfiles
    floor = mod.MERGE_SIMILARITY_FLOOR
  })
  afterEach(() => {
    vi.resetModules()
    delete process.env.COS_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('merges a genuine duplicate and persists it', () => {
    seed([profile('Luke Henry', cluster(0, 8)), profile('Luke H', cluster(0, 6, 0.07))])
    const report = merge('Luke Henry', ['Luke H'])
    expect(report.merged).toEqual(['Luke H'])
    expect(report.similarity['Luke H']).toBeGreaterThan(floor)
    expect(report.samplesAfter).toBe(14)
    // Durable, not just in memory — and written even with no sherpa manager.
    expect(readStore().profiles.map(p => p.name)).toEqual(['Luke Henry'])
  })

  it('REFUSES two different voices and changes nothing on disk', () => {
    seed([profile('Nate Williams', cluster(0, 8)), profile('Nate Winne', cluster(4, 8))])
    const report = merge('Nate Williams', ['Nate Winne'])
    expect(report.merged).toEqual([])
    expect(report.refused?.[0].name).toBe('Nate Winne')
    expect(report.refused?.[0].similarity).toBeLessThan(floor)
    expect(readStore().profiles.map(p => p.name).sort()).toEqual(['Nate Williams', 'Nate Winne'])
  })

  it('force overrides the floor, for when Miles knows what the audio does not', () => {
    seed([profile('Nate Williams', cluster(0, 8)), profile('Nate Winne', cluster(4, 8))])
    const report = merge('Nate Williams', ['Nate Winne'], { force: true })
    expect(report.merged).toEqual(['Nate Winne'])
    expect(readStore().profiles).toHaveLength(1)
  })

  it('dryRun reports the real numbers and mutates NEITHER disk nor the cache', () => {
    seed([profile('Luke Henry', cluster(0, 8)), profile('Luke H', cluster(0, 6, 0.07))])
    const before = readFileSync(storePath, 'utf-8')
    const report = merge('Luke Henry', ['Luke H'], { dryRun: true })
    expect(report.merged).toEqual(['Luke H'])
    expect(report.samplesAfter).toBe(14)
    expect(readFileSync(storePath, 'utf-8')).toBe(before)

    // The in-memory store is the subtler half: a preview that merged the cached
    // copy would leave the process believing in a merge that was never
    // persisted, and the next real write would commit it silently.
    const second = merge('Luke Henry', ['Luke H'], { dryRun: true })
    expect(second.samplesBefore).toBe(8)
    expect(second.merged).toEqual(['Luke H'])
  })

  it('a mixed batch merges the eligible and refuses the rest in one report', () => {
    seed([
      profile('Luke Henry', cluster(0, 6)),
      profile('Luke H', cluster(0, 5, 0.07)),
      profile('Luke Marr', cluster(4, 5)),
    ])
    const report = merge('Luke Henry', ['Luke H', 'Luke Marr'])
    expect(report.merged).toEqual(['Luke H'])
    expect(report.refused?.map(r => r.name)).toEqual(['Luke Marr'])
    expect(readStore().profiles.map(p => p.name).sort()).toEqual(['Luke Henry', 'Luke Marr'])
  })

  it('the floor is the search-accept threshold, not a looser invented number', () => {
    expect(floor).toBe(0.55)
  })
})
