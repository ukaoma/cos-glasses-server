// Tracing a stored voice sample back to the meeting that produced it.
//
// The filenames and provenance strings below are verbatim from the live store on
// 2026-08-06 (`meeting_1785190805524_uzxmn4_chunk327_sim0.57.wav`,
// `auto:meeting_1774377156653`, bare `g2-training`). A fixture that drifts from
// those formats proves nothing about real retraction.
import { describe, expect, it } from 'vitest'
import {
  isSampleFromSession,
  sessionIdFromTrainingWav,
  trainingSourceFor,
  untraceableSampleCount,
} from './training-audio-provenance.js'

describe('reading the session out of a training WAV name', () => {
  it('handles the real filename format', () => {
    expect(sessionIdFromTrainingWav('meeting_1785190805524_uzxmn4_chunk327_sim0.57.wav'))
      .toBe('meeting_1785190805524_uzxmn4')
  })

  it('splits on _chunk, NOT on the last underscore', () => {
    // Session ids contain underscores. Splitting on the last one would yield
    // `meeting_1785190805524_uzxmn4_chunk327` and match nothing, silently making
    // every sample untraceable.
    const id = sessionIdFromTrainingWav('meeting_1785190805524_uzxmn4_chunk9_sim0.61.wav')
    expect(id).toBe('meeting_1785190805524_uzxmn4')
    expect(id).not.toContain('chunk')
  })

  it('returns null when there is no chunk marker', () => {
    for (const f of ['random.wav', 'chunk12_sim0.5.wav', '', '_chunk1.wav']) {
      expect(sessionIdFromTrainingWav(f), f).toBeNull()
    }
  })

  it('rejects an id that would not be a legal session id', () => {
    expect(sessionIdFromTrainingWav('../../etc/passwd_chunk1_sim0.5.wav')).toBeNull()
    expect(sessionIdFromTrainingWav('a_chunk1.wav')).toBeNull()   // too short
  })
})

describe('the provenance a trained sample records', () => {
  it('stamps the session when the filename carries one', () => {
    expect(trainingSourceFor('meeting_1785190805524_uzxmn4_chunk327_sim0.57.wav'))
      .toBe('g2-training:meeting_1785190805524_uzxmn4')
  })

  it('falls back to the historic bare form rather than inventing a session', () => {
    // A wrong session id would retract a DIFFERENT meeting's evidence, which is
    // strictly worse than being untraceable.
    expect(trainingSourceFor('mystery.wav')).toBe('g2-training')
  })

  it('keeps the eviction tier intact — the head before any separator is unchanged', async () => {
    // The eviction policy classifies on the prefix before `:` or `_`. If stamping
    // the session moved `g2-training` out of the `assisted` tier, these samples
    // would silently become the weakest tier and be evicted first.
    const { provenanceTier } = await import('./embedding-eviction.js')
    expect(provenanceTier(trainingSourceFor('meeting_1785190805524_uzxmn4_chunk1_sim0.6.wav'))).toBe('assisted')
    expect(provenanceTier(trainingSourceFor('mystery.wav'))).toBe('assisted')
  })
})

describe('deciding whether a sample came from one meeting', () => {
  const SID = 'meeting_1785190805524_uzxmn4'

  it('matches every session-stamped provenance form', () => {
    expect(isSampleFromSession(`auto:${SID}`, SID)).toBe(true)
    expect(isSampleFromSession(`correction:${SID}`, SID)).toBe(true)
    expect(isSampleFromSession(`g2-training:${SID}`, SID)).toBe(true)
  })

  it('does not match a different meeting', () => {
    expect(isSampleFromSession('auto:meeting_9999999999999_zzzzzz', SID)).toBe(false)
  })

  it('requires an EXACT session match, not a prefix', () => {
    // A prefix test would let `auto:<SID>_extra` match and retract another
    // meeting's evidence from the profile.
    expect(isSampleFromSession(`auto:${SID}_extra`, SID)).toBe(false)
    expect(isSampleFromSession(`auto:${SID.slice(0, -2)}`, SID)).toBe(false)
  })

  it('never matches provenance with no session at all', () => {
    for (const s of ['g2-training', 'fireflies', 'manual', 'ext-retroactive', 'unknown', undefined, null, '']) {
      expect(isSampleFromSession(s, SID), String(s)).toBe(false)
    }
  })

  it('never matches when the session id is empty', () => {
    // Otherwise an empty id would sweep every stamped sample off the profile.
    expect(isSampleFromSession(`auto:${SID}`, '')).toBe(false)
    // The discriminating case: a TRUNCATED source whose session part is also
    // empty would pass the exact-equality check, so the empty-id guard is what
    // actually stops `auto:` matching ''.
    expect(isSampleFromSession('auto:', '')).toBe(false)
    expect(isSampleFromSession('correction:', '')).toBe(false)
    expect(isSampleFromSession('g2-training:', '')).toBe(false)
  })
})

describe('reporting what cannot be reached', () => {
  it('counts samples with no session provenance', () => {
    // Reported so a de-attribution is honest about its reach rather than
    // implying the profile was fully cleaned.
    const sources = [
      'auto:meeting_1', 'g2-training:meeting_1',      // traceable
      'g2-training', 'fireflies', 'manual', 'unknown', // not
    ]
    expect(untraceableSampleCount(sources)).toBe(4)
  })

  it('counts holes as untraceable', () => {
    expect(untraceableSampleCount([undefined, null, 'auto:meeting_1'])).toBe(2)
  })

  it('is zero for a fully stamped profile', () => {
    expect(untraceableSampleCount(['auto:m1', 'correction:m2', 'g2-training:m3'])).toBe(0)
  })
})
