// Key lanes P1 (plan v4 3.1): the predicates, the response-field helpers, the key and profile
// stores. Runs on a private temp data dir; never the live ~/.cos-glasses.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'key-lanes-lib-'))
process.env.COS_DATA_DIR = dataDir
delete process.env.COS_KEY_LANES

const lanes = await import('./key-lanes.js')
const store = await import('./key-store.js')
const profiles = await import('./key-profiles.js')
const { dataPath } = await import('./data-dir.js')

const FAKE_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function wipe() {
  for (const f of readdirSync(dataDir)) rmSync(join(dataDir, f), { recursive: true, force: true })
  lanes.__resetKeyLanesForTests()
}
const listing = () => readdirSync(dataDir).sort()

beforeEach(() => { delete process.env.COS_KEY_LANES; wipe() })
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); delete process.env.COS_KEY_LANES })

function saveProfile(enabled = true) {
  const key = store.saveKey({ kind: 'openrouter', secret: FAKE_KEY, capUsd: 1 })
  const v = profiles.validateProfileInput({ id: 'sonnet', label: 'Sonnet', keyRef: key.ref, engine: 'claude', model: 'anthropic/claude-sonnet-5.5', enabled }, ref => store.getPublicKey(ref)?.kind)
  if (!v.ok) throw new Error(v.message)
  profiles.upsertProfile(v.profile)
  return key
}

describe('key lanes predicates (plan 3.1)', () => {
  it('runs on temp data only', () => {
    expect(dataPath('x').startsWith(dataDir)).toBe(true)
  })

  it('switch unset and no file: disabled, inactive, and no file is created by reading', () => {
    expect(lanes.keyLanesEnvSwitch()).toBe('unset')
    expect(lanes.keyLanesEnabled()).toBe(false)
    expect(lanes.keyLanesActive()).toBe(false)
    expect(lanes.keyLanesHealthFields()).toEqual({})
    expect(lanes.keyProfilesModelsField()).toEqual({})
    expect(store.listPublicKeys()).toEqual([])
    expect(profiles.listProfiles()).toEqual([])
    expect(listing()).toEqual([])
  })

  it('COS_KEY_LANES=0 forces off and wins over an enabled file; nothing is written', () => {
    lanes.setKeyLanesEnabled(true)
    saveProfile()
    const before = listing()
    process.env.COS_KEY_LANES = '0'
    lanes.refreshKeyLanesEnabled()
    expect(lanes.keyLanesEnabled()).toBe(false)
    expect(lanes.keyLanesActive()).toBe(false)
    expect(lanes.keyLanesHealthFields()).toEqual({})
    expect(lanes.keyProfilesModelsField()).toEqual({})
    expect(listing()).toEqual(before)
  })

  it('only the exact value 1 turns the switch on', () => {
    for (const v of ['true', 'yes', 'on', '2', ' ', '']) {
      process.env.COS_KEY_LANES = v
      lanes.refreshKeyLanesEnabled()
      expect(lanes.keyLanesEnabled(), v).toBe(false)
    }
    process.env.COS_KEY_LANES = '1'
    expect(lanes.keyLanesEnabled()).toBe(true)
    expect(listing()).toEqual([])
  })

  it('switch on with no profile: enabled, NOT active; health says so and models adds nothing', () => {
    process.env.COS_KEY_LANES = '1'
    expect(lanes.keyLanesEnabled()).toBe(true)
    expect(lanes.keyLanesActive()).toBe(false)
    expect(lanes.keyLanesHealthFields()).toEqual({ details: { keyLanes: { enabled: true, active: false } } })
    expect(lanes.keyProfilesModelsField()).toEqual({})
    expect(listing()).toEqual([])
  })

  it('a disabled profile does not make lanes active; an enabled one does, and models lists it without the key', () => {
    process.env.COS_KEY_LANES = '1'
    saveProfile(false)
    expect(lanes.keyLanesActive()).toBe(false)
    const ref = store.listPublicKeys()[0].ref
    const v = profiles.validateProfileInput({ id: 'sonnet', label: 'Sonnet', keyRef: ref, engine: 'claude', model: 'anthropic/claude-sonnet-5.5', enabled: true }, r => store.getPublicKey(r)?.kind)
    if (!v.ok) throw new Error(v.message)
    profiles.upsertProfile(v.profile)
    expect(lanes.keyLanesActive()).toBe(true)
    expect(lanes.keyLanesHealthFields()).toEqual({ details: { keyLanes: { enabled: true, active: true } } })
    const field = lanes.keyProfilesModelsField()
    expect(field).toEqual({ keyProfiles: [{ id: 'sonnet', label: 'Sonnet', engine: 'claude', model: 'anthropic/claude-sonnet-5.5', keyKind: 'openrouter', timeoutTier: 'sonnet' }] })
    expect(JSON.stringify(field)).not.toContain(FAKE_KEY)
  })

  it('keyProfiles lists only enabled profiles whose key still exists', () => {
    process.env.COS_KEY_LANES = '1'
    const key = saveProfile(true)
    const off = profiles.validateProfileInput({ id: 'haiku', label: 'Haiku', keyRef: key.ref, engine: 'claude', model: 'anthropic/claude-haiku-5.5', enabled: false }, r => store.getPublicKey(r)?.kind)
    if (!off.ok) throw new Error(off.message)
    profiles.upsertProfile(off.profile)
    profiles.upsertProfile({ ...off.profile, id: 'orphan', enabled: true, keyRef: 'key_000000000000' })
    expect(profiles.listProfiles().map(p => p.id)).toEqual(['sonnet', 'haiku', 'orphan'])
    expect(lanes.keyProfilesModelsField().keyProfiles?.map(p => p.id)).toEqual(['sonnet'])
  })

  it('the state file enables lanes, is 0600, and is read once until refreshed', () => {
    lanes.setKeyLanesEnabled(true)
    const file = lanes.keyLanesStatePath()
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(lanes.keyLanesEnabled()).toBe(true)
    writeFileSync(file, JSON.stringify({ v: 1, enabled: false }))
    expect(lanes.keyLanesEnabled()).toBe(true)
    lanes.refreshKeyLanesEnabled()
    expect(lanes.keyLanesEnabled()).toBe(false)
  })

  it('a torn state file reads as off and is left exactly as it was', () => {
    const file = lanes.keyLanesStatePath()
    writeFileSync(file, '{"v":1,"enab')
    expect(lanes.keyLanesEnabled()).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{"v":1,"enab')
    expect(listing()).toEqual(['key-lanes.json'])
  })

  it('inactive hooks all run, and one throwing does not stop the rest', async () => {
    const seen: string[] = []
    lanes.onKeyLanesInactive('a', r => { seen.push(`a:${r}`); throw new Error('boom') })
    lanes.onKeyLanesInactive('b', r => { seen.push(`b:${r}`) })
    lanes.onKeyLanesInactive('b', r => { seen.push(`b2:${r}`) })
    expect(await lanes.runKeyLanesInactiveHooks('remove_all')).toEqual(['a'])
    expect(seen).toEqual(['a:remove_all', 'b2:remove_all'])
  })
})

describe('key store (plan 4, 10.3, 12)', () => {
  it('saves 0600 atomically in a 0700 dir, with no temp file left, and never lists the secret', () => {
    const rec = store.saveKey({ kind: 'openrouter', secret: FAKE_KEY, capUsd: 1 })
    expect(rec).toEqual({ ref: rec.ref, kind: 'openrouter', last4: FAKE_KEY.slice(-4), capUsd: 1, savedAt: rec.savedAt })
    expect(rec.ref).toMatch(/^key_[0-9a-f]{12}$/)
    const file = store.keyStorePath()
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(dataDir).mode & 0o777).toBe(0o700)
    expect(listing()).toEqual(['provider-keys.json'])
    expect(JSON.stringify(store.listPublicKeys())).not.toContain(FAKE_KEY)
    expect(JSON.stringify(store.getPublicKey(rec.ref))).not.toContain(FAKE_KEY)
    expect(store.readKeySecretForRelay(rec.ref)).toBe(FAKE_KEY)
  })

  it('the same secret saved twice keeps one record and its ref; a cap update keeps the secret', () => {
    const a = store.saveKey({ kind: 'openrouter', secret: FAKE_KEY, capUsd: 1 })
    const b = store.saveKey({ kind: 'openrouter', secret: FAKE_KEY, capUsd: 2 })
    expect(b.ref).toBe(a.ref)
    expect(store.listPublicKeys()).toHaveLength(1)
    expect(store.updateKeyCap(a.ref, 0.5)?.capUsd).toBe(0.5)
    expect(store.readKeySecretForRelay(a.ref)).toBe(FAKE_KEY)
    expect(store.updateKeyCap('key_000000000000', 1)).toBeUndefined()
  })

  it('a corrupt store reads as empty and is not moved or rewritten', () => {
    writeFileSync(store.keyStorePath(), 'not json')
    expect(store.listPublicKeys()).toEqual([])
    expect(readFileSync(store.keyStorePath(), 'utf8')).toBe('not json')
    expect(listing()).toEqual(['provider-keys.json'])
  })

  it('shape, cap and URL checks', () => {
    expect(store.keyShapeProblem('openrouter', FAKE_KEY)).toBeNull()
    expect(store.keyShapeProblem('openrouter', 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxx')).toMatch(/OpenRouter/)
    expect(store.keyShapeProblem('anthropic', 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxx')).toBeNull()
    expect(store.keyShapeProblem('openai', 'sk-proj-xxxxxxxxxxxxxxxxxxxx')).toBeNull()
    expect(store.keyShapeProblem('openrouter', 'sk-or- with space xxxxxxxxxxxx')).toMatch(/does not look/)
    expect(store.keyShapeProblem('openrouter', 'sk-or-short')).toMatch(/too short/)
    expect(store.normalizeCapUsd(undefined)).toBe(1)
    expect(store.normalizeCapUsd(0.004)).toBeNull()
    expect(store.normalizeCapUsd(2.499)).toBe(2.5)
    expect(store.normalizeCapUsd(Number.NaN)).toBeNull()
    expect(store.normalizeCompatibleBaseUrl('https://llm.example.com/v1/')).toBe('https://llm.example.com/v1')
    expect(store.normalizeCompatibleBaseUrl('https://user:pw@llm.example.com/v1')).toBeNull()
    expect(store.normalizeCompatibleBaseUrl('file:///etc/passwd')).toBeNull()
  })

  it('remove-all helpers delete only their own files', () => {
    saveProfile()
    mkdirSync(join(dataDir, 'other'))
    expect(store.deleteKeyStore()).toBe(true)
    expect(profiles.deleteProfilesFile()).toBe(true)
    expect(store.deleteKeyStore()).toBe(false)
    expect(listing()).toEqual(['other'])
    expect(existsSync(store.keyStorePath())).toBe(false)
  })
})

describe('key profiles (plan 4.4 at save time)', () => {
  const kindOf = (k: 'openrouter' | 'anthropic' | 'openai') => () => k
  const base = { id: 'p1', label: 'P', keyRef: 'key_0123456789ab' }
  it('Lane B Claude takes anthropic/ on OpenRouter or claude- on an Anthropic key, nothing else', () => {
    expect(profiles.validateProfileInput({ ...base, engine: 'claude', model: 'anthropic/claude-haiku-5.5' }, kindOf('openrouter')).ok).toBe(true)
    expect(profiles.validateProfileInput({ ...base, engine: 'claude', model: 'claude-sonnet-5-5' }, kindOf('anthropic')).ok).toBe(true)
    const bad = profiles.validateProfileInput({ ...base, engine: 'claude', model: 'openai/gpt-x' }, kindOf('openrouter'))
    expect(bad.ok ? '' : bad.error).toBe('model_not_allowed')
  })
  it('Lane B Codex takes openai/ on OpenRouter or a bare id on an OpenAI key', () => {
    expect(profiles.validateProfileInput({ ...base, engine: 'codex', model: 'openai/gpt-x' }, kindOf('openrouter')).ok).toBe(true)
    expect(profiles.validateProfileInput({ ...base, engine: 'codex', model: 'gpt-x' }, kindOf('openai')).ok).toBe(true)
    expect(profiles.validateProfileInput({ ...base, engine: 'codex', model: 'anthropic/claude-sonnet-5.5' }, kindOf('openrouter')).ok).toBe(false)
  })
  it('direct tools and /v1 are off unless asked; an unknown key and a bad id are refused', () => {
    const v = profiles.validateProfileInput({ ...base, engine: 'direct', model: 'meta/llama-x' }, kindOf('openrouter'))
    expect(v.ok && v.profile.directTools === false && v.profile.offerOnV1 === false && v.profile.enabled === true).toBe(true)
    const unknown = profiles.validateProfileInput({ ...base, engine: 'direct', model: 'm' }, () => undefined)
    expect(unknown.ok ? '' : unknown.error).toBe('unknown_key')
    expect(profiles.validateProfileInput({ ...base, id: 'Bad Id', engine: 'direct', model: 'm' }, kindOf('openrouter')).ok).toBe(false)
    expect(profiles.validateProfileInput({ ...base, engine: 'direct', model: 'm' }, kindOf('anthropic')).ok).toBe(false)
  })
})
