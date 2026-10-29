// The shadow runner, end to end through its real child process and a fake fluidaudiocli:
// the switch, the queue, the cap, the breaker, the wall clock, the RSS cap, live work, and
// the no-write guarantee. Importing server modules runs them, so the data dir is scratch.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'

const scratch = mkdtempSync(join(tmpdir(), 'speaker-shadow-runner-'))
process.env.COS_DATA_DIR = join(scratch, 'data')

const shadow = await import('./speaker-shadow.js')
const { syntheticMeeting } = await import('./__fixtures__/speaker-shadow/synthetic-meeting.js')
const { writeFakeCli, writePassthroughSandbox } = await import('./__fixtures__/speaker-shadow/fake-cli.js')
type FakeCliMode = import('./__fixtures__/speaker-shadow/fake-cli.js').FakeCliMode
type SpeakerShadowDeps = import('./speaker-shadow.js').SpeakerShadowDeps

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const TEST_WORKER = fileURLToPath(new URL('./__fixtures__/speaker-shadow/test-worker.ts', import.meta.url))
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const ON = { COS_SPEAKER_SHADOW: '1' }

async function waitFor(predicate: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise(r => setTimeout(r, 25))
  }
}

let caseNo = 0
/** A data home holding one finalized synthetic Mac meeting, plus everything a write path could touch. */
function world(mode: FakeCliMode, overrides: Partial<SpeakerShadowDeps> = {}, meetings = 1) {
  const base = join(scratch, `case-${++caseNo}`)
  const data = join(base, 'data')
  const sessions: Array<{ sessionId: string; sidecarPath: string }> = []
  for (let m = 0; m < meetings; m++) {
    const meeting = syntheticMeeting(`mac_00000000-0000-4000-8000-${String(caseNo * 10 + m).padStart(12, '0')}`)
    const audio = join(data, 'meeting-audio', meeting.sessionId)
    mkdirSync(audio, { recursive: true })
    for (const [i, wav] of meeting.wavs) writeFileSync(join(audio, `chunk_${String(i).padStart(4, '0')}.wav`), wav)
    mkdirSync(join(data, 'recordings', '2026-10'), { recursive: true })
    const sidecarPath = join(data, 'recordings', '2026-10', `2026-10-28_Mac_recording_${m}.g2-chunks.json`)
    writeFileSync(sidecarPath, JSON.stringify(meeting.sidecar, null, 2))
    writeFileSync(sidecarPath.replace(/\.g2-chunks\.json$/, '.md'), '# Mac recording\n\n**Voice 1:** synthetic words\n')
    sessions.push({ sessionId: meeting.sessionId, sidecarPath })
  }
  // Stand-ins for every store the brief says shadow mode must never write.
  writeFileSync(join(data, 'voice-profiles.json'), JSON.stringify({ 'Dana Fictional': { samples: 3 } }))
  mkdirSync(join(data, 'speaker-embeddings'), { recursive: true })
  writeFileSync(join(data, 'speaker-embeddings', 'cache.json'), '{"vectors":[]}')
  writeFileSync(join(data, 'speaker-corrections.jsonl'), '{"phase":"applied"}\n')
  const cli = writeFakeCli(join(base, 'cli'), mode)
  const tmp = join(base, 'tmp')
  mkdirSync(tmp, { recursive: true })
  const spawned: number[] = []
  const timers: Array<() => void> = []
  const logs: string[] = []
  const deps: Partial<SpeakerShadowDeps> = {
    env: () => ON,
    root: () => join(data, 'speaker-shadow'),
    captureActive: () => false,
    admissionsOpen: () => true,
    resolveCli: async () => ({ path: cli.path, sha256: sha(cli.path), trust: 'sha256' }),
    audioDirFor: id => join(data, 'meeting-audio', id),
    modelsDir: () => join(base, 'models', 'speaker-diarization'),
    modelsPresent: () => true,
    homeDir: () => join(data, 'speaker-shadow', 'home'),
    sandboxExec: writePassthroughSandbox(join(base, 'bin')),
    tmpRoot: tmp,
    spawnWorker: () => {
      const child = spawn(process.execPath, ['--import', TSX, TEST_WORKER], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, COS_DATA_DIR: data } })
      if (child.pid) spawned.push(child.pid)
      return child
    },
    limits: () => ({ dailyRuns: 12, timeoutMs: 60_000, rssBytes: 3 * 1024 ** 3 }),
    setTimer: fn => { timers.push(fn); return {} },
    log: line => logs.push(line),
    ...overrides,
  }
  const runner = new shadow.SpeakerShadowRunner(deps)
  const root = join(data, 'speaker-shadow')
  const records = () => existsSync(join(root, 'proposals.jsonl')) ? readFileSync(join(root, 'proposals.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  const state = () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
  const cliRuns = () => existsSync(cli.marker) ? readFileSync(cli.marker, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  const idle = () => !(runner as any).running && !(runner as any).pumping
  return { base, data, root, tmp, sessions, runner, records, state, cliRuns, spawned, timers, logs, idle, session: sessions[0] }
}

/** Every file under dir except speaker-shadow/, with content hash, size and mtime. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name)
      const rel = relative(dir, path)
      if (rel === 'speaker-shadow' || rel.startsWith('speaker-shadow/')) continue
      const st = statSync(path)
      if (st.isDirectory()) { out[`${rel}/`] = `dir ${st.mtimeMs}`; walk(path) }
      else out[rel] = `${sha(path)} ${st.size} ${st.mtimeMs}`
    }
  }
  walk(dir)
  return out
}

describe('speaker shadow runner: off by default', () => {
  it('reads the switch strictly: only 1, true, yes or on', () => {
    expect(shadow.speakerShadowEnabled({})).toBe(false)
    for (const v of ['1', 'true', 'YES', ' on ']) expect(shadow.speakerShadowEnabled({ COS_SPEAKER_SHADOW: v })).toBe(true)
    for (const v of ['0', 'false', '', 'enabled', '2']) expect(shadow.speakerShadowEnabled({ COS_SPEAKER_SHADOW: v })).toBe(false)
  })

  it('with the switch off a finished meeting queues nothing, spawns nothing and creates no file', async () => {
    const w = world('success', { env: () => ({}) })
    const before = snapshot(w.data)
    w.runner.notifyFinalized(w.session)
    await new Promise(r => setTimeout(r, 300))
    expect(existsSync(w.root)).toBe(false)
    expect(w.spawned).toEqual([])
    expect(snapshot(w.data)).toEqual(before)
    expect(w.runner.snapshot().state).toBe('off')
  })

  it('ignores anything that is not a Mac capture', async () => {
    const w = world('success')
    w.runner.notifyFinalized({ sessionId: 'g2_1234', sidecarPath: w.session.sidecarPath })
    await new Promise(r => setTimeout(r, 200))
    expect(existsSync(w.root)).toBe(false)
  })
})

describe('speaker shadow runner: a run', () => {
  it('logs one proposal record per meeting and writes nothing outside speaker-shadow/', async () => {
    const w = world('success')
    const before = snapshot(w.data)
    w.runner.notifyFinalized(w.session)
    await waitFor(() => w.records().length === 1 && w.idle())
    const [record] = w.records()
    expect(record).toMatchObject({ schema: 1, kind: 'speaker_shadow', logOnly: true, sessionId: w.session.sessionId, status: 'proposed', reason: null })
    expect(record.proposals.accepted.map((a: any) => [a.cluster, a.keepLabel, a.merge])).toEqual([
      ['S1', 'Voice 1', ['Voice 2', 'Voice 13']], ['S2', 'Voice 3', ['Voice 10']], ['S4', 'Voice 11', ['Voice 12']],
    ])
    expect(record.gates).toEqual({ majority: 0.8, minCoveredFraction: 0.5, floorSeconds: 15, outlier: 'leave-fragment-out cluster p95', anchorRatioPostHocColumnOnly: 1.5 })
    expect(record.facts.labelsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(record.resources.peakRssBytes === null || record.resources.peakRssBytes > 0).toBe(true)
    // THE GUARANTEE: every meeting file, label, profile, embedding cache and ledger is byte-identical.
    expect(snapshot(w.data)).toEqual(before)
    expect(readdirSync(w.tmp)).toEqual([])
    expect(readdirSync(w.root).sort()).toEqual(['home', 'proposals.jsonl', 'state.json'])
    expect(w.state()).toMatchObject({ runsToday: 1, consecutiveFailures: 0, breakerUntil: null, queue: [] })
    expect(w.runner.snapshot()).toMatchObject({ enabled: true, state: 'idle', runsToday: 1, queued: 0, breaker: { open: false, failures: 0 } })
  }, 30_000)

  it('runs a meeting once, however often it is announced', async () => {
    const w = world('success')
    w.runner.notifyFinalized(w.session)
    await waitFor(() => w.records().length === 1 && w.idle())
    w.runner.notifyFinalized(w.session)
    await new Promise(r => setTimeout(r, 300))
    expect(w.records()).toHaveLength(1)
    expect(w.cliRuns()).toHaveLength(1)
  }, 30_000)

  it('a crashing CLI is a failure record, and three in a row open the breaker for an hour', async () => {
    let clock = Date.parse('2026-10-28T15:00:00Z')
    const w = world('crash', { now: () => clock }, 4)
    for (const s of w.sessions.slice(0, 3)) w.runner.notifyFinalized(s)
    await waitFor(() => w.records().length === 3 && w.idle(), 30_000)
    expect(w.records().map((r: any) => [r.status, r.reason])).toEqual([['failed', 'cli_failed'], ['failed', 'cli_failed'], ['failed', 'cli_failed']])
    expect(w.state().consecutiveFailures).toBe(3)
    expect(w.state().breakerUntil).toBe(clock + 60 * 60_000)
    w.runner.notifyFinalized(w.sessions[3])
    await waitFor(() => w.state().queue.length === 1 && w.idle())
    expect(w.runner.snapshot()).toMatchObject({ state: 'breaker_open', breaker: { open: true, failures: 3 } })
    expect(w.cliRuns()).toHaveLength(3)
    // An hour later the breaker lets one run through.
    clock += 60 * 60_000 + 1
    w.timers.splice(0).forEach(fn => fn())
    await waitFor(() => w.records().length === 4 && w.idle(), 30_000)
    expect(w.cliRuns()).toHaveLength(4)
  }, 60_000)

  it('the hard wall clock kills the whole process group', async () => {
    const w = world('hang', { limits: () => ({ dailyRuns: 12, timeoutMs: 3_000, rssBytes: 3 * 1024 ** 3 }) })
    w.runner.notifyFinalized(w.session)
    await waitFor(() => w.records().length === 1 && w.idle(), 30_000)
    expect(w.records()[0]).toMatchObject({ status: 'failed', reason: 'timeout' })
    const cliPid = w.cliRuns()[0].pid
    await waitFor(() => { try { process.kill(cliPid, 0); return false } catch { return true } }, 5_000)
    expect(() => process.kill(w.spawned[0], 0)).toThrow()
  }, 30_000)

  it('the RSS cap kills a run that grows past it', async () => {
    const w = world('memory', { limits: () => ({ dailyRuns: 12, timeoutMs: 60_000, rssBytes: 512 * 1024 * 1024 }) })
    w.runner.notifyFinalized(w.session)
    await waitFor(() => w.records().length === 1 && w.idle(), 40_000)
    expect(w.records()[0]).toMatchObject({ status: 'failed', reason: 'rss_cap' })
    expect(w.records()[0].resources.peakRssBytes).toBeGreaterThan(512 * 1024 * 1024)
  }, 45_000)

  it('a worker that dies without an answer is a failure, not a hang', async () => {
    const w = world('success', { spawnWorker: () => spawn(process.execPath, ['-e', 'process.exit(5)'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }) })
    w.runner.notifyFinalized(w.session)
    await waitFor(() => w.records().length === 1 && w.idle())
    expect(w.records()[0]).toMatchObject({ status: 'failed', reason: 'worker_crashed' })
  }, 20_000)

  it('missing models skip the meeting without spawning anything', async () => {
    const w = world('success', { modelsPresent: () => false })
    w.runner.notifyFinalized(w.session)
    await waitFor(() => w.records().length === 1 && w.idle())
    expect(w.records()[0]).toMatchObject({ status: 'skipped', reason: 'models_missing' })
    expect(w.spawned).toEqual([])
    expect(w.state().runsToday).toBe(0)
  })

  it('no verified CLI skips the meeting', async () => {
    const w = world('success', { resolveCli: async () => null })
    w.runner.notifyFinalized(w.session)
    await waitFor(() => w.records().length === 1 && w.idle())
    expect(w.records()[0]).toMatchObject({ status: 'skipped', reason: 'cli_missing' })
    expect(w.spawned).toEqual([])
  })

  it('stops at the daily cap', async () => {
    const w = world('success', { limits: () => ({ dailyRuns: 1, timeoutMs: 60_000, rssBytes: 3 * 1024 ** 3 }) }, 2)
    w.runner.notifyFinalized(w.sessions[0])
    w.runner.notifyFinalized(w.sessions[1])
    await waitFor(() => w.records().length === 2 && w.idle(), 30_000)
    expect(w.records().map((r: any) => [r.status, r.reason])).toEqual([['proposed', null], ['skipped', 'daily_cap']])
    expect(w.spawned).toHaveLength(1)
  }, 30_000)
})

describe('speaker shadow runner: live work', () => {
  it('waits while a recording or transcription is live, then runs', async () => {
    let live = true
    const w = world('success', { captureActive: () => live })
    w.runner.notifyFinalized(w.session)
    await waitFor(() => existsSync(join(w.root, 'state.json')) && w.idle() && w.timers.length > 0)
    expect(w.spawned).toEqual([])
    expect(w.runner.snapshot()).toMatchObject({ state: 'deferred', queued: 1, deferredReason: 'live_work' })
    live = false
    w.timers.splice(0).forEach(fn => fn())
    await waitFor(() => w.records().length === 1 && w.idle(), 30_000)
    expect(w.records()[0].status).toBe('proposed')
  }, 30_000)

  it('a recording that goes live mid-run stops the run and puts the meeting back', async () => {
    let live = false
    const w = world('slow', { captureActive: () => live })
    w.runner.notifyFinalized(w.session)
    await waitFor(() => w.cliRuns().length === 1)
    live = true
    await waitFor(() => w.idle() && w.timers.length > 0, 10_000)
    const cliPid = w.cliRuns()[0].pid
    await waitFor(() => { try { process.kill(cliPid, 0); return false } catch { return true } }, 5_000)
    expect(w.records()).toEqual([])
    expect(w.state()).toMatchObject({ runsToday: 0, consecutiveFailures: 0 })
    expect(w.state().queue.map((q: any) => q.sessionId)).toEqual([w.session.sessionId])
    expect(w.logs.some(l => l.includes('capture_live'))).toBe(true)
    live = false
    w.timers.splice(0).forEach(fn => fn())
    await waitFor(() => w.records().length === 1 && w.idle(), 30_000)
    expect(w.records()[0].status).toBe('proposed')
    expect(w.cliRuns()).toHaveLength(2)
  }, 45_000)

  it('without a live-work probe nothing runs (fail closed until the server wires one)', async () => {
    const w = world('success', { captureActive: null })
    w.runner.notifyFinalized(w.session)
    await waitFor(() => existsSync(join(w.root, 'state.json')) && w.idle() && w.timers.length > 0)
    expect(w.spawned).toEqual([])
    expect(w.runner.snapshot().state).toBe('no_live_probe')
  })

  it('a drain or shutdown defers like live work', async () => {
    const w = world('success', { admissionsOpen: () => false })
    w.runner.notifyFinalized(w.session)
    await waitFor(() => existsSync(join(w.root, 'state.json')) && w.idle() && w.timers.length > 0)
    expect(w.spawned).toEqual([])
  })

  it('treats every capture lease the merge engine treats as live, plus dictation', async () => {
    const { CAPTURE_LEASE_KINDS } = await import('./meeting-actions.js')
    for (const kind of CAPTURE_LEASE_KINDS) expect(shadow.SPEAKER_SHADOW_LIVE_LEASES).toContain(kind)
    expect(shadow.speakerShadowLeaseActive(() => ({}))).toBe(false)
    expect(shadow.speakerShadowLeaseActive(() => ({ recording_chunk: 1 }))).toBe(true)
    expect(shadow.speakerShadowLeaseActive(() => ({ prompt_draft_finalize: 1 }))).toBe(true)
    expect(shadow.speakerShadowLeaseActive(() => ({ api_mutation: 3 }))).toBe(false)
  })
})

describe('speaker shadow runner: restart and records', () => {
  it('resumes a meeting a previous process queued but never ran', async () => {
    const w = world('success', { captureActive: () => true })
    w.runner.notifyFinalized(w.session)
    await waitFor(() => existsSync(join(w.root, 'state.json')) && w.idle())
    const second = new shadow.SpeakerShadowRunner({ ...(w.runner as any).deps, captureActive: () => false })
    second.resume()
    await waitFor(() => w.records().length === 1 && !(second as any).running && !(second as any).pumping, 30_000)
    expect(w.records()[0].status).toBe('proposed')
  }, 30_000)

  it('reads records newest first, filters by session, and skips a torn line', async () => {
    const root = join(scratch, 'records-only')
    const make = (sessionId: string, at: string) => ({ schema: 1, kind: 'speaker_shadow', logOnly: true, recordedAt: at, serverVersion: 't', sessionId, enqueuedAt: at, status: 'skipped', reason: 'models_missing', detail: null, gates: {} }) as any
    await shadow.appendSpeakerShadowRecord(root, make('mac_00000000-0000-4000-8000-000000000001', '2026-10-28T10:00:00Z'))
    await shadow.appendSpeakerShadowRecord(root, make('mac_00000000-0000-4000-8000-000000000002', '2026-10-28T11:00:00Z'))
    writeFileSync(join(root, 'proposals.jsonl'), readFileSync(join(root, 'proposals.jsonl'), 'utf8') + '{"kind":"speaker_sha')
    const all = await shadow.readSpeakerShadowRecords(root)
    expect(all.map(r => r.sessionId.slice(-1))).toEqual(['2', '1'])
    expect((await shadow.readSpeakerShadowRecords(root, { sessionId: 'mac_00000000-0000-4000-8000-000000000001' })).length).toBe(1)
    // An append after a torn tail starts a fresh line; nothing earlier is lost.
    await shadow.appendSpeakerShadowRecord(root, make('mac_00000000-0000-4000-8000-000000000003', '2026-10-28T12:00:00Z'))
    expect((await shadow.readSpeakerShadowRecords(root)).map(r => r.sessionId.slice(-1))).toEqual(['3', '2', '1'])
    expect(readdirSync(root).filter(n => n.endsWith('.tmp'))).toEqual([])
  })

  it('rotates the log past 8 MB instead of rewriting it forever', async () => {
    const root = join(scratch, 'records-rotate')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'proposals.jsonl'), `${JSON.stringify({ kind: 'speaker_shadow', sessionId: 'old', pad: 'x'.repeat(shadow.SPEAKER_SHADOW_RECORDS_ROTATE_BYTES) })}\n`)
    await shadow.appendSpeakerShadowRecord(root, { schema: 1, kind: 'speaker_shadow', logOnly: true, recordedAt: '2026-10-28T12:00:00.000Z', serverVersion: 't', sessionId: 'new', enqueuedAt: '2026-10-28T12:00:00.000Z', status: 'skipped', reason: null, detail: null, gates: {} as any })
    expect(readdirSync(root).sort()).toEqual(['proposals-2026-10-28T12-00-00-000Z.jsonl', 'proposals.jsonl'])
    expect((await shadow.readSpeakerShadowRecords(root, { limit: 5 })).map(r => r.sessionId)).toEqual(['new', 'old'])
  })

  it('health carries codes and counts only', () => {
    const health = shadow.speakerShadowHealth()
    expect(Object.keys(health).sort()).toEqual(['breaker', 'dailyCap', 'deferredReason', 'enabled', 'lastError', 'lastRun', 'queued', 'runsToday', 'state'])
    expect(JSON.stringify(health)).not.toMatch(/mac_|\/Users\/|detail/)
  })

  it('looks for chunk audio exactly where the meeting-audio archive keeps it', async () => {
    const { meetingAudioChunkPath } = await import('./meeting-audio-archive.js')
    const sessionId = 'mac_00000000-0000-4000-8000-0000000000ff'
    const dir = shadow.defaultSpeakerShadowDeps().audioDirFor(sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'chunk_0003.wav'), 'x')
    expect(meetingAudioChunkPath(sessionId, 3)).toBe(join(dir, 'chunk_0003.wav'))
  })

  it('the boot sweep removes only old shadow temp dirs', () => {
    const root = mkdtempSync(join(scratch, 'sweep-'))
    mkdirSync(join(root, 'cos-speaker-shadow-old'))
    mkdirSync(join(root, 'cos-parakeet-keep'))
    expect(shadow.sweepStaleSpeakerShadowTmp(root, 0, Date.now() + 1)).toBe(1)
    expect(readdirSync(root)).toEqual(['cos-parakeet-keep'])
  })
})

vi.setConfig({ testTimeout: 30_000 })
