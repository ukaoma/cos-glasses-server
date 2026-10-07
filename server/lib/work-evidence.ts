/**
 * Work evidence check (6.66.0, Control 0.5.262): is each part of a card's finish line true yet, and what shows it?
 *
 * WHY. The completion check (work-completion.ts, 6.58.0) reads one session's newest 40 turns, keeps the newest 4,000
 * characters, and asks Jev one question against the whole Done when. On 7 real cards (canary 2026-10-07) it moved none
 * of the 4 known-done ones: their proof was a live page, a Slack post or a meeting, never the session, and a two-part
 * finish line ("page is live; ads are running") was judged as one. This reads the evidence where it lives and judges
 * each clause on its own. Contract: CONTRACT_work_evidence_check_2026-10-07.md (COS repo, operations/personal/wk41_2026).
 *
 * SOURCES, each read-only:
 * - Sessions (the card's follows, at most 4). An INCREMENTAL read: only replies after the follow's cursor (or after
 *   `since` when it has none), and a new cursor back, so evidence never ages out of a fixed window. The cursor is a byte
 *   offset plus the newest record time, checked against the bytes before it, so a rewritten transcript falls back to
 *   time instead of reading garbage. Cursor transcripts carry no times: with no cursor they count from the last handoff
 *   prompt for this card (`COS-WORK <tag>` in a user message). A read that hits its byte limit before reaching the
 *   cursor says `truncated`, which Control reads as unclear.
 *   Tag scoping: with one follow, untagged replies count. With several, only `COS-WORK <tag>` lines for this card count.
 *   A reply whose status lines name only OTHER cards never counts (the thread is serving several cards).
 * - URLs in a clause, fetched through safe-fetch.ts. A pass is a 200, the final URL equal to the one asked for, and the
 *   page carrying marker words from the clause or the card title. A pass is necessary for a clause that names a URL and
 *   never sufficient on its own: Jev still decides whether a live page proves the clause.
 * - Meetings linked to the card: their summary, decisions and action items.
 * - Slack: the COS bridge's cached end-of-day sweep (`slack-evidence`), absent on a public install.
 * Every excerpt is redacted (credentials out) before it reaches TypeSafe or the response.
 *
 * JUDGING. One Jev request for all clauses. Per clause three choices: met / not_met / unclear; what the strongest item
 * reports (fact, intent, draft or none); and which numbered item that is (Jev writes no text, so it picks). Only a fact
 * with a picked item can be met; anything else is reported as unclear. When nothing new arrived since the last check of
 * this card (the same clauses and no evidence item it has not judged), Jev is not asked: the answer repeats the cached
 * verdicts with `skipped: "no_new_evidence"`.
 *
 * COST. Its own ledger (data/jev-work-evidence-usage.json), cap COS_WORK_EVIDENCE_DAILY_TOKENS (default 300,000, about
 * 40 to 60 checks at the 4.5K to 8K tokens measured in plan v2 §7), its own breaker (3 failures, then 1 hour), and a
 * master switch COS_WORK_EVIDENCE (0, false, no or off turns it off). Advice only: the server never moves a card.
 */
import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { dataPath } from './data-dir.js'
import { estimateJevTokens, JevClient, JevError } from './jev.js'
import { agentSessionRoots, findAgentSessionFile, isSafeSessionId, parseJsonLine, type AgentProvider } from './agent-session-store.js'
import { isSafeDomainName } from './domains.js'
import { callPython } from './python-bridge.js'
import { sessionTurnFromRecord, SESSION_TURNS_WINDOWS } from './agent-session-turns.js'
import { boundForRedaction, redactSecretText } from './activity-preview.js'
import { redactSecrets } from './lens-gist-engines.js'
import { safeFetch, SafeFetchError, type SafeFetchMarkers, type SafeFetchResult } from './safe-fetch.js'

export const EVIDENCE_LIMITS = {
  follows: 4, clauses: 6, clauseChars: 300, cursorChars: 512,
  /** A reply is read up to this many characters before it is excerpted. */
  replyChars: 12_000,
  /** Per follow, and for all session items together. */
  sessionItemsPerFollow: 8, sessionItemChars: 1_500, sessionChars: 10_000,
  urls: 6, meetings: 3, meetingChars: 1_200, slackItems: 6, slackItemChars: 500,
  taskChars: 1_200, titleChars: 300, excerptChars: 300,
  /** The redaction never scans more than this of one text. */
  scanChars: 16_000,
  stateEntries: 500, slackTimeoutMs: 15_000,
  defaultDailyTokens: 300_000,
} as const
export const WORK_EVIDENCE_USAGE_FILE = dataPath('jev-work-evidence-usage.json')

export const VERDICTS = ['met', 'not_met', 'unclear'] as const
export const KINDS = ['fact', 'intent', 'draft', 'none'] as const
export type Verdict = typeof VERDICTS[number]
export type EvidenceKind = typeof KINDS[number]
export type EvidenceSource = 'session' | 'url' | 'meeting' | 'slack' | 'file'
const SOURCE_ORDER: EvidenceSource[] = ['session', 'url', 'meeting', 'slack', 'file']

export function workEvidenceDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.COS_WORK_EVIDENCE_DAILY_TOKENS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : EVIDENCE_LIMITS.defaultDailyTokens
}
/** On unless COS_WORK_EVIDENCE says off. Read from the server's environment, so changing it takes a restart. */
export function workEvidenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'no', 'off'].includes((env.COS_WORK_EVIDENCE ?? '').trim().toLowerCase())
}
/** The evidence check's own Jev client: its own ledger, cap and breaker. jev.ts supplies the key and the timeout. */
export function createWorkEvidenceJevClient(fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date(),
                                            usageFile = WORK_EVIDENCE_USAGE_FILE): JevClient {
  return new JevClient(fetchImpl, now, usageFile, () => workEvidenceDailyCap())
}
let sharedClient: JevClient | null = null
export function sharedWorkEvidenceJevClient(): JevClient { return sharedClient ??= createWorkEvidenceJevClient() }

// ---------------------------------------------------------------------------------------------------------------------
// Text

/** Credentials out, bounded, one excerpt. */
export function redactExcerpt(text: string): string {
  return redactSecrets(redactSecretText(boundForRedaction(text, EVIDENCE_LIMITS.scanChars).head))
}
const squash = (text: string) => text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
/** At most `max` characters: the head and the tail of a long text, since a status line opens a reply and a summary ends it. */
export function clipHeadTail(text: string, max: number): string {
  const clean = squash(text)
  if (clean.length <= max) return clean
  const tail = Math.floor(max / 3), head = max - tail - 3
  return `${clean.slice(0, head)} … ${clean.slice(clean.length - tail)}`
}
const clip = (text: string, max: number) => squash(text).slice(0, max).trim()

const STOPWORDS = new Set(('the a an and or of to in on at for from by with is are was were be been being it its this that these those there '
  + 'their they them our we you your has have had will would should could can must may not no yes done make made sure get got all any '
  + 'page pages live site website link links url http https www com net org html into than then also just more most some such very '
  + 'running against driving traffic ready launch launched publish published update updated check checked send sent ship shipped '
  + 'work task card when what which who how about after before over under out new now')
  .split(' '))
/** The distinctive words of a text: 4+ letters or digits, not a stopword. */
export function distinctiveWords(text: string): string[] {
  const words = (text.toLowerCase().replace(/https?:\/\/\S+/g, ' ').match(/[a-z0-9]{4,}/g) ?? []).filter(w => !STOPWORDS.has(w) && !/^\d+$/.test(w))
  return [...new Set(words)]
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi
/** The URLs a clause names, trailing punctuation off, in order, at most EVIDENCE_LIMITS.urls across a check. */
export function clauseUrls(text: string): string[] {
  return [...new Set((text.match(URL_RE) ?? []).map(u => u.replace(/[.,;:!?”’]+$/, '')))]
}

/** Marker words for a URL check: quoted phrases in the clause, else distinctive words of the clause, the title and the
 *  URL's path. The host's own labels never count (every page on bottlepos.com says "Bottle POS"). */
export function markersFor(clause: string, title: string, url: string): SafeFetchMarkers {
  const phrases = [...clause.matchAll(/["“]([^"”]{3,80})["”]/g)].map(m => m[1]!.trim())
  if (phrases.length) return { phrases }
  let host: string[] = [], path = ''
  try { const u = new URL(url); host = u.hostname.toLowerCase().split('.'); path = decodeURIComponent(u.pathname).replace(/[-_/]+/g, ' ') } catch { /* no URL words */ }
  const words = [...new Set([...distinctiveWords(clause), ...distinctiveWords(title), ...distinctiveWords(path)])].filter(w => !host.includes(w))
  return { words, minWords: 2 }
}

/** The same page: scheme, host, path (a trailing slash aside) and query. */
export function sameUrl(a: string, b: string): boolean {
  try {
    const x = new URL(a), y = new URL(b)
    const path = (u: URL) => u.pathname.replace(/\/+$/, '') || '/'
    return x.protocol === y.protocol && x.hostname.toLowerCase() === y.hostname.toLowerCase() && x.port === y.port && path(x) === path(y) && x.search === y.search
  } catch { return false }
}

// ---------------------------------------------------------------------------------------------------------------------
// Status lines (the same reading as COS Control's WorkProgress.reports)

const STATUS_RE = /^COS-WORK\s+([a-f0-9]{12})\s*:\s*(done|needs[ _-]input|blocked)\s*[:\-–—]\s*(.+)$/i
export interface StatusLine { tag: string; state: string; line: string }
export function statusLines(text: string): StatusLine[] {
  const out: StatusLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\*\*|__|`/g, '').trim()
    while (line && '*_>#-•'.includes(line[0]!)) line = line.slice(1).trim()
    while (line && '*_'.includes(line[line.length - 1]!)) line = line.slice(0, -1)
    const m = STATUS_RE.exec(line)
    if (!m) continue
    const evidence = m[3]!.trim()
    if (evidence.length < 3 || evidence.startsWith('<')) continue
    out.push({ tag: m[1]!.toLowerCase(), state: m[2]!.toLowerCase(), line })
  }
  return out
}
/** A handoff prompt carries the instruction `COS-WORK <tag>: <done, needs input or blocked>: …` for its card. */
function mentionsTag(text: string, tags: ReadonlySet<string>): boolean {
  for (const m of text.matchAll(/COS-WORK\s+([a-f0-9]{12})/gi)) if (tags.has(m[1]!.toLowerCase())) return true
  return false
}

// ---------------------------------------------------------------------------------------------------------------------
// Cursors

interface CursorBody { v: 1; id: string; o: number; t: string | null; p: string }
const sessionKey = (provider: AgentProvider, sessionId: string) => createHash('sha256').update(`${provider}:${sessionId.trim().toLowerCase()}`).digest('hex').slice(0, 12)

export function encodeCursor(body: CursorBody): string { return Buffer.from(JSON.stringify(body)).toString('base64url') }
export function decodeCursor(raw: string | null): CursorBody | null {
  if (raw === null || raw.length > EVIDENCE_LIMITS.cursorChars || !/^[A-Za-z0-9_-]+$/.test(raw)) return null
  try {
    const body = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<CursorBody>
    if (body.v !== 1 || typeof body.id !== 'string' || !Number.isSafeInteger(body.o) || body.o! < 0 || typeof body.p !== 'string'
      || (body.t !== null && (typeof body.t !== 'string' || Number.isNaN(Date.parse(body.t))))) return null
    return body as CursorBody
  } catch { return null }
}
/** A cursor's syntax only (the route refuses a malformed one; a stale one is handled on read). */
export function isWellFormedCursor(raw: unknown): boolean { return raw === null || (typeof raw === 'string' && decodeCursor(raw) !== null) }

const PREFIX_BYTES = 64
async function prefixHash(path: string, offset: number): Promise<string> {
  const from = Math.max(0, offset - PREFIX_BYTES), length = offset - from
  if (length === 0) return ''
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, from)
    return createHash('sha256').update(buffer).digest('hex').slice(0, 16)
  } finally { await handle.close() }
}

// ---------------------------------------------------------------------------------------------------------------------
// Session reads

export interface SessionReply { text: string; at?: string }
export interface SessionRead {
  replies: SessionReply[]
  cursor: string
  /** The read hit its byte limit before reaching the cursor (or `since`, or the handoff prompt). */
  truncated: boolean
  /** Untimed transcripts with no cursor: whether the handoff prompt for this card was found. Untagged replies need it. */
  anchored: boolean
}
interface Record_ { obj: Record<string, unknown>; end: number }

/** The complete lines of [from, size), each with the byte offset where it ends; `wholeFirst` false drops a partial head. */
async function readLines(path: string, from: number, size: number, wholeFirst: boolean): Promise<{ records: Record_[]; end: number }> {
  const readFrom = wholeFirst || from === 0 ? from : from - 1
  const length = size - readFrom
  if (length <= 0) return { records: [], end: from }
  const handle = await open(path, 'r')
  const buffer = Buffer.alloc(length)
  try { await handle.read(buffer, 0, length, readFrom) } finally { await handle.close() }
  const lastNewline = buffer.lastIndexOf(0x0a)
  if (lastNewline < 0) return { records: [], end: from }
  const records: Record_[] = []
  let pos = 0
  if (!wholeFirst && from > 0) {
    // One byte before the window: a newline there means the window starts on a whole line.
    const first = buffer.indexOf(0x0a)
    pos = first + 1
  }
  while (pos <= lastNewline) {
    const nl = buffer.indexOf(0x0a, pos)
    const obj = parseJsonLine(buffer.subarray(pos, nl).toString('utf8'))
    if (obj) records.push({ obj, end: readFrom + nl + 1 })
    pos = nl + 1
  }
  return { records, end: readFrom + lastNewline + 1 }
}

const recordTime = (obj: Record<string, unknown>): number | null => {
  const t = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : Number.NaN
  return Number.isNaN(t) ? null : t
}

/**
 * The assistant replies of one transcript that came after `cursor` (or after `sinceMs` when the cursor is null or no
 * longer fits the file), and the cursor for next time.
 *
 * - A cursor that fits (the bytes before its offset unchanged): everything from its offset to the end, unless that is
 *   more than the largest window, in which case the newest window and `truncated`.
 * - Times (Claude, Codex): backward in growing windows until a record older than the floor is in the window; if the
 *   largest window still has none and the file goes back further, `truncated`.
 * - No times (Cursor) and no cursor: replies after the newest user message carrying this card's `COS-WORK` tag; none
 *   found means `anchored: false` (untagged replies then do not count). Nothing at all when the file was last written
 *   before `sinceMs`.
 */
export async function readSessionSince(provider: AgentProvider, sessionId: string, path: string, cursorRaw: string | null, sinceMs: number,
                                       tags: ReadonlySet<string>, windows: readonly number[] = SESSION_TURNS_WINDOWS): Promise<SessionRead> {
  const { size, mtimeMs } = await stat(path)
  const id = sessionKey(provider, sessionId)
  const largest = windows[windows.length - 1]!
  // Another session's cursor is no cursor at all: neither its offset nor its time says anything about this file.
  const decoded = decodeCursor(cursorRaw), cursor = decoded && decoded.id === id ? decoded : null
  const fits = !!cursor && cursor.o <= size && await prefixHash(path, cursor.o) === cursor.p
  let records: Record_[] = [], end = 0, truncated = false, anchored = true
  // Which floor applies when the cursor does not fit: its own time (exclusive), else `since` for a timed transcript,
  // else (Cursor writes no times) the handoff prompt for this card.
  let floorMs: number | null = null, exclusive = false
  const anchorMode = !fits && !cursor?.t && provider === 'cursor'

  if (fits) {
    const from = size - cursor!.o > largest ? size - largest : cursor!.o
    truncated = from > cursor!.o
    ;({ records, end } = await readLines(path, from, size, !truncated))
    if (end < cursor!.o) end = cursor!.o
  } else if (anchorMode && mtimeMs < sinceMs) {
    // Not written since the handoff: nothing new.
    end = size
  } else {
    if (!anchorMode) { floorMs = cursor?.t ? Date.parse(cursor.t) : sinceMs; exclusive = !!cursor?.t }
    const isAnchor = (r: Record_) => { const t = sessionTurnFromRecord(provider, r.obj, EVIDENCE_LIMITS.replyChars); return t?.role === 'user' && mentionsTag(t.text, tags) }
    const reachesFloor = (r: Record_) => { const t = recordTime(r.obj); return t !== null && t < floorMs! }
    let start = size
    for (const window of windows) {
      start = Math.max(0, size - window)
      ;({ records, end } = await readLines(path, start, size, start === 0))
      if (start === 0 || records.some(anchorMode ? isAnchor : reachesFloor)) break
    }
    if (anchorMode) {
      let anchorAt = -1
      records.forEach((r, i) => { if (isAnchor(r)) anchorAt = i })
      anchored = anchorAt >= 0
      truncated = !anchored && start > 0
      records = anchored ? records.slice(anchorAt + 1) : records
    } else {
      truncated = start > 0 && !records.some(reachesFloor)
    }
  }

  const replies: SessionReply[] = []
  let newest = cursor?.t ?? null
  for (const r of records) {
    const time = recordTime(r.obj)
    if (time !== null && (newest === null || time > Date.parse(newest))) newest = new Date(time).toISOString()
    const turn = sessionTurnFromRecord(provider, r.obj, EVIDENCE_LIMITS.replyChars)
    if (!turn || turn.role !== 'assistant') continue
    if (floorMs !== null) {
      // A record without a time inherits nothing: in a timed transcript it is kept (it is inside the window the floor
      // chose), and only a timed reply older than the floor is dropped.
      const at = turn.at ? Date.parse(turn.at) : null
      if (at !== null && (exclusive ? at <= floorMs : at < floorMs)) continue
    }
    replies.push(turn.at ? { text: turn.text, at: turn.at } : { text: turn.text })
  }
  return { replies, cursor: encodeCursor({ v: 1, id, o: end, t: newest, p: await prefixHash(path, end) }), truncated, anchored }
}

// ---------------------------------------------------------------------------------------------------------------------
// The check

export interface EvidenceItem { n: number; source: EvidenceSource; ref: string; excerpt: string; at?: string; text: string; urlPass?: boolean }
export interface ClauseVerdict {
  text: string; verdict: Verdict; confidence: number; kind: EvidenceKind
  evidence: { source: EvidenceSource; ref: string; excerpt: string; at?: string } | null
  deterministic: boolean
  /** Why a met answer was reported as unclear: not_fact, no_evidence, url_not_passed. */
  reason?: string
}
export interface CursorOut { provider: AgentProvider; sessionId: string; cursor: string | null; missing?: true }
export type EvidenceResult =
  | { provider: 'jev'; model: string; basis: 'clauses' | 'title'; clauses: ClauseVerdict[]; sources: EvidenceSource[]; cursors: CursorOut[]
      truncated: boolean; cached: boolean; skipped: 'no_new_evidence' | null; sessionItemsOmitted: number }
  | { provider: 'none'; reason: string; cursors?: CursorOut[]; truncated?: boolean }

export interface EvidenceFollow { provider: AgentProvider; sessionId: string; cursor: string | null }
export interface EvidenceRequest { domain: string; id: string; follows: EvidenceFollow[]; clauses: string[]; since: string }
export interface EvidenceCard { id: string; workIdentity?: string; title: string; text: string; meetingRefs?: Array<{ recordId: string; domain: string; month: string; filename: string; title?: string }> }
export interface MeetingEvidence { recordId: string; title: string; date?: string; summary?: string; decisions?: string[]; actionItems?: Array<{ task: string; owner?: string }> }

export interface WorkEvidenceDeps {
  jev: Pick<JevClient, 'ask'>
  findSession: (provider: AgentProvider, sessionId: string) => Promise<string | null>
  fetchUrl: (url: string, markers: SafeFetchMarkers) => Promise<SafeFetchResult>
  meeting: (ref: NonNullable<EvidenceCard['meetingRefs']>[number]) => Promise<MeetingEvidence | null>
  slack: (query: { domain: string; id: string; since: string }) => Promise<unknown>
  enabled: () => boolean
  now: () => number
  windows: readonly number[]
}

const VERDICT_TEXT = 'Is the finish-line clause in `clauses[{i}]` true now for the task in `task`, going by the numbered items in `evidence`? '
  + 'Choose met only when an item states as a fact that it has already happened: a live check of the page that passed, a report that it '
  + 'shipped, was sent, or is running. A plan, a draft, something ready but waiting on approval, or a promise to do it next is not_met. '
  + 'Choose unclear when no item says enough to tell. An item about a different task, page or campaign does not count.'
const KIND_TEXT = 'What does the strongest item in `evidence` about `clauses[{i}]` actually report?'
const PICK_TEXT = 'Which single item in `evidence` best shows whether `clauses[{i}]` is true? Choose none when no item is about it.'
export const EVIDENCE_QUESTIONS = { VERDICT_TEXT, KIND_TEXT, PICK_TEXT }

/** The most probable option and its probability, refusing an answer outside the offered options. */
export function argmax(probabilities: Record<string, number> | undefined, allowed: readonly string[]): [string, number] {
  const rows = Object.entries(probabilities ?? {})
  if (!rows.length || rows.some(([k, v]) => !allowed.includes(k) || typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
    throw new JevError('jev_bad_answer', 'Jev answered outside the offered options')
  }
  return rows.sort((a, b) => b[1] - a[1])[0] as [string, number]
}

const JEV_REASONS: Record<string, string> = { jev_cap_reached: 'jev_cap', jev_breaker_open: 'jev_breaker' }

interface CardState { judge: string; keys: Set<string>; clauses: ClauseVerdict[]; model: string; basis: 'clauses' | 'title' }

export class WorkEvidenceChecker {
  private state = new Map<string, CardState>()
  constructor(private readonly deps: WorkEvidenceDeps) {}

  /** The master switch, asked before the route reads the board. */
  enabled(): boolean { return this.deps.enabled() }

  async check(req: EvidenceRequest, card: EvidenceCard): Promise<EvidenceResult> {
    if (!this.deps.enabled()) return { provider: 'none', reason: 'evidence_disabled' }
    const title = clip(card.title || card.text, EVIDENCE_LIMITS.titleChars)
    const taskText = clip(card.text || card.title, EVIDENCE_LIMITS.taskChars)
    if (!title && !taskText) return { provider: 'none', reason: 'no_task_text' }
    const basis = req.clauses.length ? 'clauses' as const : 'title' as const
    // The title path judges the card's text; the answer names the card by its title.
    const judged = basis === 'clauses' ? req.clauses.map(c => clip(c, EVIDENCE_LIMITS.clauseChars)) : [taskText]
    const shown = basis === 'clauses' ? judged : [title]
    const tags = new Set([req.id, card.id, card.workIdentity].filter((t): t is string => typeof t === 'string' && /^[a-f0-9]{12}$/i.test(t)).map(t => t.toLowerCase()))
    const sinceMs = Date.parse(req.since)
    const keywords = new Set([...judged.flatMap(distinctiveWords), ...distinctiveWords(title)])

    const [sessions, urls, meetings, slack] = await Promise.all([
      this.sessionItems(req, tags, sinceMs, keywords),
      this.urlItems(judged, title),
      this.meetingItems(card),
      this.slackItems(req),
    ])
    const items: Omit<EvidenceItem, 'n'>[] = [...sessions.items, ...urls, ...meetings, ...slack]
    const numbered: EvidenceItem[] = items.map((item, n) => ({ ...item, n }))
    const sources = SOURCE_ORDER.filter(s => numbered.some(i => i.source === s))
    const cursors = sessions.cursors, truncated = sessions.truncated

    const stateKey = `${req.domain}/${card.id}`
    const judge = createHash('sha256').update(JSON.stringify({ basis, judged, title })).digest('hex')
    const keys = numbered.map(itemKey)
    const prior = this.state.get(stateKey)
    if (prior && prior.judge === judge && keys.every(k => prior.keys.has(k))) {
      return { provider: 'jev', model: prior.model, basis, clauses: prior.clauses, sources, cursors, truncated, cached: true, skipped: 'no_new_evidence', sessionItemsOmitted: sessions.omitted }
    }
    if (!numbered.length) return { provider: 'none', reason: 'no_evidence', cursors, truncated }

    const state = {
      task: { title, text: taskText },
      clauses: judged,
      evidence: numbered.map(i => ({ n: i.n, source: i.source, ...(i.at ? { at: i.at } : {}), text: i.text })),
    }
    const pick: Record<string, string> = Object.fromEntries(numbered.map(i => [`e${i.n}`, `evidence[${i.n}]: ${i.source}, ${clip(i.excerpt, 90)}`]))
    const questions: Record<string, unknown> = {}
    judged.forEach((_, i) => {
      questions[`v${i}`] = { type: 'choice', instructions: VERDICT_TEXT.replaceAll('{i}', String(i)), criteria: {
        met: 'An evidence item shows, as a fact, that this clause is already true.',
        not_met: 'The items show it is not done yet: planned, drafted, ready but waiting, blocked, or failed.',
        unclear: 'No item says enough to tell.',
      } }
      questions[`k${i}`] = { type: 'choice', instructions: KIND_TEXT.replaceAll('{i}', String(i)), criteria: {
        fact: 'It reports the clause as already done or observed true: shipped, live, sent, running, approved.',
        intent: 'It reports a plan, a promise, or that the work is ready but waiting (on sign-off, approval, a date).',
        draft: 'It reports a draft, mock, preview or work in progress.',
        none: 'No item is about this clause.',
      } }
      questions[`e${i}`] = { type: 'choice', instructions: PICK_TEXT.replaceAll('{i}', String(i)), criteria: { ...pick, none: 'No item is about this clause.' } }
    })
    let answers: Awaited<ReturnType<JevClient['ask']>>
    try { answers = await this.deps.jev.ask(state, questions, estimateJevTokens({ state, questions })) } catch (e) {
      if (e instanceof JevError) return { provider: 'none', reason: JEV_REASONS[e.code] ?? e.code }
      throw e
    }
    let clauses: ClauseVerdict[]
    try { clauses = judged.map((_, i) => decideClause(shown[i]!, judged[i]!, numbered, answers.answers, i)) } catch (e) {
      if (e instanceof JevError) return { provider: 'none', reason: e.code }
      throw e
    }
    const model = answers.model ?? 'jev'
    if (this.state.size >= EVIDENCE_LIMITS.stateEntries && !this.state.has(stateKey)) this.state.delete(this.state.keys().next().value!)
    this.state.delete(stateKey)
    this.state.set(stateKey, { judge, keys: new Set(keys), clauses, model, basis })
    return { provider: 'jev', model, basis, clauses, sources, cursors, truncated, cached: false, skipped: null, sessionItemsOmitted: sessions.omitted }
  }

  private async sessionItems(req: EvidenceRequest, tags: ReadonlySet<string>, sinceMs: number, keywords: ReadonlySet<string>) {
    const single = req.follows.length === 1
    let truncated = false, omitted = 0
    const cursors: CursorOut[] = []
    const perFollow: Array<Array<Omit<EvidenceItem, 'n'> & { score: number; order: number }>> = []
    for (const follow of req.follows) {
      const path = await this.deps.findSession(follow.provider, follow.sessionId).catch(() => null)
      if (!path) { cursors.push({ provider: follow.provider, sessionId: follow.sessionId, cursor: follow.cursor, missing: true }); continue }
      let read: SessionRead
      try { read = await readSessionSince(follow.provider, follow.sessionId, path, follow.cursor, sinceMs, tags, this.deps.windows) } catch {
        cursors.push({ provider: follow.provider, sessionId: follow.sessionId, cursor: follow.cursor, missing: true }); continue
      }
      truncated ||= read.truncated
      cursors.push({ provider: follow.provider, sessionId: follow.sessionId, cursor: read.cursor })
      const candidates: Array<Omit<EvidenceItem, 'n'> & { score: number; order: number }> = []
      read.replies.forEach((reply, order) => {
        const lines = statusLines(reply.text)
        const mine = lines.filter(l => tags.has(l.tag)), others = lines.filter(l => !tags.has(l.tag))
        let text: string
        let score: number
        if (mine.length) {
          // A reply that reports on this card. When it reports on other cards too, or the request follows several
          // threads, only this card's own lines count.
          text = single && !others.length ? reply.text : mine.map(l => l.line).join('\n')
          score = Number.MAX_SAFE_INTEGER
        } else if (others.length) {
          return  // it reports on other cards only
        } else {
          if (!single || !read.anchored) return  // untagged: only a thread that follows this one card, from its handoff on
          const lower = reply.text.toLowerCase()
          score = [...keywords].filter(k => lower.includes(k)).length
          text = reply.text
        }
        const excerpt = clipHeadTail(redactExcerpt(text), EVIDENCE_LIMITS.sessionItemChars)
        if (!excerpt) return
        candidates.push({ source: 'session', ref: `${follow.provider}:${follow.sessionId}`, excerpt, text: excerpt, ...(reply.at ? { at: reply.at } : {}), score, order })
      })
      // This card's own status lines first, then replies that use the finish line's words, then the rest; newest first
      // within each.
      const rank = (c: { score: number }) => c.score === Number.MAX_SAFE_INTEGER ? 2 : c.score > 0 ? 1 : 0
      candidates.sort((a, b) => rank(b) - rank(a) || b.order - a.order)
      perFollow.push(candidates)
    }
    const items: Array<Omit<EvidenceItem, 'n'> & { order: number; follow: number }> = []
    let chars = 0
    perFollow.forEach((candidates, follow) => {
      let kept = 0
      for (const c of candidates) {
        if (kept >= EVIDENCE_LIMITS.sessionItemsPerFollow || chars + c.excerpt.length > EVIDENCE_LIMITS.sessionChars) { omitted++; continue }
        kept++; chars += c.excerpt.length
        items.push({ source: c.source, ref: c.ref, excerpt: c.excerpt, text: c.text, ...(c.at ? { at: c.at } : {}), order: c.order, follow })
      }
    })
    items.sort((a, b) => a.follow - b.follow || a.order - b.order)
    return { items: items.map(({ order: _o, follow: _f, ...item }) => item), cursors, truncated, omitted }
  }

  private async urlItems(judged: string[], title: string): Promise<Array<Omit<EvidenceItem, 'n'>>> {
    const wanted: Array<{ url: string; clause: string }> = []
    for (const clause of judged) for (const url of clauseUrls(clause)) {
      if (wanted.length < EVIDENCE_LIMITS.urls && !wanted.some(w => w.url === url)) wanted.push({ url, clause })
    }
    const at = new Date(this.deps.now()).toISOString()
    return Promise.all(wanted.map(async ({ url, clause }) => {
      let excerpt: string, pass = false
      try {
        const r = await this.deps.fetchUrl(url, markersFor(clause, title, url))
        pass = r.status === 200 && sameUrl(r.finalUrl, url) && r.markerFound
        const notes = [r.status !== 200 ? null : !sameUrl(r.finalUrl, url) ? `redirected to ${r.finalUrl}` : !r.markerFound ? 'page text did not match the clause' : null].filter(Boolean)
        excerpt = [`${r.status}`, r.title || '(no title)', ...notes].join(' · ')
      } catch (e) {
        excerpt = `not checked: ${e instanceof SafeFetchError ? e.code : 'fetch_failed'}`
      }
      excerpt = clip(redactExcerpt(excerpt), EVIDENCE_LIMITS.excerptChars)
      const text = `Live check of ${url} just now: ${excerpt}${pass ? '. The page is up at that address and its text matches.' : '. This check did NOT pass.'}`
      return { source: 'url' as const, ref: url, excerpt, at, text, urlPass: pass }
    }))
  }

  private async meetingItems(card: EvidenceCard): Promise<Array<Omit<EvidenceItem, 'n'>>> {
    const out: Array<Omit<EvidenceItem, 'n'>> = []
    for (const ref of (card.meetingRefs ?? []).slice(0, EVIDENCE_LIMITS.meetings)) {
      let m: MeetingEvidence | null
      try { m = await this.deps.meeting(ref) } catch { m = null }
      if (!m || m.recordId !== ref.recordId) continue  // the linked meeting changed or is gone
      const parts = [m.summary ? `Summary: ${m.summary}` : '',
        m.decisions?.length ? `Decisions: ${m.decisions.join('; ')}` : '',
        m.actionItems?.length ? `Action items: ${m.actionItems.map(a => a.owner ? `${a.owner}: ${a.task}` : a.task).join('; ')}` : ''].filter(Boolean)
      if (!parts.length) continue
      const excerpt = clipHeadTail(redactExcerpt(`${m.title}${m.date ? ` (${m.date})` : ''}. ${parts.join(' ')}`), EVIDENCE_LIMITS.meetingChars)
      const at = m.date && !Number.isNaN(Date.parse(m.date)) ? new Date(Date.parse(m.date)).toISOString() : undefined
      out.push({ source: 'meeting', ref: `meeting:${ref.domain}/${ref.month}/${ref.filename}`, excerpt, text: excerpt, ...(at ? { at } : {}) })
    }
    return out
  }

  private async slackItems(req: EvidenceRequest): Promise<Array<Omit<EvidenceItem, 'n'>>> {
    let raw: unknown
    try { raw = await this.deps.slack({ domain: req.domain, id: req.id, since: req.since }) } catch { return [] }
    const body = raw as { available?: unknown; items?: unknown } | null
    if (!body || typeof body !== 'object' || body.available !== true || !Array.isArray(body.items)) return []
    const rows = (body.items as Array<Record<string, unknown>>).filter(r => r && typeof r === 'object' && typeof r.text === 'string' && r.text.trim())
      .map(r => {
        const ts = typeof r.ts === 'string' || typeof r.ts === 'number' ? Number(r.ts) : Number.NaN
        return { r, at: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : undefined, ts: Number.isFinite(ts) ? ts : 0 }
      })
      .sort((a, b) => b.ts - a.ts).slice(0, EVIDENCE_LIMITS.slackItems)
    return rows.map(({ r, at }) => {
      const user = typeof r.user === 'string' ? clip(r.user, 60) : 'someone'
      const channel = typeof r.channel === 'string' ? clip(r.channel, 80).replace(/^#/, '') : ''
      const excerpt = clipHeadTail(redactExcerpt(`${user}${channel ? ` in #${channel}` : ''}: ${r.text as string}`), EVIDENCE_LIMITS.slackItemChars)
      const permalink = typeof r.permalink === 'string' && /^https:\/\/[a-z0-9.-]+\.slack\.com\//i.test(r.permalink) ? r.permalink : null
      const ref = permalink ?? `slack:${channel}:${String(r.ts ?? '')}`
      return { source: 'slack' as const, ref: clip(ref, 300), excerpt, text: excerpt, ...(at ? { at } : {}) }
    })
  }
}

function itemKey(item: EvidenceItem): string {
  return createHash('sha256').update(`${item.source}\u0000${item.ref}\u0000${item.excerpt}\u0000${item.source === 'url' ? '' : item.at ?? ''}`).digest('hex')
}

/** One clause's answer from Jev's three choices, under the rules Jev cannot be trusted to apply. */
export function decideClause(shownText: string, judgedText: string, items: readonly EvidenceItem[],
                             answers: Record<string, { probabilities?: Record<string, number> }>, i: number): ClauseVerdict {
  const verdictP = answers[`v${i}`]?.probabilities
  let [verdict, confidence] = argmax(verdictP, VERDICTS) as [Verdict, number]
  const [kind] = argmax(answers[`k${i}`]?.probabilities, KINDS) as [EvidenceKind, number]
  const [picked] = argmax(answers[`e${i}`]?.probabilities, [...items.map(it => `e${it.n}`), 'none'])
  const item = picked === 'none' ? null : items.find(it => `e${it.n}` === picked) ?? null
  let reason: string | undefined
  const ownUrls = clauseUrls(judgedText)
  if (verdict === 'met') {
    // Only a fact supports met; a picked item is required; a clause that names a page needs that page's check to pass.
    if (kind !== 'fact') reason = 'not_fact'
    else if (!item) reason = 'no_evidence'
    else if ((item.source === 'url' && !item.urlPass) || ownUrls.some(u => !items.some(it => it.source === 'url' && it.ref === u && it.urlPass))) reason = 'url_not_passed'
    if (reason) { verdict = 'unclear'; confidence = Number(verdictP?.unclear ?? 0) }
  }
  return {
    text: shownText, verdict, confidence, kind,
    evidence: item ? { source: item.source, ref: item.ref, excerpt: clip(item.excerpt, EVIDENCE_LIMITS.excerptChars), ...(item.at ? { at: item.at } : {}) } : null,
    deterministic: !!item && item.source === 'url' && item.urlPass === true,
    ...(reason ? { reason } : {}),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The request

const REQUEST_KEYS = ['clauses', 'domain', 'follows', 'id', 'since']
const FOLLOW_KEYS = ['cursor', 'provider', 'sessionId']
const PROVIDERS: readonly string[] = ['claude', 'codex', 'cursor']

/** The contract's request, exactly: these five keys, bounded lists, safe names. Null for anything else (HTTP 400). */
export function parseEvidenceRequest(body: unknown): EvidenceRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  if (Object.keys(b).sort().join(',') !== REQUEST_KEYS.join(',')) return null
  if (typeof b.domain !== 'string' || !isSafeDomainName(b.domain) || typeof b.id !== 'string' || !/^[a-f0-9]{12}$/.test(b.id)) return null
  if (typeof b.since !== 'string' || b.since.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(b.since) || Number.isNaN(Date.parse(b.since))) return null
  if (!Array.isArray(b.follows) || b.follows.length > EVIDENCE_LIMITS.follows) return null
  if (!Array.isArray(b.clauses) || b.clauses.length > EVIDENCE_LIMITS.clauses) return null
  const follows: EvidenceFollow[] = [], seen = new Set<string>()
  for (const f of b.follows as unknown[]) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return null
    const r = f as Record<string, unknown>
    if (Object.keys(r).sort().join(',') !== FOLLOW_KEYS.join(',')) return null
    if (typeof r.provider !== 'string' || !PROVIDERS.includes(r.provider)) return null
    if (typeof r.sessionId !== 'string' || r.sessionId.length > 200 || !isSafeSessionId(r.sessionId)) return null
    if (!isWellFormedCursor(r.cursor)) return null
    const key = `${r.provider}:${r.sessionId.trim().toLowerCase()}`
    if (seen.has(key)) return null
    seen.add(key)
    follows.push({ provider: r.provider as AgentProvider, sessionId: r.sessionId, cursor: r.cursor as string | null })
  }
  const clauses: string[] = []
  for (const c of b.clauses as unknown[]) {
    if (typeof c !== 'string' || c.length > EVIDENCE_LIMITS.clauseChars || !c.trim() || /[\x00-\x08\x0b-\x1f\x7f]/.test(c)) return null
    clauses.push(c.trim())
  }
  return { domain: b.domain, id: b.id, follows, clauses, since: b.since }
}

// ---------------------------------------------------------------------------------------------------------------------
// Defaults

/** The COS bridge's cached Slack sweep. A standalone install answers `{}`, an older COS `{error}`: both read as absent. */
export function bridgeSlackEvidence(query: { domain: string; id: string; since: string }): Promise<unknown> {
  return callPython(['slack-evidence', '--domain', query.domain, '--id', query.id, '--since', query.since], EVIDENCE_LIMITS.slackTimeoutMs)
}

export function defaultWorkEvidenceDeps(overrides: Partial<WorkEvidenceDeps> = {}): WorkEvidenceDeps {
  return {
    jev: sharedWorkEvidenceJevClient(),
    findSession: (provider, sessionId) => findAgentSessionFile(provider, sessionId, agentSessionRoots()),
    fetchUrl: (url, markers) => safeFetch(url, markers),
    meeting: async () => null,
    slack: bridgeSlackEvidence,
    enabled: () => workEvidenceEnabled(),
    now: () => Date.now(),
    windows: SESSION_TURNS_WINDOWS,
    ...overrides,
  }
}
