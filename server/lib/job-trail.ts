// The Messages trail (6.52.0): a readable account of a running Messages job.
//
// WHAT IT IS. A Messages run used to show raw tool lines (`Bash: <command>`) and a stream
// of text in which the agent's narration and its final answer ran together. Sessions
// already solved "what is it doing": one grammar (session-stream-events.ts) of steps with
// a verb and a short target, the agent's own words between them, and a status. This module
// is the second, ISOLATED reader of each Messages bridge's stdout that feeds that grammar,
// and a few small mappers where an engine writes a shape the grammar does not read.
//
// ISOLATION IS THE CONTRACT. The bridges' own stdout handlers decide the final answer,
// the chunks, the activity lines and every terminal path, and they are untouched. The tee
// is a SEPARATE `data` listener registered AFTER the bridge's (the session-stream producer
// pattern), holds no state the bridge can see, and swallows its own failures. When a caller
// passes no `onTrail`, no listener is registered at all, which is the path the legacy
// `/api/query` route, openai-compat and a server with `COS_MESSAGES_TRAIL=0` all take.
//
// WHAT NEVER ENTERS THE TRAIL:
//  - a prompt. The job's own prompt echo, a replayed steer, an injected user row: none of
//    them is ever a trail entry (`fromGrammar`). The only thing a user row contributes is
//    the OUTCOME of a tool call.
//  - lifecycle status. `init`/`result`, Codex `turn.*`: the job status is authoritative,
//    and a trail that said "done" before the journal did would contradict it.
//  - model reasoning. Thinking blocks, Codex `reasoning` items and Cursor `thinking`
//    records are dropped, as the shipped copy promises.
//
// Redaction and the user's tool-activity opt-out are applied at the journal boundary and
// in the coordinator respectively (`sanitizeJobTrailDraft`, `applyTrailToolMode`), so a
// draft cannot reach the journal without both.
//
// REDACT BEFORE CUT, EVERYWHERE (QA round 1). A secret straddling a cut is a prefix no
// pattern recognises any more, so the readers redact every visible field in full BEFORE the
// grammar or a mapper shortens it (`preRedactClaudeRecord`, `trailLine`, `secretFree`), and
// the journal boundary redacts again. Every redaction reads at most
// REDACTION_SCAN_MAX_CHARS, cut at a token boundary, so no input can make a regex run long.

import { StringDecoder } from 'node:string_decoder'
import { boundForRedaction, redactSecretText } from './activity-preview.js'
import { redactQueryJobText } from './query-job-types.js'
import {
  DETAIL_MAX_CHARS,
  TARGET_MAX_CHARS,
  TRUNCATION_MARK,
  basename,
  codexExecCommandOutcome,
  codexExecCommandText,
  commandSummary,
  draftsFromRecord,
  oneLine,
  targetForTool,
  verbForToolName,
  type SessionStreamDraft,
  type SessionStreamVerb,
  type ToolOutcome,
} from './session-stream-events.js'
import { createLineAssembler } from './session-stream-producer.js'

export type JobTrailProvider = 'claude' | 'codex' | 'cursor'

/**
 * One trail entry, before transport stamps.
 *
 * The SAME kinds and fields as the Sessions grammar, so the app renders both with one
 * reducer. Two differences, both narrowing: there is no `prompt` kind (see the header), and
 * `status` is always `working` because lifecycle belongs to the job. `status` carries either
 * a `tool_outcome` (the result of the step before it) or a `detail`: Claude Code's own
 * readable step line (`task_summary.detail`, `post_turn_summary.status_detail`), which is an
 * extra field on an existing kind rather than a new kind, the grammar's rule for additions.
 */
export type JobTrailDraft =
  | { kind: 'tool'; verb: SessionStreamVerb; target: string; detail: string; call?: string }
  | { kind: 'prose'; text: string }
  | { kind: 'status'; state: 'working'; tool_outcome?: ToolOutcome; detail?: string; needs_action?: string }

export const JOB_TRAIL_VERBS: readonly SessionStreamVerb[] = ['read', 'edit', 'write', 'bash', 'search', 'task', 'other']

/** Per prose entry. The app keeps 2,000 of a Sessions prose (its own cap), so the trail
 * journals no more than a client will ever show. */
export const TRAIL_PROSE_MAX_CHARS = 2_000

/** Claude Code's step and summary lines are one sentence; this is room for two. */
export const TRAIL_STATUS_MAX_CHARS = 160

const CALL_ID_RE = /^[A-Za-z0-9_-]{4,96}$/
const CONTROL_EXCEPT_NEWLINE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function callId(value: unknown): string | undefined {
  return typeof value === 'string' && CALL_ID_RE.test(value) ? value : undefined
}

function lineCount(value: unknown): number {
  if (typeof value !== 'string') return 0
  const text = value.replace(/\n+$/, '')
  return text.length === 0 ? 0 : text.split('\n').length
}

function linesDetail(value: unknown): string {
  const lines = lineCount(value)
  return lines === 0 ? 'no output' : `${lines} line${lines === 1 ? '' : 's'}`
}

function parseRecord(line: string): Record<string, unknown> | null {
  const trimmed = typeof line === 'string' ? line.trim() : ''
  if (!trimmed || trimmed[0] !== '{') return null
  try {
    return asRecord(JSON.parse(trimmed))
  } catch {
    return null
  }
}

// ─── The user's opt-out ───

export type JobTrailToolMode = 'off' | 'status' | 'preview'

/** A failed step's detail that is DERIVED (a status or a count), never output text. */
const DERIVED_FAILURE_DETAIL_RE = /^(?:|exit -?\d+|denied|interrupted|timeout|not found|failed|error)$/

/**
 * The job's `activityToolMode`, applied to one draft. Null means drop it.
 *
 *   off      prose only. Every `tool` draft goes, every step outcome, and Claude Code's
 *            own step line and `needs_action` too, since each of them names a step. The
 *            user turned tool activity off; the agent's own words stay.
 *   status   steps with their verb and short target (a basename, a command summary, a
 *            pattern: the grammar never carries raw input), and outcomes as derived
 *            tokens only. A failure whose detail is text the tool wrote is shown as
 *            `error`, because that text is raw output.
 *   preview  the full grammar, including the first words of a failure.
 *
 * Every mode still passes through `sanitizeJobTrailDraft` before the journal.
 */
export function applyTrailToolMode(draft: JobTrailDraft, mode: JobTrailToolMode): JobTrailDraft | null {
  if (draft.kind === 'prose') return draft
  // QA round 1: Claude Code's step line (`detail`) and `needs_action` name the step too
  // ("Running npm test"), so `off` keeps the agent's own words and nothing else.
  if (mode === 'off') return null
  if (mode === 'preview') return draft
  if (draft.kind === 'status' && draft.tool_outcome && !draft.tool_outcome.ok
    && !DERIVED_FAILURE_DETAIL_RE.test(draft.tool_outcome.detail)) {
    return { ...draft, tool_outcome: { ...draft.tool_outcome, detail: 'error' } }
  }
  return draft
}

// ─── The journal boundary ───

/** The bounded head a redaction reads, carriage returns folded and control bytes out. */
function scannable(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return ''
  const { head } = boundForRedaction(value)
  return head.replace(/\r\n?/g, '\n').replace(CONTROL_EXCEPT_NEWLINE_RE, ' ')
}

/** Both redaction layers, in order, on raw text: private-material blocks and provider
 * secrets (activity-preview), then the store's credential and local-path patterns. Runs
 * BEFORE any flattening or cutting, so a multi-line key block is caught whole and a secret
 * is never half-cut into a visible prefix. */
function redacted(value: unknown): string {
  const plain = scannable(value)
  return plain ? redactQueryJobText(redactSecretText(plain)) : ''
}

/** Secrets out and nothing else: for a path the caller will shorten to its basename (the
 * local-path layer would turn the whole path into `[path]` first). */
function secretFree(value: unknown): string {
  const plain = scannable(value)
  return plain ? redactSecretText(plain) : ''
}

function trailLine(value: unknown, max: number): string {
  return oneLine(redacted(value), max)
}

function trailBlock(value: unknown, max: number): string {
  const text = redacted(value).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - TRUNCATION_MARK.length)).trimEnd() + TRUNCATION_MARK
}

function sanitizeOutcome(raw: unknown): ToolOutcome | undefined {
  const r = asRecord(raw)
  if (!r || typeof r.ok !== 'boolean') return undefined
  const call = callId(r.call)
  return { ok: r.ok, detail: trailLine(r.detail, DETAIL_MAX_CHARS), ...(call ? { call } : {}) }
}

/**
 * The only shape a trail row may have in the journal, from anything.
 *
 * Every text field is redacted (`redacted`) and then capped; `verb` is held to the closed
 * set; a call id must look like one. Idempotent, so hydration runs it again on every row a
 * journal holds and a rule added later applies to rows written earlier. Null means the row
 * says nothing worth keeping (empty prose, a lifecycle status, an unnamed step).
 */
export function sanitizeJobTrailDraft(raw: unknown): JobTrailDraft | null {
  const r = asRecord(raw)
  if (!r) return null
  if (r.kind === 'prose') {
    const text = trailBlock(r.text, TRAIL_PROSE_MAX_CHARS)
    return text ? { kind: 'prose', text } : null
  }
  if (r.kind === 'tool') {
    const verb = JOB_TRAIL_VERBS.includes(r.verb as SessionStreamVerb) ? r.verb as SessionStreamVerb : 'other'
    const target = trailLine(r.target, TARGET_MAX_CHARS)
    if (!target) return null
    const call = callId(r.call)
    return { kind: 'tool', verb, target, detail: trailLine(r.detail, DETAIL_MAX_CHARS), ...(call ? { call } : {}) }
  }
  if (r.kind === 'status') {
    if (r.state !== 'working') return null
    const outcome = sanitizeOutcome(r.tool_outcome)
    const detail = trailLine(r.detail, TRAIL_STATUS_MAX_CHARS)
    const needs = trailLine(r.needs_action, TRAIL_STATUS_MAX_CHARS)
    if (!outcome && !detail && !needs) return null
    return {
      kind: 'status',
      state: 'working',
      ...(outcome ? { tool_outcome: outcome } : {}),
      ...(detail ? { detail } : {}),
      ...(needs ? { needs_action: needs } : {}),
    }
  }
  return null
}

/** A journaled trail event's data back into its parts, or null (a malformed row). */
export function parseJobTrailEventData(raw: unknown): { trailSeq: number; draft: JobTrailDraft } | null {
  const r = asRecord(raw)
  if (!r) return null
  const trailSeq = r.trailSeq
  if (typeof trailSeq !== 'number' || !Number.isSafeInteger(trailSeq) || trailSeq < 1) return null
  const { trailSeq: _trailSeq, ...rest } = r
  const draft = sanitizeJobTrailDraft(rest)
  return draft ? { trailSeq, draft } : null
}

/** Characters of text a trail entry holds, for the snapshot's size bound. */
export function jobTrailTextChars(draft: JobTrailDraft): number {
  if (draft.kind === 'prose') return draft.text.length
  if (draft.kind === 'tool') return draft.target.length + draft.detail.length
  return (draft.detail?.length ?? 0) + (draft.needs_action?.length ?? 0) + (draft.tool_outcome?.detail.length ?? 0)
}

// ─── Readers: one stdout line to zero or more drafts ───

export interface JobTrailReader {
  /** One complete stdout line. Never throws. */
  line(line: string): void
  /** End of stream: flush anything held for coalescing. */
  end(): void
}

/**
 * The Sessions grammar's output, narrowed to what a trail may carry.
 *
 * `prompt` is the ONE place a person's words could enter the trail, and it never does:
 * the job's own prompt echo (and, from Phase 4, a replayed steer with its attachment block,
 * image paths or the ULTRACODE keyword) is dropped here, whatever uuid it carries.
 */
function fromGrammar(draft: SessionStreamDraft): JobTrailDraft | null {
  switch (draft.kind) {
    case 'tool':
      return { kind: 'tool', verb: draft.verb, target: draft.target, detail: draft.detail, ...(draft.call ? { call: draft.call } : {}) }
    case 'prose':
      return { kind: 'prose', text: draft.text }
    case 'status':
      // Lifecycle (`init` working, `result` done) is the job's; only an outcome rides.
      return draft.tool_outcome ? { kind: 'status', state: 'working', tool_outcome: draft.tool_outcome } : null
    case 'prompt':
      return null
    default:
      return null
  }
}

/** Tool-input keys a step's TARGET is read from (see `targetForTool`), and the path keys
 * that are shortened to a basename. Every other key (file contents, edit strings) only
 * ever yields a count, so it is left as is. */
const TARGET_TEXT_KEYS = ['command', 'cmd', 'pattern', 'query', 'skill', 'description', 'subject', 'prompt', 'url'] as const
const TARGET_PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const

function preRedactToolInput(input: unknown): unknown {
  const args = asRecord(input)
  if (!args) return input
  const out: Record<string, unknown> = { ...args }
  for (const key of TARGET_PATH_KEYS) if (typeof args[key] === 'string') out[key] = secretFree(args[key])
  for (const key of TARGET_TEXT_KEYS) if (typeof args[key] === 'string') out[key] = redacted(args[key])
  return out
}

/**
 * A Claude record with every field the grammar turns into VISIBLE text redacted in full,
 * before the grammar cuts it: text blocks (prose), a tool_use's target fields, and an
 * error result's text (the first words of a failure). A successful result is left whole:
 * the grammar reads only counts from it, and bounding it would change those counts.
 */
function preRedactClaudeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const message = asRecord(record.message)
  if (!message || !Array.isArray(message.content)) return record
  const content = message.content.map(raw => {
    const block = asRecord(raw)
    if (!block) return raw
    if (block.type === 'text' && typeof block.text === 'string') return { ...block, text: redacted(block.text) }
    if (block.type === 'tool_use') return { ...block, input: preRedactToolInput(block.input) }
    if (block.type === 'tool_result' && block.is_error === true) {
      if (typeof block.content === 'string') return { ...block, content: redacted(block.content) }
      if (Array.isArray(block.content)) {
        return { ...block, content: block.content.map(part => {
          const p = asRecord(part)
          return p && typeof p.text === 'string' ? { ...p, text: redacted(p.text) } : part
        }) }
      }
    }
    return raw
  })
  return { ...record, message: { ...message, content } }
}

/**
 * Claude (`claude -p --output-format stream-json --verbose`).
 *
 * Measured on Claude Code 2.1.278 (canary capture, 2026-09-19): every content block is its
 * OWN `assistant` record, and the blocks of one model message share `message.id`. So prose
 * is held per message id and flushed at the first line that is not more text of the same
 * message: one prose entry per assistant message, never one per streamed delta (deltas are
 * `stream_event` rows, which only ever flush). `post_turn_summary` arrives before `result`.
 *
 * A subagent's records carry `parent_tool_use_id`; its steps are shown, its prose is not
 * (those are not the agent's words to the user).
 */
function createClaudeReader(emit: (draft: JobTrailDraft) => void): JobTrailReader {
  let pending: { key: string; text: string } | null = null
  let lastStatus = ''
  const flush = () => {
    if (!pending) return
    const text = pending.text
    pending = null
    emit({ kind: 'prose', text })
  }
  const status = (detail: string, needs: string) => {
    if (!detail && !needs) return
    const key = `${detail}\n${needs}`
    // Claude Code repeats a task summary while one step runs; the trail says it once.
    if (key === lastStatus) return
    lastStatus = key
    emit({ kind: 'status', state: 'working', ...(detail ? { detail } : {}), ...(needs ? { needs_action: needs } : {}) })
  }
  return {
    line(raw) {
      const record = parseRecord(raw)
      if (!record) return
      const type = str(record.type)
      if (type === 'stream_event') {
        const inner = asRecord(record.event)
        const innerType = str(inner?.type)
        const block = asRecord(inner?.content_block)
        if (innerType === 'message_start' || innerType === 'message_stop'
          || (innerType === 'content_block_start' && block?.type !== 'text')) flush()
        return
      }
      if (type === 'assistant') {
        const message = asRecord(record.message)
        const key = str(message?.id)
        const subagent = str(record.parent_tool_use_id).length > 0
        for (const draft of draftsFromRecord('claude', preRedactClaudeRecord(record))) {
          const mapped = fromGrammar(draft)
          if (!mapped) continue
          if (mapped.kind === 'prose') {
            if (subagent) continue
            if (pending && (!key || pending.key !== key)) flush()
            pending = pending ? { key, text: `${pending.text}\n\n${mapped.text}` } : { key, text: mapped.text }
            continue
          }
          flush()
          emit(mapped)
        }
        return
      }
      flush()
      if (type === 'user') {
        for (const draft of draftsFromRecord('claude', preRedactClaudeRecord(record))) {
          const mapped = fromGrammar(draft)
          if (mapped) emit(mapped)
        }
        return
      }
      if (type === 'system') {
        if (record.subtype === 'task_summary') {
          status(trailLine(record.detail, TRAIL_STATUS_MAX_CHARS), '')
        } else if (record.subtype === 'post_turn_summary') {
          status(trailLine(record.status_detail, TRAIL_STATUS_MAX_CHARS), trailLine(record.needs_action, TRAIL_STATUS_MAX_CHARS))
        }
      }
      // `result`, `init`, `rate_limit_event`, `thinking_tokens`: the job status is authoritative.
    },
    end: flush,
  }
}

// The shell-wrapper and outcome rules are the Sessions grammar's (it reads the same live
// `codex exec --json` stream for a Continue turn), shared rather than copied.
const codexCommandText = codexExecCommandText
const codexCommandOutcome = codexExecCommandOutcome

function outcomeDraft(outcome: Omit<ToolOutcome, 'call'>, call?: string): JobTrailDraft {
  return { kind: 'status', state: 'working', tool_outcome: { ...outcome, ...(call ? { call } : {}) } }
}

/**
 * Codex (`codex exec --json`).
 *
 * Field names measured from the shipped binary's serde strings (ChatGPT.app's `codex`,
 * 2026-09-19), and for the lifecycle events, `agent_message` and `command_execution`
 * confirmed by a real 0.155.0 run (`__fixtures__/codex-exec-json-0.155.0.jsonl`; the other
 * item kinds are still the serde-string reading): events `item.started|updated|completed`, items `agent_message`, `reasoning`,
 * `command_execution` (`command`, `aggregated_output`, `exit_code`, `status`), `file_change`
 * (`changes[{path,kind: add|delete|update}]`, `status`), `mcp_tool_call` (`server`, `tool`,
 * `status`, `error`), `web_search` (`query`), `todo_list`. The `{type, item:{...}}` nesting is
 * the one the bridge and its tests already read. An agent message is complete when it
 * arrives, so it is one prose entry as is. Each step is announced once per item id, at
 * start when there is one, and its outcome follows at completion. Anything else is dropped,
 * `reasoning` by contract and newer item kinds conservatively.
 *
 * A row that is not an exec item event (an older `{msg:{...}}` wrapper, a rollout row) goes
 * through the Sessions grammar, which reads those shapes.
 */
function createCodexReader(emit: (draft: JobTrailDraft) => void): JobTrailReader {
  const announced = new Set<string>()
  const announce = (id: string, steps: JobTrailDraft[]) => {
    if (id) {
      if (announced.has(id)) return
      announced.add(id)
    }
    for (const step of steps) emit(step)
  }
  const item = (eventType: string, raw: Record<string, unknown>) => {
    const id = str(raw.id)
    const call = callId(id)
    const done = eventType === 'item.completed'
    switch (str(raw.type)) {
      case 'agent_message': {
        // Bounded before anything else reads it: the journal boundary redacts this text, and
        // no regex is ever handed an unbounded message.
        const text = boundForRedaction(str(raw.text)).head
        if (done && text.trim()) emit({ kind: 'prose', text })
        return
      }
      case 'command_execution': {
        const command = oneLine(commandSummary(redacted(codexCommandText(raw.command))), TARGET_MAX_CHARS)
        announce(id, [{ kind: 'tool', verb: 'bash', target: command || 'shell', detail: '', ...(call ? { call } : {}) }])
        if (done) emit(outcomeDraft(codexCommandOutcome(raw), call))
        return
      }
      case 'file_change': {
        const changes = (Array.isArray(raw.changes) ? raw.changes : [])
          .map(asRecord)
          .filter((change): change is Record<string, unknown> => change !== null)
          .slice(0, 5)
        announce(id, changes.map((change): JobTrailDraft => {
          const name = oneLine(basename(secretFree(change.path)), TARGET_MAX_CHARS) || 'file'
          if (change.kind === 'add') return { kind: 'tool', verb: 'write', target: name, detail: '' }
          if (change.kind === 'delete') return { kind: 'tool', verb: 'other', target: oneLine(`delete ${name}`, TARGET_MAX_CHARS), detail: '' }
          return { kind: 'tool', verb: 'edit', target: name, detail: '' }
        }))
        if (done) {
          const failed = raw.status === 'failed'
          for (const change of changes) {
            const detail = failed ? 'failed' : change.kind === 'add' ? 'created' : change.kind === 'delete' ? 'deleted' : 'edited'
            emit(outcomeDraft({ ok: !failed, detail }))
          }
        }
        return
      }
      case 'mcp_tool_call': {
        const name = [str(raw.server), str(raw.tool)].filter(Boolean).join('.')
        announce(id, [{ kind: 'tool', verb: 'other', target: trailLine(name, TARGET_MAX_CHARS) || 'mcp tool', detail: '', ...(call ? { call } : {}) }])
        if (done) {
          const failed = raw.status === 'failed' || (raw.error != null && raw.error !== '')
          emit(outcomeDraft({ ok: !failed, detail: failed ? 'failed' : '' }, call))
        }
        return
      }
      case 'web_search': {
        const query = trailLine(raw.query, TARGET_MAX_CHARS)
        // A search can start before its query is known; announce it once the query is.
        if (!query && !done) return
        announce(id, [{ kind: 'tool', verb: 'search', target: query || 'web search', detail: '', ...(call ? { call } : {}) }])
        if (done) emit(outcomeDraft({ ok: true, detail: '' }, call))
        return
      }
      default:
        return
    }
  }
  return {
    line(raw) {
      const record = parseRecord(raw)
      if (!record) return
      const type = str(record.type)
      if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
        const body = asRecord(record.item)
        if (body) item(type, body)
        return
      }
      // `thread.started`, `turn.started|completed|failed`: lifecycle, the job's.
      if (type.includes('.')) return
      for (const draft of draftsFromRecord('codex', record)) {
        const mapped = fromGrammar(draft)
        if (mapped) emit(mapped)
      }
    },
    end() {},
  }
}

/** Cursor tool-call keys (canonical protobuf JSON of `ToolCall`, measured from the
 * 2026.09.15 agent bundle's descriptors) to the grammar's tool names. Anything absent is an
 * `other` step named by its key. */
const CURSOR_TOOL_NAMES: Readonly<Record<string, string>> = {
  shellToolCall: 'Bash',
  piBashToolCall: 'Bash',
  editToolCall: 'Edit',
  piEditToolCall: 'Edit',
  applyAgentDiffToolCall: 'Edit',
  piWriteToolCall: 'Write',
  readToolCall: 'Read',
  piReadToolCall: 'Read',
  grepToolCall: 'Grep',
  piGrepToolCall: 'Grep',
  globToolCall: 'Glob',
  piFindToolCall: 'Glob',
  semSearchToolCall: 'Search',
  webSearchToolCall: 'WebSearch',
  webFetchToolCall: 'WebFetch',
  taskToolCall: 'Task',
}

const CURSOR_FILE_TOOLS = new Set(['Read', 'Edit', 'Write'])

function cursorStep(key: string, args: Record<string, unknown>, call?: string): JobTrailDraft {
  const canonical = CURSOR_TOOL_NAMES[key]
  const readable = key.replace(/ToolCall$/, '')
  if (!canonical) {
    const named = key === 'mcpToolCall' ? str(args.toolName) || str(args.name) : ''
    return { kind: 'tool', verb: 'other', target: trailLine(named || readable, TARGET_MAX_CHARS) || 'tool', detail: '', ...(call ? { call } : {}) }
  }
  // Redacted in full before `targetForTool` shortens them.
  const input: Record<string, unknown> = {
    ...(CURSOR_FILE_TOOLS.has(canonical) ? { file_path: secretFree(str(args.path) || str(args.filePath) || str(args.targetFile)) } : {}),
    command: redacted(str(args.command)),
    pattern: redacted(str(args.pattern) || str(args.globPattern) || str(args.query) || str(args.searchTerm) || str(args.url)),
    description: redacted(str(args.description)),
  }
  const target = targetForTool(canonical, input) || readable
  return { kind: 'tool', verb: verbForToolName(canonical), target, detail: '', ...(call ? { call } : {}) }
}

/** A Cursor result oneof (`success`, `failure` with `exitCode`, `timeout`, `rejected`,
 * `permissionDenied`, `fileNotFound`, `error`, ...) to a derived token. Never output text. */
function cursorOutcome(key: string, result: unknown): Omit<ToolOutcome, 'call'> {
  const r = asRecord(result)
  if (!r) return { ok: true, detail: '' }
  const success = asRecord(r.success)
  if (success) return { ok: true, detail: CURSOR_TOOL_NAMES[key] === 'Bash' ? linesDetail(success.stdout) : '' }
  const failure = asRecord(r.failure)
  if (failure) return { ok: false, detail: typeof failure.exitCode === 'number' ? `exit ${failure.exitCode}` : 'failed' }
  if ('timeout' in r) return { ok: false, detail: 'timeout' }
  if ('rejected' in r || 'permissionDenied' in r || 'readPermissionDenied' in r || 'writePermissionDenied' in r) {
    return { ok: false, detail: 'denied' }
  }
  if ('fileNotFound' in r) return { ok: false, detail: 'not found' }
  if ('error' in r || 'spawnError' in r || 'invalidFile' in r) return { ok: false, detail: 'error' }
  return { ok: true, detail: '' }
}

/**
 * Cursor (`agent -p --output-format stream-json --stream-partial-output`).
 *
 * Measured from the 2026.09.15 agent bundle: with partial output on, every text delta is
 * an `assistant` record WITH `timestamp_ms` and no `model_call_id`; right before each
 * `tool_call started` the CLI flushes the whole segment as one `assistant` record carrying
 * `model_call_id`, and before `result` it flushes the last segment with NO `timestamp_ms`.
 * Those two flush records are the coalesced prose: exactly one entry per segment, and the
 * deltas are never read. (A flush before a `retry` record carries a timestamp and no model
 * call id, the same as a delta, so the trail skips that one segment; the answer is not
 * affected.)
 *
 * The prompt echo (a `user` record), `thinking` records and lifecycle rows are dropped.
 */
function createCursorReader(emit: (draft: JobTrailDraft) => void): JobTrailReader {
  const announced = new Set<string>()
  return {
    line(raw) {
      const record = parseRecord(raw)
      if (!record) return
      const type = str(record.type)
      if (type === 'assistant') {
        const segment = (record.model_call_id != null && record.model_call_id !== '') || typeof record.timestamp_ms !== 'number'
        if (!segment) return
        for (const draft of draftsFromRecord('cursor', preRedactClaudeRecord(record))) {
          if (draft.kind === 'prose') emit({ kind: 'prose', text: draft.text })
        }
        return
      }
      if (type !== 'tool_call') return
      const toolCall = asRecord(record.tool_call)
      if (!toolCall) return
      const key = Object.keys(toolCall).find(name => /ToolCall$/.test(name))
      if (!key) return
      const body = asRecord(toolCall[key]) ?? {}
      const call = callId(record.call_id)
      const seen = call ? announced.has(call) : false
      if (record.subtype === 'started') {
        if (seen) return
        if (call) announced.add(call)
        emit(cursorStep(key, asRecord(body.args) ?? {}, call))
        return
      }
      if (record.subtype === 'completed') {
        if (call && !seen) {
          announced.add(call)
          emit(cursorStep(key, asRecord(body.args) ?? {}, call))
        }
        emit(outcomeDraft(cursorOutcome(key, body.result), call))
      }
    },
    end() {},
  }
}

export function createJobTrailReader(provider: JobTrailProvider, emit: (draft: JobTrailDraft) => void): JobTrailReader {
  if (provider === 'codex') return createCodexReader(emit)
  if (provider === 'cursor') return createCursorReader(emit)
  return createClaudeReader(emit)
}

// ─── The tee ───

/**
 * Process-wide counters for `/api/health` (`messages_trail`): stdout lines the readers were
 * handed, entries they emitted, and failures they swallowed (a reader that throws, or a
 * consumer that does). Counts and a timestamp only, never text.
 */
const trailStats = { linesRead: 0, entriesEmitted: 0, readerErrors: 0, lastErrorAt: null as number | null }

function noteTrailError(): void {
  trailStats.readerErrors++
  trailStats.lastErrorAt = Date.now()
}

export interface JobTrailStats {
  linesRead: number
  entriesEmitted: number
  readerErrors: number
  lastErrorAt: string | null
}

export function jobTrailStats(): JobTrailStats {
  return {
    linesRead: trailStats.linesRead,
    entriesEmitted: trailStats.entriesEmitted,
    readerErrors: trailStats.readerErrors,
    lastErrorAt: trailStats.lastErrorAt === null ? null : new Date(trailStats.lastErrorAt).toISOString(),
  }
}

export function __resetJobTrailStatsForTests(): void {
  trailStats.linesRead = 0
  trailStats.entriesEmitted = 0
  trailStats.readerErrors = 0
  trailStats.lastErrorAt = null
}

/** The part of a child's stdout the tee uses. A Node Readable fits, and so does the plain
 * EventEmitter the bridge tests fake a child with. */
export interface JobTrailStream {
  on(event: string, listener: (...args: any[]) => void): unknown
}

/**
 * Attach the trail as a SECOND reader of a bridge's stdout.
 *
 * Call it AFTER the bridge registers its own `data` listener, so the bridge sees every chunk
 * first and its behaviour cannot depend on this one. With no `onTrail` it registers nothing,
 * which is how every caller without a trail consumer keeps exactly the 6.51.0 stream. The
 * listener never throws into the stream: a bad line costs its own drafts and nothing else.
 */
export function teeJobTrail(
  stream: JobTrailStream | null | undefined,
  provider: JobTrailProvider,
  onTrail?: (draft: JobTrailDraft) => void,
): void {
  if (!onTrail || !stream) return
  const emit = (draft: JobTrailDraft) => {
    try {
      onTrail(draft)
      trailStats.entriesEmitted++
    } catch {
      /* the trail is observation; it never affects the run that produced it */
      noteTrailError()
    }
  }
  const reader = createJobTrailReader(provider, emit)
  const decoder = new StringDecoder('utf8')
  const assembler = createLineAssembler()
  let ended = false
  const readLine = (line: string) => {
    trailStats.linesRead++
    try { reader.line(line) } catch { noteTrailError() /* one line */ }
  }
  const feed = (text: string) => {
    for (const line of assembler.push(text)) readLine(line)
  }
  stream.on('data', (chunk: unknown) => {
    if (ended) return
    try {
      feed(typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? decoder.write(chunk) : '')
    } catch { noteTrailError() /* one chunk */ }
  })
  const finish = () => {
    if (ended) return
    ended = true
    try {
      feed(decoder.end())
      for (const line of assembler.flush()) readLine(line)
      reader.end()
    } catch { noteTrailError() /* end of an observation */ }
  }
  stream.on('end', finish)
  stream.on('close', finish)
}

// ─── Ollama: the server owns the loop, so the bridge calls these directly ───

/** One Ollama tool call as a step. The COS tools are searches and a meeting read. */
export function ollamaTrailStep(name: string, args: Record<string, unknown>): JobTrailDraft {
  if (name === 'search_meetings' || name === 'search_memories') {
    return { kind: 'tool', verb: 'search', target: trailLine(args.query, TARGET_MAX_CHARS) || name, detail: '' }
  }
  if (name === 'read_meeting') {
    return { kind: 'tool', verb: 'read', target: oneLine(basename(secretFree(args.filename)), TARGET_MAX_CHARS) || name, detail: '' }
  }
  return { kind: 'tool', verb: 'other', target: trailLine(name, TARGET_MAX_CHARS) || 'tool', detail: '' }
}

/** Its outcome: the tools answer an error as `{"error": ...}` or `unknown tool ...`. */
export function ollamaTrailOutcome(result: string): JobTrailDraft {
  const failed = /^\s*\{\s*"error"\s*:/.test(result) || /^unknown tool\b/.test(result)
  return outcomeDraft({ ok: !failed, detail: failed ? 'error' : '' })
}
