// Key lanes K1 P3 (plan v4 7.1, 7.3): a handoff that would resume a keyed CLI session elsewhere
// is refused 409 keyed_session. With nothing keyed, the route answers exactly as before.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ created: [] as any[], claimed: [] as string[], stored: null as any, available: 'cli-sub-0001' as string | undefined }))
vi.mock('../lib/claude-bridge.js', () => ({ getAvailableCliSessionId: () => state.available }))
vi.mock('../lib/codex-run-ledger.js', () => ({ getCodexExecutionCwd: () => '/tmp', getCodexTrustMode: () => 'default' }))
vi.mock('../lib/handoff-store.js', () => ({
  buildHandoffPromptContext: () => 'context',
  createHandoff: vi.fn(async (input: any) => { state.created.push(input); return { code: 'ABCD2345', ...input } }),
  claimHandoff: vi.fn(async (code: string) => { state.claimed.push(code); return state.stored }),
  getHandoff: vi.fn(async () => state.stored),
  getLatestHandoff: vi.fn(async () => null),
}))

const dataDir = mkdtempSync(join(tmpdir(), 'kl-p3-handoffs-'))
process.env.COS_DATA_DIR = dataDir
const { handoffsRouter } = await import('./handoffs.js')
const keyed = await import('../lib/keyed-sessions.js')

let base = ''
let server: Server
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', handoffsRouter)
  server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`
})
afterAll(() => { server?.close(); rmSync(dataDir, { recursive: true, force: true }) })
beforeEach(() => {
  rmSync(keyed.keyedSessionsPath(), { force: true })
  keyed.__resetKeyedSessionsForTests()
  state.created.length = 0; state.claimed.length = 0; state.stored = null; state.available = 'cli-sub-0001'
})

const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('handoffs and keyed sessions', () => {
  it('nothing keyed: create and claim answer as today', async () => {
    const res = await post('/handoffs', { sessionId: 'cos-plain', title: 't' })
    expect(res.status).toBe(201)
    expect(state.created[0].runtime.claude.cliSessionId).toBe('cli-sub-0001')
    state.stored = { code: 'ABCD2345', runtime: { claude: { cliSessionId: 'cli-sub-0001' } } }
    const claim = await post('/handoffs/ABCD2345/claim', { claimedBy: 'g2' })
    expect(claim.status).toBe(200)
    expect(state.claimed).toEqual(['ABCD2345'])
  })

  it('a keyed COS session, a keyed Claude id or a keyed Codex thread is refused 409 and nothing is saved', async () => {
    keyed.recordKeyedSession({ id: 'cli-keyed-0001', engine: 'claude', profileId: 'sonnet-key', cosSessionId: 'cos-keyed' })
    keyed.recordKeyedSession({ id: 'codex-keyed-0001', engine: 'codex', profileId: 'gpt-key' })
    for (const body of [
      { sessionId: 'cos-keyed' },
      { runtime: { claude: { cliSessionId: 'cli-keyed-0001' } } },
      { runtime: { codex: { codexThreadId: 'codex-keyed-0001' } } },
    ]) {
      const res = await post('/handoffs', body)
      expect(res.status, JSON.stringify(body)).toBe(409)
      expect(await res.json()).toEqual({ error: 'keyed_session', message: 'This session ran on your key. Continue it from COS.' })
    }
    // The fallback id itself keyed (a mapping the bridge would not hand out, belt and braces).
    state.available = 'cli-keyed-0001'
    expect((await post('/handoffs', { sessionId: 'cos-other' })).status).toBe(409)
    expect(state.created).toEqual([])
    // A plain one still works while others are keyed.
    state.available = 'cli-sub-0001'
    expect((await post('/handoffs', { sessionId: 'cos-plain' })).status).toBe(201)
  })

  it('a saved handoff whose runtime turned out keyed is not claimed', async () => {
    keyed.recordKeyedSession({ id: 'cli-keyed-0002', engine: 'claude', profileId: 'sonnet-key' })
    state.stored = { code: 'ABCD2345', runtime: { claude: { cliSessionId: 'cli-keyed-0002' } } }
    const res = await post('/handoffs/ABCD2345/claim', { claimedBy: 'g2' })
    expect(res.status).toBe(409)
    expect(state.claimed).toEqual([])
  })
})
