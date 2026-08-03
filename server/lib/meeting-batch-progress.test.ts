import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  BATCH_PENDING_MARKER,
  clearMeetingBatchTerminal,
  getMeetingSyncSnapshot,
  writeMeetingBatchProgress,
  writeMeetingBatchTerminal,
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

  // ── 6.19.0 terminal outcomes (W2) ──────────────────────────────────────
  // The exact defect from meeting_1785695339502_mvqm0p: a rejected batch
  // retained its 395 WAVs and meeting_sync reported "HQ polish · 395 chunks",
  // active:true, blocksRestart:true for the full 12h retention after the work
  // had already finished.

  it('reports a rejected batch as retained, never as active work', () => {
    const root = join(tmpdir(), `cos-meeting-sync-term-${process.pid}-${Date.now()}`)
    const meeting = join(root, 'meeting_rejected')
    mkdirSync(meeting, { recursive: true })
    try {
      writeFileSync(join(meeting, 'chunk_0000.wav'), 'x')
      writeFileSync(join(meeting, 'chunk_0001.wav'), 'x')
      // Stale marker (as after the pipeline settles and the lease stops
      // refreshing) — pre-6.19.0 this produced the phantom active row.
      const marker = join(meeting, BATCH_PENDING_MARKER)
      writeFileSync(marker, String(Date.now()))
      const stale = new Date(Date.now() - 30 * 60_000)
      utimesSync(marker, stale, stale)
      writeMeetingBatchTerminal(meeting, { outcome: 'rejected', reason: 'repetitive-output' })

      const snap = getMeetingSyncSnapshot(root)
      expect(snap.active).toBe(false)
      expect(snap.blocksRestart).toBe(false)
      expect(snap.meetings).toHaveLength(0)
      expect(snap.retained).toHaveLength(1)
      expect(snap.retained[0]!.outcome).toBe('rejected')
      expect(snap.retained[0]!.reason).toBe('repetitive-output')
      expect(snap.retained[0]!.chunkFiles).toBe(2)
      expect(snap.retained[0]!.label).toContain('Retained (rejected: repetitive-output)')
      expect(snap.label).toContain('retained')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lets live signals win over a stale terminal file (retry in flight)', () => {
    const root = join(tmpdir(), `cos-meeting-sync-retry-${process.pid}-${Date.now()}`)
    const meeting = join(root, 'meeting_retry')
    mkdirSync(meeting, { recursive: true })
    try {
      writeFileSync(join(meeting, 'chunk_0000.wav'), 'x')
      writeMeetingBatchTerminal(meeting, { outcome: 'rejected', reason: 'repetitive-output' })
      // A retry writes fresh progress (and would normally clear the terminal
      // first) — fresh activity must take precedence either way.
      writeMeetingBatchProgress(meeting, {
        phase: 'hq_polish',
        segmentsDone: 1,
        segmentsTotal: 4,
        meetingId: 'meeting_retry',
      })
      const snap = getMeetingSyncSnapshot(root)
      expect(snap.active).toBe(true)
      expect(snap.blocksRestart).toBe(true)
      expect(snap.meetings).toHaveLength(1)
      expect(snap.retained).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clearMeetingBatchTerminal removes the terminal so the dir can go active again', () => {
    const root = join(tmpdir(), `cos-meeting-sync-clear-${process.pid}-${Date.now()}`)
    const meeting = join(root, 'meeting_clear')
    mkdirSync(meeting, { recursive: true })
    try {
      writeFileSync(join(meeting, 'chunk_0000.wav'), 'x')
      writeMeetingBatchTerminal(meeting, { outcome: 'failed', reason: 'boom' })
      expect(getMeetingSyncSnapshot(root).retained).toHaveLength(1)
      clearMeetingBatchTerminal(meeting)
      const snap = getMeetingSyncSnapshot(root)
      expect(snap.retained).toHaveLength(0)
      // Back to the pre-terminal semantics for a stale dir with chunks.
      expect(snap.meetings).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
