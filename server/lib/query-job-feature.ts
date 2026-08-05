import { QUERY_JOB_PROTOCOL_VERSION } from './query-job-types.js'

/**
 * Durable jobs are the public default. COS_DURABLE_QUERY_JOBS=0 is the
 * machine-wide rollback; every other value (including unset) keeps the
 * capability available. COS Control owns the user-facing policy switch.
 */
export function durableQueryJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_DURABLE_QUERY_JOBS !== '0'
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
