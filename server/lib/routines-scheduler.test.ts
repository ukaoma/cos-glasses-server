import { readFileSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ROUTINE_LIMITS, routineScheduledClientJobId } from './routines-config.js'
import { RoutineRunError } from './routines-scheduler.js'
import { CHICAGO, SLOT_8AM, routineHarness } from './__fixtures__/routines-harness.js'

let h: ReturnType<typeof routineHarness>
beforeEach(() => { h = routineHarness() })
afterEach(() => { h.scheduler.stop(); rmSync(h.root, { recursive: true, force: true }) })

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

async function create(extra: Record<string, unknown> = {}) {
  return h.scheduler.create({ skill: 'good-morning', timezone: CHICAGO, time: '08:00', days: [0, 1, 2, 3, 4, 5, 6], ...extra })
}

describe('routine scheduler: firing on schedule', () => {
  it('fires a routine at its slot, once, as a durable job labelled with the routine and pinned to sonnet', async () => {
    const r = await create()
    h.setNow(SLOT_8AM - 60_000)
    expect((await h.scheduler.tick()).skipped[r.id]).toBe('before_slot')
    h.setNow(SLOT_8AM)
    const first = await h.scheduler.tick()
    expect(first.fired).toEqual([r.id])
    const sent = h.fake.submissions[0]
    expect(sent.origin).toEqual({ kind: 'routine', id: r.id })
    expect(sent.model).toBe('sonnet')
    expect(sent.clientJobId).toBe(routineScheduledClientJobId(r.id, '2026-09-01', CHICAGO))
    expect(String(sent.query)).toContain('Run the /good-morning skill')
    expect(String(sent.query)).toContain('Do not send email')
    h.advance(60_000)
    expect((await h.scheduler.tick()).skipped[r.id]).toBe('already_fired')
    expect(h.fake.submissions).toHaveLength(1)
  })

  it('runs two routines on their own schedules in the same tick', async () => {
    const a = await create()
    const b = await create({ skill: 'tableau-report', time: '08:00' })
    const late = await create({ skill: 'reflect', time: '09:30' })
    const result = await h.scheduler.tick()
    expect(result.fired.sort()).toEqual([a.id, b.id].sort())
    expect(result.skipped[late.id]).toBe('before_slot')
    h.setNow(SLOT_8AM + 90 * 60_000)
    expect((await h.scheduler.tick()).fired).toEqual([late.id])
  })

  it('names the model a routine asks for instead of the default', async () => {
    await create({ model: 'haiku', effort: 'xhigh' })
    await h.scheduler.tick()
    expect(h.fake.submissions[0].model).toBe('haiku')
    expect(h.fake.submissions[0].effort).toBe('xhigh')
  })

  it('stays quiet on a day it is not set for, and when switched off', async () => {
    const r = await create({ days: [3] })
    expect((await h.scheduler.tick()).skipped[r.id]).toBe('not_a_brief_day')
    await h.scheduler.update(r.id, { days: [2], enabled: false })
    expect((await h.scheduler.tick()).skipped[r.id]).toBe('disabled')
    expect(h.fake.submissions).toHaveLength(0)
  })

  it('is inert with the master switch off, Background jobs off, or maintenance', async () => {
    await create()
    h.setMaster(false)
    expect((await h.scheduler.tick()).reason).toBe('routines_off')
    h.setMaster(true); h.setDurable(false)
    expect((await h.scheduler.tick()).reason).toBe('durable_jobs_off')
    h.setDurable(true); h.setAdmissions(false)
    expect((await h.scheduler.tick()).reason).toBe('admissions_closed')
    expect(h.fake.submissions).toHaveLength(0)
  })

  it('adopts a job already admitted for the slot instead of submitting a second one', async () => {
    const r = await create()
    await h.scheduler.tick()
    // A restart that lost the ledger: the coordinator still holds the slot's identity.
    rmSync(h.deps.paths.runs, { force: true })
    const second = h.make()
    h.advance(60_000)
    const result = await second.tick()
    expect(result.fired).toEqual([r.id])
    expect(h.fake.submissions).toHaveLength(1)
    expect(h.logs.some(line => line.startsWith(`adopted ${r.id}`))).toBe(true)
  })
})

describe('routine scheduler: the daily cap', () => {
  it('counts Run now and the scheduled run together, and refuses past the cap', async () => {
    const r = await create({ dailyCap: 2 })
    h.setNow(SLOT_8AM - 2 * HOUR)
    const run = await h.scheduler.runNow(r.id)
    h.finish(run.jobId!, 'completed')
    const second = await h.scheduler.runNow(r.id)
    h.finish(second.jobId!, 'completed')
    await expect(h.scheduler.runNow(r.id)).rejects.toMatchObject({ status: 429, code: 'daily_cap_reached' })
    h.setNow(SLOT_8AM)
    expect((await h.scheduler.tick()).skipped[r.id]).toBe('daily_cap_reached')
    expect(h.fake.submissions).toHaveLength(2)
    // A new local day resets it.
    h.setNow(SLOT_8AM + DAY)
    expect((await h.scheduler.tick()).fired).toEqual([r.id])
  })

  it('does not count a failed submit against the cap', async () => {
    const r = await create({ dailyCap: 1, breaker: { failures: 5 } })
    h.setNow(SLOT_8AM - HOUR)
    h.fake.failNext.push({ code: 'store_degraded', message: 'no' })
    await expect(h.scheduler.runNow(r.id)).rejects.toMatchObject({ status: 503, code: 'store_degraded' })
    const ok = await h.scheduler.runNow(r.id)
    expect(ok.jobId).toBeTruthy()
  })

  it('stops at the server-wide ceiling across every routine', async () => {
    const ids: string[] = []
    for (let i = 0; i < 12; i++) ids.push((await create({ dailyCap: 10, skill: ['good-morning', 'reflect', 'tableau-report'][i % 3] })).id)
    h.setNow(SLOT_8AM - 3 * HOUR)
    let admitted = 0
    let refused: unknown = null
    outer: for (let round = 0; round < 10; round++) {
      for (const id of ids) {
        try {
          const run = await h.scheduler.runNow(id)
          h.finish(run.jobId!, 'completed')
          admitted++
        } catch (error) { refused = error; break outer }
      }
    }
    expect(admitted).toBe(ROUTINE_LIMITS.globalRunsPerDay)
    expect(refused).toMatchObject({ status: 429, code: 'global_cap_reached' })
  })

  it('refuses a second Run now while one is still running', async () => {
    const r = await create()
    h.setNow(SLOT_8AM - HOUR)
    await h.scheduler.runNow(r.id)
    await expect(h.scheduler.runNow(r.id)).rejects.toMatchObject({ status: 409, code: 'routine_in_progress' })
  })
})

describe('routine scheduler: the breaker', () => {
  it('opens after N consecutive failed runs, stops the routine, then allows one trial after the cooldown', async () => {
    const r = await create({ dailyCap: 10, breaker: { failures: 3, cooldownMinutes: 240 } })
    h.setNow(SLOT_8AM - 3 * HOUR)
    for (let i = 0; i < 3; i++) {
      const run = await h.scheduler.runNow(r.id)
      h.finish(run.jobId!, 'failed')
      await h.scheduler.tick()
    }
    const view = await h.scheduler.get(r.id)
    expect(view.breakerState.state).toBe('open')
    expect(view.breakerState.consecutiveFailures).toBe(3)
    expect(view.gate).toBe('breaker_open')
    expect(view.nextRunAt).toBeNull()
    await expect(h.scheduler.runNow(r.id)).rejects.toMatchObject({ status: 423, code: 'breaker_open' })
    h.setNow(SLOT_8AM)
    expect((await h.scheduler.tick()).skipped[r.id]).toBe('breaker_open')
    expect(h.jobOf(r.id)).toHaveLength(3)
    // Cooldown over: half open, one trial; a success closes it.
    h.setNow(SLOT_8AM - 3 * HOUR + 241 * 60_000)
    expect((await h.scheduler.get(r.id)).breakerState.state).toBe('half_open')
    const trial = await h.scheduler.runNow(r.id)
    h.finish(trial.jobId!, 'completed')
    await h.scheduler.tick()
    expect((await h.scheduler.get(r.id)).breakerState).toMatchObject({ state: 'closed', consecutiveFailures: 0 })
  })

  it('a failed trial after the cooldown opens it again at once', async () => {
    const r = await create({ dailyCap: 10, breaker: { failures: 2, cooldownMinutes: 30 } })
    h.setNow(SLOT_8AM - 3 * HOUR)
    for (let i = 0; i < 2; i++) {
      const run = await h.scheduler.runNow(r.id)
      h.finish(run.jobId!, 'interrupted')
      await h.scheduler.tick()
    }
    expect((await h.scheduler.get(r.id)).breakerState.state).toBe('open')
    h.advance(31 * 60_000)
    const trial = await h.scheduler.runNow(r.id)
    h.finish(trial.jobId!, 'failed')
    await h.scheduler.tick()
    expect((await h.scheduler.get(r.id)).breakerState.state).toBe('open')
  })

  it('a success between failures resets the count', async () => {
    const r = await create({ dailyCap: 10, breaker: { failures: 2 } })
    h.setNow(SLOT_8AM - 3 * HOUR)
    for (const status of ['failed', 'completed', 'failed'] as const) {
      const run = await h.scheduler.runNow(r.id)
      h.finish(run.jobId!, status)
      await h.scheduler.tick()
    }
    expect((await h.scheduler.get(r.id)).breakerState).toMatchObject({ state: 'closed', consecutiveFailures: 1 })
  })

  it('a canceled run is neither a success nor a failure', async () => {
    const r = await create({ dailyCap: 10, breaker: { failures: 1 } })
    h.setNow(SLOT_8AM - 3 * HOUR)
    const run = await h.scheduler.runNow(r.id)
    h.finish(run.jobId!, 'canceled')
    await h.scheduler.tick()
    expect((await h.scheduler.get(r.id)).breakerState).toMatchObject({ state: 'closed', consecutiveFailures: 0 })
  })

  it('counts each finished run once, however many ticks read it', async () => {
    const r = await create({ dailyCap: 10, breaker: { failures: 3 } })
    h.setNow(SLOT_8AM - 3 * HOUR)
    const run = await h.scheduler.runNow(r.id)
    h.finish(run.jobId!, 'failed')
    for (let i = 0; i < 5; i++) await h.scheduler.tick()
    expect((await h.scheduler.get(r.id)).breakerState.consecutiveFailures).toBe(1)
  })

  it('trips on repeated submit failures at the scheduled slot and stops retrying', async () => {
    const r = await create({ breaker: { failures: 3, cooldownMinutes: 60 } })
    for (let i = 0; i < 5; i++) h.fake.failNext.push({ code: 'store_degraded', message: 'store down' })
    for (let i = 0; i < 3; i++) {
      await h.scheduler.tick()
      h.advance(ROUTINE_LIMITS.attemptSpacingMs + 1_000)
    }
    const view = await h.scheduler.get(r.id)
    expect(view.breakerState.state).toBe('open')
    expect(view.breakerState.lastFailure?.code).toBe('store_degraded')
    expect((await h.scheduler.tick()).skipped[r.id]).toBe('breaker_open')
    expect(h.fake.failNext).toHaveLength(2)
  })

  it('resetBreaker closes it, and the breaker survives a restart', async () => {
    const r = await create({ dailyCap: 10, breaker: { failures: 1, cooldownMinutes: 600 } })
    h.setNow(SLOT_8AM - 3 * HOUR)
    const run = await h.scheduler.runNow(r.id)
    h.finish(run.jobId!, 'failed')
    await h.scheduler.tick()
    const restarted = h.make()
    expect(restarted.breakerOpen(r.id)).toBe(true)
    await restarted.update(r.id, { resetBreaker: true })
    expect(restarted.breakerOpen(r.id)).toBe(false)
    expect(JSON.parse(readFileSync(h.deps.paths.routines, 'utf8')).breakers[r.id]).toBeUndefined()
  })
})

describe('routine scheduler: config and refusals', () => {
  it('refuses a skill that is not in the workspace, and a routine past the limit', async () => {
    await expect(h.scheduler.create({ skill: 'not-a-skill' })).rejects.toMatchObject({ code: 'unknown_skill' })
    for (let i = 0; i < ROUTINE_LIMITS.maxRoutines; i++) await create()
    await expect(create()).rejects.toMatchObject({ code: 'too_many_routines', status: 409 })
  })

  it('a routine whose skill disappeared does not run', async () => {
    const r = await create()
    h.skills.delete('good-morning')
    await expect(h.scheduler.runNow(r.id)).rejects.toMatchObject({ code: 'skill_missing' })
    expect((await h.scheduler.get(r.id)).gate).toBe('skill_missing')
  })

  it('Run now says why when routines are off', async () => {
    const r = await create()
    h.setMaster(false)
    await expect(h.scheduler.runNow(r.id)).rejects.toBeInstanceOf(RoutineRunError)
    await expect(h.scheduler.runNow(r.id)).rejects.toMatchObject({ code: 'routines_off' })
    h.setMaster(true); h.setDurable(false)
    await expect(h.scheduler.runNow(r.id)).rejects.toMatchObject({ code: 'durable_jobs_off' })
  })

  it('edits keep the id and creation time; delete removes the routine and its breaker', async () => {
    const r = await create()
    h.advance(60_000)
    const edited = await h.scheduler.update(r.id, { name: 'Morning numbers', time: '06:15', dailyCap: 4 })
    expect(edited).toMatchObject({ id: r.id, createdAt: r.createdAt, name: 'Morning numbers', time: '06:15', dailyCap: 4 })
    await h.scheduler.remove(r.id)
    expect(h.scheduler.routines()).toHaveLength(0)
    await expect(h.scheduler.get(r.id)).rejects.toMatchObject({ code: 'routine_not_found', status: 404 })
  })

  it('holds the message number of a run not yet projected, and lets it go once terminal', async () => {
    const r = await create()
    await h.scheduler.tick()
    expect(h.scheduler.liveReservations('era-test')).toEqual([{ globalMsgNum: 42, messageEra: 'era-test', owner: `routine:${r.id}:2026-09-01` }])
    h.finish(h.fake.submissions.length ? [...h.fake.jobs.keys()][0] : '', 'completed')
    await h.scheduler.tick()
    expect(h.scheduler.liveReservations('era-test')).toEqual([])
  })
})
