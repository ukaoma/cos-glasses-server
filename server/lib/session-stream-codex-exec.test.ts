// A Continue that runs through `codex exec` (6.52.0 QA round 1): its live `--json` stdout
// now reaches the Sessions view, and it is shown ONCE.
//
// THE REAL SAMPLE. `__fixtures__/codex-exec-json-0.155.0.jsonl` is the stdout of
// `codex exec --json --sandbox read-only --skip-git-repo-check "Run the shell command: echo
// COS_CANARY. Then reply with one word: done."`, captured on 2026-09-19 with codex-cli
// 0.155.0-alpha.9.2 in a scratch directory and a scratch CODEX_HOME (only auth.json and
// config.toml copied, notify and MCP servers overridden off, deleted afterwards). The one
// edit is the thread id, replaced by a neutral one. The item kinds that sample does not
// contain (reasoning, file_change, mcp_tool_call, web_search) are read in the shapes the
// Messages trail fixtures pin (`job-trail-runs.ts`), which are a HYPOTHESIS from the
// binary's serde strings until a real run shows them.

import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { draftsFromLine, foldSeedOutcomes, type SessionStreamDraft } from './session-stream-events.js'
import { createAttachedTurnStream } from './session-stream-producer.js'
import { createTranscriptTailer } from './session-transcript-watcher.js'
import { __resetSessionStreamBusForTests, isAttachedTurnActive, sessionStreamKey } from './session-stream-bus.js'
import { createJobTrailReader, type JobTrailDraft } from './job-trail.js'
import { CODEX_RUN } from './__fixtures__/job-trail-runs.js'

const SAMPLE = readFileSync(new URL('./__fixtures__/codex-exec-json-0.155.0.jsonl', import.meta.url), 'utf8')
const SAMPLE_LINES = SAMPLE.split('\n').filter(Boolean)

const roots: string[] = []
afterEach(() => {
  __resetSessionStreamBusForTests()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('the live codex exec --json stream, read by the Sessions grammar', () => {
  it('the real 0.155.0 sample: working, the words, the step and its outcome, done; each once', () => {
    expect(SAMPLE_LINES.map(line => JSON.parse(line).type)).toEqual([
      'thread.started', 'turn.started', 'item.completed', 'item.started', 'item.completed', 'item.completed', 'turn.completed',
    ])
    expect(SAMPLE_LINES.flatMap(line => draftsFromLine('codex', line))).toEqual([
      { kind: 'status', state: 'working' },
      { kind: 'prose', text: 'I’ll run the command now.' },
      { kind: 'tool', verb: 'bash', target: 'echo COS_CANARY', detail: '', call: 'item_1' },
      { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: '1 line', call: 'item_1' } },
      { kind: 'prose', text: 'done' },
      { kind: 'status', state: 'done' },
    ])
  })

  it('the other item kinds (trail-fixture shapes): every step exactly once, each outcome paired to it', () => {
    const drafts = CODEX_RUN.flatMap(record => draftsFromLine('codex', JSON.stringify(record)))
    const tools = drafts.filter((d): d is Extract<SessionStreamDraft, { kind: 'tool' }> => d.kind === 'tool')
    expect(tools.map(t => `${t.verb} ${t.target}`)).toEqual([
      'bash rg -n TODO src', 'edit a.ts', 'write new.ts', 'other cos.search_meetings', 'search codex exec json events', 'bash npm test',
    ])
    expect(drafts.filter(d => d.kind === 'prose').map(d => (d as { text: string }).text)).toEqual(['Two TODOs found; fixing the first.', 'Fixed.'])
    // The reasoning item is a headline on a status, never prose.
    expect(drafts).toContainEqual({ kind: 'status', state: 'working', reasoning: 'Planning the private chain of thought' })
    // Folded the way a reader pairs them: every step gets its own outcome.
    const folded = foldSeedOutcomes(drafts).filter(d => d.kind === 'tool') as Array<{ target: string; outcome?: { ok: boolean; detail: string } }>
    expect(folded.map(t => t.outcome)).toEqual([
      { ok: true, detail: '2 lines' }, { ok: true, detail: 'edited' }, { ok: true, detail: 'created' },
      { ok: true, detail: '' }, { ok: true, detail: '' }, { ok: false, detail: 'exit 1' },
    ])
    expect(drafts.at(-1)).toEqual({ kind: 'status', state: 'done' })
  })

  it('the Messages trail reads the same sample the same way (the shared command rules)', () => {
    const out: JobTrailDraft[] = []
    const reader = createJobTrailReader('codex', draft => out.push(draft))
    for (const line of SAMPLE_LINES) reader.line(line)
    reader.end()
    expect(out).toEqual([
      { kind: 'prose', text: 'I’ll run the command now.\n' },
      { kind: 'tool', verb: 'bash', target: 'echo COS_CANARY', detail: '', call: 'item_1' },
      { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: '1 line', call: 'item_1' } },
      { kind: 'prose', text: 'done' },
    ])
  })
})

describe('no doubling on the Continue path', () => {
  function rolloutLine(item: Record<string, unknown>): string {
    return `${JSON.stringify({ timestamp: '2026-09-19T18:06:50.000Z', type: 'event_msg', payload: { type: 'item_completed', item } })}\n`
  }

  it('while COS drives the turn, the transcript watcher is held off; the stdout is the one copy', async () => {
    const thread = '01a0bad9-71a3-7061-bfed-d91918099cb3'
    const key = sessionStreamKey('codex', thread)
    const root = mkdtempSync(join(tmpdir(), 'cos-codex-exec-'))
    roots.push(root)
    const dir = join(root, '.codex', 'sessions')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `rollout-2026-09-19T18-06-50-${thread}.jsonl`)
    writeFileSync(path, '')

    const published: SessionStreamDraft[] = []
    const publish = (k: string, draft: SessionStreamDraft) => { if (k === key) published.push(draft) }
    // The watcher a Sessions subscriber holds for this thread, from before the turn.
    const tailer = createTranscriptTailer({ key, path, provider: 'codex', publish, offset: 0 })

    // index.ts opens the attached stream BEFORE the spawn and finishes it on every exit.
    const live = createAttachedTurnStream({ provider: 'codex', sessionId: thread, publish })
    expect(isAttachedTurnActive(key)).toBe(true)
    // Codex writes the turn to its rollout while printing it on stdout.
    appendFileSync(path, rolloutLine({ type: 'AgentMessage', id: 'msg_1', content: [{ type: 'Text', text: 'I’ll run the command now.' }] }))
    live.observeStdout(SAMPLE)
    appendFileSync(path, rolloutLine({ type: 'AgentMessage', id: 'msg_2', content: [{ type: 'Text', text: 'done' }] }))
    await tailer.tick()
    live.finish('done')
    expect(isAttachedTurnActive(key)).toBe(false)
    // Past the turn the watcher's cursor is already beyond those records: nothing replays.
    await tailer.tick()

    const prose = published.filter(d => d.kind === 'prose').map(d => (d as { text: string }).text)
    expect(prose).toEqual(['I’ll run the command now.', 'done'])
    expect(published.filter(d => d.kind === 'tool')).toHaveLength(1)

    // Control: once the turn is over, the watcher is live again for what Codex writes next.
    appendFileSync(path, rolloutLine({ type: 'AgentMessage', id: 'msg_3', content: [{ type: 'Text', text: 'after the turn' }] }))
    await tailer.tick()
    expect(published.filter(d => d.kind === 'prose').map(d => (d as { text: string }).text)).toEqual(['I’ll run the command now.', 'done', 'after the turn'])
  })

  it('index.ts opens the attached stream before the delivery, feeds it the stdout, and finishes it on both exits', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const open = index.indexOf('const live = createAttachedTurnStream({')
    const deliver = index.indexOf('const result = await deliverAttachedTurn({', open)
    const observe = index.indexOf('observeStdout: chunk => live.observeStdout(chunk),', open)
    const finishOk = index.indexOf("live.finish(result && typeof result === 'object'", deliver)
    const finishErr = index.indexOf("live.finish('idle')", deliver)
    for (const at of [open, deliver, observe, finishOk, finishErr]) expect(at).toBeGreaterThan(-1)
    expect(open).toBeLessThan(deliver)
    expect(observe).toBeGreaterThan(deliver)
  })
})
