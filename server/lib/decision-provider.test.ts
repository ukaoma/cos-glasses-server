import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecisionClient, DecisionProviderError, selectedDecisionProvider, SUBQ_ENDPOINT, SUBQ_MODEL, SubqDecisionClient, validateDecisionAnswers } from './decision-provider.js'
import { CompletionChecker } from './work-completion.js'
import { SessionRecommender } from './session-recommendation.js'
import { WorkSearcher } from './work-search.js'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.unstubAllEnvs() })
const questions = { c: { type: 'choice', instructions: 'Choose the matching item or none.', criteria: { item: 'An item', none: 'Absent or unclear' } } }
const answer = { type: 'choice' as const, choice: 'none', confidence: 0.9, probabilities: { item: 0.05, none: 0.95 } }
function client(f = vi.fn(async () => Response.json({ model: SUBQ_MODEL, answers: { c: answer }, usage: { input_tokens: 123 } })), cap = 100_000, timeout = 1000) {
  const d = mkdtempSync(join(tmpdir(), 'subq-unit-')); dirs.push(d)
  const path = join(d, 'usage.json')
  return { client: new SubqDecisionClient(f as typeof fetch, () => new Date('2026-10-14T15:00:00Z'), path, () => 'synthetic-test-key', () => cap, timeout), f, path }
}
it('defaults to Jev, honors explicit per-use-case selection, and fails closed for typos', async () => {
  expect(selectedDecisionProvider('search', {})).toBe('jev')
  expect(selectedDecisionProvider('search', { COS_DECISION_PROVIDER: 'subq', COS_DECISION_PROVIDER_SEARCH: 'jev' })).toBe('jev')
  expect(() => selectedDecisionProvider('session', { COS_DECISION_PROVIDER: 'automatic' })).toThrow('decision_invalid_provider')
  const ask = vi.fn(async () => ({ answers: { c: answer }, inputTokens: 3 }))
  const jev = createDecisionClient('search', { ask }, {})
  expect(await jev.ask('state', questions, 2)).toMatchObject({ provider: 'jev' })
  await expect(jev.ask('state', questions, 2, { images: [{ mediaType: 'image/png', base64: 'x' }] })).rejects.toThrow('decision_images_unsupported')
  expect(ask).toHaveBeenCalledTimes(1)
})
it('sends only to official SubQ, pins model, redacts nested text, and persists usage without content', async () => {
  const { client: c, f, path } = client()
  const reply = await c.ask({ nested: ['a@example.com', '555-123-4567', 'sk-123456789abcdefghijklmnop'] }, questions, 1)
  expect(reply).toMatchObject({ provider: 'subq', model: SUBQ_MODEL, inputTokens: 123 })
  const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe(SUBQ_ENDPOINT); expect(init.redirect).toBe('error')
  expect(String(init.body)).not.toMatch(/a@example.com|555-123-4567|sk-123456789/)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ '2026-10-14': 123 })
  expect(String(init.body)).toContain('[email]')
})
it.each([[401,'decision_key_rejected'],[403,'decision_key_rejected'],[402,'decision_credits_required'],[429,'decision_rate_limited'],[422,'decision_request_rejected'],[503,'decision_unavailable']] as const)('reports HTTP %i without retry or leaking upstream text', async (status, code) => {
  const { client: c, f } = client(vi.fn(async () => new Response('private upstream response', { status })))
  await expect(c.ask('x', questions, 2)).rejects.toThrow(code)
  expect(f).toHaveBeenCalledTimes(1)
})
it('rejects malformed or unoffered answers and records the successful request', async () => {
  const { client: c, path } = client(vi.fn(async () => Response.json({ model: SUBQ_MODEL, answers: { c: { ...answer, choice: 'invented' } } })))
  await expect(c.ask('x', questions, 1)).rejects.toThrow('decision_bad_answer')
  expect(JSON.parse(readFileSync(path, 'utf8'))['2026-10-14']).toBeGreaterThan(0)
  for (const malformed of [NaN, -1, 1.1, '0.5']) expect(() => validateDecisionAnswers({ c: { ...answer, probabilities: { item: malformed, none: .95 } } }, questions)).toThrow('decision_bad_answer')
  expect(() => validateDecisionAnswers({ c: { ...answer, probabilities: { none: 1 } } }, questions)).toThrow('decision_bad_answer')
  expect(() => validateDecisionAnswers({ c: answer, extra: answer }, questions)).toThrow('decision_bad_answer')
})
it('validates noul, score, and image schemas before sending', async () => {
  expect(validateDecisionAnswers({ n: { type: 'noul', noul: .2 } }, { n: { type: 'noul' } })).toHaveProperty('n')
  expect(() => validateDecisionAnswers({ n: { type: 'noul', noul: 'yes' } }, { n: { type: 'noul' } })).toThrow()
  expect(validateDecisionAnswers({ s: { type: 'score', score: .5, legend: { 0: 'low', 1: 'high' }, probabilities: { 0: .5, 1: .5 }, confidence: .5 } }, { s: { type: 'score', criteria: ['low', 'high'] } })).toHaveProperty('s')
  const { client: c, f } = client()
  for (const images of [[{ mediaType: 'image/png' as const, base64: 'https://example.com/image.png' }], [{ mediaType: 'image/png' as const, base64: 'eA==' }]]) {
    await expect(c.ask('x', questions, 1, { images })).rejects.toThrow('decision_request_rejected')
  }
  expect(f).not.toHaveBeenCalled()
})
it('preserves images as raw base64 and supports caller cancellation without switching provider', async () => {
  const { client: c, f } = client()
  const image = { mediaType: 'image/png' as const, base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
  await c.ask('synthetic image', questions, 1, { images: [image] })
  expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)).images).toEqual([image])
  const controller = new AbortController(); controller.abort()
  await expect(c.ask('x', questions, 1, { signal: controller.signal })).rejects.toThrow('decision_cancelled')
  expect(f).toHaveBeenCalledTimes(1)
})
it('bounds timeouts and opens a breaker after three transport failures', async () => {
  const f = vi.fn(async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('private transport message')), { once: true })))
  const { client: c } = client(f as never, 100_000, 2)
  for (let n = 0; n < 3; n++) await expect(c.ask('x', questions, 1)).rejects.toThrow('decision_unavailable')
  await expect(c.ask('x', questions, 1)).rejects.toThrow('decision_breaker_open')
  expect(f).toHaveBeenCalledTimes(3)
})
it('reserves concurrent requests before send and refuses over-budget inputs locally', async () => {
  let finish!: (response: Response) => void
  const f = vi.fn(() => new Promise<Response>(r => { finish = r }))
  const { client: c } = client(f as never, 300)
  const first = c.ask('x', questions, 1)
  await expect(c.ask('x', questions, 1)).rejects.toThrow('decision_cap_reached')
  finish(Response.json({ model: SUBQ_MODEL, answers: { c: answer }, usage: { input_tokens: 10 } })); await first
  const capped = client(undefined, 1)
  await expect(capped.client.ask('x', questions, 1)).rejects.toThrow('decision_cap_reached'); expect(capped.f).not.toHaveBeenCalled()
})
it('propagates provider identity and abstention through existing workflows', async () => {
  const decision = { ask: vi.fn(async () => ({ provider: 'subq' as const, model: SUBQ_MODEL, inputTokens: 12, answers: {
    finished: { probabilities: { done: .01, not_done: .04, unclear: .95 } }, best: { probabilities: { s0: .01, none: .99 } }, exact: { probabilities: { s0: .01, none: .99 } }, c: { probabilities: { t0: .01, none: .99 } } } })) }
  expect(await new CompletionChecker(decision).check({ task: { text: 'test', doneWhen: '' }, reply: 'unknown' })).toMatchObject({ provider: 'subq', verdict: 'unclear' })
  expect(await new SessionRecommender(decision).recommend({ task: { text: 'test', domain: 'personal', meetings: [] }, sessions: [{ id: 'synthetic', title: 'test', provider: 'codex' }] })).toMatchObject({ provider: 'subq', action: 'new' })
  expect(await new WorkSearcher(decision).search('absent', [{ id: 'synthetic', text: 'test', domain: 'personal', checked: false }])).toMatchObject({ available: true, none: .99 })
  const failed = { ask: vi.fn(async () => { throw new DecisionProviderError('decision_credits_required') }) }
  expect(await new CompletionChecker(failed).check({ task: { text: 'test', doneWhen: '' }, reply: 'unknown' })).toEqual({ provider: 'none', reason: 'decision_credits_required' })
  expect(await new WorkSearcher(failed).search('absent', [{ id: 'synthetic', text: 'test', domain: 'personal', checked: false }])).toMatchObject({ available: false, reason: 'decision_credits_required' })
})

it('an explicit SubQ selection never calls Jev even when SubQ fails', async () => {
  vi.stubEnv('SUBQ_API_KEY', 'synthetic-key')
  const transport = vi.fn(async () => new Response('', { status: 402 }))
  vi.stubGlobal('fetch', transport)
  try {
    const ask = vi.fn(async () => ({ answers: {}, inputTokens: 0 }))
    const chosen = createDecisionClient('completion', { ask }, { COS_DECISION_PROVIDER: 'subq' })
    await expect(chosen.ask('synthetic', questions, 1)).rejects.toThrow('decision_credits_required')
    expect(transport).toHaveBeenCalledOnce(); expect(ask).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})
it('missing credentials fail before any egress', async () => {
  const f = vi.fn(async () => Response.json({}))
  const c = new SubqDecisionClient(f, () => new Date(), '/tmp/unused-subq-unit-ledger', () => '')
  await expect(c.ask('synthetic', questions, 1)).rejects.toThrow('decision_not_configured')
  expect(f).not.toHaveBeenCalled()
})
it('cancels an in-flight request without retrying', async () => {
  const f = vi.fn(async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })))
  const { client: c } = client(f as never)
  const controller = new AbortController()
  const pending = c.ask('synthetic', questions, 1, { signal: controller.signal }); controller.abort()
  await expect(pending).rejects.toThrow('decision_cancelled'); expect(f).toHaveBeenCalledTimes(1)
})
