import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireApiToken } from './api-auth.js'

const TOKEN = 'test-api-token'
const VALID_UNKNOWN_CAPABILITY = '00000000-0000-4000-8000-000000000000'

let server: Server
let base = ''

beforeAll(async () => {
  const app = express()
  app.use('/api', requireApiToken(TOKEN))
  app.all('/api/*path', (_req, res) => res.status(204).end())
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, init)
}

describe('global API authentication boundary', () => {
  it.each(['/api/health', '/api/display-stream', '/api/diag/client', '/api/diag/health'])(
    'preserves the intentional public route %s',
    async path => expect((await request(path)).status).toBe(204),
  )

  it.each(['GET', 'HEAD'])('%s allows a canonical TTS playback capability without a header', async method => {
    const response = await request(`/api/tts/play/${VALID_UNKNOWN_CAPABILITY}`, { method })
    expect(response.status).toBe(204)
  })

  it.each([
    '/api/tts/prepare',
    '/api/tts/stream',
    '/api/tts/play/not-a-uuid',
    `/api/tts/playback/${VALID_UNKNOWN_CAPABILITY}`,
    `/api/tts/play/${VALID_UNKNOWN_CAPABILITY}/extra`,
  ])('does not widen the unauthenticated boundary to %s', async path => {
    expect((await request(path)).status).toBe(401)
  })

  it('rejects mutation methods even when the path contains a valid capability', async () => {
    expect((await request(`/api/tts/play/${VALID_UNKNOWN_CAPABILITY}`, { method: 'POST' })).status)
      .toBe(401)
  })

  it('does not accept credentials in the query string', async () => {
    expect((await request(`/api/tts/prepare?token=${TOKEN}`)).status).toBe(401)
  })

  it('returns actionable, non-secret pairing guidance without changing the stable error code', async () => {
    const missing = await request('/api/models')
    const wrong = await request('/api/models', { headers: { 'x-cos-token': 'not-the-token' } })
    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
    const missingBody = await missing.json()
    const wrongBody = await wrong.json()
    expect(missingBody).toEqual(wrongBody)
    expect(missingBody).toMatchObject({
      error: 'unauthorized',
      reason: 'pairing_token_rejected',
    })
    expect(missingBody.message).toContain('Copy Pairing Token')
    expect(JSON.stringify(missingBody)).not.toContain(TOKEN)
  })

  it('continues to accept X-Cos-Token on protected routes', async () => {
    const response = await request('/api/tts/prepare', {
      headers: { 'x-cos-token': TOKEN },
    })
    expect(response.status).toBe(204)
  })
})
