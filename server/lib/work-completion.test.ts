import { expect, it, vi } from 'vitest'
import { COMPLETION_LIMITS, CompletionChecker, decideCompletion, joinRepliesSince, readRepliesSince } from './work-completion.js'
import { LATEST_REPLY_MAX } from './agent-session-store.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JevError } from './jev.js'

const task = { text: 'Draft the homepage call to action', doneWhen: 'Copy for the hero CTA is ready and checked on a phone' }

it('takes the most probable choice and its probability, and refuses anything else', () => {
  expect(decideCompletion({ done: 0.91, not_done: 0.06, unclear: 0.03 })).toEqual({ verdict: 'done', confidence: 0.91 })
  expect(decideCompletion({ done: 0.3, not_done: 0.6, unclear: 0.1 })).toEqual({ verdict: 'not_done', confidence: 0.6 })
  expect(decideCompletion({ unclear: 0.5, done: 0.456 })).toEqual({ verdict: 'unclear', confidence: 0.5 })
  // Unrounded: 0.795 must not read as 0.8 at a threshold.
  expect(decideCompletion({ done: 0.795, not_done: 0.205 })).toEqual({ verdict: 'done', confidence: 0.795 })
  const bads: Array<Record<string, number> | undefined> = [undefined, {}, { done: 0.9, maybe: 0.1 }, { done: Number.NaN }, { done: 1.2 }, { done: -0.1 }, { done: '0.9' as unknown as number }]
  for (const bad of bads) {
    expect(() => decideCompletion(bad)).toThrow(JevError)
  }
})

it('asks Jev with the task, its Done when and the reply, clipped, and caches the answer', async () => {
  const ask = vi.fn(async () => ({ answers: { finished: { choice: 'done', probabilities: { done: 0.88, not_done: 0.1, unclear: 0.02 } } }, model: 'jev-1.13.0', inputTokens: 900 }))
  let now = 1_000
  const checker = new CompletionChecker({ ask } as any, () => now)
  const reply = 'Updated the hero CTA and checked it at 390pt. ' + 'x'.repeat(9_000)
  expect(await checker.check({ task, reply })).toEqual({ provider: 'jev', model: 'jev-1.13.0', verdict: 'done', confidence: 0.88, basis: 'done_when', cached: false })
  const [state, questions] = ask.mock.calls[0] as unknown as [any, any]
  expect(state.task).toEqual(task)
  expect(state.reply).toHaveLength(COMPLETION_LIMITS.reply)
  expect(Object.keys(questions.finished.criteria)).toEqual(['done', 'not_done', 'unclear'])
  expect(questions.finished.instructions).toContain('task.doneWhen')
  expect(questions.finished.type).toBe('choice')
  expect(await checker.check({ task, reply })).toMatchObject({ cached: true, verdict: 'done' })
  expect(ask).toHaveBeenCalledTimes(1)
  now += COMPLETION_LIMITS.cacheMs + 1
  await checker.check({ task, reply })
  expect(ask).toHaveBeenCalledTimes(2)
})

it('judges a task with no Done when against the task itself, and clips what it sends', async () => {
  const ask = vi.fn(async () => ({ answers: { finished: { probabilities: { done: 0.9, not_done: 0.1 } } }, inputTokens: 1 }))
  const checker = new CompletionChecker({ ask } as any)
  expect(await checker.check({ task: { text: task.text, doneWhen: '  ' }, reply: 'Shipped it.' })).toMatchObject({ provider: 'jev', basis: 'task', verdict: 'done' })
  const [state, questions] = ask.mock.calls[0] as unknown as [any, any]
  expect(state.task.doneWhen).toBe('')
  expect(questions.finished.instructions).toContain('task.text')
  expect(questions.finished.instructions).not.toContain('task.doneWhen')
  await checker.check({ task: { text: 'x'.repeat(5000), doneWhen: 'y'.repeat(900) }, reply: 'Shipped.' })
  const [clipped] = ask.mock.calls[1] as unknown as [any]
  expect(clipped.task.text).toHaveLength(COMPLETION_LIMITS.task)
  expect(clipped.task.doneWhen).toHaveLength(COMPLETION_LIMITS.doneWhen)
  expect(COMPLETION_LIMITS.reply).toBe(LATEST_REPLY_MAX)
})

it('answers without Jev when there is nothing to judge, and reports Jev failures as reasons', async () => {
  const ask = vi.fn()
  const checker = new CompletionChecker({ ask } as any)
  expect(await checker.check({ task: { text: '', doneWhen: '  ' }, reply: 'done' })).toEqual({ provider: 'none', reason: 'no_task_text' })
  expect(await checker.check({ task, reply: ' \n ' })).toEqual({ provider: 'none', reason: 'no_reply' })
  expect(ask).not.toHaveBeenCalled()
  const capped = new CompletionChecker({ ask: vi.fn(async () => { throw new JevError('jev_cap_reached') }) } as any)
  expect(await capped.check({ task, reply: 'Shipped it.' })).toEqual({ provider: 'none', reason: 'jev_cap_reached' })
  const odd = new CompletionChecker({ ask: vi.fn(async () => ({ answers: { finished: { probabilities: { yes: 1 } } }, inputTokens: 1 })) } as any)
  expect(await odd.check({ task, reply: 'Shipped it.' })).toEqual({ provider: 'none', reason: 'jev_bad_answer' })
  const broken = new CompletionChecker({ ask: vi.fn(async () => { throw new Error('network') }) } as any)
  await expect(broken.check({ task, reply: 'Shipped it.' })).rejects.toThrow('network')
})

it('reads the replies since a time, newest kept when long, from the session transcript', async () => {
  const turns = [
    { role: 'assistant' as const, text: 'before the handoff', at: '2026-09-29T15:00:00.000Z' },
    { role: 'user' as const, text: 'Draft the CTA', at: '2026-09-29T15:01:00.000Z' },
    { role: 'assistant' as const, text: 'Working on it.', at: '2026-09-29T15:02:00.000Z' },
    { role: 'assistant' as const, text: 'Done and checked.', at: '2026-09-29T15:03:00.000Z' },
    { role: 'assistant' as const, text: 'no time (Cursor)' },
  ]
  expect(joinRepliesSince(turns, Date.parse('2026-09-29T15:01:00.000Z'))).toBe('Working on it.\n\nDone and checked.')
  const long = joinRepliesSince([{ role: 'assistant', text: 'a'.repeat(50), at: '2026-09-29T15:02:00.000Z' }, { role: 'assistant', text: 'END', at: '2026-09-29T15:03:00.000Z' }], 0, 20)
  expect(long).toHaveLength(20); expect(long.startsWith('\u2026')).toBe(true); expect(long.endsWith('END')).toBe(true)
  const dir = mkdtempSync(join(tmpdir(), 'work-completion-'))
  try {
    const file = join(dir, 'session.jsonl')
    const line = (type: string, text: string, timestamp: string) => JSON.stringify({ type, timestamp, message: { role: type, content: [{ type: 'text', text }] } })
    writeFileSync(file, [line('assistant', 'Earlier work.', '2026-09-29T15:00:00.000Z'), line('user', 'Draft the CTA', '2026-09-29T15:01:00.000Z'),
      line('assistant', 'Updated the CTA and checked it.', '2026-09-29T15:02:00.000Z')].join('\n') + '\n')
    const find = async (_p: string, id: string) => id === 'known' ? file : null
    expect(await readRepliesSince('claude', 'known', Date.parse('2026-09-29T15:01:00.000Z'), find)).toBe('Updated the CTA and checked it.')
    expect(await readRepliesSince('claude', 'known', null, find)).toBe('Updated the CTA and checked it.')
    expect(await readRepliesSince('claude', 'unknown', null, find)).toBeNull()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
