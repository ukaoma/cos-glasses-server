/**
 * 6.83.0: the orchestrator's process-wide state, created on first use (importing this module starts nothing).
 * Files live under `data/work-orchestrator/`.
 */
import { stat } from 'node:fs/promises'
import { dataPath } from '../data-dir.js'
import { agentSessionRoots, findAgentSessionFile, type AgentProvider } from '../agent-session-store.js'
import { setUsageEventSink } from './usage-events.js'
import { SnapshotStore, type ControlSnapshot } from './snapshot.js'
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
    // Inside a test the real probes are never reachable: any test that reads usage through this monitor gets an
    // error reading, never a spawned claude or codex CLI (the boot guard below covers the poll; this covers on demand).
    const inTest = !!(process.env.VITEST || process.env.NODE_ENV === 'test')
    const noProbe = async (): Promise<never> => { throw new Error('not probed inside a test') }
    const monitor = usage = new UsageMonitor({ path: dataPath('work-orchestrator', 'usage.json'), ...(inTest ? { probes: { claude: noProbe, codex: noProbe } } : {}) })
    // Jobs report limits and rate-limit frames through the leaf module; this monitor is where they land.
    setUsageEventSink({ limit: (p, message, source) => monitor.noteLimit(p as UsageProvider, message, source), claudeFrame: frame => monitor.noteClaudeRateLimitEvent(frame) })
  }
  return usage
}
export const PLAN_LOG_PATH = () => dataPath('work-orchestrator', 'plans.jsonl')

/**
 * Called once by the server at boot: registers the usage-event sink and schedules a first log scan. Usage is read on
 * demand (a plan input or GET /usage); the 10-minute background poll starts only with `COS_WORK_USAGE_POLL=1`.
 */
export function startWorkOrchestrator(env: NodeJS.ProcessEnv = process.env): void {
  // A test that boots the server must never spawn the real claude or codex CLI, nor scan this Mac's session logs.
  orchestratorUsage() // registers the usage-event sink, so job limits and rate-limit frames are kept from boot
  if (env.VITEST || env.NODE_ENV === 'test') return
  orchestratorUsage().start(env) // opt-in only: a no-op unless COS_WORK_USAGE_POLL=1
  setTimeout(() => { void orchestratorTagIndex().refresh().catch(() => {}) }, 45_000).unref?.()
}

/** How long a plan waits for the log scan before it answers with what the index already holds. */
export const INPUT_SCAN_WAIT_MS = 20_000

/** What one plan input reads. The server passes the process-wide stores; a test passes its own. */
export interface OrchestratorParts { tags: TagIndex; usage: UsageMonitor; snapshot: () => ControlSnapshot | null }

export async function orchestratorInputFor(workID: string, meetingWorkIDs: string[], parts?: OrchestratorParts): Promise<OrchestratorInput> {
  const tags = parts?.tags ?? orchestratorTagIndex()
  const monitor = parts?.usage ?? orchestratorUsage()
  const scan = tags.refresh().catch(() => null)
  const scanned = await Promise.race([scan, new Promise<null>(r => setTimeout(() => r(null), INPUT_SCAN_WAIT_MS).unref?.())])
  // On demand: the plan this input feeds may fork or start a session, so a reading older than 2 minutes is re-read.
  const usageViews = await monitor.forPlan()
  const roots = agentSessionRoots()
  return buildOrchestratorInput(workID, meetingWorkIDs, {
    snapshot: parts ? parts.snapshot() : orchestratorSnapshots().get(),
    hits: tags.hits(),
    usage: usageViews,
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
