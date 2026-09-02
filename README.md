# COS Glasses Server

Self-hosted AI heads-up display for **Even G2 smart glasses**. Runs on your Mac,
talks to your local **Claude Code, Codex, or Cursor Agent** CLI, and pushes answers, voice
transcription, and notes to the lens. Your data never leaves your machine, and no
API key is pasted into the phone for chat.

## Quick start

```bash
npx --yes @gotcos/glasses-server@latest
```

For the optional COS Control macOS menu bar app, run the same non-mutating
readiness check it uses before guided installation:

```bash
npx --yes @gotcos/glasses-server@latest --prepare-only
```

COS Control then installs the same npm package as a launchd-managed runtime.
The original foreground command remains supported and unchanged.

Normal server start checks Node, finds your CLI, checks voice and image
processing, writes `~/.cos-glasses/.env`, and starts the server on
`0.0.0.0:3141`. Optional Whisper and Kokoro models are provisioned when their
local services start; `--prepare-only` intentionally does not download or
install optional models, write COS configuration, or start a listener. It may
invoke an installed agent CLI's read-only version/auth probe, and that CLI may
maintain its own user cache. On boot the server prints
an **API token** — paste that into the COS Glasses app. Only one COS Glasses
server may run on a Mac at a time; a second `npx` or source runner exits before
opening ports or touching shared conversation/media state. Version 6.6.0 also
gives that server a durable identity and boot-scoped display replay, allowing
build 188+ to reconnect after a Tailscale, Wi-Fi, or process interruption
without silently losing completed replies.

## Requirements

- **Node.js 20.11+** — https://nodejs.org
- **Claude Code CLI** (Opus/Fable/Sonnet). Claude Desktop alone does not install
  the terminal command. Install it on one line with
  `npm install -g @anthropic-ai/claude-code` (**never with `sudo`**), then run
  `claude` and finish the browser sign-in
  _or_ **Codex CLI** (GPT Frontier/Balanced) — https://developers.openai.com/codex/, then `codex login`
- _Optional:_ **Cursor Agent CLI** for Composer 2.5 Fast and the newest Grok high-fast.
  Ensure `agent` is on `PATH`, run `agent login`, and verify `agent models`
  lists `composer-2.5-fast` and a `cursor-grok-*-high-fast` id. COS maps
  `cursor-grok` to the newest high-fast it finds; it never silently substitutes
  Claude or Codex.
- **Even G2 glasses** + the **COS Glasses** app from the Even Hub
- `brew install whisper-cpp` for free local voice (the launcher can download the model)
- _Optional:_ `brew install python@3.12 ffmpeg poppler espeak-ng` for local Kokoro
  spoken replies on Apple silicon (Python 3.11-3.12 is supported). `ffmpeg`
  also enables photo/video attachments; `poppler` enables PDF text and page
  previews. TXT, Markdown, CSV, and JSON attachments need no extra tool. Text
  chat remains available without these optional dependencies.
- _Optional:_ **Tailscale** so your phone reaches your Mac from anywhere

> No provider API key is needed for chat when using signed-in CLIs. Usage is
> billed to the corresponding Claude, Codex, or Cursor subscription. Pick a
> provider per query, or set a default with `COS_G2_DEFAULT_MODEL`
> (`opus`|`fable`|`sonnet`|`codex-frontier`|`codex-balanced`|`cursor-grok`|`cursor-composer`|`ollama`).
> Claude tier aliases and the two GPT slots resolve dynamically, so new model
> releases do not require a new glasses package. GPT discovery refreshes every
> 15 minutes and retains its last-known-good catalog through transient failures.
> Cursor discovery also refreshes every 15 minutes and retains its last-known-good
> catalog through transient failures.
> Cursor **Agent** mode can edit files and run shell commands in the selected
> workspace. Choose **Ask** mode when you want a non-editing answer; clients that
> omit the execution mode default to Ask.
> Existing `COS_CODEX_MODEL` / `COS_CODEX_REASONING_EFFORT` settings remain
> supported on the migrated Frontier slot; leave them blank for auto-latest.
> Codex runs **sandboxed read-only** by default. Set
> `COS_CODEX_SANDBOX=workspace-write` for workdir writes + outbound network
> (`sandbox_workspace_write.network_access=true` is passed by the managed server
> and should also be set in `~/.codex/config.toml` for interactive Codex).
> Local Ollama is a **fourth picker**, shown only when `ollama serve` answers
> `GET http://127.0.0.1:11434/api/tags` with a pulled model. Direct
> `POST /api/chat` — not Codex `--oss`. Optional pin: `COS_OLLAMA_MODEL`.
> `COS_CODEX_EXTRA_ARGS` is a Codex CLI hatch, not the Ollama UX. See Configuration.
> **Claude is the most permissive provider by default.** It runs with
> `--dangerously-skip-permissions`, so a glasses query on the Claude/Opus path can
> run shell commands and read, edit, and write files on this Mac without prompting
> you. That is what makes the glasses useful for real work, and it has been the
> behavior for some time — but as of 6.18.3 the model is also correctly *told* it
> has those tools, so you will see it use them more readily than before.
> Set `COS_CLAUDE_TRUST_MODE=allowlist` to remove Claude's permission bypass
> and restrict it to COS's explicit per-query tool allowlist; undeclared tools
> then fail closed without prompting. In allowlist mode the query keeps web
> search/fetch and **read-only workspace access** (Read, Glob, Grep) — no
> shell, no edits, no writes. Only the exact value `allowlist` restricts
> anything — any other value logs a warning and stays trusted. Servers before
> 6.41.0 denied ALL workspace reads in allowlist mode; if a hardened install
> answers "I don't have access to your workspace files", update the server.

## Connect your phone (the one gotcha)

The glasses app runs on your iPhone and must reach this server on your Mac.

1. The launcher binds `0.0.0.0` (all interfaces) for you.
2. **Same WiFi (simplest):** find your Mac's LAN IP (System Settings > Wi-Fi > Details), and in the COS Glasses app enter `http://192.168.x.x:3141`.
3. **From anywhere:** install **Tailscale** on the Mac + iPhone (same account), note the Mac's `100.x` address, and enter `http://100.x.x.x:3141`.
4. Either way, paste the **API token** the server printed at boot.

To restrict the server to localhost only, set `BIND_HOST=127.0.0.1` in `~/.cos-glasses/.env`.
The built-in IP allowlist blocks public-internet traffic regardless. Its mesh
range is the exact Tailscale/CGNAT allocation (`100.64.0.0/10`), not all of
`100.0.0.0/8`; RFC1918 LAN ranges remain supported.

## What it does

- Ask anything, get a streamed answer on the lens (`/api/query`, `/v1/chat/completions`)
- With COS Glasses build 204+, server-owned durable queries are on by default:
  accepted work survives phone backgrounding,
  WebView reloads, and network handoffs, then reattaches without duplicate work
  or duplicate replies
- Choose Opus, Fable, Sonnet, GPT Frontier, GPT Balanced, Composer 2.5 Fast, or
  the newest Grok high-fast. Cursor slots fail closed when the local CLI or concrete model
  is unavailable; optional redacted tool activity streams only to the
  authenticated query that requested it
- Message History + cross-day "reference message N" — your chats are archived by day
  and every message keeps a permanent number you can recall (`/api/archive`, `/api/message/:num`)
- Recent/history responses preserve validated photo references. Recovery uses
  exact session + global-message + message-era identity without exposing storage
  paths. Ambiguous pre-version historical refs fail closed; unversioned refs are
  recovered only inside the active era when created and associated after its boundary.
- Send phone photos with queued prompts, and review assistant-selected generated,
  research, or explicitly used email images in Messages and on the G2 lens
- Recover long voice prompts after phone, network, or server interruptions. Audio
  chunks are saved before transcription and retained locally for 72 hours. On
  compatible app builds, their warm transcript also appears live while speaking;
  final HQ transcription remains authoritative.
- Live voice capture + transcription during meetings
- With COS Glasses build 209+ and server 6.11.0+, meetings continue recording
  locally through a network interruption. Reconnecting reconciles the exact
  chunks already stored by the Mac, uploads only missing audio, and finalizes
  through an idempotent save receipt without duplicating the meeting.
- Since 6.19.0, meeting audio whose save never lands is quarantined for 72 hours
  (`COS_UNSAVED_AUDIO_RETENTION_HOURS`) instead of being cleaned up, surfaces on
  `/api/health` as `unsaved_captures`, and can be recovered into a durable
  meeting scribe with one authenticated call
  (`POST /api/meeting/orphans/:sessionId/recover`; list via
  `GET /api/meeting/orphans`).
- Local whisper.cpp transcription (free and local-only by default). OpenAI
  Whisper fallback is optional and requires both the exact
  `COS_OPENAI_WHISPER_FALLBACK=1` opt-in and a configured key; a key alone never
  uploads audio.
- HQ prompt dictation is requested by default; the phone's **Fast mode** switch
  opts into turbo. Server 6.16.0 reports whether full local large-v3 actually
  ran, and compatible companions alert once if an HQ request used Fast or
  Cloud instead of silently claiming HQ.
- Local-first spoken reply playback through Kokoro on Apple silicon. The first
  use creates a private Python environment and downloads its model without
  blocking the API. Selecting Local fails closed; `local_first` can fall back
  to OpenAI TTS only when a key and budget are available. `/api/health`
  reports the independent `tts_local` state and current engine.
- Tasks / calendar / people context **if** you run the
  [COS Starter Kit](https://www.gotcos.com) (`COS_SCRIPTS_DIR`); otherwise it is
  glasses + AI only
- Welcome weather on the glasses home screen via authenticated
  `GET /api/welcome-context?lat=&lon=`. The phone supplies GPS (Even Hub
  location permission); this server only proxies Open-Meteo. Without phone
  coords the route uses last-known process coords, then optional
  `COS_WEATHER_DEFAULT_*`, otherwise omits weather. Optional `nextEvent`
  appears when `COS_SCRIPTS_DIR` calendar data is available.

## Configuration

Config lives at `~/.cos-glasses/.env` (created on first run). Every key is
optional except an installed CLI. Highlights: `BIND_HOST`, `PORT`,
`COS_API_TOKEN` (auto if unset), `COS_OPENAI_WHISPER_FALLBACK=1` plus
`OPENAI_API_KEY` (explicit cloud transcription/TTS fallback),
`COS_TTS_ENGINE` (`local_first` or `openai_primary`),
`COS_TTS_KOKORO_VOICE` (local voice id),
`COS_TTS_LOCAL_DISABLE=1` (disable the sidecar), and
`COS_TTS_PRONUNCIATIONS_JSON` (optional local/cloud pronunciation overrides),
`COS_EXTRA_TOOLS` (comma-separated `mcp__server__tool` or
`mcp__server__*` selectors shared by full and lightweight Claude paths),
`COS_CLAUDE_MCP_CONFIG` (optional absolute config path when `.mcp.json` is not
in the managed CLI working directory),
`COS_CURSOR_AGENT_BIN` (optional absolute Cursor `agent` binary),
`COS_CURSOR_PERSIST_SESSIONS=0` (disable Cursor session resume),
`COS_CODEX_SANDBOX=workspace-write` (workdir writes + outbound network on GPT),
`COS_OLLAMA_MODEL` (optional pin; must match a name from `ollama list`),
`COS_OLLAMA_HOST` (optional loopback origin, default `http://127.0.0.1:11434`;
non-loopback is refused),
`COS_CODEX_EXTRA_ARGS` (Codex exec operator hatch — not the Ollama picker.
`--oss --local-provider ollama --model qwen2.5-coder` still retargets GPT
Frontier spawn. Put it in `~/.cos-glasses/.env`; a plist-only value is dropped
on Update Server. G2 Codex exec only — Sessions Continue / Fork ignore it.
No inline `#` on the EXTRA_ARGS line.),
`COS_WEATHER_DEFAULT_LAT` / `COS_WEATHER_DEFAULT_LON` /
`COS_WEATHER_DEFAULT_CITY` (optional home fallback when phone GPS is denied),
`COS_SCRIPTS_DIR` (full pipeline), `COS_DURABLE_QUERY_JOBS=0` (optional
machine-wide rollback for build 204+ server-owned query recovery),
`COS_MEDIA_ROOT` (optional image/video store location; default
`~/.cos-glasses/data/media`), and `COS_VIDEO_UPLOAD_V2=1` (private 6.27.3+
resumable-video canary, managed by COS Control 0.5.20). The V2 canary retains
accepted original chunks (1 MiB on new sessions; leftover 256 KiB drafts keep
that size) and finalize receipts across restarts; keep it off when
using an older companion. Your name + transcription vocabulary live in
`~/.cos-glasses/.cos-profile.json` (see `.cos-profile.example.json`).
Factory example values are ignored; add the real names, companies, acronyms,
and specialist terms you say often. Guided Setup writes a safe empty profile
instead of biasing Whisper toward placeholder text.
Telegram activity export is disabled by default even when a private COS
pipeline contains `.telegram_config.json`; enable it only with the explicit
`COS_TELEGRAM_NOTIFICATIONS=1` opt-in.

## Morning brief (6.43.0)

A start-of-day brief runs on a schedule inside the server and waits in the
inbox as a numbered reply. Default: weekdays at 07:00 in the Mac's timezone,
with Calendar, recent-meeting decisions, tasks due this week, and what is
waiting on you. Turn on more sources (knowledge graph, reflection, health, an
opening reading, a metrics pulse, one of your own skills such as
`/good-morning`, a custom section), reorder them, and set their windows from
COS Control or the companion, or directly:

```bash
curl -H "X-COS-Token: $COS_TOKEN" http://127.0.0.1:3141/api/morning-brief
curl -H "X-COS-Token: $COS_TOKEN" -X PUT -H 'Content-Type: application/json' \
  -d '{"time":"06:30","sources":[{"id":"skill","enabled":true,"options":{"name":"/good-morning"}}]}' \
  http://127.0.0.1:3141/api/morning-brief
curl -H "X-COS-Token: $COS_TOKEN" -X POST http://127.0.0.1:3141/api/morning-brief/run
```

One provider run per local day, remembered in a ledger so a restart never
doubles it; a Mac asleep at the slot still fires inside a three-hour catch-up
window; "Run now" is capped at five a day. Off entirely when Background jobs
are off. The brief is read-only by contract.

## Speaker diarization (opt-in)

Without a voiceprint model this server does not classify speakers at all — it
passes through whatever label the client sends (`Unknown` when the client sends
nothing; the COS companion sends its own wearer/`Ext` labels). Named
per-speaker diarization needs a ~26 MB voiceprint model that is deliberately
**not** shipped in the npm package, so it is a bolt-on:

```bash
npx --yes @gotcos/glasses-server@latest --setup-speaker-model
```

That downloads the model to `~/.cos-glasses/models/`, verifies it against a
pinned SHA-256, and refuses to install anything that does not match. Restart the
server afterwards and check `/api/health` — `speaker_id` should read `active`.

To place it by hand instead:

```bash
mkdir -p ~/.cos-glasses/models
# put 3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx there, then restart
```

The server searches, in order: `COS_SPEAKER_MODEL_PATH` (explicit full path to
the `.onnx`), `~/.cos-glasses/models/`, then a bundled `server/models/` copy
(source checkouts only). **Use the data home, not the installed package** —
anything inside the package is destroyed by the next update, while
`~/.cos-glasses/` survives.

Use an **absolute** path if you set `COS_SPEAKER_MODEL_PATH` — a relative one
resolves against the working directory, which under the managed LaunchAgent is
the installed package.

Verify with `/api/health` → `speaker_id`:

| Value | Meaning |
|---|---|
| `active` | model loaded, diarization running |
| `unavailable` | no model found — labels come from the client |
| `error` | a model is present but the runtime rejected it (see the startup log) |

The model is read once at startup, so restart after adding it. A corrupt or
mismatched `.onnx` is screened and probed in a child process first, so a bad
download disables diarization instead of taking the server down — but it does
mean a wrong file fails silently apart from that log line.

The wearer's label comes from `owner_speaker_label` in
`~/.cos-glasses/.cos-profile.json` (default `Me`); set it to match the profile
name you enrol under. Train voices via `/api/voice/enroll?name=…` (the default
name is `owner_speaker_label`); profiles persist in
`~/.cos-glasses/data/voice-profiles.json`.

**Upgrading from an older server:** before this release the enrollment default
was hardcoded to `MU`, so an existing install may hold a profile under that name
while `owner_speaker_label` resolves to `Me`. `/api/voice/status` will then
report `enrolled: false`. Set `owner_speaker_label` to `MU` to keep the existing
voiceprints rather than re-enrolling, which would split the same voice across two
profiles.

## HQ dictation

Prompt dictation defaults to HQ. The phone owns the preference: **Fast mode
OFF** requests HQ, and **Fast mode ON** requests turbo. The Mac performs all
decoding; the phone does not run Whisper.

For the recommended **Balanced** setup, run:

```bash
npx --yes @gotcos/glasses-server@latest --setup-transcription --transcription-tier balanced
```

That keeps three jobs separate: Small.en supplies provisional prompt words on
the lens, Large-v3-Turbo commits the authoritative live transcript, and
Large-v3 polishes saved prompts and meetings. Small.en never writes the
recovery ledger and receives no decoder-bias prompt.
If its sidecar is missing or unhealthy, preview falls back to Turbo without
changing final quality. Set `COS_WHISPER_PREVIEW_MODEL=turbo` to keep one live
model, or `off` to disable provisional peeks. Existing installs that only
update the server remain on Turbo until Guided Setup opts them into Small.en.

**Max** is an opt-in tier for powerful Macs:

```bash
npx --yes @gotcos/glasses-server@latest --setup-transcription --transcription-tier max
```

Max keeps Turbo resident in the isolated preview sidecar for low-latency
provisional words, while Large-v3 remains authoritative for live commit and
saved-work polish. Canonical transcription has strict GPU priority: a cosmetic
preview is dropped or aborted instead of competing with a committed decode.
If Large-v3 is missing, health reports the downgrade and the server falls back
to Turbo rather than making transcription unavailable. COS Control is the
supported owner of the machine-wide tier; the per-lane environment variables
remain advanced overrides.

Server 6.21.8 adds a default-off meeting-completion canary. With
`COS_MEETING_PROGRESSIVE_HQ=1`, sealed meeting windows can be polished ahead of
Stop/save on a CPU-only, single-flight lane; finalization reuses only matching
audio/model/context checkpoints. Balanced is capped at two background threads
for fanless M1/M2 MacBook Airs, while Max defaults to six and remains capped by
available CPUs. `COS_MEETING_EARLY_SYNC=1` separately gives the Operations sync
pipeline a stable meeting identity before HQ completes. Either switch can be
disabled without changing canonical live transcription or raw meeting audio.

Server 6.21.32 adds a separate default-off cleanup canary for retained review
audio. Set `COS_MEETING_AUDIO_ADAPTIVE_PLAYBACK=1` (or use COS Control 0.5.11+)
to profile a retained PCM chunk and create a cached playback-only copy when a
reviewer presses Play. The raw WAV remains byte-identical, still owns the
seven-day retention clock, and is served on every analyzer/FFmpeg failure.
Capture, live preview, canonical transcription, speaker attribution, save, HQ,
and meeting sync are unchanged. Append `?raw=1` to an authenticated playback
URL for an immediate raw-versus-cleaned A/B check.
While a meeting is actively recording, playback automatically stays raw so the
optional cleanup process cannot contend with live transcription. Cleanup uses
one global worker, serves raw while that worker is busy, and preempts within
100 ms if a meeting starts after a replay request was admitted.

Server 6.21.33 lets Review Meetings browse an existing single-library tree such
as `meetings/YYYY-MM/*.md`. Set `COS_MEETINGS_ROOT` to the folder that directly
contains the month folders. It is intentionally read-only. For the full COS
sync and enrichment pipeline, keep using `COS_OPERATIONS_DIR` with
`<domain>/meetings/YYYY-MM/*.md`; arbitrary domain names are supported. When a
direct library and an operations root are both configured, the server merges
them with standalone G2 recordings and prefers the enriched writable record
for the same session.

Server 6.21.35 adds authenticated, read-only Memory and Threads browsing for
full COS installs. With `COS_SCRIPTS_DIR` configured, the companion can show the
complete Bot Memory count/type split, bounded recent summaries, exact logical
memory IDs, and existing tracked/manual threads. Exact detail requests are
resolved by stable ID so a spoken follow-up can carry the selected snapshot as
context. Embeddings, vector-store point IDs, cache files, secrets, and local
paths never cross the API boundary.

### Memory and Threads from plain markdown (6.22.0)

You do not need a Python bridge, a virtual environment, or a vector database.
Make a folder with a `memory/` or `threads/` subfolder, put markdown files in it,
and point COS Data at it (or set `COS_CONTEXT_DIR`):

```
notes/
  memory/                      any nesting, any filenames
    2026-08-09-hiring-call.md
    decisions/pricing.md       folder name becomes the type
  threads/
    website-rebuild.md
```

Front matter is optional and every field degrades rather than rejecting:

```markdown
---
type: decision          # else the containing folder name, else "note"
date: 2026-08-09        # else a YYYY-MM-DD in the filename, else file mtime
status: resolved        # threads only
---
# Held Rain POS for v25

Body text. The first heading becomes the summary.
```

Two tiers, and the bridge always wins when it is present:

| Tier | Requires | Provides |
| --- | --- | --- |
| Files | a folder of markdown | Browse, read, and reference memories and threads |
| Bridge | + venv, `cos_api_bridge.py`, vector store | Adds semantic recall, dedup, type statistics, retention |

`/api/context/status` reports `source: "bridge"` or `source: "files"` so a client
can say which tier it is showing. Fields a file-backed record cannot have are
empty rather than invented: a file thread has `velocity: ""`, `meeting_count: 0`
and `stale: 0` because nothing computed them.

Root resolution, first match wins: `COS_CONTEXT_DIR` (exclusive when set), then
`COS_OPERATIONS_DIR`, `COS_MEETINGS_ROOT` and its parent, the parent of
`COS_SCRIPTS_DIR`, then `~/.cos-glasses` — so `mkdir ~/.cos-glasses/memory` is a
complete setup. The file tier is read from the code path taken only when no
bridge is configured, so adding it cannot change the behaviour of an install that
already has one.

The API is read-only in both tiers. Standalone installs with neither a bridge nor
a notes folder report the feature as unavailable without affecting messages,
meetings, transcription, or agents.

The first server start downloads the real-time turbo model. True HQ additionally
requires the full `ggml-large-v3.bin` model (about 3.1 GB):

```bash
mkdir -p "$HOME/.local/share/whisper-models"
curl -fL --progress-bar \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin \
  -o "$HOME/.local/share/whisper-models/ggml-large-v3.bin.partial"
mv "$HOME/.local/share/whisper-models/ggml-large-v3.bin.partial" \
  "$HOME/.local/share/whisper-models/ggml-large-v3.bin"
```

Restart the server, then confirm
`capabilities.transcription.hq.hqAvailable: true` at `/api/health`. The response
does not expose local paths. If the CLI or model is unavailable, dictation stays
usable on Fast and reports the downgrade truthfully. Set
`COS_HQ_SPECULATIVE_WARM=0` to disable background HQ warm immediately; set
`COS_BATCH_LARGE_V3=0` to explicitly use turbo. Interactive HQ uses beam 2 by
default (`COS_HQ_BEAM_INTERACTIVE`); meeting batch remains beam 5.

## Run from source

```bash
git clone https://github.com/ukaoma/cos-glasses-server.git
cd cos-glasses-server
npm install
BIND_HOST=0.0.0.0 npm run start:server
```

## Troubleshooting

- *Claude Desktop is installed but COS says Claude Code is missing* — Desktop
  and the terminal CLI are separate. Run
  `npm install -g @anthropic-ai/claude-code` on one line without `sudo`, then
  run `claude` and complete sign-in. Verify with `claude --version` before
  starting COS again.
- *npm reports EACCES or a root-owned cache* — never run COS or npm with
  `sudo`, and do not recursively change system ownership. Use a private COS
  cache instead:
  `npm_config_cache="$HOME/.cos-glasses/npm-cache" npx --yes @gotcos/glasses-server@latest`.
  Version 6.12.2+ never runs a second install from inside npm's temporary cache.
- *Phone can't connect* — check `BIND_HOST=0.0.0.0`, the same Tailscale account on both devices, and the correct `100.x` IP + token.
- *Safari connects but the app does not* — confirm `npx --yes @gotcos/glasses-server@latest` is 6.6.0+, then use the app's server reconnect/edit control to verify the current URL and token. Do not run a second source or `npx` server alongside it.
- *AI queries fail* — run `claude auth status`, `codex login status`, or
  `agent status` for the selected provider, then authenticate with
  `claude auth login`, `codex login`, or `agent login` when signed out.
- *Composer or Grok is missing* — update to server 6.16.1+, confirm `agent` is
  discoverable on the service `PATH`, and run `agent models`. `/api/health`
  must report `features.cursor: true`; authenticated `/api/models` must include
  both `cursor-composer` and `cursor-grok`. Missing models fail closed instead
  of falling through to another provider.
- *Voice getting billed?* — voice is local-only by default in 6.12.0+. Confirm
  `/api/health` reports `capabilities.transcription.mode: "local-only"`. Remove
  `COS_OPENAI_WHISPER_FALLBACK` (or set it to `0`) to disable an earlier opt-in.
- *Local voice unavailable?* — install `whisper-cpp`, restart the server, and
  confirm `/api/health` reports `features.whisper: true`. A typed retryable 503
  keeps compatible prompt/meeting audio available for retry instead of silently
  sending it to OpenAI.
- *Local spoken replies unavailable?* — on Apple silicon, install
  `python@3.12 ffmpeg espeak-ng`, restart the server, and wait for the
  first-run Kokoro model download. Confirm `/api/health` reports
  `tts_local.ready: true`.
  If Python lives outside the normal Homebrew paths, set its absolute 3.11 or
  3.12 path as `COS_TTS_BOOTSTRAP_PYTHON` in `~/.cos-glasses/.env`.
  Selecting Local never falls back to cloud; set `COS_TTS_ENGINE=openai_primary`
  only when OpenAI playback is intentionally configured.
- *Photos unavailable?* — install `ffmpeg`, restart the server, and confirm `/api/health` reports `features.mediaProcessingReady: true`.
- *Video or PDF attachments unavailable?* — install `ffmpeg poppler`, restart
  the server, and confirm `/api/health` reports
  `features.videoProcessingReady: true` and `features.pdfProcessingReady: true`.
  Uploads are limited to five items, 64 MiB each; videos are represented by up
  to eight bounded still frames and PDF/text contents are quoted as untrusted
  reference data rather than executable instructions.
- *Prompt recovery unavailable?* — update with `npx --yes @gotcos/glasses-server@latest`, then confirm `/api/health` reports `features.promptRecovery: true`.
- *Durable query recovery unavailable?* — build 204+ requires server 6.10.0+.
  Restart once, then confirm `/api/health` reports
  `features.durableQueryJobs: true`, protocol `1`, and state `ready`. To roll
  back, set `COS_DURABLE_QUERY_JOBS=0`; accepted jobs still drain while new prompts use legacy streaming.
- *Offline meeting recovery unavailable?* — build 209+ requires server 6.11.0+.
  Restart once, then confirm `/api/health` reports
  `features.localFirstMeetings: true` and
  `capabilities.localFirstMeetings.protocolVersion: 1`. Older app builds keep
  using their existing live-transcription and meeting-save paths.

## License

MIT. Learn more at [gotcos.com](https://www.gotcos.com).
