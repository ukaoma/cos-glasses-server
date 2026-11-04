/** Network ranges accepted by the public server before API-token auth runs. */

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map(part => Number(part))
  if (octets.some((octet, index) => !/^\d{1,3}$/.test(parts[index]) || octet < 0 || octet > 255)) {
    return null
  }
  return octets
}

export function normalizeRemoteIp(value: string): string {
  return value.replace(/^::ffff:/, '')
}

export function isTailscaleIpv4(value: string): boolean {
  const octets = parseIpv4(normalizeRemoteIp(value))
  return !!octets && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
}

/** Tailscale IPv6 ULA range: fd7a:115c:a1e0::/48. */
export function isTailscaleIpv6(value: string): boolean {
  const clean = normalizeRemoteIp(value).trim().toLowerCase()
  return clean.startsWith('fd7a:115c:a1e0:')
}

export function isAllowedNetworkIp(value: string): boolean {
  const clean = normalizeRemoteIp(value)
  if (clean === '127.0.0.1' || clean === '::1') return true
  if (isTailscaleIpv4(clean) || isTailscaleIpv6(clean)) return true

  const octets = parseIpv4(clean)
  if (!octets) return false
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
}

/**
 * Normalize a Tailscale MagicDNS hostname (`Self.DNSName` from `tailscale status --json`).
 * Strips one trailing dot, lowercases, and requires a strict `<node>.<tailnet>.ts.net` shape.
 */
export function normalizeTailscaleDnsName(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '')
  if (!trimmed || trimmed.length > 253) return null
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\.ts\.net$/.test(trimmed)) {
    return null
  }
  return trimmed
}

export interface AllowedOriginOptions {
  /** The Mac's own verified `Self.DNSName` from `tailscale status --json`. Never a suffix wildcard. */
  selfDnsName?: string | null
  /**
   * When set, any explicit port in `origin` must match one of these numbers (e.g. `[3141, 3143]`).
   * Prevents another server on the same host (`localhost:8080`, `<mac>.ts.net:8080`) from passing
   * CORS or riding a host-scoped cookie session.
   */
  allowedPorts?: readonly number[]
}

export function isAllowedNetworkOrigin(origin: string, options: AllowedOriginOptions = {}): boolean {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const selfDns = normalizeTailscaleDnsName(options.selfDnsName)
    const hostAllowed = host === 'localhost'
      || isAllowedNetworkIp(host)
      || (selfDns !== null && host === selfDns)
    if (!hostAllowed) return false

    if (options.allowedPorts && options.allowedPorts.length > 0) {
      const effectivePort = url.port
        ? Number(url.port)
        : (url.protocol === 'https:' ? 443 : 80)
      if (!Number.isInteger(effectivePort) || !options.allowedPorts.includes(effectivePort)) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

/** True for RFC1918 private IPv4 (10/8, 172.16/12, 192.168/16). */
export function isRfc1918Ipv4(value: string): boolean {
  const octets = parseIpv4(normalizeRemoteIp(value))
  if (!octets) return false
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
}

/** Loopback in every form a Node socket reports it: 127.0.0.0/8, ::1, ::ffff:127.x. */
export function isLoopbackAddress(value: string | undefined | null): boolean {
  const address = value ?? ''
  return address === '::1' || address === '127.0.0.1'
    || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

const PROXY_FORWARDED_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-user-profile-pic',
  'tailscale-headers-info',
] as const

/**
 * True if a request carries reverse-proxy or `tailscale serve` headers.
 * A local proxy (like `tailscale serve --bg 3141`) connects over `127.0.0.1`, so
 * `isLoopbackSocket` must refuse any request carrying proxy headers to prevent remote
 * tailnet peers from masquerading as the Mac owner on `loopbackOnly` / `macOnly` routes.
 */
export function hasProxyForwardedHeaders(headers: Record<string, unknown> | undefined | null): boolean {
  if (!headers || typeof headers !== 'object') return false
  for (const name of PROXY_FORWARDED_HEADERS) {
    const val = headers[name]
    if (typeof val === 'string' && val.trim().length > 0) return true
    if (Array.isArray(val) && val.length > 0) return true
  }
  return false
}

/**
 * Loopback check on the SOCKET, never `req.ip` or `X-Forwarded-For` — and false if any
 * reverse-proxy or `tailscale serve` header is present.
 */
export function isLoopbackSocket(req: {
  socket?: { remoteAddress?: string | undefined } | null
  headers?: Record<string, unknown> | null
}): boolean {
  if (hasProxyForwardedHeaders(req.headers)) return false
  return isLoopbackAddress(req.socket?.remoteAddress)
}

export type ReachableIpv4Kind = 'tailscale' | 'lan' | 'other'
export interface ReachableIpv4 {
  name: string
  address: string
  kind: ReachableIpv4Kind
}
type InterfaceInfo = { address: string; family: string | number; internal: boolean }

// Interfaces a phone can never reach: macOS VPN tunnels that are not Tailscale's
// address, Internet Sharing / VM bridges, AirDrop (awdl) and low-latency WLAN (llw),
// and VM host-only networks.
const UNREACHABLE_INTERFACE = /^(utun|bridge|awdl|llw|vmnet|vboxnet)/

/**
 * Every external IPv4 address on this machine, Tailscale first. `kind` is
 * `tailscale` for 100.64/10 (or a Linux `tailscale*` interface), `lan` for RFC1918 on
 * an interface a phone can reach, `other` for the rest. Shared by the startup print
 * and the pairing host list.
 */
export function reachableIpv4Addresses(
  nets: Record<string, InterfaceInfo[] | undefined>,
): ReachableIpv4[] {
  const out: ReachableIpv4[] = []
  for (const [name, infos] of Object.entries(nets)) {
    for (const info of infos ?? []) {
      const family = typeof info.family === 'number' ? (info.family === 4 ? 'IPv4' : 'IPv6') : info.family
      if (family !== 'IPv4' || info.internal) continue
      const kind: ReachableIpv4Kind = isTailscaleIpv4(info.address) || name.startsWith('tailscale')
        ? 'tailscale'
        : isRfc1918Ipv4(info.address) && !UNREACHABLE_INTERFACE.test(name) ? 'lan' : 'other'
      out.push({ name, address: info.address, kind })
    }
  }
  const rank = (kind: ReachableIpv4Kind) => (kind === 'tailscale' ? 0 : kind === 'lan' ? 1 : 2)
  return out
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry.kind) - rank(b.entry.kind) || a.index - b.index)
    .map(({ entry }) => entry)
}
