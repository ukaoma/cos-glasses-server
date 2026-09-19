// The Ollama bridge reports its own loop to the Messages trail (6.52.0): one prose entry
// per round and a step plus outcome per tool call. Without a trail consumer the run is
// exactly the same. Harness pattern from ollama-bridge.test.ts.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.COS_DATA_DIR = `/tmp/cos-ollama-trail-test-${process.pid}-${Date.now()}`
  process.env.COS_OLLAMA_RUN_LEDGER_FILE = `${process.env.COS_DATA_DIR}/ollama-runs.jsonl`
})

vi.mock('./meeting-library-search.js', () => ({
  searchMeetingLibrary: vi.fn(async () => ({ hits: [], keywordCount: 0, semanticCount: 0, semanticAvailable: true })),
}))
vi.mock('./context-library-search.js', () => ({
  searchMemories: vi.fn(async () => ({ hits: [], keywordCount: 0, semanticCount: 0, semanticAvailable: true })),
}))

import { _resetOllamaCatalogCache, _setOllamaCatalogFetchForTests } from './ollama-catalog.js'
import { callOllamaStreaming } from './ollama-bridge.js'
import type { JobTrailDraft } from './job-trail.js'

function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`))
      controller.close()
    },
  })
}

function toolAwareFetch(chats: unknown[], responses: string[][]) {
  let call = 0
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen3.8:27b' }] }), { status: 200 })
    if (url.endsWith('/api/show')) return new Response(JSON.stringify({ capabilities: ['tools'] }), { status: 200 })
    chats.push(init?.body ? JSON.parse(String(init.body)) : null)
    const lines = responses[Math.min(call, responses.length - 1)]!
    call += 1
    return new Response(ndjsonStream(lines), { status: 200 })
  }
}

const ROUNDS = [
  [
    '{"message":{"role":"assistant","content":"Let me search the meetings."},"done":false}',
    '{"message":{"role":"assistant","content":"","tool_calls":[{"id":"c1","function":{"name":"search_meetings","arguments":{"query":"pricing review"}}}]},"done":false}',
    '{"message":{"role":"assistant","content":""},"done":true}',
  ],
  ['{"message":{"role":"assistant","content":"Found "},"done":false}', '{"message":{"role":"assistant","content":"it."},"done":true}'],
]

const scratch: string[] = []

afterAll(() => {
  rmSync(process.env.COS_DATA_DIR!, { recursive: true, force: true })
})
const priorScriptsDir = process.env.COS_SCRIPTS_DIR

afterEach(() => {
  _resetOllamaCatalogCache()
  _setOllamaCatalogFetchForTests(null)
  if (priorScriptsDir === undefined) delete process.env.COS_SCRIPTS_DIR
  else process.env.COS_SCRIPTS_DIR = priorScriptsDir
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true })
})

async function drive(withTrail: boolean, sessionId: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cos-ollama-trail-scripts-'))
  scratch.push(dir)
  process.env.COS_SCRIPTS_DIR = dir
  _resetOllamaCatalogCache()
  const chats: unknown[] = []
  _setOllamaCatalogFetchForTests(toolAwareFetch(chats, ROUNDS) as any)
  const calls: Array<[string, unknown[]]> = []
  const trail: JobTrailDraft[] = []
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, JSON.parse(JSON.stringify(args ?? []))]) }
  await callOllamaStreaming('what did we decide on pricing', sessionId, {
    onChunk: record('onChunk'),
    onToolStatus: record('onToolStatus'),
    onDone: async (...args: unknown[]) => { record('onDone')(...args) },
    onError: async (...args: unknown[]) => { record('onError')(...args) },
    ...(withTrail ? { onTrail: (draft: JobTrailDraft) => { trail.push(draft) } } : {}),
  })
  return { calls, trail, chats }
}

describe('the Ollama bridge and the trail', () => {
  it('reports each round once and each tool call as a step with its outcome, changing nothing else', async () => {
    const without = await drive(false, 's-ollama-trail-a')
    const withTrail = await drive(true, 's-ollama-trail-b')
    expect(without.trail).toEqual([])
    expect(withTrail.trail).toEqual([
      { kind: 'prose', text: 'Let me search the meetings.' },
      { kind: 'tool', verb: 'search', target: 'pricing review', detail: '' },
      { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: '' } },
      { kind: 'prose', text: 'Found it.' },
    ])
    // Run ids are random per run; everything else must match.
    const runIds = (calls: unknown) => JSON.parse(JSON.stringify(calls).replace(/ollama-[0-9a-f]{8}/g, 'ollama-<run>'))
    expect(runIds(withTrail.calls)).toEqual(runIds(without.calls))
    expect(JSON.stringify(withTrail.chats).replaceAll('s-ollama-trail-b', 's')).toBe(JSON.stringify(without.chats).replaceAll('s-ollama-trail-a', 's'))
    expect(withTrail.calls.find(([name]) => name === 'onDone')?.[1][0]).toBe('Let me search the meetings.Found it.')
  })
})
