import express from 'express'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/python-bridge.js', () => ({
  callPython: vi.fn(),
  pythonBridgeAvailable: vi.fn(() => true),
  pythonBridgeState: vi.fn(() => 'ready'),
}))

import { callPython, pythonBridgeAvailable, pythonBridgeState } from '../lib/python-bridge.js'
import { memoryRouter } from './memory.js'
import { threadsRouter } from './threads.js'

const callBridge = vi.mocked(callPython)
const bridgeAvailable = vi.mocked(pythonBridgeAvailable)
const bridgeState = vi.mocked(pythonBridgeState)
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
  bridgeAvailable.mockReturnValue(true)
  bridgeState.mockReturnValue('ready')
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

  it('returns typed unavailable responses when list bridges fail', async () => {
    callBridge.mockRejectedValue(new Error('offline'))
    const base = await startTestServer()
    const memory = await fetch(`${base}/api/memory`)
    const threads = await fetch(`${base}/api/threads`)
    expect(memory.status).toBe(503)
    expect(await memory.json()).toEqual({ error: 'memory_unavailable' })
    expect(threads.status).toBe(503)
    expect(await threads.json()).toEqual(expect.objectContaining({
      error: 'threads_unavailable', available: false, threads: [],
    }))
  })

  it('reports missing pipeline distinctly from a valid empty store', async () => {
    bridgeAvailable.mockReturnValue(false)
    bridgeState.mockReturnValue('pipeline_missing')
    const base = await startTestServer()
    const status = await (await fetch(`${base}/api/context/status`)).json()
    expect(status).toEqual(expect.objectContaining({
      available: false,
      state: 'pipeline_missing',
      memory: expect.objectContaining({ available: false, state: 'pipeline_missing' }),
      threads: expect.objectContaining({ available: false, state: 'pipeline_missing' }),
    }))
    expect((await fetch(`${base}/api/memory`)).status).toBe(503)
    expect((await fetch(`${base}/api/threads`)).status).toBe(503)
  })

  it('reports bridge execution failures as degraded rather than outdated', async () => {
    callBridge.mockRejectedValueOnce(new Error('temporary python failure'))
    const base = await startTestServer()
    const status = await (await fetch(`${base}/api/context/status`)).json()
    expect(status).toEqual(expect.objectContaining({
      available: false,
      protocol: 1,
      state: 'bridge_error',
      memory: expect.objectContaining({ available: false, state: 'bridge_error' }),
      threads: expect.objectContaining({ available: false, state: 'bridge_error' }),
    }))
  })

  it('bounds thread output at the bridge before normalization', async () => {
    callBridge.mockResolvedValueOnce({ threads: [] })
    const base = await startTestServer()
    expect((await fetch(`${base}/api/threads?limit=999`)).status).toBe(200)
    expect(callBridge).toHaveBeenCalledWith(['threads', '--limit', '50'])
  })
})
