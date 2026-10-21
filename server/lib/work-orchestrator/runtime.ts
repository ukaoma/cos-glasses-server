/**
 * 6.83.0: the orchestrator's process-wide state, created on first use (importing this module starts nothing).
 * Files live under `data/work-orchestrator/`.
 */
import { stat } from 'node:fs/promises'
import { dataPath } from '../data-dir.js'
import { agentSessionRoots, findAgentSessionFile, type AgentProvider } from '../agent-session-store.js'
import { isProfilePreference } from '../../../shared/key-preference.js'
import { SnapshotStore } from './snapshot.js'
import { TagIndex } from './tag-index.js'
import { UsageMonitor, type UsageProvider } from './usage.js'
import { buildOrchestratorInput, type OrchestratorInput } from './input.js'

let snapshots: SnapshotStore | null = null
let index: TagIndex | null = null
let usage: UsageMonitor | null = null

export function orchestratorSnapshots(): SnapshotStore { return snapshots ??= new SnapshotStore(dataPath('work-orchestrator', 'control-snapshot.json')) }
export function orchestratorTagIndex(): TagIndex { return index ??= new TagIndex({ roots: agentSessionRoots(), path: dataPath('work-orchestrator', 'tag-index.json') }) }
export function orchestratorUsage(): UsageMonitor { return usage ??= new UsageMonitor({ path: dataPath('work-orchestrator', 'usage.json') }) }
export const PLAN_LOG_PATH = () => dataPath('work-orchestrator', 'plans.jsonl')

/** Starts the usage poll (10 min) and a first log scan in the background. Called once by the server at boot. */
export function startWorkOrchestrator(env: NodeJS.ProcessEnv = process.env): void {
  // A test that boots the server must never spawn the real claude or codex CLI, nor scan this Mac's session logs.
  if (env.VITEST || env.NODE_ENV === 'test') return
  orchestratorUsage().start()
  setTimeout(() => { void orchestratorTagIndex().refresh().catch(() => {}) }, 45_000).unref?.()
}

/**
 * A plan-lane job failed with the provider's limit text (code `provider_limit`). A key-lane job never reaches here:
 * its limit is the key's, not the plan's (Q2).
 */
export function noteJobProviderLimit(provider: string | undefined, code: string, message: string, model: unknown, lane: unknown): void {
  try {
    if (code !== 'provider_limit' || lane || isProfilePreference(model)) return
    if (provider !== 'claude' && provider !== 'codex' && provider !== 'cursor') return
    orchestratorUsage().noteLimit(provider as UsageProvider, message, 'provider_limit')
  } catch { /* observation only */ }
}

/** A `rate_limit_event` frame from a plan-lane Claude job. */
export function noteClaudeRateLimitFrame(frame: unknown): void {
  try { orchestratorUsage().noteClaudeRateLimitEvent(frame) } catch { /* observation only */ }
}

/** How long a plan waits for the log scan before it answers with what the index already holds. */
export const INPUT_SCAN_WAIT_MS = 20_000

export async function orchestratorInputFor(workID: string, meetingWorkIDs: string[]): Promise<OrchestratorInput> {
  const tags = orchestratorTagIndex()
  const scan = tags.refresh().catch(() => null)
  const scanned = await Promise.race([scan, new Promise<null>(r => setTimeout(() => r(null), INPUT_SCAN_WAIT_MS).unref?.())])
  await orchestratorUsage().ensureFresh()
  const roots = agentSessionRoots()
  return buildOrchestratorInput(workID, meetingWorkIDs, {
    snapshot: orchestratorSnapshots().get(),
    hits: tags.hits(),
    usage: orchestratorUsage().views(),
    skipped: tags.skippedSessions(),
    logScanComplete: !!scanned?.complete,
    pathOf: async sid => {
      const known = tags.pathOf(sid)
      if (known) return known
      const [provider, id] = sid.split(':') as [AgentProvider, string]
      return findAgentSessionFile(provider, id, roots)
    },
    mtimeOf: async path => (await stat(path)).mtimeMs,
  })
}
