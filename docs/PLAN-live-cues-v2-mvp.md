# Live cues v2 MVP (consensus plan, 2026-10-17)

Evidence: `operations/personal/wk42_2026/cue_rrf_replay/REPORT.md` (dev replay, 120 windows) and the held-out replay
(112 windows, labels frozen by Opus before outputs): useful on required 26/29, unwanted 6/44, p50 7.2 s, $0.0055 per window.
Consensus with `docs/PLAN-grounded-live-cues-v3.md` and the round-2 validation (codex/grounded-live-cues): single generative call,
no Composer, tools-off Claude through `runLensGistEngine`, retrieval straight from the window, charge at start and never refund,
tombstone on Stop, cancellations are not breaker failures, everything default-off.

## Pipeline (per evaluation)
1. Feed from `transcribe-stream.ts` (existing call). Evaluate when >= 40 new words and >= 20 s since the last evaluation started; single-flight; 45 s cooldown after a cue; skip while paused, ended, breaker open or capture degraded.
2. Jev gate (own JevClient, ledger `jev-cues-usage.json`, cap `COS_LIVE_CUES_JEV_DAILY_TOKENS` default 600k): `act` cue/silent, `lookup`, `kind`. Admit when P(cue) >= `COS_LIVE_CUES_V2_GATE` (default 0.8; pooled dev+held-out: 110/113 silent kept, 51/59 required admitted).
3. Retrieval: `cue_memory.py` (COS scripts; BM25 + Qdrant dense, RRF k=60, no LLM), queries = window tail + keyword string, 6 s timeout. Failure is non-fatal (cue proceeds without memory).
4. Jev memory judge: keep notes with P >= 0.8, at most 2.
5. Writer: one `runLensGistEngine('claude', COS_LIVE_CUES_V2_MODEL || 'sonnet', ...)`, 20 s timeout, writer rules v2/v3 as the system prompt.
6. Validate: JSON, detail <= 220 chars, memoryIds subset of kept notes, number guard (every multi-digit number appears in the window or memory). Derive headline (<= 64 chars).
7. Staleness: drop when the room moved > 120 words during the evaluation.
8. Emit `coaching_nudge_v2` (LiveCueV2) and v1 `coaching_nudge` with the headline for old clients.

## Caps (how it stops)
Master switch `COS_LIVE_CUES_V2=1` (default off) plus `COS_LIVE_CUES=1`; per meeting 10 cues and 20 writer calls; 300 writer calls per local week (stored IANA zone, Monday start, charged at start, never refunded); Jev daily token cap; breaker after 3 consecutive real failures (cancel, pause, stale and maintenance are not failures).

## Routes (additive)
`POST /api/live-cues/start|stop` (unchanged shape, v2 when enabled), `GET /api/live-cues/status?sessionId=`, `POST /api/live-cues/pause`, `POST /api/live-cues/feedback`. Capability `capabilities.liveCuesV2` on `/api/health` and `/api/models`.

## Logs (no transcript text)
`live-cues-trace.jsonl` (one row per evaluation: gate p, lookup, kept count, timings, tokens, cost, outcome), `live-cues-feedback.jsonl` (cueId, vote, reason). These are the live accuracy record.

## Not in the MVP
Public web research, solo/think-aloud mode, SubQ (needs zero-retention first), Control UI, lens pause from the ring.
