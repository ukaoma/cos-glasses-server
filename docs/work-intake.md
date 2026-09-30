# Work intake

Work intake holds meeting-derived Work that is not on the board yet. A producer outside the server (COS `operations/scripts/work_intake.py`, which uses Jev to judge saved meetings) pushes items; the user resolves them in COS Control → Work → Intake. The server never calls a model or starts an agent for intake.

## Items

| Kind | Status | Meaning | Accept does |
| --- | --- | --- | --- |
| `link` | `suggested` | An existing task was probably worked on in a meeting (0.60 to 0.85, or higher for a task that already links several meetings) | Links the task to the meeting |
| `ask` | `ask` | Someone else's action item. `pull` names one of the user's sessions that may already cover it | Creates a Mentioned card linked to the meeting, written with "(from Name)" |
| `ask` | `review` | The user's own item that needs a look. `reason`: `outside_window`, `unclear_task` or `owner_uncertain` | Creates a Mentioned card linked to the meeting |
| any | `accepted` / `dismissed` | Decided. A producer may record cards it made itself (`resolution.by: "producer"`) and may retract its own open items (a producer dismissal) | — |

## API (authenticated like every `/api` route)

- `GET /api/work-intake` returns `{ schemaVersion: 1, capabilities: { linkWrites, cardCreation, bridgeUnavailable? }, counts, items, quarantined }` with open items only.
- `POST /api/work-intake/items` takes `{ items: [...] }`, at most 200 per batch. Each item is validated on its own; refusals come back in `rejected: [{ id, code }]`.
- `POST /api/work-intake/:id/resolve` takes `{ action: "accept" | "dismiss" }`. Refusals are 409 with a code (`intake_task_changed`, `meeting_links_full`, `meeting_identity_changed`, `meeting_unavailable`, `intake_text_collision`, `work_board_read_only`, `card_creation_unavailable`, `intake_busy`), 503 `task_bridge_unavailable` when the task bridge did not answer, 404 `intake_not_found`. A refused item stays open.

Card creation needs a COS task bridge that reports `captureWork: 1`. The bundled task runtime does not, so on installs without COS the Intake list stays empty and accepting an ask is refused.

## Storage and recovery

The journal is `work-intake/intake.json` in the server data directory, owned by one server process (`writer.lock`). User decisions are kept for 60 days and are sticky against producer upserts; open items are capped at 5,000. An unreadable record is quarantined on its own and logged at start. An unreadable or unsafe journal disables intake (503) without stopping the rest of the server: preserve the file for diagnosis, then move it aside to start empty. The producer's own ledger (`.work_intake_state.json`) never re-sends a decided item.

## Verification

`npx vitest run server/lib/work-intake-store.test.ts server/routes/work-intake.test.ts server/lib/task-store-intake.test.ts` covers the store, routes and bridge powers. `node server/scripts/work-intake-mutation-gate.mjs` runs its mutations in a private copy and refuses to start on a red baseline. The local Work candidate (`server/scripts/work-review-candidate.ts`) mounts intake with a journal in the candidate home.

## Jev key and session suggestions

`POST /api/jev-key/set` `{ key }` validates the key against TypeSafe and saves it to `data/jev-key.json`; `GET /api/jev-key/status` returns `{ configured, source, usedToday, dailyCap, breakerOpenUntil, lastError }` and never the key; `DELETE /api/jev-key` removes the saved key. `POST /api/work-board/session-recommendation` `{ domain, id, sessions: [{ id, provider, title, summary? }] }` returns `{ provider: "jev", action: "continue" | "fork" | "new", sessionId, confidence, reason, alternatives }` or `{ provider: "none", reason }`. The COS meeting producer reads the same saved key when its own `.env` has none.

Since 6.57.1 `POST /api/work-board/session-recommendation` also takes exactly `{ reviewId, sessions }` for a meeting review (`reviewId` = `wr_` + 32 hex). The server reads the review's meeting title and reviewed follow-up from its own store; the client never sends work text. Errors: 400 `invalid_review_request` (bad id or session list), 404 `review_not_found`, 404 `reviews_unavailable` (reviews off), 503 `review_store_unavailable` (defensive; the stock lookup reads memory).

Since 6.58.0 `POST /api/work-board/completion-check` takes exactly `{ domain, id, provider, sessionId }` plus an optional `after` (ISO time). It asks Jev whether the session's replies since `after` (or its newest reply) show the task finished, judged against its Done when or, without one, its own text. The server reads the task from the board and the replies from its own transcripts; the client sends names and a time only. It answers `{ provider: "jev", verdict: "done" | "not_done" | "unclear", confidence, basis: "done_when" | "task", model, cached }` or `{ provider: "none", reason }` (`no_reply`, `no_task_text`, a Jev condition, `completion_unavailable`). Errors: 400 `invalid_completion_request`, 404 `task_not_found`, 404 `session_not_found`. COS Control 0.5.247 asks only while the session is idle and its newest reply since the handoff has no `COS-WORK` status line, at most twice per handoff, and moves a card to QA only on done at 0.8 (0.85 without a Done when).

Since 6.58.2 `POST /api/query-jobs` also takes an optional `sessionName` (a string; the server cleans it as the 6.58.2 changelog says and keeps at most 100 characters; anything else is no name, never an error). It names only a Claude session the job starts itself (`claude --name=<name>`, when the installed CLI lists `--name`); a Continue, a dispatch, a Codex, Cursor or Ollama job, and an older server ignore it, and it is not part of the request fingerprint. A Claude job's snapshot carries `cliSessionId` from Claude's first stream event while the job is still `running`, not only at completion. COS Control 0.5.250 sends the Work item's title for New session, Start work and Fork to Claude, and links its receipt as soon as the running job names the session.
