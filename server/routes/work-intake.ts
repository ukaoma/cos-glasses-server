import { Router } from 'express'
import { WorkIntakeError, WorkIntakeStore, type IntakeMeeting, type WorkIntakeItem } from '../lib/work-intake-store.js'
import { captureWorkItem, linkTaskMeeting, listBoard, workIntakeCapabilities, TaskBridgeError, TaskRunError,
  type WorkMeetingRef } from '../lib/task-store.js'
import { resolveSavedMeetingDetail } from './meetings.js'
import type { MeetingDescriptor } from '../lib/work-review-store.js'
import type { MeetingDetail } from '../lib/meeting-store.js'

export interface WorkIntakeDependencies {
  store: WorkIntakeStore | null
  list: typeof listBoard
  capabilities: typeof workIntakeCapabilities
  link: typeof linkTaskMeeting
  capture: typeof captureWorkItem
  resolveMeeting: (descriptor: MeetingDescriptor) => MeetingDetail | Promise<MeetingDetail>
}
const MAX_MEETING_REFS = 8 // task_work_metadata.MAX_REFS
export const LINK_RACE_RETRIES = 2
const DUE_TAIL = /\s*[—–-]+\s*Due:[^()]*$/

/**
 * The words an accepted item becomes on the board. An ask records whose item it was: the producer moves the
 * owner's trailing tag out of the words, so it is written back here as "(from Name)", ahead of any due date.
 */
export function intakeCardText(item: Pick<WorkIntakeItem, 'text' | 'owner' | 'ownerIsMiles'>): string {
  const text = item.text ?? '', owner = item.owner?.trim()
  if (item.ownerIsMiles || !owner) return text
  const due = DUE_TAIL.exec(text)
  return due ? `${text.slice(0, due.index)} (from ${owner})${due[0]}` : `${text} (from ${owner})`
}

/** Auth is supplied by the parent /api mount. Nothing here calls a model or starts an agent. */
export function createWorkIntakeRouter(overrides: Partial<WorkIntakeDependencies> & Pick<WorkIntakeDependencies, 'store'>): Router {
  const deps: WorkIntakeDependencies = { list: listBoard, capabilities: workIntakeCapabilities, link: linkTaskMeeting,
    capture: captureWorkItem, resolveMeeting: resolveSavedMeetingDetail, ...overrides }
  const router = Router()
  router.use('/work-intake', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store')
    if (!deps.store) return res.status(503).json({ error: { code: 'work_intake_unavailable', message: 'Work intake is unavailable on this server.' } })
    next()
  })
  /** Refusals are answers; anything unexpected is also logged, since Control only shows the code. */
  const fail = (res: import('express').Response, e: unknown, where: string) => {
    if (e instanceof WorkIntakeError) {
      if (e.status >= 500) console.error(`[work-intake] ${where}: ${e.code}`)
      return res.status(e.status).json({ error: { code: e.code } })
    }
    if (e instanceof TaskRunError) {
      if (e.status >= 500) console.error(`[work-intake] ${where}: ${e.code}: ${e.message}`)
      return res.status(e.status).json({ error: { code: e.code, message: e.message } })
    }
    if (e instanceof TaskBridgeError) return res.status(e.code === 'task_not_found' ? 404 : 409).json({ error: { code: e.code, message: e.message } })
    console.error(`[work-intake] ${where} failed:`, e instanceof Error ? e.message : e)
    return res.status(503).json({ error: { code: 'work_intake_unavailable', message: 'Work intake is unavailable. Refresh before trying again.' } })
  }

  router.get('/work-intake', async (_req, res) => {
    try {
      const items = deps.store!.open()
      const counts = { suggested: 0, ask: 0, review: 0 }
      for (const item of items) counts[item.status as keyof typeof counts]++
      res.json({ schemaVersion: 1, capabilities: await deps.capabilities(), counts, items, quarantined: deps.store!.quarantineCount() })
    } catch (e) { fail(res, e, 'list') }
  })

  router.post('/work-intake/items', (req, res) => {
    try {
      const body = req.body
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'items') || !Array.isArray(body.items)) {
        throw new WorkIntakeError('invalid_intake_batch', 400)
      }
      res.json({ ok: true, ...deps.store!.upsert(body.items) })
    } catch (e) { fail(res, e, 'upsert') }
  })

  router.post('/work-intake/:id/resolve', async (req, res) => {
    try {
      const action = req.body?.action
      if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).some(k => k !== 'action') || (action !== 'accept' && action !== 'dismiss')) {
        throw new WorkIntakeError('invalid_intake_action', 400)
      }
      const item = await deps.store!.resolve(String(req.params.id), async current =>
        action === 'dismiss' ? { action: 'dismiss' } : { action: 'accept', taskId: await accept(current) })
      res.json({ ok: true, item })
    } catch (e) { fail(res, e, 'resolve') }
  })

  /** The meeting must still be the one that was judged; its canonical title comes from the library, not the producer. */
  async function verifiedMeeting(m: IntakeMeeting): Promise<WorkMeetingRef> {
    const descriptor: MeetingDescriptor = { domain: m.domain, month: m.month, filename: m.filename, recordId: m.recordId }
    let resolved: MeetingDetail
    try { resolved = await deps.resolveMeeting(descriptor) }
    catch { throw new WorkIntakeError('meeting_unavailable', 409) }
    if (resolved.recordId !== m.recordId) throw new WorkIntakeError('meeting_identity_changed', 409)
    return { ...descriptor, recordId: m.recordId, title: (resolved.title || m.title).replace(/\s+/g, ' ').trim().slice(0, 300) }
  }

  async function accept(item: WorkIntakeItem): Promise<string> {
    // The write power first: a read-only board must say so, not report its meeting as unreadable.
    const capabilities = await deps.capabilities()
    if (capabilities.bridgeUnavailable) throw new WorkIntakeError('task_bridge_unavailable', 503)
    if (item.kind === 'link' && !capabilities.linkWrites) throw new WorkIntakeError('work_board_read_only', 409)
    if (item.kind === 'ask' && !capabilities.cardCreation) throw new WorkIntakeError('card_creation_unavailable', 409)
    const meeting = await verifiedMeeting(item.meeting)
    if (item.kind === 'link') {
      const task = item.task!
      // Work identity survives a rename; the task id does not.
      return linkRow(task.domain, r => r.workIdentity === task.workIdentity || r.id === task.id, meeting)
    }
    const out = await deps.capture(meeting.domain, intakeCardText(item), meeting)
    if (out.created || out.linked) return out.id
    // The same words are already an OPEN task: that task is this work, so link it (as the producer does).
    // On closed, archived or delegated work, adding a second card with the same words is refused.
    if (!out.checked && !out.archived && !out.delegated) return linkRow(meeting.domain, r => r.id === out.id, meeting)
    throw new WorkIntakeError('intake_text_collision', 409)
  }

  /** Link one task to the meeting. Re-reads the row on every attempt; up to two retries on a revision race. */
  async function linkRow(domain: string, match: (row: Awaited<ReturnType<typeof listBoard>>[number]) => boolean, meeting: WorkMeetingRef): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const row = (await deps.list()).find(r => r.domain === domain && match(r))
      if (!row || !row.workRevision) throw new WorkIntakeError('intake_task_changed', 409)
      const refs = row.meetingRefs ?? []
      if (refs.some(ref => ref.recordId === meeting.recordId)) return row.id
      if (refs.length >= MAX_MEETING_REFS) throw new WorkIntakeError('meeting_links_full', 409)
      try {
        await deps.link(row.domain, row.id, row.text, row.workRevision, meeting)
        return row.id
      } catch (e) {
        if (attempt < LINK_RACE_RETRIES && e instanceof TaskBridgeError && e.code === 'task_revision_changed') continue
        throw e
      }
    }
  }
  return router
}
