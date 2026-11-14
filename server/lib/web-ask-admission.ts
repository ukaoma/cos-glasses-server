/**
 * 6.99.10 (Drop it plan section 12): Ask from COS Control Web goes through POST /api/query-jobs, the route the glasses
 * use, with `source: 'web'`. The browser holds no message counter and no conversation, so the server fills in what the
 * phone would send:
 *
 * - `sessionId`: kept when it names a live conversation (a follow-up), else a new conversation is made, as the morning
 *   brief does. The answer projects into that conversation, so it reads in Messages (Recent on the Mac and the web)
 *   and in the lens message list like any other turn.
 * - `globalMsgNum`: the next message number, minted from the same ceiling /api/message-counter serves (live sessions,
 *   the archive, and every number a not-yet-projected job holds), and never below a number this process minted
 *   already, so two web asks at once take two numbers. One web Ask moves the counter by exactly one.
 * - `messageEra`: the active era.
 *
 * A retry of the same clientJobId and generation (a lost 202) reuses the first admission's session and number, so it
 * replays instead of conflicting. `source` itself is consumed here; the job journal does not store it.
 *
 * Any other source value, or none, is left exactly as it was: the glasses and Control paths are unchanged.
 *
 * 7.0.39 (persistent COS thread, candidate 2; docs/cos-thread.md): `cosThread: true` with `source: 'web'` is an Ask from
 * the pinned COS thread. It takes NO message number (nothing minted, nothing reserved) and runs in a conversation
 * flagged as the thread's (conversation.ts Session.cosThread), kept when the asked sessionId is one, else made new. Such
 * a conversation is in no client's list, never archived, and sends nothing on the display bus; the thread store keeps
 * the question and the whole answer. `cosThread` is consumed here, like `source`. A plain web Ask that names a thread
 * conversation is refused (409 thread_session_web_only): it would vanish into a conversation no list shows.
 */
export interface WebAskAdmissionDeps {
  /** Highest message number in use in the active era (live, archive, reservations). */
  currentMax: () => number
  activeEra: () => string
  sessionExists: (sessionId: string) => boolean
  createSession: (options?: { cosThread?: boolean }) => string
  /** 7.0.39 candidate 3: records that this numbered turn was asked from Control Web (conversation.ts markWebAsk). */
  markWebAsk?: (sessionId: string, era: string, no: number) => void
  /** 7.0.39: the conversation carries the pinned COS thread. Absent: none does. */
  isThreadSession?: (sessionId: string) => boolean
  /** The admitted job for this client identity, if any (lost-202 replay). */
  priorJob: (clientJobId: string, generation: number) => Promise<{ sessionId?: string; globalMsgNum?: number; messageEra?: string } | undefined>
}

export const WEB_ASK_SOURCE = 'web'
let lastMinted = 0

/** Test-only: forget the in-process floor. */
export function resetWebAskMintForTests(): void { lastMinted = 0 }

export function isWebAsk(input: Record<string, unknown>): boolean {
  return input.source === WEB_ASK_SOURCE
}

/** 7.0.39: an Ask from the pinned COS thread (exactly `cosThread: true`). */
export function isThreadAsk(input: Record<string, unknown>): boolean {
  return input.cosThread === true
}

/** A refusal at admission, with the status and code the query-jobs route answers. */
export class WebAskAdmissionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'WebAskAdmissionError' }
}

/** Returns the request with `source` removed and the web fields filled. Synchronous after the replay lookup, so the
 * mint and the floor update happen together. */
export async function prepareWebAsk(input: Record<string, unknown>, deps: WebAskAdmissionDeps): Promise<Record<string, unknown>> {
  const { source: _source, cosThread: rawThread, ...rest } = input
  if (rawThread !== undefined && rawThread !== true) {
    throw new WebAskAdmissionError(400, 'invalid_cos_thread', 'cosThread is true or absent.')
  }
  const isThread = (id: string) => deps.isThreadSession?.(id) === true
  const clientJobId = typeof rest.clientJobId === 'string' ? rest.clientJobId.toLowerCase() : ''
  const generation = Number(rest.generation)
  const prior = clientJobId && Number.isSafeInteger(generation) && generation >= 1
    ? await deps.priorJob(clientJobId, generation).catch(() => undefined)
    : undefined
  const asked = typeof rest.sessionId === 'string' ? rest.sessionId : ''
  if (rawThread === true) {
    // A replay (lost 202) runs in the first admission's conversation; a follow-up continues the thread's; anything else
    // starts a new thread conversation. Never a number.
    if (prior?.sessionId) return { ...rest, sessionId: prior.sessionId, messageEra: prior.messageEra ?? deps.activeEra() }
    // A Retry (the next generation of the same clientJobId) stays in the conversation its first try ran in.
    const earlier = Number.isSafeInteger(generation) && generation > 1
      ? await deps.priorJob(clientJobId, generation - 1).catch(() => undefined)
      : undefined
    const keep = [asked, earlier?.sessionId ?? ''].find(id => id && deps.sessionExists(id) && isThread(id))
    const sessionId = keep ?? deps.createSession({ cosThread: true })
    return { ...rest, sessionId, messageEra: deps.activeEra() }
  }
  if (prior?.sessionId && prior.globalMsgNum) {
    return { ...rest, sessionId: prior.sessionId, globalMsgNum: prior.globalMsgNum, messageEra: prior.messageEra ?? deps.activeEra() }
  }
  if (asked && isThread(asked)) {
    throw new WebAskAdmissionError(409, 'thread_session_web_only', 'That conversation is the pinned COS thread. Ask from the thread.')
  }
  const sessionId = asked && deps.sessionExists(asked) ? asked : deps.createSession()
  const globalMsgNum = Math.max(deps.currentMax(), lastMinted) + 1
  lastMinted = globalMsgNum
  const messageEra = deps.activeEra()
  // 7.0.39 candidate 3 (Q1, lead 13:0x): THIS turn was asked on the web (the timeline's surface), recorded per turn.
  deps.markWebAsk?.(sessionId, messageEra, globalMsgNum)
  return { ...rest, sessionId, globalMsgNum, messageEra }
}
