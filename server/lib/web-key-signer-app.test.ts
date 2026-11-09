// 6.99.31 Phase 3: what the 3144 signer listener serves (lib/web-key-signer-app.ts), over a real HTTP
// listener: the strict headers on every answer, only manifest-verified signer bytes, and an /api
// allowlist that keeps every other app route (transcripts, meetings, memories) off this origin.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeWebControlManifest, WEB_CONTROL_MANIFEST_FILE, WebControlIntegrity } from './web-control-integrity.js'
import { combinedIntegrityReport, createWebKeySignerHandler, signerApiAllowed, SIGNER_PAUSED_PAGE, WEB_SIGNER_CSP } from './web-key-signer-app.js'

const SIGNER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web-signer')
const ORIGIN = 'https://ukaoma-mac-studio.tail38457f.ts.net:3144'
const BIG_APP = 'https://ukaoma-mac-studio.tail38457f.ts.net:3143'

let dir: string
let server: Server
let base: string
let integrity: WebControlIntegrity | null
let apiCalls: string[]
const quiet = { log: () => {} }

function copySigner(withManifest = true): string {
  const d = mkdtempSync(join(tmpdir(), 'web-signer-'))
  for (const name of readdirSync(SIGNER_DIR)) if (!name.endsWith('.test.ts') && !name.startsWith('.')) cpSync(join(SIGNER_DIR, name), join(d, name))
  if (withManifest) writeFileSync(join(d, WEB_CONTROL_MANIFEST_FILE), JSON.stringify(computeWebControlManifest(d)))
  return d
}

beforeAll(async () => {
  dir = copySigner()
  integrity = new WebControlIntegrity(dir, quiet)
  apiCalls = []
  // The integrity in use is swapped per test through this indirection.
  server = createServer((req, res) => createWebKeySignerHandler({ integrity, recheckMs: 0, origin: () => ORIGIN, api: (q, s) => { apiCalls.push(`${q.method} ${q.url}`); s.statusCode = 200; s.end('{"ok":true}') } })(req, res))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }) })
afterEach(() => { apiCalls = []; integrity = new WebControlIntegrity(dir, quiet) })

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') => fetch(base + path, { method, headers })

function expectStrictHeaders(res: Response): void {
  expect(res.headers.get('content-security-policy')).toBe(WEB_SIGNER_CSP)
  expect(res.headers.get('x-frame-options')).toBe('DENY')
  expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin')
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  expect(res.headers.get('cache-control')).toBe('no-store')
}

describe('headers', () => {
  it('the CSP forbids framing, inline script and inline style, and names only this origin', () => {
    expect(WEB_SIGNER_CSP).toContain("frame-ancestors 'none'")
    expect(WEB_SIGNER_CSP).toContain("script-src 'self'")
    expect(WEB_SIGNER_CSP).toContain("style-src 'self'")
    expect(WEB_SIGNER_CSP).toContain("default-src 'none'")
    expect(WEB_SIGNER_CSP).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/)
  })
  it('on the page, on an API answer, on a 404 and on the paused page', async () => {
    expectStrictHeaders(await get('/'))
    expectStrictHeaders(await get('/api/web-key/status'))
    expectStrictHeaders(await get('/nope.js'))
    integrity = null
    expectStrictHeaders(await get('/'))
  })
})

describe('the page: verified bytes only', () => {
  it('serves index.html at / and its assets, byte for byte', async () => {
    const res = await get('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toBe(readFileSync(join(SIGNER_DIR, 'index.html'), 'utf8'))
    for (const f of ['signer.js', 'signer-proof.js', 'signer-store.js', 'signer.css']) {
      const a = await get('/' + f)
      expect(a.status, f).toBe(200)
      expect(await a.text()).toBe(readFileSync(join(SIGNER_DIR, f), 'utf8'))
    }
  })
  it('index.html has no inline script, no inline style, no handler attributes; every reference is in the manifest', () => {
    const html = readFileSync(join(SIGNER_DIR, 'index.html'), 'utf8')
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    expect(scripts.length).toBe(3)
    for (const s of scripts) { expect(s[1]).toMatch(/\ssrc="\/[a-z-]+\.js"/); expect(s[2]).toBe('') }
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=|javascript:|<iframe|<form/i)
    const manifest = computeWebControlManifest(SIGNER_DIR)
    for (const m of html.matchAll(/(?:src|href)="(\/[a-z.-]+)"/g)) expect(Object.keys(manifest.files)).toContain(m[1])
    // Nothing else in the signer directory is served from the page.
    expect(Object.keys(manifest.files).sort()).toEqual(['/index.html', '/signer-proof.js', '/signer-store.js', '/signer.css', '/signer.js'])
  })
  it('a shipped file of another type is never served, even when verified', async () => {
    const d = copySigner(false)
    try {
      writeFileSync(join(d, 'notes.md'), 'not a page asset')
      writeFileSync(join(d, WEB_CONTROL_MANIFEST_FILE), JSON.stringify(computeWebControlManifest(d)))
      integrity = new WebControlIntegrity(d, quiet)
      expect((await get('/')).status).toBe(200)
      expect((await get('/notes.md')).status).toBe(404)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  it('a changed file pauses the page (503) once the check runs; nothing falls through to disk', async () => {
    const d = copySigner()
    try {
      integrity = new WebControlIntegrity(d, quiet)
      expect((await get('/')).status).toBe(200)
      writeFileSync(join(d, 'signer.js'), readFileSync(join(d, 'signer.js'), 'utf8') + '\n// changed')
      integrity.check()
      const res = await get('/signer.js')
      expect(res.status).toBe(503)
      expect(await res.text()).toBe(SIGNER_PAUSED_PAGE)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  it('no manifest, or no integrity check at all: paused, never served from disk', async () => {
    const d = copySigner(false)
    try {
      integrity = new WebControlIntegrity(d, quiet)
      expect((await get('/')).status).toBe(503)
      integrity = null
      expect((await get('/')).status).toBe(503)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  it('the big app is not here: /control/, app.js and unknown types are 404; writes to a page path are 405', async () => {
    expect((await get('/control/')).status).toBe(404)
    expect((await get('/app.js')).status).toBe(404)
    expect((await get('/.manifest.json')).status).toBe(404)
    expect((await get('/', {}, 'POST')).status).toBe(405)
  })
})

describe('the /api allowlist', () => {
  it('forwards the signer routes', async () => {
    expect((await get('/api/web-key/status')).status).toBe(200)
    expect((await get('/api/web-key/nonce', { Origin: ORIGIN }, 'POST')).status).toBe(200)
    expect((await get('/api/web-key/handoff/claim', { Origin: ORIGIN }, 'POST')).status).toBe(200)
    expect((await get('/api/agent-sessions/bindings/b-1/turns', { Origin: ORIGIN }, 'POST')).status).toBe(200)
    expect((await get('/api/agent-sessions/bindings/b-1/turns/turn-web-key-0001')).status).toBe(200)
    expect(apiCalls).toEqual(['GET /api/web-key/status', 'POST /api/web-key/nonce', 'POST /api/web-key/handoff/claim', 'POST /api/agent-sessions/bindings/b-1/turns', 'GET /api/agent-sessions/bindings/b-1/turns/turn-web-key-0001'])
  })
  it('every other app route is 404 on this origin and never reaches the app', async () => {
    for (const [p, m] of [['/api/agent-sessions/claude/abc', 'GET'], ['/api/archive', 'GET'], ['/api/health', 'GET'], ['/api/web-key/handoff', 'POST'],
      ['/api/web-key/enroll/pending', 'GET'], ['/api/web-key/enroll/approve', 'POST'], ['/api/web-key/anchor', 'POST'], ['/api/web-key/revoke-all', 'POST'], ['/api/web-key/nonce', 'PUT'],
      ['/api/agent-sessions/bindings/b-1/turns', 'GET']] as const) {
      const res = await get(p, { Origin: ORIGIN }, m)
      expect(res.status, `${m} ${p}`).toBe(404)
    }
    expect(apiCalls).toEqual([])
  })
  it('another origin cannot drive this API; a write must name this origin', async () => {
    expect((await get('/api/web-key/status', { Origin: BIG_APP })).status).toBe(403)
    expect((await get('/api/web-key/nonce', { Origin: BIG_APP }, 'POST')).status).toBe(403)
    expect((await get('/api/web-key/nonce', {}, 'POST')).status).toBe(403)
    expect((await get('/api/web-key/nonce', { Origin: 'null' }, 'POST')).status).toBe(403)
    expect(apiCalls).toEqual([])
  })
  it('signerApiAllowed is exact (no prefix match, no other method)', () => {
    expect(signerApiAllowed('POST', '/api/web-key/nonce')).toBe(true)
    expect(signerApiAllowed('POST', '/api/web-key/nonce/x')).toBe(false)
    expect(signerApiAllowed('GET', '/api/web-key/nonce')).toBe(false)
    expect(signerApiAllowed('POST', '/api/agent-sessions/bindings/b-1/turns/../../x')).toBe(false)
  })
})

describe('combinedIntegrityReport (review W1 with the signer)', () => {
  const st = (ok: boolean) => ({ state: { ok, error: null, mismatches: [], checkedAt: 5 }, manifestSha256: 'a'.repeat(64) })
  it('passes only when both trees pass; Control Web integrity off is null as before', () => {
    expect(combinedIntegrityReport(st(true), st(true))).toEqual({ enabled: true, lastCheckOk: true, checkedAt: 5, manifestSha256: 'a'.repeat(64) })
    expect(combinedIntegrityReport(st(true), st(false))?.lastCheckOk).toBe(false)
    expect(combinedIntegrityReport(st(false), st(true))?.lastCheckOk).toBe(false)
    expect(combinedIntegrityReport(st(true), null)?.lastCheckOk).toBe(false)
    expect(combinedIntegrityReport(null, st(true))).toBeNull()
  })
})
