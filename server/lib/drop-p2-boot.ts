/**
 * Drop it P2: when the pings, reminders and follow-ups run. Only while Drop it is on, and they must run without a
 * request (a reminder fires on its own), so this checks the switch at boot and once a minute: on, it opens the drop
 * service (the same stores the routes use) and starts the runtime; off, it stops the runtime and closes its state.
 *
 * Off (the default for every install) opens nothing and writes nothing, exactly as P1.
 */
import type { DropService } from './drop-service.js'
import { PingStateStore } from './ping-engine.js'
import type { DropP2Runtime } from './drop-p2-runtime.js'

export const DROP_P2_CHECK_MS = 60_000

export interface DropP2BootDeps {
  enabled: () => boolean
  /** The routes' lazy service: opening it here and in a request gives the same instance. */
  service: () => DropService | null
  pingRoot: string
  make: (stores: ReturnType<DropService['p2Stores']>, pingState: PingStateStore) => DropP2Runtime
  openPingState?: (root: string) => PingStateStore
  checkMs?: number
}

export function createDropP2Boot(deps: DropP2BootDeps) {
  let runtime: DropP2Runtime | null = null
  let state: PingStateStore | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  function down() {
    runtime?.stop(); runtime = null
    try { state?.close() } catch { /* already closed */ }
    state = null
  }
  /** Bring the runtime in line with the switch. Never throws: a store that cannot open leaves the pings off. */
  function check(): DropP2Runtime | null {
    let on = false
    try { on = deps.enabled() } catch { on = false }
    if (!on) { if (runtime) { down(); console.log('[pings] stopped: Drop it is off') } return null }
    if (runtime) return runtime
    const service = deps.service()
    if (!service) return null
    try {
      state = (deps.openPingState ?? (root => new PingStateStore(root)))(deps.pingRoot)
      runtime = deps.make(service.p2Stores(), state)
      runtime.start()
      console.log('[pings] started')
    } catch (e) {
      console.error('[pings] could not start:', e instanceof Error ? e.message.slice(0, 80) : 'error')
      down()
    }
    return runtime
  }
  return {
    /** The running runtime, or null. The routes read it for banners. */
    runtime: (): DropP2Runtime | null => runtime,
    check,
    start() { if (timer) return; check(); timer = setInterval(check, deps.checkMs ?? DROP_P2_CHECK_MS); timer.unref?.() },
    stop() { if (timer) clearInterval(timer); timer = null; down() },
  }
}
