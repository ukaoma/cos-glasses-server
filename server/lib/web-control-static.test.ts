import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'
import {
  IMMUTABLE_CACHE,
  REVALIDATE_CACHE,
  buildWebAssetTable,
  createWebControlStatic,
  pickEncoding,
  rewriteReferences,
} from './web-control-static.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const REAL_DIR = path.join(here, '..', 'web-control')

interface Raw { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
function get(port: number, urlPath: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

// The real install lives under "~/Library/Application Support/COS Control/..." and the managed
// data dir is "~/.cos-glasses": the fixture path carries a space and a dot component on purpose.
let root: string
let dir: string
let server: http.Server
let port: number
let clock = 0

function write(rel: string, text: string): void {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'web static '))
  dir = path.join(root, '.cos-glasses', 'web-control')
  write('index.html', '<link rel="stylesheet" href="/control/app.css"><script src="/control/app.js"></script><script src="/control/missing.js"></script><a href="/control/memories/memories.html">m</a>')
  write('app.css', "@font-face { src: url('/control/fonts/A.ttf') format('truetype'); } body{color:red}")
  write('app.js', 'console.log("hello from the app");'.repeat(200))
  write('fonts/A.ttf', 'FONTDATA'.repeat(100))
  write('memories/memories.html', '<p>memories</p>')
  write('panes/skip.test.ts', 'secret test source')
  const app = express()
  app.use('/control', createWebControlStatic(dir, { now: () => clock }), express.static(dir))
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  port = (server.address() as { port: number }).port
})
afterAll(() => { server?.close(); fs.rmSync(root, { recursive: true, force: true }) })

describe('rewriteReferences', () => {
  it('versions only known assets and leaves everything else exactly as written', () => {
    const hashes = new Map([['/app.js', 'aaaa'], ['/page.html', 'bbbb']])
    expect(rewriteReferences('<script src="/control/app.js"></script>', '/control', hashes)).toBe('<script src="/control/app.js?v=aaaa"></script>')
    expect(rewriteReferences('<script src="/control/gone.js"></script>', '/control', hashes)).toBe('<script src="/control/gone.js"></script>')
    expect(rewriteReferences('<a href="/control/page.html">', '/control', hashes)).toBe('<a href="/control/page.html">')
    expect(rewriteReferences('<script src="/control/app.js?x=1"></script>', '/control', hashes)).toBe('<script src="/control/app.js?x=1"></script>')
    expect(rewriteReferences("url('/control/app.js')", '/control', hashes)).toBe("url('/control/app.js?v=aaaa')")
  })
})

describe('pickEncoding', () => {
  it('prefers brotli, falls back to gzip, honours q=0', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br')
    expect(pickEncoding('gzip')).toBe('gzip')
    expect(pickEncoding('br;q=0, gzip')).toBe('gzip')
    expect(pickEncoding('identity')).toBeNull()
    expect(pickEncoding(undefined)).toBeNull()
    expect(pickEncoding('*')).toBe('br')
  })
})

describe('createWebControlStatic', () => {
  it('serves index.html revalidated, with versioned references to CSS and JS', async () => {
    const r = await get(port, '/control/')
    expect(r.status).toBe(200)
    expect(r.headers['cache-control']).toBe(REVALIDATE_CACHE)
    const html = r.body.toString()
    expect(html).toMatch(/href="\/control\/app\.css\?v=[0-9a-f]{16}"/)
    expect(html).toMatch(/src="\/control\/app\.js\?v=[0-9a-f]{16}"/)
    expect(html).toContain('src="/control/missing.js"')
    expect(html).toContain('href="/control/memories/memories.html"')
  })

  it('caches a matching versioned URL for a year and a stale or missing version not at all', async () => {
    const table = buildWebAssetTable(dir)
    const hash = table.get('/app.js')!.hash
    expect((await get(port, `/control/app.js?v=${hash}`)).headers['cache-control']).toBe(IMMUTABLE_CACHE)
    expect((await get(port, '/control/app.js?v=0000000000000000')).headers['cache-control']).toBe(REVALIDATE_CACHE)
    expect((await get(port, '/control/app.js')).headers['cache-control']).toBe(REVALIDATE_CACHE)
  })

  it('never marks HTML immutable, even with a matching hash', async () => {
    const hash = buildWebAssetTable(dir).get('/memories/memories.html')!.hash
    expect((await get(port, `/control/memories/memories.html?v=${hash}`)).headers['cache-control']).toBe(REVALIDATE_CACHE)
  })

  it('compresses with brotli or gzip, and the bytes decode to the file', async () => {
    const plain = fs.readFileSync(path.join(dir, 'app.js'))
    const br = await get(port, '/control/app.js', { 'Accept-Encoding': 'br, gzip' })
    expect(br.headers['content-encoding']).toBe('br')
    expect(br.headers.vary).toBe('Accept-Encoding')
    expect(zlib.brotliDecompressSync(br.body).equals(plain)).toBe(true)
    expect(br.body.length).toBeLessThan(plain.length)
    const gz = await get(port, '/control/app.js', { 'Accept-Encoding': 'gzip' })
    expect(gz.headers['content-encoding']).toBe('gzip')
    expect(zlib.gunzipSync(gz.body).equals(plain)).toBe(true)
    const none = await get(port, '/control/app.js')
    expect(none.headers['content-encoding']).toBeUndefined()
    expect(none.body.equals(plain)).toBe(true)
    expect(Number(none.headers['content-length'])).toBe(plain.length)
  })

  it('rewrites the font reference in CSS so a font change reaches the page', async () => {
    const css = (await get(port, '/control/app.css')).body.toString()
    const fontHash = buildWebAssetTable(dir).get('/fonts/A.ttf')!.hash
    expect(css).toContain(`url('/control/fonts/A.ttf?v=${fontHash}')`)
  })

  it('answers 304 to a matching ETag, per encoding', async () => {
    const first = await get(port, '/control/app.js', { 'Accept-Encoding': 'gzip' })
    const etag = String(first.headers.etag)
    expect(etag).toMatch(/-gzip"$/)
    expect((await get(port, '/control/app.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': etag })).status).toBe(304)
    // The plain copy has a different tag, so a gzip tag must not 304 a plain request.
    expect((await get(port, '/control/app.js', { 'If-None-Match': etag })).status).toBe(200)
  })

  it('HEAD sends headers and no body', async () => {
    const r = await get(port, '/control/app.js', {}, 'HEAD')
    expect(r.status).toBe(200)
    expect(r.body.length).toBe(0)
    expect(Number(r.headers['content-length'])).toBeGreaterThan(0)
  })

  it('does not serve TypeScript sources from the table', () => {
    expect(buildWebAssetTable(dir).has('/panes/skip.test.ts')).toBe(false)
  })

  it('picks up an edit on disk after the recheck window, with a new hash in index.html', async () => {
    const before = (await get(port, '/control/')).body.toString().match(/app\.js\?v=([0-9a-f]{16})/)![1]
    write('app.js', 'console.log("edited");'.repeat(50))
    // Inside the window the old table still answers.
    expect((await get(port, '/control/')).body.toString()).toContain(`app.js?v=${before}`)
    clock += 1000
    const after = (await get(port, '/control/')).body.toString().match(/app\.js\?v=([0-9a-f]{16})/)![1]
    expect(after).not.toBe(before)
    expect((await get(port, `/control/app.js?v=${after}`)).body.toString()).toContain('edited')
  })
})

describe('the shipped web-control folder', () => {
  const table = buildWebAssetTable(REAL_DIR)
  const html = table.get('/index.html')!.body.toString()

  it('versions every boot script and stylesheet in index.html', () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/control\/[^"]+\.(?:js|css))([^"]*)"/g)]
    expect(refs.length).toBeGreaterThanOrEqual(13)
    for (const [, url, query] of refs) {
      const asset = table.get(url.replace(/^\/control/, ''))
      expect(asset, url).toBeDefined()
      expect(query, url).toBe(`?v=${asset!.hash}`)
    }
  })

  it('versions every pane that loads on demand, and each file registers that pane', () => {
    const block = html.match(/<script type="application\/json" id="lazy-panes">([\s\S]*?)<\/script>/)
    expect(block).not.toBeNull()
    const lazy = JSON.parse(block![1]) as Record<string, string>
    expect(Object.keys(lazy).sort()).toEqual(['dictation', 'meetings', 'memories', 'messages', 'settings', 'speakers', 'threads', 'todayActions', 'work'])
    for (const [pane, url] of Object.entries(lazy)) {
      const m = url.match(/^\/control(\/panes\/[a-z-]+\.js)\?v=([0-9a-f]{16})$/)
      expect(m, url).not.toBeNull()
      const asset = table.get(m![1])!
      expect(asset.hash, url).toBe(m![2])
      expect(asset.body.toString(), pane).toContain(`registerPane('${pane}'`)
      // A pane listed for later loading must not also load at boot.
      expect(html, pane).not.toContain(`src="/control${m![1]}`)
    }
  })

  it('versions every font in the stylesheets', () => {
    const css = table.get('/app.css')!.body.toString()
    const fonts = [...css.matchAll(/url\('(\/control\/fonts\/[^'?]+)\?v=([0-9a-f]{16})'\)/g)]
    expect(fonts.length).toBe(3)
    for (const [, url, hash] of fonts) expect(table.get(url.replace(/^\/control/, ''))!.hash).toBe(hash)
  })
})
