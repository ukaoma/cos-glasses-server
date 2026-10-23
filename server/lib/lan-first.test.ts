// 6.88.0 LAN first (docs/lan-first.md): the pure rules behind GET /api/route-proof and the
// /api/models `routes` field.
import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LAN_ROUTES_CACHE_MS,
  LAN_ROUTES_MAX_PER_KIND,
  ROUTE_PROOF_GLOBAL_LIMIT,
  ROUTE_PROOF_IP_LIMIT,
  ROUTE_PROOF_MAX_TRACKED_IPS,
  ROUTE_PROOF_PREFIX,
  ROUTE_PROOF_WINDOW_MS,
  RouteProofRateLimiter,
  __setInterfaceReaderForTests,
  buildRouteLists,
  computeRouteProof,
  isValidRouteProofNonce,
  lanFirstCapabilities,
  lanFirstEnabled,
  lanFirstHttpPort,
  lanRoutesField,
  routeProofAvailable,
  routeProofMessage,
  routeProofTokenUsable,
  type InterfaceTable,
} from './lan-first.js'

const TOKEN = 'a'.repeat(20) + '-test-token-0123456789'
const ID = '11111111-2222-4333-8444-555555555555'
const NONCE = 'phoneNonce_0123456789-AB'

const iface = (address: string, extra: Partial<{ family: string | number; internal: boolean }> = {}) =>
  ({ address, family: 'IPv4', internal: false, ...extra })

afterEach(() => { __setInterfaceReaderForTests(null) })

describe('route proof message and HMAC', () => {
  it('uses the documented fixed prefix and field order', () => {
    expect(ROUTE_PROOF_PREFIX).toBe('cos-route-proof:v1:')
    expect(routeProofMessage(NONCE, ID)).toBe(`cos-route-proof:v1:${NONCE}:${ID}`)
  })

  it('is lowercase hex HMAC-SHA256(token, message), computed independently here', () => {
    const expected = createHmac('sha256', TOKEN).update(`cos-route-proof:v1:${NONCE}:${ID}`).digest('hex')
    expect(computeRouteProof(TOKEN, NONCE, ID)).toBe(expected)
    expect(expected).toMatch(/^[0-9a-f]{64}$/)
  })

  it('matches the known-answer vector published in docs/lan-first.md', () => {
    // The phone side builds against this exact vector.
    const token = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    expect(computeRouteProof(token, 'AAAAAAAAAAAAAAAAAAAAAA', '00000000-0000-4000-8000-000000000000'))
      .toBe(KNOWN_ANSWER)
  })

  it('a wrong token, another instance id or another nonce each give a different proof', () => {
    const proof = computeRouteProof(TOKEN, NONCE, ID)
    expect(computeRouteProof(TOKEN + 'x', NONCE, ID)).not.toBe(proof)
    expect(computeRouteProof(TOKEN, NONCE, '11111111-2222-4333-8444-555555555556')).not.toBe(proof)
    expect(computeRouteProof(TOKEN, NONCE + 'x', ID)).not.toBe(proof)
  })

  it('is never the HMAC of the bare nonce, so the caller cannot pick the whole message', () => {
    expect(computeRouteProof(TOKEN, NONCE, ID)).not.toBe(createHmac('sha256', TOKEN).update(NONCE).digest('hex'))
  })
})

describe('nonce validation', () => {
  it.each([
    'A'.repeat(22),
    'z'.repeat(64),
    'abc-DEF_0123456789abcdefg',
  ])('accepts %s', nonce => expect(isValidRouteProofNonce(nonce)).toBe(true))

  it.each([
    ['too short', 'A'.repeat(21)],
    ['too long', 'A'.repeat(65)],
    ['a colon', `${'A'.repeat(21)}:`],
    ['a dot', `${'A'.repeat(21)}.`],
    ['a plus', `${'A'.repeat(21)}+`],
    ['a slash', `${'A'.repeat(21)}/`],
    ['padding', `${'A'.repeat(21)}=`],
    ['a space', `${'A'.repeat(21)} `],
    ['a newline', `${'A'.repeat(22)}\n`],
    ['non-ASCII', `${'A'.repeat(21)}é`],
    ['empty', ''],
  ])('refuses a nonce with %s', (_label, nonce) => expect(isValidRouteProofNonce(nonce)).toBe(false))

  it.each([undefined, null, 42, ['A'.repeat(22)], { nonce: 'A'.repeat(22) }])('refuses a non-string %j', value =>
    expect(isValidRouteProofNonce(value)).toBe(false))
})

describe('token strength and availability', () => {
  it('needs at least 32 characters', () => {
    expect(routeProofTokenUsable('x'.repeat(31))).toBe(false)
    expect(routeProofTokenUsable('x'.repeat(32))).toBe(true)
    expect(routeProofTokenUsable(undefined)).toBe(false)
    expect(routeProofTokenUsable(42)).toBe(false)
  })

  it('advertises routeProof only when the proof is servable, and lanRoutes whenever the switch is on', () => {
    expect(lanFirstCapabilities({ token: TOKEN, serverInstanceId: ID, env: {} }))
      .toEqual({ routeProof: { protocol: 1 }, lanRoutes: { protocol: 1 } })
    expect(lanFirstCapabilities({ token: 'short', serverInstanceId: ID, env: {} })).toEqual({ lanRoutes: { protocol: 1 } })
    expect(lanFirstCapabilities({ token: TOKEN, serverInstanceId: null, env: {} })).toEqual({ lanRoutes: { protocol: 1 } })
    expect(lanFirstCapabilities({ token: TOKEN, serverInstanceId: ID, env: { COS_LAN_FIRST: '0' } })).toEqual({})
    expect(routeProofAvailable({ token: TOKEN, serverInstanceId: ID, env: { COS_LAN_FIRST: '0' } })).toBe(false)
  })

  it('only COS_LAN_FIRST=0 turns it off', () => {
    expect(lanFirstEnabled({})).toBe(true)
    expect(lanFirstEnabled({ COS_LAN_FIRST: '1' })).toBe(true)
    expect(lanFirstEnabled({ COS_LAN_FIRST: 'false' })).toBe(true)
    expect(lanFirstEnabled({ COS_LAN_FIRST: '0' })).toBe(false)
  })

  it('reads the http port the server listens on', () => {
    expect(lanFirstHttpPort({})).toBe(3141)
    expect(lanFirstHttpPort({ PORT: '4000' })).toBe(4000)
    expect(lanFirstHttpPort({ PORT: 'nope' })).toBe(3141)
    expect(lanFirstHttpPort({ PORT: '70000' })).toBe(3141)
  })
})

describe('route proof rate limit', () => {
  it('admits 20 a minute per address, then refuses with a Retry-After, then admits again after the window', () => {
    let now = 1_000_000
    const limiter = new RouteProofRateLimiter(() => now)
    for (let i = 0; i < ROUTE_PROOF_IP_LIMIT; i++) expect(limiter.admit('192.168.1.50')).toEqual({ ok: true })
    const refused = limiter.admit('192.168.1.50')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.retryAfterSeconds).toBe(60)
    now += 30_000
    const later = limiter.admit('192.168.1.50')
    expect(later.ok).toBe(false)
    if (!later.ok) expect(later.retryAfterSeconds).toBe(30)
    now += ROUTE_PROOF_WINDOW_MS
    expect(limiter.admit('192.168.1.50')).toEqual({ ok: true })
  })

  it('keeps addresses apart, and treats ::ffff:x and x as one address', () => {
    const limiter = new RouteProofRateLimiter(() => 5)
    for (let i = 0; i < ROUTE_PROOF_IP_LIMIT; i++) limiter.admit(i % 2 ? '::ffff:10.0.0.9' : '10.0.0.9')
    expect(limiter.admit('10.0.0.9').ok).toBe(false)
    expect(limiter.admit('10.0.0.10').ok).toBe(true)
  })

  it('has a global ceiling across addresses', () => {
    const limiter = new RouteProofRateLimiter(() => 5)
    let admitted = 0
    for (let i = 0; i < ROUTE_PROOF_GLOBAL_LIMIT + 50; i++) {
      if (limiter.admit(`10.1.${Math.floor(i / 250)}.${i % 250}`).ok) admitted += 1
    }
    expect(admitted).toBe(ROUTE_PROOF_GLOBAL_LIMIT)
  })

  it('stays bounded under a flood of new addresses', () => {
    let now = 0
    const limiter = new RouteProofRateLimiter(() => now)
    let max = 0
    for (let i = 0; i < 20_000; i++) {
      now += 20
      limiter.admit(`10.${Math.floor(i / 62_500) % 250}.${Math.floor(i / 250) % 250}.${i % 250}`)
      max = Math.max(max, limiter.trackedAddressCount())
    }
    expect(max).toBeLessThanOrEqual(ROUTE_PROOF_MAX_TRACKED_IPS + 1)
    expect(max).toBeGreaterThan(ROUTE_PROOF_GLOBAL_LIMIT / 2)
  })

  it('stores nothing for an address refused by the global ceiling', () => {
    const limiter = new RouteProofRateLimiter(() => 5)
    for (let i = 0; i < ROUTE_PROOF_GLOBAL_LIMIT; i++) limiter.admit(`10.4.${Math.floor(i / 250)}.${i % 250}`)
    const before = limiter.trackedAddressCount()
    expect(limiter.admit('10.5.0.1').ok).toBe(false)
    expect(limiter.trackedAddressCount()).toBe(before)
  })
})

describe('route lists from the interfaces', () => {
  it('puts RFC1918 on a real interface in lan and Tailscale CGNAT on its tunnel in tailscale', () => {
    const nets: InterfaceTable = {
      lo0: [iface('127.0.0.1', { internal: true })],
      en0: [iface('192.168.1.204'), iface('fe80::1', { family: 'IPv6' })],
      en1: [iface('10.0.0.5', { family: 4 })],
      en7: [iface('172.16.0.9'), iface('172.31.255.1'), iface('172.32.0.1')],
      utun4: [iface('100.108.149.114')],
    }
    expect(buildRouteLists(nets, 3141)).toEqual({
      lan: [
        { ip: '192.168.1.204', port: 3141, scheme: 'http' },
        { ip: '10.0.0.5', port: 3141, scheme: 'http' },
        { ip: '172.16.0.9', port: 3141, scheme: 'http' },
        { ip: '172.31.255.1', port: 3141, scheme: 'http' },
      ],
      tailscale: [{ ip: '100.108.149.114', port: 3141, scheme: 'http' }],
    })
  })

  it.each([
    ['link-local', 'en0', '169.254.10.20'],
    ['public', 'en0', '8.8.8.8'],
    ['carrier-grade NAT on Wi-Fi (not Tailscale)', 'en0', '100.70.1.2'],
    ['a corporate VPN tunnel', 'utun2', '10.8.0.2'],
    ['Internet Sharing / VM bridge', 'bridge100', '192.168.64.1'],
    ['Docker bridge', 'docker0', '172.17.0.1'],
    ['a Docker user network', 'br-1a2b3c', '172.18.0.1'],
    ['a veth pair', 'veth12ab', '172.17.0.3'],
    ['libvirt', 'virbr0', '192.168.122.1'],
    ['VMware host-only', 'vmnet8', '192.168.56.1'],
    ['VirtualBox host-only', 'vboxnet0', '192.168.57.1'],
    ['AirDrop', 'awdl0', '10.9.9.9'],
    ['low-latency WLAN', 'llw0', '10.9.9.8'],
    ['an internal address', 'en0', '192.168.1.1'],
  ])('leaves out %s', (label, name, address) => {
    const internal = label === 'an internal address'
    expect(buildRouteLists({ [name]: [iface(address, { internal })] }, 3141)).toEqual({ lan: [], tailscale: [] })
  })

  it('de-duplicates and caps each list', () => {
    const many = Array.from({ length: LAN_ROUTES_MAX_PER_KIND + 4 }, (_, i) => iface(`192.168.5.${i + 1}`))
    const lists = buildRouteLists({ en0: [...many, iface('192.168.5.1')] }, 3141)
    expect(lists.lan).toHaveLength(LAN_ROUTES_MAX_PER_KIND)
    expect(new Set(lists.lan.map(r => r.ip)).size).toBe(LAN_ROUTES_MAX_PER_KIND)
  })

  // Both found by the mutation gate: the cap hid the duplicate above, and the IPv4 rules alone let an
  // IPv4-mapped IPv6 address through (network-policy strips the ::ffff: prefix before matching).
  it('lists an address seen on two interfaces once', () => {
    const lists = buildRouteLists({ en0: [iface('192.168.1.2')], en1: [iface('192.168.1.2')], utun3: [iface('100.101.1.1')], utun4: [iface('100.101.1.1')] }, 3141)
    expect(lists.lan).toEqual([{ ip: '192.168.1.2', port: 3141, scheme: 'http' }])
    expect(lists.tailscale).toEqual([{ ip: '100.101.1.1', port: 3141, scheme: 'http' }])
  })

  it('leaves out IPv6 entries, including IPv4-mapped ones', () => {
    expect(buildRouteLists({
      en0: [iface('::ffff:192.168.1.9', { family: 'IPv6' }), iface('::ffff:10.0.0.9', { family: 6 })],
      utun4: [iface('::ffff:100.108.1.1', { family: 'IPv6' })],
    }, 3141)).toEqual({ lan: [], tailscale: [] })
  })

  it('carries the port it is given', () => {
    expect(buildRouteLists({ en0: [iface('192.168.1.2')] }, 4000).lan[0].port).toBe(4000)
  })

  it('tolerates junk entries', () => {
    expect(buildRouteLists({ en0: undefined, en1: [null as never, { family: 'IPv4', internal: false } as never] }, 3141))
      .toEqual({ lan: [], tailscale: [] })
  })
})

describe('the /api/models routes field', () => {
  it('is null without an instance id or with the switch off', () => {
    __setInterfaceReaderForTests(() => ({ en0: [iface('192.168.1.204')] }))
    expect(lanRoutesField({ port: 3141, serverInstanceId: null, env: {} })).toBeNull()
    expect(lanRoutesField({ port: 3141, serverInstanceId: ID, env: { COS_LAN_FIRST: '0' } })).toBeNull()
  })

  it('has the documented shape', () => {
    __setInterfaceReaderForTests(() => ({ en0: [iface('192.168.1.204')], utun4: [iface('100.108.149.114')] }))
    const at = Date.UTC(2026, 9, 23, 16, 0, 0)
    expect(lanRoutesField({ port: 3141, serverInstanceId: ID, env: {}, now: () => at })).toEqual({
      v: 1,
      serverInstanceId: ID,
      learnedAt: '2026-10-23T16:00:00.000Z',
      lan: [{ ip: '192.168.1.204', port: 3141, scheme: 'http' }],
      tailscale: [{ ip: '100.108.149.114', port: 3141, scheme: 'http' }],
    })
  })

  it('is cached briefly, then re-learned after a DHCP change', () => {
    let address = '192.168.1.204'
    let reads = 0
    __setInterfaceReaderForTests(() => { reads += 1; return { en0: [iface(address)] } })
    let now = 1_000_000
    const read = () => lanRoutesField({ port: 3141, serverInstanceId: ID, env: {}, now: () => now })!
    expect(read().lan[0].ip).toBe('192.168.1.204')
    address = '192.168.1.77'
    now += LAN_ROUTES_CACHE_MS - 1
    expect(read().lan[0].ip).toBe('192.168.1.204')
    expect(reads).toBe(1)
    now += 1
    expect(read().lan[0].ip).toBe('192.168.1.77')
    expect(reads).toBe(2)
  })

  it('a caller mutating the answer does not poison the cache', () => {
    __setInterfaceReaderForTests(() => ({ en0: [iface('192.168.1.204')] }))
    const first = lanRoutesField({ port: 3141, serverInstanceId: ID, env: {}, now: () => 5 })!
    first.lan[0].ip = '6.6.6.6'
    first.lan.push({ ip: '7.7.7.7', port: 1, scheme: 'http' })
    expect(lanRoutesField({ port: 3141, serverInstanceId: ID, env: {}, now: () => 6 })!.lan)
      .toEqual([{ ip: '192.168.1.204', port: 3141, scheme: 'http' }])
  })

  it('never throws: a failed interface read omits the field, and the next read recovers', () => {
    let fail = true
    __setInterfaceReaderForTests(() => { if (fail) throw new Error('uv_interface_addresses failed'); return { en0: [iface('192.168.1.9')] } })
    expect(lanRoutesField({ port: 3141, serverInstanceId: ID, env: {}, now: () => 1 })).toBeNull()
    fail = false
    expect(lanRoutesField({ port: 3141, serverInstanceId: ID, env: {}, now: () => 2 })!.lan[0].ip).toBe('192.168.1.9')
  })
})

const KNOWN_ANSWER = '445fc7d579849fa3fdfb8c2831cf0ace04c6db74e2817b75e87139cc9a3cd207'
