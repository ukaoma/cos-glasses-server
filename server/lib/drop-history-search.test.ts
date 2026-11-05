import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DropHistorySearcher, dropOptionText, searchableDrops, DROP_SEARCH_INSTRUCTIONS } from './drop-history-search.js'
import { JevError, type JevAnswers } from './jev.js'
import type { DecisionClient } from './decision-provider.js'
import type { DropRecord } from './drop-store.js'

function drop(text: string, minutesAgo: number, extra: Partial<DropRecord> = {}): DropRecord {
  const at = new Date(Date.UTC(2026, 10, 4, 16) - minutesAgo * 60_000).toISOString()
  return { id: randomUUID(), text, source: 'mac', createdAt: at, updatedAt: at, state: 'filed', dest: 'note', kind: 'note', links: [], route: { by: 'jev' }, undoUntil: null, timeline: [], ...extra }
}
function fakeClient(answer: (criteria: Record<string, string>) => Record<string, number>, calls: Array<Record<string, unknown>> = []): DecisionClient {
  return {
    async ask(state, questions) {
      calls.push({ state, questions })
      const c = (questions as { c: { criteria: Record<string, string> } }).c
      return { answers: { c: { probabilities: answer(c.criteria) } }, inputTokens: 900 } satisfies JevAnswers
    },
  }
}

describe('History search by meaning', () => {
  const drops = [
    drop('send Gina the JCK numbers', 10, { links: [{ kind: 'card', id: 'w1', label: 'JCK numbers', domain: 'quilt' }] }),
    drop('idea: a pet industry webinar with Rover', 20),
    drop('use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH for the test', 30),
  ]

  it('offers cleaned words and link labels, newest first, and never a drop that trips the secret check', () => {
    const { rows, total } = searchableDrops(drops)
    expect(total).toBe(2)
    expect(rows.map(r => r.text)).toEqual(['send Gina the JCK numbers (JCK numbers)', 'idea: a pet industry webinar with Rover'])
    expect(searchableDrops([drop('kept as a note', 1, { route: { by: 'fallback', reason: 'redacted' } })]).rows).toEqual([])
    expect(dropOptionText({ text: 'see https://example.com/x for it', links: [] })).toBe('see for it')
  })

  it('asks one Choice with none, ranks the answer, and caches it', async () => {
    const calls: Array<Record<string, unknown>> = []
    const s = new DropHistorySearcher(fakeClient(() => ({ t0: 0.05, t1: 0.9, none: 0.05 }), calls), () => 0, {})
    const r = await s.search('that dog thing', drops)
    expect(r).toMatchObject({ available: true, results: [{ p: 0.9 }, { p: 0.05 }], none: 0.05, cached: false, tokens: 900, searched: 2, partial: false })
    expect((r as { results: Array<{ id: string }> }).results[0].id).toBe(drops[1].id)
    const q = (calls[0].questions as { c: { instructions: string; criteria: Record<string, string> } }).c
    expect(q.instructions).toBe(DROP_SEARCH_INSTRUCTIONS)
    expect(Object.keys(q.criteria)).toEqual(['t0', 't1', 'none'])
    expect(JSON.stringify(calls)).not.toContain('sk-ant-api03')
    expect(await s.search('That  dog thing', drops)).toMatchObject({ cached: true, tokens: 0 })
    expect(calls).toHaveLength(1)
  })

  it('searches the newest 254 of a longer history and says partial', async () => {
    const many = Array.from({ length: 300 }, (_, i) => drop(`entry number ${i}`, i))
    const calls: Array<Record<string, unknown>> = []
    const r = await new DropHistorySearcher(fakeClient(() => ({ none: 1 }), calls), () => 0, {}).search('entry', many)
    expect(r).toMatchObject({ available: true, searched: 254, partial: true })
    const criteria = (calls[0].questions as { c: { criteria: Record<string, string> } }).c.criteria
    expect(criteria.t0).toBe('entry number 0')
  })

  it('answers available false with one line, never throws, for a Jev failure, the switch, or a bad query', async () => {
    const failing = (code: ConstructorParameters<typeof JevError>[0]): DecisionClient => ({ async ask() { throw new JevError(code) } })
    expect(await new DropHistorySearcher(failing('jev_cap_reached'), () => 0, {}).search('gina', drops)).toMatchObject({ available: false, reason: 'jev_cap_reached' })
    expect(await new DropHistorySearcher(failing('jev_bad_answer'), () => 0, {}).search('gina', drops)).toMatchObject({ available: false, reason: 'jev_unavailable' })
    expect(await new DropHistorySearcher(fakeClient(() => ({ t9: 1 })), () => 0, {}).search('gina', drops)).toMatchObject({ available: false, reason: 'jev_unavailable' })
    const calls: Array<Record<string, unknown>> = []
    expect(await new DropHistorySearcher(fakeClient(() => ({ none: 1 }), calls), () => 0, { COS_DROP_ROUTER: '0' }).search('gina', drops)).toMatchObject({ available: false, reason: 'search_off' })
    expect(await new DropHistorySearcher(fakeClient(() => ({ none: 1 }), calls), () => 0, {}).search('g', drops)).toMatchObject({ available: false, reason: 'query_invalid' })
    expect(calls).toHaveLength(0)
  })

  it('an empty history makes no call', async () => {
    const calls: Array<Record<string, unknown>> = []
    expect(await new DropHistorySearcher(fakeClient(() => ({ none: 1 }), calls), () => 0, {}).search('gina', [])).toMatchObject({ available: true, searched: 0 })
    expect(calls).toHaveLength(0)
  })
})
