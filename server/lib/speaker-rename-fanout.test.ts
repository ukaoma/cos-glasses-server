import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let root: string, operations: string, data: string
let fanout: typeof import('./speaker-rename-fanout.js')
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'speaker-fanout-'))
  operations = join(root, '.operations')
  data = join(root, '.data')
  mkdirSync(join(operations, 'quilt', 'meetings', '2026-08'), { recursive: true })
  mkdirSync(join(operations, 'scripts'), { recursive: true })
  mkdirSync(data)
  writeFileSync(join(operations, 'scripts', 'cos_python'), '#!/bin/sh\nexec /usr/bin/python3 "$@"\n', { mode: 0o700 })
  vi.stubEnv('COS_DATA_DIR', data)
  vi.stubEnv('COS_OPERATIONS_DIR', operations)
  vi.stubEnv('COS_SCRIPTS_DIR', join(operations, 'scripts'))
  vi.stubEnv('COS_MEETINGS_ROOT', '')
  vi.resetModules()
  fanout = await import('./speaker-rename-fanout.js')
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

function markdown(label = 'Luke H', format: 'inline' | 'newline' | 'bold' = 'inline'): string {
  const turn = format === 'bold' ? `**${label}** _[0:00]_:\nSomething said.`
    : format === 'newline' ? `[${label}]:\nSomething said.` : `[${label}]: Something said.`
  return `# Customer Decision\n\n## Attendees\n\n- ${label}\n- Miles Ukaoma\n\n## Transcript\n\n${turn}\n[Miles Ukaoma]: Other words.\n`
}
function sidecar(sessionId = 'meeting_fanout_001', name = 'Luke H', hq = true) {
  const chunks = [
    { speaker: name, text: 'Something said.', elapsed: 0, similarity: .11 },
    { speaker: 'Miles Ukaoma', text: 'Other words.', elapsed: 5000, similarity: .92 },
  ]
  return {
    sessionId, speakers: [name, 'Miles Ukaoma'], chunks, correctionRevision: 0, lifecycleRevision: 3,
    batchApplied: hq,
    chunkEntries: chunks.map((chunk, index) => ({ chunkIndex: index === 0 ? 3 : 7, chunk: { ...chunk } })),
    batchSegments: [{ startElapsed: 0, startChunkIdx: 0, endChunkIdx: 8, speakerWords: [
      { speaker: name, word: 'Something said.', start: 0, similarity: .11 },
      { speaker: 'Miles Ukaoma', word: 'Other words.', start: 5, similarity: .92 },
    ] }],
  }
}
function fixture(opts: { stem?: string; sessionId?: string; format?: 'inline' | 'newline' | 'bold'; hq?: boolean } = {}) {
  const stem = opts.stem ?? '2026-08-13_Customer_Decision'
  const localMonth = join(data, 'recordings', '2026-08')
  const opsMonth = join(operations, 'quilt', 'meetings', '2026-08')
  mkdirSync(localMonth, { recursive: true })
  const doc = sidecar(opts.sessionId, 'Luke H', opts.hq)
  const local = { sidecarPath: join(localMonth, stem + '.g2-chunks.json'), meetingPath: join(localMonth, stem + '.md') }
  const ops = { sidecarPath: join(opsMonth, stem + '.g2-chunks.json'), meetingPath: join(opsMonth, stem + '.md') }
  for (const paths of [local, ops]) {
    writeFileSync(paths.sidecarPath, JSON.stringify(doc, null, 2) + '\n')
    writeFileSync(paths.meetingPath, markdown('Luke H', opts.format))
  }
  return { local, ops, sessionId: doc.sessionId }
}
const load = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

it('dry-run predicts both copies and writes no file or correction ledger', async () => {
  const f = fixture()
  const before = [f.local, f.ops].flatMap(p => [p.sidecarPath, p.meetingPath]).map(p => readFileSync(p, 'utf8'))
  const result = await fanout.fanOutSpeakerRename(operations, 'Luke H', 'Luke Henry')
  expect(result).toMatchObject({ from: 'Luke H', to: 'Luke Henry', dryRun: true, skipped: [] })
  expect(result.sidecars).toHaveLength(2)
  expect(result.markdown).toHaveLength(2)
  expect(result.sidecars.every(p => p.labels === 1)).toBe(true)
  expect([f.local, f.ops].flatMap(p => [p.sidecarPath, p.meetingPath]).map(p => readFileSync(p, 'utf8'))).toEqual(before)
  expect(existsSync(join(data, 'meeting-corrections'))).toBe(false)
})

it.each(['inline', 'newline', 'bold'] as const)('applies %s labels through the two-copy ledger without enrollment', async format => {
  const f = fixture({ format })
  const voicePath = join(data, 'voice-profiles.json')
  const voice = JSON.stringify({ profiles: [{ name: 'Luke Henry', embeddings: [Array(192).fill(.1)], sources: ['manual'] }] })
  writeFileSync(voicePath, voice)
  const audioDir = join(data, 'ext-audio', f.sessionId)
  mkdirSync(audioDir, { recursive: true }); writeFileSync(join(audioDir, 'ext_chunk3_1.wav'), 'audio fixture')
  const result = await fanout.fanOutSpeakerRename(operations, 'Luke H', 'Luke Henry', { apply: true })
  expect(result.skipped).toEqual([])
  expect(result.sidecars).toHaveLength(2)
  expect(result.markdown).toHaveLength(2)
  for (const p of [f.local, f.ops]) {
    const changed = load(p.sidecarPath)
    expect(changed.chunks.map((c: any) => c.speaker)).toEqual(['Luke Henry', 'Miles Ukaoma'])
    expect(changed.chunkEntries[0].chunk.speaker).toBe('Luke Henry')
    expect(changed.batchSegments[0].speakerWords.map((w: any) => w.speaker)).toEqual(['Luke Henry', 'Miles Ukaoma'])
    expect(changed.batchSegments[0].speakerWords[0].similarity).toBe(.11)
    expect(changed.correctionRevision).toBe(1)
    expect(changed.labelsNewerThanGraph).toBe(true)
    expect(readFileSync(p.meetingPath, 'utf8')).toContain(format === 'bold' ? '**Luke Henry** _[0:00]_:' : '[Luke Henry]:')
    expect(readFileSync(p.meetingPath, 'utf8')).toContain('Something said.')
  }
  expect(readFileSync(voicePath, 'utf8')).toBe(voice)
  expect(readFileSync(join(audioDir, 'ext_chunk3_1.wav'), 'utf8')).toBe('audio fixture')
  const { readCorrections } = await import('./meeting-corrections.js')
  const rows = readCorrections(f.sessionId).rows
  expect(rows.some(r => r.phase === 'intent')).toBe(true)
  expect(rows.some(r => r.phase === 'applied')).toBe(true)
  expect(rows.filter(r => r.phase === 'applied').every(r => r.batchId)).toBe(true)
})

it('missing local copy fails closed with the original skip shape and leaves operations unchanged', async () => {
  const f = fixture(); const before = readFileSync(f.ops.sidecarPath, 'utf8')
  rmSync(f.local.sidecarPath)
  const result = await fanout.fanOutSpeakerRename(operations, 'Luke H', 'Luke Henry', { apply: true })
  expect(result.sidecars).toEqual([])
  expect(result.skipped).toEqual([{ path: f.ops.sidecarPath, reason: expect.stringMatching(/write failed:.*[Ll]ocal/) }])
  expect(readFileSync(f.ops.sidecarPath, 'utf8')).toBe(before)
})

it('a read-only operations copy prevents either sidecar being written', async () => {
  const f = fixture(); chmodSync(f.ops.meetingPath, 0o444)
  const before = readFileSync(f.local.sidecarPath, 'utf8')
  const result = await fanout.fanOutSpeakerRename(operations, 'Luke H', 'Luke Henry', { apply: true })
  expect(result.sidecars).toEqual([])
  expect(result.skipped[0].reason).toMatch(/read-only/)
  expect(readFileSync(f.local.sidecarPath, 'utf8')).toBe(before)
})

it('HQ pending and a damaged raw map refuse before any copy is written', async () => {
  const f = fixture()
  const doc = load(f.ops.sidecarPath); doc.hqState = 'running'
  writeFileSync(f.ops.sidecarPath, JSON.stringify(doc))
  let result = await fanout.fanOutSpeakerRename(operations, 'Luke H', 'Luke Henry', { apply: true })
  expect(result.skipped[0].reason).toMatch(/HQ/)
  expect(load(f.local.sidecarPath).correctionRevision).toBe(0)
  delete doc.hqState; doc.chunkEntries[0].chunk.text = 'Different transcript'
  writeFileSync(f.ops.sidecarPath, JSON.stringify(doc))
  result = await fanout.fanOutSpeakerRename(operations, 'Luke H', 'Luke Henry', { apply: true })
  expect(result.skipped[0].reason).toMatch(/map|mapping|text/i)
  expect(load(f.local.sidecarPath).correctionRevision).toBe(0)
})

it('keeps going after a bad file and reports legacy labels without unsafe fallbacks', async () => {
  const f = fixture(); const month = join(operations, 'quilt', 'meetings', '2026-08')
  writeFileSync(join(month, '2026-08-13_Broken.g2-chunks.json'), '{ bad json "Luke H"')
  writeFileSync(join(month, '2026-08-13_Legacy.md'), markdown())
  const result = await fanout.fanOutSpeakerRename(operations, 'Luke H', 'Luke Henry', { apply: true })
  expect(result.skipped.some(s => s.path.endsWith('Broken.g2-chunks.json'))).toBe(true)
  expect(result.skipped.some(s => s.path.endsWith('Legacy.md') && s.reason.includes('no G2 session sidecar'))).toBe(true)
  expect(readFileSync(f.ops.meetingPath, 'utf8')).toContain('[Luke Henry]:')
  expect(readFileSync(join(month, '2026-08-13_Legacy.md'), 'utf8')).toContain('[Luke H]:')
})

it('skips all three iCloud file conflict forms and conflict month folders', async () => {
  fixture(); const month = join(operations, 'quilt', 'meetings', '2026-08')
  for (const name of ['a 2.md', 'a 2.g2-chunks.json', 'a.g2-chunks 2.json']) writeFileSync(join(month, name), 'Luke H')
  const conflictMonth = join(operations, 'quilt', 'meetings', '2026-08 2')
  mkdirSync(conflictMonth); writeFileSync(join(conflictMonth, 'b.md'), markdown())
  const result = await fanout.fanOutSpeakerRename(operations, 'Luke H', 'Luke Henry')
  expect(result.skipped.filter(s => s.reason === 'icloud conflict copy')).toHaveLength(3)
  expect(fanout.meetingMonthDirs(operations)).not.toContain(conflictMonth)
})

it('does not report the new name as an old-name match, even when it is a substring', async () => {
  const f = fixture(); const doc = sidecar(f.sessionId, 'Luke Henry')
  for (const p of [f.local, f.ops]) { writeFileSync(p.sidecarPath, JSON.stringify(doc)); writeFileSync(p.meetingPath, markdown('Luke Henry')) }
  const result = await fanout.fanOutSpeakerRename(operations, 'Luke H', 'Luke Henry')
  expect(result.sidecars).toEqual([]); expect(result.markdown).toEqual([]); expect(result.skipped).toEqual([])
})

it('leaves archives out by default and explicitly reports unmappable archived labels when included', async () => {
  fixture(); const archive = join(operations, '.meeting_archive', 'old_client', 'meetings', '2026-05')
  mkdirSync(archive, { recursive: true }); writeFileSync(join(archive, 'x.md'), markdown())
  expect((await fanout.fanOutSpeakerRename(operations, 'Luke H', 'Luke Henry')).skipped.some(s => s.path.includes('.meeting_archive'))).toBe(false)
  expect((await fanout.fanOutSpeakerRename(operations, 'Luke H', 'Luke Henry', { includeArchive: true })).skipped.some(s => s.path.includes('.meeting_archive'))).toBe(true)
})

it('keeps no-op requests empty and retains the bold-label utility contract', async () => {
  for (const [from, to] of [['Luke H', 'Luke H'], ['', 'Luke Henry'], ['Luke H', '  ']]) {
    const result = await fanout.fanOutSpeakerRename(operations, from, to)
    expect(result.scanned).toBe(0); expect(result.sidecars).toHaveLength(0)
  }
  expect(fanout.countBoldLabels('**A. B (x)** _[1]_: he said **A. B (x)** was late', 'A. B (x)')).toBe(1)
})

it('reports stale prose without rewriting a quotation in the summary', async () => {
  const f = fixture(); writeFileSync(f.ops.meetingPath, '# Summary\n\nLuke H said the quarter looks fine.\n\n' + markdown())
  const result = await fanout.fanOutSpeakerRename(operations, 'Luke H', 'Luke Henry')
  expect(result.markdown.find(p => p.path === realpathSync(f.ops.meetingPath))?.note).toMatch(/prose still mentions/)
})

it('repairs old HQ speakerWords when the compacted chunk already carries the merged name', async () => {
  const f = fixture()
  for (const paths of [f.local, f.ops]) {
    const doc = load(paths.sidecarPath)
    doc.chunks[0].speaker = 'Luke Henry'
    doc.chunkEntries[0].chunk.speaker = 'Luke Henry'
    doc.speakers[0] = 'Luke Henry'
    writeFileSync(paths.sidecarPath, JSON.stringify(doc))
  }
  const result = await fanout.fanOutSpeakerRename(operations, 'Luke H', 'Luke Henry', { apply: true })
  expect(result.skipped).toEqual([])
  expect(result.sidecars).toHaveLength(2)
  for (const paths of [f.local, f.ops]) {
    expect(load(paths.sidecarPath).batchSegments[0].speakerWords[0].speaker).toBe('Luke Henry')
    expect(load(paths.sidecarPath).batchSegments[0].speakerWords[1].speaker).toBe('Miles Ukaoma')
  }
})

it('an open correction intent refuses fanout without changing either copy', async () => {
  const f = fixture()
  const { appendCorrection } = await import('./meeting-corrections.js')
  expect(appendCorrection(f.sessionId, {
    id: 'prior-intent', phase: 'intent', at: new Date().toISOString(), from: 'Luke H', to: 'Other',
    chunks: [0], scope: 'meeting', batchId: 'prior-batch',
  })).toBe(true)
  const result = await fanout.fanOutSpeakerRename(operations, 'Luke H', 'Luke Henry', { apply: true })
  expect(result.skipped[0].reason).toMatch(/interrupted correction/)
  expect(result.sidecars).toHaveLength(0)
  expect(load(f.local.sidecarPath).correctionRevision).toBe(0)
  expect(load(f.ops.sidecarPath).correctionRevision).toBe(0)
})
