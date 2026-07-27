// Live Cues prompts — planner and insight, both Composer asks via the
// dedicated spawn (live-cues-cursor.ts). The bridge's system prompt is gone,
// so these prompts own EVERY constraint themselves, including the anti-markdown
// rule (the old bridge prompt forbade structured output, which is why the
// bridge cannot be used) and the attribution rule (with sparse voiceprints,
// diarization collapses to owner/Ext and a model will invent named speakers).

export interface PlannerResult {
  query: string
  entity: string | null
}

export interface InsightResult {
  nudge: string
  type: string
  priority: number
}

const JSON_ONLY_RULES = [
  'Output ONLY minified JSON on a single line. No markdown, no code fences, no prose before or after.',
  'If you have nothing sharp to contribute, output the literal token null.',
].join(' ')

export function buildPlannerPrompt(transcriptWindow: string): string {
  return [
    'You plan memory lookups for a live-meeting coaching system.',
    'Given the transcript window below, produce the single most valuable memory query.',
    JSON_ONLY_RULES,
    'Schema: {"query": string, "entity": string | null}',
    '- "query": a semantic search phrase for past-meeting retrieval (topics, decisions, commitments). Under 12 words.',
    '- "entity": ONE named person, company, or project from the transcript worth exploring in the knowledge graph, or null.',
    'Output null when the window is small talk, logistics, or filler with no retrievable substance.',
    '',
    'TRANSCRIPT WINDOW:',
    transcriptWindow,
  ].join('\n')
}

export function buildInsightPrompt(input: {
  transcriptWindow: string
  memorySnippets: string[]
  graphContext: string | null
}): string {
  const memory = input.memorySnippets.length
    ? input.memorySnippets.map((snippet, index) => `${index + 1}. ${snippet}`).join('\n')
    : '(no related past meetings found)'
  return [
    'You produce ONE live coaching cue for smart-glasses during a meeting.',
    'The wearer sees at most 85 characters, so the cue must be a single sharp line.',
    JSON_ONLY_RULES,
    'Schema: {"nudge": string, "type": string, "priority": number}',
    '- "nudge": max 85 characters, max 14 words. Plain text. No markdown, no asterisks, no em dashes.',
    '- "type": a short snake_case category, e.g. commitment_check, past_context, open_question, risk_flag. NEVER the literal string coaching_nudge.',
    '- "priority": 1 (glance-worthy) to 3 (say this now).',
    'Rules:',
    '- The cue must use the MEMORY or GRAPH context to surface an edge the room cannot see. Do not replay what was just said.',
    '- Never attribute a statement to a named person unless the transcript line is labeled with that name. Prefer "someone raised X".',
    '- A sharp question is a valid cue when context is thin.',
    '- Output null unless the cue is genuinely worth interrupting a meeting for.',
    '',
    'TRANSCRIPT WINDOW:',
    input.transcriptWindow,
    '',
    'MEMORY (related past meetings):',
    memory,
    '',
    'GRAPH CONTEXT:',
    input.graphContext ?? '(unavailable this cycle)',
  ].join('\n')
}

/** Parse a Composer reply that was instructed to emit minified JSON or null.
 *  Tolerates accidental code fences; anything else unparseable returns null. */
export function parseJsonReply<T>(raw: string, validate: (value: unknown) => value is T): T | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  if (!trimmed || trimmed === 'null') return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return validate(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function isPlannerResult(value: unknown): value is PlannerResult {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.query === 'string' && record.query.trim().length > 0
    && (record.entity === null || typeof record.entity === 'string')
}

export function isInsightResult(value: unknown): value is InsightResult {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.nudge === 'string' && record.nudge.trim().length > 0
    && typeof record.type === 'string' && record.type.trim().length > 0
    && typeof record.priority === 'number' && Number.isFinite(record.priority)
}
