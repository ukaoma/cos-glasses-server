// What the sweeper DOES about a stranded session: draft it, then promote it.
//
// Two actions, deliberately asymmetric.
//
// DRAFT (at the stale threshold) is additive and reversible. It writes the
// transcript the session already holds to a file and touches nothing else — no
// store write, no audio move, no session close. That matters because a phone that
// has been silent for 25 minutes can still drain its IndexedDB buffer into the
// same session id, and closing early would answer that drain with 410 Gone. A
// draft cannot truncate anything; it only makes the capture readable and visible
// while the session stays open for the tail.
//
// It also stays OUT of the meetings store on purpose. `POST /api/meeting/save` is
// idempotent by session id — a second save replays the first receipt. If a draft
// occupied that id, the real save arriving later with the drained tail would find
// `alreadySaved` and return the SHORTER checkpoint forever. The draft is a
// sidecar, never a meeting.
//
// PROMOTE (at the retention cutoff) goes through POST /api/meeting/save over
// loopback rather than calling the store directly. That route owns the maintenance
// lease, the save-in-progress lock, the receipt contract, domain inference and the
// two-phase finalization job; reimplementing any of it here would fork the most
// load-bearing path in the product. The session is still in memory at this point,
// so the save keeps the live ASR transcript and its speaker labels — which is why
// promote must not use the quarantine recover route, whose output labels every
// speaker Unknown because no live ASR ever ran on it.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { atomicWriteFileSync } from './atomic-fs.js'
import { forgetSessionHeartbeat } from './session-heartbeats.js'
import { classifyStrandedSession, type SessionHeartbeat } from './stranded-sessions.js'

/** Title given to a capture the sweeper saves on the user's behalf. */
export const STRANDED_PROMOTE_TITLE = 'Auto-saved capture'

const DRAFT_SUFFIX = '.draft.md'
/** A draft is a safety net, not an archive. Bounded so it cannot grow unwatched. */
const MAX_DRAFT_CHARS = 400_000

export interface StrandedDraftInput {
  sessionId: string
  transcript: string
  chunkCount: number
  startedAt: number
  lastActivityAt: number
  /** Injected for deterministic tests. */
  now?: number
}

export interface StrandedDraft {
  sessionId: string
  path: string
  bytes: number
  chunkCount: number
  updatedAt: string
}

function draftPath(dir: string, sessionId: string): string {
  return resolve(dir, `${sessionId}${DRAFT_SUFFIX}`)
}

/**
 * Write (or refresh) the draft for a stranded session.
 *
 * Returns null when there is nothing worth drafting, so an empty session cannot
 * litter the directory with contentless files.
 */
export function writeStrandedDraft(dir: string, input: StrandedDraftInput): string | null {
  const transcript = input.transcript.trim()
  if (!transcript) return null
  if (!input.sessionId) return null
  const now = input.now ?? Date.now()
  const idleMin = Math.round(Math.max(0, now - input.lastActivityAt) / 60_000)
  const capturedMin = Math.round(Math.max(0, input.lastActivityAt - input.startedAt) / 60_000)
  const body = transcript.length > MAX_DRAFT_CHARS
    ? `${transcript.slice(0, MAX_DRAFT_CHARS)}\n\n[draft truncated at ${MAX_DRAFT_CHARS} characters]`
    : transcript
  const doc = [
    '---',
    `session_id: ${input.sessionId}`,
    `state: stranded_draft`,
    `chunks_received: ${input.chunkCount}`,
    `captured_minutes: ${capturedMin}`,
    `idle_minutes: ${idleMin}`,
    `drafted_at: ${new Date(now).toISOString()}`,
    '---',
    '',
    '> Draft only. This capture stopped receiving audio and has not been saved as a',
    '> meeting yet. The session is still open, so if the phone reconnects the rest of',
    '> the audio will still arrive. It becomes a real meeting automatically at the',
    `> retention cutoff, or immediately via POST /api/meeting/save.`,
    '',
    body,
    '',
  ].join('\n')
  try {
    mkdirSync(dir, { recursive: true })
    atomicWriteFileSync(draftPath(dir, input.sessionId), doc, { mode: 0o600 })
    return draftPath(dir, input.sessionId)
  } catch {
    return null
  }
}

/** Every draft currently on disk, newest first. */
export function listStrandedDrafts(dir: string): StrandedDraft[] {
  if (!existsSync(dir)) return []
  const out: StrandedDraft[] = []
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return [] }
  for (const name of entries) {
    if (!name.endsWith(DRAFT_SUFFIX)) continue
    const full = resolve(dir, name)
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
      const head = readFileSync(full, 'utf8').slice(0, 800)
      const chunks = /^chunks_received: (\d+)$/m.exec(head)
      out.push({
        sessionId: name.slice(0, -DRAFT_SUFFIX.length),
        path: full,
        bytes: st.size,
        chunkCount: chunks ? Number(chunks[1]) : 0,
        updatedAt: new Date(st.mtimeMs).toISOString(),
      })
    } catch { /* a draft we cannot stat is not worth failing the sweep over */ }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Called once a session reaches a real terminal state. Never throws. */
export function clearStrandedDraft(dir: string, sessionId: string): void {
  try { rmSync(draftPath(dir, sessionId), { force: true }) } catch {}
}

/**
 * Drop every trace of stranded-state for a session that reached ANY terminal state.
 *
 * One function because the two halves must never diverge. A retained draft would
 * keep /api/meeting/orphans advertising an unsaved capture that is now saved — the
 * false alarm that trains a user to ignore the one channel built to report real
 * losses. A retained heartbeat would let a dead session's last breath veto a stale
 * verdict for a session id that no longer exists.
 */
export function releaseStrandedState(dir: string, sessionId: string): void {
  clearStrandedDraft(dir, sessionId)
  forgetSessionHeartbeat(sessionId)
}

export interface SweepableSession {
  lastActivityAt: number
  startTime: number
  chunkCount: number
}

export interface StrandedSweepInput {
  now: number
  /** Empty means this process does not own the API — see the guard below. */
  token: string
  draftDir: string
  sessions: Iterable<[string, SweepableSession]>
  getHeartbeat: (sessionId: string) => SessionHeartbeat | null
  getTranscript: (sessionId: string) => string | null
  /** Fire-and-forget: a promote can run for minutes and must not block the tick. */
  onPromote: (sessionId: string, lastActivityAt: number) => void
}

export interface StrandedSweepResult {
  drafted: string[]
  promoted: string[]
  /** Sessions the sweep deliberately left alone. */
  live: string[]
}

/**
 * One pass over the live sessions: draft what has gone quiet, promote what is done.
 *
 * EXTRACTED FROM THE INTERVAL ON PURPOSE. While this loop lived inside the
 * `setInterval` in routes/transcribe-stream.ts no test could reach it, because
 * importing that module executes boot recovery, a 60s timer, and reads and writes
 * against the real data home. Two mutations proved the cost: deleting the entire
 * stale branch, and deleting the token gate, both SURVIVED the whole suite. A loop
 * that decides whether a recording ever becomes a meeting cannot be covered by
 * source-shape assertions alone.
 */
export function sweepStrandedSessions(input: StrandedSweepInput): StrandedSweepResult {
  const result: StrandedSweepResult = { drafted: [], promoted: [], live: [] }
  // Only the process that owns the API can save anything, and only it should be
  // writing into the data home. No token means a test worker or a tool that
  // imported the module, so the pass does nothing rather than half-acting.
  if (!input.token) return result
  for (const [sessionId, session] of input.sessions) {
    const verdict = classifyStrandedSession(
      { lastActivityAt: session.lastActivityAt, heartbeat: input.getHeartbeat(sessionId) },
      input.now,
    )
    if (verdict === 'live') { result.live.push(sessionId); continue }
    if (verdict === 'stale') {
      // Draft only. The session stays OPEN so a phone that reconnects can still
      // drain its buffered tail into this same id.
      const written = writeStrandedDraft(input.draftDir, {
        sessionId,
        transcript: input.getTranscript(sessionId) ?? '',
        chunkCount: session.chunkCount,
        startedAt: session.startTime,
        lastActivityAt: session.lastActivityAt,
        now: input.now,
      })
      if (written) result.drafted.push(sessionId)
      continue
    }
    input.onPromote(sessionId, session.lastActivityAt)
    result.promoted.push(sessionId)
  }
  return result
}

export interface PromoteResult {
  ok: boolean
  status: number
  filename?: string
  reason?: string
}

/**
 * After a failed auto-save, does the session close (quarantining its audio) or wait
 * for the next sweep?
 *
 * Extracted from the sweeper because it is the decision with the real consequence:
 * closing means the capture becomes quarantined audio and NOT a meeting, which is
 * the exact outcome this release exists to prevent. Inside the route it was
 * untestable without importing and therefore executing the whole module.
 *
 * @param idleForMs how long the session has been without a chunk
 * @param giveUpAfterMs backstop so a permanently-failing save cannot keep a
 *   session in memory forever
 */
export function shouldCloseAfterFailedPromote(
  result: PromoteResult,
  idleForMs: number,
  giveUpAfterMs: number,
): boolean {
  if (result.ok) return false
  // Never reached the server, so nothing was learned about whether it could be
  // saved. Closing here would destroy a savable capture.
  if (result.reason === 'no_token') return false
  // Another save already owns this session. That one wins.
  if (result.status === 409) return idleForMs >= giveUpAfterMs
  // A transport failure, a timeout, or a 5xx is transient: retry next sweep.
  const terminal = result.status >= 400 && result.status < 500
  return terminal || idleForMs >= giveUpAfterMs
}

export interface PromoteOptions {
  port: number
  token: string
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Finalize a stranded session into a meeting through the real save route.
 *
 * Omits `domain` deliberately so the route's own keyword inference files it,
 * rather than dumping every unattended capture into one folder.
 */
export async function promoteStrandedSession(
  sessionId: string,
  options: PromoteOptions,
): Promise<PromoteResult> {
  // No token means this process is not the server that owns the API — a unit test
  // worker, a tool importing the module. Refusing here matters because an
  // unauthenticated POST returns 401, the caller would read a 4xx as terminal, and
  // it would then close a session it could perfectly well have saved. `no_token`
  // is deliberately NOT terminal.
  if (!options.token) return { ok: false, status: 0, reason: 'no_token' }
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 600_000)
  try {
    const res = await doFetch(`http://127.0.0.1:${options.port}/api/meeting/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cos-Token': options.token },
      body: JSON.stringify({ sessionId, title: STRANDED_PROMOTE_TITLE }),
      signal: controller.signal,
    })
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
