import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export interface WorkActivity {
  id: string; workId: string; domain: string; status: string
  provider?: string; sessionId?: string; sessionTitle?: string; error?: string
}
export interface WorkActivityResult { version: 1; available: boolean; reason?: string; activities: WorkActivity[] }
/** These options are dependency injection for fixtures, never request parameters. */
export interface WorkActivityOptions {
  journalPath?: string; home?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv
}
const unavailable = (reason: string): WorkActivityResult => ({ version: 1, available: false, reason, activities: [] })
const statuses = new Set(['preparing', 'sending', 'queued', 'running', 'delivered', 'completed', 'failed', 'refused', 'reviewed', 'canceled', 'unknown'])
const providers = new Set(['claude', 'codex', 'cursor', 'ollama'])
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max

/** Read a native receipt projection, not a provider status or task-completion verdict.
 * Atomic native journal replacement permits a consistent opened-file read without
 * taking its dispatch lock. No title/keyword matching, inferred target or writes.
 */
export function readWorkActivity(domain: string, workIdentity: string, options: WorkActivityOptions = {}): WorkActivityResult {
  const env = options.env ?? process.env, home = options.home ?? homedir()
  if (!options.journalPath) {
    if ((options.platform ?? process.platform) !== 'darwin') return unavailable('Native Work history is available only on its Mac host.')
    if (env.NODE_ENV === 'test' || env.VITEST || env.COS_CONTROL_TEST_HOME || env.COS_CONTROL2_ISOLATED_PREVIEW === '1'
      || env.COS_WORK_CONNECTED_TEST === '1'
      || (env.COS_DATA_DIR && resolve(env.COS_DATA_DIR) !== join(home, '.cos-glasses', 'data'))) {
      return unavailable('This isolated runtime does not read the native Work history.')
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
      if (!stat.isDirectory() || stat.isSymbolicLink()) return unavailable('Native Work history is not safely readable.')
      const next = dirname(parent); if (next === parent) break; parent = next
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size >= 10_000_000 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return unavailable('Native Work history is not safely readable.')
    const buffer = Buffer.alloc(Math.min(stat.size + 1, 10_000_000))
    let count = 0
    while (count < buffer.length) { const n = readSync(fd, buffer, count, buffer.length - count, null); if (!n) break; count += n }
    const after = fstatSync(fd), raw = buffer.subarray(0, count)
    if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || raw.length >= 10_000_000) return unavailable('Native Work history exceeds the supported limit.')
    const journal: unknown = JSON.parse(raw.toString('utf8'))
    if (!object(journal) || ![1, 2].includes(journal.version as number) || !Array.isArray(journal.receipts)
      || journal.receipts.length > 10_000 || !Array.isArray(journal.sessions)
      || (journal.drafts !== undefined && !Array.isArray(journal.drafts))) return unavailable('Native Work history has an unsupported format.')
    // Match native Codable's required session/draft fields. A malformed journal
    // is unavailable even when its receipt array happens to look plausible.
    for (const session of journal.sessions) {
      if (!object(session) || !['id','nativeID','provider','title','summary','project','status'].every(key => text(session[key], 100_000))
        || ['waitingDetail','failure'].some(key => session[key] != null && !text(session[key], 100_000))) return unavailable('Native Work history has an unsupported format.')
    }
    const draftKeys = new Set<string>()
    for (const draft of journal.drafts ?? []) {
      if (!object(draft) || !['sourceID','sourceRevision','sessionID','provider','modelID','prompt'].every(key => text(draft[key], 100_000))
        || !draft.sourceID || !draft.sourceRevision || !['continueSession','fork','newSession'].includes(draft.mode as string)
        || typeof draft.editVersion !== 'number' || !Number.isSafeInteger(draft.editVersion) || draft.editVersion < 0) return unavailable('Native Work history has an unsupported format.')
      const key = JSON.stringify([draft.sourceID, draft.sourceRevision])
      if (draftKeys.has(key)) return unavailable('Native Work history has an unsupported format.')
      draftKeys.add(key)
    }
    const seen = new Set<string>(), activities: WorkActivity[] = [], workId = `task:${domain}:${workIdentity}`
    for (const receipt of journal.receipts) {
      if (!object(receipt) || !text(receipt.id, 256) || !receipt.id || seen.has(receipt.id)
        || !text(receipt.workID, 1024) || !text(receipt.workTitle, 8000) || !text(receipt.sourceRevision, 1024)
        || !['continueSession', 'fork', 'newSession'].includes(receipt.mode as string)
        || !text(receipt.provider, 64) || !text(receipt.modelID, 256)
        || !text(receipt.sessionTitle, 8000) || !statuses.has(receipt.status as string)
        || !text(receipt.detail, 100_000) || !text(receipt.prompt, 100_000)
        || typeof receipt.createdAt !== 'number' || !Number.isFinite(receipt.createdAt)
        || ['sessionID','result','sourceSessionID','bindingID','boundTo','channel','jobID','serverInstanceID'].some(key => receipt[key] != null && !text(receipt[key], 1_000_000))
        || (receipt.epoch != null && (typeof receipt.epoch !== 'number' || !Number.isSafeInteger(receipt.epoch)))) return unavailable('Native Work history has an unsupported format.')
      seen.add(receipt.id)
      if (receipt.workID !== workId) continue
      const status = ['preparing', 'sending'].includes(receipt.status as string) ? 'unknown' : receipt.status as string
      const activity: WorkActivity = { id: receipt.id, workId, domain, status }
      // Native sessionIDs are provider-qualified. Refuse cross-provider identity;
      // missing ownership stays missing rather than being inferred from titles.
      if (providers.has(receipt.provider)) {
        activity.provider = receipt.provider
        if (typeof receipt.sessionID === 'string' && receipt.sessionID.startsWith(receipt.provider + ':')
          && receipt.sessionID.length > receipt.provider.length + 1 && !/[\x00-\x1f\x7f]/.test(receipt.sessionID)) {
          activity.sessionId = receipt.sessionID
          activity.sessionTitle = receipt.sessionTitle.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)
        }
      }
      if (['unknown', 'failed', 'refused', 'canceled'].includes(status)) activity.error = status === 'unknown'
        ? 'Delivery is unresolved. Inspect the original session before trying again.'
        : 'This handoff did not complete successfully. Open COS Control for details.'
      activities.push(activity)
    }
    return { version: 1, available: true, activities }
  } catch (error) {
    return unavailable((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'No native Work history is available on this host.' : 'Native Work history could not be read.')
  } finally { if (fd !== undefined) closeSync(fd) }
}
