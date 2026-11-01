import { describe, expect, it } from 'vitest'
import { publicHttpsUrl } from './public-https-url.js'
import { publicWebUrl } from './meeting-ask-web.js'

// publicHttpsUrl is publicWebUrl restricted to https, copied so the cue log stays standalone. This table is the parity pin:
// every URL answers exactly as publicWebUrl does, except that anything not https is null.
const URLS = [
  'https://example.com/a', 'https://www.example.com/a?b=1#c', 'https://EXAMPLE.com', 'https://sub.domain.example.co.uk/path/', 'https://example.com:443/a', 'https://example.com:80/a',
  'https://example.com:8443/a', 'https://user@example.com/a', 'https://user:pw@example.com/a', 'https://localhost/a', 'https://app.localhost/a', 'https://printer.local/a',
  'https://intranet.internal/a', 'https://singlelabel/a', 'https://127.0.0.1/a', 'https://0.0.0.0/a', 'https://10.1.2.3/a', 'https://172.16.0.1/a', 'https://172.15.0.1/a',
  'https://172.32.0.1/a', 'https://192.168.0.1/a', 'https://169.254.1.1/a', 'https://100.64.0.1/a', 'https://100.128.0.1/a', 'https://224.0.0.1/a', 'https://8.8.8.8/a',
  'https://[::1]/a', 'https://[::]/a', 'https://[fc00::1]/a', 'https://[fd12::1]/a', 'https://[fe80::1]/a', 'https://[::ffff:1.2.3.4]/a', 'https://[2606:4700::1111]/a',
  'http://example.com/a', 'http://localhost/a', 'ftp://example.com/a', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', '//example.com/a', 'example.com/a', 'not a url', '',
  `https://example.com/${'a'.repeat(2100)}`,
]

describe('publicHttpsUrl', () => {
  it('answers exactly as publicWebUrl does for https, and refuses everything that is not https', () => {
    for (const url of URLS) {
      const web = publicWebUrl(url)
      const expected = web !== null && web.startsWith('https://') ? web : null
      expect(publicHttpsUrl(url), url.slice(0, 80)).toBe(expected)
    }
  })
  it('takes a string only, and normalises the way the URL parser does', () => {
    for (const v of [undefined, null, 3, {}, ['https://example.com']]) expect(publicHttpsUrl(v), String(v)).toBeNull()
    expect(publicHttpsUrl('https://EXAMPLE.com')).toBe('https://example.com/')
    expect(publicHttpsUrl('https://example.com/a')).toBe('https://example.com/a')
  })
  it('the table covers both outcomes, so the parity check cannot pass by refusing everything', () => {
    const allowed = URLS.filter(u => publicHttpsUrl(u) !== null)
    expect(allowed.length).toBeGreaterThan(5)
    expect(URLS.length - allowed.length).toBeGreaterThan(20)
  })
})
