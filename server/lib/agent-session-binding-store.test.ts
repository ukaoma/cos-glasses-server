import { describe, it, expect } from 'vitest'
import {
  activate,
  assertUsable,
  beginDetach,
  BINDABLE_PROVIDERS,
  boundToMarker,
  canDetach,
  carriesBoundTo,
  checkQueuedPrompt,
  createBinding,
  detach,
  forceDetach,
  isPinned,
  isTerminal,
  isExpired,
  pin,
  renew,
  targetKey,
  unpin,
  verifyBoundTo,
  type BindingState,
  type NativeBinding,
} from './agent-session-binding-store'

const THREAD = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const OTHER = '019fc80a-cc79-7921-8541-298e71695afd'
const NOW = 1_786_845_785_997
const TTL = 15 * 60 * 1000

function make(over: Partial<Parameters<typeof createBinding>[0]> = {}): NativeBinding {
  const r = createBinding({
    bindingId: 'bind-1',
    cosSessionId: 'cos-1',
    provider: 'claude',
    nativeThreadId: THREAD,
    workspaceFingerprint: 'wsfp',
    sourceFingerprint: 'srcfp',
    ttlMs: TTL,
    now: NOW,
    ...over,
  })
  if (!r.binding) throw new Error(`fixture rejected: ${r.reason}`)
  return r.binding
}

/** A binding in the only state that may run work. */
function live(over: Partial<Parameters<typeof createBinding>[0]> = {}): NativeBinding {
  const a = activate(make(over))
  if (!a.binding) throw new Error('activate rejected a fresh binding')
  return a.binding
}

const claimFor = (b: NativeBinding) => ({ bindingId: b.bindingId, epoch: b.epoch, targetKey: b.targetKey })

describe('composite keys cannot be aliased', () => {
  it('is injective where plain concatenation is not', () => {
    // SAFE_ID_RE permits ':' inside a session id, so with `provider + ':' + id`
    // ('claude', 'x:y') and ('claude:x', 'y') both yield 'claude:x:y'.
    // Contrast the naive form against the real one rather than asserting a fact
    // about string concatenation, which would pass with the module deleted.
    const naive = (p: string, id: string) => `${p}:${id}`
    expect(naive('claude', 'x:y')).toBe(naive('claude:x', 'y'))
    expect(targetKey('claude', 'x:y')).not.toBe(targetKey('claude:x', 'y'))
  })

  it('survives ids containing slashes, which SAFE_ID_RE also permits', () => {
    expect(targetKey('claude', 'a/b')).not.toBe(targetKey('claude/a', 'b'))
  })

  it('distinguishes providers for the same thread', () => {
    expect(targetKey('claude', THREAD)).not.toBe(targetKey('codex', THREAD))
  })

  it('the boundTo marker is injective on its own, not via bindingId validation', () => {
    // Asserted on directly-constructed bindings, because `NativeBinding` is an
    // exported type a route can build without going through `createBinding`.
    //
    // Under the old dot-joined marker these two collide exactly:
    //   {bindingId:'a',   epoch:1, targetKey:'2.K'} -> "a.1.2.K"
    //   {bindingId:'a.1', epoch:2, targetKey:'K'}   -> "a.1.2.K"
    // BINDING_ID_RE now excludes dots, so validation ALSO prevents this — which
    // means each guard alone is sufficient and a single-guard mutation cannot
    // reach the collision. This pins the marker's own property so the two
    // defenses stay independent.
    const base = make()
    const one = { ...base, bindingId: 'a', epoch: 1, targetKey: '2.K' }
    const two = { ...base, bindingId: 'a.1', epoch: 2, targetKey: 'K' }
    const dotJoined = (b: NativeBinding) => `${b.bindingId}.${b.epoch}.${b.targetKey}`
    expect(dotJoined(one)).toBe(dotJoined(two)) // the naive form really does collide
    expect(boundToMarker(one)).not.toBe(boundToMarker(two))
  })
})

describe('input validation', () => {
  it('rejects ids that SAFE_ID_RE would let through', () => {
    for (const bad of ['native:something', 'a/../../etc/passwd', 'abc@host', THREAD.toUpperCase()]) {
      expect(createBinding({
        bindingId: 'b', cosSessionId: 'c', provider: 'claude', nativeThreadId: bad,
        workspaceFingerprint: '', sourceFingerprint: '', ttlMs: TTL, now: NOW,
      })).toMatchObject({ binding: null, reason: 'invalid_thread_id' })
    }
  })

  it('rejects cursor and unknown providers', () => {
    expect(BINDABLE_PROVIDERS).not.toContain('cursor')
    expect(createBinding({
      bindingId: 'b', cosSessionId: 'c', provider: 'cursor', nativeThreadId: THREAD,
      workspaceFingerprint: '', sourceFingerprint: '', ttlMs: TTL, now: NOW,
    })).toMatchObject({ binding: null, reason: 'invalid_provider' })
  })

  it('rejects a bindingId that could be shaped to collide inside a marker', () => {
    for (const bad of ['', 'a.1.6:claude:36:x', 'b/../c', 'x'.repeat(200)]) {
      expect(createBinding({
        bindingId: bad, cosSessionId: 'c', provider: 'claude', nativeThreadId: THREAD,
        workspaceFingerprint: '', sourceFingerprint: '', ttlMs: TTL, now: NOW,
      })).toMatchObject({ binding: null, reason: 'invalid_binding_id' })
    }
  })

  it('rejects a non-integer or negative priorEpoch', () => {
    // NaN previously propagated into epoch and bricked every prompt as stale.
    for (const bad of [Number.NaN, 1.5, -5, Infinity]) {
      expect(make.bind(null, { priorEpoch: bad })).toThrow()
    }
  })

  it('rejects a non-finite or non-positive ttl', () => {
    for (const bad of [Number.NaN, 0, -1, Infinity]) {
      expect(make.bind(null, { ttlMs: bad })).toThrow()
    }
  })
})

describe('state transitions are an allowlist', () => {
  it('starts in staging, not active', () => {
    expect(make().state).toBe('staging')
  })

  it('activate moves staging to active', () => {
    const a = activate(make())
    expect(a.binding?.state).toBe('active')
  })

  it('activate REFUSES to resurrect a detached binding', () => {
    const d = detach(make()).binding!
    expect(activate(d)).toMatchObject({ binding: null, reason: 'terminal_state' })
  })

  it('activate refuses an already-active binding', () => {
    expect(activate(live())).toMatchObject({ binding: null, reason: 'terminal_state' })
  })

  it('beginDetach makes detaching reachable', () => {
    // Previously nothing could produce this state, so the branch handling it
    // was unreachable and its mutation went uncaught.
    expect(beginDetach(live()).state).toBe('detaching')
  })

  it('beginDetach does not disturb a terminal binding', () => {
    const d = detach(make()).binding!
    expect(beginDetach(d).state).toBe('detached')
  })

  it('isTerminal covers both detaching and detached', () => {
    expect(isTerminal(beginDetach(live()))).toBe(true)
    expect(isTerminal(detach(make()).binding!)).toBe(true)
    expect(isTerminal(live())).toBe(false)
    expect(isTerminal(make())).toBe(false)
  })

  it('only active may run work', () => {
    const states: Record<BindingState, string | null> = {
      staging: 'binding_not_active',
      active: null,
      detaching: 'binding_detached',
      detached: 'binding_detached',
    }
    for (const [state, reason] of Object.entries(states)) {
      const b = { ...live(), state: state as BindingState }
      expect(assertUsable(b, NOW).reason).toBe(reason)
    }
  })

  it('a staging binding cannot execute a queued prompt', () => {
    // staging is the pre-commit state of the journaled Chat handoff (plan 4.8);
    // a turn run against it can land while the Chat is still rolled back.
    const b = make()
    expect(checkQueuedPrompt(claimFor(b), b, NOW)).toEqual({ ok: false, reason: 'binding_not_active' })
  })
})

describe('epochs make a stale queued prompt rejectable by value', () => {
  it('starts at 1 and increments from the durable prior epoch', () => {
    expect(make().epoch).toBe(1)
    expect(make({ priorEpoch: 4 }).epoch).toBe(5)
  })

  it('accepts a current-epoch prompt on an active binding', () => {
    const b = live()
    expect(checkQueuedPrompt(claimFor(b), b, NOW)).toEqual({ ok: true, reason: null })
  })

  it('rejects a prompt composed against the previous attach of the SAME target', () => {
    const reattached = live({ priorEpoch: 1 })
    expect(checkQueuedPrompt({ ...claimFor(reattached), epoch: 1 }, reattached, NOW))
      .toEqual({ ok: false, reason: 'stale_epoch' })
  })

  it('reports a detached binding as detached, never as merely expired', () => {
    const b = detach(make()).binding!
    expect(checkQueuedPrompt(claimFor(b), b, NOW + TTL * 10))
      .toEqual({ ok: false, reason: 'binding_detached' })
  })

  it('reports a stale epoch even when the binding has also expired', () => {
    const b = live()
    expect(checkQueuedPrompt({ ...claimFor(b), epoch: b.epoch - 1 }, b, NOW + TTL + 1))
      .toEqual({ ok: false, reason: 'stale_epoch' })
  })

  it('reports expiry when the epoch is current', () => {
    const b = live()
    expect(checkQueuedPrompt(claimFor(b), b, NOW + TTL + 1))
      .toEqual({ ok: false, reason: 'binding_expired' })
  })

  it('rejects an unknown binding rather than falling through', () => {
    const b = live()
    expect(checkQueuedPrompt(claimFor(b), null, NOW)).toEqual({ ok: false, reason: 'unknown_binding' })
    expect(checkQueuedPrompt({ ...claimFor(b), bindingId: 'someone-else' }, b, NOW))
      .toEqual({ ok: false, reason: 'unknown_binding' })
  })

  it('REQUIRES a targetKey — the strongest guard is not opt-in', () => {
    const b = live()
    expect(checkQueuedPrompt({ bindingId: b.bindingId, epoch: b.epoch, targetKey: '' }, b, NOW))
      .toEqual({ ok: false, reason: 'missing_target_key' })
    expect(checkQueuedPrompt({ ...claimFor(b), targetKey: 'nope' }, b, NOW))
      .toEqual({ ok: false, reason: 'target_mismatch' })
  })
})

describe('pinning outranks the TTL', () => {
  it('expires an unpinned binding at its deadline', () => {
    const b = make()
    expect(isExpired(b, NOW + TTL - 1)).toBe(false)
    expect(isExpired(b, NOW + TTL)).toBe(true)
  })

  it('NEVER expires a pinned binding', () => {
    expect(isExpired(pin(make(), 'job-1'), NOW + TTL * 1000)).toBe(false)
  })

  it('expires again once the last job unpins', () => {
    expect(isExpired(unpin(pin(make(), 'job-1'), 'job-1'), NOW + TTL)).toBe(true)
  })

  it('does not double-pin, and stays pinned while another job remains', () => {
    expect(pin(pin(make(), 'job-1'), 'job-1').pinnedJobs).toEqual(['job-1'])
    const b = unpin(pin(pin(make(), 'job-1'), 'job-2'), 'job-1')
    expect(b.pinnedJobs).toEqual(['job-2'])
    expect(isPinned(b)).toBe(true)
  })

  it('unpinning a job that was never pinned is a no-op', () => {
    expect(unpin(make(), 'never').pinnedJobs).toEqual([])
  })

  it('refuses to re-pin a terminal binding into permanent non-expiry', () => {
    const d = detach(make()).binding!
    expect(pin(d, 'job-9').pinnedJobs).toEqual([])
    expect(isExpired(pin(d, 'job-9'), NOW + TTL)).toBe(true)
  })

  it('renew never shortens, and never revives a terminal binding', () => {
    const b = make()
    expect(renew(b, 1000, NOW).expiresAt).toBe(b.expiresAt)
    expect(renew(b, TTL * 2, NOW).expiresAt).toBe(NOW + TTL * 2)
    const d = detach(b).binding!
    expect(renew(d, TTL * 100, NOW).expiresAt).toBe(d.expiresAt)
  })
})

describe('detach honors its own guard', () => {
  it('refuses while pinned, through the mutator and not just the check', () => {
    const pinned = pin(make(), 'job-1')
    expect(canDetach(pinned)).toEqual({ ok: false, reason: 'binding_pinned' })
    // The mutator previously ignored the guard and silently dropped the pins.
    expect(detach(pinned)).toMatchObject({ binding: null, reason: 'binding_pinned' })
  })

  it('detaches cleanly when unpinned', () => {
    const r = detach(make())
    expect(r.binding?.state).toBe('detached')
    expect(r.binding?.pinnedJobs).toEqual([])
  })

  it('forceDetach is the explicit post-cancel path', () => {
    const forced = forceDetach(pin(make(), 'job-1'))
    expect(forced.state).toBe('detached')
    expect(forced.pinnedJobs).toEqual([])
  })
})

describe('the boundTo marker makes an attached turn recognizable', () => {
  it('round-trips against its own active binding', () => {
    const b = live()
    expect(verifyBoundTo(boundToMarker(b), b, NOW)).toEqual({ ok: true, reason: null })
  })

  it('REJECTS a detached binding even with a valid marker', () => {
    // The marker check previously ignored state entirely, so a route
    // authorizing on it alone let a detached binding through.
    const d = detach(make()).binding!
    expect(verifyBoundTo(boundToMarker(d), d, NOW)).toEqual({ ok: false, reason: 'binding_detached' })
  })

  it('REJECTS an expired binding even with a valid marker', () => {
    const b = live()
    expect(verifyBoundTo(boundToMarker(b), b, NOW + TTL + 1))
      .toEqual({ ok: false, reason: 'binding_expired' })
  })

  it('rejects a staging binding', () => {
    const b = make()
    expect(verifyBoundTo(boundToMarker(b), b, NOW).reason).toBe('binding_not_active')
  })

  it('rejects a marker from a different epoch of the same target', () => {
    const b = live()
    expect(verifyBoundTo(boundToMarker(b), { ...b, epoch: b.epoch + 1 }, NOW))
      .toEqual({ ok: false, reason: 'target_mismatch' })
  })

  it('rejects a marker for a different thread', () => {
    expect(verifyBoundTo(boundToMarker(live({ nativeThreadId: OTHER })), live(), NOW))
      .toEqual({ ok: false, reason: 'target_mismatch' })
  })

  it('rejects non-strings, absent markers, and a null binding', () => {
    const b = live()
    for (const bad of [null, undefined, 42, {}, '']) {
      expect(verifyBoundTo(bad, b, NOW).ok).toBe(false)
    }
    expect(verifyBoundTo('anything', null, NOW)).toEqual({ ok: false, reason: 'unknown_binding' })
  })

  it('detects an attached request on a generic route', () => {
    expect(carriesBoundTo({ boundTo: boundToMarker(live()) })).toBe(true)
    expect(carriesBoundTo({ prompt: 'hello' })).toBe(false)
    expect(carriesBoundTo({ boundTo: '' })).toBe(false)
    expect(carriesBoundTo(null)).toBe(false)
    expect(carriesBoundTo(undefined)).toBe(false)
  })
})
