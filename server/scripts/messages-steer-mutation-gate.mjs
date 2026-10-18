#!/usr/bin/env node
// Messages steer 6.78.0 (plan v3.1 P4) mutation gate: the protocol module (lib/claude-steer.ts),
// the Claude bridge's thin wiring, the coordinator's steer order, ports, seeding and
// carry-forward, the store's steer rows and checkpoint, the HTTP surface, the switch, the
// capability and the runtime wiring. Mutations run only in a disposable copy of the checkout;
// the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/messages-steer-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PURE = ['server/lib/claude-steer.test.ts']
const BRIDGE = ['server/lib/claude-bridge-steer.test.ts', 'server/lib/claude-bridge-steer-off-identity.test.ts']
const COORD_T = ['server/lib/query-job-steer-coordinator.test.ts']
const STORE_T = ['server/lib/query-job-steer-store.test.ts']
const ROUTE_T = ['server/routes/query-jobs-steer.test.ts', 'server/routes/query-jobs-off-identity.test.ts']
const FEAT = ['server/lib/query-job-feature.test.ts', 'server/lib/claude-cli-support.test.ts']
const WIRE = ['server/lib/query-job-steer-wiring.test.ts']
const ORIGIN = ['server/lib/query-job-origin.test.ts']
const ALL = [...PURE, ...BRIDGE, ...COORD_T, ...STORE_T, ...ROUTE_T, ...FEAT, ...WIRE, ...ORIGIN]
const STEER = 'server/lib/claude-steer.ts', BR = 'server/lib/claude-bridge.ts', COORD = 'server/lib/query-job-coordinator.ts'
const STORE = 'server/lib/query-job-store.ts', TYPES = 'server/lib/query-job-types.ts', ROUTES = 'server/routes/query-jobs.ts'
const FEATURE = 'server/lib/query-job-feature.ts', CLI = 'server/lib/claude-cli-support.ts', RUNTIME = 'server/lib/query-job-runtime.ts', HEALTH = 'server/routes/health.ts'
const m = (name, file, edits, tests = PURE) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── The protocol (claude-steer.ts) ──
  m('line-default-priority', STEER, ["message: { role: 'user', content } })}\\n`", "message: { role: 'user', content }, priority: 'now' })}\\n`"]),
  m('finish-only-on-full-coverage', STEER, ["    if (this.sent.every(uuid => this.covered.has(uuid))) return { action: 'finish', folded }", "    if (this.covered.has(this.promptUuid)) return { action: 'finish', folded }"], [...PURE, ...BRIDGE]),
  m('missing-uuids-turns-steer-off', STEER, ["    if (!Array.isArray(uuids)) {\n      return { action: 'finish_steering_off', folded: [] }", "    if (!Array.isArray(uuids)) {\n      return { action: 'wait', folded: [], checkpoint: false }"], [...PURE, ...BRIDGE]),
  m('checkpoint-once', STEER, ['    const firstCover = !this.promptCovered && this.covered.has(this.promptUuid)', '    const firstCover = this.covered.has(this.promptUuid)']),
  m('delivery-needs-replay', STEER, ['    if (event.isReplay !== true) return null\n', '']),
  m('delivery-once', STEER, ['|| !this.sent.includes(uuid) || this.delivered.has(uuid)) return null', '|| !this.sent.includes(uuid)) return null']),
  m('port-dedupes-by-id', STEER, ["    if (this.known.has(steer.steerId)) return 'duplicate'\n", '']),
  m('closed-port-refuses', STEER, ["    if (this.closed) return 'closed'\n    this.known.add", '    this.known.add']),
  m('included-when-written', STEER, ['    if (composed.length > 0) this.events.onIncluded?.(composed)\n', ''], [...PURE, ...BRIDGE, ...COORD_T]),
  m('failed-sink-closes-port', STEER, ["      this.closed = true\n      this.sink = null\n      return 'closed'", "      return 'closed'"]),
  m('cutoff-floor-10s', STEER, ['  return Math.max(CUTOFF_FLOOR_MS,', '  return Math.max(0,'], [...PURE, ...COORD_T]),
  m('compose-carries-steers', STEER, ['  if (lines.length === 0) return prompt\n', '  return prompt\n'], [...PURE, ...BRIDGE]),

  // ── The bridge (thin wiring) ──
  m('bridge-steer-flags', BR, ["  if (steerPort) args.push('--input-format', 'stream-json', '--replay-user-messages')", "  if (false) args.push('--input-format', 'stream-json', '--replay-user-messages')"], BRIDGE),
  m('bridge-dispatch-never-steers', BR, ['  const steerPort = options?.dispatch ? undefined : options?.steer', '  const steerPort = options?.steer'], BRIDGE),
  m('bridge-stdin-stays-open', BR, ['      proc.stdin.write(encodeUserLine(steerTracker.promptUuid, cliQuery))\n', '      proc.stdin.write(encodeUserLine(steerTracker.promptUuid, cliQuery))\n      proc.stdin.end()\n'], BRIDGE),
  m('bridge-waits-on-uncovered', BR, ["            if (verdict.action === 'wait') {", '            if (false) {'], BRIDGE),
  m('bridge-second-turn-separator', BR, ["    fullText += '\\n\\n'\n    callbacks.onChunk('\\n\\n')\n", ''], BRIDGE),
  m('bridge-settle-owns-output', BR, ['    if (steerSettling) {\n      armSteerSettle()\n      return\n    }\n', ''], BRIDGE),
  m('bridge-settle-pauses-inactivity', BR, ['    steerSettling = true\n    clearTimeout(inactivityTimer)\n', '    steerSettling = true\n'], BRIDGE),
  m('bridge-settle-ends-stdin', BR, ['      steerSettling = false\n      endSteerStdin()\n      if (!finalized) resetInactivity()', '      steerSettling = false\n      if (!finalized) resetInactivity()'], BRIDGE),
  m('bridge-reaper', BR, ['      if (!childClosed && !terminationRequested) void terminateProviderProcess(proc)', '      if (false) void terminateProviderProcess(proc)'], BRIDGE),
  m('bridge-reaper-skips-exited', BR, ["  proc.on('close', (code) => {\n    childClosed = true\n", "  proc.on('close', (code) => {\n"], BRIDGE),
  m('bridge-wall-uses-checkpoint', BR, ['      if (steerCheckpoint !== null) return finalize(steerCheckpoint)\n', ''], BRIDGE),
  m('bridge-terminal-ends-stdin', BR, ['    steerSettling = false\n    endSteerStdin()\n  }', '    steerSettling = false\n  }'], BRIDGE),
  m('bridge-echo-is-delivery', BR, ['          if (delivered) steerPort!.events.onDelivered?.(delivered)\n', ''], BRIDGE),
  m('bridge-folds-on-result', BR, ['            if (verdict.folded.length > 0) steerPort!.events.onFolded?.(verdict.folded)\n', ''], BRIDGE),
  m('bridge-checkpoints', BR, ['                steerPort!.events.onCheckpoint?.(checkpoint)\n', ''], BRIDGE),
  m('bridge-composes-first-line', BR, ['  const cliQuery = steerPort ? composeFirstContent(promptText, steerPort.drainForCompose()) : promptText', '  const cliQuery = promptText'], BRIDGE),
  m('bridge-sink-checks-stdin', BR, ['        if (finalized || steerStdinEnded || !proc.stdin.writable) return false', '        if (finalized || steerStdinEnded) return false'], BRIDGE),

  // ── The coordinator: order, decisions, ports ──
  m('coord-journal-before-stdin', COORD, ['    let result = await this.store.appendSteer(jobId, { steerId, state: decided, text, create: true })\n',
    '    this.steerPorts.get(jobId)?.offer({ steerId, text })\n    let result = await this.store.appendSteer(jobId, { steerId, state: decided, text, create: true })\n'], COORD_T),
  m('coord-lineage-before-generation', COORD, ['    const known = await this.store.findSteer(clientJobId, steerId)\n    if (known) {',
    '    const known = (await this.store.getSnapshot(jobId, generation)) && await this.store.findSteer(clientJobId, steerId)\n    if (known) {'], COORD_T),
  m('coord-identity-conflict', COORD, ['      if (known.textSha256 !== steerTextSha256(text)) throw new QueryJobSteerConflictError()\n', ''], [...COORD_T, ...ROUTE_T]),
  m('coord-limit-8', COORD, ['>= QUERY_JOB_STEER_LIMITS.steersPerJob) throw new QueryJobSteerLimitError()', '> QUERY_JOB_STEER_LIMITS.steersPerJob) throw new QueryJobSteerLimitError()'], [...COORD_T, ...ROUTE_T]),
  m('coord-ended-is-too-late', COORD, ["    if (isTerminalQueryJobStatus(job.status) || job.status === 'answer_ready') return 'too_late'\n", ''], COORD_T),
  m('coord-closed-port-too-late', COORD, ["      if (port && port.offer({ steerId, text }) === 'closed') {\n        result = await this.store.appendSteer(jobId, { steerId, state: 'too_late' })\n      }",
    '      port?.offer({ steerId, text })'], COORD_T),
  m('coord-wall-cutoff', COORD, ["    if (wallLeft !== null && wallLeft < margin) return 'too_late'", "    if (false) return 'too_late'"], COORD_T),
  m('coord-deadline-cutoff', COORD, ["    if (active.deadlineAt !== undefined && active.deadlineAt - now < margin) return 'too_late'", "    if (false) return 'too_late'"], COORD_T),
  m('coord-port-to-runner', COORD, ['        ...(active.steer ? { steer: active.steer } : {}),\n', ''], COORD_T),
  m('coord-steerable-request-only', COORD, ['    if (!options || !options.enabled() || request.steerable !== true || request.dispatch) return false', '    if (!options || !options.enabled()) return false'], COORD_T),
  m('coord-claude-only', COORD, ["      if (options.provider(request) !== 'claude') return false\n", ''], [...COORD_T, ...ROUTE_T]),
  m('coord-cli-probe', COORD, ['      return await options.cliSupported()', '      return true'], COORD_T),
  m('coord-seeds-held-steers', COORD, ['    for (const steer of own) port.offer(steer)\n', ''], COORD_T),
  m('coord-carries-forward', COORD, ['      for (const steer of await this.store.listCarryableSteers(active.request.clientJobId, active.generation)) port.offer(steer)\n', ''], COORD_T),
  m('coord-journals-folded', COORD, ["        for (const steerId of steerIds) await this.store.appendSteer(jobId, { steerId, state: 'folded' })\n", ''], [...COORD_T, ...ROUTE_T]),
  m('coord-journals-checkpoint', COORD, ['      onCheckpoint: text => journal(() => this.store.appendSteerCheckpoint(jobId, text)),', '      onCheckpoint: () => {},'], COORD_T),
  m('coord-closes-port-at-terminal', COORD, ['    if (!active.steer) return\n    active.steer.close()\n', '    if (!active.steer) return\n'], COORD_T),

  // ── The store: steer rows and the checkpoint ──
  m('store-allowlist-has-steer', STORE, ["  // 6.78.0: steer rows follow the trail's rules (a journal row, never a job event).\n  'steer',\n", ''], STORE_T),
  m('store-steer-takes-no-eventseq', STORE, ['        // The event this row follows. Never `+ 1`: a steer is not a job event.\n        eventSeq: hydrated.snapshot.eventSeq,', '        // The event this row follows. Never `+ 1`: a steer is not a job event.\n        eventSeq: hydrated.snapshot.eventSeq + 1,'], STORE_T),
  m('store-rank-on-hydration', STORE, ['    } else if (steerStateRank(row.state) > steerStateRank(entry.state)) {', '    } else if (true) {'], STORE_T),
  m('store-answering-is-too-late', STORE, ["      if (state === 'accepted' && (isTerminalQueryJobStatus(snapshot.status) || snapshot.status === 'answer_ready')) state = 'too_late'\n", ''], STORE_T),
  m('store-identity-conflict', STORE, ['          if (hydrated.steerHashes?.get(input.steerId) !== steerTextSha256(text)) throw new QueryJobSteerConflictError()\n', ''], STORE_T),
  m('store-index-newest-generation', STORE, ['    if (!indexed || indexed.generation <= record.generation) {', '    if (!indexed) {'], STORE_T),
  m('store-not-applied-frames', STORE, ['    if (publish && isTerminalQueryJobStatus(record.status)) this.publishUnappliedSteers(hydrated, record.persistedAt)\n', ''], STORE_T),
  m('store-carry-only-failed-or-interrupted', STORE, ["      if (snapshot.status !== 'failed' && snapshot.status !== 'interrupted') continue", "      if (snapshot.status === 'canceled') continue"], STORE_T),
  m('store-carry-skips-refused', STORE, ["      if (!steer || steer.state === 'too_late' || steer.state === 'unsupported') continue", '      if (!steer) continue'], STORE_T),
  m('store-fail-completes-checkpoint', STORE, ['    const checkpoint = isTerminalQueryJobStatus(current.status) ? undefined : this.checkpointOf(jobId)\n    if (checkpoint) return this.completeFromCheckpoint(current, checkpoint.text)\n', ''], [...STORE_T, ...COORD_T]),
  m('store-interrupt-completes-checkpoint', STORE, ['    const checkpoint = this.checkpointOf(jobId)\n    if (checkpoint) return this.completeFromCheckpoint(current, checkpoint.text)\n', ''], STORE_T),
  m('store-checkpoint-running-only', STORE, ["      if (snapshot.status !== 'running') return { applied: false, job: clone(snapshot) }", '      if (false) return { applied: false, job: clone(snapshot) }'], STORE_T),
  m('store-boot-counts-only-interrupts', STORE, ["          if (result.applied && result.job.status === 'interrupted') this.health.interruptedOnBoot++", '          if (result.applied) this.health.interruptedOnBoot++'], STORE_T),

  // ── Types: identity, reading, bounds ──
  m('steerable-outside-fingerprint', TYPES, ["  'activityToolMode',\n] as const satisfies readonly (keyof QueryJobRequest)[]", "  'activityToolMode', 'steerable',\n] as const satisfies readonly (keyof QueryJobRequest)[]"], [...STORE_T, ...ORIGIN]),
  m('steerable-true-only', TYPES, ['    ...(input.steerable === true ? { steerable: true as const } : {}),', '    ...(input.steerable ? { steerable: true as const } : {}),'], STORE_T),
  m('read-state-not-applied', TYPES, ["  return isTerminalQueryJobStatus(jobStatus) && (state === 'accepted' || state === 'delivered') ? 'not_applied' : state", '  return state'], [...STORE_T, ...COORD_T, ...ROUTE_T]),
  m('fallback-completed-only', TYPES, ["  if (state === 'not_applied' && jobStatus === 'completed') return 'queue_follow_up'", "  if (state === 'not_applied') return 'queue_follow_up'"], [...STORE_T, ...COORD_T]),
  m('steer-text-bound', TYPES, ["  if (text.length > QUERY_JOB_STEER_LIMITS.steerChars) throw new QueryJobValidationError('steer_text_too_large')\n", ''], COORD_T),
  m('steer-row-state-allowlist', TYPES, ["  if (typeof r.state !== 'string' || !JOURNALED_STEER_STATES.has(r.state)) return null", "  if (typeof r.state !== 'string') return null"], STORE_T),

  // ── HTTP ──
  m('route-post-disabled-404', ROUTES, ["  router.post('/query-jobs/:jobId/steer', async (req, res) => {\n    if (!enabled() || !steerEnabled()) return res.status(404).json(STEER_DISABLED)\n", "  router.post('/query-jobs/:jobId/steer', async (req, res) => {\n"], ROUTE_T),
  m('route-steers-stripped', ROUTES, ['  if (!steer || !steers) return rest as QueryJobSnapshot', '  if (!steers) return rest as QueryJobSnapshot'], ROUTE_T),
  m('route-read-needs-switch', ROUTES, ['  const steerRead = (req: Request) => wantsSteer(req) && steerEnabled()', '  const steerRead = (req: Request) => wantsSteer(req)'], ROUTE_T),
  m('route-sse-opt-in', ROUTES, ['    const steer = steerRead(req)\n', '    const steer = true\n'], ROUTE_T),
  m('route-frame-has-no-id', ROUTES, ['  res.write(`event: steer\\ndata:', '  res.write(`id: 0\\nevent: steer\\ndata:'], ROUTE_T),
  m('route-limit-429', ROUTES, ['  if (error instanceof QueryJobSteerLimitError) return { status: 429,', '  if (error instanceof QueryJobSteerLimitError) return { status: 409,'], ROUTE_T),

  // ── Switch, probe, capability, wiring ──
  m('steer-default-off', FEATURE, ['  return triState(env.COS_MESSAGES_STEER, false)', '  return triState(env.COS_MESSAGES_STEER, true)'], [...FEAT, ...ROUTE_T]),
  m('capability-needs-probe', FEATURE, ['  if (!input.jobsEnabled || input.cliSupported !== true || !messagesSteerEnabled(env)) return undefined', '  if (!input.jobsEnabled || !messagesSteerEnabled(env)) return undefined'], ROUTE_T),
  m('probe-needs-both-options', CLI, ['m.test(help) && /(^|[\\s,])--replay-user-messages', 'm.test(help) || /(^|[\\s,])--replay-user-messages'], FEAT),
  m('runtime-passes-port', RUNTIME, ['      ...(steer ? { steer } : {}),\n', ''], WIRE),
  m('health-advertises-steer', HEALTH, ['        ...steerCapabilityField(durableJobs.enabled),\n', ''], WIRE),
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

const scratch = mkdtempSync(join(tmpdir(), 'messages-steer-mutations-'))
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
  console.log(`${killed} of ${selected.length} Messages steer 6.78.0 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
