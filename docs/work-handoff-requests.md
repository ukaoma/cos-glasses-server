# Work progress and handoff requests (6.59.0)

The glasses see how Work handoffs are going, and can ask COS Control to start one. The server only reads COS Control's handoff journal and keeps a small inbox of requests. It never runs a provider for a request and never asks Jev on these routes. Every route here uses the existing `/api` authentication.

## Progress on an item: `GET /api/work-board/activity?domain=<domain>&workIdentity=<12hex>`

Unchanged fields stay as they were (`id`, `workId`, `domain`, `status`, `provider`, `sessionId`, `sessionTitle`, `error`). The result gains `capabilities: { progress: 1, requests: 1 | 0 }`; `requests` is 0 when the request inbox could not open on this server. Each activity may also carry:

| Field | Meaning | From COS Control's receipt |
| --- | --- | --- |
| `mode` | `continueSession`, `fork` or `newSession` | `mode` |
| `model` | The model slot it was sent with, when there was one | `modelID` |
| `createdAt` | ISO time the handoff was sent | `createdAt` (seconds since 1970) |
| `updatedAt` | The newest progress event, never earlier than `createdAt` | `progress.events[].at` |
| `progress.reported` | `done`, `needsInput`, `blocked` or `null` | `progress.reported` (an unknown kind reads as `null`, as Control reads it) |
| `progress.reportedBy` | `session` (its own status line) or `jev` (Jev read the reply) | `progress.reportedBy` |
| `progress.evidence` | At most 280 characters, control characters as spaces | `progress.evidence` |
| `progress.receivedAt` | When the session was seen to have the work | `progress.receivedAt` |
| `progress.lastMove` | `{ from, to, at, undone }`: the newest move COS made | the newest `moved` event and its `undoneAt` |
| `progress.paused` | A manual move back (or an Undo) paused automatic moves | `progress.paused` |
| `acknowledged` | You reviewed or acknowledged it | `acknowledgedAt` set, or status `reviewed` |
| `appOpened` | Its app owns the session now | `appOpen.openedAt` set, or channel `tab` |
| `serverHold` | The COS server is still running this Work New session | channel `job`, mode `newSession`, a session named, status not terminal |
| `requestedFrom` | `glasses` when Control sent it from a glasses request | `requestedFrom` |

`reportedBy` and `evidence` appear only with a report. `evidence` is the session's own status line or Jev's reading; show Jev's as a reading, not as the session's words. The result may also carry `savedDestination` at the top level (below).

Parsing is lenient for everything new. A malformed `progress` block is dropped on its own (that activity has no `progress`, and its `updatedAt` is its `createdAt`); a malformed `appOpen` or `acknowledgedAt` reads as absent; a time no date can hold is left out. None of them makes the journal unavailable. Every check the server already made on the rest of the journal is unchanged, and so are the file protections (no symlinked file or folder, owner only, under 10 MB, never read in an isolated runtime).

A handoff COS Control 0.5.248 opened as a tab and never linked to a session (channel `tab`, `queued`, no session) reads as `canceled`, as Control reads it.

## Everything open: `GET /api/work-board/activity/open`

`{ version: 1, available, reason?, capabilities, items }`. Each item is an activity (as above) plus `workIdentity`, `domain` and `title`. The title is the board row's; the receipt's work title is never returned. It takes no parameters (400 `invalid_open_activity_request`).

- An item is a board task (`task:<domain>:<12 hex>` with a row on the board) whose newest receipt (by time, then id; any revision), sent in the last 14 days, is not terminal, or reports needs input or blocked, or reports done, and is not acknowledged. Terminal means `completed`, `failed`, `refused`, `canceled` or `reviewed`.
- A task already complete on the board shows only while its newest receipt is `queued` or `running`, as Control's board does.
- Order: needs input and blocked first, then the rest that are not terminal (`queued`, `running`, `delivered`, `unknown`), then done awaiting review; newest first within each. At most 50.
- `available: false` with a reason when the journal or the board cannot be read.
- Read-only: no provider call, no Jev, no write.

## Saved destination

`savedDestination: { mode, provider, model?, sessionId? }` sits at the top level of the item's activity result and on each open item. It comes from COS Control's draft for that task's current revision: the server computes the revision from the board row exactly as Control's `WorkSource.taskSnapshot` does (its text, domain, Done when, source and meeting links), and a draft saved before any of those changed does not count, as in Control. It is present only when the draft names a complete destination: a session (`provider:native`) for Continue and Fork, a provider and model for New, and a model when a Fork goes to another platform. `provider` is always set. The draft's prompt is never read into a response.

## Handoff requests

The glasses leave a request, COS Control claims it and runs its own send with every guard it has (the journal fence, one active handoff per item, the status line, the session name, the server hold, the app owner, open in app). The requests live in `work-handoff-requests/requests.json` in the server data directory.

### Glasses: `POST /api/work-board/handoff-requests`

```
{ clientRequestId, domain, workIdentity, expectedRevision, mode, sessionId?, model?, note?, destinationSource }
```

- `clientRequestId`: a UUID v4 (either case; stored in lowercase). `domain`: a safe domain name. `workIdentity`: 12 hex. `expectedRevision`: the board's 64-hex `workRevision`.
- `mode`: `continueSession`, `fork` or `newSession`. Continue and Fork need `sessionId` (`provider:native`, provider one of claude, codex, cursor, ollama). A New session names no session. Continue takes no model. A Fork may name a model (another platform). A New session without a model takes the server's default (`COS_G2_DEFAULT_MODEL`, else `sonnet`), and the stored request names it. A model is a slot this server knows (`opus`, `fable`, `sonnet`, `haiku`, `codex-frontier`, `codex-balanced`, `cursor-grok`, `cursor-composer`, `ollama`).
- `note`: at most 2,000 characters after trimming. Newlines and tabs are kept; any other control character, or a broken surrogate, is refused (400), never cleaned.
- `destinationSource`: `saved`, `jev` or `user`.
- An empty string or `null` counts as not given for `sessionId`, `model` and `note`. Any other field, or a body over 16 KB, is refused.

Answers:

| Status | Code | When |
| --- | --- | --- |
| 201 | | Recorded as `pending`: `{ request }` |
| 200 | | The same `clientRequestId` and the same request again: the stored request, in whatever state it is now. Answered before the board is read |
| 400 | `invalid_handoff_request` | Anything malformed |
| 404 | `task_not_found` | No board row for that domain and work identity |
| 409 | `request_id_conflict` | The same `clientRequestId` with a different request |
| 409 | `revision_changed` | `expectedRevision` is not the board's `workRevision` now |
| 409 | `request_pending` | The item already has a pending or claimed request |
| 429 | `daily_cap` | 40 requests already made today (UTC day, whatever became of them) |
| 503 | `work_board_unavailable` | The board could not be read |
| 503 | `handoff_requests_unavailable` | The inbox did not open on this server |

### Glasses: `GET /api/work-board/handoff-requests/:clientRequestId`

`{ request: { clientRequestId, state, receiptId?, reason?, createdAt, expiresAt, claimedAt?, resultAt? } }`, never the note. `state` is `pending`, `claimed`, `sent`, `refused` or `expired`. `expiresAt` is always `createdAt` plus 10 minutes, the moment it can no longer be claimed. 404 `request_not_found`.

### COS Control

- `GET /api/work-board/handoff-requests?state=pending` returns `{ version: 1, requests }` in full (note, mode, session, model, destination source), oldest first. `state` may be any of the five states or left out.
- `POST /api/work-board/handoff-requests/:id/claim` (no body) is atomic: 200 with the full request, now `claimed`; 409 `already_claimed` when it is claimed or finished; 410 `request_expired`; 404 `request_not_found`.
- `POST /api/work-board/handoff-requests/:id/result` `{ state: "sent" | "refused", receiptId?, reason? }`, only for a claimed request: 200; the same result again is 200 with no change; otherwise 409 `request_not_claimed`, or 410 `request_expired`. The reason is cleaned (control characters as spaces) and kept to 500 characters.

### Time

- A pending request expires 10 minutes after `createdAt` and can never be claimed after that, so a Control that starts tomorrow never fires yesterday's tap.
- A claimed request with no result 10 minutes after the claim becomes `refused` with the reason `COS Control did not report back`, and a late result is refused (409).
- Both follow from the stored times on every read; the next write stores them. A read never writes.

### Storage and recovery

One server process owns the file (`writer.lock`); writes are durable and atomic (a private temp file, fsync, rename). Requests older than 7 days are dropped on the next write. An unreadable record is set aside on its own (`quarantined`) and logged at start. An unreadable or unsafe file disables the inbox (503, `capabilities.requests: 0`) without stopping the server: keep the file for diagnosis, then move it aside to start empty.

Writes take the same maintenance lease as every short `/api` write, so they are refused while COS Control drains the server for an update. Nothing here holds a restart: a request that waits through one simply expires.

## Privacy

Responses never carry a receipt's `prompt`, `detail`, `result` or work title, a progress event's text, or a draft's prompt. Evidence is up to 280 characters of the session's status line or Jev's reading (Miles approved this on 2026-09-30). A request's note goes back only to COS Control's list and to the glasses that sent it (in the create answer), never in the status view.

## Verification

`npx vitest run server/lib/work-activity.test.ts server/routes/work-board.test.ts server/lib/work-handoff-requests.test.ts server/routes/work-handoff-requests.test.ts` covers the projection, the open list, the saved destination (checked against Control's own Swift for the revision), the inbox and its routes. `node server/scripts/work-progress-mutation-gate.mjs` runs its mutations in a private copy and refuses to start on a red baseline.
