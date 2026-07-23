import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  boundedMeetingSource,
  MEETING_SOURCE_MAX_BYTES,
  MeetingStore,
  MeetingStoreError,
  type SaveMeetingInput,
} from './meeting-store.js'

const roots: string[] = []

function newRoot(prefix = 'cos-recordings-store-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return join(root, 'recordings')
}

function input(overrides: Partial<SaveMeetingInput> = {}): SaveMeetingInput {
  return {
    sessionId: 'meeting_store_001',
    title: 'Weekly planning',
    domain: 'personal',
    transcript: '[Speaker A]: We reviewed the launch plan and assigned the next decision.\n[Speaker B]: I will own the follow-up.',
    startTime: new Date(2026, 6, 15, 9, 30).getTime(),
    durationMs: 31 * 60_000,
    chunks: [
      { text: 'We reviewed the launch plan and assigned the next decision.', speaker: 'Speaker A', elapsed: 1_000, similarity: 0.9 },
      { text: 'I will own the follow-up.', speaker: 'Speaker B', elapsed: 31 * 60_000, similarity: 0.8 },
    ],
    chunkEntries: [
      { chunkIndex: 0, chunk: { text: 'We reviewed the launch plan and assigned the next decision.', speaker: 'Speaker A', elapsed: 1_000, similarity: 0.9 } },
      { chunkIndex: 3, chunk: { text: 'I will own the follow-up.', speaker: 'Speaker B', elapsed: 31 * 60_000, similarity: 0.8 } },
    ],
    transferIntegrity: {
      received: 3,
      stored: 2,
      maxIndex: 3,
      expected: 4,
      missingIndices: [2],
      completeness: 0.75,
    },
    ...overrides,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('MeetingStore', () => {
  it('publishes a private markdown+sidecar pair and exposes build199 list/detail shapes', () => {
    const root = newRoot()
    const store = new MeetingStore(root)
    const saved = store.save(input())

    expect(saved.filepath).toBe(join(root, '2026-07', saved.filename))
    expect(saved.filename).toMatch(/^2026-07-15_Weekly_planning_[a-f0-9]{8}\.md$/)
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, '2026-07')).mode & 0o777).toBe(0o700)
    expect(statSync(saved.filepath).mode & 0o777).toBe(0o600)
    expect(statSync(saved.sidecarPath).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(root, '2026-07')).some(name => name.endsWith('.tmp'))).toBe(false)

    const sidecar = JSON.parse(readFileSync(saved.sidecarPath, 'utf8'))
    expect(sidecar).toMatchObject({
      schemaVersion: 2,
      sessionId: 'meeting_store_001',
      transcriptionQuality: 'streaming',
      batchApplied: false,
      transferIntegrity: { missingIndices: [2] },
      chunkEntries: [{ chunkIndex: 0 }, { chunkIndex: 3 }],
    })

    const list = store.list({ domain: 'personal' })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      filename: saved.filename,
      title: 'Weekly planning',
      date: '2026-07-15',
      domain: 'personal',
      domainAbbr: 'P',
      source: 'G2 Glasses',
      duration: '31 minutes',
      durationMinutes: 31,
      month: '2026-07',
    })

    const detail = store.detail('personal', '2026-07', saved.filename)
    expect(detail.summary).toContain('We reviewed the launch plan')
    expect(detail.transcript).toContain('[Speaker B]: I will own the follow-up.')
    expect(detail.sourceContent).toContain('# Weekly planning')
    expect(detail.sourceContent).toContain('## Transcript')
    expect(detail.sourceTruncated).toBe(false)
    expect(detail.topics).toEqual([])
    expect(detail.decisions).toEqual([])
    expect(detail.actionItems).toEqual([])
    expect(detail.attendees).toEqual([])
  })

  it('bounds canonical meeting source on a UTF-8-safe boundary', () => {
    const content = `${'a'.repeat(MEETING_SOURCE_MAX_BYTES - 1)}▲tail`
    const source = boundedMeetingSource(content)

    expect(source.sourceTruncated).toBe(true)
    expect(Buffer.byteLength(source.sourceContent, 'utf8')).toBeLessThanOrEqual(MEETING_SOURCE_MAX_BYTES)
    expect(source.sourceContent).not.toContain('\uFFFD')
  })

  it('survives a new store instance and replays save identity from disk', () => {
    const root = newRoot()
    const firstStore = new MeetingStore(root)
    const saved = firstStore.save(input())

    const afterRestart = new MeetingStore(root)
    expect(afterRestart.list()).toHaveLength(1)
    expect(afterRestart.detail('personal', '2026-07', saved.filename).title).toBe('Weekly planning')
    expect(afterRestart.findBySessionId('meeting_store_001')).toMatchObject({
      filename: saved.filename,
      month: '2026-07',
      domain: 'personal',
      durationMin: 31,
    })
  })

  it('uses path-safe one-line titles and never overwrites same-title sessions', () => {
    const root = newRoot()
    const store = new MeetingStore(root)
    const injected = store.save(input({
      title: '../../private\n## Transcript\nreplacement',
      sessionId: 'meeting_safe_001',
    }))
    const second = store.save(input({ sessionId: 'meeting_safe_002', title: '../../private' }))

    expect(injected.filename).not.toContain('..')
    expect(injected.filename).not.toContain('/')
    expect(second.filename).not.toBe(injected.filename)
    const markdown = readFileSync(injected.filepath, 'utf8')
    expect(markdown.match(/^# /gm)).toHaveLength(1)
    expect(markdown.match(/^## Transcript$/gm)).toHaveLength(1)
    expect(store.list()).toHaveLength(2)
  })

  it('rejects traversal and ignores file/month symlinks', () => {
    const root = newRoot()
    const store = new MeetingStore(root)
    const saved = store.save(input())
    const outer = mkdtempSync(join(tmpdir(), 'cos-recordings-outside-'))
    roots.push(outer)
    const secret = join(outer, 'secret.md')
    writeFileSync(secret, '# Secret\n\n## Transcript\n\noutside bytes\n')

    const linkedFilename = '2026-07-15_Linked_deadbeef.md'
    symlinkSync(secret, join(root, '2026-07', linkedFilename))
    const linkedMonth = join(root, '2026-08')
    mkdirSync(join(outer, 'month'))
    symlinkSync(join(outer, 'month'), linkedMonth)

    expect(store.list().map(item => item.filename)).toEqual([saved.filename])
    expect(() => store.detail('personal', '2026-07', '../../secret.md'))
      .toThrowError(expect.objectContaining({ status: 400, code: 'invalid_filename' }))
    expect(() => store.detail('personal', '../07', saved.filename))
      .toThrowError(expect.objectContaining({ status: 400, code: 'invalid_month' }))
    expect(() => store.detail('personal', '2026-07', linkedFilename))
      .toThrowError(expect.objectContaining({ status: 404, code: 'meeting_not_found' }))
    expect(() => store.detail('personal', '2026-08', linkedFilename))
      .toThrowError(expect.objectContaining({ status: 404, code: 'meeting_not_found' }))
  })

  it('rejects a symlinked recordings root instead of following it', () => {
    const parent = mkdtempSync(join(tmpdir(), 'cos-recordings-root-link-'))
    roots.push(parent)
    const outside = join(parent, 'outside')
    mkdirSync(outside)
    const linkedRoot = join(parent, 'recordings')
    symlinkSync(outside, linkedRoot)
    const store = new MeetingStore(linkedRoot)
    expect(() => store.save(input())).toThrowError(MeetingStoreError)
    expect(() => store.list()).toThrowError(expect.objectContaining({ code: 'unsafe_recordings_store' }))
  })

  it('restores private modes on pre-existing recording directories', () => {
    const root = newRoot()
    mkdirSync(root, { recursive: true })
    chmodSync(root, 0o755)
    const store = new MeetingStore(root)
    const saved = store.save(input())
    expect(existsSync(saved.filepath)).toBe(true)
    expect(statSync(root).mode & 0o777).toBe(0o700)
  })
})
