// X1 (iPhone pings): 3143 over https on this Mac's ts.net name (lib/control-tsnet-tls.ts). A fake Tailscale runner
// (never the real CLI), throwaway CA and leaf pairs minted per run with openssl (no private key is committed), and real
// TLS handshakes against a real https server on 127.0.0.1:0 built with 3143's options.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer, type Server } from 'node:https'
import { connect, type PeerCertificate } from 'node:tls'
import type { AddressInfo } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  controlHttpsOptions,
  controlTsnetHealthField,
  controlTsnetHealthFrom,
  controlTsnetHttpsEnabled,
  createControlTsnetTlsForBoot,
  registerControlTsnetTls,
  type ControlTsnetTls,
} from './control-tsnet-tls.js'
import { parseRootPems, SignerTls, type SignerTlsDeps } from './web-key-signer-tls.js'
import type { RunResult } from './tailscale-nudge.js'

const NAME = 'mac-x1.example-tailnet.ts.net'
const OPENSSL = existsSync('/usr/bin/openssl') ? '/usr/bin/openssl' : 'openssl'
const BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

interface Ca { pem: string; certPath: string; keyPath: string }
interface Leaf { certPem: string; keyPem: string; fingerprint: string; notAfterMs: number }
let pki: string
let tailCa: Ca
let mkcertCa: Ca
let pair: Leaf
let signerPair: Leaf
let mkcert: Leaf

function ossl(args: string[]): void { execFileSync(OPENSSL, args, { cwd: pki, stdio: ['ignore', 'pipe', 'pipe'] }) }
function mintCa(tag: string): Ca {
  ossl(['req', '-x509', '-sha256', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-keyout', `${tag}.key`, '-out', `${tag}.pem`, '-days', '3',
    '-subj', `/CN=Throwaway ${tag}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign'])
  return { pem: readFileSync(join(pki, `${tag}.pem`), 'utf8'), certPath: join(pki, `${tag}.pem`), keyPath: join(pki, `${tag}.key`) }
}
function mintLeaf(ca: Ca, tag: string, sans: string[], days = 90): Leaf {
  ossl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-keyout', `${tag}.p8`, '-out', `${tag}.csr`, '-subj', `/CN=${tag}`])
  writeFileSync(join(pki, `${tag}.ext`), `subjectAltName=${sans.join(',')}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`)
  const serial = `0x${Buffer.from(tag).toString('hex').slice(0, 16)}${Math.floor(Math.random() * 1e6).toString(16)}`
  ossl(['x509', '-req', '-sha256', '-in', `${tag}.csr`, '-CA', ca.certPath, '-CAkey', ca.keyPath, '-set_serial', serial, '-days', String(days), '-extfile', `${tag}.ext`, '-out', `${tag}.crt`])
  ossl(['ec', '-in', `${tag}.p8`, '-out', `${tag}.key`])
  const certPem = readFileSync(join(pki, `${tag}.crt`), 'utf8')
  const x = new X509Certificate(certPem)
  return { certPem, keyPem: readFileSync(join(pki, `${tag}.key`), 'utf8'), fingerprint: x.fingerprint256, notAfterMs: Date.parse(x.validTo) }
}
const certStdout = (leaf: Leaf): string => `${leaf.certPem}${tailCa.pem}${leaf.keyPem}`

beforeAll(() => {
  pki = mkdtempSync(join(tmpdir(), 'control-tsnet-pki-'))
  tailCa = mintCa('tailca')
  mkcertCa = mintCa('mkcertca')
  pair = mintLeaf(tailCa, 'pair', [`DNS:${NAME}`])
  signerPair = mintLeaf(tailCa, 'signer-pair', [`DNS:${NAME}`])
  // The 3143 default: an mkcert-style pair for the names existing clients use.
  mkcert = mintLeaf(mkcertCa, 'mkcert', ['DNS:api.gotcos.com', 'DNS:localhost', 'IP:127.0.0.1', 'IP:100.112.1.2'], 2)
})
afterAll(() => { rmSync(pki, { recursive: true, force: true }) })

const ok = (stdout: string): RunResult => ({ code: 0, signal: null, killed: false, stdout, stderr: '', elapsedMs: 3 })
const fail = (): RunResult => ({ code: 1, signal: null, killed: false, stdout: '', stderr: 'acme: rate limited', elapsedMs: 3 })
const statusJson = (): string => JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${NAME}.`, TailscaleIPs: ['100.112.1.2'] }, CertDomains: [NAME], Peer: {} })

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
afterEach(() => registerControlTsnetTls(null))

/** Test deps for a SignerTls: the throwaway CA as the only root, a fake runner, a fake clock. */
function deps(leaf: Leaf, clock: { now: number }, calls: string[], certAnswer: { r: RunResult } = { r: ok(certStdout(leaf)) }): SignerTlsDeps {
  const base = mkdtempSync(join(tmpdir(), 'control-tsnet-data-'))
  dirs.push(base)
  return {
    dir: join(base, 'web-key-tls'),
    selfDnsName: async () => NAME,
    resolveBin: () => BIN,
    now: () => clock.now,
    log: () => {},
    schedule: () => ({ cancel: () => {} }),
    roots: parseRootPems([tailCa.pem]),
    runner: async (_bin, args) => {
      calls.push(String(args[0]))
      return args[0] === 'status' ? ok(statusJson()) : certAnswer.r
    },
  }
}

const servers: Server[] = []
afterEach(async () => { while (servers.length) { const s = servers.pop()!; await new Promise<void>(r => s.close(() => r())) } })
/** A real https server built exactly as index.ts builds 3143: controlHttpsOptions(mkcert pair, instance or null). */
async function serve3143(tls: ControlTsnetTls | null): Promise<number> {
  const server = createHttpsServer(controlHttpsOptions({ cert: mkcert.certPem, key: mkcert.keyPem }, tls), (_q, s) => { s.end('ok') })
  servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  return (server.address() as AddressInfo).port
}
function served(port: number, servername?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: '127.0.0.1', port, ...(servername ? { servername } : {}), rejectUnauthorized: false }, () => {
      const peer: PeerCertificate = sock.getPeerCertificate()
      resolve(peer.fingerprint256)
      sock.end()
    })
    sock.on('error', reject)
  })
}
const tick = () => new Promise(r => setImmediate(r))

describe('X1: the switch COS_CONTROL_TSNET_HTTPS', () => {
  it('is off by default and on only for 1, true or on', () => {
    expect(controlTsnetHttpsEnabled({})).toBe(false)
    for (const on of ['1', 'true', 'on', ' TRUE ']) expect(controlTsnetHttpsEnabled({ COS_CONTROL_TSNET_HTTPS: on })).toBe(true)
    for (const off of ['', '0', 'false', 'off', 'yes', '2']) expect(controlTsnetHttpsEnabled({ COS_CONTROL_TSNET_HTTPS: off })).toBe(false)
  })

  it('is listed in the managed runtime contract and in .env.example, commented out at its non-default value', () => {
    const contract = JSON.parse(readFileSync(new URL('../../managed-runtime-contract.json', import.meta.url), 'utf8'))
    expect(JSON.stringify(contract)).toContain('"COS_CONTROL_TSNET_HTTPS"')
    expect(readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')).toMatch(/^# COS_CONTROL_TSNET_HTTPS=1$/m)
  })
})

describe('X1: off, 3143 is exactly as before', () => {
  it('no instance: the switch off, or no mkcert pair (no 3143), whatever else holds', () => {
    let made = 0
    const make = (d: SignerTlsDeps) => { made++; return new SignerTls(d) }
    const calls: string[] = []
    const d = deps(pair, { now: Date.now() }, calls)
    expect(createControlTsnetTlsForBoot({ enabled: false, httpsAvailable: true }, () => null, d, make)).toBeNull()
    expect(createControlTsnetTlsForBoot({ enabled: true, httpsAvailable: false }, () => null, d, make)).toBeNull()
    expect(made).toBe(0)
    expect(calls).toEqual([])
    expect(existsSync(d.dir)).toBe(false)
  })

  it('3143\'s options are the mkcert pair alone, with no SNICallback, and health has no field', () => {
    const base = { cert: mkcert.certPem, key: mkcert.keyPem }
    const opts = controlHttpsOptions(base, null)
    expect(opts).toEqual(base)
    expect('SNICallback' in opts).toBe(false)
    registerControlTsnetTls(null)
    expect(controlTsnetHealthField()).toEqual({})
  })

  it('a handshake off gets mkcert for every name, the ts.net name included', async () => {
    const port = await serve3143(null)
    for (const name of [NAME, 'localhost', 'api.gotcos.com', undefined]) expect(await served(port, name)).toBe(mkcert.fingerprint)
  })
})

describe('X1: on, exact-name SNI on 3143', () => {
  it('its own instance: made and started only by start(); the ts.net name gets the trusted pair, every other name keeps mkcert', async () => {
    let made = 0
    const calls: string[] = []
    const clock = { now: Date.now() }
    const tls = createControlTsnetTlsForBoot({ enabled: true, httpsAvailable: true }, () => null, deps(pair, clock, calls), d => { made++; return new SignerTls(d) })!
    expect(tls).not.toBeNull()
    expect(made).toBe(0)
    expect(calls).toEqual([])
    const port = await serve3143(tls)
    // Before start(): nothing exists, so even the ts.net name gets mkcert.
    expect(await served(port, NAME)).toBe(mkcert.fingerprint)
    tls.start()
    tls.start()
    expect(made).toBe(1)
    await tls.active()!.check()
    expect(calls).toEqual(['status', 'cert'])
    expect(await served(port, NAME)).toBe(pair.fingerprint)
    expect(await served(port, NAME.toUpperCase())).toBe(pair.fingerprint)
    for (const other of ['localhost', 'api.gotcos.com', 'other-mac.example-tailnet.ts.net', undefined]) expect(await served(port, other)).toBe(mkcert.fingerprint)
    tls.stop()
  })

  it('with the phone key signer\'s instance present, 3143 uses that one and never makes a second', async () => {
    let made = 0
    const calls: string[] = []
    const clock = { now: Date.now() }
    const signer = new SignerTls(deps(signerPair, clock, calls))
    await signer.check()
    const tls = createControlTsnetTlsForBoot({ enabled: true, httpsAvailable: true }, () => signer, deps(pair, clock, calls), d => { made++; return new SignerTls(d) })!
    tls.start()
    expect(made).toBe(0)
    expect(tls.active()).toBe(signer)
    const port = await serve3143(tls)
    expect(await served(port, NAME)).toBe(signerPair.fingerprint)
    expect(await served(port, 'localhost')).toBe(mkcert.fingerprint)
  })
})

describe('X1: the name must match EXACTLY (Q1 Y4)', () => {
  it('only this Mac\'s name, in any case, gets the pair; a suffix, a prefix, a trailing dot, the tailnet, ts.net or another domain get mkcert', async () => {
    const calls: string[] = []
    const tls = createControlTsnetTlsForBoot({ enabled: true, httpsAvailable: true }, () => null, deps(pair, { now: Date.now() }, calls))!
    tls.start()
    await tls.active()!.check()
    const port = await serve3143(tls)
    for (const exact of [NAME, NAME.toUpperCase(), 'MAC-X1.Example-Tailnet.TS.NET']) expect(await served(port, exact)).toBe(pair.fingerprint)
    const label = NAME.split('.')[0]!
    for (const near of [
      `${NAME}.`,                        // trailing dot
      `x${NAME}`, `x.${NAME}`,           // prefixes
      NAME.slice(label.length + 1),      // the tailnet: example-tailnet.ts.net
      'ts.net', 'net',                   // suffixes
      `${NAME}.evil.com`,                // another domain
      label,                             // the bare label
    ]) {
      expect({ near, got: await served(port, near) }).toEqual({ near, got: mkcert.fingerprint })
    }
    tls.stop()
  })
})

describe('X1: renewal and expiry', () => {
  it('a failed renewal keeps serving the valid pair and says so; once expired the name gets mkcert (a loud error), never http', async () => {
    const calls: string[] = []
    const clock = { now: Date.now() }
    const answer = { r: ok(certStdout(pair)) }
    const tls = createControlTsnetTlsForBoot({ enabled: true, httpsAvailable: true }, () => null, deps(pair, clock, calls, answer))!
    tls.start()
    await tls.active()!.check()
    registerControlTsnetTls(tls)
    expect(controlTsnetHealthField().controlTsnetHttps).toMatchObject({ state: 'serving', reason: null, renewalError: null })
    // Renewal due (under 30 days left) and the CLI fails: the pair still serves, health names the failure.
    answer.r = fail()
    clock.now = pair.notAfterMs - 10 * 24 * 60 * 60_000
    await tls.active()!.check()
    const port = await serve3143(tls)
    expect(await served(port, NAME)).toBe(pair.fingerprint)
    const renewing = controlTsnetHealthField().controlTsnetHttps!
    expect(renewing.state).toBe('serving')
    expect(renewing.renewalError).not.toBeNull()
    expect(renewing.expiresAt).toBe(new Date(pair.notAfterMs).toISOString())
    // Past its end: never served again; the handshake gets 3143's default, which the phone does not trust.
    clock.now = pair.notAfterMs + 1
    expect(await served(port, NAME)).toBe(mkcert.fingerprint)
    expect(controlTsnetHealthField().controlTsnetHttps).toMatchObject({ state: 'not_serving', expiresAt: null })
    tls.stop()
  })

  it('the health field carries a state, a reason code and a date, never the host name or a key', async () => {
    const calls: string[] = []
    const tls = createControlTsnetTlsForBoot({ enabled: true, httpsAvailable: true }, () => null, deps(pair, { now: Date.now() }, calls))!
    registerControlTsnetTls(tls)
    expect(controlTsnetHealthField()).toEqual({ controlTsnetHttps: { state: 'starting', reason: null, renewalError: null, expiresAt: null } })
    tls.start()
    await tls.active()!.check()
    const text = JSON.stringify(controlTsnetHealthField())
    expect(Object.keys(controlTsnetHealthField().controlTsnetHttps!).sort()).toEqual(['expiresAt', 'reason', 'renewalError', 'state'])
    expect(text).not.toContain(NAME)
    expect(text).not.toContain('example-tailnet')
    expect(text).not.toContain('PRIVATE KEY')
    tls.stop()
  })

  it('controlTsnetHealthFrom: starting before any check, not_serving with the reason after a failed one', () => {
    expect(controlTsnetHealthFrom(null).state).toBe('starting')
    const base = { trusted: false, reason: 'tailnet_https_certs_off', host: null, notAfter: null, checkedAt: null, nextCheckAt: null, storedRefused: null } as const
    expect(controlTsnetHealthFrom({ ...base, lastError: null }).state).toBe('starting')
    expect(controlTsnetHealthFrom({ ...base, lastError: 'tailnet_https_certs_off', checkedAt: '2026-11-14T10:00:00.000Z' } as never)).toEqual({ state: 'not_serving', reason: 'tailnet_https_certs_off', renewalError: null, expiresAt: null })
  })
})

describe('X1: index.ts and health wire it, and only on 3143', () => {
  it('index.ts builds it from the switch, gives SNI to the HTTPS listener only, starts it after the signer, stops it on shutdown', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    expect(index).toContain('controlTsnetTls = createControlTsnetTlsForBoot({ enabled: controlTsnetHttpsEnabled(), httpsAvailable }, () => webKeySignerTls, {')
    expect(index).toContain("const mkcertPair = mkcertFiles && entry.label === 'HTTPS' ? controlHttpsOptions(mkcertFiles, controlTsnetTls)")
    expect(index).toContain('registerControlTsnetTls(controlTsnetTls)')
    expect(index.indexOf('controlTsnetTls?.start()')).toBeGreaterThan(index.indexOf('webKeySignerTls?.start()'))
    expect(index).toContain('  controlTsnetTls?.stop()\n')
    // The signer's own lines are unchanged.
    expect(index).toContain('withRequestTimeout(createHttpsServer(signer ? signerHttpsOptions(mkcertPair, webKeySignerTls) : mkcertPair, handler))')
  })

  it('/api/health spreads the field', () => {
    const health = readFileSync(new URL('../routes/health.ts', import.meta.url), 'utf8')
    expect(health).toContain('    ...controlTsnetHealthField(),\n')
  })
})

void tick
