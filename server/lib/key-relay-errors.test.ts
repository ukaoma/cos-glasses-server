// Key lanes P2 (plan v4 4.6): status mapping, breaker counting, error shapes, redaction.
import { describe, expect, it } from 'vitest'
import {
  RelayBreakers,
  breakerScopeFor,
  classifyUpstreamStatus,
  countsTowardBreaker,
  endsTurn,
  parseRetryAfterSeconds,
  redactSecrets,
  relayErrorBody,
} from './key-relay-errors.js'
import { BREAKER_LIMITS } from './key-relay-contract.js'

describe('key relay status mapping (plan 4.6)', () => {
  it('maps each upstream row', () => {
    expect(classifyUpstreamStatus(200)).toBeNull()
    expect(classifyUpstreamStatus(401)).toBe('key_rejected')
    expect(classifyUpstreamStatus(402)).toBe('out_of_credit')
    expect(classifyUpstreamStatus(404)).toBe('model_gone')
    expect(classifyUpstreamStatus(400, '{"error":{"message":"model not found: anthropic/claude-x"}}')).toBe('model_gone')
    expect(classifyUpstreamStatus(400, '{"error":{"message":"No endpoints found for anthropic/claude-x."}}')).toBe('model_gone')
    expect(classifyUpstreamStatus(400, '{"error":{"message":"max_tokens too large"}}')).toBeNull()
    expect(classifyUpstreamStatus(429)).toBe('rate_limited')
    expect(classifyUpstreamStatus(500)).toBe('upstream_error')
    expect(classifyUpstreamStatus(529)).toBe('upstream_error')
    expect(classifyUpstreamStatus(403)).toBeNull()
  })

  it('only 401, 402 and model-gone count toward the breaker', () => {
    expect(countsTowardBreaker('key_rejected')).toBe(true)
    expect(countsTowardBreaker('out_of_credit')).toBe(true)
    expect(countsTowardBreaker('model_gone')).toBe(true)
    for (const k of ['rate_limited', 'upstream_error', 'network_error', 'cap_refused', 'model_not_allowed'] as const) expect(countsTowardBreaker(k)).toBe(false)
    expect(countsTowardBreaker(null)).toBe(false)
    expect(breakerScopeFor('key_rejected')).toBe('key')
    expect(breakerScopeFor('out_of_credit')).toBe('key')
    expect(breakerScopeFor('model_gone')).toBe('profile')
  })

  it('ends the turn only on cap, key, credit and model-gone rows', () => {
    expect(endsTurn('cap_refused')).toBe(true)
    expect(endsTurn('key_rejected')).toBe(true)
    expect(endsTurn('out_of_credit')).toBe(true)
    expect(endsTurn('model_gone')).toBe(true)
    expect(endsTurn('rate_limited')).toBe(false)
    expect(endsTurn('upstream_error')).toBe(false)
    expect(endsTurn('network_error')).toBe(false)
  })

  it('answers in the caller error shape', () => {
    const a = relayErrorBody('claude', 'cap_refused')
    expect(a.status).toBe(402)
    expect(JSON.parse(a.body)).toEqual({ type: 'error', error: { type: 'billing_error', message: 'Daily cap reached for this key.' } })
    const o = relayErrorBody('codex', 'nonce_invalid')
    expect(o.status).toBe(401)
    expect(JSON.parse(o.body).error.code).toBe('nonce_invalid')
    expect(relayErrorBody('claude', 'network_error')).toMatchObject({ status: 502 })
    expect(JSON.parse(relayErrorBody('claude', 'network_error').body).error.type).toBe('overloaded_error')
    expect(JSON.parse(relayErrorBody('claude', 'model_not_allowed').body).error.message).toBe('Model not allowed on this key profile')
  })

  it('user-facing copy has no em dashes or arrows', () => {
    for (const e of ['nonce_invalid', 'cap_refused', 'model_not_allowed', 'network_error', 'not_found', 'bad_request', 'too_large', 'too_many_in_flight', 'browser_refused'] as const) {
      for (const engine of ['claude', 'codex'] as const) expect(relayErrorBody(engine, e).body).not.toMatch(/[—–→←]/)
    }
  })

  it('redacts every occurrence of a secret', () => {
    const k = 'sk-or-v1-abcdefabcdefabcdef'
    expect(redactSecrets(`a ${k} b Bearer ${k}`, [k])).toBe('a [redacted] b Bearer [redacted]')
    expect(redactSecrets('nothing here', [k, null, undefined])).toBe('nothing here')
  })

  it('reads Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfterSeconds('7')).toBe(7)
    expect(parseRetryAfterSeconds(new Date(10_000).toUTCString(), () => 4_000)).toBe(6)
    expect(parseRetryAfterSeconds('soon')).toBeNull()
    expect(parseRetryAfterSeconds(undefined)).toBeNull()
  })
})

describe('key relay breaker (plan 4.6)', () => {
  it('opens after 3 consecutive counted failures and stays open for an hour', () => {
    let now = 1_000_000
    const opened: string[] = []
    const b = new RelayBreakers(() => now, (scope, id) => opened.push(`${scope}:${id}`))
    expect(b.record('key', 'k', 'key_rejected', false)).toBe(false)
    expect(b.record('key', 'k', 'out_of_credit', false)).toBe(false)
    expect(b.record('key', 'k', 'key_rejected', false)).toBe(true)
    expect(b.isOpen('key', 'k')).toBe(true)
    expect(opened).toEqual(['key:k'])
    expect(b.state('key', 'k')).toMatchObject({ open: true, failures: 3 })
    now += BREAKER_LIMITS.openMs - 1
    expect(b.isOpen('key', 'k')).toBe(true)
    now += 1
    expect(b.isOpen('key', 'k')).toBe(false)
    expect(b.state('key', 'k')).toEqual({ open: false, failures: 0 })
  })

  it('a 429, 5xx or network failure never counts and never resets', () => {
    const b = new RelayBreakers()
    for (let i = 0; i < 5; i++) b.record('key', 'k', 'rate_limited', false)
    for (let i = 0; i < 5; i++) b.record('key', 'k', 'upstream_error', false)
    expect(b.state('key', 'k')).toEqual({ open: false, failures: 0 })
    b.record('key', 'k', 'key_rejected', false)
    b.record('key', 'k', 'rate_limited', false)
    b.record('key', 'k', 'key_rejected', false)
    expect(b.state('key', 'k').failures).toBe(2)
  })

  it('a success resets the count; reset() closes an open breaker', () => {
    const b = new RelayBreakers()
    b.record('profile', 'p', 'model_gone', false)
    b.record('profile', 'p', 'model_gone', false)
    b.record('profile', 'p', null, true)
    b.record('profile', 'p', 'model_gone', false)
    expect(b.isOpen('profile', 'p')).toBe(false)
    b.record('profile', 'p', 'model_gone', false)
    b.record('profile', 'p', 'model_gone', false)
    expect(b.isOpen('profile', 'p')).toBe(true)
    b.reset('profile', 'p')
    expect(b.isOpen('profile', 'p')).toBe(false)
  })
})
