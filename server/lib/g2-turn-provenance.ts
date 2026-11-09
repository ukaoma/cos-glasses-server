// G2 authority, Tier 1 (ported to 6.99.29 from the unmerged 6.66 design, a3c8c4b): verifiable
// provenance for the turns this server delivers into an agent session on behalf of the glasses or
// the phone. Turns from a signed-in COS Control Web browser are recorded too (6.99.29), never vouched.
//
// WHY. A turn Miles dictates on the G2 should carry his authority in the Claude, Codex or Cursor
// session it lands in, and a turn some other local process sends must not. Both arrive through
// the same routes with the same X-Cos-Token: the token sits in ~/.cos-glasses/.env, and every
// COS agent session on this Mac can read it. So "an authenticated call made this" proves
// nothing about who spoke.
//
// WHAT COUNTS AS PROOF, and nothing more is claimed:
//   1. The request's SOCKET address (never X-Forwarded-For, never req.ip) is not loopback and
//      is not one of this Mac's own interface addresses (LAN, Tailscale 100.x, utun, anything
//      os.networkInterfaces() lists). A process on this Mac can only reach the server from one
//      of those, so this rules out every local caller. Also local: link-local addresses, and any
//      address inside the subnet of a VM or container bridge this Mac hosts (bridge100 and kin),
//      because a container dialing the bridge arrives from an address no interface lists.
//   2. The request names, in X-Cos-Client-Instance, the COS app copy that currently holds the
//      ring for that same device address (the client-instance referee, 6.50.3), seen within
//      PAIRED_INSTANCE_FRESH_MS.
// verifiedOrigin = (1) && (2). `client` (glasses / phone) is the app's own word in X-Cos-Client
// and labels the turn; it never makes a turn verified.
//
// WEB ORIGIN (6.99.29): RECORDED, NEVER VOUCHED. Miles types into a session's box on COS Control Web
// from his phone. The browser sends no X-Cos-Token header; it sends the HttpOnly `cos_web_session`
// cookie. That cookie is NOT a secret the token cannot produce: its signature is an HMAC keyed by
// the API token itself (web-session-auth.ts, `cos_web_session_v2:<token>`), the epoch sits in
// web-session.json, and the pairing token also signs a browser in. So any holder of X-Cos-Token
// (every agent on this Mac) can mint a valid cookie and send from another tailnet node with no
// token header. A web turn is therefore ledgered with originKind 'web', verifiedOrigin false and
// reason 'web_cookie_derivable_from_token', gets NO footer, and the endpoint never vouches for it.
// Real web authority needs a key the token cannot derive (a device key or passkey enrolled out of
// band); until that exists there is no vouched web origin. `webSession` is still checked in full
// (cookie signature, expiry, epoch, X-COS-Web and an Origin naming this server, no X-Cos-Token
// header, a socket that is not this Mac) so the ledger labels the turn honestly.
//
// WHAT IS NOT PROVEN. Another device on the tailnet or the LAN that holds the token and has read
// the live instance id (the app logs it in client diagnostics on this Mac) could pass both
// tests. So could a VM this Mac runs in BRIDGED mode (it takes its own LAN address from the
// router, indistinguishable from a second machine). Both are outside this tier's threat model.
//
// THE LEDGER is append-only JSONL at <data>/g2-turn-ledger.jsonl, rotated at 5 MB. It is an audit
// trail. The file is NOT the proof: any local process can write it. The endpoint answers
// `verifiedOrigin: true` only for a record THIS process wrote and still holds in memory
// (`sealed`). A record read back from disk (after a restart, or one somebody appended by hand)
// is reported, never vouched for. A restart therefore makes recent turns unverifiable, which
// fails closed.
//
// QUEUED TURNS re-enter the turn route over loopback (thread-turn-queue-deliver.ts), so their
// socket origin at delivery is always local. The origin is captured at enqueue (and again at an
// edit), kept in memory with the hash of the text it vouches for, and carried across the
// loopback hop by a single-use random token only this process knows. A queue file edited on
// disk no longer matches the hash and drains as local. A queued origin is forgotten the moment
// its row settles (delivered, steered, cancelled, refused, expired) and lapses QUEUED_ORIGIN_TTL_MS
// after it was judged, so a turn that waits longer drains unvouched. Every drain carries a token,
// even one with no origin left to carry, so the drain is the one caller allowed to add to the
// parked turn's ledger record.
//
// WEB-KEY AUTHORITY (6.99.31, behind COS_WEB_KEY_AUTHORITY, default off). A web turn that also
// carries a `cos-web-turn/1` envelope signed by an enrolled phone key (lib/web-key-authority.ts)
// can be vouched as `authority: 'web-key'`. originOf only NOTES the envelope headers on a web
// verdict (`webKeyCandidate`); nothing is vouched until the route, knowing its real target, the
// exact words and the files, calls acceptWebKey. A route that never calls it leaves the web turn
// exactly as 6.99.29 left it. Off, no candidate is ever noted, so every web turn is recorded with
// WEB_UNVOUCHED_REASON and no footer, byte for byte as 6.99.29. A web-key record is self-proving
// (envelope + signature), so the endpoint can vouch for it after a restart, unlike the in-memory
// seal; a queued web-key origin is re-checked at its drain (expiry, revocation, epoch, words).
//
// TURN IDS ARE NOT REUSABLE. A record this process holds is never replaced by a different turn
// under the same id (a client-chosen id could otherwise overwrite a vouched record: a denial of
// service on verification). Only an identical retry (same target, same text, same origin) or the
// server's own continuation of a parked turn (drain carry, queue edit, Cursor Stop hand-off) may
// add to it; the routes refuse anything else before delivery.

import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { turnFooter } from './turn-footer.js'
import { webKeyCandidateOf, type WebKeyAuthority, type WebKeyCandidate, type WebKeyContext, type WebKeyProof } from './web-key-authority.js'
import { MESSAGE_SCOPE_MEANING, notAuthorizedFor } from '../../shared/web-turn-envelope.js'

export { FOOTER_LINE_REFUSED_COPY, G2_TURN_FOOTER_RE, g2TurnFooter, hasFooterShapedLine, stripG2TurnFooter, TURN_FOOTER_SHAPED_RE, TURN_ID_IN_USE_COPY, turnFooter, turnFooterTag, withoutTurnFooter } from './turn-footer.js'

export const G2_TURN_LEDGER_FILE = 'g2-turn-ledger.jsonl'
export const G2_TURN_LEDGER_ROTATE_BYTES = 5 * 1024 * 1024
/** Records held in memory (sealed). A turn is verified within minutes, so this is generous. */
export const G2_TURN_MEMORY_MAX = 2048
/** The strict id shape: covers the client turn id, the client fork id and the ids minted here. */
export const G2_TURN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/
export const CLIENT_INSTANCE_HEADER = 'x-cos-client-instance'
export const CLIENT_SURFACE_HEADER = 'x-cos-client'
export const TURN_CARRY_HEADER = 'x-cos-turn-carry'
/** The pairing-token header the /api gate reads. Its presence alone rules out a web turn. */
export const TOKEN_HEADER = 'x-cos-token'
/** How recently the ring's owner must have claimed for its id to vouch for a turn (the reclaim window). */
export const PAIRED_INSTANCE_FRESH_MS = 10 * 60_000
/** A carry token lives this long: the loopback hop answers in well under a second. */
export const TURN_CARRY_TTL_MS = 30_000
/** Queued origins held at once (a queue holds 8 per thread). */
export const QUEUED_ORIGIN_MAX = 512
/** A queued origin lapses this long after it was judged: a turn that waits longer drains unvouched. */
export const QUEUED_ORIGIN_TTL_MS = 30 * 60_000
/**
 * The endpoint vouches for a sealed record only this long after its origin was judged (never from
 * a later delivery). The verifier's own
 * window is 15 minutes; this bounds how long any record can ever vouch, so the verifier's
 * consumed-turn store (kept 7 days) always outlives it.
 */
export const G2_TURN_VOUCH_MAX_MS = 24 * 3_600_000
/** Why a Send again copy is not vouched: the request that sent it again was not itself a verified origin. */
export const RESEND_NOT_REVERIFIED_REASON = 'resend_not_reverified'
/** Why a web turn is never vouched in 6.99.29 (see the header). */
export const WEB_UNVOUCHED_REASON = 'web_cookie_derivable_from_token'
const OWN_ADDRESS_CACHE_MS = 30_000

export type TurnClient = 'glasses' | 'phone' | 'web' | 'local' | 'unknown'

/** Where a footed turn came from, as the ledger, the endpoint and the verifier name it. */
export type TurnOriginKind = 'g2' | 'phone' | 'web'

export interface TurnOrigin {
  remote: string
  loopback: boolean
  ownAddress: boolean
  clientInstance: string | null
  client: TurnClient
  /** 6.99.29: the request presented an X-Cos-Token header (any value). Never a web turn. */
  tokenPresented?: boolean
  /** 6.99.29: the signed-in COS Control Web cookie path passed, with no token presented. */
  webSession?: boolean
}

/** The origin kind a client label stands for; null for a local or unknown caller (never footed). */
export function originKindOf(client: TurnClient | string | undefined): TurnOriginKind | null {
  if (client === 'glasses') return 'g2'
  if (client === 'phone') return 'phone'
  if (client === 'web') return 'web'
  return null
}

export interface OriginVerdict {
  origin: TurnOrigin
  verifiedOrigin: boolean
  /** Why it is not vouched (null or absent when it is). */
  reason?: string | null
  /** When this origin was judged (ms). A queued origin lapses from here, never later. */
  judgedAt?: number
  /** 6.99.31: set only by acceptWebKey on a signed, accepted web turn. */
  authority?: 'web-key'
  /** 6.99.31: the accepted envelope and signature (self-proving). Present only with `authority`. */
  webKey?: WebKeyProof
  /** 6.99.31: envelope headers a web request carried, not yet judged (flag on only). Vouches for nothing. */
  webKeyCandidate?: WebKeyCandidate
  /** 6.99.31: why a signed web turn was not vouched (the route's acceptWebKey or a drain re-check). */
  webKeyReason?: string
}

export interface G2TurnRecord {
  turnId: string
  createdAt: string
  textSha256: string
  origin: TurnOrigin
  /** 6.99.29: g2, phone or web; null when the turn was not footed (a local or unknown caller). */
  originKind: TurnOriginKind | null
  verifiedOrigin: boolean
  /** 6.99.29: why it is not vouched; null when it is. A web turn says WEB_UNVOUCHED_REASON. */
  reason?: string | null
  /** 6.99.29: when its origin was judged (ms): the parking request, for a drained turn. */
  originJudgedAt?: number
  target: { provider: string; sessionId: string; fork?: true }
  via: string
  /**
   * Send again: the row this copy was made from. AN ANNOTATION ONLY, never authority (Codex
   * re-audit of 910eb90): the copy is judged by the request that sent it again, nothing is inherited.
   */
  resendOf?: string
  /** 6.99.31: a vouched web turn signed by an enrolled phone key. */
  authority?: 'web-key'
  /** 6.99.31: the envelope bytes and signature that vouch for it (self-proving, so durable). */
  webKey?: WebKeyProof
}

/** The shape of an Express request this module reads. Nothing else. */
export interface OriginRequest {
  method?: string
  socket?: { remoteAddress?: string | null } | null
  headers: Record<string, string | string[] | undefined>
}

// ASCII whitespace only, spelled out, so the Python verifier normalizes identically (JS `\s` and
// Python `\s` disagree on U+FEFF, U+0085 and U+001C..U+001F).
const WS_RUN = /[\t\n\v\f\r ]+/g
const WS_EDGE = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g

/** Trim, and collapse every run of ASCII whitespace to one space. */
export function normalizeTurnText(text: string): string {
  return text.replace(WS_EDGE, '').replace(WS_RUN, ' ')
}

export function turnTextSha256(text: string): string {
  return createHash('sha256').update(normalizeTurnText(text), 'utf8').digest('hex')
}

/**
 * Whether a turn of this origin gets the footer: ONLY a vouched glasses or phone turn (QA 6.99.29
 * 5b: it used to read the label, so an unverified glasses turn and every web turn were footed). A
 * web turn is never footed, whatever its verdict says.
 */
export function footerApplies(verdict: OriginVerdict): boolean {
  if (verdict.verifiedOrigin !== true) return false
  const kind = originKindOf(verdict.origin.client)
  // 6.99.31: a web turn is footed (COS-WEB) only when an enrolled phone key's envelope was accepted.
  if (kind === 'web') return verdict.authority === 'web-key' && verdict.webKey !== undefined
  return kind === 'g2' || kind === 'phone'
}

/** Whether a verdict is a vouched web-key turn (the only vouched web turn there is). */
function isWebKeyVerdict(verdict: OriginVerdict): boolean {
  return verdict.verifiedOrigin === true && verdict.authority === 'web-key' && verdict.webKey !== undefined
}

/**
 * The same verdict, never vouched, with the reason why. Any web-key authority is dropped; envelope
 * headers not yet judged stay, so a Send again or an edit can still be judged on its own signature.
 */
export function unvouched(verdict: OriginVerdict, reason: string): OriginVerdict {
  const { authority: _a, webKey: _w, ...rest } = verdict
  return { ...rest, verifiedOrigin: false, reason }
}

/** A signed web turn that was not vouched: unvouched, its envelope spent or dropped, the reason kept. */
function webKeyRefused(verdict: OriginVerdict, reason: string): OriginVerdict {
  const { authority: _a, webKey: _w, webKeyCandidate: _c, ...rest } = verdict
  return { ...rest, verifiedOrigin: false, reason, webKeyReason: reason }
}

/** The vias of a turn still parked in the queue: the only records a continuation may extend. */
export const PARKED_TURN_VIAS: ReadonlySet<string> = new Set(['queue', 'queue-edit', 'queue-resend'])

/** Whether a later record under the same id is the same turn: same target, same text, same origin. */
function sameTurn(a: G2TurnRecord, b: G2TurnRecord): boolean {
  return a.target.provider === b.target.provider
    && a.target.sessionId === b.target.sessionId
    && (a.target.fork === true) === (b.target.fork === true)
    && a.textSha256 === b.textSha256
    && a.originKind === b.originKind
    && a.verifiedOrigin === b.verifiedOrigin
}

/** `::ffff:100.64.1.2` and `100.64.1.2` are one address; IPv6 scope ids and case are dropped. */
export function normalizeAddress(address: string | null | undefined): string {
  let a = (address ?? '').trim().toLowerCase()
  if (a.startsWith('::ffff:') && a.includes('.')) a = a.slice(7)
  const pct = a.indexOf('%')
  if (pct >= 0) a = a.slice(0, pct)
  return a
}

export function isLoopbackAddress(address: string): boolean {
  const a = normalizeAddress(address)
  return a === '::1' || a === '0:0:0:0:0:0:0:1' || a === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
}

/**
 * Interfaces whose whole subnet is this Mac: the host side of a VM or container bridge. Measured
 * 2026-10-07: a process in the cos-qdrant container that dials the bridge100 host address
 * (192.168.64.1) arrives from 192.168.64.2, which is in no interface list. Without this rule any
 * local process could `docker exec` its way to a non-local address.
 */
export const VIRTUAL_BRIDGE_IFACE_RE = /^(bridge|vmnet|vnic|docker|veth|vboxnet|anpi)/

function ipv4ToInt(a: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some(n => n > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

/** Link-local addresses (169.254/16, fe80::/10) never come from a paired phone over a routed path. */
export function isLinkLocalAddress(address: string): boolean {
  const a = normalizeAddress(address)
  return /^169\.254\./.test(a) || /^fe[89ab][0-9a-f]:/.test(a)
}

export interface OwnAddressView {
  addresses: ReadonlySet<string>
  /** IPv4 subnets of virtual bridges, as [network, mask]. */
  bridgeSubnets: ReadonlyArray<readonly [number, number]>
}

/** This Mac's own addresses and bridge subnets. Throws through to the caller, which fails closed. */
export function readOwnAddressView(): OwnAddressView {
  const addresses = new Set<string>()
  const bridgeSubnets: Array<readonly [number, number]> = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const entry of list ?? []) {
      addresses.add(normalizeAddress(entry.address))
      if (entry.family === 'IPv4' && VIRTUAL_BRIDGE_IFACE_RE.test(name)) {
        const ip = ipv4ToInt(entry.address)
        const mask = ipv4ToInt(entry.netmask)
        if (ip !== null && mask !== null) bridgeSubnets.push([(ip & mask) >>> 0, mask])
      }
    }
  }
  return { addresses, bridgeSubnets }
}

/** Whether this normalized address is this Mac, a VM or container it hosts, or link-local. */
export function isOwnAddress(address: string, view: OwnAddressView): boolean {
  const a = normalizeAddress(address)
  if (view.addresses.has(a) || isLinkLocalAddress(a)) return true
  const ip = ipv4ToInt(a)
  return ip !== null && view.bridgeSubnets.some(([network, mask]) => ((ip & mask) >>> 0) === network)
}

function headerValue(headers: OriginRequest['headers'], name: string): string | null {
  const raw = headers[name]
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' ? v.trim() : null
}

const INSTANCE_RE = /^[a-z0-9]{1,16}-[a-z0-9]{1,8}$/

export class G2TurnLedger {
  private readonly memory = new Map<string, G2TurnRecord>()

  constructor(
    private readonly file: string,
    private readonly opts: { rotateBytes?: number; memoryMax?: number } = {},
  ) {}

  /** The record this process holds (sealed) for this id, or null. Synchronous: memory only. */
  held(turnId: string): G2TurnRecord | null {
    return this.memory.get(turnId) ?? null
  }

  /**
   * Append one record. Kept in memory (sealed) even when the disk write fails. Never throws.
   * A held id is never replaced unless the caller says this record continues it (`replace`):
   * false, and nothing written, otherwise.
   */
  append(record: G2TurnRecord, opts: { replace?: boolean } = {}): boolean {
    if (this.memory.has(record.turnId) && opts.replace !== true) {
      console.warn(`[g2-turn-ledger] refused to replace held record turnId=${record.turnId}`)
      return false
    }
    this.memory.delete(record.turnId)
    this.memory.set(record.turnId, record)
    const max = this.opts.memoryMax ?? G2_TURN_MEMORY_MAX
    while (this.memory.size > max) this.memory.delete(this.memory.keys().next().value as string)
    try {
      const rotateAt = this.opts.rotateBytes ?? G2_TURN_LEDGER_ROTATE_BYTES
      if (existsSync(this.file) && statSync(this.file).size >= rotateAt) renameSync(this.file, `${this.file}.1`)
      // One write of one line under O_APPEND: a reader never sees half a record.
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
      return true
    } catch (error) {
      console.error(`[g2-turn-ledger] append failed: ${error instanceof Error ? error.message : error}`)
      return false
    }
  }

  /** The newest record for this id. `sealed`: written by this process and held in memory. */
  async find(turnId: string): Promise<{ record: G2TurnRecord; sealed: boolean } | null> {
    const held = this.memory.get(turnId)
    if (held) return { record: held, sealed: true }
    for (const path of [this.file, `${this.file}.1`]) {
      let raw: string
      try { raw = await readFile(path, 'utf8') } catch { continue }
      const lines = raw.split('\n')
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]
        if (!line || !line.includes(turnId)) continue
        try {
          const parsed = JSON.parse(line) as G2TurnRecord
          if (parsed && parsed.turnId === turnId) return { record: parsed, sealed: false }
        } catch { /* a torn or foreign line is skipped */ }
      }
    }
    return null
  }
}

export interface G2TurnProvenanceDeps {
  ledger: G2TurnLedger
  /** The ring owner's instance id for this device address, when it claimed within `freshMs`. */
  pairedInstance: (device: string, now: number, freshMs: number) => string | null
  /** This Mac's addresses (default: os.networkInterfaces(), cached 30 s). A throw fails closed. */
  ownAddresses?: () => OwnAddressView
  /**
   * 6.99.29: whether this request passes the signed-in COS Control Web cookie path in full
   * (`isWebSessionAuthorized` with the /api gate's options, in production). Asked only for a
   * request with no X-Cos-Token header. Absent, or a throw: no turn is ever a web turn.
   */
  webSession?: (req: OriginRequest) => boolean
  /**
   * 6.99.31: the enrolled phone key authority. Absent, or its flag off: no envelope is ever read and
   * every web turn is what 6.99.29 made it.
   */
  webKey?: WebKeyAuthority
  now?: () => number
  randomToken?: () => string
}

/**
 * What a queued origin is sealed to besides the words (6.99.29, Codex audit of e4758a6): the provider
 * and thread it was parked for, and the digest of its attachment manifest (each file id with the hash
 * of its content; '' for none). The drain recomputes it and a vouched turn whose seal changed is refused.
 */
export interface QueueSeal { provider: string; threadId: string; attachments: string }

/** The digest of an attachment manifest ('' for no files): ids in order, each with its content hash. */
export function attachmentsDigest(manifest: ReadonlyArray<{ id: string; sha256: string }>): string {
  if (manifest.length === 0) return ''
  return createHash('sha256').update(JSON.stringify(manifest.map(e => [e.id, e.sha256])), 'utf8').digest('hex')
}

/** Whether a seal names exactly this provider, thread and attachment digest. */
export function sealMatches(seal: QueueSeal, actual: QueueSeal): boolean {
  return seal.provider === actual.provider && seal.threadId === actual.threadId && seal.attachments === actual.attachments
}

/** The refusal copy for a vouched queued turn whose seal no longer matches at its drain. */
export const QUEUED_TURN_TAMPERED_COPY = 'This queued message changed after it was queued (its words, files or session no longer match), so it was not sent. Send it again from where you typed it.'

interface QueuedOrigin { verdict: OriginVerdict; textSha256: string; judgedAt: number; attachments: string }
interface Carry { clientTurnId: string; verdict: OriginVerdict | null; seal: QueueSeal | null; textSha256: string; expiresAt: number }

/** What a route asks before it delivers a client-chosen id: the turn it is about to record. */
export interface TurnCandidate { prompt: string; verdict: OriginVerdict; provider: string; sessionId: string; fork?: boolean }

export class G2TurnProvenance {
  private readonly now: () => number
  private readonly queued = new Map<string, QueuedOrigin>()
  private readonly carries = new Map<string, Carry>()
  private ownCache: { at: number; view: OwnAddressView } | null = null

  constructor(private readonly deps: G2TurnProvenanceDeps) {
    this.now = deps.now ?? Date.now
  }

  get ledger(): G2TurnLedger { return this.deps.ledger }

  /** Null when this Mac's addresses cannot be read: the caller then treats every address as its own. */
  private own(): OwnAddressView | null {
    const at = this.now()
    if (this.ownCache && at - this.ownCache.at < OWN_ADDRESS_CACHE_MS) return this.ownCache.view
    try {
      const view = (this.deps.ownAddresses ?? readOwnAddressView)()
      this.ownCache = { at, view }
      return view
    } catch {
      this.ownCache = null
      return null
    }
  }

  /** What this request can prove about where it came from. Never throws. */
  originOf(req: OriginRequest): OriginVerdict {
    const rawRemote = req.socket?.remoteAddress ?? null
    const remote = rawRemote ? normalizeAddress(rawRemote) : ''
    const known = remote.length > 0
    const loopback = known && isLoopbackAddress(remote)
    const own = this.own()
    // Fails closed: an unreadable interface list means every address may be this Mac's.
    const ownAddress = known && (own === null || isOwnAddress(remote, own))
    const instanceRaw = headerValue(req.headers, CLIENT_INSTANCE_HEADER)
    const clientInstance = instanceRaw && INSTANCE_RE.test(instanceRaw) ? instanceRaw : null
    const said = headerValue(req.headers, CLIENT_SURFACE_HEADER)
    // 6.99.29: any X-Cos-Token header at all, valid or not, rules the web path out. The token is
    // what agents on this Mac hold; a request that shows it is never Miles's browser.
    const tokenRaw = req.headers[TOKEN_HEADER]
    const tokenPresented = Array.isArray(tokenRaw) ? tokenRaw.length > 0 : typeof tokenRaw === 'string' && tokenRaw.length > 0
    let webSession = false
    if (!tokenPresented && this.deps.webSession) {
      try { webSession = this.deps.webSession(req) === true } catch { webSession = false }
    }
    const local = loopback || ownAddress
    const client: TurnClient = local ? 'local' : !known ? 'unknown' : webSession ? 'web' : said === 'glasses' || said === 'phone' ? said : 'unknown'
    let verifiedOrigin = false
    let reason: string | null = null
    if (!known) reason = 'unknown_socket'
    else if (local) reason = 'local_socket'
    else if (webSession) {
      // The cookie path passed, no token was shown, and the socket is not this Mac. RECORDED, never
      // vouched: the cookie is an HMAC of the API token, so any token holder can mint one (header).
      reason = WEB_UNVOUCHED_REASON
    } else if (clientInstance === null) reason = 'no_client_instance'
    else {
      let paired: string | null = null
      try { paired = this.deps.pairedInstance(remote, this.now(), PAIRED_INSTANCE_FRESH_MS) } catch { paired = null }
      verifiedOrigin = paired !== null && paired === clientInstance
      if (!verifiedOrigin) reason = 'not_ring_owner'
    }
    // 6.99.31: a web request (cookie path, no token, not this Mac) that carries an envelope has it
    // NOTED, not judged: acceptWebKey judges it once the route knows the target. Flag off: never noted.
    let webKeyCandidate: WebKeyCandidate | null = null
    if (client === 'web' && this.webKeyOn()) {
      try { webKeyCandidate = webKeyCandidateOf(req.headers) } catch { webKeyCandidate = null }
    }
    return {
      origin: { remote: known ? remote : 'unknown', loopback, ownAddress, clientInstance, client, tokenPresented, webSession },
      verifiedOrigin,
      reason,
      judgedAt: this.now(),
      ...(webKeyCandidate ? { webKeyCandidate } : {}),
    }
  }

  private webKeyOn(): boolean {
    try { return this.deps.webKey?.enabled() === true } catch { return false }
  }

  /** The web-key authority, when wired (the routes and GET /api/g2-turns read it). */
  get webKey(): WebKeyAuthority | null { return this.deps.webKey ?? null }

  /**
   * 6.99.31: judge the envelope a web verdict carries against the route's REAL target, the exact
   * words and the ordered files. Accepted: vouched, `authority: 'web-key'`, footed COS-WEB. Refused:
   * unvouched with the specific reason. A verdict with no envelope comes back unchanged, so every
   * caller can pass every verdict. Never throws.
   */
  acceptWebKey(verdict: OriginVerdict, ctx: WebKeyContext): OriginVerdict {
    const candidate = verdict.webKeyCandidate
    if (!candidate) return verdict
    // A fork's receiving child has no id the phone could have signed: never vouched (plan §4.4).
    if (ctx.fork === true) return webKeyRefused(verdict, 'fork_destination_unbound')
    if (verdict.origin.client !== 'web' || !this.deps.webKey) return webKeyRefused(verdict, 'web_key_authority_off')
    const judged = this.deps.webKey.accept(candidate, ctx)
    if (!judged.ok) {
      console.warn(`[g2-turn-ledger] web-key turn not vouched turnId=${ctx.turnId} reason=${judged.reason}`)
      return webKeyRefused(verdict, judged.reason)
    }
    const { webKeyCandidate: _c, webKeyReason: _r, ...rest } = verdict
    return { ...rest, verifiedOrigin: true, reason: null, authority: 'web-key', webKey: judged.proof }
  }

  /** A held web-key origin still holds at its drain only while recheck passes (plan §4.5). */
  private reheld(verdict: OriginVerdict, prompt: string, attachments: string): OriginVerdict {
    if (verdict.authority !== 'web-key' || !verdict.webKey) return verdict
    const reason = this.deps.webKey ? this.deps.webKey.recheck(verdict.webKey, prompt, attachments) : 'web_key_authority_off'
    return reason === null ? verdict : webKeyRefused(verdict, reason)
  }

  /**
   * The text to deliver: with the footer for a vouched glasses or phone turn, otherwise unchanged.
   * `provider` is the harness the text is delivered into (claude, codex or cursor), named in the
   * footer's verify command; every caller knows it at this point (Codex re-audit of 910eb90).
   */
  footed(prompt: string, turnId: string, verdict: OriginVerdict, provider: string): string {
    if (!footerApplies(verdict) || !G2_TURN_ID_RE.test(turnId)) return prompt
    return `${prompt.replace(/[\t\n\v\f\r ]+$/, '')}\n${turnFooter(turnId, verdict.origin.client, provider)}`
  }

  private build(input: { turnId: string; prompt: string; verdict: OriginVerdict; provider: string; sessionId: string; via: string; fork?: boolean; resendOf?: string }): G2TurnRecord {
    const originKind = originKindOf(input.verdict.origin.client)
    // A web turn is never vouched unless an enrolled phone key's envelope was accepted (6.99.31).
    const webKey = originKind === 'web' && isWebKeyVerdict(input.verdict)
    const verifiedOrigin = input.verdict.verifiedOrigin === true && (originKind !== 'web' || webKey)
    const reason = verifiedOrigin ? null : (originKind === 'web' ? (input.verdict.webKeyReason ?? WEB_UNVOUCHED_REASON) : (input.verdict.reason ?? 'unverified'))
    return {
      turnId: input.turnId,
      createdAt: new Date(this.now()).toISOString(),
      textSha256: turnTextSha256(input.prompt),
      origin: { ...input.verdict.origin },
      originKind,
      verifiedOrigin,
      reason,
      originJudgedAt: typeof input.verdict.judgedAt === 'number' ? input.verdict.judgedAt : this.now(),
      target: { provider: input.provider, sessionId: input.sessionId, ...(input.fork ? { fork: true as const } : {}) },
      via: input.via,
      ...(typeof input.resendOf === 'string' && input.resendOf.length > 0 ? { resendOf: input.resendOf } : {}),
      ...(webKey && verifiedOrigin ? { authority: 'web-key' as const, webKey: input.verdict.webKey } : {}),
    }
  }

  /**
   * Whether delivering this candidate under `turnId` would reuse an id this process already holds
   * for a DIFFERENT turn. An identical retry (same target, text and origin) is not reuse. The routes
   * refuse a reuse before anything is sent. Never throws (a throw reads as reuse: refuse).
   */
  reusesTurnId(turnId: string, candidate: TurnCandidate, opts: { continues?: boolean } = {}): boolean {
    try {
      const held = this.deps.ledger.held(turnId)
      if (!held) return false
      return this.conflicts(held, this.build({ turnId, via: 'check', ...candidate }), opts.continues === true)
    } catch {
      return true
    }
  }

  /**
   * The one reuse rule. A held record is extended only by an identical retry, or by the server's
   * own continuation of a turn that is STILL PARKED (a queue, edit or Send again record). A
   * continuation never replaces a delivered record: a row written into a queue file by hand under
   * a delivered turn's id cannot drain over it.
   */
  private conflicts(held: G2TurnRecord, next: G2TurnRecord, continues: boolean): boolean {
    if (sameTurn(held, next)) return false
    return !(continues && PARKED_TURN_VIAS.has(held.via))
  }

  /** Whether this process holds any record under this id (a throw reads as held: refuse). */
  holds(turnId: string): boolean {
    try { return this.deps.ledger.held(turnId) !== null } catch { return true }
  }

  /**
   * Ledger one delivered or queued turn. `prompt` is the text WITHOUT the footer. Never throws.
   * `continues`: the server's own continuation of the turn parked under this id (drain carry, queue
   * edit, Cursor Stop hand-off), which may extend a parked record. Otherwise a held id is never
   * replaced: an identical retry keeps the first record, a different turn is refused (null, nothing
   * written).
   */
  record(input: { turnId: string; prompt: string; verdict: OriginVerdict; provider: string; sessionId: string; via: string; fork?: boolean; continues?: boolean; resendOf?: string }): G2TurnRecord | null {
    try {
      const record = this.build(input)
      const held = this.deps.ledger.held(input.turnId)
      if (held) {
        if (this.conflicts(held, record, input.continues === true)) {
          console.warn(`[g2-turn-ledger] turn id reuse refused turnId=${input.turnId} via=${input.via} held=${held.via}`)
          return null
        }
        // An identical retry that is not a continuation keeps the first record (and its time).
        if (input.continues !== true && sameTurn(held, record)) return held
      }
      this.deps.ledger.append(record, { replace: held !== null })
      return record
    } catch (error) {
      console.error(`[g2-turn-ledger] record failed: ${error instanceof Error ? error.message : error}`)
      return null
    }
  }

  private queueKey(provider: string, threadId: string, clientTurnId: string): string {
    return `${provider}\u0000${threadId}\u0000${clientTurnId}`
  }

  /**
   * A turn parked in the queue (or edited there): remember who said these words. The origin lapses
   * QUEUED_ORIGIN_TTL_MS after the verdict was judged (`verdict.judgedAt`), never after this call:
   * an origin cannot be made to last longer by noting it again.
   */
  noteQueued(provider: string, threadId: string, clientTurnId: string, prompt: string, verdict: OriginVerdict, attachments = ''): void {
    const at = this.now()
    for (const [k, held] of this.queued) if (at - held.judgedAt > QUEUED_ORIGIN_TTL_MS) this.queued.delete(k)
    const key = this.queueKey(provider, threadId, clientTurnId)
    this.queued.delete(key)
    this.queued.set(key, { verdict, textSha256: turnTextSha256(prompt), judgedAt: typeof verdict.judgedAt === 'number' ? verdict.judgedAt : at, attachments })
    while (this.queued.size > QUEUED_ORIGIN_MAX) this.queued.delete(this.queued.keys().next().value as string)
  }

  forgetQueued(provider: string, threadId: string, clientTurnId: string): void {
    this.queued.delete(this.queueKey(provider, threadId, clientTurnId))
  }

  /**
   * The origin remembered for this queued turn, only while its text is the text it vouched for and
   * within QUEUED_ORIGIN_TTL_MS of when it was judged. A lapsed origin is forgotten here.
   */
  queuedVerdict(provider: string, threadId: string, clientTurnId: string, prompt: string): OriginVerdict | null {
    const held = this.queuedOrigin(provider, threadId, clientTurnId, prompt)
    return held ? this.reheld(held.verdict, prompt, held.attachments) : null
  }

  private queuedOrigin(provider: string, threadId: string, clientTurnId: string, prompt: string): QueuedOrigin | null {
    const key = this.queueKey(provider, threadId, clientTurnId)
    const held = this.queued.get(key)
    if (!held) return null
    if (this.now() - held.judgedAt > QUEUED_ORIGIN_TTL_MS) { this.queued.delete(key); return null }
    if (held.textSha256 !== turnTextSha256(prompt)) return null
    return held
  }

  /**
   * Send again (Codex re-audit of 910eb90, P1). The row's words are MUTABLE (any local process can
   * rewrite the queue file), so a copy never inherits the original row's authority: inheriting it by
   * id once let a local caller change a refused G2 row's words or files and mint a new vouched turn
   * from them. The copy is judged by THE REQUEST THAT SENT IT AGAIN, fresh: a G2 or phone client
   * resending is vouched by its own socket and ring-owner instance, exactly like a new turn, and
   * anything else (an agent's token over loopback, a web cookie, an unknown caller) is recorded
   * unvouched with RESEND_NOT_REVERIFIED_REASON, so it gets no footer. The original id survives only
   * as the record's `resendOf` annotation, which vouches for nothing.
   */
  resendVerdict(req: OriginRequest): OriginVerdict {
    const fresh = this.originOf(req)
    return fresh.verifiedOrigin === true ? fresh : unvouched(fresh, RESEND_NOT_REVERIFIED_REASON)
  }

  /**
   * A single-use token for the drainer's loopback hop. ALWAYS issued for a drain: it carries the
   * parked origin while one is held for these words (else none, and the turn route judges the hop as
   * the local call it is), and it marks the hop as the queue's own continuation of the parked turn,
   * the one caller allowed to add to that turn's ledger record. Null only if no token can be made.
   */
  issueCarry(turn: { provider: string; threadId: string; clientTurnId: string; prompt: string }): string | null {
    try {
      const held = this.queuedOrigin(turn.provider, turn.threadId, turn.clientTurnId, turn.prompt)
      const at = this.now()
      for (const [token, carry] of this.carries) if (carry.expiresAt <= at) this.carries.delete(token)
      const token = (this.deps.randomToken ?? (() => randomBytes(32).toString('hex')))()
      // The seal rides with the origin: the turn route checks the binding's provider and thread and
      // the files it is about to compose against it, and refuses a vouched turn that no longer matches.
      const seal: QueueSeal | null = held ? { provider: turn.provider, threadId: turn.threadId, attachments: held.attachments } : null
      // 6.99.31: a parked web-key approval is re-checked here, at its drain: expired, revoked, a moved
      // epoch or changed words carry it unvouched (never re-dated).
      const verdict = held ? this.reheld(held.verdict, turn.prompt, held.attachments) : null
      this.carries.set(token, { clientTurnId: turn.clientTurnId, verdict, seal, textSha256: turnTextSha256(turn.prompt), expiresAt: at + TURN_CARRY_TTL_MS })
      return token
    } catch {
      return null
    }
  }

  /**
   * Spend a carry token. Null unless it is live, unspent, and names this turn and these words;
   * otherwise `{ verdict, seal }`: the parked origin and what it is sealed to, or nulls when none was
   * left to carry.
   */
  takeCarry(token: unknown, clientTurnId: string, prompt: string): { verdict: OriginVerdict | null; seal: QueueSeal | null } | null {
    if (typeof token !== 'string' || token.length === 0) return null
    const carry = this.carries.get(token)
    if (!carry) return null
    this.carries.delete(token)
    if (carry.expiresAt <= this.now()) return null
    if (carry.clientTurnId !== clientTurnId || carry.textSha256 !== turnTextSha256(prompt)) return null
    return { verdict: carry.verdict, seal: carry.seal }
  }
}

/** One answer of `GET /api/g2-turns/:turnId`. */
export async function describeG2Turn(provenance: G2TurnProvenance, turnId: string, now: number): Promise<Record<string, unknown> | null> {
  const found = await provenance.ledger.find(turnId)
  if (!found) return null
  const { record, sealed } = found
  // Codex re-audit of 910eb90 (P2): the age of an APPROVAL is measured from when its origin was
  // judged (the request Miles sent), never from when it was delivered. A queued, edited or Cursor
  // Stop turn is recorded again at delivery with a new createdAt; measuring from that made a turn
  // that waited 20 minutes in the queue read as seconds old to the verifier's 15-minute check. The
  // earlier of the two is used, so an approval can never read younger than its delivery.
  const createdMs = Date.parse(record.createdAt)
  const judgedMs = typeof record.originJudgedAt === 'number' && Number.isFinite(record.originJudgedAt) ? record.originJudgedAt : null
  const fromMs = judgedMs !== null && Number.isFinite(createdMs) ? Math.min(judgedMs, createdMs) : (judgedMs ?? createdMs)
  const ageMs = Number.isFinite(fromMs) ? Math.max(0, now - fromMs) : null
  // 6.99.29: g2, phone or web (older records carry only `origin.client`).
  const originKind = record.originKind ?? originKindOf(record.origin?.client)
  // Only a record this process wrote and still holds vouches for anything (see the header), never a
  // web turn (its cookie is derivable from the token), and never past G2_TURN_VOUCH_MAX_MS.
  let reason: string | null = null
  // 6.99.31: a web-key record is self-proving (envelope + signature): re-verified here against the
  // registry, so it vouches after a restart too, and reads revoked the moment its key is revoked.
  // Flag off: every web record reads WEB_UNVOUCHED_REASON, exactly as 6.99.29.
  const authority = provenance.webKey
  const webKeyOn = authority !== null && authority.enabled()
  const webKeyRecord = originKind === 'web' && record.authority === 'web-key' && record.verifiedOrigin === true && !!record.webKey
  const webKeyReview = webKeyRecord && webKeyOn && authority ? authority.review(record.webKey as WebKeyProof, { turnId: record.turnId, target: record.target }) : null
  if (originKind === 'web') {
    if (webKeyReview === null) reason = webKeyOn && typeof record.reason === 'string' && record.verifiedOrigin !== true ? record.reason : WEB_UNVOUCHED_REASON
    else if (webKeyReview.reason !== null) reason = webKeyReview.reason
    else if (ageMs === null || ageMs > G2_TURN_VOUCH_MAX_MS) reason = 'record_too_old'
  } else if (record.verifiedOrigin !== true) reason = typeof record.reason === 'string' ? record.reason : 'unverified'
  else if (!sealed) reason = 'not_sealed'
  else if (ageMs === null || ageMs > G2_TURN_VOUCH_MAX_MS) reason = 'record_too_old'
  return {
    found: true,
    turnId: record.turnId,
    createdAt: record.createdAt,
    /** When the origin this turn carries was judged; `ageMs` (and the vouch limit) run from here. */
    originJudgedAt: Number.isFinite(fromMs) ? new Date(fromMs).toISOString() : null,
    ageMs,
    textSha256: record.textSha256,
    origin: record.origin,
    originKind,
    verifiedOrigin: reason === null,
    reason,
    sealed,
    target: record.target,
    via: record.via,
    ...(typeof record.resendOf === 'string' ? { resendOf: record.resendOf } : {}),
    ...(webKeyReview !== null && record.webKey ? {
      authority: 'web-key',
      kid: record.webKey.kid,
      scope: record.webKey.scope,
      // Review B4: what this scope means and what it never authorizes, in the answer itself.
      scopeMeaning: record.webKey.scope?.kind === 'approve' ? 'approve' : MESSAGE_SCOPE_MEANING,
      notAuthorized: notAuthorizedFor(record.webKey.scope?.kind === 'approve' ? record.webKey.scope : { kind: 'message' }),
      envelope: record.webKey.envelope,
      signature: record.webKey.signature,
      passkey: record.webKey.passkey ?? null,
      authId: record.webKey.authId,
      registryEntry: webKeyReview.entry,
      // Anchor (B1), epoch and revocations (W5), integrity (W1), consume keys (B3): docs/web-key-verifier-contract.md section 6.
      ...(webKeyReview.facts ?? {}),
    } : {}),
  }
}
