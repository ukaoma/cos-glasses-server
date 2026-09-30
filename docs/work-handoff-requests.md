# Work progress and handoff requests (6.59.0)

The glasses see how Work handoffs are going, and can ask COS Control to start one. The server only reads COS Control's handoff journal and keeps a small inbox of requests. It never runs a provider for a request and never asks Jev on these routes. Every route here uses the existing `/api` authentication; COS Control's own inbox routes also answer only on the Mac itself.

## Capabilities

The activity and open-work answers carry `capabilities`:

| Field | Meaning |
| --- | --- |
| `progress: 1` | This server projects progress (below). An older server sends no `capabilities`. |
| `requests` | 1 only while COS Control is taking glasses requests: it listed pending requests in the last 120 s. Kept in memory, so after a restart it reads 0 until Control polls again. Offer Start work only on 1. |
| `requestsInbox` | 1 when the request inbox opened on this server. 1 with `requests: 0` means COS Control (0.5.252 or newer) is not running or not polling. |
| `requestsConsumerSeenAt` | When COS Control last listed pending requests (ISO), or null. |

Any future change to the request schema moves `requests` to 2.

## Progress on an item: `GET /api/work-board/activity?domain=<domain>&workIdentity=<12hex>`

Unchanged fields stay as they were (`id`, `workId`, `domain`, `status`, `provider`, `sessionId`, `sessionTitle`, `error`). The result gains `capabilities`, `taskRevision` (the task's own revision, below) and, when Control saved one, `savedDestination`, both at the top level. Each activity may also carry:

| Field | Meaning | From COS Control's journal |
| --- | --- | --- |
| `mode` | `continueSession`, `fork` or `newSession` | `mode` |
| `model` | The model slot it was sent with, when there was one | `modelID` |
| `createdAt` | ISO time the handoff was sent | `createdAt` (seconds since 1970) |
| `updatedAt` | The newest progress event, never earlier than `createdAt` | `progress.events[].at` |
| `progress.reported` | `done`, `needsInput`, `blocked` or `null` | `progress.reported` (an unknown kind reads as `null`, as Control reads it) |
| `progress.reportedBy` | `session` (its own status line) or `jev` (Jev read the reply) | `progress.reportedBy` |
| `progress.evidence` | At most 280 characters and 1,200 UTF-16 units | `progress.evidence` |
| `progress.receivedAt` | When the session was seen to have the work | `progress.receivedAt` |
| `progress.lastMove` | `{ from, to, at, undone }`: the newest move COS made | the newest `moved` event and its `undoneAt` |
| `progress.paused` | A manual move back (or an Undo) paused automatic moves | `progress.paused` |
| `progress: { unreadable: true }` | The progress block is there but the server cannot read it: there may be a report it cannot show | a malformed `progress` |
| `acknowledged` | You reviewed or acknowledged it | `acknowledgedAt` set, or status `reviewed` |
| `appOpened` | Its SESSION is owned by its app | any receipt naming the same session (Control's `sameSession`) was opened in its app (`appOpen.openedAt`), came from a 0.5.248 tab, or went to the app (channel `app`) |
| `serverHold` | The COS server is still running a Work New session on its SESSION | any receipt on the same session with channel `job`, mode `newSession`, not terminal |
| `waitingInApp` | A note for its SESSION is queued in its app; nothing reached the session yet | any receipt on the same session with channel `app` and status `queued` |
| `channel` | How Control delivered it: `job`, `fork`, `app`, `turn`, `queue` or `tab` | `channel` |
| `requestedFrom` | `glasses` when Control sent it from a glasses request | `requestedFrom` |
| `requestId` | The handoff request it answered | `requestId` (Control 0.5.252) |

`appOpened`, `serverHold` and `waitingInApp` look at every receipt in the journal that names the session, as Control's `appOwner` and `serverHold` do, and are false for a handoff with no session. `reportedBy` and `evidence` appear only with a report; show Jev's evidence as a reading, not as the session's words. Evidence is cleaned as a session name is (control characters, zero-width space, direction marks and overrides as spaces; joiners kept; whitespace, U+2028 and U+2029 included, collapsed).

Parsing is lenient for everything new. A malformed `progress` block reads `{ unreadable: true }` on its own (its `updatedAt` is then its `createdAt`); a malformed `appOpen` or `acknowledgedAt` reads as absent; a time no date can hold is left out. None of them makes the journal unavailable. Every check the server already made on the rest of the journal is unchanged, and so are the file protections (no symlinked file or folder, owner only, under 10 MB, never read in an isolated runtime).

A handoff COS Control 0.5.248 opened as a tab and never linked to a session (channel `tab`, `queued`, no session) reads as `canceled`, as Control reads it.

The board row behind `taskRevision` and `savedDestination` is read within 3 s (one read shared with the other glasses routes, kept for 10 s). Past that, or with no board, the activity still answers, without those two fields.

## Everything open: `GET /api/work-board/activity/open`

`{ version: 1, available, reason?, capabilities, items, total, truncated }`. Each item is an activity (as above) plus `workIdentity`, `domain`, `title` (the board row's; the receipt's work title is never returned), `taskRevision`, `group` and, when saved, `savedDestination`. It takes no parameters (400 `invalid_open_activity_request`).

An item is a board task (`task:<domain>:<12 hex>` with a row on the board) whose newest receipt (by time, then id; any revision) was sent in the last 14 days and falls in a group:

| `group` | When |
| --- | --- |
| `needsInput` | It reports needs input or blocked, and is not acknowledged |
| `attention` | It failed, was refused, is unknown (delivery unresolved), or completed with no report (an unreadable one included), and is not acknowledged |
| `running` | It is queued, running or delivered |
| `done` | It reports done, and is not acknowledged |

- A report counts only on a receipt that did not fail and was not refused or canceled, as Control's `WorkTracking.latest` reads it; such a receipt goes to `attention` (or nowhere, when canceled).
- A checked task shows only while its newest receipt is `queued` or `running`, as Control's board does. A task whose stage is Complete but that is not checked still shows.
- Order: the groups in the order above; within each, the newest `updatedAt` first, then the newest send. The list is cut to 50 after sorting; `total` counts every item and `truncated` says whether any were cut.
- The board is read within 5 s. Past that, or when the journal or board cannot be read, `available: false` with a reason.
- Read-only: no provider call, no Jev, no write.

`GET /api/work-board` also carries `taskRevision` on every task.

## Task revision

`taskRevision` is COS Control's own revision of the task: the SHA-256 of the context `WorkSource.taskSnapshot` builds from the row (its words, domain, Done when, source and meeting links). It changes only when that task changes, never when another card in the same domain file does. The server's computation is pinned to Control's Swift by `server/lib/__fixtures__/control-task-snapshot` (its `generate.sh` rebuilds the goldens).

## Saved destination

`savedDestination: { mode, provider, model?, sessionId? }` comes from COS Control's draft for the task's current revision; a draft saved before the task changed does not count, as in Control. It is present only when Control's `sendPlan` would send exactly that and a handoff request with it would pass the rules below:

- the draft's prompt is not empty and within Control's draft limit (31,520 UTF-16 units);
- Continue: a claude, codex or cursor session;
- a native Fork: a claude or codex session, whatever other provider the draft still holds;
- a Fork to the other platform: a claude or codex source, the other of the two as target, and a model slot of that target;
- New: a model slot whose provider is the draft's provider.

`provider` is always set. The draft's prompt is never returned.

## Handoff requests

The glasses leave a request, COS Control claims it and runs its own send with every guard it has (the journal fence, one active handoff per item, the status line, the session name, the server hold, the app owner, open in app). The requests live in `work-handoff-requests/requests.json` in the server data directory.

### Glasses: `POST /api/work-board/handoff-requests`

```
{ clientRequestId, domain, workIdentity, expectedTaskRevision, intent, mode, sessionId?, model?, note?, destinationSource, replyTo? }
```

- `clientRequestId`: a UUID v4 (either case; stored in lowercase). `domain`: a safe domain name. `workIdentity`: 12 hex. `expectedTaskRevision`: the task's `taskRevision`.
- `intent`: `start`, `reply` (Reply by voice) or `notDone` (Not done yet). Reply and Not done yet name `replyTo`, the item's newest receipt, continue the session that receipt went to, and carry a note; Start names no `replyTo`.
- `mode`: `continueSession`, `fork` or `newSession`. `sessionId` is exactly `provider:native`, with provider claude, codex or cursor and native a full lowercase session UUID (never a short id, a path, or another `provider:` inside). Continue works with claude, codex and cursor sessions and takes no model. Fork works from claude and codex sessions only; a model on a Fork is a Fork to the other platform and must be a slot of that platform. A New session names no session; without a model it takes the server's default (`COS_G2_DEFAULT_MODEL`, else `sonnet`), and the stored request names it. A model is a slot this server knows (`opus`, `fable`, `sonnet`, `haiku`, `codex-frontier`, `codex-balanced`, `cursor-grok`, `cursor-composer`, `ollama`).
- `note`: at most 2,000 characters after trimming. Newlines, tabs and the joiners U+200C and U+200D are kept. Refused (400, never cleaned): any other control character, U+2028 and U+2029, any other invisible format character (direction marks and overrides, zero-width space, soft hyphen, byte-order mark), a broken surrogate, and the text `COS-WORK` in any case (an agent quoting it back could move the card).
- `destinationSource`: `saved`, `jev` or `user`. A hint for COS Control's copy; Control never trusts it.
- An empty string or `null` counts as not given for `sessionId`, `model`, `note` and `replyTo`. Any other field, or a body over 16 KB, is refused.

Answers:

| Status | Code | When |
| --- | --- | --- |
| 201 | | Recorded as `pending`: `{ request }` |
| 200 | | The same `clientRequestId` and the same request again: the stored request, in whatever state it is now. Answered before the board is read |
| 400 | `invalid_handoff_request` | Anything malformed |
| 404 | `task_not_found` | No board row for that domain and work identity |
| 409 | `task_complete` | The task is checked |
| 409 | `request_id_conflict` | The same `clientRequestId` with a different request |
| 409 | `revision_changed` | This task changed since `expectedTaskRevision` |
| 409 | `reply_target_invalid` | `replyTo` is not this task's newest receipt, or the request continues a different session |
| 409 | `request_pending` | The item already has a pending or claimed request |
| 429 | `daily_cap` | 40 requests already made today, counted by the Mac's local day whatever became of them. The error carries `resetsAt` (the next local midnight) and the answer a `Retry-After` |
| 503 | `work_board_unavailable` | The board did not answer within 5 s or failed; `cause` says why (`work_board_timeout`, `cos_pipeline_not_configured`, ...). Nothing was created |
| 503 | `work_history_unavailable` | A reply's receipt cannot be checked: COS Control's journal cannot be read here |
| 503 | `handoff_requests_unavailable` | The inbox did not open on this server |
| 503 | `handoff_store_closed` | The server is shutting down |
| 503 | `maintenance_drain_active` | COS Control is draining the server for an update (the usual `/api` maintenance lease). This body is the maintenance shape, `{ error: "maintenance_drain_active", message, retryable: true, retryAfterSeconds? }`, with `Retry-After` when known; try again after it. Nothing was created |

After a transport failure or a timeout, GET the same `clientRequestId` before telling anyone anything: 404 means nothing was recorded.

### Glasses: `GET /api/work-board/handoff-requests/:clientRequestId`

`{ request: { clientRequestId, state, receiptId?, reason?, createdAt, expiresAt, claimedAt?, claimExpiresAt?, resultAt? } }`, never the note. `expiresAt` is `createdAt` plus 10 minutes, the last moment it can be claimed; `claimExpiresAt` is `claimedAt` plus 10 minutes, the last moment COS Control may send it. 404 `request_not_found` means the server no longer has the request (it keeps requests for 7 days).

| `state` | Meaning |
| --- | --- |
| `pending` | Waiting for COS Control on the Mac |
| `claimed` | COS Control took it and is sending |
| `sent` | Control sent it; `receiptId` names the handoff |
| `refused` | Control did not send it; `reason` says why |
| `unresolved` | Control sent it but cannot confirm delivery; `receiptId` names the handoff. "Delivery is unresolved. Check Work on the Mac." |
| `unconfirmed` | Control claimed it and did not report back within 10 minutes: it may or may not have been sent. "COS Control did not confirm. Check Work on the Mac before trying again." Never "Not sent" |
| `expired` | Nobody claimed it within 10 minutes. Nothing was sent |

### COS Control (on the Mac only: any other caller gets 403 `local_only`)

- `GET /api/work-board/handoff-requests?state=pending` returns `{ version: 1, requests, quarantined }`: the requests in full (intent, mode, session, model, note, reply target, destination source, claim deadline), oldest first, and how many unreadable records are set aside. `state` may be any state or left out; listing `pending` is what tells the glasses Control is taking requests.
- `POST /api/work-board/handoff-requests/:id/claim` (no body) is atomic: 200 `{ request, claimToken }` with the request now `claimed`; the same `{ claimToken }` again is 200 while the claim holds; 409 `already_claimed` otherwise; 410 `request_expired`; 404 `request_not_found`. Check `claimExpiresAt` immediately before sending, and never send after it.
- `POST /api/work-board/handoff-requests/:id/result` `{ state, receiptId?, reason?, claimToken }`:
  - `sent` needs `receiptId`; `refused` needs `reason` (and a `receiptId` when there is one); `unresolved` needs `receiptId`.
  - Taken for a claimed request, and once for an `unconfirmed` one (a result that arrives late).
  - The same result again is 200 with no change; any other is 409 `request_not_claimed`; a wrong token is 409 `claim_token_mismatch`; 410 `request_expired`.
  - The reason is cleaned (control characters as spaces) and kept to 500 characters.
  - Control should retry a result until the server accepts it.

### Time

- A pending request expires 10 minutes after `createdAt` and can never be claimed after that, so a Control that starts tomorrow never fires yesterday's tap.
- A claimed request with no result 10 minutes after the claim becomes `unconfirmed` and still takes one late result.
- A `createdAt` or `claimedAt` more than 5 minutes ahead of the server's clock counts as expired.
- These follow from the stored times on every read; the next write stores them. A read never writes. Each transition is logged once, with the request id and never the note.
- A request survives a restart and stays claimable until `createdAt` plus 10 minutes, whatever happened in between.

### Storage and recovery

One server process owns the file (`writer.lock`); writes are durable and atomic (a private temp file, fsync, rename). Requests and set-aside records older than 7 days are dropped on the next write; at 40 a day that is at most a few hundred. An unreadable record is set aside on its own (`quarantined`) and logged at start. An unreadable or unsafe file disables the inbox (503, `capabilities.requestsInbox: 0`) without stopping the server: keep the file for diagnosis, then move it aside to start empty.

Writes take the same maintenance lease as every short `/api` write, so they are refused while COS Control drains the server for an update. Nothing here holds a restart: a request that waits through one simply expires if it is not claimed in time.

Rolling back to a server before 6.59.0 leaves the file unread and these routes answer 404 there; COS Control and the glasses should read that 404 as a server without the inbox.

### Logs

Every refusal of a claim or a result, every 5xx (with the board's `cause`), each expiry and each claim that went unconfirmed are logged as `[work-handoff-requests] ...` with the request id and code, and the activity routes log `[work-board] ...: answered without the board (<cause>)`. A note is never logged.

## Privacy

Responses never carry a receipt's `prompt`, `detail`, `result` or work title, a progress event's text, or a draft's prompt. Two projected fields are session text: `sessionTitle` (projected since 6.56.0) and `evidence`, up to 280 characters of the session's status line or Jev's reading (Miles approved this on 2026-09-30). A request's note goes back only to COS Control's list and claim, and to the glasses that sent it (in the create answer), never in the status view.

A Continue into a busy session queues on the Mac and may reach the session later; `claimExpiresAt` bounds when Control sends, not when a queued turn runs.

## Verification

`npx vitest run server/lib/work-activity.test.ts server/routes/work-board.test.ts server/lib/work-handoff-requests.test.ts server/routes/work-handoff-requests.test.ts` covers the projection, the open list, the task revision (against Control's own Swift output), the saved destination, the inbox and its routes. `node server/scripts/work-progress-mutation-gate.mjs` runs its mutations in a private copy, refuses to start on a red baseline, and requires each mutant to fail the test named for it.
