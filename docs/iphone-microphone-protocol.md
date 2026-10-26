# Future iPhone microphone protocol (default off)

This branch implements a server contract for a future companion release. It is not enabled in the installed server, is not a claim of iPhone device qualification, and does not record app playback or calls. No version, installed setting or published artifact is changed here.

## Admission and routing

`COS_IPHONE_MICROPHONE_MEETINGS=1` is an explicit test/candidate opt-in. The default is off. `/api/health` and `/api/models` expose `capabilities.phoneMicrophoneMeetings` with:

- `enabled`: true only with the opt-in, a durable server identity, selected HQ `parakeet-ultra`, and installed Parakeet.
- `protocolVersion: 1`, `sourceType: "iphone_microphone"`, `speakerPolicy: "anonymous"`.
- `asrModel: "parakeet-ultra"`, `dictionary: "server-profile-corrections"`.
- `reason`: `disabled`, `server_identity_unavailable`, `parakeet_not_selected`, `parakeet_not_installed`, `parakeet_unavailable`, or `ready`.

This is availability of the protocol and installation, not a guarantee of a warm/free decoder. Decode failures return a retryable `503 phone_parakeet_<reason>` and keep raw audio. There is no Whisper/cloud fallback and no change to the global STT choice. Both live canonical transcription and saved/recovery HQ use the existing offline Parakeet worker and existing deterministic profile dictionary corrections. Phone HQ has no second opinion or resolver.

IDs are either `phone_<lowercase UUID>` or `phone_<13-digit originalStart epochMs>_<lowercase UUID>`, under the existing 96-character cap. A timestamped ID must agree with `startTime`. Recovery must use a fresh bounded ID when splitting, retain original start time, and keep parent/index lineage separately. Source cannot change within an ID.

Canonical upload remains the shared `POST /api/transcribe-stream` indexed transport. Require an `X-COS-Server-Instance` pin, `sessionId`, `chunkIndex`, original `startTime`, chunk-start `elapsed`, and query `sourceType=iphone_microphone&speakerPolicy=anonymous`. `chunkIndex`, `elapsed` and `startTime` are canonical decimal strings (no sign, leading zero, exponent, hex, blank or repeated key); a repeated `sessionId` is refused with 400 `invalid_session_id` before the phone check. Audio is canonical 16-kHz mono PCM16 WAV, at most 30 seconds/960044 bytes. `speaker`, if supplied, must be `Ext`; Even role metadata is refused. Admission persists an independent phone registry before raw audio/ASR. A hash/timing receipt pins every accepted index even when ASR fails; exact retry is idempotent and conflicting bytes/timing are refused. Only one phone chunk per capture processes at a time.

`POST /api/meeting/save` and `POST /api/meeting/sessions/:id/stop` require the same explicit source/policy fields. Saves require the server pin. Existing unmarked G2 requests and the separate Mac transport retain their behavior. Phone IDs with missing/wrong fields, or non-phone IDs carrying phone fields, fail closed. Phone preview returns 204 without decoding. Candidate/offline-ASR transports are refused; the companion's existing indexed-upload WAL remains the offline path.

A status request for a truly pristine ID may return `state: "missing", provenanceState: "not_admitted"` with the explicit requested phone source. It creates no registry. Existing raw/archive/journal/quarantine evidence without the exact admitted registry yields a provenance error and is retained; it is never reinterpreted as G2. This distinction permits offline Stop/recovery to reconcile before its first upload. Admission-off blocks uploads, while existing source reads/save/recovery remain available from durable provenance.

## Identity, storage and consumers

Phone captures are anonymous initially: canonical `Ext`, zero identity similarity, no G2 wearer/amplitude identification, no Even role interpretation, no Nemotron naming, no voiceprint matching, no auxiliary enrollment audio, no profile training. Naming/policy/enrollment mutations are refused. Existing policy-aware finalization/HQ cannot restore named speakers. This release does not depend on the experimental Mac acoustic-window prototype.

The same session journal, raw audio pipeline, retained meeting-audio archive, meeting store, finalization/summary jobs, saved meeting, Ask history and attached-file context are reused. Registry, active journal, `_capture.json`, saved `.g2-chunks.json` sidecar (historical storage suffix), save/status/ASR DTOs and Markdown export preserve `sourceType: iphone_microphone` and anonymous policy. The export says `iPhone Microphone`, never `G2 Glasses`. Source-bearing raw metadata follows audio into retention/quarantine. G2 blending/operations import is skipped; the existing standalone meeting library and summaries are reused. Phone rows are included beside Mac rows when an operations library is configured, and Ask/file keys are `phone:<captureId>`.

**Consumer release gate:** Control 350 knows G2/Mac sources and context keys only. A future Control update must decode/display `iphone_microphone`, accept `phone:` keys, and prevent joining phone recordings into G2/Mac live UI. Do not relabel phone DTOs to accommodate the old client. The companion must require the exact capability (including ASR/dictionary fields), preserve the selected source through rearm/recovery, and show unavailable reasons without switching to glasses. The optional companion `/display-recording/start` broadcast is not an admission route in this server revision; first indexed audio is the server admission point.

## Qualification

Tests use temporary HOME/data/profile/cache/tmp directories, synthetic PCM, injected ASR/identity functions and loopback HTTP. No actual ASR, voice models, iPhone recording, native build, UI automation, provider requests, installation or publication is run. Evidence and scheduler receipts live outside the worktree at `/Users/ukaoma/cos-release-candidates/iphone-microphone-server-20261026`.

Required before activation/publication: actual Even app/iPhone with G2 disconnected, permission denial, source-tag verification, first-frame/liveness checks, interruption/rearm/background limits, offline upload and cold process restart, Save/Ask/files/export in updated consumers, dictionary pronunciation examples through installed Parakeet, and proof that voice profiles/training stores stay unchanged. App playback/Zoom/Teams/call capture is unsupported.

Review regressions also exercise the actual shared Ask runtime/store: phone, G2 and Mac captures with the same UUID retain separate history and files, and a phone capture reopens through its saved transcript. Phone Ask adapters require durable registry/policy plus exact anonymous active/saved provenance; a rejected or corrupt journal cannot bypass session recovery through transcript fallback. Whisper progressive checkpoints are excluded for phone captures even if the global HQ setting changes while Parakeet is awaiting completion. These are injected, filesystem/loopback tests, not physical-device or model-quality qualification.

Remote Control Stop via the G2 display-bus request/claim protocol is not supported for phone captures. Those endpoints reject phone IDs with `phone_capture_stop_on_iphone`; Control must say **Stop on iPhone**. The owning companion still submits its existing source-tagged autonomous Stop intent after draining local audio.
