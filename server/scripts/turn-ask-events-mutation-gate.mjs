#!/usr/bin/env node
// X1 (candidate 3, S1 11:37): the turn-ask breadcrumbs (onTurnAskEvent in lib/turn-end-ask.ts). Same harness as
// answer-never-queued-mutation-gate.mjs: disposable copy, green baseline, each target matched exactly once, each mutant
// killed by the test named for it (WRONG KILLER fails), byte-for-byte restoration. `--check` stops after the check.
// Q1 13:36 (E5, E11): the replay flag coming down after boot, and the size-cap eviction's aged_out, are mutated too.
import { mkdtempSync, cpSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// [name, file, exact target, replacement, a substring of the test that must fail, tests]
const mutations = [
  ["asked-at-stop-missing", "server/lib/turn-end-ask.ts", "        this.emitAsked(current, env.ts)\n", "", "asked once at the stop", ["server/lib/turn-end-ask.test.ts"]],
  ["asked-late-wrapup-missing", "server/lib/turn-end-ask.ts", "      if (stoppedAlready) this.emitAsked(armed, stop!.at)\n", "", "a stop that came first", ["server/lib/turn-end-ask.test.ts"]],
  ["settled-reply-missing", "server/lib/turn-end-ask.ts", "        this.emitSettled(current, env.ts, 'answered', { by: turnAskAnswerSurface(p.prompt, child), prompt: p.prompt })\n", "", "asked once at the stop", ["server/lib/turn-end-ask.test.ts"]],
  ["answer-contract-kept", "server/lib/turn-end-ask.ts", "stripG2TurnFooter(prompt.replace(TURN_END_ANSWER_RE, '')).text", "stripG2TurnFooter(prompt).text", "asked once at the stop", ["server/lib/turn-end-ask.test.ts"]],
  ["answer-footer-kept", "server/lib/turn-end-ask.ts", "stripG2TurnFooter(prompt.replace(TURN_END_ANSWER_RE, '')).text", "prompt.replace(TURN_END_ANSWER_RE, '')", "asked once at the stop", ["server/lib/turn-end-ask.test.ts"]],
  ["choice-answer-kept", "server/lib/turn-end-ask.ts", "const answer = words !== null && state.capture.choices.includes(words) ? null : words", "const answer = words", "an answer that is one of the choices", ["server/lib/turn-end-ask.test.ts"]],
  ["unstopped-emits", "server/lib/turn-end-ask.ts", "if (state.stoppedAt === null || turnAskListeners.size === 0) return", "if (turnAskListeners.size === 0) return", "an ask that never stopped emits nothing", ["server/lib/turn-end-ask.test.ts"]],
  ["machine-moved-missing", "server/lib/turn-end-ask.ts", "        this.emitSettled(current, env.ts, 'moved_on')\n        return\n", "        return\n", "moved_on: a machine-only prompt", ["server/lib/turn-end-ask.test.ts"]],
  ["tool-moved-missing", "server/lib/turn-end-ask.ts", "        this.emitSettled(current, env.ts, 'moved_on')\n      }\n", "      }\n", "moved_on: a machine-only prompt", ["server/lib/turn-end-ask.test.ts"]],
  ["replaced-moved-missing", "server/lib/turn-end-ask.ts", "      if (current) this.emitSettled(current, env.ts, 'moved_on')\n", "", "moved_on: a machine-only prompt", ["server/lib/turn-end-ask.test.ts"]],
  ["reset-missing", "server/lib/turn-end-ask.ts", "; this.emitSettled(current, env.ts, 'session_ended') }", "}", "session_ended: a session reset", ["server/lib/turn-end-ask.test.ts"]],
  ["row-ended-missing", "server/lib/turn-end-ask.ts", "; this.emitSettled(state, this.deps.now(), 'session_ended') }", "}", "session_ended: a session reset", ["server/lib/turn-end-ask.test.ts"]],
  ["visible-age-missing", "server/lib/turn-end-ask.ts", "      this.emitSettled(state, now, 'aged_out')\n      return null\n", "      return null\n", "aged_out: read past 8 hours", ["server/lib/turn-end-ask.test.ts"]],
  ["prune-age-missing", "server/lib/turn-end-ask.ts", "; this.emitSettled(state, now, 'aged_out') }", "}", "aged_out: read past 8 hours", ["server/lib/turn-end-ask.test.ts"]],
  ["words-ignored", "server/lib/turn-end-ask.ts", "question: words ? state.capture.ask : null", "question: state.capture.ask", "words off (COS_WAITING_QUESTION_WORDS=0)", ["server/lib/turn-end-ask.test.ts"]],
  ["replay-answer-kept", "server/lib/turn-end-ask.ts", "const words = this.replaying || !this.deps.words() ? null : replyWords(reply.prompt)", "const words = !this.deps.words() ? null : replyWords(reply.prompt)", "during replay: replay true", ["server/lib/turn-end-ask.test.ts"]],
  ["replay-flag-ignored", "server/lib/turn-end-ask.ts", "replay: this.replaying,", "replay: false,", "during replay: replay true", ["server/lib/turn-end-ask.test.ts"]],
  ["runtime-replay-stuck", "server/lib/session-hooks-runtime.ts", "    if (tracker) tracker.replaying = false\n", "", "an ask replayed from the ledger at boot", ["server/lib/turn-end-ask.test.ts"]],
  ["size-cap-settle-missing", "server/lib/turn-end-ask.ts", "      this.emitSettled(oldest, now, 'aged_out')\n", "", "dropped for room", ["server/lib/turn-end-ask.test.ts"]],
  ["runtime-replay-unset", "server/lib/session-hooks-runtime.ts", "  if (tracker) tracker.replaying = true\n", "", "an ask replayed from the ledger at boot", ["server/lib/turn-end-ask.test.ts"]],
  ["listener-throw-escapes", "server/lib/turn-end-ask.ts", "    try { listener(e) } catch { /* a listener's failure never reaches the tracker */ }\n", "    listener(e)\n", "listeners run in order", ["server/lib/turn-end-ask.test.ts"]],
  ["unsubscribe-broken", "server/lib/turn-end-ask.ts", "  return () => { turnAskListeners.delete(listener) }", "  return () => {}", "listeners run in order", ["server/lib/turn-end-ask.test.ts"]],
  ["askkey-armedat-only", "server/lib/turn-end-ask.ts", "return `${state.sessionId}:${state.promptId ?? state.armedAt}`", "return `${state.sessionId}:${state.armedAt}`", "asked once at the stop", ["server/lib/turn-end-ask.test.ts"]]
]
const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const chosen = names.length ? mutations.filter(([name]) => names.includes(name)) : mutations
if (names.length && chosen.length !== names.length) throw new Error(`Unknown mutation name in: ${args.join(' ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'turn-ask-events-mutations-'))
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
    if (!killer) { survivors.push(`${name}: WRONG KILLER, expected "${killerName}", killed by: ${killers.join(' | ')}`); console.log(`${name} KILLED BY THE WRONG TEST: ${killers.join(' | ')}`); continue }
    killed++
    console.log(`${name} KILLED by ${killer}`)
  }
  console.log(`${killed} of ${chosen.length} turn-ask-events mutations killed`)
  if (survivors.length) { console.log('NOT KILLED:\n  ' + survivors.join('\n  ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
