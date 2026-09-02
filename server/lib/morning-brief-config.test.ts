import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MORNING_BRIEF_LIMITS,
  MORNING_BRIEF_SOURCES,
  MorningBriefConfigError,
  applyMorningBriefPatch,
  coerceMorningBriefConfig,
  defaultMorningBriefConfig,
  loadMorningBriefConfig,
  loadMorningBriefLedger,
  morningBriefPaths,
  normalizeSources,
  saveMorningBriefConfig,
  saveMorningBriefLedger,
} from './morning-brief-config.js'

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cos-morning-brief-config-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('defaults', () => {
  it('is on, weekdays at 07:00, in the machine zone, with the catalog in catalog order', () => {
    const config = defaultMorningBriefConfig()
    expect(config.enabled).toBe(true)
    expect(config.time).toBe('07:00')
    expect(config.days).toEqual([1, 2, 3, 4, 5])
    expect(config.sources.map(source => source.id)).toEqual(MORNING_BRIEF_SOURCES.map(spec => spec.id))
    expect(config.sources.filter(source => source.enabled).map(source => source.id))
      .toEqual(['calendar', 'meetings', 'tasks', 'waiting'])
    // The Miles-specific sources are OFF for a stranger's install.
    for (const id of ['reading', 'pulse', 'skill', 'reflection', 'health', 'knowledge', 'custom']) {
      expect(config.sources.find(source => source.id === id)?.enabled).toBe(false)
    }
  })

  it('every catalog option has a default of its own type', () => {
    for (const spec of MORNING_BRIEF_SOURCES) {
      for (const [key, option] of Object.entries(spec.options)) {
        const expected = option.type === 'integer' ? 'number' : option.type === 'text' ? 'string' : 'boolean'
        expect(typeof option.default, `${spec.id}.${key}`).toBe(expected)
      }
    }
  })
})

describe('applyMorningBriefPatch', () => {
  const base = defaultMorningBriefConfig(new Date('2026-09-01T00:00:00Z'))

  it('accepts a valid time, zone, days, model, and sources', () => {
    const next = applyMorningBriefPatch(base, {
      time: '06:45',
      timezone: 'America/Chicago',
      days: [1, 3, 5, 5, '2'],
      model: 'opus',
      effort: 'xhigh',
      sources: [
        { id: 'skill', enabled: true, options: { name: '/good-morning' } },
        { id: 'meetings', enabled: true, options: { lookbackDays: 99 } },
      ],
      closingInstruction: '  Keep it under 40 lines.  ',
    }, new Date('2026-09-01T01:00:00Z'))
    expect(next.time).toBe('06:45')
    expect(next.timezone).toBe('America/Chicago')
    expect(next.days).toEqual([1, 2, 3, 5])
    expect(next.model).toBe('opus')
    expect(next.effort).toBe('xhigh')
    expect(next.closingInstruction).toBe('Keep it under 40 lines.')
    expect(next.updatedAt).toBe('2026-09-01T01:00:00.000Z')
    // Order: the patch's order first, then every unmentioned catalog source.
    expect(next.sources.slice(0, 2).map(source => source.id)).toEqual(['skill', 'meetings'])
    expect(next.sources).toHaveLength(MORNING_BRIEF_SOURCES.length)
    expect(next.sources[0].options.name).toBe('/good-morning')
    // Integer options clamp to the catalog range rather than failing.
    expect(next.sources[1].options.lookbackDays).toBe(14)
  })

  it('an unmentioned source keeps its previous state, not the default', () => {
    const on = applyMorningBriefPatch(base, { sources: [{ id: 'reading', enabled: true }] })
    const later = applyMorningBriefPatch(on, { sources: [{ id: 'tasks', enabled: false }] })
    expect(later.sources.find(source => source.id === 'reading')?.enabled).toBe(true)
    expect(later.sources.find(source => source.id === 'tasks')?.enabled).toBe(false)
  })

  it('rejects a bad time, zone, model, and skill name loudly', () => {
    expect(() => applyMorningBriefPatch(base, { time: '7am' })).toThrow(MorningBriefConfigError)
    expect(() => applyMorningBriefPatch(base, { time: '24:00' })).toThrow(/HH:MM/)
    expect(() => applyMorningBriefPatch(base, { timezone: 'Mars/Olympus' })).toThrow(/IANA/)
    expect(() => applyMorningBriefPatch(base, { model: 'gpt-9' })).toThrow(/model/)
    expect(() => applyMorningBriefPatch(base, { sources: [{ id: 'skill', options: { name: 'rm -rf /' } }] })).toThrow(/slash name/)
    expect(() => applyMorningBriefPatch(base, { catchUpMinutes: 100_000 })).toThrow(/catchUpMinutes/)
    expect(() => applyMorningBriefPatch(base, 'nope')).toThrow(/JSON object/)
  })

  it('clears model and effort with null', () => {
    const withModel = applyMorningBriefPatch(base, { model: 'sonnet', effort: 'max' })
    const cleared = applyMorningBriefPatch(withModel, { model: null, effort: '' })
    expect(cleared.model).toBeUndefined()
    expect(cleared.effort).toBeUndefined()
  })

  it('strips control characters and caps free text', () => {
    const next = applyMorningBriefPatch(base, {
      sources: [{ id: 'custom', enabled: true, options: { instruction: 'a\u0001b\u0002\u0000c' + 'x'.repeat(5_000) } }],
    })
    const instruction = next.sources.find(source => source.id === 'custom')?.options.instruction as string
    expect(instruction.startsWith('abc')).toBe(true)
    expect(instruction).toHaveLength(MORNING_BRIEF_LIMITS.instructionChars)
  })
})

describe('normalizeSources', () => {
  it('drops unknown ids and duplicates, and appends missing catalog ids disabled-by-default', () => {
    const sources = normalizeSources([
      { id: 'tasks', enabled: false },
      { id: 'made-up', enabled: true },
      { id: 'tasks', enabled: true },
    ])
    expect(sources[0]).toMatchObject({ id: 'tasks', enabled: false })
    expect(sources.map(source => source.id)).toHaveLength(MORNING_BRIEF_SOURCES.length)
    expect(sources.some(source => (source.id as string) === 'made-up')).toBe(false)
    // A config from an older build gains new sources at THEIR defaults (which,
    // for everything beyond the four core sources, is off).
    expect(sources.find(source => source.id === 'skill')?.enabled).toBe(false)
  })
})

describe('coerceMorningBriefConfig', () => {
  it('never throws: damaged fields fall back to defaults field by field', () => {
    const config = coerceMorningBriefConfig({
      enabled: 'yes',
      time: '25:99',
      timezone: 42,
      days: ['1', 9, 'x', 5],
      catchUpMinutes: -1,
      model: 'nonsense',
      sources: 'not a list',
      closingInstruction: 12,
      updatedAt: 'never',
    })
    expect(config.enabled).toBe(true)
    expect(config.time).toBe('07:00')
    expect(config.days).toEqual([1, 5])
    expect(config.catchUpMinutes).toBe(MORNING_BRIEF_LIMITS.defaultCatchUpMinutes)
    expect(config.model).toBeUndefined()
    expect(config.sources).toHaveLength(MORNING_BRIEF_SOURCES.length)
    expect(config.closingInstruction).toBe('')
  })
})

describe('persistence', () => {
  it('round-trips the config with private permissions and starts fresh when the file is missing', () => {
    const paths = morningBriefPaths(root)
    const first = loadMorningBriefConfig(paths)
    expect(first.fresh).toBe(true)
    const saved = applyMorningBriefPatch(first.config, { time: '06:30' })
    saveMorningBriefConfig(paths, saved)
    expect(statSync(paths.config).mode & 0o777).toBe(0o600)
    const second = loadMorningBriefConfig(paths)
    expect(second.fresh).toBe(false)
    expect(second.config.time).toBe('06:30')
  })

  it('quarantines a corrupt config instead of crashing or silently disabling the brief', () => {
    const paths = morningBriefPaths(root)
    saveMorningBriefConfig(paths, defaultMorningBriefConfig())
    writeFileSync(paths.config, '{ not json')
    const loaded = loadMorningBriefConfig(paths)
    expect(loaded.fresh).toBe(true)
    expect(loaded.quarantinedAs).toMatch(/\.corrupt-\d+$/)
    expect(loaded.config.enabled).toBe(true)
  })

  it('the ledger keeps the newest runs and drops malformed rows', () => {
    const paths = morningBriefPaths(root)
    const runs = Array.from({ length: MORNING_BRIEF_LIMITS.retainedRuns + 5 }, (_, i) => ({
      id: `r${i}`, day: '2026-09-01', trigger: 'scheduled' as const, attempt: 1,
      firedAt: new Date(i * 1000).toISOString(), clientJobId: 'c', generation: 1 as const, sessionId: 's',
    }))
    saveMorningBriefLedger(paths, { v: 1, runs })
    const onDisk = JSON.parse(readFileSync(paths.runs, 'utf8')) as { runs: unknown[] }
    expect(onDisk.runs).toHaveLength(MORNING_BRIEF_LIMITS.retainedRuns)
    writeFileSync(paths.runs, JSON.stringify({ v: 1, runs: [runs[0], { junk: true }, 7] }))
    expect(loadMorningBriefLedger(paths).runs).toHaveLength(1)
  })
})
