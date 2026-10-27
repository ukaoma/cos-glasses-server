// Profile merging — two names, one voice.
//
// The safety property under test is that a WRONG merge is refused. A wrong merge
// destroys both identities at once and cannot be undone from the store alone, so
// the similarity floor is the only thing standing between "Theo M is Theo Marsh"
// (0.843, correct) and "Jordan Mallard is Miles" (a name heuristic, catastrophic).
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
    const a = profile('Theo Marsh', cluster(0, 20))
    const b = profile('Theo M', cluster(0, 20, 0.08))
    expect(profileSimilarity(a, b)).toBeGreaterThan(0.9)
  })

  it('scores two different voices below the accept floor', () => {
    const a = profile('Nate Wells', cluster(0, 20))
    const b = profile('Nate Wynn', cluster(4, 20))
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
      profiles: [profile('Theo Marsh', cluster(0, 8), 'fireflies'), profile('Theo M', cluster(0, 6, 0.07), 'g2-training')],
    }
    const out = mergeProfilesInStore(store, 'Theo Marsh', ['Theo M'], { cap: 20 })

    expect(out.mergedFrom).toEqual(['Theo M'])
    expect(out.samplesBefore).toBe(8)
    expect(out.samplesAfter).toBe(14)
    expect(out.droppedToCap).toBe(0)
    expect(store.profiles.map(p => p.name)).toEqual(['Theo Marsh'])
    const target = store.profiles[0]
    expect(target.sources).toHaveLength(target.embeddings.length)
  })

  it('PRESERVES original provenance instead of restamping it', () => {
    // Per-source retraction is what makes a poisoned auto:<sessionId> sample
    // removable later. Overwriting it with a bookkeeping label would trade a
    // useful fact for a useless one.
    const store: ProfileStore = {
      profiles: [
        profile('Theo Marsh', cluster(0, 3), 'fireflies'),
        { name: 'Theo M', embeddings: cluster(0, 2, 0.06), sources: ['auto:sess-77', 'manual'] },
      ],
    }
    mergeProfilesInStore(store, 'Theo Marsh', ['Theo M'], { cap: 20 })
    const sources = store.profiles[0].sources!
    expect(sources).toContain('auto:sess-77')
    expect(sources.some(s => s.startsWith('merged'))).toBe(false)
  })

  describe('the merged profile obeys the Mac-assigned cap (6.93.0 polish)', () => {
    const macs = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `mac-assign:mac_${tag}${i}`)
    const isMac = (src: string | undefined) => (src ?? '').startsWith('mac-assign:')

    it('two profiles with ten Mac-assigned samples each do not merge to twenty: ten stay, the oldest go', () => {
      const store: ProfileStore = {
        profiles: [
          { name: 'Theo Marsh', embeddings: cluster(0, 15), sources: [...macs(10, 'a'), ...Array(5).fill('g2-training')] },
          { name: 'Theo M', embeddings: cluster(0, 15, 0.07), sources: [...macs(10, 'b'), ...Array(5).fill('g2-training')] },
        ],
      }
      const out = mergeProfilesInStore(store, 'Theo Marsh', ['Theo M'], { cap: 40 })
      const kept = store.profiles[0].sources!
      expect(kept.filter(isMac)).toHaveLength(10)
      expect(kept.filter(s => s === 'g2-training')).toHaveLength(10)
      // Oldest first: everything from the target's own list (a0..a9) goes before any of the absorbed list (b0..b9).
      expect(kept.filter(isMac)).toEqual(macs(10, 'b'))
      expect(out.samplesAfter).toBe(20)
      expect(out.droppedToCap).toBe(10)
      expect(store.profiles[0].embeddings).toHaveLength(kept.length)
    })

    it('never more Mac-assigned samples than the profile\'s other samples', () => {
      const store: ProfileStore = {
        profiles: [
          { name: 'Theo Marsh', embeddings: cluster(0, 3), sources: ['manual', 'g2-training', 'mac-assign:mac_a0'] },
          { name: 'Theo M', embeddings: cluster(0, 5, 0.07), sources: macs(5, 'b') },
        ],
      }
      const out = mergeProfilesInStore(store, 'Theo Marsh', ['Theo M'], { cap: 40 })
      const kept = store.profiles[0].sources!
      expect(kept.filter(isMac)).toHaveLength(2) // two other samples
      expect(kept.filter(s => !isMac(s))).toEqual(['manual', 'g2-training'])
      expect(out.samplesAfter).toBe(4)
      expect(out.droppedToCap).toBe(4)
    })

    it('under cap pressure a Mac-assigned sample ranks below even an auto: one', () => {
      const store: ProfileStore = {
        profiles: [
          { name: 'Theo Marsh', embeddings: cluster(0, 6), sources: macs(6, 'a') },
          { name: 'Theo M', embeddings: cluster(0, 6, 0.07), sources: Array.from({ length: 6 }, (_, i) => `auto:meeting_${i}`) },
        ],
      }
      mergeProfilesInStore(store, 'Theo Marsh', ['Theo M'], { cap: 8 })
      const kept = store.profiles[0].sources!
      expect(kept.filter(s => s.startsWith('auto:'))).toHaveLength(6)
      expect(kept.filter(isMac)).toHaveLength(2)
    })
  })

  it('caps the union and reports what the CAP dropped, not the merge', () => {
    const store: ProfileStore = {
      profiles: [profile('Theo Marsh', cluster(0, 20)), profile('Theo M', cluster(0, 20, 0.09))],
    }
    const out = mergeProfilesInStore(store, 'Theo Marsh', ['Theo M'], { cap: 20 })
    expect(out.samplesAfter).toBe(20)
    expect(out.droppedToCap).toBe(20)
    expect(store.profiles[0].sources).toHaveLength(20)
  })

  it('the capped survivors preserve stronger provenance before diversity', () => {
    const target = profile('Theo Marsh', cluster(0,20)); target.sources = target.embeddings.map(()=>'fireflies:x')
    const absorbed = profile('Theo M', cluster(4,20)); absorbed.sources = absorbed.embeddings.map(()=>'g2-training:y')
    const store: ProfileStore = { profiles: [target, absorbed] }
    mergeProfilesInStore(store, 'Theo Marsh', ['Theo M'], { cap:20 })
    expect(store.profiles[0].sources).toEqual(Array(20).fill('g2-training:y'))
  })

  it('realigns a SHORT target sources[] before absorbing', () => {
    // Without the pre-pad, the absorbed provenance lands at the wrong indices
    // and every later per-source retraction removes the wrong samples.
    const store: ProfileStore = {
      profiles: [
        { name: 'Theo Marsh', embeddings: cluster(0, 5), sources: ['fireflies', 'fireflies'] },
        profile('Theo M', cluster(0, 3, 0.06), 'g2'),
      ],
    }
    mergeProfilesInStore(store, 'Theo Marsh', ['Theo M'], { cap: 20 })
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
    seed([profile('Theo Marsh', cluster(0, 8)), profile('Theo M', cluster(0, 6, 0.07))])
    const report = merge('Theo Marsh', ['Theo M'])
    expect(report.merged).toEqual(['Theo M'])
    expect(report.similarity['Theo M']).toBeGreaterThan(floor)
    expect(report.samplesAfter).toBe(14)
    // Durable, not just in memory — and written even with no sherpa manager.
    expect(readStore().profiles.map(p => p.name)).toEqual(['Theo Marsh'])
  })

  it('REFUSES two different voices and changes nothing on disk', () => {
    seed([profile('Nate Wells', cluster(0, 8)), profile('Nate Wynn', cluster(4, 8))])
    const report = merge('Nate Wells', ['Nate Wynn'])
    expect(report.merged).toEqual([])
    expect(report.refused?.[0].name).toBe('Nate Wynn')
    expect(report.refused?.[0].similarity).toBeLessThan(floor)
    expect(readStore().profiles.map(p => p.name).sort()).toEqual(['Nate Wells', 'Nate Wynn'])
  })

  it('force overrides the floor, for when Miles knows what the audio does not', () => {
    seed([profile('Nate Wells', cluster(0, 8)), profile('Nate Wynn', cluster(4, 8))])
    const report = merge('Nate Wells', ['Nate Wynn'], { force: true })
    expect(report.merged).toEqual(['Nate Wynn'])
    expect(readStore().profiles).toHaveLength(1)
  })

  it('dryRun reports the real numbers and mutates NEITHER disk nor the cache', () => {
    seed([profile('Theo Marsh', cluster(0, 8)), profile('Theo M', cluster(0, 6, 0.07))])
    const before = readFileSync(storePath, 'utf-8')
    const report = merge('Theo Marsh', ['Theo M'], { dryRun: true })
    expect(report.merged).toEqual(['Theo M'])
    expect(report.samplesAfter).toBe(14)
    expect(readFileSync(storePath, 'utf-8')).toBe(before)

    // The in-memory store is the subtler half: a preview that merged the cached
    // copy would leave the process believing in a merge that was never
    // persisted, and the next real write would commit it silently.
    const second = merge('Theo Marsh', ['Theo M'], { dryRun: true })
    expect(second.samplesBefore).toBe(8)
    expect(second.merged).toEqual(['Theo M'])
  })

  it('a mixed batch merges the eligible and refuses the rest in one report', () => {
    seed([
      profile('Theo Marsh', cluster(0, 6)),
      profile('Theo M', cluster(0, 5, 0.07)),
      profile('Theo Quill', cluster(4, 5)),
    ])
    const report = merge('Theo Marsh', ['Theo M', 'Theo Quill'])
    expect(report.merged).toEqual(['Theo M'])
    expect(report.refused?.map(r => r.name)).toEqual(['Theo Quill'])
    expect(readStore().profiles.map(p => p.name).sort()).toEqual(['Theo Marsh', 'Theo Quill'])
  })

  it('the floor is the search-accept threshold, not a looser invented number', () => {
    expect(floor).toBe(0.55)
  })

  describe('a merge never leaves an empty profile (6.93.0 final)', () => {
    const macOnly = (name: string, n: number, tag: string, dither = 0.05): VoiceProfile => ({
      name,
      embeddings: cluster(0, n, dither),
      sources: Array.from({ length: n }, (_, i) => `mac-assign:mac_${tag}${i}`),
    })

    it('two profiles that hold only Mac samples are refused, on disk and in a preview', () => {
      seed([macOnly('Theo Marsh', 4, 'a'), macOnly('Theo M', 3, 'b', 0.07)])
      const before = readFileSync(storePath, 'utf-8')
      const preview = merge('Theo Marsh', ['Theo M'], { dryRun: true })
      expect(preview.refusal?.code).toBe('merge_would_empty_profile')
      expect(preview.merged).toEqual([])
      expect(readFileSync(storePath, 'utf-8')).toBe(before)

      const real = merge('Theo Marsh', ['Theo M'])
      expect(real.refusal?.code).toBe('merge_would_empty_profile')
      expect(real.merged).toEqual([])
      expect(real.samplesAfter).toBe(real.samplesBefore)
      // Both identities survive, byte for byte.
      expect(readFileSync(storePath, 'utf-8')).toBe(before)
      expect(readStore().profiles.map(p => p.name).sort()).toEqual(['Theo M', 'Theo Marsh'])
    })

    it('one non-Mac sample is enough: the merge goes ahead and keeps it', () => {
      const target = macOnly('Theo Marsh', 4, 'a')
      target.sources![0] = 'g2-training'
      seed([target, macOnly('Theo M', 3, 'b', 0.07)])
      const report = merge('Theo Marsh', ['Theo M'])
      expect(report.refusal).toBeUndefined()
      expect(report.merged).toEqual(['Theo M'])
      expect(report.samplesAfter).toBeGreaterThan(0)
      expect(readStore().profiles).toHaveLength(1)
    })
  })
})
