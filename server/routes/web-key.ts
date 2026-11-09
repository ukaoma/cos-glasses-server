// /api/web-key/*: the enrolled phone key registry and enrollment ceremony (6.99.31, plan §4.3,
// §4.7). Behind COS_WEB_KEY_AUTHORITY (default off). Off, none of these is a route (each falls
// through to next(), exactly as on 6.99.29).
//
// WHO MAY CALL WHAT:
//   - The phone's steps (enroll start, prove, status, nonce) need the WEB path: the signed cookie,
//     no X-Cos-Token header, and a socket that is not this Mac (the same judgment as a web turn).
//     A token-bearing, loopback or own-address request is refused: an agent on this Mac cannot
//     start an enrollment for a key it made.
//   - COS Control's steps (pending, approve) need X-Cos-Token, and approve ALSO needs the anchor's
//     Secure Enclave signature over the frozen approval (Touch ID). The token alone approves nothing.
//   - Revoke, revoke-all and the key list take either the token or the web path. Revocation never
//     needs the anchor, so a lost phone can always be revoked (by a token holder too: denial of
//     service only, logged in web-key-audit.jsonl).
//   - Anchor registration (review B1) is COS Control's bootstrap: loopback socket only, no proxy
//     headers, X-Cos-Token, and the anchor's own signature over its `cos-web-anchor/1` statement. A
//     new anchor vouches nothing for 24 hours; the turn answer exposes its fingerprint and age so
//     the verifier compares it with Miles's committed pin.
//   - Approval packets name their creating session from the request context (`x-cos-provider`,
//     `x-cos-session-id`), never from body text (review B4).
//   - Phase 3: the phone's key steps (enroll start and prove, nonce) answer only on the 3144 signer
//     listener when `isSignerRequest` is wired (index.ts), so a page on 3143 cannot make a key.
//   - Phase 3 handoff: the composer creates one on the web path (the destination comes from the
//     binding, never the body); only the signer page claims it, once, on 3144, naming its origin.
//   - 7.0.9 anchor bootstrap (COS_WEB_KEY_ANCHOR_BOOTSTRAP on, COS_WEB_KEY_AUTHORITY off): ONLY
//     GET status (X-Cos-Token only, reply `enabled: false, mode: 'bootstrap'`) and POST anchor (as
//     above) answer. Every other route falls through exactly as with both switches off.

import { Router, type Request, type Response, type NextFunction } from 'express'
import { timingSafeTokenEqual } from '../lib/token-auth.js'
import { hasProxyForwardedHeaders, isLoopbackAddress, normalizeRemoteIp } from '../lib/network-policy.js'
import { WEB_KEY_ENABLED_APPROVE_ACTIONS, type WebKeyAuthority } from '../lib/web-key-authority.js'
import { WEB_ANCHOR_MATURITY_MS, type WebKeyEnrollments } from '../lib/web-key-registry.js'
import { parseHandoffRequest, type WebKeySignHandoffs } from '../lib/web-key-handoff.js'
import type { WebApprovalPacket, WebTurnScope } from '../../shared/web-turn-envelope.js'

export const ANCHOR_REGISTRATION_LOOPBACK_COPY = 'The COS Control anchor key can only be registered by COS Control on this Mac.'

export interface WebKeyRouterDeps {
  authority: WebKeyAuthority
  enrollments: WebKeyEnrollments
  /** The web path in full: cookie, no token, a socket that is not this Mac (G2TurnProvenance.originOf). */
  isWebRequest: (req: Request) => boolean
  apiToken: () => string
  selfDnsName: () => string | null
  expectedOrigin: () => string | null
  /** Served-asset integrity (Phase 6) for Control's audit; absent: not reported. */
  integrityStatus?: () => Record<string, unknown>
  /**
   * Phase 3: whether this request reached the 3144 signer listener (index.ts: the socket's local
   * port). Given, the phone's key steps (enroll start and prove, nonce) and the handoff claim answer
   * only there, so a page on 3143 can neither make a key nor fetch a handoff. Absent (tests that
   * predate the signer): not checked, exactly as before.
   */
  isSignerRequest?: (req: Request) => boolean
  /** Phase 3: the 3143 to 3144 handoff store. Absent: the handoff routes answer 404 `handoff_unavailable`. */
  handoffs?: WebKeySignHandoffs
  /** Phase 3: the binding's real destination, as the turn route will resolve it. Null: no such binding. */
  resolveBinding?: (bindingId: string) => { provider: string; sessionId: string; epoch: number; targetKey: string } | null
}

export const SIGNER_ORIGIN_REQUIRED = 'signer_origin_required'

export function createWebKeyRouter(deps: WebKeyRouterDeps): Router {
  const router = Router()

  const on = (req: Request, res: Response, next: NextFunction): void => {
    if (!deps.authority.enabled()) { next('router'); return }
    res.set('Cache-Control', 'private, no-store')
    next()
  }
  const hasToken = (req: Request): boolean => {
    let expected = ''
    try { expected = deps.apiToken() } catch { expected = '' }
    return expected.length > 0 && timingSafeTokenEqual(req.headers['x-cos-token'], expected)
  }
  const web = (req: Request): boolean => {
    try { return deps.isWebRequest(req) === true } catch { return false }
  }
  const refuse = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}): void => {
    res.status(status).json({ ok: false, error, ...extra })
  }
  const by = (req: Request): string => (hasToken(req) ? 'token' : 'web')
  const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {})
  /** On the 3144 listener, when the deployment can tell (Phase 3). Never throws. */
  const onSigner = (req: Request): boolean => {
    if (!deps.isSignerRequest) return true
    try { return deps.isSignerRequest(req) === true } catch { return false }
  }

  // 7.0.9: status and anchor registration answer in either mode; with both switches off they fall
  // through like every other route. They sit BEFORE `on`, which still gates everything else on the
  // authority alone.
  const anchorRoutes = (req: Request, res: Response, next: NextFunction): void => {
    if (deps.authority.mode() === 'off') { next('router'); return }
    res.set('Cache-Control', 'private, no-store')
    next()
  }

  router.get('/web-key/status', anchorRoutes, (req, res) => {
    const registry = deps.authority.registry
    const selfDns = deps.selfDnsName()
    if (deps.authority.mode() !== 'authority') {
      // Bootstrap only: COS Control's anchor state, nothing that suggests approvals. Token only:
      // no web page needs it while no phone can enroll. `enabled: false` keeps older Controls hidden.
      if (!hasToken(req)) return refuse(res, 401, 'unauthorized')
      const anchor = registry.anchor()
      return void res.json({
        ok: true,
        enabled: false,
        mode: 'bootstrap',
        anchorRegistered: anchor !== null,
        anchorMature: registry.anchorMature(),
        anchorSetAt: anchor ? anchor.setAt : null,
        aud: registry.aud(selfDns),
        origin: deps.expectedOrigin(),
        epoch: registry.epoch(),
      })
    }
    if (!hasToken(req) && !web(req)) return refuse(res, 401, 'unauthorized')
    res.json({
      ok: true,
      enabled: true,
      anchorRegistered: registry.anchor() !== null,
      anchorRefusal: registry.anchorRefusal(),
      anchorMature: registry.anchorMature(),
      registryReadable: !registry.unreadable,
      nonceStoreReadable: !deps.authority.nonces.unavailable,
      aud: registry.aud(selfDns),
      origin: deps.expectedOrigin(),
      epoch: registry.epoch(),
      activeKeys: registry.activeCount(selfDns),
      ...(deps.integrityStatus ? { integrity: deps.integrityStatus() } : {}),
    })
  })

  router.post('/web-key/anchor', anchorRoutes, (req, res) => {
    // Loopback socket, no forwarding headers (a local proxy makes every caller loopback), and the token.
    const addr = normalizeRemoteIp(req.socket?.remoteAddress ?? '')
    if (!addr || !isLoopbackAddress(addr) || hasProxyForwardedHeaders(req.headers)) return refuse(res, 403, 'loopback_required', { reasonCopy: ANCHOR_REGISTRATION_LOOPBACK_COPY })
    if (!hasToken(req)) return refuse(res, 401, 'token_required')
    const b = body(req)
    const result = deps.authority.registry.registerAnchor({ anchorPub: b.anchorPub, statement: b.statement, signature: b.signature }, 'control')
    if (!result.ok) return refuse(res, result.reason === 'registry_write_failed' || result.reason === 'registry_unreadable' ? 503 : result.reason === 'anchor_signature_invalid' ? 403 : 400, result.reason)
    res.status(201).json({ ...result, maturesAt: result.setAt + WEB_ANCHOR_MATURITY_MS })
  })

  // Everything below: the authority only (bootstrap mode falls through here, as with both off).
  router.use('/web-key', on)

  router.post('/web-key/enroll/start', (req, res) => {
    if (!web(req)) return refuse(res, 403, 'web_origin_required')
    if (!onSigner(req)) return refuse(res, 403, SIGNER_ORIGIN_REQUIRED)
    const b = body(req)
    const result = deps.enrollments.start({
      spki: b.spki,
      label: b.label,
      rotates: b.rotates,
      sasCommit: b.sasCommit,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '',
      remote: req.socket?.remoteAddress ?? 'unknown',
    }, { selfDnsName: deps.selfDnsName(), origin: deps.expectedOrigin() })
    if (!result.ok) return refuse(res, result.reason === 'device_not_allowed' ? 403 : result.reason === 'enrollment_pending' || result.reason === 'key_cap_reached' || result.reason === 'key_already_enrolled' ? 409 : 400, result.reason)
    res.status(201).json(result)
  })

  router.post('/web-key/enroll/prove', (req, res) => {
    if (!web(req)) return refuse(res, 403, 'web_origin_required')
    if (!onSigner(req)) return refuse(res, 403, SIGNER_ORIGIN_REQUIRED)
    const b = body(req)
    const result = deps.enrollments.prove({ enrollId: b.enrollId, signature: b.signature, phoneNonce: b.phoneNonce, passkey: b.passkey })
    if (!result.ok) return refuse(res, result.reason === 'enroll_unknown' ? 404 : 400, result.reason)
    res.json(result)
  })

  router.get('/web-key/enroll/status', (req, res) => {
    if (!web(req) && !hasToken(req)) return refuse(res, 401, 'unauthorized')
    res.json({ ok: true, status: deps.enrollments.status(req.query.enrollId) })
  })

  router.get('/web-key/enroll/pending', (req, res) => {
    if (!hasToken(req)) return refuse(res, 401, 'token_required')
    res.json({ ok: true, pending: deps.enrollments.pendingView() })
  })

  router.post('/web-key/enroll/approve', (req, res) => {
    if (!hasToken(req)) return refuse(res, 401, 'token_required')
    const b = body(req)
    const result = deps.enrollments.approve(b.enrollId, b.anchorSig, deps.selfDnsName())
    if (!result.ok) return refuse(res, result.reason === 'enroll_unknown' ? 404 : result.reason === 'anchor_signature_invalid' ? 403 : 409, result.reason)
    res.json(result)
  })

  router.get('/web-key/keys', (req, res) => {
    if (!hasToken(req) && !web(req)) return refuse(res, 401, 'unauthorized')
    res.json({ ok: true, epoch: deps.authority.registry.epoch(), keys: deps.authority.registry.list(deps.selfDnsName()) })
  })

  router.post('/web-key/revoke', (req, res) => {
    if (!hasToken(req) && !web(req)) return refuse(res, 401, 'unauthorized')
    const b = body(req)
    if (typeof b.kid !== 'string') return refuse(res, 400, 'invalid_request')
    const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim() : 'revoked'
    if (!deps.authority.registry.revoke(b.kid, reason, by(req))) return refuse(res, 404, 'key_unknown')
    res.json({ ok: true, kid: b.kid, revoked: true })
  })

  router.post('/web-key/revoke-all', (req, res) => {
    if (!hasToken(req) && !web(req)) return refuse(res, 401, 'unauthorized')
    res.json({ ok: true, epoch: deps.authority.registry.revokeAll(by(req)) })
  })

  router.post('/web-key/nonce', (req, res) => {
    if (!web(req)) return refuse(res, 403, 'web_origin_required')
    if (!onSigner(req)) return refuse(res, 403, SIGNER_ORIGIN_REQUIRED)
    const issued = deps.authority.nonces.issue()
    if (!issued.ok) return refuse(res, 503, issued.reason)
    res.status(201).json({ ok: true, nonce: issued.nonce, exp: issued.exp, aud: deps.authority.registry.aud(deps.selfDnsName()), epoch: deps.authority.registry.epoch() })
  })

  router.post('/web-key/packets', (req, res) => {
    // A packet is only a request (a receiving session asks Miles to approve one exact action).
    if (!hasToken(req)) return refuse(res, 401, 'token_required')
    // The creating session comes from the request context, never the body (review B4).
    const header = (name: string): string | null => { const v = req.headers[name]; return typeof v === 'string' && v.trim() ? v.trim() : null }
    const created = deps.authority.packets.create(body(req), { provider: header('x-cos-provider'), sessionId: header('x-cos-session-id') })
    if (!created.ok) return refuse(res, created.reason === 'packet_cap_reached' ? 409 : created.reason === 'creator_unknown' ? 401 : 400, created.reason)
    res.status(201).json({ ok: true, packet: created.packet, packetSha256: created.packetSha256 })
  })

  router.get('/web-key/packets', (req, res) => {
    if (!hasToken(req) && !web(req)) return refuse(res, 401, 'unauthorized')
    const provider = req.query.provider, sessionId = req.query.sessionId
    if ((provider !== undefined || sessionId !== undefined) && (typeof provider !== 'string' || !['claude', 'codex', 'cursor'].includes(provider) || typeof sessionId !== 'string' || !sessionId || sessionId.length > 128)) return refuse(res, 400, 'invalid_target')
    const packets = deps.authority.packets.list().filter(row => WEB_KEY_ENABLED_APPROVE_ACTIONS.has(row.packet.action)
      && (provider === undefined || (row.packet.provider === provider && row.packet.sessionId === sessionId)))
    res.json({ ok: true, packets })
  })

  // ── Phase 3: the handoff from the Control Web composer (3143) to the signer page (3144) ──
  // Create: the composer, on the web path. The destination is the binding's, never the body's.
  router.post('/web-key/handoff', (req, res) => {
    if (!web(req)) return refuse(res, 403, 'web_origin_required')
    if (!deps.handoffs || !deps.resolveBinding) return refuse(res, 404, 'handoff_unavailable')
    const signerOrigin = deps.expectedOrigin()
    if (!signerOrigin) return refuse(res, 503, 'origin_unavailable')
    if (deps.authority.registry.activeCount(deps.selfDnsName()) < 1) return refuse(res, 409, 'no_phone_key')
    const parsed = parseHandoffRequest(req.body)
    if (!parsed.ok) return refuse(res, 400, parsed.reason)
    const { request } = parsed
    let target: ReturnType<NonNullable<WebKeyRouterDeps['resolveBinding']>> = null
    try { target = deps.resolveBinding(request.turn.bindingId) } catch { target = null }
    if (!target) return refuse(res, 404, 'unknown_binding')
    if (target.epoch !== request.turn.epoch || target.targetKey !== request.turn.targetKey) return refuse(res, 409, 'binding_changed')
    let scope: WebTurnScope = { kind: 'message' }
    let approvalPacket: WebApprovalPacket | null = null
    if (request.packetSha256) {
      const packet = deps.authority.packets.get(request.packetSha256)
      if (!packet) return refuse(res, 404, 'packet_unknown')
      if (!WEB_KEY_ENABLED_APPROVE_ACTIONS.has(packet.action)) return refuse(res, 400, 'approve_action_not_enabled')
      // A packet is signable only for the session that asked for it (review B4).
      if (packet.provider !== target.provider || packet.sessionId !== target.sessionId) return refuse(res, 409, 'packet_session_mismatch')
      scope = { kind: 'approve', action: packet.action, artifact: packet.artifact, version: packet.version, digest: packet.digest, channel: packet.channel, packetSha256: request.packetSha256 }
      approvalPacket = packet
    }
    const created = deps.handoffs.create(request, { provider: target.provider, sessionId: target.sessionId }, scope, approvalPacket)
    if (!created.ok) return refuse(res, created.reason === 'handoff_cap_reached' ? 409 : 400, created.reason)
    // The id rides in the fragment: never sent to a server, never in a Referer. The words are not in it.
    res.status(201).json({ ok: true, handoffId: created.handoffId, exp: created.exp, signerUrl: `${signerOrigin}/#h=${created.handoffId}` })
  })

  // Claim: the signer page, once, on its own listener and naming its own origin.
  router.post('/web-key/handoff/claim', (req, res) => {
    if (!web(req)) return refuse(res, 403, 'web_origin_required')
    if (!deps.handoffs) return refuse(res, 404, 'handoff_unavailable')
    const signerOrigin = deps.expectedOrigin()
    if (!deps.isSignerRequest || !onSigner(req) || !signerOrigin || req.headers.origin !== signerOrigin) return refuse(res, 403, SIGNER_ORIGIN_REQUIRED)
    const claimed = deps.handoffs.claim(body(req).handoffId)
    if (!claimed.ok) return refuse(res, claimed.reason === 'handoff_unknown' ? 404 : claimed.reason === 'handoff_expired' ? 410 : 409, claimed.reason)
    res.json({ ok: true, handoff: claimed.handoff })
  })

  return router
}
