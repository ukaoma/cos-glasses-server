// 6.78.0 (MVP-C): resumeMeetingFinalizationJobs behind the crash-loop gate, executed against
// the REAL MeetingFinalizationJobStore and the real gate. Each boot is a new gate over the same
// ledger; a "crash" is a boot that ends without markCleanShutdown. `schedule` is the seam the
// boot uses to start a job, so no test here runs the HQ pipeline, except the one whose job is
// already complete (that path returns before any pipeline step).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { MeetingFinalizationJobStore, markCanonicalFinalizationState, type MeetingFinalizationJob } from '../lib/meeting-finalization-jobs.js'
import { RESTART_LIMIT, createBootResumeGate, installBootResumeGate, type BootResumeGate } from '../lib/boot-resume.js'
import { resumeMeetingFinalizationJobs } from './meeting.js'

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
afterEach(() => { installBootResumeGate(null) })

const BOOTS = RESTART_LIMIT * 2 + 2

function fixture(sessionIds = ['g2-crashing-1'], phase: MeetingFinalizationJob['phase'] = 'batch_pending', sidecarState = 'batch_pending') {
  const root = mkdtempSync(join(tmpdir(), 'cos-finalization-boot-resume-'))
  roots.push(root)
  const recordings = join(root, 'data', 'recordings', '2026-10')
  mkdirSync(recordings, { recursive: true })
  const store = new MeetingFinalizationJobStore(join(root, 'data', 'meeting-finalization-jobs'))
  const addJob = (sessionId: string) => {
    const meetingPath = join(recordings, `${sessionId}.md`)
    const sidecarPath = join(recordings, `${sessionId}.g2-chunks.json`)
    writeFileSync(meetingPath, '# meeting\n')
    writeFileSync(sidecarPath, JSON.stringify({ sessionId, finalizationState: sidecarState }))
    store.save({ sessionId, meetingPath, sidecarPath, audioDir: null, streamingWordCount: 12, phase, claimPending: false })
  }
  for (const sessionId of sessionIds) addJob(sessionId)
  const ledger = join(root, 'data', 'boot-resume-ledger.json')
  // The process that saved these jobs opened its boot and then crashed mid-finalization.
  writeFileSync(ledger, JSON.stringify({ version: 1, cleanShutdown: false, entries: {} }))
  return { root, store, addJob, ledger }
}

const gateAt = (ledger: string): BootResumeGate => createBootResumeGate({ path: ledger, env: {}, log: () => {} })

/** One boot: open the gate, resume, and record what was started (and the ledger at that moment). */
function boot(store: MeetingFinalizationJobStore, ledger: string, options: { clean?: boolean; sessionId?: string; gate?: BootResumeGate } = {}) {
  const gate = options.gate ?? gateAt(ledger)
  gate.openBoot()
  const started: Array<{ sessionId: string; ledger: string }> = []
  resumeMeetingFinalizationJobs({
    gate,
    finalizationJobs: store,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    schedule: job => { started.push({ sessionId: job.sessionId, ledger: readFileSync(ledger, 'utf8') }) },
  })
  if (options.clean) gate.markCleanShutdown()
  return { gate, started }
}

describe('meeting finalization resume behind the crash-loop gate (6.78.0)', () => {
  it('a finalization that crashes the server is resumed on at most 3 crashed boots, then parked and left in its store', () => {
    const { store, ledger } = fixture()
    let resumed = 0
    for (let i = 0; i < BOOTS; i++) resumed += boot(store, ledger).started.length
    expect(resumed).toBe(RESTART_LIMIT)
    expect(gateAt(ledger).status('meeting_finalization', 'g2-crashing-1')).toMatchObject({ parked: true, reason: 'restart_limit', phase: 'batch_pending' })
    // Nothing is lost: the job is still in its own store, ready for Retry.
    expect(store.get('g2-crashing-1')).toMatchObject({ sessionId: 'g2-crashing-1', phase: 'batch_pending' })
  })

  it('counts before it runs: the ledger already holds the count when the job is started', () => {
    const { store, ledger } = fixture()
    const { started } = boot(store, ledger)
    expect(started).toHaveLength(1)
    expect(JSON.parse(started[0]!.ledger).entries['meeting_finalization:g2-crashing-1']).toMatchObject({ attempts: 1, phase: 'batch_pending' })
  })

  it('only the crashing job is parked; a job that finished is forgotten and never counted again', () => {
    const { store, ledger } = fixture(['g2-crashing-1', 'g2-healthy-2'])
    const first = boot(store, ledger)
    expect(first.started.map(row => row.sessionId).sort()).toEqual(['g2-crashing-1', 'g2-healthy-2'])
    // The healthy one finished in that boot, as production finishes one: sidecar marked
    // complete, then its store removes it and the gate forgets it.
    const healthy = store.get('g2-healthy-2')!
    markCanonicalFinalizationState(healthy.sidecarPath, 'complete', false)
    store.remove('g2-healthy-2')
    first.gate.forget('meeting_finalization', 'g2-healthy-2')
    for (let i = 1; i < RESTART_LIMIT + 1; i++) boot(store, ledger)
    const { started } = boot(store, ledger)
    expect(started).toEqual([])
    expect(gateAt(ledger).status().parked.map(row => row.id)).toEqual(['g2-crashing-1'])
    expect(gateAt(ledger).status('meeting_finalization', 'g2-healthy-2')).toBeNull()
  })

  it('routine restarts resume it on every boot and never park it', () => {
    const { store, ledger } = fixture()
    let resumed = 0
    for (let i = 0; i < BOOTS; i++) resumed += boot(store, ledger, { clean: true }).started.length
    expect(resumed).toBe(BOOTS)
    expect(gateAt(ledger).isParked('meeting_finalization', 'g2-crashing-1')).toBe(false)
  })

  it('progress to a new phase starts the count over', () => {
    const { store, ledger } = fixture()
    for (let i = 0; i < RESTART_LIMIT; i++) boot(store, ledger)
    const job = store.get('g2-crashing-1')!
    store.save({ ...job, phase: 'ops_pending' })
    let resumed = 0
    for (let i = 0; i < RESTART_LIMIT; i++) resumed += boot(store, ledger).started.length
    expect(resumed).toBe(RESTART_LIMIT)
  })

  it('Retry resumes that one job in the same boot, with a fresh count, and leaves the others alone', () => {
    const { store, ledger, addJob } = fixture(['g2-crashing-1'])
    for (let i = 0; i < RESTART_LIMIT + 1; i++) boot(store, ledger)
    addJob('g2-other-2')
    const gate = gateAt(ledger)
    const parkedBoot = boot(store, ledger, { gate })
    expect(parkedBoot.started.map(row => row.sessionId)).toEqual(['g2-other-2'])
    expect(gate.retry('meeting_finalization', 'g2-crashing-1')).toMatchObject({ parked: false, attempts: 0 })
    const retried: string[] = []
    resumeMeetingFinalizationJobs({ gate, finalizationJobs: store, sessionId: 'g2-crashing-1', schedule: job => { retried.push(job.sessionId) } })
    expect(retried).toEqual(['g2-crashing-1'])
    expect(gate.status('meeting_finalization', 'g2-crashing-1')?.attempts).toBe(0)
  })

  it('with no gate installed it resumes every job on every boot (6.77.0)', () => {
    const { store, ledger } = fixture()
    let resumed = 0
    for (let i = 0; i < BOOTS; i++) {
      const started: string[] = []
      resumeMeetingFinalizationJobs({ finalizationJobs: store, schedule: job => { started.push(job.sessionId) } })
      resumed += started.length
    }
    expect(resumed).toBe(BOOTS)
    expect(JSON.parse(readFileSync(ledger, 'utf8')).entries).toEqual({})
  })

  it('the real resume forgets the count when the store removes a finished job', async () => {
    const { store, ledger } = fixture(['g2-done-1'], 'ops_pending', 'complete')
    const gate = installBootResumeGate(gateAt(ledger))
    gate.openBoot()
    resumeMeetingFinalizationJobs({ finalizationJobs: store })
    await vi.waitFor(() => { if (store.get('g2-done-1')) throw new Error('still pending') })
    expect(gate.status('meeting_finalization', 'g2-done-1')).toBeNull()
    expect(JSON.parse(readFileSync(ledger, 'utf8')).entries).toEqual({})
  })
})
