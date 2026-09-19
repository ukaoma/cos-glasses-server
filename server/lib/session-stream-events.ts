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
  // `call` (6.49.1) is the provider's own id for the call (`toolu_…`), so a result
  // can be paired with exactly the step that produced it; `outcome` is set only on a
  // SEEDED step, whose result is already in the transcript when the client opens.
  // Both are extra fields on an existing kind: a shipped client strips what it does
  // not know and renders the step as before.
  | { kind: 'tool'; verb: SessionStreamVerb; target: string; detail: string; call?: string; outcome?: ToolOutcome }
  // The user's own words for the turn being worked on. the user: "we should see the query
  // that the user has versus it just being a blank slate where it says working. That
  // way, the user at least knows what the agent is actively working on."
  //
  // ADDITIVE TO A CLOSED SET, AND SAFE BY CONSTRUCTION: the client validates `kind`
  // against its own table and ignores anything it does not know, so a build that
  // predates this renders exactly as it did before rather than breaking.
  | { kind: 'prompt'; text: string }
  | { kind: 'prose'; text: string }
  // 6.49.0: `tool_outcome` rides on a status draft, never on a new kind. A shipped
  // client drops an unknown kind BEFORE seq accounting and paints a gap row for it
  // (the B2 finding); the same client takes a repeated `status: working` as a no-op
  // (`event.state !== status` is false, nothing appended, no step counted). So the
  // result of a tool arrives on the one channel every client already survives.
  | { kind: 'status'; state: SessionStreamState; tool_outcome?: ToolOutcome }
  | { kind: 'heartbeat' }

/**
 * What a finished tool produced, in the words a lens line has room for.
 *
 * `ok` says whether the tool itself reported failure; `detail` is the token the
 * client shows at the end of the step line (`+14 -2`, `41 lines`, `17 hits`,
 * `exit 1`). Derived from the transcript's own `toolUseResult`, which is shape-keyed
 * (a Read result carries `file.numLines`, a Bash result `stdout`), so no tool name
 * and no hook is needed: the same row that announces the call carries its answer a
 * few lines later, in order. Nothing here is prompt text or file content.
 */
export interface ToolOutcome {
  ok: boolean
  detail: string
  /** The `tool_use_id` this answers (6.49.1), when the provider names one. Without
   *  it a client pairs by order (oldest step still waiting), which is right for a
   *  single call and wrong for two parallel calls that finish out of order. */
  call?: string
}

/** A tool-call id as the providers write them; anything else is not carried. */
const CALL_ID_RE = /^[A-Za-z0-9_-]{4,96}$/

function callId(value: unknown): string | undefined {
  return typeof value === 'string' && CALL_ID_RE.test(value) ? value : undefined
}

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
 * WHAT WENT WRONG ON HARDWARE. the user's 9:20 screenshot showed `bash ses...` and
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

/**
 * The outcome token for one tool result, from the transcript row that carries it.
 *
 * SHAPE-KEYED, because the user row that holds a result names no tool: only the
 * `tool_use_id` it answers. The structured `toolUseResult` is distinctive enough per
 * tool (measured across this Mac's transcripts, 2026-09-16) that the shape is the
 * name. Every branch yields a token from a COUNT or a STATUS, never from content:
 * the client has 40 characters for it and the ledger keeps no output.
 *
 * Nothing worth saying yields `ok` with an empty detail, which the client renders
 * as nothing. A result the model marked `is_error` is `ok: false` with the first
 * words of the error, since `exit 1` or `not found` is the whole point of looking.
 */
export function outcomeForToolResult(
  isError: boolean,
  resultText: string,
  structured: unknown,
): ToolOutcome {
  const text = typeof resultText === 'string' ? resultText : ''
  if (isError) {
    const exit = /^\s*Exit code (\d+)/.exec(text)
    if (exit) return { ok: false, detail: `exit ${exit[1]}` }
    const tag = /<tool_use_error>\s*([^<\n]{1,40})/.exec(text)
    if (tag) return { ok: false, detail: oneLine(tag[1], DETAIL_MAX_CHARS) }
    const rejected = /rejected|doesn't want to proceed|denied/i.test(text)
    return { ok: false, detail: rejected ? 'denied' : oneLine(text, DETAIL_MAX_CHARS) || 'error' }
  }
  const r = asRecord(structured)
  if (r) {
    // Read: `{ type: 'text', file: { numLines, totalLines } }`; an image `{ type: 'image' }`.
    const file = asRecord(r.file)
    if (file && typeof file.numLines === 'number') {
      const total = typeof file.totalLines === 'number' && file.totalLines > file.numLines ? ` of ${file.totalLines}` : ''
      return { ok: true, detail: `${file.numLines}${total} lines` }
    }
    if (r.type === 'image') return { ok: true, detail: 'image' }
    // Write: `{ type: 'create' | 'update', filePath }`.
    if (r.type === 'create') return { ok: true, detail: 'created' }
    if (r.type === 'update' && typeof r.filePath === 'string') return { ok: true, detail: 'written' }
    // Edit: `{ oldString, newString, structuredPatch }` and no `type`.
    if (Array.isArray(r.structuredPatch) && typeof r.oldString === 'string') {
      const removed = countLines(r.oldString)
      const added = countLines(r.newString)
      return { ok: true, detail: removed === 0 && added === 0 ? 'edited' : `+${added} -${removed}` }
    }
    // Bash: `{ stdout, stderr, interrupted }`.
    if (typeof r.stdout === 'string' && typeof r.stderr === 'string') {
      if (r.interrupted === true) return { ok: false, detail: 'interrupted' }
      const out = countLines(r.stdout)
      const err = countLines(r.stderr)
      if (out === 0 && err === 0) return { ok: true, detail: 'no output' }
      if (out === 0) return { ok: true, detail: `stderr ${err} line${err === 1 ? '' : 's'}` }
      return { ok: true, detail: `${out} line${out === 1 ? '' : 's'}` }
    }
    // Grep in CONTENT mode (6.49.1): the real row is `{ mode: 'content', numFiles: 0,
    // filenames: [], content, numLines, totalLines }`, numFiles ALWAYS 0 there, so the
    // file count below read "0 files" for a grep with hits (18 of 18 rows measured).
    // The hits are the lines.
    if (r.mode === 'content' && typeof r.numLines === 'number') {
      return { ok: true, detail: r.numLines === 0 ? 'none' : `${r.numLines} hit${r.numLines === 1 ? '' : 's'}` }
    }
    // Grep / Glob: counts when the tool gives them.
    if (typeof r.numFiles === 'number') return { ok: true, detail: `${r.numFiles} file${r.numFiles === 1 ? '' : 's'}` }
    if (typeof r.numMatches === 'number') return { ok: true, detail: `${r.numMatches} hit${r.numMatches === 1 ? '' : 's'}` }
    if (Array.isArray(r.filenames)) return { ok: true, detail: `${r.filenames.length} file${r.filenames.length === 1 ? '' : 's'}` }
    // WebFetch: `{ code, bytes, durationMs }`. WebSearch: `{ searchCount, results }`.
    if (typeof r.code === 'number' && typeof r.bytes === 'number') {
      return { ok: r.code < 400, detail: `${r.code} · ${Math.max(1, Math.round(r.bytes / 1024))} KB` }
    }
    if (Array.isArray(r.results) && typeof r.searchCount === 'number') {
      return { ok: true, detail: `${r.results.length} result${r.results.length === 1 ? '' : 's'}` }
    }
    // Agent / teammate spawn.
    if (r.status === 'teammate_spawned' || typeof r.agent_id === 'string') return { ok: true, detail: 'spawned' }
  }
  // Grep's plain-text answer, when the structured form did not carry the count.
  const found = /Found (\d+) (files?|matches?)/i.exec(text)
  if (found) return { ok: true, detail: `${found[1]} ${found[2].startsWith('file') ? 'file' : 'hit'}${found[1] === '1' ? '' : 's'}` }
  if (/^No (files|matches) found/i.test(text)) return { ok: true, detail: 'none' }
  return { ok: true, detail: '' }
}

/** The result blocks of a user record, paired with the row's structured result. */
export function outcomeDrafts(record: Record<string, unknown>, message: Record<string, unknown>): SessionStreamDraft[] {
  const content = message.content
  if (!Array.isArray(content)) return []
  const out: SessionStreamDraft[] = []
  for (const raw of content) {
    const block = asRecord(raw)
    if (!block || block.type !== 'tool_result') continue
    const inner = block.content
    const text = typeof inner === 'string'
      ? inner
      : Array.isArray(inner)
        ? inner.map(part => (asRecord(part)?.text as string | undefined) ?? '').join(' ')
        : ''
    // `toolUseResult` in the transcript, `tool_use_result` on `claude -p`'s stream-json
    // stdout, which the producer feeds through this same parser for every COS-spawned
    // turn (6.49.1: only the first was read, so every spawn-path Continue and every
    // drained follow-up showed an empty outcome for Read/Bash/Edit/Write).
    const outcome = outcomeForToolResult(block.is_error === true, text, record.toolUseResult ?? record.tool_use_result)
    const call = callId(block.tool_use_id)
    // A tool result means the turn is working by definition: the model called a
    // tool and is about to read what came back.
    out.push({ kind: 'status', state: 'working', tool_outcome: call ? { ...outcome, call } : outcome })
  }
  return out
}

function toolDraft(name: unknown, input: unknown, id?: unknown): SessionStreamDraft {
  const verb = verbForToolName(name)
  const target = targetForTool(name, input)
  const readable = typeof name === 'string' ? oneLine(name, TARGET_MAX_CHARS) : ''
  const call = callId(id)
  return {
    kind: 'tool',
    verb,
    // An `other` verb names the tool, because the verb no longer does. A known verb
    // that could not resolve a target also falls back to the name rather than to an
    // empty line the reader cannot interpret.
    target: verb === 'other' || target === '' ? (readable || target) : target,
    detail: detailForTool(name, input),
    ...(call ? { call } : {}),
  }
}

/**
 * Fold each outcome onto the seeded step it answers (6.49.1).
 *
 * The seed drops status drafts (they describe a past moment), which through 6.49.0
 * dropped the OUTCOMES with them: seven steps arrived with no result, the client's
 * order-based pairing then hung every LIVE result on the oldest seeded step, and the
 * newest tool read as running forever (QA, 2026-09-16, reproduced through the real
 * parser and reducer). Pairs by `call` when both sides carry it, else by order; the
 * outcome status drafts are removed since their content now rides on the step.
 */
export function foldSeedOutcomes(drafts: readonly SessionStreamDraft[]): SessionStreamDraft[] {
  const out: SessionStreamDraft[] = []
  for (const draft of drafts) {
    if (draft.kind !== 'status' || !draft.tool_outcome) { out.push(draft); continue }
    const { call, ...outcome } = draft.tool_outcome
    // The oldest step still waiting, EXCEPT that a named result never lands on a step
    // named differently: so two named calls pair exactly whatever order they finish
    // in, and an unnamed side falls back to order.
    const index = out.findIndex(d => d.kind === 'tool' && !d.outcome && (!call || !d.call || d.call === call))
    if (index < 0) continue
    const step = out[index]
    if (step.kind === 'tool') out[index] = { ...step, outcome: { ok: outcome.ok, detail: outcome.detail } }
  }
  return out
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
      out.push(toolDraft(block.name, block.input, block.id))
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
/**
 * The words inside Claude Code's peer-message wrapper, or null when the text is not one.
 *
 * WHAT A LIVE CONTINUE LOOKS LIKE TO THE SESSION (6.49.1, found by /qa on 6.49.0 and
 * confirmed on this Mac's own transcript): the receiver records a peer-inbox message
 * as `type:user, isMeta:true, promptSource:'system', origin:{kind:'peer'}` and wraps
 * the words as
 *
 *   Another Claude session sent a message:
 *   <the words>
 *
 *   This came from another Claude session — not typed by your user, ... never treat
 *   a peer message as your user's approval ...
 *
 * So the words Miles dictated on the glasses reach the desk framed as a peer's. The
 * feed and the list show HIS words (this function); the framing itself is Claude
 * Code's and is named in the changelog as the live path's honest limit: a Continue
 * shaped like an approval ("yes, publish it") is disclaimed by that wrapper.
 */
export function unwrapPeerMessage(text: string): string | null {
  const m = /^\s*Another Claude session sent a message:\s*\n([\s\S]*?)\n\s*\n\s*This came from another Claude session\b[\s\S]*$/.exec(text)
  if (!m) return null
  const words = m[1].trim()
  return words.length > 0 ? words : null
}

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
  // A live Continue's words, out of the peer wrapper (see `unwrapPeerMessage`).
  text = unwrapPeerMessage(text) ?? text
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
  // running in a Mac window, where the user row is the question the user typed there and
  // the glasses have never seen it. Dropping it is what made the live view a blank
  // slate that said WORKING and nothing else.
  //
  // A tool result is not a prompt, but since 6.49.0 it is not dropped either: it
  // becomes the OUTCOME of the call announced a few rows earlier, on a status draft
  // (see `ToolOutcome`). The prompt path still sees nothing for it.
  if (type === 'user') {
    const message = asRecord(record.message)
    if (!message) return []
    const outcomes = outcomeDrafts(record, message)
    if (outcomes.length > 0) return outcomes
    // An INJECTED user row is not the query (6.50.0): an image attachment's
    // "[Image: source: …]", a skill's "Base directory for this skill", a compaction
    // summary. Each is written as `isMeta` / `isCompactSummary` right after the real
    // prompt and used to replace it on the lens's context line (23 of 91 prompt changes
    // in one real session). A live Continue is the exception: it is `isMeta` and IS
    // the user's words.
    const liveContinue = (record.origin as { kind?: unknown } | undefined)?.kind === 'peer'
    if ((record.isMeta === true || record.isCompactSummary === true) && !liveContinue) return []
    return promptDrafts(message)
  }

  const role = typeof record.role === 'string' ? record.role : ''
  if (type !== 'assistant' && role !== 'assistant') return []
  const message = asRecord(record.message)
  if (!message) return []
  return draftsFromContentBlocks(message)
}

/**
 * Codex: three input shapes, and within a ROLLOUT one channel per kind.
 *
 * 1. A rollout (`~/.codex/sessions/.../rollout-*.jsonl`, what the transcript watcher
 *    tails). It writes the same assistant text on more than one channel: as a TurnItem
 *    (`event_msg/item_completed`, item `AgentMessage`) or, in an older rollout, as the
 *    legacy `event_msg/agent_message`, AND as `response_item/message` with
 *    `role:'assistant'` (and, on 0.155, a `response_item/agent_message` as well). It
 *    writes each command twice too: as the `response_item` call AND as an
 *    `item_completed` `CommandExecution` / `FileChange` (a 0.155 rollout here: 41 of
 *    each). Mapping two channels would double every line on the lens. So, for a rollout:
 *
 *   prose      event channel only: `item_completed/AgentMessage`, else the legacy
 *              `agent_message`. Never `response_item/message` or `/agent_message`.
 *   tools      response-item channel only. Never `CommandExecution` / `FileChange`.
 *   status     event channel only (task_started / task_complete / turn_aborted).
 *
 * 2. The live `codex exec --json` stream (what a COS-driven Continue turn prints, read by
 *    the attached-turn stream). MEASURED on codex-cli 0.155.0 (2026-09-19, fixture
 *    `__fixtures__/codex-exec-json-0.155.0.jsonl`): `{type:'thread.started'}`,
 *    `{type:'turn.started'}`, then `item.started` / `item.completed` wrapping
 *    `{id, type, ...}` with snake_case item types (`agent_message`, `command_execution`,
 *    ...), then `{type:'turn.completed', usage}`. Each item appears once per event, keyed
 *    by its id; there is no second channel. See `draftsFromCodexExecEvent`.
 *
 * 3. The `{id, msg:{type,...}}` envelope of older `codex exec` builds, read exactly as
 *    6.51.0 read it: the legacy events only (task_started, agent_message, task_complete).
 *
 * WHY THE TWO PROSE SOURCES CANNOT BOTH FIRE IN ONE ROLLOUT (6.52.0). Codex's rollout
 * writer (`should_persist_event_msg`, codex-rs/rollout/src/policy.rs) persists the
 * legacy `AgentMessage` event ONLY when the thread's `history_mode` is `legacy`, and an
 * `ItemCompleted` AgentMessage ONLY when it is `paginated`; every earlier version of
 * that policy persisted `ItemCompleted` for plan items alone. `history_mode` is a
 * property of the thread, stamped on its `session_meta`. Measured on this Mac on
 * 2026-09-19: 912 rollouts from codex-cli 0.128 to 0.155, 949 of 949 `session_meta`
 * records say `paginated`, 0 legacy `agent_message` events, 171,606 `item_completed`
 * events, 0 rollouts with both, and no AgentMessage item id written twice.
 *
 * Until 6.52.0 prose came from `agent_message` alone, so on every rollout above the
 * lens said "Working. Nothing written yet." while the Codex app showed paragraphs.
 *
 * The older `{id, msg:{type,...}}` exec envelope reads the legacy events alone, exactly as
 * 6.51.0 did, and never an item: no build on this Mac still writes it, so there is nothing
 * measured to change that reader against. Today's exec stream is shape 2 above.
 */
function draftsFromCodexRecord(record: Record<string, unknown>): SessionStreamDraft[] {
  const msg = asRecord(record.msg)
  if (msg && typeof msg.type === 'string') return draftsFromCodexEvent(msg)

  const type = typeof record.type === 'string' ? record.type : ''
  // Shape 2: a live `codex exec --json` event. No rollout row type contains a dot.
  if (type === 'thread.started' || type.startsWith('turn.') || type.startsWith('item.')) return draftsFromCodexExecEvent(record)
  const payload = asRecord(record.payload)
  if (!payload) return []
  if (type === 'event_msg') {
    if (payload.type === 'item_completed') return draftsFromCodexItem(asRecord(payload.item))
    return draftsFromCodexEvent(payload)
  }
  if (type !== 'response_item') return []

  const kind = typeof payload.type === 'string' ? payload.type : ''
  if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call') {
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    // A code-mode cell (6.52.0): `exec` carrying JavaScript that calls the real tools.
    if (kind === 'custom_tool_call' && name === 'exec' && typeof payload.input === 'string' && isCodeModeCell(payload.input)) {
      return codeModeDrafts(payload.input, payload.call_id)
    }
    if (name === 'apply_patch') {
      const patch = typeof payload.input === 'string' ? payload.input : patchFromArguments(payload.arguments)
      if (patch !== null) return [patchDraft(patch, payload.call_id)]
    }
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
    if (kind === 'function_call' && isCodexPoll(name, input)) return []
    return [toolDraft(payload.name, input, payload.call_id)]
  }
  return []
}

/** `codex exec` wraps each command in a login shell: `/bin/zsh -lc 'npm test'`. The
 * command is what ran; the wrapper is how. Shared with the Messages trail's Codex reader. */
const CODEX_SHELL_WRAPPER_RE = /^\s*(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(?:'([\s\S]*)'|"([\s\S]*)")\s*$/

export function codexExecCommandText(value: unknown): string {
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === 'string')
    if (parts.length >= 3 && /(?:^|\/)(?:ba|z|da)?sh$/.test(parts[0]) && /^-l?c$/.test(parts[1])) return parts.slice(2).join(' ')
    return parts.join(' ')
  }
  const text = typeof value === 'string' ? value : ''
  const match = CODEX_SHELL_WRAPPER_RE.exec(text)
  return match ? (match[1] ?? match[2] ?? text) : text
}

function execLineCount(value: unknown): number {
  if (typeof value !== 'string') return 0
  const text = value.replace(/\n+$/, '')
  return text.length === 0 ? 0 : text.split('\n').length
}

/** A finished `command_execution` item to a derived outcome token. Never output text.
 * Shared with the Messages trail's Codex reader. */
export function codexExecCommandOutcome(item: Record<string, unknown>): Omit<ToolOutcome, 'call'> {
  const exit = item.exit_code
  if (typeof exit === 'number') {
    if (exit !== 0) return { ok: false, detail: `exit ${exit}` }
    const lines = execLineCount(item.aggregated_output)
    return { ok: true, detail: lines === 0 ? 'no output' : `${lines} line${lines === 1 ? '' : 's'}` }
  }
  if (item.status === 'declined') return { ok: false, detail: 'denied' }
  if (item.status === 'failed') return { ok: false, detail: 'failed' }
  return { ok: true, detail: '' }
}

function execOutcome(outcome: Omit<ToolOutcome, 'call'>, call?: string): SessionStreamDraft {
  return { kind: 'status', state: 'working', tool_outcome: call ? { ...outcome, call } : outcome }
}

/**
 * One live `codex exec --json` event (6.52.0 QA round 1: a Continue that runs through
 * `codex exec` streamed only working and done, because nothing read this shape).
 *
 * STATELESS, so each step is emitted exactly once by rule rather than by memory:
 *   turn.started            status working. turn.completed / turn.failed: status done.
 *   agent_message           prose, at completion (it arrives complete).
 *   reasoning               the reasoning headline on a status, at completion; never prose.
 *   command_execution       the step at START (it has one, measured), its outcome at
 *                           completion, paired by the item id.
 *   mcp_tool_call           the same.
 *   web_search, file_change the step and its outcome at COMPLETION only: a search's query
 *                           is not known at start, and a file change is reported done.
 *   thread.started, item.updated, anything newer: nothing.
 */
function draftsFromCodexExecEvent(record: Record<string, unknown>): SessionStreamDraft[] {
  const type = typeof record.type === 'string' ? record.type : ''
  if (type === 'turn.started') return [{ kind: 'status', state: 'working' }]
  if (type === 'turn.completed' || type === 'turn.failed') return [{ kind: 'status', state: 'done' }]
  if (type !== 'item.started' && type !== 'item.completed') return []
  const item = asRecord(record.item)
  if (!item) return []
  const done = type === 'item.completed'
  const call = callId(item.id)
  switch (item.type) {
    case 'agent_message': {
      if (!done) return []
      const prose = proseDraft(item.text)
      return prose ? [prose] : []
    }
    case 'reasoning': {
      if (!done) return []
      const reasoning = codexReasoningHeadline([item.text])
      if (!reasoning) return []
      const draft: CodexReasoningStatus = { kind: 'status', state: 'working', reasoning }
      return [draft]
    }
    case 'command_execution':
      return done
        ? [execOutcome(codexExecCommandOutcome(item), call)]
        : [toolDraft('Bash', { command: codexExecCommandText(item.command) }, item.id)]
    case 'mcp_tool_call': {
      if (done) {
        const failed = item.status === 'failed' || (item.error != null && item.error !== '')
        return [execOutcome({ ok: !failed, detail: failed ? 'failed' : '' }, call)]
      }
      const name = [item.server, item.tool].filter((part): part is string => typeof part === 'string' && part.length > 0).join('.')
      return [{ kind: 'tool', verb: 'other', target: oneLine(name, TARGET_MAX_CHARS) || 'mcp tool', detail: '', ...(call ? { call } : {}) }]
    }
    case 'web_search': {
      if (!done) return []
      const query = oneLine(item.query, TARGET_MAX_CHARS)
      return [
        { kind: 'tool', verb: 'search', target: query || 'web search', detail: '', ...(call ? { call } : {}) },
        execOutcome({ ok: true, detail: '' }, call),
      ]
    }
    case 'file_change': {
      if (!done) return []
      const failed = item.status === 'failed'
      const changes = (Array.isArray(item.changes) ? item.changes : [])
        .map(asRecord)
        .filter((change): change is Record<string, unknown> => change !== null)
        .slice(0, 5)
      const out: SessionStreamDraft[] = []
      for (const change of changes) {
        const name = oneLine(basename(change.path), TARGET_MAX_CHARS) || 'file'
        if (change.kind === 'add') out.push({ kind: 'tool', verb: 'write', target: name, detail: '' })
        else if (change.kind === 'delete') out.push({ kind: 'tool', verb: 'other', target: oneLine(`delete ${name}`, TARGET_MAX_CHARS), detail: '' })
        else out.push({ kind: 'tool', verb: 'edit', target: name, detail: '' })
        out.push(execOutcome({ ok: !failed, detail: failed ? 'failed' : change.kind === 'add' ? 'created' : change.kind === 'delete' ? 'deleted' : 'edited' }))
      }
      return out
    }
    default:
      return []
  }
}

function draftsFromCodexEvent(payload: Record<string, unknown>): SessionStreamDraft[] {
  const kind = typeof payload.type === 'string' ? payload.type : ''
  if (kind === 'task_started') return [{ kind: 'status', state: 'working' }]
  // 6.51.0: an interrupted turn is over too (`turn_aborted`). Without it a follow-up parked
  // behind an aborted Codex turn waited out the 30 min open-turn ceiling.
  if (kind === 'task_complete' || kind === 'turn_complete' || kind === 'turn_aborted') return [{ kind: 'status', state: 'done' }]
  if (kind === 'agent_message') {
    const prose = proseDraft(payload.message ?? payload.text)
    return prose ? [prose] : []
  }
  return []
}

/**
 * A `status: working` draft carrying Codex's reasoning headline (6.52.0).
 *
 * AN EXTRA FIELD ON AN EXISTING KIND, NEVER A NEW KIND, for the reason `tool_outcome`
 * rides a status draft: a shipped client drops an unknown `kind` BEFORE its seq
 * accounting and paints a gap row, while it takes a repeated `status: working` as a
 * no-op and strips the fields it does not know. So an old lens renders exactly what
 * it did before, and a client that learns `reasoning` can show the line. It is never
 * prose: it is the model's summary of what it is thinking, not something it wrote.
 */
export type CodexReasoningStatus = { kind: 'status'; state: 'working'; reasoning: string }

export function isCodexReasoningStatus(draft: SessionStreamDraft): boolean {
  return draft.kind === 'status' && typeof (draft as { reasoning?: unknown }).reasoning === 'string'
}

/**
 * One completed Codex TurnItem (`event_msg/item_completed`, paginated rollouts).
 *
 * Measured item types on this Mac: AgentMessage, Reasoning, UserMessage,
 * CommandExecution, FileChange, WebSearch, McpToolCall, ContextCompaction, Plan,
 * SubAgentActivity, ImageView. Only the first three map; the tool items are the
 * response-item channel's job (see `draftsFromCodexRecord`).
 */
function draftsFromCodexItem(item: Record<string, unknown> | null): SessionStreamDraft[] {
  if (!item) return []
  if (item.type === 'AgentMessage') {
    // `content: [{type:'Text', text}]`, `phase: 'commentary' | 'final_answer'`. Both are
    // what Codex wrote to the person, so both are prose.
    const prose = proseDraft(codexItemText(item.content))
    return prose ? [prose] : []
  }
  if (item.type === 'Reasoning') {
    const reasoning = codexReasoningHeadline(item.summary_text)
    if (!reasoning) return []
    const draft: CodexReasoningStatus = { kind: 'status', state: 'working', reasoning }
    return [draft]
  }
  if (item.type === 'UserMessage') {
    // Codex already leaves AGENTS.md, `<environment_context>` and skill bodies out of
    // this item (they are response_item rows only), so what is left is what the person
    // sent, less automation wrappers and attached-file scaffolding.
    const blocks = Array.isArray(item.content)
      ? item.content.map(block => asRecord(block)?.text)
      : []
    const ask = codexUserAsk(blocks)
    const text = ask === null ? '' : oneLine(ask, PROMPT_MAX_CHARS)
    return text ? [{ kind: 'prompt', text }] : []
  }
  return []
}

function codexItemText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(block => asRecord(block)?.text)
    .filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
    .join('\n\n')
}

/**
 * The reasoning line: the headline of the newest summary section, markdown bold out.
 *
 * `summary_text` is a list of sections, each `**Title**` or `**Title**\n\nbody`
 * (415,343 sections measured, no other form). The newest is what the model is
 * thinking about now; its title is the glanceable part. An empty list (reasoning that
 * was encrypted, 4,988 items) yields nothing rather than a placeholder.
 */
export function codexReasoningHeadline(summary: unknown): string {
  if (!Array.isArray(summary)) return ''
  for (let k = summary.length - 1; k >= 0; k--) {
    const section = summary[k]
    if (typeof section !== 'string' || section.trim().length === 0) continue
    // The first line IS the title (`**Title**`); a body, when there is one, follows a
    // blank line.
    const plain = oneLine(section.trim().split('\n')[0].replace(/\*\*/g, ''), TARGET_MAX_CHARS)
    if (plain) return plain
  }
  return ''
}

/**
 * What the person asked, out of the text blocks of one Codex user message, or null.
 *
 * Shared by the stream (the `prompt` line) and the session detail (title, first
 * prompt, DISCUSSION, recent turns), so the two can never disagree about what a user
 * said. Per BLOCK, because a Codex user message is a list of blocks and one record can
 * hold a wrapper block next to typed text (`<image>` then the words; 5 records here).
 *
 * DROPPED, measured over this Mac's rollouts on 2026-09-19:
 *  - `# AGENTS.md instructions for <dir>`: Codex writes the repo's AGENTS.md as a user
 *    message. It is the FIRST user row in 469 rollouts, so it became the session's
 *    title and opening DISCUSSION line.
 *  - any block that opens with a tag: `<environment_context>`, `<skill>`,
 *    `<subagent_notification>`, `<recommended_plugins>`, `<heartbeat>`, `<image ...>`,
 *    `</image>`, `<turn_aborted>` and the rest. The same rule `isWrapperPrompt` uses.
 *
 * KEPT, because it is real: an attached-file message (`# Files mentioned by the user:`,
 * `# Files pasted by the user:`, `# In app browser:`) is reduced to the words after its
 * `## My request for Codex:` / `## My request:` heading, which is what was typed
 * (1,648 of 1,760 such messages). One without that heading is kept whole.
 */
export function codexUserAsk(blocks: readonly unknown[]): string | null {
  const kept: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'string') continue
    let text = block.trim()
    if (!text || text.startsWith('<') || CODEX_AGENTS_MD.test(text)) continue
    if (CODEX_ATTACHMENT_HEADER.test(text)) {
      const request = CODEX_REQUEST_HEADING.exec(text)
      if (request) text = text.slice(request.index + request[0].length).trim()
    }
    if (text) kept.push(text)
  }
  return kept.length > 0 ? kept.join('\n\n') : null
}

const CODEX_AGENTS_MD = /^#\s*AGENTS\.md instructions\b/
const CODEX_ATTACHMENT_HEADER = /^#\s*(?:Files mentioned by the user|Files pasted by the user|In app browser)\b/
const CODEX_REQUEST_HEADING = /^##\s*My request(?: for Codex)?:/m

/**
 * A poll, which is not a step (6.52.0).
 *
 * Code mode runs a command in a cell and then WAITS on it: `wait` with a `cell_id`, or
 * `write_stdin` with no characters to read more output (10,828 of 11,041 `write_stdin`
 * calls measured). Each rendered as a step ("other wait", "other write_stdin"), so the
 * lens counted and listed waiting as work. A `write_stdin` that TYPES something is an
 * action and stays a step.
 */
function isCodexPoll(name: string, input: unknown): boolean {
  if (name === 'wait') return true
  if (name !== 'write_stdin') return false
  const chars = asRecord(input)?.chars
  return chars === undefined || chars === null || chars === ''
}

/** Steps one code-mode cell may add. A cell that loops over calls is still one glance. */
export const CODE_MODE_MAX_STEPS = 3

/**
 * Is this `exec` input a code-mode JavaScript cell rather than a shell command?
 *
 * Every `exec` custom tool call on this Mac (48,706, codex-cli 0.129 to 0.155) is
 * JavaScript: it calls `tools.<fn>(...)`, or opens with a declaration, `text(`,
 * `ALL_TOOLS`, a loop, a comment or an array. Anything else keeps the old reading,
 * a shell command, so an older build's plain `exec` renders exactly as before.
 */
function isCodeModeCell(input: string): boolean {
  if (/^\s*(?:(?:const|let|var|await)\b|text\s*\(|ALL_TOOLS\b|for\s*\(|\/\/|\/\*|\[\s*["'`\d[{])/.test(input)) return true
  return lexCodeModeCell(input).calls.length > 0
}

interface CodeModeCall { fn: string; args: string | null }

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch)
}

function skipSpace(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i])) i++
  return i
}

/** Index just past the string literal opening at `i` (or the end, if it never closes). */
function skipStringLiteral(src: string, i: number): number {
  const quote = src[i]
  let j = i + 1
  while (j < src.length) {
    const ch = src[j]
    if (ch === '\\') { j += 2; continue }
    if (ch === quote) return j + 1
    j++
  }
  return src.length
}

/** Index of the bracket closing the one at `open`, skipping strings; the end if none. */
function matchBracket(src: string, open: number): number {
  let depth = 0
  let j = open
  while (j < src.length) {
    const ch = src[j]
    if (ch === '"' || ch === "'" || ch === '`') { j = skipStringLiteral(src, j); continue }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) return j
    }
    j++
  }
  return src.length
}

const JS_SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }

/** The value of a JS string literal (quotes included in `literal`), or null. */
function decodeJsString(literal: string): string | null {
  if (literal.length < 2) return null
  const quote = literal[0]
  if ((quote !== '"' && quote !== "'" && quote !== '`') || literal[literal.length - 1] !== quote) return null
  // One reading for all three quote styles (JSON's escapes are a subset of these).
  return literal.slice(1, -1).replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, esc: string) => {
    const simple = JS_SIMPLE_ESCAPES[esc]
    if (simple !== undefined) return simple
    if (esc.startsWith('u{')) return String.fromCodePoint(parseInt(esc.slice(2, -1), 16))
    if (esc.length > 1) return String.fromCharCode(parseInt(esc.slice(1), 16))
    return esc
  })
}

/**
 * The tool calls and string literals of a code-mode cell.
 *
 * A small lexer rather than a pattern over the source: a command string that itself
 * mentions `tools.apply_patch(` (a search for it, say) must not count as a call, and a
 * call's arguments end at ITS closing parenthesis, not at the first one in a string.
 */
function lexCodeModeCell(src: string): { calls: CodeModeCall[]; literals: string[] } {
  const calls: CodeModeCall[] = []
  const literals: string[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipStringLiteral(src, i)
      const value = decodeJsString(src.slice(i, end))
      if (value !== null) literals.push(value)
      i = end
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? src.length : nl + 1
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      i = close < 0 ? src.length : close + 2
      continue
    }
    if (src.startsWith('tools', i) && !isIdentChar(src[i - 1]) && src[i - 1] !== '.' && !isIdentChar(src[i + 5])) {
      let j = skipSpace(src, i + 5)
      let fn: string | null = null
      if (src[j] === '.') {
        j = skipSpace(src, j + 1)
        const name = /^[A-Za-z_$][\w$]*/.exec(src.slice(j))
        if (name) { fn = name[0]; j += name[0].length }
      } else if (src[j] === '[') {
        j = skipSpace(src, j + 1)
        if (src[j] === '"' || src[j] === "'" || src[j] === '`') {
          const end = skipStringLiteral(src, j)
          const name = decodeJsString(src.slice(j, end))
          j = skipSpace(src, end)
          if (name && src[j] === ']') { fn = name; j += 1 }
        }
      }
      if (fn !== null) {
        j = skipSpace(src, j)
        let args: string | null = null
        if (src[j] === '(') {
          const close = matchBracket(src, j)
          args = src.slice(j + 1, close)
          // The argument literals are scanned by the main loop too, so a patch passed
          // inline is found the same way as one passed through a variable.
          i = j + 1
        } else {
          i = j
        }
        calls.push({ fn, args })
        continue
      }
    }
    i++
  }
  return { calls, literals }
}

/**
 * The string-valued top-level properties of an object literal (`{cmd:"ls", ...}` or
 * `{"cmd":"ls"}`), or null when the argument is not one (a variable, a call).
 */
function objectLiteralStrings(args: string): Record<string, string> | null {
  const src = args.trim()
  if (!src.startsWith('{')) return null
  const out: Record<string, string> = {}
  const end = matchBracket(src, 0)
  let i = 1
  while (i < end) {
    i = skipSpace(src, i)
    if (src[i] === ',') { i++; continue }
    if (i >= end) break
    let key = ''
    if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const close = skipStringLiteral(src, i)
      key = decodeJsString(src.slice(i, close)) ?? ''
      i = close
    } else {
      const name = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))
      if (name) { key = name[0]; i += key.length }
    }
    i = skipSpace(src, i)
    if (key && src[i] === ':') {
      i = skipSpace(src, i + 1)
      if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
        const close = skipStringLiteral(src, i)
        const value = decodeJsString(src.slice(i, close))
        if (value !== null) out[key] = value
        i = close
        continue
      }
    }
    // Any other value (a number, a nested object, an expression): skip to the next
    // top-level comma.
    while (i < end && src[i] !== ',') {
      const ch = src[i]
      if (ch === '"' || ch === "'" || ch === '`') i = skipStringLiteral(src, i)
      else if (ch === '(' || ch === '[' || ch === '{') i = matchBracket(src, i) + 1
      else i++
    }
  }
  return out
}

function isCodeModePoll(call: CodeModeCall): boolean {
  if (call.fn === 'wait') return true
  if (call.fn !== 'write_stdin') return false
  // Only a provable poll is dropped: an argument that is not a literal might type.
  const args = call.args === null ? null : objectLiteralStrings(call.args)
  if (args === null) return false
  return args.chars === undefined || args.chars === ''
}

/** The patch text a code-mode `apply_patch` call applied, from the cell's literals. */
function patchFromLiterals(literals: readonly string[]): string | null {
  return literals.find(value => CODEX_PATCH_FILE.test(value)) ?? null
}

function patchFromArguments(argumentsJson: unknown): string | null {
  if (typeof argumentsJson !== 'string') return null
  try {
    const parsed = asRecord(JSON.parse(argumentsJson))
    const patch = parsed?.input ?? parsed?.patch
    return typeof patch === 'string' ? patch : null
  } catch {
    return null
  }
}

const CODEX_PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: /m

/**
 * One `apply_patch` as a step: `write` when it only adds files, else `edit`; the
 * basenames it touched; `+added -removed` counted from the hunks, the same arithmetic
 * an Edit step shows.
 */
function patchDraft(patch: string, id?: unknown): SessionStreamDraft {
  const names: string[] = []
  let onlyAdds = true
  let added = 0
  let removed = 0
  for (const line of patch.split('\n')) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line.trimEnd())
    if (header) {
      if (header[1] !== 'Add') onlyAdds = false
      const name = basename(header[2].trim())
      if (name && !names.includes(name)) names.push(name)
      continue
    }
    // Hunk lines. Every other line of the format (`*** Begin Patch`, `@@`, context)
    // starts with something else.
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  const call = callId(id)
  return {
    kind: 'tool',
    verb: names.length > 0 && onlyAdds ? 'write' : 'edit',
    target: names.length > 0 ? oneLine(names.join(', '), TARGET_MAX_CHARS) : 'apply_patch',
    detail: added + removed > 0 ? oneLine(`+${added} -${removed}`, DETAIL_MAX_CHARS) : '',
    ...(call ? { call } : {}),
  }
}

/**
 * A code-mode cell as the steps it took (6.52.0).
 *
 * Code mode wraps every tool in JavaScript: `const r = await
 * tools.exec_command({"cmd":"sed -n '1,55p' ..."}); text(r.output);`. Until 6.52.0 the
 * whole cell was the "command", so the lens printed `bash let{output,...rest}=awai...`.
 * Now each real call is a step: `exec_command` is `bash` with its `cmd`, `apply_patch`
 * is `edit`/`write` with the file, anything else names itself. Polls are not steps. A
 * cell that calls no tool is `other exec`. The call id rides the first step only, so it
 * still names exactly one step.
 */
function codeModeDrafts(input: string, id?: unknown): SessionStreamDraft[] {
  const { calls, literals } = lexCodeModeCell(input)
  const call = callId(id)
  if (calls.length === 0) {
    return [{ kind: 'tool', verb: 'other', target: 'exec', detail: '', ...(call ? { call } : {}) }]
  }
  const steps: SessionStreamDraft[] = []
  for (const c of calls) {
    if (isCodeModePoll(c)) continue
    steps.push(codeModeStep(c, literals))
    if (steps.length >= CODE_MODE_MAX_STEPS) break
  }
  return steps.map((step, index) => (index === 0 && call && step.kind === 'tool' ? { ...step, call } : step))
}

function codeModeStep(call: CodeModeCall, literals: readonly string[]): SessionStreamDraft {
  if (call.fn === 'apply_patch') {
    const inline = call.args === null ? null : decodeJsString(call.args.trim())
    const patch = inline !== null && CODEX_PATCH_FILE.test(inline) ? inline : patchFromLiterals(literals)
    if (patch !== null) return patchDraft(patch)
    return { kind: 'tool', verb: 'edit', target: 'apply_patch', detail: '' }
  }
  const args = call.args === null ? null : objectLiteralStrings(call.args)
  return toolDraft(call.fn, args ?? {})
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

/**
 * Did the newest turn in this transcript tail END? (6.48.1)
 *
 * THE RULE THE HARNESS USES, read against real Desktop transcripts on this Mac
 * (2026-09-15): a Desktop session writes no `type:'result'` row at all (0 of 30 newest
 * transcripts), so the status-draft rule above can only ever say "ended" for a
 * `claude -p` run. What every Claude transcript DOES carry is `message.stop_reason` on
 * each assistant record: `tool_use` while tools run, `end_turn` when the reply is done.
 *
 *   ended     the newest assistant record's stop_reason is terminal (end_turn,
 *             stop_sequence, max_tokens, refusal) and no tool_use it issued is still
 *             waiting for its tool_result; or a `result` row; or the user interrupted
 *             (`[Request interrupted by user`), which ends the turn without a reply.
 *   open      a user prompt newer than the last terminal reply (a `<task-notification>`
 *             included: the model answers it), or a tool_use with no result yet.
 *
 * Skipped: `isMeta` and `isCompactSummary` rows (injected context, not a prompt), tool
 * results, and the bookkeeping rows (`system`, `last-prompt`, `attachment`, `mode`...).
 * Codex keeps its event rule (task_complete / turn_complete end, task_started opens).
 *
 * PURE, like everything else here. The queue store reads the tail; this decides.
 */
export const TERMINAL_STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal'])

export type TurnFromTail = { ended: boolean; reason: 'terminal_stop' | 'result_row' | 'interrupted' | 'codex_complete' | 'prompt_open' | 'prompt_queued' | 'tool_pending' | 'no_evidence' }

export function turnFromTail(provider: SessionStreamProvider, lines: readonly string[]): TurnFromTail {
  let verdict: TurnFromTail = { ended: false, reason: 'no_evidence' }
  const pendingToolUses = new Set<string>()
  for (const line of lines) {
    const trimmed = typeof line === 'string' ? line.trim() : ''
    if (!trimmed || trimmed[0] !== '{') continue
    let record: unknown
    try { record = JSON.parse(trimmed) } catch { continue }
    const r = asRecord(record)
    if (!r) continue

    if (provider === 'codex') {
      for (const draft of draftsFromRecord('codex', r)) {
        // 6.52.0: a reasoning line is narration, not a turn event. It never moves the verdict.
        if (draft.kind === 'status' && !isCodexReasoningStatus(draft)) verdict = draft.state === 'done' ? { ended: true, reason: 'codex_complete' } : { ended: false, reason: 'prompt_open' }
      }
      continue
    }

    const type = typeof r.type === 'string' ? r.type : ''
    if (type === 'result') { verdict = { ended: true, reason: 'result_row' }; pendingToolUses.clear(); continue }
    // A prompt typed while the Stop hooks run is QUEUED, not submitted (Claude writes a
    // `queue-operation` row); it dequeues once the hooks return and the model answers it.
    // The turn is not over until then (QA, 2026-09-15). The dequeue is followed by the
    // user row itself, which the next branch reads.
    if (type === 'queue-operation') {
      if (r.operation === 'enqueue') verdict = { ended: false, reason: 'prompt_queued' }
      continue
    }
    // Injected context is not a prompt, except a cross-session message (`promptSource:
    // 'system'`), which the model answers as a turn.
    if (r.isCompactSummary === true) continue
    if (r.isMeta === true && r.promptSource !== 'system') continue
    const message = asRecord(r.message)
    if (!message) continue
    const content = Array.isArray(message.content) ? message.content : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : []
    const blocks = content.map(asRecord).filter((b): b is Record<string, unknown> => b !== null)

    if (type === 'user' || message.role === 'user') {
      const results = blocks.filter(b => b.type === 'tool_result')
      if (results.length > 0) {
        for (const b of results) if (typeof b.tool_use_id === 'string') pendingToolUses.delete(b.tool_use_id)
        continue
      }
      const text = blocks.filter(b => b.type === 'text' || b.type === undefined).map(b => (typeof b.text === 'string' ? b.text : '')).join(' ')
      if (/\[Request interrupted by user/.test(text)) { verdict = { ended: true, reason: 'interrupted' }; pendingToolUses.clear(); continue }
      if (text.trim().length === 0) continue
      verdict = { ended: false, reason: 'prompt_open' }
      continue
    }

    if (type === 'assistant' || message.role === 'assistant') {
      for (const b of blocks) if (b.type === 'tool_use' && typeof b.id === 'string') pendingToolUses.add(b.id)
      const stop = typeof message.stop_reason === 'string' ? message.stop_reason : ''
      if (TERMINAL_STOP_REASONS.has(stop)) {
        verdict = pendingToolUses.size === 0 ? { ended: true, reason: 'terminal_stop' } : { ended: false, reason: 'tool_pending' }
      } else if (stop === 'tool_use' || pendingToolUses.size > 0) {
        verdict = { ended: false, reason: 'tool_pending' }
      }
    }
  }
  return verdict
}

/**
 * The derived session state on a `status` draft (6.48.1).
 *
 * EXTRA FIELDS ON THE EXISTING KIND, NEVER A NEW KIND: every shipped EHPK drops an
 * unknown `kind` before its `seq` accounting and paints a "missed N" gap per event
 * (validation round 1, B2). The shipped parser keeps `seq` and strips unknown fields
 * on a `status` draft (canary 8), so an old client renders exactly as before and a
 * new one reads the state line off the same event.
 *
 * `state` keeps its closed vocabulary. The table:
 *   running -> working      waiting -> working (+ waiting_kind/detail)
 *   idle    -> idle         failed  -> idle (+ failure)      ended -> done
 *
 * `done` on open flips the client to its digest body, which is intended for a session
 * whose engine said SessionEnd. An ATTACHED COS TURN WINS (QA, 2026-09-15): the deriver
 * is told `attachedTurn` and answers `running` for as long as the child is writing, so
 * a Continue's trail is never handed off mid-stream by the tab's older Stop or by a
 * child's own SessionEnd; the engine's state resumes the moment the turn detaches.
 *
 * `last_reply` rides only an idle state (the feed's "Idle, last reply: …" line).
 */
export interface DerivedStatusFields {
  agent_state: 'running' | 'waiting' | 'idle' | 'failed' | 'ended'
  state_source: 'hook' | 'registry' | 'transcript'
  state_since: string
  waiting_kind?: string
  waiting_detail?: string
  failure?: string
  last_reply?: string
}

export type StatusDraftWithDerived = { kind: 'status'; state: SessionStreamState; tool_outcome?: ToolOutcome } & Partial<DerivedStatusFields>

export function statusDraftWithDerived(
  draft: { kind: 'status'; state: SessionStreamState; tool_outcome?: ToolOutcome },
  derived: DerivedStatusFields | undefined,
): StatusDraftWithDerived {
  if (!derived) return draft
  const state: SessionStreamState =
    derived.agent_state === 'running' || derived.agent_state === 'waiting' ? 'working'
    : derived.agent_state === 'ended' ? 'done'
    : 'idle'
  return {
    kind: 'status',
    state,
    // 6.49.0: the outcome is the draft's own fact, not the deriver's; it rides through.
    ...(draft.tool_outcome ? { tool_outcome: draft.tool_outcome } : {}),
    agent_state: derived.agent_state,
    state_source: derived.state_source,
    state_since: derived.state_since,
    ...(derived.waiting_kind ? { waiting_kind: derived.waiting_kind } : {}),
    ...(derived.waiting_detail !== undefined ? { waiting_detail: derived.waiting_detail } : {}),
    ...(derived.failure ? { failure: derived.failure } : {}),
    ...(state === 'idle' && derived.last_reply ? { last_reply: derived.last_reply } : {}),
  }
}

/** Draft plus transport stamps, in the field order the contract shows. */
export function stampSessionEvent(draft: SessionStreamDraft, seq: number, at: number): SessionStreamEvent {
  return { seq, at, ...draft }
}
