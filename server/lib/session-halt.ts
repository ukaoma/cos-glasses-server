// Halt markers: how a cancel from the lens stops a Claude run at the desk (6.53.0).
//
// Miles, 2026-09-21: "If there's a current run that's going, it essentially clicks the
// cancel button ... similar to when they're at the desktop."
//
// COS has no handle on a Desktop tab or a terminal `claude`: nothing it can signal, no
// socket that takes an interrupt. What it does have is the synchronous PreToolUse hook
// every Claude session on this Mac runs (`bin/hooks/cos-session-hook`). So a cancel is a
// FILE: `<data>/session-halt/<session id>`. The hook tests for it before every tool call
// and, when it is there, prints the deny plus `continue: false` that canary C1b proved
// stops the run. The run stops at its NEXT tool call; a reply that is pure text finishes
// first, and the lens copy says "at its next step" for that reason.
//
// WHERE. `dataPath('session-halt')`, beside the spool: the hook finds the folder as
// `$(dirname "$SPOOL")/session-halt`, exactly as it finds the Cursor queue folder, and the
// spool is `<data>/hook-spool` (claude-hooks-installer.ts `hookSpoolDir`). The two agree
// for the same reason the queue folder does.
//
// THE NAME IS THE LOWERCASE SESSION ID, validated. It becomes a path component here and a
// `[ -f ]` test in a shell script, and the script lowercases what it reads, so an upper-case
// file would never match and a malformed one must never be written at all.
//
// LIFETIME. A marker lives only within the run it was written for:
//   - the hook deletes it itself on UserPromptSubmit (a new desk prompt, a Continue
//     delivered into the open session, and a COS `-p` turn all fire it), so a new prompt
//     is never stopped;
//   - the server deletes it on that session's SessionEnd (session-hooks-runtime.ts);
//   - a sweep deletes anything older than HALT_MARKER_TTL_MS.
// It is NOT deleted on Stop: a background subagent reports its parent's session id (C8),
// and it is exactly the work a cancel must also stop.
//
// 6.53.3: ONE exception to "a new prompt clears it": a turn COS itself handed into the open
// session while a cancel was on its way (`haltDeliveredTurn`). That turn's own prompt must
// not be the one that frees it, so the server writes the marker back, once, when it sees it.

import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import { isValidNativeThreadId } from './native-thread-id.js'
import { unwrapPeerMessage } from './session-stream-events.js'

/**
 * How long a marker may outlive its cancel. An hour, not the plan's first 15 minutes: the
 * hook deliberately ignores age (a long build must still be cancellable), so this sweep is
 * the only thing that ends a marker whose session neither prompted again nor ended.
 */
export const HALT_MARKER_TTL_MS = 60 * 60_000

/**
 * 6.53.3 /qa: how long a re-arm waits when the hand-off was NOT verified (`maybe`: the frame
 * may or may not have reached the session). A verified hand-off keeps the marker's hour; an
 * unverified one that has not surfaced as a prompt within two minutes most likely never
 * arrived, and holding it longer only widens the window for an identical desk prompt.
 */
export const HALT_REARM_UNVERIFIED_MS = 2 * 60_000

export interface HaltMarker {
  at: number
  clientCancelId: string
}

export function haltDir(): string {
  return dataPath('session-halt')
}

/** The marker's path, or null for anything that is not a full native session id. */
export function haltMarkerPath(sessionId: string, dir = haltDir()): string | null {
  const id = typeof sessionId === 'string' ? sessionId.toLowerCase() : ''
  return isValidNativeThreadId(id) ? join(dir, id) : null
}

/**
 * Write (or refresh) the marker for one session. Atomic: the hook must never read a torn
 * file, though it only tests existence. False when the id is not a session id or the write
 * failed; the caller must then not report the cancel as accepted.
 */
export function writeHaltMarker(sessionId: string, marker: HaltMarker, dir = haltDir()): boolean {
  const path = haltMarkerPath(sessionId, dir)
  if (path === null) return false
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    atomicWriteFileSync(path, `${JSON.stringify({ at: marker.at, clientCancelId: marker.clientCancelId })}\n`, { mode: 0o600 })
    return true
  } catch (error) {
    console.error(`[session-halt] write failed: ${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.message : error}`)
    return false
  }
}

/** True when a marker was removed. A missing one is not an error. */
export function clearHaltMarker(sessionId: string, dir = haltDir()): boolean {
  const path = haltMarkerPath(sessionId, dir)
  if (path === null) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Clear the marker because the SESSION ended, but only a marker written at or before the
 * event. A SessionEnd drained late from the spool must not remove a cancel written after
 * it for the same session id (a resumed tab reuses its id).
 */
export function clearHaltMarkerOnSessionEnd(sessionId: string, endedAt: number, dir = haltDir()): boolean {
  const path = haltMarkerPath(sessionId, dir)
  if (path === null) return false
  const at = markerAt(path)
  if (at === null || !Number.isFinite(endedAt) || at > endedAt) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 6.53.3 (review A6): a cancel that landed while COS was HANDING a turn to the open session
// ---------------------------------------------------------------------------
//
// The live hop writes the turn into the running session's inbox, where it waits its turn
// (a busy session) or starts at once (an idle one). Once it has landed, the only stop is
// this marker. But the hook deletes the marker on UserPromptSubmit, and the delivered
// turn's OWN UserPromptSubmit may come after the marker is written: a busy session takes
// the message only when its current run ends (which the marker itself brings about). A
// plain write would then be deleted by the very turn it was written to stop.
//
// So the marker is written, and when the delivered turn has not visibly started yet, it is
// written AGAIN, once, on the first UserPromptSubmit for that session AFTER the send, if that
// prompt IS the delivered one. The window is the marker's own hour (two minutes for an
// unverified hand-off); SessionEnd drops it. In memory on purpose: a restart forgets it, like
// every other hold here.
//
// 6.53.3 /qa (Skeptic W1): the first cut matched `prompt.includes(<first 120 characters>)`.
// A short COS prompt ("yes") is inside most desk prompts, so the person's own next prompt
// re-armed the marker: THEIR run was denied "Cancelled from COS", and the delivered turn's
// own prompt, finding nothing pending, then ran the cancelled turn. Now:
//   - EXACT: the delivered words and the prompt's words are equal once whitespace runs are
//     collapsed and Claude Code's peer wrapper ("Another Claude session sent a message: ...",
//     which a live Continue arrives in) is taken off. The frame carries no id of its own and
//     its text is not changed to add one.
//   - FIRST PROMPT DECIDES: the first prompt after the send spends the re-arm whether or not
//     it matches. A non-match is logged (never the prompt). This gives up the cancel when
//     the person's own prompt reaches the session first, rather than risk halting their run:
//     a halted desk run is the worse error, and the lens already said "at its next step".
//   - LIMIT, stated: a desk prompt with exactly the delivered words, typed after the send and
//     taken first, is indistinguishable from the delivered turn and re-arms.

interface PendingRearm {
  marker: HaltMarker
  /** The delivered prompt's words, whitespace-normalised (`normalizePromptWords`). */
  words: string
  /** Prompts submitted before this are someone else's. */
  after: number
  until: number
}

const pendingRearms = new Map<string, PendingRearm>()
const MAX_PENDING_REARMS = 64

/**
 * Write the marker for a turn COS just put into the open session. `rearm` is false when
 * the turn has visibly started already (its UserPromptSubmit ran before this write, so
 * nothing will delete the marker but the next prompt). False when the write failed; the
 * caller must then not report the cancel as armed.
 */
export function haltDeliveredTurn(
  sessionId: string,
  marker: HaltMarker,
  turn: { prompt: string; after: number; rearm: boolean; now?: number; windowMs?: number },
  dir = haltDir(),
): boolean {
  if (!writeHaltMarker(sessionId, marker, dir)) return false
  const id = sessionId.toLowerCase()
  const words = normalizePromptWords(turn.prompt)
  if (!turn.rearm || words.length === 0) {
    pendingRearms.delete(id)
    return true
  }
  const now = turn.now ?? Date.now()
  const windowMs = typeof turn.windowMs === 'number' && Number.isFinite(turn.windowMs) && turn.windowMs > 0
    ? Math.min(turn.windowMs, HALT_MARKER_TTL_MS)
    : HALT_MARKER_TTL_MS
  pendingRearms.delete(id)
  pendingRearms.set(id, { marker, words, after: turn.after, until: now + windowMs })
  while (pendingRearms.size > MAX_PENDING_REARMS) {
    const oldest = pendingRearms.keys().next()
    if (oldest.done) break
    pendingRearms.delete(oldest.value)
  }
  return true
}

/** Whitespace runs collapsed to one space, ends trimmed. Non-strings are empty. */
export function normalizePromptWords(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
}

/**
 * Is `prompt` (a UserPromptSubmit's `prompt`) the delivered prompt? Equal words, compared
 * whole, after taking off Claude Code's peer wrapper when the prompt arrived in one.
 */
export function isDeliveredPrompt(prompt: unknown, delivered: string): boolean {
  const want = normalizePromptWords(delivered)
  if (want.length === 0 || typeof prompt !== 'string') return false
  return normalizePromptWords(unwrapPeerMessage(prompt) ?? prompt) === want
}

/**
 * A UserPromptSubmit from the session itself (never a COS child): the hook has just deleted
 * the session's marker. The FIRST such prompt after the send spends the pending re-arm: when
 * it is the delivered turn's own prompt the marker is written back, otherwise the re-arm is
 * dropped and logged. True when the marker was re-armed.
 */
export function rearmHaltOnPrompt(sessionId: string, promptAt: number, prompt: unknown, dir = haltDir(), now = Date.now()): boolean {
  const id = typeof sessionId === 'string' ? sessionId.toLowerCase() : ''
  const pending = pendingRearms.get(id)
  if (!pending) return false
  if (now > pending.until) {
    pendingRearms.delete(id)
    return false
  }
  if (!Number.isFinite(promptAt) || promptAt < pending.after) return false
  pendingRearms.delete(id)
  if (!isDeliveredPrompt(prompt, pending.words)) {
    console.warn(`[session-halt] re-arm dropped: the first prompt after the hand-off was not the delivered turn session=${id.slice(0, 8)} clientCancelId=${pending.marker.clientCancelId}`)
    return false
  }
  return writeHaltMarker(id, pending.marker, dir)
}

/** The session ended: nothing is left to stop. */
export function dropHaltRearm(sessionId: string): void {
  if (typeof sessionId === 'string') pendingRearms.delete(sessionId.toLowerCase())
}

export function hasPendingHaltRearm(sessionId: string): boolean {
  return typeof sessionId === 'string' && pendingRearms.has(sessionId.toLowerCase())
}

export function __resetHaltRearmsForTests(): void {
  pendingRearms.clear()
}

export function hasHaltMarker(sessionId: string, dir = haltDir()): boolean {
  const path = haltMarkerPath(sessionId, dir)
  if (path === null) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The marker's own `at`, else the file's mtime; null when neither can be read. */
function markerAt(path: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { at?: unknown }
    if (typeof parsed.at === 'number' && Number.isFinite(parsed.at)) return parsed.at
  } catch { /* fall back to the clock the filesystem kept */ }
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/**
 * Remove every marker older than `ttlMs`, and any leftover the atomic write abandoned.
 * Returns how many were removed. A marker dated in the future (a clock step) is judged by
 * its mtime instead, so it cannot live for ever.
 */
export function sweepHaltMarkers(now: number, ttlMs = HALT_MARKER_TTL_MS, dir = haltDir()): number {
  let names: string[]
  try { names = readdirSync(dir) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    const path = join(dir, name)
    let at = markerAt(path)
    if (at !== null && at > now) {
      try { at = statSync(path).mtimeMs } catch { at = null }
    }
    // A name the server would never write (a `.tmp` from a crashed write, anything else)
    // is removed on sight: nothing reads it, and the hook's glob would keep forking for it.
    const foreign = !isValidNativeThreadId(name)
    if (!foreign && at !== null && now - at < ttlMs) continue
    try {
      unlinkSync(path)
      removed++
    } catch { /* already gone, or a directory: leave it */ }
  }
  return removed
}
