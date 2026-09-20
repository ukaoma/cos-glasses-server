// Codex threads show what Codex writes (6.52.0), tested by EXECUTION.
//
// Every fixture is a record SHAPE measured on this Mac on 2026-09-19 across 912 Codex
// rollouts (codex-cli 0.128 to 0.155). Content is invented; structure is not:
//  - paginated rollouts (949 of 949 `session_meta.history_mode`): prose as
//    `event_msg/item_completed` AgentMessage, reasoning as a Reasoning item with
//    `summary_text`, the ask as a UserMessage item, tools as `response_item` calls
//    (code-mode `exec` cells since 0.144) plus CommandExecution / FileChange items.
//  - legacy rollouts: prose as `event_msg/agent_message`. None remain on this Mac; the
//    shape is the one the 6.51.0 grammar was written against and still reads.
//  - the older `codex exec --json` envelope `{id, msg}`, read as 6.51.0 read it (legacy
//    events only). Today's exec stream (`thread.started`, `item.*`) is measured and tested
//    in session-stream-codex-exec.test.ts.

import { describe, expect, it } from 'vitest'
import {
  CODE_MODE_MAX_STEPS,
  PROMPT_MAX_CHARS,
  TARGET_MAX_CHARS,
  codexReasoningHeadline,
  codexUserAsk,
  draftsFromLine,
  draftsFromRecord,
  foldSeedOutcomes,
  isCodexReasoningStatus,
  turnFromTail,
  type SessionStreamDraft,
} from './session-stream-events'

const THREAD = '019e0000-aaaa-7bbb-8ccc-0123456789ab'
const TURN = '019e0000-dddd-7eee-8fff-0123456789ab'

const line = (record: unknown) => JSON.stringify(record)
const at = (n: number) => `2026-09-19T16:4${n}:00.000Z`

function itemCompleted(item: Record<string, unknown>, n = 0) {
  return { timestamp: at(n), type: 'event_msg', payload: { type: 'item_completed', thread_id: THREAD, turn_id: TURN, item, completed_at_ms: 1789834800000 + n } }
}
function agentMessage(text: string, phase: string | undefined = 'commentary') {
  return itemCompleted({ type: 'AgentMessage', id: 'msg_0001', content: [{ type: 'Text', text }], ...(phase ? { phase } : {}) })
}
function assistantResponseItem(text: string, phase = 'commentary') {
  return { timestamp: at(1), type: 'response_item', payload: { type: 'message', id: 'msg_resp_0001', role: 'assistant', content: [{ type: 'output_text', text }], phase } }
}
function execCell(input: string, callId = 'call_Code0001Cell') {
  return { timestamp: at(2), type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_0001', status: 'completed', call_id: callId, name: 'exec', input } }
}
function functionCall(name: string, args: Record<string, unknown>, callId = 'call_Func0001Wait') {
  return { timestamp: at(3), type: 'response_item', payload: { type: 'function_call', id: 'fc_0001', name, arguments: JSON.stringify(args), call_id: callId } }
}
function drafts(records: unknown[]): SessionStreamDraft[] {
  return records.flatMap(record => draftsFromLine('codex', line(record)))
}
const KNOWN_KINDS = new Set(['tool', 'prompt', 'prose', 'status', 'heartbeat'])

/** A paginated rollout turn, every channel present, in the order Codex writes them. */
const PAGINATED_TURN: unknown[] = [
  { timestamp: at(0), type: 'session_meta', payload: { id: THREAD, cwd: '/Users/example/repo', originator: 'Codex Desktop', cli_version: '0.155.0-alpha.9.2', history_mode: 'paginated' } },
  { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', turn_id: TURN, started_at: 1789834800, model_context_window: 258400 } },
  { timestamp: at(0), type: 'world_state', payload: { full: false, state: { agents_md: { text: 'house rules' } } } },
  { timestamp: at(0), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /Users/example/repo\n\n<INSTRUCTIONS>house rules</INSTRUCTIONS>' }, { type: 'input_text', text: '<environment_context>\n  <cwd>/Users/example/repo</cwd>\n</environment_context>' }] } },
  { timestamp: at(0), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Prep the index update' }] } },
  itemCompleted({ type: 'UserMessage', id: 'um_0001', client_id: 'c1', content: [{ type: 'text', text: 'Prep the index update', text_elements: [] }] }),
  { timestamp: at(1), type: 'response_item', payload: { type: 'reasoning', id: 'rs_0001', summary: [], content: null, encrypted_content: 'gAAAA' } },
  itemCompleted({ type: 'Reasoning', id: 'rs_item_1', summary_text: ['**Planning the index update**'], raw_content: [] }, 1),
  execCell('const r = await tools.exec_command({"cmd":"sed -n \'1,55p\' notes.md","workdir":"/Users/example/repo","yield_time_ms":10000,"max_output_tokens":30000}); text(r.output);', 'call_Exec0001Sed'),
  itemCompleted({ type: 'CommandExecution', id: 'exec_1', process_id: '41', command: ['/bin/zsh', '-lc', "sed -n '1,55p' notes.md"], cwd: '/Users/example/repo', status: 'completed', exit_code: 0 }, 2),
  { timestamp: at(2), type: 'response_item', payload: { type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_Exec0001Sed', output: [{ type: 'input_text', text: 'Script completed' }] } },
  { timestamp: at(2), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 10 } } } },
  agentMessage('Chunk 3 of 4 is complete. Waiting on the last one.'),
  assistantResponseItem('Chunk 3 of 4 is complete. Waiting on the last one.'),
  functionCall('wait', { cell_id: '37', yield_time_ms: 1000, max_tokens: 12000 }),
  execCell('let{output,...rest}=await tools.write_stdin({"session_id":53404,"yield_time_ms":60000,"chars":"","max_output_tokens":4000});text(rest);text(output);', 'call_Exec0002Poll'),
  execCell('const patch = "*** Begin Patch\\n*** Update File: /Users/example/repo/src/index-plan.ts\\n@@\\n-const batch = 2\\n+const batch = 4\\n+const retries = 1\\n*** End Patch"; text(await tools.apply_patch(patch));', 'call_Exec0003Patch'),
  itemCompleted({ type: 'FileChange', id: 'fc_item_1', changes: { '/Users/example/repo/src/index-plan.ts': { type: 'update', unified_diff: '@@' } } }, 3),
  { timestamp: at(3), type: 'token_usage_record', payload: { thread_id: THREAD, turn_id: TURN, usage: { total_tokens: 10 } } },
  agentMessage('Index updated. Four batches, no failures.', 'final_answer'),
  assistantResponseItem('Index updated. Four batches, no failures.', 'final_answer'),
  { timestamp: at(4), type: 'event_msg', payload: { type: 'task_complete', turn_id: TURN, last_agent_message: 'Index updated. Four batches, no failures.' } },
]

/** A legacy-mode rollout turn: the shape the 6.51.0 grammar reads. */
const LEGACY_TURN: unknown[] = [
  { timestamp: at(0), type: 'session_meta', payload: { id: THREAD, cwd: '/Users/example/repo', cli_version: '0.46.0', history_mode: 'legacy' } },
  { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', model_context_window: 258400 } },
  { timestamp: at(0), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Pull the rollout' }] } },
  { timestamp: at(0), type: 'event_msg', payload: { type: 'user_message', message: 'Pull the rollout', images: [] } },
  { timestamp: at(1), type: 'event_msg', payload: { type: 'agent_reasoning', text: '**Reading the rollout**' } },
  { timestamp: at(1), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '**Reading the rollout**' }], encrypted_content: 'gAAAA' } },
  { timestamp: at(1), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["bash","-lc","ls -la /tmp"]}', call_id: 'call_Legacy0001' } },
  { timestamp: at(1), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_Legacy0001', output: '{"output":"total 0"}' } },
  { timestamp: at(2), type: 'event_msg', payload: { type: 'agent_message', message: 'Pulled the rollout.' } },
  { timestamp: at(2), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Pulled the rollout.' }] } },
  { timestamp: at(3), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Pulled the rollout.' } },
]

describe('a paginated rollout (every build on this Mac)', () => {
  it('maps one turn to exactly the steps, lines and paragraphs Codex took, once each', () => {
    expect(drafts(PAGINATED_TURN)).toEqual([
      { kind: 'status', state: 'working' },
      { kind: 'prompt', text: 'Prep the index update', turn_started_at: at(0) },
      { kind: 'status', state: 'working', reasoning: 'Planning the index update' },
      { kind: 'tool', verb: 'bash', target: "sed -n '1,55p' notes.md", detail: '', call: 'call_Exec0001Sed' },
      { kind: 'prose', text: 'Chunk 3 of 4 is complete. Waiting on the last one.' },
      { kind: 'tool', verb: 'edit', target: 'index-plan.ts', detail: '+2 -1', call: 'call_Exec0003Patch' },
      { kind: 'prose', text: 'Index updated. Four batches, no failures.' },
      { kind: 'status', state: 'done' },
    ])
  })

  it('never doubles a paragraph: the AgentMessage item speaks, the response_item copy does not', () => {
    expect(draftsFromRecord('codex', agentMessage('Once.'))).toEqual([{ kind: 'prose', text: 'Once.' }])
    expect(draftsFromRecord('codex', assistantResponseItem('Once.'))).toEqual([])
    const prose = drafts(PAGINATED_TURN).filter(d => d.kind === 'prose')
    expect(new Set(prose.map(d => (d as { text: string }).text)).size).toBe(prose.length)
  })

  it('reads the final answer and an unphased message too, and joins every Text block', () => {
    expect(draftsFromRecord('codex', agentMessage('Done.', 'final_answer'))).toEqual([{ kind: 'prose', text: 'Done.' }])
    expect(draftsFromRecord('codex', agentMessage('No phase.', undefined))).toEqual([{ kind: 'prose', text: 'No phase.' }])
    expect(draftsFromRecord('codex', itemCompleted({ type: 'AgentMessage', content: [{ type: 'Text', text: 'One.' }, { type: 'Text', text: '  ' }, { type: 'Text', text: 'Two.' }] })))
      .toEqual([{ kind: 'prose', text: 'One.\n\nTwo.' }])
    expect(draftsFromRecord('codex', itemCompleted({ type: 'AgentMessage', content: [] }))).toEqual([])
    expect(draftsFromRecord('codex', itemCompleted({ type: 'AgentMessage' }))).toEqual([])
  })

  it('never doubles a tool: CommandExecution and FileChange items are the response-item calls again', () => {
    for (const type of ['CommandExecution', 'FileChange', 'WebSearch', 'McpToolCall', 'ContextCompaction', 'Plan', 'SubAgentActivity', 'ImageView']) {
      expect(draftsFromRecord('codex', itemCompleted({ type, id: 'x' })), type).toEqual([])
    }
    const tools = drafts(PAGINATED_TURN).filter(d => d.kind === 'tool')
    expect(tools).toHaveLength(2)
  })

  it('emits only kinds a shipped client already knows', () => {
    for (const draft of drafts(PAGINATED_TURN)) expect(KNOWN_KINDS.has(draft.kind), draft.kind).toBe(true)
  })
})

describe('a legacy rollout reads exactly as 6.51.0 read it', () => {
  it('prose from agent_message once, the tool from the call, no prompt, no reasoning line', () => {
    expect(drafts(LEGACY_TURN)).toEqual([
      { kind: 'status', state: 'working' },
      { kind: 'tool', verb: 'bash', target: 'shell', detail: '', call: 'call_Legacy0001' },
      { kind: 'prose', text: 'Pulled the rollout.' },
      { kind: 'status', state: 'done' },
    ])
  })
})

describe('the older {id, msg} exec envelope reads the legacy events only, as 6.51.0 did', () => {
  it('maps agent_message and ignores the item for the same message', () => {
    const live = [
      { id: '0', msg: { type: 'task_started' } },
      { id: '1', msg: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'hello' }] } } },
      { id: '1', msg: { type: 'agent_message', message: 'hello' } },
      { id: '2', msg: { type: 'item_completed', item: { type: 'Reasoning', summary_text: ['**Thinking**'] } } },
      { id: '3', msg: { type: 'task_complete' } },
    ]
    expect(drafts(live)).toEqual([
      { kind: 'status', state: 'working' },
      { kind: 'prose', text: 'hello' },
      { kind: 'status', state: 'done' },
    ])
  })
})

describe('code-mode exec cells', () => {
  it('reads the cmd of exec_command whether the keys are quoted or not', () => {
    expect(draftsFromRecord('codex', execCell('const r = await tools.exec_command({cmd:"rg -n batch src", workdir:"/x", yield_time_ms:10000}); text(r.output);')))
      .toEqual([{ kind: 'tool', verb: 'bash', target: 'rg -n batch src', detail: '', call: 'call_Code0001Cell' }])
    expect(draftsFromRecord('codex', execCell('text(await tools.exec_command({ cmd: \'git status --short\', yield_time_ms: 1000 }))')))
      .toEqual([{ kind: 'tool', verb: 'bash', target: 'git status --short', detail: '', call: 'call_Code0001Cell' }])
    expect(draftsFromRecord('codex', execCell('let{output,...rest}=await tools.exec_command({"cmd":"npm test","yield_time_ms":10000});text(rest);text(output)')))
      .toEqual([{ kind: 'tool', verb: 'bash', target: 'npm test', detail: '', call: 'call_Code0001Cell' }])
  })

  it('reads only the top-level cmd, skipping a nested object that has one too', () => {
    expect(draftsFromRecord('codex', execCell('text(await tools.exec_command({cmd:"make build", env:{MODE:"x", cmd:"not this"}, yield_time_ms:10000}))'))[0])
      .toMatchObject({ verb: 'bash', target: 'make build' })
  })

  it('shortens the command through the shared summary (the cd prefix goes)', () => {
    const [step] = draftsFromRecord('codex', execCell('const r = await tools.exec_command({"cmd":"cd /Users/example/repo && python3 - <<\'PY\'\\nprint(1)\\nPY","yield_time_ms":10000}); text(r.output);'))
    expect(step).toMatchObject({ kind: 'tool', verb: 'bash', target: 'python3 - <<PY' })
  })

  it('decodes escapes in a single-quoted and a template literal', () => {
    expect(draftsFromRecord('codex', execCell("text(await tools.exec_command({cmd:'printf \\'%s\\\\n\\' ok'}))"))[0])
      .toMatchObject({ verb: 'bash', target: "printf '%s\\n' ok" })
    expect(draftsFromRecord('codex', execCell('text(await tools.exec_command({cmd:`ls -la`}))'))[0])
      .toMatchObject({ verb: 'bash', target: 'ls -la' })
  })

  it('does not count a tool name inside a string as a call', () => {
    const cell = 'const r = await tools.exec_command({"cmd":"rg -n \'tools.apply_patch(\' src"}); text(r.output); // tools.write_stdin(x)'
    expect(draftsFromRecord('codex', execCell(cell))).toEqual([
      { kind: 'tool', verb: 'bash', target: "rg -n 'tools.apply_patch(' src", detail: '', call: 'call_Code0001Cell' },
    ])
  })

  it('makes one step per real call, the call id on the first only, capped', () => {
    const two = draftsFromRecord('codex', execCell('text(await tools.apply_patch("*** Begin Patch\\n*** Add File: /x/new-note.md\\n+one\\n+two\\n*** End Patch")); text(await tools.exec_command({cmd:"npm test"}));'))
    expect(two).toEqual([
      { kind: 'tool', verb: 'write', target: 'new-note.md', detail: '+2 -0', call: 'call_Code0001Cell' },
      { kind: 'tool', verb: 'bash', target: 'npm test', detail: '' },
    ])
    const many = draftsFromRecord('codex', execCell(Array.from({ length: 5 }, (_, i) => `text(await tools.exec_command({cmd:"echo ${i}"}));`).join(' ')))
    expect(many).toHaveLength(CODE_MODE_MAX_STEPS)
    expect(many.map(d => (d as { target: string }).target)).toEqual(['echo 0', 'echo 1', 'echo 2'])
  })

  it('names the tool when the argument is a variable', () => {
    expect(draftsFromRecord('codex', execCell('const cmds=["ls","pwd"]; const rs=await Promise.all(cmds.map(cmd=>tools.exec_command({cmd,yield_time_ms:1000}))); text(rs);')))
      .toEqual([{ kind: 'tool', verb: 'bash', target: 'exec_command', detail: '', call: 'call_Code0001Cell' }])
  })

  it('reads a patch passed through a variable, several files, and a delete', () => {
    const cell = 'const patch = "*** Begin Patch\\n*** Update File: /x/a.ts\\n@@\\n-a\\n+b\\n*** Delete File: /x/old.ts\\n*** Update File: /x/b.ts\\n@@\\n+c\\n*** End Patch"; const r = await tools.apply_patch(patch); text(r);'
    expect(draftsFromRecord('codex', execCell(cell))).toEqual([
      { kind: 'tool', verb: 'edit', target: 'a.ts, old.ts, b.ts', detail: '+2 -1', call: 'call_Code0001Cell' },
    ])
  })

  it('gives each inline patch in one cell its own files', () => {
    const cell = 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /x/first.ts\\n-a\\n+b\\n*** End Patch")); text(await tools.apply_patch("*** Begin Patch\\n*** Add File: /x/second.md\\n+c\\n*** End Patch"));'
    expect(draftsFromRecord('codex', execCell(cell))).toEqual([
      { kind: 'tool', verb: 'edit', target: 'first.ts', detail: '+1 -1', call: 'call_Code0001Cell' },
      { kind: 'tool', verb: 'write', target: 'second.md', detail: '+1 -0' },
    ])
  })

  it('still names an apply_patch whose patch it cannot see', () => {
    expect(draftsFromRecord('codex', execCell('const lines=[]; text(await tools.apply_patch(lines.join("\\n")));')))
      .toEqual([{ kind: 'tool', verb: 'edit', target: 'apply_patch', detail: '', call: 'call_Code0001Cell' }])
  })

  it('names any other tool, by member or by bracket', () => {
    expect(draftsFromRecord('codex', execCell('const r = await tools.web__run({search_query:[{q:"pos systems"}],response_length:"short"}); text(r)')))
      .toEqual([{ kind: 'tool', verb: 'other', target: 'web__run', detail: '', call: 'call_Code0001Cell' }])
    expect(draftsFromRecord('codex', execCell('const tool = tools["mcp__docs__search"]; const r = await tool({q:"x"}); text(r)')))
      .toEqual([{ kind: 'tool', verb: 'other', target: 'mcp__docs__search', detail: '', call: 'call_Code0001Cell' }])
  })

  it('a cell that calls no tool is `other exec`, never its source as a command', () => {
    for (const cell of ['const s = "abc"; text(JSON.stringify({n: s.length}))', 'text(ALL_TOOLS.find(x => x.name === "exec"))', 'ALL_TOOLS.filter(x => x.name.includes("a"))', '["a","b"].forEach(x => text(x))', '// look\ntext(1)', 'for (const x of [1]) text(x)']) {
      expect(draftsFromRecord('codex', execCell(cell)), cell).toEqual([{ kind: 'tool', verb: 'other', target: 'exec', detail: '', call: 'call_Code0001Cell' }])
    }
  })

  it('an exec that is a shell command, not a cell, reads as it did before', () => {
    expect(draftsFromRecord('codex', execCell('git log --oneline -3', 'call_Shell0001'))).toEqual([
      { kind: 'tool', verb: 'bash', target: 'git log --oneline -3', detail: '', call: 'call_Shell0001' },
    ])
  })
})

describe('polling is not a step', () => {
  it('drops `wait` and an empty write_stdin as function calls', () => {
    expect(draftsFromRecord('codex', functionCall('wait', { cell_id: '37', yield_time_ms: 1000, max_tokens: 12000 }))).toEqual([])
    expect(draftsFromRecord('codex', functionCall('wait', { cell_id: '37', yield_time_ms: 1000, max_tokens: 12000, terminate: true }))).toEqual([])
    expect(draftsFromRecord('codex', functionCall('write_stdin', { session_id: 9, chars: '', yield_time_ms: 30000, max_output_tokens: 12000 }))).toEqual([])
    expect(draftsFromRecord('codex', functionCall('write_stdin', { session_id: 9, yield_time_ms: 30000, max_output_tokens: 12000 }))).toEqual([])
  })

  it('keeps a write_stdin that types something', () => {
    expect(draftsFromRecord('codex', functionCall('write_stdin', { session_id: 9, chars: 'y\n', yield_time_ms: 1000 }, 'call_Type0001')))
      .toEqual([{ kind: 'tool', verb: 'other', target: 'write_stdin', detail: '', call: 'call_Type0001' }])
  })

  it('drops a cell whose only call is a poll, and keeps the real call in a mixed cell', () => {
    expect(draftsFromRecord('codex', execCell('const r = await tools.write_stdin({session_id:39344,chars:"",yield_time_ms:30000,max_output_tokens:12000}); text(JSON.stringify(r));'))).toEqual([])
    expect(draftsFromRecord('codex', execCell('const r = await tools.write_stdin({"session_id":76810,"yield_time_ms":30000,"max_output_tokens":12000}); text(r.output);'))).toEqual([])
    expect(draftsFromRecord('codex', execCell('await tools.wait({cell_id:"3"}); text(await tools.exec_command({cmd:"ls"}))'))).toEqual([
      { kind: 'tool', verb: 'bash', target: 'ls', detail: '', call: 'call_Code0001Cell' },
    ])
    expect(draftsFromRecord('codex', execCell('const r = await tools.write_stdin({session_id:1,chars:"q",yield_time_ms:100}); text(r.output);')))
      .toEqual([{ kind: 'tool', verb: 'other', target: 'write_stdin', detail: '', call: 'call_Code0001Cell' }])
  })

  it('keeps a write_stdin whose argument it cannot read', () => {
    expect(draftsFromRecord('codex', execCell('const a = {session_id:1}; text(await tools.write_stdin(a))')))
      .toEqual([{ kind: 'tool', verb: 'other', target: 'write_stdin', detail: '', call: 'call_Code0001Cell' }])
  })
})

describe('apply_patch outside code mode', () => {
  it('reads the raw patch of a custom tool call and the arguments of a function call', () => {
    const patch = '*** Begin Patch\n*** Add File: /x/notes/today.md\n+hello\n*** End Patch'
    expect(draftsFromRecord('codex', { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: patch, call_id: 'call_Patch0001' } }))
      .toEqual([{ kind: 'tool', verb: 'write', target: 'today.md', detail: '+1 -0', call: 'call_Patch0001' }])
    expect(draftsFromRecord('codex', { type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ input: patch }), call_id: 'call_Patch0002' } }))
      .toEqual([{ kind: 'tool', verb: 'write', target: 'today.md', detail: '+1 -0', call: 'call_Patch0002' }])
  })
})

describe('the reasoning line', () => {
  it('rides a working status draft as an extra field, never as prose or a new kind', () => {
    const [draft] = draftsFromRecord('codex', itemCompleted({ type: 'Reasoning', summary_text: ['**Planning lightrag update process**'], raw_content: [] }))
    expect(draft).toEqual({ kind: 'status', state: 'working', reasoning: 'Planning lightrag update process' })
    expect(isCodexReasoningStatus(draft)).toBe(true)
    expect(isCodexReasoningStatus({ kind: 'status', state: 'working' })).toBe(false)
  })

  it('takes the headline of the newest section, bold out, one capped line', () => {
    expect(codexReasoningHeadline(['**First idea**', '**Second idea**\n\nWith a body that explains it.'])).toBe('Second idea')
    expect(codexReasoningHeadline(['**Newest**', '   '])).toBe('Newest')
    expect(codexReasoningHeadline(['Weighing **two** options\nmore'])).toBe('Weighing two options')
    expect(codexReasoningHeadline([`**${'x'.repeat(200)}**`])).toHaveLength(TARGET_MAX_CHARS)
  })

  it('an encrypted reasoning item (empty summary) says nothing', () => {
    expect(draftsFromRecord('codex', itemCompleted({ type: 'Reasoning', summary_text: [], raw_content: [] }))).toEqual([])
    expect(draftsFromRecord('codex', itemCompleted({ type: 'Reasoning' }))).toEqual([])
    expect(codexReasoningHeadline('**not a list**')).toBe('')
  })

  it('is not seeded as a step (the seed keeps tools and prose)', () => {
    const seeded = foldSeedOutcomes(drafts(PAGINATED_TURN)).filter(d => d.kind === 'tool' || d.kind === 'prose')
    expect(seeded.some(d => isCodexReasoningStatus(d))).toBe(false)
    expect(seeded).toHaveLength(4)
  })

  it('never moves the queue verdict', () => {
    const tail = [
      line({ type: 'event_msg', payload: { type: 'task_started' } }),
      line({ type: 'event_msg', payload: { type: 'task_complete' } }),
      line(itemCompleted({ type: 'Reasoning', summary_text: ['**Late summary**'] })),
    ]
    expect(turnFromTail('codex', tail)).toEqual({ ended: true, reason: 'codex_complete' })
    expect(turnFromTail('codex', PAGINATED_TURN.map(line))).toEqual({ ended: true, reason: 'codex_complete' })
  })
})

describe('the prompt line', () => {
  it('is what the person sent, capped, from the UserMessage item only', () => {
    expect(draftsFromRecord('codex', itemCompleted({ type: 'UserMessage', content: [{ type: 'text', text: 'Ship it', text_elements: [] }] })))
      .toEqual([{ kind: 'prompt', text: 'Ship it', turn_started_at: at(0) }])
    const long = draftsFromRecord('codex', itemCompleted({ type: 'UserMessage', content: [{ type: 'text', text: 'word '.repeat(100) }] }))
    expect((long[0] as { text: string }).text).toHaveLength(PROMPT_MAX_CHARS)
    // The response_item copy of the same ask is not a second prompt.
    expect(draftsFromRecord('codex', { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ship it' }] } })).toEqual([])
  })

  it('reads the typed request out of an attached-file message and skips images', () => {
    const item = itemCompleted({
      type: 'UserMessage',
      content: [
        { type: 'text', text: '# Files mentioned by the user:\n\n## shot.png: /Users/example/Desktop/shot.png\n\n## My request for Codex:\nFix the header spacing\n' },
        { type: 'local_image', path: '/Users/example/Desktop/shot.png' },
      ],
    })
    expect(draftsFromRecord('codex', item)).toEqual([{ kind: 'prompt', text: 'Fix the header spacing', turn_started_at: at(0) }])
  })

  it('an automation wrapper alone is not a prompt', () => {
    for (const text of ['<heartbeat>\n<current_time>x</current_time>\n</heartbeat>', '<task-notification>done</task-notification>', '   ']) {
      expect(draftsFromRecord('codex', itemCompleted({ type: 'UserMessage', content: [{ type: 'text', text }] })), text).toEqual([])
    }
    expect(draftsFromRecord('codex', itemCompleted({ type: 'UserMessage', content: [{ type: 'local_image', path: '/x.png' }] }))).toEqual([])
  })
})

describe('codexUserAsk (shared by the stream and the session detail)', () => {
  it('drops the AGENTS.md block and every tag-opened wrapper block', () => {
    expect(codexUserAsk(['# AGENTS.md instructions for /Users/example/repo\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>', '<environment_context>\n</environment_context>'])).toBeNull()
    expect(codexUserAsk(['<recommended_plugins>x</recommended_plugins>', '# AGENTS.md instructions for /r'])).toBeNull()
    expect(codexUserAsk(['<skill>\n<name>x</name>\n</skill>'])).toBeNull()
  })

  it('keeps typed words that follow an image wrapper in the same message', () => {
    expect(codexUserAsk(['<image name=[Image #1]>', '</image>', 'What is wrong with this layout?'])).toBe('What is wrong with this layout?')
  })

  it('keeps real text: a heading someone typed, a request on the heading line, a files block without a request', () => {
    expect(codexUserAsk(['# Release notes\nDraft them'])).toBe('# Release notes\nDraft them')
    expect(codexUserAsk(['# Files pasted by the user:\n\n## notes.txt:\nline one\n\n## My request: summarize this'])).toBe('summarize this')
    expect(codexUserAsk(['# Files mentioned by the user:\n\n## a.md: /x/a.md'])).toBe('# Files mentioned by the user:\n\n## a.md: /x/a.md')
    expect(codexUserAsk(['# In app browser:\n- url: http://localhost:3000\n\n## My request for Codex:\nCheck the nav'])).toBe('Check the nav')
    // The heading only means "the typed part starts here" inside an attachment block.
    expect(codexUserAsk(['Use this template:\n## My request:\nfill it in'])).toBe('Use this template:\n## My request:\nfill it in')
  })

  it('ignores non-strings and joins what is left', () => {
    expect(codexUserAsk([null, 3, 'one', undefined, ' two '])).toBe('one\n\ntwo')
    expect(codexUserAsk([])).toBeNull()
  })
})
