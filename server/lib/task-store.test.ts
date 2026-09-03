import { describe, expect, it } from 'vitest'
import {
  beyondCatchUp,
  column,
  flags,
  isCatchUpDue,
  latestLedgerRow,
  type BridgeTaskRow,
  type TaskRun,
} from './task-store.js'
import { taskInstant, zonedInstant } from './morning-brief-schedule.js'

const TZ = 'America/Chicago'
const DAY = '2026-09-02'
const NOW = Date.parse('2026-09-02T16:00:00.000Z') // 11:00 CDT

function row(overrides: Partial<BridgeTaskRow> = {}): BridgeTaskRow {
  return {
    ref: 'quilt-1',
    id: 'aaaaaaaaaaaa',
    domain: 'quilt',
    description: 'row',
    priority: 'inbox',
    is_checked: false,
    archived: false,
    line_number: 1,
    source: null,
    owner: null,
    delegated: false,
    needs_review: false,
    thread: null,
    run_at: null,
    agent_state: null,
    agent_no: null,
    section: 'inbox',
    section_day: null,
    ...overrides,
  }
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    identity: 'id',
    taskId: 'aaaaaaaaaaaa',
    ref: 'quilt-1',
    domain: 'quilt',
    line: 'row',
    day: DAY,
    attempt: 1,
    trigger: 'manual',
    firedAt: '2026-09-02T15:00:00.000Z',
    clientJobId: '00000000-0000-4000-8000-000000000000',
    generation: 1,
    sessionId: 's',
    status: 'done',
    submitAttempts: 1,
    model: 'sonnet',
    activityToolMode: 'status',
    ...overrides,
  }
}

describe('taskInstant', () => {
  it('steps the 2026-03-08 Chicago gap by 60 minutes', () => {
    expect(new Date(zonedInstant('2026-03-08', 2 * 60, TZ)).toISOString()).toBe('2026-03-08T07:00:00.000Z')
    expect(new Date(zonedInstant('2026-03-08', 2 * 60 + 30, TZ)).toISOString()).toBe('2026-03-08T07:30:00.000Z')
    expect(new Date(zonedInstant('2026-03-08', 3 * 60, TZ)).toISOString()).toBe('2026-03-08T08:00:00.000Z')
    expect(new Date(taskInstant('2026-03-08', 2 * 60, TZ)).toISOString()).toBe('2026-03-08T08:00:00.000Z')
    expect(new Date(taskInstant('2026-03-08', 2 * 60 + 30, TZ)).toISOString()).toBe('2026-03-08T08:30:00.000Z')
    expect(new Date(taskInstant('2026-03-08', 3 * 60, TZ)).toISOString()).toBe('2026-03-08T08:00:00.000Z')
  })
})

describe('column and flags', () => {
  it('paints the no-ledger matrix', () => {
    const yesterdayBeyond = row({ section: 'today', section_day: DAY, run_at: '2026-09-01 06:00' })
    expect(column(yesterdayBeyond, undefined, DAY, NOW, TZ)).toBe('inbox')
    expect(flags(yesterdayBeyond, undefined, DAY, NOW, TZ).missed).toBe(true)

    const yesterdayWithin = row({ section: 'today', section_day: DAY, run_at: '2026-09-02 10:00' })
    expect(column(yesterdayWithin, undefined, DAY, NOW, TZ)).toBe('today')
    expect(flags(yesterdayWithin, undefined, DAY, NOW, TZ).due).toBe(true)

    const staleToday = row({ section: 'today', section_day: '2026-09-01', run_at: '2026-09-02 10:00' })
    expect(column(staleToday, undefined, DAY, NOW, TZ)).toBe('carried')
    expect(flags(staleToday, undefined, DAY, NOW, TZ)).toMatchObject({ due: true, carriedOver: true })

    const tomorrow = row({ section: 'inbox', run_at: '2026-09-03 09:00' })
    expect(column(tomorrow, undefined, DAY, NOW, TZ)).toBe('scheduled')

    const failedToday = row({ section: 'today', section_day: DAY, agent_state: 'failed' })
    expect(column(failedToday, undefined, DAY, NOW, TZ)).toBe('inbox')
    expect(flags(failedToday, undefined, DAY, NOW, TZ).failed).toBe(true)
  })

  it('keeps a same-day live overdue row running and not missed', () => {
    const overdue = row({ section: 'today', section_day: DAY, run_at: '2026-09-01 06:00' })
    const live = run({ status: 'running' })
    expect(column(overdue, live, DAY, NOW, TZ)).toBe('running')
    expect(flags(overdue, live, DAY, NOW, TZ)).toMatchObject({ missed: false, due: false })
  })

  it('uses latestLedgerRow live-over-newest', () => {
    const older = run({ status: 'done', firedAt: '2026-09-02T14:00:00.000Z', catchUp: true })
    const live = run({ status: 'dispatching', firedAt: '2026-09-02T15:00:00.000Z' })
    expect(latestLedgerRow([older, live], 'aaaaaaaaaaaa', DAY)?.status).toBe('dispatching')
  })

  it('treats beyondCatchUp as epoch ms vs taskInstant, not minutes-of-day', () => {
    const runAt = { day: '2026-09-02', minutes: 10 * 60 }
    expect(beyondCatchUp(runAt, NOW, TZ, 180)).toBe(false)
    expect(isCatchUpDue(row({ run_at: '2026-09-02 10:00' }), NOW, TZ, 180)).toBe(true)
    expect(beyondCatchUp(runAt, NOW, TZ, 30)).toBe(true)
  })
})
