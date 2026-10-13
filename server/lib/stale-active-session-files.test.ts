// 6.71.14: the stale active-session sweep and the capture disposition it and the
// status route read. Pure lib tests over temp dirs; the wiring into the real module
// is covered by routes/transcribe-stream-stale-session.test.ts.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LOCAL_FIRST_MEETING_IDLE_RETENTION_MS } from './local-first-meetings-contract.js'
import {
  STALE_ACTIVE_SESSION_FILE_RETENTION_MS,
  activeSessionFileActivity,
  purgeExpiredStaleActiveSessionFiles,
  sweepStaleActiveSessionFiles,
} from './stale-active-session-files.js'
import {
  QUARANTINE_MANIFEST,
  markRecovered,
  markRecoveredNoSpeech,
  readCaptureDisposition,
} from './unsaved-audio-quarantine.js'

const roots: string[] = []
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'cos-stale-active-'))
  roots.push(root)
  return root
}
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-10-13T12:00:00Z')
const SID = 'meeting_1791831725740_e5c1fv'

function writeActive(dir: string, sessionId: string, lastActivityAt: number | undefined): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${sessionId}.json`)
  writeFileSync(path, JSON.stringify({ sessionId, startTime: (lastActivityAt ?? NOW) - 10_000, lastActivityAt, chunks: [], chunksIndexed: [], receivedIndices: [0, 1] }))
  return path
}

describe('sweepStaleActiveSessionFiles', () => {
  it('moves a not-live file idle past the 4 h horizon aside, with a reason beside it', () => {
    const root = temp(), dir = join(root, 'active-sessions'), target = join(root, 'stale-active-session-files')
    writeActive(dir, SID, NOW - LOCAL_FIRST_MEETING_IDLE_RETENTION_MS - 1)
    const moves = sweepStaleActiveSessionFiles({ dir, targetDir: target, isLive: () => false, now: NOW, idleRetentionMs: LOCAL_FIRST_MEETING_IDLE_RETENTION_MS })
    expect(moves.map(m => [m.sessionId, m.reason])).toEqual([[SID, 'not_live_idle_expired']])
    expect(existsSync(join(dir, `${SID}.json`)), 'the source must be gone').toBe(false)
    const moved = readdirSync(target).sort()
    expect(moved).toEqual([`${SID}.${NOW}.json`, `${SID}.${NOW}.reason.json`])
    // Moved, not rewritten: the original content is intact.
    expect(JSON.parse(readFileSync(join(target, `${SID}.${NOW}.json`), 'utf8')).receivedIndices).toEqual([0, 1])
    const reason = JSON.parse(readFileSync(join(target, `${SID}.${NOW}.reason.json`), 'utf8'))
    expect(reason).toMatchObject({ sessionId: SID, reason: 'not_live_idle_expired', movedAt: new Date(NOW).toISOString() })
  })

  it('acts AT the horizon, the same instant the session itself would be promoted or tombstoned', () => {
    const root = temp(), dir = join(root, 'active-sessions'), target = join(root, 'stale')
    writeActive(dir, SID, NOW - LOCAL_FIRST_MEETING_IDLE_RETENTION_MS)
    expect(sweepStaleActiveSessionFiles({ dir, targetDir: target, isLive: () => false, now: NOW, idleRetentionMs: LOCAL_FIRST_MEETING_IDLE_RETENTION_MS })
      .map(m => m.sessionId)).toEqual([SID])
  })

  it('keeps a not-live file still inside the horizon', () => {
    const root = temp(), dir = join(root, 'active-sessions'), target = join(root, 'stale')
    writeActive(dir, SID, NOW - LOCAL_FIRST_MEETING_IDLE_RETENTION_MS + 60_000)
    expect(sweepStaleActiveSessionFiles({ dir, targetDir: target, isLive: () => false, now: NOW, idleRetentionMs: LOCAL_FIRST_MEETING_IDLE_RETENTION_MS })).toEqual([])
    expect(existsSync(join(dir, `${SID}.json`))).toBe(true)
  })

  it('never touches a live session, however old its file looks', () => {
    const root = temp(), dir = join(root, 'active-sessions'), target = join(root, 'stale')
    writeActive(dir, SID, NOW - 30 * HOUR)
    writeActive(dir, 'meeting_other_dead', NOW - 30 * HOUR)
    const moves = sweepStaleActiveSessionFiles({ dir, targetDir: target, isLive: id => id === SID, now: NOW, idleRetentionMs: LOCAL_FIRST_MEETING_IDLE_RETENTION_MS })
    expect(moves.map(m => m.sessionId)).toEqual(['meeting_other_dead'])
    expect(existsSync(join(dir, `${SID}.json`)), 'a live session file was moved').toBe(true)
  })

  it('ages a file without lastActivityAt by its mtime, and skips names that are not session files', () => {
    const root = temp(), dir = join(root, 'active-sessions'), target = join(root, 'stale')
    const legacy = writeActive(dir, 'meeting_legacy_one', undefined)
    const old = new Date(NOW - 5 * HOUR)
    utimesSync(legacy, old, old)
    writeFileSync(join(dir, 'meeting_x.json.tmp-123'), '{}')
    expect(activeSessionFileActivity(legacy)).toBe(old.getTime())
    const moves = sweepStaleActiveSessionFiles({ dir, targetDir: target, isLive: () => false, now: NOW, idleRetentionMs: LOCAL_FIRST_MEETING_IDLE_RETENTION_MS })
    expect(moves.map(m => m.sessionId)).toEqual(['meeting_legacy_one'])
    expect(existsSync(join(dir, 'meeting_x.json.tmp-123'))).toBe(true)
  })

  it('a moved file is stamped at move time, so the purge keeps it for the full retention', () => {
    const root = temp(), dir = join(root, 'active-sessions'), target = join(root, 'stale')
    const path = writeActive(dir, SID, NOW - 30 * 24 * HOUR)
    const ancient = new Date(NOW - 30 * 24 * HOUR)
    utimesSync(path, ancient, ancient)
    sweepStaleActiveSessionFiles({ dir, targetDir: target, isLive: () => false, now: NOW, idleRetentionMs: LOCAL_FIRST_MEETING_IDLE_RETENTION_MS })
    expect(statSync(join(target, `${SID}.${NOW}.json`)).mtimeMs).toBe(NOW)
    expect(purgeExpiredStaleActiveSessionFiles(target, NOW + 60_000), 'purged on the next tick: a move became a delete').toBe(0)
    expect(purgeExpiredStaleActiveSessionFiles(target, NOW + STALE_ACTIVE_SESSION_FILE_RETENTION_MS + 1)).toBe(2)
    expect(readdirSync(target)).toEqual([])
  })
})

describe('readCaptureDisposition', () => {
  function quarantine(root: string, sessionId: string, dirName = sessionId): string {
    const dir = join(root, dirName)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'chunk_0000.wav'), Buffer.alloc(64))
    writeFileSync(join(dir, 'chunk_0001.wav'), Buffer.alloc(64))
    writeFileSync(join(dir, QUARANTINE_MANIFEST), JSON.stringify({
      schemaVersion: 1, sessionId, quarantinedAt: new Date(NOW).toISOString(), reason: 'idle_expiry_unsaved', chunkFiles: 2, bytes: 128,
    }))
    return dir
  }

  it('is null when the quarantine holds nothing for the session', () => {
    expect(readCaptureDisposition(SID, temp())).toBeNull()
  })

  it('quarantined, then no_speech after the silent receipt, then recovered for a saved one', () => {
    const root = temp()
    const dir = quarantine(root, SID)
    expect(readCaptureDisposition(SID, root, 72 * HOUR)).toMatchObject({
      kind: 'quarantined', chunkFiles: 2, quarantineReason: 'idle_expiry_unsaved', receiptedAt: null, savedFilename: null,
      retainedUntil: new Date(NOW + 72 * HOUR).toISOString(),
    })
    markRecoveredNoSpeech(dir, 2)
    const silent = readCaptureDisposition(SID, root)
    expect(silent?.kind).toBe('no_speech')
    expect(typeof silent?.receiptedAt).toBe('string')

    const other = quarantine(root, 'meeting_saved_one')
    markRecovered(other, '2026-10-12_Recovered_capture.md')
    expect(readCaptureDisposition('meeting_saved_one', root)).toMatchObject({ kind: 'recovered', savedFilename: '2026-10-12_Recovered_capture.md' })
  })

  it('finds a timestamp-suffixed quarantine dir, and counts an unreadable receipt as finished', () => {
    const root = temp()
    const dir = quarantine(root, SID, `${SID}.1791900000000`)
    writeFileSync(join(dir, '_recovered.json'), '{torn')
    expect(readCaptureDisposition(SID, root)).toMatchObject({ kind: 'recovered', dirName: `${SID}.1791900000000` })
  })
})
