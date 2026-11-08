/**
 * What counts as "Needs review" in Memories (Miles 2026-11-08, IMG_0524/0525): one predicate, memory-review.js, for the
 * Today count, the rail story and the Memories pane's To review count and list.
 *
 * REVIEW_CASES mirrors tests/test_memory_review_state.py in MU (learning_events.review_state), case for case; change
 * both together. The parity block runs the real server reader and bridge, the real Memories pane in a vm and the real
 * rail-story code from shell.js on the same needs-you blocks, and requires the same numbers from all of them. Every
 * item is hand-written in the shape the live CLI printed on 2026-11-08; none carries real memory content.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createNeedsYouReader, memoryReview, needsYouCount } from '../lib/learning-needs-you.js'
import { dispatchMemoriesWebOp } from '../lib/web-memories-bridge.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(HERE, p), 'utf8')
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }

// (gate, confidence, decision) -> state
const REVIEW_CASES: Array<[string, number | null, string | null, string]> = [
  ['rule_ready', 0.38, null, 'learning'],
  ['rule_ready', 0.55, null, 'learning'],
  ['rule_ready', 0.79, null, 'learning'],
  ['rule_ready', 0.8, null, 'needs_review'],
  ['rule_ready', 0.95, null, 'needs_review'],
  ['rule_ready', null, null, 'learning'],
  ['rule_ready', 0.95, 'dismissed', 'history'],
  ['rule_ready', 0.51, 'dismissed', 'history'],
  ['low_confidence', 0.38, null, 'learning'],
  ['low_confidence', 0.9, null, 'needs_review'],
  ['prune_ready', null, null, 'needs_review'],
  ['prune_ready', null, 'accepted', 'history'],
  ['prune_ready', null, 'pruned', 'history'],
  ['candidate', null, null, 'needs_review'],
  ['attribution', null, null, 'needs_review'],
  ['scope', null, null, 'needs_review'],
  ['contradiction', null, null, 'needs_review'],
  ['scope', null, 'reopened', 'needs_review'],
  ['no_such_gate', null, null, 'learning'],
]

describe('the Needs review predicate (memory-review.js)', () => {
  it.each(REVIEW_CASES)('%s at %s, decision %s: %s', (gate, confidence, decision, state) => {
    expect(memoryReview.reviewState(gate, confidence, decision)).toBe(state)
    expect(memoryReview.itemState({ gate, confidence }, decision)).toBe(state)
  })

  it('the bar is 0.8; an item may carry its own; a bool or a string is not a confidence', () => {
    expect(memoryReview.RULE_BAR).toBe(0.8)
    expect(memoryReview.reviewState('rule_ready', 0.6, null, 0.5)).toBe('needs_review')
    expect(memoryReview.itemState({ gate: 'rule_ready', confidence: 0.6, bar: 0.5 })).toBe('needs_review')
    expect(memoryReview.reviewState('rule_ready', true)).toBe('learning')
    expect(memoryReview.reviewState('rule_ready', '0.9')).toBe('learning')
    expect(memoryReview.itemState(7)).toBe('learning')
    expect(memoryReview.itemState(null)).toBe('learning')
    // a gate name never reaches an inherited property
    expect(memoryReview.reviewState('toString', null, null)).toBe('learning')
    expect(memoryReview.reviewState('scope', null, 'constructor')).toBe('needs_review')
  })

  it('an older producer\'s below-bar suggestions move to Learning and leave the count and gates; nothing is mutated', () => {
    const old = { count: 51, limit: 7, gates: { low_confidence: 4, prune_ready: 47 }, items: [...BELOW_BAR, ...PRUNE.slice(0, 3)] }
    const frozen = JSON.stringify(old)
    const out: any = memoryReview.normalizeBlock(old)
    expect(JSON.stringify(old)).toBe(frozen)
    expect(out.items.map((i: any) => i.gate)).toEqual(['prune_ready', 'prune_ready', 'prune_ready'])
    expect(out.count).toBe(47)
    expect(out.gates).toEqual({ prune_ready: 47 })
    expect(out.learning.map((i: any) => i.confidence)).toEqual([0.38, 0.38, 0.49, 0.55])
    expect(out.learning_count).toBe(4)
    expect(memoryReview.total(out)).toBe(47)
    expect(memoryReview.count(out)).toBe(3)
    // a block from the new producer is unchanged in what it counts
    const now: any = memoryReview.normalizeBlock(AFTER)
    expect(now.items).toEqual(AFTER.items)
    expect(now.count).toBe(47)
    expect(now.learning).toEqual(AFTER.learning)
    expect(memoryReview.normalizeBlock(null)).toBeNull()
  })

  it('a decision made on this page leaves the count and the open items; reopened does not', () => {
    const block = { count: 2, limit: 7, items: [PRUNE[0], AT_BAR] }
    expect(memoryReview.count(block, {})).toBe(2)
    expect(memoryReview.count(block, { mem_p0: 'accepted' })).toBe(1)
    expect(memoryReview.count(block, { ptn_ready: 'dismissed' })).toBe(1)
    expect(memoryReview.count(block, { ptn_ready: 'reopened' })).toBe(2)
    expect(memoryReview.learningItems({ learning: BELOW_BAR }, { ptn_a: 'dismissed' }).map((i: any) => i.lesson_id)).toEqual(['ptn_b', 'ptn_c', 'ptn_d'])
    expect(memoryReview.count({ count: 40, limit: 7 })).toBe(7)
    expect(memoryReview.count({ gates: {} })).toBeNull()
  })
})

// ── fixtures: the shapes `learning_events.py needs-you` printed on 2026-11-08, with invented ids and titles ──
const rule = (lesson: string, confidence: number, gate = 'low_confidence', cmp = '<') => ({
  gate, rank: 3, reason: `promotable at confidence ${confidence} (${cmp} 0.8)`, lesson_id: lesson, event_id: 'evt_' + lesson,
  title: 'Suggested rule ' + lesson, ts: '2026-10-21T13:49:23+00:00', store: 'correction_journal', category: null, confidence, occurrences: 3,
})
const BELOW_BAR = [rule('ptn_a', 0.38), rule('ptn_b', 0.38), rule('ptn_c', 0.49), rule('ptn_d', 0.55)]
const AT_BAR = { ...rule('ptn_ready', 0.8, 'rule_ready', '>='), bar: 0.8, state: 'needs_review' }
const PRUNE = Array.from({ length: 47 }, (_, i) => ({ gate: 'prune_ready', rank: 5, reason: 'Prune ready · never recalled', lesson_id: `mem_p${i}`, event_id: `evt_p${i}`,
  title: 'An old memory ' + i, ts: '2026-05-07T01:37:36+00:00', store: 'bot_memory', category: 'Prune ready · never recalled', type: 'memory', state: 'needs_review' }))
const BEFORE = { count: 51, limit: 7, overflow: 44, gates: { low_confidence: 4, prune_ready: 47 }, items: [...BELOW_BAR, ...PRUNE.slice(0, 3)], window_days: 14, reward_enabled: true }
const AFTER = { count: 47, limit: 7, overflow: 40, gates: { prune_ready: 47 }, items: PRUNE.slice(0, 7), window_days: 14, reward_enabled: true,
  learning: BELOW_BAR.map(r => ({ ...r, gate: 'rule_ready', bar: 0.8, state: 'learning' })), learning_count: 4, bar: 0.8 }
const MIXED = { count: 4, limit: 7, gates: { rule_ready: 1, prune_ready: 2, attribution: 1 }, window_days: 14,
  items: [{ gate: 'attribution', rank: 0, reason: "names gina near 'said' with no attribution field", lesson_id: 'mem_attr', event_id: 'evt_attr', title: 'decision: x', ts: '2026-11-06T17:20:31+00:00', store: 'bot_memory', category: 'decision', state: 'needs_review' },
    AT_BAR, PRUNE[0], PRUNE[1]], learning: [{ ...BELOW_BAR[0], gate: 'rule_ready', bar: 0.8, state: 'learning' }], learning_count: 1 }

// The real server reader, fed the CLI's stdout, then the real bridge status.
async function bridgeStatus(printed: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'cos-review-parity-'))
  writeFileSync(join(dir, 'cos_python'), '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(join(dir, 'learning_events.py'), '')
  try {
    const reader = createNeedsYouReader({ scriptsDir: dir, run: async () => ({ code: 0, stdout: JSON.stringify(printed) }) })
    const loopback = async (path: string) => path === '/api/health'
      ? { status: 200, body: { server_version: '7.0.2' } }
      : { status: 200, body: { available: true, learning: { available: true, total: 9 }, memory: {}, threads: {}, graph: {} } }
    return (await dispatchMemoriesWebOp('status', {}, loopback as any, 'x', () => reader.read())).details as Record<string, any>
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// The real rail story code from shell.js (the Memories block of loadStories), run on that status.
function railStory(details: Record<string, any>): { text: string; hot: boolean } {
  const SHELL = read('shell.js')
  const start = SHELL.indexOf('    // Memories (TodayHome.memoriesStory)')
  const end = SHELL.indexOf('    // Dictation lives on the Mac', start)
  if (start < 0 || end < 0) throw new Error('shell.js no longer has the Memories story block')
  let out = { text: '', hot: false }
  const fakeThen = (v: unknown) => ({ then: (fn: (x: unknown) => unknown) => fn(v) })
  new Function('soft', 'storyApi', 'setStory', 'FALLBACK', SHELL.slice(start, end))(
    (p: unknown) => p, () => fakeThen({ details }), (_n: string, text: string, hot: boolean) => { out = { text, hot } }, { memories: 'fallback' })
  return out
}

// The real Memories pane in a vm, its status answered with that same bridge status.
function pane(details: Record<string, any>) {
  let def: any = null
  const els = new Map<string, any>()
  const make = (id: string) => {
    let html = ''
    const node: any = { id, value: '', get innerHTML() { return html }, set innerHTML(v: string) { html = String(v) },
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
      contains: () => false, focus() {}, getAttribute: () => null }
    return node
  }
  els.set('pane-memories', make('pane-memories'))
  const answers: Record<string, unknown> = {
    status: details, 'ws:learning_page': { protocol: 1, matched_total: 0, next_cursor: null, items: [], coverage: {}, counts_by_type: {}, stores: {} },
    'ws:review_page': { protocol: 1, matched_total: 0, next_cursor: null, items: [] }, 'cues.summary': { available: false }, 'graph.status': { engine: 'lightrag' },
    'graph.search': { items: [] }, 'profile.owner': {},
  }
  const W = {
    $: (id: string) => els.get(id) ?? null, esc: (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!),
    toast() {}, readStore: () => ({}), writeStore() {}, skeletonRows: () => '', copyText: () => Promise.resolve(), parseRoute: () => ({ pane: 'memories', args: ['t', 'review'] }),
    go() {}, goBack() {}, setCrumb() {}, crumb: () => '', registerPane: (name: string, d: unknown) => { if (name === 'memories') def = d },
    api: (path: string, o: any) => {
      if (path.startsWith('/api/live-cues/')) return Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))
      const { op, args } = o.body
      const v = answers[op === 'workspace.request' ? 'ws:' + args.action : op]
      return Promise.resolve({ ok: true, message: '', details: v ?? {} })
    },
  }
  const media = { matches: true, addEventListener() {} }
  const window = { COSWeb: W, matchMedia: () => media, crypto: globalThis.crypto, localStorage: { getItem: () => null, setItem() {} } }
  const document = { getElementById: (id: string) => els.get(id) ?? null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} }, body: { classList: { toggle() {}, add() {}, remove() {} }, appendChild() {} }, activeElement: null }
  const location = { hash: '#/memories/t/review', replace() {} }
  const ctx = vm.createContext({ window, document, location, crypto: globalThis.crypto, console, Date, JSON, Math, Promise, Object, Array, String, Number, RegExp, Error, Uint8Array, URL,
    setTimeout: (fn: () => void, ms?: number) => ((ms ?? 0) >= 6000 ? 0 : setTimeout(fn, 0)), clearTimeout() {}, setInterval: () => 0, clearInterval() {} })
  vm.runInContext(read('memory-review.js'), ctx)
  vm.runInContext(read('panes/memories.js'), ctx)
  return { def, t: def._t }
}

describe('parity: Today, the rail story and the Memories pane count the same items', () => {
  for (const [name, printed, n, total, listed] of [
    ['before (older producer, 2026-11-08 live shape)', BEFORE, 3, 47, 3],
    ['after (this producer, 2026-11-08 live shape)', AFTER, 7, 47, 7],
    ['mixed gates with one suggestion at the bar', MIXED, 4, 4, 4],
  ] as Array<[string, unknown, number, number, number]>) {
    it(name, async () => {
      const details = await bridgeStatus(printed)
      // Today (app.js loadToday) and Control read learningToReview; the rail story reads it and learningToReviewTotal.
      expect(details.learningToReview).toBe(n)
      expect(details.learningToReviewTotal).toBe(total)
      expect(needsYouCount(details.needs_you)).toBe(n)
      const rail = railStory(details)
      expect(rail.text).toBe(total > n ? `Next ${n} of ${total}` : `${n} to review`)
      expect(rail.hot).toBe(n > 0)
      const p = pane(details)
      p.def.load(['t', 'review']); await flush()
      expect(p.t.needsCount()).toBe(n)
      expect(p.t.needsRows().length).toBe(listed)
      expect(p.t.viewsHtml()).toContain(`To review (${n})`)
      // Nothing under the bar is ever in the Needs you now rows.
      for (const row of p.t.needsRows()) expect(memoryReview.reviewState(row.needs.gate, (details.needs_you.items.find((i: any) => i.event_id === row.event_id) || {}).confidence)).toBe('needs_review')
    })
  }

  it('Today and the rail read the bridge\'s count, and nothing else counts memories to review', () => {
    const APP = read('app.js'), SHELL = read('shell.js')
    expect(APP.match(/details\.learningToReview\b/g)?.length).toBe(1)
    expect(SHELL.match(/\.learningToReview\b/g)?.length).toBe(1)
    expect(SHELL).toContain('d.learningToReviewTotal')
    expect(SHELL).not.toContain('/api/context/learning/review')
    // The pane's count and list come from the shared predicate only.
    const MEM = read('panes/memories.js')
    expect(MEM).toContain('R.count(')
    expect(MEM).toContain('R.openItems(')
    expect(MEM).not.toMatch(/ny\.items\.filter|ny\.count != null/)
  })

  it('index.html loads the predicate before app.js and every pane', () => {
    const html = read('index.html')
    const at = html.indexOf('<script src="/control/memory-review.js"></script>')
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(html.indexOf('<script src="/control/app.js"></script>'))
    expect(at).toBeLessThan(html.indexOf('id="lazy-panes"'))
  })
})
