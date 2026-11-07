import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  const deps: Record<string, unknown> = {
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
  const fns = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn { renderStory: renderStory, BRIEF: BRIEF };\n}')(deps)
  const m = { rows: opts.rows ?? [], now: opts.rows ?? [], later: [], failed: opts.failed ?? [], settled: opts.settled ?? true,
    states: opts.states ?? { sessions: 'answered', work: 'answered', voices: 'answered', memories: 'answered' },
    sessionsWaiting: (opts.sessions ?? []).filter((s: any) => s.agent_state === 'waiting').length }
  TODAY.model = m
  const flush = () => new Promise(r => setTimeout(r, 0))
  return { els, posts, clock, TODAY, m, fns, flush, render: () => fns.renderStory(m), text: () => els['today-story']!.textContent || els['today-story']!.innerHTML }
}

const WAITING = { session_id: 'aaaaaaaa-1111-4111-8111-111111111111', provider: 'claude', display_label: 'Release QA', agent_state: 'waiting', running: true,
  state_since: '2026-11-04T19:48:00Z', discussion_summary: 'Asked whether to publish 6.99.26' }
const WORKING = { session_id: 'bbbbbbbb-2222-4222-8222-222222222222', provider: 'codex', display_label: 'Today summary build', running: true, running_active: true,
  state_since: '2026-11-04T19:35:00Z', discussion_summary: 'Writing the route', project: '-Users-ukaoma-Documents-GitHub-secret' }
const FRESH = { text: 'You are shipping the Today summary. Release QA waits on you to approve a publish.', at: '2026-11-04T19:54:00Z', state: 'fresh', basis: '2 sessions', model: 'haiku' }

describe('the Today summary on the web', () => {
  it('paints the counts line at once, asks with what Today read, then swaps in the summary with a quiet age line', async () => {
    const s = story({ sessions: [WAITING, WORKING], answer: () => FRESH })
    s.render()
    expect(s.els['today-story']!.textContent, 'the counts line first, never a blank').toBe('One session is waiting on you. One agent is working, with one more session open.')
    expect(s.posts).toHaveLength(1)
    const body = s.posts[0].body
    expect(s.posts[0]).toMatchObject({ path: '/api/today/brief', method: 'POST' })
    expect(body).toMatchObject({ sessionsRead: true, needsComplete: true, unread: [], recording: false })
    expect(body.sessions).toEqual([
      { title: 'Release QA', provider: 'claude', state: 'waiting', minutes: 12, line: 'Asked whether to publish 6.99.26', waiting: 'Wants to run npm publish' },
      { title: 'Today summary build', provider: 'codex', state: 'working', minutes: 25, line: 'Writing the route', waiting: '' },
    ])
    expect(JSON.stringify(body), 'no ids or folders leave the page').not.toMatch(/aaaaaaaa|bbbbbbbb|secret/)
    await s.flush()
    expect(s.els['today-story']!.innerHTML).toBe(esc(FRESH.text) + '<span class="story-when">Updated 6 min ago.</span>')
  })
  it('a summary written under a minute ago says just now; a stale one says things moved; a failed source is named', async () => {
    const s = story({ sessions: [WORKING], failed: ['memories'], settled: false, states: { sessions: 'answered', work: 'answered', voices: 'answered', memories: 'failed' },
      answer: () => ({ ...FRESH, at: '2026-11-04T19:59:40Z', state: 'stale' }) })
    s.render(); await s.flush()
    expect(s.els['today-story']!.innerHTML).toContain('<span class="story-when">Updated just now. Things have moved since. Couldn’t read memories, so this may not be everything.</span>')
    expect(s.posts[0].body).toMatchObject({ needsComplete: false, unread: ['memories'] })
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
  it('never over a session list that was not read: the counts line keeps "Couldn’t read your sessions"', async () => {
    const s = story({ sessionsState: 'failed', answer: () => FRESH })
    s.fns.BRIEF.view = FRESH
    s.render(); await s.flush()
    expect(s.els['today-story']!.textContent).toContain('Couldn’t read your sessions')
    expect(s.els['today-story']!.textContent).not.toContain('shipping')
    expect(s.posts[0].body.sessionsRead).toBe(false)
  })
  it('offline shows the offline line and asks nothing', () => {
    const s = story({ offline: true, answer: () => FRESH })
    s.render()
    expect(s.els['today-story']!.textContent).toContain('is not answering right now')
    expect(s.posts).toHaveLength(0)
  })
  it('asks at most once a minute for the same inputs, and at once when they change', async () => {
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
    expect(s.posts).toHaveLength(3)
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

describe('Settings: "Write the Today summary with a model"', () => {
  it('loads the switch, shows the toggle under General with the cost note, and disables it when the env sets it', () => {
    expect(SETTINGS).toContain("soft(api('/api/today/brief/settings'))")
    expect(SETTINGS).toContain('tb: r[8]')
    expect(SETTINGS).toContain("row('Write the Today summary with a model'")
    expect(SETTINGS).toContain('at most every 10 minutes and 60 times a day')
    expect(SETTINGS).toMatch(/toggle\(d\.tb\.enabled, 'data-set="today-brief"' \+ \(d\.tb\.source === 'env' \? ' disabled' : ''\)/)
    expect(SETTINGS).toContain("api('/api/today/brief/settings', { method: 'POST', body: { enabled: !ton } })")
  })
})
