#!/usr/bin/env node
// Sessions durability 6.78.0 (P3) mutation gate: the attempt journal and dead-boot pins
// (lib/agent-session-binding-registry.ts), the reconcile verdicts and receipts
// (lib/queue-turn-evidence.ts), the flags, reason copy and retention (lib/thread-turn-queue.ts),
// the drain stamp, restart reconcile, replay-before-gate and Send again
// (routes/thread-turn-queue.ts), the loopback pass-through, the turns route's receipts and
// attempt exits (routes/agent-session-bindings.ts), and the composition-root wiring. Session
// steer has its own gate (session-steer-mutation-gate.mjs). Mutations run only in a
// disposable copy of the checkout; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/turn-queue-durable-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REGT = ['server/lib/agent-session-binding-registry-p3.test.ts']
const EVT = ['server/lib/queue-turn-evidence-p3.test.ts']
const TQLT = ['server/lib/thread-turn-queue-p3.test.ts']
const TQRT = ['server/routes/thread-turn-queue-p3.test.ts']
const BINDT = ['server/routes/agent-session-bindings-p3.test.ts']
const INTT = ['server/routes/queue-receipts-integration.test.ts']
const OFFT = ['server/lib/pi-durable-flags-off.test.ts']
const WIRET = ['server/lib/pi-durable-sessions-wiring.test.ts']
const ALL = [...REGT, ...EVT, ...TQLT, ...TQRT, ...BINDT, ...INTT, ...OFFT, ...WIRET]
const REG = 'server/lib/agent-session-binding-registry.ts', EVID = 'server/lib/queue-turn-evidence.ts'
const TQL = 'server/lib/thread-turn-queue.ts', TQR = 'server/routes/thread-turn-queue.ts'
const DELIV = 'server/lib/thread-turn-queue-deliver.ts', BIND = 'server/routes/agent-session-bindings.ts'
const INDEX = 'server/index.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── The attempt journal (registry) ──
  m('pin-opens-attempt-same-commit', REG, ['        ...(meta ? { pinMeta: meta } : {}),\n        ...(journal ? { attempts: journal.attempts, attemptsEvictedThrough: journal.evictedThrough } : {}),\n', '        ...(meta ? { pinMeta: meta } : {}),\n'], [...REGT, ...BINDT]),
  m('pin-writes-pin-meta', REG, ['        ...(meta ? { pinMeta: meta } : {}),\n', ''], [...REGT, ...BINDT]),
  m('unpin-records-exit', REG, ['        lastUnpinAt: held && Number.isFinite(now) ? now : record.lastUnpinAt,\n        ...(journal ? { attempts: journal.attempts, attemptsEvictedThrough: journal.evictedThrough } : {}),\n', '        lastUnpinAt: held && Number.isFinite(now) ? now : record.lastUnpinAt,\n'], [...REGT, ...BINDT]),
  m('attempt-only-change-commits', REG, ['    if (unchanged && patch.attempts === undefined) return { binding: previous.binding, reason: null }', '    if (unchanged) return { binding: previous.binding, reason: null }'], [...REGT, ...BINDT]),
  m('settle-invents-nothing', REG, ['    if (!current) return null\n    const attempts = cloneAttempts(this.attempts)\n    attempts.get(targetKeyValue)!.set(clientTurnId, { ...current, exit })',
    "    const attempts = cloneAttempts(this.attempts)\n    if (!attempts.has(targetKeyValue)) attempts.set(targetKeyValue, new Map())\n    attempts.get(targetKeyValue)!.set(clientTurnId, { bootId: this.bootId, at: now, mode: 'turn', ...current, exit })"], REGT),
  m('degraded-journal-is-null', REG, ['  attemptFor(provider: unknown, nativeThreadId: unknown, clientTurnId: unknown): TurnAttemptLookup | null {\n    if (!this.available()) return null\n', '  attemptFor(provider: unknown, nativeThreadId: unknown, clientTurnId: unknown): TurnAttemptLookup | null {\n'], REGT),
  m('age-shed-raises-evicted', REG, ['if (Number.isFinite(now) && now - row.at > ATTEMPT_RETENTION_MS) { rows.delete(id); shed(row.at) }', 'if (Number.isFinite(now) && now - row.at > ATTEMPT_RETENTION_MS) { rows.delete(id) }'], REGT),
  m('retention-keeps-48h', REG, ['if (Number.isFinite(now) && now - row.at > ATTEMPT_RETENTION_MS) {', 'if (Number.isFinite(now) && now - row.at > 0) {'], [...REGT, ...BINDT]),
  m('malformed-row-raises-evicted', REG, ['            if (attempt) kept.set(id, attempt)\n            else attemptsEvictedThrough = now\n', '            if (attempt) kept.set(id, attempt)\n'], REGT),
  m('journal-survives-other-commits', REG, ['    const attempts = next.attempts ?? this.attempts\n', '    const attempts = next.attempts ?? new Map<string, Map<string, TurnAttempt>>()\n'], [...REGT, ...BINDT]),
  m('journal-absent-from-6.77-bytes', REG, ['        ...(attempts.size > 0\n          ? {', '        ...(true\n          ? {'], [...REGT, ...OFFT]),

  // ── Pins a dead boot left (registry) ──
  m('orphan-release-inherited-only', REG, ['        if (!this.inheritedPins.has(`${id}\\u0000${job}`)) return false\n', ''], REGT),
  m('orphan-hold-live-pin-is-null', REG, ['      if (!this.inheritedPins.has(`${record.binding.bindingId}\\u0000${job}`)) return null\n', ''], REGT),
  m('orphan-window-from-restart', REG, ['    return Math.max(pinned, this.openedAt) + QUERY_JOB_ORPHAN_FENCE_MS', '    return pinned + QUERY_JOB_ORPHAN_FENCE_MS'], REGT),
  m('orphan-window-21-minutes', REG, ['    return Math.max(pinned, this.openedAt) + QUERY_JOB_ORPHAN_FENCE_MS', '    return Math.max(pinned, this.openedAt)'], [...REGT, ...BINDT, ...INTT]),
  m('orphan-due-at-the-instant', REG, ['        return now >= this.orphanReleaseAt(record, job)', '        return now > this.orphanReleaseAt(record, job)'], [...REGT, ...BINDT]),
  m('orphan-hold-ends-at-release', REG, ['    return releasesAt > now ? { releasesAt } : null', '    return { releasesAt }'], REGT),
  m('orphan-records-ambiguous', REG, ['          turns.set(id, [...ledger, { turnId: meta.clientTurnId, result: orphanReleaseRecord(job), at: now }].slice(-MAX_TURNS_PER_BINDING))\n          recorded += 1\n', '          recorded += 1\n'], [...REGT, ...INTT]),
  m('orphan-keeps-finished-record', REG, ['        if (!known) {', '        if (true) {'], REGT),
  m('orphan-pending-becomes-unknown', REG, ["        if (current && current.exit === 'pending') {", '        if (false) {'], REGT),
  m('orphan-release-is-not-activity', REG, ['        updatedAt: record.updatedAt,\n        pinnedAt: Object.freeze(pinnedAt),\n        lastUnpinAt: now,', '        updatedAt: now,\n        pinnedAt: Object.freeze(pinnedAt),\n        lastUnpinAt: now,'], REGT),
  m('orphan-record-is-ambiguous', REG, ["    outcome: 'ambiguous',\n    deliveryState: 'unknown',\n    retryable: false,", "    outcome: 'completed',\n    deliveryState: 'unknown',\n    retryable: false,"], [...REGT, ...INTT]),
  m('orphan-lazy-on-attach', REG, ['      if (this.pinBootReap()) this.releaseOrphansUnlocked(now, key)\n', ''], [...REGT, ...BINDT]),
  m('orphan-lazy-on-occupancy', REG, ['    if (this.pinBootReap()) this.reapOrphanedPins(now, makeTargetKey(provider, nativeThreadId))\n', ''], [...REGT, ...INTT]),
  m('orphan-flag-off-releases-nothing', REG, ['    if (!this.available() || !Number.isFinite(now) || !this.pinBootReap()) return none', '    if (!this.available() || !Number.isFinite(now)) return none'], REGT),
  m('find-turn-scoped-to-target', REG, ['      if (record.binding.targetKey !== key) continue\n      const hit', '      const hit'], REGT),

  // ── Reconcile verdicts (evidence) ──
  m('verdict-queued-ledger-delivered', EVID, ["  if (facts.ledgerOutcome === 'completed' || facts.ledgerOutcome === 'queued') return 'delivered'", "  if (facts.ledgerOutcome === 'completed') return 'delivered'"], EVT),
  m('verdict-attempt-sent-delivered', EVID, ["  if (facts.attempt?.attempt?.exit === 'sent') return 'delivered'\n", ''], EVT),
  m('verdict-transcript-delivered', EVID, ["  if (facts.transcriptMatch) return 'delivered'\n", ''], EVT),
  m('verdict-codex-queue-delivered', EVID, ["  if (facts.codexQueueMatch) return 'delivered'\n", ''], EVT),
  m('verdict-ambiguous-unknown', EVID, ["  if (facts.ledgerOutcome === 'ambiguous') return 'unknown'\n", ''], EVT),
  m('verdict-unstamped-unknown', EVID, ["  if (facts.row.journal !== 1) return 'unknown'\n", ''], EVT),
  m('verdict-steer-unknown', EVID, ["  if (facts.row.mode === 'steer') return 'unknown'\n", ''], EVT),
  m('verdict-unreadable-journal-unknown', EVID, ["  if (facts.attempt === null) return 'unknown'", "  if (facts.attempt === null) return 'not_delivered'"], EVT),
  m('verdict-only-not-sent-is-unsent', EVID, ["  if (attempt !== null) return attempt.exit === 'not_sent' ? 'not_delivered' : 'unknown'", "  if (attempt !== null) return 'not_delivered'"], EVT),
  m('verdict-shed-key-unknown', EVID, ["  if (shed !== null && shed >= facts.row.queuedAt) return 'unknown'", "  if (false) return 'unknown'"], EVT),
  m('transcript-exact-words', EVID, ['  if (text.trim() === want) return true', '  if (text.includes(want)) return true'], EVT),
  m('transcript-after-since', EVID, ['    if (at === null || at < sinceMs) continue', '    if (at === null) continue'], EVT),
  m('transcript-tool-result-never', EVID, ["    if (b.type === 'tool_result') return null\n", ''], EVT),
  m('transcript-peer-wrapper', EVID, ['  return unwrapPeerMessage(text) === want', '  return false'], EVT),
  m('evidence-since-attempt-began', EVID, ['const since = (attempt?.attempt?.at ?? turn.queuedAt) - EVIDENCE_BACKDATE_MS', 'const since = turn.queuedAt - EVIDENCE_BACKDATE_MS'], EVT),
  m('evidence-throw-is-unknown', EVID, ["      return reconcileVerdict({ row: turn, ledgerOutcome, transcriptMatch, codexQueueMatch, attempt })\n    } catch {\n      return 'unknown'", "      return reconcileVerdict({ row: turn, ledgerOutcome, transcriptMatch, codexQueueMatch, attempt })\n    } catch {\n      return 'not_delivered'"], EVT),

  // ── Receipts (evidence) ──
  m('receipt-status-filter', EVID, ["  return row.status === 'delivered' || (row.status === 'refused' && row.deliveryState === 'unknown')", '  return true'], [...EVT, ...INTT]),
  m('receipt-refused-needs-unknown', EVID, ["  return row.status === 'delivered' || (row.status === 'refused' && row.deliveryState === 'unknown')", "  return row.status === 'delivered' || row.status === 'refused'"], [...EVT, ...BINDT]),
  m('receipt-attempt-sent', EVID, ["    if (attempt.exit === 'sent') return { kind: 'delivered', source: 'attempt' }\n", ''], [...EVT, ...BINDT]),
  m('receipt-this-boot-pending-not-receipt', EVID, ["    const unknown = attempt.exit === 'unknown' || (attempt.exit === 'pending' && attempt.bootId !== deps.bootId)", "    const unknown = attempt.exit === 'unknown' || attempt.exit === 'pending'"], [...EVT, ...BINDT]),
  m('receipt-transcript-upgrade', EVID, ["      if (transcriptShowsPrompt(provider, lines, prompt, attempt.at - EVIDENCE_BACKDATE_MS)) return { kind: 'delivered', source: 'transcript' }\n", ''], EVT),

  // ── Flags, copy, retention (lib) ──
  m('flag-reconcile-default-on', TQL, ["  return triStateFlag(env, 'COS_QUEUE_RECONCILE', true)", "  return triStateFlag(env, 'COS_QUEUE_RECONCILE', false)"], TQLT),
  m('flag-pin-reap-default-on', TQL, ["  return triStateFlag(env, 'COS_PIN_BOOT_REAP', true)", "  return triStateFlag(env, 'COS_PIN_BOOT_REAP', false)"], TQLT),
  m('flag-resend-default-on', TQL, ["  return triStateFlag(env, 'COS_QUEUE_RESEND', true)", "  return triStateFlag(env, 'COS_QUEUE_RESEND', false)"], TQLT),
  m('flag-zero-is-off', TQL, ["  if (env[name] === '0') return false\n", ''], [...TQLT, ...OFFT]),
  m('prune-keeps-unknown-6h', TQL, ['return now - settled < (unknown ? Math.max(settledRetentionMs, UNKNOWN_DELIVERY_RETENTION_MS) : settledRetentionMs)', 'return now - settled < settledRetentionMs'], [...TQLT, ...TQRT]),
  m('prune-unknown-rule-behind-flag', TQL, ['    const unknown = keepUnknown && (', '    const unknown = ('], TQLT),
  m('copy-never-a-raw-code', TQL, ['? QUEUED_TURN_REASON_COPY[reason] : null', '? QUEUED_TURN_REASON_COPY[reason] : reason'], TQLT),
  m('copy-unknown-is-contract-line', TQL, ["  delivery_unknown_after_restart: 'May not have been sent. Read it, then say it again.',", "  delivery_unknown_after_restart: 'Refused.',"], [...TQLT, ...TQRT]),

  // ── Drain and restart reconcile (route) ──
  m('drain-stamps-journal', TQR, ['      turn.journal = 1\n', ''], TQRT),
  m('drain-stamps-boot', TQR, ["      if (typeof deps.bootId === 'string' && deps.bootId.length > 0) turn.deliveringBootId = deps.bootId\n      else delete turn.deliveringBootId", '      delete turn.deliveringBootId'], TQRT),
  m('drain-reconciles-first', TQR, ["  if (reconcile && typeof deps.deliveryEvidence === 'function') await reconcileDeliveringTurns(provider, threadId, deps)\n", ''], [...TQRT, ...INTT]),
  m('reconcile-skips-own-boot', TQR, ["    .filter(t => t.status === 'delivering' && t.deliveringBootId !== ownBoot)", "    .filter(t => t.status === 'delivering')"], TQRT),
  m('reconcile-needs-own-boot', TQR, ['  if (ownBoot === null) return counts\n', ''], TQRT),
  m('reconcile-enforces-stamp-rule', TQR, ["    if (verdict === 'not_delivered' && (row.journal !== 1 || row.mode === 'steer')) verdict = 'unknown'\n", ''], TQRT),
  m('reconcile-rereads-before-write', TQR, ["    if (!current || current.status !== 'delivering' || current.deliveringBootId !== row.deliveringBootId) continue", '    if (!current) continue'], TQRT),
  m('reconcile-attempt-stays-spent', TQR, ["      current.reason = 'requeued_after_restart'\n", "      current.reason = 'requeued_after_restart'\n      current.attempts = 0\n"], TQRT),
  m('reconcile-unknown-state', TQR, ["      current.deliveryState = 'unknown'\n", ''], TQRT),
  m('drain-replayed-unknown-settles', TQR, ["    } else if (reconcile && outcome.replayed === true && outcome.deliveryState === 'unknown') {", '    } else if (false) {'], [...TQRT, ...INTT]),

  // ── Rows, replay-before-gate, Send again (route) ──
  m('row-6.77-bytes-when-off', TQR, ['  if (!reconcile && !resend && !sessionSteerEnabled()) return row\n', ''], [...TQRT, ...OFFT]),
  m('row-resendable-only-refused-expired', TQR, ["    ...(resend && (turn.status === 'refused' || turn.status === 'expired') ? { resendable: true } : {}),", '    ...(resend ? { resendable: true } : {}),'], TQRT),
  m('row-resendable-behind-flag', TQR, ["    ...(resend && (turn.status === 'refused' || turn.status === 'expired') ? { resendable: true } : {}),", "    ...((turn.status === 'refused' || turn.status === 'expired') ? { resendable: true } : {}),"], TQRT),
  m('row-copy-behind-reconcile', TQR, ['  const reasonCopy = reconcile ? queuedTurnReasonCopy(turn.reason) : null', '  const reasonCopy = queuedTurnReasonCopy(turn.reason)'], TQRT),
  m('replay-before-gate', TQR, ['      if (held) {', '      if (false) {'], TQRT),
  m('replay-keeps-409', TQR, ["        return res.status(409).json({\n          error: 'duplicate_turn',", "        return res.status(200).json({\n          error: 'duplicate_turn',"], TQRT),
  m('replay-behind-flags', TQR, ['    if (queueReconcileEnabled() || steerOn) {', '    if (true) {'], TQRT),
  m('resend-once-only', TQR, ["    if (typeof original.resentAs === 'string' && original.resentAs.length > 0) {", '    if (false) {'], TQRT),
  m('resend-records-resent-as', TQR, ['    original.resentAs = newId\n', ''], TQRT),
  m('resend-only-refused-expired', TQR, ["    if (original.status !== 'refused' && original.status !== 'expired') return res.status(409).json({ error: 'not_resendable' })\n", ''], TQRT),
  m('resend-unknown-needs-ack', TQR, ["    if (original.deliveryState === 'unknown' && body.acknowledge !== 'may_duplicate') {", '    if (false) {'], TQRT),
  m('resend-pruned-404', TQR, ["    if (!original) return res.status(404).json({ error: 'unknown_turn' })", "    if (!original) return res.status(409).json({ error: 'not_resendable' })"], TQRT),
  m('resend-route-behind-flag', TQR, ['    if (!queueResendEnabled()) return next()\n', ''], TQRT),
  m('resend-no-await-between-read-and-write', TQR, [
    ["'/agent-sessions/:provider/:threadId/queued-turns/:clientTurnId/resend', (req: Request, res: Response, next) => {", "'/agent-sessions/:provider/:threadId/queued-turns/:clientTurnId/resend', async (req: Request, res: Response, next) => {"],
    ['    const original = queue.find(t => t.clientTurnId === originalId)\n', '    const original = queue.find(t => t.clientTurnId === originalId)\n    await new Promise(r => setTimeout(r, 25))\n'],
  ], TQRT),

  // ── Loopback pass-through ──
  m('loopback-passes-replayed', DELIV, ['      ...(sent.body.replayed === true ? { replayed: true } : {}),\n', ''], INTT),
  m('loopback-passes-delivery-state', DELIV, ["      ...(typeof sent.body.deliveryState === 'string' ? { deliveryState: sent.body.deliveryState } : {}),\n", ''], INTT),

  // ── The turns route: receipts and attempt exits ──
  m('turns-consult-receipts', BIND, ["      if (queueReconcileEnabled() && typeof deps.turnReceipt === 'function') {", '      if (false) {'], [...BINDT, ...INTT]),
  m('turns-receipts-behind-flag', BIND, ["      if (queueReconcileEnabled() && typeof deps.turnReceipt === 'function') {", "      if (typeof deps.turnReceipt === 'function') {"], BINDT),
  m('turns-receipt-throw-fails-closed', BIND, ["            receipt = { kind: 'unknown', source: 'attempt' }", '            receipt = null'], BINDT),
  m('turns-receipt-says-replayed', BIND, ['                replayed: true,\n                receipt: receipt.source,', '                receipt: receipt.source,'], [...BINDT, ...INTT]),
  m('turns-receipt-unknown-is-ambiguous', BIND, ["                outcome: delivered ? 'completed' : 'ambiguous',", "                outcome: 'completed',"], [...BINDT, ...INTT]),
  m('turns-pin-opens-attempt', BIND, ["        ...(queueReconcileEnabled() ? { attempt: { clientTurnId, mode: 'turn' as const } } : {}),", '        ...({}),'], [...BINDT, ...INTT]),
  m('turns-pin-names-turn', BIND, ['        ...(pinBootReapEnabled() ? { pinMeta: { clientTurnId } } : {}),', '        ...({}),'], [...BINDT, ...INTT]),
  m('turns-live-throw-may', BIND, ['        if (live === null) liveMay = true\n        if (live?.ok) {', '        if (live?.ok) {'], BINDT),
  m('turns-live-unverified-may', BIND, ['          liveMay = true\n          // 6.53.3: something MAY', '          // 6.53.3: something MAY'], [...BINDT, ...INTT]),
  m('turns-live-proven', BIND, ['        if (live?.ok) {\n          proven = true\n          // 6.53.3: delivered, so the turn runs', '        if (live?.ok) {\n          // 6.53.3: delivered, so the turn runs'], BINDT),
  m('turns-codex-may', BIND, ["        if (live === null || live.reason === 'unverified') liveMay = true\n", ''], BINDT),
  m('turns-codex-proven', BIND, ['          proven = true\n          // 6.53.3: queued in the Codex app', '          // 6.53.3: queued in the Codex app'], BINDT),
  m('turns-spawn-may', BIND, ['      spawnMay = true\n', ''], BINDT),
  m('turns-aborted-not-sent', BIND, ['        spawnMay = false\n', ''], BINDT),
  m('turns-spawn-proven', BIND, ['      if (after !== null) guard.acknowledgeHead(bindingId, after)\n      proven = true\n', '      if (after !== null) guard.acknowledgeHead(bindingId, after)\n'], BINDT),
  m('turns-unpin-carries-exit', BIND, ['            deps.bindings.unpin!(pinnedBindingId, turnId, readNow() ?? requestNow, { attemptExit: { clientTurnId, exit: attemptExit() } })', '            deps.bindings.unpin!(pinnedBindingId, turnId, readNow() ?? requestNow)'], BINDT),
  m('turns-exit-may-is-unknown', BIND, ["(proven ? 'sent' : liveMay || spawnMay ? 'unknown' : 'not_sent')", "(proven ? 'sent' : 'not_sent')"], [...BINDT, ...INTT]),
  m('attach-orphan-copy', BIND, ['      if (hold && Number.isFinite(hold.releasesAt)) extra.reasonCopy = orphanPinWaitCopy(hold.releasesAt)\n', ''], [...BINDT, ...INTT]),
  m('orphan-copy-rounds-up', BIND, ['  const at = new Date(Math.ceil(releasesAt / 60_000) * 60_000)', '  const at = new Date(Math.floor(releasesAt / 60_000) * 60_000)'], BINDT),
  m('orphan-copy-12-hour', BIND, ['  const hour = at.getHours() % 12 || 12', '  const hour = at.getHours()'], BINDT),

  // ── Composition root (source-shape tests: index.ts cannot be executed) ──
  m('index-tick-releases-orphans', INDEX, ["  releaseOrphanPins('tick')\n", ''], WIRET),
  m('index-queue-gets-boot', INDEX, ['    bootId: serverMetrics.bootId,\n    deliveryEvidence: makeDeliveryEvidence({', '    deliveryEvidence: makeDeliveryEvidence({'], WIRET),
  m('index-evidence-reads-journal', INDEX, ['      attempt: queueAttempt,\n      transcriptLines: queueEvidenceLines,', '      attempt: () => null,\n      transcriptLines: queueEvidenceLines,'], WIRET),
  m('index-attempt-begin-wired', INDEX, ['        agentSessionBindingRegistry.beginAttempt(provider, threadId, clientTurnId, mode, now),', '        true,'], WIRET),
  m('index-receipts-this-boot', INDEX, ['    transcriptLines: queueEvidenceLines,\n    bootId: serverMetrics.bootId,\n  }),', "    transcriptLines: queueEvidenceLines,\n    bootId: 'unknown-boot',\n  }),"], WIRET),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length && !args.includes('--check') ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && !args.includes('--check') && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')
// --check: every target matches exactly once and changes its file. Runs no tests.
if (args.includes('--check')) {
  let bad = 0
  for (const { name, file, edits } of mutations) {
    let text = readFileSync(join(root, file), 'utf8')
    const original = text
    for (const [find, replacement] of edits) {
      const n = text.split(find).length - 1
      if (n !== 1) { console.log(`${name}: matches ${n} times in ${file}: ${find.slice(0, 90)}`); bad++ }
      else text = text.replace(find, () => replacement)
    }
    if (text === original) { console.log(`${name}: no change`); bad++ }
  }
  console.log(`${mutations.length - bad} of ${mutations.length} targets match exactly once`)
  process.exit(bad ? 1 : 0)
}

const scratch = mkdtempSync(join(tmpdir(), 'turn-queue-durable-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  for (const dir of ['shared', 'work-task-runtime', 'bin', 'docs']) cpSync(join(root, dir), join(scratch, dir), { recursive: true })
  for (const file of ['vitest.config.ts', 'package.json', 'managed-runtime-contract.json', '.env.example']) cpSync(join(root, file), join(scratch, file))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: process.env.TMPDIR, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json') },
    encoding: 'utf8', timeout: 300000,
  })
  const baseline = run(ALL)
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  const totals = /Tests\s+(\d+) passed/.exec(baseline.stdout)
  console.log(`baseline PASS (${totals ? totals[1] : '?'} tests in ${ALL.length} files)`)
  let killed = 0
  for (const { name, file, edits, tests } of selected) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    let mutated = original
    for (const [find, replacement] of edits) {
      if (mutated.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}: ${find.slice(0, 80)}`)
      mutated = mutated.replace(find, () => replacement)
    }
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    let result
    try { result = run(tests) } finally { writeFileSync(target, original) }
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    const output = result.stdout + '\n' + result.stderr
    const killers = [...new Set([...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(x => x[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { console.log(`${name} SURVIVED or harness failed\n${output.slice(-3000)}`); process.exitCode = 1; continue }
    killed += 1
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${killed} of ${selected.length} Sessions durability 6.78.0 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
