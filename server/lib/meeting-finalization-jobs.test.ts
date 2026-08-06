import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MeetingFinalizationJobStore } from './meeting-finalization-jobs.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('durable meeting finalization jobs', () => {
  it('persists, advances, lists, and removes a restart-replay job', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-finalization-jobs-'))
    roots.push(root)
    const jobsRoot = join(root, 'data', 'meeting-finalization-jobs')
    const store = new MeetingFinalizationJobStore(jobsRoot)
    const meetingPath = join(root, 'data', 'recordings', '2026-08', 'recording.md')
    const sidecarPath = join(root, 'data', 'recordings', '2026-08', 'recording.g2-chunks.json')
    const audioDir = join(root, 'data', 'pending-batch', 'meeting_replay_001')
    const initial = store.save({
      sessionId: 'meeting_replay_001',
      meetingPath,
      sidecarPath,
      audioDir,
      streamingWordCount: 42,
      phase: 'batch_pending',
      claimPending: true,
    })
    expect(initial.phase).toBe('batch_pending')
    expect(store.list()).toHaveLength(1)

    const advanced = store.save({
      sessionId: initial.sessionId,
      meetingPath: initial.meetingPath,
      sidecarPath: initial.sidecarPath,
      audioDir: initial.audioDir,
      streamingWordCount: initial.streamingWordCount,
      phase: 'ops_pending',
      claimPending: false,
    })
    expect(advanced.createdAt).toBe(initial.createdAt)
    expect(store.get(initial.sessionId)?.phase).toBe('ops_pending')

    store.remove(initial.sessionId)
    expect(store.get(initial.sessionId)).toBeNull()
    expect(existsSync(join(jobsRoot, `${initial.sessionId}.json`))).toBe(false)
  })

  it('ignores malformed durable records instead of executing them', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-finalization-jobs-'))
    roots.push(root)
    const store = new MeetingFinalizationJobStore(root)
    expect(() => store.get('../escape')).toThrow(/Invalid finalization sessionId/)
  })

  it('reconstructs a missing replay job from canonical two-phase intent', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-finalization-jobs-'))
    roots.push(root)
    const store = new MeetingFinalizationJobStore(join(root, 'data', 'meeting-finalization-jobs'))
    const month = join(root, 'data', 'recordings', '2026-08')
    const pending = join(root, 'data', 'pending-batch', 'meeting_crash_001')
    mkdirSync(month, { recursive: true })
    mkdirSync(pending, { recursive: true })
    writeFileSync(join(month, 'capture.md'), '# capture\n')
    writeFileSync(join(month, 'capture.g2-chunks.json'), JSON.stringify({
      sessionId: 'meeting_crash_001',
      finalizationState: 'capture_pending',
      claimPending: true,
      streamingWordCount: 12,
      chunkEntries: [],
    }))

    expect(store.list()).toHaveLength(0)
    expect(store.reconcileCanonicalSidecars()).toHaveLength(1)
    expect(store.get('meeting_crash_001')).toMatchObject({
      phase: 'batch_pending',
      audioDir: pending,
      claimPending: true,
    })
  })
})
