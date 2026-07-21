import { describe, expect, it } from 'vitest'
import { isAllowedNetworkIp, isAllowedNetworkOrigin, isTailscaleIpv4 } from './network-policy.js'

describe('network policy', () => {
  it('accepts only the Tailscale CGNAT /10 rather than all of 100/8', () => {
    expect(isTailscaleIpv4('100.64.0.1')).toBe(true)
    expect(isTailscaleIpv4('100.127.255.254')).toBe(true)
    expect(isTailscaleIpv4('100.63.255.255')).toBe(false)
    expect(isTailscaleIpv4('100.128.0.1')).toBe(false)
    expect(isAllowedNetworkIp('100.1.2.3')).toBe(false)
  })

  it('preserves localhost and RFC1918 phone access', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:192.168.1.20', '10.0.0.8', '172.31.4.5']) {
      expect(isAllowedNetworkIp(ip)).toBe(true)
    }
    expect(isAllowedNetworkIp('172.32.0.1')).toBe(false)
    expect(isAllowedNetworkIp('8.8.8.8')).toBe(false)
  })

  it('applies the same range policy to CORS origins', () => {
    expect(isAllowedNetworkOrigin('http://100.108.149.114:3141')).toBe(true)
    expect(isAllowedNetworkOrigin('https://192.168.1.20:3143')).toBe(true)
    expect(isAllowedNetworkOrigin('http://100.1.2.3:3141')).toBe(false)
    expect(isAllowedNetworkOrigin('https://example.com')).toBe(false)
  })
})
