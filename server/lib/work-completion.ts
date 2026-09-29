/**
 * Did an agent session finish a Work task? (6.58.0)
 *
 * Control 0.5.247 follows a Work handoff until the session reports on it. Every handoff asks the agent to start its
 * reply with a status line (`COS-WORK <id>: done: <evidence>`). When the session's newest reply since the handoff
 * carries none and the session has gone idle, Control asks this (at most twice per handoff, once per reply). Jev reads
 * the session's replies since the handoff arrived (`after`) against the task's Done when, or, when the task has none
 * (most do), against the task itself. It answers done, not_done or unclear with a probability. Control moves the card
 * to QA only on done at 0.8 or more (0.85 without a Done when), and never to Complete: that stays the user's.
 *
 * The task comes from the board and the replies from this server's own session transcripts. The client sends names
 * and a time only.
 */
import { createHash } from 'node:crypto'
import { estimateJevTokens, JevError, type JevClient } from './jev.js'
import { agentSessionRoots, findAgentSessionFile, LATEST_REPLY_MAX, parseAgentSession, type AgentProvider } from './agent-session-store.js'
import { readRecentSessionTurns, SESSION_TURNS_MAX, type SessionTurn } from './agent-session-turns.js'

export const COMPLETION_LIMITS = { task: 1200, doneWhen: 500, reply: LATEST_REPLY_MAX, cacheMs: 30 * 60_000, cacheEntries: 200 } as const
export const COMPLETION_CHOICES = ['done', 'not_done', 'unclear'] as const
export type CompletionChoice = typeof COMPLETION_CHOICES[number]

export interface CompletionInput { task: { text: string; doneWhen: string }; reply: string }
/** `basis`: what the reply was read against, the task's Done when or (without one) the task itself. */
export type CompletionVerdict =
  | { provider: 'jev'; model: string; verdict: CompletionChoice; confidence: number; basis: 'done_when' | 'task'; cached: boolean }
  | { provider: 'none'; reason: string }

const AGAINST_DONE_WHEN = "Does the agent's reply in `reply` show that the task in `task` is finished, as `task.doneWhen` defines finished? "
  + 'Choose done only when the reply reports the work complete and checked against that finish line.'
const AGAINST_TASK = "Does the agent's reply in `reply` show that the task in `task.text` is finished? "
  + 'Choose done only when the reply reports that exact work complete and checked, not merely started or planned.'
const REST = ' A plan, a partial result, a question for the user, a blocker, or a promise to do it next is not_done. '
  + 'Choose unclear when the reply does not say enough to tell.'

const clip = (text: string, max: number) => text.trim().slice(0, max)

/** Pure policy over Jev's answer: the most probable choice and its probability (unrounded: a threshold decides on it). */
export function decideCompletion(probabilities: Record<string, number> | undefined): { verdict: CompletionChoice; confidence: number } {
  const rows = Object.entries(probabilities ?? {})
  if (!rows.length || rows.some(([k, v]) => !(COMPLETION_CHOICES as readonly string[]).includes(k) || typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
    throw new JevError('jev_bad_answer', 'Jev answered outside done, not_done and unclear')
  }
  const [verdict, confidence] = rows.sort((a, b) => b[1] - a[1])[0] as [CompletionChoice, number]
  return { verdict, confidence }
}

/** The replies among `turns` written at or after `afterMs`, joined oldest first, keeping the newest `max` characters. */
export function joinRepliesSince(turns: SessionTurn[], afterMs: number, max: number = COMPLETION_LIMITS.reply): string {
  const joined = turns.filter(t => t.role === 'assistant' && t.at !== undefined && Date.parse(t.at) >= afterMs).map(t => t.text).join('\n\n')
  return joined.length <= max ? joined : `\u2026${joined.slice(joined.length - (max - 1))}`
}

export type SessionFileFinder = (provider: AgentProvider, sessionId: string) => Promise<string | null>
const findInHome: SessionFileFinder = (provider, sessionId) => findAgentSessionFile(provider, sessionId, agentSessionRoots())

/** What a completion check judges: the session's replies since `afterMs`, or its newest reply when no time is given.
 *  Null when the session is not on this Mac. */
export async function readRepliesSince(provider: AgentProvider, sessionId: string, afterMs: number | null,
                                       find: SessionFileFinder = findInHome): Promise<string | null> {
  const path = await find(provider, sessionId)
  if (!path) return null
  if (afterMs === null) return (await parseAgentSession(provider, path)).latest_reply || ''
  return joinRepliesSince((await readRecentSessionTurns(provider, path, SESSION_TURNS_MAX)).turns, afterMs)
}

export class CompletionChecker {
  private cache = new Map<string, { at: number; value: Extract<CompletionVerdict, { provider: 'jev' }> }>()
  constructor(private readonly jev: JevClient, private readonly now: () => number = () => Date.now()) {}

  async check(input: CompletionInput): Promise<CompletionVerdict> {
    const state = { task: { text: clip(input.task.text, COMPLETION_LIMITS.task), doneWhen: clip(input.task.doneWhen, COMPLETION_LIMITS.doneWhen) },
      reply: clip(input.reply, COMPLETION_LIMITS.reply) }
    const basis = state.task.doneWhen ? 'done_when' as const : 'task' as const
    if (!state.task.doneWhen && !state.task.text) return { provider: 'none', reason: 'no_task_text' }
    if (!state.reply) return { provider: 'none', reason: 'no_reply' }
    const key = createHash('sha256').update(JSON.stringify(state)).digest('hex')
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < COMPLETION_LIMITS.cacheMs) return { ...hit.value, cached: true }
    const questions = {
      finished: { type: 'choice', instructions: (basis === 'done_when' ? AGAINST_DONE_WHEN : AGAINST_TASK) + REST, criteria: {
        done: basis === 'done_when' ? 'The reply reports the task finished and checked against its Done when.' : 'The reply reports this task finished and checked.',
        not_done: 'The reply shows work remaining, a plan, a question, a blocker, or a partial result.',
        unclear: 'The reply does not say enough to tell.',
      } },
    }
    try {
      const reply = await this.jev.ask(state, questions, estimateJevTokens({ state, questions }))
      const value = { provider: 'jev' as const, model: reply.model ?? 'jev', cached: false, basis, ...decideCompletion(reply.answers.finished?.probabilities) }
      if (this.cache.size >= COMPLETION_LIMITS.cacheEntries) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, { at: this.now(), value })
      return value
    } catch (e) {
      if (e instanceof JevError) return { provider: 'none', reason: e.code }
      throw e
    }
  }
}
