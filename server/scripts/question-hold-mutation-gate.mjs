#!/usr/bin/env node
// New question-hold guards. Disposable source copy, green baseline, named assertion
// failures and byte-for-byte restoration; never mutates the release worktree.
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LIB = 'server/lib/permission-broker.ts'
const INSTALLER = 'server/lib/claude-hooks-installer.ts'
const SCRIPT = 'bin/hooks/cos-session-hook'
const LIVENESS = 'server/lib/client-liveness.ts'
const ROUTE = 'server/routes/permission-broker.ts'
const RUNTIME = 'server/lib/session-hooks-runtime.ts'
const BROKER_TESTS = ['server/lib/permission-broker.test.ts', 'server/routes/permission-broker.test.ts']
const INSTALLER_TESTS = ['server/lib/claude-hooks-installer.test.ts', 'server/lib/permission-broker.test.ts']
const SCRIPT_TESTS = ['server/lib/cos-session-hook.script.test.ts']
const RUNTIME_TESTS = ['server/lib/session-hooks-runtime.test.ts']

const EXTENSION = 'the away extension: a lens worn 10 minutes ago, none polling now'
const PRESENCE = 'a lens worn 10 minutes ago gives a hold; 30 minutes is held'
const UNWORN = 'a hold=1 lens polling every 10 s with no presence (nobody wearing it)'
const UNWORN_ROUTE = 'a 6.9.563 lens polling with no presenceAgeMs (nobody wearing it)'
const CEILING = 'holdCeilingS: the installed timeout and this request'
const BEFORE_INSTALL = 'before Install hooks (the ceiling at or below the 6.59.0 clamp) away semantics are off entirely'
const FORGOT = 'forgot vs moved past'
const AGE = 'presence age is the larger of the monotonic and wall ages'

// [name, file, exact target, replacement, a substring of the test that must fail, tests]
const mutations = [
  ["stamp-ignored", "server/lib/permission-broker.ts", "const askHold = isQuestion && facts.askHold === true && !background", "const askHold = false", "admits a connected hold client", ["server/lib/permission-broker-question-hold.test.ts"]],
  ["connected-poll-ignored", "server/lib/permission-broker.ts", "const connectedHoldClient = askHold && this.polledWithin(holdPollAt, now)", "const connectedHoldClient = false", "admits a connected hold client", ["server/lib/permission-broker-question-hold.test.ts"]],
  ["no-client-parked", "server/lib/permission-broker.ts", "if (askHold && !clientLive && !presence.recent) return", "if (false) return", "no connected client or recent presence", ["server/lib/permission-broker-question-hold.test.ts"]],
  ["desk-still-gates-question", "server/lib/permission-broker.ts", "if (!askHold && idle! < this.deskIdleThreshold())", "if (idle! < this.deskIdleThreshold())", "admits a connected hold client", ["server/lib/permission-broker-question-hold.test.ts"]],
  ["question-visible-at-desk", "server/lib/permission-broker.ts", "lensVisible: !askHold || (idle !== null && idle >= this.deskIdleThreshold())", "lensVisible: true", "admits a connected hold client", ["server/lib/permission-broker-question-hold.test.ts"]],
  ["quiet-clears-question", "server/lib/permission-broker.ts", "item => !item.askHold && (!item.awayHold || !presence.recent)", "item => (!item.awayHold || !presence.recent)", "admits a connected hold client", ["server/lib/permission-broker-question-hold.test.ts"]],
  ["latch-lost", "server/lib/permission-broker.ts", "item.lensVisible = true", "item.lensVisible = false", "admits a connected hold client", ["server/lib/permission-broker-question-hold.test.ts"]],
  ["child-clears-question", "server/lib/permission-broker.ts", "if (child || env.payload.agent_id) return", "if (false) return", "desk first, glasses first", ["server/lib/permission-broker-question-hold.test.ts"]],
  ["tool-id-correlation-lost", "server/lib/permission-broker.ts", "if (item.toolUseId) return env.payload.tool_use_id === item.toolUseId", "if (item.toolUseId) return true", "matches one of two parallel questions", ["server/lib/permission-broker-question-hold.test.ts"]],
  ["interrupt-left-held", "server/lib/permission-broker.ts", "(item.askHold && env.event === 'Interrupt')", "false", "clears pending stamped questions", ["server/lib/permission-broker-question-hold.test.ts"]],
  ["unknown-desk-clears-question", "server/lib/permission-broker.ts", "if (this.deskUnreadableStreak >= 2) this.settleAll('handed_to_desk', item => !item.askHold)", "if (this.deskUnreadableStreak >= 2) this.settleAll('handed_to_desk')", "unreadable desk hides", ["server/lib/permission-broker-question-hold.test.ts"]],
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const chosen = args.length ? mutations.filter(([name]) => args.includes(name)) : mutations
if (args.length && chosen.length !== args.length) throw new Error(`Unknown mutation name in: ${args.join(' ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'question-hold-mutations-'))
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
  console.log(`${killed} of ${chosen.length} question-hold mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
