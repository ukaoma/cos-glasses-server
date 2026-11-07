/**
 * Which pet COS Control Web shows (Miles 11/06 23:06: "build the change pet picker ... Just use the
 * existing 300 pack that we have on the COS control").
 *
 * A choice is one of:
 *   mac               the pet COS Control shows (its own session-pet-states.json, or its single sprite)
 *   shipped:<id>      a character COS Control ships in its app bundle (BundledCharacters/<id>, animated),
 *                     or shipped:cloud-puff, the StarterPet still
 *   gallery:<id>      one of the OpenPets gallery pets COS Control lists (openpets-catalog.json, about 300).
 *                     As on the Mac (installOpenPetsThumb), a gallery pick is the gallery picture as a still.
 *
 * The choice is kept per browser. Changing the Mac's own pet stays in COS Control on the Mac: the app does
 * not watch its pet folder, so writing it from here would leave the Mac showing the old pet.
 * Everything here reads COS Control's files and never writes them.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { controlSupportDir, readPetSources } from './web-pet.js'

export type PetChoice =
  | { kind: 'mac' }
  | { kind: 'shipped'; id: string }
  | { kind: 'gallery'; id: string }

const ID = /^[a-z0-9][a-z0-9-]{0,80}$/

export function parsePetChoice(raw: unknown): PetChoice | null {
  if (raw === undefined) return { kind: 'mac' }
  // A repeated ?pet= arrives as an array: refuse it rather than guess.
  if (typeof raw !== 'string') return null
  const s = raw
  if (s === '' || s === 'mac') return { kind: 'mac' }
  const m = s.match(/^(shipped|gallery):(.+)$/)
  if (!m || !ID.test(m[2])) return null
  return { kind: m[1] as 'shipped' | 'gallery', id: m[2] }
}

export function petChoiceKey(c: PetChoice): string {
  return c.kind === 'mac' ? 'mac' : `${c.kind}:${c.id}`
}

/** COS Control's app resources. Most installs live in /Applications; ~/Applications is checked too. */
export function controlResourcesDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.COS_CONTROL_RESOURCES_DIR) return env.COS_CONTROL_RESOURCES_DIR
  for (const base of ['/Applications', path.join(env.HOME || '', 'Applications')]) {
    const dir = path.join(base, 'COS Control.app', 'Contents', 'Resources')
    try { if (fs.statSync(dir).isDirectory()) return dir } catch { /* next */ }
  }
  return null
}

/** Names and blurbs as COS Control shows them (Models.swift bundledCharacters). */
const SHIPPED_NAMES: Record<string, { name: string; summary: string }> = {
  'jedi-miles-windu': { name: 'Jedi Miles Windu', summary: 'Ten animated states. Purple saber and escalating droid fights.' },
  'jedi-nia-solari': { name: 'Jedi Nia Solari', summary: 'Idle and four combat loops. Purple saber and Force counters.' },
  'jedi-elara-vale': { name: 'Jedi Elara Vale', summary: 'Idle and four combat loops. Green saber and agile redirects.' },
  'jedi-rowan-vale': { name: 'Jedi Rowan Vale', summary: 'Idle and four combat loops. Blue saber and grounded strikes.' },
  'cloud-puff': { name: 'Cloud Puff', summary: 'A simple, calm figure. The default for new installs.' },
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

export interface ShippedPet { id: string; name: string; summary: string; animated: boolean }

/** Characters the installed COS Control carries. Only folders with a valid state map count. */
export function shippedPets(resources: string | null = controlResourcesDir()): ShippedPet[] {
  if (!resources) return []
  const out: ShippedPet[] = []
  let names: string[] = []
  try { names = fs.readdirSync(path.join(resources, 'BundledCharacters')).filter((n) => ID.test(n)).sort() } catch { /* none */ }
  for (const id of names) {
    if (Object.keys(readPetSources(path.join(resources, 'BundledCharacters', id))).length === 0) continue
    const label = SHIPPED_NAMES[id] ?? { name: id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), summary: '' }
    out.push({ id, name: label.name, summary: label.summary, animated: true })
  }
  if (isFile(path.join(resources, 'StarterPet', 'cloud-puff.webp'))) out.push({ id: 'cloud-puff', ...SHIPPED_NAMES['cloud-puff'], animated: false })
  return out
}

export interface GalleryPet { id: string; name: string; description: string; category: string; preview: string }

/** The OpenPets gallery COS Control fetched (openpets-catalog.json). Only https previews on openpets.dev. */
export function galleryPets(dir: string = controlSupportDir()): GalleryPet[] {
  const file = path.join(dir, 'openpets-catalog.json')
  let raw: { catalog?: { pets?: unknown[] } }
  try {
    if (!isFile(file)) return []
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch { return [] }
  const pets = Array.isArray(raw?.catalog?.pets) ? raw.catalog!.pets! : []
  const out: GalleryPet[] = []
  const seen = new Set<string>()
  for (const p of pets as Array<Record<string, unknown>>) {
    const id = typeof p?.id === 'string' ? p.id : ''
    const preview = typeof p?.preview === 'string' ? p.preview : ''
    if (!ID.test(id) || seen.has(id) || !isOpenPetsUrl(preview)) continue
    seen.add(id)
    out.push({
      id,
      name: typeof p.displayName === 'string' && p.displayName ? p.displayName : id,
      description: typeof p.description === 'string' ? p.description : '',
      category: [p.category, p.subcategory].filter((x) => typeof x === 'string' && x).join(' '),
      preview,
    })
  }
  return out
}

export function isOpenPetsUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && (u.hostname === 'openpets.dev' || u.hostname.endsWith('.openpets.dev')) && !u.username && !u.password
  } catch { return false }
}

export type ResolvedPet =
  | { kind: 'strips'; dir: string; cacheName: string }
  | { kind: 'still'; file: string; type: string }
  | { kind: 'gallery'; id: string; preview: string }

const STILL_TYPES: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }

/** Where the chosen pet's art lives, or null when that pet is not available on this Mac. */
export function resolvePet(choice: PetChoice, opts: { supportDir?: string; resources?: string | null } = {}): ResolvedPet | null {
  const support = opts.supportDir ?? controlSupportDir()
  const resources = opts.resources === undefined ? controlResourcesDir() : opts.resources
  if (choice.kind === 'mac') {
    if (Object.keys(readPetSources(support)).length > 0) return { kind: 'strips', dir: support, cacheName: '' }
    // A gallery pick or a single custom image on the Mac: COS Control's plain sprite (PetSpriteStore.fileStem).
    for (const ext of Object.keys(STILL_TYPES)) {
      const file = path.join(support, `session-pet-sprite${ext}`)
      if (isFile(file)) return { kind: 'still', file, type: STILL_TYPES[ext] }
    }
    return null
  }
  if (choice.kind === 'shipped') {
    if (!resources) return null
    if (choice.id === 'cloud-puff') {
      const file = path.join(resources, 'StarterPet', 'cloud-puff.webp')
      return isFile(file) ? { kind: 'still', file, type: 'image/webp' } : null
    }
    const dir = path.join(resources, 'BundledCharacters', choice.id)
    return Object.keys(readPetSources(dir)).length > 0 ? { kind: 'strips', dir, cacheName: `shipped-${choice.id}` } : null
  }
  const pet = galleryPets(support).find((p) => p.id === choice.id)
  return pet ? { kind: 'gallery', id: pet.id, preview: pet.preview } : null
}

/** Image type from the first bytes, so a gallery download that is not an image is refused. */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (b.length >= 6 && b.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  return null
}

export const GALLERY_MAX_BYTES = 1024 * 1024
export const GALLERY_TIMEOUT_MS = 10_000

export type PetFetcher = (url: string, init: { signal: AbortSignal; redirect: 'error' }) => Promise<Response>
const galleryInflight = new Map<string, Promise<{ file: string; type: string }>>()
/** A picture that just failed is not asked for again for this long, so a broken gallery is not hammered. */
export const GALLERY_RETRY_MS = 10 * 60_000
const galleryFailedAt = new Map<string, number>()

/**
 * The gallery picture for one pet, downloaded once from openpets.dev (as COS Control does) and kept under
 * the data folder. Refuses anything that is not an image, over 1 MB, redirected, or slower than 10 s.
 */
export function galleryThumb(pet: { id: string; preview: string }, cacheDir: string, fetcher: PetFetcher = fetch as unknown as PetFetcher): Promise<{ file: string; type: string }> {
  if (!ID.test(pet.id) || !isOpenPetsUrl(pet.preview)) return Promise.reject(new Error('gallery_pet_invalid'))
  const tag = crypto.createHash('sha256').update(pet.preview).digest('hex').slice(0, 12)
  const base = path.join(cacheDir, `${pet.id}-${tag}`)
  for (const [ext, type] of [['.webp', 'image/webp'], ['.png', 'image/png'], ['.gif', 'image/gif'], ['.jpg', 'image/jpeg']] as const) {
    if (isFile(base + ext)) return Promise.resolve({ file: base + ext, type })
  }
  const failed = galleryFailedAt.get(base)
  if (failed && Date.now() - failed < GALLERY_RETRY_MS) return Promise.reject(new Error('gallery_recently_failed'))
  let job = galleryInflight.get(base)
  if (!job) {
    job = (async () => {
      const res = await fetcher(pet.preview, { signal: AbortSignal.timeout(GALLERY_TIMEOUT_MS), redirect: 'error' })
      if (!res.ok) throw new Error(`gallery_http_${res.status}`)
      const declared = Number(res.headers.get('content-length') || 0)
      if (declared > GALLERY_MAX_BYTES) throw new Error('gallery_too_large')
      const body = Buffer.from(await res.arrayBuffer())
      if (body.length > GALLERY_MAX_BYTES) throw new Error('gallery_too_large')
      const type = sniffImage(body)
      if (!type) throw new Error('gallery_not_image')
      const ext = type === 'image/webp' ? '.webp' : type === 'image/png' ? '.png' : type === 'image/gif' ? '.gif' : '.jpg'
      fs.mkdirSync(cacheDir, { recursive: true })
      const tmp = `${base}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(tmp, body)
      fs.renameSync(tmp, base + ext)
      return { file: base + ext, type }
    })().then((ok) => { galleryFailedAt.delete(base); return ok }, (err) => { galleryFailedAt.set(base, Date.now()); throw err })
      .finally(() => galleryInflight.delete(base))
    galleryInflight.set(base, job)
  }
  return job
}
