# Transcription qualification

The objective is reliable answers during a live meeting: names, quantities,
negation, owners, deadlines, decisions and corrections must survive ASR. The
initial live transcript remains available immediately. Refined passages must be
available within 30 seconds of speech, including buffering, scheduling and decode.

## Current decision

**Hold rollout. Both new flags default off.** Ordinary CLI timestamps plus native
VAD remapping are promising on the private silver corpus. The historical live
verbose-JSON and DTW crash mechanisms retain their existing protections.

Native probes exercised silence, near silence, a 5 ms clip, empty PCM WAV,
malformed/truncated input, eight real speech clips, cancellation, Metal
preemption and CPU retry. Eight remapped clips had finite ordered token clocks;
some tokens still have zero duration. These are heuristic token timestamps, not
human-validated word boundaries or speaker identities.

A concurrent private probe ran 50 compact-JSON ASR requests and 50 warm ANE
diarizer runs for each of the baseline and candidate. Candidate ASR p95 was
325 ms versus 339 ms; diarizer p95 was 173 ms versus 185 ms. API health p95 rose
from 53 ms to 87 ms (maximum 220 ms). These small samples do not establish zero
regression risk. Initial isolated diarizer cold loads timed out; the successful
comparison used the same warm, isolated model cache for both arms.

The CPU batch used production progressive settings: six threads, CPU only and
macOS background task policy. It took **142.641 seconds**, versus 131.797 seconds
for baseline. Adding its 36.25-second sealed window gives a first-word delay
lower bound of **178.891 seconds**, before ingest or queue time. Even the last
words wait longer than 30 seconds. Foreground CPU and idle Metal timings cannot
substitute for this production policy.

## Experimental boundaries

- `COS_BATCH_HQ_TIMESTAMPS=1` applies only to meeting batch CLI decoding. It omits
  `--no-timestamps` and preserves native diagnostics needed for the exact VAD
  table. Timestamp mode partitions checkpoint fingerprints. Missing JSON or
  timing evidence fails closed; rollback uses the existing legacy decoder.
- `COS_MEETING_ASK_HQ_EVIDENCE=1` additionally requires timestamps and
  `COS_MEETING_PROGRESSIVE_HQ=1`. Ask reads completed sealed checkpoints; it
  never starts a decode. Audio hash, configuration, context chain, session and
  ASR completion must match. Runtime coverage/number/clock guards catch obvious
  corruption; they cannot establish semantic accuracy.
- Current Control submits live turns directly. Refinement occurs at v2 request
  admission and in the optional transcript endpoint. Latest uncovered turns are
  retained. Refined source IDs point to the first original chunk. Mixed voices
  use `Unidentified`; no owner is inferred from guessed token attribution.
- A request's submitted fingerprint remains unchanged. The answer's saved source
  text records the evidence used. A retry reuses the saved exchange even if new
  checkpoints arrive. Files, web search policy and answer model are unchanged.
- The legacy live-ask endpoint retains its original transcript behavior.

## Repeatable checks

From the isolated server worktree:

```sh
npm run typecheck
npm test
npm run mutation:gate -- asr-canary-raw-clock asr-canary-native-count \
  asr-canary-lost-tail asr-canary-changed-number \
  asr-canary-control-bypasses-refinement asr-canary-future-evidence \
  asr-canary-stale-cache
```

The native workers are excluded from the npm package. They require an explicit
private `COS_ASR_CANARY_ROOT`, `COS_DATA_DIR`, `COS_PROFILE_PATH`, and a read-only
`COS_ASR_CANARY_ACTIVE_DIR` pointing at the real server's active-session directory.
Data, profile, audio and outputs must reside under the private root. The guard
refuses work during a real meeting and aborts owned work if one starts. Native
results and audio stay outside this public repository.

```sh
node --import tsx/esm server/scripts/hq-native-canary.ts INPUT.wav OUTPUT.json cpu
# Other modes: metal, abort, preempt. Set the timestamp flag for candidate runs.
```

The contention worker additionally requires a separately owned persistent
Whisper server at `COS_ASR_CANARY_PORT=18278`, an offline `COS_NEMOTRON_CLI` wrapper,
and explicit `COS_NEMOTRON_MODELS`. The wrapper must preserve the isolated
CoreFoundation home, model cache and network-denying sandbox. It accepts a batch
WAV, live-chunk WAV and output JSON path. It reads the actual API health endpoint
but never starts, restarts or sends transcription to the real live server.

## Required before adoption

1. Replace machine reference drafts with human-corrected transcripts across the
   four speech strata and at least 200 verified entity mentions. Add question
   fixtures for negation, changed decisions, numbers, owners and deadlines.
2. Replay the actual capture-to-Ask pipeline on at least 13 meetings. Include
   buffering, queue time, CPU fallback, concurrent ASR/diarization and time to
   refined evidence. A faster preview estimate excludes lookahead and is not
   this measurement. The current sealed-HQ mechanism fails this requirement.
3. Preserve quality gains in the same production path, with paired meeting
   confidence intervals and non-speech positive controls. Prompt removal was
   rejected: WER rose from 15.47% to 16.87% on 13 paired silver windows. Its
   confidence interval includes zero, so this is a rejection of qualification,
   not proof that every use of a shorter prompt is worse.
4. Repeat native failure/cancellation checks and confirm saved raw audio and
   canonical transcript survive. Include cold start and longer thermal runs.

No flag, silver score, unit test or native probe grants deployment approval.
