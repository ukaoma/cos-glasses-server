// The enrolled phone key registry, enrollment ceremony, server nonces and approval packets
// (6.99.31, plan §4.2, §4.3, §4.5, §4.7). Everything here is inert unless COS_WEB_KEY_AUTHORITY
// is on (the routes and the provenance hook check the flag; this module holds state only).
//
// THE TRUST ROOT is the anchor: COS Control's Secure Enclave P-256 key, usable only after Touch ID
// (`.biometryCurrentSet`). Its public key sits in the registry file's `anchorPub`. An entry counts
// only while its `anchorSig` verifies against that anchor over the exact approval object the
// server froze at proof of possession. An entry without a valid anchorSig is ignored, so a line
// any local process writes into web-keys.json enrolls nothing.
//
// ANCHOR BOOTSTRAP (review B1). The anchor reaches this server only through POST
// /api/web-key/anchor: loopback socket, X-Cos-Token, and a self-signature by the anchor over a
// versioned statement (`cos-web-anchor/1`: spkiSha256, fingerprint, createdAt). The registry keeps
// that record next to `anchorPub` with `setAt` (server clock). An `anchorPub` in the file without
// a registration record whose self-signature verifies is refused (`anchor_unregistered`). A new or
// replaced anchor vouches nothing for WEB_ANCHOR_MATURITY_MS (24 h). `setAt` is file-backed, so a
// same-user process can backdate it: the verifier's committed pin is the real check, which is why
// the turn answer exposes the anchor's spkiSha256 and age.
//
// REVOCATION NEVER NEEDS THE ANCHOR, so a lost phone can always be revoked (by a token holder too:
// that is denial of service, logged, not forgery). Revocations in memory are never undone by a
// later read of the file: the registry is read once at boot.

import { appendFileSync, readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import {
  b64url, canonicalBytes, fingerprintOfSpki, fromB64url, kidOfSpki, parseP256Spki, sha256Hex, verifyP1363,
} from './web-key-envelope.js'
import {
  APPROVE_ACTIONS, approveFieldsValid, canonicalJson, WEB_ANCHOR_STATEMENT_VERSION, WEB_APPROVAL_PACKET_VERSION, WEB_APPROVAL_PACKET_MAX_LIFETIME_MS, WEB_ENROLL_APPROVE_VERSION, WEB_ENROLL_PROOF_VERSION, type WebApprovalPacket,
} from '../../shared/web-turn-envelope.js'
import { coseP256ToSpki, parsePasskeyAssertion, verifyPasskeyAssertion } from './web-key-passkey.js'
import type { KeyObject } from 'node:crypto'

export const WEB_KEYS_FILE = 'web-keys.json'
export const WEB_KEY_AUDIT_FILE = 'web-key-audit.jsonl'
export const WEB_KEY_NONCES_FILE = 'web-key-nonces.json'
/** Active keys at once (plan §4.3). */
export const WEB_KEY_MAX_ACTIVE = 2
/** A pending enrollment lives this long from start. */
export const WEB_ENROLL_TTL_MS = 5 * 60_000
/** Proof-of-possession attempts before the pending request is burned. */
export const WEB_ENROLL_MAX_PROOF_ATTEMPTS = 3
/** A server nonce lives this long (the longest an envelope may live). */
export const WEB_NONCE_TTL_MS = 15 * 60_000
/** Unspent nonces held at once. A flood is refused, never evicts a live one. */
export const WEB_NONCE_MAX_OUTSTANDING = 64
/** Spent-turn tombstones (the consume endpoint) are kept this long: far past any envelope's life. */
export const WEB_CONSUMED_KEEP_MS = 7 * 24 * 3_600_000
/** An approval packet stays open this long. */
export const WEB_PACKET_TTL_MS = WEB_APPROVAL_PACKET_MAX_LIFETIME_MS
export const WEB_PACKET_MAX_OPEN = 32
const LABEL_MAX = 64
/** A new or replaced anchor vouches nothing for this long after it is registered (review B1). */
export const WEB_ANCHOR_MATURITY_MS = 24 * 3_600_000
/** How far the anchor statement's createdAt may sit from the server clock. */
export const WEB_ANCHOR_STATEMENT_SKEW_MS = 10 * 60_000

/**
 * The 6-digit SAS (review W3, commit-reveal): sha256(challenge || spki || r), first 4 bytes mod 10^6.
 * The phone committed to sha256(r) BEFORE the server picked the challenge, so a patched server can
 * no longer grind challenges until an attacker key's SAS equals the phone's.
 */
export function sasOf(challenge: Buffer, spkiDer: Buffer, phoneNonce: Buffer): string {
  const digest = createHash('sha256').update(challenge).update(spkiDer).update(phoneNonce).digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

/** Normalize a socket address for the device allowlist and the approval (no IPv4-mapped prefix). */
export function normalizeRemote(remote: string): string {
  const r = remote.trim().toLowerCase()
  return r.startsWith('::ffff:') && /^\d+\.\d+\.\d+\.\d+$/.test(r.slice(7)) ? r.slice(7) : r
}

/** The device allowlist (review W6): COS_WEB_KEY_DEVICES, comma-separated addresses. Empty: none. */
export function deviceAllowlistFrom(env: NodeJS.ProcessEnv = process.env): (remote: string) => boolean {
  const list = new Set((env.COS_WEB_KEY_DEVICES ?? '').split(',').map(s => normalizeRemote(s)).filter(Boolean))
  return (remote: string) => list.size > 0 && list.has(normalizeRemote(remote))
}

/** The install identity the envelope's `aud` names: sha256(anchor SPKI DER || lower-case MagicDNS name), hex. */
export function audOf(anchorDer: Buffer, selfDnsName: string): string {
  return sha256Hex(Buffer.concat([anchorDer, Buffer.from(selfDnsName.trim().toLowerCase(), 'utf8')]))
}

/** The exact object the anchor signs to approve one phone key (frozen by the server at proof of possession). */
/**
 * Every value COS Control displays is inside these bytes (review W4): Control decodes approvalJcs
 * and derives the SAS, fingerprint and label from it. `label`, `userAgent` and `remote` are text
 * the enrolling request supplied; `remote` is the socket address (review W6).
 */
export interface WebKeyApproval {
  v: typeof WEB_ENROLL_APPROVE_VERSION
  enrollId: string
  kid: string
  spki: string
  spki_sha256: string
  fingerprint: string
  label: string
  userAgent: string
  remote: string
  challenge: string
  sasCommit: string
  phoneNonce: string
  sas: string
  aud: string
  origin: string
  kver: number
  epoch: number
  /** The one key this approval revokes (review W8), or null. */
  rotates: string | null
  passkey_credential_id: string
  passkey_spki_sha256: string
  enrolledAt: number
  exp: number
}

export interface WebKeyEntry {
  kid: string
  spki: string
  label: string
  enrolledAt: number
  kver: number
  /** The passkey's P-256 SPKI (b64url, converted from COSE at enrollment); anchored by its hash. */
  passkeySpki: string
  approval: WebKeyApproval
  anchorSig: string
  revokedAt?: number
  revokeReason?: string
  revokedBy?: string
  lastUsedAt?: number
}

/** The anchor's bootstrap record (review B1): its self-signed statement and when it was registered. */
export interface AnchorRegistration { statement: string; signature: string; setAt: number }

interface RegistryFile { v: 1; anchorPub: string | null; anchorRegistration: AnchorRegistration | null; epoch: number; entries: WebKeyEntry[] }

export type EntryState =
  | { ok: true; entry: WebKeyEntry; key: KeyObject; passkeyKey: KeyObject }
  | { ok: false; reason: 'key_unknown' | 'key_unanchored' | 'key_revoked' | 'key_epoch_stale' }

export interface RegisteredAnchor { b64: string; key: KeyObject; der: Buffer; spkiSha256: string; fingerprint: string; setAt: number }

export type AnchorRegisterResult =
  | { ok: true; spkiSha256: string; fingerprint: string; setAt: number; replaced: boolean }
  | { ok: false; reason: 'registry_unreadable' | 'invalid_key' | 'statement_invalid' | 'statement_not_canonical' | 'statement_mismatch' | 'statement_stale' | 'anchor_signature_invalid' | 'registry_write_failed' }

/** The anchor's self-signed statement, as JCS bytes, or null when it is not exactly that shape. */
function parseAnchorStatement(bytes: Buffer): { spkiSha256: string; fingerprint: string; createdAt: number } | 'not_canonical' | null {
  let v: unknown
  try { v = JSON.parse(bytes.toString('utf8')) } catch { return null }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort()
  if (keys.join(',') !== 'createdAt,fingerprint,spkiSha256,v') return null
  if (o.v !== WEB_ANCHOR_STATEMENT_VERSION || typeof o.spkiSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.spkiSha256)) return null
  if (typeof o.fingerprint !== 'string' || !/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(o.fingerprint)) return null
  if (typeof o.createdAt !== 'number' || !Number.isSafeInteger(o.createdAt) || o.createdAt < 0) return null
  const canonical = canonicalBytes(o)
  if (!canonical || !canonical.equals(bytes)) return 'not_canonical'
  return { spkiSha256: o.spkiSha256, fingerprint: o.fingerprint, createdAt: o.createdAt }
}

export class WebKeyRegistry {
  private data: RegistryFile = { v: 1, anchorPub: null, anchorRegistration: null, epoch: 0, entries: [] }
  /** The file could not be read as a registry: everything refuses and nothing is written over it. */
  readonly unreadable: boolean
  private anchorCache: { key: string; anchor: RegisteredAnchor | null } | null = null

  constructor(private readonly file: string, private readonly auditFile: string, private readonly now: () => number = Date.now) {
    let unreadable = false
    let raw: string | null = null
    try { raw = readFileSync(file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') unreadable = true
    }
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Partial<RegistryFile>
        if (parsed && parsed.v === 1 && Array.isArray(parsed.entries) && Number.isSafeInteger(parsed.epoch) && (parsed.anchorPub === null || typeof parsed.anchorPub === 'string')) {
          const reg = parsed.anchorRegistration
          const anchorRegistration = reg && typeof reg === 'object' && typeof reg.statement === 'string' && typeof reg.signature === 'string' && Number.isSafeInteger(reg.setAt)
            ? { statement: reg.statement, signature: reg.signature, setAt: reg.setAt } : null
          this.data = { v: 1, anchorPub: parsed.anchorPub ?? null, anchorRegistration, epoch: parsed.epoch as number, entries: parsed.entries.filter(e => e && typeof e.kid === 'string') }
        } else unreadable = true
      } catch { unreadable = true }
    }
    this.unreadable = unreadable
    if (unreadable) console.error(`[web-key] registry ${file} is unreadable: every enrollment and signed turn is refused until it is repaired`)
  }

  /**
   * The registered anchor, or null: none in the file, not a P-256 key, the registry unreadable, or
   * no bootstrap record whose self-signature verifies over a statement naming this very key (B1).
   */
  anchor(): RegisteredAnchor | null {
    if (this.unreadable || !this.data.anchorPub) return null
    const reg = this.data.anchorRegistration
    const cacheKey = `${this.data.anchorPub}|${reg?.statement ?? ''}|${reg?.signature ?? ''}|${reg?.setAt ?? ''}`
    if (this.anchorCache?.key === cacheKey) return this.anchorCache.anchor
    let anchor: RegisteredAnchor | null = null
    const parsed = parseP256Spki(this.data.anchorPub)
    if (parsed && reg) {
      const bytes = fromB64url(reg.statement)
      const stmt = bytes ? parseAnchorStatement(bytes) : null
      const spkiSha256 = sha256Hex(parsed.der)
      const fingerprint = fingerprintOfSpki(parsed.der)
      if (bytes && stmt && stmt !== 'not_canonical' && stmt.spkiSha256 === spkiSha256 && stmt.fingerprint === fingerprint
        && verifyP1363(parsed.key, bytes, reg.signature)) {
        anchor = { b64: this.data.anchorPub, key: parsed.key, der: parsed.der, spkiSha256, fingerprint, setAt: reg.setAt }
      }
    }
    this.anchorCache = { key: cacheKey, anchor }
    return anchor
  }

  /** Why there is no usable anchor: none at all, or a key without a valid bootstrap record. Null when there is one. */
  anchorRefusal(): 'anchor_not_registered' | 'anchor_unregistered' | null {
    if (this.anchor()) return null
    return this.data.anchorPub && !this.unreadable ? 'anchor_unregistered' : 'anchor_not_registered'
  }

  /** Whether the registered anchor is past WEB_ANCHOR_MATURITY_MS (a new or replaced anchor vouches nothing before). */
  anchorMature(): boolean {
    const a = this.anchor()
    return a !== null && this.now() - a.setAt >= WEB_ANCHOR_MATURITY_MS
  }

  /**
   * Register (or replace) the anchor from COS Control's bootstrap: the anchor's own signature over
   * its `cos-web-anchor/1` statement. The ROUTE enforces loopback and the token. A replacement
   * revokes every key (their approvals were signed by the old anchor) and bumps the epoch.
   */
  registerAnchor(input: { anchorPub: unknown; statement: unknown; signature: unknown }, by: string): AnchorRegisterResult {
    if (this.unreadable) return { ok: false, reason: 'registry_unreadable' }
    const parsed = parseP256Spki(input.anchorPub)
    if (!parsed) return { ok: false, reason: 'invalid_key' }
    const bytes = fromB64url(input.statement)
    if (!bytes || bytes.length > 1024) return { ok: false, reason: 'statement_invalid' }
    const stmt = parseAnchorStatement(bytes)
    if (stmt === null) return { ok: false, reason: 'statement_invalid' }
    if (stmt === 'not_canonical') return { ok: false, reason: 'statement_not_canonical' }
    const spkiSha256 = sha256Hex(parsed.der)
    const fingerprint = fingerprintOfSpki(parsed.der)
    if (stmt.spkiSha256 !== spkiSha256 || stmt.fingerprint !== fingerprint) return { ok: false, reason: 'statement_mismatch' }
    if (Math.abs(this.now() - stmt.createdAt) > WEB_ANCHOR_STATEMENT_SKEW_MS) return { ok: false, reason: 'statement_stale' }
    if (!verifyP1363(parsed.key, bytes, input.signature)) return { ok: false, reason: 'anchor_signature_invalid' }
    const before = JSON.stringify(this.data)
    const previous = this.data.anchorPub
    const replaced = previous !== null && previous !== b64url(parsed.der)
    const setAt = this.now()
    this.data.anchorPub = b64url(parsed.der)
    this.data.anchorRegistration = { statement: input.statement as string, signature: input.signature as string, setAt }
    if (replaced) {
      for (const e of this.data.entries) if (typeof e.revokedAt !== 'number') { e.revokedAt = setAt; e.revokeReason = 'anchor_replaced'; e.revokedBy = by }
      this.data.epoch += 1
    }
    if (!this.persist()) { this.data = JSON.parse(before) as RegistryFile; return { ok: false, reason: 'registry_write_failed' } }
    this.audit('anchor_registered', { spkiSha256, fingerprint, setAt, replaced, by, epoch: this.data.epoch })
    return { ok: true, spkiSha256, fingerprint, setAt, replaced }
  }

  /** The revoked keys, sorted by kid (review W5: the verifier compares with a Control-held list). */
  revocations(): Array<{ kid: string; revokedAt: number }> {
    return this.data.entries.filter(e => typeof e.revokedAt === 'number')
      .map(e => ({ kid: e.kid, revokedAt: e.revokedAt as number }))
      .sort((a, b) => (a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0))
  }

  /** sha256 hex of the JCS of `revocations()`. */
  revocationDigest(): string {
    return sha256Hex(canonicalJson(this.revocations()))
  }

  aud(selfDnsName: string | null): string | null {
    const anchor = this.anchor()
    if (!anchor || typeof selfDnsName !== 'string' || selfDnsName.trim() === '') return null
    return audOf(anchor.der, selfDnsName)
  }

  epoch(): number { return this.data.epoch }

  /** Whether this entry's anchorSig verifies over its own approval, and the approval names this key and its passkey. */
  private anchored(entry: WebKeyEntry, aud: string | null): { key: KeyObject; passkeyKey: KeyObject } | null {
    const anchor = this.anchor()
    if (!anchor || aud === null) return null
    const parsed = parseP256Spki(entry.spki)
    const passkey = parseP256Spki(entry.passkeySpki)
    if (!parsed || !passkey) return null
    const a = entry.approval
    if (!a || a.v !== WEB_ENROLL_APPROVE_VERSION || a.kid !== entry.kid || a.kid !== kidOfSpki(parsed.der)) return null
    if (a.spki !== entry.spki || a.spki_sha256 !== sha256Hex(parsed.der) || a.aud !== aud || a.kver !== entry.kver) return null
    if (typeof a.passkey_credential_id !== 'string' || a.passkey_credential_id.length === 0 || a.passkey_spki_sha256 !== sha256Hex(passkey.der)) return null
    const bytes = canonicalBytes(a)
    if (!bytes || !verifyP1363(anchor.key, bytes, entry.anchorSig)) return null
    return { key: parsed.key, passkeyKey: passkey.key }
  }

  entryState(kid: string, selfDnsName: string | null): EntryState {
    if (this.unreadable) return { ok: false, reason: 'key_unknown' }
    const entry = this.data.entries.find(e => e.kid === kid)
    if (!entry) return { ok: false, reason: 'key_unknown' }
    if (typeof entry.revokedAt === 'number') return { ok: false, reason: 'key_revoked' }
    const keys = this.anchored(entry, this.aud(selfDnsName))
    if (!keys) return { ok: false, reason: 'key_unanchored' }
    // Review W5: an approval from another epoch never counts (a revoke-all bumps the epoch, so a
    // file restored with an old key and the current epoch still refuses it).
    if (entry.approval.epoch !== this.data.epoch) return { ok: false, reason: 'key_epoch_stale' }
    return { ok: true, entry, ...keys }
  }

  activeCount(selfDnsName: string | null): number {
    return this.data.entries.filter(e => this.entryState(e.kid, selfDnsName).ok).length
  }

  /** Every entry as Control and the phone list it. Never the anchorSig's secret (there is none), never more than this. */
  list(selfDnsName: string | null): Array<Record<string, unknown>> {
    return this.data.entries.map((e) => {
      const der = fromB64url(e.spki)
      const state = this.entryState(e.kid, selfDnsName)
      return {
        kid: e.kid,
        label: e.label,
        fingerprint: der ? fingerprintOfSpki(der) : null,
        enrolledAt: e.enrolledAt,
        kver: e.kver,
        lastUsedAt: e.lastUsedAt ?? null,
        active: state.ok,
        state: state.ok ? 'active' : state.reason,
        ...(typeof e.revokedAt === 'number' ? { revokedAt: e.revokedAt, revokeReason: e.revokeReason ?? null } : {}),
      }
    })
  }

  /** The stored entry (for the turn answer and the verifier): the approval and anchorSig are self-proving. */
  entry(kid: string): WebKeyEntry | null {
    return this.data.entries.find(e => e.kid === kid) ?? null
  }

  private persist(): boolean {
    if (this.unreadable) return false
    try {
      durableAtomicWriteFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`)
      return true
    } catch (error) {
      console.error(`[web-key] registry write failed: ${error instanceof Error ? error.message : error}`)
      return false
    }
  }

  audit(event: string, fields: Record<string, unknown> = {}): void {
    try {
      appendFileSync(this.auditFile, `${JSON.stringify({ at: new Date(this.now()).toISOString(), event, ...fields })}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      console.error(`[web-key] audit append failed: ${error instanceof Error ? error.message : error}`)
    }
  }

  /** Add an approved entry. False (nothing changed) when the registry cannot be written. */
  addEntry(entry: WebKeyEntry): boolean {
    if (this.unreadable || this.data.entries.some(e => e.kid === entry.kid)) return false
    this.data.entries.push(entry)
    if (!this.persist()) { this.data.entries.pop(); return false }
    return true
  }

  /** Revoke one key. No anchor needed. Idempotent; false for an unknown kid. */
  revoke(kid: string, reason: string, by: string): boolean {
    const entry = this.data.entries.find(e => e.kid === kid)
    if (!entry) return false
    if (typeof entry.revokedAt !== 'number') {
      entry.revokedAt = this.now()
      entry.revokeReason = reason.slice(0, 64)
      entry.revokedBy = by
      // Revoked in memory even when the write fails: it holds for this process, and the next write carries it.
      this.persist()
    }
    this.audit('revoke', { kid, reason: entry.revokeReason, by })
    return true
  }

  /** Revoke every key and bump the epoch, which voids every outstanding envelope. No anchor needed. */
  revokeAll(by: string): number {
    const at = this.now()
    for (const e of this.data.entries) {
      if (typeof e.revokedAt !== 'number') { e.revokedAt = at; e.revokeReason = 'revoke_all'; e.revokedBy = by }
    }
    this.data.epoch += 1
    this.persist()
    this.audit('revoke_all', { epoch: this.data.epoch, by })
    return this.data.epoch
  }

  noteUsed(kid: string): void {
    const entry = this.data.entries.find(e => e.kid === kid)
    if (entry) { entry.lastUsedAt = this.now(); this.persist() }
  }
}

// ---------------------------------------------------------------------------------------------
// Enrollment ceremony (plan §4.3). One pending request at a time, held in memory only.
// ---------------------------------------------------------------------------------------------

interface PendingEnrollment {
  enrollId: string
  challenge: Buffer
  spkiB64: string
  spkiDer: Buffer
  kid: string
  label: string
  userAgent: string
  remote: string
  startedAt: number
  exp: number
  attempts: number
  aud: string
  origin: string
  rpId: string
  epoch: number
  rotates: string | null
  /** sha256(r) the phone committed to BEFORE the challenge was picked (review W3). */
  sasCommit: string
  proven: { sas: string; approval: WebKeyApproval; passkeySpki: string } | null
}

export type EnrollStartResult =
  | { ok: true; enrollId: string; challenge: string; aud: string; origin: string; rpId: string; kid: string; exp: number }
  | { ok: false; reason: 'anchor_not_registered' | 'anchor_unregistered' | 'aud_unavailable' | 'origin_unavailable' | 'registry_unreadable' | 'invalid_key' | 'invalid_label' | 'invalid_commit' | 'device_not_allowed' | 'enrollment_pending' | 'key_cap_reached' | 'key_already_enrolled' | 'rotate_unknown_key' }

export type EnrollProveResult =
  | { ok: true; sas: string; fingerprint: string }
  | { ok: false; reason: 'enroll_unknown' | 'already_proven' | 'proof_invalid' | 'enroll_burned' | 'commit_mismatch' | 'passkey_malformed' | 'passkey_invalid' }

export interface WebKeyEnrollmentOptions {
  now?: () => number
  random?: (n: number) => Buffer
  /** The device allowlist (review W6). Absent: every start is refused. */
  deviceAllowed?: (remote: string) => boolean
}

export class WebKeyEnrollments {
  private pending: PendingEnrollment | null = null
  private readonly outcomes = new Map<string, 'enrolled' | 'expired' | 'burned' | 'refused'>()
  private readonly now: () => number
  private readonly random: (n: number) => Buffer
  private readonly deviceAllowed: (remote: string) => boolean

  constructor(private readonly registry: WebKeyRegistry, opts: WebKeyEnrollmentOptions = {}) {
    this.now = opts.now ?? Date.now
    this.random = opts.random ?? randomBytes
    this.deviceAllowed = opts.deviceAllowed ?? (() => false)
  }

  private settle(outcome: 'enrolled' | 'expired' | 'burned' | 'refused'): void {
    if (!this.pending) return
    this.outcomes.set(this.pending.enrollId, outcome)
    while (this.outcomes.size > 32) this.outcomes.delete(this.outcomes.keys().next().value as string)
    this.pending = null
  }

  /** The pending request, or null; an expired one is settled here. */
  private live(): PendingEnrollment | null {
    if (this.pending && this.now() > this.pending.exp) {
      this.registry.audit('enroll_expired', { enrollId: this.pending.enrollId, kid: this.pending.kid })
      this.settle('expired')
    }
    return this.pending
  }

  start(input: { spki: unknown; label: unknown; userAgent: string; remote: string; rotates?: unknown; sasCommit?: unknown }, ctx: { selfDnsName: string | null; origin: string | null }): EnrollStartResult {
    if (this.registry.unreadable) return { ok: false, reason: 'registry_unreadable' }
    const refusal = this.registry.anchorRefusal()
    if (refusal) return { ok: false, reason: refusal }
    const aud = this.registry.aud(ctx.selfDnsName)
    if (!aud || !ctx.selfDnsName) return { ok: false, reason: 'aud_unavailable' }
    if (!ctx.origin) return { ok: false, reason: 'origin_unavailable' }
    const remote = normalizeRemote(input.remote)
    // Review W6: only a device on the allowlist may start (the default, empty, refuses everyone).
    if (!this.deviceAllowed(remote)) {
      this.registry.audit('enroll_refused_device', { remote })
      return { ok: false, reason: 'device_not_allowed' }
    }
    const parsed = parseP256Spki(input.spki)
    if (!parsed) return { ok: false, reason: 'invalid_key' }
    const label = typeof input.label === 'string' ? input.label.trim() : ''
    if (label.length === 0 || label.length > LABEL_MAX || /[\u0000-\u001f\u007f]/.test(label)) return { ok: false, reason: 'invalid_label' }
    if (typeof input.sasCommit !== 'string' || !/^[0-9a-f]{64}$/.test(input.sasCommit)) return { ok: false, reason: 'invalid_commit' }
    // One pending request at a time: a new start while one is pending is refused, never replaces it.
    if (this.live()) return { ok: false, reason: 'enrollment_pending' }
    const kid = kidOfSpki(parsed.der)
    // An existing key is never replaced (a revoked one is not re-admitted under its old kid either).
    if (this.registry.entry(kid)) return { ok: false, reason: 'key_already_enrolled' }
    let rotates: string | null = null
    if (input.rotates !== undefined && input.rotates !== null) {
      if (typeof input.rotates !== 'string' || !this.registry.entryState(input.rotates, ctx.selfDnsName).ok) return { ok: false, reason: 'rotate_unknown_key' }
      rotates = input.rotates
    }
    // A rotation replaces one active key, so it may start at the cap.
    if (rotates === null && this.registry.activeCount(ctx.selfDnsName) >= WEB_KEY_MAX_ACTIVE) return { ok: false, reason: 'key_cap_reached' }
    const at = this.now()
    this.pending = {
      enrollId: b64url(this.random(16)),
      // Picked AFTER the phone committed to sha256(r): the server cannot steer the SAS (W3).
      challenge: this.random(32),
      spkiB64: b64url(parsed.der),
      spkiDer: parsed.der,
      kid,
      label,
      userAgent: input.userAgent.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200),
      remote,
      startedAt: at,
      exp: at + WEB_ENROLL_TTL_MS,
      attempts: 0,
      aud,
      origin: ctx.origin,
      rpId: ctx.selfDnsName,
      epoch: this.registry.epoch(),
      rotates,
      sasCommit: input.sasCommit,
      proven: null,
    }
    this.registry.audit('enroll_start', { enrollId: this.pending.enrollId, kid, label, remote, rotates })
    return { ok: true, enrollId: this.pending.enrollId, challenge: b64url(this.pending.challenge), aud, origin: ctx.origin, rpId: ctx.selfDnsName, kid, exp: this.pending.exp }
  }

  /** The exact object the phone key signs to prove possession, binding its passkey and its SAS nonce. */
  static proofMessage(p: { enrollId: string; challenge: string; aud: string; origin: string; kid: string; phoneNonce: string; passkeyCredentialId: string; passkeySpkiSha256: string }): Record<string, unknown> {
    return {
      v: WEB_ENROLL_PROOF_VERSION, enrollId: p.enrollId, challenge: p.challenge, aud: p.aud, origin: p.origin, kid: p.kid,
      phoneNonce: p.phoneNonce, passkey_credential_id: p.passkeyCredentialId, passkey_spki_sha256: p.passkeySpkiSha256,
    }
  }

  private failProof(p: PendingEnrollment, reason: 'proof_invalid' | 'commit_mismatch' | 'passkey_malformed' | 'passkey_invalid'): EnrollProveResult {
    p.attempts += 1
    this.registry.audit('enroll_proof_failed', { enrollId: p.enrollId, kid: p.kid, attempts: p.attempts, reason })
    if (p.attempts >= WEB_ENROLL_MAX_PROOF_ATTEMPTS) {
      this.registry.audit('enroll_burned', { enrollId: p.enrollId, kid: p.kid })
      this.settle('burned')
      return { ok: false, reason: 'enroll_burned' }
    }
    return { ok: false, reason }
  }

  /**
   * Proof of possession: the phone key's signature, the SAS nonce revealed against its commitment
   * (W3), and a user-verified passkey assertion over the proof bytes, whose credential id and key
   * hash go into the anchor-signed approval (B2).
   */
  prove(input: { enrollId: unknown; signature: unknown; phoneNonce?: unknown; passkey?: unknown }): EnrollProveResult {
    const p = this.live()
    if (!p || p.enrollId !== input.enrollId) return { ok: false, reason: 'enroll_unknown' }
    if (p.proven) return { ok: false, reason: 'already_proven' }
    const r = fromB64url(input.phoneNonce)
    if (!r || r.length !== 32 || sha256Hex(r) !== p.sasCommit) return this.failProof(p, 'commit_mismatch')
    const pk = input.passkey && typeof input.passkey === 'object' ? input.passkey as Record<string, unknown> : null
    const passkeyDer = pk ? coseP256ToSpki(pk.publicKey) : null
    const assertion = pk ? parsePasskeyAssertion(pk.assertion) : null
    const credentialId = pk && typeof pk.credentialId === 'string' && fromB64url(pk.credentialId) && pk.credentialId.length <= 1024 ? pk.credentialId : null
    if (!passkeyDer || !assertion || !credentialId) return this.failProof(p, 'passkey_malformed')
    const passkeySpkiSha256 = sha256Hex(passkeyDer)
    const parsed = parseP256Spki(p.spkiB64)
    const msg = canonicalBytes(WebKeyEnrollments.proofMessage({
      enrollId: p.enrollId, challenge: b64url(p.challenge), aud: p.aud, origin: p.origin, kid: p.kid,
      phoneNonce: b64url(r), passkeyCredentialId: credentialId, passkeySpkiSha256,
    }))
    if (!parsed || !msg || !verifyP1363(parsed.key, msg, input.signature)) return this.failProof(p, 'proof_invalid')
    const passkeyKey = parseP256Spki(b64url(passkeyDer))
    const verdict = passkeyKey ? verifyPasskeyAssertion(assertion, {
      challenge: createHash('sha256').update(msg).digest(), origin: p.origin, rpId: p.rpId, credentialId, publicKey: passkeyKey.key,
    }) : { ok: false as const }
    if (!verdict.ok) return this.failProof(p, 'passkey_invalid')
    const sas = sasOf(p.challenge, p.spkiDer, r)
    p.proven = {
      sas,
      passkeySpki: b64url(passkeyDer),
      approval: {
        v: WEB_ENROLL_APPROVE_VERSION,
        enrollId: p.enrollId,
        kid: p.kid,
        spki: p.spkiB64,
        spki_sha256: sha256Hex(p.spkiDer),
        fingerprint: fingerprintOfSpki(p.spkiDer),
        label: p.label,
        userAgent: p.userAgent,
        remote: p.remote,
        challenge: b64url(p.challenge),
        sasCommit: p.sasCommit,
        phoneNonce: b64url(r),
        sas,
        aud: p.aud,
        origin: p.origin,
        kver: 1,
        epoch: p.epoch,
        rotates: p.rotates,
        passkey_credential_id: credentialId,
        passkey_spki_sha256: passkeySpkiSha256,
        enrolledAt: this.now(),
        exp: p.exp,
      },
    }
    this.registry.audit('enroll_proven', { enrollId: p.enrollId, kid: p.kid })
    return { ok: true, sas, fingerprint: fingerprintOfSpki(p.spkiDer) }
  }

  /**
   * What COS Control signs, and nothing displayable outside it (review W4): Control decodes
   * `approvalJcs` and shows the SAS, fingerprint, label and device from those bytes only.
   */
  pendingView(): Record<string, unknown> | null {
    const p = this.live()
    if (!p || !p.proven) return null
    const approvalBytes = canonicalBytes(p.proven.approval)
    if (!approvalBytes) return null
    return {
      enrollId: p.enrollId,
      startedAt: p.startedAt,
      exp: p.exp,
      approval: JSON.parse(approvalBytes.toString('utf8')) as Record<string, unknown>,
      /** base64url of the exact JCS bytes the anchor must sign. */
      approvalJcs: b64url(approvalBytes),
    }
  }

  /** Control posts the anchor's signature over the frozen approval. Token alone is never enough. */
  approve(enrollId: unknown, anchorSig: unknown, selfDnsName: string | null): { ok: true; kid: string } | { ok: false; reason: 'enroll_unknown' | 'not_proven' | 'anchor_not_registered' | 'anchor_unregistered' | 'anchor_signature_invalid' | 'epoch_changed' | 'key_cap_reached' | 'registry_write_failed' | 'aud_changed' } {
    const p = this.live()
    if (!p || p.enrollId !== enrollId) return { ok: false, reason: 'enroll_unknown' }
    if (!p.proven) return { ok: false, reason: 'not_proven' }
    const anchor = this.registry.anchor()
    if (!anchor) return { ok: false, reason: this.registry.anchorRefusal() ?? 'anchor_not_registered' }
    const bytes = canonicalBytes(p.proven.approval)
    if (!bytes || !verifyP1363(anchor.key, bytes, anchorSig)) {
      this.registry.audit('enroll_approve_refused', { enrollId: p.enrollId, kid: p.kid, reason: 'anchor_signature_invalid' })
      return { ok: false, reason: 'anchor_signature_invalid' }
    }
    if (this.registry.aud(selfDnsName) !== p.aud) return { ok: false, reason: 'aud_changed' }
    if (this.registry.epoch() !== p.epoch) { this.settle('refused'); return { ok: false, reason: 'epoch_changed' } }
    if (p.rotates === null && this.registry.activeCount(selfDnsName) >= WEB_KEY_MAX_ACTIVE) return { ok: false, reason: 'key_cap_reached' }
    const entry: WebKeyEntry = {
      kid: p.kid,
      spki: p.spkiB64,
      label: p.label,
      enrolledAt: p.proven.approval.enrolledAt,
      kver: 1,
      passkeySpki: p.proven.passkeySpki,
      approval: p.proven.approval,
      anchorSig: String(anchorSig),
    }
    if (!this.registry.addEntry(entry)) return { ok: false, reason: 'registry_write_failed' }
    this.registry.audit('enroll_approved', { enrollId: p.enrollId, kid: p.kid, rotates: p.proven.approval.rotates })
    // Review W8: the key revoked is the one the ANCHOR signed in `rotates`, never a server-side field.
    const rotated = p.proven.approval.rotates
    this.settle('enrolled')
    if (rotated) this.registry.revoke(rotated, 'rotated', `rotation:${entry.kid}`)
    return { ok: true, kid: entry.kid }
  }

  status(enrollId: unknown): string {
    const p = this.live()
    if (p && p.enrollId === enrollId) return p.proven ? 'proven' : 'started'
    return (typeof enrollId === 'string' && this.outcomes.get(enrollId)) || 'unknown'
  }
}

// ---------------------------------------------------------------------------------------------
// Server nonces and the spend store (plan §4.5): durable, atomic, one winner.
// ---------------------------------------------------------------------------------------------

interface NonceRow { exp: number; spentAt?: number; authId?: string }
interface ConsumedRow { at: number; session: string; provider: string }
interface NonceFile { v: 1; nonces: Record<string, NonceRow>; consumed: Record<string, ConsumedRow> }

export type NonceConsume = 'ok' | 'nonce_unknown' | 'nonce_spent' | 'nonce_expired' | 'nonce_store_unavailable'

export class WebKeyNonces {
  private data: NonceFile = { v: 1, nonces: {}, consumed: {} }
  /** The store could not be read: nothing is issued or accepted (fail closed on replay storage). */
  readonly unavailable: boolean

  constructor(private readonly file: string, private readonly now: () => number = Date.now, private readonly random: (n: number) => Buffer = randomBytes) {
    let unavailable = false
    let raw: string | null = null
    try { raw = readFileSync(file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') unavailable = true
    }
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Partial<NonceFile>
        if (parsed && parsed.v === 1 && parsed.nonces && typeof parsed.nonces === 'object' && parsed.consumed && typeof parsed.consumed === 'object') {
          this.data = { v: 1, nonces: { ...parsed.nonces }, consumed: { ...parsed.consumed } }
        } else unavailable = true
      } catch { unavailable = true }
    }
    this.unavailable = unavailable
    if (unavailable) console.error(`[web-key] nonce store ${file} is unreadable: signed turns are refused until it is repaired`)
  }

  private prune(at: number): void {
    // A spent nonce is kept an hour past its expiry; acceptance needs an issued, unspent row anyway.
    for (const [n, row] of Object.entries(this.data.nonces)) if (at > row.exp + 3_600_000) delete this.data.nonces[n]
    for (const [id, row] of Object.entries(this.data.consumed)) if (at - row.at > WEB_CONSUMED_KEEP_MS) delete this.data.consumed[id]
  }

  private persist(): boolean {
    try {
      durableAtomicWriteFileSync(this.file, `${JSON.stringify(this.data)}\n`)
      return true
    } catch (error) {
      console.error(`[web-key] nonce store write failed: ${error instanceof Error ? error.message : error}`)
      return false
    }
  }

  issue(): { ok: true; nonce: string; exp: number } | { ok: false; reason: 'nonce_store_unavailable' | 'nonce_cap_reached' } {
    if (this.unavailable) return { ok: false, reason: 'nonce_store_unavailable' }
    const at = this.now()
    this.prune(at)
    const outstanding = Object.values(this.data.nonces).filter(r => r.spentAt === undefined && r.exp >= at).length
    if (outstanding >= WEB_NONCE_MAX_OUTSTANDING) return { ok: false, reason: 'nonce_cap_reached' }
    const nonce = b64url(this.random(16))
    this.data.nonces[nonce] = { exp: at + WEB_NONCE_TTL_MS }
    if (!this.persist()) { delete this.data.nonces[nonce]; return { ok: false, reason: 'nonce_store_unavailable' } }
    return { ok: true, nonce, exp: at + WEB_NONCE_TTL_MS }
  }

  /**
   * Spend a nonce for one authorization. Synchronous from check to set (one winner). A nonce is
   * spent in memory before the write; a failed write still refuses the turn, so a restart can never
   * find an unspent row for an authorization this process accepted.
   */
  consume(nonce: string, authId: string): NonceConsume {
    if (this.unavailable) return 'nonce_store_unavailable'
    const row = this.data.nonces[nonce]
    if (!row) return 'nonce_unknown'
    if (row.spentAt !== undefined) return 'nonce_spent'
    if (this.now() > row.exp) return 'nonce_expired'
    row.spentAt = this.now()
    row.authId = authId
    return this.persist() ? 'ok' : 'nonce_store_unavailable'
  }

  /**
   * The consume endpoint (plan §4.5, review B3): one server-enforced winner per authorization. Every
   * key (`turn:<turnId>` and `web:<aud>:<authId>`) is checked and set in ONE write, so the G2 turn
   * namespace and the web authorization namespace cannot be spent apart.
   */
  spend(keys: readonly string[], session: string, provider: string): { ok: true } | { ok: false; reason: 'already_consumed' | 'nonce_store_unavailable' | 'invalid_keys' } {
    if (this.unavailable) return { ok: false, reason: 'nonce_store_unavailable' }
    if (keys.length === 0 || keys.some(k => typeof k !== 'string' || k.length === 0)) return { ok: false, reason: 'invalid_keys' }
    if (keys.some(k => this.data.consumed[k])) return { ok: false, reason: 'already_consumed' }
    const at = this.now()
    this.prune(at)
    for (const k of keys) this.data.consumed[k] = { at, session, provider }
    if (!this.persist()) { for (const k of keys) delete this.data.consumed[k]; return { ok: false, reason: 'nonce_store_unavailable' } }
    return { ok: true }
  }
}

// ---------------------------------------------------------------------------------------------
// Approval packets (plan §4.4 `approve`). A packet is only a REQUEST: a token holder may post one.
// It authorizes nothing until the phone signs an envelope whose scope names it byte for byte.
// ---------------------------------------------------------------------------------------------

export class WebKeyPackets {
  private readonly open = new Map<string, WebApprovalPacket>()

  constructor(private readonly now: () => number = Date.now, private readonly random: (n: number) => Buffer = randomBytes) {}

  private prune(): void {
    const at = this.now()
    for (const [sha, p] of this.open) if (at > p.exp) this.open.delete(sha)
  }

  /**
   * `creator` is the session that asked, taken from the authenticated request context (the route's
   * headers), never from body text (review B4). An approve envelope is accepted only for the
   * session that created its packet.
   */
  create(input: Record<string, unknown>, creator: { provider: unknown; sessionId: unknown } | null): { ok: true; packet: WebApprovalPacket; packetSha256: string } | { ok: false; reason: 'action_not_allowed' | 'invalid_packet' | 'packet_cap_reached' | 'session_from_context_only' | 'creator_unknown' } {
    // The closed action list: install, publish, push-main. Every never-list action is refused here.
    if (typeof input.action !== 'string' || !APPROVE_ACTIONS.has(input.action)) return { ok: false, reason: 'action_not_allowed' }
    if ('provider' in input || 'sessionId' in input) return { ok: false, reason: 'session_from_context_only' }
    // Strict patterns plus the action-to-channel table (shared/web-turn-envelope.ts).
    if (!approveFieldsValid(input.action, input.artifact, input.version, input.digest, input.channel)) return { ok: false, reason: 'invalid_packet' }
    const provider = creator?.provider
    const sessionId = creator?.sessionId
    if (typeof provider !== 'string' || !['claude', 'codex', 'cursor'].includes(provider)
      || typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128 || /[\u0000-\u001f\u007f]/.test(sessionId)) return { ok: false, reason: 'creator_unknown' }
    this.prune()
    if (this.open.size >= WEB_PACKET_MAX_OPEN) return { ok: false, reason: 'packet_cap_reached' }
    const at = this.now()
    const packet: WebApprovalPacket = {
      v: WEB_APPROVAL_PACKET_VERSION,
      packetId: b64url(this.random(12)),
      action: input.action as WebApprovalPacket['action'],
      artifact: input.artifact as string,
      version: input.version as string,
      digest: input.digest as string,
      channel: input.channel as string,
      provider,
      sessionId,
      createdAt: at,
      exp: at + WEB_PACKET_TTL_MS,
    }
    const bytes = canonicalBytes(packet)
    if (!bytes) return { ok: false, reason: 'invalid_packet' }
    const packetSha256 = sha256Hex(bytes)
    this.open.set(packetSha256, packet)
    return { ok: true, packet, packetSha256 }
  }

  get(packetSha256: string): WebApprovalPacket | null {
    this.prune()
    return this.open.get(packetSha256) ?? null
  }

  close(packetSha256: string): void { this.open.delete(packetSha256) }

  list(): Array<{ packetSha256: string; packet: WebApprovalPacket }> {
    this.prune()
    return [...this.open.entries()].map(([packetSha256, packet]) => ({ packetSha256, packet }))
  }
}
