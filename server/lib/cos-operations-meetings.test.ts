import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listCosOperationsMeetings,
  resolveCosOperationsDir,
} from './cos-operations-meetings.js'

const previous = {
  COS_OPERATIONS_DIR: process.env.COS_OPERATIONS_DIR,
  COS_MEETINGS_ROOT: process.env.COS_MEETINGS_ROOT,
  COS_SCRIPTS_DIR: process.env.COS_SCRIPTS_DIR,
}

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
})

describe('cos operations meetings path resolution', () => {
  it('prefers COS_OPERATIONS_DIR over scripts inference', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-ops-meetings-'))
    try {
      mkdirSync(join(root, 'quilt', 'meetings', '2026-07'), { recursive: true })
      writeFileSync(
        join(root, 'quilt', 'meetings', '2026-07', '2026-07-22_Planning.md'),
        '# Planning\n\n**Date** | 2026-07-22 14:30 |\n\n## Summary\nHello\n',
      )
      process.env.COS_OPERATIONS_DIR = root
      process.env.COS_SCRIPTS_DIR = '/tmp/does-not-matter/scripts'
      expect(resolveCosOperationsDir()).toBe(root)
      const meetings = listCosOperationsMeetings({ limit: 5 })
      expect(meetings).toHaveLength(1)
      expect(meetings[0].title).toBe('Planning')
      expect(meetings[0].domain).toBe('quilt')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns empty when no ops path is configured', () => {
    delete process.env.COS_OPERATIONS_DIR
    delete process.env.COS_MEETINGS_ROOT
    delete process.env.COS_SCRIPTS_DIR
    expect(resolveCosOperationsDir()).toBeNull()
    expect(listCosOperationsMeetings()).toEqual([])
  })
})
