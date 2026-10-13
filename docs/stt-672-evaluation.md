# STT switcher evaluation (server 6.72.0, 2026-10-13)

Everything here is SILVER: references are Fireflies transcripts of laptop-speaker calls (stratum B), from the 2026-10-10 bake-off corpus. No gold set exists. Numbers only; transcripts and audio stay in the private corpus (`/Users/ukaoma/cos-data/asr-bakeoff/`, eval outputs in `/Users/ukaoma/cos-data/stt-672-eval/`). Statistics are the bake-off's: paired blockwise bootstrap by meeting, 4,000 resamples, 95% percentile intervals; gates are `canaries/gates.py` from the bake-off (adoption rule: relative WER gain at least 10% with the CI excluding zero, entity recall not worse by more than 1 pt with the CI lower bound above -5 pts, entity precision at least 85%, CLEAN stratum E not worse, compute in budget). Scripts: `canaries/stt-672/` (excluded from the npm package). Every decode below ran through the shipped code (`server/lib/...`), and every resolver output came from the shipped resolver.

## Defaults chosen

| Setting | Default | Why |
| --- | --- | --- |
| HQ | `large-v3` (timestamps on, VAD remap) | Item 1. Bake-off: -17.4% WER vs the old decoder. The shipped path re-measured below (13.27% silver). |
| Front end | `highpass` | Item 2. WER-neutral in the bake-off, halves background pickup. |
| Quiet gate | `silero` | Item 3. Canary 5 passes pooled (80.8% / 0.91%); RMS 150 fires on 9.7%. Not robust per session half (below). |
| Second opinion | `parakeet-v2` | The only second opinion with which the resolver passed the adoption rule on the shipped Large-v3 path. |
| Resolver | on | Passes the rule against the shipped primary alone (below), no negation or unit change in the fixtures. |
| Preview | `turbo` | `parakeet` (Ultra) is wired and selectable: -12.7% WER, 0.34 s p95, 0/40 clean outputs, but it misses the entity-recall lower bound. |

## 1. Resolver

Design, from the measured error profile (bake-off: Large-v3 deletes, Parakeet inserts): align the two hypotheses word by word; take the second opinion only (a) for words a Whisper primary has nothing for (gap fill) and (b) where its side holds a profile vocabulary term the primary missed; never change a region that differs in a negation, a number or a unit, or a short insertion (3 words or fewer) carrying one. No LLM.

Timestamps: an optional skew limit (two words more than N s apart never pair) was measured on the shipped Large-v3 clocks and made the resolver worse at every limit (silver WER: no limit 12.30%, 10 s 12.73%, 5 s 12.83%, 3 s 12.95%, 2 s 13.13%; primary alone 13.27%). The clocks agree well on matched words (median 0.23 s, p90 1.02 s, 4.1% over 2 s), but the tail splits real matches. So alignment is textual; timestamps place the words taken and date every disagreement. Two rule adjustments were made after the first silver run (protected tokens narrowed to unambiguous numbers and units; vocabulary matching sees 3 agreed words either side): disclose that silver informed the rule.

### Against the shipped Large-v3 path (re-decoded through `transcribeHighQuality`, timestamps, highpass)

SILVER (39 windows, 13 meetings) has real primary clocks. SILVER-E (110 windows) uses the saved bake-off H0ts text as the Large-v3 side (the production re-decode reached 23 of 110 windows before a new recording started and was stopped), so its rows compare text only.

| Arm | Silver WER % [CI] | S / D / I | rel. vs shipped Large-v3 [CI] | SILVER-E rel. [CI] | Pooled entity recall (271) diff [CI] | Entity precision | CLEAN E | Gates |
|---|---|---|---|---|---|---|---|---|
| Large-v3 shipped (LV3_PROD) | 13.27 [11.0, 15.8] | 4.2 / 6.6 / 2.5 | | | 85.2 | 89.9 | 0/40 | |
| **Resolver: Large-v3 + Parakeet v2** | **11.80 [10.0, 13.7]** | 4.5 / 3.7 / 3.7 | **-11.1% [-19.7, -2.8]** | -13.8% [-26.6, -6.8] | +3.0 [+0.9, +6.5] | 89.8 | 0/40 | **PASS** |
| Resolver: Large-v3 + Parakeet Ultra | 12.30 [10.5, 14.3] | 4.6 / 2.9 / 4.8 | -7.3% [-16.1, +2.9] | -13.8% [-25.7, -6.0] | +3.0 [+0.9, +6.5] | 89.5 | 0/40 | fail: gain, CI |
| Parakeet Ultra alone | 11.22 [9.1, 13.6] | 4.5 / 2.1 / 4.7 | -15.5% [-27.2, -1.0] | -21.5% [-34.2, -13.3] | 0.0 [-7.3, +4.3] | 93.5 | 0/40 | fail: entity CI |
| Parakeet v2 alone | 11.71 [9.6, 13.9] | 4.3 / 4.0 / 3.4 | -11.8% [-24.9, +3.5] | -15.0% [-28.5, -6.3] | +0.7 [-5.7, +4.2] | 94.3 | 0/40 | fail: CI, entity CI |
| **Parakeet Ultra primary + Large-v3 vocabulary rescue** | **11.21 [9.1, 13.6]** | 4.5 / 2.1 / 4.7 | **-15.5% [-27.3, -1.0]** | -22.1% [-34.7, -13.8] | +2.2 [-4.9, +6.2] | 92.9 | 0/40 | **PASS** |

HQ compute: Large-v3 shipped RTF 0.145 (re-decoded with `COS_BATCH_HQ_METAL=1`; the production default device is CPU), Parakeet RTF 0.005 (Neural Engine), the pair 0.150, inside the 0.25 budget. Positive control (VAD off) still outputs on 97.5% of CLEAN units, so the fixture can fail.

### Against the saved bake-off Large-v3 fixed arm (H0ts, text only)

| Arm | rel. vs H0ts [CI] | entity diff [CI] | precision | Gates |
|---|---|---|---|---|
| Resolver + Ultra | -11.7% [-20.1, -6.1] | +2.6 [+0.7, +6.2] | 89.6 | PASS |
| Resolver + v2 | -5.7% [-12.6, +4.0] | +2.2 [+0.4, +6.1] | 90.3 | fail: gain, CI |
| Parakeet Ultra alone | -13.6% [-25.1, -1.3] | -1.5 [-9.7, +3.2] | 93.5 | fail: entity point, CI |

**Read this before trusting the v2-over-Ultra choice.** Which second opinion clears the 10% bar flips with the primary: v2 on the shipped re-decode, Ultra on the saved bake-off text. Both resolver variants improve WER and entity recall in every comparison (-5% to -12% on SILVER, -13.8% on SILVER-E), so "the resolver helps" is stable; "v2 beats Ultra as the second opinion" is not established. The default follows the rule on the configuration that ships. Collapsed windows on SILVER-E (under 50% of reference words): Large-v3 3, resolver 1, Parakeet 0.

### Parakeet as the primary HQ (Miles: "It sounds like Parakeet should be the approach we use")

Evidence only; the default primary stays Large-v3. Parakeet Ultra alone has the lowest WER (silver 11.22%, SILVER-E 12.63%) and fails the rule only on entity recall's lower bound (-7.3 pts). With the Large-v3 hypothesis as its second opinion and vocabulary rescue (the shipped resolver with `hq: parakeet-ultra`, `secondOpinion: large-v3`), it passes every gate against the shipped Large-v3: -15.5% [-27.3, -1.0], entity +2.2 [-4.9, +6.2], precision 92.9%. That configuration costs a full Large-v3 pass and is selectable today: `PUT /api/stt-settings {"hq":"parakeet-ultra","secondOpinion":"large-v3","resolver":true}` (or just `{"hq":"parakeet-ultra"}`, which moves the second opinion to Large-v3). The 10/13 fixtures (section 2) also favor Ultra on negation and units. Still pending for a primary switch: human gold across strata A to D, entity coverage beyond 271 silver mentions, and Miles's explicit decision (it reverses the 2026-08-11 invariant).

## 2. Negation and units fixtures (10/13 diagnostic windows, 24 overlapping windows)

Decoded through the shipped paths (highpass): Large-v3 HQ with timestamps, Parakeet Ultra and v2 via FluidAudio. The provisional reference (BBC captions) says "born lacking" (4 windows) and "around 18 months" (4 windows).

| Arm | "lacking" / "having" (4 windows) | "months" / "minutes" (4 windows) |
|---|---|---|
| Large-v3 shipped | 1 lacking, 0 having ("born out of" in 3) | 0 months, 4 minutes |
| Parakeet Ultra | 4 lacking, 0 having | 3 months, 1 minute |
| Parakeet v2 | 1 lacking, **3 having** (the flip) | 3 months, 1 minute |
| Resolver Large-v3 + v2 (default) | 1 lacking, 0 having | 0 months, 4 minutes |
| Resolver Large-v3 + Ultra | 1 lacking, 0 having | 0 months, 4 minutes |
| Resolver Ultra + Large-v3 | 4 lacking, 0 having | 3 months, 1 minute |

The resolver changed a negation or unit token relative to its own primary in 0 of 24 windows for every configuration: v2's "having" never reached the output. It also cannot fix the primary's own errors ("minutes"), by design.

## 3. Quiet gate (bake-off canary 5)

Labels: the bake-off's Silero v5.1.2 over each concatenated session, under 0.5 s of speech in a chunk means "Silero-negative". 10,091 of the 14,622 chunk WAVs are still on disk (32 of 44 sessions); 931 negative, 9,160 speech. The shipped gate is the in-process sherpa Silero fed in 512-sample windows (17 ms p50, 18 ms p95 per 6 s chunk).

| Gate | Fires on Silero-negative [CI] | Fires on speech [CI] | Canary 5 |
|---|---|---|---|
| RMS below 150 (before 6.72) | 9.7% [7.9, 11.7] | 0.00% | fail (must catch) |
| sherpa Silero, p 0.5, quiet under 0.5 s | 75.5% | 0.47% | fail |
| **sherpa Silero, p 0.8, min speech 0.25 s, quiet under 0.5 s (shipped)** | **80.8% [78.1, 83.2]** | **0.91% [0.73, 1.12]** | **pass (pooled)** |
| ggml Silero v5.1.2 per chunk (whisper-server's own model), quiet under 0.5 s | 72.9% | 0.40% | fail |

- The shipped detector settings were chosen on this table (a grid of 8 settings and 3 thresholds), so the pass is not out of sample. Split by alternate session, half A reaches only 67.8% (0.87% on speech) and half B 91.8% (0.94%): no per-chunk setting passed both halves. Even the exact model whisper-server uses fails per chunk, so the canary's session-context labels are partly unreachable chunk by chunk.
- A pre-existing defect found here: `trimSilence` (prompt tail guard) hands sherpa the whole chunk in one call and keeps only the last segment (a 6 s chunk of continuous speech read 0.32 s; windowed, 5.03 s). The quiet gate uses the new windowed `measureSpeechSeconds`; `trimSilence` is unchanged in this release.

## 4. Live preview: Parakeet vs Whisper Turbo

Live lane: every stored 6 s chunk of SILVER (39 windows, 1,170 chunks), SILVER-E (110 windows) and stratum E, through the shipped preview code: Parakeet via `transcribeParakeet` (preview lane, 1.5 s deadline, highpass via `asrFrontEnd`), Whisper Turbo against a private whisper-server on port 18377 with the preview sidecar's exact arguments (never the user's 8177/8178). Turbo raw on SILVER is the saved bake-off L4 arm (same arguments); reproduced at 15.59%. Baseline: Turbo on raw audio (today's preview). Pooled entity recall: 271 mentions (SILVER plus SILVER-E).

| Preview arm | SILVER WER % [CI] | S / D / I | rel. vs Turbo raw [CI] | SILVER-E WER | Entity recall (271) diff [CI] | Precision | CLEAN E output | REAL E output | Chunk compute p50 / p95 / max s | Emission delay p50 / p95 s (est.) | Gates |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Turbo raw (default) | 15.59 [13.2, 18.2] | 5.3 / 7.5 / 2.8 | | 17.21 | 82.3 | 94.5 | 1/40 | 10/30 | 0.33 / 0.47 / 0.77 | 3.48 / 6.15 | |
| Turbo highpass | 15.85 [13.3, 18.7] | 5.4 / 7.7 / 2.8 | +1.7% [-0.8, +3.7] | 17.31 | -0.7 [-3.1, +2.9] | 96.1 | 2/40 | 12/30 | 0.42 / 0.57 / 2.38 | 3.60 / 6.28 | fail |
| Parakeet v2 | 14.94 [12.7, 17.3] | 5.1 / 6.0 / 3.8 | -4.2% [-10.3, +5.1] | 16.72 | -1.8 [-5.7, +1.3] | 95.6 | **3/40** | 18/30 | 0.33 / 0.37 / 0.83 | 3.51 / 6.19 | fail |
| **Parakeet Ultra (the `parakeet` option)** | **13.61 [11.2, 16.2]** | 5.4 / 3.1 / 5.1 | **-12.7% [-19.1, -4.5]** | 14.69 | -0.4 [-5.1, +6.2] | 95.3 | **0/40** | 16/30 | 0.32 / 0.34 / 0.58 | 3.49 / 6.18 | fail: entity CI only |

- Compute is wall clock per request through the shipped path: process spawn, highpass ffmpeg (Parakeet arms) and decode. Every arm is inside the 1.0 s p95 live budget. fluidaudiocli has no server mode, so each preview is one short process; what stays warm is the compiled CoreML bundle (first compile 12 to 17 s, then about 0.3 s). The `parakeet` option is marked available once installed, and Turbo previews until the warm-up decode fits 1 s.
- Emission delay is an estimate, the same for every arm: for each word, the chunk's end minus the word's start (Parakeet v2 word starts as the timing reference) plus that arm's compute for the chunk. It is dominated by the 6 s chunk, so the engines are within 0.1 s of each other; real preview latency depends on how often the client sends partial phrases.
- REAL stratum E holds faint far-field speech the VAD misses (bake-off finding), so more output there is not proof of hallucination. CLEAN (tone and music) is: Parakeet v2 wrote text on 3 of 40, which is why the preview uses Ultra.
- Highpass made Turbo slightly worse, so the Whisper previews keep raw audio; only the Parakeet preview hears highpass (how it was measured).
- Decision: Parakeet Ultra wins WER clearly and fits the latency budget, but its entity-recall lower bound (-5.1 pts) misses the rule, so Turbo stays the default and `parakeet` is selectable for Miles to compare live.

Negation and units, per 6 s chunk (the 20 chunks behind the 10/13 windows, each decoded alone): Turbo raw wrote "lacking" once and "minutes" once; Parakeet Ultra and v2 each wrote "having" once and "months" once. Cut at 6 s, Parakeet flips the negation that it kept on the 12 to 24 s windows. The preview is cosmetic (saved text never comes from it), but read Parakeet preview text with that in mind.

Contention (bounded, 30 chunks, run while a real recording was live, all private instances): a private Large-v3 whisper-server on 18278 with the live commit arguments, the shipped Nemotron diarizer run (`runNemotronCli`, Neural Engine, nice 10) on a private model copy and HOME, and the Parakeet Ultra preview, first each alone, then all three per chunk at once.

| Component | Alone p50 / p95 ms | All three at once p50 / p95 ms | Live plus diarizer only p95 ms |
|---|---|---|---|
| Live Large-v3 chunk | 567 / 711 | 603 / 732 | 743 |
| Diarizer (1.5 s budget) | 149 / 162 | 150 / 158 | 159 |
| Parakeet Ultra preview | 323 / 340 | 329 / 341 | |

No failures in any arm. The user's live server showed no diarizer timeouts and no Whisper failures added across the run (6 timeouts before and after, 0 failures). A 30-chunk sample on an otherwise loaded Mac is not a thermal or multi-hour test.


## 5. Install and offline proof

- Pinned manifest `server/lib/parakeet-manifest.ts`: fluidaudiocli 0.17.4 SHA-256 `4714154623b59c40404563828cb0fbeb4da6878e90f582ad776c1c2cd061d35a` (22,039,856 bytes); Parakeet Ultra `FluidInference/parakeet-ultra-coreml@95eaa59a39d4394f047a4dc5cce480388a60d1b6` (21 files, 632,316,735 bytes); Parakeet TDT v2 `FluidInference/parakeet-tdt-0.6b-v2-coreml@ee09c569f73759e6d44c9bd16766f477b2b36d39` (23 files, 464,414,915 bytes). Per-file hashes come from the bake-off download manifest; the bake-off copies match all 44 files.
- The shipped installer installed from those local copies into an isolated data dir with its network fetch replaced by a function that throws: 1,118,771,506 bytes verified and installed in 2.5 s, no fetch. FluidAudio publishes no CLI binary, so the CLI is only ever copied from a hash-matching local file.
- Inference runs under `sandbox-exec` with `(deny network*)` and the install read-only, `--local-model-dir`, a key-free environment. Warm decode of a 6 s chunk: about 0.28 s; first compile 12 to 17 s.
- FluidAudio 0.17.4 exits 0 with no JSON for clips under about 0.3 s (a meeting's last chunk); found on stratum E, fixed by padding to 1 s.

## 6. Not established

Gold references (all of this is silver, stratum B only); entity coverage beyond 271 mentions; Parakeet on CPU-only Macs (it is Apple silicon only); cold-start preview behavior after a reboot beyond the warm-up rule; the progressive-HQ path combined with a second opinion (checkpoints are skipped whenever a second opinion is planned).
