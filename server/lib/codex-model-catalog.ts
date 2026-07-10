// Runtime Codex model discovery.
//
// The client persists stable frontier/balanced slots. This module resolves
// those slots to concrete model ids through Codex's official `model/list`
// method. A last-known-good catalog is retained across transient failures;
// the CLI default is used only when no discovered catalog exists yet.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import {
  CODEX_BALANCED_MODEL,
  CODEX_FRONTIER_MODEL,
  CODEX_MODEL_ID,
  CODEX_SERVICE_TIER,
  resolveConfiguredCodexReasoningEffort,
  resolveCodexReasoningEffort,
  setRuntimeCodexModelLabels,
  type CodexModelPreference,
  type EffortPreference,
} from '../../shared/model-preference.js'

const DEFAULT_REFRESH_TTL_MS = 15 * 60_000
const DEFAULT_REFRESH_TIMEOUT_MS = 7_000
const MIN_PERIODIC_REFRESH_MS = 60_000

export type CodexCatalogSource = 'app-server' | 'disk-cache' | 'cli-default'

export interface CodexCatalogModel {
  id: string
  displayName: string
  description: string
  hidden: boolean
  supportedReasoningEfforts: string[]
  defaultReasoningEffort: string
  serviceTiers: string[]
  isDefault: boolean
}

export interface CodexModelOption extends CodexCatalogModel {
  preference: CodexModelPreference
}

export interface CodexModelCatalog {
  source: CodexCatalogSource
  refreshedAt: string
  autoUpdates: true
  selectionPolicy: 'newest-generation-top-two'
  options: CodexModelOption[]
  refreshError?: string
}

export type CodexCatalogFetcher = () => Promise<CodexCatalogModel[]>

function modelCachePath(): string {
  return resolve(
    process.env.CODEX_HOME?.trim() || resolve(homedir(), '.codex'),
    'models_cache.json',
  )
}

function formatDisplayName(value: string): string {
  return value.replace(/^(GPT-\d+(?:\.\d+)+)-/i, '$1 ').trim()
}

function versionParts(modelId: string): number[] | null {
  const match = /^gpt-(\d+(?:\.\d+)*)/i.exec(modelId)
  if (!match) return null
  return match[1].split('.').map(Number)
}

function compareVersionsDesc(a: number[], b: number[]): number {
  const width = Math.max(a.length, b.length)
  for (let i = 0; i < width; i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function sameVersion(a: number[], b: number[]): boolean {
  return compareVersionsDesc(a, b) === 0
}

function isCapabilityCandidate(model: CodexCatalogModel): boolean {
  const identity = `${model.id} ${model.displayName}`
  if (/(?:^|[-\s])(mini|nano|spark|review)(?:$|[-\s])/i.test(identity)) return false
  return !/(?:fast and affordable|cost-efficient|small,? fast|ultra-fast)/i.test(model.description)
}

/** Select two full-size models from the newest visible GPT generation. */
export function selectTopCodexModels(models: CodexCatalogModel[]): CodexCatalogModel[] {
  const visible = models.filter(model => !model.hidden && versionParts(model.id))
  if (visible.length === 0) return []

  const capable = visible.filter(isCapabilityCandidate)
  const pool = capable.length > 0 ? capable : visible
  const versions = pool
    .map(model => versionParts(model.id))
    .filter((parts): parts is number[] => !!parts)
    .sort(compareVersionsDesc)
  const newest = versions[0]
  if (!newest) return pool.slice(0, 2)

  const selected = pool.filter(model => {
    const parts = versionParts(model.id)
    return !!parts && sameVersion(parts, newest)
  }).slice(0, 2)

  if (selected.length < 2) {
    const older = pool
      .filter(model => !selected.includes(model))
      .map((model, index) => ({ model, version: versionParts(model.id) ?? [], index }))
      .sort((a, b) => compareVersionsDesc(a.version, b.version) || a.index - b.index)
    for (const entry of older) {
      selected.push(entry.model)
      if (selected.length === 2) break
    }
  }

  return selected
}

export function buildCodexModelCatalog(
  models: CodexCatalogModel[],
  source: CodexCatalogSource,
  refreshedAt = new Date().toISOString(),
): CodexModelCatalog {
  const selected = selectTopCodexModels(models)
  const slots: CodexModelPreference[] = [CODEX_FRONTIER_MODEL, CODEX_BALANCED_MODEL]
  const options = selected.map((model, index): CodexModelOption => ({
    ...model,
    displayName: formatDisplayName(model.displayName || model.id),
    preference: slots[index],
  }))

  setRuntimeCodexModelLabels(options)
  return {
    source,
    refreshedAt,
    autoUpdates: true,
    selectionPolicy: 'newest-generation-top-two',
    options,
  }
}

function cliDefaultCatalog(refreshError?: string): CodexModelCatalog {
  const common = {
    id: '',
    description: 'Uses the current Codex CLI default until model discovery is available.',
    hidden: false,
    supportedReasoningEfforts: ['high', 'xhigh'],
    defaultReasoningEffort: 'high',
    serviceTiers: [] as string[],
    isDefault: true,
  }
  const catalog: CodexModelCatalog = {
    source: 'cli-default',
    refreshedAt: new Date().toISOString(),
    autoUpdates: true,
    selectionPolicy: 'newest-generation-top-two',
    options: [
      { ...common, preference: CODEX_FRONTIER_MODEL, displayName: 'GPT Frontier (auto)' },
      { ...common, preference: CODEX_BALANCED_MODEL, displayName: 'GPT Balanced (auto)', isDefault: false },
    ],
    ...(refreshError ? { refreshError } : {}),
  }
  setRuntimeCodexModelLabels(catalog.options)
  return catalog
}

function normalizeAppServerModel(raw: any): CodexCatalogModel | null {
  const id = typeof raw?.model === 'string' ? raw.model : typeof raw?.id === 'string' ? raw.id : ''
  if (!id) return null
  const efforts = Array.isArray(raw?.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts
      .map((item: any) => typeof item === 'string' ? item : item?.reasoningEffort)
      .filter((value: unknown): value is string => typeof value === 'string' && !!value)
    : []
  const serviceTiers = Array.isArray(raw?.serviceTiers)
    ? raw.serviceTiers
      .map((item: any) => typeof item === 'string' ? item : item?.id)
      .filter((value: unknown): value is string => typeof value === 'string' && !!value)
    : []
  return {
    id,
    displayName: typeof raw?.displayName === 'string' ? raw.displayName : id,
    description: typeof raw?.description === 'string' ? raw.description : '',
    hidden: raw?.hidden === true,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: typeof raw?.defaultReasoningEffort === 'string' ? raw.defaultReasoningEffort : 'high',
    serviceTiers,
    isDefault: raw?.isDefault === true,
  }
}

function readDiskCatalog(): CodexModelCatalog | null {
  const path = modelCachePath()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const models = Array.isArray(parsed?.models)
      ? parsed.models.map((raw: any): CodexCatalogModel | null => {
        const id = typeof raw?.slug === 'string' ? raw.slug : ''
        if (!id) return null
        return {
          id,
          displayName: typeof raw?.display_name === 'string' ? raw.display_name : id,
          description: typeof raw?.description === 'string' ? raw.description : '',
          hidden: raw?.visibility === 'hide',
          supportedReasoningEfforts: Array.isArray(raw?.supported_reasoning_levels)
            ? raw.supported_reasoning_levels
              .map((item: any) => item?.effort)
              .filter((value: unknown): value is string => typeof value === 'string' && !!value)
            : [],
          defaultReasoningEffort: typeof raw?.default_reasoning_level === 'string'
            ? raw.default_reasoning_level
            : 'high',
          serviceTiers: Array.isArray(raw?.service_tiers)
            ? raw.service_tiers
              .map((item: any) => item?.id)
              .filter((value: unknown): value is string => typeof value === 'string' && !!value)
            : [],
          isDefault: raw?.is_default === true,
        }
      }).filter((model: CodexCatalogModel | null): model is CodexCatalogModel => !!model)
      : []
    if (models.length === 0) return null
    const refreshedAt = typeof parsed?.fetched_at === 'string' ? parsed.fetched_at : new Date().toISOString()
    return buildCodexModelCatalog(models, 'disk-cache', refreshedAt)
  } catch {
    return null
  }
}

function refreshTimeoutMs(): number {
  const raw = Number(process.env.COS_CODEX_MODEL_REFRESH_TIMEOUT_MS ?? DEFAULT_REFRESH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 1_000 ? Math.floor(raw) : DEFAULT_REFRESH_TIMEOUT_MS
}

function refreshTtlMs(): number {
  const raw = Number(process.env.COS_CODEX_MODEL_REFRESH_TTL_MS ?? DEFAULT_REFRESH_TTL_MS)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_REFRESH_TTL_MS
}

async function fetchAppServerModels(): Promise<CodexCatalogModel[]> {
  return new Promise((resolveModels, reject) => {
    const env = { ...process.env }
    delete env.CLAUDECODE
    const child = spawn('codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })
    let settled = false
    let stdoutBuffer = ''
    let stderr = ''

    const finish = (err?: Error, models?: CodexCatalogModel[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.stdin.end() } catch { /* ignore */ }
      try { child.kill() } catch { /* ignore */ }
      if (err) reject(err)
      else resolveModels(models ?? [])
    }

    const timer = setTimeout(() => finish(new Error('Codex model discovery timed out')), refreshTimeoutMs())

    child.on('error', err => finish(err))
    child.on('close', code => {
      if (!settled) finish(new Error(`Codex model discovery exited ${code}: ${stderr.slice(0, 160)}`))
    })
    child.stderr.on('data', chunk => {
      stderr = (stderr + String(chunk)).slice(-1_000)
    })
    child.stdout.on('data', chunk => {
      stdoutBuffer += String(chunk)
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n')
        if (newline < 0) break
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (!line) continue
        try {
          const message = JSON.parse(line)
          if (message?.id !== 2) continue
          if (message?.error) {
            finish(new Error('Codex model/list failed'))
            return
          }
          const models = Array.isArray(message?.result?.data)
            ? message.result.data
              .map(normalizeAppServerModel)
              .filter((model: CodexCatalogModel | null): model is CodexCatalogModel => !!model)
            : []
          if (models.length === 0) {
            finish(new Error('Codex model/list returned no models'))
            return
          }
          finish(undefined, models)
          return
        } catch {
          // Notifications and partial/non-JSON diagnostics are irrelevant.
        }
      }
    })

    child.stdin.write(JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'cos-glasses-server', version: '6.4.0' },
        capabilities: { experimentalApi: false },
      },
    }) + '\n')
    child.stdin.write(JSON.stringify({
      id: 2,
      method: 'model/list',
      params: { limit: 50, includeHidden: false },
    }) + '\n')
  })
}

let catalogSnapshot = readDiskCatalog() ?? cliDefaultCatalog()
let refreshPromise: Promise<CodexModelCatalog> | null = null
let periodicRefreshTimer: ReturnType<typeof setInterval> | null = null

export function getCodexModelCatalogSnapshot(): CodexModelCatalog {
  return catalogSnapshot
}

/** Refresh with an injectable fetcher for alternate runtimes and tests. */
export async function refreshCodexModelCatalog(
  fetcher: CodexCatalogFetcher = fetchAppServerModels,
): Promise<CodexModelCatalog> {
  try {
    const models = await fetcher()
    const refreshed = buildCodexModelCatalog(models, 'app-server')
    if (refreshed.options.length === 0) throw new Error('No eligible GPT models')
    catalogSnapshot = refreshed
  } catch {
    // Never downgrade a working app-server/disk catalog because one refresh
    // failed. A fresh disk read is useful only when there is no known model id.
    const hasKnownModel = catalogSnapshot.options.some(option => !!option.id)
    const fallback = hasKnownModel ? catalogSnapshot : readDiskCatalog()
    if (fallback) {
      catalogSnapshot = {
        ...fallback,
        refreshError: 'Live Codex model discovery unavailable; retaining the last-known-good catalog.',
      }
    } else {
      catalogSnapshot = cliDefaultCatalog('Live Codex model discovery unavailable; using the Codex CLI default.')
    }
  }
  return catalogSnapshot
}

export async function getCodexModelCatalog(
  forceRefresh = false,
  fetcher?: CodexCatalogFetcher,
): Promise<CodexModelCatalog> {
  const parsedRefreshedAt = Date.parse(catalogSnapshot.refreshedAt)
  const ageMs = Number.isFinite(parsedRefreshedAt) ? Date.now() - parsedRefreshedAt : Number.POSITIVE_INFINITY
  if (!forceRefresh && catalogSnapshot.source === 'app-server' && ageMs < refreshTtlMs()) {
    return catalogSnapshot
  }
  if (refreshPromise) return refreshPromise

  refreshPromise = refreshCodexModelCatalog(fetcher).finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

/** Start boot + periodic refresh. Idempotent; returned stop function aids tests. */
export function startCodexModelCatalogRefresh(options?: {
  intervalMs?: number
  refresh?: () => Promise<unknown>
}): () => void {
  if (periodicRefreshTimer) return () => stopCodexModelCatalogRefresh()
  const refresh = options?.refresh ?? (() => getCodexModelCatalog(true))
  const configuredInterval = options?.intervalMs ?? refreshTtlMs()
  const intervalMs = Math.max(MIN_PERIODIC_REFRESH_MS, configuredInterval)

  void refresh().catch(() => { /* refresh function retains its own fallback */ })
  periodicRefreshTimer = setInterval(() => {
    void refresh().catch(() => { /* keep the prior catalog */ })
  }, intervalMs)
  periodicRefreshTimer.unref?.()
  return () => stopCodexModelCatalogRefresh()
}

export function stopCodexModelCatalogRefresh(): void {
  if (!periodicRefreshTimer) return
  clearInterval(periodicRefreshTimer)
  periodicRefreshTimer = null
}

export function resolveCodexModelOption(preference: CodexModelPreference): CodexModelOption {
  const base = catalogSnapshot.options.find(option => option.preference === preference)
    ?? catalogSnapshot.options[0]
    ?? cliDefaultCatalog().options[0]
  const configuredId = process.env.COS_CODEX_MODEL?.trim() || CODEX_MODEL_ID
  if (preference === CODEX_FRONTIER_MODEL && configuredId) {
    return {
      ...base,
      preference,
      id: configuredId,
      displayName: configuredId,
      description: 'Explicit COS_CODEX_MODEL compatibility override for the legacy/frontier slot.',
      supportedReasoningEfforts: [],
      defaultReasoningEffort: resolveConfiguredCodexReasoningEffort(),
      serviceTiers: [],
      isDefault: true,
    }
  }
  return base
}

export function resolveCodexPreferenceForModelId(modelId: string): CodexModelPreference | undefined {
  const normalized = modelId.trim().toLowerCase()
  return catalogSnapshot.options.find(option => option.id.toLowerCase() === normalized)?.preference
}

export function resolveCodexEffortForModel(
  option: CodexModelOption,
  effort: EffortPreference | undefined,
): string {
  const requested = effort === undefined && option.preference === CODEX_FRONTIER_MODEL
    ? resolveConfiguredCodexReasoningEffort()
    : resolveCodexReasoningEffort(effort)
  const supported = new Set(option.supportedReasoningEfforts)
  if (supported.size === 0 || supported.has(requested)) return requested

  const fallbacks: Record<string, string[]> = {
    ultra: ['max', 'xhigh', 'high', 'medium', 'low'],
    max: ['xhigh', 'high', 'medium', 'low'],
    xhigh: ['high', 'medium', 'low'],
    high: ['medium', 'low'],
  }
  return (fallbacks[requested] ?? []).find(candidate => supported.has(candidate))
    ?? option.defaultReasoningEffort
    ?? 'high'
}

export function resolveCodexServiceTier(option: CodexModelOption): string | undefined {
  return option.serviceTiers.includes(CODEX_SERVICE_TIER) ? CODEX_SERVICE_TIER : undefined
}
