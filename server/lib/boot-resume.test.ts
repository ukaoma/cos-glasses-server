// 6.78.0 (MVP-C): crash-loop parking. Executed tests of the gate itself, each simulated boot
// opening a NEW gate over the same file, the way a new process would. A "crash" is a boot that
// ends without markCleanShutdown. A crash loop starts from the ledger a process left when it
// opened its boot and then died (`priorCrash`): a MISSING ledger is a clean previous boot.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_UNPARK_AFTER_MS,
  BOOT_RESUME_KINDS,
  CRASH_LOOP_WINDOW_MS,
  RESTART_LIMIT,
  bootResumeGate,
  crashLoopParkedError,
  createBootResumeGate,
  installBootResumeGate,
  isBootResumeKind,
  isCrashLoopParkingEnabled,
  restartLimitMessage,
  resumeRetriedItem,
  type BootResumeGateOptions,
  type BootResumeLog,
} from './boot-resume.js'

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
afterEach(() => { installBootResumeGate(null) })

function ledgerPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'cos-boot-resume-'))
  roots.push(root)
  return join(root, 'boot-resume-ledger.json')
}

/** The ledger a process leaves when it opened its boot and then died. */
function priorCrash(path: string): string {
  writeFileSync(path, JSON.stringify({ version: 1, cleanShutdown: false, entries: {} }))
  return path
}

const ON = { COS_CRASH_LOOP_PARKING: undefined } as NodeJS.ProcessEnv
const quiet: BootResumeLog = () => {}
const gateAt = (path: string, extra: Partial<BootResumeGateOptions> = {}) => createBootResumeGate({ path, env: ON, log: quiet, ...extra })

/** `boots` boots; each admits the item and, when `clean`, ends with a clean shutdown. Returns how many admitted it. */
function bootLoop(path: string, boots: number, clean: boolean, phase = 'batch_pending', id = 'g2-session-1', now?: () => number): number {
  let admitted = 0
  for (let boot = 0; boot < boots; boot++) {
    const gate = gateAt(path, now ? { now } : {})
    gate.openBoot()
    if (gate.admit('meeting_finalization', id, phase)) admitted++
    if (clean) gate.markCleanShutdown()
  }
  return admitted
}

const readLedger = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { cleanShutdown: boolean; entries: Record<string, Record<string, unknown>> }

describe('COS_CRASH_LOOP_PARKING (tri-state, default ON)', () => {
  it('is on when unset, empty or any other value', () => {
    for (const value of [undefined, '', 'yes', 'true', '2', ' on ']) {
      expect(isCrashLoopParkingEnabled({ COS_CRASH_LOOP_PARKING: value }), String(value)).toBe(true)
    }
    expect(isCrashLoopParkingEnabled({})).toBe(true)
  })

  it('1 forces on; 0, false and off force off (case and spaces ignored)', () => {
    expect(isCrashLoopParkingEnabled({ COS_CRASH_LOOP_PARKING: '1' })).toBe(true)
    for (const value of ['0', 'false', 'off', ' OFF ', 'False']) {
      expect(isCrashLoopParkingEnabled({ COS_CRASH_LOOP_PARKING: value }), value).toBe(false)
    }
  })

  it('off is 6.77.0 behaviour: everything is admitted and no file is read or written', () => {
    const path = ledgerPath()
    const off = { COS_CRASH_LOOP_PARKING: '0' }
    for (let boot = 0; boot < RESTART_LIMIT * 3; boot++) {
      const gate = gateAt(path, { env: off })
      gate.openBoot()
      expect(gate.admit('meeting_finalization', 'g2-off', 'batch_pending')).toBe(true)
      gate.retry('meeting_finalization', 'g2-off')
      gate.forget('meeting_finalization', 'g2-off')
      gate.markCleanShutdown()
    }
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(join(path, '..'))).toEqual([])
    expect(gateAt(path, { env: off }).status()).toEqual({ enabled: false, crashedBoot: null, limit: RESTART_LIMIT, parked: [] })
  })

  it('off is also the kill switch for an item already parked on disk', () => {
    const path = priorCrash(ledgerPath())
    bootLoop(path, RESTART_LIMIT + 1, false)
    expect(gateAt(path).isParked('meeting_finalization', 'g2-session-1')).toBe(true)
    const before = readFileSync(path, 'utf8')
    const off = gateAt(path, { env: { COS_CRASH_LOOP_PARKING: 'off' } })
    off.openBoot()
    expect(off.admit('meeting_finalization', 'g2-session-1', 'batch_pending')).toBe(true)
    expect(off.isParked('meeting_finalization', 'g2-session-1')).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('is read at call time, not when the gate is made', () => {
    const path = ledgerPath()
    const env: NodeJS.ProcessEnv = { COS_CRASH_LOOP_PARKING: '0' }
    const gate = gateAt(path, { env })
    gate.openBoot()
    expect(existsSync(path)).toBe(false)
    env.COS_CRASH_LOOP_PARKING = '1'
    gate.openBoot()
    expect(existsSync(path)).toBe(true)
  })
})

describe('clean versus crashed boots', () => {
  it('a MISSING ledger is a clean previous boot: nothing counts (the guard never invents a crash)', () => {
    const path = ledgerPath()
    const gate = gateAt(path)
    gate.openBoot()
    expect(gate.status().crashedBoot).toBe(false)
    expect(gate.admit('meeting_finalization', 'g2-a', 'ops_pending')).toBe(true)
    expect(gate.status('meeting_finalization', 'g2-a')).toBeNull()
    // Opening the boot wrote the marker, so if THIS process crashes the next boot counts.
    expect(readLedger(path).cleanShutdown).toBe(false)
    const next = gateAt(path)
    next.openBoot()
    expect(next.status().crashedBoot).toBe(true)
  })

  it('a QUARANTINED ledger is a clean previous boot too', () => {
    for (const body of ['{"cleanShutdown": fal', '[]']) {
      const path = ledgerPath()
      writeFileSync(path, body)
      const gate = gateAt(path)
      gate.openBoot()
      expect(gate.status().crashedBoot, body).toBe(false)
      expect(gate.admit('query_job', 'l', 'start'), body).toBe(true)
      expect(gate.status('query_job', 'l'), body).toBeNull()
    }
  })

  it('a ledger left by a process that opened its boot and died is a crashed boot, and counts', () => {
    const path = priorCrash(ledgerPath())
    const gate = gateAt(path)
    gate.openBoot()
    expect(gate.status().crashedBoot).toBe(true)
    expect(gate.admit('meeting_finalization', 'g2-a', 'ops_pending')).toBe(true)
    expect(gate.status('meeting_finalization', 'g2-a')).toMatchObject({ attempts: 1, parked: false, lastAttemptAt: expect.any(String) })
  })

  it('a boot after markCleanShutdown is clean and does not count', () => {
    const path = priorCrash(ledgerPath())
    const first = gateAt(path)
    first.openBoot()
    first.markCleanShutdown()
    expect(readLedger(path).cleanShutdown).toBe(true)
    const second = gateAt(path)
    second.openBoot()
    expect(second.status().crashedBoot).toBe(false)
    expect(second.admit('meeting_finalization', 'g2-a', 'ops_pending')).toBe(true)
    expect(second.status('meeting_finalization', 'g2-a')).toBeNull()
    // Opening the boot clears the marker, so a crash of THIS process is seen by the next one.
    expect(readLedger(path).cleanShutdown).toBe(false)
  })

  it('routine restarts never park, however many there are (Update Server, drains, phone Restart)', () => {
    const path = priorCrash(ledgerPath())
    expect(bootLoop(path, RESTART_LIMIT * 4, true)).toBe(RESTART_LIMIT * 4)
    const entry = gateAt(path).status('meeting_finalization', 'g2-session-1')
    expect(entry?.parked ?? false).toBe(false)
    expect(entry?.attempts ?? 0).toBe(0)
  })

  it('markCleanShutdown from a process that never opened its boot leaves the last record alone', () => {
    const path = priorCrash(ledgerPath())
    gateAt(path).markCleanShutdown()
    expect(readLedger(path).cleanShutdown).toBe(false)
  })

  it('opening the boot twice in one process reads the marker once', () => {
    const path = priorCrash(ledgerPath())
    const before = gateAt(path)
    before.openBoot()
    before.markCleanShutdown()
    const gate = gateAt(path)
    gate.openBoot()
    gate.openBoot()
    expect(gate.status().crashedBoot).toBe(false)
  })

  it('admit before openBoot opens the boot itself', () => {
    const path = priorCrash(ledgerPath())
    const gate = gateAt(path)
    expect(gate.admit('meeting_finalization', 'g2-a', 'ops_pending')).toBe(true)
    expect(gate.status().crashedBoot).toBe(true)
    expect(gate.status('meeting_finalization', 'g2-a')?.attempts).toBe(1)
  })
})

describe('a clean shutdown resets the counts', () => {
  it('every item admitted this boot starts over; an item this boot did not admit keeps its count', () => {
    const path = priorCrash(ledgerPath())
    for (let boot = 0; boot < 2; boot++) {
      const gate = gateAt(path)
      gate.openBoot()
      gate.admit('meeting_finalization', 'admitted-again', 'batch_pending')
      gate.admit('query_job', 'not-admitted-next-boot', 'start')
    }
    const gate = gateAt(path)
    gate.openBoot()
    gate.admit('meeting_finalization', 'admitted-again', 'batch_pending')
    expect(gate.status('meeting_finalization', 'admitted-again')?.attempts).toBe(3)
    gate.markCleanShutdown()
    expect(readLedger(path).entries['meeting_finalization:admitted-again']).toMatchObject({ attempts: 0, lastAttemptAt: null, parked: false })
    expect(readLedger(path).entries['query_job:not-admitted-next-boot']).toMatchObject({ attempts: 2 })
    // So after a clean exit the item gets a full allowance again.
    expect(bootLoop(path, RESTART_LIMIT + 2, false, 'batch_pending', 'admitted-again')).toBe(RESTART_LIMIT + 1)
  })

  it('a parked item stays parked through a clean shutdown; only Retry unparks it', () => {
    const path = priorCrash(ledgerPath())
    bootLoop(path, RESTART_LIMIT + 1, false)
    const gate = gateAt(path)
    gate.openBoot()
    expect(gate.admit('meeting_finalization', 'g2-session-1', 'batch_pending')).toBe(false)
    gate.markCleanShutdown()
    expect(readLedger(path).entries['meeting_finalization:g2-session-1']).toMatchObject({ parked: true, attempts: RESTART_LIMIT + 1 })
    const next = gateAt(path)
    next.openBoot()
    expect(next.status().crashedBoot).toBe(false)
    expect(next.admit('meeting_finalization', 'g2-session-1', 'batch_pending')).toBe(false)
  })
})

describe('the restart limit, counted on CONSECUTIVE crashed boots', () => {
  it('hands an item back on at most 3 crashed boots and parks it on the 4th, then keeps it parked', () => {
    const path = priorCrash(ledgerPath())
    const boots = RESTART_LIMIT * 2 + 2
    expect(bootLoop(path, boots, false)).toBe(RESTART_LIMIT)
    const entry = gateAt(path).status('meeting_finalization', 'g2-session-1')
    expect(entry).toMatchObject({ parked: true, reason: 'restart_limit', attempts: RESTART_LIMIT + 1, phase: 'batch_pending' })
    expect(entry?.parkedAt).toEqual(expect.any(String))
  })

  it('parks exactly at the boundary: admitted on crashed boot 3, refused on crashed boot 4', () => {
    const path = priorCrash(ledgerPath())
    const verdicts: boolean[] = []
    for (let boot = 0; boot < RESTART_LIMIT + 1; boot++) {
      const gate = gateAt(path)
      gate.openBoot()
      verdicts.push(gate.admit('query_job', 'lineage-1', 'start'))
    }
    expect(verdicts).toEqual([true, true, true, false])
  })

  it('a crash just inside the 30-minute window keeps counting; one just outside restarts the count at 1', () => {
    expect(CRASH_LOOP_WINDOW_MS).toBe(30 * 60_000)
    const path = priorCrash(ledgerPath())
    let now = Date.parse('2026-10-18T12:00:00.000Z')
    const clock = () => now
    bootLoop(path, 2, false, 'batch_pending', 'g2-w', clock)
    expect(gateAt(path).status('meeting_finalization', 'g2-w')?.attempts).toBe(2)
    now += 29 * 60_000
    bootLoop(path, 1, false, 'batch_pending', 'g2-w', clock)
    expect(gateAt(path).status('meeting_finalization', 'g2-w')?.attempts).toBe(3)
    now += 31 * 60_000
    bootLoop(path, 1, false, 'batch_pending', 'g2-w', clock)
    expect(gateAt(path).status('meeting_finalization', 'g2-w')).toMatchObject({ attempts: 1, parked: false })
  })

  it('the window is measured from the LAST count, not the first', () => {
    const path = priorCrash(ledgerPath())
    let now = Date.parse('2026-10-18T12:00:00.000Z')
    const clock = () => now
    let admitted = 0
    for (let boot = 0; boot < RESTART_LIMIT + 1; boot++) {
      admitted += bootLoop(path, 1, false, 'batch_pending', 'g2-slow', clock)
      now += 20 * 60_000 // a slow loop: 60 minutes from first to last count
    }
    expect(admitted).toBe(RESTART_LIMIT)
    expect(gateAt(path).isParked('meeting_finalization', 'g2-slow')).toBe(true)
  })

  it('unrelated crashes spread over days never park anything', () => {
    const path = priorCrash(ledgerPath())
    let now = Date.parse('2026-10-18T12:00:00.000Z')
    let admitted = 0
    for (let boot = 0; boot < 20; boot++) {
      admitted += bootLoop(path, 1, false, 'batch_pending', 'g2-pending-for-days', () => now)
      now += 2 * 3600_000
    }
    expect(admitted).toBe(20)
    expect(gateAt(path).status('meeting_finalization', 'g2-pending-for-days')).toMatchObject({ attempts: 1, parked: false })
  })

  it('a parked item stays parked on a clean boot (only Retry or forget releases it)', () => {
    const path = priorCrash(ledgerPath())
    bootLoop(path, RESTART_LIMIT + 1, false)
    const clean = gateAt(path)
    clean.openBoot()
    clean.markCleanShutdown()
    const next = gateAt(path)
    next.openBoot()
    expect(next.status().crashedBoot).toBe(false)
    expect(next.admit('meeting_finalization', 'g2-session-1', 'batch_pending')).toBe(false)
  })

  it('counts an item once per boot, however often it is admitted in that boot', () => {
    const path = priorCrash(ledgerPath())
    const gate = gateAt(path)
    gate.openBoot()
    for (let i = 0; i < 5; i++) expect(gate.admit('meeting_finalization', 'g2-a', 'batch_pending')).toBe(true)
    expect(gate.status('meeting_finalization', 'g2-a')?.attempts).toBe(1)
  })

  it('a new phase is progress: the count starts over', () => {
    const path = priorCrash(ledgerPath())
    bootLoop(path, RESTART_LIMIT, false, 'batch_pending')
    expect(gateAt(path).status('meeting_finalization', 'g2-session-1')?.attempts).toBe(RESTART_LIMIT)
    // The batch finished in the last run; the crash is now in the operations handoff.
    expect(bootLoop(path, RESTART_LIMIT, false, 'ops_pending')).toBe(RESTART_LIMIT)
    expect(gateAt(path).status('meeting_finalization', 'g2-session-1')).toMatchObject({ phase: 'ops_pending', attempts: RESTART_LIMIT, parked: false })
    expect(bootLoop(path, 1, false, 'ops_pending')).toBe(0)
  })

  it('a phase change on a clean boot resets the count without counting', () => {
    const path = priorCrash(ledgerPath())
    bootLoop(path, 2, false, 'capture_pending')
    const clean = gateAt(path)
    clean.openBoot()
    clean.markCleanShutdown()
    const gate = gateAt(path)
    gate.openBoot()
    expect(gate.admit('meeting_finalization', 'g2-session-1', 'batch_pending')).toBe(true)
    expect(gate.status('meeting_finalization', 'g2-session-1')).toMatchObject({ phase: 'batch_pending', attempts: 0 })
  })

  it('items are counted separately by kind and id', () => {
    const path = priorCrash(ledgerPath())
    for (let boot = 0; boot < RESTART_LIMIT + 1; boot++) {
      const gate = gateAt(path)
      gate.openBoot()
      gate.admit('meeting_finalization', 'shared-id', 'batch_pending')
      if (boot === RESTART_LIMIT) expect(gate.admit('query_job', 'shared-id', 'start')).toBe(true)
    }
    const gate = gateAt(path)
    expect(gate.isParked('meeting_finalization', 'shared-id')).toBe(true)
    expect(gate.isParked('query_job', 'shared-id')).toBe(false)
  })

  it('honours a smaller limit', () => {
    const path = priorCrash(ledgerPath())
    const verdicts: boolean[] = []
    for (let boot = 0; boot < 3; boot++) {
      const gate = gateAt(path, { limit: 1 })
      gate.openBoot()
      verdicts.push(gate.admit('query_job', 'l', 'start'))
    }
    expect(verdicts).toEqual([true, false, false])
  })
})

describe('P7 S5: one automatic second chance for a parked meeting finalization', () => {
  const T0 = Date.parse('2026-10-18T12:00:00.000Z')
  function boots(path: string, kind: 'meeting_finalization' | 'query_job', id: string) {
    let t = T0
    return {
      at: () => t,
      /** One crashed boot `advanceMs` after the last; true when the item was admitted. */
      boot(advanceMs: number): boolean {
        t += advanceMs
        const gate = gateAt(path, { now: () => t })
        gate.openBoot()
        return gate.admit(kind, id, 'batch_pending')
      },
      gate: () => gateAt(path, { now: () => t }),
    }
  }

  it('unparks once on the first boot 30 minutes after the park, with a fresh count; a second park is permanent', () => {
    expect(AUTO_UNPARK_AFTER_MS).toBe(30 * 60_000)
    const path = priorCrash(ledgerPath())
    const key = 'meeting_finalization:g2-storm'
    const b = boots(path, 'meeting_finalization', 'g2-storm')
    for (let i = 0; i < RESTART_LIMIT; i++) expect(b.boot(60_000), `crash ${i + 1}`).toBe(true)
    expect(b.boot(60_000)).toBe(false)
    const parkedAt = Date.parse(readLedger(path).entries[key]!.parkedAt as string)
    expect(parkedAt).toBe(b.at())
    // Not before 30 minutes.
    expect(b.boot(AUTO_UNPARK_AFTER_MS - 1)).toBe(false)
    expect(readLedger(path).entries[key]).toMatchObject({ parked: true, autoRetriedAt: null })
    // At 30 minutes: the one second chance. This boot crashed too, so it counts as attempt 1.
    expect(b.boot(1)).toBe(true)
    expect(readLedger(path).entries[key]).toMatchObject({ parked: false, attempts: 1, reason: null, parkedAt: null, autoRetriedAt: new Date(parkedAt + AUTO_UNPARK_AFTER_MS).toISOString() })
    // The storm goes on: parked again after the limit, and this park is permanent.
    for (let i = 1; i < RESTART_LIMIT; i++) expect(b.boot(60_000)).toBe(true)
    expect(b.boot(60_000)).toBe(false)
    expect(b.boot(2 * 3_600_000)).toBe(false)
    expect(b.boot(48 * 3_600_000)).toBe(false)
    expect(b.gate().status().parked.map(item => item.id)).toEqual(['g2-storm'])
  })

  it("the person's Retry still unparks it, and keeps the second chance spent", () => {
    const path = priorCrash(ledgerPath())
    const key = 'meeting_finalization:g2-retried'
    const b = boots(path, 'meeting_finalization', 'g2-retried')
    for (let i = 0; i <= RESTART_LIMIT; i++) b.boot(60_000)
    expect(b.boot(AUTO_UNPARK_AFTER_MS)).toBe(true)
    for (let i = 1; i <= RESTART_LIMIT; i++) b.boot(60_000)
    expect(readLedger(path).entries[key]).toMatchObject({ parked: true })
    const retried = b.gate().retry('meeting_finalization', 'g2-retried')
    expect(retried).toMatchObject({ parked: false, attempts: 0 })
    expect(retried!.autoRetriedAt).not.toBeNull()
    for (let i = 0; i <= RESTART_LIMIT; i++) b.boot(60_000)
    expect(b.boot(AUTO_UNPARK_AFTER_MS * 4)).toBe(false)
  })

  it('a parked query job never unparks by itself (the app shows it and offers Retry)', () => {
    const path = priorCrash(ledgerPath())
    const b = boots(path, 'query_job', 'c1a2b3c4-0000-4000-8000-000000000009')
    for (let i = 0; i < RESTART_LIMIT; i++) expect(b.boot(60_000)).toBe(true)
    expect(b.boot(60_000)).toBe(false)
    expect(b.boot(AUTO_UNPARK_AFTER_MS * 10)).toBe(false)
  })

  it('a parked entry with no usable parkedAt is never unparked by the timer', () => {
    const path = ledgerPath()
    writeFileSync(path, JSON.stringify({ version: 1, cleanShutdown: false, entries: {
      'meeting_finalization:g2-undated': { kind: 'meeting_finalization', id: 'g2-undated', phase: 'batch_pending', attempts: 4, parked: true, reason: 'restart_limit', parkedAt: null, retriedAt: null, lastAttemptAt: null, updatedAt: '2026-10-18T12:00:00.000Z' },
    } }))
    const gate = gateAt(path, { now: () => T0 + 365 * 86_400_000 })
    gate.openBoot()
    expect(gate.admit('meeting_finalization', 'g2-undated', 'batch_pending')).toBe(false)
  })
})

describe('retry and forget', () => {
  it('retry unparks, starts the count over and records retriedAt', () => {
    const path = priorCrash(ledgerPath())
    bootLoop(path, RESTART_LIMIT + 1, false)
    const gate = gateAt(path, { now: () => Date.parse('2026-10-18T12:00:00.000Z') })
    gate.openBoot()
    expect(gate.admit('meeting_finalization', 'g2-session-1', 'batch_pending')).toBe(false)
    const entry = gate.retry('meeting_finalization', 'g2-session-1')
    expect(entry).toMatchObject({ parked: false, attempts: 0, reason: null, parkedAt: null, lastAttemptAt: null, retriedAt: '2026-10-18T12:00:00.000Z' })
    expect(readLedger(path).entries['meeting_finalization:g2-session-1']).toMatchObject({ parked: false, attempts: 0 })
    // Same boot (the Retry route resumes it now): admitted, and not counted twice.
    expect(gate.admit('meeting_finalization', 'g2-session-1', 'batch_pending')).toBe(true)
    expect(gate.status('meeting_finalization', 'g2-session-1')?.attempts).toBe(0)
    // And it has a full new allowance of crashed boots.
    expect(bootLoop(path, RESTART_LIMIT + 1, false)).toBe(RESTART_LIMIT)
  })

  it('retry of an unknown item is null and writes nothing', () => {
    const path = ledgerPath()
    const writes: string[] = []
    const gate = gateAt(path, { writeFile: (_p, data) => { writes.push(data) } })
    expect(gate.retry('query_job', 'nobody')).toBeNull()
    expect(writes).toEqual([])
  })

  it('forget removes the entry; forgetting an absent one writes nothing', () => {
    const path = priorCrash(ledgerPath())
    bootLoop(path, 2, false)
    const writes: string[] = []
    const gate = gateAt(path, { writeFile: (p, data) => { writes.push(data); writeFileSync(p, data) } })
    gate.forget('meeting_finalization', 'g2-session-1')
    expect(writes).toHaveLength(1)
    expect(readLedger(path).entries).toEqual({})
    gate.forget('meeting_finalization', 'g2-session-1')
    expect(writes).toHaveLength(1)
    expect(gateAt(path).status('meeting_finalization', 'g2-session-1')).toBeNull()
  })

  it('a clean boot that changes nothing writes nothing beyond opening the boot', () => {
    const path = ledgerPath()
    const first = gateAt(path)
    first.openBoot()
    first.markCleanShutdown()
    const writes: string[] = []
    const gate = gateAt(path, { writeFile: (p, data) => { writes.push(data); writeFileSync(p, data) } })
    gate.openBoot()
    expect(writes).toHaveLength(1)
    for (let i = 0; i < 20; i++) gate.admit('meeting_finalization', `g2-${i}`, 'batch_pending')
    expect(writes).toHaveLength(1)
  })
})

describe('the ledger file', () => {
  it('is private (0600) and versioned', () => {
    const path = priorCrash(ledgerPath())
    bootLoop(path, 1, false)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1, cleanShutdown: false })
  })

  it('a corrupt ledger is quarantined and read as empty, and the boot opens as clean', () => {
    const path = ledgerPath()
    writeFileSync(path, '{"cleanShutdown": tru')
    const events: Array<[string, Record<string, unknown>]> = []
    const gate = gateAt(path, { log: (_l, event, detail) => events.push([event, detail]) })
    gate.openBoot()
    expect(gate.status().crashedBoot).toBe(false)
    expect(gate.admit('meeting_finalization', 'g2-a', 'batch_pending')).toBe(true)
    const files = readdirSync(join(path, '..'))
    expect(files.filter(name => name.startsWith('boot-resume-ledger.json.corrupt-'))).toHaveLength(1)
    expect(readLedger(path)).toMatchObject({ version: 1, cleanShutdown: false, entries: {} })
    expect(events.some(([event, detail]) => event === 'boot_resume.fail_open' && detail.op === 'quarantine')).toBe(true)
    expect(events.find(([event]) => event === 'boot_resume.open')?.[1]).toMatchObject({ ledger: 'corrupt', crashedBoot: false })
  })

  it('valid JSON of the wrong shape is quarantined too', () => {
    for (const body of ['[]', 'null', '"text"', '{"entries": []}']) {
      const path = ledgerPath()
      writeFileSync(path, body)
      const gate = gateAt(path)
      gate.openBoot()
      expect(gate.admit('query_job', 'l', 'start'), body).toBe(true)
      expect(readdirSync(join(path, '..')).some(name => name.includes('.corrupt-')), body).toBe(true)
      expect(readLedger(path), body).toMatchObject({ version: 1, entries: {} })
    }
  })

  it('drops malformed entries and keeps good ones', () => {
    const path = ledgerPath()
    writeFileSync(path, JSON.stringify({
      version: 1,
      cleanShutdown: true,
      entries: {
        'query_job:good': { kind: 'query_job', id: 'good', phase: 'start', attempts: 2, parked: false, reason: null, parkedAt: null, retriedAt: null, updatedAt: new Date().toISOString() },
        'query_job:bad-attempts': { kind: 'query_job', id: 'bad-attempts', phase: 'start', attempts: -1, parked: false },
        'query_job:wrong-key': { kind: 'query_job', id: 'other', phase: 'start', attempts: 1, parked: true },
        'nocolon': { phase: 'start', attempts: 1, parked: true },
      },
    }))
    const gate = gateAt(path)
    expect(gate.status('query_job', 'good')).toMatchObject({ attempts: 2, lastAttemptAt: null })
    expect(gate.status().parked).toEqual([])
  })

  it('drops an unparked entry untouched for more than 7 days on the next write, well below the cap', () => {
    const path = ledgerPath()
    const now = Date.parse('2026-10-18T12:00:00.000Z')
    const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString()
    const entry = (id: string, daysAgo: number, parked: boolean) => ({ kind: 'meeting_finalization', id, phase: 'ops_pending', attempts: parked ? 4 : 2, parked, reason: parked ? 'restart_limit' : null, parkedAt: parked ? at(daysAgo) : null, retriedAt: null, lastAttemptAt: at(daysAgo), updatedAt: at(daysAgo) })
    writeFileSync(path, JSON.stringify({ version: 1, cleanShutdown: true, entries: {
      'meeting_finalization:stale': entry('stale', 7.01, false),
      'meeting_finalization:recent': entry('recent', 6.99, false),
      'meeting_finalization:parked-long-ago': entry('parked-long-ago', 90, true),
    } }))
    const gate = gateAt(path, { now: () => now })
    gate.openBoot()
    expect(Object.keys(readLedger(path).entries).sort()).toEqual(['meeting_finalization:parked-long-ago', 'meeting_finalization:recent'])
    expect(gate.status('meeting_finalization', 'stale')).toBeNull()
  })

  it('drops unparked entries untouched for 7 days, keeps parked ones, and keeps at most 500', () => {
    const path = ledgerPath()
    const now = Date.parse('2026-10-18T12:00:00.000Z')
    const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString()
    const entry = (id: string, daysAgo: number, parked: boolean) => ({ kind: 'query_job', id, phase: 'start', attempts: parked ? 4 : 1, parked, reason: parked ? 'restart_limit' : null, parkedAt: parked ? at(daysAgo) : null, retriedAt: null, lastAttemptAt: at(daysAgo), updatedAt: at(daysAgo) })
    const entries: Record<string, unknown> = {
      'query_job:old': entry('old', 8, false),
      'query_job:fresh': entry('fresh', 0, false),
      'query_job:old-parked': entry('old-parked', 40, true),
    }
    // 600 more, all younger than 7 days (0.5 to 6.1), so only the cap can drop them.
    for (let i = 0; i < 600; i++) entries[`query_job:bulk-${i}`] = entry(`bulk-${i}`, (i % 6) + 0.5 + 0.001 * i, false)
    writeFileSync(path, JSON.stringify({ version: 1, cleanShutdown: true, entries }))
    const gate = gateAt(path, { now: () => now })
    gate.openBoot()
    const kept = readLedger(path).entries
    expect(Object.keys(kept)).toHaveLength(500)
    expect(kept['query_job:old']).toBeUndefined()
    expect(kept['query_job:old-parked']).toMatchObject({ parked: true })
    expect(kept['query_job:fresh']).toBeDefined()
  })
})

describe('fails open', () => {
  it('a write error never parks anything: the item is admitted on every crashed boot and the error is logged', () => {
    const path = priorCrash(ledgerPath())
    const before = readFileSync(path, 'utf8')
    const events: string[] = []
    let admitted = 0
    for (let boot = 0; boot < RESTART_LIMIT * 3; boot++) {
      const gate = gateAt(path, {
        log: (_l, event) => events.push(event),
        writeFile: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) },
      })
      gate.openBoot()
      if (gate.admit('meeting_finalization', 'g2-a', 'batch_pending')) admitted++
      expect(gate.isParked('meeting_finalization', 'g2-a')).toBe(false)
    }
    expect(admitted).toBe(RESTART_LIMIT * 3)
    expect(events).toContain('boot_resume.fail_open')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('a write error exactly at the parking decision admits, and memory is not left parked', () => {
    const path = priorCrash(ledgerPath())
    bootLoop(path, RESTART_LIMIT, false)
    const gate = gateAt(path, { writeFile: (p, data) => {
      if (JSON.parse(data).entries['meeting_finalization:g2-session-1']?.parked) throw Object.assign(new Error('read-only'), { code: 'EROFS' })
      writeFileSync(p, data)
    } })
    gate.openBoot()
    expect(gate.admit('meeting_finalization', 'g2-session-1', 'batch_pending')).toBe(true)
    expect(gate.isParked('meeting_finalization', 'g2-session-1')).toBe(false)
    expect(gate.status().parked).toEqual([])
  })

  it('an unwritable directory fails open through the real durable writer', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-boot-resume-ro-'))
    roots.push(root)
    const blocker = join(root, 'not-a-dir')
    writeFileSync(blocker, 'x')
    const gate = gateAt(join(blocker, 'boot-resume-ledger.json'))
    gate.openBoot()
    for (let i = 0; i < RESTART_LIMIT + 2; i++) expect(gate.admit('query_job', `l${i}`, 'start')).toBe(true)
    gate.markCleanShutdown()
    expect(gate.status().parked).toEqual([])
  })

  it('a ledger path that cannot be read is treated as empty and clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-boot-resume-dir-'))
    roots.push(root)
    const path = join(root, 'ledger-is-a-directory')
    mkdirSync(path)
    const gate = gateAt(path)
    gate.openBoot()
    expect(gate.admit('query_job', 'l', 'start')).toBe(true)
    expect(gate.status()).toMatchObject({ enabled: true, crashedBoot: false, parked: [] })
  })
})

describe('status and breadcrumbs', () => {
  it('status() lists parked items as { kind, id, phase, attempts, parkedAt, reason } only', () => {
    const path = priorCrash(ledgerPath())
    bootLoop(path, RESTART_LIMIT + 1, false, 'ops_pending', 'g2-parked')
    bootLoop(path, 1, false, 'ops_pending', 'g2-counting')
    const gate = gateAt(path)
    gate.openBoot()
    const status = gate.status()
    expect(status).toMatchObject({ enabled: true, crashedBoot: true, limit: RESTART_LIMIT })
    expect(status.parked).toHaveLength(1)
    expect(Object.keys(status.parked[0]!).sort()).toEqual(['attempts', 'id', 'kind', 'parkedAt', 'phase', 'reason'])
    expect(status.parked[0]).toMatchObject({ kind: 'meeting_finalization', id: 'g2-parked', phase: 'ops_pending', attempts: RESTART_LIMIT + 1, reason: 'restart_limit' })
  })

  it('logs boot_resume.open, boot_resume.parked (with the item id) and boot_resume.retry', () => {
    const path = priorCrash(ledgerPath())
    bootLoop(path, RESTART_LIMIT, false)
    const events: Array<[string, Record<string, unknown>]> = []
    const gate = gateAt(path, { log: (_l, event, detail) => events.push([event, detail]) })
    gate.openBoot()
    gate.admit('meeting_finalization', 'g2-session-1', 'batch_pending')
    gate.retry('meeting_finalization', 'g2-session-1')
    expect(events.map(([event]) => event)).toEqual(['boot_resume.open', 'boot_resume.parked', 'boot_resume.retry'])
    expect(events[0]![1]).toMatchObject({ crashedBoot: true, ledger: 'ok', entries: 1, parked: 0 })
    expect(events[1]![1]).toMatchObject({ kind: 'meeting_finalization', id: 'g2-session-1', attempts: RESTART_LIMIT + 1, newly: true })
    expect(events[2]![1]).toMatchObject({ wasParked: true, attemptsBefore: RESTART_LIMIT + 1 })
  })

  it('the default log is the server console in the [event] {json} shape', () => {
    const path = ledgerPath()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      createBootResumeGate({ path, env: ON }).openBoot()
      expect(log.mock.calls.some(([line]) => typeof line === 'string' && line.startsWith('[boot_resume.open] {"crashedBoot":false'))).toBe(true)
    } finally {
      log.mockRestore()
    }
  })
})

describe('the process gate and the copy', () => {
  it('before index.ts installs one, every caller gets a pass-through gate that writes nothing', () => {
    const gate = bootResumeGate()
    gate.openBoot()
    expect(gate.admit('meeting_finalization', 'x', 'batch_pending')).toBe(true)
    expect(gate.isParked('meeting_finalization', 'x')).toBe(false)
    expect(gate.retry('meeting_finalization', 'x')).toBeNull()
    expect(gate.status()).toEqual({ enabled: false, crashedBoot: null, limit: RESTART_LIMIT, parked: [] })
    expect(gate.status('meeting_finalization', 'x')).toBeNull()
  })

  it('install returns the gate, bootResumeGate() serves it, and a Retry re-runs only its kind\'s resumer', () => {
    const path = ledgerPath()
    const resumed: string[] = []
    const gate = installBootResumeGate(gateAt(path), { resume: { meeting_finalization: id => resumed.push(id) } })
    expect(bootResumeGate()).toBe(gate)
    expect(resumeRetriedItem('meeting_finalization', 'g2-a')).toBe(true)
    expect(resumeRetriedItem('query_job', 'l')).toBe(false)
    expect(resumed).toEqual(['g2-a'])
    installBootResumeGate(gateAt(path), { resume: { meeting_finalization: () => { throw new Error('boom') } } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(resumeRetriedItem('meeting_finalization', 'g2-a')).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('knows its kinds', () => {
    expect([...BOOT_RESUME_KINDS]).toEqual(['meeting_finalization', 'query_job'])
    expect(isBootResumeKind('query_job')).toBe(true)
    expect(isBootResumeKind('finalization')).toBe(false)
    expect(isBootResumeKind(undefined)).toBe(false)
  })

  it('the parked copy fits a 32-column footer lead, names the limit, with no dashes or arrows', () => {
    expect(restartLimitMessage()).toBe('Stopped after 3 server crashes.')
    expect(restartLimitMessage().length).toBeLessThanOrEqual(32)
    expect(crashLoopParkedError()).toEqual({
      code: 'restart_limit',
      message: 'Stopped after 3 server crashes.',
      retryable: true,
      cause: 'crash_loop_parked',
    })
    expect(restartLimitMessage()).not.toMatch(/[–—→]|->|--/)
  })
})
