/**
 * 7.0.1 Control Web live state (docs/live-events-contract.md): the one EventSource('/api/events') per page, run from
 * app.js itself (the "live state (7.0.1)" block, the pet block and the "live state on screen" block, sliced and run
 * with fakes for the browser and the server). Nothing here reaches a server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const INDEX = readFileSync(join(HERE, 'index.html'), 'utf8')
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1)
  if (a < 0 || b < 0) throw new Error('marker moved in app.js: ' + (a < 0 ? from : to))
  return src.slice(a, b)
}
const CORE = between(APP, '  // ── live state (7.0.1) ─', '  // ── the session pet (Today) ─')
const PET = between(APP, '  // ── the session pet (Today) ─', '  // ── Today ──')
const VIEW = between(APP, '  // ── live state on screen (7.0.1)', '  function needWhy(item) {')
const RUNROW = between(APP, '  function runRow(s, activeNow) {', '  // ── live state on screen (7.0.1)')
const SPLIT = /  function splitSessionId\(provider, id\) \{[\s\S]*?\n  \}\n/.exec(APP)![0]
const TODATE = /  function toDate\(v\) \{[\s\S]*?\n  \}\n/.exec(APP)![0]
const SPAN = /  function span\(v\) \{[\s\S]*?\n  \}\n/.exec(APP)![0]

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────────────────────
class FakeES {
  static all: FakeES[] = []
  url: string; readyState = 0; closed = false
  onmessage: ((ev: { data: string; lastEventId?: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) { this.url = url; FakeES.all.push(this) }
  close() { this.readyState = 2; this.closed = true }
  send(frame: Record<string, unknown>) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(frame) }) }
  fail(readyState = 0) { this.readyState = readyState; this.onerror?.() }
}
const open = () => FakeES.all.filter((e) => !e.closed)

interface El { id: string; textContent: string; disabled?: boolean; attrs: Record<string, string>; cls: Set<string>; innerHTML: string;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean; toggle(c: string, on?: boolean): void };
  getAttribute(k: string): string | null; setAttribute(k: string, v: string): void; querySelector(s: string): El | null; querySelectorAll(s: string): El[]; addEventListener(): void }
function el(id = ''): El {
  const cls = new Set<string>()
  const kids: Record<string, El> = {}
  const e: El = {
    id, textContent: '', attrs: {}, cls, innerHTML: '',
    classList: { add: (c) => { cls.add(c) }, remove: (c) => { cls.delete(c) }, contains: (c) => cls.has(c), toggle: (c, on) => { if (on ?? !cls.has(c)) cls.add(c); else cls.delete(c) } },
    getAttribute(k) { return this.attrs[k] ?? null }, setAttribute(k, v) { this.attrs[k] = v },
    querySelector(sel) { return kids[sel] ?? (kids[sel] = ['.pet-sprite', '.pet-caption', '.pet-btn', '.pet-still'].includes(sel) ? el() : (null as unknown as El)) },
    querySelectorAll() { return [] }, addEventListener() {},
  }
  return e
}

const sxState = (s: { agent_state?: string; state_source?: string; running_active?: boolean }) =>
  s.agent_state === 'waiting' ? 'waiting' : s.running_active || s.agent_state === 'running' ? 'running' : s.agent_state === 'ended' ? 'stale' : 'recent'

interface Opts { probe?: { status: number; type?: string } | 'network'; list?: () => unknown[]; hidden?: boolean; brief?: (body: Record<string, any>) => unknown }
function harness(o: Opts = {}) {
  FakeES.all = []
  const els: Record<string, El> = { 'app-shell': el('app-shell'), 'today-pet': el('today-pet'), 'today-live-note': el('today-live-note'), 'today-refresh': el('today-refresh'), 'sessions-list': el('sessions-list') }
  const calls = { list: 0, repaint: [] as Array<{ rows: unknown[]; structural: boolean }>, nudge: 0, probe: [] as string[], brief: [] as Record<string, unknown>[], loadToday: [] as unknown[], running: [] as unknown[][], api: [] as string[] }
  const doc = { hidden: !!o.hidden, querySelector: () => null as unknown, querySelectorAll: (_s: string) => [] as unknown[], addEventListener() {}, createElement: () => el() }
  const rows: Array<Record<string, unknown>> = []
  const SL: { data: { sessions: unknown[] } | null; at: number } = { data: { sessions: rows }, at: Date.now() }
  const state: Record<string, unknown> = { pane: 'today', sessions: rows }
  const TODAY: Record<string, unknown> = { at: Date.now(), offline: false, sessionsState: 'answered', working: [], open: [], model: { rows: [], later: [], failed: [], states: {} } }
  const BRIEF: Record<string, unknown> = { view: null, inflight: false, sentKey: '', sentAt: 0 }
  const deps: Record<string, unknown> = {
    $: (id: string) => els[id] ?? null,
    document: doc,
    window: { matchMedia: () => ({ matches: true, addEventListener() {} }), COSWeb: { sessionQuestions: { itemsFor: () => [] } } },
    EventSource: FakeES,
    AbortController,
    fetch: (url: string) => {
      calls.probe.push(url)
      if (o.probe === 'network') return Promise.reject(new TypeError('Failed to fetch'))
      const p = o.probe ?? { status: 404, type: 'text/html' }
      return Promise.resolve({ status: p.status, headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? p.type ?? 'application/json' : null) } })
    },
    SL, state, TODAY, BRIEF,
    SX: { rows: null, view: 'sessions' },
    SX_CLOCK: { skew: 0 },
    sxServerTime: (t: number) => t,
    sessionList: (_max: number) => {
      calls.list++
      const next = { sessions: o.list ? o.list() : rows.slice() }
      SL.data = next; SL.at = Date.now()
      return Promise.resolve(next)
    },
    questionsNudge: () => { calls.nudge++ },
    providerLabel: (p: string) => ({ claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' } as Record<string, string>)[p] || 'Session',
    console,
    // the pet block's own needs
    api: (url: string, opts?: { body?: Record<string, unknown> }) => {
      calls.api.push(url)
      if (url === '/api/today/brief') { calls.brief.push({ ...opts!.body! }); return Promise.resolve(o.brief ? o.brief(opts!.body!) : { state: 'fresh', text: 'All quiet.', at: new Date().toISOString() }) }
      return Promise.resolve({ available: true, pet: 'mac', kind: 'still', poses: {}, still: '/s' })
    },
    esc: (s: string) => String(s),
    readStore: () => ({}), writeStore: () => {},
    sxState,
    Image: class { onload?: () => void; set src(_v: string) { setTimeout(() => this.onload?.(), 0) } },
    // the view block's needs
    renderRunning: (w: unknown[]) => { calls.running.push(w) },
    paintNeeds: () => {}, setBadge: () => {}, renderStory: () => {},
    sxQueryActive: () => false, renderSessionGroups: () => {}, paintSessionsHero: () => {}, sxAmbiguous: () => ({}), sxVisible: () => [], sxRow: () => '', sxKeepWarm: () => false,
    loadToday: (force: unknown) => { calls.loadToday.push(force); return Promise.resolve() },
    briefInputs: () => ({ sessions: [], needs: [] }),
    setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    setInterval: (...a: Parameters<typeof setInterval>) => setInterval(...a),
    clearInterval: (t: ReturnType<typeof setInterval>) => clearInterval(t),
    Promise, JSON, Math, Number, String, Object, Array, isFinite, encodeURIComponent,
  }
  const src = 'with (deps) {\n' + SPLIT + TODATE + CORE + PET + VIEW +
    '\nvar __realRepaint = liveRepaint; liveRepaint = function (r, s) { deps.__calls.repaint.push({ rows: r, structural: s }); return __realRepaint(r, s); };' +
    '\nreturn { LIVE: LIVE, liveOpen: liveOpen, liveStart: liveStart, liveResume: liveResume, liveHide: liveHide, liveFrame: liveFrame, liveAge: liveAge, liveClock: liveClock, liveElapsed: liveElapsed,' +
    ' liveTickOnce: liveTickOnce, liveTickStart: liveTickStart, liveOn: liveOn, liveSince: liveSince, todayRefresh: todayRefresh, liveNoteText: liveNoteText, petPose: petPose, petCaption: petCaption, TR: TR };\n}'
  deps.__calls = calls
  const kit = new Function('deps', src)(deps)
  return { kit, els, calls, rows, state, SL, TODAY, BRIEF, doc, deps }
}
const SID = '8c1d2f9e-1111-2222-3333-444455556666'
const live = (over: Record<string, unknown> = {}) => ({ provider: 'claude', sessionId: SID, state: 'working', startedAt: 1, turnStartedAt: Date.now() - 65000, updatedAt: Date.now(), replies: 0, questions: 0, queued: 0, source: 'hook', ...over })
const snap = (sessions: unknown[], seq = 1, epoch = 100, extra: Record<string, unknown> = {}) => ({ kind: 'snapshot', seq, epoch, at: Date.now(), sessions, questions: { total: 0, approvals: 0, bySession: [] }, queue: { total: 0, bySession: [] }, degraded: { registry: false, questions: false, queue: false }, ...extra })

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-11-08T05:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

describe('7.0.1: one live stream per page', () => {
  it('starting twice, coming back and going online while it is open never opens a second stream', () => {
    const h = harness()
    h.kit.liveStart(); h.kit.liveStart(); h.kit.liveResume(); h.kit.liveResume()
    expect(FakeES.all.length).toBe(1)
    expect(FakeES.all[0].url).toBe('/api/events')
    // A retry timer that fires while a stream is already open (the one place that opens) opens nothing.
    h.kit.liveOpen(); h.kit.liveOpen()
    expect(FakeES.all.length).toBe(1)
  })
  it('a hidden page opens nothing, and hiding closes the stream', () => {
    const h = harness({ hidden: true })
    h.kit.liveStart()
    expect(FakeES.all.length).toBe(0)
    h.doc.hidden = false; h.kit.liveResume()
    expect(open().length).toBe(1)
    h.doc.hidden = true; h.kit.liveHide()
    expect(open().length).toBe(0)
  })
})

describe('7.0.1: the pet and the rows follow the stream', () => {
  it('a session going to working moves its row, the Running list and the pet caption, without a list read', async () => {
    const h = harness()
    h.rows.push({ provider: 'claude', session_id: SID, title: 'Build', running: true, running_active: false, agent_state: 'idle', state_source: 'hook', alive: true })
    h.kit.liveStart()
    const es = FakeES.all[0]
    es.send(snap([live({ state: 'idle', turnStartedAt: null })]))
    await vi.advanceTimersByTimeAsync(40)
    expect(h.kit.petCaption(h.kit.petPose(h.state.sessions))).toBe('Nothing running')
    const listsBefore = h.calls.list
    es.send({ kind: 'session', seq: 2, epoch: 100, at: Date.now(), change: 'updated', session: live() })
    await vi.advanceTimersByTimeAsync(40)
    expect(h.rows[0].running_active).toBe(true)
    expect(h.kit.petCaption(h.kit.petPose(h.state.sessions))).toBe('1 running')
    expect(h.calls.running.at(-1)!.length).toBe(1)
    expect(h.calls.list).toBe(listsBefore)   // the state came from the frame; no list read for a known session
    expect(h.els['today-pet'].querySelector('.pet-caption')!.textContent).toBe('1 running')
  })
  it('a session the list has not caught up with counts at once (a placeholder row) and asks for one fresh list', async () => {
    const h = harness()
    h.kit.liveStart()
    FakeES.all[0].send(snap([live()]))
    await vi.advanceTimersByTimeAsync(40)
    expect(h.kit.petCaption(h.kit.petPose(h.state.sessions))).toBe('1 running')
    expect((h.state.sessions as Array<Record<string, unknown>>)[0]._placeholder).toBe(true)
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.calls.list).toBeGreaterThan(0)
  })
  it('the list row with the 8-character Claude id joins its live session (the contract join)', async () => {
    const h = harness()
    h.rows.push({ provider: 'claude', session_id: SID.slice(0, 8), title: 'Tab', running: true, agent_state: 'idle' })
    h.kit.liveStart()
    FakeES.all[0].send(snap([live()]))
    await vi.advanceTimersByTimeAsync(40)
    expect(h.rows[0].running_active).toBe(true)
    expect(h.rows.length).toBe(1)
  })
  it('session.removed ends a row the stream spoke for; a whole snapshot never touches a row it never spoke for', async () => {
    const h = harness()
    h.rows.push({ provider: 'claude', session_id: SID, running: true, running_active: false, agent_state: 'idle' })
    h.rows.push({ provider: 'codex', session_id: 'cx-1', running: true, running_active: true, agent_state: 'running' })
    h.kit.liveStart()
    const es = FakeES.all[0]
    es.send(snap([live()]))
    await vi.advanceTimersByTimeAsync(40)
    es.send({ kind: 'session.removed', seq: 2, epoch: 100, at: Date.now(), provider: 'claude', sessionId: SID })
    await vi.advanceTimersByTimeAsync(40)
    expect(h.rows[0].running_active).toBe(false)
    expect(h.rows[0].running).toBe(false)
    expect(h.rows[1].running_active).toBe(true)   // a Codex session whose hooks never reach the server stays as listed
  })
  it('a questions frame asks the question cards to read now (questions.js keeps its own poll)', () => {
    const h = harness()
    h.kit.liveStart()
    FakeES.all[0].send(snap([]))
    const before = h.calls.nudge
    FakeES.all[0].send({ kind: 'questions', seq: 2, epoch: 100, at: Date.now(), total: 1, approvals: 0, bySession: [] })
    expect(h.calls.nudge).toBe(before + 1)
  })
})

describe('7.0.1: the running clock ticks locally', () => {
  it('counts from turnStartedAt, corrected by the frame clock, every second; a hidden page is left alone', async () => {
    const h = harness()
    h.kit.liveStart()
    // The Mac's clock is 10 s behind this phone: `at` says so, and the clock must not run 10 s fast.
    FakeES.all[0].send(snap([], 1, 100, { at: Date.now() - 10000 }))
    const clock = el(); clock.attrs['data-live-since'] = String(Date.now() - 10000 - 65000)
    h.doc.querySelectorAll = () => [clock]
    h.kit.liveTickStart()
    await vi.advanceTimersByTimeAsync(1000)
    expect(clock.textContent).toBe('1m 6s')
    await vi.advanceTimersByTimeAsync(1000)
    expect(clock.textContent).toBe('1m 7s')
    h.doc.hidden = true
    await vi.advanceTimersByTimeAsync(3000)
    expect(clock.textContent).toBe('1m 7s')
    h.doc.hidden = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(clock.textContent).toBe('1m 11s')
  })
  it('the format: seconds, minutes and seconds, hours and minutes', () => {
    const h = harness()
    expect(h.kit.liveClock(9)).toBe('9s')
    expect(h.kit.liveClock(252)).toBe('4m 12s')
    expect(h.kit.liveClock(3900)).toBe('1h 5m')
  })
})

describe('7.0.1: reconnect, poll, resume', () => {
  it('30 s with no frame: Reconnecting, the list every 5 s, the stream reopened with ?after=<epoch>.<seq>, then live again', async () => {
    const h = harness()
    h.kit.liveStart()
    const first = FakeES.all[0]
    first.send(snap([], 7, 1762578000123))
    first.send({ kind: 'heartbeat', seq: 7, epoch: 1762578000123, at: Date.now() })
    expect(h.kit.LIVE.mode).toBe('live')
    await vi.advanceTimersByTimeAsync(31000)
    await vi.advanceTimersByTimeAsync(4000)
    expect(first.closed).toBe(true)
    expect(h.kit.LIVE.mode).toBe('reconnecting')
    expect(h.els['today-live-note'].textContent).toMatch(/^Reconnecting/)
    expect(open().length).toBe(0)
    await vi.advanceTimersByTimeAsync(3100)   // the first retry waits 3 s
    const second = open()[0]
    expect(second.url).toBe('/api/events?after=' + encodeURIComponent('1762578000123.7'))
    const before = h.calls.list
    await vi.advanceTimersByTimeAsync(10000)
    expect(h.calls.list - before).toBeGreaterThanOrEqual(2)
    second.send({ kind: 'resume', seq: 7, epoch: 1762578000123, at: Date.now(), replayed: 0 })
    expect(h.kit.LIVE.mode).toBe('live')
    const after = h.calls.list
    await vi.advanceTimersByTimeAsync(10000)
    expect(h.calls.list).toBe(after)   // live again: the 5 s list read stopped
    expect(h.kit.LIVE.poll).toBe(null)   // and its timer is gone, not idling every 5 s
  })
  it('a stream that errors before any frame but probes as a working stream (200 text/event-stream) reconnects, never 7.0.0 mode', async () => {
    const h = harness({ probe: { status: 200, type: 'text/event-stream' } })
    h.kit.liveStart()
    FakeES.all[0].fail(2)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.kit.LIVE.mode).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(3100)
    expect(open().length).toBe(1)
  })
  it('a stream that errors before any frame and probes as a network failure reconnects with polling', async () => {
    const h = harness({ probe: 'network' })
    h.kit.liveStart()
    FakeES.all[0].fail(0)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.kit.LIVE.mode).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(3000)
    expect(open().length).toBe(1)
  })
  it('a frame with a seq gap reopens from the last applied id; a new epoch starts fresh', () => {
    const h = harness()
    h.kit.liveStart()
    FakeES.all[0].send(snap([], 3, 100))
    FakeES.all[0].send({ kind: 'session', seq: 5, epoch: 100, at: Date.now(), change: 'updated', session: live() })
    expect(FakeES.all[0].closed).toBe(true)
    expect(FakeES.all[1].url).toBe('/api/events?after=100.3')
    FakeES.all[1].send({ kind: 'heartbeat', seq: 3, epoch: 200, at: Date.now() })
    expect(FakeES.all[2].url).toBe('/api/events')
  })
})

describe('7.0.1: Last-Event-ID resume', () => {
  it('hidden then visible again: the list is read at once and the stream resumes from the last id', async () => {
    const h = harness()
    h.kit.liveStart()
    FakeES.all[0].send(snap([], 41, 9))
    FakeES.all[0].send({ kind: 'queue', seq: 42, epoch: 9, at: Date.now(), total: 1, bySession: [] })
    h.doc.hidden = true; h.kit.liveHide()
    expect(FakeES.all[0].closed).toBe(true)
    h.doc.hidden = false
    const before = h.calls.list
    h.kit.liveResume()
    expect(h.calls.list).toBe(before + 1)
    expect(open()[0].url).toBe('/api/events?after=9.42')
  })
})

describe('7.0.1: counts from an old cache say how old they are', () => {
  it('"As of 2 min ago" while not live; nothing while live; nothing with no stream at all', async () => {
    const h = harness()
    h.kit.liveStart()
    FakeES.all[0].send(snap([], 1, 1))
    expect(h.kit.liveAge()).toBe('')
    h.kit.LIVE.mode = 'reconnecting'
    h.kit.LIVE.freshAt = Date.now() - 125000; h.kit.LIVE.frameAt = Date.now() - 125000
    expect(h.kit.liveAge()).toBe('As of 2 min ago')
    expect(h.kit.liveNoteText()).toBe('Reconnecting. As of 2 min ago')
    h.kit.LIVE.freshAt = Date.now() - 20000
    expect(h.kit.liveAge()).toBe('')
    h.kit.LIVE.freshAt = Date.now() - 45000
    expect(h.kit.liveAge()).toBe('As of 45 s ago')
    h.kit.LIVE.mode = 'absent'
    expect(h.kit.liveAge()).toBe('')
  })
  it('a degraded registry is not live: its counts age even while frames arrive', () => {
    const h = harness()
    h.kit.liveStart()
    h.kit.LIVE.freshAt = Date.now() - 90000
    FakeES.all[0].send(snap([], 1, 1, { degraded: { registry: true, questions: false, queue: false } }))
    expect(h.kit.liveAge()).toBe('As of 1 min ago')
  })
})

describe('7.0.1: Today Refresh', () => {
  it('re-reads all of Today, asks for a summary with force, shows Updating then Updated just now', async () => {
    const h = harness()
    const p = h.kit.todayRefresh()
    expect(h.kit.liveNoteText()).toBe('Updating')
    expect(h.els['today-refresh'].disabled).toBe(true)
    await p
    expect(h.calls.loadToday).toEqual([true])
    expect(h.calls.brief.length).toBe(1)
    expect(h.calls.brief[0].force).toBe(true)
    expect(h.kit.liveNoteText()).toBe('Updated just now')
    expect(h.els['today-refresh'].disabled).toBe(false)
    expect(h.BRIEF.inflight).toBe(false)
  })
  it('the server’s refresh limit shows as a countdown; its daily cap in plain words', async () => {
    const t = harness({ brief: () => ({ state: 'stale', text: 'Old.', at: null, reason: 'refresh_throttled', retryAfterMs: 20000 }) })
    await t.kit.todayRefresh()
    expect(t.kit.liveNoteText()).toBe('Updated just now. Try again in 20 s')
    await vi.advanceTimersByTimeAsync(5000)
    expect(t.kit.liveNoteText()).toBe('Updated just now. Try again in 15 s')
    const c = harness({ brief: () => ({ state: 'stale', text: 'Old.', at: null, reason: 'daily_cap' }) })
    await c.kit.todayRefresh()
    expect(c.kit.liveNoteText()).toBe('Updated just now. Daily summary limit reached')
  })
  it('with the summary switched off it refreshes the state only', async () => {
    const h = harness()
    h.BRIEF.view = { state: 'off', reason: 'switch_off', enabled: false, text: '' }
    await h.kit.todayRefresh()
    expect(h.calls.loadToday).toEqual([true])
    expect(h.calls.brief.length).toBe(0)
    expect(h.kit.liveNoteText()).toBe('Updated just now')
  })
  it('a 7.0.0 server that refuses `force` (400 invalid_today_brief) is asked the ordinary way, and the summary still updates', async () => {
    const h = harness({ brief: (b) => { if (b.force) { const e: any = new Error('That is not a Today summary request.'); e.status = 400; e.code = 'invalid_today_brief'; return Promise.reject(e) } return { state: 'fresh', text: 'Quiet.', at: new Date().toISOString() } } })
    await h.kit.todayRefresh()
    expect(h.calls.brief.length).toBe(2)
    expect('force' in h.calls.brief[1]).toBe(false)
    expect(h.kit.liveNoteText()).toBe('Updated just now')
  })
  it('a second tap while one runs does nothing', async () => {
    const h = harness()
    const a = h.kit.todayRefresh(), b = h.kit.todayRefresh()
    await Promise.all([a, b])
    expect(h.calls.loadToday.length).toBe(1)
  })
  it('Today’s header carries the Refresh button with a 44 px target and a status line', () => {
    expect(INDEX).toMatch(/<button type="button" id="today-refresh" class="link-btn today-refresh" data-today-refresh>Refresh<\/button>/)
    expect(INDEX).toMatch(/id="today-live-note"[^>]*role="status"/)
    const css = readFileSync(join(HERE, 'panes/today-actions.css'), 'utf8')
    expect(css).toMatch(/\.today-refresh \{[^}]*min-height: 44px/)
  })
})

describe('7.0.1: no stream means 7.0.0 behaviour', () => {
  for (const [label, probe] of [['404 (an older server, or COS_WEB_LIVE_EVENTS=0)', { status: 404, type: 'text/html' }], ['401', { status: 401 }], ['a 200 that is not a stream', { status: 200, type: 'text/html' }]] as const) {
    it(`${label}: no stream, no extra timer, no list read, no label, no repaint`, async () => {
      const h = harness({ probe })
      h.kit.liveStart()
      FakeES.all[0].fail(2)
      await vi.advanceTimersByTimeAsync(10)
      expect(h.kit.LIVE.mode).toBe('absent')
      expect(h.kit.liveOn()).toBe(false)
      await vi.advanceTimersByTimeAsync(120000)
      expect(h.calls.list).toBe(0)
      expect(FakeES.all.length).toBe(1)
      expect(h.calls.repaint.length).toBe(0)
      expect(h.kit.liveAge()).toBe('')
      expect(h.els['today-live-note'].textContent).toBe('')
      // Coming back within ten minutes: still nothing new.
      h.kit.liveResume()
      expect(FakeES.all.length).toBe(1)
      expect(h.calls.list).toBe(0)
    })
  }
  it('503: the server is full, so no fast polling, and one more try after 30 s', async () => {
    const h = harness({ probe: { status: 503 } })
    h.kit.liveStart()
    FakeES.all[0].fail(2)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.kit.LIVE.mode).toBe('busy')
    await vi.advanceTimersByTimeAsync(29000)
    expect(h.calls.list).toBe(0)
    expect(open().length).toBe(0)
    await vi.advanceTimersByTimeAsync(1100)
    expect(open().length).toBe(1)
  })
  it('the Running rows render exactly as 7.0.0 did when the stream is not live', () => {
    const base = execFileSync('git', ['show', 'ef71c9c:server/web-control/app.js'], { cwd: HERE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const OLD = between(base, '  function runRow(s, activeNow) {', '  function needWhy(item) {')
    const make = (src: string, liveIsOn: boolean) => {
      const els: Record<string, { textContent: string; innerHTML: string; querySelector: () => null }> = { 'run-count': { textContent: '', innerHTML: '', querySelector: () => null }, 'run-list': { textContent: '', innerHTML: '', querySelector: () => null } }
      const deps = {
        $: (id: string) => els[id], esc: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'), badge: (p: string) => '<b>' + p + '</b>', sessionTitle: (s: { title?: string }) => s.title || 'Untitled session',
        usualProject: () => 'p', countWord: (n: number) => String(n), TODAY: { sessionsState: 'answered' }, Date, Math, String, isFinite,
        liveOn: () => liveIsOn, liveSince: () => 12345, liveClock: () => '5m 0s', liveElapsed: () => 300, liveTickStart: () => {},
        // keep the block's own view code inert: only runRow and renderRunning are called
      }
      const body = src.indexOf('  // ── live state on screen (7.0.1)') > 0 ? src.slice(0, src.indexOf('  // ── live state on screen (7.0.1)')) : src
      return new Function('deps', 'with (deps) {\n' + SPLIT + TODATE + SPAN + body + '\nreturn { runRow: runRow, renderRunning: renderRunning, els: deps.$ };\n}')(deps) as { runRow: (s: unknown, a: boolean) => string; renderRunning: (w: unknown[], o: unknown[]) => void }
    }
    const now = Date.now()
    const working = [{ provider: 'claude', session_id: 'a', title: 'One', running: true, running_active: true, state_since: new Date(now - 5 * 60000).toISOString(), project: 'other' }]
    const quiet = [{ provider: 'codex', session_id: 'b', title: 'Two', running: true, running_active: false, last_activity_at: new Date(now - 3 * 3600000).toISOString() }]
    const oldKit = make(OLD, false), newKit = make(RUNROW, false)
    expect(newKit.runRow(working[0], true)).toBe(oldKit.runRow(working[0], true))
    expect(newKit.runRow(quiet[0], false)).toBe(oldKit.runRow(quiet[0], false))
    expect(newKit.runRow(working[0], true)).toContain('Working for 5 min')
    // Live: the same row carries the ticking clock instead.
    const liveKit = make(RUNROW, true)
    expect(liveKit.runRow(working[0], true)).toContain('data-live-since="12345"')
    expect(liveKit.runRow(quiet[0], false)).toBe(oldKit.runRow(quiet[0], false))   // a quiet row never ticks
  })
  it('ten minutes after finding no stream, coming back tries once more, and reads nothing else', async () => {
    const h = harness({ probe: { status: 404, type: 'text/html' } })
    h.kit.liveStart()
    FakeES.all[0].fail(2)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.kit.LIVE.mode).toBe('absent')
    await vi.advanceTimersByTimeAsync(10 * 60000 + 1000)
    h.kit.liveResume()
    expect(FakeES.all.length).toBe(2)
    expect(h.calls.list).toBe(0)
  })
  it('a list read is corrected by the live model only while the stream is live (app.js sessionList)', async () => {
    const SLSRC = between(APP, '  var SL = { data: null', '  function sessionListCached')
    for (const on of [true, false]) {
      const overlaid: unknown[] = []
      const deps = { api: () => Promise.resolve({ sessions: [{ provider: 'claude', session_id: 'x' }] }), noteWaiting: () => {}, Date, Promise,
        liveOn: () => on, liveOverlay: (rows: unknown) => { overlaid.push(rows) } }
      const sl = new Function('deps', 'with (deps) {\n' + SLSRC + '\nreturn sessionList;\n}')(deps) as (n: number) => Promise<unknown>
      await sl(0)
      expect(overlaid.length).toBe(on ? 1 : 0)
    }
  })
  it('with the stream live, a changed Today asks for a summary at most once a minute; without it, at once as 7.0.0 did', () => {
    const SRC = between(APP, '  function requestBrief(m) {', '  /** The summary to show')
    for (const on of [true, false]) {
      const posts: unknown[] = []
      let key = 0
      const deps = {
        BRIEF: { view: { state: 'fresh' }, inflight: false, sentKey: '', sentAt: 0 }, state: { pane: 'today' }, TODAY: {}, BRIEF_OFF_RECHECK_MS: 300000, BRIEF_RESEND_MS: 300000, BRIEF_LIVE_GAP_MS: 60000,
        briefInputs: () => ({ sessions: [{ title: String(key++) }], needs: [], later: 0, sessionsRead: true, needsComplete: true, unread: [], recording: false }),
        api: (p: string) => { posts.push(p); return new Promise(() => {}) }, Date, Object, JSON, liveOn: () => on, renderStory: () => {},
      }
      const kit = new Function('deps', 'with (deps) {\n' + SRC + '\nreturn { requestBrief: requestBrief, BRIEF: BRIEF };\n}')(deps) as { requestBrief: (m: unknown) => void; BRIEF: { inflight: boolean } }
      const m = { states: {}, rows: [], later: [], failed: [] }
      kit.requestBrief(m); kit.BRIEF.inflight = false
      vi.advanceTimersByTime(20000)
      kit.requestBrief(m)
      expect(posts.length).toBe(on ? 1 : 2)
      kit.BRIEF.inflight = false
      vi.advanceTimersByTime(41000)
      kit.requestBrief(m)
      expect(posts.length).toBe(on ? 2 : 3)
    }
  })
  it('live with a start: the row carries the 1 s clock in place of the minute line', () => {
    const deps = {
      esc: (s: string) => String(s), badge: () => '', sessionTitle: () => 'One', usualProject: () => '', span: () => '5 min',
      liveOn: () => true, liveSince: () => 12345, liveClock: () => '5m 3s', liveElapsed: () => 303, splitSessionId: (p: string, id: string) => ({ provider: p, id }),
    }
    const kit = new Function('deps', 'with (deps) {\n' + RUNROW.slice(0, RUNROW.indexOf('  function renderRunning')) + '\nreturn runRow;\n}')(deps) as (s: unknown, a: boolean) => string
    const html = kit({ provider: 'claude', session_id: 'a', running_active: true }, true)
    expect(html).toContain('Working for <span class="run-clock" data-live-since="12345">5m 3s</span>')
  })
})

describe('7.0.1: Sessions rows move in place', () => {
  function rowsHarness(opts: { search?: boolean } = {}) {
    const made: string[] = []
    const mk = (key: string, html: string) => ({ key, html, parentNode: null as any, getAttribute: (k: string) => (k === 'data-session' ? key : null) })
    const a = mk('claude|a', 'old-a'), b = mk('codex|b', 'old-b')
    const parent = { kids: [a, b], replaceChild(n: any, o: any) { const i = this.kids.indexOf(o); this.kids[i] = n } }
    a.parentNode = parent; b.parentNode = parent
    const list = { querySelectorAll: () => parent.kids.slice() }
    const calls = { groups: 0, hero: 0 }
    const deps = {
      $: (id: string) => (id === 'sessions-list' ? list : null),
      sxQueryActive: () => !!opts.search, renderSessionGroups: () => { calls.groups++ }, paintSessionsHero: () => { calls.hero++ },
      sxAmbiguous: () => ({}), sxVisible: () => [], sxKeepWarm: () => false, splitSessionId: (p: string, id: string) => ({ provider: p, id }),
      sxRow: (s: { session_id: string; agent_state: string }) => { made.push(s.session_id); return '<row ' + s.session_id + ' ' + s.agent_state + '>' },
      document: { createElement: () => { const d: any = { set innerHTML(h: string) { d.firstElementChild = { html: h, getAttribute: () => null } } }; return d } },
    }
    const fn = new Function('deps', 'with (deps) {\n' + between(APP, '  function liveSessionRows(rows, structural) {', "  // ── Today's header line and Refresh ──") + '\nreturn liveSessionRows;\n}')(deps)
    return { fn, parent, calls, made }
  }
  it('a moved row is redrawn where it stands; the others are left alone; the counts repaint', () => {
    const h = rowsHarness()
    h.fn([{ provider: 'codex', session_id: 'b', agent_state: 'running' }], false)
    expect(h.parent.kids[0].html).toBe('old-a')
    expect(h.parent.kids[1].html).toBe('<row b running>')
    expect(h.calls.hero).toBe(1)
    expect(h.calls.groups).toBe(0)
  })
  it('a session that appeared or left redraws the list; a search on screen keeps its hits', () => {
    const h = rowsHarness()
    h.fn([], true)
    expect(h.calls.groups).toBe(1)
    const s = rowsHarness({ search: true })
    s.fn([{ provider: 'codex', session_id: 'b', agent_state: 'running' }], true)
    expect(s.calls.groups).toBe(0)
    expect(s.parent.kids[1].html).toBe('old-b')
    expect(s.calls.hero).toBe(1)
  })
})
