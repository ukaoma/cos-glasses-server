// Key lanes K1, package P6 (plan v4 5.2): claude-steer's resolveRunModel / providerOfModel stay
// CLOSED; an explicit guard names a profile-bound job `profile_session`, and the profile's engine
// decides. With no profile anywhere the verdict is the 6.78.0 provider, exactly.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'key-lanes-p6-steer-'))
const dataDir = join(scratch, 'data')
mkdirSync(dataDir, { recursive: true })
process.env.HOME = scratch
process.env.COS_DATA_DIR = dataDir
process.env.COS_PROFILE_PATH = join(dataDir, 'profile.json')
delete process.env.COS_KEY_LANES

const steer = await import('./claude-steer.js')
const lanes = await import('./key-lanes.js')
const store = await import('./key-store.js')
const profiles = await import('./key-profiles.js')
const routing = await import('./key-profile-routing.js')

function saveProfile(id: string, engine: 'claude' | 'codex' | 'direct', model: string, enabled = true) {
  const key = store.saveKey({ kind: 'openrouter', secret: 'sk-or-v1-' + 'cd'.repeat(32), capUsd: 1 })
  const v = profiles.validateProfileInput({ id, label: id, keyRef: key.ref, engine, model, enabled }, ref => store.getPublicKey(ref)?.kind)
  if (!v.ok) throw new Error(v.message)
  profiles.upsertProfile(v.profile)
}

beforeEach(() => {
  delete process.env.COS_KEY_LANES
  for (const f of ['key-lanes.json', 'provider-keys.json', 'provider-profiles.json']) rmSync(join(dataDir, f), { force: true })
  lanes.refreshKeyLanesEnabled()
})
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

const MODELS = [undefined, '', 'opus', 'fable', 'sonnet', 'haiku', 'codex-high', 'codex-frontier', 'codex-balanced', 'cursor-grok', 'cursor-composer', 'ollama', 'junk', 42]
const SESSION = [null, undefined, 'opus', 'codex-balanced', 'cursor-grok', 'ollama'] as const
const ENV = [undefined, 'haiku', 'codex-frontier', 'profile:sonnet', 'junk']

describe('steerProviderFor with no profile (G-journeys steer identical)', () => {
  it('equals providerOfModel(resolveRunModel(...)) for every model, session model and env default', () => {
    let cases = 0
    for (const model of MODELS) for (const session of SESSION) for (const env of ENV) {
      const verdict = steer.steerProviderFor(model, session as never, env, () => null)
      expect(verdict).toEqual({ kind: 'provider', provider: steer.providerOfModel(steer.resolveRunModel(model, session as never, env)) })
      cases++
    }
    expect(cases).toBe(MODELS.length * SESSION.length * ENV.length)
  })

  it('reads the session binding only when nothing else names the model', () => {
    const binding = vi.fn(() => 'profile:sonnet')
    steer.steerProviderFor('opus', null, undefined, binding)
    steer.steerProviderFor(undefined, 'opus', undefined, binding)
    expect(binding).not.toHaveBeenCalled()
    steer.steerProviderFor(undefined, null, undefined, binding)
    expect(binding).toHaveBeenCalledTimes(1)
  })
})

describe('the explicit profile_session guard', () => {
  it('a profile request, or no model in a profile-bound session, is profile_session (never the Claude default)', () => {
    expect(steer.steerProviderFor('profile:gpt', null, undefined, () => null)).toEqual({ kind: 'profile_session', profileId: 'gpt' })
    expect(steer.steerProviderFor(undefined, null, 'opus', () => 'profile:gpt')).toEqual({ kind: 'profile_session', profileId: 'gpt' })
    // An explicit model slot in a profile-bound session is a subscription turn.
    expect(steer.steerProviderFor('codex-frontier', null, undefined, () => 'profile:gpt')).toEqual({ kind: 'provider', provider: 'codex' })
    // The closed functions are unchanged: a profile is not a model.
    expect(steer.resolveRunModel('profile:gpt', null, undefined)).toBe('sonnet')
  })

  it('only an active, enabled Lane B Claude profile steers; Codex, direct, disabled and lanes-off do not', () => {
    process.env.COS_KEY_LANES = '1'
    saveProfile('claudekey', 'claude', 'anthropic/claude-sonnet-5.5')
    saveProfile('gpt', 'codex', 'openai/gpt-5.5')
    saveProfile('direct1', 'direct', 'google/gemini-3-pro')
    saveProfile('offkey', 'claude', 'anthropic/claude-haiku-5.5', false)
    expect(routing.profileSteerProvider('claudekey')).toBe('claude')
    expect(routing.profileSteerProvider('gpt')).not.toBe('claude')
    expect(routing.profileSteerProvider('direct1')).not.toBe('claude')
    expect(routing.profileSteerProvider('offkey')).not.toBe('claude')
    expect(routing.profileSteerProvider('ghost')).not.toBe('claude')
    process.env.COS_KEY_LANES = '0'
    expect(routing.profileSteerProvider('claudekey')).not.toBe('claude')
  })

  it('a Codex profile session is never offered Claude steering end to end (guard plus engine)', () => {
    process.env.COS_KEY_LANES = '1'
    saveProfile('gpt', 'codex', 'openai/gpt-5.5')
    const verdict = steer.steerProviderFor(undefined, null, undefined, () => 'profile:gpt')
    const provider = verdict.kind === 'profile_session' ? routing.profileSteerProvider(verdict.profileId) : verdict.provider
    expect(provider).not.toBe('claude')
  })
})
