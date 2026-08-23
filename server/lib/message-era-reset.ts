// Rotate the short-number namespace. Live sessions are NOT ended and nothing
// is archived here: the companion keeps every card, so the reset is a numbering
// change rather than a history change.
//
// Do not rotate the era if a query is in flight.
//
// NOTE: this file deliberately imports nothing from ./conversation.js. Importing
// it runs its module scope -- loadFromDisk() and a boot runDailyArchiveMirror()
// -- which in the one-shot CLI means a second process concurrently loading and
// rewriting the same archives the live server owns. appendToArchive appends
// rather than upserts, so that duplicates prior-day chats.
//
// Today's exchanges are NOT archived by this path. The daily mirror skips
// today by design (conversation.ts: `sessionDay >= todayLocal`), so a same-day
// copy exists only after an explicit session end or POST /api/archive/now.
import {
  createMessageEra,
  currentMessageEraState,
  type MessageEraState,
} from './message-era.js'

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

  // 6.36.19 — rotate the era, do NOT end the thread.
  //
  // This used to endSession() every live session before rotating, which is what
  // made "reset the message count" also empty CHAT and kill the conversation the
  // wearer was in the middle of. Miles wants the opposite shape: the next message
  // is #1, the old cards keep their numbers, and the thread survives.
  //
  // Numbers stay unique because they are {messageEra, globalMsgNum}, not a bare
  // int: the era rotates, the current-era ceiling restarts at 0, and leftover
  // cards keep their old era. Lookup already prefers the current era
  // (message-ref.ts:231-234) and the counter is already era-scoped
  // (message-ref.ts:242-251), so nothing downstream needs to change to keep
  // "message N" unambiguous.
  //
  // `archived` stays in the result and is now always 0. Control and the app read
  // it, so removing the field would break them; the copy that reports it has to
  // stop claiming sessions were archived.
  //
  // Deliberately no archive step here. There is nothing to release, so there is
  // no 503 archive_failed path any more — that failure mode is gone rather than
  // relocated. The day-archive mirror already retains history.
  const archived = 0

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
