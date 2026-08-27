// Read-only COS tools for the Ollama path.
//
// A CLOSED ALLOWLIST of three. These are not Claude CLI tool names and this
// file must never grow toward parity: glasses-server has no in-process search
// or fetch executor (deps are cors/express/tsx), so putting `WebSearch` or
// `WebFetch` in the tools array would advertise a capability that cannot run.
// Writes, Bash, MCP and photos stay off this path entirely.
//
// Nothing here is named `Read`. `TOOL_STATUS_MESSAGES.Read` already means
// 'Analyzing photo...' in both HUD maps, so a tool called Read would put the
// wrong sentence on the lens.

import { statSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  cosOperationsMeetingsConfigured,
  getCosOperationsMeetingDetail,
  getDirectLibraryMeetingDetail,
} from './cos-operations-meetings.js'
import { searchMemories } from './context-library-search.js'
import { searchMeetingLibrary } from './meeting-library-search.js'
import { getMeetingStore, MeetingStoreError } from './meeting-store.js'
import { TOOL_HONESTY_CLAUSE, UNTRUSTED_CONTENT_CLAUSE } from './claude-tool-access.js'

export const OLLAMA_COS_TOOL_NAMES = ['search_meetings', 'search_memories', 'read_meeting'] as const
export type OllamaCosToolName = (typeof OLLAMA_COS_TOOL_NAMES)[number]

/** One tool result may not exceed this. Enforced by DROPPING hits, never by
 *  cutting mid-string: a truncated JSON body is worse than fewer results. */
const TOOL_RESULT_MAX_CHARS = 24_000

/**
 * Is the COS Python pipeline actually present?
 *
 * DUPLICATED from `cosPipelineConfigured` in claude-tool-access.ts on purpose:
 * that one is module-private (not exported), and importing it is impossible
 * without widening a Claude-owned surface. Same live `statSync` shape, so a
 * standalone npm install with no operations tree advertises no COS tools and
 * gets a prompt that never mentions them.
 *
 * Read live, never cached at import: `python-bridge.ts` binds COS_SCRIPTS_DIR
 * at module load, and a test that sets the env after import would be lying to
 * itself.
 */
export function ollamaCosPipelineConfigured(): boolean {
  const dir = process.env.COS_SCRIPTS_DIR
  if (!dir || !dir.trim()) return false
  try {
    return statSync(resolve(dir.trim())).isDirectory()
  } catch {
    return false
  }
}

/** Ollama's function-tool schema, matching the live C2/C4 probe. */
export interface OllamaToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] }
  }
}

export function buildOllamaToolDefs(): OllamaToolDef[] {
  if (!ollamaCosPipelineConfigured()) return []
  return [
    {
      type: 'function',
      function: {
        name: 'search_meetings',
        description:
          'Search the meeting library by meaning and keyword. Returns hits with title, date, domain, month and filename. Use the returned domain/month/filename with read_meeting to read one.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to look for.' },
            domain: { type: 'string', description: "Optional domain filter, e.g. quilt. Omit for all." },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_memories',
        description:
          'Search stored COS memories (past session summaries, decisions and corrections) by meaning and keyword.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'What to look for.' } },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_meeting',
        description:
          'Read one meeting by its exact domain, month and filename, as returned by search_meetings.',
        parameters: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: "Domain, or 'library'." },
            month: { type: 'string', description: 'YYYY-MM.' },
            filename: { type: 'string', description: 'Exact filename from search_meetings.' },
          },
          required: ['domain', 'month', 'filename'],
        },
      },
    },
  ]
}

/** HUD label. Never `Analyzing photo...`, never a bare `Read`. */
export function ollamaToolStatusLabel(name: string): string {
  switch (name) {
    case 'search_meetings': return 'Searching meetings...'
    case 'search_memories': return 'Searching memory...'
    case 'read_meeting': return 'Reading meeting...'
    default: return 'Working...'
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * `function.arguments` arrives as an OBJECT from the live daemon (C2) but the
 * wire format also permits a JSON string. Accept both; a malformed string is a
 * tool result, never a throw.
 */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch { /* falls through to empty */ }
  }
  return {}
}

/**
 * Shrink by DROPPING whole hits until the JSON fits, so the string a model
 * receives is always parseable. Mid-string truncation would hand the model
 * broken JSON and invite it to hallucinate the rest.
 */
function capHits<T>(payload: Record<string, unknown>, hits: T[]): string {
  let kept = hits.slice()
  for (;;) {
    const body = JSON.stringify({ ...payload, hits: kept, truncated: kept.length < hits.length })
    if (body.length <= TOOL_RESULT_MAX_CHARS || kept.length === 0) return body
    kept = kept.slice(0, Math.max(0, Math.floor(kept.length / 2)))
  }
}

/**
 * A search result ALWAYS carries its counts and its semantic reason, even when
 * it found nothing.
 *
 * Empty hits plus a reason describe THIS call. Without the reason a model reads
 * an empty list as proof the archive is empty and tells Miles he has no
 * meetings. `semanticReason` is `"none"` rather than absent so the field can
 * never be silently missing.
 */
function serializeSearch(
  result: { hits: unknown[]; keywordCount: number; semanticCount: number; semanticAvailable: boolean; semanticReason?: string },
  extra: Record<string, unknown> = {},
): string {
  return capHits(
    {
      ...extra,
      keywordCount: result.keywordCount,
      semanticCount: result.semanticCount,
      semanticAvailable: result.semanticAvailable,
      semanticReason: result.semanticReason ?? 'none',
    },
    result.hits,
  )
}

/**
 * Serialize a meeting as a PICKED SUBSET.
 *
 * Never `JSON.stringify(detail)`: the ops helpers still attach an unbounded
 * `transcript`, and MEETING_SOURCE_MAX_BYTES is 100_000 — an order of magnitude
 * past the tool cap. Only these fields cross into the model's context.
 */
function serializeMeeting(detail: Record<string, unknown>, ref: { domain: string; month: string; filename: string }): string {
  const source = asString(detail.sourceContent)
  const capped = source.length > TOOL_RESULT_MAX_CHARS ? source.slice(0, TOOL_RESULT_MAX_CHARS) : source
  const picked: Record<string, unknown> = {
    title: asString(detail.title),
    date: asString(detail.date),
    domain: ref.domain,
    month: ref.month,
    filename: ref.filename,
    sourceContent: capped,
    sourceTruncated: detail.sourceTruncated === true || capped.length < source.length,
  }
  const summary = asString(detail.summary)
  if (summary && summary.length < 4_000) picked.summary = summary
  if (Array.isArray(detail.topics) && detail.topics.length <= 40) picked.topics = detail.topics
  return JSON.stringify(picked)
}

/**
 * Copy of the routing in routes/meetings.ts ~238-256.
 *
 * The route reaches its store through `createMeetingsRouter(store)`, a factory
 * parameter — there is no importable `store` binding, so this calls
 * `getMeetingStore()` directly. A null from either helper is NOT terminal: an
 * ops miss still falls through to the standalone store, which is what serves
 * G2-local recordings sharing the same shape.
 */
function readMeetingDetail(domain: string, month: string, filename: string): string {
  if (domain === 'library') {
    const detail = getDirectLibraryMeetingDetail(month, filename)
    if (detail) return serializeMeeting(detail as unknown as Record<string, unknown>, { domain, month, filename })
  }
  if (cosOperationsMeetingsConfigured()) {
    const detail = getCosOperationsMeetingDetail(domain, month, filename)
    if (detail) return serializeMeeting(detail as unknown as Record<string, unknown>, { domain, month, filename })
  }
  try {
    const detail = getMeetingStore().detail(domain, month, filename)
    if (!detail) return JSON.stringify({ error: 'not found for this path', domain, month, filename })
    return serializeMeeting(detail as unknown as Record<string, unknown>, { domain, month, filename })
  } catch (error) {
    if (error instanceof MeetingStoreError) {
      return JSON.stringify({ error: 'not found for this path', domain, month, filename })
    }
    throw error
  }
}

/**
 * Run one tool call.
 *
 * Returns a STRING for every outcome the model could plausibly cause — unknown
 * name, missing argument, nothing found — because a thrown error would end the
 * whole turn where the model could simply have tried again. Only an abort
 * escapes as the sentinel `aborted`.
 *
 * `AbortSignal` is not thenable, so cancellation is a listener race rather than
 * an await. The signal is optional purely so unit tests can call this directly.
 */
export async function executeOllamaTool(
  name: string,
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (abortSignal?.aborted) return 'aborted'
  const work = runTool(name, args)
  if (!abortSignal) return work
  return Promise.race([
    work,
    new Promise<string>(resolveRace => {
      abortSignal.addEventListener('abort', () => resolveRace('aborted'), { once: true })
    }),
  ])
}

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    if (name === 'search_meetings') {
      const query = asString(args.query)
      if (!query) return JSON.stringify({ error: 'query is required' })
      const domain = asString(args.domain)
      const result = await searchMeetingLibrary({ query, ...(domain ? { domain } : {}) })
      return serializeSearch(result, { query, domain: domain || 'all' })
    }
    if (name === 'search_memories') {
      const query = asString(args.query)
      if (!query) return JSON.stringify({ error: 'query is required' })
      const result = await searchMemories({ query })
      return serializeSearch(result, { query })
    }
    if (name === 'read_meeting') {
      const domain = asString(args.domain)
      const month = asString(args.month)
      const filename = asString(args.filename)
      if (!domain || !month || !filename) {
        return JSON.stringify({ error: 'domain, month and filename are all required' })
      }
      return readMeetingDetail(domain, month, filename)
    }
    return `unknown tool ${name}`
  } catch (error) {
    // Call-local wording. Helper keys like `qdrant_unreachable` describe one
    // probe, and repeating them as prose invites the model to announce a
    // service outage it cannot actually observe.
    const detail = error instanceof Error ? error.message.slice(0, 200) : 'failed'
    return JSON.stringify({ error: 'tool call failed', detail })
  }
}

/**
 * What the model is told it can do. Deliberately NOT `readOnlyCapabilityPrompt`
 * (it asserts MCP reachability) and NOT `claudeToolCapabilityPrompt`.
 *
 * The escalation line must never name Ollama: Codex once offered to re-run a
 * failed task on itself, which is a loop dressed as a suggestion.
 */
export function ollamaToolCapabilityPrompt(toolNames: readonly string[]): string {
  return [
    'This request runs on the READ-ONLY Ollama path.',
    `Available tools: ${toolNames.join(', ')}. Writes, Bash, MCP, web search, web fetch, and photos are not available here.`,
    'An absent name means it is not on this path — do not ToolSearch and do not claim a connector is down.',
    'Empty search hits plus a reason report the result of THIS call; they are not proof that no meetings or memories exist.',
    'A read_meeting miss means not found for that path, not that the meeting does not exist.',
    'If the user needs a write or a web search, say so and offer Opus or Codex/GPT (workspace-write), never this local slot.',
    TOOL_HONESTY_CLAUSE,
    UNTRUSTED_CONTENT_CLAUSE,
  ].join('\n')
}

/** The sentence used when no tools are advertised. Preserved verbatim. */
export const OLLAMA_NO_TOOLS_SENTENCE =
  'You have no tools. Answer from the prompt and conversation only. Plain text.'

/**
 * The Ollama system prompt.
 *
 * Built here rather than through `buildSystemPrompt`, which instructs the model
 * to search the web and read photo files — neither of which exists on this
 * path. The glasses display constraints are copied from
 * `buildLightweightSystemPrompt` WITHOUT its Siri framing ("NOT a work
 * productivity tool"), which is wrong the moment COS tools are advertised.
 *
 * Cached context is included ALWAYS, not keyword-gated: the old gate meant a
 * question about today's schedule got no calendar unless it happened to use the
 * word "meeting". The cached read is instant, so this cannot block a glasses
 * turn the way an awaited build would.
 */
export function buildOllamaSystemPrompt(input: {
  ownerName: string
  cachedContext: string
  historyPrompt: string
  toolNames: readonly string[]
}): string {
  const owner = input.ownerName.trim() || 'the wearer'
  const parts = [
    `You are COS, ${owner}'s chief of staff, answering on smart glasses.`,
    'Answer in plain text. No markdown, no bullet characters, no emoji.',
    'Aim for 300 to 600 characters. Up to about 2000 when the answer genuinely needs it.',
  ]
  if (input.cachedContext.trim()) {
    parts.push(input.cachedContext.trim())
    parts.push(
      "The context block above is TODAY'S calendar and tasks. It is not the meeting archive. \"No more meetings today\" describes today's schedule only.",
    )
  }
  if (input.historyPrompt.trim()) parts.push(input.historyPrompt.trim())
  parts.push(
    input.toolNames.length > 0
      ? ollamaToolCapabilityPrompt(input.toolNames)
      : OLLAMA_NO_TOOLS_SENTENCE,
  )
  return parts.join('\n\n')
}
