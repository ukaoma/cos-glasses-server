// What one Continue runs with, per provider (6.62.0, plans 3.1-3.3 and 3.12, decision D1).
//
// D1 (Miles, binding): every Continue carries its session's full permissions.
//   Claude  unchanged: `claude -p --resume` already runs as the session runs (APA:473-496),
//           and keeps the session's model (canary C5).
//   Codex   the session's own sandbox, model and effort, read from its rollout
//           (`codex-session-posture.ts`), passed explicitly because resume takes the
//           config defaults otherwise (C11). Full access only in a folder Codex trusts.
//   Cursor  Run Everything (`--force`) on the session's own model (C4, C5), with every
//           spawn isolated so `--model` cannot rewrite the user's CLI default (C9).
//
// THE PLAN IS DATA. The index shim resolves it, the adapter builds argv from it, and the
// SAME plan names the one `PermissionAllowance` both of the adapter's ban checks receive.
// A plan the adapter cannot validate is refused there, never widened.
//
// THE KILL SWITCH. `COS_CONTINUE_FULL_PERMISSIONS=0` in `~/.cos-glasses/.env` resolves NO
// plan for Codex and Cursor, and the adapter then builds exactly the 6.61 argv (Codex
// `getCodexTrustMode()`, Cursor `--mode ask` on composer-2.5-fast). Default on. Control
// 0.5.254's provider allowlist does not carry the key, so it belongs in `.env`.

import type { PermissionAllowance } from './banned-permission-args.js'
import { CONTINUE_NOTE_MAX, fitModelNote, type CodexContinuePlan } from './codex-session-posture.js'
import { CURSOR_CONTINUE_FALLBACK_MODEL } from './cursor-session-model.js'

export type { CodexContinuePlan } from './codex-session-posture.js'

export interface CursorContinuePlan {
  provider: 'cursor'
  /** `force` is Run Everything. The only mode a 6.62 plan carries; Ask is "no plan". */
  mode: 'force'
  /** A flat slug the installed Cursor lists, or the fallback. */
  model: string
  /** The session's own model was read AND listed. False means the fallback. */
  matched: boolean
  note: string
}

export type AttachedContinuePlan = CodexContinuePlan | CursorContinuePlan

/** `COS_CONTINUE_FULL_PERMISSIONS`: ON unless exactly '0'. */
export function continueFullPermissionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_CONTINUE_FULL_PERMISSIONS !== '0'
}

const CODEX_SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const EFFORT_RE = /^[a-z]{2,16}$/

/**
 * Is this a plan the adapter may build from? Structural, and total: anything that is not
 * exactly a plan for THIS provider with values of the right shape is `invalid`. A value
 * here becomes an argv element, so the shapes are the argv rules.
 */
export function validateContinuePlan(provider: string, plan: unknown): AttachedContinuePlan | null | 'invalid' {
  if (plan === undefined || plan === null) return null
  if (typeof plan !== 'object' || Array.isArray(plan)) return 'invalid'
  const row = plan as Record<string, unknown>
  if (row.provider !== provider) return 'invalid'
  if (provider === 'codex') {
    if (typeof row.sandbox !== 'string' || !CODEX_SANDBOXES.has(row.sandbox)) return 'invalid'
    if (row.model !== null && (typeof row.model !== 'string' || !MODEL_RE.test(row.model))) return 'invalid'
    if (row.effort !== null && (typeof row.effort !== 'string' || !EFFORT_RE.test(row.effort))) return 'invalid'
    if (row.networkAccess !== null && typeof row.networkAccess !== 'boolean') return 'invalid'
    if (row.source !== 'session' && row.source !== 'fallback') return 'invalid'
    // A fallback plan never carries more than the 6.61 sandbox.
    if (row.source === 'fallback' && (row.sandbox === 'danger-full-access' || row.model !== null || row.effort !== null)) return 'invalid'
    return plan as CodexContinuePlan
  }
  if (provider === 'cursor') {
    if (row.mode !== 'force') return 'invalid'
    if (typeof row.model !== 'string' || !MODEL_RE.test(row.model)) return 'invalid'
    return plan as CursorContinuePlan
  }
  // Claude has no plan: its Continue is unchanged.
  return 'invalid'
}

/**
 * The ONE allowance for this plan, or undefined (the full ban). Built once per turn and
 * passed to both checks. Only the two escalations D1 names exist.
 */
export function continueAllowanceFor(plan: AttachedContinuePlan | null | undefined): PermissionAllowance | undefined {
  if (!plan) return undefined
  if (plan.provider === 'cursor' && plan.mode === 'force') return { path: 'attached_continue', cursorForce: true }
  if (plan.provider === 'codex' && plan.sandbox === 'danger-full-access') {
    return { path: 'attached_continue', codexSandbox: 'danger-full-access' }
  }
  return undefined
}

export interface CursorPlanInput {
  /** Flat slugs, most specific first (`cursorSlugCandidates`, or a CLI chat's own slug). */
  candidates: readonly string[]
  isKnown: (id: string) => boolean
  label: (id: string) => string | null
  /** COS created this CLI chat in Ask mode: a Run Everything Continue escalates it (W14). */
  askModeChat: boolean
}

/** Run Everything on the session's model, validated against the full `agent models` list. */
export function planCursorContinue(input: CursorPlanInput): CursorContinuePlan {
  let model: string | null = null
  for (const candidate of input.candidates) {
    try {
      if (MODEL_RE.test(candidate) && input.isKnown(candidate)) { model = candidate; break }
    } catch {
      model = null
      break
    }
  }
  const matched = model !== null
  const chosen = model ?? CURSOR_CONTINUE_FALLBACK_MODEL
  let label: string | null = null
  try {
    label = input.label(chosen)
  } catch {
    label = null
  }
  // The CLI's display name when the note stays short; else the slug itself (lens width).
  const display = label || (matched ? null : 'Composer 2.5 Fast')
  const note = input.askModeChat
    ? fitModelNote(m => `Now Run Everything (was Ask), ${m}.`, display, chosen, 'Now Run Everything (was Ask).')
    : matched
      ? fitModelNote(m => `Run Everything on ${m}.`, display, chosen, 'Run Everything on this session\'s model.')
      : fitModelNote(m => `Run Everything on ${m}; model unread.`, display, chosen, 'Run Everything; session model unread.')
  return { provider: 'cursor', mode: 'force', model: chosen, matched, note }
}

/** The note when the kill switch is on, per provider. Claude has none: it never changed. */
export function killSwitchNote(provider: string, codexFallbackSandbox: 'read-only' | 'workspace-write'): string | null {
  if (provider === 'codex') {
    return codexFallbackSandbox === 'workspace-write'
      ? 'Workspace write: full permissions switched off.'
      : 'Read-only: full permissions switched off.'
  }
  if (provider === 'cursor') return 'Ask mode: full permissions switched off.'
  return null
}

/** An IDE composer is not resumed from outside; a turn queued for it runs in Cursor. */
export const CURSOR_COMPOSER_NOTE = 'Runs in Cursor\'s own chat with its settings.'

/** Belt and braces for every note that reaches the wire (plan 3.12). */
export function boundedContinueNote(note: unknown): string | null {
  if (typeof note !== 'string') return null
  const trimmed = note.replace(/\s+/g, ' ').trim()
  if (trimmed.length === 0) return null
  return trimmed.length <= CONTINUE_NOTE_MAX ? trimmed : null
}
