import { afterEach, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkHandoffRequestStore, createOptionalWorkHandoffRequestStore, parseHandoffRequest, parseHandoffResult, handoffStatusView,
  handoffFullView, HANDOFF_REQUEST_LIMITS, CLAIM_TIMEOUT_REASON, type HandoffRequestRecord } from './work-handoff-requests.js'

const roots: string[] = [], stores: WorkHandoffRequestStore[] = []
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
const root = () => { const r = mkdtempSync(join(tmpdir(), 'handoff-requests-')); roots.push(r); return r }
const T0 = Date.parse('2026-09-30T15:00:00.000Z')
function clock(start = T0) { const c = { ms: start, now: () => new Date(c.ms) }; return c }
function open(dir = root(), c = clock(), writeFile?: (path: string, data: string) => void) {
  const s = new WorkHandoffRequestStore(dir, c.now, writeFile); stores.push(s); return s
}
const REV = 'b'.repeat(64)
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
const body = (n = 1, patch: Record<string, unknown> = {}) => ({ clientRequestId: uuid(n), domain: 'business', workIdentity: 'a'.repeat(12),
  expectedRevision: REV, mode: 'continueSession', sessionId: 'claude:abc-1', note: 'Use the new footer.', destinationSource: 'saved', ...patch })
const parse = (b: unknown, fallback = 'sonnet') => parseHandoffRequest(b, fallback)
/** `revision` null stands for a board row with no workRevision. */
function add(s: WorkHandoffRequestStore, b: Record<string, unknown>, revision: string | null = REV) {
  const { input, fingerprint } = parse(b); return s.create(input, fingerprint, revision ?? undefined)
}
const code = (fn: () => unknown): string => { try { fn(); return 'none' } catch (e) { return `${(e as { status?: number }).status} ${(e as { code?: string }).code}` } }

it.each([
  ['not an object', 'x'], ['an array', []], ['an unknown field', body(1, { priority: 'high' })],
  ['a v1 uuid', body(1, { clientRequestId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' })], ['no request id', body(1, { clientRequestId: undefined })],
  ['an unsafe domain', body(1, { domain: '../business' })], ['a row id that is not 12 hex', body(1, { workIdentity: 'business-1' })],
  ['a short revision', body(1, { expectedRevision: 'b'.repeat(63) })], ['an unknown mode', body(1, { mode: 'publish' })],
  ['no destination source', body(1, { destinationSource: undefined })], ['an unknown destination source', body(1, { destinationSource: 'guess' })],
  ['Continue without a session', body(1, { sessionId: undefined })], ['Fork without a session', body(1, { mode: 'fork', sessionId: '' })],
  ['a session without a provider', body(1, { sessionId: 'abc-1' })], ['a session from an unknown provider', body(1, { sessionId: 'gemini:abc' })],
  ['a session id with a space', body(1, { sessionId: 'claude:abc 1' })], ['a New session naming a session', body(1, { mode: 'newSession' })],
  ['a model on Continue', body(1, { model: 'opus' })], ['a model slot the server does not know', body(1, { mode: 'newSession', sessionId: null, model: 'gpt-9' })],
  ['a note of 2,001 characters', body(1, { note: 'n'.repeat(2_001) })], ['a note with a bell', body(1, { note: 'ring\u0007' })],
  ['a note with a carriage return', body(1, { note: 'a\r\nb' })], ['a note with a C1 control', body(1, { note: 'a\u0085b' })],
  ['a note with a lone surrogate', body(1, { note: 'a\uD800b' })], ['a note that is not text', body(1, { note: 5 })],
  ['a body over 16 KB', body(1, { note: '\u{1F377}'.repeat(1_999) + 'x'.repeat(9_000) })],
])('refuses %s as 400 invalid_handoff_request', (_name, raw) => {
  expect(code(() => parse(raw))).toBe('400 invalid_handoff_request')
})

it('accepts the contract forms, keeps newlines and tabs in a note, and counts a note in characters', () => {
  expect(parse(body(1, { clientRequestId: uuid(1).toUpperCase() })).input.clientRequestId).toBe(uuid(1))
  expect(parse(body(1, { note: 'line one\n\tline two  ' })).input.note).toBe('line one\n\tline two')
  expect(parse(body(1, { note: '\u{1F377}'.repeat(2_000) })).input.note).toHaveLength(4_000)
  expect(parse(body(1, { note: 'n'.repeat(2_000) })).input.note).toHaveLength(2_000)
  expect(parse(body(1, { note: '   ' })).input).not.toHaveProperty('note')
  expect(parse(body(1, { note: null, model: '' })).input).not.toHaveProperty('note')
  expect(parse(body(1, { mode: 'fork', sessionId: 'codex:t-9', model: 'opus' })).input).toMatchObject({ mode: 'fork', model: 'opus' })
  expect(parse(body(1, { mode: 'fork', sessionId: 'codex:t-9' })).input).not.toHaveProperty('model')
})

it('a New session takes the given model slot, or the server default, and names it', () => {
  const given = parse(body(1, { mode: 'newSession', sessionId: undefined, model: 'codex-high' }))
  expect(given.input.model).toBe('codex-frontier')
  const fallback = parse(body(1, { mode: 'newSession', sessionId: null }), 'opus')
  expect(fallback.input.model).toBe('opus')
  expect(parse(body(1, { mode: 'newSession', sessionId: null }), 'sonnet').fingerprint).toBe(fallback.fingerprint)
})

it('creates a pending request that expires 10 minutes later, and keeps the note out of the status view', () => {
  const s = open(), { request, created } = add(s, body())
  expect(created).toBe(true)
  expect(request).toMatchObject({ state: 'pending', createdAt: '2026-09-30T15:00:00.000Z', note: 'Use the new footer.' })
  expect(handoffStatusView(request)).toEqual({ clientRequestId: uuid(1), state: 'pending', createdAt: '2026-09-30T15:00:00.000Z', expiresAt: '2026-09-30T15:10:00.000Z' })
  expect(handoffFullView(request)).not.toHaveProperty('fingerprint')
  expect(handoffFullView(request)).toMatchObject({ note: 'Use the new footer.', mode: 'continueSession', sessionId: 'claude:abc-1', destinationSource: 'saved', expiresAt: '2026-09-30T15:10:00.000Z' })
})

it('is idempotent by clientRequestId: the same body is the stored request, a different body is a conflict', () => {
  const c = clock(), s = open(root(), c), first = add(s, body()).request
  expect(add(s, body())).toEqual({ request: first, created: false })
  expect(add(s, body(1, { clientRequestId: uuid(1).toUpperCase() })).created).toBe(false)
  expect(code(() => add(s, body(1, { note: 'Something else' })))).toBe('409 request_id_conflict')
  expect(code(() => add(s, body(1, { workIdentity: 'c'.repeat(12) })))).toBe('409 request_id_conflict')
  // A retry is answered even when the board moved on since, and after the request expired.
  expect(add(s, body(), 'f'.repeat(64)).created).toBe(false)
  c.ms += HANDOFF_REQUEST_LIMITS.pendingMs
  expect(add(s, body()).request.state).toBe('expired')
  expect(s.list()).toHaveLength(1)
})

it('refuses a request made against an older revision of the task', () => {
  const s = open()
  expect(code(() => add(s, body(), 'c'.repeat(64)))).toBe('409 revision_changed')
  expect(code(() => add(s, body(), null))).toBe('409 revision_changed')
  expect(s.list()).toEqual([])
})

it('allows one pending or claimed request per work item', () => {
  const c = clock(), s = open(root(), c)
  add(s, body(1))
  expect(code(() => add(s, body(2)))).toBe('409 request_pending')
  expect(add(s, body(3, { workIdentity: 'c'.repeat(12) })).created).toBe(true)
  expect(add(s, body(4, { domain: 'personal' })).created).toBe(true)
  s.claim(uuid(1))
  expect(code(() => add(s, body(2)))).toBe('409 request_pending')
  s.report(uuid(1), { state: 'sent', receiptId: 'receipt-1' })
  expect(add(s, body(2)).created).toBe(true)
  c.ms += HANDOFF_REQUEST_LIMITS.pendingMs
  expect(add(s, body(5)).created).toBe(true)   // the pending one expired
})

it('caps requests at 40 a day (UTC), whatever became of them', () => {
  const c = clock(Date.parse('2026-09-30T23:00:00.000Z')), s = open(root(), c)
  for (let n = 1; n <= 40; n++) add(s, body(n, { workIdentity: n.toString(16).padStart(12, '0') }))
  expect(code(() => add(s, body(99, { workIdentity: 'f'.repeat(12) })))).toBe('429 daily_cap')
  c.ms = Date.parse('2026-10-01T00:00:00.000Z')
  expect(add(s, body(99, { workIdentity: 'f'.repeat(12) })).created).toBe(true)
})

it('a pending request can be claimed until 10 minutes, and never after', () => {
  const c = clock(), s = open(root(), c)
  add(s, body(1)); add(s, body(2, { workIdentity: 'c'.repeat(12) }))
  c.ms = T0 + HANDOFF_REQUEST_LIMITS.pendingMs - 1
  expect(s.claim(uuid(1))).toMatchObject({ state: 'claimed', claimedAt: '2026-09-30T15:09:59.999Z' })
  c.ms = T0 + HANDOFF_REQUEST_LIMITS.pendingMs
  expect(s.get(uuid(2))!.state).toBe('expired')
  expect(code(() => s.claim(uuid(2)))).toBe('410 request_expired')
  c.ms += 86_400_000
  expect(code(() => s.claim(uuid(2)))).toBe('410 request_expired')
  expect(s.list('pending')).toEqual([])
  expect(code(() => s.claim(uuid(7)))).toBe('404 request_not_found')
})

it('exactly one claim wins', () => {
  const s = open(); add(s, body())
  expect(s.claim(uuid(1)).state).toBe('claimed')
  expect(code(() => s.claim(uuid(1)))).toBe('409 already_claimed')
  s.report(uuid(1), { state: 'refused', reason: 'Busy' })
  expect(code(() => s.claim(uuid(1)))).toBe('409 already_claimed')
})

it('a claimed request with no result after 10 minutes is refused because Control did not report back', () => {
  const c = clock(), s = open(root(), c); add(s, body()); s.claim(uuid(1))
  c.ms = T0 + HANDOFF_REQUEST_LIMITS.claimMs - 1
  expect(s.get(uuid(1))!.state).toBe('claimed')
  c.ms = T0 + HANDOFF_REQUEST_LIMITS.claimMs
  expect(s.get(uuid(1))).toMatchObject({ state: 'refused', reason: CLAIM_TIMEOUT_REASON, resultAt: '2026-09-30T15:10:00.000Z' })
  expect(code(() => s.report(uuid(1), { state: 'sent', receiptId: 'late' }))).toBe('409 request_not_claimed')
  expect(add(s, body(2)).created).toBe(true)   // the item is free again
})

it('takes a result only from a claimed request; the same result again is answered as it was', () => {
  const c = clock(), s = open(root(), c); add(s, body())
  expect(code(() => s.report(uuid(1), { state: 'sent', receiptId: 'r-1' }))).toBe('409 request_not_claimed')
  s.claim(uuid(1)); c.ms += 1_000
  const sent = s.report(uuid(1), { state: 'sent', receiptId: 'r-1' })
  expect(sent).toMatchObject({ state: 'sent', receiptId: 'r-1', resultAt: '2026-09-30T15:00:01.000Z' })
  c.ms += 1_000
  expect(s.report(uuid(1), { state: 'sent', receiptId: 'r-1' })).toEqual(sent)
  expect(code(() => s.report(uuid(1), { state: 'refused', reason: 'No' }))).toBe('409 request_not_claimed')
  expect(code(() => s.report(uuid(1), { state: 'sent', receiptId: 'r-2' }))).toBe('409 request_not_claimed')
  add(s, body(2, { workIdentity: 'c'.repeat(12) })); c.ms += HANDOFF_REQUEST_LIMITS.pendingMs
  expect(code(() => s.report(uuid(2), { state: 'refused' }))).toBe('410 request_expired')
  expect(code(() => s.report(uuid(9), { state: 'refused' }))).toBe('404 request_not_found')
})

it('parses Control\'s result strictly and cleans its reason', () => {
  expect(parseHandoffResult({ state: 'refused', reason: 'One\nactive handoff\u0000already  ' })).toEqual({ state: 'refused', reason: 'One active handoff already' })
  expect(parseHandoffResult({ state: 'sent', receiptId: 'E621E1F8-C36C-495A-93FC-0C247A3E6E5F', reason: null })).toEqual({ state: 'sent', receiptId: 'E621E1F8-C36C-495A-93FC-0C247A3E6E5F' })
  expect(Array.from(parseHandoffResult({ state: 'refused', reason: 'r'.repeat(900) }).reason!)).toHaveLength(HANDOFF_REQUEST_LIMITS.reason)
  for (const bad of [null, {}, { state: 'claimed' }, { state: 'sent', receiptId: 'a b' }, { state: 'sent', extra: 1 }, { state: 'refused', reason: 4 }]) {
    expect(code(() => parseHandoffResult(bad))).toBe('400 invalid_handoff_request')
  }
})

it('persists across a store reload, with the states time gave them', () => {
  const dir = root(), c = clock(), s = open(dir, c)
  add(s, body(1)); add(s, body(2, { workIdentity: 'c'.repeat(12) })); add(s, body(3, { workIdentity: 'd'.repeat(12) }))
  s.claim(uuid(1)); s.report(uuid(1), { state: 'sent', receiptId: 'r-1' }); s.claim(uuid(2))
  s.close(); stores.splice(stores.indexOf(s), 1)
  const later = open(dir, c)
  expect(later.list().map(r => [r.clientRequestId, r.state])).toEqual([[uuid(1), 'sent'], [uuid(2), 'claimed'], [uuid(3), 'pending']])
  expect(later.get(uuid(3))!.note).toBe('Use the new footer.')
  expect(code(() => add(later, body(1, { note: 'changed' })))).toBe('409 request_id_conflict')
  c.ms += HANDOFF_REQUEST_LIMITS.pendingMs
  add(later, body(4, { workIdentity: 'e'.repeat(12) }))   // a write stores what time did
  const stored = JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf8')).requests.map((r: HandoffRequestRecord) => [r.clientRequestId, r.state, r.reason ?? null])
  expect(stored).toEqual([[uuid(1), 'sent', null], [uuid(2), 'refused', CLAIM_TIMEOUT_REASON], [uuid(3), 'expired', null], [uuid(4), 'pending', null]])
  expect(statSync(join(dir, 'requests.json')).mode & 0o777).toBe(0o600)
  expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
})

it('a crash in the middle of a write leaves the journal and the store as they were', () => {
  const dir = root(), c = clock(), s = open(dir, c); add(s, body(1))
  const before = readFileSync(join(dir, 'requests.json'), 'utf8')
  s.close(); stores.splice(stores.indexOf(s), 1)
  let crash = true
  const crashing = open(dir, c, (path, data) => {
    if (crash) { writeFileSync(path + '.partial.tmp', data.slice(0, 20)); throw new Error('power lost') }
    writeFileSync(path, data, { mode: 0o600 })
  })
  expect(() => add(crashing, body(2, { workIdentity: 'c'.repeat(12) }))).toThrow('power lost')
  expect(() => crashing.claim(uuid(1))).toThrow('power lost')
  expect(readFileSync(join(dir, 'requests.json'), 'utf8')).toBe(before)
  expect(crashing.get(uuid(2))).toBeUndefined()
  expect(crashing.get(uuid(1))!.state).toBe('pending')
  crash = false
  expect(add(crashing, body(2, { workIdentity: 'c'.repeat(12) })).created).toBe(true)
  expect(crashing.claim(uuid(1)).state).toBe('claimed')
})

it('drops requests older than a week on the next write', () => {
  const c = clock(), s = open(root(), c); add(s, body(1))
  c.ms += HANDOFF_REQUEST_LIMITS.retainDays * 86_400_000 + 1
  add(s, body(2))
  expect(s.list().map(r => r.clientRequestId)).toEqual([uuid(2)])
})

it('quarantines one bad record, refuses a second writer, an unsafe directory and an unreadable journal, and the optional wrapper keeps boot alive', () => {
  const dir = root(), s = open(dir); add(s, body(1))
  expect(() => new WorkHandoffRequestStore(dir)).toThrow('handoff_store_locked')
  s.close(); stores.splice(stores.indexOf(s), 1)
  const file = join(dir, 'requests.json'), journal = JSON.parse(readFileSync(file, 'utf8'))
  journal.requests.push({ clientRequestId: 'broken' }, { ...journal.requests[0] }, { ...journal.requests[0], clientRequestId: uuid(5), state: 'teleported' })
  writeFileSync(file, JSON.stringify(journal)); chmodSync(file, 0o600)
  const reopened = open(dir)
  expect(reopened.quarantineCount()).toBe(3); expect(reopened.list().map(r => r.clientRequestId)).toEqual([uuid(1)])
  const loose = root(); chmodSync(loose, 0o755)
  expect(() => new WorkHandoffRequestStore(loose)).toThrow('handoff_store_unsafe')
  const corrupt = root(); writeFileSync(join(corrupt, 'requests.json'), '{nope'); chmodSync(join(corrupt, 'requests.json'), 0o600)
  expect(() => new WorkHandoffRequestStore(corrupt)).toThrow('handoff_store_recovery_required')
  expect(createOptionalWorkHandoffRequestStore(() => new WorkHandoffRequestStore(corrupt))).toBeNull()
  expect(existsSync(join(root(), 'requests.json'))).toBe(false)
})
