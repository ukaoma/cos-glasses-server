/**
 * Drop it P2 (plan PLAN_drop_it_2026-11-04 section 4): the resolution loop. "Your Work item finished", once.
 *
 * Links are stable ids, never titles: a card is its domain plus workIdentity, a handoff is its journal receipt id,
 * a session is provider:native, a thread its id. Detection runs two ways that must agree:
 * - events from the server's own writes (a card moved through /api/work-board or /api/tasks), and
 * - a 2-minute poll of the linked open cards and their handoff receipts, because the helper and other sessions
 *   write tasks.md directly.
 *
 * Exactly once (canary 7): the key is `dropId:linkKind:linkId:state`, and the feed store's insert is idempotent on
 * it under the store lock, written before any banner. A state seen by both the event and the poll, or again after a
 * restart, finds the key and stops. A QA, Draft, QA bounce posts once.
 *
 * What posts: a card reaching QA or Complete, or archived; a handoff completed (with its report, 240 characters),
 * failed or refused; a session follow-up that was replied to or failed; a thread resolved or gone stale. Other moves
 * change only the drop's status in History. No model, no script; the words are templates over the link's label.
 */
import type { DropRecord, DropLink } from './drop-store.js'
import { clip, PING_TEXT, type PingCandidate } from './ping-sources.js'

/** Control's report clip (C WorkProgressTracker.swift:588). */
export const RESOLUTION_REPORT_CHARS = 240
export const RESOLUTION_POLL_MS = 2 * 60_000
/** Drops older than this are not polled: a card that resolves after a quarter is not news about the drop. */
export const RESOLUTION_WINDOW_DAYS = 90

export type CardState = 'qa' | 'complete' | 'archived'
export type HandoffState = 'completed' | 'failed' | 'refused'
export type SessionState = 'replied' | 'failed'
export type ThreadState = 'resolved' | 'stale'

export interface CardSnapshot { workStage?: string; checked?: boolean }
export interface HandoffSnapshot { id: string; status: string; result?: string | null }
export interface ThreadSnapshot { is_resolved?: boolean; is_stale?: boolean }

/** What a card's board row says, as a resolution state, or null for a move that only updates status silently. */
export function cardState(row: CardSnapshot | null | undefined): CardState | null {
  if (row === null) return 'archived'  // absent from the board: archived ([~]) or removed
  if (!row) return null
  if (row.checked === true || row.workStage === 'complete') return 'complete'
  if (row.workStage === 'qa') return 'qa'
  return null
}
export function handoffState(receipt: HandoffSnapshot | null | undefined): HandoffState | null {
  const s = receipt?.status
  return s === 'completed' || s === 'failed' || s === 'refused' ? s : null
}
export function threadState(t: ThreadSnapshot | null | undefined): ThreadState | null {
  if (!t) return null
  if (t.is_resolved === true) return 'resolved'
  if (t.is_stale === true) return 'stale'
  return null
}

/** The exactly-once key. */
export const resolutionKey = (dropId: string, link: Pick<DropLink, 'kind' | 'id'>, state: string) => `${dropId}:${link.kind}:${link.id}:${state}`

const OPEN_CARD = { id: 'open_card', label: 'Open card' }
const OPEN_RESULT = { id: 'open_result', label: 'Open result' }
const OPEN = { id: 'open', label: 'Open' }

/** "Re: send Gina the JCK numbers": the one-line quote of the drop a follow-up answers (plan section 1). */
export function quoteOf(drop: Pick<DropRecord, 'text'>): string {
  return `Re: ${clip(drop.text, 80)}`
}

/** The follow-up for one link reaching one state. */
export function resolutionCandidate(
  drop: Pick<DropRecord, 'id' | 'text'>,
  link: DropLink,
  state: CardState | HandoffState | SessionState | ThreadState,
  nowMs: number,
  extra: { report?: string | null; handoffId?: string } = {},
): PingCandidate {
  const label = clip(link.label, PING_TEXT.title) || 'it'
  const base = { source: 'resolution' as const, key: resolutionKey(drop.id, extra.handoffId ? { kind: 'handoff', id: extra.handoffId } : link, state), title: quoteOf(drop), createdAt: nowMs, threadId: drop.id }
  const report = extra.report ? clip(extra.report, RESOLUTION_REPORT_CHARS) : ''
  switch (state) {
    case 'complete': return { ...base, line: `Done: ${label} moved to Complete.`, links: [link], actions: [OPEN_CARD] }
    case 'qa': return { ...base, line: `${label} is ready for your review.`, links: [link], actions: [OPEN_CARD], needsReply: true }
    case 'archived': return { ...base, line: `${label} was archived.`, links: [link], actions: [] }
    case 'completed': return { ...base, line: report ? `Done: ${label}. ${report}` : `Done: ${label}.`, links: [link], actions: [OPEN_RESULT, OPEN_CARD] }
    case 'refused': return { ...base, line: `The agent refused ${label}.${report ? ` ${report}` : ''}`, links: [link], actions: [OPEN_RESULT, OPEN_CARD], needsReply: true }
    case 'failed': return link.kind === 'session'
      ? { ...base, line: `${label} stopped before it replied.`, links: [link], actions: [OPEN_RESULT], needsReply: true }
      : { ...base, line: `${label} failed.${report ? ` ${report}` : ''}`, links: [link], actions: [OPEN_RESULT, OPEN_CARD], needsReply: true }
    case 'replied': return { ...base, line: `${label} replied.`, links: [link], actions: [OPEN_RESULT] }
    case 'resolved': return { ...base, line: `The ${label} thread is resolved.`, links: [link], actions: [OPEN] }
    case 'stale': return { ...base, line: `The ${label} thread went quiet.`, links: [link], actions: [OPEN] }
  }
}

/** Drops whose links the poll follows: filed, not undone, inside the window, with a card, thread or held session. */
export function followedDrops(drops: readonly DropRecord[], nowMs: number): DropRecord[] {
  const cutoff = nowMs - RESOLUTION_WINDOW_DAYS * 86_400_000
  return drops.filter(d => d.state !== 'undone' && Date.parse(d.createdAt) >= cutoff && d.links.some(l => l.kind === 'card' || l.kind === 'thread'))
}

export interface ResolutionSnapshot {
  /** Board rows keyed `${domain}:${workIdentity}`. Absent means the board could not be read (nothing is inferred). */
  cards?: ReadonlyMap<string, CardSnapshot>
  /** Handoff receipts for a card, keyed `${domain}:${workIdentity}`, journal order. */
  handoffs?: ReadonlyMap<string, readonly HandoffSnapshot[]>
  /** Thread rows by id. Absent means the cache could not be read. */
  threads?: ReadonlyMap<string, ThreadSnapshot>
}

/**
 * The follow-ups a poll (or an event, as a one-card snapshot) finds. Pure: candidates out, and the ping engine posts
 * each key at most once. A card missing from a board that WAS read counts as archived; an unread board says nothing.
 */
export function pollResolutions(drops: readonly DropRecord[], snap: ResolutionSnapshot, nowMs: number): PingCandidate[] {
  const out: PingCandidate[] = []
  for (const drop of followedDrops(drops, nowMs)) {
    for (const link of drop.links) {
      if (link.kind === 'card' && link.domain && snap.cards) {
        const key = `${link.domain}:${link.id}`
        const row = snap.cards.has(key) ? snap.cards.get(key)! : null
        const state = cardState(row)
        if (state) out.push(resolutionCandidate(drop, link, state, nowMs))
        for (const receipt of snap.handoffs?.get(key) ?? []) {
          const h = handoffState(receipt)
          if (h) out.push(resolutionCandidate(drop, link, h, nowMs, { report: receipt.result ?? null, handoffId: receipt.id }))
        }
      } else if (link.kind === 'thread' && snap.threads) {
        const state = threadState(snap.threads.get(link.id))
        if (state) out.push(resolutionCandidate(drop, link, state, nowMs))
      }
    }
  }
  return out
}

/** An event from the server's own card write: the same rule as the poll, for the drops linked to that one card. */
export function cardWriteResolutions(drops: readonly DropRecord[], domain: string, workIdentity: string, row: CardSnapshot | null, nowMs: number): PingCandidate[] {
  const linked = drops.filter(d => d.links.some(l => l.kind === 'card' && l.domain === domain && l.id === workIdentity))
  return pollResolutions(linked, { cards: new Map(row ? [[`${domain}:${workIdentity}`, row]] : []) }, nowMs)
    .filter(c => !c.key.includes(':handoff:'))
}

/** A session hook event as a turn outcome: Stop is a reply; StopFailure and Interrupt stopped it. A subagent's never counts. */
export function sessionTurnOutcome(event: string, child: boolean): SessionState | null {
  if (child) return null
  if (event === 'Stop') return 'replied'
  if (event === 'StopFailure' || event === 'Interrupt') return 'failed'
  return null
}

/** A held drop names its session as `provider:native` or the bare native id; the hooks report the native id. */
export function sameHeldSession(held: string, hookSessionId: string): boolean {
  const a = held.toLowerCase(), b = hookSessionId.toLowerCase()
  return a === b || a.endsWith(`:${b}`)
}

/**
 * The turn after Send to session ended (SessionSignalStore): replied or failed, for the drops held for it. Only a turn
 * that ended after the drop was sent counts, so the end of the turn already running at Send is never its answer.
 */
export function sessionTurnResolutions(drops: readonly DropRecord[], sessionId: string, outcome: SessionState, nowMs: number, endedAtMs = nowMs): PingCandidate[] {
  const out: PingCandidate[] = []
  for (const d of drops) {
    if (d.state === 'undone' || d.dest !== 'session' || !d.hold?.sentAt || !sameHeldSession(d.hold.sessionId, sessionId)) continue
    if (!(Date.parse(d.hold.sentAt) < endedAtMs)) continue
    const link: DropLink = d.links.find(l => l.kind === 'session' && sameHeldSession(l.id, sessionId)) ?? { kind: 'session', id: d.hold.sessionId, label: d.hold.label }
    out.push(resolutionCandidate(d, link, outcome, nowMs))
  }
  return out
}
