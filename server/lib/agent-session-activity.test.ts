import { appendFileSync, mkdtempSync, statSync, utimesSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, afterAll } from 'vitest'
import {
  ACTIVITY_TAIL_BYTES,
  ACTIVITY_TAIL_MAX_BYTES,
  activityClockMs,
  activityFromTail,
  clearSessionActivityMemo,
  mapWithConcurrency,
  readSessionActivity,
  sessionActivityFileReads,
} from './agent-session-activity.js'

// Every temp root this file makes is removed when the file ends (6.53.3 /qa W3: the suites
// had left ~150,000 `cos-*` folders in $TMPDIR). Tracked at the mkdtemp call, so a new test
// cannot forget it.
const trackedTempRoots: string[] = []
function trackedTemp<T extends string>(root: T): T {
  trackedTempRoots.push(root)
  return root
}
afterAll(() => {
  for (const root of trackedTempRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* a chmod'ed tree: best effort */ }
  }
})

const jsonl = (...records: unknown[]) => records.map(r => JSON.stringify(r)).join('\n') + '\n'
const bookkeeping = (bytes: number) => {
  const line = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-13T00:11:15.000Z', pad: 'x'.repeat(200) }) + '\n'
  return line.repeat(Math.ceil(bytes / line.length))
}
const dir = () => trackedTemp(mkdtempSync(join(tmpdir(), 'cos-activity-')))

describe('last activity from a Claude transcript', () => {
  it('ignores the bookkeeping a Desktop relaunch appends', () => {
    const text = jsonl(
      { type: 'user', timestamp: '2026-09-10T18:00:00.000Z', message: { role: 'user', content: 'fix it' } },
      { type: 'assistant', timestamp: '2026-09-10T18:01:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit' }] } },
      { type: 'queue-operation', timestamp: '2026-09-13T00:11:15.000Z' },
      { type: 'custom-title', title: 'x' },
    )
    expect(activityFromTail('claude', text, false)).toEqual({ lastActivityAt: '2026-09-10T18:01:00.000Z', lastTool: 'Edit' })
  })

  it('reports the newest tool of the latest turn, after tool results and a text reply', () => {
    const text = jsonl(
      { type: 'user', timestamp: '2026-09-13T13:59:00.000Z', message: { content: 'run it' } },
      { type: 'assistant', timestamp: '2026-09-13T14:00:00.000Z', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Bash' }] } },
      { type: 'user', timestamp: '2026-09-13T14:00:05.000Z', toolUseResult: {}, message: { content: [{ type: 'tool_result' }] } },
      { type: 'assistant', timestamp: '2026-09-13T14:00:09.000Z', message: { content: [{ type: 'text', text: 'done' }] } },
    )
    expect(activityFromTail('claude', text, false)).toEqual({ lastActivityAt: '2026-09-13T14:00:09.000Z', lastTool: 'Bash' })
  })

  it('does not report a tool from a turn that is already over', () => {
    const text = jsonl(
      { type: 'assistant', timestamp: '2026-09-13T10:00:00.000Z', message: { content: [{ type: 'tool_use', name: 'Edit' }] } },
      { type: 'user', timestamp: '2026-09-13T11:00:00.000Z', message: { content: 'thanks, now just explain it' } },
      { type: 'assistant', timestamp: '2026-09-13T11:00:04.000Z', message: { content: [{ type: 'text', text: 'Here is why.' }] } },
    )
    expect(activityFromTail('claude', text, false)).toEqual({ lastActivityAt: '2026-09-13T11:00:04.000Z', lastTool: null })
  })

  it('keeps the turn open across a tool result, whichever marker the result carries', () => {
    // Measured 2026-09-13 over 143 recent transcripts on this Mac: 26,759 tool results carry
    // both `toolUseResult` and a `tool_result` block, and 3 carry only the block. Either
    // marker alone must read as mid-turn, or the tool before it is lost.
    const turn = (result: Record<string, unknown>) => jsonl(
      { type: 'user', timestamp: '2026-09-13T13:59:00.000Z', message: { content: 'run it' } },
      { type: 'assistant', timestamp: '2026-09-13T14:00:00.000Z', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
      { type: 'user', timestamp: '2026-09-13T14:00:05.000Z', ...result },
      { type: 'assistant', timestamp: '2026-09-13T14:00:09.000Z', message: { content: [{ type: 'text', text: 'done' }] } },
    )
    const expected = { lastActivityAt: '2026-09-13T14:00:09.000Z', lastTool: 'Bash' }
    expect(activityFromTail('claude', turn({ message: { content: [{ type: 'tool_result' }] } }), false), 'block only').toEqual(expected)
    expect(activityFromTail('claude', turn({ toolUseResult: 'Error: exit 1', message: { content: 'Error: exit 1' } }), false), 'toolUseResult only').toEqual(expected)
  })

  it('drops the half line a tail read starts on, and survives junk lines', () => {
    const text = '{"type":"user","timest' + '\n' + 'not json\n' + jsonl({ type: 'user', timestamp: '2026-09-13T01:02:03Z', message: { content: 'hi' } })
    expect(activityFromTail('claude', text, true)).toEqual({ lastActivityAt: '2026-09-13T01:02:03.000Z', lastTool: null })
  })

  it('drops the first line of a mid-file tail even when that line happens to parse', () => {
    const text = JSON.stringify({ type: 'user', timestamp: '2026-09-13T09:00:00.000Z', message: {} }) + '\n'
      + jsonl({ type: 'queue-operation', timestamp: '2026-09-13T10:00:00.000Z' })
    expect(activityFromTail('claude', text, true).lastActivityAt).toBeNull()
    expect(activityFromTail('claude', text, false).lastActivityAt).toBe('2026-09-13T09:00:00.000Z')
  })

  it('answers null when there is no conversation record or the clock is bad', () => {
    expect(activityFromTail('claude', jsonl({ type: 'queue-operation', timestamp: '2026-09-13T00:11:15.000Z' }), false)).toEqual({ lastActivityAt: null, lastTool: null })
    expect(activityFromTail('claude', jsonl({ type: 'user', timestamp: 'yesterday', message: {} }), false).lastActivityAt).toBeNull()
    expect(activityFromTail('cursor', jsonl({ type: 'user', timestamp: '2026-09-13T00:00:00Z' }), false)).toEqual({ lastActivityAt: null, lastTool: null })
  })
})

describe('last activity from a Codex transcript', () => {
  it('reads response items and names every tool kind', () => {
    const turn = (payload: Record<string, unknown>) => jsonl(
      { type: 'response_item', timestamp: '2026-09-12T20:00:00.000Z', payload: { type: 'message', role: 'user' } },
      { type: 'response_item', timestamp: '2026-09-12T20:01:00.000Z', payload },
      { type: 'response_item', timestamp: '2026-09-12T20:02:00.000Z', payload: { type: 'message', role: 'assistant' } },
      { type: 'event_msg', timestamp: '2026-09-12T22:00:00.000Z', payload: { type: 'token_count' } },
    )
    expect(activityFromTail('codex', turn({ type: 'function_call', name: 'shell' }), false)).toEqual({ lastActivityAt: '2026-09-12T20:02:00.000Z', lastTool: 'shell' })
    expect(activityFromTail('codex', turn({ type: 'custom_tool_call', name: 'apply_patch' }), false).lastTool).toBe('apply_patch')
    expect(activityFromTail('codex', turn({ type: 'local_shell_call' }), false).lastTool).toBe('local_shell')
    expect(activityFromTail('codex', turn({ type: 'web_search_call' }), false).lastTool).toBe('web_search')
  })

  it('does not report a tool from before the latest user message', () => {
    const text = jsonl(
      { type: 'response_item', timestamp: '2026-09-12T20:01:00.000Z', payload: { type: 'function_call', name: 'shell' } },
      { type: 'response_item', timestamp: '2026-09-12T21:00:00.000Z', payload: { type: 'message', role: 'user' } },
    )
    expect(activityFromTail('codex', text, false)).toEqual({ lastActivityAt: '2026-09-12T21:00:00.000Z', lastTool: null })
  })
})

describe('reading from disk', () => {
  beforeEach(() => clearSessionActivityMemo())

  it('widens past a tail of bookkeeping to find the last real record', async () => {
    const file = join(dir(), 'widen.jsonl')
    writeFileSync(file, jsonl({ type: 'assistant', timestamp: '2026-09-13T12:00:00.000Z', message: { content: [{ type: 'tool_use', name: 'Grep' }] } }) + bookkeeping(ACTIVITY_TAIL_BYTES * 2))
    expect(await readSessionActivity('claude', file)).toEqual({ lastActivityAt: '2026-09-13T12:00:00.000Z', lastTool: 'Grep' })
  })

  it('stops widening at the cap rather than reading a whole huge file', async () => {
    const file = join(dir(), 'cap.jsonl')
    writeFileSync(file, jsonl({ type: 'user', timestamp: '2026-09-13T12:00:00.000Z', message: { content: 'hi' } }) + bookkeeping(ACTIVITY_TAIL_MAX_BYTES + 1024 * 1024))
    expect((await readSessionActivity('claude', file)).lastActivityAt).toBeNull()
  })

  it('reads a small file whole, and answers null for a missing file', async () => {
    const d = dir()
    const file = join(d, 'small.jsonl')
    writeFileSync(file, jsonl({ type: 'user', timestamp: '2026-09-13T08:00:00.000Z', message: { content: 'a' } }))
    expect((await readSessionActivity('claude', file)).lastActivityAt).toBe('2026-09-13T08:00:00.000Z')
    expect(await readSessionActivity('claude', join(d, 'missing.jsonl'))).toEqual({ lastActivityAt: null, lastTool: null })
  })

  it('re-reads on an mtime change or a size change, and not otherwise', async () => {
    const file = join(dir(), 'memo.jsonl')
    writeFileSync(file, jsonl({ type: 'user', timestamp: '2026-09-13T10:00:00.000Z', message: { content: 'a' } }))
    await readSessionActivity('claude', file)
    const afterFirst = sessionActivityFileReads()
    await readSessionActivity('claude', file)
    expect(sessionActivityFileReads(), 'unchanged file is served from the memo').toBe(afterFirst)

    const later = new Date(Date.now() + 5_000)
    utimesSync(file, later, later)
    await readSessionActivity('claude', file)
    expect(sessionActivityFileReads(), 'an mtime change re-reads').toBe(afterFirst + 1)

    const mtime = statSync(file).mtime
    appendFileSync(file, jsonl({ type: 'assistant', timestamp: '2026-09-13T10:05:00.000Z', message: { content: [] } }))
    utimesSync(file, mtime, mtime)
    expect((await readSessionActivity('claude', file)).lastActivityAt, 'a size change with the same mtime re-reads').toBe('2026-09-13T10:05:00.000Z')
    expect(sessionActivityFileReads()).toBe(afterFirst + 2)
  })

  it('evicts the least recently used entry first', async () => {
    const d = dir()
    const make = (name: string) => {
      const file = join(d, `${name}.jsonl`)
      writeFileSync(file, jsonl({ type: 'user', timestamp: '2026-09-13T10:00:00.000Z', message: { content: name } }))
      return file
    }
    const [a, b, c] = [make('a'), make('b'), make('c')]
    const opts = { memoMax: 2 }
    await readSessionActivity('claude', a, opts)
    await readSessionActivity('claude', b, opts)
    await readSessionActivity('claude', a, opts)
    const beforeC = sessionActivityFileReads()
    await readSessionActivity('claude', c, opts)
    await readSessionActivity('claude', a, opts)
    expect(sessionActivityFileReads(), 'a was used most recently and stays cached').toBe(beforeC + 1)
    await readSessionActivity('claude', b, opts)
    expect(sessionActivityFileReads(), 'b was evicted').toBe(beforeC + 2)
  })
})

describe('the working-now clock', () => {
  it('uses the last real record when it is older than the file write', () => {
    const mtime = Date.parse('2026-09-13T00:11:15.000Z')
    expect(activityClockMs(mtime, { lastActivityAt: '2026-09-10T18:01:00.000Z', lastTool: null })).toBe(Date.parse('2026-09-10T18:01:00.000Z'))
    expect(activityClockMs(mtime, { lastActivityAt: null, lastTool: null })).toBe(mtime)
    expect(activityClockMs(mtime, null)).toBe(mtime)
    expect(activityClockMs(mtime, { lastActivityAt: '2026-09-14T00:00:00.000Z', lastTool: null }), 'a record newer than the file is clock skew').toBe(mtime)
  })
})

describe('bounded concurrency', () => {
  it('never runs more than the limit at once and keeps order', async () => {
    let running = 0
    let peak = 0
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 2))
      running -= 1
      return n * 2
    })
    expect(peak).toBe(3)
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
  })
})
