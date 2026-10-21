// 6.82.0 Routines: one list for every routine on this server. Routine #1 is the morning brief,
// served by its own scheduler with its settings and behaviour unchanged (morning-brief-golden.test.ts);
// routine #2 onward are skill routines (routines-scheduler.ts). Every surface (the phone, COS Control,
// curl) lists, edits, pauses and runs both through /api/routines, and the morning brief keeps its
// own /api/morning-brief route for the surfaces that already use it.

import { MORNING_BRIEF_LIMITS, MorningBriefConfigError } from './morning-brief-config.js'
import { MORNING_BRIEF_ROUTINE_ID, MorningBriefRunError, type MorningBriefRunView, type MorningBriefScheduler } from './morning-brief-scheduler.js'
import { ROUTINE_DEFAULT_MODEL, ROUTINE_LIMITS, RoutineConfigError } from './routines-config.js'
import { RoutineRunError, type RoutineGate, type RoutineScheduler, type SkillRoutineView } from './routines-scheduler.js'

export interface MorningBriefRoutineView {
  id: typeof MORNING_BRIEF_ROUTINE_ID
  kind: 'morning-brief'
  name: string
  enabled: boolean
  time: string
  timezone: string
  days: number[]
  model: string | null
  effort: string | null
  nextRunAt: string | null
  gate: RoutineGate
  /** The brief's own stops, in the shape every routine row shows. */
  limits: { scheduledPerDay: 1; runNowPerDay: number; submitAttemptsPerDay: number }
  /** Sources on, in order, for the row's second line. Full settings stay on /api/morning-brief. */
  sourcesOn: string[]
  lastRun: MorningBriefRunView | null
  updatedAt: string
}

export type RoutineListEntry = MorningBriefRoutineView | (SkillRoutineView & { model: string })

export interface RoutinesEnvelope {
  protocolVersion: 1
  /** COS_ROUTINES: off stops every skill routine (the brief has its own switch). */
  masterSwitch: boolean
  limits: { maxRoutines: number; dailyCapMax: number; globalRunsPerDay: number; defaultModel: string }
  routines: RoutineListEntry[]
}

/** A body or a call the registry refuses, with the HTTP status the route sends. */
export class RoutineRegistryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RoutineRegistryError'
  }
}

function mapError(error: unknown): never {
  if (error instanceof RoutineRegistryError) throw error
  if (error instanceof RoutineConfigError) throw new RoutineRegistryError(error.status, error.code, error.message)
  if (error instanceof MorningBriefConfigError) throw new RoutineRegistryError(400, error.code, error.message)
  if (error instanceof RoutineRunError) throw new RoutineRegistryError(error.status, error.code, error.message, error.detail)
  if (error instanceof MorningBriefRunError) throw new RoutineRegistryError(error.status, error.code, error.message)
  throw error
}

/** Fields a routine edit may carry for the brief. Anything else on the brief is refused, not ignored. */
const BRIEF_FIELDS = new Set(['enabled', 'time', 'timezone', 'days', 'model', 'effort', 'catchUpMinutes', 'sources', 'closingInstruction'])

export class RoutineRegistry {
  constructor(private readonly brief: () => MorningBriefScheduler, private readonly skills: () => RoutineScheduler) {}

  private async briefView(): Promise<MorningBriefRoutineView> {
    const scheduler = this.brief()
    const config = scheduler.getConfig()
    const status = await scheduler.status()
    const gate: RoutineGate = status.gate === 'durable_jobs_off' || status.gate === 'admissions_closed' || status.gate === 'disabled' ? status.gate : 'ready'
    return {
      id: MORNING_BRIEF_ROUTINE_ID,
      kind: 'morning-brief',
      name: 'Morning brief',
      enabled: config.enabled,
      time: config.time,
      timezone: config.timezone,
      days: [...config.days],
      model: config.model ?? null,
      effort: config.effort ?? null,
      nextRunAt: status.nextRunAt,
      gate,
      limits: { scheduledPerDay: 1, runNowPerDay: MORNING_BRIEF_LIMITS.manualRunsPerDay, submitAttemptsPerDay: MORNING_BRIEF_LIMITS.scheduledAttemptsPerDay },
      sourcesOn: config.sources.filter(source => source.enabled).map(source => source.id),
      lastRun: status.lastRun,
      updatedAt: config.updatedAt,
    }
  }

  async list(): Promise<RoutinesEnvelope> {
    const skills = this.skills()
    return {
      protocolVersion: 1,
      masterSwitch: skills.masterSwitchOn(),
      limits: { maxRoutines: ROUTINE_LIMITS.maxRoutines, dailyCapMax: ROUTINE_LIMITS.dailyCapMax, globalRunsPerDay: ROUTINE_LIMITS.globalRunsPerDay, defaultModel: ROUTINE_DEFAULT_MODEL },
      routines: [await this.briefView(), ...await skills.views()],
    }
  }

  async get(id: string): Promise<RoutineListEntry> {
    try {
      return id === MORNING_BRIEF_ROUTINE_ID ? await this.briefView() : await this.skills().get(id)
    } catch (error) { return mapError(error) }
  }

  async create(body: unknown): Promise<RoutineListEntry> {
    try {
      const created = await this.skills().create(body)
      return this.skills().get(created.id)
    } catch (error) { return mapError(error) }
  }

  async update(id: string, body: unknown): Promise<RoutineListEntry> {
    try {
      if (id === MORNING_BRIEF_ROUTINE_ID) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RoutineRegistryError(400, 'invalid_patch', 'Expected a JSON object.')
        const extra = Object.keys(body).filter(key => !BRIEF_FIELDS.has(key))
        if (extra.length) throw new RoutineRegistryError(400, 'not_a_brief_field', `The morning brief does not take ${extra.join(', ')}. Its sources and options are on /api/morning-brief.`)
        this.brief().updateConfig(body)
        return this.briefView()
      }
      await this.skills().update(id, body)
      return this.skills().get(id)
    } catch (error) { return mapError(error) }
  }

  setEnabled(id: string, enabled: boolean): Promise<RoutineListEntry> {
    return this.update(id, { enabled })
  }

  async remove(id: string): Promise<void> {
    try {
      if (id === MORNING_BRIEF_ROUTINE_ID) throw new RoutineRegistryError(409, 'cannot_delete_brief', 'The morning brief cannot be deleted. Turn it off instead.')
      await this.skills().remove(id)
    } catch (error) { return mapError(error) }
  }

  async runNow(id: string): Promise<Record<string, unknown>> {
    try {
      const run = id === MORNING_BRIEF_ROUTINE_ID ? await this.brief().runNow() : await this.skills().runNow(id)
      return { ...run }
    } catch (error) { return mapError(error) }
  }

  async runs(id: string | undefined, limit: number): Promise<unknown[]> {
    try {
      if (id === MORNING_BRIEF_ROUTINE_ID) return await this.brief().listRuns(limit)
      if (id) await this.skills().get(id)
      return await this.skills().listRuns(id, limit)
    } catch (error) { return mapError(error) }
  }
}
