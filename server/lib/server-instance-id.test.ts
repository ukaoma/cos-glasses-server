import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetServerInstanceIdForTests,
  getServerInstanceId,
  initializeServerInstanceId,
} from './server-instance-id.js'

afterEach(() => __resetServerInstanceIdForTests())

describe('stable server instance id', () => {
  it('persists one mode-0600 UUID across process initialization', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-instance-id-'))
    const path = join(root, 'nested', 'id')
    const first = initializeServerInstanceId(path)
    expect(getServerInstanceId()).toBe(first)
    expect(readFileSync(path, 'utf8').trim()).toBe(first)
    expect(statSync(path).mode & 0o777).toBe(0o600)

    __resetServerInstanceIdForTests()
    expect(initializeServerInstanceId(path)).toBe(first)
  })

  it('replaces invalid legacy contents with a valid UUID', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-instance-id-'))
    const path = join(root, 'id')
    writeFileSync(path, 'broken\n')
    chmodSync(path, 0o644)
    const id = initializeServerInstanceId(path)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
