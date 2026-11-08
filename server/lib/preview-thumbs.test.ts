/** Preview engine phase 1: Quick Look thumbnails with a fake runner. The real qlmanage is canaried separately. */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { createThumbnailer, THUMB_CACHE_AGE_MS, THUMB_CONCURRENCY, THUMB_SIZE, thumbKey, withUtf8Charset, type RunResult } from './preview-thumbs.js'

const made: string[] = []
afterEach(() => { for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true }) })
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)])
const id = (n = 1) => ({ dev: 1, ino: n, size: 10, mtimeMs: 5, ctimeMs: 6 })

function setup(run: (file: string, args: string[]) => Promise<RunResult> | RunResult, now = () => 1_000_000) {
  const top = mkdtempSync(join(tmpdir(), 'cos thumbs-')); made.push(top)
  const calls: Array<{ file: string; args: string[] }> = []
  const t = createThumbnailer({ dir: () => join(top, 'cache'), tmp: () => join(top, 'tmp'), now, run: async (file, args) => { calls.push({ file, args }); return run(file, args) } })
  mkdirSync(join(top, 'tmp'))
  return { top, t, calls }
}
const writeOut = (args: string[], bytes: Buffer) => { const out = args[args.indexOf('-o') + 1]; writeFileSync(join(out, basename(args[args.length - 1]) + '.png'), bytes) }

describe('qlmanage thumbnails', () => {
  it('runs qlmanage -t with an argument array on a private copy named by extension only, then caches by identity', async () => {
    const s = setup((_f, args) => { writeOut(args, PNG); return { code: 0, signal: null, timedOut: false } })
    const got = await s.t.thumbnail(Buffer.from('%PDF'), 'Q3 plan; rm -rf ~.PDF', id())
    expect(got.status).toBe('ok')
    expect(s.calls[0].file).toBe('/usr/bin/nice')
    expect(s.calls[0].args.slice(0, 7)).toEqual(['-n', '10', '/usr/bin/qlmanage', '-t', '-s', '256', '-o'])
    expect(basename(s.calls[0].args[8]), 'no session-written name reaches the command').toBe('preview.pdf')
    expect(dirname(s.calls[0].args[8]).startsWith(join(s.top, 'tmp'))).toBe(true)
    if (got.status === 'ok') expect(basename(got.path)).toBe(thumbKey(id()) + '.png')
    expect(readdirSync(join(s.top, 'tmp')), 'the private copy is gone').toEqual([])
    expect((await s.t.thumbnail(Buffer.from('%PDF'), 'x.pdf', id())).status).toBe('ok')
    expect(s.calls, 'a cache hit runs nothing').toHaveLength(1)
  })
  it('no thumbnail (an honest card) when qlmanage fails, times out, or writes something that is not a PNG', async () => {
    for (const run of [
      () => ({ code: 1, signal: null, timedOut: false }),
      () => ({ code: null, signal: 'SIGKILL', timedOut: true }),
      (_f: string, args: string[]) => { writeOut(args, Buffer.from('<html>not png</html>')); return { code: 0, signal: null, timedOut: false } },
      () => ({ code: 0, signal: null, timedOut: false }),
    ]) {
      const s = setup(run)
      expect((await s.t.thumbnail(Buffer.from('x'), 'a.docx', id())).status).toBe('unavailable')
      expect(existsSync(join(s.top, 'cache', thumbKey(id()) + '.png'))).toBe(false)
    }
  })
  // QA 7.0.5: each failure says why, as a fixed word, so the route can log it (never a path or a file name).
  it('each failure carries a fixed reason: exit, timeout, bad_png, no_png, error_<code>', async () => {
    const cases: Array<[(f: string, args: string[]) => RunResult, string]> = [
      [() => ({ code: 1, signal: null, timedOut: false }), 'exit'],
      [() => ({ code: null, signal: 'SIGKILL', timedOut: true }), 'timeout'],
      [(_f, args) => { writeOut(args, Buffer.from('<html>not png</html>')); return { code: 0, signal: null, timedOut: false } }, 'bad_png'],
      [() => ({ code: 0, signal: null, timedOut: false }), 'no_png'],
      [() => { throw Object.assign(new Error("EACCES: permission denied, open '/Users/x/plan.pdf'"), { code: 'EACCES' }) }, 'error_EACCES'],
    ]
    for (const [run, reason] of cases) {
      const s = setup(run)
      expect(await s.t.thumbnail(Buffer.from('x'), 'plan.pdf', id())).toEqual({ status: 'unavailable', reason })
    }
  })
  it(`at most ${THUMB_CONCURRENCY} at once; the rest are busy`, async () => {
    const waits: Array<() => void> = []
    const s = setup((_f, args) => new Promise(r => waits.push(() => { writeOut(args, PNG); r({ code: 0, signal: null, timedOut: false }) })))
    const a = s.t.thumbnail(Buffer.from('1'), 'a.pdf', id(1)), b = s.t.thumbnail(Buffer.from('2'), 'b.pdf', id(2))
    expect(await s.t.thumbnail(Buffer.from('3'), 'c.pdf', id(3))).toEqual({ status: 'busy' })
    await new Promise(r => setTimeout(r, 5)); waits.forEach(w => w())
    expect((await a).status).toBe('ok'); expect((await b).status).toBe('ok')
  })
  it('an entry older than 7 days is made again, and old entries are evicted', async () => {
    let now = 10 * THUMB_CACHE_AGE_MS
    const s = setup((_f, args) => { writeOut(args, PNG); return { code: 0, signal: null, timedOut: false } }, () => now)
    const first = await s.t.thumbnail(Buffer.from('1'), 'a.pdf', id(1))
    if (first.status !== 'ok') throw new Error('no thumb')
    const old = new Date(now - THUMB_CACHE_AGE_MS - 1000); utimesSync(first.path, old, old)
    await s.t.thumbnail(Buffer.from('2'), 'b.pdf', id(2))
    expect(existsSync(first.path), 'evicted by age').toBe(false)
    await s.t.thumbnail(Buffer.from('1'), 'a.pdf', id(1))
    expect(s.calls).toHaveLength(3)
    expect(statSync(first.path).mtimeMs).toBeGreaterThan(old.getTime())
    now += 1
  })
})

describe('7.0.5 canary 4: an HTML page with no charset thumbnails as UTF-8, not mojibake', () => {
  const META = '<meta charset="utf-8">'
  it('the private copy gets the charset after <head> only when none is declared and the bytes are UTF-8', async () => {
    let copied = ''
    const s = setup((_f, args) => { copied = readFileSync(args[args.length - 1], 'latin1'); writeOut(args, PNG); return { code: 0, signal: null, timedOut: false } })
    const page = Buffer.from('<!doctype html><html><head><title>Café</title></head><body>naïve ✓</body></html>', 'utf8')
    await s.t.thumbnail(page, 'r.html', id(7))
    expect(Buffer.from(copied, 'latin1').toString('utf8')).toBe('<!doctype html><html><head>' + META + '<title>Café</title></head><body>naïve ✓</body></html>')
  })
  it('a declared charset, bytes that are not UTF-8, and a file that is not HTML are copied exactly', () => {
    const declared = Buffer.from('<html><head><meta charset="windows-1252"><p>x</p>')
    expect(withUtf8Charset(declared, 'a.html').equals(declared)).toBe(true)
    const httpEquiv = Buffer.from('<head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">')
    expect(withUtf8Charset(httpEquiv, 'a.htm').equals(httpEquiv)).toBe(true)
    const latin1 = Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])
    expect(withUtf8Charset(latin1, 'a.html').equals(latin1)).toBe(true)
    const md = Buffer.from('# Café')
    expect(withUtf8Charset(md, 'a.md').equals(md)).toBe(true)
    expect(withUtf8Charset(Buffer.from('<p>Café</p>'), 'A.HTML').toString('utf8')).toBe(META + '<p>Café</p>')
  })
  it('the cache key moved to v2, so a mojibake thumbnail cached by 7.0.5 candidates before the fix is drawn again', () => {
    const v1 = createHash('sha256').update(JSON.stringify(['thumb-v1', THUMB_SIZE, 1, 7, 10, 5, 6])).digest('hex')
    expect(thumbKey(id(7))).not.toBe(v1)
    expect(thumbKey(id(7))).toBe(createHash('sha256').update(JSON.stringify(['thumb-v2', THUMB_SIZE, 1, 7, 10, 5, 6])).digest('hex'))
  })
  it('a thumbnail smaller than 256 is fine (Quick Look never upscales): any real PNG is kept', async () => {
    const tiny = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(4, 2)])
    const s = setup((_f, args) => { writeOut(args, tiny); return { code: 0, signal: null, timedOut: false } })
    expect((await s.t.thumbnail(Buffer.from('%PDF'), 'x.pdf', id(9))).status).toBe('ok')
  })
})
