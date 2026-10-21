/**
 * 6.83.0 (M1, canary C3): which sessions belong to a Work card, from COS Control's snapshot and the tag index.
 * Pure: no I/O. The rules and their ranks are in docs/work-orchestrator.md.
 */
import type { ControlSnapshot } from './snapshot.js'
import type { TagHit } from './tag-index.js'
import { tagForWorkID, tagsIn } from './tags.js'

/** Evidence kinds, strongest first. The first five make a session the card's; status and listed confirm one. */
export const EVIDENCE_RANK = ['link', 'created', 'forked', 'continued', 'prompt', 'status', 'listed', 'meeting'] as const
export type Evidence = typeof EVIDENCE_RANK[number]
const MEMBER: ReadonlySet<Evidence> = new Set(['link', 'created', 'forked', 'continued', 'prompt'])
const CONFIRMS: ReadonlySet<Evidence> = new Set(['status', 'listed'])

export interface CardSession {
  id: string
  /** Evidence kinds for this card, in rank order. */
  discoveredBy: Evidence[]
  /** True: one of ranks 1 to 5 holds. False: a suggestion (status or listed alone, or the source-meeting join). */
  member: boolean
  linked: boolean
  /** Newest evidence for this card (ms). */
  lastTouchedCard: number | null
  /** Set when the session's newest strong evidence is on another card: it works there now, and keeps this one as history. */
  onAnotherCard: boolean
}

interface Ev { kind: Evidence; at: number | null }

/**
 * Strong evidence per card tag and session, from Control's records and the logs.
 * A placeholder or never-used tag (canary precision fix 7: `aaaaaaaaaaaa`, `0123456789ab`) is inert by construction: only
 * the requested card's own tag is read for this card, and only member evidence (a Control record or a real handoff
 * prompt) can make another card the newer owner, so a status line with an unknown tag never changes a row.
 */
function strongByTag(snapshot: ControlSnapshot | null, hits: TagHit[]): Map<string, Map<string, Ev[]>> {
  const out = new Map<string, Map<string, Ev[]>>()
  const add = (tag: string, sid: string | null, kind: Evidence, at: number | null) => {
    if (!sid) return
    let card = out.get(tag); if (!card) out.set(tag, card = new Map())
    let list = card.get(sid); if (!list) card.set(sid, list = [])
    list.push({ kind, at })
  }
  for (const l of snapshot?.links ?? []) add(tagForWorkID(l.workID), l.sessionID, 'link', l.at * 1000)
  for (const r of snapshot?.receipts ?? []) {
    const tag = tagForWorkID(r.workID), at = r.createdAt * 1000
    if (r.mode === 'newSession') add(tag, r.sessionID, 'created', at)
    else if (r.mode === 'fork') {
      // A fork's child: journaled by Control 0.5.333, or a sessionID that is not the source (canary precision fix 1).
      const child = r.forkChildID ?? (r.sessionID && r.sessionID !== r.sourceSessionID ? r.sessionID : null)
      add(tag, child, 'forked', at)
    } else add(tag, r.sessionID ?? r.sourceSessionID, 'continued', at)
    // A sourceSessionID is where a fork or new session came FROM, never membership (precision fix 2).
  }
  for (const h of hits) {
    if (h.kind === 'prompt') add(h.tag, h.sid, 'prompt', h.at)
    else if (h.kind === 'status') add(h.tag, h.sid, 'status', h.at)
  }
  for (const row of snapshot?.live?.rows ?? []) {
    for (const tag of tagsIn(row.summary)) add(tag, row.id, 'listed', row.updatedAt ? Date.parse(row.updatedAt) || null : null)
  }
  return out
}

const newest = (list: Ev[], kinds?: ReadonlySet<Evidence>) => list.filter(e => !kinds || kinds.has(e.kind)).reduce<number | null>((m, e) => (e.at !== null && (m === null || e.at > m) ? e.at : m), null)

/**
 * The card's sessions. `meetingWorkIDs`: the card's confirmed source meetings as meeting cards (`meeting:<recordId>`);
 * a session that is a member of one of them is suggested here with the reason (rule 8).
 */
export function discoverCardSessions(workID: string, snapshot: ControlSnapshot | null, hits: TagHit[], meetingWorkIDs: string[] = []): CardSession[] {
  const byTag = strongByTag(snapshot, hits)
  const tag = tagForWorkID(workID)
  const mine = new Map<string, Ev[]>(byTag.get(tag) ?? [])
  for (const m of meetingWorkIDs) {
    for (const [sid, list] of byTag.get(tagForWorkID(m)) ?? []) {
      if (!list.some(e => MEMBER.has(e.kind))) continue
      const at = newest(list, MEMBER)
      mine.set(sid, [...(mine.get(sid) ?? []), { kind: 'meeting', at }])
    }
  }
  const out: CardSession[] = []
  for (const [sid, list] of mine) {
    const kinds = EVIDENCE_RANK.filter(k => list.some(e => e.kind === k))
    const member = kinds.some(k => MEMBER.has(k))
    if (!member && !kinds.some(k => CONFIRMS.has(k) || k === 'meeting')) continue
    // Newest strong evidence decides "working on" (precision fix 5): another card with newer member evidence wins.
    const here = newest(list, MEMBER) ?? newest(list)
    let elsewhere: number | null = null
    for (const [otherTag, sessions] of byTag) {
      if (otherTag === tag || meetingWorkIDs.some(m => tagForWorkID(m) === otherTag)) continue
      const t = newest(sessions.get(sid) ?? [], MEMBER)
      if (t !== null && (elsewhere === null || t > elsewhere)) elsewhere = t
    }
    out.push({ id: sid, discoveredBy: kinds, member, linked: kinds.includes('link'), lastTouchedCard: newest(list),
      onAnotherCard: elsewhere !== null && here !== null && elsewhere > here })
  }
  return out
}
