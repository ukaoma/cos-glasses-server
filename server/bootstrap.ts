// Must remain the first import in server/index.ts. Claim the same machine-wide
// slot used by the installed LaunchAgent before mutable routes or stores load.
import './env.js'
import { acquireServerInstanceLock, ServerInstanceActiveError } from './lib/server-instance-lock.js'

try {
  const instanceLock = acquireServerInstanceLock()
  process.once('exit', instanceLock.release)
} catch (error) {
  if (error instanceof ServerInstanceActiveError) {
    console.error(`[COS API] Startup refused: ${error.message}`)
    process.exit(75)
  }
  console.error('[COS API] Startup refused: single-instance lock failed.', error)
  process.exit(74)
}
