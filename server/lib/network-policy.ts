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

export function isAllowedNetworkIp(value: string): boolean {
  const clean = normalizeRemoteIp(value)
  if (clean === '127.0.0.1' || clean === '::1') return true
  if (isTailscaleIpv4(clean)) return true

  const octets = parseIpv4(clean)
  if (!octets) return false
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
}

export function isAllowedNetworkOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return url.hostname === 'localhost' || isAllowedNetworkIp(url.hostname)
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

/**
 * Loopback check on the SOCKET, never `req.ip` or `X-Forwarded-For`. The server never
 * enables trust-proxy, but reading the socket keeps this true even if someone does.
 */
export function isLoopbackSocket(req: { socket?: { remoteAddress?: string | undefined } | null }): boolean {
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
