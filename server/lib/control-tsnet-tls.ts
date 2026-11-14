// X1 (iPhone pings, 2026-11-14): Control Web over https on this Mac's own tailnet name, port 3143.
//
// WHY. His phone opens Control Web over plain http on the Mac's ts.net name (the caps row of 11/14 09:52:30: secure
// false, proto http, hostKind ts.net), so it is not a secure context and cannot subscribe to push. 3143 serves the
// mkcert pair, which his phone does not trust and which does not name the ts.net host. This lets 3143 present a
// publicly trusted certificate for exactly that name, by SNI, and nothing else changes.
//
// WHAT IT REUSES, UNCHANGED. lib/web-key-signer-tls.ts (the phone key's 3144 signer, B2) already fetches the pair from
// the local Tailscale daemon, stores it atomically (folder 0700, key 0600, owner checked, never logged), checks the
// chain and the name, renews 30 days ahead with backoff, picks up a pair written by hand, and serves it only to a
// handshake naming exactly this Mac's host. This module only decides WHICH SignerTls 3143 asks, at handshake time:
//   - the signer's own instance when it exists (COS_WEB_KEY_AUTHORITY on): one name, one pair, one folder, so there
//     is never a second renewal loop on the same files;
//   - otherwise one instance of its own, made and started only by start(), after the listeners are up.
//
// OFF (COS_CONTROL_TSNET_HTTPS unset or anything but 1/true/on, read once at boot): createControlTsnetTlsForBoot
// returns null, 3143's options are exactly { cert, key } as before, and no Tailscale call, file or health field exists.
//
// ON. A handshake naming exactly this Mac's ts.net host gets the trusted pair; every other one (the IP, localhost,
// api.gotcos.com, no name) gets 3143's default, the mkcert pair, byte for byte as today. An expired pair is never
// served (SignerTls.sniMatches): that handshake gets mkcert, which the phone does not trust, so a lapse is a loud
// certificate error, never a silent fall back to http. Turning the switch on is what requests the certificate, and
// that puts the machine's full ts.net name in the public Certificate Transparency log: Miles's typed go, each time.

import type { SecureContext } from 'node:tls'
import type { ServerOptions as HttpsServerOptions } from 'node:https'
import { readSwitch } from './env-switch.js'
import { SignerTls, type SignerTlsDeps, type SignerTlsStatus } from './web-key-signer-tls.js'

/** `COS_CONTROL_TSNET_HTTPS`: default OFF. Read once at boot (index.ts); a change takes a restart. */
export function controlTsnetHttpsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readSwitch(env.COS_CONTROL_TSNET_HTTPS, false)
}

/** What /api/health says about it (public route): never the host name, never a key, never CLI output. */
export interface ControlTsnetHealth {
  /** `serving`: a trusted pair for this Mac's name is served. `not_serving`: none is (see `reason`). `starting`: no check yet. */
  state: 'serving' | 'not_serving' | 'starting'
  /** Why nothing trusted serves, or null while serving. */
  reason: string | null
  /** The last check's failure while a pair still serves (a renewal can fail before expiry), or null. */
  renewalError: string | null
  /** The served certificate's notAfter (ISO), or null. */
  expiresAt: string | null
}

export function controlTsnetHealthFrom(status: SignerTlsStatus | null): ControlTsnetHealth {
  if (!status) return { state: 'starting', reason: null, renewalError: null, expiresAt: null }
  if (status.trusted) return { state: 'serving', reason: null, renewalError: status.lastError, expiresAt: status.notAfter }
  if (status.checkedAt === null && status.lastError === null) return { state: 'starting', reason: null, renewalError: null, expiresAt: null }
  return { state: 'not_serving', reason: status.lastError ?? status.reason, renewalError: null, expiresAt: null }
}

export class ControlTsnetTls {
  private own: SignerTls | null = null

  constructor(
    /** The phone key signer's instance, read at handshake time (it is made later in the listener loop, or never). */
    private readonly signer: () => SignerTls | null,
    private readonly deps: SignerTlsDeps,
    private readonly make: (deps: SignerTlsDeps) => SignerTls = d => new SignerTls(d),
  ) {}

  /** The instance 3143 asks now: the signer's when it exists, else this module's own (null until start()). */
  active(): SignerTls | null {
    return this.signer() ?? this.own
  }

  /** For `https.createServer({ SNICallback })` on 3143. No instance yet, or no match: 3143's default (mkcert) context. */
  readonly sniCallback = (servername: string, cb: (err: Error | null, ctx?: SecureContext) => void): void => {
    const tls = this.active()
    if (!tls) { cb(null, undefined); return }
    tls.sniCallback(servername, cb)
  }

  /** After the listeners are up: makes and starts an own instance only when the signer's does not exist. */
  start(): void {
    if (this.signer() !== null || this.own !== null) return
    this.own = this.make(this.deps)
    this.own.start()
  }

  stop(): void {
    this.own?.stop()
  }

  /** The health field. statusRead (SR-04) may start one bounded re-check for failures a user fixes outside COS. */
  health(): ControlTsnetHealth {
    const tls = this.active()
    return controlTsnetHealthFrom(tls ? tls.statusRead() : null)
  }
}

/** index.ts's one door: an instance only with the switch on AND 3143 planned (mkcert present). Otherwise null. */
export function createControlTsnetTlsForBoot(
  opts: { enabled: boolean; httpsAvailable: boolean },
  signer: () => SignerTls | null,
  deps: SignerTlsDeps,
  make?: (deps: SignerTlsDeps) => SignerTls,
): ControlTsnetTls | null {
  if (opts.enabled !== true || opts.httpsAvailable !== true) return null
  return new ControlTsnetTls(signer, deps, make)
}

/** 3143's TLS options: the mkcert pair as the default, plus SNI selection only when an instance exists. */
export function controlHttpsOptions(base: { cert: Buffer | string; key: Buffer | string }, tls: ControlTsnetTls | null): HttpsServerOptions {
  return tls ? { ...base, SNICallback: tls.sniCallback } : { ...base }
}

// The one instance index.ts made (or null), for the public health route. Set once at boot.
let registered: ControlTsnetTls | null = null
export function registerControlTsnetTls(tls: ControlTsnetTls | null): void {
  registered = tls
}

/** `{ controlTsnetHttps }` only while it exists; absent with the switch off, exactly as before. */
export function controlTsnetHealthField(): { controlTsnetHttps?: ControlTsnetHealth } {
  return registered ? { controlTsnetHttps: registered.health() } : {}
}
