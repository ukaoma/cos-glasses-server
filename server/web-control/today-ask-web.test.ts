/**
 * Today round 2 (Miles typed 2026-11-09 09:19 to 09:20 CST): "Ask about this" under the Today summary. Runs the real
 * app.js block (paintTodayAsk, todayAskContext, sendTodayAsk) against fakes, and the real panes/cos-chat.js askAbout in
 * a vm, so the request body the server would get is the one checked. Nothing reaches a Mac or a model.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.js'), 'utf8')
const CHAT = readFileSync(join(HERE, 'panes', 'cos-chat.js'), 'utf8')
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')
const flush = () => new Promise(r => setTimeout(r, 0))

const SUMMARY = { text: 'Two things need you. The Weatherford call ended, and its session is waiting for your next step.', at: '2026-11-09T15:10:00Z', state: 'fresh',
  sessions: [{ title: 'Weatherford prep', provider: 'claude', state: 'waiting', movedAt: '2026-11-09T15:05:00Z', lastAsk: 'prep me for the "Weatherford" call ```rm```' },
    { title: 'Release work', provider: 'codex', state: 'open', movedAt: '2026-11-09T14:00:00Z' }] }

// What app.js todayAskContext hands askAbout.
const CTX = { summary: SUMMARY.text, at: SUMMARY.at, sessions: SUMMARY.sessions }

// ── cos-chat.js askAbout ──────────────────────────────────
function chat(health: unknown) {
  const posts: Array<{ path: string; body: any }> = []
  const W: Record<string, unknown> = {
    $: () => null, esc: (s: unknown) => String(s), toast: () => {}, autoGrow: () => {}, md: (s: unknown) => String(s), skeletonRows: () => '',
    toDate: (s: string) => (s ? new Date(s) : null), clock: (d: Date) => `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
    readStore: () => ({}), writeStore: () => {}, parseRoute: () => ({ pane: 'messages', args: ['cos'] }), go: () => {},
    api: (path: string, opts?: { method?: string; body?: any }) => {
      if (opts?.method === 'POST') posts.push({ path, body: opts.body })
      if (path === '/api/health') return Promise.resolve(health)
      if (path === '/api/query-jobs' && opts?.method === 'POST') return Promise.resolve({ job: { jobId: 'j1', status: 'completed', response: 'Sent it.' } })
      return Promise.resolve({ job: { jobId: 'j1', status: 'completed', response: 'Sent it.' } })
    },
  }
  const media = { matches: false, addEventListener: () => {} }
  const document = {
    addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
    activeElement: null, hidden: false, body: { scrollHeight: 0 }, scrollingElement: {}, createElement: () => ({ setAttribute() {}, classList: { add() {} } }),
  }
  const window = { COSWeb: W, matchMedia: () => media, scrollTo: () => {}, localStorage: { getItem: () => null, setItem: () => {} } }
  const ctx = vm.createContext({ window, document, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto })
  vm.runInContext(CHAT, ctx)
  return { api: W.cosChat as any, posts }
}

describe('askAbout (panes/cos-chat.js)', () => {
  it('sends the typed words as the question and the summary, its time and the sessions it read as the quoted reference', async () => {
    const h = chat({ features: { durableQueryJobs: true } })
    const where = await h.api.askAbout('Tell the Weatherford session to review the transcript, then move to the next step', CTX)
    expect(where).toEqual(['cos'])
    const ask = h.posts.find(p => p.path === '/api/query-jobs')!
    expect(ask.body.query).toBe('Tell the Weatherford session to review the transcript, then move to the next step')
    expect(ask.body.source).toBe('web')
    expect(ask.body.reference.query).toBe('The Today summary and the sessions it read')
    const ref: string = ask.body.reference.response
    expect(ref).toBe([
      'Today summary, written 15:10:',
      SUMMARY.text,
      '',
      'Sessions Today read (2):',
      // The fence holds (``` becomes '''), a double quote cannot end the quoted ask.
      `- Weatherford prep | claude | waiting | last activity ${ref.match(/waiting \| last activity ([^|]+) \|/)![1]} | last ask: "prep me for the 'Weatherford' call '''rm'''"`,
      `- Release work | codex | open | last activity ${ref.match(/open \| last activity (.+)$/m)![1]}`,
    ].join('\n'))
    // The question itself never carries the context.
    expect(ask.body.query).not.toContain('Today summary')
  })

  it('past 12 sessions it says how many more; nothing past the bound is sent', () => {
    const h = chat({ features: { durableQueryJobs: true } })
    const many = { ...CTX, sessions: Array.from({ length: 15 }, (_, i) => ({ title: `S${i}`, provider: 'claude', state: 'open', movedAt: SUMMARY.at })) }
    const text: string = h.api.aboutContextText(many)
    expect(text.match(/^- S\d+/gm)).toHaveLength(12)
    expect(text).toContain('and 3 more')
    expect(h.api.aboutContextText(null)).toBe('')
  })

  it('without the Ask capability it refuses and sends nothing', async () => {
    const h = chat({ features: { durableQueryJobs: false } })
    await expect(h.api.askAbout('Do it', CTX)).rejects.toThrow('durable query jobs')
    expect(h.posts.filter(p => p.path === '/api/query-jobs')).toEqual([])
  })
})

// ── app.js: the box ───────────────────────────────────────
class El {
  value = ''
  hidden = true
  classList = { toggle: (c: string, on: boolean) => { if (c === 'hidden') this.hidden = on }, add: (c: string) => { if (c === 'hidden') this.hidden = true }, remove: (c: string) => { if (c === 'hidden') this.hidden = false } }
}
function box(opts: { askOn?: boolean; known?: boolean; brief?: unknown; offline?: boolean; sessionsState?: string; noChat?: boolean } = {}) {
  const start = APP.indexOf('  // ── Ask about this (Today round 2'), end = APP.indexOf("  // From today's meetings: Work's suggestions")
  expect(start, 'the Ask about this block').toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const form = new El(), input = new El()
  const went: unknown[] = [], asked: unknown[] = [], toasts: string[] = []
  const cosChat = { known: () => opts.known !== false, askOn: () => opts.askOn !== false, ensureCaps: () => Promise.resolve({}),
    askAbout: (text: string, ctx: unknown) => { asked.push({ text, ctx }); return Promise.resolve(['cos']) } }
  const TODAY: any = { offline: !!opts.offline, sessionsState: opts.sessionsState ?? 'answered', model: null }
  const deps: Record<string, unknown> = {
    $: (id: string) => (id === 'today-ask' ? form : id === 'today-ask-input' ? input : null),
    window: { COSWeb: opts.noChat ? {} : { cosChat } }, TODAY, state: { pane: 'today', sessions: [] },
    briefShown: () => (opts.brief === undefined ? SUMMARY : opts.brief), renderStory: () => {}, go: (p: string, a: unknown) => went.push([p, a]),
    toast: (t: string) => toasts.push(t), autoGrow: () => {},
    sxKeepWarm: () => false, sxState: (s: any) => (s.agent_state === 'waiting' ? 'waiting' : 'recent'), splitSessionId: (p: string, id: string) => ({ provider: p || 'claude', id }),
    sessionTitle: (s: any) => s.display_label,
  }
  // eslint-disable-next-line no-new-func
  const fns = new Function('deps', 'with (deps) {\n' + APP.slice(start, end) + '\nreturn { paintTodayAsk: paintTodayAsk, sendTodayAsk: sendTodayAsk, todayAskContext: todayAskContext };\n}')(deps)
  return { form, input, went, asked, toasts, fns, deps }
}

describe('Ask about this under the Today summary (app.js)', () => {
  it('the markup mirrors the COS chat composer: one field, the placeholder, a Send button, hidden until shown', () => {
    expect(HTML).toContain('<form id="today-ask" class="cc-composer today-ask hidden"')
    expect(HTML).toContain('<textarea class="field cc-input" id="today-ask-input" rows="1" maxlength="2000" placeholder="Ask about this or steer a session"')
    expect(HTML).toContain('<button type="submit" class="cx-btn primary cc-ask">Send</button>')
    expect(APP).toContain("else if (f.id === 'today-ask') sendTodayAsk();")
    // renderStory shows it with the model summary only.
    const story = APP.slice(APP.indexOf('  function renderStory(m) {'), APP.indexOf('    var first = \'\';', APP.indexOf('  function renderStory(m) {')))
    expect(story).toContain('askBox(brief);')
  })

  it('shows under a summary with Ask on; hidden without the capability, without a summary, offline, unread or without the chat', () => {
    const on = box(); on.fns.paintTodayAsk(SUMMARY); expect(on.form.hidden).toBe(false)
    const off = box({ askOn: false }); off.form.hidden = false; off.fns.paintTodayAsk(SUMMARY); expect(off.form.hidden).toBe(true)
    const none = box(); none.form.hidden = false; none.fns.paintTodayAsk(null); expect(none.form.hidden).toBe(true)
    const offline = box({ offline: true }); offline.form.hidden = false; offline.fns.paintTodayAsk(SUMMARY); expect(offline.form.hidden).toBe(true)
    const unread = box({ sessionsState: 'failed' }); unread.form.hidden = false; unread.fns.paintTodayAsk(SUMMARY); expect(unread.form.hidden).toBe(true)
    const nochat = box({ noChat: true }); nochat.form.hidden = false; nochat.fns.paintTodayAsk(SUMMARY); expect(nochat.form.hidden).toBe(true)
  })

  it('Send goes to Messages, then COS, and asks with the summary and the sessions it read; the box empties once sent', async () => {
    const h = box()
    h.input.value = '  review the Weatherford transcript, then move to the next step  '
    h.fns.sendTodayAsk()
    expect(h.went).toEqual([['messages', ['cos']]])
    expect(h.asked).toEqual([{ text: 'review the Weatherford transcript, then move to the next step', ctx: {
      summary: SUMMARY.text, at: SUMMARY.at,
      sessions: [{ title: 'Weatherford prep', provider: 'claude', state: 'waiting', movedAt: '2026-11-09T15:05:00Z', lastAsk: SUMMARY.sessions[0].lastAsk },
        { title: 'Release work', provider: 'codex', state: 'open', movedAt: '2026-11-09T14:00:00Z', lastAsk: '' }] } }])
    await flush(); await flush()
    expect(h.input.value).toBe('')
    // Empty words, or no summary on screen: nothing is asked.
    const empty = box(); empty.input.value = '   '; empty.fns.sendTodayAsk(); expect(empty.asked).toEqual([])
    const gone = box({ brief: null }); gone.input.value = 'x'; gone.fns.sendTodayAsk(); expect(gone.asked).toEqual([])
  })

  it('an older server without the summary’s sessions: the page’s own rows, without a last ask', () => {
    const h = box()
    ;(h.deps.state as any).sessions = [{ session_id: 's1', provider: 'claude', display_label: 'Weatherford prep', agent_state: 'waiting', running: true, state_since: '2026-11-09T15:00:00Z' },
      { session_id: 's2', provider: 'claude', display_label: 'Not open', running: false }]
    const ctx = h.fns.todayAskContext({ text: 'x', at: SUMMARY.at })
    expect(ctx.sessions).toEqual([{ title: 'Weatherford prep', provider: 'claude', state: 'waiting', movedAt: '2026-11-09T15:00:00Z', lastAsk: '' }])
  })
})
