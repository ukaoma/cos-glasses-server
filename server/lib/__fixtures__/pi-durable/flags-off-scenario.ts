// 6.78.0 G-off: one deterministic query-job journal scenario, run by the flags-off identity
// test against THIS build and, once, by a generator against the 6.77.0 checkout (aa87c9d) to
// record the golden file next to this one. It imports nothing from either build: the store
// class and its storage are passed in, so the same steps drive both.
//
// What it covers: every row type the store writes on the paths P2 (restart truth) and P4
// (Messages steer) change. A run cut off by a crash (boot interrupt), one by a graceful
// shutdown, one that never reached a provider, one held `accepted` across the restart, one
// that completed (chunk rows), one at answer_ready (finished by the boot), trail rows and
// activity. The clock is fixed; random ids are normalized in order of first appearance.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The slice of QueryJobStore the scenario drives (6.77.0 and 6.78.0 both have it). */
export interface ScenarioStore {
  init(): Promise<unknown>
  admit(raw: unknown): Promise<{ job: { jobId: string } }>
  markStarting(jobId: string): Promise<unknown>
  markRunning(jobId: string, linkage: Record<string, unknown>): Promise<unknown>
  updateLinkage(jobId: string, linkage: Record<string, unknown>): Promise<unknown>
  appendPartial(jobId: string, delta: string, partialText: string): Promise<unknown>
  appendActivity(jobId: string, kind: 'status' | 'input' | 'output', text: string): Promise<unknown>
  appendTrail(jobId: string, raw: unknown): Promise<unknown>
  markAnswerReady(jobId: string, text: string, linkage?: Record<string, unknown>): Promise<unknown>
  complete(jobId: string, input: { text: string } & Record<string, unknown>): Promise<unknown>
  interrupt(jobId: string, reason?: string): Promise<unknown>
  takeRequeuedOnBoot(): Array<{ jobId: string }>
  getSnapshot(jobId: string, generation?: number): Promise<unknown>
  replay(jobId: string, generation: number, after: number): Promise<{ events: unknown[] }>
  getHealth(): Record<string, unknown>
}

export type ScenarioStoreCtor = new (options: Record<string, unknown>) => ScenarioStore

export interface ScenarioOutput {
  journal: string[]
  snapshots: Record<string, unknown>
  events: Record<string, unknown>
  health: Record<string, unknown>
  requeued: string[]
}

const CLIENT = {
  crashed: '0e5a9c1d-1111-4111-8111-000000000001',
  neverStarted: '0e5a9c1d-1111-4111-8111-000000000002',
  shutdown: '0e5a9c1d-1111-4111-8111-000000000003',
  held: '0e5a9c1d-1111-4111-8111-000000000004',
  completed: '0e5a9c1d-1111-4111-8111-000000000005',
  answerReady: '0e5a9c1d-1111-4111-8111-000000000006',
} as const

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/** Random ids become `<id:N>` in order of first appearance; the fixed client ids stay. */
function normalizer(): (text: string) => string {
  const seen = new Map<string, string>()
  const fixed = new Set<string>(Object.values(CLIENT))
  return text => text.replace(UUID_RE, id => {
    if (fixed.has(id)) return id
    if (!seen.has(id)) seen.set(id, `<id:${seen.size + 1}>`)
    return seen.get(id)!
  })
}

function request(clientJobId: string, query: string): Record<string, unknown> {
  return { clientJobId, generation: 1, query, sessionId: 'session-flags-off', activityToolMode: 'preview' }
}

export async function runFlagsOffScenario(Store: ScenarioStoreCtor, storage: () => unknown): Promise<ScenarioOutput> {
  const root = mkdtempSync(join(tmpdir(), 'cos-flags-off-'))
  try {
    let clock = Date.parse('2026-10-18T19:00:00.000Z')
    const now = () => new Date(clock)
    const tick = () => { clock += 1_000 }
    const open = (bootId: string) => new Store({ root, bootId, now, storage: storage(), requeueNeverStartedOnBoot: true })

    const a = open('boot-a-before-crash')
    await a.init()
    const run = async (clientJobId: string, query: string) => {
      const { job } = await a.admit(request(clientJobId, query)); tick()
      await a.markStarting(job.jobId); tick()
      await a.markRunning(job.jobId, { provider: 'claude', resolvedModel: 'opus' }); tick()
      await a.updateLinkage(job.jobId, { provider: 'claude', claudeRunId: `run-${clientJobId.slice(-2)}` }); tick()
      return job.jobId
    }

    // Cut off by a crash: steps, a finished push, a read in flight, two chunks, a status line.
    const crashed = await run(CLIENT.crashed, 'Push the logo strip branch, then summarize the README.')
    await a.appendTrail(crashed, { kind: 'tool', verb: 'bash', target: 'git push origin feature/logo-strip', detail: '', call: 'toolu_flags_off_1' }); tick()
    await a.appendTrail(crashed, { kind: 'status', state: 'working', tool_outcome: { ok: true, detail: 'pushed', call: 'toolu_flags_off_1' } }); tick()
    await a.appendTrail(crashed, { kind: 'tool', verb: 'read', target: 'README.md', detail: '', call: 'toolu_flags_off_2' }); tick()
    await a.appendActivity(crashed, 'status', 'Using Read...'); tick()
    await a.appendPartial(crashed, 'Pushed the branch. ', 'Pushed the branch. '); tick()
    await a.appendPartial(crashed, 'Reading the README', 'Pushed the branch. Reading the README'); tick()

    // Reached `starting`, never a provider.
    const neverStarted = (await a.admit(request(CLIENT.neverStarted, 'A question that never reached a provider.'))).job.jobId; tick()
    await a.markStarting(neverStarted); tick()

    // Admitted, never started: kept `accepted` for the next boot.
    const held = (await a.admit(request(CLIENT.held, 'A held question.'))).job.jobId; tick()

    // Completed, with chunk rows on the way.
    const completed = await run(CLIENT.completed, 'Say three things.')
    let acc = ''
    for (const part of ['One. ', 'Two. ', 'Three.']) { acc += part; await a.appendPartial(completed, part, acc); tick() }
    await a.markAnswerReady(completed, acc, { provider: 'claude', resolvedModel: 'opus' }); tick()
    await a.complete(completed, { text: acc, provider: 'claude', resolvedModel: 'opus' }); tick()

    // At answer_ready when the crash came: the boot finishes it from the journal.
    const answerReady = await run(CLIENT.answerReady, 'Answer then crash.')
    await a.appendPartial(answerReady, 'The answer.', 'The answer.'); tick()
    await a.markAnswerReady(answerReady, 'The answer.', { provider: 'claude', resolvedModel: 'opus' }); tick()

    // Ended by a graceful shutdown (what coordinator.shutdown writes), mid-edit. Last, because
    // its fence holds every later start in this session.
    const shutdown = await run(CLIENT.shutdown, 'Edit the API client to retry once.')
    await a.appendTrail(shutdown, { kind: 'tool', verb: 'edit', target: 'api-client.ts', detail: '', call: 'toolu_flags_off_3' }); tick()
    await a.appendPartial(shutdown, 'Editing.', 'Editing.'); tick()
    await a.interrupt(shutdown, 'server_shutdown'); tick()

    clock += 60_000
    const b = open('boot-b-after-crash')
    await b.init()
    const requeued = b.takeRequeuedOnBoot().map(item => item.jobId)

    const norm = normalizer()
    const ids = { crashed, neverStarted, shutdown, held, completed, answerReady }
    const snapshots: Record<string, unknown> = {}
    const events: Record<string, unknown> = {}
    for (const [name, jobId] of Object.entries(ids)) {
      snapshots[name] = await b.getSnapshot(jobId, 1)
      events[name] = (await b.replay(jobId, 1, 0)).events
    }
    const journal = readdirSync(root).filter(f => f.endsWith('.jsonl')).sort()
      .flatMap(file => readFileSync(join(root, file), 'utf8').split('\n').filter(Boolean))
    const health = b.getHealth()
    const out: ScenarioOutput = {
      journal: journal.map(line => norm(line)),
      snapshots: JSON.parse(norm(JSON.stringify(snapshots))) as Record<string, unknown>,
      events: JSON.parse(norm(JSON.stringify(events))) as Record<string, unknown>,
      health: {
        malformedRows: health.malformedRows, interruptedOnBoot: health.interruptedOnBoot,
        requeuedOnBoot: health.requeuedOnBoot, counts: health.counts, fingerprintMismatches: health.fingerprintMismatches,
      },
      requeued: requeued.map(id => norm(id)),
    }
    return out
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
