# Source-bound speaker groups and span views

**NOT IMPLEMENTED. NOT RELEASE QUALIFIED.** No automatic repair or release is authorized by this design. The current100% activity-coverage whole-chunk planner returns no useful repair. The private80% local-coverage experiment is NO-GO: estimated ASR token runs do not prove the purity of native/VAD gaps. Accepted whole-call group edges are not proof of every occurrence's localization.

## Separate identity from localization

Represent a capture-local acoustic group independently of where a transcript claims that person spoke. A `Voice A → Voice B` map has no interval scope, unknown remainder, protected-row membership or provenance. It cannot encode partial confidence and must not authorize every occurrence of either old label.

The smallest useful next consumer is grouped review: one card and one naming decision for an explicitly scoped set of supported members, while unreviewed tails and ambiguous boundaries remain visible. Do not add another unused preparation helper.

An optional identity-alias view is under architectural review. Its only defensible automatic semantics are regrouping **existing estimated anonymous labels with unchanged localization confidence**. Such a view may alias a surface already carrying a Voice label; it cannot infer a Voice for a batch word currently marked Ext/Unknown from the raw chunk's Voice. If a grouped turn label would be interpreted as proven same-person membership for an unsupported tail, the alias belongs only on the review card, not that turn. This semantic boundary requires review before implementation.

## Minimal contracts

```ts
type Group = {
  groupId: string; cohortProofHash: string;
  baseDocumentHash: string; ledgerHash: string;
  projectionRevision: number;
  memberSpanIds: string[]; qualifiedWholeChunkIds: number[];
  originalVoiceHints: string[]; // diagnostics, never global identities
  estimatedWordRefs: WordRef[];
  uncoveredIntervals: SourceSpan[];
  ambiguity: string[];
};
type SourceSpan = {
  rawChunkIndex: number; wavSHA256: string; pcmSHA256: string;
  startSample: number; endSample: number;
};
type WordRef = {
  segmentIndex: number; wordIndex: number;
  sourceSpanIds: string[]; timingKind: 'asr-estimate';
};
type ReviewedGroupName = {
  groupId: string; proofHash: string; expectedSourceRevision: string;
  reviewedSpanIds: string[]; name: string;
};
```

Bind the complete original and current per-copy JSON bytes, full legacy correction ledger, ordered raw WAV/PCM hashes and sample counts including silence, actual timeline reconstruction, complete native/export bytes, policy/evaluator version and model/CLI resource manifests. A SHA integrity check alone does not authenticate native execution. The future trusted caller owns actual file verification and execution receipts.

Native-exclusive intervals and estimated word intersections are useful review pointers. They are not themselves a new speaker-purity qualification. A future qualified text projection must keep a whole token unknown when its interval crosses an uncovered/ambiguous boundary. Missing word alignment permits an audio span pointer, not guessed token attribution. Never split token text to simulate precision. Unknown means unassigned speech; it is neither silence nor another person.

## Authoritative consumers

One resolver must supply the same full view to all of these consumers:

- `server/routes/meeting.ts` `/speakers`: grouped review cards, protected names, coverage and evidence scope.
- The same file's `/content`: transcript, clipboard forms and attendee evidence. Rendering currently reads Markdown via `parseScribe`; changing review chunks alone is insufficient.
- `server/lib/voice-directory.ts`: consistent identity aggregation without promoting anonymous group estimates into asserted names.
- `server/lib/meeting-speaker-review.ts`: separate identity grouping, localization status and actual named confidence; no invented capture similarity.
- `server/lib/mac-speaker-repair-render.ts`: exact token/prefix rendering only after source/word scope is established. Export/sync consumers must explicitly use the same versioned view or declare themselves original-source exports; no silent legacy fallback with conflicting labels.

`mac-speaker-repair-projection.ts` and `mac-speaker-live-projection.ts` remain whole-original contracts. They must not be weakened into partial-span writers. `mac-speaker-machine-evidence.ts` currently returns chunk-position name claims and must continue validating the original base before any composed view is produced.

## Preserve existing proof and human intent

Keep canonical chunks/raw entries/batch words/transcript, existing192d receipts and `correctionRevision` unchanged for an additive view. Store its proof and revision separately. Current machine proof binds the complete speech document and correction revision: mutating either can withdraw qualified Jeremy assertions even when his own rows were untouched.

Composition precedence is human/current protected spans, then currently valid existing machine-name proof, then independently qualified new span claims, then explicit unknown. Existing named rows and manual markers on every stored surface remain protected. Legacy ledger positions join through exact compacted-to-raw source mapping. Empty global confirmations retain the existing conservative behavior until a separately reviewed scoped adapter exists. Do not fabricate global human confirmations or training records.

Any base/ledger/source drift invalidates the new view before exposure. Publication must recheck source and ledger CAS immediately before the write; store a durable intent, immutable before/after images and one coherent revision. Partial resume/undo must refuse unrelated later edits. Every reader consumes a full revision, including withdrawals; no stale group survives a failed binding check.

A group naming action applies only to the submitted, exact reviewed member set under its current proof hash/revision. It cannot silently name all old Voice occurrences, unknown remainder, future evidence or another capture. New group members require renewed qualified evidence or explicit review. Cross-call reuse requires independently qualified, source-bound enrollment/profile evidence and its own approval/training contract; a human group name is not enrollment consent.

## Acceptance and next implementation boundary

Implement grouped-review read/action and the authoritative composed reader together, with a concrete route consumer. Measure naming decisions saved, supported/unknown speech, original fragment count and grouped identity estimates separately. Do not claim a person-count reduction by hiding unknown speech. Existing Ext/Unknown batch content stays unassigned unless independently qualified; root grouping must not manufacture batch Voice assignments.

Before release: prove prior-name preservation, all-surface agreement, explicit membership CAS, late-confuser withdrawal, correction races/restart/undo, token-byte/time invariance and actual closed-call benefit. The Industry original counterfactual and its already-human-corrected current copy are separate denominators. Neither the accepted-edge count nor a null whole-chunk plan demonstrates a completed repair. No additional threshold/native experiment is required to specify and implement these contracts; no production enablement follows until their independent QA passes.
