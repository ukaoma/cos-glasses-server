import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const launcher = readFileSync(resolve(root, 'bin/cli.cjs'), 'utf8')
const managedLauncher = readFileSync(resolve(root, 'bin/managed-server.cjs'), 'utf8')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  version?: string
  files?: string[]
  dependencies?: Record<string, string>
}
const packageLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as {
  version?: string
  packages?: Record<string, { version?: string }>
}

describe('public npx launcher install contract', () => {
  it('keeps package and lockfile release versions aligned', () => {
    expect(packageLock.version).toBe(pkg.version)
    expect(packageLock.packages?.['']?.version).toBe(pkg.version)
  })

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
    expect(launcher).toContain("execFileSync(binary, ['models']")
    expect(launcher).toContain('No signed-in agent CLI is ready')
    expect(launcher).toContain('claude auth login')
    expect(launcher).toContain('agent login')
  })

  it('accepts a Cursor-only install only when both public model slots resolve', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'cos-launcher-cursor-'))
    const bin = resolve(temp, 'bin')
    const home = resolve(temp, 'home')
    mkdirSync(bin)
    mkdirSync(home)
    const agent = resolve(bin, 'agent')
    writeFileSync(agent, `#!/bin/sh
if [ "$1" = "about" ]; then echo "Cursor Agent CLI Version 2026.07"; exit 0; fi
if [ "$1" = "models" ]; then
  echo "composer-2.5-fast - Composer 2.5 Fast"
  echo "cursor-grok-4.5-high-fast - Grok 4.5 Fast"
  exit 0
fi
exit 1
`)
    chmodSync(agent, 0o755)

    try {
      const result = spawnSync(process.execPath, [resolve(root, 'bin/cli.cjs'), '--prepare-only'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Cursor Agent Cursor Agent CLI Version 2026.07')
      expect(result.stdout).toContain('(Composer 2.5 / newest Grok high-fast)')
      expect(result.stdout).toContain('Non-mutating readiness check complete')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
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

  it('keeps controller readiness probes non-mutating', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'cos-launcher-prepare-'))
    const bin = resolve(temp, 'bin')
    const home = resolve(temp, 'home')
    mkdirSync(bin)
    mkdirSync(home)
    const claude = resolve(bin, 'claude')
    writeFileSync(claude, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.215"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn":true}'; exit 0; fi
exit 1
`)
    chmodSync(claude, 0o755)

    try {
      const result = spawnSync(process.execPath, [resolve(root, 'bin/cli.cjs'), '--prepare-only'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Non-mutating readiness check complete')
      expect(existsSync(resolve(home, '.cos-glasses'))).toBe(false)
      expect(existsSync(resolve(home, '.local/share/whisper-models'))).toBe(false)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('makes an explicit Kokoro Python override authoritative in readiness checks', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'cos-launcher-kokoro-python-'))
    const bin = resolve(temp, 'bin')
    const home = resolve(temp, 'home')
    mkdirSync(bin)
    mkdirSync(home)
    const claude = resolve(bin, 'claude')
    const python313 = resolve(bin, 'python3.13')
    const python311 = resolve(bin, 'python3.11')
    writeFileSync(claude, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.215"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn":true}'; exit 0; fi
exit 1
`)
    writeFileSync(python313, '#!/bin/sh\necho "Python 3.13.5"\n')
    writeFileSync(python311, '#!/bin/sh\necho "Python 3.11.14"\n')
    for (const executable of [claude, python313, python311]) chmodSync(executable, 0o755)

    try {
      const incompatible = spawnSync(process.execPath, [resolve(root, 'bin/cli.cjs'), '--prepare-only'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin`,
          COS_TTS_BOOTSTRAP_PYTHON: python313,
        },
      })
      expect(incompatible.status).toBe(0)
      expect(incompatible.stdout).toContain('Local Kokoro voice needs Python 3.11 or 3.12')
      expect(incompatible.stdout).not.toContain('Local voice Python 3.11.14')

      const compatible = spawnSync(process.execPath, [resolve(root, 'bin/cli.cjs'), '--prepare-only'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin`,
          COS_TTS_BOOTSTRAP_PYTHON: python311,
        },
      })
      expect(compatible.status).toBe(0)
      expect(compatible.stdout).toContain('Local voice Python 3.11.14')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('makes the launchd-owned managed entrypoint the listener owner', () => {
    expect(pkg.files).toContain('managed-runtime-contract.json')
    expect(managedLauncher).toContain("require('tsx/cjs')")
    expect(managedLauncher).toContain("require(resolve(PKG_ROOT, 'server/index.ts'))")
    expect(managedLauncher).not.toMatch(/spawn\s*\(|fork\s*\(|execFile\s*\(/)
  })

  it('packs Cursor models and Silero while excluding private runtime state', () => {
    const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(packed.status, packed.stderr).toBe(0)
    const report = JSON.parse(packed.stdout) as Array<{ files?: Array<{ path?: string }> }>
    const paths = new Set((report[0]?.files ?? []).map(file => file.path))

    for (const required of [
      'server/lib/cursor-bridge.ts',
      'server/lib/cursor-engine-sessions.ts',
      'server/lib/cursor-model-catalog.ts',
      'server/lib/cursor-run-ledger.ts',
      'server/models/silero_vad.onnx',
    ]) {
      expect(paths.has(required), `missing from npm tarball: ${required}`).toBe(true)
    }
    expect([...paths].some(path => path?.includes('/data/'))).toBe(false)
    expect([...paths].some(path => path?.includes('/certs/'))).toBe(false)
    expect([...paths].some(path => path?.endsWith('.test.ts'))).toBe(false)
  })

  it('keeps operator-specific paths and identities out of the public Cursor bridge', () => {
    const publicCursorSource = [
      'server/lib/cursor-bridge.ts',
      'server/lib/cursor-engine-sessions.ts',
      'server/lib/cursor-model-catalog.ts',
      'server/lib/cursor-run-ledger.ts',
    ].map(path => readFileSync(resolve(root, path), 'utf8')).join('\n')

    expect(publicCursorSource).not.toMatch(/\/Users\//)
    expect(publicCursorSource).not.toMatch(/\b(?:Miles|Ukaoma|MU-Chief-Staff)\b/i)
  })

  it('keeps operator identity and Miles calendar filters out of welcome-context', () => {
    const welcome = readFileSync(resolve(root, 'server/routes/welcome-context.ts'), 'utf8')
    expect(welcome).not.toMatch(/\/Users\//)
    expect(welcome).not.toMatch(/\b(?:Miles|Ukaoma|Leander|MU-Chief-Staff)\b/i)
    expect(welcome).not.toMatch(/hermit crab|lean-labs|miles\s*&\s*team|sprocket rocket/i)
  })
})
