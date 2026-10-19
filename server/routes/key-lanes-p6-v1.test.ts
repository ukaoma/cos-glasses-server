// Key lanes K1, package P6 (plan v4 9.4, D8): the OpenAI-compatible door. /v1/models stays open
// and byte-identical until a key lane is active, then asks for the chat Bearer and lists
// `cos-key-<id>` for profiles with "Offer on /v1" on. On chat, `cos-key-<id>` is handled before
// the closed resolveModel and runs only for an offered profile; every other one is refused, never
// answered on the subscription. Scratch HOME and data dir; model-router is a recording mock.
import express from 'express'
import type { Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const scratch = mkdtempSync(join(tmpdir(), 'key-lanes-p6-v1-'))
const dataDir = join(scratch, 'data')
mkdirSync(dataDir, { recursive: true })
process.env.HOME = scratch
process.env.COS_DATA_DIR = dataDir
process.env.COS_PROFILE_PATH = join(dataDir, 'profile.json')
delete process.env.COS_KEY_LANES

const state = vi.hoisted(() => ({ callModelStreaming: vi.fn() }))
vi.mock('../lib/claude-bridge.js', () => ({ preWarmCLI: vi.fn(async () => {}), logLatency: vi.fn() }))
vi.mock('../lib/model-router.js', () => ({ callModelStreaming: state.callModelStreaming }))
vi.mock('../lib/codex-model-catalog.js', () => ({
  getCodexModelCatalog: vi.fn(async () => ({ options: [{ id: 'gpt-5.5' }] })),
  resolveCodexPreferenceForModelId: vi.fn(() => undefined),
}))
vi.mock('../lib/response-cache.js', () => ({ tryInstantResponse: vi.fn(() => null) }))
vi.mock('../lib/maintenance-lifecycle.js', () => ({
  acquireMaintenanceWork: vi.fn(() => ({ id: 'lease-test', setPhase: vi.fn(), release: vi.fn() })),
  MaintenanceLifecycleError: class MaintenanceLifecycleError extends Error {},
}))

const lanes = await import('../lib/key-lanes.js')
const store = await import('../lib/key-store.js')
const profiles = await import('../lib/key-profiles.js')
const { openaiCompatRouter } = await import('./openai-compat.js')

const TOKEN = 'test-cos-token-p6'
const BASE_IDS = ['cos-opus', 'cos-fable', 'cos-sonnet', 'cos-haiku', 'cos-gpt-frontier', 'cos-gpt-balanced', 'gpt-5.5']
let server: Server
let base = ''

function saveProfile(id: string, offerOnV1: boolean, enabled = true) {
  const key = store.saveKey({ kind: 'openrouter', secret: 'sk-or-v1-' + 'ef'.repeat(32), capUsd: 1 })
  const v = profiles.validateProfileInput({ id, label: id, keyRef: key.ref, engine: 'claude', model: 'anthropic/claude-sonnet-5.5', enabled, offerOnV1 }, ref => store.getPublicKey(ref)?.kind)
  if (!v.ok) throw new Error(v.message)
  profiles.upsertProfile(v.profile)
}

async function models(bearer?: string) {
  const res = await fetch(`${base}/v1/models`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} })
  return { status: res.status, body: await res.json() as any }
}

async function chat(model: string) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: `hello ${model} ${Math.random()}` }] }),
  })
  return { status: res.status, body: await res.json() as any }
}

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use(openaiCompatRouter)
  server = await new Promise<Server>(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)) })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})
afterAll(async () => {
  delete process.env.COS_API_TOKEN
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(scratch, { recursive: true, force: true })
})
beforeEach(() => {
  process.env.COS_API_TOKEN = TOKEN
  delete process.env.COS_KEY_LANES
  for (const f of ['key-lanes.json', 'provider-keys.json', 'provider-profiles.json']) rmSync(join(dataDir, f), { force: true })
  lanes.refreshKeyLanesEnabled()
  state.callModelStreaming.mockReset()
  state.callModelStreaming.mockImplementation(async (_q: string, sid: string, callbacks: any) => {
    setTimeout(() => callbacks.onDone('answer'), 0)
    return sid ?? 'g2-session'
  })
})

describe('/v1/models (plan 9.4, D8)', () => {
  it('lane not active: open with no Bearer and exactly the 6.79.0 list, even with lanes enabled and no profile', async () => {
    const off = await models()
    expect(off.status).toBe(200)
    expect(off.body.data.map((m: any) => m.id)).toEqual(BASE_IDS)
    process.env.COS_KEY_LANES = '1'
    const enabledNoProfile = await models()
    expect(enabledNoProfile.status).toBe(200)
    expect(enabledNoProfile.body).toEqual(off.body)
  })

  it('lane active: no or wrong Bearer is 401; the right Bearer lists only offered, enabled profiles', async () => {
    process.env.COS_KEY_LANES = '1'
    saveProfile('offered', true)
    saveProfile('hidden', false)
    saveProfile('offered-off', true, false)
    expect((await models()).status).toBe(401)
    expect((await models('wrong')).status).toBe(401)
    const ok = await models(TOKEN)
    expect(ok.status).toBe(200)
    expect(ok.body.data.map((m: any) => m.id)).toEqual([...BASE_IDS, 'cos-key-offered'])
    expect(ok.body.data.at(-1)).toEqual({ id: 'cos-key-offered', object: 'model', created: 1709251200, owned_by: 'cos-key' })
  })
})

describe('/v1/chat/completions with cos-key-<id>', () => {
  it('an offered profile runs as profile:<id> and answers under its cos-key name', async () => {
    process.env.COS_KEY_LANES = '1'
    saveProfile('offered', true)
    const res = await chat('cos-key-offered')
    expect(res.status).toBe(200)
    expect(state.callModelStreaming).toHaveBeenCalledTimes(1)
    expect(state.callModelStreaming.mock.calls[0][3]).toBe('profile:offered')
    expect(res.body.model).toBe('cos-key-offered')
  })

  it('a profile not offered on /v1, a disabled or unknown one, or lanes off: 400, never the subscription', async () => {
    process.env.COS_KEY_LANES = '1'
    saveProfile('hidden', false)
    saveProfile('offered-off', true, false)
    for (const name of ['cos-key-hidden', 'cos-key-offered-off', 'cos-key-ghost']) {
      const res = await chat(name)
      expect(res.status).toBe(400)
      expect(res.body.error).toMatchObject({ code: 'model_not_offered', type: 'invalid_request_error' })
    }
    process.env.COS_KEY_LANES = '0'
    saveProfile('offered', true)
    expect((await chat('cos-key-offered')).status).toBe(400)
    expect(state.callModelStreaming).not.toHaveBeenCalled()
  })

  it('every other model name takes the 6.79.0 path unchanged', async () => {
    process.env.COS_KEY_LANES = '1'
    saveProfile('offered', true)
    const res = await chat('cos-sonnet')
    expect(res.status).toBe(200)
    expect(state.callModelStreaming.mock.calls[0][3]).toBe('sonnet')
    expect(res.body.model).toBe('cos-sonnet')
    // A malformed cos-key- name is not a profile: it falls to resolveModel's default as before.
    await chat('cos-key-')
    expect(state.callModelStreaming.mock.calls[1][3]).toBe('sonnet')
  })
})
