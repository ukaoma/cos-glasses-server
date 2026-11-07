// G2 authority, Tier 1 (ported to 6.99.29 from the unmerged 6.66 design, a3c8c4b): verifiable
// provenance for the turns this server delivers into an agent session on behalf of the glasses,
// the phone, or a signed-in COS Control Web browser (6.99.29).
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
// WEB ORIGIN (6.99.29). Miles types into a session's box on COS Control Web from his phone. The
// browser holds no X-Cos-Token; it holds the HttpOnly `cos_web_session` cookie, minted only after a
// sign-in with the pairing token, a Mac handoff ticket or a code from an already signed-in device,
// signed with the token and the current session epoch, and good for 7 days. A turn is
// verifiedOrigin with client `web` only when ALL of these hold:
//   1. The request carries NO X-Cos-Token header at all. Agents on this Mac hold the token; a
//      request that presents it is judged by the G2 rule above and can never be a web turn, even
//      with a cookie attached.
//   2. The cookie path passes in full (`webSession`, `isWebSessionAuthorized` in production): the
//      socket is loopback or a tailnet peer, the cookie's signature, expiry and epoch are good, and
//      a write carries X-COS-Web: 1 plus an Origin or Referer that names this very server.
//   3. The socket is not loopback and not this Mac's own address: the same this-Mac test as the G2
//      rule (1), so a process on the Mac that lifted a cookie still cannot mint a verified turn.
// COS Control Web open ON the Mac (loopback, or the Mac's own tailnet address) is therefore
// never verified: from the socket it is indistinguishable from any local process, including an
// agent that read the cookie out of a browser profile.
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
// disk no longer matches the hash and drains as local.

import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { turnFooter } from './turn-footer.js'

export { G2_TURN_FOOTER_RE, g2TurnFooter, stripG2TurnFooter, turnFooter, turnFooterTag, withoutTurnFooter } from './turn-footer.js'

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
}

export interface G2TurnRecord {
  turnId: string
  createdAt: string
  textSha256: string
  origin: TurnOrigin
  /** 6.99.29: g2, phone or web; null when the turn was not footed (a local or unknown caller). */
  originKind: TurnOriginKind | null
  verifiedOrigin: boolean
  target: { provider: string; sessionId: string; fork?: true }
  via: string
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

/** Whether a turn of this origin gets the footer: the glasses, the phone, or a signed-in web browser. */
export function footerApplies(verdict: OriginVerdict): boolean {
  return originKindOf(verdict.origin.client) !== null
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

  /** Append one record. Kept in memory (sealed) even when the disk write fails. Never throws. */
  append(record: G2TurnRecord): boolean {
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
  now?: () => number
  randomToken?: () => string
}

interface QueuedOrigin { verdict: OriginVerdict; textSha256: string }
interface Carry { clientTurnId: string; verdict: OriginVerdict; textSha256: string; expiresAt: number }

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
    if (known && !loopback && !ownAddress) {
      if (webSession) {
        // The cookie path passed, no token was shown, and the socket is not this Mac.
        verifiedOrigin = true
      } else if (clientInstance !== null) {
        let paired: string | null = null
        try { paired = this.deps.pairedInstance(remote, this.now(), PAIRED_INSTANCE_FRESH_MS) } catch { paired = null }
        verifiedOrigin = paired !== null && paired === clientInstance
      }
    }
    return { origin: { remote: known ? remote : 'unknown', loopback, ownAddress, clientInstance, client, tokenPresented, webSession }, verifiedOrigin }
  }

  /** The text to deliver: with the footer for a glasses, phone or web turn, otherwise unchanged. */
  footed(prompt: string, turnId: string, verdict: OriginVerdict): string {
    if (!footerApplies(verdict) || !G2_TURN_ID_RE.test(turnId)) return prompt
    return `${prompt.replace(/[\t\n\v\f\r ]+$/, '')}\n${turnFooter(turnId, verdict.origin.client)}`
  }

  /** Ledger one delivered or queued turn. `prompt` is the text WITHOUT the footer. Never throws. */
  record(input: { turnId: string; prompt: string; verdict: OriginVerdict; provider: string; sessionId: string; via: string; fork?: boolean }): G2TurnRecord | null {
    try {
      const record: G2TurnRecord = {
        turnId: input.turnId,
        createdAt: new Date(this.now()).toISOString(),
        textSha256: turnTextSha256(input.prompt),
        origin: { ...input.verdict.origin },
        originKind: originKindOf(input.verdict.origin.client),
        verifiedOrigin: input.verdict.verifiedOrigin,
        target: { provider: input.provider, sessionId: input.sessionId, ...(input.fork ? { fork: true as const } : {}) },
        via: input.via,
      }
      this.deps.ledger.append(record)
      return record
    } catch (error) {
      console.error(`[g2-turn-ledger] record failed: ${error instanceof Error ? error.message : error}`)
      return null
    }
  }

  private queueKey(provider: string, threadId: string, clientTurnId: string): string {
    return `${provider}\u0000${threadId}\u0000${clientTurnId}`
  }

  /** A turn parked in the queue (or edited there): remember who said these words. */
  noteQueued(provider: string, threadId: string, clientTurnId: string, prompt: string, verdict: OriginVerdict): void {
    const key = this.queueKey(provider, threadId, clientTurnId)
    this.queued.delete(key)
    this.queued.set(key, { verdict, textSha256: turnTextSha256(prompt) })
    while (this.queued.size > QUEUED_ORIGIN_MAX) this.queued.delete(this.queued.keys().next().value as string)
  }

  forgetQueued(provider: string, threadId: string, clientTurnId: string): void {
    this.queued.delete(this.queueKey(provider, threadId, clientTurnId))
  }

  /** The origin remembered for this queued turn, only while its text is the text it vouched for. */
  queuedVerdict(provider: string, threadId: string, clientTurnId: string, prompt: string): OriginVerdict | null {
    const held = this.queued.get(this.queueKey(provider, threadId, clientTurnId))
    if (!held || held.textSha256 !== turnTextSha256(prompt)) return null
    return held.verdict
  }

  /** A single-use token that carries a queued turn's origin across the drainer's loopback hop. */
  issueCarry(turn: { provider: string; threadId: string; clientTurnId: string; prompt: string }): string | null {
    const verdict = this.queuedVerdict(turn.provider, turn.threadId, turn.clientTurnId, turn.prompt)
    if (!verdict) return null
    const at = this.now()
    for (const [token, carry] of this.carries) if (carry.expiresAt <= at) this.carries.delete(token)
    const token = (this.deps.randomToken ?? (() => randomBytes(32).toString('hex')))()
    this.carries.set(token, { clientTurnId: turn.clientTurnId, verdict, textSha256: turnTextSha256(turn.prompt), expiresAt: at + TURN_CARRY_TTL_MS })
    return token
  }

  /** Spend a carry token. Null unless it is live, unspent, and names this turn and these words. */
  takeCarry(token: unknown, clientTurnId: string, prompt: string): OriginVerdict | null {
    if (typeof token !== 'string' || token.length === 0) return null
    const carry = this.carries.get(token)
    if (!carry) return null
    this.carries.delete(token)
    if (carry.expiresAt <= this.now()) return null
    if (carry.clientTurnId !== clientTurnId || carry.textSha256 !== turnTextSha256(prompt)) return null
    return carry.verdict
  }
}

/** One answer of `GET /api/g2-turns/:turnId`. */
export async function describeG2Turn(provenance: G2TurnProvenance, turnId: string, now: number): Promise<Record<string, unknown> | null> {
  const found = await provenance.ledger.find(turnId)
  if (!found) return null
  const { record, sealed } = found
  const createdMs = Date.parse(record.createdAt)
  return {
    found: true,
    turnId: record.turnId,
    createdAt: record.createdAt,
    ageMs: Number.isFinite(createdMs) ? Math.max(0, now - createdMs) : null,
    textSha256: record.textSha256,
    origin: record.origin,
    // 6.99.29: g2, phone or web (older records carry only `origin.client`).
    originKind: record.originKind ?? originKindOf(record.origin?.client),
    // Only a record this process wrote and still holds vouches for anything (see the header).
    verifiedOrigin: sealed && record.verifiedOrigin === true,
    sealed,
    target: record.target,
    via: record.via,
  }
}
