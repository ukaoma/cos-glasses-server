// 6.50.0: "a failure reading the history costs the history, never the page." QA found no
// test held that promise (removing the route's try/catch left the suite green). The
// reader is mocked to throw; the detail page must still answer 200 without the fields.
import express from 'express'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi, afterAll } from 'vitest'

// Every temp root this file makes is removed when the file ends (6.53.3 /qa W3: the suites
// had left ~150,000 `cos-*` folders in $TMPDIR). Tracked at the mkdtemp call, so a new test
// cannot forget it.
const trackedTempRoots: string[] = []
function trackedTemp<T extends string>(root: T): T {
  trackedTempRoots.push(root)
  return root
}
afterAll(() => {
  for (const root of trackedTempRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* a chmod'ed tree: best effort */ }
  }
})

vi.mock('../lib/agent-session-turns.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agent-session-turns.js')>()
  return { ...actual, readRecentSessionTurns: vi.fn(async () => { throw new Error('EIO: history read failed') }) }
})

const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0)) await close() })

describe('6.50.0: a failed history read', () => {
  it('answers the detail page anyway, without the history fields', async () => {
    const { agentSessionsRouter } = await import('./agent-sessions.js')
    const home = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-turns-failure-')))
    const id = 'aaaaaaaa-bbbb-cccc-dddd-999999999999'
    const file = join(home, '.claude', 'projects', '-repo', `${id}.jsonl`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }) + '\n')
    const previous = process.env.COS_AGENT_SESSIONS_HOME
    process.env.COS_AGENT_SESSIONS_HOME = home
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const app = express()
      app.use('/api', agentSessionsRouter)
      const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
      closers.push(() => new Promise<void>(resolve => server.close(() => resolve())))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const res = await fetch(`${base}/api/agent-sessions/claude/${id}?turns=20`)
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body).not.toHaveProperty('recent_turns')
      expect(body).not.toHaveProperty('recent_turns_more')
      expect(body.first_prompt).toBe('hello')
      expect(warn.mock.calls.some(c => String(c[0]).includes('recent turns failed'))).toBe(true)
    } finally {
      warn.mockRestore()
      if (previous === undefined) delete process.env.COS_AGENT_SESSIONS_HOME
      else process.env.COS_AGENT_SESSIONS_HOME = previous
    }
  })
})
