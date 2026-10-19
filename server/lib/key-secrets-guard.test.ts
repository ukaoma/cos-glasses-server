// Key lanes K1, QA B1: the deny layer every tool-capable Claude spawn gets while lanes are on and
// a key is saved. Off, or on with no key, every argv builder is byte-identical. Scratch data dir.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'kl-b1-guard-'))
process.env.COS_DATA_DIR = join(root, 'data')
delete process.env.COS_KEY_LANES

const guard = await import('./key-secrets-guard.js')
const store = await import('./key-store.js')
const lanes = await import('./key-lanes.js')
const { buildClaudeAttachedArgs } = await import('./attached-provider-adapter.js')
const { buildClaudeForkArgs } = await import('./fork-thread.js')

afterAll(() => { rmSync(root, { recursive: true, force: true }); delete process.env.COS_KEY_LANES })
beforeEach(() => {
  delete process.env.COS_KEY_LANES
  lanes.__resetKeyLanesForTests()
  store.deleteKeyStore()
})
const on = () => { process.env.COS_KEY_LANES = '1'; lanes.__resetKeyLanesForTests() }
const ID = '11111111-2222-4333-8444-555555555555'

describe('claudeKeySecretsGuardArgs (QA B1)', () => {
  it('lanes off: nothing, even with a key file on disk; the argv builders are unchanged', () => {
    on(); store.saveKey({ kind: 'openrouter', secret: 'sk-or-v1-guardfakefakefakefakefake', capUsd: 1 })
    delete process.env.COS_KEY_LANES; lanes.__resetKeyLanesForTests()
    expect(guard.claudeKeySecretsGuardArgs()).toEqual([])
    expect(buildClaudeAttachedArgs(ID)).not.toContain('--settings')
    expect(buildClaudeForkArgs(ID)).not.toContain('--settings')
    process.env.COS_KEY_LANES = '0'; lanes.__resetKeyLanesForTests()
    expect(guard.claudeKeySecretsGuardArgs()).toEqual([])
  })

  it('lanes on with no key saved: nothing to protect, nothing added', () => {
    on()
    expect(guard.claudeKeySecretsGuardArgs()).toEqual([])
  })

  it('lanes on with a key: one --settings layer denying Read, Edit and Write of the dir and Bash lines naming it', () => {
    on(); store.saveKey({ kind: 'openrouter', secret: 'sk-or-v1-guardfakefakefakefakefake', capUsd: 1 })
    const args = guard.claudeKeySecretsGuardArgs()
    expect(args[0]).toBe('--settings')
    expect(args).toHaveLength(2)
    const deny = (JSON.parse(args[1]!) as { permissions: { deny: string[] } }).permissions.deny
    const dir = store.keySecretsDir()
    for (const tool of ['Read', 'Edit', 'Write']) expect(deny).toContain(`${tool}(/${dir}/**)`)
    expect(deny).toContain('Bash(*key-secrets*)')
    expect(deny).toContain('Bash(*provider-keys.json*)')
    // The real path too (macOS /var is /private/var).
    const real = realpathSync(dir)
    if (real !== dir) expect(deny).toContain(`Read(/${real}/**)`)
    expect(buildClaudeAttachedArgs(ID).slice(-2)).toEqual(args)
    expect(buildClaudeForkArgs(ID).slice(-2)).toEqual(args)
  })
})
