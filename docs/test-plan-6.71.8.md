# Server 6.71.8 candidate: Meeting Ask grounding and citations

Includes the pending 6.71.7 interactive-question broker update. This plan adds to
`test-plan-6.71.7.md` and the 6.71.5 web/privacy acceptance gates; none is replaced.
The candidate is built in `codex/meeting-grounding`, based on `595ebf4`. Server
6.71.6 remains reserved for the separate workstream. No public release is implied.

## Behavior and boundaries

- Select complete neighborhoods within the existing 32,000-character transcript
  budget. Broad money questions retain corrections, dates, units, balance
  statements and conditional setups across the recording. The last-ten-minutes
  contract for What to ask is unchanged.
- Prior answers remain navigation context. Strip their request-local citation
  tokens; recover at most 16 server-owned transcript quotations within 6,000
  characters of quoted text and metadata. Current admitted wording wins for the
  same turn. Keep the prior four question/answer pairs bounded. Scope by meeting,
  server instance and audio cutoff. Do not restore old file revisions or invent
  a canonical turn target for finalized quotations.
- Keep current and recovered transcript IDs distinct from finalized quotation
  IDs. Saved answer records remain immutable. Later uploads enrich a new Ask;
  they do not rewrite an earlier answer.
- A narrow cash backstop prevents cited hypothetical proceeds from becoming
  current balances or a fabricated conflict with a current screenshot. It carries
  scenario wording across nearby short chunks, preserves explicitly separate
  current evidence, and does not use unrelated liability amounts as cash proof.
  This is not general numeric entailment, tax validation or a financial audit.
- Prompt guidance preserves explicit corrections while keeping final documents
  unverified, distinguishes historical transactions from proposals, avoids
  guessed bill types and unnecessary ordering language, and favors central
  personal-conversation facts. Confidence remains qualitative on every answer.
- No additional provider call, new dependency, automatic public lookup, ASR
  rewrite, timestamp configuration or background job is introduced.

## Automated gates

1. Typecheck and the complete server suite on frozen source.
2. Regression cases: conditional cash, independent current balances, false
   current-versus-future conflicts, split scenario chunks, correction neighborhoods,
   broad financial retrieval, repeated citation labels, future/cross-meeting
   recovery, forged client source metadata, old file revisions and finalized-ID
   collisions. Existing old-client routes, web consent/privacy, canceled requests,
   completed-record immutability and question broker tests must stay green.
3. Isolated mutation gate: stale labels, cross-meeting/future/file recovery,
   disabled cash guard, fragmented evidence, finalized citation collision and
   loss of scenario context. Require a green baseline and assertion failures for
   all eight mutations. Never mutate the release checkout or live data.
4. Pack inventory: test files and private recording/replay artifacts are absent;
   the new runtime modules and this plan are present. Verify the frozen tarball
   SHA-256 and a fresh-cache local-tarball CLI help invocation.

## Private recording replay

Keep the actual recordings, screenshots, request snapshots, provider answers and
receipts outside this public repository and npm package. Use the original
question cutoffs: Summary at 20:59.633 and money highlights at 37:53.548. Later
financial passages and files must not leak backward into these comparisons.

Replay the original selected provider with tools, connectors and hooks disabled,
using isolated data/audit directories and a 30-second cancellation deadline.
Compare the original field answers, a fresh baseline, and three candidate money
answers. Also run one candidate summary and a new Ask with the uploaded files.
Record all failed rounds; do not replace the original negative evidence with
only a passing scorecard. Inspect actual prose and supporting quotations: a
citation-membership check alone does not prove that a claim is true.

Required observations:

- Conditional proceeds stay conditional; present cash is not invented.
- The explicit bill correction is available and recognized; the final invoice
  remains unverified. A corrected subissue does not settle the entire bill.
- Earlier reported savings retain an original quote and a current scoped citation.
- Historical conversions are distinguished from the later stop-converting stance.
- A file-aware answer cites the current file revision, distinguishes present
  balances from future scenarios, leaves ambiguous OCR labels unresolved, and
  treats nonmatching exact totals as a discrepancy rather than rounding them equal.
- One provider call and no public/private search per replay; each observed run
  completes within 30 seconds. This small recording replay is not a general
  latency guarantee or a transcription-accuracy qualification.

## Field acceptance before the combined public release

Use the supported COS Control-managed candidate installation path. Preserve the
known-good 6.71.5 generation; do not start another server. Reinstall hooks once
because this candidate includes 6.71.7. Complete the existing phone 629 status
and question-broker acceptance rows in `test-plan-6.71.7.md`.

On a saved meeting, ask:

> What are the money highlights so far?

Then:

> Separate current balances, past transactions, and hypothetical plans. Show what
> still needs confirmation and cite each source.

Attach a document or screenshot, then:

> Update the highlights using the new file. Which figures are supported by the
> file, and which were only discussed as possibilities?

Open each citation on both phone and Control. It must show the supporting
quotation/file revision, not the passage that happened to reuse an older number.
Repeat while new chunks arrive; prior completed answers remain unchanged. Check
old 624/627/628 companion compatibility and the existing 629 status stability gate.

## Flags, rollout and rollback

Keep `COS_BATCH_HQ_TIMESTAMPS`, `COS_MEETING_ASK_HQ_EVIDENCE`,
`COS_LIVE_CUES_FOUNDATION_DEV`, `COS_LIVE_CUES_GROUNDED_V2` and
`COS_LIVE_CUES_RESEARCH` disabled. Retain the existing progressive-HQ baseline
configuration. These changes do not claim better raw transcription.

The candidate combines both server updates without altering their other
worktrees. Merge only tested branches. npm publication, registry integrity,
clean-cache registry install and marketplace promotion remain separate release
steps. Assess release notes/docs and current companion/Control compatibility at
that time. The grounding change needs no new client API or EHPK; frozen 629
remains the separate phone-status candidate.

Rollback: reinstall retained public server 6.71.5 through Control and reinstall
hooks again. The question-rule off switch from 6.71.7 remains available. Keep the
previous 628 EHPK and its hash; no completed Ask records are migrated or rewritten.
