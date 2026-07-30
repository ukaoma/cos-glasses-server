import { spawn } from 'node:child_process'
import { userInfo } from 'node:os'

/** LaunchAgent label Control installs for the managed glasses server. */
export const DEFAULT_LAUNCHD_LABEL = 'com.cos.glasses-server'

/**
 * COS Control's LaunchAgent uses KeepAlive SuccessfulExit:false — a clean
 * SIGTERM/exit(0) leaves the service STOPPED. Phone Restart must either
 * kickstart -k (kill + start) or exit non-zero so KeepAlive brings it back.
 */
export function scheduleManagedServerRestart(options?: {
  delayMs?: number
  label?: string
  kickstart?: (args: string[]) => void
  exitProcess?: (code: number) => void
  onError?: (error: unknown) => void
}): void {
  const delayMs = options?.delayMs ?? 350
  const label = (options?.label ?? process.env.COS_LAUNCHD_LABEL?.trim()) || DEFAULT_LAUNCHD_LABEL
  const kickstart = options?.kickstart ?? ((args: string[]) => {
    const child = spawn('launchctl', args, { detached: true, stdio: 'ignore' })
    child.unref()
  })
  const exitProcess = options?.exitProcess ?? ((code: number) => { process.exit(code) })
  const onError = options?.onError ?? ((error: unknown) => {
    console.error('[recovery] Failed to schedule managed server restart:', error)
  })

  const timer = setTimeout(() => {
    if (process.env.COS_DISABLE_SELF_RESTART === '1') return
    try {
      const uid = userInfo().uid
      kickstart(['kickstart', '-k', `gui/${uid}/${label}`])
      // If kickstart did not kill us quickly (misconfigured label), force a
      // non-zero exit so KeepAlive SuccessfulExit:false still restarts.
      setTimeout(() => {
        if (process.env.COS_DISABLE_SELF_RESTART === '1') return
        try { exitProcess(1) } catch (error) { onError(error) }
      }, 2_000).unref?.()
    } catch (error) {
      onError(error)
      try { exitProcess(1) } catch (exitError) { onError(exitError) }
    }
  }, delayMs)
  timer.unref?.()
}
