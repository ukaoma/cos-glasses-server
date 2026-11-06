# Ask COS → Work proposal integration

Status: isolated follow-on server implementation, not installed or published. On November 6, 2026, `codex/ask-cos-orchestration-20261105` was rebased onto the committed server 6.99.16 baseline `a8694c5`; the verified server implementation head is `e6e9c58`. The existing COS thread routes and conversation/session IDs remain intact. Native Ask proposal review/import work is in progress in a separate follow-on Control worktree; it is not part of the frozen Control 0.5.374 / server 6.99.16 release worktrees.

## Endpoint

Both operations use the existing `/api` authentication and return `Cache-Control: private, no-store`.

- `GET /api/ask/work-plan`: cheap protocol/capability discovery; does not run a model or read the board.
- `POST /api/ask/work-plan`: prepare a proposal for one existing Work card.

```json
{
  "workID": "task:quilt:0123456789ab",
  "revision": "<64-character canonical workRevision>",
  "question": "Review this task and propose the next assignments",
  "planner": "opus",
  "effort": "high"
}
```

Only these fields are accepted. Question limit: 2,000 characters; body limit: 12,000 bytes. Planner is `sonnet` (default) or `opus`; effort is `low`, `medium`, or `high` (default). The endpoint uses the existing tools-off Work planner. It does not execute the proposed assignments.

**Revision contract:** use the exact board row's `workRevision`, which Control's `work-context` helper returns unchanged. Do not use `taskRevision`, `controlSnapshotRevision`, or a locally generated hash. Identity must resolve uniquely. Missing metadata, completed cards, changed revisions and ineligible targets fail closed. The board and target evidence are read again after model completion.

Response includes `protocolVersion: 1`, `planOnly: true`, `workID`, `revision`, `title`, `question`, `createdAt`, `answer`, `assignments`, `model`, `effort`, original `evidence`, and `revalidatedEvidence`. `proposalID` is a content hash, **not durable storage, dispatch identity, or a receipt**. Input timestamps mean a fresh retry can produce a different hash.

Each evidence object supplies Continue/Fork allowlists and availability/provenance. Use `revalidatedEvidence` for the latest eligibility; retain the original evidence for explaining what the planner saw. New-session proposals are disabled until an authoritative executable-provider contract exists. Available quota alone is insufficient.

## Scope shown to the user

This first adapter has task metadata, confirmed meeting references and server session evidence. It does not load the native Work chat history, local attachments, prior results or their local context-item selections. Say so when showing a proposal. Evidence discovery may refresh the local session index. Ask reads existing usage evidence without launching usage probes; stale or missing usage disables assignment proposals. The planner itself still runs inference. "Plan only" does not mean zero I/O or zero inference.

A success means **proposed**, never recorded, queued, sent, delivered or completed. No Work round, task edit, recording, provider work session or send queue is created by this endpoint. Ordinary questions without a selected existing card remain in the conversation path; never invent a Work identity for them.

## Native integration checklist

1. Preserve the current COS layout. Broaden setup-only Ask copy so general questions and orchestration are discoverable.
2. Associate the proposal with the real persistent Ask conversation using the peer's contract. Keep user-visible question/title separate from carried context.
3. Bind it to the connected server identity locally. The response intentionally does not invent `serverInstanceID`.
4. Show a review action that opens the correct Work card. Before recording/importing, snapshot local links, attachments and context; preserve the returned canonical revision. Replan if any prerequisite changed.
5. A dedicated Ask importer must deduplicate user import and persist one UUIDv4 per assignment. Do not generate fresh receipt IDs on each redraw/retry. Do not treat `proposalID` as a dispatch idempotency key.
6. **Do not call `recordLensRound`.** That path stamps a glasses origin and rebases revisions. Ask proposals have neither that provenance nor lens approval.
7. Intersect server allowlists with fresh Control execution capability, app ownership, guardian and handoff receipt checks. The existing Work sender remains sole owner of dispatch.
8. Recording a proposal must not trigger auto-send or a queue pump. Send/fork actions use the normal user review and authorization flow.
9. Show request acceptance, delivery, running and completion separately. When Control is offline or evidence is unavailable, show that limitation rather than an alternate sender.

The native follow-on worktree is `/Users/ukaoma/cos-worktrees/control-ask-orchestration-20261106`, branch `codex/ask-orchestration-20261106`, based on `cdb3d74`. Its scope is broader Ask entry copy, detailed capability discovery through `GET /api/ask/work-plan`, real COS thread provenance, server-bound proposal persistence, and a dedicated explicit review/import action into the existing Work sender. Native implementation and verification remain in progress; this server receipt does not certify those behaviors.

An integration gap remains for publishing fresh Control session snapshots: the existing `POST /api/work/orchestrator/input` also refreshes usage and can launch probes. The native Ask path needs a separately validated snapshot-only publication contract before it can refresh discovery while preserving Ask's cached-usage guarantee. That route is not implemented in the verified `e6e9c58` receipt.

## Merge and validation

Continue integration in the separate follow-on worktrees. Do not merge this work into the frozen 6.99.16 or Control 0.5.374 release worktrees. The rebase already reconciled the Ask Work and COS thread mounts in `server/index.ts`; both are present once. The optional cached-usage mode in `server/lib/work-orchestrator/runtime.ts` is retained, and existing Work callers retain their refresh behavior. No follow-on version bump or release reservation is made here.

`/api/ask/work-plan` is exempt from the generic mutation lease because its route owns admission and the planner's maintenance lease. It retains those guards until the underlying provider settles, and retains both after an unconfirmed provider exit. This avoids double lease ownership and preserves the route's maintenance response contract.

Remaining release gates: finish the native follow-on implementation and build; test Ask → persistent proposal → selected Work card → explicit review/send → native receipt; then complete full server and Control release QA, candidate installation checks, and the applicable versioning/distribution gates. Include older-server fallback, disconnect, changed card/context, duplicate import/send, missing usage data, app-owned targets, cancellation and partial delivery. Any real provider canary or native send acceptance must be separately recorded. This worktree's injected-provider tests do not certify native UI, paid/live model execution, installation or release readiness.

## Isolated validation receipt

November 6, 2026, baseline `a8694c5`, verified implementation `e6e9c58`: **110 tests passed across 11 suites** — Ask core/route, Work chat core/route, orchestrator runtime/route, COS thread core/route/web, existing COS chat web, and Drop settings. TypeScript and whitespace checks passed. Dependency declarations were unchanged from 6.99.15 apart from package version metadata. No live provider invocation, native Control build, service restart, installation or publication was performed in this verification. Native implementation is still in progress; full release QA and end-to-end acceptance remain outstanding.
