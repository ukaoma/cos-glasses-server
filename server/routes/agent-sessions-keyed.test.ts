// Key lanes K1, P11: a keyed Codex thread (in its profile home) has its own name and its own
// subagents on the agent-session routes, read through codexHomes(). With key lanes off the
// routes read only the server home, as before. Scratch HOME, COS_DATA_DIR and sessions home,
// set before any server module loads (importing them runs them).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

const ROOT = mkdtempSync(join(tmpdir(), 'kl-p11-sessions-'))
const HOME = join(ROOT, 'home')
const DATA = join(ROOT, 'data')
const saved = { ...process.env }
process.env.HOME = HOME
process.env.COS_DATA_DIR = DATA
process.env.COS_PROFILE_PATH = join(DATA, 'profile.json')
process.env.COS_AGENT_SESSIONS_HOME = HOME
process.env.CODEX_HOME = join(HOME, '.codex')
delete process.env.COS_KEY_LANES

const { agentSessionsRouter } = await import('./agent-sessions.js')
const { codexProfileHome } = await import('../lib/codex-homes.js')
const { recordKeyedSession, __resetKeyedSessionsForTests } = await import('../lib/keyed-sessions.js')
const { __resetKeyLanesForTests } = await import('../lib/key-lanes.js')

const KEYED = '019f2222-3333-4444-5555-666666666666'
const CHILD = '019f9999-aaaa-bbbb-cccc-dddddddddddd'

function rollout(home: string, id: string, reply: string): string {
  const day = join(home, 'sessions', '2026', '10', '19')
  mkdirSync(day, { recursive: true })
  const file = join(day, `rollout-2026-10-19T18-00-00-${id}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/repo', timestamp: new Date().toISOString() } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] } })}\n`)
  const now = new Date()
  utimesSync(file, now, now)
  return file
}

let server: ReturnType<express.Express['listen']> | null = null
async function base(): Promise<string> {
  const app = express()
  app.use('/api', agentSessionsRouter)
  server = await new Promise(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)) })
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true }); rmSync(DATA, { recursive: true, force: true })
  mkdirSync(join(HOME, '.codex', 'sessions'), { recursive: true }); mkdirSync(DATA, { recursive: true })
  delete process.env.COS_KEY_LANES
  __resetKeyLanesForTests(); __resetKeyedSessionsForTests()
  const home = codexProfileHome('gpt-key')
  rollout(home, KEYED, 'Keyed reply.')
  const childFile = rollout(home, CHILD, 'Child reply.')
  writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ id: KEYED, thread_name: 'Keyed pricing thread' }) + '\n')
  execFileSync('/usr/bin/sqlite3', [join(home, 'state_5.sqlite'), `CREATE TABLE threads(id TEXT,rollout_path TEXT,archived INT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT); INSERT INTO threads VALUES('${CHILD}','${childFile}',1); INSERT INTO thread_spawn_edges VALUES('${KEYED}','${CHILD}','open');`])
  recordKeyedSession({ id: KEYED, engine: 'codex', profileId: 'gpt-key', cosSessionId: 'cos-1' })
})
afterEach(async () => { if (server) await new Promise<void>(r => server!.close(() => r())); server = null })
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  Object.assign(process.env, saved)
  rmSync(ROOT, { recursive: true, force: true })
})

describe('agent sessions: keyed Codex threads read through codexHomes() (P11)', () => {
  it('lanes on: the detail of a keyed thread has its name and its subagents', async () => {
    process.env.COS_KEY_LANES = '1'
    __resetKeyLanesForTests()
    const res = await fetch(`${await base()}/api/agent-sessions/codex/${KEYED}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.display_label).toBe('Keyed pricing thread')
    expect(body.subagent_activity).toMatchObject({ total: 1, completed: 1 })
  })

  it('lanes on: the list row of a keyed thread carries its subagents', async () => {
    process.env.COS_KEY_LANES = '1'
    __resetKeyLanesForTests()
    const res = await fetch(`${await base()}/api/agent-sessions?limit=50`)
    const body = await res.json() as { sessions: Array<{ session_id: string; subagent_activity?: { total: number } }> }
    const row = body.sessions.find(s => s.session_id === KEYED)
    expect(row?.subagent_activity).toMatchObject({ total: 1 })
  })

  it('lanes off: the profile home is never read (the keyed thread is not found)', async () => {
    const res = await fetch(`${await base()}/api/agent-sessions/codex/${KEYED}`)
    expect(res.status).toBe(404)
  })
})
