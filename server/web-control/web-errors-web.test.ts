/**
 * Page errors (lead 08:31, 11/11): a script error or an unhandled rejection in Control Web becomes one bounded row,
 * event web.error, with codes and places only and never a message, a stack or any text. These run app.js's own text
 * against a fake window and api.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
function slice(text: string, start: string, end: string): string {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length)
  expect(a, start).toBeGreaterThan(-1)
  expect(b, end).toBeGreaterThan(a)
  return text.slice(a, b)
}
const SRC = slice(APP, '  // Page errors (lead 08:31, 11/11)', '  // ── the shared kit for pane modules')

function kit(pane = 'sessions') {
  const listeners: Record<string, (e: any) => void> = {}, posts: any[] = []
  const window: any = { addEventListener: (t: string, fn: (e: any) => void) => { listeners[t] = fn } }
  const api = (path: string, opts: any) => { posts.push({ path, body: opts.body }); return Promise.resolve({}) }
  // eslint-disable-next-line no-new-func
  const k = new Function('deps', `with (deps) {\n${SRC}\nreturn { row: webErrorRow, MAX: WEB_ERR_MAX };\n}`)({ window, api, state: { pane }, Date })
  return { k, listeners, posts }
}
const SECRET = 'Miles typed this secret sentence'

describe('web.error rows: codes and places, never text', () => {
  it('a script error: kind, class, the file name, line, column and pane; no message or stack', () => {
    const h = kit()
    const err = Object.assign(new TypeError(SECRET), { stack: 'at ' + SECRET })
    h.listeners.error({ error: err, filename: 'https://mac.tail/control/app.js?v=7#x', lineno: 3120, colno: 17 })
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0].path).toBe('/api/diag/client')
    expect(h.posts[0].body).toMatchObject({ level: 'error', event: 'web.error' })
    expect(h.posts[0].body.data).toEqual({ kind: 'error', cls: 'TypeError', code: '', status: null, src: 'app.js', line: 3120, col: 17, pane: 'sessions', n: 1 })
    expect(JSON.stringify(h.posts[0])).not.toContain('secret')
  })
  it('an unhandled rejection from an api call: its code and HTTP status, still no message', () => {
    const h = kit('today')
    h.listeners.unhandledrejection({ reason: Object.assign(new Error(SECRET), { code: 'timeout', status: 503 }) })
    expect(h.posts[0].body.data).toEqual({ kind: 'rejection', cls: 'Error', code: 'timeout', status: 503, src: '', line: 0, col: 0, pane: 'today', n: 1 })
    expect(JSON.stringify(h.posts[0])).not.toContain('secret')
  })
  it('a rejection with a plain string or nothing: its type only, never the string', () => {
    const h = kit()
    h.listeners.unhandledrejection({ reason: SECRET })
    h.listeners.unhandledrejection({ reason: undefined })
    expect(h.posts.map(p => p.body.data.cls)).toEqual(['string', 'none'])
    expect(JSON.stringify(h.posts)).not.toContain('secret')
  })
  it('names, codes and file names that are not plain identifiers are dropped, not sent', () => {
    const h = kit()
    h.k.row('error', { name: 'My ' + SECRET, code: 'has spaces ' + SECRET }, 'https://x/' + encodeURIComponent(SECRET) + '.js', 1, 1)
    const d = h.posts[0].body.data
    expect([d.cls, d.code, d.src]).toEqual(['object', '', ''])
  })
  it('a failed image or file load (no error, no filename) is not a row', () => {
    const h = kit()
    h.listeners.error({ target: {} })
    expect(h.posts).toHaveLength(0)
  })
  it('one row per kind, class, code and place; at most 10 a page load', () => {
    const h = kit()
    for (let i = 0; i < 3; i++) h.listeners.error({ error: new TypeError('x'), filename: 'app.js', lineno: 5, colno: 1 })
    expect(h.posts, 'the same place three times is one row').toHaveLength(1)
    for (let i = 0; i < 30; i++) h.listeners.error({ error: new TypeError('x'), filename: 'app.js', lineno: 100 + i, colno: 1 })
    expect(h.k.MAX).toBe(10)
    expect(h.posts).toHaveLength(10)
    expect(h.posts[9].body.data.n).toBe(10)
  })
})
