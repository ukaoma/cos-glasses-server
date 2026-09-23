import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, afterAll } from 'vitest'
import {
  resetCosBrainDirCacheForTests,
  resolveCosBrainDir,
  resolveProviderWorkDir,
} from './launch-dir.js'

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

const roots: string[] = []
afterEach(() => {
  delete process.env.COS_WORKDIR
  delete process.env.COS_LAUNCH_DIR
  resetCosBrainDirCacheForTests()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('managed work directory detection', () => {
  it('accepts a selected AGENTS.md project', () => {
    const root = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-managed-workdir-')))
    roots.push(root)
    writeFileSync(join(root, 'AGENTS.md'), '# COS brain')
    expect(resolveCosBrainDir(root)).toBe(root)
  })

  it('accepts a starter-kit manifest and rejects an unrelated folder', () => {
    const brain = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-managed-brain-')))
    const empty = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-managed-empty-')))
    roots.push(brain, empty)
    mkdirSync(join(brain, '.cos'))
    writeFileSync(join(brain, '.cos', 'manifest.json'), '{}')
    expect(resolveCosBrainDir(brain)).toBe(brain)
    expect(resolveCosBrainDir(empty)).toBeNull()
  })

  it('makes COS_WORKDIR authoritative over legacy provider and pipeline cwd', () => {
    const selected = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-selected-workdir-')))
    const legacy = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-legacy-workdir-')))
    const scripts = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-scripts-workdir-')))
    roots.push(selected, legacy, scripts)
    writeFileSync(join(selected, 'AGENTS.md'), '# selected')
    process.env.COS_WORKDIR = selected
    resetCosBrainDirCacheForTests()
    expect(resolveProviderWorkDir({ legacyProviderDir: legacy, scriptsDir: scripts })).toBe(selected)
  })

  it('falls back to legacy provider cwd, then the COS scripts repository root', () => {
    const legacy = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-legacy-fallback-')))
    const root = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-scripts-root-')))
    const scripts = join(root, 'operations', 'scripts')
    roots.push(legacy, root)
    mkdirSync(scripts, { recursive: true })
    expect(resolveProviderWorkDir({ legacyProviderDir: legacy, scriptsDir: scripts })).toBe(legacy)
    expect(resolveProviderWorkDir({ scriptsDir: scripts })).toBe(root)
  })
})
