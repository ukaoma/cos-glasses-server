// This Mac's own Tailscale MagicDNS name, for COS Control Web's origin checks.
//
// WHY NOT THE TAILSCALE CLI. Under the server's LaunchAgent the `tailscale status --json` call
// the nudger makes fails: node passes its child no SHLVL, and the macOS CLI then answers "The
// Tailscale GUI failed to start" instead of the JSON (probe 2026-11-10; server.log's "Tailscale did
// not answer for 120s" is the event's age, not a hang). So the nudger never learns Self.DNSName and a phone at
// http://<mac>.<tailnet>.ts.net:3141/control was refused by CORS on every write (6.99.1).
// MagicDNS itself answers a reverse lookup of this Mac's own 100.x address at 100.100.100.100
// in about a millisecond, with no CLI involved. The nudger's answer still wins when it has one.
//
// EXACT NAME ONLY. The answer is normalised by normalizeTailscaleDnsName (lowercase, one
// trailing dot dropped, must end in .ts.net) and compared for equality; never a suffix match.
// No answer means no name: the tailnet NAME is refused and the tailnet IP URL keeps working.
//
// A MISS IS NOT FINAL (7.0.14). The boot lookup can miss (a startup race), and readers that only
// call currentSelfDnsName() then saw null forever: /api/web-key/status answered `origin: null` (COS
// Control hid Phone approvals) and the 3144 signer refused every phone write `origin_refused`, until
// some other route happened to call refresh(). refreshIfMissing() is for exactly those readers: with
// a name known it returns it and looks nothing up; with none it joins the lookup in flight or starts
// ONE, at most once per TAILNET_NAME_ON_DEMAND_MIN_MS, and waits at most a bounded time.

import { Resolver } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'
import { normalizeTailscaleDnsName, reachableIpv4Addresses } from './network-policy.js'

export const TAILNET_NAME_HIT_TTL_MS = 10 * 60_000
export const TAILNET_NAME_MISS_TTL_MS = 60_000
export const TAILNET_REVERSE_TIMEOUT_MS = 1_500
/** refreshIfMissing(): while the name is unknown, at most one lookup it starts per this window. */
export const TAILNET_NAME_ON_DEMAND_MIN_MS = 30_000
/** refreshIfMissing(): the longest a request waits for that lookup (the lookup itself is bounded by the resolver timeout). */
export const TAILNET_NAME_ON_DEMAND_WAIT_MS = 2_000
const MAGIC_DNS_RESOLVER = '100.100.100.100'
/**
 * 7.0.53 (the boot race; X1's option i): when phone approvals would arm, boot retries the name this many times, each a fresh lookup
 * (past the miss caches) waited at most `waitMs`, `gapMs` apart, before the one arming decision. Same local source only (the nudger,
 * then this Mac's Tailscale IPv4 at MagicDNS). The total stays under Control's readiness deadline (D4).
 */
export const TAILNET_BOOT_WAIT = { attempts: 6, waitMs: 1_500, gapMs: 1_000 } as const

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
  /**
   * For a request that must not act on a stale miss (7.0.14). A name known now: that name, no lookup.
   * None: joins the lookup in flight, or starts one unless this method started one in the last
   * TAILNET_NAME_ON_DEMAND_MIN_MS (then null at once). Waits at most `waitMs`; a slower lookup keeps
   * running and caches its answer for the next reader. Never throws.
   */
  refreshIfMissing(waitMs?: number): Promise<string | null>
  /** 7.0.53: a name known now, or one fresh lookup (joining one in flight), past every cache, waited at most `waitMs`. Never throws. */
  lookupNow?(waitMs: number): Promise<string | null>
  /**
   * X1 (7.0.42): why the last lookup found no name, or null after a hit (or before any lookup). Optional so
   * hand-made fakes need not carry it. Never a name or an address.
   */
  lastMiss?(): TailnetNameMiss | null
}

/**
 * Why a lookup found no name. `no_answer` is MagicDNS giving none within TAILNET_REVERSE_TIMEOUT_MS, which is also what
 * a busy event loop produces: at boot the lookup is sent before the server's synchronous startup work, and with the
 * loop blocked 2 s or more the answer arrives after the timer and the lookup fails ENOTFOUND (probe 2026-11-14 14:5x,
 * 7.0.41 on his Mac: 1 ms unblocked, ENOTFOUND blocked 2 s and 4 s). That miss is cached TAILNET_NAME_MISS_TTL_MS.
 */
export type TailnetNameMiss = 'no_tailscale_ip' | 'no_answer' | 'not_ts_net'

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
  let miss: TailnetNameMiss | null = null

  const fromNudger = (): string | null => {
    try { return normalizeTailscaleDnsName(deps.nudgerName?.() ?? null) } catch { return null }
  }

  const currentSelfDnsName = (): string | null => fromNudger() ?? cached?.name ?? null

  // The one lookup (single-flight): every caller below shares the promise in flight.
  const lookup = (): Promise<string | null> => {
    if (inflight) return inflight
    inflight = (async () => {
      let name: string | null = null
      let why: TailnetNameMiss | null = null
      try {
        const ip = ipv4()
        if (ip) {
          const names = await reverse(ip)
          name = names.map(n => normalizeTailscaleDnsName(n)).find((n): n is string => n !== null) ?? null
          if (!name) why = names.length ? 'not_ts_net' : 'no_answer'
        } else {
          why = 'no_tailscale_ip'
        }
      } catch {
        name = null
        why = 'no_answer'
      }
      // A miss never erases a name we already had: a blip in MagicDNS must not lock the phone out.
      cached = { name: name ?? cached?.name ?? null, at: now() }
      miss = cached.name ? null : why
      return cached.name
    })().finally(() => { inflight = null })
    return inflight
  }

  const refresh = (): Promise<string | null> => {
    const known = fromNudger()
    if (known) return Promise.resolve(known)
    const at = now()
    if (cached && at - cached.at < (cached.name ? TAILNET_NAME_HIT_TTL_MS : TAILNET_NAME_MISS_TTL_MS)) {
      return Promise.resolve(cached.name)
    }
    return lookup()
  }

  // When refreshIfMissing() last STARTED a lookup. Its own clock: the boot lookup and refresh()'s TTL
  // do not count, so the first reader after a boot miss looks again at once.
  let onDemandAt: number | null = null
  const refreshIfMissing = (waitMs: number = TAILNET_NAME_ON_DEMAND_WAIT_MS): Promise<string | null> => {
    const known = currentSelfDnsName()
    if (known) return Promise.resolve(known)
    let pending: Promise<string | null>
    if (inflight) {
      pending = inflight
    } else {
      const at = now()
      if (onDemandAt !== null && at - onDemandAt < TAILNET_NAME_ON_DEMAND_MIN_MS) return Promise.resolve(null)
      onDemandAt = at
      pending = lookup()
    }
    const wait = Math.max(0, waitMs)
    return new Promise<string | null>(resolve => {
      const timer = setTimeout(() => resolve(null), wait)
      timer.unref?.()
      pending.then(name => { clearTimeout(timer); resolve(name) }, () => { clearTimeout(timer); resolve(null) })
    })
  }

  const lookupNow = (waitMs: number): Promise<string | null> => {
    const known = currentSelfDnsName()
    if (known) return Promise.resolve(known)
    const pending = lookup()
    return new Promise<string | null>(resolve => {
      const timer = setTimeout(() => resolve(null), Math.max(0, waitMs))
      timer.unref?.()
      pending.then(name => { clearTimeout(timer); resolve(name) }, () => { clearTimeout(timer); resolve(null) })
    })
  }

  return { currentSelfDnsName, refresh, queryStatus: refresh, refreshIfMissing, lookupNow, lastMiss: () => (currentSelfDnsName() ? null : miss) }
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

/**
 * 7.0.53: the bounded boot wait for the name (TAILNET_BOOT_WAIT). Returns the name or null, how long it waited and how many
 * lookups it made. Never throws; never more than `attempts` lookups.
 */
export async function awaitTailnetNameAtBoot(
  self: Pick<TailnetSelfName, 'currentSelfDnsName' | 'lookupNow'>,
  opts: { attempts: number; waitMs: number; gapMs: number } = TAILNET_BOOT_WAIT,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ name: string | null; waitedMs: number; attempts: number }> {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => { const t = setTimeout(r, ms); t.unref?.() }))
  const start = now()
  let made = 0
  for (let i = 0; i < opts.attempts; i++) {
    const known = self.currentSelfDnsName()
    if (known) return { name: known, waitedMs: now() - start, attempts: made }
    if (!self.lookupNow) break
    made++
    let name: string | null = null
    try { name = await self.lookupNow(opts.waitMs) } catch { name = null }
    if (name) return { name, waitedMs: now() - start, attempts: made }
    if (i < opts.attempts - 1) await sleep(opts.gapMs)
  }
  return { name: self.currentSelfDnsName(), waitedMs: now() - start, attempts: made }
}
