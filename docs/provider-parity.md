# Provider parity (6.62.0)

What the server promises about Claude, Codex and Cursor desk sessions, and where each promise stops.

## Contract on the wire

- `GET /api/health` and `GET /api/models`: `providers.<claude|codex|cursor>.act` (`continueIdle`, `continueBusy`, `fork`, `cancelDesk`, `approvals`, `nativeQueue`, `keepModel`, `permissions`, each false with a reason code). Both routes also carry `providers.<p>.observe` (`hooks`, `liveState`, `children`, `compaction`, `reasoning`).
- `threadForkSupported` stays a boolean; `threadForkProviders` lists who can fork.
- `features.sessionCancel`: `cosTurn`, `deskClaude`, `deskCodex`, `deskCursor`.
- `sessionHooks`: `state` / `installed` are Claude's (Control's banner reads them). `sessionHooks.codex = {present, installed, trust, scriptOk}`; `sessionHooks.cursorObserver = {installed, nodeOk}`.
- Session rows: `running` and `running_active`; detail additionally carries `reported_model` and `continue_note` (≤60 chars). List polling does not wait for model lookups.

## Hooks

| Engine | Where | Trust | Turn start / end |
|---|---|---|---|
| Claude | `~/.claude/settings.json` | n/a | UserPromptSubmit / Stop, registry idle flip |
| Codex | `~/.codex/hooks.json` (COS blocks replaced in place) | Codex `hooks/list`; untrusted hooks never run | UserPromptSubmit / Stop, Interrupt |
| Cursor | the Claude hooks (third-party extensibility) + `~/.cursor/hooks.json` observer | n/a | IDE: UserPromptSubmit / Stop; CLI `-p` fires neither |

The halt reply is provider-specific: Claude and Cursor keep the 6.53 bytes; Codex gets deny-only (it fails open on `continue:false`).

## Continue posture

| Engine | Continue runs with | Fallback |
|---|---|---|
| Claude | the session itself (live inbox) or `claude -p --resume` with the user's default mode | unchanged |
| Codex | session `-m`, effort, `-s` from the latest `turn_context`; `danger-full-access` only in a trusted folder | 6.61 posture + note |
| Cursor | `--force --model <session slug>` only after client note acknowledgement, on its own config dir | composer-2.5-fast + note |

`COS_CONTINUE_FULL_PERMISSIONS=0` restores the 6.61 argv. Fork is read-only for every engine.

## Compatibility and limits

Cursor Run Everything requires `X-COS-Continue-Note: 1` on the turn request. Queue admission persists the acknowledgement and replays it on drain. Clients without it retain Ask mode. Continue/Fork refuse if private Cursor configuration isolation fails.

Run `codex` in Terminal to review and trust the installed hooks. COS reads hook trust through a bounded app-server call every five minutes; it does not write hook trust. Codex hooks use their own script copy. Desk Cancel requires observed hooks for the specific thread, not merely an installed script. Continue only uses danger-full-access for an already trusted working directory or its canonical Git root, rechecked at spawn; a trusted arbitrary parent does not qualify. Starting new Codex sessions may cause Codex itself to write project trust; resumed sessions do not.

Busy Codex Continue accepts the moving head and enters the native app queue, which is not exposed in COS Queue. Cursor CLI queued turns start when the chat is free and use the saved note acknowledgement. Cursor Fork creates a new read-only chat with recent context. Cursor IDE composers cannot accept outside messages, and Cursor CLI approvals cannot be answered remotely.

Cursor reasoning is briefly on disk in the observer spool until drained, then in memory and the live stream, never the ledger. A stale drain stops new thought writes. Codex rollout compaction completion closes an observed phase; start needs hook evidence. Cursor open turns quiet beyond five minutes remain OPEN until the 30-minute ceiling. Claude/Codex completion can lag by 30 seconds.

Set `COS_CONTINUE_FULL_PERMISSIONS=0` in `~/.cos-glasses/.env` and restart to restore the previous posture; Control does not yet carry this key through updates. Before rolling the server back to 6.61.7, use the pinned 6.62.0 CLI to remove Codex hooks (`--hooks uninstall --codex`), then use Control rollback and reinstall the older hooks. Do not run the old CLI with `--codex`: it does not understand that flag.
