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
import { draftsFromLine, type SessionStreamProvider } from './session-stream-events.js'
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
 * REUSES `draftsFromLine`, the same parser the live stream uses, so "the turn ended"
 * means exactly here what it means there. Hand-rolling a second `type === 'result'`
 * check is how two definitions of done drift apart.
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
      let ended = false
      for (const line of lines) {
        if (!line.trim()) continue
        for (const draft of draftsFromLine(provider, line)) {
          if (draft.kind === 'status') ended = draft.state === 'done'
        }
      }
      return ended
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}
