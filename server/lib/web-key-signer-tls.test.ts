// B2 (QA 2026-11-09): the 3144 signer's trusted Tailscale certificate (lib/web-key-signer-tls.ts).
// A fake Tailscale runner (never the real CLI) and throwaway CA plus leaf pairs minted per run with
// openssl into a temp dir (no private key is committed). The serving tests do real TLS handshakes
// against a real https server on 127.0.0.1:0.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer, type Server } from 'node:https'
import { connect, type PeerCertificate } from 'node:tls'
import type { AddressInfo } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import {
  createSignerTlsForBoot,
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
  SIGNER_TLS_STATUS_TIMEOUT_MS,
  SignerTls,
  signerHttpsOptions,
  signerTlsRenewalDue,
  signerTlsRetryMs,
  type SignerTlsDeps,
} from './web-key-signer-tls.js'
import { STATUS_ARGS, type RunResult } from './tailscale-nudge.js'
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
  otherHost = mintLeaf(tailCa, 'other', ['DNS:other-mac.tail38457f.ts.net'])
  mkcert = mintLeaf(mkcertCa, 'mkcert', ['DNS:api.gotcos.com', 'DNS:localhost', 'IP:127.0.0.1'], 2)
  expect(readFileSync(join(pki, 'pair-a.key'), 'utf8')).toContain('BEGIN EC PRIVATE KEY')
})
afterAll(() => { rmSync(pki, { recursive: true, force: true }) })

// ── fake Tailscale runner ──
const ok = (stdout: string): RunResult => ({ code: 0, signal: null, killed: false, stdout, stderr: '', elapsedMs: 3 })
const statusJson = (over: Record<string, unknown> = {}): string => JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${NAME}.`, TailscaleIPs: ['100.108.149.114'] }, CertDomains: [NAME], Peer: {}, ...over })
interface Calls { bin: string; args: readonly string[]; timeoutMs: number }

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
    runner: async (bin, args, timeoutMs) => {
      calls.push({ bin, args, timeoutMs })
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
    expect(r.calls.map(c => c.args)).toEqual([STATUS_ARGS, SIGNER_TLS_CERT_ARGS(NAME)])
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
    const otherTs = await handshake(port, { servername: 'other-mac.tail38457f.ts.net' })
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
    m.status(ok(statusJson({ CertDomains: ['other-mac.tail38457f.ts.net'] })))
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

  it('unusable output never serves and never stores: another host, a key that is not the leaf\'s, an expired leaf, garbage', async () => {
    for (const [label, stdout, advance] of [
      ['other host', certStdout(otherHost), 0],
      ['wrong key', `${pairA.certPem}${tailCa.pem}${pairB.keyPem}`, 0],
      ['expired', certStdout(pairA), pairA.notAfterMs + 1],
      ['garbage', 'Wrote public cert to -\n', 0],
    ] as const) {
      const r = rig()
      if (advance) r.clock.now = advance
      r.cert(ok(stdout))
      const s = await r.tls.check()
      expect({ label, reason: s.reason, trusted: s.trusted }).toEqual({ label, reason: 'cert_invalid', trusted: false })
      expect(r.tls.served()).toBeNull()
      expect(existsSync(r.dir)).toBe(false)
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

  it('a pair past notAfter is never served, even before the next check replaces it', async () => {
    const r = rig()
    await r.tls.check()
    const port = await serve(r.tls)
    r.clock.now = pairA.notAfterMs
    expect(fp((await handshake(port, { servername: NAME })).peer)).toBe(mkcert.fingerprint)
    expect(r.tls.status()).toMatchObject({ trusted: false, reason: 'cert_expired' })
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

describe('parseSignerTlsPair', () => {
  it('takes the chain in order plus one key, whatever text surrounds them', () => {
    const p = parseSignerTlsPair(`warning: something\n${certStdout(pairA)}\ntrailing`, NAME, Date.now())
    expect(p?.host).toBe(NAME)
    expect(p?.certPem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2)
    expect(new X509Certificate(p!.certPem).fingerprint256).toBe(pairA.fingerprint)
    expect(parseSignerTlsPair(`${certStdout(pairA)}${pairB.keyPem}`, NAME, Date.now())).toBeNull()
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
    expect(count('signerTls: () => webKeySignerTls?.status() ?? null,')).toBe(1)
    expect(count('webKeySignerTls = ')).toBe(1)
  })
})
