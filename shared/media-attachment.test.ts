import { describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENTS_PER_PROMPT,
  isValidMediaId,
  mergeMediaAttachmentRefs,
  parseMediaAttachmentRef,
  parseMediaAttachmentRefs,
  parseMediaIdList,
} from './media-attachment.js'

const GOOD_ID = 'm_0123456789abcdef01234567'

function goodRef(overrides: Record<string, unknown> = {}) {
  return {
    id: GOOD_ID,
    kind: 'user_photo',
    mime: 'image/jpeg',
    width: 1024,
    height: 768,
    createdAt: '2026-07-10T12:00:00.000Z',
    ...overrides,
  }
}

describe('media id validator', () => {
  it('accepts only the strict generated format', () => {
    expect(isValidMediaId(GOOD_ID)).toBe(true)
    expect(isValidMediaId('m_' + 'a'.repeat(24))).toBe(true)
  })

  it('rejects path characters, wrong length, wrong casing, and non-strings', () => {
    for (const bad of [
      '', 'm_', 'x_0123456789abcdef01234567', 'm_0123456789ABCDEF01234567',
      'm_0123456789abcdef0123456', 'm_0123456789abcdef012345678',
      'm_../../../etc/passwd0000', 'm_0123456789abcdef0123456/',
      42, null, undefined, {},
    ]) {
      expect(isValidMediaId(bad), String(bad)).toBe(false)
    }
  })
})

describe('parseMediaAttachmentRef (untrusted-boundary validation)', () => {
  it('round-trips a valid ref and drops unknown fields', () => {
    const ref = parseMediaAttachmentRef({ ...goodRef(), storagePath: '/etc/passwd', token: 'x' })
    expect(ref).not.toBeNull()
    expect(ref!).toEqual({
      id: GOOD_ID, kind: 'user_photo', mime: 'image/jpeg',
      width: 1024, height: 768, createdAt: '2026-07-10T12:00:00.000Z',
    })
    expect('storagePath' in ref!).toBe(false)
    expect('token' in ref!).toBe(false)
  })

  it('keeps valid optional fields and truncates oversized labels', () => {
    const ref = parseMediaAttachmentRef(goodRef({
      label: 'x'.repeat(500),
      capturedAt: '2026-07-10T11:59:00.000Z',
      expiresAt: '2026-07-10T12:10:00.000Z',
    }))
    expect(ref!.label!.length).toBe(120)
    expect(ref!.capturedAt).toBe('2026-07-10T11:59:00.000Z')
    expect(ref!.expiresAt).toBe('2026-07-10T12:10:00.000Z')
  })

  it('rejects invalid ids, kinds, mimes, dimensions, and timestamps', () => {
    expect(parseMediaAttachmentRef(goodRef({ id: 'nope' }))).toBeNull()
    expect(parseMediaAttachmentRef(goodRef({ kind: 'svg_bomb' }))).toBeNull()
    expect(parseMediaAttachmentRef(goodRef({ mime: 'image/svg+xml' }))).toBeNull()
    expect(parseMediaAttachmentRef(goodRef({ width: 0 }))).toBeNull()
    expect(parseMediaAttachmentRef(goodRef({ height: 1.5 }))).toBeNull()
    expect(parseMediaAttachmentRef(goodRef({ width: 100_000 }))).toBeNull()
    expect(parseMediaAttachmentRef(goodRef({ createdAt: 'yesterday' }))).toBeNull()
    expect(parseMediaAttachmentRef(null)).toBeNull()
    expect(parseMediaAttachmentRef('string')).toBeNull()
  })

  it('drops invalid optional timestamps instead of rejecting the ref', () => {
    const ref = parseMediaAttachmentRef(goodRef({ capturedAt: 'not-a-date' }))
    expect(ref).not.toBeNull()
    expect(ref!.capturedAt).toBeUndefined()
  })
})

describe('parseMediaAttachmentRefs / parseMediaIdList', () => {
  it('drops only invalid entries, never the whole list', () => {
    const refs = parseMediaAttachmentRefs([goodRef(), { junk: true }, goodRef({ id: 'm_' + 'b'.repeat(24) })])
    expect(refs).toHaveLength(2)
  })

  it('caps at the per-prompt maximum', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      goodRef({ id: `m_${String(i).repeat(24).slice(0, 24)}`.replace(/[^m_0-9a-f]/g, '0') }))
    // ensure ids are valid + unique
    const withIds = many.map((r, i) => ({ ...r, id: `m_${i.toString(16).padStart(24, '0')}` }))
    expect(parseMediaAttachmentRefs(withIds)).toHaveLength(MAX_ATTACHMENTS_PER_PROMPT)
    expect(parseMediaIdList(withIds.map(r => r.id))).toHaveLength(MAX_ATTACHMENTS_PER_PROMPT)
  })

  it('id list dedups and rejects malformed ids', () => {
    expect(parseMediaIdList([GOOD_ID, GOOD_ID, '../etc', 5])).toEqual([GOOD_ID])
    expect(parseMediaIdList('not-an-array')).toEqual([])
  })

  it('strictly merges user + assistant refs, de-duplicating by media id', () => {
    const assistantOnly = goodRef({ id: 'm_' + 'c'.repeat(24), kind: 'generated_visual', mime: 'image/png' })
    expect(mergeMediaAttachmentRefs(
      [goodRef(), { id: '../bad' }],
      [goodRef({ label: 'echoed by server' }), assistantOnly],
    )).toEqual([goodRef(), assistantOnly])
  })

  it('keeps legacy/non-array sources harmless and caps the merged result', () => {
    const many = Array.from({ length: 8 }, (_, i) => goodRef({
      id: `m_${i.toString(16).padStart(24, '0')}`,
    }))
    expect(mergeMediaAttachmentRefs(undefined, 'legacy', many.slice(0, 3), many.slice(3)))
      .toHaveLength(MAX_ATTACHMENTS_PER_PROMPT)
  })
})
