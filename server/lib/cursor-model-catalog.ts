// Runtime Cursor Agent CLI model discovery.
//
// Stable app slots (cursor-grok / cursor-composer) map to concrete CLI model
// ids proven in Phase 0. `agent models` is text-only — parse + cache it.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { resolveProviderBinary } from './provider-binary.js'
import {
  CURSOR_COMPOSER_MODEL,
  CURSOR_GROK_MODEL,
  setRuntimeCursorModelLabels,
  type CursorModelPreference,
} from '../../shared/model-preference.js'

const DEFAULT_REFRESH_TTL_MS = 15 * 60_000
const DEFAULT_REFRESH_TIMEOUT_MS = 7_000

/**
 * Stable slot → CLI model id mapping.
 * Composer stays pinned (no versioned high-fast family). Grok high-fast is
 * chosen at catalog build: newest `cursor-grok-<ver>-high-fast` in `agent
 * models`. This grok id is only the fallback when the live list has none.
 * `xhigh-fast` is a different SKU and is never selected here.
 */
export const CURSOR_SLOT_MODEL_IDS = {
  'cursor-grok': 'cursor-grok-4.5-high-fast',
  'cursor-composer': 'composer-2.5-fast',
} as const satisfies Record<CursorModelPreference, string>

const SLOT_DISPLAY_FALLBACK = {
  'cursor-grok': 'Grok Fast',
  'cursor-composer': 'Composer 2.5 Fast',
} as const satisfies Record<CursorModelPreference, string>

const GROK_HIGH_FAST_RE = /^cursor-grok-(\d+(?:\.\d+)*)-high-fast$/i

export function parseCursorGrokHighFastVersion(id: string): number[] | null {
  const match = GROK_HIGH_FAST_RE.exec(id.trim())
  if (!match) return null
  return match[1].split('.').map(part => Number(part))
}

export function compareVersionTuples(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left !== right) return left - right
  }
  return 0
}

/** Newest `cursor-grok-*-high-fast`. Ignores low/medium/xhigh and non-fast. */
export function selectNewestCursorGrokHighFast(
  models: CursorCatalogModel[],
): CursorCatalogModel | undefined {
  let best: { model: CursorCatalogModel; version: number[] } | undefined
  for (const model of models) {
    const version = parseCursorGrokHighFastVersion(model.id)
    if (!version) continue
    if (!best || compareVersionTuples(version, best.version) > 0) {
      best = { model, version }
    }
  }
  return best?.model
}

export type CursorCatalogSource = 'cli' | 'disk-cache' | 'unavailable'

export interface CursorCatalogModel {
  id: string
  displayName: string
}

export interface CursorModelOption extends CursorCatalogModel {
  preference: CursorModelPreference
}

export interface CursorModelCatalog {
  source: CursorCatalogSource
  refreshedAt: string
  options: CursorModelOption[]
  agentBinary?: string
  refreshError?: string
}

function catalogCachePath(): string {
  return resolve(
    process.env.COS_CURSOR_MODEL_CACHE_FILE?.trim()
      || resolve(import.meta.dirname, '..', 'data', 'cursor-models-cache.json'),
  )
}

/** Resolve the Cursor `agent` binary via the shared provider table. */
export function resolveAgentBinary(): string | undefined {
  const resolved = resolveProviderBinary('cursor')
  return resolved.ok ? resolved.path : undefined
}

/** Parse `agent models` text lines shaped like `id - Display Name`. */
export function parseAgentModelsText(text: string): CursorCatalogModel[] {
  const models: CursorCatalogModel[] = []
  const seen = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('Available models') || line.startsWith('Tip:')) continue
    const match = /^([a-z0-9][a-z0-9._\[\]-]*)\s+-\s+(.+)$/i.exec(line)
    if (!match) continue
    const id = match[1]
    const displayName = match[2].trim()
    if (!id || !displayName || seen.has(id)) continue
    seen.add(id)
    models.push({ id, displayName })
  }
  return models
}

export function buildCursorModelCatalog(
  models: CursorCatalogModel[],
  source: CursorCatalogSource,
  refreshedAt = new Date().toISOString(),
  agentBinary?: string,
  refreshError?: string,
): CursorModelCatalog {
  const byId = new Map(models.map(model => [model.id, model]))
  const grok = selectNewestCursorGrokHighFast(models)
    ?? byId.get(CURSOR_SLOT_MODEL_IDS[CURSOR_GROK_MODEL])
  const composer = byId.get(CURSOR_SLOT_MODEL_IDS[CURSOR_COMPOSER_MODEL])
  const options: CursorModelOption[] = [
    {
      preference: CURSOR_GROK_MODEL,
      id: grok?.id ?? '',
      displayName: grok?.displayName ?? SLOT_DISPLAY_FALLBACK[CURSOR_GROK_MODEL],
    },
    {
      preference: CURSOR_COMPOSER_MODEL,
      id: composer?.id ?? '',
      displayName: composer?.displayName ?? SLOT_DISPLAY_FALLBACK[CURSOR_COMPOSER_MODEL],
    },
  ]

  setRuntimeCursorModelLabels(options.filter(option => option.id).map(option => ({
    preference: option.preference,
    displayName: option.displayName,
  })))

  return {
    source,
    refreshedAt,
    options,
    ...(agentBinary ? { agentBinary } : {}),
    ...(refreshError ? { refreshError } : {}),
  }
}

function unavailableCatalog(refreshError?: string, agentBinary?: string): CursorModelCatalog {
  return buildCursorModelCatalog([], 'unavailable', new Date().toISOString(), agentBinary, refreshError)
}

function readDiskCatalog(): CursorModelCatalog | null {
  const path = catalogCachePath()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      models?: CursorCatalogModel[]
      refreshedAt?: string
      agentBinary?: string
    }
    const models = Array.isArray(parsed.models) ? parsed.models.filter(m => typeof m?.id === 'string' && m.id) : []
    if (models.length === 0) return null
    return buildCursorModelCatalog(
      models,
      'disk-cache',
      typeof parsed.refreshedAt === 'string' ? parsed.refreshedAt : new Date().toISOString(),
      typeof parsed.agentBinary === 'string' ? parsed.agentBinary : undefined,
    )
  } catch {
    return null
  }
}

function writeDiskCatalog(models: CursorCatalogModel[], agentBinary?: string): void {
  try {
    const path = catalogCachePath()
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify({
      refreshedAt: new Date().toISOString(),
      agentBinary,
      models,
    }, null, 2))
    renameSync(tmp, path)
  } catch (err) {
    console.warn('[cursor-model-catalog] cache write skipped:', err)
  }
}

function refreshTimeoutMs(): number {
  const raw = Number(process.env.COS_CURSOR_MODEL_REFRESH_TIMEOUT_MS ?? DEFAULT_REFRESH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 1_000 ? Math.floor(raw) : DEFAULT_REFRESH_TIMEOUT_MS
}

function refreshTtlMs(): number {
  const raw = Number(process.env.COS_CURSOR_MODEL_REFRESH_TTL_MS ?? DEFAULT_REFRESH_TTL_MS)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_REFRESH_TTL_MS
}

async function fetchCliModels(agentBinary: string): Promise<CursorCatalogModel[]> {
  return new Promise((resolveModels, reject) => {
    const env = { ...process.env }
    delete env.CLAUDECODE
    const child = spawn(agentBinary, ['models'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    let settled = false
    let stdout = ''
    let stderr = ''

    const finish = (err?: Error, models?: CursorCatalogModel[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* ignore */ }
      if (err) reject(err)
      else resolveModels(models ?? [])
    }

    const timer = setTimeout(() => {
      finish(new Error('Cursor model discovery timed out'))
    }, refreshTimeoutMs())

    child.on('error', err => finish(err))
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1_000) })
    child.on('close', code => {
      if (settled) return
      const models = parseAgentModelsText(stdout)
      if (models.length === 0) {
        finish(new Error(`Cursor model discovery exited ${code}: ${stderr.slice(0, 160) || 'no models'}`))
        return
      }
      finish(undefined, models)
    })
  })
}

let catalogSnapshot = readDiskCatalog() ?? unavailableCatalog()
let refreshPromise: Promise<CursorModelCatalog> | null = null

export function getCursorModelCatalogSnapshot(): CursorModelCatalog {
  return catalogSnapshot
}

export function isCursorProviderReady(): boolean {
  const binary = catalogSnapshot.agentBinary || resolveAgentBinary()
  if (!binary) return false
  return catalogSnapshot.options.every(option => !!option.id)
}

export function resolveCursorModelOption(preference: CursorModelPreference): CursorModelOption | undefined {
  return catalogSnapshot.options.find(option => option.preference === preference)
}

/**
 * Reverse of CURSOR_SLOT_MODEL_IDS: a concrete CLI model id → its stable app
 * slot. Checks the live catalog too, so a slot whose concrete id moved (e.g.
 * a new Composer build) still resolves without a code change.
 */
export function resolveCursorPreferenceForModelId(modelId: string): CursorModelPreference | undefined {
  const normalized = modelId.trim().toLowerCase()
  if (!normalized) return undefined
  if (parseCursorGrokHighFastVersion(normalized)) return CURSOR_GROK_MODEL
  for (const [preference, id] of Object.entries(CURSOR_SLOT_MODEL_IDS) as [CursorModelPreference, string][]) {
    if (id.toLowerCase() === normalized) return preference
  }
  return catalogSnapshot.options.find(option => option.id && option.id.toLowerCase() === normalized)?.preference
}

export async function getCursorModelCatalog(forceRefresh = false): Promise<CursorModelCatalog> {
  const ageMs = Date.now() - Date.parse(catalogSnapshot.refreshedAt)
  if (!forceRefresh && catalogSnapshot.source === 'cli' && ageMs < refreshTtlMs() && isCursorProviderReady()) {
    return catalogSnapshot
  }
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    const agentBinary = resolveAgentBinary()
    if (!agentBinary) {
      const disk = readDiskCatalog()
      catalogSnapshot = disk
        ? { ...disk, refreshError: 'Cursor agent binary not found on PATH or ~/.local/bin/agent' }
        : unavailableCatalog('Cursor agent binary not found on PATH or ~/.local/bin/agent')
      return catalogSnapshot
    }

    try {
      const models = await fetchCliModels(agentBinary)
      catalogSnapshot = buildCursorModelCatalog(models, 'cli', new Date().toISOString(), agentBinary)
      writeDiskCatalog(models, agentBinary)
    } catch (err) {
      const refreshError = err instanceof Error ? err.message : 'Live Cursor model discovery unavailable.'
      if (catalogSnapshot.source === 'cli' && catalogSnapshot.options.some(option => option.id)) {
        catalogSnapshot = { ...catalogSnapshot, agentBinary, refreshError }
        return catalogSnapshot
      }
      const disk = readDiskCatalog()
      catalogSnapshot = disk
        ? { ...disk, agentBinary, refreshError }
        : unavailableCatalog(refreshError, agentBinary)
    }
    return catalogSnapshot
  })().finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}
