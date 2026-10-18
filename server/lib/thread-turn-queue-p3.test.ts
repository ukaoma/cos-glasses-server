// 6.78.0 (P3, Sessions): the pure rules in thread-turn-queue.ts and provider-actions.ts.
//
// Flags are read at CALL time, so every case sets and restores process.env itself.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  pruneQueue,
  pinBootReapEnabled,
  queueReconcileEnabled,
  queueResendEnabled,
  queuedTurnReasonCopy,
  queuedTurnReasonCopyKeys,
  QUEUED_TURN_REASON_COPY_MAX,
  sessionSteerAvailability,
  sessionSteerEnabled,
  UNKNOWN_DELIVERY_RETENTION_MS,
  type QueuedThreadTurn,
} from './thread-turn-queue.js'
import { liveProviderActInput, providerActs, providerActSections } from './provider-actions.js'

const FLAGS = ['COS_QUEUE_RECONCILE', 'COS_PIN_BOOT_REAP', 'COS_QUEUE_RESEND', 'COS_SESSION_STEER', 'COS_CONTINUE_LIVE'] as const
const saved: Record<string, string | undefined> = Object.fromEntries(FLAGS.map(k => [k, process.env[k]]))
afterEach(() => {
  for (const k of FLAGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
})

describe('6.78.0 flags are tri-state and read per call', () => {
  const cases: Array<[string, () => boolean, boolean]> = [
    ['COS_QUEUE_RECONCILE', () => queueReconcileEnabled(), true],
    ['COS_PIN_BOOT_REAP', () => pinBootReapEnabled(), true],
    ['COS_QUEUE_RESEND', () => queueResendEnabled(), true],
    ['COS_SESSION_STEER', () => sessionSteerEnabled(), false],
  ]
  for (const [name, read, fallback] of cases) {
    it(`${name}: '1' on, '0' off, anything else the default (${fallback ? 'on' : 'off'})`, () => {
      delete process.env[name]
      expect(read()).toBe(fallback)
      process.env[name] = '1'
      expect(read()).toBe(true)
      process.env[name] = '0'
      expect(read()).toBe(false)
      process.env[name] = 'true'
      expect(read()).toBe(fallback)
      process.env[name] = ''
      expect(read()).toBe(fallback)
    })
  }

  it('every new flag is forwarded by the managed runtime contract', () => {
    const contract = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')) as { optionalEnvironment: string[] }
    for (const key of ['COS_QUEUE_RECONCILE', 'COS_PIN_BOOT_REAP', 'COS_QUEUE_RESEND', 'COS_SESSION_STEER']) {
      expect(contract.optionalEnvironment, key).toContain(key)
    }
  })

  it('every new flag is documented, commented out, in .env.example', () => {
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')
    for (const key of ['COS_QUEUE_RECONCILE', 'COS_PIN_BOOT_REAP', 'COS_QUEUE_RESEND', 'COS_SESSION_STEER']) {
      expect(example, key).toMatch(new RegExp(`^# ${key}=`, 'm'))
    }
  })
})

describe('queuedTurnReasonCopy: server-authored, one lens line', () => {
  it('every line fits 62 columns and uses no em dash, arrow or unsupported glyph', () => {
    expect(QUEUED_TURN_REASON_COPY_MAX).toBe(62)
    const keys = queuedTurnReasonCopyKeys()
    expect(keys.length).toBeGreaterThan(10)
    for (const key of keys) {
      const copy = queuedTurnReasonCopy(key)!
      expect(copy.length, key).toBeLessThanOrEqual(62)
      expect(copy, key).not.toMatch(/[—–→←⇒✓]/)
    }
  })

  it('the unknown outcome reads as the contract line; a raw or absent reason has no copy', () => {
    const unknown = 'May not have been sent. Read it, then say it again.'
    expect(queuedTurnReasonCopy('delivery_unknown_after_restart')).toBe(unknown)
    expect(queuedTurnReasonCopy('steer_unverified')).toBe(unknown)
    expect(queuedTurnReasonCopy('delivery_ambiguous')).toBe(unknown)
    expect(queuedTurnReasonCopy('some_new_reason')).toBeNull()
    expect(queuedTurnReasonCopy(undefined)).toBeNull()
    expect(queuedTurnReasonCopy('')).toBeNull()
    expect(queuedTurnReasonCopy('__proto__')).toBeNull()
  })
})

describe('pruneQueue keeps an unknown outcome for six hours (COS_QUEUE_RECONCILE)', () => {
  const row = (over: Partial<QueuedThreadTurn>): QueuedThreadTurn => ({
    clientTurnId: 'ct-p3-prune', cosSessionId: 'cos-1', provider: 'claude', threadId: 't', prompt: 'p',
    queuedAt: 0, status: 'refused', attempts: 1, settledAt: 0, ...over,
  })
  const at = 60 * 60 * 1000 // one hour after settling

  it('a refused row with deliveryState unknown, or an unknown reason, survives past 30 minutes', () => {
    delete process.env.COS_QUEUE_RECONCILE
    expect(UNKNOWN_DELIVERY_RETENTION_MS).toBe(6 * 60 * 60 * 1000)
    expect(pruneQueue([row({ deliveryState: 'unknown', reason: 'delivery_unknown_after_restart' })], at)).toHaveLength(1)
    expect(pruneQueue([row({ reason: 'steer_unverified' })], at)).toHaveLength(1)
    expect(pruneQueue([row({ reason: 'delivery_ambiguous' })], at)).toHaveLength(1)
    // ...and is gone after six hours.
    expect(pruneQueue([row({ deliveryState: 'unknown', reason: 'delivery_unknown_after_restart' })], UNKNOWN_DELIVERY_RETENTION_MS)).toHaveLength(0)
  })

  it('an ordinary settled row still goes at 30 minutes, and the flag off restores the 6.77 rule', () => {
    delete process.env.COS_QUEUE_RECONCILE
    expect(pruneQueue([row({ reason: 'delivery_attempts_exhausted' })], at)).toHaveLength(0)
    process.env.COS_QUEUE_RECONCILE = '0'
    expect(pruneQueue([row({ deliveryState: 'unknown', reason: 'delivery_unknown_after_restart' })], at)).toHaveLength(0)
  })
})

describe('sessionSteerAvailability: one rule for the attach field and the POST', () => {
  const base = { provider: 'claude', gateReason: 'native_thread_working', continueLive: true, peerInbox: true, waitingOnPrompt: false }

  it('a busy Claude desk session with an open inbox can be steered', () => {
    expect(sessionSteerAvailability(base)).toEqual({ available: true, mode: 'peer_inbox' })
    expect(sessionSteerAvailability({ ...base, gateReason: 'live_desktop_process' })).toEqual({ available: true, mode: 'peer_inbox' })
  })

  it('Codex has no outside channel; Cursor is an engine limit', () => {
    expect(sessionSteerAvailability({ ...base, provider: 'codex' })).toEqual({ available: false, reason: 'no_outside_channel' })
    expect(sessionSteerAvailability({ ...base, provider: 'cursor' })).toEqual({ available: false, reason: 'engine_limit' })
  })

  it('needs the live hop (COS_CONTINUE_LIVE): off is no outside channel', () => {
    expect(sessionSteerAvailability({ ...base, continueLive: false })).toEqual({ available: false, reason: 'no_outside_channel' })
  })

  it('falls back when the session is held on a permission prompt', () => {
    expect(sessionSteerAvailability({ ...base, waitingOnPrompt: true })).toEqual({ available: false, reason: 'permission_pending' })
  })

  it('needs a peer inbox, and a desk run: COS busy, a fence, or no verdict cannot be steered', () => {
    expect(sessionSteerAvailability({ ...base, peerInbox: false })).toEqual({ available: false, reason: 'no_outside_channel' })
    for (const gateReason of ['native_target_busy', 'native_turn_in_progress', 'native_target_fenced', 'probe_failed', null]) {
      expect(sessionSteerAvailability({ ...base, gateReason }), String(gateReason)).toEqual({ available: false, reason: 'no_outside_channel' })
    }
  })
})

describe('act.steer on health and models (COS_SESSION_STEER)', () => {
  const input = { attachEnabled: true, forkProviders: ['claude', 'codex', 'cursor'], sessionCancel: {}, brokerEnabled: true, continueLive: true, codexLiveQueue: true }
  const EIGHT = ['approvals', 'cancelDesk', 'continueBusy', 'continueIdle', 'fork', 'keepModel', 'nativeQueue', 'permissions']

  it('flag off: no `steer` key on any provider, the eight 6.62 keys only', () => {
    const acts = providerActs(input)
    for (const p of ['claude', 'codex', 'cursor'] as const) expect(Object.keys(acts[p]).sort()).toEqual(EIGHT)
    delete process.env.COS_SESSION_STEER
    expect('sessionSteer' in liveProviderActInput({ attachEnabled: true, forkProviders: [], sessionCancel: {} })).toBe(false)
  })

  it('flag on: claude peer_inbox, codex no_outside_channel, cursor engine_limit', () => {
    const acts = providerActs({ ...input, sessionSteer: true })
    expect(acts.claude.steer).toEqual({ supported: true, mode: 'peer_inbox' })
    expect(acts.codex.steer).toEqual({ supported: false, reason: 'no_outside_channel' })
    expect(acts.cursor.steer).toEqual({ supported: false, reason: 'engine_limit' })
    expect(providerActs({ ...input, sessionSteer: true, continueLive: false }).claude.steer).toEqual({ supported: false, reason: 'no_outside_channel' })
    expect(providerActs({ ...input, sessionSteer: true, attachEnabled: false }).claude.steer).toEqual({ supported: false, reason: 'attach_disabled' })
  })

  it('the live input reads the flag: on puts steer in every section', () => {
    process.env.COS_SESSION_STEER = '1'
    const sections = providerActSections(liveProviderActInput({ attachEnabled: true, forkProviders: [], sessionCancel: {} }))
    for (const p of ['claude', 'codex', 'cursor'] as const) expect(sections[p].act.steer).toBeDefined()
  })
})
