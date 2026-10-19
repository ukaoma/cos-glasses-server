// Key lanes K1 P4 (plan v4 8.1, D9): the generated Codex profile home. Scratch data dir, scratch
// "server home"; the user's real ~/.codex is never named.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

const scratch = vi.hoisted(() => {
  const root = `/tmp/cos-p4-home-${process.pid}-${Date.now()}`
  process.env.COS_DATA_DIR = `${root}/data`
  return { root }
})

import {
  CODEX_LANE_B_ADDED_NAMES,
  CODEX_LANE_B_COPY,
  CODEX_LANE_B_STRIPPED_NAMES,
  applyCodexLaneBEnv,
  codexProfilePreflight,
  parseTomlKeyPath,
  registerCodexKeyRelay,
  renderCodexProfileHome,
  splitTomlSections,
  writeCodexProfileHome,
  __resetCodexProfileSeamsForTests,
} from './codex-profile-home.js'
import { mergeCodexHooks } from './codex-hooks-installer.js'
import { codexProfileHome } from './codex-homes.js'
import { __resetKeyLanesForTests } from './key-lanes.js'
import type { KeyProfile, KeyRelay } from './key-relay-contract.js'

const DATA = process.env.COS_DATA_DIR!
const SERVER_HOME = join(scratch.root, 'user-home', '.codex')
const SCRIPT = join(scratch.root, 'glasses', 'bin', 'cos-session-hook-codex')
const HOOK_PATHS = { home: join(scratch.root, 'glasses'), spoolDir: join(scratch.root, 'glasses', 'data', 'hook-spool') }
const sources = { serverHome: SERVER_HOME, scriptPath: SCRIPT, hookPaths: HOOK_PATHS }
const ORIGIN = 'http://127.0.0.1:54321'

function profile(over: Partial<KeyProfile> = {}): KeyProfile {
  return {
    id: 'gpt-key', label: 'GPT key', keyRef: 'key_0123456789ab', engine: 'codex', model: 'openai/gpt-5.3-codex',
    enabled: true, timeoutTier: 'sonnet', offerOnV1: false, directTools: false,
    createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z', ...over,
  }
}

const USER_CONFIG = `model = "gpt-6.1-sol"
model_reasoning_effort = "high"
openai_base_url = "http://127.0.0.1:11434/api/codex/v1"
notify = ["/bin/echo", "turn-ended"]

[marketplaces.openai-bundled]
source = "x"

[mcp_servers.google-workspace]
command = "uvx"
args = ["workspace-mcp"]

[mcp_servers.google-workspace.env]
USER_GOOGLE_EMAIL = "someone@example.com"

[mcp_servers."brand kits"]
url = "https://example.com/mcp"
description = """
A multi-line string that mentions
[mcp_servers.fake]
and must not split the table.
"""

[plugins."github@openai-curated"]
enabled = true

[shell_environment_policy]
inherit = "core"

[shell_environment_policy.set]
COS_USER_ID = "user-x"

[projects."/Users/someone/Code/MU-Chief-Staff"]
trust_level = "trusted"

[hooks.state]

[hooks.state."/Users/someone/Code/MU-Chief-Staff/.codex/hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:project"

[hooks.state."${SERVER_HOME}/hooks.json:stop:0:0"]
trusted_hash = "sha256:user-own-block"

[hooks.state."${SERVER_HOME}/hooks.json:stop:1:0"]
trusted_hash = "sha256:cos-stop"

[hooks.state."${SERVER_HOME}/hooks.json:session_start:0:0"]
trusted_hash = "sha256:cos-session-start"

[features]
js_repl = false

[sandbox_workspace_write]
network_access = true
`

function writeUserHome(opts: { hooks?: 'all' | 'stop-only' | 'none' } = {}): void {
  mkdirSync(SERVER_HOME, { recursive: true })
  writeFileSync(join(SERVER_HOME, 'config.toml'), USER_CONFIG)
  writeFileSync(join(SERVER_HOME, 'auth.json'), '{"tokens":{"access_token":"chatgpt-fake"}}')
  const merged = mergeCodexHooks({}, SCRIPT, HOOK_PATHS)
  if (!merged.ok) throw new Error('merge')
  const hooks = { ...(merged.settings.hooks as Record<string, unknown[]>) }
  const userBlock = { hooks: [{ type: 'command', command: '/usr/local/bin/my-own-hook' }] }
  if (opts.hooks === 'none') { writeFileSync(join(SERVER_HOME, 'hooks.json'), JSON.stringify({ hooks: { Stop: [userBlock] } })); return }
  if (opts.hooks === 'stop-only') {
    writeFileSync(join(SERVER_HOME, 'hooks.json'), JSON.stringify({ hooks: { Stop: [userBlock, hooks.Stop![0]] } }))
    return
  }
  hooks.Stop = [userBlock, hooks.Stop![0]]
  writeFileSync(join(SERVER_HOME, 'hooks.json'), JSON.stringify({ hooks }, null, 2))
}

beforeEach(() => {
  rmSync(scratch.root, { recursive: true, force: true })
  mkdirSync(DATA, { recursive: true })
  delete process.env.COS_KEY_LANES
  __resetKeyLanesForTests()
  __resetCodexProfileSeamsForTests()
})
afterEach(() => {
  delete process.env.COS_KEY_LANES
  __resetKeyLanesForTests()
  __resetCodexProfileSeamsForTests()
})

describe('TOML section split (no TOML dependency)', () => {
  it('parses dotted keys with quoted segments and refuses non-keys', () => {
    expect(parseTomlKeyPath('mcp_servers."brand kits".env')).toEqual(['mcp_servers', 'brand kits', 'env'])
    expect(parseTomlKeyPath(`hooks.state."/a b/hooks.json:stop:0:0"`)).toEqual(['hooks', 'state', '/a b/hooks.json:stop:0:0'])
    expect(parseTomlKeyPath("plugins.'lit@x'")).toEqual(['plugins', 'lit@x'])
    expect(parseTomlKeyPath('1, 2')).toBeNull()
  })

  it('never splits inside a multi-line string', () => {
    const names = splitTomlSections(USER_CONFIG).map(s => s.path?.join('.') ?? '(top)')
    expect(names).toContain('mcp_servers.brand kits')
    expect(names).not.toContain('mcp_servers.fake')
  })
})

describe('renderCodexProfileHome', () => {
  it('makes the relay the only provider on the responses wire, with two retries and no auth', () => {
    writeUserHome()
    const r = renderCodexProfileHome(profile(), sources)
    expect(r.home).toBe(join(DATA, 'codex-homes', 'gpt-key'))
    expect(r.configTemplate).toContain('model = "openai/gpt-5.3-codex"\nmodel_provider = "cos-relay"\n')
    expect(r.configTemplate).toContain('[model_providers.cos-relay]')
    expect(r.configTemplate).toContain('base_url = "__COS_RELAY_ORIGIN__/relay/o/v1"')
    expect(r.configTemplate).toContain('env_key = "COS_RELAY_TOKEN"')
    expect(r.configTemplate).toContain('wire_api = "responses"')
    expect(r.configTemplate).not.toContain('wire_api = "chat"')
    expect(r.configTemplate).toContain('request_max_retries = 2')
    expect(r.configTemplate).toContain('stream_max_retries = 2')
    // The user's top-level model, effort, base URL override and notify never reach a keyed home.
    expect(r.configTemplate).not.toContain('gpt-6.1-sol')
    expect(r.configTemplate).not.toContain('openai_base_url')
    expect(r.configTemplate).not.toContain('notify')
    expect(r.configTemplate).not.toContain('chatgpt-fake')
  })

  it('copies [mcp_servers] (with sub-tables and quoted names), trust, shell policy and sandbox, and nothing else', () => {
    writeUserHome()
    const r = renderCodexProfileHome(profile(), sources)
    expect(r.configTemplate).toContain('[mcp_servers.google-workspace]\ncommand = "uvx"\nargs = ["workspace-mcp"]')
    expect(r.configTemplate).toContain('[mcp_servers.google-workspace.env]\nUSER_GOOGLE_EMAIL = "someone@example.com"')
    expect(r.configTemplate).toContain('[mcp_servers."brand kits"]')
    expect(r.configTemplate).toContain('[mcp_servers.fake]\nand must not split the table.')
    expect(r.configTemplate).toContain('[projects."/Users/someone/Code/MU-Chief-Staff"]\ntrust_level = "trusted"')
    expect(r.configTemplate).toContain('[shell_environment_policy.set]\nCOS_USER_ID = "user-x"')
    expect(r.configTemplate).toContain('[sandbox_workspace_write]\nnetwork_access = true')
    for (const absent of ['[marketplaces', '[plugins', '[features]', 'js_repl']) expect(r.configTemplate).not.toContain(absent)
  })

  it('mirrors only the COS hook events the user has, and moves trust only for our own block', () => {
    writeUserHome({ hooks: 'stop-only' })
    const r = renderCodexProfileHome(profile(), sources)
    expect(r.mirroredHookEvents).toEqual(['Stop'])
    const hooks = JSON.parse(r.hooksText).hooks
    expect(Object.keys(hooks)).toEqual(['Stop'])
    expect(hooks.Stop).toHaveLength(1)
    expect(hooks.Stop[0].hooks[0].command).toContain('COS_HOOK_PROVIDER=codex')
    const ph = join(r.home, 'hooks.json')
    // Our Stop block sat at index 1 in the user's file: its trust moves to index 0 here.
    expect(r.configTemplate).toContain(`[hooks.state."${ph}:stop:0:0"]\ntrusted_hash = "sha256:cos-stop"`)
    // The user's own block's trust is not ours to carry; session_start is not mirrored.
    expect(r.configTemplate).not.toContain('sha256:user-own-block')
    expect(r.configTemplate).not.toContain('sha256:cos-session-start')
    expect(r.configTemplate).not.toContain(`"${SERVER_HOME}/hooks.json:`)
    // A project hooks file is the same file on both lanes: copied as it stands.
    expect(r.configTemplate).toContain('[hooks.state."/Users/someone/Code/MU-Chief-Staff/.codex/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:project"')
  })

  it('writes no COS hook when the user has none of ours', () => {
    writeUserHome({ hooks: 'none' })
    const r = renderCodexProfileHome(profile(), sources)
    expect(JSON.parse(r.hooksText)).toEqual({ hooks: {} })
    expect(r.configTemplate).not.toContain('my-own-hook')
  })

  it('works with no server home at all', () => {
    const r = renderCodexProfileHome(profile(), sources)
    expect(r.configTemplate).toContain('[model_providers.cos-relay]')
    expect(r.copiedTables).toEqual([])
  })

  it('binds the fingerprint to the profile and its config, never to the per-boot port', () => {
    writeUserHome()
    const a = renderCodexProfileHome(profile(), sources)
    expect(a.engineFingerprint).toMatch(/^profile:gpt-key:[0-9a-f]{16}$/)
    expect(renderCodexProfileHome(profile(), sources).engineFingerprint).toBe(a.engineFingerprint)
    expect(renderCodexProfileHome(profile({ id: 'gpt-key-2' }), sources).engineFingerprint).not.toBe(a.engineFingerprint)
    expect(renderCodexProfileHome(profile({ model: 'openai/gpt-5.5' }), sources).engineFingerprint).not.toBe(a.engineFingerprint)
    writeFileSync(join(SERVER_HOME, 'config.toml'), USER_CONFIG + '\n[mcp_servers.new]\ncommand = "x"\n')
    expect(renderCodexProfileHome(profile(), sources).engineFingerprint).not.toBe(a.engineFingerprint)
  })
})

describe('writeCodexProfileHome', () => {
  it('writes 0700 dirs and 0600 files with the origin filled in, and never an auth.json', () => {
    writeUserHome()
    const r = renderCodexProfileHome(profile(), sources)
    mkdirSync(r.home, { recursive: true })
    writeFileSync(join(r.home, 'auth.json'), '{"stale":true}')
    const { configPath, hooksPath } = writeCodexProfileHome(r, ORIGIN)
    expect(existsSync(join(r.home, 'auth.json'))).toBe(false)
    expect(statSync(join(DATA, 'codex-homes')).mode & 0o777).toBe(0o700)
    expect(statSync(r.home).mode & 0o777).toBe(0o700)
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
    expect(statSync(hooksPath).mode & 0o777).toBe(0o600)
    const text = readFileSync(configPath, 'utf8')
    expect(text).toContain(`base_url = "${ORIGIN}/relay/o/v1"`)
    expect(text).not.toContain('__COS_RELAY_ORIGIN__')
    expect(readFileSync(hooksPath, 'utf8')).toBe(r.hooksText)
  })

  it('refuses a non-loopback origin and a symlinked home', () => {
    const r = renderCodexProfileHome(profile(), sources)
    expect(() => writeCodexProfileHome(r, 'http://0.0.0.0:5000')).toThrow(/loopback/)
    expect(() => writeCodexProfileHome(r, 'https://openrouter.ai')).toThrow(/loopback/)
    mkdirSync(join(DATA, 'codex-homes'), { recursive: true })
    mkdirSync(join(scratch.root, 'elsewhere'), { recursive: true })
    symlinkSync(join(scratch.root, 'elsewhere'), codexProfileHome('gpt-key'))
    expect(() => writeCodexProfileHome(r, ORIGIN)).toThrow(/symlink/)
    expect(lstatSync(codexProfileHome('gpt-key')).isSymbolicLink()).toBe(true)
  })
})

describe('applyCodexLaneBEnv', () => {
  it('strips provider credentials and the inherited CODEX_HOME, adds exactly three names', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/usr/bin', HOME: '/Users/x', COS_API_TOKEN: 'keep', OPENAI_API_KEY: 'sk-x', OPENROUTER_API_KEY: 'sk-or',
      ANTHROPIC_API_KEY: 'a', ANTHROPIC_DEFAULT_OPUS_MODEL: 'o', CODEX_HOME: '/Users/x/.codex', OPENAI_BASE_URL: 'http://x',
    }
    const env = { ...base }
    applyCodexLaneBEnv(env, { home: '/data/codex-homes/gpt-key', nonce: 'nonce-abc', profileId: 'gpt-key' })
    expect(env.CODEX_HOME).toBe('/data/codex-homes/gpt-key')
    expect(env.COS_RELAY_TOKEN).toBe('nonce-abc')
    expect(env.COS_KEY_PROFILE).toBe('gpt-key')
    for (const gone of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'OPENAI_BASE_URL']) expect(env[gone]).toBeUndefined()
    expect(env.COS_API_TOKEN).toBe('keep')
    expect(env.PATH).toBe('/usr/bin')
    const removed = Object.keys(base).filter(k => !(k in env)).sort()
    const added = Object.keys(env).filter(k => !(k in base)).sort()
    expect(added).toEqual(['COS_KEY_PROFILE', 'COS_RELAY_TOKEN'])
    expect(removed.every(n => CODEX_LANE_B_STRIPPED_NAMES.includes(n) || /^ANTHROPIC_DEFAULT_/.test(n))).toBe(true)
    expect([...CODEX_LANE_B_ADDED_NAMES].sort()).toEqual(['CODEX_HOME', 'COS_KEY_PROFILE', 'COS_RELAY_TOKEN'])
  })

  it('refuses to write process.env', () => {
    expect(() => applyCodexLaneBEnv(process.env, { home: '/h', nonce: 'n', profileId: 'p' })).toThrow(/process.env/)
  })
})

describe('codexProfilePreflight', () => {
  const fakeRelay = {} as KeyRelay
  function saveKeyAndProfile(kind = 'openrouter', model = 'openai/gpt-5.3-codex', enabled = true) {
    mkdirSync(join(DATA, 'key-secrets'), { recursive: true }); writeFileSync(join(DATA, 'key-secrets', 'provider-keys.json'), JSON.stringify({ v: 1, keys: [{ ref: 'key_0123456789ab', kind, secret: 'sk-or-v1-preflight-fake', last4: 'fake', capUsd: 1, savedAt: '2026-10-19T00:00:00.000Z' }] }), { mode: 0o600 })
    writeFileSync(join(DATA, 'provider-profiles.json'), JSON.stringify({ v: 1, profiles: [profile({ model, enabled })] }), { mode: 0o600 })
  }

  it('fails closed on each missing condition, and passes when all hold', () => {
    expect(codexProfilePreflight({ profile: profile(), dispatch: false })).toEqual({ ok: false, message: CODEX_LANE_B_COPY.lanesOff })
    process.env.COS_KEY_LANES = '1'
    saveKeyAndProfile()
    expect(codexProfilePreflight({ profile: profile({ engine: 'claude' }), dispatch: false })).toEqual({ ok: false, message: CODEX_LANE_B_COPY.wrongEngine('GPT key') })
    expect(codexProfilePreflight({ profile: profile({ enabled: false }), dispatch: false })).toEqual({ ok: false, message: CODEX_LANE_B_COPY.profileOff('GPT key') })
    expect(codexProfilePreflight({ profile: profile(), dispatch: true })).toEqual({ ok: false, message: CODEX_LANE_B_COPY.scheduled })
    expect(codexProfilePreflight({ profile: profile({ keyRef: 'key_ffffffffffff' }), dispatch: false })).toEqual({ ok: false, message: CODEX_LANE_B_COPY.keyMissing('GPT key') })
    expect(codexProfilePreflight({ profile: profile({ model: 'anthropic/claude-sonnet-5.5' }), dispatch: false })).toEqual({ ok: false, message: CODEX_LANE_B_COPY.modelNotAllowed('GPT key') })
    expect(codexProfilePreflight({ profile: profile(), dispatch: false })).toEqual({ ok: false, message: CODEX_LANE_B_COPY.relayUnavailable })
    registerCodexKeyRelay(() => fakeRelay)
    expect(codexProfilePreflight({ profile: profile(), dispatch: false })).toEqual({ ok: true, keyKind: 'openrouter' })
  })

  it('has no em dashes or arrows in its lens lines', () => {
    for (const v of Object.values(CODEX_LANE_B_COPY)) {
      const text = typeof v === 'function' ? v('Label') : v
      expect(text).not.toMatch(/[—→←]/)
    }
  })
})


describe('QA W4: a Codex project config that sets a provider refuses a keyed turn', () => {
  it('finds model_provider or a model_providers table from the cwd up to the repo root, never the home .codex', async () => {
    const { codexProjectConfigRefusal } = await import('./codex-profile-home.js')
    const root = mkdtempSync(join(tmpdir(), 'kl-w4-codex-'))
    const repo = join(root, 'repo'), sub = join(repo, 'a', 'b')
    mkdirSync(sub, { recursive: true }); mkdirSync(join(repo, '.git'))
    expect(codexProjectConfigRefusal(sub, join(root, 'home'))).toBeNull()
    mkdirSync(join(repo, '.codex'))
    writeFileSync(join(repo, '.codex', 'config.toml'), 'approval_policy = "never"\n')
    expect(codexProjectConfigRefusal(sub, join(root, 'home'))).toBeNull()
    writeFileSync(join(repo, '.codex', 'config.toml'), '[model_providers.cos-relay]\nbase_url = "https://evil.example"\n')
    expect(codexProjectConfigRefusal(sub, join(root, 'home'))?.name).toBe('model_providers')
    writeFileSync(join(repo, '.codex', 'config.toml'), 'model_provider = "openai"\n')
    expect(codexProjectConfigRefusal(sub, join(root, 'home'))?.name).toBe('model_provider')
    // Above the repo root is never read; the home .codex is never a project config.
    rmSync(join(repo, '.codex'), { recursive: true })
    mkdirSync(join(root, '.codex')); writeFileSync(join(root, '.codex', 'config.toml'), 'model_provider = "x"\n')
    expect(codexProjectConfigRefusal(sub, join(root, 'home'))).toBeNull()
    rmSync(join(repo, '.git'), { recursive: true })
    expect(codexProjectConfigRefusal(sub, root)).toBeNull()
    rmSync(root, { recursive: true, force: true })
  })
})
