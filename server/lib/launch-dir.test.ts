import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resetCosBrainDirCacheForTests,
  resolveCosBrainDir,
  resolveProviderWorkDir,
} from './launch-dir.js'

const roots: string[] = []
afterEach(() => {
  delete process.env.COS_WORKDIR
  delete process.env.COS_LAUNCH_DIR
  resetCosBrainDirCacheForTests()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('managed work directory detection', () => {
  it('accepts a selected AGENTS.md project', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-managed-workdir-'))
    roots.push(root)
    writeFileSync(join(root, 'AGENTS.md'), '# COS brain')
    expect(resolveCosBrainDir(root)).toBe(root)
  })

  it('accepts a starter-kit manifest and rejects an unrelated folder', () => {
    const brain = mkdtempSync(join(tmpdir(), 'cos-managed-brain-'))
    const empty = mkdtempSync(join(tmpdir(), 'cos-managed-empty-'))
    roots.push(brain, empty)
    mkdirSync(join(brain, '.cos'))
    writeFileSync(join(brain, '.cos', 'manifest.json'), '{}')
    expect(resolveCosBrainDir(brain)).toBe(brain)
    expect(resolveCosBrainDir(empty)).toBeNull()
  })

  it('makes COS_WORKDIR authoritative over legacy provider and pipeline cwd', () => {
    const selected = mkdtempSync(join(tmpdir(), 'cos-selected-workdir-'))
    const legacy = mkdtempSync(join(tmpdir(), 'cos-legacy-workdir-'))
    const scripts = mkdtempSync(join(tmpdir(), 'cos-scripts-workdir-'))
    roots.push(selected, legacy, scripts)
    writeFileSync(join(selected, 'AGENTS.md'), '# selected')
    process.env.COS_WORKDIR = selected
    resetCosBrainDirCacheForTests()
    expect(resolveProviderWorkDir({ legacyProviderDir: legacy, scriptsDir: scripts })).toBe(selected)
  })

  it('falls back to legacy provider cwd, then the COS scripts repository root', () => {
    const legacy = mkdtempSync(join(tmpdir(), 'cos-legacy-fallback-'))
    const root = mkdtempSync(join(tmpdir(), 'cos-scripts-root-'))
    const scripts = join(root, 'operations', 'scripts')
    roots.push(legacy, root)
    mkdirSync(scripts, { recursive: true })
    expect(resolveProviderWorkDir({ legacyProviderDir: legacy, scriptsDir: scripts })).toBe(legacy)
    expect(resolveProviderWorkDir({ scriptsDir: scripts })).toBe(root)
  })
})
