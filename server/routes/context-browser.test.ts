import express from 'express'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/python-bridge.js', () => ({
  callPython: vi.fn(),
  pythonBridgeAvailable: vi.fn(() => true),
  pythonBridgeState: vi.fn(() => 'ready'),
  // The routes gate on THIS, not on pythonBridgeAvailable. A module mock replaces
  // every export, so omitting it makes the gate `undefined()` and every route
  // throws — which is exactly what happened when it was first added.
  contextSourceAvailable: vi.fn(() => 'bridge'),
  COS_SCRIPTS_DIR: null,
  PYTHON_BIN: null,
}))

vi.mock('../lib/context-library-search.js', () => ({
  searchMemories: vi.fn(async () => ({
    hits: [{ id: 'mem_search_hit', title: 'Toast', snippet: 'counter toast', kind: 'memory', keywordScore: 0.8, semanticScore: 0, match: 'keyword' }],
    keywordCount: 1,
    semanticCount: 0,
    semanticAvailable: false,
    semanticReason: 'no_memory_embeddings',
  })),
  searchThreads: vi.fn(async () => ({
    hits: [{ id: '7ce8073d', title: 'Hubspot Theme Settings', snippet: 'theme', kind: 'thread', keywordScore: 0.7, semanticScore: 0, match: 'keyword' }],
    keywordCount: 1,
    semanticCount: 0,
    semanticAvailable: false,
    semanticReason: 'no_thread_embeddings',
  })),
}))

import {
  callPython,
  contextSourceAvailable,
  pythonBridgeAvailable,
  pythonBridgeState,
} from '../lib/python-bridge.js'
import { memoryRouter } from './memory.js'
import { threadsRouter } from './threads.js'

const callBridge = vi.mocked(callPython)
const bridgeAvailable = vi.mocked(pythonBridgeAvailable)
const bridgeState = vi.mocked(pythonBridgeState)
const contextSource = vi.mocked(contextSourceAvailable)
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
  contextSource.mockReturnValue('bridge')
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
    // "Missing pipeline" now means no source AT ALL — no bridge and no files. A
    // bridge-less install that has notes on disk is a working configuration, not
    // a missing pipeline; that case is covered in the file-tier block below.
    contextSource.mockReturnValue(null)
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

// ---------------------------------------------------------------------------
// The file tier must be REACHABLE. Every one of these routes used to return 503
// before callPython was called, so a fallback inside the bridge changed nothing
// a user could see. These tests pin the gate itself.
// ---------------------------------------------------------------------------
describe('a file-backed install reaches the same routes', () => {
  it('serves memory, threads and status when the only source is files', async () => {
    contextSource.mockReturnValue('files')
    bridgeAvailable.mockReturnValue(false)
    bridgeState.mockReturnValue('pipeline_missing')
    callBridge
      .mockResolvedValueOnce([{ id: 'file_memory_note.md', type: 'note', content: 'From a file' }])
      .mockResolvedValueOnce({ threads: [{ id: 'file_threads_t.md', name: 'From a file' }] })
      .mockResolvedValueOnce({
        available: true, protocol: 1, state: 'ready', source: 'files',
        memory: { available: true, total: 3, state: 'ready' },
        threads: { available: true, total: 1, active: 1, stale: 0, resolved: 0, state: 'ready' },
      })
    const base = await startTestServer()

    const memory = await fetch(`${base}/api/memory`)
    expect(memory.status).toBe(200)
    // A `file_` id must survive normalization. MEMORY_ID_PATTERN previously
    // required `mem_`, so every file-backed row was silently dropped from the
    // list — a 200 response containing nothing.
    expect(await memory.json()).toEqual([expect.objectContaining({ id: 'file_memory_note.md' })])

    const threads = await fetch(`${base}/api/threads`)
    expect(threads.status).toBe(200)
    expect((await threads.json()).threads).toEqual([expect.objectContaining({ name: 'From a file' })])

    const status = await fetch(`${base}/api/context/status`)
    const body = await status.json()
    expect(body.available).toBe(true)
    // Says WHICH tier answered, so a client never implies a vector store that is
    // not there.
    expect(body.source).toBe('files')
    expect(body.memory.total).toBe(3)
  })

  it('still reports unavailable when there is no source at all', async () => {
    contextSource.mockReturnValue(null)
    bridgeAvailable.mockReturnValue(false)
    bridgeState.mockReturnValue('pipeline_missing')
    const base = await startTestServer()

    for (const path of ['/api/memory', '/api/memory/mem_x', '/api/threads', '/api/memory/overview']) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(503)
    }
    // Status answers 200 with available:false by design — the companion reads it
    // to decide what to offer, so it must not have to distinguish a 503 from a
    // network error.
    const status = await fetch(`${base}/api/context/status`)
    expect(status.status).toBe(200)
    expect((await status.json()).available).toBe(false)
    expect(callBridge).not.toHaveBeenCalled()
  })

  it('registers memory and thread search before /:id so q is not parsed as an id', async () => {
    const base = await startTestServer()
    const tooShort = await fetch(`${base}/api/memory/search?q=T`)
    expect(tooShort.status).toBe(400)
    const memory = await fetch(`${base}/api/memory/search?q=Toast`)
    expect(memory.status).toBe(200)
    expect(await memory.json()).toEqual(expect.objectContaining({
      semanticAvailable: false,
      hits: [expect.objectContaining({ id: 'mem_search_hit', match: 'keyword' })],
    }))
    const threads = await fetch(`${base}/api/threads/search?q=theme`)
    expect(threads.status).toBe(200)
    expect(await threads.json()).toEqual(expect.objectContaining({
      semanticAvailable: false,
      semanticReason: 'no_thread_embeddings',
      hits: [expect.objectContaining({ id: '7ce8073d' })],
    }))
    expect(callBridge).not.toHaveBeenCalled()
  })
})
