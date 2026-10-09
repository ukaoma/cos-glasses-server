import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CROCKFORD_ALPHABET,
  PAIRING_CODE_ATTEMPT_LIMIT,
  PAIRING_CODE_TTL_MS,
  PAIRING_LAN_ARM_MS,
  PAIRING_PENDING_TTL_MS,
  PAIRING_QR_CHARSET,
  PAIRING_QR_PATTERN,
  PAIRING_NONCE_PATTERN,
  PAIRING_REASON_MESSAGE,
  PAIRING_REASON_STATUS,
  pairingCodesEqual,
  PairingError,
  PairingState,
  buildPairingQr,
  displayPairingCode,
  generatePairingCode,
  normalizePairingCode,
  pairingCodeTag,
  pairingHostsFrom,
  type PairingHost,
} from './glasses-pairing.js'
import { isLoopbackAddress, isLoopbackSocket, reachableIpv4Addresses } from './network-policy.js'

const TOKEN = 'standing-pairing-token-abcdefghijklmnop'
const TS_IP = '100.81.195.27'
const TS_IP_2 = '100.90.1.2'
const LAN_IP = '192.168.1.50'
const NONCE = 'nonce-AAAAAAAAAAAAAAAA'
const NONCE_2 = 'nonce-BBBBBBBBBBBBBBBB'

function makeState(overrides: { hosts?: (lan: boolean) => PairingHost[] } = {}) {
  let now = Date.UTC(2026, 9, 9, 12, 0, 0)
  const logs: string[] = []
  const state = new PairingState({
    now: () => now,
    token: () => TOKEN,
    serverName: () => 'Test-Mac',
    hosts: overrides.hosts ?? (lan => [
      { host: '100.64.1.1', port: 3141, kind: 'tailscale' as const },
      ...(lan ? [{ host: '192.168.1.204', port: 3141, kind: 'lan' as const }] : []),
    ]),
    log: line => logs.push(line),
  })
  return { state, logs, advance: (ms: number) => { now += ms }, now: () => now }
}

function reasonOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof PairingError) return error.reason
    throw error
  }
  return 'ok'
}

describe('pairing code grammar', () => {
  it('generates 8 Crockford base32 characters from crypto.randomInt by default', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode()
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    }
    expect(CROCKFORD_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ')
  })

  it('uses the injected random source over the whole alphabet', () => {
    let i = 0
    expect(generatePairingCode(max => (i++ * 5) % max)).toBe('05AFMSY3')
  })

  it('normalizes case, O, I, L, spaces and dashes', () => {
    expect(normalizePairingCode('abcd-efgh')).toBe('ABCDEFGH')
    expect(normalizePairingCode(' oOil LI10 ')).toBe('00111110')
    expect(normalizePairingCode('7K3M-9PQR')).toBe('7K3M9PQR')
    expect(normalizePairingCode('ABCD-EFG')).toBeNull()
    expect(normalizePairingCode('ABCD-EFGHJ')).toBeNull()
    expect(normalizePairingCode('ABCD-EFGU')).toBeNull() // U is not Crockford
    expect(normalizePairingCode(12345678)).toBeNull()
    expect(normalizePairingCode('A'.repeat(40))).toBeNull()
  })

  it('displays XXXX-XXXX', () => {
    expect(displayPairingCode('7K3M9PQR')).toBe('7K3M-9PQR')
  })

  it('builds the QR text exactly in the contract grammar', () => {
    const exp = 1_791_000_000_000
    const qr = buildPairingQr('7K3M9PQR', [
      { host: '100.81.195.27', port: 3141, kind: 'tailscale' },
      { host: '192.168.1.204', port: 3141, kind: 'lan' },
    ], exp)
    expect(qr).toBe(`COS1/MAC/7K3M9PQR/100.81.195.27:3141+192.168.1.204:3141/${(1_791_000_000).toString(36).toUpperCase()}`)
    expect(qr).toMatch(PAIRING_QR_PATTERN)
    expect(qr).toMatch(/^[A-Z0-9/:+.]+$/)
    expect(qr).toMatch(PAIRING_QR_CHARSET)
    // Every character is in the QR alphanumeric set, so the code never falls back to byte mode.
    for (const ch of qr) expect('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:').toContain(ch)
    expect(qr).not.toContain(',')
    expect(parseInt(qr.split('/').pop()!, 36)).toBe(1_791_000_000)
  })

  it('tags a code with 2 hex characters of its sha256', () => {
    expect(pairingCodeTag('7K3M9PQR')).toMatch(/^[0-9a-f]{2}$/)
  })
})

describe('pairing hosts', () => {
  const nets = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.1.204', family: 'IPv4', internal: false },
    ],
    bridge100: [{ address: '192.168.64.1', family: 'IPv4', internal: false }],
    utun3: [{ address: '100.81.195.27', family: 'IPv4', internal: false }],
    utun4: [{ address: '10.8.0.2', family: 'IPv4', internal: false }],
    awdl0: [{ address: '10.9.0.1', family: 'IPv4', internal: false }],
    llw0: [{ address: '10.10.0.1', family: 'IPv4', internal: false }],
    en5: [{ address: '203.0.113.5', family: 'IPv4', internal: false }],
  }

  it('lists Tailscale first, then LAN, then the rest, and skips IPv6 and internal', () => {
    const list = reachableIpv4Addresses(nets)
    expect(list[0]).toEqual({ name: 'utun3', address: '100.81.195.27', kind: 'tailscale' })
    expect(list[1]).toEqual({ name: 'en0', address: '192.168.1.204', kind: 'lan' })
    expect(list.filter(e => e.kind === 'lan').map(e => e.name)).toEqual(['en0'])
    expect(list.map(e => e.address)).not.toContain('127.0.0.1')
    expect(list.map(e => e.address)).not.toContain('fe80::1')
  })

  it('offers only Tailscale until LAN is armed, never a bridge, utun VPN, awdl or llw address', () => {
    const list = reachableIpv4Addresses(nets)
    expect(pairingHostsFrom(list, 3141, false)).toEqual([{ host: '100.81.195.27', port: 3141, kind: 'tailscale' }])
    expect(pairingHostsFrom(list, 3141, true)).toEqual([
      { host: '100.81.195.27', port: 3141, kind: 'tailscale' },
      { host: '192.168.1.204', port: 3141, kind: 'lan' },
    ])
  })

  it('is empty with no Tailscale and LAN off', () => {
    expect(pairingHostsFrom(reachableIpv4Addresses({ en0: nets.en0 }), 3141, false)).toEqual([])
  })
})

describe('loopback socket', () => {
  it.each(['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1'])('%s is loopback', ip => {
    expect(isLoopbackAddress(ip)).toBe(true)
    expect(isLoopbackSocket({ socket: { remoteAddress: ip } })).toBe(true)
  })
  it.each(['100.81.195.27', '192.168.1.5', '::ffff:192.168.1.5', '', undefined])('%s is not loopback', ip => {
    expect(isLoopbackSocket({ socket: { remoteAddress: ip } })).toBe(false)
  })
  it('ignores req.ip and X-Forwarded-For', () => {
    const req = { ip: '127.0.0.1', headers: { 'x-forwarded-for': '127.0.0.1' }, socket: { remoteAddress: '100.81.195.27' } }
    expect(isLoopbackSocket(req)).toBe(false)
  })
})

describe('pairing state machine', () => {
  it('mints a code with display, qr, expiry 5 minutes out, bootId and hosts', () => {
    const { state, now } = makeState()
    const minted = state.mint()
    expect(minted.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    expect(minted.display).toBe(`${minted.code.slice(0, 4)}-${minted.code.slice(4)}`)
    expect(Date.parse(minted.expiresAt) - now()).toBe(PAIRING_CODE_TTL_MS)
    expect(minted.qr).toMatch(PAIRING_QR_PATTERN)
    expect(minted.qr).toContain(`/${minted.code}/100.64.1.1:3141/`)
    expect(minted.hosts).toEqual([{ host: '100.64.1.1', port: 3141, kind: 'tailscale' }])
    expect(minted.lanArmedUntil).toBeNull()
    expect(minted.bootId).toBe(state.bootId)
  })

  it('returns qr null when there is no host to put in it', () => {
    const { state } = makeState({ hosts: () => [] })
    const minted = state.mint()
    expect(minted.qr).toBeNull()
    expect(minted.hosts).toEqual([])
  })

  it('expires a code after 5 minutes', () => {
    const { state, advance } = makeState()
    const { code } = state.mint()
    advance(PAIRING_CODE_TTL_MS)
    expect(reasonOf(() => state.claim({ code, nonce: NONCE }, TS_IP))).toBe('expired')
    expect(state.status().code).toBeNull()
  })

  it('accepts a code just inside 5 minutes', () => {
    const { state, advance } = makeState()
    const { code } = state.mint()
    advance(PAIRING_CODE_TTL_MS - 1)
    expect(reasonOf(() => state.claim({ code, nonce: NONCE }, TS_IP))).toBe('ok')
  })

  it('is single use: the first successful claim moves the code to used', () => {
    const { state } = makeState()
    const { code } = state.mint()
    state.claim({ code, nonce: NONCE }, TS_IP)
    state.decide(NONCE, false)
    expect(state.status().code?.state).toBe('used')
    expect(reasonOf(() => state.claim({ code, nonce: NONCE_2 }, TS_IP_2))).toBe('used')
  })

  it('accepts the dashed, lowercase display form', () => {
    const { state } = makeState()
    const { display } = state.mint()
    expect(reasonOf(() => state.claim({ code: display.toLowerCase(), nonce: NONCE }, TS_IP))).toBe('ok')
  })

  it('is idempotent for the same nonce and code', () => {
    const { state } = makeState()
    const { code } = state.mint()
    state.claim({ code, nonce: NONCE }, TS_IP)
    expect(reasonOf(() => state.claim({ code, nonce: NONCE }, TS_IP))).toBe('ok')
    expect(state.status().pending?.nonce).toBe(NONCE)
  })

  it('a new code cancels the old code and the pending claim', () => {
    const { state } = makeState()
    const first = state.mint()
    state.claim({ code: first.code, nonce: NONCE }, TS_IP)
    const second = state.mint()
    expect(second.code).not.toBe(first.code)
    expect(state.status().pending).toBeNull()
    expect(state.poll(NONCE, TS_IP)).toEqual({ state: 'expired' })
    expect(reasonOf(() => state.decide(NONCE, true))).toBe('expired')
    expect(reasonOf(() => state.claim({ code: first.code, nonce: NONCE_2 }, TS_IP_2))).toBe('unknown_code')
  })

  it('expires a pending claim after 60 s with no decision', () => {
    const { state, advance } = makeState()
    const { code } = state.mint()
    state.claim({ code, nonce: NONCE }, TS_IP)
    advance(PAIRING_PENDING_TTL_MS - 1)
    expect(state.poll(NONCE, TS_IP)).toEqual({ state: 'pending' })
    advance(1)
    expect(state.poll(NONCE, TS_IP)).toEqual({ state: 'expired' })
    expect(state.status().pending).toBeNull()
    expect(reasonOf(() => state.decide(NONCE, true))).toBe('expired')
  })

  it('refuses a second claim while one is pending with locked, and keeps the first', () => {
    const { state } = makeState()
    const { code } = state.mint()
    state.claim({ code, nonce: NONCE }, TS_IP)
    expect(reasonOf(() => state.claim({ code, nonce: NONCE_2 }, TS_IP_2))).toBe('locked')
    expect(state.status().pending?.nonce).toBe(NONCE)
    state.decide(NONCE, true)
    expect(state.poll(NONCE, TS_IP).state).toBe('allowed')
  })

  it('refuses the same nonce with a different code or from a different IP', () => {
    const { state } = makeState()
    const { code } = state.mint()
    state.claim({ code, nonce: NONCE }, TS_IP)
    expect(reasonOf(() => state.claim({ code, nonce: NONCE }, TS_IP_2))).toBe('locked')
    expect(reasonOf(() => state.claim({ code: 'ZZZZZZZZ', nonce: NONCE }, TS_IP))).toBe('locked')
  })

  it('limits a socket IP to 5 claim attempts per minute', () => {
    const { state, advance } = makeState()
    state.mint()
    for (let i = 0; i < 5; i++) {
      expect(reasonOf(() => state.claim({ code: 'ZZZZZZZZ', nonce: `${NONCE}${i}` }, TS_IP))).toBe('unknown_code')
    }
    expect(reasonOf(() => state.claim({ code: 'ZZZZZZZZ', nonce: `${NONCE}x` }, TS_IP))).toBe('rate_limited')
    // Another IP has its own bucket.
    expect(reasonOf(() => state.claim({ code: 'ZZZZZZZZ', nonce: `${NONCE}y` }, TS_IP_2))).toBe('unknown_code')
    advance(60_000)
    expect(reasonOf(() => state.claim({ code: 'ZZZZZZZZ', nonce: `${NONCE}z` }, TS_IP))).toBe('unknown_code')
  })

  it('keys the limiter on the normalized socket IP (::ffff: form is the same bucket)', () => {
    const { state } = makeState()
    state.mint()
    for (let i = 0; i < 3; i++) reasonOf(() => state.claim({ code: 'ZZZZZZZZ', nonce: `${NONCE}${i}` }, TS_IP))
    for (let i = 3; i < 5; i++) reasonOf(() => state.claim({ code: 'ZZZZZZZZ', nonce: `${NONCE}${i}` }, `::ffff:${TS_IP}`))
    expect(reasonOf(() => state.claim({ code: 'ZZZZZZZZ', nonce: `${NONCE}x` }, TS_IP))).toBe('rate_limited')
  })

  it('a used code is not locked by later attempts, and they do not count', () => {
    const { state } = makeState()
    const { code } = state.mint()
    state.claim({ code, nonce: NONCE }, TS_IP)
    // 30 more attempts from other tailnet peers while the claim waits for Allow.
    for (let i = 0; i < 30; i++) {
      const reason = reasonOf(() => state.claim({ code: i % 2 ? code : 'ZZZZZZZZ', nonce: `${NONCE_2}${i}` }, `100.70.1.${i + 1}`))
      expect(reason).toBe(i % 2 ? 'locked' : 'unknown_code')
    }
    expect(state.status().code?.state).toBe('used')
    // The waiting claim is untouched and still completes.
    state.decide(NONCE, true)
    expect(state.poll(NONCE, TS_IP).token).toBe(TOKEN)
    // After the decision the right code reads `used`, not `locked`.
    expect(reasonOf(() => state.claim({ code, nonce: `${NONCE_2}zz` }, '100.70.2.1'))).toBe('used')
    expect(state.status().code?.state).toBe('used')
  })

  it('compares codes in constant time over equal-length buffers', () => {
    expect(pairingCodesEqual('7K3M9PQR', '7K3M9PQR')).toBe(true)
    expect(pairingCodesEqual('7K3M9PQR', '7K3M9PQS')).toBe(false)
    expect(pairingCodesEqual('7K3M9PQR', '7K3M9PQ')).toBe(false)
  })

  it('locks a code after 20 attempts until a new code is made', () => {
    const { state } = makeState()
    const { code } = state.mint()
    // 20 wrong guesses from 20 different IPs (each IP stays under its own limit).
    for (let i = 0; i < PAIRING_CODE_ATTEMPT_LIMIT; i++) {
      expect(reasonOf(() => state.claim({ code: 'ZZZZZZZZ', nonce: `${NONCE}${i}` }, `100.70.0.${i + 1}`))).toBe('unknown_code')
    }
    expect(reasonOf(() => state.claim({ code, nonce: NONCE_2 }, TS_IP))).toBe('locked')
    expect(state.status().code?.state).toBe('locked')
    const fresh = state.mint()
    expect(reasonOf(() => state.claim({ code: fresh.code, nonce: NONCE_2 }, TS_IP))).toBe('ok')
  })

  it('accepts claims from Tailscale; refuses LAN unless armed, and loopback or public always', () => {
    const { state } = makeState()
    const { code } = state.mint()
    expect(reasonOf(() => state.claim({ code, nonce: NONCE }, LAN_IP))).toBe('not_allowed_network')
    expect(reasonOf(() => state.claim({ code, nonce: NONCE }, '127.0.0.1'))).toBe('not_allowed_network')
    expect(reasonOf(() => state.claim({ code, nonce: NONCE }, '::1'))).toBe('not_allowed_network')
    expect(reasonOf(() => state.claim({ code, nonce: NONCE }, '203.0.113.9'))).toBe('not_allowed_network')
    expect(reasonOf(() => state.claim({ code, nonce: NONCE }, '100.128.0.1'))).toBe('not_allowed_network')
    expect(reasonOf(() => state.claim({ code, nonce: NONCE }, `::ffff:${TS_IP}`))).toBe('ok')
  })

  it('accepts LAN claims while armed and stops after 10 minutes', () => {
    const { state, advance } = makeState()
    const minted = state.mint({ allowLan: true })
    expect(minted.hosts.map(h => h.kind)).toEqual(['tailscale', 'lan'])
    expect(minted.qr).toContain('100.64.1.1:3141+192.168.1.204:3141')
    expect(minted.lanArmedUntil).not.toBeNull()
    advance(PAIRING_LAN_ARM_MS - 1)
    expect(reasonOf(() => state.claim({ code: 'ZZZZZZZZ', nonce: NONCE }, LAN_IP))).toBe('unknown_code')
    advance(1)
    expect(reasonOf(() => state.claim({ code: 'ZZZZZZZZ', nonce: NONCE_2 }, LAN_IP))).toBe('not_allowed_network')
    expect(state.status().lanArmedUntil).toBeNull()
  })

  it('a mint without allowLan disarms LAN', () => {
    const { state } = makeState()
    state.mint({ allowLan: true })
    const { code } = state.mint()
    expect(reasonOf(() => state.claim({ code, nonce: NONCE }, LAN_IP))).toBe('not_allowed_network')
  })

  it('binds the poll to the claim socket IP', () => {
    const { state } = makeState()
    const { code } = state.mint()
    state.claim({ code, nonce: NONCE }, TS_IP)
    state.decide(NONCE, true)
    expect(reasonOf(() => state.poll(NONCE, TS_IP_2))).toBe('not_allowed_network')
    // The refused poll did not consume the token.
    expect(state.poll(NONCE, TS_IP)).toEqual({ state: 'allowed', token: TOKEN, serverName: 'Test-Mac' })
  })

  it('returns the token exactly once, then delivered', () => {
    const { state } = makeState()
    const { code } = state.mint()
    state.claim({ code, nonce: NONCE }, TS_IP)
    expect(state.poll(NONCE, TS_IP)).toEqual({ state: 'pending' })
    state.decide(NONCE, true)
    expect(state.poll(NONCE, TS_IP)).toEqual({ state: 'allowed', token: TOKEN, serverName: 'Test-Mac' })
    expect(state.poll(NONCE, TS_IP)).toEqual({ state: 'delivered', serverName: 'Test-Mac' })
    expect(state.poll(NONCE, TS_IP)).toEqual({ state: 'delivered', serverName: 'Test-Mac' })
  })

  it('the deny path never releases the token', () => {
    const { state } = makeState()
    const { code } = state.mint()
    state.claim({ code, nonce: NONCE }, TS_IP)
    state.decide(NONCE, false)
    expect(state.poll(NONCE, TS_IP)).toEqual({ state: 'denied' })
    expect(reasonOf(() => state.claim({ code, nonce: NONCE }, TS_IP))).toBe('denied')
    expect(reasonOf(() => state.decide(NONCE, true))).toBe('used')
    expect(state.status().lastClaim).toMatchObject({ ip: TS_IP, allowed: false })
  })

  it('loses everything on restart: unknown_code and a new bootId', () => {
    const before = makeState()
    const { code } = before.state.mint()
    before.state.claim({ code, nonce: NONCE }, TS_IP)
    const after = makeState()
    expect(after.state.bootId).not.toBe(before.state.bootId)
    expect(reasonOf(() => after.state.claim({ code, nonce: NONCE_2 }, TS_IP))).toBe('unknown_code')
    expect(reasonOf(() => after.state.poll(NONCE, TS_IP))).toBe('unknown_code')
  })

  it('stamps firstAuthAfterClaimAt once, only from the allowed IP after delivery', () => {
    const { state, advance, now } = makeState()
    const { code } = state.mint()
    state.claim({ code, nonce: NONCE }, TS_IP)
    state.noteAuthenticated(TS_IP) // pending: no
    state.decide(NONCE, true)
    state.noteAuthenticated(TS_IP) // allowed but token not delivered: no
    expect(state.status().firstAuthAfterClaimAt).toBeNull()
    state.poll(NONCE, TS_IP)
    state.noteAuthenticated(TS_IP_2) // another phone: no
    expect(state.status().firstAuthAfterClaimAt).toBeNull()
    advance(1000)
    state.noteAuthenticated(`::ffff:${TS_IP}`)
    const stamped = state.status().firstAuthAfterClaimAt
    expect(stamped).toBe(new Date(now()).toISOString())
    advance(1000)
    state.noteAuthenticated(TS_IP)
    expect(state.status().firstAuthAfterClaimAt).toBe(stamped)
    expect(state.status().lastClaim).toMatchObject({ ip: TS_IP, allowed: true })
  })

  it('reports status in the contract shape', () => {
    const { state } = makeState()
    const minted = state.mint({ allowLan: true })
    state.claim({ code: minted.code, nonce: NONCE }, TS_IP)
    const status = state.status()
    expect(Object.keys(status).sort()).toEqual(['bootId', 'code', 'firstAuthAfterClaimAt', 'lanArmedUntil', 'lastClaim', 'pending'])
    expect(status.code).toEqual({ display: minted.display, expiresAt: minted.expiresAt, state: 'used' })
    expect(status.pending).toMatchObject({ nonce: NONCE, ip: TS_IP })
    expect(status.lastClaim).toMatchObject({ ip: TS_IP, allowed: false })
    expect(status.lanArmedUntil).toBe(minted.lanArmedUntil)
  })

  it('refuses malformed claims with bad_request', () => {
    const { state } = makeState()
    const { code } = state.mint()
    expect(reasonOf(() => state.claim({ code, nonce: 'short' }, TS_IP))).toBe('bad_request')
    expect(reasonOf(() => state.claim({ code, nonce: 'has spaces in it 1234' }, TS_IP))).toBe('bad_request')
    expect(reasonOf(() => state.claim({ code: 'nope', nonce: NONCE }, TS_IP))).toBe('bad_request')
    expect(reasonOf(() => state.claim({ code: undefined, nonce: undefined }, TS_IP))).toBe('bad_request')
    expect(reasonOf(() => state.decide(NONCE, 'yes'))).toBe('bad_request')
  })

  it('never logs the code, display code, QR text, nonce or token', () => {
    const { state, logs } = makeState()
    const minted = state.mint({ allowLan: true })
    reasonOf(() => state.claim({ code: 'ZZZZZZZZ', nonce: NONCE_2 }, TS_IP_2))
    state.claim({ code: minted.code, nonce: NONCE }, TS_IP)
    state.decide(NONCE, true)
    state.poll(NONCE, TS_IP)
    state.noteAuthenticated(TS_IP)
    const joined = logs.join('\n')
    expect(logs.length).toBeGreaterThan(3)
    for (const secret of [minted.code, minted.display, minted.qr!, NONCE, NONCE_2, 'ZZZZZZZZ', TOKEN]) {
      expect(joined).not.toContain(secret)
    }
    expect(joined).toContain(`code#=${pairingCodeTag(minted.code)}`)
    expect(joined).toContain(`ip=${TS_IP}`)
  })
})

// docs/pairing-fixture.json is what the glasses repo copies for parity. Every value is
// recomputed here from the server's own code, so the fixture cannot drift from it.
describe('pairing parity fixture', () => {
  const fixturePath = new URL('../../docs/pairing-fixture.json', import.meta.url)
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))

  it('matches the grammar constants', () => {
    expect(fixture.alphabet).toBe(CROCKFORD_ALPHABET)
    expect(fixture.codeLength).toBe(8)
    expect(fixture.noncePattern).toBe(PAIRING_NONCE_PATTERN.source)
    expect(fixture.qrHostSeparator).toBe('+')
    expect(fixture.qrPattern).toBe(PAIRING_QR_PATTERN.source)
    expect(fixture.qrCharset).toBe(PAIRING_QR_CHARSET.source)
    expect(fixture.capability).toEqual({ pairing: { version: 1 } })
  })

  it('matches normalization and real buildPairingQr output', () => {
    for (const [input, out] of Object.entries(fixture.normalize)) expect(normalizePairingCode(input)).toBe(out)
    expect(fixture.examples).toHaveLength(2)
    for (const example of fixture.examples) {
      expect(displayPairingCode(example.code)).toBe(example.display)
      expect(buildPairingQr(example.code, example.hosts, example.expiresAtMs)).toBe(example.qr)
      expect(example.qr).toMatch(PAIRING_QR_PATTERN)
    }
    expect(fixture.examples[1].qr).toContain('+')
  })

  it('matches the reason list, statuses and limits', () => {
    expect(fixture.reasons).toEqual(PAIRING_REASON_STATUS)
    expect(fixture.reasonMessages).toEqual(PAIRING_REASON_MESSAGE)
    expect(Object.keys(fixture.reasons).sort()).toEqual([
      'bad_request', 'denied', 'draining', 'expired', 'locked', 'not_allowed_network', 'not_loopback', 'rate_limited', 'unknown_code', 'used',
    ])
    expect(fixture.pollStates).toEqual(['pending', 'allowed', 'denied', 'expired', 'delivered'])
    expect(fixture.limits).toEqual({
      codeTtlMs: PAIRING_CODE_TTL_MS,
      pendingTtlMs: PAIRING_PENDING_TTL_MS,
      lanArmMs: PAIRING_LAN_ARM_MS,
      claimsPerIpPerMinute: 5,
      attemptsPerCode: PAIRING_CODE_ATTEMPT_LIMIT,
      maxQrHosts: 3,
    })
  })
})
