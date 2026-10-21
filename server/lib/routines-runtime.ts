// 6.82.0 Routines: the production singletons, wired to the real coordinator.
// Mirrors morning-brief-runtime.ts; tests construct their own RoutineScheduler with fake deps.

import { createSession } from './conversation.js'
import { currentMessageEra } from './message-era.js'
import { getOwnerName } from './profile.js'
import { durableQueryJobsEnabled } from './query-job-feature.js'
import { queryJobCoordinator } from './query-job-runtime.js'
import { maintenanceAdmissionsOpen } from './maintenance-lifecycle.js'
import { registerMessageReservationSource } from './message-reservations.js'
import { currentMessageMax, getMorningBriefScheduler } from './morning-brief-runtime.js'
import { routinePaths } from './routines-config.js'
import { RoutineRegistry } from './routines-registry.js'
import { RoutineScheduler } from './routines-scheduler.js'
import { listWorkspaceSkills, type WorkspaceSkill } from './workspace-skills.js'

/** The skills a routine may run: this COS workspace's own (`.agents/skills`, `.claude/skills`). */
export function routineSkillCatalog(): WorkspaceSkill[] {
  return listWorkspaceSkills().filter(skill => skill.where === 'workspace')
}

export function routineSkillExists(name: string): boolean {
  return routineSkillCatalog().some(skill => skill.name === name)
}

let scheduler: RoutineScheduler | null = null
let registry: RoutineRegistry | null = null
let unregister: (() => void) | null = null

export function getRoutineScheduler(): RoutineScheduler {
  if (!scheduler) {
    const instance = new RoutineScheduler({
      paths: routinePaths(),
      submit: raw => queryJobCoordinator.submit(raw),
      findByClientGeneration: (clientJobId, generation) => queryJobCoordinator.getByClientGeneration(clientJobId, generation),
      getSnapshot: jobId => queryJobCoordinator.getSnapshot(jobId),
      createSession,
      currentMessageEra,
      currentMessageMax,
      ownerName: getOwnerName,
      durableJobsEnabled: durableQueryJobsEnabled,
      admissionsOpen: maintenanceAdmissionsOpen,
      skillExists: routineSkillExists,
    })
    unregister = registerMessageReservationSource(() => instance.liveReservations(currentMessageEra()))
    scheduler = instance
  }
  return scheduler
}

export function getRoutineRegistry(): RoutineRegistry {
  if (!registry) registry = new RoutineRegistry(getMorningBriefScheduler, getRoutineScheduler)
  return registry
}

export function startRoutineScheduler(): void {
  getRoutineScheduler().start()
}

export function stopRoutineScheduler(): void {
  scheduler?.stop()
  unregister?.()
  unregister = null
}
