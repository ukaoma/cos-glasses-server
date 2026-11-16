import { createHash } from 'node:crypto'
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
import { combinedIntegrityReport, createWebKeySignerHandler, signerApiAllowed, SIGNER_FONT_MAX_BYTES, SIGNER_PAUSED_PAGE, WEB_SIGNER_CSP } from './web-key-signer-app.js'

const SIGNER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web-signer')
const CONTROL_FONTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'web-control', 'fonts')
const FONTS = ['/fonts/DMSans.ttf', '/fonts/Fraunces.ttf']
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
  for (const name of readdirSync(SIGNER_DIR)) if (!name.endsWith('.test.ts') && !name.startsWith('.')) cpSync(join(SIGNER_DIR, name), join(d, name), { recursive: true })
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

describe("fonts (7.0.51, Miles 07:08: Control Web's DM Sans and Fraunces on the approval page)", () => {
  it('the CSP allows fonts from this origin only: no data:, no other host', () => {
    expect(WEB_SIGNER_CSP).toContain("font-src 'self'")
    expect(WEB_SIGNER_CSP.split('; ').filter(d => d.startsWith('font-src'))).toEqual(["font-src 'self'"])
    expect(WEB_SIGNER_CSP).not.toMatch(/data:|blob:/)
  })
  it('exactly two font files ship, byte-identical to the ones Control Web already serves, each within the bound', () => {
    const manifest = computeWebControlManifest(SIGNER_DIR)
    expect(Object.keys(manifest.files).filter(p => p.startsWith('/fonts/')).sort()).toEqual(FONTS)
    for (const f of FONTS) {
      const mine = readFileSync(join(SIGNER_DIR, f))
      expect(mine.equals(readFileSync(join(CONTROL_FONTS, f.slice('/fonts/'.length)))), f).toBe(true)
      expect(mine.length, f).toBeLessThanOrEqual(SIGNER_FONT_MAX_BYTES)
    }
    expect(SIGNER_FONT_MAX_BYTES).toBe(512 * 1024)
  })
  it('serves each font byte for byte as font/ttf with the strict headers', async () => {
    for (const f of FONTS) {
      const res = await get(f)
      expect(res.status, f).toBe(200)
      expect(res.headers.get('content-type')).toBe('font/ttf')
      expectStrictHeaders(res)
      expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(SIGNER_DIR, f))), f).toBe(true)
    }
  })
  it('a verified font over the bound is never served', async () => {
    const d = copySigner(false)
    try {
      writeFileSync(join(d, 'fonts', 'Big.ttf'), Buffer.alloc(SIGNER_FONT_MAX_BYTES + 1, 1))
      writeFileSync(join(d, 'fonts', 'Edge.ttf'), Buffer.alloc(SIGNER_FONT_MAX_BYTES, 1))
      writeFileSync(join(d, WEB_CONTROL_MANIFEST_FILE), JSON.stringify(computeWebControlManifest(d)))
      integrity = new WebControlIntegrity(d, quiet)
      expect((await get('/fonts/Big.ttf')).status).toBe(404)
      expect((await get('/fonts/Edge.ttf')).status).toBe(200)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  it('svg, woff, woff2, otf and a font with a changed byte are never served', async () => {
    const d = copySigner(false)
    try {
      for (const n of ['x.svg', 'x.woff', 'x.woff2', 'x.otf']) writeFileSync(join(d, 'fonts', n), 'font-ish')
      writeFileSync(join(d, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
      writeFileSync(join(d, WEB_CONTROL_MANIFEST_FILE), JSON.stringify(computeWebControlManifest(d)))
      integrity = new WebControlIntegrity(d, quiet)
      for (const p of ['/fonts/x.svg', '/fonts/x.woff', '/fonts/x.woff2', '/fonts/x.otf', '/logo.svg']) expect((await get(p)).status, p).toBe(404)
      expect((await get('/fonts/DMSans.ttf')).status).toBe(200)
      const bytes = readFileSync(join(d, 'fonts', 'DMSans.ttf')); bytes[100] ^= 1
      writeFileSync(join(d, 'fonts', 'DMSans.ttf'), bytes)
      integrity.check()
      expect((await get('/fonts/DMSans.ttf')).status).toBe(503)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  // Lead 07:25: a passkey page that shows nothing is worse than one in the wrong face. If a font fails to load, the text
  // must still render at once in a system face: every @font-face swaps (never block), and every stack that names DM Sans
  // or Fraunces ends in a generic family.
  function fontFallbackProblems(css: string): string[] {
    const problems: string[] = []
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(m => m[1])
    for (const f of faces) {
      const display = /font-display\s*:\s*([a-z-]+)/.exec(f)?.[1]
      if (display !== 'swap' && display !== 'fallback' && display !== 'optional') problems.push(`@font-face without swap: ${display ?? 'none'}`)
    }
    const rest = css.replace(/@font-face\s*\{[^}]*\}/g, '')
    for (const m of rest.matchAll(/(?:font-family|font|--[a-z-]+)\s*:\s*([^;}]*(?:DM Sans|Fraunces)[^;}]*)/g)) {
      const value = m[1].trim()
      if (!/(?:^|,|\s)(?:sans-serif|serif|system-ui|ui-sans-serif|ui-serif|monospace)\s*(?:!important)?$/.test(value)) problems.push(`no generic fallback: ${value}`)
    }
    return problems
  }
  it('if a font fails to load, text still renders in a system face (swap, and a generic family ends every stack)', () => {
    expect(fontFallbackProblems(readFileSync(join(SIGNER_DIR, 'signer.css'), 'utf8'))).toEqual([])
    // The check itself can fail: each of these must be caught.
    expect(fontFallbackProblems("@font-face { font-family: 'DM Sans'; src: url('/fonts/DMSans.ttf'); font-display: block; }")).toHaveLength(1)
    expect(fontFallbackProblems("@font-face { font-family: 'DM Sans'; src: url('/fonts/DMSans.ttf'); }")).toHaveLength(1)
    expect(fontFallbackProblems(":root { --body: 'DM Sans'; }")).toHaveLength(1)
    expect(fontFallbackProblems("body { font: 400 16px/1.5 'DM Sans', Helvetica; }")).toHaveLength(1)
    expect(fontFallbackProblems("h2 { font-family: 'Fraunces', Georgia, serif; } :root { --body: 'DM Sans', -apple-system, sans-serif; }")).toEqual([])
  })
  it('every url() in signer.css is one of the shipped fonts: no data:, no other origin, no other file', () => {
    const css = readFileSync(join(SIGNER_DIR, 'signer.css'), 'utf8')
    for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/g)) expect(FONTS, m[2]).toContain(m[2])
    expect(css).not.toMatch(/@import|data:/i)
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
    expect(Object.keys(manifest.files).sort()).toEqual([...FONTS, '/index.html', '/signer-proof.js', '/signer-store.js', '/signer.css', '/signer.js'])
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
    expect(combinedIntegrityReport(st(true), st(true))).toEqual({ enabled: true, lastCheckOk: true, checkedAt: 5, manifestSha256: 'a'.repeat(64), signerManifestSha256: 'a'.repeat(64) })
    expect(combinedIntegrityReport(st(true), st(false))?.lastCheckOk).toBe(false)
    expect(combinedIntegrityReport(st(false), st(true))?.lastCheckOk).toBe(false)
    expect(combinedIntegrityReport(st(true), null)?.lastCheckOk).toBe(false)
    expect(combinedIntegrityReport(null, st(true))).toBeNull()
  })

  // X1 G1 (lead 06:5x): the approval page's own manifest hash travels in the report, so a verifier can hold it against
  // the signed Control app's pin. Additive: an older verifier ignores the field.
  it('G1: carries the SIGNER tree\'s manifest hash, never the Control Web one; no signer tree is null', () => {
    const control = { state: { ok: true, error: null, mismatches: [], checkedAt: 5 }, manifestSha256: 'c'.repeat(64) }
    const signer = { state: { ok: true, error: null, mismatches: [], checkedAt: 5 }, manifestSha256: 'e'.repeat(64) }
    const report = combinedIntegrityReport(control, signer)!
    expect(report.manifestSha256).toBe('c'.repeat(64))
    expect(report.signerManifestSha256).toBe('e'.repeat(64))
    expect(combinedIntegrityReport(control, null)!.signerManifestSha256).toBeNull()
    expect(combinedIntegrityReport(control, { ...signer, manifestSha256: null })!.signerManifestSha256).toBeNull()
  })

  it('G1: the hash is the one the served bytes were checked against (read at boot), not the manifest file on disk now', () => {
    const d = copySigner()
    try {
      const signerIntegrity = new WebControlIntegrity(d, quiet)
      signerIntegrity.check()
      const atBoot = createHash('sha256').update(readFileSync(join(d, WEB_CONTROL_MANIFEST_FILE))).digest('hex')
      const control = { state: { ok: true, error: null, mismatches: [], checkedAt: 5 }, manifestSha256: 'c'.repeat(64) }
      expect(combinedIntegrityReport(control, signerIntegrity)!.signerManifestSha256).toBe(atBoot)
      // A manifest rewritten on disk after boot changes nothing that is served (the bytes were checked against the boot
      // manifest), so the report must keep naming the boot manifest, never the file as it is now.
      writeFileSync(join(d, WEB_CONTROL_MANIFEST_FILE), JSON.stringify({ v: 1, algorithm: 'sha256', files: {} }))
      expect(combinedIntegrityReport(control, signerIntegrity)!.signerManifestSha256).toBe(atBoot)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})
