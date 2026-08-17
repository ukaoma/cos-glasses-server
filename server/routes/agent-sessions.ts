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
import {
  occupiedThreads,
  noOccupancyKnown,
  withActiveRecently,
  type OccupiedScan,
  type OccupiedThread,
} from '../lib/occupied-threads.js'
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

/**
 * When each HELD thread's transcript was last written.
 *
 * ONLY the threads the scan already found occupied. That is the entire cost
 * argument: the occupied set is typically one or two rows out of sixty, so this
 * is one or two path resolutions and stats per request, not sixty. An empty scan
 * does no filesystem work at all.
 *
 * WHY NOT REUSE `row.modified`, WHICH IS ALREADY AN MTIME. Because for the rows
 * that matter it is not one. A live Claude row comes from `liveClaudeRows`,
 * whose `modified` is the registry's `lastActiveAt` (or, absent that, literally
 * `new Date()`), and `enrichLiveClaude` does not replace it with the file's
 * mtime. Reading freshness off that field would report an open window as a fresh
 * write on every single request, which is precisely the bug being fixed.
 *
 * Every failure lands on null, and null is doubt rather than "recent" — see
 * `isActiveRecently`. A row that cannot be measured reads OPEN, which is still
 * true of a thread with a live owner.
 */
async function transcriptMtimes(
  scan: OccupiedScan,
  rows: readonly AgentSessionRow[],
): Promise<Map<string, number | null>> {
  const mtimes = new Map<string, number | null>()
  if (scan.occupied.size === 0) return mtimes

  const providerById = new Map<string, AgentProvider>()
  for (const row of rows) providerById.set(row.session_id, row.provider)
  const roots = agentSessionRoots()

  await Promise.all([...scan.occupied.keys()].map(async threadId => {
    try {
      const provider = providerById.get(threadId)
      // An occupied id with no row cannot happen today (the scan is built FROM
      // the rows), but guessing a provider to go looking for a file is how a
      // caller-supplied id reaches the filesystem. Unknown stays unmeasured.
      if (!provider) {
        mtimes.set(threadId, null)
        return
      }
      const file = await findAgentSessionFile(provider, threadId, roots)
      mtimes.set(threadId, file ? (await stat(file)).mtimeMs : null)
    } catch {
      mtimes.set(threadId, null)
    }
  }))
  return mtimes
}

/**
 * Stamp the running hint onto a projected row.
 *
 * EXPORTED so the WIRE KEYS are covered by a behaviour test rather than by
 * reading this file. The client reads `running_active` by exact name
 * (`session-running.ts` accepts only a literal `true` on a known key), so a
 * rename here is silent on this side and renders every session as merely open on
 * the lens. Pure: it takes the scan, it does no I/O.
 */
export function withRunning<T extends { session_id: string }>(entry: T, scan: OccupiedScan) {
  const occ = scan.occupied.get(entry.session_id)
  return {
    ...entry,
    // A process HOLDS this thread open, whoever started it. Not "is generating":
    // a Claude record for an open window outlives the work by however long the
    // window stays up, which is why `running_active` exists below.
    running: occ !== undefined,
    // Held by something that is not COS, so a Continue would be refused. The
    // badge reads `running`; the Continue affordance reads this.
    running_foreign: (occ?.foreignOwners ?? 0) > 0,
    // The transcript was WRITTEN in the last few seconds: an agent is generating
    // here, not just holding the file. This is the only one of the three that
    // clears on its own when the work stops. Still a display hint, never a gate.
    running_active: occ?.activeRecently === true,
  }
}

/**
 * Occupancy plus freshness for ONE thread, for the detail route.
 *
 * WHY THE DETAIL ROUTE STAMPS THIS AT ALL. It did not, and the lens had to borrow
 * the hint from whichever list row the user tapped. That worked exactly once: the
 * detail page was a single fetch, so the borrowed flags were frozen at the moment
 * it opened and could never clear, which is half of why a finished session stayed
 * "active" on the glasses until Miles navigated away. A page that polls needs a
 * payload that carries its own liveness.
 *
 * NEARLY FREE HERE. The handler has already resolved the transcript path and
 * stat'ed it, so freshness costs nothing extra and only the single-thread
 * occupancy scan is new — the same scan `attachability` already runs on every
 * menu open. Contrast the list, where the same work would be sixty scans.
 *
 * STILL A DISPLAY HINT. Nothing about being on the detail payload makes it a
 * gate; `attach` re-probes at the write, unchanged.
 */
function runningForThread(provider: AgentProvider, threadId: string, mtimeMs: number): OccupiedScan {
  if (provider !== 'claude' && provider !== 'codex') return { occupied: new Map(), degraded: false }
  try {
    const scan = occupiedThreads(
      provider,
      [threadId],
      realOccupancyProbes(cosSpawnedPids),
      realOccupancyDirs(),
    )
    return withActiveRecently(scan, new Map([[threadId, mtimeMs]]), Date.now())
  } catch (error) {
    // The transcript is the point; occupancy is decoration. A probe failure must
    // never cost the user their session.
    console.error(`[agent-sessions] detail occupancy failed: ${error instanceof Error ? error.message : error}`)
    return noOccupancyKnown()
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
    const scan = runningThreads(sessions)
    // Freshness is layered on AFTER occupancy, and only over what occupancy
    // found. `Date.now()` is read once so every row in a payload is judged
    // against the same instant.
    const running = withActiveRecently(scan, await transcriptMtimes(scan, sessions), Date.now())
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
    const running = runningForThread(provider, parsed.session_id, st.mtimeMs)
    res.json({
      ...withRunning({ session_id: parsed.session_id }, running),
      // The client must be able to tell "this server stamped nothing" from "this
      // server stamped false", because the two demand opposite behaviour: an old
      // server's silence means keep using the hint borrowed from the list row, and
      // a new server's `false` means the thread genuinely went quiet and the
      // borrowed hint is the stale thing. Without this marker the poll could never
      // clear the flag it exists to clear.
      running_stamped: true,
      // Same meaning as on the list: a probe could not see clearly, so render
      // unknown rather than treating a quiet scan as "nothing is running".
      runningDegraded: running.degraded,
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
      // The newest assistant reply, whole. ADDITIVE: the digest above still carries
      // its own 160-char `Latest:` line, so a client that never learns this field
      // renders exactly what it rendered before. Measured at 4000 chars — see
      // LATEST_REPLY_MAX. Before this existed the detail payload had NO full-text
      // field at all, and an 1821-char reply left the Mac as 160 characters.
      latest_reply: parsed.latest_reply || '',
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
