// SR-15 (review finding 9): the 3144 signer binds only this Mac's tailnet addresses, refuses any
// connection on another local address, and status reports the certificate-disclosure facts.
// The interface fixture has the real macOS shape (os.networkInterfaces on a Mac with Tailscale, read
// 2026-11-15): loopback, Wi-Fi with a 192.168 address and a global IPv6, Tailscale's utun with a link-local,
// a 100.64/10 IPv4 and an fd7a:115c:a1e0::/48 IPv6, plus a CGNAT hotspot interface with a 100.x address.
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
  normalizeBindAddress,
  openSignerWhenTailnetAppears,
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

const iface = (address: string, family: 'IPv4' | 'IPv6' | 4 | 6, internal = false) => ({ address, family, internal })

/** A Mac on home Wi-Fi with Tailscale up. */
const MAC: InterfaceTable = {
  lo0: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true), iface('fe80::1', 'IPv6', true)],
  en0: [iface('fe80::1c2b:3d4e:5f60:7182', 'IPv6'), iface(LAN, 'IPv4'), iface('2600:1700:abcd:1230::17', 'IPv6')],
  utun4: [iface('fe80::826d:97ff:fe64:1111', 'IPv6'), iface(TS4, 'IPv4'), iface(TS6, 'IPv6')],
}
/** The same Mac with Tailscale off, tethered to a carrier-grade-NAT hotspot that hands out 100.64/10. */
const HOTSPOT_ONLY: InterfaceTable = {
  lo0: MAC.lo0,
  en0: [iface(LAN, 'IPv4')],
  en5: [iface(CGNAT, 'IPv4'), iface('fe80::aaaa:bbbb:cccc:dddd', 'IPv6')],
  utun0: [iface('fe80::2222:3333:4444:5555', 'IPv6')],
}

describe('which addresses are this Mac\'s tailnet addresses', () => {
  it('finds the utun IPv4 and IPv6 only, IPv4 first: never loopback, LAN, global IPv6 or link-local', () => {
    expect(tailnetInterfaceAddresses(MAC)).toEqual([TS4, TS6])
  })

  it('refuses a 100.64/10 address on an interface with no Tailscale IPv6 (CGNAT hotspot)', () => {
    expect(isTailnetAddress(CGNAT)).toBe(true) // in range...
    expect(tailnetInterfaceAddresses(HOTSPOT_ONLY)).toEqual([]) // ...but not Tailscale's interface
    expect(tailnetInterfaceAddresses({ ...MAC, en5: [iface(CGNAT, 'IPv4')] })).toEqual([TS4, TS6])
  })

  it('on Tailscale\'s own interface, takes only the tailnet-range addresses (never a LAN or other IPv4 or IPv6 it also carries)', () => {
    // Found by the mutation gate (iface-v4-range survived): no fixture had a non-tailnet IPv4 on the tailnet interface.
    expect(tailnetInterfaceAddresses({ utun4: [iface(LAN, 'IPv4'), iface('10.0.0.5', 'IPv4'), iface(TS4, 'IPv4'), iface(TS6, 'IPv6'), iface('2600:1700:abcd:1230::17', 'IPv6')] })).toEqual([TS4, TS6])
    expect(tailnetInterfaceAddresses({ tailscale0: [iface('10.0.0.5', 'IPv4'), iface(TS4, 'IPv4')] })).toEqual([TS4])
  })

  it('accepts numeric families (older Node) and a Linux tailscale0 interface without IPv6', () => {
    expect(tailnetInterfaceAddresses({ utun3: [iface(TS4, 4), iface(TS6, 6)] })).toEqual([TS4, TS6])
    expect(tailnetInterfaceAddresses({ tailscale0: [iface(TS4, 'IPv4')], eth0: [iface('10.0.0.5', 'IPv4')] })).toEqual([TS4])
  })

  it('never takes an internal address even in the tailnet ranges, and drops duplicates', () => {
    expect(tailnetInterfaceAddresses({ utun9: [iface(TS4, 'IPv4', true), iface(TS6, 'IPv6', true)] })).toEqual([])
    expect(tailnetInterfaceAddresses({ utun4: [iface(TS4, 'IPv4'), iface(TS6, 'IPv6')], utun5: [iface(TS6, 'IPv6'), iface(TS4, 'IPv4')] })).toEqual([TS4, TS6])
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

  it('no tailnet address (Tailscale off, CGNAT hotspot only): does not open, says why', () => {
    expect(plan(HOTSPOT_ONLY)).toEqual({ scope: 'none', addresses: [], reason: 'no_tailnet_address' })
    expect(plan({})).toEqual({ scope: 'none', addresses: [], reason: 'no_tailnet_address' })
  })

  it('BIND_HOST naming loopback or a LAN address: the signer does not open (less exposure asked for)', () => {
    expect(plan(MAC, '127.0.0.1')).toEqual({ scope: 'none', addresses: [], reason: 'bind_host_not_tailnet' })
    expect(plan(MAC, LAN)).toEqual({ scope: 'none', addresses: [], reason: 'bind_host_not_tailnet' })
  })

  it('BIND_HOST naming one of this Mac\'s tailnet addresses: exactly that one', () => {
    expect(plan(MAC, TS6)).toEqual({ scope: 'tailnet', addresses: [TS6], reason: null })
  })

  it('BIND_HOST in the tailnet range but not on Tailscale\'s interface (CGNAT): no_tailnet_address', () => {
    expect(plan({ ...MAC, en5: [iface(CGNAT, 'IPv4')] }, CGNAT)).toEqual({ scope: 'none', addresses: [], reason: 'no_tailnet_address' })
  })

  it('no https pair: https_unavailable before anything else', () => {
    expect(plan(MAC, undefined, false)).toEqual({ scope: 'none', addresses: [], reason: 'https_unavailable' })
  })
})

describe('per-connection refusal (defense in depth)', () => {
  const bound = [TS4, TS6]

  it('serves only a local address that is in the tailnet range AND one of the bound addresses', () => {
    expect(signerConnectionAllowed(TS4, bound)).toBe(true)
    expect(signerConnectionAllowed(TS6, bound)).toBe(true)
    expect(signerConnectionAllowed(`::ffff:${TS4}`, bound)).toBe(true)
    expect(signerConnectionAllowed(LAN, bound)).toBe(false)
    expect(signerConnectionAllowed('127.0.0.1', bound)).toBe(false)
    expect(signerConnectionAllowed('::1', bound)).toBe(false)
    expect(signerConnectionAllowed(CGNAT, bound)).toBe(false) // in range, never bound
    expect(signerConnectionAllowed(undefined, bound)).toBe(false)
  })

  it('a bound list carrying a non-tailnet address still refuses it (the range check is not the list\'s job)', () => {
    expect(signerConnectionAllowed(LAN, [LAN])).toBe(false)
    expect(signerConnectionAllowed('127.0.0.1', ['127.0.0.1'])).toBe(false)
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

    it('a connection on loopback (not a tailnet address) is destroyed before the handler runs', async () => {
      const lines: string[] = []
      const s = await serve(server => guardSignerConnections(server, ['127.0.0.1'], { log: l => lines.push(l) }))
      const r = await get(s.port)
      expect(r.ok).toBe(false)
      expect(s.handled()).toBe(0)
      expect(s.refused()).toBe(1)
      expect(lines).toEqual(['[web-key-signer] refused a 3144 connection on a non-tailnet address (1 so far)'])
    })

    it('a connection the predicate allows is served normally', async () => {
      const seen: unknown[] = []
      const s = await serve(server => guardSignerConnections(server, [], { allowed: addr => { seen.push(addr); return true } }))
      expect(await get(s.port)).toEqual({ ok: true, body: 'signed' })
      expect(s.handled()).toBe(1)
      expect(s.refused()).toBe(0)
      expect(seen).toEqual(['127.0.0.1'])
    })

    it('a predicate that throws refuses', async () => {
      const s = await serve(server => guardSignerConnections(server, [], { allowed: () => { throw new Error('boom') } }))
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

describe('late open (Tailscale comes up after the server)', () => {
  function rig(plans: Array<SignerBindPlan | Error>, opens: boolean[] = []) {
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
    const opened: SignerBindPlan[] = []
    let i = 0
    const ctl = openSignerWhenTailnetAppears({
      plan: () => { const p = plans[Math.min(i++, plans.length - 1)]; if (p instanceof Error) throw p; return p },
      open: async p => { opened.push(p); return opens.length ? opens.shift()! : true },
      schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true } } },
    })
    const fire = async () => { const t = timers.filter(x => !x.cancelled).at(-1)!; t.cancelled = true; t.fn(); await new Promise(r => setImmediate(r)) }
    return { ctl, timers, opened, fire, live: () => timers.filter(x => !x.cancelled).length }
  }
  const none: SignerBindPlan = { scope: 'none', addresses: [], reason: 'no_tailnet_address' }
  const tail: SignerBindPlan = { scope: 'tailnet', addresses: [TS4, TS6], reason: null }

  it('waits while there is no address, opens exactly the tailnet plan once one appears, then stops looking', async () => {
    const r = rig([none, none, tail])
    expect(r.timers[0].ms).toBe(SIGNER_BIND_RESCAN_MS)
    await r.fire(); await r.fire()
    expect(r.opened).toEqual([])
    await r.fire()
    expect(r.opened).toEqual([tail])
    expect(r.ctl.opened()).toBe(true)
    expect(r.live()).toBe(0)
  })

  it('a failed open (port taken) tries again on the next scan', async () => {
    const r = rig([tail], [false, true])
    await r.fire()
    expect(r.ctl.opened()).toBe(false)
    expect(r.live()).toBe(1)
    await r.fire()
    expect(r.opened).toEqual([tail, tail])
    expect(r.ctl.opened()).toBe(true)
  })

  it('never opens a plan that is not tailnet, even one carrying addresses', async () => {
    const r = rig([{ scope: 'none', addresses: [LAN], reason: 'bind_host_not_tailnet' }, new Error('ifaces')])
    await r.fire(); await r.fire()
    expect(r.opened).toEqual([])
    expect(r.live()).toBe(1)
  })

  it('stop cancels the pending scan', () => {
    const r = rig([none])
    r.ctl.stop()
    expect(r.live()).toBe(0)
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

  it('the signer binds each planned tailnet address, guarded, and never BIND_HOST', () => {
    const signerPart = loop.slice(loop.indexOf('    continue\n  }\n'))
    expect(signerPart).not.toContain('host: BIND_HOST')
    expect(signerPart).toContain('const signerListeners = (plan: SignerBindPlan): RequiredListener[] => plan.addresses.map(address => {')
    expect(signerPart).toContain('    guardSignerConnections(server, plan.addresses, { log: line => console.warn(line) })\n')
    expect(signerPart).toContain('    return { server, port: entry.port, host: address, label: entry.label }\n')
    expect(signerPart).toContain("  if (webKeySignerBindPlan.scope === 'tailnet') {\n    listeners.push(...signerListeners(webKeySignerBindPlan))\n")
    expect(count('planSignerBind({ nets: networkInterfaces(), bindHost: process.env.BIND_HOST, httpsAvailable })')).toBe(2)
  })

  it('status reports the facts; the late opener stops at shutdown', () => {
    expect(count('  signerFacts: webKeySignerFacts,\n')).toBe(1)
    expect(count('  signerBindFixVersion: SIGNER_BIND_FIX_VERSION,\n')).toBe(1)
    expect(count('certDisclosure: readCertDisclosure({ dir: dataPath(SIGNER_TLS_DIR), certFile: SIGNER_TLS_CERT_FILE, selfDnsName: webKeySelfDnsName() }),')).toBe(1)
    expect(count('  webKeySignerLateOpen?.stop()\n')).toBe(1)
    expect(index.indexOf('  webKeySignerLateOpen?.stop()\n')).toBeGreaterThan(index.indexOf('async function gracefulShutdown(): Promise<void> {'))
  })
})
