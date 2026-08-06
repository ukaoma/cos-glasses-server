// Does a real enrollment actually evict the sample the policy chose?
//
// The policy is unit-tested and the store primitive is unit-tested. This file
// tests the WIRING, end to end, through the real `enrollEmbedding` against the
// real sherpa-onnx extractor — because a correct policy that the enrollment path
// never consults is worth nothing, and a source-shape grep for `chooseEviction(`
// would pass while the call sat behind a condition that never fires.
//
// ISOLATION IS MANDATORY HERE. This module does work at import time and writes
// to DATA_DIR. Every test below points COS_DATA_DIR at a throwaway directory, so
// nothing can touch the 77 real voice profiles. (Learned the hard way on
// 2026-07-27: importing glasses-server modules RUNS them, and a "read-only"
// probe rewrote production archive files.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { UNKNOWN_SOURCE } from './voice-profile-store.js'
import { join } from 'node:path'

const REAL_MODEL = join(homedir(), '.cos-glasses', 'models', '3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx')
const haveModel = existsSync(REAL_MODEL)

let dir = ''
let mod: typeof import('./speaker-embeddings.js')

/**
 * A 192-dim vector with ONE dominant dimension per seed, so cosine between any
 * two different seeds is near zero.
 *
 * This matters more than it looks. The first version used a sine phase-shift,
 * and some pairs landed above the 0.95 dedup threshold — enrollEmbedding then
 * returned `{ success: false, error: 'Too similar' }`, no eviction happened, and
 * six eviction assertions passed or failed for reasons unrelated to eviction.
 * `seed` indexes a dimension directly (no modulo), so fixture seeds 0-39 and
 * probe seeds 100+ cannot collide.
 */
function distinct(seed: number): Float32Array {
  if (seed >= 192) throw new Error(`seed ${seed} exceeds the 192 dimensions available`)
  const v = new Float32Array(192)
  v[seed] = 1
  for (let i = 0; i < 192; i++) v[i] += Math.sin(i * 0.13 + seed) * 0.01
  return v
}

/** Enroll and REQUIRE it to land. A silently-rejected enrollment makes every
 *  eviction assertion downstream vacuous. */
function enroll(name: string, seed: number, source: string): void {
  const r = mod.enrollEmbedding(name, distinct(seed), source)
  expect(r.success, `enroll ${source} rejected: ${r.error}`).toBe(true)
}

function seedProfile(name: string, sources: string[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'voice-profiles.json'), JSON.stringify({
    profiles: [{
      name,
      embeddings: sources.map((_, i) => Array.from(distinct(i))),
      sources: [...sources],
    }],
  }, null, 2))
}

function storedSources(name: string): string[] {
  const doc = JSON.parse(readFileSync(join(dir, 'voice-profiles.json'), 'utf-8'))
  return doc.profiles.find((p: { name: string }) => p.name === name)?.sources ?? []
}
function storedCount(name: string): number {
  const doc = JSON.parse(readFileSync(join(dir, 'voice-profiles.json'), 'utf-8'))
  return doc.profiles.find((p: { name: string }) => p.name === name)?.embeddings.length ?? 0
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cos-evict-int-'))
  process.env.COS_DATA_DIR = dir
  process.env.COS_SPEAKER_MODEL_PATH = REAL_MODEL
  vi.resetModules()
  mod = await import('./speaker-embeddings.js')
})

/**
 * Seed a profile then start the extractor — ORDER MATTERS. Init loads the store
 * into the sherpa manager, so initialising before the fixture exists leaves the
 * manager empty and every enrollment below writes a fresh 1-sample profile,
 * which looks like "eviction deleted everything" rather than "the fixture was
 * never loaded". Init is also explicit, not automatic on import.
 */
function seedAndStart(name: string, sources: string[]): void {
  seedProfile(name, sources)
  mod.initSpeakerEmbeddings()
}
afterEach(() => {
  delete process.env.COS_DATA_DIR
  delete process.env.COS_SPEAKER_MODEL_PATH
  vi.resetModules()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!haveModel)('eviction through the real enrollment path', () => {
  it('initialises against the real model, so these assertions mean something', () => {
    seedAndStart('Probe', ['manual'])
    expect(mod.isEmbeddingAvailable()).toBe(true)
  })

  it('raises the cap to 40, so a full-at-20 profile grows instead of evicting', () => {
    // 61 of 77 live profiles sat at 20. Before this change every correction on
    // any of them cost a sample; now there is headroom first.
    seedAndStart('Twenty', Array(20).fill('fireflies'))
    enroll('Twenty', 100, 'correction:meeting_new')
    expect(storedCount('Twenty')).toBe(21)
    expect(storedSources('Twenty').filter(s => s === 'fireflies')).toHaveLength(20)
  })

  it("protects Queen's only deliberate enrollment when the profile IS full", () => {
    // The live shape that motivated this: `manual` at index 0, weaker samples
    // available. Under plain FIFO index 0 is the first thing deleted.
    const sources = ['manual', ...Array(34).fill('fireflies'), ...Array(5).fill('g2-training')]
    expect(sources).toHaveLength(40)
    seedAndStart('Queen Ukaoma', sources)

    enroll('Queen Ukaoma', 101, 'correction:meeting_new')

    const after = storedSources('Queen Ukaoma')
    expect(after).toHaveLength(40)
    // The deliberate enrollment survived; a metadata sample went instead.
    expect(after).toContain('manual')
    expect(after.filter(s => s === 'fireflies')).toHaveLength(33)
    expect(after.filter(s => s === 'g2-training')).toHaveLength(5)
    expect(after).toContain('correction:meeting_new')
  })

  it('takes the fully-automatic sample before any labelled one', () => {
    const sources = ['manual', ...Array(37).fill('fireflies'), 'g2-training', 'auto:meeting_9']
    seedAndStart('AutoFirst', sources)
    enroll('AutoFirst', 102, 'correction:m')

    const after = storedSources('AutoFirst')
    expect(after.some(s => s.startsWith('auto:'))).toBe(false)   // the automatic one left
    expect(after).toContain('manual')
    expect(after).toContain('g2-training')
    expect(after.filter(s => s === 'fireflies')).toHaveLength(37)
  })

  it('keeps provenance aligned with samples after an eviction from the middle', () => {
    // The alignment bug this guards is silent: an off-by-one between the two
    // arrays makes every later sample carry a neighbour's provenance, and
    // nothing downstream would notice.
    const sources = [
      'manual', 'auto:meeting_1', 'g2-training',
      ...Array(36).fill('fireflies'), 'ext-retroactive',
    ]
    expect(sources).toHaveLength(40)
    seedAndStart('Aligned', sources)

    enroll('Aligned', 103, 'correction:m')

    const doc = JSON.parse(readFileSync(join(dir, 'voice-profiles.json'), 'utf-8'))
    const p = doc.profiles.find((x: { name: string }) => x.name === 'Aligned')
    expect(p.sources).toHaveLength(p.embeddings.length)
    // Index 1 (the auto sample) was removed, so what followed it shifted down.
    expect(p.sources[0]).toBe('manual')
    expect(p.sources[1]).toBe('g2-training')
  })

  it('caps corrections at half the profile, replacing the oldest correction', () => {
    // Corrections come from the acoustically hard tail. Left unchecked they
    // would fill the profile and pull the centroid away from the speaker's
    // ordinary voice.
    const sources = [
      ...Array(20).fill(0).map((_, i) => `correction:meeting_${i}`),
      ...Array(20).fill('fireflies'),
    ]
    seedAndStart('AtQuota', sources)

    enroll('AtQuota', 104, 'correction:meeting_newest')

    const after = storedSources('AtQuota')
    expect(after.filter(s => s.startsWith('correction'))).toHaveLength(20)   // still at quota
    expect(after).not.toContain('correction:meeting_0')                      // oldest went
    expect(after).toContain('correction:meeting_newest')
    // NOT a fireflies sample: taking one would push corrections to 21 of 40.
    expect(after.filter(s => s === 'fireflies')).toHaveLength(20)
  })

  it('still evicts weak samples for a NON-correction enrollment', () => {
    const sources = [...Array(20).fill(0).map((_, i) => `correction:m${i}`), ...Array(20).fill('fireflies')]
    seedAndStart('Manual40', sources)

    enroll('Manual40', 105, 'manual')

    const after = storedSources('Manual40')
    // The quota governs incoming corrections only; an ordinary enrollment takes
    // the weakest sample available.
    expect(after.filter(s => s.startsWith('correction'))).toHaveLength(20)
    expect(after.filter(s => s === 'fireflies')).toHaveLength(19)
    expect(after).toContain('manual')
  })

  it('falls back to age when every sample is human-supplied', () => {
    const sources = Array(40).fill(0).map((_, i) => (i === 0 ? 'manual' : `ext-retroactive_${i}`))
    seedAndStart('AllHuman', sources)

    enroll('AllHuman', 106, 'manual')

    const after = storedSources('AllHuman')
    expect(after).toHaveLength(40)
    expect(after).not.toContain('manual_0')
    expect(after[0]).toBe('ext-retroactive_1')   // the oldest went, nothing weaker existed
  })

  it('survives a profile whose sources array is SHORTER than its embeddings', () => {
    // Real stores carry this: 3 samples read as `unknown` provenance today. A
    // short array must not misalign the eviction index.
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'voice-profiles.json'), JSON.stringify({
      profiles: [{
        name: 'Short',
        embeddings: Array(40).fill(0).map((_, i) => Array.from(distinct(i))),
        sources: ['manual', 'fireflies'],      // 2 sources for 40 embeddings
      }],
    }, null, 2))
    mod.initSpeakerEmbeddings()   // seeded inline, so init has to follow by hand

    enroll('Short', 107, 'correction:m')
    const doc = JSON.parse(readFileSync(join(dir, 'voice-profiles.json'), 'utf-8'))
    const p = doc.profiles.find((x: { name: string }) => x.name === 'Short')
    expect(p.sources).toHaveLength(p.embeddings.length)   // repaired, not left ragged
    // Discriminating assertion: the 38 unlabelled samples are the WEAKEST tier,
    // so one of those went. Both LABELLED samples must survive. Asserting only
    // that index 0 is still `manual` passes even when the policy is handed the
    // raw short array and never sees the unlabelled samples at all — it would
    // then evict `fireflies`, which is strictly worse and looks identical.
    expect(p.sources[0]).toBe('manual')
    expect(p.sources).toContain('fireflies')
    expect(p.sources.filter((x: string) => x === UNKNOWN_SOURCE)).toHaveLength(37)
  })

  it('reports which profiles have NO human-verified sample', () => {
    // The finding that motivated surfacing this: MU was 10 metadata + 9 assisted
    // + 1 unknown, trained entirely on labels the system chose for itself, and
    // no status output said so.
    seedProfile('NoHuman', [...Array(3).fill('fireflies'), 'g2-training'])
    writeFileSync(join(dir, 'voice-profiles.json'), JSON.stringify({
      profiles: [
        { name: 'NoHuman', embeddings: [0, 1, 2].map(i => Array.from(distinct(i))), sources: ['fireflies', 'fireflies', 'g2-training'] },
        { name: 'HasHuman', embeddings: [3, 4].map(i => Array.from(distinct(i))), sources: ['manual', 'fireflies'] },
      ],
    }, null, 2))
    mod.initSpeakerEmbeddings()

    const summary = mod.profileProvenanceSummary()
    expect(summary.profiles).toBe(2)
    expect(summary.cap).toBe(40)
    expect(summary.noHumanSample).toEqual(['NoHuman'])
    expect(summary.tiers).toMatchObject({ human: 1, assisted: 1, metadata: 3 })
  })

  it('counts profiles sitting at the cap', () => {
    seedAndStart('Full', Array(40).fill('fireflies'))
    expect(mod.profileProvenanceSummary().atCap).toBe(1)
  })
})
