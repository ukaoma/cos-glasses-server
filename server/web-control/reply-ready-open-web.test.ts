/**
 * 7.0.52 (Miles 14:49, A1 in W1's map): "Open result" on a Reply ready item opens the reader of the session that
 * replied, #/sessions/<provider>/<id>, not the Sessions list.
 *
 * The chain under test, end to end on fixtures: a Stop hook envelope (parseHookEnvelope) gives the provider and the
 * session id; agentCandidate makes the item; toFeedItem and parseFeedItem store it (a JSON round trip, as the feed
 * journal does); the real panes/cos-chat.js runs in a vm and the tap is driven as a click; the route it asks for is
 * then looked up with findAgentSessionFile, the same lookup the reader route uses, against a transcript tree laid out
 * the way each provider writes one.
 *
 * What only a live tap proves: that each real CLI's hook sends the same session_id its transcript is named by (the
 * fixtures name the file by the hook's id), that the phone's browser follows the hash, and that the reader then opens.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { agentCandidate } from '../lib/ping-sources.js'
import { toFeedItem } from '../lib/ping-feed-sink.js'
import { DropStoreError, parseFeedItem, parseLink } from '../lib/drop-store.js'
import { parseHookEnvelope } from '../lib/session-hook-events.js'
import { agentSessionRoots, findAgentSessionFile } from '../lib/agent-session-store.js'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes', 'cos-chat.js'), 'utf8')

function load(o: { sessions?: unknown[] } = {}) {
  const went: Array<[string, unknown[]]> = []
  const listReads: number[] = []
  const W: Record<string, unknown> = {
    // Bounded: past 5 reads the fake list never answers, so a page that read on every paint stops and fails the count
    // instead of looping forever.
    ...(o.sessions ? { sessionList: (maxAge: number) => { listReads.push(maxAge); return listReads.length > 5 ? new Promise(() => {}) : Promise.resolve({ sessions: o.sessions }) } } : {}),
    $: () => null, esc: (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'), toast: () => {}, autoGrow: () => {}, md: (s: unknown) => String(s), skeletonRows: () => '',
    toDate: (s: string) => new Date(s), readStore: () => ({}), writeStore: () => {},
    parseRoute: () => ({ pane: 'messages', args: ['cos'] }),
    go: (pane: string, args?: unknown[]) => { went.push([pane, args ?? []]) },
    api: () => Promise.resolve({}),
  }
  const media = { matches: false, addEventListener: () => {} }
  const document = {
    addEventListener: () => {}, querySelectorAll: () => [], getElementById: () => null,
    activeElement: null, hidden: false, body: { scrollHeight: 0 }, scrollingElement: {}, createElement: () => ({ setAttribute() {}, classList: { add() {} } }),
  }
  const window = { COSWeb: W, matchMedia: () => media, scrollTo: () => {}, localStorage: { getItem: () => null, setItem: () => {} } }
  const ctx = vm.createContext({ window, document, setTimeout, clearTimeout, console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto })
  vm.runInContext(SOURCE, ctx)
  const chat = W.cosChat as { onClick: (t: { getAttribute: (k: string) => string | null }) => unknown; _state: { items: unknown[]; sessionRows?: unknown[]; host?: unknown }; _itemHtml: (i: unknown) => string; _paintFeed: (stick: boolean) => void }
  const tap = (item: { id: string }) => {
    chat._state.items = [item]
    went.length = 0
    chat.onClick({ getAttribute: k => (({ 'data-cos': 'act', 'data-item': item.id, 'data-act': 'open_result' }) as Record<string, string>)[k] ?? null })
    return went[0]
  }
  return { tap, chat, listReads }
}

const temps: string[] = []
afterAll(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true }) })
function write(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n')
  return path
}

const IDS = {
  claude: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  codex: '019a7b2c-3d4e-7f60-8a1b-2c3d4e5f6a7b',
  cursor: 'c0ffee00-1234-4abc-9def-0123456789ab',
}
/** A Stop envelope as each CLI's hook script sends it: the provider is inferred from the payload, as the server does
 *  for an unstamped script, and the id arrives in capitals to prove the server's lowercasing meets the file name. */
function stopEnvelope(provider: keyof typeof IDS, home: string) {
  const sid = IDS[provider].toUpperCase()
  const payload: Record<string, unknown> = { session_id: sid, hook_event_name: 'Stop' }
  if (provider === 'claude') payload.transcript_path = join(home, '.claude', 'projects', 'repo', `${IDS.claude}.jsonl`)
  if (provider === 'codex') payload.transcript_path = join(home, '.codex', 'sessions', '2026', '11', '16', `rollout-2026-11-16T14-00-00-${IDS.codex}.jsonl`)
  if (provider === 'cursor') payload.cursor_version = '2.1.0'
  const parsed = parseHookEnvelope(JSON.stringify({ event: 'Stop', ts: Date.parse('2026-11-16T20:49:00Z'), payload }))
  if (!parsed.ok) throw new Error('fixture envelope did not parse: ' + parsed.reason)
  return parsed.envelope
}

function stored(c: NonNullable<ReturnType<typeof agentCandidate>>) {
  // The feed journal keeps JSON; parseFeedItem is what reads it back.
  return parseFeedItem(JSON.parse(JSON.stringify(toFeedItem(c, Date.parse('2026-11-16T20:49:05Z')))))
}
/** An item as a server before 7.0.52 stored it: the same fields, no provider on the link. */
function oldItem(line: string, sid = IDS.claude, extra: Record<string, unknown> = {}) {
  return { id: 'fi_old', kind: 'ping', threadId: 'fi_old', createdAt: '2026-11-15T10:00:00.000Z', readAt: null, source: 'cos',
    title: 'Reply ready', line, links: [{ kind: 'session', id: sid, label: 'Session' }], actions: [{ id: 'open_result', label: 'Open result' }],
    state: 'live', key: `agent:${sid}:turn:${'a'.repeat(64)}`, ...extra }
}

describe('Open result opens the session that replied (7.0.52)', () => {
  for (const provider of ['claude', 'codex', 'cursor'] as const) {
    it(`${provider}: the hook's id reaches the reader route, and the reader's own lookup finds that transcript`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'cos-reply-open-')); temps.push(home)
      const roots = agentSessionRoots(home)
      const file = provider === 'claude' ? write(join(roots.claudeProjects, 'repo', `${IDS.claude}.jsonl`))
        : provider === 'codex' ? write(join(roots.codexSessions, '2026', '11', '16', `rollout-2026-11-16T14-00-00-${IDS.codex}.jsonl`))
          : write(join(roots.cursorProjects, 'Users-someone-Documents-repo', 'agent-transcripts', IDS.cursor, `${IDS.cursor}.jsonl`))
      const env = stopEnvelope(provider, home)
      expect(env.provider).toBe(provider)
      expect(env.sessionId).toBe(IDS[provider])
      const c = agentCandidate({ provider: env.provider, sessionId: env.sessionId, turnEndedAt: env.ts, turnId: 'b'.repeat(64), replyReady: true })
      expect(c).not.toBeNull()
      const item = stored(c!)
      expect(item.links).toEqual([{ kind: 'session', id: IDS[provider], label: 'Session', provider }])
      // Server metadata only: the words he sees are unchanged.
      expect(item.title).toBe('Reply ready')
      expect(item.line).toBe(`${{ claude: 'Claude', codex: 'Codex', cursor: 'Cursor' }[provider]} has a reply ready.`)
      const route = load().tap(item)
      expect(route).toEqual(['sessions', [provider, IDS[provider]]])
      expect(await findAgentSessionFile(route[1][0] as typeof provider, route[1][1] as string, roots)).toBe(file)
    })
  }

  it('an agent that finished or stopped on a task opens its session the same way', () => {
    const h = load()
    for (const failed of [false, true]) {
      const item = stored(agentCandidate({ provider: 'codex', sessionId: IDS.codex, turnEndedAt: 1_763_326_140_000, label: 'the import', failed })!)
      expect(h.tap(item)).toEqual(['sessions', ['codex', IDS.codex]])
    }
  })
})

describe('Open result on an item stored before 7.0.52 (no provider field)', () => {
  it('takes the provider from the server\'s fixed line', () => {
    const h = load()
    expect(h.tap(oldItem('Claude has a reply ready.', IDS.claude))).toEqual(['sessions', ['claude', IDS.claude]])
    expect(h.tap(oldItem('Codex has a reply ready.', IDS.codex))).toEqual(['sessions', ['codex', IDS.codex]])
    expect(h.tap(oldItem('Cursor has a reply ready.', IDS.cursor))).toEqual(['sessions', ['cursor', IDS.cursor]])
    expect(h.tap(oldItem('Codex finished the import.', IDS.codex))).toEqual(['sessions', ['codex', IDS.codex]])
    expect(h.tap(oldItem('Cursor stopped on the import. It needs a look.', IDS.cursor))).toEqual(['sessions', ['cursor', IDS.cursor]])
  })
})

describe('Open result never guesses a provider: it keeps the old tap (the Sessions list)', () => {
  const LIST = ['sessions', []]
  it('an unknown agent, or one the reader does not serve', () => {
    const h = load()
    expect(h.tap(oldItem('Your agent has a reply ready.'))).toEqual(LIST)
    expect(h.tap(oldItem('Grok has a reply ready.'))).toEqual(LIST)
  })
  it('a line that is not the server\'s fixed wording', () => {
    const h = load()
    expect(h.tap(oldItem('Claude has a reply ready. And more.'))).toEqual(LIST)
    expect(h.tap(oldItem('claude has a reply ready.'))).toEqual(LIST)
    expect(h.tap(oldItem('I think Claude has a reply ready.'))).toEqual(LIST)
  })
  it('an item whose key names another session, or that is not a COS item', () => {
    const h = load()
    expect(h.tap(oldItem('Claude has a reply ready.', IDS.claude, { key: `agent:${IDS.codex}:turn:${'a'.repeat(64)}` }))).toEqual(LIST)
    expect(h.tap(oldItem('Claude has a reply ready.', IDS.claude, { key: 'drop:d1' }))).toEqual(LIST)
    expect(h.tap(oldItem('Claude has a reply ready.', IDS.claude, { source: 'web' }))).toEqual(LIST)
  })
  it('a provider field the reader does not serve wins over the line, and refuses', () => {
    const h = load()
    for (const provider of ['grok', 'constructor', 'Claude', 7]) {
      const item = oldItem('Claude has a reply ready.')
      item.links = [{ kind: 'session', id: IDS.claude, label: 'Session', provider } as never]
      expect(h.tap(item)).toEqual(LIST)
    }
  })
  it('a session link with no id', () => {
    const h = load()
    const item = oldItem('Claude has a reply ready.')
    item.links = [{ kind: 'session', label: 'Session', provider: 'claude' } as never]
    expect(h.tap(item)).toEqual(LIST)
  })
  it('the server leaves the field off for a provider the reader does not serve, or none', () => {
    for (const provider of ['grok', undefined, 'Claude', 'ollama']) {
      const c = agentCandidate({ provider, sessionId: IDS.claude, turnEndedAt: 1_763_326_140_000, turnId: 'c'.repeat(64), replyReady: true })
      expect(c!.links).toEqual([{ kind: 'session', id: IDS.claude, label: 'Session' }])
    }
  })
})

describe('the store keeps a session link\'s provider and refuses anything else', () => {
  it('keeps claude, codex and cursor on a session link', () => {
    for (const provider of ['claude', 'codex', 'cursor']) {
      expect(parseLink({ kind: 'session', id: IDS.claude, label: 'Session', provider })).toEqual({ kind: 'session', id: IDS.claude, label: 'Session', provider })
    }
    expect(parseLink({ kind: 'session', id: IDS.claude, label: 'Session' })).toEqual({ kind: 'session', id: IDS.claude, label: 'Session' })
  })
  it('refuses an unknown provider, and a provider on any other kind of link', () => {
    expect(() => parseLink({ kind: 'session', id: IDS.claude, label: 'Session', provider: 'grok' })).toThrow(DropStoreError)
    expect(() => parseLink({ kind: 'session', id: IDS.claude, label: 'Session', provider: '' })).toThrow(DropStoreError)
    expect(() => parseLink({ kind: 'card', id: 'c1', label: 'Card', provider: 'claude' })).toThrow(DropStoreError)
  })
})

describe('a Reply ready card is headed by its session\'s name (7.0.52, Miles 14:52)', () => {
  const title = (html: string) => /<p class="cc-card-title">([^<]*)<\/p>/.exec(html)?.[1]
  const line = (html: string) => /<p class="cc-card-line">([^<]*)<\/p>/.exec(html)?.[1]
  const row = (provider: string, id: string, extra: Record<string, unknown> = {}) => ({ provider, session_id: id, display_label: 'Fix the importer', ...extra })
  it('the name the Sessions list shows, with the provider kept in the line under it', () => {
    const h = load()
    h.chat._state.sessionRows = [row('codex', IDS.codex), row('claude', IDS.claude, { display_label: 'Draft the brief', title_override: 'Q4 brief' })]
    const item = stored(agentCandidate({ provider: 'codex', sessionId: IDS.codex, turnEndedAt: 1_763_326_140_000, turnId: 'd'.repeat(64), replyReady: true })!)
    expect(title(h.chat._itemHtml(item))).toBe('Fix the importer')
    expect(line(h.chat._itemHtml(item))).toBe('Codex has a reply ready.')
    // A COS rename wins, as in the Sessions list; an old item finds its session by the provider in its line.
    expect(title(h.chat._itemHtml(oldItem('Claude has a reply ready.', IDS.claude)))).toBe('Q4 brief')
  })
  it('plain text: a name with markup is shown as text, never as HTML', () => {
    const h = load()
    h.chat._state.sessionRows = [row('codex', IDS.codex, { display_label: '<img src=x onerror=alert(1)> **bold**' })]
    const html = h.chat._itemHtml(oldItem('Codex has a reply ready.', IDS.codex))
    expect(html).not.toContain('<img')
    expect(title(html)).toBe('&lt;img src=x onerror=alert(1)&gt; bold')
  })
  it('says "Reply ready" when the name is not known: no list, not in it, another provider with the same id, no title, or no provider', () => {
    const h = load()
    const item = oldItem('Codex has a reply ready.', IDS.codex)
    expect(title(h.chat._itemHtml(item))).toBe('Reply ready')
    h.chat._state.sessionRows = [row('codex', IDS.cursor)]
    expect(title(h.chat._itemHtml(item))).toBe('Reply ready')
    h.chat._state.sessionRows = [row('claude', IDS.codex)]
    expect(title(h.chat._itemHtml(item))).toBe('Reply ready')
    h.chat._state.sessionRows = [row('codex', IDS.codex, { display_label: '' })]
    expect(title(h.chat._itemHtml(item))).toBe('Reply ready')
    h.chat._state.sessionRows = [row('codex', IDS.codex)]
    expect(title(h.chat._itemHtml(oldItem('Your agent has a reply ready.', IDS.codex)))).toBe('Reply ready')
  })
  it('only a Reply ready card: a finished task keeps its own title', () => {
    const h = load()
    h.chat._state.sessionRows = [row('codex', IDS.codex)]
    const item = stored(agentCandidate({ provider: 'codex', sessionId: IDS.codex, turnEndedAt: 1_763_326_140_000, label: 'the import' })!)
    expect(title(h.chat._itemHtml(item))).toBe('the import')
  })
  it('the stored item never carries the name: the journal and the timeline COS reads keep "Reply ready"', () => {
    const item = stored(agentCandidate({ provider: 'codex', sessionId: IDS.codex, turnEndedAt: 1_763_326_140_000, turnId: 'e'.repeat(64), replyReady: true })!)
    expect(JSON.stringify(item)).not.toContain('Fix the importer')
    expect(item.title).toBe('Reply ready')
  })
  it('the chat reads the session list once when a Reply ready card is in it, then repaints with the name', async () => {
    const h = load({ sessions: [row('codex', IDS.codex)] })
    const feed: { innerHTML: string; contains: () => boolean; querySelector: () => null; querySelectorAll: () => never[]; scrollTop: number; scrollHeight: number; clientHeight: number } =
      { innerHTML: '', contains: () => false, querySelector: () => null, querySelectorAll: () => [], scrollTop: 0, scrollHeight: 0, clientHeight: 0 }
    h.chat._state.host = { querySelector: (sel: string) => (sel === '[data-cos-feed]' ? feed : null) }
    h.chat._state.items = [oldItem('Codex has a reply ready.', IDS.codex)]
    h.chat._paintFeed(false)
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(feed.innerHTML).toContain('<p class="cc-card-title">Fix the importer</p>')
    h.chat._paintFeed(false); h.chat._paintFeed(false)
    expect(h.listReads, 'one read, then a minute of quiet').toEqual([60000])
  })
  it('no Reply ready card, no read of the list', () => {
    const h = load({ sessions: [] })
    h.chat._state.host = { querySelector: (sel: string) => (sel === '[data-cos-feed]' ? { innerHTML: '', contains: () => false, querySelector: () => null, querySelectorAll: () => [] } : null) }
    h.chat._state.items = []
    h.chat._paintFeed(false)
    expect(h.listReads).toEqual([])
  })
})
