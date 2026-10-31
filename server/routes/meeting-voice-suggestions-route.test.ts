// GET /meeting/:sessionId/speakers `voiceDisplay` and /meeting/:sessionId/voice-suggestions (6.96.3), executed
// against a real express server, a real store, a real shadow file and a real profile store on disk under the
// test's own data home. Only the extractor is fake. Every name, label and word is invented.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

const SESSION = 'mac_1b2c3d4e-0000-4000-8000-00000000abcd'
const G2_SESSION = 'meeting_1786628481833_eagkaz'
const TOKEN = 'test-token-not-a-secret'
const MONTH = '2026-10'
const STEM = '2026-10-28_Invented_Review_abc12345'
const DIM = 192
const CODE: Record<string, number> = { 'Voice 1': 0, 'Voice 2': 0, 'Voice 3': 1, 'Voice 4': 20 }

let root = ''
let server: Server | null = null
let baseUrl = ''
let extracts = 0
let live = false
let effectiveView = false
let finalizing = false
const dataHome = () => process.env.COS_DATA_DIR as string

const axis = (i: number): number[] => { const v = new Array<number>(DIM).fill(0); v[i] = 1; return v }

function wav(seconds: number, code: number): Buffer {
  const samples = Math.round(seconds * 16_000)
  const b = Buffer.alloc(44 + samples * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16_000, 24); b.writeUInt32LE(32_000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40)
  for (let at = 44; at < b.length; at += 2) b.writeInt16LE(code, at)
  return b
}

const LABELS = ['Voice 1', 'Voice 2', 'Voice 3', 'Voice 4']

/** Four anonymous voices, Ext and a person, three whole chunks each, audio retained under the session id. */
function seedMacMeeting(options: { audio?: boolean; sessionId?: string; sidecar?: (doc: Record<string, unknown>) => void } = {}): void {
  const sessionId = options.sessionId ?? SESSION
  const chunks: unknown[] = []
  const chunkEntries: unknown[] = []
  let raw = 0
  for (const speaker of [...LABELS, 'Ext', 'Neva Sharpe']) {
    for (let i = 0; i < 3; i++) {
      const chunk = { speaker, elapsed: raw * 6000, similarity: 0.5, text: `Invented words number ${raw} from the planning review about shelf labels` }
      chunks.push(chunk)
      chunkEntries.push({ chunkIndex: raw, chunk })
      if (options.audio !== false) {
        const dir = join(dataHome(), 'meeting-audio', sessionId.replace(/:/g, '_'))
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `chunk_${String(raw).padStart(4, '0')}.wav`), wav(6, CODE[speaker] ?? 30))
      }
      raw++
    }
  }
  const dir = join(root, MONTH)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${STEM}.md`), '# Invented Review\n\n| **Date** | 2026-10-28 |\n\n## Summary\nInvented.\n')
  const doc: Record<string, unknown> = { sessionId, sourceType: 'mac_system_audio', durationMs: raw * 6000, chunks, chunkEntries }
  options.sidecar?.(doc)
  writeFileSync(join(dir, `${STEM}.g2-chunks.json`), JSON.stringify(doc))
}

function seedShadow(records: unknown[]): void {
  const dir = join(dataHome(), 'speaker-shadow')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'proposals.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n')
}

const SHADOW_RECORD = {
  schema: 1, kind: 'speaker_shadow', logOnly: true, recordedAt: '2026-10-28T18:00:00.000Z', serverVersion: '6.96.0', sessionId: SESSION, enqueuedAt: '2026-10-28T17:59:00.000Z', status: 'proposed', reason: null, detail: null,
  gates: { majority: 0.8, minCoveredFraction: 0.5, floorSeconds: 15, outlier: 'p95', anchorRatioMax: 1.5 },
  proposals: {
    productionVoices: 3, voicesAfter: 2, frozenOtherLabels: ['Ext', 'Neva Sharpe'], fluidAudioClusters: 2, proposedMerges: 1, acceptedMerges: 1, rejectedMerges: 0, embeddingClusterAgreement: [1, 1, 1],
    accepted: [{ cluster: 'S1', keepLabel: 'Voice 1', merge: ['Voice 2'], voices: [{ voice: 'Voice 1', seconds: 18 }, { voice: 'Voice 2', seconds: 18 }], otherLabelsInCluster: [] }],
    rejected: [{ cluster: 'S2', wouldJoin: 'Voice 1', voice: 'Voice 3', seconds: 18, reasons: [] }],
    untouched: [],
  },
}

function seedProfiles(extra: Array<{ name: string; embeddings: number[][]; sources: string[] }> = []): void {
  writeFileSync(join(dataHome(), 'voice-profiles.json'), JSON.stringify({ profiles: [
    { name: 'Dana Reyes', embeddings: [axis(0), axis(0)], sources: ['fireflies', 'g2-training'] },
    { name: 'Theo Marsh', embeddings: [axis(1)], sources: ['fireflies'] },
    { name: 'MU', embeddings: [axis(2)], sources: ['g2-training'] },
    ...extra,
  ] }))
}

async function startServer(options: { token?: boolean } = {}): Promise<void> {
  vi.resetModules()
  vi.doMock('../lib/profile.js', () => ({
    getOwnerSpeakerLabel: () => 'MU',
    getVocabulary: () => [],
    getOwnerName: () => 'Miles',
    getTranscriptionProfileStatus: () => ({}),
  }))
  // Building a real qualified packet is what the call-view suites do; here only the branch on it matters.
  vi.doMock('../lib/mac-speaker-call-view.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../lib/mac-speaker-call-view.js')
    return { ...actual, isEffectiveMacSpeakerCallView: (view: unknown) => effectiveView || (actual.isEffectiveMacSpeakerCallView as (v: unknown) => boolean)(view) }
  })
  const { MeetingStore } = await import('../lib/meeting-store.js')
  const { createMeetingRouter } = await import('./meeting.js')
  const { VoiceSuggestionRunner } = await import('../lib/mac-voice-suggestions.js')
  const { MeetingFinalizationJobStore } = await import('../lib/meeting-finalization-jobs.js')
  const { readPcm16Mono } = await import('../lib/nemotron-segments.js')
  const { requireApiToken } = await import('../lib/api-auth.js')
  const voiceSuggestions = new VoiceSuggestionRunner({
    available: () => true,
    // The real profile store, audio archive and clock. Only the 26 MB model is replaced.
    extract: audio => {
      extracts += 1
      const code = readPcm16Mono(audio)!.pcm.readInt16LE(0)
      const v = new Float32Array(DIM)
      v[code] = 1
      return v
    },
    log: () => {},
  })
  const app = express()
  app.use(express.json())
  if (options.token) app.use('/api', requireApiToken(TOKEN))
  const finalizationJobs = new MeetingFinalizationJobStore()
  const realGet = finalizationJobs.get.bind(finalizationJobs)
  finalizationJobs.get = ((id: string) => finalizing ? ({ sessionId: id } as never) : realGet(id)) as typeof finalizationJobs.get
  app.use('/api', createMeetingRouter({ store: new MeetingStore(root), captureActive: () => live, voiceSuggestions, finalizationJobs }))
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const a = server!.address()
      if (!a || typeof a === 'string') throw new Error('no address')
      baseUrl = `http://127.0.0.1:${a.port}`
      resolve()
    })
  })
}

function call(method: 'GET' | 'POST', path: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { method, headers }, res => {
      let body = ''
      res.on('data', d => { body += d })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

const speakers = (session = SESSION) => call('GET', `/api/meeting/${session}/speakers`)
const readState = (session = SESSION) => call('GET', `/api/meeting/${session}/voice-suggestions`)
const click = (session = SESSION) => call('POST', `/api/meeting/${session}/voice-suggestions`)

async function untilSettled(session = SESSION): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const { json } = await readState(session)
    if (json.state !== 'running') return json
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('job never settled')
}

function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out[relative(dir, p)] = `${statSync(p).mtimeMs}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'voice-suggest-route-'))
  extracts = 0
  live = false
  effectiveView = false
  finalizing = false
  for (const stale of ['meeting-audio', 'speaker-shadow', 'voice-profiles.json']) rmSync(join(dataHome(), stale), { recursive: true, force: true })
  seedProfiles()
})

afterEach(async () => {
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()))
  server = null
  rmSync(root, { recursive: true, force: true })
  vi.doUnmock('../lib/profile.js')
  vi.doUnmock('../lib/mac-speaker-call-view.js')
})

describe('GET /speakers voiceDisplay', () => {
  it('no shadow record, no field, and everything else as before', async () => {
    seedMacMeeting()
    await startServer()
    const res = await speakers()
    expect(res.status).toBe(200)
    expect(res.json.voices.map((v: any) => v.label).sort()).toEqual([...LABELS, 'Ext', 'Neva Sharpe'].sort())
    expect('voiceDisplay' in res.json).toBe(false)
  })

  it('a record for another session changes nothing', async () => {
    seedMacMeeting()
    seedShadow([{ ...SHADOW_RECORD, sessionId: 'mac_1b2c3d4e-0000-4000-8000-00000000ffff' }])
    await startServer()
    expect('voiceDisplay' in (await speakers()).json).toBe(false)
  })

  it('groups the merged voices, with a current voice the record missed as a single and Ext and names left out', async () => {
    seedMacMeeting()
    seedShadow([SHADOW_RECORD])
    await startServer()
    const { json } = await speakers()
    expect(json.voiceDisplay).toEqual({
      source: 'speaker-shadow',
      recordedAt: '2026-10-28T18:00:00.000Z',
      foldUnderSeconds: 15,
      groups: [{ id: 'shadow-S1', labels: ['Voice 1', 'Voice 2'], seconds: 36 }],
      singles: [{ label: 'Voice 3', seconds: 18 }, { label: 'Voice 4', seconds: null }],
      short: [],
    })
    // Display only: every row is still there for its words.
    expect(json.voices.map((v: any) => v.label)).toContain('Voice 2')
    expect(json.voices.map((v: any) => v.label)).toContain('Ext')
    expect(json.voices.find((v: any) => v.label === 'Voice 1').phrases.length).toBeGreaterThan(0)
  })

  it('a voice named since the record leaves its group, on the next read', async () => {
    seedMacMeeting({ sidecar: doc => {
      for (const c of doc.chunks as any[]) if (c.speaker === 'Voice 2') c.speaker = 'Dana Reyes'
    } })
    seedShadow([SHADOW_RECORD])
    await startServer()
    const { json } = await speakers()
    expect(json.voiceDisplay.groups).toEqual([])
    expect(json.voiceDisplay.singles.map((s: any) => s.label).sort()).toEqual(['Voice 1', 'Voice 3', 'Voice 4'])
    expect(JSON.stringify(json.voiceDisplay)).not.toContain('Dana Reyes')
  })

  it('a malformed record omits the field and the read still answers', async () => {
    seedMacMeeting()
    seedShadow([{ ...SHADOW_RECORD, proposals: { accepted: 'nope' } }])
    await startServer()
    const res = await speakers()
    expect(res.status).toBe(200)
    expect('voiceDisplay' in res.json).toBe(false)
  })

  it('a view that already groups the words stands on its own: no field on top of it', async () => {
    seedMacMeeting()
    seedShadow([SHADOW_RECORD])
    await startServer()
    expect('voiceDisplay' in (await speakers()).json).toBe(true)
    effectiveView = true
    expect('voiceDisplay' in (await speakers()).json).toBe(false)
  })

  it('reading it starts no voice job and writes nothing', async () => {
    seedMacMeeting()
    seedShadow([SHADOW_RECORD])
    await startServer()
    const before = fingerprint(dataHome())
    await speakers()
    await speakers()
    expect(extracts).toBe(0)
    expect((await readState()).json.state).toBe('idle')
    expect(fingerprint(dataHome())).toEqual(before)
  })
})

describe('/voice-suggestions', () => {
  it('needs the API token on both methods', async () => {
    seedMacMeeting()
    await startServer({ token: true })
    expect((await readState()).status).toBe(401)
    expect((await click()).status).toBe(401)
    expect(extracts).toBe(0)
    const ok = await call('GET', `/api/meeting/${SESSION}/voice-suggestions`, { 'X-Cos-Token': TOKEN })
    expect(ok.status).toBe(200)
    expect(ok.json.state).toBe('idle')
    const { isPublicApiRequest } = await import('../lib/api-auth.js')
    for (const method of ['GET', 'POST']) expect(isPublicApiRequest(method, `/meeting/${SESSION}/voice-suggestions`)).toBe(false)
  })

  it('only POST starts anything: GET answers idle, with the review\'s own revision and no extraction', async () => {
    seedMacMeeting()
    seedShadow([SHADOW_RECORD])
    await startServer()
    const first = await readState()
    expect(first.status).toBe(200)
    expect(first.json).toEqual({ state: 'idle', rule: { floor: 0.7, margin: 0.05 }, modelSpace: '192d', sourceRevision: (await speakers()).json.sourceRevision })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(extracts).toBe(0)
    expect((await click()).json.state).toBe('running')
    await untilSettled()
    expect(extracts).toBeGreaterThan(0)
  })

  it('one click: one result per group and single, the real profile store, MU never named', async () => {
    seedMacMeeting()
    seedShadow([SHADOW_RECORD])
    await startServer()
    await click()
    const done = await untilSettled()
    expect(done).toEqual({
      state: 'done',
      progress: { done: 12, total: 12 },
      rule: { floor: 0.7, margin: 0.05 },
      modelSpace: '192d',
      sourceRevision: (await speakers()).json.sourceRevision,
      suggestions: [
        { labels: ['Voice 1', 'Voice 2'], name: 'Dana Reyes', score: 1, margin: 1, units: 6, kept: 6, requiresConfirmation: true, highConfidence: true },
        { labels: ['Voice 3'], name: 'Theo Marsh', score: 1, margin: 1, units: 3, kept: 3, requiresConfirmation: true, highConfidence: true },
      ],
      unmatched: [{ labels: ['Voice 4'], gate: 'below_rule' }],
    })
  })

  it('with no shadow record, one result per anonymous label, and never Ext or a name', async () => {
    seedMacMeeting()
    await startServer()
    await click()
    const done = await untilSettled()
    const scoped = [...done.suggestions, ...done.unmatched].map((r: any) => r.labels)
    expect(scoped.sort()).toEqual([['Voice 1'], ['Voice 2'], ['Voice 3'], ['Voice 4']])
    expect(extracts).toBe(12)
  })

  it('a voice closest to MU stays unmatched, and same-capture samples cannot echo', async () => {
    CODE['Voice 4'] = 2 // sounds like MU
    try {
      seedProfiles([{ name: 'Echo Person', embeddings: [axis(7)], sources: [`mac-assign:${SESSION}`] }])
      seedMacMeeting()
      await startServer()
      await click()
      const done = await untilSettled()
      expect(done.suggestions.map((s: any) => s.name)).not.toContain('MU')
      expect(done.suggestions.map((s: any) => s.name)).not.toContain('Echo Person')
      expect(done.unmatched).toEqual([{ labels: ['Voice 4'], gate: 'below_rule' }])
    } finally {
      CODE['Voice 4'] = 20
    }
  })

  it('writes nothing anywhere: every file under the data home and the meeting store is byte-identical', async () => {
    seedMacMeeting()
    seedShadow([SHADOW_RECORD])
    await startServer()
    const before = { data: fingerprint(dataHome()), meetings: fingerprint(root) }
    await click()
    const done = await untilSettled()
    expect(done.state).toBe('done')
    expect({ data: fingerprint(dataHome()), meetings: fingerprint(root) }).toEqual(before)
  })

  it('refuses while a recording is live, and runs once it ends', async () => {
    seedMacMeeting()
    live = true
    await startServer()
    const refused = await click()
    expect(refused.status).toBe(200)
    expect(refused.json).toMatchObject({ state: 'refused', reason: 'recording_active', rule: { floor: 0.7, margin: 0.05 }, modelSpace: '192d' })
    expect(typeof refused.json.sourceRevision).toBe('string')
    expect(refused.json.sourceRevision.length).toBe(64)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(extracts).toBe(0)
    live = false
    expect((await click()).json.state).toBe('running')
    expect((await untilSettled()).state).toBe('done')
  })

  it('refuses while any recording wrap-up lease is held, whatever the session liveness says', async () => {
    seedMacMeeting()
    await startServer()
    const { acquireMaintenanceWork } = await import('../lib/maintenance-lifecycle.js')
    for (const kind of ['recording_chunk', 'meeting_save', 'meeting_batch_finalization', 'orphan_recovery'] as const) {
      const lease = acquireMaintenanceWork(kind)
      try { expect((await click()).json).toMatchObject({ state: 'refused', reason: 'recording_active' }) } finally { lease.release() }
    }
    expect(extracts).toBe(0)
  })

  it('a recording that starts mid-job ends it as refused, on GET', async () => {
    seedMacMeeting()
    await startServer()
    const started = extracts
    expect((await click()).json.state).toBe('running')
    live = true
    const out = await untilSettled()
    expect(out).toMatchObject({ state: 'refused', reason: 'recording_active' })
    expect(out.suggestions).toBeUndefined()
    expect(extracts - started).toBeLessThan(12)
  })

  it('dictation pauses the job and it finishes afterwards', async () => {
    seedMacMeeting()
    await startServer()
    const { acquireMaintenanceWork } = await import('../lib/maintenance-lifecycle.js')
    const lease = acquireMaintenanceWork('prompt_draft_write')
    expect((await click()).json.state).toBe('running')
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(extracts).toBe(0)
    expect((await readState()).json.state).toBe('running')
    lease.release()
    expect((await untilSettled()).state).toBe('done')
    expect(extracts).toBe(12)
  })

  it('refuses while this meeting is finalizing', async () => {
    seedMacMeeting()
    finalizing = true
    await startServer()
    expect((await click()).json).toMatchObject({ state: 'refused', reason: 'meeting_finalizing' })
  })

  it('refuses a derived view: its labels are not the labels on the audio', async () => {
    seedMacMeeting()
    effectiveView = true
    await startServer()
    expect((await click()).json.state).toBe('running')
    expect(await untilSettled()).toMatchObject({ state: 'refused', reason: 'derived_call_view' })
    expect(extracts).toBe(0)
  })

  it('refuses an unreadable sidecar on POST', async () => {
    seedMacMeeting({ sidecar: doc => { doc.chunks = 'nope' } })
    await startServer()
    expect((await click()).json).toMatchObject({ state: 'refused', reason: 'sidecar_unreadable', sourceRevision: '' })
  })

  it('refuses a session that is not a saved Mac capture', async () => {
    seedMacMeeting()
    await startServer()
    for (const session of ['mac_1b2c3d4e-0000-4000-8000-00000000ffff', G2_SESSION, 'phone_abc123', 'imported:fireflies:abc']) {
      const posted = await click(session)
      expect(posted.status).toBe(200)
      expect(posted.json).toMatchObject({ state: 'refused', reason: 'not_saved_mac_capture', sourceRevision: '' })
      expect((await readState(session)).json).toMatchObject({ state: 'refused', reason: 'not_saved_mac_capture' })
    }
    expect(extracts).toBe(0)
  })

  it('refuses a saved G2 meeting even when it is on disk', async () => {
    seedMacMeeting({ sessionId: G2_SESSION })
    await startServer()
    expect((await click(G2_SESSION)).json).toMatchObject({ state: 'refused', reason: 'not_saved_mac_capture' })
  })

  it('refuses when the audio is gone', async () => {
    seedMacMeeting({ audio: false })
    await startServer()
    expect((await click()).json).toMatchObject({ state: 'refused', reason: 'audio_not_retained' })
  })

  it('refuses a malformed session id as a plain 400', async () => {
    await startServer()
    expect((await call('GET', '/api/meeting/a!/voice-suggestions')).status).toBe(400)
    expect((await call('POST', '/api/meeting/a!/voice-suggestions')).status).toBe(400)
  })

  it('a changed meeting drops the old result', async () => {
    seedMacMeeting()
    await startServer()
    await click()
    const done = await untilSettled()
    expect(done.state).toBe('done')
    const md = join(root, MONTH, `${STEM}.md`)
    writeFileSync(md, `${readFileSync(md, 'utf8')}\nEdited.\n`)
    const after = await readState()
    expect(after.json.state).toBe('idle')
    expect(after.json.sourceRevision).not.toBe(done.sourceRevision)
    expect(after.json.suggestions).toBeUndefined()
  })

  it('answers a refusal during a drain from the route, not the global mutation lease', async () => {
    const { isReadOnlyApiPost } = await import('../lib/work-search.js')
    expect(isReadOnlyApiPost('POST', `/meeting/${SESSION}/voice-suggestions`)).toBe(true)
    expect(isReadOnlyApiPost('GET', `/meeting/${SESSION}/voice-suggestions`)).toBe(false)
    expect(isReadOnlyApiPost('POST', `/meeting/${SESSION}/voice-suggestions/x`)).toBe(false)
    expect(isReadOnlyApiPost('POST', `/meeting/${SESSION}/relabel`)).toBe(false)
    expect(isReadOnlyApiPost('POST', '/meeting/voice-suggestions')).toBe(false)

    seedMacMeeting()
    await startServer()
    const { maintenanceLifecycle } = await import('../lib/maintenance-lifecycle.js')
    const spy = vi.spyOn(maintenanceLifecycle, 'snapshot').mockReturnValue({ ...maintenanceLifecycle.snapshot(), admissionsOpen: false })
    try {
      expect((await click()).json).toMatchObject({ state: 'refused', reason: 'maintenance' })
    } finally { spy.mockRestore() }
    expect(extracts).toBe(0)
  })

  it('a job is started from exactly one place in the server', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => {
      const p = join(d, e.name)
      return e.isDirectory() ? (e.name === '__fixtures__' ? [] : walk(p)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : []
    })
    const serverDir = join(import.meta.dirname, '..')
    const hits = walk(serverDir).filter(p => /voiceSuggestions\.start\(|getVoiceSuggestionRunner\(\)\.start\(/.test(readFileSync(p, 'utf8')))
    expect(hits.map(p => relative(serverDir, p))).toEqual(['routes/meeting.ts'])
    const route = readFileSync(join(import.meta.dirname, 'meeting.ts'), 'utf8')
    expect(route.match(/voiceSuggestions\.start\(/g)).toHaveLength(1)
    expect(route).toContain("router.get('/meeting/:sessionId/voice-suggestions', readVoiceSuggestions)")
    expect(route).toContain("router.post('/meeting/:sessionId/voice-suggestions', startVoiceSuggestions)")
  })
})
