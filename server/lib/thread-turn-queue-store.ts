// Durable storage for queued thread turns, and the terminal-record probe.
//
// SEPARATE FROM THE DECISIONS. `thread-turn-queue.ts` is pure and holds every rule;
// this file only reads and writes. That split is what lets the rules be tested by
// execution instead of by reading them.
//
// ONE FILE PER THREAD, under the data home so it survives a server update -- the
// generation directory is replaced wholesale on every Update Server, and a queue that
// lived there would be silently emptied by a routine upgrade. Same lesson as the
// stranded voice profiles.

import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import { turnFromTail, type SessionStreamProvider } from './session-stream-events.js'
import { pruneQueue, type QueuedThreadTurn } from './thread-turn-queue.js'

/** Bytes of transcript tail read to decide whether the last turn ended. */
export const TURN_END_TAIL_BYTES = 64 * 1024

function queueDir(): string {
  const dir = dataPath('thread-turn-queue')
  try { mkdirSync(dir, { recursive: true }) } catch { /* the write below reports it */ }
  return dir
}

/**
 * One file per (provider, thread).
 *
 * The thread id is validated by the caller before it reaches here, but it is still
 * sanitised: this value becomes a PATH, and a route that forgets its guard must not
 * turn into a directory traversal.
 */
export function queuePath(provider: string, threadId: string): string {
  const safe = `${provider}-${threadId}`.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(queueDir(), `${safe}.json`)
}

/** The queue for a thread, pruned. A missing or corrupt file reads as empty. */
export function readQueue(provider: string, threadId: string, now: number): QueuedThreadTurn[] {
  const path = queuePath(provider, threadId)
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!Array.isArray(parsed)) return []
    // Corrupt rows are dropped individually rather than discarding the whole queue:
    // one bad record must not lose the other turns someone is waiting on.
    const rows = parsed.filter((r): r is QueuedThreadTurn =>
      !!r && typeof r === 'object'
      && typeof (r as QueuedThreadTurn).clientTurnId === 'string'
      && typeof (r as QueuedThreadTurn).prompt === 'string'
      && typeof (r as QueuedThreadTurn).queuedAt === 'number')
    return pruneQueue(rows, now)
  } catch {
    return []
  }
}

/** Replace a thread's queue. Atomic, so a crash mid-write cannot truncate it. */
export function writeQueue(provider: string, threadId: string, queue: readonly QueuedThreadTurn[]): void {
  atomicWriteFileSync(queuePath(provider, threadId), `${JSON.stringify(queue, null, 2)}\n`)
}

/**
 * How many WAITING follow-ups a list/detail row should show (6.48.1).
 *
 * Queue files are named with the native thread id (often a full UUID). Claude
 * list rows stay on the registry's 8-character form until a transcript match
 * expands them. An exact match always wins; an 8-character id is allowed to
 * count a unique prefix among waiting queues of that provider, and an
 * ambiguous prefix counts as zero rather than guessing.
 *
 * PURE: the store builds the input from disk; this decides the number.
 */
export function queuedWaitingForSession(
  queues: ReadonlyArray<{ provider: string; threadId: string; waiting: number }>,
  provider: string, sessionId: string,
): number {
  const id = sessionId.toLowerCase()
  const rows = queues.filter(q => q.provider === provider && q.waiting > 0)
  const exact = rows.find(q => q.threadId.toLowerCase() === id)
  if (exact) return exact.waiting
  if (id.length !== 8) return 0
  const prefixed = rows.filter(q => q.threadId.toLowerCase().startsWith(id))
  const owners = new Set(prefixed.map(q => q.threadId.toLowerCase()))
  if (owners.size !== 1) return 0
  return prefixed[0]!.waiting
}

/** One lookup for a whole list/search request: one directory read, then O(1) per row. */
export function queuedWaitingLookup(now: number): (provider: string, sessionId: string) => number {
  const queues = queuedThreadKeys().map(({ provider, threadId }) => ({
    provider,
    threadId,
    waiting: readQueue(provider, threadId, now).filter(t => t.status === 'waiting').length,
  }))
  return (provider, sessionId) => queuedWaitingForSession(queues, provider, sessionId)
}

export function queuedTurnsFields(count: number): { queued_turns?: number } {
  return count > 0 ? { queued_turns: count } : {}
}

/** Every thread with a queue file, for the drain sweep. */
export function queuedThreadKeys(): Array<{ provider: string; threadId: string }> {
  try {
    return readdirSync(queueDir())
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const base = f.slice(0, -5)
        const dash = base.indexOf('-')
        return dash > 0
          ? { provider: base.slice(0, dash), threadId: base.slice(dash + 1) }
          : null
      })
      .filter((v): v is { provider: string; threadId: string } => v !== null)
  } catch {
    return []
  }
}

/**
 * Did the holder's last turn END?
 *
 * 6.48.1: decided by `turnFromTail`, the transcript's own rule (a terminal
 * `stop_reason` with no tool_use awaiting its result, a `result` row, or a user
 * interrupt). It replaced the status-draft loop here because a Desktop transcript
 * writes no `result` row, so the old rule could only ever say "ended" for a
 * `claude -p` run and every Desktop Continue waited the 30 s idle backstop (measured
 * 2026-09-15: 0 of 30 newest transcripts carry one). The live feed still narrates
 * from `draftsFromLine`; the two are pinned to agree on recorded tails.
 *
 * Reads a bounded tail, newest record wins. Returns false on any doubt -- an
 * unreadable transcript is not evidence a turn finished, and false only means the
 * queue HOLDS, which is always the safe answer.
 */
export function transcriptTurnEnded(provider: SessionStreamProvider, path: string | null): boolean {
  if (!path || !existsSync(path)) return false
  try {
    // BOTH flags, and both are load-bearing -- hazard-invariants.test.ts enforces
    // them and each is right on its own terms. O_NOFOLLOW: a symlinked `<id>.jsonl`
    // could point at any file on disk and would be parsed here as a transcript.
    // O_NONBLOCK: `openSync` on a FIFO with no writer NEVER RETURNS, and it is a
    // synchronous syscall on Node's single thread, so one planted path would stop
    // health, meeting save and transcribe-stream along with this drain. That one is
    // recorded in the repo as three reproductions of the same bug, >34s to SIGKILL.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - TURN_END_TAIL_BYTES)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      const lines = buf.toString('utf-8').split('\n')
      // The first line of a tail read is almost always a fragment.
      if (start > 0) lines.shift()
      return turnFromTail(provider, lines).ended
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}
