// 7.0.1 (Needs you stale): the session-activity read behind the open list's supersede rule, and the two callers that
// use it (GET /api/work-board/activity/open and the inbox summary's Your move count).
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentSessionRoots } from './agent-session-store.js'
import { clearWorkSessionActivityCache, claudeHumanTurn, codexHumanTurn, workSessionActivity, workSessionActivityWalks, waitingSessionIds, WORK_SESSION_ACTIVITY_LIMITS } from './work-session-activity.js'
import { loadClaudeTranscriptIndex } from './agent-session-store.js'
import { projectOpenWork, readWorkJournal, WORK_ACTIVITY_LIMITS, type WorkJournal } from './work-activity.js'
import { countYourMove, createYourMoveCounter } from './your-move-count.js'
import { createWorkBoardRouter } from '../routes/work-board.js'
import { requireApiToken } from './api-auth.js'

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  clearWorkSessionActivityCache()
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
})
const temp = (prefix: string) => { const root = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(root); return root }

const NATIVE = '56627115-dbce-4030-ae47-446252b4cdad', S = `claude:${NATIVE}`
const LAST = '2026-11-08T05:08:44.839Z'
/** A Claude transcript whose last conversation record is LAST, followed by a relaunch's bookkeeping. */
function claudeHome(native = NATIVE, last = LAST) {
  const home = temp('work-session-home-')
  const dir = join(home, '.claude', 'projects', '-Users-x-MU-Chief-Staff'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${native}.jsonl`), [
    { type: 'user', timestamp: '2026-10-31T07:20:00.000Z', message: { role: 'user', content: 'older turn' } },
    { type: 'assistant', timestamp: '2026-10-31T07:25:59.453Z', message: { role: 'assistant', content: [{ type: 'text', text: 'status line' }] } },
    { type: 'user', timestamp: last, message: { role: 'user', content: 'a turn of yours on Nov 7' } },
    { type: 'queue-operation', timestamp: '2026-11-09T00:00:00.000Z' },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  return agentSessionRoots(home)
}

describe('workSessionActivity', () => {
  it('reads the newest conversation record of a linked Claude session, never a relaunch\'s bookkeeping', async () => {
    const found = await workSessionActivity([S], { roots: claudeHome(), env: {} })
    expect([...found]).toEqual([[S, Date.parse(LAST)]])
  })
  it('leaves out what it cannot read: no transcript, a short id, a path, another provider\'s form', async () => {
    const r = claudeHome()
    const found = await workSessionActivity(['claude:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'claude:56627115', `claude:../${NATIVE}`, `ollama:${NATIVE}`, NATIVE], { roots: r, env: {} })
    expect(found.size).toBe(0)
  })
  it('an isolated runtime with no fixture roots reads nothing', async () => {
    const r = claudeHome()
    const prev = process.env.COS_AGENT_SESSIONS_HOME
    process.env.COS_AGENT_SESSIONS_HOME = join(r.claudeProjects, '..', '..')
    try {
      expect((await workSessionActivity([S], { env: { VITEST: 'true' } })).size).toBe(0)
      expect((await workSessionActivity([S], { env: { NODE_ENV: 'test' } })).size).toBe(0)
      expect((await workSessionActivity([S], { env: {} })).get(S)).toBe(Date.parse(LAST))
    } finally { if (prev === undefined) delete process.env.COS_AGENT_SESSIONS_HOME; else process.env.COS_AGENT_SESSIONS_HOME = prev }
  })
  it('reads at most a dozen sessions per call', async () => {
    const r = claudeHome()
    const ids = Array.from({ length: 20 }, (_, i) => `claude:${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`)
    const many = await workSessionActivity([...ids, S], { roots: r, env: {} })
    expect(many.has(S)).toBe(false)
    expect((await workSessionActivity([...ids.slice(0, WORK_SESSION_ACTIVITY_LIMITS.sessions - 1), S], { roots: r, env: {} })).has(S)).toBe(true)
  })
  it('a Cursor session (no record clock) answers its transcript\'s write time', async () => {
    const home = temp('work-session-cursor-'), id = '99999999-8888-4777-8666-555555555555'
    const dir = join(home, '.cursor', 'projects', 'Users-x-repo', 'agent-transcripts', id); mkdirSync(dir, { recursive: true })
    const file = join(dir, `${id}.jsonl`); writeFileSync(file, '{"role":"user"}\n')
    const when = new Date(LAST); utimesSync(file, when, when)
    const at = (await workSessionActivity([`cursor:${id}`], { roots: agentSessionRoots(home), env: {} })).get(`cursor:${id}`)
    expect(Math.abs(at! - when.getTime())).toBeLessThan(2)   // the filesystem keeps sub-millisecond time
  })
  it('stops at its time bound and answers what it has (nothing yet), never waiting on a slow disk', async () => {
    const r = claudeHome()
    for (let i = 0; i < 400; i++) mkdirSync(join(r.claudeProjects, `-Users-x-pad-${i}`))
    expect((await workSessionActivity([S], { roots: r, env: {}, timeoutMs: 0 })).size).toBe(0)
    expect((await workSessionActivity([S], { roots: r, env: {} })).get(S)).toBe(Date.parse(LAST))
  })
  it('waitingSessionIds takes only needsInput items that name a session', () => {
    expect(waitingSessionIds([{ group: 'needsInput', sessionId: S }, { group: 'running', sessionId: 'claude:x' }, { group: 'needsInput' }, { group: 'attention', sessionId: 'codex:y' }])).toEqual([S])
  })
  it('waitingSessionIds puts the stalest wait first, once per session (review N7: the cap keeps the likeliest stale)', () => {
    expect(waitingSessionIds([
      { group: 'needsInput', sessionId: 'claude:new', waitingSince: '2026-11-07T10:00:00Z' },
      { group: 'needsInput', sessionId: 'claude:old', waitingSince: '2026-10-31T07:25:59Z' },
      { group: 'needsInput', sessionId: 'claude:new', waitingSince: '2026-11-01T00:00:00Z' },
      { group: 'needsInput', sessionId: 'claude:mid', updatedAt: '2026-11-03T00:00:00Z' },
      { group: 'needsInput', sessionId: 'claude:undated' },
    ])).toEqual(['claude:old', 'claude:new', 'claude:mid', 'claude:undated'])
  })
})

// Record shapes as Claude Code writes them (checked read-only against a real transcript on 11/08): a typed prompt carries
// origin.kind and turnOrigin "human", often with system reminders in front; the rest is the session's own machinery.
const REPORT_AT = '2026-10-31T07:25:59.453Z', TYPED_AT = '2026-10-31T07:20:00.000Z', LATER = '2026-10-31T07:31:00.000Z'
const typed = (text: unknown, at = TYPED_AT, over: Record<string, unknown> = {}) => ({ type: 'user', timestamp: at, origin: { kind: 'human' }, promptSource: 'sdk', turnOrigin: 'human', message: { role: 'user', content: text }, ...over })
const machinery: Record<string, Record<string, unknown>> = {
  'a background agent finishing (task notification)': { type: 'user', timestamp: LATER, origin: { kind: 'task-notification', producer: 'x' }, promptSource: 'system', turnOrigin: 'task_notification', message: { role: 'user', content: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status></task-notification>' } },
  'an old-format task notification (no origin)': { type: 'user', timestamp: LATER, message: { role: 'user', content: '<task-notification><status>completed</status></task-notification>' } },
  'a tool result': { type: 'user', timestamp: LATER, toolUseResult: { stdout: 'x' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
  'a tool result with no toolUseResult field': { type: 'user', timestamp: LATER, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
  'a message from another session (peer, isMeta)': { type: 'user', timestamp: LATER, isMeta: true, origin: { kind: 'peer', from: 'x' }, promptSource: 'system', turnOrigin: 'peer', message: { role: 'user', content: 'Another session says hi' } },
  'an isMeta record (a skill or command body)': { type: 'user', timestamp: LATER, isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill' }] } },
  'a system reminder alone': { type: 'user', timestamp: LATER, promptSource: 'sdk', turnOrigin: 'sdk', message: { role: 'user', content: '<system-reminder>Remember X</system-reminder>' } },
  'a system reminder alone, with a human origin': { type: 'user', timestamp: LATER, origin: { kind: 'human' }, turnOrigin: 'human', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>Remember X</system-reminder>' }] } },
  'a compaction summary': { type: 'user', timestamp: LATER, isCompactSummary: true, isVisibleInTranscriptOnly: true, turnOrigin: 'human', message: { role: 'user', content: 'This session is being continued from a previous conversation' } },
  'a background agent finishing, no tag in its text (origin task-notification)': { type: 'user', timestamp: LATER, origin: { kind: 'task-notification' }, promptSource: 'system', turnOrigin: 'task_notification', message: { role: 'user', content: 'Background agent finished' } },
  'text the app injected (turnOrigin sdk, no origin)': { type: 'user', timestamp: LATER, promptSource: 'sdk', turnOrigin: 'sdk', message: { role: 'user', content: 'Injected by the app' } },
  'a tool result with a text block beside it': { type: 'user', timestamp: LATER, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }, { type: 'text', text: 'hook output' }] } },
  'a tool result recorded as plain text': { type: 'user', timestamp: LATER, toolUseResult: 'ok', message: { role: 'user', content: 'ok' } },
  'the assistant working': { type: 'assistant', timestamp: LATER, message: { role: 'assistant', content: [{ type: 'text', text: '"user" said so' }] } },
}

function claudeTranscript(records: unknown[], native = NATIVE) {
  const home = temp('work-session-human-')
  const dir = join(home, '.claude', 'projects', '-Users-x-MU-Chief-Staff'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${native}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n')
  return agentSessionRoots(home)
}

describe('review W3: only a turn Miles started supersedes a report', () => {
  for (const [label, record] of Object.entries(machinery)) {
    it(`${label} after the report is not a turn of his`, async () => {
      expect(claudeHumanTurn(record)).toBe(false)
      const found = await workSessionActivity([S], { roots: claudeTranscript([typed('do the QA review'), record]), env: {} })
      expect(found.get(S)).toBe(Date.parse(TYPED_AT))
    })
  }
  it('a typed prompt counts, with system reminders in front, with an image, and in the old format with no origin', () => {
    expect(claudeHumanTurn(typed('go ahead'))).toBe(true)
    expect(claudeHumanTurn(typed([{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }, { type: 'text', text: 'ship it' }]))).toBe(true)
    expect(claudeHumanTurn(typed([{ type: 'image', source: {} }]))).toBe(true)
    expect(claudeHumanTurn({ type: 'user', timestamp: TYPED_AT, message: { role: 'user', content: 'older format prompt' } })).toBe(true)
  })
  it('the open list keeps a needs-input report when only a background agent and tool results followed it', async () => {
    const r = claudeTranscript([typed('do the QA review'), machinery['a background agent finishing (task notification)'], machinery['a tool result'], machinery['the assistant working']])
    const activity = await workSessionActivity([S], { roots: r, env: {} })
    const listed = projectOpenWork(journal()() as WorkJournal, [row], NOW, { sessionActivityMs: activity })
    expect(listed.items[0]).toMatchObject({ group: 'needsInput' }); expect(listed.items[0]).not.toHaveProperty('supersededAt')
    // His next prompt, past the grace, supersedes it.
    const later = new Date(Date.parse(REPORT_AT) + (WORK_ACTIVITY_LIMITS.supersedeSeconds + 1) * 1000).toISOString()
    clearWorkSessionActivityCache()
    const r2 = claudeTranscript([typed('do the QA review'), machinery['a tool result'], typed('what is next?', later), machinery['a background agent finishing (task notification)']])
    const after = projectOpenWork(journal()() as WorkJournal, [row], NOW, { sessionActivityMs: await workSessionActivity([S], { roots: r2, env: {} }) })
    expect(after.items[0]).toMatchObject({ group: 'running', supersededAt: later })
  })
  it('Codex: a message he sent counts; injected context and another agent\'s message do not', async () => {
    expect(codexHumanTurn({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the bug' }] } })).toBe(true)
    expect(codexHumanTurn({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /x' }, { type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } })).toBe(false)
    expect(codexHumanTurn({ type: 'response_item', payload: { type: 'agent_message', author: 'a', content: [{ type: 'input_text', text: 'hello' }] } })).toBe(false)
    expect(codexHumanTurn({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } })).toBe(false)
    const home = temp('work-session-codex-'), id = '01a1b996-94be-7f11-a7b3-3bbbcd9dfb53'
    const dir = join(home, '.codex', 'sessions', '2026', '11', '07'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `rollout-2026-11-07T23-16-55-${id}.jsonl`), [
      { type: 'response_item', timestamp: TYPED_AT, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the bug' }] } },
      { type: 'response_item', timestamp: LATER, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
      { type: 'response_item', timestamp: LATER, payload: { type: 'function_call', name: 'shell' } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n')
    expect((await workSessionActivity([`codex:${id}`], { roots: agentSessionRoots(home), env: {} })).get(`codex:${id}`)).toBe(Date.parse(TYPED_AT))
  })
})

describe('review W4: one walk, cached, shared, and the deadline stops the work', () => {
  it('a second read inside 30 s walks nothing; after 30 s it reads again', async () => {
    let t = Date.parse('2026-11-08T06:00:00Z')
    const r = claudeHome()
    const now = () => t
    expect((await workSessionActivity([S], { roots: r, env: {}, now })).get(S)).toBe(Date.parse(LAST))
    expect(workSessionActivityWalks()).toBe(1)
    t += WORK_SESSION_ACTIVITY_LIMITS.cacheMs - 1000
    expect((await workSessionActivity([S], { roots: r, env: {}, now })).get(S)).toBe(Date.parse(LAST))
    expect(workSessionActivityWalks()).toBe(1)
    t += 2000
    await workSessionActivity([S], { roots: r, env: {}, now })
    expect(workSessionActivityWalks()).toBe(2)
  })
  it('concurrent callers share one read', async () => {
    const r = claudeHome()
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => workSessionActivity([S], { roots: r, env: {} })))
    expect([a.get(S), b.get(S), c.get(S)]).toEqual([Date.parse(LAST), Date.parse(LAST), Date.parse(LAST)])
    expect(workSessionActivityWalks()).toBe(1)
  })
  it('several sessions in one call build the transcript index once', async () => {
    const r = claudeHome()
    const other = '11111111-2222-4333-8444-555555555555'
    const dir = join(r.claudeProjects, '-Users-x-MU-Chief-Staff')
    writeFileSync(join(dir, `${other}.jsonl`), JSON.stringify(typed('hi', LAST)) + '\n')
    const found = await workSessionActivity([S, `claude:${other}`], { roots: r, env: {} })
    expect(found.size).toBe(2)
    expect(workSessionActivityWalks()).toBe(1)
  })
  it('the index walk checks its deadline between folders, and a cut walk is never cached', async () => {
    const r = claudeHome()
    for (let i = 0; i < 50; i++) mkdirSync(join(r.claudeProjects, `-Users-x-pad-${String(i).padStart(2, '0')}`))
    let checks = 0
    const partial = await loadClaudeTranscriptIndex(r, () => ++checks > 3)
    expect(checks).toBe(4)
    expect(partial.size).toBeLessThanOrEqual(1)
    // A clock that passes the deadline during the walk: nothing is answered and nothing is cached, so the next call reads.
    let t = 0
    const cut = await workSessionActivity([S], { roots: r, env: {}, timeoutMs: 5, now: () => (t += 1) })
    expect(cut.size).toBe(0)
    await new Promise(res => setTimeout(res, 20))
    expect((await workSessionActivity([S], { roots: r, env: {} })).get(S)).toBe(Date.parse(LAST))
    expect(workSessionActivityWalks()).toBe(2)
  })
})

// The live receipt e840cc8e (COS Control's journal on 11/07), reduced to what the open list reads.
const WORK = 'a3e811fbc87a'
const created = 1_793_394_823.090714, report = 1_793_431_559.453
const liveReceipt = () => ({ id: 'e840cc8e-a0be-41fb-a00b-a61d6fca35c3', workID: `task:personal:${WORK}`, workTitle: 'Private task', sourceRevision: 'r',
  mode: 'continueSession', provider: 'claude', modelID: 'existing-session', sessionID: S, sessionTitle: 'COS Glasses - QA review before publish', status: 'delivered',
  channel: 'turn', detail: 'SECRET detail', prompt: 'SECRET prompt', createdAt: created,
  progress: { tag: WORK, reported: 'needsInput', reportedBy: 'session', evidence: 'Your test in the morning is the next step.', receivedAt: created + 1,
    seenReplies: [], notified: [], baseline: [], events: [{ id: '1', at: created, kind: 'sent', text: 'x' }, { id: '9', at: report, kind: 'needsInput', text: 'x' }] } })
const row = { id: WORK, domain: 'personal', title: 'Speaker Diarization for mac meeting', workIdentity: WORK, meetingRefs: [], checked: false }
// Another card, running in another session with no report: never read.
const OTHER = 'b'.repeat(12), OTHER_SESSION = 'codex:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const otherReceipt = () => ({ ...liveReceipt(), id: 'other', workID: `task:personal:${OTHER}`, provider: 'codex', sessionID: OTHER_SESSION, status: 'running', progress: undefined })
const otherRow = { ...row, id: OTHER, workIdentity: OTHER, title: 'Another card' }
function journal(extra: unknown[] = []) {
  const root = temp('work-session-journal-'), journalPath = join(root, 'handoffs.json')
  writeFileSync(journalPath, JSON.stringify({ version: 2, receipts: [liveReceipt(), ...extra], sessions: [], drafts: [] }), { mode: 0o600 })
  return () => readWorkJournal({ journalPath })
}
const NOW = Date.parse('2026-11-08T05:08:46.000Z')

describe('the open list and the Your move count read the session', () => {
  async function route(sessionActivity: (ids: readonly string[]) => Promise<ReadonlyMap<string, number>>) {
    const app = express(); app.use('/api', requireApiToken('fixture-token'))
    app.use('/api', createWorkBoardRouter({ journal: journal([otherReceipt()]), list: vi.fn(async () => [row, otherRow]) as never, now: () => NOW, sessionActivity }))
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/work-board/activity/open`, { headers: { 'X-COS-Token': 'fixture-token' } })
    return res.json()
  }
  it('GET /activity/open reads only the waiting sessions, and a superseded report leaves needsInput', async () => {
    const asked: string[][] = []
    const body = await route(async ids => { asked.push([...ids]); return new Map([[S, Date.parse(LAST)]]) })
    expect(asked).toEqual([[S]])
    expect(body.items).toEqual([expect.objectContaining({ id: 'e840cc8e-a0be-41fb-a00b-a61d6fca35c3', group: 'running', supersededAt: LAST, waitingSince: '2026-10-31T07:25:59.453Z' }),
      expect.objectContaining({ id: 'other', group: 'running', sessionId: OTHER_SESSION })])
  })
  it('GET /activity/open keeps the list as it was when the read fails or finds nothing', async () => {
    for (const read of [async () => { throw new Error('disk') }, async () => new Map<string, number>()]) {
      const body = await route(read)
      expect(body.items[0]).toMatchObject({ id: 'e840cc8e-a0be-41fb-a00b-a61d6fca35c3', group: 'needsInput', waitingSince: '2026-10-31T07:25:59.453Z' }); expect(body.items[0]).not.toHaveProperty('supersededAt')
    }
  })
  it('the inbox summary stops counting it once the session moved on, and counts it while it has not', async () => {
    const j = journal()()
    expect(countYourMove(j, [row], NOW)).toBe(1)
    expect(countYourMove(j, [row], NOW, new Map([[S, Date.parse(LAST)]]))).toBe(0)
    const asked: string[][] = []
    const count = createYourMoveCounter({ journal: journal(), rows: async () => [row], now: () => NOW,
      sessionActivity: async ids => { asked.push([...ids]); return new Map([[S, Date.parse(LAST)]]) } })
    expect(await count()).toBe(0); expect(asked).toEqual([[S]])
    const failing = createYourMoveCounter({ journal: journal(), rows: async () => [row], now: () => NOW, sessionActivity: async () => { throw new Error('disk') } })
    expect(await failing()).toBe(1)
    expect(await createYourMoveCounter({ journal: journal(), rows: async () => [row], now: () => NOW })()).toBe(1)
  })
})
