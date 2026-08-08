import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_DOMAINS,
  FALLBACK_DOMAIN,
  classifyDomain,
  configuredDomains,
  discoveredDomains,
  domainAbbreviation,
  domainForMeeting,
  domainNames,
  isSafeDomainName,
  resolveDomains,
} from './domains.js'
import { clearProfileCache } from './profile.js'

let home = ''
let ops = ''
const previousProfile = process.env.COS_PROFILE_PATH

/** Write a `.cos-profile.json`, or remove it to simulate an unconfigured COS. */
function profile(contents: Record<string, unknown> | null): void {
  const path = join(home, '.cos-profile.json')
  if (contents === null) rmSync(path, { force: true })
  else writeFileSync(path, JSON.stringify(contents))
  process.env.COS_PROFILE_PATH = path
  clearProfileCache()
}

/** A domain folder on disk: `{ops}/{name}/meetings/2026-08`. */
function domainDir(name: string): void {
  mkdirSync(join(ops, name, 'meetings', '2026-08'), { recursive: true })
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cos-domains-home-'))
  ops = mkdtempSync(join(tmpdir(), 'cos-domains-ops-'))
  profile(null)
})

afterEach(() => {
  if (previousProfile == null) delete process.env.COS_PROFILE_PATH
  else process.env.COS_PROFILE_PATH = previousProfile
  clearProfileCache()
  for (const d of [home, ops]) if (d) rmSync(d, { recursive: true, force: true })
})

describe('an existing install is not touched', () => {
  // THE CONSTRAINT. Miles asked for defaults for new users and said "Don't
  // overwrite my setup tho that should continue". His profile has no `domains`
  // key, so a naive default would have replaced his four business domains with
  // personal+business. The union is what protects him — no migration, no profile
  // write, nothing to go wrong.
  it('keeps four discovered domains when the profile configures none', () => {
    for (const d of ['quilt', 'sprocket_rocket', 'hermit_crabs', 'personal']) domainDir(d)
    profile({ owner_name: 'Miles', vocabulary: [] })
    expect(configuredDomains()).toEqual([])
    expect(domainNames(ops).sort())
      .toEqual(['hermit_crabs', 'personal', 'quilt', 'sprocket_rocket'])
  })

  it('does NOT apply the defaults when folders exist', () => {
    for (const d of ['quilt', 'personal']) domainDir(d)
    expect(domainNames(ops)).not.toContain('business')
  })

  it('keeps his badges exactly as they were', () => {
    // The hand-written table this replaced said quilt Q, personal P,
    // hermit_crabs HC, sprocket_rocket SR. Derivation must reproduce it, or every
    // existing row silently relabels.
    expect(domainAbbreviation('quilt')).toBe('Q')
    expect(domainAbbreviation('personal')).toBe('P')
    expect(domainAbbreviation('hermit_crabs')).toBe('HC')
    expect(domainAbbreviation('sprocket_rocket')).toBe('SR')
  })
})

describe('a brand-new COS gets two domains', () => {
  it('defaults to personal and business when nothing is configured or on disk', () => {
    expect(domainNames(ops)).toEqual(['personal', 'business'])
    expect([...DEFAULT_DOMAINS]).toEqual(['personal', 'business'])
  })

  it('derives P and B rather than someone else initials', () => {
    expect(domainAbbreviation('personal')).toBe('P')
    expect(domainAbbreviation('business')).toBe('B')
  })

  it('still defaults when the operations dir does not exist at all', () => {
    expect(domainNames(join(ops, 'nope'))).toEqual(['personal', 'business'])
    expect(domainNames(null)).toEqual(['personal', 'business'])
  })
})

describe('the user sets their own domains', () => {
  it('accepts a bare string list, the shortest thing anyone will write', () => {
    profile({ domains: ['personal', 'work', 'nonprofit'] })
    expect(domainNames(ops)).toEqual(['personal', 'work', 'nonprofit'])
  })

  it('accepts objects with keywords and a badge override', () => {
    profile({ domains: [{ name: 'DNP study', abbr: 'DNP', keywords: ['cohort', 'dissertation'] }] })
    const resolved = resolveDomains(ops)
    expect(resolved[0].name).toBe('DNP study')
    expect(domainAbbreviation('DNP study', resolved)).toBe('DNP')
  })

  it('lists a configured domain that has no folder yet, so routing works on day one', () => {
    profile({ domains: ['work'] })
    expect(discoveredDomains(ops)).toEqual([])
    expect(domainNames(ops)).toEqual(['work'])
  })

  it('never hides a folder the user made by hand', () => {
    profile({ domains: ['work'] })
    domainDir('side project')
    expect(domainNames(ops)).toEqual(['work', 'side project'])
  })

  it('does not duplicate a domain that is both configured and on disk', () => {
    profile({ domains: ['work'] })
    domainDir('work')
    expect(domainNames(ops)).toEqual(['work'])
  })

  it('drops unsafe and malformed entries instead of failing the whole list', () => {
    profile({ domains: ['work', '../escape', '', 42, { keywords: ['x'] }, '.hidden', 'work'] })
    expect(domainNames(ops)).toEqual(['work'])
  })
})

describe('a domain must hold the shape the lister actually reads', () => {
  it('ignores a meetings/ folder with no YYYY-MM month directories', () => {
    // Measured on a real install: operations/archive/meetings/ holds domain names
    // rather than months, so a bare isDirectory() check listed `archive` as a
    // domain with permanently zero meetings.
    mkdirSync(join(ops, 'archive', 'meetings', 'quilt'), { recursive: true })
    mkdirSync(join(ops, 'archive', 'meetings', 'personal'), { recursive: true })
    domainDir('personal')
    expect(discoveredDomains(ops)).toEqual(['personal'])
  })

  it('ignores an entirely empty meetings/ folder', () => {
    mkdirSync(join(ops, 'stub', 'meetings'), { recursive: true })
    expect(discoveredDomains(ops)).toEqual([])
  })

  it('accepts a month directory even before any file lands in it', () => {
    // A folder created by the pipeline moments before the first save must not
    // vanish from the list.
    mkdirSync(join(ops, 'work', 'meetings', '2026-08'), { recursive: true })
    expect(discoveredDomains(ops)).toEqual(['work'])
  })
})

describe('name safety is a safety check, not a naming policy', () => {
  it('permits the names the old pattern rejected', () => {
    // /^[a-z][a-z0-9_]{0,31}$/ accepted sprocket_rocket and rejected DNP study.
    expect(isSafeDomainName('DNP study')).toBe(true)
    expect(isSafeDomainName('Ascension')).toBe(true)
    expect(isSafeDomainName('recherche')).toBe(true)
  })

  it('still blocks traversal and control characters', () => {
    for (const bad of ['..', '.', '', 'a/b', 'a\\b', '.hidden', ' leading', 'trailing ']) {
      expect(isSafeDomainName(bad), `${JSON.stringify(bad)} must be rejected`).toBe(false)
    }
    expect(isSafeDomainName('a\u0000b')).toBe(false)
    expect(isSafeDomainName('a\nb')).toBe(false)
    expect(isSafeDomainName('x'.repeat(65))).toBe(false)
  })
})

describe('badges cover the short forms the companion uses', () => {
  it('keeps sr and hc whole instead of taking a first initial', () => {
    // The companion's session list keys on the short forms. First-initial
    // derivation would render them "S" and "H".
    expect(domainAbbreviation('sr')).toBe('SR')
    expect(domainAbbreviation('hc')).toBe('HC')
    expect(domainAbbreviation('q')).toBe('Q')
  })

  it('still derives initials for real multi-word names', () => {
    expect(domainAbbreviation('DNP study')).toBe('DS')
    expect(domainAbbreviation('hermit_crabs')).toBe('HC')
    expect(domainAbbreviation('research-lab notes')).toBe('RL')
  })

  it('never returns an empty badge', () => {
    expect(domainAbbreviation('___')).toBe('?')
    expect(domainAbbreviation('')).toBe('?')
  })
})

describe('classification routes a meeting by content', () => {
  const two = [
    { name: 'personal', keywords: undefined },
    { name: 'business', keywords: undefined },
  ]

  it('sends a work conversation to business', () => {
    const hit = classifyDomain(
      'Pipeline review with the client about Q3 revenue and the launch deadline', two)
    expect(hit?.domain).toBe('business')
  })

  it('sends a family conversation to personal', () => {
    const hit = classifyDomain(
      'Talked with my wife about the kids school and a dentist appointment', two)
    expect(hit?.domain).toBe('personal')
  })

  it('returns null rather than guessing when nothing matches', () => {
    expect(classifyDomain('mm hmm yeah okay right', two)).toBeNull()
    expect(classifyDomain('', two)).toBeNull()
  })

  it('counts DISTINCT keywords, so one repeated word cannot outvote four signals', () => {
    const repeated = 'client client client client client client client client'
    const varied = 'family kids school dentist'
    const hit = classifyDomain(`${repeated} ${varied}`, two)
    expect(hit?.domain).toBe('personal')
    expect(hit?.score).toBe(4)
  })

  it('matches on word boundaries, not substrings', () => {
    // "house" must not fire inside "housekeeping"; "demo" not inside "democracy".
    expect(classifyDomain('housekeeping and democracy', two)).toBeNull()
  })

  it('uses the user own keywords when they set them', () => {
    const custom = [
      { name: 'clinicals', keywords: ['rotation', 'preceptor'] },
      { name: 'personal', keywords: ['dinner'] },
    ]
    expect(classifyDomain('Reviewed the rotation with my preceptor', custom)?.domain).toBe('clinicals')
  })

  it('breaks a tie on configured order, so the user controls it', () => {
    const a = [{ name: 'first', keywords: ['x'] }, { name: 'second', keywords: ['y'] }]
    expect(classifyDomain('x and y', a)?.domain).toBe('first')
    const b = [{ name: 'second', keywords: ['y'] }, { name: 'first', keywords: ['x'] }]
    expect(classifyDomain('x and y', b)?.domain).toBe('second')
  })
})

describe('domainForMeeting decides what a save is filed under', () => {
  it('honours an explicit choice from the client over inference', () => {
    profile({ domains: ['personal', 'business'] })
    expect(domainForMeeting('personal', 'client revenue pipeline launch', ops)).toBe('personal')
  })

  it('infers when the client sends nothing', () => {
    profile({ domains: ['personal', 'business'] })
    expect(domainForMeeting(undefined, 'client revenue pipeline launch', ops)).toBe('business')
  })

  it('falls back to personal, the safe direction, when nothing scores', () => {
    profile({ domains: ['personal', 'business'] })
    expect(domainForMeeting(undefined, 'mm hmm okay', ops)).toBe(FALLBACK_DOMAIN)
  })

  it('does not invent a personal domain for a COS that has none', () => {
    // Filing into a domain the user never created would be worse than using one
    // they did.
    profile({ domains: ['work', 'nonprofit'] })
    expect(domainForMeeting(undefined, 'mm hmm okay', ops)).toBe('work')
  })

  it('refuses an unsafe explicit domain instead of building a path from it', () => {
    profile({ domains: ['personal', 'business'] })
    expect(domainForMeeting('../../etc', 'mm hmm okay', ops)).toBe(FALLBACK_DOMAIN)
  })
})
