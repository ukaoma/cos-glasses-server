import { describe, expect, it } from 'vitest'
import { applyMorningBriefPatch, defaultMorningBriefConfig, MORNING_BRIEF_LIMITS } from './morning-brief-config.js'
import { MORNING_BRIEF_PROMPT_MAX_CHARS, composeMorningBriefPrompt, sectionInstruction } from './morning-brief-prompt.js'

const base = { ...defaultMorningBriefConfig(new Date('2026-09-01T00:00:00Z')), timezone: 'America/Chicago' }

function compose(overrides: Parameters<typeof applyMorningBriefPatch>[1] = {}, day = '2026-09-01') {
  return composeMorningBriefPrompt({
    config: applyMorningBriefPatch(base, overrides),
    day,
    ownerName: 'Jun',
    trigger: 'scheduled',
  })
}

describe('composeMorningBriefPrompt', () => {
  it('opens with the owner, the weekday, and the SCHEDULED slot, and carries the read-only contract', () => {
    const prompt = compose()
    expect(prompt.startsWith('Morning brief for Jun. Tuesday, September 1, 2026, 07:00 America/Chicago.')).toBe(true)
    expect(prompt).toContain('read-only')
    expect(prompt).toContain('do not ask questions')
    expect(prompt).toContain('unavailable (reason)')
    expect(prompt).toContain('Order your energy:')
  })

  it('numbers the enabled sources in the configured order and skips disabled ones', () => {
    const prompt = compose({
      sources: [
        { id: 'waiting', enabled: true },
        { id: 'calendar', enabled: true },
        { id: 'tasks', enabled: false },
        { id: 'meetings', enabled: false },
      ],
    })
    expect(prompt).toMatch(/1\. WAITING ON YOU\./)
    expect(prompt).toMatch(/2\. CALENDAR\./)
    expect(prompt).not.toContain('DUE.')
    expect(prompt).not.toContain('FROM RECENT MEETINGS')
  })

  it('threads each source window into its instruction', () => {
    const prompt = compose({
      sources: [
        { id: 'meetings', enabled: true, options: { lookbackDays: 2, horizonDays: 10 } },
        { id: 'tasks', enabled: true, options: { horizonDays: 3, includeOverdue: false } },
        { id: 'waiting', enabled: true, options: { lookbackDays: 14 } },
        { id: 'calendar', enabled: true, options: { includeTomorrow: true } },
      ],
    })
    expect(prompt).toContain('last 2 days')
    expect(prompt).toContain('next 10 days')
    expect(prompt).toContain('due within 3 days')
    expect(prompt).not.toContain('overdue items first')
    expect(prompt).toContain('last 14 days')
    expect(prompt).toContain("tomorrow's first commitment")
  })

  it('names the last business day for a Monday brief as the Friday before', () => {
    const prompt = compose({}, '2026-09-07')
    expect(prompt).toContain('last business day before 2026-09-07 was 2026-09-04')
  })

  it('a workspace skill alone becomes the whole brief and keeps its own length', () => {
    const prompt = compose({
      sources: [
        { id: 'skill', enabled: true, options: { name: 'good-morning' } },
        { id: 'calendar', enabled: false },
        { id: 'meetings', enabled: false },
        { id: 'tasks', enabled: false },
        { id: 'waiting', enabled: false },
      ],
    })
    expect(prompt).toContain('1. SKILL /good-morning.')
    expect(prompt).toContain('.agents/skills')
    expect(prompt).toContain('keep it intact rather than trimming it')
    expect(prompt).not.toContain('Sections, in this order')
  })

  it('a skill with no name and a custom section with no instruction contribute nothing', () => {
    expect(sectionInstruction({ id: 'skill', enabled: true, options: { name: '' } }, '2026-09-01')).toBeNull()
    expect(sectionInstruction({ id: 'custom', enabled: true, options: { instruction: '' } }, '2026-09-01')).toBeNull()
  })

  it('the Proverbs reading uses the calendar day as the chapter and insists on KJV', () => {
    const section = sectionInstruction({ id: 'reading', enabled: true, options: { text: 'proverbs' } }, '2026-09-19')
    expect(section?.body).toContain('Proverbs chapter 19')
    expect(section?.body).toContain('King James')
  })

  it('a pulse instruction and a closing instruction are carried verbatim', () => {
    const prompt = compose({
      sources: [{ id: 'pulse', enabled: true, options: { instruction: 'Leads and opps MTD by focus industry' } }],
      closingInstruction: 'Two lines per section, no more.',
    })
    expect(prompt).toContain('Leads and opps MTD by focus industry')
    expect(prompt).toContain('Also: Two lines per section, no more.')
  })

  it('with nothing enabled the agent is told to say so in one line', () => {
    const prompt = compose({
      sources: [
        { id: 'calendar', enabled: false }, { id: 'meetings', enabled: false },
        { id: 'tasks', enabled: false }, { id: 'waiting', enabled: false },
      ],
    })
    expect(prompt).toContain('no sources selected')
  })

  it('a manual run says so, and the prompt is otherwise identical for the same day', () => {
    const config = applyMorningBriefPatch(base, {})
    const scheduled = composeMorningBriefPrompt({ config, day: '2026-09-01', ownerName: 'Jun', trigger: 'scheduled' })
    const manual = composeMorningBriefPrompt({ config, day: '2026-09-01', ownerName: 'Jun', trigger: 'manual' })
    expect(manual).toContain('Requested now rather than on the schedule.')
    expect(manual.replace(' Requested now rather than on the schedule.', '')).toBe(scheduled)
  })

  it('is deterministic for a day and stays far under the durable-job prompt ceiling at the largest legal config', () => {
    const maxed = applyMorningBriefPatch(base, {
      sources: base.sources.map(source => ({
        id: source.id,
        enabled: true,
        options: {
          instruction: 'x'.repeat(MORNING_BRIEF_LIMITS.instructionChars),
          name: 'good-morning',
          text: 'proverbs',
        },
      })),
      closingInstruction: 'y'.repeat(MORNING_BRIEF_LIMITS.instructionChars),
    })
    const a = composeMorningBriefPrompt({ config: maxed, day: '2026-09-01', ownerName: 'Jun', trigger: 'scheduled' })
    const b = composeMorningBriefPrompt({ config: maxed, day: '2026-09-01', ownerName: 'Jun', trigger: 'scheduled' })
    expect(a).toBe(b)
    expect(a.length).toBeLessThan(MORNING_BRIEF_PROMPT_MAX_CHARS)
    expect(a.length).toBeLessThan(48_000)
  })
})
