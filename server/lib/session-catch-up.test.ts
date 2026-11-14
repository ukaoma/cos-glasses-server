// X1 (session catch-up): the pure parts. The fixed sentence set, the composition rule, the cursor and the limiter.
import { describe, expect, it } from 'vitest'
import {
  CATCH_UP_PER_MINUTE, CATCH_UP_REPLAY_MS, CatchUpLimiter, SUMMARY_TEXT, answeredSurface, bindingReason, bindingStateFor,
  catchUpSummary, isCursor, turnCursor, turnsSince, type SummaryFacts,
} from './session-catch-up.js'

const base: SummaryFacts = {
  gap: false, newTurns: 0, ended: false, answeredBy: null, questionClosed: false, waitingQuestion: false,
  reattach: 'already', holder: 'this', restarted: false, working: false, queued: 0,
}

describe('the fixed sentence set (lead 15:59, condition 4)', () => {
  it('18 clauses, each sentence case, a full stop, no em dash, no arrow, no session text slot but a count', () => {
    const entries = Object.entries(SUMMARY_TEXT)
    expect(entries).toHaveLength(18)
    for (const [code, text] of entries) {
      expect(text, code).toMatch(/^[A-Z0-9{]/)
      expect(text.endsWith('.'), code).toBe(true)
      expect(text, code).not.toMatch(/[—–→⇒]|->|=>/)
      expect(text.replace('{n}', ''), code).not.toMatch(/[{}]/)
    }
  })

  it('one transcript clause first, then at most two more in the priority order, never over 160 characters', () => {
    const all = catchUpSummary({ ...base, newTurns: 3, ended: true, answeredBy: 'mac', waitingQuestion: true, reattach: 'no', restarted: true, working: true, queued: 5 })
    expect(all.codes).toEqual(['new_n', 'ended', 'answered_mac'])
    expect(all.summary).toBe('3 new messages. This session has ended. The question you saw was answered at your Mac.')
    expect(all.summary.length).toBeLessThanOrEqual(160)
    const live = catchUpSummary({ ...base, newTurns: 1, waitingQuestion: true, reattach: 'safe', holder: 'none', working: true })
    expect(live.codes).toEqual(['new_one', 'waiting_question', 'binding_relink'])
    expect(catchUpSummary({ ...base, gap: true }).codes).toEqual(['new_window'])
    expect(catchUpSummary(base).summary).toBe('No new messages.')
    expect(catchUpSummary({ ...base, queued: 2 }).summary).toBe('No new messages. 2 messages are waiting to send.')
    expect(catchUpSummary({ ...base, queued: 1 }).codes).toEqual(['new_none', 'queued_one'])
  })

  it('the link clause follows the verdict and the holder; an ended session gets no link, question or working clause', () => {
    expect(catchUpSummary({ ...base, reattach: 'not_now', holder: 'other' }).codes).toContain('binding_other')
    expect(catchUpSummary({ ...base, reattach: 'not_now', holder: 'none' }).codes).toContain('binding_busy')
    expect(catchUpSummary({ ...base, reattach: 'no', holder: 'none' }).codes).toContain('binding_no')
    expect(catchUpSummary({ ...base, reattach: 'already' }).codes).toEqual(['new_none'])
    const ended = catchUpSummary({ ...base, ended: true, reattach: 'safe', waitingQuestion: true, working: true })
    expect(ended.codes).toEqual(['new_none', 'ended'])
  })

  it('answered surfaces: mac and mac_app are the Mac, glasses the glasses, web and cos another screen; a closed question with no answer says so', () => {
    expect(answeredSurface('mac')).toBe('mac')
    expect(answeredSurface('mac_app')).toBe('mac')
    expect(answeredSurface('glasses')).toBe('glasses')
    expect(answeredSurface('web')).toBe('web')
    expect(answeredSurface('cos')).toBe('web')
    expect(answeredSurface('other')).toBeNull()
    expect(catchUpSummary({ ...base, answeredBy: 'glasses' }).codes).toContain('answered_glasses')
    expect(catchUpSummary({ ...base, answeredBy: 'web' }).codes).toContain('answered_web')
    expect(catchUpSummary({ ...base, questionClosed: true }).codes).toContain('question_closed')
  })
})

describe('the cursor', () => {
  const t = (i: number, at?: string) => ({ role: i % 2 ? 'assistant' : 'user', text: `t${i}`, ...(at ? { at } : {}) })
  it('names one turn by its time and words; a Cursor turn (no time) still gets one; the format is checked', () => {
    const c = turnCursor(t(1, '2026-11-14T12:00:00.000Z'))
    expect(isCursor(c)).toBe(true)
    expect(isCursor(turnCursor(t(1)))).toBe(true)
    expect(turnCursor(t(1, '2026-11-14T12:00:00.000Z'))).toBe(c)
    expect(turnCursor(t(2, '2026-11-14T12:00:00.000Z'))).not.toBe(c)
    for (const bad of ['', 'c2.x.AAAAAAAAAAAAAAAA', 'c1.x.short', 'c1.a b.AAAAAAAAAAAAAAAA', 'c1.' + 'a'.repeat(70) + '.AAAAAAAAAAAAAAAA', 7]) expect(isCursor(bad)).toBe(false)
  })
  it('turnsSince: the turns after the cursor; none or an unknown cursor gives the window with gap; the newest match counts', () => {
    const w = [t(1, 'a'), t(2, 'b'), t(3, 'c')]
    expect(turnsSince(w, null)).toMatchObject({ gap: true, turns: w, cursor: turnCursor(w[2]!) })
    expect(turnsSince(w, turnCursor(w[0]!))).toMatchObject({ gap: false, turns: [w[1], w[2]] })
    expect(turnsSince(w, turnCursor(w[2]!))).toMatchObject({ gap: false, turns: [] })
    expect(turnsSince(w, 'c1..AAAAAAAAAAAAAAAA')).toMatchObject({ gap: true, turns: w })
    expect(turnsSince([], null)).toEqual({ turns: [], gap: true, cursor: null })
  })
})

describe('binding reasons', () => {
  it('store_unavailable reads as the registry\'s words; a malformed reason never reaches the wire; states from reasons', () => {
    expect(bindingReason('store_unavailable')).toBe('binding_registry_unavailable')
    expect(bindingReason('binding_detached')).toBe('binding_detached')
    expect(bindingReason('Bad Reason!')).toBe('unknown_binding')
    expect(bindingReason(null)).toBe('unknown_binding')
    expect(bindingStateFor('binding_detached')).toBe('detached')
    expect(bindingStateFor('binding_expired')).toBe('expired')
    expect(bindingStateFor('stale_epoch')).toBe('unknown')
  })
})

describe('the limiter (memory only)', () => {
  it('replays the same request under 3 s, counts per client across sessions, refuses the 21st in a minute with a wait', () => {
    const l = new CatchUpLimiter()
    expect(l.check('c', 'k', 0)).toBeNull()
    l.record('c', 'k', 0, { a: 1 })
    expect(l.check('c', 'k', CATCH_UP_REPLAY_MS - 1)).toEqual({ kind: 'replay', body: { a: 1 } })
    expect(l.check('c', 'k', CATCH_UP_REPLAY_MS)).toBeNull()
    for (let i = 1; i < CATCH_UP_PER_MINUTE; i++) l.record('c', `k${i}`, i, {})
    const refused = l.check('c', 'new', 100)
    expect(refused).toMatchObject({ kind: 'refused' })
    expect((refused as { retryAfterS: number }).retryAfterS).toBeGreaterThan(0)
    expect(l.check('other-client', 'new', 100)).toBeNull()
    expect(l.check('c', 'new', 60_001)).toBeNull()
  })
  it('stays bounded: old entries go when the key count passes its cap', () => {
    const l = new CatchUpLimiter(4)
    for (let i = 0; i < 20; i++) l.record(`c${i}`, 'k', i * 70_000, {})
    expect(l.check('c0', 'k', 20 * 70_000)).toBeNull()
  })
})
