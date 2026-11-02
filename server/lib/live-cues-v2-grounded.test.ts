// Live cues v3 grounded retrieval and judge B: the pure helpers. The engine's use of them is in live-cues-v2-grounding.test.ts.
import { describe, expect, it } from 'vitest'
import {
  GROUNDED_LIMITS, usableFiles, bestFilePassage, candidateIdentities, groundedCandidates, groundedSource, isForeignPersonal, isSelfCopy, normalizeMeetingTitle,
  passagesOf, selfIdSet, shingleSet, sixGramOverlap, type GroundedFile, type GroundedInputs,
} from './live-cues-v2-grounded.js'
import { CUE_REL_NO, CUE_REL_YES, JUDGE_B_NOTE_CHARS, judgeBQuestions, judgeNoteLine, parseJudgeB, selectJudgeB } from './live-cues-v2-judge-b.js'
import { CUE_JUDGE_INSTRUCTIONS, CUE_JUDGE_NONE } from './live-cues-v2-prompts.js'
import type { MemoryNote } from './live-cues-v2.js'

const w = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ')
const note = (id: string, over: Partial<MemoryNote> = {}): MemoryNote => ({ id, date: '2026-10-01', title: `Meeting ${id}`, notes: `summary of ${id}`, key: `2026-10-01|meeting ${id.toLowerCase()}`, ...over })

describe('title identity', () => {
  it('normalises like meeting_canonical.normalize_title: lower case, ASCII punctuation to spaces, whitespace collapsed', () => {
    expect(normalizeMeetingTitle('  Q4 Pricing -- Review (Quilt)!  ')).toBe('q4 pricing review quilt')
    expect(normalizeMeetingTitle('Miles & Team: Monday_Momentum')).toBe('miles team monday momentum')
    expect(normalizeMeetingTitle('')).toBe('')
  })
  it('a meeting is the same by date and normalised title, a memory by id, a record by id and a file by id', () => {
    expect(candidateIdentities({ date: '2026-10-01', title: 'Q4: Pricing!' })).toEqual(['meeting:2026-10-01|q4 pricing'])
    expect(candidateIdentities({ date: '', title: 'x', memoryId: 'mem1' })).toEqual(['memory:mem1'])
    expect(candidateIdentities({ date: '2026-10-01', title: 'A', recordId: 'ops:quilt:2026-10:a.md', memoryId: 'm' }))
      .toEqual(['meeting:2026-10-01|a', 'record:ops:quilt:2026-10:a.md', 'memory:m'])
    expect(candidateIdentities({ date: '2026-10-01', title: 'A', fileId: 'f' })).toEqual(['file:f'])          // a file is not a meeting
  })
})

describe('self and twin exclusion', () => {
  it('6-word sequences are lower case, punctuation-free and counted per window of six', () => {
    expect(shingleSet('One two three four five six').size).toBe(1)
    expect(shingleSet('One two three four five').size).toBe(0)
    expect(shingleSet('a b c d e f g').size).toBe(2)
    expect(shingleSet('The CAP, the cap; the cap').has('the cap the cap the cap')).toBe(true)
  })
  it('overlap is the share of the candidate\'s own 6-word sequences found in the transcript; none to compare is 0', () => {
    const said = shingleSet(w('s', 40))
    const text25 = `${w('s', 8)} ${w('n', 17)}`                     // 25 words, 20 sequences; the first 3 are in the transcript
    expect(shingleSet(text25).size).toBe(20)
    expect(sixGramOverlap(text25, said)).toBe(3 / 20)
    expect(sixGramOverlap(w('n', 30), said)).toBe(0)
    expect(sixGramOverlap('too short', said)).toBe(0)
    expect(sixGramOverlap(w('s', 12), said)).toBe(1)
  })
  it('a note is this conversation at exactly 15% and not below it', () => {
    const said = shingleSet(w('s', 40))
    const at = (shared: number) => ({ notes: `${w('s', 5 + shared)} ${w('n', 20 - shared)}`, recordId: undefined, sessionId: undefined })
    // 25 words give 20 sequences; sharing the first k sequences takes 5 + k words from the transcript.
    expect(isSelfCopy(at(3), said, new Set())).toBe(true)          // 3 / 20 = 0.15
    expect(isSelfCopy(at(2), said, new Set())).toBe(false)         // 2 / 20 = 0.10
    expect(GROUNDED_LIMITS.selfOverlap).toBe(0.15)
  })
  it('a record that is this session or a known twin is excluded whatever its text says, also in the library\'s standalone: form', () => {
    const ids = selfIdSet('mac_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ['meeting_twin_01'])
    const none = new Set<string>()
    expect(isSelfCopy({ notes: 'x', recordId: 'mac_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, none, ids)).toBe(true)
    expect(isSelfCopy({ notes: 'x', recordId: 'standalone:mac_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, none, ids)).toBe(true)
    expect(isSelfCopy({ notes: 'x', recordId: 'standalone:meeting_twin_01' }, none, ids)).toBe(true)
    expect(isSelfCopy({ notes: 'x', sessionId: 'meeting_twin_01' }, none, ids)).toBe(true)
    expect(isSelfCopy({ notes: 'x', recordId: 'standalone:meeting_other_99', sessionId: 'meeting_other_99' }, none, ids)).toBe(false)
    expect(isSelfCopy({ notes: 'x' }, none, ids)).toBe(false)
  })
})

describe('domain filter', () => {
  it('a personal note never reaches a meeting that is not personal; an unknown meeting domain is not personal', () => {
    expect(isForeignPersonal('personal', 'quilt')).toBe(true)
    expect(isForeignPersonal('Personal ', null)).toBe(true)
    expect(isForeignPersonal('personal', 'personal')).toBe(false)
    expect(isForeignPersonal('personal', ' PERSONAL ')).toBe(false)
    expect(isForeignPersonal('quilt', 'personal')).toBe(false)
    expect(isForeignPersonal(undefined, 'quilt')).toBe(false)
    expect(isForeignPersonal('', null)).toBe(false)
    for (const odd of [5, {}, [], ['personal'], true, null]) {                                           // never throws on a value that is not a string
      expect(isForeignPersonal(odd as never, 'quilt'), String(odd)).toBe(false)
      expect(isForeignPersonal('personal', odd as never), String(odd)).toBe(true)
    }
  })
})

describe('files', () => {
  const file = (id: string, text: string, status = 'ready'): GroundedFile => ({ id, name: `${id}.pdf`, status, text })
  const window = 'We need to revisit the overage pricing and the renewal contract with Harborview before the quarter closes.'
  it('passages are blank-line blocks, then sentences, never longer than 300 characters', () => {
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} about overage pricing and the renewal.`).join(' ')
    const parts = passagesOf(`First block.\n\n${long}\n\n   \n\nLast block`)
    expect(parts[0]).toBe('First block.')
    expect(parts.at(-1)).toBe('Last block')
    expect(parts.every(p => p.length <= GROUNDED_LIMITS.fileChars)).toBe(true)
    expect(passagesOf('x'.repeat(650)).map(p => p.length)).toEqual([300, 300, 50])
  })
  it('the best passage is the one sharing the most of the window\'s salient words, the first on a tie', () => {
    const hit = bestFilePassage([file('f1', 'Unrelated lunch plans.\n\nOverage pricing for Harborview is capped at twelve percent.\n\nOverage pricing renewal contract Harborview quarter terms.')], window)
    expect(hit?.passage).toBe('Overage pricing renewal contract Harborview quarter terms.')
    const tie = bestFilePassage([file('f1', 'Overage pricing is reviewed yearly.\n\nOverage pricing is reviewed monthly.')], window)
    expect(tie?.passage).toBe('Overage pricing is reviewed yearly.')
  })
  it('a passage must share two of the window\'s words: one is not enough', () => {
    expect(bestFilePassage([file('f1', 'Only overage is mentioned in this passage.')], window)).toBeNull()
    expect(bestFilePassage([file('f1', 'Overage and renewal are mentioned here.')], window)?.file.id).toBe('f1')
    expect(GROUNDED_LIMITS.fileMinTerms).toBe(2)
  })
  it('only a ready file is read: pending, failed, unsupported, removed and secret-held files are ignored even when they carry text', () => {
    const text = 'Overage pricing renewal contract Harborview quarter.'
    for (const status of ['pending', 'failed', 'unsupported', 'removed', 'secret-held']) expect(bestFilePassage([file('f1', text, status)], window), status).toBeNull()
    expect(bestFilePassage([file('f1', text, 'secret-held'), file('f2', text)], window)?.file.id).toBe('f2')
    expect(bestFilePassage([file('f1', '   ')], window)).toBeNull()
  })
  it('a window with no salient words finds nothing', () => {
    expect(bestFilePassage([file('f1', 'Overage pricing renewal.')], 'um yeah okay so')).toBeNull()
  })
})

describe('candidates for the judge', () => {
  const base = (over: Partial<GroundedInputs> = {}): GroundedInputs => ({
    cueMemory: [], notes: [], files: [], transcript: w('said', 60), window: 'overage pricing renewal contract Harborview quarter',
    selfIds: selfIdSet('mac_session'), meetingDomain: 'quilt', today: '2026-11-01', ...over,
  })
  it('M1..M4 from cue_memory, N1 from the notes, F1 from the files, in that order, with ids that keep their kind', () => {
    const r = groundedCandidates(base({
      cueMemory: [1, 2, 3, 4, 5].map(i => note(`X${i}`, { date: `2026-10-0${i}`, title: `Past ${i}`, key: undefined })),
      notes: [note('Y1', { date: '2026-09-01', title: 'Memory one', key: 'memory:mem-1' }), note('Y2', { date: '2026-08-01', title: 'Memory two', key: 'memory:mem-2' })],
      files: [{ id: 'file-1', name: 'Pricing.pdf', status: 'ready', text: 'Overage pricing renewal contract Harborview terms.' }],
    }))
    expect(r.candidates.map(c => [c.id, c.arm, c.kind])).toEqual([['M1', 'cue_memory', 'meeting'], ['M2', 'cue_memory', 'meeting'], ['M3', 'cue_memory', 'meeting'], ['M4', 'cue_memory', 'meeting'],
      ['N1', 'notes', 'memory'], ['F1', 'files', 'file']])
    expect(r.candidates[4]).toMatchObject({ memoryId: 'mem-1' })
    expect(r.candidates[5]).toMatchObject({ fileId: 'file-1', title: 'Pricing.pdf', date: '2026-11-01', notes: 'Overage pricing renewal contract Harborview terms.' })
    expect(r.candidates.length).toBeLessThanOrEqual(GROUNDED_LIMITS.maxCandidates)
  })
  it('excluded copies of this meeting are skipped and the next raw note takes the slot, so four remain from eight', () => {
    const copy = (i: number) => note(`C${i}`, { title: `Copy ${i}`, date: `2026-11-0${i}`, notes: w('said', 12) })
    const r = groundedCandidates(base({ cueMemory: [copy(1), copy(2), note('A', { title: 'Real A' }), note('B', { title: 'Real B', date: '2026-09-02' }), note('C', { title: 'Real C', date: '2026-09-03' }),
      note('D', { title: 'Real D', date: '2026-09-04' }), note('E', { title: 'Real E', date: '2026-09-05' }), note('F', { title: 'Real F', date: '2026-09-06' })] }))
    expect(r.candidates.map(c => [c.id, c.title])).toEqual([['M1', 'Real A'], ['M2', 'Real B'], ['M3', 'Real C'], ['M4', 'Real D']])
    expect(r.excludedSelf).toBe(2)
  })
  it('a note filed under this session or its twin is excluded and counted, and so is one from another armed session', () => {
    const r = groundedCandidates(base({
      selfIds: selfIdSet('mac_session', ['meeting_twin']),
      notes: [note('T1', { key: 'meeting:standalone:meeting_twin', title: 'Twin copy' }), note('S1', { key: 'meeting:standalone:mac_session', title: 'Own copy', date: '2026-11-01' }),
        note('R', { key: 'meeting:ops:quilt:2026-11:filed.md', sessionId: 'meeting_twin', title: 'Filed under another record id', date: '2026-11-01' }), note('Z', { key: 'memory:m-9', title: 'Fine' })],
    }))
    expect(r.candidates.map(c => c.title)).toEqual(['Fine'])
    expect(r.excludedSelf).toBe(3)
  })
  it('a file is never excluded as this conversation: the room may read from the very document it attached', () => {
    const text = w('said', 12)
    const r = groundedCandidates(base({ window: `${w('said', 12)} overage pricing`, files: [{ id: 'f', name: 'Notes.txt', status: 'ready', text: `${text} overage pricing renewal` }] }))
    expect(r.candidates.map(c => c.id)).toEqual(['F1'])
    expect(r.excludedSelf).toBe(0)
  })
  // cue_memory.py builds each note as exactly this (operations/scripts/cue_memory.py:256): id, date, title cut at 90, the header
  // collapsed and cut at 520, and the date|normalised-title key. Its domain, once the script says it, is one more string field.
  const cueMemoryLine = (id: string, date: string, title: string, header: string, domain?: string): MemoryNote =>
    ({ id, date, title: title.slice(0, 90), notes: header.replace(/\s+/g, ' ').slice(0, 520), key: `${date}|${normalizeMeetingTitle(title)}`, ...(domain === undefined ? {} : { domain }) })
  it('a personal-domain note is dropped from a work meeting and kept in a personal one, from either arm', () => {
    const personal = cueMemoryLine('M1', '2026-10-02', 'Family budget', 'Summary: the kids\' accounts', 'personal')
    const work = cueMemoryLine('M2', '2026-10-03', 'Quilt plan', 'Summary: the plan', 'quilt')
    const mine = note('N', { title: 'Mine', domain: 'personal', key: 'memory:n', date: '2026-10-04' })
    expect(groundedCandidates(base({ cueMemory: [personal, work], notes: [mine] })).candidates.map(c => c.title)).toEqual(['Quilt plan'])
    expect(groundedCandidates(base({ cueMemory: [personal, work], notes: [mine], meetingDomain: 'personal' })).candidates.map(c => c.title)).toEqual(['Family budget', 'Quilt plan', 'Mine'])
    expect(groundedCandidates(base({ cueMemory: [personal], meetingDomain: null })).candidates).toEqual([])
    expect(groundedCandidates(base({ cueMemory: [{ ...personal, domain: ' Personal ' }] })).candidates).toEqual([])          // case and spaces do not hide it
  })
  it('the notes cue_memory.py writes today say no domain: they pass the personal rule, and each one is counted as unknown', () => {
    const lines = [cueMemoryLine('M1', '2026-10-02', 'Family budget', 'Summary: the kids\' accounts'), cueMemoryLine('M2', '2026-10-03', 'Quilt plan', 'Summary: the plan', 'quilt')]
    expect(Object.keys(lines[0]).sort()).toEqual(['date', 'id', 'key', 'notes', 'title'])
    const r = groundedCandidates(base({ cueMemory: lines, notes: [note('N', { key: 'memory:n', date: '2026-09-04', title: 'No domain here' })] }))
    expect(r.candidates.map(c => c.title)).toEqual(['Family budget', 'Quilt plan', 'No domain here'])
    expect(r.domainUnknown).toBe(2)                                                                                   // a file is not counted, and neither is a note that said its domain
    expect(groundedCandidates(base({ cueMemory: [lines[1]] })).domainUnknown).toBe(0)
    const withFile = groundedCandidates(base({ cueMemory: [lines[1]], files: [{ id: 'f', name: 'Plan.pdf', status: 'ready', text: 'Overage pricing renewal contract.' }] }))
    expect(withFile.candidates.map(c => c.id)).toEqual(['M1', 'F1'])
    expect(withFile.domainUnknown).toBe(0)
    expect(groundedCandidates(base({ cueMemory: [{ ...lines[0], domain: '   ' }] })).domainUnknown).toBe(1)             // a blank domain says nothing
  })
  it('a domain, session or key that is not a string never throws: the note is treated as saying nothing', () => {
    const odd = { ...cueMemoryLine('M1', '2026-10-02', 'Odd one', 'Summary: odd'), domain: 5, sessionId: 7, key: 9 } as unknown as MemoryNote
    const r = groundedCandidates(base({ cueMemory: [odd] }))
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0]).toMatchObject({ kind: 'meeting', key: '' })
    expect(r.candidates[0]).not.toHaveProperty('domain')
    expect(r.candidates[0]).not.toHaveProperty('sessionId')
    expect(r.domainUnknown).toBe(1)
  })
  it('a malformed row is skipped, never thrown on: each of id, date, title and notes must be a string', () => {
    const ok = cueMemoryLine('M1', '2026-10-02', 'Fine', 'Summary: fine')
    for (const bad of [{ id: 3 }, { date: 20261002 }, { title: null }, { title: { x: 1 } }, { notes: undefined }, { notes: 5 }]) {
      const r = groundedCandidates(base({ cueMemory: [{ ...ok, ...bad } as unknown as MemoryNote, cueMemoryLine('M2', '2026-10-03', 'Next', 'Summary: next')] }))
      expect(r.candidates.map(c => c.title), JSON.stringify(bad)).toEqual(['Next'])
    }
    expect(groundedCandidates(base({ cueMemory: [null, 'text', 4] as unknown as MemoryNote[] })).candidates).toEqual([])
  })
  it('a copy of this meeting also keeps its other copies out: the identity of an excluded note is remembered', () => {
    const copy = cueMemoryLine('M1', '2026-10-14', 'Weekly sync', w('said', 12))
    const sameMeeting = note('N', { date: '2026-10-14', title: 'Weekly sync', key: 'memory:m-9', notes: 'a summary that shares no sentence with the room' })
    const other = note('O', { date: '2026-10-07', title: 'Other sync', key: 'memory:m-8' })
    const r = groundedCandidates(base({ cueMemory: [copy], notes: [sameMeeting, other] }))
    expect(r.candidates.map(c => c.title)).toEqual(['Other sync'])
    expect(r.excludedSelf).toBe(1)                                                                                    // the duplicate is skipped, not counted as a second copy
  })
  it('one meeting is one candidate however many arms found it: date and title, memory id, record id, file id', () => {
    const r = groundedCandidates(base({
      cueMemory: [note('A', { date: '2026-10-01', title: 'Q4 Pricing: Review!', key: '2026-10-01|q4 pricing review' })],
      notes: [note('B', { date: '2026-10-01', title: 'q4 pricing review', key: 'meeting:ops:quilt:2026-10:q4.md' }), note('C', { date: '2026-09-02', title: 'Other', key: 'memory:m-1' })],
    }))
    expect(r.candidates.map(c => [c.id, c.title])).toEqual([['M1', 'Q4 Pricing: Review!'], ['N1', 'Other']])
    const second = groundedCandidates(base({ cueMemory: [note('A', { title: 'One', key: 'meeting:r-1', date: '2026-10-01' })], notes: [note('B', { title: 'Two', key: 'meeting:r-1', date: '2026-10-02' })] }))
    expect(second.candidates.map(c => c.title)).toEqual(['One'])
    // A file is not a meeting: one named like a meeting held today is still offered beside it.
    const files = groundedCandidates(base({ cueMemory: [note('A', { date: '2026-11-01', title: 'Doc', key: undefined })], files: [{ id: 'f1', name: 'Doc', status: 'ready', text: 'Overage pricing renewal contract.' }] }))
    expect(files.candidates.map(c => c.id)).toEqual(['M1', 'F1'])
  })
  it('the first note of the notes arm that is not a duplicate is N1', () => {
    const r = groundedCandidates(base({ cueMemory: [note('A', { title: 'Same', key: undefined })], notes: [note('D', { title: 'Same', key: 'meeting:r-2' }), note('E', { title: 'New', key: 'meeting:r-3', date: '2026-09-09' })] }))
    expect(r.candidates.map(c => [c.id, c.title])).toEqual([['M1', 'Same'], ['N1', 'New']])
  })
  it('a source carries its kind and the one locator that matches it', () => {
    const r = groundedCandidates(base({ cueMemory: [note('A', { key: undefined })], notes: [note('B', { title: 'Mem', key: 'memory:m-1', date: '2026-09-01' })] }))
    const [m1, n1] = r.candidates
    expect(groundedSource(m1, 'mtg_1')).toEqual({ id: 'mtg_1', date: '2026-10-01', title: 'Meeting A', kind: 'meeting' })
    expect(groundedSource(n1, 'mtg_2')).toEqual({ id: 'mtg_2', date: '2026-09-01', title: 'Mem', kind: 'memory', memoryId: 'm-1' })
    const rec = groundedCandidates(base({ notes: [note('R', { key: 'meeting:ops:quilt:2026-10:a.md' })] })).candidates[0]
    expect(groundedSource(rec, 'mtg_3')).toMatchObject({ kind: 'meeting', recordId: 'ops:quilt:2026-10:a.md' })
    const f = groundedCandidates(base({ files: [{ id: 'file-9', name: 'A.pdf', status: 'ready', text: 'Overage pricing renewal contract.' }] })).candidates[0]
    expect(groundedSource(f, 'mtg_4')).toMatchObject({ kind: 'file', fileId: 'file-9' })
  })
})

describe('files with fields the code reads', () => {
  it('only a file whose id, name, status and text are all strings is a file', () => {
    const ok = { id: 'f1', name: 'Plan.pdf', status: 'ready', text: 'Overage pricing renewal contract.' }
    expect(usableFiles([ok, null, 'x', 3, { ...ok, id: 4 }, { ...ok, name: 7 }, { ...ok, status: null }, { ...ok, text: undefined }, { ...ok, id: 'f2' }])).toEqual([ok, { ...ok, id: 'f2' }])
    for (const raw of [undefined, null, 'files', 5, {}, { length: 1, 0: ok }]) expect(usableFiles(raw), String(raw)).toEqual([])
  })
  it('a malformed file in the list never reaches the passage search or the candidate', () => {
    const ok = { id: 'f1', name: 'Plan.pdf', status: 'ready', text: 'Overage pricing renewal contract Harborview terms.' }
    const inputs = { cueMemory: [], notes: [], transcript: w('said', 60), window: 'overage pricing renewal contract Harborview quarter', selfIds: selfIdSet('mac_session'), meetingDomain: 'quilt', today: '2026-11-01' }
    const r = groundedCandidates({ ...inputs, files: [null, { id: 'bad', name: 7, status: 'ready', text: 'Overage pricing renewal contract Harborview terms.' }, 'x', ok] })
    expect(r.candidates.map(c => [c.id, c.title])).toEqual([['F1', 'Plan.pdf']])
    expect(groundedCandidates({ ...inputs, files: [{ id: 'bad', name: 7, status: 'ready', text: 'Overage pricing renewal contract Harborview terms.' }] }).candidates).toEqual([])
    expect(groundedCandidates({ ...inputs, files: undefined }).candidates).toEqual([])
  })
})

describe('judge B', () => {
  const cands = [{ id: 'M1', date: '2026-10-01', title: 'Kept A', notes: 'Summary: redirect pricing 12% overage' }, { id: 'F1', date: '2026-11-01', title: 'Doc.pdf', notes: 'x'.repeat(500) }]
  it('the wording is the replay\'s, verbatim', () => {
    expect(CUE_REL_YES).toBe('Yes: the note is about the same client, project, brand, person or decision as the conversation, and would help the wearer right now.')
    expect(CUE_REL_NO).toBe('No: the note is about something else, or is only loosely related to the conversation.')
    expect(judgeNoteLine(cands[0])).toBe('2026-10-01 Kept A: Summary: redirect pricing 12% overage')
    expect(judgeNoteLine(cands[1])).toBe(`2026-11-01 Doc.pdf: ${'x'.repeat(JUDGE_B_NOTE_CHARS)}`)
    expect(JUDGE_B_NOTE_CHARS).toBe(300)
    const q = judgeBQuestions(cands) as Record<string, { type: string; instructions: string; criteria: Record<string, string> }>
    expect(Object.keys(q)).toEqual(['same', 'rel_M1', 'rel_F1'])
    expect(q.same).toEqual({ type: 'choice', instructions: CUE_JUDGE_INSTRUCTIONS, criteria: { M1: judgeNoteLine(cands[0]), F1: judgeNoteLine(cands[1]), none: CUE_JUDGE_NONE } })
    expect(q.rel_M1).toEqual({ type: 'choice', criteria: { yes: CUE_REL_YES, no: CUE_REL_NO },
      instructions: 'Is this past meeting note directly relevant to what is being discussed in the last part of `window`? Past note: 2026-10-01 Kept A: Summary: redirect pricing 12% overage' })
  })
  it('reads each candidate\'s own yes and its same probability; anything missing or out of range reads as 0', () => {
    const answers = { rel_M1: { probabilities: { yes: 0.7, no: 0.3 } }, rel_F1: { probabilities: { yes: 1.2 } }, same: { probabilities: { M1: 0.4, F1: Number.NaN, none: 0.1 } } }
    expect(parseJudgeB(answers, ['M1', 'F1', 'N1'])).toEqual({ yes: { M1: 0.7, F1: 0, N1: 0 }, same: { M1: 0.4, F1: 0, N1: 0 } })
    expect(parseJudgeB(undefined, ['M1'])).toEqual({ yes: { M1: 0 }, same: { M1: 0 } })
    expect(parseJudgeB({ rel_M1: { probabilities: { yes: '0.9' as unknown as number } }, same: { probabilities: { M1: '0.5' as unknown as number } } }, ['M1'])).toEqual({ yes: { M1: 0 }, same: { M1: 0 } })   // a number, not a numeric string
  })
  it('keeps yes at or above the threshold, best first, at most two, ties in candidate order', () => {
    const c = ['M1', 'M2', 'M3', 'N1', 'F1'].map(id => ({ id }))
    expect(selectJudgeB(c, { M1: 0.65, M2: 0.649, M3: 0.9, N1: 0.65, F1: 0.2 }, 0.65, 2).map(x => x.id)).toEqual(['M3', 'M1'])
    expect(selectJudgeB(c, { M1: 0.8, M2: 0.8, M3: 0.8, N1: 0.8, F1: 0.8 }, 0.65, 2).map(x => x.id)).toEqual(['M1', 'M2'])
    expect(selectJudgeB(c, { M1: 0.64, M2: 0.5 }, 0.65, 2)).toEqual([])
    expect(selectJudgeB(c, { M1: 0.9, M2: 0.8, M3: 0.7 }, 0.65, 3).map(x => x.id)).toEqual(['M1', 'M2', 'M3'])
  })
})
