import { describe, expect, it } from 'vitest'
import {
  AUTO_RECOVER_TITLE,
  requestQuarantineRecovery,
  MAX_AUTO_RECOVER_ATTEMPTS,
  autoRecoverExhausted,
  clearRecoverAttempts,
  noteRecoverAttempt,
  pickQuarantineToRecover,
} from './quarantine-auto-recover.js'
import { STRANDED_PROMOTE_TITLE } from './stranded-session-actions.js'
import type { UnsavedCapture } from './unsaved-audio-quarantine.js'

// Shaped from a REAL quarantine row read off the live server, not invented:
// meeting_1786237535593, 139 chunks, 31,092,186 bytes, reason idle_expiry_unsaved,
// quarantined 2026-08-09T02:11:27.885Z, expires 2026-08-12T02:11:27.885Z. That
// capture reached quarantine through the restart hole this module closes.
const capture = (over: Partial<UnsavedCapture> = {}): UnsavedCapture => ({
  sessionId: 'meeting_1786237535593',
  dirName: 'meeting_1786237535593',
  quarantinedAt: '2026-08-09T02:11:27.885Z',
  ageHours: 21.7,
  chunkFiles: 139,
  bytes: 31_092_186,
  reason: 'idle_expiry_unsaved',
  expiresAt: '2026-08-12T02:11:27.885Z',
  recovered: false,
  ...over,
})

const state = (over: Partial<{ attempts: [string, number][]; inFlight: string[] }> = {}) => ({
  attempts: new Map(over.attempts ?? []),
  inFlight: new Set(over.inFlight ?? []),
})

describe('picking what to recover', () => {
  it('takes an unrecovered capture that still has audio', () => {
    expect(pickQuarantineToRecover([capture()], state())?.sessionId).toBe('meeting_1786237535593')
  })

  it('does nothing on a quiet tick', () => {
    expect(pickQuarantineToRecover([], state())).toBeNull()
  })

  it('skips one that is already a meeting', () => {
    // Recovering again would duplicate it. `recovered` is stamped on the quarantine
    // dir by the recover route and by a save that finds stale quarantine.
    expect(pickQuarantineToRecover([capture({ recovered: true })], state())).toBeNull()
  })

  it('skips a chunk-less directory, which is residue and not evidence', () => {
    expect(pickQuarantineToRecover([capture({ chunkFiles: 0 })], state())).toBeNull()
  })

  it('skips one a recovery already owns', () => {
    const s = state({ inFlight: ['meeting_1786237535593'] })
    expect(pickQuarantineToRecover([capture()], s)).toBeNull()
  })

  it('takes the OLDEST first, because it is closest to the 72-hour purge', () => {
    const picked = pickQuarantineToRecover([
      capture({ sessionId: 'young', ageHours: 2 }),
      capture({ sessionId: 'old', ageHours: 68 }),
      capture({ sessionId: 'middle', ageHours: 30 }),
    ], state())
    expect(picked?.sessionId).toBe('old')
  })

  it('treats an unreadable age as oldest, not newest', () => {
    // A null marker is itself a sign of an old directory. Sorting it last would
    // starve exactly the capture most likely to be purged next.
    const picked = pickQuarantineToRecover([
      capture({ sessionId: 'known', ageHours: 40 }),
      capture({ sessionId: 'unknown-age', ageHours: null }),
    ], state())
    expect(picked?.sessionId).toBe('unknown-age')
  })

  it('returns ONE per sweep even with a backlog', () => {
    const items = Array.from({ length: 12 }, (_, i) => capture({ sessionId: `s${i}`, ageHours: i }))
    const picked = pickQuarantineToRecover(items, state())
    // Batch transcription is real GPU work; a parallel backlog would starve a live
    // recording. The next tick takes the next one.
    expect(picked).not.toBeNull()
    expect(Array.isArray(picked)).toBe(false)
  })
})

describe('the attempt ledger stops a retry loop', () => {
  it('gives up after the budget instead of retrying every 60s for 72 hours', () => {
    const s = state()
    for (let i = 0; i < MAX_AUTO_RECOVER_ATTEMPTS; i += 1) {
      expect(pickQuarantineToRecover([capture()], s), `attempt ${i + 1}`).not.toBeNull()
      noteRecoverAttempt(s, 'meeting_1786237535593')
    }
    expect(pickQuarantineToRecover([capture()], s)).toBeNull()
    expect(autoRecoverExhausted(s, 'meeting_1786237535593')).toBe(true)
  })

  it('does not block a DIFFERENT capture once one is exhausted', () => {
    const s = state({ attempts: [['broken', MAX_AUTO_RECOVER_ATTEMPTS]] })
    const picked = pickQuarantineToRecover([
      capture({ sessionId: 'broken', ageHours: 70 }),
      capture({ sessionId: 'fine', ageHours: 3 }),
    ], s)
    expect(picked?.sessionId).toBe('fine')
  })

  it('resets on success, so a later re-quarantine starts fresh', () => {
    // Seeded AT the budget, not below it. With attempts=2 of 3 the capture is
    // already eligible and `autoRecoverExhausted` is already false, so a mutation
    // deleting the reset SURVIVED — the assertions passed without it doing anything.
    const s = state({ attempts: [['meeting_1786237535593', MAX_AUTO_RECOVER_ATTEMPTS]] })
    expect(autoRecoverExhausted(s, 'meeting_1786237535593')).toBe(true)
    expect(pickQuarantineToRecover([capture()], s)).toBeNull()

    clearRecoverAttempts(s, 'meeting_1786237535593')

    expect(autoRecoverExhausted(s, 'meeting_1786237535593')).toBe(false)
    expect(pickQuarantineToRecover([capture()], s)).not.toBeNull()
  })

  it('counts the attempt BEFORE the request, so a hang cannot loop forever', () => {
    const s = state()
    noteRecoverAttempt(s, 'x')
    expect(s.attempts.get('x')).toBe(1)
  })
})

describe('a recovered capture is distinguishable from a promoted one', () => {
  it('uses a different title, because it has no speaker labels', () => {
    // A promoted session carried live ASR with speakers. A quarantine recovery has
    // neither — every speaker comes back Unknown — and the library should say so
    // without the user opening the file.
    expect(AUTO_RECOVER_TITLE).not.toBe(STRANDED_PROMOTE_TITLE)
    expect(AUTO_RECOVER_TITLE).toMatch(/audio only/i)
  })

  it('has no em dash or arrow, which Miles reads as machine-written', () => {
    for (const title of [AUTO_RECOVER_TITLE, STRANDED_PROMOTE_TITLE]) {
      expect(title, title).not.toMatch(/[—→]/)
    }
  })
})

describe('asking the recover route to do the work', () => {
  it('refuses without a token instead of provoking a 401', async () => {
    // Same reason as promote: a 401 would look like a terminal failure and burn an
    // attempt against a capture that is perfectly recoverable by the real server.
    let called = false
    const fake = (async () => { called = true; return new Response('{}', { status: 401 }) }) as unknown as typeof fetch
    expect(await requestQuarantineRecovery('s1', { port: 3141, token: '', fetchImpl: fake }))
      .toMatchObject({ ok: false, status: 0, reason: 'no_token' })
    expect(called, 'must not attempt an unauthenticated recovery').toBe(false)
  })

  it('posts to the real recover route with the audio-only title', async () => {
    let seen: { url: string; init: any } | null = null
    const fake = (async (url: any, init: any) => {
      seen = { url: String(url), init }
      return new Response(JSON.stringify({ filename: 'r.md' }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await requestQuarantineRecovery('meeting_1786237535593',
      { port: 3141, token: 'tok', fetchImpl: fake })
    expect(result).toMatchObject({ ok: true, status: 200, filename: 'r.md' })
    expect(seen!.url).toBe('http://127.0.0.1:3141/api/meeting/orphans/meeting_1786237535593/recover')
    expect(seen!.init.headers['X-Cos-Token']).toBe('tok')
    expect(JSON.parse(seen!.init.body)).toEqual({ title: AUTO_RECOVER_TITLE })
  })

  it('encodes the session id rather than pasting it into the path', async () => {
    let url = ''
    const fake = (async (u: any) => { url = String(u); return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
    await requestQuarantineRecovery('a/../b', { port: 3141, token: 't', fetchImpl: fake })
    expect(url).toContain('a%2F..%2Fb')
    expect(url).not.toContain('a/../b')
  })

  it('reports a failure without throwing, so one bad capture cannot kill the sweep', async () => {
    for (const [status, body] of [[422, '{"reason":"no_chunk_audio"}'], [500, 'oops']] as const) {
      const fake = (async () => new Response(body, { status })) as unknown as typeof fetch
      expect(await requestQuarantineRecovery('s1', { port: 3141, token: 't', fetchImpl: fake }))
        .toMatchObject({ ok: false, status })
    }
    const dead = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await requestQuarantineRecovery('s1', { port: 3141, token: 't', fetchImpl: dead }))
      .toMatchObject({ ok: false, status: 0, reason: 'request_failed' })
  })
})
