/**
 * Drop it destinations (plan section 3): the writes a filed drop makes, through the existing COS bridge.
 *
 * | Destination   | Write                                              | Undo                                         |
 * | New card      | `task-capture-drop` (answers the id)               | `task-archive-drop` while untouched          |
 * | Existing card | a link on the drop only (no tasks.md write)        | the link is removed                          |
 * | Thread        | `thread-source --id <thread>`                      | `thread-unsource --id --source-id`           |
 * | Memory        | `memory-capture` into To review                    | `memory-review --decision=prune` (reversible)|
 * | Session, note, reminder: the drop store only.                                                               |
 *
 * A bridge that does not know a verb answers `cos_pipeline_not_configured` (or the portable runtime's
 * `task_runtime_unavailable`), which becomes DropDestinationError('destination_unavailable'): the caller keeps a plain
 * note and says why. Every destination is local; nothing here sends anything anywhere.
 */
import { callPython, contextSourceAvailable } from './python-bridge.js'
import { archiveDropCard, captureDropCard, listBoard, taskDomains, TaskBridgeError, TaskRunError } from './task-store.js'
import { domainLabel } from './domain-label.js'
import { normalizeThreads, THREAD_ID_PATTERN } from './cos-context-browser.js'
import { DROP_ROUTER_LIMITS, rankByOverlap, type RouteCandidates } from './drop-router.js'

export class DropDestinationError extends Error {
  constructor(readonly code: 'destination_unavailable' | 'destination_failed' | 'memory_too_short') { super(code) }
}

export interface DropWriters {
  captureCard(domain: string, text: string, dropId: string): Promise<{ id: string; workIdentity: string; created: boolean }>
  archiveCard(domain: string, id: string, dropId: string, text: string): Promise<'archived' | 'touched' | 'gone'>
  /** `attempt` is the filing's number: each filing is a new capture, so a replay never answers a set-aside row. */
  captureMemory(text: string, dropId: string, attempt: string): Promise<{ id: string; created: boolean }>
  /** pruned | touched (reviewed since, or not this drop's) | gone. */
  pruneMemory(id: string, dropId: string): Promise<'pruned' | 'touched' | 'gone'>
  sourceThread(threadId: string, text: string, dropId: string): Promise<{ sourceId: string; created: boolean }>
  unsourceThread(threadId: string, sourceId: string, dropId: string): Promise<'removed' | 'touched' | 'gone'>
  /** What the router may choose from. Any part that cannot be read is simply left out. */
  candidates(text: string, session?: { id: string; label: string }): Promise<RouteCandidates>
  /** Card stages for History status, keyed by Work identity. */
  cardStates(): Promise<Map<string, { workStage: string; checked: boolean }>>
}

const MISSING = new Set(['cos_pipeline_not_configured', 'task_runtime_unavailable', 'unknown_command'])
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/

/** A bridge answer as an error code, or null. The COS bridge answers both `{error:{code}}` and `{error:"…"}`. */
export function bridgeErrorCode(answer: unknown): string | null {
  if (!answer || typeof answer !== 'object') return 'empty_answer'
  const error = (answer as { error?: unknown }).error
  if (error === undefined) return null
  if (typeof error === 'string') return /unknown command/i.test(error) ? 'unknown_command' : 'bridge_error'
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' ? code : 'bridge_error'
}
function fail(code: string | null): never {
  if (code === 'memory_rejected') throw new DropDestinationError('memory_too_short')
  throw new DropDestinationError(code && MISSING.has(code) ? 'destination_unavailable' : 'destination_failed')
}
async function python(args: string[], input?: string): Promise<Record<string, unknown>> {
  // The file tier (no venv) answers `{}` for every verb it does not know: that is a missing verb, not a failure.
  if (contextSourceAvailable() !== 'bridge') fail('cos_pipeline_not_configured')
  let answer: unknown
  try { answer = await callPython(args, 20_000, input) } catch { fail('bridge_error') }
  const code = bridgeErrorCode(answer)
  if (code) fail(code)
  return answer as Record<string, unknown>
}
const taskCode = (e: unknown): string | null => e instanceof TaskBridgeError || e instanceof TaskRunError ? e.code : null

export function createBridgeDropWriters(): DropWriters {
  return {
    async captureCard(domain, text, dropId) {
      try { return await captureDropCard(domain, text, dropId) } catch (e) { fail(taskCode(e)) }
    },
    async archiveCard(domain, id, dropId, text) {
      try { return await archiveDropCard(domain, id, dropId, text) } catch (e) { fail(taskCode(e)) }
    },
    async captureMemory(text, dropId, attempt) {
      const out = await python(['memory-capture'], JSON.stringify({ text, dropId, attempt }))
      if (out.ok !== true || typeof out.id !== 'string' || !ID.test(out.id)) fail('bridge_error')
      return { id: out.id as string, created: out.created !== false }
    },
    async pruneMemory(id, dropId) {
      const out = await python(['memory-uncapture', '--id', id], JSON.stringify({ dropId }))
      if (out.ok === true && (out.result === 'pruned' || out.result === 'touched' || out.result === 'gone')) return out.result
      fail('bridge_error')
    },
    async sourceThread(threadId, text, dropId) {
      if (!THREAD_ID_PATTERN.test(threadId)) fail('invalid_thread')
      const out = await python(['thread-source', '--id', threadId], JSON.stringify({ text, dropId }))
      if (out.ok !== true || typeof out.sourceId !== 'string' || !ID.test(out.sourceId)) fail('bridge_error')
      return { sourceId: out.sourceId as string, created: out.created !== false }
    },
    async unsourceThread(threadId, sourceId, dropId) {
      const out = await python(['thread-unsource', '--id', threadId, '--source-id', sourceId], JSON.stringify({ dropId }))
      if (out.ok === true && (out.result === 'removed' || out.result === 'touched' || out.result === 'gone')) return out.result
      fail('bridge_error')
    },
    async candidates(text, session) {
      const out: RouteCandidates = { domains: [], cards: [], threads: [], ...(session ? { session } : {}) }
      try { out.domains = taskDomains().map(name => ({ name, label: domainLabel(name) })) } catch { /* no domains: no new card */ }
      try {
        const open = (await listBoard()).filter(row => !row.checked)
        out.cards = rankByOverlap(text, open, row => row.text, DROP_ROUTER_LIMITS.cardCandidates)
          .map(row => ({ id: row.id, workIdentity: row.workIdentity ?? row.id, domain: row.domain, text: row.text }))
      } catch { /* board unreadable: no existing card offered */ }
      try {
        if (contextSourceAvailable()) {
          const threads = normalizeThreads(await callPython(['threads', '--limit', '50'], 10_000), 50).threads.filter(t => !t.is_resolved)
          out.threads = rankByOverlap(text, threads, t => `${t.name} ${t.topics.join(' ')}`, DROP_ROUTER_LIMITS.threadCandidates)
            .map(t => ({ id: t.id, name: t.name }))
        }
      } catch { /* threads unreadable: none offered */ }
      return out
    },
    async cardStates() {
      const map = new Map<string, { workStage: string; checked: boolean }>()
      for (const row of await listBoard()) map.set(row.workIdentity ?? row.id, { workStage: row.workStage ?? 'planned', checked: row.checked })
      return map
    },
  }
}
