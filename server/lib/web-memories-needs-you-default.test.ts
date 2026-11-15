/**
 * The build after 7.0.42 (Memories C): status needsYou.meetings through its DEFAULT counter, the process's own cue log
 * and verdicts (liveCueVerdicts), over the last NEEDS_YOU_CUE_DAYS. Its own temp data dir, set before any import.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dataDir = mkdtempSync(join(tmpdir(), 'needs-you-default-'))
process.env.COS_DATA_DIR = dataDir
const { dispatchMemoriesWebOp } = await import('./web-memories-bridge.js')
const { liveCueVerdicts } = await import('./live-cue-verdicts.js')
afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

const DAY = 86_400_000
let n = 0
function logCue(sessionId: string, createdAt: number) {
  liveCueVerdicts().logCue({ v: 1, cueId: `0f8fad5b-d9cb-469f-a165-${String(++n).padStart(12, '0')}`, sessionId, meetingTitle: 'G2 Recording', createdAt,
    armedAt: createdAt - 60_000, kind: 'challenge', headline: 'Name the owner', detail: 'Name the owner today.', gate: 0.88, sources: [], model: 'm', before: '' })
}

describe('needsYou.meetings, default counter', () => {
  it('counts meetings with a cue to rate in the last 7 days from this process\'s cue log', async () => {
    logCue('six_days_ago', Date.now() - 6 * DAY)
    logCue('eight_days_ago', Date.now() - 8 * DAY)
    logCue('today', Date.now() - 60_000)
    const loopback = async (path: string) => path === '/api/health'
      ? { status: 200, body: { server_version: '7.0.42' } }
      : { status: 200, body: { available: true, learning: {}, memory: {}, threads: {}, graph: {} } }
    const out = await dispatchMemoriesWebOp('status', {}, loopback, 'x', async () => ({ count: 0, gates: {} }))
    expect(out.details.needsYou).toMatchObject({ meetings: 2, decisions: 0, quarantineBatch: 0, total: 2 })
  })
})
