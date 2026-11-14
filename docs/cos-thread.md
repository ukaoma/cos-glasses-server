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

## Thread-only chats (7.0.39 candidate 2)

`POST /api/query-jobs` with `source: 'web'` and `cosThread: true` is an Ask from the pinned thread. The page sends it only
when `/api/health` says `features.cosThreadOnly: true` (durable jobs on AND Drop it on); on an older server, or with
Drop it off, the Ask stays an ordinary numbered one and is never lost.

| What | Rule |
| --- | --- |
| Number | none: nothing minted, nothing reserved, so the lens list has no gap and `/api/message-counter` does not move |
| Conversation | a thread conversation (`Session.cosThread`), kept when the asked `sessionId` is one, else a new one; a Retry (next generation) stays in its first try's conversation; saved durably before the job is admitted |
| Lists | absent from `all-messages`, `live-chats`, `sessions/recent`, the archive routes, the session cache and `/api/message/:n` (they all read `getActiveSessions` or the archive) |
| Archive | a thread conversation is never written to a day file (daily mirror, clear, end, `POST /archive/now`) |
| Display bus | no `start`, `done` or `error` event, so the lens never lists it |
| Model | unchanged: the conversation's history builds the prompt like any other |
| Refusals | `cosThread` while Drop it is off: 409 `cos_thread_off`. `cosThread` without `source: 'web'`: 400 `cos_thread_web_only`. A non-thread Ask naming a thread conversation, on `/api/query-jobs` or the legacy `POST /api/query`: 409 `thread_session_web_only`. `cosThread` other than `true`: 400 `invalid_cos_thread` |

**The thread keeps it.** When the job starts (not at the 202: no admission hook exists without `index.ts`), the question
becomes the thread's turn; until it appears in history the page keeps its own pending bubble. When it ends, in any status, an
answer row is appended: the status, the first 2,000 characters, the length, and, for a completed answer longer than that,
where the whole answer is in `cos-thread/answers/YYYY-MM.jsonl` (with its SHA-256). `GET /cos-thread/entry/:id` reads it
from there (`source: 'ledger'`).

**Entry fields for a job chat:** `status` (`running`, `completed`, `failed`, `interrupted`; `canceled` reads `interrupted`),
`clientJobId` and `generation` (reattach through `/api/query-jobs/by-client`, Retry with the next generation), and for a
failed or interrupted one the partial answer's first 2,000 characters. A running chat with no end after 6 hours reads
`interrupted`.

**Never lost.** The job journal is the authority. The thread's answer row is written inside the terminal projection, which
the coordinator runs for every terminal job and again at every boot for each retained one, so a crash between the
journal's terminal fsync and the thread write is repaired on the next boot. A later end of the same generation replaces
an earlier one (a boot ends a job caught mid-start `interrupted`, then resumes it to `completed`); an identical end is
skipped. Tested by killing the process at each step (`server/lib/cos-thread-never-lost.test.ts`).

**Cursors.** `newest` is `c1.<chats>.<ends>`. `after=<newest>` answers new chats in `entries` and, in `updated`, chats
already sent whose job ended since. When the byte cap cuts `updated`, `newest` stops at the last end sent and `more` is
true, so the next read carries the rest. A cursor without the second part (candidate 1, or `older`) still works.

**`GET /api/cos-thread?threadOnly=1`.** A page that sends `cosThread` reads the thread this way. When the thread's
conversation is not a thread conversation (one from before the update, numbered, in Messages), the next Ask starts fresh
with the digest (`reason: 'thread_only'`) instead of continuing it. Without the parameter, as before.

**Public apps unchanged.** `server/routes/public-reads-golden.test.ts` holds the reads the Mac app and the glasses app make
to the bytes 7.0.38 (1737c815) answered, with and without thread conversations on disk.

## Timeline (7.0.39 candidate 3)

Breadcrumbs beside the chats: a time, a kind, one short line and a reference to the source; never a body. Advertised as
`capabilities.dropIt.thread.timeline: 1`. Nothing from the timeline enters a chat's context, and no model is called.

`GET /api/cos-thread/history?timeline=1[&kinds=chat,notification,session_question,meeting,message]&before|after&limit`
answers chats and breadcrumbs together, ordered by time (a backfilled breadcrumb sits at its own time). Without
`timeline=1` the route answers exactly as before (chats only, `c1` cursors), so a page that does not ask never sees one.

| Cursor | Use |
| --- | --- |
| `older` = `c2.<ms>.<tie>` | `before=`: the page just before that place in time |
| `newest` = `c3.<chats>.<ends>.<crumbs>.<outcomes>` | `after=`: new chats and breadcrumbs (in `entries`), and entries already sent whose chat end or breadcrumb outcome changed (in `updated`). A cut page counts only what it carried, with `more: true` |

A `c1` cursor is refused here (`invalid_cursor`); unknown kinds are `invalid_kinds`.

```json
{ "id": "b:<20 hex>", "at": "ISO", "kind": "notification", "line": "the title, one line, 160 at most",
  "ref": { "type": "notification", "id": "fi_…", "threadId": "…" },
  "outcome": "seen | replied | dismissed | acted | closed", "reply": { "type": "notification", "id": "fi_…" } }
```

| Kind | Line | Ref | Outcome |
| --- | --- | --- | --- |
| `notification` | the ping's or follow-up's title (or line) | `{ type: 'notification', id, threadId }` | `replied` (with `reply`), `acted` (a reminder button), `dismissed` (a ping closed unanswered), `closed` (a follow-up done; a newer one can retire it), `seen`, or none |
| `session_question` | the question (80 characters), from turn-end-ask's callback when the build has it | `{ type: 'session', provider: 'claude', id }` | `answered` (with `answer`, 80 characters, and `by`), `moved_on`, `session_ended`, `aged_out` |
| `meeting` | the meeting's title | `{ type: 'meeting', domain, month, filename }` (the web's `#/meetings/<domain>/<month>/<filename>`) | none |
| `message` | the question's first 60 characters (the number is in the ref; the page writes the words) | `{ type: 'message', no, era }`, plus `surface` (`web`) only for a turn whose own admission was a plain Control Web Ask (recorded per turn, never per conversation). The glasses and the Mac app send nothing that says which they are, so their turns carry no surface, even in a conversation the web started | none |

**Storage.** `cos-thread/timeline.jsonl`, append-only (one crumb per source key, one outcome row per change), and
`timeline-state.json` for which archive and meeting days were swept. The words live only there; nothing is logged.

**The sweeper.** Started by the thread routes on first use (so only with Drop it on), 5 s after, then every 60 s while a
backfill is behind and every 5 minutes after. Each pass reads, read only: the inbox feed file, the live conversations
(thread ones left out), at most 10 archive days (files over 32 MB skipped) and at most 31 meeting days whose count
changed. Older days are read once; today is read every pass. It backfills what the stores hold and invents nothing.

**Drop it off.** The sweeper reads Drop it before every pass. Found off, the pass reads and writes nothing, schedules
nothing and drops the session-question listener (a question arriving while off is ignored), so off means off without a
restart. The thread routes answer only while it is on and start the sweeper on each request, so turning it back on
resumes on the next one. An archive day that cannot be read or parsed is retried on the next passes and given up after
three; a known skip (a link, over 32 MB, gone) is done at once.

## Not yet (later candidates)

- **COS's own look-back read** by time window.
