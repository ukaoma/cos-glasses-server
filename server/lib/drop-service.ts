/**
 * Drop it P1 (plan sections 1 to 3 and 6): one drop in, filed or asked about, with a receipt in the pinned COS chat.
 *
 * Order of writes, so a drop is never lost: the drop and its chat line are saved first (state `routing`), then it is
 * routed, then the destination write, then the receipt. A restart that finds a drop still `routing` keeps it as a note.
 * A repeated dropId answers the first result; two concurrent posts of one dropId share one run.
 *
 * Undo lasts 24 hours and refuses with a reason when the item was edited since. Move is Undo, then filing where the
 * user picked, with no Jev call. Nothing is deleted: a new card is archived, a memory quarantined, a thread source
 * removed by its id, and the drop itself stays in History as undone.
 *
 * Logs carry ids, codes and lengths only (plan section 8). Nothing here imports the Messages store, so a drop never adds
 * a Messages row or moves the lens message counter (canary 11).
 */
import { randomBytes } from 'node:crypto'
import { DROP_DESTS, DROP_ID, DROP_LIMITS, DropStoreError, parseLink, type DropChoice, type DropDest, type DropKind, type DropLink, type DropRecord,
  type DropSource, type DropFileRef, type FeedAction, type FeedItem, type DropStore, type InboxFeedStore } from './drop-store.js'
import { choiceFor, cleanDropForJev, DROP_ROUTER_LIMITS, ruleRoute, type DropRouter, type DropTarget, type RouteOutcome } from './drop-router.js'
import { DropDestinationError, type DropWriters } from './drop-destinations.js'

export class DropError extends Error {
  constructor(readonly code: string, readonly status: number, message?: string) { super(message ?? code) }
}

export interface DropInput {
  dropId: string
  text: string
  source: DropSource
  hint?: { sessionId: string; label?: string }
  file?: DropFileRef
}
export interface DropView {
  id: string; text: string; source: DropSource; createdAt: string; updatedAt: string
  state: DropRecord['state']; dest: DropDest | null; kind: DropKind; status: HistoryStatus
  links: DropLink[]; choices?: DropChoice[]; route: DropRecord['route']; undoUntil: string | null
  canUndo: boolean; hold?: DropRecord['hold']; remind?: DropRecord['remind']; file?: DropFileRef
}
export interface DropAnswer { drop: DropView; items: FeedItem[]; replayed: boolean; next?: { kind: 'ask'; prompt: string } }
export type HistoryStatus = 'open' | 'in_progress' | 'done' | 'undone'
export interface AskLookup { status: string; response?: string; sessionId?: string }

export interface DropServiceDeps {
  drops: DropStore
  feed: InboxFeedStore
  router: Pick<DropRouter, 'route'>
  writers: DropWriters
  /** The existing Ask job, read by its client identity, for posting the answer into the chat. */
  askLookup?: (clientJobId: string, generation: number) => Promise<AskLookup | undefined>
  now?: () => Date
  timezone?: () => string
}

const TEXT_MAX = DROP_LIMITS.text
const ASK_WINDOW_MS = 6 * 60 * 60_000
const ANSWER_CHARS = 1_200
const short = (text: string, max = 60): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : one.slice(0, max - 1).trimEnd() + '…'
}
const feedId = () => `fi_${randomBytes(16).toString('hex')}`
const A = {
  undo: { id: 'undo', label: 'Undo' }, move: { id: 'move', label: 'Move' },
  openCard: { id: 'open_card', label: 'Open card' }, openThread: { id: 'open_thread', label: 'Open thread' },
  openMemory: { id: 'open_memory', label: 'Open memory' }, openSession: { id: 'open_session', label: 'Open session' },
  send: { id: 'send_to_session', label: 'Send to session' }, openMessages: { id: 'open_messages', label: 'Open in Messages' },
} as const

/** Why a drop is a note, in one line the chat shows. Codes stay in `route.reason`. */
export const NOTE_REASONS: Record<string, string> = {
  router_off: 'Automatic filing is off on this server.',
  redacted: 'It looked like it held a password or key, so it was not sent for filing.',
  jev_not_configured: 'Filing needs a TypeSafe key in Settings.',
  jev_key_rejected: 'TypeSafe did not accept the saved key. Check it in Settings.',
  jev_cap_reached: 'Filing has used today\'s budget. It resets at midnight UTC.',
  jev_breaker_open: 'Filing is paused for an hour after repeated failures.',
  jev_request_rejected: 'Jev refused this one.',
  jev_unavailable: 'COS could not reach Jev to file it.',
  jev_bad_answer: 'Jev gave an answer COS could not read.',
  destination_unavailable: 'Filing there needs a COS update on this Mac.',
  destination_failed: 'The place it was going did not accept it. Move it to try again.',
  memory_too_short: 'Memories need a full sentence, so this one is kept as a note.',
  interrupted: 'The server restarted while filing it.',
}

export class DropService {
  private readonly inflight = new Map<string, Promise<DropAnswer>>()
  private readonly busy = new Set<string>()
  private readonly now: () => Date
  constructor(private readonly deps: DropServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.recover()
  }

  // ── Intake ─────────────────────────────────────────────────────────

  /** Runs synchronously up to the first await, so the in-flight entry exists before a second post can look. */
  async submit(input: DropInput): Promise<DropAnswer> {
    const parsed = validateInput(input)
    const existing = this.deps.drops.get(parsed.dropId)
    if (existing && !this.inflight.has(parsed.dropId)) return this.answer(existing, true)
    const running = this.inflight.get(parsed.dropId)
    if (running) return running.then(a => ({ ...a, replayed: true }))
    const work = this.run(parsed).finally(() => this.inflight.delete(parsed.dropId))
    this.inflight.set(parsed.dropId, work)
    return work
  }

  private async run(input: DropInput): Promise<DropAnswer> {
    const at = this.now().toISOString()
    const fresh: DropRecord = {
      id: input.dropId, text: input.text, source: input.source, createdAt: at, updatedAt: at, state: 'routing', dest: null,
      kind: input.file ? 'file' : 'note', links: [], route: null, undoUntil: null, timeline: [{ at, state: 'routing' }],
      ...(input.hint ? { hint: { sessionId: input.hint.sessionId } } : {}), ...(input.file ? { file: input.file } : {}),
    }
    this.deps.drops.insert(fresh)
    this.deps.feed.insert([{ id: feedId(), kind: 'drop', threadId: fresh.id, createdAt: at, readAt: at, source: input.source,
      line: input.text, links: [], actions: [], state: 'live', key: `${fresh.id}:drop` }])
    // Before any rule (plan section 8): a drop that looks like it holds a password or key goes nowhere but the drop
    // store. Not to memory (the bridge embeds it), not to the Ask job, not to Jev.
    if (cleanDropForJev(input.text).tripped) return this.file(fresh, 'note', undefined, { by: 'fallback', reason: 'redacted' })
    const rule = ruleRoute(input.text)
    if (rule === 'ask') return this.asked(fresh)
    if (rule === 'reminder') return this.file(fresh, 'reminder', undefined, { by: 'rule' })
    if (rule === 'memory') return this.file(fresh, 'memory', undefined, { by: 'rule' })
    const session = input.hint ? { id: input.hint.sessionId, label: (input.hint.label ?? '').trim() || 'the open session' } : undefined
    let outcome: RouteOutcome
    try {
      const candidates = await this.deps.writers.candidates(input.text, session)
      outcome = await this.deps.router.route(input.text, candidates)
    } catch {
      outcome = { by: 'fallback', reason: 'jev_unavailable' }
    }
    if (outcome.by === 'fallback') return this.file(fresh, 'note', undefined, { by: 'fallback', reason: outcome.reason })
    const route = { by: 'jev' as const, p: round(outcome.decision.p), tokens: outcome.tokens, provider: outcome.provider }
    const clear = outcome.decision.clear
    if (outcome.decision.kind === 'ask') {
      const choices = outcome.decision.choices.map(c => c.dest === 'session' && session ? { ...c, target: { id: session.id, label: session.label } } : c)
      return this.question(fresh, choices, route, clear)
    }
    const decision = outcome.decision
    const target: DropTarget | undefined = decision.dest === 'session' && session ? { id: session.id, label: session.label } : decision.target
    return this.file(fresh, decision.dest, target, route, clear)
  }

  /** A question for the existing Ask job: the client submits it there and links the job back here. */
  private asked(drop: DropRecord): DropAnswer {
    const at = this.now().toISOString()
    const saved = this.deps.drops.update(drop.id, d => ({ ...d, state: 'asked', dest: 'ask', kind: 'ask', route: { by: 'rule' },
      undoUntil: null, timeline: [...d.timeline, { at, state: 'asked', dest: 'ask' }] }))
    this.receipt(saved, 'receipt', 'Asking COS', 'The answer lands here when it is ready.', [], [], 1)
    return { ...this.answer(saved, false), next: { kind: 'ask', prompt: saved.text } }
  }

  private question(drop: DropRecord, choices: DropChoice[], route: DropRecord['route'], clear: number): DropAnswer {
    const at = this.now().toISOString()
    const saved = this.deps.drops.update(drop.id, d => ({ ...d, state: 'asking', dest: null, kind: clear >= DROP_ROUTER_LIMITS.clear ? 'note' : 'idea',
      route, choices, undoUntil: new Date(Date.parse(at) + DROP_LIMITS.undoMs).toISOString(), timeline: [...d.timeline, { at, state: 'asking' }] }))
    const options = choices.filter(c => c.dest !== 'note')
    const title = options.length >= 2 ? `Is this ${reading(options[0])}, or ${reading(options[1])}?` : `Is this ${reading(options[0])}, or just a note?`
    const actions: FeedAction[] = choices.map(c => ({ id: `choose:${c.id}`, label: c.label }))
    this.receipt(saved, 'question', title, 'COS is not sure where this goes, so it is asking instead of guessing.', [], actions, 1)
    return this.answer(this.deps.drops.get(saved.id)!, false)
  }

  /**
   * File to one destination. A destination that cannot take it (a missing verb, a refusal) keeps a note with the
   * reason, never an error: the drop is already saved, and Move can try again.
   */
  private async file(drop: DropRecord, dest: DropDest, target: DropTarget | undefined, route: NonNullable<DropRecord['route']>,
                     clear = 0.5, generation = 1, movedFrom?: DropDest): Promise<DropAnswer> {
    let links: DropLink[] = []
    let hold: DropRecord['hold']
    let remind: DropRecord['remind']
    let actualDest = dest
    let reason = route.reason
    try {
      switch (dest) {
        case 'new_card': {
          if (!target?.domain) throw new DropDestinationError('destination_failed')
          const card = await this.deps.writers.captureCard(target.domain, drop.text, drop.id)
          links = [{ kind: 'card', id: card.workIdentity, label: target.label, domain: target.domain, created: card.created }]
          break
        }
        case 'existing_card':
          if (!target?.id || !target.domain) throw new DropDestinationError('destination_failed')
          links = [{ kind: 'card', id: target.id, label: target.label, domain: target.domain }]
          break
        case 'thread': {
          if (!target?.id) throw new DropDestinationError('destination_failed')
          const out = await this.deps.writers.sourceThread(target.id, drop.text, drop.id)
          links = [{ kind: 'thread', id: target.id, label: target.label, sourceId: out.sourceId, created: out.created }]
          break
        }
        case 'memory': {
          // A new capture key per filing, so a replay never answers with a row an earlier Undo set aside.
          const out = await this.deps.writers.captureMemory(drop.text, drop.id, String(generation))
          links = [{ kind: 'memory', id: out.id, label: 'To review', created: out.created }]
          break
        }
        case 'session':
          if (!target?.id) throw new DropDestinationError('destination_failed')
          hold = { sessionId: target.id, label: target.label }
          links = [{ kind: 'session', id: target.id, label: target.label }]
          break
        case 'reminder':
          // P1 keeps the reminder; its time and firing come with the parser and scheduler in P2 (plan section 7).
          remind = { at: null, tz: this.deps.timezone?.() ?? 'UTC', firedAt: null, ackAt: null, snoozes: 0 }
          links = [{ kind: 'reminder', id: drop.id, label: 'Reminder' }]
          break
        case 'note':
          break
        default:
          throw new DropDestinationError('destination_failed')
      }
    } catch (e) {
      if (!(e instanceof DropDestinationError)) throw e
      console.warn(`[drops] ${drop.id} ${dest} write failed: ${e.code}`)
      actualDest = 'note'; links = []; hold = undefined; remind = undefined
      route = { ...route, reason: e.code }; reason = e.code
    }
    const at = this.now().toISOString()
    const kind: DropKind = drop.file ? 'file' : kindFor(actualDest, clear)
    const saved = this.deps.drops.update(drop.id, d => {
      const next: DropRecord = { ...d, state: actualDest === 'session' ? 'held' : 'filed', dest: actualDest, kind, links, route,
        undoUntil: new Date(Date.parse(at) + DROP_LIMITS.undoMs).toISOString(),
        timeline: [...d.timeline, { at, state: actualDest === 'session' ? 'held' : 'filed', dest: actualDest, ...(reason ? { note: reason } : {}) }] }
      delete next.choices; delete next.hold; delete next.remind
      if (hold) next.hold = hold
      if (remind) next.remind = remind
      return next
    })
    console.log(`[drops] ${saved.id} filed dest=${actualDest} by=${route.by}${reason ? ` reason=${reason}` : ''} chars=${saved.text.length}`)
    const words = receiptWords(saved, actualDest, reason, movedFrom)
    this.receipt(saved, 'receipt', words.title, words.line, saved.links, words.actions, generation)
    return this.answer(this.deps.drops.get(saved.id)!, false)
  }

  private receipt(drop: DropRecord, kind: 'receipt' | 'question' | 'followup', title: string, line: string, links: DropLink[], actions: FeedAction[], generation: number): FeedItem {
    const at = this.now().toISOString()
    const [item] = this.deps.feed.insert([{ id: feedId(), kind, threadId: drop.id, createdAt: at,
      // Receipts are born read (plan section 1); a question and a follow-up count as unread on the pinned row.
      readAt: kind === 'receipt' ? at : null, source: 'cos', title, line, links, actions, state: 'live',
      ...(kind === 'receipt' && drop.undoUntil ? { undoUntil: drop.undoUntil } : {}), key: `${drop.id}:${kind}:${generation}` }])
    return item
  }

  /** The earlier live receipts and questions of a drop lose their buttons: only the newest one acts. */
  private retire(dropId: string): void {
    const ids = new Set(this.deps.feed.list().filter(i => i.threadId === dropId && i.kind !== 'drop' && i.state === 'live').map(i => i.id))
    if (ids.size) this.deps.feed.update(ids, item => ({ ...item, state: 'done', actions: [] }))
  }
  private nextGeneration(dropId: string): number {
    return this.deps.feed.list().filter(i => i.threadId === dropId && (i.kind === 'receipt' || i.kind === 'question')).length + 1
  }

  // ── Answering a question ───────────────────────────────────────────

  async choose(itemId: string, choiceId: string): Promise<DropAnswer> {
    const item = this.deps.feed.get(itemId)
    if (!item || item.kind !== 'question') throw new DropError('question_not_found', 404)
    return this.locked(item.threadId, async () => {
      const drop = this.mustGet(item.threadId)
      if (drop.state !== 'asking' || item.state !== 'live') return this.answer(drop, true)  // answered already: idempotent
      const choice = drop.choices?.find(c => c.id === choiceId)
      if (!choice) throw new DropError('invalid_choice', 400)
      const generation = this.nextGeneration(drop.id)
      this.retire(drop.id)
      const at = this.now().toISOString()
      this.deps.feed.insert([{ id: feedId(), kind: 'answer', threadId: drop.id, createdAt: at, readAt: at, source: drop.source,
        line: choice.label, links: [], actions: [], state: 'done', key: `${drop.id}:answer:${generation}` }])
      const target = choice.target ? { id: choice.target.id, label: choice.target.label, ...(choice.target.domain ? { domain: choice.target.domain } : {}) } : undefined
      const sessionTarget = choice.dest === 'session' && drop.hint && !target ? { id: drop.hint.sessionId, label: 'the open session' } : target
      return this.file(drop, choice.dest, sessionTarget, { by: 'user' }, drop.kind === 'idea' ? 0 : 1, generation)
    })
  }

  // ── Undo and Move ──────────────────────────────────────────────────

  async undo(dropId: string): Promise<DropAnswer> {
    return this.locked(dropId, async () => {
      const drop = this.mustGet(dropId)
      if (drop.state === 'undone') return this.answer(drop, true)
      const generation = this.nextGeneration(drop.id)
      await this.reverse(drop)
      const at = this.now().toISOString()
      const saved = this.deps.drops.update(drop.id, d => {
        const next: DropRecord = { ...d, state: 'undone', links: [], undoUntil: null, timeline: [...d.timeline, { at, state: 'undone' }] }
        delete next.hold; delete next.remind; delete next.choices
        return next
      })
      this.retire(drop.id)
      this.receipt(saved, 'receipt', 'Undone', undoLine(drop), [], [], generation)
      console.log(`[drops] ${drop.id} undone from=${drop.dest ?? drop.state}`)
      return this.answer(this.deps.drops.get(drop.id)!, false)
    })
  }

  /** Move: Undo, then file where the user picked, with no Jev call. */
  async move(dropId: string, to: { dest: DropDest; target?: DropTarget }): Promise<DropAnswer> {
    if (to.dest === 'ask' || !(DROP_DESTS as readonly string[]).includes(to.dest)) throw new DropError('invalid_move', 400)
    // Checked before anything is undone or written: a target the store would refuse must never leave a write unlinked.
    if (to.target) checkTarget(to.target)
    return this.locked(dropId, async () => {
      const drop = this.mustGet(dropId)
      if (drop.state === 'undone') throw new DropError('drop_undone', 409, 'This drop was undone.')
      if (to.dest === 'session' && !to.target?.id) throw new DropError('invalid_move', 400)
      if (to.dest === 'memory' && cleanDropForJev(drop.text).tripped) throw new DropError('redacted', 409, 'It looks like it holds a password or key, so it stays out of memories.')
      const generation = this.nextGeneration(drop.id)
      if (drop.state !== 'asking') await this.reverse(drop)
      else if (this.now().getTime() > Date.parse(drop.undoUntil ?? '')) throw new DropError('undo_expired', 409, 'Undo and Move last 24 hours.')
      this.retire(drop.id)
      const at = this.now().toISOString()
      const cleared = this.deps.drops.update(drop.id, d => {
        const next: DropRecord = { ...d, links: [], timeline: [...d.timeline, { at, state: d.state, note: 'moved' }] }
        delete next.hold; delete next.remind; delete next.choices
        return next
      })
      return this.file(cleared, to.dest, to.target, { by: 'user' }, cleared.kind === 'idea' ? 0 : 1, generation, drop.dest ?? undefined)
    })
  }

  /** Take back what filing wrote. Refuses (409) past 24 hours, for an answered ask, or when the item was edited. */
  private async reverse(drop: DropRecord): Promise<void> {
    if (drop.state === 'routing') throw new DropError('drop_busy', 409, 'This drop is still being filed.')
    if (drop.state === 'asked') throw new DropError('undo_not_available', 409, 'A question cannot be undone. The answer stays.')
    if (!drop.undoUntil || this.now().getTime() > Date.parse(drop.undoUntil)) throw new DropError('undo_expired', 409, 'Undo and Move last 24 hours.')
    // A sent hold has no undo window left (holdSent clears undoUntil), so the check above already refuses it.
    for (const link of drop.links) {
      // Something that was already there (same words on a card, a duplicate memory, a note already on the thread) is
      // only unlinked: Undo never archives or removes what this drop did not create.
      if (link.created === false) continue
      try {
        if (link.kind === 'card' && drop.dest === 'new_card') {
          const result = await this.deps.writers.archiveCard(link.domain ?? '', link.id, drop.id, drop.text)
          if (result === 'touched') throw new DropError('edited', 409, 'The card was changed since, so Undo leaves it alone.')
        } else if (link.kind === 'thread' && link.sourceId) {
          const result = await this.deps.writers.unsourceThread(link.id, link.sourceId, drop.id)
          if (result === 'touched') throw new DropError('edited', 409, 'The thread note was changed since, so Undo leaves it alone.')
        } else if (link.kind === 'memory') {
          const result = await this.deps.writers.pruneMemory(link.id, drop.id)
          if (result === 'touched') throw new DropError('edited', 409, 'The memory was reviewed since, so Undo leaves it alone.')
        }
      } catch (e) {
        if (e instanceof DropDestinationError) throw new DropError('undo_failed', 503, 'COS could not reach where it went. Try again.')
        throw e
      }
    }
  }

  // ── Session hold, asks ─────────────────────────────────────────────

  /** Control sent a held follow-up through the session's own path; the hold is spent. */
  async holdSent(dropId: string): Promise<DropAnswer> {
    return this.locked(dropId, async () => {
      const drop = this.mustGet(dropId)
      if (drop.state !== 'held' || !drop.hold) throw new DropError('not_held', 409)
      if (drop.hold.sentAt) return this.answer(drop, true)
      const at = this.now().toISOString()
      const saved = this.deps.drops.update(drop.id, d => ({ ...d, state: 'filed', hold: { ...d.hold!, sentAt: at }, undoUntil: null,
        timeline: [...d.timeline, { at, state: 'filed', dest: 'session', note: 'sent' }] }))
      const generation = this.nextGeneration(drop.id)
      this.retire(drop.id)
      this.receipt(saved, 'receipt', `Sent to ${saved.hold!.label}`, 'The session has it now.', saved.links, [A.openSession], generation)
      return this.answer(this.deps.drops.get(drop.id)!, false)
    })
  }

  async linkAsk(dropId: string, clientJobId: string, generation: number): Promise<DropAnswer> {
    if (!DROP_ID.test(clientJobId.toLowerCase()) || !Number.isSafeInteger(generation) || generation < 1) throw new DropError('invalid_ask_link', 400)
    return this.locked(dropId, async () => {
      const drop = this.mustGet(dropId)
      if (drop.dest !== 'ask') throw new DropError('not_a_question', 409)
      if (drop.ask && drop.ask.clientJobId === clientJobId.toLowerCase() && drop.ask.generation === generation) return this.answer(drop, true)
      if (drop.ask?.answeredAt) throw new DropError('already_answered', 409)
      const saved = this.deps.drops.update(drop.id, d => ({ ...d, ask: { clientJobId: clientJobId.toLowerCase(), generation },
        links: [{ kind: 'ask', id: clientJobId.toLowerCase(), label: 'Ask' }] }))
      return this.answer(saved, false)
    })
  }

  /**
   * Post finished answers into the chat, once each (key `<dropId>:followup:answer`). Read on demand by the feed and
   * summary routes; only asks linked within the last six hours are looked up.
   */
  async syncAsks(): Promise<number> {
    if (!this.deps.askLookup) return 0
    let posted = 0
    const cutoff = this.now().getTime() - ASK_WINDOW_MS
    for (const drop of this.deps.drops.list()) {
      if (drop.dest !== 'ask' || !drop.ask || drop.ask.answeredAt || Date.parse(drop.createdAt) < cutoff) continue
      let job: AskLookup | undefined
      try { job = await this.deps.askLookup(drop.ask.clientJobId, drop.ask.generation) } catch { continue }
      if (!job || !['completed', 'failed', 'canceled', 'interrupted'].includes(job.status)) continue
      const at = this.now().toISOString()
      const ok = job.status === 'completed' && !!job.response?.trim()
      const line = ok ? short(job.response!, ANSWER_CHARS) : 'The answer did not finish. Open it in Messages to try again.'
      const links: DropLink[] = job.sessionId && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(job.sessionId) ? [{ kind: 'session', id: job.sessionId, label: 'Messages' }] : []
      const before = this.deps.feed.byKey(`${drop.id}:followup:answer`)
      this.deps.feed.insert([{ id: feedId(), kind: 'followup', threadId: drop.id, createdAt: at, readAt: null, source: 'cos',
        title: `Re: ${short(drop.text)}`, line, links, actions: links.length ? [A.openMessages] : [], state: 'live', key: `${drop.id}:followup:answer` }])
      this.deps.drops.update(drop.id, d => ({ ...d, ask: { ...d.ask!, answeredAt: at } }))
      if (!before) posted++
    }
    return posted
  }

  // ── Reading ────────────────────────────────────────────────────────

  get(dropId: string): DropAnswer {
    const drop = this.deps.drops.get(dropId)
    if (!drop) throw new DropError('drop_not_found', 404)
    return this.answer(drop, false)
  }

  summary(): { unread: number; lastLine: string; lastAt: string | null; version: number } {
    const items = this.deps.feed.list()
    const unread = items.filter(i => i.readAt === null && (i.kind === 'ping' || i.kind === 'followup' || i.kind === 'question')).length
    const last = items[items.length - 1]
    return { unread, lastLine: last ? short(last.title && last.kind !== 'drop' ? `${last.title}. ${last.line}` : last.line, 120) : '', lastAt: last?.createdAt ?? null, version: this.deps.feed.version() }
  }

  /** The chat, oldest first. `after` is an item id: only items after it. */
  feed(options: { after?: string; limit?: number } = {}): { items: FeedItem[]; version: number; more: boolean } {
    const items = this.deps.feed.list()
    let start = 0
    if (options.after) {
      const index = items.findIndex(i => i.id === options.after)
      if (index < 0) throw new DropError('feed_item_not_found', 404)
      start = index + 1
    }
    const limit = Math.max(1, Math.min(200, options.limit ?? 100))
    const rest = items.slice(start)
    // Without `after` the newest page; with it, the next page forward.
    const page = options.after ? rest.slice(0, limit) : rest.slice(-limit)
    return { items: page, version: this.deps.feed.version(), more: options.after ? rest.length > limit : rest.length > limit }
  }

  /** The drop a chat item belongs to. */
  threadOf(itemId: string): string {
    const item = this.deps.feed.get(itemId)
    if (!item) throw new DropError('feed_item_not_found', 404)
    return item.threadId
  }

  markRead(through: string): { unread: number; version: number } {
    const items = this.deps.feed.list()
    const index = items.findIndex(i => i.id === through)
    if (index < 0) throw new DropError('feed_item_not_found', 404)
    const at = this.now().toISOString()
    const ids = new Set(items.slice(0, index + 1).filter(i => i.readAt === null).map(i => i.id))
    if (ids.size) this.deps.feed.update(ids, item => ({ ...item, readAt: at }))
    const s = this.summary()
    return { unread: s.unread, version: s.version }
  }

  /** History (plan section 6), P1: words over drop text and link labels, with kind and status filters, newest first. */
  async history(options: { q?: string; kind?: DropKind; status?: HistoryStatus; limit?: number; before?: string } = {}): Promise<{ drops: DropView[]; more: boolean; cardStates: 'read' | 'unavailable' | 'none' }> {
    let rows = this.deps.drops.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    if (options.before) {
      const index = rows.findIndex(r => r.id === options.before)
      if (index < 0) throw new DropError('drop_not_found', 404)
      rows = rows.slice(index + 1)
    }
    if (options.kind) rows = rows.filter(r => r.kind === options.kind)
    if (options.q) {
      const terms = options.q.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean)
      rows = rows.filter(r => {
        const hay = [r.text, ...r.links.map(l => l.label), r.hold?.label ?? '', r.file?.displayName ?? ''].join(' ').normalize('NFKC').toLowerCase()
        return terms.every(t => hay.includes(t))
      })
    }
    let cards: Map<string, { workStage: string; checked: boolean }> | null = null
    let cardStates: 'read' | 'unavailable' | 'none' = 'none'
    if (rows.some(r => r.links.some(l => l.kind === 'card'))) {
      try { cards = await this.deps.writers.cardStates(); cardStates = 'read' } catch { cardStates = 'unavailable' }
    }
    let views = rows.map(r => this.view(r, cards))
    if (options.status) views = views.filter(v => v.status === options.status)
    const limit = Math.max(1, Math.min(200, options.limit ?? 50))
    return { drops: views.slice(0, limit), more: views.length > limit, cardStates }
  }

  /** Releases both stores' writer locks (shutdown and tests). */
  close(): void { this.deps.drops.close(); this.deps.feed.close() }

  // ── Helpers ────────────────────────────────────────────────────────

  private answer(drop: DropRecord, replayed: boolean): DropAnswer {
    const items = this.deps.feed.list().filter(i => i.threadId === drop.id)
    return { drop: this.view(drop, null), items, replayed, ...(drop.dest === 'ask' && !drop.ask ? { next: { kind: 'ask' as const, prompt: drop.text } } : {}) }
  }

  private view(drop: DropRecord, cards: Map<string, { workStage: string; checked: boolean }> | null): DropView {
    return {
      id: drop.id, text: drop.text, source: drop.source, createdAt: drop.createdAt, updatedAt: drop.updatedAt, state: drop.state,
      dest: drop.dest, kind: drop.kind, status: statusOf(drop, cards), links: drop.links, ...(drop.choices ? { choices: drop.choices } : {}),
      route: drop.route, undoUntil: drop.undoUntil,
      canUndo: ['filed', 'held', 'asking'].includes(drop.state) && !!drop.undoUntil && this.now().getTime() <= Date.parse(drop.undoUntil) && !drop.hold?.sentAt,
      ...(drop.hold ? { hold: drop.hold } : {}), ...(drop.remind ? { remind: drop.remind } : {}), ...(drop.file ? { file: drop.file } : {}),
    }
  }

  private mustGet(id: string): DropRecord {
    if (!DROP_ID.test(id)) throw new DropError('invalid_drop_id', 400)
    const drop = this.deps.drops.get(id)
    if (!drop) throw new DropError('drop_not_found', 404)
    return drop
  }

  /** One change per drop at a time: a double tap gets 409 instead of two undos. */
  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(id) || this.inflight.has(id)) throw new DropError('drop_busy', 409, 'This drop is busy. Try again in a moment.')
    this.busy.add(id)
    try { return await fn() } finally { this.busy.delete(id) }
  }

  /** A drop left `routing` by a restart is kept as a note, with a receipt that says so. */
  private recover(): void {
    for (const drop of this.deps.drops.list()) {
      if (drop.state !== 'routing') continue
      const at = this.now().toISOString()
      const saved = this.deps.drops.update(drop.id, d => ({ ...d, state: 'filed', dest: 'note', kind: d.file ? 'file' : 'note',
        route: { by: 'fallback', reason: 'interrupted' }, undoUntil: new Date(Date.parse(at) + DROP_LIMITS.undoMs).toISOString(),
        timeline: [...d.timeline, { at, state: 'filed', dest: 'note', note: 'interrupted' }] }))
      const words = receiptWords(saved, 'note', 'interrupted')
      this.receipt(saved, 'receipt', words.title, words.line, [], words.actions, 1)
    }
  }
}

function validateInput(input: DropInput): DropInput {
  if (!input || typeof input !== 'object') throw new DropError('invalid_drop', 400)
  if (typeof input.dropId !== 'string' || !DROP_ID.test(input.dropId)) throw new DropError('invalid_drop_id', 400, 'dropId must be a lowercase UUID v4.')
  if (typeof input.text !== 'string') throw new DropError('invalid_text', 400)
  const text = input.text.replace(/\r\n?/g, '\n').trim()
  if (!text || [...text].length > TEXT_MAX || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new DropError('invalid_text', 400, `Text must be 1 to ${TEXT_MAX} characters.`)
  if (!['mac', 'web', 'g2', 'telegram'].includes(input.source)) throw new DropError('invalid_source', 400)
  const out: DropInput = { dropId: input.dropId, text, source: input.source }
  if (input.hint !== undefined) {
    const h = input.hint
    if (!h || typeof h.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(h.sessionId)
      || (h.label !== undefined && (typeof h.label !== 'string' || h.label.length > 200 || /[\x00-\x1f\x7f]/.test(h.label)))) throw new DropError('invalid_hint', 400)
    out.hint = { sessionId: h.sessionId, ...(h.label ? { label: h.label } : {}) }
  }
  if (input.file !== undefined) {
    const f = input.file
    if (!f || [f.store, f.key, f.fileID, f.displayName].some(v => typeof v !== 'string' || !v || v.length > 512 || /[\x00-\x1f\x7f]/.test(v))
      || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256) || f.store.length > 64 || f.fileID.length > 200 || f.displayName.length > 255) throw new DropError('invalid_file', 400)
    out.file = { store: f.store, key: f.key, fileID: f.fileID, sha256: f.sha256, displayName: f.displayName }
  }
  return out
}

/** Kinds are derived, never asked (plan section 2). */
export function kindFor(dest: DropDest, clear: number): DropKind {
  switch (dest) {
    case 'new_card': case 'existing_card': case 'session': return 'task'
    case 'memory': return 'memory'
    case 'reminder': return 'reminder'
    case 'ask': return 'ask'
    default: return clear >= DROP_ROUTER_LIMITS.clear ? 'note' : 'idea'
  }
}

function reading(choice: DropChoice): string {
  switch (choice.dest) {
    case 'new_card': return 'a task for you'
    case 'existing_card': return choice.target ? `an update to ${choice.target.label}` : 'an update to a card'
    case 'thread': return choice.target ? `a note on the ${choice.target.label} thread` : 'a note on a thread'
    case 'memory': return 'something to remember'
    case 'session': return 'a follow-up for the session'
    default: return 'a note'
  }
}

function receiptWords(drop: DropRecord, dest: DropDest, reason?: string, movedFrom?: DropDest): { title: string; line: string; actions: FeedAction[] } {
  const card = drop.links.find(l => l.kind === 'card'), thread = drop.links.find(l => l.kind === 'thread')
  const moved = movedFrom ? 'Moved. ' : ''
  switch (dest) {
    case 'new_card': return card?.created === false
      ? { title: `${moved}Already in Work, ${card.label}`, line: 'A card with these words was already there, so this links to it.', actions: [A.openCard, A.undo, A.move] }
      : { title: `${moved}Filed to Work, ${card?.label ?? 'Inbox'}`, line: 'New card in the Inbox.', actions: [A.openCard, A.undo, A.move] }
    case 'existing_card': return { title: `${moved}Added to ${card?.label ?? 'the card'}`, line: 'Linked to that card. No new card.', actions: [A.openCard, A.undo, A.move] }
    case 'thread': return { title: `${moved}Added to the ${thread?.label ?? ''} thread`.replace('the  thread', 'the thread'), line: 'It joins the thread for the next prep. No card.', actions: [A.openThread, A.undo, A.move] }
    case 'memory': return { title: `${moved}Saved to memories`, line: 'It waits in To review until you accept it.', actions: [A.openMemory, A.undo, A.move] }
    case 'session': return { title: `${moved}Held for ${drop.hold?.label ?? 'the session'}`, line: 'Send it to the session when you are ready.', actions: [A.send, A.undo, A.move] }
    case 'reminder': return { title: `${moved}Reminder saved`, line: 'Timed reminders come in the next update. It is in History.', actions: [A.undo, A.move] }
    default: {
      const word = drop.kind === 'idea' ? 'an idea' : drop.kind === 'file' ? 'a file note' : 'a note'
      const why = reason ? NOTE_REASONS[reason] ?? NOTE_REASONS.jev_unavailable : drop.route?.by === 'jev' ? 'Nothing else happens.' : 'Nothing else happens.'
      return { title: `${moved}Kept as ${word}`, line: why, actions: [A.undo, A.move] }
    }
  }
}

function undoLine(drop: DropRecord): string {
  switch (drop.dest) {
    case 'new_card': return 'The Work card is archived. Your words stay here.'
    case 'existing_card': return 'The link to the card is gone. The card is unchanged.'
    case 'thread': return 'The note is off the thread. Your words stay here.'
    case 'memory': return 'The memory is set aside. Your words stay here.'
    case 'session': return 'Nothing goes to the session. Your words stay here.'
    case 'reminder': return 'No reminder. Your words stay here.'
    default: return drop.state === 'asking' ? 'Nothing was filed. Your words stay here.' : 'The note is archived. Your words stay here.'
  }
}

export function statusOf(drop: DropRecord, cards: Map<string, { workStage: string; checked: boolean }> | null): HistoryStatus {
  if (drop.state === 'undone') return 'undone'
  if (drop.state === 'routing' || drop.state === 'asking' || drop.state === 'held') return 'open'
  if (drop.state === 'asked') return drop.ask?.answeredAt ? 'done' : 'in_progress'
  if (drop.dest === 'reminder') return drop.remind?.ackAt ? 'done' : 'open'
  const card = drop.links.find(l => l.kind === 'card')
  if (card) {
    const state = cards?.get(card.id)
    if (!state) return 'open'
    if (state.checked || state.workStage === 'complete') return 'done'
    return state.workStage === 'draft' || state.workStage === 'qa' ? 'in_progress' : 'open'
  }
  if (drop.dest === 'session') return drop.hold?.sentAt ? 'done' : 'open'
  return 'done'
}

const round = (n: number) => Math.round(n * 10_000) / 10_000
export { DropStoreError }
