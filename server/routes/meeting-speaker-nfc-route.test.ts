// Speaker names arrive decomposed (NFD) from COS Control's helper (Foundation's Process turns an argument into NFD), while the
// pipeline's sidecars hold NFC. These drive the real routes over HTTP with real NFD and NFC strings and read the files back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const NFC = 'Brigitta Pólya'
const NFD = 'Brigitta Pólya'
const MONTH = '2026-08'
const STEM = '2026-08-05_Review_abc12345'
let root = '', dataDir = '', server: Server | null = null, baseUrl = ''

it('the two spellings really are different bytes', () => {
  expect(NFC).not.toBe(NFD)
  expect(Buffer.from('Pólya').toString('hex')).toBe('50c3b36c7961')
  expect(Buffer.from('Pólya').toString('hex')).toBe('506fcc816c7961')
})

function seed(sessionId: string, spelling: string, otherLabels: string[] = ['MU']): void {
  const dir = join(root, MONTH)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${STEM}.md`), `# Review\n\n## Attendees\n\n- ${spelling}\n- MU\n\n## Summary\n\nWe talked.\n\n## Transcript\n\n[${spelling}]: First point.\n[MU]: Agreed.\n[${spelling}]: Second point.\n`)
  const labels = [spelling, ...otherLabels, spelling]
  writeFileSync(join(dir, `${STEM}.g2-chunks.json`), JSON.stringify({
    schemaVersion: 2, sessionId, startTime: 1786027607017, durationMs: 80000, speakers: [...new Set(labels)],
    chunks: labels.map((speaker, i) => ({ text: `segment ${i} words`, speaker, elapsed: i * 7000, similarity: 0.82, words: [{ word: ' segment', start: 0, end: 0.4, probability: 0.9 }] })),
  }, null, 2))
}
const sidecar = () => JSON.parse(readFileSync(join(root, MONTH, `${STEM}.g2-chunks.json`), 'utf-8')) as { speakers: string[]; chunks: Array<{ speaker: string }> }
const scribe = () => readFileSync(join(root, MONTH, `${STEM}.md`), 'utf-8')
const ledger = (sessionId: string) => { try { return readFileSync(join(dataDir, 'meeting-corrections', `${sessionId}.jsonl`), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>) } catch { return [] } }
/** Every string anywhere in a value, so "no decomposed name was written" is checked over whole files, not one field. */
const hasNfd = (text: string) => text !== text.normalize('NFC')

async function startServer(): Promise<void> {
  vi.resetModules()
  vi.doMock('../lib/profile.js', () => ({ getOwnerSpeakerLabel: () => 'MU', getVocabulary: () => [], getOwnerName: () => 'Miles', getTranscriptionProfileStatus: () => ({}) }))
  const { MeetingStore } = await import('../lib/meeting-store.js')
  const { createMeetingRouter } = await import('./meeting.js')
  const { voiceRouter } = await import('./voice.js')
  const app = express()
  app.use(express.json())
  app.use('/api', createMeetingRouter({ store: new MeetingStore(root) }))
  app.use('/api', voiceRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`; resolve() }) })
}
function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(Buffer.from(c)))
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }) })
    })
    req.on('error', reject)
    req.end(payload)
  })
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cos-nfc-')); dataDir = mkdtempSync(join(tmpdir(), 'cos-nfc-data-')); process.env.COS_DATA_DIR = dataDir })
afterEach(async () => {
  await new Promise<void>(r => server ? server.close(() => r()) : r())
  server = null
  vi.resetModules(); vi.doUnmock('../lib/profile.js')
  delete process.env.COS_DATA_DIR
  for (const d of [root, dataDir]) if (d) rmSync(d, { recursive: true, force: true })
})
const T = 30_000

describe('confirm', () => {
  it('a decomposed label confirms a composed sidecar, and the ledger holds NFC', async () => {
    seed('meeting_n1', NFC)
    await startServer()
    const res = await post('/api/meeting/meeting_n1/confirm', { label: NFD })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ confirmed: true, label: NFC, segments: 2 })
    const rows = ledger('meeting_n1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ from: NFC, to: NFC })
    expect(hasNfd(JSON.stringify(rows))).toBe(false)
  }, T)

  it('a composed label confirms a decomposed sidecar (data written before this existed)', async () => {
    seed('meeting_n2', NFD)
    await startServer()
    const res = await post('/api/meeting/meeting_n2/confirm', { label: NFC })
    expect(res.status).toBe(200)
    expect(res.json.segments).toBe(2)
    expect(hasNfd(JSON.stringify(ledger('meeting_n2')))).toBe(false)
  }, T)

  it('a different name is still refused', async () => {
    seed('meeting_n3', NFC)
    await startServer()
    for (const wrong of ['Brigitta Polya', 'Brigitta Pólyas', 'Pólya']) {
      const res = await post('/api/meeting/meeting_n3/confirm', { label: wrong })
      expect(res.status).toBe(409)
      expect(res.json.reason).toBe('label_not_present')
    }
    expect(ledger('meeting_n3')).toEqual([])
  }, T)
})

describe('relabel', () => {
  it('a rename with a decomposed target stores NFC in the sidecar, the markdown and the ledger', async () => {
    seed('meeting_n4', 'Theo M')
    await startServer()
    const res = await post('/api/meeting/meeting_n4/relabel', { from: 'Theo M', to: NFD, confirm: true })
    expect(res.status).toBe(200)
    expect(sidecar().chunks.map(c => c.speaker)).toEqual([NFC, 'MU', NFC])
    expect(sidecar().speakers).toEqual([NFC, 'MU'])
    expect(scribe()).toContain(`- ${NFC}`)
    expect(scribe()).toContain(`[${NFC}]: First point.`)
    expect(hasNfd(readFileSync(join(root, MONTH, `${STEM}.g2-chunks.json`), 'utf-8'))).toBe(false)
    expect(hasNfd(scribe())).toBe(false)
    expect(hasNfd(JSON.stringify(ledger('meeting_n4')))).toBe(false)
  }, T)

  it('a decomposed "from" renames chunks, attendee and turns that hold the composed spelling', async () => {
    seed('meeting_n5', NFC)
    await startServer()
    const res = await post('/api/meeting/meeting_n5/relabel', { from: NFD, to: 'Brigitta Polya Kovacs', confirm: true })
    expect(res.status).toBe(200)
    expect(sidecar().chunks.map(c => c.speaker)).toEqual(['Brigitta Polya Kovacs', 'MU', 'Brigitta Polya Kovacs'])
    expect(scribe()).toContain('[Brigitta Polya Kovacs]: First point.')
  }, T)

  it('a composed "from" renames a sidecar and a transcript that were written decomposed', async () => {
    seed('meeting_n6', NFD)
    await startServer()
    const res = await post('/api/meeting/meeting_n6/relabel', { from: NFC, to: 'Brigitta Polya Kovacs', confirm: true })
    expect(res.status).toBe(200)
    expect(sidecar().chunks.map(c => c.speaker)).toEqual(['Brigitta Polya Kovacs', 'MU', 'Brigitta Polya Kovacs'])
    expect(sidecar().speakers).toEqual(['Brigitta Polya Kovacs', 'MU'])
    expect(scribe()).toContain('- Brigitta Polya Kovacs')
    expect(scribe()).toContain('[Brigitta Polya Kovacs]: Second point.')
    expect(scribe()).not.toContain('Pólya')
  }, T)

  it('renaming a decomposed name into its composed spelling is the same name, not a rename', async () => {
    seed('meeting_n7', NFD)
    await startServer()
    const res = await post('/api/meeting/meeting_n7/relabel', { from: NFD, to: NFC, confirm: true })
    expect(res.status).toBe(400)
    expect(res.json.reason).toBe('noop_relabel')
  }, T)

  it('a different name is still not found', async () => {
    seed('meeting_n8', NFC)
    await startServer()
    const res = await post('/api/meeting/meeting_n8/relabel', { from: 'Brigitta Polya', to: 'Someone Else', confirm: true })
    expect(res.status).toBe(422)
    expect(sidecar().chunks.map(c => c.speaker)).toEqual([NFC, 'MU', NFC])
  }, T)
})

describe('de-attribute', () => {
  it('a decomposed name de-attributes a composed sidecar', async () => {
    seed('meeting_n9', NFC)
    await startServer()
    const res = await post('/api/meeting/meeting_n9/deattribute', { from: NFD, confirm: true, retractTraining: false })
    expect(res.status).toBe(200)
    expect(sidecar().chunks.map(c => c.speaker)).not.toContain(NFC)
    expect(scribe()).not.toContain(NFC)
    expect(res.json.from).toBe(NFC)
  }, T)
})

describe('voice profiles', () => {
  it('delete-person finds a composed profile from a decomposed name, and a different one is not found', async () => {
    writeFileSync(join(dataDir, 'voice-profiles.json'), JSON.stringify({ profiles: [{ name: NFC, embeddings: [Array.from({ length: 192 }, () => 0.1)], sources: ['x'] }] }))
    await startServer()
    const found = await post('/api/voice/delete-person', { name: NFD, dryRun: true })
    expect(found.json.removed.profiles).toBe(1)
    const asked = await post('/api/voice/delete-person', { name: NFD })
    expect(asked.status).toBe(400)
    expect(asked.json.message).toContain(`"${NFC}"`)
    const other = await post('/api/voice/delete-person', { name: 'Brigitta Polya', dryRun: true })
    expect(other.json.removed.profiles).toBe(0)
  }, T)

  it('delete-person finds a profile that was stored decomposed (written before this existed) from the composed name', async () => {
    writeFileSync(join(dataDir, 'voice-profiles.json'), JSON.stringify({ profiles: [{ name: NFD, embeddings: [Array.from({ length: 192 }, () => 0.1)], sources: ['x'] }] }))
    await startServer()
    const found = await post('/api/voice/delete-person', { name: NFC, dryRun: true })
    expect(found.json.removed.profiles).toBe(1)
  }, T)
})

describe('voice profile merge and delete with a name stored decomposed (real writes, not previews)', () => {
  const vec = (k: number) => Array.from({ length: 192 }, (_, i) => (i % 7) + 1 + k * 0.0001)
  const profile = (name: string, n: number, k = 0) => ({ name, embeddings: Array.from({ length: n }, () => vec(k)), sources: Array(n).fill('g2-training') })
  const store = () => (JSON.parse(readFileSync(join(dataDir, 'voice-profiles.json'), 'utf-8')) as { profiles: Array<{ name: string; embeddings: number[][] }> }).profiles
  const seedStore = (profiles: unknown[]) => writeFileSync(join(dataDir, 'voice-profiles.json'), JSON.stringify({ profiles }))
  const SRC_NFD = 'Zolta\u0301n Kovacs', SRC_NFC = 'Zolt\u00e1n Kovacs'

  it('merges a profile stored decomposed when asked for in NFC: the source is gone, the samples are added once, and a retry adds nothing', async () => {
    seedStore([profile('Target Person', 3), profile(SRC_NFD, 2)])
    await startServer()
    const first = await post('/api/voice/merge-profiles', { into: 'Target Person', from: [SRC_NFC], confirm: true })
    expect(first.status).toBe(200)
    expect(first.json.merged).toEqual([SRC_NFD])
    expect(store().map(p => p.name)).toEqual(['Target Person'])
    expect(store()[0]!.embeddings).toHaveLength(5)
    const retry = await post('/api/voice/merge-profiles', { into: 'Target Person', from: [SRC_NFC], confirm: true })
    expect(retry.json.merged ?? []).toEqual([])
    expect(store()[0]!.embeddings).toHaveLength(5)
  }, T)

  it('merges into a target stored decomposed, asked for in NFC', async () => {
    seedStore([profile(SRC_NFD, 3), profile('Other Person', 2)])
    await startServer()
    const res = await post('/api/voice/merge-profiles', { into: SRC_NFC, from: ['Other Person'], confirm: true })
    expect(res.status).toBe(200)
    expect(store().map(p => p.name)).toEqual([SRC_NFD])
    expect(store()[0]!.embeddings).toHaveLength(5)
  }, T)

  it('merges twins, the same name stored composed and decomposed, into one profile', async () => {
    seedStore([profile(SRC_NFC, 3), profile(SRC_NFD, 2)])
    await startServer()
    const res = await post('/api/voice/merge-profiles', { into: SRC_NFC, from: [SRC_NFD], confirm: true })
    expect(res.status).toBe(200)
    expect(store()).toHaveLength(1)
    expect(store()[0]!.name).toBe(SRC_NFC)
    expect(store()[0]!.embeddings).toHaveLength(5)
  }, T)

  // Orthogonal to the target (cosine near 0), against a copy that equals it (cosine 1).
  const far = (n: number, name: string) => ({ name, embeddings: Array.from({ length: n }, () => Array.from({ length: 192 }, (_, i) => (i % 2 ? 1 : -1) * ((i % 7) + 1) * (i % 3 === 0 ? 1 : -1))), sources: Array(n).fill('g2-training') })

  it('refuses a merge when ANY stored copy of the name is below the floor, and previews the lowest score', async () => {
    seedStore([profile('Target Person', 3), profile(SRC_NFC, 2), far(2, SRC_NFD)])
    await startServer()
    const preview = await post('/api/voice/merge-profiles', { into: 'Target Person', from: [SRC_NFC], dryRun: true })
    expect(preview.status).toBe(409)
    expect(preview.json.report.similarity[SRC_NFC]).toBeLessThan(0.55)
    const real = await post('/api/voice/merge-profiles', { into: 'Target Person', from: [SRC_NFC], confirm: true })
    expect(real.status).toBe(409)
    expect(real.json.report.merged).toEqual([])
    expect(real.json.report.refused[0].name).toBe(SRC_NFC)
    expect(store().map(p => p.name).sort()).toEqual(['Target Person', SRC_NFC, SRC_NFD].sort())
  }, T)

  it('merges both copies when both clear the floor', async () => {
    seedStore([profile('Target Person', 3), profile(SRC_NFC, 2), profile(SRC_NFD, 2)])
    await startServer()
    const real = await post('/api/voice/merge-profiles', { into: 'Target Person', from: [SRC_NFC], confirm: true })
    expect(real.status).toBe(200)
    expect(store().map(p => p.name)).toEqual(['Target Person'])
    expect(store()[0]!.embeddings).toHaveLength(7)
  }, T)

  it('counts every stored copy in the delete preview, and the delete removes the same number', async () => {
    seedStore([profile(SRC_NFC, 3), profile(SRC_NFD, 2), profile('Keep Person', 2)])
    await startServer()
    const unconfirmed = await post('/api/voice/delete-person', { name: SRC_NFC })
    expect(unconfirmed.status).toBe(400)
    expect(unconfirmed.json.wouldRemove).toMatchObject({ profile: 2, embeddings: 5 })
    const dry = await post('/api/voice/delete-person', { name: SRC_NFC, dryRun: true })
    expect(dry.json.removed).toMatchObject({ profiles: 2, embeddings: 5 })
    expect(store()).toHaveLength(3)
    const real = await post('/api/voice/delete-person', { name: SRC_NFC, confirm: true })
    expect(real.json.removed).toMatchObject({ profiles: 2, embeddings: 5 })
    expect(store().map(p => p.name)).toEqual(['Keep Person'])
  }, T)

  it('still refuses to merge a name into itself when there is only one profile', async () => {
    seedStore([profile(SRC_NFC, 3)])
    await startServer()
    const res = await post('/api/voice/merge-profiles', { into: SRC_NFD, from: [SRC_NFC], confirm: true })
    expect(res.status).toBe(400)
    expect(store()).toHaveLength(1)
  }, T)

  it('deletes a profile stored decomposed, and its decomposed calibration rows, when asked for in NFC', async () => {
    seedStore([profile(SRC_NFD, 3), profile('Keep Person', 2)])
    writeFileSync(join(dataDir, 'speaker-calibration.jsonl'), [JSON.stringify({ speaker: SRC_NFD, similarity: 0.7 }), JSON.stringify({ speaker: 'Keep Person', similarity: 0.7 })].join('\n') + '\n')
    await startServer()
    const res = await post('/api/voice/delete-person', { name: SRC_NFC, confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.removed).toMatchObject({ profiles: 1, embeddings: 3, calibrationRows: 1 })
    expect(store().map(p => p.name)).toEqual(['Keep Person'])
    expect(readFileSync(join(dataDir, 'speaker-calibration.jsonl'), 'utf-8')).not.toContain('Kovacs')
  }, T)
})

describe('enroll with a repeated name', () => {
  it.each(['?name=a&name=b'])('answers 400 for %s instead of enrolling under the owner label', async (query) => {
    await startServer()
    const res = await fetch(`${baseUrl}/api/voice/enroll${query}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.alloc(64) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/single value/)
    expect(existsSync(join(dataDir, 'voice-profiles.json'))).toBe(false)
  }, T)
})

describe('confirmed by a human, sidecar decomposed and ledger composed', () => {
  it('shows the voice confirmed after the confirm click, and the record id may be asked for in either form', async () => {
    seed('meeting_n10', NFD)
    await startServer()
    const confirmed = await post('/api/meeting/meeting_n10/confirm', { label: NFC })
    expect(confirmed.status).toBe(200)
    const speakers = await new Promise<any>((resolve, reject) => {
      const req = request(`${baseUrl}/api/meeting/meeting_n10/speakers`, res => { const c: Buffer[] = []; res.on('data', d => c.push(Buffer.from(d))); res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString()))) })
      req.on('error', reject); req.end()
    })
    const voice = speakers.voices.find((v: { label: string }) => v.label.normalize('NFC') === NFC)
    expect(voice.confirmedByHuman).toBe(true)
    const recordId = `standalone:meeting_n10`
    expect((await post('/api/meeting/meeting_n10/confirm', { label: NFC, recordId: recordId.normalize('NFD') })).status).toBe(200)
  }, T)
})

describe('a record id and an old decomposed ledger', () => {
  it('compares record ids in NFC, and meeting.ts uses that comparison', async () => {
    const { sameRecordId } = await import('../lib/speaker-name-nfc.js')
    expect(sameRecordId(`ops:quilt:2026-08:2026-08-05_Re${'\u0301'}union.md`, 'ops:quilt:2026-08:2026-08-05_R\u00e9union.md')).toBe(true)
    expect(sameRecordId('ops:quilt:2026-08:other.md', 'ops:quilt:2026-08:2026-08-05_R\u00e9union.md')).toBe(false)
    expect(sameRecordId(7, 'x')).toBe(false)
    expect(readFileSync(join(process.cwd(), 'server/routes/meeting.ts'), 'utf-8')).toContain('sameRecordId(requested, expected)')
  })

  it('shows a voice confirmed by a ledger row written decomposed, for a sidecar that is composed', async () => {
    seed('meeting_n11', NFC)
    mkdirSync(join(dataDir, 'meeting-corrections'), { recursive: true })
    writeFileSync(join(dataDir, 'meeting-corrections', 'meeting_n11.jsonl'), JSON.stringify({ id: 'confirm-1', phase: 'confirmed', at: new Date().toISOString(), from: NFD, to: NFD, chunks: [], scope: 'meeting' }) + '\n')
    await startServer()
    const speakers = await new Promise<any>((resolve, reject) => {
      const req = request(`${baseUrl}/api/meeting/meeting_n11/speakers`, res => { const c: Buffer[] = []; res.on('data', d => c.push(Buffer.from(d))); res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString()))) })
      req.on('error', reject); req.end()
    })
    expect(speakers.voices.find((v: { label: string }) => v.label === NFC).confirmedByHuman).toBe(true)
  }, T)
})

describe('the library the routes call, on its own', () => {
  it('relabelSidecarJson and relabelMeetingMarkdown write NFC and match either spelling', async () => {
    const { relabelSidecarJson, relabelMeetingMarkdown } = await import('../lib/meeting-relabel.js')
    const raw = JSON.stringify({ speakers: [NFD, 'MU'], chunks: [{ speaker: NFD }, { speaker: 'MU' }] })
    const out = relabelSidecarJson(raw, NFC, NFD + ' Kovacs', [])
    expect(out.ok).toBe(true)
    if (out.ok) { expect(hasNfd(out.value.json)).toBe(false); expect(out.value.speakers).toEqual([NFC + ' Kovacs', 'MU']) }
    const md = relabelMeetingMarkdown(`## Attendees\n\n- ${NFD}\n\n## Transcript\n\n[${NFD}]: hi\n`, NFC, NFD + ' Kovacs')
    expect(md.ok).toBe(true)
    if (md.ok) { expect(md.value).toMatchObject({ attendees: 1, transcript: 1 }); expect(hasNfd(md.value.markdown)).toBe(false) }
    expect(relabelSidecarJson(raw, NFC, NFD).ok).toBe(false) // the same name, not a rename
    // Merging into a name already listed decomposed adds no second spelling and retires the old entry.
    const merged = relabelSidecarJson(JSON.stringify({ speakers: ['Theo M', NFD], chunks: [{ speaker: 'Theo M' }, { speaker: NFD }] }), 'Theo M', NFC)
    expect(merged.ok && merged.value.speakers).toEqual([NFD])
  })
})
