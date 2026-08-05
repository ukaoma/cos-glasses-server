import { describe, expect, it } from 'vitest'
import { durableQueryJobsCapability, durableQueryJobsEnabled } from './query-job-feature.js'

describe('durable query feature gate', () => {
  it('defaults on and preserves a literal 0 kill switch', () => {
    expect(durableQueryJobsEnabled({} as NodeJS.ProcessEnv)).toBe(true)
    expect(durableQueryJobsEnabled({ COS_DURABLE_QUERY_JOBS: 'true' } as NodeJS.ProcessEnv)).toBe(true)
    expect(durableQueryJobsEnabled({ COS_DURABLE_QUERY_JOBS: '0' } as NodeJS.ProcessEnv)).toBe(false)
    expect(durableQueryJobsEnabled({ COS_DURABLE_QUERY_JOBS: '1' } as NodeJS.ProcessEnv)).toBe(true)
  })

  it('advertises the default and the explicit rollback truthfully', () => {
    const prior = process.env.COS_DURABLE_QUERY_JOBS
    delete process.env.COS_DURABLE_QUERY_JOBS
    try {
      expect(durableQueryJobsCapability()).toEqual({ enabled: true, protocolVersion: 1 })
      process.env.COS_DURABLE_QUERY_JOBS = '0'
      expect(durableQueryJobsCapability()).toEqual({ enabled: false, protocolVersion: 1 })
    } finally {
      if (prior == null) delete process.env.COS_DURABLE_QUERY_JOBS
      else process.env.COS_DURABLE_QUERY_JOBS = prior
    }
  })
})
