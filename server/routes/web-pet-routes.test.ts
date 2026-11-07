// The pet routes on COS Control Web (6.99.22 to 6.99.25): manifest, sheets, still, preview and catalog,
// through the real router with a fake sips and a fake gallery download. Nothing here touches the Mac's pet.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import type { Server } from 'http'
import { createWebControlRouter } from './web-control.js'
import { isPublicApiRequest } from '../lib/api-auth.js'

function strip(frames: number, fw: number, h: number): Buffer {
  const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const ch = (ty: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const w = frames * fw, ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ch('IHDR', ih), ch('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => Buffer.alloc(1 + w * 3, 0x40))))), ch('IEND', Buffer.alloc(0))])
}
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(12)])

let root: string, support: string, resources: string, cache: string, server: Server, base: string
const sipsCalls: string[][] = []
let fetches = 0

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet routes '))
  support = path.join(root, 'Application Support', 'COS Control')
  resources = path.join(root, 'COS Control.app', 'Contents', 'Resources')
  cache = path.join(root, '.cos-glasses', 'data', 'web-pet') // a dot folder, as in production
  fs.mkdirSync(support, { recursive: true })
  fs.writeFileSync(path.join(support, 'idle.png'), strip(4, 10, 8))
  fs.writeFileSync(path.join(support, 'session-pet-states.json'), JSON.stringify({ poses: { idle: { file: 'idle.png', frames: 4, interval: 0.1 } } }))
  fs.writeFileSync(path.join(support, 'openpets-catalog.json'), JSON.stringify({ catalog: { pets: [{ id: 'halloween-bat', displayName: 'Bat', preview: 'https://openpets.dev/p/bat.webp' }] } }))
  const nia = path.join(resources, 'BundledCharacters', 'jedi-nia-solari')
  fs.mkdirSync(nia, { recursive: true })
  fs.writeFileSync(path.join(nia, 'idle.png'), strip(2, 10, 8))
  fs.writeFileSync(path.join(nia, 'session-pet-states.json'), JSON.stringify({ poses: { idle: { file: 'idle.png', frames: 2 } } }))
  fs.mkdirSync(path.join(resources, 'StarterPet'), { recursive: true })
  fs.writeFileSync(path.join(resources, 'StarterPet', 'cloud-puff.webp'), WEBP)
  const app = express()
  app.use('/api', createWebControlRouter({
    apiToken: () => 'test-token', port: () => 0,
    petSupportDir: () => support, petResourcesDir: () => resources, petCacheDir: () => cache,
    // A stand-in for sips: writes a small PNG to the --out path and records the call.
    petRun: async (_cmd, args) => { sipsCalls.push(args); fs.writeFileSync(args[args.length - 1], strip(1, 4, 4)) },
    petFetch: async () => { fetches++; return new Response(new Uint8Array(WEBP)) },
  }))
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
})
afterAll(() => { server?.close(); fs.rmSync(root, { recursive: true, force: true }) })

describe('pet routes', () => {
  it('are never public: every one sits behind the sign-in', () => {
    for (const p of ['/web-pet', '/web-pet/catalog', '/web-pet/still', '/web-pet/preview', '/web-pet/sheet/idle/0']) expect(isPublicApiRequest('GET', p), p).toBe(false)
  })

  it('the manifest follows ?pet=: the Mac pet and a shipped character are strips, Cloud Puff and the gallery are stills', async () => {
    const mac = await (await fetch(`${base}/web-pet`)).json()
    expect(mac).toMatchObject({ available: true, pet: 'mac', kind: 'strips' })
    expect(mac.poses.idle.chunks[0]).toMatch(/^\/api\/web-pet\/sheet\/idle\/0\?pet=mac&v=[0-9a-f]{16}$/)
    const nia = await (await fetch(`${base}/web-pet?pet=shipped:jedi-nia-solari`)).json()
    expect(nia).toMatchObject({ available: true, pet: 'shipped:jedi-nia-solari', kind: 'strips' })
    expect(nia.poses.idle.chunks[0]).toContain('pet=shipped%3Ajedi-nia-solari')
    const puff = await (await fetch(`${base}/web-pet?pet=shipped:cloud-puff`)).json()
    expect(puff).toMatchObject({ available: true, kind: 'still' })
    expect(puff.still).toMatch(/^\/api\/web-pet\/still\?pet=shipped%3Acloud-puff&v=/)
    const bat = await (await fetch(`${base}/web-pet?pet=gallery:halloween-bat`)).json()
    expect(bat).toMatchObject({ available: true, kind: 'still' })
    expect(await (await fetch(`${base}/web-pet?pet=gallery:not-in-catalog`)).json()).toMatchObject({ available: false })
  })

  it('refuses a malformed or repeated choice instead of guessing', async () => {
    expect((await fetch(`${base}/web-pet?pet=shipped:../../etc`)).status).toBe(400)
    expect((await fetch(`${base}/web-pet?pet=mac&pet=gallery:halloween-bat`)).status).toBe(400)
    expect((await fetch(`${base}/web-pet/sheet/idle/0?pet=shipped:..%2F..`)).status).toBe(404)
    expect((await fetch(`${base}/web-pet/sheet/nonsense/0`)).status).toBe(404)
    expect((await fetch(`${base}/web-pet/sheet/idle/9`)).status).toBe(404)
  })

  it('serves a sheet from the cache under a dot folder, immutable only for the current version', async () => {
    const mac = await (await fetch(`${base}/web-pet`)).json()
    const r = await fetch(`http://127.0.0.1:${new URL(base).port}${mac.poses.idle.chunks[0]}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('image/png')
    expect(r.headers.get('cache-control')).toContain('immutable')
    expect((await fetch(`${base}/web-pet/sheet/idle/0?pet=mac&v=0000000000000000`)).headers.get('cache-control')).toBe('private, no-cache')
  })

  it('still: a gallery picture is downloaded once, then served from the cache', async () => {
    fetches = 0
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${base}/web-pet/still?pet=gallery:halloween-bat&v=x`)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toContain('image/webp')
    }
    expect(fetches).toBe(1)
    expect((await fetch(`${base}/web-pet/still?pet=mac`)).status).toBe(404) // the Mac pet is a strip, not a still
  })

  it('preview: an animated pet gets one first frame from sips, a still is itself', async () => {
    sipsCalls.length = 0
    const r = await fetch(`${base}/web-pet/preview?pet=shipped:jedi-nia-solari&v=x`)
    expect(r.status).toBe(200)
    expect(sipsCalls.some((c) => c[0] === '-z')).toBe(true)
    expect(sipsCalls.filter((c) => c[0] === '-c').every((c) => c[5] !== '0')).toBe(true) // never offset 0 (sips reads it as centre)
    expect((await fetch(`${base}/web-pet/preview?pet=shipped:cloud-puff&v=x`)).headers.get('content-type')).toContain('image/webp')
  })

  it('catalog lists the Mac pet, shipped characters and the gallery, each with a preview link', async () => {
    const c = await (await fetch(`${base}/web-pet/catalog`)).json()
    expect(c.mac).toMatchObject({ available: true })
    expect(c.mac.preview).toMatch(/^\/api\/web-pet\/preview\?pet=mac&v=/)
    expect(c.shipped.map((p: { pet: string }) => p.pet)).toEqual(['shipped:jedi-nia-solari', 'shipped:cloud-puff'])
    expect(c.gallery.map((p: { pet: string }) => p.pet)).toEqual(['gallery:halloween-bat'])
  })
})
