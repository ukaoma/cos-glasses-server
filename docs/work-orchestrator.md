# Work orchestrator (server 6.83.0, COS Control 0.5.333)

Plan: `operations/personal/wk43_2026/PLAN_work_orchestrator_glasses_work_routines_2026-10-20.md` (MU repo), approved by
Miles 2026-10-20 21:55. Canaries: `CANARY_C1_usage_2026-10-20.md`, `CANARY_C2_C4_orchestrator_2026-10-20.md`.
This milestone is M1 plus the planner-input parts of M2 (pick-up notes) and M3 (plan usage).

## Phase A: how Work state reaches the server (decided 2026-10-20)

Work state lives in COS Control today: confirmed links in `work-handoffs/handoffs.session-cards.json`, the receipt
journal in `handoffs.json` (flock'd, compare-and-swap writes, 10 MB cap), and Work chat rounds in `task-chat/*.json`.
The planner runs in the server. Two ways to join them were on the table.

| | A. Control pushes a snapshot through the helper | B. The server reads Control's files on this Mac |
| --- | --- | --- |
| Who owns the bytes | Control writes, under its own journal lock; the server keeps a copy | The server reads a journal Control may be writing (it would have to speak Control's lock and CAS protocol) |
| Contract | A versioned, bounded snapshot with only what discovery needs | Control's private schema, which gains fields almost every release |
| Paths | None hardcoded in the server | The server hardcodes `~/Library/Application Support/COS Control/...` (the "multi-user path" rule) |
| Phone, lens, cloud workers | Read the server's copy | Cannot: a cloud worker never sees a Mac file |
| Freshness | Pushed right before every plan, and after each recorded handoff | Always current on this Mac |
| Privacy | Ids, modes, statuses, times. Never prompts, results or file names | Everything in the journal, prompts included |

**Decision: A.** Control pushes a snapshot on change through the helper (`work-orchestrator-input`), and the server
stores it atomically in `data/work-orchestrator/control-snapshot.json` (0600). Reasons, in order: Control stays the
single writer and owner of sends (this milestone keeps its handoff path, receipts, fences and Stop); the snapshot is a
contract we can version, where Control's journal is not; the server never learns Control's private paths; and the same
copy serves the phone, the lens and later cloud workers, which B can never do. The one thing B does better, freshness,
is closed by pushing immediately before each plan (the push and the input build are one helper call) and after each
handoff Control records. The server reports the snapshot's age in every input it builds, so a stale copy is visible,
never silent.

Snapshot (protocol 1, bounded, refused whole when out of bounds):

```
{ version: 1, controlVersion, sentAt,
  links:    [{ sessionID, workID, at }]                                         <= 4000
  receipts: [{ id, workID, mode, provider, sessionID, sourceSessionID,
               forkChildID, status, createdAt }]                                <= 4000, newest first
  live:     { checkedAt, rows: [{ id, title, status, updatedAt, busy,
               waitingOnUser, appOwned }] }                                     <= 400 }
```

`live` is the session list Control read with `--fresh` immediately before planning. Guardian review rows are left out
by Control and dropped again by the server.

## What the server builds (`POST /api/work/orchestrator/input`)

For one card it returns the rows the planner sees, already ranked and bounded to 12, plus what it left out and why,
plus the usage snapshot. It never sends anything and never changes a link or a receipt.

### Discovery (canary C3 rules 1 to 8)

| Rank | Evidence | Card session? |
| --- | --- | --- |
| 1 | Confirmed link | Yes |
| 2 | `newSession` receipt on the card | Yes |
| 3 | `fork` receipt with a child (journaled `forkChildID`, or a `sessionID` that differs from `sourceSessionID`) | Yes |
| 4 | `continueSession` receipt on the card | Yes |
| 5 | The handoff template for this card's tag in a user turn | Yes (the only way to find fork children) |
| 6 | A valid `COS-WORK <tag>: done/needs input/blocked` line in the session's own reply | Yes with 1 to 5; alone a suggestion |
| 7 | The tag in the live row's summary | Yes with 1 to 5; alone a suggestion |
| 8 | The session worked the card's confirmed source meeting (meeting card `meeting:<recordId>`) | Suggestion, reason shown |
| Never | Tag in tool output, pasted or quoted handoffs, subagent transcripts, or as `sourceSessionID` | Not a card session |

Precision fixes from the canary: Claude rows are credited by their own `sessionId` (a resumed file replays older
sessions' rows); Codex guardian threads are skipped; Codex `thread_spawn` children fold into their parent; a tag no
handoff prompt or Control record ever used is ignored (placeholders such as `aaaaaaaaaaaa`); when one session is on
several cards, its newest strong evidence decides which card it is working on, and the older cards keep it as history
(`available: false, reason: on_another_card`).

The log scan is an incremental index (`data/work-orchestrator/tag-index.json`): append-only logs are read from the last
offset, so after the first pass only new bytes are scanned. Lines are parsed only when they contain `COS-WORK`.

### Rows

Each row adds to the existing `{id, title, summary, status, automatic, openWork}`:
`discoveredBy` (evidence kinds), `linked`, `lastTouchedCard` (newest evidence for this card), `lastActivity`, `live`
(in the session list Control just read), `pickup` (<= 1,500 characters), `available` and `reason`
(`not_in_session_list`, `app_owned`, `cursor`, `plan_limit`, `on_another_card`, `busy`), and `forkable`.
`automatic` stays the only gate for a Continue: Control sets it (Claude or Codex, not app owned, in the live list).

### Pick-up notes (M2 input, deterministic)

Seek from the end of the log (last 6 MB; Codex logs reach 1.4 GB), parse the last human ask, the last result, whether
the turn ended, open todos, questions and any COS-WORK status line; harness notices are skipped; the live busy flag
overrides the state line. Secrets (`redactSecrets`) and customer identifiers (emails, phone numbers, URL paths and
query strings, money amounts, long numeric ids) are redacted before the note leaves the module. No model call in this
milestone; the canary's optional Haiku polish stays undecided.

### Usage (M3 input, plan usage only)

| | Claude | Codex | Cursor |
| --- | --- | --- | --- |
| Probe | `claude -p` stream-json control request `get_usage` (`skip_behaviors`), no turn | `codex app-server` `account/rateLimits/read` (`excludeResetCreditDetails`) | none: marked unknown (no Keychain read, no TUI launch; not approved) |
| Poll | every 10 min, and before a plan when older than 2 min | same | never |
| Passive | `rate_limit_event` frames from the server's own plan-lane Claude jobs | none yet | none |
| Fallback | a `provider_limit` failure marks the provider exhausted until its stated reset, or 1 h | same | same |

Never sent: `supportsLunaReserve`. Never called: `ConsumeAccountRateLimitResetCredit`. Codex is gated on
`ordinaryUsageAllowed === false` first. Probes run in a fresh empty directory, hooks and MCP off, killed by exact PID
after 15 s. Stops: `COS_WORK_USAGE_POLL=0` turns the poll off; three failed probes in a row pause that provider's probe
for an hour. A key-lane turn's rate-limit frames are never recorded as plan usage.

### Planner input and answer

The plan request (`POST /api/work/chat`) from an orchestrator client carries `orchestrator: true`, `now` (ISO time),
`usage` (per provider: state, headroom, reset, age, source), `leftOut` (what discovery left out and why) and
`newSessionProviders`. The answer may now hold three kinds of assignment:

| `mode` | Target | Rule |
| --- | --- | --- |
| `continue` (default) | `sessionID` | the row is `automatic: true` (unchanged) |
| `fork` | `sessionID` | the row is `forkable: true` |
| `newSession` | `provider` | the provider is in `newSessionProviders` |

A client that does not send `orchestrator: true` gets today's prompt, schema and parser, byte for byte.

### Plan log

Every plan, from any client, appends one line to `data/work-orchestrator/plans.jsonl` (rotated at 2 MB, keeping the
newest half) and prints one `[work-orchestrator] plan` line: the sessions sent with their availability, what was left
out and why, the usage snapshot's age per provider, the assignments (mode and target, never prompt text), the planner,
the outcome and the time taken.

## Control 0.5.333

- Plans with the server's input when `GET /api/work/chat` advertises `orchestrator: 1`; otherwise exactly as 0.5.332.
- Refreshes the session list right before planning. A plan from no sessions says why (none discovered; or N discovered
  but none can take a Continue, each with its reason) and still lets the planner propose a new session.
- Journals `forkChildID` on fork receipts. Leaves Guardian review rows out.
- Auto-send: a per-card switch whose default is Settings › Work › Send plans without review (off by default). On: the
  plan's assignments (Continue, Fork and New session) go through the existing handoff path without the review click,
  each with a visible Stop and a log line. Off: today, unchanged.
