/** Preview engine phase 1: Quick Look thumbnails with a fake runner. The real qlmanage is canaried separately. */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createThumbnailer, THUMB_CACHE_AGE_MS, THUMB_CONCURRENCY, thumbKey, type RunResult } from './preview-thumbs.js'

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
