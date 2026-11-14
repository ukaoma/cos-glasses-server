#!/usr/bin/env node
// X1, 7.0.36: a turn-end answer is addressed to its ask (the "session moved on" refusals of 2026-11-13). Same harness as
// question-hold-default-mutation-gate.mjs: disposable copy, green baseline over every named suite, each target matched
// exactly once, each mutant killed by the test named for it, byte-for-byte restoration. `--check` stops after the
// exact-once check. One mutant per branch: the waiver, the contract-words gate, the id match, the moved refusal and its
// new ask, both id grammars, the row's id and its value, the runtime accessor, and the wiring.
import { mkdtempSync, cpSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// [name, file, exact target, replacement, a substring of the test that must fail, tests]
const mutations = [
  ["open-ask-not-waived", "server/routes/agent-session-bindings.ts", "if (acknowledged !== head.digest && !answersOpenAsk) {", "if (acknowledged !== head.digest) {", "AFTER: naming the ask that is still open", ["server/routes/agent-session-bindings.test.ts"]],
  ["typed-message-may-name-ask", "server/routes/agent-session-bindings.ts", "binding.provider === 'claude' && isTurnEndAnswerPrompt(prompt) && typeof deps.openTurnEndAsk", "binding.provider === 'claude' && typeof deps.openTurnEndAsk", "a typed message cannot use an ask id", ["server/routes/agent-session-bindings.test.ts"]],
  ["any-open-ask-matches", "server/routes/agent-session-bindings.ts", "if (open && turnEndAskId(open.stoppedAt) === namedAsk) {", "if (open) {", "the session took another turn (a newer ask is open)", ["server/routes/agent-session-bindings.test.ts"]],
  ["moved-not-refused", "server/routes/agent-session-bindings.ts", "          return refuseTurn('turn_end_ask_moved', {\n            changed: true,", "          if (false) return refuseTurn('turn_end_ask_moved', {\n            changed: true,", "no ask open any more", ["server/routes/agent-session-bindings.test.ts"]],
  ["moved-without-new-ask", "server/routes/agent-session-bindings.ts", "askNow: open ? { id: turnEndAskId(open.stoppedAt), ask: open.ask, choices: [...open.choices] } : null,", "askNow: null,", "the session took another turn (a newer ask is open)", ["server/routes/agent-session-bindings.test.ts"]],
  ["id-unanchored", "server/lib/session-state-derive.ts", "export const TURN_END_ASK_ID_RE = /^turn_end:\\d{1,16}$/", "export const TURN_END_ASK_ID_RE = /turn_end:\\d+/", "a malformed ask id is refused", ["server/routes/agent-session-bindings.test.ts"]],
  ["prefix-unanchored", "server/routes/agent-session-bindings.ts", "const TURN_END_ANSWER_RE = /^Answer sent from [^\\n]{1,60} through COS, not typed in this session: /", "const TURN_END_ANSWER_RE = /through COS/", "a typed message cannot use an ask id", ["server/routes/agent-session-bindings.test.ts"]],
  ["row-id-missing", "server/lib/session-state-derive.ts", "    waiting_ask_id: turnEndAskId(ask.stoppedAt),\n", "", "the contract row", ["server/lib/turn-end-ask.test.ts"]],
  ["id-not-the-stop", "server/lib/session-state-derive.ts", "return `turn_end:${Math.trunc(stoppedAt)}`", "return `turn_end:0`", "AFTER: naming the ask that is still open", ["server/routes/agent-session-bindings.test.ts"]],
  ["runtime-accessor-dead", "server/lib/session-hooks-runtime.ts", "return turnEndAskTracker ? turnEndAskTracker.visibleAsk(sessionId, now) : null", "return null", "openTurnEndAsk names the same ask", ["server/lib/turn-end-ask.test.ts"]],
  ["index-unwired", "server/index.ts", "  openTurnEndAsk: sessionId => openTurnEndAsk(sessionId),\n", "", "index.ts wires the tracker into the route", ["server/routes/agent-session-bindings.test.ts"]],
  ["timing-line-anonymous", "server/routes/agent-session-bindings.ts", "${stages.join(' ')} at=${turnAt} bindingId=${turnBindingId} clientTurnId=${turnClientKey} turnEndAsk=${turnNamedAsk}`", "${stages.join(' ')}`", "AFTER: naming the ask that is still open", ["server/routes/agent-session-bindings.test.ts"]],
  ["second-answer-allowed", "server/routes/agent-session-bindings.ts", "if (open && turnEndAskId(open.stoppedAt) === namedAsk && answeredAsks.has(askKey)) {", "if (false) {", "first answer counts", ["server/routes/agent-session-bindings.test.ts"]],
  ["answer-never-marked", "server/routes/agent-session-bindings.ts", "answeredAsks.set(askKey, { at: Date.now(), by: turnAskAnswerSurface(prompt, true) })", "void askKey", "first answer counts", ["server/routes/agent-session-bindings.test.ts"]],
  ["refused-answer-uses-up-ask", "server/routes/agent-session-bindings.ts", "if (answeredAskKey !== null) { answeredAsks.delete(answeredAskKey); answeredAskKey = null }", "", "refused after it was accepted", ["server/routes/agent-session-bindings.test.ts"]],
  ["answered-not-reported", "server/routes/agent-session-bindings.ts", "            ...(answeredBy !== null ? { answered: true, answeredBy } : {}),\n", "", "answered at the Mac first", ["server/routes/agent-session-bindings.test.ts"]],
  ["answer-not-remembered", "server/lib/turn-end-ask.ts", "          this.lastAnswered.set(sessionId, { stoppedAt: current.stoppedAt, answeredAt: env.ts, by: turnAskAnswerSurface(p.prompt, child) })\n", "", "openTurnEndAsk names the same ask", ["server/lib/turn-end-ask.test.ts"]],
  ["answered-any-ask", "server/lib/turn-end-ask.ts", "if (!hit || hit.stoppedAt !== stoppedAt || now - hit.stoppedAt > TURN_ASK_MAX_AGE_MS) return null", "if (!hit || now - hit.stoppedAt > TURN_ASK_MAX_AGE_MS) return null", "openTurnEndAsk names the same ask", ["server/lib/turn-end-ask.test.ts"]],
  ["answered-display-window", "server/lib/turn-end-ask.ts", "if (!hit || hit.stoppedAt !== stoppedAt || now - hit.stoppedAt > TURN_ASK_MAX_AGE_MS) return null", "if (!hit || hit.stoppedAt !== stoppedAt || now - hit.answeredAt > TURN_ASK_ANSWERED_KEEP_MS) return null", "openTurnEndAsk names the same ask", ["server/lib/turn-end-ask.test.ts"]],
  ["answered-unwired", "server/index.ts", "  turnEndAskAnswered: (sessionId, stoppedAt) => turnEndAskAnswered(sessionId, stoppedAt),\n", "", "index.ts wires the tracker into the route", ["server/routes/agent-session-bindings.test.ts"]],
  ["first-answer-surface-lost", "server/routes/agent-session-bindings.ts", "answeredBy: answeredAsks.get(askKey)?.by ?? 'cos', askNow: null", "answeredBy: 'cos', askNow: null", "first answer counts", ["server/routes/agent-session-bindings.test.ts"]],
]
const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const chosen = names.length ? mutations.filter(([name]) => names.includes(name)) : mutations
if (names.length && chosen.length !== names.length) throw new Error(`Unknown mutation name in: ${args.join(' ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'turn-end-answer-mutations-'))
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
  console.log(`${killed} of ${chosen.length} turn-end-answer mutations killed`)
  if (survivors.length) { console.log('NOT KILLED:\n  ' + survivors.join('\n  ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
