import { describe, expect, it } from 'vitest'
import {
  TASK_TITLE_MAX,
  beyondCatchUp,
  column,
  flags,
  isCatchUpDue,
  latestLedgerRow,
  taskTitle,
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

// A raw `.slice(0, 44)` cut words in half and left unbalanced `**` on 119 of the
// 201 rows the live server was serving, so the phone board read
// "**Provide data migration process docs by ind". Every bound below is derived
// from TASK_TITLE_MAX so widening the cap cannot silently strand these.

describe('taskTitle', () => {
  it('keeps the cap inside the G2 list-row budget', () => {
    // The cap is a DISPLAY constraint, not an arbitrary number: the Even vendor
    // spec gives a list row 64 characters, and the board prefixes a domain tag.
    // Every other test derives its bounds from TASK_TITLE_MAX, so without this
    // one nothing notices the cap being widened past what a row can render.
    expect(TASK_TITLE_MAX).toBeLessThanOrEqual(64)
    expect(TASK_TITLE_MAX).toBeGreaterThanOrEqual(24)
  })

  it('strips markdown emphasis instead of spending characters on it', () => {
    expect(taskTitle('**Share ICP document with Blair**')).toBe('Share ICP document with Blair')
    expect(taskTitle('Ship the *draft* today')).toBe('Ship the draft today')
    expect(taskTitle('Ship the _draft_ today')).toBe('Ship the draft today')
    expect(taskTitle('Run cos_python sync.py')).toBe('Run cos_python sync.py')
    expect(taskTitle('Run `cos_python sync.py`')).toBe('Run cos_python sync.py')
    expect(taskTitle('See [the doc](https://example.com/x)')).toBe('See the doc')
  })

  it('clears asterisks whether the emphasis pair is balanced or not', () => {
    // Production shape: the source was balanced, the 44-char slice was not.
    expect(taskTitle('**Unclosed bold that never closes')).toBe('Unclosed bold that never closes')
    expect(taskTitle('Half *open emphasis')).toBe('Half open emphasis')
    expect(taskTitle(`**${'a'.repeat(TASK_TITLE_MAX * 2)}** tail`)).not.toContain('*')
  })

  it('never exceeds the cap', () => {
    for (const n of [0, 1, TASK_TITLE_MAX - 1, TASK_TITLE_MAX, TASK_TITLE_MAX + 1, TASK_TITLE_MAX * 4]) {
      expect(taskTitle('word '.repeat(n)).length).toBeLessThanOrEqual(TASK_TITLE_MAX)
    }
  })

  it('cuts on a word boundary and marks the cut', () => {
    // Padded so the character at the cap lands INSIDE a word; with data that
    // happens to break on a space, a raw slice passes this test unchanged.
    const words = `${'x'.repeat(TASK_TITLE_MAX - 4)} bravocharlie delta`
    const out = taskTitle(words)
    expect(out.endsWith('\u2026')).toBe(true)
    // The visible body must be whole words from the source, never a split token.
    const body = out.slice(0, -1).trim()
    expect(words.startsWith(body)).toBe(true)
    expect(words[body.length] === ' ' || body.length === words.length).toBe(true)
  })

  it('keeps a single long token rather than returning almost nothing', () => {
    const out = taskTitle(`${'z'.repeat(TASK_TITLE_MAX * 2)} tail`)
    expect(out.length).toBeGreaterThan(TASK_TITLE_MAX * 0.6)
  })

  it('passes a short title through untouched and collapses stray whitespace', () => {
    expect(taskTitle('Call Silas')).toBe('Call Silas')
    expect(taskTitle('  Call   Silas  ')).toBe('Call Silas')
  })

  it('does not leave dangling punctuation before the ellipsis', () => {
    const out = taskTitle('Support Storm expansion marketing plan — the whole thing')
    expect(out).not.toMatch(/[\s\u2014,;:-]\u2026$/)
  })
})
