# Control 2 foundation: isolated preparation capability

Status: foundation spike, September 27, 2026. This is an importable macOS command-probe API with an actual OS policy. It is not a Claude/Codex adapter, website builder, or publication API. No deployed application behavior changes merely by importing this module.

## Decision

Use a fresh copied snapshot with an explicit approved file allowlist, not a linked Git worktree, as the containment unit. Never copy `.git`, hidden configuration, credential filenames, symbolic links, hardlinks, devices or directories supplied as files. Copying does not change the original checkout. The snapshot lives in a private temporary parent and gets a private HOME and TMPDIR.

Only the server that created the in-memory snapshot handle can run it. Arbitrary client-provided root paths are rejected. One process run owns a snapshot at a time, and disposal while running is rejected. No endpoint should accept an executable, source root or file allowlist directly from an untrusted client.

For the future Git target adapter, the approved project configuration must identify the repository and exact base commit. Materialize selected tracked files from that commit into an owned staging source, then call this API. Record commit, file hashes and project-policy revision in the parent journal. Dirty source files must remain untouched. A live developer checkout is not an immutable approved commit: the caller must supply an exclusively owned, stable source while copying. This spike does not implement Git revision selection or defeat a hostile process racing source-directory mutations.

## OS boundary

`/usr/bin/sandbox-exec` receives a generated deny-default profile. The policy permits content reads only inside the snapshot and fixed OS library/executable paths. Filesystem writes are limited to the snapshot and `/dev/null`. Network access and Mach service access have no allow rule. The process receives five explicit environment values, never the server environment, provider authentication or connector settings. Standard input is closed and only stdout/stderr pipes are inherited.

Modern macOS dyld needs permission to read the literal root directory. That does not allow its descendants. Global file metadata and sysctl reads are allowed and should not be described as complete host invisibility. `/System/Library` is allowed rather than all `/System`, which can expose the Data volume through another spelling.

Executable admission is deliberately limited to `/bin/sh`, `/bin/bash`, `/bin/cat`, `/bin/echo`, `/bin/sleep`, `/bin/ln` and `/usr/bin/env`. Child exec uses the same fixed list. A provider binary, interpreter, Git, package manager or build tool is unsupported and fails closed. Shell descendants inherit the OS sandbox. The process runs in a new group; timeout, cancellation, excess output and normal completion terminate remaining group members. Output is limited to 64 KiB and deadlines to 30 seconds. This is not a generalized resource-isolated VM or fork-bomb-resistant agent runtime.

The capability must remain disabled for actual provider execution until a separate adapter proves provider authentication without giving the child host secrets, tool/file access, network destinations, descendants and revision-bound outputs. Passing these probe commands cannot establish that broader capability.

## API

- `createControl2Snapshot({sourceRoot, relativePaths})` copies an explicit safe set and returns `{id, root, files, dispose}`. Omit input for an empty disposable probe. Total source data is limited to 16 MiB and 1,000 files. Filenames alone cannot establish whether content contains secrets; the caller approves content scope.
- `runControl2Sandbox({snapshot, executable, args, timeoutMs, signal})` returns exit status, bounded output, duration and timeout/cancellation/output-limit flags. Unsupported platform/root/executable or failed sandbox launch never falls back to unsandboxed execution.
- `probeControl2Sandbox()` creates only disposable files and a loopback test listener. It returns `supported`, `proven`, `code`, named checks and limitations. Treat `proven:false` as unavailable. Results are specific to this host, OS policy and current executables, not a permanent provider entitlement.

## Verification

Run `node --import tsx/esm server/scripts/control2-sandbox-canary.ts` from the server repository. It exits nonzero unless every check passes. The imported probe does not print file contents or credentials.

The canary demonstrates a real positive workspace read/write, a host-readable protected sentinel, and a loopback server reached outside the sandbox by the same Bash network builtin. It then proves denied host reads/writes, denied symlink escape and a denied network connection with no new server hit. Timeout and cancellation checks record a child PID and verify it no longer exists. Additional checks cover minimal environment and bounded output. A broken network client is not counted as isolation.

Run `npx vitest run server/lib/control2-sandbox.test.ts --maxWorkers=1`. The suite additionally rejects traversal, hidden/credential paths, symbolic/hard links, arbitrary roots/executables, invalid deadlines, concurrent ownership and active disposal. OS-level cases run only on macOS; unsupported systems do not receive a passing capability result.

Observed in this session: 14 tests passed and all 14 live probe checks passed. Production provider tools, authenticated connectors, live CMS writes, Git deploy and publication were not exercised. The parent journal, policies and native surface remain independently owned work.

## Bounded no-tool draft adapter

`control2-draft.ts` adds a separate capability: `prepareControl2Draft({instruction, model?, timeoutMs?, signal?})`. It is off unless the trusted harness sets `COS_CONTROL2_DRAFT_ENABLED=1`, permits one live turn per server process in this foundation spike, and refuses concurrent work. The configured Claude model is used; otherwise the repository default applies. It does not select a cheaper readiness model. A durable project budget must replace this development cap before routine enablement.

The authenticated CLI broker runs outside the OS sandbox because it needs its account and provider service. It receives safe mode, explicit empty strict MCP configuration, empty built-in and allowed tool lists, `dontAsk`, no session persistence, one-turn and $1 CLI budget flags, a bounded prompt and 120-second maximum deadline. The $1 flag is the CLI's reported API budget behavior; it is not a guarantee about subscription billing. The CLI and its authentication are part of the trusted host boundary. No model-selected executable or path is accepted. Timeout/cancel terminates the provider process tree; uncertain termination retains ownership and the snapshot.

The response must be JSON with exactly two strings, `title` and `body`; extra keys, malformed JSON, control characters and excess length are refused. A deterministic renderer HTML-escapes both strings into a fixed CSP-protected template, writes `preview.html` with exclusive creation into an internally created snapshot, and verifies exact content using the OS-constrained fixed command lane. The returned artifact includes its hash, model, scope and disposal function. This proves useful text preparation, not autonomous code changes or publishing. It never resumes a user conversation.

Run `COS_CONTROL2_DRAFT_ENABLED=1 node --import tsx/esm server/scripts/control2-draft-canary.ts` intentionally; it makes one real provider call using only synthetic data and cleans its artifact afterward. The observed call returned the requested `Preview ready` heading with `sonnet[1m]`, passed exact artifact verification, and left a disposable production sentinel unchanged. Five draft checks passed. The hostile script/path/command test feeds the deterministic renderer directly; it does not claim a second model jailbreak test. Ten draft unit tests plus fourteen sandbox tests passed, and repository TypeScript checking passed. Tool-enabled provider execution, live meeting ingestion and publication remain separate capabilities.
