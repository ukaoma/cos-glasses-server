// Key lanes P1 (plan v4 5.1): parsePreference accepts profiles; the closed guards do not move.
import { describe, expect, it } from 'vitest'
import { isModelPreference, normalizeModelPreference, MODEL_OPTIONS } from './model-preference.js'
import { isKeyProfileId, isProfilePreference, parsePreference, parseV1KeyModelName, profilePreference, v1KeyModelName } from './key-preference.js'

describe('parsePreference', () => {
  it('model slots parse exactly as normalizeModelPreference does, codex-high migration included', () => {
    for (const m of [...MODEL_OPTIONS, 'haiku', 'codex-high']) {
      expect(parsePreference(m)).toEqual({ kind: 'model', value: normalizeModelPreference(m) })
    }
  })

  it('profile:<id> parses to a profile; a bare id, a bad id and other junk are undefined', () => {
    expect(parsePreference('profile:sonnet')).toEqual({ kind: 'profile', id: 'sonnet' })
    expect(parsePreference('profile:my-key-2')).toEqual({ kind: 'profile', id: 'my-key-2' })
    for (const v of ['sonnet-key', 'profile:', 'profile:Bad', 'profile:-x', `profile:${'a'.repeat(33)}`, 'profile:a b', 42, null, undefined, {}]) {
      expect(parsePreference(v), String(v)).toBeUndefined()
    }
  })

  it('the closed guards still refuse every profile form', () => {
    for (const v of ['profile:sonnet', 'cos-key-sonnet', 'sonnet-key']) {
      expect(isModelPreference(v)).toBe(false)
      expect(normalizeModelPreference(v)).toBeUndefined()
    }
  })

  it('formatters round-trip and refuse malformed ids', () => {
    expect(parsePreference(profilePreference('abc'))).toEqual({ kind: 'profile', id: 'abc' })
    expect(isProfilePreference('profile:abc')).toBe(true)
    expect(isProfilePreference('opus')).toBe(false)
    expect(() => profilePreference('ABC')).toThrow()
    expect(parseV1KeyModelName(v1KeyModelName('abc'))).toBe('abc')
    expect(parseV1KeyModelName('cos-key-')).toBeUndefined()
    expect(parseV1KeyModelName('cos-opus')).toBeUndefined()
    expect(isKeyProfileId('a'.repeat(32))).toBe(true)
    expect(isKeyProfileId('a'.repeat(33))).toBe(false)
  })
})
