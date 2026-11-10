/**
 * W1 production hardening (audit 02): runs the REAL app.js blocks against fakes. Nothing reaches a Mac or a model.
 *   F7  "Find a session about this": consent per decision model, then POST /api/agent-sessions/find with { query, consentedProvider, stage }.
 *   F10 Today's Running lists COS's own jobs (GET /api/query-jobs/active) and stops only Work runs (POST /query-jobs/:id/cancel).
 *   F3  The Mac not answering: one honest line with the last update time and Retry.
 *   F2  The 7-day sign-in: a notice within a day of the end, and the reason on the sign-in card after it lapses.
 *   F23 A cold open with the Mac unreachable shows "Your Mac is not answering", not a sign-in that cannot work.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function block(startMark: string, endMark: string): string {
  const a = APP.indexOf(startMark), b = APP.indexOf(endMark)
  expect(a, startMark).toBeGreaterThan(0)
  expect(b, endMark).toBeGreaterThan(a)
  return APP.slice(a, b)
}
function store(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed))
  return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, String(v)) }, removeItem: (k: string) => { m.delete(k) }, m }
}
type Call = { path: string; method: string; body: any; timeoutMs?: number }
function fakeApi(answers: Record<string, unknown | ((body: any) => unknown)>) {
  const calls: Call[] = []
  const api = (path: string, o: { method?: string; body?: unknown; timeoutMs?: number } = {}) => {
    calls.push({ path, method: o.method ?? 'GET', body: o.body === undefined ? undefined : JSON.parse(JSON.stringify(o.body)), timeoutMs: o.timeoutMs })
    const a = answers[path]
    const v = typeof a === 'function' ? (a as (b: unknown) => unknown)(o.body) : a
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? {})
  }
  return { api, calls }
}
const fail = (status: number | undefined, message = 'refused') => Object.assign(new Error(message), status ? { status } : {})

// ── F7: meaning search ─────────────────────────────────────
const MEANING = block('  // ── Meaning search (W1', '  // ── end meaning search')
const DP = (provider: string | null, keyed = true, capable = true) => ({ effective: { search: provider }, configured: { jev: keyed, subq: keyed }, capabilities: capable ? { sessionFind: true } : {} })
const ROW = { session_id: 'aaaaaaaa-1111-4111-8111-111111111111', provider: 'claude', display_label: 'Pricing page work', strength: 'likely', probability: 0.7 }
function meaning(answers: Record<string, unknown | ((b: any) => unknown)>, seed: Record<string, string> = {}) {
  const { api, calls } = fakeApi(answers)
  const localStorage = store(seed)
  const rows: Array<{ s: any; sub: string }> = []
  const deps = { api, esc, localStorage, emptyBox: (t: string, b: string) => `<EMPTY>${t}|${b}</EMPTY>`, sessionRow: (s: any, sub: string) => { rows.push({ s, sub }); return `<ROW ${s.session_id} ${sub}>` } }
  // eslint-disable-next-line no-new-func
  const fns = new Function('deps', `with (deps) {\n${MEANING}\nreturn { findByMeaning, meaningChoose, MEANING };\n}`)(deps)
  return { fns, calls, localStorage, rows, finds: () => calls.filter(c => c.path === '/api/agent-sessions/find') }
}

describe('F7: Find a session about this', () => {
  it('asks first: the consent names what leaves the Mac and to which model, and nothing is sent', async () => {
    const h = meaning({ '/api/decision-provider': DP('subq') })
    const html = await h.fns.findByMeaning('the pricing page rounding')
    expect(html).toContain('Find sessions by meaning with SubQ?')
    expect(html).toContain('up to 508 recent sessions, to SubQ')
    expect(html).toContain('SubQ keeps what it is sent.')
    expect(html).toContain('data-action="meaning-consent" data-provider="subq" data-choice="on">Turn on')
    expect(h.finds()).toHaveLength(0)
  })
  it('after Turn on, it sends exactly { query, consentedProvider, stage: first } and draws the rows with how strong each match is', async () => {
    const h = meaning({ '/api/decision-provider': DP('jev'), '/api/agent-sessions/find': { available: true, rows: [ROW], asked: 254 } })
    h.fns.meaningChoose('jev', 'on')
    const html = await h.fns.findByMeaning('the pricing page rounding')
    expect(h.finds().map(c => c.body)).toEqual([{ query: 'the pricing page rounding', consentedProvider: 'jev', stage: 'first' }])
    expect(Object.keys(h.finds()[0]!.body).sort()).toEqual(['consentedProvider', 'query', 'stage'])
    expect(html).toContain(`<ROW ${ROW.session_id} Likely match>`)
    expect(h.rows[0]!.s.provider).toBe('claude')
  })
  it('nothing in the newest 254: it looks once further back (stage full), then says how many it checked', async () => {
    const h = meaning({ '/api/decision-provider': DP('jev'), '/api/agent-sessions/find': { available: true, rows: [], asked: 508 } }, { 'cos.web.meaningConsent': '{"jev":"on"}' })
    const html = await h.fns.findByMeaning('the pricing page rounding')
    expect(h.finds().map(c => c.body.stage)).toEqual(['first', 'full'])
    expect(html).toContain('Nothing close by meaning|Checked 508 sessions.')
  })
  it('a yes for Jev is no yes for SubQ', async () => {
    const h = meaning({ '/api/decision-provider': DP('subq') }, { 'cos.web.meaningConsent': '{"jev":"on"}' })
    const html = await h.fns.findByMeaning('the pricing page rounding')
    expect(html).toContain('Find sessions by meaning with SubQ?')
    expect(h.finds()).toHaveLength(0)
  })
  it('Never sends nothing and offers Ask me again', async () => {
    const h = meaning({ '/api/decision-provider': DP('jev') }, { 'cos.web.meaningConsent': '{"jev":"never"}' })
    const html = await h.fns.findByMeaning('the pricing page rounding')
    expect(html).toContain('Meaning search is off in this browser')
    expect(html).toContain('data-choice="ask">Ask me again')
    expect(h.finds()).toHaveLength(0)
    h.fns.meaningChoose('jev', 'ask')
    expect(JSON.parse(h.localStorage.getItem('cos.web.meaningConsent')!)).toEqual({})
  })
  it('a server that cannot, or a model with no key, says so and sends nothing', async () => {
    const off = meaning({ '/api/decision-provider': DP('jev', true, false) }, { 'cos.web.meaningConsent': '{"jev":"on"}' })
    expect(await off.fns.findByMeaning('the pricing page rounding')).toContain('Meaning search is not on here')
    const nokey = meaning({ '/api/decision-provider': DP('jev', false) }, { 'cos.web.meaningConsent': '{"jev":"on"}' })
    expect(await nokey.fns.findByMeaning('the pricing page rounding')).toContain('Meaning search needs a decision model')
    expect(off.finds().length + nokey.finds().length).toBe(0)
  })
  it('a refusal from the server is said in its own words', async () => {
    const h = meaning({ '/api/decision-provider': DP('jev'), '/api/agent-sessions/find': { available: false, reason: 'cap_reached', message: 'Meaning search has used today’s budget.', rows: [] } }, { 'cos.web.meaningConsent': '{"jev":"on"}' })
    expect(await h.fns.findByMeaning('the pricing page rounding')).toContain('Meaning search is used up for today|Meaning search has used today’s budget.')
  })
  it('the consent button is wired in the click handler', () => {
    expect(APP).toContain("if (action === 'meaning-consent') { meaningChoose(t.getAttribute('data-provider'), t.getAttribute('data-choice'));")
  })
})

// ── F10: Running beyond sessions (Q1 M6: exactly the desktop's job rows, no Stop) ──
const RUNNING = block('  function renderRunning(working, open) {', '  // ── live state on screen (7.0.1)')
const JOB = (o: Record<string, unknown>) => ({ jobId: 'j-' + String(o.origin), generation: 1, origin: 'person', state: 'running', elapsedMs: 120000, title: 'A title', ...o })
function running(answers: Record<string, unknown | ((b: any) => unknown)>, opts: { hidden?: boolean; pane?: string } = {}) {
  const { api, calls } = fakeApi(answers)
  const els: Record<string, { textContent: string; innerHTML: string; querySelector: () => null }> = { 'run-count': { textContent: '', innerHTML: '', querySelector: () => null }, 'run-list': { textContent: '', innerHTML: '', querySelector: () => null } }
  const TODAY: any = { sessionsState: 'answered', working: [], open: [] }
  const timers: Array<() => void> = []
  const deps = { api, esc, plain: (s: unknown) => String(s ?? ''), clock: (d: Date) => `T${d.getHours()}`, $: (id: string) => els[id], TODAY, state: { pane: opts.pane ?? 'today' },
    document: { hidden: !!opts.hidden }, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length }, clearTimeout: () => {},
    runRow: (s: any) => `<SESSION ${s.id}>`, countWord: (n: number) => String(n), liveTickStart: undefined }
  // eslint-disable-next-line no-new-func
  const fns = new Function('deps', `with (deps) {\n${RUNNING}\nreturn { renderRunning, loadRunJobs, runJobsSchedule, RUN_JOBS };\n}`)(deps)
  return { fns, calls, els, TODAY, timers, deps }
}

describe('F10: Today’s Running lists COS’s own jobs as the Mac does (Q1 M6)', () => {
  it('a question, a routine and a captured task each get the desktop’s row; a Work session or review (other) gets none; no Stop anywhere', async () => {
    const h = running({ '/api/query-jobs/active': { protocolVersion: 1, enabled: true, items: [JOB({ origin: 'person', title: '' }), JOB({ origin: 'routine' }), JOB({ origin: 'task', title: 'Fix the price table' }), JOB({ origin: 'other', title: 'Control Work session' })] } })
    await h.fns.loadRunJobs()
    h.fns.renderRunning([{ id: 's1' }], [])
    const html = h.els['run-list']!.innerHTML
    expect(h.els['run-count']!.textContent).toBe('4')
    expect(html).toContain('A question to COS')
    expect(html).toContain('COS is answering, 2 min')
    expect(html).toContain('running since T')
    expect(html).toContain('a captured task, on the server, 2 min')
    expect(html).toContain('Fix the price table')
    expect(html).not.toContain('Control Work session')
    expect(html).not.toMatch(/Stop|cancel|data-job=/)
    expect(html).toContain('data-goto="messages">Open in Messages')
    expect(html).toContain('data-goto="sessions">In Sessions')
    expect(html).toContain('<SESSION s1>')
  })
  it('an older server (no protocol, or an error) adds nothing and says nothing', async () => {
    const old = running({ '/api/query-jobs/active': fail(400, 'invalid_job_id') })
    await old.fns.loadRunJobs()
    old.fns.renderRunning([], [])
    expect(old.els['run-list']!.innerHTML).toContain('Nothing running')
    const off = running({ '/api/query-jobs/active': { protocolVersion: 1, enabled: false, items: [JOB({ origin: 'task' })] } })
    await off.fns.loadRunJobs()
    off.fns.renderRunning([], [])
    expect(off.els['run-list']!.innerHTML).not.toContain('run-job')
  })
  it('a session read that failed still shows the jobs and the retry, never "Nothing running"', async () => {
    const h = running({ '/api/query-jobs/active': { protocolVersion: 1, enabled: true, items: [JOB({ origin: 'person' })] } })
    await h.fns.loadRunJobs()
    h.TODAY.sessionsState = 'failed'
    h.fns.renderRunning([], [])
    expect(h.els['run-list']!.innerHTML).toContain('COS is answering')
    expect(h.els['run-list']!.innerHTML).toContain('Couldn’t read sessions')
  })
  it('the 15 s re-read runs only while Today is in front and visible (Q1 R5)', async () => {
    const items = { protocolVersion: 1, enabled: true, items: [JOB({ origin: 'person' })] }
    const hidden = running({ '/api/query-jobs/active': items }, { hidden: true })
    await hidden.fns.loadRunJobs()
    hidden.fns.runJobsSchedule()
    expect(hidden.timers).toHaveLength(1)
    hidden.timers[0]!()
    await flush()
    expect(hidden.calls.filter(c => c.path === '/api/query-jobs/active'), 'hidden: no read').toHaveLength(1)
    const other = running({ '/api/query-jobs/active': items }, { pane: 'work' })
    await other.fns.loadRunJobs(); other.fns.runJobsSchedule(); other.timers[0]!(); await flush()
    expect(other.calls.filter(c => c.path === '/api/query-jobs/active'), 'another pane: no read').toHaveLength(1)
    const shown = running({ '/api/query-jobs/active': items })
    await shown.fns.loadRunJobs(); shown.fns.runJobsSchedule(); shown.timers[0]!(); await flush()
    expect(shown.calls.filter(c => c.path === '/api/query-jobs/active'), 'in front: reads again').toHaveLength(2)
  })
})

// ── F3 and F2: the Mac not answering, and the sign-in ending ──
const CONN = block('  // ── Mac reachability and sign-in lifetime (W1', '  // ── end Mac reachability and sign-in lifetime')
function conn(opts: { up?: boolean | null; lastUpAt?: number; health?: unknown; seed?: Record<string, string>; navigator?: unknown } = {}) {
  const { api, calls } = fakeApi({ '/api/health': opts.health ?? { ok: true } })
  const box = { innerHTML: '', hidden: true }
  const SERVER: any = { up: opts.up ?? true, hooks: [], lastUpAt: opts.lastUpAt ?? 0 }
  let routed = 0
  const timers: Array<() => void> = []
  const deps = { api, esc, clock: (d: Date) => `T${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`, $: (id: string) => (id === 'conn-notice' ? box : null), SERVER,
    noteServer: (up: boolean) => { SERVER.up = up }, route: () => { routed++ }, document: { hidden: false }, localStorage: store(opts.seed), navigator: opts.navigator ?? { onLine: true },
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length }, clearTimeout: () => {} }
  // eslint-disable-next-line no-new-func
  const fns = new Function('deps', `with (deps) {\n${CONN}\nreturn { connPaint, connRetry, signinRemember, signinLapsedCopy, CONN };\n}`)(deps)
  return { fns, box, SERVER, calls, routed: () => routed, timers, localStorage: deps.localStorage }
}

describe('F3: the Mac not answering', () => {
  it('says so in one line, with when it last heard from the Mac, and offers Retry', () => {
    const at = new Date(); at.setHours(9, 5, 0, 0)
    const h = conn({ up: false, lastUpAt: at.getTime() })
    h.fns.connPaint()
    expect(h.box.hidden).toBe(false)
    expect(h.box.innerHTML).toContain('COS on your Mac is not answering.')
    expect(h.box.innerHTML).toContain('Last updated T9:05.')
    // Q1 M1: the page cannot tell a sleeping Mac from this device off the network, so it names both.
    expect(h.box.innerHTML).toContain('Your Mac may be asleep, or this device may be offline or off Tailscale.')
    expect(h.box.innerHTML).toContain('data-action="conn-retry"')
  })
  it('nothing shows while the Mac answers', () => {
    const h = conn({ up: true })
    h.fns.connPaint()
    expect(h.box.hidden).toBe(true)
    expect(h.box.innerHTML).toBe('')
  })
  it('Retry asks the public health route; an answer reloads the pane on screen', async () => {
    const h = conn({ up: false })
    await h.fns.connRetry(true)
    expect(h.calls.map(c => [c.path, c.timeoutMs])).toEqual([['/api/health', 10000]])
    expect(h.routed()).toBe(1)
  })
  it('Retry with no answer keeps the line and checks again later, never reloading', async () => {
    const h = conn({ up: false, health: fail(undefined, 'Could not reach COS on your Mac.') })
    await h.fns.connRetry(true)
    expect(h.routed()).toBe(0)
    expect(h.box.innerHTML).toContain('COS on your Mac is not answering.')
    expect(h.timers.length).toBe(1)
  })
  it('the browser itself says it is offline: the line says so plainly (Q1 M1)', () => {
    const h = conn({ up: false, navigator: { onLine: false } })
    h.fns.connPaint()
    expect(h.box.innerHTML).toContain('This device is offline.')
    expect(h.box.innerHTML).toContain('Connect to the internet and Tailscale, then try again.')
  })
  it('the page has the place for the line, and every hook repaints it', () => {
    expect(HTML).toContain('<div id="conn-notice" class="conn-notice" hidden></div>')
    expect(CONN).toContain('SERVER.hooks.push(function () { connPaint(); connSchedule(); });')
  })
})

describe('F2: sign-in renews while in use, up to 30 days', () => {
  const H = 3600000, D = 24 * H
  it('with a cap: no notice while it can still renew, a notice in the last day before the cap', () => {
    const h = conn()
    h.fns.signinRemember({ expiresAt: new Date(Date.now() + 5 * H).toISOString(), renewUntil: new Date(Date.now() + 20 * D).toISOString() })
    h.fns.connPaint()
    expect(h.box.hidden, 'the cookie ends soon but the next request renews it').toBe(true)
    h.fns.signinRemember({ expiresAt: new Date(Date.now() + 5 * H).toISOString(), renewUntil: new Date(Date.now() + 5 * H).toISOString() })
    h.fns.connPaint()
    expect(h.box.innerHTML).toContain('Sign-in here ends ')
    expect(h.box.innerHTML).toContain('Sign in again before then from COS Control Settings on your Mac: Open COS on your phone.')
    expect(h.box.innerHTML).toContain('data-action="conn-hide-signin"')
  })
  it('a server without renewal (no cap): the cookie end is the end, as before', () => {
    const h = conn()
    h.fns.signinRemember({ expiresAt: new Date(Date.now() + 5 * H).toISOString() })
    h.fns.connPaint()
    expect(h.box.innerHTML).toContain('Sign-in here ends ')
    const far = conn()
    far.fns.signinRemember({ expiresAt: new Date(Date.now() + 3 * D).toISOString() })
    far.fns.connPaint()
    expect(far.box.hidden).toBe(true)
  })
  it('the sign-in card says why it ended: the 30 days, a week without use, or a sign-out', () => {
    const past = new Date(Date.now() - 1000).toISOString(), later = new Date(Date.now() + 10 * D).toISOString()
    const cap = conn(); cap.fns.signinRemember({ expiresAt: past, renewUntil: past })
    expect(cap.fns.signinLapsedCopy()).toMatch(/^Your sign-in on this browser reached its 30 days\. On your Mac, open COS Control Settings and choose Open COS on your phone\./)
    const idle = conn(); idle.fns.signinRemember({ expiresAt: past, renewUntil: later })
    expect(idle.fns.signinLapsedCopy()).toMatch(/^Your sign-in on this browser ended after a week without use\./)
    const out = conn(); out.fns.signinRemember({ expiresAt: later, renewUntil: later })
    expect(out.fns.signinLapsedCopy()).toMatch(/^This browser is signed out\./)
    expect(CONN).not.toMatch(/Glasses and iPhone|Glasses, phone and web/)
  })
  it('what it knew is kept for the next load, and the earlier page’s stored expiry still reads', () => {
    const h = conn()
    h.fns.signinRemember({ expiresAt: new Date(Date.now() - 1000).toISOString(), renewUntil: new Date(Date.now() - 1000).toISOString() })
    const next = conn({ seed: { 'cos.web.signinEnds': h.localStorage.getItem('cos.web.signinEnds')! } })
    expect(next.fns.signinLapsedCopy()).toMatch(/reached its 30 days/)
    const old = conn({ seed: { 'cos.web.signinEnds': String(Date.now() - 1000) } })
    expect(old.fns.signinLapsedCopy()).toMatch(/^Your sign-in on this browser ended\. Sign-ins last 7 days\./)
  })
  it('a renewed response feeds the notice; the card tells the truth about how long', () => {
    expect(APP).toContain("res.headers.get('X-COS-Web-Session')")
    expect(APP).toContain("signinRemember({ expiresAt: rt[0], renewUntil: rt[1] })")
    expect(HTML).toContain('You stay signed in while you use COS here, for up to 30 days.')
    expect(HTML).not.toContain('stays connected for 7 days')
    expect(APP).toContain("showAuth(typeof signinLapsedCopy === 'function' && signedInOnce() ? signinLapsedCopy() : undefined)")
    expect(APP).toContain("if (typeof signinRemember === 'function') signinRemember(info);")
  })
})

describe('F23: a cold open with the Mac unreachable (Q1 M1, M2, S2)', () => {
  function bootWith(answers: Array<Error | Record<string, unknown>>, opts: { hidden?: boolean; known?: boolean } = {}) {
    const boot = block('  function boot() {', '  if (document.readyState')
    const calls: string[] = []
    const cls = () => { const set = new Set<string>(['hidden']); return { set, toggle: (c: string, on: boolean) => { if (on) set.add(c); else set.delete(c) }, add: (c: string) => set.add(c), contains: (c: string) => set.has(c) } }
    const els: Record<string, { classList: ReturnType<typeof cls>; textContent?: string }> = { 'auth-offline': { classList: cls() }, 'auth-form': { classList: cls() }, 'auth-error': { classList: cls() },
      'auth-title': { classList: cls(), textContent: 'Connect this browser' }, 'auth-intro': { classList: cls() }, 'auth-offline-text': { classList: cls(), textContent: '' } }
    els['auth-form']!.classList.set.delete('hidden'); els['auth-intro']!.classList.set.delete('hidden')
    const timers: Array<() => void> = [], listeners: Record<string, () => void> = {}
    let n = 0
    const document = { hidden: !!opts.hidden, addEventListener: (t: string, fn: () => void) => { listeners[t] = fn } }
    const deps = {
      location: { search: '', pathname: '/control', hash: '' }, history: { replaceState: () => {} }, URLSearchParams, document,
      api: () => { calls.push('status'); const a = answers[Math.min(n++, answers.length - 1)]!; return a instanceof Error ? Promise.reject(a) : Promise.resolve(a) },
      showShell: () => calls.push('shell'), showAuth: (m?: string) => calls.push('auth:' + (m ?? '')),
      $: (id: string) => els[id] ?? null, setStatus: () => {}, UNREACHABLE_COPY: 'Could not reach COS on your Mac.',
      setTimeout: (fn: () => void) => { timers.push(fn); return timers.length }, clearTimeout: () => {},
      signinKnown: () => (opts.known ? { ends: 1, cap: 1 } : null), signinLapsedCopy: () => 'LAPSED',
    }
    // eslint-disable-next-line no-new-func
    const fns = new Function('deps', `with (deps) {\n${boot}\nreturn { boot };\n}`)(deps)
    return { fns, calls, els, timers, document, listeners }
  }
  const down = () => fail(undefined, 'Could not reach COS on your Mac.')
  it('shows the not-answering card naming both causes, and hides the sign-in form', async () => {
    const h = bootWith([down()])
    h.fns.boot(); await flush()
    expect(h.calls).toEqual(['status', 'auth:'])
    expect(h.els['auth-offline']!.classList.set.has('hidden')).toBe(false)
    expect(h.els['auth-form']!.classList.set.has('hidden')).toBe(true)
    expect(h.els['auth-title']!.textContent).toBe('COS on your Mac is not answering')
    expect(h.els['auth-offline-text']!.textContent).toBe('Your Mac may be asleep, or this device may be offline or off Tailscale. This page checks again every 30 seconds.')
  })
  it('it really checks again every 30 s while visible, and signs in when the Mac answers (Q1 M2)', async () => {
    const h = bootWith([down(), down(), { authenticated: true }])
    h.fns.boot(); await flush()
    expect(h.timers).toHaveLength(1)
    h.timers[0]!(); await flush()
    expect(h.calls.filter(c => c === 'status')).toHaveLength(2)
    h.timers[1]!(); await flush()
    expect(h.calls).toContain('shell')
  })
  it('hidden, it does not check; coming back checks at once', async () => {
    const h = bootWith([down(), { authenticated: true }])
    h.fns.boot(); await flush()
    h.document.hidden = true
    h.listeners.visibilitychange!()
    const before = h.calls.filter(c => c === 'status').length
    h.timers.forEach(fn => fn()); await flush()
    expect(h.calls.filter(c => c === 'status').length, 'a timer that fires while hidden reads nothing').toBe(before)
    h.document.hidden = false
    h.listeners.visibilitychange!(); await flush()
    expect(h.calls).toContain('shell')
  })
  it('a Mac that answered with an error is a sign-in matter: the form stays, with the reason, and nothing retries', async () => {
    const h = bootWith([fail(503, 'Not ready.')])
    h.fns.boot(); await flush()
    expect(h.calls).toEqual(['status', 'auth:Not ready.'])
    expect(h.els['auth-offline']!.classList.set.has('hidden')).toBe(true)
    expect(h.timers).toHaveLength(0)
  })
  it('a browser that was signed in before learns why on a cold open (Q1 S2)', async () => {
    const h = bootWith([{ authenticated: false, mode: 'none' }], { known: true })
    h.fns.boot(); await flush()
    expect(h.calls).toEqual(['status', 'auth:LAPSED'])
  })
  it('the card is in the page, and Try again is wired to the same read', () => {
    expect(HTML).toContain('<button type="button" class="btn primary block" id="auth-retry">Try again</button>')
    expect(APP).toContain("if (t.id === 'auth-retry') { t.disabled = true; t.textContent = 'Checking'; bootStatus()")
  })
})

// ── Q1 M4 R1: Never is stored as never, and nothing is sent after it ──
describe('Q1 R1: Never stays never', () => {
  it('choosing Never, then searching again, sends nothing to Jev or SubQ', async () => {
    const h = meaning({ '/api/decision-provider': DP('jev'), '/api/agent-sessions/find': { available: true, rows: [ROW] } })
    h.fns.meaningChoose('jev', 'never')
    expect(JSON.parse(h.localStorage.getItem('cos.web.meaningConsent')!)).toEqual({ jev: 'never' })
    const html = await h.fns.findByMeaning('the pricing page rounding')
    expect(html).toContain('Meaning search is off in this browser')
    expect(h.finds()).toHaveLength(0)
  })
  it('the consent card says the choice is for this browser only', async () => {
    const h = meaning({ '/api/decision-provider': DP('jev') })
    expect(await h.fns.findByMeaning('the pricing page rounding')).toContain('Your choice applies to this browser only.')
  })
})

// ── A5: the Mac-prompt question at the top of the session reader ──
const READER_MAC = block("  // ── At the Mac's prompt, in the session reader (W1 A5)", "  // ── end at the Mac's prompt")
function readerMac(where: { where: string; ask: string }, row: Record<string, unknown> | null, q: Record<string, unknown> | null = null) {
  const el = { innerHTML: '', hidden: true }
  const deps = { esc, $: (id: string) => (id === 'session-mac-q' ? el : null), whereFor: () => where, sessionQs: () => q,
    askedWhy: (s: any) => (s.waiting_detail ? String(s.waiting_detail) : 'Waiting for your answer'),
    state: { sessions: row ? [row] : [] }, splitSessionId: (p: string, id: string) => ({ provider: p, id }) }
  // eslint-disable-next-line no-new-func
  const fns = new Function('deps', `with (deps) {\n${READER_MAC}\nreturn { readerMacPaint };\n}`)(deps)
  return { fns, el }
}
const R = { provider: 'claude', id: 'aaaaaaaa-1111-4111-8111-111111111111' }
describe('A5: the session reader says when its question waits on the Mac', () => {
  it('words known: shown, with the one Mac line and no button', () => {
    const h = readerMac({ where: 'mac', ask: 'Ship the release notes now?' }, null)
    h.fns.readerMacPaint(R, true)
    expect(h.el.hidden).toBe(false)
    expect(h.el.innerHTML).toContain('Waiting for your answer at the Mac')
    expect(h.el.innerHTML).toContain('<blockquote class="ta-quote sx-mac-q-words">Ship the release notes now?</blockquote>')
    expect(h.el.innerHTML).toContain("Answer this at your Mac's prompt. A message sent from here does not answer it; it waits until the question is answered at the Mac.")
    expect(h.el.innerHTML).not.toContain('<button')
  })
  it('the server waiting line names the question: that is shown', () => {
    const h = readerMac({ where: 'mac', ask: '' }, { provider: 'claude', session_id: R.id, waiting_detail: 'Which branch should I use?' })
    h.fns.readerMacPaint(R, true)
    expect(h.el.innerHTML).toContain('Which branch should I use?')
    expect(h.el.innerHTML).not.toContain('sx-mac-q-none')
  })
  it('no words anywhere: says COS cannot read them', () => {
    const h = readerMac({ where: 'mac', ask: '' }, { provider: 'claude', session_id: R.id })
    h.fns.readerMacPaint(R, true)
    expect(h.el.innerHTML).toContain("COS cannot read this question's words from here. They show at the Mac's prompt.")
    expect(h.el.innerHTML).not.toContain('<blockquote')
  })
  it('nothing when the session is not waiting, or its question is answerable here', () => {
    const a = readerMac({ where: 'mac', ask: 'x' }, null)
    a.fns.readerMacPaint(R, false)
    expect(a.el.hidden).toBe(true)
    const b = readerMac({ where: 'here', ask: 'x' }, null)
    b.fns.readerMacPaint(R, true)
    expect(b.el.hidden).toBe(true)
    expect(b.el.innerHTML).toBe('')
  })
  it('the reader has the slot and paints it on open and on every status', () => {
    expect(APP).toContain('<div class="sx-mac-q" id="session-mac-q" role="status" hidden></div>')
    expect(APP).toContain("if (typeof readerMacPaint === 'function') readerMacPaint(r, sxState(d) === 'waiting');")
    expect(APP).toContain("if (typeof readerMacPaint === 'function') readerMacPaint(r, waiting);")
  })
})

describe('Settings names the Mac page as COS Control 0.5.387 does (it ships with this server)', () => {
  it('the "On your Mac" list says Glasses, phone and web', () => {
    const SETTINGS = readFileSync(join(HERE, 'panes', 'settings.js'), 'utf8')
    expect(SETTINGS).toContain("{ id: 'glasses', title: 'Glasses, phone and web',")
    expect(SETTINGS).not.toContain('Glasses and iPhone')
  })
})
