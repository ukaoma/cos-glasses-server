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
