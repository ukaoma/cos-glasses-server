/**
 * 7.0.23, step 2b-1 of the chat-style Sessions (DESIGN_PLAN v2 "The list", the 23:33 mock, S1's contract at 469a334):
 * the grouped list. These run app.js's own text against fakes: the groups and their order, the rest rule (a row
 * changes group only when the list is at rest), the 5 s hold on an empty Needs you or Working now heading, the merge
 * with /older's short rows, the row's words, the quiet line, /older's loading and an older server's 404, and the sort
 * menu. Layout and touch sizes are checked in WebKit (W1_evidence/two_column/list_check.cjs).
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
const SRC = slice(APP, '  // ── the grouped list (7.0.23, step 2b-1', '  // The list, under the hero.')
const NOW = new Date(2026, 10, 10, 21, 0, 0).getTime()   // Tue Nov 10, 9 PM
const H = 3600e3, D = 86400e3
const iso = (ms: number) => new Date(ms).toISOString()

type Row = Record<string, unknown>
function kit(o: { rows?: Row[]; older?: Row[]; held?: Array<{ provider: string; sessionId: string }>; clock?: string; search?: boolean; api?: (p: string) => Promise<unknown> } = {}) {
  const timers: Array<{ fn: () => void; ms: number }> = []
  let now = NOW
  class FakeDate extends Date { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(now) } static now() { return now } }
  const SX: any = { rows: o.rows ?? [], clock: o.clock ?? 'updated', recency: 'newest', view: 'sessions', enabled: true, error: '', dropped: null }
  let active: any = null, renders = 0
  const apiCalls: string[] = []
  const deps: any = {
    SX, state: { pane: 'sessions' }, Date: FakeDate,
    document: { get activeElement() { return active } },
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length },
    $: () => null,
    api: (p: string) => { apiCalls.push(p); return o.api ? o.api(p) : Promise.resolve({ sessions: [], older_than_window: 0, next_before: null }) },
    renderSessionGroups: () => { renders++ },
    splitSessionId: (p: string, id: string) => ({ provider: p || 'claude', id: String(id || '') }),
    parseRoute: () => ({ pane: 'sessions', args: [] }),
    sxState: (s: Row) => ({ waiting: 'waiting', failed: 'error', running: 'running', idle: 'recent', ended: 'stale' } as Record<string, string>)[String(s.agent_state)] || 'recent',
    sxTitle: (s: Row) => String(s.display_label || s.session_id),
    sxWaitingKind: (k: string) => (k === 'question' ? 'Question' : k === 'permission' ? 'Permission' : ''),
    notSentFor: (p: string, id: string) => (id === 'ns' ? { label: 'Not sent' } : null),
    sxProviderLabel: (p: string) => (p === 'codex' ? 'Codex' : p === 'cursor' ? 'Cursor' : 'Claude'),
    toDate: (v: unknown) => (v ? new Date(String(v)) : null),
    sxTime: (v: unknown) => { const d = v ? new Date(String(v)) : null; return d && !isNaN(d.getTime()) ? d.getTime() : 0 },
    sxShortDate: (d: Date) => (d.toDateString() === new Date(now).toDateString() ? 'time' : 'date'),
    esc: (t: unknown) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    plain: (t: string) => t,
    sxGlyph: (p: string) => '<glyph ' + p + '>',
    sxReal: () => SX.rows.filter((s: Row) => !s.warm),
    sxKeepWarm: (s: Row) => !!s.warm,
    sxEmpty: (t: string) => '<empty>' + t + '</empty>',
    skeletonRows: () => '<skel>', sxEmptyCopy: () => 'none',
    sxAmbiguous: (rows: Row[]) => { const seen: Record<string, number> = {}, d: Record<string, boolean> = {}; rows.forEach(r => { const t = String(r.display_label); if (seen[t]) d[t] = true; seen[t] = 1 }); return d },
    sxDropped: () => ({ age: 7 }),
    sxQueryActive: () => !!o.search,
    sessionQs: () => ({ itemsFor: () => o.held ?? [] }),
    encodeURIComponent,
  }
  // eslint-disable-next-line no-new-func
  const k = new Function('deps', `with (deps) {\n${SRC}\nreturn { row: sxRow, group: sxGroupFor, all: sxAllRows, html: sxListHtml, rest: sxListAtRest, SXL, quiet: sxQuietLine, older: sxLoadOlder, held: sxHeldKeys, words: sxRowWords, GROUPS: SX_GROUPS, live: sxLiveRow, anchor: sxAnchor, restore: sxRestoreAnchor };\n}`)(deps)
  if (o.older) k.SXL.older = o.older.map(r => ({ ...r, form: 'short' }))
  return { k, SX, timers, later: (ms: number) => { now += ms }, setActive: (a: any) => { active = a }, renders: () => renders, apiCalls }
}
const groupsOf = (html: string) => [...html.matchAll(/data-g="([a-z]+)"/g)].map(m => m[1]).filter((g, i, a) => a.indexOf(g) === i)
const rowsIn = (html: string, g: string) => {
  const at = html.indexOf('<section class="sx-g" data-g="' + g + '"'); if (at < 0) return []
  const end = html.indexOf('</section>', at)
  return [...html.slice(at, end).matchAll(/<div class="sx-r [^"]*" data-session="([^"]+)"/g)].map(m => m[1])
}
const row = (id: string, ageMs: number, extra: Row = {}): Row => ({ provider: 'claude', session_id: id, display_label: 'T ' + id, modified: iso(NOW - ageMs), created: iso(NOW - ageMs), ...extra })

describe('the groups: a session shows once, top to bottom', () => {
  const rows = [
    row('w', 5 * D, { agent_state: 'waiting', waiting_kind: 'question' }), row('f', 1 * H, { agent_state: 'failed' }), row('r', 2 * H, { agent_state: 'running' }),
    row('p', 9 * D, { pinned: true }), row('cp', 3 * H, { cos_pinned: true }), row('t', 1 * H), row('y', 22 * H), row('wk', 4 * D),
    row('hq', 3 * D, { agent_state: 'ended' }),
  ]
  it('Needs you (waiting, failed, a question held for it), Working now, Pinned, Today, Yesterday, Earlier this week, in that order', () => {
    const h = kit({ rows, held: [{ provider: 'claude', sessionId: 'hq' }] })
    const html = h.k.html()
    expect(groupsOf(html)).toEqual(['needs', 'working', 'pinned', 'today', 'yesterday', 'week'])
    expect(rowsIn(html, 'needs').sort()).toEqual(['claude|f', 'claude|hq', 'claude|w'])
    expect(rowsIn(html, 'working')).toEqual(['claude|r'])
    expect(rowsIn(html, 'pinned').sort(), 'an agent pin and a COS pin').toEqual(['claude|cp', 'claude|p'])
    expect(rowsIn(html, 'today')).toEqual(['claude|t'])
    expect(rowsIn(html, 'yesterday')).toEqual(['claude|y'])
    expect(rowsIn(html, 'week')).toEqual(['claude|wk'])
    const all = [...html.matchAll(/<div class="sx-r [^"]*" data-session="([^"]+)"/g)].map(m => m[1])
    expect(new Set(all).size, 'each once').toBe(all.length)
  })
  it('Needs you and Working now headings name the group; the others are plain headings with a count', () => {
    const html = kit({ rows }).k.html()
    expect(html).toContain('<h3 class="sx-gh state needs"><span>Needs you</span><span class="n">2</span></h3>')
    expect(html).toContain('<h3 class="sx-gh"><span>Today</span><span class="n">1</span></h3>')
  })
  it('the days count back from today: 2 to 6 days Earlier this week, 7 to 13 Last week, 14 to 30 Earlier this month', () => {
    const h = kit()
    const held = {}
    expect(h.k.group(row('a', 1 * H), NOW, held)).toBe('today')
    expect(h.k.group(row('a', 23 * H), NOW, held)).toBe('yesterday')
    expect(h.k.group(row('a', 6 * D), NOW, held)).toBe('week')
    expect(h.k.group(row('a', 7 * D), NOW, held), 'a week ago this evening is Last week').toBe('lastweek')
    expect(h.k.group(row('a', 8 * D), NOW, held)).toBe('lastweek')
    expect(h.k.group(row('a', 20 * D), NOW, held)).toBe('month')
  })
  it('Opened sorts and groups by when it was opened', () => {
    const h = kit({ clock: 'opened' })
    expect(h.k.group(row('a', 1 * H, { created: iso(NOW - 3 * D) }), NOW, {})).toBe('week')
  })
  it('a short row (from /older) has no state, so it is never in Needs you or Working now', () => {
    expect(kit().k.group({ ...row('s', 1 * H, { agent_state: 'waiting' }), form: 'short' }, NOW, {})).toBe('today')
  })
})

describe('older rows: compact, folded, and the main row wins', () => {
  it('Last week and Earlier this month are compact, folded shut with a count; unfolded they list compact rows', () => {
    const h = kit({ rows: [row('t', H)], older: [row('o1', 9 * D), row('o2', 20 * D), row('o3', 25 * D)] })
    let html = h.k.html()
    expect(html).toContain('<button type="button" class="sx-gh" data-sx="fold" data-g="month" aria-expanded="false"><span class="fold"><span class="chev" aria-hidden="true"></span>Earlier this month</span><span class="n">2</span></button>')
    expect(rowsIn(html, 'month')).toEqual([])
    h.k.SXL.open.month = true
    html = h.k.html()
    expect(rowsIn(html, 'month')).toEqual(['claude|o2', 'claude|o3'])
    expect(html).toContain('<div class="sx-r compact" data-session="claude|o2">')
  })
  it('a session in both the main list and /older shows once, as the main list’s full row', () => {
    const h = kit({ rows: [row('same', H, { agent_state: 'running' })], older: [row('SAME', 20 * D)] })
    expect(h.k.all().map((s: Row) => s.form || 'full')).toEqual(['full'])
  })
  it('Show older appears under Earlier this month when /older has another page', () => {
    const h = kit({ older: [row('o', 20 * D)] })
    h.k.SXL.open.month = true; h.k.SXL.olderNext = '2026-10-20T00:00:00.000Z'
    expect(h.k.html()).toContain('data-sx="older-more"')
  })
})

describe('the rest rule: a row changes group only when the list is at rest', () => {
  function moving() {
    const rows = [row('a', H), row('b', 2 * H)]
    const h = kit({ rows })
    h.k.html()                                    // drawn at rest: both in Today
    return { h, rows }
  }
  it('pressed or scrolled within 2 s: a row that started running stays where it was, and a regroup is scheduled', () => {
    const { h, rows } = moving()
    rows[0]!.agent_state = 'running'
    h.k.SXL.down = true
    const html = h.k.html()
    expect(rowsIn(html, 'today')).toContain('claude|a')
    expect(rowsIn(html, 'working')).toEqual([])
    expect(h.timers.length).toBeGreaterThan(0)
    h.k.SXL.down = false; h.k.SXL.scrollAt = NOW
    expect(rowsIn(h.k.html(), 'working'), 'still held: a scroll 0 s ago').toEqual([])
  })
  it('a row with keyboard focus holds the list too', () => {
    const { h, rows } = moving()
    rows[0]!.agent_state = 'running'
    h.setActive({ closest: (sel: string) => (sel === '#sessions-list [data-session]' ? {} : null) })
    expect(h.k.rest()).toBe(false)
  })
  it('at rest (2 s with no touch, scroll or focus): every held move applies together', () => {
    const { h, rows } = moving()
    rows[0]!.agent_state = 'running'; rows[1]!.agent_state = 'waiting'
    h.k.SXL.touchAt = NOW
    h.k.html()
    h.later(2100)
    const html = h.k.html()
    expect(rowsIn(html, 'working')).toEqual(['claude|a'])
    expect(rowsIn(html, 'needs')).toEqual(['claude|b'])
  })
  it('a new session is placed at once (it was in no group), the sort menu redraws at once', () => {
    const { h, rows } = moving()
    h.k.SXL.down = true
    rows.push(row('n', 30 * 60e3, { agent_state: 'running' }))
    expect(rowsIn(h.k.html(), 'working')).toEqual(['claude|n'])
    expect(APP).toContain("else { SX.clock = v === 'opened' ? 'opened' : 'updated'; SXL.place = null; }")
  })
  it('the scheduled regroup redraws only at rest, else waits again', () => {
    const { h, rows } = moving()
    rows[0]!.agent_state = 'running'
    h.k.SXL.down = true
    h.k.html()
    const t = h.timers.at(-1)!
    t.fn()
    expect(h.renders(), 'still pressed: no redraw').toBe(0)
    h.k.SXL.down = false; h.later(5000)
    h.timers.at(-1)!.fn()
    expect(h.renders()).toBe(1)
  })
})

describe('Needs you and Working now hold their heading at 0 for 5 s', () => {
  it('the last waiting row answered: the heading stays at 0, then goes after 5 s', () => {
    const rows = [row('w', H, { agent_state: 'waiting' })]
    const h = kit({ rows })
    h.k.html()
    rows[0]!.agent_state = 'idle'
    let html = h.k.html()
    expect(html).toContain('<h3 class="sx-gh state needs"><span>Needs you</span><span class="n">0</span></h3>')
    expect(h.timers.at(-1)!.ms, 'a redraw when the hold ends').toBeLessThanOrEqual(5020)
    h.later(5001)
    html = h.k.html()
    expect(html).not.toContain('data-g="needs"')
  })
})

describe('a row: its words, and names as text only', () => {
  it('line two is the product’s state words then the project, with commas, never middle dots', () => {
    const h = kit()
    const html = h.k.row(row('ns', H, { agent_state: 'waiting', waiting_kind: 'question', queued_turns: 2, project: 'MU-Chief-Staff' }), null, {})
    expect(html).toContain('<span class="t">Waiting, question, 2 queued, Not sent, MU-Chief-Staff</span>')
    expect(html).not.toMatch(/·/)
    const failed = h.k.row(row('f', H, { agent_state: 'failed', failure: 'rate_limit', project: 'X' }), null, {})
    expect(failed).toContain('<b class="failed">Failed, rate limit</b>, X')
    expect(h.k.row(row('p', H, { pinned: true, provider: 'codex' }), null, {})).toContain('Pinned in Codex')
  })
  it('the root and its open button both carry data-session (live updates replace the root)', () => {
    const html = kit().k.row(row('a', H, { agent_state: 'running' }), null, {})
    expect(html.startsWith('<div class="sx-r full running" data-session="claude|a">')).toBe(true)
    expect(html).toContain('<button type="button" class="sx-r-open" data-session="claude|a">')
  })
  it('two rows with one title say when each opened', () => {
    expect(kit().k.row(row('a', H, { created: iso(NOW - 3 * D) }), null, { 'T a': true })).toContain('Opened date')
  })
  it('a title is drawn as text: markup in it is never markup', () => {
    const html = kit().k.row(row('x', H, { display_label: '<img src=x onerror=alert(1)>' }), null, {})
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img')
  })
  it('a search hit keeps its snippet and its Keyword or Meaning tag', () => {
    const html = kit().k.row(row('a', H), { match: 'semantic', snippet: 'found words' }, {})
    expect(html).toContain('<span class="sx-tag">Meaning</span>')
    expect(html).toContain('<span class="sx-r-snip">found words</span>')
  })
})

describe('the quiet line and /older', () => {
  it('30 days with the server’s count; 7 days on an older server', () => {
    const h = kit()
    h.k.SXL.olderOk = true; h.k.SXL.olderN = 271
    expect(h.k.quiet()).toBe('Last 30 days. 271 older through search.')
    h.k.SXL.olderOk = false
    expect(h.k.quiet()).toBe('Last 7 days. 7 older through search.')
  })
  it('loads /older once a minute at most, never twice at once, and appends a further page', async () => {
    const h = kit({ api: () => Promise.resolve({ sessions: [{ provider: 'claude', session_id: 'o' }], older_than_window: 271, next_before: '2026-10-20T00:00:00.000Z' }) })
    await h.k.older()
    expect(h.apiCalls).toEqual(['/api/agent-sessions/older?days=30&limit=200'])
    expect(h.k.SXL.older[0].form).toBe('short')
    expect(h.k.SXL.olderN).toBe(271)
    await h.k.older()
    expect(h.apiCalls, 'within a minute: no second read').toHaveLength(1)
    await h.k.older(false, true)
    expect(h.apiCalls[1]).toBe('/api/agent-sessions/older?days=30&limit=200&before=' + encodeURIComponent('2026-10-20T00:00:00.000Z'))
    expect(h.k.SXL.older).toHaveLength(2)
  })
  it('an older server (404): the list stays at 7 days and does not ask again', async () => {
    const h = kit({ api: () => Promise.reject(Object.assign(new Error('The server answered 404.'), { status: 404 })) })
    await h.k.older()
    expect(h.k.SXL.olderOk).toBe(false)
    await h.k.older(true)
    expect(h.apiCalls).toHaveLength(1)
  })
  it('only a 404 status or code means an older server; an error whose words say "not found" does not (Q1 07:22 b)', async () => {
    const h = kit({ api: () => Promise.reject(Object.assign(new Error('Session folder not found.'), { status: 500 })) })
    await h.k.older()
    expect(h.k.SXL.olderOk).not.toBe(false)
  })
  it('it is read with the list load, not on the 5 s poll', () => {
    expect(slice(APP, '  function loadSessions(force) {', '\n  }\n')).toContain('sxLoadOlder(force === true);')
    expect(slice(APP, '  function liveSessionRows(rows, structural) {', '\n  }\n')).not.toContain('sxLoadOlder')
  })
})

describe('the list head: the Sessions menu and one sort menu', () => {
  it('the sort menu: Updated or Opened; while searching Best match or Updated; Pinned is a group, not a clock', () => {
    const sort = slice(APP, '  function sxPaintSort() {', '\n  }\n')
    expect(sort).toContain("[['match', 'Best match'], ['newest', 'Updated']] : [['updated', 'Updated'], ['opened', 'Opened']]")
    expect(APP).toContain("clock: sxPref('clock', 'updated', ['updated', 'opened']),")
  })
  it('the Sessions menu holds Sessions, Usage, COS cost and Refresh; the header and switches are for Usage and COS cost', () => {
    const html = readFileSync(join(HERE, 'index.html'), 'utf8')
    const menu = slice(html, '<div class="sx-menu hidden" id="sessions-view-menu" role="menu" aria-label="Sessions">', '</div>')
    for (const item of ['data-view="sessions">Sessions<', 'data-view="usage">Usage<', 'data-view="cost">COS cost<', 'data-sx="refresh">Refresh<']) expect(menu).toContain(item)
    expect(APP).toContain("hero.classList.toggle('hidden', view === 'sessions');")
  })
})

// Q1 07:22 FIX 1: liveSessionRows' paint without a structural change. Its own text runs against a fake list.
const LIVE = slice(APP, '  function liveSessionRows(rows, structural) {', '\n  }\n') + '\n  }\n'
function liveRun(h: ReturnType<typeof kit>, drawn: string[], rows: Row[]) {
  const replaced: Array<{ id: string; html: string }> = [], calls = { regroup: 0, render: 0 }
  const els = drawn.map(id => ({ id, getAttribute: () => id, parentNode: { replaceChild: (next: any) => replaced.push({ id, html: next.__liveHtml }) } }))
  const deps: any = {
    $: (id: string) => (id === 'sessions-list' ? { querySelectorAll: () => els } : null),
    sxQueryActive: () => false, paintSessionsHero: () => {}, renderSessionGroups: () => { calls.render++ },
    sxAmbiguous: () => ({}), sxVisible: () => [], sxKeepWarm: (s: Row) => !!s.warm, sxLiveRow: h.k.live,
    splitSessionId: (p: string, id: string) => ({ provider: p || 'claude', id: String(id || '') }),
    sxRegroupLater: () => { calls.regroup++ },
    document: { createElement: () => { const d: any = {}; Object.defineProperty(d, 'innerHTML', { set(v: string) { d.firstElementChild = { html: v } } }); return d } },
  }
  // eslint-disable-next-line no-new-func
  new Function('deps', 'rows', `with (deps) {\n${LIVE}\nliveSessionRows(rows, false);\n}`)(deps, rows)
  return { replaced, calls }
}
describe('a live state change moves its row between groups, under the rest rule (Q1 07:22 FIX 1)', () => {
  it('Working now to waiting on a question: the row is redrawn in place and a regroup is asked for', () => {
    const rows = [row('r', H, { agent_state: 'running' }), row('t', 2 * H)]
    const h = kit({ rows })
    expect(rowsIn(h.k.html(), 'working')).toEqual(['claude|r'])
    rows[0]!.agent_state = 'waiting'; rows[0]!.waiting_kind = 'question'
    const run = liveRun(h, ['claude|r', 'claude|t'], [rows[0]!])
    expect(run.calls.regroup, 'a regroup is asked for').toBe(1)
    expect(run.replaced.map(x => x.id)).toEqual(['claude|r'])
  })
  it('held while the list is pressed, applied together at rest: the row lands under Needs you', () => {
    const rows = [row('r', H, { agent_state: 'running' })]
    const h = kit({ rows })
    h.k.html()
    rows[0]!.agent_state = 'waiting'
    h.k.SXL.down = true
    expect(rowsIn(h.k.html(), 'working'), 'held while pressed').toEqual(['claude|r'])
    h.k.SXL.down = false; h.later(2100)
    const html = h.k.html()
    expect(rowsIn(html, 'needs')).toEqual(['claude|r'])
    expect(rowsIn(html, 'working')).toEqual([])
  })
  it('a row in a folded group (not drawn) that starts running still asks for the regroup', () => {
    const rows = [row('old', 9 * D), row('t', H)]
    const h = kit({ rows })
    expect(rowsIn(h.k.html(), 'lastweek'), 'folded: not drawn').toEqual([])
    rows[0]!.agent_state = 'running'
    expect(liveRun(h, ['claude|t'], [rows[0]!]).calls.regroup).toBe(1)
  })
  it('a row patched inside a compact group keeps the compact form', () => {
    const rows = [row('old', 9 * D), row('t', H)]
    const h = kit({ rows })
    h.k.SXL.open.lastweek = true
    expect(rowsIn(h.k.html(), 'lastweek')).toEqual(['claude|old'])
    rows[0]!.display_label = 'Renamed'
    const run = liveRun(h, ['claude|old', 'claude|t'], [rows[0]!])
    expect(run.replaced[0]!.html).toMatch(/class="sx-r[^"]*\bcompact\b/)
    expect(run.calls.regroup, 'same group: nothing to regroup').toBe(0)
  })
  it('a change that keeps the group asks for no regroup', () => {
    const rows = [row('t', H)]
    const h = kit({ rows })
    h.k.html()
    rows[0]!.display_label = 'New title'
    expect(liveRun(h, ['claude|t'], [rows[0]!]).calls.regroup).toBe(0)
  })
})

// Q1 07:22 FIX 2: the list keeps its place across a redraw (the top visible row stays at the same height).
function fakeCol(ids: string[]) {
  const col: any = { scrollTop: 300, shift: 0, getBoundingClientRect: () => ({ top: 100 }) }
  col.querySelectorAll = () => ids.map((id, i) => ({ getAttribute: () => id, getBoundingClientRect: () => { const t = 100 + i * 60 - col.scrollTop + col.shift; return { top: t, bottom: t + 60 } } }))
  return col
}
describe('scroll anchoring: rows added above keep the top visible row where it was (Q1 07:22 FIX 2)', () => {
  it('the anchor is the first row still showing at the top, and the restore moves the scroll by its shift', () => {
    const h = kit()
    const col = fakeCol(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    const at = h.k.anchor(col)
    expect(at).toEqual({ key: 'f', top: 100 })
    col.shift = 120                                       // two rows drawn above it
    h.k.restore(col, at)
    expect(col.scrollTop).toBe(420)
    expect(col.querySelectorAll()[5].getBoundingClientRect().top, 'the anchor row is back at the top').toBe(100)
  })
  it('renderSessionGroups takes the anchor before the redraw and restores it after', () => {
    const h = kit()
    const col = fakeCol(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    const list: any = {}
    Object.defineProperty(list, 'innerHTML', { set() { col.shift = 120 } })
    const els: Record<string, any> = { 'sessions-list': list, 'sessions-list-col': col, 'sessions-q': { value: '' } }
    const deps: any = {
      $: (id: string) => els[id] || null, SX: { q: '' }, paintSessionsHero: () => {}, paintHooks: () => {}, sxQueryActive: () => false,
      sxSemanticHint: () => '', sxListWatch: () => {}, sxPaintListHead: () => {}, sxEditing: () => false, sxRegroupLater: () => {},
      sxAnchor: h.k.anchor, sxRestoreAnchor: h.k.restore, sxListHtml: () => '<rows>', sxSearchHtml: () => '',
    }
    const RSG = slice(APP, '  function renderSessionGroups() {', '\n  }\n') + '\n  }\n'
    // eslint-disable-next-line no-new-func
    new Function('deps', `with (deps) {\n${RSG}\nrenderSessionGroups();\n}`)(deps)
    expect(col.scrollTop).toBe(420)
  })
})

describe('the list asks the server for kept rows (lead 10:29: kept rows only to a client that asks)', () => {
  it('the shared list load sends kept=1; nothing else in the request changes', () => {
    expect(APP).toContain("SL.inflight = api('/api/agent-sessions?limit=80&sort=updated&kept=1')")
    expect(APP.match(/api\('\/api\/agent-sessions\?[^']*'/g)).toEqual(["api('/api/agent-sessions?limit=80&sort=updated&kept=1'"])
  })
})

// 7.0.27 (lead 13:06, Miles 13:01 on 7.0.26, the open Duo): at the divider's minimum (240 px) the list head was 272 px
// wide, so the column panned sideways and its left edge was cut, and the reach line was squeezed to one word a line
// beside New folder and the sort menu. W1_evidence/two_column/width_sweep.cjs drags the real divider from its minimum
// to its maximum in WebKit and fails on 6f6f4de (24 FAIL of 134); these pin the CSS that makes the content fit.
describe('THE LIST FITS ITS COLUMN (7.0.27)', () => {
  const CSS = readFileSync(join(HERE, 'panes/sessions.css'), 'utf8')
  const RULE = slice(CSS, '/* ── the list fits its column at every width (7.0.27', '.sx-org-note.hidden')
  const decl = (sel: string) => { const m = RULE.match(new RegExp('(^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}')); return m ? m[2] : '' }
  it('the head is one column that may shrink to 0, and its items may shrink', () => {
    expect(decl('.sx-lhead')).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(decl('.sx-lhead > *, .sx-lh-top > *, .sx-tools, .sx-search, .sx-search .field')).toContain('min-width: 0')
  })
  it('the reach line has its own full-width row; New folder and the sort menu wrap rather than overflow', () => {
    expect(decl('.sx-tools-line')).toContain('flex-wrap: wrap')
    expect(decl('.sx-tools-line .sx-quiet')).toContain('flex: 1 0 100%')
    expect(decl('.sx-tools-line .sx-select')).toMatch(/min-width: 0;.*max-width: 100%/)
  })
  it('rows and folder headings may shrink, and a folder name ends in an ellipsis', () => {
    expect(decl('.sx-rows')).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(decl('.sx-r, .sx-r-open, .sx-gh-row, .sx-gh-row .sx-gh, .sx-gh .fold')).toContain('min-width: 0')
    expect(decl('.sx-gh .fold .nm')).toMatch(/overflow: hidden;.*text-overflow: ellipsis;.*white-space: nowrap/)
    expect(APP).toContain('<span class="chev" aria-hidden="true"></span><span class="nm">\' + esc(g[1]) + \'</span></span><span class="n">\' + frows.length')
  })
  it('nothing is fixed by hiding: the rule sets no overflow on the list column', () => {
    expect(RULE).not.toMatch(/#sessions-list-col|\.split-list/)
    expect(RULE).not.toMatch(/overflow-x/)
  })
})
