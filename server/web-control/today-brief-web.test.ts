import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// The Today summary on the web (app.js: the BRIEF block, renderStory, askCos). Runs the real app.js text against fakes;
// the "server" is a function here, so nothing reaches a model or a Mac.
const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const SETTINGS = readFileSync(join(HERE, 'panes', 'settings.js'), 'utf8')

class El { textContent = ''; innerHTML = ''; className = '' }
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!)
const NOW = Date.parse('2026-11-04T20:00:00Z')

type View = Record<string, unknown> | null
function story(opts: { sessions?: any[]; rows?: any[]; states?: Record<string, string>; settled?: boolean; failed?: string[]; sessionsState?: string; offline?: boolean;
  answer?: (body: any) => View | Promise<View> | Error; pane?: string } = {}) {
  const start = APP.indexOf('  // ── The Today summary (6.99.26 candidate)'), end = APP.indexOf('  function runRow(s, activeNow)')
  expect(start, 'the brief block').toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const els: Record<string, El> = {}
  const posts: any[] = []
  const clock = { t: NOW }
  class FakeDate extends Date { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(clock.t) } static now() { return clock.t } }
  const TODAY: any = { working: (opts.sessions ?? []).filter((s: any) => s.running_active), open: (opts.sessions ?? []).filter((s: any) => s.running && !s.running_active),
    welcome: {}, offline: !!opts.offline, recording: false, sessionsState: opts.sessionsState ?? 'answered', model: null }
  const ticks: Array<() => void> = []
  const doc = { hidden: false, querySelector: (sel: string) => (sel === '#today-story .story-when' ? (els['story-when'] ??= new El()) : null) }
  const deps: Record<string, unknown> = {
    setInterval: (fn: () => void) => { ticks.push(fn); return ticks.length }, document: doc,
    $: (id: string) => (els[id] ??= new El()), esc, Date: FakeDate,
    toDate: (v: unknown) => (v ? new FakeDate(String(v)) : null), clock: () => '9:00 AM', dayWord: () => 'today',
    span: (v: unknown) => Math.max(1, Math.round((clock.t - Date.parse(String(v))) / 60000)) + ' min',
    countWord: (n: number, lower?: boolean) => { const w = ['No', 'One', 'Two', 'Three', 'Four'][n] ?? String(n); return lower ? w.toLowerCase() : w }, plural: (n: number, a: string, b: string) => (n === 1 ? a : b),
    state: { sessions: opts.sessions ?? [], serverName: 'Mac', pane: opts.pane ?? 'today' }, TODAY,
    sxKeepWarm: () => false, sxState: (s: any) => (s.agent_state === 'waiting' ? 'waiting' : s.running_active ? 'running' : 'recent'),
    splitSessionId: (p: string, id: string) => ({ provider: p || 'claude', id }), sessionTitle: (s: any) => s.display_label || 'Untitled session',
    askedWhy: () => 'Wants to run npm publish', needWhy: () => 'Waiting for your reply',
    api: (path: string, o: any) => {
      posts.push({ path, body: o && o.body, method: o && o.method })
      // A runaway (ask, repaint, ask again) stops here, so the test that counts asks fails by name instead of hanging.
      if (posts.length > 20) return new Promise(() => {})
      const a = opts.answer ? opts.answer(o && o.body) : { state: 'off', text: '' }
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a)
    },
  }
  // eslint-disable-next-line no-new-func
  const fns = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn { renderStory: renderStory, BRIEF: BRIEF, resetBrief: resetBrief };\n}')(deps)
  const m = { rows: opts.rows ?? [], now: opts.rows ?? [], later: (opts as any).later ?? [], failed: opts.failed ?? [], settled: opts.settled ?? true,
    states: opts.states ?? { sessions: 'answered', work: 'answered', voices: 'answered', memories: 'answered' },
    sessionsWaiting: (opts.sessions ?? []).filter((s: any) => s.agent_state === 'waiting').length }
  TODAY.model = m
  const flush = () => new Promise(r => setTimeout(r, 0))
  return { els, posts, clock, TODAY, m, fns, flush, ticks, doc, render: () => fns.renderStory(m), text: () => els['today-story']!.textContent || els['today-story']!.innerHTML }
}

const WAITING = { session_id: 'aaaaaaaa-1111-4111-8111-111111111111', provider: 'claude', display_label: 'Release QA', agent_state: 'waiting', running: true,
  state_since: '2026-11-04T19:48:00Z', discussion_summary: 'Asked whether to publish 6.99.26' }
const WORKING = { session_id: 'bbbbbbbb-2222-4222-8222-222222222222', provider: 'codex', display_label: 'Today summary build', running: true, running_active: true,
  state_since: '2026-11-04T19:35:00Z', discussion_summary: 'Writing the route', project: '-Users-ukaoma-Documents-GitHub-secret',
  subagent_activity: { active: 2, completed: 1, unknown: 0, total: 3, checked_at: 1, partial: false } }
const FRESH = { text: 'You are shipping the Today summary. Release QA waits on you to approve a publish.', at: '2026-11-04T19:54:00Z', state: 'fresh', basis: '2 sessions', model: 'sonnet' }

describe('the Today summary on the web', () => {
  it('paints the counts line at once, asks with what Today read, then swaps in the summary with a quiet age line', async () => {
    const s = story({ sessions: [WAITING, WORKING], answer: () => FRESH })
    s.render()
    expect(s.els['today-story']!.textContent, 'the counts line first, never a blank').toBe('One session is waiting on you. One agent is working, with one more session open.')
    expect(s.posts).toHaveLength(1)
    const body = s.posts[0].body
    expect(s.posts[0]).toMatchObject({ path: '/api/today/brief', method: 'POST' })
    expect(body).toMatchObject({ sessionsRead: true, needsComplete: true, unread: [], recording: false, later: 0 })
    expect(body.sessions).toEqual([
      { title: 'Release QA', provider: 'claude', state: 'waiting', minutes: 12, line: 'Asked whether to publish 6.99.26', waiting: 'Wants to run npm publish', key: 'claude|' + WAITING.session_id, agents: undefined },
      { title: 'Today summary build', provider: 'codex', state: 'working', minutes: 25, line: 'Writing the route', waiting: '', key: 'codex|' + WORKING.session_id,
        agents: { active: 2, completed: 1, total: 3 } },
    ])
    // Ids go only in `key`, for the server's sub-agent lookup; no folder goes at all.
    const noKeys = JSON.stringify(body.sessions.map((s: any) => ({ ...s, key: undefined })))
    expect(noKeys, 'no ids or folders outside the lookup key').not.toMatch(/aaaaaaaa|bbbbbbbb|secret/)
    await s.flush()
    expect(s.els['today-story']!.innerHTML).toBe(esc(FRESH.text) + '<span class="story-when">Updated 6 min ago.</span>')
  })
  it('a stale one says things moved once it is five minutes old, never on a summary from just now', async () => {
    const old = story({ sessions: [WORKING], answer: () => ({ ...FRESH, state: 'stale' }) })
    old.render(); await old.flush()
    expect(old.els['today-story']!.innerHTML).toContain('<span class="story-when">Updated 6 min ago. Things have moved since.</span>')
    const young = story({ sessions: [WORKING], answer: () => ({ ...FRESH, state: 'stale', at: '2026-11-04T19:57:00Z' }) })
    young.render(); await young.flush()
    expect(young.els['today-story']!.innerHTML).toContain('<span class="story-when">Updated 3 min ago.</span>')
  })
  it('a summary written under a minute ago says just now; a failed source is named', async () => {
    const s = story({ sessions: [WORKING], failed: ['memories'], settled: false, states: { sessions: 'answered', work: 'answered', voices: 'answered', memories: 'failed' },
      answer: () => ({ ...FRESH, at: '2026-11-04T19:59:40Z', state: 'stale' }) })
    s.render(); await s.flush()
    expect(s.els['today-story']!.innerHTML).toContain('<span class="story-when">Updated just now. Couldn’t read memories, so this may not be everything.</span>')
    expect(s.posts[0].body).toMatchObject({ needsComplete: false, unread: ['memories'] })
  })
  it('sends how many needs can wait until tomorrow (Today’s quiet-hours fold), never the waiting sessions among them', () => {
    const mem = { kind: 'memories', title: 'Review 7 memories', why: '' }, wait = { kind: 'session', title: 'Release QA asked you a question', why: '' }
    const s = story({ sessions: [WAITING], rows: [wait, mem], later: [mem], answer: () => FRESH } as any)
    s.render()
    expect(s.posts[0].body).toMatchObject({ needs: [{ title: 'Review 7 memories', why: '' }], later: 1 })
  })
  it('waits for every source before asking: a pending one sends nothing', () => {
    const s = story({ sessions: [WORKING], states: { sessions: 'answered', work: 'answered', voices: 'pending', memories: 'answered' }, answer: () => FRESH })
    s.render()
    expect(s.posts).toHaveLength(0)
  })
  it('off, failed or empty keeps today’s counts line exactly; off is asked again only after five minutes', async () => {
    const s = story({ sessions: [WORKING] })
    s.render(); await s.flush()
    expect(s.els['today-story']!.textContent).toBe('Nothing is waiting on you. One agent is working.')
    expect(s.els['today-story']!.innerHTML).toBe('')
    s.render(); await s.flush()
    expect(s.posts).toHaveLength(1)
    s.clock.t += 5 * 60000
    s.render(); await s.flush()
    expect(s.posts).toHaveLength(2)
    for (const answer of [() => ({ state: 'failed', text: '', reason: 'paused' }), () => new Error('offline'), () => ({ state: 'fresh', text: '' })]) {
      const f = story({ sessions: [WORKING], answer })
      f.render(); await f.flush()
      expect(f.els['today-story']!.textContent).toBe('Nothing is waiting on you. One agent is working.')
    }
  })
  it('T1 spec 0 (was: never over an unread list): a failed session read keeps today’s summary, and its age line says what could not be read', async () => {
    const s = story({ sessionsState: 'failed', failed: ['sessions'], answer: () => FRESH })
    s.fns.BRIEF.view = FRESH
    s.render(); await s.flush()
    expect(s.text()).toContain('shipping')
    expect(s.text()).not.toContain('Couldn’t read your sessions.')
    expect(s.text()).toContain('Couldn’t read sessions, so this may not be everything')
    expect(s.posts[0].body.sessionsRead, 'the server is still told the list was not read').toBe(false)
  })
  it('with no summary yet, an unread list still shows the counts line with "Couldn’t read your sessions"', async () => {
    const s = story({ sessionsState: 'failed', answer: () => ({ state: 'off', text: '' }) })
    s.render(); await s.flush()
    expect(s.text()).toContain('Couldn’t read your sessions')
  })
  it('offline shows the offline line and asks nothing', () => {
    const s = story({ offline: true, answer: () => FRESH })
    s.render()
    expect(s.els['today-story']!.textContent).toContain('is not answering right now')
    expect(s.posts).toHaveLength(0)
  })
  it('asks at once when what Today read changed, else at most every five minutes', async () => {
    const s = story({ sessions: [WORKING], answer: () => FRESH })
    s.render(); await s.flush()
    s.render(); await s.flush()
    expect(s.posts).toHaveLength(1)
    ;(s as any).TODAY.model.rows = [{ kind: 'memories', title: 'Review 2 memories', why: 'Waiting for a yes or no.' }]
    s.render(); await s.flush()
    expect(s.posts).toHaveLength(2)
    expect(s.posts[1].body.needs).toEqual([{ title: 'Review 2 memories', why: 'Waiting for a yes or no.' }])
    s.clock.t += 61_000
    s.render(); await s.flush()
    expect(s.posts, 'a minute later, the same rows: nothing').toHaveLength(2)
    s.clock.t += 4 * 60_000
    s.render(); await s.flush()
    expect(s.posts, 'five minutes after the last ask').toHaveLength(3)
  })
  it('every minute while Today shows, "Updated N min ago" moves on and an unchanged Today asks again after five minutes', async () => {
    const s = story({ sessions: [WORKING], answer: () => FRESH })
    s.render(); await s.flush()
    expect(s.ticks).toHaveLength(1)
    s.clock.t += 60_000
    s.ticks[0]!()
    await s.flush()
    expect(s.els['story-when']!.textContent).toBe('Updated 7 min ago.')
    expect(s.posts).toHaveLength(1)
    s.clock.t += 4 * 60_000
    s.ticks[0]!(); await s.flush()
    expect(s.posts).toHaveLength(2)
    s.doc.hidden = true
    s.clock.t += 10 * 60_000
    s.ticks[0]!(); await s.flush()
    expect(s.posts, 'nothing while the page is hidden').toHaveLength(2)
  })
  it('resetBrief (Settings toggled it) forgets the summary: the counts line shows and the next paint asks at once', async () => {
    const s = story({ sessions: [WORKING], answer: () => FRESH })
    s.render(); await s.flush()
    expect(s.els['today-story']!.innerHTML).toContain(esc(FRESH.text))
    s.fns.resetBrief()
    s.render(); await s.flush()
    expect(s.posts).toHaveLength(2)
  })
  it('one ask at a time: a render while one is in flight sends nothing', () => {
    const s = story({ sessions: [WORKING], answer: () => new Promise<View>(() => {}) })
    s.render(); s.render()
    // even when what Today read changed meanwhile (the once-a-minute rule would let that through)
    ;(s as any).TODAY.model.rows = [{ kind: 'memories', title: 'Review 2 memories', why: '' }]
    s.render()
    expect(s.posts).toHaveLength(1)
  })
  it('not on Today: nothing is asked', () => {
    const s = story({ sessions: [WORKING], pane: 'work', answer: () => FRESH })
    s.render()
    expect(s.posts).toHaveLength(0)
  })
})

describe('Ask from Today carries the summary, inside the cap', () => {
  function ask(brief: unknown, summary: string, max = 4000) {
    const start = APP.indexOf('  var TODAY_REFERENCE'), end = APP.indexOf('  // ── Usage ──')
    const posts: any[] = []
    const deps = {
      state: { pane: 'today' }, PANES: {}, toast: () => {}, setStatus: () => {}, webJobId: () => '11111111-2222-4333-8444-555555555555',
      ensurePane: () => Promise.resolve({ summary: () => summary, summaryMax: max }),
      api: (path: string, o: { body: unknown }) => { posts.push({ path, body: o.body }); return Promise.resolve({}) },
      window: { COSWeb: { cosChat: null } }, setTimeout: () => 0,
      briefShown: () => brief, briefMinutes: () => 6, span: () => '6 min',
    }
    // eslint-disable-next-line no-new-func
    const fn = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn askCos;\n}')(deps)
    return { fn, posts }
  }
  it('leads with the summary and its age', async () => {
    const a = ask(FRESH, 'Needs you (1): QA review.')
    await a.fn('What first?', null)
    expect(a.posts[0].body.reference.response).toBe('Summary of the sessions, written by a model 6 min ago: ' + FRESH.text + '\nNeeds you (1): QA review.')
  })
  it('a stale one says so; none, or past the cap, leaves the Today summary exactly as it was', async () => {
    const st = ask({ ...FRESH, state: 'stale' }, 'Needs you: nothing.')
    await st.fn('Q', null)
    expect(st.posts[0].body.reference.response).toContain('6 min ago (things have moved since): ')
    const none = ask(null, 'Needs you: nothing.')
    await none.fn('Q', null)
    expect(none.posts[0].body.reference.response).toBe('Needs you: nothing.')
    const full = ask(FRESH, 'x'.repeat(3950))
    await full.fn('Q', null)
    expect(full.posts[0].body.reference.response).toBe('x'.repeat(3950))
  })
})

describe('Settings: the status line under the toggle', () => {
  const fn = () => {
    const i = SETTINGS.indexOf('  function briefStatus(tb) {'), j = SETTINGS.indexOf('\n  }\n', i) + 4
    // eslint-disable-next-line no-new-func
    return new Function(SETTINGS.slice(i, j) + '\nreturn briefStatus;')() as (tb: unknown) => string
  }
  it('says paused until, today\u2019s cap reached, or the last failure, and nothing when all is well or off', () => {
    const s = fn()
    expect(s({ enabled: true, status: { kind: 'paused', until: '2026-11-07T15:00:00Z' } })).toMatch(/^Paused after three failed tries\. It tries again at /)
    // 7.0.5: the number is the "Summaries per day" setting; an older server's status (count only) still reads right.
    expect(s({ enabled: true, status: { kind: 'daily_cap', count: 60, cap: 40 } })).toBe('Today\u2019s 40 summaries are used. It writes again tomorrow.')
    expect(s({ enabled: true, status: { kind: 'daily_cap', count: 60 } })).toBe('Today\u2019s 60 summaries are used. It writes again tomorrow.')
    expect(s({ enabled: true, status: { kind: 'daily_cap', count: 1, cap: 1 } })).toBe('Today\u2019s 1 summary is used. It writes again tomorrow.')
    expect(s({ enabled: true, status: { kind: 'failed', at: '2026-11-07T15:00:00Z', code: 'timeout' } })).toMatch(/^The last try failed at .*\(it took too long\)\.$/)
    expect(s({ enabled: true, status: null })).toBe('')
    expect(s({ enabled: false, status: { kind: 'daily_cap', count: 60 } })).toBe('')
  })
})

describe('Settings: "Write the Today summary with a model"', () => {
  it('loads the switch, shows the toggle under General with the cost note, and disables it when the env sets it', () => {
    expect(SETTINGS).toContain("soft(api('/api/today/brief/settings'))")
    expect(SETTINGS).toContain('tb: r[8]')
    expect(SETTINGS).toContain("row('Write the Today summary with a model'")
    expect(SETTINGS).toContain('at most every 10 minutes and no more than Summaries per day allows')
    expect(SETTINGS).toContain('each session\\u2019s sub-agents and the Work cards in progress')
    expect(SETTINGS).toContain('never during a recording')
    expect(SETTINGS).toContain('if (W.resetTodayBrief) W.resetTodayBrief();')
    expect(SETTINGS).toMatch(/toggle\(d\.tb\.enabled, 'data-set="today-brief"' \+ \(d\.tb\.source === 'env' \? ' disabled' : ''\)/)
    expect(SETTINGS).toContain("api('/api/today/brief/settings', { method: 'POST', body: { enabled: !ton } })")
  })
})

describe('7.0.5: a reconnect asks at once, once; Summaries per day in Settings', () => {
  it('after a recovered read, the next paint asks at once with reason "reconnect"; the one after is ordinary', async () => {
    const s = story({ sessions: [WORKING], answer: () => FRESH })
    s.render(); await s.flush()
    expect(s.posts).toHaveLength(1)
    expect(s.posts[0].body.reason).toBeUndefined()
    s.clock.t += 61_000
    s.render(); await s.flush()
    expect(s.posts, 'the same rows a minute later: nothing').toHaveLength(1)
    ;(s.fns.BRIEF as any).reconnect = true
    s.render(); await s.flush()
    expect(s.posts).toHaveLength(2)
    expect(s.posts[1].body.reason).toBe('reconnect')
    expect((s.fns.BRIEF as any).reconnect).toBe(false)
    s.clock.t += 61_000
    s.render(); await s.flush()
    expect(s.posts, 'spent: the next paint is throttled as usual').toHaveLength(2)
  })
  it('a server before 7.0.5 refuses the reason (400 invalid_today_brief): the ask goes again without it', async () => {
    const bad = Object.assign(new Error('That is not a Today summary request.'), { status: 400, code: 'invalid_today_brief' })
    const s = story({ sessions: [WORKING], answer: (b: any) => (b && b.reason ? bad : FRESH) })
    ;(s.fns.BRIEF as any).reconnect = true
    s.render(); await s.flush(); await s.flush()
    expect(s.posts.map(p => p.body.reason)).toEqual(['reconnect', undefined])
    expect(s.els['today-story']!.innerHTML).toContain(esc(FRESH.text))
  })
  it('switched off: a reconnect is not a reason to ask early', async () => {
    const s = story({ sessions: [WORKING], answer: () => ({ state: 'off', text: '', enabled: false }) })
    s.render(); await s.flush()
    ;(s.fns.BRIEF as any).reconnect = true
    s.clock.t += 61_000
    s.render(); await s.flush()
    expect(s.posts).toHaveLength(1)
  })
  it('the sessions read and Today\u2019s read mark a reconnect only after a failed read', () => {
    expect(APP).toContain("if (SL.failed) { SL.failed = false; if (typeof BRIEF === 'object' && BRIEF) BRIEF.reconnect = true; }")
    expect(APP).toContain('function (err) { SL.inflight = null; SL.failed = true; throw err; }')
    expect(APP).toContain("if ((TODAY.sessionsState === 'failed' || TODAY.offline === true) && res[0] && !offline) BRIEF.reconnect = true;")
  })
  it('Settings: a 1 to 100 number under the toggle, saved with PUT and shown as the server clamped it; hidden on an older server', () => {
    expect(SETTINGS).toContain(`(typeof d.tb.dailyCap === 'number' ? row('Summaries per day'`)
    expect(SETTINGS).toContain('id="today-brief-cap" data-set="today-brief-cap" min="1" max="100" step="1"')
    expect(SETTINGS).toContain("api('/api/today/brief/settings/cap', { method: 'PUT', body: { dailyCap: wanted } })")
    expect(SETTINGS).toContain('capField.value = String(v.dailyCap)')
  })
})

// QA 7.0.5 (agents 1, 2, 4): clearing "Summaries per day" sent Number('') = 0, the server clamped it to 1 and the page
// said "Saved". Runs the real panes/settings.js in a vm: an empty, non-numeric or below-1 value sends nothing.
describe('7.0.5 QA: Summaries per day ignores an empty or invalid value', () => {
  async function loadSettings() {
    const listeners: Record<string, (e: unknown) => void> = {}
    const pane = { innerHTML: '', addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn } }
    const status = { textContent: '', classList: { toggle: () => {} } }
    const puts: unknown[] = [], toasts: string[] = []
    let loadFn: (() => void) | null = null
    const W = {
      $: (id: string) => id === 'pane-settings' ? pane : id === 'settings-status' ? status : null, esc, state: {}, skeletonRows: () => '',
      toast: (t: string) => { toasts.push(t) }, parseRoute: () => ({ pane: 'settings', args: [] }), go: () => {},
      registerPane: (_n: string, def: { load: () => void }) => { loadFn = def.load },
      api: (path: string, opts?: { method?: string; body?: any }) => {
        if (path === '/api/today/brief/settings/cap' && opts?.method === 'PUT') {
          puts.push(opts.body)
          return Promise.resolve({ enabled: true, source: 'settings', dailyCap: Math.min(100, Math.max(1, Math.round(opts.body.dailyCap))) })
        }
        if (path === '/api/today/brief/settings') return Promise.resolve({ enabled: true, source: 'settings', dailyCap: 40 })
        return Promise.reject(new Error('404'))
      },
    }
    const ctx = vm.createContext({ window: { COSWeb: W }, document: {}, console, Promise, Number, String, isFinite })
    vm.runInContext(SETTINGS, ctx)
    loadFn!()
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
    expect(pane.innerHTML, 'the row is drawn from the loaded setting').toContain('id="today-brief-cap"')
    const change = async (value: string) => {
      const field = { id: 'today-brief-cap', value }
      listeners.change({ target: field })
      for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0))
      return field
    }
    return { change, puts, toasts, status }
  }
  it('an emptied field, letters, 0 or a negative sends nothing, keeps the saved number and says why', async () => {
    const h = await loadSettings()
    for (const bad of ['', '   ', 'abc', '0', '-3']) {
      const f = await h.change(bad)
      expect(f.value, JSON.stringify(bad)).toBe('40')
    }
    expect(h.puts).toEqual([])
    expect(h.toasts).not.toContain('Saved')
    expect(h.status.textContent).toBe('Type a number from 1 to 100.')
  })
  it('a real number still saves, and the field shows what the server kept', async () => {
    const h = await loadSettings()
    expect((await h.change('25')).value).toBe('25')
    expect((await h.change('250')).value).toBe('100')
    expect(h.puts).toEqual([{ dailyCap: 25 }, { dailyCap: 250 }])
    expect(h.toasts).toEqual(['Saved', 'Saved'])
  })
})

// ── T1 spec (lead 23:04, lanes/T1_today_stable.md "Spec for W1"): Today's summary holds still while Miles reads ──
// A #today-story stand-in that counts writes and reports a height from what it holds: "L<n>" in the text is n lines of
// 30 px, plus 20 px for the age line under a summary; anything else is one line.
class Story {
  _text = ''; _html = ''; writes = 0; className = ''; style = { minHeight: '' }; clientWidth = 600
  set textContent(v: string) { this._text = v; this._html = ''; this.writes++ }
  get textContent() { return this._text || this._html.replace(/<[^>]+>/g, '') }
  set innerHTML(v: string) { this._html = v; this._text = ''; this.writes++ }
  get innerHTML() { return this._html }
  content() { const t = this._html || this._text; const n = Number((/L(\d+)/.exec(t) || [])[1] || 1); return n * 30 + (this._html.includes('story-when') ? 20 : 0) }
  getBoundingClientRect() { return { height: Math.max(this.content(), parseFloat(this.style.minHeight) || 0) } }
}
const V = (lines: number, extra: Record<string, unknown> = {}) => ({ ...FRESH, text: `L${lines} summary of the sessions.`, ...extra })
function held(opts: Parameters<typeof story>[0] = {}) {
  const s = story({ answer: () => null, ...opts })
  const el = new Story(); s.els['today-story'] = el as any
  const show = (v: unknown) => { s.fns.BRIEF.view = v; s.render(); return el.style.minHeight }
  return { ...s, el, show }
}

describe('T1 spec: the Today summary holds still', () => {
  it('0. pending and failed session reads never swap today’s summary for the counts line', () => {
    const h = held()
    h.fns.BRIEF.view = V(3)
    for (const st of ['answered', 'pending', 'answered', 'failed', 'pending', 'answered']) {
      h.TODAY.sessionsState = st
      h.render()
      expect(h.el.textContent, st).toContain('L3 summary')
      expect(h.el.textContent, st).not.toMatch(/agents? (is|are) working|No agents are running|Couldn’t read your sessions\./)
    }
  })
  it('0. a summary written yesterday is not today’s: the counts line shows', () => {
    const h = held()
    h.show(V(3, { at: '2026-11-03T15:00:00Z' }))
    expect(h.el.textContent).not.toContain('L3 summary')
  })
  it('3. the same words are written once; only the age line moves', () => {
    const h = held()
    h.show(V(2))
    expect(h.el.writes).toBe(1)
    h.clock.t += 3 * 60000
    h.render(); h.render()
    expect(h.el.writes, 'no rewrite of unchanged text').toBe(1)
    expect(h.els['story-when']!.textContent).toBe('Updated 9 min ago.')
    h.show(V(4))
    expect(h.el.writes, 'new words are written').toBe(2)
  })
  it('1. the block keeps its tallest height through shorter rewrites and the fall back to the counts line', () => {
    const h = held()
    expect(h.show(V(5))).toBe('170px')
    expect(h.show(V(4)), 'shorter: held').toBe('170px')
    expect(h.show(V(6)), 'longer: grows').toBe('200px')
    expect(h.show(V(1)), 'one line: held').toBe('200px')
    expect(h.show(null), 'counts line: held').toBe('200px')
  })
  it('2. it may shrink on a width change, a new day and resetBrief, never on a rewrite', () => {
    const h = held()
    h.show(V(6)); expect(h.el.style.minHeight).toBe('200px')
    h.el.clientWidth = 380
    expect(h.show(V(2)), 'width changed: re-fit').toBe('80px')
    h.show(V(6)); h.clock.t += 24 * 3600000
    expect(h.show(V(2, { at: new Date(h.clock.t).toISOString() })), 'a new day: re-fit').toBe('80px')
    h.show(V(6, { at: new Date(h.clock.t).toISOString() }))
    h.fns.resetBrief()
    expect(h.fns.BRIEF.heldPx).toBe(0)
    expect(h.show(null), 'after resetBrief the counts line fits itself').toBe('30px')
  })
  it('2. Refresh re-fits the block when its answer lands (todayRefresh, outside this block)', () => {
    const at = APP.indexOf('        // T1 spec 2: Refresh re-fits the block to what it now holds.\n        BRIEF.heldPx = 0;\n        if (TODAY.model && state.pane === \'today\') renderStory(TODAY.model);')
    expect(at).toBeGreaterThan(APP.indexOf('  function todayRefresh() {'))
  })
})
