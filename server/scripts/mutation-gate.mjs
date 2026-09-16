#!/usr/bin/env node
/**
 * The mutation gate, committed so it can be run again (6.47.0, QA round 1).
 *
 * WHY THIS EXISTS AS A FILE. The 6.47.0 plan names a mutation gate over every new guard, and
 * the gate that was run lived in a scratch directory that no longer exists. A gate nobody
 * can re-run is a claim about a build, not a property of the code: the next change to any of
 * these guards silently loses its coverage and the next QA pass has nothing to check against.
 *
 * WHAT IT DOES. For each case below: apply one exact string replacement to one source file,
 * run the named test files, and require them to FAIL. A mutation that leaves the suite green
 * is a finding - that branch is unreached - and is reported as SURVIVED.
 *
 * FOUR THINGS IT PROVES, IN ORDER:
 *   0. The target suites are GREEN UNMUTATED. Without this the gate is unfalsifiable: a kill
 *      is decided from a non-zero vitest exit, and a suite that was ALREADY red returns
 *      non-zero for every mutant, so an inert edit that changes no behaviour reads as killed
 *      and the whole run reports a number that means nothing. The baseline runs first and the
 *      gate refuses to continue without it.
 *   1. The target string appears EXACTLY ONCE, or the mutation is ambiguous and is refused.
 *   2. The mutated file differs from the original, so the edit actually landed.
 *   3. The file is restored BYTE FOR BYTE afterwards, verified by sha256, including when the
 *      process is interrupted: SIGINT and SIGTERM restore before exiting.
 *
 * Usage:
 *   npm run mutation:gate              every case
 *   npm run mutation:gate -- --list    names only, runs nothing
 *   npm run mutation:gate -- <name>…   only the named cases
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Every guard this pass added or changed, and the test that has to notice it is gone.
 *
 * `find` must be unique in the file. `replace` is the mutation. `tests` is what runs.
 */
const CASES = [
  {
    name: 'revert-sweep-tick',
    file: 'server/lib/meeting-actions.ts',
    find: '      isWaitingState(action.state) && (action.nextAt ?? 0) <= now)',
    replace: "      action.state === 'pending' && (action.nextAt ?? 0) <= now)",
    tests: ['server/lib/meeting-actions.test.ts'],
  },
  {
    name: 'revert-sweep-pass',
    file: 'server/lib/meeting-actions.ts',
    find: '      isWaitingState(action.state) && (action.nextAt ?? 0) <= startedAt)',
    replace: "      action.state === 'pending' && (action.nextAt ?? 0) <= startedAt)",
    tests: ['server/lib/meeting-actions.test.ts'],
  },
  {
    name: 'direction-durable',
    file: 'server/lib/meeting-actions-store.ts',
    find: "  return action.state === 'revert_pending' ? 'revert' : 'apply'",
    replace: "  return 'apply'",
    tests: ['server/lib/meeting-actions.test.ts'],
  },
  {
    name: 'retry-direction',
    file: 'server/lib/meeting-actions.ts',
    find: "      row.state = options.retryable && attempts < PIPELINE_MAX_ATTEMPTS ? pendingStateFor(directionOf(row)) : 'failed'",
    replace: "      row.state = options.retryable && attempts < PIPELINE_MAX_ATTEMPTS ? 'pending' : 'failed'",
    tests: ['server/lib/meeting-actions.test.ts'],
  },
  {
    name: 'retry-refuses-non-failed',
    file: 'server/lib/meeting-actions.ts',
    find: "      throw new ActionRefusedError(409, 'action_not_failed', 'Only a failed action can be retried.')",
    replace: '      void 0',
    tests: ['server/lib/meeting-actions.test.ts'],
  },
  {
    name: 'capture-gate',
    file: 'server/lib/meeting-actions.ts',
    find: '  return CAPTURE_LEASE_KINDS.some(kind => (byKind[kind] ?? 0) > 0)',
    replace: '  return false',
    tests: ['server/lib/meeting-actions-collect.test.ts'],
  },
  {
    name: 'input-scan-bail',
    file: 'server/lib/meeting-actions.ts',
    find: '      if (!forced && last && last.mode === mode && last.newestMtimeMs === stamp.newestMtimeMs && last.count === stamp.count) {',
    replace: '      if (false) {',
    tests: ['server/lib/meeting-actions-collect.test.ts'],
  },
  {
    name: 'input-scan-counts-deletions',
    file: 'server/lib/meeting-actions.ts',
    find: '        count += 1',
    replace: '        count += 0',
    tests: ['server/lib/meeting-actions-collect.test.ts'],
  },
  {
    name: 'hash-cache-size',
    file: 'server/lib/meeting-actions.ts',
    find: '    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.sha256',
    replace: '    if (cached) return cached.sha256',
    tests: ['server/lib/meeting-actions-collect.test.ts'],
  },
  {
    name: 'scribe-size-guard',
    file: 'server/lib/meeting-actions.ts',
    find: '    if (statSync(path).size > MAX_SCRIBE_BYTES) return { blended: false, oversized: true }',
    replace: '    if (false) return { blended: false, oversized: true }',
    tests: ['server/lib/meeting-actions-collect.test.ts'],
  },
  {
    name: 'fireflies-sidecar-version',
    file: 'server/lib/meeting-actions.ts',
    find: '          if (doc.sidecar_version !== FIREFLIES_SIDECAR_VERSION) {',
    replace: '          if (false) {',
    tests: ['server/lib/meeting-actions-collect.test.ts'],
  },
  {
    name: 'fireflies-sidecar-clipped',
    file: 'server/lib/meeting-actions.ts',
    find: '          if (doc.clipped === true) {',
    replace: '          if (false) {',
    tests: ['server/lib/meeting-actions-collect.test.ts'],
  },
  {
    name: 'split-apply-mode-refusal',
    file: 'server/lib/meeting-actions.ts',
    find: "      if (kind === 'split' && mode === 'apply') {",
    replace: '      if (false) {',
    tests: ['server/lib/meeting-actions.test.ts'],
  },
  {
    name: 'split-imports-only',
    file: 'server/lib/meeting-actions.ts',
    find: "    if (mode !== 'imports') return 'suggest'",
    replace: "    if (false) return 'suggest'",
    tests: ['server/lib/meeting-actions.test.ts'],
  },
  {
    name: 'split-d14-boundary',
    file: 'server/lib/meeting-actions.ts',
    find: "    return finishedAtMs < boundary ? 'suggest' : 'auto'",
    replace: "    return 'auto'",
    tests: ['server/lib/meeting-actions.test.ts'],
  },
  {
    name: 'patch-empty',
    file: 'server/lib/meeting-decisions.ts',
    find: '  if (patchIsEmpty(decision.patch)) {',
    replace: '  if (false) {',
    tests: ['server/lib/meeting-decisions.test.ts'],
  },
  {
    name: 'merges-remain-applied',
    file: 'server/lib/meeting-actions.ts',
    find: '      && ((mode === \'apply\') !== (pipelineSees.mode === \'apply\' || pipelineSees.active))',
    replace: '      && ((mode === \'apply\') !== (pipelineSees.mode === \'apply\'))',
    tests: ['server/lib/meeting-actions.test.ts'],
  },
  {
    name: 'mismatch-excludes-rollback',
    file: 'server/lib/meeting-actions.ts',
    find: '      && !mergesRemainApplied',
    replace: '      && true',
    tests: ['server/lib/meeting-actions.test.ts'],
  },
  {
    name: 'mac-class-transient-negative',
    file: 'server/lib/meeting-engine-mode.ts',
    find: "  if (recordedMacClass === 'pipeline') {",
    replace: '  if (false) {',
    tests: ['server/lib/meeting-engine-mode.test.ts'],
  },
  {
    name: 'mac-class-live-positive-wins',
    file: 'server/lib/meeting-engine-mode.ts',
    find: '  if (reaches) {',
    replace: '  if (false) {',
    tests: ['server/lib/meeting-engine-mode.test.ts'],
  },
  {
    name: 'day-counts-domain-scoped',
    file: 'server/lib/imported-library-rows.ts',
    find: '  groups.push(store.listDayCounts(month, domain))',
    replace: '  groups.push(store.listDayCounts(month))',
    tests: ['server/lib/superseded-day-counts.test.ts'],
  },
  {
    name: 'store-day-counts-domain',
    file: 'server/lib/meeting-store.ts',
    find: "    if (domain !== 'all') {",
    replace: '    if (false) {',
    tests: ['server/lib/superseded-day-counts.test.ts'],
  },
  {
    name: 'g2-source-basename',
    file: 'server/lib/meeting-engine/render.ts',
    find: "  const base = sidecarRelPath.split('/').pop() ?? sidecarRelPath",
    replace: '  const base = sidecarRelPath',
    tests: ['server/lib/meeting-engine/render-pipeline-patch.test.ts'],
  },
  {
    name: 'g2-source-escape',
    file: 'server/lib/meeting-engine/render.ts',
    find: "  return `${MARKER_G2_SOURCE_PREFIX}${base.replace(/--/g, '- -')} -->`",
    replace: '  return `${MARKER_G2_SOURCE_PREFIX}${base} -->`',
    tests: ['server/lib/meeting-engine/render-pipeline-patch.test.ts'],
  },
  {
    name: 'suggestion-sides-operations',
    file: 'server/lib/meeting-suggestion-sides.ts',
    find: '      ?? firefliesFromOperations(id, deps.firefliesScribeRelPaths)',
    replace: '      ?? null',
    tests: ['server/lib/meeting-suggestion-sides.test.ts'],
  },
  {
    name: 'suggestion-sides-resolved-honest',
    file: 'server/lib/meeting-suggestion-sides.ts',
    find: "  return { kind: 'g2', id: sessionId, resolved: false }",
    replace: "  return { kind: 'g2', id: sessionId, resolved: true }",
    tests: ['server/lib/meeting-suggestion-sides.test.ts'],
  },
  {
    name: 'pairing-carries-offsets',
    file: 'server/lib/meeting-engine/pairing.ts',
    find: '      existing.offsetMsBySession[result.sessionId] = result.offsetMs',
    replace: '      void result.offsetMs',
    tests: ['server/lib/meeting-engine/pairing.test.ts'],
  },
  {
    name: 'day-counts-recordings-root-fallback',
    file: 'server/lib/imported-library-rows.ts',
    find: '  const direct = sidecarSessionId(directory, filename)\n  if (direct) return direct',
    replace: '  return sidecarSessionId(directory, filename)',
    tests: ['server/lib/superseded-day-counts.test.ts'],
  },
  {
    name: 'day-counts-declared-sessions',
    file: 'server/lib/imported-library-rows.ts',
    find: '  if (declared) return new Set(declared)',
    replace: '  void declared',
    tests: ['server/lib/superseded-day-counts.test.ts'],
  },
  {
    name: 'g2-source-well-formed-comment',
    file: 'server/lib/meeting-engine/render.ts',
    find: "  return `${MARKER_G2_SOURCE_PREFIX}${base.replace(/--/g, '- -')} -->`",
    replace: '  return `${MARKER_G2_SOURCE_PREFIX}${base.replace(/--/g, "-")} -->`',
    tests: ['server/lib/meeting-engine/render-pipeline-patch.test.ts'],
  },
  {
    name: 'capture-heading-dash-free',
    file: 'server/lib/meeting-engine/render.ts',
    find: '  return `### Capture ${index + 1}, ${formatClock(capture.startMs)}, ${minutesOf(capture.durationMs / 1000)} min`',
    replace: '  return `### Capture ${index + 1} — ${formatClock(capture.startMs)}, ${minutesOf(capture.durationMs / 1000)} min`',
    tests: ['server/lib/meeting-engine/render.test.ts'],
  },
  {
    name: 'pipeline-patch-golden-drift',
    file: 'server/lib/meeting-engine/render.ts',
    find: "export const PIPELINE_SOURCES_LABEL = 'Fireflies + G2 Glasses'",
    replace: "export const PIPELINE_SOURCES_LABEL = 'Fireflies and G2 Glasses'",
    tests: ['server/lib/meeting-engine/render-pipeline-patch-golden.test.ts'],
  },
  {
    name: 'retry-imports-stays-failed',
    file: 'server/lib/meeting-actions.ts',
    find: "      const state: MergeActionRecord['state'] = current.mode === 'apply' ? pendingStateFor(direction) : 'failed'",
    replace: "      const state: MergeActionRecord['state'] = pendingStateFor(direction)",
    tests: ['server/lib/meeting-actions.test.ts'],
  },
  {
    name: 'retry-forces-a-collection',
    file: 'server/lib/meeting-actions.ts',
    find: '      this.forceNextCollection = true',
    replace: '      this.forceNextCollection = false',
    tests: ['server/lib/meeting-actions-collect.test.ts'],
  },
  {
    name: 'forced-collection-is-one-shot',
    file: 'server/lib/meeting-actions.ts',
    find: '    this.forceNextCollection = false\n    if (!options.rederiveOnly && !this.collectInjected) {',
    replace: '    if (!options.rederiveOnly && !this.collectInjected) {',
    tests: ['server/lib/meeting-actions-collect.test.ts'],
  },
  // 6.48.0 session hooks: the guards the /qa round added.
  {
    name: 'hooks-boot-drain-progress',
    file: 'server/lib/session-hook-spool.ts',
    find: '    if (sweep() === 0) break',
    replace: '    sweep()',
    tests: ['server/lib/session-hook-spool.test.ts'],
  },
  {
    name: 'hooks-permission-denied-by-name',
    file: 'server/lib/session-signal-store.ts',
    find: "  return event === 'PermissionDenied' && waiting.toolName === toolName",
    replace: '  return false',
    tests: ['server/lib/session-signal-store.test.ts'],
  },
  {
    name: 'hooks-post-tool-use-not-by-name',
    file: 'server/lib/session-signal-store.ts',
    find: "  return event === 'PermissionDenied' && waiting.toolName === toolName",
    replace: '  return waiting.toolName === toolName',
    tests: ['server/lib/session-signal-store.test.ts'],
  },
  {
    name: 'hooks-dead-grace',
    file: 'server/lib/session-state-derive.ts',
    find: '  const deadLongEnough = dead && deadScans >= MISS_LIMIT && deadSince !== null && now - deadSince >= DEAD_GRACE_MS',
    replace: '  const deadLongEnough = dead && deadScans >= MISS_LIMIT',
    tests: ['server/lib/session-signal-store.test.ts', 'server/lib/session-hooks-runtime.test.ts'],
  },
  {
    name: 'hooks-registry-yields-only-when-silent',
    file: 'server/lib/session-state-derive.ts',
    find: '  if (signal && !(registryMovedLater && hooksSilent)) {',
    replace: '  if (signal && !(registryMovedLater || hooksSilent)) {',
    tests: ['server/lib/session-signal-store.test.ts'],
  },
  {
    name: 'hooks-empty-token-no-request',
    file: 'bin/hooks/cos-session-hook',
    find: '; [ -n "$TOK" ] || { cleanup; exit 0; }   # no token, no request',
    replace: '',
    tests: ['server/lib/cos-session-hook.script.test.ts'],
  },
  {
    name: 'hooks-off-means-off',
    file: 'server/lib/session-hooks-runtime.ts',
    find: '  if (!sessionHooksEnabled()) return undefined\n  const signal = signalFor(input.sessionId)',
    replace: '  const signal = signalFor(input.sessionId)',
    tests: ['server/routes/session-hooks-wire.test.ts', 'server/lib/session-hooks-runtime.test.ts'],
  },
  // 6.48.1 session turns.
  {
    name: 'turns-tool-opens-turn',
    file: 'server/lib/session-signal-store.ts',
    find: "  if (prev.turnOpen || prev.ended || str(p.agent_id)) return {}\n  return { turnOpen: true, turnStartedAt: prev.turnStartedAt ?? at }",
    replace: '  return {}',
    tests: ['server/lib/session-signal-store.test.ts'],
  },
  {
    name: 'turns-subagent-tool-does-not-open',
    file: 'server/lib/session-signal-store.ts',
    find: "  if (prev.turnOpen || prev.ended || str(p.agent_id)) return {}",
    replace: '  if (prev.turnOpen || prev.ended) return {}',
    tests: ['server/lib/session-signal-store.test.ts'],
  },
  {
    name: 'turns-b6-registry-vouches',
    file: 'server/lib/occupancy-probes.ts',
    find: "      return registryIdleAfterStop(threadId, signal.stopAt) === true ? signal.stopAt : null",
    replace: "      return signal.stopAt",
    tests: ['server/lib/turn-from-tail.test.ts'],
  },
  {
    name: 'turns-b6-null-is-strict',
    file: 'server/lib/thread-occupancy.ts',
    find: "  if (typeof stopAt !== 'number' || !Number.isFinite(stopAt)) return activity",
    replace: "  if (typeof stopAt !== 'number' || !Number.isFinite(stopAt)) return 'idle'",
    tests: ['server/lib/thread-occupancy.test.ts'],
  },
  {
    name: 'turns-tail-pending-tool-holds',
    file: 'server/lib/session-stream-events.ts',
    find: "        verdict = pendingToolUses.size === 0 ? { ended: true, reason: 'terminal_stop' } : { ended: false, reason: 'tool_pending' }",
    replace: "        verdict = { ended: true, reason: 'terminal_stop' }",
    tests: ['server/lib/turn-from-tail.test.ts'],
  },
  {
    name: 'turns-kick-folds-into-one',
    file: 'server/lib/thread-drain-kick.ts',
    find: "    if (!followUp) {\n      stats.folded++\n      const current = inFlight\n      followUp = current.then(() => { followUp = null; return sweep() })\n    } else {\n      stats.folded++\n    }\n    return followUp",
    replace: "    stats.folded++\n    return runOnce()",
    tests: ['server/lib/thread-drain-kick.test.ts'],
  },
  {
    name: 'turns-kick-only-when-queued',
    file: 'server/lib/thread-drain-kick.ts',
    find: '      if (!queueNames(sessionId)) return false',
    replace: '      void sessionId',
    tests: ['server/lib/thread-drain-kick.test.ts'],
  },
  {
    name: 'turns-status-mapping',
    file: 'server/lib/session-stream-events.ts',
    find: "    : derived.agent_state === 'ended' ? 'done'",
    replace: "    : derived.agent_state === 'ended' ? 'idle'",
    tests: ['server/lib/session-stream-events.test.ts'],
  },
  {
    name: 'turns-replay-only-in-ring',
    file: 'server/routes/agent-session-stream.ts',
    find: "  return bounds.oldest <= after + 1 && after < bounds.newest",
    replace: "  return after < bounds.newest",
    tests: ['server/routes/agent-session-stream.test.ts'],
  },
  {
    name: 'turns-live-status-only-on-change',
    file: 'server/routes/agent-session-stream.ts',
    find: '      if (stampOf(derived) === lastStamp) return',
    replace: '      void lastStamp',
    tests: ['server/routes/agent-session-stream.test.ts'],
  },
  {
    name: 'turns-open-holds-over-idle',
    file: 'server/lib/thread-turn-queue.ts',
    find: "  if (seen.turnOpen === true) return 'hold'",
    replace: '  void seen.turnOpen',
    tests: ['server/lib/thread-turn-queue.test.ts'],
  },
  // 6.48.1 QA round (2026-09-15): the fixes that the round's blockers and warnings named.
  {
    name: 'turns-attached-turn-runs',
    file: 'server/lib/session-state-derive.ts',
    find: "  if (input.attachedTurn === true) {\n    return { agent_state: 'running', state_source: 'transcript', state_since: iso(transcript?.lastActivityAt ?? signal?.lastEventAt ?? now), ...carry, ...replyOf(signal) }\n  }",
    replace: '',
    tests: ['server/routes/agent-session-stream.test.ts'],
  },
  {
    name: 'turns-empty-replay-seeds',
    file: 'server/routes/agent-session-stream.ts',
    find: "  return bounds.oldest <= after + 1 && after < bounds.newest",
    replace: "  return bounds.oldest <= after + 1 && after <= bounds.newest",
    tests: ['server/routes/agent-session-stream.test.ts'],
  },
  {
    name: 'turns-cursor-epoch',
    file: 'server/routes/agent-session-stream.ts',
    find: "  if (m[1] !== undefined && Number(m[1]) !== epoch) return null",
    replace: '',
    tests: ['server/routes/agent-session-stream.test.ts'],
  },
  {
    name: 'turns-registry-idle-after-stop',
    file: 'server/lib/session-hooks-runtime.ts',
    find: "  return record.status === 'idle' && typeof record.statusUpdatedAt === 'number' && record.statusUpdatedAt >= stopAt",
    replace: "  return record.status === 'idle'",
    tests: ['server/lib/session-hooks-runtime.test.ts'],
  },
  {
    name: 'turns-registry-prefers-tab',
    file: 'server/lib/session-hooks-runtime.ts',
    find: "      if (isCosSpawnedPid(record.pid)) { childRecord ??= record; continue }",
    replace: '',
    tests: ['server/lib/session-hooks-runtime.test.ts'],
  },
  {
    name: 'turns-kick-plan-no-subagent-stop',
    file: 'server/lib/thread-drain-kick.ts',
    find: "  if (event !== 'Stop') return null",
    replace: "  if (event !== 'Stop' && event !== 'SubagentStop') return null",
    tests: ['server/lib/thread-drain-kick.test.ts'],
  },
  {
    name: 'turns-kick-plan-child-only-session-end',
    file: 'server/lib/thread-drain-kick.ts',
    find: "  if (child) return event === 'SessionEnd' ? { kind: 'kick' } : null",
    replace: "  if (child) return { kind: 'kick' }",
    tests: ['server/lib/thread-drain-kick.test.ts'],
  },
  {
    name: 'turns-kick-waits-for-ready',
    file: 'server/lib/thread-drain-kick.ts',
    find: "      if (readyNow) return kick(sessionId)",
    replace: "      return kick(sessionId)",
    tests: ['server/lib/thread-drain-kick.test.ts'],
  },
  {
    name: 'turns-open-holds-over-ended',
    file: 'server/lib/thread-turn-queue.ts',
    find: "  if (seen.turnOpen === true) return 'hold'\n  if (seen.turnEnded) return 'deliver'",
    replace: "  if (seen.turnEnded) return 'deliver'\n  if (seen.turnOpen === true) return 'hold'",
    tests: ['server/lib/thread-turn-queue.test.ts'],
  },
  {
    name: 'turns-tail-window',
    file: 'server/lib/thread-turn-queue-store.ts',
    find: 'export const TURN_END_TAIL_BYTES = 512 * 1024',
    replace: 'export const TURN_END_TAIL_BYTES = 64 * 1024',
    tests: ['server/lib/thread-turn-queue-store.test.ts'],
  },
  {
    name: 'turns-queued-prompt-holds',
    file: 'server/lib/session-stream-events.ts',
    find: "      if (r.operation === 'enqueue') verdict = { ended: false, reason: 'prompt_queued' }",
    replace: '',
    tests: ['server/lib/turn-from-tail.test.ts'],
  },
  {
    name: 'turns-system-message-is-a-prompt',
    file: 'server/lib/session-stream-events.ts',
    find: "    if (r.isMeta === true && r.promptSource !== 'system') continue",
    replace: '    if (r.isMeta === true) continue',
    tests: ['server/lib/turn-from-tail.test.ts'],
  },
  {
    name: 'turns-ledger-keeps-entrypoint',
    file: 'server/lib/session-hook-ledger.ts',
    find: "        ...(entrypoint ? { entrypoint } : {}),",
    replace: '',
    tests: ['server/lib/session-hook-spool.test.ts'],
  },
  {
    name: 'turns-deliver-sends-epoch-and-target',
    file: 'server/lib/thread-turn-queue-deliver.ts',
    find: "        epoch,\n        targetKey: targetKey(turn.provider, turn.threadId),",
    replace: '',
    tests: ['server/lib/thread-turn-queue-deliver.test.ts'],
  },
]

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function runTests(files) {
  const result = spawnSync(
    'npx',
    ['vitest', 'run', '--maxWorkers=1', '--testTimeout=60000', ...files],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env } },
  )
  return result.status === 0
}

const args = process.argv.slice(2)
if (args.includes('--list')) {
  for (const testCase of CASES) console.log(`${testCase.name}\t${testCase.file}`)
  process.exit(0)
}
const selected = args.length > 0 ? CASES.filter(c => args.includes(c.name)) : CASES
if (selected.length === 0) {
  console.error(`No matching cases. Known: ${CASES.map(c => c.name).join(', ')}`)
  process.exit(2)
}

/**
 * The union of every target suite has to be GREEN before a single mutation is applied.
 *
 * WITHOUT THIS THE GATE CANNOT FAIL. A kill is decided from a non-zero vitest exit, and a
 * suite that was already red returns non-zero for every mutant — so an inert edit that
 * changes no behaviour at all reads as killed, and the run reports a number that means
 * nothing. Found by the pipeline agent in their own harness, proved there with an inert
 * comment edit against a deliberately red suite, and reported here because this gate decides
 * a kill the same way.
 */
const baselineSuites = [...new Set(selected.flatMap(testCase => testCase.tests))].sort()
console.log(`baseline: ${baselineSuites.length} suite(s), unmutated`)
if (!runTests(baselineSuites)) {
  console.error('BASELINE NOT GREEN - refusing to run. Every mutant would read as KILLED.')
  console.error(`Suites: ${baselineSuites.join(' ')}`)
  process.exit(2)
}
console.log('baseline green')

/** Everything currently mutated, so an interrupt puts it all back. */
const open = new Map()

function restoreAll() {
  for (const [path, original] of open) {
    try { writeFileSync(path, original) } catch { /* nothing better to do while dying */ }
  }
  open.clear()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreAll()
    process.exit(130)
  })
}
process.on('uncaughtException', error => {
  restoreAll()
  console.error(error)
  process.exit(1)
})

const killed = []
const survived = []
const refused = []

for (const testCase of selected) {
  const path = join(ROOT, testCase.file)
  const original = readFileSync(path, 'utf8')
  const before = sha256(original)
  const occurrences = original.split(testCase.find).length - 1
  if (occurrences !== 1) {
    refused.push(`${testCase.name}: target appears ${occurrences} times, expected exactly 1`)
    continue
  }
  const mutated = original.replace(testCase.find, testCase.replace)
  if (mutated === original) {
    refused.push(`${testCase.name}: the replacement changed nothing`)
    continue
  }
  open.set(path, original)
  writeFileSync(path, mutated)
  // Proof the edit LANDED, not just that it was computed.
  if (sha256(readFileSync(path, 'utf8')) === before) {
    writeFileSync(path, original)
    open.delete(path)
    refused.push(`${testCase.name}: the file on disk did not change`)
    continue
  }
  const passed = runTests(testCase.tests)
  writeFileSync(path, original)
  open.delete(path)
  const after = sha256(readFileSync(path, 'utf8'))
  if (after !== before) {
    console.error(`FATAL: ${testCase.file} was not restored byte for byte after ${testCase.name}`)
    process.exit(3)
  }
  if (passed) {
    survived.push(testCase.name)
    console.log(`SURVIVED  ${testCase.name}  (${testCase.file})`)
  } else {
    killed.push(testCase.name)
    console.log(`killed    ${testCase.name}`)
  }
}

console.log('')
console.log(`killed ${killed.length}/${selected.length}`)
if (refused.length > 0) {
  console.log('refused:')
  for (const line of refused) console.log(`  ${line}`)
}
if (survived.length > 0) {
  console.log('SURVIVED (that branch is unreached by its tests):')
  for (const name of survived) console.log(`  ${name}`)
}
process.exit(survived.length === 0 && refused.length === 0 ? 0 : 1)
