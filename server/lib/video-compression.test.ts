import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetRichMediaCapabilityCacheForTests } from './rich-media-safety.js'
import {
  VIDEO_COMPRESSION_CRF,
  VIDEO_COMPRESSION_LABEL,
  _setCompressionTimeoutOverridesForTests,
  compressVideoFile,
} from './video-compression.js'

const roots: string[] = []
let root = ''
let workDir = ''
let originalPath = ''

function tempRoot(): string {
  const created = mkdtempSync(join(tmpdir(), 'cos-video-compression-'))
  roots.push(created)
  return created
}

/** Real ffmpeg/ffprobe are optional on a build box; the real-fixture tests self-skip. */
function realToolingReady(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * A lossless x264 source, so an x265 CRF 30 re-encode is reliably far smaller. A
 * default-quality testsrc is already tiny and could encode LARGER, which is the very
 * case skipped_not_smaller exists for and would make this test ambiguous.
 */
function writeRealClip(path: string): boolean {
  try {
    execFileSync('ffmpeg', [
      '-nostdin', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-t', '2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p',
      path,
    ], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function probeReal(path: string): Record<string, unknown> {
  const raw = execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,codec_tag_string,width,height,r_frame_rate',
    '-of', 'json', path,
  ], { encoding: 'utf8' })
  return (JSON.parse(raw) as { streams?: Record<string, unknown>[] }).streams?.[0] ?? {}
}

interface ProbeJson {
  streams: Array<Record<string, unknown>>
  format: { duration: string }
}

function videoProbe(width: number, height: number, rate: string, durationSeconds = 2): ProbeJson {
  return {
    streams: [{ codec_type: 'video', width, height, r_frame_rate: rate, avg_frame_rate: rate }],
    format: { duration: String(durationSeconds) },
  }
}

interface FakeConfig {
  workDir: string
  inputProbe?: ProbeJson | 'reject'
  outputProbe?: ProbeJson | 'reject'
  outputBytes?: number
  encodeExit?: number
  encodeSleepMs?: number
  partialBytes?: number
  sentinelPath?: string
  decodeExit?: number
}

/**
 * Fake ffmpeg/ffprobe on PATH, same shape as the fake installed in
 * adaptive-playback-audio.test.ts. Real tooling cannot be made to inflate a file, drift
 * a frame rate, or hang on demand, so the guards are exercised through these.
 */
function installFakes(config: FakeConfig): void {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const configPath = join(bin, 'config.json')
  writeFileSync(configPath, JSON.stringify(config))

  const preamble = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs')",
    `const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, 'utf8'))`,
    'const args = process.argv.slice(2)',
    "if (args.includes('-version')) process.exit(0)",
  ].join('\n')

  writeFileSync(join(bin, 'ffmpeg'), [
    preamble,
    // Decode validation is the only ffmpeg call whose last argument is "-".
    "if (args[args.length - 1] === '-') {",
    '  if (cfg.decodeExit) {',
    "    process.stderr.write('x265 [info]: HEVC encoder version 4.1\\n')",
    "    process.stderr.write('decode error in ' + args[args.indexOf('-i') + 1] + '\\n')",
    '    process.exit(cfg.decodeExit)',
    '  }',
    '  process.exit(0)',
    '}',
    'const output = args[args.length - 1]',
    "const input = args[args.indexOf('-i') + 1]",
    "if (typeof cfg.encodeSleepMs === 'number') {",
    '  fs.writeFileSync(output, Buffer.alloc(cfg.partialBytes || 512))',
    '  setTimeout(() => {',
    "    if (cfg.sentinelPath) fs.writeFileSync(cfg.sentinelPath, 'finished')",
    '    process.exit(0)',
    '  }, cfg.encodeSleepMs)',
    '} else if (cfg.encodeExit) {',
    "  process.stderr.write('x265 [info]: HEVC encoder version 4.1\\n')",
    "  process.stderr.write('failed writing ' + output + ' from ' + input + '\\n')",
    '  process.exit(cfg.encodeExit)',
    '} else {',
    '  fs.writeFileSync(output, Buffer.alloc(cfg.outputBytes || 512))',
    '  process.exit(0)',
    '}',
  ].join('\n'))

  writeFileSync(join(bin, 'ffprobe'), [
    preamble,
    'const target = args[args.length - 1]',
    // Anything inside workDir is our own encode output; anything else is the input.
    'const entry = target.indexOf(cfg.workDir) === 0 ? cfg.outputProbe : cfg.inputProbe',
    "if (!entry || entry === 'reject') {",
    "  process.stderr.write(target + ': Invalid data found when processing input\\n')",
    '  process.exit(1)',
    '}',
    'process.stdout.write(JSON.stringify(entry))',
    'process.exit(0)',
  ].join('\n'))

  chmodSync(join(bin, 'ffmpeg'), 0o755)
  chmodSync(join(bin, 'ffprobe'), 0o755)
  // Prepend: the fakes must shadow real ffmpeg, but node itself still has to resolve
  // for the shebang, so the real PATH stays behind them.
  process.env.PATH = `${bin}:${originalPath}`
  _resetRichMediaCapabilityCacheForTests()
}

function writeInput(bytes: number, name = 'input.mp4'): string {
  const path = join(root, name)
  writeFileSync(path, Buffer.alloc(bytes, 7))
  return path
}

function workDirFiles(): string[] {
  return existsSync(workDir) ? readdirSync(workDir) : []
}

beforeEach(() => {
  root = tempRoot()
  workDir = join(root, 'work')
  originalPath = process.env.PATH ?? ''
  _resetRichMediaCapabilityCacheForTests()
})

afterEach(() => {
  process.env.PATH = originalPath
  _setCompressionTimeoutOverridesForTests(null)
  _resetRichMediaCapabilityCacheForTests()
})

afterAll(() => {
  for (const created of roots) rmSync(created, { recursive: true, force: true })
})

describe('compressVideoFile', () => {
  it('publishes the measured CRF and the label health advertises', () => {
    expect(VIDEO_COMPRESSION_CRF).toBe(30)
    expect(VIDEO_COMPRESSION_LABEL).toBe('x265-crf30')
  })

  it('compresses a real clip to hvc1 without changing geometry or touching the input', async () => {
    if (!realToolingReady()) return
    const inputPath = join(root, 'clip.mp4')
    if (!writeRealClip(inputPath)) return
    const before = readFileSync(inputPath)

    const result = await compressVideoFile(inputPath, workDir)

    expect(result.status).toBe('compressed')
    expect(result.outputPath?.startsWith(workDir + sep)).toBe(true)
    expect(result.originalBytes).toBe(before.length)
    expect(result.compressedBytes).toBeGreaterThan(0)
    expect(result.compressedBytes!).toBeLessThan(result.originalBytes)
    expect(result.width).toBe(320)
    expect(result.height).toBe(180)
    expect(result.reason).toBeUndefined()

    // Geometry and the hvc1 tag are contract requirements, so assert them on the real
    // artifact rather than trusting the status alone.
    const encoded = probeReal(result.outputPath!)
    expect(encoded.codec_name).toBe('hevc')
    expect(encoded.codec_tag_string).toBe('hvc1')
    expect(encoded.width).toBe(320)
    expect(encoded.height).toBe(180)
    expect(encoded.r_frame_rate).toBe('30/1')

    expect(readFileSync(inputPath)).toEqual(before)
    expect(readdirSync(root).sort()).toEqual(['clip.mp4', 'work'])
  })

  it('reports skipped_not_video for a real file with no video stream', async () => {
    if (!realToolingReady()) return
    const inputPath = join(root, 'tone.m4a')
    try {
      execFileSync('ffmpeg', [
        '-nostdin', '-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', inputPath,
      ], { stdio: 'ignore' })
    } catch {
      return
    }
    const before = readFileSync(inputPath)

    const result = await compressVideoFile(inputPath, workDir)

    expect(result.status).toBe('skipped_not_video')
    expect(result.originalBytes).toBe(before.length)
    expect(result.outputPath).toBeUndefined()
    expect(readFileSync(inputPath)).toEqual(before)
    expect(workDirFiles()).toEqual([])
  })

  it('skips when ffmpeg and ffprobe are unavailable', async () => {
    const inputPath = writeInput(4_096)
    const before = readFileSync(inputPath)
    // No fakes: a PATH with neither binary is what an operator without ffmpeg has.
    process.env.PATH = '/usr/bin:/bin'
    _resetRichMediaCapabilityCacheForTests()

    const result = await compressVideoFile(inputPath, workDir)

    expect(result.status).toBe('skipped_unavailable')
    // Pinned to the capability gate's own reason, not just the status: probeGeometry
    // maps its own ENOENT to skipped_unavailable too, so a status-only assertion left
    // the gate unverified (deleting it was an uncaught mutation until this line).
    expect(result.reason).toBe('ffmpeg or ffprobe unavailable')
    expect(result.originalBytes).toBe(before.length)
    expect(result.outputPath).toBeUndefined()
    expect(readFileSync(inputPath)).toEqual(before)
    // Nothing was attempted, so the work dir was never even created.
    expect(existsSync(workDir)).toBe(false)
  })

  it('keeps the original when the encode is not smaller', async () => {
    const inputPath = writeInput(4_096)
    const before = readFileSync(inputPath)
    installFakes({
      workDir,
      inputProbe: videoProbe(320, 180, '30/1'),
      outputProbe: videoProbe(320, 180, '30/1'),
      outputBytes: 8_192,
    })

    const result = await compressVideoFile(inputPath, workDir)

    expect(result.status).toBe('skipped_not_smaller')
    expect(result.originalBytes).toBe(4_096)
    expect(result.compressedBytes).toBe(8_192)
    expect(result.outputPath).toBeUndefined()
    expect(workDirFiles()).toEqual([])
    expect(readFileSync(inputPath)).toEqual(before)
  })

  it('treats an equal-size encode as not smaller', async () => {
    const inputPath = writeInput(4_096)
    installFakes({
      workDir,
      inputProbe: videoProbe(320, 180, '30/1'),
      outputProbe: videoProbe(320, 180, '30/1'),
      outputBytes: 4_096,
    })

    const result = await compressVideoFile(inputPath, workDir)

    expect(result.status).toBe('skipped_not_smaller')
    expect(result.compressedBytes).toBe(4_096)
    expect(workDirFiles()).toEqual([])
  })

  it('rejects an output whose dimensions drifted from the input', async () => {
    const inputPath = writeInput(8_192)
    const before = readFileSync(inputPath)
    installFakes({
      workDir,
      inputProbe: videoProbe(3_840, 2_160, '30/1'),
      outputProbe: videoProbe(1_920, 1_080, '30/1'),
      outputBytes: 1_024,
    })

    const result = await compressVideoFile(inputPath, workDir)

    expect(result.status).toBe('failed')
    expect(result.reason).toContain('1920x1080')
    expect(result.reason).toContain('3840x2160')
    expect(result.width).toBe(3_840)
    expect(result.height).toBe(2_160)
    expect(result.outputPath).toBeUndefined()
    expect(workDirFiles()).toEqual([])
    expect(readFileSync(inputPath)).toEqual(before)
  })

  it('rejects an output whose frame rate drifted from the input', async () => {
    const inputPath = writeInput(8_192)
    installFakes({
      workDir,
      inputProbe: videoProbe(320, 180, '30/1'),
      outputProbe: videoProbe(320, 180, '24/1'),
      outputBytes: 1_024,
    })

    const result = await compressVideoFile(inputPath, workDir)

    expect(result.status).toBe('failed')
    expect(result.reason).toContain('fps')
    expect(result.reason).toContain('24.000')
    expect(workDirFiles()).toEqual([])
  })

  it('accepts a rate expressed as a different rational for the same fps', async () => {
    const inputPath = writeInput(8_192)
    installFakes({
      workDir,
      // 60000/1000 and 60/1 are the same 60 fps; a string compare would fail this.
      inputProbe: videoProbe(320, 180, '60/1'),
      outputProbe: videoProbe(320, 180, '60000/1000'),
      outputBytes: 1_024,
    })

    const result = await compressVideoFile(inputPath, workDir)

    expect(result.status).toBe('compressed')
    expect(result.compressedBytes).toBe(1_024)
  })

  it('kills the encode on timeout, removes the partial file, and keeps the input', async () => {
    const inputPath = writeInput(8_192)
    const before = readFileSync(inputPath)
    const sentinelPath = join(root, 'encode-finished')
    installFakes({
      workDir,
      inputProbe: videoProbe(320, 180, '30/1'),
      outputProbe: videoProbe(320, 180, '30/1'),
      encodeSleepMs: 1_500,
      partialBytes: 2_048,
      sentinelPath,
    })
    // The real floor is a minute wide; override rather than wait for it.
    _setCompressionTimeoutOverridesForTests({ encodeMs: 200 })

    const startedAt = Date.now()
    const result = await compressVideoFile(inputPath, workDir)
    const elapsed = Date.now() - startedAt

    expect(result.status).toBe('failed')
    expect(result.reason).toContain('timed out')
    expect(result.outputPath).toBeUndefined()
    expect(elapsed).toBeLessThan(1_500)
    expect(workDirFiles()).toEqual([])
    expect(readFileSync(inputPath)).toEqual(before)

    // The child must be dead, not merely abandoned: its post-sleep sentinel never lands.
    await new Promise(resolve => setTimeout(resolve, 1_800))
    expect(existsSync(sentinelPath)).toBe(false)
    expect(workDirFiles()).toEqual([])
  })

  it('keeps the input and leaves no partial output for every other failure mode', async () => {
    const scenarios: Array<{ name: string; config: Omit<FakeConfig, 'workDir'> }> = [
      {
        name: 'input probe rejects the bytes',
        config: { inputProbe: 'reject' },
      },
      {
        name: 'encode exits non-zero',
        config: { inputProbe: videoProbe(320, 180, '30/1'), encodeExit: 1 },
      },
      {
        name: 'output probe rejects the encode',
        config: {
          inputProbe: videoProbe(320, 180, '30/1'),
          outputProbe: 'reject',
          outputBytes: 1_024,
        },
      },
      {
        name: 'output fails decode validation',
        config: {
          inputProbe: videoProbe(320, 180, '30/1'),
          outputProbe: videoProbe(320, 180, '30/1'),
          outputBytes: 1_024,
          decodeExit: 1,
        },
      },
    ]

    for (const scenario of scenarios) {
      const inputPath = writeInput(8_192, `input-${scenarios.indexOf(scenario)}.mp4`)
      const before = readFileSync(inputPath)
      installFakes({ workDir, ...scenario.config })

      const result = await compressVideoFile(inputPath, workDir)

      expect(result.status, scenario.name).toBe('failed')
      expect(result.originalBytes, scenario.name).toBe(8_192)
      expect(result.outputPath, scenario.name).toBeUndefined()
      expect(readFileSync(inputPath), scenario.name).toEqual(before)
      expect(workDirFiles(), scenario.name).toEqual([])

      // Reasons are logged, so they stay bounded and carry no path or filename.
      const reason = result.reason ?? ''
      expect(reason.length, scenario.name).toBeGreaterThan(0)
      expect(reason.length, scenario.name).toBeLessThanOrEqual(200)
      expect(reason, scenario.name).not.toContain('/')
      expect(reason, scenario.name).not.toContain(root)
      expect(reason, scenario.name).not.toContain('input-')
    }
  })

  it('fails without writing anything when the input is missing or empty', async () => {
    installFakes({
      workDir,
      inputProbe: videoProbe(320, 180, '30/1'),
      outputProbe: videoProbe(320, 180, '30/1'),
      outputBytes: 512,
    })

    const missing = await compressVideoFile(join(root, 'absent.mp4'), workDir)
    expect(missing.status).toBe('failed')
    expect(missing.originalBytes).toBe(0)
    expect(missing.reason).toBe('input is unreadable')

    const emptyPath = writeInput(0, 'empty.mp4')
    const empty = await compressVideoFile(emptyPath, workDir)
    expect(empty.status).toBe('failed')
    expect(empty.originalBytes).toBe(0)
    expect(existsSync(emptyPath)).toBe(true)
    expect(workDirFiles()).toEqual([])
  })
})
