/** Notification-only turn evidence. Never changes lifecycle, permissions or dispatch. */
import { createHash } from 'node:crypto'
import { isMachineOnlyPrompt, type HookEnvelope } from './session-hook-events.js'
import type { SessionSignal } from './session-signal-store.js'
import { captureTurnAsk, projectedTurnAsk, WRAP_UP_TOOL } from './turn-end-ask.js'

export const REPLY_SETTLE_MS = 5_000
const LIMIT = 256
const MAX_REPLY_AGE_MS = 120_000
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(v)
type Reply = { provider: 'claude' | 'codex' | 'cursor'; sessionId: string; turnEndedAt: number; turnId: string; replyReady: true }
type Dependencies = {
  now?: () => number
  initial?: readonly SessionSignal[]
  waiting?: (sessionId: string) => boolean
  signal: (sessionId: string) => SessionSignal | undefined
  deliver: (reply: Reply) => void
}

/** Subscribe after startup replay/drain. A delay allows async ask hooks to cancel;
 * it never upgrades a stopped turn into proof that an entire task succeeded. */
export function createSessionReplyPings(deps: Dependencies) {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; reply: Reply }>()
  const blocked = new Map<string, 'wait' | 'stopped-wait' | 'ask' | 'failed'>()
  const rejected = new Set<string>()
  const cancel = (id: string) => { const old = pending.get(id); if (old) clearTimeout(old.timer); pending.delete(id) }
  const block = (id: string, kind: 'wait' | 'stopped-wait' | 'ask' | 'failed') => {
    cancel(id); blocked.delete(id); blocked.set(id,kind)
    if (blocked.size > LIMIT) blocked.delete(blocked.keys().next().value!)
  }
  for (const s of deps.initial ?? []) if (s.waiting) block(s.sessionId,'wait')
  const observe = (signal: SessionSignal, env: HookEnvelope, child: boolean) => {
    const p = env.payload, id = env.sessionId
    if (child || p.agent_id || p.subagent_id || p.parent_conversation_id || signal.keepWarm) return
    if (!Number.isFinite(env.ts) || env.ts < startedAt || now() - env.ts > MAX_REPLY_AGE_MS || env.ts > now() + 5_000) return
    const observational = p.display_only === true
    if (!observational) {
      if (env.event === 'UserPromptSubmit') {
        cancel(id)
        if (p.prompt_machine_only !== true && !isMachineOnlyPrompt(p.prompt)) blocked.delete(id)
        return
      }
      if (env.event === 'Stop' && (p.is_error === true || p.error || ['error','aborted','failed'].includes(String(p.status)))) { block(id,'failed'); return }
      if (env.event === 'Stop' && blocked.get(id) === 'wait') { block(id,'stopped-wait'); return }
      if (['StopFailure','Interrupt'].includes(env.event)) { block(id,'failed'); return }
      if (signal.waiting) { block(id,'wait'); return }
      if ((env.event === 'PreToolUse' || env.event === 'PostToolUse') && p.tool_name === WRAP_UP_TOOL) {
        const ask = p.turn_ask !== undefined ? projectedTurnAsk(p.turn_ask) : captureTurnAsk(p.tool_input,false)
        if (ask) { block(id,'ask'); return }
      }
      // Matching tool resolution can clear a permission/question wait. A wrap-up
      // ask stays blocked until a new user turn; Stop clearing waiting isn't an answer.
      if (env.event === 'PostToolUse' && p.tool_name !== WRAP_UP_TOOL && !signal.waiting && signal.turnOpen && blocked.get(id) === 'wait') blocked.delete(id)
    }
    if (blocked.has(id) || signal.waiting || signal.failure || deps.waiting?.(id)) return
    const provider = env.provider ?? signal.provider ?? 'claude'
    let turn: string | null = null
    if (observational) {
      // Native Cursor's stop status is notification evidence only. afterAgentResponse
      // and sessionEnd never qualify, and ordinary listeners never receive it.
      const c = p.notification_completion as { status?: unknown; generationId?: unknown } | undefined
      if (provider !== 'cursor' || env.event !== 'PostCompact' || !c || !token(c.generationId)) return
      turn = c.generationId
      if (c.status !== 'completed') {
        if (c.status === 'error' || c.status === 'aborted') {
          const key = createHash('sha256').update(provider+'\0'+id+'\0'+turn).digest('hex')
          rejected.add(key); if (rejected.size > LIMIT) rejected.delete(rejected.values().next().value!)
          if (pending.get(id)?.reply.turnId === key) cancel(id)
        }
        return
      }
    } else {
      if (env.event !== 'Stop' || p.is_error === true || p.error || ['error','aborted','failed'].includes(String(p.status))) return
      if (provider === 'cursor') {
        if (p.status !== 'completed' || !token(p.generation_id)) return
        turn = p.generation_id
      } else {
        // The reducer's identity survives payloads omitting an optional ID on a duplicate Stop.
        turn = token(signal.promptId) ? 'prompt:'+signal.promptId
          : typeof signal.turnStartedAt === 'number' && Number.isFinite(signal.turnStartedAt) && signal.turnStartedAt > 0 && signal.turnStartedAt <= env.ts ? 'start:'+signal.turnStartedAt
          : token(p.turn_id) ? 'turn:'+p.turn_id : token(p.prompt_id) ? 'prompt:'+p.prompt_id : null
      }
    }
    if (!turn) return
    const turnId = createHash('sha256').update(provider+'\0'+id+'\0'+turn).digest('hex')
    const old = pending.get(id)
    if (rejected.has(turnId)) return
    if (old?.reply.turnId === turnId) { old.reply.turnEndedAt = env.ts; return }
    cancel(id)
    if (pending.size >= LIMIT) return
    const reply: Reply = { provider, sessionId:id, turnEndedAt:env.ts, turnId, replyReady:true }
    const timer = setTimeout(() => {
      pending.delete(id)
      const current = deps.signal(id)
      if (!current || current.waiting || current.keepWarm || current.failure || blocked.has(id) || deps.waiting?.(id)) return
      if (!observational && (current.turnOpen || current.stopAt !== reply.turnEndedAt)) return
      try { deps.deliver(reply) } catch { /* notification failure never changes the session */ }
    },REPLY_SETTLE_MS)
    timer.unref?.(); pending.set(id,{timer,reply})
  }
  return { observe, stop() { for (const id of pending.keys()) cancel(id); blocked.clear(); rejected.clear() } }
}
