import express from 'express'
import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPrepRouter, attachmentDisposition } from './prep.js'
import { PrepRuntime } from '../lib/prep-runtime.js'
import { PrepStore } from '../lib/prep-store.js'
import { MeetingAskStore } from '../lib/meeting-ask-store.js'
import { requireApiToken } from '../lib/api-auth.js'

const MEDIA = 'm_' + '1'.repeat(24)
const BYTES = Buffer.from('Quarterly "plan"\n')
const SHA = createHash('sha256').update(BYTES).digest('hex')
const uuid = () => globalThis.crypto.randomUUID()

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'prep-http-'))
  const state = { open: true }
  const jobs = new Map<string, any>()
  const submit = vi.fn(async (raw: any) => { const job = { jobId: 'job-1', clientJobId: raw.clientJobId, sessionId: 'conv-1', status: 'accepted' }; jobs.set(raw.clientJobId, job); return { created: true, job } as any })
  const runtime = new PrepRuntime({
    store: new PrepStore(join(dir, 'prep')), meetingFiles: new MeetingAskStore(join(dir, 'ask')),
    identity: () => 'srv-1', admissions: () => state.open, now: () => Date.now(),
    lease: () => ({ id: 'l', setPhase() {}, release() {} }),
    readFile: () => BYTES, knownSession: () => true,
    readImage: async () => ({ text: '', lowConfidence: false }),
    media: () => ({
      resolveUsable: () => ({ record: { ref: { id: MEDIA, kind: 'user_document', category: 'document', mime: 'text/plain', label: 'Q4 "plan"/notes.txt', width: 0, height: 0, createdAt: '' }, bytes: 17, sha256: 'x', createdAtMs: 1 } as any, path: '/m' }),
      resolveModelDerivatives: () => ({ record: {} as any, originalPath: '/m', imagePaths: [] }),
    }),
    jobs: { prepare: async raw => raw, submit, byClient: async id => jobs.get(id) },
  })
  const app = express()
  app.use('/api', requireApiToken('test-token'))
  app.use(express.json({ limit: '1mb' }))
  app.use('/api', createPrepRouter(runtime))
  let server!: Server
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const port = (server.address() as any).port
  const request = (path: string, method = 'GET', body?: unknown, auth = true, expected: string | null = 'srv-1') => fetch(`http://127.0.0.1:${port}/api/prep${path}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { 'x-cos-token': 'test-token' } : {}), ...(expected !== null && method !== 'GET' ? { 'x-cos-expected-server-instance': expected } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { request, state, submit, close: async () => { await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }) } }
}

let closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of closers) await c(); closers = [] })
async function make() { const f = await fixture(); closers.push(f.close); return f }

describe('Prep HTTP contract', () => {
  it('requires the API token and answers no-store', async () => {
    const f = await make()
    expect((await f.request('/drafts', 'GET', undefined, false)).status).toBe(401)
    expect((await f.request('/drafts', 'POST', { clientDraftId: uuid() }, false)).status).toBe(401)
    const list = await f.request('/drafts')
    expect(list.status).toBe(200)
    expect(list.headers.get('cache-control')).toBe('no-store')
    expect(await list.json()).toEqual({ drafts: [], serverInstanceId: 'srv-1' })
  })

  it('create is 201 then 200 with the same draft; PATCH conflict is 409 {error, draft}', async () => {
    const f = await make()
    const cid = uuid()
    const a = await f.request('/drafts', 'POST', { clientDraftId: cid, title: 'Pete 1:1' })
    expect(a.status).toBe(201)
    const { draft } = await a.json() as any
    const b = await f.request('/drafts', 'POST', { clientDraftId: cid })
    expect(b.status).toBe(200)
    expect((await b.json() as any).draft.id).toBe(draft.id)
    expect((await (await f.request(`/drafts/${draft.id}`)).json() as any).draft.title).toBe('Pete 1:1')
    expect((await f.request(`/drafts/${draft.id}`, 'PATCH', { revision: 1, steer: 'Ask about Q4' })).status).toBe(200)
    const stale = await f.request(`/drafts/${draft.id}`, 'PATCH', { revision: 1, steer: 'old' })
    expect(stale.status).toBe(409)
    const body = await stale.json() as any
    expect(body.error).toBe('revision_conflict')
    expect(body.draft).toMatchObject({ id: draft.id, revision: 2, steer: 'Ask about Q4' })
    expect((await f.request('/drafts/prep_nope')).status).toBe(404)
  })

  it('serves the original bytes as an attachment with the stored mime, and the text', async () => {
    const f = await make()
    const { draft } = await (await f.request('/drafts', 'POST', { clientDraftId: uuid() })).json() as any
    const added = await f.request(`/drafts/${draft.id}/files`, 'POST', { operationId: uuid(), revision: 1, media: [{ id: MEDIA, sha256: SHA }] })
    expect(added.status).toBe(200)
    const file = (await added.json() as any).draft.files[0]
    const raw = await f.request(`/drafts/${draft.id}/files/${file.id}`)
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(raw.headers.get('content-disposition')).toBe(`attachment; filename="Q4 _plan__notes.txt"; filename*=UTF-8''${encodeURIComponent('Q4 "plan"/notes.txt')}`)
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff')
    expect(raw.headers.get('x-cos-server-instance')).toBe('srv-1')
    expect(await raw.text()).toBe('Quarterly "plan"\n')
    expect(await (await f.request(`/drafts/${draft.id}/files/${file.id}/text`)).json()).toEqual({ text: 'Quarterly "plan"\n', serverInstanceId: 'srv-1' })
    const del = await f.request(`/drafts/${draft.id}/files/${file.id}?revision=2`, 'DELETE')
    expect(del.status).toBe(200)
    expect((await del.json() as any).draft.files[0].status).toBe('removed')
    const tooMany = await f.request(`/drafts/${draft.id}/files`, 'POST', { revision: 3, media: Array.from({ length: 11 }, (_, i) => ({ id: 'm_' + String(i).padStart(24, 'a'), sha256: SHA })) })
    expect(tooMany.status).toBe(413)
    expect(await tooMany.json()).toEqual({ error: 'prep_file_limit', serverInstanceId: 'srv-1' })
  })

  it('run answers 202 {job, run, draft}; bind answers {draft, files}; reads by session and suggest', async () => {
    const f = await make()
    const { draft } = await (await f.request('/drafts', 'POST', { clientDraftId: uuid(), steer: 'x' })).json() as any
    await f.request(`/drafts/${draft.id}`, 'PATCH', { revision: 1, steer: 'Bring the renewal list' })
    const run = await f.request(`/drafts/${draft.id}/run`, 'POST', { clientRequestId: uuid(), revision: 2 })
    expect(run.status).toBe(202)
    const ran = await run.json() as any
    expect(Object.keys(ran).sort()).toEqual(['draft', 'job', 'run', 'serverInstanceId'])
    const looked = await (await f.request(`/drafts/${draft.id}/runs/${ran.run.clientRequestId}`)).json() as any
    expect([looked.run.jobId, looked.job.jobId]).toEqual(['job-1', 'job-1'])
    expect((await f.request(`/drafts/${draft.id}/runs/${uuid()}`)).status).toBe(404)
    expect(ran.job.jobId).toBe('job-1')
    const bind = await f.request(`/drafts/${draft.id}/bind`, 'POST', { revision: ran.draft.revision, sessionId: 'meeting_http_1', surface: 'web' })
    expect(bind.status).toBe(200)
    const bound = await bind.json() as any
    expect(bound.files).toEqual([expect.objectContaining({ id: `prep_${draft.id}_steer`, name: 'Prep notes', origin: 'prep', status: 'ready' })])
    expect((await (await f.request('/by-session/meeting_http_1')).json() as any).snapshots.map((d: any) => [d.draftId, d.steer])).toEqual([[draft.id, 'Bring the renewal list']])
    expect((await f.request('/by-session/..%2Fx')).status).toBe(400)
    const sugg = await f.request(`/suggest?sessionId=meeting_http_2&startedAt=${Date.now()}`)
    expect((await sugg.json() as any).drafts.map((d: any) => d.id)).toEqual([draft.id])
    const unbind = await f.request(`/drafts/${draft.id}/bind/meeting_http_1`, 'DELETE')
    expect((await unbind.json() as any).draft.bindings[0].removedAt).toEqual(expect.any(String))
  })

  it('writes answer 503 {error:"maintenance"} while admissions are closed; reads still work', async () => {
    const f = await make()
    f.state.open = false
    const res = await f.request('/drafts', 'POST', { clientDraftId: uuid() })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'maintenance', serverInstanceId: 'srv-1' })
    expect((await f.request('/drafts')).status).toBe(200)
  })

  it('DELETE a draft archives it (header required) and by-session still lists its snapshots', async () => {
    const f = await make()
    const { draft } = await (await f.request('/drafts', 'POST', { clientDraftId: uuid() })).json() as any
    await f.request(`/drafts/${draft.id}`, 'PATCH', { revision: 1, steer: 'Bring the list' })
    await f.request(`/drafts/${draft.id}/bind`, 'POST', { revision: 2, sessionId: 'meeting_http_9', surface: 'web' })
    const del = await f.request(`/drafts/${draft.id}`, 'DELETE')
    expect(del.status).toBe(200)
    expect((await del.json() as any).draft.state).toBe('archived')
    expect((await (await f.request('/by-session/meeting_http_9')).json() as any).snapshots.map((r: any) => r.steer)).toEqual(['Bring the list'])
  })

  it('every mutation needs X-COS-Expected-Server-Instance: missing is 428, another server is 409; reads need none', async () => {
    const f = await make()
    const missing = await f.request('/drafts', 'POST', { clientDraftId: uuid() }, true, null)
    expect(missing.status).toBe(428)
    expect(await missing.json()).toEqual({ error: 'server_instance_required', serverInstanceId: 'srv-1' })
    const other = await f.request('/drafts', 'POST', { clientDraftId: uuid() }, true, 'srv-old')
    expect(other.status).toBe(409)
    expect(await other.json()).toEqual({ error: 'server_instance_mismatch', serverInstanceId: 'srv-1' })
    expect((await (await f.request('/drafts')).json() as any).drafts).toEqual([])   // nothing was created
    const { draft } = await (await f.request('/drafts', 'POST', { clientDraftId: uuid() })).json() as any
    for (const [path, method, body] of [[`/drafts/${draft.id}`, 'PATCH', { revision: 1, steer: 'x' }], [`/drafts/${draft.id}/files`, 'POST', { revision: 1, media: [{ id: MEDIA, sha256: SHA }] }], [`/drafts/${draft.id}/run`, 'POST', { clientRequestId: uuid(), revision: 1 }], [`/drafts/${draft.id}/bind`, 'POST', { revision: 1, sessionId: 'meeting_http_1', surface: 'web' }], [`/drafts/${draft.id}/bind/meeting_http_1`, 'DELETE', undefined], [`/drafts/${draft.id}/files/pf_0123456789abcdef?revision=1`, 'DELETE', undefined], [`/drafts/${draft.id}`, 'DELETE', undefined]] as const) {
      expect([path, (await f.request(path, method, body, true, null)).status]).toEqual([path, 428])
    }
    expect(f.submit).not.toHaveBeenCalled()
    const read = await f.request(`/drafts/${draft.id}`, 'GET', undefined, true, null)
    expect(read.status).toBe(200)
    expect((await read.json() as any)).toMatchObject({ serverInstanceId: 'srv-1', draft: { id: draft.id, revision: 1, serverInstanceId: 'srv-1' } })
    // A body serverInstanceId is also checked when sent.
    expect((await f.request(`/drafts/${draft.id}`, 'PATCH', { revision: 1, steer: 'x', serverInstanceId: 'srv-old' })).status).toBe(409)
  })

  it('builds a safe Content-Disposition for any name', () => {
    expect(attachmentDisposition('a\r\nb".pdf')).toBe(`attachment; filename="a__b_.pdf"; filename*=UTF-8''${encodeURIComponent('a\r\nb".pdf')}`)
    expect(attachmentDisposition('...')).toBe(`attachment; filename="file"; filename*=UTF-8''...`)
    // Half an emoji (a lone surrogate) is dropped instead of throwing URIError; a whole one survives the 240 cut.
    expect(() => attachmentDisposition('report\uD83D.pdf')).not.toThrow()
    expect(attachmentDisposition('report\uD83D.pdf')).toContain(`filename*=UTF-8''report.pdf`)
    const atEdge = 'a'.repeat(239) + '\u{1F600}' + 'tail'
    expect(attachmentDisposition(atEdge)).toContain(encodeURIComponent('a'.repeat(239) + '\u{1F600}'))
  })
})
