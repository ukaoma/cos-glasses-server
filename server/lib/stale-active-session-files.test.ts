// 6.71.14: the stale active-session sweep and the capture disposition it and the
// status route read. Pure lib tests over temp dirs; the wiring into the real module
// is covered by routes/transcribe-stream-stale-session.test.ts.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LOCAL_FIRST_MEETING_IDLE_RETENTION_MS } from './local-first-meetings-contract.js'
import {
  STALE_ACTIVE_SESSION_FILE_RETENTION_MS,
  activeSessionFileActivity,
  moveActiveSessionFileAside,
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
// The real clock, not a fixed date: the sweep reads real file mtimes, so a fixed NOW
// would make these tests depend on when they run.
const NOW = Date.now()
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
    // mtime is float ms; utimes can land a fraction of a ms below the requested time.
    expect(Math.round(activeSessionFileActivity(legacy)!)).toBe(old.getTime())
    const moves = sweepStaleActiveSessionFiles({ dir, targetDir: target, isLive: () => false, now: NOW, idleRetentionMs: LOCAL_FIRST_MEETING_IDLE_RETENTION_MS })
    expect(moves.map(m => m.sessionId)).toEqual(['meeting_legacy_one'])
    expect(existsSync(join(dir, 'meeting_x.json.tmp-123'))).toBe(true)
  })

  it('a future-dated lastActivityAt cannot pin a dead file: the earlier of it and the file mtime is used', () => {
    const root = temp(), dir = join(root, 'active-sessions'), target = join(root, 'stale')
    const path = writeActive(dir, SID, NOW + 365 * 24 * HOUR)
    const old = new Date(NOW - LOCAL_FIRST_MEETING_IDLE_RETENTION_MS - 60_000)
    utimesSync(path, old, old)
    expect(Math.round(activeSessionFileActivity(path)!)).toBe(old.getTime())
    expect(sweepStaleActiveSessionFiles({ dir, targetDir: target, isLive: () => false, now: NOW, idleRetentionMs: LOCAL_FIRST_MEETING_IDLE_RETENTION_MS })
      .map(m => m.sessionId)).toEqual([SID])
  })

  it('the reason is written atomically BEFORE the move; if it cannot be written nothing moves', () => {
    const root = temp(), dir = join(root, 'active-sessions'), target = join(root, 'stale')
    writeActive(dir, SID, NOW - 5 * HOUR)
    mkdirSync(target, { recursive: true })
    chmodSync(target, 0o500)
    try {
      const path = join(dir, `${SID}.json`)
      expect(moveActiveSessionFileAside(path, SID, target, 'not_live_idle_expired', NOW)).toBeNull()
      expect(existsSync(path), 'the source must stay when the reason could not be written').toBe(true)
    } finally {
      chmodSync(target, 0o700)
    }
    expect(readdirSync(target)).toEqual([])
  })

  it('two moves of the same id in the same millisecond do not overwrite each other', () => {
    const root = temp(), dir = join(root, 'active-sessions'), target = join(root, 'stale')
    const path = writeActive(dir, SID, NOW - 5 * HOUR)
    const first = moveActiveSessionFileAside(path, SID, target, 'not_live_idle_expired', NOW)
    writeActive(dir, SID, NOW - 5 * HOUR)
    const second = moveActiveSessionFileAside(path, SID, target, 'not_live_idle_expired', NOW)
    expect(first).not.toBe(second)
    expect(readdirSync(target).sort()).toEqual([`${SID}.${NOW}-1.json`, `${SID}.${NOW}-1.reason.json`, `${SID}.${NOW}.json`, `${SID}.${NOW}.reason.json`])
  })

  it('the purge ages by the move time in the NAME, never mtime, and leaves names it cannot date', () => {
    const root = temp(), target = join(root, 'stale')
    mkdirSync(target, { recursive: true })
    const moved = NOW - STALE_ACTIVE_SESSION_FILE_RETENTION_MS - 1
    for (const name of [`${SID}.${moved}.json`, `${SID}.${moved}.reason.json`, `${SID}.${NOW}.json`, 'unknown.json']) {
      writeFileSync(join(target, name), '{}')
    }
    // Fresh mtimes everywhere: a mtime-based purge would remove nothing.
    expect(purgeExpiredStaleActiveSessionFiles(target, NOW)).toBe(2)
    expect(readdirSync(target).sort()).toEqual([`${SID}.${NOW}.json`, 'unknown.json'])
    // An ancient mtime on a freshly moved file does not get it purged.
    const ancient = new Date(NOW - 30 * 24 * HOUR)
    utimesSync(join(target, `${SID}.${NOW}.json`), ancient, ancient)
    utimesSync(join(target, 'unknown.json'), ancient, ancient)
    expect(purgeExpiredStaleActiveSessionFiles(target, NOW + 60_000)).toBe(0)
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

  it('covers EVERY dir for the id: any unrecovered one means quarantined; else a saved recovery outranks no_speech', () => {
    const root = temp()
    markRecoveredNoSpeech(quarantine(root, SID), 1)
    expect(readCaptureDisposition(SID, root)?.kind).toBe('no_speech')
    const second = quarantine(root, SID, `${SID}.1791900000000`)
    expect(readCaptureDisposition(SID, root)).toMatchObject({ kind: 'quarantined', dirName: `${SID}.1791900000000` })
    markRecovered(second, 'saved.md')
    expect(readCaptureDisposition(SID, root)).toMatchObject({ kind: 'recovered', savedFilename: 'saved.md' })
    // A different id that merely shares the prefix is not this capture.
    quarantine(root, `${SID}x`)
    expect(readCaptureDisposition(`${SID}x`, root)?.kind).toBe('quarantined')
    expect(readCaptureDisposition(SID, root)?.kind, 'a prefix-sharing id leaked in').toBe('recovered')
  })

  it('finds a timestamp-suffixed quarantine dir, and counts an unreadable receipt as finished', () => {
    const root = temp()
    const dir = quarantine(root, SID, `${SID}.1791900000000`)
    writeFileSync(join(dir, '_recovered.json'), '{torn')
    expect(readCaptureDisposition(SID, root)).toMatchObject({ kind: 'recovered', dirName: `${SID}.1791900000000` })
  })
})
