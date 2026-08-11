import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  MAX_DERIVATIVE_IMAGES,
  VIDEO_SUMMARY_CANDIDATES_PER_FRAME,
  VIDEO_SUMMARY_FRAMES_MAX,
  VIDEO_SUMMARY_FRAMES_MIN,
  pickSharpestPerWindow,
  videoSummaryFrameCount,
} from './rich-media-safety.js'

// The rule this replaces was min(8, max(1, ceil(durationMs / 15_000))). Measured against
// the real assets in the media store, it produced:
//   11.7s 4K clip      ->  1 still
//   43.6s fridge sweep ->  3 stills   (Msg 796, verbatim: "I only got 3 samples")
//   20 min (the cap)   ->  8 stills, one per 2.5 MINUTES
const CLIP_4K_MS = 11_733
const FRIDGE_MS = 43_568

describe('how many stills represent a video', () => {
  it('never returns the 1 and 3 that made a summary impossible', () => {
    expect(videoSummaryFrameCount(CLIP_4K_MS)).toBe(8)
    expect(videoSummaryFrameCount(FRIDGE_MS)).toBe(8)
  })

  it('scales with duration between a floor and a ceiling', () => {
    // ~1 per 6s in the middle of the range, which is where the 12-frame target lands.
    expect(videoSummaryFrameCount(60_000)).toBe(10)
    expect(videoSummaryFrameCount(72_000)).toBe(12)
    expect(videoSummaryFrameCount(96_000)).toBe(VIDEO_SUMMARY_FRAMES_MAX)
  })

  it('holds the floor for anything short, so no clip gets a single still', () => {
    for (const ms of [1, 500, 1_000, 6_000, 30_000, 47_000]) {
      expect(videoSummaryFrameCount(ms), `${ms}ms`).toBe(VIDEO_SUMMARY_FRAMES_MIN)
    }
  })

  it('holds the ceiling for anything long, so a 20 minute video cannot explode the budget', () => {
    for (const ms of [300_000, 1_200_000, 60 * 60_000]) {
      expect(videoSummaryFrameCount(ms), `${ms}ms`).toBe(VIDEO_SUMMARY_FRAMES_MAX)
    }
  })

  it('treats nonsense duration as short rather than producing zero or NaN frames', () => {
    // A zero-frame video throws 'produced no review frames' downstream, so a bad probe
    // reading must degrade to the floor, not to nothing.
    for (const bad of [0, -1, -60_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      const n = videoSummaryFrameCount(bad as number)
      expect(Number.isInteger(n), String(bad)).toBe(true)
      expect(n, String(bad)).toBeGreaterThanOrEqual(VIDEO_SUMMARY_FRAMES_MIN)
      expect(n, String(bad)).toBeLessThanOrEqual(VIDEO_SUMMARY_FRAMES_MAX)
    }
  })

  it('leaves the PDF page budget alone', () => {
    // MAX_DERIVATIVE_IMAGES is shared with pdftoppm -l. Raising it to give video more
    // frames would silently have given every PDF 16 pages instead of 8.
    expect(MAX_DERIVATIVE_IMAGES).toBe(8)
    expect(VIDEO_SUMMARY_FRAMES_MAX).toBeGreaterThan(MAX_DERIVATIVE_IMAGES)
  })
})

describe('picking the sharpest candidate in each window', () => {
  const cands = (sizes: number[]) =>
    sizes.map((bytes, i) => ({ name: `cand-${String(i + 1).padStart(4, '0')}.jpg`, bytes }))

  it('keeps the largest candidate per window, because bigger means sharper', () => {
    // Measured on the real fridge sweep: within one second the spread was 1.45x
    // (27,311 vs 18,852 bytes), and inspecting both ends confirmed the large one reads
    // "Mootopia WHOLE / 13g / LACTOSE FREE" while the small one is unreadable smear.
    const picked = pickSharpestPerWindow(cands([10, 99, 12, 20, 21, 88]), 2)
    expect(picked).toEqual(['cand-0002.jpg', 'cand-0006.jpg'])
  })

  it('returns one frame per window, covering start to finish', () => {
    const picked = pickSharpestPerWindow(cands(Array.from({ length: 40 }, (_, i) => i)), 8)
    expect(picked).toHaveLength(8)
    expect(new Set(picked).size, 'no window may reuse another window\'s frame').toBe(8)
    // Uniform coverage: the first pick comes from the front, the last from the end.
    expect(picked[0]).toBe('cand-0005.jpg')
    expect(picked[7]).toBe('cand-0040.jpg')
  })

  it('lets the final window absorb the remainder rather than dropping candidates', () => {
    // 10 candidates over 3 windows is 3 each with 1 left over. Silently discarding the
    // tail would mean the end of the video is never represented.
    const picked = pickSharpestPerWindow(cands([1, 2, 3, 4, 5, 6, 7, 8, 9, 50]), 3)
    expect(picked).toHaveLength(3)
    expect(picked[2], 'the leftover candidate must still be reachable').toBe('cand-0010.jpg')
  })

  it('sorts by NAME, not by arrival order, so window order follows time', () => {
    // readdirSync order is not guaranteed. If the sort were dropped, windows would be
    // assembled from arbitrary points in the video and "uniform coverage" would be a lie.
    // Sizes chosen so sorted and unsorted give DIFFERENT answers — my first attempt used
    // sizes where both orders happened to agree, so it would have passed with the sort
    // deleted and tested nothing.
    //   sorted   0001(1) 0002(2) | 0003(9) 0004(8)  -> 0002, 0003
    //   unsorted 0003(9) 0001(1) | 0004(8) 0002(2)  -> 0003, 0004
    const shuffled = [
      { name: 'cand-0003.jpg', bytes: 9 },
      { name: 'cand-0001.jpg', bytes: 1 },
      { name: 'cand-0004.jpg', bytes: 8 },
      { name: 'cand-0002.jpg', bytes: 2 },
    ]
    expect(pickSharpestPerWindow(shuffled, 2)).toEqual(['cand-0002.jpg', 'cand-0003.jpg'])
  })

  it('degrades safely on empty or impossible input', () => {
    expect(pickSharpestPerWindow([], 8)).toEqual([])
    expect(pickSharpestPerWindow(cands([1, 2]), 0)).toEqual([])
    // Fewer candidates than windows: return what exists rather than padding or throwing.
    const thin = pickSharpestPerWindow(cands([1, 2]), 8)
    expect(thin.length).toBeGreaterThan(0)
    expect(thin.length).toBeLessThanOrEqual(2)
  })
})

describe('the extraction never upscales', () => {
  it('caps the scale filter at the source width', () => {
    // A bare scale=1280:-2 UPSCALED the 480x360 fridge sweep to 1280x960 — roughly 7x
    // the image tokens for detail that was never captured. Verified end to end: the
    // extraction now returns 480x360 for that source.
    const src = readFileSync(new URL('./rich-media-safety.ts', import.meta.url).pathname, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(src).toMatch(/scale='min\(1280,iw\)':-2/)
    expect(src, 'the unconditional 1280 upscale must be gone').not.toMatch(/scale=1280:-2/)
  })

  it('samples a constant number of candidates regardless of duration', () => {
    // fps is derived from frameCount * CANDIDATES_PER_FRAME over the duration, so a
    // 20-minute recording costs the same temp I/O as a 12-second one.
    const worst = VIDEO_SUMMARY_FRAMES_MAX * VIDEO_SUMMARY_CANDIDATES_PER_FRAME
    expect(worst).toBeLessThanOrEqual(100)
    for (const ms of [CLIP_4K_MS, FRIDGE_MS, 1_200_000]) {
      expect(videoSummaryFrameCount(ms) * VIDEO_SUMMARY_CANDIDATES_PER_FRAME).toBeLessThanOrEqual(worst)
    }
  })
})
