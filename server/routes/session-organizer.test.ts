// Sessions chat-style layout, step 2a: the organizer routes and what the list, /older and search carry from them
// (S1_CONTRACT_step2a.md A1, A2, B1 to B3), through real HTTP against a scratch home and a scratch organizer file.
import express from 'express'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionsRouter } from './agent-sessions.js'
import { createSessionOrganizerRouter } from './session-organizer.js'
import { SessionOrganizer, __resetSessionOrganizerForTests } from '../lib/session-organizer.js'
import { __drainListModelWarmForTests, __resetListModelMemoForTests, listModelStats } from '../lib/list-model-memo.js'
import { resetDesktopAliasMemo } from '../lib/agent-session-store.js'
import { __resetOlderTitleMemoForTests } from '../lib/agent-session-older.js'
import { __resetCosStartedForTests } from '../lib/cos-started-sessions.js'
import { dataPath } from '../lib/data-dir.js'

const temps: string[] = []
afterAll(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true }) })
const temp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d }

const CLI = '1a2b3c4d-1111-4222-8333-444455556666'
const DESKTOP = '9f8e7d6c-1111-4222-8333-444455556666'
const OLD = '0ld0ld00-1111-4222-8333-444455556666'.replace(/l/g, '1').replace(/o/gi, '0')
const DAY = 24 * 3600 * 1000

let home = ''
let base = ''
let server: import('node:http').Server | null = null
let previousHome: string | undefined
let logs: string[] = []

function transcript(id: string, title: string, ageMs: number, model?: string): string {
  const dir = join(home, '.claude', 'projects', 'MU-Chief-Staff')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  const lines = [
    { type: 'custom-title', customTitle: title },
    { type: 'user', message: { role: 'user', content: 'first ask' } },
    ...(model ? [{ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: 'done' }] } }] : []),
  ]
  writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  const at = (Date.now() - ageMs) / 1000
  utimesSync(file, at, at)
  return file
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: res.status, json: await res.json() }
}

beforeEach(async () => {
  home = temp('cos-organizer-home-')
  previousHome = process.env.COS_AGENT_SESSIONS_HOME
  process.env.COS_AGENT_SESSIONS_HOME = home
  resetDesktopAliasMemo()
  __resetOlderTitleMemoForTests()
  __resetListModelMemoForTests()
  __resetCosStartedForTests()
  rmSync(dataPath('query-jobs'), { recursive: true, force: true }) // vitest.config.ts points COS_DATA_DIR at a scratch dir
  logs = []
  __resetSessionOrganizerForTests(new SessionOrganizer(join(temp('cos-organizer-data-'), 'session-organizer.json'), line => logs.push(line)))
  // A Claude Desktop session whose CLI transcript is CLI: the two ids are one session.
  const desktopDir = join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'ws')
  mkdirSync(desktopDir, { recursive: true })
  writeFileSync(join(desktopDir, `local_${DESKTOP}.json`), JSON.stringify({ sessionId: `local_${DESKTOP}`, cliSessionId: CLI, cwd: '/x/MU-Chief-Staff', title: 'Desktop title' }))
  transcript(CLI, 'Phone first run', 3600_000, 'claude-opus-5-5')
  transcript(OLD, 'October notes', 40 * DAY)
  const app = express()
  app.use(express.json())
  app.use('/api', agentSessionsRouter)
  app.use('/api', createSessionOrganizerRouter())
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`
})
afterEach(async () => {
  await __drainListModelWarmForTests()
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
  __resetSessionOrganizerForTests()
  if (previousHome === undefined) delete process.env.COS_AGENT_SESSIONS_HOME
  else process.env.COS_AGENT_SESSIONS_HOME = previousHome
})

describe('organizer routes', () => {
  it('folders: create, list with counts, rename, delete; names refused and taken', async () => {
    const created = await call('POST', '/session-folders', { name: 'Release' })
    expect(created.status).toBe(201)
    expect(created.json.folder).toMatchObject({ name: 'Release', count: 0 })
    expect((await call('POST', '/session-folders', { name: 'release' })).json.reason).toBe('folder_name_taken')
    expect((await call('POST', '/session-folders', { name: '  ' })).json.reason).toBe('invalid_name')
    const id = created.json.folder.id
    expect((await call('PATCH', `/session-folders/${id}`, { name: 'Ship' })).json.folder.name).toBe('Ship')
    expect((await call('GET', '/session-folders')).json.folders.map((f: any) => f.name)).toEqual(['Ship'])
    expect((await call('DELETE', `/session-folders/${id}`)).json.released).toBe(0)
    expect((await call('DELETE', `/session-folders/${id}`)).status).toBe(404)
  })

  it('a Claude Desktop id and its CLI id are one key; a session the server cannot find is refused', async () => {
    const folder = (await call('POST', '/session-folders', { name: 'Release' })).json.folder
    const viaDesktop = await call('PATCH', `/agent-sessions/claude/local_${DESKTOP}/organizer`, { folder_id: folder.id })
    expect(viaDesktop.status).toBe(200)
    expect(viaDesktop.json.session).toEqual({ provider: 'claude', session_id: CLI, folder_id: folder.id })
    const viaCli = await call('PATCH', `/agent-sessions/claude/${CLI}/organizer`, { cos_pinned: true })
    expect(viaCli.json.session).toEqual({ provider: 'claude', session_id: CLI, folder_id: folder.id, cos_pinned: true })
    expect((await call('PATCH', '/agent-sessions/claude/deadbeef-0000-4000-8000-000000000000/organizer', { cos_pinned: true })).json.reason).toBe('session_not_found')
    expect((await call('PATCH', '/agent-sessions/nope/abc/organizer', { cos_pinned: true })).json.reason).toBe('invalid_provider')
    expect((await call('PATCH', `/agent-sessions/claude/${CLI}/organizer`, {})).json.reason).toBe('empty_change')
    expect((await call('PATCH', `/agent-sessions/claude/${CLI}/organizer`, { folder_id: 'f_0000000000000000' })).json.reason).toBe('folder_not_found')
  })
})

describe('what the list, /older and search carry', () => {
  it('a COS-pinned 40-day-old session is in the main list with its fields; pinned stays the agent’s own', async () => {
    expect((await call('PATCH', `/agent-sessions/claude/${OLD}/organizer`, { cos_pinned: true, title: 'Renamed October' })).status).toBe(200)
    const list = await call('GET', '/agent-sessions')
    const row = list.json.sessions.find((r: any) => r.session_id === OLD)
    expect(row).toMatchObject({ cos_pinned: true, title_override: 'Renamed October', display_label: 'October notes', pinned: false })
    expect(list.json.organizer.rev).toBeGreaterThan(0)
  })

  it('with an empty store the list carries none of the new keys (an older client sees today’s payload)', async () => {
    const list = await call('GET', '/agent-sessions')
    expect(list.json).not.toHaveProperty('organizer')
    for (const row of list.json.sessions) {
      for (const key of ['folder_id', 'cos_pinned', 'title_override']) expect(row).not.toHaveProperty(key)
    }
    expect(list.json.sessions.map((r: any) => r.session_id)).not.toContain(OLD)
  })

  it('the list never waits on a model read: the first answer has none, the background warm fills it for the next', async () => {
    const first = await call('GET', '/agent-sessions')
    expect(first.json.sessions.find((r: any) => r.session_id === CLI)).not.toHaveProperty('reported_model')
    await __drainListModelWarmForTests()
    expect(listModelStats.reads).toBeGreaterThan(0)
    const second = await call('GET', '/agent-sessions')
    expect(second.json.sessions.find((r: any) => r.session_id === CLI).reported_model).toBe('claude-opus-5-5')
  })

  it('/older: short rows, the count past the window, refused bad `before`; a kept row comes back at any age with its fields', async () => {
    transcript('11111111-2222-4333-8444-555555555555', 'Twelve days old', 12 * DAY)
    let older = await call('GET', '/agent-sessions/older?days=30')
    // The 1-hour-old session is here too: /older may repeat a main-list row, and the client keeps the main one.
    expect(older.json.sessions.map((r: any) => r.display_label)).toEqual(['Phone first run', 'Twelve days old'])
    expect(older.json).toMatchObject({ windowDays: 30, next_before: null, older_than_window: 1 })
    expect((await call('GET', '/agent-sessions/older?before=yesterday')).json.reason).toBe('invalid_before')
    // A kept row cut by the main list's ceiling must be reachable here (Q1 FIX 1): kept rows are listed at any age.
    await call('PATCH', `/agent-sessions/claude/${OLD}/organizer`, { cos_pinned: true })
    older = await call('GET', '/agent-sessions/older?days=30')
    expect(older.json.sessions.map((r: any) => r.display_label)).toEqual(['Phone first run', 'Twelve days old', 'October notes'])
    expect(older.json.sessions.find((r: any) => r.session_id === OLD)).toMatchObject({ cos_pinned: true, form: 'short' })
    expect(older.json.older_than_window).toBe(0)
  })

  it('search finds a session by its COS title, and hits carry the organizer fields', async () => {
    await call('PATCH', `/agent-sessions/claude/${OLD}/organizer`, { title: 'Falcon board deck' })
    const search = await call('GET', '/agent-sessions/search?q=falcon')
    const hit = search.json.hits.find((h: any) => h.session_id === OLD)
    expect(hit).toMatchObject({ title_override: 'Falcon board deck', display_label: 'October notes' })
  })

  it('no folder name or title reaches a log line', async () => {
    const f = (await call('POST', '/session-folders', { name: 'Project Falcon' })).json.folder
    await call('PATCH', `/agent-sessions/claude/${CLI}/organizer`, { folder_id: f.id, title: 'Secret board deck' })
    await call('GET', '/agent-sessions')
    expect(logs.join('\n')).not.toMatch(/Falcon|Secret board deck/)
  })
})

describe('Claude alias changes through the routes (Q1 FIX 2)', () => {
  it('a write while Desktop records disagree about the CLI id is refused (409 alias_conflict)', async () => {
    const desktopDir = join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'ws2')
    mkdirSync(desktopDir, { recursive: true })
    writeFileSync(join(desktopDir, `local_${DESKTOP}.json`), JSON.stringify({ sessionId: `local_${DESKTOP}`, cliSessionId: OLD, title: 'Other' }))
    resetDesktopAliasMemo()
    const res = await call('PATCH', `/agent-sessions/claude/local_${DESKTOP}/organizer`, { cos_pinned: true })
    expect(res.status).toBe(409)
    expect(res.json.reason).toBe('alias_conflict')
  })

  it('an entry written by Desktop id follows the session when its CLI id changes', async () => {
    await call('PATCH', `/agent-sessions/claude/local_${DESKTOP}/organizer`, { cos_pinned: true })
    // The Desktop record now names a different CLI transcript.
    const NEW = '2b3c4d5e-1111-4222-8333-444455556666'
    transcript(NEW, 'Continued elsewhere', 600_000)
    const desktopDir = join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'ws')
    writeFileSync(join(desktopDir, `local_${DESKTOP}.json`), JSON.stringify({ sessionId: `local_${DESKTOP}`, cliSessionId: NEW, cwd: '/x/MU-Chief-Staff', title: 'Desktop title' }))
    resetDesktopAliasMemo()
    const list = await call('GET', '/agent-sessions')
    expect(list.json.sessions.find((r: any) => r.session_id === NEW)).toMatchObject({ cos_pinned: true })
  })
})

describe('sessions a COS job started (Miles, 2026-11-10: kept 7 days)', () => {
  it('the list keeps one past the per-agent cap, and /older lists it too (the client keeps the main row)', async () => {
    for (let i = 0; i < 22; i++) transcript(`${String(i).padStart(8, '0')}-cccc-4ddd-8eee-ffffffffffff`, `Busy ${i}`, (i + 1) * 60_000)
    const STARTED = '5ea7ed00-1111-4222-8333-444455556666'
    transcript(STARTED, 'Started from Work', 2 * DAY)
    mkdirSync(dataPath('query-jobs'), { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    writeFileSync(dataPath('query-jobs', `${day}.jsonl`), [
      { persistedAt: new Date().toISOString(), jobId: 'j-ask', type: 'accepted', request: { query: 'q', sessionId: 's' }, patch: {} },
      { persistedAt: new Date().toISOString(), jobId: 'j-ask', type: 'running', patch: { provider: 'claude', cliSessionId: STARTED } },
    ].map(r => JSON.stringify(r)).join('\n') + '\n')
    const list = await call('GET', '/agent-sessions')
    expect(list.json.sessions.map((r: any) => r.session_id)).toContain(STARTED)
    const older = await call('GET', '/agent-sessions/older?days=30&limit=200')
    expect(older.json.sessions.map((r: any) => r.session_id)).toContain(STARTED)
  })
})
