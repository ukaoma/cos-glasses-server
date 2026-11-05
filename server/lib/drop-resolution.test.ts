import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { InboxFeedStore, type DropLink, type DropRecord } from './drop-store.js'
import { cardState, cardWriteResolutions, sameHeldSession, sessionTurnOutcome, followedDrops, pollResolutions, quoteOf, resolutionCandidate, resolutionKey, sessionTurnResolutions, RESOLUTION_REPORT_CHARS, type CardSnapshot, type HandoffSnapshot } from './drop-resolution.js'
import { PingEngine, PingStateStore, type PingBanner } from './ping-engine.js'
import { feedSink, toFeedItem } from './ping-feed-sink.js'
import { isWaiting } from './drop-service.js'
import { taskInstant } from './morning-brief-schedule.js'

const TZ = 'America/Chicago'
const local = (day: string, hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return taskInstant(day, h * 60 + m, TZ) }
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cos-resolution-')); dirs.push(d); return d }

const CARD: DropLink = { kind: 'card', id: 'wid-jck-1', label: 'JCK numbers for Gina', domain: 'quilt' }
function cardDrop(overrides: Partial<DropRecord> = {}): DropRecord {
  const at = new Date(local('2026-11-04', '09:00')).toISOString()
  return { id: randomUUID(), text: 'send Gina the JCK numbers', source: 'mac', createdAt: at, updatedAt: at, state: 'filed', dest: 'new_card', kind: 'task',
    links: [CARD], route: { by: 'jev' }, undoUntil: null, timeline: [], ...overrides }
}
const board = (row: CardSnapshot | undefined) => new Map(row ? [[`quilt:${CARD.id}`, row]] : [])

describe('resolution rules', () => {
  it('reads card states: QA and Complete post; other moves do not; absent from a read board is archived', () => {
    expect(cardState({ workStage: 'qa' })).toBe('qa')
    expect(cardState({ workStage: 'complete' })).toBe('complete')
    expect(cardState({ checked: true, workStage: 'draft' })).toBe('complete')
    for (const s of ['mentioned', 'planned', 'draft', 'built']) expect(cardState({ workStage: s })).toBeNull()
    expect(cardState(null)).toBe('archived')
    expect(cardState(undefined)).toBeNull()
  })

  it('an unread board infers nothing, a read board without the card says archived', () => {
    const d = cardDrop(), now = local('2026-11-04', '12:00')
    expect(pollResolutions([d], {}, now)).toEqual([])
    expect(pollResolutions([d], { cards: new Map() }, now).map(c => c.key)).toEqual([resolutionKey(d.id, CARD, 'archived')])
  })

  it('a handoff posts completed with its report clipped to 240, failed and refused; running does not', () => {
    const d = cardDrop(), now = local('2026-11-04', '12:00')
    const receipts: HandoffSnapshot[] = [
      { id: 'h-run', status: 'running' }, { id: 'h-ok', status: 'completed', result: 'x'.repeat(500) }, { id: 'h-bad', status: 'failed' }, { id: 'h-no', status: 'refused', result: 'Out of scope.' },
    ]
    const out = pollResolutions([d], { cards: board({ workStage: 'draft' }), handoffs: new Map([[`quilt:${CARD.id}`, receipts]]) }, now)
    expect(out.map(c => c.key)).toEqual([`${d.id}:handoff:h-ok:completed`, `${d.id}:handoff:h-bad:failed`, `${d.id}:handoff:h-no:refused`])
    expect(out[0].line.length).toBeLessThanOrEqual('Done: JCK numbers for Gina. '.length + RESOLUTION_REPORT_CHARS)
    expect(out[0].actions.map(a => a.id)).toEqual(['open_result', 'open_card'])
    expect(out.map(c => c.needsReply ?? false)).toEqual([false, true, true])
  })

  it('follows filed drops inside 90 days only, never undone ones', () => {
    const now = local('2026-11-04', '12:00')
    const old = cardDrop({ createdAt: new Date(now - 91 * 86_400_000).toISOString() })
    const undone = cardDrop({ state: 'undone' })
    const live = cardDrop()
    expect(followedDrops([old, undone, live], now).map(d => d.id)).toEqual([live.id])
  })

  it('words: one outcome line, quoting the drop, threaded under it', () => {
    const d = cardDrop()
    const c = resolutionCandidate(d, CARD, 'complete', 0)
    expect(c).toMatchObject({ source: 'resolution', title: 'Re: send Gina the JCK numbers', line: 'Done: JCK numbers for Gina moved to Complete.', threadId: d.id })
    expect(quoteOf({ text: 'y'.repeat(200) }).length).toBeLessThanOrEqual(84)
    expect(toFeedItem(c, 0)).toMatchObject({ kind: 'followup', threadId: d.id, source: 'cos', readAt: null, state: 'live', key: c.key })
    expect(toFeedItem(c, 0)).not.toHaveProperty('needsReply')
    const qa = resolutionCandidate(d, CARD, 'qa', 0)
    const item = toFeedItem(qa, 0)
    expect(item.needsReply).toBe(true)
    expect(isWaiting(item)).toBe(true)
    expect(isWaiting({ ...item, state: 'done' })).toBe(false)
    expect(isWaiting(toFeedItem(c, 0))).toBe(false)
  })

  it('reads hook events as turn outcomes and matches held session ids', () => {
    expect(sessionTurnOutcome('Stop', false)).toBe('replied')
    expect(sessionTurnOutcome('StopFailure', false)).toBe('failed')
    expect(sessionTurnOutcome('Interrupt', false)).toBe('failed')
    expect(sessionTurnOutcome('Stop', true)).toBeNull()  // a subagent's Stop is not the session's reply
    for (const e of ['UserPromptSubmit', 'PreToolUse', 'SessionStart', 'SubagentStop']) expect(sessionTurnOutcome(e, false)).toBeNull()
    expect(sameHeldSession('codex:ABC-123', 'abc-123')).toBe(true)
    expect(sameHeldSession('abc-123', 'abc-123')).toBe(true)
    expect(sameHeldSession('codex:abc-1234', 'abc-123')).toBe(false)
    expect(sameHeldSession('codex:xabc-123', 'abc-123')).toBe(false)
  })

  it('only a turn that ended after the send answers it', () => {
    const sentAt = local('2026-11-04', '12:00')
    const d = cardDrop({ dest: 'session', links: [{ kind: 'session', id: 'claude:abc', label: 'Deck' }], hold: { sessionId: 'claude:abc', label: 'Deck', sentAt: new Date(sentAt).toISOString() } })
    expect(sessionTurnResolutions([d], 'abc', 'replied', sentAt + 60_000, sentAt - 1)).toEqual([])
    expect(sessionTurnResolutions([d], 'abc', 'replied', sentAt + 60_000, sentAt + 30_000).map(c => c.line)).toEqual(['Deck replied.'])
  })

  it('a session follow-up posts replied or failed, only once it was sent', () => {
    const now = local('2026-11-04', '12:00')
    const sent = cardDrop({ dest: 'session', links: [{ kind: 'session', id: 'codex:abc', label: 'HubDB push' }], hold: { sessionId: 'codex:abc', label: 'HubDB push', sentAt: new Date(now - 60_000).toISOString() } })
    const notSent = cardDrop({ dest: 'session', links: [{ kind: 'session', id: 'codex:abc', label: 'HubDB push' }], hold: { sessionId: 'codex:abc', label: 'HubDB push' } })
    expect(sessionTurnResolutions([sent, notSent], 'codex:abc', 'replied', now).map(c => c.key)).toEqual([`${sent.id}:session:codex:abc:replied`])
    expect(sessionTurnResolutions([sent], 'codex:other', 'failed', now)).toEqual([])
  })
})

/**
 * Canary 7 (plan section 9): exactly once. Each change is driven by the server's own write event AND the 2-minute
 * poll, with a restart between them, plus a QA, Draft, QA bounce. Real feed and ping state stores on disk. Fails on
 * more or fewer than one follow-up per key.
 */
describe('canary 7: one follow-up per key, by event and poll, across a restart', () => {
  function open(dir: string, nowRef: { now: number }, banners: PingBanner[]) {
    const feed = new InboxFeedStore(join(dir, 'inbox'), () => new Date(nowRef.now))
    const state = new PingStateStore(join(dir, 'pings'))
    const engine = new PingEngine({ state, feed: feedSink(feed, () => nowRef.now), read: async () => ({}), banner: b => banners.push(b), now: () => nowRef.now, timezone: () => TZ })
    return { feed, state, engine, close: () => { feed.close(); state.close() } }
  }

  it('event then restart then poll, a QA bounce, and Complete: one follow-up per key', () => {
    const dir = tmp(), nowRef = { now: local('2026-11-04', '10:00') }, banners: PingBanner[] = []
    const drop = cardDrop()
    let s = open(dir, nowRef, banners)
    // 10:00 the server's own write moves the card to QA: the event posts.
    s.engine.push(cardWriteResolutions([drop], 'quilt', CARD.id, { workStage: 'qa' }, nowRef.now))
    s.close()
    // Restart. 10:02 the poll sees QA too.
    nowRef.now += 2 * 60_000
    s = open(dir, nowRef, banners)
    s.engine.push(pollResolutions([drop], { cards: board({ workStage: 'qa' }) }, nowRef.now))
    // 10:30 bounce to Draft (silent), 11:00 back to QA (already posted), by the poll and by an event.
    nowRef.now = local('2026-11-04', '10:30')
    s.engine.push(pollResolutions([drop], { cards: board({ workStage: 'draft' }) }, nowRef.now))
    nowRef.now = local('2026-11-04', '11:00')
    s.engine.push(cardWriteResolutions([drop], 'quilt', CARD.id, { workStage: 'qa' }, nowRef.now))
    s.engine.push(pollResolutions([drop], { cards: board({ workStage: 'qa' }) }, nowRef.now))
    s.close()
    // Restart. 14:00 Complete, by the poll first, then the event.
    nowRef.now = local('2026-11-04', '14:00')
    s = open(dir, nowRef, banners)
    s.engine.push(pollResolutions([drop], { cards: board({ workStage: 'complete', checked: true }) }, nowRef.now))
    s.engine.push(cardWriteResolutions([drop], 'quilt', CARD.id, { workStage: 'complete', checked: true }, nowRef.now))
    const followups = s.feed.list().filter(i => i.kind === 'followup')
    const perKey = new Map<string, number>()
    for (const f of followups) perKey.set(f.key, (perKey.get(f.key) ?? 0) + 1)
    expect([...perKey.entries()]).toEqual([[resolutionKey(drop.id, CARD, 'qa'), 1], [resolutionKey(drop.id, CARD, 'complete'), 1]])
    expect(followups.every(f => f.threadId === drop.id)).toBe(true)
    // One banner per follow-up (resolutions are on by default, in work hours, 45 minutes apart here).
    expect(banners.map(b => b.line)).toEqual(['JCK numbers for Gina is ready for your review.', 'Done: JCK numbers for Gina moved to Complete.'])
    s.close()
  })

  it('a restart between the event and its banner never banners twice', () => {
    const dir = tmp(), nowRef = { now: local('2026-11-04', '10:00') }, banners: PingBanner[] = []
    const drop = cardDrop()
    let s = open(dir, nowRef, banners)
    s.engine.push(cardWriteResolutions([drop], 'quilt', CARD.id, { workStage: 'complete' }, nowRef.now))
    s.close()
    s = open(dir, nowRef, banners)
    s.engine.push(pollResolutions([drop], { cards: board({ workStage: 'complete' }) }, nowRef.now + 60_000))
    expect(banners).toHaveLength(1)
    expect(s.feed.list().filter(i => i.kind === 'followup')).toHaveLength(1)
    s.close()
  })
})
