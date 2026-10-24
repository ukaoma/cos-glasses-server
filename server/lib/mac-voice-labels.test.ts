// 6.90.0: `Voice N` is a placeholder everywhere a real name is checked. One test
// per site, each driving the real function, so dropping the Voice clause from any
// one of them fails a named test here.
import { describe, expect, it } from 'vitest'
import { isMacCaptureSidecar, isVoiceLabel, macVoiceLabelsEnabled, voiceLabel } from './mac-voice-labels.js'
import { isUnattributed } from './meeting-speaker-review.js'
import { isPlaceholderLabel } from './meeting-relabel-enrolment.js'
import { isNamedSegmentSpeaker, segmentTranscriptChunks } from './meeting-batch-transcribe.js'
import { nameChunkSegments } from './nemotron-live.js'
import { relabelSidecarJson } from './meeting-relabel.js'
import { shadowBestMatch, SHADOW_FLOOR, type ShadowSearchManager } from './speaker-embeddings.js'
import { activityOf, signVoiceprint, wavOf } from './__fixtures__/nemotron-helpers.js'

describe('the label', () => {
  it('is exactly Voice 1 to Voice 99', () => {
    for (const label of ['Voice 1', 'Voice 2', 'Voice 10', 'Voice 99']) expect(isVoiceLabel(label)).toBe(true)
    for (const label of ['Voice 0', 'Voice 01', 'Voice 100', 'voice 1', 'Voice  1', 'Voice 1 ', 'Voice', 'Voice A', 'Voiceover 1', 'Dana Reyes', '', null, 3])
      expect(isVoiceLabel(label)).toBe(false)
    expect(voiceLabel(3)).toBe('Voice 3')
    expect(() => voiceLabel(0)).toThrow()
    expect(() => voiceLabel(100)).toThrow()
  })

  it('the switch is on unless 0, false, off or no', () => {
    expect(macVoiceLabelsEnabled({})).toBe(true)
    expect(macVoiceLabelsEnabled({ COS_MAC_VOICE_LABELS: '1' })).toBe(true)
    expect(macVoiceLabelsEnabled({ COS_MAC_VOICE_LABELS: 'yes' })).toBe(true)
    for (const off of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) expect(macVoiceLabelsEnabled({ COS_MAC_VOICE_LABELS: off })).toBe(false)
  })

  it('a Mac capture is a mac_ id or a mac_system_audio sidecar, and fails closed on a malformed mac_ id', () => {
    expect(isMacCaptureSidecar({}, 'mac_0a1b2c3d-0000-4000-8000-000000000001')).toBe(true)
    expect(isMacCaptureSidecar({}, 'mac_not-a-uuid')).toBe(true)
    expect(isMacCaptureSidecar({ sourceType: 'mac_system_audio' }, 'meeting_x')).toBe(true)
    expect(isMacCaptureSidecar({ sessionId: 'mac_whatever' })).toBe(true)
    expect(isMacCaptureSidecar({ sessionId: 'meeting_x' }, 'meeting_x')).toBe(false)
    expect(isMacCaptureSidecar(null)).toBe(false)
  })
})

describe('Voice N is a placeholder at every site that checks for a name', () => {
  it('isUnattributed: the review panel and the final pass read it as no identity', () => {
    expect(isUnattributed('Voice 2')).toBe(true)
    expect(isUnattributed('Dana Reyes')).toBe(false)
  })

  it('PLACEHOLDER_LABEL: naming a Voice is a first naming, and a Voice target never enrols', () => {
    expect(isPlaceholderLabel('Voice 2')).toBe(true)
    expect(isPlaceholderLabel('voice 12')).toBe(true)
    expect(isPlaceholderLabel('Voice Hart')).toBe(false)
  })

  it('the batch speakers filters: a Voice label is never a segment speaker', () => {
    expect(isNamedSegmentSpeaker('Voice 1')).toBe(false)
    expect(isNamedSegmentSpeaker('Ext')).toBe(false)
    expect(isNamedSegmentSpeaker('')).toBe(false)
    expect(isNamedSegmentSpeaker('Dana Reyes')).toBe(true)
    // Through the real segmenter: a Standard chunk keeps its label, so only the filter stops it.
    const chunk = (speaker: string, elapsed: number) => ({ text: 'x', speaker, elapsed, similarity: 0.9 })
    const segments = segmentTranscriptChunks([
      { chunkIndex: 0, chunk: chunk('Voice 1', 0) },
      { chunkIndex: 1, chunk: chunk('Dana Reyes', 10_000) },
      { chunkIndex: 2, chunk: chunk('Voice 2', 20_000) },
    ] as never, 30_000)
    expect(segments.flatMap(segment => segment.speakers)).toEqual(['Dana Reyes'])
  })

  it('isRealLabel: a Voice client label is not a would-be name, so it never counts as an owner-guard refusal', () => {
    const base = {
      activity: activityOf(6, [[2, 0, 4.5], [6, 5, 5.8]]),
      text: 'We should hold the budget until Monday. Right.',
      audio: wavOf(6, () => 300),
      identify: signVoiceprint({ positive: 'Dana Reyes', negative: 'Rowan Vale' }),
      owner: 'Rowan Vale',
      chunkVoiceprint: { speaker: 'Dana Reyes', similarity: 0.7 },
    }
    const voice = nameChunkSegments({ ...base, clientSpeaker: 'Voice 2' })
    const named = nameChunkSegments({ ...base, clientSpeaker: 'Rowan Vale' })
    if (!voice.ok || !named.ok) throw new Error('unreachable')
    expect(voice.ownerGuard.client_label).toBe(0)
    expect(named.ownerGuard.client_label).toBe(1)
  })

  it('relabel: merging into a Voice label never writes the placeholder into speakers', () => {
    const raw = JSON.stringify({ speakers: ['Dana Reyes'], chunks: [{ speaker: 'Dana Reyes' }, { speaker: 'Voice 1' }] })
    const merged = relabelSidecarJson(raw, 'Dana Reyes', 'Voice 1')
    if (!merged.ok) throw new Error(merged.error)
    expect(merged.value.speakers).toEqual([])
    const named = relabelSidecarJson(raw, 'Voice 1', 'Kai Moreno')
    if (!named.ok) throw new Error(named.error)
    expect(named.value.speakers).toEqual(['Dana Reyes', 'Kai Moreno'])
  })
})

describe('shadow scoring (calibration only)', () => {
  /** A fake manager: `best` clears any threshold up to `sim`. */
  const manager = (best: string, sim: number): ShadowSearchManager & { searches: number[] } => {
    const searches: number[] = []
    return {
      searches,
      search: ({ threshold }) => { searches.push(threshold); return threshold <= sim ? best : '' },
      verify: ({ name, threshold }) => name === best && threshold <= sim,
    }
  }

  it('reports the best match and its similarity at the 0.55 floor', () => {
    const m = manager('Dana Reyes', 0.71)
    const shadow = shadowBestMatch(m, new Float32Array(4))
    expect(SHADOW_FLOOR).toBe(0.55)
    expect(m.searches).toEqual([0.55])
    expect(shadow.speaker).toBe('Dana Reyes')
    expect(shadow.similarity).toBeCloseTo(0.71, 2)
  })

  it('below the floor it is Ext with 0; a throwing manager is Ext with 0', () => {
    expect(shadowBestMatch(manager('Dana Reyes', 0.4), new Float32Array(4))).toEqual({ speaker: 'Ext', similarity: 0 })
    const broken: ShadowSearchManager = { search: () => { throw new Error('model gone') }, verify: () => false }
    expect(shadowBestMatch(broken, new Float32Array(4))).toEqual({ speaker: 'Ext', similarity: 0 })
  })
})
