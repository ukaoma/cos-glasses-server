#!/usr/bin/env node
// X1 (2026-11-12): the 8 hour question wait, at-once visibility and the turn-end replay. Same harness as
// turn-end-ask-mutation-gate.mjs: disposable copy, green baseline over every named suite, each target matched
// exactly once, each mutant killed by the test named for it, byte-for-byte restoration. `--check` stops after
// the exact-once check.
import { mkdtempSync, cpSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// [name, file, exact target, replacement, a substring of the test that must fail, tests]
const mutations = [
  ["question-wait-hours", "server/lib/full-hold.ts", "export const FULL_HOLD_QUESTION_WAIT_HOURS = 8", "export const FULL_HOLD_QUESTION_WAIT_HOURS = 7", "every wait is derived", ["server/lib/question-wait-8h.test.ts"]],
  ["plan-question-old-wait", "server/lib/claude-hooks-installer.ts", "questionWaitS: on.questions ? FULL_HOLD_QUESTION_WAIT_S : PERMISSION_HOOK_TIMEOUT_S", "questionWaitS: on.questions ? FULL_HOLD_HOOK_WAIT_S : PERMISSION_HOOK_TIMEOUT_S", "every wait is derived", ["server/lib/question-wait-8h.test.ts"]],
  ["plan-approval-8h", "server/lib/claude-hooks-installer.ts", "otherWaitS: on.approvals ? FULL_HOLD_HOOK_WAIT_S : PERMISSION_HOOK_TIMEOUT_S", "otherWaitS: on.approvals ? FULL_HOLD_QUESTION_WAIT_S : PERMISSION_HOOK_TIMEOUT_S", "every wait is derived", ["server/lib/question-wait-8h.test.ts"]],
  ["prior-split-variant-dropped", "server/lib/claude-hooks-installer.ts", "const questionWaits = [PERMISSION_HOOK_TIMEOUT_S, FULL_HOLD_QUESTION_WAIT_PRIOR_S, FULL_HOLD_QUESTION_WAIT_S]", "const questionWaits = [PERMISSION_HOOK_TIMEOUT_S, FULL_HOLD_QUESTION_WAIT_S]", "a split install from 7.0.16 to 7.0.31", ["server/lib/question-wait-8h.test.ts"]],
  ["stamp-cap-old", "server/lib/permission-broker.ts", "export const HOOK_WAIT_STAMP_MAX_S = FULL_HOLD_QUESTION_WAIT_S", "export const HOOK_WAIT_STAMP_MAX_S = 3_600", "reads the hook's wait stamp only as a whole number", ["server/lib/permission-broker.test.ts"]],
  ["script-cap-old", "bin/hooks/cos-session-hook", "[ \"$2\" -le 28800 ]", "[ \"$2\" -le 3600 ]", "stamps the wait on the request as hookWaitS", ["server/lib/cos-session-hook.script.test.ts"]],
  ["script-digits-old", "bin/hooks/cos-session-hook", "[ ${#2} -le 5 ]", "[ ${#2} -le 4 ]", "stamps the wait on the request as hookWaitS", ["server/lib/cos-session-hook.script.test.ts"]],
  ["script-cap-unpinned", "bin/hooks/cos-session-hook", "[ \"$2\" -le 28800 ]", "[ \"$2\" -le 28801 ]", "the hook script accepts exactly up to that wait", ["server/lib/question-wait-8h.test.ts"]],
  ["at-once-off", "server/lib/permission-broker.ts", "lensVisible: !askHold || full || (idle", "lensVisible: !askHold || (idle", "on every surface at once", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["at-once-for-every-question", "server/lib/permission-broker.ts", "lensVisible: !askHold || full || (idle !== null && idle >= this.deskIdleThreshold())", "lensVisible: true", "full hold does NOT take (engine unproven) still waits", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["not-shown-off", "server/lib/permission-broker.ts", "if (!item.lensVisible && this.anyFullHoldOn()) {", "if (false) {", "O1: an item no device is shown yet", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["equivalence-ignores-plan", "server/lib/claude-hooks-installer.ts", "return plan.questionWaitS <= FULL_HOLD_QUESTION_WAIT_PRIOR_S && WAIT_CAP_ONLY_PRIOR_SCRIPT_SHAS.includes(scriptSha)", "return WAIT_CAP_ONLY_PRIOR_SCRIPT_SHAS.includes(scriptSha)", "question switch on: the 7.0.31 script reads script_outdated", ["server/lib/question-wait-8h.test.ts"]],
  ["equivalence-off", "server/lib/claude-hooks-installer.ts", "return plan.questionWaitS <= FULL_HOLD_QUESTION_WAIT_PRIOR_S && WAIT_CAP_ONLY_PRIOR_SCRIPT_SHAS.includes(scriptSha)", "return false", "switch off: the 7.0.31 script reads installed", ["server/lib/question-wait-8h.test.ts"]],
  ["status-strict", "server/lib/claude-hooks-installer.ts", "else if (!scriptCurrentForPlan(scriptSha, packageScriptSha, paths.plan ?? permissionHookPlan())) state = 'script_outdated'", "else if (!scriptSha || (packageScriptSha && scriptSha !== packageScriptSha)) state = 'script_outdated'", "switch off: the 7.0.31 script reads installed", ["server/lib/question-wait-8h.test.ts"]],
  ["cursor-strict", "server/lib/claude-hooks-installer.ts", "return status.scriptSha === status.packageScriptSha || WAIT_CAP_ONLY_PRIOR_SCRIPT_SHAS.includes(status.scriptSha)", "return status.scriptSha === status.packageScriptSha", "switch off: the 7.0.31 script reads installed", ["server/lib/question-wait-8h.test.ts"]],
  ["codex-strict", "server/lib/codex-hooks-installer.ts", "const scriptOk = scriptSha !== null && (scriptSha === packageScriptSha || WAIT_CAP_ONLY_PRIOR_SCRIPT_SHAS.includes(scriptSha))", "const scriptOk = scriptSha !== null && scriptSha === packageScriptSha", "Codex: its copy", ["server/lib/question-wait-8h.test.ts"]],
  ["halt-list-missing", "server/lib/claude-hooks-installer.ts", "  // X1: the 6.71.7 to 7.0.31 script (WAIT_CAP_ONLY_PRIOR_SCRIPT_SHAS below); its halt check is this package's.\n  'ee32d7a6b051cc1b9250c0b732fbfe528a59b4930daaf27696830d5803d6687a',\n", "", "still halt-ready", ["server/lib/question-wait-8h.test.ts"]],
  ["replay-extra-off", "server/lib/session-hooks-runtime.ts", "const trackerSince = tracker ? since - turnAskReplayExtraMs() : since", "const trackerSince = since", "an ask 7 h old is armed", ["server/lib/question-wait-8h.test.ts"]],
  ["replay-into-store", "server/lib/session-hooks-runtime.ts", "    if (env.ts < since) {\n      trackerOnly++", "    if (false) {\n      trackerOnly++", "an ask 7 h old is armed", ["server/lib/question-wait-8h.test.ts"]],
  ["replay-extra-unbounded", "server/lib/session-hooks-runtime.ts", "return Math.max(0, TURN_ASK_MAX_AGE_MS - LEDGER_REPLAY_WINDOW_MS)", "return Math.max(0, TURN_ASK_MAX_AGE_MS)", "2 h past the store", ["server/lib/question-wait-8h.test.ts"]],
  ["replay-count-includes-tracker", "server/lib/session-hooks-runtime.ts", "applied: replay.applied - trackerOnly", "applied: replay.applied", "an ask 7 h old is armed", ["server/lib/question-wait-8h.test.ts"]],
]
const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const chosen = names.length ? mutations.filter(([name]) => names.includes(name)) : mutations
if (names.length && chosen.length !== names.length) throw new Error(`Unknown mutation name in: ${args.join(' ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'question-8h-mutations-'))
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
  console.log(`${killed} of ${chosen.length} question-8h mutations killed`)
  if (survivors.length) { console.log('NOT KILLED:\n  ' + survivors.join('\n  ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
