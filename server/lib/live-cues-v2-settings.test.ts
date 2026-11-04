import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  LIVE_CUES_GENERAL_LIMIT_BOUNDS, LIVE_CUES_GENERAL_LIMIT_NAMES, LIVE_CUES_V2_LIMIT_BOUNDS, LiveCuesV2Settings, generalLimitInBounds, isCueMode, isGrounding, limitInBounds,
  liveCuesV2EnvForced, resolveLiveCuesCueMode, resolveLiveCuesGrounding, resolveLiveCuesV2,
} from './live-cues-v2-settings.js'

describe('live cues v2 runtime setting', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cues-v2-setting-')) })
  afterEach(() => { try { chmodSync(join(dir, 'ro'), 0o700) } catch { /* absent */ } rmSync(dir, { recursive: true, force: true }) })

  it('resolution: env 1 forces on, else the saved choice, else off; only the exact value 1 forces', () => {
    expect(resolveLiveCuesV2({}, null)).toEqual({ enabled: false, source: 'default' })
    expect(resolveLiveCuesV2({}, { stored: () => true })).toEqual({ enabled: true, source: 'setting' })
    expect(resolveLiveCuesV2({ COS_LIVE_CUES_V2: '1' }, { stored: () => false })).toEqual({ enabled: true, source: 'env' })
    for (const v of ['0', 'true', ' 1', '']) expect(resolveLiveCuesV2({ COS_LIVE_CUES_V2: v }, { stored: () => null }), v).toEqual({ enabled: false, source: 'default' })
    expect(resolveLiveCuesV2({}, { stored: () => { throw new Error('io') } })).toEqual({ enabled: false, source: 'default' })
    expect(liveCuesV2EnvForced({ COS_LIVE_CUES_V2: '1' })).toBe(true)
  })

  it('a saved choice survives a new instance (a restart); an absent or malformed file is no choice', () => {
    const file = join(dir, 'live-cues-v2-settings.json')
    expect(new LiveCuesV2Settings(file).stored()).toBeNull()
    new LiveCuesV2Settings(file).save(true, new Date('2026-10-17T22:00:00Z'))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schema: 1, enabled: true, updatedAt: '2026-10-17T22:00:00.000Z' })
    expect(new LiveCuesV2Settings(file).stored()).toBe(true)
    for (const body of ['{bad', 'null', '[]', '{"enabled":"true"}']) {
      writeFileSync(file, body)
      expect(new LiveCuesV2Settings(file).stored(), body).toBeNull()
    }
  })

  it('a failed write changes nothing in memory', () => {
    const ro = join(dir, 'ro'); mkdirSync(ro)
    const s = new LiveCuesV2Settings(join(ro, 'live-cues-v2-settings.json'))
    expect(s.stored()).toBeNull()
    chmodSync(ro, 0o500)
    expect(() => s.save(true)).toThrow()
    expect(s.stored()).toBeNull()
  })

  it('6.79.2 limits: saved with the switch in one file (schema 2), merged on update, and each validated on read', () => {
    const file = join(dir, 'live-cues-v2-settings.json')
    const a = new LiveCuesV2Settings(file)
    a.save(true, new Date('2026-10-19T20:00:00Z'))
    a.update({ limits: { gate: 0.9, maxCuesPerMeeting: 10 } }, new Date('2026-10-19T20:01:00Z'))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schema: 2, enabled: true, gate: 0.9, maxCuesPerMeeting: 10, updatedAt: '2026-10-19T20:01:00.000Z' })
    a.update({ limits: { cooldownSeconds: 60 } })
    a.save(false)
    const b = new LiveCuesV2Settings(file)
    expect(b.stored()).toBe(false)
    expect(b.limits()).toEqual({ gate: 0.9, maxCuesPerMeeting: 10, cooldownSeconds: 60 })
    // A hand-edited value outside its bounds reads as unset (the default), never as a looser limit; the others stand.
    writeFileSync(file, JSON.stringify({ schema: 2, enabled: true, gate: 0.2, maxCuesPerMeeting: 51, cooldownSeconds: 30.5, dailyWriterCalls: 0, updatedAt: 'x' }))
    expect(new LiveCuesV2Settings(file).limits()).toEqual({})
    writeFileSync(file, JSON.stringify({ schema: 2, gate: 0.6, dailyWriterCalls: 200 }))
    const c = new LiveCuesV2Settings(file)
    expect(c.stored()).toBeNull()
    expect(c.limits()).toEqual({ gate: 0.6, dailyWriterCalls: 200 })
    // Limits only, no switch: the file says nothing about `enabled`, so a 6.79.1 server reads no choice.
    c.update({ limits: { maxCuesPerMeeting: 5 } })
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('enabled')
  })

  it('6.79.2 bounds: inclusive, whole numbers where whole, numbers only', () => {
    for (const [name, b] of Object.entries(LIVE_CUES_V2_LIMIT_BOUNDS) as Array<[keyof typeof LIVE_CUES_V2_LIMIT_BOUNDS, (typeof LIVE_CUES_V2_LIMIT_BOUNDS)[keyof typeof LIVE_CUES_V2_LIMIT_BOUNDS]]>) {
      expect(limitInBounds(name, b.min), name).toBe(true)
      expect(limitInBounds(name, b.max), name).toBe(true)
      expect(limitInBounds(name, b.default), name).toBe(true)
      expect(limitInBounds(name, b.min - 0.01), name).toBe(false)
      expect(limitInBounds(name, b.max + 0.01), name).toBe(false)
      expect(limitInBounds(name, String(b.default)), name).toBe(false)
      expect(limitInBounds(name, Number.NaN), name).toBe(false)
    }
    expect(limitInBounds('maxCuesPerMeeting', 12.5)).toBe(false)
  })

  it('6.99.0 cues per meeting: the ceiling is 50 and the default stays 25; 50 is accepted, 51 and 0 are not, and 50 survives a restart', () => {
    const b = LIVE_CUES_V2_LIMIT_BOUNDS.maxCuesPerMeeting
    expect([b.min, b.max, b.default]).toEqual([1, 50, 25])
    expect(limitInBounds('maxCuesPerMeeting', 50)).toBe(true)
    expect(limitInBounds('maxCuesPerMeeting', 51)).toBe(false)
    expect(limitInBounds('maxCuesPerMeeting', 0)).toBe(false)
    const file = join(dir, 'live-cues-v2-settings.json')
    new LiveCuesV2Settings(file).update({ limits: { maxCuesPerMeeting: 50 } })
    expect(new LiveCuesV2Settings(file).limits()).toEqual({ maxCuesPerMeeting: 50 })
    // A hand-edited 51 reads as unset (the default), never as a looser limit.
    writeFileSync(file, JSON.stringify({ schema: 2, maxCuesPerMeeting: 51 }))
    expect(new LiveCuesV2Settings(file).limits()).toEqual({})
    expect(limitInBounds('gate', 0.875)).toBe(true)
  })

  it('live cues v3: the cue mode, grounding and general limits are saved in the same file (schema 3), and every later write keeps them', () => {
    const file = join(dir, 'live-cues-v2-settings.json')
    const a = new LiveCuesV2Settings(file)
    a.save(true, new Date('2026-11-01T20:00:00Z'))
    a.update({ limits: { gate: 0.9 } })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ schema: 2 })
    a.update({ cueMode: 'general', grounding: 'grounded', general: { intervalSeconds: 600, trigger: 0.7 } }, new Date('2026-11-01T20:05:00Z'))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schema: 3, enabled: true, gate: 0.9, cueMode: 'general', grounding: 'grounded', generalIntervalSeconds: 600, generalTrigger: 0.7,
      updatedAt: '2026-11-01T20:05:00.000Z' })
    a.save(false)                                                                       // the old toggle
    a.update({ limits: { cooldownSeconds: 60 } })                                       // a v2 limit change
    a.update({ cueMode: 'all' })                                                        // one v3 field
    a.update({ general: { dailyWebSearches: 12 } })                                     // a general limit merges, it does not replace
    const b = new LiveCuesV2Settings(file)
    expect(b.stored()).toBe(false)
    expect(b.limits()).toEqual({ gate: 0.9, cooldownSeconds: 60 })
    expect(b.cueMode()).toBe('all')
    expect(b.grounding()).toBe('grounded')
    expect(b.generalLimits()).toEqual({ intervalSeconds: 600, trigger: 0.7, dailyWebSearches: 12 })
    expect(JSON.parse(readFileSync(file, 'utf8')).schema).toBe(3)
  })

  it('live cues v3: a file with nothing from v3 is still written as schema 1 or 2, and never gains a v3 field', () => {
    const file = join(dir, 'live-cues-v2-settings.json')
    const a = new LiveCuesV2Settings(file)
    a.save(true, new Date('2026-11-01T20:00:00Z'))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schema: 1, enabled: true, updatedAt: '2026-11-01T20:00:00.000Z' })
    a.update({ limits: { gate: 0.85 } }, new Date('2026-11-01T20:01:00Z'))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schema: 2, enabled: true, gate: 0.85, updatedAt: '2026-11-01T20:01:00.000Z' })
    expect(a.cueMode()).toBeNull()
    expect(a.grounding()).toBeNull()
    expect(a.generalLimits()).toEqual({})
  })

  it('live cues v3: a malformed or out-of-range v3 value reads as unset, the others stand, and a saved focused is a value', () => {
    const file = join(dir, 'live-cues-v2-settings.json')
    writeFileSync(file, JSON.stringify({ schema: 3, enabled: true, cueMode: 'loud', grounding: 7, generalIntervalSeconds: 119, generalTrigger: 0.91, generalAttemptsPerMeeting: 4.5,
      generalMaxCuesPerMeeting: 6, generalDailyTopicCalls: '60', generalDailyWebSearches: 101 }))
    const a = new LiveCuesV2Settings(file)
    expect(a.cueMode()).toBeNull()
    expect(a.grounding()).toBeNull()
    expect(a.generalLimits()).toEqual({ maxCuesPerMeeting: 6 })
    writeFileSync(file, JSON.stringify({ schema: 3, cueMode: 'focused', grounding: 'classic' }))
    const b = new LiveCuesV2Settings(file)
    expect([b.cueMode(), b.grounding()]).toEqual(['focused', 'classic'])
    b.update({ cueMode: 'general' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ schema: 3, cueMode: 'general', grounding: 'classic' })
  })

  it('live cues v3: a failed write changes none of the v3 values in memory', () => {
    const ro = join(dir, 'ro'); mkdirSync(ro)
    const s = new LiveCuesV2Settings(join(ro, 'live-cues-v2-settings.json'))
    chmodSync(ro, 0o500)
    expect(() => s.update({ cueMode: 'all', grounding: 'grounded', general: { trigger: 0.5 } })).toThrow()
    expect([s.cueMode(), s.grounding(), s.generalLimits()]).toEqual([null, null, {}])
  })

  it('live cues v3 resolution: env may force only the SAFE value; any other env value, a bad saved value or a reader that throws defers to the setting, then to focused and classic', () => {
    expect(resolveLiveCuesCueMode({}, null)).toEqual({ value: 'focused', source: 'default', locked: false })
    expect(resolveLiveCuesCueMode({}, { stored: () => null, cueMode: () => 'general' })).toEqual({ value: 'general', source: 'setting', locked: false })
    expect(resolveLiveCuesCueMode({ COS_LIVE_CUES_MODE: 'focused' }, { stored: () => null, cueMode: () => 'all' })).toEqual({ value: 'focused', source: 'env', locked: true })
    for (const v of ['general', 'all', 'Focused', ' focused', '', '1']) {
      expect(resolveLiveCuesCueMode({ COS_LIVE_CUES_MODE: v }, { stored: () => null, cueMode: () => 'all' }), v).toEqual({ value: 'all', source: 'setting', locked: false })
    }
    expect(resolveLiveCuesCueMode({}, { stored: () => null, cueMode: () => 'loud' as never })).toEqual({ value: 'focused', source: 'default', locked: false })
    expect(resolveLiveCuesCueMode({}, { stored: () => null, cueMode: () => { throw new Error('io') } })).toEqual({ value: 'focused', source: 'default', locked: false })
    expect(resolveLiveCuesGrounding({}, null)).toEqual({ value: 'classic', source: 'default', locked: false })
    expect(resolveLiveCuesGrounding({}, { stored: () => null, grounding: () => 'grounded' })).toEqual({ value: 'grounded', source: 'setting', locked: false })
    expect(resolveLiveCuesGrounding({ COS_LIVE_CUES_GROUNDING: 'classic' }, { stored: () => null, grounding: () => 'grounded' })).toEqual({ value: 'classic', source: 'env', locked: true })
    for (const v of ['grounded', 'Classic', ' classic', '', '0']) {
      expect(resolveLiveCuesGrounding({ COS_LIVE_CUES_GROUNDING: v }, { stored: () => null, grounding: () => 'grounded' }), v).toEqual({ value: 'grounded', source: 'setting', locked: false })
    }
    expect(resolveLiveCuesGrounding({}, { stored: () => null, grounding: () => 'turbo' as never })).toEqual({ value: 'classic', source: 'default', locked: false })
    expect(resolveLiveCuesGrounding({}, { stored: () => null, grounding: () => { throw new Error('io') } })).toEqual({ value: 'classic', source: 'default', locked: false })
    expect([isCueMode('general'), isCueMode('insight'), isCueMode(null)]).toEqual([true, false, false])
    expect([isGrounding('grounded'), isGrounding('on'), isGrounding(undefined)]).toEqual([true, false, false])
  })

  it('live cues v3 general limits: the contract\'s defaults, bounds and env names; inclusive, whole where whole, numbers only', () => {
    expect(Object.fromEntries(LIVE_CUES_GENERAL_LIMIT_NAMES.map(n => { const b = LIVE_CUES_GENERAL_LIMIT_BOUNDS[n]; return [n, [b.default, b.min, b.max, b.integer, b.env, b.field]] }))).toEqual({
      intervalSeconds: [300, 120, 1800, true, 'COS_LIVE_CUES_GENERAL_INTERVAL_S', 'generalIntervalSeconds'],
      trigger: [0.6, 0.4, 0.9, false, 'COS_LIVE_CUES_GENERAL_TRIGGER', 'generalTrigger'],
      attemptsPerMeeting: [8, 1, 30, true, 'COS_LIVE_CUES_GENERAL_ATTEMPTS', 'generalAttemptsPerMeeting'],
      maxCuesPerMeeting: [4, 1, 12, true, 'COS_LIVE_CUES_GENERAL_MAX_PER_MEETING', 'generalMaxCuesPerMeeting'],
      dailyTopicCalls: [60, 1, 200, true, 'COS_LIVE_CUES_GENERAL_DAILY_TOPIC_CALLS', 'generalDailyTopicCalls'],
      dailyWebSearches: [30, 1, 100, true, 'COS_LIVE_CUES_GENERAL_DAILY_WEB_SEARCHES', 'generalDailyWebSearches'],
    })
    for (const name of LIVE_CUES_GENERAL_LIMIT_NAMES) {
      const b = LIVE_CUES_GENERAL_LIMIT_BOUNDS[name]
      expect(generalLimitInBounds(name, b.min), name).toBe(true)
      expect(generalLimitInBounds(name, b.max), name).toBe(true)
      expect(generalLimitInBounds(name, b.default), name).toBe(true)
      expect(generalLimitInBounds(name, b.min - 0.01), name).toBe(false)
      expect(generalLimitInBounds(name, b.max + 0.01), name).toBe(false)
      expect(generalLimitInBounds(name, String(b.default)), name).toBe(false)
      expect(generalLimitInBounds(name, Number.NaN), name).toBe(false)
    }
    expect(generalLimitInBounds('attemptsPerMeeting', 7.5)).toBe(false)
    expect(generalLimitInBounds('trigger', 0.65)).toBe(true)
  })
})
