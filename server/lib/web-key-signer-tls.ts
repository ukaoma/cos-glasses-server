// A publicly trusted certificate for the phone signer origin, https://<MagicDNS name>:3144 (QA
// 2026-11-09 blocker B2; plan PLAN_web_turn_authority Phase 0 and Decision 1). Exists ONLY with
// COS_WEB_KEY_AUTHORITY on and the 3144 listener planned (createSignerTlsForBoot); off, nothing here
// runs: no Tailscale call, no file, no change to any listener.
//
// WHY. 3144 served the mkcert pair from server/certs/, whose SAN has no ts.net name, so iPhone Safari
// had no secure context (no passkey, no WebCrypto key) and COS Control's signer-file audit failed its
// hostname check. Tailscale's HTTPS Certificates feature issues a Let's Encrypt certificate for this
// Mac's own tailnet name. That is the phone origin Miles chose.
//
// WHAT IT DOES.
//   - Obtains the pair with `tailscale cert --cert-file - --key-file - <name>`. Both to STDOUT, not
//     to file paths: the macOS GUI build's CLI runs in an app sandbox ("this binary's filesystem
//     writes go to $HOME/Library/Containers/<app>/Data", read from the 1.102.2 binary), so a path
//     under the data dir would not receive the files. The server parses the PEM blocks and writes the
//     pair itself, atomically, into <data dir>/web-key-tls/ (dir 0700, key 0600, cert 0644).
//   - Asks `tailscale status --json` first (read only, bounded). Empty CertDomains means HTTPS
//     Certificates is off for the tailnet: no cert call is made, and the status says so
//     (`tailnet_https_certs_off`). A name missing from CertDomains: `cert_domain_mismatch`.
//   - Serves the pair on 3144 by SNI: a handshake naming exactly the certificate's host gets it; any
//     other name, no name or an IP keeps the mkcert pair (the server's default context). Replacing
//     the pair swaps the context the next handshake reads: no restart, no listener change.
//   - Checks at boot and every SIGNER_TLS_CHECK_INTERVAL_MS (daily); renews when fewer than
//     SIGNER_TLS_RENEW_BEFORE_MS (30 days) remain. A valid pair with more left calls nothing.
//   - Each check first re-reads the stored pair: a longer-lived, valid pair for this name written there
//     by hand or by another process is served from then on, no restart and no CLI call.
//   - The prompt pickup (7.0.20), the fallback if this server's own fetch fails: a pair written into
//     the dir by hand (`tailscale cert` in Terminal) or by another process. While nothing trusted
//     serves, every 3144 handshake and every status read checks the two stored files with `stat` and
//     re-reads them only when they changed (inode, size, mtime, ctime). So such a pair is served at the
//     next handshake or status read, with no restart, no CLI call and no write, instead of at the next
//     check (up to SIGNER_TLS_RETRY_MAX_MS away while failing). While a trusted pair serves, nothing
//     extra runs. What to write: CONTRACT_stored_pair.md (phone-key build, 2026-11-10).
//   - Every CLI call gets a minimal explicit env with SHLVL=1 (signerTlsCliEnv, 7.0.20), never this
//     process's env: without SHLVL the macOS CLI under the LaunchAgent answers "The Tailscale GUI failed
//     to start" (exit 0) and no certificate is fetched. That answer is reported as
//     `tailscale_cli_gui_unavailable`.
//   - Every CLI call has a timeout. Consecutive failures back off SIGNER_TLS_RETRY_BASE_MS doubling
//     to SIGNER_TLS_RETRY_MAX_MS; no call is made inside the cooldown (the breaker). One check at a
//     time. Never throws.
//   - Logs reason codes, exit facts and the expiry date. Never stdout (it carries the private key).
//
// NOT HERE: 3143 keeps its single mkcert pair (no SNI selection): Even Hub and every existing client
// see exactly the certificate they saw before.

import { execFile } from 'node:child_process'
import { mkdirSync, chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { createSecureContext, type SecureContext } from 'node:tls'
import type { ServerOptions as HttpsServerOptions } from 'node:https'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { normalizeTailscaleDnsName } from './network-policy.js'
import {
  parseTailscaleStatus,
  resolveTailscaleBin,
  STATUS_ARGS,
  type RunResult,
} from './tailscale-nudge.js'

const DAY_MS = 24 * 60 * 60_000
/** Renew when fewer than this remain before notAfter. */
export const SIGNER_TLS_RENEW_BEFORE_MS = 30 * DAY_MS
/** How often a healthy pair is re-checked (also the first check's cadence after a success). */
export const SIGNER_TLS_CHECK_INTERVAL_MS = DAY_MS
/** First retry after a failed check; doubles per consecutive failure. */
export const SIGNER_TLS_RETRY_BASE_MS = 60_000
/** The longest cooldown between failed checks. */
export const SIGNER_TLS_RETRY_MAX_MS = 60 * 60_000
export const SIGNER_TLS_STATUS_TIMEOUT_MS = 5_000
/** ACME issuance through tailscaled can take tens of seconds. */
export const SIGNER_TLS_CERT_TIMEOUT_MS = 90_000
export const SIGNER_TLS_DIR = 'web-key-tls'
export const SIGNER_TLS_CERT_FILE = 'tailscale-cert.pem'
export const SIGNER_TLS_KEY_FILE = 'tailscale-key.pem'
export const SIGNER_TLS_KEY_MODE = 0o600
export const SIGNER_TLS_CERT_MODE = 0o644
/** Both outputs to stdout ("-"), see the header. The name is a normalised *.ts.net name, never a flag. */
export const SIGNER_TLS_CERT_ARGS = (name: string): string[] => ['cert', '--cert-file', '-', '--key-file', '-', name]

/** The only variables of this process's env a Tailscale CLI call here may see (each only if set), plus SHLVL. */
export const SIGNER_TLS_CLI_ENV_KEYS: readonly string[] = Object.freeze(['HOME', 'PATH', 'TMPDIR', 'USER', 'LANG'])

/**
 * The explicit, minimal env for this module's Tailscale CLI calls (status and cert): HOME, PATH, TMPDIR,
 * USER and LANG when set, and SHLVL=1. Never this process's env: it carries the .env values (the API token,
 * provider keys), which the Tailscale child has no need for.
 *
 * WHY SHLVL (probe 2026-11-10, operations/personal/wk46_2026/phone_key_build_20261110/
 * probe_tailscale_launchd/RESULT.md): the macsys Tailscale binary is the GUI app's own executable, and it
 * decides whether it runs as the CLI from SHLVL. A child of the LaunchAgent's node has none, so it tries to
 * be the GUI and prints "The Tailscale GUI failed to start (Tailscale.CLIError error 3)" with exit 0 in
 * 0.04 s; with SHLVL=1 (and only HOME and PATH besides) it answers the JSON in 0.03 s.
 *
 * Only this module's calls get it. tailscale-nudge has the same gap and is left unchanged: fixing it changes
 * behaviour for everyone and needs Miles's go (side finding, COORD 2026-11-10 12:03).
 */
export function signerTlsCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of SIGNER_TLS_CLI_ENV_KEYS) {
    const value = base[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  env.SHLVL = '1'
  return env
}

/** A runner for this module's CLI calls: like tailscale-nudge's TailscaleRunner, plus the env the child gets. */
export type SignerTlsRunner = (bin: string, args: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<RunResult>

/**
 * The default runner: a binary path and an argument array (never a shell), with `env` as the child's whole
 * env. The result mapping is tailscale-nudge's execFileRunner's, copied so that file stays byte-identical.
 */
export const signerTlsCliRunner: SignerTlsRunner = (bin, args, timeoutMs, env) => new Promise(resolve => {
  const started = Date.now()
  execFile(bin, [...args], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8', env },
    (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null
      const spawnError = err && typeof err.code === 'string' ? err.code : undefined
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
        signal: err?.signal ?? null,
        killed: !!err?.killed,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        ...(spawnError ? { spawnError } : {}),
        elapsedMs: Date.now() - started,
      })
    })
})
/** What the macOS CLI prints, with exit 0, when it cannot reach the GUI app (no SHLVL; see signerTlsCliEnv). */
const CLI_GUI_UNAVAILABLE = /Tailscale GUI failed to start|Tailscale\.CLIError error 3\b/i

export type SignerTlsReason =
  | 'ok'
  | 'pending'
  | 'tailnet_name_unknown'
  | 'tailnet_https_certs_off'
  | 'cert_domain_mismatch'
  | 'tailscale_not_running'
  | 'tailscale_cli_missing'
  | 'tailscale_cli_timeout'
  | 'tailscale_cli_gui_unavailable'
  | 'tailscale_status_failed'
  | 'tailscale_cert_failed'
  | 'cert_invalid'
  | 'cert_expired'
  | 'cert_store_failed'

export interface SignerTlsStatus {
  /** 3144 presents a publicly trusted, unexpired certificate for this Mac's tailnet name. */
  trusted: boolean
  /** `ok` when trusted; otherwise why not. */
  reason: SignerTlsReason
  /** The name the served certificate covers, or null. */
  host: string | null
  notAfter: string | null
  /** The last check's failure, or null after a clean check (a renewal can fail while a pair still serves). */
  lastError: SignerTlsReason | null
  checkedAt: string | null
  nextCheckAt: string | null
}

export interface SignerTlsPair {
  host: string
  certPem: string
  keyPem: string
  notAfterMs: number
  context: SecureContext
}

export type Timer = { cancel: () => void }

export interface SignerTlsDeps {
  /** <data dir>/web-key-tls. Created only when a pair is first stored. */
  dir: string
  /** This Mac's tailnet name (index.ts: tailnetSelf.refresh()). Null: unknown. */
  selfDnsName: () => Promise<string | null>
  /** Default signerTlsCliRunner. Every call gets signerTlsCliEnv() as the child's env. */
  runner?: SignerTlsRunner
  resolveBin?: () => string | null
  now?: () => number
  log?: (line: string) => void
  /** Test seam for the check timer. */
  schedule?: (fn: () => void, ms: number) => Timer
}

const defaultSchedule = (fn: () => void, ms: number): Timer => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return { cancel: () => clearTimeout(t) }
}

/** The cooldown after `consecutive` failed checks (1 = the first failure). */
export function signerTlsRetryMs(consecutive: number): number {
  const n = Math.max(1, Math.floor(consecutive))
  return Math.min(SIGNER_TLS_RETRY_BASE_MS * 2 ** (n - 1), SIGNER_TLS_RETRY_MAX_MS)
}

/** Whether a pair with this notAfter is due for renewal at `now`. */
export function signerTlsRenewalDue(notAfterMs: number, now: number): boolean {
  return notAfterMs - now < SIGNER_TLS_RENEW_BEFORE_MS
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END \1-----/g

/**
 * Validate a cert chain plus key for `name` (or, with name null, for the *.ts.net name the leaf
 * covers). Returns the pair with its TLS context, or null. Never throws.
 */
export function parseSignerTlsPair(text: string, name: string | null, now: number): SignerTlsPair | null {
  try {
    const certs: string[] = []
    const keys: string[] = []
    for (const m of text.matchAll(PEM_BLOCK)) {
      if (m[1] === 'CERTIFICATE') certs.push(m[0])
      else if (/(^| )PRIVATE KEY$/.test(m[1])) keys.push(m[0])
    }
    if (certs.length === 0 || keys.length !== 1) return null
    const leaf = new X509Certificate(certs[0])
    const host = name ?? leafTailnetName(leaf)
    if (!host || normalizeTailscaleDnsName(host) !== host) return null
    if (leaf.checkHost(host, { subject: 'never' })?.toLowerCase() !== host) return null
    const notAfterMs = Date.parse(leaf.validTo)
    if (!Number.isFinite(notAfterMs) || notAfterMs <= now) return null
    const certPem = `${certs.join('\n')}\n`
    const keyPem = `${keys[0]}\n`
    // Throws when the key does not belong to the leaf: a torn or swapped pair never serves.
    const context = createSecureContext({ cert: certPem, key: keyPem })
    return { host, certPem, keyPem, notAfterMs, context }
  } catch {
    return null
  }
}

function leafTailnetName(leaf: X509Certificate): string | null {
  const san = leaf.subjectAltName ?? ''
  for (const part of san.split(',')) {
    const m = /^\s*DNS:(.+)$/.exec(part)
    const n = m ? normalizeTailscaleDnsName(m[1]) : null
    if (n) return n
  }
  return null
}

function classifyCertFailure(r: RunResult): SignerTlsReason {
  if (r.spawnError) return 'tailscale_cli_missing'
  if (r.killed || r.signal) return 'tailscale_cli_timeout'
  const text = `${r.stderr}\n${r.stdout.includes('PRIVATE KEY') ? '' : r.stdout}`
  if (/does not support getting TLS certs|HTTPS cert(ificate)?s? (support )?(is |are )?not enabled|not enabled\/configured/i.test(text)) return 'tailnet_https_certs_off'
  if (/invalid domain|must be one of/i.test(text)) return 'cert_domain_mismatch'
  return 'tailscale_cert_failed'
}

function firstLine(s: string): string {
  return (s.split('\n').find(l => l.trim()) ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 160)
}

export class SignerTls {
  private readonly now: () => number
  private readonly runner: SignerTlsRunner
  private readonly resolveBin: () => string | null
  private readonly log: (line: string) => void
  private readonly schedule: (fn: () => void, ms: number) => Timer
  private current: SignerTlsPair | null = null
  private name: string | null = null
  private lastError: SignerTlsReason | null = null
  private checkedAt: number | null = null
  private nextCheckAt: number | null = null
  private failures = 0
  private cooldownUntil: number | null = null
  private inflight: Promise<SignerTlsStatus> | null = null
  private timer: Timer | null = null
  private stopped = false
  /** The stored files' `stat` signature the prompt pickup last read (null: never read). */
  private pickupSeen: string | null = null

  constructor(private readonly deps: SignerTlsDeps) {
    this.now = deps.now ?? Date.now
    this.runner = deps.runner ?? signerTlsCliRunner
    this.resolveBin = deps.resolveBin ?? (() => resolveTailscaleBin())
    this.log = deps.log ?? (line => console.log(line))
    this.schedule = deps.schedule ?? defaultSchedule
    this.loadStored()
  }

  /** For `https.createServer({ SNICallback })` on 3144. Unmatched: the server's default (mkcert) context. */
  readonly sniCallback = (servername: string, cb: (err: Error | null, ctx?: SecureContext) => void): void => {
    if (!this.sniMatches(this.current, servername)) this.pickUpStored()
    // Read again after the pickup: a pair stored just now serves in this same handshake.
    const pair = this.current
    if (pair && this.sniMatches(pair, servername)) {
      cb(null, pair.context)
      return
    }
    cb(null, undefined)
  }

  private sniMatches(pair: SignerTlsPair | null, servername: string): boolean {
    return pair !== null && typeof servername === 'string' && servername.toLowerCase() === pair.host && this.now() < pair.notAfterMs
  }

  /** The pair being served, for tests and diagnostics. */
  served(): SignerTlsPair | null { return this.current }

  /** A trusted pair serves: unexpired, and for this Mac's tailnet name once that is known. */
  private live(at: number): boolean {
    const pair = this.current
    return pair !== null && at < pair.notAfterMs && (this.name === null || this.name === pair.host)
  }

  /**
   * The prompt pickup (see the header). Only while nothing trusted serves. Two `stat` calls; the files
   * are read and validated only when their signature changed since the last pickup, so repeated
   * handshakes or status reads cost no parsing. Scoped to this Mac's name like the check's re-read, and
   * never a step back (loadStored). Never a CLI call, never a write, never throws.
   */
  private pickUpStored(): void {
    try {
      if (this.live(this.now())) return
      const sig = this.storedSignature()
      if (sig === null || sig === this.pickupSeen) return
      this.pickupSeen = sig
      const before = this.current
      this.loadStored(this.name)
      const pair = this.current
      if (pair !== null && pair !== before) this.log(`[signer-tls] serving a stored certificate on 3144 until ${new Date(pair.notAfterMs).toISOString()}`)
      else this.log('[signer-tls] a stored certificate was not taken: not valid for this Mac\'s tailnet name now (name, expiry or key)')
    } catch { /* the next handshake, status read or check tries again */ }
  }

  /** inode, size, mtime and ctime of both stored files; null when either is missing (any other stat error throws to the caller's catch). */
  private storedSignature(): string | null {
    const parts: string[] = []
    for (const file of [SIGNER_TLS_CERT_FILE, SIGNER_TLS_KEY_FILE]) {
      const st = statSync(join(this.deps.dir, file), { bigint: true, throwIfNoEntry: false })
      if (!st) return null
      parts.push(`${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`)
    }
    return parts.join('|')
  }

  /** Also the prompt pickup's second trigger: while nothing trusted serves, a status read looks at the stored files first. */
  status(): SignerTlsStatus {
    this.pickUpStored()
    const pair = this.current
    const at = this.now()
    const live = this.live(at)
    let reason: SignerTlsReason = 'ok'
    if (!live) reason = this.lastError ?? (pair && at >= pair.notAfterMs ? 'cert_expired' : 'pending')
    return {
      trusted: live,
      reason,
      host: pair ? pair.host : null,
      notAfter: pair ? new Date(pair.notAfterMs).toISOString() : null,
      lastError: this.lastError,
      checkedAt: this.checkedAt === null ? null : new Date(this.checkedAt).toISOString(),
      nextCheckAt: this.nextCheckAt === null ? null : new Date(this.nextCheckAt).toISOString(),
    }
  }

  /** The boot check, then one every interval (or after the cooldown while failing). */
  start(): void {
    this.stopped = false
    void this.check()
  }

  stop(): void {
    this.stopped = true
    this.timer?.cancel()
    this.timer = null
  }

  /** One check (single-flight). Never throws. */
  check(): Promise<SignerTlsStatus> {
    if (this.inflight) return this.inflight
    this.inflight = this.runCheck()
      .catch(() => { this.fail('tailscale_cert_failed') })
      .then(() => {
        try { this.reschedule() } catch { /* the next boot checks again */ }
        return this.status()
      })
      .finally(() => { this.inflight = null })
    return this.inflight
  }

  private reschedule(): void {
    this.timer?.cancel()
    this.timer = null
    if (this.stopped) return
    const at = this.now()
    const next = this.failures > 0 && this.cooldownUntil !== null ? this.cooldownUntil : at + SIGNER_TLS_CHECK_INTERVAL_MS
    this.nextCheckAt = next
    this.timer = this.schedule(() => { void this.check() }, Math.max(0, next - at))
  }

  private succeed(storeFailed: boolean): void {
    this.failures = 0
    this.cooldownUntil = null
    this.lastError = storeFailed ? 'cert_store_failed' : null
    this.checkedAt = this.now()
  }

  private fail(reason: SignerTlsReason, facts = ''): void {
    const at = this.now()
    this.failures += 1
    this.cooldownUntil = at + signerTlsRetryMs(this.failures)
    this.lastError = reason
    this.checkedAt = at
    this.log(`[signer-tls] no trusted certificate: ${reason}${facts ? ` (${facts})` : ''}; next try in ${Math.round(signerTlsRetryMs(this.failures) / 1000)}s`)
  }

  private async runCheck(): Promise<void> {
    let name: string | null = null
    try { name = normalizeTailscaleDnsName(await this.deps.selfDnsName()) } catch { name = null }
    if (!name) { this.fail('tailnet_name_unknown'); return }
    this.name = name
    // A pair stored by another process (e.g. COS Control's helper, if this LaunchAgent's CLI cannot
    // answer) is picked up here, validated, without a restart and without a CLI call.
    this.loadStored(name)
    const at = this.now()
    const pair = this.current
    if (pair && pair.host === name && !signerTlsRenewalDue(pair.notAfterMs, at)) { this.succeed(false); return }
    // The breaker: no CLI call inside the cooldown after a failure.
    if (this.cooldownUntil !== null && at < this.cooldownUntil) return
    const bin = this.resolveBin()
    if (!bin) { this.fail('tailscale_cli_missing'); return }
    // The minimal env with SHLVL=1 for both calls (signerTlsCliEnv): never this process's env.
    const cliEnv = signerTlsCliEnv()

    const st = await this.runner(bin, STATUS_ARGS, SIGNER_TLS_STATUS_TIMEOUT_MS, cliEnv)
    if (st.spawnError) { this.fail('tailscale_cli_missing', `spawn ${st.spawnError}`); return }
    if (st.killed || st.signal) { this.fail('tailscale_cli_timeout', `status killed=${st.killed} signal=${st.signal ?? ''} ${st.elapsedMs}ms`); return }
    const parsed = st.code === 0 ? parseTailscaleStatus(st.stdout, this.now()) : null
    if (!parsed) {
      // The CLI's "GUI failed to start" answer (exit 0, see signerTlsCliEnv) gets its own reason, so the status names it.
      this.fail(CLI_GUI_UNAVAILABLE.test(`${st.stdout}\n${st.stderr}`) ? 'tailscale_cli_gui_unavailable' : 'tailscale_status_failed', `status code=${st.code} ${firstLine(st.stderr)}`)
      return
    }
    if (parsed.backendState !== 'Running') { this.fail('tailscale_not_running', parsed.backendState); return }
    const domains = parsed.certDomains ?? []
    if (domains.length === 0) { this.fail('tailnet_https_certs_off'); return }
    if (!domains.includes(name)) { this.fail('cert_domain_mismatch'); return }

    const r = await this.runner(bin, SIGNER_TLS_CERT_ARGS(name), SIGNER_TLS_CERT_TIMEOUT_MS, cliEnv)
    if (r.spawnError || r.killed || r.signal || r.code !== 0) {
      this.fail(classifyCertFailure(r), `cert code=${r.code} killed=${r.killed} signal=${r.signal ?? ''} ${r.elapsedMs}ms ${firstLine(r.stderr)}`)
      return
    }
    const fresh = parseSignerTlsPair(r.stdout, name, this.now())
    if (!fresh) { this.fail('cert_invalid'); return }
    let storeFailed = false
    try { this.store(fresh) } catch { storeFailed = true }
    // The hot swap: the next 3144 handshake reads this pair.
    this.current = fresh
    this.succeed(storeFailed)
    this.log(`[signer-tls] serving a trusted certificate on 3144 until ${new Date(fresh.notAfterMs).toISOString()}${storeFailed ? ' (not saved: cert_store_failed)' : ''}`)
  }

  private store(pair: SignerTlsPair): void {
    mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 })
    chmodSync(this.deps.dir, 0o700)
    // Key first: a crash between the two writes leaves a pair that fails to load (key mismatch) and is fetched again.
    durableAtomicWriteFileSync(join(this.deps.dir, SIGNER_TLS_KEY_FILE), pair.keyPem, { mode: SIGNER_TLS_KEY_MODE })
    durableAtomicWriteFileSync(join(this.deps.dir, SIGNER_TLS_CERT_FILE), pair.certPem, { mode: SIGNER_TLS_CERT_MODE })
  }

  /** With a name: only a pair for exactly that name. Without (at construction): the *.ts.net name the leaf covers. */
  private loadStored(name: string | null = null): void {
    try {
      const certPath = join(this.deps.dir, SIGNER_TLS_CERT_FILE)
      const keyPath = join(this.deps.dir, SIGNER_TLS_KEY_FILE)
      if (!existsSync(certPath) || !existsSync(keyPath)) return
      const pair = parseSignerTlsPair(`${readFileSync(certPath, 'utf8')}\n${readFileSync(keyPath, 'utf8')}`, name, this.now())
      // Never a step back: only when nothing serves, the serving pair names another host, or this one lasts longer.
      if (pair && (this.current === null || this.current.host !== pair.host || pair.notAfterMs > this.current.notAfterMs)) this.current = pair
    } catch { /* nothing stored that serves: the check fetches */ }
  }
}

/**
 * index.ts's one door: a SignerTls only with COS_WEB_KEY_AUTHORITY on AND the 3144 listener planned.
 * Otherwise null, and nothing is read, written or run.
 */
export function createSignerTlsForBoot(opts: { authorityEnabled: boolean; signerListener: boolean }, deps: SignerTlsDeps): SignerTls | null {
  if (opts.authorityEnabled !== true || opts.signerListener !== true) return null
  return new SignerTls(deps)
}

/** The 3144 server's TLS options: the mkcert pair as the default, plus SNI selection when a SignerTls exists. */
export function signerHttpsOptions(base: { cert: Buffer | string; key: Buffer | string }, tls: SignerTls | null): HttpsServerOptions {
  return tls ? { ...base, SNICallback: tls.sniCallback } : { ...base }
}
