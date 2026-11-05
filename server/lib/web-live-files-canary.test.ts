/**
 * 6.99.14: Add file in COS Control Web's live meeting view, end to end through the REAL routes behind the REAL /api gate.
 * A browser signed in with the web session cookie (no pairing token) uploads a file to the media store (POST
 * /api/media/file, the composer's own upload), then adds it to the live meeting (POST /api/meeting-ask/files/media, the
 * route the phone uses), and Meeting Ask's history lists it as a ready meeting file. The request shapes are read out of
 * panes/meetings.js and panes/cos-chat.js, so this breaks if the page stops sending what the server takes.
 *
 * And the cookie rules hold on the write: without X-COS-Web, from another origin, or with no cookie, the add is refused
 * with 401 and the meeting's files do not change. No new route: the web reaches the ones that already exist.
 */
import express from 'express'
import type { Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requireApiToken } from './api-auth.js'
import { mintWebSessionCookieValue, WEB_SESSION_COOKIE_NAME } from './web-session-auth.js'
import { MediaStore, _setMediaStoreForTests } from './media-store.js'
import { MeetingAskRuntime } from './meeting-ask-runtime.js'
import { MeetingAskStore } from './meeting-ask-store.js'
import { mediaRouter, mediaBinaryBodyParser, mediaBodyParser } from '../routes/media.js'
import { createMeetingAskRouter } from '../routes/meeting-ask.js'

const TOKEN = 'canary-live-files-token'
const SESSION = 'meeting_1762349349000_g2demo'
const MEET = readFileSync(new URL('../web-control/panes/meetings.js', import.meta.url), 'utf8')
const CHAT = readFileSync(new URL('../web-control/panes/cos-chat.js', import.meta.url), 'utf8')

/** The attach body exactly as attachLiveFile builds it. */
function webAttachBody(sid: string, serverInstanceId: string, mediaId: string, name: string): Record<string, unknown> {
  const literal = /answer\('\/api\/meeting-ask\/files\/media', \{ method: 'POST', body: (\{ sessionId: sid, [^\n]*?\] \}) \}\)/.exec(MEET)?.[1]
  expect(literal, 'attachLiveFile posts { sessionId, serverInstanceId, media: [{ id, name }] }').toBeTruthy()
  // eslint-disable-next-line no-new-func
  return new Function('sid', 'conf', 't', `return ${literal};`)(sid, { serverInstanceId }, { mediaId, name })
}
/** The document upload headers as uploadMedia builds them, plus X-COS-Web from uploadRequest. */
function webFileHeaders(name: string, mime: string, at: string): Record<string, string> {
  const literal = /uploadRequest\('\/api\/media\/file', t\.file, (\{[\s\S]*?\}), function/.exec(CHAT)?.[1]
  expect(literal).toBeTruthy()
  expect(CHAT).toContain("xhr.setRequestHeader('X-COS-Web', '1');")
  // eslint-disable-next-line no-new-func
  return { 'X-COS-Web': '1', ...new Function('t', 'at', `return ${literal};`)({ name, mime }, at) }
}
// Every write the page makes goes through answer(), which always sends X-COS-Web: 1 with the cookie.
expect(MEET).toContain("var headers = { 'X-COS-Web': '1' };")

const dirs: string[] = []
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d }
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

async function fixture() {
  const media = new MediaStore(temp('live-files-media-'))
  const prev = _setMediaStoreForTests(media)
  cleanup.push(() => { _setMediaStoreForTests(prev) })
  const runtime = new MeetingAskRuntime({
    reviewAnswers: false, store: new MeetingAskStore(temp('live-files-ask-')), identity: () => 'server-live', admissions: () => true,
    lease: () => ({ id: 'x', kind: 'meeting_ask', setPhase() {}, release() {} }) as any,
    catalog: async () => [{ engine: 'claude', available: true, defaultModel: 'haiku', models: ['haiku'] }] as any,
    run: vi.fn(), search: async () => ({ sources: [], notices: [] }), media: () => media,
  })
  cleanup.push(() => runtime.shutdown())
  const app = express()
  app.use('/api', requireApiToken(TOKEN))
  app.use('/api/media/file', mediaBinaryBodyParser)
  app.use('/api/media', mediaBodyParser)
  app.use(express.json({ limit: '1mb' }))
  app.use('/api', mediaRouter)
  app.use('/api', createMeetingAskRouter(runtime))
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  cleanup.push(() => new Promise<void>(r => server.close(() => r())))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const cookie = `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue(TOKEN).value}`
  return { origin, cookie }
}

describe('Add file during a live meeting, through the web session cookie', () => {
  it('uploads, joins the meeting as a ready file, and Meeting Ask lists it', async () => {
    const { origin, cookie } = await fixture()
    const at = '2026-11-05T13:00:00.000Z'
    const up = await fetch(`${origin}/api/media/file`, { method: 'POST', headers: { cookie, Origin: origin, ...webFileHeaders('Q4 pricing.txt', 'text/plain', at) }, body: 'Q4 price list: Starter is 59 a month.\n' })
    expect(up.status).toBe(200)
    const mediaId = (await up.json()).attachment.id as string
    expect(mediaId).toMatch(/^m_[a-f0-9]{24}$/)

    const conf = await (await fetch(`${origin}/api/meeting-ask/config`, { headers: { cookie } })).json()
    expect(conf.serverInstanceId).toBe('server-live')

    const add = await fetch(`${origin}/api/meeting-ask/files/media`, {
      method: 'POST', headers: { cookie, Origin: origin, 'X-COS-Web': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(webAttachBody(SESSION, conf.serverInstanceId, mediaId, 'Q4 pricing.txt')),
    })
    expect(add.status).toBe(200)
    const files = (await add.json()).files
    expect(files).toEqual([expect.objectContaining({ id: `phone_${mediaId}`, name: 'Q4 pricing.txt', status: 'ready', origin: 'phone', text: 'Q4 price list: Starter is 59 a month.' })])

    const hist = await (await fetch(`${origin}/api/meeting-ask/history?sessionId=${SESSION}&serverInstanceId=server-live&offset=0&limit=50`, { headers: { cookie } })).json()
    expect(hist.files.map((f: { id: string }) => f.id)).toEqual([`phone_${mediaId}`])
  })

  it('refuses the add without X-COS-Web, from another origin, or with no cookie; the meeting keeps its files', async () => {
    const { origin, cookie } = await fixture()
    const up = await fetch(`${origin}/api/media/file`, { method: 'POST', headers: { cookie, Origin: origin, ...webFileHeaders('Agenda.txt', 'text/plain', '2026-11-05T13:00:00.000Z') }, body: 'Agenda: pricing, then hiring.\n' })
    const mediaId = (await up.json()).attachment.id as string
    const body = JSON.stringify(webAttachBody(SESSION, 'server-live', mediaId, 'Agenda.txt'))
    const json = { 'Content-Type': 'application/json' }
    expect((await fetch(`${origin}/api/meeting-ask/files/media`, { method: 'POST', headers: { cookie, Origin: origin, ...json }, body })).status).toBe(401)
    expect((await fetch(`${origin}/api/meeting-ask/files/media`, { method: 'POST', headers: { cookie, Origin: 'http://evil.example', 'X-COS-Web': '1', ...json }, body })).status).toBe(401)
    expect((await fetch(`${origin}/api/meeting-ask/files/media`, { method: 'POST', headers: { Origin: origin, 'X-COS-Web': '1', ...json }, body })).status).toBe(401)
    expect((await fetch(`${origin}/api/media/file`, { method: 'POST', headers: { cookie, Origin: origin, 'Content-Type': 'text/plain', 'X-COS-Filename': 'x.txt' }, body: 'x' })).status).toBe(401)
    const hist = await (await fetch(`${origin}/api/meeting-ask/history?sessionId=${SESSION}&serverInstanceId=server-live&offset=0&limit=50`, { headers: { cookie } })).json()
    expect(hist.files).toEqual([])
  })
})
