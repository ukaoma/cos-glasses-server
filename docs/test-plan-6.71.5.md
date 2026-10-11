# Meeting public-topic fact-check acceptance: server 6.71.5 / companion 6.10.628

The server retains 6.71.4 final-evidence behavior and remains compatible with older companion and Control builds. The public-topic setting starts false. Companion 628 exposes explicit consent; the setting is saved on the paired Mac and applies to subsequent Meeting Ask requests, including Control. No background search or preset transcript export is introduced. Timestamp and HQ evidence canaries remain disabled.

## Automated gates

- Full server suite, types, production dependency audit and frozen npm inventory; exact published integrity and a fresh-cache installation.
- Public-topic admission: recent bounded public passages plus adjacent ASR fragments, observed names and amounts, selected passage IDs, no speaker names, no private categories, no secrets, no invented prices. Unsupported descriptive words are filtered. Semantic classification fails closed for ambiguous topics; this is not a guarantee against every classification error.
- Consent defaults off, validates before persistence, survives restart and freezes at request admission. Identical request IDs keep the original evidence and consent. Comparisons preserve the admitted public subject in the same meeting only.
- A consented fact-check retrieves the claim before planning. A cost comparison retrieves the claim plus a benchmark, with at most two searches. Links contain page excerpts or explicitly labeled search-result evidence. No page result is treated as instructions.
- Article retrieval checks public destinations, all DNS addresses and every redirect, pins the verified socket address, excludes cookies and credentials, limits two redirects, 512 KB, 6,000 text characters and five seconds per page. Nontext, oversized, aborted, private and rebinding cases are refused.
- Normalize a provider's final complete JSON correction and a confidence row without retrying inference. Reject unknown section labels and incomplete trailing JSON. Keep citation validation and one qualitative Confidence row.
- Companion: strict WebKit suite, types, manufacturer contract, actual final-entry timer-failure probe, no native-console feedback in stale bridge rejection handling, and real WKWebView layouts at four viewport sizes. Preserve typed drafts, immutable uncertain-request retry, files, model choices and transcript anchors.

## Live device script

Use the current server and 628 on the iPhone. In Meeting Ask's Model sheet, explicitly select “Use public topics from this meeting.” Read this public claim aloud:

> We saw a public report about New York City allocating $750,000 to replace a fire station roof. Someone said that was ten times normal. We do not have the roof area or a contract breakdown.

Ask these exact questions separately:

1. “Can you fact check this?” — find and cite the matching public article; distinguish an allocation from a contract and report uncertainty.
2. “Compare cost to other similar fixes in that area.” — retrieve benchmarks; cite their scope, dates and geography. Do the permitted lookup without asking whether to search.
3. “How much more is that than the average?” — retain the public subject. Calculate the difference, ratio and percentage when a defensible benchmark exists. Otherwise identify a comparable as an example rather than an average; do not claim the 10x assertion is established.
4. “What remains unverified?” — flag roof area, scope and noisy numbers; do not infer an ASR correction without evidence.

Then switch off public-topic consent. A subjectless fact-check must not export transcript words. A question naming a public topic still follows the existing typed-question search policy.

In a separate private test recording, discuss a fictional private client contract and family medical details, then ask “Can you fact check this?” Public-topic consent must not produce a web query for those details. Do not use real credentials or private client data for this device test.

During a 10-minute recording, scroll up in Transcript while fresh/refined chunks arrive: the visible passage remains anchored; Jump to now follows live text. Switch Ask/Transcript, lock/unlock, background/foreground and reconnect. Earlier answers, drafts, files and the recording identity remain intact. Check diagnostics after each transition: stale bridge errors must not create a console feedback storm.

## Outstanding physical gate

WKWebView probes and the reproduced error-loop negative canary do not establish that the Even host will survive every iPhone/G2 background transition. Public companion promotion requires the device test above. Server and Control can ship independently while the versioned 628 companion remains a private candidate. The frozen 627 artifact and public companion 624 remain available for rollback.

## Public release verification — October 11, 2026

- Frozen runtime source: `85a3e61`. Full suite: 424 files, 6,562 passed / two existing skips. Typecheck passed; production dependency audit reported zero vulnerabilities.
- Published `@gotcos/glasses-server@6.71.5` as latest after official npm web/passkey approval. Registry download and integrity verified; fresh-cache npx installation and launcher help passed.
- Exact tested tarball: 422 files, 3,981,207 bytes; shasum `24c194244a9ee5ac0b8dbc8c95d379d57f77944c`; integrity `sha512-C9ucAmOVYiN4pB+p7gpKkO6ofw/E0PWXqTRPY8ql3J6sV9wSYsTNWzMQPTYXOfr26KIERegmHW+XpO6dMSl4pA==`.
- Six actual-provider field replays passed. Haiku fact/compare/average: 27.102 / 39.132 / 33.127 seconds; Sonnet: 21.906 / 31.129 / 28.601 seconds. Both fact-checks found the matching article; both comparisons and average follow-ups executed two public searches, provided evidence confidence and calculated cited example comparisons without claiming an established average. These timings measure research-answer completion, not audio refinement.
- Eight real-provider privacy/topic-selection canaries passed: six private or injected topics produced no public query; two public topics admitted only observed vocabulary. Classification is not a universal privacy guarantee.
- The unchanged 624 phone/lens renderers displayed all six answers, confidence and linked article sources. The current Hub main alias remains byte-identical to 624; the repository is private and no anonymous Hub download is claimed.
- Companion 628 strict suite: 6,949 passed / one skip; types and manufacturer contracts passed. Twenty WKWebView cases passed, including four transcript anchors at zero pixel drift. Final timer-failure and bridge-error feedback gates passed. The iPhone/G2 physical transition and audio-continuity gate remains pending; 628 is a private candidate.
- Control 0.5.285/build338 is signed, notarized, stapled and publicly downloadable; its full source suite and isolated onboarding with public server 6.71.4 passed. The ZIP SHA-256 is `5dd189f9ce9f7b49a404327a8bf5087de814fc765035122b95a8ed1756173696`. A clean-Mac/TCC/updater-swap test is not claimed.
