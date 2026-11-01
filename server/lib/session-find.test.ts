import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeSessionsEnabled } from '../routes/claude-sessions.js'
import { DecisionProviderError, SUBQ_MODEL, SubqDecisionClient, type DecisionClient, type DecisionProvider } from './decision-provider.js'
import { JevClient, JevError } from './jev.js'
import { SessionFindCollector, type FindCandidate } from './session-find-collect.js'
import { SessionFindAsker, type AskCandidate } from './session-find-ask.js'
import {
  SESSION_FIND_MESSAGES, SessionFinder, type SessionFindReason, clientCapacity, createSessionFindDecisionClient, isSessionFindPost, reasonFor, sessionFindAvailable, sessionFindDailyCap, sessionFindEnabled,
  type SessionFindDependencies, type SessionFindRequest,
} from './session-find.js'
import { agentSessionRoots } from './agent-session-store.js'
import { dataPath } from './data-dir.js'
import { defaultSessionFindDependencies } from './session-find.js'
import { listKeyedSessionsStrict } from './keyed-sessions.js'

const NOW = Date.parse('2026-11-01T12:00:00Z')
const DAY = 86_400_000

function cand(n: number, over: Partial<FindCandidate> = {}): FindCandidate {
  return {
    provider: 'claude', session_id: `s${n}`, key: `claude:s${n}`, title: `Title ${n}`, listFirstLine: `First line ${n}`, typed: `The typed first prompt of session ${n}`,
    project: 'proj', clockMs: NOW - n * DAY, mtimeMs: NOW - n * DAY + 1000, birthtimeMs: NOW - (n + 1) * DAY, created: new Date(NOW - (n + 1) * DAY).toISOString(),
    compressed: false, file: `/x/s${n}.jsonl`, ...over,
  }
}

type DepsOver = Partial<SessionFindDependencies> & { pool?: FindCandidate[]; provider?: DecisionProvider }
function deps(over: DepsOver = {}) {
  const provider = over.provider ?? 'jev'
  const { pool, provider: _provider, ...rest } = over
  const collect = vi.fn<SessionFindCollector['collect']>(async o => ({ candidates: (pool ?? []).slice(0, o.limit), skippedNoDecoder: 0, skippedUnreadable: 0, opened: 0, considered: 0, ms: 0 }))
  const ask = vi.fn<SessionFindAsker['ask']>(async input => ({
    rows: input.first.slice(0, 1).map(c => ({ key: c.key, probability: 0.9, strength: 'strong' as const })), asked: [...input.first], modelCalls: 2, tokens: 10, cached: false, noneMin: 0.05, stopped: false, verdict: 'rows' as const,
  }))
  const client: DecisionClient = { provider, ask: vi.fn() as DecisionClient['ask'] }
  const base: SessionFindDependencies = {
    collector: { collect }, asker: { ask }, decision: client,
    roots: () => agentSessionRoots('/nowhere'), keyedIds: () => new Set(['keyed-one']), available: () => ({ find: true, sessions: true }), selected: () => provider,
    configured: () => true, capacity: () => null, jev: null, ...rest,
  }
  return { base, collect, ask, client, finder: new SessionFinder(base) }
}
const req = (over: Partial<SessionFindRequest> = {}): SessionFindRequest => ({ query: 'the tailscale connection drops', consentedProvider: 'jev', stage: 'first', ...over })
const sig = () => new AbortController().signal

describe('refuses before it reads a session or sends a byte', () => {
  const refusals: Array<[string, DepsOver, SessionFindRequest, SessionFindReason]> = [
    ['find is switched off', { available: () => ({ find: false, sessions: true }) }, req(), 'find_off'],
    ['sessions are off', { available: () => ({ find: true, sessions: false }) }, req(), 'sessions_off'],
    ['the person has not agreed', {}, req({ consentedProvider: null }), 'consent_required'],
    ['the person agreed to another provider', {}, req({ consentedProvider: 'subq' }), 'provider_changed'],
    ['the words redact away', {}, req({ query: 'jane.doe@example.com' }), 'query_too_short'],
    ['the words are two letters', {}, req({ query: 'ab' }), 'query_too_short'],
    ['the provider has no key', { configured: () => false }, req(), 'jev_not_configured'],
    ['the cap is already reached', { capacity: () => 'cap_reached' as const }, req(), 'cap_reached'],
    ['the breaker is open', { capacity: () => 'breaker_open' as const }, req(), 'breaker_open'],
    ['the setting is invalid', { selected: () => { throw new DecisionProviderError('decision_invalid_provider') } }, req(), 'failed'],
  ]
  it.each(refusals)('%s', async (_name, over, request, reason) => {
    const d = deps({ pool: [cand(1)], ...over })
    const answer = await d.finder.find(request, sig())
    expect(answer.available).toBe(false)
    expect(answer.reason).toBe(reason)
    expect(answer.message).toBe(SESSION_FIND_MESSAGES[reason])
    expect(answer.rows).toEqual([])
    expect(d.collect).not.toHaveBeenCalled()
    expect(d.ask).not.toHaveBeenCalled()
  })

  it('names the provider in a consent answer, so Control can say who would be sent to before anything is', async () => {
    const jev = await deps({ provider: 'jev' }).finder.find(req({ consentedProvider: null }), sig())
    expect(jev).toMatchObject({ reason: 'consent_required', provider: 'jev', storesData: false })
    const subq = await deps({ provider: 'subq' }).finder.find(req({ consentedProvider: null }), sig())
    expect(subq).toMatchObject({ reason: 'consent_required', provider: 'subq', storesData: true })
  })

  it('refuses when the snapshot is a different provider than the one checked', async () => {
    const d = deps({ provider: 'jev' })
    d.base.decision = { provider: 'subq', ask: vi.fn() as DecisionClient['ask'] }
    const answer = await new SessionFinder(d.base).find(req(), sig())
    expect(answer.reason).toBe('provider_changed')
    expect(d.collect).not.toHaveBeenCalled()
  })

  it('has the contract reasons and messages without em dashes or arrows', () => {
    for (const [reason, message] of Object.entries(SESSION_FIND_MESSAGES)) {
      expect(message, reason).not.toMatch(/[—–→←↑↓]/)
      expect(message.length).toBeGreaterThan(10)
    }
    expect(Object.keys(SESSION_FIND_MESSAGES)).toEqual(expect.arrayContaining(['consent_required', 'provider_changed', 'decision_not_configured', 'sessions_off', 'find_off', 'cap_reached', 'breaker_open', 'query_too_short', 'failed']))
  })
})

describe('an answer', () => {
  it('carries the list fields, the clock, the redacted words the model judged, the probability, the strength and the compressed flag', async () => {
    const d = deps({ pool: [cand(1, { title: 'Email jane@example.com about it', typed: 'Ring 512-555-0199 and use sk-abcdefghijklmnopqrstuvwxyz123456 for the lens', compressed: true, provider: 'codex', key: 'codex:s1', session_id: 's1' }), cand(2)] })
    const answer = await d.finder.find(req(), sig())
    expect(answer.available).toBe(true)
    expect(answer.reason).toBeNull()
    expect(answer).toMatchObject({ provider: 'jev', storesData: false, asked: 2, skipped: 0, cached: false })
    const [row] = answer.rows
    expect(row).toMatchObject({
      session_id: 's1', provider: 'codex', slug: 's1', display_label: 'Email jane@example.com about it', project: 'proj', alive: false, state: 'recent', pinned: false,
      probability: 0.9, strength: 'strong', compressed: true, device_id: 'codex', machine_spawned: false, domain: '',
    })
    expect(row!.last_activity_at).toBe(new Date(NOW - DAY).toISOString())
    expect(row!.modified).toBe(new Date(NOW - DAY + 1000).toISOString())
    // What goes back as judged_text is the redacted prompt part, like what went to the model.
    expect(row!.judged_text).not.toMatch(/555|sk-abc/)
    expect(row!.judged_text).toContain('the lens')
    expect(row).not.toHaveProperty('file')
    expect(JSON.stringify(row)).not.toContain('/x/s1.jsonl')
    expect(answer.reachedBack).toBe(new Date(NOW - 2 * DAY).toISOString())
  })

  it('sends the model the redacted query and the redacted sessions, and never the raw text', async () => {
    const d = deps({ pool: [cand(1, { title: 'Call jane@example.com', typed: 'Use password: hunter2 to log in at https://secret.example/path?token=abc123456' })] })
    await d.finder.find(req({ query: 'where did jane@example.com get the password: hunter2' }), sig())
    const input = d.ask.mock.calls[0]![0]
    expect(input.query).not.toMatch(/jane|hunter2/)
    expect(input.query).toContain('where did')
    expect(input.first[0]!.option).not.toMatch(/jane|hunter2|abc123456|secret\.example/)
  })

  it('leaves out a session whose words all redact away, and reports the rest', async () => {
    const d = deps({ pool: [cand(1, { title: 'jane@example.com', typed: 'john@example.com' }), cand(2)] })
    const answer = await d.finder.find(req(), sig())
    expect(answer.asked).toBe(1)
  })

  it('asks the older sessions only at stage full, once the first 254 are asked, and never twice for one session', async () => {
    const pool = Array.from({ length: 300 }, (_, i) => cand(i + 1))
    const d = deps({ pool, chunkSize: 254 })
    d.ask.mockImplementation(async input => {
      const older = await input.second()
      return { rows: [], asked: [...input.first, ...older], modelCalls: 3, tokens: 1, cached: false, noneMin: 0.1, stopped: false, verdict: 'below_floor' as const }
    })
    const answer = await d.finder.find(req({ stage: 'full' }), sig())
    expect(d.collect.mock.calls.map(call => call[0].limit)).toEqual([254, 508])
    expect(answer.asked).toBe(300)
    expect(d.ask.mock.calls[0]![0].first).toHaveLength(254)
  })

  it('reports the compressed files it could not read from the widest pool it used', async () => {
    const d = deps({ pool: [cand(1)] })
    d.collect.mockResolvedValue({ candidates: [cand(1)], skippedNoDecoder: 3, skippedUnreadable: 1, opened: 0, considered: 0, ms: 0 })
    expect((await d.finder.find(req(), sig())).skipped).toBe(4)
  })

  it('passes the keyed ids to the collector so keyed sessions never leave', async () => {
    const d = deps({ pool: [cand(1)] })
    await d.finder.find(req(), sig())
    expect(d.collect.mock.calls[0]![0].keyedIds?.has('keyed-one')).toBe(true)
  })

  it('answers SubQ with storesData true', async () => {
    const answer = await deps({ provider: 'subq', pool: [cand(1)] }).finder.find(req({ consentedProvider: 'subq' }), sig())
    expect(answer).toMatchObject({ available: true, provider: 'subq', storesData: true })
  })
})

describe('failures are answers, with fixed words in the log', () => {
  afterEach(() => vi.restoreAllMocks())
  it.each([
    [new JevError('jev_cap_reached'), 'cap_reached'],
    [new DecisionProviderError('decision_cap_reached'), 'cap_reached'],
    [new JevError('jev_breaker_open'), 'breaker_open'],
    [new DecisionProviderError('decision_breaker_open'), 'breaker_open'],
    [new JevError('jev_not_configured'), 'jev_not_configured'],
    [new DecisionProviderError('decision_not_configured'), 'decision_not_configured'],
    [new JevError('jev_unavailable'), 'failed'],
    [new JevError('jev_request_rejected'), 'failed'],
    [new DecisionProviderError('decision_key_rejected'), 'failed'],
    [new DecisionProviderError('decision_bad_answer'), 'failed'],
    [new Error('anything else with the query inside'), 'failed'],
  ])('%s becomes %s', async (error, reason) => {
    expect(reasonFor(error)).toBe(reason)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const d = deps({ pool: [cand(1)] })
    d.ask.mockRejectedValue(error)
    const answer = await d.finder.find(req({ query: 'a very particular secret search phrase' }), sig())
    expect(answer).toMatchObject({ available: false, reason })
    expect(warn.mock.calls.flat().join(' ')).toBe(`[session-find] unavailable: ${reason}`)
  })

  it('lets a cancelled walk throw, so the route can stay silent', async () => {
    const d = deps({ pool: [cand(1)] })
    const gone = new AbortController()
    d.collect.mockImplementation(async () => { gone.abort(); const e = new Error('cancelled'); e.name = 'AbortError'; throw e })
    await expect(d.finder.find(req(), gone.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('treats a search that stopped because the caller left as a cancel', async () => {
    const d = deps({ pool: [cand(1)] })
    d.ask.mockResolvedValue({ rows: [], asked: [], modelCalls: 1, tokens: 1, cached: false, noneMin: null, stopped: true, verdict: 'stopped' })
    await expect(d.finder.find(req(), sig())).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('the switches and predicates', () => {
  it('is on unless COS_SESSION_FIND says off', () => {
    expect(sessionFindEnabled({})).toBe(true)
    for (const off of ['0', 'false', 'no', 'off', ' OFF ']) expect(sessionFindEnabled({ COS_SESSION_FIND: off })).toBe(false)
    expect(sessionFindEnabled({ COS_SESSION_FIND: '1' })).toBe(true)
  })
  it('is available only with Sessions on, and agrees with the Sessions switch itself', () => {
    const before = process.env.COS_CLAUDE_SESSIONS_ENABLED
    try {
      for (const value of [undefined, '0', '1', 'true']) {
        if (value === undefined) delete process.env.COS_CLAUDE_SESSIONS_ENABLED; else process.env.COS_CLAUDE_SESSIONS_ENABLED = value
        expect(sessionFindAvailable(process.env)).toBe(claudeSessionsEnabled())
      }
    } finally { if (before === undefined) delete process.env.COS_CLAUDE_SESSIONS_ENABLED; else process.env.COS_CLAUDE_SESSIONS_ENABLED = before }
    expect(sessionFindAvailable({ COS_CLAUDE_SESSIONS_ENABLED: '1', COS_SESSION_FIND: '0' })).toBe(false)
    expect(sessionFindAvailable({ COS_CLAUDE_SESSIONS_ENABLED: '1' })).toBe(true)
    expect(sessionFindAvailable({})).toBe(false)
  })
  it('caps at 3,000,000 tokens a day unless COS_SESSION_FIND_DAILY_TOKENS says otherwise', () => {
    expect(sessionFindDailyCap({})).toBe(3_000_000)
    expect(sessionFindDailyCap({ COS_SESSION_FIND_DAILY_TOKENS: '500000' })).toBe(500_000)
    expect(sessionFindDailyCap({ COS_SESSION_FIND_DAILY_TOKENS: '-5' })).toBe(3_000_000)
    expect(sessionFindDailyCap({ COS_SESSION_FIND_DAILY_TOKENS: 'lots' })).toBe(3_000_000)
  })
  it('lets only the find POST past the mutation lease', () => {
    expect(isSessionFindPost('POST', '/agent-sessions/find')).toBe(true)
    for (const [m, p] of [['GET', '/agent-sessions/find'], ['POST', '/agent-sessions/find/'], ['POST', '/agent-sessions'], ['POST', '/agent-sessions/claude/abc'], ['PUT', '/agent-sessions/find'], ['POST', '/work/search']] as const) expect(isSessionFindPost(m, p)).toBe(false)
  })
})

describe('its own ledgers, caps and breakers', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'session find ledger.')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals() })
  const choiceReply = { model: SUBQ_MODEL, answers: { c: { type: 'choice', choice: 'none', confidence: 0.9, probabilities: { t0: 0.1, none: 0.9 } } }, usage: { input_tokens: 321 } }
  const choiceQuestion = { c: { type: 'choice', instructions: 'x', criteria: { t0: 'a session', none: 'none' } } }

  it('spends SubQ tokens in its own ledger and cap, not Work search\'s subq-search-usage.json', async () => {
    vi.stubEnv('SUBQ_API_KEY', 'synthetic-test-key-for-subq')
    const fetchMock = vi.fn(async () => Response.json(choiceReply))
    vi.stubGlobal('fetch', fetchMock)
    const own = join(dir, 'session-find-subq-usage.json')
    const client = createSessionFindDecisionClient({ ask: vi.fn() }, { COS_DECISION_PROVIDER_SEARCH: 'subq' }, own, () => 400)
    const snapshot = client.snapshot!()
    expect(snapshot).toBeInstanceOf(SubqDecisionClient)
    await snapshot.ask({ query: 'q' }, choiceQuestion, 1)
    expect(JSON.parse(readFileSync(own, 'utf8'))[new Date().toISOString().slice(0, 10)]).toBe(321)
    expect((snapshot as SubqDecisionClient).status().dailyCap).toBe(400)
    // 321 spent of 400: the next request's reservation (its body, in bytes) no longer fits.
    await expect(snapshot.ask({ query: 'q' }, choiceQuestion, 1)).rejects.toMatchObject({ code: 'decision_cap_reached' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps Work search\'s SubQ ledger path and cap when no feature ledger is given (the argument is additive)', async () => {
    const { createDecisionClient } = await import('./decision-provider.js')
    const c = createDecisionClient('search', { ask: vi.fn() }, { COS_DECISION_PROVIDER_SEARCH: 'subq' })
    const s = c.snapshot!() as SubqDecisionClient
    expect(s.status().dailyCap).toBe(1_000_000)
  })

  it('gives Jev its own ledger and cap', async () => {
    const fetchMock = vi.fn(async () => Response.json({ answers: { c: { type: 'choice', choice: 'none', probabilities: { none: 1 } } }, usage: { input_tokens: 77 } }))
    vi.stubEnv('TYPESAFE_API_KEY', 'synthetic-test-key-for-jev')
    const file = join(dir, 'session-find-jev-usage.json')
    const jev = new JevClient(fetchMock as typeof fetch, () => new Date('2026-11-01T10:00:00Z'), file, () => 100)
    await jev.ask({}, {}, 10)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ '2026-11-01': 77 })
    await expect(jev.ask({}, {}, 30)).rejects.toMatchObject({ code: 'jev_cap_reached' })
  })

  it('reads cap and breaker from the clients before any session is read', () => {
    const subq = { provider: 'subq', status: () => ({ configured: true, usedToday: 10, dailyCap: 100, breakerOpenUntil: null }) }
    const proto = SubqDecisionClient.prototype
    const fake = Object.assign(Object.create(proto), subq) as DecisionClient
    expect(clientCapacity(fake, 'subq', null)).toBeNull()
    expect(clientCapacity(Object.assign(Object.create(proto), { ...subq, status: () => ({ ...subq.status(), usedToday: 100 }) }) as DecisionClient, 'subq', null)).toBe('cap_reached')
    expect(clientCapacity(Object.assign(Object.create(proto), { ...subq, status: () => ({ ...subq.status(), breakerOpenUntil: 5 }) }) as DecisionClient, 'subq', null)).toBe('breaker_open')
    const jevAt = (usedToday: number, breakerOpenUntil: string | null) => ({ status: () => ({ usedToday, dailyCap: 100, breakerOpenUntil }) }) as unknown as JevClient
    expect(clientCapacity({ provider: 'jev' } as DecisionClient, 'jev', jevAt(99, null))).toBeNull()
    expect(clientCapacity({ provider: 'jev' } as DecisionClient, 'jev', jevAt(100, null))).toBe('cap_reached')
    expect(clientCapacity({ provider: 'jev' } as DecisionClient, 'jev', jevAt(0, '2026-11-01T00:00:00Z'))).toBe('breaker_open')
  })
})

describe('end to end on a fake home, real collector, real asker, scripted model', () => {
  let home = ''
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'session find e2e.')) })
  afterEach(() => rmSync(home, { recursive: true, force: true }))
  function session(n: number, prompt: string, ageDays: number) {
    const dir = join(home, '.claude', 'projects', '-Users-test-proj')
    mkdirSync(dir, { recursive: true })
    const id = `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
    const file = join(dir, `${id}.jsonl`)
    const at = NOW - ageDays * DAY
    writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: prompt }, timestamp: new Date(at).toISOString() }) + '\n'
      + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, timestamp: new Date(at + 1000).toISOString() }) + '\n')
    utimesSync(file, new Date(at + 1000), new Date(at + 1000))
    return id
  }

  it('finds the session the scripted model picks, and shows nothing when the model says none', async () => {
    const target = session(1, 'Why does the tailscale connection drop when the phone is away from home and the mac sleeps', 3)
    session(2, 'Write a launch email for the jewelry brand and check the subject line', 5)
    session(3, 'Debug the ring scrolling on the lens menu when the page is long', 9)
    const seen: string[] = []
    const client: DecisionClient = {
      provider: 'jev',
      async ask(state, questions) {
        const q = questions as Record<string, { criteria?: Record<string, string>; instructions: string; type: string }>
        seen.push(JSON.stringify({ state, questions }))
        if (q.c) {
          const entries = Object.entries(q.c.criteria!).filter(([k]) => k !== 'none')
          const hit = /phone|mac/.test((state as { query: string }).query) ? entries.find(([, text]) => /tailscale/i.test(text)) : undefined
          const probabilities: Record<string, number> = { none: hit ? 0.05 : 0.95 }
          for (const [label] of entries) probabilities[label] = label === hit?.[0] ? 0.95 : 0
          return { provider: 'jev', answers: { c: { type: 'choice', probabilities, choice: 'none', confidence: 1 } }, inputTokens: 500 }
        }
        const answers: Record<string, { type: 'noul'; noul: number }> = {}
        for (const [name, spec] of Object.entries(q)) answers[name] = { type: 'noul', noul: /tailscale/i.test(spec.instructions) ? 0.9 : 0.02 }
        return { provider: 'jev', answers, inputTokens: 120 }
      },
    }
    const finder = new SessionFinder({
      collector: new SessionFindCollector(), asker: new SessionFindAsker(), decision: client, roots: () => agentSessionRoots(home), keyedIds: () => new Set(),
      available: () => ({ find: true, sessions: true }), selected: () => 'jev', configured: () => true, capacity: () => null, jev: null,
    })
    const found = await finder.find(req({ query: 'my phone loses the mac when I am out' }), sig())
    expect(found.available).toBe(true)
    expect(found.rows.map(r => r.session_id)).toEqual([target])
    expect(found.rows[0]).toMatchObject({ strength: 'strong', probability: 0.9, compressed: false, project: '-Users-test-proj' })
    expect(found.asked).toBe(3)
    expect(found.reachedBack).toBe(new Date(NOW - 9 * DAY + 1000).toISOString())
    expect(seen.join(' ')).not.toContain(home)

    const none = await finder.find(req({ query: 'planning a half marathon training schedule' }), sig())
    expect(none).toMatchObject({ available: true, rows: [], asked: 3 })
  })
})

describe('keyed sessions must not leave, even when their file is damaged', () => {
  const file = () => dataPath('keyed-sessions.json')
  afterEach(() => rmSync(file(), { force: true }))
  const record = (id: string) => ({ id, engine: 'claude', profileId: 'p1', recordedAt: '2026-10-30T00:00:00.000Z' })

  it('reads the ids of the keyed sessions, lower case, through the default dependencies', () => {
    expect(defaultSessionFindDependencies().keyedIds().size).toBe(0)
    writeFileSync(file(), JSON.stringify({ v: 1, sessions: [record('ABCDEF12-0000-4000-8000-000000000001')] }))
    expect([...defaultSessionFindDependencies().keyedIds()]).toEqual(['abcdef12-0000-4000-8000-000000000001'])
  })

  it.each([['not JSON', '{"sessions": ['], ['the wrong shape', '{"v":1,"sessions":"x"}'], ['a record that is not one', JSON.stringify({ v: 1, sessions: [record('abcdef12-0000-4000-8000-000000000001'), { id: 7 }] })]])(
    'throws for a file that is %s, where the list\'s reader would say "none"', (_name, body) => {
      writeFileSync(file(), body)
      expect(() => listKeyedSessionsStrict()).toThrow()
      expect(() => defaultSessionFindDependencies().keyedIds()).toThrow()
    })

  it('answers failed, reads no session and asks no model when the file is damaged', async () => {
    writeFileSync(file(), '{"sessions": [')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const d = deps({ pool: [cand(1)] })
    const base = { ...d.base, keyedIds: defaultSessionFindDependencies().keyedIds }
    const answer = await new SessionFinder(base).find(req(), sig())
    expect(answer).toMatchObject({ available: false, reason: 'failed' })
    expect(d.collect).not.toHaveBeenCalled()
    expect(d.ask).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('answers failed (HTTP 200 through the route), not a thrown error, when the walk itself fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const d = deps({ pool: [cand(1)] })
    d.collect.mockRejectedValue(new Error('EIO'))
    expect(await d.finder.find(req(), sig())).toMatchObject({ available: false, reason: 'failed' })
    vi.restoreAllMocks()
  })
})
