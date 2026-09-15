/**
 * What a suggestion is ABOUT (6.47.0, QA round 1, blocker 6).
 *
 * WHAT WAS WRONG. Suggested merges was unreadable on a pipeline Mac — the one surface where
 * a person actually reviews them, because advise mode is the whole point of the review gate.
 * The client resolved the Fireflies side by re-deriving `imported:fireflies:<h16>` and
 * looking it up in the imported library, which on a pipeline Mac is empty: the meeting is a
 * scribe in the operations tree at a path only the server knows. `resolved` was literally
 * `index.isEmpty ? false : true`, so it described the index rather than the side.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ImportedMeetingLibrary, importHash, importedFilename } from './imported-meeting-library.js'
import { MeetingStore } from './meeting-store.js'
import { resolveSuggestionSides, withSuggestionSides } from './meeting-suggestion-sides.js'
import type { MergeSuggestionRecord } from './meeting-actions-store.js'

const roots: string[] = []
const savedEnv: Record<string, string | undefined> = {}
const MONTH = '2026-08'
const DATE = '2026-08-20'
const FIREFLIES_ID = 'ff-side-001'
const SESSION = 'side_session_001'

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  if (value == null) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
    delete savedEnv[key]
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function markdown(title: string, source: string, domain: string, minutes = 47): string {
  return [
    `# ${title}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| **Date** | ${DATE} 14:05 |`,
    `| **Duration** | ${minutes} minutes |`,
    `| **Source** | ${source} |`,
    `| **Domain** | ${domain} |`,
    '',
    '## Transcript',
    '',
    '[00:00:05] Speaker A: Synthetic line.',
    '',
  ].join('\n')
}

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

const suggestion: MergeSuggestionRecord = {
  id: 's_0123456789abcdef',
  kind: 'merge',
  inputs: { sessionIds: [SESSION], firefliesIds: [FIREFLIES_ID] },
  fingerprints: 'f',
  evidence: { K1: 47, K2: 0 },
  state: 'open',
  at: '2026-08-20T14:05:00.000Z',
}

describe('on a pipeline Mac, where the review happens', () => {
  function operationsTree(): { library: ImportedMeetingLibrary; store: MeetingStore; monthDir: string } {
    const parent = scratch('cos-sides-ops-')
    const operations = join(parent, 'operations')
    const monthDir = join(operations, 'quilt', 'meetings', MONTH)
    mkdirSync(monthDir, { recursive: true })
    writeFileSync(join(monthDir, `${DATE}_Weekly_Sync.md`), markdown('Weekly Sync', 'Fireflies', 'quilt', 47))
    writeFileSync(join(monthDir, `${DATE}_Weekly_Sync.fireflies.json`), JSON.stringify({
      sidecar_version: 1,
      clipped: false,
      id: FIREFLIES_ID,
      date: Date.UTC(2026, 7, 20, 14, 5, 0),
      duration: 47,
      title: 'Weekly Sync',
      participants: [],
      sentences: [],
    }))
    writeFileSync(join(monthDir, `${DATE}_Standup.md`), markdown('Standup', 'G2 Glasses', 'quilt', 28))
    writeFileSync(join(monthDir, `${DATE}_Standup.g2-chunks.json`), JSON.stringify({
      sessionId: SESSION,
      startTime: Date.UTC(2026, 7, 20, 14, 5, 0),
      durationMs: 1_680_000,
      chunks: [],
    }))
    setEnv('COS_OPERATIONS_DIR', operations)
    const dataDir = scratch('cos-sides-data-')
    return {
      library: new ImportedMeetingLibrary({ root: join(dataDir, 'imports') }),
      store: new MeetingStore(join(dataDir, 'recordings')),
      monthDir,
    }
  }

  it('resolves the Fireflies side from the operations scribe, not from an empty imports root', () => {
    const { library, store } = operationsTree()
    const sides = resolveSuggestionSides(suggestion.inputs, {
      library,
      store,
      firefliesScribeRelPaths: {
        [FIREFLIES_ID]: {
          sidecarRelPath: `quilt/meetings/${MONTH}/${DATE}_Weekly_Sync.fireflies.json`,
          scribeRelPath: `quilt/meetings/${MONTH}/${DATE}_Weekly_Sync.md`,
        },
      },
    })
    const fireflies = sides.find(side => side.kind === 'fireflies')!
    expect(fireflies.resolved).toBe(true)
    expect(fireflies.source).toBe('cos_operations')
    expect(fireflies.title).toBe('Weekly Sync')
    expect(fireflies.durationMinutes).toBe(47)
    expect(fireflies.startMs).toBe(Date.UTC(2026, 7, 20, 14, 5, 0))
    // The record id `/api/meetings` uses, so a surface can open the row it names.
    expect(fireflies.recordId).toBe(`ops:quilt:${MONTH}:${DATE}_Weekly_Sync.md`)
  })

  it('resolves the G2 side from the operations copy of the capture', () => {
    const { library, store } = operationsTree()
    const sides = resolveSuggestionSides(suggestion.inputs, { library, store })
    const g2 = sides.find(side => side.kind === 'g2')!
    expect(g2).toMatchObject({
      resolved: true,
      source: 'cos_operations',
      title: 'Standup',
      durationMinutes: 28,
      recordId: `ops:quilt:${MONTH}:${DATE}_Standup.md`,
    })
  })

  it('says resolved: false for a side nothing on this Mac holds', () => {
    // A real state — a deleted recording, a transcript the vendor removed — and one a person
    // has to be able to see rather than a row that renders as two opaque ids.
    const { library, store } = operationsTree()
    const sides = resolveSuggestionSides({ sessionIds: ['gone_session'], firefliesIds: ['gone-ff'] }, { library, store })
    expect(sides.map(side => side.resolved)).toEqual([false, false])
    expect(sides.every(side => side.recordId === undefined)).toBe(true)
  })
})

describe('on a Mac that imports for itself', () => {
  function importsTree(): { library: ImportedMeetingLibrary; store: MeetingStore } {
    const dataDir = scratch('cos-sides-imports-')
    const library = new ImportedMeetingLibrary({ root: join(dataDir, 'imports') })
    library.writeRecord({
      kind: 'fireflies',
      hash: importHash(FIREFLIES_ID),
      dateMs: Date.UTC(2026, 7, 20, 14, 5, 0),
      markdown: markdown('Weekly Sync', 'Fireflies', 'imported', 47),
      sidecar: { firefliesId: FIREFLIES_ID, originDomain: 'quilt' },
    })
    const recordings = join(dataDir, 'recordings')
    mkdirSync(join(recordings, MONTH), { recursive: true })
    writeFileSync(join(recordings, MONTH, `${DATE}_Standup.md`), markdown('Standup', 'G2 Glasses', 'personal', 28))
    writeFileSync(join(recordings, MONTH, `${DATE}_Standup.g2-chunks.json`), JSON.stringify({
      sessionId: SESSION,
      startTime: Date.UTC(2026, 7, 20, 14, 5, 0),
      durationMs: 1_680_000,
      chunks: [],
    }))
    setEnv('COS_OPERATIONS_DIR', undefined)
    setEnv('COS_MEETINGS_ROOT', undefined)
    return { library, store: new MeetingStore(recordings) }
  }

  it('resolves the Fireflies side to its imported record', () => {
    const { library, store } = importsTree()
    const sides = resolveSuggestionSides(suggestion.inputs, { library, store })
    const fireflies = sides.find(side => side.kind === 'fireflies')!
    expect(fireflies).toMatchObject({
      resolved: true,
      source: 'imported',
      recordId: `imported:fireflies:${importHash(FIREFLIES_ID)}`,
      title: 'Weekly Sync',
      durationMinutes: 47,
    })
    expect(importedFilename('fireflies', DATE, importHash(FIREFLIES_ID)))
      .toBe(`${DATE}_fireflies_${importHash(FIREFLIES_ID)}.md`)
  })

  it('resolves the G2 side to the standalone recording', () => {
    const { library, store } = importsTree()
    const g2 = resolveSuggestionSides(suggestion.inputs, { library, store }).find(side => side.kind === 'g2')!
    expect(g2).toMatchObject({ resolved: true, source: 'standalone_recordings', recordId: `standalone:${SESSION}` })
    expect(g2.title).toBe('Standup')
  })
})

describe('every row carries its sides', () => {
  it('keeps the suggestion intact and adds one side per canonical id, captures first', () => {
    const dataDir = scratch('cos-sides-rows-')
    const library = new ImportedMeetingLibrary({ root: join(dataDir, 'imports') })
    const store = new MeetingStore(join(dataDir, 'recordings'))
    setEnv('COS_OPERATIONS_DIR', undefined)
    const rows = withSuggestionSides([suggestion], { library, store })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: suggestion.id, kind: 'merge', evidence: { K1: 47, K2: 0 } })
    expect(rows[0].sides.map(side => side.kind)).toEqual(['g2', 'fireflies'])
    expect(rows[0].sides.map(side => side.id)).toEqual([SESSION, FIREFLIES_ID])
  })

  it('carries a side per input on a three-way group', () => {
    const dataDir = scratch('cos-sides-group-')
    const library = new ImportedMeetingLibrary({ root: join(dataDir, 'imports') })
    const store = new MeetingStore(join(dataDir, 'recordings'))
    setEnv('COS_OPERATIONS_DIR', undefined)
    const sides = resolveSuggestionSides({ sessionIds: ['a', 'b'], firefliesIds: ['x', 'y'] }, { library, store })
    expect(sides.map(side => `${side.kind}:${side.id}`)).toEqual(['g2:a', 'g2:b', 'fireflies:x', 'fireflies:y'])
  })
})
