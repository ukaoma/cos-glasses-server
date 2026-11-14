#!/usr/bin/env node
// X1, 7.0.38: an answer is never queued (but Send anyway may wait), the ask is read before the busy gates, a session
// moved on by machine blocks alone is not "answered", and the real-tracker pins (an aged-out ask, the switch off, a restart). Same harness as turn-end-answer-mutation-gate.mjs: disposable copy,
// green baseline over every named suite, each target matched exactly once, each mutant killed by the test named for it,
// byte-for-byte restoration. `--check` stops after the exact-once check.
import { mkdtempSync, cpSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// [name, file, exact target, replacement, a substring of the test that must fail, tests]
const mutations = [
  ["door-parks-answer", "server/routes/thread-turn-queue.ts", "    if (isTurnEndAnswerPrompt(prompt) && !sendAnyway) {", "    if (false) {", "the door: a turn-end answer behind a busy session", ["server/routes/answer-never-queued.test.ts"]],
  ["resend-copies-answer", "server/routes/thread-turn-queue.ts", "    if (isTurnEndAnswerPrompt(original.prompt)) {", "    if (false) {", "Send again never copies an answer", ["server/routes/answer-never-queued.test.ts"]],
  ["edit-makes-answer", "server/routes/thread-turn-queue.ts", "an answer is never queued.\n    if (isTurnEndAnswerPrompt(prompt)) {", "an answer is never queued.\n    if (false) {", "an edit cannot turn a waiting row into an answer", ["server/routes/answer-never-queued.test.ts"]],
  ["drain-delivers-answer", "server/routes/thread-turn-queue.ts", "    if (isTurnEndAnswerPrompt(turn.prompt) && turn.turnEndSendAnyway !== true) {", "    if (false) {", "the drain: an answer queued before the guard", ["server/routes/answer-never-queued.test.ts"]],
  ["drain-settle-not-kept", "server/routes/thread-turn-queue.ts", "      retired += 1; persist(turn, true)\n      forgetIfSettled(turn)\n      holdCheckedAt.delete(turn.clientTurnId)\n      console.warn(`[thread-turn-queue] turn-end answer settled", "      retired += 1\n      forgetIfSettled(turn)\n      holdCheckedAt.delete(turn.clientTurnId)\n      console.warn(`[thread-turn-queue] turn-end answer settled", "the drain settles it while the session is still busy", ["server/routes/answer-never-queued.test.ts"]],
  ["door-copy-changed", "server/lib/thread-turn-queue.ts", "export const TURN_END_ANSWER_NOT_QUEUED_COPY = 'Not sent. The session is working.'", "export const TURN_END_ANSWER_NOT_QUEUED_COPY = 'turn_end_answer_not_queued'", "the door: a turn-end answer behind a busy session", ["server/routes/answer-never-queued.test.ts"]],
  ["row-copy-missing", "server/lib/thread-turn-queue.ts", "  turn_end_answer_not_queued: 'Not sent: an answer to a question is never sent late.',\n", "", "the drain: an answer queued before the guard", ["server/routes/answer-never-queued.test.ts"]],
  ["sendanyway-ignored", "server/routes/thread-turn-queue.ts", "    const sendAnyway = body.turnEndSendAnyway === true", "    const sendAnyway = false", "Send anyway (lead 07:20): the button", ["server/routes/answer-never-queued.test.ts"]],
  ["sendanyway-truthy", "server/routes/thread-turn-queue.ts", "    const sendAnyway = body.turnEndSendAnyway === true", "    const sendAnyway = !!body.turnEndSendAnyway", "the mark is never inferred, never truthy-ish", ["server/routes/answer-never-queued.test.ts"]],
  ["sendanyway-row-lost", "server/routes/thread-turn-queue.ts", "      ...(sendAnyway && isTurnEndAnswerPrompt(prompt) ? { turnEndSendAnyway: true as const } : {}),\n", "", "Send anyway (lead 07:20): the button", ["server/routes/answer-never-queued.test.ts"]],
  ["sendanyway-on-typed", "server/routes/thread-turn-queue.ts", "sendAnyway && isTurnEndAnswerPrompt(prompt) ? { turnEndSendAnyway", "sendAnyway ? { turnEndSendAnyway", "the mark on a typed message is dropped", ["server/routes/answer-never-queued.test.ts"]],
  ["drain-ignores-sendanyway", "server/routes/thread-turn-queue.ts", "    if (isTurnEndAnswerPrompt(turn.prompt) && turn.turnEndSendAnyway !== true) {", "    if (isTurnEndAnswerPrompt(turn.prompt)) {", "Send anyway (lead 07:20): the button", ["server/routes/answer-never-queued.test.ts"]],
  ["turns-sendanyway-with-ask", "server/routes/agent-session-bindings.ts", "      if (sendAnyway === true && namedAsk !== undefined && namedAsk !== null) return refuseTurn('invalid_request')\n", "", "the Send anyway mark: refused with an ask id", ["server/routes/agent-session-bindings.test.ts"]],
  ["turns-sendanyway-not-true", "server/routes/agent-session-bindings.ts", "      if (sendAnyway !== undefined && sendAnyway !== null && sendAnyway !== true) return refuseTurn('invalid_request')\n", "", "the Send anyway mark: refused with an ask id", ["server/routes/agent-session-bindings.test.ts"]],
  ["early-check-skipped", "server/routes/agent-session-bindings.ts", "        if (!early.open) {", "        if (false) {", "a second tap during an in-flight first answer", ["server/routes/agent-session-bindings.test.ts"]],
  ["early-refuses-open-ask", "server/routes/agent-session-bindings.ts", "        if (!early.open) {", "        if (true) {", "an open ask with the session busy still gets the busy reason", ["server/routes/agent-session-bindings.test.ts"]],
  ["early-revision-missing", "server/routes/agent-session-bindings.ts", "return refuseTurn('turn_end_ask_moved', { changed: true, revision: earlyRevision, ...early.refusal })", "return refuseTurn('turn_end_ask_moved', { changed: true, revision: null, ...early.refusal })", "answered at the Mac, tapped while the session works", ["server/routes/agent-session-bindings.test.ts"]],
  ["machine-prompt-answers", "server/lib/turn-end-ask.ts", "      if (current && !child && (p.prompt_machine_only === true || isMachineOnlyPrompt(p.prompt))) {", "      if (false) {", "a prompt the machine wrote clears the ask as moved on", ["server/lib/turn-end-ask.test.ts"]],
  ["machine-prompt-route", "server/lib/turn-end-ask.ts", "      if (current && !child && (p.prompt_machine_only === true || isMachineOnlyPrompt(p.prompt))) {", "      if (false) {", "a peer session's message moved the session on", ["server/routes/agent-session-bindings.test.ts"]],
  ["machine-boolean-ignored", "server/lib/turn-end-ask.ts", "(p.prompt_machine_only === true || isMachineOnlyPrompt(p.prompt))", "(isMachineOnlyPrompt(p.prompt))", "the same through a restart: the replayed peer message", ["server/routes/agent-session-bindings.test.ts"]],
  ["machine-text-after-counted", "server/lib/session-hook-events.ts", "  return blocks > 0 && rest.trim().length === 0", "  return blocks > 0", "a prompt the machine wrote clears the ask as moved on", ["server/lib/turn-end-ask.test.ts"]],
  ["machine-unclosed-counted", "server/lib/session-hook-events.ts", "    if (close < 0) return false", "    if (close < 0) return true", "a prompt the machine wrote clears the ask as moved on", ["server/lib/turn-end-ask.test.ts"]],
  ["machine-unanchored", "server/lib/session-hook-events.ts", "const MACHINE_BLOCK_OPEN_RE = /^\\s*<(", "const MACHINE_BLOCK_OPEN_RE = /<(", "a prompt the machine wrote clears the ask as moved on", ["server/lib/turn-end-ask.test.ts"]],
  ["projection-boolean-dropped", "server/lib/session-hook-events.ts", "...(isMachineOnlyPrompt(payload.prompt) ? { prompt_machine_only: true } : {})", "...({})", "the ledger keeps one boolean", ["server/lib/turn-end-ask.test.ts"]],
  ["age-out-ignored", "server/lib/turn-end-ask.ts", "    if (now - state.stoppedAt > TURN_ASK_MAX_AGE_MS) {", "    if (false) {", "an aged-out ask (past 8 hours)", ["server/routes/agent-session-bindings.test.ts"]],
  ["null-tracker-falls-through", "server/routes/agent-session-bindings.ts", "isTurnEndAnswerPrompt(prompt) && typeof deps.openTurnEndAsk === 'function'\n", "isTurnEndAnswerPrompt(prompt) && typeof deps.openTurnEndAsk === 'function' && deps.openTurnEndAsk(binding.nativeThreadId) !== null\n", "COS_TURN_END_ASKS off (no tracker)", ["server/routes/agent-session-bindings.test.ts"]],
  ["replay-loses-answered", "server/lib/turn-end-ask.ts", "          this.lastAnswered.set(sessionId, { stoppedAt: current.stoppedAt, answeredAt: env.ts, by: turnAskAnswerSurface(p.prompt, child) })", "          void 0", "restart, the ask answered at the Mac before it", ["server/routes/agent-session-bindings.test.ts"]],
  ["replay-loses-moved", "server/lib/turn-end-ask.ts", "      if (promptId === null || current.promptId === null || promptId !== current.promptId) {", "      if (false) {", "restart, the session moved on with tool work", ["server/routes/agent-session-bindings.test.ts"]],
  ["replay-loses-open", "server/lib/turn-end-ask.ts", "      const capture = p.turn_ask !== undefined ? projectedTurnAsk(p.turn_ask) : captureTurnAsk(p.tool_input, this.deps.words())", "      const capture = captureTurnAsk(p.tool_input, this.deps.words())", "restart, the ask still open", ["server/routes/agent-session-bindings.test.ts"]],
  ["early-path-sets-mark", "server/routes/agent-session-bindings.ts", "        if (!early.open) {\n", "        if (!early.open) {\n          answeredAsks.set(`claude:${binding.nativeThreadId.toLowerCase()}:${namedAsk}`, { at: Date.now(), by: turnAskAnswerSurface(prompt, true), state: 'unconfirmed' })\n", "a second tap during an in-flight first answer", ["server/routes/agent-session-bindings.test.ts"]],
  ["machine-child-moved", "server/lib/turn-end-ask.ts", "      if (current && !child && (p.prompt_machine_only", "      if (current && (p.prompt_machine_only", "a prompt the machine wrote clears the ask as moved on", ["server/lib/turn-end-ask.test.ts"]],
  ["g2-dictation-moved", "server/lib/session-hook-events.ts", "  if (prompt.includes('[COS-G2 turn')) return false\n", "", "a prompt the machine wrote clears the ask as moved on", ["server/lib/turn-end-ask.test.ts"]]
]
const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const chosen = names.length ? mutations.filter(([name]) => names.includes(name)) : mutations
if (names.length && chosen.length !== names.length) throw new Error(`Unknown mutation name in: ${args.join(' ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'answer-never-queued-mutations-'))
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
  console.log(`${killed} of ${chosen.length} answer-never-queued mutations killed`)
  if (survivors.length) { console.log('NOT KILLED:\n  ' + survivors.join('\n  ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
