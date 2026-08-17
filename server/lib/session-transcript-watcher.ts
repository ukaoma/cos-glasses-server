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
// The pathological case is explicit rather than silent. A record LARGER than
// `MAX_READ_BYTES` cannot be assembled without unbounded memory, so the cursor enters
// a skip state, discards until the next newline, and resumes. `MAX_READ_BYTES` is 4
// MiB, 3.2x the largest record measured on this machine.

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

/** Cursor position in the file, plus whether we are inside an oversized record. */
export interface TranscriptCursor {
  offset: number
  skipping: boolean
}

export interface ConsumeResult {
  cursor: TranscriptCursor
  lines: string[]
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
  let offset = cursor.offset
  let buf = chunk

  if (cursor.skipping) {
    const idx = buf.indexOf(0x0a)
    if (idx < 0) {
      // Still inside the oversized record. Consume and stay skipping.
      return { cursor: { offset: offset + buf.length, skipping: true }, lines: [] }
    }
    offset += idx + 1
    buf = buf.subarray(idx + 1)
  }

  const last = buf.lastIndexOf(0x0a)
  if (last < 0) {
    if (capped) {
      // No newline in a FULL read: the record at the cursor is larger than a whole
      // tick's budget. Skip it deliberately rather than buffering it without bound.
      return { cursor: { offset: offset + buf.length, skipping: true }, lines: [] }
    }
    // An incomplete record, still being appended. Leave the cursor where it is and
    // re-read it next tick; that is what makes a 587 KB record arrive whole.
    return { cursor: { offset, skipping: false }, lines: [] }
  }

  const lines = buf.subarray(0, last).toString('utf8').split('\n').filter(line => line.length > 0)
  return { cursor: { offset: offset + last + 1, skipping: false }, lines }
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
  state(): 'working' | 'idle' | null
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

  let cursor: TranscriptCursor = { offset: Math.max(0, options.offset), skipping: false }
  let state: 'working' | 'idle' | null = null
  let lastActivity = now()

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
    async tick(): Promise<void> {
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
          cursor = { offset: size, skipping: false }
          return
        }

        if (size > cursor.offset) {
          const pending = size - cursor.offset
          const length = Math.min(pending, maxRead)
          const chunk = await readRangeAt(options.path, cursor.offset, length)
          if (chunk !== null && chunk.length > 0) {
            const result = consumeTranscriptChunk(cursor, chunk, chunk.length >= maxRead)
            cursor = result.cursor
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

  watchers.set(options.key, { refs: 1, timer, ticking: false })
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

export function __resetTranscriptWatchersForTests(): void {
  for (const entry of watchers.values()) clearInterval(entry.timer)
  watchers.clear()
}

export type { PublishedSessionEvent }
