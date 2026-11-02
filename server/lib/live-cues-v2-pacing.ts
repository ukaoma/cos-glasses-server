// 6.97.8: pace the per-meeting cue cap so a meeting cannot spend it all early. On 2026-11-02 three of the four long meetings
// reached the 25-cue cap in 18 to 30 minutes of a 35 to 47 minute meeting, and the last 5 to 22 minutes got nothing.
//
// The user's two settings keep their meaning: the cap is still the most cues a meeting can ever show, and the gap (cooldown) is
// still the least time between two cues. The pace only decides how soon the cap is available.
//
//   burst   = ceil(cap / 2)                      half the cap is open from the first minute, at the gap pace
//   refill  = max(gap, horizon / (cap - burst))  the other half comes back one cue at a time, evenly, over one meeting hour
//   allowed(t) = min(cap, burst + floor(t / refill))
//
// With the defaults (cap 25, gap 60 s, horizon 60 min): burst 13, one more cue every 5 minutes, the 25th at minute 60. At cap 25
// and gap 45 s the refill is the same 5 minutes. The horizon is the one number that is not derived from the user's settings: a
// meeting hour. A meeting that runs longer than the horizon simply has its whole cap open after it.

/** The meeting length the cap is spread over: one hour. */
export const PACE_HORIZON_MS = 60 * 60_000

export function paceBurst(maxCues: number): number {
  return Math.min(maxCues, Math.ceil(maxCues / 2))
}

/** Milliseconds between two refills; Infinity when the whole cap is already open (a cap of 1). */
export function paceRefillMs(maxCues: number, cooldownMs: number): number {
  const rest = maxCues - paceBurst(maxCues)
  return rest <= 0 ? Number.POSITIVE_INFINITY : Math.max(cooldownMs, Math.floor(PACE_HORIZON_MS / rest))
}

/** How many cues a meeting may have shown `elapsedMs` after it started. Never more than the cap; a negative elapsed counts as 0. */
export function paceAllowed(maxCues: number, cooldownMs: number, elapsedMs: number): number {
  const refill = paceRefillMs(maxCues, cooldownMs)
  const refilled = Number.isFinite(refill) ? Math.floor(Math.max(0, elapsedMs) / refill) : 0
  return Math.min(maxCues, paceBurst(maxCues) + refilled)
}
