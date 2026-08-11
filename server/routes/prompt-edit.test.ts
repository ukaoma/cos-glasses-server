import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { request } from 'node:http'
import type { Server } from 'node:http'

let server: Server | null = null
let baseUrl = ''
const applyPromptEdit = vi.fn()

vi.mock('../lib/prompt-edit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/prompt-edit.js')>()
  return {
    ...actual,
    applyPromptEdit,
  }
})

async function startTestServer(): Promise<void> {
  vi.resetModules()
  applyPromptEdit.mockReset()
  const { promptEditRouter } = await import('./prompt-edit.js')
  const app = express()
  app.use(express.json())
  app.use('/api', (req, res, next) => {
    if (req.headers['x-cos-token'] !== 'test-token') return res.status(401).json({ error: 'unauthorized' })
    next()
  })
  app.use('/api', promptEditRouter)
  await new Promise<void>((resolveStart) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      if (!address || typeof address === 'string') throw new Error('server address unavailable')
      baseUrl = `http://127.0.0.1:${address.port}`
      resolveStart()
    })
  })
}

function httpRequest(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Buffer }> {
  const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body))
  return new Promise((resolveRequest, reject) => {
    const req = request(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        ...opts.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

describe('prompt edit route', () => {
  beforeEach(async () => {
    await startTestServer()
  })

  afterEach(async () => {
    await new Promise<void>((resolveClose) => {
      if (!server) return resolveClose()
      server.close(() => resolveClose())
    })
    server = null
    baseUrl = ''
  })

  it('requires auth through the API wrapper', async () => {
    const res = await httpRequest('POST', '/api/prompt-edit', {
      body: { draftText: 'Original prompt', editInstruction: 'Make it shorter', visibleChunk: 'Original prompt', chunkIndex: 0, chunkCount: 1 },
    })

    expect(res.status).toBe(401)
    expect(applyPromptEdit).not.toHaveBeenCalled()
  })

  it('rejects empty and oversized inputs before applying edits', async () => {
    const empty = await httpRequest('POST', '/api/prompt-edit', {
      headers: { 'X-COS-Token': 'test-token' },
      body: { draftText: '', editInstruction: 'Make it shorter', visibleChunk: '', chunkIndex: 0, chunkCount: 1 },
    })
    expect(empty.status).toBe(400)

    const tooLong = await httpRequest('POST', '/api/prompt-edit', {
      headers: { 'X-COS-Token': 'test-token' },
      body: { draftText: 'x'.repeat(24_001), editInstruction: 'Make it shorter', visibleChunk: '', chunkIndex: 0, chunkCount: 1 },
    })
    expect(tooLong.status).toBe(400)
    expect(applyPromptEdit).not.toHaveBeenCalled()
  })

  it('returns revised text from the no-history edit helper', async () => {
    applyPromptEdit.mockResolvedValueOnce('Revised prompt.')

    const res = await httpRequest('POST', '/api/prompt-edit', {
      headers: { 'X-COS-Token': 'test-token' },
      body: {
        draftText: 'Original prompt with pricing.',
        editInstruction: 'Remove the pricing part.',
        visibleChunk: 'Original prompt with pricing.',
        chunkIndex: 0,
        chunkCount: 1,
      },
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body.toString())).toEqual({ revisedText: 'Revised prompt.' })
    expect(applyPromptEdit).toHaveBeenCalledWith({
      draftText: 'Original prompt with pricing.',
      editInstruction: 'Remove the pricing part.',
      visibleChunk: 'Original prompt with pricing.',
      chunkIndex: 0,
      chunkCount: 1,
    }, expect.any(AbortSignal))
  })

  it('does not abort the edit signal mid-flight on a normally completed request', async () => {
    // Regression for the req.on('close') bug: express.json() drains the request
    // stream before the handler runs, so a `req` 'close' listener fires on the
    // next tick and aborts the in-flight claude spawn (instant 500). A real edit
    // awaits a multi-second spawn, so we delay here to let any spurious 'close'
    // fire while the signal is observed.
    let signalAbortedMidFlight: boolean | null = null
    applyPromptEdit.mockImplementationOnce(async (_input: unknown, signal?: AbortSignal) => {
      await new Promise((r) => setTimeout(r, 30))
      signalAbortedMidFlight = signal?.aborted ?? null
      return 'Revised prompt.'
    })

    const res = await httpRequest('POST', '/api/prompt-edit', {
      headers: { 'X-COS-Token': 'test-token' },
      body: {
        draftText: 'Original prompt with pricing.',
        editInstruction: 'Remove the pricing part.',
        visibleChunk: 'Original prompt with pricing.',
        chunkIndex: 0,
        chunkCount: 1,
      },
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body.toString())).toEqual({ revisedText: 'Revised prompt.' })
    // The signal must stay live until we actually respond — never aborted by a
    // request-stream close.
    expect(signalAbortedMidFlight).toBe(false)
  })
})
