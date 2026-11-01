// A public https address, for the live cue log. The same rules as publicWebUrl in meeting-ask-web.ts (no credentials, no
// localhost or private or link-local host, port 80 or 443 only) plus https only, because a cue source never links to plain
// http. It is a copy on purpose: meeting-ask-web.ts pulls in the whole Ask runtime, and the cue log must stay standalone (a
// v2-off server reads it without building anything). public-https-url.test.ts pins parity with publicWebUrl on a table of
// hosts, so the two cannot drift apart unnoticed.

import { isIP } from 'node:net'

function publicAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false
  if (isIP(h) === 4) {
    const p = h.split('.').map(Number)
    return !(p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 || p[0] === 169 && p[1] === 254 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 192 && p[1] === 168 || p[0] === 100 && p[1] >= 64 && p[1] <= 127)
  }
  if (isIP(h) === 6) return !(h === '::' || h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:'))
  return h.includes('.')
}

/** The normalised href when `value` is an https URL to a public host, else null. Never throws. */
export function publicHttpsUrl(value: unknown): string | null {
  try {
    if (typeof value !== 'string' || value.length > 2048) return null
    const u = new URL(value)
    if (u.protocol !== 'https:' || u.username || u.password || !publicAddress(u.hostname) || u.port && !['80', '443'].includes(u.port)) return null
    return u.href
  } catch { return null }
}
