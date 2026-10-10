# Live COS Ask

Unreleased companion endpoint for COS Control. Authenticated `POST /api/meetings/live-ask` accepts a session ID, action (`catch_up`, `summary`, `questions`, `actions`, `ask`), question, elapsed milliseconds and transcript turns (`id`, `elapsedMs`, `speaker`, `text`), with optional recent question/answer history. It returns answer, cited sources, notices, model and snapshot time. Control sends this via its helper on stdin using the existing pairing token. Old server versions return 404 and Control asks for an update.

On demand only. Presets use only current-meeting evidence. Free-form questions can request at most two searches of existing COS memory/meeting indexes and three Haiku calls. History is disambiguation only, never evidence. Retrieval supplies bounded search excerpts, not entire historical records; notices identify unavailable semantic search or local keyword fallback. There are no write tools, automatic task creation, web searches, background model calls, automatic retries or provider fallbacks.

The existing isolated Claude CLI runner reuses stored sign-in, with no tools/MCP/hooks/session persistence. `haiku` resolves through that CLI; results identifying another model are refused. Each call has a 45-second deadline and 1,400-output-token cap; route deadline 150 seconds. Evidence budget is about 32,000 characters including transcript metadata. Oversized meetings use selected passages with a visible notice. One request may run at a time, with a two-second admission interval and bounded five-minute in-memory answer reuse. Disconnect/Stop cancels model work. Operational audit records are metadata only.

## Validation

137 focused tests passed across core orchestration, authenticated route, runner, existing lens-gist and work-search; TypeScript typecheck passed. Core coverage includes no preset history lookup, bounded hops/cache/concurrency, incomplete evidence, invalid citations, malformed input, cancellation and model mismatch. Companion native/helper tests verify actual transport and error presentation.

An opt-in real-provider canary uses invented speech, an ephemeral authenticated server and a compiled Control helper:

```sh
COS_DATA_DIR=/tmp/cos-live-ask-canary-data node --import tsx/esm server/scripts/live-cos-ask-canary.ts /path/to/compiled-helper /tmp/live-cos-ask-receipt.json
```

Run with stored Claude sign-in; the agent runs this, not the end user. The scratch helper home must be under `/tmp/` so its test port override is honored. The canary verifies its own endpoint received the request. It does not restart or mount into the production recording server. It passed on 2026-10-10 in 2.276 seconds with `claude-haiku-5-5` and grounded transcript citations. A separate real-Haiku test with injected historical search fixtures passed in 7.024 seconds with one targeted history search. Actual COS retrieval quality was not canaried against private meetings.

Candidate only. New server and Control versions, full release gates and signed/notarized Control distribution are still required. No EHPK change is necessary.
