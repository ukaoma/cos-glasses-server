# Changelog

## 6.2.0

Reliability release — ports the hardening the full COS Glasses app shipped in June.

- **Transfer integrity (lost-chunk detection).** The server now records every
  received chunk index. A chunk lost in transit surfaces as an inline
  `[… audio gap …]` marker in the gap-aware transcript instead of being
  silently stitched over. Gap state survives a mid-meeting server restart;
  legacy persisted sessions recover without false alarms. The Even Hub client
  (1.0.153+) already retries failed uploads durably — this is the server half.
- **Vocab-echo hallucination filter.** Whisper is seeded with your profile
  vocabulary; on silence/music it can echo those terms back as phantom words
  ("POS Nation. Thrift Cart.") the user never said. Bare-name echoes are now
  dropped session-aware (silence echo, back-to-back run, or exact repeat) on
  both the meeting and dictation paths. Real sentences that mention a term are
  never dropped; plain single-word terms (names, cities) never trigger it.
- **Name corrections on every path.** The `whisper_corrections` map now also
  applies to iPhone-ASR candidate text and the cloud fallback, not just local
  whisper.
- **SIGTERM parity.** Production stops (service managers, `kill`) now flush
  active session logs exactly like Ctrl-C did.
- **`COS_G2_DEFAULT_MODEL` fix.** The documented default-model switch now
  applies on the primary query path, not only the OpenAI-compat surface.

## 6.1.0

- **Codex backend.** Chat now routes to your local **Codex CLI** (`codex-high`) in
  addition to Claude Code — pick either per query, or set `COS_G2_DEFAULT_MODEL`.
- The Codex model is **not** hardcoded — it uses your codex CLI's own default model
  unless you pin one with `COS_CODEX_MODEL` (+ optional `COS_CODEX_REASONING_EFFORT`).
- Codex run/session state persists under `~/.cos-glasses/data`.

## 6.0.0

The server now ships **inside** this package — `npx @gotcos/glasses-server` runs
it directly, with no second repository to clone.

- **Bundled server.** Previous versions cloned a separate app repo at runtime;
  the standalone server is now part of the package tarball.
- **Standalone-first.** Glasses + your local Claude Code CLI. No API key is
  pasted into the phone for chat.
- **Local voice.** Transcription runs on whisper.cpp (free); OpenAI API is an
  optional fallback.
- **Phone reachability.** Defaults `BIND_HOST=0.0.0.0` so the glasses' phone app
  can reach the server over your mesh/LAN. The IP allowlist blocks public traffic.
- **Persistent config** at `~/.cos-glasses/.env`.
- Requires Node.js 20.11+.
