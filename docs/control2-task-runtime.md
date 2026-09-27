# ADR: portable task runtime foundation

Status: accepted for a read-only foundation candidate; production writes and migration remain disabled. September 27, 2026.

## Decision

Ship a small standalone Python reader with protocol `cos-control-task-read/1`, installed and probed by `bin/task-runtime-check.cjs`. Python 3.10+ and Node are required; no pip, venv, private COS checkout, credentials, vector database or model invocation is needed. The CLI does not change the live bridge configuration or task capability gate.

The candidate supports exactly:

| Command | Contract |
|---|---|
| capabilities | Explicit protocol/version, commands, read-only flag, unstable identity type, byte limit and disabled write/dispatch/migration flags |
| domains | Discover valid domain directories containing readable regular tasks.md files under the explicit root; no personal-domain fallback |
| task-rows | Canonical row fields, source SHA-256 revision and legacy description-hash IDs |

`writes`, `dispatch` and `migration` are false. An installed file named a bridge is not evidence of CRUD support. Do not connect this candidate to task-store's existing `pythonBridgeAvailable()` gate. Consumers must negotiate protocol and command capabilities.

### Install and inspect

Choose distinct absolute paths for runtime code and disposable data. Runtime installation requires an empty destination and does not overwrite an existing package.

```sh
node bin/task-runtime-check.cjs --install --runtime-dir /tmp/cos-task-candidate/runtime --data-root /tmp/cos-task-candidate/data --domain demo
node bin/task-runtime-check.cjs --runtime-dir /tmp/cos-task-candidate/runtime --data-root /tmp/cos-task-candidate/data --domain demo
python3 -I -S /tmp/cos-task-candidate/runtime/task_runtime.py capabilities
```

Create `data/demo/tasks.md` before invoking the read probe. `--operator Alex` optionally selects first-name ownership behavior; with no operator, explicitly named owners are conservatively delegated. The protocol reads domain names matching ASCII letters/digits/underscore/hyphen, bounded to 128 characters. Nonmatching names are unsupported by this candidate, not proof of missing source data.

The installer verifies fixed manifest member names and their checksums before execution. This checks package integrity against its manifest, not authenticity against a maliciously replaced manifest. Trust comes from the installed application/package distribution. It launches Python with `-I -S`, a cleared environment except PATH/LANG, bounded time/output, and the installed directory as cwd. Source access requires an explicit absolute root, descriptor-relative no-follow domain/task opens, regular-file checks and an 8 MiB cap. It detects observed in-place size/mtime changes and asks the caller to retry. Directory ancestors of the explicitly provided roots remain operator-trusted. This is a read-only source adapter, not a provider execution sandbox.

## Provenance and complete import inventory

`task-runtime/manifest.json` records the source commit and hash, adaptations, version and every shipped file hash. Source: MU-Chief-Staff snapshot `1dac83bd62937717e460f9a8334c054f79011128`, `operations/scripts/task_rows.py`; normalization is the exact lowercase/punctuation/whitespace behavior of `TaskDeduplicator.normalize` from `task_dedup.py`.

The parser keeps checkbox/archive states, source/finish-line splitting, owner/delegation detection, section and schedule markers, review state and duplicate-description ordinals. Personal domain fallbacks and a hardcoded operator were removed. The command envelope and file-access layer are new. The original `task_dedup` import is replaced by the small normalization function; no LLM deduplication code is included.

Complete runtime imports are Python standard library: argparse, hashlib, json, os, re, stat, string, sys, dataclasses, pathlib and typing. The Node installer imports only node:fs, node:path, node:crypto and node:child_process. No private configuration, meetings, cache files, data samples or credentials ship. The package carries the repository's MIT license and its existing attribution.

The legacy source parser and this package can drift. Changes to marker grammar, normalization, owner parsing or task metadata must deliberately update this package's version/provenance and fixture assertions. Private-source parity is optional supplementary evidence; installed-package tests must always run independently.

## Stable identity and write migration design

The read candidate deliberately exposes legacy identity instability. A text rename changes its ID. These IDs must never authorize durable work or publication. CRUD and migration must be a separately negotiated future protocol, not silently added under read/1.

Planned identity representation: a UUID carried on each task line in an explicit `[task-id UUID]` metadata marker, removed from displayed description and normalized dedup text by the new parser. Stable task identity is independent of domain, task text, section, order and completion state. Validate duplicate UUIDs as corruption/ambiguity; never silently choose the first. New captures allocate identity once inside the guarded write. Every writer must preserve markers byte-for-byte unless performing the controlled migration. Older code is not allowed to mutate after cutover; version negotiation and an exclusive maintenance cutover are prerequisites, because existing marker parsers would otherwise treat the new marker as description.

1. Fence legacy and managed admissions. Inventory and stop incompatible direct task writers, including pipeline jobs/older clients. Drain active runs before acquiring short-lived domain write locks; otherwise retain them with an explicit old-ID alias mapping. Never hold file locks while waiting on a model.
2. Acquire domain write locks and obtain a consistent task/ledger snapshot. Allocate UUIDs using exact source revision plus row identity, including duplicate ordinal, only within this snapshot. Recheck hashes immediately before writes. Ambiguous historical references remain unresolved rather than guessed.
3. Persist a migration intent containing backup hashes, the one-to-one alias map, source revisions and intended writes. Update rows and mutable task references, pending schedules, captures-seen and lock references. Historical audit/completion records can retain old references resolved through the immutable alias map.
4. Never regenerate existing clientJobId, jobId, run identity, sessionId, generation or publication receipt. Running ledger references resolve through the alias map until reconciled. A migration is not a retry of the underlying job.
5. Commit the migration receipt, reconcile active jobs and row ownership, then resume compatible admission. Recover interrupted transactions from intent plus observed hashes; refuse unknown mixed state. Persistent IDs and migration records must be written durably with compare-and-swap revisions.
6. A durable owner/fence keyed by stable task ID arbitrates legacy and managed execution. Scheduled selection, manual run, run minting and legacy orphan reconciliation must all honor it. File-write locks and run leases are separate mechanisms. Lease expiry does not authorize accepting late output or blindly launching another process.
7. Cross-domain movement is a two-domain guarded transaction preserving UUID. The existing writer's `move()` only changes section inside one domain. Reordering, duplicate descriptions, archive and completion preserve UUID and provenance. Active work cannot be silently archived or reidentified.
8. Rollback first fences admission. Run a versioned compatibility conversion that preserves post-migration edits, aliases and receipts. Do not restore a baseline backup over newer work. Reject downgrade when an older reader/writer cannot preserve stable identity or ownership. Resolve ordinal mutation requests against a matching board revision or reject them.

Required coordinated consumers: task_rows, task_write, task_updater, cos_api_bridge, task_checkout, task_promoter, task_archiver, all direct writer inventory; server task-store/dispatcher/routes and legacy run/capture ledgers; native Models/ControllerModel/helper. The old task_updater constructs ordinal IDs even when the parser supplies hashes, so parser changes alone are insufficient.

Required future migration canaries: restart at each cutover write, existing active legacy job, scheduled/manual/managed admission race, text edits, reordered duplicate descriptions, cross-domain transfer, archive/completion, stale ordinal mutation and rollback after new edits. None is claimed implemented by this reader package.

## Verification recorded

`npx vitest run server/lib/control2-task-runtime.test.ts --maxWorkers=1`: 4/4 passed on September 27, 2026. Checks cover independent installation, row/owner/source/finish-line/schedule semantics, distinct duplicate IDs, unchanged source, refusal to overwrite installed runtime, explicit unstable rename behavior, unsupported mutation, missing root, traversal/symlink rejection and checksum failure before Python execution.

A separate clean-directory canary installed the three-file package into a temporary directory, launched from outside the repository with only PATH supplied, read one task in a new `demo` domain, confirmed source hash unchanged and removed the temporary directory. Result: PASS. No COS environment variables, user data, private imports or model calls were used.

Unproven: production CRUD, stable-ID migration, live bridge integration, a complete clean-user macOS application installation, provider containment and meeting-to-publication execution. These remain explicit later gates. This candidate is not a claim that the complete standalone product is ready.
