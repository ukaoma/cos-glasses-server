/**
 * 7.0.1 (Needs you stale): when Miles last started a turn in each Work session, for the open list's supersede rule
 * (work-activity.ts projectOpenWork, `sessionActivityMs`).
 *
 * Miles, 11/07: Today showed "Waiting for your reply" on a Work card from Oct 31 while he talked to its session all
 * day. Control's tracker had taken a needs-input report from the session's status line for that task, and no later
 * turn mentioned the task again, so the report stood. The session's own transcript says he moved on.
 *
 * ONLY A TURN HE STARTED COUNTS (review W3). The session's own work is not an answer: a background agent finishing,
 * a tool result, a Monitor or /loop wakeup, a message from another session, a system reminder or a compaction summary
 * all write records into the transcript with nobody typing. Counting those cleared a report Miles still owed.
 * - Claude: a `user` record that is a real prompt: not `isMeta`, not a compaction summary, not a tool result, not a
 *   task notification, and from a human origin when the record says where it came from (`origin.kind` and
 *   `turnOrigin` are `human` on a typed prompt; `peer`, `task-notification`, `system` and `sdk` are not). Its text,
 *   with system reminders taken out, has to say something. Checked against the record shapes of a real transcript.
 * - Codex: a `response_item` message with role `user` whose text is not an injected block (`<environment_context>`,
 *   `# AGENTS.md instructions`, the files-mentioned list and the like).
 * - Cursor: transcripts carry no per-record clock or origin, so a Cursor session answers its file's write time. Any
 *   write moves it, so a Cursor report can clear on the agent's own work. A listed limit.
 *
 * BOUNDED (review W4): at most `sessions` sessions per call, the stalest waiting reports first (waitingSessionIds);
 * the Claude transcript index is built once per call; each session's answer is cached for `cacheMs`; concurrent
 * callers share one read per session; and `timeoutMs` is a deadline the walk itself checks between folders, sessions
 * and read windows, so a slow disk stops the work, not only the wait. A session it cannot find or read in time is left
 * out, which keeps its report standing: the old behaviour, never a guessed clear.
 */
import { open, stat } from 'node:fs/promises'
import {
  agentSessionRoots, codexSessionRootsOf, fileStat, findAgentSessionFile, listCodexJsonlFiles, loadClaudeDesktopAliases, loadClaudeTranscriptIndex,
  type AgentSessionRoots,
} from './agent-session-store.js'
import { parseWorkSessionId } from './work-activity.js'

export const WORK_SESSION_ACTIVITY_LIMITS = {
  sessions: 12,
  timeoutMs: 2_000,
  /** One session's answer is reused this long: a list poll and the badge recount never walk the disk again inside it. */
  cacheMs: 30_000,
  /** First window read from the end of a transcript, widened x4 while no human turn is found. */
  tailBytes: 256 * 1024,
  /** Largest window: a session working for hours since his last prompt writes a lot of tool output. */
  tailMaxBytes: 64 * 1024 * 1024,
} as const

export interface WorkSessionActivityOptions {
  /** Fixture roots. Without them, an isolated runtime (tests) reads nothing rather than this Mac's transcripts. */
  roots?: AgentSessionRoots
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Test seam for the cache and deadline clock. */
  now?: () => number
}

type Rec = Record<string, unknown>
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
/** Text a Claude user record carries that nobody typed. */
const CLAUDE_INJECTED = /^(<task-notification>|<local-command-stdout>|<local-command-stderr>|<local-command-caveat>|Caveat: The messages below were generated)/
/** Codex user-role blocks the app injects around a prompt. */
const CODEX_INJECTED = /^(<environment_context>|<user_instructions>|<external_[a-z_]+>|# AGENTS\.md instructions|# Files mentioned by the user)/

function originKind(obj: Rec): string | null {
  const origin = obj.origin
  if (origin && typeof origin === 'object' && typeof (origin as Rec).kind === 'string') return (origin as Rec).kind as string
  return null
}

/** A Claude transcript record that is a turn Miles started. Exported for tests. */
export function claudeHumanTurn(obj: Rec): boolean {
  if (obj.type !== 'user' || obj.isMeta === true || obj.isCompactSummary === true || obj.isVisibleInTranscriptOnly === true || obj.toolUseResult) return false
  const kind = originKind(obj)
  if (kind !== null && kind !== 'human') return false
  if (kind === null && typeof obj.turnOrigin === 'string' && obj.turnOrigin !== 'human') return false
  const content = (obj.message as Rec | undefined)?.content
  const blocks: Rec[] = typeof content === 'string' ? [{ type: 'text', text: content }]
    : Array.isArray(content) ? content.filter((b): b is Rec => !!b && typeof b === 'object') : []
  if (blocks.some(b => b.type === 'tool_result')) return false
  let said = false
  for (const block of blocks) {
    if (block.type === 'image') { said = true; continue }
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const text = block.text.replace(SYSTEM_REMINDER, '').trim()
    if (!text) continue
    if (CLAUDE_INJECTED.test(text)) return false
    said = true
  }
  return said
}

/** A Codex rollout record that is a message Miles sent. Exported for tests. */
export function codexHumanTurn(obj: Rec): boolean {
  if (obj.type !== 'response_item' || !obj.payload || typeof obj.payload !== 'object') return false
  const payload = obj.payload as Rec
  if (payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) return false
  return payload.content.some(b => {
    if (!b || typeof b !== 'object') return false
    const block = b as Rec
    if (block.type === 'input_image') return true
    if (typeof block.text !== 'string') return false
    const text = block.text.trim()
    return !!text && !CODEX_INJECTED.test(text)
  })
}

/** The newest human turn's time in a transcript tail, ms, or null. Exported for tests. */
export function lastHumanTurnFromTail(provider: 'claude' | 'codex', text: string, startsMidFile: boolean): number | null {
  const lines = text.split('\n')
  if (startsMidFile) lines.shift()
  const isHuman = provider === 'claude' ? claudeHumanTurn : codexHumanTurn
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    // Cheap prefilter before a parse: every candidate names a user role.
    if (!line.includes('"user"')) continue
    let obj: unknown
    try { obj = JSON.parse(line) } catch { continue }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !isHuman(obj as Rec)) continue
    const at = Date.parse(String((obj as Rec).timestamp ?? ''))
    if (Number.isFinite(at)) return at
  }
  return null
}

const turnMemo = new Map<string, { mtimeMs: number; size: number; at: number | null }>()
const TURN_MEMO_MAX = 200

/** One transcript's newest human turn, memoized on mtime and size. undefined: the deadline came first. */
async function readLastHumanTurn(provider: 'claude' | 'codex', file: string, pastDeadline: () => boolean): Promise<number | null | undefined> {
  const st = await stat(file)
  const hit = turnMemo.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.at
  let at: number | null = null
  const handle = await open(file, 'r')
  try {
    for (let window: number = WORK_SESSION_ACTIVITY_LIMITS.tailBytes; ; window *= 4) {
      if (pastDeadline()) return undefined
      const length = Math.min(st.size, window), start = st.size - length
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, start)
      at = lastHumanTurnFromTail(provider, buffer.subarray(0, bytesRead).toString('utf8'), start > 0)
      if (at !== null || start === 0 || window >= WORK_SESSION_ACTIVITY_LIMITS.tailMaxBytes) break
    }
  } finally {
    await handle.close()
  }
  turnMemo.delete(file)
  while (turnMemo.size >= TURN_MEMO_MAX) { const oldest = turnMemo.keys().next().value; if (oldest === undefined) break; turnMemo.delete(oldest) }
  turnMemo.set(file, { mtimeMs: st.mtimeMs, size: st.size, at })
  return at
}

/** Per session: the answer and when it was read. `at` null: read, and no human turn (or no transcript, or unreadable). */
const cache = new Map<string, { at: number | null; readAt: number }>()
const inflight = new Map<string, Promise<number | null | undefined>>()
const CACHE_MAX = 500
let walks = 0

function cacheKey(roots: AgentSessionRoots, id: string): string { return `${roots.claudeProjects}\u0000${roots.cursorProjects}\u0000${id}` }

/** Newest human turn, ms since 1970, of each session it could read, keyed by the id exactly as given. */
export async function workSessionActivity(sessionIds: readonly string[], options: WorkSessionActivityOptions = {}): Promise<Map<string, number>> {
  const found = new Map<string, number>()
  const env = options.env ?? process.env
  if (!options.roots && (env.NODE_ENV === 'test' || env.VITEST)) return found
  const roots = options.roots ?? agentSessionRoots()
  const now = options.now ?? (() => Date.now())
  const ids = [...new Set(sessionIds)].filter(id => parseWorkSessionId(id) !== null).slice(0, WORK_SESSION_ACTIVITY_LIMITS.sessions)
  if (!ids.length) return found
  const started = now(), deadline = started + (options.timeoutMs ?? WORK_SESSION_ACTIVITY_LIMITS.timeoutMs)
  const pastDeadline = () => now() >= deadline
  const keep = (id: string, at: number | null | undefined) => { if (typeof at === 'number' && Number.isFinite(at)) found.set(id, at) }

  const missing: string[] = []
  const waits: Array<Promise<void>> = []
  for (const id of ids) {
    const key = cacheKey(roots, id), hit = cache.get(key)
    if (hit && started - hit.readAt < WORK_SESSION_ACTIVITY_LIMITS.cacheMs) { keep(id, hit.at); continue }
    const running = inflight.get(key)
    if (running) waits.push(running.then(at => keep(id, at)))
    else missing.push(id)
  }

  if (missing.length) {
    // One walk for every missing session. Each session's promise is registered first, so a concurrent caller waits on
    // this read instead of starting its own.
    const settle = new Map<string, (at: number | null | undefined) => void>()
    for (const id of missing) {
      const key = cacheKey(roots, id)
      const one = new Promise<number | null | undefined>(resolve => settle.set(id, resolve))
      inflight.set(key, one)
      waits.push(one.then(at => keep(id, at)))
    }
    void (async () => {
      let indexed = false
      let claudeFiles: Map<string, string[]> | undefined
      let codexFiles: string[] | undefined
      let aliases: Awaited<ReturnType<typeof loadClaudeDesktopAliases>> | undefined
      for (const id of missing) {
        const key = cacheKey(roots, id)
        let at: number | null | undefined
        try {
          const { provider, native } = parseWorkSessionId(id)!
          if (!pastDeadline() && !indexed) {
            indexed = true
            walks += 1
            if (missing.some(m => parseWorkSessionId(m)!.provider === 'claude')) {
              aliases = await loadClaudeDesktopAliases(roots.claudeCodeSessions)
              claudeFiles = await loadClaudeTranscriptIndex(roots, pastDeadline)
            }
            if (!pastDeadline() && missing.some(m => parseWorkSessionId(m)!.provider === 'codex')) {
              codexFiles = (await Promise.all(codexSessionRootsOf(roots).map(root => listCodexJsonlFiles(root)))).flat()
            }
          }
          // Past the deadline (a walk it cut short is not a complete index, and resolving against it could pick the
          // wrong file): left out this time and read again on the next call.
          if (pastDeadline()) at = undefined
          else {
            const file = await findAgentSessionFile(provider as 'claude' | 'codex' | 'cursor', native, roots, new Date(), aliases, { claudeFiles, codexFiles })
            if (!file) at = null
            else if (provider === 'cursor') at = (await fileStat(file))?.mtimeMs ?? null
            else at = await readLastHumanTurn(provider as 'claude' | 'codex', file, pastDeadline)
          }
        } catch {
          at = null   // unreadable: its report stands, and the answer is cached like any other
        }
        if (at !== undefined) {
          cache.delete(key)
          while (cache.size >= CACHE_MAX) { const oldest = cache.keys().next().value; if (oldest === undefined) break; cache.delete(oldest) }
          cache.set(key, { at, readAt: now() })
        }
        inflight.delete(key)
        settle.get(id)!(at)
      }
    })()
  }

  let timer: NodeJS.Timeout | undefined
  await Promise.race([Promise.all(waits), new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - now())) })])
  clearTimeout(timer)
  // A copy: a shared read may still land in `found` after the deadline.
  return new Map(found)
}

/**
 * The sessions whose report the open list would show as waiting: the ones worth reading. The stalest report first
 * (review N7): under the 12-session cap the oldest waits are the likeliest to be stale, like the Oct 31 row.
 */
export function waitingSessionIds(items: ReadonlyArray<{ group: string; sessionId?: string; waitingSince?: string; updatedAt?: string }>): string[] {
  const when = (item: { waitingSince?: string; updatedAt?: string }) => {
    const t = Date.parse(item.waitingSince ?? item.updatedAt ?? '')
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY
  }
  const out: string[] = []
  for (const item of items.filter(i => i.group === 'needsInput' && i.sessionId).sort((a, b) => when(a) - when(b))) {
    if (!out.includes(item.sessionId!)) out.push(item.sessionId!)
  }
  return out
}

/** Test seams. */
export function clearWorkSessionActivityCache(): void { cache.clear(); inflight.clear(); turnMemo.clear(); walks = 0 }
export function workSessionActivityWalks(): number { return walks }
