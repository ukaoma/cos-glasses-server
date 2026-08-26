import { afterEach, describe, expect, it } from 'vitest'
import {
  evenSpeakerRoleMode,
  formatEvenRoleAgreement,
  parseEvenHubSpeakerRoleBody,
  parseEvenHubSpeakerRoleQuery,
} from './even-hub-speaker-role.js'

afterEach(() => {
  delete process.env.COS_EVEN_SPEAKER_ROLE
})

describe('parseEvenHubSpeakerRoleQuery', () => {
  it('parses the compact wire and ignores garbage', () => {
    expect(parseEvenHubSpeakerRoleQuery('40,210,12,262,12,7')).toEqual({
      schema: 1,
      frames: 262,
      self: 40,
      other: 210,
      unknown: 12,
      majority: 'other',
      directionPresent: 12,
      directionLast: 7,
    })
    expect(parseEvenHubSpeakerRoleQuery('1,0,0,1,0,')).toMatchObject({
      frames: 1, self: 1, majority: 'self', directionLast: null,
    })
    expect(parseEvenHubSpeakerRoleQuery(undefined)).toBeUndefined()
    expect(parseEvenHubSpeakerRoleQuery('1,2,3')).toBeUndefined()
    expect(parseEvenHubSpeakerRoleQuery('1,0,0,99')).toBeUndefined()
    expect(parseEvenHubSpeakerRoleQuery('self,other,unknown,1')).toBeUndefined()
  })
})

describe('parseEvenHubSpeakerRoleBody', () => {
  it('accepts the JSON object and rejects a count mismatch', () => {
    expect(parseEvenHubSpeakerRoleBody({
      self: 2, other: 1, unknown: 0, frames: 3, directionPresent: 0, directionLast: null,
    })).toMatchObject({ majority: 'self', frames: 3 })
    expect(parseEvenHubSpeakerRoleBody({ self: 1, other: 0, unknown: 0, frames: 9 })).toBeUndefined()
  })
})

describe('evenSpeakerRoleMode', () => {
  it('defaults to log and fails closed on apply until Gate A ships', () => {
    expect(evenSpeakerRoleMode()).toBe('log')
    process.env.COS_EVEN_SPEAKER_ROLE = 'off'
    expect(evenSpeakerRoleMode()).toBe('off')
    process.env.COS_EVEN_SPEAKER_ROLE = 'apply'
    expect(evenSpeakerRoleMode()).toBe('apply')
  })
})

describe('formatEvenRoleAgreement', () => {
  it('writes one line with even vs amp vs embedding', () => {
    const even = parseEvenHubSpeakerRoleQuery('0,10,0,10,0,')!
    expect(formatEvenRoleAgreement({
      chunkIndex: 12, even, amp: 'Ext', emb: 'MU', similarity: 0.67,
    })).toBe('[even-role] chunk=12 even=other amp=Ext emb=MU sim=0.67 frames=10')
  })
})
