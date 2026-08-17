// Phase 2: row-level push for a session COS did not spawn.
//
// There is no pipe. COS never started that desktop process, so the ONLY observable is
// the transcript file it appends to. This tails that file and emits each new JSONL
// record through the same grammar and the same envelope Phase 1 uses.
//
// WHAT THIS CAN AND CANNOT DO, stated plainly because the UI must not pretend
// otherwise: Claude Code writes a COMPLETE record per message, so a long reply appears
// ALL AT ONCE when it finishes. This is row-level push, not token streaming, and the
// asymmetry with a Continue turn cannot be engineered away from a file.
//
// ---------------------------------------------------------------------------
// WHY A STAT POLL AND NOT `fs.watch`
// ---------------------------------------------------------------------------
// `fs.watch` was considered and rejected. On macOS it coalesces rapid writes, so a
// burst of records can arrive as one event or, during a rename or an atomic replace,
// as none: the kFSEvents backend keeps watching the old inode and simply stops firing,
// with no error and no callback. A watcher that goes silent is indistinguishable from
// a session that went quiet, which is the exact failure class this repo has been
// burned by repeatedly -- absence of a signal read as absence of activity.
//
// A `stat` every second is one syscall per second per OPEN session detail view. It
// cannot miss a write, because it does not observe writes at all: it observes SIZE,
// and size is cumulative. If three records land between two ticks, the next read
// returns all three. Slower to first byte by up to a second, and incapable of the
// silent-death mode. That trade is correct here.
//
// ---------------------------------------------------------------------------
// OFFSET, AND THE 587 KB RECORD
// ---------------------------------------------------------------------------
// Reading forward from a byte offset, never a tail window. The tail window in
// `agent-session-store.ts` exists for a one-shot digest of a huge file and it has a
// measured hazard: a single JSONL record can exceed 768 KiB. This Mac's own largest
// transcript holds four such records, the biggest 1,239,046 bytes. A tail read that
// opens mid-record drops it whole and silently.
//
// Forward reading has no window, so record size is simply not a variable: a record of
// any length up to `MAX_READ_BYTES` is delivered intact the moment it is complete. The
// only bound is per TICK, not per record, so a burst larger than the cap drains across
// several ticks instead of allocating it all at once. Re-reading the 81 MB file per
// change, the thing the plan forbids, never happens: the cursor only ever reads the
// bytes appended since the last tick.
//
// The pathological case is explicit rather than silent, and it does NOT try to be clever.
// A record LARGER than `MAX_READ_BYTES` cannot be assembled without unbounded memory, so
// the tailer emits a terminal `done` and DEGRADES TO THE POLL, which has no such bound.
// `MAX_READ_BYTES` is 4 MiB, 3.2x the largest record measured on this machine, so this is
// a safety valve rather than an expected path.
//
// Skipping the record instead was tried first and was wrong twice over. It wedged: after
// discarding the oversized bytes the leftover in the same chunk still looked capped, so
// the GOOD record behind it was skipped too, on every tick, forever -- zero events, not
// even a status. And even working it would have silently dropped a reply the user was
// waiting to read. Arriving 5 seconds later through the poll beats never arriving.

import { constants as fsConstants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { draftsFromLine, type SessionStreamProvider } from './session-stream-events.js'
import { isAttachedTurnActive, publishSessionStream, type PublishedSessionEvent } from './session-stream-bus.js'
import type { SessionStreamDraft } from './session-stream-events.js'

/** Bytes read per tick. See the header for why this is a per-tick and not a per-record bound. */
export const MAX_READ_BYTES = 4 * 1024 * 1024

/** Stat cadence. Deliberately unremarkable; see the header. */
export const POLL_INTERVAL_MS = 1_000

/**
 * Quiet before a tailing session is called idle.
 *
 * Longer than a poll interval by a wide margin, because a model thinking between tool
 * calls writes nothing for tens of seconds and is not idle. This flag exists so a
 * client can tell a live-but-quiet stream from a finished one; it must not flicker.
 */
export const IDLE_AFTER_MS = 45_000

/** Cursor position in the file. Forward-only; see the header. */
export interface TranscriptCursor {
  offset: number
}

export interface ConsumeResult {
  cursor: TranscriptCursor
  lines: string[]
  /**
   * One record exceeded a whole tick's budget, so this stream cannot carry it.
   * The caller must stop and let the poll take over. See the header.
   */
  tooLarge?: boolean
}

/**
 * Advance the cursor over one freshly read chunk.
 *
 * PURE. No fs, no clock. Everything subtle about the offset strategy lives here so it
 * can be tested by execution rather than by reading it.
 *
 * `capped` means the read filled `MAX_READ_BYTES` and more bytes are pending, which is
 * the ONLY condition under which "no newline in this chunk" proves an oversized record
 * rather than a record still being written.
 */
export function consumeTranscriptChunk(
  cursor: TranscriptCursor,
  chunk: Buffer,
  capped: boolean,
): ConsumeResult {
  const last = chunk.lastIndexOf(0x0a)

  if (last < 0) {
    // Nothing completed in this chunk. Leave the cursor where it is so the partial
    // record is re-read next tick; that is what makes a 587 KB record arrive whole.
    // If the read was FULL, though, re-reading it will never terminate: hand it off.
    return capped
      ? { cursor, lines: [], tooLarge: true }
      : { cursor, lines: [] }
  }

  const lines = chunk.subarray(0, last).toString('utf8').split('\n').filter(line => line.length > 0)
  return { cursor: { offset: cursor.offset + last + 1 }, lines }
}

export interface TranscriptTailerOptions {
  key: string
  path: string
  provider: SessionStreamProvider
  /** Start position. Production passes the file's current size: no history replay. */
  offset: number
  now?: () => number
  publish?: (key: string, draft: SessionStreamDraft) => void
  /** True while a COS-spawned turn is the live writer. Suppresses emission, not advance. */
  suppressed?: (key: string) => boolean
  maxReadBytes?: number
  idleAfterMs?: number
}

export interface TranscriptTailer {
  /** One stat-and-read pass. Resolves; never rejects. */
  tick(): Promise<void>
  cursor(): TranscriptCursor
  /** Last state this tailer published, or null if it has published none. */
  state(): 'working' | 'idle' | 'done' | null
  /** True once this tailer has handed off to the poll. Terminal; never clears. */
  degraded(): boolean
}

/**
 * Read a byte range with the flags this repo requires everywhere.
 *
 * `O_NONBLOCK` because an `open` on a FIFO with no writer never returns, and a planted
 * path has wedged this entire server three times. `O_NOFOLLOW` because a symlinked
 * `<id>.jsonl` could point at any file on disk and be streamed as session records.
 * `fsPromises.open` also keeps the syscall off the event loop thread, unlike the
 * `openSync` sites those incidents involved.
 */
async function readRangeAt(path: string, offset: number, length: number): Promise<Buffer | null> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const nonBlock = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow | nonBlock)
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    return buffer.subarray(0, bytesRead)
  } catch {
    // Deleted, replaced by a symlink, permissions changed mid-session. The next tick
    // tries again; a read failure is never reported as session inactivity.
    return null
  } finally {
    // Opened per tick rather than held: a transcript replaced by a new inode would
    // otherwise be tailed forever at the wrong file, with no error.
    await handle?.close().catch(() => {})
  }
}

export function createTranscriptTailer(options: TranscriptTailerOptions): TranscriptTailer {
  const now = options.now ?? (() => Date.now())
  const publish = options.publish ?? ((key, draft) => { publishSessionStream(key, draft) })
  const suppressed = options.suppressed ?? isAttachedTurnActive
  const maxRead = options.maxReadBytes ?? MAX_READ_BYTES
  const idleAfter = options.idleAfterMs ?? IDLE_AFTER_MS

  let cursor: TranscriptCursor = { offset: Math.max(0, options.offset) }
  let state: 'working' | 'idle' | 'done' | null = null
  let lastActivity = now()
  let degraded = false

  const emit = (draft: SessionStreamDraft) => {
    try {
      publish(options.key, draft)
    } catch {
      /* a failed publish must not stop the cursor from advancing */
    }
  }

  return {
    cursor: () => ({ ...cursor }),
    state: () => state,
    degraded: () => degraded,
    async tick(): Promise<void> {
      // Terminal. Once the poll owns this session, continuing to stat and re-read a 4 MiB
      // range every second would burn syscalls to produce nothing, forever.
      if (degraded) return
      try {
        let size: number
        try {
          const st = await stat(options.path)
          if (!st.isFile()) return
          size = st.size
        } catch {
          return
        }

        if (size < cursor.offset) {
          // Truncated or replaced. Re-reading an 81 MB file from zero is the one thing
          // this design exists to avoid, so we rejoin at the new end and let the poll
          // fallback carry whatever the rotation took with it.
          cursor = { offset: size }
          return
        }

        if (size > cursor.offset) {
          const pending = size - cursor.offset
          const length = Math.min(pending, maxRead)
          const chunk = await readRangeAt(options.path, cursor.offset, length)
          if (chunk !== null && chunk.length > 0) {
            const result = consumeTranscriptChunk(cursor, chunk, chunk.length >= maxRead)
            cursor = result.cursor
            if (result.tooLarge) {
              // HAND OFF, do not skip. `done` is the same terminal status a finished turn
              // sends, so the client already knows to close the stream and resume its
              // 5s/15s/60s poll -- no new client vocabulary, no frozen screen.
              //
              // Self-healing: the watcher is torn down when the last subscriber releases,
              // and a fresh one starts at the file's CURRENT size, which is already past
              // this record. A reconnect therefore streams normally again.
              degraded = true
              state = 'done'
              emit({ kind: 'status', state: 'done' })
              return
            }
            if (result.lines.length > 0) {
              lastActivity = now()
              // SUPPRESSED, NOT SKIPPED. A COS-spawned turn is already streaming these
              // same records from stdout; emitting them again would double every line.
              // The cursor still advanced above, so when the turn ends the tailer is
              // already past them and replays nothing.
              if (!suppressed(options.key)) {
                if (state !== 'working') {
                  state = 'working'
                  emit({ kind: 'status', state: 'working' })
                }
                for (const line of result.lines) {
                  for (const draft of draftsFromLine(options.provider, line)) emit(draft)
                }
              }
            }
          }
        }

        if (state === 'working' && now() - lastActivity >= idleAfter) {
          state = 'idle'
          emit({ kind: 'status', state: 'idle' })
        }
      } catch {
        /* a tick that throws is a tick that produced nothing; the next one retries */
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Ref-counted lifetime
// ---------------------------------------------------------------------------

interface WatcherEntry {
  refs: number
  timer: ReturnType<typeof setInterval>
  ticking: boolean
  tailer: TranscriptTailer
}

const watchers = new Map<string, WatcherEntry>()

export interface AcquireWatcherOptions {
  key: string
  path: string
  provider: SessionStreamProvider
  /** Where to start. Production passes the file's current size. */
  offset: number
  intervalMs?: number
}

/**
 * Start tailing, or join a tail already running for this session.
 *
 * ONE WATCHER PER SESSION, ref-counted, torn down on the LAST release. Two glasses on
 * the same session must not mean two pollers on an 81 MB file, and a release that
 * fires twice must not tear down a tail another subscriber still holds.
 */
export function acquireTranscriptWatcher(options: AcquireWatcherOptions): () => void {
  const existing = watchers.get(options.key)
  if (existing) {
    existing.refs++
    return releaseOnce(options.key)
  }

  const tailer = createTranscriptTailer(options)
  const timer = setInterval(() => {
    const entry = watchers.get(options.key)
    if (!entry) return
    // A tick still in flight when the next one fires would read the same range twice
    // and emit every record twice. Skipping is correct: size is cumulative, so the
    // next tick sees everything the skipped one would have.
    if (entry.ticking) return
    entry.ticking = true
    void tailer.tick().finally(() => { entry.ticking = false })
  }, options.intervalMs ?? POLL_INTERVAL_MS)
  // Never hold the process open. A tail is a view, not work.
  if (typeof (timer as any).unref === 'function') (timer as any).unref()

  watchers.set(options.key, { refs: 1, timer, ticking: false, tailer })
  return releaseOnce(options.key)
}

function releaseOnce(key: string): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    const entry = watchers.get(key)
    if (!entry) return
    entry.refs--
    if (entry.refs > 0) return
    clearInterval(entry.timer)
    watchers.delete(key)
  }
}

export function watchedTranscriptCount(): number {
  return watchers.size
}

/**
 * Has this session's tail handed off to the poll?
 *
 * The SSE route asks this so it can END the response instead of holding a socket that
 * heartbeats forever and will never carry another record. Without that, the client's
 * liveness check keeps reading `live` off the heartbeats and the footer keeps saying
 * `stream` while the poll is quietly doing all the work -- which is precisely the
 * "absence of a signal read as health" failure this repo keeps paying for.
 *
 * False for a session with no watcher, which includes every COS-spawned turn: those
 * stream from a pipe and never degrade this way.
 */
export function transcriptWatcherDegraded(key: string): boolean {
  return watchers.get(key)?.tailer.degraded() ?? false
}

export function __resetTranscriptWatchersForTests(): void {
  for (const entry of watchers.values()) clearInterval(entry.timer)
  watchers.clear()
}

export type { PublishedSessionEvent }
