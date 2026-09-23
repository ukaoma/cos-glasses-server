// The cancel decision (6.53.0), the queue hold it leaves behind, and its ledger. The route
// and the attachability field are exercised through HTTP in agent-session-bindings.test.ts;
// this file pins the pure rules both of them call.

import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CANCEL_QUEUE_HOLD_MS,
  CLIENT_CANCEL_ID_RE,
  __resetThreadCancelsForTests,
  appendSessionCancelLedger,
  cancelEndsTurn,
  cancelHoldUntil,
  cancelRefusalCopy,
  cancelTargetFor,
  cancelVoidsOpenTurn,
  noteThreadCancelled,
  sessionCancelFeature,
  threadCancel,
  threadCancelledAt,
  type CancelFacts,
} from './session-cancel.js'

const SID = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const base: CancelFacts = { provider: 'claude', cosTurnInFlight: false, runningOutsideCos: true, hooksEnabled: true, hooksReady: true }

describe('cancelTargetFor', () => {
  it('a COS turn in flight wins over everything, for every provider', () => {
    for (const provider of ['claude', 'codex', 'cursor']) {
      expect(cancelTargetFor({ ...base, provider, cosTurnInFlight: true, hooksEnabled: false, hooksReady: false })).toBe('cos_turn')
      expect(cancelTargetFor({ ...base, provider, cosTurnInFlight: true, runningOutsideCos: false })).toBe('cos_turn')
    }
  })

  it('nothing running is null, whatever the hooks say', () => {
    expect(cancelTargetFor({ ...base, runningOutsideCos: false })).toBeNull()
    expect(cancelTargetFor({ ...base, provider: 'codex', runningOutsideCos: false })).toBeNull()
  })

  it('Codex and Cursor outside COS are unsupported, even with hooks ready', () => {
    expect(cancelTargetFor({ ...base, provider: 'codex' })).toBe('unsupported')
    expect(cancelTargetFor({ ...base, provider: 'cursor' })).toBe('unsupported')
  })

  it('a desk Claude run needs the hooks applied, then the new script, in that order', () => {
    expect(cancelTargetFor({ ...base, hooksEnabled: false, hooksReady: false })).toBe('hooks_disabled')
    expect(cancelTargetFor({ ...base, hooksEnabled: false })).toBe('hooks_disabled')
    expect(cancelTargetFor({ ...base, hooksReady: false })).toBe('hooks_outdated')
    expect(cancelTargetFor(base)).toBe('desk_run')
  })

  it('only a literal true counts: a malformed fact is the cautious answer', () => {
    expect(cancelTargetFor({ ...base, cosTurnInFlight: 1 as unknown as boolean, runningOutsideCos: false })).toBeNull()
    expect(cancelTargetFor({ ...base, hooksReady: 'yes' as unknown as boolean })).toBe('hooks_outdated')
  })
})

describe('the copy the lens shows', () => {
  it('matches the app 6.9.529 strings, and names the app for an unsupported run', () => {
    expect(cancelRefusalCopy('not_running', 'claude')).toBe('Nothing running now.')
    expect(cancelRefusalCopy('hooks_outdated', 'claude')).toBe('Install hooks in COS Control, then retry.')
    expect(cancelRefusalCopy('hooks_disabled', 'claude')).toBe('Session hooks are off on the Mac.')
    expect(cancelRefusalCopy('cancel_unsupported', 'codex')).toBe('Runs in Codex on your Mac. Stop it there.')
    expect(cancelRefusalCopy('cancel_unsupported', 'cursor')).toBe('Runs in Cursor on your Mac. Stop it there.')
    expect(cancelRefusalCopy('cancel_failed', 'claude')).toBe('Could not cancel. Check the Mac.')
  })

  it('accepts the app\'s ids and refuses anything path-shaped', () => {
    expect(CLIENT_CANCEL_ID_RE.test('ccmfu2x9k3abc123')).toBe(true)
    expect(CLIENT_CANCEL_ID_RE.test('9f0e8d7c-0000-4000-8000-000000000001')).toBe(true)
    for (const bad of ['', 'cc', 'cc/../x', '-cc12345', 'cc 1234', 'x'.repeat(200)]) expect(CLIENT_CANCEL_ID_RE.test(bad)).toBe(false)
  })
})

describe('the queue hold a cancel leaves behind', () => {
  afterEach(() => { __resetThreadCancelsForTests() })

  it('holds the thread for two minutes from the cancel, by provider and lower-cased id', () => {
    expect(cancelHoldUntil('claude', SID)).toBeNull()
    noteThreadCancelled('claude', SID.toUpperCase(), 1_000)
    expect(threadCancelledAt('claude', SID)).toBe(1_000)
    expect(cancelHoldUntil('claude', SID)).toBe(1_000 + CANCEL_QUEUE_HOLD_MS)
    expect(CANCEL_QUEUE_HOLD_MS).toBe(120_000)
    expect(cancelHoldUntil('codex', SID)).toBeNull()
    // A later cancel moves it.
    noteThreadCancelled('claude', SID, 5_000)
    expect(threadCancelledAt('claude', SID)).toBe(5_000)
    // A clock that cannot be read records nothing.
    noteThreadCancelled('claude', SID, Number.NaN)
    expect(threadCancelledAt('claude', SID)).toBe(5_000)
  })

  it('stays bounded', () => {
    for (let i = 0; i < 400; i++) noteThreadCancelled('claude', `a4b2b4dd-e40c-4b08-8a11-${String(i).padStart(12, '0')}`, 10_000_000 + i)
    expect(threadCancelledAt('claude', `a4b2b4dd-e40c-4b08-8a11-${String(399).padStart(12, '0')}`)).toBe(10_000_399)
    expect(threadCancelledAt('claude', `a4b2b4dd-e40c-4b08-8a11-${String(0).padStart(12, '0')}`)).toBeNull()
  })

  it('a cancel ends a turn only when nothing was written after it', () => {
    expect(cancelEndsTurn(null, 1_000)).toBe(false)
    expect(cancelEndsTurn(2_000, 1_000)).toBe(true)
    expect(cancelEndsTurn(2_000, 2_000)).toBe(true)
    // A row after the cancel is live evidence again.
    expect(cancelEndsTurn(2_000, 2_001)).toBe(false)
    // No row time at all: nothing contradicts the cancel.
    expect(cancelEndsTurn(2_000, null)).toBe(true)
    expect(cancelEndsTurn(Number.NaN, 1_000)).toBe(false)
  })
})

describe('the ledger', () => {
  it('appends one private JSON line per cancel', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cos-cancel-ledger-')), '.cos-glasses', 'data', 'session-cancel.jsonl')
    appendSessionCancelLedger({ at: '2026-09-21T23:00:00.000Z', provider: 'claude', threadId: SID, target: 'desk_run', outcome: 'accepted', clientCancelId: 'cc-1' }, path)
    appendSessionCancelLedger({ at: '2026-09-21T23:00:01.000Z', provider: 'codex', threadId: SID, target: null, outcome: 'not_running', clientCancelId: 'cc-2' }, path)
    const rows = readFileSync(path, 'utf-8').trim().split('\n').map(line => JSON.parse(line))
    expect(rows.map(r => r.outcome)).toEqual(['accepted', 'not_running'])
    expect(rows[0]).toEqual({ at: '2026-09-21T23:00:00.000Z', provider: 'claude', threadId: SID, target: 'desk_run', outcome: 'accepted', clientCancelId: 'cc-1' })
    expect(statSync(path).mode & 0o077).toBe(0)
  })

  it('a ledger that cannot be written never throws into the cancel', () => {
    expect(() => appendSessionCancelLedger({ at: 'x', provider: 'claude', threadId: SID, target: null, outcome: 'not_running', clientCancelId: 'cc-3' }, '/dev/null/nope/session-cancel.jsonl')).not.toThrow()
  })
})

describe('features.sessionCancel', () => {
  it('a COS turn is always cancellable; a desk run only with the hooks applied AND installed', () => {
    expect(sessionCancelFeature(true, true)).toEqual({ cosTurn: true, deskClaude: true })
    expect(sessionCancelFeature(true, false)).toEqual({ cosTurn: true, deskClaude: false })
    expect(sessionCancelFeature(false, true)).toEqual({ cosTurn: true, deskClaude: false })
    expect(sessionCancelFeature(false, false)).toEqual({ cosTurn: true, deskClaude: false })
  })
})

// 6.53.3 (review A1): a cancel remembers what it was aimed at, and only a COS turn's silence
// ends its turn. A desk run inside a long tool writes nothing for minutes and still runs.
describe('what a cancel may conclude about a turn that still reads open (6.53.3)', () => {
  afterEach(() => __resetThreadCancelsForTests())

  it('the target is remembered with the time, per thread, case-blind', () => {
    noteThreadCancelled('claude', SID.toUpperCase(), 5_000, 'desk_run')
    expect(threadCancel('claude', SID)).toEqual({ at: 5_000, target: 'desk_run' })
    expect(threadCancelledAt('claude', SID)).toBe(5_000)
    noteThreadCancelled('claude', SID, 6_000, 'cos_turn')
    expect(threadCancel('claude', SID)).toEqual({ at: 6_000, target: 'cos_turn' })
    // An older caller that names no target is recorded as such.
    noteThreadCancelled('codex', SID, 7_000)
    expect(threadCancel('codex', SID)).toEqual({ at: 7_000, target: null })
    expect(threadCancel('cursor', SID)).toBeNull()
  })

  it('cos_turn: 6.53.0\'s rule exactly, nothing written since the cancel ends the turn', () => {
    const cancel = { at: 2_000, target: 'cos_turn' as const }
    expect(cancelVoidsOpenTurn({ cancel, lastActivityAt: 1_000, turnStartedAt: 500, deskEndedAt: null })).toBe(true)
    expect(cancelVoidsOpenTurn({ cancel, lastActivityAt: 2_000, turnStartedAt: 500, deskEndedAt: null })).toBe(true)
    expect(cancelVoidsOpenTurn({ cancel, lastActivityAt: 2_001, turnStartedAt: 500, deskEndedAt: null })).toBe(false)
    expect(cancelVoidsOpenTurn({ cancel, lastActivityAt: null, turnStartedAt: null, deskEndedAt: null })).toBe(true)
  })

  it('desk_run: silence proves nothing; only the desk\'s own end, at or after the cancel and the turn\'s start, does', () => {
    const cancel = { at: 2_000, target: 'desk_run' as const }
    // THE BUG: a run inside a long tool. Nothing since the cancel, and it is still running.
    expect(cancelVoidsOpenTurn({ cancel, lastActivityAt: 1_000, turnStartedAt: 500, deskEndedAt: null })).toBe(false)
    expect(cancelVoidsOpenTurn({ cancel, lastActivityAt: null, turnStartedAt: null, deskEndedAt: null })).toBe(false)
    // An end from BEFORE the cancel is the previous turn's.
    expect(cancelVoidsOpenTurn({ cancel, lastActivityAt: 1_000, turnStartedAt: 500, deskEndedAt: 1_999 })).toBe(false)
    // The halt took: the registry flipped idle after the cancel.
    expect(cancelVoidsOpenTurn({ cancel, lastActivityAt: 1_000, turnStartedAt: 500, deskEndedAt: 2_000 })).toBe(true)
    expect(cancelVoidsOpenTurn({ cancel, lastActivityAt: 2_500, turnStartedAt: 500, deskEndedAt: 3_000 })).toBe(true)
    // A NEW prompt after that end is a live turn again.
    expect(cancelVoidsOpenTurn({ cancel, lastActivityAt: 4_000, turnStartedAt: 3_500, deskEndedAt: 3_000 })).toBe(false)
    expect(cancelVoidsOpenTurn({ cancel, lastActivityAt: 4_000, turnStartedAt: null, deskEndedAt: 3_000 })).toBe(true)
  })

  it('an unnamed or unsupported target concludes as little as a desk run; no cancel concludes nothing', () => {
    for (const target of [null, 'unsupported' as const]) {
      const cancel = { at: 2_000, target }
      expect(cancelVoidsOpenTurn({ cancel, lastActivityAt: 1_000, turnStartedAt: 500, deskEndedAt: null })).toBe(false)
      expect(cancelVoidsOpenTurn({ cancel, lastActivityAt: 1_000, turnStartedAt: 500, deskEndedAt: 2_500 })).toBe(true)
    }
    expect(cancelVoidsOpenTurn({ cancel: null, lastActivityAt: 1_000, turnStartedAt: 500, deskEndedAt: 9_000 })).toBe(false)
    expect(cancelVoidsOpenTurn({ cancel: { at: Number.NaN, target: 'cos_turn' }, lastActivityAt: 1, turnStartedAt: 1, deskEndedAt: 9 })).toBe(false)
    expect(cancelVoidsOpenTurn({ cancel: { at: 2_000, target: 'desk_run' }, lastActivityAt: 1, turnStartedAt: 1, deskEndedAt: Number.NaN })).toBe(false)
  })
})
