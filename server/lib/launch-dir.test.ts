import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveCosBrainDir } from './launch-dir.js'

const roots: string[] = []
afterEach(() => {
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
})
