/** Phone authority requires a fresh, Mac-anchor-signed disclosure. A raw env flag grants nothing. */
import { randomBytes } from 'node:crypto'
import { canonicalBytes, b64url, fromB64url, verifyP1363 } from './web-key-envelope.js'
import { normalizeTailscaleDnsName as webKeyRpId } from './network-policy.js'
import { webKeyAuthorityEnabled } from './web-key-authority.js'
import type { WebKeyRegistry } from './web-key-registry.js'

export const WEB_AUTHORITY_ACTIVATION_PROTOCOL = 'cos-web-authority-on/1'
export const WEB_AUTHORITY_ACTIVATION_TTL_SECONDS = 120
export interface AuthorityOnStatement {
  v: typeof WEB_AUTHORITY_ACTIVATION_PROTOCOL; action: 'on'; anchorSpkiSha256: string
  aud: string; origin: string; publicName: string; device: string; epoch: number
  nonce: string; iat: number; exp: number
}
export function canonicalPhoneDevice(value: unknown): value is string {
  if (typeof value !== 'string' || !/^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return false
  const parts = value.split('.').map(Number)
  return parts[1] >= 64 && parts[1] <= 127 && parts.every(n => n <= 255) && parts.join('.') === value
}
export function parseAuthorityOn(statement: unknown): { value: AuthorityOnStatement; bytes: Buffer } | null {
  const bytes = fromB64url(statement)
  if (!bytes || bytes.length > 2048 || b64url(bytes) !== statement) return null
  try {
    const s = JSON.parse(bytes.toString('utf8')) as AuthorityOnStatement
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).sort().join(',') !== 'action,anchorSpkiSha256,aud,device,epoch,exp,iat,nonce,origin,publicName,v') return null
    if (s.v !== WEB_AUTHORITY_ACTIVATION_PROTOCOL || s.action !== 'on' || typeof s.anchorSpkiSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.anchorSpkiSha256) || typeof s.aud !== 'string' || !/^[0-9a-f]{64}$/.test(s.aud)) return null
    if (!canonicalPhoneDevice(s.device) || typeof s.publicName !== 'string' || webKeyRpId(s.publicName) !== s.publicName || s.origin !== `https://${s.publicName}:3144`) return null
    if (![s.epoch, s.iat, s.exp].every(n => Number.isSafeInteger(n) && n >= 0) || s.exp <= s.iat || s.exp - s.iat > WEB_AUTHORITY_ACTIVATION_TTL_SECONDS) return null
    if (typeof s.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(s.nonce) || fromB64url(s.nonce)?.length !== 32 || b64url(fromB64url(s.nonce)!) !== s.nonce) return null
    if (!canonicalBytes(s)?.equals(bytes)) return null
    return { value: s, bytes }
  } catch { return null }
}
export class WebKeyActivation {
  private bootResolved = false
  private bootGrant: string | null = null
  constructor(private readonly deps: { registry: WebKeyRegistry; selfDnsName: () => string | null; env?: () => NodeJS.ProcessEnv; now?: () => number; onOff?: () => void | boolean }) {}
  private now(): number { return Math.floor((this.deps.now ?? Date.now)() / 1000) }
  private matches(s: AuthorityOnStatement): boolean {
    const r = this.deps.registry
    const anchor = r.anchor()
    const name = webKeyRpId(this.deps.selfDnsName())
    return !!anchor && r.anchorMature() && name !== null && s.publicName === name && s.origin === `https://${name}:3144`
      && s.anchorSpkiSha256 === anchor.spkiSha256 && s.aud === r.aud(name) && s.epoch === r.activationEpoch()
  }
  accepted(): boolean {
    try {
      const state = this.deps.registry.activationState()
      const g = state?.grant
      const parsed = g ? parseAuthorityOn(g.statement) : null
      const anchor = this.deps.registry.anchor()
      return !!(g && parsed && anchor && this.matches(parsed.value) && g.consumedNonce === parsed.value.nonce
        && g.acceptedAt >= parsed.value.iat && g.acceptedAt < parsed.value.exp && g.acceptedAt <= this.now()
        && verifyP1363(anchor.key, parsed.bytes, g.signature))
    } catch { return false }
  }
  /** Called once, after the bounded boot name lookup, before planning surfaces. A late name or
   * newly accepted grant cannot rearm a process whose signer listener/integrity were not planned. */
  armAtBoot(): boolean {
    if (this.bootResolved) return this.enabled()
    this.bootResolved = true
    if (this.accepted()) {
      const grant = this.deps.registry.activationState()!.grant!
      const env = (this.deps.env ?? (() => process.env))()
      if (webKeyAuthorityEnabled(env) && env.COS_WEB_KEY_DEVICES === parseAuthorityOn(grant.statement)!.value.device) this.bootGrant = grant.statement
    }
    return this.enabled()
  }
  /** The ONE effective authority predicate, also used for TLS issuance, routes and cookie origin. */
  enabled(name?: string | null): boolean {
    try {
      const env = (this.deps.env ?? (() => process.env))()
      if (!this.bootResolved || !this.bootGrant || !webKeyAuthorityEnabled(env) || !this.accepted()) return false
      const grant = parseAuthorityOn(this.deps.registry.activationState()!.grant!.statement)!.value
      return this.deps.registry.activationState()!.grant!.statement === this.bootGrant && env.COS_WEB_KEY_DEVICES === grant.device && (name === undefined || name === grant.publicName)
    } catch { return false }
  }
  reconcileOffAtBoot(): void {
    const env = (this.deps.env ?? (() => process.env))()
    const state = this.deps.registry.activationState()
    if (!webKeyAuthorityEnabled(env) && (state?.grant || state?.pending) && !this.off().ok) throw new Error('Cannot durably invalidate phone authority activation')
  }
  status(): Record<string, unknown> {
    return { activationProtocol: WEB_AUTHORITY_ACTIVATION_PROTOCOL, activationEpoch: this.deps.registry.activationEpoch(), activationAccepted: this.accepted(),
      ...(this.bootResolved ? { bootArm: { armed: this.enabled(), reason: this.bootArmReason(), waitedMs: this.bootWaitMs } } : {}) }
  }
  /**
   * 7.0.53 (the boot race): whether arming could happen if the name were known, so boot may wait for the name: authority on, a
   * grant whose device is this Mac's configured phone, and a mature anchor. Everything accepted() checks except the name.
   */
  bootWaitWanted(): boolean {
    try {
      const env = (this.deps.env ?? (() => process.env))()
      const g = this.deps.registry.activationState()?.grant
      const parsed = g ? parseAuthorityOn(g.statement) : null
      return !!(webKeyAuthorityEnabled(env) && parsed && env.COS_WEB_KEY_DEVICES === parsed.value.device && this.deps.registry.anchor() && this.deps.registry.anchorMature())
    } catch { return false }
  }
  private bootWaitMs: number | null = null
  /** 7.0.53: how long boot waited for the name before arming (null: it did not wait). */
  noteBootWait(waitedMs: number | null): void { this.bootWaitMs = waitedMs }
  private bootArmReason(): string | null {
    if (this.enabled()) return null
    if (!this.bootWaitWanted()) return 'not_configured'
    return this.deps.selfDnsName() === null ? 'tailnet_name_unknown_at_boot' : 'not_accepted_at_boot'
  }
  challenge(device: unknown): { ok: true; statement: string } | { ok: false; reason: string } {
    const r = this.deps.registry
    const state = r.activationState()
    if (!state) return { ok: false, reason: 'registry_unavailable' }
    if (!canonicalPhoneDevice(device)) return { ok: false, reason: 'device_invalid' }
    const anchor = r.anchor()
    if (!anchor || !r.anchorMature()) return { ok: false, reason: 'anchor_not_mature' }
    const name = webKeyRpId(this.deps.selfDnsName())
    const aud = r.aud(name)
    if (!name || !aud) return { ok: false, reason: 'tailnet_name_unknown' }
    const iat = this.now()
    const value: AuthorityOnStatement = { v: WEB_AUTHORITY_ACTIVATION_PROTOCOL, action: 'on', anchorSpkiSha256: anchor.spkiSha256, aud, origin: `https://${name}:3144`, publicName: name, device, epoch: state.epoch, nonce: randomBytes(32).toString('base64url'), iat, exp: iat + WEB_AUTHORITY_ACTIVATION_TTL_SECONDS }
    const statement = b64url(canonicalBytes(value)!)
    if (!r.saveActivation({ ...state, pending: statement })) return { ok: false, reason: 'registry_write_failed' }
    return { ok: true, statement }
  }
  accept(statement: unknown, signature: unknown): { ok: true } | { ok: false; reason: string } {
    const r = this.deps.registry
    const state = r.activationState()
    const parsed = parseAuthorityOn(statement)
    if (!state || !parsed || state.pending !== statement) return { ok: false, reason: 'activation_challenge_required' }
    const at = this.now()
    if (!this.matches(parsed.value)) return { ok: false, reason: 'activation_context_changed' }
    if (at < parsed.value.iat || at >= parsed.value.exp) return { ok: false, reason: 'activation_expired' }
    const sig = fromB64url(signature)
    if (!sig || sig.length !== 64 || b64url(sig) !== signature || !verifyP1363(r.anchor()!.key, parsed.bytes, signature)) return { ok: false, reason: 'activation_signature_invalid' }
    if (!r.saveActivation({ ...state, pending: null, grant: { statement: statement as string, signature: signature as string, acceptedAt: at, consumedNonce: parsed.value.nonce } })) return { ok: false, reason: 'registry_write_failed' }
    return { ok: true }
  }
  /** Closing planned surfaces is terminal for this process, even if a lost name later returns. */
  disarm(): void { this.bootGrant = null }

  off(): { ok: true } | { ok: false; reason: string } {
    this.disarm()
    const ok = this.deps.registry.disableActivation()
    // Close live authority surfaces even if storage fails; never acknowledge a durable Off on failure.
    const cleaned = this.deps.onOff?.() !== false
    return ok && cleaned ? { ok: true } : { ok: false, reason: 'registry_write_failed' }
  }
}

// Health reads the same verified predicate; raw flags never advertise an unsigned signer.
let registeredActivation: WebKeyActivation | null = null
export function registerWebKeyActivation(activation: WebKeyActivation | null): void { registeredActivation = activation }
export function webKeyActivationHealthField(): { webKeySigner?: 1 } {
  return registeredActivation?.enabled() ? { webKeySigner: 1 } : {}
}
