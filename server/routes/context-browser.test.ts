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
  app.use(express.json({ limit: '1mb' }))  // the real app mounts a body parser before the routers (index.ts)
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


// ── Recent learning and Knowledge routes (6.44.5) ──

import { requireApiToken } from '../lib/api-auth.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const STATUS_BASE = {
  available: true, protocol: 1,
  memory: { available: true, total: 4875, state: 'ready' },
  threads: { available: true, total: 30, active: 20, stale: 4, resolved: 6, state: 'ready' },
}
const STATUS_EXTRA = {
  learning: { available: true, state: 'ready', count: 121, to_review: { patterns: 1, task_proposals: 120 }, last_ts: '2026-08-31', stores_readable: 6, secret_path: '/Users/x' },
  graph: { available: true, state: 'ready', entities: 40359, relationships: 88369, source_updated_at: '2026-08-31T16:21:34+00:00', index_state: 'fresh',
           queue_pending: 56, owner_host: 'Ukaoma-Mac-Studio.local', is_owner: true, replica: false, processor_state: 'none', lock_state: 'free' },
  protocol: 1,
}
const EVENT = {
  event_id: 'evt_0123456789abcdef', lesson_id: 'siq_6bef5169aea2', event_type: 'proposed', ts: '2026-08-17T05:00:00.000000+00:00',
  store: 'self_improvement_queue', title: 'daily-reflect: Repair the sync path', scope: 'task', category: 'daily-reflect', engine: 'task',
  target: { kind: 'task-proposal', id: 'siq_6bef5169aea2', version: null }, applies_to: [], source_refs: [{ kind: 'self_improvement_queue', id: 'line:7', excerpt: 'Repair' }],
  prior_event_id: null, outcome: null, provenance: 'complete', ordinal: 1, scripts_dir: '/private/leak',
}

function stubBoth(base: unknown, extra: unknown | Error): void {
  callBridge.mockImplementation(async (args: string[]) => {
    if (args[0] === 'context-status') { if (base instanceof Error) throw base; return base }
    if (args[0] === 'context-learning-graph-status') { if (extra instanceof Error) throw extra; return extra }
    throw new Error(`unexpected bridge call ${args.join(' ')}`)
  })
}

describe('/context/status merges the learning and graph blocks (6.44.5)', () => {
  afterEach(() => { callBridge.mockReset(); contextSource.mockReturnValue('bridge') })

  it('carries both blocks, allowlisted, when the second call answers', async () => {
    stubBoth(STATUS_BASE, STATUS_EXTRA)
    const base = await startTestServer()
    const body = await (await fetch(`${base}/api/context/status`)).json() as Record<string, unknown>
    expect(body.memory).toEqual({ available: true, total: 4875, state: 'ready' })
    expect(body.learning).toEqual({ available: true, state: 'ready', count: 121, to_review: { patterns: 1, task_proposals: 120 }, last_ts: '2026-08-31', stores_readable: 6 })
    expect(body.graph).toEqual({ available: true, state: 'ready', entities: 40359, relationships: 88369, source_updated_at: '2026-08-31T16:21:34+00:00', index_state: 'fresh',
      queue_pending: 56, owner_host: 'Ukaoma-Mac-Studio.local', is_owner: true, replica: false, processor_state: 'none', lock_state: 'free' })
    expect(JSON.stringify(body)).not.toContain('/Users/')
    expect(callBridge).toHaveBeenCalledTimes(2)
    expect(callBridge.mock.calls[1]).toEqual([['context-learning-graph-status'], 1_500])
  })

  it.each([
    ['rejected (older bridge: unknown command, exit 1, empty stderr)', new Error('')],
    ['an { error } answer', { error: 'unknown command: context-learning-graph-status' }],
    ['a timed-out second call', new Error('Command failed: timeout')],
    ['a non-object answer', 'garbage'],
  ])('leaves memory and threads intact and the blocks absent when the second call is %s', async (_label, extra) => {
    stubBoth(STATUS_BASE, extra)
    const base = await startTestServer()
    const body = await (await fetch(`${base}/api/context/status`)).json() as Record<string, unknown>
    expect(body).toEqual({ available: true, protocol: 1, memory: STATUS_BASE.memory, threads: STATUS_BASE.threads })
    expect('learning' in body).toBe(false)
    expect('graph' in body).toBe(false)
  })

  it('reports bridge_error for a rejected base call regardless of the second', async () => {
    stubBoth(new Error('temporary python failure'), STATUS_EXTRA)
    const base = await startTestServer()
    const body = await (await fetch(`${base}/api/context/status`)).json() as Record<string, unknown>
    expect(body.memory).toEqual({ available: false, total: 0, state: 'bridge_error', reason: 'bridge_error' })
    expect('learning' in body).toBe(false)
  })

  it('never carries the blocks on the not-configured early return', async () => {
    contextSource.mockReturnValue(null)
    bridgeState.mockReturnValue('pipeline_missing')
    const base = await startTestServer()
    const body = await (await fetch(`${base}/api/context/status`)).json() as Record<string, unknown>
    expect(callBridge).not.toHaveBeenCalled()
    expect('learning' in body).toBe(false)
    expect('graph' in body).toBe(false)
  })
})

describe('recent learning and knowledge routes (6.44.5)', () => {
  afterEach(() => { callBridge.mockReset(); contextSource.mockReturnValue('bridge') })

  it('lists learning events with the cursor and coverage, allowlisted and no-store', async () => {
    callBridge.mockResolvedValueOnce({
      events: [EVENT, { event_id: 'not-an-id', event_type: 'proposed', ts: '2026-08-17T05:00:00+00:00' }, { ...EVENT, event_id: 'evt_fedcba9876543210', event_type: 'bogus' }],
      total: 3, next_cursor: { since_ts: '2026-08-17T05:00:00.000000+00:00', since_event_id: 'evt_0123456789abcdef' },
      coverage: { self_improvement_queue: { state: 'ok', count: 120, detail: '/Users/leak' }, bot_memory: { state: 'unavailable', count: 'x' } }, protocol: 1,
    })
    const base = await startTestServer()
    const response = await fetch(`${base}/api/context/learning?days=30&limit=5&kind=proposed,checked&since_ts=2026-09-01T00:00:00Z&since_event_id=evt_0123456789abcdef`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const body = await response.json() as { events: Array<Record<string, unknown>>; total: number; next_cursor: unknown; coverage: Record<string, unknown> }
    expect(body.events.map(e => e.event_id)).toEqual(['evt_0123456789abcdef'])
    expect(body.events[0]).not.toHaveProperty('scripts_dir')
    expect(body.events[0].target).toEqual({ kind: 'task-proposal', id: 'siq_6bef5169aea2', version: null })
    expect(body.total).toBe(3)
    expect(body.next_cursor).toEqual({ since_ts: '2026-08-17T05:00:00.000000+00:00', since_event_id: 'evt_0123456789abcdef' })
    expect(body.coverage.bot_memory).toEqual({ state: 'unavailable', count: 0 })
    expect(JSON.stringify(body)).not.toContain('/Users/')
    expect(callBridge).toHaveBeenCalledWith(['learning-events', '--days=30', '--limit=5', '--kind=proposed,checked', '--since-ts=2026-09-01T00:00:00Z', '--since-event-id=evt_0123456789abcdef'], 8_000)
  })

  it('serves one event with its detail, and 404s an unknown id, 400 a malformed one', async () => {
    callBridge.mockResolvedValueOnce({ ...EVENT, detail: { bodies: ['body one', 'body two'], task: 'daily-reflect', future: false, logged_times: 2, extra: 'dropped' } })
    const base = await startTestServer()
    const ok = await fetch(`${base}/api/context/learning/evt_0123456789abcdef`)
    expect(ok.status).toBe(200)
    const body = await ok.json() as { detail: Record<string, unknown> }
    expect(body.detail).toEqual({ bodies: ['body one', 'body two'], task: 'daily-reflect', future: false, logged_times: 2 })
    callBridge.mockResolvedValueOnce({ error: 'learning_event_not_found', protocol: 1 })
    expect((await fetch(`${base}/api/context/learning/evt_ffffffffffffffff`)).status).toBe(404)
    expect((await fetch(`${base}/api/context/learning/evt_bad`)).status).toBe(400)
    expect((await fetch(`${base}/api/context/learning/status`)).status).not.toBe(400)  // the status route is registered before :id
  })

  it('serves learning status and graph status, allowlisted', async () => {
    callBridge.mockResolvedValueOnce({ stores: { self_improvement_queue: { readable: true, state: 'ok', count: 120, last_ts: '2026-08-31T05:00:00+00:00' } },
      to_review: { count: 121, pattern: 1, 'task-proposal': 120 }, orphan_decisions: 0, no_store_active: false, engines: ['task'], counts_by_type: { proposed: 836, weird: 3 }, protocol: 1 })
    const base = await startTestServer()
    const status = await (await fetch(`${base}/api/context/learning/status`)).json() as Record<string, unknown>
    expect(status).toEqual({ stores: { self_improvement_queue: { readable: true, state: 'ok', count: 120, last_ts: '2026-08-31T05:00:00+00:00' } },
      to_review: { count: 121, pattern: 1, 'task-proposal': 120 }, orphan_decisions: 0, no_store_active: false, engines: ['task'], counts_by_type: { proposed: 836 } })
    callBridge.mockResolvedValueOnce({ entities: 40359, relationships: 88369, index_state: 'fresh', source: { owner_host: 'm3', is_owner: true, owner_state: 'owner' },
      queue: { pending: 56, oldest_pending_at: '2026-08-31T16:58:00+00:00' }, budget: { used: 0, cap: 1500 }, lock: { state: 'free', owner_pid: null, error: null },
      processor: { state: 'none', plist: false }, build: { state: 'done', error: '/Users/leak', wall_s: 4.4 }, protocol: 1, scripts_dir: '/Users/leak' })
    const graph = await (await fetch(`${base}/api/context/graph/status`)).json() as Record<string, unknown>
    expect(graph.entities).toBe(40359)
    expect((graph.source as Record<string, unknown>).owner_state).toBe('owner')
    expect((graph.queue as Record<string, unknown>).pending).toBe(56)
    expect((graph.build as Record<string, unknown>).wall_s).toBe(4.4)
    expect(JSON.stringify(graph)).not.toContain('/Users/')
    expect(graph).not.toHaveProperty('scripts_dir')
  })

  it('validates search, entity and passages inputs before the bridge is called', async () => {
    const base = await startTestServer()
    expect((await fetch(`${base}/api/context/graph/search?q=a`)).status).toBe(400)
    expect((await fetch(`${base}/api/context/graph/search?q=${'x'.repeat(161)}`)).status).toBe(400)
    expect((await fetch(`${base}/api/context/graph/entity`)).status).toBe(400)
    expect((await fetch(`${base}/api/context/graph/entity?id=${encodeURIComponent('a\u0007b')}`)).status).toBe(400)
    expect((await fetch(`${base}/api/context/graph/passages`)).status).toBe(400)
    expect((await fetch(`${base}/api/context/graph/passages?relationA=COS`)).status).toBe(400)
    expect((await fetch(`${base}/api/context/graph/passages?entity=COS&relationA=x&relationB=y`)).status).toBe(400)
    expect(callBridge).not.toHaveBeenCalled()
  })

  it('searches, opens an entity, reads passages; 404 on an unknown entity', async () => {
    callBridge.mockResolvedValueOnce({ items: [{ id: 'COS', type: 'artifact', degree: 183, description: 'x' }], total: 722, index_state: 'fresh', matcher: 'fts5', window: 2000, offset: 0, limit: 2, protocol: 1 })
    const base = await startTestServer()
    const search = await (await fetch(`${base}/api/context/graph/search?q=COS&limit=2&type=artifact`)).json() as Record<string, unknown>
    expect(search.total).toBe(722)
    expect(search.items).toEqual([{ id: 'COS', type: 'artifact', degree: 183, description: 'x' }])
    expect(callBridge).toHaveBeenLastCalledWith(['graph-search', '--q=COS', '--limit=2', '--offset=0', '--type=artifact'], 8_000)
    callBridge.mockResolvedValueOnce({ found: true, id: 'Miles Ukaoma', type: 'person', degree: 5251, description: 'd', descriptions: ['d'], edges: [{ source: 'Miles Ukaoma', target: 'Ryan Hopkins', weight: 228, description: 'e' }],
      neighbors: [{ id: 'Ryan Hopkins', type: 'person', degree: 300 }], total_relationships: 5251, source_status: 'resolved', source_count: 200, source_resolved: 200, index_state: 'fresh', protocol: 1 })
    const entity = await (await fetch(`${base}/api/context/graph/entity?id=${encodeURIComponent('Miles Ukaoma')}&limit=1`)).json() as Record<string, unknown>
    expect(entity.found).toBe(true)
    expect(entity.edges).toEqual([{ source: 'Miles Ukaoma', target: 'Ryan Hopkins', weight: 228, description: 'e' }])
    expect(callBridge).toHaveBeenLastCalledWith(['graph-entity', '--id=Miles Ukaoma', '--offset=0', '--limit=1'], 8_000)
    callBridge.mockResolvedValueOnce({ error: 'entity_not_found', protocol: 1 })
    expect((await fetch(`${base}/api/context/graph/entity?id=nobody`)).status).toBe(404)
    callBridge.mockResolvedValueOnce({ items: [{ chunk_id: 'chunk-1', doc_id: 'doc-1', order: 0, excerpt: 'text', source: { status: 'resolved', key: 'k', title: 't', date: '2026-04-04', summary: 's' } }],
      total: 88, index_state: 'fresh', index_built_at: '2026-09-06T22:45:20+00:00', fallback: null, unavailable: [], note: null, error: null, protocol: 1 })
    const passagesResponse = await fetch(`${base}/api/context/graph/passages?relationA=COS&relationB=${encodeURIComponent('Miles Ukaoma')}&limit=9`)
    const passages = await passagesResponse.json() as Record<string, unknown>
    expect(passages, `status ${passagesResponse.status} calls ${JSON.stringify(callBridge.mock.calls)}`).toMatchObject({ total: 88 })
    expect(callBridge).toHaveBeenLastCalledWith(['graph-passages', '--relation-a=COS', '--relation-b=Miles Ukaoma', '--limit=5'], 8_000)
  })

  it('kicks off an index build with 202 through the spawning bridge command only', async () => {
    callBridge.mockResolvedValueOnce({ started: true, already_running: false, pid: 4242, receipt: { state: 'running', started_at: '2026-09-06T23:00:00+00:00', pid: 4242, host: 'm3' }, protocol: 1 })
    const base = await startTestServer()
    const response = await fetch(`${base}/api/context/graph/index`, { method: 'POST' })
    expect(response.status).toBe(202)
    const body = await response.json() as Record<string, unknown>
    expect(body.started).toBe(true)
    expect((body.receipt as Record<string, unknown>).state).toBe('running')
    expect(callBridge).toHaveBeenCalledWith(['graph-index-build', '--reason', 'control'], 5_000)
  })

  it('starts one bounded queue ingest with 202 through the spawning bridge command, single-token argv', async () => {
    callBridge.mockResolvedValueOnce({ started: true, already_running: false, pid: 5151, limit: 25, pending: 48, lock: { state: 'free', owner_pid: null }, log: '/x/ingest.log', protocol: 1 })
    const base = await startTestServer()
    const response = await fetch(`${base}/api/context/graph/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit: 25 }) })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ started: true, already_running: false, nothing_pending: false, budget_exhausted: false, pid: 5151, limit: 25, pending: 48, lock: { state: 'free', owner_pid: null }, budget: null })
    expect(callBridge).toHaveBeenCalledWith(['graph-ingest-start', '--limit=25', '--reason=control'], 5_000)
  })

  it('ingest: a missing limit means 10, a bad one is a 400 before the bridge, a held lock is a 202 that did not start', async () => {
    callBridge.mockResolvedValueOnce({ started: false, already_running: true, limit: 10, pending: 48, lock: { state: 'exclusive', owner_pid: 777 }, protocol: 1 })
    const base = await startTestServer()
    const held = await fetch(`${base}/api/context/graph/ingest`, { method: 'POST' })
    expect(held.status).toBe(202)
    const body = await held.json() as Record<string, unknown>
    expect(body.started).toBe(false)
    expect(body.already_running).toBe(true)
    expect((body.lock as Record<string, unknown>).owner_pid).toBe(777)
    expect(callBridge).toHaveBeenLastCalledWith(['graph-ingest-start', '--limit=10', '--reason=control'], 5_000)
    callBridge.mockClear()
    for (const limit of [0, 51, 2.5, 'ten']) {
      const bad = await fetch(`${base}/api/context/graph/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit }) })
      expect(bad.status, String(limit)).toBe(400)
      expect((await bad.json() as { error: string }).error).toBe('invalid_limit')
    }
    expect(callBridge).not.toHaveBeenCalled()
  })

  it('setup: the checklist normalizes every block and ready means every check passed', async () => {
    callBridge.mockResolvedValueOnce({
      checks: [{ id: 'sdk', ok: true, detail: 'lightrag-hku 1.4.9' }, { id: 'embeddings', ok: false, detail: 'OPENAI_API_KEY is not set' }],
      owner: { owner_host: 'M3.local', this_host: 'M3.local', is_owner: true, source: 'file' },
      sources: [{ path: '/Users/q/Notes', enabled: true, exists: true, files: 12, added_at: '2026-09-06T23:00:00+00:00' }, { nope: true }],
      queue: { pending: 3, indexed: 0 }, graph: { entities: null, relationships: null }, budget: { used: 0, cap: 1500 },
      schedule: { installed: false, interval_s: null, plist: null },
      sample: { candidates: [{ path: '/Users/q/Notes/a.md', bytes: 2048 }, { path: '/Users/q/Notes/b.md', bytes: 900 }, { path: '/Users/q/Notes/c.md', bytes: 4000 }, { path: '/Users/q/Notes/d.md', bytes: 1 }], queued: 0, indexed: 0 },
      lock: { state: 'free', owner_pid: null }, ask_ready: false, protocol: 1,
    })
    const base = await startTestServer()
    const response = await fetch(`${base}/api/context/graph/setup`)
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, any>
    expect(body.ready).toBe(false)
    expect(body.checks).toEqual([{ id: 'sdk', ok: true, detail: 'lightrag-hku 1.4.9' }, { id: 'embeddings', ok: false, detail: 'OPENAI_API_KEY is not set' }])
    expect(body.owner).toEqual({ owner_host: 'M3.local', this_host: 'M3.local', is_owner: true, source: 'file' })
    expect(body.sources).toEqual([{ path: '/Users/q/Notes', enabled: true, exists: true, files: 12, added_at: '2026-09-06T23:00:00+00:00' }])
    expect(body.sample.candidates).toHaveLength(3)
    expect(body.schedule.installed).toBe(false)
    expect(callBridge).toHaveBeenCalledWith(['graph-setup-status'], 20_000)
  })

  it('setup sources: single-token argv, the list comes back, a bad action or path is a 400 before the bridge', async () => {
    callBridge.mockResolvedValueOnce({ sources: [{ path: '/Users/q/Notes', enabled: true, exists: true, files: 12, added_at: null }], protocol: 1 })
    const base = await startTestServer()
    const ok = await fetch(`${base}/api/context/graph/setup/sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'add', path: '/Users/q/Notes' }) })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ sources: [{ path: '/Users/q/Notes', enabled: true, exists: true, files: 12, added_at: null }] })
    expect(callBridge).toHaveBeenLastCalledWith(['graph-setup-sources', '--action=add', '--path=/Users/q/Notes'], 15_000)
    callBridge.mockClear()
    for (const body of [{ action: 'wipe', path: '/x' }, { action: 'add', path: '' }, { action: 'add' }]) {
      const bad = await fetch(`${base}/api/context/graph/setup/sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect(bad.status, JSON.stringify(body)).toBe(400)
    }
    expect(callBridge).not.toHaveBeenCalled()
    callBridge.mockResolvedValueOnce({ error: 'path_not_found', message: 'No folder at /Users/q/Nope', protocol: 1 })
    const missing = await fetch(`${base}/api/context/graph/setup/sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'add', path: '/Users/q/Nope' }) })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'path_not_found', message: 'No folder at /Users/q/Nope' })
  })

  it('setup owner, sample, ask and schedule ride their own commands and statuses', async () => {
    const base = await startTestServer()
    callBridge.mockResolvedValueOnce({ owner: { owner_host: 'M3.local', this_host: 'M3.local', is_owner: true, source: 'file' }, protocol: 1 })
    const owner = await fetch(`${base}/api/context/graph/setup/owner`, { method: 'POST' })
    expect(owner.status).toBe(200)
    expect(await owner.json()).toEqual({ owner: { owner_host: 'M3.local', this_host: 'M3.local', is_owner: true, source: 'file' } })
    expect(callBridge).toHaveBeenLastCalledWith(['graph-setup-owner', '--this-mac'], 10_000)

    callBridge.mockResolvedValueOnce({ started: true, already_running: false, pid: 61, limit: 3, pending: 3, lock: { state: 'free', owner_pid: null }, queued: [{ path: '/Users/q/Notes/a.md', id: 'doc_1' }], skipped: [{ path: '/Users/q/Notes/b.md', reason: 'already_indexed' }], protocol: 1 })
    const sample = await fetch(`${base}/api/context/graph/setup/sample`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit: 3 }) })
    expect(sample.status).toBe(202)
    const kicked = await sample.json() as Record<string, any>
    expect(kicked.started).toBe(true)
    expect(kicked.queued).toEqual([{ path: '/Users/q/Notes/a.md', id: 'doc_1' }])
    expect(kicked.skipped).toEqual([{ path: '/Users/q/Notes/b.md', reason: 'already_indexed' }])
    expect(callBridge).toHaveBeenLastCalledWith(['graph-ingest-sample', '--limit=3', '--reason=control'], 90_000)
    expect((await fetch(`${base}/api/context/graph/setup/sample`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit: 4 }) })).status).toBe(400)

    callBridge.mockResolvedValueOnce({ question: 'Who runs demand generation?', mode: 'hybrid', answer: 'Graham Hoffman leads demand generation.', elapsed_s: 41.2, protocol: 1 })
    const ask = await fetch(`${base}/api/context/graph/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'Who runs demand generation?' }) })
    expect(ask.status).toBe(200)
    expect(await ask.json()).toEqual({ question: 'Who runs demand generation?', mode: 'hybrid', answer: 'Graham Hoffman leads demand generation.', elapsed_s: 41.2 })
    expect(callBridge).toHaveBeenLastCalledWith(['graph-ask', '--q=Who runs demand generation?'], 150_000)
    expect((await fetch(`${base}/api/context/graph/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'hi' }) })).status).toBe(400)

    callBridge.mockResolvedValueOnce({ schedule: { installed: true, interval_s: 3600, plist: '/Users/q/Library/LaunchAgents/com.cos.lightrag-ingest.plist' }, protocol: 1 })
    const schedule = await fetch(`${base}/api/context/graph/setup/schedule`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, interval_s: 3600 }) })
    expect(schedule.status).toBe(200)
    expect(await schedule.json()).toEqual({ installed: true, interval_s: 3600, plist: '/Users/q/Library/LaunchAgents/com.cos.lightrag-ingest.plist' })
    expect(callBridge).toHaveBeenLastCalledWith(['graph-schedule', '--enabled=true', '--interval-s=3600'], 20_000)
    expect((await fetch(`${base}/api/context/graph/setup/schedule`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }) })).status).toBe(400)
    expect((await fetch(`${base}/api/context/graph/setup/schedule`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, interval_s: 60 }) })).status).toBe(400)

    callBridge.mockResolvedValueOnce({ error: 'not_owner', message: 'Only the ingestion owner (M3.local) may index the queue.', owner_host: 'M3.local', protocol: 1 })
    const replica = await fetch(`${base}/api/context/graph/setup/schedule`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
    expect(replica.status).toBe(409)
    expect(await replica.json()).toEqual({ error: 'not_owner', message: 'Only the ingestion owner (M3.local) may index the queue.', owner_host: 'M3.local' })
  })

  it('setup embedding and extraction: the choice rides its own commands; a built graph refuses with 409', async () => {
    const base = await startTestServer()
    callBridge.mockResolvedValueOnce({ embedding: { provider: 'onnx', label: 'Local light', model: 'BAAI/bge-small-en-v1.5', dimensions: 384, kind: 'local', cost: 'Free', chosen_at: '2026-09-07T13:00:00+00:00', locked: false, mismatch: false, manifest: null,
      providers: [{ id: 'openai-large', label: 'OpenAI large', model: 'text-embedding-3-large', dimensions: 3072, kind: 'cloud', cost: 'c', needs: 'n', ready: true, detail: 'Key present', selected: false }, { id: 'onnx', label: 'Local light', model: 'BAAI/bge-small-en-v1.5', dimensions: 384, kind: 'local', cost: 'Free', needs: 'n', ready: false, detail: 'not fetched', selected: true }], fetch: null },
      fetch: { started: true, already_running: false, pid: 909 }, protocol: 1 })
    const chosen = await fetch(`${base}/api/context/graph/setup/embedding`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'onnx', fetch: true }) })
    expect(chosen.status).toBe(200)
    const body = await chosen.json() as Record<string, any>
    expect(body.embedding.provider).toBe('onnx')
    expect(body.embedding.providers).toHaveLength(2)
    expect(body.embedding.providers[1]).toEqual({ id: 'onnx', label: 'Local light', model: 'BAAI/bge-small-en-v1.5', dimensions: 384, kind: 'local', cost: 'Free', needs: 'n', ready: false, detail: 'not fetched', selected: true })
    expect(body.fetch).toEqual({ started: true, already_running: false, pid: 909 })
    expect(callBridge).toHaveBeenLastCalledWith(['graph-setup-embedding', '--provider=onnx', '--fetch'], 90_000)
    callBridge.mockClear()
    for (const b of [{ provider: 'cohere' }, { provider: 'ollama', model: 'bad name!' }]) {
      expect((await fetch(`${base}/api/context/graph/setup/embedding`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).status, JSON.stringify(b)).toBe(400)
    }
    expect(callBridge).not.toHaveBeenCalled()
    callBridge.mockResolvedValueOnce({ error: 'embedding_locked', message: 'this graph was built with openai-large (text-embedding-3-large, 3072 dims); the chosen embedding is ollama (bge-m3, 1024 dims). Rebuild the graph to change it.', protocol: 1 })
    const locked = await fetch(`${base}/api/context/graph/setup/embedding`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'ollama', model: 'bge-m3' }) })
    expect(locked.status).toBe(409)
    expect((await locked.json() as { error: string }).error).toBe('embedding_locked')
    expect(callBridge).toHaveBeenLastCalledWith(['graph-setup-embedding', '--provider=ollama', '--model=bge-m3'], 90_000)
    callBridge.mockResolvedValueOnce({ extraction: { tier: 'sonnet', label: 'Balanced', detail: 'd', tiers: [{ id: 'haiku', label: 'Fast', detail: 'a', selected: false }, { id: 'sonnet', label: 'Balanced', detail: 'd', selected: true }, { id: 'opus', label: 'Deep', detail: 'o', selected: false }] }, protocol: 1 })
    const tier = await fetch(`${base}/api/context/graph/setup/extraction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tier: 'sonnet' }) })
    expect(tier.status).toBe(200)
    expect((await tier.json() as Record<string, any>).extraction.tier).toBe('sonnet')
    expect(callBridge).toHaveBeenLastCalledWith(['graph-setup-extraction', '--tier=sonnet'], 15_000)
    expect((await fetch(`${base}/api/context/graph/setup/extraction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tier: 'gpt' }) })).status).toBe(400)
    callBridge.mockResolvedValueOnce({ error: 'embedding_mismatch', message: 'This graph was built with openai-large; the chosen embedding is onnx. Choose the embedding it was built with, or rebuild the graph.', protocol: 1 })
    const mismatch = await fetch(`${base}/api/context/graph/ingest`, { method: 'POST' })
    expect(mismatch.status).toBe(409)
    expect((await mismatch.json() as { error: string }).error).toBe('embedding_mismatch')
  })

  it('ingest progress: the last Control-started run, normalized, read-only', async () => {
    callBridge.mockResolvedValueOnce({ running: true, pid: 4242, lock: { state: 'exclusive', owner_pid: 4242 }, external: false, pending: 2, total: 3, done: 1, failed: 1,
      current: { id: 'doc_ccc', est_calls: 7 }, items: [{ id: 'doc_aaa', outcome: 'indexed', seconds: 40.5 }, { id: 'doc_bbb', outcome: 'failed', reason: 'Document status missing — marked failed for retry' }],
      remaining_calls: 1461, budget: { used: 22, cap: 1500 }, ended: false, log_tail: ['Processing 3 pending items...', '  Ingesting: doc_ccc... (est 7 calls, 1461 remaining)'], log_age_s: 12.5, protocol: 1 })
    const base = await startTestServer()
    const response = await fetch(`${base}/api/context/graph/ingest/progress`)
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, any>
    expect(body.running).toBe(true)
    expect(body.external).toBe(false)
    expect(body.total).toBe(3)
    expect(body.done).toBe(1)
    expect(body.failed).toBe(1)
    expect(body.current).toEqual({ id: 'doc_ccc', est_calls: 7 })
    expect(body.items).toEqual([{ id: 'doc_aaa', outcome: 'indexed', seconds: 40.5, reason: null }, { id: 'doc_bbb', outcome: 'failed', seconds: null, reason: 'Document status missing — marked failed for retry' }])
    expect(body.log_tail).toHaveLength(2)
    expect(body.lock).toEqual({ state: 'exclusive', owner_pid: 4242 })
    expect(callBridge).toHaveBeenCalledWith(['graph-ingest-progress'], 10_000)
  })

  it('ingest on a replica answers 409 not_owner with the bridge sentence and the owner host', async () => {
    callBridge.mockResolvedValueOnce({ error: 'not_owner', message: 'Only the ingestion owner (Ukaoma-Mac-Studio.local) may index the queue.', owner_host: 'Ukaoma-Mac-Studio.local', this_host: 'Air.local', protocol: 1 })
    const base = await startTestServer()
    const response = await fetch(`${base}/api/context/graph/ingest`, { method: 'POST' })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'not_owner', message: 'Only the ingestion owner (Ukaoma-Mac-Studio.local) may index the queue.', owner_host: 'Ukaoma-Mac-Studio.local' })
  })

  it('answers 503 with the string-form reason when the pipeline is not configured or the bridge fails', async () => {
    callBridge.mockResolvedValueOnce({ error: 'cos_pipeline_not_configured' })
    const base = await startTestServer()
    expect(await (await fetch(`${base}/api/context/graph/status`)).json()).toEqual({ error: 'cos_pipeline_not_configured' })
    callBridge.mockRejectedValueOnce(new Error('boom'))
    expect((await fetch(`${base}/api/context/learning`)).status).toBe(503)
    contextSource.mockReturnValue(null)
    bridgeState.mockReturnValue('pipeline_missing')
    for (const path of ['/api/context/learning', '/api/context/learning/status', '/api/context/graph/status', '/api/context/graph/search?q=COS', '/api/context/graph/entity?id=COS', '/api/context/graph/passages?entity=COS']) {
      const response = await fetch(`${base}${path}`)
      expect(response.status, path).toBe(503)
      expect(await response.json()).toEqual({ error: 'pipeline_missing' })
    }
    expect((await fetch(`${base}/api/context/graph/index`, { method: 'POST' })).status).toBe(503)
    expect((await fetch(`${base}/api/context/graph/ingest`, { method: 'POST' })).status).toBe(503)
    expect((await fetch(`${base}/api/context/graph/setup`)).status).toBe(503)
    expect((await fetch(`${base}/api/context/graph/ingest/progress`)).status).toBe(503)
    expect((await fetch(`${base}/api/context/graph/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'anything at all' }) })).status).toBe(503)
  })

  it('requires the API token on every new route (one 401 each)', async () => {
    const app = express()
    app.use('/api', requireApiToken('test-token'))
    app.use('/api', memoryRouter)
    const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)) })
    closers.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    for (const [method, path] of [['GET', '/api/context/learning'], ['GET', '/api/context/learning/status'], ['GET', '/api/context/learning/review'], ['GET', '/api/context/learning/evt_0123456789abcdef'],
      ['GET', '/api/context/graph/status'], ['GET', '/api/context/graph/search?q=COS'], ['GET', '/api/context/graph/entity?id=COS'], ['GET', '/api/context/graph/passages?entity=COS'], ['POST', '/api/context/graph/index'], ['POST', '/api/context/graph/ingest'], ['GET', '/api/context/graph/ingest/progress'], ['GET', '/api/context/graph/setup'], ['POST', '/api/context/graph/setup/sources'], ['POST', '/api/context/graph/setup/owner'], ['POST', '/api/context/graph/setup/sample'], ['POST', '/api/context/graph/ask'], ['POST', '/api/context/graph/setup/schedule'], ['POST', '/api/context/graph/setup/embedding'], ['POST', '/api/context/graph/setup/extraction']] as const) {
      const response = await fetch(`${base}${path}`, { method })
      expect(response.status, `${method} ${path}`).toBe(401)
      // A 401 alone cannot tell a protected route from a missing one (QA 2026-09-06):
      // with the token the same path must be ANSWERED, never 404 from Express.
      callBridge.mockResolvedValueOnce({ error: 'cos_pipeline_not_configured' })
      const withToken = await fetch(`${base}${path}`, { method, headers: { 'x-cos-token': 'test-token' } })
      expect(withToken.status, `${method} ${path} with token`).not.toBe(404)
      expect(withToken.status, `${method} ${path} with token`).not.toBe(401)
    }
  })

  it('never lets the HTTP handler run an SDK or ingest command, and never logs the request URL', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'memory.ts'), 'utf8')
    for (const forbidden of ['--build-index', '--apply-curation', '--process-queue', 'graph-sync', 'graph-curation']) {
      // Any quote form, and the bare token inside a template literal: a double-quoted
      // literal slipped past the single-quote check in QA (2026-09-06).
      expect(source, forbidden).not.toMatch(new RegExp(`["'\`\\$\\{]\\s*${forbidden}\\b`))
    }
    expect(source).not.toMatch(/req\.url|originalUrl/)
    // the only build path is the spawning bridge command, at a bounded timeout
    expect(source).toContain("callPython(['graph-index-build', '--reason', 'control'], 5_000)")
  })
})


describe('QA-2 folds on the learning and knowledge routes (6.44.5)', () => {
  afterEach(() => { callBridge.mockReset(); contextSource.mockReturnValue('bridge') })

  it('serves the strict To review set on /context/learning/review, whole, before the :id route', async () => {
    callBridge.mockResolvedValueOnce({ events: [EVENT], total: 121, review_count: 121, coverage: {}, protocol: 1 })
    const base = await startTestServer()
    const response = await fetch(`${base}/api/context/learning/review?limit=999`)
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.total).toBe(121)
    expect(body.review_count).toBe(121)
    expect(callBridge).toHaveBeenCalledWith(['learning-to-review', '--limit=200'], 8_000)
  })

  it('pins the route caps at the argv: learning 50, search 30 (widening the source fails here)', async () => {
    callBridge.mockResolvedValue({ events: [], total: 0, items: [], protocol: 1 })
    const base = await startTestServer()
    await fetch(`${base}/api/context/learning?limit=999`)
    expect(callBridge).toHaveBeenLastCalledWith(['learning-events', '--days=30', '--limit=50'], 8_000)
    await fetch(`${base}/api/context/graph/search?q=COS&limit=999`)
    expect(callBridge).toHaveBeenLastCalledWith(['graph-search', '--q=COS', '--limit=30', '--offset=0'], 8_000)
  })

  it('answers 404 with a precise class for a missing index or an unknown entity, never 503', async () => {
    const base = await startTestServer()
    callBridge.mockResolvedValueOnce({ found: false, id: 'COS', index_state: 'missing', index_built_at: null, protocol: 1 })
    let response = await fetch(`${base}/api/context/graph/entity?id=COS`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'index_missing' })
    callBridge.mockResolvedValueOnce({ found: false, id: 'Nobody', index_state: 'fresh', protocol: 1 })
    response = await fetch(`${base}/api/context/graph/entity?id=Nobody`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'entity_not_found' })
  })

  it('sends every user value as one token so a leading hyphen is never read as a flag', async () => {
    callBridge.mockResolvedValue({ items: [], total: 0, events: [], found: true, id: '-x', protocol: 1 })
    const base = await startTestServer()
    await fetch(`${base}/api/context/graph/search?q=${encodeURIComponent('-x')}`)
    expect(callBridge).toHaveBeenLastCalledWith(['graph-search', '--q=-x', '--limit=30', '--offset=0'], 8_000)
    await fetch(`${base}/api/context/graph/entity?id=${encodeURIComponent('-x')}`)
    expect(callBridge).toHaveBeenLastCalledWith(['graph-entity', '--id=-x', '--offset=0', '--limit=30'], 8_000)
    await fetch(`${base}/api/context/graph/passages?entity=${encodeURIComponent('-x')}`)
    expect(callBridge).toHaveBeenLastCalledWith(['graph-passages', '--entity=-x', '--limit=5'], 8_000)
    await fetch(`${base}/api/context/learning/evt_0123456789abcdef`)
    expect(callBridge).toHaveBeenLastCalledWith(['learning-event', '--id=evt_0123456789abcdef'], 8_000)
  })

  it('pins learning-status --no-memory, the already_running 202, and no-store on /context/status', async () => {
    const base = await startTestServer()
    callBridge.mockResolvedValueOnce({ stores: {}, to_review: { count: 0 }, protocol: 1 })
    await fetch(`${base}/api/context/learning/status`)
    expect(callBridge).toHaveBeenLastCalledWith(['learning-status', '--no-memory'], 8_000)
    callBridge.mockResolvedValueOnce({ started: false, already_running: true, pid: 4242, receipt: { state: 'running' }, protocol: 1 })
    const kickoff = await fetch(`${base}/api/context/graph/index`, { method: 'POST' })
    expect(kickoff.status).toBe(202)
    expect((await kickoff.json() as Record<string, unknown>).already_running).toBe(true)
    stubBoth(STATUS_BASE, STATUS_EXTRA)
    const status = await fetch(`${base}/api/context/status`)
    expect(status.headers.get('cache-control')).toBe('private, no-store')
  })

  it('rejects control characters and over-length values on search and passages before the bridge', async () => {
    const base = await startTestServer()
    expect((await fetch(`${base}/api/context/graph/search?q=${encodeURIComponent('ab\u0007')}`)).status).toBe(400)
    expect((await fetch(`${base}/api/context/graph/passages?entity=${encodeURIComponent('a\u0007b')}`)).status).toBe(400)
    expect((await fetch(`${base}/api/context/graph/passages?entity=${'x'.repeat(201)}`)).status).toBe(400)
    expect((await fetch(`${base}/api/context/graph/passages?relationA=${'x'.repeat(201)}&relationB=COS`)).status).toBe(400)
    expect((await fetch(`${base}/api/context/graph/passages?relationA=COS&relationB=${encodeURIComponent('a\u0007b')}`)).status).toBe(400)
    expect(callBridge).not.toHaveBeenCalled()
  })
})


describe('review decisions (6.44.7)', () => {
  afterEach(() => { callBridge.mockReset(); contextSource.mockReturnValue('bridge') })

  it('writes a decision through the bridge and returns the normalized row', async () => {
    callBridge.mockResolvedValueOnce({ decision: { lesson_id: 'siq_6bef5169aea2', decision: 'dismissed', ts: '2026-09-07T02:00:00.000000+00:00', event_id: 'evt_0123456789abcdef', by: 'control', note: 'not now', scripts_dir: '/Users/x' }, protocol: 1 })
    const base = await startTestServer()
    const response = await fetch(`${base}/api/context/learning/siq_6bef5169aea2/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'dismissed', note: 'not now' }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ lesson_id: 'siq_6bef5169aea2', decision: 'dismissed', ts: '2026-09-07T02:00:00.000000+00:00', event_id: 'evt_0123456789abcdef', by: 'control' })
    expect(callBridge).toHaveBeenCalledWith(['learning-decide', '--id=siq_6bef5169aea2', '--decision=dismissed', '--note=not now'], 8_000)
  })

  it('refuses a bad decision or lesson id before the bridge, and 503s without a pipeline', async () => {
    const base = await startTestServer()
    expect((await fetch(`${base}/api/context/learning/siq_x/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'later' }) })).status).toBe(400)
    expect((await fetch(`${base}/api/context/learning/${encodeURIComponent('a\u0007b')}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'dismissed' }) })).status).toBe(400)
    expect(callBridge).not.toHaveBeenCalled()
    contextSource.mockReturnValue(null)
    bridgeState.mockReturnValue('pipeline_missing')
    expect((await fetch(`${base}/api/context/learning/siq_x/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'dismissed' }) })).status).toBe(503)
  })

  it('requires the token on the review route too', async () => {
    const app = express()
    app.use('/api', requireApiToken('test-token'))
    app.use('/api', memoryRouter)
    const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)) })
    closers.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect((await fetch(`${base}/api/context/learning/siq_x/review`, { method: 'POST' })).status).toBe(401)
  })
})
