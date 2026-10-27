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

// 6.93.0: `mac-assign:<sessionId>` is a sample a person ASSIGNED from a Mac recording's
// `Voice N` (mac-voice-assignment.ts). Nobody listened to each sample, the audio is
// call or video playback through a digital tap rather than the wearer's microphone,
// and the voice can be a merge of two people (R1). So it ranks as `assisted`, is NOT a
// correction (no quota, no protection), never vouches for identity, and may only ever
// replace another Mac-assigned sample, never a G2 correction, g2-training or fireflies
// one. Retraction by session still works (training-audio-provenance.ts).
export const MAC_ASSIGN_SOURCE = 'mac-assign'
/** Most Mac-assigned samples one profile may carry. Past this a new one replaces the oldest Mac-assigned one. */
export const MAC_ASSIGN_PROFILE_CAP = 10

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
    // 6.45.4: a held group a human named after listening (held-voice-groups).
    case 'ext-group':
      return 'human'
    // The identifier chose the label; a human approved the batch run.
    case 'g2-training':
    // 6.93.0: a person picked the name for a Mac `Voice N`; nobody heard each sample.
    case MAC_ASSIGN_SOURCE:
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

/**
 * May a sample of this provenance VOUCH for an unidentified voice — be the
 * corroboration behind "this held group sounds like X"?
 *
 * Narrower than `provenanceTier === 'human'` on purpose. `ext-retroactive` is a
 * whole held session enrolled under one typed name: a human supplied the name,
 * so eviction protects it, but nobody listened to each sample, and on the live
 * store 2026-09-12 every "high" suggestion was carried by such samples alone —
 * one household voice that a bulk enrol had written into two people's
 * profiles, offered back as those people. `auto` and `unknown` never vouch.
 */
export function vouchesForIdentity(source: string | undefined | null): boolean {
  const head = String(source ?? '').trim().split(/[:_]/)[0].toLowerCase()
  return head === 'manual' || head === 'fireflies' || head === 'g2-enrollment'
    || head === 'g2-training' || head === 'correction' || head === 'ext-group'
}

/** True for a sample added by assigning a Mac recording voice to a profile. */
export function isMacAssign(source: string | undefined | null): boolean {
  return String(source ?? '').trim().toLowerCase().startsWith(`${MAC_ASSIGN_SOURCE}:`)
    || String(source ?? '').trim().toLowerCase() === MAC_ASSIGN_SOURCE
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
  /** 6.93.0: the incoming sample may displace nothing here (a Mac-assigned sample into a full profile with no Mac-assigned
   *  sample to replace). The caller must refuse it; `index` is -1 and must not be dropped. */
  refuse?: boolean
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
  const macIdx = sources.map((s, i) => ({ s, i })).filter(x => isMacAssign(x.s)).map(x => x.i)

  // 6.93.0: a Mac-assigned sample replaces the oldest Mac-assigned one or is refused. It never takes a slot
  // from a correction, g2-training, fireflies or any other sample, whatever the profile's mix.
  if (isMacAssign(incomingSource)) {
    if (macIdx.length > 0) {
      return {
        index: macIdx[0],
        tier: 'assisted',
        reason: `Mac-assigned samples at ${macIdx.length}/${MAC_ASSIGN_PROFILE_CAP} or the profile is full, replacing the oldest Mac-assigned sample`,
      }
    }
    return { index: -1, tier: 'assisted', reason: 'profile is full and holds no Mac-assigned sample to replace, refusing the Mac-assigned sample', refuse: true }
  }

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
    // Inside the assisted tier a Mac-assigned sample goes first: it is the least verified of them.
    const idx = tier === 'assisted' && macIdx.length > 0 ? macIdx[0] : sources.findIndex(s => provenanceTier(s) === tier)
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
