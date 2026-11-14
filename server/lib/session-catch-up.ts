// X1 (session catch-up, the build after 7.0.42; Work card task:personal:ce1f04b2f016). The pure parts of
// GET /api/agent-sessions/:provider/:id/catch-up (routes/agent-session-bindings.ts): the transcript cursor, the fixed
// sentence set, the binding reason mapping, and the per-client limiter. Contract: lanes/X1_session_refresh_scope.md.
//
// Nothing here reads a file, a registry or a clock of its own; every input is passed in.

import { createHash } from 'node:crypto'

/** The most turns one catch-up returns (the reader's own window, app.js SX_TURNS). */
export const CATCH_UP_TURNS = 40
/** Under this, the same client asking the same thing gets its last answer again (`cached: true`), never a 429. */
export const CATCH_UP_REPLAY_MS = 3_000
/** Per client, across sessions, per minute. */
export const CATCH_UP_PER_MINUTE = 20
/** The longest response body. Over it, the oldest turns go and `gap` is set. */
export const CATCH_UP_MAX_BYTES = 256 * 1024

const CURSOR_RE = /^c1\.[A-Za-z0-9_-]{0,64}\.[A-Za-z0-9_-]{16}$/

interface TurnLike { role: string; text: string; at?: string }

function b64u(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

/** A turn's cursor: its own timestamp (absent on Cursor) and a short hash of its role and words. */
export function turnCursor(turn: TurnLike): string {
  const at = typeof turn.at === 'string' ? turn.at.slice(0, 40) : ''
  const hash = createHash('sha256').update(`${turn.role}\n${turn.text}`).digest('base64url').slice(0, 16)
  return `c1.${b64u(at)}.${hash}`
}

export function isCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && CURSOR_RE.test(value)
}

/**
 * The turns after `after` in `window` (oldest first), or the whole window with `gap` when `after` is absent, is not
 * in the window (more than a window behind, or a transcript rewritten), or names MORE than one turn. Identical turns
 * share a cursor (Cursor writes no time), and picking either copy is wrong: the newest hides turns the page never saw
 * (it saw [go, Done.], the desk added [next, Done.]), the oldest repeats turns it already has (Q1 17:22).
 */
export function turnsSince<T extends TurnLike>(window: readonly T[], after: string | null): { turns: T[]; gap: boolean; cursor: string | null } {
  const cursor = window.length ? turnCursor(window[window.length - 1]!) : null
  if (after === null) return { turns: [...window], gap: true, cursor }
  const hits: number[] = []
  for (let i = 0; i < window.length; i++) if (turnCursor(window[i]!) === after) hits.push(i)
  if (hits.length !== 1) return { turns: [...window], gap: true, cursor }
  return { turns: window.slice(hits[0]! + 1), gap: false, cursor: cursor ?? after }
}

// ------------------------------------------------------------------ the sentence (a fixed set; contract section)

export type SummaryCode =
  | 'new_none' | 'new_one' | 'new_n' | 'new_window'
  | 'ended' | 'answered_mac' | 'answered_glasses' | 'answered_web' | 'question_closed' | 'waiting_question'
  | 'binding_relink' | 'binding_other' | 'binding_busy' | 'binding_no'
  | 'restarted' | 'working' | 'queued_one' | 'queued_n'

export const SUMMARY_TEXT: Readonly<Record<SummaryCode, string>> = Object.freeze({
  new_none: 'No new messages.',
  new_one: '1 new message.',
  new_n: '{n} new messages.',
  new_window: 'Showing the latest messages.',
  ended: 'This session has ended.',
  answered_mac: 'The question you saw was answered at your Mac.',
  answered_glasses: 'The question you saw was answered on your glasses.',
  answered_web: 'The question you saw was answered on another screen.',
  question_closed: 'The question you saw is no longer open.',
  waiting_question: 'It is waiting on a question.',
  binding_relink: 'COS will re-link to this session.',
  binding_other: 'Another COS chat is using this session.',
  binding_busy: 'It is busy at your Mac, so COS cannot link to it yet.',
  binding_no: 'COS cannot link to this session. Fork sends your message to a copy.',
  restarted: 'COS restarted since you looked.',
  working: 'It is working now.',
  queued_one: '1 message is waiting to send.',
  queued_n: '{n} messages are waiting to send.',
})

/** After the transcript clause, at most two more, in this order. */
const SUMMARY_PRIORITY: readonly SummaryCode[] = [
  'ended', 'answered_mac', 'answered_glasses', 'answered_web', 'question_closed', 'waiting_question',
  'binding_relink', 'binding_other', 'binding_busy', 'binding_no', 'restarted', 'working', 'queued_one', 'queued_n',
]

export interface SummaryFacts {
  gap: boolean
  newTurns: number
  ended: boolean
  /** Where the question the page last showed was answered, when it was. */
  answeredBy: 'mac' | 'glasses' | 'web' | null
  /** The question the page last showed is no longer open (and no answer is known). */
  questionClosed: boolean
  waitingQuestion: boolean
  reattach: 'already' | 'safe' | 'not_now' | 'no'
  holder: 'this' | 'other' | 'none'
  restarted: boolean
  working: boolean
  queued: number
}

export function catchUpSummary(f: SummaryFacts): { summary: string; codes: SummaryCode[]; n: number } {
  const lead: SummaryCode = f.gap ? 'new_window' : f.newTurns === 0 ? 'new_none' : f.newTurns === 1 ? 'new_one' : 'new_n'
  const extra = new Set<SummaryCode>()
  if (f.ended) extra.add('ended')
  if (f.answeredBy === 'mac') extra.add('answered_mac')
  else if (f.answeredBy === 'glasses') extra.add('answered_glasses')
  else if (f.answeredBy === 'web') extra.add('answered_web')
  else if (f.questionClosed) extra.add('question_closed')
  if (f.waitingQuestion && !f.ended) extra.add('waiting_question')
  if (!f.ended) {
    if (f.reattach === 'safe') extra.add('binding_relink')
    else if (f.reattach === 'not_now') extra.add(f.holder === 'other' ? 'binding_other' : 'binding_busy')
    else if (f.reattach === 'no') extra.add('binding_no')
  }
  if (f.restarted) extra.add('restarted')
  if (f.working && !f.ended) extra.add('working')
  if (f.queued === 1) extra.add('queued_one')
  else if (f.queued > 1) extra.add('queued_n')
  const codes: SummaryCode[] = [lead, ...SUMMARY_PRIORITY.filter(c => extra.has(c)).slice(0, 2)]
  const text = (code: SummaryCode): string => {
    const n = code === 'new_n' ? f.newTurns : code === 'queued_n' ? f.queued : 0
    return SUMMARY_TEXT[code].replace('{n}', String(n))
  }
  return { summary: codes.map(text).join(' ').slice(0, 160), codes, n: f.newTurns }
}

/** The surface a turn-end answer came from, as the tracker and the marks name it, to the sentence's three. */
export function answeredSurface(by: string | null | undefined): 'mac' | 'glasses' | 'web' | null {
  // TurnAskAnswerSurface (lib/turn-end-ask.ts): mac, mac_app (COS Control on the Mac), glasses, web, cos.
  if (by === 'mac' || by === 'mac_app') return 'mac'
  if (by === 'glasses') return 'glasses'
  if (by === 'web' || by === 'cos') return 'web'
  return null
}

// ------------------------------------------------------------------ binding reasons

/** A registry check's reason, as the contract names it (`store_unavailable` reads as the registry's own words). */
export function bindingReason(reason: string | null | undefined): string {
  if (reason === 'store_unavailable') return 'binding_registry_unavailable'
  return typeof reason === 'string' && /^[a-z_]{1,48}$/.test(reason) ? reason : 'unknown_binding'
}

/** The binding's state from a failed check's reason. */
export function bindingStateFor(reason: string): 'detached' | 'expired' | 'unknown' {
  if (reason === 'binding_detached') return 'detached'
  if (reason === 'binding_expired') return 'expired'
  return 'unknown'
}

/** Refusals a turn may wait behind: the holder is mid-turn or will yield soon. Read as `not_now`, never `no`. */
export const CATCH_UP_WAIT_REASONS: ReadonlySet<string> = new Set([
  'native_thread_working', 'native_turn_in_progress', 'native_target_busy', 'codex_live_unavailable',
])

// ------------------------------------------------------------------ the limiter (memory only, never persisted)

export interface CatchUpLimiterHit { kind: 'replay'; body: Record<string, unknown> }
export interface CatchUpLimiterRefusal { kind: 'refused'; retryAfterS: number }

export class CatchUpLimiter {
  private readonly replays = new Map<string, { at: number; body: Record<string, unknown> }>()
  private readonly windows = new Map<string, number[]>()
  constructor(private readonly maxKeys = 512) {}

  /** A replay for the same client and request under CATCH_UP_REPLAY_MS, a refusal over the minute's cap, or null to answer. */
  check(client: string, requestKey: string, now: number): CatchUpLimiterHit | CatchUpLimiterRefusal | null {
    const replay = this.replays.get(`${client}\n${requestKey}`)
    if (replay && now - replay.at >= 0 && now - replay.at < CATCH_UP_REPLAY_MS) return { kind: 'replay', body: replay.body }
    const times = (this.windows.get(client) ?? []).filter(t => now - t >= 0 && now - t < 60_000)
    if (times.length >= CATCH_UP_PER_MINUTE) {
      this.windows.set(client, times)
      return { kind: 'refused', retryAfterS: Math.max(1, Math.ceil((60_000 - (now - times[0]!)) / 1000)) }
    }
    return null
  }

  /** Counts an answered request and keeps its body for the replay window. */
  record(client: string, requestKey: string, now: number, body: Record<string, unknown>): void {
    const times = (this.windows.get(client) ?? []).filter(t => now - t >= 0 && now - t < 60_000)
    times.push(now)
    this.windows.set(client, times)
    this.replays.set(`${client}\n${requestKey}`, { at: now, body })
    if (this.replays.size > this.maxKeys) {
      for (const [k, v] of this.replays) if (now - v.at >= CATCH_UP_REPLAY_MS || this.replays.size > this.maxKeys) this.replays.delete(k)
    }
    if (this.windows.size > this.maxKeys) {
      for (const [k, v] of this.windows) if (!v.some(t => now - t < 60_000) || this.windows.size > this.maxKeys) this.windows.delete(k)
    }
  }
}

// ------------------------------------------------------------------ health

let mounted = false
/** index.ts, when it wires the catch-up readers into the bindings router (the route then exists). */
export function markSessionCatchUpMounted(): void { mounted = true }
/** /api/health features.sessionCatchUp. False on a server or wiring without the route. */
export function sessionCatchUpMounted(): boolean { return mounted }
export function __resetSessionCatchUpMountedForTests(): void { mounted = false }
