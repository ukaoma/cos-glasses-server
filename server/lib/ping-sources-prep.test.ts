// 6.99.19: the prep card's "Prep me" action carries the event for a Prep draft. Additive; occurrence stays null
// because the calendar gives no event ids today.
import { describe, expect, it } from 'vitest'
import { prepCandidates } from './ping-sources.js'
import { toFeedItem } from './ping-feed-sink.js'
import { parseFeedItem } from './drop-store.js'

describe('prep card payload (6.99.19)', () => {
  it('adds prep {title, startsAt, occurrence: null} to the Prep me action and leaves the rest as it was', () => {
    const now = Date.parse('2026-11-06T21:50:00Z')
    const [c] = prepCandidates({ title: 'Pete 1:1', time: '2026-11-06T16:00:00-06:00' }, now, 'America/Chicago')
    expect(c.actions).toEqual([
      { id: 'prep', label: 'Prep me', prep: { title: 'Pete 1:1', startsAt: '2026-11-06T22:00:00.000Z', occurrence: null } },
      { id: 'dismiss', label: 'Not now' },
    ])
    expect(c.line).toBe('Pete 1:1 at 4:00 PM. Prep me?')
    expect(c.key).toMatch(/^prep:[0-9a-f]{16}:2026-11-06$/)
  })

  it('survives the feed store: parseFeedItem keeps a valid prep payload and drops an invalid one', () => {
    const now = Date.parse('2026-11-06T21:50:00Z')
    const [c] = prepCandidates({ title: 'Pete 1:1', time: '2026-11-06T16:00:00-06:00' }, now, 'America/Chicago')
    const item = parseFeedItem(toFeedItem(c, now))
    expect(item.actions[0]).toEqual({ id: 'prep', label: 'Prep me', prep: { title: 'Pete 1:1', startsAt: '2026-11-06T22:00:00.000Z', occurrence: null } })
    expect(item.actions[1]).toEqual({ id: 'dismiss', label: 'Not now' })
    const bad = parseFeedItem({ ...toFeedItem(c, now), actions: [{ id: 'prep', label: 'Prep me', prep: { title: 'x', startsAt: 'soon', occurrence: null } }] })
    expect(bad.actions[0]).toEqual({ id: 'prep', label: 'Prep me' })
  })
})
