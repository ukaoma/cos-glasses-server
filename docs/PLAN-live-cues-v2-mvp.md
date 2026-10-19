# Live cues v2 MVP (consensus plan, 2026-10-17)

Evidence: `operations/personal/wk42_2026/cue_rrf_replay/REPORT.md` (dev replay, 120 windows) and the held-out replay
(112 windows, labels frozen by Opus before outputs): useful on required 26/29, unwanted 6/44, p50 7.2 s, $0.0055 per window.
Consensus with `PLAN-grounded-live-cues-v3.md` and the round-2 validation (both on branch `codex/grounded-live-cues`, worktree `~/cos-worktrees/server-grounded-live-cues`): single generative call,
no Composer, tools-off Claude through `runLensGistEngine`, retrieval straight from the window, charge at start and never refund,
tombstone on Stop, cancellations are not breaker failures, everything default-off.

## Pipeline (per evaluation)
1. Feed from `transcribe-stream.ts` (existing call). Evaluate when >= 40 new words and >= 20 s since the last evaluation started; single-flight; 45 s cooldown after a cue; skip while paused, ended, breaker open, capped, out of weekly budget, capture degraded, or while the user's own query runs. 45 s wall per evaluation.
2. Jev gate (own JevClient, ledger `jev-cues-usage.json`, cap `COS_LIVE_CUES_JEV_DAILY_TOKENS` default 1.5M): `act` cue/silent, `lookup`, `kind`. Admit when P(cue) >= `COS_LIVE_CUES_V2_GATE` (default 0.8; pooled dev+held-out: 110/113 silent kept, 51/59 required admitted).
3. Retrieval: `cue_memory.py` (COS scripts; BM25 first, then Qdrant dense inside a 3 s budget, RRF k=60, no LLM; index cache in `~/cos-data/cue-memory/`, a stale index is served while one background rebuild runs), queries = window tail + keyword string, 6 s timeout. Failure is non-fatal (cue proceeds without memory) and traced.
4. Jev memory judge: keep notes with P >= 0.8, at most 2.
5. Writer: one `runLensGistEngine('claude', COS_LIVE_CUES_V2_MODEL || 'sonnet', ...)`, 20 s timeout. Writer rules v3 by default (held-out, same grader call: unsupported 18 -> 11, useful 48 -> 46, within grader noise); `COS_LIVE_CUES_V2_PROMPT=v2` restores v2.
6. Validate: JSON, detail <= 220 chars, memoryIds subset of kept notes. Number guard is TRACED, not enforced (it fired on 3 v3 cues, 1 unsupported; ASR writes "300 000"); `COS_LIVE_CUES_V2_NUMBER_GUARD=withhold` enforces. Derive headline (<= 64 chars).
7. Staleness: drop when the room moved more than 60 words (about 24 s of speech) or the evaluation took more than 30 s.
8. Emit `coaching_nudge_v2` (LiveCueV2) and v1 `coaching_nudge` with the headline for old clients.

## Caps (how it stops)
Master switch `COS_LIVE_CUES_V2=1` (default off; independent of v1's `COS_LIVE_CUES`); per meeting 10 cues and 20 writer calls (persisted); 300 writer calls per local week (`COS_LIVE_CUES_V2_WEEKLY`; stored IANA zone, Monday start, checked before the gate, charged before the writer, never refunded); Jev daily token cap; breaker after 3 writer failures without a successful writer call in between (cancel, pause, stale and maintenance are not failures).

6.79.0 tuning knobs (defaults unchanged): `COS_LIVE_CUES_V2_COOLDOWN_S` (whole seconds 20..900, default 45) and `COS_LIVE_CUES_V2_JUDGE_KEEP` (0.5..0.95, default 0.8); unset or empty is the default, anything else falls back to it with one log line per value.

## Routes (additive)
`POST /api/live-cues/start|stop` (unchanged shape, v2 when enabled), `GET /api/live-cues/status?sessionId=`, `POST /api/live-cues/pause`, `POST /api/live-cues/feedback`. Capability `capabilities.liveCuesV2` on `/api/health` and `/api/models`.

## Logs (the trace has no transcript text; since 6.79.0 the cue log does, see below)
`live-cues-trace.jsonl`: one row per evaluation (gate p, lookup, kept count, memory error and index age, timings, tokens, cost, outcome), rate-limited `skip` rows, and feedback rows (cueId, vote or verdict, optional user reason). This is the live accuracy record.

## Cue log and verdicts (6.79.0)
These two files DO carry text: the cue itself, up to 400 characters of what was said before it (blanked after 7 days), and Miles's rating notes. Both are 0600, never written to the trace, and not in any diagnostics export.
- `live-cues-log.jsonl`: one row per cue `{v:1, cueId, sessionId, meetingTitle, createdAt, armedAt, kind, headline, detail, gate, sources, model, prompt, memorySource, kept, before}`, appended before the cue is held or emitted. The reader validates each line and skips (counts) anything else. Pruned on first use in the process, then at most once a day: rows past 30 days dropped, `before` past 7 days blanked.
- `live-cues-verdicts.json`: `{v:1, verdicts: {[cueId]: {verdict?, note?, vote?, at}}}`, atomic write, last write wins, fails closed (503 `verdicts_unreadable`) when unreadable. A lens vote is kept in `vote` beside the verdict and never overwrites it. Records go when their cue leaves the log.
- `POST /api/live-cues/feedback {sessionId, cueId, verdict: useful|late|repeat|wrong|obvious|clear, note?}` answers `{ok, cueId, verdict, vote}`; works with v2 off; 404 `unknown_cue`, 409 `cue_session_mismatch`. The lens body `{vote, reason?}` and its `{ok, knownCue}` answer are unchanged.
- `GET /api/live-cues/history?days=7&sessionId=a,b&unrated=1&limit=200` answers `{v:1, cues: [{...row, title, titleSource, rating}], counts, truncated, skipped, maxCuesPerMeeting, meetings?}`, oldest first, the newest `limit` rows. Feature-detect with `verdicts.protocol` (1) on `GET /api/live-cues/status` without sessionId, whatever the v2 switch.

## Not in the MVP
Public web research, solo/think-aloud mode, SubQ (needs zero-retention first), Control UI, lens pause from the ring.
