// 6.82.0 Routines, the journey at the route level: the real registry over the real morning brief
// scheduler and the real skill-routine scheduler, both on a fake coordinator the test finishes jobs on.
//   - the list is the brief first, then skill routines, each with schedule, next run, last result, switch;
//   - create, edit, pause, resume, Run now, history, delete, all through /api/routines;
//   - two routines run on schedule; a forced failure trips the breaker and stops one, not the other;
//   - the brief is routine #1: its edits go to its own config, it cannot be deleted.

import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { morningBriefPaths } from '../lib/morning-brief-config.js'
import { MorningBriefScheduler } from '../lib/morning-brief-scheduler.js'
import { RoutineRegistry } from '../lib/routines-registry.js'
import { CHICAGO, SLOT_8AM, fakeSnapshot, routineHarness } from '../lib/__fixtures__/routines-harness.js'
import { createRoutinesRouter } from './routines.js'

let h: ReturnType<typeof routineHarness>
let brief: MorningBriefScheduler
let server: Server
let base: string
const roots: string[] = []

beforeEach(async () => {
  h = routineHarness()
  const briefRoot = mkdtempSync(join(tmpdir(), 'cos-routines-brief-'))
  roots.push(h.root, briefRoot)
  // The brief shares the fake coordinator, so one job store answers for every routine.
  brief = new MorningBriefScheduler({
    paths: morningBriefPaths(briefRoot),
    submit: async request => {
      const job = fakeSnapshot(randomUUID(), request, h.now())
      h.fake.jobs.set(job.jobId, job)
      h.fake.submissions.push(request)
      return { job, created: true }
    },
    findByClientGeneration: async clientJobId => [...h.fake.jobs.values()].find(job => job.clientJobId === clientJobId),
    getSnapshot: h.deps.getSnapshot,
    createSession: () => `brief-${randomUUID()}`,
    currentMessageEra: () => 'era-test',
    currentMessageMax: () => 41,
    ownerName: () => 'Jun',
    durableJobsEnabled: () => true,
    admissionsOpen: () => true,
    now: h.now,
    log: () => undefined,
  })
  brief.updateConfig({ timezone: CHICAGO })
  const registry = new RoutineRegistry(() => brief, () => h.scheduler)
  const app = express()
  app.use(express.json())
  app.use('/api', createRoutinesRouter(() => registry, () => [...h.skills].map(name => ({ name, slash: `/${name}`, description: `${name} skill`, group: 'WORKSPACE', where: 'workspace' as const }))))
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
})
afterEach(async () => {
  h.scheduler.stop(); brief.stop()
  await new Promise(resolve => server.close(resolve))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

describe('/api/routines', () => {
  it('lists the morning brief first, with its schedule, its stops, and no delete', async () => {
    const list = await call('GET', '/routines')
    expect(list.status).toBe(200)
    expect(list.json.protocolVersion).toBe(1)
    expect(list.json.masterSwitch).toBe(true)
    expect(list.json.limits).toMatchObject({ maxRoutines: 12, defaultModel: 'sonnet' })
    expect(list.json.routines).toHaveLength(1)
    expect(list.json.routines[0]).toMatchObject({
      id: 'morning-brief', kind: 'morning-brief', name: 'Morning brief', enabled: true, time: '07:00', timezone: CHICAGO, days: [1, 2, 3, 4, 5],
      limits: { scheduledPerDay: 1, runNowPerDay: 5, submitAttemptsPerDay: 3 },
    })
    expect(list.json.routines[0].sourcesOn).toEqual(['calendar', 'meetings', 'tasks', 'waiting'])
    expect((await call('DELETE', '/routines/morning-brief')).json.error.code).toBe('cannot_delete_brief')
  })

  it('an edit to the brief through /api/routines writes the brief config, and refuses a field it does not take', async () => {
    const edited = await call('PATCH', '/routines/morning-brief', { time: '06:30', days: [1, 3, 5] })
    expect(edited.status).toBe(200)
    expect(edited.json.routine).toMatchObject({ time: '06:30', days: [1, 3, 5] })
    expect(brief.getConfig()).toMatchObject({ time: '06:30', days: [1, 3, 5] })
    expect((await call('PATCH', '/routines/morning-brief', { dailyCap: 3 })).json.error.code).toBe('not_a_brief_field')
    expect((await call('PATCH', '/routines/morning-brief', { time: '6pm' })).json.error.code).toBe('invalid_time')
    const paused = await call('POST', '/routines/morning-brief/pause')
    expect(paused.json.routine.enabled).toBe(false)
    expect(brief.getConfig().enabled).toBe(false)
  })

  it('lists the workspace skills a routine can run, labels only', async () => {
    const skills = await call('GET', '/routines/skills')
    expect(skills.json.skills.map((s: { name: string }) => s.name).sort()).toEqual(['good-morning', 'reflect', 'tableau-report'])
    expect(JSON.stringify(skills.json)).not.toContain('/Users/')
  })

  it('create, edit, pause, resume, Run now, history and delete', async () => {
    const made = await call('POST', '/routines', { skill: 'tableau-report', name: 'Funnel pulse', time: '08:00', days: [2], timezone: CHICAGO, dailyCap: 3 })
    expect(made.status).toBe(201)
    const id = made.json.routine.id
    expect(made.json.routine).toMatchObject({ kind: 'skill', name: 'Funnel pulse', skill: 'tableau-report', model: 'sonnet', gate: 'ready', today: { runs: 0, cap: 3 }, lastRun: null })
    expect(made.json.routine.nextRunAt).toBe(new Date(SLOT_8AM).toISOString())
    expect((await call('POST', '/routines', { skill: 'nope' })).json.error.code).toBe('unknown_skill')
    expect((await call('PATCH', `/routines/${id}`, { dailyCap: 0 })).status).toBe(400)
    expect((await call('PATCH', `/routines/${id}`, { time: '07:45' })).json.routine.time).toBe('07:45')
    expect((await call('POST', `/routines/${id}/pause`)).json.routine).toMatchObject({ enabled: false, gate: 'disabled', nextRunAt: null })
    expect((await call('POST', `/routines/${id}/resume`)).json.routine.enabled).toBe(true)
    const ran = await call('POST', `/routines/${id}/run`)
    expect(ran.status).toBe(202)
    expect(ran.json.run).toMatchObject({ routineId: id, trigger: 'manual' })
    expect((await call('POST', `/routines/${id}/run`)).json.error.code).toBe('routine_in_progress')
    h.finish(ran.json.run.jobId, 'completed', 'Liquor leads up 4 percent')
    const history = await call('GET', `/routines/${id}/runs`)
    expect(history.json.runs[0]).toMatchObject({ status: 'completed', preview: 'Liquor leads up 4 percent' })
    expect((await call('GET', `/routines/${id}`)).json.routine.lastRun.status).toBe('completed')
    expect((await call('DELETE', `/routines/${id}`)).status).toBe(204)
    expect((await call('GET', `/routines/${id}`)).status).toBe(404)
    expect((await call('GET', '/routines/not-an-id')).status).toBe(404)
  })

  it('journey: two routines run on schedule; a forced failure trips one breaker and stops it, the other keeps running', async () => {
    const a = (await call('POST', '/routines', { skill: 'good-morning', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6], timezone: CHICAGO })).json.routine.id
    const b = (await call('POST', '/routines', { skill: 'reflect', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6], timezone: CHICAGO, breaker: { failures: 2, cooldownMinutes: 1500 } })).json.routine.id
    for (let day = 0; day < 3; day++) {
      h.setNow(SLOT_8AM + day * 86_400_000)
      const tick = await h.scheduler.tick()
      for (const id of tick.fired) {
        const job = h.jobOf(id).at(-1)!
        const snap = [...h.fake.jobs.values()].find(j => j.clientJobId === job.clientJobId)!
        h.finish(snap.jobId, id === b ? 'failed' : 'completed')
      }
      await h.scheduler.tick()
    }
    expect(h.jobOf(a)).toHaveLength(3)
    expect(h.jobOf(b)).toHaveLength(2)
    const list = (await call('GET', '/routines')).json.routines
    expect(list.map((r: { id: string }) => r.id)).toEqual(['morning-brief', a, b])
    const rb = list.find((r: { id: string }) => r.id === b)
    const ra = list.find((r: { id: string }) => r.id === a)
    expect(rb).toMatchObject({ gate: 'breaker_open', nextRunAt: null, breakerState: { state: 'open', consecutiveFailures: 2 } })
    expect(ra).toMatchObject({ gate: 'ready', breakerState: { state: 'closed' }, lastRun: { status: 'completed' } })
    const refused = await call('POST', `/routines/${b}/run`)
    expect(refused.status).toBe(423)
    expect(refused.json.error).toMatchObject({ code: 'breaker_open' })
    expect(refused.json.error.openUntil).toBeTruthy()
    // Reset from any surface, then it runs again.
    expect((await call('PATCH', `/routines/${b}`, { resetBreaker: true })).json.routine.breakerState.state).toBe('closed')
    expect((await call('POST', `/routines/${b}/run`)).status).toBe(202)
  })
})
