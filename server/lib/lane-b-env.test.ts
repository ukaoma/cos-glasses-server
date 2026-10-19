// Key lanes K1 P3 (plan v4 7.2): the Lane B child env and the settings-layer guard, as units.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  applyLaneBClaudeEnv,
  isLaneBStrippedName,
  laneBBaseEnv,
  LANE_B_CLAUDE_MODEL_NAMES,
} from './lane-b-env.js'
import { claudeSettingsFiles, claudeSettingsRefusal } from './claude-settings-guard.js'

const SPEC = { origin: 'http://127.0.0.1:40123', nonce: 'nonce-abc', slug: 'anthropic/claude-haiku-5.5', profileId: 'haiku-key' }

describe('Lane B child env', () => {
  it('strips only provider-credential names; PATH, COS_API_TOKEN and the rest stay', () => {
    const base = {
      PATH: '/usr/bin', HOME: '/Users/x', COS_API_TOKEN: 't', NODE_OPTIONS: '--x', SOME_API_KEY: 'kept',
      ANTHROPIC_API_KEY: 'a', ANTHROPIC_DEFAULT_FABLE_MODEL: 'f', CLAUDE_CODE_USE_FOUNDRY: '1', OPENROUTER_API_KEY: 'o',
    }
    const env = laneBBaseEnv(base)
    expect(Object.keys(env).sort()).toEqual(['COS_API_TOKEN', 'HOME', 'NODE_OPTIONS', 'PATH', 'SOME_API_KEY'])
    expect(base.ANTHROPIC_API_KEY).toBe('a') // the base is never written
    expect(isLaneBStrippedName('ANTHROPIC_DEFAULT_OPUS_MODEL')).toBe(true)
    expect(isLaneBStrippedName('ANTHROPIC_SOMETHING_ELSE')).toBe(false)
  })

  it('applies the relay URL, nonce, empty API key, retries, slug on every model name and the marker; teams stay off', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', ANTHROPIC_MODEL: 'claude-x' }
    applyLaneBClaudeEnv(env, SPEC)
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:40123/relay/a')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('nonce-abc')
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe('2')
    for (const n of LANE_B_CLAUDE_MODEL_NAMES) expect(env[n]).toBe(SPEC.slug)
    expect(env.COS_KEY_PROFILE).toBe('haiku-key')
    expect('ANTHROPIC_MODEL' in env).toBe(false)
    expect('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' in env).toBe(false)
    expect(env.PATH).toBe('/usr/bin')
  })

  it('refuses process.env itself and a non-loopback relay origin', () => {
    expect(() => applyLaneBClaudeEnv(process.env, SPEC)).toThrow(/process\.env/)
    for (const origin of ['http://0.0.0.0:40123', 'http://100.64.1.2:40123', 'https://127.0.0.1:40123', 'http://127.0.0.1:40123/x', 'http://localhost:40123']) {
      expect(() => applyLaneBClaudeEnv({}, { ...SPEC, origin }), origin).toThrow(/loopback/)
    }
  })
})

const scratch = mkdtempSync(join(tmpdir(), 'kl-p3-settings-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('Claude settings guard', () => {
  const home = join(scratch, 'home'), cwd = join(scratch, 'cwd')
  mkdirSync(join(home, '.claude'), { recursive: true }); mkdirSync(join(cwd, '.claude'), { recursive: true })

  it('reads the user file, the project file and the local file for this cwd', () => {
    expect(claudeSettingsFiles({ cwd, home })).toEqual([
      join(home, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'),
    ])
  })

  it('names the setting, never its value; a torn file is skipped', () => {
    writeFileSync(join(home, '.claude', 'settings.json'), '{ torn')
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-secret-value' } }))
    const r = claudeSettingsRefusal({ cwd, home })
    expect(r?.name).toBe('ANTHROPIC_AUTH_TOKEN')
    expect(r?.file).toBe(join(cwd, '.claude', 'settings.json'))
    expect(JSON.stringify(r)).not.toContain('sk-ant-secret-value')
  })

  it('passes settings with no credential names', () => {
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { MAX_THINKING_TOKENS: '9', COS_USER_ID: 'x' } }))
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }, apiKeyHelper: '' }))
    expect(claudeSettingsRefusal({ cwd, home })).toBeNull()
  })
})
