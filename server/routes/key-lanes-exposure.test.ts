// Key lanes P1 (plan v4 3.1 acceptance): /api/health and /api/models with the switch off, on with
// no profile, and active. The shape (every nested key path) is compared across states, so the
// only difference allowed is `details.keyLanes` on health while enabled and `keyProfiles` on
// models while active.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'

const dataDir = mkdtempSync(join(tmpdir(), 'key-lanes-exposure-'))
process.env.COS_DATA_DIR = dataDir
delete process.env.COS_KEY_LANES

const { healthRouter } = await import('./health.js')
const lanes = await import('../lib/key-lanes.js')
const store = await import('../lib/key-store.js')
const profiles = await import('../lib/key-profiles.js')

// Built at run time so no key-shaped literal sits in the source (GitHub push protection).
const FAKE_KEY = ['sk', 'or', 'v1', 'abcd'.repeat(15) + '1234'].join('-')
let server: Server
let base = ''
beforeAll(async () => {
  const app = express(); app.use('/api', healthRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address(); base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}, 30_000)
afterAll(() => { server.close(); rmSync(dataDir, { recursive: true, force: true }); delete process.env.COS_KEY_LANES })
beforeEach(() => {
  delete process.env.COS_KEY_LANES
  for (const f of readdirSync(dataDir)) if (/^(key-lanes\.json|key-secrets|provider-profiles\.json)$/.test(f)) rmSync(join(dataDir, f), { recursive: true })
  lanes.__resetKeyLanesForTests()
})

/** Every key path in a JSON value; array elements share one `[]` segment. */
function paths(value: unknown, prefix = ''): Set<string> {
  const out = new Set<string>()
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) { for (const x of v) walk(x, `${p}[]`); return }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(`${p}.${k}`); walk(x, `${p}.${k}`) }
  }
  walk(value, prefix)
  return out
}
const getJson = async (path: string) => (await fetch(base + path)).json() as Promise<Record<string, unknown>>
const diff = (a: Set<string>, b: Set<string>) => ({ added: [...b].filter(x => !a.has(x)).sort(), removed: [...a].filter(x => !b.has(x)).sort() })
const keyLanesFiles = () => readdirSync(dataDir).filter(f => /^(key-lanes\.json|key-secrets|provider-profiles\.json)$/.test(f))

describe('exposure list (plan 3.1)', () => {
  it('switch off: no key-lanes field anywhere on health or models, and no key-lanes file', async () => {
    for (const sw of [undefined, '0']) {
      if (sw === undefined) delete process.env.COS_KEY_LANES; else process.env.COS_KEY_LANES = sw
      const health = await getJson('/api/health')
      const models = await getJson('/api/models')
      expect('details' in health).toBe(false)
      expect('keyProfiles' in models).toBe(false)
      expect(JSON.stringify(health)).not.toMatch(/keyLanes|keyProfiles/)
      expect(JSON.stringify(models)).not.toMatch(/keyLanes|keyProfiles/)
    }
    expect(keyLanesFiles()).toEqual([])
  }, 30_000)

  it('switch on, no profile: health adds exactly details.keyLanes {enabled:true, active:false}; models is unchanged', async () => {
    const offHealth = paths(await getJson('/api/health')), offModels = paths(await getJson('/api/models'))
    process.env.COS_KEY_LANES = '1'
    const health = await getJson('/api/health'), models = await getJson('/api/models')
    expect(health.details).toEqual({ keyLanes: { enabled: true, active: false } })
    expect(diff(offHealth, paths(health))).toEqual({ added: ['.details', '.details.keyLanes', '.details.keyLanes.active', '.details.keyLanes.enabled'], removed: [] })
    expect(diff(offModels, paths(models))).toEqual({ added: [], removed: [] })
    expect(keyLanesFiles()).toEqual([])
  }, 30_000)

  it('active: models adds exactly keyProfiles, and neither surface carries the key', async () => {
    const offModels = paths(await getJson('/api/models'))
    process.env.COS_KEY_LANES = '1'
    const key = store.saveKey({ kind: 'openrouter', secret: FAKE_KEY, capUsd: 1 })
    const v = profiles.validateProfileInput({ id: 'sonnet', label: 'Sonnet', keyRef: key.ref, engine: 'claude', model: 'anthropic/claude-sonnet-5.5' }, r => store.getPublicKey(r)?.kind)
    if (!v.ok) throw new Error(v.message)
    profiles.upsertProfile(v.profile)
    const health = await getJson('/api/health'), models = await getJson('/api/models')
    expect(health.details).toEqual({ keyLanes: { enabled: true, active: true } })
    expect(models.keyProfiles).toEqual([{ id: 'sonnet', label: 'Sonnet', engine: 'claude', model: 'anthropic/claude-sonnet-5.5', keyKind: 'openrouter', timeoutTier: 'sonnet' }])
    expect(diff(offModels, paths(models)).added.filter(p => !p.startsWith('.keyProfiles'))).toEqual([])
    expect(JSON.stringify(health) + JSON.stringify(models)).not.toContain(FAKE_KEY.slice(0, 20))
  }, 30_000)
})
