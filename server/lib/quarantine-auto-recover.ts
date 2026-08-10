// Quarantined audio that nobody asked to recover still has to become a meeting.
//
// THE HOLE THIS CLOSES. 6.23.0 made a stranded session save itself at the 4-hour
// cutoff, but that only works while the server stays up. `recoverSessions()`
// refuses to load any session already past the cutoff at boot — it tombstones it —
// so a restart, a COS Control update, or a crash at the wrong moment means the
// sweeper never sees the session, its audio dir is orphaned, and it lands in
// quarantine with no meeting. That is exactly the old behavior, reached by a
// different door, and it is not hypothetical: `meeting_1786237535593` (139 chunks,
// 31 MB, reason `idle_expiry_unsaved`) came through it.
//
// Quarantine already keeps the audio for 72 hours and `POST
// /api/meeting/orphans/:id/recover` already turns it into a meeting. The only thing
// missing was that a human had to notice and press it. This picks one per sweep.
//
// WHY ONE AT A TIME. Recovery runs a full batch transcription over every chunk WAV
// — real GPU and CPU work, minutes for a long capture. Recovering a backlog in
// parallel would starve a live recording, so the sweep takes the oldest and leaves
// the rest for the next tick. The route's own `shouldAbort` already yields to a live
// recording once started.
//
// WHY THE ATTEMPT LEDGER. A capture that cannot be recovered — unreadable chunks, a
// codec the batch path rejects — would otherwise be retried every 60 seconds for 72
// hours, burning the machine and drowning the log. After a few failures it is left
// alone: the audio is still preserved and still recoverable by hand, which is
// strictly better than a retry loop that never converges.

import type { UnsavedCapture } from './unsaved-audio-quarantine.js'

/**
 * Chunks below which a capture is not worth turning into a meeting.
 *
 * A chunk covers roughly 5 to 10 seconds, so one chunk is a recording that started and
 * stopped almost immediately. Observed 2026-08-10: `meeting_1786393815060_tp693w` held
 * ONE 5.6-second chunk that transcribed to silence, and the panel advertised it as
 * "1 recoverable" with instructions to open the phone app — which cannot clear a
 * server-side quarantine, so the badge simply persisted.
 *
 * Recovering it would run a full batch transcription and produce an empty meeting
 * titled "Recovered capture (audio only)". That is noise, not rescue. The audio is NOT
 * deleted here — quarantine retention still owns that decision and expires it on its
 * own clock. This only decides what is worth acting on and worth warning about.
 */
export const MIN_RECOVERABLE_CHUNKS = 2

/**
 * Is this capture substantial enough to act on?
 *
 * One definition, used by the auto-recover picker AND by the counts that drive the
 * "unsaved captures" warning, so the badge cannot claim something is recoverable that
 * the sweeper has already decided to leave alone.
 */
export function isWorthRecovering(item: { recovered: boolean; chunkFiles: number }): boolean {
  if (item.recovered) return false
  return item.chunkFiles >= MIN_RECOVERABLE_CHUNKS
}

/** Attempts per capture before the sweep stops trying on its own. */
export const MAX_AUTO_RECOVER_ATTEMPTS = 3

/**
 * Title for a capture the sweep recovers.
 *
 * Distinct from the promote title on purpose. A promoted session carried a live ASR
 * transcript with speaker labels; a quarantine recovery has neither, because no live
 * ASR ever ran on it — every speaker comes back Unknown. The user should be able to
 * tell those two apart in the library without opening them.
 */
export const AUTO_RECOVER_TITLE = 'Recovered capture (audio only)'

export interface AutoRecoverState {
  /** sessionId → attempts already made this process lifetime. */
  attempts: Map<string, number>
  /** Recoveries currently running, from the route's own set. */
  inFlight: ReadonlySet<string>
}

/**
 * Which quarantined capture, if any, should the sweep recover next?
 *
 * Returns null when there is nothing to do — the common case — so the caller does no
 * work on a quiet tick.
 */
export function pickQuarantineToRecover(
  items: readonly UnsavedCapture[],
  state: AutoRecoverState,
): UnsavedCapture | null {
  const eligible = items.filter(item => {
    // Already a meeting, chunk-less residue, or too small to be a meeting at all.
    if (!isWorthRecovering(item)) return false
    // Another recovery owns this one.
    if (state.inFlight.has(item.sessionId)) return false
    return (state.attempts.get(item.sessionId) ?? 0) < MAX_AUTO_RECOVER_ATTEMPTS
  })
  if (eligible.length === 0) return null
  // Oldest first: it is closest to the 72-hour purge, so it has the least time left.
  // `ageHours` can be null when the marker is unreadable — treat that as oldest
  // rather than newest, because an unreadable marker is itself a sign of an old dir.
  return [...eligible].sort((a, b) => (b.ageHours ?? Number.MAX_SAFE_INTEGER)
    - (a.ageHours ?? Number.MAX_SAFE_INTEGER))[0] ?? null
}

/** Record an attempt. Called BEFORE the request, so a hang still counts. */
export function noteRecoverAttempt(state: AutoRecoverState, sessionId: string): void {
  state.attempts.set(sessionId, (state.attempts.get(sessionId) ?? 0) + 1)
}

/** Clear the ledger for a capture that succeeded, so a later re-quarantine is fresh. */
export function clearRecoverAttempts(state: AutoRecoverState, sessionId: string): void {
  state.attempts.delete(sessionId)
}

export function autoRecoverExhausted(state: AutoRecoverState, sessionId: string): boolean {
  return (state.attempts.get(sessionId) ?? 0) >= MAX_AUTO_RECOVER_ATTEMPTS
}

export interface RecoverRequestResult {
  ok: boolean
  status: number
  filename?: string
  reason?: string
}

export interface RecoverRequestOptions {
  port: number
  token: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Ask the real recover route to turn a quarantined capture into a meeting.
 *
 * Loopback for the same reason promote is: that route owns the recovering-set
 * guard, the batch transcription, the `shouldAbort` yield to a live recording, the
 * receipt and the `markRecovered` stamp. Reimplementing any of it here would fork
 * the path a user's own button press takes.
 *
 * A generous default timeout: batch transcription of a long capture is minutes of
 * real work, and aborting early would leave the route running with no one reading
 * the result.
 */
export async function requestQuarantineRecovery(
  sessionId: string,
  options: RecoverRequestOptions,
): Promise<RecoverRequestResult> {
  if (!options.token) return { ok: false, status: 0, reason: 'no_token' }
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1_800_000)
  try {
    const res = await doFetch(
      `http://127.0.0.1:${options.port}/api/meeting/orphans/${encodeURIComponent(sessionId)}/recover`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Cos-Token': options.token },
        body: JSON.stringify({ title: AUTO_RECOVER_TITLE }),
        signal: controller.signal,
      },
    )
    let payload: Record<string, unknown> = {}
    try { payload = await res.json() as Record<string, unknown> } catch {}
    return {
      ok: res.ok,
      status: res.status,
      filename: typeof payload.filename === 'string' ? payload.filename : undefined,
      reason: typeof payload.reason === 'string' ? payload.reason : undefined,
    }
  } catch (error: any) {
    return { ok: false, status: 0, reason: error?.name === 'AbortError' ? 'timeout' : 'request_failed' }
  } finally {
    clearTimeout(timer)
  }
}
