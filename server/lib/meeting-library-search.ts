/**
 * Meeting library lookup for COS Control.
 *
 * Keyword: local title/summary/filename scan. No model.
 * Semantic: existing Qdrant meeting index via semantic_search.py — one query
 * embedding, no LLM. LightRAG is intentionally not used.
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { COS_SCRIPTS_DIR, PYTHON_BIN } from './python-bridge.js'
import {
  cosOperationsMeetingsConfigured,
  discoverMeetingDomains,
  listDirectLibraryMeetingMonths,
  listDirectLibraryMeetings,
  resolveCosOperationsDir,
  resolveMeetingLibrary,
  sidecarSessionId,
} from './cos-operations-meetings.js'
import { getMeetingStore, MeetingStore } from './meeting-store.js'
import type { MeetingMeta } from './meeting-store.js'

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
const MAX_SCAN_FILES = 2_000
const HEAD_BYTES = 8_000
const SEMANTIC_TIMEOUT_MS = 15_000
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'at', 'by',
  'with', 'from', 'vs', 'is', 'it', 'be', 'as', 'we', 'our',
])

export interface MeetingSearchHit {
  recordId: string
  sessionId?: string
  title: string
  date: string
  domain: string
  duration: string
  month: string
  filename: string
  source: string
  librarySource?: MeetingMeta['librarySource']
  snippet: string
  keywordScore: number
  semanticScore: number
  match: 'keyword' | 'semantic' | 'both'
}

export interface MeetingSearchResult {
  hits: MeetingSearchHit[]
  keywordCount: number
  semanticCount: number
  semanticAvailable: boolean
  semanticReason?: string
}

export function tokenizeMeetingQuery(query: string): string[] {
  const raw = query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []
  return [...new Set(raw.filter(token => !STOPWORDS.has(token)))]
}

export function libraryRefFromPath(filePath: string): { domain: string; month: string; filename: string } | null {
  const normalized = filePath.replace(/\\/g, '/')
  const ops = normalized.match(/\/([a-z][a-z0-9_]{0,31})\/meetings\/(\d{4}-\d{2})\/([^/]+\.md)$/i)
  if (ops) return { domain: ops[1], month: ops[2], filename: ops[3] }
  const standalone = normalized.match(/\/recordings\/(\d{4}-\d{2})\/([^/]+\.md)$/i)
  if (standalone) return { domain: 'personal', month: standalone[1], filename: standalone[2] }
  const direct = normalized.match(/\/(\d{4}-\d{2})\/([^/]+\.md)$/)
  if (direct) return { domain: 'library', month: direct[1], filename: direct[2] }
  return null
}

export function scoreKeywordMatch(tokens: string[], title: string, haystack: string): { score: number; snippet: string } {
  if (tokens.length === 0) return { score: 0, snippet: '' }
  const titleL = title.toLowerCase()
  const hayL = haystack.toLowerCase()
  let hits = 0
  let titleHits = 0
  let firstAt = -1
  for (const token of tokens) {
    const inTitle = titleL.includes(token)
    const inHay = hayL.includes(token)
    if (!inTitle && !inHay) continue
    hits += 1
    if (inTitle) titleHits += 1
    if (firstAt < 0) {
      const at = hayL.indexOf(token)
      firstAt = at >= 0 ? at : 0
    }
  }
  if (hits === 0) return { score: 0, snippet: '' }
  const coverage = hits / tokens.length
  if (coverage < 0.5 && titleHits === 0) return { score: 0, snippet: '' }
  const score = Math.min(1, coverage * 0.65 + (titleHits / tokens.length) * 0.35)
  const start = Math.max(0, firstAt - 40)
  const snippet = haystack.slice(start, start + 180).replace(/\s+/g, ' ').trim()
  return { score, snippet }
}

function titleFrom(content: string, filename: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  if (heading) return heading
  return filename.replace(/^\d{4}-\d{2}-\d{2}_/, '').replace(/\.md$/i, '').replace(/_/g, ' ')
}

function dateFrom(content: string, filename: string): string {
  const field = content.match(/\*\*Date\*\*\s*[|:]\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i)
  if (field) return field[1]
  return filename.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? ''
}

function durationFrom(content: string): string {
  const match = content.match(/\*\*Duration\*\*\s*[|:]\s*(.+)/i)
  return match ? match[1].replace(/\s*\|?\s*$/, '').trim() : ''
}

function sourceFrom(content: string): string {
  const match = content.match(/\*\*Source\*\*\s*[|:]\s*(.+)/i)
  return match ? match[1].replace(/\s*\|?\s*$/, '').trim() : ''
}

function hitIdentity(row: {
  domain: string
  month: string
  filename: string
  librarySource?: MeetingMeta['librarySource']
  sessionId?: string
}): Pick<MeetingSearchHit, 'recordId' | 'month' | 'filename' | 'domain'> {
  const recordId = row.librarySource === 'direct_library'
    ? `direct:${row.month}:${row.filename}`
    : row.librarySource === 'standalone_recordings'
      ? `standalone:${row.sessionId || `${row.domain}:${row.month}:${row.filename}`}`
      : `ops:${row.domain}:${row.month}:${row.filename}`
  return { recordId, month: row.month, filename: row.filename, domain: row.domain }
}

function keywordHitsFromOps(tokens: string[], domainFilter: string, budget: { remaining: number }): MeetingSearchHit[] {
  const operationsDir = resolveCosOperationsDir()
  if (!operationsDir) return []
  const discovered = discoverMeetingDomains(operationsDir)
  const domains = domainFilter === 'all'
    ? discovered
    : discovered.includes(domainFilter) ? [domainFilter] : []
  const hits: MeetingSearchHit[] = []

  for (const domain of domains) {
    const meetingsBase = join(operationsDir, domain, 'meetings')
    let months: string[] = []
    try {
      months = readdirSync(meetingsBase).filter(name => MONTH_PATTERN.test(name)).sort().reverse()
    } catch {
      continue
    }
    for (const month of months) {
      const monthDir = join(meetingsBase, month)
      let files: string[] = []
      try {
        files = readdirSync(monthDir).filter(name => name.endsWith('.md'))
      } catch {
        continue
      }
      for (const filename of files) {
        if (budget.remaining <= 0) return hits
        budget.remaining -= 1
        let content = ''
        try {
          content = readFileSync(join(monthDir, filename), 'utf8').slice(0, HEAD_BYTES)
        } catch {
          continue
        }
        const title = titleFrom(content, filename)
        const haystack = `${filename}\n${title}\n${content}`
        const scored = scoreKeywordMatch(tokens, title, haystack)
        if (scored.score <= 0) continue
        const sessionId = sidecarSessionId(monthDir, filename)
        const identity = hitIdentity({ domain, month, filename, librarySource: 'cos_operations', sessionId })
        hits.push({
          ...identity,
          ...(sessionId ? { sessionId } : {}),
          title,
          date: dateFrom(content, filename),
          duration: durationFrom(content),
          source: sourceFrom(content),
          librarySource: 'cos_operations',
          snippet: scored.snippet,
          keywordScore: scored.score,
          semanticScore: 0,
          match: 'keyword',
        })
      }
    }
  }
  return hits
}

function keywordHitsFromDirect(tokens: string[], budget: { remaining: number }): MeetingSearchHit[] {
  const inspection = resolveMeetingLibrary()
  if (inspection.layout !== 'direct') return []
  const hits: MeetingSearchHit[] = []
  for (const month of listDirectLibraryMeetingMonths()) {
    if (budget.remaining <= 0) break
    const rows = listDirectLibraryMeetings({ limit: 200, month })
    for (const row of rows) {
      if (budget.remaining <= 0) break
      budget.remaining -= 1
      const haystack = `${row.filename}\n${row.title}\n${row.domain}`
      const scored = scoreKeywordMatch(tokens, row.title, haystack)
      if (scored.score <= 0) continue
      hits.push({
        recordId: row.recordId || `direct:${row.month}:${row.filename}`,
        ...(row.sessionId ? { sessionId: row.sessionId } : {}),
        title: row.title,
        date: row.date,
        domain: row.domain,
        duration: row.duration,
        month: row.month,
        filename: row.filename,
        source: row.source,
        librarySource: 'direct_library',
        snippet: scored.snippet || row.title,
        keywordScore: scored.score,
        semanticScore: 0,
        match: 'keyword',
      })
    }
  }
  return hits
}

function keywordHitsFromStandalone(
  tokens: string[],
  domainFilter: string,
  budget: { remaining: number },
  store: MeetingStore,
): MeetingSearchHit[] {
  const hits: MeetingSearchHit[] = []
  for (const month of store.listMonths()) {
    if (budget.remaining <= 0) break
    const rows = store.list({ limit: 200, month, domain: domainFilter })
    for (const row of rows) {
      if (budget.remaining <= 0) break
      budget.remaining -= 1
      let content = ''
      try {
        content = readFileSync(join(store.root, row.month, row.filename), 'utf8').slice(0, HEAD_BYTES)
      } catch {
        content = ''
      }
      const haystack = `${row.filename}\n${row.title}\n${row.domain}\n${content}`
      const scored = scoreKeywordMatch(tokens, row.title, haystack)
      if (scored.score <= 0) continue
      const identity = hitIdentity({
        domain: row.domain,
        month: row.month,
        filename: row.filename,
        librarySource: 'standalone_recordings',
        sessionId: row.sessionId,
      })
      hits.push({
        ...identity,
        ...(row.sessionId ? { sessionId: row.sessionId } : {}),
        title: row.title,
        date: row.date,
        duration: row.duration,
        source: row.source,
        librarySource: 'standalone_recordings',
        snippet: scored.snippet || row.title,
        keywordScore: scored.score,
        semanticScore: 0,
        match: 'keyword',
      })
    }
  }
  return hits
}

export function keywordSearchMeetings(
  query: string,
  domain = 'all',
  store: MeetingStore = getMeetingStore(),
): MeetingSearchHit[] {
  const tokens = tokenizeMeetingQuery(query)
  if (tokens.length === 0) return []
  const budget = { remaining: MAX_SCAN_FILES }
  const grouped = new Map<string, MeetingSearchHit>()
  const push = (hit: MeetingSearchHit) => {
    const existing = grouped.get(hit.recordId)
    if (!existing || hit.keywordScore > existing.keywordScore) grouped.set(hit.recordId, hit)
  }
  if (cosOperationsMeetingsConfigured()) {
    for (const hit of keywordHitsFromOps(tokens, domain, budget)) push(hit)
  }
  const library = resolveMeetingLibrary()
  if (library.layout === 'direct' && (domain === 'all' || domain === 'library')) {
    for (const hit of keywordHitsFromDirect(tokens, budget)) push(hit)
  }
  for (const hit of keywordHitsFromStandalone(tokens, domain, budget, store)) push(hit)
  return [...grouped.values()].sort((a, b) => b.keywordScore - a.keywordScore)
}

interface SemanticRawHit {
  title?: string
  date?: string
  domain?: string
  score?: number
  summary?: string
  file_path?: string
  meeting_id?: string
}

function semanticHitToLibrary(raw: SemanticRawHit): MeetingSearchHit | null {
  const fromPath = raw.file_path ? libraryRefFromPath(raw.file_path) : null
  const domain = fromPath?.domain || raw.domain || ''
  const date = raw.date || ''
  const month = fromPath?.month || (date.length >= 7 ? date.slice(0, 7) : '')
  let filename = fromPath?.filename || ''
  if (!filename && raw.meeting_id) {
    filename = raw.meeting_id.endsWith('.md') ? raw.meeting_id : `${raw.meeting_id}.md`
  }
  if (!filename || !month) return null
  const title = raw.title || titleFrom('', filename)
  const identity = hitIdentity({
    domain: domain || 'quilt',
    month,
    filename,
    librarySource: fromPath?.domain === 'library' ? 'direct_library' : 'cos_operations',
  })
  const semanticScore = typeof raw.score === 'number' && Number.isFinite(raw.score) ? Math.max(0, Math.min(1, raw.score)) : 0
  return {
    ...identity,
    title,
    date,
    duration: '',
    source: '',
    librarySource: identity.recordId.startsWith('direct:') ? 'direct_library' : 'cos_operations',
    snippet: String(raw.summary || '').slice(0, 180),
    keywordScore: 0,
    semanticScore,
    match: 'semantic',
  }
}

export function semanticSearchAvailable(): { ok: boolean; reason?: string } {
  if (!PYTHON_BIN || !COS_SCRIPTS_DIR) return { ok: false, reason: 'no_cos_pipeline' }
  if (!existsSync(PYTHON_BIN)) return { ok: false, reason: 'no_cos_pipeline' }
  const script = resolve(COS_SCRIPTS_DIR, 'semantic_search.py')
  if (!existsSync(script)) return { ok: false, reason: 'no_memory_scripts' }
  return { ok: true }
}

export function semanticSearchMeetings(query: string, domain = 'all', limit = 20): Promise<{
  hits: MeetingSearchHit[]
  reason?: string
}> {
  const available = semanticSearchAvailable()
  if (!available.ok) return Promise.resolve({ hits: [], reason: available.reason })
  const script = resolve(COS_SCRIPTS_DIR!, 'semantic_search.py')
  const args = [script, query, '--json', '--limit', String(limit), '--min-score', '0.25', '--temporal-mode', 'off']
  if (domain !== 'all' && domain !== 'library') args.push('--domain', domain)
  return new Promise(resolvePromise => {
    execFile(
      PYTHON_BIN!,
      args,
      { cwd: COS_SCRIPTS_DIR!, timeout: SEMANTIC_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolvePromise({ hits: [], reason: 'qdrant_unreachable' })
          return
        }
        try {
          const parsed = JSON.parse(String(stdout)) as SemanticRawHit[]
          const hits = (Array.isArray(parsed) ? parsed : []).flatMap(row => {
            const hit = semanticHitToLibrary(row)
            return hit ? [hit] : []
          })
          resolvePromise({ hits })
        } catch {
          resolvePromise({ hits: [], reason: 'qdrant_parse_error' })
        }
      },
    )
  })
}

export function mergeMeetingSearchHits(
  keywordHits: MeetingSearchHit[],
  semanticHits: MeetingSearchHit[],
  limit: number,
): MeetingSearchHit[] {
  const merged = new Map<string, MeetingSearchHit>()
  const keyFor = (hit: MeetingSearchHit) => hit.recordId || `${hit.domain}:${hit.month}:${hit.filename}`
  for (const hit of keywordHits) merged.set(keyFor(hit), { ...hit })
  for (const hit of semanticHits) {
    const key = keyFor(hit)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, hit)
      continue
    }
    merged.set(key, {
      ...existing,
      snippet: existing.snippet || hit.snippet,
      semanticScore: Math.max(existing.semanticScore, hit.semanticScore),
      match: existing.keywordScore > 0 && hit.semanticScore > 0 ? 'both' : existing.match,
      sessionId: existing.sessionId || hit.sessionId,
      duration: existing.duration || hit.duration,
      source: existing.source || hit.source,
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

export async function searchMeetingLibrary(options: {
  query: string
  domain?: string
  limit?: number
}, store: MeetingStore = getMeetingStore()): Promise<MeetingSearchResult> {
  const query = options.query.trim()
  const domain = options.domain || 'all'
  const limit = Math.max(1, Math.min(options.limit ?? 20, 50))
  const keywordHits = keywordSearchMeetings(query, domain, store)
  const semantic = await semanticSearchMeetings(query, domain, limit)
  const hits = mergeMeetingSearchHits(keywordHits, semantic.hits, limit)
  return {
    hits,
    keywordCount: keywordHits.length,
    semanticCount: semantic.hits.length,
    semanticAvailable: !semantic.reason,
    ...(semantic.reason ? { semanticReason: semantic.reason } : {}),
  }
}
