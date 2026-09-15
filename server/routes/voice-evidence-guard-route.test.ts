// The voice evidence guard, EXECUTED (6.47.0, WS5).
//
// Six routes can write to the voice identity store. An imported meeting has no
// audio, and a derived record's speaker names came from a vendor's diarization
// or a voice-match suggestion, so either one reaching enrolment would fold a
// cloud label back into the local profiles and then present it as local
// evidence. CLAUDE.md states the rule as "cloud speaker names training voice
// profiles (never)".
//
// TWO HALVES, AND THE SECOND IS THE POINT. A guard that refuses too much is not
// a working guard: a G2 session with a merged record derived from it is still a
// real capture with real audio, and relabelling it is exactly how its profile
// gets better. So the same fixture that proves six refusals also proves relabel
// on a merged session returns 200.
//
// Not source matching: every case is an HTTP round trip against a real express
// server, and the refusals are checked by hashing the voice files before and
// after rather than by reading the handler.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MONTH = '2026-08'
const STEM = '2026-08-05_Lead_Ops_Review_abc12345'
const SESSION = 'guard_session_abc'
const FIREFLIES_ID = 'ff-guard-001'
const HTTP_TEST_TIMEOUT = 30_000

let root = ''
let dataDir = ''
let server: Server | null = null
let baseUrl = ''

/** Every path a voice mutation could reach. Hashed whole, before and after. */
const VOICE_EVIDENCE_PATHS = [
  'voice-profiles.json',
  'meeting-corrections',
  'held-voice-embeddings',
  'chunk-embeddings',
  'ext-audio',
  'speaker-calibration.jsonl',
]

function hashTree(base: string, relative: string): string[] {
  const path = join(base, relative)
  if (!existsSync(path)) return [`${relative}:absent`]
  const stat = statSync(path)
  if (stat.isFile()) {
    return [`${relative}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`]
  }
  if (!stat.isDirectory()) return [`${relative}:other`]
  return readdirSync(path).sort().flatMap(name => hashTree(base, join(relative, name)))
}

function voiceFingerprint(): string[] {
  return VOICE_EVIDENCE_PATHS.flatMap(relative => hashTree(dataDir, relative)).sort()
}

function turns(a: string, b: string, count: number, runLen: number): unknown[] {
  const out: unknown[] = []
  let index = 0
  for (let turn = 0; turn < count; turn++) {
    const who = turn % 2 === 0 ? a : b
    for (let run = 0; run < runLen; run++) {
      out.push({
        speaker: who,
        elapsed: index * 7000,
        similarity: 0.82,
        text: `${who} raised the Jewel360 pipeline question in segment ${index} at 36 percent`,
      })
      index++
    }
  }
  return out
}

function seedCapture(): void {
  const dir = join(root, MONTH)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${STEM}.md`), [
    '# Lead Ops Review',
    '',
    '| **Date** | 2026-08-05 |',
    '',
    '## Attendees',
    '- Chris Krubeck',
    '',
    '## Summary',
    'Chris Krubeck owns the follow-up.',
    '',
  ].join('\n'))
  writeFileSync(
    join(dir, `${STEM}.g2-chunks.json`),
    JSON.stringify({ sessionId: SESSION, chunks: turns('MU', 'Chris Krubeck', 8, 30) }),
  )
}

/** A merged record in the imports library that HOLDS the capture above. */
async function seedMergedRecord(): Promise<string> {
  const { ImportedMeetingLibrary, importHash, mergedHash } = await import('../lib/imported-meeting-library.js')
  const library = new ImportedMeetingLibrary({ root: join(dataDir, 'imports') })
  const markdown = [
    '# Lead Ops Review',
    '',
    '| Field | Value |',
    '|-------|-------|',
    '| **Date** | 2026-08-05 10:00 |',
    '| **Duration** | 28 minutes |',
    '| **Source** | G2 Glasses + Fireflies |',
    '| **Domain** | imported |',
    '',
    '## Transcript',
    '',
    '[00:00:05] Chris Krubeck: under plan.',
    '',
  ].join('\n')
  library.writeRecord({
    kind: 'fireflies',
    hash: importHash(FIREFLIES_ID),
    dateMs: new Date(2026, 7, 5, 10, 0).getTime(),
    markdown,
    sidecar: { version: 1, id: FIREFLIES_ID, originDomain: 'personal' },
  })
  const merged = library.writeRecord({
    kind: 'merged',
    hash: mergedHash(FIREFLIES_ID, [SESSION]),
    dateMs: new Date(2026, 7, 5, 10, 0).getTime(),
    markdown,
    sidecar: {
      version: 1,
      actionId: 'a_00112233445566aa',
      kind: 'merge',
      inputs: [
        { kind: 'fireflies', id: FIREFLIES_ID, sha256: null },
        { kind: 'g2', id: SESSION, sha256: null },
      ],
      tier: 'auto',
      pieces: [],
    },
  })
  return merged.recordId
}

/** A second merged record, of a different meeting, holding a different capture. */
async function seedOtherMergedRecord(): Promise<string> {
  const { ImportedMeetingLibrary, mergedHash } = await import('../lib/imported-meeting-library.js')
  const library = new ImportedMeetingLibrary({ root: join(dataDir, 'imports') })
  const written = library.writeRecord({
    kind: 'merged',
    hash: mergedHash('ff-guard-other', ['other_session_xyz']),
    dateMs: new Date(2026, 7, 6, 10, 0).getTime(),
    markdown: [
      '# Другое', '', '| Field | Value |', '|-------|-------|',
      '| **Date** | 2026-08-06 10:00 |', '| **Source** | G2 Glasses + Fireflies |',
      '| **Domain** | imported |', '', '## Transcript', '', '[00:00:01] A: b.', '',
    ].join('\n'),
    sidecar: {
      version: 1,
      actionId: 'a_ffeeddccbbaa9988',
      kind: 'merge',
      inputs: [
        { kind: 'fireflies', id: 'ff-guard-other', sha256: null },
        { kind: 'g2', id: 'other_session_xyz', sha256: null },
      ],
      tier: 'auto',
      pieces: [],
    },
  })
  return written.recordId
}

/** A split piece whose sidecar names the SAME capture the merge holds. */
async function seedSplitPiece(): Promise<string> {
  const { ImportedMeetingLibrary, pieceHash } = await import('../lib/imported-meeting-library.js')
  const library = new ImportedMeetingLibrary({ root: join(dataDir, 'imports') })
  const written = library.writeRecord({
    kind: 'piece',
    hash: pieceHash('imported:fireflies:0011223344556677', 0),
    dateMs: new Date(2026, 7, 5, 10, 0).getTime(),
    markdown: [
      '# Part 1 of 2', '', '| Field | Value |', '|-------|-------|',
      '| **Date** | 2026-08-05 10:00 |', '| **Source** | Fireflies (split) |',
      '| **Domain** | imported |', '', '## Transcript', '', '[00:00:01] A: b.', '',
    ].join('\n'),
    sidecar: {
      version: 1,
      actionId: 'a_5566778899aabbcc',
      kind: 'split',
      inputs: [
        { kind: 'fireflies', id: 'ff-guard-long', sha256: null },
        { kind: 'g2', id: SESSION, sha256: null },
      ],
      tier: 'auto',
      pieces: [{ index: 0, startS: 0, endS: 1800, kind: 'matched', sessionIds: [SESSION] }],
    },
  })
  return written.recordId
}

async function startServer(): Promise<void> {
  vi.resetModules()
  vi.doMock('../lib/profile.js', () => ({
    getOwnerSpeakerLabel: () => 'MU',
    getVocabulary: () => [],
    getOwnerName: () => 'Miles',
    getTranscriptionProfileStatus: () => ({}),
  }))
  const { MeetingStore } = await import('../lib/meeting-store.js')
  const { createMeetingRouter } = await import('./meeting.js')
  const { voiceRouter } = await import('./voice.js')
  const app = express()
  app.use(express.json())
  app.use('/api', createMeetingRouter({ store: new MeetingStore(root) }))
  app.use('/api', voiceRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      if (!address || typeof address === 'string') throw new Error('no address')
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
}

function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = request(`${baseUrl}${path}`, {
      method,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
        : {},
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    req.end(payload ?? undefined)
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-voice-guard-'))
  dataDir = mkdtempSync(join(tmpdir(), 'cos-voice-guard-data-'))
  process.env.COS_DATA_DIR = dataDir
  delete process.env.COS_OPERATIONS_DIR
  delete process.env.COS_MEETINGS_ROOT
  delete process.env.COS_SCRIPTS_DIR
})

afterEach(async () => {
  delete process.env.COS_DATA_DIR
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
  vi.resetModules()
  vi.doUnmock('../lib/profile.js')
  for (const directory of [root, dataDir]) if (directory) rmSync(directory, { recursive: true, force: true })
})

describe('voice evidence guard', () => {
  it('refuses an imported or derived id on all six voice-writing routes, byte for byte', async () => {
    seedCapture()
    await startServer()
    const mergedRecordId = await seedMergedRecord()
    const importedRecordId = `imported:fireflies:${(await import('../lib/imported-meeting-library.js')).importHash(FIREFLIES_ID)}`

    const before = voiceFingerprint()

    // Six routes. Each is reached the way a confused client would reach it: an
    // imported or derived id where a capture's session or record was expected.
    const attempts: Array<{ name: string; result: { status: number; json: any }; reason: string }> = [
      {
        name: 'relabel (derived recordId)',
        reason: 'blended_derived_record',
        result: await call('POST', `/api/meeting/${SESSION}/relabel`, { from: 'Chris Krubeck', to: 'Chris', recordId: mergedRecordId }),
      },
      {
        name: 'confirm (imported recordId)',
        reason: 'imported_read_only',
        result: await call('POST', `/api/meeting/${SESSION}/confirm`, { label: 'Chris Krubeck', recordId: importedRecordId }),
      },
      {
        name: 'deattribute (derived sessionId)',
        reason: 'blended_derived_record',
        result: await call('POST', `/api/meeting/${mergedRecordId}/deattribute`, { from: 'Chris Krubeck' }),
      },
      {
        name: 'backfill-enrolment (imported sessionId)',
        reason: 'imported_read_only',
        result: await call('POST', `/api/meeting/${importedRecordId}/backfill-enrolment`, { speaker: 'Chris Krubeck', confirm: true }),
      },
      {
        name: 'enroll-ext (derived sessionId)',
        reason: 'blended_derived_record',
        result: await call('POST', '/api/voice/enroll-ext', { name: 'Chris Krubeck', sessionId: mergedRecordId }),
      },
      {
        name: 'held-groups enroll (derived member)',
        reason: 'blended_derived_record',
        result: await call('POST', '/api/voice/held-groups/enroll', {
          name: 'Chris Krubeck',
          members: [{ sessionId: mergedRecordId, chunkIndex: 0 }],
          confirm: true,
          previewHash: 'a'.repeat(32),
        }),
      },
    ]

    for (const attempt of attempts) {
      expect(attempt.result.status, attempt.name).toBe(409)
      expect(attempt.result.json.reason, attempt.name).toBe(attempt.reason)
      expect(attempt.result.json.source, attempt.name).toBeTypeOf('string')
    }

    // The refusal that names where to go instead: a derived recordId answers with
    // the capture's own record, which is the one a correction may be applied to.
    const relabelRefusal = attempts[0].result.json
    expect(relabelRefusal.sourceRecordId).toBe(`standalone:${SESSION}`)
    expect(relabelRefusal.mutable).toBe(false)

    expect(voiceFingerprint()).toEqual(before)
  }, HTTP_TEST_TIMEOUT)

  it('still relabels a G2 session that a merged record was derived from', async () => {
    seedCapture()
    await startServer()
    await seedMergedRecord()

    // The merged record exists and holds this session. The capture is untouched
    // by that, so the correction lands.
    const relabel = await call('POST', `/api/meeting/${SESSION}/relabel`, {
      from: 'Chris Krubeck', to: 'Chris Kay', confirm: true,
    })
    expect(relabel.status).toBe(200)
    expect(relabel.json.sessionId).toBe(SESSION)
    expect(relabel.json.surfaces.sidecar).toBeGreaterThan(0)

    // And the read surface says which merged record the caller opened, while
    // still describing the CAPTURE as the mutable thing.
    const { importHash, mergedHash, importRecordId } = await import('../lib/imported-meeting-library.js')
    void importHash
    const mergedRecordId = importRecordId('merged', mergedHash(FIREFLIES_ID, [SESSION]))
    const speakers = await call('GET', `/api/meeting/${SESSION}/speakers?recordId=${encodeURIComponent(mergedRecordId)}`)
    expect(speakers.status).toBe(200)
    expect(speakers.json.blendedRecordId).toBe(mergedRecordId)
    expect(speakers.json.source).toBe('standalone_recordings')
    expect(speakers.json.mutable).toBe(true)

    // A recordId that names a REAL merged record which does not hold this
    // session is ignored rather than trusted. The record has to exist for this to
    // mean anything: an id that resolves to nothing is refused a step earlier, so
    // testing only that case would leave the membership check unexercised.
    const other = await seedOtherMergedRecord()
    const wrong = await call('GET', `/api/meeting/${SESSION}/speakers?recordId=${encodeURIComponent(other)}`)
    expect(wrong.status).toBe(200)
    expect(wrong.json.blendedRecordId).toBeUndefined()

    // And an id that resolves to no record at all.
    const missing = await call('GET', `/api/meeting/${SESSION}/speakers?recordId=blended:${'0'.repeat(16)}`)
    expect(missing.status).toBe(200)
    expect(missing.json.blendedRecordId).toBeUndefined()

    // A SPLIT PIECE is a `blended:` record too, and it does hold this session in
    // its sidecar, but it is a span of a longer recording rather than a merge of
    // this capture. Labelling the panel with it would tell the reader they had
    // opened a merged meeting they never made.
    const piece = await seedSplitPiece()
    const asPiece = await call('GET', `/api/meeting/${SESSION}/speakers?recordId=${encodeURIComponent(piece)}`)
    expect(asPiece.status).toBe(200)
    expect(asPiece.json.blendedRecordId).toBeUndefined()
  }, HTTP_TEST_TIMEOUT)

  it('refuses an imported or derived id in the path before any lookup', async () => {
    seedCapture()
    await startServer()
    const mergedRecordId = await seedMergedRecord()

    // 409, not 404: the record exists and is simply not a capture. The sessionId
    // pattern allows colons, so these ids are shaped like sessions and would
    // otherwise reach a store scan.
    for (const path of [
      `/api/meeting/${mergedRecordId}/speakers`,
      `/api/meeting/${mergedRecordId}/content`,
      `/api/meeting/imported:fireflies:${'a'.repeat(16)}/speakers`,
    ]) {
      const result = await call('GET', path)
      expect(result.status, path).toBe(409)
    }
  }, HTTP_TEST_TIMEOUT)
})
