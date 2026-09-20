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
}

export interface ClientInstanceOwner extends ClientInstanceClaim {
  seenAt: number
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
    return {
      owner: live(this.tagged.get(ownerId)),
      claimant: live(this.tagged.get(claimId)),
      untagged: live(this.untagged.get(device)),
    }
  }
}

/**
 * Whether the owner is recording. Its own tagged chunks are proof however quiet its claims
 * (a hidden or locked WebView throttles its timers; chunk uploads follow the audio). Its
 * own last claim saying `recording`, and untagged chunks from the device (which could be
 * anyone's), count only while it is still claiming: a dead owner must never be pinned by
 * a stale flag or by the chunks of the copy that replaced it (QA round 2).
 */
export function ownerIsRecording(owner: ClientInstanceOwner, evidence: CaptureEvidence, now: number): boolean {
  if (evidence.owner) return true
  return (owner.recording || evidence.untagged) && now - owner.seenAt <= CLIENT_INSTANCE_LIVE_MS
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
  return { id: o.id, bootAt: o.bootAt, version, recording: o.recording === true }
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
  const fresh: ClientInstanceOwner = { ...claim, seenAt: now }
  if (!owner) return { owner: fresh, verdict: 'owner', took: true }
  if (owner.id === claim.id) return { owner: { ...owner, seenAt: now, recording: claim.recording }, verdict: 'owner', took: false }
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
