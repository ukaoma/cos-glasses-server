import { describe, expect, it } from 'vitest'
import {
  MAX_PARSED_DURATION_MS,
  MAX_PARSED_VIDEO_FRAMES,
  MAX_PLAUSIBLE_MEDIA_BYTES,
  parseMediaAttachmentRef,
} from '../../shared/media-attachment.js'
import {
  MAX_CHUNKED_MEDIA_BYTES,
  MAX_DERIVATIVE_IMAGES,
  MAX_VIDEO_MEDIA_BYTES,
  VIDEO_SUMMARY_FRAMES_MAX,
} from './rich-media-safety.js'

/**
 * These bounds were three live defects, all the same shape: the WRITER was correct
 * and the READER silently rejected what it wrote. parseMediaAttachmentRef is a
 * whitelist and every field here is optional, so a rejected field disappears with
 * no error at any layer — no throw, no log, no failing test.
 *
 * Every test below therefore ROUND-TRIPS a ref through the real parser and asserts
 * the field SURVIVES. Asserting on the writer cannot see this class of bug; the
 * writer was already right in all three cases.
 */

/** A minimal ref shaped exactly as media-store.ts:570-588 builds one for video. */
function videoRef(extra: Record<string, unknown>) {
  return {
    id: 'm_0123456789abcdef01234567',
    kind: 'user_video',
    mime: 'video/mp4',
    width: 1920,
    height: 1080,
    createdAt: '2026-08-11T16:00:00.000Z',
    category: 'video',
    ...extra,
  }
}

describe('the parser accepts what the server actually writes', () => {
  it('keeps frameCount for a 16-frame video', () => {
    // The defect: bound was hardcoded 8 while VIDEO_SUMMARY_FRAMES_MAX went to 16,
    // so every video past ~90s lost its count. videoSummaryFrameCount(96_000) === 16.
    const parsed = parseMediaAttachmentRef(videoRef({ frameCount: 16 }))
    expect(parsed?.frameCount, 'frameCount 16 must survive the parser').toBe(16)
  })

  it('keeps frameCount across the whole producible range', () => {
    for (let n = 0; n <= VIDEO_SUMMARY_FRAMES_MAX; n++) {
      expect(parseMediaAttachmentRef(videoRef({ frameCount: n }))?.frameCount, `n=${n}`).toBe(n)
    }
  })

  it('keeps bytes for a 100 MiB single-shot video and a 2 GiB chunked one', () => {
    // The defect: bound was hardcoded 64 MiB while the video ceiling moved to 100 MiB
    // and chunked to 2 GiB, so both silently lost their byte count.
    expect(parseMediaAttachmentRef(videoRef({ bytes: MAX_VIDEO_MEDIA_BYTES }))?.bytes)
      .toBe(MAX_VIDEO_MEDIA_BYTES)
    expect(parseMediaAttachmentRef(videoRef({ bytes: MAX_CHUNKED_MEDIA_BYTES }))?.bytes)
      .toBe(MAX_CHUNKED_MEDIA_BYTES)
  })

  it('keeps durationMs past the old one-hour bound', () => {
    // Unreachable today (ingest caps at 20 min) but it was the ceiling any
    // cap-raising work would have hit next, invisibly.
    expect(parseMediaAttachmentRef(videoRef({ durationMs: 4 * 60 * 60_000 }))?.durationMs)
      .toBe(4 * 60 * 60_000)
  })

  it('still rejects garbage rather than trusting any number', () => {
    // The bounds are generous, not absent. A parser that accepts anything is how a
    // corrupt index poisons the store.
    for (const bad of [
      { bytes: MAX_PLAUSIBLE_MEDIA_BYTES + 1 },
      { frameCount: MAX_PARSED_VIDEO_FRAMES + 1 },
      { durationMs: MAX_PARSED_DURATION_MS + 1 },
      { bytes: -1 },
      { frameCount: 2.5 },
      { durationMs: Number.NaN },
    ]) {
      const parsed = parseMediaAttachmentRef(videoRef(bad))
      const key = Object.keys(bad)[0] as 'bytes' | 'frameCount' | 'durationMs'
      expect(parsed, `${key} garbage must still parse the ref`).not.toBeNull()
      expect(parsed?.[key], `${key}=${JSON.stringify(bad)} must be dropped`).toBeUndefined()
    }
  })
})

describe('the mirrored bounds stay pinned to the server ceilings', () => {
  // shared/ must not import server/, so these constants are copies. A copy with no
  // pin is the drift that caused all three defects — the app and server copies of
  // this module had already diverged by ~300 lines when they were found.
  it('frame bound equals VIDEO_SUMMARY_FRAMES_MAX', () => {
    expect(MAX_PARSED_VIDEO_FRAMES).toBe(VIDEO_SUMMARY_FRAMES_MAX)
  })

  it('byte bound is at least the largest upload the server will accept', () => {
    expect(MAX_PLAUSIBLE_MEDIA_BYTES).toBeGreaterThanOrEqual(MAX_CHUNKED_MEDIA_BYTES)
  })

  it('the PDF page budget is NOT dragged up with the video frame budget', () => {
    // These were deliberately separated in 6.27.0. Raising MAX_DERIVATIVE_IMAGES to
    // give video more frames would have given every PDF 16 pages.
    expect(MAX_DERIVATIVE_IMAGES).toBe(8)
    expect(VIDEO_SUMMARY_FRAMES_MAX).toBeGreaterThan(MAX_DERIVATIVE_IMAGES)
  })
})
