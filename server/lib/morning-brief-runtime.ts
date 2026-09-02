// Morning brief — the one production scheduler, wired to the real coordinator.
//
// Mirrors query-job-runtime.ts: the module owns the singleton so the router,
// health, and index.ts all see the same instance, and tests construct their
// own MorningBriefScheduler with fake deps instead of importing this file.

import { getActiveSessions, createSession } from './conversation.js'
import { currentMessageEra, exchangeBelongsToEra } from './message-era.js'
import { maxGlobalMsgNumInDir } from '../routes/message-ref.js'
import { dataPath } from './data-dir.js'
import { getOwnerName } from './profile.js'
import { durableQueryJobsEnabled } from './query-job-feature.js'
import { queryJobCoordinator } from './query-job-runtime.js'
import { maintenanceAdmissionsOpen } from './maintenance-lifecycle.js'
import { morningBriefPaths } from './morning-brief-config.js'
import { MorningBriefScheduler } from './morning-brief-scheduler.js'

/** Highest stamped message number in the active era: live sessions plus the
 * day archives. The same arithmetic /api/message-counter serves the phone. */
export function currentMessageMax(): number {
  const era = currentMessageEra()
  let liveMax = 0
  for (const session of getActiveSessions()) {
    for (const exchange of (session as { exchanges?: Array<{ globalMsgNum?: unknown; messageEra?: unknown }> }).exchanges ?? []) {
      if (!exchangeBelongsToEra(exchange, era)) continue
      if (typeof exchange?.globalMsgNum === 'number' && exchange.globalMsgNum > liveMax) liveMax = exchange.globalMsgNum
    }
  }
  return Math.max(liveMax, maxGlobalMsgNumInDir(dataPath('archive'), era))
}

let scheduler: MorningBriefScheduler | null = null

export function getMorningBriefScheduler(): MorningBriefScheduler {
  if (!scheduler) {
    scheduler = new MorningBriefScheduler({
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
    })
  }
  return scheduler
}

export function startMorningBriefScheduler(): void {
  getMorningBriefScheduler().start()
}

export function stopMorningBriefScheduler(): void {
  scheduler?.stop()
}
