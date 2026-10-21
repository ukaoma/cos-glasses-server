// 6.83.0: a plan-lane provider limit marks that provider exhausted for the orchestrator; a key-lane one never does (Q2).
import { expect, it } from 'vitest'
import { orchestratorUsage, startWorkOrchestrator } from './runtime.js'
import { noteJobProviderLimit } from './usage-events.js'

it('marks a plan-lane provider_limit exhausted (once the runtime is up), and ignores key lanes, key profiles and other failures', () => {
  orchestratorUsage()
  const state = () => orchestratorUsage().views().find(v => v.provider === 'codex')!.state
  const before = state()
  noteJobProviderLimit('codex', 'provider_limit', 'usage limit', 'gpt-5', { lane: 'key' })
  noteJobProviderLimit('codex', 'provider_limit', 'usage limit', 'profile:openrouter-1', undefined)
  noteJobProviderLimit('codex', 'query_job_failed', 'usage limit', 'gpt-5', undefined)
  noteJobProviderLimit('ollama', 'provider_limit', 'usage limit', 'llama', undefined)
  expect(state()).toBe(before)
  noteJobProviderLimit('codex', 'provider_limit', "You've hit your usage limit. Try again in 45 minutes", 'gpt-5', undefined)
  expect(orchestratorUsage().views().find(v => v.provider === 'codex')).toMatchObject({ state: 'exhausted', source: 'provider_limit' })
})

it('a server booted by a test starts no usage poll and no log scan, even with the poll opted in', () => {
  try {
    startWorkOrchestrator({ VITEST: 'true', COS_WORK_USAGE_POLL: '1' })
    expect((orchestratorUsage() as any).timer).toBeNull()
  } finally { orchestratorUsage().stop() }
})

it('inside a test, the process-wide monitor never spawns the real claude or codex CLI', async () => {
  await orchestratorUsage().refresh('claude')
  expect(orchestratorUsage().entry('claude')).toMatchObject({ source: 'none', lastError: 'not probed inside a test' })
})
