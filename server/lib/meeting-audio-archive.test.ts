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

