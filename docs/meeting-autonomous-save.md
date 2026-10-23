# Saving a G2 meeting without the phone on screen (6.81.0)

Miles, 2026-10-20: "if the application isn't in the foreground, it can fail to save the meetings, which then heads up almost everything." Hard rule: offline capture (record on the phone, upload and transcribe on reconnect) is the most important case, and nothing may lose or split a meeting.

## Phase A: the stop-and-save path before 6.81.0

### From lens Stop to a meeting in the library

| Step | Where | What happens | Needs the phone on screen? |
| --- | --- | --- | --- |
| 1. Stop (lens, ring, phone, or Control's stop request) | phone `stopMeetingCaptureOnce` | `beginStop()`, mic off, `stopContinuous()` seals the last partial chunk | No |
| 2. Commit the last chunk | phone IndexedDB (`stageMeetingChunkStrict`) | The sealed chunk must be written to IndexedDB before it can upload. If the write fails, Stop is refused (`meeting.local_first.stop_blocked`) and `meeting-stop-autofinish.ts` waits for the retried commit | **Yes, in practice.** iOS suspends IndexedDB in a hidden WebView ("transaction watchdog", "without an in-progress transaction") |
| 3. `finalize` (`local-first-meeting-uploader.ts` `runFinalize`, 30 s budget) | phone | writes `stop_requested` to IndexedDB, then: | |
| 3a. Reconcile | phone to Mac `GET /api/meeting/sessions/:id/status` | The Mac answers its received / ASR-completed / canonical ranges and any save receipt. The phone marks chunks the Mac finished as confirmed | Fetch works hidden; the IndexedDB reads and writes around it do not |
| 3b. Drain | phone to Mac `POST /api/transcribe-stream?sessionId&chunkIndex` per pending chunk | The Mac persists the WAV, then ASR, then answers the text; the phone records the answer in IndexedDB | Same: the upload works, recording its answer does not |
| 3c. Save | phone to Mac `POST /api/meeting/save` | The Mac writes the sidecar and markdown, moves audio to pending-batch, closes the session (`deleteSession`, 410 tombstone), emits `recording_stop`, queues the durable finalization job (HQ batch, Nemotron, cleanup, COS ops handoff) | Only reached after 2, 3a and 3b succeed |
| 4. Retry | phone `retryRecoverableLocalFirstMeetings` | On boot, foreground and reconnect, every stopped session is finalized again (`allowGaps: true`) | **Yes**: foreground, boot or reconnect triggers |
| 5. Last resort | Mac stranded sweeper | A session with no chunk for 4 h is promoted (saved) by the Mac; at 8 h a failing promote closes and quarantines | No, but 4 hours late |

### What exists only on the phone

- The sealed last chunk until its IndexedDB commit succeeds (in memory, `captureHeldIndex`).
- Chunks committed to IndexedDB but not yet uploaded (`pendingRanges`).
- The answers to chunks the Mac received but whose responses the phone never recorded. The Mac has the chunk; the phone still lists it as pending.
- The `stop_requested` fact itself. The Mac had no way to learn that a meeting ended except the final save.

### Today's two meetings (read from `client-diagnostics.jsonl`)

- **11:19 qbbgyq.** Stop at 12:43:47. 12:44:08 `stop_blocked` (IndexedDB watchdog, chunk 899 held). 12:45:58 foreground reconcile and recovery reconcile both failed "Load failed". 12:46:08 auto-finish gave up after 120 s. A new WebView instance saved it at 12:47:12 through the origin-wipe recovery hint.
- **14:07 mip9qb.** Stop at 15:13:50 with the phone hidden. 15:13:58 `stop_blocked` (chunk 617 held). The phone came on screen at 15:14:22, the held chunk committed at 15:14:27, and the save landed at 15:14:37. 23 seconds of foreground did what 30 seconds hidden could not.

### Failure modes when the phone goes hidden or loses network mid-save

1. **Stop blocked on the held last chunk.** No save can run until the phone is on screen again (both meetings today).
2. **Finalize times out mid-drain.** `finalize_pending`, retried only on foreground or reconnect.
3. **Save POST lost.** Retried on foreground; the Mac's save is idempotent, so a lost response is harmless.
4. **Phone killed while hidden.** A new WebView finds the recovery hint and saves what the Mac holds; the held chunk in memory is gone.
5. **Mac saved first, phone holds unconfirmed chunks.** Any server-side save before the phone finished (the 4 h stranded promote, origin recovery) leaves the phone with `pendingRanges` against a closed session: every replay is 410, and `runFinalize` returns `collision` ("N chunks retained; recovery required") and keeps the audio forever. This is why the Mac must never save early.

## The design (6.81.0)

### Stop received

A **Stop intent** is `POST /api/meeting/sessions/:sessionId/stop` with `{ "finalChunkIndex": N, "serverInstanceId": "<pin>" }`, where N is the highest chunk index the phone captured (including a held one) and -1 means nothing was captured. It is "received" only when the server answered 202 or 200, which it does after writing the intent durably (`data/meeting-stop-intents.json`, 0600, atomic). A pin is required. A Stop whose N is behind what the Mac already holds is refused 409 `final_index_behind_server`. Re-posting is idempotent; a higher N raises the intent and a lower one never lowers it.

The intent never closes the session and never refuses a chunk.

### When the server saves on its own

`lib/meeting-autonomous-finalize.ts` `decideAutonomousFinalize`, checked when the Stop arrives and every 15 s while any Stop waits:

1. Already saved: stand down (recorded as the phone's save).
2. The phone's save holds the lock: wait.
3. Session closed without a save (expired, quarantined): stand down; those paths own it.
4. N = -1: stand down.
5. The Mac holds a chunk past N: **revoke**. The meeting is still recording.
6. No session yet (offline capture, Stop first): wait for the upload.
7. Any index 0..N not received: wait (`missing_chunks`).
8. Any index 0..N not through ASR: wait (`asr_pending`).
9. Less than 45 s since the Stop and since the last chunk arrived: wait (`settling`), so a phone that is on screen saves first.
10. Otherwise save, through the same `performSave` the phone's `POST /meeting/save` uses: one lock, one idempotent receipt, the same sidecar-then-job order and the same lease order.

It runs only while maintenance admissions are open and durable session recovery has run, the same gate as the stranded sweeper.

### Why wait instead of finalize-then-merge

A save closes the session. A chunk that arrives after the close is refused, and the phone reads "closed, with my audio still pending" as a collision it cannot resolve. A finalize-then-merge design would need the Mac to reopen a saved meeting, re-run HQ and the COS ops handoff, and the phone to stop treating that state as a collision. Waiting needs none of that: missing chunks are uploaded into the same live session exactly as they are today, and the next check saves one complete meeting. A gap that never fills is left to the existing stranded sweeper at its existing 4 h horizon, unchanged. Waiting costs only time; saving early costs audio.

### When the phone comes back

- `GET .../status` answers `saved` with the receipt. The phone adopts it.
- A chunk the phone re-sends because its answer was lost while hidden is answered with the saved text (`canonical: true`), or as empty for a silent chunk, from the saved sidecar. Only for meetings the server saved itself; every other closed session still answers 410. A chunk the saved meeting never held is still 410 and is logged as `late_chunk_refused` (the design says this cannot happen).
- `POST /meeting/save` replays the receipt (`replayed: true`). One meeting.

### Telemetry

Each event is a `[meeting/auto-save] <event> <sessionId> {json}` line in the server log and a row in `data/meeting-autonomous-save.jsonl`:

| Event | Fields |
| --- | --- |
| `stop_received`, `stop_raised` | source, finalChunkIndex, posts, chunks the Mac held |
| `waiting` (once per change, not per poll) | reason, missingCount, missingSample, finalChunkIndex |
| `finalized` | reason `stop_received_complete`, chunks, canonical, gaps, filename, waitedMs |
| `phone_saved`, `client_saved` | the phone (pinned save) or another client (unpinned: the stranded sweep, a manual curl) saved first; waitedMs |
| `phone_confirmed` | via `status`, `save_replay`, `stop_retry` or `chunk_replay`; sinceSaveMs |
| `late_replay`, `late_chunk_refused` | chunkIndex, counts |
| `revoked`, `stood_down`, `finalize_failed` | reason, status |

The status route also carries the intent additively as `stopIntent` (`finalChunkIndex`, `state`, `savedBy`, `waitingFor`).

### Unchanged

Transcription engines, the G2 matching thresholds in `sync_meetings.py`, the restart and maintenance gate semantics (the new route takes the ordinary request lease, the save takes `meeting_save` with `allowDuringDrain` exactly as the phone's save does), the stranded sweeper and its 4 h horizon, and the 410 answer for every session the server did not save itself.

## The companion change this needs (not in this release)

The server side is inert until the companion sends the Stop. The companion should:

1. In `stopMeetingCaptureOnce`, right after `beginStop()` and before any IndexedDB work, POST the Stop with `finalChunkIndex` = the highest captured index (including `captureHeldIndex`). Retry it (it is idempotent) until a 2xx, from the same retry hooks that already finalize.
2. When the held chunk cannot be committed while hidden, upload it from memory as well as retrying the commit. Without this, today's two cases still wait for the phone, because the held chunk exists nowhere else.
3. In `runFinalize`, when status is `saved` and every pending index is inside the Mac's `asrCompletedRanges`, drain (the Mac now answers those replays) before declaring a collision.

## 6.88.0: integrity against the phone's final index, and recovery saves that wait

Meeting t2xs9u (2026-10-23 07:59): a relaunched COS window found no local copy of a meeting, read its recovery hint as a storage wipe, and asked the Mac to save it from 74 chunks while the window still recording it had captured through index 120. The saved file said "Transfer integrity 100%". Code: `lib/transfer-integrity.ts`, wired in `performSave`.

| Field on `POST /meeting/save` (all optional, glasses 6.10.652) | What the server does |
| --- | --- |
| `finalChunkIndex` (a whole number, -1 to 1,000,000; anything else is ignored) | With the Stop intent's `finalChunkIndex`, the higher one is the phone's final index. Integrity counts against it: expected = final + 1, every index past the Mac's highest chunk is missing (74 of 121 reads 61.1%, 47 not received). A final more than 20,000 past the Mac's highest chunk is capped there. |
| `recovery: 'origin_wipe'` | Refused with 409 `chunks_outstanding` (`missingCount`, `finalChunkIndex`) while the phone's final index says the Mac lacks chunks in `0..final`. Nothing is saved or closed. |
| `acceptMissing: true` | The recovery waited out its bound (10 minutes on the phone): save what the Mac has, with the honest integrity above. |

A save without `recovery` is never refused here, and a save with no final index from anywhere is unchanged. An already saved meeting replays its receipt first, as before. The phone checks the same thing from the status route (`stopIntent`, `receivedRanges`, `lastActivityAt`) before it asks; the server check closes the moment between that read and the save.

