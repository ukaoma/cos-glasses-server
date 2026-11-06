# Ask COS orchestration: research and staged product plan

Research date: 2026-11-05. Status: design direction plus a first, plan-only server slice. This document does not claim that the complete product, persistent conversation, native interface, dispatch integration, or release is finished.

## Product direction

Ask COS should be a general conversation with the user's chief of staff: answer a question, think through work, prepare a plan, review it, and follow authorized work to an evidenced outcome. Setup help is one supported topic, not the product's identity. Avoid a setup-only title, placeholder, or introduction that implies Ask cannot discuss work already underway.

Preserve COS's current visual language, navigation, Work cards, and builders. Extend the current Ask surface with small, recognizable plan, review, activity, and result elements. Do not introduce a separate bot marketplace, new agent personas, or a competing task board to deliver this capability. The coordinator routes work to the existing execution sessions; it does not replace them.

## What the official product pages establish

These are product descriptions, not independent reliability tests. Only the three requested official pages were researched. No page establishes an open-source product license or a public orchestration API that COS can depend on.

| Source | Evidence and access | Transferable interaction pattern |
| --- | --- | --- |
| [Meta Muse](https://ai.meta.com/muse/) | Direct page requests returned a title but no readable body. The official-domain search index, crawled the previous month, described a persistent VM/browser, conversational access, goals and action plans, background work, an activity trail, and allow-once/always/deny choices. Treat these as indexed claims, not freshly verified live UI. | Connect a user's goal to a visible plan and progress record. Present consequential actions for a concrete decision. Keep one conversation across input surfaces. |
| [OpenAI dots](https://openai.com/index/introducing-dots/) | Page body was directly readable. It describes concurrent projects, inspectable computer/activity, context across channels, configurable rules, and read-only proactive research. It explicitly describes starting or managing tasks in Codex or ChatGPT Work. | Put a coordinator above existing builders; preserve continuity and visibility. Separate background discovery from authorized execution. |
| [Grok Bot](https://x.ai/bot) | Page body was directly readable. It describes specialist bots sharing threads, handing off work, retaining context, learning routines from demonstrations, and sharing a persistent computer per user. | Make ownership and handoffs explicit. Reuse successful routines. Prevent concurrent workers from colliding over shared resources. |

COS can implement these interaction patterns using its own code and existing interfaces. This is an inference about product design, not a claim about vendor internals, API availability, or reusable vendor source code. Vendor cloud-computer claims do not describe COS's current deployment.

## Three priorities

1. **Continuity and identity.** Keep Ask's conversation persistent and use canonical Work identities when planning existing work. Preserve the relationship between the question, the selected card revision, the proposed plan, and eventual evidence. Do not invent a task identity to make an arbitrary conversation look like an existing Work card.
2. **Reviewable work in the current interface.** Show the answer, proposed assignments, the evidence behind their routing, and what still needs the user. Clearly distinguish a proposal from a recorded plan, a request to send from delivery, and delivery from completion.
3. **Existing handoffs, then repeatable routines.** Extend the current Work flow through its single sending owner. Only after review, continuity, and outcome tracking work should repeated workflows become bounded, editable routines. Resource ownership and concurrency limits must precede broader parallel execution.

## Evidence states and language

The following are product states to represent, not a promise that the first endpoint returns this exact schema.

| State | Required evidence | User-facing meaning | Must not imply |
| --- | --- | --- | --- |
| Answer | The question and available context; sources or explicit context limits where applicable | COS answered or explained | A Work card was created, planned, or executed |
| Plan | Existing `workID`, selected `revision`, question, and a returned proposal grounded in current card/planner input | A proposed way to handle this card | The plan was recorded, approved, or sent |
| Review | User-visible plan and explicit choice about the concrete next action; current identity/revision checked again before a later mutation | The user can revise, record, or authorize the next supported step | An earlier planning request is permission to dispatch |
| Dispatch requested | A real request accepted by the existing Work handoff path | Sending has been requested | A session received the work |
| Delivered/running | Existing native receipt and session/progress evidence | Work reached its execution owner; progress is reported when available | The user's objective is complete |
| Completed/blocked/needs input | The existing session's outcome evidence, linked to the correct card and assignment | A result or a specific next decision is ready | A successful HTTP response or delivery receipt proves completion |

Revision changes require refreshing/replanning or a clear refusal; they must not silently apply a proposal to different card contents. Unavailable, stale, or missing evidence should be visible rather than presented as an empty successful result.

## Ownership and persistence boundaries

- **Persistent conversation is a separate owned workstream.** The conversation peer owns its storage, turn identity, retention, reload behavior, and native presentation. This server planning slice must not introduce a competing conversation store or assume that persistence is already complete. Coordinate a versioned integration contract with that owner before wiring the flows together.
- **Canonical Work remains authoritative.** An existing card supplies `workID` and revision. This slice does not capture a new task or synthesize a `taskID`. General conversation can remain an answer until a separate, explicit capture workflow exists.
- **COS Control remains the single sender.** Reuse the current Work handoff path, receipts, fences, and Stop behavior. The server may prepare plans and, in later authorized integration, use the existing request protocol; it must not create a second direct provider-launch or session-send path. See [Work orchestrator](work-orchestrator.md).
- **Recording is distinct from sending.** The existing lens-round design explicitly separates plan history from send requests. The new Ask planning endpoint performs neither. Any later integration must preserve that distinction and existing authorization checks.
- **Server availability is not Mac availability.** A server may remain reachable while COS Control or the Mac is offline. Plans may be prepared only to the extent required context and dependencies are available; dispatch through the native owner cannot be claimed to proceed without that owner. Show the connection limitation. Do not describe local execution as always-on or continuing with the laptop closed. The existing lens path reports disconnected Control rather than secretly launching another sender.
- **G2 is optional.** It can eventually expose the same conversation and Work records. It adds no independent execution authority. Existing verified-turn and action-specific approval rules continue to govern what can happen from that surface.

## First code slice: plan only

Introduce authenticated `POST /api/ask/work-plan` with the caller's existing `workID`, `revision`, and `question`. Resolve and validate that identity against canonical Work data and prepare a bounded plan using the existing planner facilities. Preserve normal API authorization and clear error handling.

The request is a proposal operation. It must not create a synthetic `taskID`, create or edit a task, automatically record the plan in Work history, queue assignments, dispatch to a provider/session, or start a background execution loop. Metadata-only operational logging is distinct from recording a user plan as committed Work history. Do not automatically retry by sending work through another path.

No exact response schema or newly invented error-code promise is specified here; the implemented route and focused contract tests define those details. The caller must treat a successful response as a proposal only. This first slice does not by itself deliver the full Ask COS experience.

## Build sequence

1. **Plan-only server contract.** Implement identity/revision validation, bounded input, canonical card resolution, proposal generation, and explicit failure behavior. Add focused contract tests proving that success has no recording or dispatch effects.
2. **Persistent Ask integration.** Coordinate with the conversation peer to connect saved turns to the existing native Ask surface. Broaden setup-only framing, preserve styling, and render answers and plans distinctly. Make reopen/reload and unsupported-server behavior reviewable.
3. **Review and explicit recording.** Present the concrete plan; let the user revise or intentionally record it through the established Work mechanism. Recheck revision and session availability before the next action. Keep recording separate from send authorization.
4. **Dispatch through Control.** Use the existing Work sender and evidence model. Verify disconnected, stale, duplicate, partial-send, stopped, and resumed cases. Reuse existing authorization instead of inferring approval from asking for a plan.
5. **Outcome follow-through and routines.** Connect receipts to actual session progress/results. Add bounded, opt-in routines only after successful end-to-end acceptance. Optional G2 access shares the same identities and state rather than creating another queue.

## Acceptance matrix

These are required checks for their respective phases, not assertions that they have passed.

| Scenario | Expected result | Phase |
| --- | --- | --- |
| Valid existing card, matching revision, bounded question | Returns a proposal tied to the existing card; no automatic recording or dispatch | First slice |
| Missing/invalid identity, revision, or question | Clear refusal; no fabricated task identity or side effects | First slice |
| Unknown card or changed revision | Refuse or require refresh; never silently plan against a substitute card | First slice |
| Planner/context unavailable or request interrupted | Clear failure/cancellation behavior; no success-looking empty plan and no execution fallback | First slice |
| Unauthenticated request | Existing API authentication rejects it | First slice |
| Proposal succeeds | Work history, send queue, receipts, canonical task files, and provider sessions are not mutated by this endpoint | First slice |
| Ask opens outside setup | General question/work framing using the existing COS design | Conversation integration |
| App reloads after a conversation | The conversation peer restores the appropriate turns and their proposal/result distinctions | Conversation integration |
| Older server lacks the planning route | Clear capability/update message; ordinary Ask remains usable where supported | Conversation integration |
| User reviews or revises a proposal | No execution until the supported explicit action and its authority checks | Review integration |
| Plan is intentionally recorded | History changes through its owner; recording alone never sends | Review integration |
| Mac or COS Control is offline | Visible limitation; no false dispatch/running claim and no alternate sender | Dispatch integration |
| Repeated send, changed card/session state, or partial result | Existing deduplication/fences/staleness checks apply; show per-assignment evidence | Dispatch integration |
| User stops or redirects work | Use the existing owner and show acknowledged outcome rather than assumed success | Dispatch integration |
| Receipt says delivered | Show delivery; do not mark the objective completed without outcome evidence | Follow-through |
| G2 requests an action | Same Work identity and existing verification/authority rules; no expanded permissions | Optional G2 integration |

## Scope and release note

Research and documentation do not certify runtime behavior. A plan-only server change still needs its focused validation and normal integration/release gates. Persistent conversation, native UI, review/recording, dispatch, follow-through, and optional G2 acceptance remain separate work until their owners provide evidence. No production deployment, runtime restart, or vendor integration is implied by this document.
