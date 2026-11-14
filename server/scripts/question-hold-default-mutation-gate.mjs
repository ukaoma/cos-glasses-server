#!/usr/bin/env node
// X1, 7.0.34: the question hold on by default, pending per request (Miles 2026-11-13 15:02). Same harness as
// question-8h-mutation-gate.mjs: disposable copy, green baseline over every named suite, each target matched exactly
// once, each mutant killed by the test named for it, byte-for-byte restoration. `--check` stops after the
// exact-once check. One mutant per branch of the rule: the three states, the order, the stamp gate, both plans, the
// status field, the broker's per-request and per-Mac checks, the kill switch, the wiring, and the route's refusals.
import { mkdtempSync, cpSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// [name, file, exact target, replacement, a substring of the test that must fail, tests]
const mutations = [
  ["env-on-ignored", "server/lib/full-hold.ts", "  if (readSwitch(env.COS_QUESTION_FULL_HOLD, false)) return { mode: 'on', source: 'env' }\n", "", "unset is the default; 0 and 1", ["server/lib/question-hold-default.test.ts"]],
  ["env-off-ignored", "server/lib/full-hold.ts", "  if (!readSwitch(env.COS_QUESTION_FULL_HOLD, true)) return { mode: 'off', source: 'env' }\n", "", "unset is the default; 0 and 1", ["server/lib/question-hold-default.test.ts"]],
  ["setting-ignored", "server/lib/full-hold.ts", "  if (setting === 'on' || setting === 'off') return { mode: setting, source: 'setting' }\n", "", "the setting applies only when", ["server/lib/question-hold-default.test.ts"]],
  ["setting-beats-env", "server/lib/full-hold.ts", "  if (readSwitch(env.COS_QUESTION_FULL_HOLD, false)) return { mode: 'on', source: 'env' }\n  if (!readSwitch(env.COS_QUESTION_FULL_HOLD, true)) return { mode: 'off', source: 'env' }\n  if (setting === 'on' || setting === 'off') return { mode: setting, source: 'setting' }\n", "  if (setting === 'on' || setting === 'off') return { mode: setting, source: 'setting' }\n  if (readSwitch(env.COS_QUESTION_FULL_HOLD, false)) return { mode: 'on', source: 'env' }\n  if (!readSwitch(env.COS_QUESTION_FULL_HOLD, true)) return { mode: 'off', source: 'env' }\n", "the environment beats it both ways", ["server/lib/question-hold-default.test.ts"]],
  ["default-is-off", "server/lib/full-hold.ts", "  return { mode: 'default', source: 'default' }\n", "  return { mode: 'off', source: 'default' }\n", "unset is the default; 0 and 1", ["server/lib/question-hold-default.test.ts"]],
  ["stamp-gate-inclusive", "server/lib/full-hold.ts", "hookWaitS > DEFAULT_HOLD_MIN_STAMP_S", "hookWaitS >= DEFAULT_HOLD_MIN_STAMP_S", "only a stamp longer than", ["server/lib/question-hold-default.test.ts"]],
  ["switches-no-default", "server/lib/full-hold.ts", "questionsByDefault: q.mode === 'default' }", "questionsByDefault: false }", "the broker switches: default is neither", ["server/lib/question-hold-default.test.ts"]],
  ["install-not-opt-in", "server/lib/claude-hooks-installer.ts", "(options.forInstall === true || defaultHoldTakesStamp(options.installedQuestionWaitS))", "defaultHoldTakesStamp(options.installedQuestionWaitS)", "UNSET + Reinstall hooks", ["server/lib/question-hold-default.test.ts"]],
  ["status-ignores-long-block", "server/lib/claude-hooks-installer.ts", "(options.forInstall === true || defaultHoldTakesStamp(options.installedQuestionWaitS))", "options.forInstall === true", "UNSET + Reinstall hooks", ["server/lib/question-hold-default.test.ts"]],
  ["status-plan-always-long", "server/lib/claude-hooks-installer.ts", "(options.forInstall === true || defaultHoldTakesStamp(options.installedQuestionWaitS))", "true", "UNSET + old hooks = 7.0.33 off", ["server/lib/question-hold-default.test.ts"]],
  ["installer-plan-status", "server/lib/claude-hooks-installer.ts", "permissionHookPlan(process.env, { forInstall: true, setting:", "permissionHookPlan(process.env, { forInstall: false, setting:", "UNSET + Reinstall hooks", ["server/lib/question-hold-default.test.ts"]],
  ["status-setting-ignored", "server/lib/claude-hooks-installer.ts", "  const setting = paths.setting === undefined ? readQuestionHoldSetting(questionHoldSettingPath(hookPaths.home)) : paths.setting\n", "  const setting = paths.setting === undefined ? null : paths.setting\n", "the setting file decides", ["server/lib/question-hold-default.test.ts"]],
  ["offered-not-default-only", "server/lib/claude-hooks-installer.ts", "    offered: mode === 'default' && !long,", "    offered: !long,", "UNSET + old hooks = 7.0.33 off", ["server/lib/question-hold-default.test.ts"]],
  ["active-ignores-off", "server/lib/claude-hooks-installer.ts", "    active: mode !== 'off' && long,", "    active: long,", "questionWaitStatus: active needs", ["server/lib/question-hold-default.test.ts"]],
  ["status-field-dropped", "server/lib/session-hooks-runtime.ts", "      ...(status.questionWait ? { questionWait: status.questionWait } : {}),\n", "", "the Mac app writes it", ["server/lib/question-hold-default.test.ts"]],
  ["broker-allows-any-stamp", "server/lib/permission-broker.ts", "return on.questions || (on.questionsByDefault === true && defaultHoldTakesStamp(hookWaitS))", "return on.questions || on.questionsByDefault === true", "UNSET + old hooks (stamp 630) = OFF exactly", ["server/lib/question-hold-default.test.ts"]],
  ["broker-default-never-holds", "server/lib/permission-broker.ts", "return on.questions || (on.questionsByDefault === true && defaultHoldTakesStamp(hookWaitS))", "return on.questions", "UNSET + reinstalled hooks (stamp 28,800) = the full hold", ["server/lib/question-hold-default.test.ts"]],
  ["extended-without-block", "server/lib/permission-broker.ts", "return on.questionsByDefault === true && defaultHoldTakesStamp(this.installedHookTimeoutS('question'))", "return on.questionsByDefault === true", "UNSET + old hooks (stamp 630) = OFF exactly", ["server/lib/question-hold-default.test.ts"]],
  ["extended-never-by-default", "server/lib/permission-broker.ts", "return on.questionsByDefault === true && defaultHoldTakesStamp(this.installedHookTimeoutS('question'))", "return false", "UNSET + reinstalled hooks (stamp 28,800) = the full hold", ["server/lib/question-hold-default.test.ts"]],
  ["route-shape-extended-by-default", "server/lib/permission-broker.ts", "return on.questionsByDefault === true && defaultHoldTakesStamp(this.installedHookTimeoutS('question'))", "return on.questionsByDefault === true", "unset with old hooks answers the route", ["server/routes/session-questions-queue.test.ts"]],
  ["broker-drops-default-flag", "server/lib/permission-broker.ts", "questionsByDefault: on?.questionsByDefault === true }", "questionsByDefault: false }", "UNSET + reinstalled hooks (stamp 28,800) = the full hold", ["server/lib/question-hold-default.test.ts"]],
  ["tick-hands-back-default", "server/lib/permission-broker.ts", "item.kind === 'question' ? !(on.questions || on.questionsByDefault === true) : !on.approvals", "item.kind === 'question' ? !on.questions : !on.approvals", "stays held on a tick", ["server/lib/question-hold-default.test.ts"]],
  ["index-no-setting", "server/index.ts", "  fullHold: () => fullHoldSwitches(process.env, readQuestionHoldSetting()),", "  fullHold: () => fullHoldSwitches(process.env),", "index.ts wires the switches", ["server/routes/permission-broker-full-hold.test.ts"]],
  ["route-web-writes", "server/routes/session-hooks.ts", "if (res.locals[API_AUTH_BY_LOCAL] !== 'token') {", "if (false) {", "a browser session is refused", ["server/lib/question-hold-default.test.ts"]],
  ["route-overrides-env", "server/routes/session-hooks.ts", "if (questionHoldMode(process.env).source === 'env') {", "if (false) {", "while the environment decides", ["server/lib/question-hold-default.test.ts"]],
  ["route-any-mode", "server/routes/session-hooks.ts", "if (mode !== 'on' && mode !== 'off' && mode !== 'default') {", "if (false) {", "a browser session is refused", ["server/lib/question-hold-default.test.ts"]],
  ["setting-default-kept", "server/lib/question-hold-setting.ts", "  if (mode === 'default') {\n", "  if (false) {\n", "the setting file: on and off", ["server/lib/question-hold-default.test.ts"]],
  ["setting-any-value", "server/lib/question-hold-setting.ts", "parsed && (parsed.mode === 'on' || parsed.mode === 'off') ? parsed.mode : null", "parsed ? parsed.mode as QuestionHoldSetting : null", "the setting file: on and off", ["server/lib/question-hold-default.test.ts"]],
  ["web-offer-ignores-flag", "server/web-control/app.js", "st === 'installed' && SX.hooksOffer", "st === 'installed'", "installed and not offered", ["server/web-control/question-wait-offer-web.test.ts"]],
  ["web-offer-never-read", "server/web-control/app.js", "questionWait.offered === true)", "questionWait.offered === 'never')", "installed and offered: one plain line", ["server/web-control/question-wait-offer-web.test.ts"]],
  ["web-offer-beside-problem", "server/web-control/app.js", "    if (['missing', 'drift', 'script_outdated', 'route_absent'].indexOf(st) < 0) {\n      // 7.0.34", "    if (SX.hooksOffer || ['missing', 'drift', 'script_outdated', 'route_absent'].indexOf(st) < 0) {\n      // 7.0.34", "a hooks problem plus an offer", ["server/web-control/question-wait-offer-web.test.ts"]],
  ["web-not-now-not-kept", "server/web-control/app.js", "localStorage.setItem(SX_OFFER_HIDE_KEY, '1')", "void SX_OFFER_HIDE_KEY", "Not now puts the offer away in this browser", ["server/web-control/question-wait-offer-web.test.ts"]],
  ["web-not-now-ignored", "server/web-control/app.js", "SX.hooksOffer && !SX.offerPutAway && !offerHidden()", "SX.hooksOffer", "Not now puts the offer away in this browser", ["server/web-control/question-wait-offer-web.test.ts"]],
  ["web-blocked-store-hides", "server/web-control/app.js", "localStorage.getItem(SX_OFFER_HIDE_KEY) === '1'; } catch (_e) { return false; }", "localStorage.getItem(SX_OFFER_HIDE_KEY) === '1'; } catch (_e) { return true; }", "a store that cannot be read or written", ["server/web-control/question-wait-offer-web.test.ts"]],
]
const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const chosen = names.length ? mutations.filter(([name]) => names.includes(name)) : mutations
if (names.length && chosen.length !== names.length) throw new Error(`Unknown mutation name in: ${args.join(' ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'question-hold-default-mutations-'))
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
    if (!killer) { survivors.push(`${name}: killed, but not by "${killerName}" (${killers.join(' | ')})`); console.log(`${name} KILLED BY THE WRONG TEST: ${killers.join(' | ')}`); continue }
    killed++
    console.log(`${name} KILLED by ${killer}`)
  }
  console.log(`${killed} of ${chosen.length} question-hold-default mutations killed`)
  if (survivors.length) { console.log('NOT KILLED:\n  ' + survivors.join('\n  ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
