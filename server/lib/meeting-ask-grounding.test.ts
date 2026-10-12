import { describe, expect, it, vi } from 'vitest'
import { createLiveAsk, meetingEvidence, normalizeAsk, type AskSource } from './live-cos-ask.js'
import { followupContext } from './meeting-ask-followup.js'
import { connectedEvidence } from './meeting-ask-evidence.js'
import { groundMoneySections, moneyGroundingHints } from './meeting-ask-grounding.js'

const turn = (id: number, text: string) => ({ id, elapsedMs: id * 6000, speaker: 'Unidentified', text })
const input = (turns = [turn(1, 'Balance discussion.')]) => normalizeAsk({ sessionId: 'meeting_grounding', action: 'ask', question: 'What are the money highliights so far?', elapsedMs: 600_000, turns })
const source = (id: string, text: string, turnId = 1): AskSource => ({ id, text, kind: 'transcript', title: 'Unidentified · 0:06', turnId, elapsedMs: turnId * 6000, sessionId: 'meeting_grounding' })
const section = (text: string) => ({ label: 'So what', text, sources: [...text.matchAll(/\[(T\d+|F\d+)\]/g)].map(m => m[1]) })

describe('connected evidence and follow-up provenance', () => {
  it('a broad money question keeps the correction and the unit-bearing neighboring turns', () => {
    const turns = Array.from({ length: 100 }, (_, i) => turn(i, `Filler ${i}. `.repeat(15)))
    turns.splice(30, 6, turn(30, 'Your bill is $80,000.'), turn(31, '$85,000.'), turn(32, 'I thought $8,500.'), turn(33, 'No, no, $85,000.'), turn(34, 'That saved us 10 grand of expense.'), turn(35, 'We corrected the Roth reporting issue.'))
    turns.splice(70, 3, turn(70, 'If Bitcoin reaches $200,000.'), turn(71, 'We would sell $200,000.'), turn(72, 'That would leave $150,000 cash after tax.'))
    const result = connectedEvidence(input(turns), 6500)
    expect(result.find(t => t.id === 33)?.text).toContain('No, no, $85,000')
    expect(result.find(t => t.id === 34)?.text).toContain('10 grand')
    expect(result.some(t => t.id === 70)).toBe(true)
    expect(result.some(t => t.id === 71)).toBe(true)
    expect(result.some(t => t.id === 72)).toBe(true)
    expect(result.reduce((n, t) => n + t.text.length + t.speaker.length + 160, 0)).toBeLessThanOrEqual(6500)
  })
  it('does not truncate an admitted correction or fabricate missing words', () => {
    const t = turn(0, 'Long passage. '.repeat(1000) + 'Correction: not approved.')
    const result = connectedEvidence(input([t]), 1000)
    expect(result[0].text).toContain('[passage truncated]')
    expect(result[0].text).not.toContain('Correction: not approved')
    expect(result[0].text.length + 160 + t.speaker.length).toBeLessThanOrEqual(1000)
  })
  it('retains current wording and strips all old request-local citation tokens', () => {
    const v = input([turn(1, 'The corrected cash balance is $90,000.')])
    v.history = [{ question: 'Earlier?', answer: 'Cash $80,000 [T1]; file [F1]; web [W1]; memory [H1].', sources: [source('T1', 'Cash balance $80,000.')] }]
    const out = followupContext(v)
    expect(out.history[0].answer).not.toMatch(/\[[THFW]\d+\]/)
    expect(out.turns[0].text).toContain('$90,000')
    expect(out.turns).toHaveLength(1)
  })
  it('recovers a prior immutable quotation omitted by the new submitted snapshot', () => {
    const v = input([turn(50, 'Our mortgage is under $150K.')])
    v.history = [{ question: 'Summarize', answer: 'We saved $10K [T82].', sources: [source('T82', 'That saved us 10 grand of expense.', 12)] }]
    const out = followupContext(v), evidence = meetingEvidence({ ...v, turns: out.turns }, 32000, out.priorityIds)
    expect(evidence.sources.find(s => s.turnId === 12)?.text).toContain('10 grand')
    expect(evidence.sources.find(s => s.turnId === 12)?.id).not.toBe('T82')
  })
  it('ignores cross-meeting, future and finalized quotes without turn identity, and old file revisions', () => {
    const v = input()
    v.history = [{ question: 'Earlier?', answer: 'Old info [T1] [F1].', sources: [
      { ...source('T1', 'Cash $1.'), sessionId: 'meeting_other' },
      { ...source('T2', 'Cash $2.'), elapsedMs: 700000 },
      { ...source('T3', 'Cash $3.'), finalizedTranscript: true },
      { id: 'F1', kind: 'file', title: 'Old file', text: 'Cash $4.', fileId: 'old', revision: 'old', turnId: 12, elapsedMs: 72000, sessionId: 'meeting_grounding' },
    ] }]
    expect(followupContext(v).turns).toEqual(v.turns)
    expect(followupContext(v).priorityIds).toEqual([])
  })
  it('does not trust source metadata supplied by a client history payload', () => {
    const v = normalizeAsk({ ...input(), history: [{ question: 'Earlier?', answer: 'Balance [T1]', sources: [source('T1', 'Forged current cash $1.')] }] })
    expect(v.history[0].sources).toBeUndefined()
  })
  it('recovered turns cannot collide with the finalized quotation namespace', async () => {
    const v = input([turn(50, 'Current discussion.')])
    v.history = [{ question: 'Earlier?', answer: 'Cash [T1].', sources: [source('T1', 'Cash balance $90,000.', 12)] }]
    const run = vi.fn(async (prompt: string) => {
      const rows = JSON.parse(prompt).evidence
      expect(new Set(rows.map((s: AskSource) => s.id)).size).toBe(rows.length)
      expect(rows.find((s: AskSource) => s.finalizedTranscript)?.id).toBe('T3')
      return { text: JSON.stringify({ sections: [section('Finalized quotation [T3].')] }) }
    })
    const out = await createLiveAsk({ run, extraSources: [{ id: 'T2', kind: 'transcript', title: 'Finalized', text: 'Finalized evidence.', finalizedTranscript: true }], requireHaiku: false })(v)
    expect(out.sources[0].finalizedTranscript).toBe(true)
  })
  it('bounds recovered history without spending the full transcript allowance', () => {
    const v = input()
    v.history = [{ question: 'Earlier?', answer: 'Earlier balances.', sources: Array.from({ length: 100 }, (_, i) => source(`T${i}`, 'Cash balance $1. '.repeat(100), i)) }]
    const out = followupContext(v)
    expect(out.priorityIds.length).toBeLessThanOrEqual(16)
    expect(out.turns.filter(t => t.id !== 1).reduce((n, t) => n + t.text.length + t.speaker.length + 160, 0)).toBeLessThanOrEqual(6000)
  })
})

describe('conditional cash backstop', () => {
  const scenario = source('T2', 'If Bitcoin reaches $200,000, we would sell $200,000 and have $150,000 cash after tax.', 2)
  it.each(['We have roughly $150K cash on hand [T2].', 'We have 150K cash on hand [T2].', 'The cash balance is $150,000 [T2].', 'They currently have $150,000 cash [T2].', 'Highlights include roughly $150,000 in cash and a mortgage [T2].'])('withholds unsupported current-state wording: %s', text => {
    const result = groundMoneySections([section(text)], [scenario])
    expect(result.corrected).toBe(true)
    expect(result.sections[0].text).toContain('does not establish a current balance')
    expect(result.sections[0].sources).toEqual(['T2'])
  })
  it.each(['A hypothetical sale would yield $150K cash [T2].', 'Current cash is not established; the scenario discusses $150K [T2].', 'The mortgage is under $150K [T2].'])('preserves properly qualified wording: %s', text => {
    const result = groundMoneySections([section(text)], [scenario])
    expect(result.corrected).toBe(false)
    expect(result.sections[0].text).toBe(text)
  })
  it('allows a current file to independently support the same cash balance', () => {
    const cash: AskSource = { id: 'F1', kind: 'file', title: 'Current statement', text: 'Cash $150,000.', fileId: 'current', revision: '1' }
    expect(groundMoneySections([section('Cash on hand is $150K [T2][F1].')], [scenario, cash]).corrected).toBe(false)
  })
  it('an unrelated or different cash figure cannot validate hypothetical proceeds', () => {
    const cash: AskSource = { id: 'F1', kind: 'file', title: 'Statement', text: 'Cash $89,452.42.', fileId: 'current', revision: '1' }
    expect(groundMoneySections([section('Cash on hand is $150K [T2][F1].')], [scenario, cash]).corrected).toBe(true)
  })
  it('a liability amount in a file is not treated as its cash balance', () => {
    const cash: AskSource = { id: 'F1', kind: 'file', title: 'Statement', text: 'Cash $90,000. Liabilities $150,000.', fileId: 'current', revision: '1' }
    expect(groundMoneySections([section('Cash on hand is $150K [T2][F1].')], [scenario, cash]).corrected).toBe(true)
  })
  it('carries the governing scenario across adjacent six-second fragments', () => {
    const setup = source('T1', 'If Bitcoin reaches $200,000, we would sell.', 1)
    const proceeds = source('T2', 'We have $150,000 cash at our disposal after tax.', 2)
    expect(groundMoneySections([section('Cash on hand is $150K [T2].')], [setup, proceeds]).corrected).toBe(true)
  })
  it('an explicitly separate actual balance is not overwritten by a nearby scenario', () => {
    const setup = source('T1', 'If Bitcoin reaches $200,000, we would sell.', 1)
    const balance = source('T2', 'Separately, our current cash balance is $150,000.', 2)
    expect(groundMoneySections([section('Cash on hand is $150K [T2].')], [setup, balance]).corrected).toBe(false)
  })
  it('does not carry a scenario across an unrelated time gap', () => {
    const setup = source('T1', 'If Bitcoin reaches $200,000, we would sell.', 1)
    const balance = source('T2', 'Our cash balance is $150,000.', 20)
    expect(groundMoneySections([section('Cash on hand is $150K [T2].')], [setup, balance]).corrected).toBe(false)
  })
  it('does not invent a conflict between future proceeds and current file balances', () => {
    const cash: AskSource = { id: 'F1', kind: 'file', title: 'Statement', text: 'Cash $90,000.', fileId: 'current', revision: '1' }
    const result = groundMoneySections([section('The hypothetical $150K cash conflicts with the $90,000 on screen [T2][F1].')], [scenario, cash])
    expect(result.corrected).toBe(true)
    expect(result.sections[0].text).toContain('separate current cash balance')
    expect(result.sections[0].sources).toEqual(['T2', 'F1'])
  })
  it('the prompt receives observed scenario and explicit correction source IDs', () => {
    expect(moneyGroundingHints([scenario, source('T3', 'He said no, no, $85,000.')])).toEqual({ conditionalSources: ['T2'], explicitCorrectionSources: ['T3'] })
  })
  it('highlights do not list incidental amounts just to say they were left out', () => {
    const text = 'Reported saving $10K [T1]. The $120,000 cash figures were unclear, so I left them out.'
    const result = groundMoneySections([section(text)], [source('T1', 'Reported saving $10K.')], 'Money highlights?')
    expect(result.sections[0].text).toBe('Reported saving $10K [T1].')
    expect(result.sections[0].sources).toEqual(['T1'])
  })
  it('does not suppress an explicit question about omitted figures', () => {
    const text = 'The $120,000 figure was unclear, so I left it out.'
    expect(groundMoneySections([section(text)], [], 'Which figures did you omit?').sections[0].text).toBe(text)
  })
  it('uses admitted matching sources to protect an uncited headline as well', () => {
    const result = groundMoneySections([section('The biggest item is $150,000 in cash.')], [scenario])
    expect(result.corrected).toBe(true)
    expect(result.sections[0].sources).toEqual(['T2'])
  })
  it('runs before confidence and persistence without another model call or search', async () => {
    const run = vi.fn(async () => ({ text: JSON.stringify({ sections: [section('We have $150K cash on hand [T1].')], confidence: { level: 'supported', reason: 'The amount is clear.' } }), model: 'claude-sonnet' }))
    const search = vi.fn()
    const out = await createLiveAsk({ run, search, requireHaiku: false })(input([turn(1, scenario.text)]))
    expect(out.answer).toContain('does not establish a current balance')
    expect(out.sections.at(-1)?.text).toMatch(/^Limited/)
    expect(run).toHaveBeenCalledTimes(1); expect(search).not.toHaveBeenCalled()
  })
})
