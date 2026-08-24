import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetRenderGate,
  localRenderQueueDepth,
  synthesizeLocalTts,
} from './tts-local.js'

/**
 * The Kokoro sidecar renders ONE request at a time. Everything here exists
 * because the server used to ignore that and fire N requests at once.
 *
 * WHAT BROKE, measured on device 2026-08-23. Chunking split a 6,781-character
 * reply into 9 segments and /prepare pre-warmed all 9 concurrently. Each render
 * took ~2.6s, but the synthesis timeout was armed when the request was ISSUED,
 * so it ran while the request sat in the sidecar's queue. Segment 5 spent 11.5s
 * of its 12,000ms budget waiting. On a slightly busier machine it tipped over,
 * the pre-warm returned 502, `waitForInFlight` reported failure, and iOS
 * surfaced it as NotSupportedError. Five of nine segments played.
 *
 * Two separate properties fix it, and both are pinned below:
 *
 *   1. The timeout bounds RENDER, not render-plus-queue.
 *   2. A /play render outranks a /prepare pre-warm, because a user is waiting
 *      on the first and nobody is waiting on the second.
 */

/** A sidecar we control: each call parks until we release it by index. */
function controllableSidecar() {
  const started: string[] = []
  const gates: Array<() => void> = []
  const fetchImpl = vi.fn(async (_url: string, init?: { body?: string; signal?: AbortSignal }) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    started.push(body.input)
    await new Promise<void>((resolve, reject) => {
      gates.push(resolve)
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      text: async () => '',
    } as unknown as Response
  })
  return {
    fetchImpl,
    started,
    releaseOne: () => { const g = gates.shift(); g?.() },
    inFlight: () => gates.length,
    /** Release the in-flight render, let the next one dispatch, repeat. A
     *  single `releaseAll` cannot work: releasing the holder is what DISPATCHES
     *  the next request, so its gate does not exist yet. */
    drain: async (jobs: Array<Promise<unknown>>) => {
      for (let i = 0; i < 64 && gates.length > 0; i++) {
        gates.shift()?.()
        await new Promise((r) => setTimeout(r, 0))
      }
      await Promise.all(jobs)
    },
  }
}

/** Yield long enough for the gate's promise chain to settle. Microtask-only
 *  pumping is not enough: the dispatch path crosses a real fetch boundary. */
const settle = async (ticks = 3) => {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0))
}

const render = (text: string, priority = false, signal?: AbortSignal) =>
  synthesizeLocalTts({ text, voice: 'am_echo', format: 'mp3', priority, signal })

let sidecar: ReturnType<typeof controllableSidecar>

beforeEach(() => {
  __resetRenderGate()
  sidecar = controllableSidecar()
  vi.stubGlobal('fetch', sidecar.fetchImpl)
})
afterEach(() => {
  __resetRenderGate()
  vi.unstubAllGlobals()
})

describe('the render gate serialises what the sidecar serialises anyway', () => {
  it('lets exactly one render reach the sidecar at a time', async () => {
    const all = [render('a'), render('b'), render('c')].map((p) => p.catch(() => null))
    await settle()

    expect(sidecar.started, 'only the first request may reach the sidecar').toEqual(['a'])
    expect(localRenderQueueDepth()).toBe(3)

    sidecar.releaseOne()
    await settle()
    expect(sidecar.started, 'exactly one more may follow').toEqual(['a', 'b'])

    await sidecar.drain(all)
    expect(sidecar.started).toEqual(['a', 'b', 'c'])
    expect(localRenderQueueDepth()).toBe(0)
  })

  // THE FIX. Before the gate, b and c were issued immediately and their 12s
  // timers ran while they queued. Here they must not even be dispatched until
  // the one ahead completes, so their budget is untouched by the wait.
  it('does not start the synthesis clock until the sidecar is free', async () => {
    vi.useFakeTimers()
    try {
      const a = render('a').catch(() => null)
      const b = render('b').catch((e) => e)
      await vi.advanceTimersByTimeAsync(0)

      // Sit in the queue well past the 12,000ms RENDER budget -- but inside the
      // derived queue ceiling, which for one render ahead is 2 x 12,000ms. The
      // distinction is the entire fix: waiting is not rendering.
      await vi.advanceTimersByTimeAsync(20_000)
      expect(sidecar.started, 'b must not have been dispatched yet').toEqual(['a'])
      expect(localRenderQueueDepth(), 'b is still queued, not failed').toBe(2)

      sidecar.releaseOne()
      await vi.advanceTimersByTimeAsync(0)
      expect(sidecar.started, 'b dispatches only now, with a full budget').toEqual(['a', 'b'])
      sidecar.releaseOne()
      await vi.advanceTimersByTimeAsync(0)
      await a
      const result = await b
      expect(result, 'b must not have timed out while queued').not.toBeInstanceOf(Error)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('playback outranks pre-warm', () => {
  it('puts a priority render ahead of every queued background render', async () => {
    const jobs = [
      render('warm1').catch(() => null),
      render('warm2').catch(() => null),
      render('warm3').catch(() => null),
    ]
    await settle()
    expect(sidecar.started).toEqual(['warm1'])

    jobs.push(render('PLAY', true).catch(() => null))
    await settle()

    await sidecar.drain(jobs)
    // warm1 was already in flight and cannot be preempted. PLAY must be next,
    // ahead of warm2 and warm3 which were queued before it.
    expect(sidecar.started).toEqual(['warm1', 'PLAY', 'warm2', 'warm3'])
  })

  it('never reorders playback against other playback', async () => {
    const jobs = [render('busy').catch(() => null)]
    await settle()
    for (const seg of ['seg1', 'seg2', 'seg3']) jobs.push(render(seg, true).catch(() => null))
    await settle()

    await sidecar.drain(jobs)
    expect(sidecar.started).toEqual(['busy', 'seg1', 'seg2', 'seg3'])
  })
})

describe('the gate cannot be left held', () => {
  it('releases when the render throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sidecar exploded') }))
    await expect(render('boom')).rejects.toThrow()
    expect(localRenderQueueDepth(), 'a failed render must not hold the gate').toBe(0)
  })

  it('releases when the render returns a non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, text: async () => 'nope', arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response)))
    await expect(render('bad')).rejects.toThrow()
    expect(localRenderQueueDepth()).toBe(0)
  })

  it('drops a queued render when its caller aborts, without freeing the holder', async () => {
    const held = render('holder').catch(() => null)
    await Promise.resolve()
    const ac = new AbortController()
    const queued = render('queued', false, ac.signal)
    await Promise.resolve()
    expect(localRenderQueueDepth()).toBe(2)

    ac.abort()
    await expect(queued).rejects.toThrow(/aborted/)
    expect(localRenderQueueDepth(), 'only the aborted waiter leaves').toBe(1)
    expect(sidecar.started, 'an aborted waiter must never reach the sidecar').toEqual(['holder'])

    await sidecar.drain([held])
    expect(localRenderQueueDepth()).toBe(0)
  })

  it('refuses an already-aborted caller without taking the gate', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(render('dead', false, ac.signal)).rejects.toThrow(/aborted/)
    expect(localRenderQueueDepth()).toBe(0)
    expect(sidecar.started).toEqual([])
  })
})

describe('a wedged sidecar still fails, it does not hang the queue', () => {
  it('rejects a waiter that has outlasted its derived ceiling', async () => {
    vi.useFakeTimers()
    try {
      const held = render('holder').catch(() => null)
      await vi.advanceTimersByTimeAsync(0)
      const stuck = render('stuck').catch((e) => e as Error)
      await vi.advanceTimersByTimeAsync(0)

      // Ceiling for the first waiter is (1 in flight + 1 headroom) x 12,000ms.
      await vi.advanceTimersByTimeAsync(23_000)
      expect(localRenderQueueDepth(), 'still inside the ceiling').toBe(2)

      await vi.advanceTimersByTimeAsync(2_000)
      const err = await stuck
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).name).toBe('TimeoutError')
      expect((err as Error).message).toMatch(/queue wait exceeded/)
      // The wedged holder still owns the gate; only the waiter left.
      expect(localRenderQueueDepth()).toBe(1)
      sidecar.releaseOne()
      await vi.advanceTimersByTimeAsync(0)
      await held
    } finally {
      vi.useRealTimers()
    }
  })

  // The ceiling must SCALE with queue position, or a long reply's later
  // segments would be rejected for the crime of being ninth in line. Waiter k
  // is allowed (k + 2) render budgets: one per render ahead of it, plus the
  // headroom above.
  it('gives a later waiter a proportionally longer ceiling', async () => {
    vi.useFakeTimers()
    try {
      const jobs = [render('holder').catch(() => null)]
      const deaths: Array<number | null> = []
      const start = 0
      let elapsed = start
      for (let i = 0; i < 8; i++) {
        const idx = i
        jobs.push(
          render(`seg${idx}`).catch(() => { deaths[idx] = elapsed; return null }),
        )
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(localRenderQueueDepth()).toBe(9)

      // Nobody may die before the FIRST waiter's ceiling of 2 x 12,000ms.
      await vi.advanceTimersByTimeAsync(23_000); elapsed = 23_000
      expect(localRenderQueueDepth(), 'no waiter may expire early').toBe(9)

      // Walk out to 70s: ceilings are 24, 36, 48, 60, 72, 84, 96, 108 seconds,
      // so exactly the first four are gone and the rest are still waiting.
      await vi.advanceTimersByTimeAsync(47_000); elapsed = 70_000
      expect(localRenderQueueDepth(), 'later waiters outlive earlier ones').toBe(5)

      // The decisive comparison: a flat ceiling would have killed the last
      // waiter at 24s alongside the first. It is still alive at 70s.
      expect(deaths[7] ?? null, 'the last waiter must still be queued').toBeNull()
      expect(deaths[0], 'the first waiter is long gone').not.toBeNull()
    } finally {
      vi.useRealTimers()
      __resetRenderGate()
    }
  })
})

describe('the gate leaves nothing attached to the caller', () => {
  // FOUND BY MUTATION, not by reasoning. Deleting `next.detach?.()` from the
  // release path left every one of these ten tests green: a resolved waiter
  // still renders correctly, and its stale ceiling timer only ever rejects an
  // already-settled promise. The damage is invisible and cumulative -- the
  // abort listener is never removed, so one long-lived AbortSignal driving a
  // 46-segment reply accumulates 45 dead listeners and a MaxListeners warning.
  //
  // Behaviour tests cannot see this. Counting can.
  it('removes every abort listener it adds', async () => {
    const ac = new AbortController()
    const added: unknown[] = []
    const removed: unknown[] = []
    const realAdd = ac.signal.addEventListener.bind(ac.signal)
    const realRemove = ac.signal.removeEventListener.bind(ac.signal)
    ac.signal.addEventListener = ((t: string, fn: never, o?: never) => {
      if (t === 'abort') added.push(fn)
      return realAdd(t, fn, o)
    }) as typeof ac.signal.addEventListener
    ac.signal.removeEventListener = ((t: string, fn: never, o?: never) => {
      if (t === 'abort') removed.push(fn)
      return realRemove(t, fn, o)
    }) as typeof ac.signal.removeEventListener

    const jobs = [render('holder', false, ac.signal).catch(() => null)]
    await settle()
    for (const t of ['q1', 'q2', 'q3']) jobs.push(render(t, false, ac.signal).catch(() => null))
    await settle()
    await sidecar.drain(jobs)

    // Only the QUEUED renders attach a gate listener; the holder never queued.
    expect(added.length, 'each queued render attaches one').toBe(3)
    expect(
      removed.length,
      'every attached listener must be detached when the waiter is served',
    ).toBe(added.length)
  })
})
