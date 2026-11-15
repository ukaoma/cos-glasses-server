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
// /api/web-key/status says why (signerBind.reason). Each accepted connection is checked again by its
// local address (signerConnectionAllowed) and destroyed if that is not one of the bound tailnet
// addresses, so a later edit back to a wildcard bind still cannot serve a LAN caller.
//
// WHY os.networkInterfaces AND NOT THE TAILSCALE CLI. The CLI under the LaunchAgent needs a hand-built env
// (SHLVL=1, web-key-signer-tls.ts signerTlsCliEnv), can hang or answer "GUI failed to start", is async at a
// point where the listener set is built synchronously, and tells us what Tailscale THINKS its addresses are,
// not what this process can bind. tailnet-self-name.ts already chose the interface table over the CLI for
// the same reasons. The interface table is synchronous, needs no child process and is a plain value a test
// can hand in.
//
// WHY A 100.64/10 ADDRESS ALONE IS NOT ENOUGH. 100.64.0.0/10 is also RFC 6598 carrier-grade NAT space:
// a phone hotspot or a CGNAT ISP can give the Wi-Fi interface a 100.x address. Binding that would put the
// signer on the hotspot network, the exact exposure SR-15 is about. So an interface counts as the tailnet
// interface only when it ALSO carries an address in fd7a:115c:a1e0::/48, Tailscale's own IPv6 prefix that
// no ISP hands out, or when it is named `tailscale*` (Linux tailscaled's own interface). A 100.x address
// on any other interface is refused. If a tailnet ever runs without IPv6 addresses on macOS, the signer
// stays closed and says `no_tailnet_address`: the failure is closed, never a wider bind.

import { X509Certificate } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Server, Socket } from 'node:net'
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

export interface SignerBindPlan {
  scope: 'tailnet' | 'none'
  /** The exact addresses the signer binds (or would bind), IPv4 first. Empty when scope is `none`. */
  addresses: string[]
  /** Null when scope is `tailnet`. */
  reason: SignerBindReason | null
}

type InterfaceInfo = { address: string; family: string | number; internal: boolean }
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

/**
 * This Mac's own tailnet addresses from the interface table: every tailnet-range address on an interface
 * that is provably Tailscale's (it carries an fd7a:115c:a1e0::/48 address, or it is named `tailscale*`).
 * IPv4 first, then IPv6, each in table order, no duplicates.
 */
export function tailnetInterfaceAddresses(nets: InterfaceTable): string[] {
  const v4: string[] = []
  const v6: string[] = []
  for (const [name, infos] of Object.entries(nets)) {
    const list = (infos ?? []).filter(info => info && !info.internal)
    const tailscaleInterface = name.startsWith('tailscale')
      || list.some(info => familyOf(info) === 'IPv6' && isTailscaleIpv6(normalizeBindAddress(info.address)))
    if (!tailscaleInterface) continue
    for (const info of list) {
      const addr = normalizeBindAddress(info.address)
      const family = familyOf(info)
      if (family === 'IPv4' && isTailscaleIpv4(addr)) { if (!v4.includes(addr)) v4.push(addr) }
      else if (family === 'IPv6' && isTailscaleIpv6(addr)) { if (!v6.includes(addr)) v6.push(addr) }
    }
  }
  return [...v4, ...v6]
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

/** Whether a connection that arrived on `localAddress` may be served by the signer. */
export function signerConnectionAllowed(localAddress: unknown, bound: readonly string[]): boolean {
  const addr = normalizeBindAddress(localAddress)
  return isTailnetAddress(addr) && bound.includes(addr)
}

/**
 * Defense in depth on each signer server: a connection whose local address is not one of `bound` is
 * destroyed before any byte is read. Registered after the server's own (TLS) connection listener, so the
 * TLS wrapper sees an ordinary close. Returns the count of refusals so far (for logs and tests).
 */
export function guardSignerConnections(
  server: Server,
  bound: readonly string[],
  opts: { allowed?: (localAddress: unknown) => boolean; log?: (line: string) => void } = {},
): () => number {
  const allowed = opts.allowed ?? ((addr: unknown) => signerConnectionAllowed(addr, bound))
  let refused = 0
  server.on('connection', (socket: Socket) => {
    let ok = false
    try { ok = allowed(socket.localAddress) === true } catch { ok = false }
    if (ok) return
    refused++
    // First refusal and then every hundredth, so a LAN scanner cannot fill the log.
    if (refused === 1 || refused % 100 === 0) opts.log?.(`[web-key-signer] refused a 3144 connection on a non-tailnet address (${refused} so far)`)
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

/** How often a signer that found no tailnet address at boot looks again. */
export const SIGNER_BIND_RESCAN_MS = 30_000

export type BindTimer = { cancel: () => void }
const defaultBindSchedule = (fn: () => void, ms: number): BindTimer => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return { cancel: () => clearTimeout(t) }
}

/**
 * The login race: the server's LaunchAgent can start before the Tailscale app has its address up. A signer
 * planned with no tailnet address looks again every SIGNER_BIND_RESCAN_MS (a synchronous interface read,
 * no child process) and opens once an address appears. `open` binds exactly the plan's addresses and
 * resolves true when every one is listening; false (e.g. EADDRINUSE) means try again next time. It never
 * widens the bind: a plan that is not `tailnet` is never opened.
 */
export function openSignerWhenTailnetAppears(opts: {
  plan: () => SignerBindPlan
  open: (plan: SignerBindPlan) => Promise<boolean>
  schedule?: (fn: () => void, ms: number) => BindTimer
  intervalMs?: number
  log?: (line: string) => void
}): { stop: () => void; opened: () => boolean } {
  const schedule = opts.schedule ?? defaultBindSchedule
  const interval = opts.intervalMs ?? SIGNER_BIND_RESCAN_MS
  let timer: BindTimer | null = null
  let stopped = false
  let opened = false
  const tick = async (): Promise<void> => {
    timer = null
    if (stopped || opened) return
    let plan: SignerBindPlan | null = null
    try { plan = opts.plan() } catch { plan = null }
    if (plan && plan.scope === 'tailnet' && plan.addresses.length > 0) {
      let ok = false
      try { ok = await opts.open(plan) } catch { ok = false }
      if (ok) {
        opened = true
        opts.log?.(`[web-key-signer] 3144 opened late on the tailnet address${plan.addresses.length > 1 ? 'es' : ''} ${plan.addresses.join(', ')}`)
        return
      }
    }
    if (!stopped) timer = schedule(() => { void tick() }, interval)
  }
  timer = schedule(() => { void tick() }, interval)
  return {
    stop: () => { stopped = true; timer?.cancel(); timer = null },
    opened: () => opened,
  }
}
