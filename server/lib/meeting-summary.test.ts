import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  boundTranscriptForSummary,
  buildSummaryPrompt,
  countTranscriptWords,
  extractiveMeetingSummary,
  meetingSummaryBreaker,
  meetingSummaryLLMEnabled,
  parseSummaryResponse,
  parseTranscriptTurns,
  isDiarisationLabel,
  summariseMeeting,
  transcriptSpeakers,
  MAX_SUMMARY_INPUT_CHARS,
  MIN_SUMMARY_WALL_MS,
  MIN_SUMMARY_WORDS,
  SUMMARY_WALL_MS,
} from './meeting-summary.js'
import {
  hasOpsPipelineMarkers,
  spliceMeetingEnrichment,
  writeMeetingEnrichment,
  OPS_PIPELINE_MARKERS,
} from './meeting-summary-persistence.js'
import {
  getMeetingSummaryBudgetState,
  maxDailyMeetingSummaryCalls,
  meetingSummaryBudgetFile,
  DEFAULT_DAILY_MEETING_SUMMARY_CALLS,
} from './meeting-summary-budget.js'

const roots: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cos-mtg-summary-'))
  roots.push(root)
  return root
}

const envKeys = ['COS_MEETING_SUMMARY', 'COS_SCRIPTS_DIR', 'COS_MEETING_SUMMARY_DAILY_CAP'] as const
const previousEnv: Partial<Record<typeof envKeys[number], string | undefined>> = {}

beforeEach(() => {
  for (const key of envKeys) {
    previousEnv[key] = process.env[key]
    delete process.env[key]
  }
  // The breaker is module state shared across cases.
  meetingSummaryBreaker.recordSuccess()
})

afterEach(() => {
  for (const key of envKeys) {
    const value = previousEnv[key]
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A transcript comfortably over MIN_SUMMARY_WORDS. */
function longTranscript(): string {
  const line = 'we walked through the migration timeline and the open billing questions'
  return [
    `[MU]: ${line} ${line}`,
    `[Speaker 2]: ${line}`,
    `[Ext]: ${line} ${line} ${line}`,
  ].join('\n')
}

const VALID_REPLY = JSON.stringify({
  summary: 'The team reviewed the migration timeline and agreed to defer billing changes.',
  topics: ['Migration timeline', 'Billing'],
  decisions: ['Defer billing changes to next quarter'],
  actionItems: [{ task: 'Send the revised timeline', owner: 'MU' }],
})

describe('transcript parsing', () => {
  it('groups wrapped lines into the preceding turn instead of inventing turns', () => {
    const turns = parseTranscriptTurns('[MU]: first line\ncontinued here\n[Ext]: second')
    expect(turns).toHaveLength(2)
    expect(turns[0]).toEqual({ speaker: 'MU', text: 'first line continued here' })
    expect(turns[1]).toEqual({ speaker: 'Ext', text: 'second' })
  })

  it('returns the speaker roster in first-appearance order', () => {
    expect(transcriptSpeakers('[MU]: a\n[Ext]: b\n[MU]: c')).toEqual(['MU', 'Ext'])
  })
})

describe('extractive tier', () => {
  it('reports speakers and word count', () => {
    const result = extractiveMeetingSummary('[MU]: hello there\n[Ext]: hi', { durationMinutes: 12 })
    expect(result.tier).toBe('extractive')
    expect(result.summary).toContain('12-minute recording')
    expect(result.summary).toContain('MU')
    expect(result.summary).toContain('Ext')
  })

  it('NEVER fabricates topics, decisions, or action items', () => {
    const result = extractiveMeetingSummary(longTranscript())
    expect(result.topics).toEqual([])
    expect(result.decisions).toEqual([])
    expect(result.actionItems).toEqual([])
  })
})

describe('flag is read live, not frozen at module load', () => {
  it('flips within a single process', () => {
    delete process.env.COS_MEETING_SUMMARY
    expect(meetingSummaryLLMEnabled()).toBe(false)
    process.env.COS_MEETING_SUMMARY = '1'
    expect(meetingSummaryLLMEnabled()).toBe(true)
    process.env.COS_MEETING_SUMMARY = '0'
    expect(meetingSummaryLLMEnabled()).toBe(false)
  })
})

describe('gates — each must prevent the spawn', () => {
  it('flag off: does not spawn', async () => {
    const spawn = vi.fn()
    const result = await summariseMeeting(longTranscript(), { spawn })
    expect(spawn).not.toHaveBeenCalled()
    expect(result.tier).toBe('extractive')
    expect(result.skipReason).toBe('flag_off')
  })

  it('flag on: DOES spawn — proves the gate above is the reason, not a broken seam', async () => {
    process.env.COS_MEETING_SUMMARY = '1'
    const spawn = vi.fn().mockResolvedValue(VALID_REPLY)
    const result = await summariseMeeting(longTranscript(), { spawn })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(result.tier).toBe('llm')
  })

  it('too short: does not spawn', async () => {
    process.env.COS_MEETING_SUMMARY = '1'
    const spawn = vi.fn()
    const short = '[MU]: ok thanks bye'
    expect(countTranscriptWords(short)).toBeLessThan(MIN_SUMMARY_WORDS)
    const result = await summariseMeeting(short, { spawn })
    expect(spawn).not.toHaveBeenCalled()
    expect(result.skipReason).toBe('too_short')
  })

  it('no wall time left: does not spawn', async () => {
    process.env.COS_MEETING_SUMMARY = '1'
    const spawn = vi.fn()
    const result = await summariseMeeting(longTranscript(), {
      spawn,
      remainingWallMs: MIN_SUMMARY_WALL_MS - 1,
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(result.skipReason).toBe('no_wall_time')
  })

  it('clamps the timeout to the remaining wall, never past SUMMARY_WALL_MS', async () => {
    process.env.COS_MEETING_SUMMARY = '1'
    const spawn = vi.fn().mockResolvedValue(VALID_REPLY)
    await summariseMeeting(longTranscript(), { spawn, remainingWallMs: 20_000 })
    expect(spawn.mock.calls[0][1].timeoutMs).toBe(20_000)

    spawn.mockClear()
    await summariseMeeting(longTranscript(), { spawn, remainingWallMs: 10_000_000 })
    expect(spawn.mock.calls[0][1].timeoutMs).toBe(SUMMARY_WALL_MS)
  })

  it('breaker open after repeated failures: stops spawning', async () => {
    process.env.COS_MEETING_SUMMARY = '1'
    const spawn = vi.fn().mockRejectedValue(new Error('boom'))
    await summariseMeeting(longTranscript(), { spawn })
    await summariseMeeting(longTranscript(), { spawn })
    expect(spawn).toHaveBeenCalledTimes(2)

    const blocked = await summariseMeeting(longTranscript(), { spawn })
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(blocked.skipReason).toBe('breaker_open')
  })
})

describe('model and prompt safety', () => {
  it('always requests the cheap tier explicitly', async () => {
    process.env.COS_MEETING_SUMMARY = '1'
    const spawn = vi.fn().mockResolvedValue(VALID_REPLY)
    await summariseMeeting(longTranscript(), { spawn })
    expect(spawn.mock.calls[0][1].model).toBe('haiku')
  })

  it('forbids speaker attribution, because relabel never rewrites prose', () => {
    const prompt = buildSummaryPrompt('[Speaker 2]: hello', false)
    expect(prompt).toContain('Do NOT attribute statements to a speaker')
  })

  it('discloses truncation to the model when the middle was dropped', () => {
    expect(buildSummaryPrompt('x', true)).toContain('omitted for length')
    expect(buildSummaryPrompt('x', false)).not.toContain('omitted for length')
  })
})

describe('an unauthenticated CLI exits zero — it must not reach the file', () => {
  it('treats a success-shaped auth error as failure and spends no budget', async () => {
    process.env.COS_MEETING_SUMMARY = '1'
    const before = getMeetingSummaryBudgetState().calls
    const spawn = vi.fn().mockResolvedValue(
      'API Error: 401 Unauthorized Bearer sk-supersecret123456789',
    )
    const result = await summariseMeeting(longTranscript(), { spawn })
    expect(result.tier).toBe('extractive')
    expect(result.skipReason).toBe('auth_required')
    expect(result.summary).not.toContain('sk-supersecret')
    expect(getMeetingSummaryBudgetState().calls).toBe(before)
  })
})

describe('response validation', () => {
  it('rejects a reply with no summary', () => {
    expect(parseSummaryResponse('{"topics":["a"]}')).toBeNull()
  })

  it('rejects a non-JSON reply', () => {
    expect(parseSummaryResponse('Sure! Here is your summary.')).toBeNull()
  })

  it('strips diarisation labels from action-item owners', () => {
    // Relabel never rewrites the enrichment sections, so an owner of
    // "Speaker 2" would stay wrong for the life of the file.
    for (const label of ['Speaker 2', 'speaker2', 'Ext', 'MU', 'Me', 'Unknown']) {
      expect(isDiarisationLabel(label)).toBe(true)
    }
    for (const name of ['Silas', 'Adrianna', 'Gina Torres']) {
      expect(isDiarisationLabel(name)).toBe(false)
    }
    const parsed = parseSummaryResponse(JSON.stringify({
      summary: 'ok',
      actionItems: [
        { task: 'draft comms', owner: 'Speaker 2' },
        { task: 'confirm timeline', owner: 'Silas' },
      ],
    }))
    expect(parsed?.actionItems).toEqual([
      { task: 'draft comms', owner: '' },
      { task: 'confirm timeline', owner: 'Silas' },
    ])
  })

  it('tells the model that diarisation labels are not owners', () => {
    expect(buildSummaryPrompt('x', false)).toContain('Diarisation labels')
  })

  it('drops action items with no task rather than emitting blanks', () => {
    const parsed = parseSummaryResponse(JSON.stringify({
      summary: 'ok',
      actionItems: [{ task: '', owner: 'MU' }, { task: 'real', owner: '' }],
    }))
    expect(parsed?.actionItems).toEqual([{ task: 'real', owner: '' }])
  })

  it('a malformed reply costs no budget', async () => {
    process.env.COS_MEETING_SUMMARY = '1'
    const before = getMeetingSummaryBudgetState().calls
    const spawn = vi.fn().mockResolvedValue('not json at all')
    const result = await summariseMeeting(longTranscript(), { spawn })
    expect(result.skipReason).toBe('invalid_response')
    expect(getMeetingSummaryBudgetState().calls).toBe(before)
  })

  it('a validated reply DOES cost budget', async () => {
    process.env.COS_MEETING_SUMMARY = '1'
    const before = getMeetingSummaryBudgetState().calls
    const spawn = vi.fn().mockResolvedValue(VALID_REPLY)
    const result = await summariseMeeting(longTranscript(), { spawn })
    expect(result.tier).toBe('llm')
    expect(getMeetingSummaryBudgetState().calls).toBe(before + 1)
  })
})

describe('input bounding', () => {
  it('leaves a short transcript byte-identical', () => {
    const short = longTranscript()
    expect(boundTranscriptForSummary(short)).toEqual({ text: short, truncated: false })
  })

  it('keeps BOTH ends of a long transcript — head-only would drop every late decision', () => {
    const head = 'HEAD_MARKER '
    const tail = ' TAIL_MARKER'
    const long = head + 'x'.repeat(40_000) + tail
    const { text, truncated } = boundTranscriptForSummary(long)
    expect(truncated).toBe(true)
    expect(text).toContain('HEAD_MARKER')
    expect(text).toContain('TAIL_MARKER')
    expect(text.length).toBeLessThanOrEqual(MAX_SUMMARY_INPUT_CHARS)
  })

  it('never splits a surrogate pair', () => {
    const long = '😀'.repeat(20_000)
    const { text } = boundTranscriptForSummary(long)
    expect(text).not.toContain('�')
    expect(JSON.stringify(text)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i)
  })
})

describe('markdown splice', () => {
  const base = [
    '# Meeting',
    '',
    '| Field | Value |',
    '|-------|-------|',
    '| **Duration** | 30 minutes |',
    '',
    '## Summary',
    '',
    '*Standalone recording — canonical transcript shown in meeting detail.*',
    '',
    '## Transcript',
    '',
    '[MU]: hello',
    '',
  ].join('\n')

  const result = {
    summary: 'A real summary.',
    topics: ['One'],
    decisions: ['Two'],
    actionItems: [{ task: 'Three', owner: 'MU' }],
    tier: 'llm' as const,
  }

  it('puts EVERY new section before ## Transcript', () => {
    const out = spliceMeetingEnrichment(base, result, ['MU'])!
    expect(out).toBeTruthy()
    const transcriptAt = out.indexOf('## Transcript')
    for (const heading of ['## Topics Discussed', '## Decisions', '## Action Items', '## Attendees']) {
      expect(out.indexOf(heading)).toBeGreaterThan(-1)
      expect(out.indexOf(heading)).toBeLessThan(transcriptAt)
    }
  })

  it('emits well-formed markdown spacing around every inserted section', () => {
    const out = spliceMeetingEnrichment(base, result, ['MU'])!
    // No double blank line anywhere, and a blank line before ## Transcript.
    expect(out).not.toMatch(/\n\n\n/)
    expect(out).toContain('\n\n## Transcript')
    expect(out).toMatch(/## Summary\n\nA real summary\./)
  })

  it('leaves the transcript byte-identical', () => {
    const out = spliceMeetingEnrichment(base, result, ['MU'])!
    expect(out.slice(out.indexOf('## Transcript'))).toBe(base.slice(base.indexOf('## Transcript')))
  })

  it('emits owners in the form parseActions reads back', () => {
    const out = spliceMeetingEnrichment(base, result, ['MU'])!
    expect(out).toContain('- Three (**MU**)')
    expect(out).toContain('- **MU**')
  })

  it.each(OPS_PIPELINE_MARKERS)('REFUSES a file carrying the ops marker %s', marker => {
    const opsFile = base.replace('*Standalone recording — canonical transcript shown in meeting detail.*', marker)
    expect(hasOpsPipelineMarkers(opsFile)).toBe(true)
    expect(spliceMeetingEnrichment(opsFile, result, ['MU'])).toBeNull()
  })

  it('refuses a file with no Transcript heading rather than appending blind', () => {
    const noTranscript = '# M\n\n## Summary\n\nplaceholder\n'
    expect(spliceMeetingEnrichment(noTranscript, result, [])).toBeNull()
  })

  it('writeMeetingEnrichment re-reads the file, so a relabel during the call survives', () => {
    const root = tempRoot()
    const path = join(root, 'meeting.md')
    writeFileSync(path, base)
    // Simulate a speaker relabel landing while the LLM call was in flight.
    writeFileSync(path, base.replace('[MU]: hello', '[Miles Ukaoma]: hello'))
    expect(writeMeetingEnrichment(path, result, ['Miles Ukaoma'])).toBe(true)
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('[Miles Ukaoma]: hello')
    expect(out).not.toContain('[MU]: hello')
    expect(out).toContain('A real summary.')
  })

  it('writeMeetingEnrichment returns false for an ops file and leaves it untouched', () => {
    const root = tempRoot()
    const path = join(root, 'ops.md')
    const opsFile = base.replace(
      '*Standalone recording — canonical transcript shown in meeting detail.*',
      '*G2 recording — summary pending pipeline processing.*',
    )
    writeFileSync(path, opsFile)
    expect(writeMeetingEnrichment(path, result, [])).toBe(false)
    expect(readFileSync(path, 'utf-8')).toBe(opsFile)
  })
})

describe('daily cap', () => {
  it('defaults to the documented number and honours an override', () => {
    delete process.env.COS_MEETING_SUMMARY_DAILY_CAP
    expect(maxDailyMeetingSummaryCalls()).toBe(DEFAULT_DAILY_MEETING_SUMMARY_CALLS)
    process.env.COS_MEETING_SUMMARY_DAILY_CAP = '3'
    expect(maxDailyMeetingSummaryCalls()).toBe(3)
    process.env.COS_MEETING_SUMMARY_DAILY_CAP = 'nonsense'
    expect(maxDailyMeetingSummaryCalls()).toBe(DEFAULT_DAILY_MEETING_SUMMARY_CALLS)
  })

  it('exposes remaining against the cap', () => {
    const state = getMeetingSummaryBudgetState()
    expect(state.max).toBe(maxDailyMeetingSummaryCalls())
    expect(state.remaining).toBe(Math.max(0, state.max - state.calls))
  })

  it('EXHAUSTED: does not spawn, and falls back to the deterministic tier', async () => {
    process.env.COS_MEETING_SUMMARY = '1'
    // Drive the real on-disk read path rather than stubbing the module.
    const today = new Date()
    const localDayString = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-')
    writeFileSync(
      meetingSummaryBudgetFile(),
      JSON.stringify({ date: localDayString, calls: 99 }),
    )
    process.env.COS_MEETING_SUMMARY_DAILY_CAP = '5'
    expect(getMeetingSummaryBudgetState().remaining).toBe(0)

    const spawn = vi.fn()
    const result = await summariseMeeting(longTranscript(), { spawn })
    expect(spawn).not.toHaveBeenCalled()
    expect(result.skipReason).toBe('budget_exhausted')
    expect(result.tier).toBe('extractive')
    expect(result.summary).toContain('words')
  })

  it('UNDER the cap: does spawn — proves the exhausted case above is the cap, not a broken seam', async () => {
    process.env.COS_MEETING_SUMMARY = '1'
    const today = new Date()
    const localDayString = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-')
    writeFileSync(
      meetingSummaryBudgetFile(),
      JSON.stringify({ date: localDayString, calls: 1 }),
    )
    process.env.COS_MEETING_SUMMARY_DAILY_CAP = '5'
    const spawn = vi.fn().mockResolvedValue(VALID_REPLY)
    const result = await summariseMeeting(longTranscript(), { spawn })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(result.tier).toBe('llm')
  })
})
