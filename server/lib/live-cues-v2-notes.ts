// Live cues v2 notes fallback (6.76.2). When cue_memory.py is missing, fails or times out (any Mac but Miles's has no such
// script), the memory arm looks in the owner's own COS instead, with no model call and no query leaving the Mac:
//   - searchMemories and searchMeetingLibrary, the search the Live COS Ask uses, in its keyword-only mode (semantic: false),
//   - the memory bridge listing (`cos_api_bridge.py memory`, what COS Control's Memory list shows). The public memory
//     runtime 0.1.0 serves the owner's notes ONLY there: its bot_memory.py has no `search` command, so searchMemories'
//     meaning arm answers memory_parse_error and its keyword arm reads only markdown memory folders. Listed notes are
//     scored here with the same scoreKeywordMatch the library uses.
// The window is never sent as a query. A few salient words are taken from it, and the candidates are ranked by
// reciprocal rank fusion (k=60, as cue_memory.py does). The Jev or SubQ judge then decides relevance, exactly as for
// cue_memory candidates. The whole arm is bounded by the 3 s dense budget of cue_memory.py. Nothing here logs.

import { callPython } from './python-bridge.js'
import { searchMemories, type ContextSearchHit } from './context-library-search.js'
import { scoreKeywordMatch, searchMeetingLibrary, tokenizeMeetingQuery, type MeetingSearchHit } from './meeting-library-search.js'

/** Mirrors cue_memory.py DENSE_BUDGET_S: the notes arm never takes longer than its dense arm may. */
export const NOTES_BUDGET_MS = 3_000
export const NOTES_TOP = 4
const RRF_K = 60
const NOTE_CHARS = 520
const TITLE_CHARS = 90
const BRIDGE_DAYS = 3650
const BRIDGE_LIMIT = 200

export interface NoteCandidate { id: string; date: string; title: string; notes: string; key: string }
export interface NotesResult { notes: NoteCandidate[]; error?: string }
export interface BridgeMemory { id: string; content: string; summary?: string; created_at?: string }

export interface NotesSearchers {
  memories(query: string, signal: AbortSignal): Promise<ContextSearchHit[]>
  meetings(query: string, signal: AbortSignal): Promise<MeetingSearchHit[]>
  bridge(signal: AbortSignal, timeoutMs: number): Promise<BridgeMemory[]>
}

// cue_memory.py STOP, plus conversational filler that ASR produces and that would match every note.
const STOP = new Set(`a an the and or but if then so of to in on at for with from by as is are was were be been being it its this that these those
i you he she we they me him her us them my your our their what which who whom whose when where why how all any both each few more most other
some such no nor not only own same than too very can will just don should now do does did doing have has had having would could might must
shall may yeah yes okay ok like um uh gonna wanna kind sort really right know think going get got one two also there here about into over again
further once out up down off say said says thing things lot gotta yep nope hmm mhm let lets thats theres dont didnt doesnt cant wont isnt im ive
youre were theyre hes shes its okay alright actually basically literally maybe probably pretty much well good great cool sure thank thanks
because cause want wanted need needs make made take took come came look looking see saw tell told talk talking mean means time today tomorrow
yesterday week year day back still even something someone anything everything nothing way guess feel`.split(/\s+/).filter(Boolean))

// Capitalised in every sentence position, so a capital says nothing about them being a name.
const CALENDAR = new Set('monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december'.split(' '))

/** The most salient words of the window, most salient first: frequency, a bonus for the last ~600 characters (what the
 *  room is on now, the slice cue_memory.py embeds) and for a capitalised use mid-sentence (likely a name). Tokens use the
 *  library tokenizer's alphabet ([a-z0-9]) so every term can match. */
export function notesQueryTerms(window: string, max = 6): string[] {
  const recentFrom = Math.max(0, window.length - 600)
  const stats = new Map<string, { n: number; recent: boolean; proper: boolean; last: number }>()
  for (const m of window.matchAll(/[A-Za-z0-9]+/g)) {
    const raw = m[0], term = raw.toLowerCase(), at = m.index ?? 0
    if (term.length < 3 || STOP.has(term) || /^\d{1,2}$/.test(term)) continue
    const st = stats.get(term) ?? { n: 0, recent: false, proper: false, last: 0 }
    st.n += 1
    st.last = at
    if (at >= recentFrom) st.recent = true
    const before = window.slice(Math.max(0, at - 2), at)
    if (/^[A-Z]/.test(raw) && !/[.!?\n]\s*$/.test(before) && at > 0) st.proper = true
    stats.set(term, st)
  }
  return [...stats.entries()]
    .map(([term, st]) => ({ term, score: st.n + (st.recent ? 0.5 : 0) + (st.proper && !CALENDAR.has(term) ? 1 : 0), last: st.last }))
    .sort((a, b) => b.score - a.score || b.last - a.last)
    .slice(0, max)
    .map(x => x.term)
}

/** Two keyword queries: the top four terms (a note must share two of them, or one in its title, to match) and the top
 *  two (either one matches). Distinct, in that order. */
export function notesQueries(terms: string[]): string[] {
  const qs = [terms.slice(0, 4).join(' '), terms.slice(0, 2).join(' ')].filter(q => q.trim())
  return [...new Set(qs)]
}

/** A note's LOCAL calendar day: `before` is a local day (the engine's "tomorrow"), and a memory written at 22:00 Central
 *  carries a UTC timestamp dated the next day. A bare YYYY-MM-DD is already a local day. */
export function localDateOf(v: unknown): string {
  if (typeof v !== 'string') return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) return ''
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString('en-CA') : ''
}
const dateOf = localDateOf
const flat = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

function memoryCandidate(hit: ContextSearchHit): NoteCandidate | null {
  if (!hit.id) return null
  return { id: '', date: dateOf(hit.created_at), title: flat(hit.title || hit.id, TITLE_CHARS), notes: flat(hit.snippet || hit.title, NOTE_CHARS), key: `memory:${hit.id}` }
}
function meetingCandidate(hit: MeetingSearchHit): NoteCandidate | null {
  if (!hit.recordId) return null
  return { id: '', date: dateOf(hit.date), title: flat(hit.title, TITLE_CHARS), notes: flat(hit.snippet || hit.title, NOTE_CHARS), key: `meeting:${hit.recordId}` }
}
function bridgeCandidate(row: BridgeMemory): NoteCandidate {
  const firstLine = row.content.split('\n').find(l => l.trim()) ?? row.id
  return { id: '', date: dateOf(row.created_at), title: flat(row.summary || firstLine, TITLE_CHARS), notes: flat(row.content, NOTE_CHARS), key: `memory:${row.id}` }
}

/** Bridge rows ranked for one query, best first, with the library's own keyword scorer. */
export function rankBridgeMemories(rows: BridgeMemory[], query: string): BridgeMemory[] {
  const tokens = tokenizeMeetingQuery(query)
  return rows.map(row => ({ row, score: scoreKeywordMatch(tokens, row.summary || '', `${row.summary || ''}\n${row.content}`).score }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score).map(x => x.row)
}

export function normalizeBridgeMemories(value: unknown): BridgeMemory[] {
  if (!Array.isArray(value)) return []
  const out: BridgeMemory[] = []
  for (const row of value.slice(0, BRIDGE_LIMIT)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const r = row as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id.trim().slice(0, 170) : ''
    const content = typeof r.content === 'string' ? r.content : ''
    if (!id || !content.trim()) continue
    out.push({ id, content, ...(typeof r.summary === 'string' ? { summary: r.summary } : {}), ...(typeof r.created_at === 'string' ? { created_at: r.created_at } : {}) })
  }
  return out
}

export const realNotesSearchers: NotesSearchers = {
  memories: async (query, signal) => (await searchMemories({ query, limit: 10, semantic: false, signal })).hits,
  meetings: async (query, signal) => (await searchMeetingLibrary({ query, limit: 10, semantic: false, signal })).hits,
  bridge: async (signal, timeoutMs) => normalizeBridgeMemories(await callPython(['memory', '--days', String(BRIDGE_DAYS), '--limit', String(BRIDGE_LIMIT)], timeoutMs, undefined, signal)),
}

/**
 * Candidates for the judge from the owner's own COS. `before` is exclusive (YYYY-MM-DD), like cue_memory.py; a note with
 * no date is kept. `sessionId` drops the meeting being recorded if the library already holds a copy of it. Never throws:
 * a source that fails is skipped, and running out of budget returns what was found so far with `error: notes_timeout`.
 */
export async function notesMemory(window: string, before: string, signal: AbortSignal,
  opts: { sessionId?: string; budgetMs?: number; searchers?: NotesSearchers; top?: number } = {}): Promise<NotesResult> {
  const budgetMs = opts.budgetMs ?? NOTES_BUDGET_MS
  const searchers = opts.searchers ?? realNotesSearchers
  const top = opts.top ?? NOTES_TOP
  const terms = notesQueryTerms(window)
  if (!terms.length) return { notes: [], error: 'notes_no_terms' }
  const queries = notesQueries(terms)
  const local = new AbortController()
  const onAbort = () => local.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) local.abort()

  const fused = new Map<string, { c: NoteCandidate; score: number }>()
  const failed: string[] = []
  const add = (list: Array<NoteCandidate | null>) => {
    list.forEach((c, rank) => {
      if (!c) return
      if (c.date && c.date >= before) return
      const prev = fused.get(c.key)
      fused.set(c.key, { c: prev?.c ?? c, score: (prev?.score ?? 0) + 1 / (RRF_K + rank) })
    })
  }
  const dropLive = (hits: MeetingSearchHit[]) => hits.filter(h => !(opts.sessionId && h.sessionId === opts.sessionId))

  const work = (async () => {
    const bridge = searchers.bridge(local.signal, budgetMs).catch(() => { failed.push('bridge'); return [] as BridgeMemory[] })
    for (const q of queries) {
      if (local.signal.aborted) return
      try { add((await searchers.memories(q, local.signal)).map(memoryCandidate)) } catch { failed.push('memories') }
      if (local.signal.aborted) return
      try { add(dropLive(await searchers.meetings(q, local.signal)).map(meetingCandidate)) } catch { failed.push('meetings') }
    }
    const rows = await bridge
    if (local.signal.aborted) return
    for (const q of queries) add(rankBridgeMemories(rows, q).map(bridgeCandidate))
  })()

  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = await Promise.race([
    work.then(() => false),
    new Promise<boolean>(r => { timer = setTimeout(() => r(true), budgetMs) }),
  ])
  clearTimeout(timer)
  local.abort()
  signal.removeEventListener('abort', onAbort)
  const notes = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, top)
    .map(({ c }, i) => ({ ...c, id: `M${i + 1}` }))
  if (signal.aborted) return { notes: [] }
  if (timedOut) return { notes, error: 'notes_timeout' }
  return failed.length ? { notes, error: `notes_${[...new Set(failed)].sort().join('_')}_failed` } : { notes }
}
