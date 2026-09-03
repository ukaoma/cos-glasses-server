import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import {
  fileMemoryOverview,
  fileTierState,
  fileTierStatus,
  hasFileMemory,
  hasFileThreads,
  readFileMemories,
  readFileMemoryById,
  readFileThreadById,
  readFileThreads,
  resolveContextFilesRoot,
} from './context-files.js'

// Optional COS pipeline bridge.
//
// Standalone (default): COS_SCRIPTS_DIR is unset, callPython() resolves to an
// empty/no-op result, and the server runs as glasses + Claude only.
//
// Full pipeline (optional): power users running the COS Starter Kit set
// COS_SCRIPTS_DIR to their `operations/scripts` directory. If a Python venv and
// cos_api_bridge.py are present there, live tasks/calendar/etc. are sourced from
// it. No COS source ships in this package — it shells out to the user's own.

export const COS_SCRIPTS_DIR: string | null = process.env.COS_SCRIPTS_DIR
  ? resolve(process.env.COS_SCRIPTS_DIR)
  : null

/** True when the full COS pipeline directory is configured. */
export const COS_MODE = !!COS_SCRIPTS_DIR

if (!COS_SCRIPTS_DIR) {
  console.log('[COS] Standalone mode — glasses + Claude only (set COS_SCRIPTS_DIR for the full pipeline)')
}

export const PYTHON_BIN: string | null = COS_SCRIPTS_DIR ? resolve(COS_SCRIPTS_DIR, 'venv/bin/python3') : null
const BRIDGE_SCRIPT: string | null = COS_SCRIPTS_DIR ? resolve(COS_SCRIPTS_DIR, 'cos_api_bridge.py') : null

// The optional Python bridge is available only when the user points us at a real
// COS pipeline that ships the venv + bridge script. Standalone installs never
// have these, so callPython() degrades to a no-op.
const pythonAvailable = !!(COS_SCRIPTS_DIR && existsSync(PYTHON_BIN!) && existsSync(BRIDGE_SCRIPT!))

export function pythonBridgeAvailable(): boolean {
  return pythonAvailable
}

export function pythonBridgeState(): 'ready' | 'pipeline_missing' | 'bridge_missing' {
  if (pythonAvailable) return 'ready'
  return COS_SCRIPTS_DIR ? 'bridge_missing' : 'pipeline_missing'
}

/**
 * Which context source can answer a memory/threads request: the Python bridge,
 * plain files, or nothing.
 *
 * The routes gate on THIS rather than on `pythonBridgeAvailable()`, which is what
 * made the file tier unreachable in the first draft — every route returned 503
 * before `callPython` was ever called, so wiring the fallback into the bridge
 * alone changed nothing observable. Bridge first, always: an install with a venv
 * behaves exactly as it did.
 */
export function contextSourceAvailable(): 'bridge' | 'files' | null {
  if (pythonAvailable) return 'bridge'
  return fileTierState(resolveContextFilesRoot()) === 'absent' ? null : 'files'
}

if (pythonAvailable) {
  console.log('[python-bridge] COS pipeline detected — sourcing live context')
} else if (COS_SCRIPTS_DIR) {
  console.log('[python-bridge] COS_SCRIPTS_DIR set but cos_api_bridge.py not found — running without live context')
}

/**
 * Call the optional COS data bridge. Returns live data only when a full COS
 * pipeline is configured; otherwise resolves to an empty/no-op result so the
 * context builder degrades gracefully on a standalone install.
 */
export function callPython(args: string[], timeoutMs = 30_000, input?: string): Promise<unknown> {
  if (pythonAvailable) {
    return callPythonDirect(args, timeoutMs, input)
  }
  return Promise.resolve(standaloneNoop(args))
}

/**
 * No bridge configured. Try the FILE tier first, then fall back to empty shapes.
 *
 * This function is the only door to the file tier, and it is only reached when
 * `pythonAvailable` is false — so an install with a working venv and bridge never
 * executes any of it. That is what makes the file tier backwards compatible by
 * construction rather than by promise: there is no merged resolver to get wrong.
 *
 * A user with a `memory/` or `threads/` folder gets browsable content with no venv,
 * no bridge, and no vector store. When they later build the pipeline, the SAME files
 * become the thing it indexes — nothing to refactor, because the files were always
 * the substrate.
 */
function standaloneNoop(args: string[]): unknown {
  const root = resolveContextFilesRoot()
  switch (args[0]) {
    case 'calendar': return { events: [] }
    case 'tasks': return {}
    case 'threads': {
      if (root && hasFileThreads(root)) {
        const threads = readFileThreads(root, argLimit(args, 30))
        return {
          threads,
          active_count: threads.filter(t => !t.is_resolved).length,
          stale_count: 0,
          resolved_count: threads.filter(t => t.is_resolved).length,
          source: 'files',
        }
      }
      return { threads: [], active_count: 0, stale_count: 0, resolved_count: 0 }
    }
    case 'thread-detail': {
      if (root && hasFileThreads(root)) {
        const hit = readFileThreadById(root, args[1] ?? '')
        if (hit) return hit
      }
      return { error: 'cos_pipeline_not_configured' }
    }
    case 'context-status': {
      const bridgeState = pythonBridgeState()
      const tier = fileTierState(root)
      // 'files' is a real, working configuration — not a degraded bridge. Reporting
      // it as unavailable is what made the G2 render "Unavailable." for a user who
      // had perfectly readable notes.
      if (tier !== 'absent') {
        const counts = fileTierStatus(root)
        return {
          available: true,
          protocol: 1,
          state: tier,
          source: 'files',
          memory: {
            available: counts.memory.present,
            total: counts.memory.total,
            state: counts.memory.present ? tier : 'absent',
          },
          threads: {
            available: counts.threads.present,
            total: counts.threads.total,
            active: counts.threads.active,
            // Staleness is a computed property of meeting cadence. Nothing
            // computed it for a file thread, so 0 is the truth, not a default.
            stale: 0,
            resolved: counts.threads.resolved,
            state: counts.threads.present ? tier : 'absent',
          },
        }
      }
      return {
        available: false,
        protocol: 1,
        state: bridgeState,
        memory: { available: false, total: 0, state: bridgeState },
        threads: { available: false, total: 0, active: 0, stale: 0, resolved: 0, state: bridgeState },
      }
    }
    case 'memory': {
      if (root && hasFileMemory(root)) return readFileMemories(root, argLimit(args, 30))
      return []
    }
    case 'memory-overview': {
      if (root && hasFileMemory(root)) {
        const o = fileMemoryOverview(root)
        return { available: true, collection: 'files', total: o.total, by_type: o.by_type, source: 'files' }
      }
      return {
        available: false,
        collection: 'cos_memory',
        total: 0,
        by_type: {},
        reason: 'cos_pipeline_not_configured',
      }
    }
    case 'memory-detail': {
      if (root && hasFileMemory(root)) {
        const hit = readFileMemoryById(root, args[1] ?? '')
        if (hit) return hit
      }
      return { error: 'cos_pipeline_not_configured' }
    }
    case 'badges': return {}
    case 'task-rows':
    case 'task-capture':
    case 'task-set-run-at':
    case 'task-set-marker':
    case 'task-move':
    case 'task-check':
      return { error: { code: 'cos_pipeline_not_configured' } }
    default: return {}
  }
}

/** `--limit N` from a bridge-style argv, bounded. */
function argLimit(args: string[], fallback: number): number {
  const i = args.indexOf('--limit')
  if (i === -1) return fallback
  const n = Number(args[i + 1])
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 50) : fallback
}

/** Full Python bridge — requires the user's venv + cos_api_bridge.py. */
function callPythonDirect(args: string[], timeoutMs: number, input?: string): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      PYTHON_BIN!,
      [BRIDGE_SCRIPT!, ...args],
      { cwd: COS_SCRIPTS_DIR!, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr?.trim() || err.message
          if (typeof msg === 'string' && msg.includes('unknown command')) {
            return resolvePromise({ error: { code: 'cos_pipeline_not_configured', message: msg } })
          }
          return reject(new Error(`python-bridge: ${msg}`))
        }
        try {
          resolvePromise(JSON.parse(stdout))
        } catch {
          reject(new Error(`python-bridge: invalid JSON output`))
        }
      }
    )
    if (input != null) {
      child.stdin?.write(input)
      child.stdin?.end()
    }
  })
}
