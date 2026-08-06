// Eviction policy, tested against compositions taken from the LIVE profile store.
//
// The fixtures are not invented. Every source string below appears verbatim in
// ~/.cos-glasses/data/voice-profiles.json as of 2026-08-06, and the two profile
// shapes are real:
//
//   MU            20/20 — fireflies 10, g2-training 9, unknown 1  (no human sample)
//   Queen Ukaoma  20/20 — manual at index 0, 17 weaker samples available
//
// Queen's profile is the concrete case this policy exists for: under plain FIFO
// the next correction deletes the only deliberately-enrolled sample of her voice
// while seventeen weaker samples sit untouched. Four profiles at cap share that
// shape.
import { describe, expect, it } from 'vitest'
import {
  chooseEviction,
  correctionQuota,
  EVICTION_ORDER,
  isCorrection,
  provenanceTier,
  tierBreakdown,
} from './embedding-eviction.js'

/** MU as stored today: no human-verified sample anywhere. */
const MU = [
  ...Array(10).fill('fireflies'),
  ...Array(9).fill('g2-training'),
  'unknown',
]
/** Queen as stored today: the deliberate enrollment is the OLDEST sample. */
const QUEEN = [
  'manual',
  ...Array(14).fill('fireflies'),
  ...Array(5).fill('g2-training'),
]

describe('classifying a sample by who supplied its label', () => {
  it.each([
    ['manual', 'human'],
    ['g2-enrollment', 'human'],
    ['ext-retroactive', 'human'],
    ['correction:meeting_1786027607017', 'human'],
    ['g2-training', 'assisted'],
    ['fireflies', 'metadata'],
    ['auto:meeting_1774377156653', 'automatic'],
    ['unknown', 'unknown'],
  ])('reads %s as %s', (source, tier) => {
    expect(provenanceTier(source)).toBe(tier)
  })

  it('handles bare and prefixed forms of the same source', () => {
    // Both shapes exist in the live store: `g2-training` bare, `auto:<id>` prefixed.
    expect(provenanceTier('auto')).toBe('automatic')
    expect(provenanceTier('auto:meeting_123')).toBe('automatic')
    expect(provenanceTier('correction')).toBe('human')
    expect(provenanceTier('correction:meeting_abc')).toBe('human')
  })

  it('treats an absent or unrecognised source as unknown, never as trusted', () => {
    // Defaulting an unlabelled sample to `human` would protect exactly the
    // samples whose provenance was lost.
    for (const s of [undefined, null, '', '   ', 'something-new']) {
      expect(provenanceTier(s)).toBe('unknown')
    }
  })

  it('is case- and whitespace-insensitive', () => {
    expect(provenanceTier('  MANUAL  ')).toBe('human')
    expect(provenanceTier('Correction:Meeting_X')).toBe('human')
  })

  it('identifies a correction distinctly from other human samples', () => {
    expect(isCorrection('correction:meeting_1')).toBe(true)
    expect(isCorrection('manual')).toBe(false)
    expect(isCorrection('ext-retroactive')).toBe(false)
  })
})

describe('eviction order', () => {
  it('walks weakest to strongest, ending at human', () => {
    // Encodes the intended order structurally, so reordering the constant fails
    // here rather than silently changing which samples survive.
    expect([...EVICTION_ORDER]).toEqual(['automatic', 'unknown', 'metadata', 'assisted', 'human'])
  })

  it('takes the fully-automatic sample first', () => {
    const sources = ['manual', 'fireflies', 'g2-training', 'auto:meeting_9', 'unknown']
    const c = chooseEviction(sources, 'correction:meeting_new', 40)
    expect(c?.index).toBe(3)
    expect(c?.tier).toBe('automatic')
  })

  it('takes an unknown-provenance sample before any labelled one', () => {
    const c = chooseEviction(['manual', 'fireflies', 'g2-training', 'unknown'], 'correction:m', 40)
    expect(c?.index).toBe(3)
    expect(c?.tier).toBe('unknown')
  })

  it('takes unverified attendee-metadata before an identifier-labelled sample', () => {
    // fireflies labels come from attendee metadata and were never acoustically
    // verified — the chain that manufactured the phantom Erick Hernandez profile.
    const c = chooseEviction(['manual', 'g2-training', 'fireflies'], 'correction:m', 40)
    expect(c?.index).toBe(2)
    expect(c?.tier).toBe('metadata')
  })

  it('takes an identifier-labelled sample before a human one', () => {
    const c = chooseEviction(['manual', 'ext-retroactive', 'g2-training'], 'correction:m', 40)
    expect(c?.index).toBe(2)
    expect(c?.tier).toBe('assisted')
  })

  it('drops the OLDEST within the chosen tier', () => {
    const sources = ['g2-training', 'fireflies', 'fireflies', 'g2-training']
    const c = chooseEviction(sources, 'correction:m', 40)
    expect(c?.index).toBe(1)      // the first fireflies, not the second
  })

  it('explains itself, so an eviction is never silent', () => {
    const c = chooseEviction(['manual', 'fireflies'], 'correction:m', 40)
    expect(c?.reason).toContain('fireflies')
    expect(c?.reason).toContain('rather than a stronger one')
  })
})

describe('the live profiles this policy was written for', () => {
  it("protects Queen's only deliberate enrollment, which FIFO would delete first", () => {
    const c = chooseEviction(QUEEN, 'correction:meeting_new', 40)
    expect(c).not.toBeNull()
    expect(c!.index).not.toBe(0)              // index 0 is the `manual` sample
    expect(QUEEN[c!.index]).toBe('fireflies') // a weaker sample goes instead
    expect(c!.tier).toBe('metadata')
  })

  it('drops the unlabelled sample first from MU, whose profile has no human sample', () => {
    const c = chooseEviction(MU, 'correction:meeting_new', 40)
    expect(c?.index).toBe(19)     // the lone `unknown`
    expect(c?.tier).toBe('unknown')
  })

  it('then works through MU\'s unverified metadata before the assisted samples', () => {
    const withoutUnknown = MU.slice(0, 19)
    const c = chooseEviction(withoutUnknown, 'correction:meeting_new', 40)
    expect(c?.tier).toBe('metadata')
    expect(c?.index).toBe(0)
  })
})

describe('the correction quota', () => {
  it('is half the cap, so the centroid keeps typical-voice mass', () => {
    // Corrections come from the acoustically hard tail — the segments the
    // identifier got wrong. A profile of nothing but hard cases has a centroid
    // displaced from how the speaker usually sounds.
    expect(correctionQuota(40)).toBe(20)
    expect(correctionQuota(20)).toBe(10)
    expect(correctionQuota(1)).toBe(1)      // never zero: one correction must fit
  })

  it('replaces the OLDEST CORRECTION once corrections reach quota', () => {
    const sources = [
      ...Array(4).fill('correction:old'),
      'fireflies', 'g2-training', 'manual', 'fireflies',
    ]
    const c = chooseEviction(sources, 'correction:new', 8)   // quota = 4, already at 4
    expect(c?.index).toBe(0)
    expect(c?.reason).toContain('quota')
    // Crucially NOT the fireflies sample: taking one would push corrections to 5
    // of 8 and keep displacing the centroid.
    expect(sources[c!.index]).toContain('correction')
  })

  it('does not apply the quota to a non-correction sample', () => {
    const sources = [...Array(4).fill('correction:old'), 'fireflies', 'g2-training', 'manual', 'manual']
    const c = chooseEviction(sources, 'manual', 8)
    // An ordinary enrollment still evicts the weakest sample available.
    expect(c?.tier).toBe('metadata')
    expect(c?.index).toBe(4)
  })

  it('lets corrections take weaker samples while still under quota', () => {
    const sources = ['correction:a', 'fireflies', 'g2-training', 'manual']
    const c = chooseEviction(sources, 'correction:b', 40)   // quota 20, only 1 present
    expect(c?.tier).toBe('metadata')
    expect(c?.index).toBe(1)
  })
})

describe('edge cases', () => {
  it('returns null for an empty profile — there is nothing to evict', () => {
    expect(chooseEviction([], 'correction:m', 40)).toBeNull()
  })

  it('falls back to age when every sample is human-supplied', () => {
    // No weaker sample exists to give up, so the oldest human sample goes and
    // the reason says exactly that rather than implying a tier decision.
    const sources = ['manual', 'ext-retroactive', 'correction:a', 'g2-enrollment']
    const c = chooseEviction(sources, 'manual', 40)
    expect(c?.index).toBe(0)
    expect(c?.tier).toBe('human')
    expect(c?.reason).toContain('every sample is human-supplied')
  })

  it('handles a sources array with holes without trusting them', () => {
    const sources = ['manual', undefined, 'fireflies']
    const c = chooseEviction(sources, 'correction:m', 40)
    expect(c?.index).toBe(1)        // the hole reads as unknown, weaker than metadata
    expect(c?.tier).toBe('unknown')
  })
})

describe('tier breakdown', () => {
  it('counts the live MU composition', () => {
    expect(tierBreakdown(MU)).toEqual({
      human: 0, assisted: 9, metadata: 10, automatic: 0, unknown: 1,
    })
  })

  it('counts every tier at zero for an empty profile', () => {
    expect(tierBreakdown([])).toEqual({
      human: 0, assisted: 0, metadata: 0, automatic: 0, unknown: 0,
    })
  })
})
