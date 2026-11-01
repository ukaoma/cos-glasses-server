/**
 * The sessions meaning search can ask about (Control 0.5.362, the "find" route): which sessions exist, what each is
 * called, what its first typed prompt says, and when it last did something.
 *
 * WHY THIS IS NOT THE LIST OR THE SESSIONS-TAB COLLECTOR (validated 2026-11-01, all measured on the owner's Mac).
 *   - The list keeps the first LINE of the first prompt, cut to 80 characters. 431 of 467 first prompts are longer, and
 *     meaning search on titles alone found the right session 15 times in 20 against 19 with the first 150 characters.
 *   - The list is capped at 7 days of file writes and 80 rows. mtime also lies: 234 of 854 Claude transcripts were touched
 *     7 or more days after their last record (a relaunch appends bookkeeping). This collector orders by the transcript's own
 *     last record, with its own memo, because the list's memo holds 480 entries and thrashes at this size.
 *   - Machine sessions fill the newest 254 slots: raw, they reach 8 days; without them, about 33. Dropped here: no typed
 *     first prompt, a title seen 5 or more times, a Claude Desktop scheduled task, a keep-warm title, an archived Desktop
 *     session, and anything that ran on a key.
 *   - Codex compresses finished rollouts (1,080 of 1,099 on that Mac are `.jsonl.zst`). `listCodexJsonlFiles` only takes
 *     `.jsonl`, and every reader of it (detail, stream, completion, tails) is zstd-blind, so it is left alone. This module
 *     has its own head-only lister and reader. A compressed row carries `compressed: true` and no file path ever leaves.
 *
 * ZSTD IS OPTIONAL. `createZstdDecompress` exists from Node 22.15 and 23.8; `engines` is `>=20.11`. A NAMED import of it
 * fails when the module loads on an older Node and the server would not boot. The default import plus a `typeof` check at
 * the call keeps boot safe; without the function a compressed file is skipped and COUNTED (`skippedNoDecoder`), never
 * guessed at and never silent.
 *
 * Nothing here reads more than the first megabyte of a file, calls a model, or logs a title or a prompt.
 */
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Transform } from 'node:stream'
import zlib from 'node:zlib'
import {
  AGENT_SESSION_MAX_FILE_BYTES,
  CLAUDE_UUID_JSONL,
  agentSessionRoots,
  codexUserText,
  createdFromCodexFilename,
  dirents,
  fileStat,
  firstLineTitle,
  isKeepWarmSessionTitle,
  isSkippedCursorFolder,
  isWrapperPrompt,
  isoFromMtime,
  lastCustomTitle,
  loadClaudeDesktopAliases,
  loadCodexThreadNames,
  loadCursorComposerNames,
  parseJsonLine,
  payloadText,
  preferCursorCopy,
  workspaceLabel,
  type AgentProvider,
  type AgentSessionRoots,
} from './agent-session-store.js'
import { ACTIVITY_READ_CONCURRENCY, mapWithConcurrency, readSessionActivity } from './agent-session-activity.js'

/**
 * The most that is read from the top of a file (decompressed) to find its first typed prompt, stopping at the first one. A typed
 * prompt is rarely deep: 256 KB found 135 of 172 Codex first prompts, 1 MB found 151, 16 MB all of them. Only a file that has none
 * near the top reads further, so the cost lands on long machine runs, once per file (the memo keeps the answer).
 */
export const FIND_HEAD_BYTES = 16 * 1024 * 1024
const FIND_CHUNK_BYTES = 64 * 1024
/** A title seen this many times in the pool is a machine run (a routine, a proxy, a probe), not a conversation. */
export const FIND_REPEAT_TITLE_LIMIT = 5
/** The typed first prompt kept per session, unwrapped and on one line. Redaction reads all of it; the model gets 150. */
export const FIND_PROMPT_KEEP_CHARS = 2_000
/** A prompt is unwrapped from at most this much of its start, so an unclosed tag cannot make the scan quadratic. */
const UNWRAP_SCAN_CHARS = 50_000
/** Files opened at most per walk. The newest-first stop below ends nearly every walk long before this. */
export const FIND_MAX_OPEN = 4_000
/** Files read at once, and files per batch before the stop rule is checked. */
const BATCH = 32
/** A Desktop record read whole to find its scheduled-task and archived flags. The largest seen is 0.7 MB. */
const DESKTOP_RECORD_MAX_BYTES = 8 * 1024 * 1024
export const FIND_MEMO_MAX = 8_000

const WRAP_TAGS = 'system-reminder|relevant-memories|cache-health|daily-bulletin|cos-alarms|device-handoff|now|local-command-stdout|local-command-stderr|command-name|command-message|command-args|task-notification|user-prompt-submit-hook|ide_opened_file|ide_selection|environment_context|attached_files|open_files|user_info|git_status|rules|agent_transcripts|image'
const WRAP_RE = new RegExp(`<(${WRAP_TAGS})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`, 'gi')

/**
 * What the person typed, out of a user turn: the Cursor `<user_query>` body when there is one, the harness wrapper blocks
 * out, whitespace on one line. The canary's rule (2026-11-01), which found the right session first in 19 of 20 searches.
 */
export function unwrapPrompt(text: string): string {
  let body = text.slice(0, UNWRAP_SCAN_CHARS)
  const open = body.indexOf('<user_query>'), close = body.indexOf('</user_query>')
  if (open >= 0 && close > open) body = body.slice(open + '<user_query>'.length, close)
  return body.replace(WRAP_RE, ' ').replace(/\s+/g, ' ').trim()
}

export interface FindCandidate {
  provider: AgentProvider
  session_id: string
  /** `provider:id` in lower case: one identity across the pool, the cache and the merge. */
  key: string
  /** As the list titles it (Desktop alias, then custom title, then the first line of the first prompt). Never sent as is. */
  title: string
  /** The list's first line of the first prompt, at most 80 characters. */
  listFirstLine: string
  /** The first typed prompt, unwrapped, on one line, at most FIND_PROMPT_KEEP_CHARS. Never sent as is. */
  typed: string
  project: string
  /** The newest record's time (or the file's write time where records carry none), never later than the write time. */
  clockMs: number
  mtimeMs: number
  birthtimeMs: number
  created: string
  /** A `.jsonl.zst` Codex rollout: no tail can be read, so it cannot be opened from COS, only from the Codex app. */
  compressed: boolean
  /** Where the transcript is. Server side only; no row carries it. */
  file: string
}

export interface FindPool {
  candidates: FindCandidate[]
  /** Compressed files left out because this Node cannot decompress zstd. */
  skippedNoDecoder: number
  /** Compressed files left out because they could not be read (a damaged or half-written file). */
  skippedUnreadable: number
  /** Files whose heads were read this walk (memo hits are free and not counted). */
  opened: number
  considered: number
  ms: number
}

type ZstdFactory = () => Transform | null

/** Resolved at the call, so a Node without it (and a test that removes it) both read as "absent". */
export function zstdDecompressor(): Transform | null {
  const make = (zlib as { createZstdDecompress?: () => Transform }).createZstdDecompress
  return typeof make === 'function' ? make.call(zlib) : null
}

/** `rollout-<stamp>-<uuid>.jsonl` or `.jsonl.zst`: the uuid, or null. Not `idFromCodexFilename`, which stays `.jsonl` only. */
export function rolloutFileId(name: string): string | null {
  const base = rolloutBaseName(name)
  if (!base) return null
  const parts = base.split('-')
  if (parts.length < 5) return null
  const uuid = parts.slice(-5).join('-').toLowerCase()
  return uuid.length >= 36 ? uuid : null
}
function rolloutBaseName(name: string): string | null {
  if (name.endsWith('.jsonl.zst')) return name.slice(0, -'.jsonl.zst'.length)
  if (name.endsWith('.jsonl')) return name.slice(0, -'.jsonl'.length)
  return null
}

/** Every Codex rollout under one sessions root, plain and compressed, in directory order. Head-only: nothing is opened. */
export async function listCodexRolloutFiles(sessionsRoot: string): Promise<Array<{ file: string; compressed: boolean }>> {
  const files: Array<{ file: string; compressed: boolean }> = []
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
          if (name.endsWith('.jsonl.zst')) files.push({ file: join(dayDir, name), compressed: true })
          else if (name.endsWith('.jsonl')) files.push({ file: join(dayDir, name), compressed: false })
        }
      }
    }
  }
  return files
}

class NoDecoderError extends Error {}

/**
 * The first `maxBytes` of a file's (decompressed) content, one line at a time, until `onLine` says stop. A line cut by the
 * limit is handed over as it stands and will usually not parse, which is the reader's cue to skip it.
 */
async function readHeadLines(file: string, compressed: boolean, maxBytes: number, zstd: ZstdFactory, onLine: (line: string) => boolean): Promise<void> {
  const decoder = new StringDecoder('utf8')
  let carry = ''
  let total = 0
  let stopped = false
  const feed = (chunk: Buffer): boolean => {
    total += chunk.length
    carry += decoder.write(chunk)
    let at = carry.indexOf('\n')
    while (at >= 0) {
      const line = carry.slice(0, at)
      carry = carry.slice(at + 1)
      if (line && onLine(line)) return true
      at = carry.indexOf('\n')
    }
    return false
  }
  if (!compressed) {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(FIND_CHUNK_BYTES)
      while (total < maxBytes && !stopped) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(FIND_CHUNK_BYTES, maxBytes - total), total)
        if (bytesRead <= 0) break
        stopped = feed(Buffer.from(buffer.subarray(0, bytesRead)))
      }
    } finally { await handle.close() }
  } else {
    const inflate = zstd()
    if (!inflate) throw new NoDecoderError('zstd unavailable')
    const raw = createReadStream(file, { highWaterMark: FIND_CHUNK_BYTES })
    raw.on('error', error => inflate.destroy(error))
    raw.pipe(inflate)
    try {
      for await (const chunk of inflate) {
        stopped = feed(chunk as Buffer)
        if (stopped || total >= maxBytes) break
      }
    } finally { raw.destroy(); inflate.destroy() }
  }
  if (!stopped && carry.trim()) onLine(carry + decoder.end())
}

interface HeadInfo {
  /** A typed first prompt was found (or this is a subagent, which is left out whatever it says). */
  typed: string
  listFirstLine: string
  subagent: boolean
  metaId: string
  cwd: string
  created: string
}

const emptyHead = (): HeadInfo => ({ typed: '', listFirstLine: '', subagent: false, metaId: '', cwd: '', created: '' })

function parseClaudeHead(): { head: HeadInfo; onLine: (line: string) => boolean } {
  const head = emptyHead()
  return { head, onLine: line => {
    if (!line.includes('"user"')) return false
    const obj = parseJsonLine(line)
    if (!obj || obj.type !== 'user' || obj.toolUseResult || obj.isSidechain === true) return false
    const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null
    const body = message ? payloadText(message) : null
    if (!body) return false
    if (!head.listFirstLine) head.listFirstLine = firstLineTitle(body)
    if (isWrapperPrompt(body)) return false
    const typed = unwrapPrompt(body)
    if (typed.length < 3) return false
    head.typed = typed.slice(0, FIND_PROMPT_KEEP_CHARS)
    return true
  } }
}

function parseCodexHead(): { head: HeadInfo; onLine: (line: string) => boolean } {
  const head = emptyHead()
  return { head, onLine: line => {
    if (!line.includes('"session_meta"') && !line.includes('"response_item"')) return false
    const obj = parseJsonLine(line)
    if (!obj || !obj.payload || typeof obj.payload !== 'object') return false
    const payload = obj.payload as Record<string, unknown>
    if (obj.type === 'session_meta') {
      head.metaId = String(payload.id ?? payload.session_id ?? head.metaId)
      head.cwd = String(payload.cwd ?? head.cwd)
      head.subagent = payload.thread_source === 'subagent'
      head.created = String(payload.timestamp ?? obj.timestamp ?? head.created).trim()
      return head.subagent
    }
    if (obj.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user') return false
    const body = codexUserText(payload)
    if (!body) return false
    if (isWrapperPrompt(body)) return false
    if (!head.listFirstLine) head.listFirstLine = firstLineTitle(body)
    const typed = unwrapPrompt(body)
    if (typed.length < 3) return false
    head.typed = typed.slice(0, FIND_PROMPT_KEEP_CHARS)
    return true
  } }
}

function parseCursorHead(): { head: HeadInfo; onLine: (line: string) => boolean } {
  const head = emptyHead()
  return { head, onLine: line => {
    if (!line.includes('"user"')) return false
    const obj = parseJsonLine(line)
    if (!obj || obj.role !== 'user') return false
    const message = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null
    const body = message ? payloadText(message) : null
    if (!body) return false
    if (isWrapperPrompt(body) && !body.includes('<user_query>')) return false
    const typed = unwrapPrompt(body)
    if (typed.length < 3) return false
    head.listFirstLine = firstLineTitle(body)
    head.typed = typed.slice(0, FIND_PROMPT_KEEP_CHARS)
    return true
  } }
}

interface FileRef {
  provider: AgentProvider
  file: string
  /** Claude: the uuid. Codex: the file's uuid. Cursor: the session directory. */
  id: string
  /** Claude: the project folder. Cursor: the project folder. Codex: unused. */
  folder: string
  mtimeMs: number
  birthtimeMs: number
  size: number
  compressed: boolean
}

interface FileInfo {
  mtimeMs: number
  size: number
  head: HeadInfo
  /** Claude only, read the first time it is needed (a Desktop alias title wins over it). `null` is "none found". */
  customTitle?: string | null
  clockMs?: number
}

interface DesktopFlags { mtimeMs: number; size: number; scheduled: boolean; archived: boolean }

/** Both flags are keys of the Desktop record: archived near its top, scheduledTaskId anywhere in its first megabytes. */
async function readDesktopFlags(file: string, size: number): Promise<{ scheduled: boolean; archived: boolean } | null> {
  if (size > DESKTOP_RECORD_MAX_BYTES) return null
  try {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(size)
      const { bytesRead } = await handle.read(buffer, 0, size, 0)
      const text = buffer.subarray(0, bytesRead).toString('utf8')
      return {
        scheduled: /"scheduledTaskId"\s*:\s*"[^"]+"/.test(text),
        archived: /"isArchived"\s*:\s*true/.test(text.slice(0, 64 * 1024)),
      }
    } finally { await handle.close() }
  } catch { return null }
}

export interface FindPoolOptions {
  roots?: AgentSessionRoots
  /** How many sessions the pool should hold at most: 254 for the first request of a search, 508 for both. */
  limit: number
  signal?: AbortSignal
  /** Lower-case ids (Claude session ids, Codex thread ids) that ran on a key. They never leave the Mac. */
  keyedIds?: ReadonlySet<string>
  /** Test seam: where the zstd decoder comes from. Defaults to node:zlib at the call. */
  zstd?: ZstdFactory
  maxOpen?: number
  /** Test seam: how far into a file to look for the first typed prompt. Defaults to FIND_HEAD_BYTES. */
  headBytes?: number
}

const normTitle = (title: string) => title.toLowerCase().replace(/\s+/g, ' ').trim()

export class SessionFindCollector {
  private memo = new Map<string, FileInfo>()
  private flags = new Map<string, DesktopFlags>()
  private cursorNames: { stamp: string; names: Map<string, string> } | null = null
  private flights = new Map<string, { promise: Promise<FindPool>; waiters: number; controller: AbortController }>()

  /** Memo entries held. A test seam: the memo must never outgrow the files it mirrors. */
  memoSize(): number { return this.memo.size }

  /**
   * The pool. Concurrent calls for the same roots and limit share one walk; the walk stops when its LAST caller has gone
   * (a request that closed), and what it had read stays in the memo, so the next try starts further along.
   */
  collect(options: FindPoolOptions): Promise<FindPool> {
    const roots = options.roots ?? agentSessionRoots()
    const key = `${options.limit}\0${JSON.stringify(roots)}\0${options.keyedIds ? [...options.keyedIds].sort().join(',') : ''}`
    let flight = this.flights.get(key)
    // A flight whose last caller left is stopping; a new caller starts a fresh walk (the memo keeps what the old one read).
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController()
      const created = { promise: undefined as unknown as Promise<FindPool>, waiters: 0, controller }
      created.promise = this.walk({ ...options, roots }, controller.signal).finally(() => { if (this.flights.get(key) === created) this.flights.delete(key) })
      // A walk nobody waits for any more rejects; that is not an unhandled error.
      created.promise.catch(() => undefined)
      this.flights.set(key, created)
      flight = created
    }
    const shared = flight
    shared.waiters += 1
    return new Promise<FindPool>((resolve, reject) => {
      let left = false
      const leave = () => {
        if (left) return
        left = true
        options.signal?.removeEventListener('abort', onAbort)
        shared.waiters -= 1
        if (shared.waiters <= 0) shared.controller.abort()
      }
      const onAbort = () => { leave(); reject(abortError()) }
      if (options.signal?.aborted) { onAbort(); return }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      shared.promise.then(pool => { leave(); resolve(pool) }, error => { leave(); reject(error) })
    })
  }

  private async walk(options: FindPoolOptions & { roots: AgentSessionRoots }, signal: AbortSignal): Promise<FindPool> {
    const started = performance.now()
    const { roots } = options
    const zstd = options.zstd ?? zstdDecompressor
    const keyed = options.keyedIds ?? new Set<string>()
    const maxOpen = options.maxOpen ?? FIND_MAX_OPEN
    const throwIfStopped = () => { if (signal.aborted) throw abortError() }

    const aliases = await loadClaudeDesktopAliases(roots.claudeCodeSessions)
    throwIfStopped()
    const desktopByCli = new Map<string, { title: string; file: string; mtimeMs: number }>()
    for (const [id, head] of aliases) {
      if (!head) continue
      const cli = head.cliSessionId && CLAUDE_UUID_JSONL.test(head.cliSessionId + '.jsonl') ? head.cliSessionId : id
      const previous = desktopByCli.get(cli)
      if (!previous || head.mtimeMs >= previous.mtimeMs) desktopByCli.set(cli, { title: head.title, file: head.file, mtimeMs: head.mtimeMs })
    }
    const codexNames = await loadCodexThreadNames(roots.codexSessions)
    const cursorNames = await this.composerNames(roots.cursorComposerDb)
    throwIfStopped()

    const refs = await this.enumerate(roots)
    throwIfStopped()
    this.prune(refs)
    refs.sort((a, b) => b.mtimeMs - a.mtimeMs)

    const assembled = new Map<string, FindCandidate>()
    let skippedNoDecoder = 0, skippedUnreadable = 0, opened = 0
    const noDecoderFiles = new Set<string>(), unreadableFiles = new Set<string>()
    let pool: FindCandidate[] = []
    let next = 0
    while (next < refs.length) {
      throwIfStopped()
      // Everything not yet opened was written no later than refs[next], and a transcript's last record is never later than its
      // file's write time. So once the pool is full and its oldest entry is newer than that, no unopened file can displace it.
      if (pool.length >= options.limit && pool[options.limit - 1]!.clockMs >= refs[next]!.mtimeMs) break
      if (opened >= maxOpen) break
      const batch = refs.slice(next, next + BATCH)
      next += batch.length
      const results = await mapWithConcurrency(batch, ACTIVITY_READ_CONCURRENCY, async ref => {
        if (signal.aborted) return null
        return this.inspect(ref, { desktopByCli, codexNames, cursorNames, keyed, zstd, headBytes: options.headBytes ?? FIND_HEAD_BYTES })
      })
      for (let i = 0; i < batch.length; i++) {
        const outcome = results[i]
        const ref = batch[i]!
        if (!outcome) continue
        if (outcome.read) opened += 1
        if (outcome.skip === 'nodecoder') noDecoderFiles.add(ref.file)
        if (outcome.skip === 'unreadable') unreadableFiles.add(ref.file)
        if (outcome.candidate) assembled.set(ref.file, outcome.candidate)
      }
      pool = this.settle([...assembled.values()])
    }
    throwIfStopped()
    skippedNoDecoder = noDecoderFiles.size
    skippedUnreadable = unreadableFiles.size
    return { candidates: pool.slice(0, options.limit), skippedNoDecoder, skippedUnreadable, opened, considered: refs.length, ms: Math.round(performance.now() - started) }
  }

  /** The pool-wide rules (a title seen 5 or more times is a machine), one identity per session, newest record first. */
  private settle(all: FindCandidate[]): FindCandidate[] {
    const seen = new Map<string, number>()
    for (const candidate of all) {
      const t = normTitle(candidate.title)
      seen.set(t, (seen.get(t) ?? 0) + 1)
    }
    const byKey = new Map<string, FindCandidate>()
    for (const candidate of all) {
      if ((seen.get(normTitle(candidate.title)) ?? 0) >= FIND_REPEAT_TITLE_LIMIT) continue
      const existing = byKey.get(candidate.key)
      if (!existing || candidate.clockMs > existing.clockMs) byKey.set(candidate.key, candidate)
    }
    return [...byKey.values()].sort((a, b) => b.clockMs - a.clockMs || a.key.localeCompare(b.key))
  }

  private async composerNames(db: string): Promise<Map<string, string>> {
    const st = db ? await fileStat(db) : null
    if (!st?.isFile) return new Map()
    const stamp = `${db}:${st.mtimeMs}:${st.size}`
    if (this.cursorNames?.stamp === stamp) return this.cursorNames.names
    const names = await loadCursorComposerNames(db)
    this.cursorNames = { stamp, names }
    return names
  }

  /** Stat every transcript. Claude and Cursor from their own stores; Codex from the SERVER home only (never a keyed home). */
  private async enumerate(roots: AgentSessionRoots): Promise<FileRef[]> {
    const refs: FileRef[] = []
    for (const folder of await dirents(roots.claudeProjects)) {
      const dir = join(roots.claudeProjects, folder)
      for (const name of await dirents(dir)) {
        if (!CLAUDE_UUID_JSONL.test(name)) continue
        const file = join(dir, name)
        const st = await fileStat(file)
        if (!st?.isFile) continue
        refs.push({ provider: 'claude', file, id: name.slice(0, -'.jsonl'.length), folder, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, size: st.size, compressed: false })
      }
    }
    for (const { file, compressed } of await listCodexRolloutFiles(roots.codexSessions)) {
      const st = await fileStat(file)
      if (!st?.isFile) continue
      refs.push({ provider: 'codex', file, id: file.split('/').pop() || file, folder: '', mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, size: st.size, compressed })
    }
    const cursor = new Map<string, FileRef>()
    for (const folder of await dirents(roots.cursorProjects)) {
      if (isSkippedCursorFolder(folder)) continue
      const transcripts = join(roots.cursorProjects, folder, 'agent-transcripts')
      for (const sessionDir of await dirents(transcripts)) {
        if (sessionDir === 'subagents') continue
        const file = join(transcripts, sessionDir, `${sessionDir}.jsonl`)
        const st = await fileStat(file)
        if (!st?.isFile || st.size > AGENT_SESSION_MAX_FILE_BYTES) continue
        const next: FileRef = { provider: 'cursor', file, id: sessionDir, folder, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, size: st.size, compressed: false }
        const existing = cursor.get(sessionDir)
        if (!existing) { cursor.set(sessionDir, next); continue }
        const pick = preferCursorCopy(
          { file: next.file, sessionDir, project: workspaceLabel(next.folder), mtimeMs: next.mtimeMs, birthtimeMs: next.birthtimeMs },
          { file: existing.file, sessionDir, project: workspaceLabel(existing.folder), mtimeMs: existing.mtimeMs, birthtimeMs: existing.birthtimeMs })
        cursor.set(sessionDir, pick.file === next.file ? next : existing)
      }
    }
    refs.push(...cursor.values())
    return refs
  }

  /** Forget memo entries for files that are gone, and keep the memo inside its bound. */
  private prune(refs: readonly FileRef[]): void {
    const live = new Set(refs.map(ref => ref.file))
    for (const file of this.memo.keys()) if (!live.has(file)) this.memo.delete(file)
    while (this.memo.size > FIND_MEMO_MAX) {
      const oldest = this.memo.keys().next().value
      if (oldest === undefined) break
      this.memo.delete(oldest)
    }
  }

  private async inspect(ref: FileRef, ctx: {
    desktopByCli: Map<string, { title: string; file: string; mtimeMs: number }>
    codexNames: Map<string, string>
    cursorNames: Map<string, string>
    keyed: ReadonlySet<string>
    zstd: ZstdFactory
    headBytes: number
  }): Promise<{ candidate: FindCandidate | null; read: boolean; skip?: 'nodecoder' | 'unreadable' } | null> {
    let info = this.memo.get(ref.file)
    let read = false
    if (!info || info.mtimeMs !== ref.mtimeMs || info.size !== ref.size) {
      const parser = ref.provider === 'claude' ? parseClaudeHead() : ref.provider === 'codex' ? parseCodexHead() : parseCursorHead()
      try {
        await readHeadLines(ref.file, ref.compressed, ctx.headBytes, ctx.zstd, parser.onLine)
      } catch (error) {
        return { candidate: null, read: false, skip: error instanceof NoDecoderError ? 'nodecoder' : 'unreadable' }
      }
      read = true
      info = { mtimeMs: ref.mtimeMs, size: ref.size, head: parser.head }
      this.memo.delete(ref.file)
      this.memo.set(ref.file, info)
    } else {
      this.memo.delete(ref.file)
      this.memo.set(ref.file, info)
    }
    const { head } = info
    if (head.subagent || !head.typed) return { candidate: null, read }

    let sessionId: string
    let title: string
    let project: string
    let created = isoFromMtime(ref.birthtimeMs)
    if (ref.provider === 'claude') {
      sessionId = ref.id
      if (ctx.keyed.has(sessionId.toLowerCase())) return { candidate: null, read }
      const desktop = ctx.desktopByCli.get(sessionId)
      if (desktop) {
        // The Desktop record says whether it was a scheduled run or put away. Unreadable counts as yes: it fails toward not sending.
        const flags = await this.desktopFlags(desktop.file)
        if (!flags || flags.scheduled || flags.archived) return { candidate: null, read }
      }
      if (!desktop?.title && info.customTitle === undefined) info.customTitle = await lastCustomTitle(ref.file)
      title = desktop?.title || info.customTitle || head.listFirstLine || 'Claude session'
      project = workspaceLabel(ref.folder)
    } else if (ref.provider === 'codex') {
      const name = ref.file.split('/').pop() || ref.file
      const fileId = rolloutFileId(name)
      const metaId = head.metaId.trim().toLowerCase()
      // The filename wins when it disagrees: a cloned thread carries its parent's id in session_meta (listCodexSessions).
      sessionId = fileId && metaId && fileId !== metaId ? fileId : (head.metaId || rolloutBaseName(name) || name)
      if (ctx.keyed.has(sessionId.toLowerCase())) return { candidate: null, read }
      title = ctx.codexNames.get(sessionId) || head.listFirstLine || 'Codex session'
      project = workspaceLabel(head.cwd)
      created = head.created || createdFromCodexFilename(name) || created
    } else {
      sessionId = ref.id
      if (ctx.keyed.has(sessionId.toLowerCase())) return { candidate: null, read }
      title = ctx.cursorNames.get(sessionId) || head.listFirstLine || 'Cursor session'
      project = workspaceLabel(ref.folder)
    }
    if (isKeepWarmSessionTitle(title) || isKeepWarmSessionTitle(head.listFirstLine) || isKeepWarmSessionTitle(head.typed)) return { candidate: null, read }

    if (info.clockMs === undefined) {
      let clock = ref.mtimeMs
      // A compressed rollout cannot be tailed; its write time was preserved from the last write (median 0.21 days after the start, which is the stamp's own offset).
      if (ref.provider !== 'cursor' && !ref.compressed) {
        const activity = await readSessionActivity(ref.provider, ref.file, { memoMax: FIND_MEMO_MAX })
        const at = activity.lastActivityAt ? Date.parse(activity.lastActivityAt) : Number.NaN
        if (Number.isFinite(at)) clock = Math.min(at, ref.mtimeMs)
      }
      info.clockMs = clock
    }
    return { read, candidate: {
      provider: ref.provider, session_id: sessionId, key: `${ref.provider}:${sessionId.toLowerCase()}`, title: title.slice(0, 120),
      listFirstLine: head.listFirstLine, typed: head.typed, project, clockMs: info.clockMs, mtimeMs: ref.mtimeMs, birthtimeMs: ref.birthtimeMs,
      created, compressed: ref.compressed, file: ref.file,
    } }
  }

  private async desktopFlags(file: string): Promise<{ scheduled: boolean; archived: boolean } | null> {
    const st = await fileStat(file)
    if (!st?.isFile) return null
    const known = this.flags.get(file)
    if (known && known.mtimeMs === st.mtimeMs && known.size === st.size) return known
    const read = await readDesktopFlags(file, st.size)
    if (!read) { this.flags.delete(file); return null }
    const flags: DesktopFlags = { mtimeMs: st.mtimeMs, size: st.size, ...read }
    this.flags.set(file, flags)
    return flags
  }
}

function abortError(): Error {
  const error = new Error('cancelled')
  error.name = 'AbortError'
  return error
}

export function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError' }

let shared: SessionFindCollector | null = null
/** One collector per process: it owns the memo that makes the second search cheap. */
export function sharedSessionFindCollector(): SessionFindCollector { return shared ??= new SessionFindCollector() }
