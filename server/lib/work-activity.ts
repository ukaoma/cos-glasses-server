import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export type WorkHandoffMode = 'continueSession' | 'fork' | 'newSession'
/** 6.59.0: what COS Control's tracker recorded (its `WorkProgress`, Sources/WorkProgress.swift). */
export interface WorkActivityProgress {
  reported: 'done' | 'needsInput' | 'blocked' | null
  reportedBy?: 'session' | 'jev'
  /** At most 280 characters, control characters as spaces. The session's own status line, or Jev's reading. */
  evidence?: string
  receivedAt?: string
  lastMove?: { from: string; to: string; at: string; undone: boolean }
  /** A manual move back (or an Undo) paused automatic moves for this handoff. */
  paused: boolean
}
export interface WorkActivity {
  id: string; workId: string; domain: string; status: string
  provider?: string; sessionId?: string; sessionTitle?: string; error?: string
  // 6.59.0, all optional for older clients.
  mode?: WorkHandoffMode
  model?: string
  createdAt?: string
  updatedAt?: string
  progress?: WorkActivityProgress
  acknowledged?: boolean
  appOpened?: boolean
  serverHold?: boolean
  requestedFrom?: 'glasses'
}
/** 6.59.0 (S4): where Control's saved draft for the task's current revision sends. Never the draft's prompt. */
export interface SavedDestination { mode: WorkHandoffMode; provider: string; model?: string; sessionId?: string }
export interface WorkActivityCapabilities { progress: 1; requests: 0 | 1 }
export interface WorkActivityResult {
  version: 1; available: boolean; reason?: string; capabilities?: WorkActivityCapabilities
  activities: WorkActivity[]; savedDestination?: SavedDestination
}
/** These options are dependency injection for fixtures, never request parameters. */
export interface WorkActivityOptions {
  journalPath?: string; home?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv
}
type JournalRecord = Record<string, unknown>
/** A native journal that passed every safety and format check. Its receipts and drafts are the validated raw records. */
export interface WorkJournal { available: true; receipts: JournalRecord[]; drafts: JournalRecord[] }
export type WorkJournalRead = WorkJournal | { available: false; reason: string }

export const WORK_ACTIVITY_LIMITS = { evidence: 280, openItems: 50, trackedDays: 14, progressEvents: 1_000 } as const
/** Control's `TaskRow.workStages` (and task-store WORK_STAGES). A move naming anything else is not projected. */
export const WORK_ACTIVITY_STAGES: readonly string[] = ['mentioned', 'planned', 'draft', 'built', 'qa', 'complete']
const unavailableJournal = (reason: string): WorkJournalRead => ({ available: false, reason })
const statuses = new Set(['preparing', 'sending', 'queued', 'running', 'delivered', 'completed', 'failed', 'refused', 'reviewed', 'canceled', 'unknown'])
/** Control's `WorkHandoffReceipt.terminalStatuses`: never block another handoff. */
const terminal = new Set(['completed', 'failed', 'refused', 'canceled', 'reviewed'])
const providers = new Set(['claude', 'codex', 'cursor', 'ollama'])
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const absentOr = (value: unknown, check: (v: unknown) => boolean): boolean => value === undefined || value === null || check(value)
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
const SESSION_ID = /^(claude|codex|cursor|ollama):[^\s\u0000-\u001f\u007f-\u009f]{1,256}$/
const SAFE_ID = /^[^\s\u0000-\u001f\u007f-\u009f]{1,256}$/
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Control's clock (seconds since 1970) as ISO, or nothing for a value no Date can hold. */
function isoFromSeconds(seconds: unknown): string | undefined {
  return finite(seconds) && seconds > 0 && seconds < 1e11 ? new Date(seconds * 1000).toISOString() : undefined
}

/** Control characters become spaces; at most 280 whole characters (Control's own `WorkProgress.clip` shape). */
export function cleanEvidence(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const flat = value.replace(CONTROL, ' ').trim()
  if (!flat) return undefined
  const chars = Array.from(graphemes.segment(flat), part => part.segment)
  return chars.length <= WORK_ACTIVITY_LIMITS.evidence ? flat : chars.slice(0, WORK_ACTIVITY_LIMITS.evidence - 1).join('').trimEnd() + '…'
}

/**
 * The receipt's optional `progress` block, parsed on its own. A malformed block is dropped (undefined) and never
 * makes the journal unavailable: Control writes it, and a newer Control may write more.
 */
function parseProgress(raw: unknown): { projection: WorkActivityProgress; newestAt?: number } | undefined {
  if (!object(raw)) return undefined
  const { reported, reportedBy, evidence, receivedAt, paused, events } = raw
  if (!absentOr(reported, v => typeof v === 'string') || !absentOr(reportedBy, v => typeof v === 'string')
    || !absentOr(evidence, v => text(v, 100_000)) || !absentOr(receivedAt, finite) || !absentOr(paused, v => typeof v === 'boolean')
    || !(events === undefined || (Array.isArray(events) && events.length <= WORK_ACTIVITY_LIMITS.progressEvents))) return undefined
  const list = (events ?? []) as unknown[]
  let newestAt: number | undefined
  for (const event of list) {
    if (!object(event) || !finite(event.at) || typeof event.kind !== 'string'
      || !absentOr(event.fromStage, v => typeof v === 'string') || !absentOr(event.toStage, v => typeof v === 'string')
      || !absentOr(event.undoneAt, finite)) return undefined
    newestAt = newestAt === undefined ? event.at : Math.max(newestAt, event.at)
  }
  // Control decodes a kind it does not know as a note, which is no report.
  const state = reported === 'done' || reported === 'needsInput' || reported === 'blocked' ? reported : null
  const projection: WorkActivityProgress = { reported: state, paused: paused === true }
  if (state) {
    if (reportedBy === 'session' || reportedBy === 'jev') projection.reportedBy = reportedBy
    const quoted = cleanEvidence(evidence)
    if (quoted) projection.evidence = quoted
  }
  const received = isoFromSeconds(receivedAt)
  if (received) projection.receivedAt = received
  // The newest move COS made, undone or not (Control's timeline order: events are appended).
  const move = [...list].reverse().find(event => (event as JournalRecord).kind === 'moved') as JournalRecord | undefined
  const moveAt = move && isoFromSeconds(move.at)
  if (move && moveAt && WORK_ACTIVITY_STAGES.includes(move.fromStage as string) && WORK_ACTIVITY_STAGES.includes(move.toStage as string)) {
    projection.lastMove = { from: move.fromStage as string, to: move.toStage as string, at: moveAt, undone: finite(move.undoneAt) }
  }
  return { projection, newestAt }
}

/** A 0.5.248 tab that never reached a session. Control reads it as canceled on load (WorkHandoffStore.unsentTab). */
const unsentTab = (receipt: JournalRecord): boolean => receipt.channel === 'tab' && receipt.status === 'queued' && receipt.sessionID == null

function projectReceipt(receipt: JournalRecord, domain: string): WorkActivity {
  const raw = receipt.status as string
  const status = ['preparing', 'sending'].includes(raw) ? 'unknown' : unsentTab(receipt) ? 'canceled' : raw
  const activity: WorkActivity = { id: receipt.id as string, workId: receipt.workID as string, domain, status }
  // Native sessionIDs are provider-qualified. Refuse cross-provider identity;
  // missing ownership stays missing rather than being inferred from titles.
  if (providers.has(receipt.provider as string)) {
    const provider = receipt.provider as string
    activity.provider = provider
    if (typeof receipt.sessionID === 'string' && receipt.sessionID.startsWith(provider + ':')
      && receipt.sessionID.length > provider.length + 1 && !/[\x00-\x1f\x7f]/.test(receipt.sessionID)) {
      activity.sessionId = receipt.sessionID
      activity.sessionTitle = (receipt.sessionTitle as string).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)
    }
  }
  if (['unknown', 'failed', 'refused', 'canceled'].includes(status)) activity.error = status === 'unknown'
    ? 'Delivery is unresolved. Inspect the original session before trying again.'
    : 'This handoff did not complete successfully. Open COS Control for details.'
  // 6.59.0 (S1). Never prompt, detail, result or the work title.
  activity.mode = receipt.mode as WorkHandoffMode
  const model = (receipt.modelID as string).replace(CONTROL, ' ').trim()
  if (model) activity.model = model
  const progress = parseProgress(receipt.progress)
  const createdAt = isoFromSeconds(receipt.createdAt)
  if (createdAt) {
    activity.createdAt = createdAt
    activity.updatedAt = progress?.newestAt !== undefined
      ? isoFromSeconds(Math.max(receipt.createdAt as number, progress.newestAt)) ?? createdAt : createdAt
  }
  if (progress) activity.progress = progress.projection
  // Control's handledByYou: acknowledged, or an unknown or delivered handoff you marked reviewed.
  activity.acknowledged = finite(receipt.acknowledgedAt) || raw === 'reviewed'
  // Control's appOwner: the app opened it, or 0.5.248 opened it as a tab.
  activity.appOpened = (object(receipt.appOpen) && finite(receipt.appOpen.openedAt)) || receipt.channel === 'tab'
  // Control's serverHolds: a Work New session the COS server is still running.
  activity.serverHold = receipt.channel === 'job' && receipt.mode === 'newSession' && typeof receipt.sessionID === 'string' && !terminal.has(raw)
  if (receipt.requestedFrom === 'glasses') activity.requestedFrom = 'glasses'
  return activity
}

/** Read the native journal with every safety and format check. No title/keyword matching, inferred target or writes. */
export function readWorkJournal(options: WorkActivityOptions = {}): WorkJournalRead {
  const env = options.env ?? process.env, home = options.home ?? homedir()
  if (!options.journalPath) {
    if ((options.platform ?? process.platform) !== 'darwin') return unavailableJournal('Native Work history is available only on its Mac host.')
    if (env.NODE_ENV === 'test' || env.VITEST || env.COS_CONTROL_TEST_HOME || env.COS_CONTROL2_ISOLATED_PREVIEW === '1'
      || env.COS_WORK_CONNECTED_TEST === '1'
      || (env.COS_DATA_DIR && resolve(env.COS_DATA_DIR) !== join(home, '.cos-glasses', 'data'))) {
      return unavailableJournal('This isolated runtime does not read the native Work history.')
    }
  }
  const path = options.journalPath ?? join(home, 'Library', 'Application Support', 'COS Control', 'work-handoffs', 'handoffs.json')
  let fd: number | undefined
  try {
    // Reject symlinked ancestors as well as the leaf. An explicit fixture path is
    // still subjected to the same file protections. No user-supplied path exists.
    let parent = dirname(resolve(path))
    while (true) {
      const stat = lstatSync(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return unavailableJournal('Native Work history is not safely readable.')
      const next = dirname(parent); if (next === parent) break; parent = next
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size >= 10_000_000 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return unavailableJournal('Native Work history is not safely readable.')
    const buffer = Buffer.alloc(Math.min(stat.size + 1, 10_000_000))
    let count = 0
    while (count < buffer.length) { const n = readSync(fd, buffer, count, buffer.length - count, null); if (!n) break; count += n }
    const after = fstatSync(fd), raw = buffer.subarray(0, count)
    if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || raw.length >= 10_000_000) return unavailableJournal('Native Work history exceeds the supported limit.')
    const journal: unknown = JSON.parse(raw.toString('utf8'))
    if (!object(journal) || ![1, 2].includes(journal.version as number) || !Array.isArray(journal.receipts)
      || journal.receipts.length > 10_000 || !Array.isArray(journal.sessions)
      || (journal.drafts !== undefined && !Array.isArray(journal.drafts))) return unavailableJournal('Native Work history has an unsupported format.')
    // Match native Codable's required session/draft fields. A malformed journal
    // is unavailable even when its receipt array happens to look plausible.
    for (const session of journal.sessions) {
      if (!object(session) || !['id','nativeID','provider','title','summary','project','status'].every(key => text(session[key], 100_000))
        || ['waitingDetail','failure'].some(key => session[key] != null && !text(session[key], 100_000))) return unavailableJournal('Native Work history has an unsupported format.')
    }
    const draftKeys = new Set<string>(), drafts: JournalRecord[] = []
    for (const draft of journal.drafts ?? []) {
      if (!object(draft) || !['sourceID','sourceRevision','sessionID','provider','modelID','prompt'].every(key => text(draft[key], 100_000))
        || !draft.sourceID || !draft.sourceRevision || !['continueSession','fork','newSession'].includes(draft.mode as string)
        || typeof draft.editVersion !== 'number' || !Number.isSafeInteger(draft.editVersion) || draft.editVersion < 0) return unavailableJournal('Native Work history has an unsupported format.')
      const key = JSON.stringify([draft.sourceID, draft.sourceRevision])
      if (draftKeys.has(key)) return unavailableJournal('Native Work history has an unsupported format.')
      draftKeys.add(key); drafts.push(draft)
    }
    const seen = new Set<string>(), receipts: JournalRecord[] = []
    for (const receipt of journal.receipts) {
      if (!object(receipt) || !text(receipt.id, 256) || !receipt.id || seen.has(receipt.id)
        || !text(receipt.workID, 1024) || !text(receipt.workTitle, 8000) || !text(receipt.sourceRevision, 1024)
        || !['continueSession', 'fork', 'newSession'].includes(receipt.mode as string)
        || !text(receipt.provider, 64) || !text(receipt.modelID, 256)
        || !text(receipt.sessionTitle, 8000) || !statuses.has(receipt.status as string)
        || !text(receipt.detail, 100_000) || !text(receipt.prompt, 100_000)
        || typeof receipt.createdAt !== 'number' || !Number.isFinite(receipt.createdAt)
        || ['sessionID','result','sourceSessionID','bindingID','boundTo','channel','jobID','serverInstanceID'].some(key => receipt[key] != null && !text(receipt[key], 1_000_000))
        || (receipt.epoch != null && (typeof receipt.epoch !== 'number' || !Number.isSafeInteger(receipt.epoch)))) return unavailableJournal('Native Work history has an unsupported format.')
      seen.add(receipt.id); receipts.push(receipt)
    }
    return { available: true, receipts, drafts }
  } catch (error) {
    return unavailableJournal((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'No native Work history is available on this host.' : 'Native Work history could not be read.')
  } finally { if (fd !== undefined) closeSync(fd) }
}

/** Every receipt for one exact work item, in journal order. */
export function projectWorkActivity(journal: WorkJournal, domain: string, workIdentity: string): WorkActivity[] {
  const workId = `task:${domain}:${workIdentity}`
  return journal.receipts.filter(receipt => receipt.workID === workId).map(receipt => projectReceipt(receipt, domain))
}

/** Read a native receipt projection, not a provider status or task-completion verdict.
 * Atomic native journal replacement permits a consistent opened-file read without
 * taking its dispatch lock. No title/keyword matching, inferred target or writes.
 */
export function readWorkActivity(domain: string, workIdentity: string, options: WorkActivityOptions = {}): WorkActivityResult {
  const journal = readWorkJournal(options)
  if (!journal.available) return { version: 1, available: false, reason: journal.reason, activities: [] }
  return { version: 1, available: true, activities: projectWorkActivity(journal, domain, workIdentity) }
}

/** The board-row fields Control reads for a task (TaskRow), and the ones the open list needs. */
export interface WorkBoardRowLite {
  id: string; domain: string; title?: string; text?: string; source?: string; doneWhen?: string
  checked?: boolean; workStage?: string; workIdentity?: string
  meetingRefs?: Array<{ recordId?: unknown; domain?: unknown; month?: unknown; filename?: unknown; title?: unknown }>
}
const controlOrFormat = /[\p{Cc}\p{Cf}]/u
/** Control's WorkMeetingReference(JSONValue): refs it cannot read are left out of the snapshot. */
function controlMeetingRef(ref: unknown): { recordId: string; domain: string; month: string; filename: string; title: string } | null {
  if (!object(ref)) return null
  const { recordId, domain, month, filename, title } = ref
  if (typeof recordId !== 'string' || !recordId || Buffer.byteLength(recordId) > 2048 || controlOrFormat.test(recordId)
    || typeof domain !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(domain)
    || typeof month !== 'string' || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month)
    || typeof filename !== 'string' || !filename || Buffer.byteLength(filename) > 1024 || filename === '.' || filename === '..'
    || filename.includes('/') || filename.includes('\\') || controlOrFormat.test(filename)) return null
  return { recordId, domain, month, filename, title: typeof title === 'string' ? title : 'Saved meeting' }
}

/**
 * Control's `WorkSource.taskSnapshot(task).revision` for a board row: the SHA-256 of the context it sends. A draft is
 * saved against this revision, and Control uses only the draft for the task's current one (`draft(for:)`).
 */
export function controlSnapshotRevision(row: WorkBoardRowLite): string {
  const title = typeof row.title === 'string' ? row.title : ''
  const words = typeof row.text === 'string' ? row.text : title
  const str = (value: unknown) => typeof value === 'string' ? value : ''
  let context = `Task: ${words === '' ? title : words}\nProject: ${str(row.domain)}\nDone when: ${str(row.doneWhen)}\nSource: ${str(row.source)}`
  const refs = (Array.isArray(row.meetingRefs) ? row.meetingRefs : []).map(controlMeetingRef).filter(ref => ref !== null)
  if (refs.length) {
    context += '\nConfirmed meeting references (explicit links; transcript evidence is not included):\n'
      + refs.map(ref => `- ${ref.title} | canonical ID: ${ref.recordId} | saved source: ${ref.domain}/${ref.month}/${ref.filename}`).join('\n')
  }
  return createHash('sha256').update(context, 'utf8').digest('hex')
}

/** A draft's destination when it names a complete one. The prompt is never read here. */
function draftDestination(draft: JournalRecord): SavedDestination | undefined {
  const mode = draft.mode as WorkHandoffMode, provider = draft.provider as string, model = draft.modelID as string, session = draft.sessionID as string
  if (mode === 'newSession') return providers.has(provider) && SAFE_ID.test(model) ? { mode, provider, model } : undefined
  if (!SESSION_ID.test(session)) return undefined
  const own = session.slice(0, session.indexOf(':'))
  if (mode === 'continueSession') return { mode, provider: own, sessionId: session }
  // A Fork to another platform names that platform and one of its models (Control's crossPlatform plan).
  if (providers.has(provider) && provider !== own) return SAFE_ID.test(model) ? { mode, provider, model, sessionId: session } : undefined
  return { mode, provider: own, sessionId: session }
}

/** S4: the destination saved in Control's draft for this task's current revision, when it names one. */
export function savedDestinationFor(journal: WorkJournal, row: WorkBoardRowLite): SavedDestination | undefined {
  const sourceID = `task:${row.domain}:${row.workIdentity || row.id}`, revision = controlSnapshotRevision(row)
  const draft = journal.drafts.find(d => d.sourceID === sourceID && d.sourceRevision === revision)
  return draft ? draftDestination(draft) : undefined
}

export interface OpenWorkItem extends WorkActivity { workIdentity: string; title: string; savedDestination?: SavedDestination }

/**
 * S2: every board task whose newest handoff (any revision), sent in the last 14 days, is still open: not terminal, or
 * reporting needs input or blocked, or reporting done, and not acknowledged. Needs input and blocked first, then the
 * rest that are not terminal, then done awaiting review; newest first within each. At most 50. Read-only.
 */
export function projectOpenWork(journal: WorkJournal, rows: readonly WorkBoardRowLite[], nowMs: number): OpenWorkItem[] {
  const newest = new Map<string, JournalRecord>()
  for (const receipt of journal.receipts) {
    const prior = newest.get(receipt.workID as string)
    // Control's order: createdAt, then id.
    if (!prior || (receipt.createdAt as number) > (prior.createdAt as number)
      || (receipt.createdAt === prior.createdAt && (receipt.id as string) > (prior.id as string))) newest.set(receipt.workID as string, receipt)
  }
  const nowSeconds = nowMs / 1000, ranked: Array<{ item: OpenWorkItem; rank: number; createdAt: number }> = []
  const listed = new Set<string>()
  for (const row of rows) {
    const identity = row.workIdentity || row.id, workId = `task:${row.domain}:${identity}`
    if (!/^[a-f0-9]{12}$/.test(identity) || listed.has(workId)) continue
    listed.add(workId)
    const receipt = newest.get(workId)
    if (!receipt || nowSeconds - (receipt.createdAt as number) >= WORK_ACTIVITY_LIMITS.trackedDays * 86_400) continue
    const activity = projectReceipt(receipt, row.domain)
    const reported = activity.progress?.reported ?? null, handled = activity.acknowledged === true
    const asks = (reported === 'needsInput' || reported === 'blocked') && !handled
    const done = reported === 'done' && !handled
    const open = !terminal.has(activity.status)
    if (!asks && !done && !open) continue
    // Control drops a completed task's card unless its handoff is still in progress.
    if ((row.checked || row.workStage === 'complete') && !['queued', 'running'].includes(activity.status)) continue
    const item: OpenWorkItem = { ...activity, workIdentity: identity, title: typeof row.title === 'string' ? row.title : '' }
    const destination = savedDestinationFor(journal, row)
    if (destination) item.savedDestination = destination
    ranked.push({ item, rank: asks ? 0 : done ? 2 : 1, createdAt: receipt.createdAt as number })
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || b.createdAt - a.createdAt || (a.item.id < b.item.id ? 1 : a.item.id > b.item.id ? -1 : 0))
    .slice(0, WORK_ACTIVITY_LIMITS.openItems)
    .map(entry => entry.item)
}
