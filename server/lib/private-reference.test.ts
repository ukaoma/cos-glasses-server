import { describe, it, expect } from 'vitest'
import { privateReference } from './private-reference.js'
import { PRIVATE_QUERY, PRIVATE_QUERY_BARE, admitPublicTopic } from './meeting-public-topic.js'
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
  it('the live-cue deny list (denyWordHit) keeps the bare word: its queries are chosen by a model, so nothing the user typed vouches for them', () => {
    for (const t of ['private aviation accident rates', 'private equity returns', 'our private pricing', 'a private jet', 'private']) expect(denyWordHit(t), t).toBe(true)
    expect(denyWordHit('commercial aviation accident rates')).toBe(false)
    expect(PRIVATE_QUERY_BARE.test('private aviation')).toBe(true)
    expect(PRIVATE_QUERY_BARE.test('commercial aviation')).toBe(false)
  })
})

describe('B1: the bare word blocks; only a short list of public phrases is let through', () => {
  const BLOCKED = [
    'This stays private - is the Blackstone deal above the typical average?', 'private funding round from Blackstone', 'our private placement price', 'private offer from Shopify',
    "Acme's private valuation", 'private dinner with Jeremy', "Stephen's private plane crash rate", 'my private hospital stay', "pricing that's private",
    'a private matter', 'a private hospital stay', 'the private clinic visit', 'private health records', 'private company salaries at our firm', 'privately owned by Pete', 'privacy settings for our app',
  ]
  it.each(BLOCKED)('blocked: %s', text => {
    expect(privateReference(text), text).toBe(true)
    expect(PRIVATE_QUERY.test(text), text).toBe(true)
  })
  it.each([
    "Does private aviation safter or more dangerious than commercial? typical commercial", 'Is private aviation more dangerous than commercial?', 'Is it true that private planes crash more than airlines?',
    'private jets accident rate per flight hour', 'private pilot fatality rate', 'private equity returns vs the S&P', 'private school tuition trends', 'private sector job growth', 'private label market share',
    'private markets versus public markets', 'private companies in the US', 'private credit default rates', 'how many privately held firms are there', 'private jet charter prices',
  ])('let through: %s', text => {
    expect(privateReference(text), text).toBe(false)
  })
  it.each([
    "Stephen's private plane crash rate", 'private jets that our CEO owns', 'is my private jet safe', 'their private equity firm', "Pete's private school", 'private aviation, his plane, crash rate',
    'private equity returns, keep this between us', 'private plane crash rate (off the record)', 'private jets stay private for now', 'keep this private: private equity returns', 'we discussed private aviation in private.',
  ])('a public phrase still blocks with a possessive, a person or a privacy phrase: %s', text => {
    expect(privateReference(text), text).toBe(true)
  })
  it('a contraction is not a possessive, and "keep up with private aviation" is not a privacy phrase', () => {
    expect(privateReference("What's the crash rate of private aviation?")).toBe(false)
    expect(privateReference("It's said private jets crash more, is that right?")).toBe(false)
    expect(privateReference('keep up with private aviation news')).toBe(false)
    expect(privateReference('Is private aviation safe?')).toBe(false)                    // "is private" is not a clause-final privacy phrase
  })
  it('every probe is withheld by the Ask search gate, on the comparison path too, and Miles\'s question is admitted', () => {
    for (const q of BLOCKED.slice(0, 9)) {
      const question = /typical|average|more|than/i.test(q) ? q : `Compare ${q} to the typical average`
      const gate = publicSearchGate({ question, query: userWebQuery(question) ?? question })
      expect(gate.ok, question).toBe(false)
    }
    expect(publicSearchGate({ question: MILES, query: userWebQuery(MILES)! })).toMatchObject({ ok: true })
  })
  it('narrow health words are sensitive; death, fatal and crash are not (public safety statistics need them)', () => {
    for (const w of ['hospital', 'surgery', 'clinic', 'therapy', 'pregnant', 'pregnancy', 'fever']) {
      const q = `Compare the ${w} rate to the typical average`
      expect(publicSearchGate({ question: q, query: userWebQuery(q) ?? q }), w).toMatchObject({ ok: false, reason: 'personal' })
    }
    for (const q of ['Compare commercial aviation fatal accident rates to the typical average', 'Compare crash deaths per year to the typical average']) {
      expect(publicSearchGate({ question: q, query: userWebQuery(q) ?? q }), q).toMatchObject({ ok: true })
    }
  })
})
