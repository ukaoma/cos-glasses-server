/**
 * 6.83.0: the orchestrator input for one Work card. Joins discovery, the live session list Control just read, the
 * pick-up notes and the usage snapshot into the rows the planner sees, ranked and bounded, with what was left out and
 * why. It sends nothing and changes nothing.
 */
import type { ControlSnapshot, SnapshotLiveRow } from './snapshot.js'
import { discoverCardSessions, type CardSession, type Evidence } from './discovery.js'
import { pickupNote, PICKUP_MAX_CHARS } from './pickup.js'
import type { UsageProvider, UsageView } from './usage.js'
import type { LogProvider } from './session-log.js'

export const ORCHESTRATOR_MAX_ROWS = 12
export const ORCHESTRATOR_MAX_LEFT_OUT = 12
/** The live list Control sends is "just read" for this long; older, rows read as not in the session list. */
export const LIVE_FRESH_MS = 3 * 60_000

export const UNAVAILABLE_REASONS = ['not_in_session_list', 'app_owned', 'cursor', 'plan_limit', 'on_another_card'] as const
export type UnavailableReason = typeof UNAVAILABLE_REASONS[number]

export interface OrchestratorRow {
  id: string; title: string; summary: string; status: string
  discoveredBy: Evidence[]; linked: boolean; member: boolean
  lastTouchedCard: string | null; lastActivity: string | null
  live: boolean; busy: boolean; pickup: string
  available: boolean; reason?: UnavailableReason
  /** A fork can start from it: Claude or Codex, its log is on this Mac, and that provider has plan usage left. */
  forkable: boolean
}
export interface LeftOut { id: string; title: string; reason: string }
export interface OrchestratorInput {
  protocolVersion: 1; workID: string; now: string
  rows: OrchestratorRow[]; leftOut: LeftOut[]; usage: UsageView[]
  snapshotAgeSec: number | null; liveListAgeSec: number | null; logScanComplete: boolean
  discovered: number
}

export interface InputDeps {
  snapshot: ControlSnapshot | null
  hits: import('./tag-index.js').TagHit[]
  usage: UsageView[]
  /** Log path for a session, or null when this Mac has none. */
  pathOf: (sid: string) => Promise<string | null>
  /** Last-modified time of a log, for sessions outside the live list. */
  mtimeOf?: (path: string) => Promise<number | null>
  skipped?: Set<string>
  logScanComplete?: boolean
  now?: number
  home?: string
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null)

export async function buildOrchestratorInput(workID: string, meetingWorkIDs: string[], deps: InputDeps): Promise<OrchestratorInput> {
  const now = deps.now ?? Date.now()
  const snapshot = deps.snapshot
  const liveFresh = !!snapshot?.live && now - snapshot.live.checkedAt * 1000 <= LIVE_FRESH_MS
  const live = new Map<string, SnapshotLiveRow>((liveFresh ? snapshot!.live!.rows : []).map(r => [r.id, r]))
  const usageBy = new Map<UsageProvider, UsageView>(deps.usage.map(u => [u.provider, u]))
  const found = discoverCardSessions(workID, snapshot, deps.hits, meetingWorkIDs)
  const leftOut: LeftOut[] = []
  const candidates: Array<{ s: CardSession; row: SnapshotLiveRow | undefined }> = []
  for (const s of found) {
    if (deps.skipped?.has(s.id)) { leftOut.push({ id: s.id, title: '', reason: 'codex child thread (guardian or subagent)' }); continue }
    candidates.push({ s, row: live.get(s.id) })
  }
  // Members before suggestions; in the live list before not; the session that touched this card most recently first.
  candidates.sort((a, b) => Number(b.s.member) - Number(a.s.member) || Number(!!b.row) - Number(!!a.row)
    || Number(!b.s.onAnotherCard) - Number(!a.s.onAnotherCard) || (b.s.lastTouchedCard ?? 0) - (a.s.lastTouchedCard ?? 0) || a.s.id.localeCompare(b.s.id))
  const kept = candidates.slice(0, ORCHESTRATOR_MAX_ROWS)
  for (const c of candidates.slice(ORCHESTRATOR_MAX_ROWS)) leftOut.push({ id: c.s.id, title: c.row?.title ?? '', reason: 'more than 12 sessions on this card' })
  const rows: OrchestratorRow[] = []
  for (const { s, row } of kept) {
    const provider = s.id.split(':')[0] as LogProvider
    const path = await deps.pathOf(s.id).catch(() => null)
    let pickup = 'No log for this session on this Mac.'
    let lastActivity: string | null = row?.updatedAt ?? null
    if (path) {
      try {
        const note = await pickupNote(path, provider, s.id.split(':')[1]!, row ? { busy: row.busy, waitingOnUser: row.waitingOnUser } : undefined, deps.home)
        pickup = note.note.slice(0, PICKUP_MAX_CHARS)
        lastActivity = lastActivity ?? note.lastActivity
      } catch { pickup = 'The log could not be read.' }
      if (!lastActivity && deps.mtimeOf) lastActivity = iso(await deps.mtimeOf(path).catch(() => null))
    }
    const usage = provider === 'cursor' ? undefined : usageBy.get(provider)
    const exhausted = usage?.state === 'exhausted'
    let reason: UnavailableReason | undefined
    if (provider === 'cursor') reason = 'cursor'
    else if (s.onAnotherCard) reason = 'on_another_card'
    else if (exhausted) reason = 'plan_limit'
    else if (!row) reason = 'not_in_session_list'
    else if (row.appOwned) reason = 'app_owned'
    rows.push({
      id: s.id, title: (row?.title || '').slice(0, 300) || s.id.slice(0, 15), summary: (row?.summary ?? '').slice(0, 2000),
      status: (row ? row.status || 'idle' : 'not in the session list').slice(0, 100),
      discoveredBy: s.discoveredBy, linked: s.linked, member: s.member,
      lastTouchedCard: iso(s.lastTouchedCard), lastActivity,
      live: !!row, busy: !!row?.busy, pickup,
      available: !reason, ...(reason ? { reason } : {}),
      forkable: (provider === 'claude' || provider === 'codex') && !!path && !exhausted,
    })
  }
  return {
    protocolVersion: 1, workID, now: new Date(now).toISOString(), rows, leftOut: leftOut.slice(0, ORCHESTRATOR_MAX_LEFT_OUT), usage: deps.usage,
    snapshotAgeSec: snapshot ? Math.round(now / 1000 - snapshot.receivedAt) : null,
    liveListAgeSec: snapshot?.live ? Math.round(now / 1000 - snapshot.live.checkedAt) : null,
    logScanComplete: deps.logScanComplete ?? true, discovered: found.length,
  }
}
