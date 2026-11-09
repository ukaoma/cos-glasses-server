import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTodayBrief } from '../lib/today-brief.js'
import type { TaskBoardRow } from '../lib/task-store.js'
import { createTodayBriefRouter, workInProgress } from './today-brief.js'

// No model call: the brief's `generate` is a fake. No real data folder: a temp one per test.
let dir = '', server: Server | null = null, base = ''
const prompts: string[] = []
let boardReads = 0
let board: TaskBoardRow[] | null = []

function row(over: Partial<TaskBoardRow>): TaskBoardRow {
  return { id: 'a', ref: 'r', domain: 'quilt', title: 'Card', text: 'Card', checked: false, column: 'today' as any, priority: '', section: '', stage: 'active' as any,
    due: false, missed: false, failed: false, late: false, carriedOver: false, ...over } as TaskBoardRow
}

let genDelay: Promise<void> = Promise.resolve()
let subagentCalls: string[][] = []
let subagentAnswer: (keys: string[]) => Promise<Map<string, any>> = async () => new Map()
let recentAnswer: (keys: string[]) => Map<string, any> = () => new Map()
async function start(enabled: boolean | null) {
  dir = mkdtempSync(join(tmpdir(), 'today-brief-route-'))
  if (enabled !== null) writeFileSync(join(dir, 's.json'), JSON.stringify({ schema: 1, enabled }))
  prompts.length = 0; boardReads = 0; subagentCalls = []
  const brief = createTodayBrief({
    stateFile: join(dir, 'b.json'), settingsFile: join(dir, 's.json'), env: () => ({}),
    generate: async p => { prompts.push(p); await genDelay; return 'The release is moving, and one session waits on you to approve a publish.' },
  })
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use('/api', createTodayBriefRouter({ brief, board: async () => { boardReads++; return board }, context: async (keys, into) => {
    subagentCalls.push(keys)
    // Recent activity lands first, then the sub-agents, as the real reader writes each as it is read.
    for (const [k, v] of recentAnswer(keys)) into.recent.set(k, v)
    for (const [k, v] of await subagentAnswer(keys)) into.agents.set(k, v)
  }, now: () => Date.parse('2026-11-07T13:00:00Z') }))
  server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
}
afterEach(async () => {
  if (server) await new Promise(r => server!.close(r))
  server = null
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => { board = []; subagentAnswer = async () => new Map(); recentAnswer = () => new Map() })

const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const ASK = { sessions: [{ title: 'Release QA', provider: 'claude', state: 'waiting', minutes: 5, waiting: 'Wants to run npm publish' }], needs: [], sessionsRead: true, needsComplete: true, unread: [], recording: false }

describe('POST /api/today/brief', () => {
  it('off: answers off, reads no board and calls no model', async () => {
    await start(null)
    const res = await post('/today/brief', ASK)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(await res.json()).toMatchObject({ state: 'off', text: '', enabled: false, source: 'default' })
    expect(boardReads).toBe(0)
    expect(prompts).toHaveLength(0)
  })
  it('on: writes one from the body plus the server’s own Work cards in progress', async () => {
    await start(true)
    board = [row({ title: 'Ship the Today summary', workStage: 'draft' }), row({ title: 'Done card', checked: true, workStage: 'qa' }), row({ title: 'Someday', workStage: 'planned' })]
    const res = await post('/today/brief', ASK)
    const v = await res.json()
    expect(v).toMatchObject({ state: 'fresh', model: 'sonnet', basis: '1 session and 1 Work card' })
    expect(v.text).toContain('release')
    expect(prompts[0]).toContain('Ship the Today summary (being built)')
    expect(prompts[0]).not.toContain('Done card')
    expect(prompts[0]).not.toContain('Someday')
    const peek = await (await fetch(base + '/today/brief')).json()
    expect(peek).toMatchObject({ state: 'fresh', text: v.text })
  })
  it('a Work list in the body is refused: Work comes only from the server', async () => {
    await start(true)
    const res = await post('/today/brief', { ...ASK, work: [{ title: 'Injected', stage: 'qa' }] })
    expect(res.status).toBe(400)
    expect(prompts).toHaveLength(0)
  })
  it('a body that is not an object, or too large, is refused before anything runs', async () => {
    await start(true)
    expect((await post('/today/brief', [1, 2])).status).toBe(400)
    expect((await post('/today/brief', { ...ASK, sessions: Array.from({ length: 200 }, () => ({ title: 'x'.repeat(400), state: 'open', line: 'y'.repeat(400) })) })).status).toBe(413)
    expect(prompts).toHaveLength(0)
  })
  it('a board that cannot be read costs only the Work cards', async () => {
    await start(true)
    board = null
    const v = await (await post('/today/brief', ASK)).json()
    expect(v.state).toBe('fresh')
    expect(v.basis).toBe('1 session')
  })
})

describe('sub-agents on the ask', () => {
  const K = (n: number) => 'claude|aaaaaaaa-1111-4111-8111-11111111111' + n
  const body = { ...ASK, sessions: [
    { title: 'Quiet one', provider: 'claude', state: 'open', minutes: 400, key: K(1) },
    { title: 'Orchestrator', provider: 'claude', state: 'working', minutes: 50, key: K(2), agents: { active: 1, completed: 0, total: 1 } },
    { title: 'Release QA', provider: 'claude', state: 'waiting', minutes: 5, key: K(3) },
  ] }
  it('reads them for waiting and working sessions first, and the prompt names them without any id', async () => {
    await start(true)
    subagentAnswer = async () => new Map([[K(2), { rows: [{ name: 'today-brief-builder', task: 'Today summary via Haiku', status: 'running', at: Date.parse('2026-11-07T12:56:00Z') }], running: 1, idle: 0, done: 0, failed: 0, total: 1 }]])
    expect((await (await post('/today/brief', body)).json()).state).toBe('fresh')
    expect(subagentCalls).toEqual([[K(3), K(2), K(1)]])
    expect(prompts[0]).toContain('"today-brief-builder" (running, moved 4 min ago): "Today summary via Haiku"')
    expect(prompts[0]).not.toMatch(/aaaaaaaa|claude\|/)
  })
  it('a slow read never holds the ask past its wait: the page\u2019s counts go instead', async () => {
    await start(true)
    subagentAnswer = () => new Promise(() => {})
    const t0 = Date.now()
    expect((await (await post('/today/brief', body)).json()).state).toBe('fresh')
    expect(Date.now() - t0).toBeLessThan(4000)
    expect(prompts[0]).toContain('in the last 2 hours: 1 running')
  }, 8000)
  it('a failed read is the same as none', async () => {
    await start(true)
    subagentAnswer = async () => { throw new Error('boom') }
    expect((await (await post('/today/brief', body)).json()).state).toBe('fresh')
  })
  it('off reads no sub-agents either', async () => {
    await start(null)
    await post('/today/brief', body)
    expect(subagentCalls).toEqual([])
  })
})

describe('6.99.26 QA: a gated ask reads nothing', () => {
  it('two Todays asking at once share the one call: the second is not turned away as inside the interval', async () => {
    await start(true)
    let go!: () => void
    genDelay = new Promise(r => { go = r })
    const a = post('/today/brief', ASK)
    await new Promise(r => setTimeout(r, 50))
    const b = post('/today/brief', ASK)
    await new Promise(r => setTimeout(r, 50))
    go()
    const [va, vb] = await Promise.all([(await a).json(), (await b).json()])
    genDelay = Promise.resolve()
    expect([va.state, vb.state]).toEqual(['fresh', 'fresh'])
    expect(prompts).toHaveLength(1)
  })
  it('inside the 10-minute interval the POST reads neither the board nor a transcript, and answers from the page', async () => {
    await start(true)
    const body = { ...ASK, sessions: [{ title: 'Release QA', provider: 'claude', state: 'waiting', minutes: 5, key: 'claude|aaaaaaaa-1111-4111-8111-111111111111' }] }
    expect((await (await post('/today/brief', body)).json()).state).toBe('fresh')
    const reads = [boardReads, subagentCalls.length]
    const again = await (await post('/today/brief', { ...body, sessions: [{ ...body.sessions[0], title: 'Release QA moved' }] })).json()
    expect(again).toMatchObject({ state: 'stale', reason: 'interval' })
    expect([boardReads, subagentCalls.length]).toEqual(reads)
    expect(again.text.startsWith('One thing needs you. ')).toBe(true)
  })
})

describe('the settings route', () => {
  it('reads and writes the toggle; anything but { enabled: boolean } is refused', async () => {
    await start(null)
    expect(await (await fetch(base + '/today/brief/settings')).json()).toEqual({ enabled: false, source: 'default', saved: null, dailyCap: 100 })
    expect(await (await post('/today/brief/settings', { enabled: true })).json()).toEqual({ enabled: true, source: 'settings', saved: true, status: null, dailyCap: 100 })
    expect((await post('/today/brief/settings', { enabled: 'yes' })).status).toBe(400)
    expect((await post('/today/brief/settings', { enabled: true, extra: 1 })).status).toBe(400)
    expect((await (await post('/today/brief', ASK)).json()).state).toBe('fresh')
  })
})

describe('workInProgress', () => {
  it('drafting to QA, or an agent on it; never done or delegated; running first; at most 12', () => {
    const rows = [
      row({ title: 'Planned only', workStage: 'planned' }),
      row({ title: 'Planned with an agent', workStage: 'planned', agentState: 'running' }),
      row({ title: 'In QA', workStage: 'qa' }),
      row({ title: 'Delegated', workStage: 'draft', delegated: true }),
      row({ title: 'Legacy active', stage: 'active' as any }),
      ...Array.from({ length: 20 }, (_, n) => row({ title: 'Built ' + n, workStage: 'built' })),
    ]
    const out = workInProgress(rows)
    expect(out).toHaveLength(12)
    // An undated card's last move is unknown (null), never "just now".
    expect(out[0]).toEqual({ title: 'Planned with an agent', stage: 'planned', running: true, movedMinutes: null })
    expect(out.map(w => w.title)).toContain('In QA')
    expect(out.map(w => w.title)).toContain('Legacy active')
    expect(out.map(w => w.title)).not.toContain('Planned only')
    expect(out.map(w => w.title)).not.toContain('Delegated')
    expect(workInProgress(null)).toEqual([])
  })
})

describe('readSessionContext (the server’s own reads)', () => {
  it('finds a Claude session by id under the sessions home and reads its sub-agents; a bad or unknown key reads nothing', async () => {
    const { readSessionContext } = await import('./today-brief.js')
    const home = mkdtempSync(join(tmpdir(), 'brief-home-'))
    const prev = process.env.COS_AGENT_SESSIONS_HOME
    process.env.COS_AGENT_SESSIONS_HOME = home
    try {
      const id = 'aaaaaaaa-1111-4111-8111-111111111111'
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(home, '.claude', 'projects', '-Users-x-proj'), { recursive: true })
      writeFileSync(join(home, '.claude', 'projects', '-Users-x-proj', id + '.jsonl'), [
        JSON.stringify({ type: 'assistant', timestamp: '2026-11-07T12:00:00Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { name: 'qa-ghost', description: 'Ghost hunter QA' } }] } }),
        JSON.stringify({ type: 'user', timestamp: '2026-11-07T12:00:01Z', toolUseResult: { status: 'teammate_spawned', name: 'qa-ghost' }, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      ].join('\n') + '\n')
      const out = (await readSessionContext(['claude|' + id, 'claude|bbbbbbbb-2222-4222-8222-222222222222', 'cursor|cccccccc-3333-4333-8333-333333333333'])).agents
      expect([...out.keys()]).toEqual(['claude|' + id])
      expect(out.get('claude|' + id)!.rows).toEqual([{ name: 'qa-ghost', task: 'Ghost hunter QA', status: 'running', at: Date.parse('2026-11-07T12:00:01Z') }])
    } finally {
      if (prev === undefined) delete process.env.COS_AGENT_SESSIONS_HOME; else process.env.COS_AGENT_SESSIONS_HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('7.0.1: the Today refresh button (force)', () => {
  it('force writes again at once with the same rows; a second inside 30 s answers refresh_throttled with retryAfterMs', async () => {
    await start(true)
    expect((await (await post('/today/brief', ASK)).json()).state).toBe('fresh')
    expect(prompts).toHaveLength(1)
    // Unforced, the same rows inside the interval write nothing.
    await post('/today/brief', ASK)
    expect(prompts).toHaveLength(1)
    const forced = await post('/today/brief', { ...ASK, force: true })
    expect(forced.status).toBe(200)
    expect(await forced.json()).toMatchObject({ state: 'fresh', model: 'sonnet' })
    expect(prompts).toHaveLength(2)
    const again = await post('/today/brief', { ...ASK, force: true })
    const body = await again.json()
    expect(body.reason).toBe('refresh_throttled')
    expect(body.retryAfterMs).toBeGreaterThan(0)
    expect(body.retryAfterMs).toBeLessThanOrEqual(30_000)
    expect(prompts).toHaveLength(2)
  })

  it('force must be a boolean; force: false is an ordinary ask', async () => {
    await start(true)
    expect((await post('/today/brief', { ...ASK, force: 'yes' })).status).toBe(400)
    expect((await post('/today/brief', { ...ASK, force: false })).status).toBe(200)
    expect(prompts).toHaveLength(1)
  })

  it('off: force reads nothing and calls nothing', async () => {
    await start(null)
    expect(await (await post('/today/brief', { ...ASK, force: true })).json()).toMatchObject({ state: 'off' })
    expect(boardReads).toBe(0)
    expect(prompts).toHaveLength(0)
  })
})

describe('7.0.5: Summaries per day and reconnect', () => {
  const put = (path: string, body: unknown) => fetch(base + path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  it('GET and PUT /api/today/brief/settings/cap: 100 by default, clamped to 1 to 100, anything else refused', async () => {
    await start(true)
    const read = await fetch(base + '/today/brief/settings/cap')
    expect(read.headers.get('cache-control')).toBe('private, no-store')
    expect(await read.json()).toEqual({ dailyCap: 100, min: 1, max: 100, default: 100, usedToday: 0 })
    expect(await (await put('/today/brief/settings/cap', { dailyCap: 250 })).json()).toMatchObject({ dailyCap: 100 })
    expect(await (await put('/today/brief/settings/cap', { dailyCap: 0 })).json()).toMatchObject({ dailyCap: 1 })
    expect(await (await put('/today/brief/settings/cap', { dailyCap: 25 })).json()).toMatchObject({ dailyCap: 25 })
    expect((await (await fetch(base + '/today/brief/settings')).json()).dailyCap).toBe(25)
    for (const bad of [{}, { dailyCap: '25' }, { dailyCap: null }, { dailyCap: 25, extra: 1 }, [25]]) {
      const r = await put('/today/brief/settings/cap', bad)
      expect(r.status, JSON.stringify(bad)).toBe(400)
      expect((await r.json()).error.code).toBe('invalid_today_brief_cap')
    }
    expect((await (await fetch(base + '/today/brief/settings/cap')).json()).dailyCap).toBe(25)
  })
  it('reason "reconnect" skips the spacing once; any other reason is refused', async () => {
    await start(true)
    await post('/today/brief', ASK)
    expect(prompts).toHaveLength(1)
    const changed = { ...ASK, sessions: [{ ...ASK.sessions[0], waiting: 'Wants to publish 7.0.5' }] }
    expect((await (await post('/today/brief', changed)).json()).reason).toBe('interval')
    expect((await (await post('/today/brief', { ...changed, reason: 'reconnect' })).json()).state).toBe('fresh')
    expect(prompts).toHaveLength(2)
    const third = { ...ASK, sessions: [{ ...ASK.sessions[0], waiting: 'Wants a third thing' }] }
    expect((await (await post('/today/brief', { ...third, reason: 'reconnect' })).json()).reason).toBe('interval')
    expect(prompts).toHaveLength(2)
    expect((await post('/today/brief', { ...ASK, reason: 'because' })).status).toBe(400)
    expect((await post('/today/brief', { ...ASK, reason: 1 })).status).toBe(400)
  })
})

describe('2026-11-09: recent activity and the dated board on the ask', () => {
  const NOW = Date.parse('2026-11-07T13:00:00Z')
  const K = (n: number) => `claude|aaaaaaaa-1111-4111-8111-11111111111${n}`
  const body = { sessions: [
    { title: 'Product work', provider: 'claude', state: 'open', minutes: 11, key: K(1), line: 'Yesterday we ran a bakeoff to improve transcription' },
    { title: 'Favicon question', provider: 'claude', state: 'open', minutes: 540, key: K(2), line: 'gotcos favicon' },
  ], needs: [], sessionsRead: true, needsComplete: true, unread: [], recording: false }

  it('what was read before the wait ended goes in; a session not read keeps its line, marked may be old', async () => {
    await start(true)
    recentAnswer = () => new Map([[K(1), { asks: [{ at: NOW - 16 * 60000, text: 'is everything live?', via: 'typed' }], reply: { at: NOW - 11 * 60000, text: 'The public release is live.' }, movedAt: NOW - 11 * 60000 }]])
    subagentAnswer = () => new Promise(() => {})   // the sub-agent read never answers: the ask goes on after its wait
    expect((await (await post('/today/brief', body)).json()).state).toBe('fresh')
    expect(subagentCalls).toEqual([[K(1), K(2)]])
    expect(prompts[0]).toContain('(16 min ago, typed by the person) "is everything live?"')
    expect(prompts[0]).toContain('latest reply (11 min ago) "The public release is live."')
    expect(prompts[0]).not.toContain('bakeoff')
    expect(prompts[0]).toContain('latest line (may be old): "gotcos favicon"')
  }, 8000)
  it('the board is read with dates: a card not moved in two days is a count, a card moved today shows', async () => {
    await start(true)
    board = [
      row({ title: 'Stale card', workStage: 'qa', lineChangedAt: '2026-10-31T12:00:00Z' } as any),
      row({ title: 'Fresh card', workStage: 'draft', lineChangedAt: '2026-11-07T10:00:00Z' } as any),
    ]
    expect((await (await post('/today/brief', ASK)).json()).state).toBe('fresh')
    expect(prompts[0]).toContain('- Fresh card (being built, moved 3 h ago)')
    expect(prompts[0]).not.toContain('Stale card')
    expect(prompts[0]).toContain('(1 more Work card is in progress, untouched for over two days; the newest of them moved 7 days ago.)')
  })
  it('workInProgress dates a card by its line change, else its creation day, and keeps the most recently moved', () => {
    const now = NOW
    const out = workInProgress([
      row({ title: 'Created only', workStage: 'qa', createdOn: '2026-11-05' } as any),
      row({ title: 'Changed', workStage: 'built', lineChangedAt: '2026-11-07T12:00:00Z', createdOn: '2026-10-01' } as any),
      row({ title: 'Undated', workStage: 'draft' }),
    ], now)
    expect(out.map(w => [w.title, w.movedMinutes])).toEqual([['Changed', 60], ['Created only', Math.round((now - Date.parse('2026-11-05')) / 60000)], ['Undated', null]])
  })
})
