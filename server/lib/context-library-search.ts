/**
 * Memory and Threads lookup for COS Control.
 *
 * Keyword: local title/body scan. No model.
 * Memories meaning: existing `cos_memory` index via bot_memory.py — one query
 * embedding, no LLM, never the meeting Qdrant collection.
 * Threads have no embedding index — keyword still works, semanticAvailable is false.
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { COS_SCRIPTS_DIR, PYTHON_BIN } from './python-bridge.js'
import {
  hasFileMemory,
  hasFileThreads,
  readFileMemories,
  readFileThreads,
  resolveContextFilesRoot,
} from './context-files.js'
import { scoreKeywordMatch, tokenizeMeetingQuery } from './meeting-library-search.js'

const HEAD_BYTES = 8_000
const MAX_SCAN_FILES = 2_000
const SEMANTIC_TIMEOUT_MS = 15_000
export const MEMORY_SEMANTIC_SCRIPT = 'bot_memory.py'

export interface ContextSearchHit {
  id: string
  title: string
  snippet: string
  kind: 'memory' | 'thread'
  type?: string
  created_at?: string
  name?: string
  domain?: string
  meeting_count?: number
  is_resolved?: boolean
  topics?: string[]
  keywordScore: number
  semanticScore: number
  match: 'keyword' | 'semantic' | 'both'
}

export interface ContextSearchResult {
  hits: ContextSearchHit[]
  keywordCount: number
  semanticCount: number
  semanticAvailable: boolean
  semanticReason?: string
}

export function memorySemanticArgs(query: string, limit: number, script = MEMORY_SEMANTIC_SCRIPT): string[] {
  return [script, 'search', '--query', query, '--limit', String(limit)]
}

export function memorySemanticAvailable(
  scriptsDir: string | null = COS_SCRIPTS_DIR,
  pythonBin: string | null = PYTHON_BIN,
): { ok: boolean; reason?: string } {
  if (!scriptsDir || !pythonBin) return { ok: false, reason: 'no_memory_embeddings' }
  if (!existsSync(pythonBin)) return { ok: false, reason: 'no_memory_embeddings' }
  const script = resolve(scriptsDir, MEMORY_SEMANTIC_SCRIPT)
  if (!existsSync(script)) return { ok: false, reason: 'no_memory_embeddings' }
  return { ok: true }
}

export function threadSemanticAvailable(): { ok: false; reason: 'no_thread_embeddings' } {
  return { ok: false, reason: 'no_thread_embeddings' }
}

function head(text: string): string {
  return text.slice(0, HEAD_BYTES)
}

export function keywordHitsFromRecords(
  tokens: string[],
  records: Array<{ id: string; title: string; haystack: string }>,
  kind: 'memory' | 'thread',
): ContextSearchHit[] {
  const hits: ContextSearchHit[] = []
  for (const record of records) {
    if (!record.id) continue
    const scored = scoreKeywordMatch(tokens, record.title, record.haystack)
    if (scored.score <= 0) continue
    hits.push({
      id: record.id,
      title: record.title,
      snippet: scored.snippet,
      kind,
      keywordScore: scored.score,
      semanticScore: 0,
      match: 'keyword',
    })
  }
  return hits.sort((a, b) => b.keywordScore - a.keywordScore)
}

function memoryRecordsForKeyword(): Array<{ id: string; title: string; haystack: string; extra: Partial<ContextSearchHit> }> {
  const root = resolveContextFilesRoot()
  if (!root || !hasFileMemory(root)) return []
  return readFileMemories(root, MAX_SCAN_FILES).map(row => ({
    id: row.id,
    title: row.summary || row.id,
    haystack: head(`${row.id}\n${row.summary}\n${row.type}\n${row.content}`),
    extra: { type: row.type, created_at: row.created_at, domain: row.domain },
  }))
}

function parseThreadBag(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter(row => row && typeof row === 'object' && !Array.isArray(row)) as Array<Record<string, unknown>>
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const threads = (raw as { threads?: unknown }).threads
  return Array.isArray(threads)
    ? threads.filter(row => row && typeof row === 'object' && !Array.isArray(row)) as Array<Record<string, unknown>>
    : []
}

function threadHaystack(row: Record<string, unknown>): string {
  const topics = Array.isArray(row.topics) ? row.topics.join(' ') : String(row.topics || '')
  const meetings = Array.isArray(row.meetings)
    ? row.meetings.map(item => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const meeting = item as Record<string, unknown>
        return String(meeting.name || meeting.title || '')
      }
      return ''
    }).join(' ')
    : ''
  const updates = Array.isArray(row.manual_updates)
    ? row.manual_updates.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return ''
      return String((item as Record<string, unknown>).content || '')
    }).join('\n')
    : String(row.initial_note || '')
  return head(`${row.id}\n${row.name}\n${topics}\n${meetings}\n${updates}`)
}

export function keywordHitsFromThreadCache(tokens: string[], scriptsDir: string | null = COS_SCRIPTS_DIR): ContextSearchHit[] {
  if (!scriptsDir) return []
  const files = ['.threads_cache.json', '.manual_threads.json']
  const grouped = new Map<string, ContextSearchHit>()
  for (const name of files) {
    const path = resolve(scriptsDir, name)
    if (!existsSync(path)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    for (const row of parseThreadBag(parsed)) {
      const id = String(row.id || '').trim()
      const title = String(row.name || id).trim()
      if (!id) continue
      const scored = scoreKeywordMatch(tokens, title, threadHaystack(row))
      if (scored.score <= 0) continue
      const hit: ContextSearchHit = {
        id,
        title,
        snippet: scored.snippet,
        kind: 'thread',
        domain: typeof row.domain === 'string' ? row.domain : undefined,
        meeting_count: typeof row.meeting_count === 'number' ? row.meeting_count : undefined,
        is_resolved: row.is_resolved === true || row.status === 'resolved',
        topics: Array.isArray(row.topics) ? row.topics.map(String) : undefined,
        keywordScore: scored.score,
        semanticScore: 0,
        match: 'keyword',
      }
      const existing = grouped.get(id)
      if (!existing || hit.keywordScore > existing.keywordScore) grouped.set(id, hit)
    }
  }
  return [...grouped.values()]
}

export function keywordSearchMemories(query: string): ContextSearchHit[] {
  const tokens = tokenizeMeetingQuery(query)
  if (tokens.length === 0) return []
  const records = memoryRecordsForKeyword()
  return keywordHitsFromRecords(tokens, records, 'memory').map(hit => {
    const extra = records.find(row => row.id === hit.id)?.extra ?? {}
    return { ...hit, ...extra, kind: 'memory' as const }
  })
}

export function keywordSearchThreads(query: string): ContextSearchHit[] {
  const tokens = tokenizeMeetingQuery(query)
  if (tokens.length === 0) return []
  const grouped = new Map<string, ContextSearchHit>()
  const push = (hit: ContextSearchHit) => {
    const existing = grouped.get(hit.id)
    if (!existing || hit.keywordScore > existing.keywordScore) grouped.set(hit.id, hit)
  }
  const root = resolveContextFilesRoot()
  if (root && hasFileThreads(root)) {
    for (const row of readFileThreads(root, MAX_SCAN_FILES)) {
      const title = row.name || row.id
      const haystack = head(`${row.id}\n${title}\n${row.topics.join(' ')}\n${row.manual_updates.map(item => item.content).join('\n')}`)
      const scored = scoreKeywordMatch(tokens, title, haystack)
      if (scored.score <= 0) continue
      push({
        id: row.id,
        title,
        snippet: scored.snippet,
        kind: 'thread',
        domain: row.domain,
        meeting_count: row.meeting_count,
        is_resolved: row.is_resolved,
        topics: row.topics,
        keywordScore: scored.score,
        semanticScore: 0,
        match: 'keyword',
      })
    }
  }
  for (const hit of keywordHitsFromThreadCache(tokens)) push(hit)
  return [...grouped.values()].sort((a, b) => b.keywordScore - a.keywordScore)
}

interface MemorySemanticRaw {
  id?: string
  type?: string
  content?: string
  summary?: string
  created_at?: string
  domain?: string
  score?: number
}

function semanticHitFromMemory(raw: MemorySemanticRaw): ContextSearchHit | null {
  const id = String(raw.id || '').trim()
  if (!id) return null
  const title = String(raw.summary || raw.content || id).trim()
  const semanticScore = typeof raw.score === 'number' && Number.isFinite(raw.score)
    ? Math.max(0, Math.min(1, raw.score))
    : 0
  return {
    id,
    title,
    snippet: String(raw.content || raw.summary || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    kind: 'memory',
    type: raw.type,
    created_at: raw.created_at,
    domain: raw.domain,
    keywordScore: 0,
    semanticScore,
    match: 'semantic',
  }
}

export function semanticSearchMemories(query: string, limit = 20): Promise<{
  hits: ContextSearchHit[]
  reason?: string
}> {
  const available = memorySemanticAvailable()
  if (!available.ok) return Promise.resolve({ hits: [], reason: available.reason })
  const script = resolve(COS_SCRIPTS_DIR!, MEMORY_SEMANTIC_SCRIPT)
  return new Promise(resolvePromise => {
    execFile(
      PYTHON_BIN!,
      memorySemanticArgs(query, limit, script),
      { cwd: COS_SCRIPTS_DIR!, timeout: SEMANTIC_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolvePromise({ hits: [], reason: 'no_memory_embeddings' })
          return
        }
        try {
          const parsed = JSON.parse(String(stdout)) as { results?: MemorySemanticRaw[] } | MemorySemanticRaw[]
          const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.results) ? parsed.results : [])
          resolvePromise({
            hits: rows.flatMap(row => {
              const hit = semanticHitFromMemory(row)
              return hit ? [hit] : []
            }),
          })
        } catch {
          resolvePromise({ hits: [], reason: 'memory_parse_error' })
        }
      },
    )
  })
}

export function mergeContextSearchHits(
  keywordHits: ContextSearchHit[],
  semanticHits: ContextSearchHit[],
  limit: number,
): ContextSearchHit[] {
  const merged = new Map<string, ContextSearchHit>()
  for (const hit of keywordHits) merged.set(hit.id, { ...hit })
  for (const hit of semanticHits) {
    const existing = merged.get(hit.id)
    if (!existing) {
      merged.set(hit.id, hit)
      continue
    }
    merged.set(hit.id, {
      ...existing,
      snippet: existing.snippet || hit.snippet,
      semanticScore: Math.max(existing.semanticScore, hit.semanticScore),
      match: existing.keywordScore > 0 && hit.semanticScore > 0 ? 'both' : existing.match,
      type: existing.type || hit.type,
      created_at: existing.created_at || hit.created_at,
      domain: existing.domain || hit.domain,
    })
  }
  return [...merged.values()]
    .sort((a, b) => {
      const bothDelta = Number(b.match === 'both') - Number(a.match === 'both')
      if (bothDelta) return bothDelta
      return Math.max(b.keywordScore, b.semanticScore) - Math.max(a.keywordScore, a.semanticScore)
    })
    .slice(0, Math.max(1, Math.min(limit, 50)))
}

export async function searchMemories(options: { query: string; limit?: number }): Promise<ContextSearchResult> {
  const query = options.query.trim()
  const limit = Math.max(1, Math.min(options.limit ?? 20, 50))
  const keywordHits = keywordSearchMemories(query)
  const semantic = await semanticSearchMemories(query, limit)
  return {
    hits: mergeContextSearchHits(keywordHits, semantic.hits, limit),
    keywordCount: keywordHits.length,
    semanticCount: semantic.hits.length,
    semanticAvailable: !semantic.reason,
    ...(semantic.reason ? { semanticReason: semantic.reason } : {}),
  }
}

export async function searchThreads(options: { query: string; limit?: number }): Promise<ContextSearchResult> {
  const query = options.query.trim()
  const limit = Math.max(1, Math.min(options.limit ?? 20, 50))
  const keywordHits = keywordSearchThreads(query)
  const unavailable = threadSemanticAvailable()
  return {
    hits: mergeContextSearchHits(keywordHits, [], limit),
    keywordCount: keywordHits.length,
    semanticCount: 0,
    semanticAvailable: false,
    semanticReason: unavailable.reason,
  }
}
