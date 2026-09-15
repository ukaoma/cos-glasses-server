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

`g2-source` carries the sidecar's BASENAME, not its operations-relative path,
and escapes `--` to `- -`. That is the form the COS pipeline's own
`g2_source_marker()` writes, and the pipeline compares the marker it reads
against the marker it would write: any other form reads as "another tool wrote
this", `blend_verified` fails, and a later refresh can append a second
`## G2 Capture` section to a scribe that already has one. The
operations-relative path is not lost - it stays in the decision's
`inputs[].sidecarRelPath` and in the derived sidecar, which is where a reader
that needs to OPEN the file looks.

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
| `GET /api/meeting-actions?limit=` | list actions |
| `POST /api/meeting-actions/:id/revert` | revert one |
| `POST /api/meeting-actions/revert-all` | revert all |
| `GET /api/meeting-engine/status` | mode, `pipelineSees`, `mismatch`, runs, first-run report |
| `POST /api/meeting-engine/mode` | `{ mode: "advise" | "apply" }`, pipeline Macs only |

Action states are `applied`, `failed`, `revert_pending` and `reverted`. Revert is
compare-and-set: `applied` becomes `revert_pending` atomically, a second call
gets 409 `revert_in_progress`, and a call on an already-reverted action gets 200.
`{ "dryRun": true }` returns a `previewHash` that applying requires.

Suggestion states are `open`, `confirmed`, `accepted` and `dismissed`. Accepting
in imports mode compares fingerprints and returns 409 `suggestion_stale` on a
mismatch.

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
