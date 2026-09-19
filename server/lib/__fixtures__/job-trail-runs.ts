// Engine stdout fixtures for the Messages trail (6.52.0), shared by the pure reader tests
// and the bridge tests so both read the SAME bytes. Shapes are the measured ones named in
// lib/job-trail.ts: Claude Code 2.1.278 stream-json (2026-09-19 canary capture), the Codex
// exec item fields from the shipped binary's serde strings, and the Cursor 2026.09.15
// bundle's stream-json writer. Not shipped (package.json excludes __fixtures__).

import type { JobTrailDraft } from '../job-trail.js'

export const streamEvent = (event: Record<string, unknown>) => ({ type: 'stream_event', event, session_id: 's', uuid: 'u' })
export const textDelta = (text: string) => streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })

/** A Claude run as `claude -p --output-format stream-json --verbose --include-partial-messages`
 * writes it: one record per content block sharing `message.id`, deltas as stream events,
 * the summaries Claude Code 2.1.278 emits, then `result`. */
export const CLAUDE_RUN: unknown[] = [
  { type: 'system', subtype: 'init', model: 'claude-opus-4-8', session_id: 's', uuid: 'u0', tools: [] },
  streamEvent({ type: 'message_start', message: { id: 'msg_A' } }),
  { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50, estimated_tokens_delta: 50 },
  { type: 'assistant', message: { id: 'msg_A', role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning', signature: 'sig' }] }, parent_tool_use_id: null },
  streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
  textDelta("I'll check the "),
  textDelta('config first.'),
  streamEvent({ type: 'content_block_stop', index: 1 }),
  { type: 'assistant', message: { id: 'msg_A', role: 'assistant', content: [{ type: 'text', text: "I'll check the config first." }] }, parent_tool_use_id: null },
  streamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_01Read', name: 'Read', input: {} } }),
  streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/Users/someone/app/config.json"}' } }),
  streamEvent({ type: 'content_block_stop', index: 2 }),
  { type: 'assistant', message: { id: 'msg_A', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01Read', name: 'Read', input: { file_path: '/Users/someone/app/config.json' } }] }, parent_tool_use_id: null },
  streamEvent({ type: 'message_stop' }),
  { type: 'system', subtype: 'task_summary', detail: 'Reading the app config' },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01Read', content: '{"port":3141}' }] }, parent_tool_use_id: null, uuid: 'u3', tool_use_result: { type: 'text', file: { filePath: '/Users/someone/app/config.json', numLines: 12, totalLines: 12 } } },
  { type: 'system', subtype: 'task_summary', detail: 'Reading the app config' },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
  streamEvent({ type: 'message_start', message: { id: 'msg_B' } }),
  streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  textDelta('The config sets port 3141.'),
  streamEvent({ type: 'content_block_stop', index: 0 }),
  { type: 'assistant', message: { id: 'msg_B', role: 'assistant', content: [{ type: 'text', text: 'The config sets port 3141.' }] }, parent_tool_use_id: null },
  streamEvent({ type: 'message_stop' }),
  { type: 'system', subtype: 'post_turn_summary', status_category: 'review_ready', status_detail: 'config read; answered the port question', needs_action: '' },
  { type: 'result', subtype: 'success', is_error: false, result: 'The config sets port 3141.' },
]

export const CLAUDE_RUN_TRAIL: JobTrailDraft[] = [
  { kind: 'prose', text: "I'll check the config first." },
  { kind: 'tool', verb: 'read', target: 'config.json', detail: '', call: 'toolu_01Read' },
  { kind: 'status', state: 'working', detail: 'Reading the app config' },
  { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: '12 lines', call: 'toolu_01Read' } },
  { kind: 'prose', text: 'The config sets port 3141.' },
  { kind: 'status', state: 'working', detail: 'config read; answered the port question' },
]

/** `codex exec --json` as the shipped binary writes it (field names from its serde strings). */
export const CODEX_RUN: unknown[] = [
  { type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Planning** the private chain of thought' } },
  { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'rg -n TODO src'", aggregated_output: '', exit_code: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'rg -n TODO src'", aggregated_output: 'src/a.ts:1: TODO\nsrc/b.ts:9: TODO\n', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Two TODOs found; fixing the first.' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'file_change', changes: [{ path: '/Users/someone/repo/src/a.ts', kind: 'update' }, { path: '/Users/someone/repo/src/new.ts', kind: 'add' }], status: 'completed' } },
  { type: 'item.started', item: { id: 'item_4', type: 'mcp_tool_call', server: 'cos', tool: 'search_meetings', arguments: { query: 'x' }, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_4', type: 'mcp_tool_call', server: 'cos', tool: 'search_meetings', status: 'completed' } },
  { type: 'item.started', item: { id: 'item_5', type: 'web_search', query: '' } },
  { type: 'item.completed', item: { id: 'item_5', type: 'web_search', query: 'codex exec json events' } },
  { type: 'item.started', item: { id: 'item_6', type: 'command_execution', command: 'npm test', exit_code: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_6', type: 'command_execution', command: 'npm test', aggregated_output: 'FAIL', exit_code: 1, status: 'failed' } },
  { type: 'item.updated', item: { id: 'item_7', type: 'todo_list', items: [{ text: 'fix a', completed: true }] } },
  { type: 'item.completed', item: { id: 'item_8', type: 'agent_message', text: 'Fixed.' } },
  { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
]

export const CODEX_RUN_TRAIL: JobTrailDraft[] = [
  { kind: 'tool', verb: 'bash', target: 'rg -n TODO src', detail: '', call: 'item_1' },
  { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: '2 lines', call: 'item_1' } },
  { kind: 'prose', text: 'Two TODOs found; fixing the first.' },
  { kind: 'tool', verb: 'edit', target: 'a.ts', detail: '' },
  { kind: 'tool', verb: 'write', target: 'new.ts', detail: '' },
  { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: 'edited' } },
  { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: 'created' } },
  { kind: 'tool', verb: 'other', target: 'cos.search_meetings', detail: '', call: 'item_4' },
  { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: '', call: 'item_4' } },
  { kind: 'tool', verb: 'search', target: 'codex exec json events', detail: '', call: 'item_5' },
  { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: '', call: 'item_5' } },
  { kind: 'tool', verb: 'bash', target: 'npm test', detail: '', call: 'item_6' },
  { kind: 'status', state: 'working', tool_outcome: { ok: false, detail: 'exit 1', call: 'item_6' } },
  { kind: 'prose', text: 'Fixed.' },
]

export const cursorDelta = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: 'c', timestamp_ms: 1 })

/** `agent -p --output-format stream-json --stream-partial-output`, as the 2026.09.15
 * bundle writes it: deltas with `timestamp_ms`, a segment flush with `model_call_id` before
 * each tool call, a final flush with no timestamp before `result`. */
export const CURSOR_RUN: unknown[] = [
  { type: 'system', subtype: 'init', session_id: 'c', model: 'Composer' },
  { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'SYSTEM INSTRUCTIONS\nsecret system prompt\nUSER REQUEST\nlist files' }] }, session_id: 'c' },
  { type: 'thinking', subtype: 'delta', text: 'private', session_id: 'c', timestamp_ms: 1 },
  cursorDelta('Let me '), cursorDelta('look.'),
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }] }, session_id: 'c', model_call_id: 'mc-1', timestamp_ms: 2 },
  { type: 'tool_call', subtype: 'started', call_id: 'toolu_cursor1', tool_call: { shellToolCall: { args: { command: 'ls -la /Users/someone/repo' } } }, model_call_id: 'mc-1', session_id: 'c', timestamp_ms: 3 },
  { type: 'tool_call', subtype: 'completed', call_id: 'toolu_cursor1', tool_call: { shellToolCall: { args: { command: 'ls -la /Users/someone/repo' }, result: { success: { stdout: 'a\nb\nc\n' } } } }, model_call_id: 'mc-1', session_id: 'c', timestamp_ms: 4 },
  { type: 'tool_call', subtype: 'started', call_id: 'toolu_cursor2', tool_call: { editToolCall: { args: { path: '/Users/someone/repo/src/app.ts' } } }, session_id: 'c', timestamp_ms: 5 },
  { type: 'tool_call', subtype: 'completed', call_id: 'toolu_cursor2', tool_call: { editToolCall: { args: { path: '/Users/someone/repo/src/app.ts' }, result: { success: { path: '/Users/someone/repo/src/app.ts' } } } }, session_id: 'c', timestamp_ms: 6 },
  { type: 'tool_call', subtype: 'completed', call_id: 'toolu_cursor3', tool_call: { shellToolCall: { args: { command: 'npm run build' }, result: { failure: { exitCode: 2, stderr: 'raw compiler output' } } } }, session_id: 'c', timestamp_ms: 7 },
  cursorDelta('All '), cursorDelta('set.'),
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All set.' }] }, session_id: 'c' },
  { type: 'result', subtype: 'success', is_error: false, result: 'Let me look.All set.', session_id: 'c' },
]

export const CURSOR_RUN_TRAIL: JobTrailDraft[] = [
  { kind: 'prose', text: 'Let me look.' },
  // Redacted by the reader BEFORE it shortens the command (6.52.0 QA round 1), which is
  // what the journal always held for it.
  { kind: 'tool', verb: 'bash', target: 'ls -la [path]', detail: '', call: 'toolu_cursor1' },
  { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: '3 lines', call: 'toolu_cursor1' } },
  { kind: 'tool', verb: 'edit', target: 'app.ts', detail: '', call: 'toolu_cursor2' },
  { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: '', call: 'toolu_cursor2' } },
  { kind: 'tool', verb: 'bash', target: 'npm run build', detail: '', call: 'toolu_cursor3' },
  { kind: 'status', state: 'working', tool_outcome: { ok: false, detail: 'exit 2', call: 'toolu_cursor3' } },
  { kind: 'prose', text: 'All set.' },
]
