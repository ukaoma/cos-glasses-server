// B2 (QA 2026-11-09): the 3144 signer's trusted Tailscale certificate (lib/web-key-signer-tls.ts).
// A fake Tailscale runner (never the real CLI) and throwaway CA plus leaf pairs minted per run with
// openssl into a temp dir (no private key is committed). The serving tests do real TLS handshakes
// against a real https server on 127.0.0.1:0.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer, type Server } from 'node:https'
import { connect, createSecureContext, rootCertificates, type PeerCertificate } from 'node:tls'
import type { AddressInfo } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import {
  chainsToRoot,
  checkSignerTlsPair,
  createSignerTlsForBoot,
  parseRootPems,
  parseSignerTlsPair,
  SIGNER_TLS_CERT_ARGS,
  SIGNER_TLS_CERT_FILE,
  SIGNER_TLS_CERT_MODE,
  SIGNER_TLS_CHECK_INTERVAL_MS,
  SIGNER_TLS_CERT_TIMEOUT_MS,
  SIGNER_TLS_KEY_FILE,
  SIGNER_TLS_KEY_MODE,
  SIGNER_TLS_RENEW_BEFORE_MS,
  SIGNER_TLS_RETRY_BASE_MS,
  SIGNER_TLS_RETRY_MAX_MS,
  SIGNER_TLS_STATUS_ARGS,
  SIGNER_TLS_STATUS_TIMEOUT_MS,
  SIGNER_TLS_STORED_MAX_BYTES,
  SignerTls,
  signerHttpsOptions,
  SIGNER_TLS_CLI_ENV_KEYS,
  SIGNER_TLS_CERT_CALLS_PER_DAY,
  SIGNER_TLS_STATE_FILE,
  SIGNER_TLS_REASONS,
  SIGNER_TLS_RECHECK_FLOOR_MS,
  signerTlsCliEnv,
  signerTlsCliRunner,
  signerTlsPublicRoots,
  signerTlsRenewalDue,
  signerTlsRetryMs,
  type SignerTlsDeps,
} from './web-key-signer-tls.js'
import { execFileRunner, type RunResult } from './tailscale-nudge.js'
import { WebKeyAuthority } from './web-key-authority.js'
import { WebKeyEnrollments, WebKeyNonces, WebKeyPackets, WebKeyRegistry } from './web-key-registry.js'
import { createWebKeyRouter } from '../routes/web-key.js'
import { INTEGRITY_OK, ORIGIN, p256, seedRegistry, SELF_DNS } from './__fixtures__/web-key-kit.js'

const NAME = SELF_DNS
const OPENSSL = existsSync('/usr/bin/openssl') ? '/usr/bin/openssl' : 'openssl'
const BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

// ── throwaway PKI ──
// LibreSSL's /usr/bin/openssl defaults to SHA-1 signatures and EXPLICIT EC curve parameters; Node's OpenSSL 3
// refuses both in chain verification ("ca md too weak", UNSPECIFIED). Tailscale's Go-made pairs use SHA-256 and
// named curves, so the fixtures pin both.
interface Ca { pem: string; certPath: string; keyPath: string }
interface Leaf { certPem: string; keyPem: string; fingerprint: string; notAfterMs: number }
let pki: string
let tailCa: Ca
let mkcertCa: Ca
let pairA: Leaf
let pairB: Leaf
let pairShort: Leaf
let otherHost: Leaf
let mkcert: Leaf
let mkcertTs: Leaf
let subRoot: Ca
let inter: Ca
let notCa: Ca
let leafViaInter: Leaf
let leafViaNotCa: Leaf
let rsaKey: string
let forgedCa: Ca
let forgedLeaf: Leaf

function ossl(args: string[]): void { execFileSync(OPENSSL, args, { cwd: pki, stdio: ['ignore', 'pipe', 'pipe'] }) }
function mintCa(tag: string, cn = `Throwaway ${tag}`): Ca {
  ossl(['req', '-x509', '-sha256', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-keyout', `${tag}.key`, '-out', `${tag}.pem`, '-days', '3',
    '-subj', `/CN=${cn}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign'])
  return { pem: readFileSync(join(pki, `${tag}.pem`), 'utf8'), certPath: join(pki, `${tag}.pem`), keyPath: join(pki, `${tag}.key`) }
}
/** An intermediate below `parent`: a CA (keyCertSign) or, with isCa false, a plain certificate. */
function mintSubCa(parent: Ca, tag: string, isCa: boolean, days = 30): Ca {
  ossl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-keyout', `${tag}.key`, '-out', `${tag}.csr`, '-subj', `/CN=Throwaway ${tag}`])
  writeFileSync(join(pki, `${tag}.ext`), isCa ? 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n' : 'basicConstraints=CA:FALSE\n')
  const serial = `0x${Buffer.from(tag).toString('hex').slice(0, 16)}${Math.floor(Math.random() * 1e6).toString(16)}`
  ossl(['x509', '-req', '-sha256', '-in', `${tag}.csr`, '-CA', parent.certPath, '-CAkey', parent.keyPath, '-set_serial', serial, '-days', String(days), '-extfile', `${tag}.ext`, '-out', `${tag}.pem`])
  return { pem: readFileSync(join(pki, `${tag}.pem`), 'utf8'), certPath: join(pki, `${tag}.pem`), keyPath: join(pki, `${tag}.key`) }
}
function mintLeaf(ca: Ca, tag: string, sans: string[], days = 90): Leaf {
  ossl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-keyout', `${tag}.p8`, '-out', `${tag}.csr`, '-subj', `/CN=${tag}`])
  writeFileSync(join(pki, `${tag}.ext`), `subjectAltName=${sans.join(',')}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`)
  const serial = `0x${Buffer.from(tag).toString('hex').slice(0, 16)}${Math.floor(Math.random() * 1e6).toString(16)}`
  ossl(['x509', '-req', '-sha256', '-in', `${tag}.csr`, '-CA', ca.certPath, '-CAkey', ca.keyPath, '-set_serial', serial, '-days', String(days), '-extfile', `${tag}.ext`, '-out', `${tag}.crt`])
  // Tailscale writes the key as "EC PRIVATE KEY" (SEC1); match it.
  ossl(['ec', '-in', `${tag}.p8`, '-out', `${tag}.key`])
  const certPem = readFileSync(join(pki, `${tag}.crt`), 'utf8')
  const x = new X509Certificate(certPem)
  return { certPem, keyPem: readFileSync(join(pki, `${tag}.key`), 'utf8'), fingerprint: x.fingerprint256, notAfterMs: Date.parse(x.validTo) }
}
/** What `tailscale cert --cert-file - --key-file - <name>` prints: the chain, then the key. */
const certStdout = (leaf: Leaf, ca: Ca = tailCa): string => `${leaf.certPem}${ca.pem}${leaf.keyPem}`

beforeAll(() => {
  pki = mkdtempSync(join(tmpdir(), 'signer-tls-pki-'))
  tailCa = mintCa('tailca')
  mkcertCa = mintCa('mkcertca')
  pairA = mintLeaf(tailCa, 'pair-a', [`DNS:${NAME}`])
  pairB = mintLeaf(tailCa, 'pair-b', [`DNS:${NAME}`])
  pairShort = mintLeaf(tailCa, 'pair-short', [`DNS:${NAME}`], 45)
  otherHost = mintLeaf(tailCa, 'other', ['DNS:other-mac.tail00000a.ts.net'])
  mkcert = mintLeaf(mkcertCa, 'mkcert', ['DNS:api.gotcos.com', 'DNS:localhost', 'IP:127.0.0.1'], 2)
  // SR-01: a pair for the RIGHT name from a CA that is not a root the signer trusts (an mkcert-style pair).
  mkcertTs = mintLeaf(mkcertCa, 'mkcert-ts', [`DNS:${NAME}`], 800)
  subRoot = mintCa('subroot')
  inter = mintSubCa(subRoot, 'inter', true, 30)
  notCa = mintSubCa(subRoot, 'notca', false, 30)
  leafViaInter = mintLeaf(inter, 'leaf-inter', [`DNS:${NAME}`], 90)
  leafViaNotCa = mintLeaf(notCa, 'leaf-notca', [`DNS:${NAME}`], 90)
  // R6: a CA with the SAME name as the trusted throwaway root but another key, and a leaf it signs.
  forgedCa = mintCa('forged-tailca', 'Throwaway tailca')
  forgedLeaf = mintLeaf(forgedCa, 'forged-leaf', [`DNS:${NAME}`], 90)
  ossl(['genrsa', '-out', 'rsa.key', '2048'])
  rsaKey = readFileSync(join(pki, 'rsa.key'), 'utf8')
  expect(readFileSync(join(pki, 'pair-a.key'), 'utf8')).toContain('BEGIN EC PRIVATE KEY')
})
afterAll(() => { rmSync(pki, { recursive: true, force: true }) })

// ── fake Tailscale runner ──
const ok = (stdout: string): RunResult => ({ code: 0, signal: null, killed: false, stdout, stderr: '', elapsedMs: 3 })
const statusJson = (over: Record<string, unknown> = {}): string => JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${NAME}.`, TailscaleIPs: ['100.108.149.114'] }, CertDomains: [NAME], Peer: {}, ...over })
interface Calls { bin: string; args: readonly string[]; timeoutMs: number; env?: NodeJS.ProcessEnv }

interface Rig {
  tls: SignerTls
  calls: Calls[]
  logs: string[]
  scheduled: number[]
  dir: string
  clock: { now: number }
  status: (r: RunResult | (() => Promise<RunResult>)) => void
  cert: (r: RunResult | (() => Promise<RunResult>)) => void
}
const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function rig(over: Partial<SignerTlsDeps> & { dir?: string; name?: string | null } = {}): Rig {
  const base = mkdtempSync(join(tmpdir(), 'signer-tls-data-'))
  dirs.push(base)
  const dir = over.dir ?? join(base, 'web-key-tls')
  const calls: Calls[] = []
  const logs: string[] = []
  const scheduled: number[] = []
  const clock = { now: Date.now() }
  let statusAnswer: RunResult | (() => Promise<RunResult>) = ok(statusJson())
  let certAnswer: RunResult | (() => Promise<RunResult>) = ok(certStdout(pairA))
  const name = over.name === undefined ? NAME : over.name
  const tls = new SignerTls({
    dir,
    selfDnsName: async () => name,
    resolveBin: () => BIN,
    now: () => clock.now,
    log: line => logs.push(line),
    schedule: (_fn, ms) => { scheduled.push(ms); return { cancel: () => {} } },
    // SR-01: the throwaway Tailscale CA stands in for Node's bundled public roots.
    roots: parseRootPems([tailCa.pem]),
    runner: async (bin, args, timeoutMs, env) => {
      calls.push({ bin, args, timeoutMs, env })
      const a = args[0] === 'status' ? statusAnswer : certAnswer
      return typeof a === 'function' ? a() : a
    },
    ...over,
  })
  return { tls, calls, logs, scheduled, dir, clock, status: r => { statusAnswer = r }, cert: r => { certAnswer = r } }
}

// ── a real https server on 127.0.0.1 with 3144's options ──
const servers: Server[] = []
afterEach(async () => { while (servers.length) { const s = servers.pop()!; await new Promise<void>(r => s.close(() => r())) } })
async function serve(tls: SignerTls | null): Promise<number> {
  const server = createHttpsServer(signerHttpsOptions({ cert: mkcert.certPem, key: mkcert.keyPem }, tls), (_q, s) => { s.end('ok') })
  servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  return (server.address() as AddressInfo).port
}
function handshake(port: number, opts: { servername?: string; ca?: string[] }): Promise<{ authorized: boolean; error: string | null; peer: PeerCertificate }> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: '127.0.0.1', port, ...(opts.servername ? { servername: opts.servername } : {}), ...(opts.ca ? { ca: opts.ca } : {}), rejectUnauthorized: false }, () => {
      const peer = sock.getPeerCertificate()
      resolve({ authorized: sock.authorized, error: sock.authorizationError ? String(sock.authorizationError) : null, peer })
      sock.end()
    })
    sock.on('error', reject)
  })
}
const fp = (peer: PeerCertificate): string => peer.fingerprint256

describe('flag off is zero new surface', () => {
  it('no SignerTls unless the authority is on AND the 3144 listener is planned: no call, no file', () => {
    let calls = 0
    const base = mkdtempSync(join(tmpdir(), 'signer-tls-off-'))
    dirs.push(base)
    const dir = join(base, 'web-key-tls')
    const deps: SignerTlsDeps = { dir, selfDnsName: async () => { calls++; return NAME }, runner: async () => { calls++; return ok('') }, resolveBin: () => { calls++; return BIN } }
    expect(createSignerTlsForBoot({ authorityEnabled: false, signerListener: true }, deps)).toBeNull()
    expect(createSignerTlsForBoot({ authorityEnabled: true, signerListener: false }, deps)).toBeNull()
    expect(createSignerTlsForBoot({ authorityEnabled: false, signerListener: false }, deps)).toBeNull()
    expect(calls).toBe(0)
    expect(existsSync(dir)).toBe(false)
    // The 3144 TLS options without a SignerTls are exactly the mkcert pair, no SNI selection.
    const pair = { cert: mkcert.certPem, key: mkcert.keyPem }
    expect(signerHttpsOptions(pair, null)).toEqual(pair)
    expect('SNICallback' in signerHttpsOptions(pair, null)).toBe(false)
    expect(createSignerTlsForBoot({ authorityEnabled: true, signerListener: true }, deps)).toBeInstanceOf(SignerTls)
  })
})

describe('success: fetched, stored, and served for exactly the tailnet name', () => {
  it('status then cert (both to stdout), bounded; trusted; stored 0600/0644 in a 0700 dir; the key never reaches a log', async () => {
    const r = rig()
    const s = await r.tls.check()
    expect(r.calls.map(c => c.args)).toEqual([SIGNER_TLS_STATUS_ARGS, SIGNER_TLS_CERT_ARGS(NAME)])
    expect(SIGNER_TLS_CERT_ARGS(NAME)).toEqual(['cert', '--cert-file', '-', '--key-file', '-', NAME])
    expect(r.calls.map(c => c.timeoutMs)).toEqual([SIGNER_TLS_STATUS_TIMEOUT_MS, SIGNER_TLS_CERT_TIMEOUT_MS])
    expect(r.calls.every(c => c.bin === BIN)).toBe(true)
    expect(s).toMatchObject({ trusted: true, reason: 'ok', host: NAME, lastError: null, notAfter: new Date(pairA.notAfterMs).toISOString() })
    expect(statSync(r.dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(r.dir, SIGNER_TLS_KEY_FILE)).mode & 0o777).toBe(SIGNER_TLS_KEY_MODE)
    expect(SIGNER_TLS_KEY_MODE).toBe(0o600)
    expect(statSync(join(r.dir, SIGNER_TLS_CERT_FILE)).mode & 0o777).toBe(SIGNER_TLS_CERT_MODE)
    expect(readFileSync(join(r.dir, SIGNER_TLS_KEY_FILE), 'utf8')).toContain('EC PRIVATE KEY')
    expect(readFileSync(join(r.dir, SIGNER_TLS_CERT_FILE), 'utf8')).not.toContain('PRIVATE KEY')
    expect(r.logs.join('\n')).not.toMatch(/PRIVATE KEY|BEGIN /)
    expect(r.logs.join('\n')).not.toContain(NAME)
  })

  it('a real handshake: the ts.net SNI gets the trusted pair (chain verifies, name matches); localhost and no SNI keep mkcert', async () => {
    const r = rig()
    await r.tls.check()
    const port = await serve(r.tls)
    const ts = await handshake(port, { servername: NAME, ca: [tailCa.pem] })
    expect(ts.error).toBeNull()
    expect(ts.authorized).toBe(true)
    expect(fp(ts.peer)).toBe(pairA.fingerprint)
    expect(ts.peer.subjectaltname).toContain(`DNS:${NAME}`)
    const local = await handshake(port, { servername: 'localhost', ca: [mkcertCa.pem] })
    expect(local.authorized).toBe(true)
    expect(fp(local.peer)).toBe(mkcert.fingerprint)
    const noSni = await handshake(port, {})
    expect(fp(noSni.peer)).toBe(mkcert.fingerprint)
    const otherTs = await handshake(port, { servername: 'other-mac.tail00000a.ts.net' })
    expect(fp(otherTs.peer)).toBe(mkcert.fingerprint)
  })
})

describe('failure keeps mkcert and says exactly why', () => {
  it('HTTPS Certificates off for the tailnet (CertDomains null): no cert call, no file, reason in status, mkcert served', async () => {
    const r = rig()
    r.status(ok(statusJson({ CertDomains: null })))
    const s = await r.tls.check()
    expect(s).toMatchObject({ trusted: false, reason: 'tailnet_https_certs_off', host: null, lastError: 'tailnet_https_certs_off' })
    expect(r.calls.map(c => c.args[0])).toEqual(['status'])
    expect(existsSync(r.dir)).toBe(false)
    const port = await serve(r.tls)
    expect(fp((await handshake(port, { servername: NAME })).peer)).toBe(mkcert.fingerprint)
  })

  it('/api/web-key/status carries signerTls (authority mode), and leaves it out when there is no 3144 SignerTls', async () => {
    const r = rig()
    r.status(ok(statusJson({ CertDomains: [] })))
    await r.tls.check()
    const base = mkdtempSync(join(tmpdir(), 'signer-tls-route-'))
    dirs.push(base)
    seedRegistry(join(base, 'web-keys.json'), p256())
    const registry = new WebKeyRegistry(join(base, 'web-keys.json'), join(base, 'a.jsonl'))
    const authority = new WebKeyAuthority({ registry, nonces: new WebKeyNonces(join(base, 'n.json')), packets: new WebKeyPackets(), integrity: () => INTEGRITY_OK, selfDnsName: () => NAME, expectedOrigin: () => ORIGIN, enabled: () => true })
    let current: SignerTls | null = r.tls
    const app = express()
    app.use('/api', createWebKeyRouter({ authority, enrollments: new WebKeyEnrollments(registry, { deviceAllowed: () => true }), isWebRequest: () => false, apiToken: () => 'tok', selfDnsName: () => NAME, expectedOrigin: () => ORIGIN, signerTls: () => current?.status() ?? null }))
    const server = await new Promise<import('node:http').Server>(res => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/web-key/status`
      const body = await (await fetch(url, { headers: { 'x-cos-token': 'tok' } })).json() as Record<string, unknown>
      expect(body.signerTls).toMatchObject({ trusted: false, reason: 'tailnet_https_certs_off' })
      current = null
      const without = await (await fetch(url, { headers: { 'x-cos-token': 'tok' } })).json() as Record<string, unknown>
      expect('signerTls' in without).toBe(false)
      expect(without.origin).toBe(ORIGIN)
    } finally {
      await new Promise<void>(res => server.close(() => res()))
    }
  })

  it('the cert command itself reporting certs off (status raced) is the same reason; a name outside CertDomains is a mismatch with no cert call', async () => {
    const r = rig()
    r.cert({ code: 1, signal: null, killed: false, stdout: '', stderr: 'your Tailscale account does not support getting TLS certs\n', elapsedMs: 40 })
    expect((await r.tls.check()).reason).toBe('tailnet_https_certs_off')
    const m = rig()
    m.status(ok(statusJson({ CertDomains: ['other-mac.tail00000a.ts.net'] })))
    expect((await m.tls.check()).reason).toBe('cert_domain_mismatch')
    expect(m.calls.map(c => c.args[0])).toEqual(['status'])
  })

  it('Tailscale stopped, CLI missing, name unknown, status unreadable', async () => {
    const stopped = rig()
    stopped.status(ok(statusJson({ BackendState: 'Stopped' })))
    expect((await stopped.tls.check()).reason).toBe('tailscale_not_running')
    const missing = rig({ resolveBin: () => null })
    expect((await missing.tls.check()).reason).toBe('tailscale_cli_missing')
    expect(missing.calls).toEqual([])
    const unnamed = rig({ name: null })
    expect((await unnamed.tls.check()).reason).toBe('tailnet_name_unknown')
    expect(unnamed.calls).toEqual([])
    const garbled = rig()
    garbled.status(ok('not json'))
    expect((await garbled.tls.check()).reason).toBe('tailscale_status_failed')
  })

  it('unusable output never serves and never stores: another host, a key that is not the leaf\'s, an expired leaf, garbage, a pair not publicly trusted', async () => {
    for (const [label, stdout, advance, reason] of [
      ['other host', certStdout(otherHost), 0, 'cert_invalid'],
      ['wrong key', `${pairA.certPem}${tailCa.pem}${pairB.keyPem}`, 0, 'cert_invalid'],
      ['expired', certStdout(pairA), pairA.notAfterMs + 1, 'cert_expired'],
      ['garbage', 'Wrote public cert to -\n', 0, 'cert_invalid'],
      ['not publicly trusted (SR-01)', `${mkcertTs.certPem}${mkcertCa.pem}${mkcertTs.keyPem}`, 0, 'cert_untrusted'],
    ] as const) {
      const r = rig()
      if (advance) r.clock.now = advance
      r.cert(ok(stdout))
      const s = await r.tls.check()
      expect({ label, reason: s.reason, trusted: s.trusted }).toEqual({ label, reason, trusted: false })
      expect(r.tls.served()).toBeNull()
      // SR-05 saves the cert-call count beside the pair; the pair itself is never stored.
      expect(existsSync(join(r.dir, SIGNER_TLS_KEY_FILE)) || existsSync(join(r.dir, SIGNER_TLS_CERT_FILE))).toBe(false)
    }
  })
})

describe('renewal', () => {
  it('renews only when FEWER than SIGNER_TLS_RENEW_BEFORE_MS remain (derived from the leaf, not restated)', async () => {
    expect(signerTlsRenewalDue(pairA.notAfterMs, pairA.notAfterMs - SIGNER_TLS_RENEW_BEFORE_MS)).toBe(false)
    expect(signerTlsRenewalDue(pairA.notAfterMs, pairA.notAfterMs - SIGNER_TLS_RENEW_BEFORE_MS + 1)).toBe(true)
    const r = rig()
    await r.tls.check()
    expect(r.calls).toHaveLength(2)
    r.clock.now = pairA.notAfterMs - SIGNER_TLS_RENEW_BEFORE_MS
    await r.tls.check()
    expect(r.calls).toHaveLength(2)
    r.clock.now += 1
    r.cert(ok(certStdout(pairB)))
    await r.tls.check()
    expect(r.calls.map(c => c.args[0])).toEqual(['status', 'cert', 'status', 'cert'])
  })

  it('hot swap: the renewed pair is served by the SAME listener on the next handshake, no restart', async () => {
    const r = rig()
    await r.tls.check()
    const port = await serve(r.tls)
    expect(fp((await handshake(port, { servername: NAME, ca: [tailCa.pem] })).peer)).toBe(pairA.fingerprint)
    r.clock.now = pairA.notAfterMs - SIGNER_TLS_RENEW_BEFORE_MS + 1
    r.cert(ok(certStdout(pairB)))
    const s = await r.tls.check()
    expect(s.notAfter).toBe(new Date(pairB.notAfterMs).toISOString())
    const after = await handshake(port, { servername: NAME, ca: [tailCa.pem] })
    expect(after.authorized).toBe(true)
    expect(fp(after.peer)).toBe(pairB.fingerprint)
    expect(readFileSync(join(r.dir, SIGNER_TLS_KEY_FILE), 'utf8')).toBe(`${pairB.keyPem.trim()}\n`)
  })

  it('SR-09: after this Mac is renamed, the old name\'s pair is no longer served by SNI', async () => {
    let current: string = NAME
    const r = rig({ selfDnsName: async () => current })
    await r.tls.check()
    const port = await serve(r.tls)
    expect(fp((await handshake(port, { servername: NAME, ca: [tailCa.pem] })).peer)).toBe(pairA.fingerprint)
    current = 'renamed-mac.example.ts.net'
    r.status(ok(statusJson({ CertDomains: [NAME] })))
    expect((await r.tls.check()).reason).toBe('cert_domain_mismatch')
    expect(fp((await handshake(port, { servername: NAME })).peer)).toBe(mkcert.fingerprint)
    expect(r.tls.status().trusted).toBe(false)
  })

  it('a pair past notAfter is never served, even before the next check replaces it', async () => {
    const r = rig()
    await r.tls.check()
    const port = await serve(r.tls)
    r.clock.now = pairA.notAfterMs
    expect(fp((await handshake(port, { servername: NAME })).peer)).toBe(mkcert.fingerprint)
    expect(r.tls.status()).toMatchObject({ trusted: false, reason: 'cert_expired' })
    // 7.0.20 pickup: the stored files are the same expired pair, read once and reported as not taken, never as serving.
    expect(r.logs.filter(l => /serving a stored certificate/.test(l))).toHaveLength(0)
    expect(r.logs.filter(l => /a stored certificate was not taken/.test(l))).toHaveLength(1)
  })

  it('boot: a stored pair serves at once; a fresh one costs no CLI call and the next check is a day out', async () => {
    const first = rig()
    await first.tls.check()
    const second = rig({ dir: first.dir })
    expect(second.tls.served()?.host).toBe(NAME)
    expect(second.tls.status()).toMatchObject({ trusted: true, reason: 'ok' })
    second.tls.start()
    await second.tls.check()
    expect(second.calls).toEqual([])
    expect(second.scheduled.at(-1)).toBe(SIGNER_TLS_CHECK_INTERVAL_MS)
    second.tls.stop()
  })

  it('a pair stored by another process is served at the next check: no restart, no CLI call; one for another host is ignored', async () => {
    const r = rig()
    r.status(ok(statusJson({ CertDomains: null })))
    expect((await r.tls.check()).reason).toBe('tailnet_https_certs_off')
    expect(r.calls).toHaveLength(1)
    const port = await serve(r.tls)
    expect(fp((await handshake(port, { servername: NAME })).peer)).toBe(mkcert.fingerprint)
    // e.g. COS Control's helper ran `tailscale cert` where the CLI answers, into the same dir.
    const { mkdirSync } = await import('node:fs')
    mkdirSync(r.dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(r.dir, SIGNER_TLS_CERT_FILE), `${otherHost.certPem}${tailCa.pem}`)
    writeFileSync(join(r.dir, SIGNER_TLS_KEY_FILE), otherHost.keyPem, { mode: 0o600 })
    await r.tls.check()
    expect(r.tls.served()).toBeNull()
    writeFileSync(join(r.dir, SIGNER_TLS_CERT_FILE), `${pairA.certPem}${tailCa.pem}`)
    writeFileSync(join(r.dir, SIGNER_TLS_KEY_FILE), pairA.keyPem, { mode: 0o600 })
    const s = await r.tls.check()
    expect(s).toMatchObject({ trusted: true, reason: 'ok', host: NAME })
    expect(r.calls).toHaveLength(1)
    const after = await handshake(port, { servername: NAME, ca: [tailCa.pem] })
    expect(after.authorized).toBe(true)
    expect(fp(after.peer)).toBe(pairA.fingerprint)
  })

  it('the re-read never steps back: a stored pair that expires sooner than the serving one is not taken', async () => {
    const r = rig()
    await r.tls.check()
    expect(pairShort.notAfterMs).toBeLessThan(pairA.notAfterMs)
    writeFileSync(join(r.dir, SIGNER_TLS_CERT_FILE), `${pairShort.certPem}${tailCa.pem}`)
    writeFileSync(join(r.dir, SIGNER_TLS_KEY_FILE), pairShort.keyPem, { mode: 0o600 })
    await r.tls.check()
    expect(r.tls.served()?.notAfterMs).toBe(pairA.notAfterMs)
    expect(r.calls).toHaveLength(2)
  })

  it('a torn stored pair (cert of one, key of another) is not loaded, and is fetched again', async () => {
    const first = rig()
    await first.tls.check()
    writeFileSync(join(first.dir, SIGNER_TLS_KEY_FILE), pairB.keyPem)
    const second = rig({ dir: first.dir })
    expect(second.tls.served()).toBeNull()
    await second.tls.check()
    expect(second.calls.map(c => c.args[0])).toEqual(['status', 'cert'])
    expect(second.tls.served()?.host).toBe(NAME)
  })
})

// ── the prompt pickup (7.0.20): a pair placed in the dir by hand or by another process ──
// The fallback if the server's own fetch fails: every CLI check here times out. The pair is written the way
// CONTRACT_stored_pair.md says: dir 0700, key 0600 then cert 0644, each by rename.
const cliTimeout: RunResult = { code: null, signal: 'SIGKILL', killed: true, stdout: '', stderr: '', elapsedMs: SIGNER_TLS_STATUS_TIMEOUT_MS }
function storePair(dir: string, leaf: Leaf): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const [file, text, mode] of [[SIGNER_TLS_KEY_FILE, leaf.keyPem, 0o600], [SIGNER_TLS_CERT_FILE, `${leaf.certPem}${tailCa.pem}`, 0o644]] as const) {
    const tmp = join(dir, `.${file}.tmp-${process.pid}`)
    writeFileSync(tmp, text, { mode })
    renameSync(tmp, join(dir, file))
  }
}
const pickupLines = (logs: string[], re: RegExp): string[] => logs.filter(l => re.test(l))
async function statusOverRoute(tls: SignerTls): Promise<Record<string, unknown>> {
  const base = mkdtempSync(join(tmpdir(), 'signer-tls-pickup-route-'))
  dirs.push(base)
  seedRegistry(join(base, 'web-keys.json'), p256())
  const registry = new WebKeyRegistry(join(base, 'web-keys.json'), join(base, 'a.jsonl'))
  const authority = new WebKeyAuthority({ registry, nonces: new WebKeyNonces(join(base, 'n.json')), packets: new WebKeyPackets(), integrity: () => INTEGRITY_OK, selfDnsName: () => NAME, expectedOrigin: () => ORIGIN, enabled: () => true })
  const app = express()
  // The same wiring as index.ts: `signerTls: () => webKeySignerTls?.statusRead() ?? null`.
  app.use('/api', createWebKeyRouter({ authority, enrollments: new WebKeyEnrollments(registry, { deviceAllowed: () => true }), isWebRequest: () => false, apiToken: () => 'tok', selfDnsName: () => NAME, expectedOrigin: () => ORIGIN, signerTls: () => tls.statusRead() }))
  const server = await new Promise<import('node:http').Server>(res => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/web-key/status`
    return (await (await fetch(url, { headers: { 'x-cos-token': 'tok' } })).json() as Record<string, unknown>).signerTls as Record<string, unknown>
  } finally {
    await new Promise<void>(res => server.close(() => res()))
  }
}

describe('the prompt pickup (7.0.20): a stored pair serves without waiting for the next check', () => {
  it('pickup by status read: the next /api/web-key/status after a pair is stored says trusted, with no CLI call; the next check confirms it', async () => {
    const r = rig()
    r.status(cliTimeout)
    expect((await r.tls.check()).reason).toBe('tailscale_cli_timeout')
    expect(r.calls).toHaveLength(1)
    expect((await statusOverRoute(r.tls)).trusted).toBe(false)
    storePair(r.dir, pairA)
    const s = await statusOverRoute(r.tls)
    // lastError stays the last CHECK's failure until the next check runs.
    expect(s).toMatchObject({ trusted: true, reason: 'ok', host: NAME, notAfter: new Date(pairA.notAfterMs).toISOString(), lastError: 'tailscale_cli_timeout' })
    expect(r.calls).toHaveLength(1)
    expect(pickupLines(r.logs, /serving a stored certificate on 3144 until /)).toHaveLength(1)
    expect(r.logs.join('\n')).not.toContain(NAME)
    expect(r.logs.join('\n')).not.toMatch(/PRIVATE KEY|BEGIN /)
    // The cooldown's check finds the same pair fresh: still no CLI call, lastError cleared, the next check a day out.
    r.clock.now += signerTlsRetryMs(1)
    expect(await r.tls.check()).toMatchObject({ trusted: true, reason: 'ok', lastError: null })
    expect(r.calls).toHaveLength(1)
    expect(r.scheduled.at(-1)).toBe(SIGNER_TLS_CHECK_INTERVAL_MS)
  })

  it('pickup by handshake: the first 3144 handshake naming the host after a pair is stored gets it, in that same handshake', async () => {
    const r = rig()
    r.status(cliTimeout)
    await r.tls.check()
    const port = await serve(r.tls)
    expect(fp((await handshake(port, { servername: NAME })).peer)).toBe(mkcert.fingerprint)
    storePair(r.dir, pairA)
    const first = await handshake(port, { servername: NAME, ca: [tailCa.pem] })
    expect(first.error).toBeNull()
    expect(first.authorized).toBe(true)
    expect(fp(first.peer)).toBe(pairA.fingerprint)
    expect(r.calls).toHaveLength(1)
    expect(fp((await handshake(port, { servername: 'localhost' })).peer)).toBe(mkcert.fingerprint)
    expect(fp((await handshake(port, {})).peer)).toBe(mkcert.fingerprint)
  })

  it('bounded: files are read only when they change (one read per change, however many triggers), only for this Mac\'s name', async () => {
    const r = rig()
    r.status(cliTimeout)
    await r.tls.check()
    const port = await serve(r.tls)
    const notTaken = /a stored certificate was not taken/
    // Nothing stored: no read, no line.
    for (let i = 0; i < 3; i++) { r.tls.status(); await handshake(port, { servername: NAME }) }
    expect(pickupLines(r.logs, /stored certificate/)).toHaveLength(0)
    // A pair for another Mac's name: read once, never served, never for its own name either.
    storePair(r.dir, otherHost)
    for (let i = 0; i < 3; i++) { r.tls.status(); await handshake(port, { servername: NAME }) }
    expect(r.tls.served()).toBeNull()
    expect(fp((await handshake(port, { servername: 'other-mac.tail00000a.ts.net' })).peer)).toBe(mkcert.fingerprint)
    expect(pickupLines(r.logs, notTaken)).toHaveLength(1)
    // A file removed: no read, no line.
    rmSync(join(r.dir, SIGNER_TLS_CERT_FILE))
    r.tls.status()
    await handshake(port, { servername: NAME })
    expect(pickupLines(r.logs, notTaken)).toHaveLength(1)
    // The right pair: read at the next trigger and served.
    storePair(r.dir, pairA)
    expect(r.tls.status()).toMatchObject({ trusted: true, host: NAME })
    expect(r.calls).toHaveLength(1)
  })

  it('the same checks as boot and the check (parseSignerTlsPair): a pair not publicly trusted, a wrong-name, an expired or a torn pair dropped in is never served, by status read or handshake', async () => {
    const r = rig()
    r.status(cliTimeout)
    await r.tls.check()
    const port = await serve(r.tls)
    const drops: Array<[string, () => void]> = [
      ['not publicly trusted (SR-01)', () => storePair(r.dir, mkcertTs)],
      ['wrong name', () => storePair(r.dir, otherHost)],
      ['expired', () => { r.clock.now = pairShort.notAfterMs + 1; storePair(r.dir, pairShort) }],
      ['torn (cert of one, key of another)', () => { storePair(r.dir, pairA); writeFileSync(join(r.dir, SIGNER_TLS_KEY_FILE), pairB.keyPem, { mode: 0o600 }) }],
    ]
    for (const [label, drop] of drops) {
      drop()
      expect({ label, trusted: r.tls.status().trusted, nothingServed: r.tls.served() === null }).toEqual({ label, trusted: false, nothingServed: true })
      expect({ label, mkcert: fp((await handshake(port, { servername: NAME })).peer) === mkcert.fingerprint }).toEqual({ label, mkcert: true })
    }
    expect(pickupLines(r.logs, /a stored certificate was not taken/)).toHaveLength(drops.length)
    expect(pickupLines(r.logs, /serving a stored certificate/)).toHaveLength(0)
    // The positive control: a valid pair for this name, dropped the same way, serves.
    storePair(r.dir, pairA)
    expect(r.tls.status()).toMatchObject({ trusted: true, host: NAME })
    expect(fp((await handshake(port, { servername: NAME, ca: [tailCa.pem] })).peer)).toBe(pairA.fingerprint)
    expect(r.calls).toHaveLength(1)
  })

  it('while a trusted pair serves nothing extra runs; a renewal stored in the dir is taken at the next check, with no CLI call', async () => {
    const r = rig()
    r.cert(ok(certStdout(pairShort)))
    await r.tls.check()
    expect(r.tls.served()?.notAfterMs).toBe(pairShort.notAfterMs)
    expect(r.calls).toHaveLength(2)
    // From here the CLI does not answer (the LaunchAgent), and the serving pair is due for renewal.
    r.status(cliTimeout)
    r.clock.now = pairShort.notAfterMs - SIGNER_TLS_RENEW_BEFORE_MS + 1
    storePair(r.dir, pairA)
    expect(pairA.notAfterMs).toBeGreaterThan(pairShort.notAfterMs)
    const port = await serve(r.tls)
    expect(r.tls.status()).toMatchObject({ trusted: true, notAfter: new Date(pairShort.notAfterMs).toISOString() })
    expect(fp((await handshake(port, { servername: NAME, ca: [tailCa.pem] })).peer)).toBe(pairShort.fingerprint)
    expect(pickupLines(r.logs, /stored certificate/)).toHaveLength(0)
    // The check's own re-read takes the longer-lived pair: no CLI call, nothing to report.
    expect(await r.tls.check()).toMatchObject({ trusted: true, lastError: null, notAfter: new Date(pairA.notAfterMs).toISOString() })
    expect(r.calls).toHaveLength(2)
    expect(fp((await handshake(port, { servername: NAME, ca: [tailCa.pem] })).peer)).toBe(pairA.fingerprint)
  })
})

describe('the breaker: bounded, backing off, single-flight', () => {
  it('cooldown doubles from SIGNER_TLS_RETRY_BASE_MS to SIGNER_TLS_RETRY_MAX_MS', () => {
    expect(signerTlsRetryMs(1)).toBe(SIGNER_TLS_RETRY_BASE_MS)
    expect(signerTlsRetryMs(2)).toBe(2 * SIGNER_TLS_RETRY_BASE_MS)
    expect(signerTlsRetryMs(3)).toBe(4 * SIGNER_TLS_RETRY_BASE_MS)
    expect(signerTlsRetryMs(1_000)).toBe(SIGNER_TLS_RETRY_MAX_MS)
    let last = 0
    for (let n = 1; n < 40; n++) { const v = signerTlsRetryMs(n); expect(v).toBeGreaterThanOrEqual(last); expect(v).toBeLessThanOrEqual(SIGNER_TLS_RETRY_MAX_MS); last = v }
  })

  it('a timed-out status: no CLI call inside the cooldown, one at its end; the timer is armed for the cooldown, never sooner', async () => {
    const r = rig()
    r.status({ code: null, signal: 'SIGKILL', killed: true, stdout: '', stderr: '', elapsedMs: SIGNER_TLS_STATUS_TIMEOUT_MS })
    const t0 = r.clock.now
    expect((await r.tls.check()).reason).toBe('tailscale_cli_timeout')
    expect(r.calls).toHaveLength(1)
    expect(r.scheduled.at(-1)).toBe(signerTlsRetryMs(1))
    r.clock.now = t0 + signerTlsRetryMs(1) - 1
    await r.tls.check()
    await r.tls.check()
    expect(r.calls).toHaveLength(1)
    r.clock.now = t0 + signerTlsRetryMs(1)
    await r.tls.check()
    expect(r.calls).toHaveLength(2)
    expect(r.scheduled.at(-1)).toBe(signerTlsRetryMs(2))
    expect(r.logs.at(-1)).toMatch(/tailscale_cli_timeout .*killed=true signal=SIGKILL/)
    // Recovery resets the ladder: the next timer is a day out.
    r.status(ok(statusJson()))
    r.clock.now += signerTlsRetryMs(2)
    expect((await r.tls.check()).trusted).toBe(true)
    expect(r.scheduled.at(-1)).toBe(SIGNER_TLS_CHECK_INTERVAL_MS)
  })

  it('SR-04: once HTTPS Certificates is turned on, the next authenticated status read re-checks at once, not after the backoff', async () => {
    const r = rig()
    r.status(ok(statusJson({ CertDomains: null })))
    expect((await r.tls.check()).reason).toBe('tailnet_https_certs_off')
    await r.tls.check()
    expect(r.calls).toHaveLength(1)
    r.status(ok(statusJson()))
    expect((await statusOverRoute(r.tls)).trusted).toBe(false)
    expect((await r.tls.check()).trusted).toBe(true)
    expect(r.calls.map(c => c.args[0])).toEqual(['status', 'status', 'cert'])
    expect((await statusOverRoute(r.tls))).toMatchObject({ trusted: true, reason: 'ok', lastError: null })
  })

  it('SR-04: at most one status-read re-check per floor, only for certs off or an unknown name, never from status() itself', async () => {
    const r = rig()
    r.status(ok(statusJson({ CertDomains: null })))
    await r.tls.check()
    r.tls.statusRead()
    await r.tls.check()
    expect(r.calls).toHaveLength(2)
    r.tls.statusRead()
    r.tls.status()
    await r.tls.check()
    expect(r.calls).toHaveLength(2)
    r.clock.now += SIGNER_TLS_RECHECK_FLOOR_MS
    r.tls.statusRead()
    await r.tls.check()
    expect(r.calls).toHaveLength(3)
    // Another failure keeps the breaker: no re-check from a status read.
    const t = rig()
    t.status({ code: null, signal: 'SIGKILL', killed: true, stdout: '', stderr: '', elapsedMs: SIGNER_TLS_STATUS_TIMEOUT_MS })
    await t.tls.check()
    t.clock.now += SIGNER_TLS_RECHECK_FLOOR_MS
    t.tls.statusRead()
    await t.tls.check()
    expect(t.calls).toHaveLength(1)
    // An unknown name is re-checked too, and the read stops after stop().
    let name: string | null = null
    const u = rig({ selfDnsName: async () => name })
    expect((await u.tls.check()).reason).toBe('tailnet_name_unknown')
    name = NAME
    u.tls.statusRead()
    expect((await u.tls.check()).trusted).toBe(true)
    const v = rig()
    v.status(ok(statusJson({ CertDomains: null })))
    await v.tls.check()
    v.tls.stop()
    v.tls.statusRead()
    await v.tls.check()
    expect(v.calls).toHaveLength(1)
  })

  it('SR-05: each cert call is counted and saved before it runs (0600), and the breaker survives a restart', async () => {
    const r = rig()
    r.cert({ code: 1, signal: null, killed: false, stdout: '', stderr: 'acme: error', elapsedMs: 900 })
    expect((await r.tls.check()).reason).toBe('tailscale_cert_failed')
    const statePath = join(r.dir, SIGNER_TLS_STATE_FILE)
    expect(statSync(statePath).mode & 0o777).toBe(0o600)
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(saved).toMatchObject({ v: 1, certCalls: 1, failures: 1, lastError: 'tailscale_cert_failed' })
    expect(saved.cooldownUntil).toBe(r.clock.now + signerTlsRetryMs(1))
    // A restart inside the cooldown: no CLI call at all, and status still says why.
    const again = rig({ dir: r.dir })
    again.clock.now = r.clock.now
    expect((await again.tls.check()).reason).toBe('tailscale_cert_failed')
    expect(again.calls).toEqual([])
    // Past the cooldown it calls again.
    again.clock.now += signerTlsRetryMs(1)
    again.cert({ code: 1, signal: null, killed: false, stdout: '', stderr: 'acme: error', elapsedMs: 900 })
    await again.tls.check()
    expect(again.calls.map(c => c.args[0])).toEqual(['status', 'cert'])
  })

  it('SR-05: at most SIGNER_TLS_CERT_CALLS_PER_DAY cert calls per UTC day, across restarts; the next UTC day resets the count', async () => {
    expect(SIGNER_TLS_CERT_CALLS_PER_DAY).toBe(3)
    const r = rig()
    const day = new Date(r.clock.now)
    r.clock.now = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 1, 0, 0)
    const failing: RunResult = { code: 1, signal: null, killed: false, stdout: '', stderr: 'acme: error', elapsedMs: 900 }
    r.cert(failing)
    const certCalls = (rr: Rig): number => rr.calls.filter(c => c.args[0] === 'cert').length
    for (let i = 0; i < SIGNER_TLS_CERT_CALLS_PER_DAY; i++) {
      await r.tls.check()
      r.clock.now += SIGNER_TLS_RETRY_MAX_MS
    }
    expect(certCalls(r)).toBe(SIGNER_TLS_CERT_CALLS_PER_DAY)
    expect((await r.tls.check()).reason).toBe('cert_daily_cap')
    expect(certCalls(r)).toBe(SIGNER_TLS_CERT_CALLS_PER_DAY)
    // A restart the same day: still capped.
    const again = rig({ dir: r.dir })
    again.clock.now = r.clock.now + SIGNER_TLS_RETRY_MAX_MS
    again.cert(failing)
    expect((await again.tls.check()).reason).toBe('cert_daily_cap')
    expect(certCalls(again)).toBe(0)
    // The next UTC day: one call again.
    again.clock.now = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1, 1, 0, 0) + SIGNER_TLS_RETRY_MAX_MS
    await again.tls.check()
    expect(certCalls(again)).toBe(1)
  })

  it('SR-05: no cert call when the count cannot be saved (the pair folder cannot be written)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'signer-tls-nostate-'))
    dirs.push(base)
    const dir = join(base, 'web-key-tls')
    writeFileSync(dir, 'not a folder', { mode: 0o644 })
    const r = rig({ dir })
    expect((await r.tls.check()).reason).toBe('cert_store_failed')
    expect(r.calls.map(c => c.args[0])).toEqual(['status'])
  })

  it('SR-04: the status read ITSELF starts the re-check (no other check is called), for certs off and for an unknown name, once per floor', async () => {
    // Wait for the fake runner without calling check(): only work statusRead() started can add a call.
    const settle = async (): Promise<void> => { for (let i = 0; i < 50; i++) await new Promise(res => setImmediate(res)) }
    const off = rig()
    off.status(ok(statusJson({ CertDomains: null })))
    expect((await off.tls.check()).reason).toBe('tailnet_https_certs_off')
    expect(off.calls).toHaveLength(1)
    off.status(ok(statusJson()))
    off.tls.statusRead()
    await settle()
    expect(off.calls.map(c => c.args[0])).toEqual(['status', 'status', 'cert'])
    expect(off.tls.status().trusted).toBe(true)
    let name: string | null = null
    const unknown = rig({ selfDnsName: async () => name })
    expect((await unknown.tls.check()).reason).toBe('tailnet_name_unknown')
    expect(unknown.calls).toHaveLength(0)
    name = NAME
    unknown.tls.statusRead()
    await settle()
    expect(unknown.calls.map(c => c.args[0])).toEqual(['status', 'cert'])
    // Within the floor a read starts nothing; after it, one more.
    const floor = rig()
    floor.status(ok(statusJson({ CertDomains: null })))
    await floor.tls.check()
    floor.tls.statusRead()
    await settle()
    expect(floor.calls).toHaveLength(2)
    floor.tls.statusRead()
    await settle()
    expect(floor.calls).toHaveLength(2)
    floor.clock.now += SIGNER_TLS_RECHECK_FLOOR_MS
    floor.tls.statusRead()
    await settle()
    expect(floor.calls).toHaveLength(3)
  })

  it('concurrent checks share one run', async () => {
    const r = rig()
    let release: (v: RunResult) => void = () => {}
    r.status(() => new Promise<RunResult>(res => { release = res }))
    const a = r.tls.check(), b = r.tls.check()
    await new Promise(res => setTimeout(res, 10))
    release(ok(statusJson()))
    await Promise.all([a, b])
    expect(r.calls.map(c => c.args[0])).toEqual(['status', 'cert'])
  })

  it('a renewal that fails keeps serving the still-valid pair and reports lastError', async () => {
    const r = rig()
    await r.tls.check()
    r.clock.now = pairA.notAfterMs - SIGNER_TLS_RENEW_BEFORE_MS + 1
    r.cert({ code: 1, signal: null, killed: false, stdout: '', stderr: 'acme: rate limited', elapsedMs: 900 })
    const s = await r.tls.check()
    expect(s).toMatchObject({ trusted: true, reason: 'ok', lastError: 'tailscale_cert_failed', host: NAME })
    expect(r.scheduled.at(-1)).toBe(signerTlsRetryMs(1))
  })
})

// ── the CLI env (7.0.20): a minimal explicit env with SHLVL=1 on this module's CLI calls only ──
// probe_tailscale_launchd/RESULT.md: the macsys CLI as a child of the LaunchAgent's node answers "The Tailscale
// GUI failed to start" with exit 0 unless SHLVL is set. The child must never see this process's env (the API
// token, provider keys). Children here print ONE variable (printenv), never the whole env, and assertions compare
// small values, so no value from this process's env can reach a failure message or a mutation report.
describe('the CLI env (7.0.20): SHLVL=1 in a minimal env, on the signer\'s Tailscale calls only', () => {
  const GUI_ERROR = 'The Tailscale GUI failed to start. (The operation couldn\'t be completed. (Tailscale.CLIError error 3.))'
  const ALLOWED = new Set(['HOME', 'PATH', 'TMPDIR', 'USER', 'LANG', 'SHLVL'])
  const FAKE_TOKEN = 'signer-tls-test-token-not-real'
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of ['SHLVL', 'COS_API_TOKEN']) saved[k] = process.env[k]
    delete process.env.SHLVL
    process.env.COS_API_TOKEN = FAKE_TOKEN
  })
  afterEach(() => {
    for (const k of ['SHLVL', 'COS_API_TOKEN']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('signerTlsCliEnv: SHLVL=1 plus HOME, PATH, TMPDIR, USER and LANG when set; never the token or any other key', () => {
    const base: NodeJS.ProcessEnv = { HOME: '/h', PATH: '/p', TMPDIR: '/t', USER: 'u', LANG: 'en_US.UTF-8', SHLVL: '5', COS_API_TOKEN: 'x', OPENAI_API_KEY: 'y', NODE_OPTIONS: 'z' }
    expect(signerTlsCliEnv(base)).toEqual({ HOME: '/h', PATH: '/p', TMPDIR: '/t', USER: 'u', LANG: 'en_US.UTF-8', SHLVL: '1' })
    expect(signerTlsCliEnv({ HOME: '/h', PATH: '/p', LANG: '' })).toEqual({ HOME: '/h', PATH: '/p', SHLVL: '1' })
    expect(base.SHLVL).toBe('5')
    expect(SIGNER_TLS_CLI_ENV_KEYS).toEqual(['HOME', 'PATH', 'TMPDIR', 'USER', 'LANG'])
    // From this process's env (which holds a token here): only allowed keys, no token.
    const own = signerTlsCliEnv()
    expect(Object.keys(own).filter(k => !ALLOWED.has(k)).length).toBe(0)
    expect('COS_API_TOKEN' in own).toBe(false)
    expect(own.SHLVL).toBe('1')
  })

  it('both CLI calls, status and cert, receive that env: SHLVL=1, no COS_API_TOKEN, no key outside the allowlist', async () => {
    const r = rig()
    expect((await r.tls.check()).trusted).toBe(true)
    expect(r.calls.map(c => c.args[0])).toEqual(['status', 'cert'])
    for (const c of r.calls) {
      expect({ call: c.args[0], shlvl: c.env?.SHLVL, token: c.env ? 'COS_API_TOKEN' in c.env : 'no env', extra: Object.keys(c.env ?? {}).filter(k => !ALLOWED.has(k)).length })
        .toEqual({ call: c.args[0], shlvl: '1', token: false, extra: 0 })
    }
  })

  it('a real child gets exactly that env: SHLVL=1 and no token; tailscale-nudge\'s runner is unchanged (still no SHLVL)', async () => {
    const env = signerTlsCliEnv()
    const shlvl = await signerTlsCliRunner('/usr/bin/printenv', ['SHLVL'], 5_000, env)
    expect({ code: shlvl.code, out: shlvl.stdout.trim() }).toEqual({ code: 0, out: '1' })
    const token = await signerTlsCliRunner('/usr/bin/printenv', ['COS_API_TOKEN'], 5_000, env)
    expect({ code: token.code, empty: token.stdout.trim() === '' }).toEqual({ code: 1, empty: true })
    const nudge = await execFileRunner('/usr/bin/printenv', ['SHLVL'], 5_000)
    expect({ code: nudge.code, out: nudge.stdout.trim() }).toEqual({ code: 1, out: '' })
  })

  it('end to end with a fake CLI that needs SHLVL: the default runner gets the JSON; without SHLVL the answer is reported as tailscale_cli_gui_unavailable', async () => {
    expect(/\s/.test(process.execPath)).toBe(false)
    const base = mkdtempSync(join(tmpdir(), 'signer-tls-fakecli-'))
    dirs.push(base)
    const bin = join(base, 'Tailscale')
    writeFileSync(bin, `#!${process.execPath}\nconst a = process.argv.slice(2)\nprocess.stdout.write(a[0] === 'status' && process.env.SHLVL ? ${JSON.stringify(statusJson({ CertDomains: null }))} : ${JSON.stringify(`${GUI_ERROR}\n`)})\n`, { mode: 0o755 })
    const quiet = { selfDnsName: async () => NAME, resolveBin: () => bin, log: () => {}, schedule: () => ({ cancel: () => {} }) }
    const viaDefault = new SignerTls({ dir: join(base, 'a'), ...quiet })
    expect((await viaDefault.check()).reason).toBe('tailnet_https_certs_off')
    // The nudge's runner: inherits this process's env, which has no SHLVL here.
    const withoutShlvl = new SignerTls({ dir: join(base, 'b'), ...quiet, runner: (b, args, ms) => execFileRunner(b, args, ms) })
    expect(await withoutShlvl.check()).toMatchObject({ trusted: false, reason: 'tailscale_cli_gui_unavailable', lastError: 'tailscale_cli_gui_unavailable' })
    expect(existsSync(join(base, 'a'))).toBe(false)
    expect(existsSync(join(base, 'b'))).toBe(false)
  })
})

describe('SR-03: the signer\'s own status call, without peers; an oversized answer has its own reason', () => {
  it('asks status --json --peers=false (the child receives the flag); CertDomains is still read from that answer', async () => {
    expect(SIGNER_TLS_STATUS_ARGS).toEqual(['status', '--json', '--peers=false'])
    expect(/\s/.test(process.execPath)).toBe(false)
    const base = mkdtempSync(join(tmpdir(), 'signer-tls-peers-'))
    dirs.push(base)
    const bin = join(base, 'Tailscale')
    // The fake answers JSON only when it was asked without peers, and that JSON has no Peer map.
    writeFileSync(bin, `#!${process.execPath}\nconst a = process.argv.slice(2)\nprocess.stdout.write(a[0] === 'status' && a.includes('--peers=false') ? ${JSON.stringify(JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${NAME}.` }, CertDomains: [] }))} : 'unexpected arguments\\n')\n`, { mode: 0o755 })
    const tls = new SignerTls({ dir: join(base, 'tls'), selfDnsName: async () => NAME, resolveBin: () => bin, log: () => {}, schedule: () => ({ cancel: () => {} }) })
    expect((await tls.check()).reason).toBe('tailnet_https_certs_off')
  })

  it('a status or cert answer past the 1 MiB cap is tailscale_output_too_large, never tailscale_cli_missing', async () => {
    const base = mkdtempSync(join(tmpdir(), 'signer-tls-maxbuf-'))
    dirs.push(base)
    const bin = join(base, 'Tailscale')
    writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(2 * 1024 * 1024))\n`, { mode: 0o755 })
    const tls = new SignerTls({ dir: join(base, 'tls'), selfDnsName: async () => NAME, resolveBin: () => bin, log: () => {}, schedule: () => ({ cancel: () => {} }) })
    expect(await tls.check()).toMatchObject({ trusted: false, reason: 'tailscale_output_too_large' })
    // The cert call the same way (a fake runner: status fine, cert overflows).
    const r = rig()
    r.cert({ code: null, signal: 'SIGKILL', killed: true, stdout: '', stderr: '', spawnError: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', elapsedMs: 40 })
    expect((await r.tls.check()).reason).toBe('tailscale_output_too_large')
    const m = rig()
    m.status({ code: null, signal: null, killed: false, stdout: '', stderr: '', spawnError: 'ENOENT', elapsedMs: 1 })
    expect((await m.tls.check()).reason).toBe('tailscale_cli_missing')
  })
})

describe('SR-11: one reason list, pinned, for the server and COS Control\'s generated golden', () => {
  it('SIGNER_TLS_REASONS is the pinned list (a change here means regenerating Control\'s golden.json), with no duplicates', () => {
    expect([...SIGNER_TLS_REASONS]).toEqual(['ok', 'pending', 'tailnet_name_unknown', 'tailnet_https_certs_off', 'cert_domain_mismatch', 'tailscale_not_running', 'tailscale_cli_missing', 'tailscale_cli_timeout', 'tailscale_cli_gui_unavailable', 'tailscale_output_too_large', 'tailscale_status_failed', 'tailscale_cert_failed', 'cert_invalid', 'cert_expired', 'cert_not_yet_valid', 'cert_untrusted', 'cert_store_failed', 'cert_daily_cap', 'stored_symlink', 'stored_not_file', 'stored_owner', 'stored_writable', 'stored_too_large'])
    expect(new Set(SIGNER_TLS_REASONS).size).toBe(SIGNER_TLS_REASONS.length)
    expect(Object.isFrozen(SIGNER_TLS_REASONS)).toBe(true)
  })

  it('a saved lastError outside the list is not restored', async () => {
    const r = rig()
    r.cert({ code: 1, signal: null, killed: false, stdout: '', stderr: 'acme: error', elapsedMs: 900 })
    await r.tls.check()
    const statePath = join(r.dir, SIGNER_TLS_STATE_FILE)
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    writeFileSync(statePath, JSON.stringify({ ...saved, lastError: 'made_up_reason' }), { mode: 0o600 })
    const again = rig({ dir: r.dir })
    again.clock.now = r.clock.now
    expect(again.tls.status().lastError).toBeNull()
  })
})

describe('parseSignerTlsPair', () => {
  it('takes the chain in order plus one key, whatever text surrounds them', () => {
    const p = parseSignerTlsPair(`warning: something\n${certStdout(pairA)}\ntrailing`, NAME, Date.now(), parseRootPems([tailCa.pem]))
    expect(p?.host).toBe(NAME)
    expect(p?.certPem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2)
    expect(new X509Certificate(p!.certPem).fingerprint256).toBe(pairA.fingerprint)
    expect(parseSignerTlsPair(`${certStdout(pairA)}${pairB.keyPem}`, NAME, Date.now(), parseRootPems([tailCa.pem]))).toBeNull()
  })
})

// ── SR-08 (review 2026-11-10): stored-pair hygiene ──
describe('SR-08: a stored pair is read only from a plain, private file in a private folder, at most 64 KiB', () => {
  /** A good stored pair (0700 folder, 0600 key, 0644 cert), like the server's own store(). */
  function goodStore(): { base: string; dir: string } {
    const base = mkdtempSync(join(tmpdir(), 'signer-tls-hygiene-'))
    dirs.push(base)
    const dir = join(base, 'web-key-tls')
    mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700)
    writeFileSync(join(dir, SIGNER_TLS_KEY_FILE), pairA.keyPem, { mode: 0o600 })
    writeFileSync(join(dir, SIGNER_TLS_CERT_FILE), `${pairA.certPem}${tailCa.pem}`, { mode: 0o644 })
    chmodSync(join(dir, SIGNER_TLS_KEY_FILE), 0o600)
    chmodSync(join(dir, SIGNER_TLS_CERT_FILE), 0o644)
    return { base, dir }
  }

  it('a good stored pair serves at boot, with storedRefused null', () => {
    const { dir } = goodStore()
    const r = rig({ dir })
    expect(r.tls.served()?.host).toBe(NAME)
    expect(r.tls.status()).toMatchObject({ trusted: true, storedRefused: null })
  })

  it('refuses with its own reason: a symlinked file or folder, not a regular file, another owner, group or other write, over 64 KiB', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0
    const cases: Array<[string, string, (s: { base: string; dir: string }) => { dir?: string; ownerUid?: number }]> = [
      ['symlinked cert file', 'stored_symlink', ({ base, dir }) => {
        const real = join(base, 'elsewhere.pem')
        writeFileSync(real, `${pairA.certPem}${tailCa.pem}`, { mode: 0o644 })
        rmSync(join(dir, SIGNER_TLS_CERT_FILE))
        symlinkSync(real, join(dir, SIGNER_TLS_CERT_FILE))
        return {}
      }],
      ['symlinked folder', 'stored_symlink', ({ base, dir }) => {
        const link = join(base, 'linked-tls')
        symlinkSync(dir, link)
        return { dir: link }
      }],
      ['key is not a regular file', 'stored_not_file', ({ dir }) => {
        rmSync(join(dir, SIGNER_TLS_KEY_FILE))
        mkdirSync(join(dir, SIGNER_TLS_KEY_FILE))
        return {}
      }],
      ['another owner', 'stored_owner', () => ({ ownerUid: uid + 1 })],
      ['group- or other-writable cert', 'stored_writable', ({ dir }) => { chmodSync(join(dir, SIGNER_TLS_CERT_FILE), 0o666); return {} }],
      ['group- or other-writable folder', 'stored_writable', ({ dir }) => { chmodSync(dir, 0o777); return {} }],
      ['cert over 64 KiB', 'stored_too_large', ({ dir }) => {
        writeFileSync(join(dir, SIGNER_TLS_CERT_FILE), `${pairA.certPem}${tailCa.pem}${'#'.repeat(SIGNER_TLS_STORED_MAX_BYTES)}`, { mode: 0o644 })
        return {}
      }],
    ]
    for (const [label, reason, perturb] of cases) {
      const store = goodStore()
      const over = perturb(store)
      const r = rig({ dir: over.dir ?? store.dir, ...(over.ownerUid !== undefined ? { ownerUid: over.ownerUid } : {}) })
      expect({ label, served: r.tls.served() === null, ...pick(r.tls.status()) }).toEqual({ label, served: true, trusted: false, storedRefused: reason })
    }
    function pick(s: { trusted: boolean; storedRefused: string | null }) { return { trusted: s.trusted, storedRefused: s.storedRefused } }
  })

  it('a refused file, once fixed, is taken at the next status read with no restart; the pickup log names the reason, never the host', () => {
    const { dir } = goodStore()
    chmodSync(join(dir, SIGNER_TLS_CERT_FILE), 0o666)
    const r = rig({ dir })
    expect(r.tls.status()).toMatchObject({ trusted: false, storedRefused: 'stored_writable' })
    chmodSync(join(dir, SIGNER_TLS_CERT_FILE), 0o644)
    expect(r.tls.status()).toMatchObject({ trusted: true, storedRefused: null, host: NAME })
    chmodSync(join(dir, SIGNER_TLS_CERT_FILE), 0o664)
    const q = rig({ dir })
    // Nothing loaded at boot (the cert is group-writable): the status read's pickup reads, refuses, and says why.
    expect(q.tls.status().storedRefused).toBe('stored_writable')
    expect(q.logs.filter(l => l === '[signer-tls] a stored certificate was not taken: stored_writable')).toHaveLength(1)
    expect(q.logs.join('\n')).not.toContain(NAME)
  })
})

// ── SR-01 (review 2026-11-10): `trusted` means publicly trusted ──
// A public chain only: valid-isrgrootx1.letsencrypt.org as served on 2026-11-11 (leaf, YR1, Root YR cross-signed
// by ISRG Root X1). Certificates only, no key; tests pick a `now` inside its window, so the wall clock never matters.
const LE_PUBLIC_CHAIN = `-----BEGIN CERTIFICATE-----
MIIFGzCCBAOgAwIBAgISBjxMtWq8as8b6hXlVHpzSHzSMA0GCSqGSIb3DQEBCwUA
MDMxCzAJBgNVBAYTAlVTMRYwFAYDVQQKEw1MZXQncyBFbmNyeXB0MQwwCgYDVQQD
EwNZUjEwHhcNMjYxMTA0MTczODMzWhcNMjcwMjAyMTczODMyWjArMSkwJwYDVQQD
EyB2YWxpZC1pc3Jncm9vdHgxLmxldHNlbmNyeXB0Lm9yZzCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBALP2MrRe5NGz62pFl/kTjPpsdoznNTlfFc9k8MpB
p5CL69U/GYpVaVxuI+WMyAwJvrJy6Ap0SQF+juLMvEiHI3BIuPjiy/7/Lz6MqCSO
oZvBW75XTuPs2MAvz+nl+PQGCfhobJp90rHIjYrchJbuKhVOmbkm7z/On5BWthxs
Wmi0wsxSIasGdNXWFde8PT3l8hShd6FR2T9v/EWSEPKXToSMIK4o6mhOdggNtnjJ
B9EqHoNqfDgCD6yP7/dgV+F/ksKQD7e8hjRax4/f0lIHGfzdWhlqZYV1Qge3t4Gb
JQnquV60irlcME/pftDXF8aSsrjZ8UjICYLKzm6zCV7EeNcCAwEAAaOCAi8wggIr
MA4GA1UdDwEB/wQEAwIFoDATBgNVHSUEDDAKBggrBgEFBQcDATAMBgNVHRMBAf8E
AjAAMB0GA1UdDgQWBBRVnoYeG4xMbSGGXpIGbepGMhxlBjAfBgNVHSMEGDAWgBQf
LzW+RhSCzUCxrnksVXj699Ro+zAzBggrBgEFBQcBAQQnMCUwIwYIKwYBBQUHMAKG
F2h0dHA6Ly95cjEuaS5sZW5jci5vcmcvMCsGA1UdEQQkMCKCIHZhbGlkLWlzcmdy
b290eDEubGV0c2VuY3J5cHQub3JnMBMGA1UdIAQMMAowCAYGZ4EMAQIBMC4GA1Ud
HwQnMCUwI6AhoB+GHWh0dHA6Ly95cjEuYy5sZW5jci5vcmcvODMuY3JsMIIBDQYK
KwYBBAHWeQIEAgSB/gSB+wD5AH8AjspHC6zeavOiBrCkeoS3Rv4fxr+VPiXmm07k
AkjzxugAAAGhp9mxEwAIAAAFADhc3j4EAwBIMEYCIQD8VGbXQXy3MKURPe8dsWul
XgTrWcDXzWsZiZuaF8hzAgIhAJveoFt62liq2yWHxw1X9d0/Y9Yk94CfUoW51JL4
CxgsAHYAYEyar3p/d18B1Ab8kg3ImesLHH34yVIb+voXdzuXi8kAAAGhp9mxlgAA
BAMARzBFAiB8l3IIWcLrpwGyto80cb+5zGnfe2fcMyuqOsyKqanVxwIhAKWGDRVs
eYy53nUN5wgxAJ9cgotwGHGMwzG43K+IiOW5MA0GCSqGSIb3DQEBCwUAA4IBAQAx
n3xFlkvAxCJ6InS+PT6JHa6z8fQ/S3WtUfTMv8sv3O1B3aYdRh3CCvnrKgDTnvHi
GNguCdJNTGoDlw5gXpPHkJKKC6chDWkbbuFScPujJvs4/LqL/ynEPKuv6BFmLiQ7
/qGOujAl5gLnoPL7KP1+RgUXMh50hORLTCwzZSS1XM7OUiMHfyQVHSNVsw00bNoW
4k/IzBtXBHYhFJjKFWcbkrKtQ9dK6tFhWqChY42CLjHUl84nhiLfSW/pWHJ66+A7
baBPjC/xdwfnJ3j0chPBasYEvFeqHYlSQs4qp4RrmOSYzCgHOgVoWJZHnBhogcwI
BIHCS58W6diSgAwVLnRE
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIE2zCCAsOgAwIBAgIRAKICU/FfJpHAXcHOE7m8yk4wDQYJKoZIhvcNAQELBQAw
LjELMAkGA1UEBhMCVVMxDTALBgNVBAoTBElTUkcxEDAOBgNVBAMTB1Jvb3QgWVIw
HhcNMjUwOTAzMDAwMDAwWhcNMjgwOTAyMjM1OTU5WjAzMQswCQYDVQQGEwJVUzEW
MBQGA1UEChMNTGV0J3MgRW5jcnlwdDEMMAoGA1UEAxMDWVIxMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoVi8X2xCYgMXvJxNPKp/oF13UMgmPABB07VC
LNDtoXmt9luEZNJSBV10VyT1Pz6LD8Zq1d2gc43WNl1AdRrj4sEnazbOiz0nPpmG
Bp2hui49oZtDIY6wdKeZAi5BbNU20CH6RSBBMLSQ9cXrH8dxdv4PAJ45ssGML68U
SE3BsjC2a6cAN9L5CgXVIQi5tfNiTPoFZZ3S0OlXqLmmtdV95udWAb5b6e/F49Di
CsH0Y00Ag72BVIb1hzynmKe+X0mERBTtsb3BwmpV9ipeBjMLoR/D9cHxHQCWoi5l
TmXwY015J5rGelz1nZjJuxc2kioaX29XJBnhMkP531rSdG5uMwIDAQABo4HuMIHr
MA4GA1UdDwEB/wQEAwIBhjATBgNVHSUEDDAKBggrBgEFBQcDATASBgNVHRMBAf8E
CDAGAQH/AgEAMB0GA1UdDgQWBBQfLzW+RhSCzUCxrnksVXj699Ro+zAfBgNVHSME
GDAWgBTe51tg0CJtQCh9Pw0B/qS1UrRRlDAyBggrBgEFBQcBAQQmMCQwIgYIKwYB
BQUHMAKGFmh0dHA6Ly95ci5pLmxlbmNyLm9yZy8wEwYDVR0gBAwwCjAIBgZngQwB
AgEwJwYDVR0fBCAwHjAcoBqgGIYWaHR0cDovL3lyLmMubGVuY3Iub3JnLzANBgkq
hkiG9w0BAQsFAAOCAgEA0+zvMq3kHig1ddTmmm+RibTr9/RpX7k4buanMMRqbV/y
IvP82zAHN3mvaw+cASuVsdpd0ikjhr4hnhJQLQOzOp2ccKrsdGOAgo0vddeISFAq
EWEV4lmUM3vFF796up+bSgmJ1u6RupDCMxDgF8M3eLvGuj6L0lu3zkQ0KuQLnKxL
tB0oQqn1Idg5CuuGpMvQzk29Pa3D/qHurc0EIM9SxukQuJqq63lxsYyRQFU8yMBO
hq1w5LbfaWNRrz1uklOfI/pYkAb2E2MTZrAMQkBIE2S8Jt1F8gRc96o/xOsrgvSk
a84AisX6xq1lz1Z7jGvrnXc4TMcjxZTjiTaihcYI1JIXZiLtEMSCa5l3cu8YWd6z
dLRQlqRdclVjuQfNHawRJ6GWlkK0QJosivTKwdBw3KxEtzGo8yMHERbsy57gP1UX
HOMcmZYQC0gtyR3SxfenIM/MxC3Ia2Ypab/kQ/CTnlIn2KQ5JUC6NYrGCbhFN9bp
5lKJStEwCUnLpntcrXk5XVDCNv/5RyWpRThkGOV7GetKkQ0qAY8hCzWK6oqnAhDZ
cjlYVdWfqOw3DIOX6EDNBgAqHarRVxyF9QZdOaXSyPJ0ueD2BYJEBgaCGQ8rAaU/
Qc123V5LTXDZW4CcsPBDyhy4v+c8hClAyw/IkJlfBqxB9D+/wvIMHgECZ4ptP6o=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIF9DCCA9ygAwIBAgIRAPJLbRf52a18scn+p4eCaZ8wDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMjYwNTEzMDAwMDAw
WhcNMzIwOTAyMjM1OTU5WjAuMQswCQYDVQQGEwJVUzENMAsGA1UEChMESVNSRzEQ
MA4GA1UEAxMHUm9vdCBZUjCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIB
ANvGJnN78CTJdWL3+eGfsLN5TrNBJs+VH9hRXqRbwxu9sGNiB0BD1fcOxbSUQCJI
M1xE13Db+5Cw1w0s0EBYsvuIP/6joF0w8cuImbgR1OGgYbSQ4OpzI+DG8SGuTlcE
873OCS+kh3srlo6vl43M5OJg4Aeo1sfHp6kTJDoIiFBNJAY+OKfX/FUvYKuhjT+n
o49lmqmupSBI5PkBQiqrEGtWU5uxU/cQWHGu8jSjFBznZqvbNPLMXMLFxCb3WTfr
JBXXjqvWG+v4bjzxjjeAtOlU7qarRDvNOyAuQYLln904M+faKx8hnLCpJ15ZqaEg
cNlY+9MMWcC5yvL2A2j3l9+2buggZX+dOE91zYmIdawTvSZuVvlbRrAlLxIB6pwM
BjneXCjYQ8+3BCCjssbSNpZU3hTcBDdhfAlEDlYr6pEatnMdmDT5BqnKC92bd0Eh
M1fbLHioLccLCuievT8ZkPhZrq7Mii7gNXAcUEAR8+lzYal+9zTg7C5DALyVOeG/
CqfRAMn1KSHCR0NSA6P8tn/mGRlnCct5rtVCLnVySVpU6H1qGg3DgTOuskf8eahT
MiYbI5ezPJmO5ertalskQ1utp74+eDy92PI4ftHKTbq9IWhH4YZKh3WnJEIt+oQv
lYZbY8tpEroKrFB6PFGzrJIDRyts4HqvuH52RFj2zv/BAgMBAAGjgeswgegwDgYD
VR0PAQH/BAQDAgEGMBMGA1UdJQQMMAoGCCsGAQUFBwMBMA8GA1UdEwEB/wQFMAMB
Af8wHQYDVR0OBBYEFN7nW2DQIm1AKH0/DQH+pLVStFGUMB8GA1UdIwQYMBaAFHm0
WeZ7tuXkAXOACIjIGlj26ZtuMDIGCCsGAQUFBwEBBCYwJDAiBggrBgEFBQcwAoYW
aHR0cDovL3gxLmkubGVuY3Iub3JnLzATBgNVHSAEDDAKMAgGBmeBDAECATAnBgNV
HR8EIDAeMBygGqAYhhZodHRwOi8veDEuYy5sZW5jci5vcmcvMA0GCSqGSIb3DQEB
CwUAA4ICAQA8spSI95KKfn2W6GMmDpHBJSPaLbsS3W93cijJCRCYAc1fsJgL1FIL
7C0C9ecPOdcwB2fi0Dk2p94j9iTJCxmt5CFSKLRWwnXT2MMSXexVxqoVB79BdWPx
VXETkVme/qYSAuKVHh5Ps+5BixgmwS1JkjSAc+MfrUbNssVEEnH0aEiAh+rotXAV
JSP/Ye7LJPEwD9DWG72vVWbhAcuOf5OLjz57Ctk7MgQHynZ7+PlHJtajroCaIbtC
r6tcZZaAwUQm+jQyeWdV+2hv9deOYFmKeQyjjcSrN5Nadrw+L9DZJLbA1HqeNvLh
BgqpP0fvJq2N6EtD574N6eMI7uMsJTnji2UDz9el5XLSv9fqJMuDQtYVb2oTNoKp
oUqhxPVC0aq4eG5MESaIdn8b5ZGSSeAJLMHXljEdlNza+ncfkviXk1POLnnFdvx8
/gk6M374WbLWFXw8N141B/Rl/tINGfl1TxOIiqtiMYkL02RSGb1kq34BL9NPP27z
RGMuHGnzS3hFIrRTfKxrzUZ9RzQWzEG3K6fJ3r2nqSltkeytis9DIBoFY9VmVyjL
M71DMi+y1+TRSJVClEMwvA4yL++7q9XZx5r5wBRWB4kQTKH5qyoZnDw7iiuh1lID
yDFx8r7i9vIJU5HS3moZLkYWAOilMaV9N56A9Bgb6dNcHkvg3NoaYA==
-----END CERTIFICATE-----`
const pemCerts = (text: string): X509Certificate[] => (text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map(p => new X509Certificate(p))

describe('SR-01: trusted means publicly trusted (chain to Node\'s bundled roots, notBefore, the key is the leaf\'s)', () => {
  it('Node\'s bundled roots are the default; a pair for the right name from a CA outside them is refused as cert_untrusted', () => {
    expect(signerTlsPublicRoots().length).toBe(rootCertificates.length)
    expect(checkSignerTlsPair(certStdout(pairA), NAME, Date.now())).toEqual({ ok: false, reason: 'cert_untrusted' })
    expect(checkSignerTlsPair(`${mkcertTs.certPem}${mkcertCa.pem}${mkcertTs.keyPem}`, NAME, Date.now(), parseRootPems([tailCa.pem]))).toEqual({ ok: false, reason: 'cert_untrusted' })
    expect(checkSignerTlsPair(certStdout(pairA), NAME, Date.now(), parseRootPems([tailCa.pem])).ok).toBe(true)
  })

  it('a real Let\'s Encrypt chain verifies link by link to the bundled ISRG Root X1, in any order; not without its cross-signed root, no roots, or past the leaf\'s notAfter', () => {
    const chain = pemCerts(LE_PUBLIC_CHAIN)
    expect(chain).toHaveLength(3)
    const at = Date.parse(chain[0].validFrom) + 86_400_000
    expect(chainsToRoot(chain, signerTlsPublicRoots(), at)).toBe(true)
    expect(chainsToRoot([chain[0], chain[2], chain[1]], signerTlsPublicRoots(), at)).toBe(true)
    expect(chainsToRoot(chain.slice(0, 2), signerTlsPublicRoots(), at)).toBe(false)
    expect(chainsToRoot(chain, [], at)).toBe(false)
    expect(chainsToRoot(chain, signerTlsPublicRoots(), Date.parse(chain[0].validTo) + 1)).toBe(false)
  })

  it('an intermediate must be present, a CA, and inside its own validity window', () => {
    const roots = parseRootPems([subRoot.pem])
    const at = Date.now()
    const leafI = new X509Certificate(leafViaInter.certPem)
    const interX = new X509Certificate(inter.pem)
    expect(chainsToRoot([leafI, interX], roots, at)).toBe(true)
    expect(chainsToRoot([leafI], roots, at)).toBe(false)
    expect(chainsToRoot([new X509Certificate(leafViaNotCa.certPem), new X509Certificate(notCa.pem)], roots, at)).toBe(false)
    expect(chainsToRoot([leafI, interX], roots, Date.parse(interX.validTo) + 1)).toBe(false)
    expect(checkSignerTlsPair(`${leafViaInter.certPem}${inter.pem}${leafViaInter.keyPem}`, NAME, at, roots).ok).toBe(true)
    expect(checkSignerTlsPair(`${leafViaInter.certPem}${leafViaInter.keyPem}`, NAME, at, roots)).toEqual({ ok: false, reason: 'cert_untrusted' })
  })

  it('a link must VERIFY, not only match by name: a leaf signed by a forged CA carrying the trusted root\'s name is cert_untrusted', () => {
    const roots = parseRootPems([tailCa.pem])
    const leaf = new X509Certificate(forgedLeaf.certPem)
    const root = new X509Certificate(tailCa.pem)
    // The premise, so this test cannot pass for a different reason: the names match, the signature does not.
    expect(leaf.checkIssued(root)).toBe(true)
    expect(leaf.verify(root.publicKey)).toBe(false)
    expect(chainsToRoot([leaf], roots, Date.now())).toBe(false)
    expect(checkSignerTlsPair(`${forgedLeaf.certPem}${forgedLeaf.keyPem}`, NAME, Date.now(), roots)).toEqual({ ok: false, reason: 'cert_untrusted' })
    expect(checkSignerTlsPair(`${forgedLeaf.certPem}${forgedCa.pem}${forgedLeaf.keyPem}`, NAME, Date.now(), roots)).toEqual({ ok: false, reason: 'cert_untrusted' })
  })

  it('refuses a leaf before its notBefore (cert_not_yet_valid), and takes it from that moment on', () => {
    const roots = parseRootPems([tailCa.pem])
    const from = Date.parse(new X509Certificate(pairA.certPem).validFrom)
    expect(checkSignerTlsPair(certStdout(pairA), NAME, from - 1, roots)).toEqual({ ok: false, reason: 'cert_not_yet_valid' })
    expect(checkSignerTlsPair(certStdout(pairA), NAME, from, roots).ok).toBe(true)
  })

  it('refuses a key that is not the leaf\'s, including an RSA key with an EC certificate, which createSecureContext alone accepts', () => {
    const roots = parseRootPems([tailCa.pem])
    // Why the SPKI comparison exists: this mismatch does not throw (probe 2026-11-11, Node 24.1).
    expect(() => createSecureContext({ cert: pairA.certPem, key: rsaKey })).not.toThrow()
    expect(checkSignerTlsPair(`${pairA.certPem}${tailCa.pem}${rsaKey}`, NAME, Date.now(), roots)).toEqual({ ok: false, reason: 'cert_invalid' })
    expect(checkSignerTlsPair(`${pairA.certPem}${tailCa.pem}${pairB.keyPem}`, NAME, Date.now(), roots)).toEqual({ ok: false, reason: 'cert_invalid' })
  })

  it('the default roots are Node\'s bundled roots everywhere a pair is checked (source pin: no public key is available to a test)', () => {
    // A behaviour test would need a publicly trusted leaf WITH its key, which no test can hold. So the three
    // defaults are pinned by source; the chain logic itself is behaviour-tested above with injected roots.
    const src = readFileSync(join(import.meta.dirname, 'web-key-signer-tls.ts'), 'utf8')
    const count = (s: string): number => src.split(s).length - 1
    expect(count('if (!bundledRoots) bundledRoots = Object.freeze(parseRootPems(rootCertificates))')).toBe(1)
    expect(count('roots: readonly X509Certificate[] = signerTlsPublicRoots()): SignerTlsPairCheck')).toBe(1)
    expect(count('this.roots = deps.roots ?? signerTlsPublicRoots()')).toBe(1)
  })

  it('an untrusted stored pair never serves, never ends the check and never blocks the fetch', async () => {
    const base = mkdtempSync(join(tmpdir(), 'signer-tls-untrusted-'))
    dirs.push(base)
    const dir = join(base, 'web-key-tls')
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(join(dir, SIGNER_TLS_KEY_FILE), mkcertTs.keyPem, { mode: 0o600 })
    writeFileSync(join(dir, SIGNER_TLS_CERT_FILE), `${mkcertTs.certPem}${mkcertCa.pem}`, { mode: 0o644 })
    const r = rig({ dir })
    expect(r.tls.served()).toBeNull()
    expect(r.tls.status().trusted).toBe(false)
    const s = await r.tls.check()
    expect(r.calls.map(c => c.args[0])).toEqual(['status', 'cert'])
    expect(s).toMatchObject({ trusted: true, reason: 'ok', host: NAME, notAfter: new Date(pairA.notAfterMs).toISOString() })
  })
})

describe('index.ts wiring (source)', () => {
  const index = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')
  const count = (s: string): number => index.split(s).length - 1

  it('built only in the 3144 branch of the listener loop, from the one door; 3143 keeps the bare mkcert pair', () => {
    expect(count('createSignerTlsForBoot(')).toBe(1)
    const branch = index.indexOf('  if (signer) {\n    webKeySignerTls = createSignerTlsForBoot({ authorityEnabled: webKeyAuthorityEnabled(), signerListener: true }, {')
    expect(branch).toBeGreaterThan(index.indexOf("const signer = entry.label === 'HTTPS signer'"))
    expect(count('signerHttpsOptions(')).toBe(1)
    expect(count('createHttpsServer(signer ? signerHttpsOptions(mkcertPair, webKeySignerTls) : mkcertPair, handler)')).toBe(1)
    expect(count('SNICallback')).toBe(0)
  })

  it('started once after the listeners bind, stopped once at shutdown, reported once by the status route', () => {
    expect(count('webKeySignerTls?.start()')).toBe(1)
    expect(index.indexOf('webKeySignerTls?.start()')).toBeGreaterThan(index.indexOf('listenRequiredServers(listeners).then(() => {'))
    expect(count('webKeySignerTls?.stop()')).toBe(1)
    expect(index.indexOf('webKeySignerTls?.stop()')).toBeGreaterThan(index.indexOf('async function gracefulShutdown(): Promise<void> {'))
    expect(count('signerTls: () => webKeySignerTls?.statusRead() ?? null,')).toBe(1)
    expect(count('webKeySignerTls?.status()')).toBe(0)
    expect(count('webKeySignerTls = ')).toBe(1)
  })
})
