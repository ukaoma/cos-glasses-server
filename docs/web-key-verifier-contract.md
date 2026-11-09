> Current integration: Codex phone-approvals lane, based on server 7.0.4. No live enrollment or authority activation is implied. `COS_WEB_KEY_AUTHORITY` remains off by default. Historical 6.99.31 labels below describe the reusable WIP, not a shipped qualification. Fresh focused, final independent and on-device acceptance are required.

# Web key verifier contract (server 6.99.31, flag `COS_WEB_KEY_AUTHORITY`)

What `verify_g2_turn.py` (MU-Chief-Staff `operations/scripts/`) reads for a Control Web turn signed by
an enrolled phone key. The server half lives in `shared/web-turn-envelope.ts`,
`server/lib/web-key-*.ts`, `server/routes/web-key.ts` and `server/routes/g2-turns.ts`. When this file
and the code disagree, the code is wrong: fix one of them and add a line to the change log at the end.

Flag unset: none of this exists. `GET /api/g2-turns/:id` answers a web record exactly as 6.99.29
(`reason: "web_cookie_derivable_from_token"`, no web-key fields), and every `/api/web-key/*` route is
a 404 fall-through.

## 0. Encodings

| Name | Format |
| --- | --- |
| b64url | RFC 4648 base64url, no padding, alphabet `[A-Za-z0-9_-]`. Length mod 4 never 1. |
| hex64 | 64 lower-case hex characters (a sha256 digest). |
| JCS | RFC 8785. Keys sorted by UTF-16 code unit (every key in this protocol is ASCII, so code-point sort agrees), no whitespace, strings escaped as ES `JSON.stringify`, numbers are safe integers only (no floats, no exponents). Lone surrogates are refused, in keys and values. Booleans are never integers: Python must reject `True`/`False` wherever an integer is required (`kver`, `epoch`, `iat`, `exp`, `bytes`, `wordsLen`, `createdAt`, `setAt`). Python mirror: `json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` plus the surrogate and boolean checks. |
| P1363 | ECDSA P-256 / SHA-256 signature as `r||s`, exactly 64 bytes, carried b64url. Used by the phone key and the anchor. |
| DER sig | ECDSA signature as ASN.1 DER. Used by WebAuthn (ES256) only. |
| SPKI | P-256 SubjectPublicKeyInfo DER, carried b64url. Must re-export to identical bytes (no trailing data). |
| fingerprint | First 16 hex of sha256(SPKI DER), upper case, as `XXXX-XXXX-XXXX-XXXX`. For people. Machines compare the full `spkiSha256` (hex64). |
| kid | `b64url(sha256(SPKI DER))[0:22]`. |

Every signed object is signed over its JCS bytes. The server refuses bytes that are not already
canonical, so one message has exactly one signable form.

## 1. Origins and identity

- **Signer origin:** `https://<selfDnsName>:3144` (`WEB_KEY_SIGNER_PORT = 3144`,
  `webKeySignerOrigin()` in `server/lib/web-key-origin.ts`). The ONLY origin a phone key or passkey
  signs from. `envelope.origin`, the request `Origin` header, the passkey `clientDataJSON.origin`
  and the cookie gate's extra port all use this one function. 3143 (the big app) never signs.
- **What 3144 serves (Phase 3, `lib/web-key-signer-app.ts`):** the signer page only (`server/web-signer/`:
  `index.html`, `signer.js`, `signer-proof.js`, `signer-store.js`, `signer.css`), from bytes that matched
  `server/web-signer/.manifest.json` (written at pack time like the Control Web manifest), plus an /api
  allowlist: `GET web-key/status`, `GET web-key/keys`, `POST web-key/nonce`, `POST web-key/enroll/start`,
  `POST web-key/enroll/prove`, `GET web-key/enroll/status`, `POST web-key/revoke`, `POST web-key/handoff/claim`,
  `POST agent-sessions/bindings/:id/turns`, `GET agent-sessions/bindings/:id/turns/:turnId`. Everything else
  is 404 there. An /api request naming another `Origin` is refused (403 `origin_refused`), and a write must
  name the signer origin. Every answer carries `Content-Security-Policy` with `default-src 'none'`,
  `script-src 'self'`, `style-src 'self'`, `frame-ancestors 'none'` (no inline script or style), plus
  `X-Frame-Options: DENY`, COOP and CORP `same-origin`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- **Signer-only steps:** `enroll/start`, `enroll/prove`, `nonce` and `handoff/claim` answer 403
  `signer_origin_required` unless the request reached the 3144 listener (socket local port). A page on 3143
  can neither make a key nor fetch a handoff.
- **rpId:** `selfDnsName`, the full lower-case MagicDNS host, no trailing dot (for example
  `ukaoma-mac-studio.tail38457f.ts.net`; `ts.net` is a public suffix). The verifier derives it as
  the host of `envelope.origin`.
- **aud:** `hex(sha256(anchor SPKI DER || utf8(lower(rpId))))`. The verifier computes it from ITS
  pinned anchor, never from a key in the answer.

## 2. The anchor (B1)

The anchor is COS Control's Secure Enclave P-256 key. It reaches the server only through:

`POST /api/web-key/anchor` (flag on, loopback socket only, `X-Cos-Token` required, no proxy headers)

7.0.9: the same route also answers with `COS_WEB_KEY_ANCHOR_BOOTSTRAP` on and `COS_WEB_KEY_AUTHORITY` off,
with identical gates and the identical record. In that mode `GET /api/web-key/status` (token only)
answers `{ ok, enabled: false, mode: "bootstrap", anchorRegistered, anchorMature, anchorSetAt, aud,
origin, epoch }` and no other web-key route, listener or vouch exists. Nothing in this contract's
verdicts changes: a bootstrap-only server never vouches a web turn.

```json
{ "anchorPub": "<SPKI b64url>", "statement": "<b64url of JCS bytes>", "signature": "<P1363 b64url>" }
```

Statement (the anchor signs it with itself):

```json
{ "v": "cos-web-anchor/1", "spkiSha256": "<hex64 of anchorPub DER>", "fingerprint": "XXXX-XXXX-XXXX-XXXX", "createdAt": <ms> }
```

`createdAt` must be within 10 minutes of the server clock. The server stores
`anchorRegistration: { statement, signature, setAt }` next to `anchorPub` in `web-keys.json`, where
`setAt` is the server clock at registration. Registering a different anchor revokes every key and
bumps the epoch.

- An `anchorPub` in the file WITHOUT a registration record whose self-signature verifies is refused
  (`anchor_unregistered`): no enrollment, no vouch.
- `WEB_ANCHOR_MATURITY_MS = 86_400_000` (24 h). An anchor younger than that vouches nothing
  (`anchor_too_new`).
- `setAt` is file-backed, so a same-user process can backdate it. The 24 h rule binds the server's
  own route; **the verifier's committed pin is the real check.** The verifier must refuse when the
  pin file is missing, uncommitted, or its `spkiSha256` differs from `anchor.spkiSha256` in the answer.

## 3. Enrollment (anchor-signed approval)

Approval object, `cos-web-enroll-approve/2`. Every value Control displays is inside these bytes
(W4); Control decodes `approvalJcs` and derives the SAS, fingerprint and label from it, never from a
separate field. `GET /api/web-key/enroll/pending` returns only `{ enrollId, startedAt, exp, approval, approvalJcs }`.

```json
{
  "v": "cos-web-enroll-approve/2",
  "enrollId": "<b64url 16 bytes>",
  "kid": "<kid>",
  "spki": "<phone key SPKI b64url>",
  "spki_sha256": "<hex64>",
  "fingerprint": "XXXX-XXXX-XXXX-XXXX",
  "label": "<1..64 chars, attacker-supplied text>",
  "userAgent": "<0..200 chars, attacker-supplied text>",
  "remote": "<enrolling socket address, normalized, no ::ffff: prefix>",
  "challenge": "<b64url 32 bytes, server-chosen>",
  "sasCommit": "<hex64 = sha256(phoneNonce bytes)>",
  "phoneNonce": "<b64url 32 bytes, revealed at prove>",
  "sas": "<6 digits>",
  "aud": "<hex64>",
  "origin": "https://<rpId>:3144",
  "kver": 1,
  "epoch": <int>,
  "rotates": "<kid>" | null,
  "passkey_credential_id": "<b64url>",
  "passkey_spki_sha256": "<hex64 of passkey SPKI DER>",
  "enrolledAt": <ms>,
  "exp": <ms>
}
```

- **SAS (W3, commit-reveal):** the phone sends `sasCommit = sha256(r)` at start, BEFORE the server
  picks `challenge`; it reveals `r` (`phoneNonce`) at prove.
  `sas = uint32_be(sha256(challenge || spkiDer || r)[0:4]) mod 1_000_000`, zero-padded to 6.
  The phone computes it locally. The server cannot grind `challenge` to match a chosen SAS because
  `r` is unknown to it when it picks.
- **Proof of possession:** the phone key signs (P1363) the JCS of
  `{ "v": "cos-web-enroll/2", "enrollId", "challenge", "aud", "origin", "kid", "phoneNonce", "passkey_credential_id", "passkey_spki_sha256" }`,
  and the passkey asserts (section 5) with challenge `sha256(those JCS bytes)`.
- **Device allowlist (W6):** enrollment start is refused (`device_not_allowed`) unless the socket
  address is in `COS_WEB_KEY_DEVICES` (comma-separated addresses). Empty list: every start refused.
- **Registry entry** (what the turn answer returns as `registryEntry`):
  `{ kid, spki, passkeySpki, kver, label, approval, anchorSig, revokedAt? }`. `passkeySpki` is the
  passkey's P-256 SPKI b64url (converted from COSE at enrollment); its sha256 must equal
  `approval.passkey_spki_sha256`.
- An entry counts only when: `anchorSig` (P1363) verifies over JCS(approval) with the anchor,
  `approval.kid == kid == kid(spki)`, `approval.spki == spki`, `approval.spki_sha256 == sha256(spki)`,
  `approval.aud == aud`, `approval.kver == kver`, `approval.epoch == current epoch` (W5,
  `key_epoch_stale`), `sha256(passkeySpki) == approval.passkey_spki_sha256`, no `revokedAt`.
  `approval.rotates` (W8) names the one key the approval revoked; nothing else is revoked by it.

## 4. The envelope, `cos-web-turn/1`

Header `x-cos-web-envelope`: b64url of the JCS bytes. Header `x-cos-web-sig`: P1363 b64url by the
phone key over those exact bytes. Header `x-cos-web-passkey`: section 5.

```json
{
  "v": "cos-web-turn/1", "aud": "<hex64>", "origin": "https://<rpId>:3144",
  "kid": "<kid>", "kver": 1, "epoch": <int>,
  "turnId": "^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$", "nonce": "^[A-Za-z0-9_-]{22,64}$",
  "iat": <s>, "exp": <s>,
  "provider": "claude" | "codex" | "cursor", "sessionId": "<1..128>", "bindingId": "<1..128>" | null,
  "fork": false,
  "wordsSha256": "<hex64 = sha256(utf8(words with CRLF replaced by LF, nothing else))>", "wordsLen": <utf8 byte length>,
  "attachments": [ { "id": "<1..128>", "sha256": "<hex64>", "bytes": <int>, "name": "<0..255>" } ],
  "scope": { "kind": "message" } | { "kind": "approve", ... }
}
```

Exact key sets everywhere; an unknown key is refused. `exp - iat <= 900`, `iat <= now + 60`, `now <= exp`.

**Words never end in whitespace.** The footer step trims trailing ASCII whitespace
(`[\t\n\v\f\r ]`) before it appends the `[COS-WEB turn ...]` line, so the signer trims trailing
ASCII whitespace BEFORE it hashes, and the server refuses signed words that end in it
(`words_trailing_whitespace`). Inner whitespace is exact. The verifier hashes the words before the
footer as received (CRLF to LF only) and needs no trimming rule of its own.

### Scope (B4)

- `message`: **conversation only.** `MESSAGE_SCOPE_MEANING = "conversation"`. It never authorizes
  install, publish, push (main or branch), a Hub file, or anything on the never-list, whatever the
  words say.
- `approve`: `{ "kind": "approve", "action", "artifact", "version", "digest", "channel", "packetSha256" }`

| Field | Pattern |
| --- | --- |
| action | `install` \| `publish` \| `push-main` |
| artifact | `^[a-z0-9@][a-z0-9@._/-]{0,127}$` |
| version | `^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,32})?$` |
| digest | `^sha256:[0-9a-f]{64}$` or `^sha512:[0-9a-f]{128}$` or `^sha512-[A-Za-z0-9+/]{86}==$` (npm SRI) |
| channel | from the table below only |
| packetSha256 | hex64 of the JCS bytes of the packet |

| action | allowed channels |
| --- | --- |
| install | `mac-local` |
| publish | `npm-next`, `npm-latest`, `control-appcast`, `hub-alias`, `gotcos-site`, `control-downloads`, `release-docs` |
| push-main | `git-main` |

In this candidate `install` and `publish` are accepted only through exact scoped proof (`WEB_KEY_ENABLED_APPROVE_ACTIONS`). `push-main` remains refused with `approve_action_not_enabled`. A message scope never authorizes either action.

### Handoff from Control Web (3143) to the signer (3144), Phase 3

The composer never signs and never frames the signer. It posts the turn it wants approved, then navigates
TOP LEVEL to the signer. The words are fetched by the signer; they are never in a URL.

1. `POST /api/web-key/handoff` (web path, flag on) `{ bindingId, epoch, targetKey, clientTurnId, prompt,
   acknowledgedRevision?, boundTo?, packetSha256? }`. The destination (`provider`, `sessionId`) comes from
   the binding, never the body; a moved binding is `409 binding_changed`. Refused: `no_phone_key` (no
   active key), `attachments_not_signable` (any `attachmentIds`), `words_too_long` (over 8000 chars),
   `packet_unknown`, `packet_session_mismatch` (a packet is signable only for the session that created it).
   Answer `201 { ok, handoffId, exp, signerUrl: "https://<rpId>:3144/#h=<handoffId>" }`. The composer
   navigates only to that exact shape (same host, port 3144, path `/`, no query, fragment id only).
2. `POST /api/web-key/handoff/claim { handoffId }` (web path, 3144 listener, `Origin` = signer origin).
   Once only (`409 handoff_claimed`), within 120 s (`410 handoff_expired`). Answer
   `{ ok, handoff: { handoffId, exp, words, provider, sessionId, bindingId, turn: { bindingId, epoch, targetKey,
   clientTurnId, acknowledgedRevision?, boundTo? }, scope, packet: <full packet preimage or null>, attachments: [] } }`. `scope` is `message`, or the
   packet's `approve` scope when `packetSha256` was given.
3. The signer trims trailing ASCII whitespace from `words`, shows the exact result with provider, session
   and scope, and signs only after a real tap (`isTrusted`). For an approval, it first validates the full canonical packet preimage and SHA-256, exact fields and receiver, and expiry. It displays that packet with its digest and expiry before asking for a user-verified passkey. Cancel or denied verification sends nothing. Envelope: `origin` = the page's own
   `location.origin`; `turnId` = `turn.clientTurnId`; `aud`, `nonce`, `epoch` from `POST nonce`;
   `iat` = now - 30 s; `exp` = `iat` + 600; `fork: false`; `attachments: []`; `kver: 1`. It signs the JCS
   bytes with the device key, then calls `navigator.credentials.get` with challenge = sha256(those bytes)
   and `userVerification: "required"`, then posts `{ prompt: <the shown words>, epoch, targetKey,
   clientTurnId, acknowledgedRevision?, boundTo? }` to `POST /api/agent-sessions/bindings/:bindingId/turns`
   with the three headers.

A handoff is not authority (any cookie holder can create one). Authority is the tap, the device key and
a user-verified phone passkey over the envelope the signer built and showed. WebAuthn proves user verification, not a specific biometric method; platform passkey fallback is not a claim of Face ID-only enforcement.

### Approval packets

`POST /api/web-key/packets` (token). The creating session comes from the request context headers
`x-cos-provider` and `x-cos-session-id`, never the body (a body `provider`/`sessionId` is refused,
`session_from_context_only`). Packet object, `cos-web-packet/1`:
`{ v, packetId, action, artifact, version, digest, channel, provider, sessionId, createdAt, exp }`.
An `approve` envelope whose `provider`/`sessionId` differ from the packet's creator is refused
(`packet_session_mismatch`). The receiver MUST provide its locally reviewed full canonical packet through `--expect-packet-file`, plus `--expect-packet` and `--expect-digest`, and validate every exact scope/receiver field and expiry before one-shot consume. It recomputes the canonical preimage hash; hash plus digest alone is insufficient. Per-session identity is not separately authenticated (every agent holds the token). The packet is an untrusted request until the phone signs it.

Packet id is canonical base64url of 12 random bytes (`^[A-Za-z0-9_-]{16}$`). `createdAt` and `exp` are safe integer Unix milliseconds; `0 < exp-createdAt <= 1800000`. Shared exports are `WEB_APPROVAL_PACKET_MAX_LIFETIME_MS`, `WEB_APPROVAL_PACKET_ID_RE`, `parseWebApprovalPacket`. Golden canonical bytes and SHA-256 are in `shared/web-approval-packets.golden.json`.

`GET /api/web-key/packets?provider=<provider>&sessionId=<id>` uses the existing authenticated web/token gate and is absent when authority is off. It lists only enabled actions and the requested receiver. Sessions and Today's session sheet use one shared explicit picker. Default is message only; choosing a packet passes its exact hash to handoff. A stale selection refuses, without falling back to a message or a broader approval. The separate 3144 signer cannot list packets: its allowlist only permits claiming the one chosen handoff.

New publish channels have disjoint, mandatory artifact names and SHA-256 digests:

| Channel | Required artifact | Digest covers / consumer responsibility |
| --- | --- | --- |
| `gotcos-site` | `gotcos-site-manifest` | Exact canonical deployment manifest: source commit, build output digests and allowlisted gotcos.com deployment target. No mutable URL or wildcard. |
| `control-downloads` | `cos-control-downloads-manifest` | Exact ZIP/sidecar digests, immutable asset names, latest aliases and allowed release repository. |
| `release-docs` | `cos-release-docs-manifest` | Exact documentation file/path set and separate deployment target. If docs are part of the same website deployment, one site manifest lists those bytes; a separate docs approval does not approve the site. |

The server validates channel/artifact/digest grammar and packet binding. The deploying consumer MUST additionally validate the locally reviewed deployment manifest bytes and target allowlists before consume; this generic server does not inspect deployment manifest contents. No channel grants a blanket matched-release approval. npm's own passkey authentication remains separate from COS authorization.

## 5. Passkey assertion (B2), required for EVERY vouched turn

Header `x-cos-web-passkey`: b64url of the JCS of

```json
{ "v": "cos-web-passkey/1", "credentialId": "<b64url>", "authenticatorData": "<b64url>", "clientDataJSON": "<b64url>", "signature": "<DER sig b64url>" }
```

Checks (server and verifier, identically):
1. `credentialId == approval.passkey_credential_id`.
2. `clientDataJSON` parses as JSON; `type == "webauthn.get"`; `challenge == b64url(sha256(envelope JCS bytes))` exactly; `origin == envelope.origin` exactly (port included); `crossOrigin` absent or false.
3. `authenticatorData` at least 37 bytes; `authenticatorData[0:32] == sha256(utf8(rpId))`.
4. flags byte `authenticatorData[32]`: UP (`0x01`) AND UV (`0x04`) both set.
5. ECDSA P-256 / SHA-256 DER signature over `authenticatorData || sha256(clientDataJSON bytes)` verifies with `registryEntry.passkeySpki`, whose sha256 equals the anchored `approval.passkey_spki_sha256`.

No assertion, no vouch (`passkey_missing`, `passkey_invalid`, `passkey_origin_mismatch`, ...).

**The passkey is THE approval path (Miles, 2026-11-07).** The phone key plus a passkey with Face ID
on the 3144 signer page is the complete approval path for every user, including people with only a
phone and a Mac and no Even app. A confirmation from the COS glasses companion is optional, never
required, and not built. The seam stays: the server verifies the second factor in one module
(`server/lib/web-key-passkey.ts`), its proof travels as its own field beside the envelope (`passkey`
in the answer), and the phone assembles the proof in one module (`server/web-signer/signer-proof.js`
`assembleTurnProof`, whose signer is an interface). An optional companion signer would add a sibling
without changing the envelope, the anchor or this check. Nothing assumes one exists.

## 6. Turn answer: `GET /api/g2-turns/:turnId` for a web-key record (flag on)

Existing fields (`found, turnId, createdAt, originJudgedAt, ageMs, textSha256, origin, originKind,
verifiedOrigin, reason, sealed, target, via`) are unchanged. A web-key record adds:

```json
{
  "authority": "web-key",
  "kid": "<kid>",
  "aud": "<hex64>",
  "scope": { ... },
  "scopeMeaning": "conversation" | "approve",
  "notAuthorized": [ "<item>", ... ],
  "envelope": "<b64url JCS>", "signature": "<P1363 b64url>",
  "passkey": { "credentialId", "authenticatorData", "clientDataJSON", "signature" },
  "authId": "<hex64 = sha256(phone signature bytes)>",
  "wordsSha256": "<hex64, copied from the parsed envelope>",
  "registryEntry": { "kid", "spki", "passkeySpki", "kver", "label", "approval", "anchorSig", "revokedAt?" },
  "anchor": { "spkiSha256": "<hex64>", "fingerprint": "XXXX-...", "setAt": <ms>, "ageMs": <ms>, "mature": true },
  "epoch": <int>,
  "revoked": [ { "kid", "revokedAt" } ],
  "revocationDigest": "<hex64 = sha256(JCS(revoked sorted by kid))>",
  "integrity": { "enabled": true, "lastCheckOk": true, "checkedAt": <ms>, "manifestSha256": "<hex64>" | null },
  "integrityAtAccept": { same shape, frozen when the turn was accepted },
  "consumeKeys": [ "turn:<turnId>", "web:<aud>:<authId>" ]
}
```

`verifiedOrigin: true` only when, besides signature and registry state: the anchor is mature, the
integrity check is enabled AND its last check passed now and at accept, the passkey verifies, and
the record matches the envelope (B3): `record.turnId == envelope.turnId`,
`record.target.provider == envelope.provider`, `record.target.sessionId == envelope.sessionId`,
and every copied proof field (`kid, kver, epoch, iat, exp, provider, sessionId, wordsSha256, scope,
authId`) equals the envelope. Any difference: `reason: "record_envelope_mismatch"`.

**`textSha256` covers the delivered prompt (words plus files block), normalized.** For a web-key
turn the verifier must NOT use it: compare `sha256(signedWordsText(words))` of the words it received
(before the files block and footer) with `wordsSha256` decoded from the envelope bytes, and session,
provider and turn id with the ENVELOPE, never the record.

**Integrity (W1):** with the signer (Phase 3), `lastCheckOk` is true only when BOTH the Control Web tree
(`web-control/.manifest.json`) and the signer tree (`web-signer/.manifest.json`) match; `manifestSha256`
is still the Control Web manifest's (shape unchanged). `/api/web-key/status` reports the signer's own
check under `integrity.signer`. The verifier refuses unless `integrity.enabled`, `integrity.lastCheckOk`,
`integrityAtAccept.enabled` and `integrityAtAccept.lastCheckOk` are all `true`.

**Epoch and revocation (W5):** the server reads them from `web-keys.json`, which a same-user process
can roll back (remove a `revokedAt`, restore an older file). The server alone cannot see that. The
verifier compares `epoch` and `revocationDigest` with a Control-held source (Control's keychain
mirror) and refuses on difference; `approval.epoch` and `envelope.epoch` must equal Control's epoch.

**notAuthorized** (always includes the never-list):
`credentials`, `payment-details`, `moving-money`, `deleting-data`, `sending-messages`,
`security-or-permission-settings`, `harness-permission-prompts`, `authority-rule-changes`.
For `message` scope it also includes `install`, `publish`, `push-main`, `push-branch`, `hub-file`.
For `approve` scope it also includes every action other than the signed one, and
`other-artifact-version-digest-or-channel`.

**Attachments:** until `shared/turn-files-block.ts` exists, the verifier refuses any non-empty
`envelope.attachments`.

## 7. Consume

`POST /api/g2-turns/:turnId/consume` `{ "session", "provider" }` (token, flag on). Consumes
`consumeKeys` (`turn:<turnId>` and `web:<aud>:<authId>`) in ONE atomic write of
`web-key-nonces.json`; refuses `already_consumed` if either key exists. The verifier does not call
this route. Its own `.g2_turns_consumed.json` spends, in one locked write, the BARE turn id (the
same key the G2 path spends, so G2 and web share one namespace) plus `web:<aud>:<authId>`, and
requires `consumeKeys` to equal exactly `["turn:<turnId>", "web:<aud>:<authId>"]`. The `turn:`
prefix exists only in the server's store.

## 8. Reasons the server can give (web-key)

`web_key_authority_off, signature_missing, envelope_malformed, envelope_version_unknown,
scope_not_allowed, envelope_not_canonical, anchor_not_registered, anchor_unregistered,
anchor_too_new, aud_unavailable, aud_mismatch, origin_unavailable, origin_mismatch, key_unknown,
key_unanchored, key_revoked, key_epoch_stale, key_version_stale, epoch_stale, signature_invalid,
lifetime_invalid, iat_in_future, signature_expired, fork_destination_unbound, destination_unbound,
destination_mismatch, turn_id_mismatch, words_changed, words_trailing_whitespace, attachments_unsealable, attachments_changed,
packet_unknown, packet_mismatch, packet_session_mismatch, approve_action_not_enabled,
passkey_missing, passkey_malformed, passkey_credential_mismatch, passkey_type_invalid,
passkey_challenge_mismatch, passkey_origin_mismatch, passkey_rpid_mismatch, passkey_not_user_verified,
passkey_invalid, integrity_off, integrity_failed, record_envelope_mismatch, nonce_unknown,
nonce_spent, nonce_expired, nonce_store_unavailable, web_key_check_failed`.

Route refusals added in Phase 3 (HTTP answers, never turn reasons): `signer_origin_required`,
`origin_refused` (3144 listener), `handoff_unavailable`, `no_phone_key`, `unknown_binding`,
`binding_changed`, `attachments_not_signable`, `words_too_long`, `handoff_cap_reached`,
`handoff_unknown`, `handoff_expired`, `handoff_claimed`.

## Change log

- 2026-11-07 17:05 CST: first version (B1 anchor bootstrap, B2 signer origin 3144 and passkey per
  turn, B3 record-envelope match, B4 scope patterns and packet binding, W1 integrity, W3 SAS
  commit-reveal, W4 display inside approval bytes, W5 approval epoch and revocation digest, W6
  device allowlist and remote, W8 rotates). Field names `passkey_credential_id`,
  `passkey_spki_sha256`, `passkeySpki`, `integrity.lastCheckOk` follow the verifier lane's request.
- 2026-11-07 18:05 CST: words never end in whitespace (`words_trailing_whitespace`, verifier lane
  point 1, option a). Consume: the verifier spends the bare turn id plus `web:<aud>:<authId>`; the
  server's own store keeps the `turn:` prefix (verifier lane point 2). Added the second-signer note
  in section 5 (B2 step 2 is a later, separate plan). Drain re-check now also compares the parked
  file manifest with the signed one (`attachments_changed`).
- 2026-11-07 18:50 CST: Phase 3 signer. 3144 serves only the signer page (its own manifest) and an /api
  allowlist; the phone's key steps and the handoff claim answer only there (`signer_origin_required`).
  Added the 3143 to 3144 handoff (section 4). Integrity `lastCheckOk` now covers the signer tree too
  (shape unchanged). Section 5: the passkey with Face ID is the complete approval path for every user;
  the companion confirm is optional and never required (Miles). No envelope, passkey or answer field changed.
