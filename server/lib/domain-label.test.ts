import { describe, expect, it } from 'vitest'
import { domainLabel } from './domain-label.js'

describe('domainLabel', () => {
  it('title-cases a snake_case key', () => {
    expect(domainLabel('hermit_crabs')).toBe('Hermit Crabs')
    expect(domainLabel('sprocket_rocket')).toBe('Sprocket Rocket')
    expect(domainLabel('quilt')).toBe('Quilt')
    expect(domainLabel('personal')).toBe('Personal')
  })

  it('returns a name the user wrote as prose unchanged', () => {
    // "DNP study" is a real domain someone named. Title-casing it would be this
    // helper second-guessing the user's own label, which is the habit that put
    // one person's business units in everyone's build. Only separator-joined
    // keys get derived; anything already capitalised or spaced is theirs.
    expect(domainLabel('DNP study')).toBe('DNP study')
    expect(domainLabel('iOS')).toBe('iOS')
    expect(domainLabel('Side Hustle')).toBe('Side Hustle')
  })

  it('handles hyphens and repeated separators', () => {
    expect(domainLabel('side-hustle')).toBe('Side Hustle')
    expect(domainLabel('a__b')).toBe('A B')
  })

  it('is total over degenerate input', () => {
    expect(domainLabel('')).toBe('')
    expect(domainLabel('_')).toBe('_')
    expect(domainLabel('x')).toBe('X')
  })
})
