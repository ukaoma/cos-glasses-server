// When a COS Glasses app copy last proved it is alive (6.52.0).
//
// THE SIGNAL, AND WHY THIS ONE. The permission broker parks a session question only when a
// lens or phone client could show it. Four candidates exist on this server:
//
//   - the client-instance claim (`POST /api/client-instance/claim`, glasses 6.9.505+): every
//     live app copy posts one every 15 s (CLIENT_INSTANCE_TICK_MS), authenticated, carrying
//     its id and version. A request is an ACT: it cannot be sent by a copy that is gone.
//   - the display stream (`/api/display-stream`): an open SSE socket. Open is not alive: a
//     half-open TCP connection reads the same, the socket is also opened by `probe=1`
//     connects that abort at once, and COS Control and curl open it too.
//   - client diagnostics (`clientLog`): lossy and only on events, so quiet proves nothing.
//   - meeting chunks: only while recording, and the owner's claims keep going then anyway.
//
// The claim is the most positive: a fresh, authenticated request that only an app copy
// sends, on a fixed cadence. It is also the right bound for delivery: a copy whose timers
// are frozen (a locked phone) posts no claim, and it could not poll for the question either.
// A `check: true` claim counts: a copy that yielded is still a live copy on the phone.
//
// In memory, like the claim referee: a restart forgets it, and the next tick restores it
// within 15 s. Until then nothing is parked, which is the native dialog, the safe side.

let lastClaimAt: number | null = null

/** A valid claim arrived at `at` (server clock). Never moves backwards. */
export function noteClientClaim(at: number): void {
  if (!Number.isFinite(at)) return
  if (lastClaimAt === null || at > lastClaimAt) lastClaimAt = at
}

/** When the newest valid claim arrived, or null when none has since boot. */
export function lastClientClaimAt(): number | null {
  return lastClaimAt
}

export function __resetClientLivenessForTests(): void {
  lastClaimAt = null
}
