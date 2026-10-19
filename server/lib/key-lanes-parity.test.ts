// Key lanes K1, QA G8: the companion app copies three server files byte for byte. Their SHA-256
// lives in one manifest (server/lib/__fixtures__/key-lanes/parity.json) that this test keeps
// honest: a change to any of them without the manifest fails here, so the app's parity test, which
// reads the manifest at the server tip instead of a frozen commit, sees every later drift.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = join(import.meta.dirname, '..', '..')
const manifest = JSON.parse(readFileSync(join(REPO, 'server', 'lib', '__fixtures__', 'key-lanes', 'parity.json'), 'utf8')) as { files: Record<string, string> }

describe('key-lane parity manifest (QA G8)', () => {
  it('names the three copied files and matches each byte for byte', () => {
    expect(Object.keys(manifest.files).sort()).toEqual(['server/lib/key-notices.ts', 'server/lib/key-relay-contract.ts', 'shared/key-preference.ts'])
    for (const [file, sha] of Object.entries(manifest.files)) {
      expect(createHash('sha256').update(readFileSync(join(REPO, file))).digest('hex'), file).toBe(sha)
    }
  })
})
