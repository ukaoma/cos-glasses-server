# Changelog

## 6.12.7

Pairs the public server with COS Glasses build 227+ meeting follow-ups while
preserving every existing meeting response field and legacy client contract.

- **Meeting follow-ups receive canonical source context.** Authenticated
  meeting-detail responses now add `sourceContent` and `sourceTruncated`, so
  the glasses can attach the actual meeting record before a follow-up query.
- **Bounded and UTF-8 safe.** Source context is capped at 100 KB without
  splitting a multibyte character. Existing summary and transcript fields are
  unchanged.
- **Backward compatible.** Older clients ignore the additive fields; newer
  clients no longer display the server-update warning on public installs.

## 6.12.6

Pairs with COS Glasses build 222 to harden local-first meeting recovery and
local Whisper supervision while preserving the existing public API surface.

- **Meeting work stays on its admitting Mac.** Capability-aware clients pin
  upload, status, and save requests to one `serverInstanceId`; a mismatch fails
  before audio is consumed. Legacy unpinned clients continue to work.
- **Receipt is not transcription.** Durable ledgers distinguish raw audio
  receipt, completed ASR, and canonical transcript text. Silent chunks persist
  as terminal empty completions, so replay does not rerun ASR or invent text.
- **Whisper recovery is single-owner.** Concurrent start/restart requests are
  serialized and coalesced. COS reaps only a process tree proven to own the
  configured model and port 8178, verifies the port is clear, and launches one
  replacement. An unrelated Whisper process is never killed; uncertain
  ownership fails closed.
- **Backward compatible.** Existing query, prompt recovery, media, display,
  diagnostics, transcription, and legacy meeting contracts retain their prior
  behavior. The new capability flags are additive.

## 6.12.5

Extends the file-permission hardening to the remaining append-only logs that
the launch review named.

- **Run ledgers and the token-audit log are private at the file level.** The
  Claude and Codex run ledgers and the token-audit JSONL now create with mode
  0600 and repair existing files with chmod, matching the session-log and
  atomic-fs writers. They already sat under the 0700 data directory; this
  closes the file-level bit for defense in depth and covers the token-audit log
  specifically, which lives beside the data directory rather than inside it.

## 6.12.4

Completes the public launch security review with a constant-time token check.

- **API tokens compare in constant time.** The `/api` middleware and the
  OpenAI-compatible `/v1/chat/completions` Bearer check no longer use a plain
  `!==` string compare, which short-circuits on the first differing byte and
  leaks token bytes through response timing. Both now hash each side to a fixed
  SHA-256 digest and compare with `crypto.timingSafeEqual`. Missing headers,
  duplicated headers, and length-mismatched tokens fail closed without throwing.
  A new `token-auth` test pins the behavior. 401 responses are otherwise
  unchanged.

## 6.12.3

Security hardening from the public launch review, without changing app/server
wire contracts.

- **Stored prompts never enter a shell command.** Archive title generation now
  launches Claude with an argument array and sends user content over stdin. A
  regression test proves command substitutions and backticks remain inert.
- **Claude can run in a real allowlist mode.** Existing installs retain trusted
  mode for backward compatibility. Setting `COS_CLAUDE_TRUST_MODE=allowlist`
  removes the permission bypass, restricts Claude to COS's explicit per-query
  tools, and denies undeclared tools without an interactive prompt.
- **Tailscale matching is exact.** Network and CORS policy now accept only the
  assigned `100.64.0.0/10` CGNAT range rather than every `100.x` address.
  Localhost and RFC1918 LAN access remain unchanged.
- **Durable local state is private.** Runtime data and archive directories are
  repaired to `0700`; atomic state, conversation archives, session logs, and
  the saved OpenAI key are created or repaired to `0600`. Credential writes use
  private, exclusive, fsync-backed atomic publication.
- **Telegram export requires consent.** Merely finding a private
  `.telegram_config.json` no longer enables activity export. Operators must set
  the exact `COS_TELEGRAM_NOTIFICATIONS=1` opt-in.
- **Canonical history remains exact.** Operational previews and provider
  ledgers keep their existing redaction, while durable prompts/answers are not
  silently mutated; recovery, retries, and `reference message N` remain intact.
- **Backward compatible.** Query, prompt recovery, meetings, media, display,
  diagnostics, transcription, and protocol response shapes are unchanged.

## 6.12.2

First-install hardening for public `npx` users.

- **No nested install inside npm's cache.** The launcher resolves the declared
  `tsx` dependency from npm's existing `npx` dependency tree and never runs a
  second `npm install` from the ephemeral package directory.
- **Permission failures do not spread.** A broken or incomplete package fails
  closed with a user-owned isolated-cache recovery command. COS never suggests
  `sudo npm`, broad ownership changes, or writing through a root-owned cache.
- **Claude Desktop is no longer mistaken for Claude Code.** First-run guidance
  explicitly requires the terminal CLI, keeps the scoped npm command on one
  copyable line, forbids `sudo`, and explains the interactive sign-in step.
- **Known signed-out agents fail before startup.** Installed Claude/Codex
  binaries are checked before first-query readiness. Older CLI versions whose
  authentication state cannot be proven show a warning instead of a false
  signed-in claim.
- **Local credentials are private.** `~/.cos-glasses` is repaired to `0700`;
  the token and profile files are repaired to `0600`; symlinked credential
  paths fail closed; auto-generated tokens are persisted with an atomic write.
- **Runtime behavior is unchanged.** Query, prompt recovery, meetings, media,
  diagnostics, transcription, display, and server data contracts are untouched.

## 6.12.1

Public-safe CLI diagnostics for the COS Glasses Recovery Center.

- **Both local agents are visible.** Authenticated clients can inspect a
  versioned Claude Code and Codex status summary at `/api/cli/debug`, including
  provider support, persistence readiness, workspace configuration, and the
  latest run's safe status metadata.
- **False success is fenced.** Claude Code or Codex output that reports a
  machine-shaped authentication failure while the CLI exits `0` is finalized
  as a typed `auth_error`, never projected as a completed assistant reply.
- **Build 210 stays compatible.** Sanitized `/api/cli/runs` and
  `/api/codex/runs` projections preserve the fields older Recovery Centers can
  render while newer clients adopt the combined contract.
- **Diagnostics do not become an exfiltration path.** Responses use explicit
  allowlists and omit commands, filesystem paths, trust modes, prompts,
  answers, tool payloads, content previews, raw run/session/thread IDs,
  resumable handles, environment values, and tokens. Legacy display IDs are
  omitted and workspace state is a fixed label only.
- **Authentication is mandatory.** All three diagnostic routes remain behind
  the existing `/api` token boundary. Preview-enabled ledger fixtures are
  covered by recursive forbidden-field and private-value tests.
- **Unauthenticated health is capability-only.** `/api/health` and
  `/api/models` advertise `capabilities.cliDebug`; health exposes only a CLI
  session-availability boolean rather than the resumable session ID.
- **Backward compatible.** Query, prompt, meeting, media, display, model, and
  recovery behavior is unchanged. Older clients and servers continue to use
  their existing paths; a missing CLI Debug capability remains an unsupported
  feature rather than a connection failure.

## 6.12.0

Local-first transcription policy and capability-safe recovery diagnostics for
COS Glasses build 210+.

- **Local means local.** Prompt, one-shot, and meeting transcription now remain
  on local Whisper by default. Finding an OpenAI key is not permission to upload
  audio. Cloud Whisper is reachable only when the exact
  `COS_OPENAI_WHISPER_FALLBACK=1` opt-in and a resolved key are both present.
- **Every cloud chokepoint is fenced.** Both one-shot/prompt finalization and
  continuous meeting transcription recheck the policy immediately before any
  OpenAI request, preventing a future call-site regression from bypassing the
  top-level selection logic.
- **Failure stays recoverable.** A local ASR outage returns a typed retryable
  `503` instead of silently switching providers. Durable prompt chunks and raw
  meeting audio remain available for retry; meeting receipt and batch-audio
  retention behavior is unchanged.
- **Clients can tell policy from health.** `/api/health` and `/api/models`
  publish additive `capabilities.transcription` fields. Public installs also
  advertise every privileged recovery control as unsupported, allowing newer
  phone Recovery Centers to hide controls instead of reporting false outages.
- **Backward compatible.** Existing routes and response fields remain in place.
  Older apps keep their current query, prompt, meeting, image, and display
  paths; cloud fallback remains available to operators who explicitly enable it.

## 6.11.0

Local-first meeting recovery for COS Glasses build 209+.

- **Record through network loss.** The server advertises a versioned
  `localFirstMeetings` capability with its stable instance ID. Compatible
  clients can keep audio locally, reconnect to the same server, and reconcile
  the exact sparse set of chunks it durably received.
- **Durable means acknowledged.** Raw meeting WAVs and the received-index
  ledger are committed atomically before a chunk receives success. Storage
  failures return typed retryable errors; capacity exhaustion returns `507`
  instead of silently discarding audio.
- **Long meetings stay alive.** Active-session retention is measured from the
  last durable activity, not the meeting start time, so recordings longer than
  four hours are not mistaken for abandoned sessions.
- **Safe reconnect and close.** Authenticated session-status responses expose
  exact compressed receive ranges, retention, and closed/saved state. Durable
  tombstones prevent a late or replaying client from recreating a completed
  meeting after a restart.
- **Idempotent finalization.** Repeating `POST /api/meeting/save` for an already
  saved session returns the original versioned receipt and filename without
  creating a second meeting.
- **Backward compatible.** Existing live transcription, meeting save, prompt
  recovery, durable queries, and older clients retain their prior routes and
  fields. The new capability, receipt fields, and status route are additive.

## 6.10.0

Opt-in server-owned durable query jobs for COS Glasses build 204+.

- **Accepted means durable.** With `COS_DURABLE_QUERY_JOBS=1`, the server
  appends and fsyncs an immutable job before returning 202. Provider execution
  is no longer owned by the phone's current request, WebView, or SSE subscriber.
- **Reconnect without duplication.** The client can recover an ambiguous
  admission by its stable client job ID, replay ordered bounded events, and
  acknowledge one terminal projection idempotently after message, queue,
  counter, and session state are durable on the phone.
- **Crash and cancellation fences.** Provider ownership is persisted before
  input, session-scoped leases prevent overlapping orphan continuations after a
  restart, cancellation is durable, and answer-ready ownership gates
  conversation, image, notification, and Done side effects.
- **Private bounded storage.** The append-only journal uses private directory
  and file modes, repairs torn tails, bounds progress/activity payloads, and
  retains terminal jobs for exactly seven days.
- **Safe rollout and rollback.** The health capability advertises exact protocol
  version 1 only when configured and the store is ready. Removing the flag
  blocks new durable admissions but leaves GET/events/cancel/ack available so
  accepted jobs drain; legacy queries, first turns, handoffs, and older clients
  remain unchanged.

## 6.9.0

Live recoverable prompt transcription for COS Glasses builds 200+.

- **Words appear while speaking.** After each audio chunk is durably acknowledged,
  its sanitized fast/local transcript is published on the existing authenticated,
  replayable display stream as `prompt_transcript`; the phone/G2 client can fill
  the Listening body without adding another recorder, polling loop, or ASR job.
- **Recovery remains authoritative.** The event is optional presentation state.
  Stored WAV chunks, final HQ transcription, glossary cleanup, editing, retry,
  and send behavior remain unchanged and continue even if no display client is
  connected.
- **Stale retries cannot repaint.** The server rechecks the exact draft, chunk
  index, and audio bytes after warm transcription. Replaced audio never emits
  its obsolete words, while client-side draft scoping, ordering, and replay
  deduplication handle reconnects safely.
- **Public boundary retained.** This release adds no private COS paths, personal
  data, LaunchAgent controls, remote restart authority, or machine-management
  endpoints.

## 6.8.0

Public-safe meeting finalization for COS Glasses build 199.

- **Authenticated meeting save.** `POST /api/meeting/save` finalizes an existing
  `transcribe-stream` session without adding coaching, private classification,
  personal paths, or COS-only enrichment to the public package. Lost-chunk gaps,
  original client timing, provider evidence, and sparse raw-audio indices remain
  intact through deferred iPhone replay and save.
- **Durable standalone archive.** Canonical markdown and structured sidecars are
  published atomically under `dataPath('recordings', 'YYYY-MM')`. Directories are
  `0700`, files are `0600`, filenames are path-safe and session-unique, and an
  fsync-backed sidecar-first/markdown-last commit keeps incomplete pairs hidden.
- **Review on the current client.** Authenticated `GET /api/meetings`, literal
  `GET /api/meetings/detail`, and the build199-compatible dynamic detail route
  list and read standalone recordings after process/package restarts. Traversal,
  unsafe filenames, symlinked roots/months/files, absolute-path disclosure, and
  cross-domain detail mismatches fail closed.
- **Transcript-quality bouncer.** Post-meeting batch text must preserve at least
  50% live coverage, provide independent evidence when no live baseline exists,
  and avoid repeated long segments/sentences/prefixes. Mixed timestamp coverage
  falls back to complete batch text instead of dropping text-only segments.
- **Recovery evidence wins.** Canonical streaming text remains untouched when a
  batch is rejected or cannot be applied. Pending WAVs are deleted only after
  accepted text and its sidecar decision are both durable; every other outcome
  retains audio for bounded two-hour cleanup. HQ batch decoders serialize and
  refresh their cleanup lease while queued or active.
- **Capability detection.** `/api/health` now advertises
  `features.meetingFinalization` for compatible clients.

## 6.7.0

Durable prompt recovery and self-healing local transcription for COS Glasses
builds 190–191.

- **Audio is durable before transcription.** Prompt chunks are acknowledged only
  after atomic storage under `~/.cos-glasses/data/prompt-drafts`, survive server
  and package restarts for 72 hours, and can be finalized or retried by draft ID.
- **Live warm transcription.** Each saved chunk is transcribed locally while the
  user continues speaking. Finalization reuses matching-quality cached work or
  independently produces the requested final quality.
- **No-key preservation.** Warm transcription never requires an OpenAI key. If
  every backend is unavailable, the API returns a typed retryable `503` and keeps
  the acknowledged audio instead of losing the recording behind a generic 500.
- **Whisper self-recovery.** A single inference timeout no longer leaves the
  in-memory availability flag permanently false. The next chunk performs one
  bounded, single-flight health reconciliation; successful inference closes the
  circuit, while repeated inference failures retain the controlled restart path.
- **Private-by-default storage.** Draft directories are `0700`, audio and metadata
  are `0600`, metadata updates are atomic, corrupt metadata is quarantined, and
  per-chunk/per-draft limits prevent unbounded disk growth.
- **Public boundary retained.** The npm package includes only generic prompt
  recovery and text cleanup. It does not add private COS day-context, personal
  paths, LaunchAgent controls, or remote machine restart authority.

## 6.6.0

Reconnect compatibility for COS Glasses build 188, without importing private
COS day-context or Mac service-control behavior into the public package.

- **Stable logical server identity.** The server creates one atomic UUID under
  `~/.cos-glasses/server-instance-id`, preserves it across process and network
  restarts, and returns it from authenticated `/api/models` probes. Files are
  mode `0600`; identity is minted only after every required listener binds.
- **Boot-scoped display cursors.** Display events receive one publish-owned ID
  before fan-out, so multiple subscribers see the same cursor and cannot
  duplicate replay records. Each process boot has a distinct UUID.
- **Deterministic reconnect handshake.** `/api/display-stream` emits `ready`
  before application events, accepts boot/event cursors, replays the last 200
  publish-owned events, and reports typed `boot_changed`, `cursor_ahead`, or
  `buffer_overflow` gaps so clients reconcile durable history instead of
  guessing or silently dropping replies.
- **Privacy boundary preserved.** Authenticated query activity remains off the
  unauthenticated global display bus. The npm server does not include private
  daily evidence exports, personal COS paths, launchd ownership, or remote
  machine-restart controls.
- **Backward compatible.** Older clients can continue opening the same SSE
  endpoint and ignoring the additive `ready`, cursor metadata, and replay-gap
  events.

## 6.5.0

Durable phone photos and assistant-selected output images for COS Glasses
build 179, while preserving the public server's sandbox and privacy boundary.

- **One media contract.** Authenticated phone uploads become opaque attachment
  refs, survive queues/restarts/archives/numbered-message recall, and resolve to
  normalized server-owned files for Claude/Codex. Bytes and storage paths never
  enter SSE, run ledgers, or archives.
- **Answer images.** Claude or Codex can publish an already-local generated,
  researched, or explicitly used email image through a private run-scoped
  capability. The server accepts JPEG/PNG/WebP/HEIC/HEIF/AVIF up to 16 MiB and
  16 megapixels, strips metadata, re-encodes through the existing media store,
  and appends refs to the completed answer.
- **No mailbox or URL crawler.** The publisher rejects URLs, data URIs, base64,
  unrelated discovery, symlinks, directory replacement, content-id tampering,
  over-capacity output, and manifest fields that could carry private paths.
- **Codex remains read-only.** Output publishing adds only the random private
  run directory via `codex exec --add-dir`; global sandbox flags precede
  `resume`. Older CLIs without `--add-dir` keep chat working and simply disable
  Codex output-image publishing. There is no full-access fallback.
- **Durable finalization.** Assistant text is persisted before image
  normalization, request media associates even if SSE disconnects, partial
  image failures do not discard successful refs, and completion emits one
  canonical `attachments` list with safe aggregate stats.
- **Lens contract.** `/api/health` advertises `mediaProcessingReady` and
  `g2LensVariant=png-288x144-v1`; the media endpoint serves the validated phone,
  thumbnail, and exact 288×144 G2 variants expected by build 179.
- **Fresh-install diagnostics.** The npm launcher now reports whether ffmpeg is
  ready for phone/output/lens images, gives a non-blocking install command when
  absent, and sends setup questions directly to `gotcos.com/wizard/`.
- **One server owner.** The public runner now claims the same atomic
  machine-wide lock as the installed LaunchAgent before mutable modules load.
  A duplicate exits with code 75, and HTTP/HTTPS listeners bind as one required
  set: if either port is occupied, any earlier listener closes and the process
  exits instead of surviving half-bound with separate SSE and media state.

Release evidence: TypeScript, 130/130 tests across 23 files, package dry-run
including the executable publisher and startup hardening, and a live duplicate
start against the installed LaunchAgent rejected before server initialization.

## 6.4.0

Fresh-install parity for COS Glasses builds 170–173, without weakening the
public server's sandbox defaults.

- **Auto-updating GPT Frontier + Balanced.** Stable client slots resolve to the
  top two capable models in the newest visible GPT generation through Codex's
  official `model/list` catalog. The server refreshes at boot and every 15
  minutes, and each Codex run awaits the same TTL-cached/coalesced refresh
  before resolving its slot. It preserves the last-known-good catalog on
  failures and falls back to the CLI default only before any discovery succeeds.
- **Fable + effort controls.** Fable joins Opus and Sonnet as a first-class
  Claude tier alias, and High / Extra High / Max / Ultracode now propagate from
  `/api/query` to both Claude and Codex. Claude aliases remain versionless and
  1M-context capable; Codex effort is clamped to each live model's advertised
  support. Per-run ledgers record the concrete resolved model and effort.
- **Safe live job activity.** `activityToolMode` supports off, status-only, or
  bounded observable tool input/output previews. ANSI/control data, credential
  assignments, auth headers, provider tokens, JWTs, URL credentials, and opaque
  blobs are redacted, including 40–72-character PEM/private-key body chunks.
  Hidden reasoning is never surfaced.
- **Same-session run safety.** Turns for one conversation now serialize until
  the active bridge sends a terminal callback, while different sessions remain
  concurrent. Failed or cancelled Claude/Codex runs remove the exact pending
  user exchange by object identity, preventing phantom prompts, duplicate-text
  deletion, and resume-history contamination.
- **Authenticated transport boundary.** Activity lines are returned only on the
  authenticated `/api/query` SSE stream. They are deliberately excluded from
  the unauthenticated global display bus and its replay buffer.
- **Public trust model retained.** Codex remains read-only by default with only
  the existing `workspace-write` opt-in. Existing archive traversal, local-day,
  malformed-file, starter-kit launch-directory, and conversation behavior are
  unchanged. Legacy `codex-high` state migrates to the frontier slot without
  changing saved thread trust mode.
- **Diagnostics and compatibility.** `/api/models`, health data, and `/v1/models`
  expose stable slots plus concrete live models. `cos-codex-high` remains an
  accepted alias for older clients. Existing `COS_CODEX_MODEL` and
  `COS_CODEX_REASONING_EFFORT` overrides continue to apply to the migrated
  legacy/frontier slot; leave them unset for auto-latest. A new regression suite covers catalog
  selection/fallback/refresh, sandbox arguments, migrations, effort mappings,
  activity redaction, and the display-bus security boundary.

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
# 6.13.0

- Added a non-interactive managed-server entrypoint for the COS Control macOS app.
- Added authenticated maintenance status and guarded local Whisper restart contracts.
- Added `--prepare-only` to the existing guided launcher so first-run dependencies can be prepared without leaving a second server process running.
- Added a provider-neutral managed work-folder setting while preserving the existing interactive launch-directory behavior.
- Kept the existing `npx @gotcos/glasses-server` foreground workflow fully compatible.
