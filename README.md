# @gotcos/glasses-server

COS Glasses — AI heads-up display for Even G2 smart glasses, powered by Claude.

Voice transcription runs **locally on your Mac via whisper.cpp** by default — zero per-minute cost. OpenAI API is only used as a fallback if `whisper-cpp` isn't installed.

## Quick Start

```bash
# Install local Whisper for free voice (one-time, ~3.1GB model auto-downloaded)
brew install whisper-cpp

# Start the server
npx @gotcos/glasses-server
```

The launcher detects whisper.cpp on first run and downloads the model automatically. If you skip the brew install, voice transcription falls back to OpenAI API ($0.006/min) — set `OPENAI_API_KEY` if you prefer cloud.

## Prerequisites

- macOS (Apple Silicon or Intel)
- Node.js 18+
- [Claude Code CLI](https://claude.ai/download)
- (optional) [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — `brew install whisper-cpp` for free local voice

## Documentation

Full setup guide and configuration: [gotcos.com/wizard](https://gotcos.com/wizard)

## What you get

- 100% local LLM queries via Claude Code CLI on your Max plan — no API key needed for chat
- Local voice transcription via whisper.cpp (free) with OpenAI API fallback (paid, optional)
- Live meeting capture + transcription on Even G2 smart glasses
- Active-meeting recovery — orphaned sessions survive client crashes and can be finalized via `/api/meeting/save`
- Server-side hallucination filters (Whisper "thank you" pattern) baked in
