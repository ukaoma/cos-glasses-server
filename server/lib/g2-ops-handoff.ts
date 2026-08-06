// Hand off a durable local G2 recording into COS operations/ and run exact
// enrichment. Private cos-glasses-app did this inline in meeting/save; the
// public managed package only wrote ~/.cos-glasses/data/recordings until
// 2026-07-27 — so HQ could finish while operations/ never got a (G2) scribe.
//
// Contract:
//   1. Keep the local recording as the glasses MeetingStore source of truth.
//   2. When COS_OPERATIONS_DIR / COS_SCRIPTS_DIR is set, stage a pipeline-ready
//      copy under operations/personal/meetings/YYYY-MM/ (domain review marker
//      lets sync_meetings reclassify).
//   3. Run sync_meetings.py --g2-only --g2-file with the private-app retry helper.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { resolveCosOperationsDir } from './cos-operations-meetings.js'
import { runG2EnrichmentWithRetry } from './g2-enrichment-runner.js'
import { COS_SCRIPTS_DIR, PYTHON_BIN } from './python-bridge.js'
import { getServerInstanceId } from './server-instance-id.js'

const PENDING_SUMMARY = '*G2 recording — summary pending pipeline processing.*'
const DOMAIN_REVIEW_MARKER = '<!-- g2-needs-domain-review -->'
const HQ_PENDING_MARKER = '<!-- g2-hq-state: pending -->'
const OPERATIONS_OWNED_SIDECAR_FIELDS = new Set([
  'blended_into',
  'dedupEvidence',
  'enrichmentState',
  'finalPath',
  'operationsPath',
])

export function earlyMeetingSyncEnabled(): boolean {
  return process.env.COS_MEETING_EARLY_SYNC === '1'
}

interface EarlySyncRuntimeState {
  inFlight: boolean
  pendingCount: number
  lastOutcome: 'claimed' | 'finalized' | 'failed' | null
  lastAt: string | null
  lastError: string | null
}

const earlySyncRuntime: EarlySyncRuntimeState = {
  inFlight: false,
  pendingCount: 0,
  lastOutcome: null,
  lastAt: null,
  lastError: null,
}

export function getEarlyMeetingSyncSnapshot(): EarlySyncRuntimeState & {
  requested: boolean
  enabled: boolean
  available: boolean
  reason: string | null
} {
  const requested = earlyMeetingSyncEnabled()
  const scriptsDir = process.env.COS_SCRIPTS_DIR?.trim() || COS_SCRIPTS_DIR
  const syncScript = scriptsDir ? join(scriptsDir, 'sync_meetings.py') : ''
  const python = process.env.COS_PYTHON_BIN?.trim() || PYTHON_BIN
  let reason: string | null = null
  if (!scriptsDir) reason = 'operations_not_configured'
  else if (!python || !existsSync(python)) reason = 'python_unavailable'
  else if (!syncScript || !existsSync(syncScript)) reason = 'sync_script_missing'
  else if (!syncScriptSupportsLockedImport(syncScript)) reason = 'sync_script_upgrade_required'
  const available = reason === null
  return { requested, enabled: requested && available, available, reason, ...earlySyncRuntime }
}

export interface G2StageOptions {
  phase?: 'claim' | 'final'
  hqState?: 'queued' | 'running' | 'accepted' | 'rejected' | 'failed' | 'unavailable'
  revision?: number
}

export function patchRecordingForG2Pipeline(
  markdown: string,
  options: G2StageOptions = {},
): string {
  let text = markdown.replace(/\r\n?/g, '\n')
  if (!/\|\s*\*\*Source\*\*\s*\|\s*G2 Glasses\s*\|/i.test(text) && !text.includes('| G2 Glasses')) {
    text = text.replace(
      /(\|\s*\*\*Source\*\*\s*\|)([^|\n]*)\|/,
      '| **Source** | G2 Glasses |',
    )
  }
  text = text.replace(
    /\*Standalone recording[^*]*\*/i,
    PENDING_SUMMARY,
  )
  if (!/summary pending pipeline processing/i.test(text)) {
    if (/## Summary\n\n/.test(text)) {
      text = text.replace(/## Summary\n\n/, `## Summary\n\n${PENDING_SUMMARY}\n\n`)
    } else {
      text = `${text.trimEnd()}\n\n## Summary\n\n${PENDING_SUMMARY}\n`
    }
  }
  if (!text.includes('g2-needs-domain-review')) {
    if (text.includes('## Summary')) {
      text = text.replace('## Summary', `${DOMAIN_REVIEW_MARKER}\n\n## Summary`)
    } else {
      text = `${text.trimEnd()}\n\n${DOMAIN_REVIEW_MARKER}\n`
    }
  }
  text = text.replace(/\n?<!-- g2-hq-state: pending -->\n?/g, '\n')
  if (options.phase === 'claim') {
    text = text.includes(DOMAIN_REVIEW_MARKER)
      ? text.replace(DOMAIN_REVIEW_MARKER, `${HQ_PENDING_MARKER}\n${DOMAIN_REVIEW_MARKER}`)
      : `${text.trimEnd()}\n\n${HQ_PENDING_MARKER}\n`
  }
  return text
}

function parseSidecar(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** Merge server-owned capture truth while preserving operations-owned match state. */
export function mergeG2OperationsSidecar(
  sourcePath: string,
  destinationPath: string,
  options: G2StageOptions = {},
): void {
  const source = parseSidecar(sourcePath)
  if (!source) return
  const existing = parseSidecar(destinationPath) ?? {}
  const sourceSession = typeof source.sessionId === 'string' ? source.sessionId : ''
  const existingSession = typeof existing.sessionId === 'string' ? existing.sessionId : ''
  if (sourceSession && existingSession && sourceSession !== existingSession) {
    throw new Error(`Refusing G2 sidecar merge across sessions (${existingSession} != ${sourceSession})`)
  }

  const priorRevision = Number(existing.lifecycleRevision ?? 0)
  const nextRevision = Math.max(Number(options.revision ?? 0), Number(source.lifecycleRevision ?? 0))
  if (Number.isFinite(priorRevision) && Number.isFinite(nextRevision) && nextRevision < priorRevision) {
    throw new Error(`Refusing regressing G2 sidecar revision ${nextRevision} < ${priorRevision}`)
  }

  const merged: Record<string, unknown> = { ...existing, ...source }
  for (const field of OPERATIONS_OWNED_SIDECAR_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(existing, field)) merged[field] = existing[field]
  }
  merged.lifecycleRevision = Math.max(priorRevision || 0, nextRevision || 0)
  const inferredFinalHqState = source.batchApplied === true
    ? 'accepted'
    : source.batchQualityReport
      ? 'rejected'
      : 'unavailable'
  merged.hqState = options.hqState
    ?? (options.phase === 'claim' ? 'queued' : inferredFinalHqState)
  merged.syncState = options.phase === 'claim' ? 'claimed' : 'finalized'
  merged.serverInstanceId = getServerInstanceId()
  merged.lifecycleUpdatedAt = new Date().toISOString()
  durableAtomicWriteFileSync(destinationPath, JSON.stringify(merged, null, 2), { mode: 0o600 })
}

/** Stage local recording into operations/personal for exact enrichment. */
export function stageRecordingIntoOperations(
  localMeetingPath: string,
  options: G2StageOptions = { phase: 'final' },
): string | null {
  const operationsDir = resolveCosOperationsDir()
  if (!operationsDir) return null
  if (!existsSync(localMeetingPath)) {
    console.warn(`[g2-ops-handoff] Local meeting missing: ${localMeetingPath}`)
    return null
  }

  const month = basename(dirname(localMeetingPath))
  if (!/^\d{4}-\d{2}$/.test(month)) {
    console.warn(`[g2-ops-handoff] Unexpected meeting month folder for ${localMeetingPath}`)
    return null
  }

  const destDir = join(operationsDir, 'personal', 'meetings', month)
  mkdirSync(destDir, { recursive: true })
  const destPath = join(destDir, basename(localMeetingPath))
  const patched = patchRecordingForG2Pipeline(readFileSync(localMeetingPath, 'utf8'), options)

  const stem = basename(localMeetingPath, '.md')
  const localDir = dirname(localMeetingPath)
  for (const companionName of [`${stem}.g2-chunks.json`, `${stem}.json`]) {
    const companion = join(localDir, companionName)
    if (existsSync(companion)) {
      mergeG2OperationsSidecar(companion, join(destDir, companionName), options)
    }
  }
  // Markdown is the visible commit marker. Publish it only after every
  // identity/revision sidecar has validated and committed.
  durableAtomicWriteFileSync(destPath, patched, { mode: 0o600 })
  return destPath
}

async function runOperationsSync(localMeetingPath: string, claimOnly: boolean): Promise<void> {
  if (!COS_SCRIPTS_DIR) {
    console.log('[meeting/save] Standalone mode — skipping G2 sync pipeline')
    return
  }
  if (!PYTHON_BIN) throw new Error('COS operations configured but Python bridge is unavailable')
  if (!existsSync(PYTHON_BIN)) {
    throw new Error(`COS python missing at ${PYTHON_BIN}`)
  }

  const syncScript = join(COS_SCRIPTS_DIR, 'sync_meetings.py')
  if (!existsSync(syncScript)) {
    throw new Error(`sync_meetings.py missing at ${syncScript}`)
  }

  const spawnPath = process.env.PATH?.includes('/opt/homebrew/bin')
    ? process.env.PATH
    : `/opt/homebrew/bin:${process.env.PATH || ''}`

  const supportsLockedImport = syncScriptSupportsLockedImport(syncScript)
  if (claimOnly && !supportsLockedImport) {
    throw new Error('Early meeting sync requires a newer sync_meetings.py with --g2-import-file')
  }
  const meetingFile = supportsLockedImport
    ? localMeetingPath
    : stageRecordingIntoOperations(localMeetingPath, { phase: 'final' })
  if (!meetingFile) throw new Error('Unable to stage G2 recording into operations')

  const enrichment = await runG2EnrichmentWithRetry({
    pythonBin: PYTHON_BIN,
    syncScript,
    scriptsDir: COS_SCRIPTS_DIR,
    meetingFile,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PATH: spawnPath,
      COS_G2_IMPORT_ROOT: dirname(dirname(localMeetingPath)),
      COS_SERVER_INSTANCE_ID: getServerInstanceId() ?? '',
    },
    claimOnly,
    importLocal: supportsLockedImport,
    retryDelaysMs: claimOnly ? [0] : undefined,
    timeoutMs: claimOnly ? 30_000 : undefined,
    onAttempt: message => console.log(`[meeting/save] G2 ${claimOnly ? 'claim' : 'exact sync'}: ${message}`),
  })

  if (enrichment.ok && enrichment.outcome) {
    console.log(
      `[meeting/save] G2 ${claimOnly ? 'claim' : 'pipeline'} verified after ${enrichment.attempts} attempt(s): `
      + `${enrichment.outcome.title} → ${enrichment.outcome.path}`,
    )
  } else {
    throw new Error(
      `G2 ${claimOnly ? 'claim' : 'pipeline'} failed after ${enrichment.attempts} attempt(s): `
      + `${enrichment.error ?? 'unknown exact-file sync failure'}`
    )
  }
}

function syncScriptSupportsLockedImport(syncScript: string): boolean {
  try { return readFileSync(syncScript, 'utf8').includes('--g2-import-file') } catch { return false }
}

let claimQueueTail: Promise<void> = Promise.resolve()

export async function claimMeetingInOperations(localMeetingPath: string): Promise<void> {
  if (!earlyMeetingSyncEnabled()) return
  earlySyncRuntime.pendingCount += 1
  const claim = claimQueueTail.then(async () => {
    earlySyncRuntime.inFlight = true
    try {
      await runOperationsSync(localMeetingPath, true)
      earlySyncRuntime.lastOutcome = 'claimed'
      earlySyncRuntime.lastError = null
    } catch (error) {
      earlySyncRuntime.lastOutcome = 'failed'
      earlySyncRuntime.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      earlySyncRuntime.pendingCount -= 1
      earlySyncRuntime.inFlight = earlySyncRuntime.pendingCount > 0
      earlySyncRuntime.lastAt = new Date().toISOString()
    }
  })
  claimQueueTail = claim.catch(() => undefined)
  await claim
}

export async function handoffMeetingToOperations(localMeetingPath: string): Promise<void> {
  await runOperationsSync(localMeetingPath, false)
  earlySyncRuntime.lastOutcome = 'finalized'
  earlySyncRuntime.lastError = null
  earlySyncRuntime.lastAt = new Date().toISOString()
}
