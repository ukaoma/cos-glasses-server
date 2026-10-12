# 6.71.10 candidate — concise grounded Meeting Ask

This adds to 6.71.9 image text and the earlier candidate broker/privacy gates.
It changes answer retrieval, response instructions and link attribution, not transcription.

## Release integration

- Server: merge `codex/hc-meeting-answers` on top of 6.71.9. Includes the prior image-text and question-broker work; do not replace those changes with an older branch.
- Phone: merge the 630 citation branch based on the 629 meeting-grounding ledger. Keep 629 as rollback. No package identity, SDK or permission change.
- Control: merge the separate citation branch into the next Control release alongside other approved work. It does not change the scripts-directory or memory/threads provider selection. That separate work still needs its own canaries.
- Keep `COS_BATCH_HQ_TIMESTAMPS`, `COS_MEETING_ASK_HQ_EVIDENCE`, `COS_LIVE_CUES_FOUNDATION_DEV`, `COS_LIVE_CUES_GROUNDED_V2` and `COS_LIVE_CUES_RESEARCH` unset/0. Preserve the released progressive-HQ baseline.
- Candidate packaging and draft PRs do not promote npm latest, the Hub main alias, Control appcast or marketplace state.

## Automated checks

1. Named-speaker neighborhood selection stays inside the existing evidence budget. History remains server-owned, request-local and cutoff-scoped.
2. Clarification of an account/project guides retrieval without establishing new amounts, commitments, deadlines or identities.
3. Public application/link/documentation requests honor the existing public-word and sensitive-detail gates. Primary-source ranking only chooses among observed URLs; retain DNS/address checks and at most two page reads.
4. Plain and Markdown public links resolve to observed URL sources, not summary cards. Unobserved links are withheld; invented source IDs never acquire targets.
5. Selected context does not automatically make an explicitly cited fact uncertain; incomplete/unavailable evidence still affects confidence.
6. Full server suite and TypeScript, companion suite/typecheck/Even contracts, native Control compile and core citation checks. Phone WebKit: repeated T1 IDs in different answers open the owning retained source, never another answer; unknown IDs stay inert.
7. Replay a private field recording using each original question's transcript cutoff and an isolated journal. No future turns or transcript-based search vocabulary outside existing consent gates. Keep failures, source-read counts, latency and raw outputs in the private release ledger.

## Phone / Control field gates

Use Claude Sonnet. Old saved answers are retained; submit new questions to test the new server.

1. In a saved meeting with several speakers, ask: `Summarize [speaker]'s updates for [account]. Keep it brief.`
2. Correct it: `I mean [account] managed by [speaker]. Summarize those updates.`
   Pass: accepts the intended account, includes the relevant speaker passages, avoids guessing done/status or attaching a deadline to the wrong feature. Normally <=120 words including confidence.
3. Tap a T citation within each new answer. Pass: expands the exact retained quote for that answer. Show in transcript works only where its turn still exists; an older answer retains its quote.
4. Ask a public application/link question naming the public program. Tap W in the answer and open its URL. Pass: direct link, observed URL source, distinguishes search-result-only evidence from a page read; no invented credit amount or annual recurrence.
5. Ask for the reported method behind a time saving. Pass: describes the method, calls hours a participant report, does not invent a garbled page count or independently verify savings.
6. Switch Ask/Transcript while polling; scroll up, then open/close source details. Pass: preserved reading position and no new jump. Repeat with the keyboard visible and in landscape. The pre-existing short-viewport composer issue is recorded in the private ledger and must not be called fixed by this release.
7. Repeat the image-upload and question answer/Esc gates from 6.71.9/6.71.8. Test memory/threads against the same pre-install totals if other provider setup changes are merged.

## Promotion / rollback

Promote only after the physical phone and Control citation taps, prior image/broker gates and integration checks pass. A replay is evidence of improvement on the sampled recording, not a general guarantee of factual accuracy or phone end-to-end latency. Keep malformed model replies visible as failures; do not add hidden retries to make replay numbers pass.

Rollback candidates by restoring the prior packaged server, 629 companion and previous signed Control app. Preserve stored meeting journals and file revisions. If downgrading below the pending broker changes, reinstall hooks as the prior test plan requires.
