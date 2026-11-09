import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanAskText, codexScanHeldBytes, readRecentActivity, resetRecentActivityMemo } from './agent-session-recent.js'

// Transcript lines in the shapes Claude Code and Codex write (checked against real transcripts on 11/09: Claude user rows
// with origin.kind peer and the "Another Claude session sent a message" frame, <pasted_content id=...> blocks; Codex
// response_item rows with role before content and assistant phase commentary or final_answer).
let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recent-')); resetRecentActivityMemo() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const NOW = Date.parse('2026-11-09T12:30:00Z')
const T = (minAgo: number) => new Date(NOW - minAgo * 60000).toISOString()
const cUser = (text: string, minAgo: number, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', timestamp: T(minAgo), message: { role: 'user', content: text }, ...extra })
const cAssistant = (text: string, minAgo: number) => JSON.stringify({ type: 'assistant', timestamp: T(minAgo), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const peerFrame = (words: string) => `Another Claude session sent a message:\n${words}\n\nThis came from another Claude session, not from the user.`
const xUser = (text: string, minAgo: number) => JSON.stringify({ timestamp: T(minAgo), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
const xAssistant = (text: string, minAgo: number, phase = 'final_answer') => JSON.stringify({ timestamp: T(minAgo), type: 'response_item', payload: { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] } })
const file = (name: string, lines: string[]) => { const f = join(dir, name); writeFileSync(f, lines.join('\n') + '\n'); return f }

describe('Claude: the last asks, the latest reply, when it moved', () => {
  it('keeps the newest three asks oldest first, the newest reply, and the newest record time', async () => {
    const f = file('c.jsonl', [
      cUser('Yesterday we ran a bakeoff to improve transcription quality', 29 * 24 * 60),
      cAssistant('Bakeoff plan ready.', 29 * 24 * 60 - 1),
      cUser('is everything live?', 16),
      cUser('any changes pending?', 14),
      cUser('please start the release process', 12),
      cAssistant('The public release is live.', 11),
    ])
    const r = (await readRecentActivity('claude', f, NOW))!
    expect(r.asks.map(a => a.text)).toEqual(['is everything live?', 'any changes pending?', 'please start the release process'])
    expect(r.asks.every(a => a.via === 'typed')).toBe(true)
    expect(r.reply).toEqual({ at: NOW - 11 * 60000, text: 'The public release is live.' })
    expect(r.movedAt).toBe(NOW - 11 * 60000)
  })
  it('sidechains, isMeta and isCompactSummary rows and tool results are not asks', async () => {
    const f = file('c.jsonl', [
      cUser('the real ask', 30),
      cUser('a sidechain prompt', 20, { isSidechain: true }),
      cUser('slash command body', 19, { isMeta: true }),
      cUser('This session is being continued from a previous conversation. Summary', 18, { isCompactSummary: true }),
      JSON.stringify({ type: 'user', timestamp: T(17), toolUseResult: { stdout: 'x' }, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }),
    ])
    const r = (await readRecentActivity('claude', f, NOW))!
    expect(r.asks.map(a => a.text)).toEqual(['the real ask'])
    expect(r.movedAt, 'a tool result still moves the session').toBe(NOW - 17 * 60000)
  })
  it('a peer row is sent in from another screen or session, unwrapped; a footer marks one too; agent protocol is not an ask', async () => {
    const f = file('c.jsonl', [
      cUser(peerFrame('Anything else we have not used for 6 months?'), 7, { isMeta: true, origin: { kind: 'peer' } }),
      cUser(peerFrame('<cross-session-message from="uds:x">Root ACK</cross-session-message>'), 6, { isMeta: true, origin: { kind: 'peer' } }),
      cUser('What should we test once we reload?\n[COS-G2 turn ctmux1234abcd · verify: operations/scripts/cos_python operations/scripts/verify_g2_turn.py ctmux1234abcd --session <your session id> --provider claude]', 5, { origin: { kind: 'human' } }),
      cUser('can you look at an obvious cleanup', 4, { origin: { kind: 'human' } }),
    ])
    const r = (await readRecentActivity('claude', f, NOW))!
    expect(r.asks).toEqual([
      { at: NOW - 7 * 60000, text: 'Anything else we have not used for 6 months?', via: 'peer' },
      { at: NOW - 5 * 60000, text: 'What should we test once we reload?', via: 'peer' },
      { at: NOW - 4 * 60000, text: 'can you look at an obvious cleanup', via: 'typed' },
    ])
  })
  it('pasted JSON becomes [pasted data]; wrapper tags go', async () => {
    expect(cleanAskText('Can you commit this for me: \n\n<pasted_content id="abcd">\n{\n  "v": 1,\n  "publicKey": "AAAA"\n}\n</pasted_content id="abcd">')).toBe('Can you commit this for me: [pasted data]')
    expect(cleanAskText('Store this:\n\n{"a": 1, "b": "x"}\n\nthanks')).toBe('Store this: [pasted data] thanks')
    expect(cleanAskText('<system-reminder>noise</system-reminder>fix <b>this</b> please')).toBe('fix this please')
    expect(cleanAskText('read <file> then <PORT>'), 'a placeholder is prose, not a tag').toBe('read <file> then <PORT>')
    // A background task's notification is a user row, not an ask (the 11/09 build replay showed two as "typed").
    expect(cleanAskText('<task-notification>\n<task-id>b86sofey1</task-id>\n<tool-use-id>toolu_01WHY6</tool-use-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>')).toBe('')
    expect(cleanAskText('done? <task-notification><status>completed</status></task-notification>')).toBe('done?')
    expect(cleanAskText('<pasted_content id="x">{"a": 1}</pasted_content id="x">'), 'a paste alone is still an ask').toBe('[pasted data]')
  })
  it('reads only the 8 MB tail it is given, and remembers a read until the file changes', async () => {
    const f = file('c.jsonl', [cUser('an ask far back in the head', 60), 'x'.repeat(5000), cUser('the newest ask', 2)])
    const a = (await readRecentActivity('claude', f, NOW, { claudeTailBytes: 400 }))!
    expect(a.asks.map(x => x.text)).toEqual(['the newest ask'])
    appendFileSync(f, cUser('one more', 1) + '\n')
    const b = (await readRecentActivity('claude', f, NOW, { claudeTailBytes: 400 }))!
    expect(b.asks.map(x => x.text)).toEqual(['the newest ask', 'one more'])
  })
  it('a session created within the day says what it started as; an older one does not', async () => {
    const f = file('c.jsonl', [cUser('I am trying to play Genshin', 30), cUser('obvious cleanup?', 5)])
    // The fixture file is born when the test runs, so these reads use the real clock.
    const fresh = (await readRecentActivity('claude', f, Date.now()))!
    expect(fresh.firstAsk).toBe('I am trying to play Genshin')
    expect(fresh.startedAt).toBeGreaterThan(0)
    const old = (await readRecentActivity('claude', f, Date.now() + 25 * 3600 * 1000))!
    expect(old.firstAsk).toBeUndefined()
  })
  it('refuses a symlink and answers null for a missing file', async () => {
    const real = file('real.jsonl', [cUser('x', 1)])
    const link = join(dir, 'link.jsonl')
    symlinkSync(real, link)
    expect(await readRecentActivity('claude', link, NOW)).toBeNull()
    expect(await readRecentActivity('claude', join(dir, 'missing.jsonl'), NOW)).toBeNull()
  })
})

describe('Codex: an incremental forward scan that survives huge lines', () => {
  it('a line over 1 MB is skipped unparsed, and the asks and final answer around it are read', async () => {
    const huge = JSON.stringify({ timestamp: T(9), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'HUGE ' + 'z'.repeat(1_200_000) }] } })
    const f = file('rollout-2026-10-11T10-46-00-019a0000-1111-2222-3333-444455556666.jsonl', [
      xUser('# AGENTS.md instructions for /Users/x\n\nrules', 20),
      xUser('is everything live? any changes or outstanding updates pending?', 16),
      huge,
      xAssistant('Checking the appcast now.', 12, 'commentary'),
      xAssistant('The public release is live. Your Mac has a newer private build.', 11),
    ])
    // The default 4 MB chunk holds the whole 1.2 MB line, so the per-line bound (not the unfinished-line bound) skips it.
    const r = (await readRecentActivity('codex', f, NOW))!
    expect(r.asks).toEqual([{ at: NOW - 16 * 60000, text: 'is everything live? any changes or outstanding updates pending?', via: 'typed' }])
    // With small chunks the same line is unfinished past the bound and is skipped by the other rule.
    resetRecentActivityMemo()
    expect((await readRecentActivity('codex', f, NOW, { chunkBytes: 64 * 1024 }))!.asks.map(a => a.text)).toEqual(['is everything live? any changes or outstanding updates pending?'])
    expect(r.asks.some(a => a.text.startsWith('HUGE'))).toBe(false)
    expect(r.reply!.text).toBe('The public release is live. Your Mac has a newer private build.')
    expect(r.movedAt).toBe(NOW - 11 * 60000)
  })
  it('a huge line that is the last thing in the file, unfinished, is skipped and the scan resumes after it', async () => {
    const f = join(dir, 'rollout-2026-11-09T10-00-00-019a0000-1111-2222-3333-444455556667.jsonl')
    writeFileSync(f, xUser('first ask', 30) + '\n' + '{"timestamp":"' + T(29) + '","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"' + 'q'.repeat(1_100_000))
    const a = (await readRecentActivity('codex', f, NOW, { chunkBytes: 256 * 1024 }))!
    expect(a.asks.map(x => x.text)).toEqual(['first ask'])
    // Memory stays bounded: the unfinished 1.1 MB line is not held for the next read (a real one was 44 MB).
    expect(codexScanHeldBytes(f)).toBe(0)
    appendFileSync(f, '"}]}}\n' + xUser('the ask after the huge line', 3) + '\n')
    const b = (await readRecentActivity('codex', f, NOW, { chunkBytes: 256 * 1024 }))!
    expect(b.asks.map(x => x.text)).toEqual(['first ask', 'the ask after the huge line'])
  })
  it('keeps its offset: a second read sees only what was appended', async () => {
    const f = file('rollout-2026-11-09T10-00-00-019a0000-1111-2222-3333-444455556668.jsonl', [xUser('one', 30)])
    expect((await readRecentActivity('codex', f, NOW))!.asks.map(a => a.text)).toEqual(['one'])
    // Rewrite the already-scanned bytes in place (same length): a forward scan never rereads them.
    writeFileSync(f, xUser('ONE', 30) + '\n' + xUser('two', 2) + '\n')
    expect((await readRecentActivity('codex', f, NOW))!.asks.map(a => a.text)).toEqual(['one', 'two'])
  })
  it('the first pass reads at most its cap from the end, dropping the line it lands inside', async () => {
    const f = file('rollout-2026-11-09T10-00-00-019a0000-1111-2222-3333-444455556669.jsonl', [xUser('far back', 300), 'x'.repeat(4000), xUser('near the end', 2)])
    const r = (await readRecentActivity('codex', f, NOW, { codexFirstPassBytes: 600, chunkBytes: 128 }))!
    expect(r.asks.map(a => a.text)).toEqual(['near the end'])
  })
  it('two reads at once share one scan', async () => {
    const f = file('rollout-2026-11-09T10-00-00-019a0000-1111-2222-3333-44445555666a.jsonl', [xUser('only', 5)])
    const [a, b] = await Promise.all([readRecentActivity('codex', f, NOW), readRecentActivity('codex', f, NOW)])
    expect(a!.asks).toEqual(b!.asks)
    expect(a!.asks).toHaveLength(1)
  })
  it('a footer marks a Codex ask as sent in from another screen', async () => {
    const f = file('rollout-2026-11-09T10-00-00-019a0000-1111-2222-3333-44445555666b.jsonl', [
      xUser('status?\n[COS-WEB turn web12345abcd · verify: operations/scripts/cos_python operations/scripts/verify_g2_turn.py web12345abcd --session <your session id> --provider codex]', 3),
    ])
    expect((await readRecentActivity('codex', f, NOW))!.asks).toEqual([{ at: NOW - 3 * 60000, text: 'status?', via: 'peer' }])
  })
})

describe('Cursor: the existing peek', () => {
  it('the last query and reply, timed by the file', async () => {
    const d = join(dir, 'proj', 'agent-transcripts', 'cid')
    mkdirSync(d, { recursive: true })
    const f = join(d, 'cid.jsonl')
    writeFileSync(f, [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nfix the favicon\n</user_query>' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Done: the favicon is set.' }] } }),
    ].join('\n') + '\n')
    const r = (await readRecentActivity('cursor', f, Date.now() + 1000))!
    expect(r.asks.map(a => a.text)).toEqual(['fix the favicon'])
    expect(r.reply!.text).toBe('Done: the favicon is set.')
  })
})
