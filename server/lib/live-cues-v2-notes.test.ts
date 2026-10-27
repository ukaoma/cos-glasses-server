import { describe, expect, it } from 'vitest'
import { NOTES_BUDGET_MS, localDateOf, normalizeBridgeMemories, notesMemory, notesQueries, notesQueryTerms, rankBridgeMemories, type NotesSearchers } from './live-cues-v2-notes.js'
import type { ContextSearchHit } from './context-library-search.js'
import type { MeetingSearchHit } from './meeting-library-search.js'

const WINDOW = 'Okay so we talked about the weather for a bit. Then Delmar came by about the pool.\n'
  + 'Delmar quoted the resurfacing and he wants the deposit by Friday. Faith likes the pebble finish for the pool.'

const memHit = (id: string, title: string, created_at = '2026-10-01T10:00:00Z'): ContextSearchHit =>
  ({ id, title, snippet: `${title} snippet`, kind: 'memory', created_at, keywordScore: 0.8, semanticScore: 0, match: 'keyword' })
const mtgHit = (recordId: string, title: string, date: string, sessionId?: string): MeetingSearchHit =>
  ({ recordId, title, date, snippet: `${title} notes`, domain: 'personal', duration: '', month: date.slice(0, 7), filename: 'x.md', source: 'g2', keywordScore: 0.7, semanticScore: 0, match: 'keyword', ...(sessionId ? { sessionId } : {}) })

function searchers(over: Partial<NotesSearchers> = {}, log: string[] = []): NotesSearchers {
  return {
    memories: async q => { log.push(`memories:${q}`); return [memHit('mem_pool', 'Pool contractor'), memHit('mem_future', 'Tomorrow note', '2026-10-19T09:00:00Z')] },
    meetings: async q => { log.push(`meetings:${q}`); return [mtgHit('standalone:a', 'Backyard planning', '2026-09-30'), mtgHit('standalone:live', 'This meeting', '2026-10-17', 'meeting_live')] },
    bridge: async () => { log.push('bridge'); return [
      { id: 'jr_1', content: 'Delmar wants the deposit by Friday for the pool resurfacing.', created_at: '2026-10-10T12:00:00+00:00' },
      { id: 'jr_2', content: 'Talia has swim practice on Tuesdays.', created_at: '2026-10-11T12:00:00+00:00' },
    ] },
    ...over,
  }
}

describe('notes query terms', () => {
  it('takes the salient words (names and the current topic first), never stopwords or filler', () => {
    const terms = notesQueryTerms(WINDOW)
    expect(terms.slice(0, 2).sort()).toEqual(['delmar', 'pool'])
    for (const t of ['the', 'about', 'okay', 'and', 'wants']) expect(terms).not.toContain(t)
    expect(terms.length).toBeLessThanOrEqual(6)
    expect(notesQueryTerms('um yeah so like okay the and')).toEqual([])
  })
  it('builds two distinct queries: the top four terms and the top two', () => {
    expect(notesQueries(['a1', 'b2', 'c3', 'd4', 'e5'])).toEqual(['a1 b2 c3 d4', 'a1 b2'])
    expect(notesQueries(['a1', 'b2'])).toEqual(['a1 b2'])
    expect(notesQueries([])).toEqual([])
  })
})

describe('notesMemory', () => {
  const before = '2026-10-18'
  it('fuses memories, meetings and the memory bridge into at most four candidates, numbered M1..', async () => {
    const log: string[] = []
    const r = await notesMemory(WINDOW, before, new AbortController().signal, { sessionId: 'meeting_live', searchers: searchers({}, log) })
    expect(r.error).toBeUndefined()
    expect(r.notes.map(n => n.id)).toEqual(r.notes.map((_, i) => `M${i + 1}`))
    expect(r.notes.length).toBeLessThanOrEqual(4)
    const keys = r.notes.map(n => n.key)
    expect(keys).toEqual(expect.arrayContaining(['memory:mem_pool', 'meeting:standalone:a', 'memory:jr_1']))
    expect(keys).not.toContain('memory:jr_2')                       // the bridge note shares no salient word
    expect(keys).not.toContain('memory:mem_future')                 // dated on or after `before`
    expect(keys).not.toContain('meeting:standalone:live')           // the meeting being recorded
    const pool = r.notes.find(n => n.key === 'memory:jr_1')!
    expect(pool).toMatchObject({ date: '2026-10-10', notes: 'Delmar wants the deposit by Friday for the pool resurfacing.' })
    expect(log.filter(x => x === 'bridge')).toHaveLength(1)          // listed once, scored per query
    expect(log.some(x => x.startsWith('memories:') && x.includes('delmar'))).toBe(true)
    expect(log.every(x => x === 'bridge' || x.split(':')[1].split(' ').length <= 4)).toBe(true)   // the window itself is never a query
  })
  it('never more than four candidates, however many match', async () => {
    const r = await notesMemory(WINDOW, before, new AbortController().signal, { searchers: searchers({
      memories: async () => Array.from({ length: 6 }, (_, i) => memHit(`m${i}`, `Pool note ${i}`)), meetings: async () => [], bridge: async () => [] }) })
    expect(r.notes).toHaveLength(4)
    expect(r.notes.map(n => n.id)).toEqual(['M1', 'M2', 'M3', 'M4'])
  })
  it('a note found by more than one query or source ranks first', async () => {
    const r = await notesMemory(WINDOW, before, new AbortController().signal, { searchers: searchers({
      memories: async q => (q.split(' ').length > 2 ? [memHit('a', 'Only once')] : []),
      meetings: async () => [mtgHit('m:twice', 'Twice', '2026-10-01')],
      bridge: async () => [],
    }) })
    expect(r.notes[0].key).toBe('meeting:m:twice')
  })
  it('a failing source is skipped and named; the others still answer', async () => {
    const r = await notesMemory(WINDOW, before, new AbortController().signal, { searchers: searchers({ bridge: async () => { throw new Error('bridge down') } }) })
    expect(r.error).toBe('notes_bridge_failed')
    expect(r.notes.map(n => n.key)).toContain('memory:mem_pool')
  })
  it('never outlives its budget: a hung source returns what was found with notes_timeout', async () => {
    const t0 = Date.now()
    const r = await notesMemory(WINDOW, before, new AbortController().signal, { budgetMs: 150, searchers: searchers({ meetings: () => new Promise(() => {}) }) })
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(r.error).toBe('notes_timeout')
    expect(r.notes.map(n => n.key)).toContain('memory:mem_pool')
    expect(NOTES_BUDGET_MS).toBe(3_000)                              // cue_memory.py DENSE_BUDGET_S
  })
  it('the bridge call gets the budget as its own timeout and an abort signal that fires when the budget ends', async () => {
    let seen: { timeoutMs: number; signal: AbortSignal } | null = null
    await notesMemory(WINDOW, before, new AbortController().signal, { budgetMs: 120, searchers: searchers({ bridge: (signal, timeoutMs) => { seen = { signal, timeoutMs }; return new Promise(() => {}) } }) })
    expect(seen!.timeoutMs).toBe(120)
    expect(seen!.signal.aborted).toBe(true)
  })
  it('an evaluation aborted while the search runs gets nothing, and a window of filler searches nothing', async () => {
    const ac = new AbortController()
    expect(await notesMemory(WINDOW, before, ac.signal, { searchers: searchers({ memories: async () => { ac.abort(); return [memHit('mem_pool', 'Pool contractor')] } }) })).toEqual({ notes: [] })
    const log: string[] = []
    expect(await notesMemory('um yeah okay so', before, new AbortController().signal, { searchers: searchers({}, log) })).toEqual({ notes: [], error: 'notes_no_terms' })
    expect(log).toEqual([])
  })
  it('a note is dated by its LOCAL day: one written tonight (tomorrow in UTC) is not dropped by the local before bound', async () => {
    const lateTonight = new Date(2026, 9, 17, 22, 30).toISOString()     // 22:30 local on Oct 17
    expect(localDateOf(lateTonight)).toBe('2026-10-17')
    expect(localDateOf('2026-10-03')).toBe('2026-10-03')
    expect(localDateOf('soon')).toBe('')
    const r = await notesMemory(WINDOW, '2026-10-18', new AbortController().signal, { searchers: searchers({
      memories: async () => [memHit('mem_tonight', 'Pool tonight', lateTonight)], meetings: async () => [], bridge: async () => [] }) })
    expect(r.notes.map(n => [n.key, n.date])).toEqual([['memory:mem_tonight', '2026-10-17']])
  })
  it('bridge rows: only well-formed rows with content are kept, and they are scored with the library keyword scorer', () => {
    const rows = normalizeBridgeMemories([{ id: 'a', content: 'pool deposit' }, { id: '', content: 'x' }, { id: 'b', content: '  ' }, 'junk', { id: 'c', content: 'swim' }])
    expect(rows.map(r => r.id)).toEqual(['a', 'c'])
    expect(normalizeBridgeMemories({ error: 'capability_not_available_in_public_file_runtime' })).toEqual([])
    expect(rankBridgeMemories(rows, 'pool deposit').map(r => r.id)).toEqual(['a'])
  })
})
