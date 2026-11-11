// 7.0.25 (lead 2026-11-11 10:29; Q1 10:22, G1 10:23): kept rows reach only a client that asks for them (`kept=1`).
// The public lens (6.11.681) and Control Mac (0.5.389) do not clamp to their own limit, so without the parameter
// GET /api/agent-sessions must answer exactly the 7.0.18 selection: same rows, same limit, even with COS pins, folder
// members and COS-started sessions on disk.
//
// The first describe imports nothing newer than 7.0.18 (a7e0317), so the SAME file runs there unchanged as the
// reference: `-t "without the parameter"` passes on a7e0317 and on this head with the same expected ids.
import express from 'express'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentSessionsRouter } from './agent-sessions.js'
import { dataPath } from '../lib/data-dir.js'

const DAY = 24 * 3600 * 1000
const id = (n: number) => `${String(n).padStart(8, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`
const RECENT = Array.from({ length: 25 }, (_, i) => id(i)) // 25 sessions inside 7 days; the cap of 20 drops 5
const PINNED = id(901) // 40 days old, COS-pinned
const FOLDERED = id(902) // 10 days old, in a folder
const STARTED = id(903) // 3 days old, started by a person through COS (job journal); behind 25 newer, past the cap
const FIXTURE_IDS = new Set([...RECENT, PINNED, FOLDERED, STARTED])

let home = ''
let base = ''
let server: import('node:http').Server | null = null
let previousHome: string | undefined

function transcript(sessionId: string, ageMs: number): void {
  const dir = join(home, '.claude', 'projects', 'MU-Chief-Staff')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: `Fixture ${sessionId.slice(0, 8)}` })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: 'placeholder' } })}\n`)
  const at = (Date.now() - ageMs) / 1000
  utimesSync(file, at, at)
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'cos-kept-param-'))
  previousHome = process.env.COS_AGENT_SESSIONS_HOME
  process.env.COS_AGENT_SESSIONS_HOME = home
  RECENT.forEach((sid, i) => transcript(sid, (i + 1) * 60_000))
  transcript(PINNED, 40 * DAY)
  transcript(FOLDERED, 10 * DAY)
  transcript(STARTED, 3 * DAY)
  // The organizer store and the job journal, written as files (vitest.config.ts points COS_DATA_DIR at a scratch
  // dir). A 7.0.18 server has no reader for either; this head reads both.
  const now = new Date().toISOString()
  mkdirSync(dataPath(), { recursive: true })
  writeFileSync(dataPath('session-organizer.json'), JSON.stringify({
    version: 1, rev: 2,
    folders: { f_00000000000000aa: { name: 'Release', created_at: now } },
    sessions: {
      [`claude:${PINNED}`]: { cos_pinned: true, updated_at: now },
      [`claude:${FOLDERED}`]: { folder_id: 'f_00000000000000aa', updated_at: now },
    },
  }), { mode: 0o600 })
  mkdirSync(dataPath('query-jobs'), { recursive: true })
  writeFileSync(dataPath('query-jobs', `${now.slice(0, 10)}.jsonl`), [
    { persistedAt: now, jobId: 'j-ask', type: 'accepted', request: { query: 'q', sessionId: 's' }, patch: {} },
    { persistedAt: now, jobId: 'j-ask', type: 'running', patch: { provider: 'claude', cliSessionId: STARTED } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  const app = express()
  app.use(express.json())
  app.use('/api', agentSessionsRouter)
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`
})
afterAll(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  if (previousHome === undefined) delete process.env.COS_AGENT_SESSIONS_HOME
  else process.env.COS_AGENT_SESSIONS_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

/** The fixture's rows only, in order: live rows from this Mac's own registry are not part of the fixture. */
async function fixtureIds(path: string): Promise<string[]> {
  const res = await fetch(base + path)
  expect(res.status).toBe(200)
  const json = await res.json() as { sessions: Array<{ session_id: string }> }
  return json.sessions.map(r => r.session_id).filter(sid => FIXTURE_IDS.has(sid))
}

describe('without the parameter: the 7.0.18 selection', () => {
  it('the newest 20 inside 7 days, and none of the pinned, foldered or COS-started sessions', async () => {
    expect(await fixtureIds('/agent-sessions')).toEqual(RECENT.slice(0, 20))
  })
  it('the same with a smaller limit and on the Opened clock', async () => {
    expect(await fixtureIds('/agent-sessions?limit=5')).toEqual(RECENT.slice(0, 5))
    for (const kept of [PINNED, FOLDERED, STARTED]) expect(await fixtureIds('/agent-sessions?sort=opened')).not.toContain(kept)
  })
  it('any other value of the parameter is the same as none', async () => {
    for (const v of ['0', 'true', 'yes', '']) expect(await fixtureIds(`/agent-sessions?kept=${v}`)).toEqual(RECENT.slice(0, 20))
  })
})

describe('with kept=1: the kept rows too (Control Web)', () => {
  it('the same 20, plus the pinned, foldered and COS-started sessions outside the cap and the limit', async () => {
    const ids = await fixtureIds('/agent-sessions?kept=1')
    for (const kept of [PINNED, FOLDERED, STARTED]) expect(ids).toContain(kept)
    expect(ids.filter(sid => RECENT.includes(sid))).toEqual(RECENT.slice(0, 20))
    const small = await fixtureIds('/agent-sessions?kept=1&limit=5')
    expect(small.filter(sid => RECENT.includes(sid))).toEqual(RECENT.slice(0, 5))
    for (const kept of [PINNED, FOLDERED, STARTED]) expect(small).toContain(kept)
  })
})
