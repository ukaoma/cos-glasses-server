import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CACHE_TTL_MS = 30_000
const HELPER_TIMEOUT_MS = 15_000

export interface UsageSummaryPayload {
  available: boolean
  source: 'helper' | 'ledger_fallback'
  fetchedAt: string
  sessionUsage: Record<string, unknown> | null
  cosCost: Record<string, unknown> | null
}

function candidateHelperPaths(home = homedir()): string[] {
  return [
    join(home, 'Library', 'Application Support', 'COS Control', 'bin', 'cos-control-helper'),
    '/Applications/COS Control.app/Contents/Resources/cos-control-helper',
    '/Applications/COS Control.app/Contents/MacOS/cos-control-helper',
  ]
}

export function resolveCosControlHelperBin(home = homedir()): string | null {
  for (const p of candidateHelperPaths(home)) {
    try {
      accessSync(p, fsConstants.X_OK)
      return p
    } catch {
      continue
    }
  }
  return null
}

function runHelperReadOnly(bin: string, verb: 'session-usage' | 'cos-usage'): Promise<Record<string, unknown> | null> {
  return new Promise(resolve => {
    execFile(
      bin,
      [verb, '--read-only'],
      { timeout: HELPER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err || !stdout) return resolve(null)
        try {
          const parsed = JSON.parse(stdout) as { ok?: boolean; details?: Record<string, unknown> }
          if (parsed && parsed.ok && parsed.details && typeof parsed.details === 'object') {
            return resolve(parsed.details)
          }
          resolve(null)
        } catch {
          resolve(null)
        }
      },
    )
  })
}

export function readFallbackTokenAudit(home = homedir()): Record<string, unknown> {
  const auditPath = join(home, '.cos-glasses', 'token-audit.jsonl')
  if (!existsSync(auditPath)) {
    return { auditFound: false, rows: [], totalCalls: 0, totalTokens: 0 }
  }
  try {
    const raw = readFileSync(auditPath, 'utf8')
    const lines = raw.split('\n').filter(Boolean).slice(-2000)
    const byCategory = new Map<string, { calls: number; tokens: number; usd: number }>()
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>
        const cat = typeof row.caller === 'string'
          ? row.caller
          : typeof row.category === 'string'
            ? row.category
            : typeof row.route === 'string'
              ? row.route
              : 'other'
        const tokens = (typeof row.inputTokens === 'number' ? row.inputTokens : 0)
          + (typeof row.outputTokens === 'number' ? row.outputTokens : 0)
          + (typeof row.tokens === 'number' ? row.tokens : 0)
        const usd = typeof row.costUsd === 'number' ? row.costUsd : typeof row.usd === 'number' ? row.usd : 0
        const cur = byCategory.get(cat) ?? { calls: 0, tokens: 0, usd: 0 }
        cur.calls += 1
        cur.tokens += tokens
        cur.usd += usd
        byCategory.set(cat, cur)
      } catch {
        continue
      }
    }
    const rows = [...byCategory.entries()].map(([category, v]) => ({
      category,
      calls: v.calls,
      estimatedTokens: v.tokens,
      estimatedUSD: Number(v.usd.toFixed(4)),
    }))
    return {
      auditFound: true,
      rows,
      updatedAt: new Date().toISOString(),
    }
  } catch {
    return { auditFound: false, rows: [] }
  }
}

let cachedSummary: { at: number; value: UsageSummaryPayload } | null = null
let inFlightSummary: Promise<UsageSummaryPayload> | null = null

export async function getWebUsageSummary(options: {
  forceRefresh?: boolean
  helperBin?: string | null
  home?: string
} = {}): Promise<UsageSummaryPayload> {
  const now = Date.now()
  if (!options.forceRefresh && cachedSummary && now - cachedSummary.at < CACHE_TTL_MS) {
    return cachedSummary.value
  }
  if (inFlightSummary) return inFlightSummary

  inFlightSummary = (async (): Promise<UsageSummaryPayload> => {
    const bin = options.helperBin !== undefined ? options.helperBin : resolveCosControlHelperBin(options.home)
    if (bin) {
      const [sessionUsage, cosCost] = await Promise.all([
        runHelperReadOnly(bin, 'session-usage'),
        runHelperReadOnly(bin, 'cos-usage'),
      ])
      if (sessionUsage || cosCost) {
        const payload: UsageSummaryPayload = {
          available: true,
          source: 'helper',
          fetchedAt: new Date().toISOString(),
          sessionUsage,
          cosCost: cosCost ?? readFallbackTokenAudit(options.home),
        }
        cachedSummary = { at: Date.now(), value: payload }
        return payload
      }
    }
    const fallback: UsageSummaryPayload = {
      available: true,
      source: 'ledger_fallback',
      fetchedAt: new Date().toISOString(),
      sessionUsage: null,
      cosCost: readFallbackTokenAudit(options.home),
    }
    cachedSummary = { at: Date.now(), value: fallback }
    return fallback
  })().finally(() => {
    inFlightSummary = null
  })

  return inFlightSummary
}
