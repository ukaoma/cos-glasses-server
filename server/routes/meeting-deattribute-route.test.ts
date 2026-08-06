// POST /api/meeting/:sessionId/deattribute — "this voice was NOT that person". Driven over real HTTP against real files, and every assertion about
// what changed is made by READING THE FILES BACK, not by trusting the response.
//
// The properties that carry the weight:
//   * Nothing mutates without an explicit confirm.
//   * The ledger intent lands BEFORE any file is touched, so a crash is visible.
//   * A ledger that cannot be written aborts with the files untouched.
//   * A partial relabel never touches the markdown transcript, because turn
//     indices do not correspond to chunk indices.
//   * A false attribution's TRAINING SAMPLES are retracted, not just its label.
//   * Retraction reports what it could not reach instead of implying a clean sweep.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let root = ''
let dataDir = ''
let server: Server | null = null
let baseUrl = ''

const MONTH = '2026-08'
const STEM = '2026-08-05_Lead_Ops_Review_abc12345'

const SCRIBE = `# Lead Ops Review

| Field | Value |
|-------|-------|
| **Date** | 2026-08-05 |

## Attendees

- Luke H
- MU

## Summary

Luke H walked the pipeline while MU pushed on timing. Luke owns the follow-up.

## Transcript

[Luke H]: The Jewel360 pipeline is at thirty six percent.
[MU]: Let us take that offline, Luke H can own it.
[Luke H]: Agreed on the follow-up.
`

function seed(sessionId: string, labels: string[], opts: { scribe?: string } = {}): void {
  const dir = join(root, MONTH)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${STEM}.md`), opts.scribe ?? SCRIBE)
  writeFileSync(join(dir, `${STEM}.g2-chunks.json`), JSON.stringify({
    schemaVersion: 2,
    sessionId,
    startTime: 1786027607017,
    durationMs: 807222,
    speakers: [...new Set(labels)],
    chunks: labels.map((speaker, i) => ({
      text: `segment ${i} about the Jewel360 pipeline at thirty six percent`,
      speaker, elapsed: i * 7000, similarity: 0.82,
      words: [{ word: ' segment', start: 0, end: 0.4, probability: 0.9 }],
    })),
  }, null, 2))
}

function sidecarNow(): { speakers: string[]; labels: string[]; raw: string } {
  const raw = readFileSync(join(root, MONTH, `${STEM}.g2-chunks.json`), 'utf-8')
  const doc = JSON.parse(raw)
  return { speakers: doc.speakers, labels: doc.chunks.map((c: { speaker: string }) => c.speaker), raw }
}
const scribeNow = (): string => readFileSync(join(root, MONTH, `${STEM}.md`), 'utf-8')
function ledgerNow(sessionId: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(dataDir, 'meeting-corrections', `${sessionId}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch { return [] }
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
  const app = express()
  app.use(express.json())
  app.use('/api', createMeetingRouter({ store: new MeetingStore(root) }))
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const a = server!.address()
      if (!a || typeof a === 'string') throw new Error('no address')
      baseUrl = `http://127.0.0.1:${a.port}`
      resolve()
    })
  })
}

function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(Buffer.from(c)))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-mtg-relabel-'))
  dataDir = mkdtempSync(join(tmpdir(), 'cos-mtg-relabel-data-'))
  process.env.COS_DATA_DIR = dataDir
})
afterEach(async () => {
  await new Promise<void>(r => server ? server.close(() => r()) : r())
  server = null
  vi.resetModules()
  vi.doUnmock('../lib/profile.js')
  delete process.env.COS_DATA_DIR
  for (const d of [root, dataDir]) {
    if (d) { try { chmodSync(join(d, 'meeting-corrections'), 0o700) } catch { /* not present */ } rmSync(d, { recursive: true, force: true }) }
  }
})

/** Seed a voice profile in the isolated data dir so retraction has something to
 *  remove. Shapes match the live store: 192-dim rows with a parallel sources[]. */
function seedProfile(name: string, sources: string[]): void {
  writeFileSync(join(dataDir, 'voice-profiles.json'), JSON.stringify({
    profiles: [{
      name,
      embeddings: sources.map((_, i) => Array.from({ length: 192 }, (_, d) => (d === i ? 1 : 0.01))),
      sources: [...sources],
    }],
  }, null, 2))
}
function profileSources(name: string): string[] {
  const doc = JSON.parse(readFileSync(join(dataDir, 'voice-profiles.json'), 'utf-8'))
  return doc.profiles.find((p: { name: string }) => p.name === name)?.sources ?? []
}

/**
 * Real-server integration tests: each starts an express listener, writes files,
 * and makes an HTTP round trip. Vitest's 5s default is not enough under
 * full-suite CPU contention, and the failures surface as bare STACK_TRACE_ERROR
 * timeouts on a different test each run.
 */
const HTTP_TEST_TIMEOUT = 30_000

describe('de-attribution changes nothing without confirmation', () => {
  it('previews the label change AND the training retraction', async () => {
    seed('meeting_d1', ['Navaz Sharif', 'MU', 'Navaz Sharif'])
    seedProfile('Navaz Sharif', ['manual', 'auto:meeting_d1', 'g2-training:meeting_d1', 'fireflies'])
    await startServer()

    const res = await post('/api/meeting/meeting_d1/deattribute', { from: 'Navaz Sharif' })
    expect(res.status).toBe(400)
    expect(res.json.reason).toBe('confirmation_required')
    expect(res.json.to).toBe('Ext')
    expect(res.json.chunks).toEqual([0, 2])
    // Both session-stamped samples are in scope; manual and bare fireflies are not.
    expect(res.json.training.wouldRetract).toBe(2)
    expect(res.json.training.untraceable).toBe(2)

    expect(sidecarNow().labels).toEqual(['Navaz Sharif', 'MU', 'Navaz Sharif'])
    expect(profileSources('Navaz Sharif')).toHaveLength(4)
    expect(ledgerNow('meeting_d1')).toEqual([])
  })

  it('says plainly what it cannot reach', async () => {
    seed('meeting_d2', ['Navaz Sharif'])
    seedProfile('Navaz Sharif', ['g2-training', 'g2-training', 'fireflies'])
    await startServer()

    const res = await post('/api/meeting/meeting_d2/deattribute', { from: 'Navaz Sharif' })
    // Every sample predates session stamping, so the profile cannot be cleaned.
    // Silence here would imply it had been.
    expect(res.json.training.wouldRetract).toBe(0)
    expect(res.json.training.untraceable).toBe(3)
    expect(res.json.message).toContain('cannot be retracted')
    // Says the profile is UNCHANGED, so the reviewer knows the de-attribution
    // fixed the transcript only.
    expect(res.json.message).toContain('is traceable')
    expect(res.json.message).toContain('profile is unchanged')
  })
}, HTTP_TEST_TIMEOUT)

describe('applying a de-attribution', () => {
  it('turns the voice into Ext across the sidecar and the markdown', async () => {
    seed('meeting_d3', ['Luke H', 'MU', 'Luke H'])
    await startServer()

    const res = await post('/api/meeting/meeting_d3/deattribute', { from: 'Luke H', confirm: true })
    expect(res.status).toBe(200)
    expect(sidecarNow().labels).toEqual(['Ext', 'MU', 'Ext'])
    const md = scribeNow()
    expect(md).toContain('[Ext]: The Jewel360 pipeline')
    expect(md).not.toContain('[Luke H]:')
  })

  it('RETRACTS the training samples that meeting contributed', async () => {
    // The point of the whole feature: a false attribution that auto-enrolled has
    // poisoned the profile, and removing only the label leaves it poisoned.
    seed('meeting_d4', ['Navaz Sharif', 'MU'])
    seedProfile('Navaz Sharif', ['manual', 'auto:meeting_d4', 'g2-training:meeting_d4', 'auto:meeting_other'])
    await startServer()

    const res = await post('/api/meeting/meeting_d4/deattribute', { from: 'Navaz Sharif', confirm: true })
    expect(res.status).toBe(200)
    expect(res.json.training.retracted).toBe(2)

    const after = profileSources('Navaz Sharif')
    expect(after).toEqual(['manual', 'auto:meeting_other'])
    // Another meeting's evidence is untouched — de-attribution is per-meeting.
    expect(after).toContain('auto:meeting_other')
  })

  it('leaves the profile alone when retractTraining is false', async () => {
    seed('meeting_d5', ['Navaz Sharif'])
    seedProfile('Navaz Sharif', ['auto:meeting_d5', 'manual'])
    await startServer()

    const res = await post('/api/meeting/meeting_d5/deattribute', {
      from: 'Navaz Sharif', retractTraining: false, confirm: true,
    })
    expect(res.status).toBe(200)
    expect(res.json.training.retracted).toBe(0)
    expect(profileSources('Navaz Sharif')).toEqual(['auto:meeting_d5', 'manual'])
    expect(sidecarNow().labels).toEqual(['Ext'])   // transcript still corrected
  })

  it('de-attributes only the named chunks on a partial call', async () => {
    seed('meeting_d6', ['Navaz Sharif', 'MU', 'Navaz Sharif'])
    await startServer()

    const res = await post('/api/meeting/meeting_d6/deattribute', {
      from: 'Navaz Sharif', chunks: [0], confirm: true,
    })
    expect(res.status).toBe(200)
    expect(sidecarNow().labels).toEqual(['Ext', 'MU', 'Navaz Sharif'])
    expect(res.json.partial).toBe(true)
  })

  it('records the de-attribution in the ledger, intent first', async () => {
    seed('meeting_d7', ['Navaz Sharif'])
    await startServer()
    await post('/api/meeting/meeting_d7/deattribute', { from: 'Navaz Sharif', confirm: true })

    const rows = ledgerNow('meeting_d7')
    expect(rows.map(r => r.phase)).toEqual(['intent', 'applied'])
    expect(rows[1]).toMatchObject({ from: 'Navaz Sharif', to: 'Ext', scope: 'meeting' })
  })

  it('aborts with the files AND the profile untouched when the ledger fails', async () => {
    seed('meeting_d8', ['Navaz Sharif'])
    seedProfile('Navaz Sharif', ['auto:meeting_d8'])
    await startServer()
    writeFileSync(join(dataDir, 'meeting-corrections'), 'a file where the directory goes')

    const res = await post('/api/meeting/meeting_d8/deattribute', { from: 'Navaz Sharif', confirm: true })
    expect(res.status).toBe(500)
    expect(res.json.reason).toBe('ledger_unwritable')
    expect(sidecarNow().labels).toEqual(['Navaz Sharif'])
    expect(profileSources('Navaz Sharif')).toEqual(['auto:meeting_d8'])
  })
}, HTTP_TEST_TIMEOUT)

describe('de-attribution rejects nonsense', () => {
  it('refuses to de-attribute something already unattributed', async () => {
    seed('meeting_r1', ['Ext', 'MU'])
    await startServer()
    const res = await post('/api/meeting/meeting_r1/deattribute', { from: 'Ext', confirm: true })
    expect(res.status).toBe(400)
    expect(res.json.reason).toBe('already_unattributed')
  })

  it('422s a label absent from the meeting', async () => {
    seed('meeting_r2', ['MU'])
    await startServer()
    const res = await post('/api/meeting/meeting_r2/deattribute', { from: 'Navaz Sharif', confirm: true })
    expect(res.status).toBe(422)
    expect(res.json.error).toContain('no chunk carries')
  })

  it('400s an invalid session id', async () => {
    seed('meeting_r3', ['MU'])
    await startServer()
    const res = await post('/api/meeting/..%2F..%2Fetc/deattribute', { from: 'MU', confirm: true })
    expect(res.status).toBe(400)
    expect(res.json.reason).toBe('invalid_session_id')
  })
}, HTTP_TEST_TIMEOUT)
