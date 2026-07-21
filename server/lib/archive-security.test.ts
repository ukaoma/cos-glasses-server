import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('archive summary command safety', () => {
  let root = ''
  let originalPath = ''

  beforeEach(() => {
    vi.resetModules()
    root = mkdtempSync(join(tmpdir(), 'cos-archive-security-'))
    originalPath = process.env.PATH ?? ''
    process.env.COS_DATA_DIR = join(root, 'data')

    const fakeBin = join(root, 'bin')
    mkdirSync(fakeBin, { recursive: true })
    const fakeClaude = join(fakeBin, 'claude')
    writeFileSync(fakeClaude, '#!/bin/sh\ncat >/dev/null\nprintf "Safe archive title\\n"\n', { mode: 0o700 })
    chmodSync(fakeClaude, 0o700)
    process.env.PATH = `${fakeBin}:${originalPath}`
  })

  afterEach(() => {
    process.env.PATH = originalPath
    delete process.env.COS_DATA_DIR
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps shell metacharacters in stored query text inert', async () => {
    const marker = join(root, 'must-not-exist')
    const { generateChatSummary } = await import('./archive.js')

    const title = await generateChatSummary([{
      role: 'user',
      content: `summarize $(touch ${marker}) and \`touch ${marker}\``,
      timestamp: Date.now(),
    }])

    expect(title).toBe('Safe archive title')
    expect(existsSync(marker)).toBe(false)
  })
})
