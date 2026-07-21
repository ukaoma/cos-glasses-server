import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const launcher = readFileSync(resolve(root, 'bin/cli.cjs'), 'utf8')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}

describe('public npx launcher install contract', () => {
  it('resolves the dependency npm already installed instead of mutating the npx cache', () => {
    expect(pkg.dependencies?.tsx).toBeTruthy()
    expect(launcher).toContain("require.resolve('tsx/esm', { paths: [PKG_ROOT] })")
    expect(launcher).toContain("['--import', tsxImport, 'server/index.ts']")
    expect(launcher).not.toMatch(/execSync\(\s*['\"]npm install/)
  })

  it('never teaches sudo and provides a user-owned cache recovery path', () => {
    expect(launcher).not.toMatch(/sudo\s+(?:npm|npx)/i)
    expect(launcher).toContain('npm_config_cache="$HOME/.cos-glasses/npm-cache" npx --yes @gotcos/glasses-server@latest')
  })

  it('distinguishes Claude Desktop from the required terminal CLI', () => {
    expect(launcher).toContain('Claude Desktop alone is not enough')
    expect(launcher).toContain('npm install -g @anthropic-ai/claude-code')
    expect(launcher).toContain('and finish sign-in')
  })

  it('checks provider authentication before claiming first-query readiness', () => {
    expect(launcher).toContain("commandResult('claude auth status --json')")
    expect(launcher).toContain("commandResult('codex login status')")
    expect(launcher).toContain('No signed-in agent CLI is ready')
    expect(launcher).toContain('claude auth login')
  })

  it('fails before startup when the only installed provider is signed out', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'cos-launcher-auth-'))
    const bin = resolve(temp, 'bin')
    const home = resolve(temp, 'home')
    mkdirSync(bin)
    mkdirSync(home)
    const claude = resolve(bin, 'claude')
    writeFileSync(claude, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.215"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn":false}'; exit 1; fi
exit 1
`)
    chmodSync(claude, 0o755)

    try {
      const result = spawnSync(process.execPath, [resolve(root, 'bin/cli.cjs')], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, PATH: bin },
      })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('installed — sign-in required')
      expect(result.stdout).toContain('No signed-in agent CLI is ready')
      expect(result.stdout).toContain('claude auth login')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('locks persistent config and credential files to the current user', () => {
    expect(launcher).toContain('securePrivateDirectory(CONFIG_DIR)')
    expect(launcher).toContain('chmodSync(dir, 0o700)')
    expect(launcher).toContain('chmodSync(file, 0o600)')
    expect(launcher).toContain('must be a regular file, not a symlink')
  })

  it('keeps text available but makes an incomplete local voice install unmistakable', () => {
    expect(launcher).toContain('let localVoiceReady = Boolean(whisperCliPath && hasValidModel)')
    expect(launcher).toContain('localVoiceReady = true')
    expect(launcher).toContain('LOCAL VOICE NOT READY')
    expect(launcher).toContain('Text chat can start. Under the default local-only policy, voice prompts remain unavailable.')
    expect(launcher).toContain('brew install whisper-cpp')
    expect(launcher).toContain('npx --yes @gotcos/glasses-server@latest')
    expect(launcher).not.toContain('Ctrl-C to skip')
  })
})
