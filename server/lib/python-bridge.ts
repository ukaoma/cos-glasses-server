import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

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
export function callPython(args: string[], timeoutMs = 30_000): Promise<unknown> {
  if (pythonAvailable) {
    return callPythonDirect(args, timeoutMs)
  }
  return Promise.resolve(standaloneNoop(args))
}

/** Empty shapes that the context builder tolerates (no crash, no live data). */
function standaloneNoop(args: string[]): unknown {
  switch (args[0]) {
    case 'calendar': return { events: [] }
    case 'tasks': return {}
    case 'threads': return { threads: [], active_count: 0, stale_count: 0, resolved_count: 0 }
    case 'thread-detail': return { error: 'cos_pipeline_not_configured' }
    case 'context-status': {
      const state = pythonBridgeState()
      return {
        available: false,
        protocol: 1,
        state,
        memory: { available: false, total: 0, state },
        threads: { available: false, total: 0, active: 0, stale: 0, resolved: 0, state },
      }
    }
    case 'memory': return []
    case 'memory-overview': return {
      available: false,
      collection: 'cos_memory',
      total: 0,
      by_type: {},
      reason: 'cos_pipeline_not_configured',
    }
    case 'memory-detail': return { error: 'cos_pipeline_not_configured' }
    case 'badges': return {}
    default: return {}
  }
}

/** Full Python bridge — requires the user's venv + cos_api_bridge.py. */
function callPythonDirect(args: string[], timeoutMs: number): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      PYTHON_BIN!,
      [BRIDGE_SCRIPT!, ...args],
      { cwd: COS_SCRIPTS_DIR!, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr?.trim() || err.message
          return reject(new Error(`python-bridge: ${msg}`))
        }
        try {
          resolvePromise(JSON.parse(stdout))
        } catch {
          reject(new Error(`python-bridge: invalid JSON output`))
        }
      }
    )
  })
}
