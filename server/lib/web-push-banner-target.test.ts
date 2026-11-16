// 7.0.52 A (Miles 16:08, lead 16:24): a phone notification for ONE session's reply opens that exact session's reader,
// #/sessions/<provider>/<id>, instead of the Sessions list. A merged one for several sessions opens the COS thread,
// #/messages/cos. Never a guessed provider: a session with no provider keeps today's target. The engine names the
// sessions a banner announces only when every item in it is a session ping, so a mixed banner keeps today's target.
import { describe, expect, it } from 'vitest'
import { bannerPayload } from './web-push-sender.js'
import { PingEngine, bannerSessions, type PingBanner, type PingFeedSink, type PingState } from './ping-engine.js'
import { agentCandidate, type PingCandidate } from './ping-sources.js'
import { taskInstant } from './morning-brief-schedule.js'

const ORIGIN = 'https://mac-x1.example-tailnet.ts.net:3143'
const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b'
const TZ = 'America/Chicago'
const WORK = taskInstant('2026-11-17', 10 * 60, TZ)   // a Tuesday, 10:00: not quiet, after the first banner

const navigate = (b: Partial<PingBanner>) => JSON.parse(bannerPayload({ feedIds: ['fi_1'], title: 'Reply ready', line: 'Claude has a reply ready.', sources: ['agent'], exempt: false, ...b }, ORIGIN).toString()).notification.navigate as string

describe('where the phone notification opens', () => {
  it('one session with its provider: that session\'s reader', () => {
    expect(navigate({ sessions: [{ id: A, provider: 'claude' }] })).toBe(`${ORIGIN}/control#/sessions/claude/${A}`)
    expect(navigate({ sessions: [{ id: B, provider: 'codex' }] })).toBe(`${ORIGIN}/control#/sessions/codex/${B}`)
    expect(navigate({ sessions: [{ id: A, provider: 'cursor' }] })).toBe(`${ORIGIN}/control#/sessions/cursor/${A}`)
  })
  it('two replies from the same session are still that one session', () => {
    expect(navigate({ feedIds: ['fi_1', 'fi_2'], sources: ['agent'], sessions: [{ id: A, provider: 'claude' }] })).toBe(`${ORIGIN}/control#/sessions/claude/${A}`)
  })
  it('an id with route characters is encoded, so it stays one part of the route', () => {
    const link = new URL(navigate({ sessions: [{ id: 'a/b?c#d', provider: 'claude' }] }))
    expect(link.hash).toBe('#/sessions/claude/a%2Fb%3Fc%23d')
  })
  it('one session with no provider (or one the reader does not serve): today\'s target, never a guess', () => {
    expect(navigate({ sessions: [{ id: A }] })).toBe(`${ORIGIN}/control#/sessions/t/sessions`)
    expect(navigate({ sessions: [{ id: A, provider: 'grok' as never }] })).toBe(`${ORIGIN}/control#/sessions/t/sessions`)
  })
  it('several sessions: the COS thread', () => {
    expect(navigate({ feedIds: ['fi_1', 'fi_2'], sessions: [{ id: A, provider: 'claude' }, { id: B, provider: 'codex' }] })).toBe(`${ORIGIN}/control#/messages/cos`)
    expect(navigate({ feedIds: ['fi_1', 'fi_2'], sessions: [{ id: A, provider: 'claude' }, { id: B }] })).toBe(`${ORIGIN}/control#/messages/cos`)
  })
  it('no sessions named, or a banner that is not all session pings: today\'s targets', () => {
    expect(navigate({})).toBe(`${ORIGIN}/control#/sessions/t/sessions`)
    expect(navigate({ sessions: [] })).toBe(`${ORIGIN}/control#/sessions/t/sessions`)
    expect(navigate({ sources: ['agent', 'reminder'], sessions: [{ id: A, provider: 'claude' }] })).toBe(`${ORIGIN}/control#/messages/cos/fi_1`)
  })
})

describe('the sessions a banner announces', () => {
  const reply = (sessionId: string, provider: string, at = WORK) => agentCandidate({ provider, sessionId, turnEndedAt: at, replyReady: true })!
  it('every item a session ping: one entry per session, its provider kept', () => {
    expect(bannerSessions([reply(A, 'claude')])).toEqual([{ id: A, provider: 'claude' }])
    expect(bannerSessions([reply(A, 'claude'), reply(A, 'claude', WORK + 1), reply(B, 'codex')])).toEqual([{ id: A, provider: 'claude' }, { id: B, provider: 'codex' }])
  })
  it('a provider outside the reader\'s three is left off; two providers for one session leave it off', () => {
    expect(bannerSessions([reply(A, 'grok')])).toEqual([{ id: A }])
    expect(bannerSessions([reply(A, 'claude'), reply(A, 'codex', WORK + 1)])).toEqual([{ id: A }])
  })
  it('any item that is not a session ping: no sessions named', () => {
    const other: PingCandidate = { source: 'reminder', key: 'reminder:x', line: 'x', links: [], actions: [], createdAt: WORK }
    expect(bannerSessions([reply(A, 'claude'), other])).toBeUndefined()
    expect(bannerSessions([{ ...reply(A, 'claude'), links: [] }])).toBeUndefined()
    expect(bannerSessions([])).toBeUndefined()
    // an item of another kind that links a session (a follow-up to a drop sent to one) is still not a session ping
    const followUp: PingCandidate = { source: 'resolution', key: 'res:x', line: 'Done.', links: [{ kind: 'session', id: B, label: 'x', provider: 'claude' }], actions: [], createdAt: WORK }
    expect(bannerSessions([followUp])).toBeUndefined()
    expect(bannerSessions([reply(A, 'claude'), followUp])).toBeUndefined()
  })
  it('the engine puts them on the banner it shows and sends to the phone', () => {
    let state: PingState = { ledger: [], held: [], consumed: [] }
    let n = 0
    const keys = new Set<string>()
    const feed: PingFeedSink = { hasKey: k => keys.has(k), post: c => { keys.add(c.key); return `f${++n}` } }
    const shown: PingBanner[] = [], phone: PingBanner[] = []
    const engine = new PingEngine({
      state: { read: () => structuredClone(state), write: s => { state = structuredClone(s) } }, feed, read: async () => ({}),
      banner: b => { shown.push(b) }, phoneBanner: b => { phone.push(b) }, now: () => WORK, timezone: () => TZ, enabled: () => ['agent'],
    })
    engine.push([reply(A, 'claude'), reply(B, 'codex')])
    expect(shown).toHaveLength(1)
    expect(shown[0].sessions).toEqual([{ id: A, provider: 'claude' }, { id: B, provider: 'codex' }])
    expect(phone[0].sessions).toEqual(shown[0].sessions)
  })
})
