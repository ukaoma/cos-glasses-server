// 6.97.8: fold the "nobody named an owner or a date, settle it" cues into one combined cue.
//
// On 2026-11-02, 34 of 100 cues were that one template, each taking a lens slot. This module decides which cues are open items
// and keeps the held ones for a combined cue: at most one every 10 minutes, at most 3 items, each short.
//
// What counts as an open item (QA fix: the item must come from the writer, never from a guess at the wording):
//   1. the writer returned its own `open` item (the extended-kind prompt, writer v4, asks for it; the legacy prompt never returns
//      one, so a legacy meeting folds nothing and every cue is shown as written);
//   2. the cue is also, in its wording, an owner or date gap (a cue that carries a risk or a figure and merely mentions an owner is
//      never reduced to a label);
//   3. never a decision, and never a cue that cites a past meeting or note.
// A held cue is never lost: the engine logs it when it is held, keeps it in the writer's recent-cue history, and the fold hands
// it back for display: in a combined cue (the newest three, once 10 minutes have passed since the last), or, when nothing joined
// it within 20 minutes, on its own exactly as the writer wrote it.
// Pure: no clock, no model, no I/O. The engine owns the session state and the emit.

import { cueOverlap, cueTokens } from './live-cues-filter.js'
import type { CueKind, LiveCueV2 } from '../../shared/live-cues-v2.js'

/** At most one combined cue per this long. */
export const OPEN_ITEMS_EVERY_MS = 10 * 60_000
/** At most this many items in one combined cue. */
export const OPEN_ITEMS_MAX = 3
/** A held item that nothing joined for this long is shown on its own. */
export const OPEN_ITEM_STALE_MS = 20 * 60_000
/** Longest item, in characters: the writer is asked for 50. Three of them and the lead-in stay inside the 220-character cue detail, one with " +2" inside the 64-character headline. */
export const OPEN_ITEM_MAX_CHARS = 50
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

export interface OpenItemVerdict { label: string }

/** Is this cue an open item, and what is the item? `field` is the writer's own `open` value, `cited` how many past sources it has. */
export function openItemOf(cue: { kind: CueKind; detail: string; cited: number; field?: unknown }): OpenItemVerdict | null {
  if (cue.kind === 'decision' || cue.cited > 0) return null
  const label = cleanOpenItem(cue.field)
  return label && isOwnerDateGap(cue.detail, cue.kind) ? { label } : null
}

/** The combined cue's wording. Plain words, one sentence, no dashes. */
export function openItemsDetail(items: readonly string[]): string {
  return `Still open, no owner or date: ${items.join('; ')}.`
}
/** The lens footer shows only this: the first item, and how many more are in the cue. */
export function openItemsHeadline(items: readonly string[]): string {
  return items.length > 1 ? `${items[0]} +${items.length - 1}` : items[0]
}

export interface HeldItem { label: string; at: number; cue: LiveCueV2 }
/** What the fold hands back when something is due: a combined cue of the newest three, or the oldest stale item on its own. */
export type FlushPlan = { mode: 'digest'; items: HeldItem[] } | { mode: 'alone'; items: [HeldItem] }

/** The held items of one meeting, and when something is due. */
export class OpenItemFold {
  private pending: HeldItem[] = []
  private everHeld: LiveCueV2[] = []
  private shownLabels: string[] = []
  private lastDigestAt: number | null = null

  /** Hold a cue as an item, unless it is the same item as one held or already shown (it is then only remembered). Returns whether it waits. */
  hold(label: string, cue: LiveCueV2, now: number): boolean {
    this.everHeld.push(cue)
    const tokens = cueTokens(label)
    const same = (other: string) => cueOverlap(tokens, cueTokens(other)) >= SAME_ITEM
    if (this.pending.some(p => same(p.label)) || this.shownLabels.some(same)) return false
    this.pending.push({ label, at: now, cue })
    return true
  }

  /** How many items wait. */
  waiting(): number { return this.pending.length }

  /** Every cue ever held, for the writer's recent-cue history and the repeat rules: a held item must not be raised again. */
  history(): readonly LiveCueV2[] { return this.everHeld }

  /** The held cues not yet shown in any form (meeting end). */
  unshown(): LiveCueV2[] { return this.pending.map(p => p.cue) }

  /** What is due now. A combined cue needs two waiting and 10 minutes since the last; a stale item is shown alone. */
  next(now: number): FlushPlan | null {
    const spaced = this.lastDigestAt === null || now - this.lastDigestAt >= OPEN_ITEMS_EVERY_MS
    if (spaced && this.pending.length >= 2) return { mode: 'digest', items: this.pending.slice(-OPEN_ITEMS_MAX) }
    const stale = this.pending.find(p => now - p.at >= OPEN_ITEM_STALE_MS)
    return stale ? { mode: 'alone', items: [stale] } : null
  }

  /** The plan was shown. */
  markShown(plan: FlushPlan, now: number): void {
    this.pending = this.pending.filter(p => !plan.items.includes(p))
    this.shownLabels.push(...plan.items.map(i => i.label))
    if (plan.mode === 'digest') this.lastDigestAt = now
  }
}
