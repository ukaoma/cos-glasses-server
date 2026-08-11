import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MediaStore } from './media-store.js'
import { isMediaProcessingReady } from './image-safety.js'
import { VIDEO_SUMMARY_FRAMES_MAX, videoSummaryFrameCount } from './rich-media-safety.js'

/**
 * The 16-frame video regression, tested across a RESTART.
 *
 * sanitizeRecord ran `derivativePaths.slice(0, 8)` on index load, so a 16-frame
 * video kept all 16 frames in memory and silently dropped to 8 the next time the
 * process started — and COS Control's Update Server restarts the server. Every
 * in-process assertion passed; the divergence only existed across a reload, which
 * is why nothing caught it.
 *
 * So the test constructs a SECOND MediaStore over the same root. That second
 * construction is the whole point: an assertion made before it cannot see this bug.
 */

const roots: string[] = []
let ffmpegAvailable = false
let longVideoPath = ''
let longVideoBytes = 0

function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-media-video-restart-'))
  roots.push(dir)
  return dir
}

beforeAll(async () => {
  ffmpegAvailable = await isMediaProcessingReady()
  if (!ffmpegAvailable) return
  // 96 seconds is the shortest duration that reaches the 16-frame ceiling:
  // videoSummaryFrameCount(96_000) === VIDEO_SUMMARY_FRAMES_MAX. Measured ~1s to
  // generate at 320x240 and under a second to extract, so the real path is
  // affordable to exercise rather than mocked.
  const dir = newRoot()
  longVideoPath = join(dir, 'ninety-six.mp4')
  execFileSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10',
    '-t', '96', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', longVideoPath,
  ])
  longVideoBytes = statSync(longVideoPath).size
})

/**
 * A fresh copy of the fixture per ingest.
 *
 * ingestRichMediaFromFile takes OWNERSHIP of sourcePath — it renames the file into
 * assets/ rather than copying it, which is the whole point of the streaming-staging
 * contract. Reusing one path across tests fails the second one with
 * 'staged attachment could not be read', which reads like a corrupt fixture and is
 * really a consumed one.
 */
function freshFixture(): { path: string; bytes: number } {
  const path = join(newRoot(), 'clip.mp4')
  copyFileSync(longVideoPath, path)
  return { path, bytes: statSync(path).size }
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe('a 16-frame video survives a server restart', () => {
  it('confirms the fixture actually reaches the ceiling', () => {
    if (!ffmpegAvailable) return
    // If this drifts, the rest of the file silently stops testing 16 frames.
    expect(videoSummaryFrameCount(96_000)).toBe(VIDEO_SUMMARY_FRAMES_MAX)
    expect(longVideoBytes).toBeGreaterThan(0)
  })

  it('keeps all 16 frames after the index is reloaded', async () => {
    if (!ffmpegAvailable) return
    const root = newRoot()
    const store = new MediaStore(root)
    const fixture = freshFixture()
    const ref = await store.ingestRichMediaFromFile({
      sourcePath: fixture.path,
      byteLength: fixture.bytes,
      declaredMime: 'video/mp4',
      label: 'ninety-six.mp4',
    })

    const before = store.resolveModelDerivatives(ref.id)
    expect(before.imagePaths.length, 'in-process frame count').toBe(VIDEO_SUMMARY_FRAMES_MAX)

    // The restart. Everything above passed while the bug was live.
    const reloaded = new MediaStore(root)
    const after = reloaded.resolveModelDerivatives(ref.id)
    expect(after.imagePaths.length, 'frame count AFTER restart').toBe(VIDEO_SUMMARY_FRAMES_MAX)
    expect(after.imagePaths).toEqual(before.imagePaths)
  })

  it('reports frameCount 16 on the ref, through the parser, after a restart', async () => {
    if (!ffmpegAvailable) return
    // Second half of the same defect: media-store writes frameCount: 16 and the
    // whitelist parser dropped anything over 8. sanitizeRecord re-parses on load,
    // so the count vanished at exactly the same moment the frames did.
    const root = newRoot()
    const store = new MediaStore(root)
    const fixture = freshFixture()
    const ref = await store.ingestRichMediaFromFile({
      sourcePath: fixture.path,
      byteLength: fixture.bytes,
      declaredMime: 'video/mp4',
    })
    expect(ref.frameCount, 'frameCount at publish').toBe(VIDEO_SUMMARY_FRAMES_MAX)

    const reloaded = new MediaStore(root)
    expect(reloaded.getRecord(ref.id)?.ref.frameCount, 'frameCount AFTER restart')
      .toBe(VIDEO_SUMMARY_FRAMES_MAX)
  })

  it('leaves no frame file on disk that the record cannot reach', async () => {
    if (!ffmpegAvailable) return
    // The truncation orphaned 8 files per video: on disk, unreferenced, never served
    // and never swept, because the sweeper only knows what the record points at.
    const root = newRoot()
    const store = new MediaStore(root)
    const fixture = freshFixture()
    const ref = await store.ingestRichMediaFromFile({
      sourcePath: fixture.path,
      byteLength: fixture.bytes,
      declaredMime: 'video/mp4',
    })
    const reloaded = new MediaStore(root)
    const reachable = new Set(reloaded.resolveModelDerivatives(ref.id).imagePaths)
    const record = reloaded.getRecord(ref.id)!
    const onDisk = execFileSync('find', [join(root, 'assets', ref.id), '-name', 'frame-*.jpg'])
      .toString().trim().split('\n').filter(Boolean)
    expect(onDisk.length, 'frame files written').toBe(VIDEO_SUMMARY_FRAMES_MAX)
    const orphans = onDisk.filter(p => !reachable.has(p))
    expect(orphans, `orphaned frame files: ${orphans.join(', ')}`).toEqual([])
    expect(record.derivativePaths?.length).toBe(VIDEO_SUMMARY_FRAMES_MAX)
  })
})
