import express from 'express'
import { createHash } from 'node:crypto'
import type { prepareControl2Draft } from '../lib/control2-draft.js'
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { createFoundationRouter } from './control2-foundation.js'
const servers: Server[] = []; const roots: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true }))
})
async function start(enabled: boolean, prepareDraft?: typeof prepareControl2Draft) {
  const root = mkdtempSync(join(tmpdir(), 'control2-http-')); roots.push(root)
  const app = express(); app.use(express.json()); app.use('/api', createFoundationRouter({ enabled, root, draftEnabled: !!prepareDraft, prepareDraft }))
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) }); servers.push(server)
  const address = server.address() as { port: number }
  return { root, base: `http://127.0.0.1:${address.port}/api/control2/foundation` }
}
it('does not create a journal or expose actions when disabled', async () => {
  const { root, base } = await start(false)
  expect((await fetch(base)).status).toBe(404); expect(readdirSync(root)).toEqual([])
})
it('exercises replay, conflicts and publication denial through HTTP', async () => {
  const { base } = await start(true)
  const body = { meetingId: 'source', revision: '1', projectId: 'website', ready: true, transcript: 'Prepare a preview' }
  const post = (b: unknown) => fetch(base + '/replay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
  const first = await (await post(body)).json(); expect(first.work).toHaveLength(1)
  expect((await (await post(body)).json()).replayed).toBe(true)
  expect((await post({ ...body, transcript: 'different' })).status).toBe(409)
  expect((await fetch(base + '/publish', { method: 'POST' })).status).toBe(403)
  expect((await (await fetch(base)).json()).capabilities.publication).toBe(false)
})

it('draft is opt-in and rejects missing source', async () => {
  const { base } = await start(true)
  expect((await fetch(base + '/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403)
})

it('persists one checked draft and refuses a completion after source correction', async () => {
  let release!: () => void
  let entered!: () => void
  let started = new Promise<void>(r => { entered = r })
  let gate = Promise.resolve()
  let calls = 0; let disposed = 0
  const artifactRoot = mkdtempSync(join(tmpdir(), 'control2-draft-route-')); roots.push(artifactRoot)
  const html = '<!doctype html><title>Checked text</title><p>Preview</p>'
  const path = join(artifactRoot, 'preview.html'); writeFileSync(path, html)
  const sha256 = createHash('sha256').update(html).digest('hex')
  const prepareDraft: typeof prepareControl2Draft = async () => {
    calls++; entered(); await gate
    return { id: 'draft', provider: 'claude', model: 'default', title: 'Preview', previewPath: path, sha256,
      checked: true, scope: 'no-tool-text-draft', snapshot: { id: 'test', root: artifactRoot, files: [], dispose() {} }, dispose() { disposed++ } }
  }
  const { base } = await start(true, prepareDraft)
  const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const source = { meetingId: 'source', projectId: 'website', revision: '1', transcript: 'Prepare copy', ready: true }
  const first = await (await post('/replay', source)).json()
  expect((await (await post('/draft', { workId: first.workId })).json()).work[0].artifact.sha256).toBe(sha256)
  expect((await post('/draft', { workId: first.workId })).status).toBe(200)
  expect(calls).toBe(1); expect(disposed).toBe(1)
  const saved = await (await fetch(base)).json()
  expect(readFileSync(saved.work[0].artifact.path, 'utf8')).toBe(html)
  expect(saved.capabilities.publication).toBe(false)
  const second = await (await post('/replay', { ...source, revision: '2' })).json()
  started = new Promise<void>(r => { entered = r }); gate = new Promise<void>(r => { release = r })
  const pending = post('/draft', { workId: second.workId })
  await started
  await post('/replay', { ...source, revision: '3' })
  release()
  expect((await pending).status).toBe(409)
  const final = await (await fetch(base)).json()
  expect(final.work.find((w: { revision: string }) => w.revision === '2').artifact).toBeUndefined()
  expect(disposed).toBe(2)
})
