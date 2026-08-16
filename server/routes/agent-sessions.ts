// GET /api/agent-sessions
// GET /api/agent-sessions/search?q=
// GET /api/agent-sessions/:provider/:sessionId
//
// Same local stores COS Control reads for Activity → Sessions:
// Claude jsonl, Codex rollouts, Cursor agent-transcripts.
// Default list is last 7 days of writes (mtime), including pinned Codex
// threads whose jsonl still lives in the original day folder.
// `?sort=updated` matches Control's Updated clock: newest mtime first.
// Stale pins stay in the payload but do not cluster at the top.
// `?sort=opened` keeps the same window on session start instead.
// Search scans titles, sidebar names, first prompts, and transcript heads
// without the 7-day list window. Literal /search is registered first.
// Does not need COS_SCRIPTS_DIR. Codex subagents stay out. Files over 32 MB
// still appear in the list; detail remains capped.

import { Router } from 'express'
import { stat } from 'node:fs/promises'
import {
  AGENT_SESSION_LIST_LIMIT,
  AGENT_SESSION_LIST_MAX,
  AGENT_SESSION_WINDOW_HOURS,
  agentSessionRoots,
  findAgentSessionFile,
  listAgentSessions,
  loadCursorComposerNames,
  parseAgentSession,
  type AgentProvider,
  type AgentSessionRow,
  type AgentSessionSort,
} from '../lib/agent-session-store.js'
import { searchAgentSessions, type AgentSessionSearchHit } from '../lib/agent-session-search.js'
import { claudeSessionNamesVisible, claudeSessionsDir, claudeSessionsEnabled, readClaudePeers } from './claude-sessions.js'
import { workspaceFromCwd } from '../lib/claude-session-registry.js'
import { occupiedThreads, noOccupancyKnown, type OccupiedScan, type OccupiedThread } from '../lib/occupied-threads.js'
import { realOccupancyDirs, realOccupancyProbes } from '../lib/occupancy-probes.js'
import { cosSpawnedPids } from '../lib/agent-session-ownership-store.js'

export const agentSessionsRouter = Router()

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function asProvider(value: string): AgentProvider | null {
  if (value === 'claude' || value === 'codex' || value === 'cursor') return value
  return null
}

function asSort(value: unknown): AgentSessionSort {
  return String(value ?? '').toLowerCase() === 'opened' ? 'opened' : 'updated'
}

function toSearchHit(row: AgentSessionSearchHit) {
  return {
    ...toEntry(row),
    snippet: row.snippet,
    keywordScore: row.keywordScore,
    semanticScore: row.semanticScore,
    match: row.match,
    score: Math.max(row.keywordScore, row.semanticScore),
  }
}

/**
 * Which of these sessions a desktop process is holding right now.
 *
 * ONE scan for the whole page. Calling `threadOccupancy` per row would re-read the
 * registry and shell out to `ps` per entry, which at 53 sessions is hundreds of
 * process spawns on a single list request.
 *
 * THIS IS A DISPLAY HINT AND MUST NEVER GATE A WRITE. The attach and turn routes
 * keep probing at the moment of the write, unchanged, because a list is rendered
 * seconds or minutes before the user acts and a desktop session opened in that gap
 * is exactly the race the per-write probe exists to catch.
 */
function runningThreads(rows: readonly AgentSessionRow[]): OccupiedScan {
  try {
    const dirs = realOccupancyDirs()
    // The spawn ledger is what lets a turn COS itself queued read as ours rather
    // than as a foreign desktop window holding the thread.
    const probes = realOccupancyProbes(cosSpawnedPids)
    const byProvider = new Map<string, string[]>()
    for (const row of rows) {
      if (row.provider !== 'claude' && row.provider !== 'codex') continue
      const list = byProvider.get(row.provider) ?? []
      list.push(row.session_id)
      byProvider.set(row.provider, list)
    }
    const merged = new Map<string, OccupiedThread>()
    let degraded = false
    for (const [provider, ids] of byProvider) {
      const scan = occupiedThreads(provider, ids, probes, dirs)
      for (const [id, occ] of scan.occupied) merged.set(id, occ)
      if (scan.degraded) degraded = true
    }
    return { occupied: merged, degraded }
  } catch (error) {
    // The list is the point; occupancy is decoration. A probe failure must never
    // cost the user their sessions.
    console.error(`[agent-sessions] occupancy scan failed: ${error instanceof Error ? error.message : error}`)
    return noOccupancyKnown()
  }
}

/** Stamp the running hint onto a projected row. */
function withRunning<T extends { session_id: string }>(entry: T, scan: OccupiedScan) {
  const occ = scan.occupied.get(entry.session_id)
  return {
    ...entry,
    // An agent is working in this thread right now, whoever started it.
    running: occ !== undefined,
    // Held by something that is not COS, so a Continue would be refused. The
    // badge reads `running`; the Continue affordance reads this.
    running_foreign: (occ?.foreignOwners ?? 0) > 0,
  }
}

function toEntry(row: AgentSessionRow) {
  return {
    session_id: row.session_id,
    provider: row.provider,
    slug: row.session_id,
    custom_title: row.display_label,
    display_label: row.display_label,
    first_prompt: row.first_prompt || row.display_label,
    discussion_summary: row.discussion_summary || '',
    project: row.project,
    created: row.created,
    modified: row.modified,
    duration_minutes: 0,
    message_count: 0,
    domain: '',
    device_id: row.provider,
    machine_spawned: false,
    alive: row.alive,
    state: row.state,
    pinned: row.pinned,
  }
}

async function liveClaudeRows(): Promise<AgentSessionRow[]> {
  if (!claudeSessionsEnabled()) return []
  const peers = await readClaudePeers(claudeSessionsDir(), undefined, claudeSessionNamesVisible())
  return peers.filter(peer => peer.alive).map(peer => ({
    session_id: peer.id,
    provider: 'claude' as const,
    display_label: peer.name || 'Claude session',
    project: workspaceFromCwd(peer.workspace) || peer.workspace,
    modified: peer.lastActiveAt ? new Date(peer.lastActiveAt).toISOString() : new Date().toISOString(),
    created: peer.startedAt ? new Date(peer.startedAt).toISOString() : new Date().toISOString(),
    alive: true,
    state: 'running' as const,
    pinned: false,
  }))
}

agentSessionsRouter.get('/agent-sessions', async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  try {
    const limit = boundedInteger(req.query.limit, AGENT_SESSION_LIST_LIMIT, 1, AGENT_SESSION_LIST_MAX)
    const sort = asSort(req.query.sort)
    const live = await liveClaudeRows()
    const sessions = await listAgentSessions(agentSessionRoots(), new Date(), live, limit, sort)
    const running = runningThreads(sessions)
    res.json({
      sessions: sessions.map(row => withRunning(toEntry(row), running)),
      total: sessions.length,
      windowHours: AGENT_SESSION_WINDOW_HOURS,
      sort,
      enabled: true,
      // True when a probe could not see clearly. The client must render "unknown"
      // rather than treating a quiet scan as "nothing is running".
      runningDegraded: running.degraded,
    })
  } catch (error) {
    console.error(`[agent-sessions] list failed: ${error instanceof Error ? error.message : error}`)
    res.status(500).json({ error: 'Failed to read agent sessions', reason: 'agent_sessions_read_failed' })
  }
})

agentSessionsRouter.get('/agent-sessions/search', async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  if (query.length < 2) {
    res.status(400).json({ error: 'q must be at least 2 characters', reason: 'invalid_query' })
    return
  }
  try {
    const limit = boundedInteger(req.query.limit, 20, 1, 50)
    const result = await searchAgentSessions({ query, limit })
    res.json({
      ...result,
      hits: result.hits.map(toSearchHit),
    })
  } catch (error) {
    console.error(`[agent-sessions] search failed: ${error instanceof Error ? error.message : error}`)
    res.status(500).json({ error: 'Failed to search agent sessions', reason: 'agent_sessions_search_failed' })
  }
})

agentSessionsRouter.get('/agent-sessions/:provider/:sessionId', async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const provider = asProvider(String(req.params.provider ?? '').toLowerCase())
  const sessionId = String(req.params.sessionId ?? '')
  if (!provider) {
    res.status(400).json({ error: 'provider must be claude, codex, or cursor', reason: 'bad_provider' })
    return
  }
  try {
    const found = await findAgentSessionFile(provider, sessionId, agentSessionRoots())
    if (!found) {
      res.status(404).json({ error: 'Session not found', reason: 'session_not_found' })
      return
    }
    const st = await stat(found)
    // Oversized transcripts are READ IN PART, not refused.
    //
    // This used to answer 413 "Session too large to open" above 32 MiB, which made the
    // biggest sessions — the ones most worth reviewing before a follow-up — completely
    // unopenable on the glasses. A 67 MB transcript is not exotic; this repo's own
    // 2026-08-13 session is one. The detail page needs the opening turns, the recent
    // turns, and stats, and a bounded head+tail carries all three.
    //
    // `parsed.truncated` says so out loud, and the counts are then counts of what was
    // READ. Presenting a partial count as the session total would be the same
    // dishonesty as a silent cap, so the digest omits the number entirely instead.
    const parsed = await parseAgentSession(provider, found)
    if (provider === 'cursor') {
      const names = await loadCursorComposerNames(agentSessionRoots().cursorComposerDb)
      const named = names.get(parsed.session_id) || names.get(sessionId)
      if (named) parsed.display_label = named
    }
    const modified = st.mtime.toISOString()
    res.json({
      session_id: parsed.session_id,
      provider: parsed.provider,
      slug: parsed.session_id,
      custom_title: parsed.display_label,
      display_label: parsed.display_label,
      first_prompt: parsed.first_prompt,
      discussion_summary: parsed.discussion_summary || '',
      // Detail only. The list row (line 73) deliberately stays on the 180-char
      // summary — Miles: "it should be in the body not the title, the row should
      // be no more than the 180 characters."
      discussion_digest: parsed.discussion_digest || '',
      truncated: parsed.truncated,
      project: parsed.project,
      created: modified,
      modified,
      duration_minutes: 0,
      message_count: parsed.user_message_count + parsed.assistant_message_count,
      user_message_count: parsed.user_message_count,
      assistant_message_count: parsed.assistant_message_count,
      domain: '',
      device_id: parsed.provider,
      machine_spawned: false,
      tools_used: {},
      files_touched: [],
      git_branch: parsed.git_branch || 'unknown',
      has_subagents: false,
      total_input_tokens: 0,
      total_output_tokens: 0,
      file_size_bytes: parsed.file_size_bytes,
      omitted_tools: parsed.omitted_tools,
    })
  } catch (error) {
    console.error(`[agent-sessions] detail failed: ${error instanceof Error ? error.message : error}`)
    res.status(500).json({ error: 'Failed to read agent session', reason: 'agent_sessions_read_failed' })
  }
})
