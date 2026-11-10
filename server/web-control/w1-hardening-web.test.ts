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

// ── F10: Running beyond sessions ───────────────────────────
const RUNNING = block('  function renderRunning(working, open) {', '  // ── end running beyond sessions')
const JOB = (o: Record<string, unknown>) => ({ jobId: 'j-' + String(o.origin), generation: 1, origin: 'person', state: 'running', elapsedMs: 120000, title: 'A title', ...o })
function running(answers: Record<string, unknown | ((b: any) => unknown)>) {
  const { api, calls } = fakeApi(answers)
  const els: Record<string, { textContent: string; innerHTML: string; querySelector: () => null }> = { 'run-count': { textContent: '', innerHTML: '', querySelector: () => null }, 'run-list': { textContent: '', innerHTML: '', querySelector: () => null } }
  const TODAY: any = { sessionsState: 'answered', working: [], open: [] }
  const deps = { api, esc, plain: (s: unknown) => String(s ?? ''), $: (id: string) => els[id], TODAY, state: { pane: 'today' }, document: { hidden: false },
    setTimeout: () => 0, clearTimeout: () => {}, runRow: (s: any) => `<SESSION ${s.id}>`, countWord: (n: number) => String(n), liveTickStart: undefined }
  // eslint-disable-next-line no-new-func
  const fns = new Function('deps', `with (deps) {\n${RUNNING}\nreturn { renderRunning, loadRunJobs, stopRunJob, RUN_JOBS };\n}`)(deps)
  return { fns, calls, els, TODAY }
}
const el = (attrs: Record<string, string>) => ({ getAttribute: (n: string) => attrs[n] ?? null })

describe('F10: Today’s Running lists COS’s own jobs', () => {
  it('shows each in-flight job with what it is, counts it, and offers Stop only on a Work run', async () => {
    const h = running({ '/api/query-jobs/active': { protocolVersion: 1, enabled: true, items: [JOB({ origin: 'person' }), JOB({ origin: 'routine' }), JOB({ origin: 'task', title: 'Fix the price table' }), JOB({ origin: 'other' })] } })
    await h.fns.loadRunJobs()
    h.fns.renderRunning([{ id: 's1' }], [])
    const html = h.els['run-list']!.innerHTML
    expect(h.els['run-count']!.textContent).toBe('5')
    expect(html).toContain('COS is answering')
    expect(html).toContain('Routine')
    expect(html).toContain('Fix the price table')
    expect(html).toContain('Running, 2 min')
    expect(html).toContain('<SESSION s1>')
    expect((html.match(/data-action="run-job-stop"/g) || []).length).toBe(2)
    expect(html).toContain('data-job="j-task:1"')
    expect(html).toContain('data-job="j-other:1"')
    expect(html).not.toContain('data-job="j-person:1"')
    expect(html).not.toContain('data-job="j-routine:1"')
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
  it('Stop takes two taps and then cancels that job at its generation through the existing route', async () => {
    const h = running({ '/api/query-jobs/active': { protocolVersion: 1, enabled: true, items: [JOB({ origin: 'task', generation: 3 })] }, '/api/query-jobs/j-task/cancel': { job: {} } })
    await h.fns.loadRunJobs()
    h.fns.renderRunning([], [])
    h.fns.stopRunJob(el({ 'data-job': 'j-task:3' }))
    expect(h.els['run-list']!.innerHTML).toContain('Tap again to stop')
    expect(h.calls.filter(c => c.path.endsWith('/cancel'))).toHaveLength(0)
    h.fns.stopRunJob(el({ 'data-job': 'j-task:3' }))
    expect(h.els['run-list']!.innerHTML).toContain('Stopping')
    await flush()
    const cancel = h.calls.filter(c => c.path.endsWith('/cancel'))
    expect(cancel).toEqual([{ path: '/api/query-jobs/j-task/cancel', method: 'POST', body: { generation: 3 }, timeoutMs: 20000 }])
  })
  it('a failed Stop says why on the row', async () => {
    const h = running({ '/api/query-jobs/active': { protocolVersion: 1, enabled: true, items: [JOB({ origin: 'task' })] }, '/api/query-jobs/j-task/cancel': fail(409, 'That job already finished.') })
    await h.fns.loadRunJobs()
    h.fns.stopRunJob(el({ 'data-job': 'j-task:1' })); h.fns.stopRunJob(el({ 'data-job': 'j-task:1' }))
    await flush()
    expect(h.els['run-list']!.innerHTML).toContain('That job already finished.')
  })
  it('a session read that failed still shows the jobs and the retry, never "Nothing running"', async () => {
    const h = running({ '/api/query-jobs/active': { protocolVersion: 1, enabled: true, items: [JOB({ origin: 'person' })] } })
    await h.fns.loadRunJobs()
    h.TODAY.sessionsState = 'failed'
    h.fns.renderRunning([], [])
    expect(h.els['run-list']!.innerHTML).toContain('COS is answering')
    expect(h.els['run-list']!.innerHTML).toContain('Couldn’t read sessions')
    expect(h.els['run-list']!.innerHTML).not.toContain('Nothing running')
  })
})

// ── F3 and F2: the Mac not answering, and the sign-in ending ──
const CONN = block('  // ── Mac reachability and sign-in lifetime (W1', '  // ── end Mac reachability and sign-in lifetime')
function conn(opts: { up?: boolean | null; lastUpAt?: number; health?: unknown; seed?: Record<string, string> } = {}) {
  const { api, calls } = fakeApi({ '/api/health': opts.health ?? { ok: true } })
  const box = { innerHTML: '', hidden: true }
  const SERVER: any = { up: opts.up ?? true, hooks: [], lastUpAt: opts.lastUpAt ?? 0 }
  let routed = 0
  const timers: Array<() => void> = []
  const deps = { api, esc, clock: (d: Date) => `T${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`, $: (id: string) => (id === 'conn-notice' ? box : null), SERVER,
    noteServer: (up: boolean) => { SERVER.up = up }, route: () => { routed++ }, document: { hidden: false }, localStorage: store(opts.seed),
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length }, clearTimeout: () => {} }
  // eslint-disable-next-line no-new-func
  const fns = new Function('deps', `with (deps) {\n${CONN}\nreturn { connPaint, connRetry, signinRemember, signinLapsedCopy, CONN };\n}`)(deps)
  return { fns, box, SERVER, calls, routed: () => routed, timers }
}

describe('F3: the Mac not answering', () => {
  it('says so in one line, with when it last heard from the Mac, and offers Retry', () => {
    const at = new Date(); at.setHours(9, 5, 0, 0)
    const h = conn({ up: false, lastUpAt: at.getTime() })
    h.fns.connPaint()
    expect(h.box.hidden).toBe(false)
    expect(h.box.innerHTML).toContain('Your Mac is not answering.')
    expect(h.box.innerHTML).toContain('Last updated T9:05.')
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
    expect(h.box.innerHTML).toContain('Your Mac is not answering.')
    expect(h.timers.length).toBe(1)
  })
  it('the page has the place for the line, and every hook repaints it', () => {
    expect(HTML).toContain('<div id="conn-notice" class="conn-notice" hidden></div>')
    expect(CONN).toContain('SERVER.hooks.push(function () { connPaint(); connSchedule(); });')
  })
})

describe('F2: the 7-day sign-in', () => {
  it('within a day of the end it says when, and how to sign in again', () => {
    const h = conn()
    h.fns.signinRemember({ expiresAt: new Date(Date.now() + 5 * 3600000).toISOString() })
    h.fns.connPaint()
    expect(h.box.innerHTML).toContain('Sign-in here ends ')
    expect(h.box.innerHTML).toContain('Open COS on your phone')
    expect(h.box.innerHTML).toContain('data-action="conn-hide-signin"')
  })
  it('more than a day away: nothing', () => {
    const h = conn()
    h.fns.signinRemember({ expiresAt: new Date(Date.now() + 3 * 24 * 3600000).toISOString() })
    h.fns.connPaint()
    expect(h.box.hidden).toBe(true)
  })
  it('the expiry is kept for the next load, and the sign-in card says the 7 days ran out', () => {
    const h = conn()
    h.fns.signinRemember({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    const next = conn({ seed: { 'cos.web.signinEnds': h.fns.CONN.signinEnds ? String(h.fns.CONN.signinEnds) : '' } })
    expect(next.fns.signinLapsedCopy()).toMatch(/^Your sign-in on this browser ended\. Sign-ins last 7 days\. On your Mac, open COS Control/)
    const unknown = conn()
    expect(unknown.fns.signinLapsedCopy()).toMatch(/^This browser is signed out\. On your Mac/)
  })
  it('a 401 after the page was signed in opens the card with that reason; the login and status answers feed the expiry', () => {
    expect(APP).toContain("showAuth(typeof signinLapsedCopy === 'function' && signedInOnce() ? signinLapsedCopy() : undefined)")
    expect(APP).toContain("if (typeof signinRemember === 'function') signinRemember(info);")
  })
})

describe('F23: a cold open with the Mac unreachable', () => {
  function bootWith(answer: Error | Record<string, unknown>) {
    const boot = block('  function boot() {', '  if (document.readyState')
    const calls: string[] = []
    const cls = () => { const set = new Set<string>(['hidden']); return { set, toggle: (c: string, on: boolean) => { if (on) set.add(c); else set.delete(c) }, add: (c: string) => set.add(c) } }
    const els: Record<string, { classList: ReturnType<typeof cls> }> = { 'auth-offline': { classList: cls() }, 'auth-form': { classList: cls() }, 'auth-error': { classList: cls() } }
    els['auth-form']!.classList.set.delete('hidden')
    const deps = {
      location: { search: '', pathname: '/control', hash: '' }, history: { replaceState: () => {} }, URLSearchParams,
      api: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
      showShell: () => calls.push('shell'), showAuth: (m?: string) => calls.push('auth:' + (m ?? '')),
      $: (id: string) => els[id] ?? null, setStatus: () => {}, UNREACHABLE_COPY: 'Could not reach COS on your Mac.',
    }
    // eslint-disable-next-line no-new-func
    const fns = new Function('deps', `with (deps) {\n${boot}\nreturn { boot };\n}`)(deps)
    return { fns, calls, els }
  }
  it('shows the not-answering card with Try again and hides the sign-in form', async () => {
    const h = bootWith(fail(undefined, 'Could not reach COS on your Mac.'))
    h.fns.boot(); await flush()
    expect(h.calls).toEqual(['auth:'])
    expect(h.els['auth-offline']!.classList.set.has('hidden')).toBe(false)
    expect(h.els['auth-form']!.classList.set.has('hidden')).toBe(true)
  })
  it('a Mac that answered with an error is a sign-in matter: the form stays, with the reason', async () => {
    const h = bootWith(fail(503, 'Not ready.'))
    h.fns.boot(); await flush()
    expect(h.calls).toEqual(['auth:Not ready.'])
    expect(h.els['auth-offline']!.classList.set.has('hidden')).toBe(true)
    expect(h.els['auth-form']!.classList.set.has('hidden')).toBe(false)
  })
  it('the card is in the page, and Try again is wired', () => {
    expect(HTML).toContain('<button type="button" class="btn primary block" id="auth-retry">Try again</button>')
    expect(HTML).toContain('Your Mac is not answering. COS runs on your Mac, so this page waits for it.')
    expect(APP).toContain("if (t.id === 'auth-retry')")
  })
})
