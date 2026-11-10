// X1 (2026-11-09): the full hold. A session question (AskUserQuestion) or a tool approval held for
// the WHOLE wait of the PermissionRequest hook, whether or not a COS device is live when it is asked.
//
// WHY THIS IS SAFE AT THE DESK (canaries, operations/personal/wk46_2026/production_hardening/
// x1_question_fetch/CANARIES.md): on the engines below, Claude Code shows its own question or
// approval dialog at once WHILE the PermissionRequest hook is still waiting (C1, C5). An answer at
// the Mac wins and a later hook answer is ignored (C3, C4); a hook answer withdraws the dialog (C2;
// the desktop engine sends `control_cancel_request` to the app, C6). A hold of 3,703 s worked (C7).
// So holding the hook never delays the Mac's own prompt (Miles's option B, 11/05) ON THESE ENGINES.
// An engine that is not listed, or reads older, keeps today's rule: it may not show its dialog
// until the hook returns, and a long hold there would keep the desk waiting.
//
// Both switches default OFF. With both off nothing in this file is read on the permission path.
//
// Pure, no imports beyond the one switch reader.

import { readSwitch } from './env-switch.js'

/** `COS_QUESTION_FULL_HOLD`: hold a question for the whole hook wait. Default OFF. Read per request. */
export function questionFullHoldEnabled(env: NodeJS.ProcessEnv): boolean {
  return readSwitch(env.COS_QUESTION_FULL_HOLD, false)
}

/** `COS_APPROVAL_FULL_HOLD`: hold a tool approval for the whole hook wait while the desk stays idle. Default OFF. */
export function approvalFullHoldEnabled(env: NodeJS.ProcessEnv): boolean {
  return readSwitch(env.COS_APPROVAL_FULL_HOLD, false)
}

/**
 * `COS_WAITING_QUESTION_WORDS`: a session waiting on a question carries the first 80 characters of its
 * first question (`waiting_detail`, through `toolTarget`), so Today and the Sessions rows say what it
 * asks. Default ON: Miles, 2026-11-09 22:10 CST, "Yes, show by default", told that the text is written
 * to the on-disk session-hook ledger and sent to any signed-in browser, including for questions
 * answered at the desk. `0` restores 7.0.13's empty detail exactly. Question text only: never an
 * option, a description or an answer. The `waiting` list with full words and options is NOT this
 * switch: it is on only while a full-hold switch is.
 */
export function waitingQuestionWordsEnabled(env: NodeJS.ProcessEnv): boolean {
  return readSwitch(env.COS_WAITING_QUESTION_WORDS, true)
}

/** Control and format characters (bidi overrides, zero-width) taken out of a question before it becomes row text. */
export function questionRowText(question: unknown): string {
  if (typeof question !== 'string') return ''
  return question.replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
}

export interface FullHoldSwitches { questions: boolean; approvals: boolean }

export function fullHoldSwitches(env: NodeJS.ProcessEnv): FullHoldSwitches {
  return { questions: questionFullHoldEnabled(env), approvals: approvalFullHoldEnabled(env) }
}

/**
 * The oldest engine of each kind proven to show its own dialog while the hook waits, by the
 * registry record's `entrypoint` and `version` (`~/.claude/sessions/<pid>.json`).
 *   - `cli` 2.1.321: canaries C1 to C4, C7, C9 (2026-11-09, tmux, real TTY).
 *   - `claude-desktop` 2.1.317: the engine Claude Desktop runs, driven over its stream-json
 *     protocol, C5, C6, C9 (and the 6.71.7 Desktop D1 canary of 2026-10-11 in the real app).
 * Anything else (`sdk-cli`, an unknown entrypoint, no version) is not proven.
 */
export const FULL_HOLD_ENGINE_FLOORS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  cli: Object.freeze([2, 1, 321]),
  'claude-desktop': Object.freeze([2, 1, 317]),
})

/** Where the engine runs (`lib/full-hold-engine.ts` `processHost`): Claude.app's helper, a terminal, or neither. */
export type EngineHost = 'desktop-app' | 'terminal' | 'other'

export interface EngineFacts { entrypoint: string | null; version: string | null; host?: EngineHost }

/**
 * Q1 O2: the host each entrypoint must run in. A `claude -p` print run takes its entrypoint from
 * whatever launched it, has no dialog, and runs under neither (`lib/full-hold-engine.ts`).
 */
export const FULL_HOLD_ENGINE_HOSTS: Readonly<Record<string, EngineHost>> = Object.freeze({
  cli: 'terminal',
  'claude-desktop': 'desktop-app',
})

/** `2.1.321` as numbers; null for anything that is not one to four dot-separated whole numbers. */
export function parseEngineVersion(version: unknown): number[] | null {
  if (typeof version !== 'string') return null
  const trimmed = version.trim()
  if (!/^\d{1,6}(?:\.\d{1,6}){0,3}$/.test(trimmed)) return null
  return trimmed.split('.').map(Number)
}

/** True when `version` is at or above `floor`, part by part (a missing part reads 0). */
export function versionAtLeast(version: readonly number[], floor: readonly number[]): boolean {
  const length = Math.max(version.length, floor.length)
  for (let i = 0; i < length; i++) {
    const v = version[i] ?? 0
    const f = floor[i] ?? 0
    if (v !== f) return v > f
  }
  return true
}

/** Whether this engine is proven to keep its dialog on screen while the hook waits, and runs where that dialog is. */
export function engineProvenForFullHold(engine: EngineFacts | null | undefined): boolean {
  if (!engine || typeof engine.entrypoint !== 'string') return false
  if (!Object.prototype.hasOwnProperty.call(FULL_HOLD_ENGINE_FLOORS, engine.entrypoint)) return false
  if (engine.host !== FULL_HOLD_ENGINE_HOSTS[engine.entrypoint]) return false
  const floor = FULL_HOLD_ENGINE_FLOORS[engine.entrypoint]!
  const version = parseEngineVersion(engine.version)
  return version !== null && versionAtLeast(version, floor)
}

/** The PermissionRequest wait the installer writes for a kind under the full hold. */
export const FULL_HOLD_HOOK_WAIT_S = 3600

/**
 * The matcher of the non-question PermissionRequest block once the hook is split (canary C9:
 * honoured on both engines; a question runs only the `AskUserQuestion` block, everything else
 * only this one).
 */
export const NON_QUESTION_MATCHER = '^(?!AskUserQuestion$).*'
export const QUESTION_MATCHER = 'AskUserQuestion'

/** How a web (browser session) answer proves a person just touched the page, while a flag is on. */
export const WEB_ANSWER_TOUCH_MAX_MS = 60_000
/** How long a web approval's confirm step stays usable. */
export const WEB_CONFIRM_TTL_MS = 60_000
