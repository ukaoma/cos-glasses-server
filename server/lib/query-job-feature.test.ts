import { describe, expect, it } from 'vitest'
import { durableQueryJobsCapability, durableQueryJobsEnabled } from './query-job-feature.js'

describe('durable query feature gate', () => {
  it('fails closed unless the value is exactly 1', () => {
    expect(durableQueryJobsEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(durableQueryJobsEnabled({ COS_DURABLE_QUERY_JOBS: 'true' } as NodeJS.ProcessEnv)).toBe(false)
    expect(durableQueryJobsEnabled({ COS_DURABLE_QUERY_JOBS: '0' } as NodeJS.ProcessEnv)).toBe(false)
    expect(durableQueryJobsEnabled({ COS_DURABLE_QUERY_JOBS: '1' } as NodeJS.ProcessEnv)).toBe(true)
  })

  it('advertises a versioned capability without silently enabling it', () => {
    const prior = process.env.COS_DURABLE_QUERY_JOBS
    delete process.env.COS_DURABLE_QUERY_JOBS
    try {
      expect(durableQueryJobsCapability()).toEqual({ enabled: false, protocolVersion: 1 })
      process.env.COS_DURABLE_QUERY_JOBS = '1'
      expect(durableQueryJobsCapability()).toEqual({ enabled: true, protocolVersion: 1 })
    } finally {
      if (prior == null) delete process.env.COS_DURABLE_QUERY_JOBS
      else process.env.COS_DURABLE_QUERY_JOBS = prior
    }
  })
})
