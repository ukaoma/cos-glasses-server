import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { TargetGuard } from '../routes/agent-session-bindings.js'
import { targetKey } from './agent-session-binding-store.js'
import { queueableRefusal } from './thread-turn-queue.js'

/** Source with `//` lines removed.
 *
 *  index.ts EXPLAINS this wiring in prose, at length, right where it happens. A
 *  plain substring check would match the explanation and pass no matter what the
 *  code did -- which is exactly the shape of assertion that let a dead confirmation
 *  button live in COS Control for months. */
function code(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('//'))
    .join('\n')
}

describe('the thread-turn queue can see a fence', () => {
  // WHY THIS FILE EXISTS.
  //
  // The queue is wired at index.ts BEFORE the agent-session-bindings router. The
  // router used to construct its own TargetGuard, so the queue's `occupancy` had no
  // way to observe a fence at all. A fenced target therefore reported attachable,
  // `drainDecision` returned 'deliver', the loopback attach refused
  // `native_target_fenced`, and the refusal burned one of MAX_DELIVERY_ATTEMPTS.
  // Five ticks retire a turn in about two minutes -- so a turn queued from the G2
  // against a fenced thread was silently gone long before anyone could walk to the
  // Mac and press Release.
  //
  // The identical bug already happened once with `native_target_busy`, and the fix
  // was the same: make the blocker visible to `occupancy` so the drainer holds.
  // These assertions exist so it cannot happen a third time.

  it('holds ONE guard, owned above the queue, shared with the router', () => {
    const index = code('../index.ts')

    expect(index).toMatch(/const sharedTargetGuard = new TargetGuard\(/)
    expect(index).toMatch(/guard: sharedTargetGuard/)

    // The whole defect in one assertion: the guard must be constructed BEFORE the
    // queue is wired, or the queue reads a guard that does not exist yet.
    expect(index.indexOf('const sharedTargetGuard')).toBeGreaterThan(-1)
    expect(index.indexOf('const sharedTargetGuard'))
      .toBeLessThan(index.indexOf('const queueDeps'))

    // And exactly one is constructed in the whole server.
    expect(index.match(/new TargetGuard\(/g) ?? []).toHaveLength(1)
  })

  it('consults the fence inside occupancy, before reporting attachable', () => {
    const index = code('../index.ts')
    const fn = index.slice(
      index.indexOf('occupancy: (provider: string, threadId: string)'),
    )
    const body = fn.slice(0, fn.indexOf('turnEnded:'))

    expect(body).toMatch(/sharedTargetGuard\.fencedReason\(targetKey\(provider, threadId\)\)/)
    // Ordering is the point: a fence check after the success return is decoration.
    expect(body.indexOf('fencedReason'))
      .toBeLessThan(body.indexOf('return { attachable: true'))
  })

  it('the router does not quietly build a second guard when given one', () => {
    const router = code('../routes/agent-session-bindings.ts')
    expect(router).toMatch(/const guard = deps\.guard \?\? new TargetGuard\(/)
  })

  // Execution, not source shape: the guard actually answers the question that
  // `occupancy` asks it, for the key shape `occupancy` builds.
  it('answers fencedReason for a key built the way occupancy builds it', () => {
    const guard = new TargetGuard(null)
    const key = targetKey('claude', '1c45222f-038d-460f-9a86-b8ea72c424ea')

    expect(guard.fencedReason(key)).toBeNull()

    guard.fence(key, 'native_target_fenced', {
      headBefore: null,
      turnId: 't-1',
      bindingId: 'b-1',
      provider: 'claude',
      now: 1_700_000_000_000,
    })
    expect(guard.fencedReason(key)).toBe('native_target_fenced')

    // A different thread is unaffected -- the fence is per-target, not global.
    expect(guard.fencedReason(targetKey('claude', 'other-thread-id'))).toBeNull()
  })

  it('and that reason is one the queue will wait on', () => {
    // Closes the loop: the reason `occupancy` now returns must be in the queueable
    // set, or the turn is refused outright instead of parked.
    expect(queueableRefusal('native_target_fenced')).toBe(true)
  })
})
