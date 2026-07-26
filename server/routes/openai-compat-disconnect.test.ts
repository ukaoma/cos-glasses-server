import express from 'express'
import http, { type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  calls: [] as Array<{ callbacks: any; signal?: AbortSignal }>,
  releases: [] as Array<ReturnType<typeof vi.fn>>,
  callModelStreaming: vi.fn(),
}))

vi.mock('../lib/claude-bridge.js', () => ({
  preWarmCLI: vi.fn(async () => {}),
  logLatency: vi.fn(),
}))
vi.mock('../lib/model-router.js', () => ({ callModelStreaming: state.callModelStreaming }))
vi.mock('../lib/codex-model-catalog.js', () => ({
  getCodexModelCatalog: vi.fn(async () => ({ options: [] })),
  resolveCodexPreferenceForModelId: vi.fn(() => undefined),
}))
vi.mock('../lib/response-cache.js', () => ({ tryInstantResponse: vi.fn(() => null) }))
vi.mock('../lib/maintenance-lifecycle.js', () => ({
  acquireMaintenanceWork: vi.fn(() => {
    const release = vi.fn()
    state.releases.push(release)
    return { id: 'lease-test', setPhase: vi.fn(), release }
  }),
  MaintenanceLifecycleError: class MaintenanceLifecycleError extends Error {},
}))

import { openaiCompatRouter } from './openai-compat.js'

let server: Server
let base = ''

beforeAll(async () => {
  delete process.env.COS_API_TOKEN
  const app = express()
  app.use(express.json())
  app.use(openaiCompatRouter)
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('OpenAI-compatible disconnect lifecycle', () => {
  it('holds the lease through provider abort, then clears inflight state at terminal error', async () => {
    state.calls.length = 0
    state.releases.length = 0
    state.callModelStreaming.mockReset()
    state.callModelStreaming.mockImplementation(async (_query: string, _sid: string, callbacks: any, ...args: any[]) => {
      const options = args.at(-1)
      state.calls.push({ callbacks, signal: options?.abortSignal })
      if (state.calls.length === 2) {
        setTimeout(() => callbacks.onDone('second request completed'), 0)
      }
      return `session-${state.calls.length}`
    })

    const endpoint = new URL('/v1/chat/completions', base)
    const disconnected = new Promise<void>((resolve, reject) => {
      const request = http.request(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, response => {
        response.once('data', () => {
          request.destroy()
          resolve()
        })
      })
      request.once('error', error => {
        if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error)
      })
      request.end(JSON.stringify({
        model: 'cos-opus',
        stream: true,
        messages: [{ role: 'user', content: 'disconnect lifecycle probe' }],
      }))
    })

    await disconnected
    await vi.waitFor(() => expect(state.calls).toHaveLength(1))
    await vi.waitFor(() => expect(state.calls[0].signal?.aborted).toBe(true))
    expect(state.releases[0]).not.toHaveBeenCalled()

    state.calls[0].callbacks.onError('provider terminal after close')
    await vi.waitFor(() => expect(state.releases[0]).toHaveBeenCalledTimes(1))

    const retry = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cos-opus',
        stream: true,
        messages: [{ role: 'user', content: 'disconnect lifecycle probe' }],
      }),
    })
    expect(retry.status).toBe(200)
    expect(await retry.text()).toContain('data: [DONE]')
    expect(state.callModelStreaming).toHaveBeenCalledTimes(2)
    expect(state.releases[1]).toHaveBeenCalledTimes(1)
  })
})
