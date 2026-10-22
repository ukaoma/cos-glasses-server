// Live cue verdicts (6.79.0): a durable log of every cue the v2 engine emitted, and Miles's rating of each one, so the bar,
// spacing and repeat rules can be tuned on rated cues rather than on the trace alone.
//
// live-cues-log.jsonl: one row per emitted cue, appended before the cue is held or emitted (so a fast rating never 404s),
// mode 0600. Unlike the trace it carries transcript text: `before`, the last 400 characters of what was said before the cue,
// so a cue can be judged against it. `before` is blanked after 7 days and the row dropped after 30. The reader validates
// every line and skips (and counts) anything else, so a torn line or a hand-seeded row with a typo never breaks history.
// live-cues-verdicts.json: { v: 1, verdicts: { [cueId]: { verdict?, note?, vote?, at } } }, atomic write, last write wins.
// An unreadable or corrupt verdicts file fails closed: it is left byte for byte and every write is refused, because a
// read-modify-write from an empty map would erase the week's ratings.
//
// Concurrency: every read-modify-write here is synchronous fs from read to rename, so two requests on the event loop can
// never interleave inside one. No maintenance lease: a history poll must never hold up an update drain.
//
// Standalone on purpose: verdicts and history work with v2 off, and a v2-off server must never build the engine (it
// constructs the Jev and SubQ clients). The route passes in which meeting the running engine, if any, holds the cue for.

import { appendFileSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { dataPath } from './data-dir.js'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { errMsg } from './utils.js'
import { getMeetingStore } from './meeting-store.js'
import { findCosOperationsMeetingBySessionId, findDirectLibraryMeetingBySessionId } from './cos-operations-meetings.js'
import { CUE_FEEDBACK_REASON_MAX, isCueKind, type CueKind, type CueSourceRef, type LiveCuesV2MemorySource } from '../../shared/live-cues-v2.js'
import type { WouldWithhold } from './live-cues-filter.js'

// ── Wire types (server-local: shared/live-cues-v2.ts is hash-pinned with the companion copy) ──
export const LIVE_CUE_VERDICTS_PROTOCOL = 1 as const
/** `before`: the last characters (code points) said before the cue, whitespace-collapsed. */
export const CUE_BEFORE_MAX = 400
export const CUE_VERDICTS = ['useful', 'late', 'repeat', 'wrong', 'obvious'] as const
export type CueVerdict = typeof CUE_VERDICTS[number]
export type CueVote = 'up' | 'down'
export type CueTitleSource = 'saved' | 'library' | 'capture'

/** One line of live-cues-log.jsonl. `armedAt`, `prompt`, `memorySource` and `kept` are absent on rows seeded by hand. */
export interface LiveCueLogRow {
  v: 1
  cueId: string
  sessionId: string
  /** The arm-time title as-is ("G2 Recording 2026-10-19 0741"); history resolves the saved title. */
  meetingTitle: string
  createdAt: number
  armedAt?: number
  /** reinforce | challenge, or (6.86.0, meetings with the extended kinds) decision | promise | followUp. */
  kind: CueKind
  headline: string
  detail: string
  gate: number
  sources: CueSourceRef[]
  model: string
  /** Writer rules version (v2, v3; v4 and later read the same way, so rows from a newer writer are never skipped). */
  prompt?: string
  memorySource?: LiveCuesV2MemorySource
  /** Notes the judge kept for the writer. */
  kept?: number
  /** Shadow owner/date template rules (never enforced): would this cue be withheld per meeting, or per topic. */
  wouldWithhold?: WouldWithhold
  before: string
}
/** A history row's rating. `verdict` null with a `vote` is a lens vote alone: unrated. */
export interface CueRating { verdict: CueVerdict | null; note?: string; vote?: CueVote; at: number }
export interface LiveCueHistoryRow extends LiveCueLogRow { title: string; titleSource: CueTitleSource; rating: CueRating | null }
export interface LiveCuesHistoryResponse {
  v: 1
  cues: LiveCueHistoryRow[]
  /** After the sessionId filter, before `unrated` and `limit`. */
  counts: { total: number; rated: number; unrated: number; byVerdict: Record<CueVerdict, number> }
  /** The newest `limit` rows were kept and older ones cut. */
  truncated: boolean
  /** Log lines that were not a valid cue row (torn, foreign, bad seed). */
  skipped: number
}
export interface LiveCuesVerdictResponse { ok: true; cueId: string; verdict: CueVerdict | null; vote: CueVote | null }

const DAY_MS = 24 * 60 * 60_000
export const LIVE_CUE_VERDICT_LIMITS = {
  retentionMs: 30 * DAY_MS,
  /** `before` (transcript text) is blanked on rows older than this; the rest of the row stays for the retention window. */
  beforeRetentionMs: 7 * DAY_MS,
  pruneEveryMs: DAY_MS,
  titleCacheMs: 60_000,
  maxDays: 30,
  defaultDays: 7,
  defaultLimit: 200,
  maxLimit: 1000,
  maxSessionIds: 5,
} as const

/** The `before` excerpt: whitespace-collapsed, the last CUE_BEFORE_MAX code points (never half a surrogate pair). */
export function cueBefore(said: string): string {
  return Array.from(said.replace(/\s+/g, ' ').trim()).slice(-CUE_BEFORE_MAX).join('')
}
/** A note as stored: whitespace-collapsed, truncated at CUE_FEEDBACK_REASON_MAX like the lens reason. */
export function cleanNote(note: string | undefined): string {
  return (note ?? '').replace(/\s+/g, ' ').trim().slice(0, CUE_FEEDBACK_REASON_MAX)
}
export function isCueVerdict(value: unknown): value is CueVerdict {
  return typeof value === 'string' && (CUE_VERDICTS as readonly string[]).includes(value)
}

const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const optional = (v: unknown, ok: (x: unknown) => boolean) => v === undefined || ok(v)
function isWouldWithhold(v: unknown): boolean {
  const w = v as Partial<WouldWithhold> | null
  return !!w && typeof w === 'object' && typeof w.perMeeting === 'boolean' && typeof w.perTopic === 'boolean' && optional(w.blockerCueId, str)
}
/** The full row schema. Hand-seeded rows must pass it too (`before: ""` and no optional fields are fine). */
export function isLogRow(value: unknown): value is LiveCueLogRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return r.v === 1 && str(r.cueId) && r.cueId.length > 0 && str(r.sessionId) && r.sessionId.length > 0 && str(r.meetingTitle)
    && num(r.createdAt) && isCueKind(r.kind)
    && str(r.headline) && str(r.detail) && num(r.gate) && str(r.model) && str(r.before)
    && Array.isArray(r.sources) && r.sources.every(s => !!s && typeof s === 'object' && str((s as CueSourceRef).id) && str((s as CueSourceRef).date) && str((s as CueSourceRef).title))
    && optional(r.armedAt, num) && optional(r.prompt, p => typeof p === 'string' && /^v\d{1,2}$/.test(p))
    && optional(r.memorySource, m => m === 'cue_memory' || m === 'notes' || m === 'none') && optional(r.kept, num)
    && optional(r.wouldWithhold, isWouldWithhold)
}

export class LiveCueLog {
  /** Parsed rows keyed by the file's identity, so a 15 s poll does not reparse megabytes on the event loop. */
  private cache: { key: string; rows: LiveCueLogRow[]; skipped: number } | null = null
  constructor(private readonly file: string) {}

  /** Throws on failure: the engine records it on the evaluation's trace row. */
  append(row: LiveCueLogRow): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    // A torn last line (a crash or failure mid-append) must not glue onto this row: start on a fresh line.
    const lead = this.endsMidLine() ? '\n' : ''
    appendFileSync(this.file, lead + JSON.stringify(row) + '\n', { mode: 0o600 })
  }

  /** Also the regular-file gate for append: a FIFO planted at this path would block the event loop forever on a
   *  blocking open, so it is opened non-blocking and refused before appendFileSync ever opens it. */
  private endsMidLine(): boolean {
    const nonBlock = constants.O_NONBLOCK ?? 0, noFollow = constants.O_NOFOLLOW ?? 0
    let fd: number
    try { fd = openSync(this.file, constants.O_RDONLY | nonBlock | noFollow) } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
      throw error
    }
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) throw new Error('the cue log is not a regular file')
      const size = st.size
      if (size === 0) return false
      const last = Buffer.alloc(1)
      readSync(fd, last, 0, 1, size - 1)
      return last[0] !== 0x0a
    } finally { closeSync(fd) }
  }

  /** Every valid row in file order, and how many non-blank lines were skipped. Never throws. */
  read(): { rows: LiveCueLogRow[]; skipped: number } {
    let key = ''
    try {
      const st = statSync(this.file)
      if (!st.isFile()) return { rows: [], skipped: 0 }        // never readFileSync a FIFO: it blocks the event loop
      key = `${st.ino}:${st.size}:${st.mtimeMs}`
    } catch { return { rows: [], skipped: 0 } }
    if (this.cache?.key === key) return { rows: this.cache.rows, skipped: this.cache.skipped }
    let text = ''
    try { text = readFileSync(this.file, 'utf8') } catch { return { rows: [], skipped: 0 } }
    const rows: LiveCueLogRow[] = []
    let skipped = 0
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let value: unknown
      try { value = JSON.parse(line) } catch { skipped += 1; continue }
      if (isLogRow(value)) rows.push(value); else skipped += 1
    }
    this.cache = { key, rows, skipped }
    return { rows, skipped }
  }

  /** The first logged row for this cue, under any meeting. */
  find(cueId: string): LiveCueLogRow | null {
    return this.read().rows.find(r => r.cueId === cueId) ?? null
  }

  /** Drops rows past retention and blanks `before` on rows past 7 days. Rewrites only when something changed; synchronous
   *  read, filter and rename, so an append (also synchronous, same process) cannot land mid-rewrite. Null when there is
   *  no log, otherwise the cueIds kept. */
  prune(nowMs: number): { dropped: number; blanked: number; kept: Set<string> } | null {
    if (!existsSync(this.file)) return null
    const { rows } = this.read()
    const cutoff = nowMs - LIVE_CUE_VERDICT_LIMITS.retentionMs
    const textCutoff = nowMs - LIVE_CUE_VERDICT_LIMITS.beforeRetentionMs
    let blanked = 0
    const keep = rows.filter(r => r.createdAt >= cutoff).map(r => {
      if (r.createdAt >= textCutoff || r.before === '') return r
      blanked += 1
      return { ...r, before: '' }
    })
    const dropped = rows.length - keep.length
    if (dropped || blanked) durableAtomicWriteFileSync(this.file, keep.map(r => JSON.stringify(r) + '\n').join(''), { mode: 0o600 })
    return { dropped, blanked, kept: new Set(keep.map(r => r.cueId)) }
  }
}

export class VerdictsUnreadableError extends Error {
  readonly code = 'verdicts_unreadable'
  constructor(message: string) { super(message); this.name = 'VerdictsUnreadableError' }
}

interface StoredVerdict { verdict?: CueVerdict; note?: string; vote?: CueVote; at: number }
interface VerdictFile { v: 1; verdicts: Record<string, StoredVerdict> }

export class LiveCueVerdictStore {
  constructor(private readonly file: string) {}

  /** Missing is empty. Unreadable or not the expected shape throws, and the file is left exactly as it is. */
  read(): Record<string, StoredVerdict> {
    if (!existsSync(this.file)) return {}
    let parsed: unknown
    try {
      // Never readFileSync a FIFO or a device: it blocks the event loop.
      if (!statSync(this.file).isFile()) throw new Error('not a regular file')
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      console.error(`[live-cue-verdicts] ${this.file} is unreadable; ratings are refused until it is fixed or moved: ${errMsg(error)}`)
      throw new VerdictsUnreadableError(errMsg(error))
    }
    const verdicts = (parsed as Partial<VerdictFile> | null)?.verdicts
    if (!verdicts || typeof verdicts !== 'object' || Array.isArray(verdicts)) {
      console.error(`[live-cue-verdicts] ${this.file} is not a verdicts file; ratings are refused until it is fixed or moved`)
      throw new VerdictsUnreadableError('not a verdicts file')
    }
    const out: Record<string, StoredVerdict> = {}
    for (const [cueId, r] of Object.entries(verdicts)) {
      if (!r || typeof r !== 'object' || typeof r.at !== 'number') continue
      const rec: StoredVerdict = { at: r.at }
      if (isCueVerdict(r.verdict)) rec.verdict = r.verdict
      if (rec.verdict && typeof r.note === 'string' && r.note) rec.note = r.note
      if (r.vote === 'up' || r.vote === 'down') rec.vote = r.vote
      if (rec.verdict || rec.vote) out[cueId] = rec
    }
    return out
  }

  write(verdicts: Record<string, StoredVerdict>): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    durableAtomicWriteFileSync(this.file, JSON.stringify({ v: 1, verdicts } satisfies VerdictFile) + '\n', { mode: 0o600 })
  }

  /** Drops records whose cue left the log. */
  prune(kept: Set<string>): number {
    const all = this.read()
    const gone = Object.keys(all).filter(id => !kept.has(id))
    if (!gone.length) return 0
    for (const id of gone) delete all[id]
    this.write(all)
    return gone.length
  }
}

function ratingOf(rec: StoredVerdict | undefined): CueRating | null {
  if (!rec) return null
  return { verdict: rec.verdict ?? null, ...(rec.note ? { note: rec.note } : {}), ...(rec.vote ? { vote: rec.vote } : {}), at: rec.at }
}

/** The saved meeting's title for a capture: this server's own save first, then the COS meeting library (including a
 *  merged scribe that declares the capture). Best effort; null when neither knows it. */
export function resolveSavedTitle(sessionId: string): { title: string; source: 'saved' | 'library' } | null {
  try { const m = getMeetingStore().findBySessionId(sessionId); if (m?.title) return { title: m.title, source: 'saved' } } catch { /* next */ }
  try { const m = findCosOperationsMeetingBySessionId(sessionId); if (m?.title) return { title: m.title, source: 'library' } } catch { /* next */ }
  try { const m = findDirectLibraryMeetingBySessionId(sessionId); if (m?.title) return { title: m.title, source: 'library' } } catch { /* none */ }
  return null
}

export interface LiveCueVerdictsDeps {
  log: LiveCueLog
  store: LiveCueVerdictStore
  now(): number
  trace(row: Record<string, unknown>): void
  resolveTitle(sessionId: string): { title: string; source: 'saved' | 'library' } | null
}

export type VerdictResult = { ok: true; response: LiveCuesVerdictResponse } | { ok: false; error: 'unknown_cue' | 'cue_session_mismatch' }

export class LiveCueVerdicts {
  private lastPruneAt = 0
  private readonly titles = new Map<string, { at: number; value: { title: string; source: 'saved' | 'library' } | null }>()
  constructor(readonly deps: LiveCueVerdictsDeps) {}

  /** From the engine, before the cue is held or emitted. Throws on failure (the engine traces it and carries on). */
  logCue(row: LiveCueLogRow): void {
    this.deps.log.append(row)
    this.maybePrune()
  }

  /** The meeting this cue belongs to: the running engine's (`liveOwner`), else the log's. Null when unknown. */
  private owner(cueId: string, liveOwner: string | null): string | null {
    return liveOwner ?? this.deps.log.find(cueId)?.sessionId ?? null
  }

  /** Throws VerdictsUnreadableError when the verdicts file cannot be read; nothing is written then. */
  rate(input: { sessionId: string; cueId: string; verdict: CueVerdict | 'clear'; note?: string }, liveOwner: string | null): VerdictResult {
    this.maybePrune()
    const owner = this.owner(input.cueId, liveOwner)
    if (!owner) return { ok: false, error: 'unknown_cue' }
    if (owner !== input.sessionId) return { ok: false, error: 'cue_session_mismatch' }
    const all = this.deps.store.read()
    const prev = all[input.cueId]
    const at = this.deps.now()
    const note = cleanNote(input.note)
    // clear drops the verdict and its note and keeps the lens vote; the record goes only when nothing is left.
    const next: StoredVerdict = { at, ...(prev?.vote ? { vote: prev.vote } : {}) }
    if (input.verdict !== 'clear') { next.verdict = input.verdict; if (note) next.note = note }
    if (next.verdict || next.vote) all[input.cueId] = next; else delete all[input.cueId]
    this.deps.store.write(all)
    // The trace never carries the note or any transcript text.
    this.trace({ kind: 'feedback', at: new Date(at).toISOString(), sessionId: input.sessionId, cueId: input.cueId, verdict: input.verdict, knownCue: true, ...(note && input.verdict !== 'clear' ? { noted: true } : {}) })
    return { ok: true, response: { ok: true, cueId: input.cueId, verdict: next.verdict ?? null, vote: next.vote ?? null } }
  }

  /** The lens vote, beside any verdict and never over it, for a cue known under this meeting. Throws
   *  VerdictsUnreadableError like rate(); the vote route's own answer is unchanged either way. */
  vote(sessionId: string, cueId: string, vote: CueVote, liveOwner: string | null): void {
    if (this.owner(cueId, liveOwner) !== sessionId) return
    const all = this.deps.store.read()
    all[cueId] = { ...all[cueId], vote, at: this.deps.now() }
    this.deps.store.write(all)
  }

  /** Oldest first. With more rows than `limit`, the NEWEST `limit` are kept (truncated: true). Throws
   *  VerdictsUnreadableError rather than report every cue as unrated. */
  history(q: { days: number; sessionIds?: string[]; unrated: boolean; limit: number }): LiveCuesHistoryResponse {
    this.maybePrune()
    const cutoff = this.deps.now() - q.days * DAY_MS
    const verdicts = this.deps.store.read()
    const { rows: logged, skipped } = this.deps.log.read()
    const sessions = q.sessionIds?.length ? new Set(q.sessionIds) : null
    const seen = new Set<string>()
    const rows = logged
      .filter(r => r.createdAt >= cutoff && (!sessions || sessions.has(r.sessionId)))
      .filter(r => { if (seen.has(r.cueId)) return false; seen.add(r.cueId); return true })
      .sort((a, b) => a.createdAt - b.createdAt)
    const byVerdict = Object.fromEntries(CUE_VERDICTS.map(v => [v, 0])) as Record<CueVerdict, number>
    let rated = 0
    for (const r of rows) { const v = verdicts[r.cueId]?.verdict; if (v) { byVerdict[v] += 1; rated += 1 } }
    const wanted = rows.filter(r => !q.unrated || !verdicts[r.cueId]?.verdict)
    const page = wanted.slice(-q.limit)
    return {
      v: 1,
      cues: page.map((r): LiveCueHistoryRow => {
        const saved = this.title(r.sessionId)
        return { ...r, title: saved?.title ?? r.meetingTitle, titleSource: saved?.source ?? 'capture', rating: ratingOf(verdicts[r.cueId]) }
      }),
      counts: { total: rows.length, rated, unrated: rows.length - rated, byVerdict },
      truncated: wanted.length > q.limit,
      skipped,
    }
  }

  /** Every logged cue for one meeting, whatever its age (for the per-meeting count once the engine's counter expired). */
  loggedCues(sessionId: string): number {
    return new Set(this.deps.log.read().rows.filter(r => r.sessionId === sessionId).map(r => r.cueId)).size
  }

  private title(sessionId: string): { title: string; source: 'saved' | 'library' } | null {
    const nowMs = this.deps.now()
    const hit = this.titles.get(sessionId)
    if (hit && nowMs - hit.at < LIVE_CUE_VERDICT_LIMITS.titleCacheMs) return hit.value
    let value: { title: string; source: 'saved' | 'library' } | null = null
    try { value = this.deps.resolveTitle(sessionId) } catch { value = null }
    this.titles.set(sessionId, { at: nowMs, value })
    return value
  }

  /** Rows past retention, `before` past 7 days, and the verdicts of cues that left the log. Never throws. */
  prune(): void {
    this.lastPruneAt = this.deps.now()
    try {
      const log = this.deps.log.prune(this.deps.now())
      // No log at all is not "every cue left": leave the verdicts alone.
      const gone = log ? this.deps.store.prune(log.kept) : 0
      if (log?.dropped || log?.blanked || gone) {
        console.log(`[live-cue-verdicts] pruned ${log?.dropped ?? 0} cue(s) past 30 days, blanked ${log?.blanked ?? 0} excerpt(s) past 7 days, dropped ${gone} verdict(s)`)
      }
    } catch (error) {
      console.warn(`[live-cue-verdicts] prune failed: ${errMsg(error)}`)
    }
  }

  /** First use in this process (there is no boot hook and nothing runs at import), then at most once a day. */
  maybePrune(): void {
    if (this.deps.now() - this.lastPruneAt < LIVE_CUE_VERDICT_LIMITS.pruneEveryMs) return
    this.prune()
  }

  private trace(row: Record<string, unknown>): void {
    try { this.deps.trace(row) } catch { /* trace is best effort */ }
  }
}

let singleton: LiveCueVerdicts | null = null
export function liveCueVerdicts(): LiveCueVerdicts {
  if (!singleton) {
    const traceFile = dataPath('live-cues-trace.jsonl')
    singleton = new LiveCueVerdicts({
      log: new LiveCueLog(dataPath('live-cues-log.jsonl')),
      store: new LiveCueVerdictStore(dataPath('live-cues-verdicts.json')),
      now: () => Date.now(),
      // The same trace file and feedback row shape as the engine's lens votes (live-cues-v2.ts realDeps).
      trace(row) { mkdirSync(dirname(traceFile), { recursive: true, mode: 0o700 }); appendFileSync(traceFile, JSON.stringify(row) + '\n', { mode: 0o600 }) },
      resolveTitle: resolveSavedTitle,
    })
  }
  return singleton
}
