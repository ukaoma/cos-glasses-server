import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Server } from 'node:http'

// Never the real data home: HOME and COS_DATA_DIR are temp dirs, and no meeting library is configured.
const realHome = process.env.HOME ?? ''
// The running server (6.78.x) never writes these two; the trace is left out because a live meeting appends to it.
const realFiles = ['live-cues-log.jsonl', 'live-cues-verdicts.json'].map(f => join(realHome, '.cos-glasses', 'data', f))
const fingerprint = () => realFiles.map(f => { try { const st = statSync(f); return `${f}:${st.size}:${st.mtimeMs}` } catch { return `${f}:absent` } })
const realBefore = fingerprint()
const dataDir = mkdtempSync(join(tmpdir(), 'cue-verdicts-route-'))
const homeDir = mkdtempSync(join(tmpdir(), 'cue-verdicts-home-'))
process.env.COS_DATA_DIR = dataDir
process.env.HOME = homeDir
for (const key of ['COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_SCRIPTS_DIR']) delete process.env[key]
vi.mock('../lib/jev.js', async (orig) => ({ ...(await orig<typeof import('../lib/jev.js')>()), resolveJevKey: () => ({ key: 'k', source: 'env' as const }) }))
vi.mock('../lib/provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: '/bin/true' }) }))
const { liveCuesRouter } = await import('./live-cues.js')
const { peekLiveCuesV2, shutdownLiveCuesV2 } = await import('../lib/live-cues-v2.js')
const { liveCueVerdicts } = await import('../lib/live-cue-verdicts.js')
const { dataPath } = await import('../lib/data-dir.js')

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
const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const get = (path: string) => fetch(base + path)

const CUE_A = '0f8fad5b-d9cb-469f-a165-70867728950e'
const CUE_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const UNKNOWN = '16fd2706-8baf-433b-82eb-8c7fada847da'
const verdictsFile = () => join(dataDir, 'live-cues-verdicts.json')
const now = Date.now()
function logCue(cueId: string, sessionId: string, createdAt: number) {
  liveCueVerdicts().logCue({ v: 1, cueId, sessionId, meetingTitle: 'G2 Recording 2026-10-19 1000', createdAt, armedAt: createdAt - 60_000, kind: 'challenge',
    headline: 'Name the owner', detail: 'Name the owner today.', gate: 0.88, sources: [{ id: 'mtg_abc', date: '2026-10-01', title: 'Pricing' }],
    model: 'claude-sonnet-5-5', prompt: 'v3', memorySource: 'cue_memory', kept: 1, before: 'who owns pricing' })
}

describe('live cue verdict routes (6.79.0)', () => {
  it('runs on temp data only', () => {
    expect(dataPath('live-cues-log.jsonl').startsWith(dataDir)).toBe(true)
  })

  it('with v2 OFF: status advertises verdicts, a logged cue is rated, cleared and listed with its saved title, and no engine is built', async () => {
    delete process.env.COS_LIVE_CUES_V2
    logCue(CUE_A, 'meeting_a', now - 60_000)
    logCue(CUE_B, 'meeting_b', now - 30_000)
    // meeting_a was saved by this server and retitled; meeting_b was not.
    mkdirSync(join(dataDir, 'recordings', '2026-10'), { recursive: true })
    writeFileSync(join(dataDir, 'recordings', '2026-10', '2026-10-19_hc-standup.g2-chunks.json'), JSON.stringify({ sessionId: 'meeting_a', durationMs: 60_000 }))
    writeFileSync(join(dataDir, 'recordings', '2026-10', '2026-10-19_hc-standup.md'), '# HC standup\n\n**Date:** 2026-10-19\n')

    const status = await (await get('/live-cues/status')).json() as Record<string, unknown>
    expect(status.verdicts).toEqual({ protocol: 1 })
    expect(status.v2).toBeUndefined()

    const rated = await post('/live-cues/feedback', { sessionId: 'meeting_a', cueId: CUE_A, verdict: 'late', note: ' after  the point ' })
    expect(rated.status).toBe(200)
    expect(await rated.json()).toEqual({ ok: true, cueId: CUE_A, verdict: 'late', vote: null })

    const history = await get('/live-cues/history')
    expect(history.headers.get('cache-control')).toBe('private, no-store')
    const h = await history.json() as Record<string, unknown> & { cues: Array<Record<string, unknown>> }
    expect(h).toMatchObject({ v: 1, truncated: false, skipped: 0, maxCuesPerMeeting: 25 })
    expect(h).not.toHaveProperty('meetings')
    expect(h.cues.map(c => c.cueId)).toEqual([CUE_A, CUE_B])
    expect(h.cues[0]).toMatchObject({ v: 1, sessionId: 'meeting_a', before: 'who owns pricing', title: 'HC standup', titleSource: 'saved',
      meetingTitle: 'G2 Recording 2026-10-19 1000', rating: { verdict: 'late', note: 'after the point' } })
    expect(h.cues[1]).toMatchObject({ title: 'G2 Recording 2026-10-19 1000', titleSource: 'capture', rating: null })
    expect(h.counts).toEqual({ total: 2, rated: 1, unrated: 1, byVerdict: { useful: 0, late: 1, repeat: 0, wrong: 0, obvious: 0 } })

    const unrated = await (await get('/live-cues/history?unrated=1&days=1')).json() as { cues: Array<{ cueId: string }>; counts: { total: number } }
    expect(unrated.cues.map(c => c.cueId)).toEqual([CUE_B])
    expect(unrated.counts.total).toBe(2)

    expect(await (await post('/live-cues/feedback', { sessionId: 'meeting_a', cueId: CUE_A, verdict: 'clear' })).json())
      .toEqual({ ok: true, cueId: CUE_A, verdict: null, vote: null })
    const trace = readFileSync(join(dataDir, 'live-cues-trace.jsonl'), 'utf8')
    expect(trace).not.toContain('after the point')                       // the note never reaches the trace
    expect(trace).not.toContain('who owns pricing')                      // nor the excerpt
    expect(trace.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>).filter(r => r.kind === 'feedback').map(r => r.verdict)).toEqual(['late', 'clear'])
    expect(peekLiveCuesV2()).toBeNull()
  })

  it('with sessionId (one, or a comma list of up to 5): meetings carry the durable counters, or the log count once they expired', async () => {
    writeFileSync(join(dataDir, 'live-cues-v2-state.json'), JSON.stringify({ meetings: { meeting_a: { cues: 3, writerCalls: 5, at: Date.now() } } }))
    const one = await (await get('/live-cues/history?sessionId=meeting_a')).json() as Record<string, unknown> & { cues: Array<{ cueId: string }> }
    expect(one.cues.map(c => c.cueId)).toEqual([CUE_A])
    expect(one.meetings).toEqual({ meeting_a: { cues: 3, cap: 25, writerCalls: 5, writerCap: 50 } })
    const two = await (await get('/live-cues/history?sessionId=meeting_a,%20meeting_b')).json() as Record<string, unknown> & { cues: Array<{ cueId: string }> }
    expect(two.cues.map(c => c.cueId)).toEqual([CUE_A, CUE_B])
    expect(two.meetings).toEqual({ meeting_a: { cues: 3, cap: 25, writerCalls: 5, writerCap: 50 }, meeting_b: { cues: 1, cap: 25, writerCalls: null, writerCap: 50 } })
    expect(peekLiveCuesV2()).toBeNull()
  })

  it('an unknown cue is 404 unknown_cue; a cue rated under another meeting is 409 cue_session_mismatch', async () => {
    const unknown = await post('/live-cues/feedback', { sessionId: 'meeting_a', cueId: UNKNOWN, verdict: 'useful' })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ reason: 'unknown_cue' })
    const mismatch = await post('/live-cues/feedback', { sessionId: 'meeting_a', cueId: CUE_B, verdict: 'useful' })
    expect(mismatch.status).toBe(409)
    expect(await mismatch.json()).toMatchObject({ reason: 'cue_session_mismatch' })
  })

  it('each bad verdict shape is 400 and writes nothing', async () => {
    const before = existsSync(verdictsFile()) ? readFileSync(verdictsFile(), 'utf8') : null
    const bad: unknown[] = [
      { sessionId: 'meeting_a', cueId: CUE_A, verdict: 'useful', vote: 'up' },          // both
      { sessionId: 'meeting_a', cueId: CUE_A, verdict: 'great' },                       // not a verdict
      { sessionId: 'meeting_a', cueId: CUE_A, verdict: 'USEFUL' },
      { sessionId: 'meeting_a', cueId: CUE_A, verdict: null },
      { sessionId: 'meeting_a', cueId: CUE_A, verdict: 'useful', note: 7 },             // note not a string
      { sessionId: 'meeting_a', cueId: 'short', verdict: 'useful' },                    // bad cueId
      { sessionId: 'x', cueId: CUE_A, verdict: 'useful' },                              // bad sessionId
      { cueId: CUE_A, verdict: 'useful' },                                              // no sessionId
      { sessionId: 'meeting_a', cueId: CUE_A },                                         // neither vote nor verdict
    ]
    for (const body of bad) {
      const res = await post('/live-cues/feedback', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json()).toMatchObject({ reason: 'invalid_request' })
    }
    const after = existsSync(verdictsFile()) ? readFileSync(verdictsFile(), 'utf8') : null
    expect(after).toBe(before)
  })

  it('each bad history query is 400', async () => {
    for (const qs of ['days=0', 'days=31', 'days=abc', 'days=1.5', 'days=-1', 'days=7&days=8', 'limit=0', 'limit=1001', 'limit=x', 'unrated=yes',
      'sessionId=a%20b', 'sessionId=x', 'sessionId=meeting_a,x', 'sessionId=m_1,m_2,m_3,m_4,m_5,m_6', 'sessionId=meeting_a&sessionId=meeting_b']) {
      const res = await get('/live-cues/history?' + qs)
      expect(res.status, qs).toBe(400)
      expect(await res.json()).toMatchObject({ reason: 'invalid_request' })
    }
    for (const qs of ['days=1', 'days=30', 'limit=1', 'limit=1000', 'unrated=0', 'unrated=1', 'sessionId=', 'sessionId=m_1,m_2,m_3,m_4,m_5', 'sessionId=meeting_a,meeting_a']) {
      expect((await get('/live-cues/history?' + qs)).status, qs).toBe(200)
    }
  })

  it('an unreadable verdicts file fails closed: 503 verdicts_unreadable for rating and history, and the file is left byte for byte', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const corrupt = '{"v":1,"verdicts":{"' + CUE_A + '":{"verdict":"useful"'
    writeFileSync(verdictsFile(), corrupt)
    const rating = await post('/live-cues/feedback', { sessionId: 'meeting_a', cueId: CUE_A, verdict: 'wrong' })
    expect(rating.status).toBe(503)
    expect(await rating.json()).toMatchObject({ reason: 'verdicts_unreadable' })
    const history = await get('/live-cues/history')
    expect(history.status).toBe(503)
    expect(await history.json()).toMatchObject({ reason: 'verdicts_unreadable' })
    expect(readFileSync(verdictsFile(), 'utf8')).toBe(corrupt)
    rmSync(verdictsFile())
    err.mockRestore()
  })

  it('the lens vote path is pinned: v2 off is 404 v2_disabled and stores nothing; v2 on answers exactly { ok, knownCue }', async () => {
    delete process.env.COS_LIVE_CUES_V2
    const off = await post('/live-cues/feedback', { sessionId: 'meeting_b', cueId: CUE_B, vote: 'up' })
    expect(off.status).toBe(404)
    expect(await off.json()).toEqual({ error: 'live cues v2 is off', reason: 'v2_disabled' })
    expect(existsSync(verdictsFile())).toBe(false)

    process.env.COS_LIVE_CUES_V2 = '1'; delete process.env.ANTHROPIC_API_KEY
    const unknown = await post('/live-cues/feedback', { sessionId: 'meeting_b', cueId: UNKNOWN, vote: 'up' })
    expect(unknown.status).toBe(200)
    expect(Object.keys(await unknown.json() as object).sort()).toEqual(['knownCue', 'ok'])
    const bad = await post('/live-cues/feedback', { sessionId: 'meeting_b', cueId: CUE_B, vote: 'sideways' })
    expect(bad.status).toBe(400)
  })

  it('with v2 ON the lens vote is kept beside the verdict, never over it, and only for the cue\'s own meeting', async () => {
    await post('/live-cues/feedback', { sessionId: 'meeting_b', cueId: CUE_B, verdict: 'repeat' })
    expect(await (await post('/live-cues/feedback', { sessionId: 'meeting_b', cueId: CUE_B, vote: 'down', reason: 'said it twice' })).json())
      .toEqual({ ok: true, knownCue: false })        // knownCue keeps its 6.75 meaning: this process's memory
    const h = await (await get('/live-cues/history?sessionId=meeting_b')).json() as { cues: Array<{ rating: Record<string, unknown> | null }> }
    expect(h.cues[0].rating).toMatchObject({ verdict: 'repeat', vote: 'down' })
    expect(await (await post('/live-cues/feedback', { sessionId: 'meeting_b', cueId: CUE_B, verdict: 'useful' })).json())
      .toEqual({ ok: true, cueId: CUE_B, verdict: 'useful', vote: 'down' })
    await post('/live-cues/feedback', { sessionId: 'meeting_b', cueId: UNKNOWN, vote: 'up' })
    expect(liveCueVerdicts().deps.store.read()[UNKNOWN]).toBeUndefined()
    await post('/live-cues/feedback', { sessionId: 'meeting_a', cueId: CUE_B, vote: 'up' })
    expect(liveCueVerdicts().deps.store.read()[CUE_B].vote).toBe('down')
  })

  it('50 interleaved verdict and vote posts keep every record', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(i).padStart(12, '0')}`)
    for (const cueId of ids) logCue(cueId, 'meeting_c', now - 10_000)
    const results = await Promise.all(ids.flatMap(cueId => [
      post('/live-cues/feedback', { sessionId: 'meeting_c', cueId, verdict: 'obvious' }),
      post('/live-cues/feedback', { sessionId: 'meeting_c', cueId, vote: 'up' }),
    ]))
    expect(results.map(r => r.status)).toEqual(Array(50).fill(200))
    const store = liveCueVerdicts().deps.store.read()
    for (const cueId of ids) expect(store[cueId], cueId).toMatchObject({ verdict: 'obvious', vote: 'up' })
  })

  it('left the real data home untouched', () => {
    expect(fingerprint()).toEqual(realBefore)
  })
})
