# Saved-meeting reviews in Work

Work reviews add an optional, durable read-only review step over the existing saved-meeting library. They do not migrate or rewrite tasks, and do not change the glasses Tasks contract.

## Enablement

Manual review is enabled by default. Set `COS_WORK_REVIEWS_ENABLED=0` to disable it. Opening or starting the server does not submit a review; admission requires an explicit manual request. The existing authenticated API exposes `GET/POST /api/work-reviews` and `GET /api/work-reviews/:id`. A disabled or degraded review runtime returns 404; base APIs continue to work. The native client retains normal tasks and meetings and explains review unavailability.

A request contains an explicit configured model slot and canonical meeting descriptor (`domain`, `month`, `filename`, optional `recordId`). It resolves full saved source through the same resolver as Meetings. Source truncation/absence is refused; long review inputs disclose excerpt coverage. Proposed links use same-domain source references or exact normalized action text. They are not semantic deduplication or authority to mutate a task.

Each review persists intent before job admission. Canonical record, source revision and policy version deduplicate repeated requests. Model changes do not create a second review for the same revision. Unconfirmed admission retains its original identity and does not automatically resend. Startup/timer reconciliation runs independently of native window lifetime. Source changes supersede results. A temporary source outage preserves terminal evidence privately and restores it only after the same identity/revision can be revalidated, including after query-job expiry.

The API uses the existing durable query coordinator. Claude review restricts tools to Read/Grep/Glob; Ollama is text-only. Codex and Cursor are unavailable for this extraction endpoint until an appropriately restricted adapter is qualified. These restrictions do not change the separate explicit session-handoff capabilities in COS Control. Only the local Ollama review route received a live canary in this change; fixture/source checks do not establish live compatibility for every model tier.

Review output currently appears in the existing COS conversation/display as well as Work. Automatic after-sync execution, automatic task mutation and publication are false capabilities. Session preparation remains an explicit user action with the destination's existing permissions and independent approval requirements.

## Recovery

Review journal lives under the resolved COS data directory's `work-reviews` folder. One runtime owns it. A corrupt/unsafe/locked optional journal disables reviews and emits a generic diagnostic; it does not prevent the base server from starting. Preserve the journal for diagnosis. Do not delete unconfirmed intents to obtain a retry.

## Verification

`npx vitest run server/lib/work-review-runtime.test.ts server/routes/work-reviews.test.ts server/routes/meetings.test.ts --maxWorkers=1` covers the new runtime and existing canonical meeting routes. `node server/scripts/work-review-mutation-gate.mjs` runs six mutations in a private copy without editing a live checkout. `npm run typecheck` and the full test suite remain release gates.

`server/scripts/work-review-candidate.ts` is a local development qualification gateway, excluded from the npm package. It preserves installed services and admits only Ollama through the existing public query API. Its private loopback token never replaces the installed pairing token. It is not a production server or a public installer.
