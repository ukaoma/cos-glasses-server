// Where the 3144 phone-key signer listens, and what its certificate will tell the world
// (review finding 9 / SR-15, lead ruling 2026-11-12 19:50 CST).
//
// THE FINDING. Every listener bound BIND_HOST, default 0.0.0.0, so the signer (the origin that holds the
// phone's passkey ceremony) answered on home Wi-Fi, a hotel LAN and any other interface the Mac had. Its
// origin is https://<node>.<tailnet>.ts.net:3144, which only ever resolves to this Mac's tailnet address,
// so nothing legitimate reaches it any other way. 3141 and 3143 are NOT changed here: phones on the same
// Wi-Fi still use them by design (network-policy.ts).
//
// THE FIX. The signer binds only this Mac's own tailnet addresses (IPv4 100.64.0.0/10 and IPv6
// fd7a:115c:a1e0::/48), one listener per address. No address: it does not open, and
// /api/web-key/status says why (signerBind.reason). Each accepted connection is checked again
// (signerConnectionAllowed): its local address must be one of the bound tailnet addresses AND its remote
// address must be tailnet-range and outside every non-Tailscale interface's subnet. Every 30 s the keeper
// (keepSignerBind) re-reads the interfaces: a bound address that is gone closes the listeners (status
// `address_lost`), and a changed set reopens on the new one.
//
// WHY os.networkInterfaces AND NOT THE TAILSCALE CLI. The CLI under the LaunchAgent needs a hand-built env
// (SHLVL=1, web-key-signer-tls.ts signerTlsCliEnv), can hang or answer "GUI failed to start", is async at a
// point where the listener set is built synchronously, and tells us what Tailscale THINKS its addresses are,
// not what this process can bind. tailnet-self-name.ts already chose the interface table over the CLI for
// the same reasons. The interface table is synchronous, needs no child process and is a plain value a test
// can hand in. (Fix round 1 kept this choice; see the review S1 note below.)
//
// WHICH INTERFACE IS TAILSCALE'S (review PA-R S1, fix round 1). Address ranges prove nothing about who
// configured them: 100.64.0.0/10 is RFC 6598 carrier-grade NAT space a hotspot or rogue DHCP server can hand
// out, and fd7a:115c:a1e0::/48 is a ULA prefix any LAN peer can announce in a Router Advertisement (no RA
// guard on hotel or cafe Wi-Fi), so `en0` can carry BOTH. The first build trusted "carries an fd7a address",
// which a hostile LAN satisfies. What a LAN cannot do is create an interface: on macOS Tailscale's is a
// kernel `utun<N>` tunnel, on Linux tailscaled names its own `tailscale<N>`. So an interface counts only when
//   - it is named utun<N> AND carries BOTH a 100.64/10 IPv4 AND an fd7a:115c:a1e0::/48 IPv6, or
//   - it is named tailscale<N> (Linux).
// Only its tailnet-range addresses are taken. A utun with one family, any en/bridge/awdl interface, and every
// address in those ranges on them are refused. A second local VPN that put both ranges on its own utun would
// pass this test; that needs software installed on this Mac, not a network. If a tailnet ever runs without
// IPv6 on macOS, the signer stays closed and says `no_tailnet_address`: closed, never a wider bind.

import { X509Certificate } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BlockList, type Server, type Socket } from 'node:net'
import { isTailscaleIpv4, isTailscaleIpv6 } from './network-policy.js'
import { webKeyRpId } from './web-key-origin.js'

/**
 * The integer COS Control gates its Phone approvals On row on. 1: the signer binds tailnet addresses only
 * and status carries signerBind and certDisclosure. Absent on servers before this fix.
 */
export const SIGNER_BIND_FIX_VERSION = 1

/** `all` is the old servers' wildcard meaning; this server never reports it. */
export type SignerBindScope = 'tailnet' | 'all' | 'none'
export type SignerBindReason =
  /** No interface carries a Tailscale address right now (Tailscale off, logged out, or not installed). */
  | 'no_tailnet_address'
  /** BIND_HOST names an address that is not one of this Mac's tailnet addresses (e.g. 127.0.0.1). */
  | 'bind_host_not_tailnet'
  /** No mkcert pair in server/certs, so no https listener at all (listener-startup.ts listenerPlan). */
  | 'https_unavailable'
  /** The signer was listening and a bound address left the Tailscale interface; listeners closed (review S4). */
  | 'address_lost'
  /** A tailnet address exists but binding it failed (e.g. the port is held); tried again every rescan. */
  | 'listen_failed'

export interface SignerBindPlan {
  scope: 'tailnet' | 'none'
  /** The exact addresses the signer binds (or would bind), IPv4 first. Empty when scope is `none`. */
  addresses: string[]
  /** Null when scope is `tailnet`. */
  reason: SignerBindReason | null
}

type InterfaceInfo = { address: string; family: string | number; internal: boolean; cidr?: string | null }
export type InterfaceTable = Record<string, InterfaceInfo[] | undefined>

/** Lower case, IPv4-mapped prefix and IPv6 zone dropped. */
export function normalizeBindAddress(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '').replace(/%.*$/, '')
}

/** IPv4 100.64.0.0/10 or IPv6 fd7a:115c:a1e0::/48. Range only: says nothing about which interface has it. */
export function isTailnetAddress(value: unknown): boolean {
  const addr = normalizeBindAddress(value)
  if (!addr) return false
  return addr.includes(':') ? isTailscaleIpv6(addr) : isTailscaleIpv4(addr)
}

const familyOf = (info: InterfaceInfo): 'IPv4' | 'IPv6' | null => {
  if (info.family === 4 || info.family === 'IPv4') return 'IPv4'
  if (info.family === 6 || info.family === 'IPv6') return 'IPv6'
  return null
}

const MAC_TUNNEL = /^utun\d+$/
const LINUX_TAILSCALE = /^tailscale\d*$/

/**
 * Whether this interface is Tailscale's (review S1): a macOS utun<N> carrying BOTH a 100.64/10 IPv4 and an
 * fd7a:115c:a1e0::/48 IPv6, or a Linux tailscale<N>. Never decided by address ranges alone.
 */
export function isTailscaleInterface(name: string, infos: InterfaceInfo[] | undefined): boolean {
  if (LINUX_TAILSCALE.test(name)) return true
  if (!MAC_TUNNEL.test(name)) return false
  const list = (infos ?? []).filter(info => info && !info.internal)
  const hasV4 = list.some(info => familyOf(info) === 'IPv4' && isTailscaleIpv4(normalizeBindAddress(info.address)))
  const hasV6 = list.some(info => familyOf(info) === 'IPv6' && isTailscaleIpv6(normalizeBindAddress(info.address)))
  return hasV4 && hasV6
}

/**
 * This Mac's own tailnet addresses from the interface table: the tailnet-range addresses of Tailscale's own
 * interface(s) (isTailscaleInterface). IPv4 first, then IPv6, each in table order, no duplicates.
 */
export function tailnetInterfaceAddresses(nets: InterfaceTable): string[] {
  const v4: string[] = []
  const v6: string[] = []
  for (const [name, infos] of Object.entries(nets)) {
    if (!isTailscaleInterface(name, infos)) continue
    const list = (infos ?? []).filter(info => info && !info.internal)
    for (const info of list) {
      const addr = normalizeBindAddress(info.address)
      const family = familyOf(info)
      if (family === 'IPv4' && isTailscaleIpv4(addr)) { if (!v4.includes(addr)) v4.push(addr) }
      else if (family === 'IPv6' && isTailscaleIpv6(addr)) { if (!v6.includes(addr)) v6.push(addr) }
    }
  }
  return [...v4, ...v6]
}

/**
 * The subnets of every interface that is NOT Tailscale's (review S2; loopback included, harmless). A remote address inside one of
 * them is on-link through that interface, so a packet "from" it may have come from the LAN, not the tailnet:
 * the weak host model can deliver a LAN packet addressed to the utun address. Null when nothing to check.
 */
export function nonTailscaleSubnets(nets: InterfaceTable): BlockList | null {
  const list = new BlockList()
  let any = false
  for (const [name, infos] of Object.entries(nets)) {
    if (isTailscaleInterface(name, infos)) continue
    for (const info of infos ?? []) {
      if (!info || typeof info.cidr !== 'string') continue
      const [net, bits] = info.cidr.split('/')
      const prefix = Number(bits)
      const family = familyOf(info)
      const addr = normalizeBindAddress(net)
      if (!addr || !Number.isInteger(prefix) || !family) continue
      try { list.addSubnet(addr, prefix, family === 'IPv4' ? 'ipv4' : 'ipv6'); any = true } catch { /* malformed row: skip */ }
    }
  }
  return any ? list : null
}

const WILDCARD_BIND = new Set(['', '0.0.0.0', '::'])

/**
 * Where the signer binds this boot. `bindHost` is process.env.BIND_HOST: unset or a wildcard means "the
 * tailnet addresses found now"; a specific address is honoured only when it is one of them (an operator
 * who set BIND_HOST=127.0.0.1 asked for less exposure, never for the signer on the tailnet).
 */
export function planSignerBind(opts: { nets: InterfaceTable; bindHost: string | undefined; httpsAvailable: boolean }): SignerBindPlan {
  if (!opts.httpsAvailable) return { scope: 'none', addresses: [], reason: 'https_unavailable' }
  const found = tailnetInterfaceAddresses(opts.nets)
  const host = normalizeBindAddress(opts.bindHost ?? '')
  if (!WILDCARD_BIND.has(host)) {
    if (!isTailnetAddress(host)) return { scope: 'none', addresses: [], reason: 'bind_host_not_tailnet' }
    if (!found.includes(host)) return { scope: 'none', addresses: [], reason: 'no_tailnet_address' }
    return { scope: 'tailnet', addresses: [host], reason: null }
  }
  if (found.length === 0) return { scope: 'none', addresses: [], reason: 'no_tailnet_address' }
  return { scope: 'tailnet', addresses: found, reason: null }
}

/**
 * Whether a connection may be served by the signer:
 *   - its LOCAL address is tailnet-range and one of the bound addresses, and
 *   - its REMOTE address is tailnet-range and not inside any non-Tailscale interface's subnet (review S2).
 * `nets` is read per connection (os.networkInterfaces is cheap), so a LAN joined later is seen at once.
 */
export function signerConnectionAllowed(localAddress: unknown, remoteAddress: unknown, bound: readonly string[], nets: InterfaceTable): boolean {
  const local = normalizeBindAddress(localAddress)
  if (!isTailnetAddress(local) || !bound.includes(local)) return false
  const remote = normalizeBindAddress(remoteAddress)
  if (!isTailnetAddress(remote)) return false
  const onLink = nonTailscaleSubnets(nets)
  if (onLink && onLink.check(remote, remote.includes(':') ? 'ipv6' : 'ipv4')) return false
  return true
}

/**
 * Defense in depth on each signer server: a connection that signerConnectionAllowed refuses is destroyed
 * before any byte is read. Registered after the server's own (TLS) connection listener, so the TLS wrapper
 * sees an ordinary close. Returns the count of refusals so far (for logs and tests).
 */
export function guardSignerConnections(
  server: Server,
  bound: readonly string[],
  opts: { nets: () => InterfaceTable; allowed?: (localAddress: unknown, remoteAddress: unknown) => boolean; log?: (line: string) => void },
): () => number {
  const allowed = opts.allowed ?? ((local: unknown, remote: unknown) => signerConnectionAllowed(local, remote, bound, opts.nets()))
  let refused = 0
  server.on('connection', (socket: Socket) => {
    let ok = false
    try { ok = allowed(socket.localAddress, socket.remoteAddress) === true } catch { ok = false }
    if (ok) return
    refused++
    // First refusal and then every hundredth, so a LAN scanner cannot fill the log.
    if (refused === 1 || refused % 100 === 0) opts.log?.(`[web-key-signer] refused a 3144 connection that is not tailnet to tailnet (${refused} so far)`)
    socket.destroy()
  })
  return () => refused
}

export interface SignerBindStatus {
  scope: SignerBindScope
  addresses: string[]
  reason: SignerBindReason | null
  /** True only while the signer is actually bound (authority mode, at least one listener up). */
  listening: boolean
}

/**
 * What /api/web-key/status reports. `listening` comes from the real servers; the rest from the plan
 * (the boot plan when the signer is planned, otherwise a fresh read of where it WOULD bind if turned on).
 */
export function signerBindStatus(plan: SignerBindPlan, listening: boolean): SignerBindStatus {
  return { scope: plan.scope, addresses: [...plan.addresses], reason: plan.reason, listening: plan.scope === 'tailnet' && listening }
}

export interface CertDisclosure {
  /**
   * True when this server's signer TLS store (the `web-key-tls` data folder, shared with 3143's ts.net
   * certificate) holds a certificate for this Mac's tailnet name. It cannot see certificates other tools
   * asked for (`tailscale cert` in Terminal, `tailscale serve`), so false means "this server has not
   * requested one", never "the name is not in any public log".
   */
  issued: boolean
  /** The exact name `tailscale cert` is asked for, and so the name written to public CT logs. Null: unknown. */
  publicName: string | null
}

const STORED_CERT_MAX_BYTES = 64 * 1024

/**
 * Read-only: never calls Tailscale and never writes. `certFile` is <dir>/tailscale-cert.pem
 * (web-key-signer-tls.ts SIGNER_TLS_CERT_FILE). A missing, oversized or unparseable file is "not issued";
 * a parseable certificate counts when it covers `publicName`, or, with the name unknown, when it covers
 * any ts.net name.
 */
export function readCertDisclosure(opts: { dir: string; certFile: string; selfDnsName: string | null }): CertDisclosure {
  const publicName = webKeyRpId(opts.selfDnsName)
  let issued = false
  try {
    const path = join(opts.dir, opts.certFile)
    const st = statSync(path)
    if (st.isFile() && st.size > 0 && st.size <= STORED_CERT_MAX_BYTES) {
      const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(readFileSync(path, 'utf8'))?.[0]
      if (pem) {
        const leaf = new X509Certificate(pem)
        issued = publicName ? leaf.checkHost(publicName) !== undefined : /DNS:[^,]*\.ts\.net\b/i.test(leaf.subjectAltName ?? '')
      }
    }
  } catch { issued = false }
  return { issued, publicName }
}

/** How often the keeper re-reads the interfaces (a synchronous table read, no child process). */
export const SIGNER_BIND_RESCAN_MS = 30_000

export type BindTimer = { cancel: () => void }
const defaultBindSchedule = (fn: () => void, ms: number): BindTimer => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return { cancel: () => clearTimeout(t) }
}

const sameAddresses = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every(x => b.includes(x))

/**
 * Keeps the signer bound to exactly this Mac's current tailnet addresses, every SIGNER_BIND_RESCAN_MS:
 *   - not open and a tailnet plan appears (the login race): open it;
 *   - open and the plan still names the same addresses with a live listener: nothing;
 *   - open and anything else (an address gone, the set changed, the listener dead, review S4): close every
 *     signer listener first, then open the new plan if there is one. Until a later open succeeds, status
 *     says `address_lost` instead of claiming a listener on a dead address.
 * `open` binds exactly the plan's addresses and resolves true when every one listens; false (EADDRINUSE)
 * means try again next time. A plan that is not `tailnet` is never opened. `status()` is what
 * /api/web-key/status reports.
 */
export function keepSignerBind(opts: {
  /** The boot plan. `tailnet`: index.ts already queued its listeners (REQUIRED) and they count as bound. */
  initial: SignerBindPlan
  plan: () => SignerBindPlan
  open: (plan: SignerBindPlan) => Promise<boolean>
  close: () => Promise<void>
  listening: () => boolean
  schedule?: (fn: () => void, ms: number) => BindTimer
  intervalMs?: number
  log?: (line: string) => void
}): { stop: () => void; status: () => SignerBindPlan } {
  const schedule = opts.schedule ?? defaultBindSchedule
  const interval = opts.intervalMs ?? SIGNER_BIND_RESCAN_MS
  const none = (reason: SignerBindReason): SignerBindPlan => ({ scope: 'none', addresses: [], reason })
  let bound: SignerBindPlan | null = opts.initial.scope === 'tailnet' ? opts.initial : null
  let shown: SignerBindPlan = opts.initial
  let lost = false
  let timer: BindTimer | null = null
  let stopped = false
  const tick = async (): Promise<void> => {
    timer = null
    if (stopped) return
    let cur: SignerBindPlan
    try { cur = opts.plan() } catch { cur = none('no_tailnet_address') }
    const curTailnet = cur.scope === 'tailnet' && cur.addresses.length > 0
    if (bound) {
      let alive = false
      try { alive = opts.listening() === true } catch { alive = false }
      if (curTailnet && sameAddresses(cur.addresses, bound.addresses) && alive) {
        shown = bound
      } else {
        try { await opts.close() } catch { /* the servers are dropped either way */ }
        opts.log?.(`[web-key-signer] 3144 closed: the tailnet address set changed or a listener died (was ${bound.addresses.join(', ')})`)
        bound = null
        lost = true
        shown = none('address_lost')
      }
    }
    if (!bound && !stopped) {
      if (curTailnet) {
        let ok = false
        try { ok = await opts.open(cur) } catch { ok = false }
        if (ok) {
          bound = cur
          shown = cur
          lost = false
          opts.log?.(`[web-key-signer] 3144 opened on the tailnet address${cur.addresses.length > 1 ? 'es' : ''} ${cur.addresses.join(', ')}`)
        } else if (!lost) {
          shown = none('listen_failed')
        }
      } else if (!lost) {
        shown = cur
      }
    }
    if (!stopped) timer = schedule(() => { void tick() }, interval)
  }
  timer = schedule(() => { void tick() }, interval)
  return {
    stop: () => { stopped = true; timer?.cancel(); timer = null },
    status: () => shown,
  }
}
