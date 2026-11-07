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

async function start(enabled: boolean | null) {
  dir = mkdtempSync(join(tmpdir(), 'today-brief-route-'))
  if (enabled !== null) writeFileSync(join(dir, 's.json'), JSON.stringify({ schema: 1, enabled }))
  prompts.length = 0; boardReads = 0
  const brief = createTodayBrief({
    stateFile: join(dir, 'b.json'), settingsFile: join(dir, 's.json'), env: () => ({}),
    generate: async p => { prompts.push(p); return 'The release is moving, and one session waits on you to approve a publish.' },
  })
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use('/api', createTodayBriefRouter({ brief, board: async () => { boardReads++; return board } }))
  server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
}
afterEach(async () => {
  if (server) await new Promise(r => server!.close(r))
  server = null
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => { board = [] })

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
    expect(v).toMatchObject({ state: 'fresh', model: 'haiku', basis: '1 session and 1 Work card' })
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

describe('the settings route', () => {
  it('reads and writes the toggle; anything but { enabled: boolean } is refused', async () => {
    await start(null)
    expect(await (await fetch(base + '/today/brief/settings')).json()).toEqual({ enabled: false, source: 'default', saved: null })
    expect(await (await post('/today/brief/settings', { enabled: true })).json()).toEqual({ enabled: true, source: 'settings', saved: true })
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
    expect(out[0]).toEqual({ title: 'Planned with an agent', stage: 'planned', running: true })
    expect(out.map(w => w.title)).toContain('In QA')
    expect(out.map(w => w.title)).toContain('Legacy active')
    expect(out.map(w => w.title)).not.toContain('Planned only')
    expect(out.map(w => w.title)).not.toContain('Delegated')
    expect(workInProgress(null)).toEqual([])
  })
})
