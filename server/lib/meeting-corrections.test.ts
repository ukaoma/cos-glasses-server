// The correction ledger, tested by execution against real files.
//
// The properties that matter are the ones that make a correction recoverable:
// an intent that never closed must be VISIBLE, a chain of corrections must
// resolve to the latest label, and a partially-readable ledger must say so
// rather than quietly reporting fewer corrections than a human actually made.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir = ''
let store: typeof import('./meeting-corrections.js')

const T = '2026-08-06T15:00:00.000Z'

function row(over: Partial<import('./meeting-corrections.js').CorrectionRow> = {}) {
  return {
    id: 'c1', phase: 'intent' as const, at: T,
    from: 'Ext', to: 'Luke Henry', chunks: [] as number[], scope: 'meeting' as const,
    ...over,
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cos-corrections-'))
  process.env.COS_DATA_DIR = dir
  vi.resetModules()
  store = await import('./meeting-corrections.js')
})
afterEach(() => {
  delete process.env.COS_DATA_DIR
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('recording a correction', () => {
  it('appends and reads back what the human decided', () => {
    expect(store.appendCorrection('meeting_a', row({ chunks: [3, 4, 9] }))).toBe(true)
    const out = store.readCorrections('meeting_a')
    expect(out.missing).toBe(false)
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]).toMatchObject({ id: 'c1', phase: 'intent', from: 'Ext', to: 'Luke Henry', chunks: [3, 4, 9] })
  })

  it('is append-only — a second correction never overwrites the first', () => {
    // History is the point. If a later correction replaced an earlier one, undo
    // and audit would both be impossible.
    store.appendCorrection('meeting_b', row({ id: 'c1' }))
    store.appendCorrection('meeting_b', row({ id: 'c1', phase: 'applied', surfaces: { sidecar: 3, attendees: 1, transcript: 3 } }))
    store.appendCorrection('meeting_b', row({ id: 'c2', from: 'Luke Henry', to: 'Luke H' }))
    expect(store.readCorrections('meeting_b').rows.map(r => `${r.id}:${r.phase}`))
      .toEqual(['c1:intent', 'c1:applied', 'c2:intent'])
  })

  it('distinguishes a meeting with no corrections from an unreadable one', () => {
    const out = store.readCorrections('meeting_never')
    expect(out.missing).toBe(true)
    expect(out.rows).toEqual([])
  })

  it('refuses a session id that could escape the directory', () => {
    for (const bad of ['../../etc/passwd', 'a/b', '..', '']) {
      expect(store.appendCorrection(bad, row())).toBe(false)
    }
    expect(existsSync(join(dir, 'meeting-corrections'))).toBe(false)
  })

  it('reports a row it could not parse instead of dropping it silently', () => {
    store.appendCorrection('meeting_c', row())
    const f = join(dir, 'meeting-corrections', 'meeting_c.jsonl')
    appendFileSync(f, 'not json at all\n')
    appendFileSync(f, JSON.stringify({ id: 'x', phase: 'sideways', from: 'A', to: 'B' }) + '\n')
    appendFileSync(f, JSON.stringify({ phase: 'applied', from: 'A', to: 'B' }) + '\n')  // no id
    const out = store.readCorrections('meeting_c')
    expect(out.rows).toHaveLength(1)
    expect(out.unusable).toBe(3)
  })

  it('returns false when the ledger cannot be written', () => {
    // The caller's contract depends on this: a failed INTENT write must stop the
    // rewrite, because an unrecorded mutation is the thing this file prevents.
    writeFileSync(join(dir, 'meeting-corrections'), 'a file where the directory goes')
    expect(store.appendCorrection('meeting_d', row())).toBe(false)
  })
})

describe('an intent that never closed', () => {
  it('is reported as pending — the crash signal', () => {
    store.appendCorrection('meeting_e', row({ id: 'done' }))
    store.appendCorrection('meeting_e', row({ id: 'done', phase: 'applied' }))
    store.appendCorrection('meeting_e', row({ id: 'died', from: 'MU', to: 'Clem Ukaoma' }))
    const pending = store.pendingCorrections('meeting_e')
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ id: 'died', from: 'MU', to: 'Clem Ukaoma' })
  })

  it('counts a FAILED outcome as closed, not pending', () => {
    // A correction that failed cleanly is a known outcome. Only an intent with
    // no outcome at all means the process died mid-rewrite.
    store.appendCorrection('meeting_f', row({ id: 'nope' }))
    store.appendCorrection('meeting_f', row({ id: 'nope', phase: 'failed', error: 'sidecar unreadable' }))
    expect(store.pendingCorrections('meeting_f')).toEqual([])
    expect(store.readCorrections('meeting_f').rows.find(r => r.phase === 'failed')?.error)
      .toBe('sidecar unreadable')
  })

  it('excludes pending and failed corrections from what may be trained on', () => {
    store.appendCorrection('meeting_g', row({ id: 'a', phase: 'applied', chunks: [1] }))
    store.appendCorrection('meeting_g', row({ id: 'b' }))                                   // pending
    store.appendCorrection('meeting_g', row({ id: 'c', phase: 'failed' }))
    // Piece 3 enrolls from these. Training on an intent that never landed would
    // teach a profile from chunks whose labels were never actually changed.
    expect(store.appliedCorrections('meeting_g').map(r => r.id)).toEqual(['a'])
  })
})

describe('resolving the label a voice now carries', () => {
  it('follows a chain to the end', () => {
    store.appendCorrection('meeting_h', row({ id: '1', phase: 'applied', from: 'Ext', to: 'Luke H' }))
    store.appendCorrection('meeting_h', row({ id: '2', phase: 'applied', from: 'Luke H', to: 'Luke Henry' }))
    expect(store.currentLabelFor('meeting_h', 'Ext')).toBe('Luke Henry')
  })

  it('ignores unapplied hops', () => {
    store.appendCorrection('meeting_i', row({ id: '1', phase: 'applied', from: 'Ext', to: 'Luke H' }))
    store.appendCorrection('meeting_i', row({ id: '2', from: 'Luke H', to: 'Luke Henry' }))  // intent only
    expect(store.currentLabelFor('meeting_i', 'Ext')).toBe('Luke H')
  })

  it('does not loop on a correction reversed by hand', () => {
    // A human correcting A→B then B→A is a legitimate undo, and the walk must
    // terminate rather than ping-pong forever.
    store.appendCorrection('meeting_j', row({ id: '1', phase: 'applied', from: 'A', to: 'B' }))
    store.appendCorrection('meeting_j', row({ id: '2', phase: 'applied', from: 'B', to: 'A' }))
    expect(store.currentLabelFor('meeting_j', 'A')).toBe('B')
  })

  it('prefers the LATEST decision when one label was corrected twice', () => {
    store.appendCorrection('meeting_k', row({ id: '1', phase: 'applied', from: 'Ext', to: 'Wrong Person' }))
    store.appendCorrection('meeting_k', row({ id: '2', phase: 'applied', from: 'Ext', to: 'Right Person' }))
    expect(store.currentLabelFor('meeting_k', 'Ext')).toBe('Right Person')
  })

  it('returns the label unchanged when nothing was corrected', () => {
    expect(store.currentLabelFor('meeting_none', 'Chris Krubeck')).toBe('Chris Krubeck')
  })
})

describe('health stats', () => {
  it('counts applied, pending and failed across sessions', () => {
    store.appendCorrection('meeting_s1', row({ id: 'a', phase: 'applied' }))
    store.appendCorrection('meeting_s1', row({ id: 'b' }))                     // pending
    store.appendCorrection('meeting_s2', row({ id: 'c', phase: 'failed' }))
    const st = store.correctionStoreStats()
    expect(st).toEqual({ sessions: 2, applied: 1, pending: 1, failed: 1 })
  })

  it('reports zeroes before any correction exists', () => {
    expect(store.correctionStoreStats()).toEqual({ sessions: 0, applied: 0, pending: 0, failed: 0 })
  })
})

describe('what the ledger records about surfaces', () => {
  it('keeps the per-surface change counts on the applied row', () => {
    // These are the audit trail: "3 chunks, 1 attendee line, 3 turn labels".
    // A correction claiming success while changing nothing is a defect, and
    // without these counts it is indistinguishable from a real one.
    store.appendCorrection('meeting_m', row({
      id: 'x', phase: 'applied', chunks: [2, 5, 8],
      surfaces: { sidecar: 3, attendees: 1, transcript: 3 }, proseStale: true,
    }))
    const applied = store.appliedCorrections('meeting_m')[0]
    expect(applied.surfaces).toEqual({ sidecar: 3, attendees: 1, transcript: 3 })
    expect(applied.chunks).toEqual([2, 5, 8])
    // Prose is deliberately never rewritten, so this flag is how the panel can
    // tell a human the summary still says the old name.
    expect(applied.proseStale).toBe(true)
  })

  it('drops a malformed surfaces object rather than reporting fake counts', () => {
    store.appendCorrection('meeting_n', row())
    const f = join(dir, 'meeting-corrections', 'meeting_n.jsonl')
    appendFileSync(f, JSON.stringify({
      id: 'y', phase: 'applied', at: T, from: 'A', to: 'B', chunks: [],
      surfaces: { sidecar: 'three' },
    }) + '\n')
    expect(store.appliedCorrections('meeting_n')[0].surfaces).toBeUndefined()
    expect(readFileSync(f, 'utf-8').split('\n').filter(Boolean)).toHaveLength(2)
  })
})
