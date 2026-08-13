// Local Claude / Codex / Cursor transcripts on this Mac.
// Default window is 7 days of last write (mtime). Codex Desktop pins keep
// the original YYYY/MM/DD folder, so listing by calendar path misses them.
// `sort=opened` uses session start instead. Same clocks as COS Control.
// The glasses companion cannot read these directories; the server can.

import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const AGENT_SESSION_WINDOW_HOURS = 7 * 24
export const AGENT_SESSION_MAX_AGE_MS = AGENT_SESSION_WINDOW_HOURS * 3600 * 1000
export const AGENT_SESSION_MAX_FILE_BYTES = 32 * 1024 * 1024
export const AGENT_SESSION_PER_PROVIDER_LIMIT = 20
export const AGENT_SESSION_LIST_LIMIT = AGENT_SESSION_PER_PROVIDER_LIMIT * 3
export const AGENT_SESSION_LIST_MAX = 80
const HEAD_BYTES = 256 * 1024
export const CLAUDE_UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/
const CODEX_ROLLOUT_STAMP = /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/

export type AgentProvider = 'claude' | 'codex' | 'cursor'
export type AgentSessionSort = 'updated' | 'opened'

export interface AgentSessionRow {
  session_id: string
  provider: AgentProvider
  display_label: string
  project: string
  modified: string
  created: string
  alive: boolean
  state: 'running' | 'recent'
  pinned: boolean
  first_prompt?: string
  discussion_summary?: string
}

export interface AgentSessionRoots {
  claudeProjects: string
  claudeDesktopConfig: string
  claudeCodeSessions: string
  codexSessions: string
  cursorProjects: string
  cursorComposerDb: string
  cursorWorkspaceStorage: string
}

export function agentSessionRoots(home = process.env.COS_AGENT_SESSIONS_HOME || homedir()): AgentSessionRoots {
  return {
    claudeProjects: join(home, '.claude', 'projects'),
    claudeDesktopConfig: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    claudeCodeSessions: join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
    codexSessions: join(home, '.codex', 'sessions'),
    cursorProjects: join(home, '.cursor', 'projects'),
    cursorComposerDb: join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    cursorWorkspaceStorage: join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
  }
}

export function isSafeSessionId(value: string): boolean {
  const needle = value.trim().toLowerCase()
  return needle.length >= 8
    && !needle.includes('..')
    && !needle.includes('/')
    && [...needle].every(ch => /[0-9a-f-]/.test(ch))
}

export function workspaceLabel(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('/')) {
    const parts = trimmed.split('/').filter(Boolean)
    return parts[parts.length - 1] || ''
  }
  const encoded = trimmed.startsWith('-') ? trimmed.slice(1) : trimmed
  if (encoded.includes('MU-Chief-Staff')) return 'MU-Chief-Staff'
  const github = encoded.lastIndexOf('GitHub-')
  if (github >= 0) {
    const rest = encoded.slice(github + 'GitHub-'.length)
    if (rest === 'MU-Chief-Staff' || rest.endsWith('-MU-Chief-Staff')) return 'MU-Chief-Staff'
    return rest
  }
  const parts = trimmed.split('/').filter(Boolean)
  return parts[parts.length - 1] || trimmed
}

export function isScratchCursorProject(folder: string): boolean {
  const name = folder.split('/').filter(Boolean).pop()?.toLowerCase() || folder.toLowerCase()
  return name.includes('var-folders') || name.includes('private-var') || name === 'empty-window'
}

export const isSkippedCursorFolder = isScratchCursorProject

export function isKeepWarmSessionTitle(title: string): boolean {
  const t = title.trim().toLowerCase()
  if (t === 'ready') return true
  return t.startsWith('this is an automated local readiness check')
}

export function isWrapperPrompt(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('<')
    || trimmed.startsWith('SYSTEM INSTRUCTIONS')
    || trimmed.startsWith('You are an agent')
    || trimmed.startsWith('You are QA Agent')
    || trimmed.startsWith('Message Type:')
}

export function firstLineTitle(text: string): string {
  let body = text
  const start = body.indexOf('<user_query>')
  const end = body.indexOf('</user_query>')
  if (start >= 0 && end > start) body = body.slice(start + '<user_query>'.length, end)
  body = body.replace(/<[^>]+>/g, ' ')
  const line = body.split('\n').map(s => s.trim()).find(s => s.length > 0) ?? ''
  return line.slice(0, 80)
}

export function proseSnippet(text: string, max = 160): string {
  let body = text.replace(/```[\s\S]*?```/g, ' ')
  body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!body || isWrapperPrompt(body)) return ''
  return body.slice(0, max)
}

export function composeDiscussionSummary(input: {
  title?: string
  firstPrompt?: string
  latestAssistant?: string
  max?: number
}): string {
  const max = input.max ?? 180
  const title = (input.title ?? '').replace(/\s+/g, ' ').trim()
  const first = firstLineTitle(input.firstPrompt ?? '')
  const latest = (input.latestAssistant ?? '').replace(/\s+/g, ' ').trim()
  const opening = first && first !== title ? first : ''
  const parts: string[] = []
  if (opening) parts.push(opening)
  if (latest && latest !== title && latest !== opening) parts.push(latest)
  const joined = parts.join(' · ')
  if (!joined) return ''
  return joined.length <= max ? joined : `${joined.slice(0, max - 1)}…`
}

export function assistantProseFromRecord(obj: Record<string, unknown>): string | null {
  if (obj.type === 'assistant') {
    const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null
    const text = message ? payloadText(message) : null
    return text ? proseSnippet(text) || null : null
  }
  if (obj.type === 'response_item' && obj.payload && typeof obj.payload === 'object') {
    const payload = obj.payload as Record<string, unknown>
    if (payload.role === 'assistant' && (payload.type === 'message' || !payload.type)) {
      const text = payloadText(payload)
      return text ? proseSnippet(text) || null : null
    }
  }
  if (obj.role === 'assistant') {
    const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null
    const text = message ? payloadText(message) : null
    return text ? proseSnippet(text) || null : null
  }
  return null
}

export function latestAssistantFromWindow(text: string): string {
  let latest = ''
  for (const line of text.split('\n')) {
    const obj = parseJsonLine(line)
    if (!obj) continue
    const prose = assistantProseFromRecord(obj)
    if (prose) latest = prose
  }
  return latest
}

function discussionFields(title: string, firstPrompt: string, latestAssistant: string): {
  first_prompt: string
  discussion_summary: string
} {
  return {
    first_prompt: firstPrompt,
    discussion_summary: composeDiscussionSummary({ title, firstPrompt, latestAssistant }),
  }
}

function cursorUserTitle(body: string, requireQuery: boolean): string | null {
  if (requireQuery && !body.includes('<user_query>')) return null
  const title = firstLineTitle(body)
  if (!title || isWrapperPrompt(title)) return null
  return title
}

export function payloadText(payload: Record<string, unknown>): string | null {
  const content = payload.content
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed ? trimmed : null
  }
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const type = String((block as { type?: unknown }).type ?? '')
    if (type === 'tool_result' || type === 'tool_use' || type === 'thinking') continue
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = String((block as { text?: unknown }).text ?? '').trim()
      if (text) parts.push(text)
    }
  }
  const joined = parts.join('\n\n').trim()
  return joined || null
}

export function isoFromMtime(mtimeMs: number): string {
  return new Date(mtimeMs).toISOString()
}

function row(partial: Omit<AgentSessionRow, 'created' | 'state' | 'pinned'> & {
  created?: string
  state?: AgentSessionRow['state']
  pinned?: boolean
}): AgentSessionRow {
  return {
    ...partial,
    created: partial.created ?? partial.modified,
    state: partial.state ?? (partial.alive ? 'running' : 'recent'),
    pinned: partial.pinned ?? false,
  }
}

export function idFromCodexFilename(name: string): string | null {
  if (!name.endsWith('.jsonl')) return null
  const parts = name.slice(0, -6).split('-')
  if (parts.length < 5) return null
  const uuid = parts.slice(-5).join('-').toLowerCase()
  return uuid.length >= 36 ? uuid : null
}

export async function dirents(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

export async function fileStat(path: string): Promise<{ mtimeMs: number; birthtimeMs: number; size: number; isFile: boolean } | null> {
  try {
    const st = await lstat(path)
    return {
      mtimeMs: st.mtimeMs,
      birthtimeMs: st.birthtimeMs || st.mtimeMs,
      size: st.size,
      isFile: st.isFile(),
    }
  } catch {
    return null
  }
}

export async function readWindow(path: string, fromEnd: boolean): Promise<string> {
  const st = await fileStat(path)
  if (!st?.isFile || st.size <= 0) return ''
  let start = 0
  let end = st.size - 1
  if (st.size > HEAD_BYTES) {
    if (fromEnd) start = st.size - HEAD_BYTES
    else end = HEAD_BYTES - 1
  }
  const stream = createReadStream(path, { start, end })
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(line) as unknown
    return obj && typeof obj === 'object' ? obj as Record<string, unknown> : null
  } catch {
    return null
  }
}

export async function lastCustomTitle(path: string): Promise<string | null> {
  const text = await readWindow(path, true)
  let found: string | null = null
  for (const line of text.split('\n')) {
    if (!line.includes('custom-title')) continue
    const obj = parseJsonLine(line)
    if (obj?.type !== 'custom-title') continue
    const title = String(obj.customTitle ?? '').trim()
    if (title) found = title.slice(0, 120)
  }
  return found
}

export async function peekClaudeDiscussion(path: string): Promise<{ customTitle: string | null; latestAssistant: string }> {
  const text = await readWindow(path, true)
  let customTitle: string | null = null
  for (const line of text.split('\n')) {
    if (line.includes('custom-title')) {
      const obj = parseJsonLine(line)
      if (obj?.type === 'custom-title') {
        const title = String(obj.customTitle ?? '').trim()
        if (title) customTitle = title.slice(0, 120)
      }
    }
  }
  return { customTitle, latestAssistant: latestAssistantFromWindow(text) }
}

export async function firstClaudeUserTitle(path: string): Promise<string | null> {
  const text = await readWindow(path, false)
  for (const line of text.split('\n')) {
    const obj = parseJsonLine(line)
    if (!obj || obj.type !== 'user' || obj.toolUseResult || obj.isSidechain === true) continue
    const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null
    const body = message ? payloadText(message) : null
    if (!body) continue
    const title = firstLineTitle(body)
    if (title) return title
  }
  return null
}

export function createdFromCodexFilename(name: string): string | null {
  const match = CODEX_ROLLOUT_STAMP.exec(name)
  if (!match) return null
  const stamp = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}`)
  return Number.isFinite(stamp.getTime()) ? stamp.toISOString() : null
}

export async function loadCodexThreadNames(sessionsRoot: string): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const indexPath = join(sessionsRoot, '..', 'session_index.jsonl')
  try {
    const rl = createInterface({ input: createReadStream(indexPath), crlfDelay: Infinity })
    for await (const line of rl) {
      const obj = parseJsonLine(line)
      if (!obj) continue
      const id = String(obj.id ?? '').trim()
      const name = String(obj.thread_name ?? '').trim()
      if (id && name) names.set(id, name.slice(0, 120))
    }
  } catch {
    return names
  }
  return names
}

export async function loadCodexPinnedIds(sessionsRoot: string): Promise<Set<string>> {
  const pinned = new Set<string>()
  const statePath = join(sessionsRoot, '..', '.codex-global-state.json')
  try {
    const raw = await readFile(statePath, 'utf8')
    const obj = JSON.parse(raw) as { 'pinned-thread-ids'?: unknown }
    const list = obj['pinned-thread-ids']
    if (!Array.isArray(list)) return pinned
    for (const value of list) {
      const id = String(value ?? '').trim().toLowerCase()
      if (id) pinned.add(id)
    }
  } catch {
    return pinned
  }
  return pinned
}

export function normalizeClaudeSessionId(raw: string): string {
  let id = raw.trim().toLowerCase()
  if (id.startsWith('local_')) id = id.slice('local_'.length)
  return id
}

export function peekClaudeDesktopHead(text: string): { title: string; cwd: string } {
  const unescape = (value: string) => value.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  const title = /"title"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(text)
  const cwd = /"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(text)
  return {
    title: title ? unescape(title[1]).slice(0, 120) : '',
    cwd: cwd ? unescape(cwd[1]) : '',
  }
}

export async function loadClaudeStarredIds(configPath: string): Promise<Set<string>> {
  const starred = new Set<string>()
  if (!configPath) return starred
  try {
    const obj = JSON.parse(await readFile(configPath, 'utf8')) as {
      preferences?: { epitaxyPrefs?: { 'starred-local-code-sessions'?: unknown } }
    }
    const list = obj.preferences?.epitaxyPrefs?.['starred-local-code-sessions']
    if (!Array.isArray(list)) return starred
    for (const value of list) {
      const id = normalizeClaudeSessionId(String(value ?? ''))
      if (id) starred.add(id)
    }
  } catch {
    return starred
  }
  return starred
}

function parsePinnedComposerList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? (parsed as { composerIds?: unknown; ids?: unknown }).composerIds
          ?? (parsed as { ids?: unknown }).ids
        : null
    if (!Array.isArray(list)) return []
    return list.map(value => String(value ?? '').trim().toLowerCase()).filter(Boolean)
  } catch {
    return []
  }
}

export async function loadCursorPinnedIds(workspaceStorage: string): Promise<Set<string>> {
  const pinned = new Set<string>()
  if (!workspaceStorage) return pinned
  for (const folder of await dirents(workspaceStorage)) {
    const dbPath = join(workspaceStorage, folder, 'state.vscdb')
    const st = await fileStat(dbPath)
    if (!st?.isFile) continue
    try {
      const { stdout } = await execFileAsync('/usr/bin/sqlite3', [
        '-readonly',
        dbPath,
        "SELECT value FROM ItemTable WHERE key = 'cursor/pinnedComposers' LIMIT 1",
      ], { timeout: 2000, maxBuffer: 256 * 1024 })
      for (const id of parsePinnedComposerList(stdout.trim())) pinned.add(id)
    } catch {
      continue
    }
  }
  return pinned
}

export async function findClaudeDesktopFile(sessionsRoot: string, uuid: string): Promise<string | null> {
  if (!sessionsRoot || !uuid) return null
  const name = `local_${uuid}.json`
  for (const account of await dirents(sessionsRoot)) {
    const accountDir = join(sessionsRoot, account)
    const accountSt = await fileStat(accountDir)
    if (!accountSt || accountSt.isFile) continue
    for (const workspace of await dirents(accountDir)) {
      const file = join(accountDir, workspace, name)
      const st = await fileStat(file)
      if (st?.isFile) return file
    }
  }
  return null
}

export function preferCursorCopy(
  next: { file: string; sessionDir: string; project: string; mtimeMs: number; birthtimeMs: number },
  existing: { file: string; sessionDir: string; project: string; mtimeMs: number; birthtimeMs: number },
): typeof next {
  if (next.project === 'empty-window' && existing.project !== 'empty-window') return existing
  if (existing.project === 'empty-window' && next.project !== 'empty-window') return next
  return next.mtimeMs >= existing.mtimeMs ? next : existing
}

export async function loadCursorComposerNames(dbPath: string): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (!dbPath) return names
  const st = await fileStat(dbPath)
  if (!st?.isFile) return names
  try {
    const { stdout } = await execFileAsync('/usr/bin/sqlite3', [
      '-readonly',
      '-json',
      dbPath,
      "SELECT composerId AS id, json_extract(value, '$.name') AS name FROM composerHeaders WHERE json_extract(value, '$.name') IS NOT NULL AND json_extract(value, '$.name') != ''",
    ], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 })
    const rows = JSON.parse(stdout || '[]') as Array<{ id?: string; composerId?: string; name?: string }>
    for (const row of rows) {
      const id = String(row.id ?? row.composerId ?? '').trim()
      const name = String(row.name ?? '').trim()
      if (id && name) names.set(id, name.slice(0, 120))
    }
  } catch {
    return names
  }
  return names
}

export async function peekCodexMeta(path: string): Promise<{ id: string; cwd: string; title: string; subagent: boolean; created: string } | null> {
  const text = await readWindow(path, false)
  let id = ''
  let cwd = ''
  let title = ''
  let created = ''
  let subagent = false
  for (const line of text.split('\n')) {
    const obj = parseJsonLine(line)
    if (!obj) continue
    if (obj.type === 'session_meta' && obj.payload && typeof obj.payload === 'object') {
      const payload = obj.payload as Record<string, unknown>
      id = String(payload.id ?? payload.session_id ?? id)
      cwd = String(payload.cwd ?? cwd)
      subagent = payload.thread_source === 'subagent'
      const nick = String(payload.agent_nickname ?? '').trim()
      if (nick && !title) title = nick
      const stamp = String(payload.timestamp ?? obj.timestamp ?? '').trim()
      if (stamp && !created) created = stamp
    }
    if (!title && obj.type === 'response_item' && obj.payload && typeof obj.payload === 'object') {
      const payload = obj.payload as Record<string, unknown>
      if (payload.type === 'message' && payload.role === 'user') {
        const textBody = payloadText(payload)
        if (textBody && !isWrapperPrompt(textBody)) title = firstLineTitle(textBody)
      }
    }
    if (id && title) break
  }
  return { id, cwd, title, subagent, created }
}

async function peekCursorDiscussion(path: string): Promise<{ lastUser: string | null; latestAssistant: string }> {
  const text = await readWindow(path, true)
  let lastUser: string | null = null
  for (const line of text.split('\n')) {
    const obj = parseJsonLine(line)
    if (!obj || obj.role !== 'user') continue
    const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null
    const body = message ? payloadText(message) : null
    if (!body) continue
    const title = cursorUserTitle(body, true)
    if (title) lastUser = title
  }
  return { lastUser, latestAssistant: latestAssistantFromWindow(text) }
}

async function firstCursorUserTitle(path: string): Promise<string | null> {
  const text = await readWindow(path, false)
  let fallback: string | null = null
  for (const line of text.split('\n')) {
    const obj = parseJsonLine(line)
    if (!obj || obj.role !== 'user') continue
    const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null
    const body = message ? payloadText(message) : null
    if (!body) continue
    const query = cursorUserTitle(body, true)
    if (query) return query
    if (!fallback) fallback = cursorUserTitle(body, false)
  }
  return fallback
}

export async function listCodexJsonlFiles(sessionsRoot: string): Promise<string[]> {
  const files: string[] = []
  for (const year of await dirents(sessionsRoot)) {
    const yearDir = join(sessionsRoot, year)
    const yearSt = await fileStat(yearDir)
    if (!yearSt || yearSt.isFile) continue
    for (const month of await dirents(yearDir)) {
      const monthDir = join(yearDir, month)
      const monthSt = await fileStat(monthDir)
      if (!monthSt || monthSt.isFile) continue
      for (const day of await dirents(monthDir)) {
        const dayDir = join(monthDir, day)
        const daySt = await fileStat(dayDir)
        if (!daySt || daySt.isFile) continue
        for (const name of await dirents(dayDir)) {
          if (name.endsWith('.jsonl')) files.push(join(dayDir, name))
        }
      }
    }
  }
  return files
}

export async function listClaudeSessions(
  projectsRoot: string,
  now: Date,
  liveIds: Set<string>,
  cap = AGENT_SESSION_PER_PROVIDER_LIMIT,
  starredIds: ReadonlySet<string> = new Set(),
  desktopSessionsRoot = '',
): Promise<AgentSessionRow[]> {
  const seen = new Set<string>()
  const pinnedCandidates: Array<{ file: string; native: string; project: string; mtimeMs: number; birthtimeMs: number; desktop?: string }> = []
  const recentCandidates: Array<{ file: string; native: string; project: string; mtimeMs: number; birthtimeMs: number; desktop?: string }> = []
  for (const folder of await dirents(projectsRoot)) {
    const dir = join(projectsRoot, folder)
    const dirSt = await fileStat(dir)
    if (!dirSt || dirSt.isFile) continue
    for (const name of await dirents(dir)) {
      if (!CLAUDE_UUID_JSONL.test(name)) continue
      const native = name.slice(0, -6)
      const shortId = native.slice(0, 8)
      if (liveIds.has(shortId) || liveIds.has(native)) continue
      const file = join(dir, name)
      const st = await fileStat(file)
      if (!st?.isFile) continue
      const pinned = starredIds.has(native.toLowerCase())
      const fresh = now.getTime() - st.mtimeMs <= AGENT_SESSION_MAX_AGE_MS
      if (!pinned && !fresh) continue
      const candidate = {
        file,
        native,
        project: workspaceLabel(folder),
        mtimeMs: st.mtimeMs,
        birthtimeMs: st.birthtimeMs,
      }
      seen.add(native.toLowerCase())
      if (pinned) pinnedCandidates.push(candidate)
      else recentCandidates.push(candidate)
    }
  }
  for (const starred of starredIds) {
    if (seen.has(starred) || liveIds.has(starred) || liveIds.has(starred.slice(0, 8))) continue
    const desktop = await findClaudeDesktopFile(desktopSessionsRoot, starred)
    if (!desktop) continue
    const st = await fileStat(desktop)
    if (!st?.isFile) continue
    pinnedCandidates.push({
      file: '',
      native: starred,
      project: '',
      mtimeMs: st.mtimeMs,
      birthtimeMs: st.birthtimeMs,
      desktop,
    })
    seen.add(starred)
  }
  pinnedCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  recentCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const toRows = async (candidates: typeof recentCandidates, limit: number): Promise<AgentSessionRow[]> => {
    const rows: AgentSessionRow[] = []
    for (const candidate of candidates) {
      if (rows.length >= Math.max(0, limit)) break
      let title = ''
      let project = candidate.project
      let firstPrompt = ''
      let latestAssistant = ''
      if (candidate.file) {
        const peek = await peekClaudeDiscussion(candidate.file)
        firstPrompt = await firstClaudeUserTitle(candidate.file) ?? ''
        title = peek.customTitle ?? firstPrompt
        latestAssistant = peek.latestAssistant
      }
      if ((!title || !project) && (candidate.desktop || desktopSessionsRoot)) {
        const desktop = candidate.desktop || await findClaudeDesktopFile(desktopSessionsRoot, candidate.native)
        if (desktop) {
          const head = peekClaudeDesktopHead(await readWindow(desktop, false))
          if (!title && head.title) title = head.title
          if (!project && head.cwd) project = workspaceLabel(head.cwd)
        }
      }
      title = title || 'Claude session'
      if (isKeepWarmSessionTitle(title)) continue
      rows.push(row({
        session_id: candidate.native,
        provider: 'claude',
        display_label: title,
        project,
        modified: isoFromMtime(candidate.mtimeMs),
        created: isoFromMtime(candidate.birthtimeMs),
        alive: false,
        pinned: starredIds.has(candidate.native.toLowerCase()),
        ...discussionFields(title, firstPrompt, latestAssistant),
      }))
    }
    return rows
  }

  return [
    ...await toRows(pinnedCandidates, Math.max(pinnedCandidates.length, 0)),
    ...await toRows(recentCandidates, Math.max(0, cap)),
  ]
}

export async function listCodexSessions(
  sessionsRoot: string,
  now: Date,
  cap = AGENT_SESSION_PER_PROVIDER_LIMIT,
): Promise<AgentSessionRow[]> {
  const names = await loadCodexThreadNames(sessionsRoot)
  const pinnedIds = await loadCodexPinnedIds(sessionsRoot)
  const pinnedCandidates: Array<{ file: string; name: string; mtimeMs: number; birthtimeMs: number }> = []
  const recentCandidates: Array<{ file: string; name: string; mtimeMs: number; birthtimeMs: number }> = []
  for (const file of await listCodexJsonlFiles(sessionsRoot)) {
    const st = await fileStat(file)
    if (!st?.isFile) continue
    const name = file.split('/').pop() || file
    const fileId = idFromCodexFilename(name)
    const pinned = fileId ? pinnedIds.has(fileId) : false
    const fresh = now.getTime() - st.mtimeMs <= AGENT_SESSION_MAX_AGE_MS
    if (!pinned && !fresh) continue
    const candidate = { file, name, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs }
    if (pinned) pinnedCandidates.push(candidate)
    else recentCandidates.push(candidate)
  }
  pinnedCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  recentCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const toRows = async (candidates: typeof recentCandidates, limit: number): Promise<AgentSessionRow[]> => {
    const rows: AgentSessionRow[] = []
    for (const candidate of candidates) {
      if (rows.length >= Math.max(0, limit)) break
      const meta = await peekCodexMeta(candidate.file)
      if (!meta || meta.subagent) continue
      const native = meta.id || candidate.name.slice(0, -6)
      const title = names.get(native) || meta.title || 'Codex session'
      if (isKeepWarmSessionTitle(title)) continue
      const created = meta.created || createdFromCodexFilename(candidate.name) || isoFromMtime(candidate.birthtimeMs)
      const latestAssistant = latestAssistantFromWindow(await readWindow(candidate.file, true))
      rows.push(row({
        session_id: native,
        provider: 'codex',
        display_label: title,
        project: workspaceLabel(meta.cwd),
        modified: isoFromMtime(candidate.mtimeMs),
        created,
        alive: false,
        pinned: pinnedIds.has(native.toLowerCase()),
        ...discussionFields(title, meta.title, latestAssistant),
      }))
    }
    return rows
  }

  const pinnedRows = await toRows(pinnedCandidates, Math.max(pinnedCandidates.length, 0))
  const recentRows = await toRows(recentCandidates, Math.max(0, cap))
  return [...pinnedRows, ...recentRows]
}

export async function listCursorSessions(
  projectsRoot: string,
  now: Date,
  cap = AGENT_SESSION_PER_PROVIDER_LIMIT,
  composerDb = '',
  pinnedIds: ReadonlySet<string> = new Set(),
): Promise<AgentSessionRow[]> {
  const composerNames = composerDb ? await loadCursorComposerNames(composerDb) : new Map<string, string>()
  const byId = new Map<string, { file: string; sessionDir: string; project: string; mtimeMs: number; birthtimeMs: number }>()
  for (const folder of await dirents(projectsRoot)) {
    if (folder.includes('var-folders') || folder.includes('private-var')) continue
    const transcripts = join(projectsRoot, folder, 'agent-transcripts')
    for (const sessionDir of await dirents(transcripts)) {
      if (sessionDir === 'subagents') continue
      const pinned = pinnedIds.has(sessionDir.toLowerCase())
      if (folder === 'empty-window' && !pinned) continue
      const file = join(transcripts, sessionDir, `${sessionDir}.jsonl`)
      const st = await fileStat(file)
      if (!st?.isFile) continue
      if (!pinned && st.size > AGENT_SESSION_MAX_FILE_BYTES) continue
      const fresh = now.getTime() - st.mtimeMs <= AGENT_SESSION_MAX_AGE_MS
      if (!pinned && !fresh) continue
      const next = {
        file,
        sessionDir,
        project: workspaceLabel(folder),
        mtimeMs: st.mtimeMs,
        birthtimeMs: st.birthtimeMs,
      }
      const existing = byId.get(sessionDir)
      byId.set(sessionDir, existing ? preferCursorCopy(next, existing) : next)
    }
  }
  const pinnedCandidates = [...byId.values()].filter(c => pinnedIds.has(c.sessionDir.toLowerCase()))
  const recentCandidates = [...byId.values()].filter(c => !pinnedIds.has(c.sessionDir.toLowerCase()))
  pinnedCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  recentCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const toRows = async (candidates: typeof recentCandidates, limit: number): Promise<AgentSessionRow[]> => {
    const rows: AgentSessionRow[] = []
    for (const candidate of candidates) {
      if (rows.length >= Math.max(0, limit)) break
      const peek = await peekCursorDiscussion(candidate.file)
      const firstPrompt = await firstCursorUserTitle(candidate.file) ?? peek.lastUser ?? ''
      const title = composerNames.get(candidate.sessionDir)
        ?? peek.lastUser
        ?? firstPrompt
        ?? 'Cursor session'
      if (isKeepWarmSessionTitle(title)) continue
      const alive = now.getTime() - candidate.mtimeMs < 180_000
      rows.push(row({
        session_id: candidate.sessionDir,
        provider: 'cursor',
        display_label: title,
        project: candidate.project,
        modified: isoFromMtime(candidate.mtimeMs),
        created: isoFromMtime(candidate.birthtimeMs),
        alive,
        state: alive ? 'running' : 'recent',
        pinned: pinnedIds.has(candidate.sessionDir.toLowerCase()),
        ...discussionFields(title, firstPrompt, peek.latestAssistant),
      }))
    }
    return rows
  }

  return [
    ...await toRows(pinnedCandidates, Math.max(pinnedCandidates.length, 0)),
    ...await toRows(recentCandidates, Math.max(0, cap)),
  ]
}

async function enrichLiveClaude(row: AgentSessionRow, roots: AgentSessionRoots): Promise<AgentSessionRow> {
  if (row.provider !== 'claude') return row
  const found = await findAgentSessionFile('claude', row.session_id, roots)
  if (!found) return row
  const peek = await peekClaudeDiscussion(found)
  const firstPrompt = await firstClaudeUserTitle(found)
  const title = peek.customTitle ?? firstPrompt ?? row.display_label
  const fullId = found.split('/').pop()?.replace(/\.jsonl$/i, '') || row.session_id
  return {
    ...row,
    session_id: fullId,
    display_label: title || row.display_label || 'Claude session',
    ...discussionFields(title || row.display_label, firstPrompt || '', peek.latestAssistant),
  }
}

function sessionKey(row: AgentSessionRow): string {
  return `${row.provider}:${row.session_id.trim().toLowerCase()}`
}

function preferSession(next: AgentSessionRow, current: AgentSessionRow): AgentSessionRow {
  if (next.alive !== current.alive) return next.alive ? next : current
  if (next.pinned !== current.pinned) return next.pinned ? next : current
  if (next.project === 'empty-window' && current.project !== 'empty-window') return current
  if (current.project === 'empty-window' && next.project !== 'empty-window') return next
  return (next.modified || '') > (current.modified || '') ? next : current
}

function dedupeSessions(rows: AgentSessionRow[]): AgentSessionRow[] {
  const byKey = new Map<string, AgentSessionRow>()
  for (const row of rows) {
    const key = sessionKey(row)
    const existing = byKey.get(key)
    byKey.set(key, existing ? preferSession(row, existing) : row)
  }
  return [...byKey.values()]
}

export async function listAgentSessions(
  roots: AgentSessionRoots,
  now = new Date(),
  live: AgentSessionRow[] = [],
  limit = AGENT_SESSION_LIST_LIMIT,
  sort: AgentSessionSort = 'updated',
): Promise<AgentSessionRow[]> {
  const starredIds = await loadClaudeStarredIds(roots.claudeDesktopConfig)
  const cursorPinned = await loadCursorPinnedIds(roots.cursorWorkspaceStorage)
  const enrichedLive = (await Promise.all(live.map(row => enrichLiveClaude(row, roots))))
    .filter(entry => !isKeepWarmSessionTitle(entry.display_label))
    .map(entry => {
      if (entry.provider === 'claude' && starredIds.has(normalizeClaudeSessionId(entry.session_id))) {
        return { ...entry, pinned: true }
      }
      if (entry.provider === 'cursor' && cursorPinned.has(entry.session_id.toLowerCase())) {
        return { ...entry, pinned: true }
      }
      return entry
    })
  const liveIds = new Set(enrichedLive.flatMap(row => [row.session_id, row.session_id.slice(0, 8)]))
  const cap = AGENT_SESSION_PER_PROVIDER_LIMIT
  let rows = dedupeSessions([
    ...enrichedLive,
    ...await listClaudeSessions(roots.claudeProjects, now, liveIds, cap, starredIds, roots.claudeCodeSessions),
    ...await listCodexSessions(roots.codexSessions, now, cap),
    ...await listCursorSessions(roots.cursorProjects, now, cap, roots.cursorComposerDb, cursorPinned),
  ])
  if (sort === 'opened') {
    rows = rows.filter(entry => {
      if (entry.alive) return true
      const created = Date.parse(entry.created)
      return Number.isFinite(created) && now.getTime() - created <= AGENT_SESSION_MAX_AGE_MS
    })
    rows.sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return (b.created || '').localeCompare(a.created || '')
    })
  } else {
    rows.sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return (b.modified || '').localeCompare(a.modified || '')
    })
  }
  return rows.slice(0, limit)
}

export async function findAgentSessionFile(
  provider: AgentProvider,
  sessionId: string,
  roots: AgentSessionRoots,
  now = new Date(),
): Promise<string | null> {
  if (!isSafeSessionId(sessionId)) return null
  const needle = sessionId.trim().toLowerCase()
  if (provider === 'claude') {
    for (const folder of await dirents(roots.claudeProjects)) {
      const dir = join(roots.claudeProjects, folder)
      for (const name of await dirents(dir)) {
        if (!name.endsWith('.jsonl')) continue
        const id = name.slice(0, -6).toLowerCase()
        if (id === needle || id.startsWith(needle)) return join(dir, name)
      }
    }
    return null
  }
  if (provider === 'codex') {
    for (const file of await listCodexJsonlFiles(roots.codexSessions)) {
      const name = file.split('/').pop()?.toLowerCase() ?? ''
      if (name.includes(needle)) return file
    }
    return null
  }
  let best: { file: string; mtimeMs: number } | null = null
  for (const folder of await dirents(roots.cursorProjects)) {
    if (isSkippedCursorFolder(folder)) continue
    const file = join(roots.cursorProjects, folder, 'agent-transcripts', needle, `${needle}.jsonl`)
    const st = await fileStat(file)
    if (!st?.isFile) continue
    if (!best || st.mtimeMs >= best.mtimeMs) best = { file, mtimeMs: st.mtimeMs }
  }
  return best?.file ?? null
}

export interface AgentSessionDetail {
  session_id: string
  provider: AgentProvider
  display_label: string
  project: string
  git_branch: string
  first_prompt: string
  discussion_summary: string
  user_message_count: number
  assistant_message_count: number
  omitted_tools: number
  file_size_bytes: number
}

export async function parseAgentSession(provider: AgentProvider, path: string): Promise<AgentSessionDetail> {
  const st = await stat(path)
  let title = ''
  let project = ''
  let gitBranch = ''
  let sessionId = path.split('/').pop()?.replace(/\.jsonl$/, '') || ''
  let firstPrompt = ''
  let latestAssistant = ''
  let userCount = 0
  let assistantCount = 0
  let omittedTools = 0

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    const obj = parseJsonLine(line)
    if (!obj) continue
    if (provider === 'claude') {
      if (typeof obj.sessionId === 'string' && obj.sessionId) sessionId = obj.sessionId
      if (obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle.trim()) {
        title = obj.customTitle.trim()
        continue
      }
      if (obj.isSidechain === true) continue
      if (!project && typeof obj.cwd === 'string') project = workspaceLabel(obj.cwd)
      if (!gitBranch && typeof obj.gitBranch === 'string') gitBranch = obj.gitBranch
      if (obj.type === 'user' && obj.toolUseResult) { omittedTools += 1; continue }
      if (obj.type !== 'user' && obj.type !== 'assistant') continue
      const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null
      const text = message ? payloadText(message) : null
      if (!text) {
        if (obj.type === 'assistant') omittedTools += 1
        continue
      }
      if (obj.type === 'user') {
        userCount += 1
        if (!firstPrompt) firstPrompt = firstLineTitle(text)
        if (!title) title = firstLineTitle(text)
      } else {
        assistantCount += 1
        const snippet = proseSnippet(text)
        if (snippet) latestAssistant = snippet
      }
    } else if (provider === 'codex') {
      if (obj.type === 'session_meta' && obj.payload && typeof obj.payload === 'object') {
        const payload = obj.payload as Record<string, unknown>
        if (typeof payload.cwd === 'string') project = workspaceLabel(payload.cwd)
        if (typeof payload.id === 'string' && payload.id) sessionId = payload.id
        const git = payload.git && typeof payload.git === 'object' ? payload.git as Record<string, unknown> : null
        if (git && typeof git.branch === 'string') gitBranch = git.branch
        continue
      }
      if (obj.type !== 'response_item' || !obj.payload || typeof obj.payload !== 'object') continue
      const payload = obj.payload as Record<string, unknown>
      const kind = String(payload.type ?? '')
      if (kind === 'custom_tool_call' || kind === 'custom_tool_call_output' || kind === 'function_call') {
        omittedTools += 1
        continue
      }
      if (kind !== 'message' || payload.role === 'developer') continue
      const text = payloadText(payload)
      if (!text || isWrapperPrompt(text)) continue
      if (payload.role === 'assistant') {
        assistantCount += 1
        const snippet = proseSnippet(text)
        if (snippet) latestAssistant = snippet
      } else {
        userCount += 1
        if (!firstPrompt) firstPrompt = firstLineTitle(text)
        if (!title) title = firstLineTitle(text)
      }
    } else {
      if (obj.role !== 'user' && obj.role !== 'assistant') continue
      const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null
      if (Array.isArray(message?.content) && (message.content as Array<{ type?: string }>).some(b => b?.type === 'tool_use')) {
        omittedTools += 1
      }
      const text = message ? payloadText(message) : null
      if (!text) continue
      if (obj.role === 'user') {
        userCount += 1
        const query = cursorUserTitle(text, true) ?? cursorUserTitle(text, false)
        if (query) {
          title = query
          if (!firstPrompt) firstPrompt = query
        }
      } else {
        assistantCount += 1
        const snippet = proseSnippet(text)
        if (snippet) latestAssistant = snippet
      }
    }
  }

  if (provider === 'cursor' && !project) {
    const parts = path.split('/')
    const encoded = parts[parts.indexOf('agent-transcripts') - 1] || ''
    project = workspaceLabel(encoded)
  }

  const display = title || (provider === 'codex' ? 'Codex session' : provider === 'cursor' ? 'Cursor session' : 'Claude session')
  return {
    session_id: sessionId,
    provider,
    display_label: display,
    project,
    git_branch: gitBranch,
    first_prompt: firstPrompt || title,
    discussion_summary: composeDiscussionSummary({
      title: display,
      firstPrompt: firstPrompt || title,
      latestAssistant,
    }),
    user_message_count: userCount,
    assistant_message_count: assistantCount,
    omitted_tools: omittedTools,
    file_size_bytes: st.size,
  }
}
