import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.COS_DATA_DIR = `/tmp/cos-ollama-bridge-test-${process.pid}-${Date.now()}`
  process.env.COS_OLLAMA_RUN_LEDGER_FILE = `${process.env.COS_DATA_DIR}/ollama-runs.jsonl`
})

import {
  _resetOllamaCatalogCache,
  _setOllamaCatalogFetchForTests,
} from './ollama-catalog.js'
import {
  callOllamaStreaming,
  historyToOllamaMessages,
  parseOllamaChatDelta,
} from './ollama-bridge.js'
import type { StreamCallbacks } from './claude-bridge.js'

function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`))
      controller.close()
    },
  })
}

function collectCallbacks() {
  const chunks: string[] = []
  let error: string | undefined
  let done: string | undefined
  const callbacks: StreamCallbacks = {
    onChunk: text => { chunks.push(text) },
    onError: async message => { error = message },
    onDone: async text => { done = text },
  }
  return { callbacks, chunks, result: () => ({ chunks, error, done }) }
}

describe('ollama bridge', () => {
  afterEach(() => {
    _resetOllamaCatalogCache()
    _setOllamaCatalogFetchForTests(null)
    delete process.env.COS_CODEX_EXTRA_ARGS
  })

  it('parses streamed chat deltas', () => {
    expect(parseOllamaChatDelta('{"message":{"content":"Hi"},"done":false}')).toEqual({
      content: 'Hi', done: false,
    })
    expect(parseOllamaChatDelta('{"message":{"content":""},"done":true}')).toEqual({
      content: '', done: true,
    })
    expect(parseOllamaChatDelta('{"error":"model not found"}').error).toBe('model not found')
  })

  it('maps history without repeating the current user turn', () => {
    const messages = historyToOllamaMessages([
      { role: 'user', content: 'one', timestamp: 1 },
      { role: 'assistant', content: 'two', timestamp: 2 },
    ], [])
    expect(messages).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ])
  })

  it('streams a local reply and ignores COS_CODEX_EXTRA_ARGS', async () => {
    process.env.COS_CODEX_EXTRA_ARGS = '--oss --local-provider ollama --model stolen'
    const chatBodies: unknown[] = []
    _setOllamaCatalogFetchForTests(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      chatBodies.push(init?.body ? JSON.parse(String(init.body)) : null)
      return new Response(ndjsonStream([
        '{"message":{"role":"assistant","content":"Hello "},"done":false}',
        '{"message":{"role":"assistant","content":"there"},"done":true}',
      ]), { status: 200 })
    })

    const collected = collectCallbacks()
    await callOllamaStreaming('ping', 's-ollama-1', collected.callbacks)
    const result = collected.result()
    expect(result.done).toBe('Hello there')
    expect(result.chunks.join('')).toBe('Hello there')
    expect(result.error).toBeUndefined()
    expect(chatBodies[0]).toMatchObject({
      model: 'llama3.2:latest',
      stream: true,
      // The default request DISABLES thinking. Omitting the key would let a
      // thinking-class model ruminate for minutes before the first visible
      // token; sending false costs nothing on models that cannot think.
      think: false,
    })
    expect(JSON.stringify(chatBodies[0])).not.toContain('--oss')
  })

  it('resolves COS_OLLAMA_THINK: off by default, on or leveled by explicit opt-in', async () => {
    const { resolveOllamaThink } = await import('./ollama-bridge.js')
    expect(resolveOllamaThink(undefined)).toBe(false)
    expect(resolveOllamaThink('')).toBe(false)
    expect(resolveOllamaThink('0')).toBe(false)
    expect(resolveOllamaThink('banana')).toBe(false)
    expect(resolveOllamaThink('1')).toBe(true)
    expect(resolveOllamaThink('true')).toBe(true)
    expect(resolveOllamaThink('HIGH')).toBe('high')
    expect(resolveOllamaThink(' low ')).toBe('low')
  })

  it('refuses photos', async () => {
    const collected = collectCallbacks()
    await callOllamaStreaming('what is this', 's-ollama-2', collected.callbacks, [
      { path: '/tmp/x.jpg', mimeType: 'image/jpeg', attachment: { id: 'm_1', kind: 'image' } } as any,
    ])
    expect(collected.result().error).toMatch(/text-only/i)
    expect(collected.result().done).toBeUndefined()
  })

  it('fails closed when Ollama is down', async () => {
    _setOllamaCatalogFetchForTests(async () => { throw new Error('ECONNREFUSED') })
    const collected = collectCallbacks()
    await callOllamaStreaming('ping', 's-ollama-3', collected.callbacks)
    expect(collected.result().error).toMatch(/not running|Ollama/i)
  })
})
