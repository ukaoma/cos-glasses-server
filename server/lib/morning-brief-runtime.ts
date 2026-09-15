// Morning brief — the one production scheduler, wired to the real coordinator.
//
// Mirrors query-job-runtime.ts: the module owns the singleton so the router,
// health, and index.ts all see the same instance, and tests construct their
// own MorningBriefScheduler with fake deps instead of importing this file.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { getActiveSessions, createSession } from './conversation.js'
import { currentMessageEra, exchangeBelongsToEra } from './message-era.js'
import { maxGlobalMsgNumInDir } from '../routes/message-ref.js'
import { dataPath } from './data-dir.js'
import { getOwnerName } from './profile.js'
import { durableQueryJobsEnabled } from './query-job-feature.js'
import { projectPublicConversationTerminal, queryJobCoordinator } from './query-job-runtime.js'
import { maintenanceAdmissionsOpen } from './maintenance-lifecycle.js'
import { maxReservedGlobalMsgNum, registerMessageReservationSource } from './message-reservations.js'
import {
  bindTaskDispatcher,
  dispatchDueTasks,
  reconcileDispatch,
  reservationsForEra,
} from './task-dispatcher.js'
import { composeTaskDigest, listBoard } from './task-store.js'
import { morningBriefPaths } from './morning-brief-config.js'
import { MorningBriefScheduler } from './morning-brief-scheduler.js'
import {
  MorningBriefCoverageService,
  type CalendarProbe,
  type ContextProbe,
  type MeetingsProbe,
  type ReflectionProbe,
  type SkillProbe,
  type TasksProbe,
} from './morning-brief-coverage.js'
import {
  listCosOperationsMeetingMonths,
  listDirectLibraryMeetingMonths,
  resolveMeetingLibrary,
} from './cos-operations-meetings.js'
import { importedLibraryMonths, supersededDayCounts } from './imported-library-rows.js'
import { getMeetingStore } from './meeting-store.js'
import { COS_SCRIPTS_DIR, callPython, contextSourceAvailable, pythonBridgeAvailable } from './python-bridge.js'
import { resolveProviderWorkDir } from './launch-dir.js'

/** Highest stamped message number in the active era: live sessions, the day
 * archives, AND every number a not-yet-projected job or brief already holds.
 * The same arithmetic /api/message-counter serves the phone. */
export function currentMessageMax(): number {
  const era = currentMessageEra()
  let liveMax = 0
  for (const session of getActiveSessions()) {
    for (const exchange of (session as { exchanges?: Array<{ globalMsgNum?: unknown; messageEra?: unknown }> }).exchanges ?? []) {
      if (!exchangeBelongsToEra(exchange, era)) continue
      if (typeof exchange?.globalMsgNum === 'number' && exchange.globalMsgNum > liveMax) liveMax = exchange.globalMsgNum
    }
  }
  return Math.max(liveMax, maxGlobalMsgNumInDir(dataPath('archive'), era), maxReservedGlobalMsgNum(era))
}

// ── Coverage probes (the same wells COS Control's Activity tiles read) ────────

function sumDayCounts(months: string[], days: (month: string) => Array<{ count: number }>): number {
  let total = 0
  for (const month of months) for (const day of days(month)) total += day.count
  return total
}

/**
 * How many meetings this Mac holds, counted the way the LIST counts them.
 *
 * Shares `supersededDayCounts` with `/api/meetings`, so the brief and the
 * Meetings list can never disagree about a day: a merged record replaced its
 * import and its capture in the list, and it replaces them here too. On a Mac
 * with no derived records the helper is the same uncapped filename scan it has
 * always been.
 */
export function probeMeetings(): MeetingsProbe | null {
  const library = resolveMeetingLibrary()
  if (library.layout === 'direct') {
    const months = uniqueMonths([listDirectLibraryMeetingMonths(), importedLibraryMonths()])
    return { count: sumDayCounts(months, month => supersededDayCounts(month, 'direct')), newestMonth: months[0] ?? null, layout: library.layout }
  }
  if (library.layout === 'multi_domain') {
    const months = uniqueMonths([listCosOperationsMeetingMonths('all'), importedLibraryMonths()])
    return { count: sumDayCounts(months, month => supersededDayCounts(month, 'multi_domain')), newestMonth: months[0] ?? null, layout: library.layout }
  }
  if (library.layout === 'invalid_explicit_root') return null
  const store = getMeetingStore()
  const months = uniqueMonths([store.listMonths(), importedLibraryMonths()])
  return { count: sumDayCounts(months, month => supersededDayCounts(month, 'standalone', { store })), newestMonth: months[0] ?? null, layout: 'standalone' }
}

function uniqueMonths(groups: string[][]): string[] {
  return [...new Set(groups.flat())].sort().reverse()
}

export async function probeContext(): Promise<ContextProbe | null> {
  if (contextSourceAvailable() === null) return null
  const data = await callPython(['context-status'], 8_000) as {
    memory?: { available?: unknown; total?: unknown; state?: unknown; reason?: unknown }
    threads?: { available?: unknown; total?: unknown; active?: unknown; state?: unknown; reason?: unknown }
  } | null
  if (!data || typeof data !== 'object') return null
  const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0
  const state = (part?: { state?: unknown; reason?: unknown }) =>
    typeof part?.state === 'string' ? part.state : typeof part?.reason === 'string' ? part.reason : undefined
  return {
    memory: { available: data.memory?.available === true, total: num(data.memory?.total), state: state(data.memory) },
    threads: { available: data.threads?.available === true, total: num(data.threads?.total), active: num(data.threads?.active), state: state(data.threads) },
  }
}

export async function probeCalendar(): Promise<CalendarProbe | null> {
  if (!pythonBridgeAvailable()) return null
  const data = await callPython(['calendar'], 8_000) as { meetings_today_count?: unknown; today_events?: unknown; data_source?: unknown } | null
  if (!data || typeof data !== 'object') return null
  const today = typeof data.meetings_today_count === 'number'
    ? data.meetings_today_count
    : Array.isArray(data.today_events) ? data.today_events.length : 0
  return { todayCount: Math.max(0, Math.trunc(today)), ...(typeof data.data_source === 'string' ? { source: data.data_source } : {}) }
}

export async function probeTasks(): Promise<TasksProbe | null> {
  if (!pythonBridgeAvailable()) return null
  const data = await callPython(['tasks'], 8_000) as Record<string, unknown> | null
  if (!data || typeof data !== 'object') return null
  let open = 0
  let files = 0
  for (const rows of Object.values(data)) {
    if (!Array.isArray(rows)) continue
    files += 1
    for (const row of rows) {
      if (row && typeof row === 'object' && (row as { is_checked?: unknown }).is_checked !== true) open += 1
    }
  }
  return { open, files }
}

const REFLECTION_LOG_MAX_BYTES = 8 * 1024 * 1024

export function probeReflection(): ReflectionProbe | null {
  if (!COS_SCRIPTS_DIR) return null
  const file = resolve(COS_SCRIPTS_DIR, '.cos_reflect_log.jsonl')
  let stat
  try { stat = statSync(file) } catch { return null }
  if (!stat.isFile()) return null
  const newestAt = stat.mtime.toISOString()
  if (stat.size > REFLECTION_LOG_MAX_BYTES) return { entries: -1, newestAt }
  let entries = 0
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) entries += 1
  } catch { return null }
  return { entries, newestAt }
}

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/

/** Where a skill would be found, in the order the prompt tells the agent to
 * look. Returns a folder LABEL, never an absolute path. */
export function probeSkill(rawName: string, workDir = resolveProviderWorkDir({ scriptsDir: COS_SCRIPTS_DIR }), home = homedir()): SkillProbe {
  const name = rawName.trim().replace(/^\//, '')
  if (!SKILL_NAME_RE.test(name) || basename(name) !== name) return { found: false }
  const nested = name.replace(/:/g, '/')
  const candidates: Array<[string, string]> = [
    ['.claude/skills', join(workDir, '.claude', 'skills', name, 'SKILL.md')],
    ['.agents/skills', join(workDir, '.agents', 'skills', name, 'SKILL.md')],
    ['.agents/skills', join(workDir, '.agents', 'skills', nested, 'SKILL.md')],
    ['.claude/commands', join(workDir, '.claude', 'commands', `${name}.md`)],
    ['.claude/commands', join(workDir, '.claude', 'commands', `${nested}.md`)],
    ['~/.claude/skills', join(home, '.claude', 'skills', name, 'SKILL.md')],
    ['~/.claude/commands', join(home, '.claude', 'commands', `${name}.md`)],
    ['~/.codex/prompts', join(home, '.codex', 'prompts', `${name}.md`)],
  ]
  for (const [where, path] of candidates) {
    try { if (existsSync(path)) return { found: true, where } } catch { /* unreadable: keep looking */ }
  }
  return { found: false }
}

let scheduler: MorningBriefScheduler | null = null
let unregisterReservations: (() => void) | null = null
let unregisterTaskReservations: (() => void) | null = null

export function getMorningBriefScheduler(): MorningBriefScheduler {
  if (!scheduler) {
    bindTaskDispatcher({
      submit: raw => queryJobCoordinator.submit(raw),
      findByClientGeneration: (clientJobId, generation) => queryJobCoordinator.getByClientGeneration(clientJobId, generation),
      getSnapshot: jobId => queryJobCoordinator.getSnapshot(jobId),
      getExecution: jobId => queryJobCoordinator.store.getExecution(jobId),
      cancel: (jobId, generation) => queryJobCoordinator.cancel(jobId, generation),
      complete: (jobId, input) => queryJobCoordinator.store.complete(jobId, input),
      createSession,
      currentMessageEra,
      currentMessageMax,
      durableJobsEnabled: durableQueryJobsEnabled,
      admissionsOpen: maintenanceAdmissionsOpen,
      projectTerminal: projectPublicConversationTerminal,
      finishIfActive: jobId => queryJobCoordinator.finishIfActive(jobId),
    })
    const instance = new MorningBriefScheduler({
      paths: morningBriefPaths(),
      submit: raw => queryJobCoordinator.submit(raw),
      findByClientGeneration: (clientJobId, generation) => queryJobCoordinator.getByClientGeneration(clientJobId, generation),
      getSnapshot: jobId => queryJobCoordinator.getSnapshot(jobId),
      createSession,
      currentMessageEra,
      currentMessageMax,
      ownerName: getOwnerName,
      durableJobsEnabled: durableQueryJobsEnabled,
      admissionsOpen: maintenanceAdmissionsOpen,
      coverage: new MorningBriefCoverageService({
        meetings: probeMeetings,
        context: probeContext,
        calendar: probeCalendar,
        tasks: probeTasks,
        reflection: probeReflection,
        skill: name => probeSkill(name),
      }),
      dispatchDueTasks,
      reconcileDispatch,
      taskDigest: async () => {
        try { return composeTaskDigest(await listBoard()) } catch { return '' }
      },
    })
    // The ledger row exists before the job does; its number must count.
    unregisterReservations = registerMessageReservationSource(() => instance.liveReservations(currentMessageEra()))
    unregisterTaskReservations = registerMessageReservationSource(() => reservationsForEra(currentMessageEra()))
    scheduler = instance
  }
  return scheduler
}

export function startMorningBriefScheduler(): void {
  getMorningBriefScheduler().start()
}

export function stopMorningBriefScheduler(): void {
  scheduler?.stop()
  unregisterReservations?.()
  unregisterReservations = null
  unregisterTaskReservations?.()
  unregisterTaskReservations = null
}
