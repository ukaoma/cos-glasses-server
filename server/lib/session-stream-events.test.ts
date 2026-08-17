// The event grammar, tested by EXECUTION.
//
// Every fixture below is a real record SHAPE observed on this machine on 2026-08-16 by
// counting schema keys across the largest Claude transcript (23,400 rows), the most
// recent Codex rollouts and a Cursor agent-transcript. Content is invented; structure
// is not. That matters because the only way this module can be wrong is by mapping a
// real shape to the wrong event, and a fixture I designed to match my mapper proves
// nothing about the files it will actually read.
//
// Measured tool distribution in that Claude transcript, which is why these particular
// tools are covered: Bash 3734, Edit 542, Read 201, Write 123, Agent 56, TaskUpdate 49,
// TaskCreate 34, AskUserQuestion 17, Skill 13, ToolSearch 13.

import { describe, expect, it } from 'vitest'
import {
  DETAIL_MAX_CHARS,
  PROSE_MAX_CHARS,
  TARGET_MAX_CHARS,
  basename,
  detailForTool,
  draftsFromLine,
  draftsFromRecord,
  oneLine,
  stampSessionEvent,
  targetForTool,
  verbForToolName,
  type SessionStreamDraft,
} from './session-stream-events'

function claudeAssistant(...content: unknown[]) {
  return {
    type: 'assistant',
    uuid: '6f6b0e6c-1f2f-4a3e-9a1d-2a3f4b5c6d7e',
    session_id: 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d',
    message: { role: 'assistant', model: 'claude-opus-5', content },
  }
}

describe('verbs are a closed set', () => {
  it('maps the tools this machine actually runs', () => {
    expect(verbForToolName('Read')).toBe('read')
    expect(verbForToolName('Edit')).toBe('edit')
    expect(verbForToolName('Write')).toBe('write')
    expect(verbForToolName('Bash')).toBe('bash')
    expect(verbForToolName('Grep')).toBe('search')
    expect(verbForToolName('Glob')).toBe('search')
    expect(verbForToolName('WebSearch')).toBe('search')
    expect(verbForToolName('Task')).toBe('task')
    expect(verbForToolName('Agent')).toBe('task')
  })

  it('is case insensitive, because Cursor writes StrReplace and Codex writes exec', () => {
    expect(verbForToolName('strreplace')).toBe('edit')
    expect(verbForToolName('StrReplace')).toBe('edit')
    expect(verbForToolName('exec')).toBe('bash')
  })

  it('gives an unknown tool `other` and never invents a verb', () => {
    for (const name of ['TaskUpdate', 'AskUserQuestion', 'mcp__figma__get_figma_data', '']) {
      expect(verbForToolName(name)).toBe('other')
    }
    expect(verbForToolName(null)).toBe('other')
    expect(verbForToolName(42)).toBe('other')
  })

  it('does NOT collapse BashOutput into bash, which would claim a command ran', () => {
    expect(verbForToolName('BashOutput')).toBe('other')
    expect(verbForToolName('KillShell')).toBe('other')
  })
})

describe('targets are one glanceable line', () => {
  it('reduces a file path to its basename', () => {
    expect(targetForTool('Read', { file_path: '/Users/ukaoma/Documents/GitHub/x/occupied-threads.ts' }))
      .toBe('occupied-threads.ts')
  })

  it('keeps the command for a shell call', () => {
    expect(targetForTool('Bash', { command: 'npx vitest run', description: 'Run tests' }))
      .toBe('npx vitest run')
  })

  it('flattens a multi-line command to one line AND drops the cd preamble', () => {
    // CHANGED DELIBERATELY in 6.36.2, not a regression. Every command in this repo
    // opens with the same `cd`, so it spent columns on the one part of the line that
    // is identical every time. Miles, from hardware: `bash ses...` -- two useful
    // characters out of forty.
    const target = targetForTool('Bash', { command: 'cd /tmp &&\n  ls -la\n  echo done' })
    expect(target).not.toContain('\n')
    expect(target).toBe('ls -la echo done')
  })

  it('keeps the command when it is ONLY a cd, rather than rendering an empty line', () => {
    expect(targetForTool('Bash', { command: 'cd /tmp' })).toBe('cd /tmp')
  })

  it('replaces a heredoc BODY with its marker', () => {
    // A python heredoc is often hundreds of lines and none of them is the command.
    const target = targetForTool('Bash', {
      command: "cd /repo && python3 - <<'PY'\nimport io\nprint(1)\nPY",
    })
    expect(target).toBe('python3 - <<PY')
  })

  it('drops output plumbing, which is how you read a command not what it does', () => {
    const target = targetForTool('Bash', {
      command: 'cd /repo && npx vitest run 2>&1 | sed \'s/x//\' | head -5',
    })
    expect(target).toBe('npx vitest run')
  })

  it('caps a long target with ASCII periods, never a glyph the G2 may not have', () => {
    const target = targetForTool('Bash', { command: 'x'.repeat(500) })
    expect(target).toHaveLength(TARGET_MAX_CHARS)
    expect(target.endsWith('...')).toBe(true)
    expect(target).not.toMatch(/[—→…]/)
  })

  it('uses the pattern for a search and the description for a delegated task', () => {
    expect(targetForTool('Grep', { pattern: 'deliverAttachedTurn', output_mode: 'files_with_matches' }))
      .toBe('deliverAttachedTurn')
    expect(targetForTool('Agent', { description: 'Check the poll tiers', prompt: 'long...', model: 'opus' }))
      .toBe('Check the poll tiers')
  })

  it('is empty rather than wrong when the call carries nothing nameable', () => {
    expect(targetForTool('Read', null)).toBe('')
    expect(targetForTool('Read', {})).toBe('')
  })
})

describe('details are derived, never guessed', () => {
  it('computes an edit line delta from the strings the call actually carries', () => {
    expect(detailForTool('Edit', { file_path: '/a/b.ts', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree\nfour' }))
      .toBe('+4 -2')
  })

  it('counts written lines for a Write', () => {
    expect(detailForTool('Write', { file_path: '/a/b.ts', content: 'a\nb\nc' })).toBe('3 lines')
  })

  it('says nothing for a Read, because the file is not in the call', () => {
    expect(detailForTool('Read', { file_path: '/a/b.ts', limit: 100 })).toBe('')
    expect(detailForTool('Bash', { command: 'ls' })).toBe('')
  })

  it('stays inside its cap', () => {
    const detail = detailForTool('Write', { content: 'x\n'.repeat(100_000) })
    expect(detail.length).toBeLessThanOrEqual(DETAIL_MAX_CHARS)
  })
})

describe('Claude records', () => {
  it('turns a tool_use block into one tool event', () => {
    const drafts = draftsFromRecord('claude', claudeAssistant({
      type: 'tool_use',
      id: 'toolu_012S3x4LDgJGRwta3LCWMFXj',
      name: 'Read',
      input: { file_path: '/Users/ukaoma/x/occupied-threads.ts' },
    }))
    expect(drafts).toEqual([{ kind: 'tool', verb: 'read', target: 'occupied-threads.ts', detail: '' }])
  })

  it('turns a text block into one prose event', () => {
    expect(draftsFromRecord('claude', claudeAssistant({ type: 'text', text: 'Reading the poll tiers.' })))
      .toEqual([{ kind: 'prose', text: 'Reading the poll tiers.' }])
  })

  it('emits both, in order, from a mixed content array', () => {
    const drafts = draftsFromRecord('claude', claudeAssistant(
      { type: 'text', text: 'First I will look.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npx vitest run' } },
    ))
    expect(drafts.map(d => d.kind)).toEqual(['prose', 'tool'])
  })

  it('DROPS thinking blocks', () => {
    // 347 of them in the sampled transcript. Private reasoning, and long enough to
    // bury the tool trail the reader is following on six lines.
    const drafts = draftsFromRecord('claude', claudeAssistant(
      { type: 'thinking', thinking: 'Let me consider the options at length.', signature: 'abc' },
      { type: 'text', text: 'Done.' },
    ))
    expect(drafts).toEqual([{ kind: 'prose', text: 'Done.' }])
  })

  it('drops user rows, which are tool results or our own prompt echoed back', () => {
    expect(draftsFromRecord('claude', {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    })).toEqual([])
  })

  it('reads the stream-json lifecycle rows as status', () => {
    expect(draftsFromRecord('claude', { type: 'system', subtype: 'init', session_id: 'a4b2b4dd', tools: [] }))
      .toEqual([{ kind: 'status', state: 'working' }])
    expect(draftsFromRecord('claude', { type: 'result', subtype: 'success', is_error: false, duration_ms: 1200 }))
      .toEqual([{ kind: 'status', state: 'done' }])
  })

  it('ignores the transcript rows that are not messages', () => {
    // Measured in the same file: attachment 198, last-prompt 195, custom-title 191,
    // mode 187, queue-operation 120, system 38.
    for (const type of ['attachment', 'last-prompt', 'custom-title', 'mode', 'queue-operation']) {
      expect(draftsFromRecord('claude', { type, uuid: 'x' }), type).toEqual([])
    }
  })

  it('caps a huge reply instead of putting 587 KB on one SSE frame', () => {
    const drafts = draftsFromRecord('claude', claudeAssistant({ type: 'text', text: 'y'.repeat(600_000) }))
    const prose = drafts[0] as Extract<SessionStreamDraft, { kind: 'prose' }>
    expect(prose.kind).toBe('prose')
    expect(prose.text).toHaveLength(PROSE_MAX_CHARS)
    expect(prose.text.endsWith('...')).toBe(true)
  })
})

describe('Codex records', () => {
  it('reads prose from the event channel only', () => {
    expect(draftsFromRecord('codex', {
      timestamp: '2026-08-17T02:55:46.003Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Pulled the rollout.' },
    })).toEqual([{ kind: 'prose', text: 'Pulled the rollout.' }])
  })

  it('does NOT double a reply that Codex writes on two channels', () => {
    // Measured in one rollout: 6 event_msg/agent_message, 6 response_item/message
    // role=assistant, 8 response_item/agent_message, all carrying the same text.
    expect(draftsFromRecord('codex', {
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Pulled the rollout.' }] },
    })).toEqual([])
    expect(draftsFromRecord('codex', {
      type: 'response_item',
      payload: { type: 'agent_message', message: 'Pulled the rollout.' },
    })).toEqual([])
  })

  it('reads tools from the response-item channel, parsing the arguments string', () => {
    expect(draftsFromRecord('codex', {
      type: 'response_item',
      payload: {
        type: 'function_call',
        id: 'fc_0f605545e95b5',
        name: 'shell',
        arguments: '{"command":"ls -la /tmp"}',
        call_id: 'call_tk8hWpE5vnNpFK4yQsUdxIqa',
      },
    })).toEqual([{ kind: 'tool', verb: 'bash', target: 'ls -la /tmp', detail: '' }])
  })

  it('survives an arguments string that is not JSON', () => {
    const drafts = draftsFromRecord('codex', {
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', input: 'pwd && jq keys /tmp/x.json' },
    })
    expect(drafts).toEqual([{ kind: 'tool', verb: 'bash', target: 'pwd && jq keys /tmp/x.json', detail: '' }])
  })

  it('accepts the {id, msg} envelope `codex exec --json` has historically used', () => {
    expect(draftsFromRecord('codex', { id: '0', msg: { type: 'agent_message', message: 'hello' } }))
      .toEqual([{ kind: 'prose', text: 'hello' }])
    expect(draftsFromRecord('codex', { id: '1', msg: { type: 'task_started' } }))
      .toEqual([{ kind: 'status', state: 'working' }])
  })

  it('ignores reasoning, token counts and world state', () => {
    for (const type of ['reasoning', 'token_count', 'sub_agent_activity']) {
      expect(draftsFromRecord('codex', { type: 'event_msg', payload: { type } }), type).toEqual([])
    }
    expect(draftsFromRecord('codex', { type: 'world_state', payload: {} })).toEqual([])
    expect(draftsFromRecord('codex', { type: 'session_meta', payload: { session_id: 'x', cwd: '/tmp' } })).toEqual([])
  })
})

describe('Cursor records', () => {
  it('reads the same content blocks keyed off `role` instead of `type`', () => {
    // Cursor writes {role, message:{content:[...]}} with no top-level type.
    expect(draftsFromRecord('cursor', {
      role: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'StrReplace', input: { file_path: '/a/session-poll-tiers.ts', old_string: 'a', new_string: 'a\nb' } }] },
    })).toEqual([{ kind: 'tool', verb: 'edit', target: 'session-poll-tiers.ts', detail: '+2 -1' }])
  })

  it('drops the user turn', () => {
    expect(draftsFromRecord('cursor', {
      role: 'user',
      message: { content: [{ type: 'text', text: '<user_query>do the thing</user_query>' }] },
    })).toEqual([])
  })
})

describe('a line is never allowed to throw', () => {
  it('returns nothing for garbage, truncation and non-objects', () => {
    for (const line of ['', '   ', 'not json', '{"type":"assistant"', '[1,2,3]', 'null', '{}']) {
      expect(draftsFromLine('claude', line), JSON.stringify(line)).toEqual([])
    }
  })

  it('survives a record whose fields are the wrong types', () => {
    expect(draftsFromRecord('claude', { type: 'assistant', message: { content: [1, 'x', null, { type: 'tool_use' }] } }))
      .toEqual([{ kind: 'tool', verb: 'other', target: '', detail: '' }])
    expect(draftsFromRecord('claude', undefined)).toEqual([])
    expect(draftsFromRecord('claude', 'a string')).toEqual([])
  })

  it('parses a real NDJSON line end to end', () => {
    const line = JSON.stringify(claudeAssistant({ type: 'tool_use', name: 'Bash', input: { command: 'npm pack' } }))
    expect(draftsFromLine('claude', line))
      .toEqual([{ kind: 'tool', verb: 'bash', target: 'npm pack', detail: '' }])
  })
})

describe('an `other` verb still names what happened', () => {
  it('carries the real tool name in target, per the contract', () => {
    expect(draftsFromRecord('claude', claudeAssistant({
      type: 'tool_use', name: 'mcp__figma__get_figma_data', input: { fileKey: 'abc' },
    }))).toEqual([{ kind: 'tool', verb: 'other', target: 'mcp__figma__get_figma_data', detail: '' }])
  })

  it('falls back to the tool name when a known verb resolves no target', () => {
    expect(draftsFromRecord('claude', claudeAssistant({ type: 'tool_use', name: 'Read', input: {} })))
      .toEqual([{ kind: 'tool', verb: 'read', target: 'Read', detail: '' }])
  })
})

describe('transport stamps', () => {
  it('puts seq and at first, in the contract order', () => {
    const event = stampSessionEvent({ kind: 'tool', verb: 'read', target: 'x.ts', detail: '' }, 1, 1786890000000)
    expect(Object.keys(event)).toEqual(['seq', 'at', 'kind', 'verb', 'target', 'detail'])
    expect(JSON.parse(JSON.stringify(event))).toEqual({
      seq: 1, at: 1786890000000, kind: 'tool', verb: 'read', target: 'x.ts', detail: '',
    })
  })

  it('stamps every kind without changing its shape', () => {
    expect(stampSessionEvent({ kind: 'heartbeat' }, 4, 7)).toEqual({ seq: 4, at: 7, kind: 'heartbeat' })
    expect(stampSessionEvent({ kind: 'status', state: 'working' }, 3, 7))
      .toEqual({ seq: 3, at: 7, kind: 'status', state: 'working' })
  })
})

describe('helpers', () => {
  it('basename survives a trailing slash and a bare name', () => {
    expect(basename('/a/b/c/')).toBe('c')
    expect(basename('c.ts')).toBe('c.ts')
    expect(basename('')).toBe('')
    expect(basename(null)).toBe('')
  })

  it('oneLine collapses runs of whitespace', () => {
    expect(oneLine('a\t\tb   c\n\nd', 40)).toBe('a b c d')
  })
})
