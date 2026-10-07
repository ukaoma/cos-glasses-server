/**
 * 6.65.0: GET /api/tasks rows carry createdOn, createdFrom and lineChangedAt, through the real route and the packaged
 * task runtime, against a fixture git repo whose path has spaces and dots like a real install.
 */
import express from 'express'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
vi.mock('../lib/python-bridge.js', async importOriginal => ({ ...(await importOriginal<typeof import('../lib/python-bridge.js')>()), pythonBridgeAvailable: vi.fn(() => false) }))
import { tasksRouter } from './tasks.js'
import { createWorkBoardRouter } from './work-board.js'
import { listBoard, listBoardWithDates } from '../lib/task-store.js'

let base = '', repo = '', ops = ''
const servers: Server[] = []
function git(args: string[], at: string) {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, HOME: base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } })
}
function useOperations(dir: string) {
  vi.stubEnv('COS_PORTABLE_TASKS', '1'); vi.stubEnv('COS_SCRIPTS_DIR', ''); vi.stubEnv('COS_OPERATIONS_DIR', dir)
  vi.stubEnv('COS_TASK_LOCK_STORE', join(base, 'locks.json')); vi.stubEnv('COS_PROFILE_PATH', join(base, 'profile.json'))
  writeFileSync(join(base, 'profile.json'), JSON.stringify({ domains: ['business'], owner_name: 'Alex' }))
}
const TASKS = ['## INBOX', '- [ ] Draft the launch email — **Source:** Kickoff [2026-02-20]', '- [ ] Order the trade show banners', '- [x] Book the venue walkthrough', ''].join('\n')

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cos tasks.')))
  repo = join(base, 'Chief Of.Staff'); ops = join(repo, 'operations')
  mkdirSync(join(ops, 'business'), { recursive: true })
  writeFileSync(join(ops, 'business', 'tasks.md'), TASKS)
  git(['init', '-q'], '2026-03-01T10:00:00Z'); git(['add', '-A'], '2026-03-01T10:00:00Z'); git(['commit', '-q', '-m', 'tasks'], '2026-03-01T10:00:00Z')
  appendFileSync(join(ops, 'business', 'tasks.md'), '- [ ] Brand new idea from today\n')
  useOperations(ops)
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true })
})

async function getTasks(path = '/tasks'): Promise<Array<Record<string, unknown>>> {
  const app = express(); app.use(express.json()); app.use('/api', tasksRouter); app.use('/api', createWorkBoardRouter())
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) }); servers.push(server)
  const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${path}`)
  expect(res.status).toBe(200)
  return (await res.json()).tasks
}
const by = (rows: Array<Record<string, unknown>>, text: string) => rows.find(r => r.text === text)!
const withoutDates = ({ createdOn: _a, createdFrom: _b, lineChangedAt: _c, ...rest }: Record<string, unknown>) => rest

it('GET /api/tasks adds the three date fields and leaves every existing field as it was', async () => {
  const before = readFileSync(join(ops, 'business', 'tasks.md'), 'utf8')
  const rows = await getTasks()
  expect(by(rows, 'Draft the launch email')).toMatchObject({ createdOn: '2026-02-20', createdFrom: 'source', lineChangedAt: '2026-03-01T10:00:00.000Z' })
  expect(by(rows, 'Order the trade show banners')).toMatchObject({ createdOn: '2026-03-01', createdFrom: 'git', lineChangedAt: '2026-03-01T10:00:00.000Z' })
  expect(by(rows, 'Book the venue walkthrough')).toMatchObject({ createdOn: '2026-03-01', createdFrom: 'git', checked: true })
  // Present and null (never absent) when unknown, so a client can tell a 6.65 server from an older one.
  expect(by(rows, 'Brand new idea from today')).toMatchObject({ createdOn: null, createdFrom: null, lineChangedAt: null })
  expect(rows.map(withoutDates)).toEqual(JSON.parse(JSON.stringify(await listBoard())))
  expect(readFileSync(join(ops, 'business', 'tasks.md'), 'utf8')).toBe(before)  // never written
})

it('GET /api/work-board (what COS Control reads for its Work board) serves the same dates', async () => {
  const rows = await getTasks('/work-board')
  expect(by(rows, 'Draft the launch email')).toMatchObject({ createdOn: '2026-02-20', createdFrom: 'source', lineChangedAt: '2026-03-01T10:00:00.000Z' })
  expect(by(rows, 'Order the trade show banners')).toMatchObject({ createdOn: '2026-03-01', createdFrom: 'git' })
  expect(by(rows, 'Brand new idea from today')).toMatchObject({ createdOn: null, createdFrom: null, lineChangedAt: null, taskRevision: expect.stringMatching(/^[a-f0-9]{64}$/) })
})

it('outside any git repository the git-derived fields are null; a source date still counts', async () => {
  const plain = join(base, 'public.install data', 'operations')
  mkdirSync(join(plain, 'business'), { recursive: true })
  writeFileSync(join(plain, 'business', 'tasks.md'), TASKS)
  useOperations(plain)
  const rows = await getTasks()
  expect(rows).toHaveLength(3)
  expect(by(rows, 'Draft the launch email')).toMatchObject({ createdOn: '2026-02-20', createdFrom: 'source', lineChangedAt: null })
  expect(by(rows, 'Order the trade show banners')).toMatchObject({ createdOn: null, createdFrom: null, lineChangedAt: null })
})

it('a dating failure never fails the board', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const rows = await listBoardWithDates(undefined, Date.now(), { resolve: async () => { throw new Error('git exploded') } })
  expect(rows).toHaveLength(4)
  expect(rows.every(r => r.createdOn === null && r.createdFrom === null && r.lineChangedAt === null)).toBe(true)
  expect(warn).toHaveBeenCalledWith('[tasks] dates unavailable:', 'git exploded')
  warn.mockRestore()
})
