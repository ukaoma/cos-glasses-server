// The imported meeting library.
//
// The template is checked against BOTH readers that have to agree about it:
// this repo's own parser, and the COS pipeline's regexes in sync_meetings.py
// (`**Duration** | N min` at :1577-1580 and `**Date** | YYYY-MM-DD HH:MM` at
// :1618). The pipeline's copies are reproduced here as literals, so a template
// change that would break a pipeline Mac fails in this repo instead of there.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IMPORTED_FILENAME_PATTERN,
  actionItemLines,
  IMPORT_MARKDOWN_MAX_BYTES,
  IMPORT_SIDECAR_MAX_BYTES,
  ImportedLibraryError,
  ImportedMeetingLibrary,
  TRANSCRIPT_TRUNCATED_NOTE,
  importHash,
  importRecordId,
  importedFilename,
  mergedHash,
  pieceHash,
  renderImportMarkdown,
  singleLine,
  timestampLabel,
} from './imported-meeting-library.js'

// Every durable write goes through this wrapper, so the ORDER of the two
// writes is observed rather than assumed, and the markdown write can be made to
// fail exactly the way a full disk would.
const writeState = vi.hoisted(() => ({ failOnCall: 0, calls: [] as string[] }))
vi.mock('./atomic-fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomic-fs.js')>()
  return {
    ...actual,
    durableAtomicWriteFileSync: (path: string, data: string | Buffer, options?: { mode?: number }) => {
      writeState.calls.push(path)
      if (writeState.failOnCall === writeState.calls.length) throw new Error('disk full')
      return actual.durableAtomicWriteFileSync(path, data, options)
    },
  }
})

// The pipeline's own regexes, transcribed from sync_meetings.py.
const PIPELINE_DURATION = /\*\*Duration\*\*\s*\|\s*(\d+)\s*min/
const PIPELINE_DATE = /\*\*Date\*\*\s*\|\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/

const roots: string[] = []

function newLibrary(): ImportedMeetingLibrary {
  const root = mkdtempSync(join(tmpdir(), 'cos-imports-'))
  roots.push(root)
  return new ImportedMeetingLibrary({ root: join(root, 'imports') })
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  writeState.calls = []
  writeState.failOnCall = 0
  vi.restoreAllMocks()
})

const DATE_MS = new Date(2026, 8, 10, 14, 30).getTime()

function render(overrides: Partial<Parameters<typeof renderImportMarkdown>[0]> = {}): string {
  return renderImportMarkdown({
    title: 'Weekly planning',
    dateMs: DATE_MS,
    durationSeconds: 47 * 60,
    attendees: ['miles@example.com', 'gina@example.com'],
    sentences: [
      { speakerName: 'Miles', text: 'Lets start with the launch.', startTime: 65 },
      { speakerName: 'Gina', text: 'I will own the brief.', startTime: 3725 },
    ],
    ...overrides,
  })
}

function write(library: ImportedMeetingLibrary, overrides: { kind?: 'fireflies' | 'merged' | 'piece'; hash?: string; markdown?: string; sidecar?: unknown; dateMs?: number } = {}) {
  return library.writeRecord({
    kind: overrides.kind ?? 'fireflies',
    hash: overrides.hash ?? importHash('01KTQDNA393VRVDRF8VATAFJZR'),
    dateMs: overrides.dateMs ?? DATE_MS,
    markdown: overrides.markdown ?? render(),
    sidecar: overrides.sidecar ?? { schemaVersion: 1, kind: 'fireflies', originDomain: 'personal', sentences: [] },
  })
}

describe('template', () => {
  it('round trips date, time and duration through both readers', () => {
    const library = newLibrary()
    const result = write(library)
    const detail = library.detail(result.month, result.filename)!

    expect(detail.date).toBe('2026-09-10')
    expect(detail.time).toBe('14:30')
    expect(detail.durationMinutes).toBe(47)
    expect(detail.source).toBe('Fireflies')
    expect(detail.domain).toBe('imported')
    expect(detail.transcript).toContain('[00:01:05] Miles: Lets start with the launch.')
    expect(detail.transcript).toContain('[01:02:05] Gina: I will own the brief.')

    const markdown = readFileSync(result.filepath, 'utf8')
    expect(markdown.match(PIPELINE_DURATION)?.[1]).toBe('47')
    expect(markdown.match(PIPELINE_DATE)?.[1]).toBe('2026-09-10 14:30')
    // `## Transcript` must be last: the parser reads it to end of file.
    expect(markdown.indexOf('## Transcript')).toBeGreaterThan(markdown.indexOf('## Attendees'))
  })

  it('fails the pipeline duration regex for the plain field form', () => {
    // The pipeline reads the TABLE form only. A template that drifted to
    // `**Duration:** 47 minutes` would parse here and silently stop pairing on
    // a pipeline Mac, so the negative is pinned too.
    expect(PIPELINE_DURATION.test('**Duration:** 47 minutes')).toBe(false)
  })

  it('omits the duration row when the length is unknown', () => {
    const markdown = render({ durationSeconds: null })
    expect(markdown).not.toContain('**Duration**')
    expect(PIPELINE_DATE.test(markdown)).toBe(true)
  })

  it('neutralises markup that would forge a field or a section', () => {
    const markdown = render({
      title: '**Date** | 1999-01-01 ## Summary',
      sentences: [{ speakerName: 'Miles', text: '## Summary this is not a summary', startTime: 0 }],
    })
    const library = newLibrary()
    const result = write(library, { markdown })
    const detail = library.detail(result.month, result.filename)!
    expect(detail.date).toBe('2026-09-10')
    expect(detail.summary).toBe('')
    expect(singleLine('a  b\nc')).toBe('a b c')
    expect(timestampLabel(3725)).toBe('[01:02:05]')
    expect(timestampLabel(-4)).toBe('[00:00:00]')
  })

  it('truncates a transcript that would exceed the markdown ceiling', () => {
    const many = Array.from({ length: 200_000 }, (_, index) => ({
      speakerName: 'Speaker',
      text: `line ${index} ${'x'.repeat(60)}`,
      startTime: index,
    }))
    const markdown = render({ sentences: many })
    expect(Buffer.byteLength(markdown)).toBeLessThanOrEqual(IMPORT_MARKDOWN_MAX_BYTES)
    expect(markdown).toContain(TRANSCRIPT_TRUNCATED_NOTE)
  })
})

describe('the vendor summary', () => {
  const OVERVIEW = 'The team agreed the launch date and split the follow-ups.'
  // The vendor hands these back as ONE string with newlines in it.
  const ACTION_ITEMS = '**Miles**\nSend the brief\n\n**Gina**\n- Draft the post\n  \n1. Book the room\n'

  it('splits action items into one bullet per line', () => {
    expect(actionItemLines(ACTION_ITEMS)).toEqual([
      '**Miles**', 'Send the brief', '**Gina**', 'Draft the post', 'Book the room',
    ])
    // Every bullet shape the vendor has been seen to use, so the character
    // class is covered rather than merely present. A literal bullet here would
    // make this file non-ASCII, so it is written as an escape.
    expect(actionItemLines('\u2022 bullet\n* star\n- dash\n1. first\n2) second')).toEqual([
      'bullet', 'star', 'dash', 'first', 'second',
    ])
    // Blank, absent and null are all "no action items", never an empty bullet.
    expect(actionItemLines('')).toEqual([])
    expect(actionItemLines(null)).toEqual([])
    expect(actionItemLines(undefined)).toEqual([])
    expect(actionItemLines('\n  \n\n')).toEqual([])
    expect(actionItemLines('one line only')).toEqual(['one line only'])
  })

  it('renders both sections and reads them back', () => {
    const library = newLibrary()
    const markdown = render({ overview: OVERVIEW, actionItems: actionItemLines(ACTION_ITEMS) })
    const result = write(library, { markdown })
    const detail = library.detail(result.month, result.filename)!

    expect(detail.summary).toBe(OVERVIEW)
    expect(detail.actionItems.map(item => item.task)).toEqual([
      '*Miles*', 'Send the brief', '*Gina*', 'Draft the post', 'Book the room',
    ])
    // The rest of the round trip is unchanged by the new sections.
    expect(detail.date).toBe('2026-09-10')
    expect(detail.durationMinutes).toBe(47)
    expect(markdown.indexOf('## Summary')).toBeLessThan(markdown.indexOf('## Action Items'))
    expect(markdown.indexOf('## Action Items')).toBeLessThan(markdown.indexOf('## Transcript'))
  })

  it('omits each section when the vendor gave nothing', () => {
    const library = newLibrary()
    const result = write(library, { markdown: render() })
    const markdown = readFileSync(result.filepath, 'utf8')
    expect(markdown).not.toContain('## Summary')
    expect(markdown).not.toContain('## Action Items')
    expect(library.detail(result.month, result.filename)!.summary).toBe('')

    const overviewOnly = render({ overview: OVERVIEW })
    expect(overviewOnly).toContain('## Summary')
    expect(overviewOnly).not.toContain('## Action Items')
  })
})

describe('identity', () => {
  it('derives a stable name and record id per kind', () => {
    const hash = importHash('01KTQDNA393VRVDRF8VATAFJZR')
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(importHash('01KTQDNA393VRVDRF8VATAFJZR')).toBe(hash)
    expect(importedFilename('fireflies', '2026-09-10', hash)).toBe(`2026-09-10_fireflies_${hash}.md`)
    expect(importRecordId('fireflies', hash)).toBe(`imported:fireflies:${hash}`)
    expect(importRecordId('merged', hash)).toBe(`blended:${hash}`)
  })

  it('sorts merge inputs so input order cannot make two names', () => {
    expect(mergedHash('ff1', ['b', 'a'])).toBe(mergedHash('ff1', ['a', 'b']))
    expect(mergedHash('ff1', ['a'])).not.toBe(mergedHash('ff2', ['a']))
    // A session id may contain a colon, so the separator must not be one.
    expect(mergedHash('ff1', ['a:b', 'c'])).not.toBe(mergedHash('ff1', ['a', 'b:c']))
    expect(pieceHash('blended:abc', 0)).not.toBe(pieceHash('blended:abc', 1))
  })

  it('accepts only the strict filename shape', () => {
    const good = '2026-09-10_fireflies_0123456789abcdef.md'
    expect(IMPORTED_FILENAME_PATTERN.test(good)).toBe(true)
    for (const bad of [
      '2026-09-10_fireflies_0123456789ABCDEF.md',   // uppercase hex
      '2026-09-10_fireflies_0123456789abcde.md',    // 15 hex
      '2026-09-10_fireflies_0123456789abcdef0.md',  // 17 hex
      '2026-09-10_granola_0123456789abcdef.md',     // unknown kind
      '2026-13-10_fireflies_0123456789abcdef.md',   // month 13
      '2026-09-32_fireflies_0123456789abcdef.md',   // day 32
      '2026-09-10_fireflies_0123456789abcdef 2.md', // iCloud conflict copy
      '2026-09-10_fireflies_0123456789abcdef.md.md',
    ]) {
      expect(IMPORTED_FILENAME_PATTERN.test(bad), bad).toBe(false)
    }
  })
})

describe('writing', () => {
  it('writes the sidecar first and the markdown second', () => {
    const library = newLibrary()
    const result = write(library)

    // The markdown is the commit marker, so it must land LAST: the reverse
    // order publishes a listed record whose evidence never arrived.
    expect(writeState.calls).toHaveLength(2)
    expect(writeState.calls[0]).toBe(result.sidecarPath)
    expect(writeState.calls[1]).toBe(result.filepath)
    expect(statSync(result.filepath).mode & 0o777).toBe(0o600)
    expect(statSync(result.sidecarPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(library.root, result.month)).mode & 0o777).toBe(0o700)
  })

  it('removes the sidecar when the markdown write fails', () => {
    const library = newLibrary()
    writeState.failOnCall = 2

    expect(() => write(library)).toThrow('disk full')

    // Nothing is listed, and no evidence is left behind for the sweep to find.
    const monthDir = join(library.root, '2026-09')
    const names = existsSync(monthDir) ? readdirSync(monthDir) : []
    expect(names.filter(name => name.endsWith('.import.json'))).toEqual([])
    expect(names.filter(name => name.endsWith('.md'))).toEqual([])
    expect(library.list()).toEqual([])
  })

  it('does not rewrite when the bytes are identical', () => {
    const library = newLibrary()
    const first = write(library)
    expect(first.written).toBe(true)
    const second = write(library)
    expect(second.written).toBe(false)
    expect(second.filename).toBe(first.filename)

    const changed = write(library, { markdown: render({ title: 'Weekly planning, revised' }) })
    expect(changed.written).toBe(true)
  })

  it('refuses evidence or markdown past its ceiling', () => {
    const library = newLibrary()
    expect(() => write(library, { markdown: 'x'.repeat(IMPORT_MARKDOWN_MAX_BYTES + 1) }))
      .toThrow(ImportedLibraryError)
    expect(() => write(library, { sidecar: { blob: 'x'.repeat(IMPORT_SIDECAR_MAX_BYTES) } }))
      .toThrow(/too large/)
    // A sidecar well over the markdown ceiling but under its own is fine: that
    // is the whole point of the two ceilings.
    expect(() => write(library, { sidecar: { blob: 'x'.repeat(IMPORT_MARKDOWN_MAX_BYTES + 1_000) } }))
      .not.toThrow()
  })

  it('refuses a hash that is not the record shape', () => {
    const library = newLibrary()
    expect(() => write(library, { hash: 'nothex' })).toThrow(ImportedLibraryError)
  })
})

describe('listing', () => {
  it('lists rows with imported routing and the origin domain', () => {
    const library = newLibrary()
    write(library)
    const [row] = library.list()
    expect(row.domain).toBe('imported')
    expect(row.originDomain).toBe('personal')
    expect(row.domainAbbr).toBe('P')
    expect(row.librarySource).toBe('imported')
    expect(row.mutable).toBe(false)
    expect(row.recordId).toMatch(/^imported:fireflies:[0-9a-f]{16}$/)
    expect(row.date).toBe('2026-09-10')
    expect(row.time).toBe('14:30')
  })

  it('counts hashes by kind, so derived records cannot inflate an import count', () => {
    const library = newLibrary()
    write(library)
    write(library, { kind: 'merged', hash: mergedHash('ff1', ['s1']) })
    write(library, { kind: 'piece', hash: pieceHash('blended:abc', 1) })
    expect(library.listHashes().size).toBe(3)
    expect(library.listHashes({ kind: 'fireflies' }).size).toBe(1)
    expect(library.listHashes({ kind: 'merged' }).size).toBe(1)
  })

  it('refuses an origin domain a sidecar should not be able to assert', () => {
    const library = newLibrary()
    write(library, { sidecar: { originDomain: '../../etc/passwd' } })
    // A domain reaches a folder name and a badge. An unsafe one falls back
    // rather than being carried through to either.
    expect(library.list()[0].originDomain).toBe('personal')
  })

  it('marks derived rows by kind', () => {
    const library = newLibrary()
    write(library, { kind: 'merged', hash: mergedHash('ff1', ['s1']), sidecar: { originDomain: 'quilt' } })
    write(library, { kind: 'piece', hash: pieceHash('blended:abc', 1), sidecar: { originDomain: 'quilt' } })
    const kinds = library.list().map(row => [row.librarySource, row.derivedKind])
    expect(kinds).toContainEqual(['blended', 'merge'])
    expect(kinds).toContainEqual(['blended', 'split'])
    expect(library.list()[0].originDomain).toBe('quilt')
  })

  it('filters by all, by imported, and by where the meeting came from', () => {
    const library = newLibrary()
    write(library, { sidecar: { originDomain: 'quilt' } })
    write(library, { hash: importHash('01KVAWTTAC06C22CSMG0MG2K82'), sidecar: { originDomain: 'personal' } })
    expect(library.list({ domain: 'all' })).toHaveLength(2)
    expect(library.list({ domain: 'imported' })).toHaveLength(2)
    expect(library.list({ domain: 'quilt' })).toHaveLength(1)
    expect(library.list({ domain: 'hermit_crabs' })).toHaveLength(0)
  })

  it('ignores names it did not write', () => {
    const library = newLibrary()
    const result = write(library)
    const monthDir = join(library.root, result.month)
    writeFileSync(join(monthDir, '2026-09-10_fireflies_0123456789abcdef 2.md'), readFileSync(result.filepath))
    writeFileSync(join(monthDir, 'notes.md'), '# hand dropped')
    mkdirSync(join(library.root, '2026-09 2'))
    writeFileSync(join(library.root, '2026-09 2', '2026-09-10_fireflies_0123456789abcdef.md'), '# copy')
    expect(library.list()).toHaveLength(1)
    expect(library.listHashes().size).toBe(1)
  })

  it('refuses a symlinked month folder', () => {
    const library = newLibrary()
    write(library)
    const outside = mkdtempSync(join(tmpdir(), 'cos-imports-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, '2026-08-10_fireflies_0123456789abcdef.md'), render())
    symlinkSync(outside, join(library.root, '2026-08'))
    expect(library.list()).toHaveLength(1)
  })

  it('reads a sidecar back, bounded', () => {
    const library = newLibrary()
    const result = write(library, { sidecar: { schemaVersion: 1, originDomain: 'personal', sentences: [{ text: 'hi' }] } })
    expect(library.readSidecar(result.month, result.filename)).toMatchObject({ schemaVersion: 1 })
    expect(library.readSidecar('2026-09', 'nope.md')).toBeNull()
  })
})

describe('startup sweep', () => {
  it('removes temp files and sidecars whose markdown never landed', () => {
    const library = newLibrary()
    const result = write(library)
    const monthDir = join(library.root, result.month)

    // A crash between the two writes leaves exactly this.
    const orphan = join(monthDir, '2026-09-10_fireflies_aaaaaaaaaaaaaaaa.import.json')
    writeFileSync(orphan, '{"schemaVersion":1}')
    const temp = join(monthDir, '.2026-09-10_fireflies_bbbbbbbbbbbbbbbb.md.4242.a1b2c3d4e5f6.tmp')
    writeFileSync(temp, 'half a record')
    const rootTemp = join(library.root, '.fireflies-ledger.json.4242.a1b2c3d4e5f6.tmp')
    writeFileSync(rootTemp, '{}')
    const keep = join(monthDir, '2026-09-10_fireflies_0123456789abcdef 2.import.json')
    writeFileSync(keep, '{}')

    const swept = library.sweep()
    expect(swept).toEqual({ removedTemp: 2, removedSidecars: 1, skipped: false })
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(temp)).toBe(false)
    expect(existsSync(rootTemp)).toBe(false)
    // The real record and an iCloud copy are both left alone.
    expect(existsSync(result.filepath)).toBe(true)
    expect(existsSync(result.sidecarPath)).toBe(true)
    expect(existsSync(keep)).toBe(true)
  })

  it('does nothing at all while a writer holds the lease', () => {
    const library = newLibrary()
    write(library)
    const orphan = join(library.root, '2026-09', '2026-09-10_fireflies_aaaaaaaaaaaaaaaa.import.json')
    writeFileSync(orphan, '{}')
    // Mid-write this is the correct intermediate state, not debris.
    expect(library.sweep({ isBusy: () => true })).toEqual({ removedTemp: 0, removedSidecars: 0, skipped: true })
    expect(existsSync(orphan)).toBe(true)
  })

  it('is safe on a library that was never written', () => {
    expect(newLibrary().sweep()).toEqual({ removedTemp: 0, removedSidecars: 0, skipped: false })
  })
})
