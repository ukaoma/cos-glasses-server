import express from 'express'
import type { Server } from 'node:http'
import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dataPath } from '../lib/data-dir.js'

let server: Server | null = null
let baseUrl = ''
const engineCalls: string[] = []
let admissionsOpen = true

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as any }
}

beforeEach(async () => {
  for (const f of ['lens-gist.json', 'lens-gist-cache.json', 'lens-gist-budget.json', 'lens-gist-runs.jsonl']) rmSync(dataPath(f), { force: true })
  delete process.env.COS_LENS_GIST_ENGINE
  engineCalls.length = 0
  admissionsOpen = true
  vi.resetModules()
  // Every CLI "installed", whatever this machine has (/qa round 1: the route test needed
  // Cursor's agent on the machine running it).
  vi.doMock('../lib/provider-binary.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('../lib/provider-binary.js')>(),
    resolveProviderBinary: (provider: string) => ({ ok: true, path: `/fake/bin/${provider}`, source: 'absolute' }),
  }))
  vi.doMock('../lib/maintenance-lifecycle.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('../lib/maintenance-lifecycle.js')>(),
    maintenanceAdmissionsOpen: () => admissionsOpen,
  }))
  // No real model, no real `agent models`, no real Ollama in a test.
  vi.doMock('../lib/lens-gist-engines.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('../lib/lens-gist-engines.js')>(),
    runLensGistEngine: async (engine: string) => {
      engineCalls.push(engine)
      return { text: 'Outcome: Done\nSo what: Merge when ready\nYou asked: Check it', model: 'claude-sonnet-5' }
    },
    runProcess: async () => ({ code: 0, stdout: 'Available models\n\ngrok-4.7-low-fast - Grok 4.7 Low Fast\n', stderr: '' }),
  }))
  vi.doMock('../lib/ollama-catalog.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('../lib/ollama-catalog.js')>(),
    getOllamaCatalog: async () => ({ ready: false, origin: '', model: '', models: [], refreshedAt: '', error: 'not running' }),
  }))
  const { lensGistRouter } = await import('./lens-gist.js')
  const app = express()
  app.use(express.json())
  app.use('/api', lensGistRouter)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      if (!addr || typeof addr === 'string') throw new Error('no addr')
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

afterEach(async () => {
  await new Promise<void>((resolve) => { server ? server.close(() => resolve()) : resolve() })
  server = null
  vi.doUnmock('../lib/lens-gist-engines.js')
  vi.doUnmock('../lib/ollama-catalog.js')
  vi.doUnmock('../lib/provider-binary.js')
  vi.doUnmock('../lib/maintenance-lifecycle.js')
  vi.resetModules()
  delete process.env.COS_LENS_GIST_ENGINE
})

describe('POST /api/lens-gist', () => {
  it('answers the card, with the engine and the model it resolved to', async () => {
    const res = await call('POST', '/api/lens-gist', { kind: 'session', ask: 'check it', reply: 'All green.' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      status: 'ready', engine: 'claude', model: 'claude-sonnet-5', cached: false,
      gist: { outcome: 'Done', soWhat: 'Merge when ready', asked: 'Check it' },
    })
  })

  it('is a 400 only for a malformed request', async () => {
    expect((await call('POST', '/api/lens-gist', { kind: 'thread', reply: 'x' })).status).toBe(400)
    expect((await call('POST', '/api/lens-gist', { kind: 'message' })).status).toBe(400)
    expect(engineCalls).toEqual([])
  })

  it('gives way to a drain: while admissions are closed it answers unavailable and runs nothing', async () => {
    admissionsOpen = false
    const res = await call('POST', '/api/lens-gist', { kind: 'session', reply: 'x' })
    expect(res).toEqual({ status: 200, json: { status: 'unavailable', reason: 'maintenance' } })
    expect(engineCalls).toEqual([])
  })

  it('answers 200 off, not an error, when the engine is off', async () => {
    process.env.COS_LENS_GIST_ENGINE = 'off'
    const res = await call('POST', '/api/lens-gist', { kind: 'message', reply: 'Hi.' })
    expect(res).toEqual({ status: 200, json: { status: 'off', reason: 'turned off' } })
    expect(engineCalls).toEqual([])
  })
})

describe('/api/lens-gist/config', () => {
  it('lists the four engines with their defaults and the models each can run', async () => {
    const res = await call('GET', '/api/lens-gist/config')
    expect(res.status).toBe(200)
    expect(res.json.engine).toBe('claude')
    expect(res.json.engines.map((e: any) => e.engine)).toEqual(['claude', 'codex', 'cursor', 'ollama'])
    const byEngine = Object.fromEntries(res.json.engines.map((e: any) => [e.engine, e]))
    expect(byEngine.claude.models).toEqual(['sonnet', 'haiku', 'opus'])
    expect(byEngine.cursor.models).toEqual(['grok-4.7-low-fast'])
    expect(byEngine.ollama).toMatchObject({ available: false, detail: 'not running' })
  })

  it('saves a switch the next POST uses', async () => {
    const put = await call('PUT', '/api/lens-gist/config', { engine: 'cursor', model: 'grok-4.7-low-fast' })
    expect(put.json).toMatchObject({ saved: true, effective: { engine: 'cursor', model: 'grok-4.7-low-fast', source: 'config' } })
    await call('POST', '/api/lens-gist', { kind: 'session', reply: 'x' })
    expect(engineCalls).toEqual(['cursor'])
  })

  it('says when the environment overrides the saved choice, and refuses a bad engine', async () => {
    process.env.COS_LENS_GIST_ENGINE = 'claude'
    expect((await call('PUT', '/api/lens-gist/config', { engine: 'codex' })).json).toMatchObject({ saved: true, overriddenByEnv: 'COS_LENS_GIST_ENGINE', effective: { engine: 'claude', source: 'env' } })
    expect((await call('PUT', '/api/lens-gist/config', { engine: 'gpt' })).status).toBe(400)
  })
})
