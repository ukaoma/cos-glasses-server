# Changelog

## 6.3.1

Security + robustness hardening on the 6.3.0 archive routes, from a 3-agent QA pass. (6.3.0 was never published; 6.3.1 is the first release of the expanded route set.)

- **SECURITY — path traversal blocked.** The new `:date` archive routes fed the param straight into `<dir>/${date}.json`, so an encoded traversal (`/api/archive/..%2F..%2Fetc%2Fhosts`) could read arbitrary `*.json` on the host (and rename-corrupt one via the quarantine path). Auth+IP gated, but a real exposure on a shared LAN/meshnet. Fixed: `archiveRouter.param('date', …)` enforces `^\d{4}-\d{2}-\d{2}$` on every `:date` route before any fs access; defense-in-depth guard in `readArchiveChatNumbered`. Verified: traversal/bad-format → 400, valid dates → 200.
- **Reference date label (US evenings).** Live-session `reference message N` stamped the date with UTC, labeling an evening reference with tomorrow's date. Now `localDay()`.
- **Malformed day file no longer wipes History.** A valid-JSON wrong-shape day file (no `chats[]`) 500'd the readers and dropped `listArchiveDates` into its catch, hiding all history. `loadArchive` coerces `chats` to `[]`; the bad day lists as 0 chats.
- **Thrift/cosmetic:** `/api/archive/now` passes `skipLLM:true` (no surprise LLM spend on a public manual snapshot); stale path comment + unused `__dirname` removed from `lib/archive.ts`.

## 6.3.0

Message History, cross-day references, and history recovery for public installs.
These features previously required a full COS server; now `npx @gotcos/glasses-server`
exposes them too, so the G2 app's Message History and "reference message N" work
on a vanilla install.

- **Message History** — the archive routes (`/api/archive`, `/api/archive/:date/chats`,
  `/api/archive/:date/chats/:i/messages`, `/api/archive/:date/messages`, `/api/archive/now`)
  are now served. The daily archive-mirror (already in this package) writes prior-day
  sessions to disk; these routes browse them. Each day row shows chat count + topic.
- **Cross-day "reference message N"** — new `/api/message/:num` resolves a permanent
  message number across live sessions then day archives (newest-first), and
  `/api/message-counter` publishes the numbering ceiling so a fresh/cleared client
  never reuses a number. Message numbers were already stored (`globalMsgNum`); this
  makes them resolvable.
- **History recovery** — session routes (`/api/sessions/today/all-messages`,
  `/api/sessions/:id/messages`, recent-sessions index, context-break, end-session)
  let the app restore recent history and open archived chats.

No change to the public-safe model curation (Sonnet default, no pinned/unreleased
model ids) or the core query/voice/display paths. Typecheck clean; new routes
smoke-tested (message-counter, archive list, message lookup).

## 6.2.1

Foolproofing release — driven by an adversarial onboarding QA pass.

- **The server now prints URLs the phone can actually use.** Boot output lists
  your real addresses (`http://100.x.x.x:3141` labeled Tailscale, LAN IPs labeled
  same-Wi-Fi) instead of only the un-pasteable bind address `0.0.0.0`.
- **Auto-generated API tokens survive restarts.** First boot saves the token to
  `~/.cos-glasses/.env`, so re-running the server no longer silently rotates the
  credential your app already saved (the "worked yesterday, 401 today" trap).
- **Starter-Kit COS inheritance is real now.** Run `npx @gotcos/glasses-server`
  from your COS folder and glasses chat loads its brain: the launcher records
  your launch directory, and when it contains `.cos/manifest.json`, `AGENTS.md`,
  or `CLAUDE.md`, Claude/Codex spawn there (explicit `COS_SCRIPTS_DIR` still wins).
- **Transfer-integrity report actually surfaces.** 6.2.0 recorded lost chunks but
  never returned them; the offline-session `finalize` response now includes
  `transferIntegrity` (received/expected/missing/completeness) and a gap-aware
  `transcript` with inline `[… audio gap …]` markers.
- **One default model everywhere: Sonnet.** The query router, the OpenAI-compat
  surface, and CLI pre-warm all default to Sonnet (was a mix of Opus and Haiku).
  Set `COS_G2_DEFAULT_MODEL` to override; per-query picks unchanged.

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
