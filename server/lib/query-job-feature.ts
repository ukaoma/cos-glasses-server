import { QUERY_JOB_PROTOCOL_VERSION } from './query-job-types.js'

/**
 * Durable jobs ship dark. The private canary enables them explicitly with
 * COS_DURABLE_QUERY_JOBS=1; removing the flag is an immediate server-side
 * rollback that leaves the legacy /api/query path untouched.
 */
export function durableQueryJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_DURABLE_QUERY_JOBS === '1'
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
