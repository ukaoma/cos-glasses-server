// The event grammar for a live agent session.
//
// ONE grammar, TWO sources. Phase 1 feeds it the NDJSON a COS-spawned `claude -p
// --output-format stream-json` writes to stdout; Phase 2 feeds it the JSONL records
// a desktop session appends to its transcript. For Claude those are the SAME record
// shape — `{type:'assistant', message:{content:[...]}}` — which is why the two phases
// can share one mapper instead of two that drift.
//
// PURE ON PURPOSE. No clock, no filesystem, no bus, no I/O. `seq` and `at` are
// stamped by the transport, so every function here is a total function of its input
// and can be tested by execution rather than by reading the source. That is the whole
// reason the grammar is a separate module from the wiring: source-shape tests cannot
// observe a mapping being wrong, and this is the part that CAN be wrong.
//
// THE CLOSED SETS ARE THE CONTRACT. `kind`, `state` and `verb` are fixed vocabularies
// the client renders against. An unrecognised tool is NEVER a new verb: it is `other`
// carrying its real name in `target`, so a provider adding a tool tomorrow degrades to
// a readable line instead of an unrenderable one.

/** Closed set. A provider tool name that is not in the table maps to `other`. */
export type SessionStreamVerb = 'read' | 'edit' | 'write' | 'bash' | 'search' | 'task' | 'other'

/** Closed set. */
export type SessionStreamState = 'working' | 'idle' | 'done'

export type SessionStreamDraft =
  | { kind: 'tool'; verb: SessionStreamVerb; target: string; detail: string }
  // The user's own words for the turn being worked on. Miles: "we should see the query
  // that the user has versus it just being a blank slate where it says working. That
  // way, the user at least knows what the agent is actively working on."
  //
  // ADDITIVE TO A CLOSED SET, AND SAFE BY CONSTRUCTION: the client validates `kind`
  // against its own table and ignores anything it does not know, so a build that
  // predates this renders exactly as it did before rather than breaking.
  | { kind: 'prompt'; text: string }
  | { kind: 'prose'; text: string }
  | { kind: 'status'; state: SessionStreamState }
  | { kind: 'heartbeat' }

/** A draft plus the transport's stamps. This is the JSON on the wire. */
export type SessionStreamEvent = SessionStreamDraft & { seq: number; at: number }

/** Providers whose records this grammar understands. */
export type SessionStreamProvider = 'claude' | 'codex' | 'cursor'

/**
 * Prose ceiling.
 *
 * Matches `LATEST_REPLY_MAX` in agent-session-store.ts, which is what the polled
 * detail payload already carries, so the streamed view and the polled view agree on
 * how much of a reply a client ever sees. It also stops a single 587 KB transcript
 * record — four of them exist in this Mac's largest transcript — from being written
 * down an SSE pipe in one frame.
 */
export const PROSE_MAX_CHARS = 4_000

/** A tool target is one glanceable line on a 576x288 lens, never a paragraph. */
export const TARGET_MAX_CHARS = 80

/** `+14 -2`, `120 lines`. Anything longer is not a detail. */
export const DETAIL_MAX_CHARS = 40

/**
 * The user's query, in characters.
 *
 * 160 rather than the 80 a target gets: this is the one line that says WHAT IS BEING
 * WORKED ON, so it earns more than a tool name does. The client clips it to the two
 * lens lines it can spare, which at 62 columns is ~120 visible; the extra 40 is
 * headroom so the client rather than the server decides where to cut.
 */
export const PROMPT_MAX_CHARS = 160

/**
 * Marker appended when a value was cut.
 *
 * Three ASCII periods, not the single-character ellipsis: the G2 font has a limited
 * glyph table and an unmapped character renders as tofu, which is worse than the
 * truncation it is announcing.
 */
export const TRUNCATION_MARK = '...'

/**
 * Tool name to verb.
 *
 * Exact names, not prefixes or fuzzy matching. `BashOutput` is not `bash`: it is a
 * different action, and collapsing it would make the HUD claim a command ran when it
 * was only being read. Anything absent here is deliberately `other`.
 */
const VERB_BY_TOOL: Readonly<Record<string, SessionStreamVerb>> = {
  read: 'read',
  notebookread: 'read',
  strreplace: 'edit',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  write: 'write',
  bash: 'bash',
  shell: 'bash',
  exec: 'bash',
  exec_command: 'bash',
  local_shell_call: 'bash',
  grep: 'search',
  glob: 'search',
  search: 'search',
  websearch: 'search',
  webfetch: 'search',
  toolsearch: 'search',
  task: 'task',
  agent: 'task',
  skill: 'task',
}

export function verbForToolName(name: unknown): SessionStreamVerb {
  if (typeof name !== 'string') return 'other'
  return VERB_BY_TOOL[name.trim().toLowerCase()] ?? 'other'
}

/** Collapse to one line and cap. Every client-visible string passes through here. */
export function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, Math.max(0, max - TRUNCATION_MARK.length)) + TRUNCATION_MARK
}

/** Last path segment. A full path is unreadable on the lens and leaks the tree. */
export function basename(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0) return ''
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function countLines(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0) return 0
  return value.split('\n').length
}

/**
 * The part of a shell command worth 40 columns.
 *
 * WHAT WENT WRONG ON HARDWARE. Miles's 9:20 screenshot showed `bash ses...` and
 * `bash s...` -- a shell command reduced to two characters. Two causes compounding:
 * the raw command was sent whole, and the CLIENT then treated it as a PATH and kept
 * only the text after the last `/`. So `cd /Users/.../cos-glasses-app && grep -n x
 * src/lib/session-stream-trail.ts` arrived, got split on its final slash, and rendered
 * as the tail of a filename. The client fix is necessary; this is the other half.
 *
 * WHAT IT DROPS, in order of how much noise it removes:
 *  - a leading `cd <path>` and its separator. Every command in this repo starts with
 *    one and it is the same directory every time: pure cost, zero information.
 *  - heredoc BODIES. A `<<'PY' ... PY` block is often hundreds of lines, and none of
 *    them is the command; the marker is kept so it is clear a script ran inline.
 *  - `2>&1`, pipes into output plumbing (`head`, `tail`, `sed`, `tr`, `cut`) and
 *    redirections, which are how you read a command rather than what it does.
 *
 * WHAT IT KEEPS: the first real verb and its arguments, which is what you would look
 * for on a monitor over someone's shoulder.
 */
export function commandSummary(command: string): string {
  let text = command.replace(/\r/g, '')

  // Heredoc body out, marker kept: `python3 - <<'PY' ...body... PY` -> `python3 - <<PY`
  text = text.replace(/<<-?\s*'?"?([A-Za-z_][A-Za-z0-9_]*)'?"?[\s\S]*?^\1\s*$/gm, '<<$1')
  text = text.replace(/<<-?\s*'?"?([A-Za-z_][A-Za-z0-9_]*)'?"?[\s\S]*$/m, '<<$1')

  text = text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()

  // Leading `cd <path>` plus its separator, however the command chained it. Repeated
  // because a command can open with more than one.
  for (let i = 0; i < 3; i++) {
    const next = text.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;|\|\||\n)?\s*/, '')
    if (next === text) break
    text = next
  }

  // Output plumbing off the end. The command is what ran, not how it was read.
  text = text.replace(/\s*2>&1\s*/g, ' ')
  text = text.replace(/\s*\|\s*(?:head|tail|sed|tr|cut|wc|sort|uniq|grep -o|cat)\b[^|]*/g, '')
  text = text.replace(/\s*>\s*\/dev\/null(?:\s*2>&1)?/g, '')

  const flat = text.replace(/\s{2,}/g, ' ').trim()
  return flat.length > 0 ? flat : command.trim()
}

/**
 * What this tool acted ON.
 *
 * A basename for file tools, the command for a shell, the pattern for a search, the
 * description for a delegated task. For `other` the caller substitutes the real tool
 * name, because a verb of `other` with an empty target says nothing at all.
 */
export function targetForTool(name: unknown, input: unknown): string {
  const toolName = typeof name === 'string' ? name.trim() : ''
  const args = asRecord(input)
  if (!args) return ''
  const lower = toolName.toLowerCase()

  const filePath = args.file_path ?? args.path ?? args.notebook_path
  if (typeof filePath === 'string' && filePath.length > 0) return oneLine(basename(filePath), TARGET_MAX_CHARS)

  if (lower === 'bash' || lower === 'shell' || lower === 'exec' || lower === 'exec_command') {
    const command = args.command ?? args.cmd
    if (typeof command === 'string' && command.length > 0) {
      return oneLine(commandSummary(command), TARGET_MAX_CHARS)
    }
  }

  for (const key of ['pattern', 'query', 'skill', 'description', 'subject', 'prompt']) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return oneLine(value, TARGET_MAX_CHARS)
  }
  return ''
}

/**
 * The small quantitative aside, or nothing.
 *
 * Only where it is derivable from the call itself. An Edit carries both strings, so
 * the line delta is arithmetic rather than a guess; a Read does not carry the file, so
 * it gets nothing rather than an invented number.
 */
export function detailForTool(name: unknown, input: unknown): string {
  const args = asRecord(input)
  if (!args) return ''
  const lower = typeof name === 'string' ? name.trim().toLowerCase() : ''
  if (lower === 'edit' || lower === 'strreplace' || lower === 'multiedit') {
    const removed = countLines(args.old_string)
    const added = countLines(args.new_string)
    if (removed === 0 && added === 0) return ''
    return oneLine(`+${added} -${removed}`, DETAIL_MAX_CHARS)
  }
  if (lower === 'write') {
    const lines = countLines(args.content)
    return lines === 0 ? '' : oneLine(`${lines} lines`, DETAIL_MAX_CHARS)
  }
  return ''
}

function toolDraft(name: unknown, input: unknown): SessionStreamDraft {
  const verb = verbForToolName(name)
  const target = targetForTool(name, input)
  const readable = typeof name === 'string' ? oneLine(name, TARGET_MAX_CHARS) : ''
  return {
    kind: 'tool',
    verb,
    // An `other` verb names the tool, because the verb no longer does. A known verb
    // that could not resolve a target also falls back to the name rather than to an
    // empty line the reader cannot interpret.
    target: verb === 'other' || target === '' ? (readable || target) : target,
    detail: detailForTool(name, input),
  }
}

function proseDraft(text: unknown): SessionStreamDraft | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const capped = trimmed.length <= PROSE_MAX_CHARS
    ? trimmed
    : trimmed.slice(0, PROSE_MAX_CHARS - TRUNCATION_MARK.length) + TRUNCATION_MARK
  return { kind: 'prose', text: capped }
}

/**
 * Anthropic-shaped content blocks, used by BOTH Claude and Cursor.
 *
 * Cursor writes `{role:'assistant', message:{content:[...]}}` with no top-level
 * `type`; Claude writes `{type:'assistant', message:{content:[...]}}`. The blocks
 * inside are identical, so they share this.
 *
 * `thinking` blocks are dropped. They are the model's private reasoning, they are
 * long, and putting them on a six-line lens buries the tool trail the reader is
 * actually following.
 */
function draftsFromContentBlocks(message: Record<string, unknown>): SessionStreamDraft[] {
  const content = message.content
  if (typeof content === 'string') {
    const prose = proseDraft(content)
    return prose ? [prose] : []
  }
  if (!Array.isArray(content)) return []
  const out: SessionStreamDraft[] = []
  for (const raw of content) {
    const block = asRecord(raw)
    if (!block) continue
    if (block.type === 'text') {
      const prose = proseDraft(block.text)
      if (prose) out.push(prose)
    } else if (block.type === 'tool_use') {
      out.push(toolDraft(block.name, block.input))
    }
  }
  return out
}

/**
 * The user's query out of a user record, or nothing.
 *
 * WHAT IS DELIBERATELY NOT A PROMPT:
 *  - a `tool_result` block. The call was announced when it was made.
 *  - a harness-injected wrapper. `<system-reminder>`, `<local-command-stdout>`,
 *    `<command-name>` and the memory/bulletin blocks arrive as user turns and are not
 *    anything a person asked. Showing one on the lens would be worse than showing
 *    nothing, because it reads as the user's own words.
 *  - an empty string after cleaning.
 */
export function promptDrafts(message: Record<string, unknown>): SessionStreamDraft[] {
  const content = message.content
  const blocks = Array.isArray(content)
    ? content
    : typeof content === 'string' ? [{ type: 'text', text: content }] : []

  const parts: string[] = []
  for (const raw of blocks) {
    const block = asRecord(raw)
    if (!block) continue
    if (block.type === 'tool_result') return []
    if (block.type !== 'text' && block.type !== undefined) continue
    if (typeof block.text === 'string') parts.push(block.text)
  }

  let text = parts.join(' ')
  // Wrapper blocks out, whole. A partial strip would leave the tag names on the lens.
  text = text.replace(/<(system-reminder|relevant-memories|cache-health|daily-bulletin|cos-alarms|device-handoff|now|memory-stored|local-command-stdout|local-command-stderr|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g, ' ')
  const flat = oneLine(text, PROMPT_MAX_CHARS)
  // A record whose ONLY content was a wrapper leaves nothing worth a line.
  if (!flat || /^</.test(flat)) return []
  return [{ kind: 'prompt', text: flat }]
}

function draftsFromClaudeRecord(record: Record<string, unknown>): SessionStreamDraft[] {
  const type = typeof record.type === 'string' ? record.type : ''

  // The stream-json envelope's own lifecycle rows. `result` is the last line of a
  // `claude -p` run and is the only place the turn's END is stated outright.
  if (type === 'system' && record.subtype === 'init') return [{ kind: 'status', state: 'working' }]
  if (type === 'result') return [{ kind: 'status', state: 'done' }]

  // A user row is EITHER a tool result or the query being worked on.
  //
  // This used to drop both, on the reasoning that "the prompt came from this device".
  // That is true of a Continue turn and FALSE of the case that matters most: a session
  // running in a Mac window, where the user row is the question Miles typed there and
  // the glasses have never seen it. Dropping it is what made the live view a blank
  // slate that said WORKING and nothing else.
  //
  // Tool results stay dropped -- the call was already announced.
  if (type === 'user') {
    const message = asRecord(record.message)
    return message ? promptDrafts(message) : []
  }

  const role = typeof record.role === 'string' ? record.role : ''
  if (type !== 'assistant' && role !== 'assistant') return []
  const message = asRecord(record.message)
  if (!message) return []
  return draftsFromContentBlocks(message)
}

/**
 * Codex, with ONE CHANNEL PER KIND, which is the point.
 *
 * Codex writes the same assistant text twice, as `event_msg/agent_message` AND as
 * `response_item/message` with `role:'assistant'` (measured on this Mac: 6 of each in
 * one rollout, plus 8 `response_item/agent_message`). Mapping both would double every
 * reply on the lens. So prose comes from the event channel only and tools from the
 * response-item channel only, and the duplication is unrepresentable rather than
 * deduplicated after the fact.
 *
 * The honest cost: if a Codex build stops emitting `event_msg/agent_message`, prose
 * goes quiet and the poll fallback carries the text. Quiet is the safe direction;
 * doubled text is not.
 *
 * `codex exec --json` has also historically wrapped events as `{id, msg:{type,...}}`
 * rather than `{type:'event_msg', payload:{...}}`. Both are accepted.
 */
function draftsFromCodexRecord(record: Record<string, unknown>): SessionStreamDraft[] {
  const msg = asRecord(record.msg)
  if (msg && typeof msg.type === 'string') return draftsFromCodexEvent(msg)

  const type = typeof record.type === 'string' ? record.type : ''
  const payload = asRecord(record.payload)
  if (!payload) return []
  if (type === 'event_msg') return draftsFromCodexEvent(payload)
  if (type !== 'response_item') return []

  const kind = typeof payload.type === 'string' ? payload.type : ''
  if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call') {
    // `arguments` is a JSON STRING on function_call; `input` is a raw string on
    // custom_tool_call. Only the parseable one can yield a structured target.
    let input: unknown = payload.input
    if (typeof payload.arguments === 'string') {
      try {
        input = JSON.parse(payload.arguments)
      } catch {
        input = { command: payload.arguments }
      }
    } else if (typeof input === 'string') {
      input = { command: input }
    }
    return [toolDraft(payload.name, input)]
  }
  return []
}

function draftsFromCodexEvent(payload: Record<string, unknown>): SessionStreamDraft[] {
  const kind = typeof payload.type === 'string' ? payload.type : ''
  if (kind === 'task_started') return [{ kind: 'status', state: 'working' }]
  if (kind === 'task_complete' || kind === 'turn_complete') return [{ kind: 'status', state: 'done' }]
  if (kind === 'agent_message') {
    const prose = proseDraft(payload.message ?? payload.text)
    return prose ? [prose] : []
  }
  return []
}

/**
 * One parsed provider record to zero or more events.
 *
 * Zero is a normal answer and the common one: token counts, reasoning, world state,
 * tool results, mode rows and attachments all map to nothing. A record this grammar
 * does not recognise is silently dropped rather than rendered as a mystery line.
 */
export function draftsFromRecord(
  provider: SessionStreamProvider,
  record: unknown,
): SessionStreamDraft[] {
  const obj = asRecord(record)
  if (!obj) return []
  try {
    if (provider === 'codex') return draftsFromCodexRecord(obj)
    // Cursor shares Claude's content-block shape, keyed off `role` instead of `type`.
    return draftsFromClaudeRecord(obj)
  } catch {
    // A malformed record costs one line of the trail. It must never cost the stream.
    return []
  }
}

/** One raw NDJSON line to events. Garbage in yields an empty array, never a throw. */
export function draftsFromLine(provider: SessionStreamProvider, line: string): SessionStreamDraft[] {
  const trimmed = typeof line === 'string' ? line.trim() : ''
  if (trimmed.length === 0 || trimmed[0] !== '{') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  return draftsFromRecord(provider, parsed)
}

/** Draft plus transport stamps, in the field order the contract shows. */
export function stampSessionEvent(draft: SessionStreamDraft, seq: number, at: number): SessionStreamEvent {
  return { seq, at, ...draft }
}
