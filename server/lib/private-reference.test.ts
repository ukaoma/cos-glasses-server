import { describe, it, expect } from 'vitest'
import { privateReference } from './private-reference.js'
import { PRIVATE_QUERY, admitPublicTopic } from './meeting-public-topic.js'
import { publicSearchGate, publicResourceRequest, userWebQuery } from './meeting-ask-web.js'
import { denyWordHit } from './live-cues-general-topic.js'

const MILES = 'Does private aviation safter or more dangerious than commercial? typical commercial'

describe('private as a privacy reference, not an adjective', () => {
  it.each([
    MILES, 'private jet crash rate vs commercial', 'private equity returns vs S&P', 'Is private school worth it compared to public', 'private label vs brand name prices',
    'how many privately held companies are in the US', 'a private plane versus an airline', 'private aviation', 'what does a private company have to disclose', 'private sector wages compared to public sector',
    'the private jet market', 'private equity firms in private markets', 'taking a flight in private aviation',
  ])('public subject, not a reference: %s', text => {
    expect(privateReference(text)).toBe(false)
    expect(PRIVATE_QUERY.test(text)).toBe(false)
  })
  it.each([
    'my private notes', 'the private conversation we had', 'keep this private', 'our private pricing', 'private beta of our app',
    'in private', 'We talked in private and then left', 'keep it private', 'keep that strictly private', 'he privately told me', 'she privately shared the number',
    'the private info', 'private data', 'a private message from Jo', 'private details about the deal', 'my private account', 'the private repo', 'our private channel', 'private budget', 'this is private.', 'that\'s private',
    'private contract terms', 'private meeting notes',
  ])('a privacy reference: %s', text => {
    expect(privateReference(text)).toBe(true)
    expect(PRIVATE_QUERY.test(text)).toBe(true)
  })
  it('the other private words still block, with or without the word private', () => {
    for (const t of ['our client list', 'the employee handbook', 'her birthday', 'my wife', 'a medical diagnosis', 'the internal roadmap']) expect(PRIVATE_QUERY.test(t), t).toBe(true)
  })
})

describe('every site that read the bare word uses the helper', () => {
  it('the Ask search gate (PRIVATE_COST): Miles\'s question is admitted; privacy references are still withheld', () => {
    const query = userWebQuery(MILES)!
    expect(query).toContain('private aviation')
    expect(publicSearchGate({ question: MILES, query })).toMatchObject({ ok: true })
    expect(publicSearchGate({ question: 'private jet crash rate vs commercial, compare the typical average', query: 'private jet crash rate vs commercial compare typical average' })).toMatchObject({ ok: true })
    expect(publicSearchGate({ question: 'Compare private equity returns to the S&P average', query: 'private equity returns S&P average' })).toMatchObject({ ok: true })
    for (const q of ['Compare our private pricing to the typical average', 'Compare my private notes to the average cost', 'Is the private beta of our app more expensive than the typical', 'Keep this private: is it more than average']) {
      expect(publicSearchGate({ question: q, query: userWebQuery(q) ?? q }), q).toMatchObject({ ok: false, reason: 'personal' })
    }
  })
  it('the public-resource request check', () => {
    expect(publicResourceRequest('find the application for the private school')).toBe(true)
    expect(publicResourceRequest('find the private file link')).toBe(false)
    expect(publicResourceRequest('give me our private notes docs link')).toBe(false)
  })
  it('the public-topic admission (PRIVATE_QUERY on the question, the query and the turns)', () => {
    const input = { question: 'Fact check: is private aviation more dangerous than commercial on average?', action: 'ask' as const, sessionId: 's', elapsedMs: 60_000, turns: [{ id: 1, elapsedMs: 50_000, speaker: 'Speaker 2', text: 'Private planes crash at a far higher rate than airlines.' }] } as any
    const raw = { publicTopic: true, category: 'public_news', query: 'private aviation commercial accident rate average', evidenceTurnIds: [1] }
    expect(admitPublicTopic(raw, input)).not.toBeNull()
    const privateTurn = { ...input, turns: [{ ...input.turns[0], text: 'Keep this private, but private planes crash more.' }] }
    expect(admitPublicTopic(raw, privateTurn)).toBeNull()
    expect(admitPublicTopic({ ...raw, query: 'my private notes accident rate average' }, input)).toBeNull()
  })
  it('the live-cue deny list (denyWordHit) lets a public subject through and keeps a privacy reference out', () => {
    expect(denyWordHit('private aviation accident rates')).toBe(false)
    expect(denyWordHit('private equity returns')).toBe(false)
    expect(denyWordHit('our private pricing')).toBe(true)
  })
})
