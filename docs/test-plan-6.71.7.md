# 6.71.7 / companion 6.10.629 acceptance plan

Candidate only. Server base is public 6.71.5; 6.71.6 is reserved by the separate God's Eye session. App base is frozen 628 (5a42294). Control 0.5.285/build338 can manage this update without a new Control build. This plan adds to the 6.71.5/628 meeting and bridge gates; it does not replace them.

## Automated evidence

- Desktop D1 passed before building: a synchronous 60-second PermissionRequest hook started at 21:32:43 CDT; the native question was visible and Red was accepted at 21:32:59, before the hook ended at 21:33:43. A second question canceled with Esc while its card had focus; the hook received SIGTERM and no process remained. Esc in the chat composer did not cancel the card. Remote Control remains untested.
- Complete server suite: 6,574 passed / 2 skipped. A final focused installer/broker pass also covers the previous exact script fixture and current reinstall state.
- New broker tests compare 144 approval/unstamped admission and tick cases to the actual 6.71.5 implementation. Stamped questions cover connected/no-client, active/idle/unknown desk, 90-second visibility latch, timeout ceilings, canceled hooks, session boundaries/Interrupt, child events, background requests, parallel questions and first-answer races. A desk completion may add either string or array answers to its input without changing which question it settles.
- Eleven isolated guard mutations are killed by their named assertions after a green baseline. Original source bytes are restored and the release checkout is never mutated.
- Companion status probe measures 20 updates per Ask/Transcript case at 390x844, 320x568 and 390x420, with long content scrolled above the bottom. Composer position, reading height, scroll position and status height must stay within 0.5 px. The private old-CSS control must fail. Standard/full WebKit-strict tests, release typechecks, manufacturer contracts, startup timer quarantine and package asset hashes must pass on final bundles.
- Receipts/logs: the release owner's local `glasses-question-answering-2026-10-11` evidence directory (not bundled). Local automated evidence does not prove stability inside the physical Even host.

## Phone status canary (629 on the current server)

1. Sideload the new **6.10.629** file; preserve 628 for rollback. Start a five-minute G2 recording. Open VIEWS > live meeting > Ask.
2. Ask: **“Catch me up on this meeting so far.”** Watch Checking COS appear and disappear. The composer and reading area must stay in place. Scroll up through an answer and repeat the question; your position must stay steady.
3. Switch to Transcript, scroll up, and wait through at least two refreshes. New chunks and COS checks must not move the passage you are reading. Jump to live must still work.
4. Open the keyboard and repeat in Ask, then hide it. The Ask button remains reachable. Changes caused by opening/closing the keyboard are expected; status polling while it is open must not cause additional movement.
5. Briefly disconnect the phone's network. Connection notices remain readable, recording status remains honest, and reconnect restores Ask. A long notice/Retry must be accessible within the scrollable status area.
6. Lock the phone for five minutes, return to Even, and verify G2 capture, transcript continuity, reconnect and no crash. Stop/save, reopen the meeting and check the saved transcript and Ask history. Include the original 628 dead-bridge/background gate; a WebKit layout probe does not qualify host crashes.

Pass: no status-related movement, no inaccessible controls, no recording loss/crash, and saved evidence/history retained. Record actual observed results rather than assuming a pass.

## Question broker canary (candidate server installed, hooks reinstalled)

Install the frozen candidate through the supported Control-managed server path with the retained 6.71.5 generation/tarball available. Do not start an unmanaged second server. Then click **Reinstall hooks** in Control once. A Codex hook-trust prompt, if shown, must be approved by the user. Do not infer that an app upgrade reinstalled server hooks.

Use a disposable interactive Claude Desktop Code session and this prompt:

> Call AskUserQuestion once with the question "Pick a color" and options Red and Blue, then tell me which I picked.

| Test | Action | Required result |
| --- | --- | --- |
| T1 desk answer | Answer Red immediately at the Mac, with glasses connected | Native dialog remains usable; model reports Red; no card appears later |
| T2 step away | Ask again and leave the Mac untouched | Card appears after the configured desk-idle threshold (90 s default), within two 3-second polls; answer Blue from glasses; model reports Blue |
| T3 return to desk | After T2's card appears, return and answer at the Mac | Card stays until the desk answer, then closes within two polls; no late duplicate answer |
| T4 quiet wearer | Leave glasses connected but untouched for over 30 minutes, then ask and step away | Connected hold polling still qualifies; the card arrives after desk idle |
| T5 no answerer | Disconnect all answering clients and ensure no recent wearer presence | Question stays Mac-only immediately; no ten-minute orphan hold |
| T6 race | In separate runs, answer first at desk, then first on glasses; attempt late answer from the other surface | Exactly one model result; late answer ignored/rejected |
| T7 Esc | Ask at desk, focus the question card, press Esc | Tool/hook stops; no delayed card, stuck request or stray curl process |
| T8 approval | Request a harmless permission-controlled tool at desk, then while away | Existing approval policy and return-to-desk handback unchanged |
| T9 reinstall/provider | Check Claude, Codex and Cursor hook status after reinstall | Current scripts; desk-cancel readiness restored; new question routing only where supported |
| T10 rollback switch | `echo 0 > ~/.cos-glasses/hook-ask-hold`, then ask at desk | Today's immediate desk rule returns; `echo 1 > ~/.cos-glasses/hook-ask-hold` restores the new rule |
| T11 old companion | Exercise question cards on frozen public 624 and 627/628 | Existing routes/answer shapes still work; no new client-ID rejection |
| T12 stop/drain | Cancel a held tool; end its session; perform a controlled server drain | Corresponding card closes; no stale resurrection or orphan request |

Known copy limitation: an answer at the Mac may close the old companion card with “Handed back to the Mac.” Answer-source provenance/security is deferred; this build does not require a new client identity header from 627/628.

## Rollout and rollback

All physical rows are pending until witnessed. Do not declare a public release qualified from the local checks alone. Preserve other sessions' worktrees, changes and 6.71.6 reservation. Merge only the tested source branches once all required gates pass; publish a frozen npm tarball and promote the companion/Hub only within explicit release authorization.

Cue/transcription experiment flags stay off: `COS_LIVE_CUES_FOUNDATION_DEV`, `COS_LIVE_CUES_GROUNDED_V2`, `COS_LIVE_CUES_RESEARCH`, `COS_BATCH_HQ_TIMESTAMPS`, `COS_MEETING_ASK_HQ_EVIDENCE`. Existing `COS_MEETING_PROGRESSIVE_HQ=1` baseline is retained. There is no claim that the experimental transcription or Haiku cues passed accuracy qualification.

To roll back the new question behavior quickly, write `0` to `~/.cos-glasses/hook-ask-hold`. To downgrade the server, reinstall retained 6.71.5 through Control and **Reinstall hooks again** (mandatory: the old package does not recognize the new script SHA). Roll the companion back to the preserved versioned 628 EHPK; the server question rule does not require 629. No Control upgrade is necessary.
