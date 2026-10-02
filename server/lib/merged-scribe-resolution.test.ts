// 6.61.2: resolving a G2 session to its merged scribe in ANY domain folder.
//
// A merged scribe holds a capture only if it says so with
// `<!-- g2-session: <exact id> -->`. These tests pin the lookup that turns a
// session into a record: which folders it searches, what it refuses to count,
// that two claims resolve to neither, and that a warm lookup reads nothing.
// Executed against real files in a temp operations tree.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findCosOperationsMeetingBySessionId,
  mergedScribeCacheStats,
  mergedScribeMonthsFor,
  resetMergedScribeCache,
} from './cos-operations-meetings.js'
import { MeetingStore } from './meeting-store.js'
import { ImportedMeetingLibrary } from './imported-meeting-library.js'
import { resolveSuggestionSides } from './meeting-suggestion-sides.js'
import { derivedSourcesFor } from './imported-library-rows.js'

const SESSION = 'meeting_1789047739389_iijsqc'
const CAPTURE = '2026-09-10_G2_Recording_2026-09-10_0842_3eaf0686'

let parent = ''
let operations = ''
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ['COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_SCRIPTS_DIR'] as const

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  // Real path: the lookup answers with the operations root's realpath (/private/var on macOS).
  parent = realpathSync(mkdtempSync(join(tmpdir(), 'cos-merged-scribe-')))
  operations = join(parent, 'operations')
  process.env.COS_OPERATIONS_DIR = operations
  delete process.env.COS_MEETINGS_ROOT
  delete process.env.COS_SCRIPTS_DIR
  resetMergedScribeCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  rmSync(parent, { recursive: true, force: true })
})

function dir(domain: string, month: string): string {
  const path = join(operations, domain, 'meetings', month)
  mkdirSync(path, { recursive: true })
  return path
}

function capture(domain: string, month: string, stem = CAPTURE, sessionId = SESSION): string {
  const path = join(dir(domain, month), `${stem}.g2-chunks.json`)
  writeFileSync(path, JSON.stringify({ schemaVersion: 2, sessionId, startTime: 1789047739389, chunks: [] }))
  return path
}

function scribe(domain: string, month: string, filename: string, sessions: string[], title = 'Chris <> Miles Sync'): string {
  const path = join(dir(domain, month), filename)
  writeFileSync(path, [
    `# ${title}`,
    '',
    '## Transcript',
    '',
    '[MU]: Hello.',
    '',
    '<!-- g2-transcript-blended -->',
    ...sessions.map(id => `<!-- g2-session: ${id} -->`),
    '## G2 Speaker-Separated Transcript',
    '',
  ].join('\n'))
  return path
}

describe('cross-folder resolution', () => {
  it('cross-folder: resolves to the merged scribe in another domain, with that scribe\'s domain, month and filename', () => {
    const sidecar = capture('personal', '2026-09')
    const merged = scribe('sprocket_rocket', '2026-09', '2026-09-10_Chris_Miles_Sync.md', [SESSION])
    const found = findCosOperationsMeetingBySessionId(SESSION)
    expect(found).toEqual({
      sidecarPath: sidecar,
      meetingPath: merged,
      filename: '2026-09-10_Chris_Miles_Sync.md',
      domain: 'sprocket_rocket',
      month: '2026-09',
      title: 'Chris <> Miles Sync',
    })
  })

  it('cross-folder: searches every discovered domain, including ones this repo never names', () => {
    capture('personal', '2026-09')
    const merged = scribe('DNP study', '2026-09', '2026-09-10_Cohort_Call.md', [SESSION], 'Cohort call')
    expect(findCosOperationsMeetingBySessionId(SESSION)?.meetingPath).toBe(merged)
  })

  it('same-folder: a merged scribe beside its sidecar still resolves', () => {
    capture('quilt', '2026-09')
    const merged = scribe('quilt', '2026-09', '2026-09-10_Weekly_Sync.md', [SESSION], 'Weekly sync')
    const found = findCosOperationsMeetingBySessionId(SESSION)
    expect(found?.meetingPath).toBe(merged)
    expect(found?.domain).toBe('quilt')
  })

  it('a capture whose own scribe still exists keeps it, even when another meeting declares the session', () => {
    capture('personal', '2026-09')
    const own = join(dir('personal', '2026-09'), `${CAPTURE}.md`)
    writeFileSync(own, '# G2 Recording\n')
    scribe('quilt', '2026-09', '2026-09-10_Weekly_Sync.md', [SESSION])
    const found = findCosOperationsMeetingBySessionId(SESSION)
    expect(found?.meetingPath).toBe(own)
    expect(found?.domain).toBe('personal')
  })

  it('no scribe declares the session: the record is the capture alone, as in 6.61.1', () => {
    capture('personal', '2026-09')
    scribe('quilt', '2026-09', '2026-09-10_Unrelated.md', ['meeting_000000000000_other'])
    const found = findCosOperationsMeetingBySessionId(SESSION)
    expect(found?.filename).toBe(`${CAPTURE}.md`)
    expect(found?.domain).toBe('personal')
    expect(found?.mergedScribeConflict).toBeUndefined()
  })
})

describe('identity is the marker', () => {
  it('a marker with a near-miss id (prefix or suffix) does not match', () => {
    capture('personal', '2026-09')
    scribe('quilt', '2026-09', '2026-09-10_Prefix.md', [SESSION.slice(0, -1)])
    scribe('quilt', '2026-09', '2026-09-10_Suffix.md', [`${SESSION}x`])
    scribe('quilt', '2026-09', '2026-09-10_Wrapped.md', [`x${SESSION}`])
    const found = findCosOperationsMeetingBySessionId(SESSION)
    expect(found?.filename).toBe(`${CAPTURE}.md`)
    expect(found?.mergedScribeConflict).toBeUndefined()
  })

  it('a title or filename that names the capture is not a claim', () => {
    capture('personal', '2026-09')
    const path = join(dir('quilt', '2026-09'), `${CAPTURE}.md`)
    writeFileSync(path, `# ${CAPTURE}\n\n<!-- g2-source: ${CAPTURE}.g2-chunks.json -->\n${SESSION}\n`)
    expect(findCosOperationsMeetingBySessionId(SESSION)?.domain).toBe('personal')
  })
})

describe('two claims fail closed', () => {
  it('duplicate claim fails closed: two meetings declaring one session resolve to neither, with a reason logged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    capture('personal', '2026-09')
    scribe('sprocket_rocket', '2026-09', '2026-09-10_Chris_Miles_Sync.md', [SESSION])
    scribe('quilt', '2026-09', '2026-09-10_Rival.md', [SESSION])
    const found = findCosOperationsMeetingBySessionId(SESSION)
    expect(found?.filename).toBe(`${CAPTURE}.md`)
    expect(found?.domain).toBe('personal')
    expect(found?.mergedScribeConflict).toEqual([
      'quilt/meetings/2026-09/2026-09-10_Rival.md',
      'sprocket_rocket/meetings/2026-09/2026-09-10_Chris_Miles_Sync.md',
    ])
    const lines = warn.mock.calls.map(call => String(call[0]))
    expect(lines.filter(line => line.includes('merged_scribe_ambiguous') && line.includes(SESSION))).toHaveLength(1)
    // Logged once per claim set, not on every lookup.
    findCosOperationsMeetingBySessionId(SESSION)
    expect(warn.mock.calls.filter(call => String(call[0]).includes('merged_scribe_ambiguous'))).toHaveLength(1)
  })

  it('two claims in one folder are as ambiguous as two in different folders', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    capture('quilt', '2026-09')
    scribe('quilt', '2026-09', '2026-09-10_A.md', [SESSION])
    scribe('quilt', '2026-09', '2026-09-10_B.md', [SESSION])
    expect(findCosOperationsMeetingBySessionId(SESSION)?.mergedScribeConflict).toHaveLength(2)
  })
})

describe('iCloud copies are never claims', () => {
  it('an iCloud "2026-09 2" folder is ignored, alone or beside the real one', () => {
    capture('personal', '2026-09')
    scribe('quilt', '2026-09 2', '2026-09-10_Chris_Miles_Sync.md', [SESSION])
    expect(findCosOperationsMeetingBySessionId(SESSION)?.domain).toBe('personal')
    const real = scribe('sprocket_rocket', '2026-09', '2026-09-10_Chris_Miles_Sync.md', [SESSION])
    const found = findCosOperationsMeetingBySessionId(SESSION)
    expect(found?.meetingPath).toBe(real)
    expect(found?.mergedScribeConflict).toBeUndefined()
  })

  it('an iCloud conflict copy of the merged scribe does not make the session ambiguous', () => {
    capture('personal', '2026-09')
    const real = scribe('quilt', '2026-09', '2026-09-10_Chris_Miles_Sync.md', [SESSION])
    scribe('quilt', '2026-09', '2026-09-10_Chris_Miles_Sync 2.md', [SESSION])
    const found = findCosOperationsMeetingBySessionId(SESSION)
    expect(found?.meetingPath).toBe(real)
    expect(found?.mergedScribeConflict).toBeUndefined()
  })

  it('an iCloud copy of the sidecar is never the capture', () => {
    capture('personal', '2026-09', `${CAPTURE} 2`)
    scribe('quilt', '2026-09', '2026-09-10_Chris_Miles_Sync.md', [SESSION])
    expect(findCosOperationsMeetingBySessionId(SESSION)).toBeNull()
  })
})

describe('adjacent month', () => {
  it('adjacent month: a capture on the last day of a month finds a scribe filed in the next month', () => {
    capture('personal', '2026-09', '2026-09-30_G2_Recording_2026-09-30_2341_aaaa0001')
    const merged = scribe('quilt', '2026-10', '2026-10-01_Late_Call.md', [SESSION], 'Late call')
    const found = findCosOperationsMeetingBySessionId(SESSION)
    expect(found?.meetingPath).toBe(merged)
    expect(found?.month).toBe('2026-10')
  })

  it('adjacent month: a capture on the first day of a month finds a scribe filed in the previous month', () => {
    capture('personal', '2026-10', '2026-10-01_G2_Recording_2026-10-01_0002_aaaa0002')
    const merged = scribe('quilt', '2026-09', '2026-09-30_Late_Call.md', [SESSION], 'Late call')
    expect(findCosOperationsMeetingBySessionId(SESSION)?.month).toBe('2026-09')
    expect(findCosOperationsMeetingBySessionId(SESSION)?.meetingPath).toBe(merged)
  })

  it('adjacent month: a mid-month capture does not search the neighbouring months', () => {
    capture('personal', '2026-09')
    scribe('quilt', '2026-10', '2026-10-10_Chris_Miles_Sync.md', [SESSION])
    expect(findCosOperationsMeetingBySessionId(SESSION)?.domain).toBe('personal')
  })

  it('adjacent month: the month list for each case, across a year boundary', () => {
    expect(mergedScribeMonthsFor('2026-09', '2026-09-10_x.g2-chunks.json')).toEqual(['2026-09'])
    expect(mergedScribeMonthsFor('2026-12', '2026-12-31_x.g2-chunks.json')).toEqual(['2026-12', '2027-01'])
    expect(mergedScribeMonthsFor('2027-01', '2027-01-01_x.g2-chunks.json')).toEqual(['2027-01', '2026-12'])
    expect(mergedScribeMonthsFor('2028-02', '2028-02-29_x.g2-chunks.json')).toEqual(['2028-02', '2028-03'])
    expect(mergedScribeMonthsFor('2026-09', 'G2_Recording.g2-chunks.json')).toEqual(['2026-09', '2026-08', '2026-10'])
    expect(mergedScribeMonthsFor('2026-09 2', '2026-09-10_x.g2-chunks.json')).toEqual([])
  })
})

describe('the marker cache', () => {
  it('cache invalidates on a new scribe: a merged scribe written after a lookup is found by the next one', () => {
    capture('personal', '2026-09')
    expect(findCosOperationsMeetingBySessionId(SESSION)?.domain).toBe('personal')
    const merged = scribe('quilt', '2026-09', '2026-09-10_Chris_Miles_Sync.md', [SESSION])
    expect(findCosOperationsMeetingBySessionId(SESSION)?.meetingPath).toBe(merged)
  })

  it('cache invalidates on an in-place edit: a marker added to an existing scribe is seen', () => {
    capture('personal', '2026-09')
    const path = scribe('quilt', '2026-09', '2026-09-10_Chris_Miles_Sync.md', [])
    expect(findCosOperationsMeetingBySessionId(SESSION)?.domain).toBe('personal')
    // Same inode, same folder entry: only the file's own stamp changes.
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n<!-- g2-session: ${SESSION} -->\n`)
    expect(findCosOperationsMeetingBySessionId(SESSION)?.meetingPath).toBe(path)
  })

  it('cache invalidates when a marker is removed', () => {
    capture('personal', '2026-09')
    const path = scribe('quilt', '2026-09', '2026-09-10_Chris_Miles_Sync.md', [SESSION])
    expect(findCosOperationsMeetingBySessionId(SESSION)?.meetingPath).toBe(path)
    writeFileSync(path, '# Chris <> Miles Sync\n\nNo markers any more.\n')
    expect(findCosOperationsMeetingBySessionId(SESSION)?.domain).toBe('personal')
  })

  it('a warm lookup reads no scribe again; a cold one reads each scribe once', () => {
    capture('personal', '2026-09')
    for (let i = 0; i < 12; i++) scribe(['quilt', 'hermit_crabs', 'sprocket_rocket'][i % 3], '2026-09', `2026-09-1${i % 10}_Other_${i}.md`, [])
    scribe('quilt', '2026-09', '2026-09-10_Chris_Miles_Sync.md', [SESSION])
    findCosOperationsMeetingBySessionId(SESSION)
    const cold = mergedScribeCacheStats().reads
    expect(cold).toBe(13)
    for (let i = 0; i < 5; i++) expect(findCosOperationsMeetingBySessionId(SESSION)?.domain).toBe('quilt')
    expect(mergedScribeCacheStats().reads).toBe(cold)
  })
})

describe('every caller that builds a recordId from the lookup', () => {
  it('suggestion sides name the merged scribe the list shows', () => {
    capture('personal', '2026-09')
    scribe('sprocket_rocket', '2026-09', '2026-09-10_Chris_Miles_Sync.md', [SESSION])
    const data = join(parent, 'data')
    const sides = resolveSuggestionSides({ sessionIds: [SESSION], firefliesIds: [] }, {
      library: new ImportedMeetingLibrary({ root: join(data, 'imports') }),
      store: new MeetingStore(join(data, 'recordings')),
    })
    expect(sides[0]).toMatchObject({
      kind: 'g2', resolved: true, source: 'cos_operations',
      recordId: 'ops:sprocket_rocket:2026-09:2026-09-10_Chris_Miles_Sync.md',
      title: 'Chris <> Miles Sync',
    })
  })

  it('a derived record names the merged scribe as its G2 source', () => {
    capture('personal', '2026-09')
    scribe('sprocket_rocket', '2026-09', '2026-09-10_Chris_Miles_Sync.md', [SESSION])
    const sources = derivedSourcesFor(
      { recordId: 'blended:0123456789abcdef', kind: 'merge', g2SessionIds: [SESSION], firefliesIds: [] } as never,
      new MeetingStore(join(parent, 'data', 'recordings')),
    )
    expect(sources).toEqual([{ kind: 'g2', id: SESSION, recordId: 'ops:sprocket_rocket:2026-09:2026-09-10_Chris_Miles_Sync.md' }])
  })
})
