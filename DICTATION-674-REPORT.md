# Server 6.74.0: Mac dictation for every user (report)

Branch `feat/dictation-everyone` (from `feat/work-queue-parallel` 6.73.15). Not published, not pushed. The installed server (LaunchAgent, ports 3141 and 3143) was not touched.

## What changed

| Area | Change | Files |
|---|---|---|
| Setting | `dictation`: `auto` (default), `parakeet-ultra`, `whisper`. A file without the key reads as `auto`. Mac dictation no longer follows the Preview model. GET adds `dictation.desktop`; PUT accepts `dictation`. | `server/lib/stt-settings.ts` |
| Engine policy | `requiredEngine=local`: `auto` uses Parakeet when installed, warm and its breaker closed. Otherwise local Whisper decodes, with `fallbackReason`, and a warm-up starts. Busy and failed decodes also fall back. The path is local-only even when the caller passes no policy. A Whisper failure becomes 503 `no_local_engine` with `action`, `detail` and an honest `retryable`. The explicit `parakeet-ultra` setting is strict. `requiredEngine=parakeet-ultra` keeps the 6.73 bodies and messages, and now follows the dictation setting instead of Preview. Phone and glasses paths are unchanged. | `server/lib/transcribe-audio.ts`, `server/lib/dictation-stt.ts` |
| Capabilities | `desktopDictationVersion` stays 1 (deviation from the spec). Adds `desktopDictationVersions: [1,2]`, `requiredEngines: ['parakeet-ultra','local']` and `benchmark: 1`. | `server/routes/transcribe.ts` |
| Warm-up | Parakeet warms when it is installed and dictation is `auto` or `parakeet-ultra`. | `server/lib/stt-runtime.ts` |
| CLI trust | Checks, in order (final identity agreed with the Control builder):<br>1. `codesign --verify --strict` passes.<br>2. The TeamIdentifier is `NV3X46LLCR` (read from `/Applications/COS Control.app`).<br>3. A second strict verify passes against `anchor apple generic and certificate leaf[subject.OU] = "NV3X46LLCR"`.<br>4. The codesign Identifier is exactly `com.gotcos.control.fluidaudiocli`; otherwise `wrong_identifier`.<br>5. A signature-bound embedded Info.plist has CFBundleIdentifier `com.gotcos.control.fluidaudiocli` (otherwise `wrong_identifier`) and CFBundleShortVersionString `0.17.4` (otherwise `wrong_version`).<br>The binary is never run. Only a file named `fluidaudiocli` is ever checked, and it is opened non-blocking with no-follow. | `server/lib/parakeet-cli-trust.ts` (new) |
| Install | The SHA pin is tried first. Otherwise COS Control's signed CLI is used, and the copy in staging is proved again. The receipt records `trust`, `sha256`, `size` and `teamId`, and every run checks the installed bytes. The installer checks for 1.5 GB free before writing anything. `errorCode` reports what failed. `allowDownload:false` never downloads. | `server/lib/parakeet.ts` |
| Routes | `POST /api/stt-settings/parakeet/cli`. Install takes `cliPath` and returns 507 (disk) and 422 (untrusted). `POST /api/transcribe/benchmark` runs one engine at a time, refuses while recording, and times out after 60 s per engine and 150 s in all. | `server/routes/stt-settings.ts`, `server/routes/transcribe.ts`, `server/lib/dictation-benchmark.ts` (new) |
| Speaker separation (separable commit f865c3b) | After the existing lookup order (`COS_NEMOTRON_CLI`, `~/.cos-glasses/bin`, `PATH`, all unchanged), the diarizer also finds:<br>1. the GUI-installed Parakeet CLI, when its receipt is complete and its bytes match;<br>2. COS Control's bundled copy, when it passes the Developer ID check or the SHA pin.<br>Unchecked files are skipped, so lookups never block. | `server/lib/diarizer-backend.ts`, `server/lib/parakeet.ts` |
| Status copy | The note never points at `~/.cos-glasses/bin`. It names the action ("Install Parakeet (654 MB)...", "Update COS Control...", or why Control's copy was refused). | `server/lib/stt-runtime.ts` |
| Version | 6.74.0 in `package.json`, both `package-lock.json` fields, and `CHANGELOG.md`. The server reads its version from `package.json`; there is no separate COS_VERSION. | |
| Contract | New section, "Mac dictation for every user (6.74.0)". | `docs/dictation-stt-contract.md` |

## Two deviations from the brief, both forced by evidence

1. **Capability version stays 1.** COS Control 0.5.316 checks `desktopDictationVersion == 1` exactly (`HelperSources/main.swift:15397` in the `ctl-pet-v12-6` release candidate). Advertising 2 would break every old Control. New Control should look for 2 in `desktopDictationVersions` instead.
2. **fluidaudiocli 0.17.4 has no version command.** On the pinned binary, both `--version` and `version` print `Unknown command`. The final contract therefore requires an Info.plist that is embedded in the binary and bound by its signature (built with `-sectcreate __TEXT __info_plist`), and drops the `--version` fallback. A new test pins exactly what old Control checks: `desktopDictationVersion` exactly 1, `localOnly` true, `parakeet-ultra` in `requiredEngines`, and `engine: parakeet-ultra` in the answer to its request.

**Runtime trust (the parakeet.ts:541 point).** A Developer ID install no longer depends on the SHA pin at run time:
- The install proves the signed CLI with the full codesign, team, identifier and version check, then proves the copied file again.
- It records that copy's SHA-256, size and team in the receipt.
- Every Parakeet run (`installedCliIntact`) checks the installed bytes against that recorded hash. Bytes can only match if they are exactly what passed codesign.
- Codesign is not re-run on each decode. That would add a process spawn to every dictation.
- The diarizer lookup applies the same test (`installedCliTrustedNow`), and uses the full check for Control's bundled copy.

## Tests

- Final full server suite (once, after every commit including the identity and diarizer changes; isolated `COS_DATA_DIR` and profile): **Test Files 461 passed (461). Tests 7120 passed, 2 skipped (7122).** Duration 386.43 s. The earlier end-of-feature run, before the follow-ups, was 460 files and 7107 passed, 2 skipped.
- The first full run, before two fixes: 2 failed and 7103 passed. Both failures were mine:
  - `package-manifest.test.ts` rejected the changelog heading `6.74.0:`. Changed to `6.74.0 -`.
  - `hazard-invariants.test.ts` caught an unguarded `openSync` in the new plist reader. The path comes from a client, so a FIFO would have blocked the server. Fixed with `O_NONBLOCK | O_NOFOLLOW` plus an `fstat` check, and a FIFO test was added.
- New tests:
  - `desktop-dictation.test.ts` covers the policy, the compatibility matrix and the failure hints.
  - `parakeet-cli-trust.test.ts` covers good, wrong team, unanchored, unsigned and ad hoc, invalid, wrong version, never-run, missing, FIFO and the Mach-O parser.
  - `dictation-benchmark.test.ts` covers the benchmark.
  - Additions in `parakeet.test.ts` (install), `stt-settings.test.ts` and `transcribe.test.ts` (routes) and `stt-runtime.test.ts` (status and warm).

## Mutation run

- Serial, one mutant at a time, each target asserted to appear exactly once.
- Baseline before any mutant: the 8 target files, 151 tests, 0 failed.
- The tree was restored byte for byte after each mutant, and `git status` was clean afterwards.
- Result of the first run: **42 of 43 killed.** Two follow-up runs, each with its own green baseline, killed 5 of 5 identity mutants (T9 to T13) and 5 of 5 diarizer mutants (D1 to D5). D3 and D4 first survived; each exposed a missing test (a repeated lookup through the cached PATH search; an intact CLI inside an incomplete install), which was added before they were killed. **Overall: 52 of 53 killed, and the one survivor was an unreachable clause, now removed.** P5 survived because its clause was unreachable (a `whisper` plan never carries a reason, and `parakeet-ultra` throws first). The clause was removed rather than kept as a guard nothing can exercise.
- Not mutated: the `O_NONBLOCK` flag. Removing it makes the FIFO test block the worker thread forever rather than fail. The FIFO test proves the guarded path returns in under 1 s.

| Mutant | Result | First killing test |
|---|---|---|
| T9 codesign identifier is exact | killed | parakeet-cli-trust.test.ts: refuses another codesign identifier, including the earlier draft name |
| T10 plist CFBundleIdentifier is exact | killed | parakeet-cli-trust.test.ts: refuses an embedded plist whose CFBundleIdentifier differs |
| T11 only a signature-bound plist counts | killed | parakeet-cli-trust.test.ts: refuses another version, and a plist the signature does not bind |
| T12 version is exactly 0.17.4 | killed | parakeet-cli-trust.test.ts: refuses another version, and a plist the signature does not bind |
| T13 identifier constant | killed | parakeet-cli-trust.test.ts: the agreed identity string is exact |
| D1 GUI-installed CLI only when verified | killed | diarizer-parakeet-cli.test.ts: ignores the GUI-installed CLI while unverified or untrusted |
| D2 bundled CLI only when trusted | killed | diarizer-parakeet-cli.test.ts: an unchecked bundled CLI is skipped, never run |
| D3 cached PATH search falls through | killed (after a new test) | diarizer-parakeet-cli.test.ts: a later lookup still finds a CLI that became trusted |
| D4 installed CLI needs a complete install | killed (after a new test) | parakeet.test.ts: installedCliTrustedNow ... an intact CLI inside an incomplete install |
| D5 trusted only on a matching hash | killed | parakeet.test.ts: installedCliTrustedNow ... false once tampered |
| P1 explicit parakeet-ultra is strict | killed | desktop-dictation.test.ts: transcribeAudioBuffer: Mac dictation engine policy and compatibility parakeet-ultra setting with requiredEngine=local is strict: no Whisper, a  |
| P2 Mac dictation is local-only by itself | killed | desktop-dictation.test.ts: transcribeAudioBuffer: Mac dictation engine policy and compatibility requiredEngine=local is local only by itself, even when the caller passes  |
| P3 old request refuses a non-Parakeet plan | killed | desktop-dictation.test.ts: transcribeAudioBuffer: Mac dictation engine policy and compatibility old request, setting auto (parakeet_not_installed): the exact 6.73 refusal |
| P4 old request refuses a failed decode | killed | desktop-dictation.test.ts: transcribeAudioBuffer: Mac dictation engine policy and compatibility old request, decode failed under auto: the exact 6.73 decode refusal, neve |
| P5 fallbackReason only under auto | survived | none (equivalent: unreachable clause, removed) |
| P6 Whisper failure becomes no_local_engine | killed | desktop-dictation.test.ts: transcribeAudioBuffer: Mac dictation engine policy and compatibility requiredEngine=local is local only by itself, even when the caller passes  |
| P7 Mac plan ignores the Preview model | killed | desktop-dictation.test.ts: the dictation setting (pure) Mac dictation does not follow the Preview model |
| P8 auto needs Parakeet warm | killed | desktop-dictation.test.ts: the dictation setting (pure) auto uses Parakeet only installed, warm and breaker closed; otherwise Whisper with the reason |
| P9 phone path keeps the Preview plan | killed | desktop-dictation.test.ts: transcribeAudioBuffer: Mac dictation engine policy and compatibility a request with no requiredEngine (phone, glasses) still follows the Previe |
| P10 parakeet-ultra option needs Parakeet installed | killed | stt-settings.test.ts: 6.74.0: Mac dictation setting and the GUI Parakeet install GET has dictation.desktop on auto; PUT dictation persists it and refuses an unavailable c |
| P11 missing key reads as auto | killed | desktop-dictation.test.ts: the dictation setting (pure) defaults to auto, and every pre-6.74 file (no key) reads as auto, including Macs that chose Parakeet |
| H1 retry only when waiting helps (no_local_engine) | killed | desktop-dictation.test.ts: the one action a failure offers (pure) no_local_engine |
| H2 install_parakeet only when installable | killed | desktop-dictation.test.ts: the one action a failure offers (pure) no_local_engine |
| H3 whisper starting is retryable | killed | desktop-dictation.test.ts: the one action a failure offers (pure) no_local_engine |
| R1 route reports the hint retryable | killed | transcribe.test.ts: one-shot transcription availability contract a Mac dictation failure carries the action and an honest retryable |
| R2 capability version stays 1 | killed | transcribe.test.ts: one-shot transcription availability contract advertises desktop capability before microphone audio is transferred; version stays 1 for older Control |
| R3 local accepted as requiredEngine | killed | transcribe.test.ts: one-shot transcription availability contract requiredEngine=local is Mac dictation: local only, the setting echoed, the fallback named |
| T1 strict signature verify | killed | parakeet-cli-trust.test.ts: checkDeveloperIdCli refuses a signature that does not verify strictly |
| T2 TeamIdentifier is COS | killed | parakeet-cli-trust.test.ts: checkDeveloperIdCli refuses another team |
| T3 Apple-anchored requirement | killed | parakeet-cli-trust.test.ts: checkDeveloperIdCli refuses a certificate that claims the COS team but does not chain to Apple |
| T4 ad hoc is unsigned | killed | parakeet-cli-trust.test.ts: checkDeveloperIdCli refuses unsigned and ad hoc builds (the upstream build on this Mac is ad hoc) |
| T5 version must be 0.17.4 | killed | parakeet-cli-trust.test.ts: checkDeveloperIdCli refuses another version; a bound plist naming one means the binary is never run |
| T6 never run a binary whose plist names another version | killed | parakeet-cli-trust.test.ts: checkDeveloperIdCli refuses another version; a bound plist naming one means the binary is never run |
| T7 file name must be fluidaudiocli | killed | stt-settings.test.ts: 6.74.0: Mac dictation setting and the GUI Parakeet install install: 422 for an untrusted cliPath, 400 for a path that is not fluidaudiocli |
| T8 version token boundary | killed | parakeet-cli-trust.test.ts: helpers versionMatches takes 0.17.4 as a whole token only |
| I1 receipt team must be COS | killed | parakeet.test.ts: 6.74.0: install from COS Control signed CLI, disk precheck, error codes a developer-id receipt naming another team is not installed |
| I2 runtime checks the recorded hash | killed | parakeet.test.ts: 6.74.0: install from COS Control signed CLI, disk precheck, error codes installs the signed CLI (no SHA pin can match it), records its own hash, and run |
| I3 the copy is proved again | killed | parakeet.test.ts: 6.74.0: install from COS Control signed CLI, disk precheck, error codes proves the copy too: a copy that fails its own check is never installed |
| I4 disk precheck in the installer | killed | parakeet.test.ts: 6.74.0: install from COS Control signed CLI, disk precheck, error codes needs 1.5 GB free before anything is written; a full disk installs nothing |
| I5 1.5 GB boundary is inclusive | killed | parakeet.test.ts: 6.74.0: install from COS Control signed CLI, disk precheck, error codes needs 1.5 GB free before anything is written; a full disk installs nothing |
| I6 SHA pin wins over the Control build | killed | parakeet.test.ts: Parakeet install (pinned, hash-checked) installs from matching local copies without touching the network |
| I7 untrusted Control CLI is cli_untrusted | killed | parakeet.test.ts: 6.74.0: install from COS Control signed CLI, disk precheck, error codes refuses a CLI from another team, and says the tool did not pass its check |
| I8 cancel mid-download says cancelled | killed | parakeet.test.ts: 6.74.0: install from COS Control signed CLI, disk precheck, error codes cancel mid-download keeps the existing install and says cancelled |
| S1 route disk precheck 507 | killed | stt-settings.test.ts: 6.74.0: Mac dictation setting and the GUI Parakeet install install: 507 with the numbers when the disk is short, before any install starts |
| S2 route refuses an untrusted cliPath | killed | stt-settings.test.ts: 6.74.0: Mac dictation setting and the GUI Parakeet install install: 422 for an untrusted cliPath, 400 for a path that is not fluidaudiocli |
| S3 allowDownload false never downloads | killed | stt-settings.test.ts: 6.74.0: Mac dictation setting and the GUI Parakeet install install: allowDownload false without a localSource never downloads |
| S4 only a trusted CLI is registered | killed | stt-settings.test.ts: 6.74.0: Mac dictation setting and the GUI Parakeet install POST parakeet/cli registers Control CLI and returns the verdict |
| U1 installable via the signed CLI | killed | stt-runtime.test.ts: 6.74.0: Parakeet install offer with COS Control signed CLI is installable once the signed CLI is verified, and the note names the size and that Whisp |
| U2 auto warms Parakeet | killed | stt-runtime.test.ts: 6.73.0: a Parakeet HQ model warms Parakeet too (dictation final uses it only warm) starts a warm-up for hq parakeet-ultra with a Turbo preview, and s |
| B1 one run at a time | killed | dictation-benchmark.test.ts: runDictationBenchmark one run at a time, and never while a recording is live |
| B2 refuse while recording | killed | dictation-benchmark.test.ts: runDictationBenchmark one run at a time, and never while a recording is live |
| B3 per-engine timeout | killed | dictation-benchmark.test.ts: runDictationBenchmark a hung engine times out and the next one still runs |
| B4 stop when a recording starts mid-run | killed | dictation-benchmark.test.ts: runDictationBenchmark one run at a time, and never while a recording is live |

## Real-path smoke (isolated)

Setup:
- `COS_DATA_DIR`, `HOME` and `COS_PROFILE_PATH` were scratch, with no `stt-settings.json`.
- The real Whisper model directory was symlinked read-only into the scratch HOME.
- Whisper decodes went to the running live worker on 8178. These were read-only inference requests: nothing was started, stopped or restarted. The port is tied to the server's process-ownership and kill logic, so I did not add a port override to production code for this.
- The audio was a 5.0 s 16 kHz mono WAV from `say`.
- Miles's `~/.cos-glasses/data/stt-settings.json` was untouched (mtime still Oct 13 23:45).

| Check | Result |
|---|---|
| Capabilities | `{desktopDictationVersion:1, desktopDictationVersions:[1,2], requiredEngines:['parakeet-ultra','local'], localOnly:true, dictionary:'cos', benchmark:1}` |
| `dictation.desktop`, fresh Mac | selected `auto`, effective `whisper`, reasonCode `parakeet_not_installed` |
| `requiredEngine=local`, auto, Parakeet absent | 200, `engine: whisper`, `fallbackReason: parakeet_not_installed`, correct text, 444 ms (978 ms on the first, cold request) |
| `requiredEngine=local`, setting whisper | 200, `engine: whisper`, no `fallbackReason`, 409 ms |
| `requiredEngine=parakeet-ultra` (old Control) | 503, byte-exact 6.73 body `{"error":"Parakeet is not ready. Select Parakeet for dictation in Transcription settings and retry.","reason":"parakeet_unavailable","retryable":true}` |
| PUT `dictation: parakeet-ultra` without Parakeet | 400 "Parakeet Ultra is not available: Install Parakeet on this Mac first." |
| Benchmark | Whisper ran, rtf 0.08, correct text; Parakeet `skipped: not_installed` |
| Trust, real codesign (rerun under the final rule) | upstream ad hoc CLI: `unsigned`. COS Control main binary: `wrong_identifier` (signed as `com.gotcos.control`; never executed). Chrome helper (team EQHXZ8M8AV, strict-valid standalone): `wrong_team`. Slack main binary copied out of its bundle: `signature_invalid`. |
| Install with that other-team cliPath | 422 `cli_untrusted`, `cli.reason: wrong_team`; register route 422 |
| GUI install, real SHA-pinned CLI, real Hugging Face, cancel | 202, downloaded 27.7 MB of 654 MB from the pinned revision, DELETE 202, `errorCode: cancelled`, nothing left under the Parakeet root |

## Speaker separation (diarizer)

- **Before the change:** `nemotronCliPath` looked only at `COS_NEMOTRON_CLI`, `~/.cos-glasses/bin` and `PATH`, so a GUI install never enabled speaker separation.
- **Separable commit f865c3b:** adds the two trusted locations after that order, as the lead asked. Untrusted copies in those paths are ignored, and tests cover another team, another identifier, unverified, and unchecked.
- **Real run on an isolated data dir and HOME:**
  - The bundled CLI doesn't exist yet: `/Applications/COS Control.app/Contents/Helpers` is absent on this Mac. A SHA-pinned copy at a scratch `COS Control.app/Contents/Helpers` path stood in for it.
  - First lookup: `null`. The file is unchecked, so it is skipped and never run.
  - After the background pin check: the lookup returns that path.
  - `activeDiarizer` then reports `{requested: nemotron, active: embedding, fallback: models_missing}`.
- **So speaker separation does not run yet for a new user.** It also needs the Nemotron models (`nemotron-3-diarization`). On Miles's Mac those are present at `~/.cos-glasses/models`, but nothing installs them for a new user. I did not download them.
- **Not changed:** the diarizer's KNOWN_CLI_SHA256 log line would call a Developer ID build "an unverified build". That is a log line only, left as it was.

## Risks and open items

- **The trusted happy path for a real COS-signed 0.17.4 build is covered only by injected tests.** No such binary exists yet. The first real proof is Control 0.5.317's signed helper, run through `POST /api/stt-settings/parakeet/cli`. Control must sign the helper standalone (hardened runtime, identifier, embedded plist) so the copy verifies outside the bundle.
- **Rollback.** A server older than 6.74.0 reads a Developer ID receipt as not installed. That fails safe: dictation goes back to the 6.73 behaviour, and Parakeet is offered for reinstall only where a SHA-pinned CLI exists.
- **No 503 `no_local_engine` against a really dead Whisper.** I would not stop the production worker to get one; that branch is covered by unit and route tests.
- **Warm-up on `auto`.** Every Mac with Parakeet installed now warms it in the background (it is deferred while recording, as before). That costs Neural Engine compile time and memory once per server start on Macs that installed Parakeet but use Whisper for meetings.
- **`peakRssBytes`** samples the sandboxed CLI pid every 50 ms. A decode under about 50 ms is sampled once, at spawn.
- **A SHA-pinned `cliPath` sent on install is not remembered as a candidate for GET.** Only Developer ID paths are. It matters only when HOME differs from the CLI's location.
