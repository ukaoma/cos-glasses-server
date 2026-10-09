// Glasses pairing (6.67.0). Contract: docs/pairing-contract.md.
//
// COS Control mints a short-lived, single-use code over loopback and shows it as a QR.
// The phone claims it over Tailscale (or the home Wi-Fi while that is armed), the Mac
// user presses Allow, and only then does the phone's poll receive the pairing token,
// exactly once. Everything here is in memory: a restart loses every code and claim,
// and `bootId` changes so Control knows to show a new code.
//
// This module is pure. The clock, the random source, the token, the host list and
// the server name are injected so every rule in the contract is testable.

import { createHash, randomInt as cryptoRandomInt, randomUUID } from 'node:crypto'
import { isRfc1918Ipv4, isTailscaleIpv4, normalizeRemoteIp } from './network-policy.js'

export const PAIRING_PROTOCOL_VERSION = 1
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const PAIRING_CODE_LENGTH = 8
export const PAIRING_CODE_TTL_MS = 5 * 60_000
export const PAIRING_PENDING_TTL_MS = 60_000
export const PAIRING_LAN_ARM_MS = 10 * 60_000
export const PAIRING_IP_LIMIT_PER_MINUTE = 5
export const PAIRING_IP_WINDOW_MS = 60_000
export const PAIRING_CODE_ATTEMPT_LIMIT = 20
/** Decided claims stay pollable this long, so a slow phone still sees `denied`. */
export const PAIRING_CLAIM_RETENTION_MS = 10 * 60_000
/** At most this many hosts in a QR, Tailscale first, so the QR stays small. */
export const PAIRING_MAX_QR_HOSTS = 3
export const PAIRING_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
/** The QR grammar. Clients parse it; the server is the only writer. */
export const PAIRING_QR_PATTERN = /^COS1\/MAC\/[0-9A-HJKMNP-TV-Z]{8}\/(?:\d{1,3}(?:\.\d{1,3}){3}:\d{1,5})(?:,\d{1,3}(?:\.\d{1,3}){3}:\d{1,5})*\/[0-9A-Z]+$/

export type PairingReason =
  | 'expired'
  | 'used'
  | 'locked'
  | 'rate_limited'
  | 'not_loopback'
  | 'not_allowed_network'
  | 'unknown_code'
  | 'denied'
  | 'draining'
  | 'bad_request'

export const PAIRING_REASON_STATUS: Record<PairingReason, number> = {
  bad_request: 400,
  not_loopback: 403,
  not_allowed_network: 403,
  denied: 403,
  unknown_code: 404,
  used: 409,
  locked: 409,
  expired: 410,
  rate_limited: 429,
  draining: 503,
}

export const PAIRING_REASON_MESSAGE: Record<PairingReason, string> = {
  bad_request: 'That pairing request was not understood. Scan the code again.',
  not_loopback: 'Pairing codes are made only by COS Control on this Mac.',
  not_allowed_network: 'Connect over Tailscale, or turn on "Allow pairing on this Wi-Fi" in COS Control.',
  denied: 'Pairing was denied on the Mac.',
  unknown_code: 'This code is not current. Show a new one in COS Control.',
  used: 'This code was already used. Show a new one in COS Control.',
  locked: 'Too many tries, or another device is waiting. Show a new code in COS Control.',
  expired: 'Code expired: show a new one in COS Control.',
  rate_limited: 'Too many tries. Wait a minute and try again.',
  draining: 'Your Mac is updating. Try again in a minute.',
}

export type PairingHostKind = 'tailscale' | 'lan'
export interface PairingHost {
  host: string
  port: number
  kind: PairingHostKind
}

export type ClaimState = 'pending' | 'allowed' | 'denied' | 'expired' | 'delivered'

export class PairingError extends Error {
  readonly reason: PairingReason
  readonly status: number
  readonly retryAfterSeconds?: number
  constructor(reason: PairingReason, retryAfterSeconds?: number) {
    super(reason)
    this.reason = reason
    this.status = PAIRING_REASON_STATUS[reason]
    this.retryAfterSeconds = retryAfterSeconds
  }
}

// ── Code and QR grammar ─────────────────────────────────────────────────────

export function generatePairingCode(randomInt: (max: number) => number = max => cryptoRandomInt(max)): string {
  let code = ''
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += CROCKFORD_ALPHABET[randomInt(CROCKFORD_ALPHABET.length)]
  return code
}

/** Uppercase, O→0, I/L→1, strip spaces and dashes. Null unless 8 Crockford characters remain. */
export function normalizePairingCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 32) return null
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (code.length !== PAIRING_CODE_LENGTH) return null
  for (const ch of code) if (!CROCKFORD_ALPHABET.includes(ch)) return null
  return code
}

export function displayPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** `COS1/MAC/<CODE>/<host>:<port>[,<host>:<port>]/<EXP>`, EXP = unix seconds in base36 uppercase. */
export function buildPairingQr(code: string, hosts: readonly PairingHost[], expiresAtMs: number): string {
  const hostList = hosts.map(h => `${h.host}:${h.port}`).join(',')
  const exp = Math.floor(expiresAtMs / 1000).toString(36).toUpperCase()
  return `COS1/MAC/${code}/${hostList}/${exp}`
}

/** First 2 hex characters of sha256(code): the only form of a code that is ever logged. */
export function pairingCodeTag(code: string): string {
  return createHash('sha256').update(code).digest('hex').slice(0, 2)
}

/**
 * Pairing hosts from the reachable-address list: Tailscale IPv4 first, then RFC1918
 * only while LAN is armed. Never IPv6 or MagicDNS. Deduplicated, capped for QR size.
 */
export function pairingHostsFrom(
  addresses: ReadonlyArray<{ address: string; kind: 'tailscale' | 'lan' | 'other' }>,
  port: number,
  lanArmed: boolean,
): PairingHost[] {
  const seen = new Set<string>()
  const tailscale: PairingHost[] = []
  const lan: PairingHost[] = []
  for (const entry of addresses) {
    if (seen.has(entry.address)) continue
    if (isTailscaleIpv4(entry.address)) {
      seen.add(entry.address)
      tailscale.push({ host: entry.address, port, kind: 'tailscale' })
    } else if (lanArmed && entry.kind === 'lan' && isRfc1918Ipv4(entry.address)) {
      seen.add(entry.address)
      lan.push({ host: entry.address, port, kind: 'lan' })
    }
  }
  return [...tailscale, ...lan].slice(0, PAIRING_MAX_QR_HOSTS)
}

// ── State machine ───────────────────────────────────────────────────────────

interface CodeRecord {
  code: string
  expiresAt: number
  attempts: number
  status: 'active' | 'used' | 'locked'
}

interface ClaimRecord {
  nonce: string
  code: string
  ip: string
  at: number
  state: ClaimState
  decidedAt: number | null
  deliveredAt: number | null
}

export interface PairingStateOptions {
  now?: () => number
  randomInt?: (max: number) => number
  bootId?: string
  /** The standing pairing token, read at delivery time so a rotation is honoured. */
  token: () => string
  serverName: () => string
  /** Hosts for the QR, given whether LAN is armed right now. */
  hosts: (lanArmed: boolean) => PairingHost[]
  log?: (line: string) => void
}

export interface MintResult {
  code: string
  display: string
  qr: string | null
  expiresAt: string
  bootId: string
  hosts: PairingHost[]
  lanArmedUntil: string | null
}

export interface PollResult {
  state: ClaimState
  token?: string
  serverName?: string
}

export interface PairingStatus {
  code: { display: string; expiresAt: string; state: CodeRecord['status'] } | null
  pending: { nonce: string; ip: string; at: string } | null
  lastClaim: { ip: string; at: string; allowed: boolean } | null
  firstAuthAfterClaimAt: string | null
  lanArmedUntil: string | null
  bootId: string
}

const iso = (ms: number) => new Date(ms).toISOString()

export class PairingState {
  readonly bootId: string
  private readonly now: () => number
  private readonly randomInt?: (max: number) => number
  private readonly opts: PairingStateOptions
  private readonly log: (line: string) => void
  private current: CodeRecord | null = null
  private pendingNonce: string | null = null
  private readonly claims = new Map<string, ClaimRecord>()
  private lastClaimNonce: string | null = null
  private firstAuthAfterClaimAt: number | null = null
  private lanArmedUntil: number | null = null
  private readonly ipAttempts = new Map<string, number[]>()

  constructor(opts: PairingStateOptions) {
    this.opts = opts
    this.now = opts.now ?? (() => Date.now())
    this.randomInt = opts.randomInt
    this.bootId = opts.bootId ?? randomUUID()
    this.log = opts.log ?? (line => console.log(line))
  }

  private lanArmed(at: number): boolean {
    return this.lanArmedUntil != null && at < this.lanArmedUntil
  }

  /** Lazy timers: a pending claim older than 60 s expires; old decided claims are dropped. */
  private sweep(at: number): void {
    if (this.pendingNonce) {
      const pending = this.claims.get(this.pendingNonce)
      if (!pending || pending.state !== 'pending') {
        this.pendingNonce = null
      } else if (at - pending.at >= PAIRING_PENDING_TTL_MS) {
        pending.state = 'expired'
        pending.decidedAt = at
        this.pendingNonce = null
        this.log(`[pairing] claim expired ip=${pending.ip} code#=${pairingCodeTag(pending.code)}`)
      }
    }
    for (const [nonce, claim] of this.claims) {
      if (claim.state !== 'pending' && at - claim.at > PAIRING_CLAIM_RETENTION_MS && nonce !== this.lastClaimNonce) {
        this.claims.delete(nonce)
      }
    }
    if (this.lanArmedUntil != null && at >= this.lanArmedUntil) this.lanArmedUntil = null
  }

  /** POST /pairing/code. A new code cancels the previous code and any pending claim. */
  mint(input: { allowLan?: boolean } = {}): MintResult {
    const at = this.now()
    this.sweep(at)
    if (this.pendingNonce) {
      const pending = this.claims.get(this.pendingNonce)
      if (pending && pending.state === 'pending') {
        pending.state = 'expired'
        pending.decidedAt = at
      }
      this.pendingNonce = null
    }
    this.lanArmedUntil = input.allowLan === true ? at + PAIRING_LAN_ARM_MS : null
    const code = generatePairingCode(this.randomInt)
    const expiresAt = at + PAIRING_CODE_TTL_MS
    this.current = { code, expiresAt, attempts: 0, status: 'active' }
    const hosts = this.opts.hosts(this.lanArmed(at))
    const qr = hosts.length > 0 ? buildPairingQr(code, hosts, expiresAt) : null
    this.log(`[pairing] code minted hosts=${hosts.map(h => h.host).join(',') || 'none'} lan=${this.lanArmedUntil ? 'armed' : 'off'} code#=${pairingCodeTag(code)}`)
    return {
      code,
      display: displayPairingCode(code),
      qr,
      expiresAt: iso(expiresAt),
      bootId: this.bootId,
      hosts,
      lanArmedUntil: this.lanArmedUntil != null ? iso(this.lanArmedUntil) : null,
    }
  }

  /** Throws PairingError unless `ip` may claim at all (network, then per-IP limit). */
  private admitClaimer(ip: string, at: number): void {
    if (!isTailscaleIpv4(ip) && !(isRfc1918Ipv4(ip) && this.lanArmed(at))) {
      throw new PairingError('not_allowed_network')
    }
    const recent = (this.ipAttempts.get(ip) ?? []).filter(t => at - t < PAIRING_IP_WINDOW_MS)
    if (recent.length >= PAIRING_IP_LIMIT_PER_MINUTE) {
      this.ipAttempts.set(ip, recent)
      const retry = Math.max(1, Math.ceil((PAIRING_IP_WINDOW_MS - (at - recent[0])) / 1000))
      throw new PairingError('rate_limited', retry)
    }
    recent.push(at)
    this.ipAttempts.set(ip, recent)
    if (this.ipAttempts.size > 1000) {
      for (const [key, times] of this.ipAttempts) {
        if (times.every(t => at - t >= PAIRING_IP_WINDOW_MS)) this.ipAttempts.delete(key)
      }
    }
  }

  /** POST /pairing/claim. Returns normally for 202 `{ pending: true }`; throws PairingError otherwise. */
  claim(input: { code: unknown; nonce: unknown }, socketIp: string): void {
    const at = this.now()
    this.sweep(at)
    const ip = normalizeRemoteIp(socketIp)
    this.admitClaimer(ip, at)
    const nonce = typeof input.nonce === 'string' && PAIRING_NONCE_PATTERN.test(input.nonce) ? input.nonce : null
    const code = normalizePairingCode(input.code)
    if (!nonce || !code) {
      this.log(`[pairing] claim ip=${ip} result=bad_request`)
      throw new PairingError('bad_request')
    }
    const tag = pairingCodeTag(code)
    const refuse = (reason: PairingReason): never => {
      this.log(`[pairing] claim ip=${ip} result=${reason} code#=${tag}`)
      throw new PairingError(reason)
    }

    // Idempotent for the same nonce and code from the same socket IP.
    const existing = this.claims.get(nonce)
    if (existing) {
      if (existing.code !== code || existing.ip !== ip) refuse('locked')
      if (existing.state === 'pending') return
      if (existing.state === 'denied') refuse('denied')
      if (existing.state === 'expired') refuse('expired')
      // allowed or delivered: the claim already succeeded; the poll carries the token.
      return
    }

    const current = this.current
    if (!current) refuse('unknown_code')
    const record = current as CodeRecord
    if (at >= record.expiresAt) refuse(record.code === code ? 'expired' : 'unknown_code')
    if (record.status === 'locked') refuse('locked')
    // Every attempt while a code is live counts against it, right or wrong.
    record.attempts++
    if (record.attempts > PAIRING_CODE_ATTEMPT_LIMIT) {
      // A pending claim keeps waiting for its decision; only new claims are locked out.
      record.status = 'locked'
      refuse('locked')
    }
    if (record.code !== code) refuse('unknown_code')
    if (this.pendingNonce) refuse('locked')
    if (record.status === 'used') refuse('used')

    record.status = 'used'
    this.claims.set(nonce, { nonce, code, ip, at, state: 'pending', decidedAt: null, deliveredAt: null })
    this.pendingNonce = nonce
    this.lastClaimNonce = nonce
    this.log(`[pairing] claim ip=${ip} result=pending code#=${tag}`)
  }

  /** GET /pairing/claim/:nonce. The token is returned once; `allowed` then reads `delivered`. */
  poll(nonce: string, socketIp: string): PollResult {
    const at = this.now()
    this.sweep(at)
    const ip = normalizeRemoteIp(socketIp)
    const claim = this.claims.get(nonce)
    if (!claim) throw new PairingError('unknown_code')
    if (claim.ip !== ip) {
      this.log(`[pairing] poll ip=${ip} result=not_allowed_network code#=${pairingCodeTag(claim.code)}`)
      throw new PairingError('not_allowed_network')
    }
    if (claim.state === 'allowed') {
      claim.state = 'delivered'
      claim.deliveredAt = at
      this.log(`[pairing] token delivered ip=${ip} code#=${pairingCodeTag(claim.code)}`)
      return { state: 'allowed', token: this.opts.token(), serverName: this.opts.serverName() }
    }
    if (claim.state === 'delivered') return { state: 'delivered', serverName: this.opts.serverName() }
    return { state: claim.state }
  }

  /** POST /pairing/decision. */
  decide(nonce: unknown, allow: unknown): void {
    const at = this.now()
    this.sweep(at)
    if (typeof nonce !== 'string' || typeof allow !== 'boolean') throw new PairingError('bad_request')
    const claim = this.claims.get(nonce)
    if (!claim) throw new PairingError('unknown_code')
    if (claim.state === 'expired') throw new PairingError('expired')
    if (claim.state !== 'pending') throw new PairingError('used')
    claim.state = allow ? 'allowed' : 'denied'
    claim.decidedAt = at
    this.pendingNonce = null
    this.lastClaimNonce = nonce
    if (allow) this.firstAuthAfterClaimAt = null
    this.log(`[pairing] decision ip=${claim.ip} result=${allow ? 'allowed' : 'denied'} code#=${pairingCodeTag(claim.code)}`)
  }

  /**
   * Called after a request passes requireApiToken. Stamps `firstAuthAfterClaimAt` once,
   * for the first authenticated request from the allowed claim's IP after its token
   * was delivered, so another phone's traffic can never turn Control green.
   */
  noteAuthenticated(socketIp: string | undefined): void {
    if (this.firstAuthAfterClaimAt != null || !this.lastClaimNonce) return
    const claim = this.claims.get(this.lastClaimNonce)
    if (!claim || claim.state !== 'delivered') return
    if (normalizeRemoteIp(socketIp ?? '') !== claim.ip) return
    this.firstAuthAfterClaimAt = this.now()
    this.log(`[pairing] first authenticated request ip=${claim.ip}`)
  }

  /** GET /pairing/status. */
  status(): PairingStatus {
    const at = this.now()
    this.sweep(at)
    const current = this.current && at < this.current.expiresAt ? this.current : null
    const pending = this.pendingNonce ? this.claims.get(this.pendingNonce) ?? null : null
    const last = this.lastClaimNonce ? this.claims.get(this.lastClaimNonce) ?? null : null
    return {
      code: current ? { display: displayPairingCode(current.code), expiresAt: iso(current.expiresAt), state: current.status } : null,
      pending: pending ? { nonce: pending.nonce, ip: pending.ip, at: iso(pending.at) } : null,
      lastClaim: last ? { ip: last.ip, at: iso(last.at), allowed: last.state === 'allowed' || last.state === 'delivered' } : null,
      firstAuthAfterClaimAt: this.firstAuthAfterClaimAt != null ? iso(this.firstAuthAfterClaimAt) : null,
      lanArmedUntil: this.lanArmedUntil != null ? iso(this.lanArmedUntil) : null,
      bootId: this.bootId,
    }
  }
}
