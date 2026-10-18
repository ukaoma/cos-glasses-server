// 6.78.0 restart truth (plan v3.1 P2): the pure planner that tells a person what a restart cut
// off. Executed against the real module; nothing here touches a store, a provider or a file.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  MAX_AUTO_RESUMES_PER_LINEAGE,
  buildInterruption,
  interruptedByRestart,
  planRestartResume,
  restartCauseOf,
  restartError,
  restartNoticeText,
  trailSteps,
} from './query-job-resume.js'
import {
  QUERY_JOB_ERROR_CAUSES,
  QUERY_JOB_INTERRUPTION_LIMITS,
  QUERY_JOB_LIMITS,
  QUERY_JOB_RESTART_MESSAGE,
  normalizeQueryJobError,
  parseQueryJobInterruption,
  type QueryJobSnapshot,
} from './query-job-types.js'

const CONTRACT = JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__/pi-durable/contracts/interrupted-job.json'), 'utf8'))
const AT = '2026-10-18T19:31:02.000Z'

const tool = (verb: string, target: string, call?: string) => ({ kind: 'tool', verb, target, detail: '', ...(call ? { call } : {}) })
const done = (call: string | undefined, ok = true) => ({ kind: 'status', state: 'working', tool_outcome: { ok, detail: ok ? 'ok' : 'exit 1', ...(call ? { call } : {}) } })
const seq = (entries: Array<Record<string, unknown>>, first = 1) => entries.map((entry, index) => ({ ...entry, trailSeq: first + index, at: AT }))

function job(overrides: Partial<QueryJobSnapshot> = {}): QueryJobSnapshot {
  return {
    schemaVersion: 1, jobId: 'job', clientJobId: 'c1a2b3c4-0000-4000-8000-000000000009', generation: 1, turnId: 't',
    requestFingerprint: 'f', status: 'interrupted', eventSeq: 9, oldestEventSeq: 1, sessionId: 's', attachments: [],
    partialText: '', partialTruncated: false, activity: [], acceptedAt: AT, updatedAt: AT, completedAt: AT, retentionUntil: AT,
    providerOwnershipConfirmedAt: AT,
    error: restartError('server_restarted'),
    ...overrides,
  } as QueryJobSnapshot
}

const build = (trail: Array<Record<string, unknown>> | undefined, options: Partial<Parameters<typeof buildInterruption>[0]> = {}) => buildInterruption({
  job: { trail: trail as QueryJobSnapshot['trail'], providerOwnershipConfirmedAt: AT },
  activityToolMode: 'preview',
  cause: 'server_restarted',
  at: AT,
  ...options,
})

describe('trailSteps (6.78.0)', () => {
  it('finishes a step only by the outcome that names its call, newest unfinished first', () => {
    const { steps, ambiguous } = trailSteps(seq([tool('bash', 'npm test', 'call_aaaa'), tool('bash', 'npm test', 'call_bbbb'), done('call_aaaa')]))
    expect(steps.map(s => [s.call, s.finished])).toEqual([['call_aaaa', true], ['call_bbbb', false]])
    expect(ambiguous).toBe(false)
  })

  it('an outcome with no call, or one that matches no step, finishes nothing and marks the list ambiguous', () => {
    expect(trailSteps(seq([tool('edit', 'a.ts', 'call_aaaa'), done(undefined)]))).toMatchObject({ ambiguous: true, steps: [{ finished: false }] })
    expect(trailSteps(seq([tool('edit', 'a.ts', 'call_aaaa'), done('call_zzzz')]))).toMatchObject({ ambiguous: true, steps: [{ finished: false }] })
    expect(trailSteps(seq([tool('edit', 'a.ts')])).ambiguous).toBe(true)
  })

  it('reads only tool and status entries: prose, a steer row and any later kind are not steps', () => {
    const { steps, ambiguous } = trailSteps(seq([
      { kind: 'prose', text: 'Let me look.' },
      { kind: 'steer', steerId: 'x', text: 'also check the tests' },
      { kind: 'future_kind', verb: 'edit', target: 'x.ts' },
      tool('read', 'README.md', 'call_aaaa'),
    ]))
    expect(steps).toEqual([{ verb: 'read', target: 'README.md', call: 'call_aaaa', finished: false }])
    expect(ambiguous).toBe(false)
  })
})

describe('buildInterruption (6.78.0)', () => {
  it('names the step cut off and the side-effect steps already done (the QJ-6b shape)', () => {
    const interruption = build(seq([
      tool('bash', 'git push origin feature/logo-strip', 'toolu_push_1'), done('toolu_push_1'),
      tool('read', 'README.md', 'toolu_read_2'),
    ]))
    expect(interruption).toEqual({
      cause: 'server_restarted', at: AT,
      cutOffDuring: 'reading README.md',
      alreadyDone: ['ran git push origin feature/logo-strip'],
      incomplete: false, resumable: true,
    })
    expect(restartNoticeText(interruption)).toBe('The server restarted mid-answer. Cut off during: reading README.md. Already done: ran git push origin feature/logo-strip.')
  })

  it('never lists reads or searches as already done, and marks a failed step', () => {
    const interruption = build(seq([
      tool('read', 'a.ts', 'call_r1'), done('call_r1'),
      tool('search', 'TODO', 'call_s1'), done('call_s1'),
      tool('edit', 'api-client.ts', 'call_e1'), done('call_e1'),
      tool('bash', 'npm test', 'call_b1'), done('call_b1', false),
    ]))
    expect(interruption.alreadyDone).toEqual(['edited api-client.ts', 'ran npm test (failed)'])
    expect(interruption.cutOffDuring).toBeNull()
    expect(interruption.incomplete).toBe(false)
  })

  it("uses Claude Code's own step line for the open step, but only while that step is the newest", () => {
    expect(build(seq([tool('bash', 'npm test', 'call_b1'), { kind: 'status', state: 'working', detail: 'Running the test suite.' }])).cutOffDuring)
      .toBe('running the test suite')
    // The line came before a newer step: it describes an older one, so the newer step's own words win.
    expect(build(seq([{ kind: 'status', state: 'working', detail: 'Running the test suite.' }, tool('edit', 'x.ts', 'call_e1')])).cutOffDuring)
      .toBe('editing x.ts')
  })

  it('keeps the newest five done steps, each at most 60 characters, and says older ones were dropped', () => {
    const entries: Array<Record<string, unknown>> = []
    for (let i = 1; i <= 7; i++) entries.push(tool('edit', `file-${i}.ts`, `call_e${i}xx`), done(`call_e${i}xx`))
    entries.push(tool('bash', `node scripts/${'very-long-name-'.repeat(8)}.mjs`, 'call_long'), done('call_long'))
    const interruption = build(seq(entries))
    expect(interruption.alreadyDone).toHaveLength(QUERY_JOB_INTERRUPTION_LIMITS.alreadyDoneMax)
    expect(interruption.alreadyDone[0]).toBe('edited file-4.ts')
    expect(interruption.alreadyDone.every(line => line.length <= QUERY_JOB_INTERRUPTION_LIMITS.alreadyDoneEntryChars)).toBe(true)
    expect(interruption.alreadyDone.at(-1)).toMatch(/\.\.\.$/)
    expect(interruption.incomplete).toBe(true)
  })

  it('bounds the cut-off step to 60 characters and redacts paths and credentials like activity', () => {
    const interruption = build(seq([tool('bash', `curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwx" /Users/miles/private/${'x'.repeat(80)}`, 'call_b1')]))
    expect(interruption.cutOffDuring!.length).toBeLessThanOrEqual(QUERY_JOB_INTERRUPTION_LIMITS.cutOffDuringChars)
    expect(interruption.cutOffDuring).not.toMatch(/sk-abcdef|\/Users\/miles/)
  })

  it('says the list may be incomplete when it cannot be whole', () => {
    // Tool activity off: the trail holds no steps at all.
    expect(build(seq([{ kind: 'prose', text: 'Working.' }]), { activityToolMode: 'off' }).incomplete).toBe(true)
    // The trail lost its oldest entries (its first held entry is not trailSeq 1)...
    expect(build(seq([tool('edit', 'x.ts', 'call_e1'), done('call_e1')], 7)).incomplete).toBe(true)
    // ...or is at its entry bound.
    const full = seq(Array.from({ length: QUERY_JOB_LIMITS.trailEntries }, () => ({ kind: 'prose', text: 'p' })))
    expect(build(full).incomplete).toBe(true)
    // Two steps still open, or a call-less outcome.
    expect(build(seq([tool('edit', 'a.ts', 'call_e1'), tool('edit', 'b.ts', 'call_e2')])).incomplete).toBe(true)
    expect(build(seq([tool('edit', 'a.ts', 'call_e1'), done(undefined)])).incomplete).toBe(true)
    // A provider owned the session and left no trail at all (COS_MESSAGES_TRAIL=0, say).
    expect(build(undefined).incomplete).toBe(true)
  })

  it('a job that never reached a provider was cut off during nothing, and the list is complete', () => {
    expect(buildInterruption({ job: {}, activityToolMode: 'preview', cause: 'server_shutdown', at: AT }))
      .toEqual({ cause: 'server_shutdown', at: AT, cutOffDuring: null, alreadyDone: [], incomplete: false, resumable: true })
  })

  it('a crash-loop-parked job is never resumable and its list is never complete', () => {
    expect(buildInterruption({ job: {}, activityToolMode: 'preview', cause: 'crash_loop_parked', at: AT }))
      .toEqual(CONTRACT.parked.interruption)
  })

  it('builds inside the shutdown budget: a full 200-entry trail in well under 50 ms', () => {
    const entries: Array<Record<string, unknown>> = []
    for (let i = 0; i < QUERY_JOB_LIMITS.trailEntries / 2; i++) entries.push(tool('edit', `f${i}.ts`, `call_${String(i).padStart(4, '0')}`), done(`call_${String(i).padStart(4, '0')}`))
    const trail = seq(entries)
    const started = performance.now()
    for (let i = 0; i < 10; i++) build(trail)
    expect((performance.now() - started) / 10).toBeLessThan(50)
  })
})

describe('the wire contract (pi_durable_build/contracts/interrupted-job.json)', () => {
  it('every restart path writes the contract message and a cause from the allowlist', () => {
    expect(QUERY_JOB_RESTART_MESSAGE).toBe(CONTRACT.restart.error.message)
    expect(QUERY_JOB_RESTART_MESSAGE).toBe(CONTRACT.shutdown.error.message)
    expect(restartError('server_restarted')).toEqual(CONTRACT.restart.error)
    expect(restartError('server_shutdown')).toEqual(CONTRACT.shutdown.error)
    for (const fixture of [CONTRACT.restart, CONTRACT.shutdown, CONTRACT.parked]) {
      expect(QUERY_JOB_ERROR_CAUSES.has(fixture.error.cause)).toBe(true)
      expect(normalizeQueryJobError(fixture.error)).toEqual(fixture.error)
    }
  })

  it('the bounds are the contract limits', () => {
    expect(QUERY_JOB_INTERRUPTION_LIMITS.alreadyDoneMax).toBe(CONTRACT.limits.alreadyDoneMax)
    expect(QUERY_JOB_INTERRUPTION_LIMITS.alreadyDoneEntryChars).toBe(CONTRACT.limits.alreadyDoneEntryChars)
    // The lead a 32-column footer shows whole.
    expect(QUERY_JOB_RESTART_MESSAGE.split('. ')[0]!.length + 1).toBeLessThanOrEqual(CONTRACT.limits.messageLeadColumns)
  })

  it('every contract interruption survives the journal parser unchanged', () => {
    for (const fixture of [CONTRACT.restart, CONTRACT.shutdown, CONTRACT.parked]) {
      expect(parseQueryJobInterruption(fixture.interruption)).toEqual(fixture.interruption)
    }
  })

  it('the parser holds a record another build wrote to this shape and these bounds', () => {
    expect(parseQueryJobInterruption({ ...CONTRACT.restart.interruption, cause: 'gremlins' })).toBeUndefined()
    expect(parseQueryJobInterruption({ ...CONTRACT.restart.interruption, at: 'not a date' })).toBeUndefined()
    expect(parseQueryJobInterruption({ ...CONTRACT.restart.interruption, incomplete: 'yes' })).toBeUndefined()
    expect(parseQueryJobInterruption([CONTRACT.restart.interruption])).toBeUndefined()
    const loose = parseQueryJobInterruption({
      ...CONTRACT.restart.interruption,
      cutOffDuring: 'x'.repeat(500),
      alreadyDone: ['a', 7, '', ...Array.from({ length: 9 }, (_, i) => `step ${i} ${'y'.repeat(90)}`)],
      extra: 'dropped',
    })!
    expect(loose.cutOffDuring!.length).toBeLessThanOrEqual(60)
    expect(loose.alreadyDone).toHaveLength(5)
    expect(loose.alreadyDone.every(line => line.length <= 60)).toBe(true)
    expect(loose).not.toHaveProperty('extra')
  })
})

describe('planRestartResume (6.78.0)', () => {
  const request = { activityToolMode: 'preview' as const }
  const now = Date.parse(AT)

  it('a job no restart ended is none', () => {
    expect(planRestartResume(job({ status: 'failed', error: { code: 'provider_failed', message: 'x' } }), request, { now, autoResumesSoFar: 0 }).action).toBe('none')
    expect(planRestartResume(job({ status: 'canceled', error: { code: 'canceled', message: 'Canceled by user.' } }), request, { now, autoResumesSoFar: 0 }).action).toBe('none')
    expect(planRestartResume(job({ error: { code: 'interrupted', message: 'something else' } }), request, { now, autoResumesSoFar: 0 }).action).toBe('none')
  })

  it('waits while a provider child from before the restart may still run (the orphan fence, QJ-6d)', () => {
    const plan = planRestartResume(job({ orphanFenceUntil: new Date(now + 60_000).toISOString() }), request, { now, autoResumesSoFar: 0 })
    expect(plan).toMatchObject({ action: 'wait', reason: 'orphan_fence' })
    expect(planRestartResume(job({ orphanFenceUntil: new Date(now - 1).toISOString() }), request, { now, autoResumesSoFar: 0 }).action).toBe('ask_user')
  })

  it('never resumes by itself in 6.78.0, not even a declared read-only dispatch (deferred, V3 N11)', () => {
    expect(MAX_AUTO_RESUMES_PER_LINEAGE).toBe(0)
    const plan = planRestartResume(job(), { activityToolMode: 'preview', dispatch: { restricted: true, tools: ['Read', 'Grep', 'Glob'] } }, { now, autoResumesSoFar: 0 })
    expect(plan).toMatchObject({ action: 'ask_user', reason: 'auto_resume_deferred' })
    expect(planRestartResume(job(), request, { now, autoResumesSoFar: 0 })).toMatchObject({ action: 'ask_user', reason: 'not_declared_replay_safe' })
  })

  it('reads the stored interruption when there is one, and builds it for a journal 6.77.0 wrote', () => {
    const trail = seq([tool('bash', 'git push origin feature/logo-strip', 'toolu_push_1'), done('toolu_push_1'), tool('read', 'README.md', 'toolu_read_2')]) as QueryJobSnapshot['trail']
    const legacy = job({ trail, error: { code: 'interrupted', message: 'Server restarted. Prompt preserved; provider was not restarted.', retryable: true } })
    const plan = planRestartResume(legacy, request, { now, autoResumesSoFar: 0 })
    expect(plan.notice).toContain('git push origin feature/logo-strip')
    expect(plan.notice).toContain('README.md')
    const stored = job({ interruption: { ...CONTRACT.restart.interruption } })
    expect(planRestartResume(stored, request, { now, autoResumesSoFar: 0 }).notice).toContain('running the test suite')
  })

  it('a parked job is a person\'s call, whatever its fence', () => {
    const parked = job({ error: { ...CONTRACT.parked.error }, interruption: { ...CONTRACT.parked.interruption }, orphanFenceUntil: new Date(now + 60_000).toISOString() })
    expect(planRestartResume(parked, request, { now, autoResumesSoFar: 0 })).toMatchObject({ action: 'ask_user', reason: 'crash_loop_parked' })
  })
})

describe('restartCauseOf (6.78.0)', () => {
  it('reads 6.78.0 causes and the 6.77.0 messages of both restart paths', () => {
    expect(restartCauseOf(job())).toBe('server_restarted')
    expect(restartCauseOf(job({ error: restartError('server_shutdown') }))).toBe('server_shutdown')
    expect(restartCauseOf(job({ error: { code: 'interrupted', message: 'server_shutdown', retryable: true } }))).toBe('server_shutdown')
    expect(restartCauseOf(job({ error: { code: 'interrupted', message: 'Server restarted. Prompt preserved; provider was not restarted.' } }))).toBe('server_restarted')
    expect(restartCauseOf(job({ error: { ...CONTRACT.parked.error } }))).toBe('crash_loop_parked')
    expect(restartCauseOf(job({ status: 'failed' }))).toBeNull()
    expect(interruptedByRestart(job({ error: { ...CONTRACT.parked.error } }))).toBe(false)
    expect(interruptedByRestart(job({ error: restartError('server_shutdown') }))).toBe(true)
  })
})
