import { describe, expect, it, vi } from 'vitest'
import { DecisionProviderError, type DecisionClient, type DecisionProvider } from './decision-provider.js'
import {
  FIND_CHOICE_OPTIONS, FIND_MAX_ROWS, FIND_NONE_ABSTAIN, FIND_RERANK_TOP, FIND_TUNING, SessionFindAsker, collapseIdentical, parseChoice, strengthFor, type AskCandidate,
} from './session-find-ask.js'

const cand = (n: number, option = `session ${n} about topic ${n}`, clockMs = 1_000_000 - n): AskCandidate => ({ key: `claude:s${n}`, option, clockMs })
const many = (from: number, count: number) => Array.from({ length: count }, (_, i) => cand(from + i))

interface Script {
  provider?: DecisionProvider
  /** probability of each option text in a Choice (by text); the rest share what is left, `none` takes the remainder */
  choice?: (options: string[]) => { byOption?: Record<string, number>; none?: number }
  noul?: (text: string) => number
}
function fake(script: Script = {}) {
  const calls: Array<{ kind: 'choice' | 'noul'; options?: string[]; texts?: string[]; query: string; estimate: number }> = []
  const client: DecisionClient = {
    provider: script.provider ?? 'jev',
    async ask(state, questions, estimate) {
      const query = (state as { query: string }).query
      const q = questions as Record<string, { type: string; criteria?: Record<string, string>; instructions: string }>
      if (q.c) {
        const options = Object.entries(q.c.criteria!).filter(([k]) => k !== 'none').map(([, v]) => v)
        calls.push({ kind: 'choice', options, query, estimate })
        const { byOption = {}, none = 0 } = script.choice?.(options) ?? {}
        const labels = Object.keys(q.c.criteria!)
        const probabilities: Record<string, number> = {}
        let used = none
        labels.forEach(label => {
          if (label === 'none') return
          const p = byOption[q.c!.criteria![label]!] ?? 0
          probabilities[label] = p
          used += p
        })
        probabilities.none = none + Math.max(0, 1 - used)
        return { provider: script.provider ?? 'jev', answers: { c: { type: 'choice', probabilities, choice: 'none', confidence: 0.9 } }, inputTokens: 1000 + options.length }
      }
      const texts = Object.values(q).map(x => x.instructions)
      calls.push({ kind: 'noul', texts, query, estimate })
      const answers: Record<string, { type: 'noul'; noul: number }> = {}
      Object.entries(q).forEach(([name, spec]) => { answers[name] = { type: 'noul', noul: script.noul?.(spec.instructions) ?? 0 } })
      return { provider: script.provider ?? 'jev', answers, inputTokens: 100 * texts.length }
    },
  }
  return { client, calls, choices: () => calls.filter(c => c.kind === 'choice'), reranks: () => calls.filter(c => c.kind === 'noul') }
}
const run = (asker: SessionFindAsker, f: ReturnType<typeof fake>, input: { first: AskCandidate[]; second?: AskCandidate[]; stage?: 'first' | 'full'; query?: string; shouldStop?: () => boolean; chunkSize?: number }) =>
  asker.ask({ client: f.client, query: input.query ?? 'find the thing', stage: input.stage ?? 'first', first: input.first, second: vi.fn(async () => input.second ?? []), shouldStop: input.shouldStop, chunkSize: input.chunkSize })

describe('one Choice, then the yes/no view', () => {
  it('asks the newest sessions as one Choice and the top of it as independent yes/no questions, then orders rows by the yes/no answers', async () => {
    const first = many(0, 30)
    const f = fake({ choice: () => ({ byOption: { [first[3]!.option]: 0.55, [first[7]!.option]: 0.3 } }), noul: text => text.includes('topic 7') ? 0.9 : text.includes('topic 3') ? 0.7 : 0.02 })
    const out = await run(new SessionFindAsker(), f, { first })
    expect(f.choices()).toHaveLength(1)
    expect(f.choices()[0]!.options).toHaveLength(30)
    expect(f.reranks()).toHaveLength(1)
    expect(f.reranks()[0]!.texts!.length).toBeLessThanOrEqual(FIND_RERANK_TOP)
    expect(out.rows.map(r => [r.key, r.strength])).toEqual([['claude:s7', 'strong'], ['claude:s3', 'strong']])
    expect(out.verdict).toBe('rows')
    expect(out.modelCalls).toBe(2)
    expect(out.cached).toBe(false)
    expect(out.asked).toHaveLength(30)
  })

  it('does not call a second request for stage first, however weak the first answer is', async () => {
    const f = fake({ choice: () => ({ byOption: {} }) })
    const second = vi.fn(async () => many(300, 10))
    await new SessionFindAsker().ask({ client: f.client, query: 'q one', stage: 'first', first: many(0, 5), second })
    expect(second).not.toHaveBeenCalled()
    expect(f.choices()).toHaveLength(1)
  })

  it('asks at most 254 options in a request, however many are offered', async () => {
    const f = fake({ choice: () => ({ byOption: {} }) })
    const out = await run(new SessionFindAsker(), f, { first: many(0, 400) })
    expect(f.choices()[0]!.options).toHaveLength(FIND_CHOICE_OPTIONS)
    expect(out.asked).toHaveLength(FIND_CHOICE_OPTIONS)
  })

  it('asks the yes/no question about at most 12 sessions', async () => {
    const first = many(0, 20)
    const f = fake({ choice: () => ({ byOption: Object.fromEntries(first.map(c => [c.option, 0.04])) }), noul: () => 0.5 })
    await run(new SessionFindAsker(), f, { first })
    expect(f.reranks()[0]!.texts).toHaveLength(FIND_RERANK_TOP)
  })

  it('shows at most 5 rows even when more clear the floor', async () => {
    const first = many(0, 12)
    const f = fake({ choice: () => ({ byOption: Object.fromEntries(first.map(c => [c.option, 0.08])) }), noul: () => 0.9 })
    const out = await run(new SessionFindAsker(), f, { first })
    expect(out.rows).toHaveLength(FIND_MAX_ROWS)
  })

  it('shows nothing when the yes/no answers are all under the floor, and says why', async () => {
    const first = many(0, 12)
    const f = fake({ choice: () => ({ byOption: { [first[0]!.option]: 0.3 } }), noul: () => FIND_TUNING.jev.floor - 0.01 })
    const out = await run(new SessionFindAsker(), f, { first })
    expect(out.rows).toEqual([])
    expect(out.verdict).toBe('below_floor')
  })

  it('spends nothing on a yes/no round when no session reaches the pre-floor', async () => {
    const first = many(0, 30)
    const f = fake({ choice: () => ({ byOption: Object.fromEntries(first.map(c => [c.option, FIND_TUNING.jev.rerankMinRaw - 0.005])) }) })
    const out = await run(new SessionFindAsker(), f, { first })
    expect(out.noneMin).toBeLessThan(FIND_NONE_ABSTAIN)
    expect(f.reranks()).toHaveLength(0)
    expect(out.verdict).toBe('below_floor')
  })

  it('bands the yes/no probability into strong, likely and possible', () => {
    const t = FIND_TUNING.jev
    expect(strengthFor(t, t.strong)).toBe('strong')
    expect(strengthFor(t, t.strong - 0.001)).toBe('likely')
    expect(strengthFor(t, t.likely)).toBe('likely')
    expect(strengthFor(t, t.likely - 0.001)).toBe('possible')
    expect(t.floor).toBeLessThan(t.likely)
    expect(t.likely).toBeLessThan(t.strong)
  })

  it('uses the Choice probabilities as they are when the provider is Choice-only', async () => {
    const tuning = FIND_TUNING.subq
    const original = { ...tuning }
    try {
      tuning.rerank = false
      const first = many(0, 8)
      const f = fake({ provider: 'subq', choice: () => ({ byOption: { [first[2]!.option]: 0.9, [first[5]!.option]: tuning.floor - 0.05 } }) })
      const out = await run(new SessionFindAsker(), f, { first })
      expect(f.reranks()).toHaveLength(0)
      expect(out.rows.map(r => r.key)).toEqual(['claude:s2'])
      expect(out.rows[0]!.strength).toBe('strong')
    } finally { Object.assign(tuning, original) }
  })
})

describe('the second request and the none rule', () => {
  it('asks for older sessions only at stage full, and only when the top row of the first is not already strong', async () => {
    const first = many(0, 20), second = many(100, 20)
    const strong = fake({ choice: () => ({ byOption: { [first[1]!.option]: FIND_TUNING.jev.skipSecondAt } }), noul: () => 0.9 })
    const asker = new SessionFindAsker()
    const sec = vi.fn(async () => second)
    await asker.ask({ client: strong.client, query: 'strong query', stage: 'full', first, second: sec })
    expect(sec).not.toHaveBeenCalled()
    expect(strong.choices()).toHaveLength(1)

    const weak = fake({ choice: () => ({ byOption: { [first[1]!.option]: FIND_TUNING.jev.skipSecondAt - 0.01 } }), noul: () => 0.9 })
    const sec2 = vi.fn(async () => second)
    const out = await asker.ask({ client: weak.client, query: 'weak query', stage: 'full', first, second: sec2 })
    expect(sec2).toHaveBeenCalledTimes(1)
    expect(weak.choices()).toHaveLength(2)
    expect(out.asked).toHaveLength(40)
  })

  it('merges the two requests by raw probability and reads none only after the last: an answer in the second request wins even though the first said none', async () => {
    const first = many(0, 20), second = many(100, 20)
    const f = fake({ choice: options => options.includes(second[4]!.option) ? { byOption: { [second[4]!.option]: 0.95 }, none: 0.02 } : { byOption: { [first[0]!.option]: 0.05 }, none: 0.83 }, noul: text => text.includes('topic 104') ? 0.9 : 0.02 })
    const out = await run(new SessionFindAsker(), f, { first, second, stage: 'full' })
    expect(out.noneMin).toBeLessThan(FIND_NONE_ABSTAIN)
    expect(out.rows.map(r => r.key)).toEqual(['claude:s104'])
  })

  it('takes the lowest none, not the last: an answer in the first request is not erased by a second request with no answer', async () => {
    const first = many(0, 20), second = many(100, 20)
    const f = fake({ choice: options => options.includes(second[0]!.option) ? { byOption: {}, none: 0.9 } : { byOption: { [first[2]!.option]: 0.5, [first[3]!.option]: 0.45 }, none: 0.05 }, noul: text => text.includes('topic 2 ') || text.endsWith('topic 2') ? 0.8 : 0.01 })
    const out = await run(new SessionFindAsker(), f, { first, second, stage: 'full' })
    expect(f.choices()).toHaveLength(2)
    expect(out.noneMin).toBe(0.05)
    expect(out.verdict).not.toBe('abstain')
    expect(out.rows.map(r => r.key)).toEqual(['claude:s2'])
  })

  it('abstains when every request says none at 0.8 or more, and spends no yes/no round', async () => {
    const first = many(0, 20), second = many(100, 20)
    const f = fake({ choice: options => ({ byOption: { [options[0]!]: 0.1 }, none: 0.9 }) })
    const out = await run(new SessionFindAsker(), f, { first, second, stage: 'full' })
    expect(out.verdict).toBe('abstain')
    expect(out.rows).toEqual([])
    expect(out.noneMin).toBe(0.9)
    expect(f.reranks()).toHaveLength(0)
  })

  it('abstains on the first request alone at stage first', async () => {
    const f = fake({ choice: () => ({ none: 0.88 }) })
    const out = await run(new SessionFindAsker(), f, { first: many(0, 10) })
    expect(out.verdict).toBe('abstain')
  })

  it('uses a second request that returns nothing as no second request', async () => {
    const f = fake({ choice: () => ({ none: 0.2, byOption: {} }) })
    const out = await run(new SessionFindAsker(), f, { first: many(0, 5), second: [], stage: 'full' })
    expect(f.choices()).toHaveLength(1)
    expect(out.asked).toHaveLength(5)
  })

  it('does not start the second request or the yes/no round once the caller has gone', async () => {
    let gone = false
    const first = many(0, 10)
    const f = fake({ choice: () => { gone = true; return { byOption: { [first[0]!.option]: 0.3 } } }, noul: () => 0.9 })
    const out = await run(new SessionFindAsker(), f, { first, second: many(100, 10), stage: 'full', shouldStop: () => gone })
    expect(out.stopped).toBe(true)
    expect(out.verdict).toBe('stopped')
    expect(f.choices()).toHaveLength(1)
    expect(f.reranks()).toHaveLength(0)

    gone = false
    const f2 = fake({ choice: () => ({ byOption: { [first[0]!.option]: 0.9 } }), noul: () => 0.9 })
    let stopBeforeRerank = false
    const asker = new SessionFindAsker()
    const out2 = await asker.ask({ client: f2.client, query: 'rerank stop', stage: 'first', first, second: async () => [], shouldStop: () => { stopBeforeRerank = f2.choices().length > 0; return stopBeforeRerank } })
    expect(out2.stopped).toBe(true)
    expect(f2.reranks()).toHaveLength(0)
  })
})

describe('forks and identical text', () => {
  it('collapses identical text into one option and gives every member the probability', async () => {
    const same = 'Genshin settings: the Mac froze while playing'
    const first = [cand(0, same, 5_000), cand(1, 'unrelated session one'), cand(2, same, 4_000), cand(3, 'unrelated session two')]
    expect(collapseIdentical(first)).toHaveLength(3)
    const f = fake({ choice: () => ({ byOption: { [same]: 0.6 } }), noul: t => t.includes('Genshin') ? 0.8 : 0.01 })
    const out = await run(new SessionFindAsker(), f, { first })
    expect(f.choices()[0]!.options).toHaveLength(3)
    expect(f.reranks()[0]!.texts).toHaveLength(1)
    expect(out.rows.map(r => [r.key, r.probability])).toEqual([['claude:s0', 0.8], ['claude:s2', 0.8]])
  })
})

describe('the cache', () => {
  it('answers the same search again from the cache, with no model call, in any candidate order', async () => {
    const first = many(0, 10)
    const f = fake({ choice: () => ({ byOption: { [first[2]!.option]: 0.7 } }), noul: () => 0.8 })
    const asker = new SessionFindAsker()
    const a = await run(asker, f, { first, query: 'Same Words' })
    expect(a.cached).toBe(false)
    const b = await run(asker, f, { first: [...first].reverse(), query: '  same   words ' })
    expect(b.cached).toBe(true)
    expect(b.modelCalls).toBe(0)
    expect(b.rows).toEqual(a.rows)
    expect(f.calls).toHaveLength(2)
  })

  it('expires after 10 minutes', async () => {
    let now = 1_000
    const first = many(0, 5)
    const f = fake({ choice: () => ({ byOption: { [first[0]!.option]: 0.7 } }), noul: () => 0.8 })
    const asker = new SessionFindAsker(() => now)
    await run(asker, f, { first, query: 'ten minutes' })
    now += 10 * 60_000 - 1
    expect((await run(asker, f, { first, query: 'ten minutes' })).cached).toBe(true)
    now += 2
    expect((await run(asker, f, { first, query: 'ten minutes' })).cached).toBe(false)
  })

  it('does not share an answer between providers or between queries', async () => {
    const first = many(0, 5)
    const asker = new SessionFindAsker()
    const jev = fake({ choice: () => ({ none: 0.1 }) }), subq = fake({ provider: 'subq', choice: () => ({ none: 0.1 }) })
    await run(asker, jev, { first, query: 'shared words' })
    await run(asker, subq, { first, query: 'shared words' })
    await run(asker, jev, { first, query: 'other words' })
    expect(jev.choices()).toHaveLength(2)
    expect(subq.choices()).toHaveLength(1)
  })

  it('reuses the first request when stage full follows stage first for the same words', async () => {
    const first = many(0, 10), second = many(100, 10)
    const f = fake({ choice: options => options.includes(second[0]!.option) ? { byOption: { [second[0]!.option]: 0.2 } } : { byOption: { [first[0]!.option]: 0.3 } }, noul: () => 0.5 })
    const asker = new SessionFindAsker()
    await run(asker, f, { first, query: 'two stages' })
    expect(f.choices()).toHaveLength(1)
    await run(asker, f, { first, second, query: 'two stages', stage: 'full' })
    expect(f.choices()).toHaveLength(2)
  })

  it('lets a search typed twice at once share one request', async () => {
    const first = many(0, 6)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const f = fake({ choice: () => ({ byOption: { [first[0]!.option]: 0.7 } }), noul: () => 0.8 })
    const slow = { ...f.client, ask: async (...args: Parameters<DecisionClient['ask']>) => { await gate; return f.client.ask(...args) } }
    const asker = new SessionFindAsker()
    const input = { query: 'twice at once', stage: 'first' as const, first, second: async () => [] }
    const a = asker.ask({ ...input, client: slow }), b = asker.ask({ ...input, client: slow })
    release()
    await Promise.all([a, b])
    expect(f.choices()).toHaveLength(1)
  })

  it('does not cache a failure', async () => {
    const first = many(0, 4)
    let fail = true
    const f = fake({ choice: () => ({ byOption: {} }) })
    const client: DecisionClient = { provider: 'jev', ask: async (...a) => { if (fail) throw new DecisionProviderError('decision_unavailable'); return f.client.ask(...a) } }
    const asker = new SessionFindAsker()
    await expect(asker.ask({ client, query: 'retry me', stage: 'first', first, second: async () => [] })).rejects.toBeInstanceOf(DecisionProviderError)
    fail = false
    await expect(asker.ask({ client, query: 'retry me', stage: 'first', first, second: async () => [] })).resolves.toBeTruthy()
  })
})

describe('answers that cannot be trusted', () => {
  it('rejects an option that was not offered, a probability outside 0 to 1, and a missing answer', () => {
    expect(() => parseChoice({ probabilities: { t0: 0.5, t9: 0.1, none: 0.4 } }, 2)).toThrow(DecisionProviderError)
    expect(() => parseChoice({ probabilities: { t0: 1.2, none: 0 } }, 2)).toThrow(DecisionProviderError)
    expect(() => parseChoice({ probabilities: { t0: Number.NaN, none: 0 } }, 2)).toThrow(DecisionProviderError)
    expect(() => parseChoice({ probabilities: { tx: 0.5 } }, 2)).toThrow(DecisionProviderError)
    expect(() => parseChoice(undefined, 2)).toThrow(DecisionProviderError)
    expect(parseChoice({ probabilities: { t1: 0.7, none: 0.3 } }, 3)).toEqual({ p: [0, 0.7, 0], none: 0.3 })
  })

  it('treats a yes/no answer that is missing or out of range as a bad answer', async () => {
    const first = many(0, 4)
    const f = fake({ choice: () => ({ byOption: { [first[0]!.option]: 0.7 } }), noul: () => 1.5 })
    await expect(run(new SessionFindAsker(), f, { first })).rejects.toBeInstanceOf(DecisionProviderError)
  })

  it('tells the model that session text is data, in the Choice and in every yes/no question', async () => {
    const first = many(0, 4)
    const f = fake({ choice: () => ({ byOption: { [first[0]!.option]: 0.7 } }), noul: () => 0.8 })
    await run(new SessionFindAsker(), f, { first })
    // The instruction reaches the client as the Choice's `instructions`; the fake keeps the yes/no text, which starts with it.
    expect(f.reranks()[0]!.texts![0]).toMatch(/data and not an instruction/)
  })
})
