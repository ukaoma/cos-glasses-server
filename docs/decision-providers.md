# Decision providers (candidate, October 14, 2026)

Jev remains the default. SubQ Snap is an explicit opt-in for the server's three classifier workflows. This branch does not install, publish, change running environment flags, change release versions, or alter generative orchestration.

## Configuration and rollback

The server reads these settings when creating each workflow client. Restart the server after intentionally changing them. No configuration was changed during this evaluation.

```dotenv
# Default when absent. Explicit values are jev or subq; auto is unsupported.
COS_DECISION_PROVIDER=jev
# Optional overrides: SESSION, COMPLETION, SEARCH
COS_DECISION_PROVIDER_SEARCH=subq
# SubQ key is environment-only, never copied from the TypeSafe key or saved by the Jev Settings UI.
SUBQ_API_KEY=<provide-through-private-runtime-environment>
# Each SubQ workflow has its own UTC daily budget and private usage ledger.
COS_SUBQ_DAILY_TOKENS=1000000
```

Remove the override or select `jev` and restart to roll back. The global setting applies only to these server decision workflows, not the COS Python interfaces below. Existing Jev key management, ledgers, budgets and `COS_JEV_SEARCH=0` search-off control retain their meanings. Jev key status describes the Jev key only. There is no new Control settings UI in this branch. Treat this as a backend candidate until the installed client is verified to accept provider `subq` in session and completion advice; older clients may recognize only `jev`.

Explicit provider failure never sends the same input to another provider. An unknown provider value fails client construction. SubQ authentication, credits, quota, request rejection, invalid answer, cancellation, timeout and breaker failures produce structured reasons. Session and completion advice return `provider: none`; search returns `available: false` and keeps word search available. There are no retries or automatic fallback mode. Successful session/completion advice identifies `provider: subq`; existing thresholds and abstention choices stay in place.

The SubQ client uses only the hardcoded official HTTPS endpoint with redirects refused, a 20-second timeout, a three-failure/hour breaker for transport/schema failures, and separate private token ledgers. It reserves a conservative UTF-8 body-byte estimate before concurrent requests can pass the budget, then records reported input tokens. Uncertain transport outcomes and unreadable successful responses count conservatively. Encoded image bytes make the preflight budget deliberately conservative. Redaction removes recognized secrets, email addresses and common phone formats in string values and keys; it is not a guarantee that arbitrary prose is anonymous. Images require explicit caller input and are never automatically captured, logged or saved by the client.

## Source inventory and boundaries

| Interface | Decision role | Candidate routing |
| --- | --- | --- |
| `server/lib/session-recommendation.ts`, `/api/work-board/session-recommendation` | Two choices: matching context and exact task; recommends Continue/Fork/New | `SESSION` override |
| `server/lib/work-completion.ts`, `/api/work-board/completion-check` | done/not_done/unclear, with existing completion thresholds | `COMPLETION` override |
| `server/lib/work-search.ts`, `/api/work/search` | Choice among redacted board texts plus none | `SEARCH` override; retains dedicated Jev search ledger and off switch |
| `server/lib/jev.ts` | Existing TypeSafe transport/key/budget; used through the server seam | Default preserved |
| MU `operations/scripts/work_intake.py`, class `Jev` | Meeting relevance/linking, responsibility, item candidates, existing-task matching, session repull | Read-only inventory; unchanged |
| MU `operations/scripts/jev_client.py`, `memory_rerank.py` | Prompt-time memory relevance/conflict scoring; code determines direction/selection | Read-only inventory; unchanged; 0.9-second hook deadline is especially important |
| MU `operations/scripts/work_slack_sweep.py` | Generative Slack collector through existing LLM backend; feeds intake, with comments mentioning Jev | Not a direct decision transport; unchanged |
| MU `operations/scripts/jev_trace_run.py` | Jev browser-use trace logging | Browser tooling, not a drop-in classifier call; unchanged |
| `server/scripts/work-review-candidate.ts` | Injects a private candidate Jev client into the same advice routes | Candidate-only helper; no change to its launch/config |

Generative Claude/Codex/Ollama engines, reasoning, tool execution, text generation, meeting extraction and browser action planning do not route through Snap. Snap's typed decisions do not replace a generative orchestrator. Python work intake and memory reranking need separate adapter/governance work and realistic labeled evaluation before any opt-in there; this server switch does not claim to control them.

## Official contract reviewed

Sources checked October 14, 2026:

- [Quickstart](https://docs.subq.ai/): public-preview access and credits requirement.
- [Decisions API](https://docs.subq.ai/endpoints/decisions-api/): `POST https://api.subq.ai/v1/systemone`, `subq-snap-preview`, 1–16 typed noul/choice/score questions. Noul is a probability, not a boolean. Choice includes the complete option distribution and confidence. Score includes legend/distribution/confidence.
- [Models](https://docs.subq.ai/using-the-api/models/): Snap supports image input and costs $0.05 per million input tokens, output free. This is distinct from the early-access generative `subq-preview` model.
- [Images](https://docs.subq.ai/endpoints/decisions-api/#images): up to four PNG/JPEG/WebP images as `{mediaType,base64}`, no data-URL prefix, 4 MiB each and 8 MiB total decoded, request body at most 13 MiB. Video is unsupported. Local client checks counts, base64, sizes and file signatures; the server remains authoritative for full decode validity.
- [Retention](https://docs.subq.ai/using-the-api/data-retention/): account default is indefinite storage; zero retention requires an organization policy. Per-request `store:false` is documented for Chat/Responses, not Decisions. Only synthetic fixtures were sent. This code does not infer or change the account's retention policy.

## Bounded live canary

[Machine-readable fixtures and responses](decision-provider-canary-20261014.json). Exactly 15 requests total, within the 24-request limit: 6 Jev and 9 SubQ. No retries, purchases, authentication failures, credit failures, quota failures, transport failures or malformed responses occurred. All HTTP responses were 200. Availability observations are limited to this short run.

| Evidence | Jev `jev-1.13.0` | SubQ `subq-snap-preview` |
| --- | --- | --- |
| Same six labeled text fixtures correct | 6/6 | 6/6 |
| Text median / max latency | 167.5 / 219 ms | 307 / 359 ms |
| Text input tokens reported | 2,264 | 863 |
| Separate flat-color image cases | Not sent; seam rejects images for Jev | 2/2 correct; 381 ms median |
| Additional plan-is-not-done smoke | Not paired | Correct; 303 ms |

The paired cases cover completed-and-checked work, blocked partial work, unrelated/insufficient evidence (`unclear`), an exact session match, no matching session (`none`), and no matching task (`none`). SubQ's additional plan smoke selected `not_done` at probability 0.9668. Both paired unknown-evidence cases selected `unclear`; there was no false completion in these fixtures. Offline schema validation passed for all eight saved paired-text/image SubQ responses without making more requests.

The image fixtures were generated 128x128 solid red and solid blue PNGs. Both color choice and no-readable-text noul were correct. This demonstrates the image request/response path and simple pixel classification only. It does not demonstrate screenshot grounding, OCR, object recognition, real UI understanding, or an advantage over a multimodal JEV baseline. No user's screenshots, meetings, memory or work content were transmitted. Live score questions were not evaluated; local schema tests cover score validation.

SubQ reported 1,431 total input tokens, estimated list-price cost $0.00007155 at the verified $0.05/M price. Jev reported 2,264 input tokens. Its existing COS rate constant is $0.042/M, giving an indicative $0.000095088; this is not a verified current TypeSafe invoice or account credit balance. Tokenization differs, so unit price, token count and end-to-end cost are separate observations. No credit purchase was made.

**Decision: keep Jev as default.** Both providers were correct on these small text fixtures; SubQ took longer. New image capability and lower observed token count do not establish stronger accuracy, latency, calibration, abstention or production availability. No completion thresholds were recalibrated. Image triage is an eligible future opt-in use case once retention is appropriate and representative synthetic/approved images are labeled. Existing text roles require larger representative comparisons before promotion; memory reranking additionally needs its strict hook deadline and no-store contract preserved.

## Validation

79 targeted tests passed across seven files, including 17 new provider tests. `tsc --noEmit` passed. Tests use one Vitest worker, isolated HOME/data directories, and no COS scripts directory. New coverage includes explicit routing/no fallback, provider identity through existing workflows, redaction, typed probability/schema validation, image rejection, official origin/redirect policy, HTTP error taxonomy, concurrent budget reservation, timeout, cancellation, breaker and abstention behavior. Existing Jev/route/search/recommendation/completion regression tests passed.

The repository's MU architecture drift detector was run as required by the architecture skill. It reported pre-existing LaunchAgent/documentation/recency/git-hygiene drift. Those unrelated findings were not repaired or treated as provider-canary failures.
