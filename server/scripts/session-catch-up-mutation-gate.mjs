#!/usr/bin/env node
// X1 (session catch-up, the build after 7.0.42; Work card task:personal:ce1f04b2f016). GET .../catch-up is read only in
// fact, has the detail route's redaction for every caller, and answers each stale state. Same harness as
// turn-ask-events-mutation-gate.mjs: disposable copy, green baseline, each target matched exactly once, each mutant
// killed by the test named for it (WRONG KILLER fails), byte-for-byte restoration. `--check` stops after the check.
// Equivalent, so not mutated: TargetGuard.peekFencedReason calling fencedReason internally (the zero-calls proxy sees
// only calls from outside; cu-fence-twin pins the call site), and readSessionCatchUpView's `observe: false` on the
// claude path (derive-observe-notifies and derive-observe-ages pin what it does).
import { mkdtempSync, cpSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// [name, file, exact target, replacement, a substring of the test that must fail, tests]
const mutations = [
  ["cu-attachblocked-twin", "server/routes/agent-session-bindings.ts", "deps.bindings.wouldBlockAttach ? deps.bindings.wouldBlockAttach(provider, threadId, now) === true : holder !== null", "(deps.bindings as any).attachBlocked ? (deps.bindings as any).attachBlocked(provider, threadId, now) === true : holder !== null", "ZERO CALLS", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-fence-twin", "server/routes/agent-session-bindings.ts", "const fenced = guard.peekFencedReason(key)", "const fenced = guard.fencedReason(key)", "ZERO CALLS", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-open-ask-twin", "server/routes/agent-session-bindings.ts", "try { open = cu.peekAsk(threadId) } catch { open = null }", "try { open = (deps.openTurnEndAsk ?? cu.peekAsk)!(threadId) } catch { open = null }", "ZERO CALLS", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-renews", "server/routes/agent-session-bindings.ts", "if (check && check.ok === true) return { state: 'active'", "if (check && check.ok === true && (deps.bindings as any).renew?.(bindingId, 1_800_000, now) !== 0) return { state: 'active'", "ZERO CALLS", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-delivers", "server/routes/agent-session-bindings.ts", "    catchUpLimiter.record(client, requestKey, now, body)\n", "    void deps.deliverAttachedTurn?.({} as never)\n    catchUpLimiter.record(client, requestKey, now, body)\n", "ZERO CALLS", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-mark-drop", "server/routes/agent-session-bindings.ts", "      const mark = answeredAsks.get(`claude:${threadId.toLowerCase()}:${askSeen}`)\n", "      const mark = answeredAsks.get(`claude:${threadId.toLowerCase()}:${askSeen}`)\n      answeredAsks.delete(`claude:${threadId.toLowerCase()}:${askSeen}`)\n", "never drops it", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-mark-set", "server/routes/agent-session-bindings.ts", "      const mark = answeredAsks.get(`claude:${threadId.toLowerCase()}:${askSeen}`)\n", "      if (askSeen === openId) answeredAsks.set(`claude:${threadId.toLowerCase()}:${askSeen}`, { at: now, by: 'web', state: 'delivered' })\n      const mark = answeredAsks.get(`claude:${threadId.toLowerCase()}:${askSeen}`)\n", "catch-up never sets one", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-reattach-mid-turn", "server/routes/agent-session-bindings.ts", "    if (working) return { ...out, reattach: 'not_now', reason: 'native_thread_working' }\n", "", "no binding remembered", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-already-dropped", "server/routes/agent-session-bindings.ts", "      if (check && check.ok === true) return { state: 'active', holder: 'this', otherWorking: false, reattach: 'already', reason: null }\n", "", "binding active and this page", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-blocked-safe", "server/routes/agent-session-bindings.ts", "    if (blocked) return { ...out, reattach: 'not_now', reason: out.otherWorking ? 'native_turn_in_progress' : 'native_target_busy' }\n", "", "row 1, detached", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-cursor-ignored", "server/routes/agent-session-bindings.ts", "const since = turnsSince(view.turns, after)", "const since = turnsSince(view.turns, null)", "row 4, the cursor", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-changed-inverted", "server/routes/agent-session-bindings.ts", "? revision !== revisionSeen : null", "? revision === revisionSeen : null", "row 3, the thread moved", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-restart-never", "server/routes/agent-session-bindings.ts", "const restartedSince = bootSeen !== null && bootSeen !== cu.bootId", "const restartedSince = false", "row 8, a restart", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-replay-off", "server/routes/agent-session-bindings.ts", "    if (limited?.kind === 'replay') { res.json({ ...limited.body, cached: true }); return }\n", "", "replayed (cached true", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-cap-off", "server/routes/agent-session-bindings.ts", "while (turns.length > 0 && Buffer.byteLength(JSON.stringify(body)) > CATCH_UP_MAX_BYTES) {", "while (false) {", "the 256 KB cap", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-bad-cursor-accepted", "server/routes/agent-session-bindings.ts", "      || (after !== null && !isCursor(after))\n", "", "refusals: bad_provider 400", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-question-closed-lost", "server/routes/agent-session-bindings.ts", "      else if (askSeen !== openId) questionClosed = true\n", "", "row 5, the open question", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-queue-position", "server/routes/agent-session-bindings.ts", "position: row.status === 'waiting' ? ++position : null", "position: ++position", "row 6, queued turns", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-mounted-always", "server/routes/agent-session-bindings.ts", "  if (deps.catchUp) router.get('/agent-sessions/:provider/:threadId/catch-up'", "  if (true as boolean) router.get('/agent-sessions/:provider/:threadId/catch-up'", "without catch-up readers the route does not exist", ["server/routes/agent-session-bindings.test.ts"]],
  ["peekask-ages", "server/lib/turn-end-ask.ts", "    if (now - state.stoppedAt > TURN_ASK_MAX_AGE_MS) return null\n    return { ask: state.capture.ask", "    if (now - state.stoppedAt > TURN_ASK_MAX_AGE_MS) { this.asks.delete(state.sessionId); this.counters.agedOut++; return null }\n    return { ask: state.capture.ask", "peekAsk reads the open ask", ["server/lib/turn-end-ask.test.ts"]],
  ["derive-observe-notifies", "server/lib/session-hooks-runtime.ts", "  if (input.observe === false) return derived\n", "", "observe false derives the same state", ["server/lib/session-hooks-runtime.test.ts"]],
  ["derive-observe-ages", "server/lib/session-hooks-runtime.ts", "input.observe === false ? turnEndAskTracker.peekAsk(key, now) : turnEndAskTracker.visibleAsk(key, now)", "turnEndAskTracker.visibleAsk(key, now)", "observe-false derive", ["server/lib/turn-end-ask.test.ts"]],
  ["registry-would-reaps", "server/lib/agent-session-binding-registry.ts", "    if (!isBindableProvider(provider) || !isValidNativeThreadId(nativeThreadId)) return false\n    const id = this.targets.get(makeTargetKey(provider, nativeThreadId))", "    if (!isBindableProvider(provider) || !isValidNativeThreadId(nativeThreadId)) return false\n    if (this.pinBootReap()) this.reapOrphanedPins(now, makeTargetKey(provider, nativeThreadId))\n    const id = this.targets.get(makeTargetKey(provider, nativeThreadId))", "wouldBlockAttach answers as attachBlocked does", ["server/lib/agent-session-binding-registry.test.ts"]],
  ["broker-peek-settles", "server/lib/permission-broker.ts", "      if (item.state !== 'pending' || now >= item.deadlineAt || !item.lensVisible) continue\n", "      if (item.state !== 'pending') continue\n      if (now >= item.deadlineAt) { this.settle(item, 'expired'); continue }\n      if (!item.lensVisible) continue\n", "peekPendingFor lists one session", ["server/lib/permission-broker.test.ts"]],
  ["broker-peek-any-session", "server/lib/permission-broker.ts", "      if (item.sessionId !== key) continue\n", "", "peekPendingFor lists one session", ["server/lib/permission-broker.test.ts"]],
  ["view-no-redaction", "server/routes/agent-sessions.ts", "  const redacted = redactLocalPathsDeep(raw) as SessionTurn[]", "  const redacted = raw", "the native Mac helper", ["server/routes/session-catch-up-redaction.test.ts"]],
  ["view-markers-always", "server/routes/agent-sessions.ts", "  const turns = opts.cards ? redacted : redacted.map(", "  const turns = true ? redacted : redacted.map(", "link markers only with cards=1", ["server/routes/session-catch-up-redaction.test.ts"]],
  ["health-flag-always", "server/routes/health.ts", "sessionCatchUp: sessionCatchUpMounted(),", "sessionCatchUp: true,", "false until index.ts mounts the route", ["server/routes/session-catch-up-wiring.test.ts"]],
  ["wiring-open-ask-twin", "server/index.ts", "peekAsk: sessionId => peekTurnEndAsk(sessionId),", "peekAsk: sessionId => openTurnEndAsk(sessionId),", "each reader is the peek", ["server/routes/session-catch-up-wiring.test.ts"]],
  ["wiring-broker-list", "server/index.ts", "pendingPrompts: sessionId => permissionBroker.peekPendingFor(sessionId),", "pendingPrompts: sessionId => permissionBroker.list().filter(q => q.sessionId === sessionId),", "each reader is the peek", ["server/routes/session-catch-up-wiring.test.ts"]],
  ["summary-three-max", "server/lib/session-catch-up.ts", "SUMMARY_PRIORITY.filter(c => extra.has(c)).slice(0, 2)", "SUMMARY_PRIORITY.filter(c => extra.has(c))", "one transcript clause first", ["server/lib/session-catch-up.test.ts"]],
  ["cursor-oldest-match", "server/lib/session-catch-up.ts", "  for (let i = window.length - 1; i >= 0; i--) {\n    if (turnCursor(window[i]!) === after)", "  for (let i = 0; i < window.length; i++) {\n    if (turnCursor(window[i]!) === after)", "turnsSince: the turns after the cursor", ["server/lib/session-catch-up.test.ts"]],
  ["view-previews-ignored", "server/routes/agent-sessions.ts", "  if (recent && !sessionFilesSetting.read().enabled) recent = { ...recent, turns: withoutPreviews(recent.turns) }\n", "", "previews off (COS_WEB_SESSION_FILES=0)", ["server/routes/session-catch-up-redaction.test.ts"]],
  ["view-claude-observes", "server/routes/agent-sessions.ts", "      remember: false,\n      observe: false,\n    })\n  } else if (provider === 'cursor'", "      remember: false,\n    })\n  } else if (provider === 'cursor'", "derive never ages out", ["server/routes/session-catch-up-redaction.test.ts"]],
  ["cu-replay-key-no-binding", "server/routes/agent-session-bindings.ts", "const requestKey = [provider, threadId, after, bindingId, epochRaw,", "const requestKey = [provider, threadId, after, epochRaw,", "the replay key is every request field", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-closed-when-open", "server/routes/agent-session-bindings.ts", "      else if (askSeen !== openId) questionClosed = true\n", "      else questionClosed = true\n", "row 5, the open question", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-client-kind-ignored", "server/routes/agent-session-bindings.ts", "const client = `${req.socket?.remoteAddress ?? ''}|${req.headers['x-cos-token'] ? 'token' : 'cookie'}`", "const client = `${req.socket?.remoteAddress ?? ''}`", "the replay key is every request field", ["server/routes/agent-session-bindings.test.ts"]],
  ["cu-boot-length-unchecked", "server/routes/agent-session-bindings.ts", "      || (bootSeen !== null && bootSeen.length > 128)) {", "      ) {", "x-cos-boot: up to 128", ["server/routes/agent-session-bindings.test.ts"]],
  ["broker-peek-lens-ignored", "server/lib/permission-broker.ts", "      if (item.state !== 'pending' || now >= item.deadlineAt || !item.lensVisible) continue\n", "      if (item.state !== 'pending' || now >= item.deadlineAt) continue\n", "peekPendingFor lists one session", ["server/lib/permission-broker.test.ts"]]
]
const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const chosen = names.length ? mutations.filter(([name]) => names.includes(name)) : mutations
if (names.length && chosen.length !== names.length) throw new Error(`Unknown mutation name in: ${args.join(' ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'session-catch-up-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'bin'), join(scratch, 'bin'), { recursive: true })
  // vitest.config.ts names setup files here (the 6.71.7 gate predates them).
  if (existsSync(join(root, 'test-support'))) cpSync(join(root, 'test-support'), join(scratch, 'test-support'), { recursive: true })
  cpSync(join(root, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
  cpSync(join(root, 'managed-runtime-contract.json'), join(scratch, 'managed-runtime-contract.json'))
  // The listing test reads .env.example (the S6 lesson).
  cpSync(join(root, '.env.example'), join(scratch, '.env.example'))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data') }, encoding: 'utf8', timeout: 300_000,
  })
  if (args.includes('--check')) {
    let badTargets = 0
    for (const [name, file, find] of chosen) {
      const n = readFileSync(join(scratch, file), 'utf8').split(find).length - 1
      console.log(`${n === 1 ? 'ok  ' : 'BAD '} ${name} (${n})`)
      // Lead 16:4x: a target that matches nothing (or twice) FAILS the check, never a quiet line.
      if (n !== 1) badTargets++
    }
    process.exit(badTargets ? 1 : 0)
  }
  // Green baseline first, over every suite any mutant names.
  const all = [...new Set(chosen.flatMap(m => m[5]))]
  const baseline = run(all)
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  const summary = /Tests\s+(\d+) passed \((\d+)\)/.exec(baseline.stdout)
  if (!summary || summary[1] !== summary[2]) throw new Error('Baseline did not report every test passing:\n' + baseline.stdout)
  console.log(`baseline PASS (${summary[1]} tests in ${all.length} files)`)
  // Every target exactly once, before any mutant runs.
  for (const [name, file, find] of chosen) {
    const n = readFileSync(join(scratch, file), 'utf8').split(find).length - 1
    if (n !== 1) throw new Error(`Mutation ${name} matches ${n} times in ${file}; it must match exactly once`)
  }
  let killed = 0
  // Every mutant runs; survivors are collected and reported together (Q1: stopping at the first hid the rest).
  const survivors = []
  for (const [name, file, find, replacement, killerName, tests] of chosen) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    const mutated = original.replace(find, () => replacement)
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    let result
    try { result = run(tests) } finally { writeFileSync(target, original) }
    if (readFileSync(target, 'utf8') !== original) throw new Error(`${file} was not restored after ${name}`)
    const output = result.stdout + '\n' + result.stderr
    // The intended test must be among the named failures: a kill by some unrelated test proves nothing about the rule.
    const killers = [...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(match => match[1].trim())
    if (result.status === 0 || result.error || !killers.length) { survivors.push(`${name}: SURVIVED or harness failed`); console.log(`${name} SURVIVED\n${output.slice(-1500)}`); continue }
    const killer = killers.find(line => line.includes(killerName))
    if (!killer) { survivors.push(`${name}: WRONG KILLER, expected "${killerName}", killed by: ${killers.join(' | ')}`); console.log(`${name} KILLED BY THE WRONG TEST: ${killers.join(' | ')}`); continue }
    killed++
    console.log(`${name} KILLED by ${killer}`)
  }
  console.log(`${killed} of ${chosen.length} session-catch-up mutations killed`)
  if (survivors.length) { console.log('NOT KILLED:\n  ' + survivors.join('\n  ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
