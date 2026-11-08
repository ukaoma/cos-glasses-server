// 7.0.1 (Needs you stale, Miles 11/07): Today listed "COS Glasses - QA review before publish, Oct 31, Waiting for your
// reply in Personal" while he talked to that session all day. These run app.js's own Needs you code (needsModel,
// needRowHtml) on the exact items the server served.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.js'), 'utf8')

function harness(needs: unknown[]) {
  const start = APP.indexOf('  function needWhy(item) {'), end = APP.indexOf('  // Weather sits under the date')
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  const helpers = APP.slice(APP.indexOf('  function splitSessionId(provider, id) {'), APP.indexOf('  function skeletonRows(n) {'))
  const ctx: Record<string, unknown> = {
    window: { COSWeb: {} }, state: { sessions: [] },
    TODAY: { needs, sessionsState: 'answered', workState: 'answered', voices: { state: 'answered', groups: [] }, memories: { state: 'answered', n: 0 }, working: [] },
    plain: (t: string) => t, sxProvider: (p: string) => p || 'claude', sxKeepWarm: () => false, sxState: () => 'recent',
    esc: (t: string) => String(t), domainLabel: (d: string) => (d === 'personal' ? 'Personal' : d),
    ago: (v: string) => 'AGE(' + v + ')', listWords: (a: string[]) => a.join(', '),
  }
  vm.createContext(ctx)
  vm.runInContext(helpers + APP.slice(start, end) + '\n;this.__ = { needsModel: needsModel, needRowHtml: needRowHtml, needWhy: needWhy };', ctx)
  return (ctx as { __: { needsModel: () => { rows: Array<{ kind: string; item?: unknown }> }; needRowHtml: (r: unknown, i: number) => string } }).__
}

// The live item from GET /api/work-board/your-move on 11/07 (server 7.0.0), and the same item as the 7.0.1 server
// serves it once it read the session's Nov 7 activity.
const live = { id: 'e840cc8e-a0be-41fb-a00b-a61d6fca35c3', workId: 'task:personal:a3e811fbc87a', domain: 'personal', title: 'Speaker Diarization for mac meeting',
  sessionTitle: 'COS Glasses - QA review before publish', status: 'delivered', channel: 'turn', mode: 'continueSession', provider: 'claude',
  sessionId: 'claude:56627115-dbce-4030-ae47-446252b4cdad', createdAt: '2026-10-30T21:13:43.090Z', updatedAt: '2026-10-31T08:25:59.453Z',
  progress: { reported: 'needsInput', paused: false, reportedBy: 'session', receivedAt: '2026-10-30T21:13:44.316Z' },
  acknowledged: false, waitingInApp: false, appOpened: false, group: 'needsInput', waitingSince: '2026-10-31T07:25:59.453Z' }
const superseded = { ...live, group: 'running', supersededAt: '2026-11-08T05:08:44.839Z' }

describe('Needs you: a Work report its session has moved on from', () => {
  it('a report the server marked superseded is not a Needs you row', () => {
    expect(harness([live]).needsModel().rows.map(r => r.kind)).toEqual(['work'])
    expect(harness([superseded]).needsModel().rows).toEqual([])
  })
  it('a superseded completed handoff that regrouped to "Needs a look" still shows, as the Messages badge counts it (review N6)', () => {
    const lookedAt = { ...live, status: 'completed', group: 'attention', supersededAt: '2026-11-08T05:08:44.839Z' }
    expect(harness([lookedAt]).needsModel().rows.map(r => r.kind)).toEqual(['work'])
  })
  it('a waiting Work row is dated by when it started waiting, not by the card\'s newest event', () => {
    const h = harness([live]), [row] = h.needsModel().rows
    const html = h.needRowHtml(row, 0)
    expect(html).toContain('AGE(2026-10-31T07:25:59.453Z)'); expect(html).not.toContain('AGE(2026-10-31T08:25:59.453Z)')
    expect(html).toContain('Waiting for your reply in Personal')
    // An older server sends no waitingSince: the newest event, as before.
    const old = { ...live } as Record<string, unknown>; delete old.waitingSince
    const h2 = harness([old]); expect(h2.needRowHtml(h2.needsModel().rows[0], 0)).toContain('AGE(2026-10-31T08:25:59.453Z)')
  })
})
