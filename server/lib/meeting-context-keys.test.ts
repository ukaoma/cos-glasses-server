import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  MEETING_CONTEXT_KEY,
  firefliesSidecarId,
  meetingContextFields,
  meetingContextKeys,
  readOnlyContext,
  topLevelStringField,
} from './meeting-context-keys.js'
import {
  getCosOperationsMeetingDetail,
  listCosOperationsMeetings,
  meetingPrimaryKeyCacheStats,
  meetingContextForRecord,
  meetingPrimaryKeyClaims,
  resetMeetingPrimaryKeyCache,
} from './cos-operations-meetings.js'

// 6.64.0 meeting context keys: what COS Control files a meeting's dropped files under. Read from ids the meeting already
// carries, never written into it, never matched by title or date.

const previous = { COS_OPERATIONS_DIR: process.env.COS_OPERATIONS_DIR, COS_MEETINGS_ROOT: process.env.COS_MEETINGS_ROOT, COS_SCRIPTS_DIR: process.env.COS_SCRIPTS_DIR }
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos ctx.keys ü-'))
  delete process.env.COS_MEETINGS_ROOT
  delete process.env.COS_SCRIPTS_DIR
  process.env.COS_OPERATIONS_DIR = root
  resetMeetingPrimaryKeyCache()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  for (const [key, value] of Object.entries(previous)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
})

function month(domain: string, m: string): string {
  const dir = join(root, domain, 'meetings', m)
  mkdirSync(dir, { recursive: true })
  return dir
}
function meeting(dir: string, name: string, body = ''): string {
  const path = join(dir, name)
  writeFileSync(path, `# ${name.replace(/\.md$/, '')}\n\n**Date** | 2026-09-14 10:00 |\n\n## Summary\nS\n${body}`)
  return path
}
function g2(dir: string, name: string, sessionId: string): void {
  writeFileSync(join(dir, name.replace(/\.md$/, '.g2-chunks.json')), JSON.stringify({ sessionId, speakers: ['Speaker 1'], chunks: [] }))
}
function ff(dir: string, name: string, id: string): void {
  // The real head: sidecar_version, id, then the sentences, each carrying its own nested ids.
  writeFileSync(join(dir, name.replace(/\.md$/, '.fireflies.json')), JSON.stringify({
    sidecar_version: 1, id, date: 1788292800000, participants: ['a@b.c'],
    sentences: Array.from({ length: 400 }, (_, i) => ({ speaker_id: i % 3, id: `nested-${i}`, text: 'words '.repeat(8) })),
  }))
}

describe('pure rules', () => {
  it('orders keys capture, Fireflies, then declared, without repeats', () => {
    expect(meetingContextKeys({ g2SessionId: 'meeting_1', firefliesId: '01ABC', declared: ['meeting_1', 'meeting_2'] }))
      .toEqual(['g2:meeting_1', 'ff:01ABC', 'g2:meeting_2'])
    expect(meetingContextKeys({ declared: ['meeting_9'] })).toEqual(['g2:meeting_9'])
    expect(meetingContextKeys({})).toEqual([])
  })
  it('refuses an id outside the marker grammar', () => {
    expect(meetingContextKeys({ g2SessionId: '../x', firefliesId: 'a b', declared: ['ok_id'] })).toEqual(['g2:ok_id'])
    expect(meetingContextKeys({ firefliesId: 'x'.repeat(97) })).toEqual([])
    for (const key of meetingContextKeys({ g2SessionId: 'meeting_1788479784524_iz0g6y', firefliesId: '01M1F90QA71Y628BYC7AFE4GG7' })) {
      expect(MEETING_CONTEXT_KEY.test(key)).toBe(true)
    }
  })
  it('reads only a TOP-LEVEL field from a JSON head', () => {
    expect(topLevelStringField('{"sidecar_version":1,"id":"01ABC","x":[{"id":"no"}]}', 'id')).toBe('01ABC')
    // Key order changed: a nested id comes first and must not be taken.
    expect(topLevelStringField('{"participants":[{"id":"nested"}],"meta":{"id":"deeper"},"id":"top"}', 'id')).toBe('top')
    expect(topLevelStringField('{"participants":[{"id":"nested"}]', 'id')).toBeUndefined()
    expect(topLevelStringField('{"title":"has \\"id\\": \\"fake\\"","id":"real"}', 'id')).toBe('real')
    expect(topLevelStringField('{"id":12}', 'id')).toBeUndefined()
  })
  it('says why files cannot be added', () => {
    expect(meetingContextFields([])).toEqual({ contextKeys: [], contextSupported: false, contextReason: 'no_source_id' })
    expect(meetingContextFields(['g2:abc'], { conflictCopy: true }).contextReason).toBe('conflict_copy')
    expect(meetingContextFields(['g2:abc'], { claimants: 2 })).toEqual({ contextKeys: ['g2:abc'], contextSupported: false, contextAmbiguous: true, contextReason: 'ambiguous' })
    expect(meetingContextFields(['g2:abc'], { claimants: 1 })).toEqual({ contextKeys: ['g2:abc'], contextSupported: true })
    const a = readOnlyContext(); a.contextKeys.push('x')
    expect(readOnlyContext().contextKeys).toEqual([])
  })
})

describe('Fireflies sidecar head', () => {
  it('reads the top-level id from a sidecar of any size, never a link', () => {
    const dir = month('quilt', '2026-09')
    meeting(dir, '2026-09-14_Call.md')
    ff(dir, '2026-09-14_Call.md', '01M1F90QA71Y628BYC7AFE4GG7')
    expect(firefliesSidecarId(dir, '2026-09-14_Call.md')).toBe('01M1F90QA71Y628BYC7AFE4GG7')
    meeting(dir, '2026-09-14_Linked.md')
    symlinkSync(join(dir, '2026-09-14_Call.fireflies.json'), join(dir, '2026-09-14_Linked.fireflies.json'))
    expect(firefliesSidecarId(dir, '2026-09-14_Linked.md')).toBeUndefined()
    expect(firefliesSidecarId(dir, '2026-09-14_None.md')).toBeUndefined()
  })
})

describe('list and detail carry the keys', () => {
  it('keys a G2 capture, a Fireflies call and a merged meeting, and the detail says the same', () => {
    const sep = month('quilt', '2026-09')
    meeting(sep, '2026-09-14_Capture_(G2).md'); g2(sep, '2026-09-14_Capture_(G2).md', 'meeting_111')
    meeting(sep, '2026-09-14_Call.md'); ff(sep, '2026-09-14_Call.md', '01FFCALL')
    meeting(sep, '2026-09-14_Merged.md', '\n<!-- g2-session: meeting_222 -->\n<!-- g2-session: meeting_333 -->\n'); ff(sep, '2026-09-14_Merged.md', '01FFMERGED')
    meeting(sep, '2026-09-14_Untracked.md')
    const rows = Object.fromEntries(listCosOperationsMeetings({ month: '2026-09', limit: 50 }).map(r => [r.filename, r]))
    expect(rows['2026-09-14_Capture_(G2).md'].contextKeys).toEqual(['g2:meeting_111'])
    expect(rows['2026-09-14_Call.md'].contextKeys).toEqual(['ff:01FFCALL'])
    expect(rows['2026-09-14_Merged.md'].contextKeys).toEqual(['ff:01FFMERGED', 'g2:meeting_222', 'g2:meeting_333'])
    expect(rows['2026-09-14_Untracked.md']).toMatchObject({ contextKeys: [], contextSupported: false, contextReason: 'no_source_id' })
    for (const name of ['2026-09-14_Capture_(G2).md', '2026-09-14_Call.md', '2026-09-14_Merged.md']) {
      expect(rows[name].contextSupported).toBe(true)
      const detail = getCosOperationsMeetingDetail('quilt', '2026-09', name)!
      expect(detail.contextKeys).toEqual(rows[name].contextKeys)
      expect(detail.contextSupported).toBe(true)
    }
  })

  it('a G2 meeting keeps its key through the enrichment rename and a domain move (the case that killed plan v1)', () => {
    const sep = month('personal', '2026-09')
    meeting(sep, '2026-09-14_G2_Recording_2026-09-14_1000_ab12cd34.md'); g2(sep, '2026-09-14_G2_Recording_2026-09-14_1000_ab12cd34.md', 'meeting_rename')
    const before = listCosOperationsMeetings({ month: '2026-09', limit: 10 })[0].contextKeys
    // The pipeline regenerates the file from a template under its new title and moves the sidecar with it.
    rmSync(join(sep, '2026-09-14_G2_Recording_2026-09-14_1000_ab12cd34.md'))
    rmSync(join(sep, '2026-09-14_G2_Recording_2026-09-14_1000_ab12cd34.g2-chunks.json'))
    const quilt = month('quilt', '2026-09')
    meeting(quilt, '2026-09-14_Pricing_Reset_(G2).md'); g2(quilt, '2026-09-14_Pricing_Reset_(G2).md', 'meeting_rename')
    const after = listCosOperationsMeetings({ month: '2026-09', limit: 10 })
    expect(after).toHaveLength(1)
    expect(after[0].domain).toBe('quilt')
    expect(after[0].contextKeys).toEqual(before)
  })

  it('two live meetings with one primary key are ambiguous on both; a conflict copy is never a claimant', () => {
    const p = month('personal', '2026-09'), s = month('sprocket_rocket', '2026-09')
    meeting(p, '2026-09-03_G2_Recording_2026-09-03_0700_d6c6c2a7.md'); g2(p, '2026-09-03_G2_Recording_2026-09-03_0700_d6c6c2a7.md', 'meeting_dup')
    meeting(s, '2026-09-03_Module_Builder_(G2).md'); g2(s, '2026-09-03_Module_Builder_(G2).md', 'meeting_dup')
    meeting(s, '2026-09-03_Solo_(G2).md'); g2(s, '2026-09-03_Solo_(G2).md', 'meeting_solo')
    // An iCloud copy of the solo meeting with its sidecar copy: the copy is refused, the original stays sole owner.
    writeFileSync(join(s, '2026-09-03_Solo_(G2) 2.md'), readFileSync(join(s, '2026-09-03_Solo_(G2).md')))
    writeFileSync(join(s, '2026-09-03_Solo_(G2) 2.g2-chunks.json'), JSON.stringify({ sessionId: 'meeting_solo' }))
    const rows = listCosOperationsMeetings({ month: '2026-09', limit: 50 })
    const by = (name: string) => rows.find(r => r.filename === name)!
    for (const name of ['2026-09-03_G2_Recording_2026-09-03_0700_d6c6c2a7.md', '2026-09-03_Module_Builder_(G2).md']) {
      expect(by(name)).toMatchObject({ contextKeys: ['g2:meeting_dup'], contextSupported: false, contextAmbiguous: true, contextReason: 'ambiguous' })
    }
    expect(by('2026-09-03_Solo_(G2).md')).toMatchObject({ contextKeys: ['g2:meeting_solo'], contextSupported: true })
    expect(by('2026-09-03_Solo_(G2) 2.md')).toMatchObject({ contextKeys: [], contextSupported: false, contextReason: 'conflict_copy' })
    // The detail sees the same ambiguity, even when asked for one domain only.
    expect(getCosOperationsMeetingDetail('sprocket_rocket', '2026-09', '2026-09-03_Module_Builder_(G2).md')!.contextAmbiguous).toBe(true)
  })

  it('a merged meeting that still lives beside its capture is not ambiguous: their primary keys differ', () => {
    const sep = month('quilt', '2026-09')
    meeting(sep, '2026-09-14_Capture_(G2).md'); g2(sep, '2026-09-14_Capture_(G2).md', 'meeting_x')
    meeting(sep, '2026-09-14_Call.md', '<!-- g2-session: meeting_x -->'); ff(sep, '2026-09-14_Call.md', '01FF')
    const rows = listCosOperationsMeetings({ month: '2026-09', limit: 50 })
    expect(rows.every(r => r.contextSupported)).toBe(true)
    expect(rows.find(r => r.filename === '2026-09-14_Call.md')!.contextKeys).toEqual(['ff:01FF', 'g2:meeting_x'])
  })

  it('a strict month folder only: a "2026-09 2" conflict folder never claims a key', () => {
    const sep = month('quilt', '2026-09')
    meeting(sep, '2026-09-14_A_(G2).md'); g2(sep, '2026-09-14_A_(G2).md', 'meeting_a')
    const copy = join(root, 'quilt', 'meetings', '2026-09 2'); mkdirSync(copy)
    meeting(copy, '2026-09-14_A_(G2).md'); g2(copy, '2026-09-14_A_(G2).md', 'meeting_a')
    expect(meetingPrimaryKeyClaims(root, null).get('g2:meeting_a')).toBe(1)
    expect(listCosOperationsMeetings({ month: '2026-09', limit: 5 })[0].contextSupported).toBe(true)
  })

  it('writes nothing into the meeting tree', () => {
    const sep = month('quilt', '2026-09')
    const path = meeting(sep, '2026-09-14_Call.md'); ff(sep, '2026-09-14_Call.md', '01FF')
    const before = { body: readFileSync(path, 'utf8'), mtime: statSync(path).mtimeMs, dir: statSync(sep).mtimeMs }
    listCosOperationsMeetings({ month: '2026-09', limit: 5 })
    getCosOperationsMeetingDetail('quilt', '2026-09', '2026-09-14_Call.md')
    expect(readFileSync(path, 'utf8')).toBe(before.body)
    expect(statSync(path).mtimeMs).toBe(before.mtime)
    expect(statSync(sep).mtimeMs).toBe(before.dir)
  })
})

describe('the primary-key index', () => {
  it('reads each meeting once, then only a stat per month until the folder changes', () => {
    const sep = month('quilt', '2026-09')
    for (let i = 0; i < 5; i++) { meeting(sep, `2026-09-1${i}_M${i}.md`); ff(sep, `2026-09-1${i}_M${i}.md`, `01FF${i}`) }
    meetingPrimaryKeyClaims(root, null)
    expect(meetingPrimaryKeyCacheStats().reads).toBe(5)
    meetingPrimaryKeyClaims(root, null)
    expect(meetingPrimaryKeyCacheStats().reads).toBe(5)
    // A new meeting lands (renamed into place, so the folder's stamp moves): that month is read again.
    meeting(sep, '2026-09-20_New.md'); ff(sep, '2026-09-20_New.md', '01FFNEW')
    const later = new Date(Date.now() + 5_000); utimesSync(sep, later, later)
    const claims = meetingPrimaryKeyClaims(root, null)
    expect(meetingPrimaryKeyCacheStats().reads).toBe(11)
    expect(claims.get('ff:01FFNEW')).toBe(1)
  })
})

describe('a card link resolves to its meeting keys, whatever record id it was linked under (QA B1)', () => {
  it('a standalone link names its session; an imported or re-derived one is read-only', () => {
    expect(meetingContextForRecord('standalone:meeting_1790_abc', null)).toEqual({ contextKeys: ['g2:meeting_1790_abc'], contextSupported: true })
    expect(meetingContextForRecord('imported:fireflies:0123456789abcdef', null).contextReason).toBe('read_only_record')
    expect(meetingContextForRecord('blended:0123456789abcdef', null).contextReason).toBe('read_only_record')
    expect(meetingContextForRecord('standalone:../x', null).contextSupported).toBe(false)
  })

  it('an ops link at its own path, after the G2 rename, and after a domain move keeps the same keys', () => {
    const p = month('personal', '2026-10')
    const raw = '2026-10-06_G2_Recording_2026-10-06_1214_abcdef12.md'
    meeting(p, raw); g2(p, raw, 'meeting_moves')
    const link = `ops:personal:2026-10:${raw}`
    expect(meetingContextForRecord(link, null)).toEqual({ contextKeys: ['g2:meeting_moves'], contextSupported: true })
    // Enrichment renames it (the content carries the capture's date and time) and the sidecar moves with it.
    rmSync(join(p, raw)); rmSync(join(p, raw.replace(/\.md$/, '.g2-chunks.json')))
    writeFileSync(join(p, '2026-10-06_Pricing_Reset_(G2).md'), '# Pricing reset\n\n| **Date** | 2026-10-06 12:14 |\n\n## Summary\nS\n')
    g2(p, '2026-10-06_Pricing_Reset_(G2).md', 'meeting_moves')
    expect(meetingContextForRecord(link, null)).toEqual({ contextKeys: ['g2:meeting_moves'], contextSupported: true,
      resolvedRecordId: 'ops:personal:2026-10:2026-10-06_Pricing_Reset_(G2).md' })
    // Then refiled to another domain under the same name.
    const q = month('quilt', '2026-10')
    for (const ext of ['.md', '.g2-chunks.json']) {
      writeFileSync(join(q, '2026-10-06_Pricing_Reset_(G2)' + ext), readFileSync(join(p, '2026-10-06_Pricing_Reset_(G2)' + ext)))
      rmSync(join(p, '2026-10-06_Pricing_Reset_(G2)' + ext))
    }
    expect(meetingContextForRecord('ops:personal:2026-10:2026-10-06_Pricing_Reset_(G2).md', null)).toMatchObject({
      contextKeys: ['g2:meeting_moves'], resolvedRecordId: 'ops:quilt:2026-10:2026-10-06_Pricing_Reset_(G2).md' })
    // The raw link survives the rename AND the move.
    expect(meetingContextForRecord(link, null).contextKeys).toEqual(['g2:meeting_moves'])
  })

  it('a standalone link to a capture two operations meetings carry is ambiguous', () => {
    const p = month('personal', '2026-10'), q = month('quilt', '2026-10')
    meeting(p, '2026-10-03_A_(G2).md'); g2(p, '2026-10-03_A_(G2).md', 'meeting_contested')
    meeting(q, '2026-10-03_A_(G2).md'); g2(q, '2026-10-03_A_(G2).md', 'meeting_contested')
    expect(meetingContextForRecord('standalone:meeting_contested', null)).toMatchObject({ contextSupported: false, contextAmbiguous: true })
  })

  it('two candidates are no answer: never a guess', () => {
    const a = month('quilt', '2026-10'), b = month('hermit_crabs', '2026-10')
    meeting(a, '2026-10-02_Standup.md'); ff(a, '2026-10-02_Standup.md', '01FFA')
    meeting(b, '2026-10-02_Standup.md'); ff(b, '2026-10-02_Standup.md', '01FFB')
    expect(meetingContextForRecord('ops:personal:2026-10:2026-10-02_Standup.md', null)).toEqual({ contextKeys: [], contextSupported: false, contextReason: 'no_source_id' })
    // Its own domain still answers for itself.
    expect(meetingContextForRecord('ops:quilt:2026-10:2026-10-02_Standup.md', null).contextKeys).toEqual(['ff:01FFA'])
  })

  it('a merged scribe link carries the captures it declares', () => {
    const q = month('quilt', '2026-10')
    meeting(q, '2026-10-01_Review.md', '<!-- g2-session: meeting_absorbed -->'); ff(q, '2026-10-01_Review.md', '01FFREV')
    expect(meetingContextForRecord('ops:quilt:2026-10:2026-10-01_Review.md', null).contextKeys).toEqual(['ff:01FFREV', 'g2:meeting_absorbed'])
  })

  it('refuses a path in the link', () => {
    month('quilt', '2026-10')
    for (const bad of ['ops:quilt:2026-10:../../etc/passwd.md', 'ops:../x:2026-10:a.md', 'ops:quilt:2026-13:a.md']) {
      expect(meetingContextForRecord(bad, null).contextSupported).toBe(false)
    }
  })
})

describe('QA round 1 (2026-10-06)', () => {
  it('a merged scribe with markers only, beside two captures not yet retired, is not ambiguous', () => {
    const q = month('quilt', '2026-10')
    meeting(q, '2026-10-01_Launch_A_(G2).md'); g2(q, '2026-10-01_Launch_A_(G2).md', 'meeting_A1')
    meeting(q, '2026-10-01_Launch_B_(G2).md'); g2(q, '2026-10-01_Launch_B_(G2).md', 'meeting_B1')
    meeting(q, '2026-10-01_Launch_Review.md', '<!-- g2-session: meeting_A1 -->\n<!-- g2-session: meeting_B1 -->')
    const rows = Object.fromEntries(listCosOperationsMeetings({ month: '2026-10', limit: 10 }).map(r => [r.filename, r]))
    expect(rows['2026-10-01_Launch_Review.md']).toMatchObject({ contextKeys: ['g2:meeting_A1', 'g2:meeting_B1'], contextSupported: true })
    expect(rows['2026-10-01_Launch_A_(G2).md'].contextSupported).toBe(true)
    expect(getCosOperationsMeetingDetail('quilt', '2026-10', '2026-10-01_Launch_Review.md')!.contextSupported).toBe(true)
  })

  it('a markers-only scribe whose capture lives twice is contested, so it is ambiguous too', () => {
    const p = month('personal', '2026-10'), q = month('quilt', '2026-10')
    meeting(p, '2026-10-01_Cap_(G2).md'); g2(p, '2026-10-01_Cap_(G2).md', 'meeting_twice')
    meeting(q, '2026-10-01_Cap_(G2).md'); g2(q, '2026-10-01_Cap_(G2).md', 'meeting_twice')
    meeting(q, '2026-10-01_Merged.md', '<!-- g2-session: meeting_twice -->')
    const merged = listCosOperationsMeetings({ month: '2026-10', limit: 10 }).find(r => r.filename === '2026-10-01_Merged.md')!
    expect(merged).toMatchObject({ contextSupported: false, contextAmbiguous: true })
  })

  it('the index never reads a meeting body', () => {
    const q = month('quilt', '2026-10')
    meeting(q, '2026-10-01_Only_Markers.md', '<!-- g2-session: meeting_M -->')
    expect(meetingPrimaryKeyClaims(root, null).size).toBe(0)
  })

  it('a sidecar rewritten in place (the folder stamp unchanged) is seen within a minute', () => {
    const q = month('quilt', '2026-10')
    meeting(q, '2026-10-02_X.md'); ff(q, '2026-10-02_X.md', '01FFX')
    meeting(q, '2026-10-02_Y.md'); ff(q, '2026-10-02_Y.md', '01FFY')
    expect(meetingPrimaryKeyClaims(root, null).get('ff:01FFX')).toBe(1)
    const before = statSync(q)
    ff(q, '2026-10-02_Y.md', '01FFX')
    // Rewritten in place: the folder's own stamp has not moved, so only the minute's re-read can see it.
    const after = statSync(q)
    expect(`${after.mtimeMs}:${after.ctimeMs}`).toBe(`${before.mtimeMs}:${before.ctimeMs}`)
    expect(meetingPrimaryKeyClaims(root, null).get('ff:01FFX')).toBe(1)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    try {
      expect(meetingPrimaryKeyClaims(root, null).get('ff:01FFX')).toBe(2)
    } finally { clock.mockRestore() }
  })
})
