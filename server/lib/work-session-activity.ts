/**
 * 7.0.1 (Needs you stale): when each Work session last did something, for the open list's supersede rule
 * (work-activity.ts projectOpenWork, `sessionActivityMs`).
 *
 * Miles, 11/07: Today showed "Waiting for your reply" on a Work card from Oct 31 while he talked to its session all
 * day. Control's tracker had taken a needs-input report from the session's status line for that task, and no later
 * turn mentioned the task again, so the report stood. The session's own transcript says it moved on: this reads the
 * newest conversation record of each linked session (agent-session-activity.ts, the clock the Sessions list uses).
 *
 * Read-only and bounded: at most `sessions` sessions per call, each `provider:native` exactly as a Work session id is
 * written (a full thread UUID, never a short id or a path), and the whole read stops at `timeoutMs`, answering what it
 * has. A session it cannot find or read is left out, which keeps its report standing: the old behaviour, never a
 * guessed clear. Cursor transcripts carry no per-record clock, so a Cursor session answers its file's write time.
 */
import { agentSessionRoots, fileStat, findAgentSessionFile, type AgentSessionRoots } from './agent-session-store.js'
import { readSessionActivity } from './agent-session-activity.js'
import { parseWorkSessionId } from './work-activity.js'

export const WORK_SESSION_ACTIVITY_LIMITS = { sessions: 12, timeoutMs: 2_000 } as const

export interface WorkSessionActivityOptions {
  /** Fixture roots. Without them, an isolated runtime (tests) reads nothing rather than this Mac's transcripts. */
  roots?: AgentSessionRoots
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/** Newest activity, ms since 1970, of each session it could read, keyed by the id exactly as given. */
export async function workSessionActivity(sessionIds: readonly string[], options: WorkSessionActivityOptions = {}): Promise<Map<string, number>> {
  const found = new Map<string, number>()
  const env = options.env ?? process.env
  if (!options.roots && (env.NODE_ENV === 'test' || env.VITEST)) return found
  const roots = options.roots ?? agentSessionRoots()
  const ids = [...new Set(sessionIds)].filter(id => parseWorkSessionId(id) !== null).slice(0, WORK_SESSION_ACTIVITY_LIMITS.sessions)
  if (!ids.length) return found
  const work = (async () => {
    for (const id of ids) {
      const { provider, native } = parseWorkSessionId(id)!
      try {
        const file = await findAgentSessionFile(provider as 'claude' | 'codex' | 'cursor', native, roots)
        if (!file) continue
        const at = provider === 'cursor' ? (await fileStat(file))?.mtimeMs : Date.parse((await readSessionActivity(provider as 'claude' | 'codex', file)).lastActivityAt ?? '')
        if (typeof at === 'number' && Number.isFinite(at)) found.set(id, at)
      } catch { /* left out: its report stands */ }
    }
  })()
  let timer: NodeJS.Timeout | undefined
  await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, options.timeoutMs ?? WORK_SESSION_ACTIVITY_LIMITS.timeoutMs) })])
  clearTimeout(timer)
  // A copy: the read may still be adding to `found` after a timeout.
  return new Map(found)
}

/** The sessions whose report the open list would show as waiting: the ones worth reading. */
export function waitingSessionIds(items: ReadonlyArray<{ group: string; sessionId?: string }>): string[] {
  return items.filter(item => item.group === 'needsInput' && item.sessionId).map(item => item.sessionId!)
}
