// A bridge that calls back BEFORE it resolves must still get a terminal event.
//
// query-sse-payload.test.ts mocks the router to fire callbacks on a macrotask
// AFTER callModelStreaming resolves, and its comment states that bridges
// "never" call back synchronously because they are child-process driven. The
// Ollama bridge is not: it is an in-process HTTP loop that awaits its own
// finalizeDone before returning, so every callback runs INSIDE the route's
// `const sid = await callModelStreaming(...)`.
//
// That window is a temporal dead zone for `sid`. `onDone` read it, threw
// ReferenceError after already setting `done = true`, and returned without
// writing `event: done` — so the socket stayed open forever on a turn whose
// answer had already been persisted. Measured on device 2026-08-26: the
// glasses counted past 1,100 seconds on a turn that finished in 166.
//
// This file pins the callback ORDER the other file assumes away.

import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/message-era.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/message-era.js')>()
  return {
    ...actual,
    currentMessageEra: () => 'era-inprocess-test',
    currentMessageEraState: () => ({ v: 1 as const, era: 'era-inprocess-test', startedAt: 1 }),
  }
})

// The Ollama shape: callbacks fire, awaited, BEFORE the promise resolves.
vi.mock('../lib/model-router.js', () => ({
  callModelStreaming: vi.fn(async (
    _query: string,
    sessionId: string | undefined,
    callbacks: {
      onStart?: (...a: unknown[]) => void
      onChunk: (t: string) => void
      onToolStatus?: (name: string) => void
      onDone: (...a: unknown[]) => void | Promise<void>
    },
  ) => {
    const sid = sessionId ?? 'inprocess-session'
    callbacks.onStart?.('ollama', sid, undefined, { ollamaRunId: 'ollama-test' })
    callbacks.onToolStatus?.('search_meetings')
    callbacks.onChunk('grounded ')
    callbacks.onChunk('answer')
    // Awaited inline — exactly what callOllamaStreaming's finalizeDone does.
    await callbacks.onDone('grounded answer', 'ollama', undefined, { ollamaRunId: 'ollama-test' })
    return sid
  }),
}))

import { queryRouter } from './query.js'

let server: Server
let base = ''

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', queryRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

async function collectSse(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${base}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + 8_000
  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>(resolve =>
          setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1, deadline - Date.now()))),
      ])
      if (result.value) buf += decoder.decode(result.value, { stream: true })
      const idx = buf.indexOf('event: done')
      if (idx >= 0 && buf.indexOf('\n\n', idx) >= 0) break
      if (result.done) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return buf
}

describe('a bridge that calls back inside its own await', () => {
  it('still receives a terminal done event', async () => {
    const body = await collectSse({
      query: 'search my meetings',
      sessionId: 'inprocess-a',
      model: 'ollama',
      messageEra: 'era-inprocess-test',
    })
    // The regression: chunks arrived and the stream then hung forever.
    expect(body).toContain('event: chunk')
    expect(body).toContain('event: done')
  })

  it('carries the session id in the done payload rather than throwing on it', async () => {
    const body = await collectSse({
      query: 'search my meetings',
      sessionId: 'inprocess-b',
      model: 'ollama',
      messageEra: 'era-inprocess-test',
    })
    const idx = body.indexOf('event: done')
    expect(idx).toBeGreaterThanOrEqual(0)
    const line = body.slice(idx).split('\n').find(l => l.startsWith('data: '))!
    const payload = JSON.parse(line.slice(6))
    // Reading the outer `const sid` here is what threw ReferenceError.
    expect(payload.sessionId).toBe('inprocess-b')
    expect(payload.text).toBe('grounded answer')
  })

  it('reports the tool status before the terminal event', async () => {
    const body = await collectSse({
      query: 'search my meetings',
      sessionId: 'inprocess-c',
      model: 'ollama',
      messageEra: 'era-inprocess-test',
    })
    expect(body.indexOf('event: tool_status')).toBeGreaterThanOrEqual(0)
    expect(body.indexOf('event: tool_status')).toBeLessThan(body.indexOf('event: done'))
  })
})
