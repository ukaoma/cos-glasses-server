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

export interface ClientInstanceClaim {
  id: string
  bootAt: number
  version: string
}

export interface ClientInstanceOwner extends ClientInstanceClaim {
  seenAt: number
}

export type ClientInstanceVerdict = 'owner' | 'yield'

const ID_PATTERN = /^[a-z0-9]{1,16}-[a-z0-9]{1,8}$/

/** A body the route may act on, or null. Never throws. */
export function parseClientInstanceClaim(body: unknown): ClientInstanceClaim | null {
  if (!body || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  if (typeof o.id !== 'string' || !ID_PATTERN.test(o.id)) return null
  if (typeof o.bootAt !== 'number' || !Number.isFinite(o.bootAt) || o.bootAt <= 0) return null
  const version = typeof o.version === 'string' ? o.version.slice(0, 32) : ''
  return { id: o.id, bootAt: o.bootAt, version }
}

function isNewer(a: ClientInstanceClaim, b: ClientInstanceClaim): boolean {
  return a.bootAt > b.bootAt || (a.bootAt === b.bootAt && a.id > b.id)
}

/** The owner after `claim` arrives at `now`, and what to tell its sender. */
export function arbitrateClientInstance(
  owner: ClientInstanceOwner | null,
  claim: ClientInstanceClaim,
  now: number,
): { owner: ClientInstanceOwner; verdict: ClientInstanceVerdict; took: boolean } {
  const fresh: ClientInstanceOwner = { ...claim, seenAt: now }
  if (!owner) return { owner: fresh, verdict: 'owner', took: true }
  if (owner.id === claim.id) return { owner: { ...owner, seenAt: now }, verdict: 'owner', took: false }
  if (isNewer(claim, owner)) return { owner: fresh, verdict: 'owner', took: true }
  if (now - owner.seenAt > CLIENT_INSTANCE_LIVE_MS) return { owner: fresh, verdict: 'owner', took: true }
  return { owner, verdict: 'yield', took: false }
}
