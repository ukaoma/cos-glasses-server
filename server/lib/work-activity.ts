import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { flattenDisplayText } from './query-job-types.js'
import { isValidNativeThreadId } from './native-thread-id.js'
import { isClaudeModel, isCodexModel, isCursorModel, isOllamaModel, normalizeModelPreference, type ModelPreference } from '../../shared/model-preference.js'

export type WorkHandoffMode = 'continueSession' | 'fork' | 'newSession'
/** 6.59.0: what COS Control's tracker recorded (its `WorkProgress`, Sources/WorkProgress.swift). */
export interface WorkActivityProgress {
  reported: 'done' | 'needsInput' | 'blocked' | null
  reportedBy?: 'session' | 'jev'
  /** At most 280 characters and 1,200 UTF-16 units, cleaned as a session name is. The session's own status line, or Jev's reading. */
  evidence?: string
  receivedAt?: string
  lastMove?: { from: string; to: string; at: string; undone: boolean }
  /** A manual move back (or an Undo) paused automatic moves for this handoff. */
  paused: boolean
}
/** A progress block the server could not read: there may be a report it cannot show. */
export interface UnreadableWorkProgress { unreadable: true }
export interface WorkActivity {
  id: string; workId: string; domain: string; status: string
  provider?: string; sessionId?: string; sessionTitle?: string; error?: string
  // 6.59.0, all optional for older clients.
  mode?: WorkHandoffMode
  model?: string
  createdAt?: string
  updatedAt?: string
  progress?: WorkActivityProgress | UnreadableWorkProgress
  acknowledged?: boolean
  /** Per SESSION: a receipt handed this handoff's session to its app (opened there, a 0.5.248 tab, or channel app). */
  appOpened?: boolean
  /** Per SESSION: the COS server is still running a Work New session on this handoff's session. */
  serverHold?: boolean
  /** Per SESSION: a note for this handoff's session is queued in its app (status queued, channel app); nothing reached the session. */
  waitingInApp?: boolean
  requestedFrom?: 'glasses'
  /** The handoff request this receipt answered (Control 0.5.252 writes it). */
  requestId?: string
  /** How Control delivered it: job, fork, app, turn, queue or tab. */
  channel?: string
  /**
   * A send in flight: on disk it reads preparing or sending and was made in the last 10 minutes. `status` still reads
   * `unknown` (older clients); with this flag it is "Sending", not an unresolved delivery. Absent otherwise.
   */
  sending?: true
}
/** 6.59.0 (S4): where Control's saved draft for the task's current revision sends. Never the draft's prompt. */
export interface SavedDestination { mode: WorkHandoffMode; provider: string; model?: string; sessionId?: string }
/**
 * `requests` is 1 only while COS Control is consuming the inbox (it listed pending requests in the last 120 s);
 * `requestsInbox` is 1 when the inbox opened on this server; `requestsConsumerSeenAt` is Control's last listing.
 */
export interface WorkActivityCapabilities { progress: 1; requests: 0 | 1; requestsInbox: 0 | 1; requestsConsumerSeenAt: string | null }
export interface WorkActivityResult {
  version: 1; available: boolean; reason?: string; capabilities?: WorkActivityCapabilities
  activities: WorkActivity[]; savedDestination?: SavedDestination
  /** The task's own revision (Control's taskSnapshot), for a handoff request's expectedTaskRevision. */
  taskRevision?: string
}
/** These options are dependency injection for fixtures, never request parameters. */
export interface WorkActivityOptions {
  journalPath?: string; home?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv
}
type JournalRecord = Record<string, unknown>
/** A native journal that passed every safety and format check. Its receipts and drafts are the validated raw records. */
export interface WorkJournal { available: true; receipts: JournalRecord[]; drafts: JournalRecord[] }
export type WorkJournalRead = WorkJournal | { available: false; reason: string }

export const WORK_ACTIVITY_LIMITS = { evidence: 280, evidenceUnits: 1_200, openItems: 50, trackedDays: 14, progressEvents: 1_000, sendingSeconds: 600 } as const
/** Control's `TaskRow.workStages` (and task-store WORK_STAGES). A move naming anything else is not projected. */
export const WORK_ACTIVITY_STAGES: readonly string[] = ['mentioned', 'planned', 'draft', 'built', 'qa', 'complete']
const unavailableJournal = (reason: string): WorkJournalRead => ({ available: false, reason })
const statuses = new Set(['preparing', 'sending', 'queued', 'running', 'delivered', 'completed', 'failed', 'refused', 'reviewed', 'canceled', 'unknown'])
/** Control's `WorkHandoffReceipt.terminalStatuses`: never block another handoff. */
const terminal = new Set(['completed', 'failed', 'refused', 'canceled', 'reviewed'])
const providers = new Set(['claude', 'codex', 'cursor', 'ollama'])
/** Control's provider sets (WorkHandoffStore.swift): Continue, native Fork, Fork targets across platforms, Fork sources. */
export const CONTINUE_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'cursor'])
export const FORK_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex'])
const CROSS_PLATFORM_TARGETS: ReadonlySet<string> = new Set(['claude', 'codex'])
const EXPORTABLE_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'cursor'])
/** Control's draftLimit: 32,000 less the status-line reserve, in UTF-16 units. */
const DRAFT_LIMIT = 32_000 - 480
const CHANNELS: ReadonlySet<string> = new Set(['job', 'fork', 'app', 'turn', 'queue', 'tab'])
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const absentOr = (value: unknown, check: (v: unknown) => boolean): boolean => value === undefined || value === null || check(value)
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * A Work session id exactly as a handoff request may name one: `provider:native` with provider claude, codex or cursor
 * and native a full lowercase thread UUID (native-thread-id.ts). Never a short id, a path, or a nested `provider:`.
 */
export function parseWorkSessionId(value: unknown): { provider: string; native: string } | null {
  if (typeof value !== 'string') return null
  const at = value.indexOf(':'), provider = value.slice(0, at), native = value.slice(at + 1)
  return at > 0 && CONTINUE_PROVIDERS.has(provider) && isValidNativeThreadId(native) ? { provider, native } : null
}
/** The provider a model slot runs on. */
export function modelProvider(slot: ModelPreference): 'claude' | 'codex' | 'cursor' | 'ollama' {
  return isClaudeModel(slot) ? 'claude' : isCodexModel(slot) ? 'codex' : isCursorModel(slot) ? 'cursor' : isOllamaModel(slot) ? 'ollama' : 'claude'
}
/**
 * Control's ClaudeSession.sameSession (Models.swift): two `provider:native` ids name one session when the providers
 * match and the native ids are equal, or one is the first 8 or more characters of the other. Case-insensitive.
 */
export function sameSession(a: string, b: string): boolean {
  const split = (v: string) => { const at = v.indexOf(':'); return at > 0 && at < v.length - 1 ? [v.slice(0, at).toLowerCase(), v.slice(at + 1).toLowerCase()] : null }
  const x = split(a), y = split(b)
  if (!x || !y || x[0] !== y[0]) return false
  if (x[1] === y[1]) return true
  const [short, long] = x[1].length <= y[1].length ? [x[1], y[1]] : [y[1], x[1]]
  return short.length >= 8 && long.startsWith(short)
}

/** Control's clock (seconds since 1970) as ISO, or nothing for a value no Date can hold. */
function isoFromSeconds(seconds: unknown): string | undefined {
  return finite(seconds) && seconds > 0 && seconds < 1e11 ? new Date(seconds * 1000).toISOString() : undefined
}

/**
 * Cleaned as a session name is (6.58.2 sanitizeSessionName's characters: controls, zero-width space, direction marks
 * and overrides as spaces, joiners kept, whitespace collapsed), then at most 280 whole characters AND 1,200 UTF-16
 * units, so one character built of many marks cannot make it large. A cut ends in an ellipsis, as Control's clip does.
 */
export function cleanEvidence(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const flat = flattenDisplayText(value)
  if (!flat) return undefined
  const chars = Array.from(graphemes.segment(flat), part => part.segment)
  if (chars.length <= WORK_ACTIVITY_LIMITS.evidence && flat.length <= WORK_ACTIVITY_LIMITS.evidenceUnits) return flat
  let kept = ''
  for (const char of chars.slice(0, WORK_ACTIVITY_LIMITS.evidence - 1)) {
    if (kept.length + char.length > WORK_ACTIVITY_LIMITS.evidenceUnits - 1) break
    kept += char
  }
  return kept.trimEnd() + '…'
}

/**
 * The receipt's optional `progress` block, parsed on its own. Absent is undefined; a malformed block reads
 * `{ unreadable: true }` and never makes the journal unavailable: Control writes it, and a newer Control may write more.
 */
function parseProgress(raw: unknown): { projection: WorkActivityProgress | UnreadableWorkProgress; newestAt?: number } | undefined {
  if (raw === undefined || raw === null) return undefined
  const unreadable = { projection: { unreadable: true as const } }
  if (!object(raw)) return unreadable
  const { reported, reportedBy, evidence, receivedAt, paused, events } = raw
  if (!absentOr(reported, v => typeof v === 'string') || !absentOr(reportedBy, v => typeof v === 'string')
    || !absentOr(evidence, v => text(v, 100_000)) || !absentOr(receivedAt, finite) || !absentOr(paused, v => typeof v === 'boolean')
    || !(events === undefined || (Array.isArray(events) && events.length <= WORK_ACTIVITY_LIMITS.progressEvents))) return unreadable
  const list = (events ?? []) as unknown[]
  let newestAt: number | undefined
  for (const event of list) {
    if (!object(event) || !finite(event.at) || typeof event.kind !== 'string'
      || !absentOr(event.fromStage, v => typeof v === 'string') || !absentOr(event.toStage, v => typeof v === 'string')
      || !absentOr(event.undoneAt, finite)) return unreadable
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
/** The report a progress projection carries, or null (none, or unreadable). */
export function reportOf(progress: WorkActivity['progress']): WorkActivityProgress['reported'] {
  return progress && !('unreadable' in progress) ? progress.reported : null
}

/** A 0.5.248 tab that never reached a session. Control reads it as canceled on load (WorkHandoffStore.unsentTab). */
const unsentTab = (receipt: JournalRecord): boolean => receipt.channel === 'tab' && receipt.status === 'queued' && receipt.sessionID == null
/** The status Control shows for a receipt it loaded: an interrupted send is unknown, an unsent tab canceled. */
const loadedStatus = (receipt: JournalRecord): string => ['preparing', 'sending'].includes(receipt.status as string) ? 'unknown'
  : unsentTab(receipt) ? 'canceled' : receipt.status as string
const sessionOf = (receipt: JournalRecord): string | null => typeof receipt.sessionID === 'string' && receipt.sessionID !== '' ? receipt.sessionID : null
/** Control's appOwner, plus a channel app receipt (a Continue it handed to the app): the app owns the session. */
const ownsInApp = (r: JournalRecord) => (object(r.appOpen) && finite(r.appOpen.openedAt)) || r.channel === 'tab' || r.channel === 'app'
/** Control's serverHolds: a Work New session the COS server is still running. */
const serverHolds = (r: JournalRecord) => r.channel === 'job' && r.mode === 'newSession' && typeof r.sessionID === 'string' && !terminal.has(r.status as string)

function projectReceipt(receipt: JournalRecord, domain: string, all: readonly JournalRecord[], nowMs: number): WorkActivity {
  const raw = receipt.status as string, status = loadedStatus(receipt)
  const activity: WorkActivity = { id: receipt.id as string, workId: receipt.workID as string, domain, status }
  // Control writes preparing or sending just before it sends, for a few seconds. Older than 10 minutes, it was interrupted.
  if (['preparing', 'sending'].includes(raw) && nowMs / 1000 - (receipt.createdAt as number) < WORK_ACTIVITY_LIMITS.sendingSeconds) activity.sending = true
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
  // Only a New session is sent with a model. Control records the placeholder "existing-session" for Continue and Fork.
  const model = (receipt.modelID as string).replace(CONTROL, ' ').trim()
  if (receipt.mode === 'newSession' && model && model !== 'existing-session') activity.model = model
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
  // Ownership is the SESSION's, across every receipt that names it (Control's appOwner and serverHold look at all of them).
  const session = sessionOf(receipt)
  const onSession = session ? all.filter(r => { const other = sessionOf(r); return other !== null && sameSession(other, session) }) : []
  activity.appOpened = onSession.some(ownsInApp)
  activity.serverHold = onSession.some(serverHolds)
  activity.waitingInApp = onSession.some(r => r.channel === 'app' && loadedStatus(r) === 'queued')
  if (receipt.requestedFrom === 'glasses') activity.requestedFrom = 'glasses'
  if (typeof receipt.requestId === 'string' && UUID_V4.test(receipt.requestId)) activity.requestId = receipt.requestId
  if (CHANNELS.has(receipt.channel as string)) activity.channel = receipt.channel as string
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

/** Every receipt for one exact work item, in journal order. `nowMs` only tells a send in flight from an interrupted one. */
export function projectWorkActivity(journal: WorkJournal, domain: string, workIdentity: string, nowMs: number): WorkActivity[] {
  const workId = `task:${domain}:${workIdentity}`
  return journal.receipts.filter(receipt => receipt.workID === workId).map(receipt => projectReceipt(receipt, domain, journal.receipts, nowMs))
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
 * saved against this revision, Control uses only the draft for the task's current one (`draft(for:)`), and a handoff
 * request names it as `expectedTaskRevision`. Pinned to Control's own Swift in __fixtures__/control-task-snapshot.
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

/**
 * A draft's destination, only when Control's sendPlan (WorkHandoffStore.swift) would send exactly that AND a handoff
 * request with it would pass this server's rules. The prompt is read only for being there; it is never returned.
 */
function draftDestination(draft: JournalRecord): SavedDestination | undefined {
  const mode = draft.mode as WorkHandoffMode, provider = draft.provider as string, prompt = draft.prompt as string
  if (!prompt.trim() || prompt.length > DRAFT_LIMIT) return undefined
  const slot = normalizeModelPreference(draft.modelID)
  if (mode === 'newSession') return slot && modelProvider(slot) === provider ? { mode, provider, model: slot } : undefined
  const session = parseWorkSessionId(draft.sessionID)
  if (!session) return undefined
  const sessionId = draft.sessionID as string
  if (mode === 'continueSession') return { mode, provider: session.provider, sessionId }
  // Fork. Across platforms when the draft names another target platform: Control needs an exportable source and a
  // model of that target; a request takes a Fork only from claude or codex. Otherwise a native Fork, whatever other
  // provider the draft still holds.
  if (CROSS_PLATFORM_TARGETS.has(provider) && provider !== session.provider) {
    if (!EXPORTABLE_PROVIDERS.has(session.provider) || !FORK_PROVIDERS.has(session.provider) || !slot || modelProvider(slot) !== provider) return undefined
    return { mode, provider, model: slot, sessionId }
  }
  return FORK_PROVIDERS.has(session.provider) ? { mode, provider: session.provider, sessionId } : undefined
}

/** S4: the destination saved in Control's draft for this task's current revision, when it names one. */
export function savedDestinationFor(journal: WorkJournal, row: WorkBoardRowLite): SavedDestination | undefined {
  const sourceID = `task:${row.domain}:${row.workIdentity || row.id}`, revision = controlSnapshotRevision(row)
  const draft = journal.drafts.find(d => d.sourceID === sourceID && d.sourceRevision === revision)
  return draft ? draftDestination(draft) : undefined
}

/** S2 groups, in order. */
export type OpenWorkGroup = 'needsInput' | 'attention' | 'running' | 'done'
export interface OpenWorkItem extends WorkActivity { workIdentity: string; title: string; taskRevision: string; group: OpenWorkGroup; savedDestination?: SavedDestination }
export interface OpenWorkList { items: OpenWorkItem[]; total: number; truncated: boolean }
const GROUP_RANK: Record<OpenWorkGroup, number> = { needsInput: 0, attention: 1, running: 2, done: 3 }

/**
 * S2: every board task whose newest handoff (any revision), sent in the last 14 days, still wants something:
 * - needsInput: it reports needs input or blocked and you have not acknowledged it;
 * - attention: failed, refused, unknown, or completed with no report, and not acknowledged;
 * - running: queued, running or delivered, or a send in flight (preparing or sending, made in the last 10 minutes;
 *   an older one was interrupted and is unknown);
 * - done: it reports done and you have not acknowledged it.
 * A report counts only on a receipt that did not fail, was not refused and not canceled (Control's WorkTracking.latest).
 * A checked task shows only while its handoff is queued or running (Control's board). Groups in that order, the most
 * recently updated first within each, cut to 50 after sorting; `total` counts them all. Read-only.
 */
export function projectOpenWork(journal: WorkJournal, rows: readonly WorkBoardRowLite[], nowMs: number): OpenWorkList {
  const newest = new Map<string, JournalRecord>()
  for (const receipt of journal.receipts) {
    const prior = newest.get(receipt.workID as string)
    // Control's order: createdAt, then id.
    if (!prior || (receipt.createdAt as number) > (prior.createdAt as number)
      || (receipt.createdAt === prior.createdAt && (receipt.id as string) > (prior.id as string))) newest.set(receipt.workID as string, receipt)
  }
  const nowSeconds = nowMs / 1000, ranked: Array<{ item: OpenWorkItem; rank: number; updatedAt: number; createdAt: number }> = []
  const listed = new Set<string>()
  for (const row of rows) {
    const identity = row.workIdentity || row.id, workId = `task:${row.domain}:${identity}`
    if (!/^[a-f0-9]{12}$/.test(identity) || listed.has(workId)) continue
    listed.add(workId)
    const receipt = newest.get(workId)
    if (!receipt || nowSeconds - (receipt.createdAt as number) >= WORK_ACTIVITY_LIMITS.trackedDays * 86_400) continue
    const activity = projectReceipt(receipt, row.domain, journal.receipts, nowMs)
    const status = activity.status, handled = activity.acknowledged === true
    const reported = ['failed', 'refused', 'canceled'].includes(status) ? null : reportOf(activity.progress)
    // A send in flight is running, not unresolved.
    const sending = activity.sending === true
    const group: OpenWorkGroup | null = (reported === 'needsInput' || reported === 'blocked') && !handled ? 'needsInput'
      : reported === 'done' && !handled ? 'done'
      : sending ? 'running'
      : !handled && (['failed', 'refused', 'unknown'].includes(status) || (status === 'completed' && reported === null)) ? 'attention'
      : ['queued', 'running', 'delivered'].includes(status) ? 'running' : null
    if (!group) continue
    // Control drops a completed task's card unless its handoff is still in progress.
    if (row.checked === true && !sending && !['queued', 'running'].includes(status)) continue
    const item: OpenWorkItem = { ...activity, workIdentity: identity, title: typeof row.title === 'string' ? row.title : '', taskRevision: controlSnapshotRevision(row), group }
    const destination = savedDestinationFor(journal, row)
    if (destination) item.savedDestination = destination
    const updatedAt = activity.updatedAt ? Date.parse(activity.updatedAt) : 0
    ranked.push({ item, rank: GROUP_RANK[group], updatedAt, createdAt: receipt.createdAt as number })
  }
  const items = ranked
    .sort((a, b) => a.rank - b.rank || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.item.id < b.item.id ? 1 : a.item.id > b.item.id ? -1 : 0))
    .slice(0, WORK_ACTIVITY_LIMITS.openItems)
    .map(entry => entry.item)
  return { items, total: ranked.length, truncated: ranked.length > items.length }
}
