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
// WHAT GETS PARKED (Miles's Q3 and Q4, 2026-09-19): away AND recently present
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
//   - a client that can answer asked for the questions in the last 30 s: an authenticated
//     `GET /api/session-questions?client=glasses|phone` (lib/client-liveness). An app without
//     the question UI never calls it, so for it the broker is inert and every request is `{}`.
//     6.60.0: or the away hold applies (THE AWAY HOLD, below). Only a poll WITHOUT `hold=1`
//     counts here as before; a `hold=1` poll counts only while its wearer's presence is
//     recent;
//   - the desk has been idle `COS_PERMISSION_BROKER_DESK_IDLE_S` (default 90, never below 30),
//     read here with a bounded `ioreg`, not trusted from the script.
// The cheap gates run first and the desk read last; the question card or the approval card
// is built only for a request that will be parked (QA round 1: a 900 KB Write input costs a
// no_client request nothing).
//
// A parked item holds the hook's response open until EXACTLY ONE of these resolves it:
// an answer from the lens or phone; a hand-back from either ("Leave for the Mac"): `{}`;
// the desk becoming active (polled every 1.5 s, and two unreadable reads in a row count as
// active): `{}`; the answering client going quiet for 30 s: `{}` (never an item the away
// hold holds, 6.60.0); the deadline (`COS_PERMISSION_BROKER_TIMEOUT_S`, default 110, clamped
// to 120 so it lands before the hook's 125 s; 6.60.0: the away hold, up to 600 s, never past
// `holdCeilingS`): `{}`; the hook hanging up: `hook_gone`; the session
// moving on without us (its tool ran, was denied, or the turn ended): `{}`; a drain: `{}`.
//
// ---------------------------------------------------------------------------
// THE AWAY HOLD (6.60.0, Miles 2026-09-30: "Yes, up to 10 min")
// ---------------------------------------------------------------------------
// A question that starts while Miles is away used to be answerable from the glasses only for
// the 110 s above, and not at all when no client was polling at that moment (`no_client`,
// `{}` at once). Now, while the desk is idle past the SAME threshold the gate above uses
// (`COS_PERMISSION_BROKER_DESK_IDLE_S`), a parked request is held up to the away hold
// (`COS_PERMISSION_BROKER_AWAY_HOLD_S`, default 600, clamped to [30, 600]; `0` turns it off,
// which turns the away hold off; a `hold=1` client still counts as live only with recent
// presence), but only when ALL of these hold:
//   - the installed hook waits longer than the 6.59.0 broker could ever hold (its 120 s
//     clamp, `AWAY_MIN_CEILING_S`). Before Install hooks it does not, and away semantics are
//     off (QA round 1, User W6). A `hold=1` client still counts as live only with recent
//     presence, so a lens untouched for 30 minutes gets no card (QA round 2, W-A);
//   - a client that shows held questions reported its WEARER present recently (Miles,
//     2026-09-30 19:54: "Hold only if the glasses or phone were connected in the last 30
//     min. A Claude Remote Control session with no glasses gets its question right away,
//     as before."). The contract shared with COS Glasses 6.9.563 (lib/client-liveness): a
//     poll `?client=glasses|phone&hold=1&presenceAgeMs=<int>`, the ms since a ring, temple or
//     lens gesture, or a phone touch while COS is in front. The worn status is never presence
//     (Glasses 6.9.570, Miles 2026-10-02: wear detection can be turned off, and then it always
//     reads not worn). Recent means within `COS_PERMISSION_BROKER_AWAY_RECENT_CLIENT_S`
//     (default 1800; below 30 s, the 30 s live window). A connected lens nobody touches sends
//     no presence; an older client sends
//     no `hold=1` and keeps the 6.59.0 liveness, never the away hold. In memory: after a
//     restart nothing is recent until such a poll.
// Held that way, a request stays answerable while no client is polling, so a lens or phone
// that comes back can still answer it. It is re-checked on every desk poll (QA round 1,
// Skeptic W2): once no client is live and the wearer's latest presence is older than the
// window, it goes to the Mac's dialog (`no_client`), so one glance never holds a question 10
// minutes. Desk activity still hands it back within one poll (1.5 s); a request that arrives
// while Miles is at the desk is still `{}` at once (`desk_active`); every path still ends.
// Every request answered `{}` is logged with why, the presence age and the window.
//
// NEVER past the hook's own wait. The hold is clamped to `holdCeilingS`: the PermissionRequest
// `timeout` in the Claude settings file (read, not assumed) and the wait the hook stamped on
// THIS request (`hookWaitS`, 6.60.0 script), whichever is less, minus 10 s; settings that
// cannot be read leave the stamp alone. A request with no stamp (the earlier script, or an
// earlier hook block) waited 130 s and its curl 125 s, so it is never held past 120 s.
// Canaries on Claude Code 2.1.286, 2026-09-30: a PermissionRequest hook configured for 630 s
// that slept 610 s was waited for and its allow applied (and 300 s / 200 s before it); one
// configured for 150 s was stopped at 150 s and the tool did not run. The script stops its
// own curl when it is stopped, so the broker sees the hook leave (`hook_gone`) at once.
//
// What a client sees: `deadlineAt` is the latest the request stays answerable (sooner if the
// wearer's presence lapses with no client live); each item says `answerable`, `awayHold` and
// `waitingAtMac`, and the questions route lists settled items (`settled`, codes only; every one
// the Mac still waits on, whatever the cap), with `serverStartedAt` and
// `waitingAtMacForgottenBefore` so a client can tell "forgot" from "moved past". `waitingAtMac`
// stays true until that request's own tool finishes or is denied, its turn ends, or its row
// reads ended: no hook marks the moment a dialog is approved, so an approved tool that is
// still running reads as waiting (the safe direction: never "not waiting" while a dialog may
// be up).
//
// NEVER: a permission RULE. `updatedPermissions` and the request's suggestions are never
// returned; the decision objects below are built from nothing but constants and the
// original input. Question and command text is never logged and never goes on the display
// bus; the client API is behind the API token. A settled item keeps its codes and what was
// chosen, never the questions or the card.

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { boundForRedaction } from './activity-preview.js'
import { inferHookProvider, toolFingerprint, SESSION_ID_RE, type HookEnvelope } from './session-hook-events.js'
import { ASK_USER_QUESTION_TOOL, type SessionSignalStore } from './session-signal-store.js'

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

/** 6.60.0: the away hold. `COS_PERMISSION_BROKER_AWAY_HOLD_S`. */
export const AWAY_HOLD_DEFAULT_S = 600
/** Miles approved "up to 10 min" (2026-09-30). The installer's hook wait (630) is sized for it. */
export const AWAY_HOLD_MAX_S = 600
export const AWAY_HOLD_MIN_S = 30

/**
 * `COS_PERMISSION_BROKER_AWAY_HOLD_S`, in ms: default 600 s, clamped to [30, 600]. `0`, `off`
 * or `false` turns the away hold off (0): the 6.59.0 broker. Junk is the default.
 */
export function permissionBrokerAwayHoldMs(env: NodeJS.ProcessEnv): number {
  const raw = (env.COS_PERMISSION_BROKER_AWAY_HOLD_S ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'off' || raw === 'false') return 0
  const parsed = Number(raw)
  const seconds = raw !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : AWAY_HOLD_DEFAULT_S
  return Math.round(Math.min(AWAY_HOLD_MAX_S, Math.max(AWAY_HOLD_MIN_S, seconds)) * 1000)
}

/** 6.60.0: how recently a client must have polled for the away hold. */
export const AWAY_RECENT_CLIENT_DEFAULT_S = 1_800
/** A day: past that, "recently connected" no longer describes anyone. */
export const AWAY_RECENT_CLIENT_MAX_S = 86_400

/**
 * `COS_PERMISSION_BROKER_AWAY_RECENT_CLIENT_S`, in ms: default 1800 s (30 min), clamped to
 * [0, 86400]. `0` means a client must be live right now (polled within the 30 s window).
 * Junk or a negative number is the default.
 */
export function permissionBrokerAwayRecentClientMs(env: NodeJS.ProcessEnv): number {
  const raw = (env.COS_PERMISSION_BROKER_AWAY_RECENT_CLIENT_S ?? '').trim()
  const parsed = Number(raw)
  const seconds = raw !== '' && Number.isFinite(parsed) && parsed >= 0 ? parsed : AWAY_RECENT_CLIENT_DEFAULT_S
  return Math.round(Math.min(AWAY_RECENT_CLIENT_MAX_S, Math.max(0, seconds)) * 1000)
}

/** 6.60.0: Claude Code's wait on every PermissionRequest hook before 6.60.0 (its curl: 125). */
export const LEGACY_HOOK_WAIT_S = 130
/**
 * 6.60.0: the broker answers this far inside the hook's own wait: 5 s for the script's curl
 * to give up before Claude Code stops the hook, 5 s more so `{}` lands before curl gives up.
 * The 130 / 125 / 120 chain every release since 6.52.0 has kept.
 */
export const HOOK_REPLY_MARGIN_S = 10
/** A `hookWaitS` stamp outside this range is not one the installer writes: no stamp. */
export const HOOK_WAIT_STAMP_MAX_S = 3_600

/**
 * 6.60.0: the longest a request may be held, in seconds, from the hook's own start.
 * `installedHookTimeoutS` is our PermissionRequest `timeout` in the Claude settings file, or
 * null when that cannot be read (missing, unparseable, a symlink, no block of ours).
 * `hookWaitS` is the wait this invocation stamped (the 6.60.0 script passes its block's
 * timeout); none means an earlier hook, 130. The lesser of the two, minus the margin. With
 * the settings unreadable, the stamp alone minus the margin (QA round 1, N4), and an
 * unstamped request the old safe clamp, 120: an unstamped request is never held past 120.
 * Never negative: a ceiling at or below zero is `stale_hook`.
 */
export function holdCeilingS(installedHookTimeoutS: number | null, hookWaitS: number | null): number {
  const hasStamp = hookWaitS !== null && Number.isFinite(hookWaitS) && hookWaitS > 0
  if (installedHookTimeoutS === null || !Number.isFinite(installedHookTimeoutS) || installedHookTimeoutS <= 0) {
    // QA round 1 (N4): unreadable settings. The stamp is this invocation's own wait, so it
    // still bounds the hold; with no stamp, the old safe clamp, never more than 120.
    return hasStamp ? Math.max(0, hookWaitS! - HOOK_REPLY_MARGIN_S) : BROKER_TIMEOUT_MAX_S
  }
  const stamped = hasStamp ? hookWaitS! : LEGACY_HOOK_WAIT_S
  return Math.max(0, Math.min(installedHookTimeoutS, stamped) - HOOK_REPLY_MARGIN_S)
}

/**
 * A client must have polled `GET /api/session-questions?client=glasses|phone` this recently,
 * at admission AND while anything is held (QA round 1: 60 s let a phone that locked hold a
 * question nobody could see for a minute). Three polls at the advertised interval.
 */
export const CLIENT_LIVE_WINDOW_MS = 30_000
/** The poll interval the questions route advertises to clients. */
export const QUESTIONS_POLL_INTERVAL_MS = 10_000
/** A poll stamp this far AHEAD of the server clock (the clock stepped back) is not trusted. */
export const POLL_FUTURE_SKEW_MS = 5_000
/** The `client` values of a questions poll that count as a live answerer. */
export const ANSWERING_CLIENTS: ReadonlySet<string> = new Set(['glasses', 'phone'])
/** The questions API's own version, advertised at /api/models. */
export const SESSION_QUESTIONS_PROTOCOL_VERSION = 1
/** How often a parked item re-reads the desk. */
export const DESK_POLL_MS = 1_500
/** Never hold a request for a desk idle less than this, whatever the setting says. */
export const DESK_IDLE_MIN_S = 30
/** Parked items at once; past it, `{}`. Checked again after the desk read. */
export const MAX_PENDING = 32
/** A settled item is kept this long so a late answer gets the right code and a retry its replay. */
export const SETTLED_RETENTION_MS = 10 * 60_000
/**
 * 6.60.0: a settled item still waiting at the Mac (`waitingAtMac`) is kept this long, so a
 * client can keep saying the Mac is waiting until Miles is back. Bounded: an event the spool
 * never delivered must not leave it waiting forever.
 */
export const MAC_WAIT_RETENTION_MS = 60 * 60_000
/**
 * 6.60.0 (QA round 1, Ghost Hunter W1): while the session's own row still waits on that very
 * request (`stillWaitingAtMac`), it is kept up to this long instead of the hour.
 */
export const MAC_WAIT_MAX_RETENTION_MS = 24 * 60 * 60_000
export const MAX_SETTLED = 256
/** 6.60.0: at most this many settled items in a questions listing, newest first. */
export const SETTLED_LIST_MAX = 32
/** Free text for "Other". */
export const OTHER_TEXT_MAX = 2_000
/** The approval card's short line: the command (or path, URL, query) as the lens shows it. */
export const APPROVAL_SUMMARY_MAX = 160
/** The full command, one page back on the lens. */
export const APPROVAL_DETAIL_MAX = 4_000
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
  /**
   * 6.60.0: the envelope's `hookWaitS`, the hook block's own `timeout` as the 6.60.0 script
   * received it (its second argument). Null for an earlier script or block: `holdCeilingS`.
   */
  hookWaitS: number | null
  /**
   * 6.62.0 (plan 3.10): the engine that asked, from the envelope's stamp (the Codex command
   * writes one) or the payload. Cursor never reaches here (`cursor` refusal above).
   */
  provider?: 'claude' | 'codex'
}

export type EnvelopeVerdict =
  | { ok: true; facts: PermissionRequestFacts }
  | { ok: false; reason: 'malformed' | 'cursor' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

type EnvelopeRead =
  | { ok: true; facts: Omit<PermissionRequestFacts, 'fingerprint'> }
  | { ok: false; reason: 'malformed' | 'cursor' }

/** The envelope's structure only: no hashing, no regex over the input. */
function readPermissionRequestEnvelope(body: unknown): EnvelopeRead {
  if (!isRecord(body) || body.event !== 'PermissionRequest' || !isRecord(body.payload)) return { ok: false, reason: 'malformed' }
  const p = body.payload
  if ('cursor_version' in p) return { ok: false, reason: 'cursor' }
  if (typeof p.session_id !== 'string' || !SESSION_ID_RE.test(p.session_id)) return { ok: false, reason: 'malformed' }
  if (typeof p.tool_name !== 'string' || p.tool_name.trim().length === 0) return { ok: false, reason: 'malformed' }
  if (!isRecord(p.tool_input)) return { ok: false, reason: 'malformed' }
  const ts = typeof body.ts === 'number' && Number.isFinite(body.ts) ? body.ts : null
  const wait = body.hookWaitS
  const hookWaitS = typeof wait === 'number' && Number.isInteger(wait) && wait > 0 && wait <= HOOK_WAIT_STAMP_MAX_S ? wait : null
  return {
    ok: true,
    facts: { sessionId: p.session_id.toLowerCase(), toolName: p.tool_name, toolInput: p.tool_input, hookStartedAtMs: ts, hookWaitS, provider: inferHookProvider(body.provider, p) === 'codex' ? 'codex' : 'claude' },
  }
}

/**
 * The spool envelope the hook posts (`{"ts","ppid","event","payload"}`), read strictly.
 * Cursor stamps every hook payload with `cursor_version` and Claude Code never does, so
 * the key's presence, in any form, is a Cursor request. The broker itself reads the
 * structure first and fingerprints only a request it will park.
 */
export function parsePermissionRequestEnvelope(body: unknown): EnvelopeVerdict {
  const read = readPermissionRequestEnvelope(body)
  if (!read.ok) return read
  return { ok: true, facts: { ...read.facts, fingerprint: toolFingerprint(read.facts.toolName, read.facts.toolInput) } }
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
 * here (no questions, an option without a label, two questions with the same text:
 * answers are keyed by the text, so two alike could never both be answered; or two options
 * of one question with the same label: an answer names an option by its label, so the two
 * could never be told apart, and picking both is refused as a duplicate). Null is the
 * `unsupported_input` fast path: `{}` and the Mac's own dialog, never a held card.
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
    const labels = new Set<string>()
    for (const o of q.options) {
      if (!isRecord(o) || typeof o.label !== 'string' || o.label.length === 0) return null
      if (labels.has(o.label)) return null
      labels.add(o.label)
      options.push({ label: o.label, description: typeof o.description === 'string' ? o.description : '' })
    }
    questions.push({ question: q.question, header: typeof q.header === 'string' ? q.header : '', multiSelect: q.multiSelect === true, options })
  }
  return questions
}

/**
 * The one change made to "Other" free text, measured (canary, 2026-09-19): Claude Code
 * joins a list answer with commas in the text the model reads, so `["Red","Blue","Purple,
 * but only on weekends"]` reached the model as `Red,Blue,Purple, but only on weekends` and
 * the model dropped "but only on weekends". Free text that contains a comma is wrapped in
 * double quotes, which keeps it one answer in that text. Option labels are never touched.
 */
export function quoteFreeTextAnswer(text: string): string {
  return text.includes(',') ? `"${text}"` : text
}

export type AnswerValidation =
  | { ok: true; answers: Record<string, string[]> }
  | { ok: false; reason: 'answers_shape' | 'unanswered' | 'unknown_label' | 'duplicate_label' | 'too_many' | 'other_too_long'; index?: number }

/**
 * A client's answers, one entry per question in order: `{ labels?: string[], other?: string }`.
 * Every question must be answered. Labels must match one of that question's options
 * EXACTLY (the client shows a sanitized copy and sends the original back). `other` is the
 * free text of the card's "Other" choice, sent as its own entry. Single-select takes
 * exactly one entry. The result is keyed by each question's ORIGINAL text, labels in option
 * order, "Other" last: the shape Claude Desktop sends.
 * Free text goes through `quoteFreeTextAnswer`.
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
    if (other.trim().length > 0) list.push(quoteFreeTextAnswer(other))
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

/** 6.53.0: the message a held prompt gets when its session's run is cancelled from COS. */
export const CANCEL_DENY_MESSAGE = 'Cancelled from COS'

/**
 * 6.53.0: a held prompt whose run was cancelled from the lens. Deny with `interrupt: true`,
 * so Claude ends the RUN rather than trying something else in place of this tool. The one
 * case where a broker reply interrupts, and only ever from `cancelSession`.
 *
 * 6.62.0 (W20, C2): never for Codex. Its PermissionRequest refuses `interrupt` (it fails
 * closed on the field), so a Codex prompt gets the plain deny; the halt marker stops the run
 * at its next command.
 */
export function cancelHookOutput(provider: 'claude' | 'codex' = 'claude'): Record<string, unknown> {
  const decision = provider === 'codex'
    ? { behavior: 'deny', message: CANCEL_DENY_MESSAGE }
    : { behavior: 'deny', message: CANCEL_DENY_MESSAGE, interrupt: true }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
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
  /** What will run, as the lens shows it: the command verbatim, the full path, the URL. */
  summary: string
  /** The same, longer (up to APPROVAL_DETAIL_MAX). The lens puts it one page back. */
  detail: string
}

const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'shell', 'exec', 'exec_command'])
const FILE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'multiedit', 'notebookedit'])

/**
 * Approval text as the lens and phone draw it (6.52.0 QA round 2). Nothing is dropped and
 * nothing is merged: a line break is shown as a literal `\n` between spaces, so a second
 * command can never read as arguments of the first; any other control character is shown as
 * `\xNN`. EVERY other character outside printable ASCII (0x20 to 0x7e) is shown as
 * `\uNNNN`, one per UTF-16 unit (6.52.0 app QA): a bidirectional override or a zero-width
 * character cannot reorder or hide part of a command, and a curly quote, a dash, an ellipsis
 * or an emoji cannot be drawn as the ASCII character a lens font substitutes for it. Curly
 * quotes are not shell quotes, so `echo <curly>; curl ... | bash;<curly>` runs the curl; drawn as
 * straight quotes it would read as a harmless echo. Remaining whitespace runs (spaces and
 * tabs) become one space.
 */
export function visibleApprovalText(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, ' \\n ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(/[^\x00-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/[\t\u00a0\s]+/g, ' ')
    .trim()
}

type ApprovalRedaction = 'command' | 'path' | 'url'

const PROVIDER_TOKEN_RE = /\b(?:sk-(?:proj-|live-|test-|ant-)?|sk_(?:live|test)_|sess-|pat-|gh[pousr]_|github_pat_|glpat-|npm_|pypi-|shpat_|xox[baprs]-)[A-Za-z0-9._-]{8,}\b/gi
const AWS_KEY_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g
const GOOGLE_KEY_RE = /\bAIza[A-Za-z0-9_-]{30,}\b/g
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const PEM_MARKER_RE = /-----(?:BEGIN|END) [A-Z0-9 ]{0,40}(?:PRIVATE KEY|CREDENTIALS?)-----/gi
const SECRET_KEY = '(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|access[_-]?token|refresh[_-]?token|session[_-]?token|token|credential|auth(?:orization)?|password|passwd|pwd|secret|client[_-]?secret|private[_-]?key|database[_-]?url|connection[_-]?string|dsn|session(?:[_-]?id)?|cookie|phpsessid|jsessionid|sid)'
// Inside ONE piece only. The value stops at a quote, a slash or a comma, so a match can
// never reach past the piece it sits in (6.52.0 QA round 2: the shared patterns' quoted
// values ran across `&&`, `;` and `|` and swallowed whole commands).
const PIECE_ASSIGN_RE = new RegExp(`\\b((?:[a-z0-9]+[_-])*${SECRET_KEY}(?:[_-][a-z0-9]+)*["']?[:=])(["']?)([^"'/,]+)`, 'gi')
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]*:[^\s/@]+@/gi
const URL_QUERY_SECRET_RE = /([?&](?:api[_-]?key|access[_-]?token|token|auth|password|secret)=)[^&#\s]+/gi
// A flag or scheme word whose NEXT piece is the credential.
const SECRET_NEXT_PIECE_RE = /^(?:--?(?:api-key|token|access-token|refresh-token|password|passwd|secret|client-secret)|-u|--user|["']?(?:bearer|basic|digest)|["']?(?:set-)?cookie:)$/i
const BASE64ISH_RE = /^["']?[A-Za-z0-9+/=]{24,}["']?$/

function redactProviderTokens(text: string): string {
  return text
    .replace(PROVIDER_TOKEN_RE, '[redacted-token]')
    .replace(AWS_KEY_RE, '[redacted-aws-key]')
    .replace(GOOGLE_KEY_RE, '[redacted-google-key]')
    .replace(JWT_RE, '[redacted-jwt]')
}

/** Keep a piece's own quotes and hide what they hold. */
function redactWholePiece(piece: string): string {
  const m = /^(["']?)(.*?)(["']?)$/.exec(piece)
  return m && m[2] ? `${m[1]}[redacted]${m[3]}` : piece
}

/**
 * Secrets out of approval text, and never anything else (6.52.0 QA round 2). A command is
 * split into pieces at whitespace and at `;`, `&` and `|`, which are kept as written; every
 * redaction happens INSIDE one piece, so it can hide a credential but never a command,
 * a pipe or an argument after it. A path keeps everything but provider tokens. A URL also
 * loses its userinfo and secret query values.
 */
export function redactApprovalText(text: string, mode: ApprovalRedaction): string {
  if (mode === 'path') return redactProviderTokens(text)
  if (mode === 'url') return redactProviderTokens(text.replace(URL_USERINFO_RE, '$1[redacted]@').replace(URL_QUERY_SECRET_RE, '$1[redacted]'))
  const sawPem = PEM_MARKER_RE.test(text)
  PEM_MARKER_RE.lastIndex = 0
  const marked = text.replace(PEM_MARKER_RE, '[redacted-private-material]')
  const parts = marked.split(/(\s+|&&|\|\||[;&|])/)
  let previous = ''
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (i % 2 === 1 || part === '') continue
    let piece = part
    if (SECRET_NEXT_PIECE_RE.test(previous)) piece = redactWholePiece(piece)
    else if (sawPem && BASE64ISH_RE.test(piece)) piece = redactWholePiece(piece)
    else {
      piece = piece.replace(URL_USERINFO_RE, '$1[redacted]@')
      piece = piece.replace(PIECE_ASSIGN_RE, (_m, key: string, quote: string) => `${key}${quote}[redacted]`)
      piece = redactProviderTokens(piece)
    }
    parts[i] = piece
    previous = part
  }
  return parts.join('')
}

/** The marker a cut line ends with, naming how much is not shown. */
export function approvalCutMarker(omitted: number): string {
  return ` ...(+${omitted} chars)`
}

/**
 * What an approval line says when the call gives it nothing to show (6.52.0 app QA): never
 * an empty line, so a client never has to drop an item it cannot draw.
 */
export const APPROVAL_EMPTY_COMMAND = '(empty command)'
export const APPROVAL_EMPTY_PATH = '(empty path)'
export const APPROVAL_NO_INPUT = '(no input)'

/**
 * One approval line from raw text: made visible (line breaks and hidden characters shown),
 * then redacted with the approval redactor, then cut at `max` with the marker. Only
 * REDACTION_SCAN_MAX_CHARS reach a regex, ended at a token boundary, so no input can make
 * it slow and no secret straddling that bound is shown half. Nothing to show (an empty or
 * whitespace-only value) is `empty`, never ''.
 */
function approvalLine(raw: string, max: number, mode: ApprovalRedaction = 'command', empty: string = APPROVAL_NO_INPUT): string {
  const { head, omitted } = boundForRedaction(raw)
  const text = redactApprovalText(visibleApprovalText(head), mode)
  if (text.length === 0 && omitted === 0) return empty
  if (text.length <= max && omitted === 0) return text
  const shown = text.slice(0, max)
  return shown + approvalCutMarker(text.length - shown.length + omitted)
}

function lineCount(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0) return 0
  return value.replace(/\n$/, '').split('\n').length
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** How big a file change is, from the call itself. */
function fileChangeSize(lower: string, input: Record<string, unknown>): string {
  if (lower === 'write') {
    const content = typeof input.content === 'string' ? input.content : ''
    return `${plural(lineCount(content), 'line')}, ${plural(content.length, 'char')}`
  }
  if (lower === 'edit') {
    const all = input.replace_all === true ? ', every match' : ''
    return `+${lineCount(input.new_string)} -${lineCount(input.old_string)} lines${all}`
  }
  if (lower === 'multiedit') {
    const edits = Array.isArray(input.edits) ? input.edits.length : 0
    return plural(edits, 'edit')
  }
  // NotebookEdit. The mode is the call's own text: shown like the rest of the card (every
  // character outside printable ASCII escaped) and cut short, never drawn raw.
  const mode = typeof input.edit_mode === 'string' && input.edit_mode.length > 0 ? approvalLine(input.edit_mode, 40, 'path') : 'replace'
  return `${mode}, ${plural(lineCount(input.new_source), 'line')}`
}

/** A value as the card shows it: a string as written, anything else as JSON. */
function valueText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * What the lens and phone show for an approval (6.52.0 QA round 1).
 *
 * THE RULE: the card never says less than what will run. Round 1 reused the Sessions
 * display shorteners and they misstated it: `git status | tail -3 && git push --force
 * origin main` read "git status", `ls | head -1; curl ... | sh` read "ls| sh", any path of
 * 40+ characters read "[opaque output hidden]", and WebFetch showed its prompt. So:
 *   - a shell command: verbatim, whitespace-normalized, every segment, pipe and `&&` part;
 *   - Write, Edit, MultiEdit, NotebookEdit: the full path, then the size or line count;
 *   - WebFetch: the URL. WebSearch: the query;
 *   - anything else: its input keys and values in order (the card's `tool` names it).
 * A call with nothing to show still has a line (6.52.0 app QA): `(empty command)` for an
 * empty or blank command, `(empty path)` for an empty path, `(no input)` otherwise (`{}`).
 * A line longer than its cap is cut there and ends with ` ...(+N chars)`. The only thing
 * taken out is a secret, by `redactApprovalText`, which works inside one piece of the
 * command at a time (round 2: the shared patterns swallowed `&& git push --force`), never
 * the opaque-output heuristic, which hid ordinary paths.
 */
export function approvalCard(toolName: string, toolInput: Record<string, unknown>): ApprovalCard {
  const lower = toolName.trim().toLowerCase()
  const str = (key: string): string | null => typeof toolInput[key] === 'string' ? toolInput[key] as string : null
  const both = (text: string, mode: ApprovalRedaction = 'command', empty: string = APPROVAL_NO_INPUT): ApprovalCard => ({
    tool: toolName,
    summary: approvalLine(text, APPROVAL_SUMMARY_MAX, mode, empty),
    detail: approvalLine(text, APPROVAL_DETAIL_MAX, mode, empty),
  })
  if (SHELL_TOOLS.has(lower)) {
    const command = str('command') ?? str('cmd')
    if (command !== null) return both(command, 'command', APPROVAL_EMPTY_COMMAND)
  }
  if (FILE_TOOLS.has(lower)) {
    const path = str('file_path') ?? str('notebook_path') ?? str('path')
    if (path !== null) {
      const size = ` (${fileChangeSize(lower, toolInput)})`
      return {
        tool: toolName,
        summary: approvalLine(path, APPROVAL_SUMMARY_MAX, 'path', APPROVAL_EMPTY_PATH) + size,
        detail: approvalLine(path, APPROVAL_DETAIL_MAX, 'path', APPROVAL_EMPTY_PATH) + size,
      }
    }
  }
  if (lower === 'webfetch' && str('url') !== null) return both(str('url')!, 'url')
  if (lower === 'websearch' && str('query') !== null) return both(str('query')!)
  // `approvalLine` bounds what reaches a regex, so a huge value costs a join, not a scan.
  return both(Object.entries(toolInput).map(([key, value]) => `${key}=${valueText(value)}`).join(' '))
}

// ---------------------------------------------------------------------------
// The broker
// ---------------------------------------------------------------------------

export type BrokerItemKind = 'question' | 'approval'
export type BrokerResolution = 'answered' | 'handed_to_desk' | 'expired' | 'hook_gone' | 'retracted' | 'drained' | 'no_client'
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
  /**
   * The newest counting `GET /api/session-questions`, or null (lib/client-liveness). The
   * 6.59.0 liveness reads it when `lastLegacyPollAt` is absent.
   */
  lastQuestionsPollAt(): number | null
  /**
   * 6.60.0: the newest counting poll WITHOUT `hold=1`, the 6.59.0 liveness for every older
   * client (`lastLegacyQuestionsPollAt`). Absent: `lastQuestionsPollAt`.
   */
  lastLegacyPollAt?(): number | null
  /** 6.60.0: the newest counting poll WITH `hold=1` (`lastHoldQuestionsPollAt`). Absent: none. */
  lastHoldPollAt?(): number | null
  readDeskIdleSeconds(): Promise<number | null>
  deskIdleSeconds(): number
  timeoutMs(): number
  /** 6.60.0: the away hold in ms, 0 for off (`permissionBrokerAwayHoldMs`). Absent: off. */
  awayHoldMs?(): number
  /**
   * 6.60.0: our PermissionRequest hook's `timeout` in the Claude settings file, or null when it
   * cannot be read. Absent: null, the old safe clamp (`holdCeilingS`).
   */
  installedHookTimeoutS?(): number | null
  /**
   * 6.60.0: how long ago the newest QUALIFYING wearer presence was (a `hold=1` poll with a
   * valid `presenceAgeMs`), or null when there is none since boot (`presenceAgeMs`,
   * lib/client-liveness). Absent: null.
   */
  presenceAgeMs?(): number | null
  /**
   * 6.60.0: how recent that presence must be for the away hold, in ms
   * (`permissionBrokerAwayRecentClientMs`), never below the 30 s live window. Absent: 30 s.
   */
  awayRecentClientMs?(): number
  /**
   * 6.60.0: the session's row still waits on exactly this request (its hook signal is
   * waiting, on this fingerprint, and not ended). Keeps a waiting-at-the-Mac item past the
   * hour. Absent: false.
   */
  stillWaitingAtMac?(sessionId: string, fingerprint: string): boolean
  signals?: BrokerSignalSink
  pollMs?: number
  newId?: () => string
  log?: (line: string) => void
}

/** 6.60.0: how a parked request's deadline was decided, logged once per request. Numbers only. */
export interface HoldFacts {
  /** Our PermissionRequest `timeout` in the Claude settings file, or null (unreadable). */
  installedHookTimeoutS: number | null
  /** The wait this hook invocation stamped, or null (an earlier script or block). */
  hookWaitS: number | null
  /** The away hold in seconds; 0 when it is off. */
  awayHoldS: number
  /** `holdCeilingS(installedHookTimeoutS, hookWaitS)`. */
  ceilingS: number
  /** The hold, from the hook's own start to the deadline, in seconds. */
  effectiveDeadlineS: number
  /** The desk's idle time at admission, in ms. */
  deskIdleMs: number | null
  /** A client that can answer was live at admission (6.59.0 liveness, or a `hold=1` client with recent presence). */
  clientLive: boolean
  /** 6.60.0: the age of the newest qualifying wearer presence; null for none since boot. */
  presenceAgeMs: number | null
  /** 6.60.0: how recent that presence had to be, in seconds. */
  recentWindowS: number
  /** 6.60.0: why this request is not away-held, or null when it is. */
  notAwayReason: NotAwayReason | null
}

/**
 * 6.60.0: why a request is not held by the away hold (logged once per decision):
 * `hold_off` the switch is 0; `ceiling_at_base` the installed hook waits no longer than the
 * 6.59.0 broker could hold (Install hooks not run); `no_hold_client` no `hold=1` client has
 * reported wearer presence since boot; `stale_presence` its latest presence is older than the
 * window; `desk_active` Miles is at the Mac.
 */
export type NotAwayReason = 'hold_off' | 'ceiling_at_base' | 'no_hold_client' | 'stale_presence' | 'desk_active'

/**
 * 6.60.0: the away hold needs a hook that waits longer than the 6.59.0 broker could ever hold
 * (its 120 s clamp). At or below that, before Install hooks, away semantics are off entirely
 * and the broker is 6.59.0 (QA round 1, W6).
 */
export const AWAY_MIN_CEILING_S = BROKER_TIMEOUT_MAX_S

export interface ParkRequest {
  facts: PermissionRequestFacts
  kind: BrokerItemKind
  questions: BrokerQuestion[] | null
  approval: ApprovalCard | null
  deadlineAt: number
  /**
   * 6.60.0: held by the away hold: a client going quiet does not hand it back (desk activity
   * still does). False with the away hold off, or for a request built without it.
   */
  awayHold?: boolean
  hold?: HoldFacts
}

export type BrokerAdmission = { ok: true; request: ParkRequest } | { ok: false; reason: BrokerFastPath }

type Chosen = { answers: Record<string, string[]> } | { decision: 'allow' | 'deny' }

interface BrokerItem {
  id: string
  sessionId: string
  /** 6.62.0: the engine that asked (plan 3.10); every view says it. */
  provider: 'claude' | 'codex'
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
  /** The clientAnswerId of the "Leave for the Mac" that settled it, so its retry replays. */
  handedBackBy: string | null
  channel: HookReplyChannel | null
  timer: ReturnType<typeof setTimeout> | null
  /** 6.60.0: held by the away hold (`ParkRequest.awayHold`). */
  awayHold: boolean
  /**
   * 6.60.0: settled with `{}` written to the hook (handed to the desk, expired, no client,
   * drained), so the Mac's own dialog is showing, and the session has not moved past the
   * request since (`sessionMovedPast`).
   */
  waitingAtMac: boolean
}

export interface SessionQuestionView {
  id: string
  sessionId: string
  provider: 'claude' | 'codex'
  kind: BrokerItemKind
  tool: string
  createdAt: string
  /** When it stops being answerable from here. 6.60.0: the away hold's deadline when held by it. */
  deadlineAt: string
  questions?: BrokerQuestion[]
  approval?: ApprovalCard
  /** 6.60.0: an answer posted now still reaches the session. Always true for a pending item. */
  answerable: boolean
  /** 6.60.0: held by the away hold: it stays answerable while no client polls, until `deadlineAt` or the desk. */
  awayHold: boolean
  /** 6.60.0: handed to the Mac's own dialog and still waiting there. Always false for a pending item. */
  waitingAtMac: boolean
}

/**
 * 6.60.0: a settled item as the questions route lists it (`settled`): codes and times only,
 * never the questions, the card, or what was chosen.
 */
export interface SettledQuestionView {
  id: string
  sessionId: string
  provider: 'claude' | 'codex'
  kind: BrokerItemKind
  tool: string
  createdAt: string
  deadlineAt: string
  settledAt: string
  resolution: BrokerResolution
  /** Always false: a settled item takes no answer. */
  answerable: false
  awayHold: boolean
  /**
   * The broker gave the hook `{}`, so the Mac's own dialog showed, and the session has not
   * moved past the request since: its tool has not run nor been denied, its turn has not
   * ended. A client can say the Mac is waiting on an answer.
   */
  waitingAtMac: boolean
}

/** 6.60.0: the resolutions that write `{}` to a listening hook, so the Mac's dialog shows. */
const MAC_DIALOG_RESOLUTIONS: ReadonlySet<BrokerResolution> = new Set(['handed_to_desk', 'expired', 'no_client', 'drained'])

/**
 * `/api/health`'s `permissionBroker`. Counts, the mode and two timestamps: never an id,
 * a question, a command, or how many are held right now (that is on the authenticated
 * questions route). Every key is camelCase; the reason CODES keep their wire spelling.
 */
export interface PermissionBrokerHealth {
  enabled: boolean
  mode: BrokerMode
  counters: {
    parked: number
    answered: number
    handedToDesk: number
    /** Of `handedToDesk`, those a client handed back ("Leave for the Mac"). */
    handedBack: number
    expired: number
    hookGone: number
    retracted: number
    drained: number
    noClient: number
    /** An answer refused 400 `invalid_answer`. */
    invalidAnswer: number
    /** A desk read that failed while something was held. */
    deskUnreadable: number
    /** 6.60.0: of `parked`, those held by the away hold. */
    awayHeld: number
    /** 6.60.0: of `parked`, those parked while no client that can answer was polling. */
    parkedWithoutClient: number
    /** Requests answered `{}` without being parked, keyed by the camelCase of the reason. */
    fastPath: Record<string, number>
  }
  lastFastPath: BrokerFastPath | null
  lastFastPathAt: string | null
  lastQuestionsPollAt: string | null
}

type ResolutionCounter = 'handedToDesk' | 'expired' | 'hookGone' | 'retracted' | 'drained' | 'noClient'
const RESOLUTION_COUNTER: Record<Exclude<BrokerResolution, 'answered'>, ResolutionCounter> = {
  handed_to_desk: 'handedToDesk',
  expired: 'expired',
  hook_gone: 'hookGone',
  retracted: 'retracted',
  drained: 'drained',
  no_client: 'noClient',
}

function camelKey(code: string): string {
  return code.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())
}

function isoOrNull(ms: number | null): string | null {
  return ms !== null && Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

export interface AnswerResult { status: number; body: Record<string, unknown> }

export const BROKER_ID_RE = /^pq_[0-9a-f]{24}$/
export const CLIENT_ANSWER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** Events that end the turn a request was part of: every held request of the session is moot. */
const TURN_BOUNDARIES: ReadonlySet<string> = new Set(['Stop', 'StopFailure', 'SessionEnd', 'UserPromptSubmit'])

/**
 * The session moved past a request without the broker: its turn ended (or a new session
 * started over it), or its own tool ran or was denied, which means the Mac's dialog was
 * answered. For a pending item that is a retraction; for one handed to the Mac (6.60.0) it
 * means the Mac is no longer waiting on it. A question's tool is AskUserQuestion; an
 * approval matches by fingerprint, or by tool name for a denial.
 */
function sessionMovedPast(item: Pick<BrokerItem, 'kind' | 'fingerprint' | 'toolName'>, env: HookEnvelope, toolName: string, fingerprint: string, strict = false): boolean {
  if (TURN_BOUNDARIES.has(env.event) || (env.event === 'SessionStart' && env.payload.source !== 'compact')) return true
  if (env.event === 'PostToolUse' || env.event === 'PostToolUseFailure' || env.event === 'PermissionDenied') {
    // `strict` (QA round 1, N3), for "the Mac is no longer waiting": an approval only by its
    // own fingerprint, never by a denial of the same tool name, which may be another dialog
    // of the same session still on screen.
    if (item.kind === 'question') return toolName === ASK_USER_QUESTION_TOOL
    if (strict) return fingerprint === item.fingerprint
    return fingerprint === item.fingerprint || (env.event === 'PermissionDenied' && toolName === item.toolName)
  }
  return false
}

export class PermissionBroker {
  private readonly deps: PermissionBrokerDeps
  private readonly items = new Map<string, BrokerItem>()
  private poll: ReturnType<typeof setInterval> | null = null
  private pollInFlight = false
  /** Failed desk reads in a row while something is held. Two hand everything back. */
  private deskUnreadableStreak = 0
  private readonly counters = { parked: 0, answered: 0, handedToDesk: 0, handedBack: 0, expired: 0, hookGone: 0, retracted: 0, drained: 0, noClient: 0, invalidAnswer: 0, deskUnreadable: 0, awayHeld: 0, parkedWithoutClient: 0 }
  private readonly fastPaths: Record<string, number> = {}
  private lastFastPath: BrokerFastPath | null = null
  private lastFastPathAt: number | null = null

  /**
   * 6.60.0 (QA round 1, Ghost Hunter W1): the server cannot know about a waiting-at-the-Mac
   * item settled at or before this time: it started then, or it later dropped one that was
   * still waiting. Never moves back.
   */
  private waitingForgottenBefore: number

  constructor(deps: PermissionBrokerDeps) {
    this.deps = deps
    this.waitingForgottenBefore = deps.now()
  }

  /** 6.60.0: `waitingAtMacForgottenBefore` on the questions route, in ms. */
  waitingAtMacForgottenBeforeMs(): number {
    return this.waitingForgottenBefore
  }

  private log(line: string): void {
    try { (this.deps.log ?? console.log)(`[permission-broker] ${line}`) } catch { /* logging never breaks a hook */ }
  }

  /** A request answered `{}` without being parked, counted by why. */
  noteFastPath(reason: BrokerFastPath, context: { notAway?: NotAwayReason; presence?: { ageMs: number | null; windowMs: number }; clientLive?: boolean } = {}): { ok: false; reason: BrokerFastPath } {
    const key = camelKey(reason)
    this.fastPaths[key] = (this.fastPaths[key] ?? 0) + 1
    this.lastFastPath = reason
    this.lastFastPathAt = this.deps.now()
    // 6.60.0 (QA round 1, Completionist N9, Ghost Hunter W5): one line per request answered
    // `{}`, with why, how old the wearer's presence is and the window. Numbers only.
    let presence = context.presence
    if (!presence) { try { presence = this.presence(this.deps.now()) } catch { presence = undefined } }
    const age = presence?.ageMs === null || presence?.ageMs === undefined ? 'null' : String(Math.round(presence.ageMs))
    this.log(`fast path ${reason}${context.notAway ? ` not_away=${context.notAway}` : ''} presenceAgeMs=${age} windowMs=${presence?.windowMs ?? 'null'}${context.clientLive === undefined ? '' : ` clientLive=${context.clientLive}`}`)
    return { ok: false, reason }
  }

  /**
   * A client that can answer has polled within the window. A stamp more than
   * POLL_FUTURE_SKEW_MS ahead of the clock (the clock stepped back) is stale, not live
   * forever.
   */
  private clientLive(now: number): boolean {
    // 6.60.0: the 6.59.0 liveness is a poll WITHOUT `hold=1` (every older client).
    const legacy = this.deps.lastLegacyPollAt
    return this.polledWithin(legacy ? legacy() : this.deps.lastQuestionsPollAt(), now)
  }

  /** A poll stamp within the live window, and not more than the skew ahead of the clock. */
  private polledWithin(polledAt: number | null | undefined, now: number): boolean {
    if (polledAt === null || polledAt === undefined || !Number.isFinite(polledAt)) return false
    if (polledAt - now > POLL_FUTURE_SKEW_MS) return false
    return now - polledAt <= CLIENT_LIVE_WINDOW_MS
  }

  /** 6.60.0: the away hold in ms; 0 when off, absent, or unreadable. */
  private awayHoldMs(): number {
    let ms = 0
    try { ms = Number(this.deps.awayHoldMs?.() ?? 0) } catch { ms = 0 }
    return Number.isFinite(ms) && ms > 0 ? ms : 0
  }

  /** 6.60.0: the recent-presence window in ms, never below the 30 s live window. */
  private recentWindowMs(): number {
    let ms = 0
    try { ms = Number(this.deps.awayRecentClientMs?.() ?? 0) } catch { ms = 0 }
    return Math.max(CLIENT_LIVE_WINDOW_MS, Number.isFinite(ms) && ms > 0 ? ms : 0)
  }

  /**
   * 6.60.0: the newest qualifying wearer presence and what it allows, read now:
   *   - `recent`: within the window, so the away hold may apply;
   *   - `holdLive`: a `hold=1` client polled within the live window AND its presence is
   *     recent, so it counts as a live client the way an older client's poll does. A
   *     connected lens nobody touches never counts (QA round 1, Skeptic W1).
   */
  private presence(now: number): { ageMs: number | null; recent: boolean; holdLive: boolean; windowMs: number } {
    let ageMs: number | null = null
    try { ageMs = this.deps.presenceAgeMs?.() ?? null } catch { ageMs = null }
    if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) ageMs = null
    const windowMs = this.recentWindowMs()
    const recent = ageMs !== null && ageMs <= windowMs
    let holdPollAt: number | null = null
    try { holdPollAt = this.deps.lastHoldPollAt?.() ?? null } catch { holdPollAt = null }
    return { ageMs, recent, holdLive: recent && this.polledWithin(holdPollAt, now), windowMs }
  }

  /** 6.60.0: the installed hook timeout, or null when absent or unreadable. */
  private installedHookTimeoutS(): number | null {
    let value: number | null = null
    try { value = this.deps.installedHookTimeoutS?.() ?? null } catch { value = null }
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
  }

  /**
   * 6.60.0: how long a request arriving now, from a hook that stamped `hookWaitS`, may be held:
   * the away hold when it applies (never shorter than the base timeout), else the base
   * timeout, and never past `holdCeilingS`. `ceilingAllowsAway` is the hook waiting longer
   * than the 6.59.0 broker could hold.
   */
  private holdMs(hookWaitS: number | null, away: boolean): { holdMs: number; awayHoldMs: number; installedHookTimeoutS: number | null; ceilingS: number; ceilingAllowsAway: boolean } {
    const awayHoldMs = away ? this.awayHoldMs() : 0
    const installedHookTimeoutS = this.installedHookTimeoutS()
    const ceilingS = holdCeilingS(installedHookTimeoutS, hookWaitS)
    const baseMs = this.deps.timeoutMs()
    const wanted = awayHoldMs > 0 ? Math.max(baseMs, awayHoldMs) : baseMs
    return { holdMs: Math.min(wanted, ceilingS * 1000), awayHoldMs, installedHookTimeoutS, ceilingS, ceilingAllowsAway: ceilingS > AWAY_MIN_CEILING_S }
  }

  /** 6.60.0: the recent-presence window, for the questions route and `/api/models`. */
  awayRecentClientWindowMs(): number {
    return this.recentWindowMs()
  }

  /**
   * 6.60.0: the longest a question that starts now while Miles is away is held, for a hook
   * as the settings file has it, when a `hold=1` client reported wearer presence within the
   * window (`awayHoldMs` on the questions route and `/api/models`). 0 when the away hold is
   * off, or when the installed hook waits no longer than the 6.59.0 broker could hold.
   */
  awayHoldNowMs(): number {
    if (this.awayHoldMs() === 0) return 0
    const hold = this.holdMs(this.installedHookTimeoutS(), true)
    return hold.ceilingAllowsAway ? hold.holdMs : 0
  }

  /** The desk-idle threshold, never below DESK_IDLE_MIN_S. */
  private deskIdleThreshold(): number {
    const configured = Number(this.deps.deskIdleSeconds())
    return Math.max(DESK_IDLE_MIN_S, Number.isFinite(configured) ? configured : DESK_IDLE_MIN_S)
  }

  pendingCount(): number {
    let n = 0
    for (const item of this.items.values()) if (item.state === 'pending') n++
    return n
  }

  /**
   * Every gate, cheapest first, so a request outside them is answered without spawning
   * anything or reading its input: the switch, the drain, the envelope's structure (a
   * Cursor payload), the tool policy, a live client, the hook's own deadline, capacity, and
   * only then the desk (one `ioreg`). The switch, the drain, the approvals policy and
   * capacity are read again after it, since the world may have moved during the read. The
   * question card, the approval card and the fingerprint are built only for a request that
   * will be parked.
   */
  async admit(body: unknown): Promise<BrokerAdmission> {
    if (this.deps.mode() === 'off') return this.noteFastPath('broker_off')
    if (!this.deps.admissionsOpen()) return this.noteFastPath('draining')
    const read = readPermissionRequestEnvelope(body)
    if (!read.ok) return this.noteFastPath(read.reason)
    const { facts } = read
    const isQuestion = facts.toolName === ASK_USER_QUESTION_TOOL
    if (!isQuestion) {
      if (this.deps.mode() !== 'all') return this.noteFastPath('approvals_off')
      if (UNBROKERED_TOOLS.has(facts.toolName)) return this.noteFastPath('unsupported_tool')
    }
    const now = this.deps.now()
    const presence = this.presence(now)
    const clientLive = this.clientLive(now) || presence.holdLive
    // 6.60.0: the away hold applies only when it is on, the installed hook waits longer than
    // the 6.59.0 broker could hold, and a `hold=1` client reported wearer presence within the
    // window (Miles, 19:54; QA round 1).
    const switchOn = this.awayHoldMs() > 0
    const ceilingAllowsAway = this.holdMs(facts.hookWaitS, false).ceilingAllowsAway
    const away = switchOn && ceilingAllowsAway && presence.recent
    const notAwayReason: NotAwayReason | null = away ? null
      : !switchOn ? 'hold_off'
      : !ceilingAllowsAway ? 'ceiling_at_base'
      : presence.ageMs === null ? 'no_hold_client'
      : 'stale_presence'
    const hold = this.holdMs(facts.hookWaitS, away)
    // With it, a request is held whether or not a client is polling right now, so a lens or
    // phone that comes back can still answer it. Without it, no client is `{}`, as in 6.59.0.
    if (!clientLive && !away) return this.noteFastPath('no_client', { notAway: notAwayReason!, presence, clientLive })
    // The deadline counts from when the HOOK started, when its stamp is sane: a request the
    // server read late must still be answered before the hook's curl gives up.
    const requestedAt = facts.hookStartedAtMs !== null && facts.hookStartedAtMs <= now ? facts.hookStartedAtMs : now
    const deadlineAt = requestedAt + hold.holdMs
    if (deadlineAt <= now) return this.noteFastPath('stale_hook')
    if (this.pendingCount() >= MAX_PENDING) return this.noteFastPath('capacity')
    let idle: number | null = null
    try { idle = await this.deps.readDeskIdleSeconds() } catch { idle = null }
    if (idle === null) return this.noteFastPath('desk_unknown')
    if (idle < this.deskIdleThreshold()) return this.noteFastPath('desk_active', { notAway: 'desk_active', presence, clientLive })
    const mode = this.deps.mode()
    if (mode === 'off') return this.noteFastPath('broker_off')
    if (!this.deps.admissionsOpen()) return this.noteFastPath('draining')
    if (!isQuestion && mode !== 'all') return this.noteFastPath('approvals_off')
    // Others were admitted during the read: the cap holds at the moment of parking.
    if (this.pendingCount() >= MAX_PENDING) return this.noteFastPath('capacity')
    let kind: BrokerItemKind
    let questions: BrokerQuestion[] | null = null
    let approval: ApprovalCard | null = null
    if (isQuestion) {
      questions = parseQuestions(facts.toolInput)
      if (!questions) return this.noteFastPath('unsupported_input')
      kind = 'question'
    } else {
      kind = 'approval'
      approval = approvalCard(facts.toolName, facts.toolInput)
    }
    const fingerprint = toolFingerprint(facts.toolName, facts.toolInput)
    const awayHold = away
    const holdFacts: HoldFacts = {
      installedHookTimeoutS: hold.installedHookTimeoutS,
      hookWaitS: facts.hookWaitS,
      awayHoldS: Math.round(hold.awayHoldMs / 1000),
      ceilingS: hold.ceilingS,
      effectiveDeadlineS: Math.round(hold.holdMs / 1000),
      deskIdleMs: idle * 1000,
      clientLive,
      presenceAgeMs: presence.ageMs === null ? null : Math.round(presence.ageMs),
      recentWindowS: Math.round(presence.windowMs / 1000),
      notAwayReason,
    }
    return { ok: true, request: { facts: { ...facts, fingerprint }, kind, questions, approval, deadlineAt, awayHold, hold: holdFacts } }
  }

  /** Hold the hook's response until exactly one resolution. Returns the item id. */
  park(request: ParkRequest, channel: HookReplyChannel): string {
    const now = this.deps.now()
    const id = this.deps.newId ? this.deps.newId() : `pq_${randomBytes(12).toString('hex')}`
    const { facts } = request
    const item: BrokerItem = {
      id,
      sessionId: facts.sessionId,
      provider: facts.provider ?? 'claude',
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
      handedBackBy: null,
      channel,
      timer: null,
      awayHold: request.awayHold === true,
      waitingAtMac: false,
    }
    this.items.set(id, item)
    this.counters.parked++
    if (item.awayHold) this.counters.awayHeld++
    if (request.hold && !request.hold.clientLive) this.counters.parkedWithoutClient++
    item.timer = setTimeout(() => { this.settle(item, 'expired') }, Math.max(0, request.deadlineAt - now))
    item.timer.unref?.()
    try { this.deps.signals?.attach(item.sessionId, id, item.fingerprint) } catch { /* rows are advisory */ }
    this.ensurePolling()
    // 6.60.0: the numbers the deadline came from, once per request (never text).
    const hold = request.hold ? ` hold=${JSON.stringify(request.hold)}` : ''
    this.log(`parked ${id} kind=${item.kind} session=${item.sessionId.slice(0, 8)} deadline_s=${Math.round((request.deadlineAt - now) / 1000)} away_hold=${item.awayHold} pending=${this.pendingCount()}${hold}`)
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
      let written = false
      try { written = item.channel?.reply({}) === true } catch { /* the hook is gone anyway */ }
      // 6.60.0: `{}` reached the hook, so the Mac's own dialog is up for it now.
      item.waitingAtMac = written && MAC_DIALOG_RESOLUTIONS.has(resolution)
    }
    item.channel = null
    // A settled item is kept for its codes, not its content.
    item.toolInput = {}
    item.questions = null
    item.approval = null
    this.counters[RESOLUTION_COUNTER[resolution]]++
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
        provider: item.provider,
        kind: item.kind,
        tool: item.toolName,
        createdAt: new Date(item.createdAt).toISOString(),
        deadlineAt: new Date(item.deadlineAt).toISOString(),
        ...(item.questions ? { questions: item.questions } : {}),
        ...(item.approval ? { approval: item.approval } : {}),
        answerable: true,
        awayHold: item.awayHold,
        waitingAtMac: false,
      })
    }
    return views.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * 6.60.0: the settled items still kept, newest settled first, at most SETTLED_LIST_MAX:
   * codes and times only. `waitingAtMac` says the Mac's own dialog is still waiting on one.
   */
  settledList(): SettledQuestionView[] {
    this.prune()
    const settled: BrokerItem[] = []
    for (const item of this.items.values()) if (item.state !== 'pending' && item.settledAt !== null) settled.push(item)
    settled.sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0))
    // Every item the Mac still waits on is listed whatever the cap, so a missing one is never
    // read as "moved past" (Ghost Hunter W1); the newest others fill up to SETTLED_LIST_MAX.
    const waiting = settled.filter(item => item.waitingAtMac)
    const others = settled.filter(item => !item.waitingAtMac).slice(0, Math.max(0, SETTLED_LIST_MAX - waiting.length))
    const listed = [...waiting, ...others].sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0))
    return listed.map(item => ({
      id: item.id,
      sessionId: item.sessionId,
      provider: item.provider,
      kind: item.kind,
      tool: item.toolName,
      createdAt: new Date(item.createdAt).toISOString(),
      deadlineAt: new Date(item.deadlineAt).toISOString(),
      settledAt: new Date(item.settledAt!).toISOString(),
      resolution: item.state as BrokerResolution,
      answerable: false as const,
      awayHold: item.awayHold,
      waitingAtMac: item.waitingAtMac,
    }))
  }

  /**
   * 6.60.0 (QA round 1, N2): the session's row now reads ended (its process is gone, or it
   * ended), so no Mac dialog of it can still be waiting. Cleared at once, not after the hour.
   * Takes a full session id or the registry's eight-character form. Returns how many cleared.
   */
  sessionRowEnded(sessionId: string): number {
    const wanted = typeof sessionId === 'string' ? sessionId.toLowerCase() : ''
    if (wanted.length < 8) return 0
    let cleared = 0
    for (const item of this.items.values()) {
      if (!item.waitingAtMac) continue
      if (item.sessionId !== wanted && !(wanted.length < 36 && item.sessionId.startsWith(wanted))) continue
      item.waitingAtMac = false
      cleared++
    }
    if (cleared > 0) this.log(`session row ended: ${cleared} no longer waiting at the Mac session=${wanted.slice(0, 8)}`)
    return cleared
  }

  /** 6.60.0: how many settled items are still waiting at the Mac. */
  waitingAtMacCount(): number {
    let n = 0
    for (const item of this.items.values()) if (item.state !== 'pending' && item.waitingAtMac) n++
    return n
  }

  /**
   * `POST /api/session-questions/:id/answer`. Synchronous from the state check to the
   * reply, so two racing answers cannot both win: the first one settles the item and the
   * second reads it settled.
   *
   * `{clientAnswerId, handBack: true}` is "Leave for the Mac" (6.52.0 app QA): the hook gets
   * `{}` at once, so the Mac's own dialog shows now instead of at the deadline. It resolves
   * the item as `handed_to_desk`, and it competes with an answer like any answer: the first
   * action wins. A later answer reads 409 `handed_to_desk`; a hand-back after an answer reads
   * 409 `already_answered` with the recorded answer; the same hand-back retried (same
   * clientAnswerId) replays its 200. `handBack` wins over any answer fields in the same body:
   * it is the safe direction, since it only shows the dialog that would have shown anyway.
   */
  answer(id: string, body: unknown): AnswerResult {
    const item = BROKER_ID_RE.test(id) ? this.items.get(id) : undefined
    if (!item) return { status: 404, body: { error: 'not_found' } }
    const input = isRecord(body) ? body : {}
    const clientAnswerId = input.clientAnswerId
    if (typeof clientAnswerId !== 'string' || !CLIENT_ANSWER_ID_RE.test(clientAnswerId)) {
      this.counters.invalidAnswer++
      return { status: 400, body: { error: 'invalid_answer', reason: 'client_answer_id' } }
    }
    const handBack = input.handBack === true
    if (item.state !== 'pending') return this.settledReply(item, clientAnswerId, handBack)
    if (this.deps.now() >= item.deadlineAt) {
      this.settle(item, 'expired')
      return this.settledReply(item, clientAnswerId, handBack)
    }
    if (handBack) return this.handBack(item, clientAnswerId)
    let chosen: Chosen
    let output: Record<string, unknown>
    if (item.kind === 'question') {
      const validation = validateQuestionAnswers(item.questions ?? [], input.answers)
      if (!validation.ok) {
        this.counters.invalidAnswer++
        return { status: 400, body: { error: 'invalid_answer', reason: validation.reason, ...(validation.index !== undefined ? { index: validation.index } : {}) } }
      }
      chosen = { answers: validation.answers }
      output = questionHookOutput(item.toolInput, validation.answers)
    } else {
      if (input.decision !== 'allow' && input.decision !== 'deny') {
        this.counters.invalidAnswer++
        return { status: 400, body: { error: 'invalid_answer', reason: 'decision' } }
      }
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
    item.questions = null
    item.approval = null
    if (item.timer) clearTimeout(item.timer)
    item.timer = null
    this.counters.answered++
    try { this.deps.signals?.decided(item.sessionId, item.id, item.fingerprint) } catch { /* rows are advisory */ }
    this.log(`answered ${item.id} kind=${item.kind} pending=${this.pendingCount()}`)
    this.prune()
    return { status: 200, body: { ok: true, id: item.id, kind: item.kind, ...chosen } }
  }

  /**
   * 6.53.0: a desk run of this session was cancelled from COS. Every prompt the broker holds
   * for it is answered deny with `interrupt: true` (the away-from-desk case: without this the
   * run waits out the deadline and then shows the Mac's dialog, and a cancel "at the next
   * tool call" never arrives, because the next tool is the one being asked about). Recorded
   * as an answer, so a lens answering the same card afterwards reads 409 already_answered.
   * A hook that already left is `hook_gone`, as for any answer. Returns how many it denied.
   */
  cancelSession(sessionId: string): number {
    const wanted = typeof sessionId === 'string' ? sessionId.toLowerCase() : ''
    if (!wanted) return 0
    let denied = 0
    for (const item of [...this.items.values()]) {
      if (item.state !== 'pending' || item.sessionId !== wanted) continue
      if (!item.channel || !item.channel.writable() || !item.channel.reply(cancelHookOutput(item.provider))) {
        this.settle(item, 'hook_gone')
        continue
      }
      item.state = 'answered'
      item.settledAt = this.deps.now()
      item.answer = { clientAnswerId: 'cos-cancel', chosen: { decision: 'deny' } }
      item.channel = null
      item.toolInput = {}
      item.questions = null
      item.approval = null
      if (item.timer) clearTimeout(item.timer)
      item.timer = null
      this.counters.answered++
      try { this.deps.signals?.decided(item.sessionId, item.id, item.fingerprint) } catch { /* rows are advisory */ }
      this.log(`cancelled ${item.id} kind=${item.kind} pending=${this.pendingCount()}`)
      denied++
    }
    this.prune()
    return denied
  }

  /**
   * "Leave for the Mac" on a pending item. As for an answer, the hook must still be listening:
   * one that already left is `hook_gone` (the Mac shows its dialog either way).
   */
  private handBack(item: BrokerItem, clientAnswerId: string): AnswerResult {
    if (!item.channel || !item.channel.writable()) {
      this.settle(item, 'hook_gone')
      return this.settledReply(item, clientAnswerId, true)
    }
    item.handedBackBy = clientAnswerId
    this.counters.handedBack++
    this.settle(item, 'handed_to_desk')
    return { status: 200, body: { ok: true, id: item.id, kind: item.kind, handedBack: true } }
  }

  private settledReply(item: BrokerItem, clientAnswerId: string, handBack = false): AnswerResult {
    switch (item.state) {
      case 'answered': {
        const chosen = item.answer?.chosen ?? {}
        // A hand-back never replays an answer, even under the answer's own id.
        if (handBack) return { status: 409, body: { error: 'already_answered', ...chosen } }
        if (item.answer?.clientAnswerId === clientAnswerId) return { status: 200, body: { ok: true, id: item.id, kind: item.kind, replay: true, ...chosen } }
        return { status: 409, body: { error: 'already_answered', ...chosen } }
      }
      case 'expired':
        return { status: 409, body: { error: 'expired' } }
      case 'hook_gone':
        return { status: 410, body: { error: 'hook_gone' } }
      default:
        // handed_to_desk, retracted, drained, no_client: the Mac has it now. Only the
        // hand-back that did it, retried under its own id, replays; an answer never does.
        if (handBack && item.handedBackBy === clientAnswerId) return { status: 200, body: { ok: true, id: item.id, kind: item.kind, handedBack: true, replay: true } }
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
      // 6.60.0: one handed to the Mac's dialog stops waiting there when the session moves past it.
      if (item.waitingAtMac && env.ts >= item.requestedAt && sessionMovedPast(item, env, toolName, fingerprint, true)) {
        item.waitingAtMac = false
        continue
      }
      if (item.state !== 'pending' || env.ts < item.requestedAt) continue
      if (sessionMovedPast(item, env, toolName, fingerprint)) this.settle(item, 'retracted')
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
    this.deskUnreadableStreak = 0
  }

  /**
   * One check while anything is held. A drain, the answering client going quiet, or
   * returning to the Mac hands everything back. An unreadable desk counts as the desk only
   * on the SECOND failed read in a row: one `ioreg` that times out under load must not
   * throw away a question someone is reading (QA round 1).
   */
  async tick(): Promise<void> {
    if (this.pendingCount() === 0) { this.stopPolling(); return }
    if (!this.deps.admissionsOpen()) { this.settleAll('drained'); return }
    const now = this.deps.now()
    const presence = this.presence(now)
    if (!(this.clientLive(now) || presence.holdLive)) {
      // 6.60.0: an item held by the away hold outlives the client going quiet, but only while
      // the wearer's latest presence is still within the window (QA round 1, Skeptic W2: a
      // single glance must not hold a question 10 more minutes). The desk below still hands
      // it back.
      this.settleAll('no_client', item => !item.awayHold || !presence.recent)
      if (this.pendingCount() === 0) return
    }
    if (this.pollInFlight) return
    this.pollInFlight = true
    let idle: number | null = null
    try { idle = await this.deps.readDeskIdleSeconds() } catch { idle = null } finally { this.pollInFlight = false }
    if (idle === null) {
      this.counters.deskUnreadable++
      this.deskUnreadableStreak++
      if (this.deskUnreadableStreak >= 2) this.settleAll('handed_to_desk')
      return
    }
    this.deskUnreadableStreak = 0
    if (idle >= this.deskIdleThreshold()) return
    this.settleAll('handed_to_desk')
  }

  private settleAll(resolution: 'handed_to_desk' | 'drained' | 'no_client', only: (item: BrokerItem) => boolean = () => true): void {
    for (const item of [...this.items.values()]) if (item.state === 'pending' && only(item)) this.settle(item, resolution)
    if (this.pendingCount() === 0) this.stopPolling()
  }

  /**
   * Settled items are kept for SETTLED_RETENTION_MS (late answers, replays), at most
   * MAX_SETTLED. 6.60.0: one still waiting at the Mac is kept for MAC_WAIT_RETENTION_MS.
   */
  private prune(): void {
    const now = this.deps.now()
    const settled: BrokerItem[] = []
    for (const item of this.items.values()) {
      if (item.state === 'pending') continue
      if (item.settledAt !== null && now - item.settledAt > this.retentionMs(item)) this.forget(item)
      else settled.push(item)
    }
    // Over the cap, the oldest that no longer wait go first.
    const excess = settled.length - MAX_SETTLED
    if (excess > 0) {
      settled.sort((a, b) => Number(a.waitingAtMac) - Number(b.waitingAtMac) || (a.settledAt ?? 0) - (b.settledAt ?? 0))
      for (let i = 0; i < excess; i++) this.forget(settled[i]!)
    }
    if (this.pendingCount() === 0) this.stopPolling()
  }

  /**
   * How long a settled item is kept: ten minutes; an hour while the Mac waits on it; a day
   * while its session's row still waits on that very request (Ghost Hunter W1).
   */
  private retentionMs(item: BrokerItem): number {
    if (!item.waitingAtMac) return SETTLED_RETENTION_MS
    let still = false
    try { still = this.deps.stillWaitingAtMac?.(item.sessionId, item.fingerprint) === true } catch { still = false }
    return still ? MAC_WAIT_MAX_RETENTION_MS : MAC_WAIT_RETENTION_MS
  }

  /** Drop a settled item. One the Mac may still wait on moves the forgotten horizon. */
  private forget(item: BrokerItem): void {
    this.items.delete(item.id)
    if (item.waitingAtMac && item.settledAt !== null && item.settledAt > this.waitingForgottenBefore) this.waitingForgottenBefore = item.settledAt
  }

  health(): PermissionBrokerHealth {
    const mode = this.deps.mode()
    let polledAt: number | null = null
    try { polledAt = this.deps.lastQuestionsPollAt() } catch { polledAt = null }
    return {
      enabled: mode !== 'off',
      mode,
      counters: { ...this.counters, fastPath: { ...this.fastPaths } },
      lastFastPath: this.lastFastPath,
      lastFastPathAt: isoOrNull(this.lastFastPathAt),
      lastQuestionsPollAt: isoOrNull(polledAt),
    }
  }

  /**
   * Counts, for the AUTHENTICATED questions route only (6.52.0 QA round 2): pending was
   * derivable from the public counters (parked minus every resolution), so none of them are
   * on the public `/api/health`.
   */
  stats(): { counters: Record<string, number>; fastPath: Record<string, number> } {
    return { counters: { ...this.counters }, fastPath: { ...this.fastPaths } }
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

/** `/api/health`: counts, the mode and timestamps only; never an id, a question or a command. */
/** What the PUBLIC `/api/health` may show about the broker: the mode and two timestamps.
 * No counters (6.52.0 QA round 2): how many are held was derivable from them (parked minus
 * every resolution). The counts are on the authenticated `/api/session-questions` route. */
export type PublicPermissionBrokerHealth = Omit<PermissionBrokerHealth, 'counters'>

export function permissionBrokerHealthFields(): { permissionBroker: PublicPermissionBrokerHealth | null } {
  if (!registered) return { permissionBroker: null }
  const { counters: _counters, ...visible } = registered.health()
  return { permissionBroker: visible }
}

export interface SessionQuestionsCapability {
  enabled: boolean
  mode: BrokerMode
  protocolVersion: number
  pollIntervalMs: number
  liveWindowMs: number
  /**
   * 6.60.0: the longest a question that starts while you are away is held for the glasses,
   * whether or not a client is polling (`PermissionBroker.awayHoldNowMs`); 0 when the away
   * hold is off or the broker is.
   */
  awayHoldMs: number
  /**
   * 6.60.0: the away hold applies only when a client that can answer polled within this many
   * ms (`COS_PERMISSION_BROKER_AWAY_RECENT_CLIENT_S`); 0 means it must be polling right now.
   */
  awayRecentClientMs: number
}

/**
 * `/api/models` `capabilities.sessionQuestions`: whether the questions API is there and
 * holding, and the client contract (poll `GET /api/session-questions?client=glasses|phone`
 * every `pollIntervalMs`; a client quiet for `liveWindowMs` hands everything back).
 */
export function sessionQuestionsCapability(): SessionQuestionsCapability {
  let mode: BrokerMode = 'off'
  try { mode = registered ? registered.health().mode : 'off' } catch { mode = 'off' }
  let awayHoldMs = 0
  try { awayHoldMs = registered && mode !== 'off' ? registered.awayHoldNowMs() : 0 } catch { awayHoldMs = 0 }
  let awayRecentClientMs = 0
  try { awayRecentClientMs = registered && awayHoldMs > 0 ? registered.awayRecentClientWindowMs() : 0 } catch { awayRecentClientMs = 0 }
  return {
    enabled: mode !== 'off',
    mode,
    protocolVersion: SESSION_QUESTIONS_PROTOCOL_VERSION,
    pollIntervalMs: QUESTIONS_POLL_INTERVAL_MS,
    liveWindowMs: CLIENT_LIVE_WINDOW_MS,
    awayHoldMs,
    awayRecentClientMs,
  }
}
