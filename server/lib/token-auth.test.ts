import { describe, it, expect } from 'vitest'
import { timingSafeTokenEqual } from './token-auth.js'

describe('timingSafeTokenEqual', () => {
  const TOKEN = '_' + 'a'.repeat(43) // shape of an auto-generated base64url token

  it('accepts the exact token', () => {
    expect(timingSafeTokenEqual(TOKEN, TOKEN)).toBe(true)
  })

  it('rejects a same-length token that differs by one byte', () => {
    const wrong = TOKEN.slice(0, -1) + 'b'
    expect(timingSafeTokenEqual(wrong, TOKEN)).toBe(false)
  })

  it('rejects a shorter token without throwing (length mismatch is handled)', () => {
    expect(() => timingSafeTokenEqual('short', TOKEN)).not.toThrow()
    expect(timingSafeTokenEqual('short', TOKEN)).toBe(false)
  })

  it('rejects a longer token without throwing', () => {
    expect(timingSafeTokenEqual(TOKEN + 'extra', TOKEN)).toBe(false)
  })

  it('rejects a missing header (undefined)', () => {
    expect(timingSafeTokenEqual(undefined, TOKEN)).toBe(false)
  })

  it('rejects a duplicated header parsed as an array', () => {
    expect(timingSafeTokenEqual([TOKEN, TOKEN], TOKEN)).toBe(false)
  })

  it('rejects non-string provided values', () => {
    expect(timingSafeTokenEqual(42, TOKEN)).toBe(false)
    expect(timingSafeTokenEqual(null, TOKEN)).toBe(false)
    expect(timingSafeTokenEqual({}, TOKEN)).toBe(false)
  })

  it('rejects everything when the expected token is empty', () => {
    expect(timingSafeTokenEqual('', '')).toBe(false)
    expect(timingSafeTokenEqual('anything', '')).toBe(false)
  })

  it('matches multi-byte unicode tokens exactly', () => {
    const uni = 'token-✓-café-🔐'
    expect(timingSafeTokenEqual(uni, uni)).toBe(true)
    expect(timingSafeTokenEqual('token-x-café-🔐', uni)).toBe(false)
  })
})
