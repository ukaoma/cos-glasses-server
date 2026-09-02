// Morning brief — the prompt composer.
//
// Pure: config + clock in, one prompt string out. The prompt is what the user's
// own COS agent receives as a durable query job at the scheduled minute, so it
// carries everything the agent needs and nothing the server cannot vouch for:
//
//  - the read-only contract (nobody is watching; never send, create, or edit);
//  - the sections, in the user's order, each with its window and its own
//    "unavailable" rule so a missing connector produces one honest line, not a
//    fabricated one;
//  - the glasses formatting contract (plain text, short labelled lines) so the
//    result renders on a 576x288 lens without a second pass.
//
// Deterministic for a given (config, day): the scheduled slot, not the actual
// firing minute, is what appears in the prompt. That is what lets a retry after
// a crashed submission re-admit as the SAME job by client identity instead of
// conflicting on a different prompt body.

import type { MorningBriefConfig, MorningBriefSource, MorningBriefSourceId } from './morning-brief-config.js'
import { MORNING_BRIEF_SOURCES } from './morning-brief-config.js'
import { parseTime, shiftDay } from './morning-brief-schedule.js'

/** Well under the 48,000-char durable-job ceiling, with room for the largest
 * legal combination of free-text options. */
export const MORNING_BRIEF_PROMPT_MAX_CHARS = 16_000

export interface MorningBriefPromptInput {
  config: MorningBriefConfig
  /** Local calendar day the brief is for (YYYY-MM-DD in config.timezone). */
  day: string
  ownerName: string
  trigger: 'scheduled' | 'manual'
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function describeDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const weekday = WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${weekday}, ${MONTH_NAMES[m - 1]} ${d}, ${y}`
}

function lastBusinessDay(day: string): string {
  let candidate = shiftDay(day, -1)
  for (let i = 0; i < 7; i++) {
    const [y, m, d] = candidate.split('-').map(Number)
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
    if (weekday !== 0 && weekday !== 6) return candidate
    candidate = shiftDay(candidate, -1)
  }
  return candidate
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

function str(options: MorningBriefSource['options'], key: string): string {
  const value = options[key]
  return typeof value === 'string' ? value.trim() : ''
}

function num(options: MorningBriefSource['options'], key: string, fallback: number): number {
  const value = options[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(options: MorningBriefSource['options'], key: string, fallback: boolean): boolean {
  const value = options[key]
  return typeof value === 'boolean' ? value : fallback
}

/** One section's instruction. Returns null when the source has nothing to say
 * (a custom section with no instruction, a skill with no name). */
export function sectionInstruction(source: MorningBriefSource, day: string): { label: string; body: string } | null {
  const o = source.options
  switch (source.id) {
    case 'calendar':
      return {
        label: 'CALENDAR',
        body: [
          `Today's commitments in time order, each on one line: start time, title, who it is with when that matters.`,
          `Name the first commitment of the day and how much open time exists before it.`,
          bool(o, 'includeTomorrow', false) ? `Then tomorrow's first commitment on one line.` : '',
          `Read every calendar this workspace can reach (connectors, local calendar helpers, cached calendar files). If none can be read, write "Calendar: unavailable" with the reason.`,
        ].filter(Boolean).join(' '),
      }
    case 'meetings': {
      const lookback = num(o, 'lookbackDays', 3)
      const horizon = num(o, 'horizonDays', 7)
      return {
        label: 'FROM RECENT MEETINGS',
        body: [
          `Meetings synced in the last ${plural(lookback, 'day')} (the last business day before ${day} was ${lastBusinessDay(day)}).`,
          `Surface only items with a hard edge: a decision that was made, a deadline inside the next ${plural(horizon, 'day')}, a dollar figure, or a named owner.`,
          `Read the meeting's summary and decisions; never paste an extracted action-item list verbatim, and when a number or date matters, quote it from the transcript.`,
          `Three to five items ranked by consequence, one line each: the decision or open question, then the hard edge.`,
          `If nothing decision-grade happened, say so in one line.`,
        ].join(' '),
      }
    }
    case 'tasks': {
      const horizon = num(o, 'horizonDays', 7)
      const overdue = bool(o, 'includeOverdue', true)
      return {
        label: 'DUE',
        body: [
          `Open tasks from this workspace's task files due within ${plural(horizon, 'day')}${overdue ? ', overdue items first' : ''}.`,
          `One line each: the task, its owner if not the wearer, and the date. Cap at seven. Skip anything already marked done.`,
        ].join(' '),
      }
    }
    case 'waiting': {
      const lookback = num(o, 'lookbackDays', 7)
      return {
        label: 'WAITING ON YOU',
        body: [
          `Across every channel this workspace can read (Slack, email, chat connectors), from the last ${plural(lookback, 'day')}:`,
          `direct mentions with no reply from the wearer, questions addressed to the wearer with no answer beneath them, and threads that moved after the wearer's last message.`,
          `Up to five, ranked by consequence. Each line names the channel or sender, who is waiting, and the ask.`,
          `Never claim something is unread; report only what is verifiable. If no channel can be read, write "Waiting on you: unavailable" with the reason.`,
        ].join(' '),
      }
    }
    case 'knowledge': {
      const lookback = num(o, 'lookbackDays', 7)
      return {
        label: 'MOVING',
        body: [
          `From memory, threads, and the knowledge graph this workspace keeps: the two or three relationships, projects, or people that moved in the last ${plural(lookback, 'day')} and why it matters today.`,
          `One line each. Cite the thread or entity by name. Skip this section silently if the workspace has no memory or graph.`,
        ].join(' '),
      }
    }
    case 'reflection':
      return {
        label: 'CARRY THIS',
        body: [
          `From recent reflection logs, journal entries, or correction records in this workspace: the one theme that recurs across at least two periods.`,
          `State the pattern in one line and the single behaviour to carry into today in a second line. Do not grade. Skip silently if there is no reflection history.`,
        ].join(' '),
      }
    case 'health':
      return {
        label: 'BODY',
        body: `Last night's sleep and readiness from any connected health source, one line, with the one adjustment it implies. Skip silently if no health source is connected.`,
      }
    case 'reading': {
      const text = str(o, 'text') || 'proverbs'
      const [, , d] = day.split('-').map(Number)
      if (text.toLowerCase() === 'proverbs') {
        return {
          label: 'OPENING',
          body: [
            `Proverbs chapter ${d} (the calendar day) in the public-domain King James Version, presented as numbered verses.`,
            `Then one verse from it that genuinely speaks to today's shape, named, with a two-sentence connection. Never substitute a copyrighted translation; if the exact KJV text cannot be verified, say so and skip the chapter.`,
          ].join(' '),
        }
      }
      return {
        label: 'OPENING',
        body: `A short public-domain reading from "${text}" matched to today's date, then one line on why it fits. Never reproduce copyrighted text.`,
      }
    }
    case 'pulse': {
      const instruction = str(o, 'instruction')
      return {
        label: 'PULSE',
        body: [
          instruction
            ? `The numbers the wearer steers by: ${instruction}`
            : `The numbers the wearer steers by, from any dashboard, report, or metrics connector this workspace has.`,
          `Use the most recent complete period (yesterday, or the last business day). Render quantitative comparisons as bar fills with a direction glyph and the delta, for example "Grocery 162 ██████████ ▼ -7%".`,
          `Name the strongest positive and the clearest pain. If the source cannot be read, write "Pulse: unavailable" with the reason; never imply data you did not pull.`,
        ].join(' '),
      }
    }
    case 'skill': {
      const name = str(o, 'name')
      if (!name) return null
      const slash = name.startsWith('/') ? name : `/${name}`
      return {
        label: `SKILL ${slash}`,
        body: [
          `Run this workspace's ${slash} skill exactly as it is defined (look under .claude/skills, .agents/skills, .claude/commands, and ~/.codex/prompts) and use its output for this section.`,
          `Do not summarise it away; it was written for this purpose. If the skill does not exist, write one line saying so and continue with the other sections.`,
        ].join(' '),
      }
    }
    case 'custom': {
      const instruction = str(o, 'instruction')
      if (!instruction) return null
      return { label: 'ALSO', body: instruction }
    }
  }
}

const KNOWN_IDS = new Set<MorningBriefSourceId>(MORNING_BRIEF_SOURCES.map(spec => spec.id))

/** Compose the brief prompt. Enabled sources become numbered sections in the
 * user's order; a section whose source has nothing to say is skipped. */
export function composeMorningBriefPrompt(input: MorningBriefPromptInput): string {
  const { config, day, ownerName, trigger } = input
  const slotMinutes = parseTime(config.time)
  const slot = `${String(Math.floor(slotMinutes / 60)).padStart(2, '0')}:${String(slotMinutes % 60).padStart(2, '0')}`
  const sections = config.sources
    .filter(source => source.enabled && KNOWN_IDS.has(source.id))
    .map(source => sectionInstruction(source, day))
    .filter((section): section is { label: string; body: string } => section !== null)

  const skillOnly = sections.length === 1 && sections[0].label.startsWith('SKILL ')

  const lines: string[] = []
  lines.push(`Morning brief for ${ownerName || 'the wearer'}. ${describeDay(day)}, ${slot} ${config.timezone}.${trigger === 'manual' ? ' Requested now rather than on the schedule.' : ''}`)
  lines.push('')
  lines.push(
    'This is the start-of-day brief that waits in the COS Glasses inbox before the wearer opens it. Nobody is watching this run: do not ask questions, do not pause for confirmation, and do not stop early. ' +
    'It is read-only. Do not send messages or email, create or change calendar events, edit tasks, or write files other than any journal or log a skill you run is already designed to keep.',
  )
  lines.push('')
  lines.push(
    'Evidence discipline: every line must come from something you actually read in this workspace or through its connectors. ' +
    'When a source cannot be read, give that section one line, "<Section>: unavailable (reason)", and move on. Never invent a meeting, a message, a number, or a name. ' +
    'An aside is not a finding; include only items with a hard edge (a decision, a date, a dollar figure, an owner).',
  )
  lines.push('')

  if (sections.length === 0) {
    lines.push('No sections are enabled. Reply with exactly one line: "Morning brief: no sources selected. Choose sources in COS Control or the companion app."')
  } else if (skillOnly) {
    lines.push('Content:')
    lines.push(`1. ${sections[0].label}. ${sections[0].body}`)
  } else {
    lines.push('Sections, in this order, each opened by its label on its own line:')
    sections.forEach((section, index) => {
      lines.push(`${index + 1}. ${section.label}. ${section.body}`)
    })
  }
  lines.push('')

  if (config.closingInstruction) {
    lines.push(`Also: ${config.closingInstruction}`)
    lines.push('')
  }

  lines.push(
    'Format for the glasses: plain text only. No markdown headings, tables, or bullet symbols; a section is its label on one line followed by short lines. ' +
    'Keep every line under 60 characters where you can, because the lens is 576 pixels wide and wraps silently. Keep the whole brief under about 60 lines; ' +
    (skillOnly
      ? 'if the skill\'s own output format is longer, keep it intact rather than trimming it.'
      : 'trim from the bottom of each section, not from the top.'),
  )
  lines.push(
    'End with one line beginning "Order your energy:" naming the single posture for the day, grounded in the sections above.',
  )
  lines.push('Do not say "here is" or "I found". Do not add a preamble or a sign-off.')

  const prompt = lines.join('\n')
  return prompt.length > MORNING_BRIEF_PROMPT_MAX_CHARS
    ? `${prompt.slice(0, MORNING_BRIEF_PROMPT_MAX_CHARS - 1)}…`
    : prompt
}
