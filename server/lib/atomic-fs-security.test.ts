import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atomicWriteFileSync } from './atomic-fs.js'

describe('private atomic persistence', () => {
  it('creates private files by default and repairs an existing permissive destination', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-private-atomic-'))
    try {
      const path = join(root, 'state.json')
      writeFileSync(path, '{}', { mode: 0o644 })

      atomicWriteFileSync(path, '{"safe":true}')

      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
