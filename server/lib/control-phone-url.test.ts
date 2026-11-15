import { describe, expect, it } from 'vitest'
import type { RequiredListener } from './listener-startup.js'
import type { SignerTlsStatus } from './web-key-signer-tls.js'
import { controlPhoneUrl, trustedControlPhoneHttpsPort } from './control-phone-url.js'

const NAME = 'mac.example-tail.ts.net'
const NOW = Date.parse('2026-11-15T19:00:00Z')
const status = (patch: Partial<SignerTlsStatus> = {}): SignerTlsStatus => ({
  trusted: true, host: NAME, reason: 'ok', notAfter: new Date(NOW + 60_000).toISOString(),
  lastError: null, checkedAt: null, nextCheckAt: null, storedRefused: null, ...patch,
})
const tls = (patch: Partial<SignerTlsStatus> = {}) => ({ active: () => ({ status: () => status(patch) }) })
const listener = (patch: { listening?: boolean; port?: number; actualPort?: number; host?: string; label?: string; address?: null | string } = {}): RequiredListener => ({
  label: patch.label ?? 'HTTPS', host: '0.0.0.0', port: patch.port ?? 3143,
  server: {
    listening: patch.listening ?? true,
    address: () => patch.address !== undefined ? patch.address : ({ address: patch.host ?? '0.0.0.0', family: 'IPv4', port: patch.actualPort ?? 3143 }),
  } as RequiredListener['server'],
})

describe('trusted Control phone URL', () => {
  it('requires exact-name trusted live certificate and actual matching HTTPS listener', () => {
    expect(trustedControlPhoneHttpsPort(NAME, tls(), [listener()], NOW)).toBe(3143)
    expect(controlPhoneUrl(NAME, '100.100.1.2', 3141, n => trustedControlPhoneHttpsPort(n, tls(), [listener()], NOW))).toBe(`https://${NAME}:3143/control`)
  })

  it.each([
    ['disabled TLS', null, [listener()]],
    ['missing active certificate', { active: () => null }, [listener()]],
    ['mkcert/untrusted certificate', tls({ trusted: false }), [listener()]],
    ['certificate for another name', tls({ host: 'old.example-tail.ts.net' }), [listener()]],
    ['expired certificate', tls({ notAfter: new Date(NOW).toISOString() }), [listener()]],
    ['missing expiry', tls({ notAfter: null }), [listener()]],
    ['invalid expiry', tls({ notAfter: 'unknown' }), [listener()]],
    ['no listener', tls(), []],
    ['stopped listener', tls(), [listener({ listening: false })]],
    ['wrong actual port', tls(), [listener({ actualPort: 3144 })]],
    ['signer is not Control', tls(), [listener({ label: 'HTTPS signer' })]],
    ['loopback only', tls(), [listener({ host: '127.0.0.1' })]],
    ['LAN only', tls(), [listener({ host: '192.168.1.12' })]],
    ['missing bound address', tls(), [listener({ address: null })]],
    ['unix socket', tls(), [listener({ address: '/tmp/unused' })]],
  ] as const)('falls back to HTTP with %s', (_why, provider, listeners) => {
    const port = trustedControlPhoneHttpsPort(NAME, provider, listeners, NOW)
    expect(port).toBeNull()
    expect(controlPhoneUrl(NAME, '100.100.1.2', 3141, () => port)).toBe(`http://${NAME}:3141/control`)
  })

  it('does not upgrade an IP, use another host, or fail link generation on status error', () => {
    expect(controlPhoneUrl(null, '100.100.1.2', 3141, () => 3143)).toBe('http://100.100.1.2:3141/control')
    expect(controlPhoneUrl(null, null, 3141, () => 3143)).toBeNull()
    expect(controlPhoneUrl(NAME, null, 3141, () => { throw new Error('unavailable') })).toBe(`http://${NAME}:3141/control`)
    expect(controlPhoneUrl(NAME, null, 3141, () => 0)).toBe(`http://${NAME}:3141/control`)
    expect(trustedControlPhoneHttpsPort('other.example-tail.ts.net', tls(), [listener()], NOW)).toBeNull()
    expect(trustedControlPhoneHttpsPort(NAME, { active: () => { throw new Error('unavailable') } }, [listener()], NOW)).toBeNull()
    expect(trustedControlPhoneHttpsPort(NAME, tls(), [listener({ host: '100.100.1.2' })], NOW)).toBe(3143)
    expect(trustedControlPhoneHttpsPort(NAME, tls(), [listener({ host: '::' })], NOW)).toBe(3143)
  })
})
