import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fanOutSpeakerRename, meetingMonthDirs, countBoldLabels } from './speaker-rename-fanout.js'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

function sidecar(speakers: string[]): string {
  return JSON.stringify({
    speakers,
    chunks: speakers.map((s, i) => ({ index: i, speaker: s, text: `line ${i}` })),
  }, null, 2) + '\n'
}

function markdown(label: string): string {
  return [
    '# Meeting', '', '## Attendees', '', `- ${label}`, '- Miles Ukaoma', '',
    // `[Name]:` is the canonical form -- 4,590 turn labels across the real library use
    // it. My first fixture used `**Name**`, which the primitive deliberately does not
    // match, so the test failed for a reason that had nothing to do with the fan-out.
    '## Transcript', '', `[${label}]:`, 'Something said.', '',
  ].join('\n')
}

function library(): string {
  const root = mkdtempSync(join(tmpdir(), 'fanout-'))
  roots.push(root)
  const month = join(root, 'quilt', 'meetings', '2026-08')
  mkdirSync(month, { recursive: true })
  writeFileSync(join(month, 'a.g2-chunks.json'), sidecar(['Luke H', 'Miles Ukaoma']))
  writeFileSync(join(month, 'a.md'), markdown('Luke H'))
  return root
}

describe('a merge reaches the meetings it never used to', () => {
  it('DRY RUNS by default and writes nothing', () => {
    const root = library()
    const before = readFileSync(join(root, 'quilt/meetings/2026-08/a.g2-chunks.json'), 'utf-8')
    const r = fanOutSpeakerRename(root, 'Luke H', 'Luke Henry')
    expect(r.dryRun).toBe(true)
    expect(r.sidecars.length + r.markdown.length).toBeGreaterThan(0)
    // The report says what WOULD change; the disk is untouched.
    expect(readFileSync(join(root, 'quilt/meetings/2026-08/a.g2-chunks.json'), 'utf-8')).toBe(before)
  })

  it('rewrites both the sidecar and the transcript when asked', () => {
    const root = library()
    const r = fanOutSpeakerRename(root, 'Luke H', 'Luke Henry', { apply: true })
    expect(r.dryRun).toBe(false)
    const side = readFileSync(join(root, 'quilt/meetings/2026-08/a.g2-chunks.json'), 'utf-8')
    const md = readFileSync(join(root, 'quilt/meetings/2026-08/a.md'), 'utf-8')
    expect(side).toContain('Luke Henry')
    expect(JSON.parse(side).chunks.some((c: { speaker: string }) => c.speaker === 'Luke H')).toBe(false)
    expect(md).toContain('[Luke Henry]:')
  })

  it('counts labels, not files, so the report is honest about scale', () => {
    const root = library()
    const r = fanOutSpeakerRename(root, 'Luke H', 'Luke Henry')
    expect(r.sidecars[0]!.labels).toBeGreaterThan(0)
    expect(r.markdown[0]!.labels).toBeGreaterThan(0)
  })

  it('SKIPS iCloud conflict copies, which would edit a file nothing reads', () => {
    const root = library()
    const month = join(root, 'quilt', 'meetings', '2026-08')
    writeFileSync(join(month, 'a 2.md'), markdown('Luke H'))
    const conflictMonth = join(root, 'quilt', 'meetings', '2026-08 2')
    mkdirSync(conflictMonth, { recursive: true })
    writeFileSync(join(conflictMonth, 'b.md'), markdown('Luke H'))

    const r = fanOutSpeakerRename(root, 'Luke H', 'Luke Henry', { apply: true })
    // The conflict FILE is skipped and reported.
    expect(r.skipped.some(s => s.path.endsWith('a 2.md'))).toBe(true)
    expect(readFileSync(join(month, 'a 2.md'), 'utf-8')).toContain('[Luke H]:')
    // The conflict MONTH is never walked at all.
    expect(readFileSync(join(conflictMonth, 'b.md'), 'utf-8')).toContain('[Luke H]:')
    expect(meetingMonthDirs(root)).not.toContain(conflictMonth)
  })

  it('does not report a plain non-match as a skip', () => {
    // `Luke H` is a SUBSTRING of `Luke Henry`, so a file holding only the new name
    // passes the pre-filter and is then correctly rejected. On the real library that
    // padded the skip list with 15 non-issues, which hides the ones that matter.
    const root = library()
    const month = join(root, 'quilt', 'meetings', '2026-08')
    writeFileSync(join(month, 'done.g2-chunks.json'), sidecar(['Luke Henry']))
    const r = fanOutSpeakerRename(root, 'Luke H', 'Luke Henry')
    expect(r.skipped.some(s => s.path.endsWith('done.g2-chunks.json'))).toBe(false)
  })

  it('leaves the archive alone unless asked', () => {
    const root = library()
    const arch = join(root, '.meeting_archive', 'old_client', 'meetings', '2026-05')
    mkdirSync(arch, { recursive: true })
    writeFileSync(join(arch, 'x.md'), markdown('Luke H'))

    expect(fanOutSpeakerRename(root, 'Luke H', 'Luke Henry').markdown.some(f => f.path.includes('.meeting_archive'))).toBe(false)
    expect(fanOutSpeakerRename(root, 'Luke H', 'Luke Henry', { includeArchive: true })
      .markdown.some(f => f.path.includes('.meeting_archive'))).toBe(true)
  })

  it('refuses a no-op rename rather than walking the library for nothing', () => {
    const root = library()
    for (const [from, to] of [['Luke H', 'Luke H'], ['', 'Luke Henry'], ['Luke H', '  ']]) {
      const r = fanOutSpeakerRename(root, from!, to!)
      expect(r.scanned).toBe(0)
      expect(r.sidecars).toHaveLength(0)
    }
  })

  it('keeps going after one bad file, rather than half-renaming the library', () => {
    const root = library()
    const month = join(root, 'quilt', 'meetings', '2026-08')
    writeFileSync(join(month, 'broken.g2-chunks.json'), '{ this is not json "Luke H"')
    const r = fanOutSpeakerRename(root, 'Luke H', 'Luke Henry', { apply: true })
    expect(r.skipped.some(s => s.path.endsWith('broken.g2-chunks.json'))).toBe(true)
    // The good files still landed.
    expect(readFileSync(join(month, 'a.md'), 'utf-8')).toContain('[Luke Henry]:')
  })

  it('surfaces prose the primitive deliberately leaves alone', () => {
    const root = library()
    const month = join(root, 'quilt', 'meetings', '2026-08')
    writeFileSync(join(month, 'prose.md'),
      markdown('Luke H') + '\n## Summary\n\nLuke H said the quarter looks fine.\n')
    const r = fanOutSpeakerRename(root, 'Luke H', 'Luke Henry')
    const entry = r.markdown.find(f => f.path.endsWith('prose.md'))
    expect(entry?.note).toMatch(/prose still mentions/)
  })
})

describe('the second transcript format is reported, never silently missed', () => {
  // MEASURED, not hypothetical. For the Luke rename the real library holds 17 files /
  // 97 labels the primitive rewrites, and 20 files / 77 labels in a `**Name**` form it
  // does not -- 13 of those in LIVE quilt meetings. A fan-out that fixed 97 and said
  // nothing about 63 would report success on a 39% miss.
  const bold = (label: string) => [
    '# Meeting', '', '## Attendees', '', `- ${label}`, '',
    '## Transcript', '', `**${label}** _[9:42]_:`, 'Something said.', '',
  ].join('\n')

  it('reports unhandled labels as a note when the file ALSO has handled ones', () => {
    const root = library()
    const month = join(root, 'quilt', 'meetings', '2026-08')
    writeFileSync(join(month, 'mixed.md'),
      ['# Meeting', '', '## Attendees', '', '- Luke H', '',
       '## Transcript', '', '[Luke H]:', 'handled.', '', '**Luke H** _[9:43]_:', 'not handled.', ''].join('\n'))
    const r = fanOutSpeakerRename(root, 'Luke H', 'Luke Henry')
    const entry = r.markdown.find(f => f.path.endsWith('mixed.md'))
    expect(entry?.note).toMatch(/unhandled/)
  })

  it('REPORTS a bold-only file either way -- as a note, or as a skip', () => {
    // The invariant is visibility, not which list it lands in. A file with an attendee
    // bullet still gets rewritten there, so it appears with a note; a file with NO
    // handled label at all changes nothing and would otherwise fall out of the report
    // entirely, so it is recorded as a skip. My first version asserted only the skip
    // path and the fixture happened to take the other one.
    const root = library()
    const month = join(root, 'quilt', 'meetings', '2026-08')
    writeFileSync(join(month, 'boldonly.md'), bold('Luke H'))
    // No Attendees section at all: nothing handled anywhere in the file.
    writeFileSync(join(month, 'bold-nothing.md'),
      ['# Meeting', '', '## Transcript', '', '**Luke H** _[9:42]_:', 'said.', ''].join('\n'))

    const r = fanOutSpeakerRename(root, 'Luke H', 'Luke Henry')
    const noted = r.markdown.find(f => f.path.endsWith('boldonly.md'))
    expect(noted?.note).toMatch(/unhandled/)

    const skip = r.skipped.find(s => s.path.endsWith('bold-nothing.md'))
    expect(skip?.reason).toMatch(/unhandled/)
  })

  it('counts only line-anchored labels, not a bolded name inside spoken text', () => {
    expect(countBoldLabels('**Luke H** _[9:42]_:\nhe said **Luke H** was late\n', 'Luke H')).toBe(1)
    expect(countBoldLabels('no labels here at all', 'Luke H')).toBe(0)
  })

  it('escapes a name with regex characters rather than throwing', () => {
    expect(countBoldLabels('**A. B (x)** _[1]_:\n', 'A. B (x)')).toBe(1)
  })
})
