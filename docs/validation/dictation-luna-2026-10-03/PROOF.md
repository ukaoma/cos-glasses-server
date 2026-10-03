# Dictation model options — server 6.61.5

Local candidate based on server 6.61.4 (`7ca669456dd195840cf380c7514f38815826e4ac`). Pair with app 6.10.573. Stable server and production preferences were not changed.

## Gates

- Full server suite: **379 files passed; 5,801 tests passed and 2 skipped**. Exit 0; 317.09 seconds.
- Focused runner and dictation HTTP-route checks: **27 passed**.
- TypeScript: `npm run typecheck` passed.
- `npm pack --json` produced `gotcos-glasses-server-6.61.5.tgz`. Exact size and SHA-256: `artifact.json`. This is a local package, not an npm publication.
- Real CLI smoke: `node --import tsx/esm docs/validation/dictation-luna-2026-10-03/smoke.ts`; raw synthetic input, output and duration in `smoke.json`. Sonnet 2.137 s; Luna 5.588 s. Both preserved amounts, hedging and the instruction not to send. One sample each proves the new runner works, not comparative speed.

## Contracts reviewed

`capabilities.dictationCleanup.models` advertises `sonnet` and `luna-5.6-fast` on `/api/health` and `/api/models`. The app's picker contains exactly those choices; Luna maps to Cursor CLI `gpt-5.6-luna-none-fast`. Sonnet is the default. Explicit Haiku remains accepted for old clients.

Text finalization and audio-draft finalize/retry honor the choice. Unknown text models return 400; unknown audio models disable cleanup while preserving transcription. Per-model circuit breakers prevent an unavailable Cursor CLI from blocking Sonnet. Existing daily cleanup limits remain shared.

Subscription CLIs run in a disposable workspace. API keys and alternate API endpoint/auth environment variables are removed. Claude tools, hooks and MCP are disabled. Cursor uses ask mode (read tools remain) with a temporary profile containing only subscription/connectivity metadata and no MCP. Provider stderr is not exposed in error messages. No provider API client or fallback is added.

Tests cover invalid and empty results, failed CLI exits, missing config, explicit model selection, default/legacy behavior, timeout/abort process-tree termination, removal of temporary profiles, and independent failure recovery. The original transcript (with existing deterministic glossary corrections) remains available if cleanup fails. No production meeting/task data was used for write tests.

## Remaining acceptance and rollback

Phone/G2 click paths, app restart, physical display and end-to-end timing have not been exercised. See the paired app's `docs/validation/dictation-luna-2026-10-03/PLAN-AND-PROOF.md` for the acceptance sequence. Keep Sonnet default pending that evidence.

Roll back the server to 6.61.4 from the existing hardening worktree. No data migration was added. Before rolling the app back to 572, choose Sonnet, because 572 does not understand the new Luna preference. Public/stable promotion is not qualified by unit tests alone.
