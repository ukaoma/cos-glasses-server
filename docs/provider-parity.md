# Provider parity (6.62.0)

What the server promises about Claude, Codex and Cursor desk sessions, and where each promise stops.

## Contract on the wire

- `GET /api/health` and `GET /api/models`: `providers.<claude|codex|cursor>.act` (`continueIdle`, `continueBusy`, `fork`, `cancelDesk`, `approvals`, `nativeQueue`, `keepModel`, `permissions`, each false with a reason code). `/api/health` also carries `providers.<p>.observe` (`hooks`, `liveState`, `children`, `compaction`, `reasoning`).
- `threadForkSupported` stays a boolean; `threadForkProviders` lists who can fork.
- `features.sessionCancel`: `cosTurn`, `deskClaude`, `deskCodex`, `deskCursor`.
- `sessionHooks`: `state` / `installed` are Claude's (Control's banner reads them). `sessionHooks.codex = {present, installed, trust, scriptOk}`; `sessionHooks.cursorObserver = {installed, nodeOk}`.
- Session rows and detail: `running` and `running_active` from one rule for all providers, `reported_model`, `continue_note` (≤60 chars).

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
| Cursor | `--force --model <session slug>` on its own config dir | composer-2.5-fast + note |

`COS_CONTINUE_FULL_PERMISSIONS=0` restores the 6.61 argv. Fork is read-only for every engine.

Evidence for every engine fact here (canaries C1-C12, K1-K3): the plan's research folder, `operations/personal/wk41_2026/provider_parity_research/` in the COS repo.
