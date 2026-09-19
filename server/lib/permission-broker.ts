// The permission broker (6.52.0): a Claude session's question card (AskUserQuestion) or
// tool approval, answered from the COS glasses or the phone while Miles is away from the
// Mac, and handed straight back to the Mac's own dialog the moment he returns to it.
//
// ---------------------------------------------------------------------------
// THE MECHANISM (canaries, Claude Code 2.1.278, 2026-09-19)
// ---------------------------------------------------------------------------
// Claude Code runs a PermissionRequest hook before it shows a permission dialog, and waits
// for it (the installer gives it 130 s; the script's curl gives up at 125 s). The hook may
// print a decision:
//   - AskUserQuestion: `allow` with `updatedInput` = the original input plus `answers`, a
//     map from each question's ORIGINAL text to a LIST of labels (Desktop's own shape; an
//     "Other" answer is its own entry, verbatim). The model then reads "The user answered".
//   - any other tool: `allow` runs it; `deny` with a message blocks it (`is_error`).
// No decision (`{}`, or anything the script does not recognise) means the native dialog,
// exactly as if no hook existed. Every path here that is not an answer ends in `{}`.
//
// ---------------------------------------------------------------------------
// WHAT GETS PARKED (Miles's Q3 and Q4, 2026-09-19): away AND wearing
// ---------------------------------------------------------------------------
// The hook has no matcher, so every permission request at an idle desk reaches the route.
// Everything outside the gate answers `{}` at once (target: under 100 ms). A request is
// parked only when ALL of these hold:
//   - the broker is on: `COS_PERMISSION_BROKER` is not `0`/`false`/`off`, and the session
//     hooks are on (the rows and the retraction ride them);
//   - no maintenance drain is under way;
//   - it is a Claude envelope: a Cursor payload (`cursor_version`) is never brokered;
//   - the tool is AskUserQuestion, or approvals are on (`COS_PERMISSION_BROKER=questions`
//     turns approvals off; the default brokers both). ExitPlanMode is never brokered: its
//     dialog chooses a permission MODE, and "allow once" is not a plan approval;
//   - a client that can answer asked for the questions in the last 60 s: an authenticated
//     `GET /api/session-questions` (lib/client-liveness). An app without the question UI
//     never calls it, so for it the broker is inert and every request is `{}`;
//   - the desk has been idle `COS_PERMISSION_BROKER_DESK_IDLE_S` (default 90), read here with
//     a bounded `ioreg`, not trusted from the script.
//
// A parked item holds the hook's response open until EXACTLY ONE of these resolves it:
// an answer from the lens or phone; the desk becoming active (polled every 1.5 s): `{}`;
// the deadline (`COS_PERMISSION_BROKER_TIMEOUT_S`, default 110, clamped to 120 so it lands
// before the hook's 125 s): `{}`; the hook hanging up: `hook_gone`; the session moving on
// without us (its tool ran, was denied, or the turn ended): `{}`; a drain: `{}`.
//
// NEVER: a permission RULE. `updatedPermissions` and the request's suggestions are never
// returned; the decision objects below are built from nothing but constants and the
// original input. Question and command text is never logged and never goes on the display
// bus; the client API is behind the API token.

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { sanitizeActivityPreview } from './activity-preview.js'
import { toolFingerprint, SESSION_ID_RE, type HookEnvelope } from './session-hook-events.js'
import { ASK_USER_QUESTION_TOOL, type SessionSignalStore } from './session-signal-store.js'
import { TARGET_MAX_CHARS, commandSummary, detailForTool, targetForTool } from './session-stream-events.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type BrokerMode = 'off' | 'questions' | 'all'

/**
 * `COS_PERMISSION_BROKER`: `0`/`false`/`off` answers `{}` to everything (the kill switch,
 * no reinstall needed); `questions` brokers AskUserQuestion only; unset or anything else
 * brokers questions AND approvals (Miles's Q4). Off whenever the session hooks are off.
 */
export function permissionBrokerMode(env: NodeJS.ProcessEnv, sessionHooksOn: boolean): BrokerMode {
  const raw = (env.COS_PERMISSION_BROKER ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'off') return 'off'
  if (!sessionHooksOn) return 'off'
  return raw === 'questions' ? 'questions' : 'all'
}

export const BROKER_TIMEOUT_DEFAULT_S = 110
/** The hook script's curl gives up at `--max-time 125`. */
export const HOOK_CURL_MAX_S = 125
/** The deadline is never at or above the hook's own wait: five seconds of margin. */
export const BROKER_TIMEOUT_MAX_S = 120
export const BROKER_TIMEOUT_MIN_S = 5

/** `COS_PERMISSION_BROKER_TIMEOUT_S`, default 110, clamped to [5, 120], in ms. */
export function permissionBrokerTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.COS_PERMISSION_BROKER_TIMEOUT_S)
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : BROKER_TIMEOUT_DEFAULT_S
  return Math.round(Math.min(BROKER_TIMEOUT_MAX_S, Math.max(BROKER_TIMEOUT_MIN_S, seconds)) * 1000)
}

/** A client must have polled `GET /api/session-questions` this recently. */
export const CLIENT_LIVE_WINDOW_MS = 60_000
/** How often a parked item re-reads the desk. */
export const DESK_POLL_MS = 1_500
/** Parked items at once; past it, `{}`. */
export const MAX_PENDING = 32
/** A settled item is kept this long so a late answer gets the right code and a retry its replay. */
export const SETTLED_RETENTION_MS = 10 * 60_000
export const MAX_SETTLED = 256
/** Free text for "Other". */
export const OTHER_TEXT_MAX = 2_000
/** The full command, one page back on the lens. */
export const APPROVAL_DETAIL_MAX = 1_000
export const DENY_MESSAGE = 'Denied from COS glasses'
/** Tools whose dialog is not a yes/no: never brokered. */
export const UNBROKERED_TOOLS: ReadonlySet<string> = new Set(['ExitPlanMode'])

// ---------------------------------------------------------------------------
// The desk
// ---------------------------------------------------------------------------

/**
 * Seconds since the last keyboard, mouse or trackpad input on this Mac, or null when it
 * cannot be read. One bounded `ioreg` (about 30 ms; `-r -d 1 -k` keeps the output to a
 * few KB), the same counter the hook script reads.
 */
export function readHidIdleSeconds(): Promise<number | null> {
  return new Promise(resolve => {
    try {
      execFile('/usr/sbin/ioreg', ['-r', '-d', '1', '-k', 'HIDIdleTime', '-c', 'IOHIDSystem'], { timeout: 1_000, maxBuffer: 1 << 20 }, (error, stdout) => {
        if (error) return resolve(null)
        const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(stdout))
        const ns = match ? Number(match[1]) : Number.NaN
        resolve(Number.isFinite(ns) ? Math.floor(ns / 1_000_000_000) : null)
      })
    } catch {
      resolve(null)
    }
  })
}

// ---------------------------------------------------------------------------
// Reading the hook's envelope
// ---------------------------------------------------------------------------

export interface PermissionRequestFacts {
  sessionId: string
  toolName: string
  /** Verbatim. The answer is built on top of this object, never a copy of the display. */
  toolInput: Record<string, unknown>
  /** The reducer's fingerprint of the same request (tool name + canonical input). */
  fingerprint: string
  /** The envelope's `ts`: when the hook started, epoch ms from the same Mac clock. */
  hookStartedAtMs: number | null
}

export type EnvelopeVerdict =
  | { ok: true; facts: PermissionRequestFacts }
  | { ok: false; reason: 'malformed' | 'cursor' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The spool envelope the hook posts (`{"ts","ppid","event","payload"}`), read strictly.
 * Cursor stamps every hook payload with `cursor_version` and Claude Code never does, so
 * the key's presence, in any form, is a Cursor request.
 */
export function parsePermissionRequestEnvelope(body: unknown): EnvelopeVerdict {
  if (!isRecord(body) || body.event !== 'PermissionRequest' || !isRecord(body.payload)) return { ok: false, reason: 'malformed' }
  const p = body.payload
  if ('cursor_version' in p) return { ok: false, reason: 'cursor' }
  if (typeof p.session_id !== 'string' || !SESSION_ID_RE.test(p.session_id)) return { ok: false, reason: 'malformed' }
  if (typeof p.tool_name !== 'string' || p.tool_name.trim().length === 0) return { ok: false, reason: 'malformed' }
  if (!isRecord(p.tool_input)) return { ok: false, reason: 'malformed' }
  const ts = typeof body.ts === 'number' && Number.isFinite(body.ts) ? body.ts : null
  return {
    ok: true,
    facts: {
      sessionId: p.session_id.toLowerCase(),
      toolName: p.tool_name,
      toolInput: p.tool_input,
      fingerprint: toolFingerprint(p.tool_name, p.tool_input),
      hookStartedAtMs: ts,
    },
  }
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export interface BrokerQuestionOption { label: string; description: string }
export interface BrokerQuestion { question: string; header: string; multiSelect: boolean; options: BrokerQuestionOption[] }

export const MAX_QUESTIONS = 8
export const MAX_OPTIONS = 16

/**
 * The AskUserQuestion input, read strictly; null when the card cannot be answered from
 * here (no questions, an option without a label, or two questions with the same text:
 * answers are keyed by the text, so two alike could never both be answered).
 */
export function parseQuestions(toolInput: Record<string, unknown>): BrokerQuestion[] | null {
  const raw = toolInput.questions
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUESTIONS) return null
  const seen = new Set<string>()
  const questions: BrokerQuestion[] = []
  for (const q of raw) {
    if (!isRecord(q) || typeof q.question !== 'string' || q.question.trim().length === 0) return null
    if (seen.has(q.question)) return null
    seen.add(q.question)
    if (!Array.isArray(q.options) || q.options.length === 0 || q.options.length > MAX_OPTIONS) return null
    const options: BrokerQuestionOption[] = []
    for (const o of q.options) {
      if (!isRecord(o) || typeof o.label !== 'string' || o.label.length === 0) return null
      options.push({ label: o.label, description: typeof o.description === 'string' ? o.description : '' })
    }
    questions.push({ question: q.question, header: typeof q.header === 'string' ? q.header : '', multiSelect: q.multiSelect === true, options })
  }
  return questions
}

export type AnswerValidation =
  | { ok: true; answers: Record<string, string[]> }
  | { ok: false; reason: 'answers_shape' | 'unanswered' | 'unknown_label' | 'duplicate_label' | 'too_many' | 'other_too_long'; index?: number }

/**
 * A client's answers, one entry per question in order: `{ labels?: string[], other?: string }`.
 * Every question must be answered. Labels must match one of that question's options
 * EXACTLY (the client shows a sanitized copy and sends the original back). `other` is the
 * free text of the card's "Other" choice, sent verbatim as its own entry. Single-select
 * takes exactly one entry. The result is keyed by each question's ORIGINAL text, labels
 * in option order, "Other" last: the shape Claude Desktop sends.
 */
export function validateQuestionAnswers(questions: readonly BrokerQuestion[], raw: unknown): AnswerValidation {
  if (!Array.isArray(raw) || raw.length !== questions.length) return { ok: false, reason: 'answers_shape' }
  const answers: Record<string, string[]> = {}
  for (let index = 0; index < questions.length; index++) {
    const q = questions[index]!
    const entry = raw[index]
    if (!isRecord(entry)) return { ok: false, reason: 'answers_shape', index }
    const labels = entry.labels === undefined ? [] : entry.labels
    if (!Array.isArray(labels) || labels.some(l => typeof l !== 'string')) return { ok: false, reason: 'answers_shape', index }
    if (entry.other !== undefined && typeof entry.other !== 'string') return { ok: false, reason: 'answers_shape', index }
    const picked = new Set<string>()
    for (const label of labels as string[]) {
      if (!q.options.some(o => o.label === label)) return { ok: false, reason: 'unknown_label', index }
      if (picked.has(label)) return { ok: false, reason: 'duplicate_label', index }
      picked.add(label)
    }
    // Verbatim: whitespace-only is no answer, anything else is sent exactly as written.
    const other = typeof entry.other === 'string' ? entry.other : ''
    if (other.length > OTHER_TEXT_MAX) return { ok: false, reason: 'other_too_long', index }
    const list: string[] = []
    for (const option of q.options) {
      if (picked.has(option.label) && !list.includes(option.label)) list.push(option.label)
    }
    if (other.trim().length > 0) list.push(other)
    if (list.length === 0) return { ok: false, reason: 'unanswered', index }
    if (!q.multiSelect && list.length > 1) return { ok: false, reason: 'too_many', index }
    answers[q.question] = list
  }
  return { ok: true, answers }
}

// ---------------------------------------------------------------------------
// What the hook prints
// ---------------------------------------------------------------------------

/** AskUserQuestion answered: allow, with the ORIGINAL input plus `answers`. Nothing else. */
export function questionHookOutput(toolInput: Record<string, unknown>, answers: Record<string, string[]>): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...toolInput, answers } } } }
}

/** A tool approval: allow once, or deny with the one message. Never a rule. */
export function approvalHookOutput(decision: 'allow' | 'deny'): Record<string, unknown> {
  const body = decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: DENY_MESSAGE }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: body } }
}

// ---------------------------------------------------------------------------
// The approval card
// ---------------------------------------------------------------------------

export interface ApprovalCard {
  tool: string
  /** The Sessions grammar's short target (a command's `commandSummary`, a file's basename), redacted. */
  summary: string
  /** The full command or target, redacted, one line, capped. The lens puts it one page back. */
  detail: string
}

const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'shell', 'exec', 'exec_command'])

/**
 * What the lens and phone show for an approval. Redaction runs on the FULL text before
 * anything is cut, so a secret is never half-shown: the shell summary is taken first (its
 * heredoc rule needs the original lines) and then redacted; every other field is redacted
 * and then handed to the Sessions grammar's target helper.
 */
export function approvalCard(toolName: string, toolInput: Record<string, unknown>): ApprovalCard {
  const redacted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(toolInput)) {
    if (typeof value === 'string') redacted[key] = sanitizeActivityPreview(value, 4_000) ?? ''
  }
  const command = typeof toolInput.command === 'string' ? toolInput.command : typeof toolInput.cmd === 'string' ? toolInput.cmd : null
  if (SHELL_TOOLS.has(toolName.trim().toLowerCase()) && command !== null) {
    return {
      tool: toolName,
      summary: sanitizeActivityPreview(commandSummary(command), TARGET_MAX_CHARS) ?? '',
      detail: sanitizeActivityPreview(command, APPROVAL_DETAIL_MAX) ?? '',
    }
  }
  const summary = targetForTool(toolName, redacted)
  const path = redacted.file_path ?? redacted.path ?? redacted.notebook_path
  let detail: string
  if (typeof path === 'string' && path.length > 0) {
    const delta = detailForTool(toolName, toolInput)
    detail = delta ? `${path} (${delta})` : path
  } else {
    detail = sanitizeActivityPreview(JSON.stringify(toolInput), APPROVAL_DETAIL_MAX) ?? ''
  }
  return { tool: toolName, summary, detail }
}

// ---------------------------------------------------------------------------
// The broker
// ---------------------------------------------------------------------------

export type BrokerItemKind = 'question' | 'approval'
export type BrokerResolution = 'answered' | 'handed_to_desk' | 'expired' | 'hook_gone' | 'retracted' | 'drained'
export type BrokerFastPath =
  | 'broker_off' | 'draining' | 'malformed' | 'cursor' | 'approvals_off' | 'unsupported_tool'
  | 'unsupported_input' | 'no_client' | 'stale_hook' | 'capacity' | 'desk_unknown' | 'desk_active'
  | 'hook_gone_early'

/** The held response. */
export interface HookReplyChannel {
  /** The hook is still listening: its socket can take a reply. */
  writable(): boolean
  /** Write the reply; false when it could not be written. */
  reply(body: Record<string, unknown>): boolean
}

/** Where the rows learn about a parked item (the session signal store, in production). */
export interface BrokerSignalSink {
  attach(sessionId: string, requestId: string, fingerprint: string): void
  detach(sessionId: string, requestId: string): void
  decided(sessionId: string, requestId: string, fingerprint: string): void
}

export interface PermissionBrokerDeps {
  now(): number
  mode(): BrokerMode
  admissionsOpen(): boolean
  /** The newest authenticated `GET /api/session-questions`, or null (lib/client-liveness). */
  lastQuestionsPollAt(): number | null
  readDeskIdleSeconds(): Promise<number | null>
  deskIdleSeconds(): number
  timeoutMs(): number
  signals?: BrokerSignalSink
  pollMs?: number
  newId?: () => string
  log?: (line: string) => void
}

export interface ParkRequest {
  facts: PermissionRequestFacts
  kind: BrokerItemKind
  questions: BrokerQuestion[] | null
  approval: ApprovalCard | null
  deadlineAt: number
}

export type BrokerAdmission = { ok: true; request: ParkRequest } | { ok: false; reason: BrokerFastPath }

type Chosen = { answers: Record<string, string[]> } | { decision: 'allow' | 'deny' }

interface BrokerItem {
  id: string
  sessionId: string
  kind: BrokerItemKind
  toolName: string
  toolInput: Record<string, unknown>
  fingerprint: string
  /** When the hook started (its envelope stamp) or, unstamped, when it was parked. */
  requestedAt: number
  questions: BrokerQuestion[] | null
  approval: ApprovalCard | null
  createdAt: number
  deadlineAt: number
  state: 'pending' | BrokerResolution
  settledAt: number | null
  answer: { clientAnswerId: string; chosen: Chosen } | null
  channel: HookReplyChannel | null
  timer: ReturnType<typeof setTimeout> | null
}

export interface SessionQuestionView {
  id: string
  sessionId: string
  provider: 'claude'
  kind: BrokerItemKind
  tool: string
  createdAt: string
  deadlineAt: string
  questions?: BrokerQuestion[]
  approval?: ApprovalCard
}

export interface PermissionBrokerHealth {
  enabled: boolean
  mode: BrokerMode
  pending: number
  counters: {
    parked: number
    answered: number
    handed_to_desk: number
    expired: number
    hook_gone: number
    retracted: number
    drained: number
    fast_path: Partial<Record<BrokerFastPath, number>>
  }
  lastFastPath: BrokerFastPath | null
}

export interface AnswerResult { status: number; body: Record<string, unknown> }

export const BROKER_ID_RE = /^pq_[0-9a-f]{24}$/
export const CLIENT_ANSWER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** Events that end the turn a request was part of: every held request of the session is moot. */
const TURN_BOUNDARIES: ReadonlySet<string> = new Set(['Stop', 'StopFailure', 'SessionEnd', 'UserPromptSubmit'])

export class PermissionBroker {
  private readonly deps: PermissionBrokerDeps
  private readonly items = new Map<string, BrokerItem>()
  private poll: ReturnType<typeof setInterval> | null = null
  private pollInFlight = false
  private readonly counters = { parked: 0, answered: 0, handed_to_desk: 0, expired: 0, hook_gone: 0, retracted: 0, drained: 0 }
  private readonly fastPaths: Partial<Record<BrokerFastPath, number>> = {}
  private lastFastPath: BrokerFastPath | null = null

  constructor(deps: PermissionBrokerDeps) {
    this.deps = deps
  }

  private log(line: string): void {
    try { (this.deps.log ?? console.log)(`[permission-broker] ${line}`) } catch { /* logging never breaks a hook */ }
  }

  /** A request answered `{}` without being parked, counted by why. */
  noteFastPath(reason: BrokerFastPath): { ok: false; reason: BrokerFastPath } {
    this.fastPaths[reason] = (this.fastPaths[reason] ?? 0) + 1
    this.lastFastPath = reason
    return { ok: false, reason }
  }

  pendingCount(): number {
    let n = 0
    for (const item of this.items.values()) if (item.state === 'pending') n++
    return n
  }

  /**
   * Every gate, cheapest first, so a request outside them is answered without spawning
   * anything. The desk is read last (one `ioreg`), and the switch and the drain are read
   * again after it, since the world may have moved during the read.
   */
  async admit(body: unknown): Promise<BrokerAdmission> {
    if (this.deps.mode() === 'off') return this.noteFastPath('broker_off')
    if (!this.deps.admissionsOpen()) return this.noteFastPath('draining')
    const parsed = parsePermissionRequestEnvelope(body)
    if (!parsed.ok) return this.noteFastPath(parsed.reason)
    const { facts } = parsed
    let kind: BrokerItemKind
    let questions: BrokerQuestion[] | null = null
    let approval: ApprovalCard | null = null
    if (facts.toolName === ASK_USER_QUESTION_TOOL) {
      questions = parseQuestions(facts.toolInput)
      if (!questions) return this.noteFastPath('unsupported_input')
      kind = 'question'
    } else {
      if (this.deps.mode() !== 'all') return this.noteFastPath('approvals_off')
      if (UNBROKERED_TOOLS.has(facts.toolName)) return this.noteFastPath('unsupported_tool')
      kind = 'approval'
      approval = approvalCard(facts.toolName, facts.toolInput)
    }
    const now = this.deps.now()
    const polledAt = this.deps.lastQuestionsPollAt()
    if (polledAt === null || now - polledAt > CLIENT_LIVE_WINDOW_MS) return this.noteFastPath('no_client')
    // The deadline counts from when the HOOK started, when its stamp is sane: a request the
    // server read late must still be answered before the hook's curl gives up.
    const requestedAt = facts.hookStartedAtMs !== null && facts.hookStartedAtMs <= now ? facts.hookStartedAtMs : now
    const deadlineAt = requestedAt + this.deps.timeoutMs()
    if (deadlineAt <= now) return this.noteFastPath('stale_hook')
    if (this.pendingCount() >= MAX_PENDING) return this.noteFastPath('capacity')
    let idle: number | null = null
    try { idle = await this.deps.readDeskIdleSeconds() } catch { idle = null }
    if (idle === null) return this.noteFastPath('desk_unknown')
    if (idle < this.deps.deskIdleSeconds()) return this.noteFastPath('desk_active')
    if (this.deps.mode() === 'off') return this.noteFastPath('broker_off')
    if (!this.deps.admissionsOpen()) return this.noteFastPath('draining')
    return { ok: true, request: { facts, kind, questions, approval, deadlineAt } }
  }

  /** Hold the hook's response until exactly one resolution. Returns the item id. */
  park(request: ParkRequest, channel: HookReplyChannel): string {
    const now = this.deps.now()
    const id = this.deps.newId ? this.deps.newId() : `pq_${randomBytes(12).toString('hex')}`
    const { facts } = request
    const item: BrokerItem = {
      id,
      sessionId: facts.sessionId,
      kind: request.kind,
      toolName: facts.toolName,
      // Only a question needs its input again (the answer is built on it). An approval's
      // input can be a whole file (Write): never kept past the card and the fingerprint.
      toolInput: request.kind === 'question' ? facts.toolInput : {},
      fingerprint: facts.fingerprint,
      requestedAt: facts.hookStartedAtMs !== null && facts.hookStartedAtMs <= now ? facts.hookStartedAtMs : now,
      questions: request.questions,
      approval: request.approval,
      createdAt: now,
      deadlineAt: request.deadlineAt,
      state: 'pending',
      settledAt: null,
      answer: null,
      channel,
      timer: null,
    }
    this.items.set(id, item)
    this.counters.parked++
    item.timer = setTimeout(() => { this.settle(item, 'expired') }, Math.max(0, request.deadlineAt - now))
    item.timer.unref?.()
    try { this.deps.signals?.attach(item.sessionId, id, item.fingerprint) } catch { /* rows are advisory */ }
    this.ensurePolling()
    this.log(`parked ${id} kind=${item.kind} session=${item.sessionId.slice(0, 8)} deadline_s=${Math.round((request.deadlineAt - now) / 1000)} pending=${this.pendingCount()}`)
    return id
  }

  /** The hook's connection closed. A no-op once the item is settled. */
  hookClosed(id: string): void {
    const item = this.items.get(id)
    if (item) this.settle(item, 'hook_gone')
  }

  /** Every way an item ends except an answer. The hook gets `{}` unless it is gone. */
  private settle(item: BrokerItem, resolution: Exclude<BrokerResolution, 'answered'>): boolean {
    if (item.state !== 'pending') return false
    item.state = resolution
    item.settledAt = this.deps.now()
    if (item.timer) clearTimeout(item.timer)
    item.timer = null
    if (resolution !== 'hook_gone') {
      try { item.channel?.reply({}) } catch { /* the hook is gone anyway */ }
    }
    item.channel = null
    item.toolInput = {} // a settled item is kept for its codes, not its content
    this.counters[resolution]++
    try { this.deps.signals?.detach(item.sessionId, item.id) } catch { /* rows are advisory */ }
    this.log(`${resolution} ${item.id} kind=${item.kind} pending=${this.pendingCount()}`)
    this.prune()
    return true
  }

  /** The pending items, oldest first, for `GET /api/session-questions`. */
  list(): SessionQuestionView[] {
    const now = this.deps.now()
    const views: SessionQuestionView[] = []
    for (const item of [...this.items.values()]) {
      if (item.state !== 'pending') continue
      // A deadline the timer has not caught yet is still a dead question.
      if (now >= item.deadlineAt) { this.settle(item, 'expired'); continue }
      views.push({
        id: item.id,
        sessionId: item.sessionId,
        provider: 'claude',
        kind: item.kind,
        tool: item.toolName,
        createdAt: new Date(item.createdAt).toISOString(),
        deadlineAt: new Date(item.deadlineAt).toISOString(),
        ...(item.questions ? { questions: item.questions } : {}),
        ...(item.approval ? { approval: item.approval } : {}),
      })
    }
    return views.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * `POST /api/session-questions/:id/answer`. Synchronous from the state check to the
   * reply, so two racing answers cannot both win: the first one settles the item and the
   * second reads it settled.
   */
  answer(id: string, body: unknown): AnswerResult {
    const item = BROKER_ID_RE.test(id) ? this.items.get(id) : undefined
    if (!item) return { status: 404, body: { error: 'not_found' } }
    const input = isRecord(body) ? body : {}
    const clientAnswerId = input.clientAnswerId
    if (typeof clientAnswerId !== 'string' || !CLIENT_ANSWER_ID_RE.test(clientAnswerId)) {
      return { status: 400, body: { error: 'invalid_answer', reason: 'client_answer_id' } }
    }
    if (item.state !== 'pending') return this.settledReply(item, clientAnswerId)
    if (this.deps.now() >= item.deadlineAt) {
      this.settle(item, 'expired')
      return this.settledReply(item, clientAnswerId)
    }
    let chosen: Chosen
    let output: Record<string, unknown>
    if (item.kind === 'question') {
      const validation = validateQuestionAnswers(item.questions ?? [], input.answers)
      if (!validation.ok) {
        return { status: 400, body: { error: 'invalid_answer', reason: validation.reason, ...(validation.index !== undefined ? { index: validation.index } : {}) } }
      }
      chosen = { answers: validation.answers }
      output = questionHookOutput(item.toolInput, validation.answers)
    } else {
      if (input.decision !== 'allow' && input.decision !== 'deny') return { status: 400, body: { error: 'invalid_answer', reason: 'decision' } }
      chosen = { decision: input.decision }
      output = approvalHookOutput(input.decision)
    }
    // The hook must still be listening BEFORE the answer is accepted. An answer written
    // into a closed socket is one the session never received: it would read as answered
    // here while Claude shows the native dialog.
    if (!item.channel || !item.channel.writable() || !item.channel.reply(output)) {
      this.settle(item, 'hook_gone')
      return this.settledReply(item, clientAnswerId)
    }
    item.state = 'answered'
    item.settledAt = this.deps.now()
    item.answer = { clientAnswerId, chosen }
    item.channel = null
    item.toolInput = {}
    if (item.timer) clearTimeout(item.timer)
    item.timer = null
    this.counters.answered++
    try { this.deps.signals?.decided(item.sessionId, item.id, item.fingerprint) } catch { /* rows are advisory */ }
    this.log(`answered ${item.id} kind=${item.kind} pending=${this.pendingCount()}`)
    this.prune()
    return { status: 200, body: { ok: true, id: item.id, kind: item.kind, ...chosen } }
  }

  private settledReply(item: BrokerItem, clientAnswerId: string): AnswerResult {
    switch (item.state) {
      case 'answered': {
        const chosen = item.answer?.chosen ?? {}
        if (item.answer?.clientAnswerId === clientAnswerId) return { status: 200, body: { ok: true, id: item.id, kind: item.kind, replay: true, ...chosen } }
        return { status: 409, body: { error: 'already_answered', ...chosen } }
      }
      case 'expired':
        return { status: 409, body: { error: 'expired' } }
      case 'hook_gone':
        return { status: 410, body: { error: 'hook_gone' } }
      default:
        // handed_to_desk, retracted, drained: the Mac has it now.
        return { status: 409, body: { error: 'handed_to_desk', reason: item.state } }
    }
  }

  /**
   * One hook event from the spool, after the signal store applied it (the store's
   * subscriber). Keeps the row's id attached across re-announcements, and retracts a held
   * item the session has moved past without us: its tool ran or was denied (the native
   * dialog was answered), or its turn ended. An event older than the request is history.
   */
  observeHookEvent(env: HookEnvelope, child: boolean): void {
    if (child) return
    const p = env.payload
    const toolName = typeof p.tool_name === 'string' ? p.tool_name : ''
    const fingerprint = typeof p.tool_fingerprint === 'string' ? p.tool_fingerprint : toolFingerprint(toolName, p.tool_input ?? null)
    for (const item of [...this.items.values()]) {
      if (item.sessionId !== env.sessionId) continue
      if (env.event === 'PermissionRequest' || env.event === 'PreToolUse') {
        if (item.fingerprint !== fingerprint) continue
        try {
          if (item.state === 'pending') this.deps.signals?.attach(item.sessionId, item.id, item.fingerprint)
          // A late copy of a request we already answered (stamped before the answer) must
          // not leave the row waiting; the same question asked AGAIN later is a new wait.
          else if (item.state === 'answered' && env.ts <= (item.settledAt ?? 0)) this.deps.signals?.decided(item.sessionId, item.id, item.fingerprint)
        } catch { /* rows are advisory */ }
        continue
      }
      if (item.state !== 'pending' || env.ts < item.requestedAt) continue
      if (TURN_BOUNDARIES.has(env.event) || (env.event === 'SessionStart' && p.source !== 'compact')) {
        this.settle(item, 'retracted')
        continue
      }
      if (env.event === 'PostToolUse' || env.event === 'PostToolUseFailure' || env.event === 'PermissionDenied') {
        const same = item.kind === 'question'
          ? toolName === ASK_USER_QUESTION_TOOL
          : fingerprint === item.fingerprint || (env.event === 'PermissionDenied' && toolName === item.toolName)
        if (same) this.settle(item, 'retracted')
      }
    }
  }

  private ensurePolling(): void {
    if (this.poll || this.pendingCount() === 0) return
    this.poll = setInterval(() => { void this.tick() }, this.deps.pollMs ?? DESK_POLL_MS)
    this.poll.unref?.()
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  /** One desk check while anything is held. Returning to the Mac hands everything back. */
  async tick(): Promise<void> {
    if (this.pendingCount() === 0) { this.stopPolling(); return }
    if (!this.deps.admissionsOpen()) { this.settleAll('drained'); return }
    if (this.pollInFlight) return
    this.pollInFlight = true
    let idle: number | null = null
    try { idle = await this.deps.readDeskIdleSeconds() } catch { idle = null } finally { this.pollInFlight = false }
    // Unreadable is treated as the desk: the native dialog is the safe side.
    if (idle !== null && idle >= this.deps.deskIdleSeconds()) return
    this.settleAll('handed_to_desk')
  }

  private settleAll(resolution: 'handed_to_desk' | 'drained'): void {
    for (const item of [...this.items.values()]) if (item.state === 'pending') this.settle(item, resolution)
    if (this.pendingCount() === 0) this.stopPolling()
  }

  /** Settled items are kept for SETTLED_RETENTION_MS (late answers, replays), at most MAX_SETTLED. */
  private prune(): void {
    const now = this.deps.now()
    const settled: BrokerItem[] = []
    for (const item of this.items.values()) {
      if (item.state === 'pending') continue
      if (item.settledAt !== null && now - item.settledAt > SETTLED_RETENTION_MS) this.items.delete(item.id)
      else settled.push(item)
    }
    const excess = settled.length - MAX_SETTLED
    for (let i = 0; i < excess; i++) this.items.delete(settled[i]!.id)
    if (this.pendingCount() === 0) this.stopPolling()
  }

  health(): PermissionBrokerHealth {
    const mode = this.deps.mode()
    return {
      enabled: mode !== 'off',
      mode,
      pending: this.pendingCount(),
      counters: { ...this.counters, fast_path: { ...this.fastPaths } },
      lastFastPath: this.lastFastPath,
    }
  }

  /** Shutdown: every held hook is answered `{}` (the native dialog) before the process goes. */
  stop(): void {
    this.settleAll('drained')
    this.stopPolling()
  }
}

// ---------------------------------------------------------------------------
// Wiring to the session signal store, and health
// ---------------------------------------------------------------------------

type SignalStoreSeams = Pick<SessionSignalStore, 'attachPermissionRequestId' | 'detachPermissionRequestId' | 'resolveWaiting' | 'subscribe'>

/** The rows carry a held item's id; a decision is resolution evidence; anything else drops the id. */
export function brokerSignalSink(store: SignalStoreSeams): BrokerSignalSink {
  return {
    attach: (sessionId, requestId, fingerprint) => { store.attachPermissionRequestId(sessionId, requestId, fingerprint) },
    detach: (sessionId, requestId) => { store.detachPermissionRequestId(sessionId, requestId) },
    decided: (sessionId, requestId, fingerprint) => { store.resolveWaiting(sessionId, { requestId, fingerprint }) },
  }
}

/** Feed every applied hook event to the broker. Returns the unsubscribe. */
export function wirePermissionBrokerToSignals(broker: PermissionBroker, store: SignalStoreSeams): () => void {
  return store.subscribe((_signal, env, child) => { broker.observeHookEvent(env, child) })
}

let registered: PermissionBroker | null = null

export function registerPermissionBroker(broker: PermissionBroker | null): void {
  registered = broker
}

/** `/api/health`: counts and the mode only; never an id, a question or a command. */
export function permissionBrokerHealthFields(): { permissionBroker: PermissionBrokerHealth | null } {
  return { permissionBroker: registered ? registered.health() : null }
}
