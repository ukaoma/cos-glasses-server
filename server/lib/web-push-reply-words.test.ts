// 7.0.52 C (Miles 16:08; lead 16:30 on X1's read, wk47_2026/cos_orchestrator_focus_mode/X1_session_reply_notifications.md):
// the session's name on the lock screen, only on a phone whose owner chose words for it (the existing per-device showWords;
// off for a new device). Body only; the notification title stays "COS". One session: "Reply ready: <title> (Claude)", the
// title read from the Sessions list's own cache at send time, cut to 60 code points, with controls, bidi and zero-width
// characters stripped and ** and backticks dropped; no title: "Reply ready: session ab12cd34 (Claude)". Several sessions:
// the count only. The provider word comes from the provider enum, never from text. Never reply text; never in the URL.
import { describe, expect, it } from 'vitest'
import { bannerPayload, replyBody, REPLY_TITLE_CHARS } from './web-push-sender.js'
import { PingEngine, type PingBanner, type PingFeedSink, type PingState } from './ping-engine.js'
import { agentCandidate } from './ping-sources.js'
import { taskInstant } from './morning-brief-schedule.js'

const ORIGIN = 'https://mac-x1.example-tailnet.ts.net:3143'
const A = 'ab12cd34-0000-0000-0000-00000000000a', B = 'bb12cd34-0000-0000-0000-00000000000b', C = 'cb12cd34-0000-0000-0000-00000000000c'
const reply = (over: Partial<PingBanner> = {}): PingBanner => ({ feedIds: ['fi_1'], title: 'Reply ready', line: 'Claude has a reply ready.', sources: ['agent'], exempt: false, replies: true, sessions: [{ id: A, provider: 'claude' }], ...over })
const shown = (b: PingBanner, showWords: boolean, titles: Record<string, string> = {}) =>
  JSON.parse(bannerPayload(b, ORIGIN, showWords, id => titles[id] ?? null).toString()).notification as { title: string; body: string; navigate: string }

describe('words on the lock screen for a reply', () => {
  it('one session with words on: its title and the provider word; the notification title stays COS', () => {
    const n = shown(reply(), true, { [A]: 'Bottle POS pricing page' })
    expect(n).toMatchObject({ title: 'COS', body: 'Reply ready: Bottle POS pricing page (Claude)' })
    expect(shown(reply({ sessions: [{ id: B, provider: 'codex' }] }), true, { [B]: 'Fix the build' }).body).toBe('Reply ready: Fix the build (Codex)')
    expect(shown(reply({ sessions: [{ id: C, provider: 'cursor' }] }), true, { [C]: 'Docs' }).body).toBe('Reply ready: Docs (Cursor)')
  })
  it('no title known: the first 8 of the id', () => {
    expect(shown(reply(), true).body).toBe('Reply ready: session ab12cd34 (Claude)')
    expect(shown(reply(), true, { [A]: ' \u200b**`` ' }).body).toBe('Reply ready: session ab12cd34 (Claude)')   // nothing left after cleaning
  })
  it('no provider: no provider word, never a guess from the line', () => {
    expect(shown(reply({ sessions: [{ id: A }], line: 'Codex has a reply ready.' }), true, { [A]: 'Plan' }).body).toBe('Reply ready: Plan')
  })
  it('several sessions: the count only, no names', () => {
    const b = reply({ feedIds: ['fi_1', 'fi_2', 'fi_3'], sessions: [{ id: A, provider: 'claude' }, { id: B, provider: 'codex' }, { id: C }] })
    const n = shown(b, true, { [A]: 'Secret one', [B]: 'Secret two', [C]: 'Secret three' })
    expect(n.body).toBe('3 sessions replied')
    expect(JSON.stringify(n)).not.toContain('Secret')
  })
  it('words off: the kind only, as today, whatever the title', () => {
    expect(shown(reply(), false, { [A]: 'Secret title' }).body).toBe('Session update')
    expect(shown(reply({ feedIds: ['fi_1', 'fi_2'], sessions: [{ id: A, provider: 'claude' }, { id: B }] }), false, { [A]: 'x' }).body).toBe('2 updates')
  })
  it('not a reply banner: words on keeps today\'s line (finished or stopped on), and a mixed banner too', () => {
    const done = reply({ replies: undefined, title: 'Build', line: 'Claude finished Build.' })
    expect(shown(done, true, { [A]: 'Secret title' }).body).toBe('Claude finished Build.')
    expect(shown(reply({ sources: ['agent', 'reminder'], line: 'Reply ready, Call Sam' }), true, { [A]: 'Secret' }).body).toBe('Reply ready, Call Sam')
  })
  it('the title never reaches the URL or the notification title', () => {
    const n = shown(reply(), true, { [A]: 'Title with/slash?and#hash' })
    expect(n.navigate).toBe(`${ORIGIN}/control#/sessions/claude/${A}`)
    expect(n.title).toBe('COS')
  })
})

describe('cleaning the title', () => {
  const body = (title: string) => replyBody([{ id: A, provider: 'claude' }], () => title)
  it('cut to REPLY_TITLE_CHARS code points, ending in an ellipsis, never splitting a surrogate pair', () => {
    expect(REPLY_TITLE_CHARS).toBe(60)
    const long = 'x'.repeat(REPLY_TITLE_CHARS + 5)
    expect(body(long)).toBe(`Reply ready: ${'x'.repeat(REPLY_TITLE_CHARS - 1)}… (Claude)`)
    expect(body('x'.repeat(REPLY_TITLE_CHARS))).toBe(`Reply ready: ${'x'.repeat(REPLY_TITLE_CHARS)} (Claude)`)
    const emoji = '😀'.repeat(REPLY_TITLE_CHARS + 1)
    const got = body(emoji)
    expect(Array.from(got.slice('Reply ready: '.length, -' (Claude)'.length))).toHaveLength(REPLY_TITLE_CHARS)
    expect(got).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
  it('controls, bidi and zero-width characters, line and paragraph separators stripped; ** and backticks dropped; whitespace collapsed', () => {
    expect(body('a\u0000b\u001fc\u007fd\u0085e')).toBe('Reply ready: a b c d e (Claude)')
    expect(body('\u202eevil\u202c \u2066x\u2069 \u200ey\u200f')).toBe('Reply ready: evil x y (Claude)')
    expect(body('zero\u200bwidth\u200c\u200d\ufeffjoin')).toBe('Reply ready: zerowidthjoin (Claude)')
    expect(body('line\none\u2028two\u2029three\r\nfour')).toBe('Reply ready: line one two three four (Claude)')
    expect(body('**Bold** and `code`  ``x``')).toBe('Reply ready: Bold and code x (Claude)')
  })
  it('other invisible characters (X1 16:4x) are removed too; a title made only of them falls back to the id', () => {
    expect(body('a\u00adb\u061cc\u180ed\u2060e\u2064f\ufff9g\ufffbh')).toBe('Reply ready: abcdefgh (Claude)')
    expect(body('ta\u{e0041}\u{e007f}g')).toBe('Reply ready: tag (Claude)')
    expect(body('\u{e0041}\u{e0042}\u{e007f}')).toBe('Reply ready: session ab12cd34 (Claude)')
  })
})

describe('the engine marks a banner whose items are all Reply ready', () => {
  const TZ = 'America/Chicago', WORK = taskInstant('2026-11-17', 10 * 60, TZ)
  const run = (items: ReturnType<typeof agentCandidate>[]) => {
    let state: PingState = { ledger: [], held: [], consumed: [] }
    let n = 0
    const keys = new Set<string>()
    const feed: PingFeedSink = { hasKey: k => keys.has(k), post: c => { keys.add(c.key); return `f${++n}` } }
    const out: PingBanner[] = []
    new PingEngine({ state: { read: () => structuredClone(state), write: s => { state = structuredClone(s) } }, feed, read: async () => ({}),
      banner: b => { out.push(b) }, now: () => WORK, timezone: () => TZ, enabled: () => ['agent'] }).push(items.map(i => i!))
    return out
  }
  it('Reply ready items: replies true; a finished or stopped item in it: not marked', () => {
    expect(run([agentCandidate({ provider: 'claude', sessionId: A, turnEndedAt: WORK, replyReady: true })])[0].replies).toBe(true)
    expect(run([agentCandidate({ provider: 'claude', sessionId: A, turnEndedAt: WORK, label: 'Build' })])[0].replies).toBeUndefined()
    expect(run([agentCandidate({ provider: 'claude', sessionId: A, turnEndedAt: WORK, label: 'Build', failed: true })])[0].replies).toBeUndefined()
    // a finished session whose own label is "Reply ready" carries that title, but not the fixed sentence: not marked
    expect(run([agentCandidate({ provider: 'claude', sessionId: A, turnEndedAt: WORK, label: 'Reply ready' })])[0].replies).toBeUndefined()
    expect(run([agentCandidate({ provider: 'claude', sessionId: A, turnEndedAt: WORK, replyReady: true }),
      agentCandidate({ provider: 'codex', sessionId: B, turnEndedAt: WORK, label: 'Build' })])[0].replies).toBeUndefined()
  })
})
