/**
 * 6.99.19 Prep on COS Control Web (PREP_CONTRACT_v1): the chat's "Prep me" card. Runs the REAL panes/cos-chat.js in a
 * vm with a fake COSWeb, a fake fetch for the /api/prep routes (as server/routes/prep.ts answers them) and a fake
 * XMLHttpRequest for the media upload, and drives it the way a tap does.
 *
 * What is pinned:
 *  - no capabilities.prep: Prep me is today's plain Ask, the same request, and no /api/prep call;
 *  - with it: Prep me opens a draft (POST /api/prep/drafts with a v4 clientDraftId kept in this browser) and opening it
 *    again resumes the same draft through GET;
 *  - every write sends the draft's revision; a 409 revision_conflict adopts the newer draft and says so in one line;
 *  - Prep me posts .../run and the job it returns is an ordinary Ask in the chat (take, poll); a lost answer is retried
 *    with the same clientRequestId and then found through the draft's runs and /api/query-jobs/by-client.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes', 'cos-chat.js'), 'utf8')
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DRAFT_ID = 'prep_' + 'C'.repeat(26)
const STARTS = '2026-11-06T15:30:00.000Z'
const PREP_CAPS = { protocol: 1, maxFiles: 10, steerChars: 4000, bind: true, suggest: true, serverInstanceId: 'inst-A' }
const pdfFile = (name = 'Q4 pricing.pdf', text = 'Q4 price list: Starter is 59 a month.') => {
  const bytes = new TextEncoder().encode(text)
  return { name, size: bytes.length, type: 'application/pdf', lastModified: 0, arrayBuffer: async () => bytes.buffer.slice(0) }
}
const sha = async (text: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex')
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }

class FakeXHR {
  static all: FakeXHR[] = []
  method = ''; path = ''; headers: Record<string, string> = {}; body: unknown = null; status = 0; responseText = ''
  upload: { onprogress?: (e: unknown) => void } = {}
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null
  constructor() { FakeXHR.all.push(this) }
  open(method: string, path: string) { this.method = method; this.path = path }
  setRequestHeader(k: string, v: string) { this.headers[k] = v }
  send(body: unknown) { this.body = body }
  abort() { this.onabort?.() }
  respond(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.() }
}

type Call = { method: string; path: string; body: any; headers?: Record<string, string> }
function load(opts: { prep?: boolean; store?: Map<string, unknown> } = {}) {
  FakeXHR.all = []
  const store = opts.store ?? new Map<string, unknown>()
  const calls: Call[] = []          // every /api/prep request
  const heads: Array<Record<string, string>> = []   // their headers, in the same order
  const apiCalls: Call[] = []       // every W.api request (the Ask path)
  const draft: any = { id: DRAFT_ID, clientDraftId: '', revision: 1, title: 'Weekly marketing sync', startsAt: STARTS, steer: '', files: [], runs: [], bindings: [], conversation: { sessionId: null }, state: 'active' }
  // Scripted answers, consumed in order, for a route key like 'PATCH draft' or 'POST run'; else the default behaviour.
  const script: Record<string, Array<{ status: number; body?: unknown; delayMs?: number } | 'lost'>> = {}
  const answer = (status: number, body: unknown) => Promise.resolve({ status, text: async () => JSON.stringify(body) })
  const fetch = (path: string, o: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const method = o.method ?? 'GET', body = o.body ? JSON.parse(o.body) : undefined, url = new URL(path, 'http://x')
    calls.push({ method, path, body })
    heads.push(o.headers ?? {})
    const p = url.pathname
    const key = p === '/api/prep/drafts' ? 'POST create' : p === `/api/prep/drafts/${DRAFT_ID}` ? `${method} draft` : p.endsWith('/run') ? 'POST run' : p.endsWith('/files') ? 'POST files' : /\/files\//.test(p) ? 'DELETE file' : /\/runs\//.test(p) ? 'GET runs' : p
    const next = script[key]?.shift()
    if (next === 'lost') return Promise.reject(new Error('network'))
    if (next) return next.delayMs ? new Promise(r => setTimeout(r, next.delayMs)).then(() => answer(next.status, next.body)) : answer(next.status, next.body)
    if (key === 'POST create') { draft.clientDraftId = body.clientDraftId; return answer(201, { draft }) }
    if (key === 'GET draft') return answer(200, { draft })
    if (key === 'DELETE draft') { draft.state = 'archived'; return answer(200, { draft }) }
    if (key === 'PATCH draft') {
      if (body.revision !== draft.revision) return answer(409, { error: 'revision_conflict', draft })
      draft.steer = body.steer; draft.revision++; return answer(200, { draft })
    }
    if (key === 'POST files') {
      if (body.revision !== draft.revision) return answer(409, { error: 'revision_conflict', draft })
      for (const m of body.media) draft.files.push({ id: 'pf_' + m.id.slice(-16), name: m.name, mime: 'application/pdf', bytes: 2048, status: 'ready', kind: 'document', textChars: 40 })
      draft.revision++; return answer(200, { draft })
    }
    if (key === 'POST run') {
      if (body.revision !== draft.revision) return answer(409, { error: 'revision_conflict', draft })
      const run = { clientRequestId: body.clientRequestId, clientJobId: 'cj-' + body.clientRequestId.slice(0, 8), jobId: 'job_1', sessionId: null, draftRevision: draft.revision, createdAt: 'x' }
      draft.runs.push(run)
      return answer(202, { job: { jobId: 'job_1', clientJobId: run.clientJobId, status: 'queued' }, run, draft })
    }
    return answer(404, { error: 'not_found' })
  }
  const jobs: Record<string, unknown> = {}
  const W: Record<string, unknown> = {
    $: () => null, esc: (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    toast: () => {}, autoGrow: () => {}, md: (s: unknown) => String(s), skeletonRows: () => '',
    toDate: (s: string) => new Date(s), readStore: (k: string) => JSON.parse(JSON.stringify(store.get(k) ?? {})), writeStore: (k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))) },
    parseRoute: () => ({ pane: 'messages', args: ['cos'] }), go: () => {},
    api: (path: string, o?: { method?: string; body?: unknown }) => {
      apiCalls.push({ method: o?.method ?? 'GET', path, body: o?.body })
      if (path === '/api/health') return Promise.resolve({ status: 'ok', capabilities: { durableQueryJobs: true, ...(opts.prep ? { prep: PREP_CAPS } : {}) } })
      if (jobs[path]) return Promise.resolve(jobs[path])
      return Promise.resolve({})
    },
  }
  const media = { matches: false, addEventListener: () => {} }
  const document = {
    addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
    activeElement: null, hidden: false, body: { scrollHeight: 0 }, scrollingElement: {}, createElement: () => ({ setAttribute() {}, classList: { add() {} } }),
  }
  const window = { COSWeb: W, matchMedia: () => media, scrollTo: () => {}, localStorage: { getItem: () => null, setItem: () => {} }, navigator: { userAgent: 'Chrome' } }
  const ctx = vm.createContext({
    window, document, navigator: window.navigator, setTimeout, clearTimeout, console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto,
    fetch, XMLHttpRequest: FakeXHR, AbortController, URL, isFinite, encodeURIComponent,
  })
  vm.runInContext(SOURCE, ctx)
  const chat = W.cosChat as any
  const card = { id: 'fi_prep1', kind: 'ping', threadId: 'fi_prep1', state: 'live', title: 'Weekly marketing sync', line: 'Weekly marketing sync at 10:30 AM. Prep me?', links: [], createdAt: '2026-11-06T15:16:00.000Z',
    actions: [{ id: 'prep', label: 'Prep me', prep: { title: 'Weekly marketing sync', startsAt: STARTS, occurrence: null } }, { id: 'dismiss', label: 'Not now' }] }
  const tapPrep = () => chat.onClick({ getAttribute: (k: string) => (({ 'data-cos': 'act', 'data-item': card.id, 'data-act': 'prep' }) as Record<string, string>)[k] ?? null })
  const ready = async () => { await chat.ensureCaps(); chat._state.items = [card] }
  const type = (text: string) => chat._onPrepInput({ value: text })
  return { chat, W, calls, heads, apiCalls, draft, script, store, jobs, tapPrep, ready, type, card }
}

describe('Prep me without Prep on the server', () => {
  it('is the plain Ask it was: POST /api/query-jobs "Prep me for <title>", and no /api/prep call', async () => {
    const h = load()
    await h.ready()
    h.jobs['/api/query-jobs'] = { job: { jobId: 'job_plain', status: 'queued' } }
    h.jobs['/api/query-jobs/job_plain?generation=1'] = { job: { jobId: 'job_plain', status: 'completed', response: 'ok' } }
    h.tapPrep()
    await flush()
    const asks = h.apiCalls.filter(c => c.path === '/api/query-jobs')
    expect(asks).toHaveLength(1)
    expect(asks[0].body).toMatchObject({ query: 'Prep me for Weekly marketing sync', source: 'web', generation: 1 })
    expect(h.calls).toEqual([])
    expect(h.chat._prep()).toBe(null)
    // The old branch is still there word for word, behind the capability check.
    expect(SOURCE).toContain("if (prepOn()) return openPrep(item); if (C.caps && C.caps.jobs) submitAsk('Prep me for ' + (item.title || 'my next meeting'), ''); return; }")
  })
})

describe('the Prep composer', () => {
  it('opens a draft: POST /api/prep/drafts with a v4 clientDraftId, the title and the start; no Ask runs yet', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep()
    await flush()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: '/api/prep/drafts', body: { title: 'Weekly marketing sync', startsAt: STARTS } })
    expect(h.calls[0].body.clientDraftId).toMatch(UUID4)
    expect(h.apiCalls.filter(c => c.path === '/api/query-jobs')).toEqual([])
    expect(h.chat._prep().draft.id).toBe(DRAFT_ID)
    const html = h.chat._prepHtml()
    expect(html).toMatch(/<h3 class="mt-ask-title cc-prep-title">Prep for Weekly marketing sync<\/h3>/)
    expect(html).toMatch(/placeholder="What should this prep focus on\?"/)
    expect(html).toMatch(/maxlength="4000"/)
    expect(html).toMatch(/>Prep me<\/button>/)
    expect(html).toMatch(/<span>Add file<\/span>/)
    expect(html).toMatch(/No files yet\. Add file, paste or drop one here\./)
  })

  it('opened again (a reload), it resumes the same draft through GET; a lost create is sent again with the same clientDraftId', async () => {
    const store = new Map<string, unknown>()
    const first = load({ prep: true, store })
    await first.ready()
    first.tapPrep(); await flush()
    const cd = first.calls[0].body.clientDraftId
    const again = load({ prep: true, store })
    await again.ready()
    again.tapPrep(); await flush()
    expect(again.calls.map(c => c.method + ' ' + c.path)).toEqual(['GET /api/prep/drafts/' + DRAFT_ID])
    // A create whose answer was lost leaves only the clientDraftId; the next open sends it again (idempotent create).
    const lostStore = new Map<string, unknown>()
    const lost = load({ prep: true, store: lostStore })
    await lost.ready()
    lost.script['POST create'] = ['lost']
    lost.tapPrep(); await flush()
    expect(lost.chat._prep().note).toMatch(/COS on your Mac did not answer/)
    const cdLost = lost.calls[0].body.clientDraftId
    const retry = load({ prep: true, store: lostStore })
    await retry.ready()
    retry.tapPrep(); await flush()
    expect(retry.calls[0]).toMatchObject({ method: 'POST', path: '/api/prep/drafts', body: { clientDraftId: cdLost } })
    expect(cd).not.toBe(cdLost)
  })

  it('every write sends the revision: the steer (PATCH), a file (POST .../files after the media upload), a removal (DELETE ?revision=)', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.type('Focus on the Q4 pricing change.')
    await h.chat._savePrepSteer(); await flush()
    expect(h.calls.at(-1)).toEqual({ method: 'PATCH', path: '/api/prep/drafts/' + DRAFT_ID, body: { revision: 1, steer: 'Focus on the Q4 pricing change.' } })
    h.chat._addPrepFiles([pdfFile()])
    const x = FakeXHR.all.at(-1)!
    expect(x.path).toBe('/api/media/file')
    x.respond(200, { attachment: { id: 'm_' + 'a'.repeat(24) } })
    await flush()
    const files = h.calls.at(-1)!
    expect(files).toMatchObject({ method: 'POST', path: '/api/prep/drafts/' + DRAFT_ID + '/files', body: { revision: 2, media: [{ id: 'm_' + 'a'.repeat(24), name: 'Q4 pricing.pdf' }] } })
    expect(files.body.operationId).toMatch(UUID4)
    // Amendment 20: the sha256 of exactly the bytes the media upload sent.
    expect(files.body.media[0].sha256).toBe(await sha('Q4 price list: Starter is 59 a month.'))
    expect(h.chat._prep().ups).toEqual([])
    expect(h.chat._prepHtml()).toMatch(/Files · 1/)
    const fileId = h.draft.files[0].id
    h.chat.onClick({ getAttribute: (k: string) => (({ 'data-cos': 'prep-remove', 'data-file': fileId }) as Record<string, string>)[k] ?? null })
    await flush()
    expect(h.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/prep/drafts/' + DRAFT_ID + '/files/' + fileId + '?revision=3' })
  })

  it('a files call whose answer was lost is sent again with the same operationId; a refused one gets a new one on Retry', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST files'] = ['lost', 'lost']
    h.chat._addPrepFiles([pdfFile('Agenda.pdf')])
    FakeXHR.all.at(-1)!.respond(200, { attachment: { id: 'm_' + 'b'.repeat(24) } })
    await flush()
    const sent = h.calls.filter(c => c.path.endsWith('/files'))
    expect(sent).toHaveLength(2)
    expect(sent[1].body.operationId).toBe(sent[0].body.operationId)
    const up = h.chat._prep().ups[0]
    expect(up.state).toBe('failed')
    // Retry after no answer: still the same operation, and the bytes are not uploaded again.
    const xhrs = FakeXHR.all.length
    h.script['POST files'] = [{ status: 413, body: { error: 'prep_file_limit' } }]
    h.chat.onClick({ getAttribute: (k: string) => (({ 'data-cos': 'prep-retry', 'data-up': up.id }) as Record<string, string>)[k] ?? null })
    await flush()
    expect(FakeXHR.all.length).toBe(xhrs)
    expect(h.calls.filter(c => c.path.endsWith('/files'))[2].body.operationId).toBe(sent[0].body.operationId)
    expect(up.error).toBe('This prep holds 10 files. Remove one, then retry.')
    // Refused, so nothing was recorded: the next Retry is a new operation.
    h.chat.onClick({ getAttribute: (k: string) => (({ 'data-cos': 'prep-retry', 'data-up': up.id }) as Record<string, string>)[k] ?? null })
    await flush()
    const last = h.calls.filter(c => c.path.endsWith('/files')).at(-1)!
    expect(last.body.operationId).toMatch(UUID4)
    expect(last.body.operationId).not.toBe(sent[0].body.operationId)
    expect(h.chat._prep().ups).toEqual([])
  })

  it('a video is refused with what to attach instead, and nothing is uploaded', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.chat._addPrepFiles([{ name: 'clip.mov', size: 1000, type: 'video/quicktime', lastModified: 0 }])
    expect(FakeXHR.all).toHaveLength(0)
    expect(h.chat._prep().note).toBe('clip.mov is a video. Prep reads documents and the text in images, so attach a PDF, a text file or a screenshot.')
  })

  it('409 revision_conflict: the newer draft is adopted (its notes and revision), and one plain line says so', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    // Changed on the Mac meanwhile: revision 1 is stale.
    h.draft.revision = 5; h.draft.steer = 'From the Mac: ask about the budget.'
    h.type('My words')
    await h.chat._savePrepSteer(); await flush()
    const p = h.chat._prep()
    expect(p.draft.revision).toBe(5)
    expect(p.steer).toBe('From the Mac: ask about the budget.')
    expect(p.note).toBe('This prep changed on another device. It now shows the newest notes and files. Check them, then try again.')
    expect(p.warn).toBe(true)
    expect(p.note.split('\n')).toHaveLength(1)
    // The next write goes with the adopted revision and is accepted.
    h.type('Mine again')
    await h.chat._savePrepSteer(); await flush()
    expect(h.calls.at(-1)!.body).toEqual({ revision: 5, steer: 'Mine again' })
    expect(h.draft.steer).toBe('Mine again')
  })
})

describe('the Mac\u2019s server identity on every write (amendment 19)', () => {
  it('every Prep write names the server it expects; reads do not', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.type('Notes'); await h.chat._savePrepSteer(); await flush()
    h.chat._runPrep(); await flush(12)
    h.calls.forEach((c, i) => {
      if (c.method === 'GET') expect(h.heads[i]['X-COS-Expected-Server-Instance']).toBeUndefined()
      else expect(h.heads[i]['X-COS-Expected-Server-Instance']).toBe('inst-A')
    })
    expect(h.calls.filter(c => c.method !== 'GET').length).toBeGreaterThanOrEqual(3)
  })

  it('409 server_instance_mismatch: one line says the server changed, the draft is read again, and unsaved words go out to the new server', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['PATCH draft'] = [{ status: 409, body: { error: 'server_instance_mismatch', serverInstanceId: 'inst-B' } }]
    h.script['GET draft'] = [{ status: 200, body: { draft: { ...h.draft, serverInstanceId: 'inst-B' }, serverInstanceId: 'inst-B' } }]
    h.type('Keep these words')
    await h.chat._savePrepSteer(); await flush()
    expect(h.chat._prep().note).toBe('The COS server on your Mac changed since this prep opened. It was read again. Check it, then try again.')
    expect(h.calls.map(c => c.method + ' ' + c.path.replace(DRAFT_ID, 'D'))).toEqual(['POST /api/prep/drafts', 'PATCH /api/prep/drafts/D', 'GET /api/prep/drafts/D'])
    expect(h.chat._prep().steer).toBe('Keep these words')
    await new Promise(r => setTimeout(r, 800)); await flush()
    const last = h.calls.length - 1
    expect(h.calls[last]).toMatchObject({ method: 'PATCH', body: { steer: 'Keep these words' } })
    expect(h.heads[last]['X-COS-Expected-Server-Instance']).toBe('inst-B')
  })

  it('428 (a write without the header) is a bug: it says nothing changed and to reload the page', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST run'] = [{ status: 428, body: { error: 'server_instance_required' } }]
    const errors: unknown[] = []
    const orig = console.error; console.error = (...a: unknown[]) => { errors.push(a) }
    try { h.chat._runPrep(); await flush(12) } finally { console.error = orig }
    expect(h.chat._prep().note).toBe('This page did not name the Mac\u2019s COS server, so nothing was changed. Reload the page, then try again.')
    expect(errors).toHaveLength(1)
  })

  it('409 media_hash_mismatch: nothing is added, and Retry uploads the bytes again', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST files'] = [{ status: 409, body: { error: 'media_hash_mismatch' } }]
    h.chat._addPrepFiles([pdfFile()])
    FakeXHR.all.at(-1)!.respond(200, { attachment: { id: 'm_' + 'c'.repeat(24) } })
    await flush(12)
    const up = h.chat._prep().ups[0]
    expect(up.error).toBe('The file your Mac kept does not match what this browser sent. Retry to send it again.')
    const before = FakeXHR.all.length
    h.chat.onClick({ getAttribute: (k: string) => (({ 'data-cos': 'prep-retry', 'data-up': up.id }) as Record<string, string>)[k] ?? null })
    expect(FakeXHR.all.length).toBe(before + 1)
  })

  it('the stand-in sha256 (a plain-http page has no crypto.subtle) matches the browser\u2019s', async () => {
    const h = load({ prep: true })
    for (const text of ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'Q4 price list: Starter is 59 a month.'.repeat(40)]) {
      expect(h.chat._sha256Js(new TextEncoder().encode(text))).toBe(await sha(text))
    }
  })
})

describe('a conflict while the person is still typing', () => {
  it('the newer draft still wins: words typed during the refused save are replaced, and not sent on top of it', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['PATCH draft'] = [{ status: 409, body: { error: 'revision_conflict', draft: { ...h.draft, revision: 9, steer: 'From the Mac' } }, delayMs: 30 }]
    h.type('First words')
    const saving = h.chat._savePrepSteer()
    await new Promise(r => setTimeout(r, 5))
    expect(h.calls.filter(c => c.method === 'PATCH')).toHaveLength(1)
    h.type('First words, and more')
    await saving; await flush()
    const p = h.chat._prep()
    expect(p.steer).toBe('From the Mac')
    expect(p.dirty).toBe(false)
    await new Promise(r => setTimeout(r, 800)); await flush()
    expect(h.calls.filter(c => c.method === 'PATCH')).toHaveLength(1)
  })
})

describe('Prep me runs as an ordinary Ask in the chat', () => {
  it('saves the notes, posts .../run with a fresh clientRequestId and the current revision, and polls the job like any Ask', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.type('What does Gina need from me?')
    h.chat._runPrep()
    await flush(12)
    const run = h.calls.find(c => c.path.endsWith('/run'))!
    expect(h.calls.map(c => c.method + ' ' + c.path.replace(DRAFT_ID, 'D'))).toEqual(['POST /api/prep/drafts', 'PATCH /api/prep/drafts/D', 'POST /api/prep/drafts/D/run'])
    expect(run.body.clientRequestId).toMatch(UUID4)
    expect(run.body.revision).toBe(2)
    expect(run.body.continue).toBeUndefined()
    const asks = h.chat._state.asks
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ cid: 'cj-' + run.body.clientRequestId.slice(0, 8), jobId: 'job_1', status: 'queued', query: 'Prep: Weekly marketing sync\nWhat does Gina need from me?', replyKey: '' })
    // The composer closes; the answer is in the chat.
    expect(h.chat._prep()).toBe(null)
    h.jobs['/api/query-jobs/job_1?generation=1'] = { job: { jobId: 'job_1', status: 'completed', response: 'Here is your prep.', globalMsgNum: 812 } }
    await new Promise(r => setTimeout(r, 700)); await flush()
    expect(h.apiCalls.some(c => c.path === '/api/query-jobs/job_1?generation=1')).toBe(true)
    expect(asks[0]).toMatchObject({ status: 'completed', response: 'Here is your prep.', no: 812 })
  })

  it('a lost answer: the same clientRequestId is sent again, then GET .../runs/<clientRequestId> answers the run and its job', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST run'] = ['lost', 'lost']
    h.script['GET runs'] = [{ status: 200, body: { run: { clientRequestId: 'x', clientJobId: 'cj-runs', jobId: 'job_5' }, job: { jobId: 'job_5', clientJobId: 'cj-runs', status: 'running' } } }]
    h.chat._runPrep()
    await flush(12)
    const runs = h.calls.filter(c => c.path.endsWith('/run'))
    expect(runs.map(c => c.body.clientRequestId)).toEqual([runs[0].body.clientRequestId, runs[0].body.clientRequestId])
    expect(h.calls.at(-1)!.path).toBe('/api/prep/drafts/' + DRAFT_ID + '/runs/' + runs[0].body.clientRequestId)
    expect(h.chat._state.asks[0]).toMatchObject({ cid: 'cj-runs', jobId: 'job_5', status: 'running' })
  })

  it('202 from .../runs (still being admitted): it asks again, then shows the job once the run is accepted', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST run'] = ['lost', 'lost']
    h.script['GET runs'] = [{ status: 202, body: { run: { clientRequestId: 'x', clientJobId: 'cj-wait', state: 'submitting' } } },
      { status: 200, body: { run: { clientRequestId: 'x', clientJobId: 'cj-wait', jobId: 'job_w' }, job: { jobId: 'job_w', clientJobId: 'cj-wait', status: 'running' } } }]
    h.chat._runPrep()
    await flush(12)
    expect(h.chat._prep().note).toBe('Your Mac is starting this prep.')
    expect(h.chat._state.asks).toHaveLength(0)
    await new Promise(r => setTimeout(r, 1600)); await flush(12)
    expect(h.calls.filter(c => /\/runs\//.test(c.path))).toHaveLength(2)
    expect(h.chat._state.asks[0]).toMatchObject({ cid: 'cj-wait', jobId: 'job_w' })
  })

  it('503 run_status_unknown from .../runs: nothing is claimed, and the next tap is the same request', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST run'] = ['lost', 'lost']
    h.script['GET runs'] = [{ status: 503, body: { error: 'run_status_unknown' } }]
    h.chat._runPrep()
    await flush(12)
    expect(h.chat._prep().note).toBe('COS on your Mac did not answer, so this prep may not have started. Tap Prep me again; it will not run twice.')
    expect(h.calls.filter(c => c.method === 'GET' && c.path === '/api/prep/drafts/' + DRAFT_ID)).toEqual([])
  })

  it('run_not_accepted: nothing is claimed and the next tap is the same request', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST run'] = ['lost', 'lost', 'lost', 'lost']
    h.script['GET runs'] = [{ status: 404, body: { error: 'run_not_accepted' } }]
    h.chat._runPrep()
    await flush(12)
    expect(h.chat._prep().note).toBe('COS on your Mac did not answer, so this prep may not have started. Tap Prep me again; it will not run twice.')
    expect(h.chat._state.asks).toHaveLength(0)
    h.chat._runPrep()
    await flush(12)
    const runs = h.calls.filter(c => c.path.endsWith('/run'))
    expect(new Set(runs.map(c => c.body.clientRequestId)).size).toBe(1)
  })

  it('a server without the runs route: the run is found in the draft and its job by client id', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST run'] = ['lost', 'lost']
    // The run did land on the Mac: the draft lists it.
    h.script['GET draft'] = [{ status: 200, body: { draft: { ...h.draft, runs: [] } } }]
    h.chat._runPrep()
    await flush(6)
    const runs = h.calls.filter(c => c.path.endsWith('/run'))
    expect(runs).toHaveLength(2)
    expect(runs[1].body.clientRequestId).toBe(runs[0].body.clientRequestId)
    // Not in the draft: nothing is claimed, and the next tap is the same request.
    expect(h.chat._prep().note).toBe('COS on your Mac did not answer, so this prep may not have started. Tap Prep me again; it will not run twice.')
    expect(h.chat._state.asks).toHaveLength(0)
    const rid = runs[0].body.clientRequestId
    h.script['POST run'] = ['lost', 'lost']
    h.script['GET draft'] = [{ status: 200, body: { draft: { ...h.draft, runs: [{ clientRequestId: rid, clientJobId: 'cj-found', jobId: 'job_9', sessionId: null, draftRevision: 1, createdAt: 'x' }] } } }]
    h.jobs['/api/query-jobs/by-client/cj-found?generation=1'] = { job: { jobId: 'job_9', status: 'running', partialText: 'Working' } }
    h.chat._runPrep()
    await flush(12)
    expect(h.calls.filter(c => c.path.endsWith('/run')).slice(-2).map(c => c.body.clientRequestId)).toEqual([rid, rid])
    expect(h.apiCalls.some(c => c.path === '/api/query-jobs/by-client/cj-found?generation=1')).toBe(true)
    expect(h.chat._state.asks[0]).toMatchObject({ cid: 'cj-found', jobId: 'job_9', status: 'running' })
  })

  it('409 run_in_progress shows the run already going, as its Ask, instead of starting a second', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST run'] = [{ status: 409, body: { error: 'run_in_progress', run: { clientRequestId: 'r0', clientJobId: 'cj-going', jobId: 'job_7' } } }]
    h.jobs['/api/query-jobs/by-client/cj-going?generation=1'] = { job: { jobId: 'job_7', status: 'running' } }
    h.chat._runPrep()
    await flush(12)
    expect(h.chat._state.asks).toHaveLength(1)
    expect(h.chat._state.asks[0]).toMatchObject({ cid: 'cj-going', jobId: 'job_7' })
    expect(h.chat._prep()).toBe(null)
  })

  it('a 202 with no job (the server replays an earlier run) is found by its clientJobId', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST run'] = [{ status: 202, body: { job: null, run: { clientRequestId: 'r', clientJobId: 'cj-replay', jobId: 'job_3' }, draft: h.draft } }]
    h.jobs['/api/query-jobs/by-client/cj-replay?generation=1'] = { job: { jobId: 'job_3', status: 'running' } }
    h.chat._runPrep()
    await flush(12)
    expect(h.chat._state.asks[0]).toMatchObject({ cid: 'cj-replay', jobId: 'job_3' })
  })

  it('a conflict on the notes stops the run: nothing runs on words the person has not seen', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.draft.revision = 7; h.draft.steer = 'Changed on the Mac'
    h.type('Mine')
    h.chat._runPrep()
    await flush(12)
    expect(h.calls.filter(c => c.path.endsWith('/run'))).toEqual([])
    expect(h.chat._prep().note).toMatch(/^This prep changed on another device\./)
    expect(h.chat._prep().running).toBe(false)
  })

  it('continues the prep conversation on a second Prep me', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.draft.runs = [{ clientRequestId: 'a', clientJobId: 'b', jobId: 'c', sessionId: 's1', draftRevision: 1, createdAt: 'x' }]
    h.draft.conversation = { sessionId: 's1' }
    h.script['GET draft'] = []
    h.chat._prep().draft = { ...h.draft }
    h.chat._runPrep()
    await flush(12)
    expect(h.calls.find(c => c.path.endsWith('/run'))!.body.continue).toBe(true)
  })
})

describe('a run in flight is never lost (review item 1)', () => {
  const storedRun = (h: ReturnType<typeof load>) => (h.store.get('cos.web.prepDrafts') as any)['item:fi_prep1'].run
  it('an unanswered run (503) is kept with the draft: after a reload the next tap resends the same clientRequestId with its own model and effort', async () => {
    const store = new Map<string, unknown>()
    const h = load({ prep: true, store })
    await h.ready()
    h.chat._state.model = 'opus'; h.chat._state.effort = 'max'
    h.tapPrep(); await flush()
    h.script['POST run'] = [{ status: 503, body: { error: 'run_status_unknown' } }]
    h.chat._runPrep(); await flush(12)
    const first = h.calls.find(c => c.path.endsWith('/run'))!.body
    expect(storedRun(h)).toEqual({ rid: first.clientRequestId, model: 'opus', effort: 'max', cont: false })
    expect(h.chat._prep().note).toMatch(/Tap Prep me again; it will not run twice\.$/)
    // A reload: a new page, the same browser storage, and a different model picked since.
    const again = load({ prep: true, store })
    await again.ready()
    again.chat._state.model = 'sonnet'
    again.tapPrep(); await flush()
    again.chat._runPrep(); await flush(12)
    const second = again.calls.find(c => c.path.endsWith('/run'))!.body
    expect(second).toMatchObject({ clientRequestId: first.clientRequestId, model: 'opus', effort: 'max' })
    expect(again.chat._state.asks).toHaveLength(1)
    expect(storedRun(again)).toBeUndefined()
  })

  it('a later write (the notes saved again) keeps the stored run with the draft', async () => {
    const store = new Map<string, unknown>()
    const h = load({ prep: true, store })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST run'] = [{ status: 503, body: { error: 'run_status_unknown' } }]
    h.chat._runPrep(); await flush(12)
    const rid = h.calls.find(c => c.path.endsWith('/run'))!.body.clientRequestId
    h.type('One more line'); await h.chat._savePrepSteer(); await flush()
    expect(storedRun(h).rid).toBe(rid)
    const again = load({ prep: true, store })
    await again.ready()
    again.tapPrep(); await flush()
    again.chat._runPrep(); await flush(12)
    expect(again.calls.find(c => c.path.endsWith('/run'))!.body.clientRequestId).toBe(rid)
  })

  it('closing and reopening the composer keeps the run too', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST run'] = [{ status: 503, body: { error: 'maintenance' } }]
    h.chat._runPrep(); await flush(12)
    const rid = h.calls.find(c => c.path.endsWith('/run'))!.body.clientRequestId
    h.chat._closePrep()
    h.tapPrep(); await flush()
    h.chat._runPrep(); await flush(12)
    expect(h.calls.filter(c => c.path.endsWith('/run')).map(c => c.body.clientRequestId)).toEqual([rid, rid])
  })

  it('409 run_in_progress still submitting: that run is sent again with its own clientRequestId and params, and then shown', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST run'] = [{ status: 409, body: { error: 'run_in_progress', run: { clientRequestId: '11111111-2222-4333-8444-555555555555', clientJobId: 'cj-x', state: 'submitting', model: 'fable', effort: 'high', continue: true } } }]
    h.chat._runPrep(); await flush(14)
    const runs = h.calls.filter(c => c.path.endsWith('/run'))
    expect(runs).toHaveLength(2)
    expect(runs[1].body).toMatchObject({ clientRequestId: '11111111-2222-4333-8444-555555555555', model: 'fable', effort: 'high', continue: true })
    expect(h.chat._state.asks).toHaveLength(1)
    expect(h.chat._state.asks[0].cid).toBe('cj-' + '11111111')
  })

  it('409 run_failed says so plainly, and the next tap is a fresh run', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST run'] = [{ status: 409, body: { error: 'run_failed', run: { clientRequestId: 'r', state: 'failed', error: 'model_unavailable' } } }]
    h.chat._runPrep(); await flush(12)
    expect(h.chat._prep().note).toBe('This prep did not start on your Mac (model unavailable). Tap Prep me to try again.')
    expect(storedRun(h)).toBeUndefined()
    h.chat._runPrep(); await flush(12)
    const runs = h.calls.filter(c => c.path.endsWith('/run'))
    expect(runs[1].body.clientRequestId).not.toBe(runs[0].body.clientRequestId)
    expect(h.chat._state.asks).toHaveLength(1)
  })
})

describe('runs the Mac no longer keeps, and no re-drive for a new id (server 357b0f5)', () => {
  const storedRun = (h: ReturnType<typeof load>) => (h.store.get('cos.web.prepDrafts') as any)['item:fi_prep1'].run
  it("outcome 'unavailable' with job null: the stored run is released, one plain line, no polling and no by-client lookup", async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST run'] = ['lost', 'lost']
    h.script['GET runs'] = [{ status: 200, body: { run: { clientRequestId: 'x', clientJobId: 'cj-gone', state: 'accepted', outcome: 'unavailable', settledAt: '2026-11-06T18:00:00.000Z', answer: null }, job: null } }]
    h.chat._runPrep(); await flush(12)
    expect(h.chat._prep().note).toBe('This prep finished earlier, but its answer is no longer kept. Tap Prep me to run it again.')
    expect(storedRun(h)).toBeUndefined()
    expect(h.chat._state.asks).toHaveLength(0)
    expect(h.apiCalls.filter(c => /query-jobs/.test(c.path))).toEqual([])
    await new Promise(r => setTimeout(r, 1700)); await flush()
    expect(h.calls.filter(c => /\/runs\//.test(c.path))).toHaveLength(1)
    // The next tap is a fresh run.
    h.chat._runPrep(); await flush(12)
    const runs = h.calls.filter(c => c.path.endsWith('/run'))
    expect(runs.at(-1)!.body.clientRequestId).not.toBe(runs[0].body.clientRequestId)
  })

  it('a replayed run that ended with its answer copied shows that answer as a finished Ask, with nothing to poll', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST run'] = [{ status: 202, body: { job: null, run: { clientRequestId: 'r', clientJobId: 'cj-old', state: 'accepted', outcome: 'unavailable', settledAt: 'x', answer: 'Kept answer.' }, draft: h.draft } }]
    h.chat._runPrep(); await flush(12)
    expect(h.chat._state.asks[0]).toMatchObject({ cid: 'cj-old', status: 'completed', response: 'Kept answer.' })
    expect(h.apiCalls.filter(c => /query-jobs/.test(c.path))).toEqual([])
    expect(h.chat._prep()).toBe(null)
  })

  it('409 run_in_progress for an accepted run (a new id never re-drives): no second POST; the run already going is shown', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    h.script['POST run'] = [{ status: 409, body: { error: 'run_in_progress', run: { clientRequestId: 'old', clientJobId: 'cj-going', state: 'accepted', jobId: 'job_g' } } }]
    h.jobs['/api/query-jobs/by-client/cj-going?generation=1'] = { job: { jobId: 'job_g', status: 'running' } }
    h.chat._runPrep(); await flush(12)
    expect(h.calls.filter(c => c.path.endsWith('/run'))).toHaveLength(1)
    expect(h.chat._state.asks[0]).toMatchObject({ cid: 'cj-going', jobId: 'job_g' })
    // Nothing in the page reads a `redriven` flag: only run.state decides a resend.
    expect(SOURCE).not.toMatch(/redriven/)
  })
})

describe('the draft limit and Archive this prep (review item 3)', () => {
  it('507 prep_draft_limit says how to free a slot', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.script['POST create'] = [{ status: 507, body: { error: 'prep_draft_limit' } }]
    h.tapPrep(); await flush()
    expect(h.chat._prep().note).toBe('COS already keeps as many preps as it can. Open an old prep card, tap Archive this prep, then try again.')
  })

  it('Archive this prep: DELETE the draft with the server header, forget it here, close; the card then starts a new draft', async () => {
    const h = load({ prep: true })
    await h.ready()
    h.tapPrep(); await flush()
    expect(h.chat._prepHtml()).toMatch(/data-cos="prep-archive">Archive this prep<\/button>/)
    const cd = h.calls[0].body.clientDraftId
    h.chat.onClick({ getAttribute: (k: string) => (({ 'data-cos': 'prep-archive' }) as Record<string, string>)[k] ?? null })
    await flush()
    const i = h.calls.findIndex(c => c.method === 'DELETE')
    expect(h.calls[i].path).toBe('/api/prep/drafts/' + DRAFT_ID + '?revision=1')
    expect(h.heads[i]['X-COS-Expected-Server-Instance']).toBe('inst-A')
    expect(h.chat._prep()).toBe(null)
    expect((h.store.get('cos.web.prepDrafts') as any)['item:fi_prep1']).toBeUndefined()
    h.tapPrep(); await flush()
    const create = h.calls.filter(c => c.path === '/api/prep/drafts').at(-1)!
    expect(create.body.clientDraftId).not.toBe(cd)
  })
})

describe('copy rules on the Prep strings', () => {
  it('no em dashes and no arrows in the Prep code; buttons say what they do', () => {
    const block = SOURCE.slice(SOURCE.indexOf('// ── Prep (6.99.19'), SOURCE.indexOf('// ── events (delegated'))
    expect(block.length).toBeGreaterThan(4000)
    expect(block).not.toMatch(/[—→←⇒]/)
    for (const label of ['>Close<', 'Prep me', '>Remove<', 'Add file']) expect(block).toContain(label)
  })
})
