/**
 * 6.99.16: the COS thread on COS Control Web. Runs the real panes/cos-chat.js in a vm with a fake COSWeb and
 * document (the cos-chat-p2.test.ts harness), and drives Ask and New thread the way taps do.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes', 'cos-chat.js'), 'utf8')
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }

type Answer = unknown | ((body: any) => unknown)
function load(answers: Record<string, Answer>) {
  const calls: Array<{ method: string; path: string; body: any }> = []
  const inputs: Record<string, { value: string; focus: () => void }> = {}
  const W: Record<string, unknown> = {
    $: () => null, esc: (s: unknown) => String(s), toast: () => {}, autoGrow: () => {}, md: (s: unknown) => String(s), skeletonRows: () => '',
    toDate: (s: string) => new Date(s), readStore: () => ({}), writeStore: () => {},
    parseRoute: () => ({ pane: 'messages', args: ['cos'] }), go: () => {},
    api: (path: string, o?: { method?: string; body?: unknown }) => {
      calls.push({ method: o?.method ?? 'GET', path, body: o?.body })
      const a = answers[path]
      const v = typeof a === 'function' ? (a as (b: unknown) => unknown)(o?.body) : a
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? {})
    },
  }
  const media = { matches: false, addEventListener: () => {} }
  const document = {
    addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null,
    getElementById: (id: string) => (inputs[id] ??= { value: '', focus() {} }),
    activeElement: null, hidden: false, body: { scrollHeight: 0 }, scrollingElement: {}, createElement: () => ({ setAttribute() {}, classList: { add() {} } }),
  }
  const window = { COSWeb: W, matchMedia: () => media, scrollTo: () => {}, localStorage: { getItem: () => null, setItem: () => {} } }
  // The page's poll waits 600 ms to 4 s between reads; here every wait is a turn of the event loop.
  const fastTimeout = (fn: () => void) => setTimeout(fn, 0)
  const ctx = vm.createContext({ window, document, setTimeout: fastTimeout, clearTimeout, console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto })
  vm.runInContext(SOURCE, ctx)
  const chat = W.cosChat as any
  chat._state.caps = { dropIt: true, jobs: true, steer: false, thread: true, dropFiles: 0 }
  const ask = (text: string) => { inputs['cos-input'] = inputs['cos-input'] ?? { value: '', focus() {} }; inputs['cos-input'].value = text; chat.onClick({ getAttribute: (a: string) => (a === 'data-cos' ? 'ask' : null), closest: () => ({ getAttribute: () => 'chat' }) }) }
  const tap = (what: string) => chat.onClick({ getAttribute: (a: string) => (a === 'data-cos' ? what : null), closest: () => null })
  const jobs = () => calls.filter(c => c.path === '/api/query-jobs')
  const turns = () => calls.filter(c => c.path === '/api/cos-thread/turn')
  return { chat, ask, tap, calls, jobs, turns }
}
const thread = (next: Record<string, unknown>, asks = 3) => ({ protocol: 1, capTokens: 150000, thread: { id: 'th_1', startedAt: 'x', lastAskAt: null, asks, segments: 1, sessionId: 'sess0042', provider: null, contextTokens: 120000 }, next })
const admitted = (sessionId: string, no: number) => ({ job: { jobId: 'j-' + no, sessionId, globalMsgNum: no, status: 'queued' } })

describe('COS Control Web: the COS thread (6.99.16)', () => {
  it('continue: reads the thread first and sends its sessionId, with no digest', async () => {
    const h = load({ '/api/cos-thread': thread({ mode: 'continue', sessionId: 'sess0042', reason: 'continue', digest: null }), '/api/query-jobs': admitted('sess0042', 501) })
    h.ask('What is on my plate tomorrow?')
    await flush()
    const order = h.calls.map(c => c.path)
    expect(order.indexOf('/api/cos-thread')).toBeLessThan(order.indexOf('/api/query-jobs'))
    expect(h.jobs()).toHaveLength(1)
    expect(h.jobs()[0]!.body).toMatchObject({ query: 'What is on my plate tomorrow?', source: 'web', sessionId: 'sess0042' })
    expect(h.jobs()[0]!.body).not.toHaveProperty('reference')
    expect(h.chat._threadLine()).toBe('Continues your COS thread · 3 asks')
  })

  it('fresh: sends no sessionId and carries the digest as the Ask\'s reference, never inside the question', async () => {
    const digest = 'Earlier in this COS thread (a summary carried over; ask COS to search History or Messages for more):\n- You asked: x'
    const h = load({ '/api/cos-thread': thread({ mode: 'fresh', sessionId: null, reason: 'size', digest }), '/api/query-jobs': admitted('sess0099', 502) })
    h.chat._state.session = { id: 'sess-old-day', day: 'today' }  // the per-day session is not used while the thread is on
    h.ask('Next question')
    await flush()
    const body = h.jobs()[0]!.body
    expect(body).not.toHaveProperty('sessionId')
    expect(body.query).toBe('Next question')
    expect(body.reference).toEqual({ query: 'Summary carried over from earlier in this COS thread', response: digest })
    expect(h.chat._threadLine()).toBe('New thread. It carries a short summary of the last one.')
    // Fresh with nothing to carry: no reference at all.
    const h2 = load({ '/api/cos-thread': thread({ mode: 'fresh', sessionId: null, reason: 'empty', digest: null }, 0), '/api/query-jobs': admitted('sess0100', 503) })
    h2.ask('First ever')
    await flush()
    expect(h2.jobs()[0]!.body).not.toHaveProperty('sessionId')
    expect(h2.jobs()[0]!.body).not.toHaveProperty('reference')
  })

  it('posts the turn once when the Ask finishes, with its session, answer and message number', async () => {
    let polls = 0
    const h = load({
      '/api/cos-thread': thread({ mode: 'continue', sessionId: 'sess0042', reason: 'continue', digest: null }),
      '/api/query-jobs': admitted('sess0042', 504),
      '/api/query-jobs/j-504?generation=1&trail=1': () => (++polls < 3 ? { job: { jobId: 'j-504', status: 'running', sessionId: 'sess0042', globalMsgNum: 504 } }
        : { job: { jobId: 'j-504', status: 'completed', response: 'Two meetings and a dentist.', sessionId: 'sess0042', globalMsgNum: 504 } }),
      '/api/cos-thread/turn': thread({ mode: 'continue', sessionId: 'sess0042', reason: 'continue', digest: null }, 4),
    })
    h.ask('What is on my plate tomorrow?')
    await flush(30)
    expect(h.turns()).toHaveLength(1)
    const cid = h.jobs()[0]!.body.clientJobId
    expect(h.turns()[0]!.body).toEqual({ clientId: cid, sessionId: 'sess0042', query: 'What is on my plate tomorrow?', answer: 'Two meetings and a dentist.', messageNo: 504 })
    // Finishing again (a late repaint or a second poll) never posts it twice, done or still posting.
    const a = h.chat._state.asks[0]
    expect(a.turnState).toBe('done')
    h.chat._postTurn(a)
    a.turnState = 'posting'
    h.chat._postTurn(a)
    await flush()
    expect(h.turns()).toHaveLength(1)
    expect(h.chat._threadLine()).toBe('Continues your COS thread · 4 asks')
  })

  it('a second Ask while the first is still answering continues the first one\'s conversation without reading the thread', async () => {
    const h = load({
      '/api/cos-thread': thread({ mode: 'fresh', sessionId: null, reason: 'size', digest: 'Earlier in this COS thread (a summary carried over; ask COS to search History or Messages for more):' }),
      '/api/query-jobs': (b: any) => admitted(b.sessionId ?? 'sess0200', 600),
      '/api/query-jobs/j-600?generation=1&trail=1': { job: { jobId: 'j-600', status: 'running', sessionId: 'sess0200', globalMsgNum: 600 } },
    })
    h.ask('First')
    await flush()
    const reads = h.calls.filter(c => c.path === '/api/cos-thread').length
    h.ask('Second, while the first runs')
    await flush()
    expect(h.calls.filter(c => c.path === '/api/cos-thread').length).toBe(reads)
    expect(h.jobs()[1]!.body).toMatchObject({ sessionId: 'sess0200' })
    expect(h.jobs()[1]!.body).not.toHaveProperty('reference')
  })

  it('New thread posts /api/cos-thread/new with {} and shows the new-thread line', async () => {
    const h = load({ '/api/cos-thread/new': thread({ mode: 'fresh', sessionId: null, reason: 'manual', digest: 'Earlier in this COS thread (a summary carried over; ask COS to search History or Messages for more):' }, 0) })
    h.tap('new-thread')
    await flush()
    expect(h.calls.filter(c => c.method === 'POST')).toEqual([{ method: 'POST', path: '/api/cos-thread/new', body: {} }])
    expect(h.chat._threadLine()).toBe('New thread. It carries a short summary of the last one.')
  })

  it('without the capability the old rule stands: the per-day session, no thread reads, no turn posts', async () => {
    const h = load({ '/api/query-jobs': admitted('sess-day', 505), '/api/query-jobs/j-505?generation=1&trail=1': { job: { jobId: 'j-505', status: 'completed', response: 'ok', sessionId: 'sess-day' } } })
    h.chat._state.caps = { dropIt: true, jobs: true, steer: false, thread: false, dropFiles: 0 }
    h.chat._state.session = { id: 'sess-day', day: 'today' }
    h.ask('Old style')
    await flush(20)
    expect(h.calls.some(c => c.path.startsWith('/api/cos-thread'))).toBe(false)
    expect(h.jobs()[0]!.body).toMatchObject({ sessionId: 'sess-day' })
  })

  it('reads the capability from /api/health: thread only inside an enabled dropIt', () => {
    const h = load({})
    h.chat._setCaps({ capabilities: { dropIt: { enabled: true, thread: { protocol: 1 } }, durableQueryJobs: true } })
    expect(h.chat._state.caps.thread).toBe(true)
    h.chat._setCaps({ capabilities: { dropIt: { enabled: false, thread: { protocol: 1 } }, durableQueryJobs: true } })
    expect(h.chat._state.caps.thread).toBe(false)
    h.chat._setCaps({ capabilities: { dropIt: { enabled: true }, durableQueryJobs: true } })
    expect(h.chat._state.caps.thread).toBe(false)
  })

  it('Ask is on for a health body shaped like the live one (features.durableQueryJobs, no capabilities.durableQueryJobs)', async () => {
    const h = load({ '/api/query-jobs': admitted('sess0300', 700), '/api/cos-thread': thread({ mode: 'continue', sessionId: 'sess0300', reason: 'continue', digest: null }) })
    h.chat._state.caps = null
    const live = { status: 'ok', features: { durableQueryJobs: true, durableQueryJobsProtocol: 1 }, capabilities: { dropIt: { protocol: 1, enabled: true, source: 'settings', p2Settings: 1, attachments: 5, thread: { protocol: 1 } } } }
    h.chat._setCaps(live)
    expect(h.chat.askOn()).toBe(true)
    h.ask('Is Ask on?')
    await flush()
    // The web Ask still names itself (source 'web'), so the server fills in the message era and number.
    expect(h.jobs()).toHaveLength(1)
    expect(h.jobs()[0]!.body).toMatchObject({ source: 'web', generation: 1, sessionId: 'sess0300', activityToolMode: 'status' })
    // Off stays off.
    h.chat._setCaps({ features: { durableQueryJobs: false }, capabilities: {} })
    expect(h.chat.askOn()).toBe(false)
  })
})
