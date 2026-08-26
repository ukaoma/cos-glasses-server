// Local Ollama discovery. Hidden picker until GET /api/tags succeeds with a model.
// Host is loopback-only — COS_OLLAMA_HOST that is not 127.0.0.1 / localhost / ::1
// is refused (SSRF).

export const DEFAULT_OLLAMA_ORIGIN = 'http://127.0.0.1:11434'
const PROBE_TIMEOUT_MS = 2_000
const CACHE_TTL_MS = 30_000

export interface OllamaCatalog {
  ready: boolean
  origin: string
  model: string
  models: string[]
  refreshedAt: string
  error?: string
}

type FetchLike = typeof fetch
let catalogFetch: FetchLike = globalThis.fetch.bind(globalThis)

export function ollamaFetch(...args: Parameters<FetchLike>): ReturnType<FetchLike> {
  return catalogFetch(...args)
}

export function _setOllamaCatalogFetchForTests(fn: FetchLike | null): void {
  catalogFetch = fn ?? globalThis.fetch.bind(globalThis)
}

function unavailableCatalog(origin: string, error: string): OllamaCatalog {
  return {
    ready: false,
    origin,
    model: '',
    models: [],
    refreshedAt: new Date().toISOString(),
    error,
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

export function resolveOllamaOrigin(
  raw: string | undefined = process.env.COS_OLLAMA_HOST,
): { ok: true; origin: string } | { ok: false; error: string } {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { ok: true, origin: DEFAULT_OLLAMA_ORIGIN }
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: 'COS_OLLAMA_HOST must be http(s) on loopback' }
    }
    if (!isLoopbackHostname(url.hostname)) {
      return { ok: false, error: 'COS_OLLAMA_HOST must be loopback (127.0.0.1, localhost, ::1)' }
    }
    if (url.username || url.password) {
      return { ok: false, error: 'COS_OLLAMA_HOST must not include credentials' }
    }
    return { ok: true, origin: url.origin }
  } catch {
    return { ok: false, error: 'COS_OLLAMA_HOST is not a valid URL' }
  }
}

export function selectOllamaModel(names: string[], preferred?: string): string {
  const cleaned = names.map(name => name.trim()).filter(Boolean)
  if (cleaned.length === 0) return ''
  const pin = (preferred ?? process.env.COS_OLLAMA_MODEL ?? '').trim()
  if (!pin) return cleaned[0] ?? ''
  if (cleaned.includes(pin)) return pin
  const tagged = cleaned.find(name => name.startsWith(`${pin}:`))
  return tagged ?? ''
}

export function parseOllamaTagNames(body: unknown): string[] {
  if (!body || typeof body !== 'object') return []
  const models = (body as { models?: unknown }).models
  if (!Array.isArray(models)) return []
  const names: string[] = []
  for (const row of models) {
    if (!row || typeof row !== 'object') continue
    const record = row as { name?: unknown; model?: unknown }
    const name = typeof record.name === 'string' ? record.name
      : typeof record.model === 'string' ? record.model
        : ''
    if (name.trim()) names.push(name.trim())
  }
  return names
}

let catalogSnapshot: OllamaCatalog = unavailableCatalog(DEFAULT_OLLAMA_ORIGIN, 'unprobed')
let refreshPromise: Promise<OllamaCatalog> | null = null

export function getOllamaCatalogSnapshot(): OllamaCatalog {
  return catalogSnapshot
}

export function isOllamaProviderReady(): boolean {
  return catalogSnapshot.ready && catalogSnapshot.model.length > 0
}

export function _resetOllamaCatalogCache(): void {
  catalogSnapshot = unavailableCatalog(DEFAULT_OLLAMA_ORIGIN, 'unprobed')
  refreshPromise = null
}

async function probeOllamaCatalog(): Promise<OllamaCatalog> {
  const originResult = resolveOllamaOrigin()
  if (!originResult.ok) return unavailableCatalog(DEFAULT_OLLAMA_ORIGIN, originResult.error)
  const origin = originResult.origin
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await catalogFetch(`${origin}/api/tags`, { signal: controller.signal })
    if (!response.ok) {
      return unavailableCatalog(origin, `ollama /api/tags HTTP ${response.status}`)
    }
    const body = await response.json() as unknown
    const models = parseOllamaTagNames(body)
    const model = selectOllamaModel(models)
    if (!model) return unavailableCatalog(origin, 'no models pulled')
    return {
      ready: true,
      origin,
      model,
      models,
      refreshedAt: new Date().toISOString(),
    }
  } catch (error: any) {
    const message = error?.name === 'AbortError'
      ? 'ollama probe timed out'
      : (error?.message ? String(error.message).slice(0, 160) : 'ollama unreachable')
    return unavailableCatalog(origin, message)
  } finally {
    clearTimeout(timer)
  }
}

export async function getOllamaCatalog(forceRefresh = false): Promise<OllamaCatalog> {
  const ageMs = Date.now() - Date.parse(catalogSnapshot.refreshedAt)
  if (
    !forceRefresh
    && catalogSnapshot.ready
    && Number.isFinite(ageMs)
    && ageMs >= 0
    && ageMs < CACHE_TTL_MS
  ) {
    return catalogSnapshot
  }
  if (refreshPromise) return refreshPromise
  refreshPromise = probeOllamaCatalog().then(snapshot => {
    catalogSnapshot = snapshot
    return snapshot
  }).finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}
