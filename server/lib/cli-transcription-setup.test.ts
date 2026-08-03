import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
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

    expect(output).toContain('Adaptive transcription setup complete')
    expect(readFileSync(join(root, '.cos-glasses/.env'), 'utf8')).toContain('COS_WHISPER_PREVIEW_MODEL=small.en')
    expect(JSON.parse(readFileSync(join(root, '.cos-glasses/.cos-profile.json'), 'utf8'))).toMatchObject({
      owner_name: 'User',
      vocabulary: [],
      whisper_corrections: '{}',
    })
  })
})
