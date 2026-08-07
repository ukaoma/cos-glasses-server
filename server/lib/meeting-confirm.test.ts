// Confirming a label the display floor demoted.
//
// THE GAP THIS CLOSES. The floor stops the identifier asserting a name it did
// not earn — a 0.56 match over one segment is not evidence. But a person who
// was in the room IS evidence, and there was no way to record it: a rename
// cannot say "yes, that really is her" because `relabelSidecarJson` rejects
// `from === to`. So the panel demoted the row, told the reviewer to name it,
// and offered a candidate list that deliberately excluded the very name they
// wanted. Miles hit exactly that on 2026-08-07 with Queen Ukaoma at 0.56.
//
// A confirmation rewrites NOTHING. It records that a human vouched, and the
// review stops presenting the label as unearned.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dataDir = ''

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'meeting-confirm-'))
  process.env.COS_DATA_DIR = dataDir
  vi.resetModules()
})

afterEach(() => {
  delete process.env.COS_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
  vi.resetModules()
})

/** Chunks that produce a demoted row: one segment, similarity below the floor. */
function weakChunks(label: string) {
  return [
    { speaker: label, text: 'I have to run around and go to the hospital', elapsed: 0, similarity: 0.56 },
    { speaker: 'Ext', text: 'other person talking', elapsed: 10_000, similarity: 0.9 },
    { speaker: 'Ext', text: 'and continuing', elapsed: 20_000, similarity: 0.9 },
    { speaker: 'Ext', text: 'and still going', elapsed: 30_000, similarity: 0.9 },
  ]
}

describe('confirming a demoted label', () => {
  it('demotes a weak label when nothing is confirmed', async () => {
    const { reviewMeetingSpeakers } = await import('./meeting-speaker-review.js')

    const review = reviewMeetingSpeakers(weakChunks('Queen Ukaoma'), { owner: 'MU' })
    const row = review.voices.find(v => v.label === 'Queen Ukaoma')

    expect(row).toBeDefined()
    expect(row!.nameAsserted).toBe(false)
    expect(row!.confirmedByHuman).toBe(false)
    // Both reasons stated, which is what makes the demotion reviewable.
    expect(row!.assertionBlockers.join(' ')).toMatch(/1 segment/)
    expect(row!.assertionBlockers.join(' ')).toMatch(/0\.56/)
  })

  it('asserts the name once a human confirms it', async () => {
    const { reviewMeetingSpeakers } = await import('./meeting-speaker-review.js')

    const review = reviewMeetingSpeakers(weakChunks('Queen Ukaoma'), {
      owner: 'MU',
      confirmed: new Set(['Queen Ukaoma']),
    })
    const row = review.voices.find(v => v.label === 'Queen Ukaoma')!

    expect(row.nameAsserted).toBe(true)
    expect(row.confirmedByHuman).toBe(true)
    // Blockers are withheld, not listed-then-overridden: "similarity 0.56 below
    // 0.65" under a name the reviewer personally confirmed reads as the
    // confirmation having failed.
    expect(row.assertionBlockers).toEqual([])
  })

  it('confirms ONLY the named label, not every weak row', async () => {
    const { reviewMeetingSpeakers } = await import('./meeting-speaker-review.js')
    const chunks = [
      ...weakChunks('Queen Ukaoma'),
      { speaker: 'Luke Henry', text: 'a different weak voice', elapsed: 40_000, similarity: 0.58 },
    ]

    const review = reviewMeetingSpeakers(chunks, { owner: 'MU', confirmed: new Set(['Queen Ukaoma']) })

    expect(review.voices.find(v => v.label === 'Queen Ukaoma')!.nameAsserted).toBe(true)
    expect(review.voices.find(v => v.label === 'Luke Henry')!.nameAsserted).toBe(false)
  })

  it('records and reads back a confirmation, scoped to one meeting', async () => {
    const { appendCorrection, confirmedLabels } = await import('./meeting-corrections.js')

    expect(confirmedLabels('meeting_a').size).toBe(0)
    const ok = appendCorrection('meeting_a', {
      id: 'confirm-1', phase: 'confirmed', at: new Date().toISOString(),
      from: 'Queen Ukaoma', to: 'Queen Ukaoma', chunks: [], scope: 'meeting',
    })
    expect(ok).toBe(true)

    // The write succeeded and the READ dropped it: readCorrections validated
    // phase against a hardcoded list that did not include 'confirmed', so the
    // row counted as unusable and the confirmation vanished with no error.
    const { readCorrections } = await import('./meeting-corrections.js')
    expect(readCorrections('meeting_a').unusable).toBe(0)
    expect(confirmedLabels('meeting_a').has('Queen Ukaoma')).toBe(true)
    // Vouching for a voice in one room says nothing about a different room.
    expect(confirmedLabels('meeting_b').has('Queen Ukaoma')).toBe(false)
  })

  it('does not treat an ordinary rename as a confirmation', async () => {
    const { appendCorrection, confirmedLabels } = await import('./meeting-corrections.js')

    appendCorrection('meeting_c', {
      id: 'rename-1', phase: 'applied', at: new Date().toISOString(),
      from: 'Navaz Sharif', to: 'Queen Ukaoma', chunks: [0], scope: 'meeting',
    })

    // An applied rename is not a vouch. Only a 'confirmed' row waives the floor.
    expect(confirmedLabels('meeting_c').size).toBe(0)
  })

  it('a confirmation still shows a thrash caveat, so a mixed row stays visibly mixed', async () => {
    const { reviewMeetingSpeakers } = await import('./meeting-speaker-review.js')
    // Alternating speakers produce a thrash pair.
    const chunks = Array.from({ length: 12 }, (_, i) => ({
      speaker: i % 2 === 0 ? 'Queen Ukaoma' : 'Clem Ukaoma',
      text: `turn ${i}`,
      elapsed: i * 10_000,
      similarity: 0.9,
    }))

    const review = reviewMeetingSpeakers(chunks, { owner: 'MU', confirmed: new Set(['Queen Ukaoma']) })
    const row = review.voices.find(v => v.label === 'Queen Ukaoma')!

    expect(row.confirmedByHuman).toBe(true)
    // The name is asserted, but the evidence that it swaps is NOT hidden.
    expect(row.thrashesWith.length).toBeGreaterThan(0)
  })
})
