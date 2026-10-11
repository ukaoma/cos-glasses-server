import { describe, it, expect } from 'vitest'
import { meetingAskFromLine, meetingAskAnswerMarkdown, meetingAskCitations, type MeetingAskSection, type MeetingAskSource } from './meeting-ask.js'
const t1: MeetingAskSource = { id: 'T1', kind: 'transcript', title: 'Person A · 0:10', text: 'x', turnId: 1 }
const w1: MeetingAskSource = { id: 'W1', kind: 'web', title: 'Web search summary: example pos', text: 'x', url: 'https://www.example.com/pricing', retrievalId: 'r1' }
const w2: MeetingAskSource = { id: 'W2', kind: 'web', title: 'Result', text: 'x', url: 'https://docs.example.org/a', retrievalId: 'r1' }
const w3: MeetingAskSource = { id: 'W3', kind: 'web', title: 'Summary', text: 'x' }
const h1: MeetingAskSource = { id: 'H1', kind: 'memory', title: 'Pricing preference', text: 'x', memoryId: 'm1' }
const h2: MeetingAskSource = { id: 'H2', kind: 'meeting', title: 'pricing sync · 2026-09-30', text: 'x', recordId: 'r' }
const f1: MeetingAskSource = { id: 'F1', kind: 'file', title: 'Q4 pricing.pdf', text: 'x', fileId: 'f', revision: '1' }
const all = [t1, w1, w2, w3, h1, h2, f1]
const cite = (...ids: string[]): MeetingAskSection[] => [{ label: 'So what', text: ids.map(i => `[${i}]`).join(' '), sources: ids }]

describe('lens From: line', () => {
  it('is null for a meeting-only answer or no citations', () => {
    expect(meetingAskFromLine(cite('T1'), all)).toBeNull()
    expect(meetingAskFromLine(cite(), all)).toBeNull()
    expect(meetingAskFromLine(undefined, all)).toBeNull()
  })
  it('names each kind of outside source', () => {
    expect(meetingAskFromLine(cite('T1', 'W1'), all)).toBe('the web, example.com')
    expect(meetingAskFromLine(cite('W3'), all)).toBe('the web')
    expect(meetingAskFromLine(cite('H1'), all)).toBe('COS memory')
    expect(meetingAskFromLine(cite('H2'), all)).toBe('earlier meeting, Sep 30 pricing sync')
    expect(meetingAskFromLine(cite('F1'), all)).toBe('file, Q4 pricing.pdf')
  })
  it('counts only cited ids, never an uncited sibling from the same web search', () => {
    expect(meetingAskFromLine(cite('W1'), all)).toBe('the web, example.com')
    expect(meetingAskFromLine(cite('W1', 'W2'), all)).toBe('the web, example.com, docs.example.org')
  })
  it('reads citations from every section and joins kinds in a fixed order on one line', () => {
    const sections: MeetingAskSection[] = [{ label: 'So what', text: '[F1]', sources: ['F1'] }, { label: 'Details', text: '[H1] [W1] [T1]', sources: ['H1', 'W1', 'T1'] }]
    expect(meetingAskFromLine(sections, all)).toBe('the web, example.com; COS memory; file, Q4 pricing.pdf')
  })
  it('stays one bounded line', () => {
    const long: MeetingAskSource = { ...f1, title: 'A very long attachment name that goes on and on and on and on.pdf' }
    const line = meetingAskFromLine(cite('W1', 'H1', 'F1'), [w1, h1, long])!
    expect(line.length).toBeLessThanOrEqual(80); expect(line.endsWith('…')).toBe(true); expect(line).not.toContain('\n')
  })
})
describe('answer helpers', () => {
  it('composes one bold-label line per section', () => {
    expect(meetingAskAnswerMarkdown([{ label: 'So what', text: 'A [T1].', sources: ['T1'] }, { label: 'Next', text: 'B.', sources: [] }])).toBe('**So what:** A [T1].\n**Next:** B.')
  })
  it('lists citations once, in first-cited order', () => {
    expect(meetingAskCitations('[T2] x [H1] [T2] [W3] [Z1] [T]')).toEqual(['T2', 'H1', 'W3'])
  })
})
