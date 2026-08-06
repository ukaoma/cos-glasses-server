// Does the SAVE PATH actually retain audio for review?
//
// The archive is unit-tested and the routes that serve it are tested. This file
// tests the WIRING, because a perfect archive that the save path never calls
// leaves the audio exactly as doomed as before — and a grep for
// `archiveSessionAudio(` would pass while the call sat after the rename, when the
// source directory is already gone.
//
// It drives the real exported `moveSessionAudioToPending`, which is the single
// choke point every saved meeting's audio passes through.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir = ''
let stream: typeof import('./transcribe-stream.js')
let archive: typeof import('../lib/meeting-audio-archive.js')

/** session-audio as the capture path writes it, one distinct byte per chunk. */
function seedSessionAudio(id: string, chunks: number): string {
  const src = join(dir, 'session-audio', id)
  mkdirSync(src, { recursive: true })
  for (let i = 0; i < chunks; i++) {
    writeFileSync(join(src, `chunk_${String(i).padStart(4, '0')}.wav`), Buffer.alloc(128, i + 1))
  }
  return src
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cos-wire-audio-'))
  process.env.COS_DATA_DIR = dir
  delete process.env.COS_MEETING_AUDIO
  vi.resetModules()
  stream = await import('./transcribe-stream.js')
  archive = await import('../lib/meeting-audio-archive.js')
})
afterEach(() => {
  delete process.env.COS_DATA_DIR
  delete process.env.COS_MEETING_AUDIO
  vi.resetModules()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('saving a meeting retains its audio for review', () => {
  it('archives every chunk when the audio moves to pending-batch', async () => {
    const src = seedSessionAudio('meeting_w1', 6)
    const dest = stream.moveSessionAudioToPending('meeting_w1')

    expect(dest).not.toBeNull()
    // The pipeline still got its copy — the batch path is unchanged.
    expect(readdirSync(dest!).filter(f => f.endsWith('.wav'))).toHaveLength(6)
    // And review has one too.
    expect(archive.listMeetingAudioChunks('meeting_w1')).toEqual([0, 1, 2, 3, 4, 5])
    expect(existsSync(src)).toBe(false)     // source was renamed away
  })

  it('archives BEFORE the rename, so the source still exists to link from', async () => {
    // This is the ordering the mutation pass exposed: calling the archive after
    // renameSync leaves nothing to link, and the audio dies silently.
    seedSessionAudio('meeting_w2', 3)
    stream.moveSessionAudioToPending('meeting_w2')
    expect(archive.listMeetingAudioChunks('meeting_w2')).toHaveLength(3)
  })

  it('keeps the audio playable after the batch directory is purged', async () => {
    // The actual failure mode being fixed: HQ polish finishes, the pipeline
    // deletes its directory, and before this wiring that ended the audio.
    seedSessionAudio('meeting_w3', 4)
    const dest = stream.moveSessionAudioToPending('meeting_w3')
    rmSync(dest!, { recursive: true, force: true })

    const path = archive.meetingAudioChunkPath('meeting_w3', 2)
    expect(path).not.toBeNull()
    expect(readFileSync(path!)).toEqual(Buffer.alloc(128, 3))
  })

  it('costs no extra disk — the archive shares the pipeline copy\'s inodes', async () => {
    seedSessionAudio('meeting_w4', 3)
    const dest = stream.moveSessionAudioToPending('meeting_w4')
    const { statSync } = await import('node:fs')
    const a = statSync(join(dest!, 'chunk_0000.wav'))
    const b = statSync(archive.meetingAudioChunkPath('meeting_w4', 0)!)
    expect(b.ino).toBe(a.ino)
  })

  it('still moves the audio to pending-batch when review retention is OFF', async () => {
    // Retention is a review convenience; it must never be able to break the
    // re-transcription pipeline.
    process.env.COS_MEETING_AUDIO = '0'
    vi.resetModules()
    stream = await import('./transcribe-stream.js')
    archive = await import('../lib/meeting-audio-archive.js')

    seedSessionAudio('meeting_w5', 3)
    const dest = stream.moveSessionAudioToPending('meeting_w5')
    expect(dest).not.toBeNull()
    expect(readdirSync(dest!).filter(f => f.endsWith('.wav'))).toHaveLength(3)
    expect(archive.listMeetingAudioChunks('meeting_w5')).toEqual([])
  })

  it('returns null for an unknown session without creating an archive entry', async () => {
    expect(stream.moveSessionAudioToPending('meeting_nope')).toBeNull()
    expect(archive.listMeetingAudioChunks('meeting_nope')).toEqual([])
  })
}, 30_000)
