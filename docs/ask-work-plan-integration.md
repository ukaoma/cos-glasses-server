# Ask COS → Work proposal integration

Status: isolated server implementation, not installed or published. Base: server 6.99.15 (`9cbcf5f`). Native conversation/UI is owned by the Control 0.5.374 / server 6.99.16 builder. This contract is additive; it does not replace that builder's conversation/session IDs.

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

## Merge and validation

Merge the adapter and documentation from `codex/ask-cos-orchestration-20261105` into the peer's integration branch. Existing source-file changes are the import/mount in `server/index.ts` and an optional cached-usage mode in `server/lib/work-orchestrator/runtime.ts`. Reconcile the mount explicitly with the peer's new cos-thread mount. Existing runtime callers retain their refresh behavior. No version bump or release reservation is made here.

Before release, test the real native path: Ask → persistent proposal → selected Work card → explicit review/send → native receipt. Include older-server fallback, disconnect, changed card/context, duplicate import/send, missing usage data, app-owned targets, cancellation and partial delivery. This worktree's injected-provider tests do not certify native UI, paid/live model execution, installation or release readiness.

## Isolated validation receipt

November 5, 2026: 98 tests passed across nine suites (Ask core/route, existing Work core/route, orchestrator core/route, usage, hooks and actual runtime). TypeScript passed. Independent review verified authenticated mounting, canonical revision binding, cancellation ownership, fork exclusions and cached-usage process behavior. No live provider invocation, native Control build, service restart or publication was performed. Full server/release QA and native end-to-end checks remain integration gates.
