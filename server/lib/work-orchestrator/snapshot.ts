/**
 * 6.83.0 (Phase A, docs/work-orchestrator.md): the Work state COS Control pushes. Control owns the journal; the server
 * keeps this bounded, versioned copy in `data/work-orchestrator/control-snapshot.json` (0600, atomic). Ids, modes,
 * statuses and times only: never a prompt, a result or a file name. Out of bounds or malformed is refused whole.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteFileSync } from '../atomic-fs.js'

export const SNAPSHOT_VERSION = 1
export const SNAPSHOT_MAX_LINKS = 4000
export const SNAPSHOT_MAX_RECEIPTS = 4000
export const SNAPSHOT_MAX_LIVE = 400
const SID = /^(claude|codex|cursor):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
/** A task card (`task:<domain>:<12 hex>`), a meeting card (`meeting:<record id>`) or another kind COS Control adds later. */
const WORK_ID = /^[a-z][a-z0-9_]{0,30}:[^\u0000-\u001f]{1,250}$/
const MODES = ['continueSession', 'fork', 'newSession'] as const

export interface SnapshotLink { sessionID: string; workID: string; at: number }
export interface SnapshotReceipt {
  id: string; workID: string; mode: typeof MODES[number]; provider: string
  sessionID: string | null; sourceSessionID: string | null; forkChildID: string | null; status: string; createdAt: number
}
export interface SnapshotLiveRow { id: string; title: string; status: string; updatedAt: string | null; busy: boolean; waitingOnUser: boolean; appOwned: boolean; summary: string }
export interface ControlSnapshot {
  version: 1; controlVersion: string; sentAt: number; receivedAt: number
  links: SnapshotLink[]; receipts: SnapshotReceipt[]; live: { checkedAt: number; rows: SnapshotLiveRow[] } | null
}

const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, n: number): v is string => typeof v === 'string' && v.length <= n && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)
/** Seconds since 1970. A value from Swift's reference date (2001) is moved onto 1970. */
export const epochSeconds = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v > 0 ? (v < 1.5e9 ? v + 978_307_200 : v > 1e11 ? v / 1000 : v) : null
const sidOrNull = (v: unknown): string | null => typeof v === 'string' && SID.test(v.toLowerCase()) ? v.toLowerCase() : null

export function parseSnapshot(v: unknown, now = Date.now()): ControlSnapshot {
  return parseSnapshotReport(v, now).snapshot
}

/**
 * 7.0.13: the snapshot plus how many live rows were left out. Live rows are evidence only (what the session list
 * showed), so a row COS cannot name by a full session id, or whose text breaks a bound, is skipped and counted instead
 * of refusing the whole snapshot. Control 0.5.384 sent a running Claude CLI peer as `claude:<8 hex>` (the prefix id
 * /api/claude-sessions serves) and every Work chat plan on every card failed with 400 invalid_snapshot. A row that is
 * not an object, and every link and receipt, stay strict: links and receipts decide which sessions belong to a card.
 */
export function parseSnapshotReport(v: unknown, now = Date.now()): { snapshot: ControlSnapshot; droppedLiveRows: number } {
  let droppedLiveRows = 0
  if (!obj(v) || v.version !== SNAPSHOT_VERSION || !str(v.controlVersion, 40) || !Array.isArray(v.links) || v.links.length > SNAPSHOT_MAX_LINKS
    || !Array.isArray(v.receipts) || v.receipts.length > SNAPSHOT_MAX_RECEIPTS) throw new Error('invalid_snapshot')
  const links: SnapshotLink[] = []
  for (const l of v.links) {
    const at = epochSeconds(l?.at), sid = sidOrNull(l?.sessionID)
    if (!obj(l) || !sid || !str(l.workID, 256) || !WORK_ID.test(l.workID) || at === null) throw new Error('invalid_link')
    links.push({ sessionID: sid, workID: l.workID, at })
  }
  const receipts: SnapshotReceipt[] = []
  for (const r of v.receipts) {
    const createdAt = epochSeconds(r?.createdAt)
    if (!obj(r) || !str(r.id, 64) || !str(r.workID, 256) || !WORK_ID.test(r.workID) || !(MODES as readonly unknown[]).includes(r.mode)
      || !str(r.provider, 20) || !str(r.status, 40) || createdAt === null) throw new Error('invalid_receipt')
    receipts.push({ id: r.id, workID: r.workID, mode: r.mode, provider: r.provider, sessionID: sidOrNull(r.sessionID),
      sourceSessionID: sidOrNull(r.sourceSessionID), forkChildID: sidOrNull(r.forkChildID), status: r.status, createdAt })
  }
  let live: ControlSnapshot['live'] = null
  if (v.live != null) {
    const checkedAt = epochSeconds(v.live?.checkedAt)
    if (!obj(v.live) || checkedAt === null || !Array.isArray(v.live.rows) || v.live.rows.length > SNAPSHOT_MAX_LIVE) throw new Error('invalid_live')
    const rows: SnapshotLiveRow[] = []
    for (const r of v.live.rows) {
      if (!obj(r)) throw new Error('invalid_live_row')
      const id = sidOrNull(r.id)
      if (!id) { droppedLiveRows++; continue }
      if (!str(r.title ?? '', 300) || !str(r.status ?? '', 100) || !str(r.summary ?? '', 2000)) { droppedLiveRows++; continue }
      if (isGuardianRow(id, r.title ?? '', r.summary ?? '')) continue
      rows.push({ id, title: r.title ?? '', status: r.status ?? '', updatedAt: str(r.updatedAt, 40) ? r.updatedAt : null,
        busy: r.busy === true, waitingOnUser: r.waitingOnUser === true, appOwned: r.appOwned === true, summary: r.summary ?? '' })
    }
    live = { checkedAt, rows }
  }
  return { snapshot: { version: 1, controlVersion: v.controlVersion, sentAt: epochSeconds(v.sentAt) ?? now / 1000, receivedAt: now / 1000, links, receipts, live }, droppedLiveRows }
}

/** Codex guardian review threads (canary C3: 17 in the live list) are never offered as work sessions. */
export function isGuardianRow(id: string, title: string, summary: string): boolean {
  return id.startsWith('codex:') && (title.trim() === 'Guardian review' || summary.startsWith('The following is the Codex agent history'))
}

export class SnapshotStore {
  private current: ControlSnapshot | null = null
  constructor(private readonly path: string) {
    try { const v = JSON.parse(readFileSync(path, 'utf8')); this.current = parseSnapshot(v, (v?.receivedAt ?? 0) * 1000) } catch { this.current = null }
  }
  get(): ControlSnapshot | null { return this.current }
  put(snapshot: ControlSnapshot): void {
    this.current = snapshot
    try { mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 }); atomicWriteFileSync(this.path, JSON.stringify(snapshot)) } catch (e) {
      console.warn(`[work-orchestrator] snapshot kept in memory only: ${(e as Error).message}`)
    }
  }
}
