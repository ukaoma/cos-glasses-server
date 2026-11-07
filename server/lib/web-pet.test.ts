import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { WEB_PET_HEIGHT, petChunk, planPose, pngSize, readPetSources, webPetManifest, type PetPoseSource } from './web-pet.js'

// ── a tiny PNG writer: one solid colour per frame, frames side by side ──
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
function crc32(buf: Buffer): number { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const COLOURS: Array<[number, number, number]> = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255]]
function stripPng(frames: number, fw: number, h: number): Buffer {
  const w = frames * fw
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const rows: Buffer[] = []
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3)
    for (let x = 0; x < w; x++) { const [r, g, b] = COLOURS[Math.floor(x / fw) % COLOURS.length]; row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b }
    rows.push(row)
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}
/** RGB at (x, y) of a PNG, read through `sips` BMP output (bottom-up unless the height is negative). */
function pixel(png: string, x: number, y: number, tmp: string): [number, number, number] {
  const bmp = path.join(tmp, `px-${path.basename(png)}.bmp`)
  execFileSync('/usr/bin/sips', ['-s', 'format', 'bmp', png, '--out', bmp], { stdio: 'ignore' })
  const b = fs.readFileSync(bmp)
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), hRaw = b.readInt32LE(22), bpp = b.readUInt16LE(28) / 8
  const h = Math.abs(hRaw), stride = Math.ceil((w * bpp) / 4) * 4
  const row = hRaw > 0 ? h - 1 - y : y
  const i = off + row * stride + x * bpp
  return [b[i + 2], b[i + 1], b[i]]
}

let root: string
let dir: string
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'web pet '))
  // Real support folder is "~/Library/Application Support/COS Control": a space in the path on purpose.
  dir = path.join(root, 'Application Support', 'COS Control')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'strip-5.png'), stripPng(5, 10, 8))
  fs.writeFileSync(path.join(dir, 'odd.png'), stripPng(1, 7, 8))
  fs.writeFileSync(path.join(root, 'outside.png'), stripPng(2, 10, 8))
  fs.writeFileSync(path.join(dir, 'session-pet-states.json'), JSON.stringify({ poses: {
    working: { file: 'strip-5.png', frames: 5, interval: 0.02 },
    idle: { file: 'strip-5.png', frames: 5 },
    done: { file: 'odd.png', frames: 2 },              // 7 px wide does not split into 2 frames
    error: { file: '../../outside.png', frames: 2 },   // a real, valid strip, but outside the folder
    waiting: { file: '/etc/passwd', frames: 1 },       // absolute
    attention: { file: 'missing.png', frames: 3 },
    patrol: { file: 'strip-5.png', frames: 0 },
    notapose: { file: 'strip-5.png', frames: 5 },
  } }))
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('readPetSources', () => {
  it('keeps only valid poses inside the folder, with whole frames', () => {
    const src = readPetSources(dir)
    expect(Object.keys(src).sort()).toEqual(['idle', 'working'])
    expect(src.working).toMatchObject({ frames: 5, interval: 0.02, width: 50, height: 8 })
    expect(src.idle!.interval).toBe(0.12)
  })
  it('reads PNG size from the header and refuses non-PNGs', () => {
    expect(pngSize(path.join(dir, 'strip-5.png'))).toEqual({ width: 50, height: 8 })
    expect(pngSize(path.join(dir, 'session-pet-states.json'))).toBeNull()
  })
  it.runIf(process.platform !== 'win32')('never blocks on a named pipe in place of a strip or the map', () => {
    const fifoDir = path.join(root, 'fifo')
    fs.mkdirSync(fifoDir, { recursive: true })
    execFileSync('/usr/bin/mkfifo', [path.join(fifoDir, 'pipe.png'), path.join(fifoDir, 'session-pet-states.json')])
    const t = Date.now()
    expect(pngSize(path.join(fifoDir, 'pipe.png'))).toBeNull()
    expect(readPetSources(fifoDir)).toEqual({})
    expect(Date.now() - t).toBeLessThan(1000)
  })

  it('is empty without a state map', () => {
    expect(readPetSources(path.join(root, 'nowhere'))).toEqual({})
    expect(webPetManifest(path.join(root, 'nowhere'))).toEqual({ available: false, poses: {} })
  })
})

describe('planPose', () => {
  const src: PetPoseSource = { pose: 'working', file: '/x.png', frames: 184, interval: 0.02, width: 55936, height: 256, size: 1, mtimeMs: 1 }
  it('matches the real Windu working strip: 190 px frames, 43 per chunk, 5 chunks', () => {
    const p = planPose(src)
    expect(p).toMatchObject({ outHeight: WEB_PET_HEIGHT, frameWidth: 190, perChunk: 43, chunks: 5 })
    expect(p.perChunk * p.frameWidth).toBeLessThanOrEqual(8192)
  })
  it('changes key when the source file changes', () => {
    expect(planPose(src).key).not.toBe(planPose({ ...src, mtimeMs: 2 }).key)
    expect(planPose(src).key).toBe(planPose({ ...src }).key)
  })
})

describe('petChunk', () => {
  it('builds every chunk with the right sips calls, cutting the first chunk through a flip', async () => {
    const calls: string[][] = []
    const cache = path.join(root, 'cache-fake')
    const run = async (_cmd: string, args: string[]) => { calls.push(args); fs.writeFileSync(args[args.length - 1], 'png') }
    const plan = planPose(readPetSources(dir).working!, 16, 50) // 20 px frames, 2 per chunk, 3 chunks
    expect(plan).toMatchObject({ frameWidth: 20, perChunk: 2, chunks: 3 })
    const files = await Promise.all([0, 1, 2].map((i) => petChunk(plan, i, { cacheDir: cache, run })))
    expect(files.every((f) => fs.existsSync(f))).toBe(true)
    expect(calls[0].slice(0, 3)).toEqual(['-z', '16', '100'])
    expect(calls.filter((c) => c[0] === '-f')).toHaveLength(2) // flip the strip, flip the first chunk back
    const crops = calls.filter((c) => c[0] === '-c').map((c) => c.slice(1, 5))
    expect(crops).toEqual([['16', '40', '--cropOffset', '0'], ['16', '40', '--cropOffset', '0'], ['16', '20', '--cropOffset', '0']])
    const offsets = calls.filter((c) => c[0] === '-c').map((c) => Number(c[5]))
    expect(offsets).toEqual([60, 40, 80]) // first chunk from the mirrored far end; never a 0 offset
    // A second request is served from disk without running sips again.
    const before = calls.length
    await petChunk(plan, 1, { cacheDir: cache, run })
    expect(calls.length).toBe(before)
  })

  it('refuses a chunk index outside the plan', async () => {
    const plan = planPose(readPetSources(dir).working!)
    await expect(petChunk(plan, 9, { cacheDir: path.join(root, 'c2') })).rejects.toThrow('no_such_chunk')
  })

  it.runIf(process.platform === 'darwin' && fs.existsSync('/usr/bin/sips'))('real sips: every frame lands in the right chunk at the right place', async () => {
    const cache = path.join(root, 'cache-real')
    const plan = planPose(readPetSources(dir).working!, 16, 50)
    const files = await Promise.all([0, 1, 2].map((i) => petChunk(plan, i, { cacheDir: cache })))
    expect(files.map((f) => pngSize(f))).toEqual([{ width: 40, height: 16 }, { width: 40, height: 16 }, { width: 20, height: 16 }])
    for (let frame = 0; frame < 5; frame++) {
      const file = files[Math.floor(frame / 2)]
      const x = (frame % 2) * 20 + 10 // centre of the frame, clear of resize blending at the edges
      expect(pixel(file, x, 8, root), `frame ${frame}`).toEqual(COLOURS[frame])
    }
  })
})
