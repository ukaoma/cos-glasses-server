// When a client that can ANSWER a session question last asked for them (6.52.0).
//
// THE SIGNAL, AND WHY THIS ONE. The permission broker holds a session question or a tool
// approval only while a lens or phone client could show it and send the answer back. The
// only proof of that is a client asking for the questions: an authenticated
// `GET /api/session-questions?client=glasses|phone` (X-Cos-Token, never the hook token)
// within the last 30 s, checked at admission and again while anything is held.
//
// Rejected, and why:
//   - the client-instance claim (`POST /api/client-instance/claim`): every COS Glasses copy
//     since 6.9.505 posts it every 15 s, including the ones with no question UI. Counting
//     it made a 6.9.511 app on the phone read as "someone can answer", so the Mac held
//     questions and approvals nobody could see for up to 110 s (coordinator review,
//     2026-09-19). A claim says a copy is alive, not that it can answer.
//   - the display stream: an open socket is not alive (a half-open connection, a
//     `probe=1` connect, COS Control and curl all read the same).
//   - client diagnostics and meeting chunks: lossy, or only while recording.
//
// So an app that has never heard of this feature never calls the route, and the broker
// answers `{}` (the Mac's own dialog) for it, exactly as before. The poll also bounds
// delivery: a copy whose timers are frozen (a locked phone) cannot poll, and could not
// show the question either.
//
// In memory: a restart forgets it, and the next poll restores it. Until then nothing is
// held, which is the native dialog, the safe side.
//
// 6.60.0 (QA round 1, the contract shared with COS Glasses 6.9.563): the away hold needs
// more than a poll. A poll QUALIFIES only with `hold=1` (this client shows held questions;
// 6.9.563 and later send it) AND a finite `presenceAgeMs` within [0, 24 h]: the ms since
// the latest real wearer evidence (glasses: a ring or temple input, or a device status with
// wearing true; phone: a foreground touch). A connected lens nobody wears sends no
// `presenceAgeMs`, and an older client sends no `hold=1`, so neither can make the Mac hold a
// question for 10 minutes.
//
// Kept apart, all in memory (a restart forgets them, which fails toward 6.59.0):
//   - the newest counting poll of any kind (`lastQuestionsPollAt`, for /api/health);
//   - the newest poll WITHOUT `hold=1` (`lastLegacyQuestionsPollAt`): the 6.59.0 liveness,
//     unchanged for every older client;
//   - the newest poll WITH `hold=1` (`lastHoldQuestionsPollAt`);
//   - the newest qualifying presence, on BOTH clocks, each forward-only: monotonic
//     (`performance.now()`, immune to the wall clock stepping) and wall. Its age is the
//     larger of the two (`presenceAgeMs`): on macOS the monotonic clock does not advance
//     while the Mac sleeps, so on its own it would read a pre-sleep presence as younger
//     than it is; the wall clock does advance. A wall clock stepped forward reads older
//     (no hold), never younger.

/** 6.60.0: the most a client may report as `presenceAgeMs`. Anything else is no presence. */
export const PRESENCE_AGE_MAX_MS = 86_400_000

let lastPollAt: number | null = null
let lastLegacyPollAt: number | null = null
let lastHoldPollAt: number | null = null
let lastPresenceMono: number | null = null
let lastPresenceWall: number | null = null

/** 6.60.0: the monotonic clock. Milliseconds since this process started; paused while the Mac sleeps. */
export function monotonicNowMs(): number {
  return performance.now()
}

/** A stored stamp this far ahead of a new poll means the clock stepped back. */
const CLOCK_STEP_BACK_MS = 5_000

/** Newest-wins for a poll stamp, following a clock that stepped back (see below). */
function newerStamp(stored: number | null, at: number): number {
  return stored === null || at > stored || stored - at > CLOCK_STEP_BACK_MS ? at : stored
}

/** 6.60.0: what a counting poll said about the client, read from its query. */
export interface QuestionsPollFacts {
  /** `hold=1`: this client can show held questions. */
  hold?: boolean
  /** ms since the latest real wearer evidence; null or absent when there is none since boot. */
  presenceAgeMs?: number | null
}

/** 6.60.0: a `presenceAgeMs` the contract accepts: a finite whole number within [0, 24 h]. */
export function validPresenceAgeMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= PRESENCE_AGE_MAX_MS
}

/**
 * A counting questions poll answered at `at` (server clock). Never moves backwards for a
 * slower request answered later, but a clock that stepped back is followed: a stamp left in
 * the future would read stale to the broker, and ignoring every poll until the clock caught
 * up would leave no live client for that long. 6.60.0: `poll` says whether it was a `hold=1`
 * poll and carried qualifying presence; `mono` is the monotonic time it was answered.
 */
export function noteQuestionsPoll(at: number, poll: QuestionsPollFacts = {}, mono: number = monotonicNowMs()): void {
  if (!Number.isFinite(at)) return
  lastPollAt = newerStamp(lastPollAt, at)
  if (poll.hold !== true) {
    lastLegacyPollAt = newerStamp(lastLegacyPollAt, at)
    return
  }
  lastHoldPollAt = newerStamp(lastHoldPollAt, at)
  if (!validPresenceAgeMs(poll.presenceAgeMs) || !Number.isFinite(mono)) return
  // Forward-only on each clock: a slower poll carrying older evidence never moves it back.
  const presenceMono = mono - poll.presenceAgeMs
  const presenceWall = at - poll.presenceAgeMs
  if (lastPresenceMono === null || presenceMono > lastPresenceMono) lastPresenceMono = presenceMono
  if (lastPresenceWall === null || presenceWall > lastPresenceWall) lastPresenceWall = presenceWall
}

/**
 * 6.60.0: how long ago the newest qualifying wearer presence was, or null when no
 * qualifying poll has arrived since this process started. The larger of the monotonic age
 * and the wall-clock age, so a Mac that slept never makes it read younger.
 */
export function presenceAgeMs(mono: number = monotonicNowMs(), wall: number = Date.now()): number | null {
  if (lastPresenceMono === null || !Number.isFinite(mono)) return null
  const monoAge = Math.max(0, mono - lastPresenceMono)
  const wallAge = lastPresenceWall !== null && Number.isFinite(wall) ? wall - lastPresenceWall : 0
  return Math.max(monoAge, wallAge)
}

/** When the newest authenticated questions poll of any kind arrived, or null since boot (/api/health). */
export function lastQuestionsPollAt(): number | null {
  return lastPollAt
}

/** 6.60.0: the newest poll WITHOUT `hold=1`: the 6.59.0 liveness, for every older client. */
export function lastLegacyQuestionsPollAt(): number | null {
  return lastLegacyPollAt
}

/** 6.60.0: the newest poll WITH `hold=1`. */
export function lastHoldQuestionsPollAt(): number | null {
  return lastHoldPollAt
}

export function __resetClientLivenessForTests(): void {
  lastPollAt = null
  lastLegacyPollAt = null
  lastHoldPollAt = null
  lastPresenceMono = null
  lastPresenceWall = null
}
