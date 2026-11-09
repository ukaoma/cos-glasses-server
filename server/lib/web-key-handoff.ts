// The handoff from Control Web (3143) to the phone key signer (3144) (6.99.31, review W2). Behind
// COS_WEB_KEY_AUTHORITY (default off; the routes in routes/web-key.ts fall through when it is off).
//
// HOW IT WORKS. The composer on 3143 posts the turn it wants approved (words, binding, its turn id).
// The server resolves the real destination from the binding and keeps it here under a random id for
// two minutes. The composer then NAVIGATES (top level, never a frame or a message) to
// `https://<host>:3144/#h=<id>`. The signer page claims the id once, from its own origin, and shows
// exactly what it will sign. The words never travel in a URL; the id is in the fragment, which is
// not sent to any server and not in a Referer.
//
// WHAT IT DOES NOT DO. A handoff is not authority: a cookie holder (so any token holder) can create
// one. Authority comes only from the phone's tap, its key and Face ID over the envelope the signer
// builds and shows from these exact bytes.

import { randomBytes } from 'node:crypto'
import { parseWebApprovalPacket, parseWebTurnScope, type WebApprovalPacket, type WebTurnScope } from '../../shared/web-turn-envelope.js'
import { canonicalBytes, sha256Hex } from './web-key-envelope.js'

export const WEB_KEY_HANDOFF_TTL_MS = 120_000
export const WEB_KEY_HANDOFF_MAX_OPEN = 8
/** The longest words a phone approval carries (the turn route takes more; a phone screen should not). */
export const WEB_KEY_HANDOFF_MAX_WORDS = 8_000

const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/
const BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const OPAQUE = /^[A-Za-z0-9_.:-]{1,256}$/

/** The turn request the signer will post, minus the words (they travel beside it). */
export interface SignHandoffTurn {
  bindingId: string
  epoch: number
  targetKey: string
  clientTurnId: string
  acknowledgedRevision?: string
  boundTo?: string
}

export interface SignHandoffRequest {
  words: string
  turn: SignHandoffTurn
  packetSha256: string | null
}

/** What the signer is told, exactly once. */
export interface SignHandoffView {
  handoffId: string
  exp: number
  words: string
  provider: string
  sessionId: string
  bindingId: string
  turn: SignHandoffTurn
  scope: WebTurnScope
  /** Full canonical preimage of an approval packet, so the phone can verify and display it. */
  packet: WebApprovalPacket | null
  attachments: []
}

export type HandoffParse = { ok: true; request: SignHandoffRequest } | { ok: false; reason: 'invalid_request' | 'attachments_not_signable' | 'words_too_long' }

/** The composer's body: { bindingId, epoch, targetKey, clientTurnId, prompt, acknowledgedRevision?, boundTo?, packetSha256? }. */
export function parseHandoffRequest(body: unknown): HandoffParse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, reason: 'invalid_request' }
  const b = body as Record<string, unknown>
  // Files cannot be signed until the shared files block exists (contract section 6): refuse, never drop.
  if (b.attachmentIds !== undefined && !(Array.isArray(b.attachmentIds) && b.attachmentIds.length === 0)) return { ok: false, reason: 'attachments_not_signable' }
  if (typeof b.prompt !== 'string' || b.prompt.trim().length === 0) return { ok: false, reason: 'invalid_request' }
  if (b.prompt.length > WEB_KEY_HANDOFF_MAX_WORDS) return { ok: false, reason: 'words_too_long' }
  if (typeof b.bindingId !== 'string' || !BINDING_ID.test(b.bindingId)) return { ok: false, reason: 'invalid_request' }
  if (!Number.isSafeInteger(b.epoch) || (b.epoch as number) < 1) return { ok: false, reason: 'invalid_request' }
  if (typeof b.targetKey !== 'string' || b.targetKey.length === 0 || b.targetKey.length > 512) return { ok: false, reason: 'invalid_request' }
  if (typeof b.clientTurnId !== 'string' || !TURN_ID.test(b.clientTurnId)) return { ok: false, reason: 'invalid_request' }
  for (const k of ['acknowledgedRevision', 'boundTo'] as const) {
    if (b[k] !== undefined && b[k] !== null && (typeof b[k] !== 'string' || !OPAQUE.test(b[k] as string))) return { ok: false, reason: 'invalid_request' }
  }
  if (b.packetSha256 !== undefined && b.packetSha256 !== null && (typeof b.packetSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.packetSha256))) return { ok: false, reason: 'invalid_request' }
  const turn: SignHandoffTurn = { bindingId: b.bindingId, epoch: b.epoch as number, targetKey: b.targetKey, clientTurnId: b.clientTurnId }
  if (typeof b.acknowledgedRevision === 'string') turn.acknowledgedRevision = b.acknowledgedRevision
  if (typeof b.boundTo === 'string') turn.boundTo = b.boundTo
  return { ok: true, request: { words: b.prompt, turn, packetSha256: typeof b.packetSha256 === 'string' ? b.packetSha256 : null } }
}

interface OpenHandoff { view: SignHandoffView; claimed: boolean }

export type HandoffClaim = { ok: true; handoff: SignHandoffView } | { ok: false; reason: 'handoff_unknown' | 'handoff_expired' | 'handoff_claimed' }

export class WebKeySignHandoffs {
  private readonly open = new Map<string, OpenHandoff>()

  constructor(private readonly now: () => number = Date.now, private readonly random: (n: number) => Buffer = randomBytes) {}

  private prune(at: number): void {
    // Expired ones stay a little past their life so a late claim reads `handoff_expired`, not unknown.
    for (const [id, h] of this.open) if (at > h.view.exp + WEB_KEY_HANDOFF_TTL_MS) this.open.delete(id)
  }

  /** Keep one handoff for the resolved destination. The scope is checked here as the envelope parser checks it. */
  create(request: SignHandoffRequest, target: { provider: string; sessionId: string }, scope: WebTurnScope = { kind: 'message' }, packet: WebApprovalPacket | null = null): { ok: true; handoffId: string; exp: number } | { ok: false; reason: 'handoff_cap_reached' | 'scope_not_allowed' | 'packet_mismatch' } {
    const at = this.now()
    this.prune(at)
    if (parseWebTurnScope(scope) === null) return { ok: false, reason: 'scope_not_allowed' }
    if (scope.kind === 'approve') {
      const parsed = parseWebApprovalPacket(packet), encoded = parsed && canonicalBytes(parsed)
      if (!parsed || !encoded || sha256Hex(encoded) !== scope.packetSha256 || at > parsed.exp || at < parsed.createdAt
        || parsed.provider !== target.provider || parsed.sessionId !== target.sessionId
        || ['action', 'artifact', 'version', 'digest', 'channel'].some(k => parsed[k as keyof WebApprovalPacket] !== scope[k as keyof typeof scope])) return { ok: false, reason: 'packet_mismatch' }
      packet = { ...parsed }
    } else if (packet !== null) return { ok: false, reason: 'packet_mismatch' }
    let live = 0
    for (const h of this.open.values()) if (!h.claimed && at <= h.view.exp) live += 1
    if (live >= WEB_KEY_HANDOFF_MAX_OPEN) return { ok: false, reason: 'handoff_cap_reached' }
    const handoffId = this.random(18).toString('base64url')
    const exp = at + WEB_KEY_HANDOFF_TTL_MS
    this.open.set(handoffId, {
      claimed: false,
      view: {
        handoffId, exp, words: request.words, provider: target.provider, sessionId: target.sessionId,
        bindingId: request.turn.bindingId, turn: { ...request.turn }, scope: { ...scope }, packet, attachments: [],
      },
    })
    return { ok: true, handoffId, exp }
  }

  /** Once only, and only before it expires. */
  claim(id: unknown): HandoffClaim {
    const at = this.now()
    this.prune(at)
    const h = typeof id === 'string' ? this.open.get(id) : undefined
    if (!h) return { ok: false, reason: 'handoff_unknown' }
    if (at > h.view.exp) return { ok: false, reason: 'handoff_expired' }
    if (h.claimed) return { ok: false, reason: 'handoff_claimed' }
    h.claimed = true
    return { ok: true, handoff: { ...h.view, turn: { ...h.view.turn }, scope: { ...h.view.scope }, packet: h.view.packet ? { ...h.view.packet } : null } }
  }
}
