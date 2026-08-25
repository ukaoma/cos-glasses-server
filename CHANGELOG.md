## 6.37.0

Meetings recorded without the COS operations pipeline now get a real summary,
topics, decisions and action items. Until now they got none of that, and the
server compensated by returning the TRANSCRIPT in the summary slot -- which is
why this was reported as "no proper summary and transcription."

FEATURE DEFAULTS NOW ON (Miles 2026-08-25)

Ship the capability active; users opt out of what they do not need. Each gate
stays strict in the other direction -- only a literal '0' disables, so a stray
or malformed value cannot silently switch a feature off.

  COS_THREAD_ATTACH_ENABLED            Continue agent threads
  COS_VIDEO_UPLOAD_V2                  Reliable video uploads
  COS_MEETING_AUDIO_ADAPTIVE_PLAYBACK  Adaptive audio cleanup

COS_WHISPER_MEETING_PREVIEW (Meeting Turbo preview) was ALREADY on by default
server-side; COS Control mis-renders its checkbox as off because it resolves
the value as == "1" rather than != "0". That is a Control display bug, not a
server default, and is not fixed here.

Idle Metal HQ (COS_BATCH_HQ_METAL) is deliberately unchanged -- it is
hardware-dependent and stays opt-in.

Two consequences worth knowing. An in-flight video upload sets blocksRestart,
so a drain caught mid-upload waits for it -- that is the contract, not a stuck
gate, and must never be --forced. Adaptive playback affects review playback
only; the raw WAV is untouched, and transcript, attribution, save and sync are
unchanged.

VOICE ENROLMENT

"enroll my voice" followed by more speech created a profile NAMED with the
entire spoken utterance -- a ~40-second transcript. Reported by a first-time
user. Because a junk name never equals owner_speaker_label,
/api/voice/status reported `enrolled: false` no matter how many times you
enrolled, and editing voice-profiles.json by hand did not help because the
server rewrites it from memory.

Root cause was client-side: a $-anchored command regex fell through to the
named-enrolment branch, whose capture group had no length bound. Fixed in
COS Glasses 6.8.433.

POST /api/voice/enroll now validates ?name= as well, so an OLD client cannot
write a sentence into the profile store: at most 40 characters, at most 4
words, letters/spaces/hyphens/apostrophes only, no sentence punctuation, and
no self-referential phrasing. The wearer's own label is always accepted --
including the default "Me", which is itself self-referential and would
otherwise have been rejected by its own guard.

WHAT CHANGED

meeting-store parseMeeting no longer substitutes the transcript into `summary`.
A standalone placeholder now yields an empty summary, and the transcript is
carried in its own `transcript` field, which the reader renders as its own
section (requires COS Glasses 6.8.433). estimatedDetailPages now counts the
transcript, so a list row no longer advertises ~1p for a meeting that paginates
to many.

Two enrichment tiers, both standalone-only:

  extractive  always on, zero tokens -- duration, word count, speaker roster
              with talk-time split, opening excerpt. Fabricates nothing:
              topics/decisions/actions come back empty rather than guessed.

  llm         COS_MEETING_SUMMARY=1, default OFF. One `claude -p --model haiku`
              per meeting at the ops_pending phase of finalization.

It runs at ops_pending specifically because batch HQ transcription replaces the
whole transcript; summarising earlier would describe text the file no longer
contains. Every generated section is inserted BEFORE `## Transcript`, because
replaceMeetingTranscriptAtomic replaces from that marker to end of file.

NEVER RUNS FOR OPERATIONS USERS, and refuses twice: the caller gates on
cosOpsPipelineConfigured(), and the writer independently refuses any file
carrying the sync_meetings.py markers. Overwriting the summary section would
erase them and the pipeline would skip the meeting entirely -- losing domain
reclassification, task extraction and the operations copy.

COST CONTROLS
  - COS_MEETING_SUMMARY, read live (not frozen at module load)
  - haiku pinned explicitly, so it can never inherit an Opus session default
  - own daily cap (COS_MEETING_SUMMARY_DAILY_CAP, default 40), never shared
    with the archive counter; committed only after a validated summary, so a
    failure, auth refusal or malformed reply costs nothing
  - circuit breaker with its own failure accounting
  - single-slot queue, so a boot replay cannot spawn one provider per meeting
  - wall budget anchored to the finalization job start, keeping batch decode +
    summariser + handoff under COS Control's 90s waitForRestartProof
  - minimum word floor; head+tail input bound, never head-only
  - surfaced on /api/health as meeting_summary

An unauthenticated CLI exits ZERO with a success-shaped payload carrying the
bearer token. The result is screened with terminalProviderAuthFailure before
anything is written, so a 401 can never be persisted into a meeting file.

Generated prose never attributes statements to a speaker, and diarisation
labels ("Speaker 2", "Ext", "MU") are stripped from action-item owners -- the
speaker-review flow deliberately never rewrites these sections, so a label
captured here would stay wrong permanently.

A standalone save with no audio now schedules a finalization pass too; before
this it was nulled and never reached ops_pending. Orphan recovery, which has
its own path, enriches as well.

## 6.36.28

THE bug. Three earlier fixes tonight were each real and none was this one.

Every segment of a reply is minted at /prepare with a 120s idle deadline that
starts AT MINT. But the client only touches segment k when segment k-1 starts
playing. Measured on device, 6,781 chars at 1.25x:

    seg 4   first touched t+101s   played
    seg 5   first touched t+147s   FAILED
    seg 6   first touched t+215s   FAILED
    seg 7   never reached          FAILED

Segment 5 was deleted 27s before the client first asked for it. Reproduced with
curl against the running server, replaying the exact timeline: HTTP 404 at
segment 5, t+216s. The 404 reaches the audio element as NotSupportedError at
readyState 0 -- identical to every other media failure, which is why a char cap,
a wider idle window and a render gate all left playback stopping at segment 5.

WHAT CHANGED

- An unread session gets a grace window DERIVED from how long the whole reply
  takes to speak, plus one segment of margin (the last segment is first touched
  when the second-to-last starts playing).
- A read may only ever EXTEND a deadline, never shorten one. This is not
  cosmetic: the client warms segment k one whole segment before playing it, so
  collapsing the grace on that first read SPENT it. At 0.5x a 900-char segment
  is 170s of wall time against a 120s window, and the reply lost segment 1 while
  holding a 1,476s grace. Found by QA, after the first version of this fix.
- SESSION_IDLE_MS and SESSION_MAX_LIFETIME_MS are now COMPUTED from shared
  constants rather than written down. Both were derived from ~19 chars/sec, the
  FAST voice, and this release is the one that measured the slow voice at 10.
  Leaving them meant the file asserted two contradictory worst cases:
    idle     900 / 10 / 0.5  =  180s   against a 120s window
    ceiling  40,000 / 10 / 0.5 = 133 min against a 90 min ceiling
  The ceiling had also started silently truncating the grace for any reply over
  ~26,400 chars, relocating the same failure to roughly segment 31 of 46.
- MAX_LOCAL_TTS_CHARS, LATER_CHUNK_CHARS, the speech rate and the minimum
  playback rate now live in one place and are imported by the tests that used to
  restate them. That duplication is why the contradiction above was invisible.
- /play now logs the 404 it produces. The server held this fact all evening and
  recorded nothing, so the only reporter was a fire-and-forget client call.
- CORS exposes Content-Range and Accept-Ranges, without which the client's
  failure probe reads them as null from the null-origin companion WebView.

SECURITY, stated plainly rather than buried

An unread capability now lives far longer than 120 seconds -- up to the ceiling,
which is 136 minutes. That is a real widening and it is the price of playing a
40,000-character reply, which genuinely takes over two hours at 0.5x. What is
unchanged: the ceiling is absolute, reading cannot extend a capability past the
grace it was minted with, and an unread capability still expires on its own.
Both properties are pinned and both mutate red.

216 files, 3047 tests in scope (218 / 3053 including a parallel session's two
files, which are not part of this release).

## 6.36.27

The sidecar renders one request at a time. The server finally acts like it.

WHAT BROKE. Chunking (6.36.25) split a reply into 9 segments and /prepare
pre-warmed all 9 at once. The synthesis timeout was armed when a request was
ISSUED, so it ran while that request sat in the sidecar's queue. Measured on a
6,781-character reply: renders took ~2.6s each, but segment 5 spent 11.5s of its
12,000ms budget waiting for a turn. On device it tipped over, the pre-warm
returned 502, and iOS surfaced it as NotSupportedError. Five of nine segments
played.

The 12,000ms constant was not wrong when it was written -- its own comment says
it exists to "bound hung sidecar so local_first can fall back before session TTL
(~60s)", from an era when a reply was ONE render. Chunking changed the input and
nothing re-derived the limit.

- New render gate in tts-local.ts. One render reaches the sidecar at a time, so
  the synthesis timeout now bounds RENDER, which is what it always claimed to
  bound. Queue wait is governed separately.
- Queue wait has its own DERIVED ceiling: one synthesis budget per render ahead,
  plus one budget of headroom. The headroom is not slack -- without it the first
  waiter's ceiling expires in a dead heat with the holder's own timeout, and a
  request that was about to be served is rejected in the same tick. Found by the
  test, not by reasoning.
- /play outranks /prepare pre-warm. A user is waiting on the first and nobody is
  waiting on the second; without priority, segment 5's playback request queues
  behind pre-warms for 6, 7 and 8 -- work not needed for minutes. Priority never
  reorders playback against itself.
- /api/health tts_local now reports renderQueueDepth. This was not observable on
  2026-08-23 and that cost an evening.

Every guard mutation-verified, including one that only counting could catch:
dropping the waiter's detach left all ten behaviour tests green while leaking an
abort listener per queued render (45 of them on a 46-segment reply).

217 files, 3042 tests.

## 6.36.26

Deadline hardening for the segmented TTS path shipped in 6.36.25. Three constants
that were written rather than derived, and three tests that could not fail.

- `SESSION_IDLE_MS` 60s -> 120s, DERIVED. Every segment's session is minted at
  `/prepare`, but the client only touches segment i+1 when segment i starts
  playing -- so the idle window has to outlast one full segment at the slowest
  speed the client offers: `900 / 19 / 0.5 = 94.7s`. 60s covered 1x (47.4s) and
  1.25x (37.9s) but not 0.75x (63.2s), which is a shipped option in the Settings
  picker. At 0.75x every other segment would have 404'd, and because the client
  resolves rather than rejects on error, playback would have continued and
  dropped half the reply while still sounding complete.
- `MAX_CHUNKS` 40 -> 46. 40 covered 35,350 characters against a 40,000-character
  local cap -- 4,650 short, not "comfortably past" as its comment claimed. The
  overflow landed in one oversized final segment, which the OpenAI backend then
  trims PER SEGMENT, silently dropping text and contradicting the chunker's own
  no-loss contract. (46 was the second answer; 45 was still 150 short.)
- The timing test compared one chunk's render time against its own playback
  time. Both sides are linear in length, so it reduced to `1.9 < 17.54` and
  passed for every input -- including `LATER_CHUNK_CHARS = 100_000`, which
  restores the original bug exactly. Replaced with the cumulative, serialized
  form the sidecar actually exhibits, plus a test that scores the OLD
  prefix/tail split as the failure it was.
- Session-lifetime and policy tests now import `SESSION_IDLE_MS` and
  `SESSION_MAX_LIFETIME_MS` instead of restating them as literals.
- `SESSION_MAX_LIFETIME_MS` 30 -> 90 minutes (derived: a 40,000-char reply is
  70.2 minutes at 0.5x).

All four constants are mutation-verified: reverting each one fails a test.

215 files, 3028 tests.

## 6.36.25

**Spoken replies are now N segments, not a prefix and a tail.**

The two-segment split was a race, and the user lost it by less than a second.
Measured on device with a 6,781-character reply:

    prefix rendered in   0.5s
    tail rendered in    12.4s  -- AFTER the prefix; the sidecar serializes
                                  synthesis behind one lock
    tail ready          ~12.9s after prepare
    prefix audio         15s ... but 12.0s at the user's 1.25x playback speed

The phone asked for the tail at 12.0s. It existed at 12.9s. `/play` blocks until
synthesis finishes before sending any headers -- 11.3 seconds to first byte,
measured -- and iOS's media loader will not wait. It buffered nothing and rejected
with `NotSupportedError`.

Widening the margin would not have fixed it: the margin depends on reply length,
voice, playback speed and machine load. Chunking removes the race instead. The
first segment stays small (250 chars, ~0.5s render, ~13s of speech) so first audio
is as fast as before; later segments are 900 chars. Every segment renders roughly
ten times faster than it plays, so the queue only gets further ahead — a property
now asserted directly rather than assumed.

`/prepare` returns `urls` (every segment, in order) plus `chunks`. `url` and
`tailUrl` are kept, pointing at the first two, so a client older than 6.8.428
plays a degraded two segments instead of nothing.

`splitForFastPrefix` is deleted — zero callers, zero tests, and leaving a
superseded splitter next to its replacement is how the wrong one gets used.

The chunker's first test asserts that concatenating the segments reproduces the
input's words. That caught a real defect in the first draft: the final piece was
appended twice, so `splitForChunks('Hi.')` returned `['Hi. Hi.']`. A chunker that
duplicates or drops text is worse than the bug it replaces, because the reply
still sounds complete.

Suite 3022 / 215, tsc 0. Mutation-verified: reverting to two segments, and
dropping the legacy url/tailUrl, each fail the route contract test.

## 6.36.24

**Playback stopped after about a minute, whatever the reply length.**

The TTS play session held a deadline fixed 60 seconds from creation. iOS WKWebView
re-requests `audio.src` every few seconds to refill its decode buffer, so once the
session expired those refills 404'd and the audio simply stopped mid-sentence.

Measured on this machine: 250 characters is 14 seconds of speech, 4,000 characters
is 211. So any reply over roughly 1,100 characters outlived its own session. The
symptom was "the first ten seconds play and nothing else comes" -- the fast-path
prefix is 250 characters, which is that 14 seconds exactly.

6.36.23 removed a character cap that was also real, but the cap truncated the
TEXT; this truncated the PLAYBACK. The ceiling was time, not length, which is what
"caps out at a max duration" meant literally.

`SESSION_TTL_MS` becomes `SESSION_IDLE_MS`, refreshed on every read, so a session
stays alive while audio is actively playing and dies a minute after it stops.

Because the session UUID IS the auth for an unauthenticated play route, a purely
sliding window could be held open indefinitely by polling. `SESSION_MAX_LIFETIME_MS`
(30 minutes) is an absolute ceiling that reading never extends -- far longer than
any plausible reply, and still a bounded exposure window for a leaked URL. The
periodic reaper honours it too.

v5.9.4 made these reads non-destructive for exactly this symptom and stopped one
step short, noting "sessions still expire on the existing 60s TTL, so the practical
exposure window is unchanged". True, and also what left the ceiling in place.

Suite 3013 / 214, tsc 0. Both halves mutation-verified: removing the refresh fails
the playback tests, and letting a read extend past the ceiling fails the security
tests.

## 6.36.23

**Long replies stopped speaking at about three or four pages.**

`MAX_TTS_CHARS = 4000` is OpenAI's input limit -- `gpt-4o-mini-tts` rejects
anything longer -- and it was applied UP FRONT, before COS chose an engine. Kokoro
runs locally and has no such limit, so local speech was being truncated by a rule
belonging to an API it was not using. The sidecar then applied its own `text[:4000]`
as a bare slice: no sentence boundary, no error, no signal to the caller. It simply
stopped mid-word.

The cap now lives where the backend is actually known. OpenAI keeps 4000, applied
in BOTH its entry points (the cached generator and the streaming sibling -- capping
one truncates silently through the other). Local gets 40,000, which is a memory and
latency bound rather than a product limit. The sidecar's slice is now a named
runaway-caller bound, overridable via `COS_TTS_MAX_INPUT_CHARS`.

**Eight British English voices**, on disk all along and offered by nothing:
bm_george, bm_daniel, bm_lewis, bm_fable, bf_emma, bf_alice, bf_isabella, bf_lily.
`/api/tts/voices` now serves 28 local voices with an `accent` field, American
first so `local[0]` is still the historical default.

The voice pack ships 54. The other 26 -- Mandarin, Japanese, Hindi, Spanish,
Brazilian Portuguese, Italian, French -- are deliberately NOT offered: the sidecar
phonemises with `lang_code="a"`, so they would be read through an American English
grapheme-to-phoneme pass, producing an accent artefact rather than the language.
Exposing them needs a lang_code map and text in the matching language.

**`isKokoroVoiceId` now checks the catalog instead of the shape.** It was
`/^[a-z]{2}_[a-z0-9]+$/i`, which accepts any id of the right form -- the 26
non-English voices, and ids for no voice at all. Nothing downstream refused them
either: the sidecar falls back requested -> COS_TTS_KOKORO_VOICE -> am_echo and
returns audio, so an unrecognised voice produced a DIFFERENT voice with no error.
`KOKORO_VOICE_IDS` had existed for exactly this check and was never read.

Suite 3008 / 213, tsc 0. Three mutations verified: restoring the shared cap on the
local path, reintroducing the up-front cap, and dropping the British set each fail
the assertion written for them.

## 6.36.22

**`features.claudeSessions` in health**, so a client toggle can read its own state.

COS Control's "Show Claude sessions" checkbox sourced its state from
`GET /api/claude-sessions` -- the call that also lists every session -- and the
panel never made that call. The box rendered false while the setting was true, and
Miles enabled it four times against a control that could only ever show him one
value. Health is what every other toggle on that panel already reads, and this is
a pure env read, so it costs nothing on a poll.

Present even when off: a client must distinguish `false` from absent, because
absent means a server too old to report it and the toggle should then be left
alone rather than forced off.

Pairs with COS Control 0.5.64.

## 6.36.21

**Fence liveness: the one thing about a fence a machine can actually establish.**

`GET /agent-sessions/fences` and the release preview now carry a `liveness`
aggregate -- `state` (`running` / `none_running` / `unknown`) plus counts. It
answers "is a child COS spawned for this turn still writing", which is the only
way releasing is unsafe for a reason a machine can see: admit a new turn while an
old child is still writing and two writers interleave in one transcript.

IT IS NOT A SAFETY VERDICT and no surface may render it as one. Whether the
ambiguous turn landed stays unknowable. Two automatic fence resolvers were
designed and both rejected (thread-fence-store.ts:40) because the dominant shape
is `timeout`, where the child had ~21 minutes to run tool calls before SIGKILL --
and the only fence this system has ever produced was exactly that shape. A
classifier built on n=1 would be guessing with a confident face.

The module enforces the three traps FenceRecord warns about rather than repeating
them: a pid is matched against its RECORDED start, because the OS recycles pids;
an empty or missing spawn list resolves to `unknown`, never `none_running`,
because "nothing was recorded" is not "nothing ran"; and any probe that throws or
returns something unparseable resolves toward `unknown`. A live child outranks an
unreadable probe.

Only the aggregate crosses the wire. No pid, no spawn list, and the rest of the
evidence block stays disk-only -- widening that is a deliberate contract change,
not a side effect of this.

`listFences` now REQUIRES the probe. It was optional, and the resulting
`deps === undefined` branch was unreachable from the route: a mutation flipping
its default to `none_running` left all 262 route tests green. An unreached line
that returns a confident answer is worse than no line.


**A turn queued against a fenced thread was thrown away in about two minutes.**

The thread-turn queue is wired before the agent-session-bindings router, and that
router built its own `TargetGuard`. So the queue's occupancy gate could not see a
fence at all: a fenced target reported attachable, `drainDecision` returned
'deliver', the loopback attach refused `native_target_fenced`, and the refusal
spent one of five delivery attempts. Five 20-second ticks retire a turn -- long
before anyone could reach the Mac, and the only fence this system has produced sat
for roughly 40 hours because clearing it required a terminal.

This is the SAME failure `native_target_busy` hit before the binding was made
visible to occupancy, and the note recording that fix is three lines above the
change. Fences never got the same treatment.

The server now owns one `TargetGuard`, constructed above the queue and handed to
the router, and occupancy consults it. A fenced target holds, and a hold spends
nothing.

`native_target_fenced` is now queueable -- the one entry in that set cleared by a
person rather than a clock. The previous reasoning (waiting cannot resolve "may or
may not have been delivered") was correct for a world where releasing needed a
terminal. COS Control 0.5.63 ships a Release button that runs, so the wait ends on
a real event. Queueing does not weaken anything: delivery re-enters the attach
route and re-runs the fence check.

Fence-held turns get `FENCE_HELD_TURN_TTL_MS` (72h) instead of the ordinary 6h.
Six hours is right for a busy thread; it is wrong for a state that ends when a
person looks. It still expires, and it still says so.

Two existing tests were retargeted rather than deleted, both with the reasoning
kept: the one asserting a fence is NOT queueable, and the one using a fence as its
example of a refusal that can never clear -- that rule is unchanged and now uses a
structurally permanent reason as its witness.

Requires COS Control 0.5.63 for the Release button to actually work.

Suite 3003 / 213 files, tsc 0. The wiring and liveness guards are mutation-verified: removing
the fence check from occupancy, and moving the guard below the queue, each fail
the assertion written for them.

## 6.36.20

Follow-up to 6.36.19, which was never published. QA found three things in it.

**The reset CLI mutated production archives just by importing.**
`message-era-reset.ts` imported `endSession`/`getActiveSessions` from
`conversation.js` and used neither -- but that module's scope runs
`loadFromDisk()` and a boot `runDailyArchiveMirror()`. In the one-shot CLI that
is a second process concurrently loading and rewriting the archives the live
server owns, and `appendToArchive` appends rather than upserts, so it can
duplicate prior-day chats. The import is gone, and a test now asserts it stays
gone. The previous canary injected an `archiveAndRelease` and asserted it was
never called, which only ever caught a regression routed through the callback --
the code it replaced called `endSession()` directly as its default. `sessions`
and `archiveAndRelease` are deleted from the input type rather than left as a
silent no-op for a future caller.

**A corrupt `message-era.json` was indistinguishable from a reset.**
`currentMessageEraState` fell back to `legacy` on missing OR invalid content.
Reverting to `legacy` after a real era existed is the worst available answer: it
re-reads every era-stamped exchange as a PREVIOUS era, hiding it from
`/all-messages`, while promoting unstamped ones to current -- and to a client it
looks exactly like a reset nobody asked for. Missing still means `legacy`, which
is correct for a first upgrade whose exchanges carry no stamp at all. Corrupt
now rotates explicitly, says so on stderr, and degrades to `legacy` without
caching only if the replacement cannot be persisted.

**The header described a code path that had been removed.** It still said
rotation stops "if an archive write fails". There is no archive write. It now
also records what 6.36.19 quietly changed: this path does NOT archive, and the
daily mirror skips today by design, so a same-day copy exists only after an
explicit session end or `POST /api/archive/now`.

The 409 copy on both query paths no longer tells the wearer to reopen for a
"fresh message list" -- as of app 6.8.423 the cards stay.

Requires app 6.8.423. Suite 2976 / 209 files, tsc 0, measured on a CLEAN
checkout of this commit rather than a working tree carrying another session's
uncommitted files -- the 6.36.19 note quoted 2981/211 from a contaminated tree,
and that tree's untracked code would have shipped in the tarball.

The conversation-import canary is mutation-verified: reintroducing the import
fails it. One unidentified test failed on a single clean-tree run and did not
recur across six further runs; it is not attributed to this change and it is
recorded here rather than rounded down to "clean".

## 6.36.19
- **Resetting the spoken message count no longer ends the conversation.**
  `resetLiveMessageEra` used to `endSession` every live session before rotating
  the era, so "reset the message count" also emptied CHAT and killed the thread
  the wearer was in the middle of. It now rotates the era and nothing else.
- Numbers stay unique because they were never bare ints: a number is
  `{messageEra, globalMsgNum}`. The era rotates, the current-era ceiling
  restarts at 0, and leftover cards keep their old era and their old number.
  Lookup already prefers the current era (`message-ref.ts:231-234`) and the
  counter is already era-scoped (`message-ref.ts:242-251`), so "message N" stays
  unambiguous without a second ID scheme.
- `archived` stays in the response and is now always `0`. Callers read the field,
  so it is kept — but copy that reports it must stop claiming sessions were
  archived. The `archive_failed` 503 path is **gone**, not relocated: there is no
  archive step left to fail.
- Tests inverted to match. A supplied `archiveAndRelease` is now asserted
  *never to be called*, and a refusing one can no longer block the rotation.
  Mutation-verified: reintroducing the release loop fails the suite.

**Ship gate:** do not POST `/api/message-era/reset` from any surface until app
6.8.422 is also live. Server-first plus the old companion still wipes local
messages, and `/sessions/today/all-messages` is era-filtered so recover cannot
bring the leftover cards back.

## 6.36.18
- **Meetings list now carries voice-assignment tags.** Each row includes
  `voiceReview` from the sidecar head (`speakers[]`) plus whether a human
  correction landed in the ledger. Control paints NEW / N to name / REVIEWED
  without opening each meeting. Still a 4 KB head read — not a chunk parse.

## 6.36.17
- **Naming a new person from a wrong existing label now creates their voice profile.**
  Enrolment after `POST /relabel` only fired when `from` was a placeholder (`Ext`,
  `Unknown`, `Unidentified N`). The live path in Speakers review is the other one:
  the identifier weakly matches someone already enrolled, and the reviewer says
  **This is someone else → Use "Milo LeBaron"**. Measured 2026-08-20 on
  `meeting_1787234635703_t4iz74`: Nick Gurney → Milo LeBaron, 19 chunks, ledger
  `applied`, 78 profiles, no Milo. Backfill used the same guard, so the meeting
  could not be enrolled after the fact either (`eligible: 0`, `skippedNamedSource: 1`).
- **Enrol by target, not by source.** `enrolNamedVoice` still skips a placeholder
  `to` and an empty `changed` list. A real `to` enrols those chunks — creates the
  profile when it does not exist, appends when it does — through the same raw-index
  map, coherence gate, 20-sample cap, and `correction:<sessionId>` tag. Global fold
  of two identities remains `merge-profiles`. Per-meeting chunk assignment is not
  that. Mutating the old `from`-placeholder guard back in fails the new Nick → Milo
  test.

## 6.36.16
- **Cursor Agent Continue.** Continue now resumes a Cursor Agent CLI thread with
  `agent --resume <id> --workspace <spawn spelling>` in ask-mode. Bindable, not
  forkable: Fork on Cursor still has no spawn path. Occupancy treats a resolved
  `~/.cursor/chats/<hash>/<id>/` session (`hasConversation: true`) as attachable
  with no invented process owner. `--workspace` uses the jsonl folder slug that
  already exists — never `realpath` of `meta.json.cwd`, which creates a second
  transcript folder. Queue is refused for Cursor. The 6.36.15 jsonl-mtime write
  hint is unpublished on the LIST; detail still uses the jsonl mtime the handler
  already stat'ed as a display-only working signal, never a write gate.

## 6.36.15 (unpublished)
- **Cursor sessions can show as working.** Occupancy only scanned Claude
  (registry) and Codex (writer lock). Cursor has neither, so every Cursor row
  stamped `running: false` even while the jsonl was being written — the lens
  stayed on the digest and the list never showed a live Cursor turn. The list
  already paid for Cursor `modified` as the jsonl mtime; a write inside the same
  30s window Claude/Codex use for `running_active` now synthesizes a display
  hint (`running` + `running_active`, `running_foreign` still false). Detail
  uses the file it already stat'ed. Still a hint, never a write gate. Withheld:
  Continue on Cursor is 6.36.16, and this mtime hint is not in that train.

## 6.36.14
- **The session LIST now reports what its caps hid.** The 7-day age gate, the
  20-per-provider cap, and the Cursor 32 MB skip used to drop rows with no
  signal, so a 60-row list looked complete. `GET /api/agent-sessions` now carries
  `dropped: { age, limit, oversized }`. Additive: an older client ignores the
  key. Zero means the walk found nothing to hide, not that the caps are off.
  Keep-warm titles and Codex files over 32 MB are not counted — Codex is listed
  oversize on purpose; Cursor is the one that skips. Measured on this machine
  before publish: 62 listed, **2,144** older than 7 days, **91** over the
  per-provider cap, **0** oversized. The visible first/last ids match running
  6.36.13, so the list membership did not change — only the silence did.

## 6.36.13
- **Codex was spawned by bare name in four places, and it only worked here by accident.**
  `codex` on PATH is a shell alias to `/Applications/Codex.app`, which does not exist; the real
  binary lives in ChatGPT.app. Every bare `spawn('codex', …)` resolved through a PATH that COS
  Control injects into the managed plist — so it worked on this machine and was ENOENT for every
  public npx user, and for anything launchd- or Finder-spawned. The sites: the model catalog, the
  `--add-dir` capability probe, the health probe, and `callCodexStreaming`, which is the **live
  turn-execution path**. Each now resolves first, and each refuses in the way that suits it: the
  live turn throws with the reason, the catalog rejects to its existing `cli-default` degradation,
  the capability probe reports unsupported, and the health probe reports `unresolved (…)` instead
  of collapsing "cannot find it" and "found it and it errored" into one `error`.
- **Binary resolution moved to its own leaf module.** `provider-binary.ts` imports nothing from the
  repo, deliberately: reaching the resolver through `attached-provider-adapter.ts` would close the
  cycle adapter → codex-run-ledger → codex-model-catalog → adapter. The adapter re-exports it, so
  no existing importer changed.
- **Three source-text assertions replaced with fixtures.** Two tests asserted on this repo's own
  characters — `not.toMatch('AGENT_SESSION_MAX_FILE_BYTES')` and `toMatch('end = HEAD_BYTES - 1')`
  — which go stale on any refactor and cannot observe the property they name. A Codex rollout is
  now made genuinely larger than the 32 MB gate (sparse, via `truncateSync`) and asserted to still
  be listed. Verified by mutation: adding that gate to `listCodexSessions` fails the new test.

## 6.36.12
- **Claude and Codex now rank candidates by recency before spending the budget.** Both
  walked in raw `readdir` order, so which sessions were reachable came down to filesystem
  layout — `collectCursorDocs` had ranked for a while and these two were the inconsistent
  ones. Statting every candidate first costs ~41ms across 2,118 files. Cursor also charged
  its budget before the keep-warm filter, the same defect, now fixed.
- **The reach claim in the module docstring was never true and is now measured.** It said
  "older chats stay findable". Ranked and measured on this machine, search reaches roughly
  24 days of Claude, 89 days of Codex and 19 days of Cursor, because once candidates are
  ordered by recency the per-provider doc budget IS the horizon. `EXAMINE_MULTIPLE` was
  re-swept and raised to 12 — the point where examining more files stops finding anything
  older and the doc budget takes over. A sampled older stratum was considered and
  rejected: partial coverage makes a miss uninterpretable, and a search that silently
  samples cannot tell you whether something is absent or merely unsampled.
- **Embedding batches go out together instead of one after another.** The loop awaited
  each batch in turn, so cost was a round trip per 64 docs and grew as the collector
  returned more — 389 docs is 7 serialized trips at the old size. Now 128 per request,
  all in flight at once. Structural; not measured end to end, because this harness has no
  OpenAI key and the running server was left alone.
- **Session search was 68% scaffolding, and the budget was the reason.** Of the 1,296
  Claude transcripts on this machine the collector indexed 41, and 28 of those 41 were
  machine prompts — 22 Slack Bridge proxy, 4 reply-with, 2 slack_search_users. Roughly 13
  real conversations were searchable, which is why searching an exact session title
  returned nothing. Two changes, which do not work apart: `isKeepWarmSessionTitle` now
  recognises the machine families by anchored prefix, and both the Claude and Codex
  collectors run that filter — and the Codex `thread_source === 'subagent'` check — BEFORE
  charging the doc budget rather than after. Measured against the real corpus: 41 indexed
  Claude docs with 28 junk becomes **79 indexed with 0 junk**.
- **The budget now counts docs kept, not files opened.** That is the whole fix: a run of
  machine transcripts used to consume the 134-file allowance and return nothing, so the
  newest real transcript on disk was never reached. A second `examined` ceiling
  (`EXAMINE_MULTIPLE`, 5x the doc budget) stops a pathological corpus walking all 1,296
  files, and the expensive transcript-body read is deferred until a file is being kept.
- **This also removes rows from COS Control's session LIST.** The predicate is shared by
  all four collectors and the list path, so keep-warm and Slack Bridge entries stop
  appearing there too. That is intended, not a side effect to fix.
- **Control may not see any of this yet.** The search route's median is ~2.27s against
  Control's 2s client timeout, of which ~1.7s is two sequential embedding round trips;
  this work adds ~350ms on top. Until that timeout and `EMBED_BATCH` are addressed,
  Control falls back to its local scanner and reports a fabricated `server_too_old`.
- **The scan budget had no test coverage at all.** `collectAgentSessionSearchDocs` was
  never called by any test and its `cap` was never exercised, so the branch that spends
  the budget had never run. 21 tests added, each verified to FAIL against the previous
  code before being kept.

## 6.36.11
- **Fences now record WHY, so the population can be measured before anything resolves
  automatically.** Two plans designed an automatic fence resolver and both were rejected —
  the second because there has never been a single fence on the machine to look at. If
  `timeout` dominates, the child had the full 21-minute budget to run tool calls before
  SIGKILL and re-delivery would re-execute them, so no automatic clear is ever safe. That
  question was unanswerable and now is not.
- **`reaped` is reported by the adapter, never derived.** A signal-killed child reports
  `code === null` and the handlers only assign `exitCode` for a numeric code — so deriving
  "was it reaped" from `exitCode` reports NEVER REAPED for the dominant timeout shape
  (SIGTERM, then SIGKILL), which is exactly backwards for the decision this data informs.
  The first cut of this change did derive it. `AttachedTurnFailureResult` now carries
  `reaped`, true from every settle reached via `close`/`error` and false only from the
  force-settle that fires when `close` never arrived.
- **An unreadable adapter result records nothing, not zeroes.** Reading `{}` and writing
  `exitCode: null, childReaped: false` states two facts about a child nothing is known
  about, indistinguishable on disk from a confirmed-unreaped timeout — corrupting the one
  discriminator this evidence exists to establish.
- **`fenceSite` says which site fired.** `adapterReason` cannot substitute: the catch site
  inherits whatever the adapter last reported, so a route crash AFTER a clean delivery
  records `ok` — the strongest possible reason NOT to re-deliver, which would otherwise
  read as "nothing went wrong".
- **One resolved reason for the record and the log.** The record said `unreadable_result`
  while the breadcrumb said `unknown`, so an operator grepping for the sentinel found
  nothing. This is the same contradiction 6.36.10 fixed at the other fence site,
  re-committed one release later in the same handler; both now read one value.
- **A release no longer destroys the evidence.** `releaseFence` deletes the row, and the
  realistic first-fence sequence is: fence lands, Control's card appears, it is released,
  the distribution is gone. The release breadcrumb now carries the whole record.
- **Spawn identity as `{pid, startMs}` PAIRS.** `recordedPids` held bare pids and the
  measured start was discarded; a pid alone cannot be told apart from a recycled one.
  The evidence type is narrowed to the six adapter fields so the spread at the fence
  sites cannot clobber the fence's own identity — `Partial<FenceEvidence>` permitted
  `provider`, and the adapter result carries one that would write null and fail
  `isFenceRecord` on the next read, silently un-enforcing the fence.
- **All fields OPTIONAL and NOT in `isFenceRecord`.** That predicate is cast-based, so a
  required field would type as present while being undefined at runtime; extending it
  would reclassify existing rows as unrecognised and silently un-enforce them.
- **DISK ONLY.** Nothing reaches the wire; asserted against the real `/fences` body and
  the release preview.
- **No behaviour change.** Nothing clears, nothing refuses differently. Upgrade, downgrade
  and the COS Control card were all verified unaffected.
- **Coverage, stated honestly.** The adapter's `reaped` contract is tested at the adapter,
  driving a real `close(null)` — a route test could not cover it, because the route
  fixtures supply `reaped` themselves and would pass with the adapter gutted. Mutation
  results: caught — derived-from-exitCode, adapter stops reporting reaped, startMs zeroed,
  empty spawn list, missing fenceSite, unrecorded adapterReason, wire leak. **Survived, and
  therefore unverified: `stderrClass` is written but asserted nowhere, and `fail()`'s
  `reaped: false` default on the `not_attempted` paths (which never fence).** The
  `route_error` fence site remains reachable by no test.
- **Known gaps, not fixed here:** `stderrClass` appears in the breadcrumbs but on a
  default install (`COS_THREAD_FENCE_DURABLE` unset) nothing is written to disk at all;
  and reading the distribution means reading `thread-fences.json` or the server log —
  there is no UI for it.
- **A live session was reporting itself hours idle.** Separate from the fence work above.
  `liveClaudeRows` builds a row's `modified` from the peer registry's `lastActiveAt`, which
  tracks the REGISTRY record and not the transcript — so a session that is actively writing
  keeps reporting whenever the registry last moved. Measured on three live sessions
  2026-08-18: the wire said 55.3m / 407.7m / 435.0m old while their transcripts had been
  written 0.1m / 0.2m / 5.1m earlier. Under-reporting by up to 7.2 hours. Shipped in
  66dff88; `enrichLiveClaude` already resolves the transcript path and reads the file twice,
  so the true mtime costs one `stat`. A resolved file that fails to stat keeps the
  heartbeat; a session with no transcript at all (2 of 6 measured) returns early on the
  existing guard. Prerequisite for any surface that renders a real date — without it,
  showing the timestamp displays an actively-writing session as seven hours stale.
  Coverage: `enrichLiveClaude` had NO execution coverage before this (every existing test
  passes an empty live array). Two tests now drive it through `listAgentSessions`. Three
  mutations, two caught; the third (the stat-failure fallback) SURVIVES because the
  missing-file guard returns first, so that branch is unreached. The code says so.

## 6.36.10
- **A fenced thread had no exit and left no trace.** An ambiguous delivery fences the
  target so a prompt cannot be double-delivered into a real conversation — that is
  correct and stays. Everything around it was wrong: the fence lived in a process-local
  Map, wrote no log line at either site, had no list, and had no release. It was
  discoverable only by being refused, and the only thing that cleared it was a restart.
- **Now listable and releasable without a restart.** `GET /api/agent-sessions/fences`
  lists them; `POST /api/agent-sessions/fences/release` clears one. Addressed by DIGEST,
  never by raw target key — the key embeds the private native thread id. Fails closed:
  without `confirm: true` it returns 400 with a preview of what would be reopened. That
  confirmation is a deliberate second call, NOT proof a human looked — the API token is
  shared by the phone, the lens and every COS agent session, so nothing is structurally
  prevented from asserting it. The comment says so rather than overclaiming.
- **Durable storage ships INERT, behind `COS_THREAD_FENCE_DURABLE=1`, default off.**
  Persisting the fence is the right direction, but durability without a reachable
  release is a regression, not a fix: today "Restart Server" in COS Control clears a
  fence, and making it survive restarts with no operator surface in Control would turn
  an 8-second annoyance into a permanently dead thread needing a terminal. The flag
  flips on when COS Control has a Fences card. The routes above already remove the
  restart from the recovery path.
- **A write can never erase what it could not read.** `TargetGuard` hydrates only the
  rows it understood and saves its map wholesale, so a single unrecognised row — a
  newer schema, a partial write, one bad field — would otherwise be erased by the next
  fence on an unrelated thread, silently reopening every other fenced thread. Writes now
  merge unrecognised rows back through. A corrupt file is quarantined to
  `.corrupt-<ts>` rather than dropped, and uses `durableAtomicWriteFileSync` (fsync of
  bytes, metadata and directory; randomized exclusive temp name) rather than the
  lightweight cache writer.
- **A release is persisted before it is reported.** Mutating memory first and reporting
  success meant an operator could be told a thread was open, write to it, and find it
  fenced again after the next restart with no record of why. A failed write now returns
  500 `persist_failed` and the fence holds. `GET /fences` reports `degraded` when the
  last write failed — a memory-only fence set is otherwise indistinguishable from a
  durable one until the process restarts.
- **Visible.** Breadcrumbs at both fence-set sites (tagged `ambiguous` vs `route_error`)
  and both fence-hit routes (turn, attach). No raw target key in any of them. The
  route_error line reports the hoisted pre-turn head rather than hardcoding
  `unavailable`, which contradicted the record it had just written.
- **Known, not fixed here:** releasing a fence does not by itself make the thread
  attachable — the turn that fenced it left a binding holding the target for its
  30-minute TTL, so the next attach refuses `native_target_busy`. There is no detach
  route. `/attachability` still does not consult the fence, so the lens menu renders
  Continue enabled on a fenced thread; the refusal is honest, the menu is not yet.
- **Coverage.** 11 mutations against the new guards fail the suite, including all four
  that survived the first QA pass (the release handle check, and the provider/reason/
  fencedAt row validators). One documented survivor remains: removing the write-once
  guard on `fence()`, which no route can reach because both fence sites sit inside the
  `tryClaim` section. The code says so at the call site.

## 6.36.9
- **The queue gate can now see COS's own bindings, which closes a 30-minute lockout.**
  `threadOccupancy` sees FOREIGN holders only — `OccupancyReason` has no
  `native_target_busy`, because that refusal comes from the binding registry. So when a
  live COS binding held a thread, Continue refused `native_target_busy`, the client
  armed the queue, and this gate answered `409 thread_free` ("Pick Continue again"),
  which refused identically. A closed loop for the whole binding TTL, while the refusal
  copy said "detach that one first" — an action with no endpoint.
- The same gap burnt the delivery ceiling: the drainer saw `attachable`, ATTEMPTED, and
  the attach route refused. Five of those retired a turn in about two minutes. With the
  binding visible, `drainDecision` returns `hold` and spends nothing — one change closes
  both the loop and the burn.
- **A gate refusal no longer spends an attempt.** Classified by REASON, never by status:
  every refusal that is not `invalid_request` (400) or a capability gap (503) comes back
  409, so a status rule would have retried `native_target_fenced` — "an earlier turn may
  or may not have been delivered" — up to 1,080 times. Reuses `queueableRefusal`, and
  fails CLOSED on an unrecognised reason.
- The attempt is still written and fsynced BEFORE the call, then REFUNDED once the
  outcome is known. Deferring the increment would have reopened the crash-safety hole
  the comment there describes, and a test reads `attempts` off disk mid-delivery to
  prove it.
- **The refusal reason is no longer discarded.** `deliver` read `body.error`; the attach
  route emits `reason` and has never emitted `error`, so every stored reason in the
  field was the literal `attach_409` and the whole feature was reason-blind. Also
  carries the turn route's own `retryable` verdict, which outranks our inference.


## 6.36.8
- **The queue now covers the refusal that actually fires.** Device diagnostics, once the
  path was finally instrumented, recorded `native_target_busy` on every Continue that
  reached the server — never `native_thread_working`, which is what 6.36.7 was built
  around. Selecting Continue SUCCEEDS and mints a binding; if the dictation is not
  completed the binding lingers to its TTL, and every Continue inside that window
  refuses. Twelve such bindings had stacked up on one thread over an evening.
- `native_target_busy` and `native_turn_in_progress` are now queueable. Both are
  transient by construction — a clock clears them — and both are COS's OWN bookkeeping
  rather than a foreign process holding the thread. Delivery still re-runs the full
  gate, so nothing about the safety model changes.
- `native_target_fenced` is deliberately NOT queueable: "may or may not have been
  delivered" cannot be resolved by waiting, and queueing it risks a duplicate turn in a
  real conversation.


## 6.36.7
- **A turn spoken at a busy thread is now queued instead of refused.** Miles: "if
  there's a session that's still running, that would just put it into the queue the same
  way that the user has the ability to do so." The thread was never stuck — measured at
  the moment he asked, its transcript mtime was 3s old against a 30s window, so the gate
  correctly read `working`. That is the trap: while you are talking to an agent in a
  thread, it is CONTINUOUSLY working, so Continue was unreachable for exactly the thread
  you most want to continue and Fork was the only door.
- **This does not weaken the attach gate, which is the whole design.** The queue defers
  to the gate rather than bypassing it: delivery re-runs the full occupancy check and
  can still refuse. Several tests exist only to prove that negative.
- Only occupancy reasons are queueable. A structural refusal — unsupported provider,
  malformed id, attach switched off — still refuses immediately, because telling someone
  their turn is queued when it can never run is worse than refusing it.
- **Delivery re-enters through the front door**, over loopback to this server's own
  attach and turn routes. Those carry the gate, the target fence, the per-target claim,
  the watermark, the idempotency ledger and the child-pid accounting; a second copy in a
  background worker would be a second place for the gate to drift.
- **The watermark exemption, approved explicitly by Miles.** A queued turn drains after
  the thread has moved on — that is what it waited for — so its binding is minted fresh
  at delivery. Checked as normal, a queue would fail 100% of the time. An interactive
  turn still gets the full divergence check.
- Ready means the turn ENDED (`result` / `turn_complete`, detected with the same parser
  the live stream uses), with the 30s idle clock as a backstop so a holder that dies
  cannot wedge the queue. Thirty seconds of silence alone would fire during a long tool
  call and inject into the middle of a turn.
- Durable under the data home, so it survives a server update and a pocketed phone. The
  attempt count is persisted BEFORE each delivery, so a crash mid-flight cannot reset
  the ceiling and retry forever. Six-hour TTL, 8 waiting per thread, 5 attempts, and a
  cancel route for the × control.


## 6.36.6
- **The session digest follows the thread instead of its opening.** Miles, from the
  lens: "It's currently showing a legacy session that I had over a day ago... The
  discussion should show the questions that we're asking and a summary of those most
  recent things, not something that's the 'first' message." The whole budget now goes
  to recency. `DIGEST_HEAD_TURNS` drops from 2 to 0 — a deliberate reversal of the
  earlier rule that reserved the opening ask because it "frames everything after it".
  The opening is not lost: `first_prompt` still carries it in full.
- **Harness-injected rows no longer render as things you asked.** A slash-command body
  and a compaction preamble are both written as USER rows, so both appeared in the
  DISCUSSION list. Filtered on the STRUCTURAL flags Claude already sets — `isMeta` and
  `isCompactSummary` — not on a markdown heuristic that could misfire on a real paste.
  The compaction preamble is also filtered by text as a fallback for providers that
  emit no flag, and that filter reaches titles and the search index too: the preamble
  is byte-identical across every compacted session, so as a title or a search hit it
  distinguishes nothing.
- **On a truncated read the head window no longer feeds the recency list.** The head
  window IS the session opening, and on a large session the 60-turn window never fills,
  so those turns survived at the top of the digest indefinitely. Measured on a real
  94 MiB session: both leading bullets were head-window turns from the previous day.
  A whole-file read is untouched — it yields `tail: true` for every line.
- Verified by parsing real transcripts, not fixtures: the 94 MiB session now leads with
  the two most recent asks, and an ordinary 2.7 MiB session renders nine recent turns
  in reading order.


## 6.36.5
- **A speaker merge now reaches the meetings, not just the voice store.**
  `merge-profiles` folded two profiles together and relabelled the calibration log,
  and stopped there. Meetings keep the speaker strings written at transcription time
  and the review panel re-reads them from disk, so every meeting recorded before a
  merge kept rendering two people forever — the merge fixed identification going
  forward and nothing behind it. Measured on the live library for one real merge:
  24 sidecars (111 labels) and 18 transcripts (70 labels) were stranded.
- The fan-out is a **pure string rewrite** — the same `relabelSidecarJson` and
  `relabelMeetingMarkdown` primitives the per-meeting relabel route uses, minus its
  `enrolNamedVoice` step. Re-enrolling would double-count audio the merge has already
  absorbed and drag the centroid, which matters at the margin: one recent merge moved
  a neighbouring speaker from 0.818 to 0.842.
- **The confirm gate now shows the blast radius before you approve it**, scoped to the
  names that would actually merge. Dry run is the default, writes are atomic, and the
  response names every file touched so the rewrite can be audited and diffed.
- Renames only what the store actually absorbed. A requested name that matched no
  profile is reported as missing and left alone everywhere — fanning out the requested
  list instead would have renamed a real person off the back of a typo.
- Reports what it cannot fix rather than passing over it: transcripts in the older
  `**Name**` label form are counted and surfaced, not silently skipped. On the live
  library that is 12 files carrying 58 labels a rename leaves behind.
- iCloud conflict copies are skipped by construction, including the compound-extension
  form (`sync 2.g2-chunks.json`) an earlier pass let through.

## 6.28.0
- **Continue Original Agent Thread — attach to a live desktop thread and append a turn
  to it.** From the glasses you can now continue a Claude Code or Codex conversation that
  already exists on your Mac: the turn is written into the REAL transcript, not a copy.
  Verified end to end on disposable threads for both providers.

  **OFF BY DEFAULT and permanently supported that way.** Set `COS_THREAD_ATTACH_ENABLED=1`
  to turn it on. With it unset you get exactly the behaviour that existed before: read-only
  session browsing and Fork-only everywhere. The two write routes are not registered at all
  when it is off, so a disabled server holds no reachable write code, and the attachability
  endpoint answers `attach_disabled` without touching the filesystem.

- **A thread that someone has open on the desktop is never written to.** COS resolves, from
  a first-party per-session registry, whether a live process owns the thread, and refuses
  with "Open on your Mac. Fork it instead." Ownership of COS's own spawned child is
  established from a measured kernel process start, because a bare pid can be recycled.

- **A repeated POST replays instead of delivering twice.** Turns carry a required client
  idempotency key and completed or ambiguous outcomes are remembered durably, so a retry
  after a lost response returns what the first turn did rather than posting a second copy
  into the conversation. A pre-delivery refusal stays re-evaluatable.

- **A turn whose fate is unknown is never reported as a clean failure.** If the provider
  fails after the prompt was delivered, the outcome is `ambiguous` with `retryable: false`
  and copy telling you to check the thread, because a retry there would double-post.

- No always-approve, bypass-permissions or sandbox-escape flag can reach a provider running
  an attached turn; the argv is checked before any process is created.

## 6.27.13
- **`POST /api/meeting/:sessionId/backfill-enrolment`** — train a profile from a voice
  that was named BEFORE enrolment shipped. Those meetings have a correct transcript and
  no profile, and re-running the rename cannot help: the voice is already a real name
  there, so the placeholder guard correctly declines. The live case is Kirstyn Blum —
  60 and 109 chunks across two meetings, 182 sidecar mentions, absent from a 77-profile
  store.
- The correction LEDGER already holds what enrolment needs: the original `from`, the
  `to`, and the exact chunk indices written at apply time. This replays those rows
  through the SAME `enrolNamedVoice` — raw-index mapping, refusal when unmappable,
  coherence, the diversity cap and the `correction:<sessionId>` tag all apply
  identically. No second implementation to drift.
- **Named-source corrections are excluded, by the existing rule rather than a new one.**
  `Ext -> Kirstyn` is training data; `Allison Wheeler -> Kirstyn` is a mis-attribution
  fix, and training on it would put Allison's voice into Kirstyn's profile. Both rows
  are reported; only the placeholder one attempts anything. Mutation-verified: dropping
  the placeholder guard fails that test.
- **Runs in-process, which is the point.** The voice store is owned by the running
  server and rewritten wholesale, so an external process that enrols directly has its
  work silently clobbered. Not hypothetical — an attempt on 2026-08-13 validated
  cleanly, selected 20 samples, and left the store untouched at its Aug 7 mtime.
- **Fails closed.** Without `confirm: true` it reports what it would enrol and writes
  nothing. The preview runs every gate — a preview that skipped them would be a guess
  about what the real call does — so `enrolNamedVoice` gained a `dryRun` flag. The
  projection can land HIGHER than reality, because only `enrollEmbedding` can judge
  near-duplicates against the live profile; that is documented on the flag.

## 6.27.12
- **Naming an unidentified voice creates a real speaker profile — correctly this time.**
  Re-enables what 6.27.10 shipped broken and 6.27.11 disabled.
- **The index join is fixed.** 6.27.10 fed COMPACTED sidecar positions to a store keyed
  on RAW capture indices; on a live session that enrolled 73 of 103 rows belonging to
  other people, 22 of them the owner. Enrolment now runs through
  `attachRawChunkIndices` and **refuses outright** when the mapping is not established —
  detected by reference identity, which is how that function signals "cannot map" —
  reporting `skipped: 'no_index_mapping'`. There is no fallback to positions anywhere.
- **`Ext` is a bucket, not a person, so coherence is checked.** Only the dominant
  MUTUALLY coherent cluster is enrolled and `clusterSkipped` reports the rest. Mutual
  rather than medoid-star on purpose: a seed sitting between two voices merges them
  otherwise. The floor is aliased from the exported `MERGE_SIMILARITY_FLOOR` so it
  cannot drift from the identifier's own accept threshold.
- **Samples are stamped `correction:<sessionId>`.** A bare tag matched none of the three
  prefixes `isSampleFromSession` accepts, so "Not in this meeting" — the app's only undo
  — would have retracted nothing, the samples would have counted as untraceable, and
  they would have landed in the weakest eviction tier with no correction quota.
- **Bounded.** `greedyDiversitySelect` caps at 20 before enrolling. Unbounded, ~41ms per
  cycle against a 7.9 MB store x 109 chunks blocked the event loop past the helper's 30s
  timeout, showing "Server stopped" for a correction that applied.
- **Reports honestly.** `enrolment: { enrolled, attempted, created, clusterSkipped,
  skipped }`. A zero is now legible instead of indistinguishable from success.
  `created: false` when appending to an existing profile, so nothing claims a profile
  was made when samples were added. `enrolledEmbeddings` retained for existing clients.
- **Tests, 28 -> 42, plus 14 on the selection lib.** The chunk-embedding mock is GONE:
  fixtures write real JSONL through the real encoder and the route reads it through the
  real decoder and index filter. That double mock is why 6.27.10 shipped — the join was
  never exercised, and a gapless 3-chunk fixture pinned the bug as the contract.
- Nine mutations, all landed in-target and confirmed present before each run. M1
  (bypass the mapping) fails four tests including "enrols the RAW-index embeddings,
  never the sidecar positions". M2 initially SURVIVED — the branch was unreached — so
  the test was fixed rather than the code.
- Known: `skipDedupCheck` stays at its default `false`, so near-duplicate samples are
  rejected and `enrolled` can fall below the 20 selected. Conservative and honestly
  reported; `/api/voice/enroll-ext` passes `true`.

## 6.27.11
- **SAFETY REVERT: the 6.27.10 relabel enrolment is disabled.** It joined two
  different index spaces. `plan.value.changed` are positions in the COMPACTED sidecar
  array (`meeting-relabel.ts:119`, over rows already filtered to those carrying text)
  while the chunk-embedding store is keyed on the RAW capture index
  (`transcribe-stream.ts:1868`). They diverge at the first text-less chunk.
- Measured on a live session: naming ONE voice enrolled **73 of 103 rows belonging to
  other people**, including **22 chunks of the owner**, plus five colleagues. It
  reported success because rows do come back — the wrong ones. 73 of 74 live sessions
  with embeddings have gaps, so this was the normal case, not an edge case.
- `attachRawChunkIndices` is the conversion for exactly this. It was already imported
  in the file, used correctly by the review path, and carries a comment three hundred
  lines above the change reading "`chunks` is NOT the WAV number".
- **Anyone on 6.27.10 should update.** Naming a voice in the review panel could write
  other people — including the owner — into that person's profile, permanently and
  across every future meeting. The relabel itself was always correct; only the
  enrolment side effect was wrong.

  Re-enabling requires all of: the `attachRawChunkIndices` mapping with a refusal when
  it is unavailable; a coherence gate (an `Ext` bucket is many voices — 98% of its
  pairwise cosines fall below the identifier's own 0.55 accept threshold); a
  `correction:<sessionId>` source tag so samples are human-tier, quota-protected and
  retractable by the existing de-attribute path (a bare `meeting-relabel` tag matches
  none of the three prefixes `isSampleFromSession` accepts, so "Not in this meeting"
  silently retracts nothing); `greedyDiversitySelect` to bound the loop (~41ms per
  cycle against a 7.9 MB store x 109 chunks blocks the event loop past the helper's
  30s timeout); and honest reporting so a zero enrolment is distinguishable from
  success. The COS Control scope-picker copy also still reads "Corrects this meeting
  only. Other meetings are left alone."

## 6.27.10
- **Naming an unidentified voice now creates a real profile.** `POST /api/meeting/:id/relabel`
  was TEXT ONLY: it rewrote `speaker` strings in the sidecar and never touched the
  voice store. Saving "Kirstyn Blum" over 109 segments labelled that one meeting and
  taught the system nothing — she never appeared in `/api/voice/profiles`, the review
  panel still offered her as `new name` inside the SAME meeting, no later meeting
  could match her, and there was no profile to add further chunks against.
  Verified on the live store: 77 profiles, no Kirstyn Blum, while both sidecars
  carried her name.
- The server already had `/api/voice/enroll-ext` for exactly this and the naming flow
  never called it. Relabel now enrols the embeddings of the chunks it actually
  changed, tagged `source: meeting-relabel` so a bad batch can be retracted wholesale.
- **Scoped deliberately.** Enrolment runs ONLY when a placeholder (`Ext`,
  `Unidentified N`, `Speaker N`, `Unknown`) becomes a real name. Correcting one real
  name to another is left alone: moving a voice between existing people is
  `merge-profiles`, which is explicit and confirmation-gated. A cross-roster sweep of
  this store put two DISTINCT people at 0.85 similarity, so implicit re-pointing would
  poison profiles.
- Enrolment happens after the sidecar and ledger are durable, and a throwing voice
  store cannot undo the rename the user asked for. `enrolledEmbeddings` is returned so
  the panel can confirm a profile was created.
- Four tests, both directions mutation-checked: reverting to text-only fails the
  enrolment test; dropping the placeholder guard fails both safety tests.

## 6.27.9
- **Large sessions open instead of 413ing.** `GET /api/agent-sessions/:provider/:id`
  answered `413 Session too large to open` for any transcript over 32 MiB, so the
  biggest sessions — the ones most worth reviewing before a follow-up — returned
  nothing at all. A 67 MB transcript is not exotic; this repo's own 2026-08-13 session
  is 70 MB. Oversized files are now read as a bounded **head (256 KiB) + tail
  (768 KiB)**. That 70 MB session parses in **7 ms** and yields a 1,286-char digest
  with both the opening ask and the most recent turns.
- Slicing at an arbitrary byte offset is safe because `parseJsonLine` returns null for
  the fragmentary first line of the tail window and the loop skips it.
- **`truncated` is reported, and the counts stop pretending.** On a partial read the
  message counts are counts of what was READ. The digest therefore prints
  `… middle of a large session not read …` instead of a turn number it cannot know —
  a confidently wrong "… 12 earlier turns …" on a 4,000-turn session is the same
  dishonesty as a silent cap.
- **Slash-command scaffolding no longer eats the two best slots.** `collectTurn` now
  applies the existing `isWrapperPrompt` filter and `<user_query>` stripping, so a
  digest opens with the real ask rather than `<command-message>…`.
- Window sizes are injectable. With production defaults any quick-to-build fixture is
  smaller than head+tail combined, so a test would read the whole file and pass
  identically with windowing REMOVED — it did, until a mutation caught it. The test
  now pins the read count and fails when windowing is dropped.

## 6.27.8
- **Session bodies get a real digest.** `GET /api/agent-sessions/:provider/:id` adds
  `discussion_digest`: up to **2000 chars** of what actually happened — the opening
  ask, the most recent user turns in order, and where the assistant left off.
- **The list row is untouched at 180.** Miles: "it should be in the body not the
  title, the row should be no more than the 180 characters." `discussion_summary`
  keeps its 180-char budget for the single-line row; the digest is a separate field
  the detail page reads. One shared field could not serve both — a 2000-char gist
  appended to a row destroys it.
- **No LLM, no extra reads.** `parseAgentSession` already streams every line of the
  transcript to count turns; it was discarding the middle. The digest is assembled
  from turns it is already parsing, so it costs no tokens and no additional I/O.
- **Elision is stated, never silent.** The store keeps the opening turns plus a
  60-turn recent window so a 900-turn session cannot balloon memory, and passes the
  TRUE turn count so the `… N earlier turns …` line reports what was really dropped
  rather than what the buffer happened to hold.
- Opening turns are reserved BEFORE recency. Filling from the end first starved the
  original ask out of a 40-turn session entirely — caught by its own test.
- Older clients ignore the field; older servers omit it and the glasses fall back to
  the 180-char summary.

## 6.27.7
- **`GET /api/agent-sessions` ships in the public package.** Claude Code, Codex,
  and Cursor transcripts from this Mac, last 7 days of writes. Glasses 6.8.360
  uses this instead of the Claude-only COS cache. Stock 6.27.6 404s that route.
- **Sessions list matches Control Updated.** Newest write first. Stale pins stay
  in the payload (any age) but do not cluster at the top — that is Control's
  Pinned clock, which glasses does not have.
- **Session discussion gist.** Agent-session list and detail include
  `discussion_summary`: first real user turn plus the latest assistant prose
  from a cheap transcript peek. No LLM. Glasses use it on the session row and
  detail; older clients ignore the field. `first_prompt` on the list is the
  first user turn, not a copy of the sidebar title.
- **Sessions lookup.** `GET /api/agent-sessions/search?q=` runs keyword over
  sidebar names, `/rename` titles, first prompts, and the first ~8k of user
  transcript — including chats older than the 7-day list window. Meaning search
  embeds the query once against those same texts (OpenAI key, no LLM). Keyword
  still returns if embeddings are down. Literal path, registered before
  `/agent-sessions/:provider/:sessionId`.
- **Sessions Pinned includes Claude Desktop stars and Cursor
  `pinnedComposers`.** Same rule as ChatGPT `pinned-thread-ids`: starred
  Claude sessions (including Desktop-only blobs with no `~/.claude` jsonl)
  and Cursor sidebar pins stay in the list at any age. Keep-warm `ready`
  rows still stay out.
- **Sessions hide CLI keep-warm `ready` rows** and Control provider-proof
  prompts so real chats fill the list.
- **Sessions keep ChatGPT pins and Cursor sidebar names.** Codex
  `pinned-thread-ids` stay in the list even when the jsonl is weeks old.
  Cursor rows use `composerHeaders.name` (the sidebar title) and skip the
  `empty-window` duplicate of the same chat.
- **Memory and Threads lookup.** `GET /api/memory/search?q=` and
  `GET /api/threads/search?q=` run keyword over local notes (first ~8k of each
  file, ~2k file budget) then, for memories only, one embedding against the
  existing `cos_memory` index via `bot_memory.py`. Threads have no embedding
  index — `semanticAvailable` is false and keyword still works. Literal paths,
  registered before `/:id`. Does not search meeting Qdrant. Additive; list and
  detail are unchanged.
- **Meeting library calendar filters.** `GET /api/meetings` accepts `month=YYYY-MM`
  and `day=YYYY-MM-DD`, raises the cap to 200 when either is set, and returns
  `months` plus per-day counts for that month. Unfiltered G2 lists stay at the
  existing 50-row cap. Additive — extra fields are ignored by older clients.
- **Meeting lookup.** `GET /api/meetings/search?q=` runs keyword over title,
  summary, and filename, then meaning search against the existing Qdrant
  meeting index (one query embedding, no LLM). Keyword still returns if Qdrant
  is down. Literal path, registered before `/meetings/:domain/:month/:filename`.
- **Reset live message count.** `POST /api/message-era/reset` with `{ confirm: true }`
  snapshots live sessions into the day archive, then starts short-numbering at
  #1. History is not deleted — ARCHIVE / Message History still resolve old
  stamps. Refuses without confirm, while a query is in flight, or if archive
  fails. Disk mtime is enough; no server restart. CLI
  `reset-message-era.ts --confirm` uses the same path.
- **Grok slot tracks newest high-fast.** `cursor-grok` now resolves to the
  newest `cursor-grok-<ver>-high-fast` from `agent models` (today 4.6). Low,
  medium, xhigh, and non-fast ids are ignored. Composer stays pinned to
  `composer-2.5-fast`. No EHPK change: the phone still sends the stable slot.
- **Clear stranded video uploads.** Sideload, crash, or a killed composer can
  leave a `receiving` draft for 4 hours. That draft holds `blocksRestart`, so
  Repair and Update stall on it instead of clearing it. `POST /api/media/video-upload/clear-stranded`
  cancels receiving drafts with no active writer and no bytes for 60 seconds.
  Finalizing and published receipts are left alone.

## 6.27.6
- **V2 original chunks are 1 MiB.** Same sequential one-in-flight loop, same
  ArrayBuffer bodies, same GET-progress resume. A 244 MB clip goes from 953
  round trips to ~239. That is the leftover ~10% against legacy 8 MiB, paid as
  per-chunk RTT, without opening a second fetch — two concurrent ArrayBuffer
  PUTs from this WebView are still an untested shape.
- **In-flight 256 KiB drafts keep their size.** `putOriginal` checks the
  session's own `chunkBytes`, not the live constant, so a draft that started
  before this upgrade still accepts 256 KiB parts and rejects a 1 MiB PUT into
  that slot. New inits advertise 1 MiB. Do not raise this above 1 MiB until the
  phone parser cap is raised first — above that, V2 capability parse returns
  null and the transport silently falls back to legacy.
- Frame parts stay 256 KiB. Protocol stays 1.

## 6.27.5
- **Chunk uploads now leave a server-side trace.** On 2026-08-12 a phone upload
  stalled on both media transports and the server was a complete blind spot: nothing
  recorded that a chunk request had arrived, so "the client never got the ack" could
  not be separated from "the server never sent one" without reading a staging file's
  mtime and running `netstat` by hand.
- `[media-chunk]` now logs one line per REQUEST (never per data event - a 237-chunk
  upload logging per `data` would bury the log): `body-read` when the body finishes
  arriving, `responded` with status when the response is fully flushed to the socket,
  `abandoned` when the client goes away mid-body, and `closed-unanswered` when the
  socket closes with no response written. Each carries bytes received and elapsed ms.
- `closed-unanswered` is the only case where blaming the server is correct, and it is
  now stated explicitly rather than inferred from absence of evidence. It gates on
  **`res` 'close', not `req` 'close'**: since Node 16 `IncomingMessage` emits 'close'
  when the REQUEST completes rather than when the socket does, so on an async handler
  (`putOriginal` and `putFrame` both are) it lands while `res.writableEnded` is still
  false. Gated on `req` it false-fired on EVERY successful V2 chunk — 237 bogus alarms
  per upload on the single most diagnostic line in the file. Caught by adversarial QA
  before release and pinned by a test that fails if the gate moves back.
- The two early refusals (`chunk_bytes_required` 400 and declared-Content-Length 413)
  returned BEFORE the tracer existed, so a chunk the server actively rejected logged
  nothing — the same silence as a request that never arrived. The tracer is now
  declared above them and every refusal logs.
- Diagnosis only. No behaviour change to any upload path.

## 6.27.4

### Fuzzy name corrections reach phone dictation

- `applyFuzzyCorrections` is now called inside `cleanOutboundDictation`, so text
  arriving at `POST /dictation/finalize` gets the same Levenshtein pass the
  server-transcription route has always had. It previously had exactly ONE call site
  (`transcribe-audio.ts:252`), which meant phone Moonshine dictation — which sends
  text, never audio — never received it. Verified by call-site enumeration, not by
  reading a single file.
- Runs BEFORE the autoclean LLM, so the model sees corrected proper nouns instead of
  being asked to guess at them, and it still helps on every path where autoclean is
  off, over the character cap, or breaker-open.
- Same target construction (`getAllSpeakerNames()` + `getVocabulary()`) and the same
  non-fatal posture as the existing call site: a correction pass is quality
  enhancement, never a durability dependency.

**Measured reach, so callers do not assume more than it delivers.** The distance
budget is 1 edit for 5-8 character words, so it catches single-edit misses
(`Austen` → Austin, `Nyala` → Niala) but NOT `Miyala` → Niala (2 edits) or
`Yukoma` → Ukaoma (3). Wiring it does **not** remove the need for explicit
`whisper_corrections` entries on multi-edit misses; the new test asserts both
directions so that is not re-derived later.

`Austin` deliberately untouched — `correctAustinJustin()` already owns that pair.

Pairs with app 6.8.346, which breadcrumbs the finalize call so a missing correction
can be told apart from a finalize step that never ran.

## 6.27.3

### Durable, resumable video transport (private canary)

- Replaces fragile single-request phone video uploads with a generation-pinned,
  resumable 256 KiB protocol whose accepted chunks survive server restarts.
- Adds idempotent init/finalize receipts, explicit acknowledgement and cancel,
  bounded draft retention, and maintenance status so updates cannot erase a
  video draft that is still being transferred or whose receipt is not stored.
- Keeps the published media record byte-compatible with 6.27.2: the original
  MP4/MOV remains required and the existing validated ffprobe/ffmpeg path stays
  the fallback. Phone frame extraction is separately gated until its physical
  iPhone decoder/canvas acceptance test executes.
- New V2 admission is disabled by default (`COS_VIDEO_UPLOAD_V2=0`). Existing
  V2 drafts remain observable, cancellable, and finalizable after the flag is
  turned off so rollback never strands accepted bytes.

## 6.27.2

### One finalizer for phone and Mac dictation

- Added authenticated `POST /api/dictation/finalize` for already-transcribed
  Moonshine text. It reuses the exact glossary, negative rules, Haiku/Sonnet
  polish, circuit breaker, token audit, and daily cap already used by recovered
  server prompt drafts.
- The route accepts bounded text only. Phone-local audio and rolling preview
  audio do not leave the iPhone, and a finalizer failure falls back to the
  deterministic glossary result instead of losing the transcription.
- Both Message commits and sealed Meeting preview phrases can use the same
  final quality pass while canonical Large-v3 meeting transcription remains
  unchanged.

## 6.27.1

### The 16-frame video from 6.27.0 now actually works end to end

6.27.0 raised video stills from 1-3 to 8-16 entirely inside the extractor. Four
consumers were never checked, and each one silently rejected what the extractor
had started writing. Every failure was invisible: three dropped an optional field
with no error, and the fourth threw only when the user asked a question.

- **A video of 75 seconds or longer 400'd when you asked about it.**
  `query-attachments.ts` capped model image inputs at 12 and threw a hard
  `too_many_attachment_frames` rather than trimming, while `round(75/6) = 13`
  frames. The video uploaded, stored its frames, and failed at ask time. The
  ceiling is now `VIDEO_SUMMARY_FRAMES_MAX`, expressed as the symbol so the two
  cannot drift again, and a test walks every duration to 30 minutes. Nothing in
  the suite had ever asserted `too_many_attachment_frames`.
- **A 16-frame video became an 8-frame video after any restart.**
  `sanitizeRecord` ran `derivativePaths.slice(0, 8)` on index load, so the record
  kept 16 frames in memory and 8 on reload - and Update Server restarts the
  server. The other 8 files stayed on disk orphaned: unreferenced, never served,
  never swept. PDFs are unaffected; their producer caps itself at 8.
- **`frameCount` above 8 was dropped by the parser.** `parseMediaAttachmentRef`
  is a whitelist and the field is optional, so the count vanished with no error
  for every video past ~90 seconds.
- **`bytes` above 64 MiB was dropped by the parser** - so the 100 MiB and chunked
  2 GiB videos shipped in 6.26.0 lost their byte count too. Raised to the chunked
  ceiling and pinned to it.
- `durationMs` above 1 hour was likewise dropped. Unreachable today behind the
  20-minute ingest cap, fixed now because it is the same one-line class and would
  have been the next invisible ceiling.

The parser bounds are now named constants documented as sanity bounds rather than
policy, mirrored from the server ceilings and pinned by test - `shared/` cannot
import `server/`, and an unpinned copy is what allowed all of this to drift.

Known limitation, unchanged: attaching three or more videos to one prompt still
returns 400, because 3 x the 8-frame floor exceeds the 16-input ceiling. Frames
are a video's only visual representation, so refusing is honest where silently
dropping half of one would not be.

New tests: 8 parser round-trip, 4 restart round-trip, 5 frame-budget. Every one
round-trips through the real reader - asserting on the writer is what missed all
four defects, since the writer was correct in every case. 8 mutations, all caught.

## 6.27.0

### Video review frames: 8-16 stills instead of 1-3

A video attachment is summarized from stills. The old rule was one still per 15
seconds, floored at 1 and capped at 8, which gave a 12 second clip **one** frame
and a 44 second clip **three** - not enough to tell what a video contains. Miles,
on a fridge sweep: "it only selects three chunks from the video."

- Frame count is now `clamp(round(seconds / 6), 8, 16)`. A 12s clip and a 44s
  clip both get 8; a 72s clip gets 12; anything past 96s gets 16.
- Each frame is the **sharpest** of 5 candidates sampled around its position,
  ranked by encoded JPEG size at fixed quality. Measured on real footage the
  spread within one second was 1.45x, and the large frame read product label
  text that the small one rendered as smear.
- Candidate count is `frames * 5`, so a 20 minute recording costs the same temp
  I/O as a 12 second one - the sampling rate adapts, the work does not grow.
- Fixed an upscale: `scale=1280:-2` was enlarging a 480x360 source to 1280x960,
  paying roughly 7x the image tokens for detail that was never captured. Now
  `scale='min(1280,iw)':-2`, so small sources pass through at native size.
- `MAX_DERIVATIVE_IMAGES` (8) is untouched, so PDF page extraction is unchanged.
  Video no longer shares that constant.

## 6.26.0

Chunked, resumable upload: video is no longer limited by what fits in one request.

- A video can now be uploaded in pieces, so length is bounded by storage rather than by a
  single request. A 3-minute 4K clip is roughly 570 MB and could never fit a one-shot
  limit; it now transfers as a sequence of 8 MiB chunks, losslessly, and is compressed
  afterwards for storage.
- Interrupted uploads resume. The phone asks the server what it actually received and
  continues from there rather than trusting its own count, because a chunk whose
  acknowledgement was lost makes the client's number wrong. Resume covers network drops,
  which is the common case; a server restart clears in-flight uploads and the phone starts
  over cleanly rather than resuming onto nothing.
- Cancelling or giving up releases the server's slot and staging disk immediately instead
  of holding them for four hours. Without this, a handful of give-ups on a poor connection
  could make new uploads unavailable until the sessions expired.
- Assembly is verified before anything is published: the reassembled size must match what
  the phone declared, a chunk that arrives out of order is refused rather than appended,
  and a partial write is rejected rather than producing a correctly-sized file with a hole
  in it.
- Finalizing a chunked upload runs the same validation, size cap, atomic publish and
  background compression as a single-shot upload — one path, so the safety rules cannot
  drift between them. Only video is allowed the larger chunked ceiling; documents and
  images keep the existing limit, because reading a multi-gigabyte text file into memory
  would fail in a far worse way than refusing it.
- `GET /api/health` advertises chunked availability and the chunk size, so the phone
  decides from what this server actually supports rather than from a built-in assumption.

## 6.25.0

Large video uploads: a 100 MiB cap, streamed to disk, compressed in the background.

- Video attachments may now be up to 100 MiB. Images and documents stay at 64 MiB, and
  the kind is decided from the file's magic bytes rather than its declared Content-Type,
  so a declared video type cannot buy the larger ceiling.
- Uploads no longer buffer in memory. The body streams into the existing staging
  directory and moves into place through the hardened atomic rename, with the byte
  ceiling enforced during the stream so an oversized body is refused about one chunk
  past the limit instead of after landing in full. `GET /api/media/:id/content` is
  streamed for the same reason — raising the cap had otherwise taken that route's peak
  allocation from 64 MiB to 100 MiB per concurrent download.
- `requestTimeout` is now explicit at 900s on both listeners. Node's 300s default was
  invisible at 64 MiB but would have destroyed a 100 MiB upload's socket roughly 140
  seconds before the client's own deadline, breaking exactly the size band this enables.
  900s is the client's own ceiling, so the client always gives up first and can report a
  real diagnostic instead of an opaque network error.
- Stored videos are compressed in the background with `libx265 -crf 30`, measured at
  2.7x smaller and SSIM 0.969 on a real 4K 30fps upload. Resolution and frame rate are
  never reduced, because that is what later frame-by-frame review depends on and
  upscaling cannot recover it. An encode that is not smaller, or that fails, or that
  changes the geometry, leaves the original in place — there is no path where the only
  copy is lost. Requires ffmpeg and ffprobe; without them the original is simply kept.
- `GET /api/health` publishes `mediaLimits`, so the phone no longer hardcodes a byte cap
  that can drift from what this server will actually accept. Chunked upload is
  advertised as unavailable because its endpoints are not mounted yet.

## 6.24.5

COS Control provider proofs now isolate themselves from project customizations.

- Claude Code 2.1.227 began rejecting the automated readiness check in large COS
  workspaces because it loaded project instructions, skills, plugins, and attachment
  context before evaluating the tiny proof prompt. The request exceeded 200k tokens
  and exited 1 even though Claude authentication and normal commands were healthy.
- The no-tool readiness subprocess now uses Claude Safe Mode. It still proves the
  installed CLI, authentication, model access, process lifecycle, and exact response,
  while avoiding unrelated workspace context. Normal glasses queries are unchanged.

## 6.24.4

Rich-media attachments extend the established authenticated photo pipeline without
changing meeting capture, transcription, recovery, or G2 image transport.

- `POST /api/media/file` accepts bounded raw uploads for TXT, Markdown, CSV, JSON,
  PDF, MP4, and MOV. It rejects URLs, caller-supplied paths, unsupported formats,
  malformed bytes, files over 64 MiB, and videos over 20 minutes.
- Text is decoded strictly; PDFs become bounded extracted text plus page stills;
  videos become at most eight JPEG stills. Originals, extracted text, and frames
  stay in the private media store. The public attachment reference contains only
  typed metadata and a stable opaque ID.
- Claude Code and Codex receive quoted document text and/or local derivative images.
  Stored attachment content is explicitly untrusted reference data, never
  instructions. Durable jobs persist only attachment IDs and regenerate their
  bounded prompt inputs when the run starts.
- Health now reports coarse PDF/video processor readiness without leaking paths.
  Missing `ffmpeg`/`ffprobe` or Poppler tools fail with typed, actionable errors.
- Media index containment is component-exact. Invalid records quarantine the index
  and preserve owned bytes instead of enabling orphan cleanup.

Proof: 460 suites / 1,515 tests, isolated runtime directory, plus clean TypeScript.

## 6.24.3

Auto-recovery of quarantined audio has never run in production. Miles saw the symptom
for three turns: "1 recoverable" that opening the phone app could not clear.

- **My call sat inside a bare `catch {}`.** `autoRecoverOneQuarantinedCapture()` was one
  line after `purgeExpiredQuarantine()` inside the orphan-audio sweep's
  `try { ... } catch {}`, so any throw in that sweep meant auto-recovery silently never
  executed — on 6.23.1, 6.24.0, 6.24.1 and 6.24.2. Zero `[quarantine]` lines in a 48 MB
  log across every one of those releases. It now has its own try, because recovering
  quarantined audio has nothing to do with sweeping orphaned session-audio dirs and must
  not depend on that succeeding.
- **That bare catch is why it took three turns to find.** Three minutes of watching a
  live server produced no recovery, no log, and nothing to reason about, because the
  error was discarded. Both catches now report. I chased three wrong causes first — a
  closed admissions gate (`admissionsOpen` was `true`), a stale npm cache (real, but a
  different bug), and a broken picker (it selects the item correctly against live data).
- **A one-chunk capture is no longer advertised as recoverable.**
  `meeting_1786393815060_tp693w` held ONE 5.6-second chunk that transcribed to silence.
  Recovering it would have produced an empty meeting titled "Recovered capture (audio
  only)"; advertising it produced a badge with instructions that cannot work, since a
  server-side quarantine has no deferred phone save to land. `MIN_RECOVERABLE_CHUNKS`
  is 2, and `isWorthRecovering` is the SINGLE definition used by the picker AND by both
  warning counts — two definitions would let the badge claim something the sweeper has
  already decided to skip.
- No audio is deleted by any of this. Quarantine retention still owns expiry.

Coverage: 8 mutations, all caught. The placement mutations were first measured against a
RED baseline and re-run once green, because a mutation against a failing tree proves
nothing. Three of those red iterations were my own test windowing, never the fix: a
file-wide ban that hit a second legitimate bare catch, a fixed-width slice that ran past
the fix, and an `indexOf` that matched the function definition instead of the call site.

Full suite 1505 serially, tsc clean, gate after the bump.

## 6.24.2

The empty-recording restart lock, split out of 6.24.1.

**Correction to 6.24.1's own entry.** These bullets were written under 6.24.1 while it
was still unpublished, but it had already gone to the registry by then, so that heading
described a published artifact that does not contain this code. Verified by downloading
the published tarball: 6.24.1 carries the `project` field and has no
`EMPTY_SESSION_STALE_MS`. Moved here rather than left standing.

- **A 6-second aborted recording no longer locks the restart for 30 minutes.**
  `getTranscriptionSessionLiveness` gated purely on elapsed time. The 30-minute grace
  exists to protect a real recording that has gone briefly quiet — a backgrounded phone
  buffering to IndexedDB — but a session with NO canonical text has nothing to protect.
  Observed 2026-08-10: `meeting_1786393815060_tp693w` started, received one 5.6s chunk
  that transcribed to empty, stopped 6.2 seconds later, and then blocked Update Server.
  A session idle past `EMPTY_SESSION_STALE_MS` (2 minutes) with zero canonical chunks
  now stops blocking a restart.
- **Why that cannot reap a live recording.** `lastActivityAt` is bumped on chunk
  ARRIVAL, before any text filtering, so a live recording in a silent room keeps
  arriving every ~10s and never goes idle at all; its silent chunks land in
  `emptyCompletions`, not `chunks`. Gating on emptiness ALONE would kill exactly that
  session, which is why the rule requires emptiness AND idleness. Counted on canonical
  text rather than array length, because the array is sparse and a silent chunk carries
  no text — the precise shape an aborted recording leaves behind.

## 6.24.1

Surfaces `project` on session rows, so the list can group the way Claude Code's own
sidebar does.

- The indexer was scanning ONE project directory. `PROJECTS_DIR` was hardcoded to
  MU-Chief-Staff, so 17 of 18 project dirs — `cos-glasses-app`, `cos-glasses-server`,
  the 119 projects, the COS examples — were never indexed at all. That is why the
  Sessions list could never match the sidebar: entire projects were absent, not just
  mislabelled. Fixed in session_indexer.py (COS repo); 1,212 sessions now carry a
  project where 1,000 were visible before.
- `project` comes from the `cwd` on the session records, not from decoding the
  directory name. Claude Code replaces path separators with dashes and a real dash is
  indistinguishable from a separator afterwards, so
  `-Users-ukaoma-Documents-GitHub-Ukaoma-Chief-Of-Staff-MU-Chief-Staff` decoded to
  "Ukaoma-Chief-Of-Staff-MU-Chief-Staff" where the sidebar says "MU-Chief-Staff".

## 6.24.0

The Sessions tab stops 404ing, and a read-only presence view of Claude Code
sessions on this Mac arrives behind a flag.

- **`/api/session-index` was never ported into the published package.** The route
  lives in the private app repo and is mounted there; the companion has been calling
  it and getting an Express HTML 404 since the managed-runtime cutover. Same class as
  the stranded voice profiles, the npmignore-excluded speaker model and the stranded
  `.cos-profile.json`.
- **Ported rather than retired, against the original recommendation.**
  `/api/sessions/recent` looked like a duplicate and is not: it reads an IN-MEMORY map
  on a 24-hour window, carries no `domain` and no `device_id`, gives `lastQuery` where
  the companion wants `first_prompt`, dies on restart, and has no counterpart at all
  for the detail view's `tools_used`, `files_touched`, `git_branch` and token counts.
  `lib/session-cache-writer.ts` already writes the disk cache, so only the reader was
  missing.
- **Four defects fixed in the port, all measured on the real 37,700-entry cache.**
  An unset `COS_SCRIPTS_DIR` returned `[]` — a 200 that reads as "you have no
  sessions" on every standalone install — now 503 with `reason: pythonBridgeState()`.
  `err.message` leaked filesystem paths; now a generic reason, detail to the log.
  31.7 MB was parsed synchronously per request, the detail endpoint included, on a
  process that also streams live audio; now async and cached against file identity
  (161ms cold, 15ms warm). And the filename filter matched iCloud sync-conflict
  duplicates: `.session_index_cache_Ukaoma-Mac-Studio 3.json` shared 543 of its 602
  rows with the canonical file, so the merged list served 543 duplicates. Verified on
  real data: 37,700 naive becomes 37,157 served, exactly 543 removed. Filtering ` N`
  filenames would have been wrong in the other direction, since ` 2.json` holds 245
  rows appearing nowhere else, so dedupe is by session_id with newest winning.
- **New `GET /api/claude-sessions`, off unless `COS_CLAUDE_SESSIONS_ENABLED=1`.**
  It projects another product's 0700 state directory over a socket bound to 0.0.0.0
  behind a private-network allowlist, so in a published package that has to be opt-in.
  Named `claude-sessions` rather than `peers` because COS already overloads "session"
  three ways and the glasses, phone and server are all arguably peers.
- **Redaction is decided by `nameSource`, and only `derived` passes.** `auto` means an
  LLM wrote the label FROM THE WORK, and `/rename` clears the field entirely, so a
  missing `nameSource` is a renamed session rather than a derived one. Anything but an
  exact `derived` is replaced with the recomputed folder name and flagged
  `nameRedacted`. Echoing `name` while redacting `cwd` would not have been redaction.
- **Reachability is a conjunction: alive AND a declared socket path AND that file
  present.** Each alone is a false positive. Verified live: the 2.1.222 row reports
  `reachable: false` for having no socket path, and `/tmp/cc-socks` holds an orphaned
  `.sock` whose pid is dead and whose registry file is already gone, because sockets
  are not reaped. Liveness is a signal 0, never inferred from mtime, and EPERM
  resolves to false rather than true.
- Fields are named explicitly, never spread. The writer can also emit `logPath` (a
  full path), `agent`, `jobId`, `bridgeSessionId` and `parkedJobId`. Verified against
  the live registry: no `/Users/`, no `cc-socks`, no `logPath`, no `cwd` on the wire.
- Registry reads honor `CLAUDE_CONFIG_DIR`, match `<pid>.json` strictly rather than
  `*.json`, `lstat` to refuse symlinks, and treat an ENOENT mid-read as normal because
  the reaper is actively unlinking.

- **Session labels you can actually read, and machine sessions you can hide.** The
  list is only useful if the rows have names. Measured 2026-08-10: `first_prompt` took
  the first user message unconditionally, so a slash-command session was labelled
  `<command-message>cos-glasses</command-message>`, a proxy session was labelled "You
  are the COS Slack Bridge proxy", and everything else fell back to a random slug
  (`crispy-coalescing-salamander`) or the bare UUID. Fixed in the Python indexer with a
  filter, not an LLM: wrappers are stripped, a slash command keeps its name, injected
  persona prompts are rejected. `custom_title` now carries Claude Code's own sidebar
  title where the user set one — `3dc7e253` correctly reads "COS-glasses Server work
  (meetings)". New `display_label` resolves title, then derived label, then short id,
  and falls back for the 37,157 rows written before these fields existed.
- **`?human=1` hides harness-opened sessions.** 1,045 of 1,210 local sessions are proxy
  calls, readiness probes and hook spawns; roughly 165 were opened by a person, which is
  the order of magnitude Claude Code's own sidebar shows. `machine_spawned` is strict
  `=== true`, so a bad value fails OPEN — losing a session the user had is worse than
  showing a machine one.
- **`COS_CLAUDE_SESSIONS_SHOW_NAMES=1` opts into real session names.** Redaction stays
  the default so the published package is safe for anyone, but on an owner's own machine
  it deleted the whole value of the view, since the names are how you tell one session
  from another. Deliberately a SEPARATE switch from the enable flag: turning the feature
  on must not silently turn redaction off. Opting in still never exposes a path or an
  unlisted field.

**Sending messages from the glasses stays closed, not parked.** COS launches Claude
with `--dangerously-skip-permissions` in BOTH branches of `claude-permissions.ts:44`,
so there is no configuration in which an inbound message reaches a receiver that
would prompt. Combined with the 0.0.0.0 bind, that is a LAN-token-to-RCE path.

Coverage: 75 tests across the two routes, 20 mutations all caught. One was an invalid
experiment first time round — the 500 responder is identical in both handlers, so
mutating them together looked covered; mutated one at a time the list site was caught
and the DETAIL site SURVIVED, which found a genuinely untested leak path.

## 6.23.1

Closes the hole 6.23.0 left open, plus a lockfile version that 6.23.0 shipped out of
sync with package.json.

- **A restart used to re-open the bug.** 6.23.0 saves a stranded capture at the
  4-hour cutoff, but only while the server stays up. `recoverSessions()` refuses to
  load any session already past that cutoff at boot — it tombstones it — so a
  restart, a COS Control update, or a crash at the wrong moment meant the sweeper
  never saw the session and its audio landed in quarantine with no meeting. Not
  hypothetical: `meeting_1786237535593` (139 chunks, 31 MB, `idle_expiry_unsaved`)
  arrived there that way.
- **Quarantined audio now recovers itself.** The same 60-second tick picks ONE
  unrecovered capture with chunks and asks the real
  `POST /api/meeting/orphans/:id/recover` to turn it into a meeting. One at a time
  because that route runs a full batch transcription — real GPU work, minutes for a
  long capture — and a parallel backlog would starve a live recording. Oldest first,
  since it is closest to the 72-hour purge.
- **It gives up rather than looping.** Three attempts per capture, then it stops and
  says so. A capture with unreadable chunks would otherwise be retried every 60
  seconds for three days. The audio stays quarantined and recoverable by hand, which
  beats a retry loop that never converges. A 409 from a manual recovery does not burn
  the budget.
- Recovered captures are titled "Recovered capture (audio only)", distinct from a
  promoted session's "Auto-saved capture", because a quarantine recovery has no live
  ASR and every speaker comes back Unknown. The library should say which is which
  without opening the file.
- **`package-lock.json` was still on 6.22.1 while package.json said 6.23.0.** Caught
  by the repo's own `launcher-contract` test, which I did not re-run after bumping the
  version. The published 6.23.0 code is unaffected; the lockfile is now aligned and
  the suite runs after the bump, not before it.

Verified live before this release: a backdated synthetic session was recovered at
boot, drafted by the sweeper within 60s, and promoted to a meeting at the cutoff
about 40s later, with the draft cleared and the domain inferred rather than
hardcoded. 14 new tests here, full suite 1425 serially.

## 6.23.0

A recording whose phone goes away now becomes a meeting on its own. Miles: "we end
up with a meeting that is orphaned that we have no ability to keep."

Found live while writing this: two sessions stranded for 184 and 24 minutes, holding
the restart lock, while `GET /api/meeting/orphans` answered `count: 0`. Both saved at
100% transfer integrity (529/529 and 23/23 chunks). Nothing had been lost — but
nothing was going to turn them into meetings either.

- **The audio was never the problem.** A stranded capture stays live in memory for 4
  hours, then closes as `expired` and its chunks move to quarantine for 72 more. A
  76-hour window in which the audio exists and NOTHING converts it into a meeting
  unless a human notices. Expiry produced preserved evidence, not a meeting.
- **The 60-second sweeper already existed and already detected these.** It called
  `closeTranscriptSession(id, 'expired')`. The change is the disposition at the
  cutoff, not new scheduling: it now finalizes through `POST /api/meeting/save`,
  which keeps the live ASR transcript and its speaker labels. The quarantine recover
  route was the wrong tool here — its output labels every speaker Unknown, because no
  live ASR ever ran on it.
- **Staleness never closes a session early, and it must not.** The companion buffers
  to IndexedDB while iOS suspends the WebView and drains on foreground, and it
  restores `restoredSessionId` across a relaunch — so a phone silent for 30 minutes
  can still deliver its tail into the same session id. Close it and `isSessionDeleted`
  answers 410 Gone: a truncated meeting AND a second orphan. At the stale threshold a
  readable draft is written and the session stays open.
- **`/api/meeting/orphans` and `/api/health` were blind to the state that matters.**
  Both listed only QUARANTINED directories, and a stranded session is not quarantined
  for four hours. New `stranded` / `stranded_captures` report idle minutes, captured
  minutes, chunk count, when the sweeper will save it, and whether a draft exists.
- **Quiet is not failure.** A heartbeat carrying `audioState` is now kept per session
  and can VETO a stale verdict — a phone that says it is recording is alive even with
  no chunk arriving, because its uploads may merely be blocked. A BACKGROUNDED phone
  counts as capturing; requiring `visibilityState: visible` would reap exactly the
  sessions the drain path exists to rescue. Absence proves nothing in the other
  direction: `clientLog` is fire-and-forget and lossy, so a missing heartbeat can
  never itself mark a session dead. Chunk arrival decides.
- **One definition of stale.** `RECORDING_SESSION_STALE_MS` is now derived from
  `STRANDED_STALE_MS` rather than being a second literal. Two subsystems disagreeing
  about what a live recording is, is precisely how the panel could read "2
  recording(s) active" while the orphan endpoint reported none.
- A failed auto-save does not throw away a savable capture: `no_token` and 5xx and
  transport failures retry on the next sweep, 409 yields to the save that already owns
  the session, and only a terminal 4xx (or an 8-hour backstop) falls back to the old
  close-and-quarantine.

Coverage: 59 tests over the new modules, 23 mutations all caught. Three of those
initially SURVIVED — the whole stale branch deleted, the token gate deleted, and the
terminal draft cleanup deleted — because the loop lived inside a `setInterval` in a
module no test can import without executing boot recovery, a timer, and writes to the
real data home. It was extracted with injected dependencies rather than covered by
source-shape assertions. Full suite green serially (1411 tests); two unrelated files
flake under file parallelism, which is a pre-existing isolation bug.

## 6.22.1

Notes attached from somewhere else by a symlink are now read properly. Found by
Queen within hours of 6.22.0, on the very first real setup.

- **A symlinked subfolder or file was silently skipped.** `readdirSync` reports a
  symlink as `isSymbolicLink()`, never as `isDirectory()` or `isFile()`, so the walk
  ignored every link it met. A top-level `memory -> /elsewhere` link worked only by
  accident, because the folder LOOKUP uses `statSync` and follows links while the
  walk did not. Anything linked one level deeper vanished with no error at all.
- Attaching an existing store is a primary way to adopt this feature, not an edge
  case, so a link now behaves like whatever it points at: a linked folder is walked,
  a linked note is read, and a broken link is skipped without failing the read.
- **Cycles terminate.** Following links makes `memory/loop -> memory` fatal, so every
  directory is now visited once by resolved real path. The same identity check stops
  a store reached through two different links being counted twice.
- **No depth limit.** An earlier draft of this fix capped nesting at 16 levels; that
  guarded nothing real (cycles terminate on identity, and the file cap already bounds
  the work) while silently hiding notes nested deeper. Removed.
- The status counter and the reader walk the same way, so the header count and the
  list can no longer disagree.

## 6.22.0

Memory and Threads now work without a Python bridge, a venv, or a vector
database. Point COS Data at a folder holding `memory/` or `threads/` markdown and
they are browsable immediately.

This is the move that made Meetings adoptable, applied to context: the
requirement collapses to markdown files in folders. Any nesting, any filename,
front matter optional. `type` comes from front matter, else the containing folder
name, else `note`; ordering from a front-matter date, else a date in the filename,
else mtime.

- **Backwards compatible by construction, not by promise.** The file tier is
  reachable only from the branch `callPython` takes when the bridge is ABSENT. An
  install with a working venv and `cos_api_bridge.py` never executes a line of it,
  so its behaviour cannot change. There is no merged resolver to get wrong, no
  migration, no reindex, and no profile edit. A test reads `python-bridge.ts` and
  fails if the bridge path ever references the file tier.
- **The routes were the real gate.** `/api/memory`, `/api/memory/:id`,
  `/api/memory/overview`, `/api/threads` and `/api/threads/:id` returned 503
  before `callPython` was ever called, so a fallback inside the bridge would have
  changed nothing observable. They now gate on whether ANY source can answer.
- **`/api/context/status` reports a file store as available**, with
  `source: "bridge" | "files"` so a client can say which tier it is showing
  instead of implying a vector store that is not there. Absent on older servers.
  `stale` is 0 for file threads because nothing computed staleness — that is the
  truth, not a default.
- **File ids are namespaced `file_`,** disjoint from `mem_`, so a reference is
  never ambiguous about which store it addresses. `MEMORY_ID_PATTERN` accepts
  both; it previously required `mem_`, which silently dropped every file-backed
  row from the list and returned a 200 containing nothing.
- **`COS_CONTEXT_DIR`** points the tier anywhere and is exclusive when set.
  Otherwise `COS_OPERATIONS_DIR`, `COS_MEETINGS_ROOT` and its parent, the parent
  of `COS_SCRIPTS_DIR`, then `~/.cos-glasses` — so `mkdir ~/.cos-glasses/memory`
  is a complete setup.
- Amendments are NOT in this release. Reads only.

## 6.21.36

Security and accuracy fixes for the 6.21.35 context browser. Two claims in that
release's notes were false; both are corrected here and the claims restated
honestly.

- **Local filesystem paths were reaching the lens.** 6.21.35 said "no filesystem
  paths are exposed." Three shapes leaked, each reproduced against the live store:
  a tilde path lost only its `~/` and shipped the rest
  (`~/.cos-glasses/data/voice-profiles.json`); a path with no whitespace before it
  never matched at all (`KEY=/Users/...`, `>/Users/...`, `,/Users/...`); and a path
  containing spaces stopped at the first space. The pattern is now anchored to real
  filesystem roots, which also stops it corrupting API routes — `/api/health` and
  `/v1/chat/completions` were being replaced with `[local path hidden]`, and that
  same redacted string is sent to the model as evidence, so a follow-up about a
  route lost its subject. UNC paths are covered too.

- **Eleven credential families were passing through**, each demonstrated with a
  correctly-shaped value: HubSpot `pat-`, GitHub `github_pat_`, Slack `xapp-` and
  `xoxd-`, Google `GOCSPX-`, `npm_`, Stripe `(sk|rk|pk)_live_`, AWS `ASIA` key ids
  and unprefixed 40-char secret keys, GitLab `glpat-`, SSH2/PuTTY key headers, and
  `redis://:password@host` where the username is empty. `PWD=` and `PASS=` are now
  treated as credential names.

  Conversely `MAX_THINKING_TOKENS=31999` was being redacted as a secret — a bare
  integer is not a credential, and redacting a real setting corrupts evidence
  without protecting anything.

- **Malformed bridge protocols were relabeled as protocol 1** — precisely what
  6.21.35's notes said it prevented. `finiteInteger` ran `Math.trunc(Number(v))`
  before the comparison, so `'1'`, `1.5`, `1.9`, `true` and `[1]` all became `1`
  and were served as compatible, with the reported field rewritten to `1` so
  Control could not see what it had been handed. The check is now strict and
  pre-coercion, and an incompatible protocol is reported as its raw integer or 0,
  never a truncated 1.

- **Three browse routes could CREATE the Qdrant collection.** `/api/memory`,
  `/api/memory/:id` and `/api/memory/overview` called `ensure_collection()`, so a
  read-only G2 browse against a machine with no collection wrote a new empty one
  and made a broken setup look healthy. They now pass `ensure=False`.
  `get_summary_stats` already documented this exact reasoning and deliberately
  omitted the call; the browse paths did not follow it.

Tests were written to fail first: 21 new assertions reproduced real leaks against
6.21.35 before any pattern changed. One pre-existing assertion changed by a single
character — the old pattern's segment class included a comma and reported
`file.txt,` as the filename.

## 6.21.35

- Adds authenticated `/api/context/status` proof so Control and the companion
  distinguish a healthy empty store from missing, outdated, or degraded COS data.
- Preserves manual-thread meetings, milestones, sources, and initial notes across
  the Python bridge while bounding list/detail payloads.
- Fixes recent-memory ordering for stores larger than 2,000 points by paging the
  full filtered collection before selecting the newest results.
- Broadens phone-safe redaction for credentials, tokens, private keys, Windows and
  file-URI paths, and keeps browser-only memory reads retention-neutral.
- Caches the full memory type overview briefly to avoid repeatedly scanning a
  large store while users browse.
- Rejects future or malformed COS Data bridge protocols instead of relabeling
  them as protocol 1, so Control and the companion fail closed on incompatibility.
- Quotes referenced Meeting, Memory, and Thread bodies as untrusted source data:
  they remain factual evidence but can never become a prompt-instruction channel.

## 6.21.34

- **Memory and Threads are now real production surfaces.** Authenticated
  `/api/memory` and `/api/threads` list/detail routes expose bounded read-only
  projections from the configured COS pipeline instead of returning 404.
- **Stable references, not storage internals.** Memory uses its logical
  `mem_...` ID and Threads use their existing stable ID. Responses never expose
  embeddings, Qdrant point IDs, raw cache files, secrets, or local paths.
- **Memory overview is complete.** The store total and type split scan the full
  collection instead of silently stopping after the first 1,000 records.
- **Manual threads remain visible immediately.** The bridge merges the computed
  thread cache with the durable manual-thread store without mutating either.
- **Standalone installs fail honestly.** Systems without a COS scripts pipeline
  return empty/unavailable shapes while the rest of the glasses server remains
  usable.

## 6.21.33

- **Existing meeting libraries can be selected directly.** `COS_MEETINGS_ROOT`
  now accepts `meetings/YYYY-MM/*.md` as a read-only library, while
  `COS_OPERATIONS_DIR` continues to own multi-domain enrichment and writes.
- **Mixed libraries stay coherent.** Review Meetings merges direct, enriched
  operations, and standalone G2 records, dedupes by session identity, and
  prefers the writable enriched copy when one exists.
- **Upgrades remain compatible.** A legacy multi-domain
  `COS_MEETINGS_ROOT` keeps its prior operations-root meaning. Invalid explicit
  roots report a degraded state instead of silently switching libraries.
- **Read-only means read-only.** Direct-library speaker mutations return a
  typed conflict, paths and symlinks are contained, scans are bounded, and
  public health never exposes the selected filesystem path.

## 6.21.32

- **Adaptive meeting-audio cleanup is a default-off, replay-only canary.** When
  `COS_MEETING_AUDIO_ADAPTIVE_PLAYBACK=1`, the authenticated retained-audio
  playback route profiles each PCM chunk as hot/clipped, hot, quiet,
  wind/noisy, or clean indoor, then generates a bounded cleaned WAV on first
  play. Later plays use the cached copy.
- **Raw evidence is immutable and remains the fallback.** Derived files live
  beside retained raw chunks under a versioned name, count against the existing
  8 GB archive cap, and cannot extend the seven-day retention clock. Unsupported
  WAVs, missing FFmpeg, timeouts, and invalid output all serve the original raw
  file. Cache-orphan cleanup deletes only directories proven to contain derived
  playback files alone; unknown entries or failed stats retain the directory.
  `?raw=1` provides an authenticated per-request A/B escape hatch.
- **A live recording always wins.** Play requests made while any meeting is
  actively recording bypass cleanup and serve raw. If recording starts after
  cleanup was admitted, the one global cleanup worker is preempted within
  100 ms; requests for other chunks while it is busy immediately serve raw.
  FFmpeg falls back inside eight seconds, ahead of Control's media deadline.
- **No live or canonical path changed.** Capture, Turbo preview, Large-v3
  canonical transcription, speaker attribution, meeting save, HQ polish, and
  meeting sync do not import or call the cleanup module. Health reports the
  active policy, generated/cache/fallback counters, and raw-preservation
  contract for COS Control and field diagnostics.

## 6.21.31

Domains belong to the user. Four places in this codebase hardcoded ONE user's
business units, a fifth pretended to make them configurable, and two of them
disagreed with each other. A second person set up their own COS on 2026-08-08 and
nothing she could name would work.

- **New `lib/domains.ts` — one definition of each of these, replacing five.** What
  it replaced: `['quilt','sprocket_rocket','hermit_crabs','personal']` in the
  operations lister (used for listing, sidecar lookup, filtering, AND as the
  path-traversal guard); a hand-written badge table; `domain.slice(0,2)` in the
  meeting store, which rendered `sprocket_rocket` as "SP" while the lister said
  "SR"; and `getDomainKeywords()` in `profile.ts`, exported with **zero call
  sites** — a whole configuration chain built and never connected, which reads as
  "domains are configurable" to anyone who greps for it.

- **Domains are the UNION of your configuration and what is on disk.** The union
  is load-bearing, not incidental. Configured with no folder yet: still listed, so
  a new install can be routed before any folder exists. On disk but unconfigured:
  still listed, so a folder made by hand never becomes invisible — and that is
  what makes this change safe for an existing install, whose profile configures
  nothing and whose folders resolve exactly as before. Nothing is written to any
  existing profile. Neither: the defaults.

- **Defaults are `personal` and `business`, badged P and B.** Two, not four, and
  only a genuinely fresh COS ever sees them. Set your own in
  `.cos-profile.json` — a bare list works (`"domains": ["personal","work"]`), or
  objects with `keywords` and an `abbr` override.

- **A meeting with no domain from the client is now routed by content.** Keyword
  scoring over title and transcript, counting DISTINCT matched keywords so one
  word repeated forty times cannot outvote four different signals, word-boundary
  matched so "car" does not fire inside "carrier". Deliberately not a model call:
  this runs on every save. Nothing scoring falls back to `personal`, the safe
  direction — a work meeting misfiled as personal is a nuisance the user fixes,
  while a personal conversation filed under a business domain can be pasted into
  a work channel.

- **A domain name is checked for SAFETY, not style.** The old save-path pattern
  `/^[a-z][a-z0-9_]{0,31}$/` accepted `sprocket_rocket` and rejected `DNP study`,
  so a user could select that folder and then never save a meeting into it. The
  store also lowercased the name, which turned `DNP study` into `dnp study` and
  matched no directory on disk. Spaces and mixed case are now fine; traversal,
  control characters and hidden names are still refused.

- **A domain must hold the shape the lister reads.** A `meetings/` folder is no
  longer enough: it must contain at least one `YYYY-MM` month directory. Measured
  on a real install, `operations/archive/meetings/` holds domain names rather than
  months, so a bare directory check listed it as a domain with permanently zero
  meetings. Structural, so no blocklist of names was needed.

## 6.21.30

- **A name you removed by hand is now stated, and the stale write-up is called
  out.** De-attribution rewrites the sidecar, the attendee list and the transcript
  labels, but deliberately leaves narrative prose alone, because substituting into
  a written sentence mangles grammar and can hit the wrong person. The applied
  correction row has recorded `proseStale: true` for exactly this since the feature
  shipped — and NOTHING read it.

  Real case, 2026-08-07: Miles removed "Clem Ukaoma" from a personal call that was
  only him and Queen (his father's voice matched a similar profile). All 8 label
  sites were rewritten correctly. The LLM summary still opened "Miles, Queen, and
  Clem talk through..." and the payload said nothing at all. The allowlist covered
  it only as "not confirmed", which is far too weak: he did not fail to confirm
  that person, he explicitly said they were not in the room.

  The payload now carries `removedNames` and states it above the write-up: *"You
  removed "Clem Ukaoma" from this meeting. The write-up below was written before
  that and still uses the name: treat every mention of it as a capture error, not
  a participant."* The prose is left intact — the record stays, the correction
  travels beside it.

- **The overlap note is gated on how long the meeting RAN, not on voiced time.**
  Gating on voiced time tripped it on 16 of 23 real meetings, because any overlap
  at all exceeds the union of voiced speech. At 70% it stopped being a signal and
  became boilerplate on something pasted into Slack. Rows adding to more than the
  meeting length is the genuinely confusing case — 71m of rows inside a 66-minute
  meeting — and that is roughly a tenth of meetings.

  Worth recording for the next person who tests this: only the WORD-TIMING path
  can overflow. Measured, the chunk-estimate path credits a contested second to
  one speaker (two speakers at identical timestamps gave MU 273s and Gina 0s), so
  a chunk-sourced meeting can never trip the note.

## 6.21.29

Everything below was found by two rounds of adversarial review of 6.21.28 against
the real corpus. **Published 6.21.28 contains the route and none of these fixes**
— its `meeting-scribe-content.ts` is 192 lines with no `renderProvenance`, no
`cleanBody`, and no coverage floor (verified by extracting the tarball, not by
reading the changelog). If you are on 6.21.28, per-voice shares are printed
without the floor.

- **The compact form no longer ships a transcript.** `contains('transcript')`
  kept only the longest match and the loser fell through to `extras`, which went
  into BOTH forms — so the "no transcript" summary carried a second full
  transcript on 112 of 2,090 real scribes, worst case 78,652 characters, printed
  directly above its own "Transcript omitted" line. All transcript-shaped
  sections are now consumed; extras beyond 2,000 characters are omitted from the
  compact form only. The size ceiling matters because a heading cannot be
  trusted: one real scribe hides a full transcript under `G2 Glasses Enrichment`.

- **"Voice matching confirmed" was false for two of the three ways a name is
  asserted.** `nameAsserted` is one boolean over three different warrants — the
  cosine floor, a human typing the name, and the wearer exemption (identity comes
  from holding the device, not from a score). The route carried `isOwner` and
  `confirmedByHuman` and discarded both. The output now names the warrant per
  person: `"MU" by wearing the device; "Gina Obert" by voice match; "Luke Henry"
  because a human named that voice`. Labels are quoted, so a typed "Smith, John"
  cannot read as two people, and the caveat now covers different SPELLINGS of a
  confirmed name (labels are `MU` while the prose says "Miles").

- **A lone named voice no longer gets a share.** "100% of identified speech" is
  always true with one name and reads as "he did all the talking" — on 23 real
  meetings, including one where 6m 29s was unidentified.

- **Rows that overlap say so.** Each per-voice figure is that voice's own union,
  but two people talking over each other is counted once EACH, so the rows add to
  more than the meeting on 34 of 323 real meetings (71m of rows inside 66
  minutes). The figures are right; adding them is what misleads, so the block now
  explains the overlap instead of shrinking anyone.

- **"(no transcript in this scribe)" was a lie on 140 of 399 sidecars.** Those
  meetings have no write-up yet while the recording holds the speech — one case
  today had 27,442 characters in the sidecar this route had just parsed. It now
  distinguishes "not written up yet" from "nobody spoke".

- **The payload says which business it is.** 98 of 251 real meetings are
  `personal` and 25 of 251 summaries carry compensation, termination, or legal
  content, while the buttons are framed for Slack and email. `/speakers` has
  always carried `domain`; this route dropped it. Personal meetings also get an
  explicit line before the content.

- **A derived note is never relabelled as the transcript.** With no real
  transcript, a `Transcript Enrichment (from raw recording)` note won by default
  and was printed under `## Transcript` with its real heading destroyed. The
  section's own heading is now used, and an `## Attendees (from transcript)`
  variant can no longer win the slot at all — nor slip into `extras`, where it
  printed the unfloored name list this module exists to replace.

- **The generator stamp is stripped by POSITION, not wording.** Measured across
  1,227 real stamps, four generator names appear ("Meeting Intelligence System",
  "COS Split Pipeline", "COS Meeting Intelligence", "Manual Granola Paste"), so a
  name-anchored regex leaks some — I shipped one that leaked 7. Being the last
  line is the invariant, which also means a mid-body italic line a human wrote
  now survives. `<!-- g2-needs-domain-review -->` and `<details open>` are
  stripped too; the internal marker reached 129 of 362 real clipboards.

- Also: `mmss` no longer renders `NaNm NaNs`; `meetingDate(1)` no longer returns
  1969-12-31; a date-only ISO string no longer reports the previous day; each
  clipboard form is rendered once instead of twice per request.

## 6.21.28

**Published. Contains the route only — see 6.21.29 for what it is missing.**

- `GET /meeting/:sessionId/content` — the readable meeting plus two ready-made
  clipboard forms. Operations-first resolution, identical to `/speakers`, so the
  list row and this view can never describe the same meeting differently.

- The attendee block is rebuilt from the review rather than reusing the scribe's
  own `## Attendees`, which applies no confidence floor: 2026-08 alone carries
  scribes listing 55, 21, 20, 19, 18, 18, 17 and 15 attendees.

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

## [6.36.4] - 2026-08-17

### A cloned Codex conversation gets its own identity

Miles forked "Markt POS 2.0 build" into "POS Nation 3.0 build" and the fork never
appeared in the sessions list. It had not failed to index -- it was indexed AS ITS
PARENT. The list showed one `Markt POS 2.0 build` row whose modified time was the
fork's activity: two conversations, one identity, and the newer one invisible.

Cloning copies the parent's `session_meta` record wholesale, so the new rollout carries
the PARENT's id under its own filename. `listCodexSessions` keyed on `meta.id` and
folded them together.

The filename is unique per rollout by construction; the meta record is content and can
be a copy. **When they disagree, the filename now wins.** An ordinary session, where
they agree, is untouched.

Verified against the real machine before and after: the fork's `session_meta.id` reads
`019e0943…` (the parent) while its filename reads `01a0119c…`.

### Also worth recording, not fixed here

That fork's rollout is **771,177,205 bytes** -- 735 MB, against other rollouts small
enough not to register. The clone duplicated the entire parent transcript and Codex
rewrites the whole file, which is past Node's 512 MB string limit; COS survives only
because it reads bounded windows. Giving the fork its own identity does not shrink it,
and a clone of a clone doubles again.

## [6.36.3] - 2026-08-17

### The seeded query was being crowded out by the steps

Caught by probing the live stream after shipping 6.36.2, before Miles tested it: a
real session seeded 8 events -- 6 tool calls, one prose, one status -- and **no
prompt**. The seed took "the last 7 events of any kind", and in a busy run the
user's question is twenty or thirty steps back, so the activity you opened the page
to watch is exactly what pushed the query off it. The one case the feature exists
for was the one case it failed.

The newest prompt in the read window is now emitted FIRST and unconditionally,
outside the step budget. Measured on this Mac's largest transcript (87.2 MB): the
last 256 KiB holds 133 records including 3 user turns, so the window reaches a query
comfortably. The client pins rather than lists it, so it costs nothing in the
scrolling window.

## [6.36.2] - 2026-08-17

### The live view stops being a blank slate

Three changes, all from Miles watching a real session on hardware.

- **The user's query is now an event.** A `user` record used to be dropped whole,
  on the reasoning that "the prompt came from this device" -- true of a Continue
  turn and false of the case that matters most, a session running in a Mac window
  where that record is the question Miles typed there and the glasses have never
  seen it. Dropping it is why the lens said WORKING and gave no clue what it was
  working ON. Tool results stay dropped; harness wrappers
  (`<system-reminder>`, `<cos-alarms>`, the memory and bulletin blocks) are
  stripped, because on the lens they would read as the user's own words.
  New `prompt` kind: additive to a closed set, and safe by construction since the
  client validates `kind` against its own table and ignores what it does not know.

- **A shell command is summarised instead of sent raw.** `bash ses...` and
  `bash s...` on the lens were a command reduced to two characters. Two causes
  compounding, and this is one of them: the leading `cd <path>` (identical on
  every command in a repo), heredoc BODIES, and output plumbing (`2>&1`, pipes
  into `head`/`sed`) are now dropped, keeping the verb and its arguments -- what
  you would look for reading over someone's shoulder.

- **The stream seeds from history on connect.** The tail starts at the file's
  current size, so opening a session that was already working showed an EMPTY page
  that filled one line at a time. It now reads backward a bounded 256 KiB, drops
  the leading fragment (an arbitrary offset lands mid-record), and replays the last
  7 steps -- exactly the client's live window, so the seed fills the screen once
  without pushing live events out of the view it exists to prime. Never fatal: a
  session whose history cannot be read still streams, it just starts empty.

Needs COS Glasses 6.8.374 to render any of it.

## [6.36.1] - 2026-08-17

### A reply keeps its line structure

Miles, from a G2 screenshot: a session reply arrived on the lens as one unbroken
paragraph carrying three headings and six bullets, none of them visible.

`proseBody` collapsed ALL whitespace, and both the one-line list gist and the
`latest_reply` BODY went through it. Collapsing is right for a row and destroys a
body: the client cannot restore structure the server already flattened. Two
fields, two jobs, and now two paths — `latestAssistantReply` preserves newlines
while `proseSnippet` still returns exactly one line.

### The tag strip ate prose

`/<[^>]+>/` deleted anything between angle brackets, so `read <file>` reached the
lens as `read ,`. Every `<path>`, `<PORT>` and `<name>` a technical reply uses
died the same way, mid-sentence and unreportably. Replaced with an allowlist built
from the tags actually present in transcripts on this machine (measured over 3,001
records: HTML from rendered output, plus the COS wrapper blocks). A name not on
the list is treated as the prose it almost always is; adding one later is a
one-line change, whereas a placeholder eaten out of a sentence is invisible.

9 execution tests on the shared prose path.

## [6.36.0] - 2026-08-17

### Sessions push instead of being polled

A new SSE route streams what an agent session is doing, so the glasses stop
re-asking every five seconds. Two cases, and the difference between them is real
rather than something the UI papers over.

- **`GET /api/agent-sessions/:provider/:sessionId/stream`** — one event per step
  (`tool` / `prose` / `status` / `heartbeat`), a monotonic `seq` so a client can
  see loss, and a heartbeat at least every 20s so silence is evidence rather than
  ambiguity. Authenticated like every other route; `COS_SESSION_STREAM_ENABLED=0`
  turns it off.
- **A turn COS started streams from the pipe.** The child already ran with
  `--output-format stream-json --verbose`; its stdout was read only to confirm a
  session id and then discarded. It is now teed to the bus as well, and the id
  scan is untouched.
- **A session in a desktop window gets row-level push.** COS never spawned that
  process and has no pipe to it, so the transcript file is the only observable.
  It is tailed forward from a byte offset, one `stat` per second per OPEN view,
  and each new record is emitted through the same grammar and envelope. Claude
  writes a complete record per message, so a long reply lands all at once when it
  finishes. **That asymmetry cannot be engineered away from a file** and the
  contract does not claim otherwise.
- **`fs.watch` was rejected deliberately.** On macOS it coalesces bursts and, on
  an atomic replace, keeps watching the old inode and simply stops firing — a
  watcher that goes silent is indistinguishable from a session that went quiet,
  which is the failure class this repo keeps paying for. A `stat` poll cannot
  miss a write because it does not observe writes; it observes size, and size is
  cumulative.
- **A record too large to stream hands the session back to the poll.** One record
  in a real transcript on this machine is 1,239,046 bytes. The tail reads up to 4
  MiB per TICK, so any record up to that arrives intact; a bigger one ends the
  response with a terminal `done` instead of stalling. Skipping it was tried
  first and was wrong twice: it wedged (the good record behind the oversized one
  was skipped too, on every tick, forever — zero events, not even a status) and,
  even working, it would have silently dropped a reply the user was waiting for.
- **One watcher per session, ref-counted.** Two glasses on one session is not two
  pollers on an 81 MB file, and a double release does not tear down a tail
  another subscriber still holds.

Needs COS Glasses 6.8.372 to be visible. An older app never calls the route.

## [6.35.0] - 2026-08-16

### The newest assistant reply arrives whole instead of at 160 characters

- **The defect.** Miles opened a session on the glasses and the newest reply was cut
  off mid-sentence. The session detail payload had NO full-text field: it carried
  `discussion_summary` (180 chars) and `discussion_digest` (2000), and the newest
  reply appeared only as the `Latest:` line inside the digest, produced by
  `proseSnippet` at **160 characters** with a bare `slice` that stops mid-word and
  prints nothing to say it stopped. An 1821-character reply reached the wire as 160
  characters. The other 1661 never left the Mac. Polling was never the suspect: no
  poll can deliver bytes the server did not send.
- **New field `latest_reply` on `GET /api/agent-sessions/:provider/:sessionId`,
  bounded at 4000 characters.** The number is measured, not guessed. Across 8,387
  assistant replies in the 60 most recent transcripts on this Mac: p50 153, p75 291,
  p90 1,627, p95 2,412, p99 3,405, max 21,757. The old 160-char cap delivered only
  **52.7%** of replies whole. 4000 delivers **99.58%** (35 of 8,387 cut). 6000 would
  buy 0.26 of a point for 50% more bytes on every fetch, and the reader paginates at
  roughly 200 chars, so 4000 is at most 20 swipes of deliberate reading.
- **A dedicated field, not a bigger slice of the digest.** Three caps sit in series
  here (`proseSnippet` 160, `DIGEST_TURN_MAX` 220, `DISCUSSION_DIGEST_MAX` 2000) and
  the digest reserves its `Latest:` block FIRST, so a longer reply inside that budget
  starves the user turns it is supposed to sit beside. Two fields, two jobs.
- **Truncation is now visible.** `latest_reply` ends in an ellipsis when it does have
  to cut. `proseSnippet` keeps its old bare 160-char slice, pinned by a test.
- **ADDITIVE. An older app keeps working.** Nothing was removed or renamed:
  `discussion_summary` and `discussion_digest` still carry exactly what they carried,
  the digest still holds its own 160-char `Latest:` line, and a client that never
  learns the new key renders what it rendered before. Proven over real HTTP rather
  than by reading the route source.

### Two latent hazards in the same path, both closed

- **"Latest" can no longer be a line from the session's opening.** An oversized
  transcript is read head-then-tail into one loop, and the newest reply was plain
  last-write-wins across both windows. A session whose tail window happened to hold
  no assistant prose, which is ordinary when the last 768 KiB are giant tool results,
  kept whichever assistant row the HEAD saw and published it labelled `Latest:`. A
  line from the start of the session, presented as its current state. Silently wrong,
  and worse than truncation because truncation is at least visible. Lines are now
  tagged with the window they came from and only the window ending at EOF can claim
  to be latest; with nothing there the honest answer is nothing, and the digest drops
  its `Latest:` block rather than filling it with the wrong turn. A whole-file read
  is all tail, so small sessions are unchanged.
- **A record larger than the tail window no longer empties the tail.** The tail opens
  at `size - 768 KiB`, mid-record, and the leading fragment is discarded by design.
  When the FINAL record is bigger than the window, that fragment is the only thing in
  it: nothing parses, and the tail contributes no recent turns and no reply at all.
  Not hypothetical: 14 records over 768 KiB exist in a 60-transcript sample on this
  Mac, the largest 1,239,045 bytes, 1.58x the window. The tail now reaches back up to
  one further MiB to open at a real record boundary, and stops reaching past that so
  a pathological record cannot pull an unbounded read into memory.
- **Measured, not asserted:** both hazards are LATENT today. Every transcript
  currently over the 32 MiB read ceiling has 8 to 19 assistant rows in its tail, so
  neither is firing right now. They are mechanisms, closed before they fire.

### Notes

- One behaviour change beyond the additive field, and it is the point of the fix: on
  a truncated read whose tail holds no assistant prose, `discussion_summary` and the
  digest's `Latest:` block are now EMPTY where they used to carry a line from the
  session's opening. That removes wrong content, not content.
- A mutation that survived is recorded rather than buried. An early draft clamped the
  tail start at `headBytes` to avoid double counting, and no test reached it. It was
  both untested and wrong: `lastRecordStart` returns the LAST record's start and that
  record always runs to EOF, so the head can only ever see a prefix it discards, and
  the clamp only threw away the record the reach exists to recover. The clamp is
  gone, a test now covers the case, and re-adding it fails.

## [6.34.0] - 2026-08-16

### A continued turn now runs with the session's own permissions

- **This widens what Continue can do.** A prompt spoken into the glasses can run
  tools on the Mac with nobody at the keyboard. Authorized explicitly by Miles
  after his first real continued turn came back reporting that every tool was
  disabled, which is not the point of the feature.
- Claude drops `--permission-mode plan` and the empty `--tools`/`--allowedTools`
  pair. Codex now uses `getCodexTrustMode()`, the same posture ordinary Codex runs
  use on the host, rather than a stricter one invented at this call site. Absent
  `COS_CODEX_SANDBOX=workspace-write` that is still read-only, so this is never
  more permissive than the rest of the server.
- **Unchanged, and load-bearing:** `COS_THREAD_ATTACH_ENABLED` still gates the
  surface and off still leaves the routes unregistered; `findBannedPermissionArg`
  still rejects every real bypass at the spawn boundary; delivery is still gated
  on a fresh occupancy probe, the epoch floor, the per-target claim and the head
  watermark. Dropping a lockdown is not adding a bypass.
- The old read-only posture had NO test asserting it was present, so it could have
  been deleted silently. The new posture is pinned, and so is the bypass ban.

## [6.33.0] - 2026-08-16

### One switch turns Continue on

Continue was gated by two environment variables, and the second one was
invisible. `COS_THREAD_ATTACH_ENABLED=1` registered the write routes;
`COS_THREAD_ATTACH_IDLE_HOLDER=1` was additionally needed before COS would write
into a thread whose Mac window is open but idle. COS Control's "Continue agent
threads" checkbox sets only the first, so health reported the feature ON while
every single attempt was refused, because a developer's editor windows stay
open and that is precisely the case the second flag covered.

- **`COS_THREAD_ATTACH_ENABLED=1` is now the whole answer.** It registers the two
  write routes and wires the transcript clock that tells an idle holder from a
  working one. Nothing else to set.
- **`COS_THREAD_ATTACH_IDLE_HOLDER` is REMOVED, not deprecated.** If you set it
  by hand, it is now ignored and can be deleted from your LaunchAgent plist or
  shell profile. Leaving it in place changes nothing either way.
- **COS Control needs no update for this.** Its existing checkbox already writes
  the surviving key, so the toggle that reported ON while refusing now reports
  ON and works.

The two switches were never independently useful, and folding them is the honest
description of the decision rather than a convenience. The relaxation is what
makes a silent fork possible, so "Continue is on" and "a fork may happen" are one
choice, and one switch states it.

Every safety behaviour is unchanged. A holder measured WRITING is still refused
with `native_thread_working`; a holder COS cannot measure is still refused with
`live_desktop_process`, because only a positive idle observation relaxes the gate
and an unreadable transcript is not one. Off still means the write routes are not
registered at all, so a disabled server answers 404 rather than 403 and holds no
reachable write code.

## [6.32.0] - 2026-08-16

### Continue now blocks on WORKING, not on merely open

Continuing a Claude Code thread from COS used to be refused whenever any foreign
process held it. That came from `~/.claude/sessions/<pid>.json`, which records an
OPEN WINDOW, not an agent generating: a session that finished ten minutes ago
with the window still up looked identical to one mid-turn. Anyone who leaves
Claude Code windows open was therefore refused on exactly the threads they work
in, and allowed only on the ones they had abandoned.

- A foreign holder is now terminal only while it is **demonstrably writing**. A
  holder measured idle (registry record alive, transcript stale past the same
  30s window `running_active` uses) is continuable.
- New refusal reason **`native_thread_working`**, distinct from
  `live_desktop_process`, because the two ask for different things. Working
  clears itself in seconds and the copy says to wait; `live_desktop_process` now
  means COS could not measure the thread at all and says so rather than implying
  the thread is busy.
- Off by default behind **`COS_THREAD_ATTACH_IDLE_HOLDER=1`**. Unset, no
  transcript clock is wired, every foreign holder reads unknown, and the gate
  behaves exactly as it did in 6.31.0. Composes with `COS_THREAD_ATTACH_ENABLED`.

Verified against a real interactive `claude` 2.1.229 held open and idle before
the gate was touched. Writing into it delivers normally and never corrupts:
across six injections and six desktop turns, including three writers landing
within 45ms of each other, every transcript prefix stayed byte-identical, with
no unparseable lines and no dangling parent references. What it DOES do is fork
the conversation: the holder's in-memory view is stale, so its next turn branches
off the pre-injection tail and the two writers stop seeing each other. Nothing is
lost, and the divergence is caught one layer up by the head watermark, which
changes on a desktop write and refuses the next COS turn with
`native_thread_changed`. The full canary, including what it does NOT license, is
recorded in `server/lib/thread-occupancy.ts` under THE IDLE-HOLDER RELAXATION.

## [6.31.0] - 2026-08-16

### "Running" meant an open window, not a working agent

- `GET /api/agent-sessions` adds **`running_active`**: the thread's transcript was
  written in the last 30 seconds, so an agent is generating in it right now.
- This exists because `running` could not answer that question and was being read
  as though it could. It comes from a process registry, and a Claude Code record
  describes an open WINDOW (`kind: interactive`, `entrypoint: claude-desktop`) —
  so a session that finished an hour ago, with the window still up, stayed
  `running: true` forever. A finished session reported itself active on the
  glasses and never cleared.
- The transcript is the only part of a session with a clock in it. While a
  session generates, its jsonl mtime tracks the wall clock to within a second;
  when it stops, the mtime goes stale while the registry record does not. That
  divergence is the whole signal.
- The window is 30 seconds, deliberately much wider than the observed write
  cadence, so a long tool call between writes does not flap a working session to
  idle and back.
- **Costs one stat per HELD thread, not per listed thread.** Freshness is layered
  on after the occupancy scan and only over what it found, so a list with nothing
  running does no extra filesystem work at all.
- Anything unmeasurable — no transcript, unreadable file, a timestamp from the
  future — reads as NOT active. The row then falls back to "open", which is still
  true of a thread with a live owner. The stronger claim has to be earned by an
  actual observation.
- **Still a display hint and still never a write gate.** `attachability` and
  `attach` keep probing at the moment of the write, unchanged.

### The session detail describes its own liveness

- `GET /api/agent-sessions/:provider/:sessionId` now carries the same three
  `running_*` fields plus `running_stamped: true` and `runningDegraded`.
- Until now only the LIST stamped occupancy, so the detail page had to borrow the
  flags from whichever row the user tapped. Those flags froze at the moment of the
  tap, which is the other half of why a finished session never cleared: the page
  had no way to ask again. A polling client needs a payload that carries its own
  liveness.
- `running_stamped` exists so a client can tell an old server's silence from a new
  server's `false`. They demand opposite behaviour: keep the borrowed hint, or drop
  it as stale.
- Nearly free: the handler already resolves and stats the transcript, so only the
  single-thread occupancy scan is new, and that is the same scan `attachability`
  runs on every menu open.

**Required by the COS Glasses build that ships the honest activity line.**

## [6.30.0] - 2026-08-16

### Sessions know which threads are live

- `GET /api/agent-sessions` now stamps each row with `running` (an agent is
  working in this thread right now) and `running_foreign` (it is held by
  something that is not COS, so a Continue would be refused), plus a
  `runningDegraded` flag on the payload when a probe could not see clearly.
- `running` counts COS's own queued turn too. Two different questions: whether an
  agent is working (the badge) and whether a write would be refused (the
  affordance). Counting only foreign owners would hide your own turn from the
  screen you open to watch it.
- **This is a display hint and never a write gate.** Attach and turn keep probing
  at the moment of the write, unchanged, so a desktop session opened between the
  list render and the tap is still caught.
- Fails the opposite way to the gate: doubt reports `degraded` rather than
  painting every session busy.
- One scan for the whole page, measured at 7ms for 45 real sessions (was 792ms
  before a scan-scoped memo and skipping lsof when no Codex writer lock exists).

**Required by COS Glasses 6.8.364.**

## [6.29.0] - 2026-08-16

### Continue is queued instead of holding the phone

- An attached turn is admitted with **202** and delivered in the background. A
  provider turn runs up to 21 minutes and iOS suspends the WebView the moment the
  phone is pocketed, so a synchronous turn was lost exactly when the user did the
  natural thing.
- Every safety gate stays synchronous: body, replay, queued-prompt, lease, target,
  epoch, fence, claim, occupancy, head baseline, pin. A refusal still reaches the
  user immediately and precisely. Only the spawn moved.
- **New:** `GET /api/agent-sessions/bindings/:bindingId/turns/:clientTurnId`
  serves the same durable ledger record the replay path serves, so a poll and a
  retry can never disagree about what a turn did. Reports `unknown` rather than
  `failed` for a key it has never seen.
- Fixed: a post-202 refusal recorded nothing, so the status route would have
  answered `pending` forever. Pre-202 refusals keep the old semantics and stay
  re-evaluatable.

### Fork, ungated

- `POST /api/agent-sessions/:provider/:threadId/fork` is registered whether or not
  `COS_THREAD_ATTACH_ENABLED` is set. Fork appends to nothing: the original is left
  byte-identical. It is what every refusal tells the user to do instead, and a
  refusal pointing at a route that 404s is a dead end.

**Required by COS Glasses 6.8.363.** Continue still needs
`COS_THREAD_ATTACH_ENABLED=1`; with it unset the write routes are not registered
and behavior is unchanged.

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
