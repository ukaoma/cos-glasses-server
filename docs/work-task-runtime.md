# Portable canonical Work tasks

The production task adapter first uses an available configured COS Python bridge.
If `COS_SCRIPTS_DIR` is configured but broken, it fails closed. It does not silently
switch that install to another storage system. Otherwise the npm package includes
`work-task-runtime`, a standard-library-only Python 3.10+ task bridge. The server
probes the interpreter, uses `-I -S -B`, verifies packaged file hashes before every
invocation, bounds input/output/time, and passes a minimal child environment.
Unsupported platforms/interpreters remain unavailable. Python is a prerequisite;
this package does not silently install an interpreter. A stock Mac whose only
interpreter is Apple's Python 3.9 does not meet this prerequisite. With Homebrew
already installed, run `brew install python@3.12`, then restart the server. Discovery
checks unversioned Homebrew Python and exact Apple Silicon/Intel Homebrew opt/bin
paths for Python 3.12 and 3.11 before `/usr/bin/python3`; it does not assume the
versioned formula creates an unversioned `python3` link. An explicit
`COS_TASK_PYTHON` is exclusive and must point to a supported executable. If
`COS_SCRIPTS_DIR` is set but broken, repair that bridge instead: Work deliberately
does not use the portable fallback to hide a configured pipeline failure.

The source is the same canonical `tasks.md`, not a new database. Resolution is an
explicit `COS_OPERATIONS_DIR` (including a new empty root), the existing operations
resolver, then `COS_DATA_DIR/operations`. Configured/discovered/default domains use
the shared server domain resolver. A fresh default domain can receive its first
capture. `COS_PORTABLE_TASKS=0` disables only the portable fallback; an existing
full COS bridge remains authoritative. `COS_TASK_PYTHON` can select an absolute
interpreter path. Explicit roots and source files must not be symlinks; configure
the real directory path. Root/domain opens are pinned descriptors; on macOS the
single-command child pins its domain as cwd instead of relying on unsupported
`/dev/fd/<directory>/file` traversal. Source reads use no-follow bounded opens;
atomic replacement writes use exclusive no-follow temporary files. Same-user
modification of the installed package/manifest is outside this integrity boundary.

Since 6.65.0 `GET /api/tasks` and `GET /api/work-board` rows also carry `createdOn`,
`createdFrom` and `lineChangedAt`, for both the COS bridge and this runtime. The server reads them; the
runtime does not. `createdOn` is the first `YYYY-MM-DD` in the source label, else the
day the task's words first appeared in the git history of its `tasks.md`.
`lineChangedAt` is the git blame time of a committed line. Each is null when unknown,
including every git-derived value when no git repository tracks the `tasks.md`.
Nothing is written into `tasks.md`.

The default lock namespace remains `~/Library/Application Support/COS/.task_locks.json`
and canonical `file:<domain>` entries. `COS_TASK_LOCK_STORE` is an explicit override
for isolated fixtures. Existing COS bridge calls keep their original environment
and lock behavior. Portable calls pin the lock directory and reject symlink,
nonregular, oversized or corrupt lock stores. Do not delete locks to retry a write.

`server/scripts/build-work-task-runtime.py --source /absolute/COS/operations/scripts`
rebuilds the snapshot. `manifest.json` records source commit, source hashes, exact
packaged hashes and adaptations. Canonical parser/writer/metadata/checkout/atomic
modules are included; only task handlers and the exact normalization method are
extracted from larger source modules. No customer data, credentials, general COS
bridge, vector dependencies or provider invocation ships. The repository MIT
license applies. Owner matching uses the configured profile's first name; without
a configured owner, explicit named owners remain delegated. Task IDs, source,
legacy markers, stable Work metadata and CAS revisions retain canonical semantics.

Supported commands cover task-store capture, rows, edit, schedule, run markers,
legacy stage, finish line, move, check/uncheck, Work stage and confirmed meeting
link writes. Readiness does not authorize autonomous work. Server-side meeting
resolution still verifies exact canonical meeting identity before linking.

## Native receipt activity

`GET /api/work-board/activity?domain=<domain>&workIdentity=<12hex>` uses the existing
API authentication and returns exact native receipt associations. Its `workId` is
`task:<domain>:<workIdentity>` and `sessionId`, when present, is provider-qualified
(e.g. `codex:<native-id>`). The journal path is fixed to macOS
`~/Library/Application Support/COS Control/work-handoffs/handoffs.json`. Other
platforms, isolated runtimes, missing/unsafe/malformed journals report
`available:false`, not a successful empty history. Custom data roots are treated
as isolated for native-journal reading. There is no request-supplied file path.

Receipt identity/status/provider/session fields are projected, and since 6.59.0
also mode, model slot, channel, times, acknowledgement, the session's app and server
ownership (per session, across every receipt that names it), the request a receipt
answered, and COS Control's own progress record: the report (done, needs input,
blocked), who made it, its evidence, when the session received the work, the newest
automatic move and whether moves are paused (`docs/work-handoff-requests.md`). Two
projected fields are session-derived text: the session title (since 6.56.0) and the
evidence, which Miles approved returning on 2026-09-30, at most 280 characters and
1,200 UTF-16 units, cleaned as a session name is. Prompt, detail, result, work title,
draft and source text and progress event text are never returned. Error text is
generic. Session ownership is never inferred from titles. `sending`/`preparing`
project as unknown; queued/delivered receipts are not task completion. `updatedAt` is
the newest progress event Control recorded, else the receipt's `createdAt`; nothing
is fabricated. A malformed progress block reads `{ unreadable: true }` on its own and
never makes the journal unavailable. This endpoint does not poll providers, resend work or mutate
the native journal.

## Qualification

Focused tests cover independent copied-runtime execution, fresh production-env
subprocess without test opt-in, full canonical CRUD, exact identity normalization,
metadata preservation after rename, stale CAS refusal, canonical locks, generic
owner behavior, broken-bridge refusal, root/domain/file/lock symlink refusal, input
and source limits, native receipt privacy and exact identity/auth boundaries.

The older `task-runtime` read-only foundation protocol remains a separate artifact;
it is not upgraded or advertised as writable. Public release still requires the
full test/typecheck/package gates and installed npm/Mac acceptance.
