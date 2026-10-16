// 6.74.0: speaker separation also finds a TRUSTED Parakeet CLI (diarizer-backend.ts
// trustedParakeetCli), after every earlier location. Untrusted copies are ignored.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir = ''
const apps = () => join(dir, 'Applications')
const helper = () => join(apps(), 'COS Control.app', 'Contents', 'Helpers', 'fluidaudiocli')
const home = () => join(dir, 'home')
const fake = (over: { team?: string; identifier?: string } = {}) => ({
  display: async () => ({ code: 0, output: `Identifier=${over.identifier ?? 'com.gotcos.control.fluidaudiocli'}\nInfo.plist entries=2\nTeamIdentifier=${over.team ?? 'NV3X46LLCR'}\n` }),
  verify: async () => ({ code: 0, output: '' }),
  embeddedPlist: () => '<key>CFBundleIdentifier</key><string>com.gotcos.control.fluidaudiocli</string><key>CFBundleShortVersionString</key><string>0.17.4</string>',
  sha256: async () => 'c'.repeat(64),
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cos-diarizer-cli-'))
  mkdirSync(home(), { recursive: true })
  process.env.COS_DATA_DIR = join(dir, 'data')
  vi.resetModules()
})
afterEach(() => {
  vi.doUnmock('./parakeet.js')
  delete process.env.COS_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

async function load(installed: boolean | null | (() => boolean | null) = false) {
  vi.doMock('./parakeet.js', async orig => {
    const real: any = await orig()
    return { ...real, installedCliTrustedNow: () => typeof installed === 'function' ? installed() : installed, parakeetCliPath: () => join(dir, 'data', 'stt', 'parakeet', 'current', 'bin', 'fluidaudiocli') }
  })
  const B = await import('./diarizer-backend.js')
  const T = await import('./parakeet-cli-trust.js')
  T.__resetCliTrustForTests()
  T.__setApplicationsRootForTests(apps())
  return { B, T }
}
function placeHelper(): string {
  mkdirSync(join(helper(), '..'), { recursive: true })
  writeFileSync(helper(), 'bundled')
  return helper()
}
const noEnv = () => ({ PATH: '/usr/bin:/bin' })

describe('diarizer lookup: trusted Parakeet CLI locations', () => {
  it('finds the GUI-installed CLI when its install and bytes are verified', async () => {
    const { B } = await load(true)
    expect(B.nemotronCliPath(noEnv(), home())).toBe(join(dir, 'data', 'stt', 'parakeet', 'current', 'bin', 'fluidaudiocli'))
  })

  it('a later lookup (cached PATH search) still finds a CLI that became trusted', async () => {
    let state: boolean | null = null
    const { B } = await load(() => state)
    expect(B.nemotronCliPath(noEnv(), home())).toBeNull()
    state = true
    expect(B.nemotronCliPath(noEnv(), home())).toBe(join(dir, 'data', 'stt', 'parakeet', 'current', 'bin', 'fluidaudiocli'))
  })

  it('ignores the GUI-installed CLI while unverified or untrusted', async () => {
    for (const state of [false, null] as const) {
      vi.resetModules()
      const { B } = await load(state)
      expect(B.nemotronCliPath(noEnv(), home()), String(state)).toBeNull()
    }
  })

  it('finds COS Control bundled CLI once it is trusted (Developer ID of the COS team)', async () => {
    const { B, T } = await load(false)
    const path = placeHelper()
    await T.trustCli(path, fake())
    expect(B.nemotronCliPath(noEnv(), home())).toBe(path)
  })

  it('an unchecked bundled CLI is skipped, never run, and the lookup does not wait for its check', async () => {
    const { B } = await load(false)
    placeHelper()
    const t0 = Date.now()
    expect(B.nemotronCliPath(noEnv(), home())).toBeNull()
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it.each([
    ['another team', { team: 'ABCDE12345' }],
    ['another identifier', { identifier: 'com.gotcos.fluidaudiocli' }],
  ])('ignores a bundled CLI from %s', async (_label, over) => {
    const { B, T } = await load(false)
    const path = placeHelper()
    await T.trustCli(path, fake(over))
    expect(B.nemotronCliPath(noEnv(), home())).toBeNull()
  })

  it('keeps the existing order: COS_NEMOTRON_CLI, then ~/.cos-glasses/bin, before any Parakeet copy', async () => {
    const { B, T } = await load(true)
    const path = placeHelper()
    await T.trustCli(path, fake())
    const explicit = join(dir, 'explicit-cli'); writeFileSync(explicit, '')
    expect(B.nemotronCliPath({ ...noEnv(), COS_NEMOTRON_CLI: explicit }, home())).toBe(explicit)
    // An explicit override that is missing is the answer: no fall-through to Parakeet.
    expect(B.nemotronCliPath({ ...noEnv(), COS_NEMOTRON_CLI: '/no/such/fluidaudiocli' }, home())).toBeNull()
    const cos = join(home(), '.cos-glasses', 'bin', 'fluidaudiocli')
    mkdirSync(join(cos, '..'), { recursive: true }); writeFileSync(cos, '')
    expect(B.nemotronCliPath(noEnv(), home())).toBe(cos)
  })

  it('activeDiarizer no longer reports cli_missing when only a trusted Parakeet CLI exists (models still required)', async () => {
    const { B } = await load(true)
    const choice = B.activeDiarizer({ ...noEnv(), COS_DIARIZER: 'nemotron' }, home())
    expect(choice.fallback).toBe('models_missing')
  })
})
