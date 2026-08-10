import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { getSessionHeartbeat, recordSessionHeartbeat } from './session-heartbeats.js'
import {
  STRANDED_PROMOTE_TITLE,
  clearStrandedDraft,
  listStrandedDrafts,
  promoteStrandedSession,
  releaseStrandedState,
  shouldCloseAfterFailedPromote,
  sweepStrandedSessions,
  writeStrandedDraft,
} from './stranded-session-actions.js'

const NOW = 1_786_320_000_000
const mins = (n: number) => n * 60_000

let dir: string
beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), 'stranded-')) })

const input = (over: Partial<Parameters<typeof writeStrandedDraft>[1]> = {}) => ({
  sessionId: 'meeting_1786305380784_30mzjn',
  transcript: 'Speaker 1: so the idea is that the sweeper saves it for you.',
  chunkCount: 526,
  startedAt: NOW - mins(240),
  lastActivityAt: NOW - mins(184),
  now: NOW,
  ...over,
})

describe('the draft is a sidecar, never a meeting', () => {
  it('writes readable text with the numbers that explain the state', () => {
    const path = writeStrandedDraft(dir, input())!
    expect(path).toMatch(/meeting_1786305380784_30mzjn\.draft\.md$/)
    const doc = readFileSync(path, 'utf8')
    expect(doc).toContain('state: stranded_draft')
    expect(doc).toContain('chunks_received: 526')
    expect(doc).toContain('idle_minutes: 184')
    expect(doc).toContain('captured_minutes: 56')
    expect(doc).toContain('the sweeper saves it for you')
  })

  it('says plainly that this is not a meeting yet and the tail can still arrive', () => {
    // The draft exists so a stranded capture is visible and readable. If its own
    // text implied it were final, a user would stop waiting for the drain.
    const doc = readFileSync(writeStrandedDraft(dir, input())!, 'utf8')
    expect(doc).toContain('Draft only')
    expect(doc).toContain('has not been saved as a')
    expect(doc).toMatch(/phone reconnects/)
  })

  it('refreshes in place rather than accumulating one file per tick', () => {
    writeStrandedDraft(dir, input())
    writeStrandedDraft(dir, input({ chunkCount: 540, transcript: 'Speaker 1: more audio arrived.' }))
    const drafts = listStrandedDrafts(dir)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]!.chunkCount).toBe(540)
    expect(readFileSync(drafts[0]!.path, 'utf8')).toContain('more audio arrived')
  })

  it('declines to write a contentless draft', () => {
    expect(writeStrandedDraft(dir, input({ transcript: '   \n  ' }))).toBeNull()
    expect(writeStrandedDraft(dir, input({ sessionId: '' }))).toBeNull()
    expect(listStrandedDrafts(dir)).toHaveLength(0)
  })

  it('bounds a runaway transcript instead of writing it whole', () => {
    const path = writeStrandedDraft(dir, input({ transcript: 'x'.repeat(500_000) }))!
    const doc = readFileSync(path, 'utf8')
    expect(doc).toContain('[draft truncated at 400000 characters]')
    expect(doc.length).toBeLessThan(402_000)
  })

  it('never reports a negative age when a clock skews', () => {
    const doc = readFileSync(writeStrandedDraft(dir, input({ lastActivityAt: NOW + mins(5) }))!, 'utf8')
    expect(doc).toContain('idle_minutes: 0')
    // Scoped to the COMPUTED fields. A bare /-\d+/ matches the hyphens in the
    // ISO `drafted_at` stamp and fails on a correct file.
    expect(doc).toMatch(/^idle_minutes: (?!-)\d+$/m)
    expect(doc).toMatch(/^captured_minutes: (?!-)\d+$/m)
  })
})

describe('listing and clearing drafts', () => {
  it('returns nothing for a directory that was never created', () => {
    expect(listStrandedDrafts(resolve(dir, 'nope'))).toEqual([])
  })

  it('ignores files that are not drafts', () => {
    writeStrandedDraft(dir, input())
    writeFileSync(resolve(dir, 'notes.md'), 'unrelated')
    writeFileSync(resolve(dir, 'x.draft.md.bak'), 'unrelated')
    expect(listStrandedDrafts(dir).map(d => d.sessionId)).toEqual(['meeting_1786305380784_30mzjn'])
  })

  it('clears on a terminal state, and is safe when nothing is there', () => {
    writeStrandedDraft(dir, input())
    clearStrandedDraft(dir, 'meeting_1786305380784_30mzjn')
    expect(listStrandedDrafts(dir)).toHaveLength(0)
    expect(() => clearStrandedDraft(dir, 'never-existed')).not.toThrow()
  })
})

describe('promote goes through the real save route', () => {
  const opts = (fetchImpl: typeof fetch) => ({ port: 3141, token: 'tok', fetchImpl })

  it('posts to /api/meeting/save with the token header and no domain', async () => {
    let seen: { url: string; init: any } | null = null
    const fake = (async (url: any, init: any) => {
      seen = { url: String(url), init }
      return new Response(JSON.stringify({ saved: true, filename: 'x.md' }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await promoteStrandedSession('s1', opts(fake))
    expect(result).toMatchObject({ ok: true, status: 200, filename: 'x.md' })
    expect(seen!.url).toBe('http://127.0.0.1:3141/api/meeting/save')
    expect(seen!.init.headers['X-Cos-Token']).toBe('tok')
    const body = JSON.parse(seen!.init.body)
    expect(body).toEqual({ sessionId: 's1', title: STRANDED_PROMOTE_TITLE })
    // Omitting domain lets the route's keyword inference file it, instead of
    // dumping every unattended capture into one folder.
    expect(body).not.toHaveProperty('domain')
  })

  it('reports a refusal without throwing, so one bad session cannot kill the sweep', async () => {
    const fake = (async () => new Response(
      JSON.stringify({ error: 'no transcript', reason: 'session_not_found' }),
      { status: 404 },
    )) as unknown as typeof fetch
    expect(await promoteStrandedSession('s1', opts(fake)))
      .toMatchObject({ ok: false, status: 404, reason: 'session_not_found' })
  })

  it('survives a non-JSON body', async () => {
    const fake = (async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch
    expect(await promoteStrandedSession('s1', opts(fake))).toMatchObject({ ok: false, status: 502 })
  })

  it('survives the server not answering at all', async () => {
    const fake = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await promoteStrandedSession('s1', opts(fake)))
      .toMatchObject({ ok: false, status: 0, reason: 'request_failed' })
  })

  it('refuses without a token instead of provoking a 401', async () => {
    // A 401 would read as a terminal 4xx and make the caller CLOSE a session it
    // could have saved. Never reaching the network is the safe answer.
    let called = false
    const fake = (async () => { called = true; return new Response('{}', { status: 401 }) }) as unknown as typeof fetch
    expect(await promoteStrandedSession('s1', { port: 3141, token: '', fetchImpl: fake }))
      .toMatchObject({ ok: false, status: 0, reason: 'no_token' })
    expect(called, 'must not attempt an unauthenticated save').toBe(false)
  })

  it('reports a timeout distinctly, because HQ finalization is slow by design', async () => {
    const fake = (async (_url: any, init: any) => {
      await new Promise((_res, rej) => init.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; rej(e)
      }))
      throw new Error('unreachable')
    }) as unknown as typeof fetch
    expect(await promoteStrandedSession('s1', { port: 3141, token: 't', fetchImpl: fake, timeoutMs: 10 }))
      .toMatchObject({ ok: false, status: 0, reason: 'timeout' })
  })
})

describe('a failed auto-save must not throw away a savable capture', () => {
  const GIVE_UP = mins(480)
  const ok = { ok: true, status: 200 }

  it('never closes after a successful save', () => {
    expect(shouldCloseAfterFailedPromote(ok, mins(1000), GIVE_UP)).toBe(false)
  })

  it('never closes when the request never reached the server', () => {
    // Closing on no_token would quarantine a capture the real server could save.
    for (const idle of [mins(240), mins(10_000)]) {
      expect(shouldCloseAfterFailedPromote({ ok: false, status: 0, reason: 'no_token' }, idle, GIVE_UP))
        .toBe(false)
    }
  })

  it('retries a transport failure or timeout instead of closing', () => {
    expect(shouldCloseAfterFailedPromote({ ok: false, status: 0, reason: 'request_failed' }, mins(241), GIVE_UP)).toBe(false)
    expect(shouldCloseAfterFailedPromote({ ok: false, status: 0, reason: 'timeout' }, mins(241), GIVE_UP)).toBe(false)
  })

  it('retries a 5xx, because the server being busy is not the capture being bad', () => {
    for (const status of [500, 502, 503]) {
      expect(shouldCloseAfterFailedPromote({ ok: false, status }, mins(241), GIVE_UP), String(status)).toBe(false)
    }
  })

  it('closes on a terminal 4xx, so the audio still reaches quarantine', () => {
    for (const status of [400, 404, 422]) {
      expect(shouldCloseAfterFailedPromote({ ok: false, status }, mins(241), GIVE_UP), String(status)).toBe(true)
    }
  })

  it('leaves a 409 alone, because another save already owns the session', () => {
    expect(shouldCloseAfterFailedPromote({ ok: false, status: 409, reason: 'save_in_progress' }, mins(241), GIVE_UP)).toBe(false)
  })

  it('gives up eventually, so a permanently failing save cannot pin a session forever', () => {
    expect(shouldCloseAfterFailedPromote({ ok: false, status: 503 }, GIVE_UP - 1, GIVE_UP)).toBe(false)
    expect(shouldCloseAfterFailedPromote({ ok: false, status: 503 }, GIVE_UP, GIVE_UP)).toBe(true)
    expect(shouldCloseAfterFailedPromote({ ok: false, status: 409 }, GIVE_UP, GIVE_UP)).toBe(true)
  })
})

describe('a terminal session keeps no stranded state', () => {
  it('clears BOTH the draft and the liveness veto', () => {
    // Executed, not asserted from source. A retained draft keeps
    // /api/meeting/orphans advertising a capture that is already saved; a retained
    // heartbeat lets a dead session veto a stale verdict for an id that is gone.
    writeStrandedDraft(dir, input())
    recordSessionHeartbeat('meeting_1786305380784_30mzjn', { at: NOW, audioState: 'recording_continuous' })
    expect(listStrandedDrafts(dir)).toHaveLength(1)
    expect(getSessionHeartbeat('meeting_1786305380784_30mzjn')).not.toBeNull()

    releaseStrandedState(dir, 'meeting_1786305380784_30mzjn')

    expect(listStrandedDrafts(dir)).toHaveLength(0)
    expect(getSessionHeartbeat('meeting_1786305380784_30mzjn')).toBeNull()
  })

  it('is safe on a session that never stranded', () => {
    expect(() => releaseStrandedState(dir, 'never-existed')).not.toThrow()
  })

  it('is wired into the ONE terminal path in the route', () => {
    // Structural, and stated as such: reaching finishClosingTranscriptSession
    // means executing routes/transcribe-stream.ts, which boots recovery and a 60s
    // interval against the real data home. The route harness in meeting.test.ts
    // injects a mocked `sessions` object, so it cannot reach the real function
    // either. A mutation deleting this call SURVIVED the whole lib suite, which is
    // what this test exists to catch.
    const route = readFileSync(
      new URL('../routes/transcribe-stream.ts', import.meta.url).pathname, 'utf8')
    const fn = route.slice(route.indexOf('function finishClosingTranscriptSession'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body, 'the terminal path must release stranded state')
      .toMatch(/releaseStrandedState\(STRANDED_DRAFT_DIR, sessionId\)/)
  })
})

describe('the sweep pass, actually executed', () => {
  const session = (over: Record<string, number> = {}) => ({
    lastActivityAt: NOW, startTime: NOW - mins(60), chunkCount: 100, ...over,
  })
  const sweep = (over: Record<string, unknown> = {}) => {
    const promoted: Array<[string, number]> = []
    const result = sweepStrandedSessions({
      now: NOW,
      token: 'tok',
      draftDir: dir,
      sessions: [],
      getHeartbeat: () => null,
      getTranscript: () => 'Speaker 1: the audio is still here.',
      onPromote: (id: string, at: number) => promoted.push([id, at]),
      ...over,
    } as any)
    return { result, promoted }
  }

  it('does NOTHING without a token, not even a draft', () => {
    // A test worker or a tool that imported the module must not write into the
    // real data home or attempt a save. Deleting this guard SURVIVED before the
    // loop was extracted.
    const { result, promoted } = sweep({
      token: '',
      sessions: [['dead', session({ lastActivityAt: NOW - mins(300) })]],
    })
    expect(result).toEqual({ drafted: [], promoted: [], live: [] })
    expect(promoted).toEqual([])
    expect(listStrandedDrafts(dir)).toHaveLength(0)
  })

  it('leaves a session that is still receiving chunks completely alone', () => {
    const { result, promoted } = sweep({ sessions: [['fresh', session()]] })
    expect(result.live).toEqual(['fresh'])
    expect(result.drafted).toEqual([])
    expect(promoted).toEqual([])
    expect(listStrandedDrafts(dir)).toHaveLength(0)
  })

  it('drafts a stale session and does NOT promote it', () => {
    // Deleting this whole branch SURVIVED the suite before extraction — the
    // feature would have shipped silently doing nothing.
    const { result, promoted } = sweep({
      sessions: [['stale', session({ lastActivityAt: NOW - mins(45) })]],
    })
    expect(result.drafted).toEqual(['stale'])
    expect(promoted).toEqual([])
    const drafts = listStrandedDrafts(dir)
    expect(drafts).toHaveLength(1)
    expect(readFileSync(drafts[0]!.path, 'utf8')).toContain('the audio is still here')
  })

  it('promotes at the cutoff and hands the real lastActivityAt to the caller', () => {
    const lastActivityAt = NOW - mins(241)
    const { result, promoted } = sweep({ sessions: [['done', session({ lastActivityAt })]] })
    expect(result.promoted).toEqual(['done'])
    expect(promoted).toEqual([['done', lastActivityAt]])
  })

  it('respects a fresh heartbeat and skips drafting a quiet-but-recording phone', () => {
    const { result } = sweep({
      sessions: [['buffering', session({ lastActivityAt: NOW - mins(45) })]],
      getHeartbeat: () => ({ at: NOW - mins(1), audioState: 'recording_continuous', visibilityState: 'hidden' }),
    })
    expect(result.live).toEqual(['buffering'])
    expect(result.drafted).toEqual([])
  })

  it('does not count a contentless session as drafted', () => {
    const { result } = sweep({
      sessions: [['empty', session({ lastActivityAt: NOW - mins(45) })]],
      getTranscript: () => null,
    })
    expect(result.drafted).toEqual([])
    expect(listStrandedDrafts(dir)).toHaveLength(0)
  })

  it('handles a mixed fleet in one pass', () => {
    const { result, promoted } = sweep({
      sessions: [
        ['fresh', session()],
        ['stale', session({ lastActivityAt: NOW - mins(45) })],
        ['done', session({ lastActivityAt: NOW - mins(400) })],
      ],
    })
    expect(result.live).toEqual(['fresh'])
    expect(result.drafted).toEqual(['stale'])
    expect(result.promoted).toEqual(['done'])
    expect(promoted.map(p => p[0])).toEqual(['done'])
  })

  it('is the loop the interval actually calls', () => {
    // Structural, and the ONLY structural assertion left on this path: the wiring
    // line itself. Everything the loop decides is executed above.
    const route = readFileSync(
      new URL('../routes/transcribe-stream.ts', import.meta.url).pathname, 'utf8')
    expect(route).toMatch(/sweepStrandedSessions\(\{/)
    expect(route).toMatch(/onPromote: promoteStrandedCapture/)
    expect(route).toMatch(/token: process\.env\.COS_API_TOKEN/)
  })
})
