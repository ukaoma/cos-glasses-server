// `probeMeetings` counts what the LIST shows (6.47.0, WS5).
//
// The morning brief's coverage tile and the Meetings list read the same library.
// Before this they counted it two different ways, so a merged record made the
// tile say three meetings where the list showed one. Both now go through
// `supersededDayCounts`, and this pins that they agree per layout.
//
// The helper must also stay FREE on a Mac with no derived records: the probe
// sums day counts across every month, and a full scribe read per month would be
// a real cost added to a daily job for a feature that Mac does not use. The last
// case pins the gate rather than trusting the comment.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MONTH = '2026-08'
const DATE = '2026-08-05'
const SESSION = 'probe_session_abc'
const FIREFLIES_ID = 'ff-probe-001'

let parent = ''
let dataDir = ''

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'cos-probe-meetings-'))
  dataDir = mkdtempSync(join(tmpdir(), 'cos-probe-meetings-data-'))
  process.env.COS_DATA_DIR = dataDir
  for (const key of ['COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_SCRIPTS_DIR']) delete process.env[key]
  vi.resetModules()
})

afterEach(() => {
  delete process.env.COS_DATA_DIR
  for (const key of ['COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_SCRIPTS_DIR']) delete process.env[key]
  vi.resetModules()
  for (const directory of [parent, dataDir]) if (directory) rmSync(directory, { recursive: true, force: true })
})

function meetingMarkdown(title: string, domain: string, source: string, extra = ''): string {
  return [
    `# ${title}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| **Date** | ${DATE} 10:00 |`,
    '| **Duration** | 28 minutes |',
    `| **Source** | ${source} |`,
    `| **Domain** | ${domain} |`,
    '',
    ...(extra ? [extra, ''] : []),
    '## Transcript',
    '',
    '[00:00:05] Speaker A: launch evidence.',
    '',
  ].join('\n')
}

function writeCapture(monthDir: string, stem: string, sessionId: string): void {
  mkdirSync(monthDir, { recursive: true })
  writeFileSync(join(monthDir, `${stem}.md`), meetingMarkdown('Launch review (G2)', 'personal', 'G2 Glasses'))
  writeFileSync(join(monthDir, `${stem}.g2-chunks.json`), JSON.stringify({ sessionId, speakers: [], chunks: [] }))
}

async function seedMergedImport(): Promise<void> {
  const { getImportedMeetingLibrary, importHash, mergedHash } = await import('./imported-meeting-library.js')
  const library = getImportedMeetingLibrary()
  const dateMs = new Date(2026, 7, 5, 10, 0).getTime()
  library.writeRecord({
    kind: 'fireflies',
    hash: importHash(FIREFLIES_ID),
    dateMs,
    markdown: meetingMarkdown('Launch review', 'imported', 'Fireflies'),
    sidecar: { version: 1, id: FIREFLIES_ID, originDomain: 'personal' },
  })
  library.writeRecord({
    kind: 'merged',
    hash: mergedHash(FIREFLIES_ID, [SESSION]),
    dateMs,
    markdown: meetingMarkdown('Launch review', 'imported', 'G2 Glasses + Fireflies'),
    sidecar: {
      version: 1,
      actionId: 'a_99887766554433aa',
      kind: 'merge',
      inputs: [
        { kind: 'fireflies', id: FIREFLIES_ID, sha256: null },
        { kind: 'g2', id: SESSION, sha256: null },
      ],
      tier: 'auto',
      pieces: [],
    },
  })
}

/** A COS pipeline this Mac can hand recordings to. */
function enablePipeline(): void {
  const scripts = join(parent, 'scripts')
  mkdirSync(join(scripts, 'venv', 'bin'), { recursive: true })
  writeFileSync(join(scripts, 'venv', 'bin', 'python3'), '#!/bin/sh\n')
  writeFileSync(join(scripts, 'sync_meetings.py'), '# stub\n')
  process.env.COS_SCRIPTS_DIR = scripts
}

async function probe(): Promise<{ count: number; layout: string; newestMonth: string | null } | null> {
  const { probeMeetings } = await import('./morning-brief-runtime.js')
  return probeMeetings() as any
}

describe('probeMeetings counts what the list shows', () => {
  it('standalone: a capture, its import and their merge count once', async () => {
    writeCapture(join(dataDir, 'recordings', MONTH), `${DATE}_Launch_Review_G2`, SESSION)
    await seedMergedImport()
    const result = await probe()
    expect(result).toMatchObject({ layout: 'standalone', newestMonth: MONTH, count: 1 })
  })

  it('standalone: an imported meeting counts even with no recordings at all', async () => {
    // The store is empty here, so a count taken from the store alone reads zero
    // while the Meetings list shows one row. That was the shape of the bug: the
    // brief and the list counting different libraries.
    await seedMergedImport()
    expect(await probe()).toMatchObject({ layout: 'standalone', count: 1, newestMonth: MONTH })
  })

  it('direct: the same, beside a direct library of its own', async () => {
    const directRoot = join(parent, 'library')
    mkdirSync(join(directRoot, MONTH), { recursive: true })
    writeFileSync(join(directRoot, MONTH, `${DATE}_Existing_Review.md`), meetingMarkdown('Existing review', 'library', 'Granola'))
    process.env.COS_MEETINGS_ROOT = directRoot
    writeCapture(join(dataDir, 'recordings', MONTH), `${DATE}_Launch_Review_G2`, SESSION)
    await seedMergedImport()
    // A month the direct library has never heard of. Without the imports months
    // in the pager this one is never visited and its meeting is never counted.
    const { getImportedMeetingLibrary, importHash } = await import('./imported-meeting-library.js')
    getImportedMeetingLibrary().writeRecord({
      kind: 'fireflies',
      hash: importHash('ff-probe-older'),
      dateMs: new Date(2026, 6, 2, 9, 0).getTime(),
      markdown: meetingMarkdown('Older import', 'imported', 'Fireflies'),
      sidecar: { version: 1, id: 'ff-probe-older', originDomain: 'personal' },
    })
    const result = await probe()
    // The direct library's own meeting, the merged record, and the older import.
    // Not the capture, and not the import the merge holds.
    expect(result).toMatchObject({ layout: 'direct', count: 3, newestMonth: MONTH })
  })

  it('multi_domain without a pipeline: operations, plus the merged record', async () => {
    const operations = join(parent, 'operations')
    mkdirSync(join(operations, 'personal', 'meetings', MONTH), { recursive: true })
    writeFileSync(
      join(operations, 'personal', 'meetings', MONTH, `${DATE}_Ops_Review.md`),
      meetingMarkdown('Ops review', 'personal', 'Granola'),
    )
    process.env.COS_OPERATIONS_DIR = operations
    writeCapture(join(dataDir, 'recordings', MONTH), `${DATE}_Launch_Review_G2`, SESSION)
    await seedMergedImport()
    const result = await probe()
    expect(result).toMatchObject({ layout: 'multi_domain', count: 2 })
  })

  it('multi_domain with a pipeline: operations only, and the merged scribe replaces its capture', async () => {
    const operations = join(parent, 'operations')
    const opsMonth = join(operations, 'personal', 'meetings', MONTH)
    writeCapture(opsMonth, `${DATE}_Launch_Review_G2`, SESSION)
    writeFileSync(
      join(opsMonth, `${DATE}_Launch_Review.md`),
      meetingMarkdown('Launch review', 'personal', 'G2 Glasses + Fireflies',
        `<!-- g2-session: ${SESSION} -->\n<!-- merge-action: a_99887766554433aa -->`),
    )
    process.env.COS_OPERATIONS_DIR = operations
    enablePipeline()
    // The decision file is what says a merge was applied here; the marker scan is
    // gated on it.
    mkdirSync(join(dataDir, 'imports', 'decisions'), { recursive: true })
    writeFileSync(join(dataDir, 'imports', 'decisions', 'a_99887766554433aa.json'), '{"schema":1}')
    // Imports exist but are NOT this Mac's library: the pipeline owns the tree.
    await seedMergedImport()

    const result = await probe()
    expect(result).toMatchObject({ layout: 'multi_domain', count: 1 })
  })

  // The row filter reads the merged-scribe markers unconditionally, so the day
  // count has to as well. An earlier build gated the count's scan on a pipeline
  // decision file existing, which made the list say one row and the calendar dot
  // say two whenever a merged scribe outlived its decision file.
  it('drops the capture from the count with no decision file beside the merged scribe', async () => {
    const operations = join(parent, 'operations')
    const opsMonth = join(operations, 'personal', 'meetings', MONTH)
    writeCapture(opsMonth, `${DATE}_Launch_Review_G2`, SESSION)
    writeFileSync(
      join(opsMonth, `${DATE}_Launch_Review.md`),
      meetingMarkdown('Launch review', 'personal', 'G2 Glasses + Fireflies', `<!-- g2-session: ${SESSION} -->`),
    )
    process.env.COS_OPERATIONS_DIR = operations
    enablePipeline()

    const { supersededDayCounts } = await import('./imported-library-rows.js')
    expect(supersededDayCounts(MONTH, 'multi_domain', { pipeline: true })).toEqual([{ date: DATE, count: 1 }])
    expect(await probe()).toMatchObject({ layout: 'multi_domain', count: 1 })
  })

  it('counts an ordinary operations month unchanged', async () => {
    const operations = join(parent, 'operations')
    const opsMonth = join(operations, 'personal', 'meetings', MONTH)
    writeCapture(opsMonth, `${DATE}_Launch_Review_G2`, SESSION)
    writeFileSync(join(opsMonth, `${DATE}_Ops_Review.md`), meetingMarkdown('Ops review', 'personal', 'Granola'))
    process.env.COS_OPERATIONS_DIR = operations
    enablePipeline()
    expect(await probe()).toMatchObject({ layout: 'multi_domain', count: 2 })
  })
})
