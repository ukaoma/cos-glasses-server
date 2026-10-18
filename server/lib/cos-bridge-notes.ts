// The owner's notes as the memory bridge lists them, searched by keyword, and reciprocal rank fusion (6.76.2). Shared by
// the live cues notes fallback (live-cues-v2-notes.ts) and the Live COS Ask (searchAskHistory in live-cos-ask.ts).
//
// Why the listing: the public memory runtime 0.1.0 serves the owner's notes ONLY through `cos_api_bridge.py memory` (what
// COS Control's Memory list shows). Its bot_memory.py has no `search` command, so searchMemories' meaning arm answers
// memory_parse_error, and its keyword arm reads only markdown memory folders: on such a Mac, searchMemories finds none of
// the owner's notes. Listing and scoring is local: no model call, no query leaves the Mac. Nothing here logs.

import { callPython } from './python-bridge.js'
import { scoreKeywordMatch, tokenizeMeetingQuery } from './meeting-library-search.js'

export const BRIDGE_DAYS = 3650
export const BRIDGE_LIMIT = 200
/** The listing never takes longer than cue_memory.py's dense arm may (DENSE_BUDGET_S). */
export const BRIDGE_TIMEOUT_MS = 3_000
export const RRF_K = 60

export interface BridgeMemory { id: string; content: string; summary?: string; created_at?: string; domain?: string }

/** Rows the bridge listed: an id and some content, at most BRIDGE_LIMIT. Anything else (an error object) is no rows. */
export function normalizeBridgeMemories(value: unknown): BridgeMemory[] {
  if (!Array.isArray(value)) return []
  const out: BridgeMemory[] = []
  for (const row of value.slice(0, BRIDGE_LIMIT)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const r = row as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id.trim().slice(0, 170) : ''
    const content = typeof r.content === 'string' ? r.content : ''
    if (!id || !content.trim()) continue
    out.push({ id, content,
      ...(typeof r.summary === 'string' ? { summary: r.summary } : {}),
      ...(typeof r.created_at === 'string' ? { created_at: r.created_at } : {}),
      ...(typeof r.domain === 'string' && r.domain ? { domain: r.domain } : {}) })
  }
  return out
}

/** The bridge listing. Rejects when the bridge fails or the signal aborts; callers decide what that means. */
export async function listBridgeMemories(signal?: AbortSignal, timeoutMs: number = BRIDGE_TIMEOUT_MS): Promise<BridgeMemory[]> {
  return normalizeBridgeMemories(await callPython(['memory', '--days', String(BRIDGE_DAYS), '--limit', String(BRIDGE_LIMIT)], timeoutMs, undefined, signal))
}

/** Rows that match `query`, best first, scored by the library's own keyword scorer (score > 0 only). */
export function scoreBridgeMemories(rows: BridgeMemory[], query: string): Array<{ row: BridgeMemory; score: number }> {
  const tokens = tokenizeMeetingQuery(query)
  return rows.map(row => ({ row, score: scoreKeywordMatch(tokens, row.summary || '', `${row.summary || ''}\n${row.content}`).score }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score)
}

/** A note's LOCAL calendar day: a date bound is a local day (live cues use "tomorrow"), and a memory written at 22:00 Central
 *  carries a UTC timestamp dated the next day. A bare YYYY-MM-DD is already a local day. */
export function localDateOf(v: unknown): string {
  if (typeof v !== 'string') return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) return ''
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString('en-CA') : ''
}

/** Reciprocal rank fusion over ranked lists (k=60, as cue_memory.py): an item in several lists, or high in one, ranks first.
 *  The first item seen for a key is kept; ties keep the order items were first added. */
export class RankFusion<T> {
  private readonly items = new Map<string, { item: T; score: number; order: number }>()
  add(list: ReadonlyArray<{ key: string; item: T }>): void {
    list.forEach(({ key, item }, rank) => {
      const prev = this.items.get(key)
      this.items.set(key, { item: prev?.item ?? item, score: (prev?.score ?? 0) + 1 / (RRF_K + rank), order: prev?.order ?? this.items.size })
    })
  }
  ranked(limit = Infinity): T[] {
    return [...this.items.values()].sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map(x => x.item)
  }
}
