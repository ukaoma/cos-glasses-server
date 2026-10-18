// 6.78.0 (MVP-C): composition-root wiring of the crash-loop gate.
//
// SOURCE-SHAPE ASSERTIONS, AND THEY SAY SO (the repo's convention for server/index.ts,
// see meeting-import-wiring.test.ts): index.ts binds ports and starts timers at import, so no
// test can execute it. The behaviour behind each line is executed elsewhere:
// boot-resume.test.ts (the gate), query-job-coordinator-boot-resume.test.ts (the requeue),
// meeting-boot-resume.test.ts and meeting.test.ts (finalization), maintenance.test.ts (routes).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
const count = (text: string, needle: string) => text.split(needle).length - 1
/** The text between two anchors, each of which must exist exactly once. */
function between(text: string, from: string, to: string): string {
  expect(count(text, from), from).toBe(1)
  expect(count(text, to), to).toBe(1)
  return text.slice(text.indexOf(from), text.indexOf(to))
}

describe('server/index.ts wires one crash-loop gate per process', () => {
  const index = source('server/index.ts')

  it('installs exactly one gate, on the data directory ledger, with the meeting Retry resumer', () => {
    expect(count(index, 'installBootResumeGate(createBootResumeGate({ path: dataPath(BOOT_RESUME_LEDGER_FILE) })')).toBe(1)
    expect(index).toContain('resume: { meeting_finalization: sessionId => resumeMeetingFinalizationJobs({ sessionId }) },')
  })

  it('opens the boot first thing in the admitted runtime, before every boot resume', () => {
    const admitted = between(index, 'const startAdmittedRuntime', 'startProofSafeServices()\n  onMaintenanceAdmissionsOpen')
    const openAt = admitted.indexOf('bootResume.openBoot()')
    expect(openAt).toBeGreaterThan(-1)
    expect(count(index, 'bootResume.openBoot()')).toBe(1)
    expect(openAt).toBeLessThan(admitted.indexOf('resumeMeetingFinalizationJobs()'))
    expect(openAt).toBeLessThan(admitted.indexOf('void initQueryJobRuntime()'))
  })

  it('marks a clean exit FIRST in gracefulShutdown, before the 8 s force exit exists, so every exit after SIGTERM is clean', () => {
    const shutdown = between(index, 'async function gracefulShutdown', "process.on('SIGTERM'")
    const markAt = shutdown.indexOf('bootResume.markCleanShutdown()')
    expect(count(index, 'bootResume.markCleanShutdown()')).toBe(1)
    expect(markAt).toBeGreaterThan(shutdown.indexOf('gracefulShutdownStarted = true'))
    expect(markAt).toBeLessThan(shutdown.indexOf('const forceExit = setTimeout(() => process.exit(1), 8_000)'))
    expect(markAt).toBeLessThan(shutdown.indexOf('await meetingAskRuntime.shutdown()'))
    expect(markAt).toBeLessThan(shutdown.indexOf("await shutdownQueryJobRuntime('server_shutdown')"))
    expect(markAt).toBeLessThan(shutdown.indexOf('process.exit(0)'))
    // Never from an exit hook: a crash also runs exit hooks, which would count it as clean.
    expect(index).not.toMatch(/process\.(on|once)\('exit'[^\n]*markCleanShutdown/)
  })
})

describe('the query-job runtime hands the coordinator the process gate', () => {
  it('passes the bootResumeGate accessor (read when used, so index.ts can install it later)', () => {
    const runtime = source('server/lib/query-job-runtime.ts')
    expect(runtime).toContain("import { bootResumeGate } from './boot-resume.js'")
    const coordinator = between(runtime, 'export const queryJobCoordinator = new QueryJobCoordinator(', '// A job\'s number is a live reservation')
    expect(coordinator).toContain('  bootResumeGate,\n')
  })
})

describe('the managed runtime forwards the switch', () => {
  it('lists COS_CRASH_LOOP_PARKING in optionalEnvironment', () => {
    const contract = JSON.parse(source('managed-runtime-contract.json')) as { optionalEnvironment: string[]; contractVersion: number }
    expect(contract.optionalEnvironment).toContain('COS_CRASH_LOOP_PARKING')
    // The status field is additive: Control accepts contract 1 or 2 only.
    expect(contract.contractVersion).toBe(2)
  })
})
