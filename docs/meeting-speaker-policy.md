# Capture identity policy

A capture can opt into `standard`, `high-confidence`, or `anonymous` identity matching. Unconfigured captures retain Standard behavior. This is independent of transcription/cue flags and ASR engine selection.

- High-confidence recognition uses the existing 0.88 auto-enrollment floor for the wearer, expected speakers, and full-profile search. It withholds lower or invalid confidence names and skips automatic enrollment and named training-audio collection.
- Anonymous capture keeps transcription but does not invoke profile identification. Labels are `Ext`; this mode does not promise separate anonymous voice identities.
- Matching changes apply to newly processed audio. Existing names are unchanged; use the speaker correction workflow to remove existing misattribution. Global voice profiles are not removed.

`GET /api/meeting/:sessionId/speaker-policy` returns `mode` and `revision`. `POST` requires `mode` and `expectedPolicyRevision`. Saved captures additionally require their canonical `recordId` and the Control helper sends `expectedRevision` to protect against stale source selection. Policy writes use a private durable file per capture and compare-and-swap revision. A corrupt policy fails closed as Anonymous with `revision: unreadable` and an error. A deliberate repair may write using that exact revision; it never restores Standard automatically.

Identity policy is pinned when the audio chunk is accepted, before any asynchronous persistence, ASR or diarization work. Whole-chunk identification, track identification, label projection and persistence all use that same snapshot. Loosening the policy while ASR is pending applies only to the next accepted chunk.

Every new canonical transcript chunk stores `speakerPolicy`; raw chunk persistence and both saved-sidecar projections retain it. Legacy chunks without markers mean Standard. Malformed markers fail closed. Batch transcription splits windows at policy transitions, preserves strict confidence gates, and withholds names for distant or defensively mixed strict windows. Progressive HQ checkpoint reuse rejects a changed identity policy.

The final named-identity Nemotron pass builds meeting-wide channel/name mappings. It skips non-Mac captures containing strict-policy chunk markers (`speaker_policy` reason), preserving the existing markdown and sidecar byte-for-byte. Registered Mac captures use the separate anonymous final pass described below; it does not turn anonymous labels into named identities or reuse earlier Standard identities. Text transcription and the normal batch quality gate continue.

## Canary evidence

The isolated 13-file canary passed 180 tests, using mocked ASR/identity models and injected final runners. It covers policy persistence and permissions, compare-and-swap rejection, corrupt policy repair, collision-resistant capture IDs, shared confidence gates, real stream/meeting HTTP routes, delayed ASR policy changes, no strict automatic training, raw/saved/recovered markers, batch transition/fallback behavior, checkpoint invalidation, and final-pass refusal with no native runner call or canonical byte change. Existing Standard and speaker-review regressions passed. TypeScript typecheck passed.

This is backend qualification. The candidate still needs the Control helper/UI integration, actual policy selection and confirmation shortcuts, full applicable release checks, and artifact/signing gates before promotion. No live setting, transcription flag, cue flag, native worker, installed server or public package was changed by these canaries.


## Live Mac anonymous voices

Mac recordings retain the fixed High-confidence named identity floor (0.88).
Live `Voice N` is on by default as the window replay below; `COS_MAC_LIVE_VOICES=off`
gives 6.92.0 (every live Mac chunk reads `Ext`).
With `COS_MAC_LIVE_VOICES=anchors` (and `COS_MAC_VOICE_LABELS` not off), successful
live Nemotron tracks can carry anonymous `Voice N` labels at identity similarity
zero. These labels mean acoustic continuity inside this capture, never a person.
The chunk receipt and live transcript retain the existing `speaker` and
`segments[].speaker` fields; clients should display these distinct anonymous
labels instead of collapsing them into one unidentified row.

A label requires at least two seconds of isolated speech with at least 90% of the
track exclusive, a valid acoustic embedding, and a second agreeing observation
from a different raw chunk with different audio bytes. Replaying the same window
under another index does not count as new evidence. Matching uses fixed capture-local anchors at 0.88
with a 0.1 separation margin; intermediate similarities remain `Ext` and cannot
allocate new voices. Channel numbers are never used as cross-chunk identities.
Missing models, warming, busy, failed diarization, unavailable embeddings, short
tracks and uncertain matches keep existing `Ext` behavior. Named recognition is
unchanged. The switch disables new anonymous labels without changing ASR.

At most six acoustic anchors are held in the existing private active-session
file. They survive recovery with their label numbers, are never exposed through
the transcript DTO or saved sidecar, and are removed when that session closes.
Malformed continuity fails closed instead of restarting numbering. Existing
saved recordings are untouched; final whole-meeting anonymous diarization
retains its current quality gates. When live labels exist, a clean, exclusive
window must prove each final-channel crosswalk to the existing Voice N.
Contradictory/split crosswalks cannot transfer a label to other chunks; existing
local turns retain their evidence. That pass cannot renumber known voices. A final
channel that no live `Voice N` turn touches (a voice the live path never proved) is
numbered above every live number, so a saved meeting is never worse than the
6.92.0 pass; a channel a live turn contradicts stays `Ext`. With no live `Voice N`
at all (the default) nothing is restricted. These conservative guards are
not an acoustic calibration claim; real playback audio still needs qualification.

Mac renames remain text-only: `enrolNamedVoice` returns `mac_capture`. Neither
anonymous continuity nor a guessed name creates a global voice profile, banks
correction-training embeddings, or copies training WAVs. User-confirmed training
from Mac playback is the separate explicit flow below (`assignVoiceProfile`), with
selected isolated acoustic evidence, raw-index mapping, preview/confirmation and
provenance/retraction support; ordinary relabeling is not that consent.


## Live Mac window replay (6.93.0, on by default)

`COS_MAC_LIVE_VOICES=window`, or unset (`off` turns it off; `anchors` is the per-chunk path above)
replaces the per-chunk anchors with window replay
(`server/lib/mac-window-voices.ts`, `server/lib/mac-window-replay.ts`). Chunk k is
diarized together with the durable chunks before it (contiguous, at most 5 chunks
and 30 s), so the model's slots are consistent across the boundary inside that
window. A slot inherits a capture track only through frames the capture already
attributed: one to one, at least 1 s of exclusive overlap, at least 80% of that
slot's overlap on one track. A slot with attributed overlap that fails those
tests gets no track and cannot mint a number. A carried slot is used only when the
chunk diarized alone agrees (at least half of the slot's exclusive frames placed, at
least 90% of those on one channel). This catches a window model that merged two voices
that both speak in the current chunk: that slot is not carried and its frames are stored
untracked, so the error does not feed the next window. It does not yet catch a clean
hand-over at a chunk boundary (a new voice alone in the chunk, put on an old voice's slot
by the window model): the chunk alone shows one clean voice and agrees. Catching that
needs evidence from more than one chunk. It is a known limit now that the window is on by default: a wrong number in the live and saved transcript. It becomes a wrong name only if a person assigns that `Voice N` to someone, and that assignment is gated (below). A track
becomes `Voice N` after two clean proof chunks (2 s alone, purity 0.9, distinct chunk and
audio hash). A track no remembered frame refers to is evicted and its id reused (12 live
ids), so a long meeting cannot exhaust them; its number stays spent. The window run's
timeout is sized from its length (1.5 s per 6 s of audio, 7.5 s for 30 s), a timeout never
counts toward the breaker shared with G2 (two in a row stop the window for that capture),
and a timeout or refused geometry falls back to the plain per-chunk run.

The state is per-frame track ids for the last 4 chunks plus track proofs and the
number high-water. It lives in the private active-session file, is validated on
every use, and is never written to the saved sidecar. A returning voice beyond the
window reads `Ext` or a new number; a wrong merge is the failure this design
refuses to risk. The session-wide fix is a persistent native diarizer per capture
(the append-session prototype), which is not part of this release.


## Assigning a Mac voice to an existing voice profile (6.93.0)

A Mac `Voice N` is text only by default: it is never a profile, never enrolled and never
trained. The one exception is an explicit assignment: `POST /api/meeting/:sessionId/relabel`
with `assignVoiceProfile: true`, `from` an unnamed `Voice N`, and `to` an already enrolled
profile name. The server extracts voiceprints from the retained chunk audio (7 days, the
meeting-audio archive; a Mac recording banks no embeddings), keeps only this voice's audio,
runs the same coherence and diversity gates as a glasses rename, and writes nothing until
`confirm: true`. The dry run reports the person, the most samples that would be added and
the similarity of this voice to the stored profile, as a suggestion. Nothing is created,
and when no audio is retained the whole request is refused (`422 nothing_to_enrol`),
rename included. Gates (6.93.0): the wearer's own profile is never a target (`409 owner_profile`);
a voice that sounds unlike the stored profile (under the 0.55 merge floor, `below_floor`), a
`Voice N` that holds more than one voice (`mixed_voice`: units were thrown out as a different
voice and the kept group is under two thirds of what was embedded) and one coherent unit under
6 s (`too_little_audio`) are each `409` unless the request carries `force: true`. It is refused
while any meeting is being recorded (`409 capture_active`). Samples carry `mac-assign:<sessionId>`
provenance, not `correction:`: they rank as assisted, are capped at 10 per profile, never vouch
for identity, may only replace another Mac-assigned sample, and "Not in this meeting"
retracts them.
