import express from 'express'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/python-bridge.js', () => ({ callPython: vi.fn() }))

import { callPython } from '../lib/python-bridge.js'
import { memoryRouter } from './memory.js'
import { threadsRouter } from './threads.js'

const callBridge = vi.mocked(callPython)
const closers: Array<() => Promise<void>> = []

async function startTestServer(): Promise<string> {
  const app = express()
  app.use('/api', memoryRouter)
  app.use('/api', threadsRouter)
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  closers.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  callBridge.mockReset()
  await Promise.all(closers.splice(0).map(close => close()))
})

describe('memory and thread API routes', () => {
  it('preserves the legacy memory array and clamps untrusted query values', async () => {
    callBridge.mockResolvedValueOnce([{
      id: 'mem_20260808_120000_123456', type: 'decision', summary: 'Decision', content: 'Details',
    }])
    const base = await startTestServer()
    const response = await fetch(`${base}/api/memory?days=99999&limit=999`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([expect.objectContaining({ id: 'mem_20260808_120000_123456' })])
    expect(callBridge).toHaveBeenCalledWith(['memory', '--days', '3650', '--limit', '50'])
  })

  it('fetches exact memory and thread IDs and returns typed not-found responses', async () => {
    callBridge
      .mockResolvedValueOnce({ id: 'mem_exact_1', type: 'decision', content: 'Exact memory' })
      .mockResolvedValueOnce({ id: 'thread-1', name: 'Exact thread', meeting_count: 2 })
      .mockResolvedValueOnce({ error: 'memory_not_found' })
    const base = await startTestServer()

    expect(await (await fetch(`${base}/api/memory/mem_exact_1`)).json())
      .toEqual(expect.objectContaining({ id: 'mem_exact_1', content: 'Exact memory' }))
    expect(await (await fetch(`${base}/api/threads/thread-1`)).json())
      .toEqual(expect.objectContaining({ id: 'thread-1', name: 'Exact thread' }))
    expect((await fetch(`${base}/api/memory/mem_missing`)).status).toBe(404)
  })

  it('rejects path-like identifiers before the bridge is called', async () => {
    const base = await startTestServer()
    expect((await fetch(`${base}/api/memory/%2E%2E%2Fsecret`)).status).toBe(400)
    expect((await fetch(`${base}/api/threads/%2E%2E%2Fsecret`)).status).toBe(400)
    expect(callBridge).not.toHaveBeenCalled()
  })

  it('returns honest empty shapes when list bridges are unavailable', async () => {
    callBridge.mockRejectedValue(new Error('offline'))
    const base = await startTestServer()
    expect(await (await fetch(`${base}/api/memory`)).json()).toEqual([])
    expect(await (await fetch(`${base}/api/threads`)).json()).toEqual({
      generated_at: '', active_count: 0, stale_count: 0, resolved_count: 0, threads: [],
    })
  })
})
