#!/usr/bin/env node
// X1 (2026-11-09): the full hold's guards. Same harness as question-hold-mutation-gate.mjs: disposable
// source copy, green baseline over every named suite, each target matched exactly once, each mutant
// killed by the test named for it, and byte-for-byte restoration. Never mutates the worktree.
// `--check` stops after the exact-once check (no tests run).
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// [name, file, exact target, replacement, a substring of the test that must fail, tests]
const mutations = [
  ["question-default-on", "server/lib/full-hold.ts", "readSwitch(env.COS_QUESTION_FULL_HOLD, false)", "readSwitch(env.COS_QUESTION_FULL_HOLD, true)", "default OFF", ["server/lib/full-hold.test.ts"]],
  ["approval-default-on", "server/lib/full-hold.ts", "readSwitch(env.COS_APPROVAL_FULL_HOLD, false)", "readSwitch(env.COS_APPROVAL_FULL_HOLD, true)", "default OFF", ["server/lib/full-hold.test.ts"]],
  ["words-default-on", "server/lib/full-hold.ts", "readSwitch(env.COS_WAITING_QUESTION_WORDS, false)", "readSwitch(env.COS_WAITING_QUESTION_WORDS, true)", "default OFF", ["server/lib/full-hold.test.ts"]],
  ["engine-gate-open", "server/lib/full-hold.ts", "return version !== null && versionAtLeast(version, floor)", "return true", "refuses older", ["server/lib/full-hold.test.ts"]],
  ["cli-floor-lowered", "server/lib/full-hold.ts", "cli: Object.freeze([2, 1, 321])", "cli: Object.freeze([2, 1, 320])", "refuses older", ["server/lib/full-hold.test.ts"]],
  ["desktop-floor-lowered", "server/lib/full-hold.ts", "'claude-desktop': Object.freeze([2, 1, 317])", "'claude-desktop': Object.freeze([2, 1, 316])", "refuses older", ["server/lib/full-hold.test.ts"]],
  ["engine-own-property", "server/lib/full-hold.ts", "if (!Object.prototype.hasOwnProperty.call(FULL_HOLD_ENGINE_FLOORS, engine.entrypoint)) return false", "", "refuses older", ["server/lib/full-hold.test.ts"]],
  ["non-question-matcher-all", "server/lib/full-hold.ts", "export const NON_QUESTION_MATCHER = '^(?!AskUserQuestion$).*'", "export const NON_QUESTION_MATCHER = '.*'", "selects every tool but AskUserQuestion", ["server/lib/claude-hooks-installer-full-hold.test.ts"]],
  ["switch-ignored-differential", "server/lib/permission-broker.ts", "if (isQuestion ? !on.questions : !on.approvals) return false", "", "admission and tick cases", ["server/lib/permission-broker-full-hold-off.test.ts"]],
  ["switch-ignored", "server/lib/permission-broker.ts", "if (isQuestion ? !on.questions : !on.approvals) return false", "", "with the question switch off it is exactly today", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["background-or-codex-held", "server/lib/permission-broker.ts", "if (background || facts.provider === 'codex') return false", "", "unstamped question (hook-ask-hold 0)", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["unstamped-question-held", "server/lib/permission-broker.ts", "if (isQuestion && !askHold) return false", "", "unstamped question (hook-ask-hold 0)", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["no-wait-stamp-held", "server/lib/permission-broker.ts", "if (facts.hookWaitS === null) return false", "", "unstamped question (hook-ask-hold 0)", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["engine-gate-skipped", "server/lib/permission-broker.ts", "return engineProvenForFullHold(engine)", "return true", "no registry record", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["full-question-needs-client", "server/lib/permission-broker.ts", "if (!full && askHold && !deviceAdmits && !webOnly)", "if (askHold && !deviceAdmits && !webOnly)", "holds a question with no client", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["full-approval-needs-client", "server/lib/permission-broker.ts", "if (!full && !clientLive && !away)", "if (!clientLive && !away)", "an approval stays held with no client", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["full-deadline-is-away-hold", "server/lib/permission-broker.ts", "const hold = full ? this.fullHoldMs(facts.hookWaitS, isQuestion ? 'question' : 'approval') : this.holdMs(facts.hookWaitS, away)", "const hold = this.holdMs(facts.hookWaitS, away)", "holds a question with no client", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["full-deadline-wrong-kind", "server/lib/permission-broker.ts", "this.fullHoldMs(facts.hookWaitS, isQuestion ? 'question' : 'approval')", "this.fullHoldMs(facts.hookWaitS, 'question')", "times a question from the question block", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["kind-timeout-ignored", "server/lib/permission-broker.ts", "kind !== undefined && this.deps.installedHookTimeoutForKindS ?", "false ?", "times a question from the question block", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["web-touch-makes-web-only", "server/lib/permission-broker.ts", "const webOnly = !full && !deviceAdmits", "const webOnly = !deviceAdmits", "a recent web touch never makes a full-hold question web-only", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["kill-switch-dead", "server/lib/permission-broker.ts", "this.settleAll('handed_to_desk', item => item.fullHold && (item.kind === 'question' ? !on.questions : !on.approvals))", "this.settleAll('handed_to_desk', () => false)", "kill switch", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["kill-switch-wrong-kind", "server/lib/permission-broker.ts", "item.fullHold && (item.kind === 'question' ? !on.questions : !on.approvals)", "item.fullHold && !on.questions", "kill switch", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["no-client-clears-full", "server/lib/permission-broker.ts", "this.settleAll('no_client', item => !item.fullHold && (item.webOnly", "this.settleAll('no_client', item => (item.webOnly", "an approval stays held with no client", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["row-end-keeps-approval", "server/lib/permission-broker.ts", "if ((item.askHold || item.fullHold) && item.state === 'pending') {", "if (item.askHold && item.state === 'pending') {", "a session row that ends retracts a held approval", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["web-touch-skipped", "server/lib/permission-broker.ts", "if (by === 'web' && this.anyFullHoldOn() && !validWebTouch(input.presenceAgeMs)) {", "if (false) {", "needs a fresh touch", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["web-touch-even-when-off", "server/lib/permission-broker.ts", "if (by === 'web' && this.anyFullHoldOn() && !validWebTouch(input.presenceAgeMs)) {", "if (by === 'web' && !validWebTouch(input.presenceAgeMs)) {", "web door is exactly today", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["web-touch-window-open", "server/lib/permission-broker.ts", "value >= 0 && value <= WEB_ANSWER_TOUCH_MAX_MS", "value >= 0", "needs a fresh touch", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["web-touch-fractional", "server/lib/permission-broker.ts", "typeof value === 'number' && Number.isInteger(value)", "typeof value === 'number' && Number.isFinite(value)", "needs a fresh touch", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["confirm-skipped", "server/lib/permission-broker.ts", "if (by === 'web' && this.anyFullHoldOn()) {\n        const refused", "if (false) {\n        const refused", "needs a confirm id this server issued", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["confirm-decision-unbound", "server/lib/permission-broker.ts", "if (found.itemId !== itemId || found.decision !== decision) return 'confirm_invalid'", "if (found.itemId !== itemId) return 'confirm_invalid'", "needs a confirm id this server issued", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["confirm-item-unbound", "server/lib/permission-broker.ts", "if (found.itemId !== itemId || found.decision !== decision) return 'confirm_invalid'", "if (found.decision !== decision) return 'confirm_invalid'", "belongs to one item", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["confirm-reusable", "server/lib/permission-broker.ts", "    this.confirms.delete(raw)\n    return null", "    return null", "single use", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["confirm-never-expires", "server/lib/permission-broker.ts", "if (this.deps.now() >= found.expiresAt) {", "if (false) {", "expires", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["confirm-any-surface", "server/lib/permission-broker.ts", "if (by !== 'web') return { status: 400, body: { error: 'invalid_confirm', reason: 'surface' } }", "", "the confirm route", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["confirm-no-touch", "server/lib/permission-broker.ts", "    if (!validWebTouch(input.presenceAgeMs)) return { status: 403, body: { error: 'web_touch_required' } }", "", "the confirm route", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["confirm-for-questions", "server/lib/permission-broker.ts", "if (item.kind !== 'approval') return { status: 400, body: { error: 'invalid_confirm', reason: 'kind' } }", "", "the confirm route", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["waiting-always-on", "server/lib/permission-broker.ts", "return words || this.anyFullHoldOn()", "return true", "is empty with every switch off", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["waiting-words-ignored", "server/lib/permission-broker.ts", "return words || this.anyFullHoldOn()", "return this.anyFullHoldOn()", "COS_WAITING_QUESTION_WORDS alone", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["waiting-words-kept", "server/lib/permission-broker.ts", "      entry.questions = null\n", "", "walks at_mac, held, answered", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["waiting-failure-kept", "server/lib/permission-broker.ts", "if (env.event !== 'PostToolUse') { this.waiting.delete(entry.key); return }", "", "a failure, a denial", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["waiting-turn-kept", "server/lib/permission-broker.ts", "if (entry.sessionId === env.sessionId && entry.state === 'waiting' && env.ts >= entry.askedAt) this.waiting.delete(entry.key)", "", "a failure, a denial", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["waiting-compact-drops", "server/lib/permission-broker.ts", "(env.event === 'SessionStart' && p.source !== 'compact')) {\n      for", "env.event === 'SessionStart') {\n      for", "a failure, a denial", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["waiting-ignores-latch", "server/lib/permission-broker.ts", "item.state === 'pending' && item.lensVisible && now < item.deadlineAt", "item.state === 'pending' && now < item.deadlineAt", "behind the desk latch reads at_mac", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["waiting-tool-id-unmatched", "server/lib/permission-broker.ts", "if (item.toolUseId && entry.toolUseId) return item.toolUseId === entry.toolUseId", "if (item.toolUseId && entry.toolUseId) return true", "only the one with the held tool_use id", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["waiting-by-cos-always", "server/lib/permission-broker.ts", "if (item.state === 'answered' && item.answer && item.answer.clientAnswerId !== 'cos-cancel' && this.itemMatches(item, entry)) return true", "return true", "answered at the Mac reads answeredBy mac", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["waiting-by-cos-never", "server/lib/permission-broker.ts", "if (item.state === 'answered' && item.answer && item.answer.clientAnswerId !== 'cos-cancel' && this.itemMatches(item, entry)) return true", "", "walks at_mac, held, answered", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["waiting-unbounded", "server/lib/permission-broker.ts", "if (this.waiting.size > MAX_WAITING) {", "if (false) {", "is bounded", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["waiting-no-max-age", "server/lib/permission-broker.ts", "if (now - entry.askedAt > WAITING_MAX_AGE_MS) this.waiting.delete(entry.key)\n      else if", "if (false) this.waiting.delete(entry.key)\n      else if", "is bounded", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["waiting-answered-forever", "server/lib/permission-broker.ts", "else if (entry.state === 'answered' && entry.answeredAt !== null && now - entry.answeredAt > WAITING_ANSWERED_KEEP_MS)", "else if (false)", "walks at_mac, held, answered", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["waiting-row-end-kept", "server/lib/permission-broker.ts", "if (entry.sessionId === wanted || (wanted.length < 36 && entry.sessionId.startsWith(wanted))) this.waiting.delete(entry.key)", "", "a session row that ends drops its entries", ["server/lib/permission-broker-full-hold.test.ts"]],
  ["plan-split-when-off", "server/lib/claude-hooks-installer.ts", "if (!on.questions && !on.approvals) return { split: false", "if (false) return { split: false", "merge output is 97402b4", ["server/lib/claude-hooks-installer-full-hold.test.ts"]],
  ["plan-question-wait-always-full", "server/lib/claude-hooks-installer.ts", "questionWaitS: on.questions ? FULL_HOLD_HOOK_WAIT_S : PERMISSION_HOOK_TIMEOUT_S", "questionWaitS: FULL_HOLD_HOOK_WAIT_S", "writes AskUserQuestion at", ["server/lib/claude-hooks-installer-full-hold.test.ts"]],
  ["plan-other-wait-always-full", "server/lib/claude-hooks-installer.ts", "otherWaitS: on.approvals ? FULL_HOLD_HOOK_WAIT_S : PERMISSION_HOOK_TIMEOUT_S", "otherWaitS: FULL_HOLD_HOOK_WAIT_S", "writes AskUserQuestion at", ["server/lib/claude-hooks-installer-full-hold.test.ts"]],
  ["prior-unsplit-not-prior", "server/lib/claude-hooks-installer.ts", "if (plan.split) out.push([canonicalBlock(scriptPath, sub, paths)])", "", "unsplit install, then a switch on", ["server/lib/claude-hooks-installer-full-hold.test.ts"]],
  ["prior-split-not-prior", "server/lib/claude-hooks-installer.ts", "    out.push(splitPermissionBlocks(scriptPath, sub, paths, q, o))", "    void 0", "unsplit install, then a switch on", ["server/lib/claude-hooks-installer-full-hold.test.ts"]],
  ["matcher-selects-everything", "server/lib/claude-hooks-installer.ts", "try { return new RegExp(`^(?:${matcher})$`).test(toolName) } catch { return false }", "return true", "writes AskUserQuestion at", ["server/lib/claude-hooks-installer-full-hold.test.ts"]],
  ["kind-timeouts-always-reported", "server/lib/claude-hooks-installer.ts", "...(paths.plan?.split || permissionHookPlan().split || permissionHookTimeouts.question !== permissionHookTimeouts.approval ? { permissionHookTimeouts } : {})", "...({ permissionHookTimeouts })", "unsplit install, then a switch on", ["server/lib/claude-hooks-installer-full-hold.test.ts"]],
  ["question-target-lost", "server/lib/session-hook-events.ts", "i.description, firstQuestion]", "i.description]", "first question, clipped to 80", ["server/lib/session-hook-events-question.test.ts"]],
  ["question-target-first", "server/lib/session-hook-events.ts", "[i.command, i.file_path, i.path, i.url, i.pattern, i.query, i.prompt, i.description, firstQuestion]", "[firstQuestion, i.command, i.file_path, i.path, i.url, i.pattern, i.query, i.prompt, i.description]", "every earlier field still wins", ["server/lib/session-hook-events-question.test.ts"]],
  ["route-keys-when-off", "server/routes/permission-broker.ts", "...(deps.broker.extendedQuestionsView() ?", "...(true ?", "7.0.13's keys exactly", ["server/routes/permission-broker-full-hold.test.ts"]],
  ["route-confirm-door-forced-web", "server/routes/permission-broker.ts", "const result = deps.broker.confirm(String(req.params.id ?? ''), req.body, by)", "const result = deps.broker.confirm(String(req.params.id ?? ''), req.body, 'web')", "confirm (web door only)", ["server/routes/permission-broker-full-hold.test.ts"]],
  ["index-switches-hardwired", "server/index.ts", "  fullHold: () => fullHoldSwitches(process.env),", "  fullHold: () => ({ questions: true, approvals: true }),", "index.ts wires the switches", ["server/routes/permission-broker-full-hold.test.ts"]],
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const chosen = names.length ? mutations.filter(([name]) => names.includes(name)) : mutations
if (names.length && chosen.length !== names.length) throw new Error(`Unknown mutation name in: ${args.join(' ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'full-hold-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'bin'), join(scratch, 'bin'), { recursive: true })
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
    if (result.status === 0 || result.error || !killers.length) throw new Error(`Mutation survived or harness failed: ${name}\n${output.slice(-4000)}`)
    const killer = killers.find(line => line.includes(killerName))
    if (!killer) throw new Error(`Mutation ${name} was killed, but not by the test named for it ("${killerName}"): ${killers.join(' | ')}`)
    killed++
    console.log(`${name} KILLED by ${killer}`)
  }
  console.log(`${killed} of ${chosen.length} full-hold mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
