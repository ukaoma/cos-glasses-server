import express from 'express'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The domain filer is wrapped, not replaced: the real keyword scorer still runs, and the test reads the text it was handed.
const filed = vi.hoisted(() => ({ texts: [] as string[] }))
vi.mock('../lib/domains.js', async original => {
  const real = await original<typeof import('../lib/domains.js')>()
  return { ...real, domainForMeeting: (explicit: string | undefined, text: string, ops: string | null) => { filed.texts.push(text); return real.domainForMeeting(explicit, text, ops) } }
})

import { MeetingStore } from '../lib/meeting-store.js'
import { MeetingFinalizationJobStore } from '../lib/meeting-finalization-jobs.js'
import { initializeServerInstanceId } from '../lib/server-instance-id.js'
import { createTitleSteerStore, TitleSteerError, TITLE_STEER_FILE_NAME } from '../lib/meeting-title-steer.js'
import { createMeetingRouter } from './meeting.js'

// Title steer (6.99.0): the name typed in COS Control while a meeting records. Route level, over the real meeting store
// and save route, with the live session map faked the way meeting-stop-request.test.ts does. Synthetic text only.

const TOKEN = 'title-steer-token'
const SID = 'g2_meeting_0001'
const roots: string[] = []
const servers: Server[] = []

const opsEnvKeys = ['COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_SCRIPTS_DIR'] as const
const previousOpsEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  filed.texts.length = 0
  for (const key of opsEnvKeys) { previousOpsEnv[key] = process.env[key]; delete process.env[key] }
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const key of opsEnvKeys) { if (previousOpsEnv[key] == null) delete process.env[key]; else process.env[key] = previousOpsEnv[key] }
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function harness(opts: { state?: 'active' | 'closed' | 'missing'; parent?: string; wrapSteer?: (real: ReturnType<typeof createTitleSteerStore>) => ReturnType<typeof createTitleSteerStore> } = {}) {
  const parent = opts.parent ?? mkdtempSync(join(tmpdir(), 'cos-title-steer-route-'))
  if (!opts.parent) roots.push(parent)
  initializeServerInstanceId(join(parent, 'server-instance-id'))
  const store = new MeetingStore(join(parent, 'data', 'recordings'))
  const realSteer = createTitleSteerStore({ path: join(parent, 'data', TITLE_STEER_FILE_NAME) })
  const titleSteer = opts.wrapSteer ? opts.wrapSteer(realSteer) : realSteer
  const publish = vi.fn(() => true)
  const chunk = { text: 'Hello there.', speaker: 'Speaker A', elapsed: 61_000, similarity: 0.9 }
  const sessionState = { value: opts.state ?? 'active' as 'active' | 'closed' | 'missing' }
  const sessions = {
    getTranscript: () => '[Speaker A]: Hello there.',
    getStartTime: () => 1_000,
    getChunks: () => [chunk],
    getChunkEntries: () => [{ chunkIndex: 0, chunk }],
    getProviderCandidates: () => ({}),
    getIntegrity: () => ({ received: 1, stored: 1, maxIndex: 0, expected: 1, missingIndices: [], completeness: 1 }),
    drainAudioWrites: async () => {},
    hasAudio: () => false,
    moveAudioToPending: () => null,
    delete: vi.fn(),
    getState: () => sessionState.value,
    publishTitleSteer: publish,
  }
  const app = express()
  app.use('/api', (req, res, next) => {
    if (req.headers['x-cos-token'] !== TOKEN) { res.status(401).json({ error: 'unauthorized' }); return }
    next()
  })
  app.use(express.json())
  app.use('/api', createMeetingRouter({
    store,
    sessions,
    titleSteer,
    emit: vi.fn(),
    finalizationJobs: new MeetingFinalizationJobStore(join(parent, 'data', 'meeting-finalization-jobs')),
    runBatch: async () => { throw new Error('no batch in this test') },
    scheduleBackground: () => {},
  }))
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  servers.push(server)
  const address = server.address()
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-cos-token': TOKEN } })
    return { status: res.status, headers: res.headers, body: await res.json() as Record<string, any> }
  }
  const put = (body: unknown) => api('/api/meeting/title-steer', { method: 'PUT', body: JSON.stringify(body) })
  const get = (sessionId = SID) => api(`/api/meeting/title-steer?sessionId=${encodeURIComponent(sessionId)}`)
  const save = (body: Record<string, unknown> = {}) => api('/api/meeting/save', { method: 'POST', body: JSON.stringify({ sessionId: SID, ...body }) })
  const saved = () => {
    const found = store.findBySessionId(SID)
    if (!found) throw new Error('not saved')
    return { found, markdown: readFileSync(found.filepath, 'utf8'), sidecar: JSON.parse(readFileSync(found.sidecarPath, 'utf8')) as Record<string, any> }
  }
  return { api, put, get, save, saved, store, titleSteer, publish, sessionState, parent }
}

describe('GET and PUT /meeting/title-steer', () => {
  it('a meeting with no steer answers revision 0 and no title, uncached', async () => {
    const h = await harness()
    const res = await h.get()
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ sessionId: SID, title: null, revision: 0, updatedAt: null })
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('sets a steer, answers the new view, and a later GET returns the same', async () => {
    const h = await harness()
    const set = await h.put({ sessionId: SID, title: 'Polling accuracy chat', expectedRevision: 0 })
    expect(set.status).toBe(200)
    expect(set.body).toMatchObject({ sessionId: SID, title: 'Polling accuracy chat', revision: 1 })
    expect(typeof set.body.updatedAt).toBe('string')
    expect(Number.isNaN(Date.parse(set.body.updatedAt))).toBe(false)
    expect(set.headers.get('cache-control')).toBe('private, no-store')
    expect((await h.get()).body).toEqual(set.body)
  })

  it('tells the live session to publish the change, once per successful write and never for a refused one', async () => {
    const h = await harness()
    await h.put({ sessionId: SID, title: 'First', expectedRevision: 0 })
    expect(h.publish).toHaveBeenCalledTimes(1)
    expect(h.publish).toHaveBeenCalledWith(SID)
    await h.put({ sessionId: SID, title: 'Stale', expectedRevision: 0 })      // 409
    await h.put({ sessionId: SID, title: 'x'.repeat(121), expectedRevision: 1 }) // 400
    expect(h.publish).toHaveBeenCalledTimes(1)
    await h.put({ sessionId: SID, title: '', expectedRevision: 1 })           // a clear is published too
    expect(h.publish).toHaveBeenCalledTimes(2)
  })

  it('normalizes: whitespace collapsed, control characters to spaces, trimmed', async () => {
    const h = await harness()
    const set = await h.put({ sessionId: SID, title: '  Board\u0000prep\t\tand   pricing \n', expectedRevision: 0 })
    expect(set.body.title).toBe('Board prep and pricing')
  })

  it('caps at 120 characters: 120 is kept, 121 is 400 invalid_title and changes nothing', async () => {
    const h = await harness()
    const ok = await h.put({ sessionId: SID, title: 'a'.repeat(120), expectedRevision: 0 })
    expect(ok.status).toBe(200)
    expect(ok.body.title).toHaveLength(120)
    const over = await h.put({ sessionId: SID, title: 'b'.repeat(121), expectedRevision: 1 })
    expect(over.status).toBe(400)
    expect(over.body).toMatchObject({ error: 'invalid_title', reason: 'invalid_title' })
    expect((await h.get()).body).toMatchObject({ title: 'a'.repeat(120), revision: 1 })
  })

  it('"" and null clear the steer; clearing keeps counting the revision', async () => {
    const h = await harness()
    await h.put({ sessionId: SID, title: 'Something', expectedRevision: 0 })
    const cleared = await h.put({ sessionId: SID, title: '', expectedRevision: 1 })
    expect(cleared.body).toMatchObject({ title: null, revision: 2 })
    await h.put({ sessionId: SID, title: 'Again', expectedRevision: 2 })
    const nulled = await h.put({ sessionId: SID, title: null, expectedRevision: 3 })
    expect(nulled.body).toMatchObject({ title: null, revision: 4 })
    expect((await h.get()).body.title).toBeNull()
  })

  it('409 title_changed on a stale revision, with the current view so the client can resync; nothing changes', async () => {
    const h = await harness()
    await h.put({ sessionId: SID, title: 'Phone typed this', expectedRevision: 0 })
    const stale = await h.put({ sessionId: SID, title: 'Mac typed this', expectedRevision: 0 })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ error: 'title_changed', reason: 'title_changed', current: { sessionId: SID, title: 'Phone typed this', revision: 1 } })
    expect((await h.get()).body).toMatchObject({ title: 'Phone typed this', revision: 1 })
    // A revision from the future is just as wrong.
    expect((await h.put({ sessionId: SID, title: 'X', expectedRevision: 5 })).status).toBe(409)
  })

  it('404 session_not_live for a session that is closed or unknown, and nothing is stored', async () => {
    for (const state of ['closed', 'missing'] as const) {
      const h = await harness({ state })
      const res = await h.put({ sessionId: SID, title: 'Too late', expectedRevision: 0 })
      expect(res.status, state).toBe(404)
      expect(res.body, state).toMatchObject({ error: 'session_not_live', reason: 'session_not_live' })
      expect(h.titleSteer.get(SID).revision).toBe(0)
      expect(h.publish).not.toHaveBeenCalled()
    }
  })

  it('a session that stops being live stops taking steers, but its steer still reads back', async () => {
    const h = await harness()
    await h.put({ sessionId: SID, title: 'Kept', expectedRevision: 0 })
    h.sessionState.value = 'closed'
    expect((await h.put({ sessionId: SID, title: 'Late', expectedRevision: 1 })).status).toBe(404)
    expect((await h.get()).body).toMatchObject({ title: 'Kept', revision: 1 })
  })

  it('malformed requests are 400 whether or not the session is live', async () => {
    for (const state of ['active', 'closed'] as const) {
      const h = await harness({ state })
      const bad: Array<[Record<string, unknown>, string]> = [
        [{ title: 'X', expectedRevision: 0 }, 'invalid_session_id'],
        [{ sessionId: 'a b', title: 'X', expectedRevision: 0 }, 'invalid_session_id'],
        [{ sessionId: SID, title: 5, expectedRevision: 0 }, 'invalid_title'],
        [{ sessionId: SID, title: { a: 1 }, expectedRevision: 0 }, 'invalid_title'],
        [{ sessionId: SID, title: 'X' }, 'invalid_revision'],
        [{ sessionId: SID, title: 'X', expectedRevision: -1 }, 'invalid_revision'],
        [{ sessionId: SID, title: 'X', expectedRevision: '0' }, 'invalid_revision'],
        [{ sessionId: SID, title: 'X', expectedRevision: 0.5 }, 'invalid_revision'],
      ]
      for (const [body, reason] of bad) {
        const res = await h.put(body)
        expect(res.status, `${state} ${JSON.stringify(body)}`).toBe(400)
        expect(res.body.reason, JSON.stringify(body)).toBe(reason)
      }
      expect(h.titleSteer.get(SID).revision).toBe(0)
    }
  })

  it('GET with a missing or malformed sessionId is 400', async () => {
    const h = await harness()
    expect((await h.api('/api/meeting/title-steer')).status).toBe(400)
    const bad = await h.get('../x')
    expect(bad.status).toBe(400)
    expect(bad.body.reason).toBe('invalid_session_id')
  })

  it('GET for an id that names an Object member (constructor, __proto__) is an ordinary empty answer, not an error', async () => {
    const h = await harness()
    for (const id of ['constructor', '__proto__', 'toString']) {
      const res = await h.get(id)
      expect(res.status, id).toBe(200)
      expect(res.body, id).toEqual({ sessionId: id, title: null, revision: 0, updatedAt: null })
    }
  })

  it('an unexpected failure is a plain 500 and the log carries the error name only, never its message (which could hold the title)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const secret = 'Zephyrwind Acquisition Talks'
    const h = await harness({ wrapSteer: real => ({ ...real, set: () => { throw new Error(`disk said no to ${secret}`) } }) })
    const res = await h.put({ sessionId: SID, title: secret, expectedRevision: 0 })
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'title_steer_error', reason: 'title_steer_error' })
    const lines = errors.mock.calls.map(args => args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '))
    expect(lines.some(line => line.includes('[meeting/title-steer]'))).toBe(true)
    expect(lines.filter(line => line.includes('Zephyrwind') || line.includes('disk said no'))).toEqual([])
  })

  it('a persistence failure is a 503 steer_persistence_failed and the revision stays', async () => {
    const h = await harness({ wrapSteer: real => ({ ...real, set: () => { throw new TitleSteerError('steer_persistence_failed', 503) } }) })
    const res = await h.put({ sessionId: SID, title: 'Anything', expectedRevision: 0 })
    expect(res.status).toBe(503)
    expect(res.body.reason).toBe('steer_persistence_failed')
    expect(h.publish).not.toHaveBeenCalled()
  })

  it('needs the API token like every other /api/meeting route', async () => {
    const h = await harness()
    const res = await fetch(`http://127.0.0.1:${(servers[0].address() as { port: number }).port}/api/meeting/title-steer?sessionId=${SID}`)
    expect(res.status).toBe(401)
    expect(h.titleSteer.get(SID).revision).toBe(0)
  })

  it('persists across a restart: a new router over the same data dir serves the steer and keeps the revision', async () => {
    const first = await harness()
    await first.put({ sessionId: SID, title: 'Survives a restart', expectedRevision: 0 })
    await first.put({ sessionId: SID, title: 'Survives a restart, twice', expectedRevision: 1 })
    const second = await harness({ parent: first.parent })
    expect((await second.get()).body).toMatchObject({ title: 'Survives a restart, twice', revision: 2 })
    expect((await second.put({ sessionId: SID, title: 'Old client', expectedRevision: 1 })).status).toBe(409)
    expect((await second.put({ sessionId: SID, title: 'New client', expectedRevision: 2 })).body.revision).toBe(3)
  })

  it('never logs the title: console shows lengths only, on every outcome', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(name => vi.spyOn(console, name).mockImplementation(() => {}))
    const secret = 'Zephyrwind Acquisition Talks'
    const h = await harness()
    await h.put({ sessionId: SID, title: secret, expectedRevision: 0 })              // set
    await h.put({ sessionId: SID, title: `${secret} v2`, expectedRevision: 0 })      // 409
    await h.put({ sessionId: SID, title: secret.repeat(10), expectedRevision: 1 })   // 400
    await h.put({ sessionId: SID, title: '', expectedRevision: 1 })                  // clear
    await h.put({ sessionId: SID, title: secret, expectedRevision: 2 })
    await h.save()
    const lines = spies.flatMap(spy => spy.mock.calls.map(args => args.map(String).join(' ')))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.filter(line => line.includes('Zephyrwind') || line.includes('Acquisition'))).toEqual([])
    expect(lines.some(line => line.includes('[meeting/title-steer]') && line.includes(`length=${secret.length}`))).toBe(true)
  })
})

describe('the steer in the status route', () => {
  it('GET /meeting/sessions/:id/status carries titleSteer (null until one is set)', async () => {
    const h = await harness()
    initializeServerInstanceId(join(h.parent, 'server-instance-id'))
    const before = await h.api(`/api/meeting/sessions/${SID}/status`)
    expect(before.status).toBe(200)
    expect(before.body.titleSteer).toBeNull()
    await h.put({ sessionId: SID, title: 'Visible in status', expectedRevision: 0 })
    expect((await h.api(`/api/meeting/sessions/${SID}/status`)).body.titleSteer).toBe('Visible in status')
    await h.put({ sessionId: SID, title: '', expectedRevision: 1 })
    expect((await h.api(`/api/meeting/sessions/${SID}/status`)).body.titleSteer).toBeNull()
  })
})

describe('saving with a steer', () => {
  it('a save that sends no title files under the steer, with the header row and the sidecar field', async () => {
    const h = await harness()
    await h.put({ sessionId: SID, title: 'Polling accuracy chat', expectedRevision: 0 })
    const res = await h.save()
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const { found, markdown, sidecar } = h.saved()
    expect(found.title).toBe('Polling accuracy chat')
    expect(markdown.startsWith('# Polling accuracy chat\n')).toBe(true)
    expect(markdown).toContain('| **Title steer** | Polling accuracy chat |')
    expect(sidecar.title).toBe('Polling accuracy chat')
    expect(sidecar.titleSteer).toBe('Polling accuracy chat')
    expect(found.filename).toContain('Polling_accuracy_chat')
  })

  it('a blank title in the save counts as none: the steer names the meeting', async () => {
    const h = await harness()
    await h.put({ sessionId: SID, title: 'From the steer', expectedRevision: 0 })
    await h.save({ title: '   ' })
    expect(h.saved().found.title).toBe('From the steer')
  })

  it('a save that sends its own title keeps it, and still records the steer in the row and the sidecar', async () => {
    const h = await harness()
    await h.put({ sessionId: SID, title: 'Polling accuracy chat', expectedRevision: 0 })
    await h.save({ title: 'Quarterly Polling Review' })
    const { found, markdown, sidecar } = h.saved()
    expect(found.title).toBe('Quarterly Polling Review')
    expect(markdown.startsWith('# Quarterly Polling Review\n')).toBe(true)
    expect(markdown).toContain('| **Title steer** | Polling accuracy chat |')
    expect(sidecar).toMatchObject({ title: 'Quarterly Polling Review', titleSteer: 'Polling accuracy chat' })
  })

  it('without a steer nothing changes: no row, no sidecar field, the old fallback title', async () => {
    const h = await harness()
    await h.save()
    const { found, markdown, sidecar } = h.saved()
    expect(found.title).toMatch(/^G2 Recording \d{4}-\d{2}-\d{2} \d{4}$/)
    expect(markdown).not.toContain('Title steer')
    expect('titleSteer' in sidecar).toBe(false)
  })

  it('a cleared steer is no steer', async () => {
    const h = await harness()
    await h.put({ sessionId: SID, title: 'Typed then removed', expectedRevision: 0 })
    await h.put({ sessionId: SID, title: '', expectedRevision: 1 })
    await h.save()
    const { found, markdown, sidecar } = h.saved()
    expect(found.title).toMatch(/^G2 Recording /)
    expect(markdown).not.toContain('Title steer')
    expect('titleSteer' in sidecar).toBe(false)
  })

  it('escapes a pipe in the header row so the table stays one row per field', async () => {
    const h = await harness()
    await h.put({ sessionId: SID, title: 'Sales | Marketing sync', expectedRevision: 0 })
    await h.save({ title: 'Weekly sync' })
    const { markdown, sidecar } = h.saved()
    expect(markdown).toContain('| **Title steer** | Sales \\| Marketing sync |')
    const row = markdown.split('\n').find(line => line.includes('Title steer'))!
    expect(row.replace(/\\\|/g, '').split('|').length).toBe(4)               // leading, field, value, trailing
    expect(sidecar.titleSteer).toBe('Sales | Marketing sync')               // the sidecar keeps the raw text
  })

  it('the header row and sidecar keep the steer as typed: a slash is not turned into a space', async () => {
    const h = await harness()
    await h.put({ sessionId: SID, title: 'AI/ML roadmap sync', expectedRevision: 0 })
    await h.save({ title: 'Roadmap sync' })
    const { markdown, sidecar } = h.saved()
    expect(markdown).toContain('| **Title steer** | AI/ML roadmap sync |')
    expect(sidecar.titleSteer).toBe('AI/ML roadmap sync')
  })

  it('the steer reaches the domain filer through the title, as a sent title does', async () => {
    const h = await harness()
    await h.put({ sessionId: SID, title: 'Zephyr board meeting', expectedRevision: 0 })
    await h.save()
    expect(filed.texts).toHaveLength(1)
    expect(filed.texts[0].startsWith('Zephyr board meeting\n')).toBe(true)
    // And when the request has its own title, that is what is filed, not the steer.
    const other = await harness()
    await other.put({ sessionId: SID, title: 'Steer words', expectedRevision: 0 })
    filed.texts.length = 0
    await other.save({ title: 'Sent words' })
    expect(filed.texts[0].startsWith('Sent words\n')).toBe(true)
    expect(filed.texts[0]).not.toContain('Steer words')
  })

  it('a replayed save returns the first save: the steer cannot rename a meeting that is already filed', async () => {
    const h = await harness()
    await h.put({ sessionId: SID, title: 'First name', expectedRevision: 0 })
    await h.save()
    h.sessionState.value = 'closed'
    expect((await h.put({ sessionId: SID, title: 'Second name', expectedRevision: 1 })).status).toBe(404)
    const again = await h.save()
    expect(again.status).toBe(200)
    expect(h.saved().found.title).toBe('First name')
  })
})
