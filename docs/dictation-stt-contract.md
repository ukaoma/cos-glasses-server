# Dictation speech-to-text contract (server 6.73.0)

Status: shipped in 6.73.0 (2026-10-13). The map and phone contract were written first; the
measured numbers are in the Evidence section at the end.

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
| `dictation_disabled_by_env` | `COS_DICTATION_FOLLOWS_STT=0` holds every dictation decode on Whisper |
| `large_v3_preview_not_offered`, `nemotron_not_wired` | A Preview choice that is not offered; dictation keeps Whisper |

The user never sees a blank or an error because of Parakeet: a failed Parakeet decode is
retried on Whisper inside the same request. Parakeet warms when either the Preview model
is `parakeet` or the HQ model is `parakeet-ultra`, never while a recording is live.

### Second opinion and resolver

Off for dictation, always, whatever the meeting setting says. A prompt is something the
user is waiting on. Measured added latency is in the Evidence section so Miles can decide.

### Front end and quiet gate

See the Evidence section for the measurements behind these rules.

- Front end: the selected front end is applied to Parakeet dictation decodes (as the
  meeting preview does). Whisper dictation decodes keep raw audio, as in 6.72.0: on real
  prompt chunks highpass changed the first word of the Large-v3 HQ text on 24 of 149, the
  same leading-speech effect measured on 2026-07-30, with no accuracy gain to pay for it.
- Quiet gate: never drops dictation audio, whatever the setting. Every chunk is still
  decoded and the existing post-decode filters stay the only silence handling. On clean
  spoken one-to-three-word commands, 18 of 30 had under 0.5 s of Silero speech, so the
  meeting rule would have dropped them. The gate's other meeting effect (no vocabulary
  prompt on a quiet chunk) is not applied either: it would strip the names prompt from
  exactly those short commands. `GET` reports `dictation.quietGate: "none"`.

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

## 5. Fast mode on a Max-tier Mac (Miles's case)

| Setting | Fast mode on resolves to | Fast mode off (final) resolves to |
|---|---|---|
| Preview `turbo`, HQ `large-v3` (defaults) | live Large-v3 worker: p50 316 ms, p95 467 ms | whisper-cli Large-v3: p50 1,544 ms, p95 1,844 ms per chunk (mostly hidden by the HQ warm while speaking) |
| Preview `parakeet`, HQ `large-v3` | Parakeet Ultra plus highpass: about p50 291 ms, p95 484 ms | whisper-cli Large-v3, as above |
| Preview `parakeet`, HQ `parakeet-ultra` | Parakeet Ultra, as above | Parakeet Ultra, as above |

On a Max-tier Mac, following the Preview model with Parakeet makes Fast mode about as fast
as today's live Large-v3 worker (p50 291 vs 316 ms, p95 484 vs 467 ms) and clearly less
accurate on names (69% vs 98% of name targets clean, 63% vs 88% in babble). Numbers and
negations are level. Recommendation for Miles's Mac: keep the Preview model on Turbo for
dictation; choose Parakeet only if the meeting-preview gain matters more than names in
prompts, or set `COS_DICTATION_FOLLOWS_STT=0` to keep dictation on Whisper while meetings
use Parakeet (it holds all dictation slots, not one).

## Evidence

Measured 2026-10-13 on the M3 Ultra (Max tier), with private engines only: whisper-server
Large-v3 and Turbo on ports 18278 and 18277 with the production flags (`-t 16 -l en -fa
--no-speech-thold 0.7 --vad`), whisper-cli Large-v3 with the interactive HQ arguments
(beam 2, no VAD, vocabulary prompt), and Parakeet Ultra from a scratch copy of the pinned
install through the server's own `transcribeParakeet` (sandboxed). The running server,
its whisper processes and its data were not touched. The vocabulary prompt was the
bake-off `short_prompt` list; every engine's text went through the same fuzzy vocabulary
correction the server applies. No transcript text is reproduced here.

Two sets:

- Real: 173 saved prompt-draft chunks (copied read-only), 152 of them 2 to 15 s. No human
  reference exists, so accuracy here is only "difference from today's HQ text".
- Synthetic with known text: 25 prompts (names, numbers with units, negations, one to three
  word commands), 3 to 5 macOS voices each, 87 clips clean and the same 87 mixed with real
  G2 meeting babble at 12 dB SNR. Scored on target words (for example "15 minutes" or
  "fifteen minutes") and WER. Synthetic speech is cleaner than a G2 microphone; treat it as
  a controlled check, not field accuracy.

### Latency, real prompt chunks 2 to 15 s (n=152)

| Engine (dictation path) | p50 ms | p95 ms |
|---|---|---|
| Turbo live worker (Fast, standard Mac) | 195 | 241 |
| Turbo preview, no prompt (peek today) | 186 | 221 |
| Large-v3 live worker (Fast, Max tier) | 316 | 467 |
| whisper-cli Large-v3 (HQ final) | 1,544 | 1,844 |
| Parakeet Ultra, raw | 239 | 426 |
| Parakeet Ultra, highpass input | 233 | 419 |
| Highpass front end (ffmpeg), added | 58 | 65 |
| Full front end (ffmpeg), added | 151 | 169 |

### Accuracy, synthetic set (target words matched)

| Engine | Names clean | Names babble | Numbers clean / babble | Negations | Short commands clean / babble | WER clean / babble |
|---|---|---|---|---|---|---|
| whisper-cli Large-v3 (HQ) | 50/51 (98%) | 44/51 (86%) | 32/33, 33/33 | 42/42 | 33/35, 33/35 | 6.5% / 9.1% |
| Large-v3 live worker | 50/51 (98%) | 45/51 (88%) | 30/33, 30/33 | 42/42 | 34/35, 34/35 | 6.9% / 7.1% |
| Turbo live worker | 45/51 (88%) | 46/51 (90%) | 30/33, 30/33 | 42/42 | 33/35, 33/35 | 8.5% / 8.5% |
| Turbo preview, no prompt | 35/51 (69%) | 32/51 (63%) | 30/33, 30/33 | 42/42 | 31/35, 33/35 | 13.5% / 14.7% |
| Parakeet Ultra, highpass | 35/51 (69%) | 32/51 (63%) | 30/33, 30/33 | 42/42 | 33/35, 33/35 | 13.9% / 15.4% |
| Parakeet Ultra, full chain | 35/51 (69%) | 29/51 (57%) | 30/33, 30/33 | 42/42 | 34/35, 23/35 | 13.3% / 20.4% |

Parakeet has no vocabulary prompt, so on names it lands where an unprompted Turbo does.
The `full` front end hurts Parakeet in noise (short commands 33 to 23 of 35, WER 15.4% to
20.4%) and changed the first word on 10 of 123 real chunks (highpass: 1 of 123). Highpass is
the default and is safe; `full` is the user's choice and is honoured, but it is the wrong
choice for dictation.

### Real chunks: difference from today's HQ text (n=152)

Large-v3 live worker 25.0%, Turbo live worker 23.6%, Parakeet Ultra highpass 27.3%. All
three give empty text on the same 26 chunks where HQ (no VAD) wrote words; those are
fragments of under a second at the end of a recording, where Silero also finds no speech.

### Quiet gate

Clean one-to-three-word commands: 18 of 30 under 0.5 s of Silero speech (minimum 0.00 s).
With babble mixed in Silero hears speech everywhere (minimum 0.80 s), so the gate fails in
both directions on prompts. Dictation keeps no gate.

### Second opinion and resolver (not run; for Miles to decide later)

The resolver itself costs p50 0.06 ms, max 0.92 ms on a prompt chunk. The cost is the second
decode. With HQ `large-v3` and Parakeet as the second opinion, run in parallel: about 0 ms
added (Parakeet finishes first), or about 290 ms run after HQ. With HQ `parakeet-ultra` and
Large-v3 as the second opinion: about 1.3 s added in parallel (p50 1,544 minus 291), 1.5 s
after. That last case would remove most of Parakeet's speed advantage on the final.
