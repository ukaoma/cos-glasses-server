# Server 6.71.2 combined test plan

Private candidate, October 11, 2026. Combines server 6.71.1 (`ce35151`)
with the transcription canary branch. No client binary changes are included.
Public distribution and transcription adoption are separate gates.

## Release decision

The production live decoder keeps compact JSON and disabled DTW. Both new flags
remain unset/off: `COS_BATCH_HQ_TIMESTAMPS` and `COS_MEETING_ASK_HQ_EVIDENCE`.
The legacy batch fingerprint is unchanged with timestamps off. The combined
server retains the 6.71.1 Meeting Ask features. Do not enable refinement during
normal meetings until its latency and human accuracy gates pass.

## Automated regression checks

Run from the combined worktree, with Vitest's isolated data/profile configuration:

```sh
npm run typecheck
npm test
npm run mutation:gate -- asr-canary-raw-clock asr-canary-native-count \
  asr-canary-lost-tail asr-canary-changed-number \
  asr-canary-control-bypasses-refinement asr-canary-future-evidence \
  asr-canary-stale-cache asr-merge-ended-overlay asr-merge-lost-source
npm pack --dry-run --json
```

| Contract | Required result |
| --- | --- |
| Disabled flags | Same live transcript response and batch cache identity as the released path; no HQ cache read on GET. |
| Ended meeting | Saved sidecar IDs, source, duration, ended notice and close time survive with HQ on or off. Active-file and Markdown fallback still work; missing words return the released 404. |
| Direct Control submission | Refine only admitted, normalized evidence. Saved source quotes reflect the frozen evidence. Original request fingerprint governs retries. |
| Live tail and cutoff | New uncovered speech remains; no checkpoint ending after the question cutoff may replace evidence. Mixed voices receive no inferred identity. |
| Phone files | Real uploaded text remains ready/citable beside Control files; secret, unsupported, expired, missing and oversized statuses retain their contracts. |
| COS lookup | Meaning is default; keyword causes no embedding request. Settings survive restart and malformed updates write nothing. |
| What to ask | Recent topic gets evidence priority and citation ordering. At most one COS lookup/two model calls; no preset web request escapes to web. |
| Combined answer | One refined direct request can cite the real phone document, use keyword COS search, preserve notices and replay once without re-running refinement/model. |
| Capture protections | Compact live JSON, disabled DTW, raw audio persistence, cancellation, Metal preemption and CPU fallback remain covered. |
| Packaging | Candidate version differs from installed 6.71.1. Private audio, receipts, fixtures, test suites and native canary workers are excluded. |

The mutation run must start with a green baseline, reject every selected mutant
through an assertion failure (not compilation/setup failure), and restore sources.
Full-suite counts and artifact checksums are recorded in the private release receipt.

## Native evidence carried into this merge

The timestamp parser, native batch call and checkpoint validation are unchanged
from the qualified canary commit `7479e21`; the merge adds the released Ask
resolver and phone/search work. Previous private probes covered CPU/Metal silence,
near silence, short/empty/malformed inputs, eight real speech clips, cancellation,
preemption and CPU retry. Native output clocks were finite/bounded. Some tokens
have zero duration; these are heuristic token clocks, not precise word boundaries.

Concurrent probes used 50 compact-JSON ASR requests and 50 warm ANE diarizer runs
per arm. ASR p95 was 339 ms baseline / 325 ms candidate; diarizer 185 / 173 ms;
API health 53 / 87 ms (candidate maximum 220 ms). The cold isolated diarizer failed
to load in the first bounded attempts; the paired comparison used a warm cache.
This is limited evidence, not proof of zero regressions or of cold-start safety.
Repeat native probes if decoder/parser/checkpoint code, native binary, model,
thread policy or hardware changes. See [transcription qualification](asr-canaries.md).

## Local installed acceptance and client checks

Keep the previous managed 6.71.1 generation and package as rollback. Before a
candidate switch, confirm no active capture or Ask; use the COS Control managed
runtime installation, never the retired app LaunchAgent installer. Record before
and after generation/version, exact listener ownership and API/Whisper health.
New flags must remain off in the installed launch environment.

The following require an actual client/device session and remain pending until
observed; server tests alone do not count:

- Start a short controlled meeting. Speak an owner, a number, a negative statement
  and a deadline; change the topic and correct one decision. Verify initial text
  continues immediately and ask about each fact. Check source quote, time and ID.
- On Control and the current phone build, use Catch me up, Summarize, Action items,
  What to ask and a typed question. Check recent-topic questions and the section
  rendering. Retry one request after navigation; history/export remain consistent.
- Add a real TXT or PDF text file from the phone and a file from Control. Ask a
  question requiring both meeting text and the file. Verify ready/unsupported
  notices, removal and saved historical citations.
- Switch COS search to keyword and back. Trigger a COS lookup, check its notice,
  and verify a preset cannot invoke web search. A public typed lookup retains its
  established privacy policy.
- End and save the meeting; reopen Ask, ask a follow-up, then open an earlier
  source in the transcript. IDs and ended notice must still match.
- Read the answer on the lens and phone, including sources and scrolling. Capture
  glitches, wrong facts, missing text, crashes or an unhealthy service block release.

Rollback the candidate through the managed generation selector if any installed
regression occurs. Do not delete raw audio, canonical transcripts or Ask history.

## Tangible transcription improvement gate (currently blocked)

1. Human-correct the reference transcripts in all speech strata and verify at
   least 200 entity mentions. ASR silver transcripts cannot certify fact fidelity.
2. Replay the actual capture-to-Ask path across at least 13 meetings. Measure
   speech-to-refined-evidence p95 including buffering, ingest, queueing and decode,
   with concurrent capture, diarization, CPU fallback and cold start. It must be
   within the accepted **30 seconds** and preserve the initial live transcript.
3. Require paired meeting accuracy gains with uncertainty intervals, plus reliable
   answers for names, amounts, negation, owners, deadlines and changed decisions.
4. Run silence/non-speech positive controls, native failures and longer thermal
   contention trials; preserve saved raw audio and canonical transcript hashes.

Current production-policy CPU candidate decode took **142.641 seconds** after
sealing a **36.25-second** window, so the first-word lower bound is **178.891 seconds**
before ingest/queue time. The sealed window alone exceeds 30 seconds. This blocks
refinement adoption even though the silver WER improved from 15.718% to 12.986%.
No ASR engine, prompt or accuracy claim is being promoted by this combined build.
