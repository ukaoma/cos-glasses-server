import type { ChildProcess } from 'node:child_process'

export interface ProviderTerminationResult {
  closed: boolean
  escalated: boolean
  code: number | null
  signal: NodeJS.Signals | null
}

interface ProviderTerminationOptions {
  termGraceMs?: number
  killWaitMs?: number
}

/** A detached provider's process group can outlive its CLI leader. ESRCH is
 * the only proof that no member remains; EPERM and unknown probe failures are
 * treated as alive so lifecycle ownership fails closed. */
function providerGroupAlive(pid: number | undefined): boolean {
  if (!pid || process.platform === 'win32') return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error: any) {
    return error?.code !== 'ESRCH'
  }
}

/** Signal the detached provider process group so tool subprocesses cannot be
 * orphaned behind the CLI wrapper. Direct-child signaling is a safe fallback
 * for a process that failed before its process group was established. */
function signalProviderTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid
  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // Fall through to the direct child. close/error remains authoritative.
    }
  }
  try { proc.kill(signal) } catch { /* process already terminal */ }
}

/**
 * Terminate provider work and resolve only after Node observes leader close
 * and the detached process group no longer exists.
 * A caller must retain its maintenance lease when `closed` is false: releasing
 * without a close event could let Control restart while a tool is still alive.
 */
export function terminateProviderProcess(
  proc: ChildProcess,
  options: ProviderTerminationOptions = {},
): Promise<ProviderTerminationResult> {
  const termGraceMs = Math.max(10, options.termGraceMs ?? 2_000)
  const killWaitMs = Math.max(10, options.killWaitMs ?? 2_000)
  const groupPid = proc.pid
  const initiallyClosed = proc.exitCode !== null || proc.signalCode !== null

  if (initiallyClosed && !providerGroupAlive(groupPid)) {
    return Promise.resolve({
      closed: true,
      escalated: false,
      code: proc.exitCode,
      signal: proc.signalCode,
    })
  }

  return new Promise(resolve => {
    let settled = false
    let escalated = false
    let leaderClosed = initiallyClosed
    let leaderCode = proc.exitCode
    let leaderSignal = proc.signalCode
    let escalationTimer: ReturnType<typeof setTimeout> | undefined
    let terminalTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (result: ProviderTerminationResult) => {
      if (settled) return
      settled = true
      if (escalationTimer) clearTimeout(escalationTimer)
      if (terminalTimer) clearTimeout(terminalTimer)
      proc.removeListener('close', onClose)
      proc.removeListener('error', onError)
      resolve(result)
    }
    const finishIfTreeClosed = (): boolean => {
      if (!leaderClosed || providerGroupAlive(groupPid)) return false
      finish({
        closed: true,
        escalated,
        code: leaderCode,
        signal: leaderSignal,
      })
      return true
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      leaderClosed = true
      leaderCode = code
      leaderSignal = signal
      finishIfTreeClosed()
    }
    const onError = () => {
      // A spawn failure has no live process to retain. Running children still
      // produce close after an error, so wait for that authoritative event.
      if (!proc.pid) {
        leaderClosed = true
        leaderCode = null
        leaderSignal = null
        finishIfTreeClosed()
      }
    }

    proc.once('close', onClose)
    proc.once('error', onError)
    try { proc.stdin?.destroy() } catch { /* best effort */ }
    signalProviderTree(proc, 'SIGTERM')

    escalationTimer = setTimeout(() => {
      if (finishIfTreeClosed()) return
      escalated = true
      signalProviderTree(proc, 'SIGKILL')
      const deadline = Date.now() + killWaitMs
      const pollForTreeExit = () => {
        if (finishIfTreeClosed()) return
        if (Date.now() < deadline) {
          terminalTimer = setTimeout(pollForTreeExit, 25)
          return
        }
        finish({
          closed: false,
          escalated: true,
          code: leaderCode,
          signal: leaderSignal,
        })
      }
      terminalTimer = setTimeout(pollForTreeExit, 25)
    }, termGraceMs)
  })
}
