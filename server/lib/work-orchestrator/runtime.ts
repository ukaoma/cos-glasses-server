/**
 * 6.83.0: the orchestrator's process-wide state, created on first use (importing this module starts nothing).
 * Files live under `data/work-orchestrator/`.
 */
import { stat } from 'node:fs/promises'
import { dataPath } from '../data-dir.js'
import { agentSessionRoots, findAgentSessionFile, type AgentProvider } from '../agent-session-store.js'
import { setUsageEventSink } from './usage-events.js'
import { SnapshotStore } from './snapshot.js'
import { TagIndex } from './tag-index.js'
import { UsageMonitor, type UsageProvider } from './usage.js'
import { buildOrchestratorInput, type OrchestratorInput } from './input.js'

let snapshots: SnapshotStore | null = null
let index: TagIndex | null = null
let usage: UsageMonitor | null = null

export function orchestratorSnapshots(): SnapshotStore { return snapshots ??= new SnapshotStore(dataPath('work-orchestrator', 'control-snapshot.json')) }
export function orchestratorTagIndex(): TagIndex { return index ??= new TagIndex({ roots: agentSessionRoots(), path: dataPath('work-orchestrator', 'tag-index.json') }) }
export function orchestratorUsage(): UsageMonitor {
  if (!usage) {
    const monitor = usage = new UsageMonitor({ path: dataPath('work-orchestrator', 'usage.json') })
    // Jobs report limits and rate-limit frames through the leaf module; this monitor is where they land.
    setUsageEventSink({ limit: (p, message, source) => monitor.noteLimit(p as UsageProvider, message, source), claudeFrame: frame => monitor.noteClaudeRateLimitEvent(frame) })
  }
  return usage
}
export const PLAN_LOG_PATH = () => dataPath('work-orchestrator', 'plans.jsonl')

/** Starts the usage poll (10 min) and a first log scan in the background. Called once by the server at boot. */
export function startWorkOrchestrator(env: NodeJS.ProcessEnv = process.env): void {
  // A test that boots the server must never spawn the real claude or codex CLI, nor scan this Mac's session logs.
  orchestratorUsage() // registers the usage-event sink, so job limits and rate-limit frames are kept from boot
  if (env.VITEST || env.NODE_ENV === 'test') return
  orchestratorUsage().start()
  setTimeout(() => { void orchestratorTagIndex().refresh().catch(() => {}) }, 45_000).unref?.()
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
