// Meeting audio retention, exercised against real files on disk.
//
// The properties that carry the weight are the ones protecting Miles's ability
// to review a week later: audio must survive the pending-batch purge that used
// to destroy it, a session whose age cannot be read must be KEPT, and the 8 GB
// cap must evict predictably rather than shaving chunks off arbitrary meetings.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir = ''
let mod: typeof import('./meeting-audio-archive.js')

const DAY = 24 * 60 * 60 * 1000

/** A session-audio directory shaped like the capture path writes it. */
function sourceSession(id: string, chunks: number, bytesEach = 3200): string {
  const src = join(dir, 'session-audio', id)
  mkdirSync(src, { recursive: true })
  for (let i = 0; i < chunks; i++) {
    writeFileSync(join(src, `chunk_${String(i).padStart(4, '0')}.wav`), Buffer.alloc(bytesEach, i + 1))
  }
  // Non-chunk residue the capture path also leaves behind.
  writeFileSync(join(src, '_batch_pending.marker'), String(Date.now()))
  return src
}

function ageSession(id: string, days: number): void {
  const root = join(dir, 'meeting-audio', id)
  const t = (Date.now() - days * DAY) / 1000
  for (const f of readdirSync(root)) utimesSync(join(root, f), t, t)
}

async function load(): Promise<void> {
  vi.resetModules()
  mod = await import('./meeting-audio-archive.js')
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cos-mtg-audio-'))
  process.env.COS_DATA_DIR = dir
  delete process.env.COS_MEETING_AUDIO
  delete process.env.COS_MEETING_AUDIO_RETENTION_DAYS
  delete process.env.COS_MEETING_AUDIO_MAX_BYTES
  await load()
})
afterEach(() => {
  delete process.env.COS_DATA_DIR
  delete process.env.COS_MEETING_AUDIO
  delete process.env.COS_MEETING_AUDIO_RETENTION_DAYS
  delete process.env.COS_MEETING_AUDIO_MAX_BYTES
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('archiving a session', () => {
  it('brings every chunk WAV across and ignores non-chunk residue', () => {
    const src = sourceSession('meeting_a', 5)
    const r = mod.archiveSessionAudio('meeting_a', src)
    expect(r.linked).toBe(5)
    expect(r.failed).toBe(0)
    expect(mod.listMeetingAudioChunks('meeting_a')).toEqual([0, 1, 2, 3, 4])
    // The batch marker is pipeline bookkeeping, not audio.
    expect(existsSync(join(dir, 'meeting-audio', 'meeting_a', '_batch_pending.marker'))).toBe(false)
  })

  it('uses HARD LINKS, so it costs no extra disk', () => {
    const src = sourceSession('meeting_b', 3)
    mod.archiveSessionAudio('meeting_b', src)
    const a = statSync(join(src, 'chunk_0000.wav'))
    const b = statSync(join(dir, 'meeting-audio', 'meeting_b', 'chunk_0000.wav'))
    expect(b.ino).toBe(a.ino)      // same inode — one copy of the bytes
    expect(b.nlink).toBeGreaterThanOrEqual(2)
  })

  it('SURVIVES the pending-batch purge that used to destroy this audio', () => {
    // The whole point. The batch pipeline deletes its directory when HQ polish
    // finishes; before this archive existed, that was the end of the audio.
    const src = sourceSession('meeting_c', 4)
    mod.archiveSessionAudio('meeting_c', src)
    rmSync(src, { recursive: true, force: true })

    expect(mod.listMeetingAudioChunks('meeting_c')).toEqual([0, 1, 2, 3])
    const path = mod.meetingAudioChunkPath('meeting_c', 2)!
    expect(readFileSync(path)).toEqual(Buffer.alloc(3200, 3))   // byte-identical
  })

  it('counts derived playback bytes without extending the raw retention age', () => {
    const src = sourceSession('meeting_playback_budget', 1, 3_200)
    mod.archiveSessionAudio('meeting_playback_budget', src)
    const retained = join(dir, 'meeting-audio', 'meeting_playback_budget')
    const raw = join(retained, 'chunk_0000.wav')
    const playback = join(retained, 'playback_v1_0000.wav')
    writeFileSync(playback, Buffer.alloc(2_400, 7))
    const old = (Date.now() - 6 * DAY) / 1_000
    utimesSync(raw, old, old)
    // A fresh replay cannot renew the session. One day later the raw evidence
    // crosses the seven-day window and the whole session must expire.
    const stats = mod.meetingAudioStats()
    expect(stats.bytes).toBe(5_600)
    const swept = mod.sweepMeetingAudio(Date.now() + DAY + 1_000)
    expect(swept.removed).toContain('meeting_playback_budget')
    expect(swept.bytesFreed).toBe(5_600)
  })

  it('is idempotent — re-archiving does not duplicate or fail', () => {
    const src = sourceSession('meeting_d', 3)
    expect(mod.archiveSessionAudio('meeting_d', src).linked).toBe(3)
    const again = mod.archiveSessionAudio('meeting_d', src)
    expect(again.linked).toBe(0)
    expect(again.failed).toBe(0)
    // Also zero COPIES: without the already-present skip, linkSync throws EEXIST
    // and the copy fallback silently overwrites, which looks identical on
    // `linked`/`failed` while rewriting every byte on every save.
    expect(again.copied).toBe(0)
    expect(mod.listMeetingAudioChunks('meeting_d')).toHaveLength(3)
  })

  it('never throws on the save path', () => {
    // Losing review audio must never cost a meeting.
    expect(() => mod.archiveSessionAudio('meeting_e', join(dir, 'nope'))).not.toThrow()
    expect(mod.archiveSessionAudio('meeting_e', join(dir, 'nope')).linked).toBe(0)
    writeFileSync(join(dir, 'meeting-audio'), 'a file where the directory goes')
    expect(() => mod.archiveSessionAudio('meeting_f', sourceSession('meeting_f', 2))).not.toThrow()
  })

  it('refuses a session id that could escape the directory', () => {
    const src = sourceSession('meeting_g', 2)
    for (const bad of ['../../etc', 'a/b', '..', '']) {
      expect(mod.archiveSessionAudio(bad, src).linked).toBe(0)
    }
  })

  it('writes nothing when retention is switched off', async () => {
    process.env.COS_MEETING_AUDIO = '0'
    await load()
    const src = sourceSession('meeting_h', 3)
    expect(mod.archiveSessionAudio('meeting_h', src).linked).toBe(0)
    expect(existsSync(join(dir, 'meeting-audio'))).toBe(false)
  })
})

describe('retention window', () => {
  it('defaults to 7 days, so a Friday meeting survives to the weekend', () => {
    // Miles's decision: review happens on weekends or free time, and 8 hours
    // cannot span that.
    expect(mod.meetingAudioTtlMs()).toBe(7 * DAY)
  })

  it('sweeps past the window and keeps what is inside it', () => {
    mod.archiveSessionAudio('meeting_old', sourceSession('meeting_old', 3))
    mod.archiveSessionAudio('meeting_new', sourceSession('meeting_new', 3))
    ageSession('meeting_old', 9)

    const r = mod.sweepMeetingAudio(Date.now())
    expect(r.removed).toEqual(['meeting_old'])
    expect(r.retained).toEqual(['meeting_new'])
    expect(r.bytesFreed).toBe(3 * 3200)
    expect(mod.listMeetingAudioChunks('meeting_old')).toEqual([])
    expect(mod.listMeetingAudioChunks('meeting_new')).toHaveLength(3)
  })

  it('keeps a session at 6 days and drops it at 8', () => {
    mod.archiveSessionAudio('meeting_six', sourceSession('meeting_six', 2))
    ageSession('meeting_six', 6)
    expect(mod.sweepMeetingAudio(Date.now()).removed).toEqual([])
    ageSession('meeting_six', 8)
    expect(mod.sweepMeetingAudio(Date.now()).removed).toEqual(['meeting_six'])
  })

  it('removes a derived cache orphan when its raw owner is gone', () => {
    const orphan = join(dir, 'meeting-audio', 'meeting_derived_only')
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, 'playback_v1_0000.wav'), Buffer.alloc(2_400, 7))

    const result = mod.sweepMeetingAudio(Date.now())
    expect(result.removed).toEqual(['meeting_derived_only'])
    expect(result.bytesFreed).toBe(2_400)
    expect(existsSync(orphan)).toBe(false)
  })

  it('retains an ambiguous derived directory when any unknown evidence is present', () => {
    const ambiguous = join(dir, 'meeting-audio', 'meeting_derived_with_evidence')
    mkdirSync(ambiguous, { recursive: true })
    writeFileSync(join(ambiguous, 'playback_v1_0000.wav'), Buffer.alloc(2_400, 7))
    writeFileSync(join(ambiguous, 'recovery-evidence.json'), '{"retained":true}')

    const result = mod.sweepMeetingAudio(Date.now())
    expect(result.removed).toEqual([])
    expect(result.retained).toEqual(['meeting_derived_with_evidence'])
    expect(existsSync(ambiguous)).toBe(true)
  })

  it('RETAINS a session whose age cannot be read', () => {
    // An unreadable stat treated as ancient would delete the audio a pending
    // review depends on.
    mkdirSync(join(dir, 'meeting-audio', 'meeting_blank'), { recursive: true })
    const r = mod.sweepMeetingAudio(Date.now())
    expect(r.removed).toEqual([])
    expect(r.retained).toEqual(['meeting_blank'])
  })

  it('honours the retention override', async () => {
    process.env.COS_MEETING_AUDIO_RETENTION_DAYS = '1'
    await load()
    expect(mod.meetingAudioTtlMs()).toBe(DAY)
  })

  it('ignores a nonsense override rather than deleting everything', async () => {
    for (const bad of ['0', '-3', 'soon', '']) {
      process.env.COS_MEETING_AUDIO_RETENTION_DAYS = bad
      await load()
      expect(mod.meetingAudioTtlMs(), bad).toBe(7 * DAY)
    }
  })

  it('is a no-op with no archive present', () => {
    expect(mod.sweepMeetingAudio(Date.now())).toEqual({ removed: [], retained: [], bytesFreed: 0 })
  })
})

describe('the 8 GB budget', () => {
  it('defaults to 8 GB, per Miles', () => {
    expect(mod.meetingAudioMaxBytes()).toBe(8 * 1024 * 1024 * 1024)
  })

  it('does nothing while under budget', () => {
    mod.archiveSessionAudio('meeting_small', sourceSession('meeting_small', 3))
    const r = mod.enforceMeetingAudioCap()
    expect(r.evicted).toEqual([])
    expect(r.bytesAfter).toBe(3 * 3200)
  })

  it('evicts OLDEST SESSIONS FIRST until it fits', () => {
    for (const [id, days] of [['m_oldest', 6], ['m_middle', 3], ['m_newest', 1]] as const) {
      mod.archiveSessionAudio(id, sourceSession(id, 10))   // 32 000 bytes each
      ageSession(id, days)
    }
    // Budget for roughly one session.
    const r = mod.enforceMeetingAudioCap(40_000)
    expect(r.evicted).toEqual(['m_oldest', 'm_middle'])
    expect(r.bytesAfter).toBeLessThanOrEqual(40_000)
    // The newest survives — the one most likely to still need reviewing.
    expect(mod.listMeetingAudioChunks('m_newest')).toHaveLength(10)
  })

  it('evicts WHOLE sessions, never part of one', () => {
    // Half a meeting's audio is a confusing artefact; predictable eviction beats
    // squeezing in a few more megabytes.
    mod.archiveSessionAudio('m_a', sourceSession('m_a', 10))
    ageSession('m_a', 5)
    mod.archiveSessionAudio('m_b', sourceSession('m_b', 10))
    mod.enforceMeetingAudioCap(35_000)
    for (const id of ['m_a', 'm_b']) {
      const n = mod.listMeetingAudioChunks(id).length
      expect(n === 0 || n === 10, `${id} kept ${n} chunks`).toBe(true)
    }
  })

  it('stops as soon as it is under budget rather than clearing the archive', () => {
    for (const [id, days] of [['m_1', 5], ['m_2', 4], ['m_3', 3], ['m_4', 2]] as const) {
      mod.archiveSessionAudio(id, sourceSession(id, 5))    // 16 000 each, 64 000 total
      ageSession(id, days)
    }
    const r = mod.enforceMeetingAudioCap(40_000)
    expect(r.evicted).toEqual(['m_1', 'm_2'])              // just enough
    expect(mod.listMeetingAudioChunks('m_3')).toHaveLength(5)
    expect(mod.listMeetingAudioChunks('m_4')).toHaveLength(5)
  })

  it('honours a byte override', async () => {
    process.env.COS_MEETING_AUDIO_MAX_BYTES = '1024'
    await load()
    expect(mod.meetingAudioMaxBytes()).toBe(1024)
  })

  it('ignores a nonsense byte override', async () => {
    for (const bad of ['0', '-1', 'lots', '']) {
      process.env.COS_MEETING_AUDIO_MAX_BYTES = bad
      await load()
      expect(mod.meetingAudioMaxBytes(), bad).toBe(8 * 1024 * 1024 * 1024)
    }
  })
})

describe('serving one chunk back', () => {
  it('resolves a retained chunk by index', () => {
    mod.archiveSessionAudio('meeting_p', sourceSession('meeting_p', 12))
    const p = mod.meetingAudioChunkPath('meeting_p', 7)
    expect(p).toContain('chunk_0007.wav')
    expect(readFileSync(p!)).toEqual(Buffer.alloc(3200, 8))
  })

  it('returns null for a chunk that is not retained', () => {
    mod.archiveSessionAudio('meeting_q', sourceSession('meeting_q', 3))
    expect(mod.meetingAudioChunkPath('meeting_q', 99)).toBeNull()
    expect(mod.meetingAudioChunkPath('meeting_never', 0)).toBeNull()
  })

  it('refuses a traversing index or session', () => {
    mod.archiveSessionAudio('meeting_r', sourceSession('meeting_r', 3))
    for (const bad of [-1, 1.5, NaN]) expect(mod.meetingAudioChunkPath('meeting_r', bad)).toBeNull()
    expect(mod.meetingAudioChunkPath('../../etc/passwd', 0)).toBeNull()
  })
})

describe('health stats', () => {
  it('reports the budget and window alongside usage', () => {
    mod.archiveSessionAudio('meeting_s1', sourceSession('meeting_s1', 4))
    mod.archiveSessionAudio('meeting_s2', sourceSession('meeting_s2', 6))
    const st = mod.meetingAudioStats()
    expect(st).toMatchObject({
      enabled: true, sessions: 2, bytes: 10 * 3200,
      retentionDays: 7, maxBytes: 8 * 1024 * 1024 * 1024,
    })
    expect(st.oldestAgeHours).not.toBeNull()
  })

  it('does not count an empty session directory as retained audio', () => {
    mkdirSync(join(dir, 'meeting-audio', 'meeting_empty'), { recursive: true })
    expect(mod.meetingAudioStats().sessions).toBe(0)
  })

  it('reports an empty archive without inventing an age', () => {
    const st = mod.meetingAudioStats()
    expect(st.sessions).toBe(0)
    expect(st.bytes).toBe(0)
    expect(st.oldestAgeHours).toBeNull()
  })
})

describe('sizing against real recording volume', () => {
  it('a week at the measured peak rate stays inside the budget', () => {
    // Measured over the 14 days to 2026-08-06: 3.1 h/day mean, 6.9 h peak.
    // 16 kHz mono 16-bit = 32 000 B/s. This asserts the DECISION, so a future
    // change to the cap or the window has to confront the arithmetic.
    const bytesPerHour = 32_000 * 3600
    expect(6.9 * 7 * bytesPerHour).toBeLessThan(mod.meetingAudioMaxBytes())
    // And that the budget is not so large it is meaningless — a sustained
    // 12 h/day week would exceed it, which is what makes it a real backstop.
    expect(12 * 7 * bytesPerHour).toBeGreaterThan(mod.meetingAudioMaxBytes())
  })
})

describe('the retention pass run by the interval', () => {
  it('expires FIRST, then enforces the budget', () => {
    // Order is load-bearing. Cap-first would count the expired session's bytes
    // against the budget and evict extra sessions that were still in-window.
    mod.archiveSessionAudio('m_expired', sourceSession('m_expired', 10))
    ageSession('m_expired', 30)
    mod.archiveSessionAudio('m_fresh', sourceSession('m_fresh', 10))

    process.env.COS_MEETING_AUDIO_MAX_BYTES = String(40_000)
    const { swept, capped } = mod.runMeetingAudioRetention(Date.now())

    // The expired session left via EXPIRY, not eviction...
    expect(swept.removed).toEqual(['m_expired'])
    expect(capped.evicted).toEqual([])
    // ...and the in-window session survived, which cap-first would have taken.
    expect(mod.listMeetingAudioChunks('m_fresh')).toHaveLength(10)
  })

  it('still enforces the budget when nothing has expired', () => {
    mod.archiveSessionAudio('m_1', sourceSession('m_1', 10))
    ageSession('m_1', 3)
    mod.archiveSessionAudio('m_2', sourceSession('m_2', 10))
    process.env.COS_MEETING_AUDIO_MAX_BYTES = String(40_000)

    const { swept, capped } = mod.runMeetingAudioRetention(Date.now())
    expect(swept.removed).toEqual([])
    expect(capped.evicted).toEqual(['m_1'])
  })
})

describe('the health hot path', () => {
  it('reports the window without touching the filesystem', () => {
    // The /audio route used to statSync every retained chunk to report one
    // config number.
    expect(mod.meetingAudioRetentionDays()).toBe(7)
  })

  it('caches stats, so a 12-second health poll does not re-walk the archive', () => {
    // Uncached this stats EVERY chunk — 2,000-3,000 files at the measured rate,
    // synchronously, on the loop that ingests live audio.
    mod.archiveSessionAudio('m_cache', sourceSession('m_cache', 5))
    const first = mod.meetingAudioStats()
    expect(first.sessions).toBe(1)

    // Add a session; the cached answer must not change yet.
    mod.archiveSessionAudio('m_cache2', sourceSession('m_cache2', 5))
    expect(mod.meetingAudioStats().sessions).toBe(1)

    mod.invalidateMeetingAudioStats()
    expect(mod.meetingAudioStats().sessions).toBe(2)
  })

  it('invalidates the cache when retention actually removes something', () => {
    // Otherwise health keeps reporting the pre-sweep usage, and an operator
    // watching the 8 GB budget sees a number that never moves.
    mod.archiveSessionAudio('m_old', sourceSession('m_old', 5))
    ageSession('m_old', 20)
    mod.archiveSessionAudio('m_new', sourceSession('m_new', 5))
    expect(mod.meetingAudioStats().sessions).toBe(2)   // warms the cache

    const { swept } = mod.runMeetingAudioRetention(Date.now())
    expect(swept.removed).toEqual(['m_old'])
    expect(mod.meetingAudioStats().sessions).toBe(1)   // no stale figure
  })

  it('does not invalidate when retention changed nothing', () => {
    mod.archiveSessionAudio('m_stable', sourceSession('m_stable', 5))
    mod.meetingAudioStats()
    const { swept, capped } = mod.runMeetingAudioRetention(Date.now())
    expect(swept.removed).toEqual([])
    expect(capped.evicted).toEqual([])
    expect(mod.meetingAudioStats().sessions).toBe(1)
  })
})

describe('ext-audio fallback', () => {
  // The archive is FORWARD-ONLY, so on upgrade day there is nothing to play.
  // ext-audio already holds 72 hours of unidentified-voice audio keyed by the
  // same raw chunk index — verified across 14 real meetings at 90-100% match.
  function seedExt(sessionId: string, indices: number[], ts = 1785846879259): void {
    const d = join(dir, 'ext-audio', sessionId)
    mkdirSync(d, { recursive: true })
    for (const i of indices) writeFileSync(join(d, `ext_chunk${i}_${ts + i}.wav`), Buffer.alloc(96, i + 1))
  }

  it('lists the raw chunk indices ext-audio holds', () => {
    seedExt('meeting_x', [9, 10, 14, 22])
    expect(mod.listExtAudioChunks('meeting_x')).toEqual([9, 10, 14, 22])
  })

  it('resolves a chunk by its RAW index, matching the real filename shape', () => {
    seedExt('meeting_y', [16])
    const p = mod.extAudioChunkPath('meeting_y', 16)
    expect(p).toContain('ext_chunk16_')
    expect(readFileSync(p!)).toEqual(Buffer.alloc(96, 17))
  })

  it('does not confuse chunk 1 with chunk 16', () => {
    // A prefix match on `ext_chunk1` would also hit ext_chunk16, ext_chunk10…
    // and play the wrong segment.
    seedExt('meeting_z', [1, 10, 16])
    expect(mod.extAudioChunkPath('meeting_z', 1)).toContain('ext_chunk1_')
    expect(mod.extAudioChunkPath('meeting_z', 1)).not.toContain('ext_chunk16_')
    expect(mod.extAudioChunkPath('meeting_z', 1)).not.toContain('ext_chunk10_')
  })

  it('returns null for a chunk with no ext audio', () => {
    seedExt('meeting_w', [5])
    expect(mod.extAudioChunkPath('meeting_w', 99)).toBeNull()
    expect(mod.extAudioChunkPath('meeting_none', 0)).toBeNull()
    expect(mod.listExtAudioChunks('meeting_none')).toEqual([])
  })

  it('refuses a traversing session id', () => {
    for (const bad of ['../../etc', 'a/b', '..']) {
      expect(mod.extAudioChunkPath(bad, 0)).toBeNull()
      expect(mod.listExtAudioChunks(bad)).toEqual([])
    }
  })

  it('takes the newest file when a chunk was written more than once', () => {
    const d = join(dir, 'ext-audio', 'meeting_dup')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'ext_chunk7_1000000000001.wav'), Buffer.alloc(96, 1))
    writeFileSync(join(d, 'ext_chunk7_1000000000002.wav'), Buffer.alloc(96, 2))
    expect(readFileSync(mod.extAudioChunkPath('meeting_dup', 7)!)).toEqual(Buffer.alloc(96, 2))
  })
})
