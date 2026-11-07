import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseClaudeSubagents, readClaudeSubagents } from './session-subagents.js'

// Transcript lines in the shapes Claude Code writes (checked against real transcripts on 11/07: Agent tool_use input
// keys, toolUseResult.status async_launched / teammate_spawned, <task-notification>, <teammate-message>).
const T = (min: number) => new Date(Date.parse('2026-11-07T12:00:00Z') + min * 60000).toISOString()
const use = (id: string, name: string, input: Record<string, unknown>, min: number) =>
  JSON.stringify({ type: 'assistant', timestamp: T(min), message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, min: number, toolUseResult: Record<string, unknown> = {}, isError = false) =>
  JSON.stringify({ type: 'user', timestamp: T(min), toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x', ...(isError ? { is_error: true } : {}) }] } })
const userText = (text: string, min: number) => JSON.stringify({ type: 'user', timestamp: T(min), message: { content: text } })
const queued = (text: string, min: number) => JSON.stringify({ type: 'queue-operation', timestamp: T(min), content: text })
const notify = (id: string, status: string) => `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/private/tmp/x/tasks/a1.output</output-file>\n<status>${status}</status>\n<summary>Agent "x" finished</summary>\n</task-notification>`
const teammate = (name: string, body: string) => `Another Claude session sent a message:\n<teammate-message teammate_id="${name}" color="blue">\n${body}\n</teammate-message>`

describe('parseClaudeSubagents', () => {
  it('a foreground agent is done when its result lands; a failed result is failed', () => {
    const out = parseClaudeSubagents([
      use('t1', 'Agent', { description: 'Find the cache code', subagent_type: 'Explore', prompt: 'secret prompt' }, 0),
      result('t1', 3, { status: 'completed' }),
      use('t2', 'Task', { description: 'Lint the diff' }, 4),
      result('t2', 5, {}, true),
    ].join('\n'))
    expect(out.rows).toEqual([
      { name: 'agent', task: 'Lint the diff', status: 'failed', at: Date.parse(T(5)) },
      { name: 'Explore', task: 'Find the cache code', status: 'done', at: Date.parse(T(3)) },
    ])
    expect(out).toMatchObject({ running: 0, done: 1, failed: 1, total: 2, partial: false })
    expect(JSON.stringify(out)).not.toContain('secret prompt')
  })

  it('a background agent runs until its task notification says completed or failed, delivered or still queued', () => {
    const out = parseClaudeSubagents([
      use('b1', 'Agent', { description: 'QA Completionist: release readiness', run_in_background: true }, 0),
      result('b1', 0, { status: 'async_launched' }),
      use('b2', 'Agent', { description: 'QA Skeptic', run_in_background: true }, 1),
      result('b2', 1, { status: 'async_launched' }),
      use('b3', 'Agent', { description: 'Ghost hunter', run_in_background: true }, 2),
      result('b3', 2, { status: 'async_launched' }),
      userText(notify('b1', 'completed'), 9),
      queued(notify('b2', 'failed'), 7),
      userText(notify('bash-xyz', 'completed'), 8),   // a background shell, not an agent: ignored
    ].join('\n'))
    const by = Object.fromEntries(out.rows.map(r => [r.task, r.status]))
    expect(by).toEqual({ 'QA Completionist: release readiness': 'done', 'QA Skeptic': 'failed', 'Ghost hunter': 'running' })
    expect(out.rows[0]!.task, 'running first').toBe('Ghost hunter')
    expect(out).toMatchObject({ running: 1, done: 1, failed: 1, total: 3 })
  })

  it('a teammate runs when spawned, idles on its idle notice, runs again when sent work, and is done on a shutdown approval', () => {
    const lines = [
      use('m1', 'Agent', { name: 'today-brief-builder', description: 'Today summary via Haiku, capped', subagent_type: 'general-purpose' }, 0),
      result('m1', 0, { status: 'teammate_spawned', name: 'today-brief-builder' }),
      use('m2', 'Agent', { name: 'qa-ghost', description: 'Ghost hunter QA' }, 1),
      result('m2', 1, { status: 'teammate_spawned', name: 'qa-ghost' }),
      userText(teammate('today-brief-builder', '{"type":"idle_notification","from":"today-brief-builder","idleReason":"available"}'), 30),
      userText(teammate('qa-ghost', '{"type":"idle_notification","from":"qa-ghost"}'), 10),
    ]
    let out = parseClaudeSubagents(lines.join('\n'))
    expect(out.rows.map(r => [r.name, r.status])).toEqual([['today-brief-builder', 'idle'], ['qa-ghost', 'idle']])
    lines.push(use('s1', 'SendMessage', { to: 'today-brief-builder', message: 'add sub-agents' }, 40))
    lines.push(userText(teammate('qa-ghost', '{"type":"shutdown_response","request_id":"r1","approve":true}'), 41))
    out = parseClaudeSubagents(lines.join('\n'))
    expect(out.rows).toEqual([
      { name: 'today-brief-builder', task: 'Today summary via Haiku, capped', status: 'running', at: Date.parse(T(40)) },
      { name: 'qa-ghost', task: 'Ghost hunter QA', status: 'done', at: Date.parse(T(41)) },
    ])
    // A plain report moves it without changing its state; an unknown teammate is ignored.
    lines.push(userText(teammate('today-brief-builder', 'Built it. Commits abc.'), 50))
    lines.push(userText(teammate('researcher', '{"type":"idle_notification"}'), 51))
    out = parseClaudeSubagents(lines.join('\n'))
    expect(out.rows[0]).toMatchObject({ name: 'today-brief-builder', status: 'running', at: Date.parse(T(50)) })
    expect(out.total).toBe(2)
  })

  it('an older event never rewinds a newer one', () => {
    const out = parseClaudeSubagents([
      use('b1', 'Agent', { description: 'x', run_in_background: true }, 0),
      userText(notify('b1', 'completed'), 9),
      result('b1', 0, { status: 'async_launched' }),
    ].join('\n'))
    expect(out.rows[0]).toMatchObject({ status: 'done', at: Date.parse(T(9)) })
  })

  it('at most six rows, live ones first then newest, with counts over all; a cut first line is skipped and the read says partial', () => {
    const lines: string[] = []
    for (let i = 0; i < 10; i++) { lines.push(use('d' + i, 'Agent', { description: 'done ' + i }, i)); lines.push(result('d' + i, i, { status: 'completed' })) }
    lines.push(use('r1', 'Agent', { description: 'still going', run_in_background: true }, 0), result('r1', 0, { status: 'async_launched' }))
    const out = parseClaudeSubagents('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"cut' + '\n' + lines.join('\n'), true)
    expect(out.rows).toHaveLength(6)
    expect(out.rows[0]!.task).toBe('still going')
    expect(out.rows.slice(1).map(r => r.task)).toEqual(['done 9', 'done 8', 'done 7', 'done 6', 'done 5'])
    expect(out).toMatchObject({ running: 1, done: 10, total: 11, partial: true })
    // A tail that starts exactly on a line boundary keeps that first, whole line.
    const whole = parseClaudeSubagents(use('w', 'Agent', { description: 'first whole line' }, 0), true)
    expect(whole.rows.map(r => r.task)).toEqual(['first whole line'])
  })

  it('bounds the name and task it keeps, and keeps nothing else from the call', () => {
    const out = parseClaudeSubagents(use('x', 'Agent', { name: 'n'.repeat(500), description: 'd'.repeat(500), prompt: 'p'.repeat(100) }, 0))
    expect(out.rows[0]!.name.length).toBeLessThanOrEqual(60)
    expect(out.rows[0]!.task.length).toBeLessThanOrEqual(160)
    expect(Object.keys(out.rows[0]!).sort()).toEqual(['at', 'name', 'status', 'task'])
  })
})

describe('readClaudeSubagents', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'subagents-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reads only the tail it is given, and remembers a read until the file changes', async () => {
    const file = join(dir, 's.jsonl')
    const pad = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2000) } })
    writeFileSync(file, [use('old', 'Agent', { description: 'before the tail' }, 0), pad, pad, use('new', 'Agent', { description: 'in the tail' }, 1)].join('\n') + '\n')
    const a = await readClaudeSubagents(file, 1000)
    expect(a!.rows.map(r => r.task)).toEqual(['in the tail'])
    expect(a!.partial).toBe(true)
    expect(await readClaudeSubagents(file, 1000)).toBe(a)   // the memo: same mtime and size
    writeFileSync(file, use('new', 'Agent', { description: 'in the tail' }, 1) + '\n' + result('new', 2, { status: 'completed' }) + '\n')
    const b = await readClaudeSubagents(file, 1000)
    expect(b).not.toBe(a)
    expect(b!.rows[0]!.status).toBe('done')
  })

  it('refuses a symlink and a FIFO without hanging, and answers null for a missing file', async () => {
    const real = join(dir, 'real.jsonl'), link = join(dir, 'link.jsonl'), fifo = join(dir, 'pipe.jsonl')
    writeFileSync(real, use('x', 'Agent', { description: 'x' }, 0))
    symlinkSync(real, link)
    execFileSync('/usr/bin/mkfifo', [fifo])
    expect(await readClaudeSubagents(link)).toBeNull()
    expect(await readClaudeSubagents(fifo)).toBeNull()
    expect(await readClaudeSubagents(join(dir, 'none.jsonl'))).toBeNull()
    expect((await readClaudeSubagents(real))!.total).toBe(1)
  }, 5000)
})
