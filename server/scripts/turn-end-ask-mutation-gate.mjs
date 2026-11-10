#!/usr/bin/env node
// X1 (2026-11-10, 7.0.18): the turn-end ask's guards. Same harness as full-hold-mutation-gate.mjs: disposable
// source copy, green baseline over every named suite, each target matched exactly once, each mutant
// killed by the test named for it, and byte-for-byte restoration. Never mutates the worktree.
// `--check` stops after the exact-once check (no tests run).
import { mkdtempSync, cpSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// [name, file, exact target, replacement, a substring of the test that must fail, tests]
const mutations = [
  ["default-off", "server/lib/turn-end-ask.ts", "export const TURN_END_ASKS_DEFAULT = true", "export const TURN_END_ASKS_DEFAULT = false", "defaults ON", ["server/lib/turn-end-ask.test.ts"]],
  ["switch-reread", "server/lib/turn-end-ask.ts", "if (enabledAtStartup === null) enabledAtStartup =", "enabledAtStartup =", "is read once", ["server/lib/turn-end-ask.test.ts"]],
  ["no-button-qualifies", "server/lib/turn-end-ask.ts", "if (labels.length === 0 && !blocked) return null", "", "suggestion, not a decision", ["server/lib/turn-end-ask.test.ts"]],
  ["app-action-as-choice", "server/lib/turn-end-ask.ts", "if (action.action !== undefined && action.action !== null && action.action !== '') continue", "", "app-action buttons are never choices", ["server/lib/turn-end-ask.test.ts"]],
  ["blocked-loose", "server/lib/turn-end-ask.ts", "const blocked = toolInput.blocked === true", "const blocked = !!toolInput.blocked", "blocked with no buttons", ["server/lib/turn-end-ask.test.ts"]],
  ["choices-unbounded", "server/lib/turn-end-ask.ts", "choices: words ? labels.slice(0, TURN_ASK_MAX_CHOICES) : []", "choices: words ? labels : []", "app-action buttons are never choices", ["server/lib/turn-end-ask.test.ts"]],
  ["text-unclipped", "server/lib/turn-end-ask.ts", "return text.length > max ? text.slice(0, max - 1) + '…' : text", "return text", "bounded and cleaned", ["server/lib/turn-end-ask.test.ts"]],
  ["words-ignored", "server/lib/turn-end-ask.ts", "return { ask: words ? ask : '', choices: words ? labels.slice(0, TURN_ASK_MAX_CHOICES) : [], blocked }", "return { ask, choices: labels.slice(0, TURN_ASK_MAX_CHOICES), blocked }", "words off", ["server/lib/turn-end-ask.test.ts"]],
  ["projected-unbounded", "server/lib/turn-end-ask.ts", "value.choices.filter((c): c is string => typeof c === 'string').slice(0, TURN_ASK_MAX_CHOICES)", "value.choices.filter((c): c is string => typeof c === 'string')", "reads the ledger copy back", ["server/lib/turn-end-ask.test.ts"]],
  ["disabled-observes", "server/lib/turn-end-ask.ts", "if (!this.deps.enabled()) return\n    const p = env.payload", "const p = env.payload", "does nothing at all while its switch reads off", ["server/lib/turn-end-ask.test.ts"]],
  ["disabled-shows", "server/lib/turn-end-ask.ts", "if (!this.deps.enabled()) return null\n    const key", "const key", "does nothing at all while its switch reads off", ["server/lib/turn-end-ask.test.ts"]],
  ["subagent-arms", "server/lib/turn-end-ask.ts", "if (str(p.agent_id)) return", "", "sub-agent", ["server/lib/turn-end-ask.test.ts"]],
  ["child-reply-ignored", "server/lib/turn-end-ask.ts", "if (env.event === 'UserPromptSubmit') {", "if (env.event === 'UserPromptSubmit' && !child) {", "from the desk or a COS Continue child", ["server/lib/turn-end-ask.test.ts"]],
  ["reply-keeps", "server/lib/turn-end-ask.ts", "if (current) { this.asks.delete(sessionId); this.counters.clearedByReply++ }", "", "from the desk or a COS Continue child", ["server/lib/turn-end-ask.test.ts"]],
  ["child-arms", "server/lib/turn-end-ask.ts", "    if (child) return\n", "", "COS-spawned child", ["server/lib/turn-end-ask.test.ts"]],
  ["print-run-arms", "server/lib/turn-end-ask.ts", "if (signal?.entrypoint === 'sdk-cli') return\n", "\n", "a print run (registry entrypoint sdk-cli) never arms", ["server/lib/turn-end-ask.test.ts"]],
  ["compact-clears", "server/lib/turn-end-ask.ts", "(env.event === 'SessionStart' && p.source !== 'compact')", "env.event === 'SessionStart'", "compact keeps it", ["server/lib/turn-end-ask.test.ts"]],
  ["resets-ignored", "server/lib/turn-end-ask.ts", "new Set(['SessionEnd', 'Interrupt', 'StopFailure'])", "new Set([])", "SessionStart (not compact), SessionEnd, Interrupt, StopFailure", ["server/lib/turn-end-ask.test.ts"]],
  ["startup-ignored", "server/lib/turn-end-ask.ts", "(SESSION_RESETS.has(env.event) || (env.event === 'SessionStart' && p.source !== 'compact'))", "SESSION_RESETS.has(env.event)", "SessionStart (not compact), SessionEnd, Interrupt, StopFailure", ["server/lib/turn-end-ask.test.ts"]],
  ["stop-any-prompt", "server/lib/turn-end-ask.ts", "(current.promptId === null || promptId === null || current.promptId === promptId)", "true", "a Stop of another prompt", ["server/lib/turn-end-ask.test.ts"]],
  ["stop-before-arm", "server/lib/turn-end-ask.ts", "current.stoppedAt === null && env.ts >= current.armedAt &&", "current.stoppedAt === null &&", "older than the wrap_up, ingested after it", ["server/lib/turn-end-ask.test.ts"]],
  ["stop-first-ignored", "server/lib/turn-end-ask.ts", "stoppedAt: stoppedAlready ? stop!.at : null", "stoppedAt: null", "the Stop first", ["server/lib/turn-end-ask.test.ts"]],
  ["stop-first-any-time", "server/lib/turn-end-ask.ts", "!!stop && env.ts <= stop.at &&", "!!stop &&", "a Stop of another prompt, or an earlier Stop", ["server/lib/turn-end-ask.test.ts"]],
  ["stop-first-any-prompt", "server/lib/turn-end-ask.ts", "(stop.promptId === null || promptId === null || stop.promptId === promptId)", "true", "the other prompt that came FIRST", ["server/lib/turn-end-ask.test.ts"]],
  ["disarm-ignored", "server/lib/turn-end-ask.ts", "if (current && current.stoppedAt === null) this.asks.delete(sessionId)", "", "disarms the earlier one", ["server/lib/turn-end-ask.test.ts"]],
  ["disarm-after-stop", "server/lib/turn-end-ask.ts", "if (current && current.stoppedAt === null) this.asks.delete(sessionId)", "if (current) this.asks.delete(sessionId)", "leaves the asked one alone", ["server/lib/turn-end-ask.test.ts"]],
  ["new-turn-kept", "server/lib/turn-end-ask.ts", "if (promptId === null || current.promptId === null || promptId !== current.promptId) {", "if (false) {", "a new turn's tool step", ["server/lib/turn-end-ask.test.ts"]],
  ["new-turn-same-prompt", "server/lib/turn-end-ask.ts", "if (promptId === null || current.promptId === null || promptId !== current.promptId) {", "if (true) {", "a new turn's tool step", ["server/lib/turn-end-ask.test.ts"]],
  ["new-turn-before-stop", "server/lib/turn-end-ask.ts", "if (current && current.stoppedAt !== null && env.ts > current.stoppedAt && (", "if (current && current.stoppedAt !== null && (", "a new turn's tool step", ["server/lib/turn-end-ask.test.ts"]],
  ["age-out-off", "server/lib/turn-end-ask.ts", "if (now - state.stoppedAt > TURN_ASK_MAX_AGE_MS) {", "if (false) {", "8 hours after the stop", ["server/lib/turn-end-ask.test.ts"]],
  ["age-nine-hours", "server/lib/turn-end-ask.ts", "TURN_ASK_MAX_AGE_MS = 8 * 60 * 60_000", "TURN_ASK_MAX_AGE_MS = 9 * 60 * 60_000", "8 hours after the stop", ["server/lib/turn-end-ask.test.ts"]],
  ["prune-age-off", "server/lib/turn-end-ask.ts", "if (state.stoppedAt !== null && now - state.stoppedAt > TURN_ASK_MAX_AGE_MS) { this.asks.delete(state.sessionId); this.counters.agedOut++ }", "", "aged out before the desk was ever idle", ["server/lib/turn-end-ask.test.ts"]],
  ["latch-skipped", "server/lib/turn-end-ask.ts", "if (state.visibleAt === null) return null", "", "C17 order", ["server/lib/turn-end-ask.test.ts"]],
  ["threshold-floor-dropped", "server/lib/turn-end-ask.ts", "Math.max(TURN_ASK_DESK_IDLE_MIN_S, Number.isFinite(configured) ? configured : TURN_ASK_DESK_IDLE_MIN_S)", "(Number.isFinite(configured) ? configured : TURN_ASK_DESK_IDLE_MIN_S)", "never below 30", ["server/lib/turn-end-ask.test.ts"]],
  ["threshold-off-by-one", "server/lib/turn-end-ask.ts", "if (idle < threshold) return", "if (idle <= threshold) return", "C17 order", ["server/lib/turn-end-ask.test.ts"]],
  ["unreadable-shows", "server/lib/turn-end-ask.ts", "if (idle === null || !Number.isFinite(idle)) return Math.max(pollMs, TURN_ASK_UNREADABLE_RETRY_MS)", "if (idle === null || !Number.isFinite(idle)) idle = 1e9", "unreadable desk", ["server/lib/turn-end-ask.test.ts"]],
  ["smart-wait-off", "server/lib/turn-end-ask.ts", "return Math.max(pollMs, Math.ceil((threshold - idle) * 1000))", "return pollMs", "a busy desk is read again only when", ["server/lib/turn-end-ask.test.ts"]],
  ["reads-when-nothing-waits", "server/lib/turn-end-ask.ts", "if (!this.waitingForLatch()) return null\n    const pollMs", "const pollMs", "no desk read while nothing waits", ["server/lib/turn-end-ask.test.ts"]],
  ["row-ended-ignored", "server/lib/turn-end-ask.ts", "if (state.sessionId === key || (key.length < 36 && state.sessionId.startsWith(key))) { this.asks.delete(state.sessionId); this.counters.clearedByTurn++ }", "", "the row ending", ["server/lib/turn-end-ask.test.ts"]],
  ["tracked-unbounded", "server/lib/turn-end-ask.ts", "while (this.asks.size > MAX_TURN_ASKS) {", "while (false) {", "at most 128", ["server/lib/turn-end-ask.test.ts"]],
  ["projected-path-ignored", "server/lib/turn-end-ask.ts", "const capture = p.turn_ask !== undefined ? projectedTurnAsk(p.turn_ask) : captureTurnAsk(p.tool_input, this.deps.words())", "const capture = captureTurnAsk(p.tool_input, this.deps.words())", "a replayed (projected) row arms", ["server/lib/turn-end-ask.test.ts"]],
  ["projection-ignores-switch", "server/lib/session-hook-events.ts", "if (event !== 'PostToolUse' || toolName !== WRAP_UP_TOOL || !turnEndAsksEnabled()) return {}", "if (event !== 'PostToolUse' || toolName !== WRAP_UP_TOOL) return {}", "the projection is 7.0.17", ["server/lib/turn-end-ask.test.ts"]],
  ["projection-any-event", "server/lib/session-hook-events.ts", "if (event !== 'PostToolUse' || toolName !== WRAP_UP_TOOL || !turnEndAsksEnabled()) return {}", "if (toolName !== WRAP_UP_TOOL || !turnEndAsksEnabled()) return {}", "only on a PostToolUse of wrap_up", ["server/lib/turn-end-ask.test.ts"]],
  ["projection-words-ignored", "server/lib/session-hook-events.ts", "captureTurnAsk(toolInput, waitingQuestionWordsEnabled(process.env))", "captureTurnAsk(toolInput, true)", "only on a PostToolUse of wrap_up", ["server/lib/turn-end-ask.test.ts"]],
  ["projection-keeps-raw", "server/lib/session-hook-events.ts", "return capture ? { turn_ask: capture } : {}", "return capture ? { turn_ask: capture, input: toolInput } : {}", "never recap or tool_response", ["server/lib/turn-end-ask.test.ts"]],
  ["overlay-over-running", "server/lib/session-state-derive.ts", "if (!ask || base.agent_state !== 'idle') return base", "if (!ask) return base", "never over running", ["server/lib/turn-end-ask.test.ts"]],
  ["overlay-print-run", "server/lib/session-state-derive.ts", "if (signal?.entrypoint === 'sdk-cli') return base", "", "a print run's signal", ["server/lib/turn-end-ask.test.ts"]],
  ["overlay-registry-busy-ignored", "server/lib/session-state-derive.ts", "if (registry?.alive && registry.status === 'busy' && registry.statusUpdatedAt !== null && registry.statusUpdatedAt > ask.stoppedAt + TURN_ASK_BUSY_GRACE_MS) return base", "", "the registry busy again", ["server/lib/turn-end-ask.test.ts"]],
  ["overlay-no-grace", "server/lib/session-state-derive.ts", "registry.statusUpdatedAt > ask.stoppedAt + TURN_ASK_BUSY_GRACE_MS) return base", "registry.statusUpdatedAt > ask.stoppedAt) return base", "the registry busy again", ["server/lib/turn-end-ask.test.ts"]],
  ["overlay-dead-registry-vetoes", "server/lib/session-state-derive.ts", "if (registry?.alive && registry.status === 'busy'", "if (registry && registry.status === 'busy'", "the registry busy again", ["server/lib/turn-end-ask.test.ts"]],
  ["overlay-since-dropped", "server/lib/session-state-derive.ts", "    state_since: iso(ask.stoppedAt),\n", "", "the contract row", ["server/lib/turn-end-ask.test.ts"]],
  ["row-fields-dropped", "server/lib/session-state-derive.ts", "    ...(derived.waiting_source ? { waiting_source: derived.waiting_source, waiting_choices: [...(derived.waiting_choices ?? [])] } : {}),\n    ...(derived.failure ? { failure: derived.failure } : {}),\n    ...(derived.last_reply ?", "    ...(derived.failure ? { failure: derived.failure } : {}),\n    ...(derived.last_reply ?", "the contract row", ["server/lib/turn-end-ask.test.ts"]],
  ["status-fields-dropped", "server/lib/session-state-derive.ts", "    ...(derived.waiting_source ? { waiting_source: derived.waiting_source, waiting_choices: [...(derived.waiting_choices ?? [])] } : {}),\n    ...(derived.failure ? { failure: derived.failure } : {}),\n    ...(derived.agent_state === 'idle'", "    ...(derived.failure ? { failure: derived.failure } : {}),\n    ...(derived.agent_state === 'idle'", "the contract row", ["server/lib/turn-end-ask.test.ts"]],
  ["stream-reads-working", "server/lib/session-stream-events.ts", "derived.agent_state === 'waiting' && derived.waiting_source === 'turn_end' ? 'idle'\n    : ", "", "the stream reads it idle", ["server/lib/turn-end-ask.test.ts"]],
  ["stream-fields-dropped", "server/lib/session-stream-events.ts", "    ...(derived.waiting_source ? { waiting_source: derived.waiting_source, waiting_choices: [...(derived.waiting_choices ?? [])] } : {}),\n", "", "the stream reads it idle", ["server/lib/turn-end-ask.test.ts"]],
  ["runtime-no-ask", "server/lib/session-hooks-runtime.ts", "...(turnEndAskTracker ? { turnEndAsk: turnEndAskTracker.visibleAsk(key, now) } : {}),", "", "the row turns waiting once latched", ["server/lib/turn-end-ask.test.ts"]],
  ["runtime-row-end-kept", "server/lib/session-hooks-runtime.ts", "    turnEndAskTracker?.sessionRowEnded(key)\n", "", "the registry ends (dead pid on two scans", ["server/lib/turn-end-ask.test.ts"]],
  ["runtime-ignores-switch", "server/lib/session-hooks-runtime.ts", "turnEndAskTracker = enabled && turnEndAsksEnabled() ? new TurnEndAskTracker({", "turnEndAskTracker = enabled ? new TurnEndAskTracker({", "off: no tracker, no counters", ["server/lib/turn-end-ask.test.ts"]],
  ["runtime-subscribes-late", "server/lib/session-hooks-runtime.ts", "  const unsubscribeTurnAsk = tracker ? sessionSignalStore.subscribe((signal, env, child) => tracker.observe(env, child, signal)) : () => {}\n  const replay = ledger.replay(", "  let unsubscribeTurnAsk = () => {}\n  const replay = ledger.replay(", "survives a restart", ["server/lib/turn-end-ask.test.ts"]],
  ["route-always-counters", "server/routes/permission-broker.ts", "return counters ? { turnEndAsks: counters } : {}", "return { turnEndAsks: counters }", "absent while it is off", ["server/routes/session-questions-turn-end.test.ts"]],
]
const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const chosen = names.length ? mutations.filter(([name]) => names.includes(name)) : mutations
if (names.length && chosen.length !== names.length) throw new Error(`Unknown mutation name in: ${args.join(' ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'turn-end-ask-mutations-'))
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
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data') }, encoding: 'utf8', timeout: 300_000,
  })
  if (args.includes('--check')) {
    for (const [name, file, find] of chosen) {
      const n = readFileSync(join(scratch, file), 'utf8').split(find).length - 1
      console.log(`${n === 1 ? 'ok  ' : 'BAD '} ${name} (${n})`)
    }
    process.exit(0)
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
    if (!killer) { survivors.push(`${name}: killed, but not by "${killerName}" (${killers.join(' | ')})`); console.log(`${name} KILLED BY THE WRONG TEST: ${killers.join(' | ')}`); continue }
    killed++
    console.log(`${name} KILLED by ${killer}`)
  }
  console.log(`${killed} of ${chosen.length} turn-end-ask mutations killed`)
  if (survivors.length) { console.log('NOT KILLED:\n  ' + survivors.join('\n  ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
