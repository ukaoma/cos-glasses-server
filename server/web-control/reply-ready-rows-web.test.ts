/**
 * 7.0.53 Part A (Miles 20:52 on F1's partR "a1" frames; the lead's build order): a Reply ready item in the COS thread is
 * the session speaking, one row per session. Runs the real panes/cos-chat.js in a vm with a fake COSWeb and document,
 * paints the chat into a fake feed and reads the HTML, and drives taps and keys the way messages.js passes them on.
 *
 * What only a browser proves: the 3-line clip, the hairline and the tokens in both looks (F1's keyed sweep), and the
 * phone's real tap targets.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, 'panes', 'cos-chat.js'), 'utf8')
const CSS = readFileSync(join(HERE, 'panes', 'cos-chat.css'), 'utf8')
const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', B = '019a7b2c-3d4e-7f60-8a1b-2c3d4e5f6a7b'
const minAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()
let n = 0
function rr(o: { sid?: string; provider?: string | null; label?: string; excerpt?: string; at?: string; turnAt?: string; count?: number; earlier?: unknown; line?: string; title?: string; source?: string } = {}) {
  const sid = o.sid ?? A, id = 'fi_' + (++n)
  const provider = o.provider === null ? {} : { provider: o.provider ?? 'claude' }
  return { id, kind: 'ping', threadId: id, createdAt: o.at ?? minAgo(4), readAt: null, source: o.source ?? 'cos', title: o.title ?? 'Reply ready',
    line: o.line ?? 'Claude has a reply ready.', links: [{ kind: 'session', id: sid, label: o.label ?? 'Session', ...provider }],
    actions: [{ id: 'open_result', label: 'Open result' }], state: 'live', key: `agent:${sid}:turn:${'a'.repeat(63)}${n % 10}`,
    ...(o.excerpt !== undefined ? { excerpt: o.excerpt } : {}), ...(o.turnAt ? { turnAt: o.turnAt } : {}), ...(o.count !== undefined ? { count: o.count } : {}), ...(o.earlier !== undefined ? { earlier: o.earlier } : {}) }
}

function load(o: { sessions?: unknown[] } = {}) {
  const went: Array<[string, unknown[]]> = []
  const W: Record<string, unknown> = {
    $: () => null, esc, toast: () => {}, autoGrow: () => {}, md: (s: unknown) => String(s), skeletonRows: () => '',
    toDate: (s: string) => { const d = new Date(s); return isNaN(d.getTime()) ? null : d }, readStore: () => ({}), writeStore: () => {},
    parseRoute: () => ({ pane: 'messages', args: ['cos'] }), go: (pane: string, args?: unknown[]) => { went.push([pane, args ?? []]) },
    api: () => Promise.resolve({}),
    ...(o.sessions ? { sessionList: () => Promise.resolve({ sessions: o.sessions }) } : {}),
  }
  let html = ''
  const rows: Record<string, unknown> = {}
  const feed = { get innerHTML() { return html }, set innerHTML(v: string) { html = v }, contains: () => false, querySelector: () => null, querySelectorAll: () => [], scrollTop: 0, scrollHeight: 0, clientHeight: 0 }
  const host = { querySelector: (s: string) => (s === '[data-cos-feed]' ? feed : (rows[s] as unknown) ?? null) }
  const document = { addEventListener: () => {}, querySelectorAll: () => [], getElementById: () => null, activeElement: null, hidden: false, body: { scrollHeight: 0 }, scrollingElement: {}, createElement: () => ({ setAttribute() {}, classList: { add() {} } }) }
  const window = { COSWeb: W, matchMedia: () => ({ matches: false, addEventListener: () => {} }), scrollTo: () => {}, scrollBy: () => {}, localStorage: { getItem: () => null, setItem: () => {} } }
  const ctx = vm.createContext({ window, document, setTimeout, clearTimeout, console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto })
  vm.runInContext(SOURCE, ctx)
  const chat = W.cosChat as any
  Object.assign(chat._state, { host, caps: { jobs: true, dropIt: true }, feedMode: 'drop', feedState: 'ready' })
  const paint = (items: unknown[]) => { chat._state.items = items; chat._paintFeed(true); return html }
  const tap = (attrs: Record<string, string>) => chat.onClick({ getAttribute: (k: string) => attrs[k] ?? null, tagName: 'BUTTON' })
  return { chat, paint, tap, went, html: () => html, rows, W }
}
const count = (h: string, re: RegExp) => (h.match(re) ?? []).length

describe('one row per session, the newest reply shown', () => {
  it('three replies from one session and one from another: two rows, no Reply ready cards', () => {
    const h = load()
    const html = h.paint([rr({ at: minAgo(30), excerpt: 'First.' }), rr({ sid: B, provider: 'codex', line: 'Codex has a reply ready.', at: minAgo(20), excerpt: 'Codex said.' }), rr({ at: minAgo(10), excerpt: 'Second.' }), rr({ at: minAgo(4), excerpt: 'Newest words.' })])
    expect(count(html, /class="rr"/g)).toBe(2)
    expect(html).not.toContain('cc-card-title">Reply ready')
    expect(html).not.toContain('Open result')
    expect(html).toContain('Newest words.')
    expect(html).not.toContain('Second.')
    expect(html).toContain(', 3 replies, ')
    expect(html).toContain('2 earlier replies')
    // The order is the order of each session's newest reply: Codex (20 min ago) before Claude (4 min ago).
    expect(html.indexOf('Codex said.')).toBeLessThan(html.indexOf('Newest words.'))
  })
  it('the session speaks: its name as a link, provider, short id, the count and when', () => {
    const h = load()
    const html = h.paint([rr({ label: 'Release checks for Wednesday', excerpt: 'Done.', at: minAgo(4) })])
    expect(html).toContain('<button type="button" class="rr-name" data-cos="rr-open"')
    expect(html).toContain('>Release checks for Wednesday</button>')
    expect(html).toContain('Claude, <span class="rr-id">0a1b2c3d</span>, 4 min ago')
  })
  it('a single reply has no count and no earlier replies', () => {
    const html = load().paint([rr({ excerpt: 'Only one.' })])
    expect(html).not.toMatch(/replies/)
    expect(html).not.toContain('class="link-btn rr-count"')
  })
  it('the server\'s own count wins when it is larger than the items here', () => {
    const html = load().paint([rr({ excerpt: 'x', count: 18 })])
    expect(html).toContain(', 18 replies, ')
    expect(html).toContain('17 earlier replies')
  })
})

describe('the name: the link label, else the session list, else "Reply ready"', () => {
  it('the server\'s label first', () => {
    expect(load().paint([rr({ label: 'Fix the **importer**', excerpt: 'x' })])).toContain('>Fix the importer</button>')
  })
  it('then the session list\'s title (its rename first)', async () => {
    const h = load({ sessions: [{ provider: 'claude', session_id: A, display_label: 'Agent label', title_override: 'His rename' }] })
    h.chat._state.sessionRows = [{ provider: 'claude', session_id: A, display_label: 'Agent label', title_override: 'His rename' }]
    expect(h.paint([rr({ excerpt: 'x' })])).toContain('>His rename</button>')
  })
  it('else "Reply ready", never a guessed name', () => {
    expect(load().paint([rr({ excerpt: 'x' })])).toContain('>Reply ready</button>')
  })
})

describe('the reply in plain words, three lines until he opens it', () => {
  it('closed: the whole reply is ONE clamped block, its paragraphs kept as line breaks (Codex P2); open: its paragraphs', () => {
    const h = load()
    const items = [rr({ excerpt: 'All three gates passed.\n\nOne thing: <img src=x onerror=alert(1)> **now**?\n\nThird.\n\nFourth.' })]
    const closed = h.paint(items)
    expect(closed).toContain('<div class="rr-said clip" data-cos="rr-more"')
    const said = /<div class="rr-said clip"[^>]*>([\s\S]*?)<\/div>/.exec(closed)![1]!
    expect(said.match(/<p>/g)).toHaveLength(1)
    expect(said).toBe('<p>All three gates passed.\nOne thing: &lt;img src=x onerror=alert(1)&gt; **now**?\nThird.\nFourth.</p>')
    expect(closed).not.toContain('<img')
    h.tap({ 'data-cos': 'rr-more', 'data-rr': 'claude|' + A })
    expect(h.html()).toContain('<p>All three gates passed.</p><p>One thing: &lt;img src=x onerror=alert(1)&gt; **now**?</p><p>Third.</p><p>Fourth.</p>')
  })
  it('the clamp is on that one block, in the stylesheet', () => {
    expect(CSS).toMatch(/\.rr-said\.clip p \{ display: -webkit-box; -webkit-line-clamp: 3;/)
  })
  it('a reply from before COS kept reply text says so and is not a toggle', () => {
    const html = load().paint([rr({})])
    expect(html).toContain('This reply came before COS kept reply text. Open the session to read it.')
    expect(html).not.toContain('class="rr-said clip"')
  })
  it('a newer item with no words (Cursor keeps none) says to open the session, not that it came before', () => {
    const html = load().paint([rr({ provider: 'cursor', line: 'Cursor has a reply ready.', turnAt: minAgo(5) })])
    expect(html).toContain('Open the session to read the reply.')
    expect(html).not.toContain('came before COS kept reply text')
  })
  it('a tap on the words opens it in place, and again closes it', () => {
    const h = load()
    const items = [rr({ excerpt: 'Long words.' })]
    h.paint(items)
    const key = 'claude|' + A
    h.tap({ 'data-cos': 'rr-more', 'data-rr': key })
    expect(h.html()).toContain('<div class="rr-said" data-cos="rr-more"')
    expect(h.html()).toContain('aria-expanded="true"')
    h.tap({ 'data-cos': 'rr-more', 'data-rr': key })
    expect(h.html()).toContain('<div class="rr-said clip"')
  })
  it('Enter or Space on the words (a div, so they can be selected) opens it; another key does nothing', () => {
    const h = load()
    h.paint([rr({ excerpt: 'Words.' })])
    const key = 'claude|' + A
    const press = (k: string) => { let prevented = false; h.chat.onKey({ key: k, target: { tagName: 'DIV', getAttribute: (a: string) => (({ 'data-cos': 'rr-more', 'data-rr': key }) as Record<string, string>)[a] ?? null }, preventDefault: () => { prevented = true } }); return prevented }
    expect(press('a')).toBe(false)
    expect(h.html()).toContain('rr-said clip')
    expect(press('Enter')).toBe(true)
    expect(h.html()).not.toContain('rr-said clip')
    expect(press(' ')).toBe(true)
    expect(h.html()).toContain('rr-said clip')
  })
})

describe('"N earlier replies" opens them in place', () => {
  it('the server\'s earlier list and the older items here, newest first, each once, with what is left in the session', () => {
    const h = load()
    const items = [rr({ at: minAgo(50), turnAt: minAgo(51), excerpt: 'Oldest here.' }),
      rr({ at: minAgo(5), excerpt: 'Newest.', count: 9, earlier: [{ at: minAgo(20), excerpt: 'From the server.' }, { at: minAgo(51), excerpt: 'Oldest here.' }, 'junk', null] })]
    h.paint(items)
    h.tap({ 'data-cos': 'rr-more', 'data-rr': 'claude|' + A })
    const html = h.html()
    expect(html).toContain('Hide earlier replies')
    expect(count(html, /class="rr-e"/g)).toBe(3)
    expect(html.indexOf('From the server.')).toBeLessThan(html.indexOf('Oldest here.'))
    expect(count(html, /Oldest here\./g)).toBe(1)
    expect(html).toContain('6 more in the session')
  })
  it('at most five shown', () => {
    const h = load()
    const earlier = Array.from({ length: 8 }, (_, i) => ({ at: minAgo(10 + i), excerpt: 'e' + i }))
    h.paint([rr({ excerpt: 'n', count: 9, earlier })])
    h.tap({ 'data-cos': 'rr-more', 'data-rr': 'claude|' + A })
    expect(count(h.html(), /class="rr-e"/g)).toBe(6)
    expect(h.html()).toContain('3 more in the session')
  })
  it('after opening or closing, focus is back on the same control in the new row, without scrolling (Codex P2)', () => {
    const h = load()
    h.paint([rr({ excerpt: 'Words.' }), rr({ excerpt: 'More.', at: minAgo(1) })])
    const key = 'claude|' + A
    const focused: Array<[string, unknown]> = []
    const ctl = (name: string) => ({ focus: (o: unknown) => { focused.push([name, o]) } })
    const words = ctl('words'), count = ctl('count')
    h.rows[`[data-rr-row="${key}"]`] = { querySelector: (sel: string) => (sel === '.rr-count' ? count : sel === '.rr-said[data-cos="rr-more"]' ? words : null) }
    h.tap({ 'data-cos': 'rr-more', 'data-rr': key })                       // the "N earlier replies" button
    h.chat.onKey({ key: 'Enter', target: { tagName: 'DIV', getAttribute: (a: string) => (({ 'data-cos': 'rr-more', 'data-rr': key }) as Record<string, string>)[a] ?? null }, preventDefault: () => {} })
    h.chat.onClick({ getAttribute: (k: string) => (({ 'data-cos': 'rr-more', 'data-rr': key }) as Record<string, string>)[k] ?? null, tagName: 'DIV' })
    expect(focused).toEqual([['count', { preventScroll: true }], ['words', { preventScroll: true }], ['words', { preventScroll: true }]])
  })
  it('an unknown row key changes nothing', () => {
    const h = load()
    h.paint([rr({ excerpt: 'n' })])
    const before = h.html()
    h.tap({ 'data-cos': 'rr-more', 'data-rr': 'cursor|nope' })
    expect(h.html()).toBe(before)
    expect((h.chat._state.rrOpen || {})['cursor|nope']).toBeUndefined()
  })
})

describe('Open the session, and the approval line', () => {
  it('the name and "Open the session" open that session\'s reader, and Back is set to come back here', () => {
    const h = load()
    h.paint([rr({ excerpt: 'x' })])
    h.tap({ 'data-cos': 'rr-open', 'data-rr': 'claude|' + A })
    expect(h.went).toEqual([['sessions', ['claude', A]]])
    expect(h.chat._state.returnTo).toMatchObject({ key: 'messages/cos', reader: 'sessions/claude/' + A })
  })
  it('an old item names its provider only in its line: still one row, still the right reader', () => {
    const h = load()
    h.paint([rr({ provider: null, line: 'Codex has a reply ready.', sid: B })])
    h.tap({ 'data-cos': 'rr-open', 'data-rr': 'codex|' + B })
    expect(h.went).toEqual([['sessions', ['codex', B]]])
  })
  it('waiting on a permission or a plan: the approval line, and Open the session is the primary button', () => {
    for (const kind of ['permission', 'plan']) {
      const h = load()
      h.chat._state.sessionRows = [{ provider: 'claude', session_id: 'claude:' + A, state: 'waiting', waiting_kind: kind }]
      const html = h.paint([rr({ excerpt: 'x' })])
      expect(html).toContain('It asked for approval. Approve it in Sessions, where the request card is.')
      expect(html).toContain('class="cx-btn primary" data-cos="rr-open"')
    }
  })
  it('no approval line for a question, a working session, or another provider with the same id', () => {
    for (const row of [{ provider: 'claude', session_id: A, state: 'waiting', waiting_kind: 'question' }, { provider: 'claude', session_id: A, state: 'working', waiting_kind: 'permission' }, { provider: 'codex', session_id: A, state: 'waiting', waiting_kind: 'permission' }]) {
      const h = load()
      h.chat._state.sessionRows = [row]
      const html = h.paint([rr({ excerpt: 'x' })])
      expect(html).not.toContain('It asked for approval')
      expect(html).toContain('class="link-btn rr-go"')
    }
  })
})

describe('what stays as it was', () => {
  it('an item whose provider cannot be told keeps its old card and Open result', () => {
    const html = load().paint([rr({ provider: null, line: 'Your agent has a reply ready.' }), rr({ provider: 'grok' as never, line: 'Grok has a reply ready.' })])
    expect(count(html, /class="rr"/g)).toBe(0)
    expect(count(html, /Open result/g)).toBe(2)
  })
  it('other COS items, and a "Reply ready" that is not COS\'s own, are untouched', () => {
    const html = load().paint([rr({ title: 'the import', line: 'Claude finished the import.' }), rr({ source: 'web' })])
    expect(count(html, /class="rr"/g)).toBe(0)
  })
  it('painting never changes the stored items (what the banners, the lens and COS read)', () => {
    const items = [rr({ excerpt: 'x', count: 3 }), rr({ excerpt: 'y' })]
    const copy = JSON.parse(JSON.stringify(items))
    const h = load()
    h.paint(items)
    h.tap({ 'data-cos': 'rr-more', 'data-rr': 'claude|' + A })
    expect(items).toEqual(copy)
  })
  it('a link to an earlier reply folded into a row shows that row', () => {
    const h = load()
    const older = rr({ at: minAgo(30), excerpt: 'old' }), newer = rr({ at: minAgo(3), excerpt: 'new' })
    h.paint([older, newer])
    const row = { getBoundingClientRect: () => ({ top: 0 }), scrollIntoView: () => { (row as any).shown = true } }
    h.rows[`[data-rr-row="claude|${A}"]`] = row
    h.chat._state.focusItem = older.id
    h.chat._paintFeed(false)
    expect((row as any).shown).toBe(true)
  })
})

describe('the row\'s styles use tokens only', () => {
  const block = CSS.slice(CSS.indexOf('7.0.53 Part A'))
  it('no colour written out in the Reply ready rules (amber.css restyles them through tokens)', () => {
    expect(block.length).toBeGreaterThan(200)
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(/)
  })
})
