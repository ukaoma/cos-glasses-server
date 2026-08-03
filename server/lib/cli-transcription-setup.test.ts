import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

let root = ''

describe('public adaptive transcription setup', () => {
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  it('persists the adaptive choice and a safe profile without starting a listener', () => {
    root = mkdtempSync(join(tmpdir(), 'cos-cli-transcription-'))
    const fakeBin = join(root, 'bin')
    mkdirSync(fakeBin)
    const codex = join(fakeBin, 'codex')
    writeFileSync(codex, '#!/bin/sh\nif [ "$1" = "login" ]; then echo "Logged in"; else echo "codex-cli 1.0.0"; fi\n')
    chmodSync(codex, 0o700)
    for (const binary of ['whisper-cli', 'whisper-server']) {
      const path = join(fakeBin, binary)
      writeFileSync(path, '#!/bin/sh\nexit 0\n')
      chmodSync(path, 0o700)
    }

    const output = execFileSync(process.execPath, [resolve('bin/cli.cjs'), '--setup-transcription', '--prepare-only'], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        SKIP_WHISPER_DOWNLOAD: '1',
        COS_CURSOR_AGENT_BIN: join(root, 'missing-agent'),
      },
      encoding: 'utf8',
      timeout: 30_000,
    })

    expect(output).toContain('Transcription setup complete')
    expect(readFileSync(join(root, '.cos-glasses/.env'), 'utf8')).toContain('COS_WHISPER_TRANSCRIPTION_TIER=balanced')
    expect(readFileSync(join(root, '.cos-glasses/.env'), 'utf8')).toContain('COS_WHISPER_PREVIEW_MODEL=small.en')
    expect(readFileSync(join(root, '.cos-glasses/.env'), 'utf8')).toContain('COS_WHISPER_COMMIT_MODEL=turbo')
    expect(JSON.parse(readFileSync(join(root, '.cos-glasses/.cos-profile.json'), 'utf8'))).toMatchObject({
      owner_name: 'User',
      vocabulary: [],
      whisper_corrections: '{}',
    })
  })

  it('retains a timed-out partial download, reports incomplete setup, and promotes a completed retry', () => {
    root = mkdtempSync(join(tmpdir(), 'cos-cli-transcription-resume-'))
    const fakeBin = join(root, 'bin')
    const modelDir = join(root, '.local/share/whisper-models')
    mkdirSync(fakeBin)
    mkdirSync(modelDir, { recursive: true })
    const codex = join(fakeBin, 'codex')
    writeFileSync(codex, '#!/bin/sh\nif [ "$1" = "login" ]; then echo "Logged in"; else echo "codex-cli 1.0.0"; fi\n')
    chmodSync(codex, 0o700)
    for (const binary of ['whisper-cli', 'whisper-server']) {
      const path = join(fakeBin, binary)
      writeFileSync(path, '#!/bin/sh\nexit 0\n')
      chmodSync(path, 0o700)
    }
    const curl = join(fakeBin, 'curl')
    writeFileSync(curl, '#!/bin/sh\nexit 28\n')
    chmodSync(curl, 0o700)
    const turbo = join(modelDir, 'ggml-large-v3-turbo.bin')
    const large = join(modelDir, 'ggml-large-v3.bin')
    writeFileSync(turbo, '')
    writeFileSync(large, '')
    truncateSync(turbo, 800_000_000)
    truncateSync(large, 2_800_000_000)
    const partial = join(modelDir, 'ggml-small.en.bin.partial')
    writeFileSync(partial, 'retained partial bytes')

    const env = {
      ...process.env,
      HOME: root,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      COS_CURSOR_AGENT_BIN: join(root, 'missing-agent'),
    }
    const failed = spawnSync(process.execPath, [resolve('bin/cli.cjs'), '--setup-transcription', '--prepare-only'], {
      cwd: resolve('.'), env, encoding: 'utf8', timeout: 30_000,
    })
    expect(failed.status).toBe(1)
    expect(failed.stdout).toContain('Transcription setup incomplete')
    expect(failed.stdout).toContain('Partial download retained')
    expect(readFileSync(partial, 'utf8')).toBe('retained partial bytes')

    writeFileSync(curl, `#!/bin/sh
set -eu
resume='false'
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--continue-at" ] && [ "\${2:-}" = "-" ]; then resume='true'; shift 2; continue; fi
  if [ "$1" = "-o" ]; then output="$2"; shift 2; continue; fi
  shift
done
[ "$resume" = "true" ]
[ -n "$output" ]
truncate -s 487614201 "$output"
`)
    chmodSync(curl, 0o700)
    const resumed = execFileSync(process.execPath, [resolve('bin/cli.cjs'), '--setup-transcription', '--prepare-only'], {
      cwd: resolve('.'), env, encoding: 'utf8', timeout: 30_000,
    })
    expect(resumed).toContain('Transcription setup complete')
    expect(existsSync(partial)).toBe(false)
    expect(existsSync(join(modelDir, 'ggml-small.en.bin'))).toBe(true)
  })

  it('persists Max without provisioning a redundant Small.en worker', () => {
    root = mkdtempSync(join(tmpdir(), 'cos-cli-transcription-max-'))
    const fakeBin = join(root, 'bin')
    mkdirSync(fakeBin)
    for (const binary of ['codex', 'whisper-cli', 'whisper-server']) {
      const path = join(fakeBin, binary)
      writeFileSync(path, binary === 'codex'
        ? '#!/bin/sh\nif [ "$1" = "login" ]; then echo "Logged in"; else echo "codex-cli 1.0.0"; fi\n'
        : '#!/bin/sh\nexit 0\n')
      chmodSync(path, 0o700)
    }

    const output = execFileSync(process.execPath, [
      resolve('bin/cli.cjs'), '--setup-transcription', '--transcription-tier', 'max', '--prepare-only',
    ], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        SKIP_WHISPER_DOWNLOAD: '1',
        COS_CURSOR_AGENT_BIN: join(root, 'missing-agent'),
      },
      encoding: 'utf8',
      timeout: 30_000,
    })

    const persisted = readFileSync(join(root, '.cos-glasses/.env'), 'utf8')
    expect(output).toContain('Max transcription selected')
    expect(output).toContain('Transcription setup complete')
    expect(persisted).toContain('COS_WHISPER_TRANSCRIPTION_TIER=max')
    expect(persisted).toContain('COS_WHISPER_PREVIEW_MODEL=turbo')
    expect(persisted).toContain('COS_WHISPER_COMMIT_MODEL=large-v3')
  })

  it('rejects an unknown transcription tier before mutating configuration', () => {
    root = mkdtempSync(join(tmpdir(), 'cos-cli-transcription-invalid-'))
    const result = spawnSync(process.execPath, [
      resolve('bin/cli.cjs'), '--setup-transcription', '--transcription-tier', 'fastest', '--prepare-only',
    ], {
      cwd: resolve('.'), env: { ...process.env, HOME: root }, encoding: 'utf8', timeout: 30_000,
    })
    expect(result.status).toBe(64)
    expect(result.stderr).toContain('Use balanced or max')
    expect(existsSync(join(root, '.cos-glasses/.env'))).toBe(false)
  })

  it('rejects a missing transcription tier value before mutating configuration', () => {
    root = mkdtempSync(join(tmpdir(), 'cos-cli-transcription-missing-'))
    const result = spawnSync(process.execPath, [
      resolve('bin/cli.cjs'), '--setup-transcription', '--transcription-tier',
    ], {
      cwd: resolve('.'), env: { ...process.env, HOME: root }, encoding: 'utf8', timeout: 30_000,
    })
    expect(result.status).toBe(64)
    expect(result.stderr).toContain('Missing value for --transcription-tier')
    expect(existsSync(join(root, '.cos-glasses/.env'))).toBe(false)
  })
})
