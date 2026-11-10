// Must remain the first import in server/index.ts. Claim the same machine-wide
// slot used by the installed LaunchAgent before mutable routes or stores load.
import './env.js'
import { acquireServerInstanceLock, ServerInstanceActiveError } from './lib/server-instance-lock.js'
import { diskIoMeterRequested, installDiskIoMeter } from './lib/disk-io-meter.js'

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

// S1 (2026-11-09): opt-in per-path disk I/O meter (COS_DISK_IO_METER=1, default off). Installed
// here, before index.ts loads its stores, so module-load writes are counted too.
if (diskIoMeterRequested()) installDiskIoMeter()
