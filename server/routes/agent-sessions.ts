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
// Does not need COS_SCRIPTS_DIR. Codex subagents stay out.
// Codex files over 32 MB still appear in the list. Cursor files over 32 MB
// are skipped and counted on `dropped.oversized`. The list payload now says
// what each cap hid.

import { ACTIVITY_READ_CONCURRENCY, activityClockMs, mapWithConcurrency, readSessionActivity, type SessionActivity } from '../lib/agent-session-activity.js'
import { Router } from 'express'
import { stat } from 'node:fs/promises'
import {
  AGENT_SESSION_LIST_LIMIT,
  AGENT_SESSION_LIST_MAX,
  AGENT_SESSION_WINDOW_HOURS,
  agentSessionRoots,
  findAgentSessionFile,
  listAgentSessions,
  emptySessionListDropped,
  loadClaudeDesktopAliases,
  loadCursorComposerNames,
  parseAgentSession,
  type AgentProvider,
  type AgentSessionRoots,
  type ClaudeAliasMap,
  type AgentSessionRow,
  type AgentSessionSort,
} from '../lib/agent-session-store.js'
import { searchAgentSessions, type AgentSessionSearchHit } from '../lib/agent-session-search.js'
import { claudeSessionNamesVisible, claudeSessionsDir, claudeSessionsEnabled, readClaudePeerRecords, registryFacts } from './claude-sessions.js'
import type { ClaudePeerRecord } from '../lib/claude-session-registry.js'
import { deriveForRow } from '../lib/session-hooks-runtime.js'
import { derivedRowFields, type DerivedSessionState } from '../lib/session-state-derive.js'
import { queuedTurnsFields, queuedWaitingLookup } from '../lib/thread-turn-queue-store.js'
import { isAttachedTurnActive, sessionStreamKey } from '../lib/session-stream-bus.js'
import { workspaceFromCwd } from '../lib/claude-session-registry.js'
import {
  occupiedThreads,
  noOccupancyKnown,
  withActiveRecently,
  isActiveRecently,
  type OccupiedScan,
  type OccupiedThread,
} from '../lib/occupied-threads.js'
import {
  codexLockSnapshot,
  peekCodexLockSnapshot,
  realOccupancyDirs,
  realOccupancyProbes,
  withLockSnapshot,
  type LockHolderSnapshot,
} from '../lib/occupancy-probes.js'
import type { OccupancyDirs } from '../lib/thread-occupancy.js'
import { parseTurnsParam, readRecentSessionTurns, type RecentTurnsRead } from '../lib/agent-session-turns.js'
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

function toSearchHit(row: AgentSessionSearchHit, queuedTurns = 0, derived?: DerivedSessionState) {
  return {
    ...toEntry(row, undefined, derived, queuedTurns),
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
function runningThreads(rows: readonly AgentSessionRow[], dirs: OccupancyDirs, snapshot: LockHolderSnapshot | null): OccupiedScan {
  try {
    // The spawn ledger is what lets a turn COS itself queued read as ours rather
    // than as a foreign desktop window holding the thread.
    //
    // Codex lock holders come from ONE batched lsof taken for the whole request
    // (see `codexLockSnapshot`), not one 2.3 s synchronous scan per listed row.
    // With no snapshot — the batch failed — the wrapped probe runs exactly as
    // before, so the worst case is the old cost, never a wrong verdict.
    const base = realOccupancyProbes(cosSpawnedPids)
    const probes = snapshot ? withLockSnapshot(base, snapshot) : base
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
  roots: AgentSessionRoots,
  aliases: ClaudeAliasMap,
): Promise<Map<string, number | null>> {
  const mtimes = new Map<string, number | null>()
  if (scan.occupied.size === 0) return mtimes

  const providerById = new Map<string, AgentProvider>()
  for (const row of rows) providerById.set(row.session_id, row.provider)

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
      // The shared alias map: this used to rebuild it from 564 files per held thread.
      const file = await findAgentSessionFile(provider, threadId, roots, new Date(), aliases)
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
 * "active" on the glasses until the user navigated away. A page that polls needs a
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
  // Cursor: no process registry. The detail handler already stat'ed the jsonl;
  // freshness of that file is the only honest working signal for the lens.
  // Occupancy (the write gate) uses chats-dir resolution, not this hint.
  if (provider === 'cursor') {
    if (!isActiveRecently(mtimeMs, Date.now())) return { occupied: new Map(), degraded: false }
    return {
      occupied: new Map([[threadId, { threadId, owners: 1, foreignOwners: 0, activeRecently: true }]]),
      degraded: false,
    }
  }
  if (provider !== 'claude' && provider !== 'codex') return { occupied: new Map(), degraded: false }
  try {
    const dirs = realOccupancyDirs()
    // A detail open inside LOCK_SNAPSHOT_TTL_MS of a list answers from that list's
    // snapshot; otherwise the single synchronous probe runs as it always has.
    const snapshot = peekCodexLockSnapshot(dirs.codexLocksDir)
    const base = realOccupancyProbes(cosSpawnedPids)
    const scan = occupiedThreads(
      provider,
      [threadId],
      snapshot ? withLockSnapshot(base, snapshot) : base,
      dirs,
    )
    return withActiveRecently(scan, new Map([[threadId, mtimeMs]]), Date.now())
  } catch (error) {
    // The transcript is the point; occupancy is decoration. A probe failure must
    // never cost the user their session.
    console.error(`[agent-sessions] detail occupancy failed: ${error instanceof Error ? error.message : error}`)
    return noOccupancyKnown()
  }
}

function toEntry(row: AgentSessionRow, activity?: SessionActivity | null, derived?: DerivedSessionState, queuedTurns = 0) {
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
    // 6.45.5: when the session last DID something and its last tool, read from the
    // transcript's own records (lib/agent-session-activity.ts). Omitted, not null, when
    // unknown, so an older client and a Cursor row see exactly the payload they did.
    ...(activity?.lastActivityAt ? { last_activity_at: activity.lastActivityAt } : {}),
    ...(activity?.lastTool ? { last_tool: activity.lastTool } : {}),
    // 6.48.0: the one derived state (hook > registry > transcript) with its provenance.
    // Under a NEW key: `state` above is `running|recent` and Control renders any other
    // value there as "Running". Omitted entirely when nothing is known, like the two above.
    ...derivedRowFields(derived),
    // 6.48.1: waiting follow-ups on this thread. Omitted at 0 so an older client
    // and a quiet row look the same as 6.48.0.
    ...queuedTurnsFields(queuedTurns),
  }
}

async function liveClaudePeerRecords(): Promise<ClaudePeerRecord[]> {
  if (!claudeSessionsEnabled()) return []
  return readClaudePeerRecords(claudeSessionsDir(), undefined, claudeSessionNamesVisible())
}

function liveClaudeRows(peers: ClaudePeerRecord[]): AgentSessionRow[] {
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
    const roots = agentSessionRoots()
    const dirs = realOccupancyDirs()
    // The lock probe is a 2-3 s lsof that needs only the locks directory, so it
    // starts NOW and runs under the walk instead of after it. A failed batch is
    // logged and the scan below falls back to the per-lock probe.
    const snapshotPromise: Promise<LockHolderSnapshot | null> = codexLockSnapshot(dirs.codexLocksDir).catch(error => {
      console.error(`[agent-sessions] lock snapshot failed: ${error instanceof Error ? error.message : error}`)
      return null
    })
    // ONE alias load per request, shared by the walk, every live row and every
    // held thread. Measured 2026-09-10: sixteen loads of 119 MB before this line.
    const aliases = await loadClaudeDesktopAliases(roots.claudeCodeSessions)
    const peers = await liveClaudePeerRecords()
    const live = liveClaudeRows(peers)
    const dropped = emptySessionListDropped()
    const sessions = await listAgentSessions(roots, new Date(), live, limit, sort, dropped, aliases)
    // 6.45.5: each row's last real activity, read from its transcript records. Memoized on
    // mtime and size, so a steady poll re-reads nothing; bounded so a cold list of 80 rows
    // never holds 80 descriptors at once.
    const activity = await mapWithConcurrency(sessions, ACTIVITY_READ_CONCURRENCY, row =>
      row.file ? readSessionActivity(row.provider, row.file) : Promise.resolve(null))
    const activityById = new Map(sessions.map((row, index) => [row.session_id, activity[index]]))
    const scan = runningThreads(sessions, dirs, await snapshotPromise)
    // Freshness is layered on AFTER occupancy, and only over what occupancy
    // found. Cursor has no process occupancy, so the list does not invent a
    // working hint from jsonl mtime — detail still can, from the file it stat'ed.
    // 6.45.5: judged by the last real record when it is known, so a relaunch's bookkeeping
    // write no longer reads as 30 seconds of work on every held session.
    const clocks = await transcriptMtimes(scan, sessions, roots, aliases)
    for (const [threadId, mtimeMs] of clocks) {
      if (mtimeMs !== null) clocks.set(threadId, activityClockMs(mtimeMs, activityById.get(threadId)))
    }
    const running = withActiveRecently(scan, clocks, Date.now())
    // Derived AFTER the walk: live rows carry the registry's eight-character id until
    // `enrichLiveClaude` finds their transcript, and the deriver wants the full one where
    // it exists. The registry facts are joined back by prefix; a transcript-only row (an
    // ended job, a tab closed hours ago) still gets a state from its activity clock.
    const now = Date.now()
    // First wins, and `readClaudePeerRecords` sorts alive first: a dead predecessor's file
    // (a resumed tab, a finished Continue child) must never shadow the live record.
    const peersByPrefix = new Map<string, ClaudePeerRecord>()
    for (const peer of peers) {
      const prefix = peer.sessionId.slice(0, 8)
      if (!peersByPrefix.has(prefix)) peersByPrefix.set(prefix, peer)
    }
    const derivedById = new Map<string, DerivedSessionState | undefined>()
    for (const row of sessions) {
      if (row.provider !== 'claude') continue
      const peer = peersByPrefix.get(row.session_id.slice(0, 8).toLowerCase())
      const hint = running.occupied.get(row.session_id)
      derivedById.set(row.session_id, deriveForRow({
        sessionId: row.session_id,
        registry: peer ? registryFacts(peer) : undefined,
        transcript: {
          inFlight: hint?.activeRecently === true,
          lastActivityAt: activityById.get(row.session_id)?.lastActivityAt ? Date.parse(activityById.get(row.session_id)!.lastActivityAt!) : null,
        },
        now,
        attachedTurn: isAttachedTurnActive(sessionStreamKey('claude', row.session_id)),
      }))
    }
    const queuedOf = queuedWaitingLookup(now)
    res.json({
      sessions: sessions.map((row, index) => withRunning(toEntry(row, activity[index], derivedById.get(row.session_id), queuedOf(row.provider, row.session_id)), running)),
      total: sessions.length,
      windowHours: AGENT_SESSION_WINDOW_HOURS,
      sort,
      enabled: true,
      // True when a probe could not see clearly. The client must render "unknown"
      // rather than treating a quiet scan as "nothing is running".
      runningDegraded: running.degraded,
      // LIST caps that previously dropped rows with no signal. Additive: an older
      // client ignores this key. Zero means the walk found nothing to hide, not
      // that the caps are off.
      dropped,
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
    const queuedOf = queuedWaitingLookup(Date.now())
    // 6.48.1: search hits carry the same derived state as list rows (no list/search shape
    // drift), from the registry and the hook signal; a hit has no transcript walk.
    const peers = await liveClaudePeerRecords()
    const peersByPrefix = new Map<string, ClaudePeerRecord>()
    for (const peer of peers) {
      const prefix = peer.sessionId.slice(0, 8)
      if (!peersByPrefix.has(prefix)) peersByPrefix.set(prefix, peer)
    }
    const derivedFor = (hit: AgentSessionSearchHit): DerivedSessionState | undefined => {
      if (hit.provider !== 'claude') return undefined
      const peer = peersByPrefix.get(hit.session_id.slice(0, 8).toLowerCase())
      return deriveForRow({
        sessionId: hit.session_id,
        registry: peer ? registryFacts(peer) : undefined,
        transcript: hit.modified ? { inFlight: false, lastActivityAt: Date.parse(hit.modified) } : undefined,
        attachedTurn: isAttachedTurnActive(sessionStreamKey('claude', hit.session_id)),
        remember: false,
      })
    }
    res.json({
      ...result,
      hits: result.hits.map(hit => toSearchHit(hit, queuedOf(hit.provider, hit.session_id), derivedFor(hit))),
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
    // 6.50.0 `?turns=N`: the recent conversation, for the lens's scroll-up history. Only
    // when asked, so the detail poll and every older client get the same bytes as before.
    // A failure here costs the history, never the detail page.
    const turnsWanted = parseTurnsParam(req.query.turns)
    let recentTurns: RecentTurnsRead | null = null
    if (turnsWanted !== null) {
      try {
        recentTurns = await readRecentSessionTurns(provider, found, turnsWanted)
      } catch (error) {
        console.warn(`[agent-sessions] recent turns failed provider=${provider}: ${error instanceof Error ? error.message : error}`)
      }
    }
    if (provider === 'cursor') {
      const names = await loadCursorComposerNames(agentSessionRoots().cursorComposerDb)
      const named = names.get(parsed.session_id) || names.get(sessionId)
      if (named) parsed.display_label = named
    }
    const modified = st.mtime.toISOString()
    const activity = await readSessionActivity(provider, found)
    const running = runningForThread(provider, parsed.session_id, activityClockMs(st.mtimeMs, activity))
    // 6.48.0: the detail carries the same derived state as its list row. The registry is
    // read once here (a few hundred small files at most) because the detail has no walk.
    let derived: DerivedSessionState | undefined
    if (provider === 'claude') {
      const peer = (await liveClaudePeerRecords()).find(p => p.sessionId === parsed.session_id.toLowerCase()) // alive first
      derived = deriveForRow({
        sessionId: parsed.session_id,
        registry: peer ? registryFacts(peer) : undefined,
        transcript: { inFlight: running.occupied.get(parsed.session_id)?.activeRecently === true, lastActivityAt: activity.lastActivityAt ? Date.parse(activity.lastActivityAt) : null },
        attachedTurn: isAttachedTurnActive(sessionStreamKey('claude', parsed.session_id)),
      })
    }
    res.json({
      ...withRunning({ session_id: parsed.session_id }, running),
      ...derivedRowFields(derived),
      ...queuedTurnsFields(queuedWaitingLookup(Date.now())(provider, parsed.session_id)),
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
      // summary — the user: "it should be in the body not the title, the row should
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
      ...(activity.lastActivityAt ? { last_activity_at: activity.lastActivityAt } : {}),
      ...(activity.lastTool ? { last_tool: activity.lastTool } : {}),
      ...(recentTurns ? { recent_turns: recentTurns.turns, recent_turns_more: recentTurns.more } : {}),
    })
  } catch (error) {
    console.error(`[agent-sessions] detail failed: ${error instanceof Error ? error.message : error}`)
    res.status(500).json({ error: 'Failed to read agent session', reason: 'agent_sessions_read_failed' })
  }
})
