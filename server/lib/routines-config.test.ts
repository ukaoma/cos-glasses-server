import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ROUTINE_DEFAULT_MODEL,
  ROUTINE_ID_RE,
  ROUTINE_LIMITS,
  applyRoutinePatch,
  composeSkillRoutinePrompt,
  loadRoutinesFile,
  routinePaths,
  routineScheduledClientJobId,
  routineAuditCaller,
  routinesEnabledByEnv,
  saveRoutinesFile,
} from './routines-config.js'
import { QUERY_JOB_ORIGIN_ID_RE } from './query-job-types.js'
import { KEY_PROFILE_REJECT_CODE } from './key-profile-rejects.js'

const ctx = { now: new Date('2026-09-01T12:00:00Z'), skillExists: (name: string) => ['good-morning', 'customer-marketing:intel'].includes(name) }
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('routine config', () => {
  it('a new routine takes safe defaults: on, weekdays at 08:00, cap 2, breaker 3 failures and 6 h, sonnet', () => {
    const r = applyRoutinePatch(null, { skill: '/good-morning' }, ctx)
    expect(ROUTINE_ID_RE.test(r.id)).toBe(true)
    expect(QUERY_JOB_ORIGIN_ID_RE.test(r.id)).toBe(true)
    expect(r).toMatchObject({
      kind: 'skill', skill: 'good-morning', name: '/good-morning', enabled: true, time: '08:00', days: [1, 2, 3, 4, 5],
      dailyCap: 2, model: ROUTINE_DEFAULT_MODEL, breaker: { failures: 3, cooldownMinutes: 360 },
    })
    expect(ROUTINE_DEFAULT_MODEL).toBe('sonnet')
  })

  it('accepts a namespaced skill and keeps its colon', () => {
    expect(applyRoutinePatch(null, { skill: 'customer-marketing:intel' }, ctx).skill).toBe('customer-marketing:intel')
  })

  it('throws on every bad field instead of keeping the old value', () => {
    const r = applyRoutinePatch(null, { skill: 'good-morning' }, ctx)
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ time: '8am' }, 'invalid_time'],
      [{ time: '24:00' }, 'invalid_time'],
      [{ timezone: 'Mars/Base' }, 'invalid_timezone'],
      [{ days: 'weekdays' }, 'invalid_days'],
      [{ enabled: 'yes' }, 'invalid_enabled'],
      [{ dailyCap: 0 }, 'invalid_daily_cap'],
      [{ dailyCap: ROUTINE_LIMITS.dailyCapMax + 1 }, 'invalid_daily_cap'],
      [{ model: 'gpt-9' }, 'invalid_model'],
      [{ effort: 'turbo' }, 'invalid_effort'],
      [{ breaker: { failures: 0 } }, 'invalid_breaker_failures'],
      [{ breaker: { cooldownMinutes: 1 } }, 'invalid_breaker_cooldown'],
      [{ breaker: 3 }, 'invalid_breaker'],
      [{ skill: '../etc/passwd' }, 'invalid_skill'],
      [{ skill: 'not-here' }, 'unknown_skill'],
      [{ name: 7 }, 'invalid_name'],
    ]
    for (const [patch, code] of bad) expect(() => applyRoutinePatch(r, patch, ctx), JSON.stringify(patch)).toThrow(expect.objectContaining({ code }))
    expect(() => applyRoutinePatch(null, {}, ctx)).toThrow(expect.objectContaining({ code: 'invalid_skill' }))
    expect(() => applyRoutinePatch(null, [], ctx)).toThrow(expect.objectContaining({ code: 'invalid_patch' }))
  })

  it('refuses a key-lane profile for a scheduled routine', () => {
    const r = applyRoutinePatch(null, { skill: 'good-morning' }, ctx)
    expect(() => applyRoutinePatch(r, { model: 'profile:abc' }, ctx)).toThrow(expect.objectContaining({ code: 'invalid_model' }))
    const prior = process.env.COS_KEY_LANES
    process.env.COS_KEY_LANES = '1'
    try {
      expect(() => applyRoutinePatch(r, { model: 'profile:abc' }, ctx)).toThrow(expect.objectContaining({ code: KEY_PROFILE_REJECT_CODE }))
    } finally {
      if (prior === undefined) delete process.env.COS_KEY_LANES; else process.env.COS_KEY_LANES = prior
    }
  })

  it('an empty model goes back to the cheap default, never to the user default', () => {
    const r = applyRoutinePatch(null, { skill: 'good-morning', model: 'opus' }, ctx)
    expect(r.model).toBe('opus')
    expect(applyRoutinePatch(r, { model: '' }, ctx).model).toBe('sonnet')
  })

  it('a damaged file keeps the good routines and drops the unusable ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'cos-routines-cfg-'))
    roots.push(root)
    const paths = routinePaths(root)
    const good = applyRoutinePatch(null, { skill: 'good-morning' }, ctx)
    saveRoutinesFile(paths, { v: 1, routines: [good], breakers: { [good.id]: { consecutiveFailures: 2 } } })
    const raw = JSON.parse(JSON.stringify({ v: 1, routines: [good, { id: 'routine-zz', skill: 'x' }, { ...good, dailyCap: 99, time: 'noon' }], breakers: { [good.id]: { consecutiveFailures: 2 } } }))
    writeFileSync(paths.routines, JSON.stringify(raw))
    const loaded = loadRoutinesFile(paths).file
    expect(loaded.routines).toHaveLength(1)
    expect(loaded.routines[0].dailyCap).toBe(good.dailyCap)
    expect(loaded.breakers[good.id].consecutiveFailures).toBe(2)
    writeFileSync(paths.routines, '{not json')
    const corrupt = loadRoutinesFile(paths)
    expect(corrupt.file.routines).toEqual([])
    expect(corrupt.quarantinedAs).toBeTruthy()
  })

  it('a scheduled client id is fixed per routine, day and zone', () => {
    expect(routineScheduledClientJobId('routine-0000000001', '2026-09-01', 'America/Chicago')).toBe(routineScheduledClientJobId('routine-0000000001', '2026-09-01', 'America/Chicago'))
    expect(routineScheduledClientJobId('routine-0000000001', '2026-09-01', 'America/Chicago')).not.toBe(routineScheduledClientJobId('routine-0000000002', '2026-09-01', 'America/Chicago'))
    expect(routineScheduledClientJobId('routine-0000000001', '2026-09-01', 'America/Chicago')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('the prompt names the skill and keeps the unattended contract', () => {
    const text = composeSkillRoutinePrompt({ name: 'Pulse', skill: 'tableau-report', instruction: 'Focus on Liquor.' }, '2026-09-01', 'Jun', 'scheduled')
    expect(text).toContain('Run the /tableau-report skill')
    expect(text).toContain('Also: Focus on Liquor.')
    expect(text).toContain('Nobody is watching this run.')
    expect(text).toContain('Do not send email, Slack or any message, publish, deploy, push, delete data, or spend money.')
  })

  it('the master switch is on unless explicitly off', () => {
    expect(routinesEnabledByEnv({})).toBe(true)
    expect(routinesEnabledByEnv({ COS_ROUTINES: '1' })).toBe(true)
    for (const off of ['0', 'false', 'off', 'no', ' OFF ']) expect(routinesEnabledByEnv({ COS_ROUTINES: off }), off).toBe(false)
  })
})

describe('routine token-audit caller', () => {
  it('a routine job is counted as routine:<id>; every other job keeps its caller', () => {
    expect(routineAuditCaller({ origin: { kind: 'routine', id: 'morning-brief' } })).toBe('routine:morning-brief')
    expect(routineAuditCaller({ origin: { kind: 'routine', id: 'routine-0123456789' } })).toBe('routine:routine-0123456789')
    expect(routineAuditCaller({ origin: { kind: 'task', id: 'abcdefabcdef' } })).toBe('')
    expect(routineAuditCaller({})).toBe('')
  })
})
