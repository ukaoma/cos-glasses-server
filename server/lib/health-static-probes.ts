import { execFile } from 'node:child_process'
import { PYTHON_BIN } from './python-bridge.js'
import {
  getCursorModelCatalog,
  isCursorProviderReady,
  resolveAgentBinary,
} from './cursor-model-catalog.js'

const DEFAULT_CACHE_TTL_MS = 30_000
const PROBE_TIMEOUT_MS = 5_000

export interface HealthStaticProbeSnapshot {
  python: string
  claude: string
  codex: string
  cursor: string
  claudeAvailable: boolean
  codexAvailable: boolean
  cursorAvailable: boolean
}

interface CachedProbe<T> {
  value: T
  refreshedAt: number
}

/**
 * Small stale-while-revalidate cache used for process-level health probes.
 * Runtime fields (recordings, recovery leases, Whisper, TTS, request counts)
 * remain fresh on every /api/health request.
 */
export function createStaticProbeCache<T>(
  load: () => Promise<T>,
  ttlMs: () => number,
  now: () => number = Date.now,
): { get: () => Promise<T>; reset: () => void } {
  let cached: CachedProbe<T> | null = null
  let inFlight: Promise<T> | null = null

  const refresh = (): Promise<T> => {
    if (inFlight) return inFlight
    inFlight = load().then((value) => {
      cached = { value, refreshedAt: now() }
      return value
    }).finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return {
    get: async () => {
      if (!cached) return refresh()
      if (now() - cached.refreshedAt < ttlMs()) return cached.value
      // A stale static version string is safer than making liveness wait for
      // four child processes. Refresh it for the next request in background.
      void refresh().catch(() => {})
      return cached.value
    },
    reset: () => {
      cached = null
      inFlight = null
    },
  }
}

function cacheTtlMs(): number {
  const raw = Number(process.env.COS_HEALTH_STATIC_PROBE_TTL_MS ?? DEFAULT_CACHE_TTL_MS)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_CACHE_TTL_MS
}

function execute(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      killSignal: 'SIGKILL',
    }, (error, stdout, stderr) => {
      if (error) return reject(error)
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export function parseCursorAboutVersion(output: string): string | undefined {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = /^CLI Version\s*:?\s*(\d{4}(?:\.\d+){1,3}(?:[-+][a-z0-9.-]+)?)$/i.exec(line)
    if (match) return match[1]
  }
  return undefined
}

function firstNonemptyLine(output: string): string | undefined {
  return output.split(/\r?\n/).map(line => line.trim()).find(Boolean)
}

async function probePython(): Promise<string> {
  if (!PYTHON_BIN) return 'standalone'
  try {
    return firstNonemptyLine((await execute(PYTHON_BIN, ['--version'])).stdout) ?? 'available'
  } catch {
    return 'error'
  }
}

async function probeClaude(): Promise<{ value: string; available: boolean }> {
  try {
    const result = await execute('claude', ['--version'])
    return { value: firstNonemptyLine(result.stdout) ?? 'available', available: true }
  } catch {
    return { value: 'error', available: false }
  }
}

async function probeCodex(): Promise<{ value: string; available: boolean }> {
  try {
    const result = await execute('codex', ['--version'])
    const combined = `${result.stdout}\n${result.stderr}`.trim()
    const versionLine = combined.split(/\r?\n/).map(line => line.trim())
      .find(line => /^codex(?:-cli)?\s+/i.test(line))
    return { value: versionLine ?? firstNonemptyLine(combined) ?? 'available', available: true }
  } catch {
    return { value: 'error', available: false }
  }
}

async function probeCursor(): Promise<{ value: string; available: boolean }> {
  const agentBinary = resolveAgentBinary()
  if (!agentBinary) return { value: 'error', available: false }
  try {
    const result = await execute(agentBinary, ['about'])
    const combined = `${result.stdout}\n${result.stderr}`.trim()
    const version = parseCursorAboutVersion(combined)
    // Catalog discovery is authenticated downstream truth and can take up to
    // seven seconds. Warm it without putting that latency on public health.
    void getCursorModelCatalog().catch(() => {})
    const available = isCursorProviderReady()
    const value = version ?? 'available'
    return {
      value: available ? value : `${value} (models unresolved)`,
      available,
    }
  } catch {
    return { value: 'error', available: false }
  }
}

async function loadStaticHealthProbes(): Promise<HealthStaticProbeSnapshot> {
  const [python, claude, codex, cursor] = await Promise.all([
    probePython(),
    probeClaude(),
    probeCodex(),
    probeCursor(),
  ])
  return {
    python,
    claude: claude.value,
    codex: codex.value,
    cursor: cursor.value,
    claudeAvailable: claude.available,
    codexAvailable: codex.available,
    cursorAvailable: cursor.available,
  }
}

const staticProbeCache = createStaticProbeCache(loadStaticHealthProbes, cacheTtlMs)

export function getHealthStaticProbes(): Promise<HealthStaticProbeSnapshot> {
  return staticProbeCache.get()
}

/** Test hook. */
export function _resetHealthStaticProbeCache(): void {
  staticProbeCache.reset()
}
