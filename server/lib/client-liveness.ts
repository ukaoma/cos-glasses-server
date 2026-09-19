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

let lastPollAt: number | null = null

/** A stored stamp this far ahead of a new poll means the clock stepped back. */
const CLOCK_STEP_BACK_MS = 5_000

/**
 * A counting questions poll answered at `at` (server clock). Never moves backwards for a
 * slower request answered later, but a clock that stepped back is followed: a stamp left in
 * the future would read stale to the broker, and ignoring every poll until the clock caught
 * up would leave no live client for that long.
 */
export function noteQuestionsPoll(at: number): void {
  if (!Number.isFinite(at)) return
  if (lastPollAt === null || at > lastPollAt || lastPollAt - at > CLOCK_STEP_BACK_MS) lastPollAt = at
}

/** When the newest authenticated questions poll arrived, or null when none has since boot. */
export function lastQuestionsPollAt(): number | null {
  return lastPollAt
}

export function __resetClientLivenessForTests(): void {
  lastPollAt = null
}
