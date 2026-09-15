// Fireflies key storage and its routes.
//
// The property every assertion here defends: the key goes IN and never comes
// back out. It is stored at 0600 under a 0700 directory, and no status, save
// response or check response contains it.

import express from 'express'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FirefliesBudget, FirefliesClient, type FirefliesTransportOutcome } from './fireflies-client.js'
import { FIREFLIES_KEY_ENV, FirefliesKeyError, FirefliesKeyStore } from './fireflies-key.js'
import { createFirefliesKeyRouter } from '../routes/fireflies-key.js'

const KEY = 'ff_live_key_9876543210abcdef'
const roots: string[] = []
const servers: Server[] = []
const savedEnv = process.env[FIREFLIES_KEY_ENV]

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cos-fireflies-key-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  if (savedEnv == null) delete process.env[FIREFLIES_KEY_ENV]
  else process.env[FIREFLIES_KEY_ENV] = savedEnv
})

function store(): FirefliesKeyStore {
  return new FirefliesKeyStore({ path: join(newRoot(), 'keys', 'fireflies-key.json') })
}

function clientFor(keyStore: FirefliesKeyStore, outcome: () => FirefliesTransportOutcome): FirefliesClient {
  return new FirefliesClient({
    transport: async () => outcome(),
    key: () => keyStore.key(),
    budget: new FirefliesBudget({ path: join(newRoot(), '.fireflies-budget.json') }),
  })
}

const okUser: FirefliesTransportOutcome = {
  kind: 'http', status: 200, headers: {}, body: JSON.stringify({ data: { user: { user_id: 'u1' } } }),
}

describe('storage', () => {
  it('writes the key 0600 inside a 0700 directory', () => {
    const keyStore = store()
    keyStore.save(KEY)
    expect(statSync(keyStore.path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(keyStore.path)).mode & 0o777).toBe(0o700)
    expect(keyStore.key()).toBe(KEY)
  })

  it('never returns the key in a status', () => {
    const keyStore = store()
    keyStore.save(KEY)
    const status = keyStore.status()
    expect(status).toMatchObject({ configured: true, source: 'config' })
    expect(JSON.stringify(status)).not.toContain(KEY)
  })

  it('lets an environment key win, and says so', () => {
    const keyStore = store()
    keyStore.save(KEY)
    process.env[FIREFLIES_KEY_ENV] = 'ff_env_key_1234567890abcd'
    expect(keyStore.key()).toBe('ff_env_key_1234567890abcd')
    expect(keyStore.status().source).toBe('env')
  })

  it.each([
    ['too short', 'ff_short'],
    ['with a space', 'ff key 0123456789abcdef'],
    ['too long', `ff_${'x'.repeat(600)}`],
  ])('refuses a key %s', (_label, candidate) => {
    expect(() => store().save(candidate)).toThrow(FirefliesKeyError)
  })

  it('refuses a key that is not a string', () => {
    expect(() => store().save(undefined)).toThrow(FirefliesKeyError)
    expect(() => store().save({ key: KEY })).toThrow(FirefliesKeyError)
  })

  it('treats a symlinked key file as no key at all', () => {
    const keyStore = store()
    const elsewhere = join(newRoot(), 'somebody-elses-secret.json')
    writeFileSync(elsewhere, JSON.stringify({ key: 'ff_not_mine_012345678901' }))
    mkdirSync(dirname(keyStore.path), { recursive: true, mode: 0o700 })
    symlinkSync(elsewhere, keyStore.path)
    expect(keyStore.key()).toBeNull()
    expect(keyStore.status().configured).toBe(false)
  })

  it('records a check, and stamps validatedAt only when it passed', () => {
    const keyStore = store()
    keyStore.save(KEY)
    keyStore.recordCheck({ state: 'invalid_key', httpStatus: 500, checkedAt: '2026-09-14T10:00:00.000Z', cached: false })
    expect(keyStore.status().validatedAt).toBeUndefined()
    expect(keyStore.status().lastCheck?.state).toBe('invalid_key')

    keyStore.recordCheck({ state: 'ok', checkedAt: '2026-09-14T11:00:00.000Z', cached: false })
    expect(keyStore.status().validatedAt).toBe('2026-09-14T11:00:00.000Z')
    expect(readFileSync(keyStore.path, 'utf8')).toContain('lastCheck')
  })

  it('removes the key on delete', () => {
    const keyStore = store()
    keyStore.save(KEY)
    keyStore.delete()
    expect(existsSync(keyStore.path)).toBe(false)
    expect(keyStore.status()).toEqual({ configured: false, source: 'none' })
    // Deleting again is the same end state, not an error.
    expect(() => keyStore.delete()).not.toThrow()
  })
})

describe('routes', () => {
  async function harness(outcome: () => FirefliesTransportOutcome = () => okUser) {
    const keyStore = store()
    const client = clientFor(keyStore, outcome)
    const changed: Array<{ configured: boolean }> = []
    const checked: string[] = []
    const app = express()
    app.use(express.json())
    app.use('/api', createFirefliesKeyRouter({
      store: () => keyStore,
      client: () => client,
      onKeyChanged: event => { changed.push(event) },
      onKeyChecked: check => { checked.push(check.state) },
    }))
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)
    await new Promise<void>(resolve => server.once('listening', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no address')
    return { base: `http://127.0.0.1:${address.port}`, keyStore, changed, checked }
  }

  it('stores the key then checks it, and echoes neither', async () => {
    const { base, keyStore, changed, checked } = await harness()
    const response = await fetch(`${base}/api/fireflies-key/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: KEY }),
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).not.toContain(KEY)
    expect(JSON.parse(body).check.state).toBe('ok')
    expect(keyStore.key()).toBe(KEY)
    expect(changed).toEqual([{ configured: true }])
    expect(checked).toEqual(['ok'])
  })

  it('refuses a bad key with a code a surface can render', async () => {
    const { base } = await harness()
    const response = await fetch(`${base}/api/fireflies-key/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'nope' }),
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('key_length_invalid')
  })

  it('reports status without the key and without calling out', async () => {
    const calls: number[] = []
    const { base, keyStore } = await harness(() => { calls.push(1); return okUser })
    keyStore.save(KEY)
    const status = await (await fetch(`${base}/api/fireflies-key/status`)).json()
    expect(status).toMatchObject({ configured: true, source: 'config' })
    expect(JSON.stringify(status)).not.toContain(KEY)
    expect(calls).toEqual([])
  })

  it('checks on demand and tells the importer what happened', async () => {
    const { base, keyStore, checked } = await harness(() => ({
      kind: 'http',
      status: 500,
      headers: {},
      body: JSON.stringify({ errors: [{ code: 'auth_failed' }] }),
    }))
    keyStore.save(KEY)
    const check = await (await fetch(`${base}/api/fireflies-key/check`, { method: 'POST' })).json()
    expect(check.state).toBe('invalid_key')
    expect(checked).toEqual(['invalid_key'])
  })

  it('deletes the key', async () => {
    const { base, keyStore, changed } = await harness()
    keyStore.save(KEY)
    const response = await fetch(`${base}/api/fireflies-key`, { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect(keyStore.key()).toBeNull()
    expect(changed).toEqual([{ configured: false }])
  })
})
