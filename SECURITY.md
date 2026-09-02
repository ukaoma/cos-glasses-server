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
- `GET /api/display-stream` is public by design and returns lifecycle events
  only. Content requires a ticket or the token header. See
  `server/routes/display.ts` for the allowlist.
