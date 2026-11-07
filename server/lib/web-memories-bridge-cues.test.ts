/**
 * The Memories bridge's cues.summary (Control's CueVerdicts.summary): the cue history read is the capability check.
 * Before Control Web had a cue review it always answered available:false; now it tells the truth either way.
 */
import { describe, expect, it } from 'vitest'
import { dispatchMemoriesWebOp, type LoopbackFetchFn } from './web-memories-bridge.js'

function loopback(status: number, body: Record<string, unknown>) {
  const paths: string[] = []
  const fn: LoopbackFetchFn = async (path) => { paths.push(path); return { status, body } }
  return { fn, paths }
}

describe('Memories bridge: cues.summary', () => {
  it('a v1 history answer is available, with the week\'s counts, from a one-row read', async () => {
    const lb = loopback(200, { v: 1, cues: [], counts: { total: 457, rated: 10, unrated: 447, byVerdict: {} } })
    const out = await dispatchMemoriesWebOp('cues.summary', {}, lb.fn)
    expect(out).toEqual({ ok: true, message: 'Cues', details: { available: true, unrated: 447, rated: 10, total: 457 } })
    expect(lb.paths).toEqual(['/api/live-cues/history?days=7&unrated=1&limit=1'])
  })

  it('a server without the routes, an unreadable ratings file or an answer outside the contract is unavailable', async () => {
    for (const [status, body] of [[404, { error: 'not found' }], [503, { error: 'the verdicts file is unreadable', reason: 'verdicts_unreadable' }],
      [200, { cues: [], counts: { total: 1, rated: 0, unrated: 1 } }], [200, { v: 1, cues: [] }]] as Array<[number, Record<string, unknown>]>) {
      expect((await dispatchMemoriesWebOp('cues.summary', {}, loopback(status, body).fn)).details, JSON.stringify(body)).toEqual({ available: false })
    }
  })
})
