# Security

COS Glasses server runs on your own machine and holds your meeting transcripts,
so a flaw here is a flaw in your privacy, not ours. Reports are welcome and
taken seriously.

## Reporting

Open an issue at <https://github.com/ukaoma/cos-glasses-server/issues> titled
`security` with **no details in the body**. A maintainer will reply with a
private channel within two business days. Do not post the finding publicly
until a fixed version is on npm.

Please include the server version (`/api/health` → `server_version`), the
client (COS Glasses EHPK version or COS Control version), and the smallest
reproduction you have. Do not include real transcripts.

## What to expect

- Acknowledgement within two business days.
- A fix released as a patch version, with the finding described in
  `CHANGELOG.md` once a fixed version is on npm.
- Credit in the changelog if you want it. TJ's 2026-08 report on the display
  stream (fixed in 6.42.0 and hardened in 6.42.1) is the model.

## Scope notes

- The pairing token (`X-Cos-Token`) is the only credential. Rotating it
  invalidates every display-stream ticket; there is no server-side ticket store.
- Pairing codes (6.67.0, `docs/pairing-contract.md`) are not credentials. A code
  lives 5 minutes in memory, works once, is made only over loopback with the token,
  and releases the pairing token only after someone presses Allow on the Mac, and
  then only once, to the address that claimed it. Claims are accepted over Tailscale
  (100.64.0.0/10), or a private Wi-Fi address only while the user has allowed it for
  10 minutes. Limits: 5 claims a minute per connection address, 20 tries per code.
  Codes, nonces, tokens and QR text are never logged. The pairing token is still the
  only standing credential.
- A device on your tailnet can lock a live pairing code by guessing at it 20 times.
  This is accepted: COS Control says why and offers a new code, and a code already
  claimed is never locked by later guesses.
- While "Allow pairing on this Wi-Fi" is on, the pairing token reaches the phone over
  plain HTTP on that Wi-Fi, as the pasted token always has. Use it only at home; it
  turns itself off after 10 minutes. Over Tailscale the traffic is encrypted.
- Behind `tailscale serve` or `funnel`, requests arrive from a loopback proxy, so
  every claim is refused (`not_allowed_network`): pairing fails closed there.
- `GET /api/display-stream` is public by design and returns lifecycle events
  only. Content requires a ticket or the token header. See
  `server/routes/display.ts` for the allowlist.
