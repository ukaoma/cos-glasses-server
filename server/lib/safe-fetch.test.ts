import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:https'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  SAFE_FETCH_LIMITS, SAFE_FETCH_USER_AGENT, SafeFetchError, createHttpsTransport, isBlockedAddress, markersFound, pageTitle,
  pinnedLookup, resolveVetted, safeFetch, vetUrl, type ResolvedAddress, type Transport, type TransportRequest,
} from './safe-fetch.js'

const PUBLIC: ResolvedAddress = { address: '93.184.216.34', family: 4 }
const page = (title: string, body: string) => Buffer.from(`<html><head><title>${title}</title><script>var x="loopback"</script></head><body>${body}</body></html>`)

/** A transport that records every request and answers from a script, one answer per call. */
function scripted(answers: Array<{ status: number; location?: string; body?: Buffer } | ((req: TransportRequest) => Promise<never>)>) {
  const calls: Array<{ url: string; address: string; headers: Record<string, string> }> = []
  const transport: Transport = async req => {
    const address = await new Promise<string>((resolve, reject) => req.lookup(req.url.hostname, {}, (err, addr) => err ? reject(err) : resolve(String(addr))))
    calls.push({ url: req.url.href, address, headers: req.headers })
    const next = answers.shift()
    if (!next) throw new Error('no scripted answer left')
    if (typeof next === 'function') return next(req)
    return { status: next.status, location: next.location ?? null, body: next.body ?? Buffer.alloc(0) }
  }
  return { transport, calls }
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (e) { if (e instanceof SafeFetchError) return e.code; throw e }
  throw new Error('expected a SafeFetchError')
}

describe('addresses', () => {
  it('blocks loopback, private, link-local, CGNAT and Tailscale, ULA, mapped and unspecified addresses', () => {
    for (const a of ['127.0.0.1', '127.255.0.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '100.64.0.1',
      '100.100.100.100', '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
      '::ffff:8.8.8.8', 'fc00::1', 'fd7a:115c:a1e0::1', 'fe80::1%en0', '[::1]', '64:ff9b::7f00:1', '2002:7f00:1::1', 'ff02::1', 'not-an-ip', '']) {
      expect(isBlockedAddress(a), a).toBe(true)
    }
  })
  it('allows ordinary public addresses, at the edges of the blocked ranges too', () => {
    for (const a of ['93.184.216.34', '8.8.8.8', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.255.255', '2606:4700::6810:84e5', '2a00:1450:4001:80b::200e']) {
      expect(isBlockedAddress(a), a).toBe(false)
    }
  })
  it('refuses a name when ANY of its addresses is blocked, and when it resolves to nothing', async () => {
    expect(await resolveVetted('a.example.com', async () => [PUBLIC])).toEqual([PUBLIC])
    expect(await refusal(resolveVetted('a.example.com', async () => [PUBLIC, { address: '127.0.0.1', family: 4 }]))).toBe('address_blocked')
    expect(await refusal(resolveVetted('a.example.com', async () => [{ address: '::1', family: 6 }, PUBLIC]))).toBe('address_blocked')
    expect(await refusal(resolveVetted('a.example.com', async () => []))).toBe('dns_failed')
    expect(await refusal(resolveVetted('a.example.com', async () => { throw new Error('ENOTFOUND') }))).toBe('dns_failed')
  })
})

describe('URLs', () => {
  it('accepts an https URL on the default port and drops the fragment', () => {
    expect(vetUrl('https://bottlepos.com/october-switch-offer#top').href).toBe('https://bottlepos.com/october-switch-offer')
    expect(vetUrl('https://bottlepos.com:443/x').href).toBe('https://bottlepos.com/x')
  })
  it('refuses every unsafe shape with its own reason', () => {
    const cases: Array<[string, string]> = [
      ['not a url', 'invalid_url'], ['http://bottlepos.com/', 'not_https'], ['ftp://bottlepos.com/', 'not_https'], ['file:///etc/passwd', 'not_https'],
      ['https://bottlepos.com:8443/', 'port_not_default'], ['https://127.0.0.1:6333/', 'port_not_default'], ['https://user:pw@bottlepos.com/', 'credentials_in_url'],
      ['https://127.0.0.1/', 'ip_literal_host'], ['https://2130706433/', 'ip_literal_host'], ['https://0x7f.1/', 'ip_literal_host'], ['https://[::1]/', 'ip_literal_host'],
      ['https://93.184.216.34/', 'ip_literal_host'], ['https://intranet/', 'single_label_host'], ['https://localhost/', 'single_label_host'],
      ['https://printer.local/', 'private_host'], ['https://mac.tail1234.ts.net/', 'private_host'], ['https://db.internal/', 'private_host'], ['https://x.localhost/', 'private_host'],
      ['https://demo-123.hs-sites.com/page', 'preview_host'], ['https://hs-sites.com/', 'preview_host'], ['https://app.hubspotpreview-na1.com/_hcms/preview', 'preview_host'],
      ['https://' + 'a'.repeat(2050) + '.com/', 'invalid_url'],
    ]
    for (const [url, code] of cases) {
      let got = ''
      try { vetUrl(url) } catch (e) { got = (e as SafeFetchError).code }
      expect(got, url).toBe(code)
    }
  })
})

describe('the pinned lookup', () => {
  it('answers only for its own host, only with the checked addresses, in both callback forms', async () => {
    const lookup = pinnedLookup('Bottlepos.com', [PUBLIC, { address: '2606:4700::1', family: 6 }])
    const one = await new Promise<[unknown, unknown, unknown]>(r => lookup('bottlepos.com', {}, (e, a, f) => r([e, a, f])))
    expect(one).toEqual([null, '93.184.216.34', 4])
    const all = await new Promise<unknown>(r => lookup('bottlepos.com.', { all: true }, (_e, a) => r(a)))
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1', family: 6 }])
    const other = await new Promise<unknown>(r => lookup('evil.example.com', {}, e => r(e)))
    expect(other).toBeInstanceOf(Error)
  })
})

describe('safeFetch', () => {
  it('fetches the page with a browser User-Agent and no cookies, and reports status, final URL, title and markers', async () => {
    const { transport, calls } = scripted([{ status: 200, body: page('Switch to Bottle POS: $3,000 + Free Hardware', '<h1>October switch offer</h1>') }])
    const result = await safeFetch('https://bottlepos.com/october-switch-offer', { words: ['october', 'switch', 'offer'] }, { resolve: async () => [PUBLIC], transport })
    expect(result).toEqual({ status: 200, finalUrl: 'https://bottlepos.com/october-switch-offer', title: 'Switch to Bottle POS: $3,000 + Free Hardware', markerFound: true })
    expect(Object.keys(result).sort()).toEqual(['finalUrl', 'markerFound', 'status', 'title'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.address).toBe('93.184.216.34')
    expect(calls[0]!.headers['User-Agent']).toBe(SAFE_FETCH_USER_AGENT)
    expect(Object.keys(calls[0]!.headers).map(h => h.toLowerCase())).not.toContain('cookie')
  })

  it('refuses before any connection when the name resolves to a blocked address', async () => {
    const { transport, calls } = scripted([{ status: 200 }])
    expect(await refusal(safeFetch('https://evil.example.com/', undefined, { resolve: async () => [{ address: '127.0.0.1', family: 4 }], transport }))).toBe('address_blocked')
    expect(calls).toHaveLength(0)
  })

  it('canary 6: a redirect to 127.0.0.1:6333 never reaches it, in any spelling', async () => {
    for (const location of ['https://127.0.0.1:6333/collections', 'http://127.0.0.1:6333/', 'https://127.0.0.1/', '//127.0.0.1:6333/', 'https://[::1]:6333/', 'https://localhost:6333/']) {
      const { transport, calls } = scripted([{ status: 302, location }, { status: 200, body: page('Qdrant', 'qdrant') }])
      const code = await refusal(safeFetch('https://bottlepos.com/offer', { words: ['qdrant'] }, { resolve: async () => [PUBLIC], transport }))
      expect(['port_not_default', 'not_https', 'ip_literal_host', 'single_label_host'], location).toContain(code)
      expect(calls.map(c => c.url), location).toEqual(['https://bottlepos.com/offer'])
    }
  })

  it('refuses a redirect to another host, even a public one', async () => {
    const { transport, calls } = scripted([{ status: 301, location: 'https://www.bottlepos.com/offer' }, { status: 200 }])
    expect(await refusal(safeFetch('https://bottlepos.com/offer', undefined, { resolve: async () => [PUBLIC], transport }))).toBe('redirect_other_host')
    expect(calls).toHaveLength(1)
  })

  it('re-checks the addresses on every same-host hop (DNS rebinding between hops)', async () => {
    const resolve = vi.fn<(h: string) => Promise<ResolvedAddress[]>>().mockResolvedValueOnce([PUBLIC]).mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const { transport, calls } = scripted([{ status: 302, location: '/next' }, { status: 200 }])
    expect(await refusal(safeFetch('https://rebind.example.com/start', undefined, { resolve, transport }))).toBe('address_blocked')
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(calls).toHaveLength(1)
  })

  it('connects to the checked address: the socket lookup never resolves again (DNS rebinding at connect)', async () => {
    // The name answers public once, then loopback. The transport asks the lookup twice (as a socket with a retry would);
    // both answers are the checked public address, and the resolver was asked exactly once.
    const resolve = vi.fn<(h: string) => Promise<ResolvedAddress[]>>().mockResolvedValueOnce([PUBLIC]).mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const seen: string[] = []
    const transport: Transport = async req => {
      for (let i = 0; i < 2; i++) seen.push(await new Promise<string>(r => req.lookup(req.url.hostname, { all: false }, (_e, a) => r(String(a)))))
      return { status: 200, location: null, body: page('Fine', 'fine words') }
    }
    await safeFetch('https://rebind.example.com/', undefined, { resolve, transport })
    expect(seen).toEqual(['93.184.216.34', '93.184.216.34'])
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('follows at most 3 same-host redirects and reports the final URL', async () => {
    const ok = scripted([{ status: 301, location: '/a' }, { status: 302, location: '/b' }, { status: 307, location: 'https://bottlepos.com/c' }, { status: 200, body: page('C', 'c') }])
    expect(await safeFetch('https://bottlepos.com/start', undefined, { resolve: async () => [PUBLIC], transport: ok.transport })).toMatchObject({ status: 200, finalUrl: 'https://bottlepos.com/c' })
    expect(ok.calls).toHaveLength(4)
    const tooMany = scripted([{ status: 301, location: '/a' }, { status: 301, location: '/b' }, { status: 301, location: '/c' }, { status: 301, location: '/d' }, { status: 200 }])
    expect(await refusal(safeFetch('https://bottlepos.com/start', undefined, { resolve: async () => [PUBLIC], transport: tooMany.transport }))).toBe('redirect_limit')
    expect(tooMany.calls).toHaveLength(4)
    const noLocation = scripted([{ status: 302 }])
    expect(await refusal(safeFetch('https://bottlepos.com/start', undefined, { resolve: async () => [PUBLIC], transport: noLocation.transport }))).toBe('redirect_without_location')
  })

  it('reads at most 256 KB of the body and still finds the title', async () => {
    const huge = Buffer.concat([page('Big page', 'start words'), Buffer.alloc(SAFE_FETCH_LIMITS.maxBytes * 2, 'a'), Buffer.from(' tailmarker ')])
    let offered = 0
    const transport: Transport = async req => { offered = req.maxBytes; return { status: 200, location: null, body: huge } }
    const result = await safeFetch('https://bottlepos.com/big', { words: ['tailmarker'] }, { resolve: async () => [PUBLIC], transport })
    expect(offered).toBe(256 * 1024)
    expect(result).toMatchObject({ status: 200, title: 'Big page', markerFound: false })  // the marker past 256 KB is never read
  })

  it('gives up after 5 seconds for the whole fetch, slow DNS or slow server', async () => {
    vi.useFakeTimers()
    try {
      const hang: Transport = req => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted'))))
      const slowServer = refusal(safeFetch('https://bottlepos.com/', undefined, { resolve: async () => [PUBLIC], transport: hang }))
      await vi.advanceTimersByTimeAsync(SAFE_FETCH_LIMITS.timeoutMs + 1)
      expect(await slowServer).toBe('timeout')
      const slowDns = refusal(safeFetch('https://bottlepos.com/', undefined, { resolve: () => new Promise(() => {}), transport: hang }))
      await vi.advanceTimersByTimeAsync(SAFE_FETCH_LIMITS.timeoutMs + 1)
      expect(await slowDns).toBe('timeout')
      // A server that ignores the abort signal is still cut off at the deadline.
      const deaf = refusal(safeFetch('https://bottlepos.com/', undefined, { resolve: async () => [PUBLIC], transport: () => new Promise(() => {}) }))
      await vi.advanceTimersByTimeAsync(SAFE_FETCH_LIMITS.timeoutMs + 1)
      expect(await deaf).toBe('timeout')
      expect(SAFE_FETCH_LIMITS.timeoutMs).toBe(5_000)
    } finally { vi.useRealTimers() }
  })

  it('a network error is "network", never a pass', async () => {
    const transport: Transport = async () => { throw new Error('ECONNRESET') }
    expect(await refusal(safeFetch('https://bottlepos.com/', undefined, { resolve: async () => [PUBLIC], transport }))).toBe('network')
  })

  it('a non-200 answer or a soft 404 never finds the marker', async () => {
    const notFound = scripted([{ status: 404, body: page('Offer', 'october switch offer') }])
    expect(await safeFetch('https://bottlepos.com/x', { words: ['october', 'switch'] }, { resolve: async () => [PUBLIC], transport: notFound.transport })).toMatchObject({ status: 404, markerFound: false })
    const soft = scripted([{ status: 200, body: page('Page not found | Bottle POS', 'october switch offer') }])
    expect(await safeFetch('https://bottlepos.com/x', { words: ['october', 'switch'] }, { resolve: async () => [PUBLIC], transport: soft.transport })).toMatchObject({ status: 200, markerFound: false })
  })
})

describe('markers', () => {
  const html = page('Switch to Bottle POS &amp; save', '<p>The October switch offer: $3,000 toward hardware.</p><script>secretword()</script>').toString()
  it('needs every quoted phrase, or two of the words (all of them when fewer)', () => {
    expect(markersFound(html, { phrases: ['October switch offer'] })).toBe(true)
    expect(markersFound(html, { phrases: ['October switch offer', 'free trial'] })).toBe(false)
    expect(markersFound(html, { words: ['october', 'switch', 'trial'] })).toBe(true)
    expect(markersFound(html, { words: ['october', 'trial', 'loyalty'] })).toBe(false)
    expect(markersFound(html, { words: ['switch'] })).toBe(true)
    expect(markersFound(html, { words: ['secretword', 'switch'] })).toBe(false)  // script text is not page text
    expect(markersFound(html, { words: ['swit', 'octobe'] })).toBe(false)      // whole words only
    expect(markersFound(html, { words: [] })).toBe(false)
    expect(markersFound(html, undefined)).toBe(false)
    expect(pageTitle(html)).toBe('Switch to Bottle POS & save')
  })
})

// The real node:https transport against a real TLS server on 127.0.0.1, reached by a name that does NOT resolve there in
// DNS: a successful answer proves the socket used the pinned address and that the certificate is checked for the name.
const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0
describe.skipIf(!openssl)('the https transport', () => {
  let dir = '', server: Server, port = 0, cert = ''
  const routes: Record<string, (res: import('node:http').ServerResponse) => void> = {
    '/page': res => { res.setHeader('Set-Cookie', 'a=b'); res.end('<title>Real TLS</title>hello') },
    // The rest of a long page arrives late: a transport that stopped reading at its cap answers long before it.
    '/big': res => { res.write(Buffer.alloc(300 * 1024, 'x')); const t = setTimeout(() => res.end('END'), 3_000); res.on('close', () => clearTimeout(t)) },
    '/gz': res => { res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync(Buffer.from('<title>Zipped</title>' + 'y'.repeat(400 * 1024)))) },
    '/moved': res => { res.statusCode = 302; res.setHeader('Location', 'https://127.0.0.1:6333/'); res.end() },
  }
  const seenHeaders: Array<Record<string, unknown>> = []
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'safe-fetch-tls-'))
    const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=evidence.example.com',
      '-addext', 'subjectAltName=DNS:evidence.example.com', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { encoding: 'utf8' })
    if (made.status !== 0) throw new Error('openssl failed: ' + made.stderr)
    cert = readFileSync(join(dir, 'cert.pem'), 'utf8')
    server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => { seenHeaders.push(req.headers); (routes[req.url ?? ''] ?? (r => { r.statusCode = 404; r.end() }))(res) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as { port: number }).port
  })
  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })
  const ask = (path: string, maxBytes = SAFE_FETCH_LIMITS.maxBytes, hostname = 'evidence.example.com') => createHttpsTransport({ ca: cert, port })({
    url: new URL(`https://${hostname}${path}`), lookup: pinnedLookup(hostname, [{ address: '127.0.0.1', family: 4 }]),
    headers: { 'User-Agent': SAFE_FETCH_USER_AGENT, 'Accept-Encoding': 'identity' }, signal: new AbortController().signal, maxBytes,
  })

  it('connects through the pinned lookup and checks the certificate against the name', async () => {
    const res = await ask('/page')
    expect(res.status).toBe(200)
    expect(res.body.toString()).toContain('Real TLS')
    expect(seenHeaders.at(-1)?.cookie).toBeUndefined()
    expect(seenHeaders.at(-1)?.['user-agent']).toBe(SAFE_FETCH_USER_AGENT)
    // The same server under a name its certificate does not carry is refused by TLS.
    await expect(createHttpsTransport({ ca: cert, port })({ url: new URL('https://other.example.com/page'), lookup: pinnedLookup('other.example.com', [{ address: '127.0.0.1', family: 4 }]),
      headers: {}, signal: new AbortController().signal, maxBytes: 1024 })).rejects.toThrow()
  })
  it('stops reading at the byte cap, plain or compressed', async () => {
    const started = Date.now()
    const big = await ask('/big', 64 * 1024)
    expect(big.body.length).toBe(64 * 1024)
    expect(Date.now() - started).toBeLessThan(2_000)  // it stopped the transfer instead of waiting for the end
    const zipped = await ask('/gz', 64 * 1024)
    expect(zipped.body.length).toBe(64 * 1024)
    expect(zipped.body.toString()).toContain('<title>Zipped</title>')
  })
  it('returns a redirect without following it', async () => {
    expect(await ask('/moved')).toEqual({ status: 302, location: 'https://127.0.0.1:6333/', body: Buffer.alloc(0) })
  })
})
