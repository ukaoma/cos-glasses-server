import { describe, it, expect, vi } from 'vitest'
import { createLiveAsk, meetingEvidence, normalizeAsk, orderAsksByRecency, recentSinceMs, QUESTIONS_RECENT_MS, type AskInput, type AskSource } from './live-cos-ask.js'
// 6.71.1: What to ask leads with the recent discussion and may look in COS once, never the web.
const MIN = 60_000
const meeting = (minutes: number, perMinute: number, chars: number, extra: Record<string, unknown> = {}): AskInput => {
  const turns = Array.from({ length: minutes * perMinute }, (_, i) => ({ id: i, speaker: i % 2 ? 'Person B' : 'Person A', elapsedMs: Math.floor(i * MIN / perMinute), text: `t${i} `.padEnd(chars, 'x') }))
  return normalizeAsk({ sessionId: 'meeting_questions_test', action: 'questions', question: '', elapsedMs: minutes * MIN, turns, ...extra })
}
const json = (v: unknown) => ({ text: JSON.stringify(v), model: 'claude-haiku' })
const ask = (label: string, text: string) => ({ label, text })

describe('What to ask: recent discussion first', () => {
  it('a long meeting keeps every turn of the last ten minutes in full, then samples earlier context', () => {
    // 360 turns, about 110K characters; the last ten minutes fit in 32K. Recording time is 60:03, so the
    // window opens at 50:03 and the turn spoken at 50:00 straddles it.
    const input = meeting(60, 6, 300, { elapsedMs: 60 * MIN + 3000 })
    const since = recentSinceMs(input)
    expect(QUESTIONS_RECENT_MS).toBe(10 * MIN); expect(since).toBe(50 * MIN)
    const recent = input.turns.filter(t => t.elapsedMs >= since)
    const { sources, notices } = meetingEvidence(input)
    for (const t of recent) expect(sources.find(s => s.turnId === t.id)?.text).toBe(t.text)
    const earlier = sources.filter(s => (s.elapsedMs ?? 0) < since)
    expect(earlier.length).toBeGreaterThan(0)
    expect(Math.min(...earlier.map(s => s.elapsedMs ?? 0))).toBeLessThan(10 * MIN)
    expect(sources.reduce((n, s) => n + s.text.length + s.title.length + 160, 0)).toBeLessThanOrEqual(34_000)
    expect(sources.map(s => s.elapsedMs)).toEqual([...sources.map(s => s.elapsedMs)].sort((a, b) => a! - b!))
    expect(notices).toEqual(['This answer reads the last ten minutes in full and earlier passages in part because the meeting exceeds the context limit.'])
  })
  it('when the last ten minutes alone overflow, the newest turns win', () => {
    const input = meeting(12, 20, 1500)
    const { sources, notices } = meetingEvidence(input)
    expect(sources.at(-1)?.turnId).toBe(input.turns.at(-1)!.id)
    expect(sources.every(s => (s.elapsedMs ?? 0) >= recentSinceMs(input))).toBe(true)
    expect(notices.join()).toContain('selected passages')
  })
  it('the same long meeting gives Summarize the old whole-recording sample, not the recent window', () => {
    const input = { ...meeting(60, 6, 300), action: 'summary' as const }
    const recent = input.turns.filter(t => t.elapsedMs >= recentSinceMs(input))
    const { sources } = meetingEvidence(input)
    expect(recent.filter(t => sources.some(s => s.turnId === t.id)).length).toBeLessThan(recent.length)
  })
  it('a short meeting is read whole, and the prompt names the recent window and the recency rule', async () => {
    const input = meeting(20, 1, 50)
    expect(meetingEvidence(input).sources).toHaveLength(20)
    const run = vi.fn(async (_p: string) => json({ sections: [ask('So what', 'Pricing moved [T20].'), ask('Ask', 'Q? R [T20].')] }))
    await createLiveAsk({ run, search: vi.fn(), now: () => 5000 })(input)
    const prompt = JSON.parse(run.mock.calls[0][0])
    expect(prompt.recentSinceMs).toBe(recentSinceMs(input))
    expect(prompt.question).toContain('start with the most recent topic')
  })
})

describe('What to ask: Ask rows newest first', () => {
  const src = (id: string, elapsedMs: number): AskSource => ({ id, kind: 'transcript', title: id, text: id, elapsedMs })
  // H1 carries a time only to prove that a non-transcript source never decides the order.
  const sources = [src('T1', 1000), src('T2', 2000), src('T3', 3000), src('T4', 4000), { id: 'H1', kind: 'memory' as const, title: 'h', text: 'h', elapsedMs: 9999 }]
  const row = (label: string, ids: string[]) => ({ label, text: ids.map(i => `[${i}]`).join(' ') || 'x', sources: ids })
  it('orders by the newest transcript turn each row cites, So what first, uncited rows last, ties in model order', () => {
    const out = orderAsksByRecency([row('So what', ['T1']), row('Ask', ['T1']), row('Ask', ['H1']), row('Ask', ['T2', 'T4']), row('Ask', ['T3']), row('Ask', ['T3', 'H1'])], sources)
    expect(out.map(r => `${r.label}:${r.sources.join('+')}`)).toEqual(['So what:T1', 'Ask:T2+T4', 'Ask:T3', 'Ask:T3+H1', 'Ask:T1', 'Ask:H1'])
  })
  it('is applied to the answer: the model\'s oldest-first Asks come back newest first', async () => {
    const input = meeting(30, 1, 50)
    const run = vi.fn(async (_p: string) => json({ sections: [ask('So what', 'Topic changed [T30].'), ask('Ask', 'About the start? [T1]'), ask('Ask', 'About the middle? [T15]'), ask('Ask', 'About now? [T30]')] }))
    const result = await createLiveAsk({ run, search: vi.fn(), now: () => 5000 })(input)
    expect(result.sections.slice(0,-1).map(s => s.text)).toEqual(['Topic changed [T30].', 'About now? [T30]', 'About the middle? [T15]', 'About the start? [T1]'])
    expect(result.answer.split('\n\n')[1]).toBe('**Ask:** About now? [T30]')
  })
  it('leaves other actions in label order', async () => {
    const input = { ...meeting(30, 1, 50), action: 'summary' as const }
    const run = vi.fn(async (_p: string) => json({ sections: [ask('So what', 'x [T1]'), ask('Covered', 'old [T1]'), ask('Next', 'new [T30]')] }))
    expect((await createLiveAsk({ run, search: vi.fn(), now: () => 5000 })(input)).sections.slice(0,-1).map(s => s.label)).toEqual(['So what', 'Covered', 'Next'])
  })
})

describe('What to ask: one COS lookup, never the web', () => {
  const found = { sources: [{ id: 'H0', kind: 'memory' as const, title: 'Prior case note', text: 'Similar case: imaging did not match symptoms.' }], notices: [] }
  it('one COS search from the recent discussion, cited in an Ask row; a second request is not searched', async () => {
    const input = meeting(30, 1, 50)
    const run = vi.fn()
      .mockResolvedValueOnce(json({ sections: [], searchQuery: 'imaging symptoms mismatch injection', searchScope: 'web' }))
      .mockResolvedValueOnce(json({ sections: [ask('So what', 'Imaging fit is open [T30].'), ask('Ask', 'Do imaging and symptoms match? A prior case says check [H1] [T30].')] }))
    const search = vi.fn(async (_q: string, _s?: string, _scope?: string) => found)
    const result = await createLiveAsk({ run, search, now: () => 5000, webAvailable: true, explicitWebQuery: 'imaging' })(input)
    expect(search).toHaveBeenCalledTimes(1); expect(search.mock.calls[0][2]).toBe('cos')
    expect(run).toHaveBeenCalledTimes(2)
    expect(JSON.parse(run.mock.calls[0][0]).searchAllowed).toBe(true); expect(JSON.parse(run.mock.calls[1][0]).searchAllowed).toBe(false)
    expect(result.sections[1].sources).toEqual(['H1', 'T30'])
    expect(result.sources.map(s => s.id)).toContain('H1')
  })
  it('the hop cap holds: a model that asks to search again gets no second lookup', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(json({ sections: [], searchQuery: 'a', searchScope: 'cos' }))
      .mockResolvedValueOnce(json({ sections: [], searchQuery: 'b', searchScope: 'cos' }))
    const search = vi.fn(async () => found)
    await expect(createLiveAsk({ run, search, now: () => 5000 })(meeting(30, 1, 50))).rejects.toMatchObject({ reason: 'invalid_answer' })
    expect(search).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(2)
  })
  it('no preset ever sends a web search, even with the web available and an explicit web query set', async () => {
    for (const action of ['questions', 'catch_up', 'summary', 'actions'] as const) {
      const run = vi.fn(async (_p: string) => json({ sections: [ask('So what', 'x [T1]')] }))
      const search = vi.fn(async () => found)
      await createLiveAsk({ run, search, now: () => 5000, webAvailable: true, explicitWebQuery: 'search the web' })({ ...meeting(30, 1, 50), action })
      expect(search).not.toHaveBeenCalled(); expect(run).toHaveBeenCalledTimes(1)
    }
  })
})
