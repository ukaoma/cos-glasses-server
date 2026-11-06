# Ask COS → Work proposal integration

Status: isolated follow-on server implementation, not installed or published. On November 6, 2026, `codex/ask-cos-orchestration-20261105` was rebased onto the committed server 6.99.16 baseline `a8694c5`; the verified server implementation head is `e6e9c58`. The existing COS thread routes and conversation/session IDs remain intact. Native Ask proposal review/import work is in progress in a separate follow-on Control worktree; it is not part of the frozen Control 0.5.374 / server 6.99.16 release worktrees.

## Endpoint

Both operations use the existing `/api` authentication and return `Cache-Control: private, no-store`.

- `GET /api/ask/work-plan`: cheap protocol/capability discovery; does not run a model or read the board. `controlSnapshot: 1` advertises the snapshot-only publication contract below.
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

Questions containing text changed by the existing secret redactor are refused before evidence reads or inference with HTTP 400 `question_contains_sensitive_text` and “Remove credentials from the question and try again.” This preserves native exact-question matching without echoing sensitive text.

Response includes `protocolVersion: 1`, `planOnly: true`, `workID`, `revision`, `title`, `question`, `createdAt`, `answer`, `assignments`, `model`, `effort`, original `evidence`, and `revalidatedEvidence`. `proposalID` is a content hash, **not durable storage, dispatch identity, or a receipt**. Input timestamps mean a fresh retry can produce a different hash.

Each evidence object supplies Continue/Fork allowlists and availability/provenance. Use `revalidatedEvidence` for the latest eligibility; retain the original evidence for explaining what the planner saw. New-session proposals are disabled until an authoritative executable-provider contract exists. Available quota alone is insufficient.

## Snapshot-only publication

After reading `controlSnapshot: 1`, native Control may publish its actual links, receipts and fresh live-session list through `POST /api/work/orchestrator/snapshot`:

```json
{
  "workID": "task:quilt:0123456789ab",
  "revision": "<canonical board workRevision>",
  "serverInstanceId": "<exact serverInstanceId from /api/models>",
  "snapshot": { "version": 1, "controlVersion": "<Control version>", "sentAt": 1793966400, "links": [], "receipts": [], "live": null }
}
```

The snapshot is the existing `parseSnapshot` protocol, not new capability evidence. Use the actual current epoch timestamp and existing bounded Control snapshot builder; the values above are illustrative. The complete body is limited to 4,000,000 bytes, with at most 4,000 links, 4,000 receipts and 400 live rows. Unknown top-level request keys are refused; the existing snapshot parser strips non-schema nested fields, including caller-supplied `automatic`, `forkable` or capabilities. The server stamps receipt time itself.

The route requires existing `/api` authentication, an initialized matching server identity and an exact current canonical Work card revision. It checks identity and maintenance again after the bounded board read, before updating the existing snapshot cache. It returns `{protocolVersion:1, accepted:true, workID, revision, serverInstanceId}`. Refusal leaves the prior cache in place: malformed binding/snapshot is 400, body overflow 413, mismatched server or revision 409, missing task 404, and unavailable identity/board or maintenance 503. Ambiguous or completed cards also fail closed. No discovery, usage probe, planner, task mutation, authoritative link/receipt mutation or dispatch runs here.

This retains the legacy paired-client evidence trust boundary: the supplied snapshot is trusted Control evidence under the paired token, not independently verified session ownership or permission to execute. Matching `serverInstanceId` prevents publishing to an unintended server; it does not prove the caller is the Control app. Later planning and native Send must still apply their eligibility, ownership and revision gates. Acceptance means the existing snapshot cache was updated; its best-effort disk persistence is not a durable delivery receipt. A client must not fall back to `/work/orchestrator/input` when this capability is missing, because that older path can refresh usage and launch probes.

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

The additive snapshot-only route above closes the server-side fresh-snapshot publication gap without changing legacy `/work/orchestrator/input` refresh behavior. Native use of the new route remains part of the follow-on implementation and acceptance work. The earlier `e6e9c58` receipt predates this addition.

## Merge and validation

Continue integration in the separate follow-on worktrees. Do not merge this work into the frozen 6.99.16 or Control 0.5.374 release worktrees. The rebase already reconciled the Ask Work and COS thread mounts in `server/index.ts`; both are present once. The optional cached-usage mode in `server/lib/work-orchestrator/runtime.ts` is retained, and existing Work callers retain their refresh behavior. No follow-on version bump or release reservation is made here.

`/api/ask/work-plan` is exempt from the generic mutation lease because its route owns admission and the planner's maintenance lease. It retains those guards until the underlying provider settles, and retains both after an unconfirmed provider exit. This avoids double lease ownership and preserves the route's maintenance response contract.

`/api/work/orchestrator/snapshot` likewise owns its short mutation lease and rechecks binding/admission before the cache write; its index exemption prevents double ownership.

Remaining release gates: finish the native follow-on implementation and build; test Ask → persistent proposal → selected Work card → explicit review/send → native receipt; then complete full server and Control release QA, candidate installation checks, and the applicable versioning/distribution gates. Include older-server fallback, disconnect, changed card/context, duplicate import/send, missing usage data, app-owned targets, cancellation and partial delivery. Any real provider canary or native send acceptance must be separately recorded. This worktree's injected-provider tests do not certify native UI, paid/live model execution, installation or release readiness.

## Isolated validation receipt

November 6, 2026, baseline `a8694c5`, verified implementation `e6e9c58`: **110 tests passed across 11 suites** — Ask core/route, Work chat core/route, orchestrator runtime/route, COS thread core/route/web, existing COS chat web, and Drop settings. TypeScript and whitespace checks passed. Dependency declarations were unchanged from 6.99.15 apart from package version metadata. No live provider invocation, native Control build, service restart, installation or publication was performed in this verification. Native implementation is still in progress; full release QA and end-to-end acceptance remain outstanding.

November 6 snapshot-only follow-on: **88 tests passed across seven suites**, including 17 snapshot-publication tests, Ask core/route, orchestrator core/route/runtime and the COS thread route. Tests cover server/revision mismatch, malformed and oversized input, capability-field stripping, maintenance and identity rechecks, disconnect while the board read is pending, and an actual snapshot-cache write/reload followed by cached Ask retrieval with zero usage probes. TypeScript and whitespace checks passed. Independent route review found no blocking defect; its requested disconnect/lease test is included. No live inference, installed-service change or native send acceptance was performed.
