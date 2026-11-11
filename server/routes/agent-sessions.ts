import { workObservationFields } from '../lib/session-work-observation.js'
import { readCodexSubagentsAcross } from '../lib/codex-subagent-activity.js'
import { listKeyedSessions } from '../lib/keyed-sessions.js'
import { codexProfileHome } from '../lib/codex-homes.js'
import { join as joinPath } from 'node:path'

/** Key lanes (P11): a keyed Codex thread's own sessions root (P3's keyed-session record). */
function keyedCodexRootOf(): (id: string) => string | undefined {
  const byId = new Map(listKeyedSessions().filter(r => r.engine === 'codex').map(r => [r.id.toLowerCase(), joinPath(codexProfileHome(r.profileId), 'sessions')]))
  return id => byId.get(id.toLowerCase())
}
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
  codexSessionRootsOf,
  loadCodexThreadNamesAll,
  idFromCodexFilename,
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
import { deriveForRow, signalFor, workObservationFor } from '../lib/session-hooks-runtime.js'
import { derivedRowFields, type DerivedSessionState, type RegistryFacts } from '../lib/session-state-derive.js'
import type { WorkObservation } from '../lib/session-work-observation.js'
import type { SessionSignal } from '../lib/session-signal-store.js'
import { HOOK_ACTIVE_CAP_MS, codexRolloutFacts, type CodexRolloutFacts } from '../lib/codex-rollout-state.js'
import { queuedTurnsFields, allQueuedWaitingLookup } from '../lib/thread-turn-queue-store.js'
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
import { redactLocalPathsDeep } from '../lib/local-path-redact.js'
import { isNativeMacCaller } from '../lib/native-mac-caller.js'
import { cosSpawnedPids } from '../lib/agent-session-ownership-store.js'
import { sessionActFactsFor, sessionActFields } from '../lib/session-act-fields.js'
import { CONTINUE_NOTE_HEADER, continueNoteAcknowledged } from '../lib/continue-plan.js'

import { agentSessionOutputImages, sharedFileHeaders } from '../lib/agent-session-output-images.js'
import { previewErrorCode } from '../lib/preview-error-code.js'
import { resetPreviewLogThrottle, warnPreviewThrottled } from '../lib/preview-log-throttle.js'
import { sessionFilesSetting, withoutPreviews } from '../lib/session-files-setting.js'
import { withoutLinkMarkers } from '../lib/session-links.js'
import { createSessionPreviewRouter } from './session-preview.js'
import { organizerKey, sessionOrganizer, type OrganizerRowFields } from '../lib/session-organizer.js'
import { listOlderSessions, shortRowFor, OLDER_DEFAULT_DAYS, OLDER_DEFAULT_LIMIT, OLDER_MAX_DAYS, OLDER_MAX_LIMIT, OLDER_MIN_DAYS } from '../lib/agent-session-older.js'
import { cachedListModel, warmListModels } from '../lib/list-model-memo.js'
import { cosStartedSessionIds } from '../lib/cos-started-sessions.js'

/** Step 2a: the organizer, or null when it is unavailable or empty (the list is then exactly today's). */
function organizerForList(): ReturnType<typeof sessionOrganizer> | null {
  try {
    const o = sessionOrganizer()
    return o.isAvailable() && !o.isEmpty() ? o : null
  } catch {
    return null
  }
}
/** Claude Desktop ids per CLI id, from the request's alias table (an entry written under a Desktop id still matches). */
function desktopIdsByCli(aliases: ClaudeAliasMap | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [desktopId, head] of aliases ?? new Map()) {
    const cli = head?.cliSessionId
    if (!cli || cli.startsWith('!')) continue
    out.set(cli, [...(out.get(cli) ?? []), desktopId])
  }
  return out
}
function organizerFieldsOf(o: ReturnType<typeof sessionOrganizer> | null, provider: string, sessionId: string, desktopIds?: Map<string, string[]>): OrganizerRowFields {
  if (!o) return {}
  const id = sessionId.toLowerCase()
  return o.fieldsForAny([organizerKey(provider, id)], provider === 'claude' ? desktopIds?.get(id) ?? [] : [])
}

export const agentSessionsRouter = Router()
// Preview engine phase 1: GET /api/preview/agent-sessions/... and /api/preview-folders/settings (routes/session-preview.ts).
agentSessionsRouter.use(createSessionPreviewRouter())

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

function toSearchHit(row: AgentSessionSearchHit, queuedTurns: number | null = 0, derived?: DerivedSessionState) {
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
export function withRunning<T extends { session_id: string }>(entry: T, scan: OccupiedScan, hint: RunningHint | null = null) {
  const occ = scan.occupied.get(entry.session_id)
  // 6.62.0: a Cursor row with hook evidence is decided by it (there is no process occupancy
  // for Cursor, and its file time says nothing once the hooks have spoken).
  const decides = hint?.decides === true
  return {
    ...entry,
    // A process HOLDS this thread open, whoever started it. Not "is generating":
    // a Claude record for an open window outlives the work by however long the
    // window stays up, which is why `running_active` exists below.
    running: decides ? hint!.running : occ !== undefined || hint?.running === true,
    // Held by something that is not COS, so a Continue would be refused. The
    // badge reads `running`; the Continue affordance reads this.
    running_foreign: (occ?.foreignOwners ?? 0) > 0 || hint?.foreign === true,
    // The transcript was WRITTEN in the last few seconds: an agent is generating
    // here, not just holding the file. This is the only one of the three that
    // clears on its own when the work stops. Still a display hint, never a gate.
    // 6.62.0: or the engine's own hooks (or a Codex rollout) say a turn is open and the
    // last event is inside HOOK_ACTIVE_CAP_MS (plan 1.1-1.3).
    running_active: decides || hint?.activeDecides === true ? hint!.active : occ?.activeRecently === true || hint?.active === true,
  }
}

/**
 * 6.62.0 (plan 1.1-1.3): what the engine's own evidence says about working, for `withRunning`.
 *
 * A DISPLAY HINT, NEVER A GATE: the write gate (`thread-occupancy.ts`) is untouched. An open
 * turn reads active only while its last event is inside HOOK_ACTIVE_CAP_MS: an Esc with no
 * Stop, a crash, a Cursor abort leave a turn open, and the half-hour open-turn ceiling would
 * otherwise show a ghost "working" row for thirty minutes (W5).
 *
 *   hook running, last event inside the cap   running, active (every provider)
 *   hook running, quiet past the cap          Cursor: running, NOT active (OPEN, quiet: a
 *                                             tool can run longer than the cap with no event,
 *                                             and an Esc with no Stop looks the same, QA W8);
 *                                             Claude and Codex: no hint (occupancy answers)
 *   hook waiting                               running, not active
 *   hook or registry idle (Claude, Codex)      not active even if the file was just written
 *                                             (a flush after Stop), unless the transcript's
 *                                             newest record is more than
 *                                             TRANSCRIPT_AFTER_IDLE_GRACE_MS past the idle
 *                                             signal: then no hint (occupancy freshness
 *                                             answers, a hookless restarted turn)
 *   hook or registry waiting, ended, failed    not active, ownership kept (Cursor: decided)
 *   Codex rollout turn open inside the cap     running, active (no Codex hooks yet)
 *   Cursor, any other hook state               not running, not active (`decides`)
 *
 * A hook-derived `running` only exists inside the deriver's 30-minute open-turn ceiling, so an
 * open-quiet Cursor row ends there, or at its Stop or SessionEnd.
 *
 * For Claude and Codex, authoritative idle/waiting states suppress recent-write activity
 * for display while leaving ownership intact. Other hints add to occupancy. For Cursor,
 * whose list has no occupancy at all, a hook signal decides, and
 * a running Cursor turn is the user's own (an IDE composer or their terminal; COS's own child
 * is kept out of the phase), so it is foreign.
 */
export interface RunningHint {
  running: boolean
  active: boolean
  foreign: boolean
  /** Cursor with hook evidence: this hint IS the answer, occupancy and file time are not read. */
  decides: boolean
  /** Authoritative non-working state suppresses file-write activity without changing occupancy. */
  activeDecides?: boolean
}

/**
 * A transcript write this long after the idle signal is new work, not the flush that
 * trails a Stop. Claude writes its last records around the Stop hook; a turn that wakes
 * later (a background-task notification restarts a text-only turn, with no prompt and no
 * tool call, so no hook fires until its Stop) writes well past this.
 */
export const TRANSCRIPT_AFTER_IDLE_GRACE_MS = 5_000

export function runningHintFor(provider: AgentProvider, derived: DerivedSessionState | undefined, lastEventAt: number | null, now: number, transcriptAt: number | null = null): RunningHint | null {
  const cursor = provider === 'cursor'
  const quiet: RunningHint | null = cursor ? { running: false, active: false, foreign: false, decides: true } : null
  if (!derived) return null
  // The state deriver already arbitrates fresh work, waits and completed turns.
  // A transcript flush after Stop must not turn an idle/waiting badge back to
  // working. Keep ownership/open-window evidence intact: this is display only.
  if ((derived.state_source === 'hook' || derived.state_source === 'registry') && derived.agent_state !== 'running') {
    // An idle signal OLDER than the transcript's newest real record is not the latest
    // word: a turn restarted with no hook (see TRANSCRIPT_AFTER_IDLE_GRACE_MS) is writing.
    // Fall back to occupancy freshness. Idle only: waiting keeps `running: true` and its
    // question; ended and failed stay settled. Cursor's transcript has no clock.
    if (!cursor && derived.agent_state === 'idle' && transcriptAt !== null) {
      const since = Date.parse(derived.state_since)
      const signalAt = Math.max(Number.isFinite(since) ? since : 0, derived.state_source === 'hook' ? lastEventAt ?? 0 : 0)
      if (transcriptAt > signalAt + TRANSCRIPT_AFTER_IDLE_GRACE_MS) return null
    }
    if (cursor) return derived.agent_state === 'waiting'
      ? { running: true, active: false, foreign: true, decides: true }
      : quiet
    return { running: derived.agent_state === 'waiting', active: false, foreign: false, decides: false, activeDecides: true }
  }
  const inCap = lastEventAt !== null && now - lastEventAt <= HOOK_ACTIVE_CAP_MS && lastEventAt <= now + 5_000
  if (derived.state_source === 'hook') {
    if (derived.agent_state === 'running' && inCap) return { running: true, active: true, foreign: cursor, decides: cursor }
    if (derived.agent_state === 'running' && cursor) return { running: true, active: false, foreign: true, decides: true }
    return quiet
  }
  if (provider === 'codex' && derived.state_source === 'transcript' && derived.agent_state === 'running' && inCap) {
    return { running: true, active: true, foreign: false, decides: false }
  }
  return null
}

/** The newest thing a signal heard: an event, or (Cursor) a thought. */
function signalLastAt(signal: SessionSignal | undefined): number | null {
  if (!signal) return null
  return Math.max(signal.lastEventAt, signal.lastThought?.at ?? 0)
}

/** A Codex thread with a writer-lock holder: alive, with no status of its own (W6). */
const CODEX_HOLDER_FACTS: RegistryFacts = { alive: true, status: null, waitingFor: null, statusUpdatedAt: null, lastActiveAt: null }

/**
 * 6.62.0 (plan 1.3): one derivation for a Codex row. The hooks when they have spoken; else the
 * rollout's own turn markers, read for a thread written inside the cap. Registry facts only
 * when a writer-lock holder exists: passing "dead" facts for every unloaded thread would end
 * each of them after two scans (session-state-derive.ts).
 */
function deriveCodexRow(sessionId: string, held: boolean, facts: CodexRolloutFacts | null, now: number, remember = true): DerivedSessionState | undefined {
  return deriveForRow({
    sessionId,
    registry: held ? CODEX_HOLDER_FACTS : undefined,
    transcript: facts ? { inFlight: facts.open, lastActivityAt: facts.mtimeMs } : undefined,
    now,
    remember,
    attachedTurn: isAttachedTurnActive(sessionStreamKey('codex', sessionId)),
  })
}

/** The evidence clock a row's hint is judged by: the hooks, else (Codex) the rollout write. */
function hintClock(signal: SessionSignal | undefined, derived: DerivedSessionState | undefined, facts: CodexRolloutFacts | null): number | null {
  if (derived?.state_source === 'hook') return signalLastAt(signal)
  return facts?.mtimeMs ?? null
}

/**
 * 6.62.0 (plan 1.9): Codex compaction. Codex's PreCompact hook opens it; the rollout's
 * `ContextCompaction` item, written when it is over, closes it (as does the PostCompact hook).
 */
function codexCompactionFields(observation: WorkObservation | undefined, facts: CodexRolloutFacts | null, now: number): ReturnType<typeof workObservationFields> {
  if (!observation || observation.compactingAt === null) return {}
  if (facts?.compactedAt != null && facts.compactedAt >= observation.compactingAt) return {}
  const { compaction } = workObservationFields({ ...observation, agents: [], partial: false }, now)
  return compaction ? { compaction } : {}
}

/** 6.62.0 (plan 1.1): a Cursor row's last activity is its last hook event; the transcript has no clock. */
function cursorActivityFields(provider: AgentProvider, signal: SessionSignal | undefined): { last_activity_at?: string } {
  if (provider !== 'cursor') return {}
  const at = signalLastAt(signal)
  return at ? { last_activity_at: new Date(at).toISOString() } : {}
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

function toEntry(row: AgentSessionRow, activity?: SessionActivity | null, derived?: DerivedSessionState, queuedTurns: number | null = 0) {
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
    // Step 2a: COS pins and folder members are listed at any age, outside the cap and `limit`.
    const organizer = organizerForList()
    const desktopIds = organizer ? desktopIdsByCli(aliases) : undefined
    // Miles, 2026-11-10: sessions a COS job started in the last 7 days stay listed (memoized journal read).
    const started = await cosStartedSessionIds()
    const sessions = await listAgentSessions(roots, new Date(), live, limit, sort, dropped, aliases, organizer ? organizer.keptIds() : {}, started)
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
    // 6.51.0: a Cursor composer whose OWN hook events reached the store (Cursor runs the COS
    // session hook from ~/.claude/settings.json) gets the same one derivation, from the
    // signal alone. Hook-grounded only: a Cursor row with no events keeps exactly the 6.50
    // shape, and nothing is inferred from its file times here.
    for (const row of sessions) {
      if (row.provider !== 'cursor' || !signalFor(row.session_id)) continue
      derivedById.set(row.session_id, deriveForRow({ sessionId: row.session_id, now, remember: false }))
    }
    // 6.62.0 (plan 1.3): Codex rows get the one derivation too, from the hooks or the rollout.
    const rolloutById = new Map<string, CodexRolloutFacts | null>()
    for (const row of sessions) {
      if (row.provider !== 'codex') continue
      const facts = codexRolloutFacts(row.file, now)
      rolloutById.set(row.session_id, facts)
      derivedById.set(row.session_id, deriveCodexRow(row.session_id, running.occupied.has(row.session_id), facts, now))
    }
    const queuedOf = await allQueuedWaitingLookup(now)
    const codexRoots = codexSessionRootsOf(roots)
    const subagents = await readCodexSubagentsAcross(sessions.filter(row => row.provider === 'codex').map(row => row.session_id), codexRoots, now, codexRoots.length > 1 ? keyedCodexRootOf() : undefined)
    // 7.0.4 S1: no absolute Mac path in any string a list row carries (titles, first prompts, summaries).
    res.json(redactLocalPathsDeep({
      sessions: sessions.map((row, index) => {
        const derived = derivedById.get(row.session_id)
        const signal = signalFor(row.session_id)
        const facts = rolloutById.get(row.session_id) ?? null
        const hint = runningHintFor(row.provider, derived, hintClock(signal, derived, facts), now, clocks.get(row.session_id) ?? null)
        // Step 2a: the model only from the memo (never a read on the list path, 6.62.0 W11).
        const model = cachedListModel(row.provider, row.file, Number.isFinite(Date.parse(row.modified)) ? Date.parse(row.modified) : null)
        return {
          ...withRunning(toEntry(row, activity[index], derived, queuedOf(row.provider, row.session_id)), running, hint),
          ...organizerFieldsOf(organizer, row.provider, row.session_id, desktopIds),
          ...(model ? { reported_model: model } : {}),
          ...cursorActivityFields(row.provider, signal),
          ...(row.provider === 'codex'
            ? { ...(subagents.has(row.session_id) ? { subagent_activity: subagents.get(row.session_id) } : {}), ...codexCompactionFields(workObservationFor(row.session_id), facts, now) }
            : workObservationFields(workObservationFor(row.session_id), now)),
        }
      }),
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
      ...(organizer ? { organizer: { rev: organizer.rev() } } : {}),
    }))
    // Step 2a: read the models this answer lacked, in the background, for a later poll. Never awaited.
    warmListModels(sessions)
  } catch (error) {
    console.error(`[agent-sessions] list failed: ${error instanceof Error ? error.message : error}`)
    res.status(500).json({ error: 'Failed to read agent sessions', reason: 'agent_sessions_read_failed' })
  }
})

// Step 2a (S1_CONTRACT_step2a.md B2): the last `days` days in a short form, paged, for the compact groups. Not on the
// list poll: fetched when the list opens and as a group unfolds. Live rows, COS-kept rows and each agent's own pins are
// left out (the main list has them in full); a row may still also be in the main list, and the client keeps that one.
agentSessionsRouter.get('/agent-sessions/older', async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  try {
    const days = boundedInteger(req.query.days, OLDER_DEFAULT_DAYS, OLDER_MIN_DAYS, OLDER_MAX_DAYS)
    const limit = boundedInteger(req.query.limit, OLDER_DEFAULT_LIMIT, 1, OLDER_MAX_LIMIT)
    const beforeRaw = typeof req.query.before === 'string' ? Date.parse(req.query.before) : NaN
    if (typeof req.query.before === 'string' && !Number.isFinite(beforeRaw)) {
      res.status(400).json({ error: 'before must be an ISO time', reason: 'invalid_before' })
      return
    }
    const roots = agentSessionRoots()
    const aliases = await loadClaudeDesktopAliases(roots.claudeCodeSessions)
    const organizer = organizerForList()
    const kept = organizer ? organizer.keptIds() : { claude: new Set<string>(), codex: new Set<string>(), cursor: new Set<string>() }
    const started = await cosStartedSessionIds()
    for (const provider of ['claude', 'codex', 'cursor'] as const) for (const id of started[provider]) kept[provider].add(id)
    // Kept Claude ids may be Desktop ids; the walk names transcripts by CLI id.
    for (const id of [...kept.claude]) { const cli = aliases.get(id)?.cliSessionId; if (cli && !cli.startsWith('!')) kept.claude.add(cli) }
    const liveIds = new Set(liveClaudeRows(await liveClaudePeerRecords()).map(row => row.session_id.toLowerCase()))
    const result = await listOlderSessions(roots, new Date(), {
      days, limit, aliases,
      ...(Number.isFinite(beforeRaw) ? { before: beforeRaw } : {}),
      // Kept rows come back here at any age: the main list holds at most KEPT_LIST_MAX of them (Q1 FIX 1).
      exclude: { claude: liveIds },
      keep: kept,
    })
    res.json(redactLocalPathsDeep({
      sessions: result.rows.map(row => ({ ...row, ...organizerFieldsOf(organizer, row.provider, row.session_id, desktopIdsByCli(aliases)) })),
      windowDays: days,
      next_before: result.nextBefore,
      ...(Number.isFinite(beforeRaw) ? {} : { older_than_window: result.olderThanWindow }),
    }))
  } catch (error) {
    console.error(`[agent-sessions] older list failed: ${error instanceof Error ? error.message : error}`)
    res.status(500).json({ error: 'Failed to read older agent sessions', reason: 'agent_sessions_read_failed' })
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
    // Step 2a: a session renamed in COS is found by its new title too (the agent's own title still matches as before).
    const organizer = organizerForList()
    if (organizer) {
      const seen = new Set(result.hits.map(hit => organizerKey(hit.provider, hit.session_id)))
      const roots = agentSessionRoots()
      const extra: AgentSessionSearchHit[] = []
      for (const match of organizer.titleMatches(query)) {
        if (seen.has(organizerKey(match.provider, match.session_id)) || extra.length + result.hits.length >= limit) continue
        const file = await findAgentSessionFile(match.provider, match.session_id, roots).catch(() => null)
        const short = file ? await shortRowFor(match.provider, file, undefined, roots) : null
        if (!short) continue
        extra.push({ session_id: short.session_id, provider: short.provider, display_label: short.display_label, project: short.project,
          modified: short.modified, created: short.created, alive: false, state: 'recent', pinned: false,
          snippet: '', keywordScore: 1, semanticScore: 0, match: 'keyword' })
      }
      result.hits = [...extra, ...result.hits]
    }
    const queuedOf = await allQueuedWaitingLookup(Date.now())
    // 6.48.1: search hits carry the same derived state as list rows (no list/search shape
    // drift), from the registry and the hook signal; a hit has no transcript walk.
    const peers = await liveClaudePeerRecords()
    const peersByPrefix = new Map<string, ClaudePeerRecord>()
    for (const peer of peers) {
      const prefix = peer.sessionId.slice(0, 8)
      if (!peersByPrefix.has(prefix)) peersByPrefix.set(prefix, peer)
    }
    const derivedFor = (hit: AgentSessionSearchHit): DerivedSessionState | undefined => {
      // 6.62.0 (plan 1.3): a Codex or Cursor hit the hooks have spoken for gets the same state
      // as its row, from the signal alone (a hit has no transcript walk).
      if (hit.provider !== 'claude') return signalFor(hit.session_id) ? deriveForRow({ sessionId: hit.session_id, remember: false, attachedTurn: isAttachedTurnActive(sessionStreamKey(hit.provider, hit.session_id)) }) : undefined
      const peer = peersByPrefix.get(hit.session_id.slice(0, 8).toLowerCase())
      return deriveForRow({
        sessionId: hit.session_id,
        registry: peer ? registryFacts(peer) : undefined,
        transcript: hit.modified ? { inFlight: false, lastActivityAt: Date.parse(hit.modified) } : undefined,
        attachedTurn: isAttachedTurnActive(sessionStreamKey('claude', hit.session_id)),
        remember: false,
      })
    }
    // 7.0.4 S1: search hits carry snippets of the same words.
    res.json(redactLocalPathsDeep({
      ...result,
      hits: result.hits.map(hit => ({ ...toSearchHit(hit, queuedOf(hit.provider, hit.session_id), derivedFor(hit)), ...organizerFieldsOf(organizer, hit.provider, hit.session_id) })),
    }))
  } catch (error) {
    console.error(`[agent-sessions] search failed: ${error instanceof Error ? error.message : error}`)
    res.status(500).json({ error: 'Failed to search agent sessions', reason: 'agent_sessions_search_failed' })
  }
})

/** 7.0.4 S2: the 403 every local-file route answers for a file whose name says it may hold secrets. */
export const SECRET_FILE_DENIED = 'secret_file_denied'
/** 7.0.4 QA: the 503 a preview answers when the Mac is already reading its limit of previews (not unreachable). */
export const PREVIEWS_BUSY = 'previews_busy'

type PreviewKind = 'output_image' | 'tool_image' | 'sent_file'
/**
 * 7.0.4 QA: every preview refusal and failure is logged with its kind and a reason code, never a path or a session's
 * words. A burst of the same reason (a page of thumbnails while the reader is full) logs once per 10 seconds, with the
 * count it held back (lib/preview-log-throttle.ts, shared with the preview engine routes since 7.0.7).
 */
export function logPreviewOutcome(kind: PreviewKind, reason: string, now = Date.now()): void {
  warnPreviewThrottled(kind + ':' + reason, `[agent-sessions] preview ${kind} refused reason=${reason}`, now)
}
/** Tests only: forget the burst window, so each case logs. */
export { resetPreviewLogThrottle }
/** The answer for a preview read that did not succeed, logged (a missing id is ordinary and is not). */
function previewRefusal(res: import('express').Response, kind: PreviewKind, status: 'not_found' | 'unavailable' | 'too_large' | 'secret' | 'busy'): void {
  const noun = kind === 'sent_file' ? 'file' : 'image'
  if (status !== 'not_found') logPreviewOutcome(kind, status === 'secret' ? SECRET_FILE_DENIED : status)
  if (status === 'secret') { res.status(403).json({ error: SECRET_FILE_DENIED }); return }
  if (status === 'not_found') { res.status(404).json({ error: `${noun}_not_found` }); return }
  if (status === 'too_large') { res.status(413).json({ error: `${noun}_too_large` }); return }
  if (status === 'busy') { res.set('Retry-After', '2'); res.status(503).json({ error: PREVIEWS_BUSY }); return }
  res.status(503).json({ error: `${noun}_unavailable` })
}

// Authenticated by index.ts's shared /api gate. Neither the request nor the response
// carries a filesystem path; the resolver reauthorizes exact transcript membership.
agentSessionsRouter.get('/agent-sessions/:provider/:sessionId/output-images/:imageId/content', async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  res.set('X-Content-Type-Options', 'nosniff')
  // 6.99.35: "Show files and images your sessions make" off answers before anything is read.
  if (!sessionFilesSetting.read().enabled) { res.status(403).json({ error: 'previews_off' }); return }
  const provider = asProvider(String(req.params.provider ?? '').toLowerCase())
  if (!provider || (req.query.variant !== undefined && req.query.variant !== 'thumb' && req.query.variant !== 'phone')) {
    res.status(404).json({ error: 'image_not_found' }); return
  }
  try {
    const content = await agentSessionOutputImages.content(provider, String(req.params.sessionId), String(req.params.imageId), req.query.variant === 'thumb' ? 'thumb' : 'phone')
    // 7.0.4 S2: the id was authorized, and the file's name says it may hold secrets (lib/secret-path-guard.ts).
    if (content.status !== 'ok') { previewRefusal(res, 'output_image', content.status === 'expired' ? 'unavailable' : content.status); return }
    res.type('image/jpeg')
    // `send` defaults to `dotfiles: 'ignore'` and applies it to the WHOLE absolute path
    // when no `root` is given, so a media root under `~/.cos-glasses/data` 404'd on
    // every default install (see the header of lib/send-audio.ts). 'allow' is safe: the
    // dot component is our data home, and the resolver above returned an exact,
    // containment-checked path with no caller-supplied segments.
    res.sendFile(content.path, { dotfiles: 'allow' }, err => {
      if (!err) return
      if (!res.headersSent) res.status(503).json({ error: 'image_unavailable' })
      else res.destroy()
    })
  } catch (error) {
    logPreviewOutcome('output_image', 'error_' + previewErrorCode(error))
    res.status(503).json({ error: 'image_unavailable' })
  }
})

// 6.99.35: "Show files and images your sessions make" (lib/session-files-setting.ts), Control Web Settings, Privacy.
// Default on; COS_WEB_SESSION_FILES=0 on the Mac forces it off and the answer says so (source: 'env').
agentSessionsRouter.get('/session-files/settings', (_req, res) => {
  res.set('Cache-Control', 'private, no-store')
  try { res.json(sessionFilesSetting.read()) } catch { res.status(500).json({ error: 'session_files_settings_unavailable' }) }
})
agentSessionsRouter.post('/session-files/settings', (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'enabled') || typeof body.enabled !== 'boolean') {
    res.status(400).json({ error: { code: 'invalid_session_files_settings', message: 'Send { enabled: true } or { enabled: false }.' } }); return
  }
  try { res.json(sessionFilesSetting.set(body.enabled)) } catch { res.status(500).json({ error: 'session_files_settings_unavailable' }) }
})

// 6.99.35: a file a Claude session sent with SendUserFile. Same gate, same re-authorization, no path
// in the request or the response. HTML is an attachment of type octet-stream with a sandbox CSP, never
// same-origin HTML; a PDF may open inline.
agentSessionsRouter.get('/agent-sessions/:provider/:sessionId/output-files/:fileId/content', async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  res.set('X-Content-Type-Options', 'nosniff')
  if (!sessionFilesSetting.read().enabled) { res.status(403).json({ error: 'previews_off' }); return }
  const provider = asProvider(String(req.params.provider ?? '').toLowerCase())
  if (!provider) { res.status(404).json({ error: 'file_not_found' }); return }
  try {
    const content = await agentSessionOutputImages.fileContent(provider, String(req.params.sessionId), String(req.params.fileId))
    if (content.status !== 'ok') { previewRefusal(res, 'sent_file', content.status); return }
    res.set(sharedFileHeaders(content.name, content.kind))
    res.status(200).end(content.bytes)
  } catch (error) {
    logPreviewOutcome('sent_file', 'error_' + previewErrorCode(error))
    res.status(503).json({ error: 'file_unavailable' })
  }
})

// Images a session looked at (tool results such as a Read of a PNG or a browser screenshot) and images attached
// to its prompts. Same gate and switch as output images, same rule: no path in the request or the response. Embedded
// bytes are served as the image type they ARE (png, jpeg, webp or gif, sniffed, never the declared type), with a
// sandbox CSP; a path-only Read comes back through the output-image normalizer as a JPEG.
export const TOOL_IMAGE_CSP = "sandbox; default-src 'none'"
agentSessionsRouter.get('/agent-sessions/:provider/:sessionId/tool-images/:imageId/content', async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  res.set('X-Content-Type-Options', 'nosniff')
  if (!sessionFilesSetting.read().enabled) { res.status(403).json({ error: 'previews_off' }); return }
  const provider = asProvider(String(req.params.provider ?? '').toLowerCase())
  if (!provider) { res.status(404).json({ error: 'image_not_found' }); return }
  try {
    const content = await agentSessionOutputImages.toolImageContent(provider, String(req.params.sessionId), String(req.params.imageId))
    if (content.status !== 'ok') { previewRefusal(res, 'tool_image', content.status); return }
    res.set('Content-Security-Policy', TOOL_IMAGE_CSP)
    res.set('Cross-Origin-Resource-Policy', 'same-origin')
    if ('path' in content) {
      res.type('image/jpeg')
      // dotfiles 'allow': the media root lives under ~/.cos-glasses/data (see the output-images route above).
      res.sendFile(content.path, { dotfiles: 'allow' }, err => {
        if (!err) return
        if (!res.headersSent) res.status(503).json({ error: 'image_unavailable' })
        else res.destroy()
      })
      return
    }
    res.set('Content-Type', content.type)
    res.set('Content-Disposition', 'inline')
    res.status(200).end(content.bytes)
  } catch (error) {
    logPreviewOutcome('tool_image', 'error_' + previewErrorCode(error))
    res.status(503).json({ error: 'image_unavailable' })
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
    // 6.52.0: a Codex thread is titled by its own name, as its list row already is. Keyed
    // by the rollout's FILENAME id first: a cloned thread's `session_meta` carries its
    // parent's id (see `listCodexSessions`), and the parent's name would be the wrong one.
    let codexThreadName: string | undefined
    if (provider === 'codex') {
      const names = await loadCodexThreadNamesAll(agentSessionRoots())
      const fileId = idFromCodexFilename(found.split('/').pop() || '')
      codexThreadName = (fileId ? names.get(fileId) : undefined) || names.get(sessionId) || undefined
    }
    const parsed = await parseAgentSession(provider, found, codexThreadName ? { codexThreadName } : {})
    // 6.50.0 `?turns=N`: the recent conversation, for the lens's scroll-up history. Only
    // when asked, so the detail poll and every older client get the same bytes as before.
    // A failure here costs the history, never the detail page.
    const turnsWanted = parseTurnsParam(req.query.turns)
    let recentTurns: RecentTurnsRead | null = null
    if (turnsWanted !== null) {
      try {
        const images = await agentSessionOutputImages.context(provider, sessionId, found)
        recentTurns = await readRecentSessionTurns(provider, found, turnsWanted, undefined, images.project)
        // 6.99.35: previews off sends one mark per message instead of image and file names.
        if (recentTurns && !sessionFilesSetting.read().enabled) recentTurns = { ...recentTurns, turns: withoutPreviews(recentTurns.turns) }
      } catch (error) {
        console.warn(`[agent-sessions] recent turns failed provider=${provider}: ${error instanceof Error ? error.message : error}`)
      }
    }
    if (provider === 'cursor') {
      const names = await loadCursorComposerNames(agentSessionRoots().cursorComposerDb)
      const named = names.get(parsed.session_id) || names.get(sessionId)
      if (named) parsed.display_label = named
    }
    const now = Date.now()
    const rollout = provider === 'codex' ? codexRolloutFacts(found, now) : null
    const observed = provider === 'codex' ? codexCompactionFields(workObservationFor(parsed.session_id), rollout, now) : workObservationFields(workObservationFor(parsed.session_id))
    const detailRoots = provider === 'codex' ? codexSessionRootsOf(agentSessionRoots()) : []
    const subagents = provider === 'codex' ? (await readCodexSubagentsAcross([sessionId], detailRoots, undefined, detailRoots.length > 1 ? keyedCodexRootOf() : undefined)).get(sessionId.toLowerCase()) : observed.subagent_activity
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
    } else if (provider === 'cursor' && signalFor(parsed.session_id)) {
      // 6.51.0: the detail agrees with its list row (hook-grounded Cursor state).
      derived = deriveForRow({ sessionId: parsed.session_id, remember: false })
    } else if (provider === 'codex') {
      // 6.62.0 (plan 1.3): as its list row: the hooks, else the rollout's turn markers.
      derived = deriveCodexRow(parsed.session_id, running.occupied.has(parsed.session_id), rollout, now, false)
    }
    const signal = signalFor(parsed.session_id)
    const hint = runningHintFor(provider, derived, hintClock(signal, derived, rollout), now, activityClockMs(st.mtimeMs, activity))
    // 7.0.4 S1: every string the detail sends (the reply, the digest, the first prompt, each turn's words, tool
    // labels, file and image names) has its absolute local paths turned into base names (lib/local-path-redact.ts).
    // A walk over the whole value rather than a field list, so a field added later is covered too.
    const body = redactLocalPathsDeep({
      ...withRunning({ session_id: parsed.session_id }, running, hint),
      ...derivedRowFields(derived),
      ...queuedTurnsFields((await allQueuedWaitingLookup(Date.now()))(provider, parsed.session_id)),
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
      has_subagents: (subagents?.total ?? 0) > 0,
      ...observed,
      ...(subagents ? { subagent_activity: subagents } : {}),
      total_input_tokens: 0,
      total_output_tokens: 0,
      file_size_bytes: parsed.file_size_bytes,
      omitted_tools: parsed.omitted_tools,
      ...(activity.lastActivityAt ? { last_activity_at: activity.lastActivityAt } : {}),
      ...cursorActivityFields(provider, signal),
      ...(activity.lastTool ? { last_tool: activity.lastTool } : {}),
      ...(recentTurns ? { recent_turns: recentTurns.turns, recent_turns_more: recentTurns.more } : {}),
      // 6.62.0 (plans 1.8, 3.12): the lens reads both from the DETAIL (display-pages.ts).
      // 6.62.0 /qa (W11): detail and the attach verdict only; list rows never wait on model reads.
      // Q3: the note says Ask unless this client declared it shows the note.
      ...sessionActFields((await sessionActFactsFor([{ provider, session_id: parsed.session_id, file: found }], {
        noteAck: continueNoteAcknowledged(req.headers[CONTINUE_NOTE_HEADER]),
      }))[0]),
    })
    // 7.0.4 W1: COS Control's helper on this Mac matches a Work prompt it sent against the session's user turns by
    // their opening words, and it holds the prompt unredacted. Only the user turns' words in `recent_turns` (the one
    // field it matches on) are sent as written, and only to that privileged local caller: a direct loopback request
    // that passed the header-token gate with no browser or proxy header (lib/native-mac-caller.ts). Every browser
    // (cookie or token), phone, LAN, tailnet and proxied request gets the redacted body. The answer is already
    // `private, no-store`; Vary names every header the choice reads, so no cache can serve one as the other.
    if (turnsWanted !== null) res.vary('Cookie').vary('X-COS-Token').vary('Origin').vary('Referer').vary('User-Agent').vary('Sec-Fetch-Mode').vary('Sec-Fetch-Site').vary('Sec-Fetch-Dest')
    // 7.0.7 final QA: link-card markers (`[words](cos-file:N)`) go only to a client that asks for them with `cards=1`
    // (Control Web from 7.0.7: the reader and Today's session sheet). Everyone else gets each card's words, as 7.0.4
    // showed them: a Control Web tab opened before the update (it has no reload-on-version), COS Control (no build
    // renders markers; its own cards come from outputLinks), the lens and any older client. outputLinks is unchanged.
    const native = recentTurns && Array.isArray(body.recent_turns) ? isNativeMacCaller(req, res) : false
    const cardsWanted = req.query.cards === '1'
    // The native helper always gets words, whatever it asks for (no Control build draws markers).
    if (recentTurns && Array.isArray(body.recent_turns) && (native || !cardsWanted)) {
      body.recent_turns = body.recent_turns.map((turn, index) => {
        const original = recentTurns!.turns[index]
        if (native && original && original.role === 'user' && turn.role === 'user') return { ...turn, text: original.text }
        return typeof turn.text === 'string' && turn.text.includes('](cos-file:') ? { ...turn, text: withoutLinkMarkers(turn.text) } : turn
      })
    }
    res.json(body)
  } catch (error) {
    console.error(`[agent-sessions] detail failed: ${error instanceof Error ? error.message : error}`)
    res.status(500).json({ error: 'Failed to read agent session', reason: 'agent_sessions_read_failed' })
  }
})
