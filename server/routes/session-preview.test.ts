/** Preview engine phase 1: the preview routes. Fake resolver and thumbnailer; the real router, headers and parts. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionPreviewRouter, partsFor } from './session-preview.js'
import { HTML_RUN_CSP, HTML_SAFE_CSP } from '../lib/preview-content.js'

const ID = 'al_' + 'a'.repeat(64)
const made: string[] = []
afterEach(() => { for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true }) })

function ok(name: string, kind: string, body: string | Buffer, extra: Record<string, unknown> = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  return { status: 'ok' as const, bytes, name, kind, type: 'T', identity: { dev: 1, ino: 2, size: bytes.length, mtimeMs: 3, ctimeMs: 4 }, path: '/never/sent', root: '/never', descriptor: {} as never, ...extra }
}
async function serve(opts: { file?: () => unknown; enabled?: boolean; thumb?: unknown; image?: unknown; folders?: unknown } = {}) {
  const previewFile = vi.fn(async () => (opts.file ? opts.file() : { status: 'not_found' }))
  const previewImage = vi.fn(async () => opts.image ?? { status: 'unavailable' })
  const thumbnail = vi.fn(async () => opts.thumb ?? { status: 'unavailable' })
  const folders = (opts.folders as never) ?? { read: () => ({ folders: ['/h/cos-worktrees'], source: 'settings' }), set: vi.fn(() => ({ ok: true, setting: { folders: ['/h/x'], source: 'settings' } })) }
  const app = express(); app.use(express.json())
  app.use('/api', createSessionPreviewRouter({ previews: { previewFile, previewImage } as never, enabled: () => opts.enabled !== false, thumbs: { thumbnail } as never, folders, home: () => '/h' }))
  const server = app.listen(0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  return { base, previewFile, previewImage, thumbnail, close: () => server.close() }
}
const url = (part: string, q = '') => `/preview/agent-sessions/claude/session/${ID}/content?part=${part}${q}`

describe('preview routes', () => {
  it('previews off answers 403 before anything is read, for meta and every part', async () => {
    const s = await serve({ enabled: false, file: () => ok('a.md', 'markdown', '# a') })
    for (const path of [`/preview/agent-sessions/claude/session/${ID}/meta`, url('raw'), url('text'), url('thumb')]) {
      const r = await fetch(s.base + path)
      expect(r.status, path).toBe(403)
      expect(await r.json()).toEqual({ error: 'previews_off' })
    }
    expect(s.previewFile).not.toHaveBeenCalled()
    s.close()
  })
  it('meta lists the parts for the kind and never a path', async () => {
    const s = await serve({ file: () => ok('PLAN.md', 'markdown', '# Plan', { line: 3 }) })
    const r = await fetch(s.base + `/preview/agent-sessions/claude/session/${ID}/meta`)
    const body = await r.json()
    expect(body).toEqual({ id: ID, name: 'PLAN.md', kind: 'markdown', type: 'T', size: 6, line: 3, state: 'available', parts: ['raw', 'text'] })
    expect(JSON.stringify(body)).not.toContain('/never')
    s.close()
  })
  it('refusals: unknown provider, not found, blocked, too large, folder, a part the kind lacks, a bad part', async () => {
    const cases: Array<[unknown, string, number, string]> = [
      [{ status: 'not_found' }, url('raw'), 404, 'preview_not_found'],
      [{ status: 'secret' }, url('raw'), 403, 'secret_file_denied'],
      [{ status: 'too_large' }, url('raw'), 413, 'preview_too_large'],
      [{ status: 'folder' }, url('raw'), 404, 'preview_folder'],
      [ok('a.md', 'markdown', 'x'), url('table'), 400, 'preview_part'],
      [ok('a.md', 'markdown', 'x'), url('html-run'), 400, 'preview_part'],
      [ok('a.md', 'markdown', 'x'), url('nope'), 400, 'preview_part'],
    ]
    for (const [file, path, code, error] of cases) {
      const s = await serve({ file: () => file })
      const r = await fetch(s.base + path)
      expect(r.status, path + ' ' + JSON.stringify(file).slice(0, 40)).toBe(code)
      expect((await r.json()).error).toBe(error)
      s.close()
    }
    const s = await serve({ file: () => ok('a.md', 'markdown', 'x') })
    expect((await fetch(s.base + `/preview/agent-sessions/nope/session/${ID}/content?part=raw`)).status).toBe(404)
    s.close()
  })
  it('raw is an octet-stream attachment; an HTML file is never served as a page by raw', async () => {
    const s = await serve({ file: () => ok('r.html', 'html', '<script>x</script>') })
    const r = await fetch(s.base + url('raw'))
    expect(r.headers.get('content-type')).toBe('application/octet-stream')
    expect(r.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(r.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    s.close()
  })
  it('html is sandboxed with no scripts and no network; html-run runs scripts in an opaque origin with no network', async () => {
    const s = await serve({ file: () => ok('r.html', 'html', '<h1>r</h1><script>1</script>') })
    const safe = await fetch(s.base + url('html'))
    expect(safe.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(safe.headers.get('content-security-policy')).toBe(HTML_SAFE_CSP)
    expect(await safe.text()).toBe('<h1>r</h1><script>1</script>')
    const run = await fetch(s.base + url('html-run'))
    expect(run.headers.get('content-security-policy')).toBe(HTML_RUN_CSP)
    expect(run.headers.get('x-content-type-options')).toBe('nosniff')
    s.close()
  })
  it('HTML is shown full length: past 512 KiB, up to 8 MiB', async () => {
    const big = '<p>' + 'x'.repeat(700 * 1024) + '</p>'
    const s = await serve({ file: () => ok('big.html', 'html', big) })
    expect((await (await fetch(s.base + url('html'))).text()).length).toBe(big.length)
    const t = await (await fetch(s.base + url('text', '&limit=99999999'))).json()
    expect(t.text.length).toBe(big.length)
    s.close()
  })
  it('text windows with line; table pages; a binary file is refused as words', async () => {
    let s = await serve({ file: () => ok('a.ts', 'code', 'line1\nline2\n', { line: 2 }) })
    const t = await (await fetch(s.base + url('text'))).json()
    expect(t).toEqual({ text: 'line1\nline2\n', offset: 0, end: 12, size: 12, more: false, line: 2 })
    s.close()
    s = await serve({ file: () => ok('d.csv', 'table', 'a,b\n1,2\n') })
    const tb = await (await fetch(s.base + url('table'))).json()
    expect(tb).toMatchObject({ header: ['a', 'b'], rows: [['1', '2']], more: false })
    s.close()
    s = await serve({ file: () => ok('a.txt', 'text', Buffer.from([0x61, 0, 0x62])) })
    expect((await fetch(s.base + url('text'))).status).toBe(415)
    s.close()
  })
  it('a PDF opens inline as a PDF; its thumbnail is a PNG, and no thumbnail is an honest 503', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-thumb-')); made.push(dir)
    const png = join(dir, 't.png'); writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    let s = await serve({ file: () => ok('r.pdf', 'pdf', '%PDF-1.7'), thumb: { status: 'ok', path: png } })
    const inline = await fetch(s.base + url('inline'))
    expect(inline.headers.get('content-type')).toBe('application/pdf')
    expect(inline.headers.get('content-disposition')).toMatch(/^inline;/)
    const th = await fetch(s.base + url('thumb'))
    expect(th.status).toBe(200)
    expect(th.headers.get('content-type')).toBe('image/png')
    expect(th.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    s.close()
    s = await serve({ file: () => ok('r.pdf', 'pdf', '%PDF-1.7') })
    const none = await fetch(s.base + url('thumb'))
    expect(none.status).toBe(503)
    expect(await none.json()).toEqual({ error: 'thumb_unavailable' })
    s.close()
  })
  it('a linked picture goes through the normalizer as a JPEG', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cos-img-')); made.push(dir)
    const jpg = join(dir, 'n.jpg'); writeFileSync(jpg, 'jpeg')
    const s = await serve({ file: () => ok('shot.png', 'image', 'png'), image: { status: 'ok', path: jpg, mime: 'image/jpeg', bytes: 4 } })
    const r = await fetch(s.base + url('inline'))
    expect(r.headers.get('content-type')).toBe('image/jpeg')
    expect(s.previewImage).toHaveBeenCalledWith('claude', 'session', ID, 'phone')
    s.close()
  })
  it('folder settings: ~/ display, refusals name the folder', async () => {
    const set = vi.fn(() => ({ ok: false, errors: [{ index: 0, code: 'broad', message: 'That folder is too broad. Name a project folder inside it.' }] }))
    const s = await serve({ folders: { read: () => ({ folders: ['/h/cos-worktrees', '/Volumes/W'], source: 'settings' }), set } })
    expect(await (await fetch(s.base + '/preview-folders/settings')).json()).toEqual({ folders: ['~/cos-worktrees', '/Volumes/W'], source: 'settings' })
    const bad = await fetch(s.base + '/preview-folders/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: ['~/Documents'] }) })
    expect(bad.status).toBe(400)
    expect((await bad.json()).errors[0].code).toBe('broad')
    const shape = await fetch(s.base + '/preview-folders/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: '~/x', extra: 1 }) })
    expect(shape.status).toBe(400)
    s.close()
  })
  it('partsFor', () => {
    expect(partsFor('pdf', 'a.pdf')).toEqual(['raw', 'inline', 'thumb'])
    expect(partsFor('html', 'a.html')).toEqual(['raw', 'text', 'html', 'html-run', 'thumb'])
    expect(partsFor('table', 'a.csv')).toEqual(['raw', 'text', 'table'])
    expect(partsFor('image', 'a.gif')).toEqual(['raw'])
    expect(partsFor('image', 'a.png')).toEqual(['raw', 'inline', 'thumb'])
    expect(partsFor('folder', 'x')).toEqual([])
    expect(partsFor('sheet', 'a.xlsx')).toEqual(['raw', 'thumb'])
  })
})
