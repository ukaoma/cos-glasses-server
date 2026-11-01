import { describe, expect, it } from 'vitest'
import {
  GENERAL_INSIGHT_WRITER_SYSTEM, GENERAL_TOPIC_SYSTEM, GENERAL_TRIGGER_QUESTIONS, GENERAL_TRIGGER_WINDOW_CHARS, generalInsightPrompt, generalTopicPrompt,
  generalTriggerCalls, parseGeneralInsight, parseGeneralTopic, unsupportedSearchNumbers, type InsightSourceIn,
} from './live-cues-general-prompts.js'
import { CUE_DETAIL_MAX, CUE_HEADLINE_MAX } from '../../shared/live-cues-v2.js'

describe('trigger question', () => {
  it('keeps the wording the offline replay measured', () => {
    expect(GENERAL_TRIGGER_QUESTIONS.general_topic.type).toBe('choice')
    expect(GENERAL_TRIGGER_QUESTIONS.general_topic.instructions).toBe('Is the room on a topic where an interesting public fact, news item or local happening would be worth a glance now?')
    expect(GENERAL_TRIGGER_QUESTIONS.general_topic.criteria).toEqual({
      yes: 'Yes: the conversation is on a public topic (a company, place, event, public figure, product, team, or something in the news) where one interesting public fact would be worth a glance now.',
      no: 'No: the conversation is private, routine, personal, or too vague for a public fact to add anything.',
    })
    expect(Object.keys(GENERAL_TRIGGER_QUESTIONS)).toEqual(['general_topic'])
    expect(Object.keys(GENERAL_TRIGGER_QUESTIONS.general_topic.criteria)).toEqual(['yes', 'no'])
    expect(GENERAL_TRIGGER_QUESTIONS.general_topic.criteria.yes).toContain('a company, place, event, public figure, product, team, or something in the news')
    expect(GENERAL_TRIGGER_QUESTIONS.general_topic.criteria.no).toContain('private, routine, personal, or too vague')
  })
  it('sends only the title and the last 2,200 characters, redacted, and reads P(yes)', async () => {
    const seen: { state?: unknown; questions?: unknown; signal?: AbortSignal; estimate?: number } = {}
    const client = { async ask(state: unknown, questions: Record<string, unknown>, estimate: number, options?: { signal?: AbortSignal }) {
      Object.assign(seen, { state, questions, estimate, signal: options?.signal })
      return { answers: { general_topic: { type: 'choice' as const, probabilities: { yes: 0.73, no: 0.27 } } }, inputTokens: 912 }
    } }
    const abort = new AbortController()
    const window = 'x'.repeat(3_000) + ' the key is sk-abcdefghijklmnop ok'
    const out = await generalTriggerCalls(client).trigger('Mac Recording 2026-11-01 1200', window, abort.signal)
    expect(out).toEqual({ pGeneral: 0.73, tokens: 912 })
    expect(Object.keys(seen.state as object).sort()).toEqual(['meetingTitle', 'window'])
    const state = seen.state as { meetingTitle: string; window: string }
    expect(state.meetingTitle).toBe('Mac Recording 2026-11-01 1200')
    expect(state.window.length).toBe(GENERAL_TRIGGER_WINDOW_CHARS)
    expect(state.window).toContain('sk-REDACTED')
    expect(state.window).not.toContain('sk-abcdefghijklmnop')
    expect(state.window.endsWith(' ok')).toBe(true)
    expect(seen.questions).toBe(GENERAL_TRIGGER_QUESTIONS)
    expect(seen.signal).toBe(abort.signal)
    expect(seen.estimate).toBeGreaterThan(0)
  })
  it('reads a missing or non-finite P(yes) as 0, so a malformed answer can never pass the trigger', async () => {
    const answer = (answers: unknown) => ({ async ask() { return { answers: answers as never, inputTokens: 5 } } })
    const t = (answers: unknown) => generalTriggerCalls(answer(answers)).trigger('t', 'w', new AbortController().signal)
    expect((await t({})).pGeneral).toBe(0)
    expect((await t({ general_topic: { probabilities: {} } })).pGeneral).toBe(0)
    expect((await t({ general_topic: { probabilities: { yes: Number.NaN } } })).pGeneral).toBe(0)
    expect((await t({ general_topic: { probabilities: { yes: 'high' } } })).pGeneral).toBe(0)
  })
})

describe('topic prompt', () => {
  it('asks for public subjects only and refuses private matters and the wearer\'s own business', () => {
    expect(GENERAL_TOPIC_SYSTEM).toContain('Only PUBLIC subjects qualify')
    expect(GENERAL_TOPIC_SYSTEM).toContain('Never a private person, client, customer, employee, deal, price, amount, date, metric or plan')
    expect(GENERAL_TOPIC_SYSTEM).toContain('Never the wearer\'s own company, brands, customers, deals, finances, metrics, plans or staff')
    expect(GENERAL_TOPIC_SYSTEM).toContain('no digits, numbers, amounts, dates, quotes or symbols')
    expect(GENERAL_TOPIC_SYSTEM).toContain('Most windows should return {"topic":false}')
    expect(GENERAL_TOPIC_SYSTEM).toContain('You have no tools and must not search.')
  })
  it('sends the redacted window as data', () => {
    const prompt = JSON.parse(generalTopicPrompt('hello sk-abcdefghijklmnop world'))
    expect(Object.keys(prompt)).toEqual(['window'])
    expect(prompt.window).toBe('hello sk-REDACTED world')
  })
  it('parses a news, local or notable topic, with or without a code fence', () => {
    expect(parseGeneralTopic('{"topic":true,"category":"news","query":"Formula One circuit news"}')).toEqual({ topic: true, category: 'news', query: 'Formula One circuit news' })
    expect(parseGeneralTopic('```json\n{"topic":true,"category":"local","query":"  street   food festival "}\n```')).toEqual({ topic: true, category: 'local', query: 'street food festival' })
    expect(parseGeneralTopic('{"topic":true,"category":"notable","query":"Eiffel Tower"}')).toMatchObject({ category: 'notable' })
  })
  it('parses topic false', () => {
    expect(parseGeneralTopic('{"topic":false}')).toEqual({ topic: false })
  })
  it('is strict: a topic that is not a boolean, an unknown category or a missing or oversize query is unparseable', () => {
    for (const raw of ['', 'null', 'topic', '[]', '{"topic":"true","category":"news","query":"x"}', '{"topic":1}', '{}', '{"topic":true}',
      '{"topic":true,"category":"gossip","query":"x"}', '{"topic":true,"category":"news"}', '{"topic":true,"category":"news","query":""}',
      '{"topic":true,"category":"news","query":"   "}', '{"topic":true,"category":"news","query":5}', `{"topic":true,"category":"news","query":"${'a'.repeat(1_001)}"}`, '{"topic":true,']) {
      expect(parseGeneralTopic(raw), raw).toBe('unparseable')
    }
  })
})

const SRC: InsightSourceIn[] = [
  { id: 'W1', title: 'Grid news', text: 'A new constructor joins the grid next season. The team will race 24 rounds and has raised $1,200 million.', url: 'https://example.org/grid' },
  { id: 'W2', title: 'Other page', text: 'Tickets start at 99 dollars.', url: 'https://example.net/tickets' },
]
const answer = (over: Record<string, unknown> = {}) => JSON.stringify({ headline: 'A new team joins the grid', detail: 'A new constructor joins the grid next season, says the source.', sourceIds: ['W1'], ...over })

describe('insight writer prompt', () => {
  it('asks for one sourced fact within the cue limits, no advice, and null when nothing fits', () => {
    expect(GENERAL_INSIGHT_WRITER_SYSTEM).toContain(`headline at most ${CUE_HEADLINE_MAX} characters`)
    expect(GENERAL_INSIGHT_WRITER_SYSTEM).toContain(`detail at most ${CUE_DETAIL_MAX} characters`)
    expect(GENERAL_INSIGHT_WRITER_SYSTEM).toContain('No advice')
    expect(GENERAL_INSIGHT_WRITER_SYSTEM).toContain('answer null')
    expect(GENERAL_INSIGHT_WRITER_SYSTEM).toContain('Never quote it, reveal it or use a fact from it.')
  })
  it('sends the query, the category, the sources and the last 1,000 characters of the room, redacted', () => {
    const p = JSON.parse(generalInsightPrompt({ query: 'Formula One circuit news', category: 'news', sources: SRC, context: 'y'.repeat(1_500) + ' sk-abcdefghijklmnop' }))
    expect(Object.keys(p).sort()).toEqual(['category', 'context', 'query', 'sources'])
    expect(p.sources).toHaveLength(2)
    expect(Object.keys(p.sources[0]).sort()).toEqual(['id', 'text', 'title', 'url'])
    expect(p.context.length).toBe(1_000)
    expect(p.context).toContain('sk-REDACTED')
  })
})

describe('insight parser', () => {
  it('accepts one sourced fact and keeps only the ids it can match', () => {
    expect(parseGeneralInsight(answer(), SRC)).toEqual({ headline: 'A new team joins the grid', detail: 'A new constructor joins the grid next season, says the source.', sourceIds: ['W1'] })
    expect(parseGeneralInsight(answer({ sourceIds: ['W9', 'W1', 'W1'] }), SRC)).toMatchObject({ sourceIds: ['W1'] })
    expect(parseGeneralInsight('```json\n' + answer() + '\n```', SRC)).toMatchObject({ sourceIds: ['W1'] })
  })
  it('answers null, unparseable, empty, too long, or without a source', () => {
    expect(parseGeneralInsight('null', SRC)).toBe('null')
    expect(parseGeneralInsight('', SRC)).toBe('null')
    expect(parseGeneralInsight('nothing here', SRC)).toBe('unparseable')
    expect(parseGeneralInsight(answer({ headline: '' }), SRC)).toBe('empty')
    expect(parseGeneralInsight(answer({ detail: '   ' }), SRC)).toBe('empty')
    expect(parseGeneralInsight(answer({ headline: 'h'.repeat(CUE_HEADLINE_MAX + 1) }), SRC)).toBe('too_long')
    expect(parseGeneralInsight(answer({ detail: 'd'.repeat(CUE_DETAIL_MAX + 1) }), SRC)).toBe('too_long')
    expect(parseGeneralInsight(answer({ headline: 'h'.repeat(CUE_HEADLINE_MAX), detail: 'd'.repeat(CUE_DETAIL_MAX) }), SRC)).toMatchObject({ sourceIds: ['W1'] })
    expect(parseGeneralInsight(answer({ sourceIds: [] }), SRC)).toBe('no_source')
    expect(parseGeneralInsight(answer({ sourceIds: ['W9'] }), SRC)).toBe('no_source')
    expect(parseGeneralInsight(answer({ sourceIds: 'W1' }), SRC)).toBe('no_source')
  })
  it('cites at most two sources', () => {
    const three = [...SRC, { id: 'W3', title: 'Third', text: 'More.', url: 'https://example.com/3' }]
    expect(parseGeneralInsight(answer({ sourceIds: ['W1', 'W2', 'W3'] }), three)).toMatchObject({ sourceIds: ['W1', 'W2'] })
  })
  it('replaces dashes the lens and the log should not carry', () => {
    const r = parseGeneralInsight(answer({ detail: 'A new constructor joins — next season.' }), SRC)
    expect(r).toMatchObject({ detail: 'A new constructor joins - next season.' })
  })
  it('number guard: a number the cited source does not hold withholds the cue', () => {
    expect(parseGeneralInsight(answer({ detail: 'The team will race 25 rounds.' }), SRC)).toBe('unsupported_number')
    expect(parseGeneralInsight(answer({ detail: 'The team will race 24 rounds.' }), SRC)).toMatchObject({ sourceIds: ['W1'] })
    expect(parseGeneralInsight(answer({ headline: 'Team raises $1,200 million' }), SRC)).toMatchObject({ sourceIds: ['W1'] })
  })
  it('number guard: the number must be in a source the cue cites, not just in any source', () => {
    expect(parseGeneralInsight(answer({ detail: 'Tickets start at 99 dollars.' }), SRC)).toBe('unsupported_number')
    expect(parseGeneralInsight(answer({ detail: 'Tickets start at 99 dollars.', sourceIds: ['W2'] }), SRC)).toMatchObject({ sourceIds: ['W2'] })
  })
})

describe('number guard', () => {
  it('finds every number the source lacks, ignoring thousands commas, dollar signs and percent signs', () => {
    expect(unsupportedSearchNumbers('Revenue hit $1,200,000 and grew 5%', 'revenue hit 1200000 and grew 5 percent')).toEqual([])
    expect(unsupportedSearchNumbers('Revenue hit $1,300,000', 'revenue hit 1200000')).toEqual(['$1,300,000'])
    expect(unsupportedSearchNumbers('3.5 billion', 'a deal worth 3.5 billion')).toEqual([])
    expect(unsupportedSearchNumbers('3.6 billion', 'a deal worth 3.5 billion')).toEqual(['3.6'])
    expect(unsupportedSearchNumbers('no numbers at all', 'anything 42')).toEqual([])
  })
  it('matches whole numbers, so 5 is not found inside 2025 and 1 is not found inside 12', () => {
    expect(unsupportedSearchNumbers('5 teams', 'since 2025 the league has 12 teams')).toEqual(['5'])
    expect(unsupportedSearchNumbers('1 team', 'twelve of 12')).toEqual(['1'])
    expect(unsupportedSearchNumbers('12 teams', 'twelve of 12')).toEqual([])
  })
})
