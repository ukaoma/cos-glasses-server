// The meetings LIST across every library layout, with imports and derived
// records present (6.47.0, WS5).
//
// WHAT THIS PINS. A merge is additive: the Fireflies import, the G2 recording
// and the merged record all exist on disk afterwards. The person scrolling their
// meetings must still see ONE row, and the calendar dot for that day must say 1.
// Every layout has its own row-assembly path, and each one had to learn the same
// rule, so each one is exercised here rather than trusting the shared helper.
//
// The imports library is INJECTED. `getImportedMeetingLibrary()` resolves the
// process-wide data home, which vitest shares across every test file, so a test
// that used the singleton would be testing whatever else the run had written.

import express from 'express'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ImportedMeetingLibrary,
  importHash,
  importedFilename,
  mergedHash,
  pieceHash,
} from '../lib/imported-meeting-library.js'
import { MeetingStore } from '../lib/meeting-store.js'
import { createMeetingsRouter } from './meetings.js'

const MONTH = '2026-07'
const DATE = '2026-07-15'
const SESSION = 'meeting_list_session_001'
const SECOND_SESSION = 'meeting_list_session_002'
const FIREFLIES_ID = 'ff-list-001'

const roots: string[] = []
const servers: Server[] = []
const envKeys = ['COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_SCRIPTS_DIR'] as const
const savedEnv: Partial<Record<typeof envKeys[number], string | undefined>> = {}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  for (const key of envKeys) {
    const value = savedEnv[key]
    if (value == null) delete process.env[key]
    else process.env[key] = value
    delete savedEnv[key]
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setEnv(key: typeof envKeys[number], value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  if (value == null) delete process.env[key]
  else process.env[key] = value
}

/** A meeting record in the shape every reader in this repo parses. */
function meetingMarkdown(title: string, domain: string, source: string, extra = ''): string {
  return [
    `# ${title}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| **Date** | ${DATE} 14:05 |`,
    '| **Duration** | 28 minutes |',
    `| **Source** | ${source} |`,
    `| **Domain** | ${domain} |`,
    '',
    '## Summary',
    '',
    'Launch evidence and the owner for the follow-up.',
    '',
    ...(extra ? [extra, ''] : []),
    '## Transcript',
    '',
    '[00:00:05] Speaker A: The team reviewed launch evidence.',
    '',
  ].join('\n')
}

function writeCapture(monthDir: string, filename: string, sessionId: string, title: string, domain = 'personal'): void {
  mkdirSync(monthDir, { recursive: true })
  writeFileSync(join(monthDir, filename), meetingMarkdown(title, domain, 'G2 Glasses'))
  writeFileSync(
    join(monthDir, filename.replace(/\.md$/, '.g2-chunks.json')),
    JSON.stringify({ sessionId, speakers: ['Speaker A'], durationMs: 1_680_000, chunks: [] }),
  )
}

interface SetupOptions {
  layout: 'direct' | 'multi_domain' | 'standalone'
  pipeline?: boolean
}

function setup(options: SetupOptions) {
  const parent = mkdtempSync(join(tmpdir(), 'cos-meetings-list-'))
  roots.push(parent)
  const recordingsRoot = join(parent, 'data', 'recordings')
  const importsRoot = join(parent, 'data', 'imports')
  mkdirSync(join(recordingsRoot, MONTH), { recursive: true })
  mkdirSync(join(importsRoot, MONTH), { recursive: true })
  const store = new MeetingStore(recordingsRoot)
  const library = new ImportedMeetingLibrary({ root: importsRoot })

  const operations = join(parent, 'operations')
  const directRoot = join(parent, 'library')
  if (options.layout === 'multi_domain') {
    mkdirSync(join(operations, 'personal', 'meetings', MONTH), { recursive: true })
    setEnv('COS_OPERATIONS_DIR', operations)
  } else if (options.layout === 'direct') {
    mkdirSync(join(directRoot, MONTH), { recursive: true })
    setEnv('COS_MEETINGS_ROOT', directRoot)
  }
  if (options.pipeline) {
    // `g2RecordingsReachOperations()` is the strict check: the venv interpreter
    // AND sync_meetings.py both have to exist for this Mac to count as one whose
    // pipeline files its own recordings.
    const scripts = join(parent, 'scripts')
    mkdirSync(join(scripts, 'venv', 'bin'), { recursive: true })
    writeFileSync(join(scripts, 'venv', 'bin', 'python3'), '#!/bin/sh\n')
    writeFileSync(join(scripts, 'sync_meetings.py'), '# stub\n')
    setEnv('COS_SCRIPTS_DIR', scripts)
  } else {
    setEnv('COS_SCRIPTS_DIR', undefined)
  }

  return {
    parent,
    store,
    library,
    storeMonthDir: join(recordingsRoot, MONTH),
    importsMonthDir: join(importsRoot, MONTH),
    operationsMonthDir: join(operations, 'personal', 'meetings', MONTH),
    directMonthDir: join(directRoot, MONTH),
  }
}

async function serve(store: MeetingStore, library: ImportedMeetingLibrary) {
  const app = express()
  app.use(express.json())
  app.use('/api', createMeetingsRouter(store, library))
  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  servers.push(server)
  const address = server.address()
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
  return async (path: string) => {
    const response = await fetch(`${base}${path}`)
    return { status: response.status, json: await response.json() as any }
  }
}

/** The import, and the merged record that holds it plus one capture. */
function writeImportAndMerge(
  library: ImportedMeetingLibrary,
  sessions: string[],
  dateMs: number,
): { importRecordId: string; mergedRecordId: string } {
  const importWrite = library.writeRecord({
    kind: 'fireflies',
    hash: importHash(FIREFLIES_ID),
    dateMs,
    markdown: meetingMarkdown('Launch review', 'imported', 'Fireflies'),
    sidecar: { version: 1, id: FIREFLIES_ID, originDomain: 'personal' },
  })
  const mergedWrite = library.writeRecord({
    kind: 'merged',
    hash: mergedHash(FIREFLIES_ID, sessions),
    dateMs,
    markdown: meetingMarkdown('Launch review', 'imported', 'G2 Glasses + Fireflies'),
    sidecar: {
      version: 1,
      actionId: 'a_0123456789abcdef',
      kind: 'merge',
      inputs: [
        { kind: 'fireflies', id: FIREFLIES_ID, sha256: null },
        ...sessions.map(sessionId => ({ kind: 'g2', id: sessionId, sha256: null })),
      ],
      tier: 'auto',
      pieces: [],
    },
  })
  return { importRecordId: importWrite.recordId, mergedRecordId: mergedWrite.recordId }
}

const dateMs = new Date(2026, 6, 15, 14, 5).getTime()

describe('meetings list with imports and derived records', () => {
  for (const layout of ['direct', 'multi_domain', 'standalone'] as const) {
    for (const pipeline of layout === 'multi_domain' ? [false, true] : [false]) {
      const name = layout === 'multi_domain' ? `multi_domain${pipeline ? ' with a pipeline' : ' without a pipeline'}` : layout

      it(`shows one row and a day count of 1 for a capture, its import and their merge (${name})`, async () => {
        const h = setup({ layout, pipeline })

        if (pipeline) {
          // On a pipeline Mac the merge was spliced INTO the Fireflies scribe, and
          // the capture's own scribe is still there until retire completes. The
          // scribe says what it holds; the list has to believe it.
          writeCapture(h.operationsMonthDir, `${DATE}_Launch_Review_G2.md`, SESSION, 'Launch review (G2)')
          writeFileSync(
            join(h.operationsMonthDir, `${DATE}_Launch_Review.md`),
            meetingMarkdown('Launch review', 'personal', 'G2 Glasses + Fireflies',
              `<!-- g2-transcript-blended -->\n<!-- g2-session: ${SESSION} -->\n<!-- merge-action: a_0123456789abcdef -->`),
          )
        } else {
          writeCapture(h.storeMonthDir, `${DATE}_Launch_Review_G2.md`, SESSION, 'Launch review (G2)')
          writeImportAndMerge(h.library, [SESSION], dateMs)
        }

        const api = await serve(h.store, h.library)
        const list = await api('/api/meetings?limit=50&domain=all')
        expect(list.status).toBe(200)
        expect(list.json.meetings).toHaveLength(1)
        expect(list.json.meetings[0]).toMatchObject({ derivedKind: 'merge', sessionId: SESSION })
        expect(list.json.meetings[0].actionId).toBe('a_0123456789abcdef')
        // A record in the IMPORTS library is read-only: it is a function of its
        // inputs and the next re-derive rewrites it. A pipeline-applied merge is
        // not that — it is the operations scribe itself, spliced in place — so it
        // stays writable, which is what keeps speaker correction working on a
        // merged meeting (plan blocker 8).
        expect(list.json.meetings[0].mutable).toBe(pipeline)
        expect(list.json.meetings[0].librarySource).toBe(pipeline ? 'cos_operations' : 'blended')

        const month = await api(`/api/meetings?month=${MONTH}`)
        expect(month.json.days).toEqual([{ date: DATE, count: 1 }])
      })

      it(`keeps two split pieces as two rows (${name})`, async () => {
        const h = setup({ layout, pipeline })
        for (const index of [0, 1]) {
          h.library.writeRecord({
            kind: 'piece',
            hash: pieceHash(`imported:fireflies:${importHash(FIREFLIES_ID)}`, index),
            dateMs: dateMs + index * 3_600_000,
            markdown: meetingMarkdown(`Long recording (part ${index + 1} of 2)`, 'imported', 'Fireflies (split)'),
            sidecar: {
              version: 1,
              actionId: 'a_fedcba9876543210',
              kind: 'split',
              inputs: [{ kind: 'fireflies', id: FIREFLIES_ID, sha256: null }],
              tier: 'auto',
              pieces: [{ index, startS: index * 3600, endS: (index + 1) * 3600, kind: 'matched', sessionIds: [SESSION] }],
            },
          })
        }

        const api = await serve(h.store, h.library)
        const list = await api('/api/meetings?limit=50&domain=all')
        // A pipeline Mac reads only its operations tree, so the pieces are not
        // its rows at all. Everywhere else two pieces are two meetings, and they
        // must not collapse on a shared session the way a sessionId would make
        // them.
        if (pipeline) {
          expect(list.json.meetings).toHaveLength(0)
          return
        }
        expect(list.json.meetings).toHaveLength(2)
        expect(list.json.meetings.map((row: any) => row.pieceIndex).sort()).toEqual([0, 1])
        expect(new Set(list.json.meetings.map((row: any) => row.recordId)).size).toBe(2)
        for (const row of list.json.meetings) {
          expect(row).toMatchObject({ librarySource: 'blended', derivedKind: 'split', mutable: false })
          expect(row.sessionId).toBeUndefined()
          expect(row.sourceSessionId).toBe(SESSION)
        }
      })

      it(`gives one merged row for two captures of one meeting (${name})`, async () => {
        const h = setup({ layout, pipeline })
        if (pipeline) {
          writeCapture(h.operationsMonthDir, `${DATE}_Launch_A_G2.md`, SESSION, 'Launch A (G2)')
          writeCapture(h.operationsMonthDir, `${DATE}_Launch_B_G2.md`, SECOND_SESSION, 'Launch B (G2)')
          writeFileSync(
            join(h.operationsMonthDir, `${DATE}_Launch_Review.md`),
            meetingMarkdown('Launch review', 'personal', 'G2 Glasses + Fireflies',
              `<!-- g2-session: ${SESSION} -->\n<!-- g2-session: ${SECOND_SESSION} -->\n<!-- merge-action: a_0123456789abcdef -->`),
          )
        } else {
          writeCapture(h.storeMonthDir, `${DATE}_Launch_A_G2.md`, SESSION, 'Launch A (G2)')
          writeCapture(h.storeMonthDir, `${DATE}_Launch_B_G2.md`, SECOND_SESSION, 'Launch B (G2)')
          writeImportAndMerge(h.library, [SESSION, SECOND_SESSION], dateMs)
        }

        const api = await serve(h.store, h.library)
        const list = await api('/api/meetings?limit=50&domain=all')
        expect(list.json.meetings).toHaveLength(1)
        expect(list.json.meetings[0].g2SessionIds).toEqual([SESSION, SECOND_SESSION])
        const month = await api(`/api/meetings?month=${MONTH}`)
        expect(month.json.days).toEqual([{ date: DATE, count: 1 }])
      })
    }
  }

  // 6.46.1: a Starter Kit multi-folder library with no COS pipeline lists the
  // server's own G2 saves beside the operations rows, operations first, and the
  // day count skips the store row an operations copy already covers.
  it('keeps the 6.46.1 multi_domain precedence when nothing is merged', async () => {
    const h = setup({ layout: 'multi_domain' })
    writeCapture(h.storeMonthDir, `${DATE}_Launch_Review_G2.md`, SESSION, 'Launch review (G2)')
    writeFileSync(join(h.operationsMonthDir, `${DATE}_Ops_Review.md`), meetingMarkdown('Ops review', 'personal', 'Granola'))

    const api = await serve(h.store, h.library)
    const first = await api('/api/meetings?limit=50&domain=all')
    expect(first.json.source).toBe('mixed_library')
    expect(first.json.meetings.map((row: any) => row.librarySource))
      .toEqual(['cos_operations', 'standalone_recordings'])
    expect((await api(`/api/meetings?month=${MONTH}`)).json.days).toEqual([{ date: DATE, count: 2 }])

    // The same capture reaching operations wins by sessionId and is counted once.
    writeCapture(h.operationsMonthDir, `${DATE}_Launch_Review_G2.md`, SESSION, 'Launch review')
    const synced = await api(`/api/meetings?month=${MONTH}`)
    expect(synced.json.meetings).toHaveLength(2)
    expect(synced.json.meetings.every((row: any) => row.librarySource === 'cos_operations')).toBe(true)
    expect(synced.json.days).toEqual([{ date: DATE, count: 2 }])
  })

  it('reports mixed_library and a read-only import row when nothing is merged', async () => {
    const h = setup({ layout: 'standalone' })
    h.library.writeRecord({
      kind: 'fireflies',
      hash: importHash(FIREFLIES_ID),
      dateMs,
      markdown: meetingMarkdown('Launch review', 'imported', 'Fireflies'),
      sidecar: { version: 1, id: FIREFLIES_ID, originDomain: 'quilt' },
    })
    const api = await serve(h.store, h.library)
    const list = await api('/api/meetings?limit=50&domain=all')
    expect(list.json.source).toBe('mixed_library')
    expect(list.json.meetings).toHaveLength(1)
    expect(list.json.meetings[0]).toMatchObject({
      librarySource: 'imported',
      recordId: `imported:fireflies:${importHash(FIREFLIES_ID)}`,
      mutable: false,
      domain: 'imported',
      originDomain: 'quilt',
      domainAbbr: 'Q',
    })
    // The routing domain, the meeting's own domain, and nothing else.
    expect((await api('/api/meetings?domain=quilt')).json.meetings).toHaveLength(1)
    expect((await api('/api/meetings?domain=imported')).json.meetings).toHaveLength(1)
    expect((await api('/api/meetings?domain=personal')).json.meetings).toHaveLength(0)

    // A month the store has never seen still has to reach the calendar pager, or
    // the reader cannot page back to a month that holds only imports.
    h.library.writeRecord({
      kind: 'fireflies',
      hash: importHash('ff-list-older'),
      dateMs: new Date(2026, 5, 2, 9, 0).getTime(),
      markdown: meetingMarkdown('Older import', 'imported', 'Fireflies'),
      sidecar: { version: 1, id: 'ff-list-older', originDomain: 'quilt' },
    })
    expect((await api('/api/meetings?limit=50&domain=all')).json.months).toContain('2026-06')
  })

  it('opens a merged record and names the sources it still holds', async () => {
    const h = setup({ layout: 'standalone' })
    writeCapture(h.storeMonthDir, `${DATE}_Launch_Review_G2.md`, SESSION, 'Launch review (G2)')
    writeImportAndMerge(h.library, [SESSION], dateMs)
    const filename = importedFilename('merged', DATE, mergedHash(FIREFLIES_ID, [SESSION]))

    const api = await serve(h.store, h.library)
    const detail = await api(`/api/meetings/imported/${MONTH}/${filename}`)
    expect(detail.status).toBe(200)
    expect(detail.json).toMatchObject({ librarySource: 'blended', derivedKind: 'merge', mutable: false })
    expect(detail.json.sources).toEqual([
      { kind: 'fireflies', id: FIREFLIES_ID, recordId: `imported:fireflies:${importHash(FIREFLIES_ID)}` },
      { kind: 'g2', id: SESSION, recordId: `standalone:${SESSION}` },
    ])
  })

  // The imported detail branch is gated on the ROUTING DOMAIN and a strict
  // filename. A recording whose title happens to contain "merged" produces a
  // store filename that must keep resolving through the store.
  it('resolves a G2 recording titled with the word merged through the store', async () => {
    const h = setup({ layout: 'standalone' })
    const filename = `${DATE}_Merged_Launch_Notes.md`
    writeCapture(h.storeMonthDir, filename, SESSION, 'Merged launch notes')

    const api = await serve(h.store, h.library)
    const detail = await api(`/api/meetings/personal/${MONTH}/${filename}`)
    expect(detail.status).toBe(200)
    expect(detail.json.title).toBe('Merged launch notes')
    expect(detail.json.librarySource).toBeUndefined()

    // And a near-miss inside the imports domain falls THROUGH rather than 404ing.
    const fallthrough = await api(`/api/meetings/imported/${MONTH}/${DATE}_merged_nothex.md`)
    expect(fallthrough.status).toBe(404)
  })

  // The imported branch is gated on the ROUTING domain as well as the filename.
  // Without the domain gate a request under any domain would serve the imported
  // record, so `/personal/...` and `/quilt/...` would return the same file under
  // two identities and Control would have two rows pointing at one record.
  it('serves an imported record only under the imported domain', async () => {
    const h = setup({ layout: 'standalone' })
    writeImportAndMerge(h.library, [SESSION], dateMs)
    const filename = importedFilename('merged', DATE, mergedHash(FIREFLIES_ID, [SESSION]))

    const api = await serve(h.store, h.library)
    expect((await api(`/api/meetings/imported/${MONTH}/${filename}`)).status).toBe(200)
    // Same month, same filename, a different routing domain: the store has no
    // such recording, so this must 404 rather than open the imported record.
    const wrongDomain = await api(`/api/meetings/personal/${MONTH}/${filename}`)
    expect(wrongDomain.status).toBe(404)
    const viaQuery = await api(`/api/meetings/detail?domain=personal&month=${MONTH}&filename=${filename}`)
    expect(viaQuery.status).toBe(404)
  })

  it('accepts exactly the three record filenames and nothing else', async () => {
    const { IMPORTED_DETAIL_FILENAME } = await import('./meetings.js')
    const hash = '00112233445566aa'
    for (const kind of ['fireflies', 'merged', 'piece']) {
      expect(IMPORTED_DETAIL_FILENAME.test(`${DATE}_${kind}_${hash}.md`), kind).toBe(true)
    }
    for (const name of [
      `${DATE}_Merged_Launch_Notes.md`,
      `${DATE}_merged_${hash} 2.md`,
      `${DATE}_merged_${hash.toUpperCase()}.md`,
      `${DATE}_blended_${hash}.md`,
      `${DATE}_merged_${hash}.md.txt`,
      `merged_${hash}.md`,
    ]) {
      expect(IMPORTED_DETAIL_FILENAME.test(name), name).toBe(false)
    }
  })
})
