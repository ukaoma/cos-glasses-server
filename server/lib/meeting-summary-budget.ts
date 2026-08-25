// Daily budget for standalone meeting summary generation (`claude -p`).
//
// Separate counter from archive-budget.ts ON PURPOSE. That module holds a
// single global `calls` field; folding meeting summaries into it would let a
// burst of meetings disarm archive summaries for the rest of the day. Every
// recurring claude -p caller gets its OWN accounting.
//
// Two defects in archive-budget.ts are deliberately NOT copied here:
//   1. It increments BEFORE the call and never refunds, so a machine offline
//      for one evening burns the whole day's cap on failures. This module
//      commits only a call that produced a validated summary.
//   2. It uses plain writeFileSync, violating the atomic-writes rule. This
//      module uses atomicWriteFileSync + loadJsonOrQuarantine.
//
// Reset is lazy: a read that finds date != localDay() starts fresh. No timers.

import { atomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'
import { localDay } from './local-day.js'
import { dataPath } from './data-dir.js'

const BUDGET_FILE = dataPath('meeting-summary-budget.json')

/** Exported for tests that need to drive the real on-disk read path. */
export function meetingSummaryBudgetFile(): string {
  return BUDGET_FILE
}

export const DEFAULT_DAILY_MEETING_SUMMARY_CALLS = 40

/** Max claude -p calls per local day for meeting summarisation.
 *  Read LIVE for the same reason the feature flag is: COS Control rebuilds the
 *  runtime plist environment on update, and a module-load const would freeze
 *  the value at import — making it untunable without a restart and untestable
 *  in-process. */
export function maxDailyMeetingSummaryCalls(): number {
  const raw = Number(process.env.COS_MEETING_SUMMARY_DAILY_CAP)
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAILY_MEETING_SUMMARY_CALLS
}

export interface MeetingSummaryBudgetState {
  date: string
  calls: number
}

function readBudget(): MeetingSummaryBudgetState {
  const today = localDay()
  const result = loadJsonOrQuarantine<MeetingSummaryBudgetState>(BUDGET_FILE)
  if (result.status === 'corrupt') {
    console.error(
      `[meeting-summary] budget file was corrupt, quarantined as ${result.quarantinedAs} — starting today at 0`,
    )
    return { date: today, calls: 0 }
  }
  if (result.status !== 'ok') return { date: today, calls: 0 }
  const data = result.data
  if (typeof data?.calls !== 'number' || data.date !== today) {
    return { date: today, calls: 0 }
  }
  return data
}

/**
 * True when today's budget still has room. Does NOT consume — call
 * `commitMeetingSummaryCall()` only after a call produced a validated summary,
 * so failures, auth refusals, and timeouts cost nothing.
 */
export function meetingSummaryBudgetAvailable(): boolean {
  return readBudget().calls < maxDailyMeetingSummaryCalls()
}

/** Count one call that produced a validated summary. */
export function commitMeetingSummaryCall(): void {
  const state = readBudget()
  state.calls += 1
  try {
    atomicWriteFileSync(BUDGET_FILE, JSON.stringify(state))
  } catch {
    /* non-fatal — worst case the next read under-counts by one */
  }
}

/** For /api/health and dashboards. */
export function getMeetingSummaryBudgetState(): MeetingSummaryBudgetState & {
  max: number
  remaining: number
} {
  const state = readBudget()
  const max = maxDailyMeetingSummaryCalls()
  return { ...state, max, remaining: Math.max(0, max - state.calls) }
}
