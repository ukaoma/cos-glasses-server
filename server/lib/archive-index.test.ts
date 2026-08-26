import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ARCHIVE_INDEX_SCHEMA,
  extractSummary,
  readIndexFile,
  refreshArchiveIndex,
  summariseDayFile,
} from './archive-index.js'

let dir: string
let indexPath: string

function day(date: string, chats: Array<{ exchangeCount: number }>, summary = `summary for ${date}`) {
  writeFileSync(
    join(dir, `${date}.json`),
    JSON.stringify({ date, summary, chats: chats.map((c, i) => ({ id: `c${i}`, exchangeCount: c.exchangeCount, exchanges: [] })), archivedAt: `${date}T23:59:00Z` }),
    'utf8',
  )
}

beforeEach(() => {
  // Dot in the path: the real store is ~/.cos-glasses, and a dotless fixture has
  // masked a production path bug in this codebase before.
  dir = mkdtempSync(join(tmpdir(), 'arch.idx.'))
  indexPath = join(dir, '..', `archive-index-${Math.abs(dir.length)}.json`)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(indexPath, { force: true })
})

describe('extractSummary', () => {
  it('pulls the top-level summary', () => {
    expect(extractSummary('{"date":"2026-08-24","summary":"a quiet day","chats":[')).toBe('a quiet day')
  })
  it('handles escapes without throwing', () => {
    expect(extractSummary('{"summary":"he said \\"go\\" then left"}')).toBe('he said "go" then left')
  })
  it('returns null when absent rather than guessing', () => {
    expect(extractSummary('{"date":"2026-08-24","chats":[]}')).toBeNull()
  })
})

describe('summariseDayFile', () => {
  it('counts chats and sums exchanges without parsing', async () => {
    day('2026-08-24', [{ exchangeCount: 5 }, { exchangeCount: 7 }, { exchangeCount: 1 }])
    const s = await summariseDayFile(join(dir, '2026-08-24.json'))
    expect(s.chatCount).toBe(3)
    expect(s.exchangeCount).toBe(13)
    expect(s.summary).toBe('summary for 2026-08-24')
  })

  it('reports zero for a day with no chats', async () => {
    day('2026-08-23', [])
    const s = await summariseDayFile(join(dir, '2026-08-23.json'))
    expect(s.chatCount).toBe(0)
    expect(s.exchangeCount).toBe(0)
  })
})

describe('refreshArchiveIndex', () => {
  it('builds on first run and serves from cache on the second', async () => {
    day('2026-08-24', [{ exchangeCount: 4 }])
    day('2026-08-23', [{ exchangeCount: 2 }, { exchangeCount: 3 }])

    const first = await refreshArchiveIndex(dir, indexPath)
    expect(first.rebuilt.sort()).toEqual(['2026-08-23', '2026-08-24'])
    expect(first.fromCache).toBe(0)
    expect(first.entries.map(e => e.date)).toEqual(['2026-08-24', '2026-08-23'])
    expect(first.entries[1].exchangeCount).toBe(5)

    const second = await refreshArchiveIndex(dir, indexPath)
    expect(second.rebuilt).toEqual([])
    expect(second.fromCache).toBe(2)
  })

  it('rebuilds a day whose bytes changed', async () => {
    day('2026-08-24', [{ exchangeCount: 4 }])
    await refreshArchiveIndex(dir, indexPath)

    day('2026-08-24', [{ exchangeCount: 4 }, { exchangeCount: 6 }])
    const r = await refreshArchiveIndex(dir, indexPath)
    expect(r.rebuilt).toEqual(['2026-08-24'])
    expect(r.entries[0].exchangeCount).toBe(10)
  })

  it('rebuilds when mtime moves even at identical size', async () => {
    // The size-only trap: an in-place edit that preserves length. mtime is the
    // half of the key that catches it.
    day('2026-08-24', [{ exchangeCount: 4 }])
    await refreshArchiveIndex(dir, indexPath)
    const p = join(dir, '2026-08-24.json')
    const before = statSync(p).size

    const rewritten = readFileSync(p, 'utf8').replace('"exchangeCount":4', '"exchangeCount":9')
    writeFileSync(p, rewritten, 'utf8')
    expect(statSync(p).size).toBe(before) // same length on purpose
    const later = new Date(Date.now() + 5000)
    utimesSync(p, later, later)

    const r = await refreshArchiveIndex(dir, indexPath)
    expect(r.rebuilt).toEqual(['2026-08-24'])
    expect(r.entries[0].exchangeCount).toBe(9)
  })

  it('drops entries for days that no longer exist', async () => {
    day('2026-08-24', [{ exchangeCount: 4 }])
    day('2026-08-23', [{ exchangeCount: 1 }])
    await refreshArchiveIndex(dir, indexPath)

    rmSync(join(dir, '2026-08-23.json'))
    const r = await refreshArchiveIndex(dir, indexPath)
    expect(r.dropped).toEqual(['2026-08-23'])
    expect(r.entries.map(e => e.date)).toEqual(['2026-08-24'])
  })

  it('ignores non-date json siblings', async () => {
    day('2026-08-24', [{ exchangeCount: 4 }])
    writeFileSync(join(dir, 'notes.json'), '{"nope":true}', 'utf8')
    const r = await refreshArchiveIndex(dir, indexPath)
    expect(r.entries.map(e => e.date)).toEqual(['2026-08-24'])
  })

  it('survives a corrupt index file by rebuilding', async () => {
    day('2026-08-24', [{ exchangeCount: 4 }])
    writeFileSync(indexPath, '{ this is not json', 'utf8')
    const r = await refreshArchiveIndex(dir, indexPath)
    expect(r.entries.map(e => e.date)).toEqual(['2026-08-24'])
  })

  it('discards an index written under a different schema', async () => {
    day('2026-08-24', [{ exchangeCount: 4 }])
    // The stale entry carries the file's REAL size and mtime, so the (size,mtime)
    // key would happily serve it. Only the schema check can reject it -- which is
    // the point: an earlier version of this test used size:1/mtimeMs:1, so
    // invalidation fired for the wrong reason and the test passed with the schema
    // guard removed. Caught by mutating the guard and watching it stay green.
    const st = statSync(join(dir, '2026-08-24.json'))
    writeFileSync(indexPath, JSON.stringify({
      schemaVersion: ARCHIVE_INDEX_SCHEMA + 1,
      entries: { '2026-08-24': { date: '2026-08-24', size: st.size, mtimeMs: st.mtimeMs, chatCount: 999, exchangeCount: 999, summary: null } },
    }), 'utf8')
    const r = await refreshArchiveIndex(dir, indexPath)
    expect(r.rebuilt).toEqual(['2026-08-24'])
    expect(r.entries[0].chatCount).toBe(1)
    expect(r.entries[0].exchangeCount).toBe(4)
  })

  it('returns an empty index for a missing directory rather than throwing', async () => {
    const r = await refreshArchiveIndex(join(dir, 'gone'), indexPath)
    expect(r.entries).toEqual([])
  })

  it('readIndexFile returns an empty index for an absent path', () => {
    expect(readIndexFile(join(dir, 'nope.json')).entries).toEqual({})
  })
})
