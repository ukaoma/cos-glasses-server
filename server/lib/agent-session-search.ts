/**
 * Sessions lookup for COS Control.
 *
 * Keyword: local title / sidebar name / first prompt / transcript scan. No model.
 * Semantic: one OpenAI query embedding scored against those same texts.
 * Sessions have no Qdrant collection — this is not meeting or memory search.
 * The 7-day list window does not apply; older chats stay findable.
 */

import { join } from 'node:path'
import { scoreKeywordMatch, tokenizeMeetingQuery } from './meeting-library-search.js'
import { tryGetOpenAIKey } from './openai-key.js'
import {
  AGENT_SESSION_MAX_FILE_BYTES,
  CLAUDE_UUID_JSONL,
  agentSessionRoots,
  createdFromCodexFilename,
  dirents,
  fileStat,
  findClaudeDesktopFile,
  firstClaudeUserTitle,
  firstLineTitle,
  idFromCodexFilename,
  isKeepWarmSessionTitle,
  isSkippedCursorFolder,
  isWrapperPrompt,
  isoFromMtime,
  lastCustomTitle,
  listCodexJsonlFiles,
  loadClaudeStarredIds,
  loadCodexPinnedIds,
  loadCodexThreadNames,
  loadCursorComposerNames,
  loadCursorPinnedIds,
  parseJsonLine,
  payloadText,
  peekClaudeDesktopHead,
  peekCodexMeta,
  preferCursorCopy,
  readWindow,
  workspaceLabel,
  type AgentProvider,
  type AgentSessionRoots,
  type AgentSessionRow,
} from './agent-session-store.js'

const HEAD_TEXT = 8_000
const MAX_SCAN_FILES = 400

/**
 * How many files a provider may OPEN per search, as a multiple of the docs it may KEEP.
 *
 * Before the filter moved ahead of the decrement, `remaining` meant "files read" -- so a
 * run of machine transcripts consumed the whole allowance and returned nothing. Now it
 * means "docs kept", which on its own would let a pathological corpus walk all 1,296
 * files. This is the ceiling that stops it.
 *
 * Swept 2026-08-18 against the real corpus (1,296 Claude transcripts, 822 Codex
 * rollouts). Docs kept vs collector wall time, median of 5 warm runs:
 *
 *     HEAD   298 docs   692 ms
 *     x2     300 docs   763 ms
 *     x3     316 docs   864 ms
 *     x5     345 docs  1042 ms   <- chosen
 *     x8     396 docs  1402 ms
 *     x12    400 docs  1463 ms   (saturates MAX_SCAN_FILES)
 *
 * x8 is close to the reachable ceiling, but the route this feeds already exceeds COS
 * Control's 2s client timeout on most calls BEFORE any of this (measured median 2.268s,
 * of which ~1.7s is two sequential embedding round trips). Until that is fixed, work
 * bought here is work Control may discard, so this sits at the middle of the curve.
 * Raise it once the route fits the timeout.
 */
const EXAMINE_MULTIPLE = 5

/**
 * `remaining` counts docs KEPT. `examined` counts files OPENED. They are different
 * numbers because most files on this machine are filtered out after their title is read.
 */
type ScanBudget = { remaining: number; examined: number }
const SEMANTIC_DOC_CAP = 120
const SEMANTIC_MIN = 0.28
const EMBED_MODEL = 'text-embedding-3-small'
const EMBED_TIMEOUT_MS = 12_000
const EMBED_BATCH = 64

export interface AgentSessionSearchHit extends AgentSessionRow {
  snippet: string
  keywordScore: number
  semanticScore: number
  match: 'keyword' | 'semantic' | 'both'
}

export interface AgentSessionSearchResult {
  hits: AgentSessionSearchHit[]
  keywordCount: number
  semanticCount: number
  semanticAvailable: boolean
  semanticReason?: string
}

export type EmbedTexts = (texts: string[]) => Promise<number[][] | { reason: string }>

interface SearchDoc {
  row: AgentSessionRow
  title: string
  haystack: string
}

function clip(text: string, max = HEAD_TEXT): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

function extractUserText(provider: AgentProvider, raw: string): string {
  const parts: string[] = []
  for (const line of raw.split('\n')) {
    const obj = parseJsonLine(line)
    if (!obj) continue
    if (provider === 'claude') {
      if (obj.isSidechain === true || obj.toolUseResult) continue
      if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
        parts.push(obj.customTitle)
        continue
      }
      if (obj.type !== 'user') continue
      const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null
      const body = message ? payloadText(message) : null
      if (body && !isWrapperPrompt(body)) parts.push(firstLineTitle(body) || body)
    } else if (provider === 'codex') {
      if (obj.type !== 'response_item' || !obj.payload || typeof obj.payload !== 'object') continue
      const payload = obj.payload as Record<string, unknown>
      if (payload.type !== 'message' || payload.role === 'developer' || payload.role === 'assistant') continue
      const body = payloadText(payload)
      if (body && !isWrapperPrompt(body)) parts.push(firstLineTitle(body) || body)
    } else {
      if (obj.role !== 'user') continue
      const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null
      const body = message ? payloadText(message) : null
      if (!body) continue
      const title = firstLineTitle(body)
      if (title && !isWrapperPrompt(title)) parts.push(title)
    }
    if (parts.join('\n').length >= HEAD_TEXT) break
  }
  return clip(parts.join('\n'))
}

async function transcriptHaystack(provider: AgentProvider, path: string): Promise<string> {
  const head = await readWindow(path, false)
  const tail = await readWindow(path, true)
  const raw = head === tail ? head : `${head}\n${tail}`
  return extractUserText(provider, raw)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let left = 0
  let right = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    left += a[i] * a[i]
    right += b[i] * b[i]
  }
  if (left <= 0 || right <= 0) return 0
  return dot / (Math.sqrt(left) * Math.sqrt(right))
}

export async function defaultEmbedTexts(texts: string[]): Promise<number[][] | { reason: string }> {
  const key = tryGetOpenAIKey()
  if (!key) return { reason: 'no_session_embeddings' }
  if (texts.length === 0) return []
  const vectors: number[][] = new Array(texts.length)
  for (let offset = 0; offset < texts.length; offset += EMBED_BATCH) {
    const slice = texts.slice(offset, offset + EMBED_BATCH).map(text => text.slice(0, HEAD_TEXT))
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: EMBED_MODEL, input: slice }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      })
      if (!response.ok) return { reason: 'embeddings_unreachable' }
      const parsed = await response.json() as { data?: Array<{ embedding?: number[]; index?: number }> }
      const rows = Array.isArray(parsed.data) ? parsed.data : []
      for (const row of rows) {
        const index = typeof row.index === 'number' ? row.index : 0
        if (Array.isArray(row.embedding)) vectors[offset + index] = row.embedding
      }
    } catch {
      return { reason: 'embeddings_unreachable' }
    }
  }
  if (vectors.some(row => !Array.isArray(row) || row.length === 0)) return { reason: 'embeddings_unreachable' }
  return vectors
}

function pushDoc(docs: SearchDoc[], next: SearchDoc) {
  const key = `${next.row.provider}:${next.row.session_id.toLowerCase()}`
  const existing = docs.find(doc => `${doc.row.provider}:${doc.row.session_id.toLowerCase()}` === key)
  if (!existing) {
    docs.push(next)
    return
  }
  if (next.haystack.length > existing.haystack.length) existing.haystack = next.haystack
  if (next.title && (existing.title.endsWith(' session') || next.title.length > existing.title.length)) {
    existing.title = next.title
    existing.row = { ...existing.row, display_label: next.title }
  }
}

async function collectClaudeDocs(roots: AgentSessionRoots, docs: SearchDoc[], budget: ScanBudget) {
  const starred = await loadClaudeStarredIds(roots.claudeDesktopConfig)
  for (const folder of await dirents(roots.claudeProjects)) {
    const dir = join(roots.claudeProjects, folder)
    for (const name of await dirents(dir)) {
      if (!CLAUDE_UUID_JSONL.test(name) || budget.remaining <= 0 || budget.examined <= 0) continue
      const file = join(dir, name)
      const st = await fileStat(file)
      if (!st?.isFile) continue
      budget.examined -= 1
      const native = name.slice(0, -6)
      const custom = await lastCustomTitle(file)
      const first = await firstClaudeUserTitle(file)
      const title = custom || first || 'Claude session'
      // Both filters run BEFORE the doc budget is charged, and the haystack -- by far the
      // most expensive read here -- runs only for a file we are actually keeping.
      if (isKeepWarmSessionTitle(title)) continue
      budget.remaining -= 1
      const users = await transcriptHaystack('claude', file)
      const haystack = clip(`${title}\n${custom || ''}\n${first || ''}\n${workspaceLabel(folder)}\n${users}`)
      pushDoc(docs, {
        title,
        haystack,
        row: {
          session_id: native,
          provider: 'claude',
          display_label: title,
          project: workspaceLabel(folder),
          modified: isoFromMtime(st.mtimeMs),
          created: isoFromMtime(st.birthtimeMs),
          alive: false,
          state: 'recent',
          pinned: starred.has(native.toLowerCase()),
        },
      })
    }
  }
  for (const starredId of starred) {
    if (docs.some(doc => doc.row.provider === 'claude' && doc.row.session_id.toLowerCase() === starredId)) continue
    if (budget.remaining <= 0) break
    const desktop = await findClaudeDesktopFile(roots.claudeCodeSessions, starredId)
    if (!desktop) continue
    const st = await fileStat(desktop)
    if (!st?.isFile) continue
    const head = peekClaudeDesktopHead(await readWindow(desktop, false))
    const title = head.title || 'Claude session'
    if (isKeepWarmSessionTitle(title)) continue
    budget.remaining -= 1
    pushDoc(docs, {
      title,
      haystack: clip(`${title}\n${head.cwd}\n${workspaceLabel(head.cwd)}`),
      row: {
        session_id: starredId,
        provider: 'claude',
        display_label: title,
        project: workspaceLabel(head.cwd),
        modified: isoFromMtime(st.mtimeMs),
        created: isoFromMtime(st.birthtimeMs),
        alive: false,
        state: 'recent',
        pinned: true,
      },
    })
  }
}

async function collectCodexDocs(roots: AgentSessionRoots, docs: SearchDoc[], budget: ScanBudget) {
  const names = await loadCodexThreadNames(roots.codexSessions)
  const pinned = await loadCodexPinnedIds(roots.codexSessions)
  for (const file of await listCodexJsonlFiles(roots.codexSessions)) {
    if (budget.remaining <= 0 || budget.examined <= 0) break
    const st = await fileStat(file)
    if (!st?.isFile) continue
    budget.examined -= 1
    const meta = await peekCodexMeta(file)
    // Subagent rollouts are the Codex analogue of the keep-warm transcripts: 427 of 822
    // on this machine per the 2026-08-18 census. Filtered before the doc budget is charged.
    if (!meta || meta.subagent) continue
    const name = file.split('/').pop() || file
    const native = meta.id || name.slice(0, -6)
    const thread = names.get(native) || ''
    const title = thread || meta.title || 'Codex session'
    if (isKeepWarmSessionTitle(title)) continue
    budget.remaining -= 1
    const users = await transcriptHaystack('codex', file)
    const created = meta.created || createdFromCodexFilename(name) || isoFromMtime(st.birthtimeMs)
    pushDoc(docs, {
      title,
      haystack: clip(`${title}\n${thread}\n${meta.title}\n${meta.cwd}\n${users}`),
      row: {
        session_id: native,
        provider: 'codex',
        display_label: title,
        project: workspaceLabel(meta.cwd),
        modified: isoFromMtime(st.mtimeMs),
        created,
        alive: false,
        state: 'recent',
        pinned: pinned.has(native.toLowerCase()) || Boolean(idFromCodexFilename(name) && pinned.has(idFromCodexFilename(name)!)),
      },
    })
  }
}

async function collectCursorDocs(
  roots: AgentSessionRoots,
  docs: SearchDoc[],
  budget: { remaining: number },
  now: Date,
) {
  const composerNames = await loadCursorComposerNames(roots.cursorComposerDb)
  const pinnedIds = await loadCursorPinnedIds(roots.cursorWorkspaceStorage)
  const byId = new Map<string, { file: string; project: string; mtimeMs: number; birthtimeMs: number }>()
  for (const folder of await dirents(roots.cursorProjects)) {
    if (isSkippedCursorFolder(folder)) continue
    const transcripts = join(roots.cursorProjects, folder, 'agent-transcripts')
    for (const sessionDir of await dirents(transcripts)) {
      if (sessionDir === 'subagents') continue
      if (folder === 'empty-window' && !pinnedIds.has(sessionDir.toLowerCase())) continue
      const file = join(transcripts, sessionDir, `${sessionDir}.jsonl`)
      const st = await fileStat(file)
      if (!st?.isFile) continue
      if (st.size > AGENT_SESSION_MAX_FILE_BYTES && !pinnedIds.has(sessionDir.toLowerCase())) continue
      const next = { file, project: workspaceLabel(folder), mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs }
      const existing = byId.get(sessionDir)
      byId.set(sessionDir, existing ? preferCursorCopy({ ...next, sessionDir }, { ...existing, sessionDir }) : next)
    }
  }
  const ranked = [...byId.entries()].sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
  for (const [sessionDir, candidate] of ranked) {
    if (budget.remaining <= 0) break
    budget.remaining -= 1
    const sidebar = composerNames.get(sessionDir) || ''
    const users = await transcriptHaystack('cursor', candidate.file)
    const title = sidebar || users.split('\n')[0] || 'Cursor session'
    if (isKeepWarmSessionTitle(title)) continue
    pushDoc(docs, {
      title,
      haystack: clip(`${title}\n${sidebar}\n${candidate.project}\n${users}`),
      row: {
        session_id: sessionDir,
        provider: 'cursor',
        display_label: title,
        project: candidate.project,
        modified: isoFromMtime(candidate.mtimeMs),
        created: isoFromMtime(candidate.birthtimeMs),
        alive: now.getTime() - candidate.mtimeMs < 180_000,
        state: now.getTime() - candidate.mtimeMs < 180_000 ? 'running' : 'recent',
        pinned: pinnedIds.has(sessionDir.toLowerCase()),
      },
    })
  }
}

export async function collectAgentSessionSearchDocs(
  roots: AgentSessionRoots = agentSessionRoots(),
  cap = MAX_SCAN_FILES,
  now = new Date(),
): Promise<SearchDoc[]> {
  const docs: SearchDoc[] = []
  const share = Math.max(1, Math.ceil(Math.min(cap, MAX_SCAN_FILES) / 3))
  const examined = share * EXAMINE_MULTIPLE
  await collectClaudeDocs(roots, docs, { remaining: share, examined })
  await collectCodexDocs(roots, docs, { remaining: share, examined })
  await collectCursorDocs(roots, docs, { remaining: share }, now)
  docs.sort((a, b) => (b.row.modified || '').localeCompare(a.row.modified || ''))
  return docs.slice(0, Math.max(1, Math.min(cap, MAX_SCAN_FILES)))
}

export function keywordSearchSessions(docs: SearchDoc[], query: string): AgentSessionSearchHit[] {
  const tokens = tokenizeMeetingQuery(query)
  if (tokens.length === 0) return []
  const hits: AgentSessionSearchHit[] = []
  for (const doc of docs) {
    const scored = scoreKeywordMatch(tokens, doc.title, doc.haystack)
    if (scored.score <= 0) continue
    hits.push({
      ...doc.row,
      snippet: scored.snippet || doc.title,
      keywordScore: scored.score,
      semanticScore: 0,
      match: 'keyword',
    })
  }
  return hits.sort((a, b) => b.keywordScore - a.keywordScore)
}

export async function semanticSearchSessions(
  docs: SearchDoc[],
  query: string,
  limit: number,
  embedTexts: EmbedTexts = defaultEmbedTexts,
): Promise<{ hits: AgentSessionSearchHit[]; reason?: string }> {
  const pool = docs.slice(0, SEMANTIC_DOC_CAP)
  if (pool.length === 0) return { hits: [] }
  const embedded = await embedTexts([query, ...pool.map(doc => clip(`${doc.title}\n${doc.haystack}`, 1_500))])
  if (!Array.isArray(embedded)) return { hits: [], reason: embedded.reason }
  const [queryVec, ...docVecs] = embedded
  if (!queryVec) return { hits: [], reason: 'embeddings_unreachable' }
  const hits: AgentSessionSearchHit[] = []
  for (let i = 0; i < pool.length; i++) {
    const score = cosineSimilarity(queryVec, docVecs[i] || [])
    if (score < SEMANTIC_MIN) continue
    const doc = pool[i]
    hits.push({
      ...doc.row,
      snippet: clip(doc.haystack, 180),
      keywordScore: 0,
      semanticScore: Math.max(0, Math.min(1, score)),
      match: 'semantic',
    })
  }
  return {
    hits: hits.sort((a, b) => b.semanticScore - a.semanticScore).slice(0, Math.max(1, Math.min(limit, 50))),
  }
}

export function mergeSessionSearchHits(
  keywordHits: AgentSessionSearchHit[],
  semanticHits: AgentSessionSearchHit[],
  limit: number,
): AgentSessionSearchHit[] {
  const merged = new Map<string, AgentSessionSearchHit>()
  const keyFor = (hit: AgentSessionSearchHit) => `${hit.provider}:${hit.session_id.toLowerCase()}`
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

export async function searchAgentSessions(options: {
  query: string
  limit?: number
  roots?: AgentSessionRoots
  embedTexts?: EmbedTexts
  now?: Date
}): Promise<AgentSessionSearchResult> {
  const query = options.query.trim()
  const limit = Math.max(1, Math.min(options.limit ?? 20, 50))
  const docs = await collectAgentSessionSearchDocs(
    options.roots ?? agentSessionRoots(),
    MAX_SCAN_FILES,
    options.now,
  )
  const keywordHits = keywordSearchSessions(docs, query)
  const semantic = await semanticSearchSessions(docs, query, limit, options.embedTexts ?? defaultEmbedTexts)
  return {
    hits: mergeSessionSearchHits(keywordHits, semantic.hits, limit),
    keywordCount: keywordHits.length,
    semanticCount: semantic.hits.length,
    semanticAvailable: !semantic.reason,
    ...(semantic.reason ? { semanticReason: semantic.reason } : {}),
  }
}
