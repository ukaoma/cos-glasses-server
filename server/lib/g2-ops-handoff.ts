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

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
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
  'claimed_parent',
  'correctionRevision',
  'labelsNewerThanGraph',
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

/** Sources that share the `.g2-chunks.json` sidecar shape but are not G2 glasses audio. */
const NON_G2_SOURCE_TYPES = new Set(['mac_system_audio', 'iphone_microphone'])
const NON_G2_HEADER = /\|\s*\*\*(?:Source\*\*\s*\|\s*(?:Mac System Audio|iPhone Microphone)|Capture source\*\*\s*\|\s*(?:mac_system_audio|iphone_microphone))\s*\|/i

function sidecarSourceType(sidecar: Record<string, unknown> | null): string | null {
  if (!sidecar) return null
  if (typeof sidecar.sourceType === 'string') return sidecar.sourceType
  const capture = sidecar.captureSource
  if (capture && typeof capture === 'object' && typeof (capture as Record<string, unknown>).sourceType === 'string') {
    return (capture as Record<string, unknown>).sourceType as string
  }
  return null
}

/**
 * A Mac or iPhone capture, read from its markdown header or its sidecar. Neither is G2 audio,
 * so neither may be relabelled "G2 Glasses" or handed to the G2 import, where sync_meetings
 * would make it a candidate to blend into a Fireflies or Granola meeting.
 */
export function isNonG2CaptureRecording(markdown: string, sidecar: Record<string, unknown> | null = null): boolean {
  if (NON_G2_HEADER.test(markdown)) return true
  const sourceType = sidecarSourceType(sidecar)
  return sourceType !== null && NON_G2_SOURCE_TYPES.has(sourceType)
}

export function patchRecordingForG2Pipeline(
  markdown: string,
  options: G2StageOptions = {},
): string {
  if (isNonG2CaptureRecording(markdown)) {
    throw new Error('Refusing to relabel a Mac or iPhone recording as G2 Glasses')
  }
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

/** A missing or unreadable file reads as empty: the guard only refuses on positive evidence. */
function readTextOrEmpty(path: string): string {
  try { return readFileSync(path, 'utf8') } catch { return '' }
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

export function g2Revision(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid G2 revision')
  return value
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

  const priorRevision = g2Revision(existing.lifecycleRevision)
  const nextRevision = Math.max(g2Revision(options.revision), g2Revision(source.lifecycleRevision))
  if (Number.isFinite(priorRevision) && Number.isFinite(nextRevision) && nextRevision < priorRevision) {
    throw new Error(`Refusing regressing G2 sidecar revision ${nextRevision} < ${priorRevision}`)
  }

  const merged: Record<string, unknown> = { ...existing, ...source }
  for (const field of OPERATIONS_OWNED_SIDECAR_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(existing, field)) merged[field] = existing[field]
  }
  const correctionFields = ['chunks', 'chunkEntries', 'speakers', 'batchSegments', 'batchApplied', 'correctionRevision', 'labelsNewerThanGraph']
  if (g2Revision(existing.correctionRevision) > g2Revision(source.correctionRevision)) {
    for (const field of correctionFields) {
      if (Object.prototype.hasOwnProperty.call(existing, field)) merged[field] = existing[field]
      else delete merged[field]
    }
  }
  merged.correctionRevision = Math.max(g2Revision(existing.correctionRevision), g2Revision(source.correctionRevision))
  merged.labelsNewerThanGraph = existing.labelsNewerThanGraph === true || source.labelsNewerThanGraph === true
  merged.lifecycleRevision = Math.max(priorRevision || 0, nextRevision || 0)
  const inferredFinalHqState = merged.batchApplied === true
    ? 'accepted'
    : merged.batchQualityReport
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

  const sourceSidecar = parseSidecar(localMeetingPath.replace(/\.md$/, '.g2-chunks.json'))
  if (isNonG2CaptureRecording(readFileSync(localMeetingPath, 'utf8'), sourceSidecar)) {
    throw new Error('Refusing to stage a Mac or iPhone recording through the G2 import')
  }
  const destDir = join(operationsDir, 'personal', 'meetings', month)
  mkdirSync(destDir, { recursive: true })
  const destPath = join(destDir, basename(localMeetingPath))
  const destinationSidecar = parseSidecar(destPath.replace(/\.md$/, '.g2-chunks.json'))
  const keepMarkdown = g2Revision(destinationSidecar?.correctionRevision) > g2Revision(sourceSidecar?.correctionRevision)
  if (keepMarkdown && !existsSync(destPath)) throw new Error('Corrected operations markdown missing; refusing stale import')
  const patched = keepMarkdown ? readFileSync(destPath, 'utf8') : patchRecordingForG2Pipeline(readFileSync(localMeetingPath, 'utf8'), options)

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

/**
 * Whether a G2 recording saved now can reach operations/ at all. The save path skips the pipeline when
 * COS_SCRIPTS_DIR is unset, and runOperationsSync throws when the venv Python or sync_meetings.py is missing, so in
 * each of those cases the recording stays only in the server's own store. GET /api/meetings reads this to decide
 * whether a multi-folder library must list that store itself. Reads env live, like cosOpsPipelineConfigured in
 * routes/meeting.ts.
 */
export function g2RecordingsReachOperations(): boolean {
  const raw = process.env.COS_SCRIPTS_DIR?.trim()
  if (!raw) return false
  const scriptsDir = resolve(raw)
  return existsSync(resolve(scriptsDir, 'venv/bin/python3')) && existsSync(join(scriptsDir, 'sync_meetings.py'))
}

async function runOperationsSync(localMeetingPath: string, claimOnly: boolean): Promise<void> {
  if (!COS_SCRIPTS_DIR) {
    console.log('[meeting/save] Standalone mode — skipping G2 sync pipeline')
    return
  }
  // 6.94.0: a Mac or iPhone capture never takes the G2 import, whatever the caller asked.
  if (isNonG2CaptureRecording(readTextOrEmpty(localMeetingPath), parseSidecar(localMeetingPath.replace(/\.md$/, '.g2-chunks.json')))) {
    throw new Error('Refusing a Mac or iPhone recording on the G2 import; it has its own import')
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

// ── 6.94.0: Mac recordings into the COS meeting library ─────────────────────
//
// A saved Mac system-audio recording is filed through the same pipeline as a G2 one
// (sync_meetings.py stages it, runs the LLM summary/title/domain step, renames and moves
// it), but through its own import, `--mac-import-file`, which never takes part in G2 to
// Fireflies/Granola matching. The server uses it only when the installed sync_meetings.py
// says it can (`--capabilities`); an older script leaves the recording standalone, exactly
// as before 6.94.0, and is never given a Mac file on the G2 import.

export interface SyncCapabilities {
  macImport: boolean
  /** Why Mac filing is unavailable; null when it is available. */
  reason: string | null
}

export interface CapabilityProbeResult {
  code: number | null
  stdout: string
}

export type CapabilityProbe = (pythonBin: string, syncScript: string, cwd: string) => Promise<CapabilityProbeResult>

const CAPABILITY_PROBE_TIMEOUT_MS = 30_000
/** sync_meetings.py `mac_twins` version the server needs: 2 = twins of G2 recordings AND cloud scribes. */
export const MAC_TWINS_REQUIRED = 2
/**
 * sync_meetings.py `mac_title` version the server needs: 1 = its model prompt asks a Mac recording
 * for a title. The script that first shipped `mac_import` (COS d51abbff2) told the model the title
 * was "ONLY for G2 source, null otherwise", so every Mac import came back untitled and was never
 * written, after three model calls per save (2026-10-27).
 */
export const MAC_TITLE_REQUIRED = 1
const capabilityCache = new Map<string, SyncCapabilities>()

function spawnCapabilityProbe(pythonBin: string, syncScript: string, cwd: string): Promise<CapabilityProbeResult> {
  return new Promise(resolvePromise => {
    execFile(
      pythonBin,
      [syncScript, '--capabilities'],
      { cwd, timeout: CAPABILITY_PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024, env: { ...process.env, PYTHONUNBUFFERED: '1' } },
      (error, stdout) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : null) : 0
        resolvePromise({ code, stdout: String(stdout ?? '') })
      },
    )
  })
}

/** Test seam: forget probed capabilities. */
export function resetSyncCapabilitiesCache(): void {
  capabilityCache.clear()
}

/**
 * What the installed sync_meetings.py can do, read from `--capabilities` rather than guessed.
 * Mac filing needs `mac_import: 1`, `mac_twins: 2` or later and `mac_title: 1` or later.
 *
 * Cached per python + script + mtime + size, so an upgraded script is probed again. A script
 * whose text never mentions `--capabilities` is an older one: it would take the sync lock
 * before rejecting the flag, so it is never spawned and reads as "no Mac import". A failed or
 * unreadable probe is not cached, so a transient failure is retried on the next recording.
 */
export async function readSyncCapabilities(
  pythonBin: string,
  syncScript: string,
  probe: CapabilityProbe = spawnCapabilityProbe,
): Promise<SyncCapabilities> {
  let key: string
  let text: string
  try {
    const stat = statSync(syncScript)
    key = `${pythonBin}\0${syncScript}\0${stat.mtimeMs}\0${stat.size}`
    text = readFileSync(syncScript, 'utf8')
  } catch {
    return { macImport: false, reason: 'sync_script_missing' }
  }
  const cached = capabilityCache.get(key)
  if (cached) return cached
  if (!text.includes('--capabilities')) {
    const result = { macImport: false, reason: 'sync_script_upgrade_required' }
    capabilityCache.set(key, result)
    return result
  }
  const probed = await probe(pythonBin, syncScript, dirname(syncScript))
  if (probed.code !== 0) return { macImport: false, reason: 'capability_probe_failed' }
  const line = probed.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { return { macImport: false, reason: 'capability_probe_unreadable' } }
  // Both: the import, AND the twin rule (version 2: G2 recordings and Fireflies/Granola scribes)
  // that keeps a Mac copy of an already-recorded meeting out of LightRAG and Work. A script with
  // the import but an older twin rule would file a Mac + Fireflies meeting twice.
  const caps = !!parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  const macImport = caps.mac_import === 1
    && typeof caps.mac_twins === 'number' && caps.mac_twins >= MAC_TWINS_REQUIRED
    && typeof caps.mac_title === 'number' && caps.mac_title >= MAC_TITLE_REQUIRED
  const result = { macImport, reason: macImport ? null : 'sync_script_upgrade_required' }
  capabilityCache.set(key, result)
  return result
}

export type MacLibraryFiling =
  | { outcome: 'filed'; path: string; status: string }
  | { outcome: 'standalone'; reason: string }

export interface MacLibraryDependencies {
  probe?: CapabilityProbe
  runEnrichment?: typeof runG2EnrichmentWithRetry
}

/** True only for a Mac capture: the sidecar says mac_system_audio AND the header says Mac System Audio. */
export function isMacSystemAudioRecording(markdown: string, sidecar: Record<string, unknown> | null): boolean {
  return sidecarSourceType(sidecar) === 'mac_system_audio'
    && /\|\s*\*\*Source\*\*\s*\|\s*Mac System Audio\s*\|/i.test(markdown)
}

/**
 * File one saved Mac recording into the COS meeting library, or say why it stays standalone.
 *
 * Reads the operations env live (like cosOpsPipelineConfigured), so a Control-updated env is
 * seen. Throws when the pipeline ran and failed; returns `standalone` when it never could run.
 */
export async function fileMacRecordingInLibrary(
  localMeetingPath: string,
  deps: MacLibraryDependencies = {},
): Promise<MacLibraryFiling> {
  const raw = process.env.COS_SCRIPTS_DIR?.trim()
  if (!raw) return { outcome: 'standalone', reason: 'operations_not_configured' }
  const scriptsDir = resolve(raw)
  const pythonBin = resolve(scriptsDir, 'venv/bin/python3')
  const syncScript = join(scriptsDir, 'sync_meetings.py')
  if (!existsSync(pythonBin)) return { outcome: 'standalone', reason: 'python_unavailable' }
  if (!existsSync(syncScript)) return { outcome: 'standalone', reason: 'sync_script_missing' }

  const markdown = readFileSync(localMeetingPath, 'utf8')
  const sidecar = parseSidecar(localMeetingPath.replace(/\.md$/, '.g2-chunks.json'))
  if (!isMacSystemAudioRecording(markdown, sidecar)) {
    throw new Error(`Not a Mac system-audio recording: ${basename(localMeetingPath)}`)
  }

  const capabilities = await readSyncCapabilities(pythonBin, syncScript, deps.probe)
  if (!capabilities.macImport) return { outcome: 'standalone', reason: capabilities.reason ?? 'sync_script_upgrade_required' }

  const spawnPath = process.env.PATH?.includes('/opt/homebrew/bin')
    ? process.env.PATH
    : `/opt/homebrew/bin:${process.env.PATH || ''}`
  const enrichment = await (deps.runEnrichment ?? runG2EnrichmentWithRetry)({
    pythonBin,
    syncScript,
    scriptsDir,
    meetingFile: localMeetingPath,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PATH: spawnPath,
      COS_G2_IMPORT_ROOT: dirname(dirname(localMeetingPath)),
      COS_SERVER_INSTANCE_ID: getServerInstanceId() ?? '',
    },
    importLocal: true,
    macImport: true,
    onAttempt: message => console.log(`[meeting/save] Mac library filing: ${message}`),
  })
  if (!enrichment.ok || !enrichment.outcome) {
    throw new Error(
      `Mac library filing failed after ${enrichment.attempts} attempt(s): `
      + `${enrichment.error ?? 'unknown exact-file sync failure'}`,
    )
  }
  return { outcome: 'filed', path: enrichment.outcome.path, status: enrichment.outcome.status }
}
