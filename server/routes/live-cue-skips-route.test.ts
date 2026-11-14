/**
 * The build after 7.0.42 (Memories C, lead 2026-11-14 15:58 and 16:03): POST /api/live-cues/skip and /skip/clear, and the
 * `skips` field on GET /api/live-cues/history. Real router, temp data dir and temp HOME only. Placeholder words only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Server } from 'node:http'

const realHome = process.env.HOME ?? ''
const dataDir = mkdtempSync(join(tmpdir(), 'cue-skips-route-'))
const homeDir = mkdtempSync(join(tmpdir(), 'cue-skips-home-'))
process.env.COS_DATA_DIR = dataDir
process.env.HOME = homeDir
for (const key of ['COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_SCRIPTS_DIR']) delete process.env[key]
vi.mock('../lib/jev.js', async (orig) => ({ ...(await orig<typeof import('../lib/jev.js')>()), resolveJevKey: () => ({ key: 'k', source: 'env' as const }) }))
vi.mock('../lib/provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: '/bin/true' }) }))
const { liveCuesRouter } = await import('./live-cues.js')
const { shutdownLiveCuesV2 } = await import('../lib/live-cues-v2.js')
const { liveCueVerdicts } = await import('../lib/live-cue-verdicts.js')
const { MAX_MEETING_SKIPS } = await import('../lib/live-cue-skips.js')

let server: Server
let base = ''
const saved = { ...process.env }
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api', liveCuesRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address(); base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`
})
afterAll(() => {
  server.close(); shutdownLiveCuesV2(); process.env = saved; process.env.HOME = realHome
  rmSync(dataDir, { recursive: true, force: true }); rmSync(homeDir, { recursive: true, force: true })
})
const post = async (path: string, body: unknown) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() as any }
}
const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() as any } }
const skipsFile = () => join(dataDir, 'live-cues-skips.json')
let n = 0
function logCue(sessionId: string, createdAt: number) {
  liveCueVerdicts().logCue({ v: 1, cueId: `0f8fad5b-d9cb-469f-a165-${String(++n).padStart(12, '0')}`, sessionId, meetingTitle: 'G2 Recording', createdAt,
    armedAt: createdAt - 60_000, kind: 'challenge', headline: 'Name the owner', detail: 'Name the owner today.', gate: 0.88, sources: [],
    model: 'claude-sonnet-5-5', before: '' })
}

describe('skip this meeting (routes)', () => {
  it('skips a meeting in the window, lists it in history, and undoes it', async () => {
    logCue('meeting_a', Date.now() - 60_000)
    logCue('meeting_b', Date.now() - 30_000)
    const skipped = await post('/live-cues/skip', { sessionId: 'meeting_a' })
    expect(skipped.status).toBe(200)
    expect(skipped.body).toMatchObject({ ok: true, sessionId: 'meeting_a', skippedAt: expect.any(Number) })
    const history = await get('/live-cues/history?days=7&unrated=1')
    expect(history.status).toBe(200)
    expect(history.body.skips).toEqual({ meeting_a: skipped.body.skippedAt })
    expect((await get('/live-cues/history?sessionId=meeting_b')).body.skips).toEqual({})
    expect(liveCueVerdicts().unratedSessionCount(7)).toBe(1)
    const cleared = await post('/live-cues/skip/clear', { sessionId: 'meeting_a' })
    expect(cleared).toEqual({ status: 200, body: { ok: true, sessionId: 'meeting_a', skippedAt: null } })
    expect((await get('/live-cues/history')).body.skips).toEqual({})
    expect(liveCueVerdicts().unratedSessionCount(7)).toBe(2)
  })

  it('refuses a bad id (400) and a meeting with no cue in the window (404), writing nothing', async () => {
    const before = (() => { try { return readFileSync(skipsFile(), 'utf8') } catch { return null } })()
    for (const body of [{}, { sessionId: '' }, { sessionId: 'x' }, { sessionId: 'bad id!' }, { sessionId: 42 }]) {
      for (const path of ['/live-cues/skip', '/live-cues/skip/clear']) {
        const r = await post(path, body)
        expect([r.status, r.body.reason]).toEqual([400, 'invalid_request'])
      }
    }
    for (const path of ['/live-cues/skip', '/live-cues/skip/clear']) {
      const r = await post(path, { sessionId: 'never_seen_meeting' })
      expect([r.status, r.body.reason]).toEqual([404, 'unknown_meeting'])
    }
    expect((() => { try { return readFileSync(skipsFile(), 'utf8') } catch { return null } })()).toBe(before)
  })

  it('a full skips map refuses with 409 skips_full and writes nothing', async () => {
    logCue('meeting_c', Date.now() - 10_000)
    const skips: Record<string, { at: number }> = {}
    for (let i = 0; i < MAX_MEETING_SKIPS; i++) skips[`m${i}`] = { at: Date.now() }
    writeFileSync(skipsFile(), JSON.stringify({ v: 1, skips }))
    const before = readFileSync(skipsFile(), 'utf8')
    const r = await post('/live-cues/skip', { sessionId: 'meeting_c' })
    expect([r.status, r.body.reason]).toEqual([409, 'skips_full'])
    expect(readFileSync(skipsFile(), 'utf8')).toBe(before)
    rmSync(skipsFile())
  })

  it('an unreadable skips file: the routes answer 503 and history is still served, with skips null', async () => {
    writeFileSync(skipsFile(), '{not json')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await post('/live-cues/skip', { sessionId: 'meeting_b' })
      expect([r.status, r.body.reason]).toEqual([503, 'skips_unreadable'])
      const history = await get('/live-cues/history')
      expect(history.status).toBe(200)
      expect(history.body.skips).toBeNull()
      expect(history.body.cues.length).toBeGreaterThan(0)
      expect(readFileSync(skipsFile(), 'utf8')).toBe('{not json')
      expect(err.mock.calls.flat().join(' ')).not.toContain('meeting_b')
    } finally { err.mockRestore(); rmSync(skipsFile()) }
  })
})
