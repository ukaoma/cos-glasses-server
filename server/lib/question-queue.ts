// X1 (Miles 2026-11-12 17:31, "a consistent way ... to access active questions that are in waiting and in queue"):
// ONE list of everything a session waits on him for, oldest first, built here once and served additively on
// GET /api/session-questions as `queue` and `queueCount`, so Control Web, the glasses and the Mac app list and
// count the same things. Present whatever the full-hold switches say: it is also how he finds a question that
// only the Mac's own dialog can answer.
//
// WHAT IS IN IT: questions COS holds (answerable here) or that wait at the Mac's dialog; tool approvals held or at
// the Mac (listed so they are found; answering them keeps every existing rule, `where` says which door); turn-end
// asks a row shows; and, for QUEUE_ANSWERED_KEEP_MS, what was just answered and on which surface, so a card can say
// "Answered on the glasses" instead of vanishing.
//
// PRIVACY: the only words are `line` (a question's first 80 characters, cleaned; an approval's existing summary;
// a turn-end ask's 80 characters) and a turn-end ask's reply labels, the same text the questions route, the
// session rows and the cards already carry to the same authenticated clients (the API token or the paired web
// session). With COS_WAITING_QUESTION_WORDS=0 a question's line is ''. Nothing here is logged.

import { questionRowText } from './full-hold.js'
import type { BrokerQueueSource, QueueSurface } from './permission-broker.js'
import type { AnsweredTurnAsk, QueueTurnAsk } from './turn-end-ask.js'

export const QUEUE_LINE_MAX = 80
/** Entries past this are dropped, oldest answered first, then oldest waiting. */
export const QUEUE_MAX = 64

export type QueueKind = 'question' | 'approval' | 'turn_end'

export interface QueueEntry {
  key: string
  sessionId: string
  /** The session's title as the session list last showed it, or null (the client uses its own). */
  title: string | null
  provider: 'claude' | 'codex'
  kind: QueueKind
  /** One line: the question, the approval's summary, or the turn-end ask. '' when words are off or unknown. */
  line: string
  askedAt: string
  /** `here`: answer it from COS now (`heldId` for questions and approvals; a turn-end ask by a reply). `mac`: only the Mac's dialog. */
  where: 'here' | 'mac'
  heldId: string | null
  deadlineAt: string | null
  /** A turn-end ask's reply labels (0 to 2); [] otherwise. */
  choices: string[]
  state: 'waiting' | 'answered'
  answeredBy: QueueSurface | null
  answeredAt: string | null
}

export interface QuestionQueue { queue: QueueEntry[]; queueCount: number }

export interface QueueInput {
  broker: readonly BrokerQueueSource[]
  turnEnd: readonly QueueTurnAsk[]
  turnEndAnswered: readonly AnsweredTurnAsk[]
  titleFor(sessionId: string): string | null
  /** COS_WAITING_QUESTION_WORDS. */
  words: boolean
}

function clip(text: string, max = QUEUE_LINE_MAX): string {
  const t = questionRowText(text).replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

const iso = (ms: number | null): string | null => ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString()

function safeTitle(titleFor: QueueInput['titleFor'], sessionId: string): string | null {
  try { return titleFor(sessionId) } catch { return null }
}

export function buildQuestionQueue(input: QueueInput): QuestionQueue {
  const entries: QueueEntry[] = []
  for (const s of input.broker) {
    const line = s.kind === 'question'
      ? (input.words && s.questions.length > 0 ? clip(s.questions[0]!.question) : '')
      : (s.approval ? clip(s.approval.summary) : '')
    entries.push({
      key: s.key, sessionId: s.sessionId, title: safeTitle(input.titleFor, s.sessionId), provider: s.provider, kind: s.kind,
      line, askedAt: iso(s.askedAt)!, where: s.where, heldId: s.heldId, deadlineAt: iso(s.deadlineAt), choices: [],
      state: s.state, answeredBy: s.answeredBy, answeredAt: iso(s.answeredAt),
    })
  }
  for (const a of input.turnEnd) {
    entries.push({
      key: `${a.sessionId}:turn_end:${a.stoppedAt}`, sessionId: a.sessionId, title: safeTitle(input.titleFor, a.sessionId), provider: 'claude',
      kind: 'turn_end', line: clip(a.ask), askedAt: iso(a.stoppedAt)!, where: 'here', heldId: null, deadlineAt: null,
      choices: [...a.choices], state: 'waiting', answeredBy: null, answeredAt: null,
    })
  }
  for (const a of input.turnEndAnswered) {
    entries.push({
      key: `${a.sessionId}:turn_end:${a.stoppedAt}`, sessionId: a.sessionId, title: safeTitle(input.titleFor, a.sessionId), provider: 'claude',
      kind: 'turn_end', line: clip(a.ask), askedAt: iso(a.stoppedAt)!, where: 'here', heldId: null, deadlineAt: null,
      choices: [], state: 'answered', answeredBy: a.by, answeredAt: iso(a.answeredAt),
    })
  }
  // One entry per key (a waiting and an answered copy of the same ask: the answered one wins).
  const byKey = new Map<string, QueueEntry>()
  for (const e of entries) {
    const had = byKey.get(e.key)
    if (!had || (had.state === 'waiting' && e.state === 'answered')) byKey.set(e.key, e)
  }
  let queue = [...byKey.values()].sort((a, b) => a.askedAt.localeCompare(b.askedAt) || a.key.localeCompare(b.key))
  if (queue.length > QUEUE_MAX) {
    const waiting = queue.filter(e => e.state === 'waiting')
    const answered = queue.filter(e => e.state === 'answered')
    const keepAnswered = Math.max(0, QUEUE_MAX - waiting.length)
    const keep = new Set([...waiting.slice(-QUEUE_MAX), ...answered.slice(answered.length - keepAnswered)])
    queue = queue.filter(e => keep.has(e))
  }
  return { queue, queueCount: queue.filter(e => e.state === 'waiting').length }
}
