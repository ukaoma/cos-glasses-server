/**
 * 7.0.52 (S1; Anand's Today on a public install, task:personal:ce1f04b2f016): with no Work handoffs file, Today said
 * "Couldn't read Work". A missing file (or a host that is not a Mac) is now a known not-set-up read, distinct from a
 * failed read: GET /api/work-board/activity/open says state 'not_set_up', and GET /api/work-board/your-move answers it as
 * nothing open (available:true), which Today, the rail and the action recheck already read as "nothing waiting". Every
 * other unavailable read stays a failure. Temp homes only; nothing here reads the Mac's own Work history.
 */
import { afterAll, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readWorkJournal, type WorkJournalRead } from '../lib/work-activity.js'
import { createWorkBoardRouter } from './work-board.js'
import { createWebControlRouter } from './web-control.js'

// The real path: macOS's tmpdir is under /var, a symlink, which the reader refuses as an ancestor.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'work-not-set-up-')))
const servers: Server[] = []
afterAll(() => { for (const s of servers) s.close(); rmSync(root, { recursive: true, force: true }) })

let n = 0
/** A home as a Mac host reads it: its own data dir, so the isolated-runtime guard (which reads env) does not apply. */
function home() {
  const h = join(root, 'home' + ++n)
  mkdirSync(h, { recursive: true })
  return { h, read: (platform: NodeJS.Platform = 'darwin') => readWorkJournal({ home: h, platform, env: { COS_DATA_DIR: join(h, '.cos-glasses', 'data') } as NodeJS.ProcessEnv }) }
}
const handoffs = (h: string) => join(h, 'Library', 'Application Support', 'COS Control', 'work-handoffs')

describe('readWorkJournal: nothing to read is not set up; anything else unavailable is a failure', () => {
  it('no COS Control folder at all: not set up', () => {
    const r = home().read()
    expect(r).toEqual({ available: false, reason: 'No native Work history is available on this host.', notSetUp: true })
  })
  it('the folder but no handoffs file: not set up', () => {
    const x = home(); mkdirSync(handoffs(x.h), { recursive: true })
    expect(x.read()).toEqual({ available: false, reason: 'No native Work history is available on this host.', notSetUp: true })
  })
  it('a host that is not a Mac: not set up', () => {
    expect(home().read('linux')).toEqual({ available: false, reason: 'Native Work history is available only on its Mac host.', notSetUp: true })
  })
  it('a file that is not JSON: a failed read, no flag', () => {
    const x = home(); mkdirSync(handoffs(x.h), { recursive: true }); writeFileSync(join(handoffs(x.h), 'handoffs.json'), '{not json')
    expect(x.read()).toEqual({ available: false, reason: 'Native Work history could not be read.' })
  })
  it('a file in another format: a failed read, no flag', () => {
    const x = home(); mkdirSync(handoffs(x.h), { recursive: true }); writeFileSync(join(handoffs(x.h), 'handoffs.json'), JSON.stringify({ version: 9 }))
    expect(x.read()).toEqual({ available: false, reason: 'Native Work history has an unsupported format.' })
  })
  it('a file it may not open: a failed read, no flag', () => {
    const x = home(); mkdirSync(handoffs(x.h), { recursive: true })
    const f = join(handoffs(x.h), 'handoffs.json'); writeFileSync(f, '{}'); chmodSync(f, 0o000)
    try {
      const r = x.read()
      expect(r.available).toBe(false)
      expect('notSetUp' in r).toBe(false)
    } finally { chmodSync(f, 0o600) }
  })
  it('a directory where the file should be: a failed read, no flag', () => {
    const x = home(); mkdirSync(join(handoffs(x.h), 'handoffs.json'), { recursive: true })
    expect(x.read()).toEqual({ available: false, reason: 'Native Work history is not safely readable.' })
  })
  it('a symlinked folder on the way: unsafe, a failed read, no flag', () => {
    const x = home(), real = join(root, 'elsewhere' + n)
    mkdirSync(real, { recursive: true }); mkdirSync(join(x.h, 'Library', 'Application Support', 'COS Control'), { recursive: true })
    symlinkSync(real, handoffs(x.h))
    expect(x.read()).toEqual({ available: false, reason: 'Native Work history is not safely readable.' })
  })
  it('a file over the size limit: a failed read, no flag', () => {
    const x = home(); mkdirSync(handoffs(x.h), { recursive: true })
    writeFileSync(join(handoffs(x.h), 'handoffs.json'), Buffer.alloc(10_000_000, 0x20))
    expect(x.read()).toEqual({ available: false, reason: 'Native Work history is not safely readable.' })
  })
  it('an isolated runtime (tests, previews): unavailable, never "not set up"', () => {
    const r = readWorkJournal({ home: home().h, platform: 'darwin', env: { VITEST: 'true' } as NodeJS.ProcessEnv })
    expect(r).toEqual({ available: false, reason: 'This isolated runtime does not read the native Work history.' })
  })
  it('a valid empty journal: available', () => {
    const x = home(); mkdirSync(handoffs(x.h), { recursive: true })
    writeFileSync(join(handoffs(x.h), 'handoffs.json'), JSON.stringify({ version: 2, receipts: [], sessions: [] }))
    expect(x.read()).toEqual({ available: true, receipts: [], drafts: [] })
  })
})

async function listen(app: express.Express) {
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  servers.push(server)
  return { server, port: (server.address() as { port: number }).port }
}

describe('GET /api/work-board/activity/open', () => {
  async function open(read: WorkJournalRead) {
    const app = express(); app.use('/api', createWorkBoardRouter({ journal: () => read }))
    const { port } = await listen(app)
    return (await fetch(`http://127.0.0.1:${port}/api/work-board/activity/open`)).json()
  }
  it('says not_set_up when there is nothing to read', async () => {
    const body = await open({ available: false, reason: 'No native Work history is available on this host.', notSetUp: true })
    expect(body).toMatchObject({ version: 1, available: false, state: 'not_set_up', reason: 'No native Work history is available on this host.', items: [], total: 0, truncated: false })
  })
  it('a journal that reads but a board that does not: a failure, no state', async () => {
    const warn = console.warn; console.warn = () => {}
    try {
      const app = express(); app.use('/api', createWorkBoardRouter({ journal: () => ({ available: true, receipts: [], drafts: [] }), list: async () => { throw new Error('bridge down') } }))
      const { port } = await listen(app)
      const body = await (await fetch(`http://127.0.0.1:${port}/api/work-board/activity/open`)).json()
      expect(body).toMatchObject({ available: false, items: [], total: 0 })
      expect('state' in body).toBe(false)
    } finally { console.warn = warn }
  })
  it('a failed read carries no state', async () => {
    const body = await open({ available: false, reason: 'Native Work history could not be read.' })
    expect(body.available).toBe(false)
    expect('state' in body).toBe(false)
  })
})

describe('GET /api/work-board/your-move (what Today reads)', () => {
  let answer: { status: number; body: unknown } = { status: 200, body: {} }
  let base = ''
  it('setup', async () => {
    const app = express()
    // A stand-in for the open-work route the compatibility route reads over loopback.
    app.get('/api/work-board/activity/open', (_req, res) => { res.status(answer.status).json(answer.body) })
    let port = 0
    app.use('/api', createWebControlRouter({ apiToken: () => 'test-token', port: () => port }))
    port = (await listen(app)).port
    base = `http://127.0.0.1:${port}/api/work-board/your-move`
  })
  const read = async () => (await fetch(base)).json()

  it('Work not set up: an answer with nothing open, never a failed read', async () => {
    answer = { status: 200, body: { version: 1, available: false, state: 'not_set_up', reason: 'No native Work history is available on this host.', items: [], total: 0 } }
    expect(await read()).toEqual({ available: true, state: 'not_set_up', total: 0, items: [] })
  })
  it('a failed Work read stays a failure', async () => {
    answer = { status: 200, body: { version: 1, available: false, reason: 'Native Work history could not be read.', items: [], total: 0 } }
    expect(await read()).toEqual({ available: false, total: 0, items: [] })
  })
  it('a non-200 answer is a failure, whatever its body says', async () => {
    answer = { status: 503, body: { state: 'not_set_up' } }
    expect(await read()).toEqual({ available: false, total: 0, items: [] })
  })
  it('open work passes through as before', async () => {
    answer = { status: 200, body: { version: 1, available: true, items: [{ id: 'one' }], total: 1 } }
    expect(await read()).toEqual({ available: true, total: 1, items: [{ id: 'one' }] })
  })
})
