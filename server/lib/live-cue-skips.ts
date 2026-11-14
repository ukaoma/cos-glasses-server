/**
 * The build after 7.0.42 (Memories C, lead 2026-11-14 15:58 and 16:03; Work card task:personal:ce1f04b2f016): "Skip this
 * meeting", known to the server so the Memories page, the rail, Today (status needsYou.meetings) and every device count
 * the same meetings to rate.
 *
 * A skip is { sessionId: { at } } in its own file, live-cues-skips.json, kept apart from the verdicts file so no older
 * client or server ever reads it: a rollback only makes skipped meetings reappear as unrated. A skip covers the cues
 * already shown when it was made (LiveCueVerdicts.unratedSessionCount): a cue logged after it brings the meeting back.
 * It expires SKIP_TTL_MS after `at` (the cue log's 7-day edge), dropped on read. At most MAX_MEETING_SKIPS live skips:
 * one past that is refused, never written, and nothing is evicted to make room.
 *
 * Nothing here logs a session id or any cue text.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { durableAtomicWriteFileSync } from './atomic-fs.js'

const DAY_MS = 24 * 60 * 60_000
/** A skip lasts as long as the cues it covers stay in the 7-day window. */
export const SKIP_TTL_MS = 7 * DAY_MS
/** Live skips at most. Seven days of meetings is far below this; a write past it is refused, not trimmed. */
export const MAX_MEETING_SKIPS = 500

export class SkipsUnreadableError extends Error {
  readonly code = 'skips_unreadable'
  constructor(message: string) { super(message); this.name = 'SkipsUnreadableError' }
}

interface SkipFile { v: 1; skips: Record<string, { at: number }> }

export type SkipWriteResult =
  | { ok: true; sessionId: string; skippedAt: number | null }
  | { ok: false; error: 'skips_full' }

export class LiveCueSkipStore {
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  /** Live skips, sessionId to `at`. Missing is none. Unreadable or not the expected shape throws (never "no skips"),
   *  and the file is left as it is. An expired or malformed entry is left out. */
  read(): Record<string, number> {
    if (!existsSync(this.file)) return {}
    let parsed: unknown
    try {
      // Never readFileSync a FIFO or a device: it blocks the event loop.
      if (!statSync(this.file).isFile()) throw new Error('not a regular file')
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      console.error('[live-cue-skips] the skips file is unreadable:', error instanceof Error ? error.name : 'error')
      throw new SkipsUnreadableError(error instanceof Error ? error.name : 'unreadable')
    }
    const skips = (parsed as Partial<SkipFile> | null)?.skips
    if ((parsed as Partial<SkipFile> | null)?.v !== 1 || !skips || typeof skips !== 'object' || Array.isArray(skips)) {
      console.error('[live-cue-skips] the skips file is not a skips file')
      throw new SkipsUnreadableError('not a skips file')
    }
    const cutoff = this.now() - SKIP_TTL_MS
    const out: Record<string, number> = {}
    for (const [sessionId, entry] of Object.entries(skips)) {
      const at = (entry as { at?: unknown } | null)?.at
      if (typeof at === 'number' && Number.isFinite(at) && at > cutoff) out[sessionId] = at
    }
    return out
  }

  /** Skip a meeting now (again: the time moves to now). Refused past MAX_MEETING_SKIPS live skips. Throws on an
   *  unreadable file, writing nothing. */
  skip(sessionId: string): SkipWriteResult {
    const live = this.read()
    if (!(sessionId in live) && Object.keys(live).length >= MAX_MEETING_SKIPS) return { ok: false, error: 'skips_full' }
    const at = this.now()
    live[sessionId] = at
    this.write(live)
    return { ok: true, sessionId, skippedAt: at }
  }

  /** Undo a skip. A meeting that was not skipped is already in that state: nothing is written. */
  clear(sessionId: string): SkipWriteResult {
    const live = this.read()
    if (!(sessionId in live)) return { ok: true, sessionId, skippedAt: null }
    delete live[sessionId]
    this.write(live)
    return { ok: true, sessionId, skippedAt: null }
  }

  private write(live: Record<string, number>): void {
    const skips: SkipFile['skips'] = {}
    for (const [sessionId, at] of Object.entries(live)) skips[sessionId] = { at }
    durableAtomicWriteFileSync(this.file, JSON.stringify({ v: 1, skips } satisfies SkipFile) + '\n', { mode: 0o600 })
  }
}
