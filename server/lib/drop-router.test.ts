import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildDropRequest, cleanDropForJev, createDropJevClient, decideDrop, dropDailyCap, dropRouterEnabled, DropRouter, jevOnlyDropClient, rankByOverlap, sharedDropDecisionClient,
  ruleRoute, type DropRequest, type RouteCandidates } from './drop-router.js'
import { type DecisionClient } from './decision-provider.js'
import { JevError } from './jev.js'
import { CARDS, DOMAINS, THREADS } from './__fixtures__/drop-fixtures.js'

const world: RouteCandidates = {
  domains: DOMAINS,
  cards: CARDS.slice(0, 3),
  threads: THREADS.slice(0, 2).map(t => ({ id: t.id, name: t.name })),
}
const req = (c: RouteCandidates = world): DropRequest => buildDropRequest('drop words', c)
const answer = (dest: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  dest: { probabilities: dest }, domain: { probabilities: { d0: 0.9, d1: 0.04, d2: 0.03, d3: 0.03 } },
  card: { probabilities: { c0: 0.9, c1: 0.04, c2: 0.03, none: 0.03 } }, thread: { probabilities: { h0: 0.9, h1: 0.05, none: 0.05 } },
  clear: { noul: 0.8 }, ...extra,
})

describe('rule routes (no Jev call)', () => {
  it.each([
    ['remind me Thursday to send the numbers', 'reminder'], ['Please remind me to call the bank', 'reminder'],
    ['remember the Tulsa store prefers email', 'memory'], ['Remember: coffee black', 'memory'],
    ['what did we decide?', 'ask'], ['How many leads came in', 'ask'], ['Is the deck ready?', 'ask'],
    ['who owns the pricing sheet', 'ask'], ['remind me what we decided?', 'reminder'],
    ['Draft the onboarding email', null], ['the remember-me checkbox is broken', null], ['somehow the deck slipped', null],
  ])('%s', (text, expected) => expect(ruleRoute(text)).toBe(expected))
})

describe('what Jev reads', () => {
  it('removes URLs, emails and opaque ids without tripping', () => {
    const out = cleanDropForJev('Send gina@example.com the deck at https://docs.example.com/d/abc123 ref a1b2c3d4e5f6a7b8c9d0e1f2a3')
    expect(out.tripped).toBe(false)
    expect(out.text).not.toMatch(/example|https|a1b2c3/)
  })
  it('trips on a credential, so the drop is never sent', () => {
    expect(cleanDropForJev('use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH for the test').tripped).toBe(true)
  })
  it('offers only cards and threads sharing a word with the drop', () => {
    expect(rankByOverlap('kickoff agenda', CARDS, c => c.text, 30).map(c => c.text)).toEqual(['Build the kickoff deck outline'])
    expect(rankByOverlap('the and for', CARDS, c => c.text, 30)).toEqual([])
  })
  it('asks only the questions that have something to choose', () => {
    const bare = buildDropRequest('x', { domains: [DOMAINS[0]], cards: [], threads: [] })
    expect(Object.keys(bare.questions).sort()).toEqual(['clear', 'dest'])
    expect(Object.keys(bare.questions.dest.criteria!).sort()).toEqual(['memory', 'new_card', 'note'])
    const full = buildDropRequest('x', { ...world, session: { id: 's1', label: 'Slides' } })
    expect(Object.keys(full.questions).sort()).toEqual(['card', 'clear', 'dest', 'domain', 'session', 'thread'])
    expect(full.questions.card.criteria!.none).toBeDefined()
  })
})

describe('thresholds', () => {
  it('files at 0.80 with a 0.25 lead and a sure target', () => {
    const d = decideDrop(answer({ new_card: 0.8, existing_card: 0.05, thread: 0.05, memory: 0.05, note: 0.05 }), req())
    expect(d).toMatchObject({ kind: 'file', dest: 'new_card', target: { domain: 'work' } })
  })
  it('asks below 0.80', () => {
    const d = decideDrop(answer({ new_card: 0.79, existing_card: 0.01, thread: 0.1, memory: 0.05, note: 0.05 }), req())
    expect(d.kind).toBe('ask')
  })
  it('asks when the lead is under 0.25', () => {
    const r = req({ ...world, threads: [] })
    const d = decideDrop(answer({ new_card: 0.81, existing_card: 0.0, memory: 0.0, note: 0.19 }, { thread: undefined }), r)
    expect(d.kind).toBe('file')
    const close = decideDrop({ ...answer({ new_card: 0.6, existing_card: 0.4 }), dest: { probabilities: { new_card: 0.8, existing_card: 0.56, memory: 0, note: 0 } } } as never, r)
    expect(close.kind).toBe('ask')
  })
  it('needs 0.90 for a memory', () => {
    expect(decideDrop(answer({ memory: 0.89, note: 0.11 }), req()).kind).toBe('ask')
    expect(decideDrop(answer({ memory: 0.9, note: 0.1 }), req())).toMatchObject({ kind: 'file', dest: 'memory' })
  })
  it('asks when the destination is sure but its card is not', () => {
    const d = decideDrop(answer({ existing_card: 0.9, note: 0.1 }, { card: { probabilities: { c0: 0.79, c1: 0.11, c2: 0.05, none: 0.05 } } }), req())
    expect(d.kind).toBe('ask')
    if (d.kind === 'ask') expect(d.choices.map(c => c.dest)).toEqual(['existing_card', 'note'])
  })
  it('asks when the domain of a new card is unsure', () => {
    const d = decideDrop(answer({ new_card: 0.95, note: 0.05 }, { domain: { probabilities: { d0: 0.5, d1: 0.5, d2: 0, d3: 0 } } }), req())
    expect(d.kind).toBe('ask')
  })
  it('a sure note is filed as a note; an unsure one with no other reading is a note too', () => {
    expect(decideDrop(answer({ note: 0.9, new_card: 0.1 }), req())).toMatchObject({ kind: 'file', dest: 'note' })
  })
  it('offers at most two readings plus Just a note, with targets', () => {
    const d = decideDrop(answer({ new_card: 0.4, thread: 0.35, existing_card: 0.2, note: 0.05 }), req())
    expect(d.kind).toBe('ask')
    if (d.kind !== 'ask') return
    expect(d.choices.map(c => c.dest)).toEqual(['new_card', 'thread', 'note'])
    expect(d.choices[1].target).toMatchObject({ id: THREADS[0].id })
    expect(d.choices[2].label).toBe('Just a note')
  })
  it('refuses an answer with no destination', () => {
    expect(() => decideDrop({ dest: { probabilities: {} } }, req())).toThrow(JevError)
  })
})

describe('DropRouter', () => {
  const fixed: DecisionClient = { provider: 'jev', ask: vi.fn(async () => ({ provider: 'jev' as const, answers: answer({ new_card: 0.9, note: 0.1 }), inputTokens: 512 })) }

  it('makes no call when COS_DROP_ROUTER is off', async () => {
    const ask = vi.fn()
    const out = await new DropRouter({ client: { ask }, enabled: () => false }).route('Draft the email', world)
    expect(out).toEqual({ by: 'fallback', reason: 'router_off' })
    expect(ask).not.toHaveBeenCalled()
  })
  it('makes no call for a drop that trips the redactor', async () => {
    const ask = vi.fn()
    const out = await new DropRouter({ client: { ask }, enabled: () => true }).route('token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH', world)
    expect(out).toEqual({ by: 'fallback', reason: 'redacted' })
    expect(ask).not.toHaveBeenCalled()
  })
  it('turns Jev failures into a reason, never a throw', async () => {
    for (const code of ['jev_not_configured', 'jev_cap_reached', 'jev_breaker_open', 'jev_key_rejected', 'jev_request_rejected'] as const) {
      const out = await new DropRouter({ client: { ask: async () => { throw new JevError(code) } }, enabled: () => true }).route('Draft the email', world)
      expect(out).toEqual({ by: 'fallback', reason: code })
    }
    const down = await new DropRouter({ client: { ask: async () => { throw new JevError('jev_unavailable') } }, enabled: () => true }).route('Draft it', world)
    expect(down).toEqual({ by: 'fallback', reason: 'jev_unavailable' })
  })
  it('audits sizes and timing only', async () => {
    const audit = vi.fn()
    const out = await new DropRouter({ client: fixed, enabled: () => true, audit }).route('Draft the onboarding email', world)
    expect(out).toMatchObject({ by: 'jev', tokens: 512, decision: { kind: 'file', dest: 'new_card' } })
    expect(audit).toHaveBeenCalledOnce()
    expect(JSON.stringify(audit.mock.calls[0][0])).not.toMatch(/onboarding/)
  })
  it('sends Jev the cleaned words, not the raw ones', async () => {
    const ask = vi.fn(async () => ({ answers: answer({ note: 0.9, new_card: 0.1 }), inputTokens: 10 }))
    await new DropRouter({ client: { ask }, enabled: () => true }).route('Mail ana@example.com about https://x.example.com/a', world)
    expect(JSON.stringify(ask.mock.calls[0])).not.toMatch(/example/)
  })
})

describe('switch and cap', () => {
  it('reads COS_DROP_ROUTER and COS_DROP_DAILY_TOKENS', () => {
    expect(dropRouterEnabled({})).toBe(true)
    for (const off of ['0', 'false', 'no', 'off', ' OFF ']) expect(dropRouterEnabled({ COS_DROP_ROUTER: off })).toBe(false)
    expect(dropDailyCap({})).toBe(300_000)
    expect(dropDailyCap({ COS_DROP_DAILY_TOKENS: '1000' })).toBe(1000)
    expect(dropDailyCap({ COS_DROP_DAILY_TOKENS: 'nope' })).toBe(300_000)
  })
  it('a drop client with its own ledger stops at its cap before any request', async () => {
    const fetchImpl = vi.fn()
    const prior = process.env.COS_DROP_DAILY_TOKENS, priorKey = process.env.TYPESAFE_API_KEY
    process.env.COS_DROP_DAILY_TOKENS = '1'; process.env.TYPESAFE_API_KEY = 'test-key-not-real'
    try {
      const ledger = join(mkdtempSync(join(tmpdir(), 'drop-ledger-')), 'jev-drop-usage.json')
      const client = jevOnlyDropClient(createDropJevClient(fetchImpl as never, () => new Date(), ledger))
      const out = await new DropRouter({ client, enabled: () => true }).route('Draft the onboarding email', world)
      expect(out).toEqual({ by: 'fallback', reason: 'jev_cap_reached' })
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      if (prior === undefined) delete process.env.COS_DROP_DAILY_TOKENS; else process.env.COS_DROP_DAILY_TOKENS = prior
      if (priorKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = priorKey
    }
  })
})

describe('pinned to Jev', () => {
  it('the shared drop client is Jev whatever the decision provider setting says', async () => {
    const prior = process.env.COS_DECISION_PROVIDER
    process.env.COS_DECISION_PROVIDER = 'subq'
    try { expect(sharedDropDecisionClient().provider).toBe('jev') } finally {
      if (prior === undefined) delete process.env.COS_DECISION_PROVIDER; else process.env.COS_DECISION_PROVIDER = prior
    }
  })
  it('passes through to Jev and refuses images', async () => {
    const ask = vi.fn(async () => ({ answers: {}, inputTokens: 3 }))
    const client = jevOnlyDropClient({ ask })
    expect(await client.ask({}, {}, 1)).toMatchObject({ provider: 'jev', inputTokens: 3 })
    await expect(client.ask({}, {}, 1, { images: [{ mediaType: 'image/png', base64: 'AA==' }] })).rejects.toMatchObject({ code: 'decision_images_unsupported' })
  })
})
