// 6.83.0: a plan-lane provider limit marks that provider exhausted for the orchestrator; a key-lane one never does (Q2).
import { expect, it } from 'vitest'
import { noteJobProviderLimit, orchestratorUsage } from './runtime.js'

it('marks a plan-lane provider_limit exhausted, and ignores key lanes, key profiles and other failures', () => {
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
