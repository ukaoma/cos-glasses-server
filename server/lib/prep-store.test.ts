import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrepStore, parsePrepOccurrence, prepOccurrenceKey } from './prep-store.js'
import type { PrepDraft } from '../../shared/prep.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks() })
const root = () => { const d = mkdtempSync(join(tmpdir(), 'prep-store-')); dirs.push(d); return join(d, 'prep') }
const draft = (id: string): PrepDraft => ({ id, clientDraftId: '11111111-1111-4111-8111-111111111111', serverInstanceId: 'srv-1', fileOperations: [], revision: 1, createdAt: '2026-11-06T15:00:00.000Z', updatedAt: '2026-11-06T15:00:00.000Z', title: 't', startsAt: null, occurrence: null, identity: 'none', steer: '', files: [], runs: [], conversation: { sessionId: null }, bindings: [], state: 'active' })
const ID = 'prep_' + 'a'.repeat(26)

describe('PrepStore', () => {
  it('writes drafts mode 0600 under drafts/, and a fresh instance reads them back', () => {
    const r = root()
    new PrepStore(r).write(draft(ID))
    expect(statSync(join(r, 'drafts', ID + '.json')).mode & 0o777).toBe(0o600)
    expect(new PrepStore(r).get(ID)).toEqual(draft(ID))
  })

  it('skips an unreadable draft file without deleting it', () => {
    const r = root()
    const s = new PrepStore(r)
    s.write(draft(ID))
    writeFileSync(join(r, 'drafts', 'prep_' + 'b'.repeat(26) + '.json'), '{not json')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fresh = new PrepStore(r)
    expect(fresh.list().map(d => d.id)).toEqual([ID])
    expect(readdirSync(join(r, 'drafts'))).toHaveLength(2)
  })

  it('keeps originals and text per draft and counts every byte toward the store limit', () => {
    const s = new PrepStore(root())
    s.write(draft(ID))
    const before = s.usageBytes()
    s.putOriginal(ID, 'pf_0123456789abcdef', Buffer.alloc(1000, 1))
    s.putText(ID, 'pf_0123456789abcdef', 'hello')
    expect(s.readOriginal(ID, 'pf_0123456789abcdef')).toEqual(Buffer.alloc(1000, 1))
    expect(s.readText(ID, 'pf_0123456789abcdef')).toBe('hello')
    expect(s.readText(ID, 'pf_fedcba9876543210')).toBe('')
    expect(s.usageBytes() - before).toBe(1005)
    expect(() => s.readOriginal(ID, '../../etc/passwd')).toThrow('invalid_file_id')
  })
})

describe('occurrence identity', () => {
  it('derives the v2 key from every part, exact to the millisecond, account included', () => {
    const base = { provider: 'google' as const, account: 'miles@example.com', calendarId: 'c', eventId: null, externalId: 'ical-1', startsAt: '2026-11-06T16:00:10-06:00' }
    const k = prepOccurrenceKey(base)
    expect(k).toBe('occ:v2:' + createHash('sha256').update('occ:v2:google|miles@example.com|c||ical-1|2026-11-06T22:00:10.000Z').digest('hex'))
    // No quantization and no coalescing: a second later, another account, or another id is another key.
    expect(prepOccurrenceKey({ ...base, startsAt: '2026-11-06T22:00:11Z' })).not.toBe(k)
    expect(prepOccurrenceKey({ ...base, account: null })).not.toBe(k)
    expect(prepOccurrenceKey({ ...base, eventId: 'e' })).not.toBe(k)
    const o = parsePrepOccurrence({ ...base, title: 'ignored', key: 'occ:v2:forged' })
    expect(o).toEqual({ key: k, provider: 'google', account: 'miles@example.com', calendarId: 'c', eventId: null, externalId: 'ical-1', startsAt: '2026-11-06T22:00:10.000Z', endsAt: null })
  })

  it('is null without every required part, and never from a title or time alone', () => {
    const at = '2026-11-06T22:00:00Z'
    expect(parsePrepOccurrence({ provider: 'm365', calendarId: 'c', startsAt: at })).toBeNull()
    expect(parsePrepOccurrence({ provider: 'm365', eventId: 'e', startsAt: at })).toBeNull()
    expect(parsePrepOccurrence({ calendarId: 'c', eventId: 'e', startsAt: at })).toBeNull()
    expect(parsePrepOccurrence({ provider: 'outlook', calendarId: 'c', eventId: 'e', startsAt: at })).toBeNull()
    expect(parsePrepOccurrence({ provider: 'm365', calendarId: 'c', eventId: 'e' })).toBeNull()
    expect(parsePrepOccurrence({ title: 'Pete 1:1', startsAt: at })).toBeNull()
    expect(parsePrepOccurrence(null)).toBeNull()
  })
})
