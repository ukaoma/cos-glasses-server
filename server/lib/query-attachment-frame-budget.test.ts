import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  VIDEO_SUMMARY_FRAMES_MAX,
  VIDEO_SUMMARY_FRAMES_MIN,
  videoSummaryFrameCount,
} from './rich-media-safety.js'
import { MAX_ATTACHMENTS_PER_PROMPT } from '../../shared/media-attachment.js'

/**
 * The producer/consumer boundary that 6.27.0 broke.
 *
 * Raising stills to 8-16 was done entirely inside rich-media-safety.ts. The consumer
 * — query-attachments.ts — capped image inputs at 12 and threw a hard 400 rather than
 * trimming, and nothing in the suite asserted `too_many_attachment_frames`. So a
 * video of 75s or more ingested cleanly, wrote its frames, and failed only when the
 * user asked about it. The upload path had no idea.
 *
 * These tests pin the RELATIONSHIP between the two numbers rather than either value,
 * because the defect was never a wrong constant — it was two correct constants that
 * no test compared.
 */

const source = readFileSync(new URL('./query-attachments.ts', import.meta.url).pathname, 'utf8')
const stripped = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/** The consumer's ceiling, read from the module that enforces it. */
function declaredImageInputCeiling(): string {
  const m = stripped.match(/const MAX_MODEL_IMAGE_INPUTS = ([^\n]+)/)
  if (!m) throw new Error('MAX_MODEL_IMAGE_INPUTS not found in query-attachments.ts')
  return m[1].trim()
}

describe('one video always fits the model image budget', () => {
  it('the consumer ceiling is expressed in terms of the producer ceiling', () => {
    // A literal here is what let the two drift. Requiring the symbol means raising
    // VIDEO_SUMMARY_FRAMES_MAX cannot silently outrun the consumer again.
    expect(declaredImageInputCeiling()).toBe('VIDEO_SUMMARY_FRAMES_MAX')
  })

  it('no duration the extractor accepts can exceed the image budget', () => {
    // The real defect, expressed as the property that was violated. Walk every
    // duration from 1s to 30min and assert the frame count fits.
    const offenders: string[] = []
    for (let seconds = 1; seconds <= 30 * 60; seconds++) {
      const frames = videoSummaryFrameCount(seconds * 1000)
      if (frames > VIDEO_SUMMARY_FRAMES_MAX) offenders.push(`${seconds}s -> ${frames}`)
    }
    expect(offenders, `durations exceeding the budget: ${offenders.slice(0, 5).join(', ')}`).toEqual([])
  })

  it('names the exact durations that used to 400', () => {
    // Regression anchor. Under the old ceiling of 12 these all failed at ask time.
    expect(videoSummaryFrameCount(72_000)).toBe(12)   // was the last width that worked
    expect(videoSummaryFrameCount(75_000)).toBe(13)   // first failure: 13 > 12
    expect(videoSummaryFrameCount(96_000)).toBe(16)   // ceiling
    for (const seconds of [75, 90, 96, 120, 600, 1200]) {
      expect(videoSummaryFrameCount(seconds * 1000), `${seconds}s`).toBeLessThanOrEqual(VIDEO_SUMMARY_FRAMES_MAX)
    }
  })

  it('still refuses genuinely over-budget multi-attachment prompts', () => {
    // The 400 is not removed, and should not be: frames are a video's only visual
    // representation, so silently dropping them would answer from a partial video
    // without saying so. Two videos at the floor exactly fit; three cannot.
    expect(stripped).toContain('too_many_attachment_frames')
    expect(VIDEO_SUMMARY_FRAMES_MIN * 2).toBeLessThanOrEqual(VIDEO_SUMMARY_FRAMES_MAX)
    expect(VIDEO_SUMMARY_FRAMES_MIN * 3).toBeGreaterThan(VIDEO_SUMMARY_FRAMES_MAX)
    // Documents the consequence rather than asserting it is desirable: attaching 3+
    // videos is a 400. If that ever needs to become an even per-video clamp, this
    // test is where the decision gets revisited.
    expect(MAX_ATTACHMENTS_PER_PROMPT).toBe(5)
  })

  it('the video branch still has no clamp, which is why the ceiling must fit', () => {
    // If a future change DOES clamp per-video frames, this assertion should fail and
    // be deliberately updated — the ceiling requirement relaxes only if that happens.
    // Window the VIDEO branch only. A wider slice reaches the document branch, whose
    // resolved.text.slice(0, room) is a legitimate text budget and has nothing to do
    // with frame clamping — my first attempt at this assertion failed on exactly that.
    const start = stripped.indexOf("category === 'video'")
    const videoBranch = stripped.slice(start, stripped.indexOf('} else {', start))
    expect(videoBranch).toContain('for (const path of resolved.imagePaths)')
    expect(videoBranch, 'video frames are pushed unclamped').not.toMatch(/slice\(0,/)
  })
})
