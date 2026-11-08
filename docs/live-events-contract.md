# Live events contract (`GET /api/events`)

Status: shipped in server 7.0.1 (private; server half from `claude/live-state-server`, client half from `claude/live-state-web`). This file is the contract the
Control Web client codes against. If the server changes a shape, it changes here first and the change log at the end
says what moved.

## Why

Control Web paints from caches and polls on separate timers, so the pet, the session rows, Today's counts and the
running clocks drift between fetches (Miles, 2026-11-07). This stream tells an open page **when the server's own
session state changes**, within about a second, so the page can correct itself without polling faster.

It is a change feed, not a replacement for the list. Titles, last lines, files and everything else with words in it
still come from `GET /api/agent-sessions` and friends. The stream carries **ids, states, counts and times only**.

## Route

```
GET /api/events
```

- **Auth:** the same `/api` gate as every other route: the `X-Cos-Token` header, or the Control Web session cookie.
  `EventSource` sends the cookie on a same-origin request, so the web client needs no token. A request with neither
  gets the gate's ordinary `401 { reason: "pairing_token_rejected" }` JSON, before any stream headers.
- **Switch:** `COS_WEB_LIVE_EVENTS`. Absent or anything but `0`: on. `0`: the route is not registered at all, so the
  request falls through to the normal 404. Read once at server start. A client that gets 404 (or any non-200, or a
  non-`text/event-stream` answer) uses today's polling, which is also what it does against a server older than 7.0.1.
- **Capacity:** at most `LIVE_EVENTS_MAX_STREAMS` (16) open streams per server. One more closes the **oldest** open
  stream to make room, and the server logs it with the open count (a peer that vanished behind Tailscale would
  otherwise hold its slot until TCP gives up). The closed client sees its stream end and reconnects with its last id.
  Only when no stream can be closed does a request answer `503 { reason: "live_events_capacity" }` JSON, before any
  stream headers (also logged). The client then falls back to polling and retries later (back off to 30 s or more).
- **Response headers:** `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`,
  `X-Accel-Buffering: no` (the same set `/api/agent-sessions/:p/:id/stream` uses through Tailscale Serve), and the
  first bytes are `retry: 3000`.

## Frames

Every frame is one `data:` line holding one JSON object. There are **no named SSE events and no comment keepalives**:
one handler reads every frame, the same rule as the per-session stream. Frames that change state, and the snapshot, also
carry an SSE `id:` line so the browser's `EventSource` resends it as `Last-Event-ID` on its own reconnect. `heartbeat`
and `resume` never carry one.

```
id: 1762578000123.42
data: {"kind":"session","seq":42,"epoch":1762578000123,"at":1762578001000,"change":"updated","session":{...}}
```

Common fields on every frame:

| field   | type   | meaning |
| ------- | ------ | ------- |
| `kind`  | string | one of the kinds below. Ignore kinds you do not know. |
| `seq`   | int    | **Server-wide, monotonic within one server life (`epoch`).** State frames take the next number. `heartbeat` and `resume` repeat the newest number without taking a new one, so a client that sees a `seq` above the last one it applied has missed something and should reconnect (which resumes or snapshots). |
| `epoch` | int    | Server life id (ms at hub start). A different epoch means the server restarted: everything you hold is from a previous life. |
| `at`    | int    | Server clock, ms since 1970, when the frame was written. Use it to estimate clock skew for running-time ticks (see Times). |

Unknown fields must be ignored. New fields may be added without a contract version bump.

### `snapshot`

The whole live model. Sent first on a fresh connect, and on a resume the server cannot honour (see Resume). Replace
your live model with it. **It carries `id: <epoch>.<seq>`** (its `seq` is the newest state it includes, which can be
0 on a server that has seen nothing yet), so a reconnect that sends it resumes from there instead of asking for
another whole snapshot.

```json
{
  "kind": "snapshot", "seq": 42, "epoch": 1762578000123, "at": 1762578001000,
  "sessions": [ LiveSession, ... ],
  "questions": { "total": 1, "approvals": 0, "bySession": [ { "provider": "claude", "sessionId": "…", "count": 1 } ] },
  "queue": { "total": 2, "bySession": [ { "provider": "claude", "sessionId": "…", "count": 2 } ] },
  "degraded": { "registry": false, "questions": false, "queue": false }
}
```

`degraded.<source>: true` means that source could not be read on the last tick. Do not read its absence as "nothing
running" / "nothing waiting"; keep the polled value and show it as not live.

### `session`

One session was added or changed. Upsert by key (see Ids).

```json
{ "kind": "session", "seq": 43, "epoch": 1762578000123, "at": 1762578002000, "change": "added" | "updated", "session": LiveSession }
```

### `session.removed`

A session left the live model: it has been `ended` for `LIVE_ENDED_LINGER_MS` (10 minutes). A session whose registry
record and hook record are both gone is first marked `ended` (a `session` frame) and lingers the same 10 minutes; there
is no immediate removal. Remove it from live counts. It may still be in the list as a recent session.

```json
{ "kind": "session.removed", "seq": 44, "epoch": 1762578000123, "at": 1762578003000, "provider": "claude", "sessionId": "…" }
```

### `questions`

The set of questions and approvals waiting in the permission broker changed (one opened, was answered, timed out or
was withdrawn). Same shape as the snapshot's `questions`, at the top level. Treat it as the new total; then refresh
`GET /api/session-questions` for the cards themselves (the stream never carries question text).

```json
{ "kind": "questions", "seq": 45, "epoch": …, "at": …, "total": 0, "approvals": 0, "bySession": [] }
```

### `queue`

Waiting follow-up messages (the thread turn queue) changed. Same shape as the snapshot's `queue`.

```json
{ "kind": "queue", "seq": 46, "epoch": …, "at": …, "total": 1, "bySession": [ { "provider": "codex", "sessionId": "…", "count": 1 } ] }
```

### `heartbeat`

Every `LIVE_EVENTS_HEARTBEAT_MS` (15 s). No `id:` line; `seq` is the newest state seq. **No frame of any kind for
30 s means the stream is dead**: close it, mark the page "Reconnecting", poll the summary every 5 s, and reopen with
the last `id` you applied.

```json
{ "kind": "heartbeat", "seq": 46, "epoch": …, "at": … }
```

### `resume`

Sent after a successful replay (see Resume) so the client knows its model is current. No `id:` line.

```json
{ "kind": "resume", "seq": 46, "epoch": …, "at": …, "replayed": 3 }
```

## `LiveSession`

```json
{
  "provider": "claude" | "codex" | "cursor",
  "sessionId": "8c1d2f9e-…",
  "state": "working" | "waiting" | "idle" | "ended",
  "startedAt": 1762577000000,
  "turnStartedAt": 1762577900000,
  "updatedAt": 1762578001000,
  "replies": 3,
  "questions": 0,
  "queued": 0,
  "source": "hook" | "registry",
  "failed": true
}
```

| field | meaning |
| ----- | ------- |
| `state` | `working`: the agent is generating now. This is the same test as a list row's `running_active` (the pet's and Running card's test): an open turn whose engine last spoke inside the hook activity cap. One approximation: a Claude tab with no hooks whose registry says `busy` is `working` without the transcript clock the list reads. For Codex and Cursor, `ended` and the open window are the hook window only (open while a hook spoke in the last 30 minutes or a turn or wait is open); the list's process check decides whether such a session is open, so a client takes only working, waiting or idle and the times from the stream for those providers. `waiting`: the agent is blocked on the user (a permission prompt, a question, a plan, MCP input). `idle`: open, not working. `ended`: the engine said the session ended; it lingers 10 minutes as `ended`, then a `session.removed` follows. |
| `startedAt` | When this session was first seen (registry `startedAt` for a Claude tab, else the first hook event this server heard). ms, or `null`. |
| `turnStartedAt` | When the current turn started (the prompt that opened it). ms while `state` is `working` or `waiting`, else `null`. **Tick the running clock locally from this**: `elapsed = Date.now() - skew - turnStartedAt`, where `skew = Date.now() - frame.at` measured on the frame you got it in. |
| `updatedAt` | The newest thing the server heard for this session (a hook event or a registry status move), ms. Changes that touch only `updatedAt` are coalesced to at most one `session` frame per session every `LIVE_ACTIVITY_MIN_MS` (5 s); every other change is sent at once. |
| `replies` | Turns that ended (a reply landed) **since this server started**, from the engine's Stop events. It only goes up within one `epoch`. Use a change to know a new reply landed and refresh that session's detail; do not show it as a lifetime count. |
| `questions` | Questions and approvals waiting in the broker for this session. |
| `queued` | Waiting follow-up messages for this session. |
| `source` | `hook`: the engine's own hooks spoke for this session. `registry`: a Claude tab known only from `~/.claude/sessions` (no hooks yet); its state is the registry's status. |
| `failed` | Present and `true` only when the last turn stopped on a failure. `state` is then `idle`. No failure text is sent. |

**Never sent:** titles, prompts, replies, tool names or inputs, file names, paths, cwd, workspace or project names,
model names. Ids, states, counts and times only, the same privacy as the pet.

### Ids

The key is `provider + ":" + sessionId`, with `sessionId` lowercase.

- `sessionId` is the full id the server has. For a Claude tab that is the registry's full UUID.
- **Match a list row to a live session by provider plus the full id**, lowercase.
- The list (`GET /api/agent-sessions`) sometimes carries a Claude tab under the registry's **8-character** short id
  until it finds the transcript. Use the 8-character prefix **only when one side is exactly 8 characters long, and only
  when exactly one candidate matches**, the rule `countFor` uses on the server. Never join two full ids on their
  prefix: Codex ids are UUIDv7, whose first 8 characters are a millisecond timestamp's top bits and stay the same for
  about 65 seconds, so parallel Codex sessions started together share them.

## Resume

Send the last applied `id` (`<epoch>.<seq>`) as the standard `Last-Event-ID` header (the browser's `EventSource`
does this itself on its own reconnect) or as `?after=<epoch>.<seq>` (for a manual reconnect, since `new EventSource`
cannot set headers). The query wins when both are present.

- Same epoch, and the ring (`LIVE_EVENTS_RING_SIZE`, 512 frames) still holds the frame right after `seq`: the server
  replays every state frame after `seq` in order, then sends `resume`. No `snapshot`.
- Same epoch and `seq` equals the newest: nothing to replay; `resume` with `replayed: 0`.
- Anything else (another epoch, a `seq` older than the ring, a `seq` from the future, a malformed id): a fresh
  `snapshot`, exactly like a first connect.

## Backpressure

A stream whose unsent bytes pass `LIVE_EVENTS_MAX_BUFFER_BYTES` (256 KB) is closed by the server rather than
buffered without limit. The client sees the stream end, and reconnects with its last id (a resume when the ring still
reaches back, else a snapshot).

## What feeds it (server side, for reviewers)

- **Hook signals** (`sessionSignalStore.subscribe`): Claude, and Codex and Cursor sessions whose hooks reach the store.
  Pushed; a change is flushed within `LIVE_FLUSH_MS` (150 ms). **A push rebuilds only the hook-derived readings**
  (from the in-memory signal store, against the registry as the last tick read it). It reads no registry file, broker
  or queue file; those wait for the tick. So a brand-new Claude tab can take up to one tick (2 s) to appear.
- **A bounded diff tick** every `LIVE_TICK_MS` (2 s), **only while at least one stream is open**, over things with no
  change signal: the Claude registry (`~/.claude/sessions`, small JSON files, the same read the per-session stream
  does), the permission broker's in-memory list, the queue files, and the clock (an open turn that goes quiet past the
  activity cap stops being `working`). No stream open: no tick and no reads. The hub's one subscription (the reply
  counter, one Map increment per Stop) is made when the hub is built and stays for the server's life.
- **A registry folder that exists but cannot be read** marks the registry `degraded` and keeps the last good model; it
  is never read as "nothing alive". A missing folder is an empty registry.
- **Not fed (known gap):** a Codex or Cursor session whose hooks have never reached this server. Those rows still
  appear through the list poll, as today. The client should keep a slow list refresh (the existing pane-load refresh,
  plus a debounced refresh on `session` added/removed) so they are not missed.

## Client checklist (what the web half owns)

1. One `EventSource('/api/events')` per page, shared by the pet, Sessions rows, Today counts and question cards.
2. Paint from cache first; apply `snapshot` as the live truth; apply `session`/`session.removed`/`questions`/`queue`.
3. Running time ticks locally from `turnStartedAt` (skew-corrected by `at`), no polling.
4. On `session` added or removed: debounced (about 1 s) refresh of `GET /api/agent-sessions` for the words. On a
   `replies` change: the same refresh, at most once every 12 s. On `questions`: refresh `GET /api/session-questions`.
5. 30 s with no frame: "Reconnecting", poll the summary every 5 s, reopen with `?after=<last id>`. **Overlay the live
   model on list reads only while a stream is open and live.** Reconnecting, busy or hidden, the list read is the
   newest truth: show it as read, drop placeholder rows, and keep the model only as the base a resume applies to.
6. `visibilitychange` to visible and `pageshow`: re-read the summary at once, then reopen the stream with the last id.
7. 404 or 503 or a non-stream answer: polling, as today. 503 `live_events_capacity`: retry after 30 s or more.
8. Counts from a cache older than 30 s show their age.

## Today summary refresh (same release)

- `POST /api/today/brief` body gains an optional `"force": true` (the Today refresh button). It skips the 10 minute
  interval and the "inputs unchanged" check, and still honours the switch, recording, drain, breaker and the 60 a day
  cap. Forced asks are limited to one per `TODAY_BRIEF_FORCE_MIN_MS` (30 s); a second inside that answers the current
  view with `reason: "refresh_throttled"` and `retryAfterMs`. The answer is the usual brief view.
- The summary is now written by Sonnet (`model: "sonnet"` in the view), was Haiku.

## Change log

- 2026-11-07 23:2x: first version (server lead, before build). Shapes may still gain fields; none will be removed
  without a line here.
- 2026-11-07 23:3x: built as written (commits 7dbdf7f, 86619e0 and the follow-up). Clarifications, no shape change:
  - The FIRST stream on an idle server primes the model, so its ring starts with one `session` `added` frame per open
    session (seq 1..N) before the snapshot's seq. A fresh page gets the snapshot only; a resume from inside that range
    replays those `added` frames, which upsert cleanly.
  - `startedAt` is fixed while a session is in the model (the registry and the hooks can disagree by seconds).
  - A Claude tab's `ended` can arrive as two `session` frames (the registry record going, then the hook's SessionEnd):
    treat `ended` as idempotent.
  - Measured on a scratch server: hook event to frame 103 to 232 ms (http and https), a killed session's `ended`
    within about 0.5 s, a clean exit's `ended` within one 2 s tick.
  - Today refresh: `force: true` on `POST /api/today/brief` landed in 86619e0 (the route takes `force` off the body
    before the rows are checked, so the 7dbdf7f-era "unknown key" refusal is gone). A non-boolean `force` is 400.
  - Today refresh: Sonnet measured at $0.016 to $0.018 a call (Haiku $0.0008); `retryAfterMs` is whole ms, at most
    30000.
- 2026-11-07 23:4x: **the `snapshot` frame now carries `id: <epoch>.<seq>`** (asked by the web half). Additive: a
  client that builds its last id from `epoch` and `seq` sees the same value.
- 2026-11-08 01:xx (7.0.1 review fixes, no shape change):
  - **Ids: join on the full id.** The 8-character prefix only when one side is exactly 8 characters and one candidate
    matches (skeptic B1: three Codex UUIDv7 rollouts started 16 s apart shared their first 8 characters).
  - Capacity: at the cap the oldest stream is closed instead of refusing the newest; evictions and refusals are logged.
  - A hook push rebuilds hook readings only; the registry, broker and queue are read on the tick.
  - An unreadable registry folder is `degraded`, not "nothing alive".
  - `session.removed` wording matches the code (a vanished session lingers as `ended` first).
  - Client: overlay only while live; non-Claude open or closed from the list; reply-triggered list reads at most once
    every 12 s.
