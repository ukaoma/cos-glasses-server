// The signed Control Web turn envelope, `cos-web-turn/1` (6.99.31, plan §4.4). PURE: no I/O, no
// crypto, no imports, so the phone signer, the server and the tests share one definition, and
// the Python verifier (MU-Chief-Staff operations/scripts/verify_g2_turn.py) mirrors it with golden
// fixtures.
//
// CANONICAL BYTES. The phone signs the RFC 8785 (JCS) encoding of the envelope: object keys
// sorted by UTF-16 code units, no whitespace, strings escaped as ES JSON.stringify escapes them,
// numbers as ES Number-to-string. Every number this protocol uses is a safe integer, so the
// Python mirror (json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)) agrees
// byte for byte. The server refuses an envelope whose bytes are not already canonical: one
// message has exactly one signable form.
//
// CLOSED SHAPES. Every object here has an exact key set. An unknown key, an unknown `v`, an
// unknown scope kind or an approve action outside APPROVE_ACTIONS is refused, never ignored. The
// `approve` grammar has no spelling for the never-list (credentials, money, deleting data, sending
// messages, security or permission settings, the harness's permission prompts), and its free
// fields have strict patterns plus an action-to-channel table (review B4).
//
// `message` scope is CONVERSATION ONLY (MESSAGE_SCOPE_MEANING). Its words are free text, so a
// message can SAY "send the email"; that is not authority. Enforcement of what a message may
// cause is the receiving agent's policy, read from the verifier's `notAuthorized` list, exactly as
// for G2. The contract is docs/web-key-verifier-contract.md.

export const WEB_TURN_ENVELOPE_VERSION = 'cos-web-turn/1'
export const WEB_ENROLL_PROOF_VERSION = 'cos-web-enroll/2'
export const WEB_ENROLL_APPROVE_VERSION = 'cos-web-enroll-approve/2'
export const WEB_APPROVAL_PACKET_VERSION = 'cos-web-packet/1'
/** Approval packet timestamps are Unix milliseconds; a packet lives at most 30 minutes. */
export const WEB_APPROVAL_PACKET_MAX_LIFETIME_MS = 30 * 60_000
/** Canonical base64url encoding of the server's 12 random packet-id bytes. */
export const WEB_APPROVAL_PACKET_ID_RE = /^[A-Za-z0-9_-]{16}$/
export const WEB_PASSKEY_ASSERTION_VERSION = 'cos-web-passkey/1'
export const WEB_ANCHOR_STATEMENT_VERSION = 'cos-web-anchor/1'

/** The longest an envelope may live (exp - iat), in seconds. */
export const WEB_TURN_MAX_LIFETIME_S = 15 * 60
/** How far in the future `iat` may sit (clock skew between the phone and this Mac), in seconds. */
export const WEB_TURN_IAT_SKEW_S = 60

/** The only actions an `approve` scope can name. Anything else, including every never-list item, is unexpressible. */
export const APPROVE_ACTIONS: ReadonlySet<string> = new Set(['install', 'publish', 'push-main'])

/** What a `message` scope means: conversation only (review B4). */
export const MESSAGE_SCOPE_MEANING = 'conversation'

/** Never authorized by a web turn, whatever its scope or words (CLAUDE.md G2 Authority never-list). */
export const WEB_KEY_NEVER_AUTHORIZED: readonly string[] = Object.freeze([
  'credentials', 'payment-details', 'moving-money', 'deleting-data', 'sending-messages',
  'security-or-permission-settings', 'harness-permission-prompts', 'authority-rule-changes',
])

/** What `message` scope never authorizes on top of the never-list: it is conversation only. */
export const MESSAGE_SCOPE_NOT_AUTHORIZED: readonly string[] = Object.freeze([
  'install', 'publish', 'push-main', 'push-branch', 'hub-file',
])

/** The channels each approve action may name. Nothing else is signable (review B4). */
export const APPROVE_ACTION_CHANNELS: Readonly<Record<'install' | 'publish' | 'push-main', readonly string[]>> = Object.freeze({
  install: Object.freeze(['mac-local']),
  publish: Object.freeze(['npm-next', 'npm-latest', 'control-appcast', 'hub-alias', 'gotcos-site', 'control-downloads', 'release-docs']),
  'push-main': Object.freeze(['git-main']),
})

export const APPROVE_ARTIFACT_RE = /^[a-z0-9@][a-z0-9@._/-]{0,127}$/
export const APPROVE_VERSION_RE = /^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,32})?$/
/** sha256:<hex64>, sha512:<hex128>, or an npm SRI sha512-<base64>. Nothing else. */
export const APPROVE_DIGEST_RE = /^(sha256:[0-9a-f]{64}|sha512:[0-9a-f]{128}|sha512-[A-Za-z0-9+/]{86}==)$/
/** These channels approve one reviewed canonical deployment manifest, never arbitrary URLs. */
export const PUBLISH_MANIFEST_ARTIFACTS: Readonly<Record<string, string>> = Object.freeze({
  'gotcos-site': 'gotcos-site-manifest',
  'control-downloads': 'cos-control-downloads-manifest',
  'release-docs': 'cos-release-docs-manifest',
})

/** Whether the four free approve fields match their patterns and the channel belongs to the action. */
export function approveFieldsValid(action: unknown, artifact: unknown, version: unknown, digest: unknown, channel: unknown): boolean {
  if (typeof action !== 'string' || !APPROVE_ACTIONS.has(action)) return false
  if (typeof artifact !== 'string' || !APPROVE_ARTIFACT_RE.test(artifact)) return false
  if (typeof version !== 'string' || !APPROVE_VERSION_RE.test(version)) return false
  if (typeof digest !== 'string' || !APPROVE_DIGEST_RE.test(digest)) return false
  const channels = APPROVE_ACTION_CHANNELS[action as keyof typeof APPROVE_ACTION_CHANNELS]
  if (typeof channel !== 'string' || !channels.includes(channel)) return false
  if (Object.prototype.hasOwnProperty.call(PUBLISH_MANIFEST_ARTIFACTS, channel)
    && (artifact !== PUBLISH_MANIFEST_ARTIFACTS[channel] || !/^sha256:[0-9a-f]{64}$/.test(digest))) return false
  return true
}

/** The verifier's `notAuthorized` list for a scope: the never-list plus what this scope does not cover. */
export function notAuthorizedFor(scope: WebTurnScope): string[] {
  if (scope.kind === 'message') return [...WEB_KEY_NEVER_AUTHORIZED, ...MESSAGE_SCOPE_NOT_AUTHORIZED]
  const others = [...APPROVE_ACTIONS].filter(a => a !== scope.action)
  return [...WEB_KEY_NEVER_AUTHORIZED, ...others, 'push-branch', 'hub-file', 'other-artifact-version-digest-or-channel']
}

export type WebTurnScope =
  | { kind: 'message' }
  | { kind: 'approve'; action: 'install' | 'publish' | 'push-main'; artifact: string; version: string; digest: string; channel: string; packetSha256: string }

export interface WebTurnAttachment { id: string; sha256: string; bytes: number; name: string }

export interface WebTurnEnvelope {
  v: typeof WEB_TURN_ENVELOPE_VERSION
  aud: string
  origin: string
  kid: string
  kver: number
  epoch: number
  turnId: string
  nonce: string
  iat: number
  exp: number
  provider: string
  sessionId: string
  bindingId: string | null
  fork: boolean
  wordsSha256: string
  wordsLen: number
  attachments: WebTurnAttachment[]
  scope: WebTurnScope
}

export class CanonicalJsonError extends Error {}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true
      i += 1
    } else if (c >= 0xdc00 && c <= 0xdfff) return true
  }
  return false
}

/**
 * RFC 8785 JSON Canonicalization Scheme for the values this protocol carries: plain objects,
 * arrays, strings, safe integers, booleans and null. Anything else throws (a float, NaN, a lone
 * surrogate, undefined, a class instance): the protocol never signs it, so it never encodes it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new CanonicalJsonError('only safe integers are signable')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) throw new CanonicalJsonError('lone surrogate')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => {
      if (hasLoneSurrogate(k)) throw new CanonicalJsonError('lone surrogate in key')
      return `${JSON.stringify(k)}:${canonicalJson(obj[k])}`
    }).join(',')}}`
  }
  throw new CanonicalJsonError(`not signable: ${typeof value}`)
}

/** The exact words as signed: CRLF becomes LF, and nothing else changes (no trim, no collapse). */
export function signedWordsText(words: string): string {
  return words.replace(/\r\n/g, '\n')
}

const HEX64 = /^[0-9a-f]{64}$/
const B64URL = /^[A-Za-z0-9_-]+$/
const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/
const PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'cursor'])
const SHORT = (s: unknown, max: number): s is string => typeof s === 'string' && s.length > 0 && s.length <= max

function exactKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const have = Object.keys(obj)
  return have.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k))
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
}

const nonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

const APPROVE_SCOPE_KEYS = ['kind', 'action', 'artifact', 'version', 'digest', 'channel', 'packetSha256'] as const

/** The closed scope list. Null for anything outside it. */
export function parseWebTurnScope(v: unknown): WebTurnScope | null {
  if (!isPlainObject(v)) return null
  if (v.kind === 'message') return exactKeys(v, ['kind']) ? { kind: 'message' } : null
  if (v.kind === 'approve') {
    if (!exactKeys(v, APPROVE_SCOPE_KEYS)) return null
    // The closed action list, the strict field patterns and the channel table (approveFieldsValid).
    if (!approveFieldsValid(v.action, v.artifact, v.version, v.digest, v.channel)) return null
    if (typeof v.packetSha256 !== 'string' || !HEX64.test(v.packetSha256)) return null
    return { kind: 'approve', action: v.action as 'install' | 'publish' | 'push-main', artifact: v.artifact as string, version: v.version as string, digest: v.digest as string, channel: v.channel as string, packetSha256: v.packetSha256 }
  }
  return null
}

const ENVELOPE_KEYS = ['v', 'aud', 'origin', 'kid', 'kver', 'epoch', 'turnId', 'nonce', 'iat', 'exp', 'provider', 'sessionId', 'bindingId', 'fork', 'wordsSha256', 'wordsLen', 'attachments', 'scope'] as const
const ATTACHMENT_KEYS = ['id', 'sha256', 'bytes', 'name'] as const
export const WEB_TURN_MAX_ATTACHMENTS = 16

/**
 * The envelope's exact shape, or the first reason it is not one. `scope_not_allowed` is kept
 * apart from `envelope_malformed` so the phone can say which.
 */
export function parseWebTurnEnvelope(v: unknown): { ok: true; envelope: WebTurnEnvelope } | { ok: false; reason: 'envelope_malformed' | 'envelope_version_unknown' | 'scope_not_allowed' } {
  if (!isPlainObject(v)) return { ok: false, reason: 'envelope_malformed' }
  if (v.v !== WEB_TURN_ENVELOPE_VERSION) return { ok: false, reason: 'envelope_version_unknown' }
  if (!exactKeys(v, ENVELOPE_KEYS)) return { ok: false, reason: 'envelope_malformed' }
  if (typeof v.aud !== 'string' || !HEX64.test(v.aud)) return { ok: false, reason: 'envelope_malformed' }
  if (!SHORT(v.origin, 256) || !/^https?:\/\/[^/\s]+$/.test(v.origin)) return { ok: false, reason: 'envelope_malformed' }
  if (typeof v.kid !== 'string' || v.kid.length !== 22 || !B64URL.test(v.kid)) return { ok: false, reason: 'envelope_malformed' }
  if (!nonNegInt(v.kver) || v.kver < 1 || !nonNegInt(v.epoch)) return { ok: false, reason: 'envelope_malformed' }
  if (typeof v.turnId !== 'string' || !TURN_ID.test(v.turnId)) return { ok: false, reason: 'envelope_malformed' }
  if (typeof v.nonce !== 'string' || !/^[A-Za-z0-9_-]{22,64}$/.test(v.nonce)) return { ok: false, reason: 'envelope_malformed' }
  if (!nonNegInt(v.iat) || !nonNegInt(v.exp)) return { ok: false, reason: 'envelope_malformed' }
  if (typeof v.provider !== 'string' || !PROVIDERS.has(v.provider)) return { ok: false, reason: 'envelope_malformed' }
  if (!SHORT(v.sessionId, 128)) return { ok: false, reason: 'envelope_malformed' }
  if (v.bindingId !== null && !SHORT(v.bindingId, 128)) return { ok: false, reason: 'envelope_malformed' }
  if (typeof v.fork !== 'boolean') return { ok: false, reason: 'envelope_malformed' }
  if (typeof v.wordsSha256 !== 'string' || !HEX64.test(v.wordsSha256) || !nonNegInt(v.wordsLen)) return { ok: false, reason: 'envelope_malformed' }
  if (!Array.isArray(v.attachments) || v.attachments.length > WEB_TURN_MAX_ATTACHMENTS) return { ok: false, reason: 'envelope_malformed' }
  const attachments: WebTurnAttachment[] = []
  for (const a of v.attachments) {
    if (!isPlainObject(a) || !exactKeys(a, ATTACHMENT_KEYS)) return { ok: false, reason: 'envelope_malformed' }
    if (!SHORT(a.id, 128) || typeof a.sha256 !== 'string' || !HEX64.test(a.sha256) || !nonNegInt(a.bytes) || typeof a.name !== 'string' || a.name.length > 255) {
      return { ok: false, reason: 'envelope_malformed' }
    }
    attachments.push({ id: a.id, sha256: a.sha256, bytes: a.bytes, name: a.name })
  }
  const scope = parseWebTurnScope(v.scope)
  if (scope === null) return { ok: false, reason: 'scope_not_allowed' }
  return {
    ok: true,
    envelope: {
      v: WEB_TURN_ENVELOPE_VERSION, aud: v.aud, origin: v.origin, kid: v.kid, kver: v.kver, epoch: v.epoch,
      turnId: v.turnId, nonce: v.nonce, iat: v.iat, exp: v.exp, provider: v.provider, sessionId: v.sessionId,
      bindingId: v.bindingId as string | null, fork: v.fork, wordsSha256: v.wordsSha256, wordsLen: v.wordsLen,
      attachments, scope,
    },
  }
}

/** An approval packet a receiving session posts for the phone to sign against (plan §4.4 `approve`). */
export interface WebApprovalPacket {
  v: typeof WEB_APPROVAL_PACKET_VERSION
  packetId: string
  action: 'install' | 'publish' | 'push-main'
  artifact: string
  version: string
  digest: string
  channel: string
  provider: string
  sessionId: string
  createdAt: number
  exp: number
}

/** The exact packet preimage, shared with the receiving verifier. No URL or wildcard authority. */
export function parseWebApprovalPacket(value: unknown): WebApprovalPacket | null {
  if (!isPlainObject(value) || !exactKeys(value, ['v', 'packetId', 'action', 'artifact', 'version', 'digest', 'channel', 'provider', 'sessionId', 'createdAt', 'exp'])) return null
  if (value.v !== WEB_APPROVAL_PACKET_VERSION || typeof value.packetId !== 'string' || !WEB_APPROVAL_PACKET_ID_RE.test(value.packetId)) return null
  if (!approveFieldsValid(value.action, value.artifact, value.version, value.digest, value.channel)) return null
  if (typeof value.provider !== 'string' || !PROVIDERS.has(value.provider) || !SHORT(value.sessionId, 128) || /[\u0000-\u001f\u007f]/.test(value.sessionId)) return null
  if (!nonNegInt(value.createdAt) || !nonNegInt(value.exp) || value.exp <= value.createdAt || value.exp - value.createdAt > WEB_APPROVAL_PACKET_MAX_LIFETIME_MS) return null
  return { ...value } as unknown as WebApprovalPacket
}
