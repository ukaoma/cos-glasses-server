import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import {
  GALLERY_MAX_BYTES, GALLERY_TIMEOUT_MS, galleryPets, galleryThumb, isOpenPetsUrl, parsePetChoice, petChoiceKey, resolvePet, shippedPets,
  type PetFetcher,
} from './web-pet-choice.js'

// A real 2-frame PNG strip, so readPetSources accepts the folder as an animated pet.
function strip(frames: number, fw: number, h: number): Buffer {
  const crcT = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0 }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const w = frames * fw, ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.alloc(1 + w * 3, 0x80)))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(12)])
function animatedPet(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'idle.png'), strip(2, 10, 8))
  fs.writeFileSync(path.join(dir, 'session-pet-states.json'), JSON.stringify({ poses: { idle: { file: 'idle.png', frames: 2 } } }))
}

let root: string, support: string, resources: string
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet choice '))
  support = path.join(root, 'Application Support', 'COS Control')
  resources = path.join(root, 'COS Control.app', 'Contents', 'Resources')
  fs.mkdirSync(support, { recursive: true })
  animatedPet(path.join(resources, 'BundledCharacters', 'jedi-nia-solari'))
  fs.mkdirSync(path.join(resources, 'BundledCharacters', 'empty-folder'), { recursive: true })
  fs.mkdirSync(path.join(resources, 'StarterPet'), { recursive: true })
  fs.writeFileSync(path.join(resources, 'StarterPet', 'cloud-puff.webp'), WEBP)
  fs.writeFileSync(path.join(support, 'openpets-catalog.json'), JSON.stringify({ catalog: { pets: [
    { id: 'halloween-bat', displayName: 'Bat', description: 'A little companion.', category: 'western', subcategory: 'halloween', preview: 'https://openpets.dev/pets/content/abc/thumb.webp' },
    { id: 'evil', displayName: 'Evil', preview: 'https://evil.example/thumb.webp' },
    { id: 'plain-http', displayName: 'Plain', preview: 'http://openpets.dev/x.webp' },
    { id: '../escape', displayName: 'Escape', preview: 'https://openpets.dev/x.webp' },
    { id: 'halloween-bat', displayName: 'Duplicate', preview: 'https://openpets.dev/y.webp' },
  ] } }))
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('parsePetChoice', () => {
  it('accepts mac, shipped and gallery ids and refuses anything else', () => {
    expect(parsePetChoice(undefined)).toEqual({ kind: 'mac' })
    expect(parsePetChoice('mac')).toEqual({ kind: 'mac' })
    expect(parsePetChoice('shipped:jedi-nia-solari')).toEqual({ kind: 'shipped', id: 'jedi-nia-solari' })
    expect(parsePetChoice('gallery:halloween-bat')).toEqual({ kind: 'gallery', id: 'halloween-bat' })
    for (const bad of ['shipped:../etc', 'gallery:', 'other:x', 'shipped:A', 'gallery:x/y', 42]) expect(parsePetChoice(bad), String(bad)).toBeNull()
    expect(petChoiceKey({ kind: 'gallery', id: 'halloween-bat' })).toBe('gallery:halloween-bat')
  })
})

describe('catalog', () => {
  it('lists shipped characters with real art, and Cloud Puff as a still', () => {
    expect(shippedPets(resources).map((p) => [p.id, p.name, p.animated])).toEqual([['jedi-nia-solari', 'Jedi Nia Solari', true], ['cloud-puff', 'Cloud Puff', false]])
    expect(shippedPets(null)).toEqual([])
  })
  it('keeps only https openpets.dev gallery pets with safe, unique ids', () => {
    expect(galleryPets(support).map((p) => p.id)).toEqual(['halloween-bat'])
    expect(galleryPets(support)[0]).toMatchObject({ name: 'Bat', category: 'western halloween' })
    // The Mac helper's rule (isAllowedThumbURL), including its own test cases.
    expect(isOpenPetsUrl('https://openpets.dev/pets/tmuxai-openpets/thumb.webp')).toBe(true)
    expect(isOpenPetsUrl('http://openpets.dev/pets/tmuxai-openpets/thumb.webp')).toBe(false)
    expect(isOpenPetsUrl('https://openpets.dev.evil.com/pets/x/thumb.webp')).toBe(false)
    expect(isOpenPetsUrl('https://openpets.dev@evil.com/pets/x/thumb.webp')).toBe(false)
    expect(isOpenPetsUrl('https://zip.openpets.dev/pets/x/thumb.webp')).toBe(false)
    expect(isOpenPetsUrl('https://openpets.dev/pets/x/archive.zip')).toBe(false)
    expect(GALLERY_MAX_BYTES).toBe(512 * 1024)
    expect(GALLERY_TIMEOUT_MS).toBe(6000)
  })
})

describe('resolvePet', () => {
  it('maps each choice to where its art lives, or null when this Mac does not have it', () => {
    expect(resolvePet({ kind: 'mac' }, { supportDir: support, resources })).toBeNull() // no pet on the Mac yet
    fs.writeFileSync(path.join(support, 'session-pet-sprite.webp'), WEBP)
    expect(resolvePet({ kind: 'mac' }, { supportDir: support, resources })).toMatchObject({ kind: 'still', type: 'image/webp' })
    animatedPet(support) // a state map wins over the plain sprite, as in COS Control
    expect(resolvePet({ kind: 'mac' }, { supportDir: support, resources })).toMatchObject({ kind: 'strips', dir: support })
    expect(resolvePet({ kind: 'shipped', id: 'jedi-nia-solari' }, { supportDir: support, resources })).toMatchObject({ kind: 'strips', cacheName: 'shipped-jedi-nia-solari' })
    expect(resolvePet({ kind: 'shipped', id: 'empty-folder' }, { supportDir: support, resources })).toBeNull()
    expect(resolvePet({ kind: 'shipped', id: 'cloud-puff' }, { supportDir: support, resources })).toMatchObject({ kind: 'still' })
    expect(resolvePet({ kind: 'shipped', id: 'jedi-nia-solari' }, { supportDir: support, resources: null })).toBeNull()
    expect(resolvePet({ kind: 'gallery', id: 'halloween-bat' }, { supportDir: support, resources })).toMatchObject({ kind: 'gallery', preview: 'https://openpets.dev/pets/content/abc/thumb.webp' })
    expect(resolvePet({ kind: 'gallery', id: 'evil' }, { supportDir: support, resources })).toBeNull()
  })
})

describe('galleryThumb', () => {
  const pet = { id: 'halloween-bat', preview: 'https://openpets.dev/pets/content/abc/thumb.webp' }
  const reply = (body: Buffer, init: { status?: number; length?: number } = {}) =>
    new Response(new Uint8Array(body), { status: init.status ?? 200, headers: init.length != null ? { 'content-length': String(init.length) } : {} })

  it('downloads once, keeps it, and serves the copy after', async () => {
    let calls = 0
    const fetcher: PetFetcher = async (url, init) => { calls++; expect(url).toBe(pet.preview); expect(init.redirect).toBe('error'); return reply(WEBP) }
    const dir = path.join(root, 'g1')
    const first = await galleryThumb(pet, dir, fetcher)
    expect(first.type).toBe('image/webp')
    expect(fs.readFileSync(first.file).equals(WEBP)).toBe(true)
    await galleryThumb(pet, dir, fetcher)
    expect(calls).toBe(1)
  })
  it('shares one download between requests that arrive together', async () => {
    let calls = 0
    const fetcher: PetFetcher = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return reply(WEBP) }
    const dir = path.join(root, 'g2')
    await Promise.all([galleryThumb(pet, dir, fetcher), galleryThumb(pet, dir, fetcher), galleryThumb(pet, dir, fetcher)])
    expect(calls).toBe(1)
  })
  it('refuses a page that is not an image, an oversized file, an HTTP error, and a non-gallery address', async () => {
    await expect(galleryThumb(pet, path.join(root, 'g3'), async () => reply(Buffer.from('<html>nope</html>')))).rejects.toThrow('gallery_not_image')
    await expect(galleryThumb(pet, path.join(root, 'g4'), async () => reply(Buffer.alloc(GALLERY_MAX_BYTES + 1, 1)))).rejects.toThrow('gallery_too_large')
    await expect(galleryThumb(pet, path.join(root, 'g5'), async () => reply(WEBP, { length: GALLERY_MAX_BYTES + 1 }))).rejects.toThrow('gallery_too_large')
    await expect(galleryThumb(pet, path.join(root, 'g6'), async () => reply(Buffer.alloc(0), { status: 404 }))).rejects.toThrow('gallery_http_404')
    await expect(galleryThumb({ id: 'x', preview: 'https://evil.example/a.webp' }, path.join(root, 'g7'), async () => reply(WEBP))).rejects.toThrow('gallery_pet_invalid')
    for (const d of ['g3', 'g4', 'g5', 'g6']) expect(fs.existsSync(path.join(root, d)) ? fs.readdirSync(path.join(root, d)) : []).toEqual([])
  })
  it('does not ask again for a picture that just failed', async () => {
    let calls = 0
    const p2 = { id: 'halloween-bat', preview: 'https://openpets.dev/pets/content/def/thumb.webp' }
    const dir = path.join(root, 'g8')
    await expect(galleryThumb(p2, dir, async () => { calls++; return reply(Buffer.alloc(0), { status: 503 }) })).rejects.toThrow('gallery_http_503')
    await expect(galleryThumb(p2, dir, async () => { calls++; return reply(WEBP) })).rejects.toThrow('gallery_recently_failed')
    expect(calls).toBe(1)
  })
  it('takes WebP only, as the Mac does, and refuses a PNG', async () => {
    await expect(galleryThumb(pet, path.join(root, 'g9'), async () => reply(strip(1, 2, 2)), null)).rejects.toThrow('gallery_not_image')
  })
  it('uses the thumbnail COS Control already fetched, without downloading', async () => {
    const mac = path.join(root, 'macsupport')
    fs.mkdirSync(path.join(mac, 'openpets-thumbs'), { recursive: true })
    fs.writeFileSync(path.join(mac, 'openpets-thumbs', 'halloween-bat.webp'), WEBP)
    let calls = 0
    const got = await galleryThumb(pet, path.join(root, 'g10'), async () => { calls++; return reply(WEBP) }, mac)
    expect(got.file).toBe(path.join(mac, 'openpets-thumbs', 'halloween-bat.webp'))
    expect(calls).toBe(0)
    // A file there that is not a WebP is ignored and the gallery is asked instead.
    fs.writeFileSync(path.join(mac, 'openpets-thumbs', 'halloween-bat.webp'), 'not an image')
    await galleryThumb(pet, path.join(root, 'g11'), async () => { calls++; return reply(WEBP) }, mac)
    expect(calls).toBe(1)
  })
  it('stops reading a download as soon as it passes the size limit', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(64 * 1024)); if (pulled > 50) c.close() } })
    await expect(galleryThumb(pet, path.join(root, 'g12'), async () => new Response(body), null)).rejects.toThrow('gallery_too_large')
    expect(pulled).toBeLessThan(12) // 512 KB is 8 chunks of 64 KB; it never pulls all 50
  })
})
