/**
 * Older sessions in a short form (Sessions chat-style layout, step 2a; S1_CONTRACT_step2a.md, B2).
 *
 * The main list (listAgentSessions) keeps its 7-day window and its per-agent cap of 20, so its 5-second poll stays the
 * size it is. On Miles's Mac that cap shows only the newest ~4 hours of Claude sessions (333 transcripts in 7 days,
 * measured 2026-11-10). This walk answers the rest of the last `days` days as SHORT rows: id, agent, title, project,
 * dates. No state, activity or model: those come from the detail route when a session is opened.
 *
 * - Paged newest first across all agents by `before` (exclusive) and `limit`; `nextBefore` is null on the last page.
 * - Leaves out the ids in `exclude` (live rows, passed by the route) and each agent's own pins. A row may still also be
 *   in the main list; the client keeps the main row.
 * - Includes the ids in `keep` (COS pins, folder members, COS-started sessions) AT ANY AGE (Q1 FIX 1, lead ruling
 *   2026-11-10): the main list holds at most KEPT_LIST_MAX of them, so a kept row past that ceiling comes back here as
 *   a short row and is never silently dropped. The ones the main list does have are repeats the client drops.
 * - Leaves out keep-warm sessions and Codex subagent rollouts, as the main list does.
 * - Titles are read with the main list's own rules and memoized on file mtime and size. These files are days old and
 *   rarely change, so a repeat call re-reads almost nothing.
 * - `olderThanWindow` counts sessions past `days` that are not kept or pinned: the "N older through search" line.
 */
import { join } from 'node:path'
import {
  AGENT_SESSION_MAX_FILE_BYTES,
  CLAUDE_UUID_JSONL,
  codexSessionRootsOf,
  createdFromCodexFilename,
  dirents,
  fileStat,
  firstClaudeUserTitle,
  firstCursorUserTitle,
  idFromCodexFilename,
  isKeepWarmSessionTitle,
  isoFromMtime,
  listCodexJsonlFiles,
  loadClaudeDesktopAliases,
  loadClaudeStarredIds,
  loadCodexPinnedIdsAll,
  loadCodexThreadNamesAll,
  loadCursorComposerNames,
  loadCursorPinnedIds,
  peekClaudeDiscussion,
  peekCodexMeta,
  peekCursorDiscussion,
  workspaceLabel,
  type AgentProvider,
  type AgentSessionRoots,
  type ClaudeAliasMap,
} from './agent-session-store.js'

export const OLDER_DEFAULT_DAYS = 30
export const OLDER_MIN_DAYS = 2
export const OLDER_MAX_DAYS = 30
export const OLDER_DEFAULT_LIMIT = 100
export const OLDER_MAX_LIMIT = 200

export interface OlderSessionRow {
  session_id: string
  provider: AgentProvider
  display_label: string
  project: string
  modified: string
  created: string
  form: 'short'
}

interface Candidate { provider: AgentProvider; id: string; file: string; mtimeMs: number; birthtimeMs: number; size: number; folder: string }
interface Resolved { title: string; project: string; created: string; id: string; skip: boolean }

/** file -> what was read for this exact mtime and size. Bounded; cleared oldest-first. */
const titleMemo = new Map<string, { mtimeMs: number; size: number; resolved: Resolved }>()
const TITLE_MEMO_MAX = 5_000
export const olderTitleStats = { reads: 0, memoHits: 0 }
export function __resetOlderTitleMemoForTests(): void { titleMemo.clear(); olderTitleStats.reads = 0; olderTitleStats.memoHits = 0 }

async function memoized(candidate: Candidate, read: () => Promise<Resolved>): Promise<Resolved> {
  const hit = titleMemo.get(candidate.file)
  if (hit && hit.mtimeMs === candidate.mtimeMs && hit.size === candidate.size) { olderTitleStats.memoHits++; return hit.resolved }
  olderTitleStats.reads++
  const resolved = await read()
  titleMemo.delete(candidate.file)
  titleMemo.set(candidate.file, { mtimeMs: candidate.mtimeMs, size: candidate.size, resolved })
  while (titleMemo.size > TITLE_MEMO_MAX) titleMemo.delete(titleMemo.keys().next().value!)
  return resolved
}

export async function listOlderSessions(roots: AgentSessionRoots, now: Date, options: {
  days?: number
  before?: number
  limit?: number
  exclude?: Partial<Record<AgentProvider, ReadonlySet<string>>>
  /** Listed at any age, outside `days` (see the header). */
  keep?: Partial<Record<AgentProvider, ReadonlySet<string>>>
  aliases?: ClaudeAliasMap
} = {}): Promise<{ rows: OlderSessionRow[]; nextBefore: string | null; olderThanWindow: number }> {
  const days = Math.min(OLDER_MAX_DAYS, Math.max(OLDER_MIN_DAYS, Math.floor(options.days ?? OLDER_DEFAULT_DAYS)))
  const limit = Math.min(OLDER_MAX_LIMIT, Math.max(1, Math.floor(options.limit ?? OLDER_DEFAULT_LIMIT)))
  const cutoff = now.getTime() - days * 24 * 3600 * 1000
  const before = Number.isFinite(options.before) ? options.before! : Number.POSITIVE_INFINITY
  const excluded = (provider: AgentProvider, id: string) => options.exclude?.[provider]?.has(id.toLowerCase()) ?? false
  const kept = (provider: AgentProvider, id: string) => options.keep?.[provider]?.has(id.toLowerCase()) ?? false

  const aliases = options.aliases ?? await loadClaudeDesktopAliases(roots.claudeCodeSessions)
  const canonical = (id: string) => { const cli = aliases.get(id)?.cliSessionId; return cli && CLAUDE_UUID_JSONL.test(cli + '.jsonl') ? cli : id }
  const claudeStars = new Set([...await loadClaudeStarredIds(roots.claudeDesktopConfig)].map(id => canonical(id).toLowerCase()))
  const codexPinned = await loadCodexPinnedIdsAll(roots)
  const cursorPinned = await loadCursorPinnedIds(roots.cursorWorkspaceStorage)

  let olderThanWindow = 0
  const candidates: Candidate[] = []
  const consider = (c: Candidate, pinned: boolean) => {
    if (pinned || excluded(c.provider, c.id)) return
    if (c.mtimeMs < cutoff && !kept(c.provider, c.id)) { olderThanWindow++; return }
    candidates.push(c)
  }

  for (const folder of await dirents(roots.claudeProjects)) {
    const dir = join(roots.claudeProjects, folder)
    for (const name of await dirents(dir)) {
      if (!CLAUDE_UUID_JSONL.test(name)) continue
      const id = name.slice(0, -6).toLowerCase()
      const st = await fileStat(join(dir, name))
      if (!st?.isFile) continue
      consider({ provider: 'claude', id, file: join(dir, name), mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, size: st.size, folder }, claudeStars.has(id))
    }
  }
  for (const root of codexSessionRootsOf(roots)) {
    for (const file of await listCodexJsonlFiles(root)) {
      const id = idFromCodexFilename(file.split('/').pop() || '')
      if (!id) continue
      const st = await fileStat(file)
      if (!st?.isFile) continue
      consider({ provider: 'codex', id, file, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, size: st.size, folder: '' }, codexPinned.has(id))
    }
  }
  const cursorById = new Map<string, Candidate>()
  for (const folder of await dirents(roots.cursorProjects)) {
    if (folder.includes('var-folders') || folder.includes('private-var') || folder === 'empty-window') continue
    const transcripts = join(roots.cursorProjects, folder, 'agent-transcripts')
    for (const sessionDir of await dirents(transcripts)) {
      if (sessionDir === 'subagents') continue
      const file = join(transcripts, sessionDir, `${sessionDir}.jsonl`)
      const st = await fileStat(file)
      if (!st?.isFile || st.size > AGENT_SESSION_MAX_FILE_BYTES) continue
      const id = sessionDir.toLowerCase()
      const next: Candidate = { provider: 'cursor', id, file, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, size: st.size, folder }
      const prev = cursorById.get(id)
      if (!prev || next.mtimeMs > prev.mtimeMs) cursorById.set(id, next)
    }
  }
  for (const c of cursorById.values()) consider(c, cursorPinned.has(c.id))

  const page = candidates.filter(c => c.mtimeMs < before).sort((a, b) => b.mtimeMs - a.mtimeMs)
  const codexNames = page.some(c => c.provider === 'codex') ? await loadCodexThreadNamesAll(roots) : new Map<string, string>()
  const cursorNames = page.some(c => c.provider === 'cursor') && roots.cursorComposerDb
    ? await loadCursorComposerNames(roots.cursorComposerDb) : new Map<string, string>()
  const desktopTitles = new Map<string, string>()
  for (const [id, head] of aliases) if (head?.title) desktopTitles.set(canonical(id).toLowerCase(), head.title)

  const rows: OlderSessionRow[] = []
  let consumed = 0
  for (const c of page) {
    if (rows.length >= limit) break
    consumed++
    const r = await memoized(c, () => resolve(c, codexNames, cursorNames, desktopTitles))
    if (r.skip) continue
    rows.push({ session_id: r.id, provider: c.provider, display_label: r.title, project: r.project, modified: isoFromMtime(c.mtimeMs), created: r.created, form: 'short' })
  }
  const more = consumed < page.length
  return {
    rows,
    nextBefore: more && consumed > 0 ? isoFromMtime(page[consumed - 1].mtimeMs) : null,
    olderThanWindow,
  }
}

async function resolve(c: Candidate, codexNames: Map<string, string>, cursorNames: Map<string, string>, desktopTitles: Map<string, string>): Promise<Resolved> {
  const created = isoFromMtime(c.birthtimeMs)
  if (c.provider === 'claude') {
    const peek = await peekClaudeDiscussion(c.file)
    const title = peek.customTitle ?? await firstClaudeUserTitle(c.file) ?? desktopTitles.get(c.id) ?? 'Claude session'
    return { id: c.id, title, project: workspaceLabel(c.folder), created, skip: isKeepWarmSessionTitle(title) }
  }
  if (c.provider === 'codex') {
    const meta = await peekCodexMeta(c.file)
    if (!meta || meta.subagent) return { id: c.id, title: '', project: '', created, skip: true }
    // The main list's rule: the filename wins when the meta id disagrees (a cloned rollout copies its parent's meta).
    const metaId = (meta.id || '').trim().toLowerCase()
    const id = metaId && metaId !== c.id ? c.id : (metaId || c.id)
    const title = codexNames.get(id) || meta.title || 'Codex session'
    const name = c.file.split('/').pop() || ''
    return { id, title, project: workspaceLabel(meta.cwd), created: meta.created || createdFromCodexFilename(name) || created, skip: isKeepWarmSessionTitle(title) }
  }
  const peek = await peekCursorDiscussion(c.file)
  const title = cursorNames.get(c.id) || await firstCursorUserTitle(c.file) || peek.lastUser || 'Cursor session'
  return { id: c.id, title, project: workspaceLabel(c.folder), created, skip: isKeepWarmSessionTitle(title) }
}


/** One session's short row from its transcript file (renamed-title search hits). Null when it cannot be read or is a
 *  keep-warm or subagent session. Uses the same title rules and memo as the older walk. */
export async function shortRowFor(provider: AgentProvider, file: string, aliases?: ClaudeAliasMap, roots?: AgentSessionRoots): Promise<OlderSessionRow | null> {
  const st = await fileStat(file)
  if (!st?.isFile) return null
  const parts = file.split('/')
  const name = parts.pop() || ''
  const id = provider === 'claude' ? name.replace(/\.jsonl$/, '').toLowerCase()
    : provider === 'codex' ? (idFromCodexFilename(name) ?? '')
      : (parts[parts.length - 1] || '').toLowerCase()
  if (!id) return null
  const folder = provider === 'claude' ? parts[parts.length - 1] || '' : provider === 'cursor' ? parts[parts.length - 3] || '' : ''
  const c: Candidate = { provider, id, file, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, size: st.size, folder }
  const codexNames = provider === 'codex' && roots ? await loadCodexThreadNamesAll(roots) : new Map<string, string>()
  const cursorNames = provider === 'cursor' && roots?.cursorComposerDb ? await loadCursorComposerNames(roots.cursorComposerDb) : new Map<string, string>()
  const desktopTitles = new Map<string, string>()
  for (const head of (aliases ?? new Map()).values()) if (head?.title && head.cliSessionId?.toLowerCase() === id) desktopTitles.set(id, head.title)
  const r = await memoized(c, () => resolve(c, codexNames, cursorNames, desktopTitles))
  if (r.skip) return null
  return { session_id: r.id, provider, display_label: r.title, project: r.project, modified: isoFromMtime(c.mtimeMs), created: r.created, form: 'short' }
}
