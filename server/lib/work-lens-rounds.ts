/**
 * 6.83.0: lens plans in Work chat history, and "Send this plan" (contract:
 * operations/personal/wk43_2026/CONTRACT_lens_plans_6.83.0_2026-10-21.md in the MU repo; docs/work-orchestrator.md).
 *
 * The lens records a plan it made (POST /api/work/chat with the orchestrator input) as a lens round, and may ask for it
 * to be sent. This store only holds rounds and requests. COS Control owns every send and its Work chat journal: it pulls
 * the inbox, writes the round into the card's Work chat record, performs each send through its own Send path and
 * reports results. Nothing here sends to a session.
 *
 * Storage: `data/work-lens-rounds.json`, atomic (0600), at most 200 rounds, each kept 14 days. Ids, states, times and
 * short text only; plans carry prompts, which are the user's own words.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { atomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'
import { WORK_CHAT_EFFORTS, WORK_CHAT_MAX_ASSIGNMENTS, WORK_CHAT_MAX_ITEMS, WORK_CHAT_PLANNERS } from './work-chat.js'
import type { ControlSnapshot } from './work-orchestrator/snapshot.js'

export const LENS_ROUNDS_MAX = 200
export const LENS_ROUND_TTL_MS = 14 * 24 * 3600_000
/** A send request COS Control has not picked up in 10 minutes is expired. */
export const LENS_SEND_PICKUP_MS = 10 * 60_000
/** A picked-up send whose assignment COS Control never reported in 15 minutes is marked failed, so the lens stops polling. */
export const LENS_SEND_REPORT_MS = 15 * 60_000
/** COS Control is connected while it has polled the inbox in the last 60 seconds. */
export const LENS_CONTROL_FRESH_MS = 60_000
export const LENS_INBOX_MAX = 50
export const LENS_ROUND_BODY_BYTES = 256_000
export const LENS_QUESTION_CHARS = 4000
export const LENS_ANSWER_CHARS = 6000
export const LENS_PROMPT_CHARS = 6000
export const LENS_DETAIL_CHARS = 200
const MAX_SENDS_KEPT = 8
const MAX_STOPS_KEPT = 8

const WORK_ID = /^task:[a-z_]+:[a-f0-9]{12}$/
const CLIENT_ROUND_ID = /^lens-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SID = /^(claude|codex|cursor):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const ITEM_ID = /^[a-z]{1,8}(:[a-f0-9]{12})?$/
const RECEIPT_ID = /^[A-Za-z0-9_.:-]{1,80}$/
export const ROUND_ID = /^lr_[a-f0-9]{16}$/
export const SEND_ID = /^ls_[a-f0-9]{16}$/

export const ASSIGNMENT_MODES = ['continue', 'fork', 'newSession'] as const
export const ASSIGNMENT_STATES = ['pending', 'held', 'sent', 'delivered', 'failed', 'refused', 'stopped'] as const
export const ROUND_STATES = ['recorded', 'in_history', 'send_requested', 'sending', 'sent', 'partly_sent', 'refused', 'expired'] as const
export type AssignmentMode = typeof ASSIGNMENT_MODES[number]
export type AssignmentState = typeof ASSIGNMENT_STATES[number]
export type RoundState = typeof ROUND_STATES[number]
type SendState = 'send_requested' | 'sending' | 'sent' | 'partly_sent' | 'refused' | 'expired'
const TERMINAL: readonly AssignmentState[] = ['sent', 'delivered', 'failed', 'refused', 'stopped']
const SENT_LIKE: readonly AssignmentState[] = ['sent', 'delivered']

export interface LensAssignment {
  id: string; mode: AssignmentMode; sessionID?: string; provider?: string; prompt: string; contextItemIDs?: string[]
  state: AssignmentState; receiptId?: string; detail?: string; reportedSessionID?: string; updatedAt?: string
}
export interface LensSendRequest {
  id: string; assignmentIds: string[]; confirm: 'two-step' | null; confirmedAt: string | null; autoSend: boolean
  requestedAt: number; pickedUpAt: number | null; state: SendState; finishedAt: number | null
}
export interface LensStopRequest { id: string; assignmentIds: string[]; sendRequestId: string | null; requestedAt: number; pickedUpAt: number | null }
export interface LensRound {
  roundId: string; seq: number; clientRoundId: string; workID: string; question: string; answer: string
  planner: string | null; effort: string | null; orchestrator: boolean; assignments: LensAssignment[]
  createdAt: string; recordedAt: number; inHistory: boolean; historyAt: number | null; autoSendCard: boolean
  /** The card's sessions (Control snapshot links and receipts) when the plan was recorded; null when no snapshot. */
  cardSessions: string[] | null
  sends: LensSendRequest[]; stops: LensStopRequest[]; updatedAt: number
}
interface StoreFile { version: 1; seq: number; rounds: LensRound[] }

export class LensRoundError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) { super(message) }
}
const invalid = (field: string, message = `The plan's ${field} is not valid.`) => new LensRoundError('invalid_lens_round', 400, message, { field })

const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, n: number): v is string => typeof v === 'string' && v.length <= n && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)
const iso = (v: unknown): v is string => str(v, 40) && !Number.isNaN(Date.parse(v as string))
const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`

export interface LensRoundInput {
  workID: string; clientRoundId: string; question: string; answer: string; planner: string | null; effort: string | null
  orchestrator: boolean; assignments: Omit<LensAssignment, 'state'>[]; createdAt: string
}

/** The record body. Unknown keys are ignored and never stored. */
export function parseLensRound(v: unknown): LensRoundInput {
  if (!obj(v)) throw invalid('body', 'The plan could not be read.')
  if (v.v !== 1) throw invalid('v')
  if (!str(v.workID, 256) || !WORK_ID.test(v.workID)) throw invalid('workID')
  if (!str(v.clientRoundId, 60) || !CLIENT_ROUND_ID.test(v.clientRoundId)) throw invalid('clientRoundId')
  if (!str(v.question, LENS_QUESTION_CHARS) || !v.question.trim()) throw invalid('question')
  if (!str(v.answer, LENS_ANSWER_CHARS)) throw invalid('answer')
  if (v.planner !== undefined && !(WORK_CHAT_PLANNERS as readonly unknown[]).includes(v.planner)) throw invalid('planner')
  if (v.effort !== undefined && !(WORK_CHAT_EFFORTS as readonly unknown[]).includes(v.effort)) throw invalid('effort')
  if (v.orchestrator !== undefined && typeof v.orchestrator !== 'boolean') throw invalid('orchestrator')
  if (v.source !== 'lens') throw invalid('source')
  if (!iso(v.createdAt)) throw invalid('createdAt')
  if (!Array.isArray(v.assignments) || v.assignments.length > WORK_CHAT_MAX_ASSIGNMENTS) throw invalid('assignments')
  const assignments: LensRoundInput['assignments'] = []
  v.assignments.forEach((a: unknown, i: number) => {
    if (!obj(a) || a.id !== `a${i + 1}`) throw invalid('assignments.id', 'Assignment ids must be a1 to aN in answer order.')
    const mode = a.mode ?? 'continue'
    if (!(ASSIGNMENT_MODES as readonly unknown[]).includes(mode)) throw invalid('assignments.mode')
    if (mode !== 'newSession' && !(str(a.sessionID, 64) && SID.test(a.sessionID))) throw invalid('assignments.sessionID')
    if (mode === 'newSession' && a.sessionID !== undefined && a.sessionID !== null) throw invalid('assignments.sessionID')
    if (mode === 'newSession' ? !['claude', 'codex'].includes(a.provider) : (a.provider !== undefined && !['claude', 'codex', 'cursor'].includes(a.provider))) throw invalid('assignments.provider')
    if (!str(a.prompt, LENS_PROMPT_CHARS) || !a.prompt.trim()) throw invalid('assignments.prompt')
    if (a.contextItemIDs !== undefined && !(Array.isArray(a.contextItemIDs) && a.contextItemIDs.length <= WORK_CHAT_MAX_ITEMS
      && a.contextItemIDs.every((id: unknown) => str(id, 24) && ITEM_ID.test(id)))) throw invalid('assignments.contextItemIDs')
    assignments.push({ id: a.id, mode: mode as AssignmentMode, ...(mode !== 'newSession' ? { sessionID: a.sessionID } : {}),
      ...(a.provider ? { provider: a.provider } : {}), prompt: a.prompt,
      ...(a.contextItemIDs ? { contextItemIDs: [...new Set<string>(a.contextItemIDs)] } : {}) })
  })
  return { workID: v.workID, clientRoundId: v.clientRoundId, question: v.question, answer: v.answer, planner: v.planner ?? null,
    effort: v.effort ?? null, orchestrator: v.orchestrator === true, assignments, createdAt: v.createdAt }
}

/** The card's sessions as COS Control's snapshot records them: confirmed links, receipt targets and fork children. */
export function cardSessionsOf(snapshot: ControlSnapshot | null, workID: string): string[] | null {
  if (!snapshot) return null
  const out = new Set<string>()
  for (const l of snapshot.links) if (l.workID === workID) out.add(l.sessionID)
  for (const r of snapshot.receipts) {
    if (r.workID !== workID) continue
    if (r.sessionID && !(r.mode === 'fork' && r.sessionID === r.sourceSessionID)) out.add(r.sessionID)
    if (r.forkChildID) out.add(r.forkChildID)
  }
  return [...out].sort()
}

/**
 * A plan is stale when the card's sessions changed since it was recorded: a session added (a link, a receipt's new
 * session, a fork child) or one gone. Sessions this round's own sends reported (a New session, a fork child) are not
 * a change, so a partly sent plan can send the rest. Unknown on either side (no snapshot) is never stale.
 */
export function planIsStale(round: LensRound, now: string[] | null): boolean {
  if (!round.cardSessions || !now) return false
  const before = new Set(round.cardSessions)
  const own = new Set(round.assignments.map(a => a.reportedSessionID).filter((s): s is string => !!s && !before.has(s)))
  const after = now.filter(s => !own.has(s))
  return after.length !== before.size || after.some(s => !before.has(s))
}

/** Where a picked-up send ended, from its assignments. */
export function sendOutcome(states: AssignmentState[]): 'sent' | 'partly_sent' | 'refused' {
  const sent = states.filter(s => SENT_LIKE.includes(s)).length
  return sent === states.length ? 'sent' : sent > 0 ? 'partly_sent' : 'refused'
}

export interface ControlSeen { at: number; autoSend: boolean }

export class LensRoundStore {
  private file: StoreFile = { version: 1, seq: 0, rounds: [] }
  private control: ControlSeen | null = null
  constructor(private readonly path: string | null, private readonly now: () => number = Date.now) {
    if (!path || !existsSync(path)) return
    try {
      const v = JSON.parse(readFileSync(path, 'utf8'))
      if (!obj(v) || v.version !== 1 || !Array.isArray(v.rounds) || typeof v.seq !== 'number') throw new Error('unrecognised')
      this.file = { version: 1, seq: v.seq, rounds: v.rounds.filter((r: unknown) => obj(r) && typeof r.roundId === 'string' && ROUND_ID.test(r.roundId)).slice(-LENS_ROUNDS_MAX) }
    } catch (e) {
      // Never overwrite what could not be read: move it aside and start empty.
      const aside = `${path}.unreadable-${this.now()}`
      try { renameSync(path, aside) } catch { /* nothing to move */ }
      console.warn(`[work-lens-rounds] ${path} could not be read (${(e as Error).message}); moved to ${aside}`)
    }
  }

  private persist(): void {
    if (!this.path) return
    try { mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 }); atomicWriteFileSync(this.path, JSON.stringify(this.file)) }
    catch (e) { console.warn(`[work-lens-rounds] kept in memory only: ${(e as Error).message}`) }
  }

  /** Drops rounds past 14 days, expires sends not picked up in 10 minutes, and fails sends never reported. */
  private sweep(): boolean {
    const now = this.now()
    let changed = false
    const kept = this.file.rounds.filter(r => now - r.recordedAt <= LENS_ROUND_TTL_MS)
    if (kept.length !== this.file.rounds.length) { this.file.rounds = kept; changed = true }
    for (const r of this.file.rounds) {
      const send = r.sends[r.sends.length - 1]
      if (!send) continue
      if (send.state === 'send_requested' && now - send.requestedAt > LENS_SEND_PICKUP_MS) {
        send.state = 'expired'; send.finishedAt = now; r.updatedAt = now; changed = true
      } else if (send.state === 'sending' && send.pickedUpAt !== null && now - send.pickedUpAt > LENS_SEND_REPORT_MS) {
        const mine = r.assignments.filter(a => send.assignmentIds.includes(a.id))
        const silent = mine.filter(a => a.state === 'pending')
        if (silent.length) {
          for (const a of silent) { a.state = 'failed'; a.detail = 'COS Control did not report this send.'; a.updatedAt = new Date(now).toISOString() }
          this.settle(r, send, now); changed = true
        }
      }
    }
    return changed
  }

  private settle(r: LensRound, send: LensSendRequest, now: number): void {
    const states = r.assignments.filter(a => send.assignmentIds.includes(a.id)).map(a => a.state)
    if (states.every(s => TERMINAL.includes(s))) { send.state = sendOutcome(states); send.finishedAt ??= now }
    else if (send.state !== 'sending') { send.state = 'sending'; send.finishedAt = null }
    r.updatedAt = now
  }

  private tick(): void { if (this.sweep()) this.persist() }

  find(roundId: string): LensRound | undefined { this.tick(); return this.file.rounds.find(r => r.roundId === roundId) }

  controlStatus(): { connected: boolean; lastSeenSec: number | null; autoSend: boolean } {
    const c = this.control
    if (!c) return { connected: false, lastSeenSec: null, autoSend: false }
    const age = Math.max(0, this.now() - c.at)
    return { connected: age <= LENS_CONTROL_FRESH_MS, lastSeenSec: Math.round(age / 1000), autoSend: c.autoSend }
  }

  record(input: LensRoundInput, cardSessions: string[] | null): { round: LensRound; created: boolean } {
    this.tick()
    const existing = this.replay(input.clientRoundId)
    if (existing) return { round: existing, created: false }
    const now = this.now()
    const round: LensRound = {
      roundId: newId('lr'), seq: ++this.file.seq, clientRoundId: input.clientRoundId, workID: input.workID, question: input.question,
      answer: input.answer, planner: input.planner, effort: input.effort, orchestrator: input.orchestrator,
      assignments: input.assignments.map(a => ({ ...a, state: 'pending' as const })), createdAt: input.createdAt, recordedAt: now,
      inHistory: false, historyAt: null, autoSendCard: false, cardSessions, sends: [], stops: [], updatedAt: now,
    }
    this.file.rounds.push(round)
    while (this.file.rounds.length > LENS_ROUNDS_MAX) {
      const idle = this.file.rounds.findIndex(r => !r.sends.some(s => s.state === 'send_requested' || s.state === 'sending'))
      this.file.rounds.splice(idle >= 0 ? idle : 0, 1)
    }
    this.persist()
    return { round, created: true }
  }

  replay(clientRoundId: string): LensRound | undefined { return this.file.rounds.find(r => r.clientRoundId === clientRoundId) }

  private active(r: LensRound): LensSendRequest | undefined {
    const s = r.sends[r.sends.length - 1]
    return s && (s.state === 'send_requested' || s.state === 'sending') ? s : undefined
  }

  /**
   * A send request. Omitted ids mean the whole plan, minus assignments already sent (so a partly sent plan sends the
   * rest); naming an assignment already sent, or nothing left to send, is `already_sent`.
   */
  requestSend(roundId: string, body: { assignmentIds?: string[]; confirm: 'two-step' | null; confirmedAt: string | null },
    checks: { cardSessions: string[] | null; controlConnected: boolean }): LensSendRequest {
    const r = this.find(roundId)
    if (!r) throw new LensRoundError('unknown_round', 404, 'This plan is not on the server any more.')
    if (this.active(r)) throw new LensRoundError('send_in_progress', 409, 'This plan is already being sent.')
    const known = new Set(r.assignments.map(a => a.id))
    if (body.assignmentIds && body.assignmentIds.some(id => !known.has(id))) throw invalid('assignmentIds', 'That assignment is not in this plan.')
    const sentAlready = (id: string) => SENT_LIKE.includes(r.assignments.find(a => a.id === id)!.state)
    const ids = body.assignmentIds ? [...new Set(body.assignmentIds)] : r.assignments.map(a => a.id).filter(id => !sentAlready(id))
    if (!ids.length || ids.some(sentAlready)) throw new LensRoundError('already_sent', 409, 'This plan was already sent.')
    if (planIsStale(r, checks.cardSessions)) throw new LensRoundError('plan_stale', 409, "This card's sessions changed since the plan. Plan again.")
    if (body.confirm !== 'two-step' && !r.autoSendCard) throw new LensRoundError('confirmation_required', 428, 'Confirm on the lens to send this plan.')
    if (!checks.controlConnected) throw new LensRoundError('control_not_connected', 423, 'COS Control is not connected. The plan is saved; send it from the Mac.')
    const now = this.now()
    const send: LensSendRequest = { id: newId('ls'), assignmentIds: ids, confirm: body.confirm, confirmedAt: body.confirmedAt,
      autoSend: body.confirm !== 'two-step', requestedAt: now, pickedUpAt: null, state: 'send_requested', finishedAt: null }
    for (const a of r.assignments) if (ids.includes(a.id)) { a.state = 'pending'; delete a.detail; delete a.receiptId }
    r.sends.push(send); if (r.sends.length > MAX_SENDS_KEPT) r.sends.splice(0, r.sends.length - MAX_SENDS_KEPT)
    r.updatedAt = now
    this.persist()
    return send
  }

  requestStop(roundId: string, assignmentIds: string[], controlConnected: boolean): LensStopRequest {
    const r = this.find(roundId)
    if (!r) throw new LensRoundError('unknown_round', 404, 'This plan is not on the server any more.')
    const known = new Set(r.assignments.map(a => a.id))
    if (!assignmentIds.length || assignmentIds.some(id => !known.has(id))) throw invalid('assignmentIds', 'That assignment is not in this plan.')
    if (!controlConnected) throw new LensRoundError('control_not_connected', 423, 'COS Control is not connected. Stop it from the Mac.')
    const now = this.now()
    const ids = [...new Set(assignmentIds)]
    const send = [...r.sends].reverse().find(s => ids.some(id => s.assignmentIds.includes(id))) ?? null
    const stop: LensStopRequest = { id: newId('lst'), assignmentIds: ids, sendRequestId: send?.id ?? null, requestedAt: now, pickedUpAt: null }
    r.stops.push(stop); if (r.stops.length > MAX_STOPS_KEPT) r.stops.splice(0, r.stops.length - MAX_STOPS_KEPT)
    r.updatedAt = now
    this.persist()
    return stop
  }

  /**
   * COS Control's poll. Lists rounds not yet in history (after `since`, oldest first), send requests waiting to be picked
   * up and stop requests, never more than 50 in all. Listing a send or a stop is its pick-up: it is listed once.
   */
  inbox(since: number, autoSend: boolean) {
    this.tick()
    const now = this.now()
    this.control = { at: now, autoSend }
    const rounds: LensRound[] = [], sends: { round: LensRound; send: LensSendRequest }[] = [], stops: { round: LensRound; stop: LensStopRequest }[] = []
    let room = LENS_INBOX_MAX, changed = false
    for (const r of this.file.rounds) {
      for (const s of r.sends) if (room > 0 && s.state === 'send_requested') { s.state = 'sending'; s.pickedUpAt = now; r.updatedAt = now; sends.push({ round: r, send: s }); room--; changed = true }
      for (const s of r.stops) if (room > 0 && s.pickedUpAt === null) { s.pickedUpAt = now; stops.push({ round: r, stop: s }); room--; changed = true }
    }
    for (const r of this.file.rounds) if (room > 0 && !r.inHistory && r.seq > since) { rounds.push(r); room-- }
    if (changed) this.persist()
    const content = (r: LensRound) => ({ roundId: r.roundId, workID: r.workID, clientRoundId: r.clientRoundId, question: r.question, answer: r.answer,
      planner: r.planner, effort: r.effort, orchestrator: r.orchestrator, createdAt: r.createdAt, recordedAt: new Date(r.recordedAt).toISOString(),
      assignments: r.assignments.map(a => ({ id: a.id, mode: a.mode, ...(a.sessionID ? { sessionID: a.sessionID } : {}), ...(a.provider ? { provider: a.provider } : {}),
        prompt: a.prompt, ...(a.contextItemIDs ? { contextItemIDs: a.contextItemIDs } : {}) })) })
    return {
      v: 1 as const,
      cursor: rounds.reduce((m, r) => Math.max(m, r.seq), since),
      rounds: rounds.map(content),
      sends: sends.map(({ round, send }) => ({ sendRequestId: send.id, roundId: round.roundId, workID: round.workID, assignmentIds: send.assignmentIds,
        confirm: send.confirm, confirmedAt: send.confirmedAt, autoSend: send.autoSend, requestedAt: new Date(send.requestedAt).toISOString(),
        round: content(round) })),
      stops: stops.map(({ round, stop }) => ({ stopRequestId: stop.id, roundId: round.roundId, workID: round.workID, assignmentIds: stop.assignmentIds,
        sendRequestId: stop.sendRequestId, requestedAt: new Date(stop.requestedAt).toISOString() })),
    }
  }

  markInHistory(roundId: string, autoSendCard: boolean | undefined): LensRound {
    const r = this.find(roundId)
    if (!r) throw new LensRoundError('unknown_round', 404, 'This plan is not on the server any more.')
    const now = this.now()
    if (!r.inHistory) { r.inHistory = true; r.historyAt = now }
    if (autoSendCard !== undefined) r.autoSendCard = autoSendCard
    r.updatedAt = now
    this.persist()
    return r
  }

  report(sendRequestId: string, results: { id: string; state: AssignmentState; receiptId?: string; detail?: string; sessionID?: string }[]): LensRound {
    this.tick()
    const r = this.file.rounds.find(x => x.sends.some(s => s.id === sendRequestId))
    const send = r?.sends.find(s => s.id === sendRequestId)
    if (!r || !send) throw new LensRoundError('unknown_send', 404, 'No such send request.')
    if (send.state === 'send_requested' || send.state === 'expired') throw new LensRoundError('send_not_picked_up', 409, 'This send request was not picked up.')
    if (results.some(x => !send.assignmentIds.includes(x.id))) throw invalid('assignments.id', 'That assignment is not in this send request.')
    const now = this.now(), at = new Date(now).toISOString()
    for (const x of results) {
      const a = r.assignments.find(y => y.id === x.id)!
      a.state = x.state; a.updatedAt = at
      if (x.receiptId) a.receiptId = x.receiptId
      if (x.detail !== undefined) a.detail = x.detail
      if (x.sessionID) a.reportedSessionID = x.sessionID
    }
    this.settle(r, send, now)
    this.persist()
    return r
  }
}

export function parseSendBody(v: unknown): { assignmentIds?: string[]; confirm: 'two-step' | null; confirmedAt: string | null } {
  if (v !== undefined && !obj(v)) throw invalid('body', 'The send request could not be read.')
  const b = (v ?? {}) as Record<string, any>
  if (b.v !== undefined && b.v !== 1) throw invalid('v')
  if (b.assignmentIds !== undefined && !(Array.isArray(b.assignmentIds) && b.assignmentIds.length >= 1 && b.assignmentIds.length <= WORK_CHAT_MAX_ASSIGNMENTS
    && b.assignmentIds.every((id: unknown) => typeof id === 'string' && /^a[1-9]$/.test(id)))) throw invalid('assignmentIds')
  if (b.confirm !== undefined && b.confirm !== 'two-step') throw invalid('confirm')
  if (b.confirmedAt !== undefined && !iso(b.confirmedAt)) throw invalid('confirmedAt')
  if (b.confirm === 'two-step' && b.confirmedAt === undefined) throw invalid('confirmedAt', 'A confirmed send carries the time it was confirmed.')
  return { ...(b.assignmentIds ? { assignmentIds: b.assignmentIds } : {}), confirm: b.confirm ?? null, confirmedAt: b.confirmedAt ?? null }
}

export function parseStopBody(v: unknown): string[] {
  if (!obj(v) || (v.v !== undefined && v.v !== 1) || !Array.isArray(v.assignmentIds) || v.assignmentIds.length < 1 || v.assignmentIds.length > WORK_CHAT_MAX_ASSIGNMENTS
    || !v.assignmentIds.every((id: unknown) => typeof id === 'string' && /^a[1-9]$/.test(id))) throw invalid('assignmentIds')
  return v.assignmentIds
}

export function parseResultBody(v: unknown): { id: string; state: AssignmentState; receiptId?: string; detail?: string; sessionID?: string }[] {
  if (!obj(v) || !Array.isArray(v.assignments) || v.assignments.length < 1 || v.assignments.length > WORK_CHAT_MAX_ASSIGNMENTS) throw invalid('assignments')
  return v.assignments.map((a: unknown) => {
    if (!obj(a) || typeof a.id !== 'string' || !/^a[1-9]$/.test(a.id)) throw invalid('assignments.id')
    if (!(ASSIGNMENT_STATES as readonly unknown[]).includes(a.state)) throw invalid('assignments.state')
    if (a.receiptId !== undefined && a.receiptId !== null && !(typeof a.receiptId === 'string' && RECEIPT_ID.test(a.receiptId))) throw invalid('assignments.receiptId')
    if (a.detail !== undefined && a.detail !== null && !str(a.detail, LENS_DETAIL_CHARS)) throw invalid('assignments.detail')
    if (a.sessionID !== undefined && a.sessionID !== null && !(typeof a.sessionID === 'string' && SID.test(a.sessionID))) throw invalid('assignments.sessionID')
    return { id: a.id, state: a.state, ...(a.receiptId ? { receiptId: a.receiptId } : {}), ...(typeof a.detail === 'string' ? { detail: a.detail } : {}),
      ...(a.sessionID ? { sessionID: a.sessionID } : {}) }
  })
}

/** The round as the lens reads it: state, never the prompts. */
export function roundView(r: LensRound) {
  const send = r.sends[r.sends.length - 1]
  const state: RoundState = send ? send.state : r.inHistory ? 'in_history' : 'recorded'
  return {
    roundId: r.roundId, workID: r.workID, state, inHistory: r.inHistory, autoSendCard: r.autoSendCard,
    assignments: r.assignments.map(a => ({ id: a.id, state: a.state, ...(a.reportedSessionID ?? a.sessionID ? { sessionID: a.reportedSessionID ?? a.sessionID } : {}),
      ...(a.receiptId ? { receiptId: a.receiptId } : {}), ...(a.detail ? { detail: a.detail } : {}) })),
    updatedAt: new Date(r.updatedAt).toISOString(),
  }
}

let shared: LensRoundStore | null = null
/** The process-wide store. Inside a test it is in memory only, so a test never reads or moves this Mac's data file. */
export function defaultLensRoundStore(): LensRoundStore {
  return shared ??= new LensRoundStore(process.env.VITEST || process.env.NODE_ENV === 'test' ? null : dataPath('work-lens-rounds.json'))
}
