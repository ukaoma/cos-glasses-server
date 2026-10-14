import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { dataPath } from './data-dir.js'
import { captureSpeakerMode, policyLabel, readSpeakerPolicy, writeSpeakerPolicy } from './meeting-speaker-policy.js'

const filename = (id: string) => dataPath('speaker-policy', createHash('sha256').update(id).digest('hex') + '.json')

describe('per-capture identity policy', () => {
  it('defaults missing captures to legacy Standard and persists a private policy with CAS', () => {
    const id = 'policy_saved_001'
    expect(readSpeakerPolicy(id)).toEqual({ mode: 'standard', revision: 'unset' })
    writeSpeakerPolicy(id, 'anonymous', 'unset')
    const first = readSpeakerPolicy(id)
    expect(first.mode).toBe('anonymous')
    expect(first.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(statSync(filename(id)).mode & 0o777).toBe(0o600)
    expect(statSync(dataPath('speaker-policy')).mode & 0o777).toBe(0o700)
    expect(() => writeSpeakerPolicy(id, 'standard', 'unset')).toThrow(/changed/)
    expect(readSpeakerPolicy(id)).toEqual(first)
    writeSpeakerPolicy(id, 'high-confidence', first.revision)
    expect(readSpeakerPolicy(id).mode).toBe('high-confidence')
  })
  it('keeps colon and underscore capture IDs distinct', () => {
    writeSpeakerPolicy('policy:collision', 'anonymous', 'unset')
    writeSpeakerPolicy('policy_collision', 'high-confidence', 'unset')
    expect(readSpeakerPolicy('policy:collision').mode).toBe('anonymous')
    expect(readSpeakerPolicy('policy_collision').mode).toBe('high-confidence')
  })
  it('fails closed on corrupt data, wrong capture identity and invalid modes; repair is explicit', () => {
    const id = 'policy_corrupt_001'
    writeSpeakerPolicy(id, 'anonymous', 'unset')
    for (const raw of ['{', JSON.stringify({ sessionId: 'someone_else', mode: 'standard' }), JSON.stringify({ sessionId: id, mode: 'typo' })]) {
      writeFileSync(filename(id), raw)
      expect(readSpeakerPolicy(id)).toMatchObject({ mode: 'anonymous', revision: 'unreadable', error: expect.any(String) })
    }
    expect(() => writeSpeakerPolicy(id, 'standard', 'unset')).toThrow(/changed/)
    writeSpeakerPolicy(id, 'anonymous', 'unreadable')
    expect(JSON.parse(readFileSync(filename(id), 'utf8'))).toEqual({ sessionId: id, mode: 'anonymous' })
  })
  it('withholds all anonymous names and uses the same strong floor for wearer and others', () => {
    for (const speaker of ['MU', 'Someone else']) {
      for (const similarity of [0, 0.61, 0.87, NaN, Infinity, 1.01]) {
        const value = { speaker, similarity }
        expect(policyLabel(value, 'high-confidence')).toEqual({ speaker: 'Ext', similarity: 0 })
        expect(policyLabel(value, 'standard')).toBe(value)
      }
      for (const similarity of [0.88, 0.99, 1]) {
        expect(policyLabel({ speaker, similarity }, 'high-confidence')).toEqual({ speaker, similarity })
        expect(policyLabel({ speaker, similarity }, 'anonymous')).toEqual({ speaker: 'Ext', similarity: 0 })
      }
    }
  })
  it('treats missing chunk markers as legacy Standard and malformed markers as anonymous', () => {
    expect(captureSpeakerMode(undefined)).toBe('standard')
    expect(captureSpeakerMode('high-confidence')).toBe('high-confidence')
    expect(captureSpeakerMode('unexpected')).toBe('anonymous')
    expect(() => writeSpeakerPolicy('../bad', 'anonymous', 'unset')).toThrow(/changed/)
  })
})
