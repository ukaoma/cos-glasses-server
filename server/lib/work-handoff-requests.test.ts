import { afterEach, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkHandoffRequestStore, createOptionalWorkHandoffRequestStore, parseHandoffRequest, parseHandoffResult, handoffStatusView,
  handoffFullView, handoffRequestCapabilities, HANDOFF_REQUEST_LIMITS, type HandoffRequestRecord } from './work-handoff-requests.js'

const roots: string[] = [], stores: WorkHandoffRequestStore[] = []
afterEach(() => { vi.restoreAllMocks(); for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
const root = () => { const r = mkdtempSync(join(tmpdir(), 'handoff-requests-')); roots.push(r); return r }
const T0 = Date.parse('2026-09-30T15:00:00.000Z')
function clock(start = T0) { const c = { ms: start, now: () => new Date(c.ms) }; return c }
function open(dir = root(), c = clock(), writeFile?: (path: string, data: string) => void, options?: { timeZone?: string }) {
  const s = new WorkHandoffRequestStore(dir, c.now, writeFile, options); stores.push(s); return s
}
const REV = 'b'.repeat(64)
const C1 = 'claude:11111111-2222-4333-8444-555555555555', X1 = 'codex:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', R1 = 'cursor:99999999-8888-4777-8666-555555555555'
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
const body = (n = 1, patch: Record<string, unknown> = {}) => ({ clientRequestId: uuid(n), domain: 'business', workIdentity: 'a'.repeat(12),
  expectedTaskRevision: REV, intent: 'start', mode: 'continueSession', sessionId: C1, note: 'Use the new footer.', destinationSource: 'saved', ...patch })
const parse = (b: unknown, fallback = 'sonnet') => parseHandoffRequest(b, fallback)
/** `revision` null stands for a board row whose revision is unknown. */
function add(s: WorkHandoffRequestStore, b: Record<string, unknown>, revision: string | null = REV) {
  const { input, fingerprint } = parse(b); return s.create(input, fingerprint, revision ?? undefined)
}
const fail = (fn: () => unknown): { status?: number; code?: string; message?: string; extra?: Record<string, string> } => {
  try { fn(); return {} } catch (e) { return e as never }
}
const code = (fn: () => unknown): string => { const e = fail(fn); return e.code ? `${e.status} ${e.code}` : 'none' }
const claimOf = (s: WorkHandoffRequestStore, n: number) => s.claim(uuid(n)).claimToken!

it.each([
  ['not an object', 'x'], ['an array', []], ['an unknown field', body(1, { priority: 'high' })],
  ['the old expectedRevision field', { ...body(1), expectedRevision: REV }],
  ['a v1 uuid', body(1, { clientRequestId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' })], ['no request id', body(1, { clientRequestId: undefined })],
  ['an unsafe domain', body(1, { domain: '../business' })], ['a row id that is not 12 hex', body(1, { workIdentity: 'business-1' })],
  ['a short task revision', body(1, { expectedTaskRevision: 'b'.repeat(63) })], ['no task revision', body(1, { expectedTaskRevision: undefined })],
  ['no intent', body(1, { intent: undefined })], ['an unknown intent', body(1, { intent: 'celebrate' })],
  ['an unknown mode', body(1, { mode: 'publish' })],
  ['no destination source', body(1, { destinationSource: undefined })], ['an unknown destination source', body(1, { destinationSource: 'guess' })],
  ['Continue without a session', body(1, { sessionId: undefined })], ['Fork without a session', body(1, { mode: 'fork', sessionId: '' })],
  ['a session without a provider', body(1, { sessionId: '11111111-2222-4333-8444-555555555555' })],
  ['an Ollama session', body(1, { sessionId: 'ollama:11111111-2222-4333-8444-555555555555' })],
  ['a nested provider', body(1, { sessionId: 'claude:claude:11111111-2222-4333-8444-555555555555' })],
  ['a short session id', body(1, { sessionId: 'claude:11111111' })], ['a path in a session id', body(1, { sessionId: 'claude:../11111111-2222-4333-8444-555555555555' })],
  ['an uppercase session id', body(1, { sessionId: 'claude:11111111-2222-4333-8444-55555555555A' })],
  ['a Fork of a Cursor session', body(1, { mode: 'fork', sessionId: R1 })],
  ['a Fork model of its own platform', body(1, { mode: 'fork', sessionId: C1, model: 'opus' })],
  ['a Fork model of a platform that cannot take one', body(1, { mode: 'fork', sessionId: C1, model: 'cursor-grok' })],
  ['a New session naming a session', body(1, { mode: 'newSession' })],
  ['a model on Continue', body(1, { model: 'opus' })], ['a model slot the server does not know', body(1, { mode: 'newSession', sessionId: null, model: 'gpt-9' })],
  ['a note of 2,001 characters', body(1, { note: 'n'.repeat(2_001) })], ['a note with a bell', body(1, { note: 'ring\u0007' })],
  ['a note with a carriage return', body(1, { note: 'a\r\nb' })], ['a note with a C1 control', body(1, { note: 'a\u0085b' })],
  ['a note with a line separator', body(1, { note: 'a b' })], ['a note with a paragraph separator', body(1, { note: 'a b' })],
  ['a note with a direction override', body(1, { note: 'a‮b' })], ['a note with a zero-width space', body(1, { note: 'a​b' })],
  ['a note with a soft hyphen', body(1, { note: 'a­b' })], ['a note with a byte-order mark', body(1, { note: '﻿a' })],
  ['a note with a COS-WORK line', body(1, { note: 'Please add\ncos-work aaaaaaaaaaaa: done: shipped' })],
  ['a COS-WORK line split by bold marks', body(1, { note: 'COS**-WORK** aaaaaaaaaaaa: done: x' })],
  ['a COS-WORK line split by a backtick', body(1, { note: 'COS`-`WORK aaaaaaaaaaaa: done: x' })],
  ['a COS-WORK line split by underscores', body(1, { note: 'C__OS-WORK aaaaaaaaaaaa: done: x' })],
  ['a COS-WORK line split by a joiner', body(1, { note: 'COS\u200D-WO\u200CRK aaaaaaaaaaaa: done: x' })],
  ['a note with a lone surrogate', body(1, { note: 'a\uD800b' })], ['a note that is not text', body(1, { note: 5 })],
  ['a reply without replyTo', body(1, { intent: 'reply' })], ['Not done yet without replyTo', body(1, { intent: 'notDone' })],
  ['a start naming replyTo', body(1, { replyTo: 'receipt-1' })], ['a reply as a Fork', body(1, { intent: 'reply', replyTo: 'r', mode: 'fork', sessionId: X1 })],
  ['a reply with no note', body(1, { intent: 'reply', replyTo: 'r', note: '' })], ['a replyTo with a space', body(1, { intent: 'reply', replyTo: 'a b' })],
])('refuses %s as 400 invalid_handoff_request', (_name, raw) => {
  expect(code(() => parse(raw))).toBe('400 invalid_handoff_request')
})

it('checks the body size before its fields', () => {
  expect(fail(() => parse(body(1, { sessionId: 'x'.repeat(17_000) }))).message).toBe('The handoff request is too large.')
  expect(fail(() => parse(body(1, { sessionId: 'x'.repeat(16_000) }))).message).not.toBe('The handoff request is too large.')
})

it('accepts the contract forms, keeps newlines, tabs and joiners in a note, and counts a note in characters', () => {
  expect(parse(body(1, { clientRequestId: uuid(1).toUpperCase() })).input.clientRequestId).toBe(uuid(1))
  expect(parse(body(1, { note: 'line one\n\tline two  ' })).input.note).toBe('line one\n\tline two')
  expect(parse(body(1, { note: 'family \u{1F468}‍\u{1F469}‍\u{1F467} क्‌ष' })).input.note).toContain('‍')
  expect(parse(body(1, { note: '\u{1F377}'.repeat(2_000) })).input.note).toHaveLength(4_000)
  expect(parse(body(1, { note: 'n'.repeat(2_000) })).input.note).toHaveLength(2_000)
  expect(parse(body(1, { note: '   ' })).input).not.toHaveProperty('note')
  expect(parse(body(1, { note: null, model: '' })).input).not.toHaveProperty('note')
  expect(parse(body(1, { sessionId: R1 })).input.sessionId).toBe(R1)
  expect(parse(body(1, { mode: 'fork', sessionId: X1, model: 'opus' })).input).toMatchObject({ mode: 'fork', model: 'opus' })
  expect(parse(body(1, { mode: 'fork', sessionId: C1, model: 'codex-balanced' })).input).toMatchObject({ mode: 'fork', model: 'codex-balanced' })
  expect(parse(body(1, { mode: 'fork', sessionId: X1 })).input).not.toHaveProperty('model')
  expect(parse(body(1, { intent: 'reply', replyTo: 'E621E1F8-C36C-495A-93FC-0C247A3E6E5F' })).input).toMatchObject({ intent: 'reply', replyTo: 'E621E1F8-C36C-495A-93FC-0C247A3E6E5F' })
  expect(parse(body(1, { intent: 'notDone', replyTo: 'r-1' })).input.intent).toBe('notDone')
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
  expect(request).toMatchObject({ state: 'pending', createdAt: '2026-09-30T15:00:00.000Z', note: 'Use the new footer.', intent: 'start' })
  expect(handoffStatusView(request)).toEqual({ clientRequestId: uuid(1), state: 'pending', createdAt: '2026-09-30T15:00:00.000Z', expiresAt: '2026-09-30T15:10:00.000Z' })
  expect(handoffFullView(request)).not.toHaveProperty('fingerprint')
  expect(handoffFullView(request)).toMatchObject({ note: 'Use the new footer.', mode: 'continueSession', sessionId: C1, destinationSource: 'saved', expiresAt: '2026-09-30T15:10:00.000Z' })
})

it('is idempotent by clientRequestId: the same body is the stored request, a different body is a conflict', () => {
  const c = clock(), s = open(root(), c), first = add(s, body()).request
  expect(add(s, body())).toEqual({ request: first, created: false })
  expect(add(s, body(1, { clientRequestId: uuid(1).toUpperCase() })).created).toBe(false)
  expect(code(() => add(s, body(1, { note: 'Something else' })))).toBe('409 request_id_conflict')
  expect(code(() => add(s, body(1, { workIdentity: 'c'.repeat(12) })))).toBe('409 request_id_conflict')
  expect(code(() => add(s, body(1, { intent: 'reply', replyTo: 'r-1' })))).toBe('409 request_id_conflict')
  // A retry is answered even when the board moved on since, and after the request expired.
  expect(add(s, body(), 'f'.repeat(64)).created).toBe(false)
  c.ms += 10 * 60_000
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
  const token = claimOf(s, 1)
  expect(code(() => add(s, body(2)))).toBe('409 request_pending')
  s.report(uuid(1), { state: 'sent', receiptId: 'receipt-1', claimToken: token })
  expect(add(s, body(2)).created).toBe(true)
  c.ms += 10 * 60_000
  expect(add(s, body(5)).created).toBe(true)   // the pending one expired
})

it('caps requests at 40 a local day, whatever became of them, and says when it resets', () => {
  const c = clock(new Date(2026, 8, 30, 23, 0).getTime()), s = open(root(), c)
  for (let n = 1; n <= 40; n++) add(s, body(n, { workIdentity: n.toString(16).padStart(12, '0') }))
  const refused = fail(() => add(s, body(99, { workIdentity: 'f'.repeat(12) })))
  expect(`${refused.status} ${refused.code}`).toBe('429 daily_cap')
  expect(refused.extra).toEqual({ resetsAt: new Date(2026, 9, 1, 0, 0).toISOString() })
  expect(refused.message).toBe('The daily limit of 40 handoff requests is reached. Try again after the daily reset.')
  c.ms = new Date(2026, 9, 1, 0, 0).getTime()
  expect(add(s, body(99, { workIdentity: 'f'.repeat(12) })).created).toBe(true)
})

it('the daily cap follows the Mac\'s zone, not UTC: in Chicago it resets at 05:00Z and not at 00:00Z, on any machine', () => {
  const chicago = { timeZone: 'America/Chicago' }
  const c = clock(Date.parse('2026-09-30T23:59:00.000Z')), s = open(root(), c, undefined, chicago)   // 18:59 on Sep 30 in Chicago
  for (let n = 1; n <= 40; n++) add(s, body(n, { workIdentity: n.toString(16).padStart(12, '0') }))
  c.ms = Date.parse('2026-10-01T00:01:00.000Z')   // a new UTC day, still Sep 30 in Chicago
  const refused = fail(() => add(s, body(99, { workIdentity: 'f'.repeat(12) })))
  expect(`${refused.status} ${refused.code}`).toBe('429 daily_cap')
  expect(refused.extra).toEqual({ resetsAt: '2026-10-01T05:00:00.000Z' })
  c.ms = Date.parse('2026-10-01T04:59:59.999Z')
  expect(code(() => add(s, body(99, { workIdentity: 'f'.repeat(12) })))).toBe('429 daily_cap')
  c.ms = Date.parse('2026-10-01T05:00:00.000Z')
  expect(add(s, body(99, { workIdentity: 'f'.repeat(12) })).created).toBe(true)
  // The night the clocks go back (Nov 1, 2026): the day is 25 hours long and the reset is still the next local midnight.
  const fall = clock(Date.parse('2026-11-01T05:30:00.000Z')), t = open(root(), fall, undefined, chicago)   // 00:30 CDT
  for (let n = 1; n <= 40; n++) add(t, body(n, { workIdentity: n.toString(16).padStart(12, '0') }))
  expect(fail(() => add(t, body(99, { workIdentity: 'f'.repeat(12) }))).extra).toEqual({ resetsAt: '2026-11-02T06:00:00.000Z' })
})

it('a pending request can be claimed until 10 minutes, and never after', () => {
  const c = clock(), s = open(root(), c)
  add(s, body(1)); add(s, body(2, { workIdentity: 'c'.repeat(12) }))
  c.ms = T0 + 10 * 60_000 - 1
  const claimed = s.claim(uuid(1))
  expect(claimed).toMatchObject({ state: 'claimed', claimedAt: '2026-09-30T15:09:59.999Z' })
  expect(claimed.claimToken).toMatch(/^[a-f0-9]{32}$/)
  expect(handoffFullView(claimed)).toMatchObject({ claimExpiresAt: '2026-09-30T15:19:59.999Z' })
  expect(handoffFullView(claimed)).not.toHaveProperty('claimToken')
  expect(handoffStatusView(claimed)).toMatchObject({ claimExpiresAt: '2026-09-30T15:19:59.999Z' })
  c.ms = T0 + 10 * 60_000
  expect(s.get(uuid(2))!.state).toBe('expired')
  expect(code(() => s.claim(uuid(2)))).toBe('410 request_expired')
  c.ms += 86_400_000
  expect(code(() => s.claim(uuid(2)))).toBe('410 request_expired')
  expect(s.list('pending')).toEqual([])
  expect(code(() => s.claim(uuid(7)))).toBe('404 request_not_found')
})

it('exactly one claim wins; its own token claims again, any other does not', () => {
  const s = open(); add(s, body())
  const token = claimOf(s, 1)
  expect(code(() => s.claim(uuid(1)))).toBe('409 already_claimed')
  expect(code(() => s.claim(uuid(1), 'f'.repeat(32)))).toBe('409 already_claimed')
  expect(s.claim(uuid(1), token)).toMatchObject({ state: 'claimed', claimToken: token })
  s.report(uuid(1), { state: 'refused', reason: 'Busy', claimToken: token })
  expect(code(() => s.claim(uuid(1), token))).toBe('409 already_claimed')
})

it('a claim with no result after 10 minutes is unconfirmed, and takes exactly one late result', () => {
  const c = clock(), s = open(root(), c); add(s, body()); const token = claimOf(s, 1)
  c.ms = T0 + 10 * 60_000 - 1
  expect(s.get(uuid(1))!.state).toBe('claimed')
  c.ms = T0 + 10 * 60_000
  const unconfirmed = s.get(uuid(1))!
  expect(unconfirmed.state).toBe('unconfirmed'); expect(unconfirmed).not.toHaveProperty('resultAt'); expect(unconfirmed).not.toHaveProperty('reason')
  expect(code(() => s.claim(uuid(1), token))).toBe('409 already_claimed')
  c.ms += 3_600_000
  expect(s.report(uuid(1), { state: 'sent', receiptId: 'late-receipt', claimToken: token })).toMatchObject({ state: 'sent', receiptId: 'late-receipt' })
  expect(s.report(uuid(1), { state: 'sent', receiptId: 'late-receipt', claimToken: token }).state).toBe('sent')
  expect(code(() => s.report(uuid(1), { state: 'unresolved', receiptId: 'late-receipt', claimToken: token }))).toBe('409 request_not_claimed')
  expect(add(s, body(2)).created).toBe(true)   // the item is free again
})

it('takes a result only from a claimed request under its token; the same result again is answered as it was', () => {
  const c = clock(), s = open(root(), c); add(s, body())
  expect(code(() => s.report(uuid(1), { state: 'sent', receiptId: 'r-1', claimToken: 'f'.repeat(32) }))).toBe('409 request_not_claimed')
  const token = claimOf(s, 1); c.ms += 1_000
  expect(code(() => s.report(uuid(1), { state: 'sent', receiptId: 'r-1', claimToken: 'f'.repeat(32) }))).toBe('409 claim_token_mismatch')
  const unresolved = s.report(uuid(1), { state: 'unresolved', receiptId: 'r-1', claimToken: token })
  expect(unresolved).toMatchObject({ state: 'unresolved', receiptId: 'r-1', resultAt: '2026-09-30T15:00:01.000Z' })
  c.ms += 1_000
  expect(s.report(uuid(1), { state: 'unresolved', receiptId: 'r-1', claimToken: token })).toEqual(unresolved)
  expect(code(() => s.report(uuid(1), { state: 'refused', reason: 'No', claimToken: token }))).toBe('409 request_not_claimed')
  expect(code(() => s.report(uuid(1), { state: 'unresolved', receiptId: 'r-2', claimToken: token }))).toBe('409 request_not_claimed')
  add(s, body(2, { workIdentity: 'c'.repeat(12) })); c.ms += 10 * 60_000
  expect(code(() => s.report(uuid(2), { state: 'refused', reason: 'x', claimToken: token }))).toBe('410 request_expired')
  expect(code(() => s.report(uuid(9), { state: 'refused', reason: 'x', claimToken: token }))).toBe('404 request_not_found')
})

it('a time more than 5 minutes ahead of the clock: a pending request is expired, a claimed one unconfirmed', () => {
  const dir = root(), c = clock(), s = open(dir, c)
  add(s, body(1)); add(s, body(2, { workIdentity: 'c'.repeat(12) })); const token = claimOf(s, 2)
  s.close(); stores.splice(stores.indexOf(s), 1)
  const behind = clock(T0 - 5 * 60_000), same = open(dir, behind)
  expect(same.list().map(r => r.state)).toEqual(['pending', 'claimed'])   // exactly 5 minutes: still within the skew
  behind.ms -= 1
  // A pending request expires; a claimed one is unconfirmed, never expired: Control may have sent it and can still say so.
  expect(same.list().map(r => r.state)).toEqual(['expired', 'unconfirmed'])
  expect(code(() => same.claim(uuid(1)))).toBe('410 request_expired')
  expect(same.report(uuid(2), { state: 'sent', receiptId: 'r', claimToken: token })).toMatchObject({ state: 'sent', receiptId: 'r' })
  // A claim made while the clock ran ahead: its createdAt is fine, its claimedAt is 7 minutes in the future.
  const jumpy = clock(), other = open(root(), jumpy)
  add(other, body(3)); jumpy.ms = T0 + 8 * 60_000; const late = claimOf(other, 3); jumpy.ms = T0 + 60_000
  expect(other.get(uuid(3))!.state).toBe('unconfirmed')
  expect(other.report(uuid(3), { state: 'unresolved', receiptId: 'r', claimToken: late }).state).toBe('unresolved')
  expect(code(() => other.report(uuid(3), { state: 'sent', receiptId: 'r', claimToken: late }))).toBe('409 request_not_claimed')
})

it('logs a time-made transition once, with the id and never the note', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const c = clock(), s = open(root(), c); add(s, body(1)); add(s, body(2, { workIdentity: 'c'.repeat(12) })); claimOf(s, 2)
  c.ms += 10 * 60_000
  s.list(); s.list(); s.get(uuid(1))
  const lines = warn.mock.calls.map(call => String(call[0]))
  expect(lines.filter(line => line.includes(uuid(1)))).toEqual([`[work-handoff-requests] ${uuid(1)} expired: COS Control did not claim it in time`])
  expect(lines.filter(line => line.includes(uuid(2)))).toEqual([`[work-handoff-requests] ${uuid(2)} unconfirmed: COS Control claimed it and did not report back`])
  expect(lines.join('\n')).not.toContain('Use the new footer')
})

it('parses Control\'s result strictly and cleans its reason', () => {
  const token = 'a'.repeat(32)
  expect(parseHandoffResult({ state: 'refused', reason: 'One\nactive handoff\u0000already  ', claimToken: token })).toEqual({ state: 'refused', reason: 'One active handoff already', claimToken: token })
  expect(parseHandoffResult({ state: 'sent', receiptId: 'E621E1F8-C36C-495A-93FC-0C247A3E6E5F', reason: null, claimToken: token })).toEqual({ state: 'sent', receiptId: 'E621E1F8-C36C-495A-93FC-0C247A3E6E5F', claimToken: token })
  expect(parseHandoffResult({ state: 'unresolved', receiptId: 'r', claimToken: token }).state).toBe('unresolved')
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}', cut = parseHandoffResult({ state: 'refused', reason: family.repeat(600), claimToken: token }).reason!
  expect(cut).toBe(family.repeat(500))
  for (const bad of [null, {}, { state: 'claimed', claimToken: token }, { state: 'sent', claimToken: token }, { state: 'unresolved', claimToken: token },
    { state: 'refused', claimToken: token }, { state: 'refused', reason: '\u0000 ', claimToken: token }, { state: 'sent', receiptId: 'r' },
    { state: 'sent', receiptId: 'r', claimToken: 'short' }, { state: 'sent', receiptId: 'a b', claimToken: token },
    { state: 'sent', receiptId: 'r', claimToken: token, extra: 1 }, { state: 'refused', reason: 4, claimToken: token }]) {
    expect(code(() => parseHandoffResult(bad))).toBe('400 invalid_handoff_request')
  }
})

it('persists across a store reload, with the states time gave them', () => {
  const dir = root(), c = clock(), s = open(dir, c)
  add(s, body(1)); add(s, body(2, { workIdentity: 'c'.repeat(12) })); add(s, body(3, { workIdentity: 'd'.repeat(12) }))
  s.report(uuid(1), { state: 'sent', receiptId: 'r-1', claimToken: claimOf(s, 1) }); const token2 = claimOf(s, 2)
  s.close(); stores.splice(stores.indexOf(s), 1)
  const later = open(dir, c)
  expect(later.list().map(r => [r.clientRequestId, r.state])).toEqual([[uuid(1), 'sent'], [uuid(2), 'claimed'], [uuid(3), 'pending']])
  expect(later.get(uuid(3))!.note).toBe('Use the new footer.')
  expect(later.claim(uuid(2), token2).state).toBe('claimed')   // the token survives a restart
  expect(code(() => add(later, body(1, { note: 'changed' })))).toBe('409 request_id_conflict')
  c.ms += 10 * 60_000
  add(later, body(4, { workIdentity: 'e'.repeat(12) }))   // a write stores what time did
  const stored = JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf8')).requests.map((r: HandoffRequestRecord) => [r.clientRequestId, r.state])
  expect(stored).toEqual([[uuid(1), 'sent'], [uuid(2), 'unconfirmed'], [uuid(3), 'expired'], [uuid(4), 'pending']])
  expect(statSync(join(dir, 'requests.json')).mode & 0o777).toBe(0o600)
  expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
})

it('a long reason cut in whole characters survives a restart', () => {
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', reason = family.repeat(120) + 'x'.repeat(43)
  expect(Array.from(reason)).toHaveLength(643)   // 163 characters, 643 code points
  const dir = root(), c = clock(), s = open(dir, c); add(s, body(1))
  const token = claimOf(s, 1), parsed = parseHandoffResult({ state: 'refused', reason, claimToken: token })
  expect(parsed.reason).toBe(reason)
  s.report(uuid(1), parsed)
  s.close(); stores.splice(stores.indexOf(s), 1)
  const later = open(dir, c)
  expect(later.quarantineCount()).toBe(0)
  expect(later.get(uuid(1))).toMatchObject({ state: 'refused', reason })
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

it('keeps a request 7 days: one 6 days old stays, one 8 days old goes on the next write', () => {
  const c = clock(), s = open(root(), c)
  add(s, body(1)); c.ms += 2 * 86_400_000; add(s, body(2, { workIdentity: 'c'.repeat(12) }))
  c.ms += 6 * 86_400_000
  add(s, body(3, { workIdentity: 'd'.repeat(12) }))
  expect(s.list().map(r => r.clientRequestId)).toEqual([uuid(2), uuid(3)])
})

it('quarantines bad records (a New session with no model among them), ages them out after 7 days, and refuses unsafe stores', () => {
  const dir = root(), c = clock(), s = open(dir, c); add(s, body(1))
  expect(() => new WorkHandoffRequestStore(dir)).toThrow('handoff_store_locked')
  s.close(); stores.splice(stores.indexOf(s), 1)
  const file = join(dir, 'requests.json'), journal = JSON.parse(readFileSync(file, 'utf8')), good = journal.requests[0]
  journal.requests.push({ clientRequestId: 'broken' }, { ...good }, { ...good, clientRequestId: uuid(5), state: 'teleported' },
    { ...good, clientRequestId: uuid(6), mode: 'newSession', sessionId: undefined, model: undefined },
    { ...good, clientRequestId: uuid(7), state: 'claimed', claimedAt: good.createdAt })
  writeFileSync(file, JSON.stringify(journal)); chmodSync(file, 0o600)
  const reopened = open(dir, c)
  expect(reopened.quarantineCount()).toBe(5); expect(reopened.list().map(r => r.clientRequestId)).toEqual([uuid(1)])
  c.ms += 6 * 86_400_000; add(reopened, body(2, { workIdentity: 'c'.repeat(12) }))
  expect(reopened.quarantineCount()).toBe(5)
  c.ms += 2 * 86_400_000; add(reopened, body(3, { workIdentity: 'd'.repeat(12) }))
  expect(reopened.quarantineCount()).toBe(0)
  expect(JSON.parse(readFileSync(file, 'utf8')).quarantined).toEqual([])
  const loose = root(); chmodSync(loose, 0o755)
  expect(() => new WorkHandoffRequestStore(loose)).toThrow('handoff_store_unsafe')
  const corrupt = root(); writeFileSync(join(corrupt, 'requests.json'), '{nope'); chmodSync(join(corrupt, 'requests.json'), 0o600)
  expect(() => new WorkHandoffRequestStore(corrupt)).toThrow('handoff_store_recovery_required')
  expect(createOptionalWorkHandoffRequestStore(() => new WorkHandoffRequestStore(corrupt))).toBeNull()
  expect(existsSync(join(root(), 'requests.json'))).toBe(false)
})

it('tells the glasses requests are on only while COS Control lists pending ones, for 120 s', () => {
  const c = clock(), s = open(root(), c)
  expect(handoffRequestCapabilities(null, c.ms)).toEqual({ requests: 0, requestsInbox: 0, requestsConsumerSeenAt: null })
  expect(handoffRequestCapabilities(s, c.ms)).toEqual({ requests: 0, requestsInbox: 1, requestsConsumerSeenAt: null })
  s.noteConsumer()
  expect(handoffRequestCapabilities(s, c.ms + 120_000)).toEqual({ requests: 1, requestsInbox: 1, requestsConsumerSeenAt: '2026-09-30T15:00:00.000Z' })
  expect(handoffRequestCapabilities(s, c.ms + 120_001)).toEqual({ requests: 0, requestsInbox: 1, requestsConsumerSeenAt: '2026-09-30T15:00:00.000Z' })
})
