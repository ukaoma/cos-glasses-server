# In-flight query jobs: `GET /api/query-jobs/active` (6.84.1)

COS Control's Activity home shows the questions COS is answering right now in its Running panel. This route lists them. It is read-only, answers from memory, and never carries a prompt body, an answer, tool output or the trail.

## Detecting it

`GET /api/health` (public) carries two fields in `features`:

| Field | Meaning |
| --- | --- |
| `activeQueryJobs: true` | This server has the route. Static: present on every 6.84.1 and newer server. |
| `activeQueryJobsProtocol: 1` | The answer shape below. Any breaking change moves it to 2. |

Absent on older servers. Key off the field, not the status code: an older server answers `GET /api/query-jobs/active` with **400 `invalid_job_id`** (its `/query-jobs/:jobId` route reads `active` as a job id), not 404. A client that sees no `features.activeQueryJobs` hides the rows and does not call the route.

`features.durableQueryJobs` still says whether jobs run at all. With it false the route answers `enabled: false` and an empty list.

## Request

`GET /api/query-jobs/active` with `X-Cos-Token`, the same authentication as every other `/api` route (401 `unauthorized` without it). No query parameters. Safe to call every 60 seconds.

## Answer

Values are illustrative.

```json
{
  "protocolVersion": 1,
  "enabled": true,
  "now": "2026-10-21T22:05:12.204Z",
  "count": 2,
  "items": [
    {
      "jobId": "3f6c0b1e-5d2a-4c7e-9a41-0b7d2e6f9c11",
      "generation": 1,
      "origin": "person",
      "state": "running",
      "status": "running",
      "acceptedAt": "2026-10-21T22:04:40.118Z",
      "startedAt": "2026-10-21T22:04:40.391Z",
      "elapsedMs": 32086,
      "provider": "claude",
      "model": "opus",
      "resolvedModel": "claude-opus-4-8",
      "messageNo": 1287,
      "title": "What did Graham say about the October webinar numbers?"
    },
    {
      "jobId": "9b2a7d40-1c3e-4f58-8e2d-6a0c4b9e7f21",
      "generation": 1,
      "origin": "routine",
      "originId": "morning-brief",
      "state": "queued",
      "status": "accepted",
      "acceptedAt": "2026-10-21T22:05:01.950Z",
      "elapsedMs": 10254,
      "model": "sonnet",
      "messageNo": 1288,
      "title": "Write my morning brief for Wednesday, October 22"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `now` | Server time (ISO) the list was read. `elapsedMs` is measured to it. |
| `count` | Every job admitted and not finished. It can be larger than `items.length` (see Bounds). |
| `items` | At most 50, oldest first (`acceptedAt`, then `jobId`). |

Each item:

| Field | Meaning |
| --- | --- |
| `jobId`, `generation` | The job, as `GET /api/query-jobs/:jobId?generation=` reads it. |
| `origin` | Who asked, as far as the job record can tell (below). |
| `originId` | The routine slug or the task id. Only with `routine` and `task`. |
| `state` | `queued` (admitted, waiting for an earlier run in its session, a fence or a drain), `running` (starting or answering) or `finishing` (the answer is written and being committed). |
| `status` | The job model's own value: `accepted`, `starting`, `running` or `answer_ready`. |
| `acceptedAt` | When the server admitted it. |
| `startedAt` | When the provider started. Absent while queued. |
| `elapsedMs` | Milliseconds from `acceptedAt` to `now` (the person's wait), never negative. |
| `provider` | `claude`, `codex`, `cursor` or `ollama`, once known. |
| `model` | The model asked for: a slot such as `opus`, or `profile:<id>` for a key profile. |
| `resolvedModel` | The model the provider reported, once it started. |
| `messageNo` | The message number the phone minted for the question. Absent on jobs without one. |
| `title` | Plain text, at most 80 characters (below). |

Finished jobs (`completed`, `failed`, `canceled`, `interrupted`) are never listed or counted.

### `origin`

The phone app sends a question typed on the phone and one spoken on the glasses the same way: no `origin` field, with a message number. The `g2` label the phone keeps locally never reaches the job record (the server drops a bare-string origin and counts it), so the server cannot tell the two apart and does not guess.

| Value | When |
| --- | --- |
| `person` | No `origin`, and the job carries a message number: asked on the phone or the glasses. |
| `routine` | `origin.kind` is `routine` (the morning brief, the routines scheduler). |
| `task` | `origin.kind` is `task` (a dispatch of a captured task). |
| `other` | Anything else: no origin and no message number (a COS Control Work session, a meeting review). |

For the Running panel, `person` is the glasses-or-phone question. A client that needs the glasses only must ask the phone; the server has no way to know.

### `title`

The first non-blank line of the prompt, from the first 1,000 characters only. It is redacted with the job store's credential and local-path patterns (`[redacted]`, `[path]`), flattened to one line (control and invisible characters become spaces, runs of spaces collapse) and cut to 80 characters counted as grapheme clusters, the ellipsis (`…`) included, back to a word break when one falls in the second half. An emoji is never split. A job COS Control started with a session name (a Work session on Claude) uses that name instead, under the same rules. A job with only attachments has an empty title; the client shows its own fallback.

Never in the answer: the rest of the prompt, the reference turn, the partial or final answer, tool status and activity lines, the trail, steers, the session id, attachments and error text.

## Cost

The route reads the job store's in-memory identities and hydrated records (`QueryJobStore.listInFlight`, the same synchronous walk `/api/message-counter` already does on every phone send). It does no hydration, no journal or disk read, no await, and starts no timer. The work per call is one pass over the retained identities plus one title per in-flight job, each from at most 1,000 characters.

## Bounds

- At most 50 items per answer; `count` is the full number.
- A live job whose record the store has evicted from memory (only possible past 500 hydrated jobs, and terminal ones are evicted first) is counted in `count` but not listed, rather than read back from disk.
- Before the store finishes booting the list is empty.
- The legacy streaming `POST /api/query` route does not create a durable job and is not listed.

## Tests

`server/routes/query-jobs-active.test.ts` (route and title rules) and `server/routes/health-query-jobs.test.ts` (the capability). `server/scripts/active-query-jobs-mutation-gate.mjs` mutates the exclusion, count, truncation, title, origin, state, cap, order, route and capability guards one at a time against a green baseline (not packaged).
