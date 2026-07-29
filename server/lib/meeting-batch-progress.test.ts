import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  BATCH_PENDING_MARKER,
  getMeetingSyncSnapshot,
  writeMeetingBatchProgress,
} from './meeting-batch-progress.js'

describe('meeting-batch-progress', () => {
  it('reports idle when pending-batch is empty', () => {
    const root = join(tmpdir(), `cos-meeting-sync-idle-${process.pid}-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    try {
      const snap = getMeetingSyncSnapshot(root)
      expect(snap.active).toBe(false)
      expect(snap.label).toBe('Idle')
      expect(snap.percent).toBeNull()
      expect(snap.blocksRestart).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('surfaces percent from _batch_progress.json', () => {
    const root = join(tmpdir(), `cos-meeting-sync-pct-${process.pid}-${Date.now()}`)
    const meeting = join(root, 'meeting_abc')
    mkdirSync(meeting, { recursive: true })
    try {
      writeFileSync(join(meeting, 'chunk_0000.wav'), 'x')
      writeFileSync(join(meeting, BATCH_PENDING_MARKER), String(Date.now()))
      writeMeetingBatchProgress(meeting, {
        phase: 'hq_polish',
        segmentsDone: 3,
        segmentsTotal: 10,
        meetingId: 'meeting_abc',
      })
      const snap = getMeetingSyncSnapshot(root)
      expect(snap.active).toBe(true)
      expect(snap.percent).toBe(30)
      expect(snap.blocksRestart).toBe(true)
      expect(snap.label).toContain('30%')
      expect(snap.meetings[0]?.segmentsDone).toBe(3)
      expect(snap.meetings[0]?.segmentsTotal).toBe(10)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to chunk count when progress file is absent', () => {
    const root = join(tmpdir(), `cos-meeting-sync-chunks-${process.pid}-${Date.now()}`)
    const meeting = join(root, 'meeting_xyz')
    mkdirSync(meeting, { recursive: true })
    try {
      writeFileSync(join(meeting, 'chunk_0000.wav'), 'x')
      writeFileSync(join(meeting, 'chunk_0001.wav'), 'x')
      const marker = join(meeting, BATCH_PENDING_MARKER)
      writeFileSync(marker, String(Date.now()))
      utimesSync(marker, new Date(), new Date())
      const snap = getMeetingSyncSnapshot(root)
      expect(snap.active).toBe(true)
      expect(snap.percent).toBeNull()
      expect(snap.label).toContain('2 chunk')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
