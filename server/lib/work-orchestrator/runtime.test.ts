import { expect, it, vi } from 'vitest'
import { orchestratorInputFor, type OrchestratorParts } from './runtime.js'
import { UsageMonitor, type UsageReading } from './usage.js'
import { readAskWorkPlanInput } from '../../routes/ask-work-plan.js'

const workID = 'task:quilt:aaaaaaaaaaaa'
function fixture() {
  const reading: UsageReading = { plan: 'test', available: true, allowed: true,
    windows: [{ kind: 'session', usedPct: 10, resetsAt: null }] }
  const claude = vi.fn(async () => reading), codex = vi.fn(async () => reading)
  // Real monitor with fake probes: the tested runtime branch decides whether any probe runs.
  const usage = new UsageMonitor({ probes: { claude, codex }, now: () => 1_000_000, pollEnabled: false })
  const forPlan = vi.spyOn(usage, 'forPlan'), views = vi.spyOn(usage, 'views')
  const tags = { refresh: vi.fn(async () => ({ complete: true })), hits: () => [], skippedSessions: () => new Set<string>(),
    pathOf: () => null } as unknown as OrchestratorParts['tags']
  return { parts: { tags, usage, snapshot: () => null } satisfies OrchestratorParts, claude, codex, forPlan, views }
}

it('cached runtime input reads views without invoking forPlan or either provider probe', async () => {
  const f = fixture()
  const result = await orchestratorInputFor(workID, [], f.parts, { usageMode: 'cached' })
  expect(result).toMatchObject({ workID, rows: [], logScanComplete: true })
  expect(result.usage.map(u => u.state)).toEqual(['unknown', 'unknown', 'unknown'])
  expect(f.views).toHaveBeenCalledOnce(); expect(f.forPlan).not.toHaveBeenCalled()
  expect(f.claude).not.toHaveBeenCalled(); expect(f.codex).not.toHaveBeenCalled()
})
it('default runtime input retains the existing on-demand Work usage refresh', async () => {
  const f = fixture()
  const result = await orchestratorInputFor(workID, [], f.parts)
  expect(f.forPlan).toHaveBeenCalledOnce(); expect(f.claude).toHaveBeenCalledOnce(); expect(f.codex).toHaveBeenCalledOnce()
  expect(result.usage.find(u => u.provider === 'claude')).toMatchObject({ state: 'ok', source: 'probe' })
})
it('the Ask default wrapper selects cached mode on the actual runtime, without probes', async () => {
  const f = fixture()
  const result = await readAskWorkPlanInput(workID, [], f.parts)
  expect(result.usage).toHaveLength(3)
  expect(f.views).toHaveBeenCalledOnce(); expect(f.forPlan).not.toHaveBeenCalled()
  expect(f.claude).not.toHaveBeenCalled(); expect(f.codex).not.toHaveBeenCalled()
})
