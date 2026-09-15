// Composition-root wiring for the importer.
//
// A SOURCE-SHAPE TEST, which this repo treats as weaker than an execution test.
// It is used here for the same reason maintenance-lifecycle-wiring.test.ts uses
// it: server/index.ts binds ports and starts timers at import, so no test can
// execute it, and every line below is a wire whose absence is silent. A router
// that is never mounted answers 404, a scheduler that is never started simply
// never polls, and a sweep that is never called leaves debris forever. Each one
// would pass every other test in this release.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('server/index.ts', () => {
  const index = source('server/index.ts')

  it('mounts both new routers', () => {
    expect(index).toContain("import { firefliesKeyRouter } from './routes/fireflies-key.js'")
    expect(index).toContain("import { meetingImportRouter } from './routes/meeting-import.js'")
    expect(index).toMatch(/app\.use\('\/api', firefliesKeyRouter\)/)
    expect(index).toMatch(/app\.use\('\/api', meetingImportRouter\)/)
  })

  it('lets the import run own its own lifecycle lease', () => {
    // The run answers 202 and keeps working; the global per-request lease would
    // double-own work the importer already leases per page.
    expect(index).toContain("req.path === '/meeting-import/fireflies/run'")
    const lifecycleOwned = index.slice(index.indexOf('const lifecycleOwned'), index.indexOf('if (lifecycleOwned) return next()'))
    expect(lifecycleOwned).toContain('/meeting-import/fireflies/run')
  })

  it('starts the poll with the admitted runtime and stops it on shutdown', () => {
    expect(index).toContain('startMeetingImportScheduler()')
    expect(index).toContain('stopMeetingImportScheduler()')
    const shutdown = index.slice(index.indexOf('async function gracefulShutdown'), index.indexOf('process.on(\'SIGTERM\''))
    expect(shutdown, 'the poll must stop before the process exits').toContain('stopMeetingImportScheduler()')
    const admitted = index.slice(index.indexOf('const startAdmittedRuntime'), index.indexOf('startProofSafeServices()'))
    expect(admitted, 'the poll starts only once admissions are open').toContain('startMeetingImportScheduler()')
  })

  it('sweeps import debris at startup, beside the other resume work', () => {
    const admitted = index.slice(index.indexOf('const startAdmittedRuntime'), index.indexOf('startProofSafeServices()'))
    expect(admitted).toContain('resumeMeetingFinalizationJobs()')
    expect(admitted).toContain('getImportedMeetingLibrary().sweep(')
    // Never while a writer holds the lease: mid-write, a sidecar without its
    // markdown is the correct intermediate state.
    expect(admitted).toContain('isBusy:')
    expect(admitted).toContain('meeting_import')
  })
})

describe('maintenance kinds', () => {
  it('declares meeting_import as a work kind', () => {
    expect(source('server/lib/maintenance-lifecycle.ts')).toContain("| 'meeting_import'")
  })

  it('takes the lease in the importer, around the writes', () => {
    const importer = source('server/lib/meeting-import.ts')
    expect(importer).toContain("acquireMaintenanceWork('meeting_import')")
    // The lease must be released on every exit path from the page.
    expect(importer).toMatch(/finally\s*\{\s*\n\s*lease\.release\(\)/)
  })
})

describe('the key path stays separate from voice training', () => {
  it('leaves speaker-trainer.ts reading only the environment and the COS .env', () => {
    const trainer = source('server/lib/speaker-trainer.ts')
    expect(trainer).toContain("loadCosEnvKey('FIREFLIES_API_KEY')")
    expect(trainer).not.toContain('fireflies-key')
  })
})
