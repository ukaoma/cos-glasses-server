// The row helpers behind the imported library (6.47.0, WS5).
//
// The route tests drive these through HTTP, which is where supersession has to
// be right. Two rules cannot be reached that way and are pinned here instead:
// the derived dedupe (the listers produce one row per file, so a duplicate only
// arrives from a store that has one) and the day-count filter (a date whose rows
// are all superseded has to DISAPPEAR, not show a zero or a negative).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  dedupeDerivedRows,
  dropSupersededRows,
  mergeDayCounts,
  summarizeDerivedSidecar,
  supersededDayCounts,
  supersededFromRows,
  withDerivedIdentity,
} from './imported-library-rows.js'
import { ImportedMeetingLibrary } from './imported-meeting-library.js'
import { MeetingStore, type MeetingMeta } from './meeting-store.js'

const temps: string[] = []
afterEach(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true })
})

function row(partial: Partial<MeetingMeta>): MeetingMeta {
  return {
    filename: '2026-09-10_merged_00112233445566aa.md',
    title: 'Launch review',
    date: '2026-09-10',
    domain: 'imported',
    domainAbbr: 'IMP',
    source: 'G2 Glasses + Fireflies',
    duration: '28 minutes',
    month: '2026-09',
    ...partial,
  }
}

describe('derived row helpers', () => {
  it('keeps one row per recordId, because a split piece has no session to dedupe on', () => {
    const kept = dedupeDerivedRows([
      row({ recordId: 'blended:aaaaaaaaaaaaaaaa', filename: 'a.md' }),
      row({ recordId: 'blended:aaaaaaaaaaaaaaaa', filename: 'a-copy.md' }),
      row({ recordId: 'blended:bbbbbbbbbbbbbbbb', filename: 'b.md' }),
    ])
    expect(kept.map(entry => entry.filename)).toEqual(['a.md', 'b.md'])
  })

  it('falls back to month and filename when a row carries no recordId', () => {
    const kept = dedupeDerivedRows([
      row({ filename: 'a.md' }),
      row({ filename: 'a.md' }),
      row({ filename: 'b.md' }),
    ])
    expect(kept).toHaveLength(2)
  })

  it('drops a date whose every row was superseded, rather than showing it as zero', () => {
    // A negative total is a double subtraction and would be worse than a zero:
    // it would silently cancel a real meeting on the same day.
    expect(mergeDayCounts([
      [{ date: '2026-09-10', count: 2 }, { date: '2026-09-11', count: 1 }],
      [{ date: '2026-09-10', count: -2 }, { date: '2026-09-11', count: -2 }],
    ])).toEqual([])
    expect(mergeDayCounts([
      [{ date: '2026-09-10', count: 2 }],
      [{ date: '2026-09-10', count: -1 }],
    ])).toEqual([{ date: '2026-09-10', count: 1 }])
  })

  it('reads inputs, action and piece identity out of a derived sidecar', () => {
    const summary = summarizeDerivedSidecar({
      version: 1,
      actionId: 'a_00112233445566aa',
      kind: 'split',
      inputs: [
        { kind: 'fireflies', id: 'ff-1', sha256: null },
        { kind: 'g2', id: 'sess-1', sha256: null },
        { kind: 'other', id: 'ignored' },
        'not an object',
      ],
      pieces: [{ index: 2, sessionIds: ['sess-1'] }],
    }, { recordId: 'blended:00112233445566aa', month: '2026-09', filename: 'p.md', kind: 'piece' })
    expect(summary).toMatchObject({
      kind: 'split', actionId: 'a_00112233445566aa', pieceIndex: 2, sourceSessionId: 'sess-1',
      g2SessionIds: ['sess-1'], firefliesIds: ['ff-1'],
    })
  })

  it('degrades to null on a sidecar it cannot read as an object', () => {
    for (const value of [null, undefined, 'text', 42, ['array']]) {
      expect(summarizeDerivedSidecar(value, {
        recordId: 'blended:00112233445566aa', month: '2026-09', filename: 'p.md', kind: 'merged',
      })).toBeNull()
    }
  })

  it('gives a merged row the earliest capture and a piece none at all', () => {
    const merged = withDerivedIdentity(row({ recordId: 'blended:a' }), {
      recordId: 'blended:a', month: '2026-09', filename: 'm.md', kind: 'merge',
      actionId: 'a_1', g2SessionIds: ['sess-1', 'sess-2'], firefliesIds: ['ff-1'],
    })
    expect(merged).toMatchObject({ sessionId: 'sess-1', g2SessionIds: ['sess-1', 'sess-2'], actionId: 'a_1' })

    const piece = withDerivedIdentity(row({ recordId: 'blended:b', sessionId: 'sess-1' }), {
      recordId: 'blended:b', month: '2026-09', filename: 'p.md', kind: 'split',
      g2SessionIds: ['sess-1'], firefliesIds: ['ff-1'], pieceIndex: 1, sourceSessionId: 'sess-1',
    })
    expect(piece.sessionId).toBeUndefined()
    expect(piece).toMatchObject({ pieceIndex: 1, sourceSessionId: 'sess-1' })
  })

  it('refuses a month that is not a month, rather than reading whatever folder it names', () => {
    // The imports day scan builds its path from the month string directly, so a
    // month that never went through the pattern would read any folder whose name
    // the caller chose. The list route validates its own query, but this helper
    // is also called from the morning brief, where the month comes from a
    // directory listing.
    const parent = mkdtempSync(join(tmpdir(), 'cos-rows-month-'))
    temps.push(parent)
    const importsRoot = join(parent, 'imports')
    // `2026-7` is one digit short: the pattern rejects it, a readdir would not.
    mkdirSync(join(importsRoot, '2026-7'), { recursive: true })
    writeFileSync(
      join(importsRoot, '2026-7', '2026-07-15_fireflies_00112233445566aa.md'),
      '# T\n\n| **Date** | 2026-07-15 |\n',
    )
    const options = {
      store: new MeetingStore(join(parent, 'recordings')),
      library: new ImportedMeetingLibrary({ root: importsRoot }),
    }
    expect(supersededDayCounts('2026-7', 'standalone', options)).toEqual([])
    expect(supersededDayCounts('../../etc', 'standalone', options)).toEqual([])
    expect(supersededDayCounts('2026-13', 'standalone', options)).toEqual([])
  })

  it('reads the sessions an operations row declares, and never drops the row that declared them', () => {
    const rows = [
      row({ recordId: 'ops:personal:2026-09:merged.md', derivedKind: 'merge', sessionId: 'sess-1', g2SessionIds: ['sess-1', 'sess-2'] }),
      row({ recordId: 'ops:personal:2026-09:a.md', sessionId: 'sess-1', filename: 'a.md' }),
      row({ recordId: 'ops:personal:2026-09:b.md', sessionId: 'sess-2', filename: 'b.md' }),
      row({ recordId: 'ops:personal:2026-09:c.md', sessionId: 'sess-3', filename: 'c.md' }),
    ]
    const kept = dropSupersededRows(rows, supersededFromRows(rows))
    expect(kept.map(entry => entry.recordId)).toEqual(['ops:personal:2026-09:merged.md', 'ops:personal:2026-09:c.md'])
  })
})
