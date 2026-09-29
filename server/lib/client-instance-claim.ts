// Which copy of the COS Glasses app owns the ring (6.50.3). PURE: the clock is passed in.
//
// WHY THE SERVER. On 2026-09-18 the Even Realities app kept an older WebView copy of the
// plugin alive behind a newly opened one and delivered every ring event to both, so one
// Start Meeting recorded the same 90 minutes twice. Glasses 6.9.505 put a claim in the Even
// app's own storage: the newest boot wins, the copy behind it yields. It failed in the field
// because the hidden copy's storage calls went unanswered (its claim sat 36 min stale and it
// never read the newer one), while its HTTP calls to this server kept working (it uploaded
// all 827 chunks). This server is the one party every copy can still reach.
//
// RULE. One owner at a time. A claim from the owner refreshes it. A claim from a NEWER boot
// (ties broken by id) takes ownership. A claim from an older boot takes ownership only when
// the owner has gone quiet for CLIENT_INSTANCE_LIVE_MS (the newer copy died). In memory: a
// server restart forgets the owner, and the next posts re-establish it within one tick.

export const CLIENT_INSTANCE_TICK_MS = 15_000
/** Three missed ticks: the owner is gone. */
export const CLIENT_INSTANCE_LIVE_MS = 3 * CLIENT_INSTANCE_TICK_MS
/**
 * 6.52.3: how long the owner must be quiet before an OLDER boot may take the ring back.
 * On 2026-09-20 a hidden copy from the night before took the ring after the live copy
 * went quiet (a locked phone throttles its timers) and answered a hold-to-talk 27 minutes
 * later with a stale session. 45 s is a normal quiet spell for a locked phone; a dead
 * copy stays dead, so waiting ten minutes costs nothing.
 */
export const CLIENT_INSTANCE_RECLAIM_MS = 10 * 60_000
/**
 * 6.52.3: an older boot may take the ring back only when ITS OWN previous claim is this
 * recent. Both copies sleep when the phone does; a zombie that woke up alongside the live
 * copy has a gap of its own, and the live copy's refresh lands within a tick.
 */
export const CLIENT_INSTANCE_AWAKE_MS = CLIENT_INSTANCE_LIVE_MS
/**
 * 6.50.4: a meeting chunk inside this window means that copy is recording. Five chunk
 * intervals (~6 s each), so a stretch of silence or a slow upload does not end the hold.
 */
export const CLIENT_INSTANCE_CAPTURE_LIVE_MS = 30_000
/**
 * 6.58.1: how long an owner's own `recording` word holds the ring without proof. On 2026-09-29
 * (glasses 6.9.558) a hidden copy lost its audio at 07:38:19 and kept claiming `recording: true`
 * for 12 minutes; two newer copies started the meeting and were each told to stop within a
 * second, and 12.5 minutes were never captured. The word exists for upload lag (QA round 3),
 * which is bounded: the uploader backs off 1, 2, 4 ... up to 60 s, so after a short outage the
 * chunks resume within about 40 s of the last one, and after a longer one within 60 s of the
 * claims coming back (the grace below). So the word holds for this long after its newest proof.
 */
export const CLIENT_INSTANCE_WORD_HOLD_MS = 90_000
/**
 * 6.58.1: a gap between an owner's claims longer than two ticks is an outage or a sleep. When the
 * owner comes back still saying `recording`, its word gets one fresh CLIENT_INSTANCE_WORD_HOLD_MS
 * for its chunks to catch up, but only if a chunk of its own arrived since the last such grace:
 * the 2026-09-29 zombie's timers were throttled (gaps of 30 s to 208 s between rows), so a grace
 * on every gap would have held the ring for it indefinitely.
 */
export const CLIENT_INSTANCE_GRACE_GAP_MS = 2 * CLIENT_INSTANCE_TICK_MS
/** App copies whose newest chunk is remembered; the least recent is dropped past this. */
export const CLIENT_INSTANCE_MAX_TAGGED = 64
/** A boot time this far past the server clock is a phone clock set wrong, not a newer copy. */
export const CLIENT_INSTANCE_MAX_FUTURE_BOOT_MS = 60 * 60_000

export interface ClientInstanceClaim {
  id: string
  bootAt: number
  version: string
  /**
   * The copy says it is recording (glasses 6.9.509+; false when absent). Chunk arrival
   * alone lags: after an outage the uploader backs off up to 60 s, and only a visible page
   * or a display reconnect resets it, which a hidden recording copy never gets (QA round 3).
   */
  recording: boolean
  /**
   * 6.58.1: the claim carried a `recording` field at all (glasses 6.9.510+). Only then is a
   * `recording: false` a statement; from older copies it is merely absent.
   */
  recordingReported?: boolean
}

export interface ClientInstanceOwner extends ClientInstanceClaim {
  seenAt: number
  /** 6.58.1: when this owner's current run of `recording: true` claims began. */
  recordingSince?: number
  /** 6.58.1: when this owner last got a grace for its word after a gap (see CLIENT_INSTANCE_GRACE_GAP_MS). */
  graceAt?: number
}

export type ClientInstanceVerdict = 'owner' | 'yield'

const ID_PATTERN = /^[a-z0-9]{1,16}-[a-z0-9]{1,8}$/

/** The `clientInstance` a chunk POST names (glasses 6.9.509+), or null. Never throws. */
export function parseInstanceTag(value: unknown): string | null {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null
}

/**
 * What the chunk stream says about who is recording, for one claim from one device.
 * `owner` / `claimant`: that copy's OWN tagged chunks arrived inside
 * CLIENT_INSTANCE_CAPTURE_LIVE_MS. `untagged`: chunks without a tag (glasses before 6.9.509)
 * arrived from this device, so they could be anyone's.
 */
export interface CaptureEvidence {
  owner: boolean
  claimant: boolean
  untagged: boolean
  /** 6.58.1: when the owner's own newest tagged chunk arrived, however long ago; absent: never (or forgotten). */
  ownerChunkAt?: number
}

export const NO_CAPTURE: CaptureEvidence = { owner: false, claimant: false, untagged: false }

/**
 * Newest chunk arrival per tagged app copy, and per device for untagged chunks. The clock
 * is passed in. Bounded: a copy that stopped sending is forgotten once 64 newer ones have.
 */
export class ClientChunkLedger {
  private readonly tagged = new Map<string, number>()
  private readonly untagged = new Map<string, number>()

  note(device: string, instance: string | null, at: number): void {
    const map = instance ? this.tagged : this.untagged
    const key = instance ?? device
    map.delete(key)
    map.set(key, at)
    while (map.size > CLIENT_INSTANCE_MAX_TAGGED) map.delete(map.keys().next().value as string)
  }

  evidence(device: string, ownerId: string, claimId: string, now: number): CaptureEvidence {
    const live = (at: number | undefined) => at !== undefined && now - at < CLIENT_INSTANCE_CAPTURE_LIVE_MS
    const ownerChunkAt = this.tagged.get(ownerId)
    return {
      owner: live(ownerChunkAt),
      claimant: live(this.tagged.get(claimId)),
      untagged: live(this.untagged.get(device)),
      ...(ownerChunkAt !== undefined ? { ownerChunkAt } : {}),
    }
  }
}

/**
 * Whether the owner is recording. Its own tagged chunks are proof however quiet its claims
 * (a hidden or locked WebView throttles its timers; chunk uploads follow the audio). Its
 * own last claim saying `recording`, and untagged chunks from the device (which could be
 * anyone's), count only while it is still claiming: a dead owner must never be pinned by
 * a stale flag or by the chunks of the copy that replaced it (QA round 2).
 *
 * 6.58.1, two limits from the 2026-09-29 zombie (see CLIENT_INSTANCE_WORD_HOLD_MS):
 * - An owner still claiming that SAYS it is not recording is believed over its trailing chunks.
 *   Glasses 6.9.560 says so within seconds of its audio stopping; the chunks it had already
 *   committed kept arriving for up to 30 s and would have held the ring for a copy that had
 *   nothing left to record. Chunks outrank the word only when the word is stale or unspoken.
 * - Its word alone holds for CLIENT_INSTANCE_WORD_HOLD_MS after its newest proof: its own
 *   newest chunk, the start of its recording claims, or its one grace after a gap.
 */
export function ownerIsRecording(owner: ClientInstanceOwner, evidence: CaptureEvidence, now: number): boolean {
  const claiming = now - owner.seenAt <= CLIENT_INSTANCE_LIVE_MS
  const saysNotRecording = claiming && owner.recordingReported === true && !owner.recording
  if (evidence.owner && !saysNotRecording) return true
  if (!claiming) return false
  if (evidence.untagged) return true
  if (!owner.recording) return false
  const provenAt = Math.max(evidence.ownerChunkAt ?? 0, owner.recordingSince ?? 0, owner.graceAt ?? 0)
  return now - provenAt <= CLIENT_INSTANCE_WORD_HOLD_MS
}

/** A body the route may act on, or null. Never throws. */
export function parseClientInstanceClaim(body: unknown, now = Date.now()): ClientInstanceClaim | null {
  if (!body || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  if (typeof o.id !== 'string' || !ID_PATTERN.test(o.id)) return null
  if (typeof o.bootAt !== 'number' || !Number.isFinite(o.bootAt) || o.bootAt <= 0) return null
  // A copy that booted with the phone clock set ahead would outrank every later copy for
  // as long as the clock stayed wrong (QA, 6.50.3).
  if (o.bootAt > now + CLIENT_INSTANCE_MAX_FUTURE_BOOT_MS) return null
  const version = typeof o.version === 'string' ? o.version.slice(0, 32) : ''
  return { id: o.id, bootAt: o.bootAt, version, recording: o.recording === true, recordingReported: typeof o.recording === 'boolean' }
}

/**
 * The owner's own claim, refreshed (6.58.1). `recordingSince` starts when its claims start saying
 * `recording` and clears when they stop. A claim that comes back after a gap longer than
 * CLIENT_INSTANCE_GRACE_GAP_MS, still recording, gets a grace for its uploads to catch up, once
 * per chunk of its own: the first grace is free, and another needs a chunk newer than the last.
 */
function refreshOwner(owner: ClientInstanceOwner, claim: ClientInstanceClaim, now: number, evidence: CaptureEvidence): ClientInstanceOwner {
  const next: ClientInstanceOwner = { ...owner, seenAt: now, recording: claim.recording, recordingReported: claim.recordingReported }
  if (!claim.recording) {
    delete next.recordingSince
    delete next.graceAt
    return next
  }
  if (!owner.recording || owner.recordingSince === undefined) next.recordingSince = now
  const cameBack = now - owner.seenAt > CLIENT_INSTANCE_GRACE_GAP_MS
  const chunkSinceGrace = owner.graceAt === undefined || (evidence.ownerChunkAt ?? 0) > owner.graceAt
  if (owner.recording && cameBack && chunkSinceGrace) next.graceAt = now
  return next
}

function isNewer(a: ClientInstanceClaim, b: ClientInstanceClaim): boolean {
  return a.bootAt > b.bootAt || (a.bootAt === b.bootAt && a.id > b.id)
}

/** The owner after `claim` arrives at `now`, and what to tell its sender. */
export function arbitrateClientInstance(
  owner: ClientInstanceOwner | null,
  claim: ClientInstanceClaim,
  now: number,
  evidence: CaptureEvidence = NO_CAPTURE,
  /** When this claimant last claimed (any verdict), or undefined: never seen. */
  claimantLastSeenAt?: number,
): { owner: ClientInstanceOwner; verdict: ClientInstanceVerdict; took: boolean } {
  const fresh: ClientInstanceOwner = { ...claim, seenAt: now, ...(claim.recording ? { recordingSince: now } : {}) }
  if (!owner) return { owner: fresh, verdict: 'owner', took: true }
  if (owner.id === claim.id) return { owner: refreshOwner(owner, claim, now, evidence), verdict: 'owner', took: false }
  // 6.50.4: the yielding copy stops its recording (that is how a duplicate ends), so the
  // ring must never move in a way that stops the only recording.
  // (1) The claimant is recording and the owner is not: the claimant is the meeting.
  // Reopened offline, the Mac still names the dead copy from before; when signal returns,
  // the new copy's chunks land first and its claim must not be told to stop (QA round 2).
  // Its chunks or its own word: after an outage the uploads lag the claims (QA round 3).
  if ((evidence.claimant || claim.recording) && !ownerIsRecording(owner, evidence, now)) return { owner: fresh, verdict: 'owner', took: true }
  // (2) The owner is recording: a newer copy waits, however quiet the owner's claims.
  // Reopening COS on a blank phone page mid-meeting ended the meeting on 6.50.3 (QA).
  // The ring moves on the newer copy's first claim after the meeting stops.
  if (ownerIsRecording(owner, evidence, now)) return { owner, verdict: 'yield', took: false }
  if (isNewer(claim, owner)) return { owner: fresh, verdict: 'owner', took: true }
  // 6.52.3: an older boot takes a quiet ring back only after CLIENT_INSTANCE_RECLAIM_MS,
  // and only while it has itself been claiming (awake), never on the first tick after a
  // gap of its own. A dead newer copy is replaced when the user reopens COS (a newer boot
  // still takes at once); this rule is for the copy that is merely quiet.
  const claimantAwake = claimantLastSeenAt !== undefined && now - claimantLastSeenAt <= CLIENT_INSTANCE_AWAKE_MS
  if (now - owner.seenAt > CLIENT_INSTANCE_RECLAIM_MS && claimantAwake) return { owner: fresh, verdict: 'owner', took: true }
  return { owner, verdict: 'yield', took: false }
}
