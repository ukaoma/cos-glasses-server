import { afterAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allocateTestDataHome } from '../test-support/data-home.js'
import { DATA_DIR } from '../server/lib/data-dir.js'

const root = mkdtempSync(join(tmpdir(), 'cos-data-isolation-check-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

it('isolates every data-backed path, including reused workers, without redirecting scripts', () => {
  const env: NodeJS.ProcessEnv = { COS_VITEST_RUN_DATA_DIR: root, COS_SCRIPTS_DIR: '/controlled/scripts' }
  const first = allocateTestDataHome(env)
  const firstPaths = { ...env }
  writeFileSync(join(first, 'retained.json'), '{}')
  const second = allocateTestDataHome(env)
  expect(second).not.toBe(first)
  for (const key of ['COS_DATA_DIR', 'COS_PROFILE_PATH', 'COS_TOKEN_AUDIT_FILE', 'COS_CURSOR_SPAWN_ROOT', 'COS_CURSOR_SPAWN_SOURCE', 'COS_MAINTENANCE_GATE_PATH']) {
    expect(env[key]).not.toBe(firstPaths[key])
    expect(env[key] === second || env[key]?.startsWith(second + '/')).toBe(true)
  }
  expect(readdirSync(second)).toEqual([])
  expect(env.COS_SCRIPTS_DIR).toBe('/controlled/scripts')
})

it('fails closed without a configured absolute run root', () => {
  expect(() => allocateTestDataHome({})).toThrow('Missing absolute')
  expect(() => allocateTestDataHome({ COS_VITEST_RUN_DATA_DIR: 'relative' })).toThrow('Missing absolute')
})

it('sets the safe home before product module imports capture it', () => {
  expect(DATA_DIR).toBe(process.env.COS_DATA_DIR)
  expect(DATA_DIR).not.toBe(process.env.COS_VITEST_RUN_DATA_DIR)
})
