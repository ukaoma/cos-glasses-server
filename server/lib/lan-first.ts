// 6.88.0 LAN first (docs/lan-first.md). Two additive pieces for the phone:
//
// 1. A pre-token identity proof. `GET /api/route-proof?nonce=<phone nonce>` is public, so a
//    phone can ask an address it has not used before "are you the Mac I paired with?"
//    BEFORE it sends X-Cos-Token there. The answer is an HMAC keyed by the token over a
//    fixed, domain-separated message; the phone computes the same HMAC with its stored
//    token and sends the token only on a match. A machine without the token cannot make a
//    matching proof, and the response never carries the token.
// 2. The addresses this Mac answers on, published ONLY on authenticated /api/models (never
//    on public /api/health), so the phone can learn its LAN route after a DHCP change.
//
// This module is pure apart from the cached interface read. Clock, interfaces, token and
// instance id are injected so every rule is testable.

import { createHmac } from 'node:crypto'
import { networkInterfaces as osNetworkInterfaces } from 'node:os'
import { isRfc1918Ipv4, isTailscaleIpv4, normalizeRemoteIp } from './network-policy.js'

export const ROUTE_PROOF_PROTOCOL = 1
export const LAN_ROUTES_PROTOCOL = 1

/**
 * The fixed domain-separation prefix. The caller chooses only the nonce, never the whole
 * message, and the nonce charset has no `:`, so the message always parses one way. The only
 * other HMAC keyed by the token signs `display-stream:<exp>` (lib/display-ticket.ts), which
 * can never begin with this prefix, so a proof is never a usable display ticket.
 */
export const ROUTE_PROOF_PREFIX = 'cos-route-proof:v1:'
/** base64url alphabet, 22 to 64 characters. 22 base64url characters carry 132 bits. */
export const ROUTE_PROOF_NONCE_PATTERN = /^[A-Za-z0-9_-]{22,64}$/
/**
 * A proof lets anyone on the network check token guesses offline, so it is served only for
 * a token long enough that guessing is hopeless. COS Control writes 64 hex characters and
 * the server's own token is 44 base64url characters; a short hand-set legacy token gets no
 * proof (the phone keeps today's single-route behaviour).
 */
export const ROUTE_PROOF_MIN_TOKEN_LENGTH = 32
export const ROUTE_PROOF_IP_LIMIT = 20
export const ROUTE_PROOF_GLOBAL_LIMIT = 240
export const ROUTE_PROOF_WINDOW_MS = 60_000
/** Past this many tracked addresses, idle ones are dropped. Live ones are bounded by the global ceiling. */
export const ROUTE_PROOF_MAX_TRACKED_IPS = 1024

export const LAN_ROUTES_CACHE_MS = 10_000
export const LAN_ROUTES_MAX_PER_KIND = 8

/** `COS_LAN_FIRST=0` turns off both pieces (read per request). Anything else leaves them on. */
export function lanFirstEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COS_LAN_FIRST !== '0'
}

/** The plain-http port the phone uses on both paths (server/index.ts reads the same `PORT`). */
export function lanFirstHttpPort(env: NodeJS.ProcessEnv = process.env): number {
  const port = parseInt(env.PORT ?? '3141', 10)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3141
}

export function isValidRouteProofNonce(value: unknown): value is string {
  return typeof value === 'string' && ROUTE_PROOF_NONCE_PATTERN.test(value)
}

export function routeProofTokenUsable(token: unknown): token is string {
  return typeof token === 'string' && token.length >= ROUTE_PROOF_MIN_TOKEN_LENGTH
}

export function routeProofMessage(nonce: string, serverInstanceId: string): string {
  return `${ROUTE_PROOF_PREFIX}${nonce}:${serverInstanceId}`
}

/** Lowercase hex HMAC-SHA256(token, "cos-route-proof:v1:" + nonce + ":" + serverInstanceId). */
export function computeRouteProof(token: string, nonce: string, serverInstanceId: string): string {
  return createHmac('sha256', token).update(routeProofMessage(nonce, serverInstanceId), 'utf8').digest('hex')
}

/** True when the proof is servable right now: switch on, instance id minted, token strong. */
export function routeProofAvailable(input: { token: unknown; serverInstanceId: string | null; env?: NodeJS.ProcessEnv }): boolean {
  return lanFirstEnabled(input.env) && !!input.serverInstanceId && routeProofTokenUsable(input.token)
}

/** `capabilities.routeProof` / `capabilities.lanRoutes`, or nothing. Absent means "do not try". */
export function lanFirstCapabilities(input: { token: unknown; serverInstanceId: string | null; env?: NodeJS.ProcessEnv }): {
  routeProof?: { protocol: number }
  lanRoutes?: { protocol: number }
} {
  if (!lanFirstEnabled(input.env)) return {}
  return {
    ...(routeProofAvailable(input) ? { routeProof: { protocol: ROUTE_PROOF_PROTOCOL } } : {}),
    lanRoutes: { protocol: LAN_ROUTES_PROTOCOL },
  }
}

// ── Rate limit ───────────────────────────────────────────────────────────────

export type RouteProofAdmission = { ok: true } | { ok: false; retryAfterSeconds: number }

/** Sliding one-minute window per remote address, plus a global ceiling. In memory only. */
export class RouteProofRateLimiter {
  private readonly perIp = new Map<string, number[]>()
  private global: number[] = []

  constructor(private readonly now: () => number = () => Date.now()) {}

  admit(remoteAddress: string | undefined | null): RouteProofAdmission {
    const at = this.now()
    const ip = normalizeRemoteIp(remoteAddress ?? '') || 'unknown'
    const live = (times: number[]) => times.filter(t => at - t < ROUTE_PROOF_WINDOW_MS)
    const retry = (oldest: number) => Math.max(1, Math.ceil((ROUTE_PROOF_WINDOW_MS - (at - oldest)) / 1000))

    this.global = live(this.global)
    const recent = live(this.perIp.get(ip) ?? [])
    if (recent.length >= ROUTE_PROOF_IP_LIMIT) {
      this.perIp.set(ip, recent)
      return { ok: false, retryAfterSeconds: retry(recent[0]) }
    }
    if (this.global.length >= ROUTE_PROOF_GLOBAL_LIMIT) {
      // Nothing is stored for a refused address, so a flood of new addresses grows nothing.
      if (recent.length) this.perIp.set(ip, recent)
      return { ok: false, retryAfterSeconds: retry(this.global[0]) }
    }
    recent.push(at)
    this.global.push(at)
    this.perIp.set(ip, recent)
    // Live entries are bounded by the global ceiling, so dropping the idle ones is enough.
    if (this.perIp.size > ROUTE_PROOF_MAX_TRACKED_IPS) {
      for (const [key, times] of this.perIp) if (live(times).length === 0) this.perIp.delete(key)
    }
    return { ok: true }
  }

  /** For tests: how many addresses the limiter is holding. */
  trackedAddressCount(): number {
    return this.perIp.size
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

export interface RouteEntry {
  ip: string
  port: number
  scheme: 'http'
}

export interface LanRoutes {
  v: number
  serverInstanceId: string
  learnedAt: string
  lan: RouteEntry[]
  tailscale: RouteEntry[]
}

type InterfaceInfo = { address: string; family: string | number; internal: boolean }
export type InterfaceTable = Record<string, InterfaceInfo[] | undefined>

/**
 * Interfaces a phone on the home Wi-Fi can never reach through: VPN tunnels (utun is checked
 * separately for Tailscale), Internet Sharing and VM bridges, AirDrop (awdl), low-latency WLAN
 * (llw), VM host-only networks, and Linux container bridges and veth pairs.
 */
const NOT_LAN_INTERFACE = /^(utun|tun|tap|ipsec|ppp|bridge|awdl|llw|vmnet|vboxnet|docker|br-|veth|virbr|lxc|lxd|cni|flannel|podman|cali|vnic|tailscale)/i
/** Tailscale's own interface: utunN on macOS, tailscale0 on Linux, "Tailscale" on Windows. */
const TAILSCALE_INTERFACE = /^(utun|tailscale)/i

function ipv4(info: InterfaceInfo): boolean {
  const family = typeof info.family === 'number' ? (info.family === 4 ? 'IPv4' : 'IPv6') : info.family
  return family === 'IPv4' && !info.internal
}

/**
 * Pure. LAN = RFC1918 IPv4 on a non-internal interface that is not a tunnel, bridge or VM
 * network. Tailscale = 100.64/10 on Tailscale's own interface (a carrier-grade-NAT address
 * on en0 is not Tailscale and is left out). Link-local 169.254/16 is neither. Each list keeps
 * interface order, is de-duplicated, and is capped.
 */
export function buildRouteLists(nets: InterfaceTable, port: number): { lan: RouteEntry[]; tailscale: RouteEntry[] } {
  const lan: RouteEntry[] = []
  const tailscale: RouteEntry[] = []
  const seen = new Set<string>()
  for (const [name, infos] of Object.entries(nets)) {
    for (const info of infos ?? []) {
      if (!info || typeof info.address !== 'string' || !ipv4(info)) continue
      const ip = info.address
      if (seen.has(ip)) continue
      if (isTailscaleIpv4(ip)) {
        if (TAILSCALE_INTERFACE.test(name) && tailscale.length < LAN_ROUTES_MAX_PER_KIND) {
          seen.add(ip)
          tailscale.push({ ip, port, scheme: 'http' })
        }
        continue
      }
      if (isRfc1918Ipv4(ip) && !NOT_LAN_INTERFACE.test(name) && lan.length < LAN_ROUTES_MAX_PER_KIND) {
        seen.add(ip)
        lan.push({ ip, port, scheme: 'http' })
      }
    }
  }
  return { lan, tailscale }
}

let readInterfaces: () => InterfaceTable = () => osNetworkInterfaces() as InterfaceTable
let cache: { at: number; port: number; lists: { lan: RouteEntry[]; tailscale: RouteEntry[] } } | null = null

/**
 * The `routes` field for authenticated /api/models, or null to omit it. Re-read from the
 * interfaces at most every 10 s, so a DHCP change shows up within one cache period. Never
 * throws: a failed interface read omits the field and leaves the rest of the response alone.
 */
export function lanRoutesField(input: {
  port: number
  serverInstanceId: string | null
  env?: NodeJS.ProcessEnv
  now?: () => number
}): LanRoutes | null {
  try {
    if (!lanFirstEnabled(input.env) || !input.serverInstanceId) return null
    const at = (input.now ?? Date.now)()
    if (!cache || cache.port !== input.port || at - cache.at >= LAN_ROUTES_CACHE_MS || at < cache.at) {
      cache = { at, port: input.port, lists: buildRouteLists(readInterfaces(), input.port) }
    }
    return {
      v: LAN_ROUTES_PROTOCOL,
      serverInstanceId: input.serverInstanceId,
      learnedAt: new Date(cache.at).toISOString(),
      lan: cache.lists.lan.map(r => ({ ...r })),
      tailscale: cache.lists.tailscale.map(r => ({ ...r })),
    }
  } catch {
    cache = null
    return null
  }
}

export function __setInterfaceReaderForTests(reader: (() => InterfaceTable) | null): void {
  readInterfaces = reader ?? (() => osNetworkInterfaces() as InterfaceTable)
  cache = null
}
