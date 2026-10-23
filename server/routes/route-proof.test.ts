// 6.88.0 LAN first: GET /api/route-proof behind the real /api auth boundary (docs/lan-first.md).
import express from 'express'
import { createHmac } from 'node:crypto'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { requireApiToken } from '../lib/api-auth.js'
import { verifyDisplayTicket } from '../lib/display-ticket.js'
import { ROUTE_PROOF_IP_LIMIT, RouteProofRateLimiter } from '../lib/lan-first.js'
import { createRouteProofRouter } from './route-proof.js'

const TOKEN = 'route-proof-test-token-0123456789abcdef'
const OTHER_TOKEN = 'route-proof-other-token-0123456789abcdef'
const ID = '11111111-2222-4333-8444-555555555555'
const NONCE = 'phoneNonce_0123456789-AB'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))))
})

async function start(opts: { token?: string; id?: string | null; env?: NodeJS.ProcessEnv; limiter?: RouteProofRateLimiter } = {}): Promise<string> {
  const token = opts.token ?? TOKEN
  const app = express()
  app.use('/api', requireApiToken(token))
  app.use('/api', createRouteProofRouter({
    token: () => token,
    serverInstanceId: () => (opts.id === undefined ? ID : opts.id),
    env: () => opts.env ?? {},
    limiter: opts.limiter,
  }))
  app.all('/api/*path', (_req, res) => res.status(204).end())
  const server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  servers.push(server)
  const address = server.address()
  return typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
}

const expectedProof = (token: string, nonce: string, id: string) =>
  createHmac('sha256', token).update(`cos-route-proof:v1:${nonce}:${id}`).digest('hex')

describe('GET /api/route-proof', () => {
  it('answers a stranger with no token: instance id plus the HMAC, nothing else', async () => {
    const base = await start()
    const res = await fetch(`${base}/api/route-proof?nonce=${NONCE}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ v: 1, serverInstanceId: ID, proof: expectedProof(TOKEN, NONCE, ID) })
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(NONCE)
  })

  it('a phone holding the right token verifies the proof; a phone holding a wrong token does not', async () => {
    const base = await start()
    const body = await (await fetch(`${base}/api/route-proof?nonce=${NONCE}`)).json() as { proof: string; serverInstanceId: string }
    expect(body.proof).toBe(expectedProof(TOKEN, NONCE, body.serverInstanceId))
    expect(body.proof).not.toBe(expectedProof(OTHER_TOKEN, NONCE, body.serverInstanceId))
  })

  it('a Mac with a different token gives a different proof for the same nonce and id (the wrong-Mac case)', async () => {
    const ours = await start()
    const theirs = await start({ token: OTHER_TOKEN })
    const a = await (await fetch(`${ours}/api/route-proof?nonce=${NONCE}`)).json() as { proof: string }
    const b = await (await fetch(`${theirs}/api/route-proof?nonce=${NONCE}`)).json() as { proof: string }
    expect(a.proof).not.toBe(b.proof)
    expect(b.proof).toBe(expectedProof(OTHER_TOKEN, NONCE, ID))
  })

  it('binds the server instance id: the proof is over the id it reports, and another id breaks it', async () => {
    const otherId = '99999999-2222-4333-8444-555555555555'
    const base = await start({ id: otherId })
    const body = await (await fetch(`${base}/api/route-proof?nonce=${NONCE}`)).json() as { proof: string; serverInstanceId: string }
    expect(body.serverInstanceId).toBe(otherId)
    expect(body.proof).toBe(expectedProof(TOKEN, NONCE, otherId))
    expect(body.proof).not.toBe(expectedProof(TOKEN, NONCE, ID))
  })

  it('is not a token oracle: the caller cannot get the HMAC of a message it chose', async () => {
    const base = await start()
    // Every message the route signs begins with the fixed prefix, so the HMAC of a bare
    // attacker string, or a display-stream ticket signature, is never returned.
    const body = await (await fetch(`${base}/api/route-proof?nonce=${NONCE}`)).json() as { proof: string }
    expect(body.proof).not.toBe(createHmac('sha256', TOKEN).update(NONCE).digest('hex'))
    const exp = Math.floor(Date.now() / 1000) + 600
    expect(verifyDisplayTicket(TOKEN, `${exp}.${body.proof}`)).toBe(false)
    // A nonce that tries to smuggle a message separator or a ticket purpose is refused outright.
    for (const nonce of [`display-stream:${exp}`, `${'A'.repeat(22)}:${ID}`, `${'A'.repeat(22)}%0A`]) {
      expect((await fetch(`${base}/api/route-proof?nonce=${nonce}`)).status).toBe(400)
    }
  })

  it.each([
    ['missing', ''],
    ['empty', '?nonce='],
    ['too short', `?nonce=${'A'.repeat(21)}`],
    ['too long', `?nonce=${'A'.repeat(65)}`],
    ['bad characters', `?nonce=${'A'.repeat(21)}.`],
    ['repeated', `?nonce=${NONCE}&nonce=${NONCE}`],
    ['bracketed', `?nonce[a]=${NONCE}`],
  ])('a %s nonce gives 400 bad_nonce', async (_label, query) => {
    const base = await start()
    const res = await fetch(`${base}/api/route-proof${query}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ v: 1, reason: 'bad_nonce' })
  })

  it('trips the per-address rate limit with a Retry-After, and bad nonces spend the same budget', async () => {
    const base = await start({ limiter: new RouteProofRateLimiter() })
    for (let i = 0; i < ROUTE_PROOF_IP_LIMIT; i++) {
      const res = await fetch(`${base}/api/route-proof?nonce=${i % 2 ? NONCE : 'bad'}`)
      expect(res.status).toBe(i % 2 ? 200 : 400)
    }
    const limited = await fetch(`${base}/api/route-proof?nonce=${NONCE}`)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await limited.json()).toEqual({ v: 1, reason: 'rate_limited' })
  })

  it('answers 503 not_ready before the instance id is minted, and for a token too short to expose', async () => {
    for (const opts of [{ id: null }, { token: 'short-token-0123456789' }]) {
      const base = await start(opts)
      const res = await fetch(`${base}/api/route-proof?nonce=${NONCE}`)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ v: 1, reason: 'not_ready' })
    }
  })

  it('answers 404 disabled with COS_LAN_FIRST=0', async () => {
    const base = await start({ env: { COS_LAN_FIRST: '0' } })
    const res = await fetch(`${base}/api/route-proof?nonce=${NONCE}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ v: 1, reason: 'disabled' })
  })

  it('keeps every other verb behind the token, and refuses it even with the token', async () => {
    const base = await start()
    for (const method of ['HEAD', 'POST', 'PUT', 'DELETE']) {
      expect((await fetch(`${base}/api/route-proof?nonce=${NONCE}`, { method })).status).toBe(401)
    }
    const withToken = await fetch(`${base}/api/route-proof?nonce=${NONCE}`, { method: 'POST', headers: { 'x-cos-token': TOKEN } })
    expect(withToken.status).toBe(405)
    expect(withToken.headers.get('allow')).toBe('GET')
  })

  it('opens exactly one path', async () => {
    const base = await start()
    for (const path of ['/api/route-proof/', '/api/route-proof/x', '/api/x/route-proof', '/api/route-proofs', '/api/Route-Proof']) {
      expect((await fetch(`${base}${path}?nonce=${NONCE}`)).status).toBe(401)
    }
  })

  it('does not read a token from the query string or let one change the answer', async () => {
    const base = await start()
    const plain = await (await fetch(`${base}/api/route-proof?nonce=${NONCE}`)).json()
    const withQueryToken = await (await fetch(`${base}/api/route-proof?nonce=${NONCE}&token=${OTHER_TOKEN}`)).json()
    expect(withQueryToken).toEqual(plain)
  })
})
