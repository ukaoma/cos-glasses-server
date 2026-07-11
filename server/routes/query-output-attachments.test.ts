import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/model-router.js', () => ({
  callModelStreaming: vi.fn(async (
    _query: string,
    sessionId: string | undefined,
    callbacks: { onDone: (...args: unknown[]) => void },
  ) => {
    const sid = sessionId ?? 'standalone-output-test'
    setTimeout(() => callbacks.onDone('answer', 'opus', undefined, {
      outputAttachments: [{
        id: `m_${'b'.repeat(24)}`,
        kind: 'generated_visual',
        mime: 'image/jpeg',
        width: 96,
        height: 64,
        createdAt: '2026-07-11T12:00:00.000Z',
        label: 'Research image',
      }],
      outputImageStats: { published: 1, attached: 1, rejected: 0 },
    }), 5)
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
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('standalone query output attachment contract', () => {
  it('publishes one canonical refs-only attachments field', async () => {
    const response = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'research an image' }),
    })
    const stream = await response.text()
    const block = stream.split('\n\n').find(part => part.includes('event: done'))
    expect(block).toBeTruthy()
    const done = JSON.parse(block!.split('data: ')[1])
    expect(done.attachments).toHaveLength(1)
    expect(done.attachments[0]).toMatchObject({
      id: `m_${'b'.repeat(24)}`,
      kind: 'generated_visual',
      label: 'Research image',
    })
    expect(done.outputImageStats).toEqual({ published: 1, attached: 1, rejected: 0 })
    expect('outputAttachments' in done).toBe(false)
    expect(stream).not.toContain('storagePath')
    expect(stream).not.toContain('original-normalized')
  })
})
