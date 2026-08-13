// Archive live sessions, then start short-numbering at #1.
// History is retained in day archives; only the current era's ceiling resets.
// Disk mtime on message-era.json is enough — the live server re-reads it.
// Do not rotate the era if a query is in flight or an archive write fails.

import { endSession, getActiveSessions } from './conversation.js'
import {
  createMessageEra,
  currentMessageEraState,
  type MessageEraState,
} from './message-era.js'
import type { SessionToArchive } from './archive.js'

export class MessageEraResetError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'MessageEraResetError'
    this.code = code
    this.status = status
  }
}

export interface MessageEraResetResult {
  ok: true
  era: string
  previousEra: string
  archived: number
  max: 0
  startedAt: number
}

export interface MessageEraResetInput {
  confirm: boolean
  now?: number
  activeRuns?: number
  shuttingDown?: boolean
  sessions?: SessionToArchive[]
  archiveAndRelease?: (session: SessionToArchive) => Promise<boolean>
}

async function resolveJobHealth(input: MessageEraResetInput): Promise<{ activeRuns: number; shuttingDown: boolean }> {
  if (input.activeRuns != null || input.shuttingDown != null) {
    return {
      activeRuns: input.activeRuns ?? 0,
      shuttingDown: input.shuttingDown ?? false,
    }
  }
  const { queryJobCoordinator } = await import('./query-job-runtime.js')
  const health = queryJobCoordinator.getHealth()
  return { activeRuns: health.activeRuns, shuttingDown: health.shuttingDown }
}

export async function resetLiveMessageEra(input: MessageEraResetInput): Promise<MessageEraResetResult> {
  if (input.confirm !== true) {
    throw new MessageEraResetError(
      'confirmation_required',
      'confirmation required',
      400,
    )
  }

  const jobs = await resolveJobHealth(input)
  if (jobs.activeRuns > 0) {
    throw new MessageEraResetError(
      'query_in_flight',
      'A query is still running. Wait for it to finish, then reset.',
      409,
    )
  }
  if (jobs.shuttingDown) {
    throw new MessageEraResetError(
      'server_shutting_down',
      'Server is shutting down. Try again after it is healthy.',
      409,
    )
  }

  const previous = currentMessageEraState()
  const sessions = input.sessions ?? getActiveSessions()
  const archiveAndRelease = input.archiveAndRelease ?? (async (session: SessionToArchive) => {
    const result = await endSession(session.id)
    if (!result) return true
    if (result.exchangeCount > 0 && !result.logged) return false
    return true
  })

  let archived = 0
  for (const session of sessions) {
    const released = await archiveAndRelease(session)
    if (!released) {
      throw new MessageEraResetError(
        'archive_failed',
        'Archive failed; message count was not reset.',
        503,
      )
    }
    archived++
  }

  const next: MessageEraState = createMessageEra(input.now ?? Date.now())
  return {
    ok: true,
    era: next.era,
    previousEra: previous.era,
    archived,
    max: 0,
    startedAt: next.startedAt,
  }
}
