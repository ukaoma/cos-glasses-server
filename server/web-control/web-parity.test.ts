/**
 * 6.99.12, Even app parity on COS Control Web: the Ask composer without Drop it, attachments, Model and Effort from
 * /api/models, Reply from the message reader, and session question cards. 6.99.13: Drop with files. Runs the REAL panes/cos-chat.js and
 * panes/questions.js in a vm with a fake COSWeb, document, XMLHttpRequest and fetch, and drives them the way taps do.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHAT_SOURCE = readFileSync(join(HERE, 'panes', 'cos-chat.js'), 'utf8')
const QUESTIONS_SOURCE = readFileSync(join(HERE, 'panes', 'questions.js'), 'utf8')
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1'
const flush = () => new Promise(r => setTimeout(r, 0))

class FakeXHR {
  static all: FakeXHR[] = []
  method = ''; path = ''; headers: Record<string, string> = {}; body: unknown = null; status = 0; responseText = ''
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {}
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null
  constructor() { FakeXHR.all.push(this) }
  open(method: string, path: string) { this.method = method; this.path = path }
  setRequestHeader(k: string, v: string) { this.headers[k] = v }
  send(body: unknown) { this.body = body }
  abort() { this.onabort?.() }
  respond(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.() }
}

function loadChat(opts: { ua?: string; answers?: Record<string, unknown> } = {}) {
  FakeXHR.all = []
  const posts: Array<{ path: string; body: any }> = []
  const answers: Record<string, unknown> = opts.answers ?? {}
  const inputs: Record<string, { value: string; focus: () => void }> = {}
  let authShown = 0
  const W: Record<string, unknown> = {
    $: () => null, esc: (s: unknown) => String(s), toast: () => {}, autoGrow: () => {}, md: (s: unknown) => String(s), skeletonRows: () => '',
    toDate: (s: string) => new Date(s), readStore: () => ({}), writeStore: () => {},
    parseRoute: () => ({ pane: 'messages', args: ['cos'] }), go: () => {}, showAuth: () => { authShown++ },
    api: (path: string, o?: { method?: string; body?: unknown }) => {
      if (o?.method === 'POST') posts.push({ path, body: o.body })
      const a = answers[path]
      return typeof a === 'function' ? (a as (o: unknown) => Promise<unknown>)(o) : Promise.resolve(a ?? {})
    },
  }
  const media = { matches: false, addEventListener: () => {} }
  const document = {
    addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null,
    getElementById: (id: string) => (inputs[id] ??= { value: '', focus() {} }),
    activeElement: null, hidden: false, body: { scrollHeight: 0 }, scrollingElement: {}, createElement: () => ({ setAttribute() {}, classList: { add() {} } }),
  }
  const navigator = { userAgent: opts.ua ?? CHROME }
  const window = { COSWeb: W, matchMedia: () => media, scrollTo: () => {}, localStorage: { getItem: () => null, setItem: () => {} }, navigator }
  const ctx = vm.createContext({ window, document, navigator, setTimeout, clearTimeout, console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto, XMLHttpRequest: FakeXHR })
  vm.runInContext(CHAT_SOURCE, ctx)
  const chat = W.cosChat as any
  const k = (name: string) => chat._composer(name)
  const tap = (what: string, form = 'chat') => chat.onClick({ getAttribute: (a: string) => (a === 'data-cos' ? what : null), closest: () => ({ getAttribute: () => form }) })
  const input = (id: string) => document.getElementById(id)
  return { chat, k, tap, posts, inputs, input, answers, authShown: () => authShown }
}
const file = (name: string, size: number, type: string) => ({ name, size, type, lastModified: Date.UTC(2026, 10, 4, 23, 0) })

describe('the composer: what can be attached (classify)', () => {
  it('takes photos, PDF, TXT, MD, CSV, JSON, XLSX, MP4 and MOV, and refuses the rest with a plain line', () => {
    const { chat } = loadChat()
    expect(chat._classify(file('a.jpg', 10, 'image/jpeg'))).toEqual({ kind: 'photo' })
    expect(chat._classify(file('Plan.pdf', 10, 'application/pdf'))).toEqual({ kind: 'doc', mime: 'application/pdf' })
    expect(chat._classify(file('notes.md', 10, ''))).toEqual({ kind: 'doc', mime: 'text/markdown' })
    expect(chat._classify(file('notes.md', 10, 'application/octet-stream'))).toEqual({ kind: 'doc', mime: 'text/markdown' })
    expect(chat._classify(file('q3.xlsx', 10, ''))).toEqual({ kind: 'doc', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    expect(chat._classify(file('clip.mov', 10, 'video/quicktime'))).toEqual({ kind: 'video', mime: 'video/quicktime' })
    expect(chat._classify(file('a.zip', 10, 'application/zip')).refuse).toMatch(/cannot be attached\. COS takes photos, PDF/)
    expect(chat._classify(file('a.webm', 10, 'video/webm')).refuse).toMatch(/Use MP4 or MOV/)
  })

  it('refuses HEIC outside Safari, and takes it in Safari (which can draw it into the canvas)', () => {
    expect(loadChat({ ua: CHROME }).chat._classify(file('IMG_1.HEIC', 10, 'image/heic')).refuse).toMatch(/HEIC photo, which only Safari can read/)
    expect(loadChat({ ua: CHROME }).chat._classify(file('IMG_1.heic', 10, '')).refuse).toMatch(/HEIC/)
    expect(loadChat({ ua: SAFARI }).chat._classify(file('IMG_1.HEIC', 10, 'image/heic'))).toEqual({ kind: 'photo' })
  })

  it('says plainly when a file is too big: 64 MB for documents, 100 MB for video', () => {
    const { chat } = loadChat()
    expect(chat._classify(file('big.pdf', 64 * 1048576, 'application/pdf'))).toEqual({ kind: 'doc', mime: 'application/pdf' })
    expect(chat._classify(file('big.pdf', 64 * 1048576 + 1, 'application/pdf')).refuse).toBe('big.pdf is 64 MB. The largest file COS takes is 64 MB.')
    expect(chat._classify(file('big.pdf', 70 * 1048576, 'application/pdf')).refuse).toBe('big.pdf is 70 MB. The largest file COS takes is 64 MB.')
    expect(chat._classify(file('long.mp4', 100 * 1048576, 'video/mp4'))).toEqual({ kind: 'video', mime: 'video/mp4' })
    expect(chat._classify(file('long.mp4', 100 * 1048576 + 1, 'video/mp4')).refuse).toMatch(/The largest video COS takes is 100 MB/)
  })
})

describe('the composer: uploads', () => {
  it('a document goes raw to /api/media/file with the headers the server reads, and becomes an attachment id', async () => {
    const h = loadChat()
    h.chat._addFiles(h.k('chat'), [file('Q3 plan.pdf', 2048, 'application/pdf')])
    expect(FakeXHR.all).toHaveLength(1)
    const x = FakeXHR.all[0]!
    expect(x.method).toBe('POST')
    expect(x.path).toBe('/api/media/file')
    expect(x.headers).toEqual({ 'X-COS-Web': '1', 'Content-Type': 'application/pdf', 'X-COS-Filename': 'Q3%20plan.pdf', 'X-COS-Captured-At': '2026-11-04T23:00:00.000Z' })
    expect((x.body as { name: string }).name).toBe('Q3 plan.pdf')
    expect(h.k('chat').atts[0].state).toBe('uploading')
    x.upload.onprogress?.({ lengthComputable: true, loaded: 1024, total: 2048 })
    expect(h.k('chat').atts[0].progress).toBe(0.5)
    x.respond(200, { attachment: { id: 'm_pdf1', mime: 'application/pdf' } })
    await flush()
    expect(h.k('chat').atts[0]).toMatchObject({ state: 'ready', mediaId: 'm_pdf1' })
  })

  it('a 401 mid-upload never opens the sign-in screen: the words and the file stay, and the chip says why', async () => {
    const h = loadChat()
    const k = h.k('chat')
    h.input('cos-input').value = 'What does this plan miss?'
    k.draft = 'What does this plan miss?'
    h.chat._addFiles(k, [file('Q3 plan.pdf', 2048, 'application/pdf')])
    FakeXHR.all[0]!.respond(401, { error: 'unauthorized' })
    await flush()
    expect(h.authShown()).toBe(0)
    expect(k.draft).toBe('What does this plan miss?')
    expect(k.atts).toHaveLength(1)
    expect(k.atts[0]).toMatchObject({ state: 'failed', error: 'Signed out' })
    expect(k.signedOut).toBe(true)
    expect(k.note).toMatch(/signed out\. Your message and files are kept/)
    // Ask waits: a failed file is retried or removed first.
    h.tap('ask')
    await flush()
    expect(h.posts.filter(p => p.path === '/api/query-jobs')).toEqual([])
    // Sign in again is a button the person presses, and Retry sends the same file again.
    h.tap('sign-in')
    expect(h.authShown()).toBe(1)
    h.chat.onClick({ getAttribute: (a: string) => (a === 'data-cos' ? 'att-retry' : a === 'data-att' ? k.atts[0].id : null), closest: () => ({ getAttribute: () => 'chat' }) })
    expect(FakeXHR.all).toHaveLength(2)
    expect(FakeXHR.all[1]!.body).toBe(FakeXHR.all[0]!.body)
  })

  it('five attachments at most; a sixth, a too-big file and a zip are refused before any upload', () => {
    const h = loadChat()
    const k = h.k('chat')
    h.chat._addFiles(k, [1, 2, 3, 4, 5, 6].map(n => file(`n${n}.txt`, 10, 'text/plain')))
    expect(k.atts).toHaveLength(5)
    expect(FakeXHR.all).toHaveLength(5)
    expect(k.note).toBe('Up to 5 attachments per message. n6.txt was not added.')
    const h2 = loadChat()
    h2.chat._addFiles(h2.k('chat'), [file('huge.pdf', 65 * 1048576, 'application/pdf'), file('a.zip', 10, 'application/zip')])
    expect(h2.k('chat').atts).toHaveLength(0)
    expect(FakeXHR.all).toHaveLength(0)
    expect(h2.k('chat').note).toMatch(/^huge\.pdf is 65 MB\. The largest file COS takes is 64 MB\. a\.zip cannot be attached/)
  })
})

describe('the composer: Ask, Reply and Drop', () => {
  const admitted = (sessionId: string, no: number) => ({ '/api/query-jobs': { job: { jobId: 'j-' + no, sessionId, globalMsgNum: no, status: 'queued' } } })

  it('Ask carries the ready attachment ids (never more than five), the model and the effort', async () => {
    const h = loadChat({ answers: admitted('s-new', 412) })
    h.chat._state.caps = { dropIt: false, jobs: true, steer: false }
    h.chat._state.model = 'codex-frontier'
    h.chat._state.effort = 'max'
    const k = h.k('chat')
    k.atts = [1, 2, 3, 4, 5, 6].map(n => ({ id: 'a' + n, name: 'p' + n + '.jpg', kind: 'photo', state: 'ready', mediaId: 'm' + n, thumb: '' }))
    h.input('cos-input').value = 'What is on these shelves?'
    h.tap('ask')
    await flush()
    const sent = h.posts.find(p => p.path === '/api/query-jobs')!.body
    expect(sent).toMatchObject({ generation: 1, query: 'What is on these shelves?', source: 'web', model: 'codex-frontier', effort: 'max' })
    expect(sent.attachmentIds).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect(sent).not.toHaveProperty('sessionId')
    await flush()
    // Sent: the box and the chips are cleared, and the chat now continues that conversation.
    expect(k.atts).toEqual([])
    expect(h.chat._state.session).toMatchObject({ id: 's-new' })
    expect(h.chat._state.asks[0]).toMatchObject({ no: 412, atts: [{ name: 'p1.jpg' }, { name: 'p2.jpg' }, { name: 'p3.jpg' }, { name: 'p4.jpg' }, { name: 'p5.jpg' }] })
  })

  it('Ask waits while a file is still uploading', async () => {
    const h = loadChat()
    h.chat._state.caps = { dropIt: false, jobs: true, steer: false }
    const k = h.k('chat')
    k.atts = [{ id: 'a1', name: 'x.pdf', kind: 'doc', state: 'uploading', mediaId: '' }]
    h.input('cos-input').value = 'Summarize it'
    h.tap('ask')
    await flush()
    expect(h.posts).toEqual([])
  })

  it('Reply sends that turn\'s sessionId and leaves the chat\'s own conversation alone', async () => {
    const h = loadChat({ answers: admitted('s-turn', 413) })
    h.chat._state.caps = { dropIt: false, jobs: true, steer: false }
    h.chat._state.session = { id: 's-chat', day: 'x' }
    const html = h.chat.replyHtml('409', { no: 409, sessionId: 's-turn', query: 'q', text: 't' })
    expect(html).toContain('data-cos-form="reply-409"')
    expect(html).toContain('Reply to Message #409')
    expect(html).not.toContain('data-cos="drop"')
    const k = h.k('reply-409')
    h.input(k.inputId).value = 'And who owns the slides?'
    h.tap('ask', 'reply-409')
    await flush()
    const sent = h.posts.find(p => p.path === '/api/query-jobs')!.body
    expect(sent).toMatchObject({ query: 'And who owns the slides?', sessionId: 's-turn', source: 'web' })
    await flush()
    expect(h.chat._state.session).toEqual({ id: 's-chat', day: 'x' })
    expect(h.chat._state.asks[0]).toMatchObject({ replyKey: 'reply-409', no: 413 })
  })

  // 6.99.13: Drop takes the files too, where the server says it does (capabilities.dropIt.attachments).
  const M = (n: number) => 'm_' + String(n).repeat(24).slice(0, 24)
  const health = (attachments?: number) => ({ capabilities: { dropIt: { enabled: true, ...(attachments === undefined ? {} : { attachments }) }, durableQueryJobs: true } })
  const dropAnswer = (extra: Record<string, unknown> = {}) => ({ '/api/drops': { drop: { id: 'd1' }, items: [], ...extra } })

  it('Drop with a photo and a PDF sends both ids with the words, and the chips clear once the Mac has them', async () => {
    const h = loadChat({ answers: dropAnswer() })
    h.chat._setCaps(health(5))
    expect(h.chat._state.caps.dropFiles).toBe(5)
    const k = h.k('chat')
    k.atts = [{ id: 'a1', name: 'Endcap.jpg', kind: 'photo', state: 'ready', mediaId: M(1) }, { id: 'a2', name: 'Q3 plan.pdf', kind: 'doc', state: 'ready', mediaId: M(2) }]
    h.input('cos-input').value = 'File this with the shelf photo'
    h.tap('drop')
    await flush()
    const sent = h.posts.find(p => p.path === '/api/drops')!.body
    expect(sent).toMatchObject({ text: 'File this with the shelf photo', source: 'web', attachmentIds: [M(1), M(2)] })
    expect(sent.dropId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    await flush()
    expect(k.atts).toEqual([])
  })

  it('an older server without dropIt.attachments keeps the words-only note and drops nothing', async () => {
    const h = loadChat({ answers: dropAnswer() })
    h.chat._setCaps(health())
    expect(h.chat._state.caps.dropFiles).toBe(0)
    const k = h.k('chat')
    k.atts = [{ id: 'a1', name: 'x.pdf', kind: 'doc', state: 'ready', mediaId: M(1) }]
    h.input('cos-input').value = 'File this'
    h.tap('drop')
    await flush()
    expect(h.posts).toEqual([])
    expect(k.note).toBe('Drop takes words only on this Mac. Ask sends the files with your words, or remove them to drop.')
    expect(k.atts).toHaveLength(1)
  })

  it('files with no words, an upload still going, and a failed upload: each says what to do and sends nothing', async () => {
    const h = loadChat({ answers: dropAnswer() })
    h.chat._setCaps(health(5))
    const k = h.k('chat')
    k.atts = [{ id: 'a1', name: 'x.pdf', kind: 'doc', state: 'ready', mediaId: M(1) }]
    h.input('cos-input').value = '  '
    h.tap('drop')
    expect(k.note).toBe('Add a few words with the files so COS knows where they go.')
    h.input('cos-input').value = 'File this'
    k.atts = [{ id: 'a1', name: 'x.pdf', kind: 'doc', state: 'uploading', mediaId: '' }]
    h.tap('drop')
    k.atts = [{ id: 'a1', name: 'x.pdf', kind: 'doc', state: 'failed', mediaId: '' }]
    h.tap('drop')
    expect(k.note).toBe('A file did not upload. Retry it or remove it, then Drop.')
    await flush()
    expect(h.posts).toEqual([])
  })

  it('a refused file keeps the words and the files in the box and says why', async () => {
    const refused = Object.assign(new Error('A file expired before it was dropped (uploads wait 4 hours). Add it again, then Drop.'), { code: 'attachment_expired' })
    const h = loadChat({ answers: { '/api/drops': () => Promise.reject(refused) } })
    h.chat._setCaps(health(5))
    const k = h.k('chat')
    k.atts = [{ id: 'a1', name: 'x.pdf', kind: 'doc', state: 'ready', mediaId: M(1) }]
    h.input('cos-input').value = 'File this'
    h.tap('drop')
    await flush(); await flush()
    expect(k.note).toBe('Not dropped: A file expired before it was dropped (uploads wait 4 hours). Add it again, then Drop. Your words and files are still here.')
    expect(k.atts).toHaveLength(1)
    expect(h.input('cos-input').value).toBe('File this')
  })

  it('a drop read as a question runs the Ask with the drop\'s files', async () => {
    const h = loadChat({ answers: { ...dropAnswer({ drop: { id: 'd1' }, next: { kind: 'ask', prompt: 'what is on this shelf?', attachmentIds: [M(3), '../x'] } }),
      '/api/query-jobs': { job: { jobId: 'j1', sessionId: 's1', globalMsgNum: 9, status: 'queued' } } } })
    h.chat._setCaps(health(5))
    h.k('chat').atts = [{ id: 'a1', name: 'shelf.jpg', kind: 'photo', state: 'ready', mediaId: M(3) }]
    h.input('cos-input').value = 'what is on this shelf?'
    h.tap('drop')
    await flush(); await flush()
    const ask = h.posts.find(p => p.path === '/api/query-jobs')!.body
    expect(ask).toMatchObject({ query: 'what is on this shelf?', attachmentIds: [M(3)] })
  })

  it('the receipt lists each file with Open; your words show what you sent; a line without files shows none', () => {
    const { chat } = loadChat()
    const receipt = chat._itemHtml({ id: 'fi_1', kind: 'receipt', threadId: 'd1', state: 'live', title: 'Filed to Work, Work', line: 'New card in the Inbox. The 2 files stay here in the COS chat with your words.',
      links: [{ kind: 'card', id: 'c1', label: 'Work' }, { kind: 'file', id: M(1), label: 'Endcap.jpg' }, { kind: 'file', id: M(2), label: 'Q3 plan.pdf' }, { kind: 'file', id: '../etc', label: 'bad' }], actions: [] })
    expect(receipt).toContain('href="/api/media/' + M(1) + '/content?variant=phone" target="_blank" rel="noopener" aria-label="Open Endcap.jpg"')
    expect(receipt).toContain('<img src="/api/media/' + M(1) + '/content?variant=thumb"')
    expect(receipt).toContain('aria-label="Open Q3 plan.pdf"')
    expect(receipt.split('<span class="cc-dfile-open">Open</span>')).toHaveLength(3)
    expect(receipt).not.toContain('../etc')
    // Never the clip's class: .cc-file is the invisible file input, and a link wearing it does not show.
    expect(receipt).not.toMatch(/class="cc-file[" ]/)
    const mine = chat._itemHtml({ id: 'fi_0', kind: 'drop', threadId: 'd1', source: 'web', line: 'File this', links: [{ kind: 'file', id: M(2), label: 'Q3 plan.pdf' }], actions: [] })
    expect(mine).toContain('cc-dfiles mine')
    expect(mine).not.toContain('cc-dfile-open')
    // After Undo the server answers the lines without their file links: nothing to open.
    expect(chat._itemHtml({ id: 'fi_2', kind: 'receipt', threadId: 'd1', state: 'live', title: 'Undone', line: 'x', links: [], actions: [] })).not.toContain('cc-dfiles')
  })

  it('with Drop it off and jobs on, the pinned row is Ask COS and the reader offers Reply; with jobs off, no Reply', () => {
    const h = loadChat()
    h.chat._state.caps = { dropIt: false, jobs: true, steer: false }
    expect(h.chat.on()).toBe(true)
    expect(h.chat.dropOn()).toBe(false)
    expect(h.chat.pinnedRowHtml(false)).toContain('>Ask COS<')
    h.chat._state.caps = { dropIt: false, jobs: false, steer: false }
    expect(h.chat.on()).toBe(false)
    expect(h.chat.replyHtml('1', { no: 1, sessionId: 's' })).toBe('')
  })
})

describe('Model and Effort come from /api/models', () => {
  it('Claude\'s tiers always; Codex from the catalog; Cursor and Ollama only when the Mac says they are ready', () => {
    const { chat } = loadChat()
    const options = [
      { preference: 'codex-frontier', id: 'gpt-5.8', displayName: 'GPT-5.8' },
      { preference: 'codex-balanced', id: 'gpt-5.8-mini', displayName: 'GPT-5.8 mini' },
      { preference: 'cursor-grok', id: 'grok-4.7', displayName: 'Grok 4.7' },
      { preference: 'ollama', id: 'llama4', displayName: 'llama4' },
      { preference: 'something-new', id: 'x' },
    ]
    expect(chat._modelsFrom({ options }).map((m: { value: string; label: string }) => `${m.value}=${m.label}`)).toEqual([
      'opus=Claude Opus', 'fable=Claude Fable', 'sonnet=Claude Sonnet', 'codex-frontier=Codex GPT-5.8', 'codex-balanced=Codex GPT-5.8 mini',
    ])
    expect(chat._modelsFrom({ options, cursorReady: true, ollamaReady: true }).map((m: { value: string }) => m.value)).toEqual([
      'opus', 'fable', 'sonnet', 'codex-frontier', 'codex-balanced', 'cursor-grok', 'ollama',
    ])
  })
})

// ── session questions (panes/questions.js) ─────────────
function loadQuestions(cap: Record<string, unknown> | null, poll: { status: number; body?: unknown; reject?: boolean }) {
  const notes: boolean[] = []
  const fetches: Array<{ url: string; init: any }> = []
  const posts: Array<{ path: string; body: any }> = []
  let authShown = 0
  const listeners: Record<string, (e: unknown) => void> = {}
  const host = {
    hidden: true, innerHTML: '',
    addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn },
    querySelector: () => null, querySelectorAll: () => [],
  }
  const shell = { classList: { contains: () => false } }
  let onShell: (() => void) | null = null
  const W = {
    esc: (s: unknown) => String(s), toast: () => {}, showAuth: () => { authShown++ },
    onShell: (fn: () => void) => { onShell = fn },
    noteServer: (up: boolean) => { notes.push(up) },
    api: (path: string, o?: { method?: string; body?: unknown }) => {
      if (o?.method === 'POST') { posts.push({ path, body: o.body }); return Promise.resolve({ ok: true }) }
      if (path === '/api/models') return Promise.resolve(cap ? { capabilities: { sessionQuestions: cap } } : {})
      return Promise.resolve({})
    },
  }
  const fetch = (url: string, init: unknown) => {
    fetches.push({ url, init })
    if (poll.reject) return Promise.reject(new TypeError('Load failed'))
    return Promise.resolve({ status: poll.status, ok: poll.status >= 200 && poll.status < 300, json: () => Promise.resolve(poll.body) })
  }
  const document = { getElementById: (id: string) => (id === 'sq-host' ? host : id === 'app-shell' ? shell : null), addEventListener: () => {}, hidden: false, activeElement: null }
  const timers: Array<() => void> = []
  const ctx = vm.createContext({
    window: { COSWeb: W, addEventListener: () => {} }, document, fetch, console, Date, JSON, Math, Promise, crypto: globalThis.crypto, isFinite,
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length }, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
  })
  vm.runInContext(QUESTIONS_SOURCE, ctx)
  const Qs = (W as any).sessionQuestions
  const fire = (type: string, target: Record<string, unknown>) => listeners[type]!({ target })
  const button = (what: string, id: string) => ({ closest: () => ({ disabled: false, getAttribute: (a: string) => (a === 'data-sq' ? what : a === 'data-sq-id' ? id : null) }) })
  return { start: () => onShell?.(), fetches, posts, Qs, fire, button, host, authShown: () => authShown, notes }
}
const ITEM_Q = {
  id: 'pq_aaaaaaaaaaaaaaaaaaaaaaaa', sessionId: 's1', provider: 'claude', kind: 'question', tool: 'AskUserQuestion',
  createdAt: new Date(Date.now() - 5_000).toISOString(), deadlineAt: new Date(Date.now() + 115_000).toISOString(), answerable: true, awayHold: false, waitingAtMac: false,
  questions: [
    { question: 'Which steps?', header: 'Release', multiSelect: true, options: [{ label: 'Publish', description: '' }, { label: 'Bump', description: '' }] },
    { question: 'Which color?', header: '', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] },
  ],
}

describe('session question cards (6.99.12)', () => {
  // QA 6.99.30 (Skeptic): Sessions and Meetings keep this 3 s read running and call no api(), so it alone tells app.js
  // whether the Mac answered; otherwise a "down" mark left Submit, Allow and Deny disabled until the 5-minute check.
  it('the poll tells app.js the Mac answered (any status, a 500 included) or did not (a network rejection)', async () => {
    for (const status of [200, 500, 502]) {
      const h = loadQuestions({ enabled: true, webClient: true }, { status, body: { enabled: true, items: [] } })
      h.start()
      await flush(); await flush(); await flush()
      expect(h.fetches, String(status)).toHaveLength(1)
      expect(h.notes, String(status)).toEqual([true])
    }
    const gone = loadQuestions({ enabled: true, webClient: true }, { status: 0, reject: true })
    gone.start()
    await flush(); await flush(); await flush()
    expect(gone.fetches).toHaveLength(1)
    expect(gone.notes).toEqual([false])
  })

  it('never calls the questions route unless the server says it takes the browser session', async () => {
    for (const cap of [null, { enabled: true }, { enabled: false, webClient: true }]) {
      const h = loadQuestions(cap, { status: 200, body: { items: [] } })
      h.start()
      await flush(); await flush()
      expect(h.fetches, JSON.stringify(cap)).toEqual([])
    }
  })

  it('polls as client=web with the session cookie; a 401 stops the poll and never signs the page out', async () => {
    const h = loadQuestions({ enabled: true, webClient: true, pollIntervalMs: 10_000 }, { status: 401, body: {} })
    h.start()
    await flush(); await flush(); await flush()
    expect(h.fetches).toHaveLength(1)
    // 6.99.26: hold=1 always; presenceAgeMs only after a touch on the page (today-actions.test.ts covers the touch).
    expect(h.fetches[0]!.url).toBe('/api/session-questions?client=web&hold=1')
    expect(h.fetches[0]!.init).toMatchObject({ credentials: 'same-origin', headers: { 'X-COS-Web': '1' } })
    expect(h.authShown()).toBe(0)
    expect(h.Qs._state.stopped).toBe(true)
  })

  it('a question: pick, then Send twice (tap then confirm) posts the answers in option order', async () => {
    const h = loadQuestions({ enabled: true, webClient: true }, { status: 200, body: { enabled: true, items: [ITEM_Q], pollIntervalMs: 10_000 } })
    h.start()
    await flush(); await flush(); await flush()
    expect(h.Qs._state.items).toHaveLength(1)
    expect(h.host.hidden).toBe(false)
    expect(h.host.innerHTML).toContain('Claude has a question')
    const pick = (q: number, o: number, checked = true) => h.fire('change', { hasAttribute: (a: string) => a === 'data-sq-pick', getAttribute: (a: string) => (({ 'data-sq-id': ITEM_Q.id, 'data-q': String(q), 'data-o': String(o) }) as Record<string, string>)[a], checked })
    pick(0, 1); pick(0, 0); pick(1, 1)
    h.fire('click', h.button('send', ITEM_Q.id))
    expect(h.posts).toEqual([])
    h.fire('click', h.button('send', ITEM_Q.id))
    await flush()
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0]!.path).toBe(`/api/session-questions/${ITEM_Q.id}/answer`)
    expect(h.posts[0]!.body.answers).toEqual([{ labels: ['Publish', 'Bump'] }, { labels: ['Blue'] }])
    expect(h.posts[0]!.body.clientAnswerId).toMatch(/^gw_[0-9a-f]{24}$/)
  })

  it('an approval: Allow once twice posts allow; Leave for the Mac posts a hand-back', async () => {
    const approval = { ...ITEM_Q, id: 'pq_bbbbbbbbbbbbbbbbbbbbbbbb', kind: 'approval', tool: 'Bash', questions: undefined, approval: { tool: 'Bash', summary: 'npm test', detail: 'npm test' } }
    const other = { ...approval, id: 'pq_cccccccccccccccccccccccc' }
    const h = loadQuestions({ enabled: true, webClient: true }, { status: 200, body: { enabled: true, items: [approval, other] } })
    h.start()
    await flush(); await flush(); await flush()
    expect(h.host.innerHTML).toContain('Claude wants to use Bash')
    h.fire('click', h.button('allow', approval.id))
    expect(h.posts).toEqual([])
    h.fire('click', h.button('allow', approval.id))
    h.fire('click', h.button('leave', other.id))
    await flush()
    expect(h.posts.map(p => [p.path.split('/')[3], p.body.decision ?? null, p.body.handBack ?? null])).toEqual([[approval.id, 'allow', null], [other.id, null, true]])
  })
})
