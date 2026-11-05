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
 */
export interface WebAskAdmissionDeps {
  /** Highest message number in use in the active era (live, archive, reservations). */
  currentMax: () => number
  activeEra: () => string
  sessionExists: (sessionId: string) => boolean
  createSession: () => string
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

/** Returns the request with `source` removed and the web fields filled. Synchronous after the replay lookup, so the
 * mint and the floor update happen together. */
export async function prepareWebAsk(input: Record<string, unknown>, deps: WebAskAdmissionDeps): Promise<Record<string, unknown>> {
  const { source: _source, ...rest } = input
  const clientJobId = typeof rest.clientJobId === 'string' ? rest.clientJobId.toLowerCase() : ''
  const generation = Number(rest.generation)
  const prior = clientJobId && Number.isSafeInteger(generation) && generation >= 1
    ? await deps.priorJob(clientJobId, generation).catch(() => undefined)
    : undefined
  if (prior?.sessionId && prior.globalMsgNum) {
    return { ...rest, sessionId: prior.sessionId, globalMsgNum: prior.globalMsgNum, messageEra: prior.messageEra ?? deps.activeEra() }
  }
  const asked = typeof rest.sessionId === 'string' ? rest.sessionId : ''
  const sessionId = asked && deps.sessionExists(asked) ? asked : deps.createSession()
  const globalMsgNum = Math.max(deps.currentMax(), lastMinted) + 1
  lastMinted = globalMsgNum
  return { ...rest, sessionId, globalMsgNum, messageEra: deps.activeEra() }
}
