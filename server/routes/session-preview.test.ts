/** Preview engine phase 1: the preview routes. Fake resolver and thumbnailer; the real router, headers and parts. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionPreviewRouter, logPreviewRefusal, partsFor } from './session-preview.js'
import { resetPreviewLogThrottle } from '../lib/preview-log-throttle.js'
import { HTML_RUN_CSP, HTML_RUN_META_CSP, HTML_RUN_RTC_GUARD, HTML_SAFE_CSP, HTML_SAFE_META_CSP } from '../lib/preview-content.js'

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
      [{ status: 'busy' }, url('raw'), 503, 'previews_busy'],
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
  it('html is sandboxed with no scripts and no fetches; html-run runs scripts in an opaque origin with no fetches and the WebRTC guard first', async () => {
    const s = await serve({ file: () => ok('r.html', 'html', '<h1>r</h1><script>1</script>') })
    const safe = await fetch(s.base + url('html'))
    expect(safe.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(safe.headers.get('content-security-policy')).toBe(HTML_SAFE_CSP)
    // PLAN 6: the policy is also the first tag in the page, before anything in it can load.
    expect(await safe.text()).toBe(`<meta http-equiv="Content-Security-Policy" content="${HTML_SAFE_META_CSP}"><h1>r</h1><script>1</script>`)
    const run = await fetch(s.base + url('html-run'))
    expect(run.headers.get('content-security-policy')).toBe(HTML_RUN_CSP)
    expect(run.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await run.text()).toBe(`<meta http-equiv="Content-Security-Policy" content="${HTML_RUN_META_CSP}">${HTML_RUN_RTC_GUARD}<h1>r</h1><script>1</script>`)
    s.close()
  })
  it('HTML is shown full length: past 8 MiB in one page; its source is windowed at 512 KiB like any text', async () => {
    const big = '<!doctype html><p>' + 'x'.repeat(9 * 1024 * 1024) + '</p>'
    const s = await serve({ file: () => ok('big.html', 'html', big) })
    const page = await (await fetch(s.base + url('html'))).text()
    expect(page.length).toBe(big.length + `<meta http-equiv="Content-Security-Policy" content="${HTML_SAFE_META_CSP}">`.length)
    expect(page.endsWith('x</p>')).toBe(true)
    const t = await (await fetch(s.base + url('text', '&limit=99999999'))).json()
    expect(t.text.length).toBe(512 * 1024)
    expect(t.more).toBe(true)
    s.close()
  })
  it('an HTML page over 32 MiB is refused, never cut', async () => {
    const s = await serve({ file: () => ok('huge.html', 'html', Buffer.alloc(32 * 1024 * 1024 + 1, 0x78)) })
    const r = await fetch(s.base + url('html'))
    expect(r.status).toBe(413)
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

describe('7.0.4 QA busy answer on the preview routes', () => {
  it('a busy read and a busy thumbnail answer 503 previews_busy with Retry-After', async () => {
    const s = await serve({ file: () => ({ status: 'busy' }) })
    const r = await fetch(s.base + url('text'))
    expect([r.status, r.headers.get('retry-after'), (await r.json()).error]).toEqual([503, '2', 'previews_busy'])
    s.close()
    const t = await serve({ file: () => ok('r.pdf', 'pdf', '%PDF'), thumb: { status: 'busy' } })
    const rt = await fetch(t.base + url('thumb'))
    expect([rt.status, rt.headers.get('retry-after'), (await rt.json()).error]).toEqual([503, '2', 'previews_busy'])
    t.close()
  })
})

// QA 7.0.5 (agent 3 C-W4, agent 4 C-W3): every refusal or failure on the preview routes logs one line with a stable
// reason code and the provider, part and kind. Never a path, a file name, an id or a session's words.
describe('7.0.5 QA: preview refusals and failures are logged, with no path', () => {
  const PATHY = '/Users/someone/secret/plan.md'
  async function logged(opts: Parameters<typeof serve>[0], path: string) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetPreviewLogThrottle()
    try {
      const s = await serve(opts)
      const r = await fetch(s.base + path)
      await r.text()
      s.close()
      return { status: r.status, lines: warn.mock.calls.map(c => c.map(String).join(' ')) }
    } finally { warn.mockRestore() }
  }
  const pathError = () => Object.assign(new Error(`ENOENT: no such file or directory, open '${PATHY}'`), { code: 'ENOENT' })
  const meta = `/preview/agent-sessions/claude/session/${ID}/meta`
  const cases: Array<[string, Parameters<typeof serve>[0], string, number, string]> = [
    ['previews off', { enabled: false }, url('raw'), 403, '[preview] content refused reason=previews_off provider=claude'],
    ['a secret', { file: () => ({ status: 'secret' }) }, url('raw'), 403, '[preview] content refused reason=secret_file_denied provider=claude part=raw'],
    ['busy', { file: () => ({ status: 'busy' }) }, url('text'), 503, '[preview] content refused reason=previews_busy provider=claude part=text'],
    ['too large', { file: () => ({ status: 'too_large' }) }, meta, 413, '[preview] meta refused reason=preview_too_large provider=claude'],
    ['the resolver failed', { file: () => ({ status: 'unavailable', reason: 'error_ENOENT' }) }, meta, 503, '[preview] meta refused reason=preview_unavailable provider=claude detail=error_ENOENT'],
    ['meta threw', { file: () => { throw pathError() } }, meta, 503, '[preview] meta refused reason=preview_unavailable provider=claude detail=error_ENOENT'],
    ['content threw', { file: () => { throw pathError() } }, url('text'), 503, '[preview] content refused reason=preview_unavailable provider=claude part=text detail=error_ENOENT'],
    ['a bad part', { file: () => ok('plan.md', 'markdown', 'x') }, url('table'), 400, '[preview] content refused reason=preview_part provider=claude part=table kind=markdown'],
    ['binary', { file: () => ok('plan.md', 'markdown', Buffer.from([0, 1, 2, 0])) }, url('text'), 415, '[preview] content refused reason=preview_binary provider=claude part=text kind=markdown'],
    ['no thumbnail', { file: () => ok('plan.pdf', 'pdf', '%PDF'), thumb: { status: 'unavailable', reason: 'timeout' } }, url('thumb'), 503, '[preview] content refused reason=thumb_unavailable provider=claude part=thumb kind=pdf detail=timeout'],
    ['a picture that failed', { file: () => ok('shot.png', 'image', 'x'), image: { status: 'unavailable', reason: 'error_EACCES' } }, url('inline'), 503, '[preview] content refused reason=preview_unavailable provider=claude part=inline kind=image detail=error_EACCES'],
  ]
  for (const [name, opts, path, code, line] of cases) {
    it(name + ': one line, with its code', async () => {
      const r = await logged(opts, path)
      expect(r.status).toBe(code)
      expect(r.lines).toEqual([line])
      for (const l of r.lines) {
        expect(l).not.toContain('/Users')
        expect(l).not.toContain('plan.')
        expect(l).not.toContain('shot.')
        expect(l).not.toContain(ID)
        expect(l).not.toContain('session')
      }
    })
  }
  it('a missing id is ordinary and is not logged; a success logs nothing', async () => {
    expect((await logged({ file: () => ({ status: 'not_found' }) }, url('raw'))).lines).toEqual([])
    expect((await logged({ file: () => ok('plan.md', 'markdown', '# a') }, url('text'))).lines).toEqual([])
  })
  // 7.0.7 (final QA N1): the 7.0.4 routes' limiter, shared. A page of busy thumbnails is one line, then the count.
  it('a burst of one line logs once per 10 seconds, with the count it held back; a different line is not held back', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetPreviewLogThrottle()
    try {
      const busy = { route: 'content' as const, provider: 'claude', part: 'thumb', kind: 'pdf' as const }
      for (let i = 0; i < 5; i++) logPreviewRefusal(busy, 'previews_busy', 1_000 + i)
      logPreviewRefusal({ ...busy, kind: 'html' as const }, 'previews_busy', 1_010)
      logPreviewRefusal(busy, 'previews_busy', 12_000)
      expect(warn.mock.calls.map(c => c.join(' '))).toEqual([
        '[preview] content refused reason=previews_busy provider=claude part=thumb kind=pdf',
        '[preview] content refused reason=previews_busy provider=claude part=thumb kind=html',
        '[preview] content refused reason=previews_busy provider=claude part=thumb kind=pdf (+4 like it)',
      ])
    } finally { warn.mockRestore() }
  })
  it('a burst through the routes: 6 busy thumbnails in a row log one line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetPreviewLogThrottle()
    try {
      const s = await serve({ file: () => ({ status: 'busy' }) })
      for (let i = 0; i < 6; i++) { const r = await fetch(s.base + url('thumb')); expect(r.status).toBe(503); await r.text() }
      s.close()
      expect(warn.mock.calls.map(c => c.join(' '))).toEqual(['[preview] content refused reason=previews_busy provider=claude part=thumb'])
    } finally { warn.mockRestore() }
  })
  it('the limiter is the 7.0.4 one, not a second copy', () => {
    const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
    expect(src('./session-preview.ts')).toContain("import { warnPreviewThrottled } from '../lib/preview-log-throttle.js'")
    expect(src('./agent-sessions.ts')).toContain('warnPreviewThrottled(kind + ')
    for (const f of ['./session-preview.ts', './agent-sessions.ts']) expect(src(f)).not.toMatch(/new Map<string, \{ at: number; quiet: number \}>/)
  })
  it('a detail that is not a plain word is never written', async () => {
    const r = await logged({ file: () => ({ status: 'unavailable', reason: PATHY }) }, meta)
    expect(r.lines).toEqual(['[preview] meta refused reason=preview_unavailable provider=claude'])
  })
})
