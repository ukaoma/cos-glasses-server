// This Mac's own Tailscale MagicDNS name, for COS Control Web's origin checks.
//
// WHY NOT THE TAILSCALE CLI. Under the server's LaunchAgent the `tailscale status --json` call
// the nudger makes does not answer (server.log: "trigger=boot dropped: Tailscale did not answer
// for 120s"), so the nudger never learns Self.DNSName and a phone at
// http://<mac>.<tailnet>.ts.net:3141/control was refused by CORS on every write (6.99.1).
// MagicDNS itself answers a reverse lookup of this Mac's own 100.x address at 100.100.100.100
// in about a millisecond, with no CLI involved. The nudger's answer still wins when it has one.
//
// EXACT NAME ONLY. The answer is normalised by normalizeTailscaleDnsName (lowercase, one
// trailing dot dropped, must end in .ts.net) and compared for equality; never a suffix match.
// No answer means no name: the tailnet NAME is refused and the tailnet IP URL keeps working.

import { Resolver } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'
import { normalizeTailscaleDnsName, reachableIpv4Addresses } from './network-policy.js'

export const TAILNET_NAME_HIT_TTL_MS = 10 * 60_000
export const TAILNET_NAME_MISS_TTL_MS = 60_000
export const TAILNET_REVERSE_TIMEOUT_MS = 1_500
const MAGIC_DNS_RESOLVER = '100.100.100.100'

export interface TailnetSelfNameDeps {
  /** The nudger's own reading, preferred whenever it has one. */
  nudgerName?: () => string | null
  /** This Mac's Tailscale IPv4, or null when Tailscale is not up. */
  tailscaleIpv4?: () => string | null
  /** PTR lookup of an address; names may carry a trailing dot. */
  reverse?: (ip: string) => Promise<string[]>
  now?: () => number
}

export interface TailnetSelfName {
  /** The name known right now, without waiting. */
  currentSelfDnsName(): string | null
  /** Look the name up (single-flight, cached); resolves to the name or null. Never throws. */
  refresh(): Promise<string | null>
  /** `SelfDnsSource` for isAllowedCorsOrigin: same as refresh(). */
  queryStatus(): Promise<string | null>
}

function defaultTailscaleIpv4(): string | null {
  return reachableIpv4Addresses(networkInterfaces()).find(a => a.kind === 'tailscale')?.address ?? null
}

function defaultReverse(ip: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: TAILNET_REVERSE_TIMEOUT_MS, tries: 1 })
  resolver.setServers([MAGIC_DNS_RESOLVER])
  return resolver.reverse(ip)
}

export function createTailnetSelfName(deps: TailnetSelfNameDeps = {}): TailnetSelfName {
  const now = deps.now ?? (() => Date.now())
  const ipv4 = deps.tailscaleIpv4 ?? defaultTailscaleIpv4
  const reverse = deps.reverse ?? defaultReverse
  let cached: { name: string | null; at: number } | null = null
  let inflight: Promise<string | null> | null = null

  const fromNudger = (): string | null => {
    try { return normalizeTailscaleDnsName(deps.nudgerName?.() ?? null) } catch { return null }
  }

  const currentSelfDnsName = (): string | null => fromNudger() ?? cached?.name ?? null

  const refresh = (): Promise<string | null> => {
    const known = fromNudger()
    if (known) return Promise.resolve(known)
    const at = now()
    if (cached && at - cached.at < (cached.name ? TAILNET_NAME_HIT_TTL_MS : TAILNET_NAME_MISS_TTL_MS)) {
      return Promise.resolve(cached.name)
    }
    if (inflight) return inflight
    inflight = (async () => {
      let name: string | null = null
      try {
        const ip = ipv4()
        if (ip) {
          const names = await reverse(ip)
          name = names.map(n => normalizeTailscaleDnsName(n)).find((n): n is string => n !== null) ?? null
        }
      } catch {
        name = null
      }
      // A miss never erases a name we already had: a blip in MagicDNS must not lock the phone out.
      cached = { name: name ?? cached?.name ?? null, at: now() }
      return cached.name
    })().finally(() => { inflight = null })
    return inflight
  }

  return { currentSelfDnsName, refresh, queryStatus: refresh }
}

let singleton: TailnetSelfName | null = null
/** index.ts installs the server's instance, wired to its nudger. */
export function installTailnetSelfName(deps: TailnetSelfNameDeps): TailnetSelfName {
  singleton = createTailnetSelfName(deps)
  return singleton
}
export function getTailnetSelfName(): TailnetSelfName {
  if (!singleton) singleton = createTailnetSelfName()
  return singleton
}
