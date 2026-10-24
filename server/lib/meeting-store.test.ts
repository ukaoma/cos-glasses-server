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
import { afterEach, describe, expect, it, afterAll, vi } from 'vitest'
import {
  boundedMeetingSource,
  MEETING_SOURCE_MAX_BYTES,
  MeetingStore,
  MeetingStoreError,
  storedMeetingTime,
  type SaveMeetingInput,
} from './meeting-store.js'

// 6.73.14 QA: which markdown files the store opened in full. The real reader still runs; this only records the name,
// so a test can prove a list never opened a file it had no reason to.
const markdownReads = vi.hoisted(() => [] as string[])
vi.mock('./meeting-file-guards.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./meeting-file-guards.js')>()
  return {
    ...actual,
    safeReadFile: (...args: Parameters<typeof actual.safeReadFile>) => {
      markdownReads.push(args[2])
      return actual.safeReadFile(...args)
    },
  }
})

// Every temp root this file makes is removed when the file ends (6.53.3 /qa W3: the suites
// had left ~150,000 `cos-*` folders in $TMPDIR). Tracked at the mkdtemp call, so a new test
// cannot forget it.
const trackedTempRoots: string[] = []
function trackedTemp<T extends string>(root: T): T {
  trackedTempRoots.push(root)
  return root
}
afterAll(() => {
  for (const root of trackedTempRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* a chmod'ed tree: best effort */ }
  }
})

const roots: string[] = []

function newRoot(prefix = 'cos-recordings-store-'): string {
  const root = trackedTemp(mkdtempSync(join(tmpdir(), prefix)))
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
  it('persists capture identity policy on both raw sidecar projections', () => {
    const store = new MeetingStore(newRoot())
    const value = input()
    value.chunks[1]!.speakerPolicy = 'anonymous'
    value.chunkEntries![1]!.chunk.speakerPolicy = 'high-confidence'
    const saved = store.save(value)
    const sidecar = JSON.parse(readFileSync(saved.sidecarPath, 'utf8'))
    expect(sidecar.chunks[1].speakerPolicy).toBe('anonymous')
    expect(sidecar.chunkEntries[1].chunk.speakerPolicy).toBe('high-confidence')
  })

  it('6.90.0: a Mac Voice N placeholder never enters the sidecar speakers list, like Ext', () => {
    const store = new MeetingStore(newRoot())
    const value = input()
    value.chunks[0]!.speaker = 'Voice 1'
    value.chunks[1]!.speaker = 'Dana Reyes'
    value.chunks[1]!.segments = [{ speaker: 'Voice 2', text: 'I will own', startSec: 0, endSec: 1 }, { speaker: 'Ext', text: 'the follow-up.', startSec: 1, endSec: 2 }]
    const saved = store.save(value)
    expect(JSON.parse(readFileSync(saved.sidecarPath, 'utf8')).speakers).toEqual(['Dana Reyes'])
  })

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
    // Pre-6.37 this asserted `summary` contained transcript text — it was
    // pinning the transcript-as-summary substitution, i.e. the bug. The
    // transcript now lives only in its own field.
    expect(detail.summary).toBe('')
    expect(detail.transcript).toContain('[Speaker A]: We reviewed the launch plan')
    expect(detail.transcript).toContain('[Speaker B]: I will own the follow-up.')
    expect(detail.sourceContent).toContain('# Weekly planning')
    expect(detail.sourceContent).toContain('## Transcript')
    expect(detail.sourceTruncated).toBe(false)
    expect(detail.topics).toEqual([])
    expect(detail.decisions).toEqual([])
    expect(detail.actionItems).toEqual([])
    expect(detail.attendees).toEqual([])
  })

  it('a standalone placeholder yields an EMPTY summary, not the transcript', () => {
    // Until 6.37 this returned the transcript as the summary, which put the
    // transcript in the summary slot on every surface and read as a broken
    // summary. That branch had no test, so the whole suite stayed green
    // through it.
    const previous = process.env.COS_SCRIPTS_DIR
    delete process.env.COS_SCRIPTS_DIR
    try {
      const store = new MeetingStore(newRoot())
      const saved = store.save(input())
      const detail = store.detail('personal', saved.month, saved.filename)
      expect(detail.summary).toBe('')
      expect(detail.transcript).toContain('We reviewed the launch plan')
    } finally {
      if (previous == null) delete process.env.COS_SCRIPTS_DIR
      else process.env.COS_SCRIPTS_DIR = previous
    }
  })

  it('the page estimate counts the transcript the reader renders', () => {
    const previous = process.env.COS_SCRIPTS_DIR
    delete process.env.COS_SCRIPTS_DIR
    try {
      const store = new MeetingStore(newRoot())
      const long = 'word '.repeat(4000).trim()
      const saved = store.save(input({
        transcript: `[Speaker A]: ${long}`,
        chunks: [{ text: long, speaker: 'Speaker A', elapsed: 1_000, similarity: 0.9 }],
        chunkEntries: undefined,
      }))
      const listed = store.list({ domain: 'personal' })
        .find(item => item.filename === saved.filename)
      expect(listed).toBeTruthy()
      // A summary-only estimate reported every standalone meeting as ~1p while
      // the reader paginated many.
      expect(listed!.detailCharEstimate).toBeGreaterThan(long.length / 2)
      expect(listed!.estimatedDetailPages).toBeGreaterThan(1)
    } finally {
      if (previous == null) delete process.env.COS_SCRIPTS_DIR
      else process.env.COS_SCRIPTS_DIR = previous
    }
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
    const outer = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-recordings-outside-')))
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
    const parent = trackedTemp(mkdtempSync(join(tmpdir(), 'cos-recordings-root-link-')))
    roots.push(parent)
    const outside = join(parent, 'outside')
    mkdirSync(outside)
    const linkedRoot = join(parent, 'recordings')
    symlinkSync(outside, linkedRoot)
    const store = new MeetingStore(linkedRoot)
    expect(() => store.save(input())).toThrowError(MeetingStoreError)
    expect(() => store.list()).toThrowError(expect.objectContaining({ code: 'unsafe_recordings_store' }))
  })

  // 6.73.14 QA: Control polls `?day=` every 3 s during a hand-off, and a pipeline Mac's store holds hundreds of G2
  // recordings it never lists. Matching the session from the sidecar head first means those are never opened.
  it('matches sessionMatch on the sidecar before it opens any markdown, and a day reads only its month', () => {
    const root = newRoot()
    const store = new MeetingStore(root)
    const g2 = store.save(input({ sessionId: 'meeting_store_g2' }))
    const macFile = '2026-07-15_Mac_recording_15370d86.md'
    writeFileSync(join(root, '2026-07', macFile), '# Mac recording\n\n| **Date** | 2026-07-15 |\n| **Time** | 10:39 PM |\n| **Domain** | personal |\n\n## Transcript\n\n[Ext]: hello\n')
    writeFileSync(join(root, '2026-07', macFile.replace(/\.md$/, '.g2-chunks.json')),
      JSON.stringify({ schemaVersion: 2, sourceType: 'mac_system_audio', sessionId: 'mac_50609b33-32bb-4ad3-8b3d-9912cc0bcb21' }))
    const august = store.save(input({ sessionId: 'meeting_store_august', startTime: new Date(2026, 7, 3, 9, 0).getTime() }))

    markdownReads.length = 0
    const rows = store.list({ sessionMatch: id => typeof id === 'string' && id.startsWith('mac_') })
    expect(rows.map(row => row.sessionId)).toEqual(['mac_50609b33-32bb-4ad3-8b3d-9912cc0bcb21'])
    // The recorder sees reads at all (the Mac file), and none of the G2 recordings the match turned away.
    expect(markdownReads).toEqual([macFile])

    markdownReads.length = 0
    expect(store.list({ day: '2026-07-15' }).map(row => row.filename).sort()).toEqual([g2.filename, macFile].sort())
    expect(markdownReads).not.toContain(august.filename)
    expect(markdownReads.sort()).toEqual([g2.filename, macFile].sort())
  })

  it('gives a stored row its start time, in the operations rows\' 24-hour form', () => {
    const store = new MeetingStore(newRoot())
    store.save(input({ sessionId: 'meeting_store_evening', title: 'Evening', startTime: new Date(2026, 6, 15, 22, 39).getTime() }))
    store.save(input({ sessionId: 'meeting_store_morning', title: 'Zebra morning', startTime: new Date(2026, 6, 15, 9, 30).getTime() }))
    // Newest first by time, not by filename ("Zebra" sorts after "Evening").
    expect(store.list().map(row => [row.title, row.time])).toEqual([['Evening', '22:39'], ['Zebra morning', '09:30']])

    expect(storedMeetingTime('| **Time** | 12:05 AM |', 'x.md')).toBe('00:05')
    expect(storedMeetingTime('| **Time** | 12:05 PM |', 'x.md')).toBe('12:05')
    expect(storedMeetingTime('| **Time** | 14:05 |', 'x.md')).toBe('14:05')
    expect(storedMeetingTime('| **Date** | 2026-07-15 14:05 |', 'x.md')).toBe('14:05')
    expect(storedMeetingTime('| **Date** | 2026-07-15 |', '2026-07-15_Mac_Recording_2026-07-15_2239_abcd1234.md')).toBe('22:39')
    expect(storedMeetingTime('| **Date** | 2026-07-15 |', '2026-07-15_Weekly_planning_abcd1234.md')).toBeUndefined()
    expect(storedMeetingTime('| **Time** | 13:05 PM |', 'x.md')).toBeUndefined()
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
