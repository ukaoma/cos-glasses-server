// 6.50.0: the recent conversation of a session, for the lens's scroll-up history.
// Every record shape below is the shape the provider writes (copied from transcripts on
// this Mac, prompts shortened); the window test writes a file whose tool output
// dominates its bytes, which is what made the digest's 768 KiB tail hold two prompts.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SESSION_TURNS_MAX,
  SESSION_TURNS_WINDOWS,
  parseTurnsParam,
  readRecentSessionTurns,
  recentSessionTurns,
  sessionTurnFromRecord,
} from './agent-session-turns'
import { LATEST_REPLY_MAX } from './agent-session-store'

const AT = '2026-09-16T22:18:35.744Z'
const user = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'user', timestamp: AT, ...extra, message: { role: 'user', content: [{ type: 'text', text }] } })
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'assistant', timestamp: AT, ...extra, message: { role: 'assistant', content } })

describe('sessionTurnFromRecord: claude', () => {
  it('keeps what a person said and what the model wrote back', () => {
    expect(sessionTurnFromRecord('claude', user('Can we make sure that update the docs?'))).toEqual({ role: 'user', text: 'Can we make sure that update the docs?', at: AT })
    expect(sessionTurnFromRecord('claude', assistant([{ type: 'text', text: 'Pushed as c9fc56a.' }]))).toEqual({ role: 'assistant', text: 'Pushed as c9fc56a.', at: AT })
  })

  it('leaves out tool calls, tool results, sub-agents, thinking and a reply that is only a tool call', () => {
    expect(sessionTurnFromRecord('claude', assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]))).toBeNull()
    expect(sessionTurnFromRecord('claude', { type: 'user', toolUseResult: { stdout: 'x' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] } })).toBeNull()
    expect(sessionTurnFromRecord('claude', { ...user('sub-agent prompt'), isSidechain: true })).toBeNull()
    expect(sessionTurnFromRecord('claude', assistant([{ type: 'thinking', thinking: 'hmm' }]))).toBeNull()
    // Text and a tool call in one reply: the words stay.
    expect(sessionTurnFromRecord('claude', assistant([{ type: 'text', text: 'Checking the gate.' }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }]))?.text).toBe('Checking the gate.')
  })

  it('drops an injected row (a slash-command body, a compaction summary) but keeps a live Continue as the user\'s words', () => {
    expect(sessionTurnFromRecord('claude', user('# COS Glasses Server Management\n\nStart the stack.', { isMeta: true }))).toBeNull()
    expect(sessionTurnFromRecord('claude', user('This session is being continued from a previous conversation. Summary: things.', { isCompactSummary: true }))).toBeNull()
    // The row Claude Code wrote for Miles's own glasses Continue on 2026-09-16.
    const peer = user('Another Claude session sent a message:\nAlright, so this is a test to see if the hold continues. On the G2.\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf.', { isMeta: true, promptSource: 'system', origin: { kind: 'peer', from: 'unknown' } })
    expect(sessionTurnFromRecord('claude', peer)).toEqual({ role: 'user', text: 'Alright, so this is a test to see if the hold continues. On the G2.', at: AT })
  })

  it('drops wrapper prompts and harness tags, keeps lines, and caps with a visible ellipsis', () => {
    expect(sessionTurnFromRecord('claude', user('<command-message>cos-glasses</command-message>'))).toBeNull()
    expect(sessionTurnFromRecord('claude', user('<system-reminder>ctx</system-reminder>'))).toBeNull()
    const shaped = sessionTurnFromRecord('claude', assistant([{ type: 'text', text: '## Result\n\n- one\n- two\n\n```ts\nconst x = 1\n```\n\nDone <system-reminder>x</system-reminder>' }]))
    expect(shaped?.text).toContain('## Result\n\n- one\n- two')
    expect(shaped?.text).not.toContain('const x = 1')
    expect(shaped?.text).not.toContain('system-reminder')
    const long = sessionTurnFromRecord('claude', assistant([{ type: 'text', text: 'word '.repeat(2000) }]))
    expect(long?.text.length).toBe(LATEST_REPLY_MAX)
    expect(long?.text.endsWith('…')).toBe(true)
  })

  it('omits a timestamp the provider did not write, or wrote badly', () => {
    expect(sessionTurnFromRecord('claude', { ...user('hi'), timestamp: undefined })).toEqual({ role: 'user', text: 'hi' })
    expect(sessionTurnFromRecord('claude', { ...user('hi'), timestamp: 'not a date' })).toEqual({ role: 'user', text: 'hi' })
  })
})

describe('sessionTurnFromRecord: codex and cursor', () => {
  it('codex: response_item messages only; developer, tool calls and events are not the conversation', () => {
    const msg = (role: string, text: string, kind = 'input_text') => ({ type: 'response_item', timestamp: AT, payload: { type: 'message', role, content: [{ type: kind, text }] } })
    expect(sessionTurnFromRecord('codex', msg('user', 'Fix the lease.'))).toEqual({ role: 'user', text: 'Fix the lease.', at: AT })
    expect(sessionTurnFromRecord('codex', msg('assistant', 'Fixed.', 'output_text'))).toEqual({ role: 'assistant', text: 'Fixed.', at: AT })
    expect(sessionTurnFromRecord('codex', msg('developer', 'rules'))).toBeNull()
    expect(sessionTurnFromRecord('codex', { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } })).toBeNull()
    expect(sessionTurnFromRecord('codex', { type: 'event_msg', payload: { type: 'agent_message', message: 'dup' } })).toBeNull()
  })

  it('cursor: the ask out of <user_query>, the reply as written', () => {
    const row = (role: string, text: string) => ({ role, message: { content: [{ type: 'text', text }] } })
    expect(sessionTurnFromRecord('cursor', row('user', '<user_info>os</user_info>\n<user_query>\nRename the route.\n</user_query>'))).toEqual({ role: 'user', text: 'Rename the route.' })
    expect(sessionTurnFromRecord('cursor', row('assistant', 'Renamed.'))).toEqual({ role: 'assistant', text: 'Renamed.' })
    expect(sessionTurnFromRecord('cursor', row('system', 'x'))).toBeNull()
  })
})

describe('recentSessionTurns', () => {
  it('keeps file order and returns the newest `limit`', () => {
    const lines = ['first', 'second', 'third'].map(t => JSON.stringify(user(t)))
    expect(recentSessionTurns('claude', lines, 2).map(t => t.text)).toEqual(['second', 'third'])
    expect(recentSessionTurns('claude', [...lines, 'torn {"type":'], 5).map(t => t.text)).toEqual(['first', 'second', 'third'])
    expect(recentSessionTurns('claude', lines, 0)).toEqual([])
  })
})

describe('readRecentSessionTurns: backward windows', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const file = (rows: unknown[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-turns-'))
    dirs.push(dir)
    const path = join(dir, 'a.jsonl')
    writeFileSync(path, rows.length === 0 ? '' : rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    return path
  }
  // A tool result the size of a real one, so the bytes are the tools' and not the words'.
  const bigTool = () => ({ type: 'user', toolUseResult: { stdout: 'x'.repeat(4000) }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(4000) }] } })

  it('grows the window until it holds what was asked, and says when more came before', async () => {
    const rows: unknown[] = []
    for (let i = 0; i < 6; i++) { rows.push(user(`prompt ${i}`)); rows.push(bigTool(), bigTool()); rows.push(assistant([{ type: 'text', text: `reply ${i}` }])) }
    const path = file(rows)
    // 20 KB: about one prompt's worth. 200 KB: the whole file.
    const small = await readRecentSessionTurns('claude', path, 4, [20_000, 200_000])
    expect(small.turns.map(t => t.text)).toEqual(['prompt 4', 'reply 4', 'prompt 5', 'reply 5'])
    expect(small.more).toBe(true)
    expect(small.bytesRead).toBeGreaterThan(20_000) // it had to grow past the first window
    const all = await readRecentSessionTurns('claude', path, 40, [20_000, 200_000])
    expect(all.turns).toHaveLength(12)
    expect(all.more).toBe(false)
  })

  it('stops at its ceiling with what it found, marked as more-before, never a whole-file read', async () => {
    const rows: unknown[] = []
    for (let i = 0; i < 30; i++) { rows.push(user(`prompt ${i}`)); rows.push(bigTool(), bigTool(), bigTool()) }
    const path = file(rows)
    const capped = await readRecentSessionTurns('claude', path, 20, [15_000, 30_000])
    expect(capped.bytesRead).toBeLessThanOrEqual(30_000)
    expect(capped.turns.length).toBeGreaterThan(0)
    expect(capped.turns.length).toBeLessThan(20)
    expect(capped.more).toBe(true)
    expect(capped.turns.at(-1)?.text).toBe('prompt 29')
  })

  it('never returns a torn first record from a window that starts mid-file', async () => {
    const rows = [user('A'.repeat(300)), user('newest')]
    const path = file(rows)
    const read = await readRecentSessionTurns('claude', path, 5, [40, 10_000])
    expect(read.turns.map(t => t.text)).toEqual(['A'.repeat(300), 'newest'])
  })

  it('a window that starts EXACTLY on a record boundary keeps that record', async () => {
    const a = JSON.stringify(user('older'))
    const b = JSON.stringify(user('boundary record'))
    const path = file([user('older'), user('boundary record')])
    // One window, exactly the last record plus its newline: it begins at a line start.
    const read = await readRecentSessionTurns('claude', path, 5, [b.length + 1])
    expect(read.turns.map(t => t.text)).toEqual(['boundary record'])
    expect(read.more).toBe(true)
    expect(a.length).toBeGreaterThan(0)
  })

  it('bounds the ask and the file', async () => {
    const path = file([user('only')])
    expect((await readRecentSessionTurns('claude', path, 0)).turns).toEqual([])
    expect((await readRecentSessionTurns('claude', path, 9999)).turns).toHaveLength(1)
    expect(SESSION_TURNS_WINDOWS.at(-1)).toBe(24 * 1024 * 1024)
    const empty = file([])
    expect(await readRecentSessionTurns('claude', empty, 5)).toEqual({ turns: [], more: false, bytesRead: 0 })
  })
})

describe('parseTurnsParam', () => {
  it('accepts an integer 1..SESSION_TURNS_MAX and nothing else', () => {
    expect(parseTurnsParam('20')).toBe(20)
    expect(parseTurnsParam('1')).toBe(1)
    expect(parseTurnsParam(String(SESSION_TURNS_MAX))).toBe(SESSION_TURNS_MAX)
    for (const bad of [undefined, '', '0', String(SESSION_TURNS_MAX + 1), '-3', '2.5', '20abc', ['20'], '1000']) {
      expect(parseTurnsParam(bad), String(bad)).toBeNull()
    }
  })
})
