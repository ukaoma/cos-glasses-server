import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LiveCuesV2Settings, liveCuesV2EnvForced, resolveLiveCuesV2 } from './live-cues-v2-settings.js'

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
})
