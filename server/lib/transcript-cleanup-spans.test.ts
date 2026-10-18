import { describe, expect, it } from 'vitest'
import { parseTranscriptLines, tokenize, alignWordInfo, skeleton, soundsAlike, wordInfoFromSidecar, type Token } from './transcript-cleanup-text.js'
import { addNotes, buildContextPack, extractTerms, knownKeys, nameTargets, type ContextPack } from './transcript-cleanup-context.js'
import { deterministicFixes, inflectionOf, lowConfidenceFloor, repeatRuns, selectSpans } from './transcript-cleanup-spans.js'
import { buildCleanupPrompt, parseCleanupReply, validateCleanupEdits } from './transcript-cleanup-model.js'
import { applyPlannedEdits } from './transcript-cleanup-ledger.js'

function pack(over: Partial<Parameters<typeof buildContextPack>[0]> = {}): ContextPack {
  return buildContextPack({ title: 'Sync', date: '2026-10-17', attendees: [], speakers: ['Queen Ukaoma', 'Graham Smith'], owner: null, vocabulary: ['Jewel360', 'Bottle POS'], corrections: {}, files: [], screen: [], ...over })
}

function setup(section: string, probability?: (t: Token) => number | undefined, p: ContextPack = pack()) {
  const lines = parseTranscriptLines(section)
  const tokens = tokenize(lines)
  for (const t of tokens) { const v = probability?.(t); if (v !== undefined) t.probability = v }
  return { lines, tokens, sel: selectSpans(lines, tokens, nameTargets(p), knownKeys(p)), p }
}
const texts = (s: ReturnType<typeof setup>) => s.sel.spans.map(x => x.text)

describe('span selection (no model)', () => {
  it('low confidence uses the engine floor: Parakeet 0.50, Whisper 0.40', () => {
    expect(lowConfidenceFloor('parakeet-ultra')).toBe(0.5)
    expect(lowConfidenceFloor('large-v3')).toBe(0.4)
    expect(lowConfidenceFloor(undefined)).toBe(0.45)
    const scores: Record<string, number> = { alpha: 0.49, bravo: 0.5, charlie: 0.39, delta: 0.41 }
    const lines = parseTranscriptLines('[MU]: alpha one bravo two three four charlie five six seven delta.')
    const tokens = tokenize(lines)
    for (const t of tokens) { t.probability = scores[t.key] ?? 0.99; t.engine = ['charlie', 'delta'].includes(t.key) ? 'large-v3' : 'parakeet-ultra' }
    const sel = selectSpans(lines, tokens, [], new Set())
    expect(sel.spans.map(s => s.text)).toEqual(['alpha', 'charlie'])
    expect(sel.spans.every(s => s.reasons.join() === 'low_confidence')).toBe(true)
  })

  it('fillers are never doubtful, however unsure the engine was', () => {
    expect(texts(setup('[MU]: um, uh, hmm. mhm.', () => 0.1))).toEqual([])
    // A filler between two doubtful words is carried inside their span, never a span of its own.
    expect(texts(setup('[MU]: we um went. Uh. yesterday', t => (t.key === 'um' || t.key === 'uh' ? 0.1 : t.key === 'we' || t.key === 'went' ? 0.2 : 0.99)))).toEqual(['we um went'])
  })

  it('near names: Yukoma, eucoma and the split "U coma"; common words never', () => {
    const s = setup('[MU]: Yukoma and eucoma, then U coma, and a comma, right?')
    // One word apart merges; a comma ends the passage.
    expect(texts(s)).toEqual(['Yukoma and eucoma', 'U coma'])
    expect(s.sel.spans.every(x => x.reasons.includes('near_name') && x.near.includes('Ukaoma'))).toBe(true)
    expect(skeleton('Ukaoma')).toBe('km')
    expect(soundsAlike('comma', 'Ukaoma')).toBe(false)
    expect(soundsAlike('eucoma', 'Ukaoma')).toBe(true)
  })

  it('an out-of-vocabulary capital beside a known name is doubtful; at a sentence start it is not', () => {
    const s = setup('[MU]: I saw Queen Zebulona there. Zebulona left, and Graham Fennimore stayed.')
    expect(texts(s)).toEqual(['Zebulona', 'Fennimore'])
    expect(s.sel.spans[0].reasons).toEqual(['oov_capitalized'])
  })

  it('a decoder loop is one repeat span; ordinary repetition is not', () => {
    const lines = parseTranscriptLines('[MU]: thank you for watching thank you for watching thank you for watching and no no no')
    const tokens = tokenize(lines)
    expect(repeatRuns(tokens)).toEqual([[0, 12]])
    const sel = selectSpans(lines, tokens, [], new Set())
    expect(sel.spans).toHaveLength(1)
    expect(sel.spans[0]).toMatchObject({ reasons: ['repeat'], text: 'thank you for watching thank you for watching thank you for watching' })
  })

  it('spans never cross a speaker turn, hold at most 6 words, and carry same-line context', () => {
    const s = setup('[MU]: one two three four five six seven eight\n[Ext]: nine ten', () => 0.1)
    expect(s.sel.spans.map(x => [x.line, x.text])).toEqual([[0, 'one two three four five six'], [0, 'seven eight'], [1, 'nine ten']])
    expect(s.sel.spans[1].before).toBe('one two three four five six')
    expect(s.sel.spans[2].before).toBe('')
  })

  it('the cap keeps names first, then the least confident, and ids follow transcript order', () => {
    const lines = parseTranscriptLines('[MU]: alpha x x bravo x x Yukoma x x charlie')
    const tokens = tokenize(lines)
    const p = { alpha: 0.3, bravo: 0.1, charlie: 0.44 } as Record<string, number>
    for (const t of tokens) t.probability = p[t.key] ?? 0.99
    const sel = selectSpans(lines, tokens, nameTargets(pack()), knownKeys(pack()), { maxSpans: 2 })
    expect(sel.found).toBe(4)
    expect(sel.spans.map(s => [s.id, s.text])).toEqual([['S1', 'bravo'], ['S2', 'Yukoma']])
  })

  it('a word the engine was sure of is not near a name; the same word unsure is', () => {
    const p = pack({ speakers: ['Nate Diaz'] })
    expect(texts(setup('[MU]: the Rates went up', () => 0.99, p))).toEqual([])
    const unsure = setup('[MU]: the Rates went up', t => (t.key === 'rates' ? 0.6 : 0.99), p)
    expect(unsure.sel.spans.map(x => [x.text, x.reasons, x.near])).toEqual([['Rates', ['near_name'], ['Nate']]])
  })

  it('an unsure inflection of a name-like label is still not near it', () => {
    const p = pack({ screen: [{ at: 1, text: 'Recording Settings' }] })
    expect(texts(setup('[MU]: then Recordings started', t => (t.key === 'recordings' ? 0.6 : 0.99), p))).toEqual([])
    expect(soundsAlike('Mello', 'Amelo')).toBe(false)
  })

  it('joined pieces: an exact join is a split name; function words and long pieces never join', () => {
    expect(texts(setup('[MU]: I saw Uka oma today'))).toEqual(['Uka oma'])
    expect(texts(setup('[MU]: we went to the on ramp', undefined, pack({ speakers: ['Theon Ruiz'] })))).toEqual([])
    const long = setup('[MU]: then Amberly x said', t => (t.key === 'amberly' || t.key === 'x' ? 0.5 : 0.99), pack({ speakers: ['Amberlyx Stone'] }))
    expect(texts(long)).toEqual(['Amberly'])
    expect(soundsAlike('Ella', 'Ollie')).toBe(false)
  })

  it('two repetitions are speech, not a loop; a capital that opens a sentence is not out of vocabulary', () => {
    const lines = parseTranscriptLines('[MU]: we went we went home')
    expect(repeatRuns(tokenize(lines))).toEqual([])
    expect(texts(setup('[MU]: I saw them there. Ozmanda and Queen left.'))).toEqual([])
  })

  it('a known exact spelling is never doubtful', () => {
    expect(texts(setup('[MU]: Queen Ukaoma uses Jewel360 and Bottle POS.'))).toEqual([])
  })

  it('aligns batch words to tokens greedily, and an unmatched token stays unscored', () => {
    const lines = parseTranscriptLines('[MU]: Hello, Queen Ukaoma.\n[Ext]: Hi there')
    const tokens = tokenize(lines)
    const words = wordInfoFromSidecar({ startTime: 1_000_000, batchSegments: [{ startElapsed: 2_000, stt: { engine: 'parakeet-ultra' }, words: [
      { word: 'Hello,', start: 0, probability: 0.9 }, { word: 'Queen', start: 0.5, probability: 0.8 }, { word: 'Ukaoma', start: 1, probability: 0.4 }, { word: 'Hi', start: 3, probability: 0.7 },
    ] }] })
    expect(alignWordInfo(tokens, words)).toBe(4)
    expect(tokens.map(t => [t.core, t.probability, t.atMs, t.engine])).toEqual([
      ['Hello', 0.9, 1_002_000, 'parakeet-ultra'], ['Queen', 0.8, 1_002_500, 'parakeet-ultra'], ['Ukaoma', 0.4, 1_003_000, 'parakeet-ultra'],
      ['Hi', 0.7, 1_005_000, 'parakeet-ultra'], ['there', undefined, undefined, undefined],
    ])
  })
})

describe('deterministic fixes', () => {
  it('capitalised words only; strong targets only when unsure; a screen term at any confidence; never a known spelling', () => {
    const lines = parseTranscriptLines("[MU]: then Graem said Ukoma's plan to Graem and Black, the Settng page, Recordings, giant and graem and kaoma. Vernel left. Vernel came")
    const tokens = tokenize(lines)
    for (const t of tokens) t.probability = 0.97
    tokens.filter(t => t.core === 'Graem')[0].probability = 0.6
    tokens.filter(t => t.core === 'Vernel').at(-1)!.probability = 0.6
    const p = pack({ speakers: ['Aaron Black'], vocabulary: [], screen: [{ at: 1, text: 'Ukaoma Settings Recording Slack' }] })
    const fixes = deterministicFixes(tokens, ['Graeme Hill', 'Vernell Ruiz'], nameTargets(p), knownKeys(p))
    // The unsure Graem is one edit from an attendee; the sure one is left. Ukoma's is one edit from a screen term
    // (any confidence). Black is a known surname, never rewritten to the screen's Slack. Settng is two edits from a
    // label; Recordings is an inflection of one; giant, graem and kaoma are lowercase; the sure Vernel opens a sentence.
    expect(fixes.map(f => [f.original, f.replacement, f.fromMeeting])).toEqual([
      ['Graem', 'Graeme', false],
      ["Ukoma's", "Ukaoma's", true],
      ['Vernel', 'Vernell', false],
    ])
    expect(fixes[0].token).toBe(tokens.filter(t => t.core === 'Graem')[0].i)
    expect(fixes[2].token).toBe(tokens.filter(t => t.core === 'Vernel').at(-1)!.i)
    // A known person is never rewritten into a screen word one edit away; a screen term rewrites a sure word only mid-sentence.
    const p2 = pack({ speakers: ['Nora Vance'], vocabulary: [], screen: [{ at: 1, text: 'Vince Ukaoma' }] })
    const t2 = tokenize(parseTranscriptLines('[MU]: Ukoma left with Vance. Then Ukoma came'))
    for (const t of t2) t.probability = 0.97
    expect(deterministicFixes(t2, [], nameTargets(p2), knownKeys(p2)).map(f => [f.original, f.replacement, f.token])).toEqual([['Ukoma', 'Ukaoma', 5]])
    // Enrolled names that are not in the room are never deterministic targets.
    expect(deterministicFixes(tokenize(parseTranscriptLines('[MU]: then Blak said')), [], nameTargets(p), knownKeys(p))).toEqual([])
    expect(inflectionOf('Recordings', 'Recording')).toBe(true)
    expect(inflectionOf('Ukoma', 'Ukaoma')).toBe(false)
  })

  it('applies edits by offset, keeping punctuation and the label', () => {
    const lines = parseTranscriptLines('[MU]: Hi Yukoma, and eucoma.')
    const tokens = tokenize(lines)
    const { lines: out, applied } = applyPlannedEdits(lines, [
      { line: 0, start: tokens[1].start, end: tokens[1].end, replacement: 'Ukaoma', source: 'model' },
      { line: 0, start: tokens[3].start, end: tokens[3].end, replacement: 'Ukaoma', source: 'model' },
    ])
    expect(out[0].prefix + out[0].text).toBe('[MU]: Hi Ukaoma, and Ukaoma.')
    expect(applied.map(a => [a.original, a.offset, a.before, a.after])).toEqual([['Yukoma', 3, 'Hi ', ', and Ukaoma.'], ['eucoma', 15, 'Hi Ukaoma, and ', '.']])
    // Overlapping edits cannot both land: the earlier one in the line wins.
    const overlap = applyPlannedEdits(lines, [
      { line: 0, start: 3, end: 9, replacement: 'Ukaoma', source: 'model' },
      { line: 0, start: 5, end: 14, replacement: 'XX', source: 'model' },
    ])
    expect(overlap.lines[0].text).toBe('Hi Ukaoma, and eucoma.')
    expect(overlap.applied).toHaveLength(1)
  })
})

describe('context terms', () => {
  it('extracts names and runs of capitals, not common words, acronyms or sentence filler', () => {
    expect(extractTerms('Queen Ukaoma joined. The Meeting has POS and Jewel360 | Settings')).toEqual(['Queen Ukaoma', 'Ukaoma', 'Jewel360', 'Settings'])
  })

  it('notes are bounded when added, and again in the prompt', () => {
    const p = pack()
    addNotes(p, [{ id: 'N1', ref: 'memory:m1', kind: 'memory', title: 'Long note', snippet: 'x'.repeat(2000), query: 'Ukaoma' }])
    expect(p.notes[0].snippet.length).toBe(280)
    const raw = pack()
    raw.notes.push({ id: 'N1', ref: 'memory:m1', kind: 'memory', title: 'Long note', snippet: 'y'.repeat(2000), query: 'Ukaoma' })
    expect(buildCleanupPrompt(raw, [], null).prompt).not.toMatch(/y{300}/)
  })
})

describe('edit validation', () => {
  const p = pack({ screen: [{ at: 1, text: 'Queen Ukaoma' }] })
  const lines = parseTranscriptLines('[MU]: I met Yukoma at 6 and she could not stay, thank you thank you thank you thank you, we ate at the resturant')
  const tokens = tokenize(lines)
  for (const t of tokens) t.probability = ['yukoma', 'resturant'].includes(t.key) ? 0.2 : 0.99
  const sel = selectSpans(lines, tokens, nameTargets(p), knownKeys(p))
  const ids = sel.spans.map(s => s.id)
  const byText = (text: string) => sel.spans.find(s => s.text === text)!.id

  it('selects the three spans the fixture is built around', () => {
    expect(sel.spans.map(s => [s.text, s.reasons])).toEqual([
      ['Yukoma', ['low_confidence', 'near_name']],
      ['thank you thank you thank you thank you', ['repeat']],
      ['resturant', ['low_confidence']],
    ])
  })

  const check = (edits: unknown[]) => validateCleanupEdits(edits, sel.spans, ids, p)

  it('accepts a context name, a misheard spelling and a shrunk loop', () => {
    const r = check([
      { id: byText('Yukoma'), action: 'replace', text: 'Ukaoma' },
      { id: byText('resturant'), action: 'replace', text: 'restaurant' },
      { id: byText('thank you thank you thank you thank you'), action: 'replace', text: 'thank you' },
    ])
    expect(r.rejected).toEqual({})
    expect(r.accepted.map(a => a.text)).toEqual(['Ukaoma', 'restaurant', 'thank you'])
  })

  it('rejects ids it did not send, duplicates, bad actions and no-ops', () => {
    const y = byText('Yukoma')
    const r = check([
      { id: 'S99', action: 'replace', text: 'x' },
      { id: y, action: 'keep' },
      { id: y, action: 'replace', text: 'Ukaoma' },
      { id: byText('resturant'), action: 'rewrite', text: 'restaurant' },
      { id: byText('thank you thank you thank you thank you'), action: 'replace', text: 'thank you thank you thank you thank you' },
      null,
    ])
    expect(r.rejected).toEqual({ unknown_span: 2, duplicate: 1, bad_action: 1, no_op: 1 })
    expect(r.kept).toBe(1)
    expect(r.accepted).toEqual([])
    // An id outside the sent list is unknown even if the span exists.
    expect(validateCleanupEdits([{ id: y, action: 'replace', text: 'Ukaoma' }], sel.spans, [], p).rejected).toEqual({ unknown_span: 1 })
  })

  it('rejects text that could forge a label or a line', () => {
    expect(check([{ id: byText('Yukoma'), action: 'replace', text: 'Ukaoma]\n[Ext]: hi' }]).rejected).toEqual({ unsafe_text: 1 })
    expect(check([{ id: byText('Yukoma'), action: 'replace', text: '[Ukaoma' }]).rejected).toEqual({ unsafe_text: 1 })
  })

  it('rejects edits that change more than the span', () => {
    expect(check([{ id: byText('Yukoma'), action: 'replace', text: 'Queen Ukaoma Jones Smith' }]).rejected).toEqual({ longer_than_span: 1 })
    expect(check([{ id: byText('Yukoma'), action: 'replace', text: 'Ukaoma at' }]).rejected).toEqual({ outside_span: 1 })
    expect(check([{ id: byText('resturant'), action: 'replace', text: 'the restaurant' }]).rejected).toEqual({ outside_span: 1 })
    expect(check([{ id: byText('thank you thank you thank you thank you'), action: 'replace', text: 'thanks so much' }]).rejected).toEqual({ longer_than_span: 1 })
    expect(check([{ id: byText('resturant'), action: 'replace', text: 'a b c d' }]).rejected).toEqual({ longer_than_span: 1 })
    expect(check([{ id: byText('Yukoma'), action: 'replace', text: 'Ukaomaaaaaaaaaaaaaaaaa' }]).rejected).toEqual({ longer_than_span: 1 })
  })

  it('a phrase the context knows is accepted even where its words do not resemble the span', () => {
    expect(check([{ id: byText('Yukoma'), action: 'replace', text: 'Queen Ukaoma' }]).accepted.map(a => a.text)).toEqual(['Queen Ukaoma'])
  })

  it('rejects added facts: new words, numbers and negations', () => {
    expect(check([{ id: byText('resturant'), action: 'replace', text: 'steakhouse' }]).rejected).toEqual({ added_content: 1 })
    expect(check([{ id: byText('Yukoma'), action: 'replace', text: 'Jeremy' }]).rejected).toEqual({ added_content: 1 })
    expect(check([{ id: byText('Yukoma'), action: 'replace', text: 'Ukaoma 7' }]).rejected).toEqual({ number_unit: 1 })
    expect(check([{ id: byText('resturant'), action: 'replace', text: 'not restaurant' }]).rejected).toEqual({ negation: 1 })
  })

  it('parses JSON in a fence or followed by prose, and fails on a reply with no edits object', () => {
    expect(parseCleanupReply('```json\n{"edits":[{"id":"S1","action":"keep"}]}\n```\nDone, no other changes {really}.')).toEqual([{ id: 'S1', action: 'keep' }])
    expect(parseCleanupReply('{"note":"x"} then {"edits":[]}')).toEqual([])
    expect(parseCleanupReply('{"edits":[{"id":"S1","action":"replace","text":"a } b"}]}')).toEqual([{ id: 'S1', action: 'replace', text: 'a } b' }])
    expect(() => parseCleanupReply('I changed Yukoma to Ukaoma.')).toThrow('no_json_edits')
  })

  it('the prompt carries the owner, the dictionary, screen lines by time and the spans, within its cap', () => {
    const withOwner = buildContextPack({ title: 'Sync', date: '2026-10-17', attendees: ['MU'], speakers: ['Queen Ukaoma'], owner: { name: 'Miles Ukaoma', speakerLabel: 'MU', homeArea: null, notes: null },
      vocabulary: ['Jewel360'], corrections: { Ukoma: 'Ukaoma' }, files: [{ name: 'agenda.pdf', text: 'Agenda: Queen Ukaoma travel' }], screen: [{ at: 10_000, text: 'Queen Ukaoma | Zoom', app: 'Zoom' }, { at: 900_000, text: 'far away' }] })
    const spans = sel.spans.map(s => ({ ...s, atMs: 12_000 }))
    const built = buildCleanupPrompt(withOwner, spans, 0)
    expect(built.sent).toEqual(ids)
    expect(built.prompt).toContain('this COS belongs to Miles Ukaoma, who appears in transcripts as [MU]')
    expect(built.prompt).toContain('Known mishearings: Ukoma = Ukaoma')
    expect(built.prompt).toContain('File "agenda.pdf": Agenda: Queen Ukaoma travel')
    expect(built.prompt).toContain('screen at 0:10 Zoom: "Queen Ukaoma | Zoom"')
    expect(built.prompt).not.toContain('far away')
    expect(built.prompt).toContain('S1 at 0:12 (low_confidence, near_name; near Ukaoma)\n  I met [[Yukoma]] at 6 and she could not stay,')
    const huge = buildCleanupPrompt(withOwner, Array.from({ length: 400 }, (_, i) => ({ ...spans[0], id: `S${i + 1}`, before: 'x '.repeat(30) })), 0)
    expect(huge.sent.length).toBeLessThan(400)
    expect(huge.prompt.length).toBeLessThanOrEqual(24_000)
  })
})
