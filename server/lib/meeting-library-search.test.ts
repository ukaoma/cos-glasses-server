import { describe, expect, it } from 'vitest'
import {
  libraryRefFromPath,
  mergeMeetingSearchHits,
  scoreKeywordMatch,
  tokenizeMeetingQuery,
  type MeetingSearchHit,
} from './meeting-library-search.js'

function hit(partial: Partial<MeetingSearchHit> & Pick<MeetingSearchHit, 'recordId' | 'filename'>): MeetingSearchHit {
  return {
    title: 'Untitled',
    date: '2026-08-12',
    domain: 'quilt',
    duration: '',
    month: '2026-08',
    source: '',
    snippet: '',
    keywordScore: 0,
    semanticScore: 0,
    match: 'keyword',
    ...partial,
  }
}

describe('meeting library search helpers', () => {
  it('tokenizes a lookup and drops stopwords', () => {
    expect(tokenizeMeetingQuery('Toast in grocery vs Clover')).toEqual(['toast', 'grocery', 'clover'])
  })

  it('scores a title hit higher than a body-only hit', () => {
    const title = scoreKeywordMatch(['toast'], 'Countering Toast In Grocery', 'other notes')
    const body = scoreKeywordMatch(['toast'], 'Staffing conflict', 'we should counter toast in aisle 4')
    expect(title.score).toBeGreaterThan(body.score)
    expect(body.score).toBeGreaterThan(0)
  })

  it('parses ops, standalone, and direct library paths', () => {
    expect(libraryRefFromPath('/Users/x/operations/quilt/meetings/2026-08/2026-08-12_Toast_(G2).md')).toEqual({
      domain: 'quilt', month: '2026-08', filename: '2026-08-12_Toast_(G2).md',
    })
    expect(libraryRefFromPath('/Users/x/.cos-glasses/data/recordings/2026-07/2026-07-15_Route.md')).toEqual({
      domain: 'personal', month: '2026-07', filename: '2026-07-15_Route.md',
    })
    expect(libraryRefFromPath('/meetings/2026-03/2026-03-10_Existing_Review.md')).toEqual({
      domain: 'library', month: '2026-03', filename: '2026-03-10_Existing_Review.md',
    })
  })

  it('merges keyword and semantic hits for the same record', () => {
    const merged = mergeMeetingSearchHits(
      [hit({ recordId: 'ops:quilt:2026-08:a.md', filename: 'a.md', keywordScore: 0.8, snippet: 'keyword snippet' })],
      [hit({ recordId: 'ops:quilt:2026-08:a.md', filename: 'a.md', semanticScore: 0.6, match: 'semantic', snippet: 'meaning snippet' })],
      10,
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].match).toBe('both')
    expect(merged[0].keywordScore).toBe(0.8)
    expect(merged[0].semanticScore).toBe(0.6)
    expect(merged[0].snippet).toBe('keyword snippet')
  })
})
