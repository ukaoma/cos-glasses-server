# STT switcher evaluation (server 6.72.0, 2026-10-13)

Everything here is SILVER: the references are Fireflies transcripts of laptop-speaker calls (stratum B) from the 2026-10-10 bake-off corpus. No gold set exists. Numbers only; transcripts and audio stay in the private bake-off corpus outside this repository. Statistics are the bake-off's: paired blockwise bootstrap by meeting, 4,000 resamples, 95% percentile intervals. Gates are the bake-off's `canaries/gates.py` (adoption rule: relative WER gain at least 10% with the CI excluding zero; entity recall point at least -1 pt and CI lower bound above -5 pts; entity precision at least 85%; CLEAN stratum E not higher than the baseline; compute in budget). Scripts: `canaries/stt-672/` (not in the npm package).

**Which numbers are shipped-path.** Every HQ arm in section 1 and the Parakeet preview arm in section 4 ran through the shipped code: `transcribeSegments` at production 30 s windows (`segmentTranscriptChunks` over the stored chunks), the job plan, `asrFrontEnd` (highpass), the real Large-v3 and Parakeet decoders, the resolver, corrections, `stripOverlap` and speaker mapping; the preview through `transcribeMeetingPreview` and the preview route's own hallucination cleaning. One approximation: decodes were cached by input audio, so in a resolver arm Large-v3's 250-character prompt context came from the Large-v3-alone run. The Whisper Turbo preview baseline is the saved bake-off L4 arm (SILVER) and a private Turbo server run (SILVER-E, stratum E), both with the route's cleaning applied afterwards. Section 6 lists the earlier comparisons that used saved bake-off text; they are superseded.

## Defaults chosen, and the rule applied

| Setting | Default | Evidence |
| --- | --- | --- |
| HQ | `large-v3` (timestamps on, VAD remap) | Item 1; the primary every arm is compared with. |
| Front end | `highpass` | Item 2. |
| Quiet gate | `silero` | Item 3, canary 5 (section 3). |
| Second opinion | `off` | Neither resolver configuration passed the rule (section 1). |
| Resolver | `false` | Same. It is available and records disagreements whenever a second opinion is chosen. |
| Preview | `turbo` | Parakeet Ultra passes the live-lane rule on the shipped path (-10.7% WER, CI -18.4 to -1.4) and is selectable; Turbo stays the default (section 4). |

Miles's rule (14:14): Ultra everywhere if it passes; v2 only with a proven benefit Ultra cannot give. **Branch 3 applied**: Resolver(Large-v3 + Ultra) fails, Resolver(Large-v3 + v2) fails, so the second opinion defaults off, Parakeet v2 is removed from the product and the install (464 MB never downloaded), and Ultra stays installable for the preview and the HQ primary.

## 1. HQ on the shipped path (SILVER 39 windows / 13 meetings; SILVER-E 110 windows; 271 pooled entity mentions)

Baseline: Large-v3 alone through the same code, SILVER WER 13.24% [11.0, 15.7] (S/D/I 4.2 / 6.6 / 2.5), SILVER-E 19.21% [14.3, 26.6], pooled entity recall 81.9%, precision 89.5%.

| Arm | SILVER WER % [CI] | S / D / I | rel. vs Large-v3 [CI] | SILVER-E WER % | SILVER-E rel. [CI] | Entity recall diff [CI] | Precision | CLEAN E | Collapsed (SILVER-E) | Gates |
|---|---|---|---|---|---|---|---|---|---|---|
| Large-v3 alone | 13.24 | 4.2 / 6.6 / 2.5 | | 19.21 | | | 89.5 | 0/40 | 6 | |
| Resolver: Large-v3 + Ultra | 13.03 [10.7, 15.6] | 4.4 / 4.8 / 3.8 | -1.6% [-4.7, +1.1] | 17.86 | -7.0% [-8.5, -4.2] | +0.7 [0.0, +1.5] | 89.6 | 0/40 | 4 | fail: gain, CI |
| Resolver: Large-v3 + v2 | 12.69 [10.5, 15.0] | 4.3 / 5.3 / 3.0 | -4.2% [-6.5, -1.9] | 17.95 | -6.6% [-8.6, -5.0] | +0.7 [0.0, +1.7] | 88.9 | 0/40 | 4 | fail: gain |
| Parakeet Ultra alone (HQ) | 11.76 [9.6, 14.1] | 4.5 / 2.4 / 4.9 | -11.2% [-23.7, +2.6] | 12.69 | -33.9% [-46.7, -24.5] | +2.6 [-6.5, +8.6] | 94.2 | 0/40 | 0 | fail: CI, entity CI |
| Ultra primary + Large-v3 second opinion, resolver on | 11.75 [9.5, 14.1] | 4.5 / 2.4 / 4.9 | -11.3% [-23.7, +2.4] | 12.64 | -34.2% [-46.7, -24.7] | +4.4 [-4.7, +9.5] | 93.6 | 0/40 | 0 | fail: CI only |

- Paired, v2 minus Ultra as the resolver's second opinion: SILVER -0.34 pts [-0.68, -0.02], SILVER-E +0.09 pts [-0.53, +0.50]. v2 is a little better on SILVER but itself fails the 10% bar, so under the rule it does not stay.
- What the resolver did on SILVER with Ultra: 467 gap fills taken; refused 112 runs outside the primary VAD's speech, 16 under the 0.5 confidence floor, 20 that would add or change a negation, number or unit. These QA-round restrictions (no gap fill outside speech, a confidence floor, protection for every region) are why the gain fell from the earlier saved-text estimate (section 6).
- REAL stratum E (faint far-field speech the VAD misses, 30 units): any output 37% for Large-v3 and both resolver arms (no change), 43% for Parakeet Ultra as primary. CLEAN (tone, music, 40 units) is 0 for every arm; the VAD-off positive control still outputs on 97.5%, so the fixture can fail.
- Compute (decode wall clock over audio, this run): Large-v3 on Metal 0.170, Parakeet Ultra 0.018 (Neural Engine), the pair 0.188, inside 0.25. **On CPU, the production default device, the 0.25 budget is not met by Large-v3 alone**: 8 windows measured 1.19x real time on a machine at load 28 to 32 (pre-existing for Large-v3 HQ; Parakeet adds 0.018). Miles's Mac runs `COS_BATCH_HQ_METAL=1`.

### Parakeet as the primary HQ (Miles: "It sounds like Parakeet should be the approach we use")

Evidence only; the default primary stays Large-v3. On the shipped path Ultra as the primary cut SILVER WER from 13.24% to 11.76% and SILVER-E from 19.21% to 12.69% (no collapsed windows against 6), with entity recall up 2.6 to 4.4 pts and precision 93.6 to 94.2%. It fails the rule only because the SILVER interval reaches +2.4 to +2.6% (13 meetings). With Large-v3 as its second opinion and the resolver on, only the WER interval fails. That configuration costs a full Large-v3 pass and is selectable: `PUT /api/stt-settings {"hq":"parakeet-ultra","secondOpinion":"large-v3","resolver":true}`. In the fixtures (section 2) Ultra also kept the negation and the unit far more often. Still needed before a default switch: human gold across strata A to D, more than 271 silver entity mentions, and Miles's explicit decision (it reverses the 2026-08-11 invariant).

## 2. Negation and units fixtures (10/13 diagnostic, 24 overlapping windows, shipped path)

Each window (12 to 24 s, two to four chunks) ran through `transcribeSegments` exactly like a saved meeting. The provisional reference (BBC captions) says "born lacking" (4 windows) and "around 18 months" (4 windows).

| Arm | "lacking" / "having" | "months" / "minutes" | Negation or unit changed vs its own primary |
|---|---|---|---|
| Large-v3 alone | 1 / 0 | 0 / 4 | |
| Resolver Large-v3 + Ultra | 1 / 0 | 0 / 4 | 0 of 24 |
| Resolver Large-v3 + v2 | 1 / 0 | 0 / 4 | 0 of 24 |
| Parakeet Ultra alone | 4 / 0 | 3 / 1 | |
| Ultra + Large-v3 second opinion | 4 / 0 | 3 / 1 | 0 of 24 |

The resolver never changed a negation or a unit. It also cannot repair the primary's own errors, by design.

## 3. Quiet gate (bake-off canary 5)

Labels: the bake-off's Silero v5.1.2 over each concatenated session; under 0.5 s of speech in a chunk is "Silero-negative". 10,091 of the 14,622 chunk WAVs are still on disk (32 of 44 sessions); 931 negative, 9,160 speech. The shipped gate is a dedicated in-process sherpa Silero (probability 0.8, minimum speech 0.25 s) fed in 512-sample windows, 17 ms p50 per 6 s chunk.

| Gate | Fires on Silero-negative [CI] | Fires on speech [CI] | Canary 5 |
|---|---|---|---|
| RMS below 150 (before 6.72) | 9.7% [7.9, 11.7] | 0.00% | fail (must catch) |
| sherpa Silero, p 0.5, quiet under 0.5 s | 75.5% | 0.47% | fail |
| **sherpa Silero, p 0.8, min speech 0.25 s (shipped)** | **80.8% [78.1, 83.2]** | **0.91% [0.73, 1.12]** | **pass (pooled)** |
| ggml Silero v5.1.2 per chunk (whisper-server's own model) | 72.9% | 0.40% | fail |

- The shipped settings were chosen on this table (8 detector settings by 3 thresholds), so the pass is not out of sample. By alternate session halves: 67.8% / 0.87% and 91.8% / 0.94%; no per-chunk setting passed both. Even whisper-server's own model fails per chunk.
- The gate decides only the prompt and the front end. The silence-hallucination text drops stay on RMS below 150, because a chunk with one short real name can be Silero-quiet.
- Found here, not fixed in this release: `trimSilence` (the prompt tail guard) hands sherpa the whole chunk in one call, which keeps only the last speech segment (a 6 s speech chunk read 0.32 s, windowed 5.03 s).

## 4. Live preview: Parakeet Ultra vs Whisper Turbo

Live lane: every stored 6 s chunk of SILVER (39 windows, 1,170 chunks), SILVER-E (110 windows) and stratum E. Parakeet Ultra ran through `transcribeMeetingPreview` (the client listing `parakeet-ultra` in `previewModels`, the highpass front end, the 0.9 s Parakeet deadline, corrections) and then the preview route's cleaning (`stripInlineHallucinationsOneShot`, `isFullHallucination`); in this process the Turbo fallback had no sidecar, so 7 of 2,243 requests that missed the budget count as empty previews. Baseline: Whisper Turbo on raw audio (today's preview) with the same route cleaning and corrections applied to its saved text: the bake-off L4 arm on SILVER, a private Turbo server (the preview sidecar's exact arguments, never the user's 8177) on SILVER-E and stratum E. Pooled entity recall: 271 mentions.

| Preview arm | SILVER WER % [CI] | S / D / I | rel. vs Turbo [CI] | SILVER-E WER | Entity recall (271) diff [CI] | Precision | CLEAN E | REAL E | Request p50 / p95 / max s | Emission delay p50 / p95 s (est.) | Gates |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Whisper Turbo (default) | 15.71 [13.3, 18.3] | 5.3 / 7.6 / 2.8 | | 17.31 | 81.9 | 94.5 | 1/40 | 10/30 | 0.33 / 0.47 / 0.77 | 3.49 / 6.16 | |
| **Parakeet Ultra (the `parakeet` option)** | **14.04 [11.5, 16.8]** | 5.5 / 3.6 / 5.0 | **-10.7% [-18.4, -1.4]** | 14.74 | 0.0 [-4.7, +6.9] | 94.9 | 1/40 | 17/30 | 0.42 / 0.68 / 1.25 | 3.61 / 6.30 | **PASS** |

- On the shipped path Parakeet Ultra passes every live-lane gate against Turbo. Turbo stays the default as decided (14:14 rule, point 4): the gain's interval only just excludes zero, a Parakeet preview needs the install, a warm model and COS Glasses 6.10.639, and Parakeet writes more text on REAL non-speech units (17 of 30 against 10), which holds faint far-field speech, so that is not proof of hallucination. Miles can select it and compare live.
- Request time is wall clock through the shipped path (spawn, highpass ffmpeg, decode, cleaning) on a Mac at load 25 to 36 with other work running; every arm stays inside the 1.0 s p95 live budget. fluidaudiocli has no server mode, so each preview is one short process; the compiled CoreML bundle is what stays warm.
- Emission delay is an estimate, the same method for both arms: for each word, the chunk's end minus the word's start (Parakeet v2 word starts from the first pass as the timing reference) plus the arm's request time. The 6 s chunk dominates it; real preview latency depends on how often the phone sends partial phrases.
- Earlier first-pass numbers (Parakeet decoded outside `transcribeMeetingPreview`, no corrections or route cleaning, 1.5 s deadline): Ultra -12.7% [-19.1, -4.5], 0/40 CLEAN; v2 -4.2% [-10.3, +5.1] with 3/40 CLEAN outputs, which is why the preview uses Ultra and v2 is gone. Highpass made Turbo slightly worse (+1.7% [-0.8, +3.7], 2/40 CLEAN), so the Whisper previews keep raw audio.

Negation and units, per 6 s chunk (the 20 chunks behind the 10/13 windows, each decoded alone): Turbo wrote "lacking" once and "minutes" once; Parakeet Ultra wrote "having" once and "months" once. Cut at 6 s Parakeet flips the negation it keeps on the 12 to 24 s windows. The preview is cosmetic (saved text never comes from it).

Contention (bounded, 30 chunks, while a real recording was live, all private instances): a private Large-v3 whisper-server with the live commit arguments, the shipped Nemotron diarizer run (`runNemotronCli`, Neural Engine, nice 10) and the Parakeet Ultra preview, each alone and then all three per chunk at once.

| Component | Alone p50 / p95 ms | All three at once p50 / p95 ms | Live plus diarizer only p95 ms |
|---|---|---|---|
| Live Large-v3 chunk | 567 / 711 | 603 / 732 | 743 |
| Diarizer (1.5 s budget) | 149 / 162 | 150 / 158 | 159 |
| Parakeet Ultra preview | 323 / 340 | 329 / 341 | |

No failures in any arm, and the user's server showed no new diarizer timeouts or Whisper failures across that run. A 30-chunk sample is not a thermal or multi-hour test, and it did not include a first CoreML compile next to the diarizer (the warm-up is now deferred while a recording is live instead).

## 5. Install and offline proof

- Pinned manifest `server/lib/parakeet-manifest.ts`: fluidaudiocli 0.17.4 SHA-256 `4714154623b59c40404563828cb0fbeb4da6878e90f582ad776c1c2cd061d35a` (22,039,856 bytes) and Parakeet Ultra `FluidInference/parakeet-ultra-coreml@95eaa59a39d4394f047a4dc5cce480388a60d1b6` (21 files, 632,316,735 bytes); install total 654,356,591 bytes. Per-file hashes come from the bake-off download manifest; the bake-off copy matches all 21 files.
- The shipped installer installed from local copies into an isolated data dir with its network fetch replaced by a throwing function: verified and installed with no fetch.
- The sandbox profile is enforced by the OS, tested in `parakeet.test.ts`: under the profile, `curl` to a local HTTP server fails while the same request works unsandboxed, and a write outside the run directory, the CoreML cache and the per-user temp directory fails. FluidAudio buffers audio over about 15 s in the per-user temp directory; without that allowance every 30 s HQ window failed (found by this evaluation).
- Clips under about 0.3 s make FluidAudio exit 0 with no output (a meeting's last chunk); they are padded to 1 s.

## 6. Superseded comparisons (saved bake-off text, not the shipped path)

The first pass compared saved bake-off outputs: Parakeet run over whole 3-minute windows in the bake-off's own sandbox without highpass, and Large-v3 from the bake-off H0ts arm or a timed re-decode composed outside `transcribeSegments`. On that basis Resolver(Large-v3 + Ultra) looked like -11.7% [-20.1, -6.1] against H0ts and v2 like -11.1% [-19.7, -2.8] against the re-decode. Those numbers depended on how the windows were composed and on a resolver without the speech-span, confidence and protection rules; the shipped path does not reproduce them, and the defaults follow section 1.

## 7. Live impact of this evaluation

Most of it ran while Miles was recording. All decodes used private processes; the user's 8177/8178 servers were never called. The live-impact guard (the user's public `/api/health`) saw the diarizer fall back to the voiceprint on 3 chunks during the heaviest stretch (Metal HQ decode plus a Parakeet preview run on a machine at load 30 to 36); the runs then paused and paced themselves, and no Whisper failure was seen.

## 8. Not established

Gold references (all of this is silver, stratum B only); entity coverage beyond 271 mentions; HQ compute on an idle CPU; Parakeet on Intel Macs (unsupported); cold-start preview behaviour after a reboot beyond the warm-up rule; a route-level test of orphan recovery's plan (pinned by a shared helper and its tests).
