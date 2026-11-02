// 6.97.8: fold the "nobody named an owner or a date, settle it" cues into one combined cue.
//
// On 2026-11-02, 34 of 100 cues were that one template, each taking a lens slot. This module decides which cues are open items
// and keeps the held ones for a combined cue: at most one every 10 minutes, at most 3 items, each short. An item that arrives
// while one was shown recently waits for the next; one that waits too long, or beyond the newest three, is dropped.
//
// What counts as an open item, in order:
//   1. never a decision (a record of what the room settled stands on its own) and never a cue that cites a past meeting or note
//      (the cross-meeting contrast is the value there; the owner or date ask is the minor half);
//   2. the writer's own `open` field, when it returned one (the extended-kind prompt asks for it, with the item in its own words);
//   3. otherwise the wording: an explicit absence of an owner, a date or someone taking it on, together with an ask to settle it
//      (or, for the followUp and promise kinds, the absence alone). Narrow on purpose: a cue that merely mentions an owner, a
//      deadline that is someone else's, or proposes a concrete check is not matched. Today one cue the owner rated Useful ("the
//      room hasn't said who tests them. Pick a check, like running ...") matches a looser reading, so the loose reading is not used.
// Pure: no clock, no model, no I/O. The engine owns the session state and the emit.

import { cueOverlap, cueTokens } from './live-cues-filter.js'
import type { CueKind } from '../../shared/live-cues-v2.js'

/** At most one combined cue per this long. */
export const OPEN_ITEMS_EVERY_MS = 10 * 60_000
/** At most this many items in one combined cue. */
export const OPEN_ITEMS_MAX = 3
/** A held item older than this is dropped, not shown late. */
export const OPEN_ITEM_STALE_MS = 20 * 60_000
/** Longest item, in characters. Three of them and the lead-in stay inside the 220-character cue detail. */
export const OPEN_ITEM_MAX_CHARS = 56
/** Two items this alike (token overlap) are the same item. */
const SAME_ITEM = 0.6

const ABSENT = /\b(?:no|nobody|none|not yet|hasn'?t|haven'?t|wasn'?t|weren'?t|isn'?t|never)\b[^.!?]{0,60}?\b(?:owner|owners|date|dates|deadline|named|taken|assigned)\b/i
const ASK = /\b(?:name|pick|assign|set|settle|pin|pin down|agree|choose|decide|fix|confirm)\b[^.!?]{0,40}?\b(?:an? owner|the owner|who|when|an? date|the date|a deadline|a day|cadence)\b/i

/** The wording rule alone (rule 3 above). */
export function isOwnerDateGap(detail: string, kind: CueKind): boolean {
  const text = detail || ''
  if (!ABSENT.test(text)) return false
  return ASK.test(text) || kind === 'followUp' || kind === 'promise'
}

/** One item in the writer's words, trimmed to the item limit; null when it says nothing. */
export function cleanOpenItem(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim().replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, '')
  if (text.length < 3) return null
  return clipAtWord(text, OPEN_ITEM_MAX_CHARS)
}

function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '') + '…'
}

/** An item label from a cue's wording: its first sentence (what is open; the second sentence is usually the gap), clipped. */
export function openItemFromText(detail: string): string {
  const clean = (detail || '').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim()
  const first = (clean.split(/(?<=[.!?])\s+/)[0] ?? clean).replace(/^open:\s*/i, '').replace(/[.!?]+$/, '').trim()
  return clipAtWord(first.charAt(0).toUpperCase() + first.slice(1), OPEN_ITEM_MAX_CHARS)
}

export interface OpenItemVerdict { label: string; source: 'field' | 'text' }

/** Is this cue an open item, and what is the item? `field` is the writer's own `open` value, `cited` how many past sources it has. */
export function openItemOf(cue: { kind: CueKind; detail: string; cited: number; field?: unknown }): OpenItemVerdict | null {
  if (cue.kind === 'decision' || cue.cited > 0) return null
  const fromField = cleanOpenItem(cue.field)
  if (fromField) return { label: fromField, source: 'field' }
  return isOwnerDateGap(cue.detail, cue.kind) ? { label: openItemFromText(cue.detail), source: 'text' } : null
}

/** The combined cue's wording. Plain words, one sentence, no dashes. */
export function openItemsDetail(items: readonly string[]): string {
  return `Still open, no owner or date: ${items.join('; ')}.`
}
export function openItemsHeadline(count: number): string {
  return count === 1 ? 'Open item: needs an owner or date' : `Open items: ${count} need an owner or date`
}

/** The held items of one meeting, and when a combined cue is due. */
export class OpenItemFold {
  private pending: Array<{ label: string; at: number }> = []
  private shown: string[] = []
  private lastDigestAt: number | null = null

  /** Hold an item, unless it is the same as one held or one already shown. Returns whether it was kept. */
  hold(label: string, now: number): boolean {
    const tokens = cueTokens(label)
    const same = (other: string) => cueOverlap(tokens, cueTokens(other)) >= SAME_ITEM
    if (this.pending.some(p => same(p.label)) || this.shown.some(same)) return false
    this.pending.push({ label, at: now })
    return true
  }

  /** How many items wait (after dropping the stale ones). */
  waiting(now: number): number {
    this.pending = this.pending.filter(p => now - p.at <= OPEN_ITEM_STALE_MS)
    return this.pending.length
  }

  /** The items of a combined cue if one is due now: at least two waiting, and none shown in the last 10 minutes. The newest three. */
  due(now: number): string[] | null {
    if (this.lastDigestAt !== null && now - this.lastDigestAt < OPEN_ITEMS_EVERY_MS) return null
    if (this.waiting(now) < 2) return null
    return this.pending.slice(-OPEN_ITEMS_MAX).map(p => p.label)
  }

  /** The combined cue was shown: clear what waited (the older ones are dropped, not carried) and remember what was said. */
  markShown(items: readonly string[], now: number): void {
    this.shown.push(...items)
    this.pending = []
    this.lastDigestAt = now
  }
}
