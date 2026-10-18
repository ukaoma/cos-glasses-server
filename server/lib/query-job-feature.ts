import { QUERY_JOB_PROTOCOL_VERSION } from './query-job-types.js'

/**
 * Durable jobs are the public default. COS_DURABLE_QUERY_JOBS=0 is the
 * machine-wide rollback; every other value (including unset) keeps the
 * capability available. COS Control owns the user-facing policy switch.
 */
export function durableQueryJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_DURABLE_QUERY_JOBS !== '0'
}

/**
 * The Messages trail (6.52.0) is on by default. COS_MESSAGES_TRAIL=0 is the rollback
 * that needs no downgrade: the job runner then hands the bridges no trail callback, so
 * no second stdout reader is attached, no `trail` event is journaled, and every stream,
 * snapshot and answer is exactly the 6.51.0 one. Read per job, so a restart applies it.
 */
export function messagesTrailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_MESSAGES_TRAIL !== '0'
}

/**
 * 6.78.0 switches read the tri-state of MVP-C (COS_CRASH_LOOP_PARKING): `1`, `true` or `on`
 * force a switch on, `0`, `false` or `off` force it off, and anything else (unset included)
 * is its DEFAULT. Read at call time, so a restart applies a change.
 */
function triState(raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '1' || value === 'true' || value === 'on') return true
  if (value === '0' || value === 'false' || value === 'off') return false
  return fallback
}

/**
 * 6.78.0 restart truth, default ON. An Ask a restart cut off (crash then boot, or a graceful
 * shutdown) carries `error.cause` and an `interruption` record naming the step it was cut off
 * during and the side-effect steps already done; a crash-loop-parked one carries its
 * `interruption` too. Off is the MVP-C build exactly: the boot path's old message, the raw
 * `server_shutdown` message on a graceful shutdown, and no `interruption` anywhere.
 */
export function restartNoticeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return triState(env.COS_RESTART_NOTICE, true)
}

/**
 * 6.78.0 (MVP-D release 1): the delta-only chunk WRITER, default OFF. The reader is always
 * on, so a journal a writer-on build wrote reads back whole on this build and on every later
 * one. The writer ships on by default one release after its reader.
 */
export function queryJobDeltaJournalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return triState(env.COS_QUERY_JOB_DELTA_JOURNAL, false)
}

export function durableQueryJobsCapability(): {
  enabled: boolean
  protocolVersion: number
} {
  return {
    enabled: durableQueryJobsEnabled(),
    protocolVersion: QUERY_JOB_PROTOCOL_VERSION,
  }
}
