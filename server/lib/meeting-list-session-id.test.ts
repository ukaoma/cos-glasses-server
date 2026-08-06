// list() carries each meeting's sessionId, so a Control row can open the
// per-meeting speaker review.
//
// The review endpoint is keyed on sessionId rather than filename because that is
// what lets the store's own hardened lookup find the sidecar again. Without this
// field the list surface and the review surface could not be joined at all.
//
// Read cost is the second thing under test: sidecars run to megabytes, so this
// must not read them whole.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MeetingStore } from './meeting-store.js'

let root = ''
let store: MeetingStore

const MONTH = '2026-08'

function md(title: string): string {
  return `# ${title}\n\n| Field | Value |\n|---|---|\n| **Date** | 2026-08-05 |\n| **Domain** | Personal |\n`
}

function seed(stem: string, title: string, sidecar: string | null): void {
  const dir = join(root, MONTH)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${stem}.md`), md(title))
  if (sidecar !== null) writeFileSync(join(dir, `${stem}.g2-chunks.json`), sidecar)
}

/** A sidecar the size a real 30-minute meeting produces. */
function fatSidecar(sessionId: string, chunkCount = 4000): string {
  const chunks = Array.from({ length: chunkCount }, (_, i) => ({
    text: `segment ${i} with a reasonable amount of transcript text in it to add weight`,
    speaker: 'MU', elapsed: i * 7000, similarity: 0.8,
  }))
  return JSON.stringify({ schemaVersion: 1, sessionId, startTime: 1, durationMs: 1_899_000, chunks })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-list-sid-'))
  store = new MeetingStore(root)
})
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

describe('sessionId on the meeting list', () => {
  it('carries the sessionId from the sidecar', () => {
    seed('2026-08-05_Lead_Ops_Review_abc12345', 'Lead Ops Review',
      JSON.stringify({ schemaVersion: 1, sessionId: 'meeting_1785971169854_16dcao', chunks: [] }))
    const [row] = store.list()
    expect(row.sessionId).toBe('meeting_1785971169854_16dcao')
    expect(row.title).toBe('Lead Ops Review')
  })

  it('OMITS the field for a meeting with no sidecar, rather than inventing one', () => {
    seed('2026-08-05_Older_Meeting_def45678', 'Older Meeting', null)
    const [row] = store.list()
    expect(row).not.toHaveProperty('sessionId')
    // The row is still listed — a missing sidecar is not a missing meeting.
    expect(row.title).toBe('Older Meeting')
  })

  it('omits it for a corrupt sidecar instead of failing the whole list', () => {
    seed('2026-08-05_Truncated_aaa11111', 'Truncated', '{"schemaVersion":1,"sessi')
    seed('2026-08-05_Healthy_bbb22222', 'Healthy',
      JSON.stringify({ sessionId: 'meeting_ok_1', chunks: [] }))
    const rows = store.list()
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.title === 'Truncated')).not.toHaveProperty('sessionId')
    expect(rows.find(r => r.title === 'Healthy')!.sessionId).toBe('meeting_ok_1')
  })

  it('finds the id even when it is not the first key', () => {
    seed('2026-08-05_Reordered_ccc33333', 'Reordered',
      JSON.stringify({ schemaVersion: 1, startTime: 1, durationMs: 2, domain: 'personal',
        title: 'Reordered', canonicalProvider: 'x', sessionId: 'meeting_late_key', chunks: [] }))
    expect(store.list()[0].sessionId).toBe('meeting_late_key')
  })

  it('rejects a nonsense id rather than passing it through', () => {
    seed('2026-08-05_Bad_Id_ddd44444', 'Bad Id',
      JSON.stringify({ sessionId: '../../etc/passwd', chunks: [] }))
    expect(store.list()[0]).not.toHaveProperty('sessionId')
  })

  it('reads only the HEAD, proven behaviourally on an over-cap sidecar', () => {
    // A timing assertion cannot prove this — whole-reading 300 KB is still fast
    // enough to pass any threshold loose enough to be stable, which a mutation
    // run confirmed. So assert the property instead: this sidecar is larger than
    // the store's MAX_MEETING_BYTES whole-file cap (10 MB), which means a reader
    // that takes the whole file returns null and loses the sessionId entirely.
    // Only a head-read can still find it.
    const big = fatSidecar('meeting_big_1', 130_000)
    expect(big.length).toBeGreaterThan(10 * 1024 * 1024)
    seed('2026-08-05_Big_Meeting_eee55555', 'Big Meeting', big)

    const [row] = store.list()
    expect(row.sessionId).toBe('meeting_big_1')
  })

  it('still lists a meeting whose sidecar is enormous', () => {
    // The row must survive regardless: an over-cap sidecar is a listing detail,
    // never a reason to hide the meeting.
    seed('2026-08-05_Huge_ggg77777', 'Huge', fatSidecar('meeting_huge_1', 130_000))
    expect(store.list().map(r => r.title)).toEqual(['Huge'])
  })

  it('will not follow a symlinked sidecar out of the month directory', () => {
    const outside = join(root, 'outside.json')
    writeFileSync(outside, JSON.stringify({ sessionId: 'meeting_escaped_1', chunks: [] }))
    seed('2026-08-05_Symlinked_fff66666', 'Symlinked', null)
    symlinkSync(outside, join(root, MONTH, '2026-08-05_Symlinked_fff66666.g2-chunks.json'))
    expect(store.list()[0]).not.toHaveProperty('sessionId')
  })

  it('keeps working across several meetings in one month', () => {
    seed('2026-08-05_First_111aaaaa', 'First', JSON.stringify({ sessionId: 'meeting_a', chunks: [] }))
    seed('2026-08-04_Second_222bbbbb', 'Second', JSON.stringify({ sessionId: 'meeting_b', chunks: [] }))
    const ids = store.list().map(r => r.sessionId).sort()
    expect(ids).toEqual(['meeting_a', 'meeting_b'])
  })
})
