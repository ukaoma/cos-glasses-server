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

  // The display-stream capability mirrors the TTS one: admitted on SHAPE at this
  // boundary, signature verified in the route. `/api/display-stream` itself stays in
  // the public set above ON PURPOSE — removing it would 401 every installed client,
  // because neither EventSource in the app can attach a header.
  it.each(['GET', 'HEAD'])('%s admits a shape-valid display-stream capability', async method => {
    const ticket = `1780000000.${'a'.repeat(64)}`
    expect((await request(`/api/display-stream/${ticket}`, { method })).status).toBe(204)
  })

  it.each([
    '/api/display-stream/not-a-ticket',
    '/api/display-stream/1780000000',
    `/api/display-stream/1780000000.${'a'.repeat(63)}`,
    `/api/display-stream/1780000000.${'A'.repeat(64)}`,
    `/api/display-stream/abc.${'a'.repeat(64)}`,
  ])('rejects a malformed display-stream capability %s', async path => {
    expect((await request(path)).status).toBe(401)
  })

  it('does not admit a display-stream capability on a non-GET method', async () => {
    const ticket = `1780000000.${'a'.repeat(64)}`
    expect((await request(`/api/display-stream/${ticket}`, { method: 'POST' })).status).toBe(401)
  })

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
    expect(missingBody.message).toBe('Paste the pairing token from COS Control, or scan its code with COS Glasses 6.10.621 or newer.')
    expect(JSON.stringify(missingBody)).not.toContain(TOKEN)
  })

  // 6.67.0 pairing: exactly two public doors, each exact on METHOD and path.
  const NONCE = 'phone-nonce_0123456789'
  it('admits POST /api/pairing/claim and GET /api/pairing/claim/<nonce> without a token', async () => {
    expect((await request('/api/pairing/claim', { method: 'POST' })).status).toBe(204)
    expect((await request(`/api/pairing/claim/${NONCE}`)).status).toBe(204)
  })

  it.each([
    ['GET', '/api/pairing/code'],
    ['POST', '/api/pairing/code'],
    ['GET', '/api/pairing/status'],
    ['POST', '/api/pairing/decision'],
    ['GET', '/api/pairing/claim'],
    ['PUT', '/api/pairing/claim'],
    ['DELETE', '/api/pairing/claim'],
    ['POST', `/api/pairing/claim/${NONCE}`],
    ['HEAD', `/api/pairing/claim/${NONCE}`],
    ['GET', '/api/pairing/claim/short'],
    ['GET', `/api/pairing/claim/${'a'.repeat(65)}`],
    ['GET', `/api/pairing/claim/${NONCE}/extra`],
    ['GET', '/api/pairing/claim/has.dot.in.it.0123456789'],
    ['GET', `/api/evil/pairing/claim/${NONCE}`],
    ['GET', `/api/x/pairing/claim/${NONCE}`],
  ])('keeps %s %s behind the token', async (method, path) => {
    expect((await request(path, { method })).status).toBe(401)
  })

  it('calls onAuthenticated only for requests that passed the token check', async () => {
    const seen: string[] = []
    const app = express()
    app.use('/api', requireApiToken(TOKEN, { onAuthenticated: req => { seen.push(req.path) } }))
    app.all('/api/*path', (_req, res) => res.status(204).end())
    const local = await new Promise<Server>(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
    })
    try {
      const address = local.address()
      const url = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
      await fetch(`${url}/api/health`)
      await fetch(`${url}/api/models`)
      await fetch(`${url}/api/models`, { headers: { 'x-cos-token': 'wrong-token' } })
      await fetch(`${url}/api/models`, { headers: { 'x-cos-token': TOKEN } })
      expect(seen).toEqual(['/models'])
    } finally {
      await new Promise<void>(resolve => local.close(() => resolve()))
    }
  })

  it('continues to accept X-Cos-Token on protected routes', async () => {
    const response = await request('/api/tts/prepare', {
      headers: { 'x-cos-token': TOKEN },
    })
    expect(response.status).toBe(204)
  })
})
