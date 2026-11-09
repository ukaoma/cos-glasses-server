/**
 * 7.0.4 W1: COS Control's Work tracking still recognises a prompt it sent when the prompt opens with a Mac path.
 *
 * Control (0.5.378 and 0.5.379, unchanged) decides a Work prompt ARRIVED by comparing the first 60 letters and digits
 * of its own unredacted prompt with the user turns of `GET /api/agent-sessions/:p/:id?turns=N`, read by its helper over
 * loopback with the X-COS-Token header (WorkProgress.promptKey, HelperSources `session-recent-replies`). S1 redaction
 * turned the path into a base name, so the keys differed. The helper now gets the user turns as written; every browser,
 * phone and proxied request still gets them redacted. Requests go through the real /api token gate and node:http (Node's
 * fetch adds `Sec-Fetch-Mode`, which the helper's URLSession never sends).
 */
import express from 'express'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionsRouter } from './agent-sessions.js'
import { API_AUTH_BY_LOCAL, requireApiToken } from '../lib/api-auth.js'
import { isNativeMacCaller } from '../lib/native-mac-caller.js'
import { mintWebSessionCookieValue, WEB_SESSION_COOKIE_NAME } from '../lib/web-session-auth.js'

const TOKEN = 'work-match-test-token-0123456789abcdef'
const CLAUDE_ID = 'bbbbbbbb-1111-4222-8333-444444444444'
const CWD = '/Users/jane/Documents/GitHub/Acme Chief Of Staff/Repo-One'
/** What Control sent, and still holds unredacted: a Work prompt that opens with a path. */
const PROMPT = `Read ${CWD}/docs/plan.md and fix the summary in ~/Documents/notes.md. COS Work handoff 0123456789ab.`

/** Control's key, mirrored: the first 60 lowercase letters and digits (WorkProgress.swift promptKey). */
const promptKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 60)

const temps: string[] = []
afterAll(() => { for (const p of temps.splice(0)) rmSync(p, { recursive: true, force: true }) })
const closers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())) })
let home = ''
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cos-work-match-')); temps.push(home)
  for (const k of ['COS_AGENT_SESSIONS_HOME', 'CODEX_HOME']) saved[k] = process.env[k]
  process.env.COS_AGENT_SESSIONS_HOME = home
  process.env.CODEX_HOME = join(home, '.codex')
  const t = (m: number) => `2026-11-08T12:${String(m).padStart(2, '0')}:00.000Z`
  const row = (type: 'user' | 'assistant', m: number, text: string) =>
    ({ type, uuid: `${type[0]}${m}`, timestamp: t(m), cwd: CWD, sessionId: CLAUDE_ID, message: { role: type, content: [{ type: 'text', text }] } })
  const file = join(home, '.claude', 'projects', '-Users-jane-Documents-GitHub-Acme-Chief-Of-Staff-Repo-One', `${CLAUDE_ID}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, [
    row('user', 1, PROMPT),
    row('assistant', 2, `Fixed [plan.md](${CWD}/docs/plan.md#L3). COS-WORK 0123456789ab: done - summary fixed`),
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
})
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })

/**
 * The real /api token gate in front of the real router. `remoteAs` makes the socket report another source address
 * (a LAN or tailnet peer, or an IPv4-mapped loopback) before the gate reads it: a test cannot bind those sources.
 */
async function serve(host = '127.0.0.1', remoteAs?: string): Promise<number> {
  const app = express()
  if (remoteAs) app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAs, configurable: true }); next() })
  app.use('/api', requireApiToken(TOKEN))
  app.use('/api', agentSessionsRouter)
  const server = await new Promise<ReturnType<typeof app.listen>>(r => { const s = app.listen(0, host, () => r(s)) })
  closers.push(() => new Promise<void>(r => server.close(() => r())))
  return (server.address() as AddressInfo).port
}

interface Detail { recent_turns?: Array<{ role: string; text: string }>; latest_reply: string; first_prompt: string }
/** One GET with exactly these headers, as URLSession (or a browser) would send them. */
function get(port: number, path: string, headers: Record<string, string>, host = '127.0.0.1'): Promise<{ status: number; body: Detail; raw: string; cache: string; vary: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path, method: 'GET', headers }, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => resolve({
        status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) as Detail : ({} as Detail), raw,
        cache: String(res.headers['cache-control'] ?? ''), vary: String(res.headers.vary ?? ''),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}
const DETAIL = `/api/agent-sessions/claude/${CLAUDE_ID}?turns=6`
const HELPER = { 'X-COS-Token': TOKEN, 'User-Agent': 'cos-control-helper/0.5.379 CFNetwork/3826 Darwin/27.2.0', Accept: '*/*' }
const userText = (d: Detail) => (d.recent_turns ?? []).filter(t => t.role === 'user').map(t => t.text)

describe('W1: the Mac helper matches a Work prompt that opens with a path', () => {
  it('the helper over loopback with its token gets the user turn as written, so Control\'s key matches', async () => {
    const port = await serve()
    const res = await get(port, DETAIL, HELPER)
    expect(res.status).toBe(200)
    const users = userText(res.body)
    expect(users).toHaveLength(1)
    expect(promptKey(users[0]!)).toBe(promptKey(PROMPT))
    // Only the user turns' words: the assistant turn, the reply and the first prompt stay redacted.
    const assistant = (res.body.recent_turns ?? []).filter(t => t.role === 'assistant').map(t => t.text).join('\n')
    expect(assistant).not.toContain('/Users/')
    expect(assistant).toContain('plan.md:3')
    // 7.0.5 QA: the Mac gets the card's words, never a `cos-file:N` marker it cannot render.
    expect(assistant).not.toContain('cos-file:')
    expect(res.body.latest_reply).not.toContain('/Users/')
    expect(res.body.first_prompt).not.toContain('/Users/')
  })

  it('7.0.7: the Mac helper gets card words even if it asks for cards=1 (no Control build draws markers)', async () => {
    const port = await serve()
    const res = await get(port, DETAIL + '&cards=1', HELPER)
    expect(res.status).toBe(200)
    const assistant = (res.body.recent_turns ?? []).filter(t => t.role === 'assistant').map(t => t.text).join('\n')
    expect(assistant).not.toContain('cos-file:')
    expect(assistant).toContain('plan.md:3')
  })

  it('without ?turns= nothing is exempt: the detail carries no recent_turns and no path', async () => {
    const port = await serve()
    const res = await get(port, `/api/agent-sessions/claude/${CLAUDE_ID}`, HELPER)
    expect(res.status).toBe(200)
    expect(res.body.recent_turns).toBeUndefined()
    expect(res.raw).not.toContain('/Users/')
  })

  const redactedCases: Array<[string, Record<string, string>]> = [
    ['a browser fetch (Sec-Fetch-Mode)', { ...HELPER, 'Sec-Fetch-Mode': 'cors' }],
    ['a browser fetch (Sec-Fetch-Site)', { ...HELPER, 'Sec-Fetch-Site': 'same-origin' }],
    ['a page with an Origin', { ...HELPER, Origin: 'http://127.0.0.1:3141' }],
    ['a page with a Referer', { ...HELPER, Referer: 'http://127.0.0.1:3141/control' }],
    ['a browser user agent', { ...HELPER, 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }],
    ['a tailscale serve hop (x-forwarded-for)', { ...HELPER, 'X-Forwarded-For': '100.101.102.103' }],
    ['a tailscale serve hop (tailscale-user-login)', { ...HELPER, 'Tailscale-User-Login': 'someone@example.com' }],
    ['a Forwarded header', { ...HELPER, Forwarded: 'for=100.101.102.103' }],
  ]
  for (const [label, headers] of redactedCases) {
    it(`${label} gets the redacted user turn`, async () => {
      const port = await serve()
      const res = await get(port, DETAIL, headers)
      expect(res.status).toBe(200)
      expect(res.raw).not.toContain('/Users/')
      expect(promptKey(userText(res.body)[0] ?? '')).not.toBe(promptKey(PROMPT))
    })
  }

  it('a Control Web cookie session (no token header, or a wrong one) gets the redacted user turn', async () => {
    const port = await serve()
    const cookie = `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue(TOKEN).value}`
    const cases: Array<Record<string, string>> = [{ Cookie: cookie }, { Cookie: cookie, 'X-COS-Token': 'not-the-token' }]
    for (const headers of cases) {
      const res = await get(port, DETAIL, headers)
      expect(res.status).toBe(200)
      expect(res.raw).not.toContain('/Users/')
    }
  })
})

describe('W1: source addresses, through the real gate', () => {
  it('IPv6 loopback ::1 is this Mac: the user turn as written', async () => {
    const port = await serve('::1')
    const res = await get(port, DETAIL, HELPER, '::1')
    expect(res.status).toBe(200)
    expect(promptKey(userText(res.body)[0] ?? '')).toBe(promptKey(PROMPT))
  })
  it('an IPv4-mapped loopback (::ffff:127.0.0.1, a dual-stack socket) is deliberately this Mac too', async () => {
    const port = await serve('127.0.0.1', '::ffff:127.0.0.1')
    const res = await get(port, DETAIL, HELPER)
    expect(promptKey(userText(res.body)[0] ?? '')).toBe(promptKey(PROMPT))
  })
  for (const [label, address] of [['a LAN peer', '192.168.1.20'], ['a LAN peer, IPv4-mapped', '::ffff:192.168.1.20'], ['a tailnet peer', '100.101.102.103'], ['a tailnet IPv6 peer', 'fd7a:115c:a1e0::1']] as const) {
    it(`${label} with the right token gets the redacted user turn`, async () => {
      const port = await serve('127.0.0.1', address)
      const res = await get(port, DETAIL, HELPER)
      expect(res.status).toBe(200)
      expect(res.raw).not.toContain('/Users/')
      expect(promptKey(userText(res.body)[0] ?? '')).not.toBe(promptKey(PROMPT))
    })
  }
})

describe('W1: caching', () => {
  it('both answers are private, no-store, and vary on every header the choice reads', async () => {
    const port = await serve()
    const original = await get(port, DETAIL, HELPER)
    const redacted = await get(port, DETAIL, { ...HELPER, 'Sec-Fetch-Mode': 'cors' })
    expect(promptKey(userText(original.body)[0] ?? '')).not.toBe(promptKey(userText(redacted.body)[0] ?? ''))
    for (const res of [original, redacted]) {
      expect(res.cache).toBe('private, no-store')
      for (const name of ['Cookie', 'X-COS-Token', 'Origin', 'Referer', 'User-Agent', 'Sec-Fetch-Mode', 'Sec-Fetch-Site', 'Sec-Fetch-Dest']) expect(res.vary).toContain(name)
    }
  })
  it('the original text never leaks into a later redacted answer (each answer is a request-local copy)', async () => {
    const port = await serve()
    await get(port, DETAIL, HELPER)
    const after = await get(port, DETAIL, { Cookie: `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue(TOKEN).value}` })
    expect(after.raw).not.toContain('/Users/')
  })
})

describe('isNativeMacCaller', () => {
  const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers }) as never
  const token = { locals: { [API_AUTH_BY_LOCAL]: 'token' } } as never
  it('needs the gate\'s token mark, a loopback socket and no browser or proxy header', () => {
    expect(isNativeMacCaller(req('127.0.0.1'), token)).toBe(true)
    expect(isNativeMacCaller(req('::1'), token)).toBe(true)
    expect(isNativeMacCaller(req('::ffff:127.0.0.1'), token)).toBe(true)
    expect(isNativeMacCaller(req('127.0.0.1'), { locals: {} } as never)).toBe(false)
    expect(isNativeMacCaller(req('100.101.102.103'), token)).toBe(false)
    expect(isNativeMacCaller(req('192.168.1.20'), token)).toBe(false)
    expect(isNativeMacCaller(req('127.0.0.1', { 'x-real-ip': '100.1.2.3' }), token)).toBe(false)
  })
  it('the gate marks the token door only when the header matched', async () => {
    const gate = requireApiToken(TOKEN)
    const run = (headers: Record<string, string>) => {
      const locals: Record<string, unknown> = {}
      let passed = false
      gate({ method: 'GET', path: '/agent-sessions', headers, socket: { remoteAddress: '127.0.0.1' } } as never,
        { locals, status: () => ({ json: () => undefined }) } as never, () => { passed = true })
      return { passed, by: locals[API_AUTH_BY_LOCAL] }
    }
    expect(run({ 'x-cos-token': TOKEN })).toEqual({ passed: true, by: 'token' })
    expect(run({ cookie: `${WEB_SESSION_COOKIE_NAME}=${mintWebSessionCookieValue(TOKEN).value}` })).toEqual({ passed: true, by: undefined })
    expect(run({ 'x-cos-token': 'wrong' }).by).toBeUndefined()
  })
})
