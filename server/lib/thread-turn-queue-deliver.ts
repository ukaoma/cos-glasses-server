// Delivering a queued turn by re-entering this server's own attach + turn routes.
//
// WHY LOOPBACK AND NOT A DIRECT CALL. Delivery is not "post a prompt". It is the
// occupancy gate, the target fence, the per-target claim, the divergence watermark, the
// idempotency ledger and the child-pid accounting -- a long, ordered sequence in
// agent-session-bindings.ts where every branch exists because something once went
// wrong. Re-implementing it here would create a second place for the gate to drift, and
// the drift would be invisible until the day it mattered. Going back in through the
// front door means the gate runs exactly once, in its existing home, and this file
// cannot weaken it even by accident.
//
// The cost is one loopback request per delivered turn, at a volume of a handful a day.
//
// THE WATERMARK EXEMPTION LIVES HERE, and nowhere else. A queued turn drains after the
// thread has moved on -- that is what it waited for -- so its binding is minted FRESH
// at delivery against the thread as it stands. The turn is therefore always composed
// against a current baseline, which is what the user meant by queueing it: "append this
// to whatever the thread is when it frees". An interactive turn still gets the full
// divergence check, because there the user composed against a state they were looking
// at and a silent change is genuinely surprising. Miles approved this explicitly.
//
// FAILS CLOSED, AND AMBIGUITY IS A FAILURE. Anything other than a clean admission
// resolves `ok: false`, which returns the turn to the queue rather than marking it
// sent. The caller bounds retries; the danger to avoid here is the opposite one --
// reporting success for a turn that may not have landed, which loses it silently.

import { request } from 'node:http'
import type { QueuedThreadTurn } from './thread-turn-queue.js'

/** Per-request ceiling. Attach and turn both answer immediately; the turn route
 *  admits with 202 and does the long work in the background. */
const DELIVER_TIMEOUT_MS = 15_000

interface LoopbackReply { status: number; body: Record<string, unknown> }

function post(port: number, token: string, path: string, payload: unknown): Promise<LoopbackReply> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        // The header the rest of COS authenticates with. NOT `Authorization: Bearer`.
        'X-Cos-Token': token,
      },
      timeout: DELIVER_TIMEOUT_MS,
    }, res => {
      let raw = ''
      res.on('data', c => { raw += c })
      res.on('end', () => {
        let body: Record<string, unknown> = {}
        try { body = raw ? JSON.parse(raw) as Record<string, unknown> : {} } catch { /* non-JSON is a failure below */ }
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    req.on('timeout', () => { req.destroy(new Error('deliver_timeout')) })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

/**
 * Attach, then send. Returns `ok` only on a provable admission.
 *
 * The attach is what re-baselines the watermark: it reads the thread's head digest as
 * it is NOW, so the turn that follows cannot be refused for divergence that happened
 * while the turn was waiting.
 */
export async function deliverQueuedTurnOverLoopback(
  turn: QueuedThreadTurn,
  port: number,
  token: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const attach = await post(
      port, token,
      `/api/agent-sessions/${encodeURIComponent(turn.provider)}/${encodeURIComponent(turn.threadId)}/attach`,
      { cosSessionId: turn.cosSessionId },
    )
    if (attach.status !== 200 && attach.status !== 201) {
      // The gate said no at drain time. Not an error -- the queue holds and tries again.
      return { ok: false, reason: String(attach.body.error ?? `attach_${attach.status}`) }
    }
    const bindingId = typeof attach.body.bindingId === 'string' ? attach.body.bindingId : ''
    if (!bindingId) return { ok: false, reason: 'attach_no_binding' }

    const sent = await post(
      port, token,
      `/api/agent-sessions/bindings/${encodeURIComponent(bindingId)}/turns`,
      // `clientTurnId` is carried through unchanged so the turn route's own
      // idempotency ledger recognises a re-delivery of the SAME turn. Without it a
      // retry after an ambiguous response would put the sentence in twice.
      { clientTurnId: turn.clientTurnId, prompt: turn.prompt },
    )
    // 202 is the success shape: admitted, delivered in the background, poll the ledger.
    if (sent.status === 202 || sent.status === 200) return { ok: true }
    return { ok: false, reason: String(sent.body.error ?? `turn_${sent.status}`) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'deliver_failed' }
  }
}
