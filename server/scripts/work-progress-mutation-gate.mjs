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
const READER = 'server/lib/work-board-reader.ts', ACTIVITY_UUID = LIB
// [name, file, exact target, replacement, a substring of the test that must fail]
const mutations = [
  // S1: progress projection
  ['malformed-progress-unreadable', LIB, ' || !absentOr(receivedAt, finite)', '', 'reads unreadable on its own'],
  ['malformed-event-unreadable', LIB, "\n      || !absentOr(event.undoneAt, finite)) return unreadable", ') return unreadable', 'reads unreadable on its own'],
  ['unreadable-not-silence', LIB, "  const unreadable = { projection: { unreadable: true as const } }\n  if (!object(raw)) return unreadable", "  const unreadable = undefined\n  if (!object(raw)) return unreadable", 'reads unreadable on its own'],
  ['evidence-cap-280', LIB, 'evidence: 280,', 'evidence: 300,', 'evidence is cleaned as a session name is'],
  ['evidence-cap-1200-units', LIB, 'evidenceUnits: 1_200,', 'evidenceUnits: 12_000,', 'evidence is cleaned as a session name is'],
  ['evidence-session-name-rules', LIB, 'const flat = flattenDisplayText(value)', "const flat = value.replace(CONTROL, ' ').trim()", 'evidence is cleaned as a session name is'],
  ['evidence-only-with-report', LIB, '  if (state) {\n', '  if (true) {\n', 'go with a report only'],
  ['unknown-kind-no-report', LIB, "reported === 'done' || reported === 'needsInput' || reported === 'blocked' ? reported : null", "typeof reported === 'string' ? reported : null", 'go with a report only'],
  ['last-move-undone', LIB, 'undone: finite(move.undoneAt)', 'undone: false', 'never its text'],
  ['last-move-newest', LIB, '[...list].reverse().find(', '[...list].find(', 'lastMove is the newest move'],
  ['last-move-known-stages', LIB, "WORK_ACTIVITY_STAGES.includes(move.toStage as string)", 'true', 'lastMove is the newest move'],
  ['updated-at-newest-event', LIB, 'isoFromSeconds(Math.max(receipt.createdAt as number, progress.newestAt))', 'isoFromSeconds(receipt.createdAt as number)', 'never its text'],
  ['acknowledged-reviewed', LIB, "finite(receipt.acknowledgedAt) || raw === 'reviewed'", 'finite(receipt.acknowledgedAt)', 'acknowledged and requestedFrom mirror Control'],
  ['request-id-projected', LIB, "if (typeof receipt.requestId === 'string' && UUID_V4.test(receipt.requestId)) activity.requestId = receipt.requestId", "if (typeof receipt.requestId === 'string') activity.requestId = receipt.requestId", 'acknowledged and requestedFrom mirror Control'],
  ['app-owner-per-session', LIB, 'activity.appOpened = onSession.some(ownsInApp)', "activity.appOpened = ownsInApp(receipt) && !!session", 'belong to the SESSION'],
  ['app-owner-channel-app', LIB, " || r.channel === 'tab' || r.channel === 'app'", " || r.channel === 'tab'", 'belong to the SESSION'],
  ['same-session-prefix-8', LIB, 'return short.length >= 8 && long.startsWith(short)', 'return short.length >= 7 && long.startsWith(short)', 'belong to the SESSION'],
  ['server-hold-not-terminal', LIB, "typeof r.sessionID === 'string' && !terminal.has(r.status as string)", "typeof r.sessionID === 'string'", 'belong to the SESSION'],
  ['waiting-in-app-queued', LIB, "activity.waitingInApp = onSession.some(r => r.channel === 'app' && loadedStatus(r) === 'queued')", "activity.waitingInApp = onSession.some(r => r.channel === 'app')", 'belong to the SESSION'],
  ['unsent-tab-canceled', LIB, "\n  : unsentTab(receipt) ? 'canceled' : receipt.status as string", "\n  : receipt.status as string", 'belong to the SESSION'],
  ['session-id-native-rule', LIB, 'isValidNativeThreadId(native) ? { provider, native } : null', 'native.length >= 8 ? { provider, native } : null', 'parseWorkSessionId follow Control'],
  // S2: open list
  ['open-14-days', LIB, 'nowSeconds - (receipt.createdAt as number) >= WORK_ACTIVITY_LIMITS.trackedDays', 'nowSeconds - (receipt.createdAt as number) > WORK_ACTIVITY_LIMITS.trackedDays', 'groups needs input, attention'],
  ['open-done-unacknowledged', LIB, ": reported === 'done' && !handled ? 'done'", ": reported === 'done' ? 'done'", 'groups needs input, attention'],
  ['open-asks-unacknowledged', LIB, "(reported === 'needsInput' || reported === 'blocked') && !handled ? 'needsInput'", "(reported === 'needsInput' || reported === 'blocked') ? 'needsInput'", 'groups needs input, attention'],
  ['open-attention-group', LIB, "(['failed', 'refused', 'unknown'].includes(status) || (status === 'completed' && reported === null)) ? 'attention'", "(['unknown'].includes(status)) ? 'attention'", 'groups needs input, attention'],
  ['open-failed-reports-ignored', LIB, "const reported = ['failed', 'refused', 'canceled'].includes(status) ? null : reportOf(activity.progress)", 'const reported = reportOf(activity.progress)', 'groups needs input, attention'],
  ['open-group-order', LIB, 'needsInput: 0, attention: 1, running: 2, done: 3', 'needsInput: 0, attention: 2, running: 1, done: 3', 'groups needs input, attention'],
  ['open-cap-50', LIB, 'openItems: 50,', 'openItems: 60,', 'before cutting to 50'],
  ['open-order-by-progress', LIB, 'a.rank - b.rank || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt', 'a.rank - b.rank || b.createdAt - a.createdAt', 'before cutting to 50'],
  ['open-total', LIB, 'return { items, total: ranked.length, truncated: ranked.length > items.length }', 'return { items, total: items.length, truncated: false }', 'before cutting to 50'],
  ['open-checked-row', LIB, "if (row.checked === true && !['queued', 'running'].includes(status)) continue", "if ((row.checked === true || row.workStage === 'complete') && !['queued', 'running'].includes(status)) continue", 'groups needs input, attention'],
  ['open-newest-receipt', LIB, '(receipt.createdAt as number) > (prior.createdAt as number)', '(receipt.createdAt as number) < (prior.createdAt as number)', 'reads only the newest receipt'],
  // Task revision and saved destination
  ['snapshot-drops-unreadable-refs', LIB, "|| typeof domain !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(domain)", "|| typeof domain !== 'string'", 'Swift'],
  ['snapshot-text-falls-back-to-title', LIB, "words === '' ? title : words", 'words', 'Swift'],
  ['saved-current-revision-only', LIB, 'd.sourceID === sourceID && d.sourceRevision === revision', 'd.sourceID === sourceID', "sendPlan would send exactly that"],
  ['saved-prompt-required', LIB, 'if (!prompt.trim() || prompt.length > DRAFT_LIMIT) return undefined', 'if (prompt.length > DRAFT_LIMIT) return undefined', "sendPlan would send exactly that"],
  ['saved-native-fork-providers', LIB, "  return FORK_PROVIDERS.has(session.provider) ? { mode, provider: session.provider, sessionId } : undefined", "  return { mode, provider: session.provider, sessionId }", "sendPlan would send exactly that"],
  ['saved-cross-platform-target-model', LIB, '!slot || modelProvider(slot) !== provider) return undefined\n    return { mode, provider, model: slot, sessionId }', '!slot) return undefined\n    return { mode, provider, model: slot, sessionId }', "sendPlan would send exactly that"],
  ['saved-leftover-provider-native', LIB, 'if (CROSS_PLATFORM_TARGETS.has(provider) && provider !== session.provider) {', "if (provider !== '' && provider !== session.provider) {", "sendPlan would send exactly that"],
  // Routes S1/S2
  ['capabilities-from-inbox', BOARD, 'const activityCapabilities = (): WorkActivityCapabilities => ({ progress: 1, ...deps.requests() })', "const activityCapabilities = (): WorkActivityCapabilities => ({ progress: 1, requests: 1, requestsInbox: 1, requestsConsumerSeenAt: null })", 'S1 answers capabilities as the inbox says'],
  ['open-takes-no-params', BOARD, "if (Object.keys(req.query).length) return res.status(400)", 'if (false) return res.status(400)', 'S2 lists open work'],
  ['saved-destination-top-level', BOARD, '    if (destination) result.savedDestination = destination\n', '', 'S1 carries the saved destination'],
  ['s1-board-budget-3s', BOARD, "await glanceBoard('activity', WORK_BOARD_READ_LIMITS.savedDestinationMs)", "await glanceBoard('activity', 6_000)", 'S1 carries the saved destination'],
  ['board-rows-task-revision', BOARD, ', taskRevision: controlSnapshotRevision(row) }))', ' }))', 'GET /work-board carries'],
  ['reader-shares-one-read', READER, 'if (!inflight || started - inflight.at > maxAgeMs) {', 'if (true) {', 'shared board reader'],
  ['reader-bound', READER, 'const bound = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WorkBoardTimeoutError()), timeoutMs) })', 'const bound = new Promise<never>(() => {})', 'shared board reader'],
  // Inbox store
  ['idempotent-replay', STORE, '    if (existing) return { request: existing, created: false }\n', '', 'is idempotent by clientRequestId'],
  ['request-id-conflict', STORE, 'if (existing && existing.fingerprint !== fingerprint) throw', 'if (false) throw', 'is idempotent by clientRequestId'],
  ['task-revision-checked', STORE, 'if (taskRevision !== input.expectedTaskRevision) throw', 'if (false) throw', 'refuses a request made against an older revision'],
  ['one-pending-or-claimed-per-item', STORE, "(r.state === 'pending' || r.state === 'claimed')", "r.state === 'pending'", 'allows one pending or claimed request'],
  ['daily-cap-constant', STORE, 'dailyCap: 40,', 'dailyCap: 41,', 'caps requests at 40 a local day'],
  ['daily-cap-local-day', STORE, 'const localDay = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }', 'const localDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)', 'caps requests at 40 a local day'],
  ['daily-cap-resets-at', STORE, 'It resets at midnight on the Mac (${resetsAt}).`, { resetsAt })', 'It resets at midnight on the Mac.`)', 'caps requests at 40 a local day'],
  ['pending-ttl-constant', STORE, 'pendingMs: 10 * 60_000,', 'pendingMs: 11 * 60_000,', 'claimed until 10 minutes'],
  ['claim-ttl-constant', STORE, 'claimMs: 10 * 60_000,', 'claimMs: 11 * 60_000,', 'unconfirmed, and takes exactly one late result'],
  ['pending-expires-at-10-min', STORE, "else if (state === 'pending' && nowMs >= created + HANDOFF_REQUEST_LIMITS.pendingMs) state = 'expired'", "else if (state === 'pending' && nowMs > created + HANDOFF_REQUEST_LIMITS.pendingMs) state = 'expired'", 'claimed until 10 minutes'],
  ['future-skew-expired', STORE, "(claimed !== undefined && claimed > nowMs + HANDOFF_REQUEST_LIMITS.skewMs))) state = 'expired'", "false)) state = 'expired'", 'ahead of the clock counts as expired'],
  ['expired-never-claimable', STORE, "    if (request.state === 'expired') throw new WorkHandoffRequestError('request_expired', 410, 'This request expired before COS Control claimed it.')\n    if (request.state === 'claimed' && claimToken", "    if (request.state === 'claimed' && claimToken", 'claimed until 10 minutes'],
  ['claim-wins-once', STORE, "if (request.state !== 'pending') throw new WorkHandoffRequestError('already_claimed'", "if (request.state === 'sent') throw new WorkHandoffRequestError('already_claimed'", 'exactly one claim wins'],
  ['claim-token-reclaims', STORE, "if (request.state === 'claimed' && claimToken !== undefined && claimToken === request.claimToken) return request", "if (request.state === 'claimed' && claimToken !== undefined) return request", 'exactly one claim wins'],
  ['claimed-times-out-unconfirmed', STORE, "else if (state === 'claimed' && nowMs >= claimed! + HANDOFF_REQUEST_LIMITS.claimMs) state = 'unconfirmed'", "else if (state === 'claimed' && nowMs >= claimed! + HANDOFF_REQUEST_LIMITS.claimMs) state = 'refused'", 'unconfirmed, and takes exactly one late result'],
  ['unconfirmed-takes-late-result', STORE, "if (request.state !== 'claimed' && request.state !== 'unconfirmed') {", "if (request.state !== 'claimed') {", 'unconfirmed, and takes exactly one late result'],
  ['result-needs-claim-token', STORE, 'if (request.claimToken !== result.claimToken) throw', 'if (false) throw', 'under its token'],
  ['result-only-from-claimed', STORE, "if (!request.claimToken) throw new WorkHandoffRequestError('request_not_claimed'", "if (false) throw new WorkHandoffRequestError('request_not_claimed'", 'under its token'],
  ['state-only-after-commit', STORE, "    this.writeFile(this.path, JSON.stringify({ version: 1, requests: kept, quarantined }) + '\\n')\n    this.rows = kept\n", "    this.rows = kept\n    this.writeFile(this.path, JSON.stringify({ version: 1, requests: kept, quarantined }) + '\\n')\n", 'a crash in the middle of a write'],
  ['retention-7-days', STORE, 'retainDays: 7,', 'retainDays: 9,', 'keeps a request 7 days'],
  ['quarantine-ages-out', STORE, 'const quarantined = this.quarantined.filter(q => Date.parse(q.at) >= cutoff)', 'const quarantined = this.quarantined', 'quarantines bad records'],
  ['stored-new-session-needs-model', STORE, "  if (raw.mode === 'newSession' && !given(raw.model)) throw new Error('record')\n", '', 'quarantines bad records'],
  ['transition-logged-once', STORE, "if (state !== r.state && !this.noticed.has(r.clientRequestId + state)) {", 'if (state !== r.state) {', 'logs a time-made transition once'],
  ['consumer-window-120s', STORE, 'nowMs - seen <= HANDOFF_REQUEST_LIMITS.consumerMs ? 1 : 0', 'nowMs - seen <= HANDOFF_REQUEST_LIMITS.consumerMs + 1 ? 1 : 0', 'only while COS Control lists pending ones'],
  // Inbox validation
  ['intent-needs-reply-target', STORE, "if ((intent === 'reply' || intent === 'notDone') !== !!replyTo) throw", 'if (false) throw', 'refuses a reply without replyTo'],
  ['note-control-refused', STORE, 'if (NOTE_REFUSED.test(body.note)) throw', 'if (false) throw', 'refuses a note with a bell'],
  ['note-format-characters', STORE, '|(?![\\u200c\\u200d])\\p{Cf}|', '|', 'refuses a note with a direction override'],
  ['note-line-separators', STORE, '\\u007f-\\u009f\\u2028\\u2029]|', '\\u007f-\\u009f]|', 'refuses a note with a line separator'],
  ['note-no-status-line', STORE, 'if (STATUS_LINE.test(body.note)) throw', 'if (false) throw', 'refuses a note with a COS-WORK line'],
  ['note-counted-in-characters', STORE, '[...trimmed].length > HANDOFF_REQUEST_LIMITS.note', 'trimmed.length > HANDOFF_REQUEST_LIMITS.note', 'counts a note in characters'],
  ['note-limit-constant', STORE, 'note: 2_000,', 'note: 2_001,', 'refuses a note of 2,001 characters'],
  ['body-size-checked', STORE, "if (Buffer.byteLength(JSON.stringify(body)) > HANDOFF_REQUEST_LIMITS.body) throw", 'if (false) throw', 'checks the body size before its fields'],
  ['fork-from-claude-codex', STORE, "if (!FORK_PROVIDERS.has(provider)) throw invalid('Fork works", "if (false) throw invalid('Fork works", 'refuses a Fork of a Cursor session'],
  ['fork-model-other-platform', STORE, ' || modelProvider(model as never) === provider)) {', ')) {', 'refuses a Fork model of its own platform'],
  ['continue-fork-need-session', STORE, "if (!sessionId || !provider) throw invalid('Continue and Fork need sessionId", "if (false) throw invalid('Continue and Fork need sessionId", 'refuses Continue without a session'],
  ['uuid-v4-only', ACTIVITY_UUID, '-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-', '-[0-9a-f]{4}-[0-9a-f]{4}-', 'refuses a v1 uuid'],
  ['new-session-default-model', STORE, "mode === 'newSession' ? model ?? defaultModel : model", 'model', 'takes the given model slot, or the server default'],
  ['result-reason-cleaned', STORE, ".replace(/[\\u0000-\\u001f\\u007f-\\u009f]/g, ' ').replace(/\\s+/g, ' ')", ".replace(/\\s+/g, ' ')", "parses Control's result strictly"],
  ['result-sent-needs-receipt', STORE, "if ((result.state === 'sent' || result.state === 'unresolved') && !result.receiptId) throw", 'if (false) throw', "parses Control's result strictly"],
  ['result-reason-graphemes', STORE, 'Array.from(graphemes.segment(flat), part => part.segment).slice(0, HANDOFF_REQUEST_LIMITS.reason)', '[...flat].slice(0, HANDOFF_REQUEST_LIMITS.reason)', "parses Control's result strictly"],
  // Inbox routes
  ['control-routes-local-only', ROUTE, "    if (!deps.isLocal(req)) throw new WorkHandoffRequestError('local_only', 403", "    if (false) throw new WorkHandoffRequestError('local_only', 403", 'only on this Mac'],
  ['loopback-rule', ROUTE, "return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address.startsWith('::ffff:127.')", "return address !== ''", 'only on this Mac'],
  ['pending-list-is-the-consumer', ROUTE, "if (state === 'pending') deps.store!.noteConsumer()", 'deps.store!.noteConsumer()', 'which turns requests on'],
  ['list-reports-quarantine', ROUTE, ',\n        quarantined: deps.store!.quarantineCount() })', ' })', 'which turns requests on'],
  ['status-view-has-no-note', ROUTE, 'return res.json({ request: handoffStatusView(request) })', 'return res.json({ request: handoffFullView(request) })', 'the glasses status view has state and times only'],
  ['replay-before-board', ROUTE, '      if (replay) return res.status(200).json({ request: handoffFullView(replay) })\n', '', 'answers a retry 200 from the store without the board'],
  ['task-not-found-404', ROUTE, "if (!row) throw new WorkHandoffRequestError('task_not_found'", "if (false) throw new WorkHandoffRequestError('task_not_found'", 'checks the task itself'],
  ['task-complete-409', ROUTE, "if (row.checked) throw new WorkHandoffRequestError('task_complete'", "if (false) throw new WorkHandoffRequestError('task_complete'", 'checks the task itself'],
  ['task-revision-not-file-revision', ROUTE, 'deps.store!.create(input, fingerprint, controlSnapshotRevision(row))', 'deps.store!.create(input, fingerprint, row.workRevision)', 'checks the task itself'],
  ['board-cause-in-503', ROUTE, "'Work board is unavailable. Nothing was sent; try again shortly.', { cause })", "'Work board is unavailable. Nothing was sent; try again shortly.')", 'work_board_unavailable with its cause'],
  ['reply-must-be-newest', ROUTE, "    if (newest !== target) throw new WorkHandoffRequestError('reply_target_invalid'", "    if (false) throw new WorkHandoffRequestError('reply_target_invalid'", "a reply names the item's newest receipt"],
  ['reply-same-session', ROUTE, 'if (!session || !sameSession(session, input.sessionId!)) throw', 'if (!session) throw', "a reply names the item's newest receipt"],
  ['created-is-201', ROUTE, 'res.status(created ? 201 : 200)', 'res.status(200)', 'creates 201'],
  ['claim-returns-token', ROUTE, 'return res.json({ request: handoffFullView(request), claimToken: request.claimToken })', 'return res.json({ request: handoffFullView(request) })', 'claim race'],
  ['claim-body-checked', ROUTE, "throw new WorkHandoffRequestError('invalid_handoff_request', 400, 'A claim takes no body", "if (false) throw new WorkHandoffRequestError('invalid_handoff_request', 400, 'A claim takes no body", 'claim race'],
  ['claim-result-refusals-logged', ROUTE, "if (e.status >= 500 || where === 'claim' || where === 'result') console.warn", 'if (e.status >= 500) console.warn', 'takes one late result'],
  ['daily-cap-retry-after', ROUTE, "if (e.extra.resetsAt) res.set('Retry-After'", "if (false) res.set('Retry-After'", 'says when the daily cap resets'],
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
  for (const [name, file, find, replacement, killerName] of mutations) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    if (original.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}`)
    writeFileSync(target, original.replace(find, () => replacement))
    const result = run(), output = result.stdout + '\n' + result.stderr
    writeFileSync(target, original)
    // The intended test must be among the named failures: a kill by some unrelated test proves nothing about the rule.
    const killers = [...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(match => match[1].trim())
    if (result.status === 0 || result.error || !killers.length) throw new Error(`Mutation survived or harness failed: ${name}\n${output}`)
    const killer = killers.find(line => line.includes(killerName))
    if (!killer) throw new Error(`Mutation ${name} was killed, but not by the test named for it ("${killerName}"): ${killers.join(' | ')}`)
    console.log(`${name} KILLED by ${killer}`)
  }
  console.log(`${mutations.length} of ${mutations.length} work-progress mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
