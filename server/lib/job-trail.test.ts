// The Messages trail's pure parts, by execution: every engine's real line shapes in, the
// drafts out. Fixture shapes are the measured ones named in job-trail.ts: Claude Code
// 2.1.278's stream-json (the 2026-09-19 canary capture), the Codex exec item fields from
// the shipped binary's serde strings, and the Cursor 2026.09.15 bundle's stream-json writer.

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { redactSecretText } from './activity-preview.js'
import {
  TRAIL_PROSE_MAX_CHARS,
  applyTrailToolMode,
  createJobTrailReader,
  jobTrailTextChars,
  ollamaTrailOutcome,
  ollamaTrailStep,
  parseJobTrailEventData,
  sanitizeJobTrailDraft,
  teeJobTrail,
  type JobTrailDraft,
  type JobTrailProvider,
} from './job-trail.js'
import {
  CLAUDE_RUN,
  CLAUDE_RUN_TRAIL,
  CODEX_RUN,
  CODEX_RUN_TRAIL,
  CURSOR_RUN,
  CURSOR_RUN_TRAIL,
  streamEvent,
  textDelta,
} from './__fixtures__/job-trail-runs.js'

function read(provider: JobTrailProvider, records: unknown[]): JobTrailDraft[] {
  const out: JobTrailDraft[] = []
  const reader = createJobTrailReader(provider, draft => out.push(draft))
  for (const record of records) reader.line(typeof record === 'string' ? record : JSON.stringify(record))
  reader.end()
  return out
}

describe('Claude reader', () => {
  it('turns a real-shaped stream-json run into prose, steps, outcomes and Claude Code step lines', () => {
    expect(read('claude', CLAUDE_RUN)).toEqual(CLAUDE_RUN_TRAIL)
  })

  it('coalesces the text blocks of one assistant message into ONE prose entry, never one per delta', () => {
    const drafts = read('claude', [
      streamEvent({ type: 'message_start', message: { id: 'msg_C' } }),
      textDelta('First '), textDelta('part.'),
      { type: 'assistant', message: { id: 'msg_C', content: [{ type: 'text', text: 'First part.' }] } },
      streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      textDelta('Second part.'),
      { type: 'assistant', message: { id: 'msg_C', content: [{ type: 'text', text: 'Second part.' }] } },
      streamEvent({ type: 'message_stop' }),
      { type: 'assistant', message: { id: 'msg_D', content: [{ type: 'text', text: 'Next message.' }] } },
    ])
    expect(drafts).toEqual([
      { kind: 'prose', text: 'First part.\n\nSecond part.' },
      { kind: 'prose', text: 'Next message.' },
    ])
  })

  it('flushes held prose before a step, so the order on the page is the order it happened', () => {
    const drafts = read('claude', [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Running the tests.' }] } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_01Bash', name: 'Bash', input: { command: 'cd /repo && npm test 2>&1 | tail -5' } }] } },
    ])
    expect(drafts).toEqual([
      { kind: 'prose', text: 'Running the tests.' },
      { kind: 'tool', verb: 'bash', target: 'npm test', detail: '', call: 'toolu_01Bash' },
    ])
  })

  it('never emits a prompt: the job echo, a replayed steer with its attachment block, image path and ULTRACODE keyword', () => {
    const drafts = read('claude', [
      { type: 'user', uuid: 'cos-job-prompt', message: { role: 'user', content: [{ type: 'text', text: 'Summarize the attached file' }] } },
      { type: 'user', uuid: 'cos-steer-1', message: { role: 'user', content: 'Also check /private/tmp/cos-img-1.jpg\n\n<attachment name="notes.pdf">QUOTED PRIVATE DOCUMENT TEXT</attachment>\n\nultracode' } },
      { type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'text', text: 'the words a person typed' }] } },
    ])
    expect(drafts).toEqual([])
  })

  it('drops lifecycle status (init, result) and thinking, keeping only what the job status cannot say', () => {
    const drafts = read('claude', [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'assistant', message: { id: 'm', content: [{ type: 'thinking', thinking: 'secret plan' }] } },
      { type: 'result', subtype: 'success', result: 'done' },
    ])
    expect(drafts).toEqual([])
  })

  it("shows a subagent's steps but not its prose (not the agent's words to the user)", () => {
    const drafts = read('claude', [
      { type: 'assistant', parent_tool_use_id: 'toolu_01Task', message: { id: 'sub', content: [{ type: 'text', text: 'subagent musing' }] } },
      { type: 'assistant', parent_tool_use_id: 'toolu_01Task', message: { id: 'sub', content: [{ type: 'tool_use', id: 'toolu_01Grep', name: 'Grep', input: { pattern: 'TODO' } }] } },
    ])
    expect(drafts).toEqual([{ kind: 'tool', verb: 'search', target: 'TODO', detail: '', call: 'toolu_01Grep' }])
  })

  it('carries needs_action from a post-turn summary that has one', () => {
    const drafts = read('claude', [
      { type: 'system', subtype: 'post_turn_summary', status_category: 'blocked', status_detail: 'AskUserQuestion tool not available; cannot proceed', needs_action: 'clarify: is AskUserQuestion available?' },
    ])
    expect(drafts).toEqual([{
      kind: 'status', state: 'working',
      detail: 'AskUserQuestion tool not available; cannot proceed',
      needs_action: 'clarify: is AskUserQuestion available?',
    }])
  })

  it('costs one line for garbage, never the stream', () => {
    expect(read('claude', ['not json', '{"broken":', '[1,2]', '', JSON.stringify({ type: 'assistant', message: { id: 'x', content: [{ type: 'text', text: 'still here' }] } })]))
      .toEqual([{ kind: 'prose', text: 'still here' }])
  })
})

describe('Codex reader', () => {
  it('maps exec items to steps, outcomes and one prose per agent message; reasoning and lifecycle stay out', () => {
    expect(read('codex', CODEX_RUN)).toEqual(CODEX_RUN_TRAIL)
  })

  it('announces a step once per item id, even when only the completion is seen', () => {
    expect(read('codex', [
      { type: 'item.completed', item: { id: 'item_9', type: 'command_execution', command: ['bash', '-lc', 'ls -la'], aggregated_output: '', exit_code: 0 } },
    ])).toEqual([
      { kind: 'tool', verb: 'bash', target: 'ls -la', detail: '', call: 'item_9' },
      { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: 'no output', call: 'item_9' } },
    ])
  })

  it('still reads the older rollout-shaped rows through the Sessions grammar, dropping their lifecycle status', () => {
    expect(read('codex', [
      { type: 'event_msg', payload: { type: 'agent_message', message: 'from a rollout row' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ])).toEqual([{ kind: 'prose', text: 'from a rollout row' }])
  })
})

describe('Cursor reader', () => {
  it('uses the segment flushes as prose (one per segment), steps from tool_call, and drops the prompt echo and thinking', () => {
    expect(read('cursor', CURSOR_RUN)).toEqual(CURSOR_RUN_TRAIL)
  })

  it('maps result cases to derived tokens only, never output text', () => {
    const outcome = (result: unknown) => read('cursor', [
      { type: 'tool_call', subtype: 'completed', call_id: 'toolu_r', tool_call: { readToolCall: { args: { path: '/a/b.md' }, result } } },
    ])[1]
    expect(outcome({ fileNotFound: {} })).toMatchObject({ tool_outcome: { ok: false, detail: 'not found' } })
    expect(outcome({ permissionDenied: {} })).toMatchObject({ tool_outcome: { ok: false, detail: 'denied' } })
    expect(outcome({ timeout: { timeoutMs: 5 } })).toMatchObject({ tool_outcome: { ok: false, detail: 'timeout' } })
    expect(outcome({ error: { error: 'EACCES /Users/someone/secret' } })).toMatchObject({ tool_outcome: { ok: false, detail: 'error' } })
  })

  it('names an MCP call by its tool, and an unknown tool by its key', () => {
    const drafts = read('cursor', [
      { type: 'tool_call', subtype: 'started', call_id: 'toolu_m1', tool_call: { mcpToolCall: { args: { toolName: 'search_meetings', providerIdentifier: 'cos' } } } },
      { type: 'tool_call', subtype: 'started', call_id: 'toolu_m2', tool_call: { updateTodosToolCall: { args: {} } } },
    ])
    expect(drafts).toEqual([
      { kind: 'tool', verb: 'other', target: 'search_meetings', detail: '', call: 'toolu_m1' },
      { kind: 'tool', verb: 'other', target: 'updateTodos', detail: '', call: 'toolu_m2' },
    ])
  })
})

describe('the journal boundary: redaction', () => {
  const narration = 'I will read the config file and then run the tests.'

  it('redactSecretText keeps narration and newlines exactly, and never flags ordinary prose', () => {
    expect(redactSecretText(narration)).toBe(narration)
    expect(redactSecretText('line one\nline two\n\nline four')).toBe('line one\nline two\n\nline four')
  })

  it('removes secrets and local paths from prose, keeping the narration around them and its line breaks', () => {
    const prose = [
      narration,
      'Using Authorization: Bearer abcdefghijklmnop0123456789 against the API.',
      'The key is sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX and api_key=hunter2hunter2.',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n-----END PRIVATE KEY-----',
      'Edited /Users/someone/private/notes.md for you.',
    ].join('\n')
    const clean = sanitizeJobTrailDraft({ kind: 'prose', text: prose })
    expect(clean?.kind).toBe('prose')
    const text = (clean as { text: string }).text
    expect(text.startsWith(`${narration}\n`)).toBe(true)
    for (const secret of ['abcdefghijklmnop0123456789', 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX', 'hunter2hunter2', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC', '/Users/someone']) {
      expect(text).not.toContain(secret)
    }
    expect(text).toContain('[path]')
    expect(text).toContain('Edited')
    expect(text.split('\n').length).toBeGreaterThanOrEqual(4)
  })

  it('redacts a step target, a status line and an outcome detail too', () => {
    expect(sanitizeJobTrailDraft({ kind: 'tool', verb: 'bash', target: 'curl -H "Authorization: Bearer abcdefghijklmnop0123456789" https://x', detail: '' }))
      .toMatchObject({ target: expect.not.stringContaining('abcdefghijklmnop0123456789') })
    expect(sanitizeJobTrailDraft({ kind: 'tool', verb: 'bash', target: 'cat /Users/someone/.ssh/id_rsa', detail: '' }))
      .toEqual({ kind: 'tool', verb: 'bash', target: 'cat [path]', detail: '' })
    expect(sanitizeJobTrailDraft({ kind: 'status', state: 'working', detail: 'Exporting token=abcdef123456 to the env' }))
      .toMatchObject({ detail: expect.not.stringContaining('abcdef123456') })
    expect(sanitizeJobTrailDraft({ kind: 'status', state: 'working', tool_outcome: { ok: false, detail: 'password: hunter2' } }))
      .toMatchObject({ tool_outcome: { detail: expect.not.stringContaining('hunter2') } })
  })

  it('redacts BEFORE it cuts, so a secret straddling the cap is never half shown', () => {
    const pad = 'x '.repeat((TRAIL_PROSE_MAX_CHARS - 20) / 2)
    const text = (sanitizeJobTrailDraft({ kind: 'prose', text: `${pad}sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345` }) as { text: string }).text
    expect(text.length).toBeLessThanOrEqual(TRAIL_PROSE_MAX_CHARS)
    expect(text).not.toMatch(/sk-proj-A/)
  })

  it('caps every field and holds the verb to its closed set', () => {
    const tool = sanitizeJobTrailDraft({ kind: 'tool', verb: 'teleport', target: 'y'.repeat(500), detail: 'z'.repeat(500), call: 'not a call id!' })
    expect(tool).toEqual({ kind: 'tool', verb: 'other', target: expect.any(String), detail: expect.any(String) })
    expect((tool as { target: string }).target.length).toBe(80)
    expect((tool as { detail: string }).detail.length).toBe(40)
    expect((sanitizeJobTrailDraft({ kind: 'prose', text: 'w '.repeat(5_000) }) as { text: string }).text.length).toBeLessThanOrEqual(TRAIL_PROSE_MAX_CHARS)
  })

  it('refuses what a trail row must never be: a prompt, a lifecycle status, an empty entry', () => {
    expect(sanitizeJobTrailDraft({ kind: 'prompt', text: 'the words a person typed' })).toBeNull()
    expect(sanitizeJobTrailDraft({ kind: 'status', state: 'done' })).toBeNull()
    expect(sanitizeJobTrailDraft({ kind: 'status', state: 'working' })).toBeNull()
    expect(sanitizeJobTrailDraft({ kind: 'prose', text: '   ' })).toBeNull()
    expect(sanitizeJobTrailDraft({ kind: 'tool', verb: 'read', target: '' })).toBeNull()
  })

  it('is idempotent, so hydration can run it again on every stored row', () => {
    for (const draft of [...CLAUDE_RUN_TRAIL, ...CODEX_RUN_TRAIL, ...CURSOR_RUN_TRAIL]) {
      const once = sanitizeJobTrailDraft(draft)
      expect(sanitizeJobTrailDraft(once)).toEqual(once)
    }
  })

  it('parses a journaled event back only with a dense positive trailSeq', () => {
    expect(parseJobTrailEventData({ trailSeq: 3, kind: 'prose', text: 'hi' })).toEqual({ trailSeq: 3, draft: { kind: 'prose', text: 'hi' } })
    expect(parseJobTrailEventData({ trailSeq: 0, kind: 'prose', text: 'hi' })).toBeNull()
    expect(parseJobTrailEventData({ kind: 'prose', text: 'hi' })).toBeNull()
    expect(parseJobTrailEventData({ trailSeq: 1, kind: 'mystery' })).toBeNull()
  })

  it('counts text characters for the snapshot bound', () => {
    expect(jobTrailTextChars({ kind: 'prose', text: 'abcd' })).toBe(4)
    expect(jobTrailTextChars({ kind: 'tool', verb: 'read', target: 'ab', detail: 'c' })).toBe(3)
    expect(jobTrailTextChars({ kind: 'status', state: 'working', detail: 'ab', tool_outcome: { ok: true, detail: 'c' } })).toBe(3)
  })
})

describe("the user's opt-out (activityToolMode)", () => {
  const step: JobTrailDraft = { kind: 'tool', verb: 'bash', target: 'npm test', detail: '' }
  const okOutcome: JobTrailDraft = { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: '12 lines' } }
  const rawFailure: JobTrailDraft = { kind: 'status', state: 'working', tool_outcome: { ok: false, detail: 'ENOENT: no such file x' } }
  const exitFailure: JobTrailDraft = { kind: 'status', state: 'working', tool_outcome: { ok: false, detail: 'exit 1' } }
  const prose: JobTrailDraft = { kind: 'prose', text: 'Running the tests.' }
  const stepLine: JobTrailDraft = { kind: 'status', state: 'working', detail: 'Running the test suite' }

  it('off: no tool steps and no step outcomes; prose and plain status stay', () => {
    expect(applyTrailToolMode(step, 'off')).toBeNull()
    expect(applyTrailToolMode(okOutcome, 'off')).toBeNull()
    expect(applyTrailToolMode(exitFailure, 'off')).toBeNull()
    expect(applyTrailToolMode(prose, 'off')).toEqual(prose)
    expect(applyTrailToolMode(stepLine, 'off')).toEqual(stepLine)
  })

  it('status: steps with verb and short target; a failure shows a derived token, never the raw text', () => {
    expect(applyTrailToolMode(step, 'status')).toEqual(step)
    expect(applyTrailToolMode(okOutcome, 'status')).toEqual(okOutcome)
    expect(applyTrailToolMode(exitFailure, 'status')).toEqual(exitFailure)
    expect(applyTrailToolMode(rawFailure, 'status')).toEqual({ ...rawFailure, tool_outcome: { ok: false, detail: 'error' } })
  })

  it('preview: the full grammar, including the first words of a failure', () => {
    expect(applyTrailToolMode(rawFailure, 'preview')).toEqual(rawFailure)
    expect(applyTrailToolMode(step, 'preview')).toEqual(step)
  })
})

describe('the tee', () => {
  it('registers NOTHING on the stream without a trail consumer', () => {
    const stream = new EventEmitter()
    teeJobTrail(stream, 'claude', undefined)
    expect(stream.eventNames()).toEqual([])
  })

  it('assembles lines across chunks (including a split multi-byte character) and flushes at end', () => {
    const stream = new EventEmitter()
    const drafts: JobTrailDraft[] = []
    teeJobTrail(stream, 'claude', draft => drafts.push(draft))
    const bytes = Buffer.from(`${JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'Café is open — ok' }] } })}\n`)
    const cut = bytes.indexOf(0xc3) + 1
    stream.emit('data', bytes.subarray(0, 10))
    stream.emit('data', bytes.subarray(10, cut))
    stream.emit('data', bytes.subarray(cut))
    expect(drafts).toEqual([])
    stream.emit('end')
    stream.emit('close')
    expect(drafts).toEqual([{ kind: 'prose', text: 'Café is open — ok' }])
  })

  it('never throws into the stream, and a consumer that throws once still gets the rest of the line', () => {
    const stream = new EventEmitter()
    const seen: string[] = []
    teeJobTrail(stream, 'claude', draft => {
      seen.push(draft.kind)
      if (seen.length === 1) throw new Error('consumer exploded')
    })
    expect(() => {
      // Held prose flushes, then the step: two drafts from ONE line.
      stream.emit('data', Buffer.from(`${JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'Reading it.' }] } })}\n`))
      stream.emit('data', Buffer.from(`${JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'toolu_01X', name: 'Read', input: { file_path: 'a.ts' } }] } })}\n`))
      stream.emit('end')
    }).not.toThrow()
    expect(seen).toEqual(['prose', 'tool'])
  })
})

describe('Ollama steps', () => {
  it('names the COS tools by what they searched or read, and marks an error answer failed', () => {
    expect(ollamaTrailStep('search_meetings', { query: 'pricing review' })).toEqual({ kind: 'tool', verb: 'search', target: 'pricing review', detail: '' })
    expect(ollamaTrailStep('read_meeting', { filename: 'quilt/2026-09/2026-09-18_review.md' })).toEqual({ kind: 'tool', verb: 'read', target: '2026-09-18_review.md', detail: '' })
    expect(ollamaTrailStep('mystery', {})).toEqual({ kind: 'tool', verb: 'other', target: 'mystery', detail: '' })
    expect(ollamaTrailOutcome('{"hits":[]}')).toEqual({ kind: 'status', state: 'working', tool_outcome: { ok: true, detail: '' } })
    expect(ollamaTrailOutcome('{"error":"query is required"}')).toEqual({ kind: 'status', state: 'working', tool_outcome: { ok: false, detail: 'error' } })
  })
})
