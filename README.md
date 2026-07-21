# COS Glasses Server

Self-hosted AI heads-up display for **Even G2 smart glasses**. Runs on your Mac,
talks to your local **Claude Code or Codex** CLI, and pushes answers, voice
transcription, and notes to the lens. Your data never leaves your machine, and no
API key is pasted into the phone for chat.

## Quick start

```bash
npx --yes @gotcos/glasses-server@latest
```

The launcher checks Node, finds your CLI, checks voice and image processing,
downloads the local voice model when needed, writes `~/.cos-glasses/.env`, and
starts the server on `0.0.0.0:3141`. On boot it prints
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
- **Even G2 glasses** + the **COS Glasses** app from the Even Hub
- `brew install whisper-cpp` for free local voice (the launcher can download the model)
- _Optional:_ `brew install ffmpeg` for phone/output image attachments (text chat remains available without it)
- _Optional:_ **Tailscale** so your phone reaches your Mac from anywhere

> No `ANTHROPIC_API_KEY` is needed — chat runs through your installed CLI, billed
> to your existing Claude or Codex subscription. Pick either per query, or set a
> default with `COS_G2_DEFAULT_MODEL` (`opus`|`fable`|`sonnet`|`codex-frontier`|`codex-balanced`).
> Claude tier aliases and the two GPT slots resolve dynamically, so new model
> releases do not require a new glasses package. GPT discovery refreshes every
> 15 minutes and retains its last-known-good catalog through transient failures.
> Existing `COS_CODEX_MODEL` / `COS_CODEX_REASONING_EFFORT` settings remain
> supported on the migrated Frontier slot; leave them blank for auto-latest.
> Codex runs **sandboxed read-only** by default (`COS_CODEX_SANDBOX` to adjust).
> Claude preserves the established trusted-machine mode for compatibility.
> Set `COS_CLAUDE_TRUST_MODE=allowlist` to remove Claude's permission bypass
> and restrict it to COS's explicit per-query tool allowlist; undeclared tools
> then fail closed without prompting.

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
- With COS Glasses build 204+, opt into server-owned durable queries with
  `COS_DURABLE_QUERY_JOBS=1`: accepted work survives phone backgrounding,
  WebView reloads, and network handoffs, then reattaches without duplicate work
  or duplicate replies
- Choose Opus, Fable, Sonnet, GPT Frontier, or GPT Balanced plus High, Extra
  High, Max, or Ultracode effort; optional redacted tool activity streams only
  to the authenticated query that requested it
- Message History + cross-day "reference message N" — your chats are archived by day
  and every message keeps a permanent number you can recall (`/api/archive`, `/api/message/:num`)
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
- Local whisper.cpp transcription (free and local-only by default). OpenAI
  Whisper fallback is optional and requires both the exact
  `COS_OPENAI_WHISPER_FALLBACK=1` opt-in and a configured key; a key alone never
  uploads audio.
- Tasks / calendar / people context **if** you run the
  [COS Starter Kit](https://www.gotcos.com) (`COS_SCRIPTS_DIR`); otherwise it is
  glasses + AI only

## Configuration

Config lives at `~/.cos-glasses/.env` (created on first run). Every key is
optional except an installed CLI. Highlights: `BIND_HOST`, `PORT`,
`COS_API_TOKEN` (auto if unset), `COS_OPENAI_WHISPER_FALLBACK=1` plus
`OPENAI_API_KEY` (explicit cloud voice fallback),
`COS_SCRIPTS_DIR` (full pipeline), `COS_DURABLE_QUERY_JOBS=1` (build 204+
server-owned query recovery), and `COS_MEDIA_ROOT` (optional image-store
location; default `~/.cos-glasses/data/media`). Your name + transcription vocabulary live in
`~/.cos-glasses/.cos-profile.json` (see `.cos-profile.example.json`).
Telegram activity export is disabled by default even when a private COS
pipeline contains `.telegram_config.json`; enable it only with the explicit
`COS_TELEGRAM_NOTIFICATIONS=1` opt-in.

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
- *AI queries fail* — run `claude auth status` / `codex login status`, then
  `claude auth login` / `codex login` when the provider reports signed out.
- *Voice getting billed?* — voice is local-only by default in 6.12.0+. Confirm
  `/api/health` reports `capabilities.transcription.mode: "local-only"`. Remove
  `COS_OPENAI_WHISPER_FALLBACK` (or set it to `0`) to disable an earlier opt-in.
- *Local voice unavailable?* — install `whisper-cpp`, restart the server, and
  confirm `/api/health` reports `features.whisper: true`. A typed retryable 503
  keeps compatible prompt/meeting audio available for retry instead of silently
  sending it to OpenAI.
- *Photos unavailable?* — install `ffmpeg`, restart the server, and confirm `/api/health` reports `features.mediaProcessingReady: true`.
- *Prompt recovery unavailable?* — update with `npx --yes @gotcos/glasses-server@latest`, then confirm `/api/health` reports `features.promptRecovery: true`.
- *Durable query recovery unavailable?* — build 204+ requires server 6.10.0+ and
  `COS_DURABLE_QUERY_JOBS=1`. Restart once, then confirm `/api/health` reports
  `features.durableQueryJobs: true`, protocol `1`, and state `ready`. To roll
  back, remove the flag; accepted jobs still drain while new prompts use legacy streaming.
- *Offline meeting recovery unavailable?* — build 209+ requires server 6.11.0+.
  Restart once, then confirm `/api/health` reports
  `features.localFirstMeetings: true` and
  `capabilities.localFirstMeetings.protocolVersion: 1`. Older app builds keep
  using their existing live-transcription and meeting-save paths.

## License

MIT. Learn more at [gotcos.com](https://www.gotcos.com).
