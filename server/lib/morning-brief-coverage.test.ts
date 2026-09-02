import { describe, expect, it } from 'vitest'
import { defaultMorningBriefConfig, applyMorningBriefPatch } from './morning-brief-config.js'
import {
  MorningBriefCoverageService,
  briefSections,
  describeSourceCoverage,
  sectionOutcomes,
} from './morning-brief-coverage.js'

const NOW = Date.UTC(2026, 8, 1, 12, 0)

function config(sources?: Array<Record<string, unknown>>) {
  const base = defaultMorningBriefConfig(new Date(NOW))
  return sources ? applyMorningBriefPatch(base, { sources }, new Date(NOW)) : base
}

const NONE = { meetings: undefined, context: undefined, calendar: undefined, tasks: undefined, reflection: undefined }

describe('describeSourceCoverage', () => {
  it('reports the depth behind meetings, knowledge, calendar, tasks, and reflection when probes answer', () => {
    const probes = {
      meetings: { count: 2312, newestMonth: '2026-09', layout: 'multi_domain' },
      context: { memory: { available: true, total: 6705, state: 'ready' }, threads: { available: true, total: 66, active: 12, state: 'ready' } },
      calendar: { todayCount: 3, source: 'cache_fresh' },
      tasks: { open: 142, files: 4 },
      reflection: { entries: 210, newestAt: '2026-08-31T22:38:00.000Z' },
    }
    const rows = Object.fromEntries(config().sources.map(source => [source.id, describeSourceCoverage(source, probes)]))
    expect(rows.meetings).toMatchObject({ state: 'ready', summary: '2,312 meetings stored, newest Sep 2026.', counts: { stored: 2312 } })
    expect(rows.knowledge).toMatchObject({ state: 'ready', summary: '6,705 memories · 66 threads (12 active).' })
    expect(rows.calendar).toMatchObject({ state: 'ready', summary: "3 events on today's calendar (cache fresh)." })
    expect(rows.tasks).toMatchObject({ state: 'ready', summary: '142 open tasks across 4 task files.' })
    expect(rows.reflection).toMatchObject({ state: 'ready', summary: '210 reflections on record, newest Aug 31.' })
    expect(rows.reading).toMatchObject({ state: 'ready' })
    expect(rows.waiting.state).toBe('runtime')
    expect(rows.health.state).toBe('runtime')
    expect(rows.pulse.state).toBe('runtime')
    for (const row of Object.values(rows)) expect(row.summary).not.toMatch(/\/Users|~\//)
  })

  it('distinguishes empty from unavailable from runtime', () => {
    const emptyMeetings = describeSourceCoverage(config().sources[1], { ...NONE, meetings: { count: 0, newestMonth: null, layout: 'direct' } })
    expect(emptyMeetings.state).toBe('empty')
    const noLibrary = describeSourceCoverage(config().sources[1], { ...NONE, meetings: null })
    expect(noLibrary).toMatchObject({ state: 'empty', summary: 'No meeting library configured yet.' })
    const knowledge = config().sources.find(s => s.id === 'knowledge')!
    const down = describeSourceCoverage(knowledge, { ...NONE, context: { memory: { available: false, total: 0, state: 'qdrant_unavailable' }, threads: { available: false, total: 0, state: 'thread_store_unavailable' } } })
    expect(down).toMatchObject({ state: 'unavailable', summary: 'Memory and threads unreachable (memory store unreachable).' })
    const half = describeSourceCoverage(knowledge, { ...NONE, context: { memory: { available: false, total: 0, state: 'qdrant_unavailable' }, threads: { available: true, total: 66, active: 0 } } })
    expect(half).toMatchObject({ state: 'unavailable', summary: 'memories memory store unreachable · 66 threads.' })
    const calendarRuntime = describeSourceCoverage(config().sources[0], NONE)
    expect(calendarRuntime.state).toBe('runtime')
    const calendarEmpty = describeSourceCoverage(config().sources[0], { ...NONE, calendar: { todayCount: 0 } })
    expect(calendarEmpty.state).toBe('empty')
  })

  it('checks the named skill through the probe and never a path', () => {
    const cfg = config([{ id: 'skill', enabled: true, options: { name: '/good-morning' } }])
    const skill = cfg.sources.find(s => s.id === 'skill')!
    expect(describeSourceCoverage(skill, NONE, () => ({ found: true, where: '.claude/skills' })))
      .toMatchObject({ state: 'ready', summary: '/good-morning found under .claude/skills.' })
    expect(describeSourceCoverage(skill, NONE, () => ({ found: false })).state).toBe('unavailable')
    expect(describeSourceCoverage(skill, NONE).state).toBe('runtime')
    const unnamed = config([{ id: 'skill', enabled: true, options: { name: '' } }]).sources.find(s => s.id === 'skill')!
    expect(describeSourceCoverage(unnamed, NONE).state).toBe('empty')
    const custom = config([{ id: 'custom', enabled: true, options: { instruction: 'Also the weather' } }]).sources.find(s => s.id === 'custom')!
    expect(describeSourceCoverage(custom, NONE).state).toBe('ready')
  })
})

describe('MorningBriefCoverageService', () => {
  it('caches probe results for the TTL, re-probes on force, and bounds a hung probe', async () => {
    let now = NOW
    let meetingsCalls = 0
    let contextCalls = 0
    const service = new MorningBriefCoverageService({
      meetings: () => { meetingsCalls += 1; return { count: 5, newestMonth: '2026-09', layout: 'direct' } },
      context: async () => { contextCalls += 1; return new Promise(() => {}) },
    }, { now: () => now, ttlMs: 60_000, probeTimeoutMs: 20 })
    const first = await service.describe(config())
    expect(first.sources.find(s => s.id === 'meetings')).toMatchObject({ state: 'ready', counts: { stored: 5 } })
    // A hung probe is bounded and read as "cannot see it", never a hang.
    expect(first.sources.find(s => s.id === 'knowledge')!.state).toBe('empty')
    expect(meetingsCalls).toBe(1)
    expect(contextCalls).toBe(1)
    await service.describe(config())
    expect(meetingsCalls).toBe(1)
    now += 61_000
    await service.describe(config())
    expect(meetingsCalls).toBe(2)
    await service.describe(config(), true)
    expect(meetingsCalls).toBe(3)
    expect(first.ttlMs).toBe(60_000)
  })

  it('reflects a config change without re-probing', async () => {
    let calls = 0
    const service = new MorningBriefCoverageService({
      meetings: () => { calls += 1; return { count: 1, newestMonth: null, layout: 'direct' } },
      skill: name => ({ found: name === 'good-morning', where: '.agents/skills' }),
    }, { now: () => NOW })
    const a = await service.describe(config([{ id: 'skill', enabled: true, options: { name: 'good-morning' } }]))
    const b = await service.describe(config([{ id: 'skill', enabled: true, options: { name: 'other' } }]))
    expect(a.sources.find(s => s.id === 'skill')!.state).toBe('ready')
    expect(b.sources.find(s => s.id === 'skill')!.state).toBe('unavailable')
    expect(calls).toBe(1)
  })
})

describe('section outcomes', () => {
  it('lists the enabled sections in order with their prompt labels', () => {
    const sections = briefSections(config(), '2026-09-01')
    expect(sections.map(s => s.id)).toEqual(['calendar', 'meetings', 'tasks', 'waiting'])
    expect(sections[0].label).toBe('CALENDAR')
    expect(sections[3].label).toBe('WAITING ON YOU')
    const skillOnly = briefSections(config([
      { id: 'calendar', enabled: false }, { id: 'meetings', enabled: false }, { id: 'tasks', enabled: false }, { id: 'waiting', enabled: false },
      { id: 'skill', enabled: true, options: { name: '/good-morning' } },
    ]), '2026-09-01')
    expect(skillOnly).toEqual([{ id: 'skill', label: 'SKILL /good-morning' }])
  })

  it('reads present, unavailable, skipped, and missing back from the answer', () => {
    const sections = briefSections(config([
      { id: 'calendar', enabled: true }, { id: 'meetings', enabled: true }, { id: 'tasks', enabled: true },
      { id: 'waiting', enabled: true }, { id: 'knowledge', enabled: true },
    ]), '2026-09-01')
    const answer = [
      'CALENDAR',
      '9:00 Standup',
      '**From recent meetings**',
      'Budget decision Thursday',
      'Waiting on you: unavailable (no Slack connector)',
      'Order your energy: ship the brief.',
    ].join('\n')
    expect(sectionOutcomes(sections, answer).map(s => `${s.id}:${s.state}`)).toEqual([
      'calendar:present', 'meetings:present', 'tasks:missing', 'waiting:unavailable', 'knowledge:skipped',
    ])
  })

  it('treats a skill section as present unless the answer says the skill was not found', () => {
    const sections = [{ id: 'skill' as const, label: 'SKILL /good-morning' }]
    expect(sectionOutcomes(sections, 'Proverbs 1\n1 The proverbs of Solomon...')[0].state).toBe('present')
    expect(sectionOutcomes(sections, 'The /good-morning skill does not exist in this workspace.')[0].state).toBe('unavailable')
    expect(sectionOutcomes(sections, 'Skill not found: /good-morning')[0].state).toBe('unavailable')
    expect(sectionOutcomes(sections, '')[0].state).toBe('missing')
  })
})
