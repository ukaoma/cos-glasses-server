# Capture identity policy

A capture can opt into `standard`, `high-confidence`, or `anonymous` identity matching. Unconfigured captures retain Standard behavior. This is independent of transcription/cue flags and ASR engine selection.

- High-confidence recognition uses the existing 0.88 auto-enrollment floor for the wearer, expected speakers, and full-profile search. It withholds lower or invalid confidence names and skips automatic enrollment and named training-audio collection.
- Anonymous capture keeps transcription but does not invoke profile identification. Labels are `Ext`; this mode does not promise separate anonymous voice identities.
- Matching changes apply to newly processed audio. Existing names are unchanged; use the speaker correction workflow to remove existing misattribution. Global voice profiles are not removed.

`GET /api/meeting/:sessionId/speaker-policy` returns `mode` and `revision`. `POST` requires `mode` and `expectedPolicyRevision`. Saved captures additionally require their canonical `recordId` and the Control helper sends `expectedRevision` to protect against stale source selection. Policy writes use a private durable file per capture and compare-and-swap revision. A corrupt policy fails closed as Anonymous with `revision: unreadable` and an error. A deliberate repair may write using that exact revision; it never restores Standard automatically.

Identity policy is pinned when the audio chunk is accepted, before any asynchronous persistence, ASR or diarization work. Whole-chunk identification, track identification, label projection and persistence all use that same snapshot. Loosening the policy while ASR is pending applies only to the next accepted chunk.

Every new canonical transcript chunk stores `speakerPolicy`; raw chunk persistence and both saved-sidecar projections retain it. Legacy chunks without markers mean Standard. Malformed markers fail closed. Batch transcription splits windows at policy transitions, preserves strict confidence gates, and withholds names for distant or defensively mixed strict windows. Progressive HQ checkpoint reuse rejects a changed identity policy.

The final Nemotron pass builds meeting-wide channel/name mappings. It therefore skips any capture containing strict-policy chunk markers (`speaker_policy` reason), preserving the existing markdown and sidecar byte-for-byte. It does not reuse an earlier Standard identity to relabel later anonymous speech. Text transcription and the normal batch quality gate continue.

## Canary evidence

The isolated 13-file canary passed 180 tests, using mocked ASR/identity models and injected final runners. It covers policy persistence and permissions, compare-and-swap rejection, corrupt policy repair, collision-resistant capture IDs, shared confidence gates, real stream/meeting HTTP routes, delayed ASR policy changes, no strict automatic training, raw/saved/recovered markers, batch transition/fallback behavior, checkpoint invalidation, and final-pass refusal with no native runner call or canonical byte change. Existing Standard and speaker-review regressions passed. TypeScript typecheck passed.

This is backend qualification. The candidate still needs the Control helper/UI integration, actual policy selection and confirmation shortcuts, full applicable release checks, and artifact/signing gates before promotion. No live setting, transcription flag, cue flag, native worker, installed server or public package was changed by these canaries.
