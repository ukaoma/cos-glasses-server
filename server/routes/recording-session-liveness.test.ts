// A leaked recording session must not be able to block every restart.
//
// THE INCIDENT (2026-08-06, twice, on 6.21.20 and 6.21.22). The maintenance
// drain gate counts `sessions.size`. A session whose phone dropped
// mid-recording without sending a close pins that count at 1 indefinitely, so
// Install, Repair, Restart and Update Server each drain `recording_session=1`,
// time out after 60s, and fail — with no user-visible reason. `/api/meeting/
// orphans` reported 0 the whole time, because it reads the quarantine directory
// and the counter reads the in-memory session map. Two stores, one lock.
//
// THE TRAP THESE PIN. The intuitive discriminator — "activeTotal >= 1 with
// oldestWorkStartedAt: null means leaked" — is WRONG. `recording_session`
// reaches the gate via `extraActiveByKind`, and the snapshot's oldest-start
// loop walks only tracked work entries, so an extra count never carries a
// timestamp. EVERY recording session reads `oldestWorkStartedAt: null`, healthy
// or not. Acting on that would strand live recordings. Only `lastActivityAt`
// separates them, and these tests fail if anyone reverts to the other reading.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dataDir = ''

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'session-liveness-'))
  process.env.COS_DATA_DIR = dataDir
  vi.resetModules()
})

afterEach(() => {
  delete process.env.COS_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
  vi.resetModules()
})

/** Reach into the module's session map the way the running server fills it. */
async function seedSession(sessionId: string, lastActivityAt: number, chunks = 3) {
  const mod: any = await import('./transcribe-stream.js')
  const map: Map<string, any> = mod.__sessionsForTests
  // Setup gate. Guarding on this instead would let every case below no-op.
  if (!map) throw new Error('__sessionsForTests missing — the test seam is gone')
  map.set(sessionId, {
    chunks: Array.from({ length: chunks }, (_, i) => ({ index: i, text: 'x' })),
    startTime: lastActivityAt,
    title: sessionId,
    lastActivityAt,
  })
  if (!map.has(sessionId)) throw new Error(`seed failed for ${sessionId}`)
  return mod
}

describe('recording session liveness', () => {
  it('exposes a stale threshold well under the 4h chunk-retention window', async () => {
    const { RECORDING_SESSION_STALE_MS } = await import('./transcribe-stream.js')
    const fourHours = 4 * 60 * 60 * 1000

    // Long enough to survive a backgrounded phone buffering to IndexedDB, a
    // network drop, or a long pause — those run to minutes.
    expect(RECORDING_SESSION_STALE_MS).toBeGreaterThanOrEqual(10 * 60 * 1000)
    // Short enough that a leak cannot hold a restart for an hour, as it did.
    expect(RECORDING_SESSION_STALE_MS).toBeLessThan(fourHours)
  })

  it('counts nothing when there are no sessions', async () => {
    const { getTranscriptionSessionLiveness } = await import('./transcribe-stream.js')
    const result = getTranscriptionSessionLiveness()
    expect(result.live).toBe(0)
    expect(result.stale).toBe(0)
    expect(result.staleSessions).toEqual([])
  })

  it('treats a recently-active session as live so a real recording still blocks', async () => {
    const now = Date.now()
    const mod = await seedSession('meeting_live_1', now - 5_000)

    const result = mod.getTranscriptionSessionLiveness(now)
    expect(result.live).toBe(1)
    expect(result.stale).toBe(0)
  })

  it('treats a long-silent session as stale so it stops blocking', async () => {
    const now = Date.now()
    const mod = await seedSession('meeting_phantom_1', now - 54 * 60 * 1000)

    const result = mod.getTranscriptionSessionLiveness(now)
    // 54 minutes is the real phantom from 2026-08-06.
    expect(result.live).toBe(0)
    expect(result.stale).toBe(1)
    expect(result.staleSessions[0].sessionId).toBe('meeting_phantom_1')
    expect(result.staleSessions[0].silentForMs).toBeGreaterThan(30 * 60 * 1000)
  })

  it('separates a live session from a phantom in the same map', async () => {
    const now = Date.now()
    await seedSession('meeting_phantom_2', now - 90 * 60 * 1000)
    const mod = await seedSession('meeting_live_2', now - 2_000)

    const result = mod.getTranscriptionSessionLiveness(now)
    // The live recording must still hold the gate; only the phantom is released.
    expect(result.live).toBe(1)
    expect(result.stale).toBe(1)
  })

  it('never deletes a stale session — it is surfaced, not reaped', async () => {
    const now = Date.now()
    const mod = await seedSession('meeting_phantom_3', now - 60 * 60 * 1000)

    mod.getTranscriptionSessionLiveness(now)
    // The chunks stay recoverable. Reaping here would destroy audio that the
    // 4h durable window exists to protect.
    expect(mod.getActiveTranscriptionSessionCount()).toBe(1)
    expect(mod.getTranscriptionSessionLiveness(now).stale).toBe(1)
  })
})

describe('an EMPTY session must not hold the restart lock for 30 minutes', () => {
  // Observed 2026-08-10 on 6.24.0: meeting_1786393815060_tp693w started, received ONE
  // 5.6s chunk that transcribed to empty, stopped 6.2 seconds later, and then blocked
  // Update Server. Correct per the old rule — 13 minutes idle is inside the 30-minute
  // grace — but the grace exists to protect a transcript, and there was none.

  it('is stale once idle past the empty window, with no canonical text', async () => {
    const mod: any = await import('./transcribe-stream.js')
    const now = Date.now()
    await seedSession('empty-aborted', now - mod.EMPTY_SESSION_STALE_MS - 1_000, 0)
    const result = mod.getTranscriptionSessionLiveness(now)
    expect(result.live).toBe(0)
    expect(result.stale).toBe(1)
    expect(result.staleSessions[0]).toMatchObject({ sessionId: 'empty-aborted', chunks: 0 })
  })

  it('still protects an empty session that only just went quiet', async () => {
    // A recording genuinely starting has no chunk for its first interval. Reaping at
    // once would kill it before its first chunk lands.
    const mod: any = await import('./transcribe-stream.js')
    const now = Date.now()
    await seedSession('just-started', now - 20_000, 0)
    expect(mod.getTranscriptionSessionLiveness(now).live).toBe(1)
  })

  it('NEVER reaps a session that has real text, however short the idle', async () => {
    const mod: any = await import('./transcribe-stream.js')
    const now = Date.now()
    await seedSession('has-text', now - mod.EMPTY_SESSION_STALE_MS - 60_000, 3)
    // Idle well past the empty window, but it has a transcript, so only the 30-minute
    // rule may touch it.
    expect(mod.getTranscriptionSessionLiveness(now).live).toBe(1)
  })

  it('the empty window is far shorter than the full one, and both still apply', async () => {
    const mod: any = await import('./transcribe-stream.js')
    expect(mod.EMPTY_SESSION_STALE_MS).toBeLessThan(mod.RECORDING_SESSION_STALE_MS)
    expect(mod.EMPTY_SESSION_STALE_MS).toBe(2 * 60_000)
    const now = Date.now()
    // A session WITH text is still reaped by the 30-minute rule.
    await seedSession('old-with-text', now - mod.RECORDING_SESSION_STALE_MS - 1_000, 4)
    expect(mod.getTranscriptionSessionLiveness(now).stale).toBe(1)
  })

  it('counts canonical text, not sparse array length', async () => {
    // A silent chunk carries no text and lands in emptyCompletions. Counting
    // chunks.length would read an aborted session as having content.
    const mod: any = await import('./transcribe-stream.js')
    const map: Map<string, any> = mod.__sessionsForTests
    const now = Date.now()
    const sparse: any[] = []
    sparse[4] = { index: 4, text: '' }   // arrived, transcribed to silence
    map.set('sparse-silent', {
      chunks: sparse, startTime: now - 600_000, title: 'x',
      lastActivityAt: now - mod.EMPTY_SESSION_STALE_MS - 1_000,
    })
    const result = mod.getTranscriptionSessionLiveness(now)
    expect(result.stale).toBe(1)
    expect(result.staleSessions[0].chunks).toBe(0)
  })
})
