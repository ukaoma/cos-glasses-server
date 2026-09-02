// Morning brief — what each source can actually reach, and what a run produced.
//
// The Sources list names an INSTRUCTION ("Meetings", "Knowledge graph"); the
// server can also say how deep the well is behind it: 2,312 meetings stored,
// 6,705 memories and 66 threads, the /good-morning skill found under
// .claude/skills. Miles (2026-09-01): "I'm assuming we should see all of these
// stats when we turn it on." Those are the same numbers COS Control's Activity
// tiles show, read from the same places, so the card agrees with the tiles.
//
// Two halves, both pure over injected probes so tests never touch a venv:
//  - coverage: per-source state + one summary line, probes cached for a few
//    minutes (they walk the meeting library and shell to the Python bridge);
//  - section outcomes: after a run, which sections the answer actually opened,
//    which came back "<Section>: unavailable", and which were silently skipped.
//
// A source the server cannot see at all (Slack, health, dashboards) is
// `runtime`: the COS brain resolves it when the brief runs. That is a fact,
// not a failure, and the summary says so instead of showing a dash.

import type { MorningBriefConfig, MorningBriefSource, MorningBriefSourceId } from './morning-brief-config.js'
import { MORNING_BRIEF_SOURCES } from './morning-brief-config.js'
import { sectionInstruction } from './morning-brief-prompt.js'

export type MorningBriefCoverageState = 'ready' | 'empty' | 'unavailable' | 'runtime'

export interface MorningBriefSourceCoverage {
  id: MorningBriefSourceId
  state: MorningBriefCoverageState
  /** One line for a settings row. Never a path, never a prompt. */
  summary: string
  counts?: Record<string, number>
}

export interface MorningBriefCoverage {
  checkedAt: string
  ttlMs: number
  sources: MorningBriefSourceCoverage[]
}

export interface MeetingsProbe { count: number; newestMonth: string | null; layout: string }
export interface ContextProbe {
  memory: { available: boolean; total: number; state?: string }
  threads: { available: boolean; total: number; active?: number; state?: string }
}
export interface CalendarProbe { todayCount: number; source?: string }
export interface TasksProbe { open: number; files: number }
export interface ReflectionProbe { entries: number; newestAt: string | null }
export interface SkillProbe { found: boolean; where?: string }

/** Every probe is optional: a standalone install has none of the pipeline
 * ones, and `null` means "the server cannot see this" (runtime), not zero. */
export interface MorningBriefCoverageProbes {
  meetings?: () => MeetingsProbe | null
  context?: () => Promise<ContextProbe | null>
  calendar?: () => Promise<CalendarProbe | null>
  tasks?: () => Promise<TasksProbe | null>
  reflection?: () => ReflectionProbe | null
  skill?: (name: string) => SkillProbe
}

export const MORNING_BRIEF_COVERAGE_TTL_MS = 5 * 60_000
export const MORNING_BRIEF_COVERAGE_PROBE_TIMEOUT_MS = 8_000

interface ProbeResults {
  meetings: MeetingsProbe | null | undefined
  context: ContextProbe | null | undefined
  calendar: CalendarProbe | null | undefined
  tasks: TasksProbe | null | undefined
  reflection: ReflectionProbe | null | undefined
}

function n(value: number): string {
  return Math.max(0, Math.trunc(value)).toLocaleString('en-US')
}

function plural(count: number, unit: string): string {
  return `${n(count)} ${unit}${count === 1 ? '' : 's'}`
}

function str(options: MorningBriefSource['options'], key: string): string {
  const value = options[key]
  return typeof value === 'string' ? value.trim() : ''
}

function monthLabel(month: string | null): string {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return ''
  const [y, m] = month.split('-').map(Number)
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return names[m - 1] ? `${names[m - 1]} ${y}` : ''
}

function dayLabel(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${names[d.getUTCMonth()]} ${d.getUTCDate()}`
}

function unavailableReason(state?: string): string {
  switch (state) {
    case 'qdrant_unavailable': return 'memory store unreachable'
    case 'bridge_error': return 'pipeline bridge failed'
    case 'bridge_missing': return 'pipeline bridge missing'
    case 'thread_store_unavailable': return 'thread store unreachable'
    default: return state ? state.replace(/_/g, ' ') : 'unreachable'
  }
}

const RUNTIME_SUMMARY: Record<'waiting' | 'health' | 'pulse', string> = {
  waiting: 'Slack, email, and chat connectors are read by your COS when the brief runs.',
  health: 'Any connected health source (Oura or similar) is read when the brief runs.',
  pulse: 'Dashboards and metrics connectors are read when the brief runs.',
}

/** The coverage row for one source, from probe results already gathered. */
export function describeSourceCoverage(
  source: MorningBriefSource,
  probes: ProbeResults,
  skillProbe?: (name: string) => SkillProbe,
): MorningBriefSourceCoverage {
  const o = source.options
  switch (source.id) {
    case 'calendar': {
      const probe = probes.calendar
      if (probe === undefined || probe === null) {
        return { id: source.id, state: 'runtime', summary: 'Calendars are read through your COS connectors when the brief runs.' }
      }
      const counts = { today: probe.todayCount }
      if (probe.todayCount > 0) {
        return { id: source.id, state: 'ready', summary: `${plural(probe.todayCount, 'event')} on today's calendar${probe.source ? ` (${probe.source.replace(/_/g, ' ')})` : ''}.`, counts }
      }
      return { id: source.id, state: 'empty', summary: 'Calendar reachable; nothing on it today.', counts }
    }
    case 'meetings': {
      const probe = probes.meetings
      if (probe === undefined || probe === null) {
        return { id: source.id, state: 'empty', summary: 'No meeting library configured yet.' }
      }
      const counts = { stored: probe.count }
      if (probe.count > 0) {
        const newest = monthLabel(probe.newestMonth)
        return { id: source.id, state: 'ready', summary: `${plural(probe.count, 'meeting')} stored${newest ? `, newest ${newest}` : ''}.`, counts }
      }
      return { id: source.id, state: 'empty', summary: 'Meeting library is empty so far.', counts }
    }
    case 'tasks': {
      const probe = probes.tasks
      if (probe === undefined || probe === null) {
        return { id: source.id, state: 'runtime', summary: 'Task files in your workspace are read when the brief runs.' }
      }
      const counts = { open: probe.open, files: probe.files }
      if (probe.open > 0) {
        return { id: source.id, state: 'ready', summary: `${plural(probe.open, 'open task')} across ${plural(probe.files, 'task file')}.`, counts }
      }
      return { id: source.id, state: 'empty', summary: 'Task files reachable; nothing open.', counts }
    }
    case 'waiting':
      return { id: source.id, state: 'runtime', summary: RUNTIME_SUMMARY.waiting }
    case 'knowledge': {
      const probe = probes.context
      if (probe === undefined || probe === null) {
        return { id: source.id, state: 'empty', summary: 'No memory or thread store yet; this section skips itself.' }
      }
      const memoryOk = probe.memory.available
      const threadsOk = probe.threads.available
      const counts = { memories: probe.memory.total, threads: probe.threads.total, activeThreads: probe.threads.active ?? 0 }
      if (!memoryOk && !threadsOk) {
        return { id: source.id, state: 'unavailable', summary: `Memory and threads unreachable (${unavailableReason(probe.memory.state)}).`, counts }
      }
      const parts: string[] = []
      if (memoryOk) parts.push(plural(probe.memory.total, 'memory').replace('memorys', 'memories'))
      else parts.push(`memories ${unavailableReason(probe.memory.state)}`)
      if (threadsOk) {
        const active = probe.threads.active ?? 0
        parts.push(`${plural(probe.threads.total, 'thread')}${active > 0 ? ` (${n(active)} active)` : ''}`)
      } else {
        parts.push(`threads ${unavailableReason(probe.threads.state)}`)
      }
      const total = (memoryOk ? probe.memory.total : 0) + (threadsOk ? probe.threads.total : 0)
      return {
        id: source.id,
        state: total > 0 ? (memoryOk && threadsOk ? 'ready' : 'unavailable') : 'empty',
        summary: `${parts.join(' · ')}.`,
        counts,
      }
    }
    case 'reflection': {
      const probe = probes.reflection
      if (probe === undefined || probe === null) {
        return { id: source.id, state: 'runtime', summary: 'Journals and reflection logs in your workspace are read when the brief runs.' }
      }
      const counts = { entries: probe.entries }
      if (probe.entries > 0) {
        const newest = dayLabel(probe.newestAt)
        return { id: source.id, state: 'ready', summary: `${plural(probe.entries, 'reflection')} on record${newest ? `, newest ${newest}` : ''}.`, counts }
      }
      return { id: source.id, state: 'empty', summary: 'Reflection log present but empty.', counts }
    }
    case 'health':
      return { id: source.id, state: 'runtime', summary: RUNTIME_SUMMARY.health }
    case 'reading': {
      const text = str(o, 'text') || 'proverbs'
      return text.toLowerCase() === 'proverbs'
        ? { id: source.id, state: 'ready', summary: 'Public-domain KJV Proverbs, one chapter per calendar day. Nothing to connect.' }
        : { id: source.id, state: 'ready', summary: `Public-domain reading from "${text}", matched to the date.` }
    }
    case 'pulse':
      return { id: source.id, state: 'runtime', summary: str(o, 'instruction') ? `${RUNTIME_SUMMARY.pulse} Instruction set.` : RUNTIME_SUMMARY.pulse }
    case 'skill': {
      const name = str(o, 'name')
      if (!name) return { id: source.id, state: 'empty', summary: 'Name a skill to run as this section.' }
      const slash = name.startsWith('/') ? name : `/${name}`
      if (!skillProbe) return { id: source.id, state: 'runtime', summary: `${slash} is looked up in the workspace when the brief runs.` }
      const probe = skillProbe(name)
      return probe.found
        ? { id: source.id, state: 'ready', summary: `${slash} found under ${probe.where ?? 'the workspace'}.` }
        : { id: source.id, state: 'unavailable', summary: `${slash} not found under .claude/skills, .agents/skills, .claude/commands, or ~/.codex/prompts.` }
    }
    case 'custom': {
      const instruction = str(o, 'instruction')
      return instruction
        ? { id: source.id, state: 'ready', summary: 'Runs as written.' }
        : { id: source.id, state: 'empty', summary: 'Write an instruction to add this section.' }
    }
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    timer.unref?.()
    work.then(value => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(null) })
  })
}

export interface MorningBriefCoverageServiceOptions {
  now?: () => number
  ttlMs?: number
  probeTimeoutMs?: number
  log?: (line: string) => void
}

/**
 * Cached probe results + per-call source rows. The probes are the expensive
 * part (a library walk, a Python shell-out); the rows are recomputed on every
 * call from the CURRENT config so a renamed skill or a cleared instruction is
 * reflected immediately without re-probing.
 */
export class MorningBriefCoverageService {
  private cache: { at: number; results: ProbeResults } | null = null
  private inFlight: Promise<ProbeResults> | null = null
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly probeTimeoutMs: number

  constructor(private readonly probes: MorningBriefCoverageProbes, options: MorningBriefCoverageServiceOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? MORNING_BRIEF_COVERAGE_TTL_MS
    this.probeTimeoutMs = options.probeTimeoutMs ?? MORNING_BRIEF_COVERAGE_PROBE_TIMEOUT_MS
  }

  invalidate(): void {
    this.cache = null
  }

  async describe(config: MorningBriefConfig, force = false): Promise<MorningBriefCoverage> {
    const results = await this.results(force)
    const sources = config.sources.map(source => describeSourceCoverage(source, results, this.probes.skill))
    return { checkedAt: new Date(this.cache?.at ?? this.now()).toISOString(), ttlMs: this.ttlMs, sources }
  }

  private results(force: boolean): Promise<ProbeResults> {
    if (!force && this.cache && this.now() - this.cache.at < this.ttlMs) return Promise.resolve(this.cache.results)
    if (this.inFlight) return this.inFlight
    this.inFlight = this.probeAll().then(results => {
      this.cache = { at: this.now(), results }
      return results
    }).finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async probeAll(): Promise<ProbeResults> {
    const sync = <T>(fn: (() => T | null) | undefined): T | null | undefined => {
      if (!fn) return undefined
      try { return fn() } catch { return null }
    }
    const async = <T>(fn: (() => Promise<T | null>) | undefined): Promise<T | null | undefined> => {
      if (!fn) return Promise.resolve(undefined)
      let started: Promise<T | null>
      try { started = fn() } catch { return Promise.resolve(null) }
      return withTimeout(started, this.probeTimeoutMs)
    }
    const [context, calendar, tasks] = await Promise.all([
      async(this.probes.context),
      async(this.probes.calendar),
      async(this.probes.tasks),
    ])
    return {
      meetings: sync(this.probes.meetings),
      context,
      calendar,
      tasks,
      reflection: sync(this.probes.reflection),
    }
  }
}

// ── Section outcomes ──────────────────────────────────────────────────────────

export interface MorningBriefSectionRef {
  id: MorningBriefSourceId
  label: string
}

export type MorningBriefSectionState = 'present' | 'unavailable' | 'skipped' | 'missing' | 'pending'

export interface MorningBriefSectionOutcome extends MorningBriefSectionRef {
  state: MorningBriefSectionState
}

const KNOWN_IDS = new Set<MorningBriefSourceId>(MORNING_BRIEF_SOURCES.map(spec => spec.id))

/** Sources that opt out silently when there is nothing behind them. */
const SILENT_SKIP = new Set<MorningBriefSourceId>(['knowledge', 'reflection', 'health'])

/** The sections a brief for `day` will carry, in order, from the config the
 * run was fired with. Stored on the ledger row so a later config change does
 * not rewrite what an old run was asked for. */
export function briefSections(config: MorningBriefConfig, day: string): MorningBriefSectionRef[] {
  const out: MorningBriefSectionRef[] = []
  for (const source of config.sources) {
    if (!source.enabled || !KNOWN_IDS.has(source.id)) continue
    const section = sectionInstruction(source, day)
    if (section) out.push({ id: source.id, label: section.label })
  }
  return out
}

function normalize(line: string): string {
  return line.replace(/[*_#`>]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Read a finished brief back against the sections it was asked for. Purely
 * textual: a label on its own line (or opening one) is "present"; the
 * "<Section>: unavailable" contract from the prompt is "unavailable"; a
 * silent-skip section with no label is "skipped"; anything else is "missing".
 * A skill section has no label in the skill-only prompt, so it is "present"
 * unless the answer says the skill was not found.
 */
export function sectionOutcomes(sections: readonly MorningBriefSectionRef[], answer: string): MorningBriefSectionOutcome[] {
  const lines = answer.split(/\r?\n/).map(normalize).filter(Boolean)
  const text = lines.join('\n')
  return sections.map(section => {
    const label = normalize(section.label)
    if (section.id === 'skill') {
      if (lines.length === 0) return { ...section, state: 'missing' as const }
      const slash = label.replace(/^skill\s+/, '')
      const notFound = new RegExp(`${escapeRegExp(slash)}[^\\n]{0,80}(does not exist|not found|no such skill|could not (?:find|locate)|is not defined)`, 'i')
      const notFoundBefore = new RegExp(`(does not exist|not found|no such skill|could not (?:find|locate))[^\\n]{0,80}${escapeRegExp(slash)}`, 'i')
      return { ...section, state: notFound.test(text) || notFoundBefore.test(text) ? 'unavailable' as const : 'present' as const }
    }
    // The prompt's unavailable line uses a sentence-case name, not the shouted label.
    const unavailable = new RegExp(`^${escapeRegExp(label)}\\s*[:\\-–—]\\s*unavailable`, 'i')
    if (lines.some(line => unavailable.test(line))) return { ...section, state: 'unavailable' as const }
    const opened = lines.some(line => line === label || line.startsWith(`${label}:`) || line.startsWith(`${label} -`) || line.startsWith(`${label} —`))
    if (opened) return { ...section, state: 'present' as const }
    return { ...section, state: SILENT_SKIP.has(section.id) ? 'skipped' as const : 'missing' as const }
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
