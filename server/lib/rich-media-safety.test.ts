import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { VIDEO_SUMMARY_FRAMES_MIN, prepareRichMedia } from './rich-media-safety.js'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cos-rich-media-test-'))
  roots.push(root)
  return root
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
describe('prepareRichMedia', () => {
  it('accepts strict UTF-8 text formats and caps model text without changing the original bytes', async () => {
    const original = Buffer.from(`# Brief\r\n\r\n${'detail '.repeat(20_000)}`, 'utf8')
    const prepared = await prepareRichMedia(original, { label: 'brief.md', declaredMime: 'text/markdown' })
    expect(prepared.category).toBe('document')
    if (prepared.category !== 'document') return
    expect(prepared.mime).toBe('text/markdown')
    expect(prepared.original).toEqual(original)
    expect(prepared.extractedText).toContain('# Brief\n\n')
    expect(prepared.extractedText.length).toBeLessThanOrEqual(100_100)
    expect(prepared.textTruncated).toBe(true)
    expect(prepared.pageImages).toEqual([])
  })

  it('rejects unsupported, NUL-bearing, and invalid UTF-8 files with typed errors', async () => {
    await expect(prepareRichMedia(Buffer.from('zip'), { label: 'archive.zip' }))
      .rejects.toMatchObject({ code: 'unsupported_attachment_format' })
    await expect(prepareRichMedia(Buffer.from([0x61, 0x00, 0x62]), { label: 'note.txt' }))
      .rejects.toMatchObject({ code: 'corrupt_attachment' })
    await expect(prepareRichMedia(Buffer.from([0xc3, 0x28]), { label: 'note.txt' }))
      .rejects.toMatchObject({ code: 'corrupt_attachment' })
  })

  it('extracts PDF text and bounded page stills when Poppler is available', async () => {
    const root = tempRoot()
    const textPath = join(root, 'source.txt')
    writeFileSync(textPath, 'Queen PDF test\nSecond line\n')
    let pdf: Buffer
    try {
      pdf = execFileSync('/usr/sbin/cupsfilter', ['-m', 'application/pdf', textPath], {
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 4 * 1024 * 1024,
      })
      execFileSync('pdftotext', ['-v'], { stdio: 'ignore' })
      execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' })
    } catch {
      return
    }
    const prepared = await prepareRichMedia(pdf, { label: 'queen.pdf', declaredMime: 'application/pdf' })
    expect(prepared.category).toBe('document')
    if (prepared.category !== 'document') return
    expect(prepared.mime).toBe('application/pdf')
    expect(prepared.extractedText).toContain('Queen PDF test')
    expect(prepared.pageImages.length).toBeGreaterThanOrEqual(1)
    expect(prepared.pageImages.length).toBeLessThanOrEqual(8)
    expect(prepared.pageImages[0].subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })

  it('turns MP4/MOV into bounded still frames and rejects malformed ISO-BMFF bytes', async () => {
    const root = tempRoot()
    const videoPath = join(root, 'clip.mp4')
    try {
      execFileSync('ffmpeg', [
        '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=5',
        '-t', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath,
      ])
    } catch {
      return
    }
    const prepared = await prepareRichMedia(readFileSync(videoPath), { label: 'clip.mp4', declaredMime: 'video/mp4' })
    expect(prepared.category).toBe('video')
    if (prepared.category !== 'video') return
    expect(prepared.mime).toBe('video/mp4')
    expect(prepared.durationMs).toBeGreaterThan(1_500)
    // This asserted toHaveLength(1) until 6.27.0, pinning the old one-still-per-15s
    // rule. A 2s clip getting a single frame is the defect, not the contract, so the
    // count is now the floor and every frame must be a real JPEG.
    expect(prepared.frames.length).toBe(VIDEO_SUMMARY_FRAMES_MIN)
    for (const [i, frame] of prepared.frames.entries()) {
      expect(frame.subarray(0, 2), `frame ${i} SOI`).toEqual(Buffer.from([0xff, 0xd8]))
      expect(frame.length, `frame ${i} not empty`).toBeGreaterThan(1_000)
    }
    // Distinct moments, not one frame repeated: a duplicated pick would defeat the
    // entire point of sampling across the clip.
    expect(new Set(prepared.frames.map(f => f.length)).size).toBeGreaterThan(1)

    const fake = Buffer.alloc(32)
    fake.write('ftyp', 4, 'ascii')
    await expect(prepareRichMedia(fake, { label: 'fake.mp4' }))
      .rejects.toMatchObject({ code: 'corrupt_attachment' })
  })
})
