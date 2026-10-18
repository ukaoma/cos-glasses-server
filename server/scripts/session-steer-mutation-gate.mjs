#!/usr/bin/env node
// Session steer 6.78.0 (P3) mutation gate: the availability rule (lib/thread-turn-queue.ts),
// the queued-turns `mode: steer` path and its write order (routes/thread-turn-queue.ts), the
// attach refusal's `steer` field (routes/agent-session-bindings.ts), `act.steer`
// (lib/provider-actions.ts) and the composition-root wiring. The rest of P3 is gated by
// turn-queue-durable-mutation-gate.mjs. Mutations run only in a disposable copy of the
// checkout; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/session-steer-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const TQLT = ['server/lib/thread-turn-queue-p3.test.ts']
const TQRT = ['server/routes/thread-turn-queue-p3.test.ts']
const BINDT = ['server/routes/agent-session-bindings-p3.test.ts']
const OFFT = ['server/lib/pi-durable-flags-off.test.ts']
const WIRET = ['server/lib/pi-durable-sessions-wiring.test.ts']
const ALL = [...TQLT, ...TQRT, ...BINDT, ...OFFT, ...WIRET]
const TQL = 'server/lib/thread-turn-queue.ts', TQR = 'server/routes/thread-turn-queue.ts'
const BIND = 'server/routes/agent-session-bindings.ts', ACTS = 'server/lib/provider-actions.ts'
const INDEX = 'server/index.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── The availability rule (one rule for the attach field and the POST) ──
  m('flag-steer-default-off', TQL, ["  return triStateFlag(env, 'COS_SESSION_STEER', false)", "  return triStateFlag(env, 'COS_SESSION_STEER', true)"], [...TQLT, ...TQRT]),
  m('cursor-is-engine-limit', TQL, ["  if (input.provider === 'cursor') return { available: false, reason: 'engine_limit' }\n", ''], [...TQLT, ...TQRT]),
  m('claude-only', TQL, ["  if (input.provider !== 'claude') return { available: false, reason: 'no_outside_channel' }\n", ''], [...TQLT, ...TQRT]),
  m('needs-continue-live', TQL, ["  if (!input.continueLive) return { available: false, reason: 'no_outside_channel' }\n", ''], [...TQLT, ...TQRT]),
  m('needs-desk-run-gate-reason', TQL, ["  if (typeof input.gateReason !== 'string' || !STEERABLE_GATE_REASONS.has(input.gateReason)) return { available: false, reason: 'no_outside_channel' }\n", ''], TQLT),
  m('cos-busy-not-steerable', TQL, ["new Set(['native_thread_working', 'live_desktop_process'])", "new Set(['native_thread_working', 'live_desktop_process', 'native_target_busy'])"], TQLT),
  m('needs-peer-inbox', TQL, ["  if (!input.peerInbox) return { available: false, reason: 'no_outside_channel' }\n", ''], [...TQLT, ...TQRT]),
  m('permission-prompt-falls-back', TQL, ["  if (input.waitingOnPrompt) return { available: false, reason: 'permission_pending' }\n", ''], [...TQLT, ...TQRT]),

  // ── The queued-turns POST, mode steer ──
  m('steer-behind-flag', TQR, ["    const wantSteer = steerOn && body.mode === 'steer'", "    const wantSteer = body.mode === 'steer'"], TQRT),
  m('steer-only-when-available', TQR, ['      if (availability.available) return steerTurn(req, res, deps, turn, queue, gate.reason, fallbackNone)', '      return steerTurn(req, res, deps, turn, queue, gate.reason, fallbackNone)'], TQRT),
  m('fallback-says-why', TQR, ['      ...(steerFallback !== null ? { steerFallback } : {}),\n', ''], TQRT),
  m('fallback-none-refuses-without-row', TQR, ["      if (fallbackNone) return res.status(409).json({ error: 'steer_unavailable', reason: availability.reason })\n", ''], TQRT),
  m('intent-row-written-first', TQR, ['  writeQueue(provider, threadId, admitted.queue, { durable: true })\n\n  /** Rewrite this row', '\n  /** Rewrite this row'], TQRT),
  m('intent-row-is-steer', TQR, ["    mode: 'steer',\n    journal: 1,", '    journal: 1,'], TQRT),
  m('intent-row-is-stamped', TQR, ["    mode: 'steer',\n    journal: 1,", "    mode: 'steer',"], TQRT),
  m('no-frame-without-attempt', TQR, ['  if (!begun) {', '  if (false) {'], TQRT),
  m('attempt-before-frame', TQR, [
    ['  let begun = false\n  try {\n    begun = deps.attempts?.begin(provider, threadId, clientTurnId, \'steer\', deps.now()) === true\n  } catch {\n    begun = false\n  }\n', '  let begun = true\n'],
    ["    live = await deps.deliverLiveTurn!({ provider, sessionId: threadId, prompt, verifyTimeoutMs: PEER_VERIFY_TIMEOUT_MS, clientTurnId })\n", "    live = await deps.deliverLiveTurn!({ provider, sessionId: threadId, prompt, verifyTimeoutMs: PEER_VERIFY_TIMEOUT_MS, clientTurnId })\n    deps.attempts?.begin(provider, threadId, clientTurnId, 'steer', deps.now())\n"],
  ], TQRT),
  m('unverified-is-unknown', TQR, ["  if (live === null || live.reason === 'unverified' || live.reason === 'write_failed') {", '  if (live === null) {'], TQRT),
  m('journal-sent', TQR, ["    journal('sent')\n", ''], TQRT),
  m('journal-unknown', TQR, ["    journal('unknown')\n", ''], TQRT),
  m('journal-not-sent', TQR, ["  journal('not_sent')\n", ''], TQRT),
  m('delivered-row-settles', TQR, ["    settleRow(row => { row.status = 'delivered'; row.reason = 'steered'; row.settledAt = at })", "    settleRow(row => { row.reason = 'steered' })"], TQRT),
  m('unverified-row-unknown', TQR, ["    settleRow(row => { row.status = 'refused'; row.reason = 'steer_unverified'; row.deliveryState = 'unknown'; row.settledAt = at })", "    settleRow(row => { row.status = 'refused'; row.reason = 'steer_unverified'; row.settledAt = at })"], TQRT),
  m('not-sent-back-to-waiting', TQR, ["  return queued202(settleRow(backToWaiting), 'no_outside_channel')", "  return queued202(settleRow(() => {}), 'no_outside_channel')"], TQRT),
  m('fallback-none-settles-refused', TQR, ['  if (fallbackNone) {\n    settleRow(', '  if (false) {\n    settleRow('], TQRT),

  // ── The attach refusal's `steer` field ──
  m('attach-steer-behind-flag', BIND, ["    if (sessionSteerEnabled() && typeof deps.sessionSteer === 'function' && queueableRefusal(reason)) {", "    if (typeof deps.sessionSteer === 'function' && queueableRefusal(reason)) {"], BINDT),
  m('attach-steer-added', BIND, ['      if (steer) extra.steer = steer\n', ''], BINDT),
  m('attach-occupancy-refusal-carries-extras', BIND, ["        return refuseAttach(res, refused, attachRefusalExtras(providerParam, threadIdParam, refused, now))\n      }\n\n      // `runOccupancy`", "        return refuseAttach(res, refused)\n      }\n\n      // `runOccupancy`"], BINDT),

  // ── act.steer ──
  m('act-steer-absent-when-off', ACTS, ['      ...(steer ? { steer: claudeSteer } : {}),', '      steer: claudeSteer,'], [...TQLT, ...OFFT]),
  m('act-codex-no-outside-channel', ACTS, ["      ...(steer ? { steer: no('no_outside_channel') } : {}),", "      ...(steer ? { steer: yes('peer_inbox') } : {}),"], TQLT),
  m('act-cursor-engine-limit', ACTS, ["      ...(steer ? { steer: no('engine_limit') } : {}),", "      ...(steer ? { steer: no('no_outside_channel') } : {}),"], TQLT),
  m('act-claude-peer-inbox', ACTS, ["  const claudeSteer = !attach ? no('attach_disabled') : input.continueLive ? yes('peer_inbox') : no('no_outside_channel')", "  const claudeSteer = no('no_outside_channel')"], TQLT),
  m('act-live-input-reads-flag', ACTS, ['    ...(sessionSteerEnabled() ? { sessionSteer: true } : {}),', '    ...({}),'], TQLT),

  // ── Composition root (source-shape tests: index.ts cannot be executed) ──
  m('index-queue-gets-steer', INDEX, ['    ...steerDeps,\n    attempts: {', '    attempts: {'], WIRET),
  m('index-probe-reads-prompt', INDEX, ['    waitingOnPrompt: sessionHooksEnabled() ? (signalFor(threadId)?.waiting ?? null) !== null : false,', '    waitingOnPrompt: false,'], WIRET),
  m('index-attach-steer-behind-flag', INDEX, ['  sessionSteer: (provider, threadId, gateReason) => (sessionSteerEnabled() ? steerAvailabilityFor(', '  sessionSteer: (provider, threadId, gateReason) => (true ? steerAvailabilityFor('], WIRET),
  m('index-one-live-transport', INDEX, ['  deliverLiveTurn: liveTurnDeliverer,\n  // 6.51.0', '  deliverLiveTurn: makeLiveTurnDeliverer(nativeHeadDeps),\n  // 6.51.0'], WIRET),
  // ── P7 S9: the journal_unavailable fallback the contract now lists ──
  m('steer-journal-unavailable', TQR, ['    return queued202(latest, \'journal_unavailable\')', '    return queued202(latest, \'no_outside_channel\')'], TQRT),
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

const scratch = mkdtempSync(join(tmpdir(), 'session-steer-mutations-'))
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
  console.log(`${killed} of ${selected.length} Session steer 6.78.0 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
