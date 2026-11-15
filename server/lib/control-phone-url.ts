import type { SignerTls } from './web-key-signer-tls.js'
import type { RequiredListener } from './listener-startup.js'
import { isTailscaleIpv4, isTailscaleIpv6, normalizeTailscaleDnsName } from './network-policy.js'

/** Read-only readiness of the exact SNI provider installed on Control's HTTPS listener.
 * A configured port or the default mkcert pair never establishes phone trust.
 */
export function trustedControlPhoneHttpsPort(
  name: string,
  tls: { active: () => Pick<SignerTls, 'status'> | null } | null,
  listeners: readonly RequiredListener[],
  now: number = Date.now(),
): number | null {
  const dns = normalizeTailscaleDnsName(name)
  if (!dns || !tls) return null
  try {
    const status = tls.active()?.status()
    if (!status?.trusted || status.host !== dns || !status.notAfter || Date.parse(status.notAfter) <= now || !Number.isFinite(Date.parse(status.notAfter))) return null
    const listener = listeners.find(item => item.label === 'HTTPS')
    if (!listener?.server.listening) return null
    const address = listener.server.address()
    if (!address || typeof address === 'string' || address.port !== listener.port) return null
    // A LAN-only or loopback-only bind cannot serve this tailnet name.
    if (address.address !== '0.0.0.0' && address.address !== '::' && !isTailscaleIpv4(address.address) && !isTailscaleIpv6(address.address)) return null
    return validPort(address.port) ? address.port : null
  } catch { return null }
}

function validPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
}

/** One phone origin for QR, copied sign-in links and typed-code addresses. */
export function controlPhoneUrl(
  name: string | null,
  ip: string | null,
  httpPort: number,
  trustedHttpsPort?: (name: string) => number | null,
): string | null {
  const dns = normalizeTailscaleDnsName(name)
  if (dns) {
    let port: number | null = null
    try { port = trustedHttpsPort?.(dns) ?? null } catch { /* HTTP remains available. */ }
    if (validPort(port)) return `https://${dns}:${port}/control`
  }
  const host = dns ?? ip
  return host ? `http://${host}:${httpPort}/control` : null
}
