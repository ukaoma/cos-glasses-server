#!/usr/bin/env node
// 6.59.0 Work progress and handoff request mutation gate. Mutations run only in a disposable copy of server/ and
// shared/; the live checkout is never rewritten. The unmutated suite must pass first (a gate over a red suite proves
// nothing), each target must match exactly once, and each mutant must fail a NAMED test (a transform or compile error
// fails the file, not a named test, so it never counts as a kill).
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const scratch = mkdtempSync(join(tmpdir(), 'work-progress-mutations-'))
const tests = ['server/lib/work-activity.test.ts', 'server/routes/work-board.test.ts', 'server/lib/work-handoff-requests.test.ts', 'server/routes/work-handoff-requests.test.ts']
const LIB = 'server/lib/work-activity.ts', BOARD = 'server/routes/work-board.ts', STORE = 'server/lib/work-handoff-requests.ts', ROUTE = 'server/routes/work-handoff-requests.ts'
const mutations = [
  // S1: progress projection
  ['malformed-progress-dropped', LIB, ' || !absentOr(receivedAt, finite)', ''],
  ['malformed-event-dropped', LIB, "\n      || !absentOr(event.undoneAt, finite)) return undefined", ') return undefined'],
  ['evidence-cap-280', LIB, 'evidence: 280,', 'evidence: 300,'],
  ['evidence-control-as-space', LIB, "const flat = value.replace(CONTROL, ' ').trim()", 'const flat = value.trim()'],
  ['evidence-only-with-report', LIB, '  if (state) {\n', '  if (true) {\n'],
  ['unknown-kind-no-report', LIB, "reported === 'done' || reported === 'needsInput' || reported === 'blocked' ? reported : null", "typeof reported === 'string' ? reported : null"],
  ['last-move-undone', LIB, 'undone: finite(move.undoneAt)', 'undone: false'],
  ['last-move-newest', LIB, '[...list].reverse().find(', '[...list].find('],
  ['last-move-known-stages', LIB, "WORK_ACTIVITY_STAGES.includes(move.toStage as string)", 'true'],
  ['updated-at-newest-event', LIB, 'isoFromSeconds(Math.max(receipt.createdAt as number, progress.newestAt))', 'isoFromSeconds(receipt.createdAt as number)'],
  ['acknowledged-reviewed', LIB, "finite(receipt.acknowledgedAt) || raw === 'reviewed'", 'finite(receipt.acknowledgedAt)'],
  ['app-opened-tab', LIB, "(object(receipt.appOpen) && finite(receipt.appOpen.openedAt)) || receipt.channel === 'tab'", '(object(receipt.appOpen) && finite(receipt.appOpen.openedAt))'],
  ['server-hold-not-terminal', LIB, "typeof receipt.sessionID === 'string' && !terminal.has(raw)", "typeof receipt.sessionID === 'string'"],
  ['unsent-tab-canceled', LIB, ": unsentTab(receipt) ? 'canceled' : raw", ': raw'],
  // S2: open list
  ['open-14-days', LIB, 'nowSeconds - (receipt.createdAt as number) >= WORK_ACTIVITY_LIMITS.trackedDays', 'nowSeconds - (receipt.createdAt as number) > WORK_ACTIVITY_LIMITS.trackedDays'],
  ['open-done-unacknowledged', LIB, "const done = reported === 'done' && !handled", "const done = reported === 'done'"],
  ['open-asks-unacknowledged', LIB, "const asks = (reported === 'needsInput' || reported === 'blocked') && !handled", "const asks = (reported === 'needsInput' || reported === 'blocked')"],
  ['open-rank-order', LIB, 'rank: asks ? 0 : done ? 2 : 1', 'rank: asks ? 0 : done ? 1 : 1'],
  ['open-cap-50', LIB, 'openItems: 50,', 'openItems: 60,'],
  ['open-complete-row', LIB, "if ((row.checked || row.workStage === 'complete') && !['queued', 'running'].includes(activity.status)) continue", ''],
  ['open-newest-receipt', LIB, '(receipt.createdAt as number) > (prior.createdAt as number)', '(receipt.createdAt as number) < (prior.createdAt as number)'],
  // S4: saved destination
  ['snapshot-drops-unreadable-refs', LIB, "|| typeof domain !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(domain)", "|| typeof domain !== 'string'"],
  ['snapshot-text-falls-back-to-title', LIB, "words === '' ? title : words", 'words'],
  ['saved-current-revision-only', LIB, 'd.sourceID === sourceID && d.sourceRevision === revision', 'd.sourceID === sourceID'],
  ['saved-cross-platform-needs-model', LIB, 'return SAFE_ID.test(model) ? { mode, provider, model, sessionId: session } : undefined', 'return { mode, provider, model, sessionId: session }'],
  // Routes S1/S2
  ['requests-capability-honest', BOARD, 'requests: deps.requestsAvailable() ? 1 : 0', 'requests: 1'],
  ['open-takes-no-params', BOARD, "if (Object.keys(req.query).length) return res.status(400)", 'if (false) return res.status(400)'],
  ['saved-destination-top-level', BOARD, '        if (destination) result.savedDestination = destination\n', ''],
  ['board-read-only-with-a-draft', BOARD, 'if (journal.drafts.some(draft => draft.sourceID === `task:${domain}:${workIdentity}`)) {', 'if (true) {'],
  // S3: inbox store
  ['idempotent-replay', STORE, '    if (existing) return { request: existing, created: false }\n', ''],
  ['request-id-conflict', STORE, 'if (existing && existing.fingerprint !== fingerprint) throw', 'if (false) throw'],
  ['revision-checked', STORE, 'if (boardRevision !== input.expectedRevision) throw', 'if (false) throw'],
  ['one-pending-or-claimed-per-item', STORE, "(r.state === 'pending' || r.state === 'claimed')", "r.state === 'pending'"],
  ['daily-cap-constant', STORE, 'dailyCap: 40,', 'dailyCap: 41,'],
  ['pending-ttl-constant', STORE, 'pendingMs: 10 * 60_000,', 'pendingMs: 11 * 60_000,'],
  ['claim-ttl-constant', STORE, 'claimMs: 10 * 60_000,', 'claimMs: 11 * 60_000,'],
  ['note-limit-constant', STORE, 'note: 2_000,', 'note: 2_001,'],
  ['daily-cap-40', STORE, '.length >= HANDOFF_REQUEST_LIMITS.dailyCap', '.length > HANDOFF_REQUEST_LIMITS.dailyCap'],
  ['pending-expires-at-10-min', STORE, "r.state === 'pending' && nowMs >= Date.parse(r.createdAt)", "r.state === 'pending' && nowMs > Date.parse(r.createdAt)"],
  ['expired-never-claimable', STORE, "    if (request.state === 'expired') throw new WorkHandoffRequestError('request_expired', 410, 'This request expired before COS Control claimed it.')\n    if (request.state !== 'pending')", "    if (request.state !== 'pending' && request.state !== 'expired')"],
  ['claim-wins-once', STORE, "if (request.state !== 'pending') throw new WorkHandoffRequestError('already_claimed'", "if (request.state === 'sent') throw new WorkHandoffRequestError('already_claimed'"],
  ['claimed-times-out-to-refused', STORE, "if (r.state === 'claimed' && nowMs >= Date.parse(r.claimedAt!) + HANDOFF_REQUEST_LIMITS.claimMs) {", 'if (false) {'],
  ['result-only-from-claimed', STORE, "if (request.state !== 'claimed') throw new WorkHandoffRequestError('request_not_claimed'", "if (false) throw new WorkHandoffRequestError('request_not_claimed'"],
  ['state-only-after-commit', STORE, "    this.writeFile(this.path, JSON.stringify({ version: 1, requests: kept, quarantined: this.quarantined }) + '\\n')\n    this.rows = kept\n", "    this.rows = kept\n    this.writeFile(this.path, JSON.stringify({ version: 1, requests: kept, quarantined: this.quarantined }) + '\\n')\n"],
  ['note-control-refused', STORE, 'if (NOTE_REFUSED.test(body.note)) throw', 'if (false) throw'],
  ['note-counted-in-characters', STORE, '[...trimmed].length > HANDOFF_REQUEST_LIMITS.note', 'trimmed.length > HANDOFF_REQUEST_LIMITS.note'],
  ['continue-fork-need-session', STORE, "if (!sessionId) throw invalid('Continue and Fork need sessionId", "if (false) throw invalid('Continue and Fork need sessionId"],
  ['uuid-v4-only', STORE, '-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-', '-[0-9a-f]{4}-[0-9a-f]{4}-'],
  ['new-session-default-model', STORE, "mode === 'newSession' ? model ?? defaultModel : model", 'model'],
  ['result-reason-cleaned', STORE, ".replace(/[\\u0000-\\u001f\\u007f-\\u009f]/g, ' ').replace(/\\s+/g, ' ')", ".replace(/\\s+/g, ' ')"],
  // S3: inbox routes
  ['status-view-has-no-note', ROUTE, 'return res.json({ request: handoffStatusView(request) })', 'return res.json({ request: handoffFullView(request) })'],
  ['replay-before-board', ROUTE, '      if (replay) return res.status(200).json({ request: handoffFullView(replay) })\n', ''],
  ['task-not-found-404', ROUTE, "if (!row) throw new WorkHandoffRequestError('task_not_found'", "if (false) throw new WorkHandoffRequestError('task_not_found'"],
  ['created-is-201', ROUTE, 'res.status(created ? 201 : 200)', 'res.status(200)'],
  ['claim-takes-no-body', ROUTE, 'if (!emptyBody(req.body)) throw', 'if (false) throw'],
]
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = () => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data') }, encoding: 'utf8', timeout: 180000,
  })
  const baseline = run()
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  const summary = /Tests\s+(\d+) passed \((\d+)\)/.exec(baseline.stdout)
  if (!summary || summary[1] !== summary[2]) throw new Error('Baseline did not report every test passing:\n' + baseline.stdout)
  console.log(`baseline PASS (${summary[1]} tests in ${tests.length} files)`)
  for (const [name, file, find, replacement] of mutations) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    if (original.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}`)
    writeFileSync(target, original.replace(find, () => replacement))
    const result = run(), output = result.stdout + '\n' + result.stderr
    writeFileSync(target, original)
    const killer = /FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/.exec(output)
    if (result.status === 0 || result.error || !killer) throw new Error(`Mutation survived or harness failed: ${name}\n${output}`)
    console.log(`${name} KILLED by ${killer[1].trim()}`)
  }
  console.log(`${mutations.length} of ${mutations.length} work-progress mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
