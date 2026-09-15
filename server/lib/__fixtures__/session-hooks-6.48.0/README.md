# Recorded Claude Code 2.1.272 hook sequences (2026-09-15)

Every file is a real recording: `bin/hooks/cos-session-hook` spooled these envelopes from
`claude -p --model haiku` runs on macOS, one envelope per line, in spool order. Paths are
redacted to `/Users/example/...`; nothing else was edited. The one rule (from the
Harness engines README): every field name and event name the reducer handles comes from
one of these files, never from the docs.

| File | What it shows |
|---|---|
| `p-mode-run.hooks.jsonl` | SessionStart(source), UserPromptSubmit(prompt, prompt_id), Stop(last_assistant_message, no stop_reason), SessionEnd(reason). |
| `post-tool-use.hooks.jsonl` | Two prompting Bash calls in one turn: their PermissionRequest hooks ran SERIALLY (the second arrived after the first was answered); PostToolUse carries tool_use_id and duration_ms; a failed Read fires PostToolUseFailure. |
| `permission-deny.hooks.jsonl` | The hook returned `deny` with a message; no PermissionDenied or PostToolUseFailure followed, and the Stop's last_assistant_message is the deny message verbatim. |
| `permission-no-decision.hooks.jsonl` | The hook returned nothing in print mode; the tool was blocked by Claude itself, and the turn stopped. |

Interactive-only events (Notification types, PreToolUse for AskUserQuestion and
ExitPlanMode, StopFailure, SubagentStart/Stop, PostCompact, PostModelSwitch) cannot be
recorded headless; they join this directory from the first real Desktop session after
the hooks are installed. Until then the reducer treats their shapes as optional.
