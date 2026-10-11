import { describe, it, expect, vi } from 'vitest'
import { createLiveAsk, normalizeAsk, normalizeSections, sectionsFromAnswer, OFF_FORMAT_NOTICE, type AskInput } from './live-cos-ask.js'
import { MEETING_ASK_LABELS } from '../../shared/meeting-ask.js'
// 6.71.0: the model returns labeled sections; the server validates them and composes `answer`.
const turns = [
  { id: 1, speaker: 'Person A', elapsedMs: 10_000, text: 'We picked the annual plan.' },
  { id: 2, speaker: 'You', elapsedMs: 20_000, text: 'I will send the pricing sheet by Friday.' },
  { id: 3, speaker: 'Person B', elapsedMs: 30_000, text: 'Who owns the rollout is still open.' },
]
const input = (action: AskInput['action'], question = ''): AskInput => normalizeAsk({ sessionId: 'meeting_sections_test', action, question: action === 'ask' ? question || 'What was decided?' : question, elapsedMs: 60_000, turns })
const ids = new Set(['T1', 'T2', 'T3', 'H1'])
const row = (label: string, text: string) => ({ label, text })
const ask = (sections: unknown, extra: Record<string, unknown> = {}) => {
  const run = vi.fn(async (_prompt: string) => ({ text: JSON.stringify({ sections, searchQuery: null, ...extra }), model: 'claude-haiku' }))
  return { run, ask: createLiveAsk({ run, search: vi.fn(), now: () => 5000 }) }
}

describe('Meeting Ask sections: labels per action', () => {
  const sample: Record<string, string> = { 'So what': 'Annual plan chosen [T1].', Decided: 'Annual plan [T1].', Open: 'Rollout owner [T3].', 'You owe': 'Pricing sheet by Friday [T2].', Next: 'Confirm the owner [T3].', Covered: 'Plans and rollout [T1].', 'Others owe': 'None named by others [T3].', Unowned: 'Rollout [T3].', Proposed: 'Pick an owner [T3].', Ask: 'Who owns rollout? It is unassigned [T3].', Details: 'The annual plan won [T1].' }
  for (const action of Object.keys(MEETING_ASK_LABELS) as AskInput['action'][]) {
    it(`${action} accepts exactly its own labels, in its order`, () => {
      const labels = MEETING_ASK_LABELS[action]
      const out = normalizeSections(action, labels.map(l => row(l, sample[l])), ids)
      expect(out.map(s => s.label)).toEqual(labels)
    })
    it(`${action} rejects a label it does not allow`, () => {
      const foreign = Object.keys(sample).filter(l => !MEETING_ASK_LABELS[action].includes(l))
      expect(foreign.length).toBeGreaterThan(0)
      for (const label of [...foreign, 'Notes', 'You asked', 'From']) {
        expect(() => normalizeSections(action, [row('So what', 'x [T1]'), row(label, 'y [T1]')], ids)).toThrow('invalid_answer')
      }
    })
  }
  it('requires a non-empty So what', () => {
    for (const bad of [[row('Decided', 'Annual [T1]')], [row('So what', '   ')], [row('So what', 'None.'), row('Decided', 'Annual [T1]')], []]) {
      expect(() => normalizeSections('catch_up', bad, ids)).toThrow('invalid_answer')
    }
  })
  it('rejects malformed rows and a non-array', () => {
    for (const bad of [null, 'So what: x', { label: 'So what', text: 'x' }, [{ label: 'So what' }], [{ label: 'So what', text: 3 }], [null], Array.from({ length: 13 }, () => row('So what', 'x'))]) {
      expect(() => normalizeSections('summary', bad, ids)).toThrow('invalid_answer')
    }
  })
  it('normalizes label case and a trailing colon, and puts rows in the action order', () => {
    const out = normalizeSections('catch_up', [row('next', 'Confirm [T3].'), row('DECIDED:', 'Annual [T1].'), row(' so  what ', 'Annual plan [T1].')], ids)
    expect(out.map(s => s.label)).toEqual(['So what', 'Decided', 'Next'])
  })
  it('drops empty and padding rows instead of padding', () => {
    const out = normalizeSections('summary', [row('So what', 'Annual plan [T1].'), row('Covered', ''), row('Decided', 'None'), row('Open', 'n/a'), row('Next', 'Nothing yet.')], ids)
    expect(out.map(s => s.label)).toEqual(['So what'])
  })
  it('keeps up to three Ask rows in order and joins a repeated single label', () => {
    const q = normalizeSections('questions', [row('So what', 'Ownership is the gap [T3].'), ...[1, 2, 3, 4].map(i => row('Ask', `Question ${i}? Reason [T3].`))], ids)
    expect(q.map(s => s.text)).toEqual(['Ownership is the gap [T3].', 'Question 1? Reason [T3].', 'Question 2? Reason [T3].', 'Question 3? Reason [T3].'])
    const d = normalizeSections('summary', [row('So what', 'x [T1]'), row('Decided', 'Annual [T1].'), row('Decided', 'Rollout later [T3].')], ids)
    expect(d[1]).toEqual({ label: 'Decided', text: 'Annual [T1]. Rollout later [T3].', sources: ['T1', 'T3'] })
  })
  it('keeps You owe only when it cites the transcript', () => {
    expect(normalizeSections('actions', [row('So what', 'x [T1]'), row('You owe', 'Pricing sheet by Friday [T2].')], ids).map(s => s.label)).toEqual(['So what', 'You owe'])
    expect(normalizeSections('actions', [row('So what', 'x [T1]'), row('You owe', 'Probably the pricing sheet.')], ids).map(s => s.label)).toEqual(['So what'])
    expect(normalizeSections('catch_up', [row('So what', 'x [T1]'), row('You owe', 'From memory [H1].')], ids).map(s => s.label)).toEqual(['So what'])
  })
  it('maps each section to its own citations and removes invented ones', () => {
    const out = normalizeSections('catch_up', [row('So what', 'Annual [T1], again [T1], rollout open [T3].'), row('Open', 'Owner [T99] and history [H1].')], ids)
    expect(out[0].sources).toEqual(['T1', 'T3'])
    expect(out[1]).toEqual({ label: 'Open', text: 'Owner [source unavailable] and history [H1].', sources: ['H1'] })
  })
  it('flattens line breaks and redacts secrets inside a section', () => {
    const out = normalizeSections('ask', [row('So what', 'Line one [T1].\n\n- line two sk-abcdefghijklmnopqrstuvwx')], ids)
    expect(out[0].text).not.toContain('\n'); expect(out[0].text).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  })
})

describe('Meeting Ask sections: end to end through createLiveAsk', () => {
  it('composes answer as one **Label:** line per section and returns sections with sources', async () => {
    const { ask: run } = ask([row('Next', 'Confirm the owner [T3].'), row('So what', 'Annual plan chosen [T1].'), row('Decided', 'Annual plan [T1].'), row('Open', ''), row('You owe', 'Pricing sheet by Friday [T2].')])
    const result = await run(input('catch_up'))
    expect(result.answer.split('\n\n**Confidence:**')[0]).toBe('**So what:** Annual plan chosen [T1].\n\n**Decided:** Annual plan [T1].\n\n**You owe:** Pricing sheet by Friday [T2].\n\n**Next:** Confirm the owner [T3].')
    expect(result.sections.slice(0, -1)).toEqual([
      { label: 'So what', text: 'Annual plan chosen [T1].', sources: ['T1'] },
      { label: 'Decided', text: 'Annual plan [T1].', sources: ['T1'] },
      { label: 'You owe', text: 'Pricing sheet by Friday [T2].', sources: ['T2'] },
      { label: 'Next', text: 'Confirm the owner [T3].', sources: ['T3'] },
    ])
    expect(result.sections.at(-1)?.label).toBe('Confidence')
    expect(result.sources.map(s => s.id)).toEqual(['T1', 'T2', 'T3'])
  })
  it('an unknown label, a foreign label or a missing So what fails as invalid_answer with no retry', async () => {
    for (const sections of [[row('So what', 'x [T1]'), row('Covered', 'y [T1]')], [row('Decided', 'y [T1]')], 'plain text']) {
      const { ask: run, run: model } = ask(sections)
      await expect(run(input('catch_up'))).rejects.toMatchObject({ reason: 'invalid_answer', status: 502 })
      expect(model).toHaveBeenCalledTimes(1)
    }
  })
  it('tells the model the labels, the task and the wearer', async () => {
    const run = vi.fn(async (_prompt: string) => ({ text: JSON.stringify({ sections: [row('So what', 'x [T1]')] }), model: 'claude-haiku' }))
    await createLiveAsk({ run, search: vi.fn(), now: () => 5000, wearer: () => 'Sam Rivera' })(input('actions'))
    const prompt = JSON.parse(run.mock.calls[0][0])
    expect(prompt.labels).toEqual(['So what', 'You owe', 'Others owe', 'Unowned', 'Proposed']); expect(prompt.wearer).toBe('Sam Rivera')
    const bare = vi.fn(async (_prompt: string) => ({ text: JSON.stringify({ sections: [row('So what', 'x [T1]')] }), model: 'claude-haiku' }))
    await createLiveAsk({ run: bare, search: vi.fn(), now: () => 5000 })(input('summary'))
    expect(JSON.parse(bare.mock.calls[0][0]).wearer).toBeNull()
  })
  it('a search hop with empty sections still searches, and the final answer is sectioned', async () => {
    const run = vi.fn().mockResolvedValueOnce({ text: '{"sections":[],"searchQuery":"annual plan history"}' }).mockResolvedValueOnce({ text: JSON.stringify({ sections: [row('So what', 'Chosen before too [H1].'), row('Details', 'Earlier review [H1], today [T1].')] }) })
    const search = vi.fn(async () => ({ sources: [{ id: 'H1', kind: 'meeting' as const, title: 'Plan review · 2026-09-30', text: 'Annual plan agreed.' }], notices: [] }))
    const result = await createLiveAsk({ run, search, now: () => 5000 })(input('ask', 'Did we pick this before?'))
    expect(search).toHaveBeenCalledTimes(1)
    expect(result.sections.slice(0, -1).map(s => [s.label, s.sources])).toEqual([['So what', ['H1']], ['Details', ['H1', 'T1']]])
  })
})

describe('Meeting Ask sections: a provider that still answers {"answer":"..."}', () => {
  const old = (answer: unknown, extra: Record<string, unknown> = {}) => createLiveAsk({ run: async () => ({ text: JSON.stringify({ answer, searchQuery: null, ...extra }), model: 'claude-haiku' }), search: vi.fn(), now: () => 5000 })
  it('reads **Label:** lines through the same rules, with no notice', async () => {
    const result = await old('**Decided:** Annual plan [T1].\n\n**So what:** Annual plan chosen\nfor next year [T1].\n- **Open:** None\n**Next**: Confirm the owner [T3].')(input('catch_up'))
    expect(result.sections.slice(0, -1)).toEqual([
      { label: 'So what', text: 'Annual plan chosen for next year [T1].', sources: ['T1'] },
      { label: 'Decided', text: 'Annual plan [T1].', sources: ['T1'] },
      { label: 'Next', text: 'Confirm the owner [T3].', sources: ['T3'] },
    ])
    expect(result.notices).not.toContain(OFF_FORMAT_NOTICE)
  })
  it('falls back to one So what row with a notice when the lines give no valid So what', async () => {
    const cases: [string, AskInput['action']][] = [
      ['Annual plan chosen [T1].\n\n- Rollout owner open [T3]\n- Invented [T9]', 'summary'], // plain markdown
      ['Quick note first.\n**So what:** Annual plan [T1].', 'summary'], // prose above the first label
      ['**So what:** Annual plan [T1].\n**Covered:** Plans [T1].', 'catch_up'], // a label this action does not allow
      ['**Decided:** Annual plan [T1].', 'catch_up'], // labels but no So what
    ]
    for (const [answer, action] of cases) {
      const result = await old(answer)(input(action))
      const text = answer.replace('[T9]', '[source unavailable]')
      expect(result.sections.slice(0, -1), answer).toEqual([{ label: 'So what', text, sources: [...new Set(text.match(/T\d+/g))] }])
      expect(result.answer.split('\n\n**Confidence:**')[0]).toBe('**So what:** ' + text)
      expect(result.notices).toContain(OFF_FORMAT_NOTICE)
    }
  })
  it('still fails on empty or non-JSON output, and on an unknown label inside a real sections array', async () => {
    for (const ask of [old(''), old('   '), old(null), createLiveAsk({ run: async () => ({ text: 'Annual plan [T1]', model: 'claude-haiku' }), search: vi.fn(), now: () => 5000 }), old('Annual plan [T1]', { sections: [row('So what', 'x [T1]'), row('Notes', 'y')] })]) {
      await expect(ask(input('summary'))).rejects.toMatchObject({ reason: 'invalid_answer', status: 502 })
    }
  })
  it('the parser refuses a blank answer itself', () => {
    expect(() => sectionsFromAnswer('summary', ' \n ', ids)).toThrow('invalid_answer')
  })
  it('the parser redacts secrets in the fallback row', () => {
    const out = sectionsFromAnswer('ask', 'Key is sk-abcdefghijklmnopqrstuvwx [T1]', ids)
    expect(out.offFormat).toBe(true); expect(out.sections[0].text).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  })
})
