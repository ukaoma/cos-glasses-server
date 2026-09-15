// The ONE hook every speaker mutation goes through.
//
// WHY HERE AND NOT IN THE ROUTES. Relabel, confirm and de-attribute are three handlers today
// and a fourth is a plausible next release. A listener wired into each of them is a listener
// the fourth silently does not get. Every one of them closes its correction through
// `appendCorrection`, so this is where "a human changed who said what in this meeting"
// actually happens, and it is the only place the merge runner subscribes.

import { describe, expect, it } from 'vitest'
import { appendCorrection, onCorrectionApplied, type CorrectionRow } from './meeting-corrections.js'

const SESSION = 'hook-test-session'

function row(overrides: Partial<CorrectionRow> = {}): CorrectionRow {
  return {
    id: `c-${Math.random().toString(16).slice(2)}`,
    phase: 'applied',
    at: new Date().toISOString(),
    from: 'Speaker 1',
    to: 'Nadia Okonkwo',
    chunks: [0, 1],
    scope: 'meeting',
    ...overrides,
  }
}

describe('subscribing to corrections', () => {
  it('tells a listener which session changed, with the row', () => {
    const seen: Array<{ sessionId: string; phase: string }> = []
    const off = onCorrectionApplied((sessionId, correction) => seen.push({ sessionId, phase: correction.phase }))
    try {
      appendCorrection(SESSION, row())
    } finally {
      off()
    }
    expect(seen).toEqual([{ sessionId: SESSION, phase: 'applied' }])
  })

  it('fires for every outcome phase a mutation route writes', () => {
    // relabel closes 'applied'; the confirm route writes 'confirmed' and
    // 'confirmed-chunks'; an undo writes 'reverted'. All four mean the labels on this
    // meeting are now different from what a derived record was built on.
    const seen: string[] = []
    const off = onCorrectionApplied((_sessionId, correction) => seen.push(correction.phase))
    try {
      for (const phase of ['applied', 'confirmed', 'confirmed-chunks', 'reverted'] as const) {
        appendCorrection(SESSION, row({ phase }))
      }
    } finally {
      off()
    }
    expect(seen).toEqual(['applied', 'confirmed', 'confirmed-chunks', 'reverted'])
  })

  it('unsubscribes', () => {
    const seen: string[] = []
    const off = onCorrectionApplied(() => seen.push('x'))
    off()
    appendCorrection(SESSION, row())
    expect(seen).toEqual([])
  })

  it('does not fire for a session id it refuses to write at all', () => {
    // `appendCorrection` returns false for an unsafe session id and writes nothing. Firing
    // there would tell the runner to re-derive a meeting whose correction never landed.
    const seen: string[] = []
    const off = onCorrectionApplied(() => seen.push('x'))
    try {
      expect(appendCorrection('../escape', row())).toBe(false)
    } finally {
      off()
    }
    expect(seen).toEqual([])
  })

  it('contains a listener that throws, and keeps the correction successful', () => {
    // The correction is already durable by the time a listener runs. A downstream reaction
    // failing must never make the correction look failed to its caller.
    const seen: string[] = []
    const offBad = onCorrectionApplied(() => { throw new Error('re-derive unavailable') })
    const offGood = onCorrectionApplied(() => seen.push('still ran'))
    try {
      expect(appendCorrection(SESSION, row())).toBe(true)
    } finally {
      offBad()
      offGood()
    }
    expect(seen).toEqual(['still ran'])
  })
})
