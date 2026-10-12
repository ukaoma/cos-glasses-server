# Private walk Ask replay

Exploratory offline canary. This folder does not change production endpoints, transcription, lens rendering or feature flags. Run only with private fixtures outside the repository.

Compare four evidence strategies with the same Sonnet answer contract: current production selection, full available transcript prefix, bounded local fuzzy retrieval, and tools-off Haiku intent followed by fuzzy retrieval. The four recorded questions retain their exact original transcript cutoffs. Four additional questions test older topics, caller claims, missing facts and irrelevant ordering language.

The retirement query is a deliberately narrow, deterministic public-topic allowlist proof, not a general-purpose privacy classifier. Generic public evidence comes from the production bounded web search. Controlled trials share that snapshot; separate end-to-end trials include a fresh search in the 30-second deadline. No private conversation words are sent to public search. Model runners have no tools or connectors. All experimental flags are disabled in the isolated child environment.

Before rollout, manually judge factual support for each cited passage, directness, missing-fact abstention and summary coverage. ID validity alone is not citation correctness. Repeated runs from one meeting do not establish broad reliability or a production latency percentile.

Two subsequent refinements are evaluated separately from the original paired comparison. `scoped-v2` narrows account-rule evidence, explicitly gives the current action precedence over prior questions, and uses the complete available prefix for a broad summary. `guarded-v3` adds deterministic word/amount/citation checks and at most one rewrite under the shared deadline. The fresh searches use a public IRS site query. These change several factors together; results cannot be attributed to retrieval alone. These prototypes are specific to this topic and are not production privacy controls.

The site-query trials failed the page-read gate despite meeting the timing limit. Subsequent trials explicitly require a page read before answering, compare the original broad query, and test a fixed catalog of two independently verified official public pages. The catalog is a topic-specific complementary path, not proof that arbitrary questions can skip discovery. Exact-source and coverage-warning review remains manual. Scripts evolved during this exploratory run; retain the private designs, raw trials, and findings rather than presenting it as a blinded benchmark.

```sh
node --test canaries/walk-ask/retrieval.test.mjs
node --import tsx/esm canaries/walk-ask/web-probe.mjs /absolute/private/output
node --import tsx/esm canaries/walk-ask/replay.mjs /absolute/private/output controlled
node --import tsx/esm canaries/walk-ask/replay.mjs /absolute/private/output repeat
node --import tsx/esm canaries/walk-ask/replay.mjs /absolute/private/output end-to-end
node --test canaries/walk-ask/scoped-retrieval.test.mjs
node --import tsx/esm canaries/walk-ask/replay.mjs /absolute/private/output refine
node --import tsx/esm canaries/walk-ask/replay.mjs /absolute/private/output guarded
node --import tsx/esm canaries/walk-ask/replay.mjs /absolute/private/output guarded-repeat
node --import tsx/esm canaries/walk-ask/replay.mjs /absolute/private/output guarded-end-to-end
node --import tsx/esm canaries/walk-ask/replay.mjs /absolute/private/output guarded-broad-end-to-end
node --import tsx/esm canaries/walk-ask/replay.mjs /absolute/private/output curated-primary
node --test canaries/walk-ask/research-gate.test.mjs
```

Private directory must contain `recorded-exchanges.json` and `web-pack.json`; scripts write design, raw trials and isolated audit rows there. Do not commit fixture or replay content.
