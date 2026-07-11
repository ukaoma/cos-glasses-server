import { execFileSync } from 'node:child_process'
import { describe, expect, it, beforeAll } from 'vitest'
import {
  ImageSafetyError,
  MAX_IMAGE_BYTES,
  MAX_OUTPUT_ARTIFACT_BYTES,
  NORMALIZED_MAX_EDGE,
  THUMB_MAX_EDGE,
  isMediaProcessingReady,
  normalizeImage,
  normalizeOutputArtifact,
  parseJpegDimensions,
  parsePngDimensions,
  sniffImageType,
  sniffOutputArtifactType,
  strictBase64Decode,
  validateSourceImage,
} from './image-safety.js'

// 1x1 red PNG — canonical valid fixture.
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let ffmpegAvailable = false
let jpegFixture: Buffer
let webpFixture: Buffer | null = null

function makeJpeg(width: number, height: number): Buffer {
  return execFileSync('ffmpeg', [
    '-nostdin', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=red:s=${width}x${height}`,
    '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2pipe', '-',
  ], { maxBuffer: 32 * 1024 * 1024 })
}

/** Hand-craft a PNG header claiming arbitrary dimensions — proves the
 *  megapixel gate fires from the HEADER, before any decode. */
function fakePngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(64)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

beforeAll(async () => {
  ffmpegAvailable = await isMediaProcessingReady()
  if (ffmpegAvailable) jpegFixture = makeJpeg(640, 480)
  if (ffmpegAvailable) {
    try {
      webpFixture = execFileSync('ffmpeg', [
        '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x480',
        '-frames:v', '1', '-c:v', 'libwebp', '-f', 'webp', '-',
      ], { maxBuffer: 8 * 1024 * 1024 })
    } catch { webpFixture = null }
  }
})

describe('strictBase64Decode', () => {
  it('decodes valid base64', () => {
    expect(strictBase64Decode(Buffer.from('hello').toString('base64')).toString()).toBe('hello')
  })

  it('rejects malformed, empty, and non-string input', () => {
    for (const bad of ['', 'a', 'ab=c', '!!!!', 'aGk=x', 42 as unknown as string, null as unknown as string]) {
      expect(() => strictBase64Decode(bad), JSON.stringify(bad)).toThrow(ImageSafetyError)
    }
  })
})

describe('magic-byte sniffing', () => {
  it('detects PNG and JPEG; rejects everything else', () => {
    expect(sniffImageType(Buffer.from(PNG_1x1_B64, 'base64'))).toBe('image/png')
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg')
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBeNull()
    expect(sniffImageType(Buffer.from('%PDF-1.4'))).toBeNull()
    // HEIC ftyp box
    expect(sniffImageType(Buffer.from('\x00\x00\x00\x18ftypheic'))).toBeNull()
  })

  it('allowlists realistic local output artifact containers by magic', () => {
    expect(sniffOutputArtifactType(Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'binary'))).toBe('image/webp')
    expect(sniffOutputArtifactType(Buffer.from('\x00\x00\x00\x18ftypavif', 'binary'))).toBe('image/avif')
    expect(sniffOutputArtifactType(Buffer.from('\x00\x00\x00\x18ftypheic', 'binary'))).toBe('image/heic')
    const compatibleHeic = Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x00\x00heic', 'binary')
    expect(sniffOutputArtifactType(compatibleHeic)).toBe('image/heic')
    expect(sniffOutputArtifactType(Buffer.from('GIF89a......'))).toBeNull()
  })
})

describe('header dimension parsing', () => {
  it('parses PNG IHDR dimensions', () => {
    expect(parsePngDimensions(Buffer.from(PNG_1x1_B64, 'base64'))).toEqual({ width: 1, height: 1 })
  })

  it('parses JPEG SOF dimensions (requires ffmpeg fixture)', () => {
    if (!ffmpegAvailable) return
    expect(parseJpegDimensions(jpegFixture)).toEqual({ width: 640, height: 480 })
  })

  it('returns null on truncated/garbage headers', () => {
    expect(parsePngDimensions(Buffer.alloc(4))).toBeNull()
    expect(parseJpegDimensions(Buffer.from([0xff, 0xd8, 0x00, 0x00]))).toBeNull()
  })
})

describe('validateSourceImage', () => {
  it('accepts a valid PNG', () => {
    const v = validateSourceImage(Buffer.from(PNG_1x1_B64, 'base64'))
    expect(v.mime).toBe('image/png')
    expect(v.width).toBe(1)
  })

  it('rejects oversized byte payloads', () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0xff)
    big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff
    expect(() => validateSourceImage(big)).toThrow(/bytes/)
  })

  it('rejects decompression bombs from the header alone (no decode)', () => {
    expect(() => validateSourceImage(fakePngHeader(100_000, 100_000)))
      .toThrowError(expect.objectContaining({ code: 'dimensions_too_large' }))
  })

  it('rejects unsupported formats with a typed error', () => {
    expect(() => validateSourceImage(Buffer.from('GIF89a-not-an-image-really')))
      .toThrowError(expect.objectContaining({ code: 'unsupported_format' }))
  })

  it('rejects images whose header has no readable dimensions', () => {
    const corrupt = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4)])
    expect(() => validateSourceImage(corrupt))
      .toThrowError(expect.objectContaining({ code: 'corrupt_image' }))
  })
})

describe('normalizeImage (ffmpeg)', () => {
  it('normalizes to metadata-free JPEG within the edge limits', async () => {
    if (!ffmpegAvailable) return
    const big = makeJpeg(2000, 1500)
    const out = await normalizeImage(validateSourceImage(big))
    expect(out.mime).toBe('image/jpeg')
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(NORMALIZED_MAX_EDGE)
    // deterministic re-encode: output itself passes the ingestion gate
    const revalidated = validateSourceImage(out.normalized)
    expect(revalidated.width).toBe(out.width)
    // thumb honors its own edge cap
    const thumbDims = parseJpegDimensions(out.thumb)
    expect(thumbDims).not.toBeNull()
    expect(Math.max(thumbDims!.width, thumbDims!.height)).toBeLessThanOrEqual(THUMB_MAX_EDGE)
    // EXIF stripped: no APP1/Exif marker in output
    expect(out.normalized.includes(Buffer.from('Exif'))).toBe(false)
  })

  it('does not upscale small images', async () => {
    if (!ffmpegAvailable) return
    const out = await normalizeImage(validateSourceImage(jpegFixture))
    expect(out.width).toBe(640)
    expect(out.height).toBe(480)
  })

  it('fails typed on undecodable input and publishes nothing', async () => {
    if (!ffmpegAvailable) return
    // Valid JPEG magic + valid-looking SOF header, garbage body.
    const evil = Buffer.concat([jpegFixture.subarray(0, 400), Buffer.alloc(600, 0x00)])
    const validated = { bytes: evil, mime: 'image/jpeg' as const, width: 640, height: 480 }
    await expect(normalizeImage(validated)).rejects.toThrowError(
      expect.objectContaining({ name: 'ImageSafetyError' }),
    )
  })
})

describe('normalizeOutputArtifact (trusted local agent artifact)', () => {
  it('normalizes a realistic >2 MiB PNG artifact back into the standard JPEG contract', async () => {
    if (!ffmpegAvailable) return
    const png = Buffer.from(PNG_1x1_B64, 'base64')
    // Ancillary bytes after IEND are ignored by image decoders but accurately
    // model a large local artifact at the byte-boundary under test.
    const large = Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES + 32, 0)])
    expect(large.length).toBeGreaterThan(MAX_IMAGE_BYTES)
    const out = await normalizeOutputArtifact(large)
    expect(out.mime).toBe('image/jpeg')
    expect(out.normalized.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES)
    expect(validateSourceImage(out.normalized).mime).toBe('image/jpeg')
  })

  it('normalizes WebP when the local ffmpeg build supports it', async () => {
    if (!ffmpegAvailable || !webpFixture) return
    expect(sniffOutputArtifactType(webpFixture)).toBe('image/webp')
    const out = await normalizeOutputArtifact(webpFixture)
    expect(out.mime).toBe('image/jpeg')
    expect(out.width).toBe(640)
    expect(out.height).toBe(480)
  })

  it('rejects output artifacts above the separate 16 MiB hard cap', async () => {
    const tooLarge = Buffer.alloc(MAX_OUTPUT_ARTIFACT_BYTES + 1)
    await expect(normalizeOutputArtifact(tooLarge)).rejects.toThrowError(
      expect.objectContaining({ code: 'image_too_large' }),
    )
  })
})
