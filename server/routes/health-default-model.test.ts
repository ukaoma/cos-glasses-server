// 7.0.2 (A7): /api/models says what "Default" in a model picker resolves to, in model-router's order:
// the request's model, then the session's preference, then COS_G2_DEFAULT_MODEL, then DEFAULT_MODEL.
import express from 'express'
import type { Server } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { healthRouter, resolveDefaultModel } from './health.js'
import { getOrCreateSession, setSessionModel } from '../lib/conversation.js'
import { DEFAULT_MODEL } from '../../shared/model-preference.js'

const PROFILE_ID = 'a7-test-profile'

let server: Server | null = null
let base = ''
const ENV = process.env.COS_G2_DEFAULT_MODEL
beforeAll(async () => {
  const app = express()
  app.use('/api', healthRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server!.address()
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
})
afterAll(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()) })
afterEach(() => { if (ENV === undefined) delete process.env.COS_G2_DEFAULT_MODEL; else process.env.COS_G2_DEFAULT_MODEL = ENV })

describe('resolveDefaultModel (7.0.2 A7)', () => {
  it('request, then session, then COS_G2_DEFAULT_MODEL, then DEFAULT_MODEL', () => {
    expect(resolveDefaultModel({ requested: 'opus', sessionModel: 'sonnet', env: 'codex-frontier' })).toEqual({ preference: 'opus', source: 'request' })
    expect(resolveDefaultModel({ sessionModel: 'fable', env: 'codex-frontier' })).toEqual({ preference: 'fable', source: 'session' })
    expect(resolveDefaultModel({ env: 'codex-frontier' })).toEqual({ preference: 'codex-frontier', source: 'env' })
    expect(resolveDefaultModel({})).toEqual({ preference: DEFAULT_MODEL, source: 'built-in' })
  })
  it('an env value that is not a model slot, or names a key profile, falls through to DEFAULT_MODEL', () => {
    expect(resolveDefaultModel({ env: 'gpt-nonsense' })).toEqual({ preference: DEFAULT_MODEL, source: 'built-in' })
    expect(resolveDefaultModel({ env: 'profile:abc' })).toEqual({ preference: DEFAULT_MODEL, source: 'built-in' })
  })
  it('a session bound to a key profile: source profile, never named, ahead of the env default (QA W5)', () => {
    expect(resolveDefaultModel({ sessionProfile: true, env: 'codex-frontier' })).toEqual({ preference: null, source: 'profile' })
    expect(resolveDefaultModel({ sessionModel: 'opus', sessionProfile: true })).toEqual({ preference: 'opus', source: 'session' })
  })
})

describe('/api/models defaultModel (7.0.2 A7)', () => {
  it('reports the env default on this Mac (Miles: COS_G2_DEFAULT_MODEL=codex-frontier)', async () => {
    process.env.COS_G2_DEFAULT_MODEL = 'codex-frontier'
    const body = await (await fetch(`${base}/api/models`)).json() as any
    expect(body.defaultModel).toEqual({ preference: 'codex-frontier', source: 'env' })
  }, 20_000)
  it('no env: the built-in default', async () => {
    delete process.env.COS_G2_DEFAULT_MODEL
    const body = await (await fetch(`${base}/api/models`)).json() as any
    expect(body.defaultModel).toEqual({ preference: DEFAULT_MODEL, source: 'built-in' })
  }, 20_000)
  it('?sessionId= adds that session\'s preference; an unknown id reads as no session', async () => {
    process.env.COS_G2_DEFAULT_MODEL = 'codex-frontier'
    const sid = getOrCreateSession('a7-default-model-test')
    setSessionModel(sid, 'opus')
    const body = await (await fetch(`${base}/api/models?sessionId=${encodeURIComponent(sid)}`)).json() as any
    expect(body.defaultModel).toEqual({ preference: 'opus', source: 'session' })
    const bad = await (await fetch(`${base}/api/models?sessionId=${encodeURIComponent('../x y')}`)).json() as any
    expect(bad.defaultModel).toEqual({ preference: 'codex-frontier', source: 'env' })
    setSessionModel(sid, `profile:${PROFILE_ID}` as any)
    const bound = await (await fetch(`${base}/api/models?sessionId=${encodeURIComponent(sid)}`)).json() as any
    expect(bound.defaultModel).toEqual({ preference: null, source: 'profile' })
  }, 20_000)
})
