/**
 * Drop it P2 on COS Control Web: the pinned chat's buttons for pings, reminders and follow-ups. Runs the real
 * panes/cos-chat.js in a vm with a fake COSWeb and document, and drives its click handler the way a tap does.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panes', 'cos-chat.js'), 'utf8')

function load() {
  const posts: Array<{ path: string; body: unknown }> = []
  const went: string[] = []
  const answers: Record<string, unknown> = {}
  const input = { value: '', focused: false, focus() { this.focused = true } }
  const W: Record<string, unknown> = {
    $: () => null, esc: (s: unknown) => String(s), toast: () => {}, autoGrow: () => {}, md: (s: unknown) => String(s), skeletonRows: () => '',
    toDate: (s: string) => new Date(s), readStore: () => ({}), writeStore: () => {},
    parseRoute: () => ({ pane: 'messages', args: ['cos'] }),
    go: (pane: string) => { went.push(pane) },
    api: (path: string, opts?: { method?: string; body?: { action?: string } }) => {
      if (opts?.method === 'POST') posts.push({ path, body: opts.body })
      const key = opts?.body?.action ?? path
      return Promise.resolve(answers[key] ?? {})
    },
  }
  const media = { matches: false, addEventListener: () => {} }
  const document = {
    addEventListener: () => {}, querySelectorAll: () => [], getElementById: (id: string) => id === 'cos-input' ? input : null,
    activeElement: null, hidden: false, body: { scrollHeight: 0 }, scrollingElement: {}, createElement: () => ({ setAttribute() {}, classList: { add() {} } }),
  }
  const window = { COSWeb: W, matchMedia: () => media, scrollTo: () => {}, localStorage: { getItem: () => null, setItem: () => {} } }
  const ctx = vm.createContext({ window, document, setTimeout, clearTimeout, console, Date, JSON, Math, Promise, localStorage: window.localStorage, crypto: globalThis.crypto })
  vm.runInContext(SOURCE, ctx)
  const chat = W.cosChat as { onClick: (t: { getAttribute: (k: string) => string | null }) => unknown; _state: { items: unknown[]; caps: unknown } }
  const tap = (itemId: string, action: string) => chat.onClick({ getAttribute: k => (({ 'data-cos': 'act', 'data-item': itemId, 'data-act': action }) as Record<string, string>)[k] ?? null })
  return { chat, tap, posts, went, input, answers }
}
const flush = () => new Promise(r => setTimeout(r, 0))

describe('COS Control Web chat: P2 buttons', () => {
  it('reminder Done and Snooze post to /api/inbox/action, and the ping loses its buttons', async () => {
    const h = load()
    const ping = { id: 'fi_1', kind: 'ping', threadId: 'fi_1', state: 'live', actions: [{ id: 'snooze_1h', label: 'Snooze 1 hour' }], links: [{ kind: 'reminder', id: 'd1', label: 'x' }] }
    h.chat._state.items = [ping]
    h.answers.snooze_1h = { item: { ...ping, state: 'done', actions: [] } }
    h.tap('fi_1', 'snooze_1h')
    await flush()
    expect(h.posts).toEqual([{ path: '/api/inbox/action', body: { itemId: 'fi_1', action: 'snooze_1h' } }])
    expect((h.chat._state.items[0] as { state: string }).state).toBe('done')
    for (const a of ['reminder_done', 'snooze_tomorrow']) { h.tap('fi_1', a); await flush() }
    expect(h.posts.map(p => (p.body as { action: string }).action)).toEqual(['snooze_1h', 'reminder_done', 'snooze_tomorrow'])
  })

  it('a reminder that asked: Tomorrow 9:00 posts when:tomorrow_9', async () => {
    const h = load()
    h.chat._state.items = [{ id: 'fi_2', kind: 'receipt', threadId: 'd2', state: 'live', actions: [], links: [] }]
    h.tap('fi_2', 'when:tomorrow_9')
    await flush()
    expect(h.posts).toEqual([{ path: '/api/inbox/action', body: { itemId: 'fi_2', action: 'when:tomorrow_9' } }])
  })

  it('opens go where the link lives; Reply starts a reminder in the composer; nothing unknown is posted', async () => {
    const h = load()
    h.chat._state.items = [
      { id: 'a', kind: 'followup', threadId: 'd', state: 'live', actions: [], links: [{ kind: 'session', id: 'codex:x', label: 'x' }] },
      { id: 'b', kind: 'followup', threadId: 'd', state: 'live', actions: [], links: [{ kind: 'card', id: 'w', label: 'x' }] },
      { id: 'c', kind: 'ping', threadId: 'c', state: 'live', actions: [], links: [{ kind: 'thread', id: 't', label: 'x' }] },
      { id: 'e', kind: 'ping', threadId: 'e', state: 'live', actions: [], links: [{ kind: 'meeting', id: 'm', label: 'x' }] },
      { id: 'f', kind: 'ping', threadId: 'f', state: 'live', actions: [], links: [] },
    ]
    h.tap('a', 'open_result'); h.tap('b', 'open_result'); h.tap('c', 'open'); h.tap('e', 'open'); h.tap('f', 'review')
    expect(h.went).toEqual(['sessions', 'work', 'threads', 'meetings', 'work'])
    h.tap('f', 'reply')
    expect(h.input).toMatchObject({ value: 'remind me ', focused: true })
    h.tap('f', 'launch_rockets')
    await flush()
    expect(h.posts).toEqual([])
  })
})

describe('COS Control Web chat: one Dismiss (6.99.15)', () => {
  const count = (html: string) => (html.match(/data-act="dismiss"/g) ?? []).length
  it('a follow-up that carries its own Dismiss shows it once', () => {
    const h = load()
    const itemHtml = (h.chat as unknown as { _itemHtml: (i: unknown) => string })._itemHtml
    const followup = { id: 'fi_9', kind: 'followup', threadId: 'fi_9', state: 'live', needsReply: true, title: 'Nav approved', line: '2 follow-ups',
      actions: [{ id: 'open_card', label: 'Review' }, { id: 'dismiss', label: 'Dismiss' }], links: [], createdAt: '2026-11-05T22:30:00.000Z' }
    expect(count(itemHtml(followup))).toBe(1)
  })
  it('an item that needs a reply and carries no Dismiss still gets one', () => {
    const h = load()
    const itemHtml = (h.chat as unknown as { _itemHtml: (i: unknown) => string })._itemHtml
    const asked = { id: 'fi_8', kind: 'question', threadId: 'fi_8', state: 'live', needsReply: true, line: 'Which thread?', actions: [], links: [], createdAt: '2026-11-05T22:30:00.000Z' }
    expect(count(itemHtml(asked))).toBe(1)
  })
})
