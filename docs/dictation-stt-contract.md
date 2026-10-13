# Dictation speech-to-text contract (server 6.73.0)

Status: map and phone contract written first (2026-10-13), refined as the build lands.
Measured numbers live in the "Evidence" section at the end.

Miles asked (2026-10-13): the transcription choices in Settings (Preview model, HQ model,
front end, quiet gate) must drive prompting and dictation too, not only meetings.

## 1. Map of every dictation path (6.72.0, before this change)

"Live worker" means whisper-server on 8178, the canonical live decoder. It runs the
commit model: Whisper Turbo on a standard Mac, Whisper Large-v3 on a Max-tier Mac
(`getWhisperCommitCapability().effectiveModel`; Miles's M3 Ultra runs Large-v3 there).
"Preview sidecar" means the isolated whisper-server on 8177 (`whisper-preview.ts`),
Turbo or small.en. "whisper-cli" means the one-shot Large-v3 beam-search decoder
(`transcribeHighQuality`).

| # | Route | Function | What it produces | Engine in 6.72.0 | How Fast mode picks it |
|---|---|---|---|---|---|
| D1 | `POST /api/prompt-drafts/:id/peek` | `transcribeWhisperPreview` | Provisional lens text for the still-open chunk (SSE `prompt_transcript`, `provisional: true`). Never saved. | Preview sidecar (Turbo); falls through to the live worker when the sidecar is down | Not affected by Fast mode |
| D2 | `POST /api/prompt-drafts/:id/chunks` (fast warm, every chunk) | `transcribeChunk(..., 'fast', 'warm')` then `transcribeAudioBuffer(mode fast, local-only)` then `transcribeLocal` | The live HUD text for a closed chunk (SSE `prompt_transcript`, not provisional) and the cached Fast transcript | Live worker | Always runs, both modes. In Fast mode it is also the final text (reused by finalize) |
| D3 | same route, speculative HQ warm (`mode=hq` only, `COS_HQ_SPECULATIVE_WARM` on) | `transcribeChunk(..., 'hq', 'warm')` then `transcribeHighQuality` (interactive, words on) | Cached HQ transcript so finalize is near-instant. Never painted | whisper-cli Large-v3 | Skipped in Fast mode |
| D4 | `POST /api/prompt-drafts/:id/finalize` and `/retry` | `finalizeDraft` then `transcribeChunk(..., mode, 'final')` for each chunk without a reusable decode | The sent prompt (Record Message, hold-to-talk, edit instruction) | HQ mode: whisper-cli Large-v3, live worker if the CLI fails. Fast mode: live worker | `?mode=fast` from the phone's `cos_fast_mode` |
| D5 | `POST /api/transcribe` | `transcribeAudioBuffer` | One-shot Quick VOICE and browser recordings (the browser path posts WebM, not WAV) | Same split as D4. Over 60 s of audio, HQ is downgraded to Fast | `?mode=fast` from `cos_fast_mode` |
| D6 | `POST /api/dictation/finalize` | `cleanOutboundDictation` | Glossary and optional polish of text the phone already transcribed (Moonshine) | No audio, no server engine | Not applicable |
| D7 | `POST /api/prompt-edit` | `applyPromptEdit` | Applies an edit instruction to a draft | Text only. The spoken instruction itself arrives through D1 to D4 as its own draft | Not applicable |

None of D1 to D5 applied a front end or a quiet gate in 6.72.0:

- No front end. `transcribe-audio.ts` notes the 2026-07-30 measurement that the light
  (80 Hz highpass) enhance dropped leading speech on compose, so prompts decode raw audio.
- No quiet gate. Every chunk is decoded; silence is handled after the decode by the
  hallucination filters (`isFullHallucination`, vocabulary echo, caption credits) and the
  prompt tail guard (Silero speech windows, used only to judge a trailing sentence).

### Fast mode is not literally "Turbo"

The phone's copy says Fast mode is Turbo. On the server it means "the live worker":
Turbo on a standard Mac, but Whisper Large-v3 (greedy, already loaded) on a Max-tier
Mac, including Miles's. HQ means whisper-cli Large-v3 with beam search and VAD. So the
honest definition is "the fast engine", not a model name. Either way Fast is faster than
HQ, which is the property the mapping below keeps.

## 2. Mapping shipped in 6.73.0

The engine for a decode is chosen once, when that decode starts, from one snapshot of the
settings. A decode never changes engine part way through. A Parakeet failure falls back
to the Whisper engine that path used in 6.72.0, for that decode only, with a plain reason.

| Path | Follows | `preview: turbo` (default), `large-v3`, `nemotron-560` | `preview: parakeet` |
|---|---|---|---|
| D1 peek (live preview) | Preview model | Unchanged (preview sidecar Turbo) | Parakeet Ultra, preview lane |
| D2 fast warm (HUD text) | Preview model | Unchanged (live worker) | Parakeet Ultra |
| D4/D5 Fast mode final | Preview model | Unchanged (live worker) | Parakeet Ultra |

| Path | Follows | `hq: large-v3` (default), `large-v3-legacy` | `hq: parakeet-ultra` |
|---|---|---|---|
| D3 HQ warm | HQ model | Unchanged (whisper-cli Large-v3) | Parakeet Ultra |
| D4/D5 HQ final | HQ model | Unchanged (whisper-cli Large-v3) | Parakeet Ultra |

`large-v3` and `large-v3-legacy` differ only in the meeting batch timestamp decoder; a
dictation decode is interactive and never used that flag, so both are today's HQ path.

Why Fast mode follows the Preview model: Fast mode is "give me the fast engine". The
Preview model is the fast engine the user picked. Parakeet Ultra decodes a 6 s chunk in
about 0.3 s warm, so Fast mode on Parakeet stays faster than HQ on either engine.

### Parakeet safety (same rules as meetings)

Parakeet runs for a dictation decode only when all of these hold; otherwise the decode
uses the 6.72.0 Whisper engine for that path and records the reason code:

| Reason code | When |
|---|---|
| `parakeet_not_installed` | Parakeet is not installed |
| `parakeet_warming` | The compiled model is not warm yet (a warm-up is started; never awaited by a prompt) |
| `parakeet_warm_failed` | The last warm-up failed (retried every 2 minutes) |
| `parakeet_breaker_open` | Repeated Parakeet misses opened the breaker (shared with the meeting preview) |
| `parakeet_busy` | The single preview lane is in use (peek), or two interactive decodes are already running |
| `parakeet_failed` | This decode failed or timed out; Whisper decoded the same audio |
| `audio_not_pcm_wav` | The audio is not 16 kHz mono PCM16 WAV (the browser path posts WebM) |

The user never sees a blank or an error because of Parakeet: a failed Parakeet decode is
retried on Whisper inside the same request. Parakeet warms when either the Preview model
is `parakeet` or the HQ model is `parakeet-ultra`, never while a recording is live.

### Second opinion and resolver

Off for dictation, always, whatever the meeting setting says. A prompt is something the
user is waiting on. Measured added latency is in the Evidence section so Miles can decide.

### Front end and quiet gate

See the Evidence section for the measurements behind these rules.

- Front end: applied to Parakeet dictation decodes (as the meeting preview does).
  Whisper dictation decodes keep raw audio, as in 6.72.0.
- Quiet gate: never drops dictation audio. Every chunk is still decoded and the existing
  post-decode filters stay the only silence handling. (Measured below: the Silero gate's
  0.5 s rule would drop real short commands.)

## 3. Phone contract

**No new request field is required, and no field gates dictation.**

Why: the meeting preview needs `previewModels` because the phone checks the answer's
`model` against `MAC_MEETING_PREVIEW_MODELS` and treats anything else as an identity
mismatch. Dictation has no such check:

- `POST /api/prompt-drafts/:id/peek` answers `{ draftId, chunkIndex, peekGen, accepted }`
  with no text. The text arrives later as the SSE event `prompt_transcript`.
- The phone reads `prompt_transcript` through `parsePromptTranscriptEvent`
  (`src/lib/prompt-live-transcript.ts`), which keeps only `draftId`, `chunkIndex`, `text`,
  `provisional` and `peekGen` and checks no model. The same holds for the non-provisional
  chunk event (D2).
- `POST /api/transcribe` and `/api/prompt-drafts/:id/finalize` are read for `text`,
  `requestedMode`, `actualQuality`, `degraded`, `backend` and `degradationReason`.
  `actualQuality` keeps its three values (`hq`, `fast`, `cloud`); `announceTranscriptionQuality`
  only reacts to `requestedMode: 'hq'` with `degraded: true`.

So every phone, including the public 618, gets the engine the user picked for dictation,
and no older phone can reject the text. What 6.73.0 adds is additive and optional:

| Where | New field | Values |
|---|---|---|
| SSE `prompt_transcript` | `engine` | `whisper` or `parakeet-ultra` |
| `/api/transcribe`, finalize, retry | `engine` | `whisper` or `parakeet-ultra` (finalize: `mixed` when chunks differ) |
| same | `engineReason` (only when the selection could not run) | a reason code from the table above |
| `GET /api/stt-settings` | `dictation` block and `appliesTo.dictation` | see section 4 |

`backend` gains the value `parakeet-ultra` for a Parakeet decode. Older phones log it and
otherwise ignore it. `actualQuality` for a Parakeet decode is the mode the user asked for
(`hq` from the HQ model, `fast` from the Preview model), so an HQ Parakeet prompt is not
reported as degraded.

The phone keeps sending exactly what it sends today: `?mode=fast` when `cos_fast_mode` is
on, nothing otherwise. It must not send `previewModels` on dictation routes (it is ignored
there).

## 4. `GET /api/stt-settings` additions (additive only)

```json
"appliesTo": { "preview": "next live chunk", "hq": "next saved meeting", "dictation": "next dictation chunk" },
"dictation": {
  "preview": { "engine": "whisper" | "parakeet-ultra", "follows": "preview", "reason": null | "...", "reasonCode": null | "..." },
  "final":   { "engine": "whisper" | "parakeet-ultra", "follows": "hq",      "reason": ..., "reasonCode": ... },
  "fast":    { "engine": "whisper" | "parakeet-ultra", "follows": "preview", "reason": ..., "reasonCode": ... },
  "frontEnd": "highpass" | "full" | "raw",
  "quietGate": "none",
  "secondOpinion": "off",
  "note": "plain sentence for UI copy"
}
```

`dictation.frontEnd` is what Parakeet dictation hears (`raw` when no dictation decode uses
Parakeet). Control and the phone can replace "Dictation is unchanged" with `dictation.note`.
A 6.72.0 server has no `dictation` key; clients treat its absence as "dictation uses Whisper".

## Evidence

Filled in as measured (section 5 below).
