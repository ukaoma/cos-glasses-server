// The hook envelope: what `bin/hooks/cos-session-hook` writes, and the only shape the
// ingester, the ledger and the signal store ever read.
//
// One file per Claude Code hook event, spooled by a POSIX sh script that never talks to
// this server (PermissionRequest excepted). The script wraps the payload Claude piped to
// it: `{"ts":<ms>,"ppid":<pid>,"event":"<name>","payload":<stdin>}`.
//
// FIELD NAMES COME FROM RECORDED 2.1.272 PAYLOADS WHERE ONE EXISTS, never from the docs
// alone. The docs said `start_reason`, `end_reason`, `stop_reason` and a `tool_use_id` on
// PermissionRequest; the recordings (2026-09-15) carry `source`, `reason`, no stop reason
// at all, and no tool_use_id on PermissionRequest. Fixtures under
// `__fixtures__/session-hooks-6.48.0/` are those recordings; their README lists the
// interactive-only events (Notification, StopFailure, sub-agents, compaction, model switch)
// whose shapes are still the documented ones until a Desktop recording lands.

import { createHash } from 'node:crypto'

/** Events the installer subscribes and the reducer understands. Anything else is dropped. */
export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'PermissionRequest',
  'PermissionDenied',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PostModelSwitch',
  // 6.62.0: Codex fires this when a turn is interrupted (Esc). It closes the turn, as a Stop
  // does. Never in Claude's subscription list: Claude Code has no such hook.
  'Interrupt',
  // 6.62.0: the Cursor observer's `afterAgentThought`. Display only, like every observer
  // event: its text lives in memory and on the live feed, never in the ledger.
  'AgentThought',
] as const

export type HookEventName = typeof HOOK_EVENT_NAMES[number]

/**
 * 6.62.0: events the reducer understands that no Claude Code hook fires. They stay OUT of
 * Claude's `HOOK_SUBSCRIPTIONS` (a new Claude block would turn every install into `drift`):
 * `Interrupt` is Codex's, and `AgentThought` is the Cursor observer's.
 */
export const NON_CLAUDE_HOOK_EVENTS: readonly HookEventName[] = ['Interrupt', 'AgentThought']

/**
 * 6.62.0: which engine ran the hook. The Codex command carries `COS_HOOK_PROVIDER=codex`,
 * which the script writes into the envelope; Claude Code and Cursor share the
 * `~/.claude/settings.json` command and are told apart by the payload (`inferHookProvider`).
 */
export type HookProvider = 'claude' | 'codex' | 'cursor'

export function isHookProvider(value: unknown): value is HookProvider {
  return value === 'claude' || value === 'codex' || value === 'cursor'
}

/**
 * The provider of one envelope, in this order (plan 2.1): the envelope's own stamp (the Codex
 * command and the Cursor observer write one); else Cursor's `cursor_version`, which every
 * Cursor payload carries and no other engine's does; else a transcript under
 * `/.codex/sessions/` (a COS Claude block Codex imported runs without the stamp); else Claude.
 */
export function inferHookProvider(stamped: unknown, payload: Record<string, unknown>): HookProvider {
  if (isHookProvider(stamped)) return stamped
  if ('cursor_version' in payload) return 'cursor'
  if (typeof payload.transcript_path === 'string' && payload.transcript_path.includes('/.codex/sessions/')) return 'codex'
  return 'claude'
}

/** 6.62.0: the cap on an agent thought kept in memory and sent on the live feed. */
export const AGENT_THOUGHT_MAX = 280

const EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENT_NAMES)

export function isHookEventName(value: unknown): value is HookEventName {
  return typeof value === 'string' && EVENT_SET.has(value)
}

/** A full Claude session id: the transcript basename and the registry `sessionId`. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The spool file is capped by the script at 1 MiB of stdin; the envelope adds a few bytes. */
export const HOOK_ENVELOPE_MAX_BYTES = 1_048_576 + 256

export interface HookEnvelope {
  /** Milliseconds, stamped by the script when the hook ran. */
  ts: number
  /** The hook process's parent pid: the claude process, or the `sh -c` wrapper. */
  ppid: number | null
  event: HookEventName
  sessionId: string
  payload: Record<string, unknown>
  /** 6.62.0: set by `parseHookEnvelope` and a 6.62 ledger row; absent on older rows and hand-built envelopes. */
  provider?: HookProvider
}

/**
 * What a regex can still read off the head of a file that did not parse: enough for the
 * store to apply a payload-less event so a cut Stop still turns a row idle, never enough
 * to trust any other field.
 */
export interface SalvagedHookHead {
  sessionId: string
  event: HookEventName
  ts: number
}

export type ParsedHookEnvelope =
  | { ok: true; envelope: HookEnvelope }
  | { ok: false; reason: 'too_large' | 'not_json' | 'not_envelope' | 'unknown_event' | 'no_session'; salvaged: SalvagedHookHead | null }

const SALVAGE_SESSION_RE = /"session_id"\s*:\s*"([0-9a-f-]{36})"/i
const SALVAGE_EVENT_RE = /"event"\s*:\s*"([A-Za-z]+)"/
const SALVAGE_TS_RE = /"ts"\s*:\s*(\d{10,16})/

function salvage(text: string): SalvagedHookHead | null {
  const head = text.slice(0, 4096)
  const session = SALVAGE_SESSION_RE.exec(head)?.[1]
  const event = SALVAGE_EVENT_RE.exec(head)?.[1]
  const ts = Number(SALVAGE_TS_RE.exec(head)?.[1])
  if (!session || !SESSION_ID_RE.test(session) || !isHookEventName(event) || !Number.isFinite(ts)) return null
  return { sessionId: session.toLowerCase(), event, ts }
}

export function parseHookEnvelope(text: string): ParsedHookEnvelope {
  if (text.length > HOOK_ENVELOPE_MAX_BYTES) return { ok: false, reason: 'too_large', salvaged: salvage(text) }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { ok: false, reason: 'not_json', salvaged: salvage(text) } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not_envelope', salvaged: null }
  const r = raw as Record<string, unknown>
  const ts = Number(r.ts)
  const payload = r.payload
  if (!Number.isFinite(ts) || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'not_envelope', salvaged: salvage(text) }
  }
  if (!isHookEventName(r.event)) return { ok: false, reason: 'unknown_event', salvaged: null }
  const p = payload as Record<string, unknown>
  const sessionId = typeof p.session_id === 'string' && SESSION_ID_RE.test(p.session_id) ? p.session_id.toLowerCase() : null
  if (!sessionId) return { ok: false, reason: 'no_session', salvaged: null }
  const ppid = Number(r.ppid)
  return {
    ok: true,
    envelope: {
      ts,
      ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : null,
      event: r.event,
      sessionId,
      payload: p,
      provider: inferHookProvider(r.provider, p),
    },
  }
}

/** Pin the fingerprint the broker and the reducer share: tool name + canonical input. */
export function toolFingerprint(toolName: string, toolInput: unknown): string {
  return createHash('sha256').update(toolName).update('\0').update(canonicalJson(toolInput)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const o = value as Record<string, unknown>
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}'
}

/** The 80-char target a waiting line shows: the command, path or URL the tool was called with. */
export function toolTarget(toolInput: unknown, max = 80): string {
  if (!toolInput || typeof toolInput !== 'object') return ''
  const i = toolInput as Record<string, unknown>
  const candidate = [i.command, i.file_path, i.path, i.url, i.pattern, i.query, i.prompt, i.description]
    .find(v => typeof v === 'string' && v.trim().length > 0)
  const text = typeof candidate === 'string' ? candidate.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/** Text fields kept from a payload. Everything else is dropped before the ledger sees it. */
export const HOOK_TEXT_MAX = 400

export function clipText(value: unknown, max = HOOK_TEXT_MAX): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/**
 * What the ledger keeps of a payload. A PostToolUse carries the whole tool_response (a
 * Read can exceed 100 KB) and a Stop the whole reply; neither belongs in a durable
 * 10 MB ring. The reducer needs exactly these.
 */
export function projectHookPayload(event: HookEventName, payload: Record<string, unknown>): Record<string, unknown> {
  const str = (k: string) => (typeof payload[k] === 'string' ? payload[k] as string : undefined)
  const base: Record<string, unknown> = {
    session_id: str('session_id'),
    ...(payload.display_only === true ? { display_only: true } : {}),
    ...(str('transcript_path') ? { transcript_path: str('transcript_path') } : {}),
    ...(str('cwd') ? { cwd: str('cwd') } : {}),
    ...(str('permission_mode') ? { permission_mode: str('permission_mode') } : {}),
    ...(str('prompt_id') ? { prompt_id: str('prompt_id') } : {}),
    // 6.62.0: Codex stamps every turn-scoped event with its turn id and model.
    ...(str('turn_id') ? { turn_id: str('turn_id') } : {}),
    ...(event !== 'SessionStart' && str('model') ? { model: clipText(payload.model, 100) } : {}),
  }
  switch (event) {
    case 'SessionStart':
      return { ...base, source: str('source'), ...(str('model') ? { model: str('model') } : {}) }
    case 'SessionEnd':
      return { ...base, reason: str('reason') }
    case 'UserPromptSubmit':
      return { ...base, prompt: clipText(payload.prompt) }
    case 'Stop':
      return { ...base, last_assistant_message: clipText(payload.last_assistant_message), stop_hook_active: payload.stop_hook_active === true }
    case 'StopFailure':
      return { ...base, error: clipText(payload.error ?? payload.error_type ?? payload.message, 120), matcher: str('matcher') ?? str('error_type') }
    case 'PermissionRequest':
    case 'PermissionDenied':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const toolName = str('tool_name') ?? ''
      return {
        ...base,
        tool_name: toolName,
        tool_target: toolTarget(payload.tool_input),
        tool_fingerprint: toolFingerprint(toolName, payload.tool_input ?? null),
        ...(str('tool_use_id') ? { tool_use_id: str('tool_use_id') } : {}),
        // A sub-agent's tool events carry these (docs; unrecorded as of 2026-09-15). The
        // store reads `agent_id` to keep them from reopening the main turn, so the ledger
        // must keep it or a replay reopens what the live path did not.
        ...(str('agent_id') ? { agent_id: str('agent_id') } : {}),
        ...(str('agent_type') ? { agent_type: str('agent_type') } : {}),
        ...(event === 'PermissionRequest' && Array.isArray(payload.permission_suggestions)
          ? { permission_suggestions: payload.permission_suggestions.slice(0, 4) }
          : {}),
      }
    }
    case 'Notification':
      return { ...base, notification_type: str('notification_type'), message: clipText(payload.message, 160) }
    case 'SubagentStart':
    case 'SubagentStop':
      return { ...base, agent_id: str('agent_id'), agent_type: str('agent_type') }
    case 'PostModelSwitch':
      return { ...base, from_model: str('from_model'), to_model: str('to_model') }
    case 'PreCompact':
    case 'PostCompact':
    case 'Interrupt':
      return base
    // The thought's TEXT is never kept: the ledger is a 10 MB ring replayed at boot, and a
    // thought can quote anything the agent read. A replayed AgentThought carries nothing.
    case 'AgentThought':
      return base
  }
}
