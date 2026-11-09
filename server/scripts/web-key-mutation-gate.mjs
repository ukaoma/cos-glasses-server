#!/usr/bin/env node
// 6.99.31 enrolled phone key mutation gate: every guard of the web-key acceptance
// (lib/web-key-authority.ts), the envelope grammar (shared/web-turn-envelope.ts), the crypto
// helpers (lib/web-key-envelope.ts), the registry and ceremony (lib/web-key-registry.ts), the
// provenance hook (lib/g2-turn-provenance.ts), the turn routes that call it, the web-key and
// g2-turns routers, and served-asset integrity (lib/web-control-integrity.ts, lib/web-control-static.ts).
// Mutations run only in a disposable copy of the checkout; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated (a gate over a red suite reads every mutant as killed).
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/web-key-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const AUTHT = ['server/lib/web-key-authority.test.ts']
const REGT = ['server/lib/web-key-registry.test.ts']
const INTT = ['server/routes/turn-provenance-web-key.test.ts']
const WEBT = ['server/routes/turn-provenance-web.test.ts']
const INTEGT = ['server/lib/web-control-integrity.test.ts']
const STATICT = ['server/lib/web-control-static.test.ts']
const ORIGT = ['server/lib/web-key-origin.test.ts']
const PACKETT = ['shared/web-approval-packets.test.ts']
const ALL = [...PACKETT, ...AUTHT, ...REGT, ...INTT, ...WEBT, ...INTEGT, ...STATICT, ...ORIGT]
const AUTH = 'server/lib/web-key-authority.ts', REG = 'server/lib/web-key-registry.ts', ENV = 'server/lib/web-key-envelope.ts'
const SH = 'shared/web-turn-envelope.ts', PROV = 'server/lib/g2-turn-provenance.ts'
const BIND = 'server/routes/agent-session-bindings.ts', TQR = 'server/routes/thread-turn-queue.ts'
const WKR = 'server/routes/web-key.ts', G2R = 'server/routes/g2-turns.ts'
const INTEG = 'server/lib/web-control-integrity.ts', STATIC = 'server/lib/web-control-static.ts'
const PK = 'server/lib/web-key-passkey.ts', ORIG = 'server/lib/web-key-origin.ts', LIS = 'server/lib/listener-startup.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })
const drop = (name, file, line, tests) => m(name, file, [line, ''], tests)

const mutations = [
  // The manifest channels must not become interchangeable or permit a non-SHA256 digest.
  m('packet-manifest-boundaries', SH, ["  if (Object.prototype.hasOwnProperty.call(PUBLISH_MANIFEST_ARTIFACTS, channel)\n    && (artifact !== PUBLISH_MANIFEST_ARTIFACTS[channel] || !/^sha256:[0-9a-f]{64}$/.test(digest))) return false\n", ''], PACKETT),
  // ── Acceptance (lib/web-key-authority.ts) ──
  m('flag-default-off', AUTH, ['  return readSwitch(env.COS_WEB_KEY_AUTHORITY, false)', '  return readSwitch(env.COS_WEB_KEY_AUTHORITY, true)'], INTT),
  drop('accept-flag-off', AUTH, "    if (!this.enabled()) return { ok: false, reason: 'web_key_authority_off' }\n    if (!candidate.signature)", AUTHT),
  m('accept-signature-missing', AUTH, ["    if (!candidate.signature) return { ok: false, reason: 'signature_missing' }\n", ''], AUTHT),
  m('accept-parse', AUTH, ['    if (!parsed.ok) return { ok: false, reason: parsed.reason }\n    const env', '    const env'], AUTHT),
  m('accept-anchor', AUTH, ['    if (anchorRefusal) return { ok: false, reason: anchorRefusal }\n', ''], AUTHT),
  m('accept-anchor-mature', AUTH, ["    if (!registry.anchorMature()) return { ok: false, reason: 'anchor_too_new' }\n    const integrity", '    const integrity'], AUTHT),
  m('accept-integrity', AUTH, ['    if (!integrity.ok) return { ok: false, reason: integrity.reason }\n    const selfDns', '    const selfDns'], AUTHT),
  m('integrity-now-enabled', AUTH, ["    if (!report || report.enabled !== true) return { ok: false, reason: 'integrity_off', report }", "    if (!report) return { ok: false, reason: 'integrity_off', report }"], AUTHT),
  m('integrity-now-failed', AUTH, ["    if (report.lastCheckOk !== true) return { ok: false, reason: 'integrity_failed', report }\n", ''], AUTHT),
  m('accept-passkey-missing', AUTH, ["    if (!candidate.passkey) return { ok: false, reason: 'passkey_missing' }\n", ''], AUTHT),
  m('accept-passkey-parse', AUTH, ["    if (!assertion) return { ok: false, reason: 'passkey_malformed' }\n    const rpId", '    const rpId'], AUTHT),
  m('accept-passkey-verdict', AUTH, ['    if (!pk.ok) return { ok: false, reason: pk.reason }\n    const nowS', '    const nowS'], [...AUTHT, ...INTT]),
  m('accept-words-trailing-ws', AUTH, ["    if (/[\\t\\n\\v\\f\\r ]$/.test(signedWordsText(ctx.words))) return { ok: false, reason: 'words_trailing_whitespace' }\n", ''], AUTHT),
  m('accept-aud-unavailable', AUTH, ["    if (!aud) return { ok: false, reason: 'aud_unavailable' }\n", ''], AUTHT),
  m('accept-aud', AUTH, ['    if (env.aud !== aud) return', '    if (false) return'], [...AUTHT, ...INTT]),
  m('accept-envelope-origin', AUTH, ['    if (env.origin !== origin || candidate.requestOrigin !== origin)', '    if (candidate.requestOrigin !== origin)'], AUTHT),
  m('accept-request-origin', AUTH, ['    if (env.origin !== origin || candidate.requestOrigin !== origin)', '    if (env.origin !== origin)'], AUTHT),
  m('accept-key-state', AUTH, ['    if (!state.ok) return { ok: false, reason: state.reason }\n    if (env.kver', '    if (env.kver'], [...AUTHT, ...INTT]),
  m('accept-kver', AUTH, ["    if (env.kver !== state.entry.kver) return { ok: false, reason: 'key_version_stale' }\n", ''], AUTHT),
  m('accept-epoch', AUTH, ["    if (env.epoch !== registry.epoch()) return { ok: false, reason: 'epoch_stale' }\n", ''], AUTHT),
  m('accept-signature', AUTH, ['    if (!verifyP1363(state.key, parsed.bytes, candidate.signature)) return', '    if (false) return'], [...AUTHT, ...INTT]),
  m('accept-lifetime', AUTH, ["    if (env.exp <= env.iat || env.exp - env.iat > WEB_TURN_MAX_LIFETIME_S) return { ok: false, reason: 'lifetime_invalid' }", "    if (env.exp <= env.iat) return { ok: false, reason: 'lifetime_invalid' }"], AUTHT),
  m('accept-iat-skew-boundary', AUTH, ["    if (env.iat > nowS + WEB_TURN_IAT_SKEW_S) return { ok: false, reason: 'iat_in_future' }", "    if (env.iat > nowS + WEB_TURN_IAT_SKEW_S + 1) return { ok: false, reason: 'iat_in_future' }"], AUTHT),
  m('accept-expiry', AUTH, ["    if (nowS > env.exp) return { ok: false, reason: 'signature_expired' }", "    if (false) return { ok: false, reason: 'signature_expired' }"], [...AUTHT, ...INTT]),
  m('accept-fork-envelope', AUTH, ['    if (env.fork || ctx.fork === true)', '    if (ctx.fork === true)'], AUTHT),
  m('accept-fork-context', AUTH, ['    if (env.fork || ctx.fork === true)', '    if (env.fork)'], AUTHT),
  m('accept-destination-unbound', AUTH, ["    if (ctx.sessionId === null) return { ok: false, reason: 'destination_unbound' }\n", ''], AUTHT),
  m('accept-provider', AUTH, ['    if (env.provider !== ctx.provider || env.sessionId !== ctx.sessionId)', '    if (env.sessionId !== ctx.sessionId)'], AUTHT),
  m('accept-session', AUTH, ['    if (env.provider !== ctx.provider || env.sessionId !== ctx.sessionId)', '    if (env.provider !== ctx.provider)'], [...AUTHT, ...INTT]),
  m('accept-binding', AUTH, ["    if (env.bindingId !== null && env.bindingId !== (ctx.bindingId ?? null)) return { ok: false, reason: 'destination_mismatch' }\n", ''], AUTHT),
  m('accept-turn-id', AUTH, ["    if (env.turnId !== ctx.turnId) return { ok: false, reason: 'turn_id_mismatch' }\n", ''], [...AUTHT, ...INTT]),
  m('accept-words-hash', AUTH, ['    if (env.wordsSha256 !== words.sha256 || env.wordsLen !== words.len)', '    if (env.wordsLen !== words.len)'], [...AUTHT, ...INTT]),
  m('accept-words-crlf-only', AUTH, ["  const text = Buffer.from(signedWordsText(words), 'utf8')", "  const text = Buffer.from(words, 'utf8')"], AUTHT),
  m('accept-attachments-unsealable', AUTH, ["    if (ctx.attachments === null) return { ok: false, reason: 'attachments_unsealable' }\n", ''], AUTHT),
  m('accept-attachments-count', AUTH, ['    if (env.attachments.length !== ctx.attachments.length\n      || ', '    if ('], [...AUTHT, ...INTT]),
  m('accept-attachments-id', AUTH, ['a.id !== ctx.attachments![i].id || ', ''], AUTHT),
  m('accept-attachments-hash', AUTH, [' || a.sha256 !== ctx.attachments![i].sha256', ''], [...AUTHT, ...INTT]),
  m('accept-packet-unknown', AUTH, ["      if (!packet) return { ok: false, reason: 'packet_unknown' }\n", ''], AUTHT),
  m('accept-packet-fields', AUTH, ['      if (packet.action !== scope.action || packet.artifact !== scope.artifact || packet.version !== scope.version', '      if (packet.action !== scope.action || packet.artifact !== scope.artifact'], AUTHT),
  m('accept-packet-session', AUTH, ["      if (packet.provider !== env.provider || packet.sessionId !== env.sessionId) return { ok: false, reason: 'packet_session_mismatch' }\n", ''], AUTHT),
  m('accept-packet-session-provider', AUTH, ["      if (packet.provider !== env.provider || packet.sessionId", '      if (packet.sessionId'], AUTHT),
  m('accept-approve-enabled', AUTH, ["      if (!WEB_KEY_ENABLED_APPROVE_ACTIONS.has(scope.action)) return { ok: false, reason: 'approve_action_not_enabled' }\n", ''], AUTHT),
  m('accept-packet-single-use', AUTH, ['    if (packetSha !== null) this.deps.packets.close(packetSha)\n', ''], AUTHT),
  m('accept-nonce', AUTH, ['    if (spent !== \'ok\') return { ok: false, reason: spent }\n', ''], [...AUTHT, ...INTT]),
  m('recheck-flag', AUTH, ["      if (!this.enabled()) return 'web_key_authority_off'\n      if (Math.floor", '      if (Math.floor'], AUTHT),
  m('recheck-expiry', AUTH, ["      if (Math.floor(this.now() / 1000) > proof.exp) return 'signature_expired'\n", ''], [...AUTHT, ...INTT]),
  m('recheck-key', AUTH, ['      if (!state.ok) return state.reason\n', ''], [...AUTHT, ...INTT]),
  m('recheck-words', AUTH, ["      if (wordsDigest(words).sha256 !== proof.wordsSha256) return 'words_changed'\n", ''], AUTHT),
  m('recheck-integrity', AUTH, ['      if (!integrity.ok) return integrity.reason\n      if (wordsDigest', '      if (wordsDigest'], AUTHT),
  m('recheck-attachments', AUTH, ["      if (manifestDigest(parsed.envelope.attachments) !== attachmentsDigest) return 'attachments_changed'\n", ''], AUTHT),
  m('review-flag', AUTH, ["      if (!this.enabled()) return { reason: 'web_key_authority_off', entry: null, facts: null }\n", ''], [...AUTHT, ...INTT]),
  m('review-record-turn', AUTH, ['      if (record.turnId !== env.turnId || record.target', '      if (record.target'], [...AUTHT, ...INTT]),
  m('review-record-provider', AUTH, ['record.target?.provider !== env.provider || ', ''], [...AUTHT, ...INTT]),
  m('review-record-session', AUTH, [' || record.target?.sessionId !== env.sessionId\n', '\n'], [...AUTHT, ...INTT]),
  m('review-proof-words', AUTH, [' || proof.wordsSha256 !== env.wordsSha256', ''], AUTHT),
  m('review-proof-session', AUTH, [' || proof.sessionId !== env.sessionId || proof.wordsSha256', ' || proof.wordsSha256'], AUTHT),
  m('review-proof-scope', AUTH, ['        || !same(proof.scope, env.scope) || !sigBytes', '        || !sigBytes'], AUTHT),
  m('review-proof-authid', AUTH, [' || proof.authId !== sha256Hex(sigBytes)', ''], [...AUTHT, ...INTT]),
  m('review-anchor-refusal', AUTH, ['      if (refusal) return { reason: refusal, entry, facts }\n', ''], AUTHT),
  m('review-anchor-mature', AUTH, ["      if (!registry.anchorMature()) return { reason: 'anchor_too_new', entry, facts }\n", ''], AUTHT),
  m('review-key', AUTH, ['      if (!state.ok) return { reason: state.reason, entry, facts }\n', ''], INTT),
  m('review-signature', AUTH, ["      if (!verifyP1363(state.key, parsed.bytes, proof.signature)) return { reason: 'signature_invalid', entry, facts }\n", ''], INTT),
  m('review-passkey-missing', AUTH, ["      if (!proof.passkey || !rpId) return { reason: 'passkey_missing', entry, facts }\n", ''], AUTHT),
  m('review-passkey', AUTH, ['      if (!pk.ok) return { reason: pk.reason, entry, facts }\n', ''], AUTHT),
  m('review-integrity-at-accept', AUTH, ["      if (!proof.integrity || proof.integrity.enabled !== true || proof.integrity.lastCheckOk !== true) return { reason: 'integrity_off', entry, facts }\n", ''], AUTHT),
  m('review-integrity-now', AUTH, ['      if (!integrity.ok) return { reason: integrity.reason, entry, facts }\n      return { reason: null', '      return { reason: null'], AUTHT),

  // ── The grammar (shared/web-turn-envelope.ts) and crypto (lib/web-key-envelope.ts) ──
  m('grammar-version', SH, ["  if (v.v !== WEB_TURN_ENVELOPE_VERSION) return { ok: false, reason: 'envelope_version_unknown' }\n", ''], AUTHT),
  m('grammar-exact-keys', SH, ["  if (!exactKeys(v, ENVELOPE_KEYS)) return { ok: false, reason: 'envelope_malformed' }\n", ''], AUTHT),
  m('grammar-message-exact', SH, ["  if (v.kind === 'message') return exactKeys(v, ['kind']) ? { kind: 'message' } : null", "  if (v.kind === 'message') return { kind: 'message' }"], AUTHT),
  m('grammar-approve-exact', SH, ['    if (!exactKeys(v, APPROVE_SCOPE_KEYS)) return null\n', ''], AUTHT),
  m('grammar-approve-actions', SH, ["  if (typeof action !== 'string' || !APPROVE_ACTIONS.has(action)) return false\n", ''], [...AUTHT, ...INTT]),
  m('grammar-unknown-kind', SH, ["packetSha256: v.packetSha256 }\n  }\n  return null", "packetSha256: v.packetSha256 }\n  }\n  return { kind: 'message' }"], AUTHT),
  m('grammar-approve-fields', SH, ['    if (!approveFieldsValid(v.action, v.artifact, v.version, v.digest, v.channel)) return null\n', ''], AUTHT),
  m('grammar-artifact', SH, ["  if (typeof artifact !== 'string' || !APPROVE_ARTIFACT_RE.test(artifact)) return false\n", ''], AUTHT),
  m('grammar-approve-version', SH, ["  if (typeof version !== 'string' || !APPROVE_VERSION_RE.test(version)) return false\n", ''], AUTHT),
  m('grammar-digest', SH, ["  if (typeof digest !== 'string' || !APPROVE_DIGEST_RE.test(digest)) return false\n", ''], AUTHT),
  m('grammar-channel-table', SH, ["  if (typeof channel !== 'string' || !channels.includes(channel)) return false", "  if (typeof channel !== 'string') return false"], AUTHT),
  m('grammar-message-not-authorized', SH, ["  if (scope.kind === 'message') return [...WEB_KEY_NEVER_AUTHORIZED, ...MESSAGE_SCOPE_NOT_AUTHORIZED]", "  if (scope.kind === 'message') return [...WEB_KEY_NEVER_AUTHORIZED]"], [...AUTHT, ...INTT]),
  m('grammar-sorted-keys', SH, ['    const keys = Object.keys(obj).sort()', '    const keys = Object.keys(obj)'], [...AUTHT, ...INTT]),
  m('grammar-safe-integers', SH, ["    if (!Number.isSafeInteger(value)) throw new CanonicalJsonError('only safe integers are signable')\n", ''], AUTHT),
  m('crypto-canonical-bytes', ENV, ['  if (!canonical || !canonical.equals(bytes)) return', '  if (!canonical) return'], AUTHT),
  m('crypto-p256-only', ENV, ["    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null", "    if (key.asymmetricKeyType !== 'ec') return null"], REGT),
  m('crypto-strict-b64url', ENV, ["  if (typeof s !== 'string' || !B64URL_RE.test(s) || s.length % 4 === 1) return null", "  if (typeof s !== 'string') return null"], AUTHT),

  // ── Registry and ceremony (lib/web-key-registry.ts) ──
  m('registry-anchor-sig', REG, ['    if (!bytes || !verifyP1363(anchor.key, bytes, entry.anchorSig)) return null', '    if (!bytes) return null'], [...AUTHT, ...REGT]),
  m('registry-anchor-aud', REG, [' || a.aud !== aud || a.kver', ' || a.kver'], REGT),
  m('registry-revoked', REG, ["    if (typeof entry.revokedAt === 'number') return { ok: false, reason: 'key_revoked' }\n", ''], [...AUTHT, ...REGT]),
  m('enroll-one-pending', REG, ["    if (this.live()) return { ok: false, reason: 'enrollment_pending' }\n", ''], REGT),
  m('enroll-never-replace', REG, ["    if (this.registry.entry(kid)) return { ok: false, reason: 'key_already_enrolled' }\n", ''], REGT),
  m('enroll-cap', REG, ["    if (rotates === null && this.registry.activeCount(ctx.selfDnsName) >= WEB_KEY_MAX_ACTIVE) return { ok: false, reason: 'key_cap_reached' }\n", ''], REGT),
  m('enroll-expiry', REG, ['    if (this.pending && this.now() > this.pending.exp) {', '    if (false) {'], REGT),
  m('enroll-proof', REG, ["    if (!parsed || !msg || !verifyP1363(parsed.key, msg, input.signature)) return this.failProof(p, 'proof_invalid')", "    if (!parsed || !msg) return this.failProof(p, 'proof_invalid')"], [...REGT, ...INTT]),
  m('enroll-burn', REG, ['    if (p.attempts >= WEB_ENROLL_MAX_PROOF_ATTEMPTS) {', '    if (p.attempts >= 99) {'], REGT),
  m('enroll-device', REG, ['    if (!this.deviceAllowed(remote)) {', '    if (false) {'], REGT),
  m('enroll-device-default-refuses', REG, ['    this.deviceAllowed = opts.deviceAllowed ?? (() => false)', '    this.deviceAllowed = opts.deviceAllowed ?? (() => true)'], REGT),
  m('enroll-commit-format', REG, ["    if (typeof input.sasCommit !== 'string' || !/^[0-9a-f]{64}$/.test(input.sasCommit)) return { ok: false, reason: 'invalid_commit' }\n", ''], REGT),
  m('enroll-commit-reveal', REG, [" || sha256Hex(r) !== p.sasCommit) return this.failProof(p, 'commit_mismatch')", ") return this.failProof(p, 'commit_mismatch')"], REGT),
  m('enroll-sas-uses-r', REG, ['  const digest = createHash(\'sha256\').update(challenge).update(spkiDer).update(phoneNonce).digest()', '  const digest = createHash(\'sha256\').update(challenge).update(spkiDer).digest()'], REGT),
  m('enroll-passkey-malformed', REG, ["    if (!passkeyDer || !assertion || !credentialId) return this.failProof(p, 'passkey_malformed')\n", ''], REGT),
  m('enroll-passkey-verify', REG, ["    if (!verdict.ok) return this.failProof(p, 'passkey_invalid')\n", ''], REGT),
  m('enroll-pending-only-approval', REG, ['      enrollId: p.enrollId,\n      startedAt: p.startedAt,', '      enrollId: p.enrollId,\n      sas: p.proven.sas,\n      startedAt: p.startedAt,'], [...REGT, ...INTT]),
  m('approval-rotates-signed', REG, ['        rotates: p.rotates,\n        passkey_credential_id', '        passkey_credential_id'], REGT),
  m('approval-remote-signed', REG, ['        remote: p.remote,\n        challenge', '        challenge'], REGT),
  m('registry-anchor-needs-record', REG, ['    if (parsed && reg) {', '    if (parsed && !reg) { anchor = { b64: this.data.anchorPub, key: parsed.key, der: parsed.der, spkiSha256: sha256Hex(parsed.der), fingerprint: fingerprintOfSpki(parsed.der), setAt: 0 } } else if (parsed && reg) {'], [...AUTHT, ...REGT]),
  m('registry-anchor-selfsig', REG, ['\n        && verifyP1363(parsed.key, bytes, reg.signature)) {', ') {'], REGT),
  m('registry-anchor-statement-key', REG, [" && stmt.spkiSha256 === spkiSha256 && stmt.fingerprint === fingerprint\n", '\n'], REGT),
  m('registry-epoch', REG, ["    if (entry.approval.epoch !== this.data.epoch) return { ok: false, reason: 'key_epoch_stale' }\n", ''], AUTHT),
  m('registry-passkey-anchored', REG, [' || a.passkey_spki_sha256 !== sha256Hex(passkey.der)', ''], AUTHT),
  m('registry-approval-spki', REG, ['    if (a.spki !== entry.spki || a.spki_sha256', '    if (a.spki_sha256'], REGT),
  m('register-mismatch', REG, ["    if (stmt.spkiSha256 !== spkiSha256 || stmt.fingerprint !== fingerprint) return { ok: false, reason: 'statement_mismatch' }\n", ''], REGT),
  m('register-stale', REG, ["    if (Math.abs(this.now() - stmt.createdAt) > WEB_ANCHOR_STATEMENT_SKEW_MS) return { ok: false, reason: 'statement_stale' }\n", ''], REGT),
  m('register-signature', REG, ["    if (!verifyP1363(parsed.key, bytes, input.signature)) return { ok: false, reason: 'anchor_signature_invalid' }\n    const before", '    const before'], [...REGT, ...INTT]),
  m('register-replace-revokes', REG, ["      for (const e of this.data.entries) if (typeof e.revokedAt !== 'number') { e.revokedAt = setAt; e.revokeReason = 'anchor_replaced'; e.revokedBy = by }\n", ''], REGT),
  m('register-maturity-24h', REG, ['export const WEB_ANCHOR_MATURITY_MS = 24 * 3_600_000', 'export const WEB_ANCHOR_MATURITY_MS = 3_600_000'], [...AUTHT, ...REGT]),
  m('enroll-needs-proof', REG, ["    if (!p.proven) return { ok: false, reason: 'not_proven' }\n", ''], REGT),
  m('enroll-anchor-approval', REG, ['    if (!bytes || !verifyP1363(anchor.key, bytes, anchorSig)) {', '    if (!bytes) {'], [...REGT, ...INTT]),
  m('enroll-epoch', REG, ["    if (this.registry.epoch() !== p.epoch) { this.settle('refused'); return { ok: false, reason: 'epoch_changed' } }\n", ''], REGT),
  m('enroll-rotation-revokes', REG, ["    if (rotated) this.registry.revoke(rotated, 'rotated', `rotation:${entry.kid}`)\n", ''], REGT),
  m('nonce-single-use', REG, ["    if (row.spentAt !== undefined) return 'nonce_spent'\n", ''], [...AUTHT, ...REGT, ...INTT]),
  m('nonce-expiry', REG, ["    if (this.now() > row.exp) return 'nonce_expired'\n", ''], AUTHT),
  m('nonce-unavailable', REG, ["    if (this.unavailable) return 'nonce_store_unavailable'\n", ''], AUTHT),
  m('nonce-cap', REG, ["    if (outstanding >= WEB_NONCE_MAX_OUTSTANDING) return { ok: false, reason: 'nonce_cap_reached' }\n", ''], REGT),
  m('spend-one-winner', REG, ["    if (keys.some(k => this.data.consumed[k])) return { ok: false, reason: 'already_consumed' }\n", ''], [...REGT, ...INTT]),
  m('spend-all-keys', REG, ['    for (const k of keys) this.data.consumed[k] = { at, session, provider }\n', '    this.data.consumed[keys[0]] = { at, session, provider }\n'], [...REGT, ...INTT]),
  m('packet-context-only', REG, ["    if ('provider' in input || 'sessionId' in input) return { ok: false, reason: 'session_from_context_only' }\n", ''], [...AUTHT, ...INTT]),
  m('packet-strict-fields', REG, ["    if (!approveFieldsValid(input.action, input.artifact, input.version, input.digest, input.channel)) return { ok: false, reason: 'invalid_packet' }\n", ''], AUTHT),
  m('packet-creator', REG, ["      || typeof sessionId !== 'string' || sessionId.length === 0", "      || typeof sessionId !== 'string'"], AUTHT),
  m('packet-closed-actions', REG, ["    if (typeof input.action !== 'string' || !APPROVE_ACTIONS.has(input.action)) return { ok: false, reason: 'action_not_allowed' }\n", ''], AUTHT),

  // ── Provenance (lib/g2-turn-provenance.ts) ──
  m('prov-candidate-flag-gated', PROV, ["    if (client === 'web' && this.webKeyOn()) {", "    if (client === 'web') {"], INTT),
  m('prov-candidate-web-only', PROV, ["    if (client === 'web' && this.webKeyOn()) {", '    if (this.webKeyOn()) {'], INTT),
  m('prov-footer-web-needs-key', PROV, ["  if (kind === 'web') return verdict.authority === 'web-key' && verdict.webKey !== undefined\n", ''], INTT),
  m('prov-footer-web-needs-proof', PROV, ["  if (kind === 'web') return verdict.authority === 'web-key' && verdict.webKey !== undefined", "  if (kind === 'web') return verdict.authority === 'web-key'"], INTT),
  m('prov-record-web-needs-key', PROV, ["  return verdict.verifiedOrigin === true && verdict.authority === 'web-key' && verdict.webKey !== undefined", '  return verdict.verifiedOrigin === true'], INTT),
  m('prov-fork-first', PROV, ["    if (ctx.fork === true) return webKeyRefused(verdict, 'fork_destination_unbound')\n", ''], INTT),
  m('prov-accept-refusal', PROV, ['      return webKeyRefused(verdict, judged.reason)\n', '      return verdict\n'], INTT),
  m('prov-reheld', PROV, ['    return reason === null ? verdict : webKeyRefused(verdict, reason)', '    return verdict'], INTT),
  m('prov-queued-verdict-rechecked', PROV, ['    return held ? this.reheld(held.verdict, prompt, held.attachments) : null', '    return held ? held.verdict : null'], INTT),
  m('prov-carry-rechecked', PROV, ['      const verdict = held ? this.reheld(held.verdict, turn.prompt, held.attachments) : null', '      const verdict = held ? held.verdict : null'], INTT),
  m('prov-describe-record', PROV, ['authority.review(record.webKey as WebKeyProof, { turnId: record.turnId, target: record.target })', "authority.review(record.webKey as WebKeyProof, { turnId: (record.webKey as WebKeyProof & { _t?: string })._t ?? JSON.parse(Buffer.from((record.webKey as WebKeyProof).envelope, 'base64url').toString()).turnId, target: { provider: (record.webKey as WebKeyProof).provider, sessionId: (record.webKey as WebKeyProof).sessionId } })"], INTT),
  m('prov-describe-review', PROV, ['    else if (webKeyReview.reason !== null) reason = webKeyReview.reason\n', ''], INTT),
  m('prov-describe-flag-off', PROV, ['  const webKeyOn = authority !== null && authority.enabled()', '  const webKeyOn = authority !== null'], INTT),
  m('prov-web-reason-parity', PROV, ["(originKind === 'web' ? (input.verdict.webKeyReason ?? WEB_UNVOUCHED_REASON) :", "(originKind === 'web' ? (input.verdict.reason ?? WEB_UNVOUCHED_REASON) :"], [...INTT, ...WEBT]),

  // ── The turn routes ──
  m('bind-accepts', BIND, ['        turnVerdict = provenance.acceptWebKey(turnVerdict, { provider: binding.provider, sessionId: binding.nativeThreadId, bindingId, turnId: clientTurnId, words, attachments: webKeyFiles })', '        void 0'], INTT),
  m('bind-files-read', BIND, ['        webKeyFiles = m.ok ? m.manifest : null', '        webKeyFiles = []'], INTT),
  m('park-accepts', TQR, ['      verdict = deps.provenance.acceptWebKey(sealed.verdict, { provider, sessionId: threadId, turnId: clientTurnId, words: prompt, attachments: sealed.manifest })', '      verdict = sealed.verdict'], INTT),
  m('resend-accepts', TQR, ['      const copyVerdict = deps.provenance.acceptWebKey(sealed.verdict, { provider, sessionId: threadId, turnId: newId, words: copy.prompt, attachments: sealed.manifest })', '      const copyVerdict = sealed.verdict'], INTT),
  m('edit-accepts', TQR, ['      const editVerdict = deps.provenance.acceptWebKey(sealed.verdict, { provider, sessionId: threadId, turnId: id, words: prompt, attachments: sealed.manifest })', '      const editVerdict = sealed.verdict'], INTT),

  // ── The web-key and g2-turns routers ──
  m('router-flag-off', WKR, ["    if (!deps.authority.enabled()) { next('router'); return }\n", ''], INTT),
  m('router-start-web-only', WKR, ["  router.post('/web-key/enroll/start', (req, res) => {\n    if (!web(req)) return refuse(res, 403, 'web_origin_required')", "  router.post('/web-key/enroll/start', (req, res) => {"], INTT),
  m('router-prove-web-only', WKR, ["  router.post('/web-key/enroll/prove', (req, res) => {\n    if (!web(req)) return refuse(res, 403, 'web_origin_required')", "  router.post('/web-key/enroll/prove', (req, res) => {"], INTT),
  m('router-pending-token', WKR, ["  router.get('/web-key/enroll/pending', (req, res) => {\n    if (!hasToken(req)) return refuse(res, 401, 'token_required')", "  router.get('/web-key/enroll/pending', (req, res) => {"], INTT),
  m('router-approve-token', WKR, ["  router.post('/web-key/enroll/approve', (req, res) => {\n    if (!hasToken(req)) return refuse(res, 401, 'token_required')", "  router.post('/web-key/enroll/approve', (req, res) => {"], INTT),
  m('router-nonce-web-only', WKR, ["  router.post('/web-key/nonce', (req, res) => {\n    if (!web(req)) return refuse(res, 403, 'web_origin_required')", "  router.post('/web-key/nonce', (req, res) => {"], INTT),
  m('router-anchor-loopback', WKR, ['    if (!addr || !isLoopbackAddress(addr) || hasProxyForwardedHeaders(req.headers))', '    if (!addr || hasProxyForwardedHeaders(req.headers))'], INTT),
  m('router-anchor-proxy', WKR, [" || hasProxyForwardedHeaders(req.headers)) return refuse(res, 403, 'loopback_required'", ") return refuse(res, 403, 'loopback_required'"], INTT),
  m('router-anchor-token', WKR, ["    if (!hasToken(req)) return refuse(res, 401, 'token_required')\n    const b = body(req)\n    const result = deps.authority.registry.registerAnchor", '    const b = body(req)\n    const result = deps.authority.registry.registerAnchor'], INTT),
  m('router-packet-context', WKR, ["{ provider: header('x-cos-provider'), sessionId: header('x-cos-session-id') }", '{ provider: body(req).provider, sessionId: body(req).sessionId }'], INTT),
  m('consume-both-keys', G2R, ['      const spent = authority.nonces.spend(keys, b.session, b.provider)', '      const spent = authority.nonces.spend([keys[0]], b.session, b.provider)'], INTT),
  m('consume-flag-off', G2R, ['    if (!authority || !authority.enabled()) return next()\n', '    if (!authority) return next()\n'], INTT),
  m('consume-token', G2R, ["    if (!expected || !timingSafeTokenEqual(req.headers['x-cos-token'], expected)) return void res.status(401).json({ consumed: false, error: 'token_required' })\n", ''], INTT),
  m('consume-destination', G2R, ["      if (typeof b.session !== 'string' || typeof b.provider !== 'string' || target?.sessionId !== b.session || target?.provider !== b.provider) {", "      if (typeof b.session !== 'string' || typeof b.provider !== 'string') {"], INTT),

  // ── Passkey assertions (lib/web-key-passkey.ts) ──
  m('pk-credential', PK, ["    if (a.credentialId !== expect.credentialId) return { ok: false, reason: 'passkey_credential_mismatch' }\n", ''], AUTHT),
  m('pk-type', PK, ["    if (client.type !== 'webauthn.get') return { ok: false, reason: 'passkey_type_invalid' }\n", ''], AUTHT),
  m('pk-challenge', PK, ["    if (client.challenge !== expect.challenge.toString('base64url')) return { ok: false, reason: 'passkey_challenge_mismatch' }\n", ''], AUTHT),
  m('pk-origin', PK, ['    if (client.origin !== expect.origin || (client.crossOrigin', '    if ((client.crossOrigin'], [...AUTHT, ...REGT]),
  m('pk-cross-origin', PK, [' || (client.crossOrigin !== undefined && client.crossOrigin !== false)', ''], AUTHT),
  m('pk-rpid', PK, ["    if (!authData.subarray(0, 32).equals(rpIdHash)) return { ok: false, reason: 'passkey_rpid_mismatch' }\n", ''], AUTHT),
  m('pk-up', PK, ['    if ((flags & PASSKEY_FLAG_UP) === 0 || (flags', '    if ((flags'], AUTHT),
  m('pk-uv', PK, [' || (flags & PASSKEY_FLAG_UV) === 0', ''], [...AUTHT, ...REGT]),
  m('pk-signature', PK, ["    if (!verify('sha256', signed, { key: expect.publicKey, dsaEncoding: 'der' }, sig)) return { ok: false, reason: 'passkey_invalid' }\n", ''], [...AUTHT, ...REGT]),
  m('pk-header-canonical', PK, ['  return canonical && canonical.equals(bytes) ? a : null', '  return a'], AUTHT),
  m('cose-alg', PK, ['  if (map.get(1) !== 2 || map.get(3) !== -7 || map.get(-1) !== 1) return null', '  if (map.get(1) !== 2 || map.get(-1) !== 1) return null'], REGT),
  m('cose-trailing', PK, ['  if (pos !== buf.length) return null\n', ''], REGT),

  // ── Signer origin and listeners ──
  m('origin-signer-port', ORIG, ['export const WEB_KEY_SIGNER_PORT = 3144', 'export const WEB_KEY_SIGNER_PORT = 3143'], ORIGT),
  m('listener-signer-flag-gated', LIS, ['    if (opts.webKeyAuthority) plan.push(', '    plan.push('], ORIGT),

  // ── Served-asset integrity ──
  m('integrity-default-off', INTEG, ['  return readSwitch(env.COS_WEB_CONTROL_INTEGRITY, readSwitch(env.COS_WEB_KEY_AUTHORITY, false))', '  return readSwitch(env.COS_WEB_CONTROL_INTEGRITY, readSwitch(env.COS_WEB_KEY_AUTHORITY, true))'], INTEGT),
  m('integrity-follows-web-key', INTEG, ['  return readSwitch(env.COS_WEB_CONTROL_INTEGRITY, readSwitch(env.COS_WEB_KEY_AUTHORITY, false))', '  return readSwitch(env.COS_WEB_CONTROL_INTEGRITY, false)'], INTEGT),
  m('integrity-changed', INTEG, ["      if (createHash('sha256').update(body).digest('hex') !== want) {", '      if (false) {'], INTEGT),
  m('integrity-unexpected', INTEG, ["      if (!want) { mismatches.push({ path: f.urlPath, problem: 'unexpected' }); continue }", "      if (!want) { continue }"], INTEGT),
  m('integrity-missing', INTEG, ["    for (const p of Object.keys(expected)) if (!seen.has(p)) mismatches.push({ path: p, problem: 'missing' })\n", ''], INTEGT),
  m('integrity-manifest-paths', INTEG, [" && !k.includes('..')", ''], INTEGT),
  m('integrity-manifest-once', INTEG, ['    const expected = this.manifest.files', '    const expected = (JSON.parse(readFileSync(join(this.dir, WEB_CONTROL_MANIFEST_FILE), "utf8")) as WebControlManifest).files'], INTEGT),
  m('integrity-skips-tests', INTEG, ["    else if (st.isFile() && !name.endsWith('.test.ts')) out.push({ urlPath, file })", '    else if (st.isFile()) out.push({ urlPath, file })'], INTEGT),
  m('static-refuses-on-fail', STATIC, ['    if (integrity && verified() === null) {', '    if (false) {'], INTEGT),
  m('static-no-fallthrough', STATIC, ["      if (integrity) { res.status(404).type('text').send('Not found'); return }\n", ''], INTEGT),
  m('static-verified-bytes-only', STATIC, ['    if (source) return source.get(file) ?? null\n', ''], INTEGT),
  m('static-periodic-recheck', STATIC, ['    if (every > 0) { timer = setInterval(', '    if (false) { timer = setInterval('], INTEGT),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length && !args.includes('--check') ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && !args.includes('--check') && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')
if (args.includes('--check')) {
  let bad = 0
  for (const { name, file, edits } of mutations) {
    let text = readFileSync(join(root, file), 'utf8')
    const original = text
    for (const [find, replacement] of edits) {
      const n = text.split(find).length - 1
      if (n !== 1) { console.log(`${name}: matches ${n} times in ${file}: ${find.slice(0, 90)}`); bad++ }
      else text = text.replace(find, () => replacement)
    }
    if (text === original) { console.log(`${name}: no change`); bad++ }
  }
  console.log(`${mutations.length - bad} of ${mutations.length} targets match exactly once`)
  process.exit(bad ? 1 : 0)
}

const scratch = mkdtempSync(join(tmpdir(), 'web-key-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  for (const dir of ['shared', 'work-task-runtime', 'bin', 'docs', 'test-support']) cpSync(join(root, dir), join(scratch, dir), { recursive: true })
  for (const file of ['vitest.config.ts', 'package.json', 'managed-runtime-contract.json', '.env.example']) cpSync(join(root, file), join(scratch, file))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: process.env.TMPDIR, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json') },
    encoding: 'utf8', timeout: 300000,
  })
  const baseline = run(ALL)
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout.slice(-4000) + '\n' + baseline.stderr.slice(-4000))
  const totals = /Tests\s+(\d+) passed/.exec(baseline.stdout)
  console.log(`baseline PASS (${totals ? totals[1] : '?'} tests in ${ALL.length} files)`)
  let killed = 0
  for (const { name, file, edits, tests } of selected) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    let mutated = original
    for (const [find, replacement] of edits) {
      if (mutated.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}: ${find.slice(0, 80)}`)
      mutated = mutated.replace(find, () => replacement)
    }
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    let result
    try { result = run(tests) } finally { writeFileSync(target, original) }
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    const output = result.stdout + '\n' + result.stderr
    const killers = [...new Set([...output.matchAll(/FAIL\s+((?:server|shared)\/\S+\.test\.ts > [^\n]+)/g)].map(x => x[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { console.log(`${name} SURVIVED or harness failed\n${output.slice(-1500)}`); process.exitCode = 1; continue }
    killed += 1
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${killed} of ${selected.length} web-key 6.99.31 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
