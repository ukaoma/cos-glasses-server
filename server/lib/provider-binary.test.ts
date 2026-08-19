import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  resolveBinaryFromSpec,
  resolveProviderBinary,
  STALE_SHIM_PREFIXES,
  type BinarySpec,
} from './provider-binary.js'

function scratchBin(name = 'codex'): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cos-provider-binary-'))
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\necho ok\n')
  chmodSync(path, 0o755)
  return { dir, path }
}

/**
 * These run the REAL algorithm against a real filesystem. The bug being guarded is a
 * runtime resolution failure under a PATH the login shell never has -- a source-text
 * assertion cannot observe that, so every case here resolves something.
 *
 * Note the deliberate absence of `env -i`: stripping the whole environment breaks
 * Keychain and produces false diagnoses. Only PATH is substituted.
 */
describe('provider binary resolution', () => {
  it('yields an absolute, executable path from a PATH the login shell would not have', () => {
    const { dir, path } = scratchBin()
    const spec: BinarySpec = { name: 'codex', envKeys: [], absolutes: [] }
    const resolved = resolveBinaryFromSpec(spec, { PATH: `/usr/bin:/bin:${dir}` })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.path).toBe(path)
    expect(resolved.path.startsWith('/')).toBe(true)
    expect(resolved.source).toBe('path')
  })

  it('refuses instead of returning a bare name when nothing resolves', () => {
    const spec: BinarySpec = { name: 'codex', envKeys: [], absolutes: [] }
    const resolved = resolveBinaryFromSpec(spec, { PATH: '/nonexistent-cos-probe' })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.detail).toBe('not_found')
    // The whole point: a caller can never spawn `'codex'` by accident.
    expect(resolved).not.toHaveProperty('path')
  })

  it('REFUSES an unusable env override rather than falling through to a good candidate', () => {
    const { path } = scratchBin()
    const spec: BinarySpec = { name: 'codex', envKeys: ['COS_CODEX_BIN'], absolutes: [path] }
    const resolved = resolveBinaryFromSpec(spec, { COS_CODEX_BIN: '/nope/not/here', PATH: '' })
    // An operator who set it wrongly needs telling, not silently overriding.
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.detail).toBe('env_override_unusable')
  })

  it('excludes a stale shim even when it is a real executable', () => {
    const { dir } = scratchBin()
    const shimRoot = join(dir, 'Applications', 'Codex.app')
    mkdirSync(shimRoot, { recursive: true })
    const shim = join(shimRoot, 'codex')
    writeFileSync(shim, '#!/bin/sh\necho stale\n')
    chmodSync(shim, 0o755)
    const spec: BinarySpec = {
      name: 'codex',
      envKeys: [],
      absolutes: [shim],
      excludePrefixes: [shimRoot],
    }
    expect(resolveBinaryFromSpec(spec, { PATH: '' }).ok).toBe(false)
  })

  it('prefers an absolute candidate over PATH, so a shim on PATH cannot win', () => {
    const good = scratchBin()
    const onPath = scratchBin()
    const spec: BinarySpec = { name: 'codex', envKeys: [], absolutes: [good.path] }
    const resolved = resolveBinaryFromSpec(spec, { PATH: onPath.dir })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.path).toBe(good.path)
    expect(resolved.source).toBe('absolute')
  })

  it('still exports the real stale-shim prefix', () => {
    expect(STALE_SHIM_PREFIXES).toContain('/Applications/Codex.app/')
  })

  it('resolves codex on THIS machine with a PATH that contains nothing', () => {
    // The end-to-end property the four call-site changes exist for: a launchd- or
    // Finder-spawned process has no useful PATH, and resolution must still succeed
    // because the spec tries ChatGPT.app as an absolute BEFORE any PATH scan.
    //
    // Skipped rather than failed where that app is absent -- this asserts a fact about
    // the host, and a machine without ChatGPT.app installed is not a regression.
    const resolved = resolveProviderBinary('codex', { PATH: '/nonexistent-cos-probe' })
    if (!resolved.ok) {
      expect(existsSync('/Applications/ChatGPT.app/Contents/Resources/codex')).toBe(false)
      return
    }
    expect(resolved.source).toBe('absolute')
    expect(resolved.path.startsWith('/')).toBe(true)
    expect(resolved.path).not.toContain('/Applications/Codex.app/')
  })
})

/**
 * A narrow regression pin, kept deliberately as a text scan.
 *
 * Four sites spawned `codex` by bare name; on this machine they worked only because COS
 * Control injects ChatGPT.app onto the managed plist PATH, so no runtime test on THIS
 * machine can fail the way a public npx install does. This is the one assertion that can.
 */
describe('no provider is spawned by bare name', () => {
  const files = [
    'server/lib/codex-bridge.ts',
    'server/lib/codex-model-catalog.ts',
    'server/lib/health-static-probes.ts',
  ]
  it.each(files)('%s spawns a resolved path', file => {
    const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    expect(src).not.toMatch(/spawn(?:Sync)?\(\s*'codex'/)
    expect(src).not.toMatch(/execute\(\s*'codex'/)
    expect(src).toContain("resolveProviderBinary('codex')")
  })
})
