// 6.97.8: pace the per-meeting cue cap so a meeting cannot spend it all early. On 2026-11-02 three of the four long meetings
// reached the 25-cue cap in 18 to 30 minutes of a 35 to 47 minute meeting, and the last 5 to 22 minutes got nothing.
//
// The user's two settings keep their meaning: the cap is still the most cues a meeting can ever show, and the gap (cooldown) is
// still the least time between two cues. The pace only decides how soon the cap is available.
//
//   burst   = ceil(cap / 2)                          half the cap is open from the first minute, at the gap pace
//   refill  = max(gap, horizon / (cap - burst))      the other half comes back one cue at a time, evenly, over the horizon
//   allowed(t) = min(cap, burst + floor(t / refill))
//
// The horizon is the meeting's own length when the calendar match gives one (clamped to 15 to 180 minutes), else one meeting
// hour. With the defaults (cap 25, gap 60 s, one hour): burst 13, one more cue every 5 minutes, the 25th at minute 60. A meeting
// that runs longer than the horizon simply has its whole cap open after it. A cap of 4 or fewer is not paced at all: with so few
// cues the first minutes are the only ones worth spending them on, and the engine tests of a small cap rely on it.

/** The meeting length the cap is spread over when the calendar does not say: one hour. */
export const PACE_HORIZON_MS = 60 * 60_000
export const PACE_HORIZON_MIN_MS = 15 * 60_000
export const PACE_HORIZON_MAX_MS = 180 * 60_000
/** Caps up to this are not paced. */
export const PACE_MIN_CAP = 5

/** A calendar length as a horizon: null or nonsense falls back to the default, anything else is clamped. */
export function paceHorizon(durationMs: number | null | undefined): number {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return PACE_HORIZON_MS
  return Math.min(PACE_HORIZON_MAX_MS, Math.max(PACE_HORIZON_MIN_MS, durationMs))
}

export function paceBurst(maxCues: number): number {
  return Math.min(maxCues, Math.ceil(maxCues / 2))
}

/** Milliseconds between two refills; Infinity when the whole cap is already open (a cap of 1). */
export function paceRefillMs(maxCues: number, cooldownMs: number, horizonMs: number = PACE_HORIZON_MS): number {
  const rest = maxCues - paceBurst(maxCues)
  return rest <= 0 ? Number.POSITIVE_INFINITY : Math.max(cooldownMs, Math.floor(horizonMs / rest))
}

/** How many cues a meeting may have shown `elapsedMs` after it started. Never more than the cap; a negative elapsed counts as 0. */
export function paceAllowed(maxCues: number, cooldownMs: number, elapsedMs: number, horizonMs: number = PACE_HORIZON_MS): number {
  if (maxCues < PACE_MIN_CAP) return maxCues
  const refill = paceRefillMs(maxCues, cooldownMs, horizonMs)
  const refilled = Number.isFinite(refill) ? Math.floor(Math.max(0, elapsedMs) / refill) : 0
  return Math.min(maxCues, paceBurst(maxCues) + refilled)
}
