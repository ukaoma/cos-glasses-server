<!-- Copy of operations/personal/wk41_2026/CONTRACT_glasses_pairing_2026-10-09.md in the COS repo, the single source of truth for server 6.67.0, glasses 6.10.621 and the Control pairing branch. Server notes on what the contract left open are at the end. -->

# Contract: glasses pairing (server 6.67.0, glasses 6.10.621, Control branch for Codex)

This is the single source of truth for the three builders. Design and reasons: `PLAN_glasses_onboarding_quick_connect_2026-10-08.md`, sections v2 and v4.

**Miles, 2026-10-09 07:23:** "We'll use the next version release as the canary. We'll start with Miles network, he should see the QR with the newer Activity setup view that contains the QR code for scanning."

**Scope of this release: pairing only.** Durability (Part C), approve-from-glasses (Part B) and the tour come in later releases.

## Capability
- `GET /api/health` adds `capabilities.pairing = { version: 1 }`.
- Clients check it before any pairing call. When it is missing, the phone says "Update COS on your Mac (server 6.67 or newer)" and Control shows "Update the server".

## Code and QR grammar (the server builds both, clients only parse)
- **Code:** 8 characters, Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`).
  - Normalize input: uppercase it, map O→0, I and L→1, and strip spaces and dashes.
  - Display it as `XXXX-XXXX`.
- **QR text:** `COS1/MAC/<CODE>/<host>:<port>[+<host>:<port>]/<EXP>`
  - All uppercase alphanumeric plus `/ : + .`, so the QR stays at version 3 or 4. (Changed from `,` after QA round 1: a comma is not in the QR alphanumeric set. The server writes `+`; clients accept `+` and `,`.)
  - `<EXP>` is the expiry, in unix seconds, written in base36 uppercase.
  - Hosts are IPv4 only, http. Tailscale (100.64.0.0/10) comes first; a LAN address (RFC1918) is included only while LAN pairing is armed.
  - `MAC` is the kind. `CLOUD` is reserved for later. Any other kind, or a version other than `COS1`, is refused with "Update COS to use this code".
  - Clients refuse hosts outside 100.64/10 and RFC1918.

## Server routes (6.67.0)
All under `/api/pairing`. Every response carries a `reason` string on failure. The reasons are:
`expired`, `used`, `locked`, `rate_limited`, `not_loopback`, `not_allowed_network`, `unknown_code`, `denied`, `draining`, `bad_request`.

| Route | Auth | Body or params | 200/202 response |
|---|---|---|---|
| `POST /pairing/code` | token **and** loopback socket (`req.socket.remoteAddress`, both forms; never `req.ip` or XFF) | `{ allowLan?: boolean }` (`allowLan` arms LAN claims for 10 minutes) | `{ code, display, qr, expiresAt, bootId, hosts:[{host,port,kind:'tailscale'|'lan'}], lanArmedUntil|null }`. A new code cancels the previous one and any pending claim. |
| `POST /pairing/claim` | **public**, an exact `POST` match in `isPublicApiRequest`, with its own JSON parser capped at 1 KB | `{ code, nonce }` (`nonce` is 16 to 64 characters from `[A-Za-z0-9_-]`, made by the phone) | 202 `{ pending: true }`. Idempotent for the same nonce and code. |
| `GET /pairing/claim/:nonce` | **public**, and the caller's socket IP must equal the claim's IP | | `{ state: 'pending'|'allowed'|'denied'|'expired'|'delivered', token?, serverName? }`. The token is returned **once** (the `allowed` state moves to `delivered`). A later read returns `delivered` with no token. |
| `GET /pairing/status` | token and loopback | | `{ code: {display, expiresAt}|null, pending: {nonce, ip, at}|null, lastClaim: {ip, at, allowed}|null, firstAuthAfterClaimAt|null, lanArmedUntil|null, bootId }` |
| `POST /pairing/decision` | token and loopback | `{ nonce, allow: boolean }` | `{ ok: true }` |

### Rules
- **Network:** a claim is accepted from 100.64/10. It is accepted from RFC1918 only while LAN is armed. Anything else gets `not_allowed_network`. This check sits on top of the existing network allowlist.
- **Code lifetime:** 5 minutes, single use (the first successful claim moves it to `used`).
- **Pending claims:** one at a time. A pending claim waits up to 60 s for a decision, then becomes `expired`. A second claim while one is pending is refused with `locked`, and that does not cancel the first.
- **Limits:**
  - 5 claim attempts per minute per socket IP, then `rate_limited`.
  - 20 attempts per code, then the code is `locked` until a new code is made.
  - The limiter keys on the socket IP. Trust-proxy is never enabled.
- **State:** in memory only. A restart loses codes, so a claim with an old code gets `unknown_code`, and `bootId` changes.
- **Drain:** the pairing routes are exempt from the mutation lease, since they write no files. When shutting down, `code`, `claim`, `status` and `decision` return 503 `draining`. The poll `GET /pairing/claim/:nonce` is still served (QA round 1), so a token already allowed reaches the phone even if the update gate closes before the next poll.
- **First authenticated call:** when a request passes `requireApiToken` and its socket IP equals an allowed `lastClaim.ip`, stamp `firstAuthAfterClaimAt` once.
- **Logging:** never the code, nonce, token or QR text. Log the IP, the result, and the first 2 characters of a sha256 of the code. A test must fail if any of those values appear in log output.
- **Docs:**
  - SECURITY.md: the pairing token is still the only standing credential; pairing codes are short-lived and single use.
  - `docs/pairing-contract.md`: a copy of this file.
  - Change the 401 copy to "Paste the pairing token from COS Control, or scan its code with COS Glasses 6.10.621 or newer." (QA round 1: older glasses show it word for word.) The `reason` value stays `pairing_token_rejected`.

## Glasses 6.10.621
- **Parser:** `src/lib/pair-code.ts` parses the QR grammar, normalizes codes and orders hosts. It is unit tested and exposed to the ES5 wizard as `window.__COS_PAIR`.
- **Scan entry points:**
  - the wizard Start screen (first option, "Scan code on your Mac")
  - `setup-step1` (the reauth path)
  - the Settings overlay
  - the local starter banner's Connect Mac
- **Ways in:**
  - **Scan:** `window._evenBridge.captureImageFromCamera()`
  - **Use a screenshot:** `pickImageFromAlbum()`
  - **Type the code:** the code plus the Mac address
  - Scan and screenshot are shown only when the bridge method is a function.
- **Decoding:** jsQR, decoding at the native width capped at 1920, then a second pass at 1280. A miss shows "Move closer so the code fills your screen".
- **Flow:**
  1. Check health on the first host that answers (try hosts in order, 3 s each).
  2. Make a nonce, then claim.
  3. Poll `GET /pairing/claim/:nonce` every 1.5 s for up to 70 s. The screen and the lens say "Waiting for Allow on your Mac".
  4. When the token arrives, write `cos_server_url = http://host:port` and `cos_api_token`, then run the existing `fetchAuthenticatedTarget`, then `finishConnectedSetup`, exactly as the IP form does.
  5. Keep the token in memory and retry if `/api/models` fails.
- **Re-pairing:** when a committed target already exists, ask "Replace <old host> with <host>?" first.
- **Lens lines:** "Pairing with your Mac…", "Waiting for Allow on your Mac", "Paired", "Code expired: show a new one", "Mac is updating". Each fits 6 lines and the width, using only drawable glyphs. isWearing is never used.
- **Manifest:** `camera` and `album` go in app.json **and** app-hub.json. Update `verify-timer-quarantine-build.mjs` and the `marketplace-hardening` pin. Strip URL-bearing comments from the jsQR bundle. Add a `THIRD_PARTY_NOTICES` entry.
- **Version touchpoints:** COS_VERSION, package.json, package-lock (both fields), CHANGELOG, the index.html changelog, app.json, app-hub.json, and the Hub receipt.

## Control (branch off `origin/codex/whisper-runtime` 601a944, released by Codex)
- **New helper verbs:**
  - `tailscale-status` runs the Tailscale bundle binary, `/Applications/Tailscale.app/Contents/MacOS/tailscale`, with **`SHLVL=1`** in the child's environment. It returns `{installed, running, selfIPv4, selfDNS, peers:[{os, dns, ipv4, online, sameUser}]}`, read from `status --json`. Use `Self.UserID` to work out `sameUser`; never use `HostName`.
  - `tailscale-whois <ip>` returns `{node, os, user}`.
  - `pairing-code [--allow-lan]`, `pairing-status` and `pairing-decision <nonce> allow|deny` call the server routes above over loopback with the token.
- **Setup guide, new "Glasses" section.** It is **not counted** in Finish setup, and it replaces `GlassesGuideRow`. It has three rows:
  1. **Tailscale on this Mac:**
     - not installed: Get Tailscale (https://tailscale.com/download/mac)
     - signed out: Open Tailscale
     - running: green, with the address
  2. **Tailscale on your iPhone:**
     - shows a QR for `https://apps.apple.com/app/tailscale/id1470499037`
     - copy: "Sign in with the same account as this Mac"
     - turns green when a same-user iOS peer is online, naming it ("iphone-15-pro-max is on your tailnet")
  3. **Connect your glasses:**
     - Shown only when `capabilities.pairing` is present.
     - The QR is drawn with CoreImage `CIQRCodeGenerator`, correction level Q, from the server's `qr` string, at least 220 pt. Show `display` and the first host as text, with the copy "Hold your phone so the code fills the screen".
     - Re-mint only while the pane is visible: when the code expires or `bootId` changes, and on **Show a new code**.
     - When `pending` appears, show the **Allow / Deny** card: "<whois node> (<user>) wants to pair". For a non-tailnet IP: "Device on Wi-Fi <ip>".
     - It turns green on `firstAuthAfterClaimAt`, showing "Paired: <node>, <time>".
     - "Allow pairing on this Wi-Fi (home only)" is a toggle (`--allow-lan`), off by default.
- **Plumbing:** add new Swift files to every `Tests/run.sh` source list. Every compile goes through `Tests/compile-guard.sh`, one at a time.
- **Reset pairing** (token rotation): **not in this release.** It ships with Part B.

## Server 6.67.0: what the contract left open, as built

- **Times** in JSON (`expiresAt`, `lanArmedUntil`, `at`, `firstAuthAfterClaimAt`) are ISO 8601 strings, or null. Only the QR `<EXP>` is base36 unix seconds.
- **No host:** when the Mac has no Tailscale IPv4 and LAN is not armed, `POST /pairing/code` still mints, with `hosts: []` and `qr: null`, so Control can say why instead of drawing a QR no phone can use.
- **Hosts:** at most 3, Tailscale first. LAN addresses come only from RFC1918 on interfaces a phone can reach (never `utun` VPNs that are not Tailscale, `bridge`, `awdl`, `llw`, `vmnet`, `vboxnet`).
- **allowLan:** `true` arms LAN for 10 minutes; a mint without it disarms LAN, so Control's toggle is the source of truth.
- **Failures** are `{ reason, message }`: 400 `bad_request`, 403 `not_loopback` / `not_allowed_network` / `denied`, 404 `unknown_code`, 409 `used` / `locked`, 410 `expired`, 429 `rate_limited` (with `Retry-After`), 503 `draining`.
- **Poll:** an unknown nonce (for example after a restart) is 404 `unknown_code`; a poll from a different socket IP is 403 `not_allowed_network` and does not spend the token. `serverName` comes with the token and with `delivered`. Only a real GET may read the token: a HEAD (which needs the token header to get past the gate at all) is answered 405.
- **Status:** `code` is present while the current code is unexpired and carries an extra `state: 'active'|'used'|'locked'`.
- **Decision** on a nonce that is not pending: 404 `unknown_code`, 410 `expired`, or 409 `used` (already decided).
- **Per-code limit:** every claim attempt while a code is active counts against it, right code or wrong; the 21st attempt locks it. Once a code is `used`, later attempts neither count nor lock it: the right code answers `locked` while its claim waits for Allow and `used` after, a wrong one `unknown_code`. Codes are compared in constant time.
- **firstAuthAfterClaimAt** is stamped only after the allowed claim's token was delivered, on the first token-authenticated request from that claim's IP. A new Allow clears it.
- **Draining** means the server is shutting down or the maintenance gate is closed (an update in progress, including the startup gate before Control releases it). The poll is never refused for draining.
- **Loopback** accepts any 127.0.0.0/8, `::1` and `::ffff:127.x` socket at the pairing check, but the server's global network allowlist (unchanged) admits only `127.0.0.1` and `::1` exactly, so another 127.x address is refused before pairing sees it.
- **QR alphabet:** hosts are joined with `+`, which is in the QR alphanumeric set (`0-9 A-Z space $ % * + - . / :`), so every QR the server writes can be encoded in alphanumeric mode.
- **Parity fixture:** `docs/pairing-fixture.json` holds the alphabet, nonce pattern, QR pattern and charset, normalization cases, two real `buildPairingQr` outputs (one and two hosts), the reason list with statuses and messages, the poll states and the limits. `server/lib/glasses-pairing.test.ts` recomputes every value, so it fails if the fixture drifts. Clients copy it; nobody edits it by hand.
