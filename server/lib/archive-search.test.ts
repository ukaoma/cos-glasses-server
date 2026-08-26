import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_LIMIT,
  MAX_SNIPPETS_PER_DAY,
  datesInRange,
  isArchiveDate,
  searchArchive,
  searchArchiveFile,
} from './archive-search.js'

let dir: string

function day(date: string, body: string) {
  writeFileSync(join(dir, `${date}.json`), body, 'utf8')
}

beforeAll(() => {
  // A dot in the path, because the real archive lives under ~/.cos-glasses and a
  // dotless mktemp fixture has hidden a production 404 in this codebase before.
  dir = mkdtempSync(join(tmpdir(), 'arch.search.'))
  day('2026-08-24', JSON.stringify({ date: '2026-08-24', chats: [{ exchanges: [{ content: 'the voiceprint model is missing' }] }] }))
  day('2026-08-20', JSON.stringify({ date: '2026-08-20', chats: [{ exchanges: [{ content: 'Chelsie asked about enrolment' }] }] }))
  day('2026-06-01', JSON.stringify({ date: '2026-06-01', chats: [{ exchanges: [{ content: 'older mention of voiceprint here' }] }] }))
  day('2026-03-02', JSON.stringify({ date: '2026-03-02', chats: [{ exchanges: [{ content: 'nothing relevant' }] }] }))
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('date helpers', () => {
  it('accepts only YYYY-MM-DD', () => {
    expect(isArchiveDate('2026-08-24')).toBe(true)
    expect(isArchiveDate('dates')).toBe(false)          // the /archive/dates trap
    expect(isArchiveDate('../../etc/hosts')).toBe(false)
    expect(isArchiveDate('2026-8-4')).toBe(false)
  })

  it('filters a range inclusively and returns newest first', () => {
    const all = ['2026-03-02', '2026-06-01', '2026-08-20', '2026-08-24']
    expect(datesInRange(all, '2026-06-01', '2026-08-20')).toEqual(['2026-08-20', '2026-06-01'])
    expect(datesInRange(all)).toEqual(['2026-08-24', '2026-08-20', '2026-06-01', '2026-03-02'])
  })
})

describe('searchArchive', () => {
  const dates = ['2026-08-24', '2026-08-20', '2026-06-01', '2026-03-02']

  it('finds a term across days, newest first', async () => {
    const r = await searchArchive({ dir, dates, query: 'voiceprint' })
    expect(r.hits.map(h => h.date)).toEqual(['2026-08-24', '2026-06-01'])
    expect(r.hits[0].snippets[0]).toContain('voiceprint')
  })

  it('is case-insensitive', async () => {
    const r = await searchArchive({ dir, dates, query: 'CHELSIE' })
    expect(r.hits.map(h => h.date)).toEqual(['2026-08-20'])
  })

  it('honours a date range', async () => {
    const r = await searchArchive({ dir, dates, query: 'voiceprint', from: '2026-07-01' })
    expect(r.hits.map(h => h.date)).toEqual(['2026-08-24'])
  })

  it('returns nothing for an absent term without throwing', async () => {
    const r = await searchArchive({ dir, dates, query: 'zzzznotpresent' })
    expect(r.hits).toEqual([])
    expect(r.scannedDays).toBe(4)
  })

  it('rejects a query below the minimum length', async () => {
    await expect(searchArchive({ dir, dates, query: 'a' })).rejects.toThrow(/at least/)
  })

  it('marks truncation when more days match than the limit', async () => {
    const r = await searchArchive({ dir, dates, query: 'voiceprint', limit: 1 })
    expect(r.hits).toHaveLength(1)
    expect(r.truncated).toBe(true)
  })

  it('survives a listed-but-missing day', async () => {
    const r = await searchArchive({ dir, dates: [...dates, '2026-01-01'], query: 'voiceprint' })
    expect(r.hits.map(h => h.date)).toEqual(['2026-08-24', '2026-06-01'])
  })

  it('defaults the limit rather than returning everything unbounded', async () => {
    const r = await searchArchive({ dir, dates, query: 'voiceprint' })
    expect(r.hits.length).toBeLessThanOrEqual(DEFAULT_LIMIT)
  })
})

describe('chunk boundary', () => {
  // THE test. The reader pulls 1 MiB at a time, so a term straddling that
  // boundary is invisible to a naive per-chunk indexOf. Every fixture above is
  // far under 1 MiB and would pass with the overlap deleted, which is exactly how
  // this bug reaches production: green tests, silent hit loss on the real
  // multi-megabyte days.
  const CHUNK = 1 << 20
  const NEEDLE = 'straddlingterm'

  it('finds a term split across the 1MiB read boundary', async () => {
    const bdir = mkdtempSync(join(tmpdir(), 'arch.bound.'))
    try {
      // Place the needle so it starts 4 bytes before the boundary and ends after.
      const head = 'x'.repeat(CHUNK - 4)
      writeFileSync(join(bdir, '2026-08-01.json'), head + NEEDLE + 'y'.repeat(64), 'utf8')

      const direct = await searchArchiveFile(join(bdir, '2026-08-01.json'), NEEDLE)
      expect(direct).not.toBeNull()
      expect(direct!.matches).toBe(1)

      const r = await searchArchive({ dir: bdir, dates: ['2026-08-01'], query: NEEDLE })
      expect(r.hits).toHaveLength(1)
      expect(r.hits[0].matches).toBe(1)
    } finally {
      rmSync(bdir, { recursive: true, force: true })
    }
  })

  it('does not double-count a term sitting inside the carried overlap', async () => {
    const bdir = mkdtempSync(join(tmpdir(), 'arch.dupe.'))
    try {
      // Exactly one occurrence, positioned so it lands in the carry window.
      const head = 'x'.repeat(CHUNK - Math.floor(NEEDLE.length / 2))
      writeFileSync(join(bdir, '2026-08-02.json'), head + NEEDLE + 'z'.repeat(4096), 'utf8')
      const direct = await searchArchiveFile(join(bdir, '2026-08-02.json'), NEEDLE)
      expect(direct!.matches).toBe(1)
    } finally {
      rmSync(bdir, { recursive: true, force: true })
    }
  })
})

describe('snippet capping', () => {
  it('caps snippets per day while still counting every match', async () => {
    const cdir = mkdtempSync(join(tmpdir(), 'arch.cap.'))
    try {
      const repeated = Array.from({ length: 40 }, (_, i) => `entry ${i} repeatedterm value`).join(' ')
      writeFileSync(join(cdir, '2026-08-03.json'), repeated, 'utf8')
      const r = await searchArchive({ dir: cdir, dates: ['2026-08-03'], query: 'repeatedterm' })
      expect(r.hits[0].matches).toBe(40)
      expect(r.hits[0].snippets.length).toBe(MAX_SNIPPETS_PER_DAY)
    } finally {
      rmSync(cdir, { recursive: true, force: true })
    }
  })
})
