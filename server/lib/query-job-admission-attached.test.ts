import { describe, it, expect } from 'vitest'
import { preparePublicDurableQueryAdmission } from './query-job-runtime.js'
import { boundToMarker, createBinding } from './agent-session-binding-store.js'

// Plan 4.2, the silent-downgrade ban. An attached turn re-admitted through the
// GENERIC durable-query route would otherwise run against COS's own conversation
// instead of the user's desktop thread, and would look like it worked.
describe('the generic route refuses an attached turn', () => {
  const marker = (): string => {
    const made = createBinding({
      bindingId: 'bnd-11111111-2222-4333-8444-555555555555',
      cosSessionId: 'cos-1',
      provider: 'claude',
      nativeThreadId: 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d',
      workspaceFingerprint: 'w',
      sourceFingerprint: 's',
      ttlMs: 900_000,
      now: 1_700_000_000_000,
    })
    if (!made.binding) throw new Error(`fixture rejected: ${made.reason}`)
    return boundToMarker(made.binding)
  }

  it('rejects a request carrying a boundTo marker', async () => {
    await expect(preparePublicDurableQueryAdmission({
      clientJobId: 'c1', generation: 1, query: 'hi', sessionId: 's1', boundTo: marker(),
    })).rejects.toMatchObject({ status: 409, code: 'attached_turn_on_generic_route' })
  })

  it('names the thread rather than blaming the request', async () => {
    // The copy has to tell the user what actually happened, because from their side
    // a rejected continuation is indistinguishable from a broken app.
    await expect(preparePublicDurableQueryAdmission({
      clientJobId: 'c1', generation: 1, query: 'hi', sessionId: 's1', boundTo: marker(),
    })).rejects.toMatchObject({ message: expect.stringContaining('thread on your Mac') })
  })

  it('leaves an ORDINARY request alone', async () => {
    // The paired assertion: a check that rejected everything would pass the two
    // above and break every normal COS query.
    const ordinary = { clientJobId: 'c1', generation: 1, query: 'hi', sessionId: 's1' }
    const out = await preparePublicDurableQueryAdmission(ordinary) as Record<string, unknown>
    expect(out.clientJobId).toBe('c1')
    expect(out.query).toBe('hi')
  })

  it('ignores an empty or non-string marker rather than refusing a normal turn', async () => {
    for (const boundTo of ['', null, undefined, 42, {}]) {
      const out = await preparePublicDurableQueryAdmission({
        clientJobId: 'c1', generation: 1, query: 'hi', sessionId: 's1', boundTo,
      }) as Record<string, unknown>
      expect(out.clientJobId).toBe('c1')
    }
  })
})
