// 6.78.0 (P3): the restart reconcile's verdict, the transcript evidence it reads, and the
// turns route's receipts. All pure; every read is injected.
import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_BACKDATE_MS,
  isReceiptRow,
  makeDeliveryEvidence,
  makeTurnReceiptLookup,
  reconcileVerdict,
  transcriptShowsPrompt,
  type ReconcileFacts,
} from './queue-turn-evidence.js'
import type { TurnAttempt, TurnAttemptLookup } from './agent-session-binding-registry.js'
import type { QueuedThreadTurn } from './thread-turn-queue.js'

const T0 = 1_790_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()
const attempt = (exit: TurnAttempt['exit'], over: Partial<TurnAttempt> = {}): TurnAttemptLookup =>
  ({ attempt: { bootId: 'boot-a', at: T0 + 1_000, mode: 'turn', exit, ...over }, evictedThrough: null })
const none: TurnAttemptLookup = { attempt: null, evictedThrough: null }

function facts(over: Partial<ReconcileFacts> = {}): ReconcileFacts {
  return {
    row: { queuedAt: T0, journal: 1 },
    ledgerOutcome: null,
    transcriptMatch: false,
    codexQueueMatch: false,
    attempt: none,
    ...over,
  }
}

describe('reconcileVerdict: the five-step order (plan v3.1 P3)', () => {
  it('1. a completed or queued ledger record, or an attempt that exited sent, is delivered', () => {
    expect(reconcileVerdict(facts({ ledgerOutcome: 'completed' }))).toBe('delivered')
    expect(reconcileVerdict(facts({ ledgerOutcome: 'queued' }))).toBe('delivered')
    expect(reconcileVerdict(facts({ attempt: attempt('sent') }))).toBe('delivered')
    // ...even on an unstamped or steer row: positive evidence wins.
    expect(reconcileVerdict(facts({ row: { queuedAt: T0 }, ledgerOutcome: 'completed' }))).toBe('delivered')
  })

  it('2. an exact transcript match is delivered, and upgrades an ambiguous ledger record', () => {
    expect(reconcileVerdict(facts({ transcriptMatch: true }))).toBe('delivered')
    expect(reconcileVerdict(facts({ transcriptMatch: true, ledgerOutcome: 'ambiguous' }))).toBe('delivered')
    expect(reconcileVerdict(facts({ transcriptMatch: true, row: { queuedAt: T0, journal: 1, mode: 'steer' } }))).toBe('delivered')
  })

  it('3. a Codex queue row with the same text is delivered', () => {
    expect(reconcileVerdict(facts({ codexQueueMatch: true }))).toBe('delivered')
  })

  it('4. an ambiguous ledger record without positive evidence is unknown, even with a not_sent attempt', () => {
    expect(reconcileVerdict(facts({ ledgerOutcome: 'ambiguous', attempt: attempt('not_sent') }))).toBe('unknown')
  })

  it('4. a legacy (unstamped) row reads unknown without positive evidence, never not_delivered', () => {
    expect(reconcileVerdict(facts({ row: { queuedAt: T0 } }))).toBe('unknown')
    expect(reconcileVerdict(facts({ row: { queuedAt: T0 }, attempt: attempt('not_sent') }))).toBe('unknown')
  })

  it('4. a steer row reads unknown without positive evidence, never not_delivered', () => {
    expect(reconcileVerdict(facts({ row: { queuedAt: T0, journal: 1, mode: 'steer' } }))).toBe('unknown')
    expect(reconcileVerdict(facts({ row: { queuedAt: T0, journal: 1, mode: 'steer' }, attempt: attempt('not_sent') }))).toBe('unknown')
  })

  it('4. an unreadable journal is unknown', () => {
    expect(reconcileVerdict(facts({ attempt: null }))).toBe('unknown')
  })

  it('5. not_delivered only for attempt not_sent, or a stamped turn row with no attempt at all', () => {
    expect(reconcileVerdict(facts({ attempt: attempt('not_sent') }))).toBe('not_delivered')
    expect(reconcileVerdict(facts({ attempt: none }))).toBe('not_delivered')
    expect(reconcileVerdict(facts({ attempt: attempt('pending') }))).toBe('unknown')
    expect(reconcileVerdict(facts({ attempt: attempt('unknown') }))).toBe('unknown')
  })

  it('5. an evicted key reads as unknown: the journal shed attempts at or after the row was queued', () => {
    expect(reconcileVerdict(facts({ attempt: { attempt: null, evictedThrough: T0 } }))).toBe('unknown')
    expect(reconcileVerdict(facts({ attempt: { attempt: null, evictedThrough: T0 + 5 } }))).toBe('unknown')
    // Shed entirely before this row existed: cannot have been this row's attempt.
    expect(reconcileVerdict(facts({ attempt: { attempt: null, evictedThrough: T0 - 1 } }))).toBe('not_delivered')
  })
})

describe('transcriptShowsPrompt: exact, wrapper-aware, after `since`', () => {
  const prompt = 'Also check the footer on mobile.'
  const peer = `Another Claude session sent a message:\n${prompt}\n\nThis came from another Claude session, not typed by your user.`
  const line = (row: Record<string, unknown>) => JSON.stringify(row)

  it('claude: a user row with the exact words, or the peer-wrapped words, after since', () => {
    expect(transcriptShowsPrompt('claude', [line({ type: 'user', timestamp: iso(T0 + 10), message: { role: 'user', content: prompt } })], prompt, T0)).toBe(true)
    expect(transcriptShowsPrompt('claude', [line({ type: 'user', isMeta: true, promptSource: 'system', timestamp: iso(T0 + 10), message: { role: 'user', content: [{ type: 'text', text: peer }] } })], prompt, T0)).toBe(true)
  })

  it('claude: an enqueue queue-operation and a queued_command attachment count', () => {
    expect(transcriptShowsPrompt('claude', [line({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(T0 + 10), content: prompt })], prompt, T0)).toBe(true)
    expect(transcriptShowsPrompt('claude', [line({ type: 'attachment', timestamp: iso(T0 + 10), attachment: { type: 'queued_command', prompt: peer, origin: { kind: 'peer' } } })], prompt, T0)).toBe(true)
  })

  it('never a prefix, a substring, an older row, a row without a time, or a tool result', () => {
    const user = (content: unknown, at: number | null = T0 + 10) => line({ type: 'user', ...(at === null ? {} : { timestamp: iso(at) }), message: { role: 'user', content } })
    expect(transcriptShowsPrompt('claude', [user('Also check the footer')], prompt, T0)).toBe(false)
    expect(transcriptShowsPrompt('claude', [user(`${prompt} And the header.`)], prompt, T0)).toBe(false)
    expect(transcriptShowsPrompt('claude', [user(prompt, T0 - 1)], prompt, T0)).toBe(false)
    expect(transcriptShowsPrompt('claude', [user(prompt, null)], prompt, T0)).toBe(false)
    expect(transcriptShowsPrompt('claude', [user([{ type: 'tool_result', content: prompt }])], prompt, T0)).toBe(false)
    // A row that carries a tool result is tool traffic, whatever text rides beside it: never
    // the person's turn. Erring to "no evidence" reads unknown, which is never resent.
    expect(transcriptShowsPrompt('claude', [user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }, { type: 'text', text: prompt }])], prompt, T0)).toBe(false)
    expect(transcriptShowsPrompt('claude', null, prompt, T0)).toBe(false)
    expect(transcriptShowsPrompt('claude', [user(prompt)], '   ', T0)).toBe(false)
  })

  it('codex: an event_msg user_message or a user response_item message', () => {
    expect(transcriptShowsPrompt('codex', [line({ type: 'event_msg', timestamp: iso(T0 + 10), payload: { type: 'user_message', message: prompt } })], prompt, T0)).toBe(true)
    expect(transcriptShowsPrompt('codex', [line({ type: 'response_item', timestamp: iso(T0 + 10), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } })], prompt, T0)).toBe(true)
    expect(transcriptShowsPrompt('codex', [line({ type: 'response_item', timestamp: iso(T0 + 10), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: prompt }] } })], prompt, T0)).toBe(false)
  })
})

describe('makeDeliveryEvidence: the real reads, a throw is unknown', () => {
  const turn = (over: Partial<QueuedThreadTurn> = {}): QueuedThreadTurn => ({
    clientTurnId: 'ct-evidence-1', cosSessionId: 'cos-1', provider: 'claude', threadId: 't-1', prompt: 'ship it',
    queuedAt: T0, status: 'delivering', attempts: 1, journal: 1, ...over,
  })

  it('reads the ledger outcome, the attempt and the transcript since the attempt began', async () => {
    let since = -1
    const evidence = makeDeliveryEvidence({
      ledgerOutcome: () => null,
      attempt: () => attempt('pending', { at: T0 + 5_000 }),
      transcriptLines: () => [JSON.stringify({ type: 'user', timestamp: iso(T0 + 5_000 - EVIDENCE_BACKDATE_MS + 1), message: { content: 'ship it' } })],
    })
    expect(await evidence(turn())).toBe('delivered')
    const before = makeDeliveryEvidence({
      ledgerOutcome: () => null,
      attempt: () => { since = T0 + 5_000; return attempt('pending', { at: T0 + 5_000 }) },
      transcriptLines: () => [JSON.stringify({ type: 'user', timestamp: iso(T0 + 5_000 - EVIDENCE_BACKDATE_MS - 1), message: { content: 'ship it' } })],
    })
    expect(await before(turn())).toBe('unknown')
    expect(since).toBe(T0 + 5_000)
  })

  it('a Codex queue listing with the same text is delivered; a throw anywhere is unknown', async () => {
    const codex = makeDeliveryEvidence({ ledgerOutcome: () => null, attempt: () => attempt('pending'), transcriptLines: () => [], codexQueueTexts: async () => ['  ship it '] })
    expect(await codex(turn({ provider: 'codex' }))).toBe('delivered')
    const throws = makeDeliveryEvidence({ ledgerOutcome: () => { throw new Error('ledger') }, attempt: () => none, transcriptLines: () => [] })
    expect(await throws(turn())).toBe('unknown')
    const listThrows = makeDeliveryEvidence({ ledgerOutcome: () => null, attempt: () => none, transcriptLines: () => [], codexQueueTexts: async () => { throw new Error('codex') } })
    expect(await listThrows(turn({ provider: 'codex' }))).toBe('unknown')
  })

  it('a stamped row with no attempt and no evidence is not_delivered; the ledger completed wins', async () => {
    expect(await makeDeliveryEvidence({ ledgerOutcome: () => null, attempt: () => none, transcriptLines: () => null })(turn())).toBe('not_delivered')
    expect(await makeDeliveryEvidence({ ledgerOutcome: () => 'completed', attempt: () => none, transcriptLines: () => null })(turn())).toBe('delivered')
  })
})

describe('receipts: settled queue rows and the attempt journal, never a waiting or delivering row', () => {
  const row = (status: QueuedThreadTurn['status'], over: Partial<QueuedThreadTurn> = {}): QueuedThreadTurn => ({
    clientTurnId: 'ct-receipt-1', cosSessionId: 'cos-1', provider: 'claude', threadId: 't-1', prompt: 'ship it',
    queuedAt: T0, status, attempts: 1, ...over,
  })

  it('isReceiptRow: delivered, or refused with an unknown outcome; nothing else', () => {
    expect(isReceiptRow({ status: 'delivered' })).toBe(true)
    expect(isReceiptRow({ status: 'refused', deliveryState: 'unknown' })).toBe(true)
    for (const status of ['waiting', 'delivering', 'refused', 'expired', 'cancelled'] as const) {
      expect(isReceiptRow({ status }), status).toBe(false)
    }
  })

  it('a delivering row (the drainer posting its own key) is NOT a receipt', () => {
    const lookup = makeTurnReceiptLookup({ queueRows: () => [row('delivering', { journal: 1 })], attempt: () => none, bootId: 'boot-a' })
    expect(lookup('claude', 't-1', 'ct-receipt-1', 'ship it')).toBeNull()
    const waiting = makeTurnReceiptLookup({ queueRows: () => [row('waiting')], attempt: () => none, bootId: 'boot-a' })
    expect(waiting('claude', 't-1', 'ct-receipt-1', 'ship it')).toBeNull()
  })

  it('settled rows: delivered replays delivered, refused-unknown replays unknown', () => {
    expect(makeTurnReceiptLookup({ queueRows: () => [row('delivered')], attempt: () => none, bootId: 'b' })('claude', 't-1', 'ct-receipt-1', 'x'))
      .toEqual({ kind: 'delivered', source: 'queue' })
    expect(makeTurnReceiptLookup({ queueRows: () => [row('refused', { deliveryState: 'unknown' })], attempt: () => none, bootId: 'b' })('claude', 't-1', 'ct-receipt-1', 'x'))
      .toEqual({ kind: 'unknown', source: 'queue' })
  })

  it('attempts: sent is delivered; unknown or a dead boot pending is unknown; this boot pending and not_sent are not receipts', () => {
    const at = (a: TurnAttemptLookup) => makeTurnReceiptLookup({ queueRows: () => [], attempt: () => a, bootId: 'boot-a' })('claude', 't-1', 'ct-receipt-1', 'ship it')
    expect(at(attempt('sent'))).toEqual({ kind: 'delivered', source: 'attempt' })
    expect(at(attempt('unknown'))).toEqual({ kind: 'unknown', source: 'attempt' })
    expect(at(attempt('pending', { bootId: 'boot-dead' }))).toEqual({ kind: 'unknown', source: 'attempt' })
    expect(at(attempt('pending', { bootId: 'boot-a' }))).toBeNull()
    expect(at(attempt('not_sent'))).toBeNull()
    expect(at(none)).toBeNull()
  })

  it('an unknown attempt the transcript now shows is delivered (a late acceptance row)', () => {
    const lookup = makeTurnReceiptLookup({
      queueRows: () => [],
      attempt: () => attempt('unknown'),
      transcriptLines: () => [JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(T0 + 2_000), content: 'ship it' })],
      bootId: 'boot-a',
    })
    expect(lookup('claude', 't-1', 'ct-receipt-1', 'ship it')).toEqual({ kind: 'delivered', source: 'transcript' })
    expect(lookup('claude', 't-1', 'ct-receipt-1', 'something else')).toEqual({ kind: 'unknown', source: 'attempt' })
  })
})
