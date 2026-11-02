import { describe, expect, it } from 'vitest'
import { CUE_DETAIL_MAX, CUE_HEADLINE_MAX } from '../../shared/live-cues-v2.js'
import {
  OPEN_ITEMS_EVERY_MS, OPEN_ITEMS_MAX, OPEN_ITEM_MAX_CHARS, OPEN_ITEM_STALE_MS, OpenItemFold, cleanOpenItem, isOwnerDateGap, openItemFromText, openItemOf, openItemsDetail, openItemsHeadline,
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

  it('a decision is never an open item, even with a gap in its text or a field from the writer', () => {
    const text = 'Decided: Sam joins the pool. No target or date for holding them accountable was given yet. Settle when.'
    expect(openItemOf({ kind: 'decision', detail: text, cited: 0 })).toBeNull()
    expect(openItemOf({ kind: 'decision', detail: text, cited: 0, field: 'Accountability date' })).toBeNull()
  })

  it('a cue that cites a past meeting or note is never an open item: its cross-meeting contrast is the value', () => {
    const [text] = GAP_CUES[1]
    expect(openItemOf({ kind: 'challenge', detail: text, cited: 0 })).not.toBeNull()
    expect(openItemOf({ kind: 'challenge', detail: text, cited: 1, field: 'Draft deadline' })).toBeNull()
  })

  it("the writer's own item wins and needs no matching wording; an empty or useless field falls back to the wording", () => {
    expect(openItemOf({ kind: 'challenge', detail: 'The offsite agenda is still loose.', cited: 0, field: ' Offsite agenda. ' })).toEqual({ label: 'Offsite agenda', source: 'field' })
    expect(openItemOf({ kind: 'challenge', detail: 'The offsite agenda is still loose.', cited: 0, field: '  ' })).toBeNull()
    expect(openItemOf({ kind: 'challenge', detail: 'The offsite agenda is still loose.', cited: 0, field: 42 })).toBeNull()
    const [text] = GAP_CUES[3]
    expect(openItemOf({ kind: 'challenge', detail: text, cited: 0, field: '??' })).toMatchObject({ source: 'text' })
  })

  it('an item is short, in plain words and never over the limit; a label from the wording is the first sentence', () => {
    expect(cleanOpenItem('Thanksgiving week — agenda')).toBe('Thanksgiving week - agenda')
    expect(cleanOpenItem('x'.repeat(200))!.length).toBeLessThanOrEqual(OPEN_ITEM_MAX_CHARS)
    expect(cleanOpenItem('word '.repeat(40))!.endsWith('…')).toBe(true)
    expect(cleanOpenItem('')).toBeNull()
    expect(openItemFromText('Open: how many trials converted at the second tier. No owner or date was named.')).toBe('How many trials converted at the second tier')
    expect(openItemFromText(GAP_CUES[1][0]).length).toBeLessThanOrEqual(OPEN_ITEM_MAX_CHARS)
  })

  it('the combined cue fits a cue: three longest items under the detail limit, a headline under the headline limit, no dash or arrow', () => {
    const longest = 'x'.repeat(OPEN_ITEM_MAX_CHARS)
    const detail = openItemsDetail([longest, longest, longest])
    expect(detail.length).toBeLessThanOrEqual(CUE_DETAIL_MAX)
    for (const n of [1, 2, 3]) {
      expect(openItemsHeadline(n).length).toBeLessThanOrEqual(CUE_HEADLINE_MAX)
      expect(openItemsHeadline(n)).not.toMatch(/[—–→]/)
    }
    expect(detail).not.toMatch(/[—–→]/)
    expect(openItemsHeadline(1)).toBe('Open item: needs an owner or date')
    expect(openItemsHeadline(3)).toBe('Open items: 3 need an owner or date')
    expect(openItemsDetail(['Offsite agenda', 'Draft deadline'])).toBe('Still open, no owner or date: Offsite agenda; Draft deadline.')
  })
})

describe('open items: the fold (6.97.8)', () => {
  it('needs two waiting items, and shows the newest three', () => {
    const f = new OpenItemFold()
    f.hold('Offsite agenda', 0)
    expect(f.due(MIN)).toBeNull()
    f.hold('Draft deadline for pricing', MIN)
    f.hold('Vendor budget answer', 2 * MIN)
    f.hold('Dashboard review date', 3 * MIN)
    expect(f.due(4 * MIN)).toEqual(['Draft deadline for pricing', 'Vendor budget answer', 'Dashboard review date'])
    expect(OPEN_ITEMS_MAX).toBe(3)
  })

  it('shows nothing for 10 minutes after a combined cue, then the next two or more', () => {
    const f = new OpenItemFold()
    f.hold('Offsite agenda', 0); f.hold('Draft deadline pricing', MIN)
    const items = f.due(2 * MIN)!
    f.markShown(items, 2 * MIN)
    f.hold('Vendor budget answer', 3 * MIN); f.hold('Dashboard review date', 4 * MIN)
    expect(f.due(5 * MIN)).toBeNull()
    expect(f.due(2 * MIN + OPEN_ITEMS_EVERY_MS - 1)).toBeNull()
    expect(f.due(2 * MIN + OPEN_ITEMS_EVERY_MS)).toEqual(['Vendor budget answer', 'Dashboard review date'])
  })

  it('the same item is held once, and an item already shown is not held again', () => {
    const f = new OpenItemFold()
    expect(f.hold('Offsite agenda owner', 0)).toBe(true)
    expect(f.hold('Offsite agenda owner needed', MIN)).toBe(false)             // the same item in other words
    expect(f.hold('Draft deadline pricing', MIN)).toBe(true)
    f.markShown(f.due(2 * MIN)!, 2 * MIN)
    expect(f.hold('Offsite agenda owner', 20 * MIN)).toBe(false)               // said already
    expect(f.hold('Vendor budget answer', 20 * MIN)).toBe(true)
  })

  it('an item that waited too long is dropped, not shown late', () => {
    const f = new OpenItemFold()
    f.hold('Offsite agenda', 0)
    f.hold('Draft deadline pricing', 5 * MIN)
    expect(f.due(OPEN_ITEM_STALE_MS + 1)).toBeNull()                           // the first expired, one left
    expect(f.waiting(OPEN_ITEM_STALE_MS + 1)).toBe(1)
    expect(f.waiting(5 * MIN + OPEN_ITEM_STALE_MS + 1)).toBe(0)
  })

  it('a combined cue clears what waited: older items past the newest three are dropped, not carried', () => {
    const f = new OpenItemFold()
    for (const [i, label] of ['Alpha topic', 'Bravo topic', 'Charlie topic', 'Delta topic', 'Echo topic'].entries()) f.hold(label, i * 1000)
    const items = f.due(10_000)!
    expect(items).toEqual(['Charlie topic', 'Delta topic', 'Echo topic'])
    f.markShown(items, 10_000)
    expect(f.waiting(10_001)).toBe(0)
  })
})
