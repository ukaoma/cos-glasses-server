// Stop a G2 meeting from the Mac (COS Control), by asking the glasses to stop.
//
// WHY A REQUEST AND NOT A SAVE. POST /api/meeting/save on a live G2 session saves what
// has arrived and closes the session, but the phone that captures the audio does not
// stop: its mic stays on, the lens keeps showing REC, every later chunk is refused with
// 410 session_closed, and local-first capture files that tail as a separate recovery
// meeting. So the Mac never saves a live G2 meeting itself. It ASKS: this store holds the
// request, the display bus carries `meeting_stop_requested` to the companion, and the
// companion runs its own Stop (the same one the lens and the phone run), which saves
// through /api/meeting/save with every chunk it holds.
//
// THE CLAIM. A request is acted on only after the companion CLAIMS it here, and a claim is
// accepted only within STOP_REQUEST_CLAIM_WINDOW_MS of the request, measured on this
// server's clock (the phone's clock is never compared). Control waits a little longer
// than that window before it says "Glasses not connected", so a phone that wakes later,
// or a display-bus replay of an old event, can never stop a meeting the Mac already told
// the person was not stopped.

import { randomUUID } from 'node:crypto'

export const STOP_REQUEST_CLAIM_WINDOW_MS = 10_000
/** How long a settled request stays readable for Control's poll. */
export const STOP_REQUEST_RETAIN_MS = 10 * 60_000
export const STOP_REQUEST_REFUSAL_REASONS = ['not_recording', 'other_session', 'stop_in_progress'] as const
export type StopRequestRefusal = typeof STOP_REQUEST_REFUSAL_REASONS[number]

export type StopRequestState = 'pending' | 'claimed' | 'refused' | 'expired'

export interface StopRequest {
  requestId: string
  sessionId: string
  source: string
  requestedAt: number
  state: StopRequestState
  claimedAt: number | null
  refusal: StopRequestRefusal | null
}

export type StopClaimResult =
  | { ok: true; request: StopRequest }
  | { ok: false; reason: 'unknown_request' | 'expired' | 'refused' }

export interface StopRequestStore {
  /** A pending request for this session is reused (same id), so a double click asks once. */
  request(sessionId: string, source: string): StopRequest
  claim(sessionId: string, requestId: string): StopClaimResult
  refuse(sessionId: string, requestId: string, reason: StopRequestRefusal): StopClaimResult
  get(sessionId: string, requestId: string): StopRequest | null
}

export function isStopRequestRefusal(value: unknown): value is StopRequestRefusal {
  return typeof value === 'string' && (STOP_REQUEST_REFUSAL_REASONS as readonly string[]).includes(value)
}

export function createStopRequestStore(deps: { now?: () => number; newId?: () => string } = {}): StopRequestStore {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => `stop_${randomUUID()}`)
  const requests = new Map<string, StopRequest>()

  const settle = (request: StopRequest, at: number): StopRequest => {
    if (request.state === 'pending' && at - request.requestedAt > STOP_REQUEST_CLAIM_WINDOW_MS) request.state = 'expired'
    return request
  }
  const prune = (at: number) => {
    for (const [id, request] of requests) {
      if (at - request.requestedAt > STOP_REQUEST_RETAIN_MS) requests.delete(id)
    }
  }
  const find = (sessionId: string, requestId: string): StopRequest | null => {
    const request = requests.get(requestId)
    return request && request.sessionId === sessionId ? request : null
  }

  return {
    request(sessionId, source) {
      const at = now()
      prune(at)
      for (const request of requests.values()) {
        if (request.sessionId === sessionId && settle(request, at).state === 'pending') return request
      }
      const request: StopRequest = {
        requestId: newId(),
        sessionId,
        source,
        requestedAt: at,
        state: 'pending',
        claimedAt: null,
        refusal: null,
      }
      requests.set(request.requestId, request)
      return request
    },
    claim(sessionId, requestId) {
      const at = now()
      const request = find(sessionId, requestId)
      if (!request) return { ok: false, reason: 'unknown_request' }
      settle(request, at)
      // A second claim of a claimed request is the same phone retrying a lost answer.
      if (request.state === 'claimed') return { ok: true, request }
      if (request.state === 'expired') return { ok: false, reason: 'expired' }
      if (request.state === 'refused') return { ok: false, reason: 'refused' }
      request.state = 'claimed'
      request.claimedAt = at
      return { ok: true, request }
    },
    refuse(sessionId, requestId, reason) {
      const at = now()
      const request = find(sessionId, requestId)
      if (!request) return { ok: false, reason: 'unknown_request' }
      settle(request, at)
      if (request.state === 'claimed') return { ok: true, request }
      if (request.state === 'pending') {
        request.state = 'refused'
        request.refusal = reason
      }
      return request.state === 'refused' ? { ok: true, request } : { ok: false, reason: 'expired' }
    },
    get(sessionId, requestId) {
      const request = find(sessionId, requestId)
      return request ? settle(request, now()) : null
    },
  }
}
