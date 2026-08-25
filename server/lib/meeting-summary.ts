// Standalone meeting enrichment — summary / topics / decisions / action items.
//
// WHY THIS EXISTS
// Summary, topics, decisions and actions are normally produced by
// sync_meetings.py, spawned through g2-ops-handoff. A standalone user has no
// COS_SCRIPTS_DIR, no Python, and no sync_meetings.py, so that pipeline never
// runs and MeetingStore.save writes only a placeholder. This module is the
// standalone-only replacement.
//
// TWO TIERS
//   extractiveMeetingSummary()  — deterministic, zero tokens, always available.
//                                 Reports what the transcript literally shows:
//                                 speakers, turns, talk-time, opening excerpt.
//                                 It does NOT invent topics or decisions.
//   llmMeetingSummary()         — `claude -p` over the transcript. Default OFF.
//                                 Falls back to the extractive tier on every
//                                 failure path.
//
// NEVER RUNS FOR OPERATIONS USERS. Overwriting the summary section would erase
// the two markers sync_meetings.py:925-926 gates on
// ('summary pending pipeline processing' and 'g2-needs-domain-review'), and the
// meeting would be skipped by the pipeline entirely — permanent loss of domain
// reclassification, task extraction, and the operations copy. The caller gates
// on cosOpsPipelineConfigured(); this module refuses independently as defence
// in depth.

import { spawnClaudeText } from './prompt-edit.js'
import { terminalProviderAuthFailure } from './provider-terminal-error.js'
import { createBreaker } from './claude-circuit.js'
import {
  meetingSummaryBudgetAvailable,
  commitMeetingSummaryCall,
} from './meeting-summary-budget.js'

export interface MeetingActionItemDraft {
  task: string
  owner: string
}

export interface MeetingSummaryResult {
  summary: string
  topics: string[]
  decisions: string[]
  actionItems: MeetingActionItemDraft[]
  /** Which tier produced this. Surfaced so no caller can present a mechanical
   *  record as though it were an abstractive summary. */
  tier: 'extractive' | 'llm'
}

// ── Bounds ──────────────────────────────────────────────────

/** Below this the recording is too short to enrich; spend nothing. */
export const MIN_SUMMARY_WORDS = 40

/** Input bound for the LLM tier. Head+tail, never head-only: a head-only
 *  truncation of a long meeting silently discards every decision made in the
 *  last two thirds and still reads as confident and complete. */
export const MAX_SUMMARY_INPUT_CHARS = 24_000
const HEAD_FRACTION = 0.6
const ELISION = '\n\n[... middle of transcript omitted for length ...]\n\n'

/** Hard wall for one LLM summary call. */
export const SUMMARY_WALL_MS = 45_000

/** Below this much remaining budget the LLM tier is skipped entirely — a call
 *  that cannot finish inside the window must not be started. */
export const MIN_SUMMARY_WALL_MS = 15_000

/** Total wall budget for the whole finalization job (batch decode + handoff +
 *  this summariser). COS Control's waitForRestartProof defaults to 90s
 *  (cos-control-macos/HelperSources/main.swift:2645); a drain that catches
 *  finalization in flight past that hard-fails to Repair. 75s leaves 15s of
 *  margin for lease release and proof publication. */
export const FINALIZATION_WALL_BUDGET_MS = 75_000

const MAX_TOPICS = 8
const MAX_DECISIONS = 8
const MAX_ACTIONS = 10
const MAX_SUMMARY_CHARS = 1_200

const breaker = createBreaker({ label: 'meeting-summary', maxFailures: 2 })

/** Exported for tests. */
export const meetingSummaryBreaker = breaker

// ── Flag ────────────────────────────────────────────────────

/** Read LIVE, not at module load. COS Control rebuilds the runtime plist
 *  environment on update, and tests flip this per-case; a module-scope const
 *  would freeze the value at import and make both untestable. */
export function meetingSummaryLLMEnabled(): boolean {
  const raw = process.env.COS_MEETING_SUMMARY?.trim()
  return raw === '1' || raw?.toLowerCase() === 'true'
}

// ── Transcript parsing ──────────────────────────────────────

export interface TranscriptTurn {
  speaker: string
  text: string
}

/** Parse `[Speaker]: text` turns. Lines without a speaker prefix are appended
 *  to the previous turn so a wrapped line does not become its own turn. */
export function parseTranscriptTurns(transcript: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  for (const line of transcript.split('\n')) {
    const match = line.match(/^\s*\[([^\]]{1,60})\]:\s*(.*)$/)
    if (match) {
      turns.push({ speaker: match[1].trim(), text: match[2].trim() })
      continue
    }
    const trimmed = line.trim()
    if (!trimmed) continue
    if (turns.length > 0) {
      turns[turns.length - 1].text = `${turns[turns.length - 1].text} ${trimmed}`.trim()
    } else {
      turns.push({ speaker: '', text: trimmed })
    }
  }
  return turns.filter(turn => turn.text.length > 0)
}

export function countTranscriptWords(transcript: string): number {
  return transcript.split(/\s+/).filter(Boolean).length
}

// ── Tier 1: deterministic ───────────────────────────────────

/**
 * A factual record of what the transcript contains. Deliberately makes no
 * claim it cannot support: topics, decisions and action items come back EMPTY
 * because no deterministic method extracts them reliably, and a fabricated
 * list is worse than an absent one.
 */
export function extractiveMeetingSummary(
  transcript: string,
  opts: { durationMinutes?: number } = {},
): MeetingSummaryResult {
  const turns = parseTranscriptTurns(transcript)
  const words = countTranscriptWords(transcript)

  const wordsBySpeaker = new Map<string, number>()
  for (const turn of turns) {
    if (!turn.speaker) continue
    wordsBySpeaker.set(
      turn.speaker,
      (wordsBySpeaker.get(turn.speaker) ?? 0) + countTranscriptWords(turn.text),
    )
  }
  const speakers = [...wordsBySpeaker.entries()].sort((a, b) => b[1] - a[1])

  const parts: string[] = []
  if (opts.durationMinutes && opts.durationMinutes > 0) {
    parts.push(`${opts.durationMinutes}-minute recording`)
  } else {
    parts.push('Recording')
  }
  parts.push(`${words.toLocaleString()} words`)
  if (speakers.length > 0) {
    const roster = speakers
      .map(([name, count]) => `${name} (${Math.round((count / Math.max(1, words)) * 100)}%)`)
      .join(', ')
    parts.push(`${speakers.length} speaker${speakers.length === 1 ? '' : 's'}: ${roster}`)
  }

  const opening = turns
    .slice(0, 3)
    .map(turn => (turn.speaker ? `${turn.speaker}: ${turn.text}` : turn.text))
    .join(' ')
    .slice(0, 300)
    .trim()

  const summary = opening
    ? `${parts.join('. ')}.\n\nOpening: ${opening}${opening.length >= 300 ? '…' : ''}`
    : `${parts.join('. ')}.`

  return {
    summary,
    topics: [],
    decisions: [],
    actionItems: [],
    tier: 'extractive',
  }
}

/** Speaker roster, for the Attendees section. Deterministic either tier. */
export function transcriptSpeakers(transcript: string): string[] {
  const seen: string[] = []
  for (const turn of parseTranscriptTurns(transcript)) {
    if (turn.speaker && !seen.includes(turn.speaker)) seen.push(turn.speaker)
  }
  return seen.slice(0, 20)
}

// ── Tier 2: LLM ─────────────────────────────────────────────

/** Head+tail bound that never splits a UTF-16 surrogate pair. */
export function boundTranscriptForSummary(transcript: string): {
  text: string
  truncated: boolean
} {
  if (transcript.length <= MAX_SUMMARY_INPUT_CHARS) {
    return { text: transcript, truncated: false }
  }
  const budget = MAX_SUMMARY_INPUT_CHARS - ELISION.length
  let headEnd = Math.floor(budget * HEAD_FRACTION)
  let tailStart = transcript.length - (budget - headEnd)
  // Never cut between a surrogate pair (emoji, some CJK extensions).
  if (isLowSurrogate(transcript.charCodeAt(headEnd))) headEnd -= 1
  if (isLowSurrogate(transcript.charCodeAt(tailStart))) tailStart += 1
  return {
    text: `${transcript.slice(0, headEnd)}${ELISION}${transcript.slice(tailStart)}`,
    truncated: true,
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

export function buildSummaryPrompt(transcript: string, truncated: boolean): string {
  return [
    'You are summarising a meeting transcript for the person who recorded it.',
    '',
    'Rules:',
    '- Reply with ONLY a JSON object. No prose, no code fence.',
    '- Shape: {"summary": string, "topics": string[], "decisions": string[], "actionItems": [{"task": string, "owner": string}]}',
    '- "summary" is 2-4 sentences of what actually happened.',
    '- Use an empty array when the transcript does not support that field. Never invent a decision or an action item.',
    // Speaker labels in a standalone transcript are diarisation guesses
    // ("Speaker 2", "Ext") and are corrected later by the speaker-review flow,
    // which deliberately never rewrites prose (meeting-corrections.ts:19-26).
    // A generated summary naming a speaker would keep the wrong name forever.
    '- Do NOT attribute statements to a speaker by name or label. Describe what was discussed, not who said it.',
    '- "owner" must be a person NAMED ALOUD in the transcript. Diarisation labels'
      + ' ("Speaker 2", "Ext", "MU", "Me", "Unknown") are placeholders, not names —'
      + ' use "" for owner in that case.',
    '- Write in the same language as the transcript.',
    truncated
      ? '- The middle of this transcript was omitted for length. Say so in the summary rather than implying full coverage.'
      : '',
    '',
    'Transcript:',
    transcript,
  ]
    .filter(Boolean)
    .join('\n')
}

/** Diarisation placeholders. These are corrected later by the speaker-review
 *  flow, which never rewrites the enrichment sections — so a label captured as
 *  an action-item owner would stay wrong permanently. Drop it instead. */
const DIARISATION_LABEL = /^(?:speaker\s*\d+|ext(?:ernal)?|unknown|me|mu)$/i

export function isDiarisationLabel(value: string): boolean {
  return DIARISATION_LABEL.test(value.trim())
}

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, limit)
}

/** Strict shape validation. A malformed reply is a failure, not a partial win. */
export function parseSummaryResponse(raw: string): MeetingSummaryResult | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
  if (!summary || summary.length > MAX_SUMMARY_CHARS) return null

  const actionItems = Array.isArray(record.actionItems)
    ? record.actionItems
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map(item => {
          const owner = typeof item.owner === 'string' ? item.owner.trim() : ''
          return {
            task: typeof item.task === 'string' ? item.task.trim() : '',
            // Belt and braces: the prompt forbids these, and this drops them
            // if a model returns one anyway.
            owner: isDiarisationLabel(owner) ? '' : owner,
          }
        })
        .filter(item => item.task.length > 0)
        .slice(0, MAX_ACTIONS)
    : []

  return {
    summary,
    topics: asStringArray(record.topics, MAX_TOPICS),
    decisions: asStringArray(record.decisions, MAX_DECISIONS),
    actionItems,
    tier: 'llm',
  }
}

export interface LlmSummaryOptions {
  durationMinutes?: number
  /** Wall time still available before FINALIZATION_WALL_BUDGET_MS is spent. */
  remainingWallMs?: number
  signal?: AbortSignal
  /** Test seam. Defaults to the real spawnClaudeText. */
  spawn?: (prompt: string, opts: { model: string; timeoutMs: number; label: string; signal?: AbortSignal }) => Promise<string>
}

export interface SummaryOutcome extends MeetingSummaryResult {
  /** Why the LLM tier did not run, when it did not. */
  skipReason?:
    | 'flag_off'
    | 'too_short'
    | 'budget_exhausted'
    | 'breaker_open'
    | 'no_wall_time'
    | 'auth_required'
    | 'invalid_response'
    | 'call_failed'
}

/**
 * Produce the best available enrichment. Always returns a usable result: the
 * LLM tier when every gate passes, the deterministic tier otherwise.
 */
export async function summariseMeeting(
  transcript: string,
  opts: LlmSummaryOptions = {},
): Promise<SummaryOutcome> {
  const fallback = extractiveMeetingSummary(transcript, {
    durationMinutes: opts.durationMinutes,
  })

  if (!meetingSummaryLLMEnabled()) return { ...fallback, skipReason: 'flag_off' }
  if (countTranscriptWords(transcript) < MIN_SUMMARY_WORDS) {
    return { ...fallback, skipReason: 'too_short' }
  }
  if (breaker.isOpen()) return { ...fallback, skipReason: 'breaker_open' }
  if (!meetingSummaryBudgetAvailable()) {
    return { ...fallback, skipReason: 'budget_exhausted' }
  }

  const remaining = opts.remainingWallMs ?? SUMMARY_WALL_MS
  if (remaining < MIN_SUMMARY_WALL_MS) return { ...fallback, skipReason: 'no_wall_time' }
  const timeoutMs = Math.min(SUMMARY_WALL_MS, remaining)

  const { text, truncated } = boundTranscriptForSummary(transcript)
  const spawn = opts.spawn ?? ((prompt, spawnOpts) => spawnClaudeText(prompt, spawnOpts))

  let raw: string
  try {
    raw = await spawn(buildSummaryPrompt(text, truncated), {
      // Cheapest tier, and --model is ALWAYS passed by spawnClaudeText so this
      // can never silently inherit an Opus session default.
      model: 'haiku',
      timeoutMs,
      label: 'Meeting summary',
      signal: opts.signal,
    })
  } catch (err) {
    breaker.recordFailure()
    console.error(`[meeting-summary] call failed: ${err instanceof Error ? err.message : String(err)}`)
    return { ...fallback, skipReason: 'call_failed' }
  }

  // An unauthenticated CLI exits ZERO with a success-shaped payload carrying
  // the bearer token (claude-bridge-auth-finalization.test.ts:173-191). Without
  // this check that credential would be written into a durable meeting file.
  const authFailure = terminalProviderAuthFailure('claude', raw)
  if (authFailure) {
    breaker.recordFailure()
    console.error(`[meeting-summary] ${authFailure}`)
    return { ...fallback, skipReason: 'auth_required' }
  }

  const parsed = parseSummaryResponse(raw)
  if (!parsed) {
    breaker.recordFailure()
    console.error('[meeting-summary] response failed shape validation')
    return { ...fallback, skipReason: 'invalid_response' }
  }

  // Committed only now: a failure, refusal, or malformed reply costs nothing.
  commitMeetingSummaryCall()
  breaker.recordSuccess()
  return parsed
}

// ── Concurrency ─────────────────────────────────────────────

let summaryQueueTail: Promise<unknown> = Promise.resolve()

/**
 * Serialise summary work to a single slot. resumeMeetingFinalizationJobs()
 * replays EVERY retained job on boot, so without this a crash-then-restart
 * would spawn one provider per pending meeting at once.
 *
 * Load-shedding is automatic and needs no queue limit: each caller computes
 * remainingWallMs from its OWN job start, so a job that waited behind others
 * arrives with too little budget and degrades to the deterministic tier
 * instead of holding its maintenance lease past COS Control's drain timeout.
 */
export function enqueueSummaryWork<T>(fn: () => Promise<T>): Promise<T> {
  const run = summaryQueueTail.then(fn, fn)
  summaryQueueTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
