# Meeting import and merge contract (server 6.47.0)

What COS Control, the COS Glasses companion and any other client may rely on when
a Mac imports meetings it did not record, and when the merge engine derives new
records from them.

Two principles decide every rule below.

1. **Additive, never reductive.** A merge writes a NEW record. The Fireflies
   import, the G2 recordings and the merged record all still exist afterwards.
   That is what makes Undo possible, and it is why the list needs a supersession
   rule rather than a delete.
2. **Sources are immutable.** No engine action changes the sha256 of a G2
   recording, its `.g2-chunks.json`, an import file, or a Fireflies scribe.

## Modes

One predicate decides how this Mac behaves. `meetingEngineMode()` returns
`imports` when no COS pipeline can file this Mac's recordings into an operations
tree, and otherwise reads `dataPath('merge-engine.json')` for `advise` or
`apply`.

| Mode | Fireflies comes from | The engine | Writes |
|---|---|---|---|
| `imports` | the server's own importer | merges and splits automatically, after the first-run report | records and stores under `dataPath('imports')` |
| `advise` | the pipeline's `.fireflies.json` sidecars | shows would-merge items and suggestions | stores under `dataPath('imports')` only; nothing in `operations/` |
| `apply` | the same sidecars | decides, and the pipeline applies each decision | a decision file per action; the pipeline writes the operations tree |

The mode file is written only by the server, through
`POST /api/meeting-engine/mode`. There is no environment flag.

```json
{ "schema": 1, "mode": "advise", "changedAt": "...", "changedBy": "control", "macClass": "pipeline" }
```

`macClass` is what this install has been OBSERVED to be, written by the server at
most once per process per class. `g2RecordingsReachOperations()` is a live probe:
it stats the COS venv's python and `sync_meetings.py`, and those go missing for
reasons that have nothing to do with this Mac's identity - iCloud evicting the
checkout, a pip rebuild, `COS_SCRIPTS_DIR` changing between two reads. A Mac
recorded as `pipeline` therefore keeps its recorded mode on a live negative
rather than falling to `imports`, and the disagreement is reported in engine
status as `macClass: { observed, recorded, changed }`. A live POSITIVE always
wins: being wrong towards advise writes nothing, and being wrong towards imports
imports every meeting the pipeline already files.

## Stores

All under `dataPath('imports')`, all written by the server alone.

| Path | Holds |
|---|---|
| `YYYY-MM/<date>_fireflies_<h16>.md` | one imported meeting, with `.import.json` beside it |
| `YYYY-MM/<date>_merged_<h16>.md` | one meeting plus its G2 recordings, with `.derived.json` |
| `YYYY-MM/<date>_piece_<h16>.md` | one span of a long recording, with `.derived.json` |
| `.actions.json` | action records |
| `.suggestions.json` | open and decided suggestions |
| `.tombstones.json` | input pairs blocked from automation |
| `.engine-status.json` | mode, runs, first-run report |
| `decisions/<actionId>.json` | one pipeline apply decision, and its result |

Markdown is capped at 9 MiB and sidecars at 32 MiB, read through a bounded
reader. Nothing here ever writes a `.g2-chunks.json`: that file is the key the
speaker system looks meetings up by, and a derived record that looked like a
capture would be offered for speaker review and then re-derived from its own
output.

## Identifiers

| Kind | Record id | Hash |
|---|---|---|
| Import | `imported:fireflies:<h16>` | `sha256("fireflies:" + firefliesId)` |
| Merged | `blended:<h16>` | `sha256("merge:" + firefliesPrimaryId + ":" + sorted G2 sessionIds)` |
| Split piece | `blended:<h16>` | `sha256("split:" + sourceRecordId + ":" + pieceIndex)` |
| Operations meeting | `ops:<domain>:<month>:<filename>` | n/a |
| Direct library | `direct:<month>:<filename>` | n/a |
| Standalone recording | `standalone:<sessionId>` | n/a |

Canonical ids inside the engine are the G2 `sessionId` and the Fireflies vendor
id. An action id is `a_` plus the first 16 hex of
`sha256(kind + ":" + sorted canonical ids)`; a suggestion id is `s_` plus the
same hash.

## List rows

`GET /api/meetings` always sends `librarySource` and `mutable`.

| Row | `librarySource` | `recordId` | Also carries |
|---|---|---|---|
| Import | `imported` | `imported:fireflies:<h16>` | `mutable: false` |
| Merged | `blended` | `blended:<h16>` | `derivedKind: "merge"`, `actionId`, `sessionId` (earliest G2 input), `g2SessionIds[]`, `mutable: false` |
| Split piece | `blended` | `blended:<h16>` | `derivedKind: "split"`, `actionId`, `sourceSessionId?`, `pieceIndex`, NO `sessionId`, `mutable: false` |

Every row from the imported library carries `domain: "imported"` for routing,
`originDomain` for where the meeting actually came from, and
`domainAbbr = domainAbbreviation(originDomain)`. The `domain` query parameter
matches `all`, `imported`, or the row's `originDomain`.

A merged row's `sessionId` is the earliest capture it holds, so the speaker
panel, the audio routes and held naming still have a way in from the row that
replaced the capture's own. A split piece deliberately has none: it is a span,
not a capture, and two pieces of one recording would collapse onto each other.

On a Mac where the PIPELINE applied the merge, the merged record is the Fireflies
scribe itself, spliced in place. It declares what it holds in its own body:

```
<!-- g2-transcript-blended -->
<!-- g2-source: <sidecar basename, with -- escaped to - -> -->
<!-- g2-session: <sessionId> -->
<!-- merge-action: <actionId> -->
```

The operations lister reads the last two and sets `derivedKind: "merge"`,
`g2SessionIds[]` and `actionId` on that row.

The patch the pipeline splices is a pure function of its input. ONE field can move
its bytes for the same primary and captures: `coarseOffsetMsBySession`, the
offset pairing measured per capture. It feeds alignment, therefore attribution,
therefore the Speaker Verification row. Absent, alignment falls back to the
difference between the two clocks. A fixture generated without it pins the
fallback; one generated with it pins a different, better answer, and the
difference is by design rather than a regression.

`g2-source` carries the sidecar's BASENAME, not its operations-relative path,
and escapes `--` to `- -`. That is the form the COS pipeline's own
`g2_source_marker()` writes, and the pipeline compares the marker it reads
against the marker it would write: any other form reads as "another tool wrote
this", `blend_verified` fails, and a later refresh can append a second
`## G2 Capture` section to a scribe that already has one. The
operations-relative path is not lost - it stays in the decision's
`inputs[].sidecarRelPath` and in the derived sidecar, which is where a reader
that needs to OPEN the file looks.

KNOWN LIMIT, shared with the pipeline: `str.replace('--', '- -')` is
non-overlapping on both sides, so a run of THREE or more hyphens still leaves a
`--` in the comment body (`x----y` becomes `x- -- -y`). Closing that means
changing both sides in one step - a server that escaped more thoroughly would
write a marker the pipeline reads as another tool's, which is the failure the
basename form exists to end.

It is REACHABLE BY CONSTRUCTION, not merely unobserved: the pipeline's
`scribe_generator.sanitize_filename` strips only `<>:"/\|?*` and collapses
whitespace, and never touches hyphens, so a title like `Roadmap---Final`
survives into the scribe stem and from there into this basename.

It is safe to record rather than fix because every reader of this marker on both
sides is a SUBSTRING test (`sync_meetings.py:1589`, `:1613`, `:2806`,
`g2_blend_backfill.py:221`), and the server never reads `g2-source` back at all.
No HTML parser touches it, and the escape always breaks up `-->`, so the comment
can never terminate early. Pinned in `render-pipeline-patch.test.ts` and in
`g2_source_marker`'s own docstring on the pipeline side.

## Supersession

The list drops the rows a derived record already holds, BEFORE merging its
sources, and keeps each layout's existing group order. Nothing is deleted: the
sources stay reachable through the merged record's `sources[]`.

- A G2 row is dropped when a derived record names its session.
- An import row is dropped when a derived record names its Fireflies id.
- A derived row is never dropped, and derived rows dedupe on `recordId`.

| Layout | Behavior |
|---|---|
| `direct` | adds imports and derived rows when the domain filter admits them |
| `multi_domain`, no pipeline | adds them; the 6.46.1 operations-before-standalone precedence is unchanged |
| `multi_domain`, with a pipeline | operations rows only; an operations G2 row is dropped when a merged scribe in the same tree declares its session |
| `standalone` | store, imports and derived rows |

The top-level `source` is `mixed_library` whenever imports or derived rows are
present, and unchanged otherwise.

Day counts come from `supersededDayCounts(month, layout)`: uncapped filename
scans plus the derived sidecars' inputs. `probeMeetings` uses the same helper, so
the morning brief and the Meetings list cannot disagree about a day.

With NOTHING imported and NOTHING derived, that helper answers with exactly the
6.46.1 per-layout source set: the direct library for `direct`, the operations
tree for `multi_domain`, the recordings store for `standalone`. Supersession has
nothing to subtract on a plain upgrade, and the union it otherwise computes added
the standalone store to two layouts that had never counted it. Every group,
including the store's own, honours the `domain` filter.

## Splits, per mode

A split writes NEW records, one per piece, each superseding the long original in
the list. That shape only exists where the server owns the library.

| Mode | What a long recording gets |
|---|---|
| `imports` | an automatic split after the first-run boundary, or an accepted suggestion; both write one `piece` record per span and revert by deleting them |
| `advise` | a suggestion only. Nothing is written outside `dataPath('imports')` |
| `apply` | a suggestion only. `POST /api/meeting-suggestions/:id/accept` answers 409 `split_not_supported_in_apply_mode` |

Apply mode splices a patch into a scribe the pipeline already wrote. There is no
additive, revertible way to turn one operations scribe into three, so the refusal
is typed rather than a 200 that did nothing.

## Apply-mode merges are frozen at apply time

A record in the imports library is a function of its inputs: a speaker
correction on one of its G2 captures fires a re-derive and the record is
rewritten. An apply-mode merge is not that. It is the operations scribe itself,
spliced in place, and the server does not rewrite an operations file after the
pipeline has written it - `rederive` selects `mode === 'imports'` only.

Speaker corrections still reach it, through the pipeline's own path: apply stamps
the G2 sidecar with `blended_into`, held naming resolves the merged scribe
through that stamp, and the merged scribe declares its sessions with
`<!-- g2-session -->` so `findCosOperationsMeetingBySessionId` prefers it over an
orphan sidecar. What does not happen is the merged transcript's speaker LABELS
changing retroactively from a later voice match.

## Detail

`GET /api/meetings/:domain/:month/:filename` and `GET /api/meetings/detail`
resolve in this order: direct library, imported library, operations, store.

The imported branch answers only when `domain === "imported"` AND the filename
matches `^\d{4}-\d{2}-\d{2}_(fireflies|merged|piece)_[0-9a-f]{16}\.md$`. A miss
falls through to the next source rather than 404ing, so a G2 recording whose
title contains the word "merged" still resolves through the store.

A merged detail adds `sources[]`, one entry per input:

```json
{ "kind": "g2" | "fireflies", "id": "<sessionId or vendor id>", "recordId": "<record that still holds it>" }
```

`canonicalRecord` is declared on the row type but the server never reads a
client-sent value.

## Search

`GET /api/meetings/search` scans the imported library before the standalone
store, sharing one file budget. The same supersession rule applies, so one
meeting gives one hit. A hit's `recordId` for an imported or derived record is
derived from the filename's own hash, which is what lets a semantic hit (which
arrives as a file path, with no row behind it) name the same record the list
names.

## Speaker routes and the recordId contract

`GET /api/meeting/:sessionId/speakers` and `.../content` accept an optional
`?recordId=`.

- `source` and `mutable` always describe the CAPTURE: the file that holds the
  chunks and the one a correction would rewrite.
- A `blended:` recordId that genuinely holds this session adds
  `blendedRecordId` to the response. A wrong or stale one is ignored.
- A sessionId matching `^(imported|blended):` is refused 409 BEFORE any lookup.
  The sessionId pattern allows colons, so those ids are shaped like sessions.

Mutations (`relabel`, `confirm`, `deattribute`, `backfill-enrolment`):

| Input | Answer |
|---|---|
| a G2 recordId, or none | allowed; a re-derive follows |
| `blended:<h16>` | 409 `blended_derived_record`, with `sourceRecordId` naming the capture to correct |
| `imported:fireflies:<h16>` | 409 `imported_read_only` |
| a `direct:` recordId | 409 `direct_library_read_only`, as before |

A merged G2 session is NOT refused. It is a real capture with real audio, and
relabelling it is how its voice profile gets better.

`findCosOperationsMeetingBySessionId` prefers a live scribe that declares the
session through `<!-- g2-session -->` over a sidecar whose markdown is missing,
which is the state apply leaves behind when it retires a standalone scribe. The
orphan sidecar still supplies the chunks; the merged scribe supplies the readable
meeting.

## Voice evidence

`assertVoiceEvidenceSource()` refuses by id kind only: ids matching
`^(imported|blended):` and paths ending `.import.json` or `.derived.json`. It is
called from relabel, confirm, deattribute, backfill-enrolment, enroll-ext and
held-groups enroll.

It never refuses a G2 session merely because derived records exist. An imported
meeting has no audio, and a derived record's speaker names came from a vendor's
diarization or a voice-match suggestion, so training a profile on either would
fold a cloud label back into the local identity store and then present it as
local evidence.

## Actions, suggestions and Revert

| Route | Purpose |
|---|---|
| `GET /api/meeting-suggestions?state=` | list suggestions |
| `POST /api/meeting-suggestions/:id/accept` | imports mode |
| `POST /api/meeting-suggestions/:id/confirm` | advise mode |
| `POST /api/meeting-suggestions/:id/dismiss` | dismiss; a dismissed input set never reopens |
| `GET /api/meeting-actions?limit=` | list actions, newest first |
| `GET /api/meeting-actions/:id` | one action |
| `POST /api/meeting-actions/:id/revert` | revert one |
| `POST /api/meeting-actions/:id/retry` | put a failed action back in its own direction |
| `POST /api/meeting-actions/revert-all` | revert all |
| `GET /api/meeting-engine/status` | mode, `pipelineSees`, `mismatch`, `mergesRemainApplied`, `macClass`, runs, first-run report |
| `POST /api/meeting-engine/mode` | `{ mode: "advise" | "apply" }`, pipeline Macs only |

Action states are `pending`, `applied`, `failed`, `revert_pending` and
`reverted`. `pending` and `revert_pending` are the two WAITING states: an apply
or an undo the pipeline has not finished. Both are swept by the 30 s tick and by
every pass, and both are re-driven on boot.

Every action carries `direction: "apply" | "revert"`, written when it is created
and when a Revert claims it. The direction is NOT derived from the state,
because a retryable failure sends an action back to a waiting state and reading
the direction out of that state turned the retry of an undo into a redo.

`POST /api/meeting-actions/:id/retry` answers `{ ok, state, direction }`. It
takes only a `failed` action: a waiting one gets 409 `apply_in_flight`, any other
state 409 `action_not_failed`, a missing one 404 `action_not_found`, a run in
flight 409 `run_in_progress`, and a drain 409 `maintenance_drain_active`. A retry
resets the attempt budget, because the bounded automatic retry exists to stop a
broken decision burning a spawn every thirty seconds and a person asking for one
is not that.

A failed action carries `diagnostics`: `{ code, signal, timedOut, elapsedMs,
stderr?, decisionInvalid?, spawnError? }`. `Command failed` with an empty stderr
is three different bugs - a non-zero exit, a timeout kill and a failed fork - and
each is its own field here. `decisionInvalid` is the pipeline's own
`COS_MERGE_DECISION_INVALID=` line from exit 4.

Revert is compare-and-set: `applied` becomes `revert_pending` atomically, a
second call gets 409 `revert_in_progress`, and a call on an already-reverted
action gets 200. `{ "dryRun": true }` returns a `previewHash` that applying
requires.

Suggestion states are `open`, `confirmed`, `accepted` and `dismissed`. Accepting
in imports mode compares fingerprints and returns 409 `suggestion_stale` on a
mismatch. An accepted merge carries the suggestion's stored `K1` and `K2` into the
derived sidecar's `evidence`, and each capture's offset from re-scoring the
suggestion's own captures against its own meetings into alignment. Before QA round
2 it carried neither, so its sidecar said `K1 = K2 = 0` and alignment fell back to
the two clocks.

### Suggestion sides

Every row from `GET /api/meeting-suggestions` carries `sides`, resolved by the
SERVER:

```json
{ "kind": "g2" | "fireflies", "id": "<canonical id>", "recordId": "<row that holds it>",
  "title": "...", "startMs": 1755700000000, "durationMinutes": 47,
  "source": "imported" | "cos_operations" | "standalone_recordings", "resolved": true }
```

Captures first, then transcripts, one side per canonical id. A client must not
re-derive `imported:fireflies:<h16>` from a vendor id: on a pipeline Mac the
Fireflies side is a scribe in the operations tree at a path only the server
knows, and that is exactly where suggestions are reviewed. `resolved: false` is a
real state - a deleted recording, a transcript the vendor removed - and carries
no `recordId`.

Imported list rows also carry `vendorId`, the Fireflies transcript id, so nothing
downstream has to re-implement the record-id hash.

### Engine status

`mismatch` is true only when the server and the pipeline genuinely disagree.
Advise mode with an ACTIVE pipeline is NOT a disagreement: `merge_engine_active()`
stays true while any applied action exists, precisely so the old blend path does
not restart over merged scribes after a rollback. That state is reported as
`mergesRemainApplied: true`, and only when `pipelineSees.appliedActions > 0`.
Advise, active and zero applied is also what the pipeline prints when it cannot
read its own actions file, so that combination reports `mergesRemainApplied: false`
and `mismatch: true` rather than the reassuring rollback state. When the pipeline cannot be asked, `pipelineSees` is
null and both flags are false: not known is not disagrees.

The status probe (`sync_meetings.py --merge-engine-status`, at most once every
five minutes) runs with the INHERITED environment. Injecting the server's own
`COS_DATA_DIR` made the child resolve the server's own mode file, so the answer
was the server reading itself back and a real disagreement could not be observed.

`counts.applied` is every action in state `applied`, any tier except
`legacy_applied`: exactly the set `revert-all` would undo, and the only count an
Undo-all control may show. It never includes suggestions.

`counts` carries `pending` and `revertPending` separately: an undo that cannot
finish is the state `POST /api/meeting-engine/mode` refuses on, and folding it
into `pending` hid it.

`lastRun` carries `skippedReason` when a pass did nothing - `maintenance_deferred`,
`capture_active`, `inputs_unchanged`, `inputs_unreadable`, `too_many_inputs` -
plus `inputsSkipped` (refused inputs by reason) and `clockBand` statistics.

`capture_active` covers five maintenance lease kinds: `recording_chunk`,
`meeting_save`, `meeting_batch_finalization`, `orphan_recovery` and
`one_shot_transcription`. It gates the start of a pass only. A pass deferred this
way is remembered: the 30 s tick answers `{ fired: false, reason: "capture_active" }`
while any of those leases is held, and `{ fired: true, reason: "deferred_pass" }`
when it runs the owed pass under its original trigger. `g2_finalized` fires from
inside the finalization lease, so its pass always takes this route.

## The pipeline half

The server spawns `sync_meetings.py` for apply-mode work. The child is the only
writer of the operations tree; the server is the only writer of the decision.

| Command | Purpose |
|---|---|
| `--apply-merge-decision <actionId>` | splice the decision's patch into the Fireflies scribe |
| `--revert-merge-decision <actionId>` | restore the archived original and the retired captures |
| `--revert-all-merge-decisions` | applied actions newest first, under the same rules |
| `--merge-engine-status` | print `{ "mode", "active", "applied_actions" }` and exit 0 |

Environment, passed explicitly by the server for every command except the status
probe:

| Variable | Meaning |
|---|---|
| `COS_DATA_DIR` | where the mode file, the stores and `decisions/` live |
| `COS_MERGE_DECISION_FILE` | absolute path of this action's decision file |
| `PATH` | prepends `/opt/homebrew/bin`; a launchd-started server does not inherit a login shell's PATH |
| `PYTHONUNBUFFERED=1` | so streamed progress arrives before the child exits |

Exit codes:

| Code | Meaning | What the server does |
|---|---|---|
| 0 | the report line is authoritative | record `applied` or `reverted` |
| 3 | another pipeline process holds the sync lock | NOT a failure: the action stays waiting and is retried in two minutes |
| 4 | the decision does not match the files on disk | terminal; retrying cannot make it match |
| 5 | a step failed part way, or the whole apply failed | retried once, then failed until a person retries it |

The child prints exactly ONE result line, prefixed `COS_MERGE_RESULT=`:

```json
{ "schema": 1, "action_id": "a_...", "status": "applied" | "reverted" | "partial" | "failed",
  "outputs": [{ "path", "sha256" }], "archived": [{ "original", "archive", "sha256" }],
  "retired": [{ "original", "archive", "sha256" }], "stamps": [{ "sidecar", "blended_into" }],
  "transcript_map": "applied" | "skipped", "transcript_map_reason": "...",
  "step": "...", "error_code": "..." }
```

`transcript_map` says whether the meeting-level speaker map was applied to the
transcript's speaker prefixes. `skipped` with a `transcript_map_reason` means the
prefix format did not match enough lines to be safe (under 90%), which is a
successful apply with one part deliberately not done - not a failure. Missing,
malformed or DUPLICATED result lines are all `result_unreadable`, and the reason
says which: a command that printed nothing died before its report, and one that
printed twice reported twice and neither can be trusted.

## Import routes and states

| Route | Purpose |
|---|---|
| `POST /api/meeting-import/fireflies/run` | `{ windowDays }`; 202 with a run id, or 409 |
| `GET /api/meeting-import/fireflies/status` | run state and counts |
| `POST /api/meeting-import/fireflies/settings` | `{ keepImporting, planCap }` |
| `POST /api/fireflies-key/set` | stores the key, then checks it |
| `GET /api/fireflies-key/status` | `{ configured, source, savedAt, validatedAt, lastCheck }` |
| `DELETE /api/fireflies-key` | removes the key |
| `POST /api/fireflies-key/check` | `{ state, httpStatus?, retryAfterSeconds?, checkedAt }` |

Import run states: `idle`, `running`, `ok`, `partial`, `invalid_key`,
`rate_limited`, `vendor_down`, `unreachable`, `write_unlisted`,
`refused_pipeline`. A server whose mode is `advise` refuses an import run with
409 `operations_pipeline_owns_fireflies`: the pipeline already brings those
meetings in, and two writers producing near-identical records is how one meeting
becomes two rows that each look canonical.

The key is stored at `dataPath('fireflies-key.json')`, mode 0600, with a
`FIREFLIES_API_KEY` environment override. It is never displayed and never
returned. `speaker-trainer.ts` does not read it: a key-file-only install does not
enable `POST /api/voice/train`.

## Compatibility

| Pairing | Behavior |
|---|---|
| a client that does not know the new `librarySource` values | ignores the extra fields; rows still carry a title, date and filename |
| a server before 6.47.0 | ignores `data/imports` entirely |
| a pipeline checkout before WS8 | reads no mode file; applied merges carry the standard blend marker and the `blended_into` stamp, so the old blend path treats them as done |

To roll back with merged records present, revert them first — `revert-all` in
imports mode, `--revert-all-merge-decisions` in apply mode — then set the mode
file back to advise.
