// Meeting search over the imported library (6.47.0, WS5).
//
// ONE MEETING, ONE HIT. A merged record holds the transcript of BOTH its import
// and its capture, so a query that matches the meeting matches all three files
// on disk. The list already drops the inputs a derived record holds; search has
// to drop them too, or the same conversation comes back three times under three
// titles and the reader cannot tell which one is current.
//
// The data home is set per test and the modules re-imported, because the imports
// library is a process-wide singleton resolved from `dataPath('imports')` at
// first use.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MONTH = '2026-08'
const DATE = '2026-08-05'
const SESSION = 'search_session_abc'
const FIREFLIES_ID = 'ff-search-001'

let root = ''
let dataDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-search-imports-'))
  dataDir = mkdtempSync(join(tmpdir(), 'cos-search-imports-data-'))
  process.env.COS_DATA_DIR = dataDir
  for (const key of ['COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_SCRIPTS_DIR']) delete process.env[key]
  vi.resetModules()
})

afterEach(() => {
  delete process.env.COS_DATA_DIR
  vi.resetModules()
  for (const directory of [root, dataDir]) if (directory) rmSync(directory, { recursive: true, force: true })
})

function meetingMarkdown(title: string, domain: string, source: string): string {
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
    '## Summary',
    '',
    'The Jewel360 pipeline question and who owns the follow-up.',
    '',
    '## Transcript',
    '',
    '[00:00:05] Speaker A: the Jewel360 pipeline question.',
    '',
  ].join('\n')
}

function seedCapture(): void {
  const dir = join(root, MONTH)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${DATE}_Jewel360_Pipeline_G2.md`), meetingMarkdown('Jewel360 pipeline (G2)', 'personal', 'G2 Glasses'))
  writeFileSync(
    join(dir, `${DATE}_Jewel360_Pipeline_G2.g2-chunks.json`),
    JSON.stringify({ sessionId: SESSION, speakers: ['Speaker A'], chunks: [] }),
  )
}

async function seedImports(options: { merged: boolean }): Promise<void> {
  const { getImportedMeetingLibrary, importHash, mergedHash } = await import('./imported-meeting-library.js')
  const library = getImportedMeetingLibrary()
  library.writeRecord({
    kind: 'fireflies',
    hash: importHash(FIREFLIES_ID),
    dateMs: new Date(2026, 7, 5, 10, 0).getTime(),
    markdown: meetingMarkdown('Jewel360 pipeline', 'imported', 'Fireflies'),
    sidecar: { version: 1, id: FIREFLIES_ID, originDomain: 'personal' },
  })
  if (!options.merged) return
  library.writeRecord({
    kind: 'merged',
    hash: mergedHash(FIREFLIES_ID, [SESSION]),
    dateMs: new Date(2026, 7, 5, 10, 0).getTime(),
    markdown: meetingMarkdown('Jewel360 pipeline', 'imported', 'G2 Glasses + Fireflies'),
    sidecar: {
      version: 1,
      actionId: 'a_1122334455667788',
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

async function search(): Promise<Array<{ recordId: string; librarySource?: string }>> {
  const { MeetingStore } = await import('./meeting-store.js')
  const { keywordSearchMeetings } = await import('./meeting-library-search.js')
  return keywordSearchMeetings('Jewel360 pipeline', 'all', new MeetingStore(root))
}

describe('meeting search with imports and derived records', () => {
  it('returns the capture and the import separately until they are merged', async () => {
    seedCapture()
    await seedImports({ merged: false })
    const hits = await search()
    expect(hits.map(hit => hit.librarySource).sort()).toEqual(['imported', 'standalone_recordings'])
  })

  it('returns ONE hit once a merged record holds both', async () => {
    seedCapture()
    await seedImports({ merged: true })
    const hits = await search()
    expect(hits).toHaveLength(1)
    expect(hits[0].librarySource).toBe('blended')
    const { importRecordId, mergedHash } = await import('./imported-meeting-library.js')
    expect(hits[0].recordId).toBe(importRecordId('merged', mergedHash(FIREFLIES_ID, [SESSION])))
  })

  it('reads an imports path before the direct-library shape', async () => {
    const { libraryRefFromPath } = await import('./meeting-library-search.js')
    // Both shapes end in `<month>/<file>.md`, so order is the whole rule.
    expect(libraryRefFromPath(`/Users/x/.cos-glasses/data/imports/${MONTH}/${DATE}_merged_00112233445566aa.md`)).toEqual({
      domain: 'imported', month: MONTH, filename: `${DATE}_merged_00112233445566aa.md`,
    })
    expect(libraryRefFromPath(`/Users/x/library/${MONTH}/${DATE}_Existing_Review.md`)).toEqual({
      domain: 'library', month: MONTH, filename: `${DATE}_Existing_Review.md`,
    })
  })

  it('names an imports path from its own filename, merged and plain alike', async () => {
    // A semantic hit is a FILE PATH with no row behind it, so this is the only
    // place an imported record's id is reconstructed. Getting it wrong means the
    // search result and the list row name one record two different ways, and the
    // row the reader taps opens nothing.
    const { semanticHitToLibrary } = await import('./meeting-library-search.js')
    const { importHash, importRecordId, mergedHash } = await import('./imported-meeting-library.js')
    const mergedFile = `${DATE}_merged_${mergedHash(FIREFLIES_ID, [SESSION])}.md`
    const merged = semanticHitToLibrary({
      file_path: `/Users/x/.cos-glasses/data/imports/${MONTH}/${mergedFile}`,
      title: 'Jewel360 pipeline', date: DATE, score: 0.7,
    })
    expect(merged).toMatchObject({
      librarySource: 'blended',
      recordId: importRecordId('merged', mergedHash(FIREFLIES_ID, [SESSION])),
      domain: 'imported',
    })

    const importFile = `${DATE}_fireflies_${importHash(FIREFLIES_ID)}.md`
    const plain = semanticHitToLibrary({
      file_path: `/Users/x/.cos-glasses/data/imports/${MONTH}/${importFile}`,
      title: 'Jewel360 pipeline', date: DATE, score: 0.7,
    })
    expect(plain).toMatchObject({
      librarySource: 'imported',
      recordId: importRecordId('fireflies', importHash(FIREFLIES_ID)),
    })

    // The other two shapes are unchanged.
    expect(semanticHitToLibrary({ file_path: `/Users/x/operations/quilt/meetings/${MONTH}/a.md`, date: DATE }))
      .toMatchObject({ librarySource: 'cos_operations', recordId: `ops:quilt:${MONTH}:a.md` })
    expect(semanticHitToLibrary({ file_path: `/Users/x/library/${MONTH}/b.md`, date: DATE }))
      .toMatchObject({ librarySource: 'direct_library', recordId: `direct:${MONTH}:b.md` })
  })

  it('drops only what a derived record holds, and never the derived row itself', async () => {
    const { dropSupersededHits } = await import('./meeting-library-search.js')
    const { importHash, importRecordId, mergedHash } = await import('./imported-meeting-library.js')
    const superseded = {
      g2Sessions: new Set([SESSION]),
      importRecordIds: new Set([importRecordId('fireflies', importHash(FIREFLIES_ID))]),
      isEmpty: false,
    }
    const base = { title: 't', date: DATE, domain: 'imported', duration: '', month: MONTH, source: '', snippet: '', keywordScore: 1, semanticScore: 0, match: 'keyword' as const }
    const kept = dropSupersededHits([
      { ...base, recordId: importRecordId('merged', mergedHash(FIREFLIES_ID, [SESSION])), filename: 'a.md', librarySource: 'blended', sessionId: SESSION },
      { ...base, recordId: importRecordId('fireflies', importHash(FIREFLIES_ID)), filename: 'b.md', librarySource: 'imported' },
      { ...base, recordId: `standalone:${SESSION}`, filename: 'c.md', librarySource: 'standalone_recordings', sessionId: SESSION },
      { ...base, recordId: 'standalone:other', filename: 'd.md', librarySource: 'standalone_recordings', sessionId: 'other' },
    ], superseded)
    expect(kept.map(hit => hit.filename)).toEqual(['a.md', 'd.md'])
  })
})
