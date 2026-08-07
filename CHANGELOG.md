## 6.21.27

- Per-speaker speaking time on the review. `speakingMs` per voice, plus
  `voicedMs`, `attributedSpeakingMs`, `unattributedSpeakingMs` and
  `notCapturedMs` on the meeting.

  It reads the word timings the HQ batch pass ALREADY writes
  (`batchSegments[].speakerWords`, present on 82 of 92 measured sidecars), so it
  is real voiced time with silence excluded — no audio, no VAD, no embedding, and
  it works past the 7-day audio retention. Without them it falls back to chunk
  deltas capped at the capture ceiling, and `speakingTimeSource` says which ran.

  Three things the arithmetic had to get right, each caught against real data:
  word intervals OVERLAP, so a naive sum totals 1.2x-1.5x the meeting's own
  duration — union counts overlap once and lands at 0.75x-0.97x. Speakers also
  overlap EACH OTHER, so per-speaker figures legitimately exceed wall clock
  (a real 5.2-minute capture summed to 6.0); the invariant is therefore
  `voicedMs + notCapturedMs = durationMs`, never attributed + unattributed.
  And the attributed/unattributed split is by `nameAsserted` PER VOICE, never
  per segment: a per-segment floor cannot carry the owner or human-confirmed
  waivers and contradicts the rows above it (measured on 2026-08-02 "G2 App
  Fixes": the panel names MU for 47.3% of the meeting, a per-segment floor 14.9%).

- Uncapped chunk deltas credit dead air to whoever spoke last. On 2026-08-04
  "Design Gaps" that turns 8.1 minutes of speech into 50.2, with a 36.6s MEDIAN
  gap that no outlier rule would catch. Capped at the measured ceiling.

## 6.21.26

- `assertedSegments` added to the speaker review: how many segments belong to
  voices the panel actually shows WITH A NAME. `attributed` is a boolean that
  only goes false at 100% unidentified, so a meeting where 295 of 299 chunks
  matched nobody reported `true` and rendered as though normally attributed.
  Measured unidentified share across 14 retained sessions ran 24% to 100%, all
  of it collapsing onto that one boolean.

  It counts asserted voices (`nameAsserted`), NOT chunks carrying a
  person-shaped label. Those diverge sharply: on session 0i1xv3 the label-based
  count is 287 of 379 segments while only 177 are displayed as names, so a
  header built on labels would claim three quarters of the meeting identified
  above a list of rows reading "Unidentified voice".

  Purely additive — the route already spreads the review object and no client
  decodes this payload strictly. COS Control 0.5.5+ renders it, and omits the
  line against an older server rather than showing a zero.

## 6.21.25

- `POST /meeting/:sessionId/confirm` — record that a human vouched for a label
  the display floor demoted. The floor exists so the identifier cannot assert a
  name it did not earn, but a person who was in the room is better evidence
  than a cosine score, and there was no way to say so. A rename could not
  express it: `relabelSidecarJson` rejects `from === to`. So the panel demoted
  the row, instructed the reviewer to name it, and offered a candidate list
  that excluded the very name they wanted.

  A confirmation rewrites nothing — the sidecar already carries the label. It
  records the vouch, and `reviewMeetingSpeakers` then reports the row as
  asserted. Meeting-scoped like every other correction: vouching for a voice in
  one room says nothing about a different room. Refuses with 409 if no chunk in
  the meeting actually carries that label, so a typo cannot become a permanent
  confirmation in an append-only ledger.

  A confirmed row still shows its thrash caveat. The name is asserted; the
  evidence that it swaps with someone else is not hidden.

- Fixed a latent trap found while building it: `readCorrections` validated
  `phase` against a hardcoded list, so adding a phase to the TYPE made every
  such row unusable at read time — the write succeeded, the read silently
  dropped it, and no error surfaced anywhere. Phase validation now derives from
  a single list with a narrowing guard.

## 6.21.24

- A leaked recording session can no longer block every restart. The maintenance
  drain gate counted `sessions.size`, so a session whose phone dropped
  mid-recording without sending a close pinned that count at 1 indefinitely and
  Install, Repair, Restart and Update Server each drained it, timed out after
  60s, and failed — with no user-visible reason. Hit twice on 2026-08-06
  (6.21.20 and 6.21.22); the second phantom had been silent 54 minutes and the
  only way through was to finalize it as a real meeting, which it was not.

  The gate now counts only sessions active within the last 30 minutes. A stale
  one is reported in status as `staleTranscriptionSessions` with its session id,
  silent duration and chunk count, so a blocked operator can see the cause —
  and `/api/meeting/orphans` reporting 0 can no longer coexist silently with a
  held lock, since the two read different stores.

  **Nothing is reaped.** The session, its chunks and its recoverability are
  untouched; only its claim on the restart gate expires. The 30-minute window
  sits far above the reasons a live recording legitimately goes quiet (a
  backgrounded phone buffering to IndexedDB, a network drop) and far below the
  4h durable-chunk retention.

  Note for anyone reading the health payload: `oldestWorkStartedAt: null` does
  NOT indicate a leak. `recording_session` reaches the gate through
  `extraActiveByKind`, which never contributes a timestamp, so every recording
  session reports null — healthy or not. Only `lastActivityAt` separates them.

## 6.21.23

- `GET /meeting/:sessionId/embeddings` — why each chunk was labelled the way it
  was. Reads the per-chunk embeddings the pipeline has retained since 6.21.15
  and scores each one against every enrolled profile now, returning the top
  matches and the margin between the best two. Until this route that store had
  **no production reader at all**: the data was collected for weeks and never
  looked at.

  The margin is the point. It separates "missed by 0.02 against one profile"
  from "equidistant between three" — a fixable near-miss versus a genuinely
  ambiguous voice — and the review panel cannot tell those apart today. On a
  face-mounted microphone that distinction is most of the available signal.

  Read-only, and deliberately does NOT return the raw 192-float vectors: ~1 KB
  of base64 per chunk that means nothing to a reader. Whole-session reads are
  capped (default 50, max 400) because each chunk is scored against every
  profile. A retained-but-absent chunk is reported in `missing` rather than
  dropped, and `retained:false` stays distinguishable from "scored, no match".

## 6.21.22

- The meeting Turbo preview is ON by default. `COS_WHISPER_MEETING_PREVIEW` is
  now opt-OUT (`=0` disables), matching `COS_WHISPER_STRIP_BRAND_URLS` and
  `COS_WHISPER_THANKYOU_FILTER` in the same file. The committed Large-v3
  transcript remains authoritative and still atomically replaces the
  provisional line; this gate only decides whether the low-latency lane is
  offered at all. The companion carries a second gate, flipped to default-on in
  app 6.8.312 — both must be on for a provisional line to appear, and an older
  companion simply never asks.

- Includes 6.21.21, which was superseded before publish and never released to
  npm. Do not look for it there. Its content — the whisper preflight probe
  retry — is carried here unchanged.

## 6.21.21

- One transient process probe no longer disables local Whisper for the whole
  server lifetime. On 2026-08-06 the `/bin/ps` probe inside the startup
  preflight failed exactly once, during a generation changeover while the
  previous generation's Python child was shutting down. Startup caught it, set
  state `failed`, and stopped — whisper never launched, port 8178 refused for
  ~30 minutes across a live recording, and only a manual restart recovered it.
  Boot calls `startWhisperServer()` once, and the only other recovery path is a
  circuit breaker that first needs three failed transcriptions, so nothing ever
  retried the thing that had actually failed.

  Both preflight probes now retry three times with backoff. `lsof` exit 1 means
  "no matches" and is still passed straight through, so the common path costs
  exactly one probe. Preflight still fails CLOSED after the retries: it exists
  to prove no orphaned whisper owns port 8178, and spawning without that proof
  risks two owners.

- A surviving probe failure now names its own cause. The field failure logged
  only `Command failed: /bin/ps …` with empty stderr — identical output for a
  timeout kill, a non-zero exit, and a failed fork — which cost an
  investigation and still did not settle the mechanism (measured, this probe
  runs in ~45ms against a 2s timeout, so "it timed out" was never established).
  Errors now carry per-attempt elapsed time, `killed`, `signal`, `code`, and
  stderr, deduplicated so all three attempts survive the 240-character bound.

## 6.21.20

- Audio playback works at all. Every play button in the Control speaker review
  returned a 404 and made no sound, on every default install, since playback
  shipped. `res.sendFile` delegates to `send`, which defaults to
  `dotfiles: 'ignore'` and — with no `root` set — applies that policy to the
  WHOLE absolute path rather than to anything the request supplied. The default
  data home is `~/.cos-glasses/data`, and `.cos-glasses` is a dot component, so
  the file was found, confirmed to exist, then refused on the way out the door.
  All three audio routes were affected: meeting chunks, speaker-profile samples,
  and ext-audio samples.

  The tests could not have caught this. They point `COS_DATA_DIR` at
  `mktemp -d` — `/var/folders/...` — which cannot contain a dot component, so
  the suite was structurally incapable of reproducing a default install and
  stayed green while the feature was dead. The three routes now share
  `sendAudioFile`, and `send-audio.test.ts` serves from a dot-directory on
  purpose, over a real listener, asserting on the returned bytes.

## 6.21.19

- Review playback falls back to ext-audio. The 7-day archive introduced in
  6.21.18 is FORWARD-ONLY — it starts filling when a meeting is saved under that
  version — so on upgrade day the panel had no play buttons at all, which is what
  Miles hit. ext-audio already holds 72 hours of unrecognised-speaker audio keyed
  by the same raw capture index; measured across 14 real meetings, 90-100% of
  those files correspond to a chunk the sidecar labels `Ext`. That is exactly the
  set a reviewer most needs to hear.
- `GET /meeting/:id/audio` merges both sources and reports `archivedChunks` and
  `extAudioChunks` separately, because the windows differ (7 days vs 72 hours)
  and a single retention figure would be wrong for half the list.
- Published under its own version rather than re-cutting 6.21.18: that version is
  already on npm, and two different artifacts sharing a version number is a
  defect in its own right.

## 6.21.18

Everything a human needs to correct who spoke, and to hear the voice before
deciding. Four changes that landed together after Miles reviewed the 2026-08-06
Ditto meeting and found eleven attributed voices, most of them wrong.

- A NAME MUST BE EARNED. `identifySpeaker` accepts a match at 0.55, so one
  segment could arrive in the review panel wearing somebody's full name — Richard
  Jenkins on 1 segment at 0.60, Luke Henry on 1 at 0.55. Voices now carry
  `nameAsserted` plus `assertionBlockers`; below the floor a client must render
  "unidentified" and offer the label only as a scored candidate. Floors:
  similarity >= 0.65 AND >= 3 segments AND not thrashing. The owner gets no
  exemption.
- `timeline` ON THE REVIEW. Consecutive same-speaker spans with start/end, so a
  ribbon can be an actual timeline. The previous one drew a rectangle per voice
  sized by share of segments while labelled "who spoke, in order", so a voice
  that spoke twice appeared once and hover could report nothing true.
- POST /meeting/:id/deattribute — "this voice was NOT that person". Un-attributes
  it for ONE meeting and retracts the training samples that meeting contributed
  to that person's profile, so a false attribution stops reinforcing itself. It
  reports what it cannot reach: `train-g2` used to stamp a bare `g2-training`,
  discarding which meeting each sample came from, and now stamps
  `g2-training:<sessionId>`. Samples written before this are relabellable but not
  retractable.
- MEETING AUDIO KEPT 7 DAYS, 8 GB budget (Miles's call: review should survive to
  a weekend). Chunk WAVs previously died with the batch pipeline —
  `session-audio` held 0 files. Hard-linked at the single choke point before the
  rename, so it costs no extra disk and outlives the pipeline's cleanup. Sized on
  measurement: 3.1 h/day mean and 6.9 h peak make a week ~2.5 GB uncompressed, so
  the audio stays usable for re-transcription too. Retention sweeps expiry first,
  then evicts oldest whole sessions; a session whose age cannot be read is kept.
- Playback: `GET /voice/profiles/:name/sample` (needs no retention change — the
  training audio already existed, and playing a stored profile is what answers
  "is this really them"), `GET /voice/ext-audio/:id/sample`, and
  `GET /meeting/:id/audio/:chunk` which distinguishes "the window passed" from
  "that chunk is missing" and reports which chunks are playable.
- `/api/health` gains `review_audio`. `voice_provenance` from 6.21.17 already
  reports `noHumanSample`; on the live store that is 67 of 77 profiles.

FIXES FOUND BY QA BEFORE PUBLISH (nothing above ever shipped):

- PLAYBACK PLAYS THE RIGHT AUDIO. `Phrase` now carries the RAW capture index,
  resolved from the sidecar's `chunkEntries`. The compacted `chunks` array and
  the `chunk_NNNN.wav` numbering are different sequences: on the 2026-08-06 Ditto
  sidecar, 885 compacted chunks against raw indices 0..945 with 36 gaps, so array
  position 884 is raw chunk 940. Playing by position would have played a
  different speaker minutes earlier — on the one screen whose job is confirming
  who spoke. When the counts disagree no index is emitted at all, because a
  shifted index is worse than no button.
- THE OWNER IS EXEMPT FROM THE NAME FLOOR. The wearer is verified at exactly the
  floor (VERIFY_THRESHOLD 0.65), so they sat permanently on the boundary and any
  thrash pair flipped them: measured across the 2026-08-06 corpus, the owner row
  read "Unidentified voice" in 4 of 9 meetings, once with 285 of their own
  segments. `thrashesWith` still renders, so a mixed row is still visible.
- DE-ATTRIBUTION NUMBERS ITS LABELS. `Unidentified 1`, `Unidentified 2`, … rather
  than one shared `Ext`. Miles found five wrong attributions in one meeting;
  collapsing them into a single row would have destroyed his ability to tell
  those voices apart, which is exactly what playback is for next.
- DE-ATTRIBUTION DELETES THE ATTENDEE BULLET instead of renaming it. Renaming
  wrote an unidentified label into the attendee list as though it were a person,
  and every downstream reader takes that bullet at face value while the pipeline
  that BUILDS attendees deliberately excludes such labels.
- The timeline's LAST SPAN had zero width. `durationMs` frequently equals the
  final chunk's start exactly (both 5,783,732 on the Ditto sidecar), so the
  closing turn rendered as a sliver. The tail now takes one typical chunk of
  width from the meeting's own median gap — measured 7,034 ms where it was 0.
- De-attribute reports `markdownSkipped`, which relabel already did and it
  silently dropped. 39% of operations sidecars have no `.md` beside them, so the
  response claimed segment changes with no hint the document was untouched.
- `/api/health` no longer statSyncs every retained chunk on every poll. COS
  Control polls every 12s and a 7-day window is 2,000-3,000 files; stats are now
  cached for 30s and invalidated when retention actually removes something. The
  `/audio` listing reads the retention window as config rather than walking disk.

Requires COS Control 0.5.0+ to use the scoped correction and playback surfaces.

## 6.21.17

- Voice profiles now give up their WEAKEST sample, not their oldest. Eviction is
  by provenance tier — automatic, then unknown, then attendee-metadata, then
  identifier-labelled — and human-supplied samples (manual, ext-retroactive,
  g2-enrollment, correction) are protected.
- Measured on the live store before changing anything, not assumed:
  * 61 of 77 profiles were ALREADY at the 20-sample cap, so every correction
    cost a sample.
  * The owner profile driving owner detection read: fireflies 10, g2-training 9,
    unknown 1 — ZERO human-verified samples.
  * FOUR profiles at cap would have lost a human sample to plain FIFO while
    weaker samples sat untouched, including one whose only deliberate enrollment
    was its oldest sample with 17 weaker samples available.
- Cap raised 20 -> 40. Search latency measured at 1 us for 20, 40 AND 80 samples
  per speaker across 77 speakers, so the old cap defended nothing measurable.
  Twenty extra slots each is about 1.2 MB.
- Corrections are capped at HALF a profile. They come from the acoustically hard
  tail — the segments the identifier got wrong — so a profile of nothing but
  corrections has a centroid displaced from how the speaker actually sounds. At
  quota a new correction replaces the OLDEST CORRECTION, never a typical-voice
  sample.
- Every eviction logs which sample went and why; none disappear silently.
- `/api/health` gains `voice_provenance`: tier totals, profiles at cap, and
  `noHumanSample` — the profiles trained entirely on labels the system chose for
  itself. That number was previously invisible.
- An unrecognised or missing provenance string classifies as `unknown`, the
  weakest tier, never as trusted. A sample whose provenance was lost must not
  inherit the protection given to one a human supplied.

## 6.21.16

- `POST /api/meeting/:sessionId/relabel` — correct who a voice was in ONE
  meeting. Body `{ from, to, chunks?, confirm | dryRun, force? }`.
- Per-meeting by design, not a global merge. Miles: "changing it doesn't mean
  that all previous chunks should also be moved. It should be meeting by
  meeting, with the goal of hardening or refining the voice profiles." The
  identifier mishearing a voice in one room is not evidence that every past
  attribution was wrong.
- Fails closed like the other destructive endpoints: no `confirm` returns 400
  `confirmation required` with a full preview of what would change.
- THE LEDGER IS WRITTEN FIRST. An intent row lands before any file is touched,
  and a ledger that cannot be written aborts the correction with the files
  untouched — an unrecorded mutation is the failure this exists to prevent. A
  process dying mid-rewrite therefore leaves a visible pending correction, and a
  later correction on the same meeting refuses with 409 until `force`.
- A PARTIAL relabel (explicit `chunks`) never touches the meeting markdown.
  Measured on a real meeting: 135 sidecar chunks collapse to 46 speaker runs
  while the markdown carries 70 turns, and they disagree on who spoke — the
  transcript comes from a different segmentation pass, so there is no
  chunk-index-to-turn mapping. Rewriting by label there would relabel turns the
  human never selected. The response says why rather than staying silent.
- Narrative prose is NEVER rewritten — only reported as `proseStale` with the
  forms found. Verified on a real scribe: 6 of 12 speakers are referred to by
  bare first name in the summary, and with two Kyles, two Jacobuses and two
  Chrises in this org a first-name substitution would rewrite sentences about
  someone else. The confirmation message says this before a human commits.
- `/api/health` reports `speaker_corrections` (sessions, applied, pending,
  failed). `pending` is the one to watch.

## 6.21.15

- Persist the per-chunk voiceprint embedding, so a speaker correction can become
  training instead of only a transcript edit. `identifySpeaker` computed a
  192-dim embedding for every chunk, used it to pick a name, and discarded it —
  nothing downstream kept it, so a human saying "those six segments were
  actually me" had no acoustic evidence left to learn from. Embeddings now land
  in `chunk-embeddings/<sessionId>.jsonl`, keyed by chunk index, which is the
  join key to the existing chunk sidecar.
- This only works FORWARD. Meetings recorded before this ships can be relabelled
  but can never harden a profile, because their embeddings are already gone.
- `Ext` is deliberately included. An unidentified voice is the one case with no
  other route to being trained at all.
- RETENTION IS 14 DAYS, not the 8 hours used for audio snippets
  (`COS_CHUNK_EMBEDDING_TTL_DAYS` to change it). Two reasons, both worth Miles
  overriding if he disagrees: 8 hours cannot survive a weekend, so a Friday
  meeting could never be corrected on Monday; and an embedding is not audio — it
  is a non-invertible timbre vector that cannot be played back, so the privacy
  argument behind a short audio window does not carry across unchanged.
- Master switch `COS_CHUNK_EMBEDDINGS=0`. Default ON, because with it off a
  correction can never train anything. The write is append-only JSONL, never
  throws, and is skipped silently on failure: losing an embedding must never
  cost a chunk of transcript.
- Reject a wrong-DIMENSION vector on read rather than averaging it into a
  profile. A 64-dim row decodes perfectly cleanly and nothing downstream would
  notice, which is precisely why it needs an explicit gate.
- `/api/health` reports `chunk_embeddings` (sessions, bytes, TTL, oldest age) so
  the loop can be seen banking evidence rather than assumed to be.
- Size, measured not estimated: ~1.1 KB per chunk, so a 400-chunk meeting is
  under 500 KB.

## 6.21.14

- Carry `sessionId` on the COS operations meetings list as well. 6.21.13 added it
  to the standalone store's lister, but a COS install serves its list from the
  operations tree, so the field never appeared and every row was skipped as
  unreviewable.
- Resolve a speaker review from the operations tree first when it is configured.
  The same session exists in both trees under different names — the standalone
  store keeps the raw capture name, operations keeps the titled copy — and the
  list reads operations, so resolving the store first showed one title on the row
  and a different one in the panel for the same meeting.
- Report which tree a review came from, and search every domain rather than
  assuming personal.

## 6.21.13

- Carry each meeting's `sessionId` on the meetings list, so a Control row can
  open the per-meeting speaker review. The review is keyed on the session
  because that is what lets the store's own hardened lookup find the chunk
  sidecar again; without this field the two surfaces could not be joined.
- Read only the head of a sidecar to lift that one field. Sidecars run to
  megabytes, and reading them whole would make listing cost scale with total
  transcript size — and silently drop the id on any sidecar above the
  whole-file size cap.
- Omit the field rather than invent one when a sidecar is absent, corrupt,
  symlinked outside its month directory, or carries an implausible id. A
  meeting with no readable sidecar is still listed.

## 6.21.12

- Add `GET /api/meeting/:sessionId/speakers`, the read surface behind COS
  Control's speaker-naming panel. Read-only: it reports what a saved meeting's
  chunk sidecar already holds and never writes. Naming, merging, and rebuilding
  stay on the `/api/voice/*` routes, each with its own confirmation.
- Return two to three representative verbatim lines per voice, spread across the
  meeting and timestamped. These are the primary output: a similarity score
  cannot tell you who someone is, and a remembered sentence can.
- Report per-voice reliability from run length rather than similarity alone. Two
  labels that swap every few segments are the identifier oscillating mid-turn,
  which means those profiles cannot be told apart and any name applied to either
  would be a guess. A high similarity score does not override that verdict.
- Restrict the run-length comparison to each pair of speakers, so a third person
  interjecting cannot make two others look like they are swapping.
- Report a recovered meeting as unattributed rather than as a meeting with no
  speakers, and still return phrases for it — on those meetings the phrases are
  the only way in.

## 6.21.11

- Add `POST /api/voice/merge-profiles` for the case where one person holds two
  profiles. The sherpa manager registers one centroid per name, so a split
  identity has both halves competing on every search and each capped at twenty
  samples independently — a weaker representation than either half deserves.
- Refuse a merge whose centroid similarity falls below the search-accept
  threshold, since two profiles further apart than the value at which
  identification would match them are not one voice. `force` overrides and is
  recorded in the response.
- Preserve provenance through a merge and select the surviving samples for
  acoustic diversity, so capping the union keeps both profiles represented
  rather than silently discarding the absorbed one.
- Relabel the absorbed name's calibration history instead of deleting it: after
  a merge it is one person's history, and it is the only evidence for whether
  the merge improved identification.
- Refuse to absorb the owner label, which the live identification path checks
  first on every chunk.

## 6.21.10

- Make the voice profile store durable. `voice-profiles.json` is written
  atomically with rotating hourly backups, a corrupt file is quarantined and
  recovered from the newest usable backup, and a save can no longer replace a
  populated store with an empty one.
- Keep embedding provenance aligned. `sources[]` is now added, evicted, and
  repaired in lockstep with `embeddings[]`, and centroids use the modal
  dimension so a single wrong-length row cannot reduce a speaker's registered
  vector to NaN.
- Read saved speaker audio from the runtime data directory, matching where the
  transcription pipeline writes it. `train-g2`, `saved-audio`, `ext-audio`, and
  `enroll-ext` previously resolved a path inside the installed package and
  reported an empty system on every managed install.
- Require confirmation before an unscoped `train-g2` or `enroll-ext` rewrites
  profiles and deletes source audio, cap G2 training at ten diverse samples per
  speaker so a large backlog cannot evict an existing profile, and retain source
  audio whenever nothing was enrolled.
- Add `readiness.speakerId` to health. A voiceprint model that is installed but
  rejected by the runtime now reports degraded instead of passing as working
  diarization; an install with no model configured is unaffected.
- Expire saved training audio after 14 days per file, add a confirm-gated
  `POST /api/voice/delete-person` that reports per-store removal counts, and add
  `GET /api/voice/profiles` for review surfaces.

## 6.21.9

- Prevent an unclosed or abandoned recording from monopolizing progressive HQ.
  Each live session now receives one sealed window per FIFO turn, and sessions
  idle for 45 seconds yield only disposable checkpoint compute while preserving
  raw audio, recovery ledgers, completed checkpoints, and save behavior.
- Resume a yielded session automatically when a new canonical chunk arrives,
  and expose `paused_idle` in the progressive health snapshot for diagnosis.

## 6.21.8

- Decouple durable G2 sync identity from post-meeting HQ so a saved meeting can
  enter Operations immediately and be enriched in place when Large-v3 finishes.
- Add default-off progressive Large-v3 checkpoints for sealed 30-second meeting
  windows. Stop reuses only cache entries whose audio, context, model, and session
  identities still match; provisional text never becomes canonical on its own.
- Make progressive CPU admission tier-aware. Balanced is capped at two background
  threads for fanless M1/M2-class Macs; Max defaults to six and remains capped by
  available CPUs. Both stay global-single-flight, preemptible, and separately
  kill-switched from Early Sync.
- Publish requested/effective tier, thread policy, sealed-window progress, early
  sync outcomes, and durable finalization recovery through health for COS Control.

## 6.21.7

- Add a default-off, authenticated meeting-preview endpoint for private canaries.
  It accepts bounded, server-pinned audio snapshots and returns disposable
  Large-v3-Turbo text without creating or mutating meeting sessions.
- Keep canonical Large-v3 transcription, speaker attribution, recovery, save, HQ
  polish, and indexing unchanged. Preview never falls back to the canonical worker
  and drops under canonical Metal contention.
- Reject stale server pins and oversized bodies before inference, recheck
  maintenance admission after slow uploads, and drop concurrent preview work rather
  than building a latency queue. `COS_WHISPER_MEETING_PREVIEW=1` is required.

## 6.21.6

- Make server-owned durable query jobs the default so accepted replies keep
  running through phone backgrounding, WebView reloads, and network handoffs.
- Preserve `COS_DURABLE_QUERY_JOBS=0` as the machine-wide rollback. Existing
  accepted jobs remain recoverable and cancellable while new prompts use the
  legacy streaming path.
- Publish the capability truth through authenticated health/model surfaces so
  COS Control and the companion can independently enforce machine and device
  preferences without changing the proven two-step cancel gesture.

## 6.21.5

- Drop the narrow Large-v3 stock-caption artifact family beginning with
  “closed captioning provided by” from prompt dictation.
- When that exact HQ artifact occurs, retain the already-validated Fast
  transcript for the same audio and report the result as degraded instead of
  saving either the caption credit or an empty gap. All other HQ and no-speech
  paths are unchanged.

## 6.21.4

- Preserve validated phone-photo references on Claude and Codex conversation
  exchanges so Recent Glasses and message-history clients can recover the
  original visual context instead of receiving a text-only marker.
- Recover validated refs at read time from the durable media association index,
  keyed by exact session ID, global message number, and message era. Pre-6.21.4
  unversioned refs are recovered only for the active era when both creation and
  association occurred after its boundary; ambiguous historical refs fail
  closed rather than risking the wrong photo.

## 6.21.3

- Route Max-tier provisional dictation preview through the resident Turbo
  preview sidecar while keeping authoritative live commit and saved-work
  polish on Large-v3. This corrects the 6.21.0 behavior that made cosmetic
  preview pay Large-v3 latency.
- Give canonical transcription strict GPU priority. A cosmetic preview is
  dropped or aborted when canonical/HQ Metal work begins, and preview failures
  remain outside the Whisper circuit breaker and all persistence paths.
- Report the effective Max lanes truthfully as Turbo preview, Large-v3 commit,
  and Large-v3 polish. Balanced remains Small.en preview, Turbo commit, and
  Large-v3 polish.

## 6.21.2

- Cache Python, Claude, Codex, and Cursor process probes for 30 seconds so the
  public health endpoint remains cheap under frequent phone diagnostics. Stale
  static versions are served while one background refresh runs; live recovery,
  transcription, TTS, maintenance, and request fields remain fresh.
- Parse Cursor's actual `CLI Version` line instead of reporting the About
  heading. Authenticated model discovery continues to be the authoritative
  Cursor readiness signal.

## 6.21.1

- Make the transactional Claude readiness proof explicitly use Haiku instead
  of inheriting a user's heavyweight default model. The no-tool proof now has
  a 45-second bound, while normal COS queries keep their selected models.
- Preserve timeout and cancellation reasons across the provider-process close
  race. A timed-out proof now reports `provider proof timed out` instead of the
  misleading `provider process exited before launch`.

## 6.21.0

Transcription quality is now a machine-owned, observable two-tier policy.

- **Balanced and Max tiers.** Balanced keeps Small.en as a cosmetic prompt
  preview, Large-v3-Turbo as the authoritative live commit model, and Large-v3
  for saved-work polish. Max reuses the resident Large-v3 worker for preview
  and commit; it never starts a third Whisper process.
- **Safe Large-v3 fallback.** A requested Max tier degrades visibly to Turbo
  when the Large-v3 weights are unavailable. Immutable Turbo and Large-v3
  paths remain independently addressable for fallback and HQ work; health also
  warns when Max is active but its immutable Turbo recovery weights are absent.
- **Preview isolation.** Small.en previews no longer receive decoder-bias
  vocabulary and still cannot write recovery state or replace committed text.
  Startup reaps only an exact stale Small.en/8177 worker before spawning its
  owned child; an unrelated listener is never contacted with audio or killed.
- **Truthful health.** The existing
  `capabilities.transcription.live` block now reports requested/effective tier,
  requested/effective commit model, downgrade reason, and preview prompt policy
  without exposing local file paths.
- **Guided provisioning.** `--setup-transcription --transcription-tier
  balanced|max` provisions only the models required by the selected tier plus
  the immutable Turbo fallback and Large-v3 HQ model.

## 6.20.1

Adaptive setup now survives the slow or interrupted downloads that exposed the
first public 6.20.0 install to a false-success state.

- **Resumable model downloads.** Whisper model downloads retain their `.partial`
  files, resume with HTTP range requests, retry transient network errors eight
  times, and use one-hour bounds for Small.en/Turbo plus a two-hour bound for
  Large-v3. A rerun continues from the last byte instead of restarting at zero.
- **Truthful guided setup.** `--setup-transcription --prepare-only` exits nonzero
  and names any missing lane instead of printing “setup complete” after a model
  download failed. Existing Turbo transcription remains the safe runtime
  fallback while setup is incomplete.

## 6.20.0

Adaptive transcription makes fast feedback additive instead of a quality
trade-off. The preview lane can be fast without changing the transcript that is
saved, searched, or sent.

- **Three explicit local transcription lanes.** Prompt previews can run on a
  dedicated Small.en sidecar, committed live text remains on
  Large-v3-Turbo, and HQ polish remains on Large-v3. The existing phone
  `provisional` contract is unchanged. A late or failed preview cannot replace
  committed text or advance the recovery ledger.
- **Safe adaptive fallback.** `COS_WHISPER_PREVIEW_MODEL` accepts `auto`,
  `small.en`, `turbo`, or `off`. `auto` uses Small.en only when provisioned;
  otherwise it preserves the prior Turbo behavior. A Small.en failure falls
  back to the non-circuit Turbo path and cannot trip or success-reset the
  authoritative Whisper breaker. The early private
  `COS_WHISPER_REALTIME_MODEL` name remains a migration alias.
- **No surprise on update.** An unset preview setting keeps the pre-6.20 Turbo
  behavior. Guided Setup explicitly opts users into Small.en after provisioning
  its weights.
- **One setup command.** `--setup-transcription` records the adaptive choice
  and provisions Small.en preview, Turbo commit, and Large-v3 HQ weights.
  Pair with `--prepare-only` for COS Control so provisioning exits before the
  managed LaunchAgent takes ownership.
- **Truthful health.** `/api/health` and `/api/models` add path-free
  `capabilities.transcription.live` and `.profile` blocks alongside the
  existing `.hq` block. COS Control can report the effective preview, commit,
  and HQ models independently.
- **Factory vocabulary can no longer reduce accuracy.** The shipped profile is
  empty and safe. Existing `Your Name`, `NameOne`, `NameTwo`, `YourCompany`,
  `ProductName`, and `Soundalike -> YourName` examples are ignored everywhere
  decoder bias or correction data is consumed. Startup warns once, and health
  reports the ignored count. Real terms are trimmed and deduplicated.
- **Correction keys are literal.** User correction keys are escaped before
  regular-expression construction, so punctuation in names cannot alter the
  matcher.

## 6.19.0

Meeting audio is evidence. This release stops the server from ever deleting an
unsaved capture, and makes batch status stop lying about finished work.

- **Unsaved-capture quarantine (the 2026-08-01 data-loss fix).** The
  session-audio purge (boot sweep + 60s interval + non-saved session close)
  DELETED any directory not tracked in memory once the 4h idle retention
  passed — an offline meeting whose deferred save never landed lost its
  full-fidelity audio within a minute. Two real meetings were destroyed this
  way on 2026-08-01; only speaker-enrollment fragments survived. Audio-bearing
  directories are now MOVED to `data/unsaved-audio/` with a manifest, never
  deleted in place. Empty directories are still cleaned. A failed quarantine
  move leaves the source untouched. Quarantine expires on
  `COS_UNSAVED_AUDIO_RETENTION_HOURS` (default 72, clamped 1–720) — the only
  place quarantined audio is ever deleted.
- **Unsaved captures are visible.** `/api/health` gains `unsaved_captures`
  (count + compact items, same exposure level as `meeting_sync`). The
  authenticated `GET /api/meeting/orphans` returns full detail.
- **Miles-triggered recovery, surface-only by decision (2026-08-02).**
  `POST /api/meeting/orphans/:sessionId/recover` batch-transcribes the
  quarantined WAVs (same segment/enhance/Metal-preempt contract as HQ polish,
  under a new `orphan_recovery` maintenance lease), writes a durable scribe,
  and hands off to operations when the COS pipeline is configured. Idempotent
  via the save-receipt short-circuit; the server never drives recovery on its
  own, and audio stays in quarantine until the retention clock — a failed
  recovery is retryable.
- **Rejected HQ batches release their status.** A terminal batch outcome
  (rejected quality, pipeline failure, accepted-but-unpersisted) now writes
  `_batch_terminal.json` next to the retained WAVs. `meeting_sync` reports
  those as `retained` — never as active work — so a rejected batch no longer
  shows "HQ polish · N chunks" with `blocksRestart: true` for the 12h WAV
  retention after the work already finished (observed on
  meeting_1785695339502_mvqm0p, reason `repetitive-output`). A retry clears
  the terminal record; live progress always wins. `meeting_sync.retained` is
  additive — older consumers ignore it.
- Deferred by design: the realtime-model fallback port (W3) ships in its own
  release. The app-side module has diverged ~1,100 lines from this repo's
  whisper path; transplanting it alongside the data-loss fix would couple the
  release's safest change to its riskiest. No default flips either way.

## 6.18.8

- **Prompt draft peeks for live ASR.** `POST /api/prompt-drafts/:draftId/peek`
  runs Turbo locally, emits `prompt_transcript` with `provisional: true` +
  `peekGen`, and does **not** advance the recovery ledger. Drop-on-busy,
  `learnInline=false`, and `affectsCircuit: false` so peeks cannot trip or
  success-reset the Whisper breaker.
- **Interactive HQ keeps short utterance heads.** Compose HQ skips light
  enhance (highpass was truncating "device, just for…") and omits CLI `--vad`
  as defense-in-depth. Meeting/batch HQ paths unchanged.

## 6.18.7

- **Phone Restart no longer leaves the server Stopped.** Control LaunchAgent
  KeepAlive is `SuccessfulExit: false`, so the old SIGTERM→exit(0) path never
  came back — phone showed "Restart requested; reconnect is taking longer than
  expected" while Control sat at Stopped. Restart now `launchctl kickstart -k`
  (fallback `exit(1)` so KeepAlive still fires).

## 6.18.6

- **Phone Restart works on COS Control managed installs.** Recovery status /
  `/api/recovery/server/restart` previously required `COS_HARNESS=daemon`, but
  Control's LaunchAgent sets `COS_MANAGED=1` with `COS_HARNESS=foreground`.
  Health correctly advertised `managed: true` while the restart route returned
  409 "Server is not managed by the COS LaunchAgent". Gate now uses
  `COS_MANAGED=1` (`isManagedRuntime()`), matching capabilities.

## 6.18.5

- **Codex workspace-write now includes outbound network.** `workspace-write`
  alone still blocked HTTPS (Gmail API, etc.) because Codex defaults
  `sandbox_workspace_write.network_access` to off. When
  `COS_CODEX_SANDBOX=workspace-write`, the managed server now passes
  `-c sandbox_workspace_write.network_access=true` and the capability header
  states HTTPS is available. Pair with the same key in `~/.codex/config.toml`
  for interactive Codex CLI. Still not `danger-full-access` — writes stay
  inside the workdir. Prefer COS `email_cache` / `email_gmail_api` over
  approval-gated Google Workspace connector sends from glasses.

## 6.18.4

- **Meeting sync progress on `/api/health`.** Post-meeting HQ polish writes
  `_batch_progress.json` under `pending-batch/<meetingId>/` and publishes
  `meeting_sync` on health (`active`, `percent`, `label`, `blocksRestart`,
  per-meeting rows). COS Control 0.3.0+ shows this as a status row so Update /
  Restart drain is no longer a black box during long Whisper batch jobs.

## 6.18.3

> Ships as 6.18.3. There is no published 6.18.2 — that version number was bumped
> past mid-development and never released to npm, so everything below reaches
> users for the first time in 6.18.3.

- **Heads up: Claude-path glasses queries will now actually use shell and file
  tools.** They always had permission — `--dangerously-skip-permissions` has been
  the launch flag for a long time — but the misleading header below was talking
  them out of it. With the header corrected, a voice query on the Claude/Opus
  path can genuinely run `Bash` and `Edit`/`Write` on your Mac. That is the
  intended behavior and what makes the glasses useful, but it is a real change in
  what you will observe. To genuinely restrict it, set
  `COS_CLAUDE_TRUST_MODE=allowlist`, which denies every undeclared tool without
  prompting.
- **The tool-capability header now describes the permission mode the CLI actually
  ran with.** Every model got the same "configured with only these tool selectors"
  string, including the Claude/Opus agent path — which runs
  `--dangerously-skip-permissions --allowedTools <list>`, where that list is an
  *auto-approve hint*, not a restriction. Sessions read it as a capability
  inventory, refused work they could do, and invented downstream outages to
  explain the refusal (2026-07-28 G2 incident; repeated 2026-07-29 in a
  good-morning run that claimed DNS, bot-memory, and filesystem were blocked
  when none of them were). The header is now mode-derived: the trusted agent
  path states plainly that Bash, Read/Edit/Write, Skill, git, and every connected
  MCP are available regardless of any list (COS scripts only when
  `COS_SCRIPTS_DIR` is a real directory — see next bullet), and instructs a
  PROBE before any claim of absence.
- **The header only promises what the install actually has.** The trusted contract
  names Bash, Read/Edit/Write, Skill, git, and every connected MCP unconditionally,
  but the COS Python pipeline is named ONLY when `COS_SCRIPTS_DIR` points at a real
  directory — the variable is optional and unset on a standalone install, which is
  most users. Promising a pipeline that is not installed is the same defect as
  denying tools that are: either way the session trusts the header over reality.
  The same gate applies to the read-only contract, so a Cursor ask-mode session no
  longer both denies script runs and claims COS scripts are reachable in
  consecutive sentences. The read-only escalation target no longer names the
  surface it is running on.
- **The read-only slots finally say so, and only they do.** Cursor ask-mode
  (grok / composer) previously got no contract at all, and Codex/GPT got none
  either despite running `codex exec --sandbox read-only` by default. Both now
  carry an honest read-only contract naming what is actually denied and offering
  to re-run on an agent model. Cursor agent-mode and
  `COS_CODEX_SANDBOX=workspace-write` get the agent contract instead.
- **The header now says MCP tools load lazily.** The pre-approved selector list
  never contains MCP names — they are deferred and fetched on demand — so a
  session that read the list as an inventory concluded connectors were down. The
  trusted header now states that an absent MCP name means "not fetched yet", that
  ToolSearch is the way to check, and that mid-session connecting/disconnected/
  reconnected reminders are local tool-catalog churn rather than evidence about
  the service. Observed live 2026-07-29: all 529 MCP tools dropped and returned
  inside a single turn while every server stayed healthy. The read-only contract
  carries the same clause, scoped to reads.
- **The anti-fabrication clause is now shared and unconditional.**
  `TOOL_HONESTY_CLAUSE` is exported once and appended on all four paths: report
  the failure of YOUR call and stop there; "my request could not reach X" is the
  finding, "the X service is down" is fabrication.
- **Fetched content is data, not commands.** A separate
  `UNTRUSTED_CONTENT_CLAUSE` rides on every capability path — Claude trusted and
  allowlist, Cursor ask and agent, Codex read-only and workspace-write. The
  honesty clause governs accuracy *after* a failure; this one governs judgment
  *before* acting on tool output, web pages, files, transcripts, or meeting
  text. Confirm before anything destructive or outward-facing. The trusted-body
  blanket was also narrowed from "never refuse or hedge" to "never claim a tool
  is unavailable" so availability honesty does not read as a safety override.

## 6.18.1

- **Post-meeting HQ polish can use the GPU when nothing live needs it — opt-in.**
  6.14.1 stopped batch polish from fighting a live meeting for Metal by pinning
  it to CPU forever, which also taxed every idle polish. The device is now
  chosen per segment: Metal only when `COS_BATCH_HQ_METAL=1` **and** nothing
  live is contending. **Default is unchanged (always CPU)** until a
  meeting-to-meeting smoke passes on real hardware; `COS_BATCH_HQ_FORCE_CPU=1`
  remains the blunt rollback and wins over everything.
- **Live always wins the GPU, and a preempted segment is never half-saved.**
  A meeting starting mid-batch preempts the Metal child two ways: on new
  session creation (create only — an ordinary status read of a stale session
  must not evict a healthy batch) and on `recording_chunk` lease acquire, which
  covers recovery/reconnect paths that skip creation. The interrupted output is
  **discarded unconditionally** — checked before the exit code, because SIGTERM
  can race to a zero exit with partial stdout — and the same segment is retried
  once on CPU, which cannot itself be preempted. A truncated transcript is
  never written into a saved meeting; slow or failed beats silently wrong.
- **Waiting is distinguished from wedging.** A session counts as live only if
  it was active within 180s. A cold orphan cannot pin batch to CPU — an
  `active-sessions` entry sat untouched for 3+ hours on 2026-07-27, and an
  "any session in the map" rule would have disabled the GPU path permanently
  and silently. Prompt ASR and one-shot transcription count as contending
  (same Metal family), and a second Metal batch never starts while one is in
  flight. A failing liveness probe fails safe to CPU.
- Every batch segment logs `device`, `reason`, and `metalEnabled`, so "why was
  polish slow today" is answerable after the fact.

## 6.18.0

- **G2 save → operations sync restored on the managed public server.** After
  `meeting/save` (+ HQ batch when present), the server stages the durable
  recording into `operations/personal/meetings/` with pipeline markers and runs
  `sync_meetings.py --g2-only --g2-file` (same enrichment runner as the private
  app). Without this, Control installs finished HQ locally but never wrote
  `(G2)` scribes into COS — Jul 27 regression after the 6.17.0 managed cutover.
  Pending-batch TTL raised to 12h and skips purge while a batch lease is held.
- **Live Cues (opt-in): live meeting coaching on the lens.** With
  `COS_LIVE_CUES=1` and the companion's Live cues toggle On, a live meeting
  runs transcript window → Composer planner → Qdrant → Composer insight → a
  `coaching_nudge` flash on the glasses. Requires the full COS pipeline
  (`COS_SCRIPTS_DIR`) plus the Cursor Agent CLI; Composer 2.5 is the only
  supported cue model and anything else fails closed.
- **The LightRAG graph hop ships OFF, on measured evidence.** Across 5 real
  `--explore` calls against a 31k-entity / 66k-relationship graph: p50
  **73.5s**, max 117.2s, min 14.8s — only 1 of 5 finished inside the 40s hop
  budget. Left on by default it would spend 40s of the 60s pipeline wall plus
  two calls from the shared 200/day query pool to produce a degraded cue about
  80% of the time. `COS_LIVE_CUES_GRAPH=1` opts in after you time your own
  graph. Graph-off is a configured normal, not a degradation, so it renders no
  mark; cues still get memory grounding from Qdrant in ~1.5s.
- **Cost containment is structural, not advisory.** Per-meeting cap (8
  pipelines), single-flight, 60s floor, 30s cooldown, a 60s pipeline wall
  (deliberately under COS Control's 90s drain window), a consecutive-failure
  breaker, a persisted weekly Composer ceiling, and a LightRAG reserve that
  stops graph hops while fewer than `COS_LIVE_CUES_LIGHTRAG_RESERVE` calls
  remain in the shared 200/day query pool. Every skipped pipeline logs its
  reason — a silent cap is treated as a defect.
- **Zero side effects on existing paths.** Cue asks use a dedicated Composer
  spawn: no conversation history, no Cursor run-ledger entries, no Telegram
  notifications, and token audit under its own `live-cues` source so `g2-query`
  keeps measuring only real user queries. Transcription never awaits the
  pipeline. Cues degrade honestly: a cue produced without graph grounding
  carries `degraded` + a reason, and Cursor's exit-0 auth failure output is
  detected rather than rendered as a cue.
- **Health truthfulness.** `features.liveCues` plus `capabilities.liveCues`
  (`{ available, reason }`) publish from one helper on BOTH `/api/health` and
  `/api/models`, with user-safe reasons only. Config lives in
  `~/.cos-glasses/.env` — never the LaunchAgent plist, which COS Control
  rebuilds from its manifest. Kill switch: `COS_LIVE_CUES=0` + restart.

## 6.17.0

- **Speaker diarization is now a bolt-on any install can enable.** The ~26 MB
  voiceprint model stays out of the npm package, but the loader no longer looks
  only inside the package (where a managed install has no copy, and where a
  hand-placed one is destroyed by the next update). Resolution order:
  `COS_SPEAKER_MODEL_PATH` → `~/.cos-glasses/models/` → bundled `server/models/`
  (source checkouts). Put the model in `~/.cos-glasses/models/` and restart.
- **A bad model file can no longer take the server down.** onnxruntime aborts
  the process on a malformed or mismatched model rather than throwing, which
  under a KeepAlive LaunchAgent became a permanent restart loop that killed
  queries, meetings, and transcription over an optional feature. The file is now
  screened structurally and loaded in a throwaway child process first, so a
  truncated download or an HTML error page saved as `.onnx` disables diarization
  and nothing else.
- **`/api/health` reports `speaker_id`** as `active` / `unavailable` / `error`,
  so a server running without voiceprints is no longer indistinguishable from
  one doing real diarization. `error` means a model is installed but the runtime
  rejected it.
- **Profile config is read from the data home.** `.cos-profile.json` is now
  loaded from `~/.cos-glasses/` when present, ahead of the package-root copy.
  Managed installs previously resolved it inside the generation directory, where
  no profile exists and every field silently took its default — losing
  transcription vocabulary, whisper corrections, and the wearer label.
- **`/api/voice/enroll` and `/api/voice/status` no longer hardcode `MU`.** Both
  use `owner_speaker_label` (default `Me`), matching what identification already
  used. **Upgrade note:** an install that enrolled under the old default holds a
  profile named `MU`; `/api/voice/status` will report `enrolled: false` until you
  set `owner_speaker_label` to `MU`. Do that rather than re-enrolling, which
  splits one voice across two profiles.

## 6.16.9

- **Message-era reset visible to a running server.** `currentMessageEraState`
  re-reads `message-era.json` when mtime changes, so
  `reset-message-era.ts --confirm` (separate process) is picked up without
  depending on a stale in-memory `legacy` cache. Restart still recommended
  so live sessions stop serving pre-reset stamps; reset script prints verify
  steps.

## 6.16.8

- **Per-exchange model stamps on managed installs.** History badges were
  defaulting to Opus whenever the server pair had no `modelPreference`
  (Jul 19 `#228`–`#231` archives are unstamped — client `DEFAULT_MODEL`).
  Bridges now stamp the actual run model on each exchange; archive +
  today/all-messages emit via `resolveExchangePairModel`. Unstamped
  legacy rows stay unlabeled server-side (phone still defaults those to
  Opus — cannot invent Grok without evidence). New Cursor/Codex/Claude
  turns keep truthful badges after reconnect/merge.

## 6.16.7

- **Message-number era reset on managed public installs.** Companion burn
  fixes never lowered the archive ceiling (`/api/message-counter` still
  reported `max: 17931` with no `era`). Ported `message-era` under
  `~/.cos-glasses/data`, era-scoped counter + lookup, stamp `messageEra` on
  exchanges, and `409 message_era_mismatch` on legacy `/api/query` + durable
  admission after a reset. Ops: `npx tsx server/scripts/reset-message-era.ts
  --confirm`, restart LaunchAgent, phone reconnect → live list clears and
  numbering restarts near #1. Archives retained.

## 6.16.6

- **HQ finalize no longer loses to late Fast warm.** Fast warm and speculative
  HQ warm share `warmTranscripts[chunk]`; a slow turbo decode could overwrite
  large-v3 after HQ had already won. Warm/final writes are quality-monotonic
  (hq > cloud > fast) for the same audio hash. Finalize reuses HQ/cloud only;
  when Settings HQ is available, a degraded turbo warm is retried with
  `automatic` instead of becoming the finished-chat question text.

## 6.16.5

- **Welcome weather restored on managed installs.** Ported authenticated
  `GET /api/welcome-context` (Open-Meteo + reverse-geocode). Phone sends
  `lat`/`lon` from Even Hub geolocation; Mac never invents a home city.
  Without coords: last process coords → optional `COS_WEATHER_DEFAULT_*` →
  omit weather. New coords await reverse-geocode (3s) before first JSON so
  the city label is not stale. Calendar `nextEvent` stays optional via the
  COS python bridge with public-safe OOO filtering only.

## 6.16.4

- **Cursor Agent on legacy `/api/query`.** 6.16.3 only forwarded
  `cursorExecutionMode` on durable jobs. Most installs still run with
  `durableQueryJobs: false`, so the companion fell back to `/api/query` and
  Cursor stayed Ask (Shell Rejected). Legacy route now accepts the field;
  Cursor omit/unknown defaults to **agent** (Settings default). Explicit `ask`
  still forces read-only. Durable runtime uses the same default.

## 6.16.3

- **Cursor Agent mode on durable jobs.** Glasses Settings → Agent now reaches
  the CLI (`--force` / no `--mode ask`). Public 6.16.1–6.16.2 accepted Cursor
  models but dropped `cursorExecutionMode` before query-job execution, so every
  turn stayed Ask and Shell was Rejected. Parse + forward `agent`|`ask`; omit
  still defaults to ask for old clients.

## 6.16.2

- **COS operations meetings library.** G2 Review Meetings can list markdown from
  a configurable COS `operations/` tree via `COS_OPERATIONS_DIR` /
  `COS_MEETINGS_ROOT`, with fallback to `COS_SCRIPTS_DIR/..`, then standalone
  recordings. Opt-in per install — no hardcoded COS layout.

## 6.16.1

- **Cursor Agent models (Composer 2.5 / Grok 4.5).** Managed installs now ship
  the Cursor bridge, model catalog, engine sessions, and run ledger. `/api/health`
  advertises `features.cursor` + `cursor_models`; authenticated `/api/models`
  merges Cursor slots with Codex. Fail-closed: unresolved Cursor never falls
  through to Claude/Codex.
- **Cursor-complete setup and diagnostics.** The public launcher now accepts a
  Cursor-only installation after `agent models` proves both slots, including the
  `~/.local/bin/agent` fallback used by launchd. Authenticated CLI diagnostics
  include redacted Cursor run state alongside Claude and Codex.
- **Silero VAD in the npm tarball.** `.npmignore` previously excluded
  `server/models/`, so managed 6.16.0 ran with `silero_vad: disabled` and
  untrimmed audio. Package now ships `server/models/silero_vad.onnx`.
- **HQ path retained.** Speculative HQ warm + interactive beam/light enhance from
  6.15.5/6.16.0 remain the default Render path.
- **Public-package boundary.** The tarball contract excludes runtime data,
  certificates, tests, operator-specific paths, and operator-specific names.

## 6.16.0

- **Truthful HQ results.** An HQ request is reported as HQ only when the full
  local large-v3 decoder actually ran. Turbo, real-time server, long-audio, and
  decode-error fallbacks now retain the requested mode while returning their
  actual quality, backend, degradation flag, and bounded reason code.
- **HQ capability health.** `/api/health` and `/api/models` add a path-free
  `capabilities.transcription.hq` block with availability, model, backend, and
  a user-safe missing-prerequisite reason. Generic Whisper liveness no longer
  implies that large-v3 HQ is installed.
- **Phone-visible fallback telemetry.** One-shot transcription and prompt-draft
  finalize responses expose the same additive quality fields. Draft finalize
  aggregates the records it actually used and reuses a successful degraded
  warm result instead of paying for an identical second turbo decode.
- **Default unchanged.** Absent an explicit Fast request, prompt dictation still
  requests HQ. `COS_HQ_SPECULATIVE_WARM=0` remains the immediate warm-path
  rollback, and meeting batch beam/isolation behavior is unchanged.

## 6.15.5

- **Speculative HQ warm (no EHPK).** While a prompt-draft chunk is acknowledged,
  Fast warm still paints the HUD and, when Settings HQ is active (default), a
  background large-v3 warm overwrites `warmTranscripts` with `actualQuality=hq`
  under `local-only` (never OpenAI mid-speak). Finalize reuses that cache so
  Render is dominated by the last unfinished chunk, not a cold full re-decode.
  Killswitch: `COS_HQ_SPECULATIVE_WARM=0`.
- **Finalize dedupe.** In-flight HQ warm and finalize share one decode via a
  purpose-agnostic job key so Render cannot start a second large-v3 while warm
  is still running.
- **Interactive HQ latency knobs.** Interactive beam defaults to 2 (meetings
  keep beam 5); short clips (&lt;15s) use light ffmpeg enhance (highpass only).
  Env: `COS_HQ_BEAM_INTERACTIVE`, `COS_HQ_ENHANCE_LIGHT_MAX_SEC`.

## 6.15.4

- Start Whisper, Kokoro, model discovery, and local audio prerequisites while
  a managed successor remains behind the authenticated maintenance gate. Start
  durable recovery, session warming, snapshots, and media GC exactly once after
  the controller releases admissions, so routine restarts cannot strand local
  services or prematurely mutate durable state.
- Bound Whisper process and port inspection to two seconds per probe, move it
  off the Node event loop, expose startup phase/error diagnostics, and only reap
  processes whose executable is actually `whisper-server` with the COS model
  and port signature.
- Migrate legacy bare MCP server selectors to `mcp__server__*` and warn once for
  rejected local/invalid selectors without relaxing the safe tool boundary.
- Terminate abandoned, timed-out, start-failed, and ownership-lost provider
  runs without orphaning tool subprocesses. Termination targets the detached
  process group, escalates from SIGTERM to SIGKILL, and releases lifecycle
  ownership only after Node observes process close. Control's provider proof
  uses the same process-owned cancellation boundary.
- Expose persistent Whisper prerequisite state separately from batch-only CLI
  availability, plus an additive readiness summary so HTTP-200 liveness cannot
  hide a configured local subsystem failure.
- Keep the stable `unauthorized` error code while adding non-secret guidance to
  copy and paste the complete pairing token from COS Control.

## 6.15.3

- Make `COS_WORKDIR` the authoritative Claude, Codex, and Cursor workspace.
  Legacy provider-specific and `COS_SCRIPTS_DIR` paths remain compatibility
  fallbacks, so pipeline scripts can stay separate from the agent workspace.
- Add workspace-precedence coverage for migrated LaunchAgent environments.

## 6.15.2

- Validate the inherited Kokoro Python runtime before skipping bootstrap, so a
  stale Python 3.13 or partial venv is repaired during a normal managed update.
- Retry failed Kokoro cold starts with bounded exponential backoff instead of
  latching local speech unavailable until the whole server restarts.
- Add explicit MCP selector/config support to both Claude query paths and tell
  the model the exact permission selectors without fabricating connector
  health, authentication, or handshake machinery.
- Add an authenticated, boot-cached transactional provider proof for COS
  Control. It performs a real no-tool model turn and exposes no provider output
  or credentials.

## 6.15.1

- Fix prepared TTS playback for native audio clients by allowing only
  `GET`/`HEAD /api/tts/play/<UUID>` through the global API-token boundary. The
  authenticated prepare route mints a random, audio-scoped capability that
  expires after 60 seconds; all other TTS routes remain token-protected.
- Fix Kokoro first-run provisioning by selecting only Python 3.11 or 3.12,
  the actual compatibility intersection of the pinned `numpy` and `misaki`
  dependencies. Python 3.13 is no longer advertised or selected.
- Reject an incompatible `COS_TTS_BOOTSTRAP_PYTHON` before installation and
  automatically rebuild stale or partial TTS virtual environments instead of
  repeatedly failing inside pip.

## 6.15.0

- Add local-first spoken reply playback through a Mac-owned Kokoro sidecar on
  Apple silicon. The existing OpenAI TTS path remains available as an explicit
  engine choice and as the bounded fallback for `local_first` only when a key
  and budget are available.
- Preserve cancellation across the local synthesis boundary so abandoned
  requests return 499 and can never become accidental cloud fallbacks. An
  explicitly selected local engine fails closed when Kokoro is unavailable.
- Keep cache entries and resumable sessions engine-aware, expose additive
  `tts_local` and voice-engine health, and announce a real Kokoro-to-OpenAI
  fallback only after cloud audio succeeds.
- Bootstrap the pinned private Python environment asynchronously on first run,
  avoiding an API event-loop stall while dependencies install. The local
  sidecar is limited to Apple silicon macOS; other hosts retain their existing
  OpenAI behavior.
- Add opt-in, public-safe pronunciation overrides through
  `COS_TTS_PRONUNCIATIONS_JSON`. The published package contains no personal
  pronunciation dictionary or machine-specific path.

## 6.14.2

- Restore timed words on post-meeting CPU polish only: whisper-cli `-ojf`
  token offsets feed speaker-word mapping after save. Live ASR stays on
  compact `json` (no `verbose_json`); VAD-empty CLI windows return empty
  transcription safely without reintroducing the live daemon crash.

## 6.14.1

- Keep real-time `large-v3-turbo` stable on VAD-empty audio by using
  whisper-server compact JSON instead of the nullable `verbose_json` language
  path that can crash native whisper.cpp.
- Prevent long sessions from stalling on unread native output by discarding
  whisper-server stdout and stderr under the existing owner-safe supervisor.
- Isolate meeting-save full `large-v3` polish from live Metal inference by
  running batch HQ on CPU with eight threads. Interactive HQ retains GPU speed.
- Reap timed-out HQ children before the queue advances, with SIGKILL escalation
  if SIGTERM does not exit within two seconds.

## 6.14.0

- Add voice (TTS + speaker) and additive glasses routes to the public server: `tts`, `voice`, `glossary`, `handoffs`, `recovery`, `prompt-edit`, `bookmarks`. Brings server-side voice + companion utilities to public installs; COS-integration routes remain private.

# Changelog

## 6.12.7

Pairs the public server with COS Glasses build 227+ meeting follow-ups while
preserving every existing meeting response field and legacy client contract.

- **Meeting follow-ups receive canonical source context.** Authenticated
  meeting-detail responses now add `sourceContent` and `sourceTruncated`, so
  the glasses can attach the actual meeting record before a follow-up query.
- **Bounded and UTF-8 safe.** Source context is capped at 100 KB without
  splitting a multibyte character. Existing summary and transcript fields are
  unchanged.
- **Backward compatible.** Older clients ignore the additive fields; newer
  clients no longer display the server-update warning on public installs.

## 6.12.6

Pairs with COS Glasses build 222 to harden local-first meeting recovery and
local Whisper supervision while preserving the existing public API surface.

- **Meeting work stays on its admitting Mac.** Capability-aware clients pin
  upload, status, and save requests to one `serverInstanceId`; a mismatch fails
  before audio is consumed. Legacy unpinned clients continue to work.
- **Receipt is not transcription.** Durable ledgers distinguish raw audio
  receipt, completed ASR, and canonical transcript text. Silent chunks persist
  as terminal empty completions, so replay does not rerun ASR or invent text.
- **Whisper recovery is single-owner.** Concurrent start/restart requests are
  serialized and coalesced. COS reaps only a process tree proven to own the
  configured model and port 8178, verifies the port is clear, and launches one
  replacement. An unrelated Whisper process is never killed; uncertain
  ownership fails closed.
- **Backward compatible.** Existing query, prompt recovery, media, display,
  diagnostics, transcription, and legacy meeting contracts retain their prior
  behavior. The new capability flags are additive.

## 6.12.5

Extends the file-permission hardening to the remaining append-only logs that
the launch review named.

- **Run ledgers and the token-audit log are private at the file level.** The
  Claude and Codex run ledgers and the token-audit JSONL now create with mode
  0600 and repair existing files with chmod, matching the session-log and
  atomic-fs writers. They already sat under the 0700 data directory; this
  closes the file-level bit for defense in depth and covers the token-audit log
  specifically, which lives beside the data directory rather than inside it.

## 6.12.4

Completes the public launch security review with a constant-time token check.

- **API tokens compare in constant time.** The `/api` middleware and the
  OpenAI-compatible `/v1/chat/completions` Bearer check no longer use a plain
  `!==` string compare, which short-circuits on the first differing byte and
  leaks token bytes through response timing. Both now hash each side to a fixed
  SHA-256 digest and compare with `crypto.timingSafeEqual`. Missing headers,
  duplicated headers, and length-mismatched tokens fail closed without throwing.
  A new `token-auth` test pins the behavior. 401 responses are otherwise
  unchanged.

## 6.12.3

Security hardening from the public launch review, without changing app/server
wire contracts.

- **Stored prompts never enter a shell command.** Archive title generation now
  launches Claude with an argument array and sends user content over stdin. A
  regression test proves command substitutions and backticks remain inert.
- **Claude can run in a real allowlist mode.** Existing installs retain trusted
  mode for backward compatibility. Setting `COS_CLAUDE_TRUST_MODE=allowlist`
  removes the permission bypass, restricts Claude to COS's explicit per-query
  tools, and denies undeclared tools without an interactive prompt.
- **Tailscale matching is exact.** Network and CORS policy now accept only the
  assigned `100.64.0.0/10` CGNAT range rather than every `100.x` address.
  Localhost and RFC1918 LAN access remain unchanged.
- **Durable local state is private.** Runtime data and archive directories are
  repaired to `0700`; atomic state, conversation archives, session logs, and
  the saved OpenAI key are created or repaired to `0600`. Credential writes use
  private, exclusive, fsync-backed atomic publication.
- **Telegram export requires consent.** Merely finding a private
  `.telegram_config.json` no longer enables activity export. Operators must set
  the exact `COS_TELEGRAM_NOTIFICATIONS=1` opt-in.
- **Canonical history remains exact.** Operational previews and provider
  ledgers keep their existing redaction, while durable prompts/answers are not
  silently mutated; recovery, retries, and `reference message N` remain intact.
- **Backward compatible.** Query, prompt recovery, meetings, media, display,
  diagnostics, transcription, and protocol response shapes are unchanged.

## 6.12.2

First-install hardening for public `npx` users.

- **No nested install inside npm's cache.** The launcher resolves the declared
  `tsx` dependency from npm's existing `npx` dependency tree and never runs a
  second `npm install` from the ephemeral package directory.
- **Permission failures do not spread.** A broken or incomplete package fails
  closed with a user-owned isolated-cache recovery command. COS never suggests
  `sudo npm`, broad ownership changes, or writing through a root-owned cache.
- **Claude Desktop is no longer mistaken for Claude Code.** First-run guidance
  explicitly requires the terminal CLI, keeps the scoped npm command on one
  copyable line, forbids `sudo`, and explains the interactive sign-in step.
- **Known signed-out agents fail before startup.** Installed Claude/Codex
  binaries are checked before first-query readiness. Older CLI versions whose
  authentication state cannot be proven show a warning instead of a false
  signed-in claim.
- **Local credentials are private.** `~/.cos-glasses` is repaired to `0700`;
  the token and profile files are repaired to `0600`; symlinked credential
  paths fail closed; auto-generated tokens are persisted with an atomic write.
- **Runtime behavior is unchanged.** Query, prompt recovery, meetings, media,
  diagnostics, transcription, display, and server data contracts are untouched.

## 6.12.1

Public-safe CLI diagnostics for the COS Glasses Recovery Center.

- **Both local agents are visible.** Authenticated clients can inspect a
  versioned Claude Code and Codex status summary at `/api/cli/debug`, including
  provider support, persistence readiness, workspace configuration, and the
  latest run's safe status metadata.
- **False success is fenced.** Claude Code or Codex output that reports a
  machine-shaped authentication failure while the CLI exits `0` is finalized
  as a typed `auth_error`, never projected as a completed assistant reply.
- **Build 210 stays compatible.** Sanitized `/api/cli/runs` and
  `/api/codex/runs` projections preserve the fields older Recovery Centers can
  render while newer clients adopt the combined contract.
- **Diagnostics do not become an exfiltration path.** Responses use explicit
  allowlists and omit commands, filesystem paths, trust modes, prompts,
  answers, tool payloads, content previews, raw run/session/thread IDs,
  resumable handles, environment values, and tokens. Legacy display IDs are
  omitted and workspace state is a fixed label only.
- **Authentication is mandatory.** All three diagnostic routes remain behind
  the existing `/api` token boundary. Preview-enabled ledger fixtures are
  covered by recursive forbidden-field and private-value tests.
- **Unauthenticated health is capability-only.** `/api/health` and
  `/api/models` advertise `capabilities.cliDebug`; health exposes only a CLI
  session-availability boolean rather than the resumable session ID.
- **Backward compatible.** Query, prompt, meeting, media, display, model, and
  recovery behavior is unchanged. Older clients and servers continue to use
  their existing paths; a missing CLI Debug capability remains an unsupported
  feature rather than a connection failure.

## 6.12.0

Local-first transcription policy and capability-safe recovery diagnostics for
COS Glasses build 210+.

- **Local means local.** Prompt, one-shot, and meeting transcription now remain
  on local Whisper by default. Finding an OpenAI key is not permission to upload
  audio. Cloud Whisper is reachable only when the exact
  `COS_OPENAI_WHISPER_FALLBACK=1` opt-in and a resolved key are both present.
- **Every cloud chokepoint is fenced.** Both one-shot/prompt finalization and
  continuous meeting transcription recheck the policy immediately before any
  OpenAI request, preventing a future call-site regression from bypassing the
  top-level selection logic.
- **Failure stays recoverable.** A local ASR outage returns a typed retryable
  `503` instead of silently switching providers. Durable prompt chunks and raw
  meeting audio remain available for retry; meeting receipt and batch-audio
  retention behavior is unchanged.
- **Clients can tell policy from health.** `/api/health` and `/api/models`
  publish additive `capabilities.transcription` fields. Public installs also
  advertise every privileged recovery control as unsupported, allowing newer
  phone Recovery Centers to hide controls instead of reporting false outages.
- **Backward compatible.** Existing routes and response fields remain in place.
  Older apps keep their current query, prompt, meeting, image, and display
  paths; cloud fallback remains available to operators who explicitly enable it.

## 6.11.0

Local-first meeting recovery for COS Glasses build 209+.

- **Record through network loss.** The server advertises a versioned
  `localFirstMeetings` capability with its stable instance ID. Compatible
  clients can keep audio locally, reconnect to the same server, and reconcile
  the exact sparse set of chunks it durably received.
- **Durable means acknowledged.** Raw meeting WAVs and the received-index
  ledger are committed atomically before a chunk receives success. Storage
  failures return typed retryable errors; capacity exhaustion returns `507`
  instead of silently discarding audio.
- **Long meetings stay alive.** Active-session retention is measured from the
  last durable activity, not the meeting start time, so recordings longer than
  four hours are not mistaken for abandoned sessions.
- **Safe reconnect and close.** Authenticated session-status responses expose
  exact compressed receive ranges, retention, and closed/saved state. Durable
  tombstones prevent a late or replaying client from recreating a completed
  meeting after a restart.
- **Idempotent finalization.** Repeating `POST /api/meeting/save` for an already
  saved session returns the original versioned receipt and filename without
  creating a second meeting.
- **Backward compatible.** Existing live transcription, meeting save, prompt
  recovery, durable queries, and older clients retain their prior routes and
  fields. The new capability, receipt fields, and status route are additive.

## 6.10.0

Opt-in server-owned durable query jobs for COS Glasses build 204+.

- **Accepted means durable.** With `COS_DURABLE_QUERY_JOBS=1`, the server
  appends and fsyncs an immutable job before returning 202. Provider execution
  is no longer owned by the phone's current request, WebView, or SSE subscriber.
- **Reconnect without duplication.** The client can recover an ambiguous
  admission by its stable client job ID, replay ordered bounded events, and
  acknowledge one terminal projection idempotently after message, queue,
  counter, and session state are durable on the phone.
- **Crash and cancellation fences.** Provider ownership is persisted before
  input, session-scoped leases prevent overlapping orphan continuations after a
  restart, cancellation is durable, and answer-ready ownership gates
  conversation, image, notification, and Done side effects.
- **Private bounded storage.** The append-only journal uses private directory
  and file modes, repairs torn tails, bounds progress/activity payloads, and
  retains terminal jobs for exactly seven days.
- **Safe rollout and rollback.** The health capability advertises exact protocol
  version 1 only when configured and the store is ready. Removing the flag
  blocks new durable admissions but leaves GET/events/cancel/ack available so
  accepted jobs drain; legacy queries, first turns, handoffs, and older clients
  remain unchanged.

## 6.9.0

Live recoverable prompt transcription for COS Glasses builds 200+.

- **Words appear while speaking.** After each audio chunk is durably acknowledged,
  its sanitized fast/local transcript is published on the existing authenticated,
  replayable display stream as `prompt_transcript`; the phone/G2 client can fill
  the Listening body without adding another recorder, polling loop, or ASR job.
- **Recovery remains authoritative.** The event is optional presentation state.
  Stored WAV chunks, final HQ transcription, glossary cleanup, editing, retry,
  and send behavior remain unchanged and continue even if no display client is
  connected.
- **Stale retries cannot repaint.** The server rechecks the exact draft, chunk
  index, and audio bytes after warm transcription. Replaced audio never emits
  its obsolete words, while client-side draft scoping, ordering, and replay
  deduplication handle reconnects safely.
- **Public boundary retained.** This release adds no private COS paths, personal
  data, LaunchAgent controls, remote restart authority, or machine-management
  endpoints.

## 6.8.0

Public-safe meeting finalization for COS Glasses build 199.

- **Authenticated meeting save.** `POST /api/meeting/save` finalizes an existing
  `transcribe-stream` session without adding coaching, private classification,
  personal paths, or COS-only enrichment to the public package. Lost-chunk gaps,
  original client timing, provider evidence, and sparse raw-audio indices remain
  intact through deferred iPhone replay and save.
- **Durable standalone archive.** Canonical markdown and structured sidecars are
  published atomically under `dataPath('recordings', 'YYYY-MM')`. Directories are
  `0700`, files are `0600`, filenames are path-safe and session-unique, and an
  fsync-backed sidecar-first/markdown-last commit keeps incomplete pairs hidden.
- **Review on the current client.** Authenticated `GET /api/meetings`, literal
  `GET /api/meetings/detail`, and the build199-compatible dynamic detail route
  list and read standalone recordings after process/package restarts. Traversal,
  unsafe filenames, symlinked roots/months/files, absolute-path disclosure, and
  cross-domain detail mismatches fail closed.
- **Transcript-quality bouncer.** Post-meeting batch text must preserve at least
  50% live coverage, provide independent evidence when no live baseline exists,
  and avoid repeated long segments/sentences/prefixes. Mixed timestamp coverage
  falls back to complete batch text instead of dropping text-only segments.
- **Recovery evidence wins.** Canonical streaming text remains untouched when a
  batch is rejected or cannot be applied. Pending WAVs are deleted only after
  accepted text and its sidecar decision are both durable; every other outcome
  retains audio for bounded two-hour cleanup. HQ batch decoders serialize and
  refresh their cleanup lease while queued or active.
- **Capability detection.** `/api/health` now advertises
  `features.meetingFinalization` for compatible clients.

## 6.7.0

Durable prompt recovery and self-healing local transcription for COS Glasses
builds 190–191.

- **Audio is durable before transcription.** Prompt chunks are acknowledged only
  after atomic storage under `~/.cos-glasses/data/prompt-drafts`, survive server
  and package restarts for 72 hours, and can be finalized or retried by draft ID.
- **Live warm transcription.** Each saved chunk is transcribed locally while the
  user continues speaking. Finalization reuses matching-quality cached work or
  independently produces the requested final quality.
- **No-key preservation.** Warm transcription never requires an OpenAI key. If
  every backend is unavailable, the API returns a typed retryable `503` and keeps
  the acknowledged audio instead of losing the recording behind a generic 500.
- **Whisper self-recovery.** A single inference timeout no longer leaves the
  in-memory availability flag permanently false. The next chunk performs one
  bounded, single-flight health reconciliation; successful inference closes the
  circuit, while repeated inference failures retain the controlled restart path.
- **Private-by-default storage.** Draft directories are `0700`, audio and metadata
  are `0600`, metadata updates are atomic, corrupt metadata is quarantined, and
  per-chunk/per-draft limits prevent unbounded disk growth.
- **Public boundary retained.** The npm package includes only generic prompt
  recovery and text cleanup. It does not add private COS day-context, personal
  paths, LaunchAgent controls, or remote machine restart authority.

## 6.6.0

Reconnect compatibility for COS Glasses build 188, without importing private
COS day-context or Mac service-control behavior into the public package.

- **Stable logical server identity.** The server creates one atomic UUID under
  `~/.cos-glasses/server-instance-id`, preserves it across process and network
  restarts, and returns it from authenticated `/api/models` probes. Files are
  mode `0600`; identity is minted only after every required listener binds.
- **Boot-scoped display cursors.** Display events receive one publish-owned ID
  before fan-out, so multiple subscribers see the same cursor and cannot
  duplicate replay records. Each process boot has a distinct UUID.
- **Deterministic reconnect handshake.** `/api/display-stream` emits `ready`
  before application events, accepts boot/event cursors, replays the last 200
  publish-owned events, and reports typed `boot_changed`, `cursor_ahead`, or
  `buffer_overflow` gaps so clients reconcile durable history instead of
  guessing or silently dropping replies.
- **Privacy boundary preserved.** Authenticated query activity remains off the
  unauthenticated global display bus. The npm server does not include private
  daily evidence exports, personal COS paths, launchd ownership, or remote
  machine-restart controls.
- **Backward compatible.** Older clients can continue opening the same SSE
  endpoint and ignoring the additive `ready`, cursor metadata, and replay-gap
  events.

## 6.5.0

Durable phone photos and assistant-selected output images for COS Glasses
build 179, while preserving the public server's sandbox and privacy boundary.

- **One media contract.** Authenticated phone uploads become opaque attachment
  refs, survive queues/restarts/archives/numbered-message recall, and resolve to
  normalized server-owned files for Claude/Codex. Bytes and storage paths never
  enter SSE, run ledgers, or archives.
- **Answer images.** Claude or Codex can publish an already-local generated,
  researched, or explicitly used email image through a private run-scoped
  capability. The server accepts JPEG/PNG/WebP/HEIC/HEIF/AVIF up to 16 MiB and
  16 megapixels, strips metadata, re-encodes through the existing media store,
  and appends refs to the completed answer.
- **No mailbox or URL crawler.** The publisher rejects URLs, data URIs, base64,
  unrelated discovery, symlinks, directory replacement, content-id tampering,
  over-capacity output, and manifest fields that could carry private paths.
- **Codex remains read-only.** Output publishing adds only the random private
  run directory via `codex exec --add-dir`; global sandbox flags precede
  `resume`. Older CLIs without `--add-dir` keep chat working and simply disable
  Codex output-image publishing. There is no full-access fallback.
- **Durable finalization.** Assistant text is persisted before image
  normalization, request media associates even if SSE disconnects, partial
  image failures do not discard successful refs, and completion emits one
  canonical `attachments` list with safe aggregate stats.
- **Lens contract.** `/api/health` advertises `mediaProcessingReady` and
  `g2LensVariant=png-288x144-v1`; the media endpoint serves the validated phone,
  thumbnail, and exact 288×144 G2 variants expected by build 179.
- **Fresh-install diagnostics.** The npm launcher now reports whether ffmpeg is
  ready for phone/output/lens images, gives a non-blocking install command when
  absent, and sends setup questions directly to `gotcos.com/wizard/`.
- **One server owner.** The public runner now claims the same atomic
  machine-wide lock as the installed LaunchAgent before mutable modules load.
  A duplicate exits with code 75, and HTTP/HTTPS listeners bind as one required
  set: if either port is occupied, any earlier listener closes and the process
  exits instead of surviving half-bound with separate SSE and media state.

Release evidence: TypeScript, 130/130 tests across 23 files, package dry-run
including the executable publisher and startup hardening, and a live duplicate
start against the installed LaunchAgent rejected before server initialization.

## 6.4.0

Fresh-install parity for COS Glasses builds 170–173, without weakening the
public server's sandbox defaults.

- **Auto-updating GPT Frontier + Balanced.** Stable client slots resolve to the
  top two capable models in the newest visible GPT generation through Codex's
  official `model/list` catalog. The server refreshes at boot and every 15
  minutes, and each Codex run awaits the same TTL-cached/coalesced refresh
  before resolving its slot. It preserves the last-known-good catalog on
  failures and falls back to the CLI default only before any discovery succeeds.
- **Fable + effort controls.** Fable joins Opus and Sonnet as a first-class
  Claude tier alias, and High / Extra High / Max / Ultracode now propagate from
  `/api/query` to both Claude and Codex. Claude aliases remain versionless and
  1M-context capable; Codex effort is clamped to each live model's advertised
  support. Per-run ledgers record the concrete resolved model and effort.
- **Safe live job activity.** `activityToolMode` supports off, status-only, or
  bounded observable tool input/output previews. ANSI/control data, credential
  assignments, auth headers, provider tokens, JWTs, URL credentials, and opaque
  blobs are redacted, including 40–72-character PEM/private-key body chunks.
  Hidden reasoning is never surfaced.
- **Same-session run safety.** Turns for one conversation now serialize until
  the active bridge sends a terminal callback, while different sessions remain
  concurrent. Failed or cancelled Claude/Codex runs remove the exact pending
  user exchange by object identity, preventing phantom prompts, duplicate-text
  deletion, and resume-history contamination.
- **Authenticated transport boundary.** Activity lines are returned only on the
  authenticated `/api/query` SSE stream. They are deliberately excluded from
  the unauthenticated global display bus and its replay buffer.
- **Public trust model retained.** Codex remains read-only by default with only
  the existing `workspace-write` opt-in. Existing archive traversal, local-day,
  malformed-file, starter-kit launch-directory, and conversation behavior are
  unchanged. Legacy `codex-high` state migrates to the frontier slot without
  changing saved thread trust mode.
- **Diagnostics and compatibility.** `/api/models`, health data, and `/v1/models`
  expose stable slots plus concrete live models. `cos-codex-high` remains an
  accepted alias for older clients. Existing `COS_CODEX_MODEL` and
  `COS_CODEX_REASONING_EFFORT` overrides continue to apply to the migrated
  legacy/frontier slot; leave them unset for auto-latest. A new regression suite covers catalog
  selection/fallback/refresh, sandbox arguments, migrations, effort mappings,
  activity redaction, and the display-bus security boundary.

## 6.3.1

Security + robustness hardening on the 6.3.0 archive routes, from a 3-agent QA pass. (6.3.0 was never published; 6.3.1 is the first release of the expanded route set.)

- **SECURITY — path traversal blocked.** The new `:date` archive routes fed the param straight into `<dir>/${date}.json`, so an encoded traversal (`/api/archive/..%2F..%2Fetc%2Fhosts`) could read arbitrary `*.json` on the host (and rename-corrupt one via the quarantine path). Auth+IP gated, but a real exposure on a shared LAN/meshnet. Fixed: `archiveRouter.param('date', …)` enforces `^\d{4}-\d{2}-\d{2}$` on every `:date` route before any fs access; defense-in-depth guard in `readArchiveChatNumbered`. Verified: traversal/bad-format → 400, valid dates → 200.
- **Reference date label (US evenings).** Live-session `reference message N` stamped the date with UTC, labeling an evening reference with tomorrow's date. Now `localDay()`.
- **Malformed day file no longer wipes History.** A valid-JSON wrong-shape day file (no `chats[]`) 500'd the readers and dropped `listArchiveDates` into its catch, hiding all history. `loadArchive` coerces `chats` to `[]`; the bad day lists as 0 chats.
- **Thrift/cosmetic:** `/api/archive/now` passes `skipLLM:true` (no surprise LLM spend on a public manual snapshot); stale path comment + unused `__dirname` removed from `lib/archive.ts`.

## 6.3.0

Message History, cross-day references, and history recovery for public installs.
These features previously required a full COS server; now `npx @gotcos/glasses-server`
exposes them too, so the G2 app's Message History and "reference message N" work
on a vanilla install.

- **Message History** — the archive routes (`/api/archive`, `/api/archive/:date/chats`,
  `/api/archive/:date/chats/:i/messages`, `/api/archive/:date/messages`, `/api/archive/now`)
  are now served. The daily archive-mirror (already in this package) writes prior-day
  sessions to disk; these routes browse them. Each day row shows chat count + topic.
- **Cross-day "reference message N"** — new `/api/message/:num` resolves a permanent
  message number across live sessions then day archives (newest-first), and
  `/api/message-counter` publishes the numbering ceiling so a fresh/cleared client
  never reuses a number. Message numbers were already stored (`globalMsgNum`); this
  makes them resolvable.
- **History recovery** — session routes (`/api/sessions/today/all-messages`,
  `/api/sessions/:id/messages`, recent-sessions index, context-break, end-session)
  let the app restore recent history and open archived chats.

No change to the public-safe model curation (Sonnet default, no pinned/unreleased
model ids) or the core query/voice/display paths. Typecheck clean; new routes
smoke-tested (message-counter, archive list, message lookup).

## 6.2.1

Foolproofing release — driven by an adversarial onboarding QA pass.

- **The server now prints URLs the phone can actually use.** Boot output lists
  your real addresses (`http://100.x.x.x:3141` labeled Tailscale, LAN IPs labeled
  same-Wi-Fi) instead of only the un-pasteable bind address `0.0.0.0`.
- **Auto-generated API tokens survive restarts.** First boot saves the token to
  `~/.cos-glasses/.env`, so re-running the server no longer silently rotates the
  credential your app already saved (the "worked yesterday, 401 today" trap).
- **Starter-Kit COS inheritance is real now.** Run `npx @gotcos/glasses-server`
  from your COS folder and glasses chat loads its brain: the launcher records
  your launch directory, and when it contains `.cos/manifest.json`, `AGENTS.md`,
  or `CLAUDE.md`, Claude/Codex spawn there (explicit `COS_SCRIPTS_DIR` still wins).
- **Transfer-integrity report actually surfaces.** 6.2.0 recorded lost chunks but
  never returned them; the offline-session `finalize` response now includes
  `transferIntegrity` (received/expected/missing/completeness) and a gap-aware
  `transcript` with inline `[… audio gap …]` markers.
- **One default model everywhere: Sonnet.** The query router, the OpenAI-compat
  surface, and CLI pre-warm all default to Sonnet (was a mix of Opus and Haiku).
  Set `COS_G2_DEFAULT_MODEL` to override; per-query picks unchanged.

## 6.2.0

Reliability release — ports the hardening the full COS Glasses app shipped in June.

- **Transfer integrity (lost-chunk detection).** The server now records every
  received chunk index. A chunk lost in transit surfaces as an inline
  `[… audio gap …]` marker in the gap-aware transcript instead of being
  silently stitched over. Gap state survives a mid-meeting server restart;
  legacy persisted sessions recover without false alarms. The Even Hub client
  (1.0.153+) already retries failed uploads durably — this is the server half.
- **Vocab-echo hallucination filter.** Whisper is seeded with your profile
  vocabulary; on silence/music it can echo those terms back as phantom words
  ("POS Nation. Thrift Cart.") the user never said. Bare-name echoes are now
  dropped session-aware (silence echo, back-to-back run, or exact repeat) on
  both the meeting and dictation paths. Real sentences that mention a term are
  never dropped; plain single-word terms (names, cities) never trigger it.
- **Name corrections on every path.** The `whisper_corrections` map now also
  applies to iPhone-ASR candidate text and the cloud fallback, not just local
  whisper.
- **SIGTERM parity.** Production stops (service managers, `kill`) now flush
  active session logs exactly like Ctrl-C did.
- **`COS_G2_DEFAULT_MODEL` fix.** The documented default-model switch now
  applies on the primary query path, not only the OpenAI-compat surface.

## 6.1.0

- **Codex backend.** Chat now routes to your local **Codex CLI** (`codex-high`) in
  addition to Claude Code — pick either per query, or set `COS_G2_DEFAULT_MODEL`.
- The Codex model is **not** hardcoded — it uses your codex CLI's own default model
  unless you pin one with `COS_CODEX_MODEL` (+ optional `COS_CODEX_REASONING_EFFORT`).
- Codex run/session state persists under `~/.cos-glasses/data`.

## 6.0.0

The server now ships **inside** this package — `npx @gotcos/glasses-server` runs
it directly, with no second repository to clone.

- **Bundled server.** Previous versions cloned a separate app repo at runtime;
  the standalone server is now part of the package tarball.
- **Standalone-first.** Glasses + your local Claude Code CLI. No API key is
  pasted into the phone for chat.
- **Local voice.** Transcription runs on whisper.cpp (free); OpenAI API is an
  optional fallback.
- **Phone reachability.** Defaults `BIND_HOST=0.0.0.0` so the glasses' phone app
  can reach the server over your mesh/LAN. The IP allowlist blocks public traffic.
- **Persistent config** at `~/.cos-glasses/.env`.
- Requires Node.js 20.11+.
# 6.13.0

- Added a non-interactive managed-server entrypoint for the COS Control macOS app.
- Added authenticated maintenance status and guarded local Whisper restart contracts.
- Added `--prepare-only` to the existing guided launcher so first-run dependencies can be prepared without leaving a second server process running.
- Added a provider-neutral managed work-folder setting while preserving the existing interactive launch-directory behavior.
- Kept the existing `npx @gotcos/glasses-server` foreground workflow fully compatible.
