import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { durableQueryJobsCapability, durableQueryJobsEnabled, messagesTrailEnabled, queryJobDeltaJournalEnabled, restartNoticeEnabled } from './query-job-feature.js'

describe('durable query feature gate', () => {
  it('defaults on and preserves a literal 0 kill switch', () => {
    expect(durableQueryJobsEnabled({} as NodeJS.ProcessEnv)).toBe(true)
    expect(durableQueryJobsEnabled({ COS_DURABLE_QUERY_JOBS: 'true' } as NodeJS.ProcessEnv)).toBe(true)
    expect(durableQueryJobsEnabled({ COS_DURABLE_QUERY_JOBS: '0' } as NodeJS.ProcessEnv)).toBe(false)
    expect(durableQueryJobsEnabled({ COS_DURABLE_QUERY_JOBS: '1' } as NodeJS.ProcessEnv)).toBe(true)
  })

  it('keeps the Messages trail on by default, with a literal 0 as its rollback', () => {
    expect(messagesTrailEnabled({} as NodeJS.ProcessEnv)).toBe(true)
    expect(messagesTrailEnabled({ COS_MESSAGES_TRAIL: '1' } as NodeJS.ProcessEnv)).toBe(true)
    expect(messagesTrailEnabled({ COS_MESSAGES_TRAIL: 'false' } as NodeJS.ProcessEnv)).toBe(true)
    expect(messagesTrailEnabled({ COS_MESSAGES_TRAIL: '0' } as NodeJS.ProcessEnv)).toBe(false)
  })

  it('6.78.0: the restart notice is on by default; 0, false and off turn it off', () => {
    for (const value of [undefined, '', '1', 'true', 'on', 'yes', 'maybe']) {
      expect(restartNoticeEnabled({ COS_RESTART_NOTICE: value } as NodeJS.ProcessEnv), String(value)).toBe(true)
    }
    for (const value of ['0', 'false', 'off', ' Off ']) {
      expect(restartNoticeEnabled({ COS_RESTART_NOTICE: value } as NodeJS.ProcessEnv), value).toBe(false)
    }
  })

  it('6.78.0: the delta journal writer is off by default; 1, true and on turn it on', () => {
    expect(queryJobDeltaJournalEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(queryJobDeltaJournalEnabled({ COS_QUERY_JOB_DELTA_JOURNAL: 'on' } as NodeJS.ProcessEnv)).toBe(true)
    expect(queryJobDeltaJournalEnabled({ COS_QUERY_JOB_DELTA_JOURNAL: '0' } as NodeJS.ProcessEnv)).toBe(false)
  })

  it('6.78.0: both switches reach a managed server (optionalEnvironment) and are documented in .env.example', () => {
    const contract = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8')) as { optionalEnvironment: string[] }
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')
    for (const key of ['COS_RESTART_NOTICE', 'COS_QUERY_JOB_DELTA_JOURNAL']) {
      expect(contract.optionalEnvironment, key).toContain(key)
      expect(example, key).toMatch(new RegExp(`^# ${key}=`, 'm'))
    }
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
