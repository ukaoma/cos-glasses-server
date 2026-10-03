// 6.61.2: a merged G2 meeting whose capture sidecar sits in a DIFFERENT DOMAIN
// FOLDER than the merged scribe.
//
// The COS pipeline splices a G2 capture into the Fireflies scribe and retires the
// capture's own scribe, leaving its `.g2-chunks.json` behind. The meeting is often
// re-filed to another domain on the way (a G2 capture defaults to `personal`, the
// Fireflies call it joined is `sprocket_rocket`), so on 2026-10-02 65 of the 199
// merged scribes on Miles's Mac sat in a different domain folder than their
// sidecar. 6.61.1 looked for the merged scribe only beside the sidecar, so the
// session resolved to the RETIRED filename:
//
//   * the speaker review answered `ops:personal:...:<G2 recording>.md`, a record
//     the meetings list does not show, under the G2 recording's raw filename;
//   * a correction sent with the list row's recordId was refused 409
//     `record_source_mismatch`;
//   * a correction sent with the review's own recordId (what COS Control 0.5.254
//     sends) renamed the voice in the sidecar only, and reported the merged
//     scribe as "meeting markdown unreadable", so the meeting kept the old name.
//
// Every assertion about what changed is made by reading the files back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SESSION = 'meeting_1789047739389_iijsqc'
const MONTH = '2026-09'
const SIDECAR_DOMAIN = 'personal'
const SCRIBE_DOMAIN = 'sprocket_rocket'
const CAPTURE_STEM = '2026-09-10_G2_Recording_2026-09-10_0842_3eaf0686'
const SCRIBE = '2026-09-10_Chris_Miles_Sync.md'
const LIST_RECORD_ID = `ops:${SCRIBE_DOMAIN}:${MONTH}:${SCRIBE}`
const RETIRED_RECORD_ID = `ops:${SIDECAR_DOMAIN}:${MONTH}:${CAPTURE_STEM}.md`
const HTTP_TEST_TIMEOUT = 30_000

let parent = ''
let operations = ''
let server: Server | null = null
let baseUrl = ''
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ['COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_SCRIPTS_DIR', 'COS_DATA_DIR'] as const

function mergedScribe(sessionId = SESSION): string {
  return [
    '# Chris <> Miles Sync',
    '',
    '| Field | Value |',
    '|-------|-------|',
    '| **Date** | 2026-09-10 09:00 |',
    '| **Source** | Fireflies |',
    '| **Sources** | Fireflies + G2 Glasses |',
    '| **Domain** | Sprocket Rocket |',
    '| **Duration** | 29 minutes |',
    '',
    '## Attendees',
    '',
    '- MU',
    '- Speaker 2',
    '- Kyle Payton',
    '',
    '## Summary',
    '',
    'Miles walked Chris through the session pets.',
    '',
    '## Transcript',
    '',
    '[MU]: The pets keep track of every project.',
    '[Speaker 2]: It is becoming its own thing.',
    '[Kyle Payton]: Have a good weekend.',
    '',
    '<!-- g2-transcript-blended -->',
    `<!-- g2-source: ${CAPTURE_STEM}.g2-chunks.json -->`,
    `<!-- g2-session: ${sessionId} -->`,
    '## G2 Speaker-Separated Transcript',
    '',
    '**MU** _[0:06]_: The pets keep track of every project.',
    '**Speaker 2** _[0:12]_: It is becoming its own thing.',
    '',
  ].join('\n')
}

function sidecar(sessionId = SESSION): string {
  const labels = ['MU', 'Speaker 2', 'Kyle Payton', 'Speaker 2']
  return JSON.stringify({
    schemaVersion: 2,
    sessionId,
    startTime: 1789047739389,
    durationMs: 3324942,
    domain: SIDECAR_DOMAIN,
    title: 'G2 Recording 2026-09-10 0842',
    speakers: [...new Set(labels)],
    chunks: labels.map((speaker, i) => ({
      text: `segment ${i} about the session pets`, speaker, elapsed: i * 6000, similarity: 0.8,
    })),
    // Real sidecars carry this pointer and it goes stale when the scribe is
    // re-filed: on Miles's Mac it still names personal/... for this meeting.
    blended_into: [`${SIDECAR_DOMAIN}/meetings/${MONTH}/${SCRIBE}`],
  }, null, 2)
}

function monthDir(domain: string, month = MONTH): string {
  return join(operations, domain, 'meetings', month)
}

/** The capture's sidecar in one domain, its merged scribe in another, no scribe beside the sidecar. */
function seedCrossFolder(): void {
  mkdirSync(monthDir(SIDECAR_DOMAIN), { recursive: true })
  mkdirSync(monthDir(SCRIBE_DOMAIN), { recursive: true })
  writeFileSync(join(monthDir(SIDECAR_DOMAIN), `${CAPTURE_STEM}.g2-chunks.json`), sidecar())
  writeFileSync(join(monthDir(SCRIBE_DOMAIN), SCRIBE), mergedScribe())
  // An unrelated meeting in the sidecar's own folder, so "the month has scribes"
  // is true there too and only the marker can pick the right one.
  writeFileSync(join(monthDir(SIDECAR_DOMAIN), '2026-09-10_Family_Dinner.md'), '# Family dinner\n\n## Transcript\n\n[MU]: Pasta.\n')
}

function scribeNow(): string {
  return readFileSync(join(monthDir(SCRIBE_DOMAIN), SCRIBE), 'utf8')
}

function sidecarNow(): { chunks: Array<{ speaker: string }> } {
  return JSON.parse(readFileSync(join(monthDir(SIDECAR_DOMAIN), `${CAPTURE_STEM}.g2-chunks.json`), 'utf8'))
}

async function startServer(): Promise<void> {
  vi.resetModules()
  vi.doMock('../lib/profile.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../lib/profile.js')
    return {
      ...actual,
      getOwnerSpeakerLabel: () => 'MU',
      getVocabulary: () => [],
      getOwnerName: () => 'Miles',
      getTranscriptionProfileStatus: () => ({}),
    }
  })
  // Enrolment needs the ONNX runtime this suite does not have; the route's
  // file writes are what is under test.
  vi.doMock('../lib/speaker-embeddings.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../lib/speaker-embeddings.js')
    return { ...actual, isEmbeddingAvailable: () => false, enrollEmbedding: () => ({ success: true, dim: 192 }) }
  })
  const { MeetingStore } = await import('../lib/meeting-store.js')
  const { ImportedMeetingLibrary } = await import('../lib/imported-meeting-library.js')
  const { createMeetingRouter } = await import('./meeting.js')
  const { createMeetingsRouter } = await import('./meetings.js')
  const store = new MeetingStore(join(parent, 'data', 'recordings'))
  const library = new ImportedMeetingLibrary({ root: join(parent, 'data', 'imports') })
  const app = express()
  app.use(express.json())
  app.use('/api', createMeetingsRouter(store, library))
  app.use('/api', createMeetingRouter({ store }))
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const a = server!.address()
      if (!a || typeof a === 'string') throw new Error('no address')
      baseUrl = `http://127.0.0.1:${a.port}`
      resolve()
    })
  })
}

function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, {
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {},
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(Buffer.from(c)))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    req.end(payload || undefined)
  })
}

async function listRow(): Promise<any> {
  const listed = await call('GET', `/api/meetings?month=${MONTH}`)
  expect(listed.status).toBe(200)
  return listed.json.meetings.find((row: any) => row.sessionId === SESSION)
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  parent = mkdtempSync(join(tmpdir(), 'cos-cross-folder-'))
  operations = join(parent, 'operations')
  mkdirSync(join(parent, 'data', 'recordings'), { recursive: true })
  mkdirSync(join(parent, 'data', 'imports'), { recursive: true })
  // The pipeline layout, as on Miles's Mac: COS sync files G2 recordings here.
  const scripts = join(parent, 'scripts')
  mkdirSync(join(scripts, 'venv', 'bin'), { recursive: true })
  writeFileSync(join(scripts, 'venv', 'bin', 'python3'), '#!/bin/sh\n')
  writeFileSync(join(scripts, 'sync_meetings.py'), '# stub\n')
  process.env.COS_SCRIPTS_DIR = scripts
  process.env.COS_OPERATIONS_DIR = operations
  process.env.COS_DATA_DIR = join(parent, 'data')
  delete process.env.COS_MEETINGS_ROOT
})

afterEach(async () => {
  await new Promise<void>(r => server ? server.close(() => r()) : r())
  server = null
  vi.resetModules()
  vi.doUnmock('../lib/profile.js')
  vi.doUnmock('../lib/speaker-embeddings.js')
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  rmSync(parent, { recursive: true, force: true })
})

describe('a merged meeting whose capture sits in another domain folder (6.61.2)', () => {
  it('cross-folder: the list row is the merged scribe and carries the session', async () => {
    seedCrossFolder()
    await startServer()
    const row = await listRow()
    expect(row).toBeTruthy()
    expect(row.recordId).toBe(LIST_RECORD_ID)
    expect(row.derivedKind).toBe('merge')
  }, HTTP_TEST_TIMEOUT)

  it('cross-folder: the speaker review returns the recordId, title and domain the list row carries', async () => {
    seedCrossFolder()
    await startServer()
    const row = await listRow()
    const review = await call('GET', `/api/meeting/${SESSION}/speakers`)
    expect(review.status).toBe(200)
    expect(review.json.recordId).toBe(row.recordId)
    expect(review.json.recordId).not.toBe(RETIRED_RECORD_ID)
    expect(review.json.title).toBe('Chris <> Miles Sync')
    expect(review.json.filename).toBe(SCRIBE)
    expect(review.json.domain).toBe(SCRIBE_DOMAIN)
    // Field set unchanged for older clients: the capture still describes the source.
    expect(review.json.source).toBe('cos_operations')
    expect(review.json.mutable).toBe(true)
  }, HTTP_TEST_TIMEOUT)

  it('cross-folder: a relabel sent with the list row recordId is applied to the merged scribe, not refused 409', async () => {
    seedCrossFolder()
    await startServer()
    const row = await listRow()
    const res = await call('POST', `/api/meeting/${SESSION}/relabel`, {
      from: 'Speaker 2', to: 'Chris Dubois', recordId: row.recordId, confirm: true,
    })
    expect(res.status).toBe(200)
    expect(res.json.markdownSkipped ?? null).toBeNull()
    expect(sidecarNow().chunks.map(c => c.speaker)).toEqual(['MU', 'Chris Dubois', 'Kyle Payton', 'Chris Dubois'])
    const md = scribeNow()
    expect(md).toContain('[Chris Dubois]: It is becoming its own thing.')
    expect(md).toContain('- Chris Dubois')
    expect(md).not.toContain('[Speaker 2]:')
    // The marker that makes this resolution possible survives the rewrite.
    expect(md).toContain(`<!-- g2-session: ${SESSION} -->`)
  }, HTTP_TEST_TIMEOUT)

  it('cross-folder: a relabel sent with the speaker review recordId rewrites the merged scribe (what Control 0.5.254 sends)', async () => {
    seedCrossFolder()
    await startServer()
    const review = await call('GET', `/api/meeting/${SESSION}/speakers`)
    const res = await call('POST', `/api/meeting/${SESSION}/relabel`, {
      from: 'Speaker 2', to: 'Chris Dubois', recordId: review.json.recordId, confirm: true,
    })
    expect(res.status).toBe(200)
    expect(res.json.surfaces).toMatchObject({ sidecar: 2, attendees: 1, transcript: 1 })
    expect(res.json.markdownSkipped ?? null).toBeNull()
    expect(scribeNow()).toContain('[Chris Dubois]: It is becoming its own thing.')
  }, HTTP_TEST_TIMEOUT)

  it('cross-folder: a deattribution sent with the list row recordId is applied to the merged scribe', async () => {
    seedCrossFolder()
    await startServer()
    const row = await listRow()
    const res = await call('POST', `/api/meeting/${SESSION}/deattribute`, {
      from: 'Kyle Payton', recordId: row.recordId, confirm: true, retractTraining: false,
    })
    expect(res.status).toBe(200)
    expect(res.json.markdownSkipped ?? null).toBeNull()
    expect(scribeNow()).not.toContain('[Kyle Payton]:')
    expect(scribeNow()).not.toContain('- Kyle Payton')
    expect(sidecarNow().chunks.map(c => c.speaker)).not.toContain('Kyle Payton')
  }, HTTP_TEST_TIMEOUT)

  it('cross-folder: a confirmation sent with the list row recordId is accepted', async () => {
    seedCrossFolder()
    await startServer()
    const row = await listRow()
    const res = await call('POST', `/api/meeting/${SESSION}/confirm`, { label: 'MU', recordId: row.recordId })
    expect(res.status).toBe(200)
  }, HTTP_TEST_TIMEOUT)

  it('cross-folder: the content route reads the merged scribe and names its domain', async () => {
    seedCrossFolder()
    await startServer()
    const res = await call('GET', `/api/meeting/${SESSION}/content`)
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.json)).toContain('Miles walked Chris through the session pets.')
    expect(JSON.stringify(res.json)).toContain(`"domain":"${SCRIBE_DOMAIN}"`)
  }, HTTP_TEST_TIMEOUT)

  it('same-folder: a merged scribe beside its sidecar still resolves as in 6.61.1', async () => {
    mkdirSync(monthDir(SIDECAR_DOMAIN), { recursive: true })
    writeFileSync(join(monthDir(SIDECAR_DOMAIN), `${CAPTURE_STEM}.g2-chunks.json`), sidecar())
    writeFileSync(join(monthDir(SIDECAR_DOMAIN), SCRIBE), mergedScribe())
    await startServer()
    const row = await listRow()
    expect(row.recordId).toBe(`ops:${SIDECAR_DOMAIN}:${MONTH}:${SCRIBE}`)
    const review = await call('GET', `/api/meeting/${SESSION}/speakers`)
    expect(review.json.recordId).toBe(row.recordId)
    const res = await call('POST', `/api/meeting/${SESSION}/relabel`, {
      from: 'Speaker 2', to: 'Chris Dubois', recordId: row.recordId, confirm: true,
    })
    expect(res.status).toBe(200)
    expect(readFileSync(join(monthDir(SIDECAR_DOMAIN), SCRIBE), 'utf8')).toContain('[Chris Dubois]:')
  }, HTTP_TEST_TIMEOUT)

  it('two scribes claim one session: fails closed, rewrites neither, and says why', async () => {
    seedCrossFolder()
    mkdirSync(monthDir('quilt'), { recursive: true })
    const rival = join(monthDir('quilt'), '2026-09-10_Rival_Claim.md')
    writeFileSync(rival, mergedScribe().replace('# Chris <> Miles Sync', '# Rival claim'))
    const before = { scribe: scribeNow(), rival: readFileSync(rival, 'utf8'), sidecar: sidecarNow() }
    await startServer()
    const review = await call('GET', `/api/meeting/${SESSION}/speakers`)
    expect(review.status).toBe(200)
    // No merge resolution: the review describes the capture itself.
    expect(review.json.recordId).toBe(RETIRED_RECORD_ID)
    const res = await call('POST', `/api/meeting/${SESSION}/relabel`, {
      from: 'Speaker 2', to: 'Chris Dubois', recordId: review.json.recordId, confirm: true,
    })
    expect(review.json.mutable).toBe(false)
    expect(res.status).toBe(409)
    expect(res.json.reason).toBe('record_source_mismatch')
    expect(sidecarNow()).toEqual(before.sidecar)
    expect(scribeNow()).toBe(before.scribe)
    expect(readFileSync(rival, 'utf8')).toBe(before.rival)
    // A client holding either list row's recordId is refused rather than pointed at one of them.
    const refused = await call('POST', `/api/meeting/${SESSION}/relabel`, {
      from: 'Chris Dubois', to: 'Speaker 2', recordId: LIST_RECORD_ID, confirm: true,
    })
    expect(refused.status).toBe(409)
    expect(refused.json.reason).toBe('record_source_mismatch')
  }, HTTP_TEST_TIMEOUT)
  it('surviving raw file cannot displace the marked merged scribe for list, review, content or correction', async () => {
    seedCrossFolder()
    const raw = join(monthDir(SIDECAR_DOMAIN), `${CAPTURE_STEM}.md`)
    writeFileSync(raw, '# Original capture\n\n## Transcript\n[Speaker 2]: old text\n')
    const before = readFileSync(raw, 'utf8')
    await startServer()
    const row = await listRow()
    for (const route of ['speakers', 'content']) {
      const res = await call('GET', `/api/meeting/${SESSION}/${route}?recordId=${encodeURIComponent(row.recordId)}`)
      expect(res.status).toBe(200)
      expect(res.json.recordId).toBe(row.recordId)
      expect(res.json.sourceRevision).toMatch(/^[a-f0-9]{64}$/)
      expect(res.json.reviewIdentityVersion).toBe(1)
    }
    const res = await call('POST', `/api/meeting/${SESSION}/relabel`, { from:'Speaker 2', to:'Chris Dubois', recordId:row.recordId, confirm:true })
    expect(res.status).toBe(200)
    expect(scribeNow()).toContain('[Chris Dubois]:')
    expect(readFileSync(raw, 'utf8')).toBe(before)
  }, HTTP_TEST_TIMEOUT)

  it('explicit wrong selection is refused for both reads', async () => {
    seedCrossFolder(); await startServer()
    for (const route of ['speakers', 'content']) {
      const res = await call('GET', `/api/meeting/${SESSION}/${route}?recordId=${encodeURIComponent('ops:personal:2026-09:wrong.md')}`)
      expect(res.status).toBe(409)
      expect(res.json.reason).toBe('record_source_mismatch')
    }
  }, HTTP_TEST_TIMEOUT)

  it('changed scribe or sidecar refuses the viewed revision without writing any correction', async () => {
    for (const changeSidecar of [false, true]) {
      seedCrossFolder()
      if (!server) await startServer()
      const review = await call('GET', `/api/meeting/${SESSION}/speakers`)
      const path = changeSidecar ? join(monthDir(SIDECAR_DOMAIN), `${CAPTURE_STEM}.g2-chunks.json`) : join(monthDir(SCRIBE_DOMAIN), SCRIBE)
      writeFileSync(path, readFileSync(path, 'utf8') + '\n')
      const before = { scribe:scribeNow(), sidecar:sidecarNow() }
      for (const [route, body] of [['relabel',{from:'Speaker 2',to:'Chris Dubois',confirm:true}],['deattribute',{from:'Speaker 2',confirm:true}],['confirm',{label:'Speaker 2'}]] as const) {
        const res = await call('POST', `/api/meeting/${SESSION}/${route}`, {...body,recordId:review.json.recordId,expectedRevision:review.json.sourceRevision})
        expect(res.status).toBe(409)
        expect(res.json.reason).toBe('record_source_mismatch')
        expect(scribeNow()).toBe(before.scribe)
        expect(sidecarNow()).toEqual(before.sidecar)
      }
    }
  }, HTTP_TEST_TIMEOUT)

})
