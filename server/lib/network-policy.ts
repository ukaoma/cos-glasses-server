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
