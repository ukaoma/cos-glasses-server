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

export function durableQueryJobsCapability(): {
  enabled: boolean
  protocolVersion: number
} {
  return {
    enabled: durableQueryJobsEnabled(),
    protocolVersion: QUERY_JOB_PROTOCOL_VERSION,
  }
}
