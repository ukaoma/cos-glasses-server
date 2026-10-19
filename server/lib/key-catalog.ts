// Key lanes K1 P5 (plan v4 10.4, D10): the model catalog for key profiles.
//
// Source: OpenRouter's PUBLIC `GET /api/v1/models` (no key, never a key header), cached in
// memory for 24 hours. Nothing is written to disk and nothing is fetched at import: the first
// fetch happens only when a caller asks (the catalog route, or a direct turn refreshing prices in
// the background). With key lanes off nobody asks, so this module does nothing.
//
// Curated list (D10): Claude Sonnet 5.5 via OpenRouter is the default, Claude Haiku 5.5 is the
// one cheaper option. Their built-in prices are the plan's; a live catalog row replaces them.
// "Downselect" turns the full catalog into at most 20 picker rows of at most 64 characters (the
// lens list budget), curated first, every row carrying the lanes it can run on (plan 4.4: Lane B
// takes only `anthropic/` and `openai/` slugs; everything else is direct only).
//
// Tests never touch the network: the URL and fetch are injectable and the suite points them at a
// loopback mock server.

export const KEY_CATALOG_URL = 'https://openrouter.ai/api/v1/models'
export const KEY_CATALOG_TTL_MS = 24 * 60 * 60 * 1000
export const KEY_CATALOG_TIMEOUT_MS = 8_000
/** A catalog body bigger than this is refused rather than parsed (today's is about 1 MB). */
export const KEY_CATALOG_MAX_BYTES = 16 * 1024 * 1024
/** Lens list budget (plan 10.4): 20 rows of 64 characters. */
export const KEY_CATALOG_MAX_ROWS = 20
export const KEY_CATALOG_ROW_CHARS = 64

export const DEFAULT_KEY_MODEL = 'anthropic/claude-sonnet-5.5'
export const CHEAPER_KEY_MODEL = 'anthropic/claude-haiku-5.5'

export interface KeyCatalogModel {
  id: string
  name: string
  inUsdPerM: number
  outUsdPerM: number
  contextLength?: number
  /** From `supported_parameters`; undefined when the catalog does not say. */
  supportsTools?: boolean
}

export type CuratedRole = 'default' | 'cheaper'
export interface CuratedKeyModel extends KeyCatalogModel {
  role: CuratedRole
}

/** D10. Prices are plan 10.4's and are replaced by the live catalog row when one is cached. */
export const KEY_CATALOG_CURATED: readonly CuratedKeyModel[] = [
  { id: DEFAULT_KEY_MODEL, name: 'Claude Sonnet 5.5', inUsdPerM: 2, outUsdPerM: 10, supportsTools: true, role: 'default' },
  { id: CHEAPER_KEY_MODEL, name: 'Claude Haiku 5.5', inUsdPerM: 0.1, outUsdPerM: 0.5, supportsTools: true, role: 'cheaper' },
]

export type KeyCatalogLane = 'key' | 'direct'

/** Plan 4.4: which lanes a slug can run on. */
export function catalogLanesFor(id: string): KeyCatalogLane[] {
  return id.startsWith('anthropic/') || id.startsWith('openai/') ? ['key', 'direct'] : ['direct']
}

function perMillion(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 1e6 * 1e6) / 1e6
}

/**
 * Parse an OpenRouter `/models` body. Rows without an id or a usable price are dropped, as are
 * rows that do not output text (image-only models cannot answer on the lens).
 */
export function parseKeyCatalog(body: unknown): KeyCatalogModel[] {
  const rows = body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
    ? (body as { data: unknown[] }).data
    : []
  const out: KeyCatalogModel[] = []
  const seen = new Set<string>()
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as {
      id?: unknown; name?: unknown; context_length?: unknown
      pricing?: { prompt?: unknown; completion?: unknown }
      architecture?: { output_modalities?: unknown }
      supported_parameters?: unknown
    }
    if (typeof m.id !== 'string' || !m.id.trim() || m.id.length > 200 || seen.has(m.id)) continue
    const inUsdPerM = perMillion(m.pricing?.prompt)
    const outUsdPerM = perMillion(m.pricing?.completion)
    if (inUsdPerM === null || outUsdPerM === null) continue
    const outputs = m.architecture?.output_modalities
    if (Array.isArray(outputs) && !outputs.includes('text')) continue
    seen.add(m.id)
    out.push({
      id: m.id,
      name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : m.id,
      inUsdPerM,
      outUsdPerM,
      ...(typeof m.context_length === 'number' && Number.isFinite(m.context_length) ? { contextLength: m.context_length } : {}),
      ...(Array.isArray(m.supported_parameters) ? { supportsTools: m.supported_parameters.includes('tools') } : {}),
    })
  }
  return out
}

export interface KeyCatalogOptions {
  url?: string
  fetchImpl?: typeof fetch
  now?: () => number
  ttlMs?: number
  timeoutMs?: number
}

export interface KeyCatalogSnapshot {
  models: KeyCatalogModel[]
  /** `openrouter` when a live catalog is cached, `built-in` when only the curated list is known. */
  from: 'openrouter' | 'built-in'
  fetchedAt?: number
}

/** A 24-hour in-memory cache of the public catalog. One fetch in flight at a time. */
export class KeyCatalog {
  private readonly url: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private cached: { at: number; models: KeyCatalogModel[] } | null = null
  private inflight: Promise<KeyCatalogModel[]> | null = null

  constructor(options: KeyCatalogOptions = {}) {
    this.url = options.url ?? KEY_CATALOG_URL
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? KEY_CATALOG_TTL_MS
    this.timeoutMs = options.timeoutMs ?? KEY_CATALOG_TIMEOUT_MS
  }

  /** The cached models while fresh, else null. Never fetches. */
  peek(): KeyCatalogModel[] | null {
    if (!this.cached || this.now() - this.cached.at >= this.ttlMs) return null
    return this.cached.models
  }

  /** Fresh cache, or one fetch. A failed fetch keeps any stale copy and reports built-in when none. */
  async get(): Promise<KeyCatalogSnapshot> {
    const fresh = this.peek()
    if (fresh) return { models: fresh, from: 'openrouter', fetchedAt: this.cached!.at }
    try {
      const models = await this.fetchOnce()
      return { models, from: 'openrouter', fetchedAt: this.cached!.at }
    } catch {
      if (this.cached) return { models: this.cached.models, from: 'openrouter', fetchedAt: this.cached.at }
      return { models: [], from: 'built-in' }
    }
  }

  /** Start a refresh when stale and do not wait for it. Errors are swallowed (prices fall back). */
  refreshInBackground(): void {
    if (this.peek() || this.inflight) return
    void this.fetchOnce().catch(() => undefined)
  }

  private fetchOnce(): Promise<KeyCatalogModel[]> {
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      try {
        // Public endpoint: no Authorization header, ever. Redirects are refused so the request
        // cannot be bounced somewhere else.
        const response = await this.fetchImpl(this.url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (!response.ok) throw new Error(`catalog HTTP ${response.status}`)
        const length = Number(response.headers.get('content-length') ?? '0')
        if (length > KEY_CATALOG_MAX_BYTES) throw new Error('catalog too large')
        const text = await response.text()
        if (text.length > KEY_CATALOG_MAX_BYTES) throw new Error('catalog too large')
        const models = parseKeyCatalog(JSON.parse(text))
        if (models.length === 0) throw new Error('catalog empty')
        this.cached = { at: this.now(), models }
        return models
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }
}

let shared: KeyCatalog | null = null

/** The process catalog, created on first use (never at import). */
export function getKeyCatalog(): KeyCatalog {
  if (!shared) shared = new KeyCatalog()
  return shared
}

/** Tests only. */
export function __setKeyCatalogForTests(catalog: KeyCatalog | null): void {
  shared = catalog
}

/** The curated two with live prices (and tool support) when the catalog has them. */
export function curatedKeyModels(models: readonly KeyCatalogModel[] | null): CuratedKeyModel[] {
  const live = new Map((models ?? []).map(m => [m.id, m]))
  return KEY_CATALOG_CURATED.map(c => {
    const m = live.get(c.id)
    return m
      ? { ...c, inUsdPerM: m.inUsdPerM, outUsdPerM: m.outUsdPerM, ...(m.supportsTools !== undefined ? { supportsTools: m.supportsTools } : {}), ...(m.contextLength ? { contextLength: m.contextLength } : {}) }
      : { ...c }
  })
}

export interface ModelPriceInfo {
  inUsdPerM: number
  outUsdPerM: number
  from: 'openrouter' | 'built-in' | 'unknown'
}

/** Price for one slug: live row, else curated, else unknown (the caller decides the fallback). */
export function keyModelPrice(id: string, models: readonly KeyCatalogModel[] | null): ModelPriceInfo {
  const live = models?.find(m => m.id === id)
  if (live) return { inUsdPerM: live.inUsdPerM, outUsdPerM: live.outUsdPerM, from: 'openrouter' }
  const curated = KEY_CATALOG_CURATED.find(m => m.id === id)
  if (curated) return { inUsdPerM: curated.inUsdPerM, outUsdPerM: curated.outUsdPerM, from: 'built-in' }
  return { inUsdPerM: 0, outUsdPerM: 0, from: 'unknown' }
}

/** True or false when the catalog (or the curated list) says; undefined when nobody knows. */
export function keyModelSupportsTools(id: string, models: readonly KeyCatalogModel[] | null): boolean | undefined {
  const live = models?.find(m => m.id === id)
  if (live && live.supportsTools !== undefined) return live.supportsTools
  return KEY_CATALOG_CURATED.find(m => m.id === id)?.supportsTools
}

export interface KeyCatalogRow {
  id: string
  /** One lens row: name and price per million, at most KEY_CATALOG_ROW_CHARS characters. */
  label: string
  inUsdPerM: number
  outUsdPerM: number
  lanes: KeyCatalogLane[]
  role?: CuratedRole
}

/** Glyphs the lens font lacks (brief rule 8), em and en dash, and control characters. */
const LENS_UNSAFE = /[\u0000-\u001f\u007f-\u009f–—←-⇿♦✓⚠↻↺⌛⋯░▓⬡`]/gu

function lensRow(text: string, max = KEY_CATALOG_ROW_CHARS): string {
  const clean = text.replace(LENS_UNSAFE, ' ').replace(/\s+/g, ' ').trim()
  const glyphs = [...clean]
  if (glyphs.length <= max) return clean
  return `${glyphs.slice(0, max - 1).join('').trimEnd()}…`
}

function money(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4).replace(/0+$/, '')}`
  return `$${n < 1 ? n.toFixed(2) : Number(n.toFixed(2)).toString()}`
}

/** `Claude Sonnet 5.5 | $2/$10 per M`, cut to one lens row. The price suffix is kept whole. */
export function catalogRowLabel(m: Pick<KeyCatalogModel, 'name' | 'inUsdPerM' | 'outUsdPerM'>): string {
  const price = ` | ${money(m.inUsdPerM)}/${money(m.outUsdPerM)} per M`
  const room = KEY_CATALOG_ROW_CHARS - [...price].length
  return lensRow(`${lensRow(m.name, Math.max(8, room))}${price}`)
}

export interface DownselectOptions {
  query?: string
  /** Only models that can run on this lane. */
  lane?: KeyCatalogLane
  /** Only models the catalog says can call tools. */
  toolsOnly?: boolean
  limit?: number
}

/**
 * The picker list: curated first (with live prices), then catalog matches for `query` in the
 * catalog's own order, de-duplicated, at most `limit` (20) rows of at most 64 characters.
 * Without a query only the curated rows come back (plan 10.4: "More models" is a search).
 */
export function downselectKeyCatalog(models: readonly KeyCatalogModel[] | null, options: DownselectOptions = {}): KeyCatalogRow[] {
  const limit = Math.max(0, Math.min(KEY_CATALOG_MAX_ROWS, Math.floor(options.limit ?? KEY_CATALOG_MAX_ROWS)))
  const q = (options.query ?? '').trim().toLowerCase().slice(0, 40)
  const keep = (m: KeyCatalogModel) =>
    (!options.lane || catalogLanesFor(m.id).includes(options.lane))
    && (!options.toolsOnly || m.supportsTools === true)
  const rows: KeyCatalogRow[] = []
  const seen = new Set<string>()
  const push = (m: KeyCatalogModel, role?: CuratedRole) => {
    if (rows.length >= limit || seen.has(m.id) || !keep(m)) return
    seen.add(m.id)
    rows.push({ id: m.id, label: catalogRowLabel(m), inUsdPerM: m.inUsdPerM, outUsdPerM: m.outUsdPerM, lanes: catalogLanesFor(m.id), ...(role ? { role } : {}) })
  }
  for (const c of curatedKeyModels(models)) push(c, c.role)
  if (q && models) {
    for (const m of models) {
      if (rows.length >= limit) break
      if (m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) push(m)
    }
  }
  return rows
}
