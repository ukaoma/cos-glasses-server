# Control 2 foundation candidate

This opt-in development slice proves durable source receipts, a separate native
review surface, isolated execution primitives and portable task-read feasibility.
It does not implement automatic agent building or publication. Neither the
managed server nor its task scheduler is started by the lab launcher.

## Start the disposable backend

From this package, with Node dependencies installed:

```sh
export COS_CONTROL2_FOUNDATION=1
export COS_CONTROL2_DRAFT_ENABLED=1
export COS_CONTROL_TEST_HOME="$(mktemp -d /tmp/cos-control2-lab.XXXXXX)"
export COS_CONTROL_TEST_API_PORT=3147
npm run control2:lab
```

The same scratch home, API port and foundation flag launch the native Foundation Lab candidate.
The launcher writes a private token under the scratch home. It does not print
the token or reuse production configuration. Only localhost is bound; browser
Origin requests and unauthenticated calls are denied. Ports 3141/3143 are refused.

Replay the synthetic meeting twice: one item remains. Advance its revision: the
old item is superseded. Restart the backend using the same test home: receipts
and review items persist. Source readiness false creates a blocked item. A
revision reused with different content is rejected. Publication always refuses.

## Manual text preview

Select a current review item and choose **Prepare text preview**. This explicitly
starts one authenticated Claude CLI turn with tools disabled. The model returns
plain title/body fields; deterministic escaping and a restrictive CSP produce
HTML, then an OS-sandboxed command verifies the bytes. **Open checked preview**
checks the retained file hash before opening it. No website code is changed.

The draft flag is optional and off by default. There is a maximum of one started
model turn per backend process, a $1 CLI budget ceiling and a 120-second maximum.
Restart the isolated backend to make another attempt. Existing checked previews
are reused without another turn. Instructions, including source and criteria,
are capped at 4,000 characters; oversized inputs show a draft validation error.
A missing or changed persisted preview fails closed with a recovery error.

## Storage decision

Use one versioned, bounded journal and durable fsync/rename writes for the
foundation spike. All transitions synchronously acquire an exclusive journal
lock, then load, validate and replace the complete record. There are at most 200
receipts; capacity fails closed rather than forgetting deduplication history.
An unclean writer lock or corrupt/unsupported journal returns a recovery error.
Do not delete that lock until the owner process is confirmed stopped and the
journal inspected. This is deliberately not automatic crash recovery for the
full MVP. Full task migration/cross-store transactions and lease fencing remain
the next slice's gates; decide on SQLite before those if a file transaction
cannot meet the validated cutover contract.

Meeting revisions are opaque and manual lab replay is explicitly ordered by the
tester. This is not an out-of-order production event consumer. Late source alias
conflicts stop for reconciliation rather than silently unifying identities.
No legacy tasks, existing sessions, memories or meeting source files are written.

## Rollback

Stop the lab backend and quit the separate lab app. The installed Control
0.5.239, managed server 6.55.0 and glasses 6.9.555 baseline need no rollback because
the lab never replaces them. Retain scratch data for diagnosis or remove that
specific disposable directory after inspection. All repositories have the
`cos-control2-baseline-2026-09-27` annotated tag. Runtime artifact checksums and
operator restore instructions live in the private COS baseline receipt.

## Remaining gates

The OS sandbox proof is for fixed uncredentialed system commands, not proof that
Claude/Codex can safely execute tools with their normal configuration. The
portable task package reports its actual capabilities and does not perform a
legacy stable-ID cutover. Production source adapters, exact pilot meeting and
website binding, actual-theme staging, managed provider execution, revision-bound
approval and a publisher are later gated slices. Do not advertise them as shipped.
