import { describe, expect, it } from 'vitest'
import { CUE_DETAIL_MAX, CUE_HEADLINE_MAX, type LiveCueV2 } from '../../shared/live-cues-v2.js'
import {
  OPEN_ITEMS_EVERY_MS, OPEN_ITEMS_MAX, OPEN_ITEM_MAX_CHARS, OPEN_ITEM_STALE_MS, OpenItemFold, cleanOpenItem, isOwnerDateGap, openItemOf, openItemsDetail, openItemsHeadline,
} from './live-cues-v2-open-items.js'

const MIN = 60_000

// Every cue below is synthesized in the shape of the 11/02 template cues; none is a real one.
const GAP_CUES: Array<[string, 'challenge' | 'reinforce' | 'followUp' | 'promise']> = [
  ["Sam said they'll dig into the churn drop-off and fold it into the retention analysis. No date was given, so settle when that analysis lands.", 'promise'],
  ['Main slides get built over the next week, but nobody has taken the draft deadline or who owns the pricing section. Settle a date before the call ends.', 'challenge'],
  ['Open: how many trials converted at the second tier. The room said it will look, but no owner or date was named.', 'followUp'],
  ['The vendor decision is pending after the budget call. Settle who chases that answer this week and by when, since no owner or date was named.', 'challenge'],
  ["Nobody has taken ownership of the exclusion list yet, so name an owner before it goes to the contractor.", 'reinforce'],
  ['The dashboard review is only planned for later this week with no date or attendee list. Pin a day and invite the analyst.', 'challenge'],
  ['Someone took on putting the offsite on the manager agenda. No date was set for that talk.', 'promise'],
]
const NOT_GAP_CUES: Array<[string, 'challenge' | 'reinforce' | 'followUp' | 'promise']> = [
  // an owner mentioned, not missing
  ['Ad locations are strong and owner changes are rising, so growth may be existing owners moving, not net new owners. Split them.', 'challenge'],
  // someone else's deadline, no ask
  ['Ask the advisor for written proof of the filing. The record lacks it, and you need it before the November payment deadline.', 'challenge'],
  // the shape of a cue the owner rated Useful on 11/02: the gap is named, but the cue proposes a concrete check
  ["Narrow rules sound good, but the room hasn't said who tests them. Pick a check, like running the liquor bucket against its spelling variations.", 'challenge'],
  // an ask with no absence
  ['Name an owner for the redirect and set a date. The client asked twice.', 'challenge'],
  // an absence of something else
  ['Categories stay static until new keywords appear, but no bar is set. Settle a threshold on volume.', 'challenge'],
  ['The plan has support and the numbers hold. Ship the pilot on Monday as agreed.', 'reinforce'],
]

describe('open items: what counts (6.97.8)', () => {
  it('the wording rule matches an explicit missing owner or date with an ask to settle it, in the shape of the 11/02 template cues', () => {
    for (const [text, kind] of GAP_CUES) expect(isOwnerDateGap(text, kind), text).toBe(true)
  })

  it('and not a mention of owners, someone else\'s deadline, a bare ask, another missing thing, or a cue that proposes a concrete check', () => {
    for (const [text, kind] of NOT_GAP_CUES) expect(isOwnerDateGap(text, kind), text).toBe(false)
  })

  it('the followUp and promise kinds need only the absence; the other kinds also need the ask', () => {
    const absenceOnly = 'The room will revisit pricing next quarter. No date was set.'
    expect(isOwnerDateGap(absenceOnly, 'followUp')).toBe(true)
    expect(isOwnerDateGap(absenceOnly, 'promise')).toBe(true)
    expect(isOwnerDateGap(absenceOnly, 'challenge')).toBe(false)
    expect(isOwnerDateGap(absenceOnly, 'reinforce')).toBe(false)
  })

  it('a decision is never an open item, even with a gap in its text and a field from the writer', () => {
    const text = 'Decided: Sam joins the pool. No target or date for holding them accountable was given yet. Settle when.'
    expect(openItemOf({ kind: 'decision', detail: text, cited: 0, field: 'Accountability date' })).toBeNull()
  })

  it('a cue that cites a past meeting or note is never an open item: its cross-meeting contrast is the value', () => {
    const [text] = GAP_CUES[1]
    expect(openItemOf({ kind: 'challenge', detail: text, cited: 0, field: 'Draft deadline' })).not.toBeNull()
    expect(openItemOf({ kind: 'challenge', detail: text, cited: 1, field: 'Draft deadline' })).toBeNull()
  })

  it('QA fix: an item needs the writer\'s own `open`; wording alone never folds a cue (the legacy prompt returns none)', () => {
    for (const [text, kind] of GAP_CUES) {
      expect(openItemOf({ kind, detail: text, cited: 0 }), text).toBeNull()
      expect(openItemOf({ kind, detail: text, cited: 0, field: '  ' }), text).toBeNull()
      expect(openItemOf({ kind, detail: text, cited: 0, field: 42 }), text).toBeNull()
    }
  })

  it('QA fix: a field on a cue whose wording is not an owner or date gap does not fold it (a risk or a figure is never reduced to a label)', () => {
    const risky = 'Pricing ships Monday but the customer email has no draft; churn risk for 400 accounts. Review the email today.'
    expect(openItemOf({ kind: 'challenge', detail: risky, cited: 0, field: 'Customer email' })).toBeNull()
    for (const [text, kind] of NOT_GAP_CUES) expect(openItemOf({ kind, detail: text, cited: 0, field: 'Some item' }), text).toBeNull()
    const [gap, gapKind] = GAP_CUES[0]
    expect(openItemOf({ kind: gapKind, detail: gap, cited: 0, field: ' Churn analysis date. ' })).toEqual({ label: 'Churn analysis date' })
  })

  it('an item is short, in plain words and never over the limit', () => {
    expect(cleanOpenItem('Thanksgiving week — agenda')).toBe('Thanksgiving week - agenda')
    expect(cleanOpenItem('x'.repeat(200))!.length).toBeLessThanOrEqual(OPEN_ITEM_MAX_CHARS)
    expect(cleanOpenItem('word '.repeat(40))!.endsWith('…')).toBe(true)
    expect(cleanOpenItem('')).toBeNull()
  })

  it('the combined cue fits a cue: three longest items under the detail limit, the headline (first item plus the count) under the headline limit, no dash or arrow', () => {
    const longest = 'x'.repeat(OPEN_ITEM_MAX_CHARS)
    const detail = openItemsDetail([longest, longest, longest])
    expect(detail.length).toBeLessThanOrEqual(CUE_DETAIL_MAX)
    expect(openItemsHeadline([longest, longest, longest]).length).toBeLessThanOrEqual(CUE_HEADLINE_MAX)
    expect(openItemsHeadline([longest]).length).toBeLessThanOrEqual(CUE_HEADLINE_MAX)
    expect(detail).not.toMatch(/[—–→]/)
    expect(openItemsHeadline(['Offsite agenda'])).toBe('Offsite agenda')
    expect(openItemsHeadline(['Offsite agenda', 'Draft deadline', 'Vendor answer'])).toBe('Offsite agenda +2')
    expect(openItemsDetail(['Offsite agenda', 'Draft deadline'])).toBe('Still open, no owner or date: Offsite agenda; Draft deadline.')
  })
})

const cueOf = (id: string, at = 0): LiveCueV2 => ({ protocol: 2, cueId: id, sessionId: 'm', headline: id, detail: `Detail of ${id}`, kind: 'challenge', sources: [], gate: 0.9, createdAt: at, model: 'm' })

describe('open items: the fold (6.97.8, QA fix: nothing is lost)', () => {
  it('a combined cue needs two waiting, shows the newest three, and keeps the older ones waiting', () => {
    const f = new OpenItemFold()
    f.hold('Offsite agenda', cueOf('a'), 0)
    expect(f.next(MIN)).toBeNull()
    for (const [i, label] of ['Pricing deck draft', 'Vendor budget answer', 'Dashboard review'].entries()) f.hold(label, cueOf(`b${i}`), (i + 1) * MIN)
    const plan = f.next(4 * MIN)!
    expect(plan.mode).toBe('digest')
    expect(plan.items.map(i => i.label)).toEqual(['Pricing deck draft', 'Vendor budget answer', 'Dashboard review'])
    expect(OPEN_ITEMS_MAX).toBe(3)
    f.markShown(plan, 4 * MIN)
    expect(f.waiting()).toBe(1)                                                     // the oldest is still waiting, not dropped
    expect(f.next(5 * MIN)).toBeNull()                                              // alone for 20 minutes
  })

  it('a second combined cue waits 10 minutes after the first', () => {
    const f = new OpenItemFold()
    f.hold('Offsite agenda', cueOf('a'), 0); f.hold('Draft deadline pricing', cueOf('b'), MIN)
    f.markShown(f.next(2 * MIN)!, 2 * MIN)
    f.hold('Vendor budget answer', cueOf('c'), 3 * MIN); f.hold('Dashboard review date', cueOf('d'), 4 * MIN)
    expect(f.next(5 * MIN)).toBeNull()
    expect(f.next(2 * MIN + OPEN_ITEMS_EVERY_MS - 1)).toBeNull()
    expect(f.next(2 * MIN + OPEN_ITEMS_EVERY_MS)!.items.map(i => i.label)).toEqual(['Vendor budget answer', 'Dashboard review date'])
  })

  it('a lone item nothing joined for 20 minutes is shown on its own, as the cue the writer wrote', () => {
    const f = new OpenItemFold()
    f.hold('Offsite agenda', cueOf('lone'), 0)
    expect(f.next(OPEN_ITEM_STALE_MS - 1)).toBeNull()
    const plan = f.next(OPEN_ITEM_STALE_MS)!
    expect(plan.mode).toBe('alone')
    expect(plan.items[0].cue.cueId).toBe('lone')
    f.markShown(plan, OPEN_ITEM_STALE_MS)
    expect(f.waiting()).toBe(0)
    expect(f.next(OPEN_ITEM_STALE_MS + 1)).toBeNull()
  })

  it('W2: a stale item the room talked about again since it was held is dropped, not shown alone; one it did not is shown', () => {
    const f = new OpenItemFold()
    f.hold('Warehouse audit booking', cueOf('a'), 0)
    f.noteSaid('We moved on to pricing and the vendor list')
    expect(f.next(OPEN_ITEM_STALE_MS)).toMatchObject({ mode: 'alone' })
    f.noteSaid('so the warehouse audit is booked for Tuesday')                         // warehouse, audit and booking-ish words
    const plan = f.next(OPEN_ITEM_STALE_MS)!
    expect(plan.mode).toBe('drop')
    f.markShown(plan, OPEN_ITEM_STALE_MS)
    expect(f.waiting()).toBe(0)
    expect(f.hold('Warehouse audit booking', cueOf('b'), OPEN_ITEM_STALE_MS + 1)).toBe(true)   // a dropped item was never shown, so it can be raised again
  })

  it('W2: one word of a longer label coming up again is not enough; most of the label is', () => {
    const f = new OpenItemFold()
    f.hold('Warehouse audit booking schedule', cueOf('a'), 0)                          // four scored words: 0.6 of 4 rounds up to 3
    f.noteSaid('the warehouse came up'); f.noteSaid('an audit')
    expect(f.next(OPEN_ITEM_STALE_MS)).toMatchObject({ mode: 'alone' })
    f.noteSaid('and the booking')
    expect(f.next(OPEN_ITEM_STALE_MS)).toMatchObject({ mode: 'drop' })
  })

  it('W2: only what was said after the item was held counts, and a label with no scored words is never dropped', () => {
    const f = new OpenItemFold()
    f.noteSaid('warehouse audit booking')                                              // before it was held: nothing waits, nothing is remembered
    f.hold('Warehouse audit booking', cueOf('a'), 0)
    expect(f.next(OPEN_ITEM_STALE_MS)).toMatchObject({ mode: 'alone' })
    const g = new OpenItemFold()
    g.hold('Owner and date', cueOf('b'), 0)                                            // every word is on the stop list
    g.noteSaid('owner and date, owner and date')
    expect(g.next(OPEN_ITEM_STALE_MS)).toMatchObject({ mode: 'alone' })
  })

  it('showing an item alone does not use up the 10 minutes between combined cues', () => {
    const f = new OpenItemFold()
    f.hold('Offsite agenda', cueOf('a'), 0)
    f.markShown(f.next(OPEN_ITEM_STALE_MS)!, OPEN_ITEM_STALE_MS)
    f.hold('Draft deadline pricing', cueOf('b'), OPEN_ITEM_STALE_MS + MIN); f.hold('Vendor budget answer', cueOf('c'), OPEN_ITEM_STALE_MS + MIN)
    expect(f.next(OPEN_ITEM_STALE_MS + 2 * MIN)).toMatchObject({ mode: 'digest' })
  })

  it('a stale item is shown alone even inside the 10 minutes after a combined cue (it is the original cue, not another combined one)', () => {
    const f = new OpenItemFold()
    f.hold('Offsite agenda', cueOf('a'), 0); f.hold('Draft deadline pricing', cueOf('b'), MIN)
    f.markShown(f.next(2 * MIN)!, 2 * MIN)
    f.hold('Vendor budget answer', cueOf('c'), 3 * MIN)
    expect(f.next(3 * MIN + OPEN_ITEM_STALE_MS - 1)).toBeNull()
    expect(f.next(3 * MIN + OPEN_ITEM_STALE_MS)).toMatchObject({ mode: 'alone' })
  })

  it('the same item is held once, an item already shown is not held again, and every held cue stays in the history', () => {
    const f = new OpenItemFold()
    expect(f.hold('Offsite agenda owner', cueOf('a'), 0)).toBe(true)
    expect(f.hold('Offsite agenda owner needed', cueOf('b'), MIN)).toBe(false)
    expect(f.hold('Draft deadline pricing', cueOf('c'), MIN)).toBe(true)
    f.markShown(f.next(2 * MIN)!, 2 * MIN)
    expect(f.hold('Offsite agenda owner', cueOf('d'), 20 * MIN)).toBe(false)
    expect(f.hold('Vendor budget answer', cueOf('e'), 20 * MIN)).toBe(true)
    expect(f.history().map(c => c.cueId)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})
