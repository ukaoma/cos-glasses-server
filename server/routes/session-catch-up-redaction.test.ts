/**
 * X1 (session catch-up, lead 15:59 condition 2): GET .../catch-up has the same gate and the same redaction as the
 * session detail route, for every caller class, and no caller gets more from it than from detail.
 *
 * The real /api token gate in front of the real detail router and the real bindings router with the real
 * readSessionCatchUpView. Requests over node:http with exactly the headers each caller sends (fixture and helpers
 * mirror agent-sessions-work-match.test.ts, the 7.0.4 W1 native-helper exemption).
 */
import express from 'express'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionsRouter, readSessionCatchUpView } from './agent-sessions.js'
import { createAgentSessionBindingsRouter } from './agent-session-bindings.js'
import { requireApiToken } from '../lib/api-auth.js'
import { mintWebSessionCookieValue, WEB_SESSION_COOKIE_NAME } from '../lib/web-session-auth.js'
import { TurnEndAskTracker, WRAP_UP_TOOL, __setTurnEndAsksForTests } from '../lib/turn-end-ask.js'
import { __resetSessionHooksForTests, __setTurnEndAskTrackerForTests, deriveForRow } from '../lib/session-hooks-runtime.js'
import type { HookEnvelope } from '../lib/session-hook-events.js'

const TOKEN = 'catch-up-redaction-token-0123456789abcd'
const CLAUDE_ID = 'cccccccc-1111-4222-8333-444444444444'
const CWD = '/Users/jane/Documents/GitHub/Acme Chief Of Staff/Repo-One'
const PROMPT = `Read ${CWD}/docs/plan.md and fix the summary in ~/Documents/notes.md. COS Work handoff 0123456789ab.`

const temps: string[] = []
afterAll(() => { for (const p of temps.splice(0)) rmSync(p, { recursive: true, force: true }) })
const closers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())) })
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'cos-catch-up-redact-')); temps.push(home)
  for (const k of ['COS_AGENT_SESSIONS_HOME', 'CODEX_HOME', 'COS_WEB_SESSION_FILES', 'COS_CLAUDE_SESSIONS_ENABLED', 'COS_SESSION_HOOKS']) saved[k] = process.env[k]
  process.env.COS_AGENT_SESSIONS_HOME = home
  process.env.CODEX_HOME = join(home, '.codex')
  const t = (m: number) => `2026-11-14T12:${String(m).padStart(2, '0')}:00.000Z`
  const row = (type: 'user' | 'assistant', m: number, text: string) =>
    ({ type, uuid: `${type[0]}${m}`, timestamp: t(m), cwd: CWD, sessionId: CLAUDE_ID, message: { role: type, content: [{ type: 'text', text }] } })
  const file = join(home, '.claude', 'projects', '-Users-jane-Documents-GitHub-Acme-Chief-Of-Staff-Repo-One', `${CLAUDE_ID}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, [
    row('user', 1, PROMPT),
    row('assistant', 2, `Fixed [plan.md](${CWD}/docs/plan.md#L3). Done.`),
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
})
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })

async function serve(): Promise<number> {
  const app = express()
  app.use('/api', requireApiToken(TOKEN))
  app.use('/api', agentSessionsRouter)
  app.use('/api', createAgentSessionBindingsRouter({
    probes: {} as never,
    dirs: { claudeSessionsDir: '/nonexistent', codexLocksDir: '/nonexistent', cursorChatsDir: '/nonexistent' },
    now: () => Date.now(),
    bindings: { list: () => [], available: () => true },
    attachEnabled: false,
    catchUp: { view: (p, id, opts) => readSessionCatchUpView(p, id, opts), bootId: 'boot-redaction' },
  }))
  const server = await new Promise<ReturnType<typeof app.listen>>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  closers.push(() => new Promise<void>(r => server.close(() => r())))
  return (server.address() as AddressInfo).port
}

interface Turn { role: string; text: string }
function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {}, raw }))
    })
    req.on('error', reject)
    req.end()
  })
}

const DETAIL = `/api/agent-sessions/claude/${CLAUDE_ID}?turns=40`
const CATCH_UP = `/api/agent-sessions/claude/${CLAUDE_ID}/catch-up`
const HELPER = { 'X-COS-Token': TOKEN, 'User-Agent': 'cos-control-helper/0.5.393 CFNetwork/3826 Darwin/27.2.0', Accept: '*/*' }
const BROWSER = { ...HELPER, 'Sec-Fetch-Mode': 'cors', Origin: 'http://127.0.0.1:3141' }
const cookie = () => ({ Cookie: `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue(TOKEN).value}` })
const users = (turns: Turn[]) => turns.filter(t => t.role === 'user').map(t => t.text)

describe('X1 catch-up: the same gate and redaction as detail, for every caller class', () => {
  it('the native Mac helper: detail gives it the user turn as written (7.0.4), catch-up never does', async () => {
    const port = await serve()
    const detail = await get(port, DETAIL, HELPER)
    expect(users(detail.body.recent_turns)[0]).toContain('/Users/jane')
    const catchUp = await get(port, CATCH_UP, HELPER)
    expect(catchUp.status).toBe(200)
    expect(catchUp.raw).not.toContain('/Users/')
    // Exactly the browser's turns: the helper gets no more from catch-up than a browser gets from detail.
    const browserDetail = await get(port, DETAIL, BROWSER)
    expect(catchUp.body.turns).toEqual(browserDetail.body.recent_turns)
  })

  it('a browser with the token, and a Control Web cookie, each get exactly the detail\'s browser turns', async () => {
    const port = await serve()
    const browserDetail = await get(port, DETAIL, BROWSER)
    for (const headers of [BROWSER, cookie(), { ...cookie(), 'X-COS-Token': 'not-the-token' }]) {
      const res = await get(port, CATCH_UP, headers)
      expect(res.status).toBe(200)
      expect(res.raw).not.toContain('/Users/')
      expect(res.body.turns).toEqual(browserDetail.body.recent_turns)
    }
  })

  it('link markers only with cards=1, as on detail, and never a local path either way', async () => {
    const port = await serve()
    const plain = await get(port, CATCH_UP, cookie())
    const withCards = await get(port, `${CATCH_UP}?cards=1`, cookie())
    const detailCards = await get(port, `${DETAIL}&cards=1`, cookie())
    expect(plain.raw).not.toContain('cos-file:')
    expect(withCards.body.turns).toEqual(detailCards.body.recent_turns)
    expect(withCards.raw).not.toContain('/Users/')
  })

  it('no token and no cookie: refused by the gate exactly as detail is', async () => {
    const port = await serve()
    const detail = await get(port, DETAIL, {})
    const catchUp = await get(port, CATCH_UP, {})
    expect(catchUp.status).toBe(detail.status)
    expect(catchUp.status).toBe(401)
    expect(catchUp.body).toEqual(detail.body)
  })
})

describe('X1 catch-up: the view is the detail\'s browser path, previews and all, and its derive changes nothing (Q1 U13, U23)', () => {
  it('previews off (COS_WEB_SESSION_FILES=0): catch-up marks previewsOff and drops the card exactly as detail does', async () => {
    process.env.COS_WEB_SESSION_FILES = '0'
    const port = await serve()
    const detail = await get(port, DETAIL, BROWSER)
    const catchUp = await get(port, CATCH_UP, BROWSER)
    const assistant = (turns: Array<Turn & { previewsOff?: boolean; outputLinks?: unknown[] }>) => turns.find(t => t.role === 'assistant')!
    expect(assistant(detail.body.recent_turns).previewsOff).toBe(true)
    expect(assistant(catchUp.body.turns).previewsOff).toBe(true)
    expect(assistant(catchUp.body.turns).outputLinks).toBeUndefined()
    expect(catchUp.body.turns).toEqual(detail.body.recent_turns)
    // With previews on, the card is there (so the setting is what removed it).
    delete process.env.COS_WEB_SESSION_FILES
    const on = await get(port, `${CATCH_UP}?cards=1`, BROWSER)
    expect(assistant(on.body.turns).previewsOff).toBeUndefined()
  })

  it('the view\'s derive never ages out the session\'s open ask (an observing derive does), whatever the tracker holds', async () => {
    process.env.COS_CLAUDE_SESSIONS_ENABLED = '1'
    delete process.env.COS_SESSION_HOOKS
    __resetSessionHooksForTests()
    __setTurnEndAsksForTests(true)
    const t = Date.now() - 9 * 60 * 60_000   // asked nine hours ago: past the 8 h age-out
    const clock = { now: t + 5_000 }
    const tracker = new TurnEndAskTracker({ now: () => clock.now, enabled: () => true, words: () => true, readDeskIdleSeconds: async () => 300, deskIdleSeconds: () => 90, pollMs: 3_600_000 })
    __setTurnEndAskTrackerForTests(tracker)
    try {
      const env = (event: HookEnvelope['event'], ts: number, payload: Record<string, unknown> = {}): HookEnvelope =>
        ({ ts, ppid: 4242, event, sessionId: CLAUDE_ID, payload: { session_id: CLAUDE_ID, ...payload } })
      tracker.observe(env('UserPromptSubmit', t - 10_000, { prompt: 'go', prompt_id: 'p-cu-1' }), false)
      tracker.observe(env('PostToolUse', t, { tool_name: WRAP_UP_TOOL, prompt_id: 'p-cu-1', tool_input: { recap: 'r', ask: 'Ship it?', actions: [{ label: 'Yes' }] } }), false)
      tracker.observe(env('Stop', t + 1_000, { last_assistant_message: 'done', prompt_id: 'p-cu-1' }), false)
      await tracker.tick()
      const before = tracker.stats()
      expect(before.tracked).toBe(1)
      const view = await readSessionCatchUpView('claude', CLAUDE_ID, { cards: false, turns: 40 })
      expect(view).not.toBeNull()
      expect(tracker.stats()).toEqual(before)
      // The probe can fail: an observing derive of the same row ages it out.
      deriveForRow({ sessionId: CLAUDE_ID, transcript: { inFlight: false, lastActivityAt: null } })
      expect(tracker.stats()).toMatchObject({ tracked: 0, agedOut: before.agedOut + 1 })
    } finally {
      tracker.stop()
      __setTurnEndAskTrackerForTests(null)
      __setTurnEndAsksForTests(null)
      __resetSessionHooksForTests()
    }
  })
})
