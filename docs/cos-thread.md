# The COS thread: history routes

The pinned COS chat in Control Web is one persistent thread. This file is the contract for the routes the page reads.

- **Store:** `server/lib/cos-thread.ts`.
- **Routes:** `server/routes/cos-thread.ts`.
- **Design:** S1 and W1, 2026-11-14 (`lanes/S1_cos_thread_server_design.md` and `lanes/W1_cos_thread_routes_proposal.md` in the MU repo).

## Gate and capability

- Every route lives under `/api` with its auth.
- Every answer is `Cache-Control: private, no-store`.
- While Drop it is off, every route answers 404 `drop_it_off` and creates no file.
- `capabilities.dropIt.thread` is `{ protocol: 1, history: 1 }` while Drop it is on.
  - `history: 1` means the two routes below exist.
  - `protocol` stays exactly 1, because a 7.0.37 page turns the thread off unless it is 1.

## GET /api/cos-thread/history

Every chat of every thread, past and present, closed threads included. Each closed thread is an earlier stretch, told apart by `threadId`.

| Query | Meaning |
| --- | --- |
| none | the newest page |
| `before=<cursor>` | the page that ends just before the cursor (scrolling up) |
| `after=<cursor>` | what was added from the cursor on (the open pane's poll) |
| `limit` | 1 to 100, default 40 |

- **Errors:**
  - `before` and `after` together: 400 `invalid_cursor`;
  - a cursor this route did not give out: 400 `invalid_cursor`;
  - a bad limit: 400 `invalid_limit`.
- **A cursor past the end** reads as the end.
- **Cursors** are opaque strings. They stay valid across restarts, because the ledger is append-only.

```json
{ "protocol": 1,
  "entries": [{ "id": "t:<clientId>", "at": "ISO", "kind": "chat", "question": "…", "answer": "… (preview)",
                "answerChars": 412, "full": true, "threadId": "th_…", "status": "completed", "messageNo": 472 }],
  "older": "<cursor> | null",
  "newest": "<cursor>",
  "more": false,
  "updated": [] }
```

- **Order:** entries run oldest to newest within a page.
- **Byte cap:** a page also stops at 256 KB of entries, so it can hold fewer than `limit`. It always carries at least one entry when one is due.
- **`older: null`** means the start of the history.
- **`more`:** an `after=` page stopped at its limit or its byte cap, and more entries follow. Ask again from `newest`.
- **`answer`** is the preview the ledger keeps, the first 2,000 characters.
  - `full` says whether the preview is the whole answer.
  - `answerChars` is the whole answer's length when known, otherwise null.
- **`updated`** lists entries already sent whose outcome changed since the cursor. It is always empty until timeline entries exist.
- **Old rows:** rows recorded before the server kept whole answers read `status: 'completed'`, and `full` is true only when the preview is shorter than its cap.

## GET /api/cos-thread/entry/:id

One chat, `t:<clientId>`, with its whole answer:

```json
{ "entry": { …as above, "answer": "the whole answer", "answerChars": 5210, "full": true }, "source": "ledger | live | archive | preview" }
```

- **Where the answer comes from, in order:**
  1. the ledger, when its preview is the whole answer;
  2. the live conversation;
  3. the day archive;
  4. otherwise the preview, with `full: false`.
- **Archive read:** read only. It reads the turn's own local day and up to 31 later days, never past today. It skips any file over 32 MB and stops at 96 MB in all. It never creates or quarantines a file.
- **Answer cap:** an answer over 1,000,000 characters is cut and reads `full: false`.
- **Errors:** 400 `invalid_entry` for an id that is not `t:<clientId>`; 404 `entry_not_found` for one the history does not hold.

## Not yet (later candidates)

- **Thread-only chats** (`cosThread: true` on `POST /api/query-jobs`): no message number, nothing on the display bus, kept out of Recent and the archive, and the whole answer kept at the job's end.
- **Timeline entries:** notifications, session questions, meetings and glasses chats.
- **COS's own look-back read** by time window.
