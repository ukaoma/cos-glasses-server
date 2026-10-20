import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LIVE_CUES_V2_LIMIT_BOUNDS, LiveCuesV2Settings, limitInBounds, liveCuesV2EnvForced, resolveLiveCuesV2 } from './live-cues-v2-settings.js'

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
    writeFileSync(file, JSON.stringify({ schema: 2, enabled: true, gate: 0.2, maxCuesPerMeeting: 40, cooldownSeconds: 30.5, dailyWriterCalls: 0, updatedAt: 'x' }))
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
    expect(limitInBounds('gate', 0.875)).toBe(true)
  })
})
