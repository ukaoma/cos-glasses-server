import { createHash } from 'node:crypto'
import type { MeetingAskExchange } from '../../shared/meeting-ask.js'
import type { MeetingDetail } from './meeting-store.js'
import type { WorkIntakeItem, WorkIntakeStore } from './work-intake-store.js'
import { WorkIntakeError } from './work-intake-store.js'
import { parseMeetingDescriptor, type MeetingDescriptor } from './work-review-store.js'

export interface FollowUpDependencies {
  store: WorkIntakeStore | null
  identity(value: unknown): string
  get(id: string): MeetingAskExchange
  resolveMeeting(descriptor: MeetingDescriptor): MeetingDetail | Promise<MeetingDetail>
}

/** Explicit user save: no inference, task write, owner guess, or transcript mutation. */
export async function saveAskFollowUp(raw: unknown, deps: FollowUpDependencies): Promise<{ item: WorkIntakeItem }> {
  const body = raw as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(k => !['serverInstanceId', 'requestId', 'meeting', 'text', 'sourceIds'].includes(k))) {
    throw new WorkIntakeError('invalid_follow_up', 400)
  }
  let server: string
  try { server = deps.identity(body.serverInstanceId) } catch { throw new WorkIntakeError('server_identity_mismatch', 409) }
  if (!deps.store) throw new WorkIntakeError('work_intake_unavailable', 503)
  if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.requestId)) throw new WorkIntakeError('invalid_follow_up', 400)
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 600 || /[\x00-\x08\x0b-\x1f\x7f]/.test(body.text)) throw new WorkIntakeError('invalid_follow_up_text', 400)
  const text = body.text.replace(/\s+/g, ' ').trim()
  let exchange: MeetingAskExchange
  try { exchange = deps.get(body.requestId) } catch { throw new WorkIntakeError('answer_unavailable', 404) }
  if (exchange.serverInstanceId !== server || exchange.status !== 'completed') throw new WorkIntakeError('answer_not_completed', 409)
  let descriptor: MeetingDescriptor
  try { descriptor = parseMeetingDescriptor(body.meeting) } catch { throw new WorkIntakeError('invalid_meeting_descriptor', 400) }
  if (!descriptor.recordId) throw new WorkIntakeError('meeting_identity_required', 400)
  let meeting: MeetingDetail
  try { meeting = await deps.resolveMeeting(descriptor) } catch { throw new WorkIntakeError('meeting_unavailable', 409) }
  if (meeting.recordId !== descriptor.recordId) throw new WorkIntakeError('meeting_identity_changed', 409)
  const captures = new Set([meeting.sessionId, meeting.sourceSessionId, ...(meeting.g2SessionIds ?? []),
    ...(meeting.contextKeys ?? []).filter(k => k.startsWith('g2:')).map(k => k.slice(3)),
    ...(meeting.sources ?? []).filter(s => s.kind === 'g2').map(s => s.id)])
  if (!captures.has(exchange.sessionId) || meeting.contextAmbiguous) throw new WorkIntakeError('meeting_capture_mismatch', 409)
  const ids = body.sourceIds === undefined ? exchange.sources.slice(0, 8).map(s => s.id) : body.sourceIds
  if (!Array.isArray(ids) || ids.length > 8 || ids.some(id => typeof id !== 'string' || !exchange.sources.some(s => s.id === id))) throw new WorkIntakeError('invalid_follow_up_source', 400)
  const sources = [...new Set(ids)].map(id => exchange.sources.find(s => s.id === id)!).map(s => ({
    id: s.id, kind: s.kind, title: s.title.slice(0, 300), text: s.text.slice(0, 600),
    ...(s.text.length > 600 ? { truncated: true } : {}),
    ...(s.url ? { url: s.url.slice(0, 2048) } : {}),
    ...(s.elapsedMs !== undefined ? { elapsedMs: s.elapsedMs } : {}),
  }))
  const now = new Date().toISOString()
  const id = 'wi_' + createHash('sha256').update(JSON.stringify([server, exchange.requestId, text])).digest('hex').slice(0, 32)
  const item: WorkIntakeItem = { id, kind: 'ask', status: 'review', reason: 'unclear_task',
    meeting: { ...descriptor, recordId: descriptor.recordId, title: meeting.title }, confidence: 0, model: 'user-reviewed',
    producedAt: now, updatedAt: now, text, owner: null, ownerIsMiles: false,
    askEvidence: { requestId: exchange.requestId, sessionId: exchange.sessionId, throughMs: exchange.throughMs, question: exchange.question.slice(0, 2000), answer: (exchange.answer ?? '').slice(0, 6000), ...((exchange.answer?.length ?? 0) > 6000 ? { answerTruncated: true } : {}), sources } }
  const result = deps.store.upsert([item])
  if (result.rejected.length) throw new WorkIntakeError(result.rejected[0].code, 409)
  const saved = deps.store.get(id)
  // Resolved items are sticky: retries must not reopen them or claim a new save.
  if (!saved) throw new WorkIntakeError('follow_up_not_saved', 503)
  return { item: saved }
}
