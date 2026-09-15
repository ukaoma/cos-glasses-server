/**
 * Day counts on a plain 6.46.x upgrade (6.47.0, QA round 1, blocker 8).
 *
 * WHAT WAS WRONG. `supersededDayCounts` replaced three different per-layout day counts with
 * one UNION, and on a Mac with no Fireflies key, no imports and no merges that union is a
 * behaviour change nobody asked for:
 *
 *   - `direct` and `multi_domain` started adding the standalone recordings store to counts
 *     that had never included it, and
 *   - the store's own count ignored the `domain` filter every other group honours, so
 *     `domain=quilt` counted a `personal` recording.
 *
 * Both together made a domain-filtered calendar grow dots the list could not explain.
 * Supersession has nothing to subtract when nothing is derived, so the union buys nothing
 * there and the 6.46.1 per-layout source set is restored.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ImportedMeetingLibrary, importHash } from './imported-meeting-library.js'
import { MeetingStore } from './meeting-store.js'
import { supersededDayCounts } from './imported-library-rows.js'
import { probeMeetings } from './morning-brief-runtime.js'

const MONTH = '2026-07'
const DATE = '2026-07-15'
const OTHER_DATE = '2026-07-16'

const roots: string[] = []
const envKeys = ['COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_SCRIPTS_DIR'] as const
const savedEnv: Partial<Record<typeof envKeys[number], string | undefined>> = {}

function setEnv(key: typeof envKeys[number], value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  if (value == null) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  for (const key of envKeys) {
    const value = savedEnv[key]
    if (value == null) delete process.env[key]
    else process.env[key] = value
    delete savedEnv[key]
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function markdown(title: string, domain: string, date = DATE): string {
  return [
    `# ${title}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| **Date** | ${date} 14:05 |`,
    '| **Duration** | 28 minutes |',
    '| **Source** | G2 Glasses |',
    `| **Domain** | ${domain} |`,
    '',
    '## Transcript',
    '',
    '[00:00:05] Speaker A: Synthetic line.',
    '',
  ].join('\n')
}

function writeRecording(monthDir: string, filename: string, sessionId: string, domain: string, date = DATE): void {
  mkdirSync(monthDir, { recursive: true })
  writeFileSync(join(monthDir, filename), markdown(filename.replace(/\.md$/, ''), domain, date))
  writeFileSync(
    join(monthDir, filename.replace(/\.md$/, '.g2-chunks.json')),
    JSON.stringify({ sessionId, speakers: ['Speaker A'], durationMs: 1_680_000, chunks: [] }),
  )
}

/** A multi_domain tree with one `quilt` and one `personal` recording in the store. */
function upgradeMac(): { store: MeetingStore; library: ImportedMeetingLibrary; operations: string } {
  const parent = mkdtempSync(join(tmpdir(), 'cos-day-counts-'))
  roots.push(parent)
  const recordingsRoot = join(parent, 'data', 'recordings')
  const importsRoot = join(parent, 'data', 'imports')
  mkdirSync(join(recordingsRoot, MONTH), { recursive: true })
  const operations = join(parent, 'operations')
  mkdirSync(join(operations, 'quilt', 'meetings', MONTH), { recursive: true })
  setEnv('COS_OPERATIONS_DIR', operations)
  setEnv('COS_SCRIPTS_DIR', undefined)
  writeRecording(join(recordingsRoot, MONTH), `${DATE}_Quilt_Standup.md`, 'session_quilt', 'quilt')
  writeRecording(join(recordingsRoot, MONTH), `${OTHER_DATE}_Family_Call.md`, 'session_personal', 'personal', OTHER_DATE)
  return {
    store: new MeetingStore(recordingsRoot),
    library: new ImportedMeetingLibrary({ root: importsRoot }),
    operations,
  }
}

describe('the standalone store count honours the domain filter', () => {
  it('counts only the asked-for domain', () => {
    const { store } = upgradeMac()
    expect(store.listDayCounts(MONTH)).toEqual([{ date: DATE, count: 1 }, { date: OTHER_DATE, count: 1 }])
    expect(store.listDayCounts(MONTH, 'quilt')).toEqual([{ date: DATE, count: 1 }])
    expect(store.listDayCounts(MONTH, 'personal')).toEqual([{ date: OTHER_DATE, count: 1 }])
    expect(store.listDayCounts(MONTH, 'hermit_crabs')).toEqual([])
  })

  it('refuses a domain name that is not one, rather than reading a path from it', () => {
    const { store } = upgradeMac()
    expect(store.listDayCounts(MONTH, '../../etc')).toEqual([])
  })

  it('counts the whole month, not one capped page', () => {
    // `list()` caps a scoped query at 200 rows, and a day count that silently stops
    // counting is worse than one that costs a read.
    const parent = mkdtempSync(join(tmpdir(), 'cos-day-counts-cap-'))
    roots.push(parent)
    const monthDir = join(parent, MONTH)
    mkdirSync(monthDir, { recursive: true })
    for (let index = 0; index < 205; index++) {
      writeFileSync(join(monthDir, `${DATE}_Meeting${String(index).padStart(3, '0')}.md`), markdown('Meeting', 'quilt'))
    }
    const store = new MeetingStore(parent)
    expect(store.listDayCounts(MONTH, 'quilt')).toEqual([{ date: DATE, count: 205 }])
  })
})

describe('the day count honours the domain filter in every group', () => {
  it('leaves a personal recording out of a domain=quilt standalone count', () => {
    const { store, library } = upgradeMac()
    setEnv('COS_OPERATIONS_DIR', undefined)
    expect(supersededDayCounts(MONTH, 'standalone', { store, library, domain: 'quilt' }))
      .toEqual([{ date: DATE, count: 1 }])
    expect(supersededDayCounts(MONTH, 'standalone', { store, library, domain: 'all' }))
      .toEqual([{ date: DATE, count: 1 }, { date: OTHER_DATE, count: 1 }])
  })

  it('leaves a personal recording out of a domain=quilt multi_domain count', () => {
    // The exact shape the blocker describes: a multi_domain library, a `quilt` filter, and a
    // `personal` recording sitting in the server's own recordings store.
    const { store, library, operations } = upgradeMac()
    writeFileSync(join(operations, 'quilt', 'meetings', MONTH, `${DATE}_Ops_Review.md`), markdown('Ops review', 'quilt'))
    expect(supersededDayCounts(MONTH, 'multi_domain', { store, library, domain: 'quilt', pipeline: false }))
      .toEqual([{ date: DATE, count: 2 }])
    expect(supersededDayCounts(MONTH, 'multi_domain', { store, library, domain: 'personal', pipeline: false }))
      .toEqual([{ date: OTHER_DATE, count: 1 }])
  })
})

/**
 * The COVERAGE tile reads the same helper as the list, and that stays true.
 *
 * QA round 1 also asked for the 6.46.1 per-layout source set to be restored in
 * `probeMeetings` when nothing is derived. That was tried and REVERTED: on a pipeline Mac a
 * merged scribe lives in the operations tree with no `.derived.json` anywhere, so "nothing
 * is derived" is true while there is still a capture to subtract.
 * `morning-brief-probe-meetings.test.ts` pins exactly that case, and the gate broke it.
 *
 * The defect blocker 8 actually names — the store count ignoring the domain filter — is
 * fixed above, and the union already equals the 6.46.1 source set in every layout once the
 * imports root is empty, because each layout's day count is the union its OWN list shows.
 */
describe('the morning brief probe counts what the list counts', () => {
  it('uses the shared helper, so the tile and the list cannot disagree', () => {
    const { operations } = upgradeMac()
    writeFileSync(join(operations, 'quilt', 'meetings', MONTH, `${DATE}_Ops_Review.md`), markdown('Ops review', 'quilt'))
    const probe = probeMeetings()
    expect(probe?.layout).toBe('multi_domain')
    // Same month, same helper, same answer. `probeMeetings` resolves the process-wide store
    // and imports library; the operations tree is env-driven and is the one both read here.
    const viaHelper = supersededDayCounts(MONTH, 'multi_domain', { domain: 'all' })
      .reduce((sum, day) => sum + day.count, 0)
    expect(probe?.count).toBe(viaHelper)
  })
})

describe('with imports present, the union still honours the domain', () => {
  /**
   * The OTHER half of blocker 8, and the one the 6.46.1 fallback hides.
   *
   * As soon as anything is imported, `supersededDayCounts` takes its union branch, and there
   * the store's own count was the one group that ignored the `domain` filter every other
   * group honours. A `domain=quilt` calendar counted a `personal` recording.
   */
  function withOneImport(): { store: MeetingStore; library: ImportedMeetingLibrary } {
    const { store, library } = upgradeMac()
    setEnv('COS_OPERATIONS_DIR', undefined)
    library.writeRecord({
      kind: 'fireflies',
      hash: importHash('ff-domain-1'),
      dateMs: new Date(2026, 6, 16, 9, 0).getTime(),
      markdown: markdown('Family planning', 'imported', OTHER_DATE),
      sidecar: { version: 1, id: 'ff-domain-1', originDomain: 'personal' },
    })
    return { store, library }
  }

  it('counts only the quilt recording under domain=quilt', () => {
    const { store, library } = withOneImport()
    // The personal recording and the personal import both belong to another domain.
    expect(supersededDayCounts(MONTH, 'standalone', { store, library, domain: 'quilt' }))
      .toEqual([{ date: DATE, count: 1 }])
  })

  it('counts only the personal ones under domain=personal', () => {
    const { store, library } = withOneImport()
    // One store recording plus one import, both on the same day.
    expect(supersededDayCounts(MONTH, 'standalone', { store, library, domain: 'personal' }))
      .toEqual([{ date: OTHER_DATE, count: 2 }])
  })

  it('counts everything under domain=all', () => {
    const { store, library } = withOneImport()
    expect(supersededDayCounts(MONTH, 'standalone', { store, library, domain: 'all' }))
      .toEqual([{ date: DATE, count: 1 }, { date: OTHER_DATE, count: 2 }])
  })

  it('leaves a personal standalone recording out of a multi_domain domain=quilt count', () => {
    // The exact shape the blocker describes: a multi_domain library, a `quilt` filter, and a
    // `personal` recording sitting in the server's own recordings store.
    const { store, library, operations } = upgradeMac()
    writeFileSync(join(operations, 'quilt', 'meetings', MONTH, `${DATE}_Ops_Review.md`), markdown('Ops review', 'quilt'))
    library.writeRecord({
      kind: 'fireflies',
      hash: importHash('ff-md-1'),
      dateMs: new Date(2026, 6, 16, 9, 0).getTime(),
      markdown: markdown('Family planning', 'imported', OTHER_DATE),
      sidecar: { version: 1, id: 'ff-md-1', originDomain: 'personal' },
    })
    // One operations row plus one quilt recording in the store. The personal recording and
    // the personal import belong to another domain and are not this day's dots.
    expect(supersededDayCounts(MONTH, 'multi_domain', { store, library, domain: 'quilt', pipeline: false }))
      .toEqual([{ date: DATE, count: 2 }])
  })
})

/**
 * The recordings-root fallback, shared with the list.
 *
 * The operations tree gitignores `.g2-chunks.json`, so a recording whose markdown arrived
 * through git or iCloud sits there with no sidecar beside it. `listCosOperationsMeetings`
 * handles that by looking under the SERVER's own recordings root by the same stem; the day
 * count did not, so a row the list DROPPED was still counted and the dot said two where the
 * list showed one.
 */
describe('a scribe whose sidecar is only under the recordings root', () => {
  it('is still dropped from the count when a merged scribe declares its session', () => {
    const parent = mkdtempSync(join(tmpdir(), 'cos-day-counts-fallback-'))
    roots.push(parent)
    const operations = join(parent, 'operations')
    const opsMonth = join(operations, 'quilt', 'meetings', MONTH)
    mkdirSync(opsMonth, { recursive: true })
    const recordingsRoot = join(parent, 'data', 'recordings')
    mkdirSync(join(recordingsRoot, MONTH), { recursive: true })
    setEnv('COS_OPERATIONS_DIR', operations)
    setEnv('COS_SCRIPTS_DIR', undefined)

    // The capture's MARKDOWN reached operations; its sidecar did not.
    writeFileSync(join(opsMonth, `${DATE}_Standup.md`), markdown('Standup', 'quilt'))
    writeFileSync(
      join(recordingsRoot, MONTH, `${DATE}_Standup.g2-chunks.json`),
      JSON.stringify({ sessionId: 'fallback_session', speakers: ['Speaker A'], durationMs: 1_680_000, chunks: [] }),
    )
    // And the merged scribe beside it says it holds that session.
    writeFileSync(join(opsMonth, `${DATE}_Weekly.md`), [
      markdown('Weekly', 'quilt').trimEnd(),
      '',
      '<!-- g2-transcript-blended -->',
      '<!-- g2-session: fallback_session -->',
      '<!-- merge-action: a_0123456789abcdef -->',
      '',
    ].join('\n'))

    const store = new MeetingStore(recordingsRoot)
    const library = new ImportedMeetingLibrary({ root: join(parent, 'data', 'imports') })
    // Two scribes on disk, one of them superseded: one dot.
    expect(supersededDayCounts(MONTH, 'multi_domain', {
      store,
      library,
      domain: 'quilt',
      pipeline: true,
      recordingsRoot,
    })).toEqual([{ date: DATE, count: 1 }])
  })

  it('accepts the sessions the caller already declared instead of re-reading the month', () => {
    // `/api/meetings` has just read every scribe in this month and knows which sessions the
    // merged ones hold. The count must agree with what it was handed.
    const parent = mkdtempSync(join(tmpdir(), 'cos-day-counts-declared-'))
    roots.push(parent)
    const operations = join(parent, 'operations')
    const opsMonth = join(operations, 'quilt', 'meetings', MONTH)
    mkdirSync(opsMonth, { recursive: true })
    setEnv('COS_OPERATIONS_DIR', operations)
    setEnv('COS_SCRIPTS_DIR', undefined)
    writeRecording(opsMonth, `${DATE}_Standup.md`, 'declared_session', 'quilt')
    writeFileSync(join(opsMonth, `${DATE}_Weekly.md`), markdown('Weekly', 'quilt'))

    const store = new MeetingStore(join(parent, 'data', 'recordings'))
    const library = new ImportedMeetingLibrary({ root: join(parent, 'data', 'imports') })
    const options = { store, library, domain: 'quilt', pipeline: true } as const
    // Nothing on disk says the Weekly scribe holds anything, so the scan finds no merge.
    expect(supersededDayCounts(MONTH, 'multi_domain', options)).toEqual([{ date: DATE, count: 2 }])
    // Told what the list declared, it subtracts that instead of reading every scribe again.
    expect(supersededDayCounts(MONTH, 'multi_domain', {
      ...options,
      declaredSessions: new Set(['declared_session']),
    })).toEqual([{ date: DATE, count: 1 }])
  })
})

describe('once something IS derived, supersession runs again', () => {
  it('drops the capture a merged record holds, in the domain that asked', () => {
    const { store, library } = upgradeMac()
    setEnv('COS_OPERATIONS_DIR', undefined)
    const dateMs = new Date(2026, 6, 15, 14, 5).getTime()
    library.writeRecord({
      kind: 'fireflies',
      hash: importHash('ff-day-1'),
      dateMs,
      markdown: markdown('Launch review', 'imported'),
      sidecar: { version: 1, id: 'ff-day-1', originDomain: 'quilt' },
    })
    library.writeRecord({
      kind: 'merged',
      hash: 'a'.repeat(16),
      dateMs,
      markdown: markdown('Launch review merged', 'imported'),
      sidecar: {
        version: 1,
        actionId: 'a_0123456789abcdef',
        kind: 'merge',
        inputs: [
          { kind: 'fireflies', id: 'ff-day-1', sha256: null },
          { kind: 'g2', id: 'session_quilt', sha256: null },
        ],
        tier: 'auto',
        pieces: [],
        originDomain: 'quilt',
      },
    })
    // One merged record replaces its import AND the capture it holds: one row, one dot.
    expect(supersededDayCounts(MONTH, 'standalone', { store, library, domain: 'all' }))
      .toEqual([{ date: DATE, count: 1 }, { date: OTHER_DATE, count: 1 }])
  })
})
