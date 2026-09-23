import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, afterAll } from 'vitest'
import {
  __resetServerInstanceIdForTests,
  getServerInstanceId,
  initializeServerInstanceId,
} from './server-instance-id.js'

// Every temp root this file makes is removed when the file ends (6.53.3 /qa W3: the suites
// had left ~150,000 `cos-*` folders in $TMPDIR). Tracked at the mkdtemp call, so a new test
// cannot forget it.
const trackedTempRoots: string[] = []
function trackedTemp<T extends string>(root: T): T {
  trackedTempRoots.push(root)
  return root
}
afterAll(() => {
  for (const root of trackedTempRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* a chmod'ed tree: best effort */ }
  }
})

afterEach(() => __resetServerInstanceIdForTests())

describe('stable server instance id', () => {
  it('persists one mode-0600 UUID across process initialization', () => {
    const root = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-instance-id-')))
    const path = join(root, 'nested', 'id')
    const first = initializeServerInstanceId(path)
    expect(getServerInstanceId()).toBe(first)
    expect(readFileSync(path, 'utf8').trim()).toBe(first)
    expect(statSync(path).mode & 0o777).toBe(0o600)

    __resetServerInstanceIdForTests()
    expect(initializeServerInstanceId(path)).toBe(first)
  })

  it('replaces invalid legacy contents with a valid UUID', () => {
    const root = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-instance-id-')))
    const path = join(root, 'id')
    writeFileSync(path, 'broken\n')
    chmodSync(path, 0o644)
    const id = initializeServerInstanceId(path)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
