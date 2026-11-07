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

/** Names and summaries word for word from COS Control (Models.swift bundledCharacters). Cloud Puff has no
 *  summary there (defaultCharacterName only), so its line is ours. Keep in step when Control adds a character. */
const SHIPPED_NAMES: Record<string, { name: string; summary: string }> = {
  'jedi-miles-windu': { name: 'Jedi Miles Windu', summary: 'Ten animated states. Purple saber and escalating droid fights.' },
  'jedi-nia-solari': { name: 'Jedi Nia Solari', summary: 'Eight-frame idle and four combat loops. Purple saber, braided silhouette, and Force counters.' },
  'jedi-elara-vale': { name: 'Jedi Elara Vale', summary: 'Eight-frame idle and four combat loops. Green saber, auburn braid, and agile redirects.' },
  'jedi-rowan-vale': { name: 'Jedi Rowan Vale', summary: 'Eight-frame idle and four combat loops. Blue saber, two-handed guard, and grounded strikes.' },
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

/** The Mac helper's rule, exactly (HelperSources/main.swift isAllowedThumbURL): https, host openpets.dev, a path
 *  ending in /thumb.webp, no user or password. The catalog is untrusted; nothing else is ever fetched. */
export function isOpenPetsUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === 'openpets.dev' && u.port === '' && !u.username && !u.password && u.pathname.endsWith('/thumb.webp')
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

/** The Mac helper's limits (openPetsThumbMaxBytes, timeout 6): 512 KB, enforced while reading, and 6 seconds. */
export const GALLERY_MAX_BYTES = 512 * 1024
export const GALLERY_TIMEOUT_MS = 6_000
/** COS Control keeps the thumbnails it already fetched here (main.swift openPetsThumbsDir, <id>.webp). */
export const MAC_THUMBS_DIR = 'openpets-thumbs'

function isWebP(b: Buffer): boolean {
  return b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
}

/** Read at most max bytes from a response body, cancelling the stream past the limit. */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (!reader) return Buffer.from(await res.arrayBuffer())
  const parts: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) { await reader.cancel().catch(() => {}); throw new Error('gallery_too_large') }
    parts.push(Buffer.from(value))
  }
  return Buffer.concat(parts)
}

export type PetFetcher = (url: string, init: { signal: AbortSignal; redirect: 'error' }) => Promise<Response>
const galleryInflight = new Map<string, Promise<{ file: string; type: string }>>()
/** A picture that just failed is not asked for again for this long, so a broken gallery is not hammered. */
export const GALLERY_RETRY_MS = 10 * 60_000
const galleryFailedAt = new Map<string, number>()

/**
 * The gallery picture for one pet, downloaded once from openpets.dev (as COS Control does) and kept under
 * the data folder. Refuses anything the Mac helper would (not WebP, over 512 KB, redirected, slower than 6 s).
 */
export function galleryThumb(pet: { id: string; preview: string }, cacheDir: string, fetcher: PetFetcher = fetch as unknown as PetFetcher, macSupportDir: string | null = null): Promise<{ file: string; type: string }> {
  if (!ID.test(pet.id) || !isOpenPetsUrl(pet.preview)) return Promise.reject(new Error('gallery_pet_invalid'))
  // The thumbnail COS Control already fetched, when it is a real WebP: no second download (read only).
  if (macSupportDir) {
    const mac = path.join(macSupportDir, MAC_THUMBS_DIR, `${pet.id}.webp`)
    try {
      if (fs.statSync(mac).isFile() && fs.statSync(mac).size <= GALLERY_MAX_BYTES && isWebP(fs.readFileSync(mac))) return Promise.resolve({ file: mac, type: 'image/webp' })
    } catch { /* not there: fetch below */ }
  }
  const tag = crypto.createHash('sha256').update(pet.preview).digest('hex').slice(0, 12)
  const base = path.join(cacheDir, `${pet.id}-${tag}`)
  if (isFile(base + '.webp')) return Promise.resolve({ file: base + '.webp', type: 'image/webp' })
  const failed = galleryFailedAt.get(base)
  if (failed && Date.now() - failed < GALLERY_RETRY_MS) return Promise.reject(new Error('gallery_recently_failed'))
  let job = galleryInflight.get(base)
  if (!job) {
    job = (async () => {
      const res = await fetcher(pet.preview, { signal: AbortSignal.timeout(GALLERY_TIMEOUT_MS), redirect: 'error' })
      if (res.status !== 200) throw new Error(`gallery_http_${res.status}`)
      const declared = Number(res.headers.get('content-length') || 0)
      if (declared > GALLERY_MAX_BYTES) throw new Error('gallery_too_large')
      const body = await readCapped(res, GALLERY_MAX_BYTES)
      // WebP only, as the Mac (isOpenPetsWebP).
      if (!isWebP(body)) throw new Error('gallery_not_image')
      fs.mkdirSync(cacheDir, { recursive: true })
      const tmp = `${base}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(tmp, body)
      fs.renameSync(tmp, base + '.webp')
      return { file: base + '.webp', type: 'image/webp' }
    })().then((ok) => { galleryFailedAt.delete(base); return ok }, (err) => { galleryFailedAt.set(base, Date.now()); throw err })
      .finally(() => galleryInflight.delete(base))
    galleryInflight.set(base, job)
  }
  return job
}
