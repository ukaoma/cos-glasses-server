# Server 6.73.1 — model tier correction

## Resulting behavior

Stable GPT Max/Frontier selects the newest catalog-described frontier model. GPT Balanced selects the newest workhorse/balanced model. In the current Codex catalog this means Max = GPT-6-Astra and Balanced = GPT-6.1-Sol. Numeric versions alone cannot substitute a workhorse for a frontier model.

When both roles are not described, selection retains the previous newest-generation fallback. Hidden/small candidates remain excluded; explicit overrides, saved tier preferences, and last-known-good discovery remain intact. Existing companion 640 can receive the corrected catalog from the updated server. No transcription or cue settings change.

## Automated gates

- Actual local catalog replay resolves Astra to `codex-frontier`, Sol 6.1 to `codex-balanced`.
- Forward/reverse catalog-order tests verify the concrete execution model and visible labels.
- Future independent tier updates and hidden/small exclusions pass.
- Deliberately restoring numeric-version selection makes the reversal canary fail.
- Catalog, bridge, engine-session, and shared-preference regression tests; full server suite, TypeScript and production audit are recorded separately in the candidate receipt.

## Phone acceptance after installation

1. Verify server 6.73.1 in About. Companion 640 may stay installed.
2. Reopen model settings after reconnecting to refresh the server catalog. GPT Max/Frontier must correspond to GPT-6-Astra, GPT Balanced to GPT-6.1-Sol. Changing a tier must persist through reopening.
3. Send a short question using each tier. CLI DEBUG > Mode should report Astra for Max and Sol 6.1 for Balanced, unless an explicit server model override was deliberately configured. A model's self-reported name is not execution evidence.
4. Check Claude, Cursor and local model choices remain available as before.
5. Repeat one Fast and one HQ dictation check: both still follow the meeting settings introduced in 6.73.0.

## Private workspace retrieval acceptance

The private graph-lock change is a separate local script fix, not shipped in this public npm patch. It reads an existing shared lock without write access while retaining ingestion exclusion. Controlled workspace-restricted graph, bot-memory and meeting-vector reads passed; phone/G2 output remains a field gate.

With Codex selected, ask: “Search bot memory and meeting history for our Parakeet transcription decisions. Use vector search and the knowledge graph. Give me three bullets with sources, and report any retrieval error.”

Pass: actual retrieval results or an accurate coverage limitation, without inventing a Qdrant outage or graph permission failure. Fresh vector/memory results may exist while the graph has only older evidence. No permissions should be expanded to make this work.

## Delivery status

Candidate only until explicitly published and installed. Retain server 6.73.0 for rollback. No new EHPK, Control binary, native transcription process, flag change, or live-server restart is needed to prepare this candidate.
