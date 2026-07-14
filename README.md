# COS Glasses Server

Self-hosted AI heads-up display for **Even G2 smart glasses**. Runs on your Mac,
talks to your local **Claude Code or Codex** CLI, and pushes answers, voice
transcription, and notes to the lens. Your data never leaves your machine, and no
API key is pasted into the phone for chat.

## Quick start

```bash
npx @gotcos/glasses-server
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
- **Claude Code CLI** (Opus/Fable/Sonnet) — https://claude.ai/download, then `claude login`
  _or_ **Codex CLI** (GPT Frontier/Balanced) — https://developers.openai.com/codex/, then `codex login`
- **Even G2 glasses** + the **COS Glasses** app from the Even Hub
- _Optional:_ `brew install whisper-cpp` for free local voice (otherwise OpenAI API)
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

## Connect your phone (the one gotcha)

The glasses app runs on your iPhone and must reach this server on your Mac.

1. The launcher binds `0.0.0.0` (all interfaces) for you.
2. **Same WiFi (simplest):** find your Mac's LAN IP (System Settings > Wi-Fi > Details), and in the COS Glasses app enter `http://192.168.x.x:3141`.
3. **From anywhere:** install **Tailscale** on the Mac + iPhone (same account), note the Mac's `100.x` address, and enter `http://100.x.x.x:3141`.
4. Either way, paste the **API token** the server printed at boot.

To restrict the server to localhost only, set `BIND_HOST=127.0.0.1` in `~/.cos-glasses/.env`.
The built-in IP allowlist blocks public-internet traffic regardless.

## What it does

- Ask anything, get a streamed answer on the lens (`/api/query`, `/v1/chat/completions`)
- Choose Opus, Fable, Sonnet, GPT Frontier, or GPT Balanced plus High, Extra
  High, Max, or Ultracode effort; optional redacted tool activity streams only
  to the authenticated query that requested it
- Message History + cross-day "reference message N" — your chats are archived by day
  and every message keeps a permanent number you can recall (`/api/archive`, `/api/message/:num`)
- Send phone photos with queued prompts, and review assistant-selected generated,
  research, or explicitly used email images in Messages and on the G2 lens
- Recover long voice prompts after phone, network, or server interruptions. Audio
  chunks are saved before transcription and retained locally for 72 hours.
- Live voice capture + transcription during meetings
- Local whisper.cpp transcription (free) with OpenAI fallback (optional)
- Tasks / calendar / people context **if** you run the
  [COS Starter Kit](https://www.gotcos.com) (`COS_SCRIPTS_DIR`); otherwise it is
  glasses + AI only

## Configuration

Config lives at `~/.cos-glasses/.env` (created on first run). Every key is
optional except an installed CLI. Highlights: `BIND_HOST`, `PORT`,
`COS_API_TOKEN` (auto if unset), `OPENAI_API_KEY` (cloud voice fallback),
`COS_SCRIPTS_DIR` (full pipeline), and `COS_MEDIA_ROOT` (optional image-store
location; default `~/.cos-glasses/data/media`). Your name + transcription vocabulary live in
`~/.cos-glasses/.cos-profile.json` (see `.cos-profile.example.json`).

## Run from source

```bash
git clone https://github.com/ukaoma/cos-glasses-server.git
cd cos-glasses-server
npm install
BIND_HOST=0.0.0.0 npm run start:server
```

## Troubleshooting

- *Phone can't connect* — check `BIND_HOST=0.0.0.0`, the same Tailscale account on both devices, and the correct `100.x` IP + token.
- *Safari connects but the app does not* — confirm `npx @gotcos/glasses-server@latest` is 6.6.0+, then use the app's server reconnect/edit control to verify the current URL and token. Do not run a second source or `npx` server alongside it.
- *AI queries fail* — run `claude --version` / `codex --version`, then `claude login` / `codex login`.
- *Voice getting billed?* — install `whisper-cpp` for free local transcription.
- *Photos unavailable?* — install `ffmpeg`, restart the server, and confirm `/api/health` reports `features.mediaProcessingReady: true`.
- *Prompt recovery unavailable?* — update with `npx @gotcos/glasses-server@latest`, then confirm `/api/health` reports `features.promptRecovery: true`.

## License

MIT. Learn more at [gotcos.com](https://www.gotcos.com).
