// The loopback delivery (6.48.1 fix): attach, then a turn body the turns route ACCEPTS.
// Executed against a real HTTP listener standing in for the two routes, so the body on
// the wire is what is asserted, not a source shape. The bug: since the binding
// hardening the turns route requires `epoch` and `targetKey`, and the drainer sent
// neither, so every drained follow-up was refused invalid_request and held forever.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { deliverQueuedTurnOverLoopback } from './thread-turn-queue-deliver.js'
import { targetKey } from './agent-session-binding-store.js'
import type { QueuedThreadTurn } from './thread-turn-queue.js'

const THREAD = 'a1b2c3d4-0000-4000-8000-000000000001'
const turn: QueuedThreadTurn = {
  clientTurnId: 'ct-1', cosSessionId: 'cos-abc', provider: 'claude', threadId: THREAD,
  prompt: 'follow-up', queuedAt: 1, status: 'delivering', attempts: 1,
} as QueuedThreadTurn

describe('deliverQueuedTurnOverLoopback', () => {
  let server: Server | null = null
  afterEach(() => { server?.close(); server = null })

  async function listen(handle: (path: string, body: Record<string, unknown>) => { status: number; body: unknown }): Promise<number> {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        const out = handle(req.url ?? '', raw ? JSON.parse(raw) : {})
        res.statusCode = out.status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(out.body))
      })
    })
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
    return (server!.address() as AddressInfo).port
  }

  it('sends the epoch the attach minted and the server-side target key, so the turns route admits it', async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = []
    const port = await listen((path, body) => {
      seen.push({ path, body })
      if (path.endsWith('/attach')) return { status: 201, body: { attached: true, bindingId: 'bnd-1', epoch: 7, boundTo: 'rev-xyz' } }
      // The turns route's contract (agent-session-bindings.ts): epoch integer >= 1, targetKey string, prompt, clientTurnId.
      const ok = Number.isInteger(body.epoch) && (body.epoch as number) >= 1 && typeof body.targetKey === 'string' && typeof body.prompt === 'string' && typeof body.clientTurnId === 'string'
      return ok ? { status: 202, body: { outcome: 'queued' } } : { status: 400, body: { reason: 'invalid_request', retryable: true } }
    })
    const result = await deliverQueuedTurnOverLoopback(turn, port, 'tok')
    expect(result).toEqual({ ok: true })
    expect(seen[0].path).toBe(`/api/agent-sessions/claude/${THREAD}/attach`)
    expect(seen[0].body).toEqual({ cosSessionId: 'cos-abc' })
    expect(seen[1].path).toBe('/api/agent-sessions/bindings/bnd-1/turns')
    expect(seen[1].body).toEqual({ clientTurnId: 'ct-1', prompt: 'follow-up', epoch: 7, targetKey: targetKey('claude', THREAD), boundTo: 'rev-xyz' })
  })

  it('an attach without an epoch is not provable admission', async () => {
    const port = await listen(path => path.endsWith('/attach') ? { status: 201, body: { attached: true, bindingId: 'bnd-1' } } : { status: 202, body: {} })
    expect(await deliverQueuedTurnOverLoopback(turn, port, 'tok')).toEqual({ ok: false, reason: 'attach_no_epoch' })
  })

  it('a refused turn carries the route reason and its retryable verdict', async () => {
    const port = await listen(path => path.endsWith('/attach')
      ? { status: 201, body: { attached: true, bindingId: 'bnd-1', epoch: 1 } }
      : { status: 409, body: { reason: 'stale_epoch', retryable: false } })
    expect(await deliverQueuedTurnOverLoopback(turn, port, 'tok')).toEqual({ ok: false, reason: 'stale_epoch', serverRetryable: false })
  })
})
