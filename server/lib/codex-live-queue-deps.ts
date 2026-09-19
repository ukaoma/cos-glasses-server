// The real world behind `codex-live-queue.ts`: the binary, the process, the counters.
//
// Kept apart from the pure module so the verdict rules there never touch a process.
// Nothing here writes a file; the only write is the one `codex queue` makes itself.

import { spawn } from 'node:child_process'
import { resolveProviderBinary } from './provider-binary.js'
import {
  codexLiveQueueEnabled,
  deliverOverCodexQueue,
  type CodexLiveResult,
  type CodexQueueRun,
} from './codex-live-queue.js'

/** Output past this is not a confirmation line; keep memory bounded if the CLI misbehaves. */
const MAX_CAPTURE_BYTES = 64 * 1024

/**
 * Run the CLI with no shell, a closed stdin and a hard timeout. Always resolves.
 *
 * The environment is the server's own, so `CODEX_HOME` (if an operator set one) is the
 * same one occupancy read the writer lock from: the queue row lands in the database the
 * holder is watching.
 */
export function runCodexQueueCli(binary: string, args: readonly string[], timeoutMs: number): Promise<CodexQueueRun> {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (run: CodexQueueRun) => {
      if (settled) return
      settled = true
      resolve(run)
    }
    let child: ReturnType<typeof spawn>
    try {
      // Its own process group, so the ceiling can kill anything it started too: a
      // grandchild holding stdout open would otherwise keep 'close' from ever firing
      // (found by the hang test, which waited out the whole `sleep`).
      child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true })
    } catch (error) {
      finish({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: error instanceof Error ? error.message : 'spawn threw' })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { if (typeof child.pid === 'number') process.kill(-child.pid, 'SIGKILL') } catch { /* group already gone */ }
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      // Answer at the ceiling, not whenever the pipes finally close.
      finish({ code: null, stdout, stderr, timedOut: true, spawnError: null })
    }, Math.max(100, timeoutMs))
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString('utf-8') })
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString('utf-8') })
    child.on('error', error => {
      clearTimeout(timer)
      // ENOENT/EACCES arrive here before any byte ran: nothing was queued.
      finish({ code: null, stdout, stderr, timedOut: false, spawnError: error.message })
    })
    child.on('close', code => {
      clearTimeout(timer)
      finish({ code: timedOut ? null : code, stdout, stderr, timedOut, spawnError: null })
    })
  })
}

export interface CodexLiveStats {
  attempts: number
  delivered: number
  /** By reason, so the health row says WHY a Codex Continue did not go live. */
  fallbacks: Record<string, number>
  lastReason: string | null
  lastAt: number | null
}

const stats: CodexLiveStats = { attempts: 0, delivered: 0, fallbacks: {}, lastReason: null, lastAt: null }

/** For `/api/health`. A copy, never the live object. */
export function codexLiveStats(): CodexLiveStats {
  return { ...stats, fallbacks: { ...stats.fallbacks } }
}

/** Tests only. */
export function __resetCodexLiveStatsForTests(): void {
  stats.attempts = 0
  stats.delivered = 0
  stats.fallbacks = {}
  stats.lastReason = null
  stats.lastAt = null
}

/**
 * The route's Codex dep. `disabled` and `no_holder` are not counted as attempts: the
 * first is the operator's choice and the second is the ordinary spawn path, so neither
 * should make the health row look busy.
 */
export function makeCodexLiveDeliverer(deps?: {
  run?: typeof runCodexQueueCli
  resolveBinary?: () => string | null
  enabled?: () => boolean
}) {
  return async (request: { provider: string; sessionId: string; prompt: string; foreignHolder?: boolean }): Promise<CodexLiveResult> => {
    const result = await deliverOverCodexQueue(
      {
        provider: request.provider,
        sessionId: request.sessionId,
        prompt: request.prompt,
        enabled: (deps?.enabled ?? codexLiveQueueEnabled)(),
        foreignHolder: request.foreignHolder === true,
      },
      {
        resolveBinary: deps?.resolveBinary ?? (() => {
          const resolved = resolveProviderBinary('codex')
          return resolved.ok ? resolved.path : null
        }),
        run: deps?.run ?? runCodexQueueCli,
        now: () => Date.now(),
        log: (level, event, detail) => {
          const line = `[${event}] ${JSON.stringify(detail)}`
          if (level === 'warn') console.warn(line)
          else console.log(line)
        },
      },
    )
    if (result.reason !== 'disabled' && result.reason !== 'no_holder') {
      stats.attempts += 1
      if (result.ok) stats.delivered += 1
      else stats.fallbacks[result.reason] = (stats.fallbacks[result.reason] ?? 0) + 1
      stats.lastReason = result.reason
      stats.lastAt = Date.now()
    }
    return result
  }
}
