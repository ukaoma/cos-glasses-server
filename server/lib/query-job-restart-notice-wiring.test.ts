// 6.78.0 P2 composition: the two production wiring points of restart truth and the delta
// journal, checked on the source (query-job-runtime.ts and index.ts cannot be imported here:
// their graphs reach claude-bridge.ts and whisper-local). The behaviour behind each line is
// executed in query-job-restart-notice.test.ts and query-job-delta-journal.test.ts.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const runtime = readFileSync(new URL('./query-job-runtime.ts', import.meta.url), 'utf8')
const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

describe('restart truth wiring (6.78.0)', () => {
  it('the production store journals through createQueryJobJournalStorage (MVP-D reader on, writer by flag)', () => {
    const store = runtime.slice(runtime.indexOf('export const queryJobStore = new QueryJobStore({'))
    expect(store.slice(0, store.indexOf('})'))).toContain('storage: createQueryJobJournalStorage(),')
  })

  it('graceful shutdown hands the coordinator the server_shutdown reason, inside the force-exit budget', () => {
    const shutdown = index.slice(index.indexOf('async function gracefulShutdown()'), index.indexOf("process.on('SIGTERM'"))
    expect(shutdown.indexOf('setTimeout(() => process.exit(1), 8_000)')).toBeGreaterThan(-1)
    expect(shutdown.indexOf("await shutdownQueryJobRuntime('server_shutdown')")).toBeGreaterThan(shutdown.indexOf('8_000'))
  })
})
