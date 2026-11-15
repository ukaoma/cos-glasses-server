// SR-15 (review finding 9) and fix round 1 (review PA-R S1, S2, S4): the 3144 signer binds only this Mac's
// tailnet addresses on Tailscale's OWN interface, refuses any connection that is not tailnet to tailnet,
// follows address changes, and status reports the certificate-disclosure facts.
// Fixtures have the real macOS shape (os.networkInterfaces with `cidr`, read on a Mac with Tailscale
// 2026-11-15): loopback; Wi-Fi with a 192.168 address and a global IPv6; Tailscale's utun with a link-local,
// a 100.64/10 IPv4 /32 and an fd7a:115c:a1e0::/48 IPv6. Hostile shapes: hotel Wi-Fi whose en0 also carries
// an RA-announced fd7a /64 and a rogue-DHCP 100.x /16; a CGNAT hotspot; a utun with only one family.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  guardSignerConnections,
  isTailnetAddress,
  isTailscaleInterface,
  keepSignerBind,
  nonTailscaleSubnets,
  normalizeBindAddress,
  planSignerBind,
  readCertDisclosure,
  SIGNER_BIND_FIX_VERSION,
  SIGNER_BIND_RESCAN_MS,
  signerBindStatus,
  signerConnectionAllowed,
  tailnetInterfaceAddresses,
  type InterfaceTable,
  type SignerBindPlan,
} from './web-key-signer-bind.js'

const TS4 = '100.101.102.103'
const TS6 = 'fd7a:115c:a1e0::1234:5678'
const LAN = '192.168.1.23'
const CGNAT = '100.72.3.4'
const PHONE4 = '100.90.1.2'
const PHONE6 = 'fd7a:115c:a1e0::aaaa:1'
/** What a hostile LAN can put on en0: a rogue-DHCP 100.x in a /16 and an RA-announced fd7a /64. */
const EVIL4 = '100.90.7.7'
const EVIL6 = 'fd7a:115c:a1e0:5555::77'

const iface = (address: string, family: 'IPv4' | 'IPv6' | 4 | 6, prefix: number | null = null, internal = false) =>
  ({ address, family, internal, cidr: prefix === null ? null : `${address}/${prefix}` })

const LO = [iface('127.0.0.1', 'IPv4', 8, true), iface('::1', 'IPv6', 128, true), iface('fe80::1', 'IPv6', 64, true)]
const UTUN = [iface('fe80::826d:97ff:fe64:1111', 'IPv6', 64), iface(TS4, 'IPv4', 32), iface(TS6, 'IPv6', 48)]
/** A Mac on home Wi-Fi with Tailscale up. */
const MAC: InterfaceTable = {
  lo0: LO,
  en0: [iface('fe80::1c2b:3d4e:5f60:7182', 'IPv6', 64), iface(LAN, 'IPv4', 24), iface('2600:1700:abcd:1230::17', 'IPv6', 64)],
  utun4: UTUN,
}
/** Hotel Wi-Fi run by an attacker: en0 carries BOTH tailnet ranges. Tailscale up or not. */
const HOTEL_EN0 = [iface('fe80::1c2b:3d4e:5f60:7182', 'IPv6', 64), iface(EVIL4, 'IPv4', 16), iface(EVIL6, 'IPv6', 64)]
const HOTEL_TS_DOWN: InterfaceTable = { lo0: LO, en0: HOTEL_EN0, utun0: [iface('fe80::2222:3333:4444:5555', 'IPv6', 64)] }
const HOTEL_TS_UP: InterfaceTable = { lo0: LO, en0: HOTEL_EN0, utun4: UTUN }
/** Tailscale off, tethered to a carrier-grade-NAT hotspot. */
const HOTSPOT_ONLY: InterfaceTable = { lo0: LO, en0: [iface(LAN, 'IPv4', 24)], en5: [iface(CGNAT, 'IPv4', 24), iface('fe80::aaaa:bbbb:cccc:dddd', 'IPv6', 64)] }

describe('which interface is Tailscale\'s (review S1)', () => {
  it('home Wi-Fi: only the utun IPv4 and IPv6, IPv4 first; never loopback, LAN, global IPv6 or link-local', () => {
    expect(tailnetInterfaceAddresses(MAC)).toEqual([TS4, TS6])
  })

  it('hostile hotel en0 with an RA fd7a /64 and a rogue-DHCP 100.x: refused, Tailscale down or up', () => {
    expect(isTailnetAddress(EVIL4) && isTailnetAddress(EVIL6)).toBe(true) // both in range...
    expect(isTailscaleInterface('en0', HOTEL_EN0)).toBe(false) // ...but en0 is never Tailscale's
    expect(tailnetInterfaceAddresses(HOTEL_TS_DOWN)).toEqual([])
    expect(tailnetInterfaceAddresses(HOTEL_TS_UP)).toEqual([TS4, TS6])
  })

  it('a utun with only one family is not Tailscale\'s (both a 100.64/10 IPv4 and an fd7a IPv6 are required)', () => {
    expect(tailnetInterfaceAddresses({ utun4: [iface(TS4, 'IPv4', 32)] })).toEqual([])
    expect(tailnetInterfaceAddresses({ utun4: [iface(TS6, 'IPv6', 48)] })).toEqual([])
    expect(tailnetInterfaceAddresses({ utun4: [iface(TS4, 'IPv4', 32), iface('fd00:1::5', 'IPv6', 64)] })).toEqual([])
    expect(tailnetInterfaceAddresses({ utun4: [iface('10.8.0.2', 'IPv4', 24), iface(TS6, 'IPv6', 48)] })).toEqual([])
  })

  it('names: utun<N> only on macOS (not utun-ish names), tailscale<N> on Linux', () => {
    expect(isTailscaleInterface('utun7', UTUN)).toBe(true)
    expect(isTailscaleInterface('xutun4', UTUN)).toBe(false)
    expect(isTailscaleInterface('utun', UTUN)).toBe(false)
    expect(isTailscaleInterface('en0', UTUN)).toBe(false)
    expect(isTailscaleInterface('bridge100', UTUN)).toBe(false)
    expect(tailnetInterfaceAddresses({ tailscale0: [iface(TS4, 'IPv4', 32)], eth0: [iface('10.0.0.5', 'IPv4', 24)] })).toEqual([TS4])
  })

  it('on Tailscale\'s own interface, takes only the tailnet-range addresses', () => {
    expect(tailnetInterfaceAddresses({ utun4: [iface(LAN, 'IPv4', 24), iface('10.0.0.5', 'IPv4', 8), iface(TS4, 'IPv4', 32), iface(TS6, 'IPv6', 48), iface('2600:1700:abcd:1230::17', 'IPv6', 64)] })).toEqual([TS4, TS6])
    expect(tailnetInterfaceAddresses({ tailscale0: [iface('10.0.0.5', 'IPv4', 8), iface(TS4, 'IPv4', 32)] })).toEqual([TS4])
  })

  it('numeric families (older Node), internal rows never count, duplicates dropped', () => {
    expect(tailnetInterfaceAddresses({ utun3: [iface(TS4, 4, 32), iface(TS6, 6, 48)] })).toEqual([TS4, TS6])
    expect(tailnetInterfaceAddresses({ utun9: [iface(TS4, 'IPv4', 32, true), iface(TS6, 'IPv6', 48, true)] })).toEqual([])
    // An internal row never vouches for the interface (found by the gate: iface-internal-counts survived).
    expect(tailnetInterfaceAddresses({ utun9: [iface(TS4, 'IPv4', 32), iface(TS6, 'IPv6', 48, true)] })).toEqual([])
    expect(tailnetInterfaceAddresses({ utun9: [iface(TS4, 'IPv4', 32, true), iface(TS6, 'IPv6', 48)] })).toEqual([])
    expect(tailnetInterfaceAddresses({ utun4: [iface(TS4, 'IPv4', 32), iface(TS6, 'IPv6', 48)], utun5: [iface(TS6, 'IPv6', 48), iface(TS4, 'IPv4', 32)] })).toEqual([TS4, TS6])
  })

  it('normalizes IPv4-mapped, zone ids and case', () => {
    expect(normalizeBindAddress(`::ffff:${TS4}`)).toBe(TS4)
    expect(normalizeBindAddress('FD7A:115C:A1E0::1234:5678%utun4')).toBe(TS6)
    expect(normalizeBindAddress(undefined)).toBe('')
  })
})

describe('the bind plan', () => {
  const plan = (nets: InterfaceTable, bindHost?: string, httpsAvailable = true) => planSignerBind({ nets, bindHost, httpsAvailable })

  it('default (BIND_HOST unset or a wildcard): the tailnet addresses, never 0.0.0.0', () => {
    for (const host of [undefined, '', '0.0.0.0', '::']) {
      expect(plan(MAC, host)).toEqual({ scope: 'tailnet', addresses: [TS4, TS6], reason: null })
    }
  })

  it('no tailnet interface (Tailscale off; hostile hotel; CGNAT hotspot): does not open, says why', () => {
    for (const nets of [HOTEL_TS_DOWN, HOTSPOT_ONLY, {}]) expect(plan(nets)).toEqual({ scope: 'none', addresses: [], reason: 'no_tailnet_address' })
  })

  it('hostile hotel with Tailscale up: binds only the utun pair, never en0\'s look-alikes', () => {
    expect(plan(HOTEL_TS_UP)).toEqual({ scope: 'tailnet', addresses: [TS4, TS6], reason: null })
    expect(plan(HOTEL_TS_UP, EVIL4)).toEqual({ scope: 'none', addresses: [], reason: 'no_tailnet_address' })
  })

  it('BIND_HOST naming loopback or a LAN address: the signer does not open (less exposure asked for)', () => {
    expect(plan(MAC, '127.0.0.1')).toEqual({ scope: 'none', addresses: [], reason: 'bind_host_not_tailnet' })
    expect(plan(MAC, LAN)).toEqual({ scope: 'none', addresses: [], reason: 'bind_host_not_tailnet' })
  })

  it('BIND_HOST naming one of this Mac\'s tailnet addresses: exactly that one', () => {
    expect(plan(MAC, TS6)).toEqual({ scope: 'tailnet', addresses: [TS6], reason: null })
  })

  it('no https pair: https_unavailable before anything else', () => {
    expect(plan(MAC, undefined, false)).toEqual({ scope: 'none', addresses: [], reason: 'https_unavailable' })
  })
})

describe('per-connection refusal (defense in depth, review S2)', () => {
  const bound = [TS4, TS6]
  const ok = (local: unknown, remote: unknown, nets: InterfaceTable = MAC, b: readonly string[] = bound) => signerConnectionAllowed(local, remote, b, nets)

  it('tailnet to tailnet: a phone on its tailnet IPv4 or IPv6, to a bound address, is served', () => {
    expect(ok(TS4, PHONE4)).toBe(true)
    expect(ok(TS6, PHONE6)).toBe(true)
    expect(ok(`::ffff:${TS4}`, `::ffff:${PHONE4}`)).toBe(true)
    expect(ok(TS4, TS4)).toBe(true) // this Mac fetching its own signer over its tailnet name
  })

  it('local address: must be tailnet-range AND one of the bound addresses', () => {
    expect(ok(LAN, PHONE4)).toBe(false)
    expect(ok('127.0.0.1', PHONE4)).toBe(false)
    expect(ok(CGNAT, PHONE4)).toBe(false) // in range, never bound
    expect(ok(undefined, PHONE4)).toBe(false)
    expect(ok(LAN, PHONE4, MAC, [LAN])).toBe(false) // the range check is not the list's job
  })

  it('remote address: a LAN, loopback or global caller is refused even on a bound address', () => {
    expect(ok(TS4, '192.168.1.50')).toBe(false)
    expect(ok(TS4, '127.0.0.1')).toBe(false)
    expect(ok(TS6, '2600:1700:abcd:1230::99')).toBe(false)
    expect(ok(TS4, undefined)).toBe(false)
  })

  it('weak host: a "tailnet" remote inside a non-Tailscale interface\'s subnet is refused (hotel /16 and RA /64)', () => {
    // The hostile LAN's DHCP /16 contains the phone's tailnet IP, and its RA /64 an fd7a address.
    expect(ok(TS4, PHONE4, HOTEL_TS_UP)).toBe(false)
    expect(ok(TS6, 'fd7a:115c:a1e0:5555::1', HOTEL_TS_UP)).toBe(false)
    // Outside those subnets the real tailnet still works on the same network.
    expect(ok(TS4, '100.101.9.9', HOTEL_TS_UP)).toBe(true)
    expect(ok(TS6, PHONE6, HOTEL_TS_UP)).toBe(true)
  })

  it('Tailscale\'s own subnets never refuse (the utun fd7a /48 covers every tailnet IPv6)', () => {
    expect(nonTailscaleSubnets({ utun4: UTUN })).toBeNull()
    expect(ok(TS6, PHONE6, { utun4: UTUN })).toBe(true)
  })

  it('a CGNAT hotspot whose subnet covers the phone: refused (fails closed on that network)', () => {
    const nets = { ...MAC, en5: [iface('100.90.0.1', 'IPv4', 16)] }
    expect(ok(TS4, PHONE4, nets)).toBe(false)
  })

  it('rows without a cidr, or malformed, are skipped (no throw)', () => {
    expect(nonTailscaleSubnets({ en0: [iface(LAN, 'IPv4', null)], en1: [{ address: LAN, family: 'IPv4', internal: false, cidr: 'junk/xx' }] })).toBeNull()
  })

  it('the default guard reads the socket\'s remote address and the live table: a LAN remote on a bound address is destroyed', () => {
    const sockets: Array<{ localAddress: string; remoteAddress: string; destroyed: number }> = []
    let handler: (socket: unknown) => void = () => {}
    const fake = { on: (_event: string, fn: (socket: unknown) => void) => { handler = fn } } as unknown as Server
    let table: InterfaceTable = MAC
    const refused = guardSignerConnections(fake, [TS4], { nets: () => table })
    const connect = (localAddress: string, remoteAddress: string) => {
      const s = { localAddress, remoteAddress, destroyed: 0, destroy() { this.destroyed++ } }
      sockets.push(s)
      handler(s)
      return s.destroyed
    }
    expect(connect(TS4, '192.168.1.50')).toBe(1)
    expect(connect(TS4, PHONE4)).toBe(0)
    table = HOTEL_TS_UP // joined the hostile hotel: the same phone address is now on-link through en0
    expect(connect(TS4, PHONE4)).toBe(1)
    expect(refused()).toBe(2)
  })

  describe('on a real server', () => {
    const open: Server[] = []
    afterAll(async () => { await Promise.all(open.map(s => new Promise(r => s.close(r)))) })

    async function serve(guard: (server: Server) => () => number): Promise<{ port: number; handled: () => number; refused: () => number }> {
      let handled = 0
      const server = createServer((_req, res) => { handled++; res.end('signed') })
      const refused = guard(server)
      open.push(server)
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
      return { port: (server.address() as AddressInfo).port, handled: () => handled, refused }
    }
    const get = (port: number) => new Promise<{ ok: boolean; body?: string; error?: string }>(resolve => {
      const req = request({ host: '127.0.0.1', port, path: '/', agent: false }, res => {
        let body = ''
        res.on('data', c => { body += c })
        res.on('end', () => resolve({ ok: true, body }))
      })
      req.on('error', e => resolve({ ok: false, error: (e as NodeJS.ErrnoException).code ?? e.message }))
      req.end()
    })

    it('a loopback connection (not tailnet to tailnet) is destroyed before the handler runs', async () => {
      const lines: string[] = []
      const s = await serve(server => guardSignerConnections(server, ['127.0.0.1'], { nets: () => MAC, log: l => lines.push(l) }))
      const r = await get(s.port)
      expect(r.ok).toBe(false)
      expect(s.handled()).toBe(0)
      expect(s.refused()).toBe(1)
      expect(lines).toEqual(['[web-key-signer] refused a 3144 connection that is not tailnet to tailnet (1 so far)'])
    })

    it('the guard hands the predicate the real local AND remote address; allowed is served', async () => {
      const seen: unknown[] = []
      const s = await serve(server => guardSignerConnections(server, [], { nets: () => MAC, allowed: (local, remote) => { seen.push([local, remote]); return true } }))
      expect(await get(s.port)).toEqual({ ok: true, body: 'signed' })
      expect(s.handled()).toBe(1)
      expect(s.refused()).toBe(0)
      expect(seen).toEqual([['127.0.0.1', '127.0.0.1']])
    })

    it('a predicate that throws refuses', async () => {
      const s = await serve(server => guardSignerConnections(server, [], { nets: () => MAC, allowed: () => { throw new Error('boom') } }))
      expect((await get(s.port)).ok).toBe(false)
      expect(s.handled()).toBe(0)
    })
  })
})

describe('status shape', () => {
  it('listening is true only for a tailnet plan with a live listener', () => {
    const tail: SignerBindPlan = { scope: 'tailnet', addresses: [TS4, TS6], reason: null }
    const none: SignerBindPlan = { scope: 'none', addresses: [], reason: 'no_tailnet_address' }
    expect(signerBindStatus(tail, true)).toEqual({ scope: 'tailnet', addresses: [TS4, TS6], reason: null, listening: true })
    expect(signerBindStatus(tail, false).listening).toBe(false)
    expect(signerBindStatus(none, true)).toEqual({ scope: 'none', addresses: [], reason: 'no_tailnet_address', listening: false })
    expect(SIGNER_BIND_FIX_VERSION).toBe(1)
  })

  it('returns a copy of the addresses (a caller cannot edit the plan)', () => {
    const tail: SignerBindPlan = { scope: 'tailnet', addresses: [TS4], reason: null }
    signerBindStatus(tail, true).addresses.push(LAN)
    expect(tail.addresses).toEqual([TS4])
  })
})

describe('the keeper (late open, lost or changed addresses; review S4)', () => {
  const none: SignerBindPlan = { scope: 'none', addresses: [], reason: 'no_tailnet_address' }
  const tail: SignerBindPlan = { scope: 'tailnet', addresses: [TS4, TS6], reason: null }
  const tail4: SignerBindPlan = { scope: 'tailnet', addresses: [TS4], reason: null }

  function rig(initial: SignerBindPlan, plans: Array<SignerBindPlan | Error>, opens: boolean[] = []) {
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
    const events: string[] = []
    let live = initial.scope === 'tailnet'
    let i = 0
    const keeper = keepSignerBind({
      initial,
      plan: () => { const p = plans[Math.min(i++, plans.length - 1)]; if (p instanceof Error) throw p; return p },
      open: async p => { events.push(`open ${p.addresses.join(',')}`); const r = opens.length ? opens.shift()! : true; if (r) live = true; return r },
      close: async () => { events.push('close'); live = false },
      listening: () => live,
      schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true } } },
    })
    const fire = async () => { const t = timers.filter(x => !x.cancelled).at(-1)!; t.cancelled = true; t.fn(); await new Promise(r => setImmediate(r)) }
    return { keeper, timers, events, fire, kill: () => { live = false }, pending: () => timers.filter(x => !x.cancelled).length }
  }

  it('login race: waits while there is no address, then opens exactly the tailnet plan', async () => {
    const r = rig(none, [none, tail])
    expect(r.timers[0].ms).toBe(SIGNER_BIND_RESCAN_MS)
    expect(r.keeper.status()).toEqual(none)
    await r.fire()
    expect(r.events).toEqual([])
    await r.fire()
    expect(r.events).toEqual([`open ${TS4},${TS6}`])
    expect(r.keeper.status()).toEqual(tail)
    expect(r.pending()).toBe(1) // keeps watching after opening
  })

  it('bound at boot and nothing changes: no close, no open, status stays the plan', async () => {
    const r = rig(tail, [tail, { ...tail, addresses: [TS6, TS4] }])
    await r.fire(); await r.fire()
    expect(r.events).toEqual([])
    expect(r.keeper.status()).toEqual(tail)
  })

  it('Tailscale goes down while bound: closes, and reports address_lost instead of a dead listener', async () => {
    const r = rig(tail, [none, none])
    await r.fire()
    expect(r.events).toEqual(['close'])
    expect(r.keeper.status()).toEqual({ scope: 'none', addresses: [], reason: 'address_lost' })
    await r.fire()
    expect(r.keeper.status().reason).toBe('address_lost') // until a later open succeeds
  })

  it('the address set changes: closes the stale listeners first, then opens the new set in the same scan', async () => {
    const r = rig(tail, [tail4])
    await r.fire()
    expect(r.events).toEqual(['close', `open ${TS4}`])
    expect(r.keeper.status()).toEqual(tail4)
  })

  it('a dead listener with an unchanged plan is reopened', async () => {
    const r = rig(tail, [tail])
    r.kill()
    await r.fire()
    expect(r.events).toEqual(['close', `open ${TS4},${TS6}`])
  })

  it('a failed open (port taken) says listen_failed and tries again on the next scan', async () => {
    const r = rig(none, [tail], [false, true])
    await r.fire()
    expect(r.keeper.status()).toEqual({ scope: 'none', addresses: [], reason: 'listen_failed' })
    await r.fire()
    expect(r.events).toEqual([`open ${TS4},${TS6}`, `open ${TS4},${TS6}`])
    expect(r.keeper.status()).toEqual(tail)
  })

  it('never opens a plan that is not tailnet, even one carrying addresses; a throwing plan opens nothing', async () => {
    const r = rig(none, [{ scope: 'none', addresses: [LAN], reason: 'bind_host_not_tailnet' }, new Error('ifaces')])
    await r.fire(); await r.fire()
    expect(r.events).toEqual([])
    expect(r.pending()).toBe(1)
  })

  it('stop cancels the pending scan', () => {
    const r = rig(none, [none])
    r.keeper.stop()
    expect(r.pending()).toBe(0)
  })
})

describe('certificate disclosure (read only)', () => {
  const NAME = 'studio-mac.tail00000a.ts.net'
  const OPENSSL = existsSync('/usr/bin/openssl') ? '/usr/bin/openssl' : 'openssl'
  let dir: string
  const certFor = (tag: string, san: string): string => {
    execFileSync(OPENSSL, ['req', '-x509', '-sha256', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', `${tag}.key`, '-out', `${tag}.pem`, '-days', '2', '-subj', `/CN=${tag}`, '-addext', `subjectAltName=${san}`], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    return readFileSync(join(dir, `${tag}.pem`), 'utf8')
  }
  let mine: string
  let other: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'signer-bind-cert-'))
    mine = certFor('mine', `DNS:${NAME}`)
    other = certFor('other', 'DNS:other-mac.tail00000a.ts.net')
  })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })
  const store = (name: string, text: string) => { const d = mkdtempSync(join(dir, 'store-')); writeFileSync(join(d, name), text); return d }

  it('nothing stored: not issued, and the exact lower-case name a first issuance puts in public logs', () => {
    const empty = mkdtempSync(join(dir, 'empty-'))
    expect(readCertDisclosure({ dir: empty, certFile: 'tailscale-cert.pem', selfDnsName: 'Studio-Mac.tail00000a.ts.net.' })).toEqual({ issued: false, publicName: NAME })
    expect(readCertDisclosure({ dir: join(dir, 'missing'), certFile: 'tailscale-cert.pem', selfDnsName: null })).toEqual({ issued: false, publicName: null })
  })

  it('a stored certificate for this name: issued', () => {
    expect(readCertDisclosure({ dir: store('tailscale-cert.pem', mine), certFile: 'tailscale-cert.pem', selfDnsName: NAME })).toEqual({ issued: true, publicName: NAME })
  })

  it('a stored certificate for ANOTHER name (before a rename) does not count as this name issued', () => {
    expect(readCertDisclosure({ dir: store('tailscale-cert.pem', other), certFile: 'tailscale-cert.pem', selfDnsName: NAME }).issued).toBe(false)
  })

  it('name unknown: any stored ts.net certificate counts', () => {
    expect(readCertDisclosure({ dir: store('tailscale-cert.pem', other), certFile: 'tailscale-cert.pem', selfDnsName: null })).toEqual({ issued: true, publicName: null })
  })

  it('garbage, an empty file or an oversized file: not issued, never a throw', () => {
    expect(readCertDisclosure({ dir: store('tailscale-cert.pem', 'not a certificate'), certFile: 'tailscale-cert.pem', selfDnsName: NAME }).issued).toBe(false)
    expect(readCertDisclosure({ dir: store('tailscale-cert.pem', ''), certFile: 'tailscale-cert.pem', selfDnsName: NAME }).issued).toBe(false)
    expect(readCertDisclosure({ dir: store('tailscale-cert.pem', mine + 'x'.repeat(70 * 1024)), certFile: 'tailscale-cert.pem', selfDnsName: NAME }).issued).toBe(false)
  })
})

// index.ts cannot be imported in a test (importing it boots the server), so its wiring is pinned by source.
describe('index.ts wiring (source)', () => {
  const index = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')
  const count = (s: string): number => index.split(s).length - 1
  const loopStart = index.indexOf('for (const entry of listenerPlan(')
  const loop = index.slice(loopStart, index.indexOf('listenRequiredServers(listeners).then(() => {'))

  it('3141 and 3143 keep BIND_HOST; it is pushed once, only in the non-signer branch', () => {
    expect(count('host: BIND_HOST')).toBe(1)
    expect(loop).toContain("  if (!signer) {\n    listeners.push({ server: makeServer(), port: entry.port, host: BIND_HOST, label: entry.label })\n    continue\n  }\n")
    expect(count("const BIND_HOST = process.env.BIND_HOST ?? '0.0.0.0'")).toBe(1)
  })

  it('the signer binds each planned tailnet address, guarded with the live interface table, and never BIND_HOST', () => {
    const signerPart = loop.slice(loop.indexOf('    continue\n  }\n'))
    expect(signerPart).not.toContain('host: BIND_HOST')
    expect(signerPart).toContain('const signerListeners = (plan: SignerBindPlan): RequiredListener[] => plan.addresses.map(address => {')
    expect(signerPart).toContain('    guardSignerConnections(server, plan.addresses, { nets: signerNets, log: line => console.warn(line) })\n')
    expect(signerPart).toContain('  const signerNets = () => networkInterfaces()\n')
    expect(signerPart).toContain('    return { server, port: entry.port, host: address, label: entry.label }\n')
    expect(signerPart).toContain("  if (signerBootPlan.scope === 'tailnet') {\n    listeners.push(...signerListeners(signerBootPlan))\n")
    expect(count('planSignerBind({ nets: signerNets(), bindHost: process.env.BIND_HOST, httpsAvailable })')).toBe(2)
  })

  it('the keeper owns the signer: built once with the boot plan, its close empties the servers, status reads it', () => {
    expect(count('webKeySignerKeeper = keepSignerBind({')).toBe(1)
    expect(index).toContain('    initial: signerBootPlan,\n')
    expect(index).toContain('    close: closeSigner,\n')
    expect(index).toContain('    const closing = webKeySignerServers.splice(0, webKeySignerServers.length)\n')
    expect(index).toContain('    listening: () => webKeySignerServers.length > 0 && webKeySignerServers.every(server => server.listening),\n')
    expect(count('webKeySignerKeeper?.status() ?? planSignerBind(')).toBe(1)
  })

  it('status reports the facts; the keeper stops at shutdown; no claim that a wildcard squatter fails the boot', () => {
    expect(count('  signerFacts: webKeySignerFacts,\n')).toBe(1)
    expect(count('  signerBindFixVersion: SIGNER_BIND_FIX_VERSION,\n')).toBe(1)
    expect(count('certDisclosure: readCertDisclosure({ dir: dataPath(SIGNER_TLS_DIR), certFile: SIGNER_TLS_CERT_FILE, selfDnsName: webKeySelfDnsName() }),')).toBe(1)
    expect(count('  webKeySignerKeeper?.stop()\n')).toBe(1)
    expect(index.indexOf('  webKeySignerKeeper?.stop()\n')).toBeGreaterThan(index.indexOf('async function gracefulShutdown(): Promise<void> {'))
    expect(index).not.toContain('(a squatter fails the boot closed)')
    expect(index).toContain('A process holding the wildcard 0.0.0.0:3144 probably does not')
  })
})
