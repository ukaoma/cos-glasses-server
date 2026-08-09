import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  EXAMPLE_MEETING_DOMAINS,
  discoverMeetingDomains,
  domainAbbreviation,
  getDirectLibraryMeetingDetail,
  inspectMeetingLibraryPath,
  listDirectLibraryMeetings,
  listCosOperationsMeetings,
  resolveMeetingLibrary,
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
      expect(resolveCosOperationsDir()).toBe(realpathSync(root))
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

  it('keeps a legacy multi-domain COS_MEETINGS_ROOT as the operations root', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-legacy-meetings-'))
    try {
      mkdirSync(join(root, 'clinical', 'meetings', '2026-08'), { recursive: true })
      delete process.env.COS_OPERATIONS_DIR
      process.env.COS_MEETINGS_ROOT = root
      expect(resolveCosOperationsDir()).toBe(realpathSync(root))
      expect(resolveMeetingLibrary().layout).toBe('multi_domain')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('accepts an existing direct YYYY-MM library without making it a write root', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-direct-meetings-'))
    try {
      mkdirSync(join(root, '2026-03'), { recursive: true })
      mkdirSync(join(root, '2026-08'), { recursive: true })
      writeFileSync(join(root, '2026-03', '2026-03-01_Older.md'), '# Older\n\n**Date** | 2026-03-01 |\n')
      writeFileSync(join(root, '2026-08', '2026-08-08_Queen.md'), '# Queen Meeting\n\n**Date** | 2026-08-08 18:00 |\n\n## Summary\nVisible\n')
      delete process.env.COS_OPERATIONS_DIR
      delete process.env.COS_SCRIPTS_DIR
      process.env.COS_MEETINGS_ROOT = root
      expect(inspectMeetingLibraryPath(root).layout).toBe('direct')
      expect(resolveCosOperationsDir()).toBeNull()
      expect(resolveMeetingLibrary().layout).toBe('direct')
      const rows = listDirectLibraryMeetings({ limit: 10 })
      expect(rows.map(row => row.title)).toEqual(['Queen Meeting', 'Older'])
      expect(rows.every(row => row.mutable === false && row.librarySource === 'direct_library')).toBe(true)
      expect(rows.every(row => row.canonicalRecord == null)).toBe(true)
      expect(getDirectLibraryMeetingDetail('2026-08', '2026-08-08_Queen.md')?.summary).toBe('Visible')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('does not silently fall back when an explicit direct root disappears', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-missing-meetings-'))
    process.env.COS_MEETINGS_ROOT = root
    rmSync(root, { recursive: true, force: true })
    expect(resolveMeetingLibrary().layout).toBe('invalid_explicit_root')
  })
})

/**
 * Domains are DISCOVERED, not enumerated.
 *
 * Queen set up her own COS on 2026-08-08 and every folder she picked was
 * rejected, because both the Control validator and this module carried
 * `['quilt','sprocket_rocket','hermit_crabs','personal']` — one user's business
 * domains, shipped as a requirement. Her tree has none of them.
 */
describe('meeting domains are discovered from the chosen directory', () => {
  const withTree = (build: (root: string) => void, run: (root: string) => void) => {
    const root = mkdtempSync(join(tmpdir(), 'cos-ops-discover-'))
    try { build(root); process.env.COS_OPERATIONS_DIR = root; run(root) }
    finally { rmSync(root, { recursive: true, force: true }) }
  }
  const scribe = (root: string, domain: string, name: string) => {
    mkdirSync(join(root, domain, 'meetings', '2026-08'), { recursive: true })
    writeFileSync(join(root, domain, 'meetings', '2026-08', name),
      '# A Meeting\n\n**Date** | 2026-08-08 10:00 |\n\n## Summary\nBody\n')
  }

  it('finds a domain that is nobody\'s business unit, with a space in the name', () => {
    withTree(root => scribe(root, 'DNP study', '2026-08-08_Cohort_Review.md'), root => {
      expect(discoverMeetingDomains(root)).toEqual(['DNP study'])
      const meetings = listCosOperationsMeetings({ limit: 5 })
      expect(meetings).toHaveLength(1)
      expect(meetings[0].domain).toBe('DNP study')
    })
  })

  it('does not require any of one user\'s four domains to be present', () => {
    withTree(root => { scribe(root, 'ascension', 'a.md'); scribe(root, 'clinicals', 'b.md') }, root => {
      const found = discoverMeetingDomains(root)
      expect(found).toEqual(['ascension', 'clinicals'])
      for (const mine of EXAMPLE_MEETING_DOMAINS) expect(found).not.toContain(mine)
      expect(listCosOperationsMeetings({ limit: 5 })).toHaveLength(2)
    })
  })

  it('filters by a discovered domain, and rejects one that is not there', () => {
    withTree(root => { scribe(root, 'ascension', 'a.md'); scribe(root, 'clinicals', 'b.md') }, () => {
      expect(listCosOperationsMeetings({ domain: 'ascension' })).toHaveLength(1)
      expect(listCosOperationsMeetings({ domain: 'quilt' })).toHaveLength(0)
    })
  })

  it('ignores a subdirectory with no meetings/ tree', () => {
    withTree(root => {
      scribe(root, 'personal', 'p.md')
      mkdirSync(join(root, 'scripts'), { recursive: true })
      mkdirSync(join(root, 'intelligence', 'timeseries'), { recursive: true })
    }, root => expect(discoverMeetingDomains(root)).toEqual(['personal']))
  })

  it('ignores hidden directories', () => {
    withTree(root => {
      scribe(root, 'personal', 'p.md')
      mkdirSync(join(root, '.meeting_archive', 'meetings'), { recursive: true })
    }, root => expect(discoverMeetingDomains(root)).toEqual(['personal']))
  })

  it('returns nothing for a directory that does not exist', () => {
    expect(discoverMeetingDomains('/nope/not/here')).toEqual([])
  })
})

describe('domainAbbreviation replaces the hand-written table exactly', () => {
  it('reproduces every entry the old DOMAIN_ABBR map had', () => {
    // The table is deleted; this equivalence is why that was safe. If a future
    // edit changes derivation, this fails rather than silently relabelling
    // every existing user's rows.
    expect(domainAbbreviation('quilt')).toBe('Q')
    expect(domainAbbreviation('personal')).toBe('P')
    expect(domainAbbreviation('hermit_crabs')).toBe('HC')
    expect(domainAbbreviation('sprocket_rocket')).toBe('SR')
  })

  it('derives something sensible for a domain nobody predicted', () => {
    expect(domainAbbreviation('DNP study')).toBe('DS')
    expect(domainAbbreviation('ascension')).toBe('A')
    expect(domainAbbreviation('research-lab notes')).toBe('RL')
  })

  it('never returns an empty badge', () => {
    expect(domainAbbreviation('___')).toBe('?')
    expect(domainAbbreviation('')).toBe('?')
  })
})
