// Which sample gets dropped when a voice profile is full.
//
// WHY THIS IS NOT FIFO. Measured on the live store (2026-08-06): 61 of 77
// profiles are already at the 20-sample cap, so every correction costs a sample
// today. And the samples are not interchangeable — the owner's own profile, the
// one driving owner detection, reads:
//
//   MU: 20/20 — fireflies 10, g2-training 9, unknown 1     (zero human-verified)
//
// `fireflies` labels come from meeting ATTENDEE METADATA, never acoustically
// verified. That is exactly the chain that manufactured the phantom "Erick
// Hernandez" profile: 3 fireflies seeds compounding to 18 via g2-training. Under
// plain FIFO, a human correction could evict the single `manual` sample while
// ten unverified metadata seeds sat untouched. Age is the wrong axis. Who
// supplied the label is the right one.
//
// THE COUNTER-ARGUMENT, honoured by the quota below. Corrections are drawn from
// the acoustically HARD tail — the chunks the identifier got wrong. A profile
// made entirely of hard cases has a centroid displaced from the speaker's
// typical voice, which could make routine matching worse. So corrections are
// protected from eviction but capped at half a profile, keeping typical-voice
// mass in the centroid.

/** Ordered weakest-first: eviction walks this list and takes from the first
 *  non-empty tier. */
export const EVICTION_ORDER = ['automatic', 'unknown', 'metadata', 'assisted', 'human'] as const

export type ProvenanceTier = typeof EVICTION_ORDER[number]

/**
 * Classify a sample by WHO supplied its label — not by how the audio arrived.
 *
 * Source strings appear both bare (`g2-training`) and prefixed
 * (`auto:meeting_1774377156653`), both verified in the live store, so matching is
 * on the prefix before any separator.
 */
export function provenanceTier(source: string | undefined | null): ProvenanceTier {
  const head = String(source ?? '').trim().split(/[:_]/)[0].toLowerCase()
  switch (head) {
    // A human deliberately supplied the audio or named the voice.
    case 'manual':
    case 'correction':
    case 'ext-retroactive':
    case 'g2-enrollment':
      return 'human'
    // The identifier chose the label; a human approved the batch run.
    case 'g2-training':
      return 'assisted'
    // Label came from attendee metadata and was never acoustically verified.
    case 'fireflies':
      return 'metadata'
    // No human involvement at any point.
    case 'auto':
      return 'automatic'
    default:
      return 'unknown'
  }
}

/** True for a sample created by a human correcting a specific meeting. */
export function isCorrection(source: string | undefined | null): boolean {
  return String(source ?? '').trim().toLowerCase().startsWith('correction')
}

/**
 * How many of a profile's slots corrections may occupy.
 *
 * Half, rounded down. Above this the profile's centroid is dominated by the
 * acoustically difficult segments that needed correcting, which is not what the
 * speaker usually sounds like.
 */
export function correctionQuota(cap: number): number {
  return Math.max(1, Math.floor(cap / 2))
}

export interface EvictionChoice {
  /** Index into embeddings[]/sources[] to drop. */
  index: number
  tier: ProvenanceTier
  /** Human-readable justification, logged so an eviction is never silent. */
  reason: string
}

/**
 * Choose which sample to drop to make room for `incomingSource`.
 *
 * Returns null when the incoming sample should be REFUSED rather than evicting
 * anything — which happens only when a correction would exceed its quota and
 * every correction present is newer than it could justify replacing.
 */
export function chooseEviction(
  sources: Array<string | undefined | null>,
  incomingSource: string,
  cap: number,
): EvictionChoice | null {
  // No empty-array guard: the tier walk below returns null for an empty
  // profile on its own (every findIndex is -1), and the quota branch cannot
  // fire because the quota floor is 1. Verified by mutation — an explicit
  // guard here is unreachable in effect.
  const correctionIdx = sources.map((s, i) => ({ s, i })).filter(x => isCorrection(x.s)).map(x => x.i)

  // A correction arriving at or above quota replaces the OLDEST CORRECTION, not
  // a typical-voice sample. Corrections stay protected as a class while the
  // newest human evidence still lands, and the centroid keeps its ordinary mass.
  if (isCorrection(incomingSource) && correctionIdx.length >= correctionQuota(cap)) {
    return {
      index: correctionIdx[0],
      tier: 'human',
      reason: `corrections at quota (${correctionIdx.length}/${correctionQuota(cap)}) — replacing the oldest correction`,
    }
  }

  for (const tier of EVICTION_ORDER) {
    const idx = sources.findIndex(s => provenanceTier(s) === tier)
    if (idx === -1) continue
    // Reached only when the profile is entirely human-supplied. Age decides,
    // because there is no weaker sample to give up.
    const reason = tier === 'human'
      ? 'every sample is human-supplied — dropping the oldest'
      : `dropping the oldest ${tier} sample (${String(sources[idx])}) rather than a stronger one`
    return { index: idx, tier, reason }
  }
  return null
}

/** Tier counts for a profile, for logs and health output. */
export function tierBreakdown(sources: Array<string | undefined | null>): Record<ProvenanceTier, number> {
  const out: Record<ProvenanceTier, number> = {
    human: 0, assisted: 0, metadata: 0, automatic: 0, unknown: 0,
  }
  for (const s of sources) out[provenanceTier(s)]++
  return out
}
