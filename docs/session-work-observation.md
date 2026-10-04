# Session child work and context phases — 6.61.7 candidate

This additive, display-only API metadata requires app 6.10.590 to render the new status row. Existing clients ignore it. No model, queue, permission, storage or continuation policy changes.

`GET /api/agent-sessions` and provider detail may add `subagent_activity` with active/completed/unknown/total counts, `checked_at` and `partial`. Claude/Cursor detail may also add `compaction` with state, started_at and checked_at. Missing metadata means unavailable; it is not zero active agents. A count excludes the parent. Counts never become write authority.

Codex uses read-only local state SQLite spawn edges and bounded lifecycle evidence from descendant rollout tails. Open edges alone do not indicate work. Claude uses native lifecycle hooks. Cursor requires its native observer in addition to any imported Claude hooks: third-party mapping omits some subagent events.

After publication and server update, use the normal `--hooks install` or Control Install hooks action. This adds PreCompact to Claude and merges the bounded native Cursor observer into its hooks.json. Existing foreign hooks are preserved; invalid JSON fails without replacement. Reopen provider sessions as needed to load updated hooks. `--hooks uninstall` removes these owned observers. Native observers retain only parent/child IDs and phase timestamps, emit no followup, and cannot notify action listeners that drain queues or change permissions.

An active child without fresh evidence becomes unknown after five minutes; compaction without a resume event becomes unknown after ten. Native Cursor modes that do not emit these events remain unverified. Codex on this installation exposes the context replacement record, not reliable live compaction-start telemetry. Oversized recognized context records are skipped incrementally while the stream stays open; ordinary oversized records keep the existing safe polling fallback.

Validation: full suite 5,829 passed / 2 optional skipped; supplementary three-suite run 63 passed (HTTP provider projection, hook backward compatibility, observer lifecycle). Types passed, production dependency audit zero vulnerabilities, tarball inventory includes the native observer. No live positive Claude/Cursor swarm or physical G2 acceptance is claimed. npm publication, clean-cache registry installation, hook refresh, and device acceptance remain pending.
