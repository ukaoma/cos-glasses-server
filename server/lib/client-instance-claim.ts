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
/** The glasses uploader's longest wait between chunk attempts (cos-glasses-app local-first-meeting-uploader.ts, maxBackoffMs). */
export const GLASSES_UPLOAD_MAX_BACKOFF_MS = 60_000
/** The glasses chunk upload's request timeout (cos-glasses-app api-client.ts). A failed attempt can take this long. */
export const GLASSES_UPLOAD_TIMEOUT_MS = 30_000
/**
 * 6.58.1: how long a copy's own `recording` word holds without proof. On 2026-09-29 (glasses
 * 6.9.558) a hidden copy lost its audio at 07:38:19 and kept claiming `recording: true` for 12
 * minutes; two newer copies started the meeting and were each told to stop within a second, and
 * 12.5 minutes were never captured. The word exists for upload lag (QA round 3), which is bounded:
 * the worst gap between two chunk arrivals from a copy that is recording is one failed attempt
 * (the timeout) plus the longest backoff, 90 s. This allows one more backoff on top (QA, 6.58.1:
 * exactly 90 s left no margin for a weak link, an ASR stall on the Mac or throttled timers).
 */
export const CLIENT_INSTANCE_WORD_HOLD_MS = GLASSES_UPLOAD_TIMEOUT_MS + 2 * GLASSES_UPLOAD_MAX_BACKOFF_MS
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
   * The copy says it is recording (glasses 6.9.510+; false when absent). Chunk arrival
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

/**
 * 6.58.1: what one copy has said about recording, kept per copy (not per owner) so it survives
 * the ring moving between copies. Before this was per copy, a copy that lost the ring and took
 * it back started a fresh clock each time, and a silent 6.9.538 copy and an idle newer one
 * traded the ring every few minutes for a whole meeting, both answering the ring (QA, 6.58.1).
 */
export interface CopyWord {
  recording: boolean
  recordingReported: boolean
  /** When this copy's current run of `recording: true` claims began. */
  recordingSince?: number
  /** When this copy last got a grace after a gap in its claims (see CLIENT_INSTANCE_GRACE_GAP_MS). */
  graceAt?: number
  /** When this copy last claimed, under any verdict. */
  seenAt: number
}

export interface ClientInstanceOwner extends ClientInstanceClaim {
  seenAt: number
  /** 6.58.1: the owner's CopyWord.recordingSince. */
  recordingSince?: number
  /** 6.58.1: the owner's CopyWord.graceAt. */
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
  /** 6.58.1: the same for the claimant. */
  claimantChunkAt?: number
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
    const claimantChunkAt = this.tagged.get(claimId)
    return {
      owner: live(ownerChunkAt),
      claimant: live(claimantChunkAt),
      untagged: live(this.untagged.get(device)),
      ...(ownerChunkAt !== undefined ? { ownerChunkAt } : {}),
      ...(claimantChunkAt !== undefined ? { claimantChunkAt } : {}),
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
 *   committed can keep arriving and would hold the ring for a copy with nothing left to record.
 *   Only while it claims (CLIENT_INSTANCE_LIVE_MS): a copy's start announcement is one claim with
 *   a 1.5 s deadline while its chunks get 30 s, so a `false` from before a meeting can outlive a
 *   start the Mac never heard, and its chunks must then speak for it (QA round 2: believing the
 *   old `false` let a second copy record alongside). Only a claim that carries the field counts.
 * - Its word alone holds for CLIENT_INSTANCE_WORD_HOLD_MS after its newest proof (wordBacked).
 */
export function ownerIsRecording(owner: ClientInstanceOwner, evidence: CaptureEvidence, now: number): boolean {
  const claiming = now - owner.seenAt <= CLIENT_INSTANCE_LIVE_MS
  if (evidence.owner && !(claiming && saysNotRecording(owner))) return true
  if (!claiming) return false
  if (evidence.untagged) return true
  return wordBacked(owner, evidence.ownerChunkAt, now)
}

/** 6.58.1: the claim carried `recording: false` explicitly (glasses 6.9.510+). */
export function saysNotRecording(claim: Pick<ClientInstanceClaim, 'recording' | 'recordingReported'>): boolean {
  return claim.recordingReported === true && !claim.recording
}

/**
 * 6.58.1: a copy's own `recording: true` still counts: its newest proof (its own newest chunk,
 * the start of its run of recording claims, or its one grace after a gap) is no older than
 * CLIENT_INSTANCE_WORD_HOLD_MS. The same rule for an owner holding the ring and a claimant
 * taking it, so a copy with nothing to show cannot take the ring back by saying so (QA, 6.58.1).
 */
export function wordBacked(word: Pick<CopyWord, 'recording' | 'recordingSince' | 'graceAt'>, chunkAt: number | undefined, now: number): boolean {
  if (!word.recording) return false
  const provenAt = Math.max(chunkAt ?? 0, word.recordingSince ?? 0, word.graceAt ?? 0)
  return now - provenAt <= CLIENT_INSTANCE_WORD_HOLD_MS
}

/**
 * 6.58.1: a copy's word after its claim at `now`. `recordingSince` starts when its claims start
 * saying `recording` and clears when they stop. A claim that comes back after a gap longer than
 * CLIENT_INSTANCE_GRACE_GAP_MS, still recording, gets a grace for its uploads to catch up, once
 * per chunk of its own: the first grace is free, and another needs a chunk newer than the last.
 * `chunkAt` is this copy's own newest chunk.
 */
export function nextCopyWord(prev: CopyWord | undefined, claim: ClientInstanceClaim, now: number, chunkAt?: number): CopyWord {
  const recordingReported = claim.recordingReported === true
  if (!claim.recording) return { recording: false, recordingReported, seenAt: now }
  if (!prev || !prev.recording || prev.recordingSince === undefined) return { recording: true, recordingReported, recordingSince: now, seenAt: now }
  const cameBack = now - prev.seenAt > CLIENT_INSTANCE_GRACE_GAP_MS
  const chunkSinceGrace = prev.graceAt === undefined || (chunkAt ?? 0) > prev.graceAt
  const graceAt = cameBack && chunkSinceGrace ? now : prev.graceAt
  return { recording: true, recordingReported, recordingSince: prev.recordingSince, ...(graceAt !== undefined ? { graceAt } : {}), seenAt: now }
}

/** The owner's word, as a CopyWord. */
function wordOf(owner: ClientInstanceOwner): CopyWord {
  return {
    recording: owner.recording,
    recordingReported: owner.recordingReported === true,
    ...(owner.recordingSince !== undefined ? { recordingSince: owner.recordingSince } : {}),
    ...(owner.graceAt !== undefined ? { graceAt: owner.graceAt } : {}),
    seenAt: owner.seenAt,
  }
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
  /**
   * 6.58.1: this claimant's word before this claim (the route keeps one per copy). Undefined:
   * the owner's own word when the claimant is the owner, otherwise a copy never heard from.
   */
  claimantWord?: CopyWord,
): { owner: ClientInstanceOwner; verdict: ClientInstanceVerdict; took: boolean; word: CopyWord } {
  const isOwner = owner !== null && owner.id === claim.id
  const chunkAt = isOwner ? evidence.ownerChunkAt : evidence.claimantChunkAt
  const word = nextCopyWord(claimantWord ?? (isOwner ? wordOf(owner) : undefined), claim, now, chunkAt)
  const fresh: ClientInstanceOwner = {
    ...claim,
    seenAt: now,
    ...(word.recordingSince !== undefined ? { recordingSince: word.recordingSince } : {}),
    ...(word.graceAt !== undefined ? { graceAt: word.graceAt } : {}),
  }
  const decide = (o: ClientInstanceOwner, verdict: ClientInstanceVerdict, took: boolean) => ({ owner: o, verdict, took, word })
  if (!owner) return decide(fresh, 'owner', true)
  if (isOwner) return decide(fresh, 'owner', false)
  // 6.50.4: the yielding copy stops its recording (that is how a duplicate ends), so the
  // ring must never move in a way that stops the only recording.
  // (1) The claimant is recording and the owner is not: the claimant is the meeting.
  // Reopened offline, the Mac still names the dead copy from before; when signal returns,
  // the new copy's chunks land first and its claim must not be told to stop (QA round 2).
  // Its chunks or its own word: after an outage the uploads lag the claims (QA round 3).
  // 6.58.1: the claimant's chunks count unless it says it is not recording, and its word only
  // while it is backed (wordBacked), the same tests the owner meets.
  const claimantRecords = (evidence.claimant && !saysNotRecording(claim)) || wordBacked(word, chunkAt, now)
  if (claimantRecords && !ownerIsRecording(owner, evidence, now)) return decide(fresh, 'owner', true)
  // (2) The owner is recording: a newer copy waits, however quiet the owner's claims.
  // Reopening COS on a blank phone page mid-meeting ended the meeting on 6.50.3 (QA).
  // The ring moves on the newer copy's first claim after the meeting stops.
  if (ownerIsRecording(owner, evidence, now)) return decide(owner, 'yield', false)
  if (isNewer(claim, owner)) return decide(fresh, 'owner', true)
  // 6.52.3: an older boot takes a quiet ring back only after CLIENT_INSTANCE_RECLAIM_MS,
  // and only while it has itself been claiming (awake), never on the first tick after a
  // gap of its own. A dead newer copy is replaced when the user reopens COS (a newer boot
  // still takes at once); this rule is for the copy that is merely quiet.
  const claimantAwake = claimantLastSeenAt !== undefined && now - claimantLastSeenAt <= CLIENT_INSTANCE_AWAKE_MS
  if (now - owner.seenAt > CLIENT_INSTANCE_RECLAIM_MS && claimantAwake) return decide(fresh, 'owner', true)
  return decide(owner, 'yield', false)
}
