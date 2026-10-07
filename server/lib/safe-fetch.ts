/**
 * An outbound GET that cannot be pointed at this Mac or its networks (6.66.0, Work evidence check).
 *
 * WHY THIS EXISTS. A Work card's finish line can name a page ("https://bottlepos.com/october-switch-offer page is
 * live"), and the evidence check proves that clause by fetching the page. The URL is text a person or an agent wrote,
 * and this server sits on a Mac next to Qdrant (127.0.0.1:6333), the glasses API, the Tailscale network and the home
 * LAN. Node's own fetch follows 20 redirects to anywhere, loopback included (validation round 1, 2026-10-07). So every
 * request goes through the rules below, and nothing else in the server fetches a URL it was handed.
 *
 * THE RULES (plan v2 §3):
 * - https on the default port only; no credentials in the URL; no IP literal hosts; no single-label host; no private
 *   suffix (.local, .ts.net, .internal and the like); no preview host (hs-sites.com, hubspotpreview-na1.com), whose
 *   200 proves nothing about the live page.
 * - Every address the name resolves to is checked, and ONE blocked address refuses the whole name: loopback, RFC 1918,
 *   link-local 169.254/16, CGNAT and Tailscale 100.64/10, ULA fc00::/7, IPv4-mapped and unspecified addresses, and the
 *   other special-use ranges below.
 * - The socket connects to the addresses that were checked, through a `lookup` that answers from that list and never
 *   resolves again, so a name cannot pass the check and then rebind to 127.0.0.1 for the connect.
 * - Redirects are manual: at most 3, each to the SAME host, each hop checked again from scratch.
 * - No cookies are sent or kept. A browser User-Agent, because HubSpot serves a pre-rendered bot copy to a headless one.
 * - 5 seconds for the whole fetch, redirects included; at most 256 KB of the body is read (a longer page is read up to
 *   that point, not refused: a page's <title> and its copy come first).
 *
 * It returns the four things the evidence check needs and nothing else: the final status, the final URL, the page
 * title, and whether the marker words were on the page. A refused or failed fetch throws SafeFetchError with a code.
 */
import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { IncomingMessage } from 'node:http'
import type { Transform } from 'node:stream'

export const SAFE_FETCH_LIMITS = { timeoutMs: 5_000, maxBytes: 256 * 1024, maxRedirects: 3, urlChars: 2_048, titleChars: 200 } as const

/** A current desktop Safari. A headless or library UA gets HubSpot's pre-rendered bot copy, which can lag the page. */
export const SAFE_FETCH_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

export type SafeFetchErrorCode = 'invalid_url' | 'not_https' | 'port_not_default' | 'credentials_in_url' | 'ip_literal_host'
  | 'single_label_host' | 'private_host' | 'preview_host' | 'dns_failed' | 'address_blocked' | 'redirect_other_host'
  | 'redirect_limit' | 'redirect_without_location' | 'timeout' | 'network'

export class SafeFetchError extends Error {
  constructor(readonly code: SafeFetchErrorCode, message: string = code) { super(message); this.name = 'SafeFetchError' }
}

export interface SafeFetchResult { status: number; finalUrl: string; title: string; markerFound: boolean }

/** What must be on the page. Every phrase must appear; otherwise at least `minWords` of `words` (all of them when fewer). */
export interface SafeFetchMarkers { phrases?: string[]; words?: string[]; minWords?: number }

export interface ResolvedAddress { address: string; family: 4 | 6 }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void
export type PinnedLookup = (hostname: string, options: unknown, callback: LookupCallback) => void

export interface TransportRequest {
  url: URL
  /** Answers only for `url.hostname`, only with the checked addresses. */
  lookup: PinnedLookup
  headers: Record<string, string>
  signal: AbortSignal
  maxBytes: number
}
export interface TransportResponse { status: number; location: string | null; body: Buffer }
export type Transport = (req: TransportRequest) => Promise<TransportResponse>

export interface SafeFetchDeps {
  resolve: Resolver
  transport: Transport
  timeoutMs: number
  maxBytes: number
  maxRedirects: number
}

// ---------------------------------------------------------------------------------------------------------------------
// Addresses

// Two lists: Node checks an IPv4 address against IPv6 rules as IPv4-mapped, so one shared list holding ::ffff:0:0/96
// blocked every IPv4 address (found by this file's own test).
const BLOCKED_V4 = new BlockList(), BLOCKED_V6 = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED_V4.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  // ::/96 holds the unspecified address, loopback and the old IPv4-compatible form; ::ffff:0:0/96 is IPv4-mapped.
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) BLOCKED_V6.addSubnet(net, prefix, 'ipv6')

/** True for any address this server must never connect to on a URL's say-so. Anything unparseable is blocked. */
export function isBlockedAddress(address: string): boolean {
  const clean = address.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const family = isIP(clean)
  if (family === 4) return BLOCKED_V4.check(clean, 'ipv4')
  if (family === 6) return BLOCKED_V6.check(clean, 'ipv6')
  return true
}

// ---------------------------------------------------------------------------------------------------------------------
// Hosts and URLs

const PRIVATE_SUFFIXES = ['.local', '.localhost', '.ts.net', '.internal', '.home.arpa', '.lan', '.intranet', '.corp', '.localdomain']
/** Preview and draft hosts: a 200 there says nothing about the live page. */
const PREVIEW_HOSTS = [/(^|\.)hs-sites(-[a-z0-9]+)?\.com$/, /(^|\.)hubspotpreview(-[a-z0-9]+)?\.com$/]

/** The URL a fetch may start from or be redirected to, or a SafeFetchError saying why not. */
export function vetUrl(raw: string | URL): URL {
  let url: URL
  try { url = typeof raw === 'string' ? new URL(raw) : new URL(raw.href) } catch { throw new SafeFetchError('invalid_url') }
  if (url.href.length > SAFE_FETCH_LIMITS.urlChars) throw new SafeFetchError('invalid_url')
  if (url.protocol !== 'https:') throw new SafeFetchError('not_https')
  // The URL parser drops a default :443, so any port left is not the default.
  if (url.port !== '') throw new SafeFetchError('port_not_default')
  if (url.username || url.password) throw new SafeFetchError('credentials_in_url')
  vetHostname(url.hostname)
  url.hash = ''
  return url
}

export function vetHostname(raw: string): string {
  const host = raw.toLowerCase().replace(/\.$/, '')
  if (!host || host.startsWith('[') || isIP(host)) throw new SafeFetchError('ip_literal_host')
  if (!host.includes('.')) throw new SafeFetchError('single_label_host')
  if (host === 'localhost' || PRIVATE_SUFFIXES.some(suffix => host.endsWith(suffix))) throw new SafeFetchError('private_host')
  if (PREVIEW_HOSTS.some(re => re.test(host))) throw new SafeFetchError('preview_host')
  return host
}

const defaultResolve: Resolver = async hostname => {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true })
  return rows.map(r => ({ address: r.address, family: r.family === 6 ? 6 : 4 }))
}

/** Every address of `hostname`, all of them allowed, or a SafeFetchError. One blocked address refuses the name. */
export async function resolveVetted(hostname: string, resolve: Resolver): Promise<ResolvedAddress[]> {
  let rows: ResolvedAddress[]
  try { rows = await resolve(hostname) } catch { throw new SafeFetchError('dns_failed') }
  if (!Array.isArray(rows) || rows.length === 0) throw new SafeFetchError('dns_failed')
  for (const row of rows) if (!row || typeof row.address !== 'string' || isBlockedAddress(row.address)) throw new SafeFetchError('address_blocked')
  return rows.map(r => ({ address: r.address, family: isIP(r.address) === 6 ? 6 : 4 }))
}

/** A `lookup` for the socket that answers from the checked list and never resolves again (no DNS rebinding). */
export function pinnedLookup(hostname: string, addresses: readonly ResolvedAddress[]): PinnedLookup {
  const host = hostname.toLowerCase()
  return (name, options, callback) => {
    if (name.toLowerCase().replace(/\.$/, '') !== host || !addresses.length) {
      callback(Object.assign(new Error('lookup refused'), { code: 'ENOTFOUND' }), '')
      return
    }
    if ((options as { all?: boolean } | null)?.all) callback(null, addresses.map(a => ({ address: a.address, family: a.family })))
    else callback(null, addresses[0]!.address, addresses[0]!.family)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The default transport: node:https, no agent (no pooled socket outlives its checked lookup), no cookies.

export function createHttpsTransport(options: { ca?: string | Buffer; port?: number } = {}): Transport {
  return req => new Promise<TransportResponse>((resolvePromise, reject) => {
    let settled = false
    const done = (fn: () => void) => { if (!settled) { settled = true; fn() } }
    const client = httpsRequest({
      host: req.url.hostname, servername: req.url.hostname, port: options.port ?? 443,
      path: req.url.pathname + req.url.search, method: 'GET', headers: req.headers,
      lookup: req.lookup as never, agent: false, signal: req.signal, ...(options.ca ? { ca: options.ca } : {}),
    }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0
      const location = typeof res.headers.location === 'string' ? res.headers.location : null
      if (status >= 300 && status < 400) { res.resume(); client.destroy(); return done(() => resolvePromise({ status, location, body: Buffer.alloc(0) })) }
      const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase()
      let stream: IncomingMessage | Transform = res
      if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(createGunzip())
      else if (encoding === 'deflate') stream = res.pipe(createInflate())
      else if (encoding === 'br') stream = res.pipe(createBrotliDecompress())
      const chunks: Buffer[] = []
      let total = 0
      const finish = () => done(() => resolvePromise({ status, location, body: Buffer.concat(chunks).subarray(0, req.maxBytes) }))
      stream.on('data', (chunk: Buffer) => {
        if (settled) return
        chunks.push(chunk); total += chunk.length
        // Enough read: stop the transfer rather than download the rest.
        if (total >= req.maxBytes) { finish(); client.destroy(); res.destroy() }
      })
      stream.on('end', finish)
      stream.on('error', e => done(() => reject(e)))
      // A connection that closes early answers with what arrived rather than hanging until the timeout. A complete
      // compressed body is left to its decompressor, which ends after its last bytes.
      res.on('close', () => { if (stream === res || !res.complete) finish() })
    })
    client.on('error', e => done(() => reject(e)))
    client.end()
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// The page

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8}|#39);/gi, (all, name: string) => {
    const lower = name.toLowerCase()
    if (lower.startsWith('#x')) { const n = parseInt(lower.slice(2), 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ' }
    if (lower.startsWith('#')) { const n = parseInt(lower.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ' }
    return ENTITIES[lower] ?? all
  })
}

export function pageTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return match ? decodeEntities(match[1]!).replace(/\s+/g, ' ').trim().slice(0, SAFE_FETCH_LIMITS.titleChars) : ''
}

/** The words a person reads on the page, lowercased: scripts, styles and tags out. */
export function pageText(html: string): string {
  const stripped = html.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
  return decodeEntities(stripped).replace(/\s+/g, ' ').toLowerCase()
}

/** A page that answers 200 but says it is missing. */
const SOFT_404 = /\b(404|page not found|not found|page cannot be found|no longer available)\b/i

export function markersFound(html: string, markers: SafeFetchMarkers | undefined): boolean {
  if (!markers) return false
  const title = pageTitle(html)
  if (SOFT_404.test(title)) return false
  const text = ` ${pageText(html)} ${title.toLowerCase()} `
  const phrases = (markers.phrases ?? []).map(p => p.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean)
  if (phrases.length) return phrases.every(p => text.includes(p))
  const words = [...new Set((markers.words ?? []).map(w => w.trim().toLowerCase()).filter(w => w.length >= 3))]
  if (!words.length) return false
  const need = Math.max(1, Math.min(markers.minWords ?? 2, words.length))
  let hits = 0
  for (const word of words) if (new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text)) hits++
  return hits >= need
}

// ---------------------------------------------------------------------------------------------------------------------

const REDIRECTS = new Set([301, 302, 303, 307, 308])
export const defaultSafeFetchDeps: SafeFetchDeps = {
  resolve: defaultResolve, transport: createHttpsTransport(),
  timeoutMs: SAFE_FETCH_LIMITS.timeoutMs, maxBytes: SAFE_FETCH_LIMITS.maxBytes, maxRedirects: SAFE_FETCH_LIMITS.maxRedirects,
}

/** GET `raw` under every rule above. Throws SafeFetchError when the URL, an address or a redirect is refused. */
export async function safeFetch(raw: string, markers?: SafeFetchMarkers, overrides: Partial<SafeFetchDeps> = {}): Promise<SafeFetchResult> {
  const deps = { ...defaultSafeFetchDeps, ...overrides }
  let current = vetUrl(raw)
  const host = current.hostname.toLowerCase()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs)
  const expired = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new SafeFetchError('timeout')), { once: true }))
  expired.catch(() => { /* raced below; never unhandled */ })
  try {
    for (let hop = 0; ; hop++) {
      const addresses = await Promise.race([resolveVetted(current.hostname, deps.resolve), expired])
      let res: TransportResponse
      try {
        res = await Promise.race([deps.transport({ url: current, lookup: pinnedLookup(current.hostname, addresses), signal: controller.signal, maxBytes: deps.maxBytes,
          headers: { 'User-Agent': SAFE_FETCH_USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'identity' } }), expired])
      } catch (e) {
        if (e instanceof SafeFetchError) throw e
        if (controller.signal.aborted) throw new SafeFetchError('timeout')
        throw new SafeFetchError('network', e instanceof Error ? e.message : String(e))
      }
      if (REDIRECTS.has(res.status)) {
        if (!res.location) throw new SafeFetchError('redirect_without_location')
        if (hop >= deps.maxRedirects) throw new SafeFetchError('redirect_limit')
        let next: URL
        try { next = new URL(res.location, current) } catch { throw new SafeFetchError('invalid_url') }
        next = vetUrl(next)
        if (next.hostname.toLowerCase() !== host) throw new SafeFetchError('redirect_other_host')
        current = next
        continue
      }
      const html = res.body.subarray(0, deps.maxBytes).toString('utf8')
      return { status: res.status, finalUrl: current.href, title: pageTitle(html), markerFound: res.status === 200 && markersFound(html, markers) }
    }
  } finally { clearTimeout(timer) }
}
