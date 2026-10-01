#!/usr/bin/env node
// 6.60.0 away hold mutation gate. Mutations run only in a disposable copy of server/, shared/
// and bin/; the live checkout is never rewritten. The unmutated suites must pass first (a gate
// over a red suite proves nothing), each target must match exactly once, and each mutant must
// fail the NAMED test written for it (a transform or compile error fails the file, not a named
// test, so it never counts as a kill).
//
// Covers what the 6.60.0 brief names: the away extension, the desk-return handover, the
// installed-timeout clamp (the earlier 130 s hook), no_client while away, and the fallback on
// an unreadable settings file; plus the hook script's wait, the prior-wait drift and
// waitingAtMac.
//
// Usage: node server/scripts/away-hold-mutation-gate.mjs [--list] [name...]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LIB = 'server/lib/permission-broker.ts'
const INSTALLER = 'server/lib/claude-hooks-installer.ts'
const SCRIPT = 'bin/hooks/cos-session-hook'
const BROKER_TESTS = ['server/lib/permission-broker.test.ts', 'server/routes/permission-broker.test.ts']
const INSTALLER_TESTS = ['server/lib/claude-hooks-installer.test.ts', 'server/lib/permission-broker.test.ts']
const SCRIPT_TESTS = ['server/lib/cos-session-hook.script.test.ts']

// [name, file, exact target, replacement, a substring of the test that must fail, tests]
const mutations = [
  // The away extension
  ['away-extension-dropped', LIB, '    const wanted = awayHoldMs > 0 ? Math.max(baseMs, awayHoldMs) : baseMs\n', '    const wanted = baseMs\n', 'the away extension: a request that starts while away is held to the away hold', BROKER_TESTS],
  ['away-deadline-not-the-hold', LIB, '    const deadlineAt = requestedAt + hold.holdMs\n', '    const deadlineAt = requestedAt + this.deps.timeoutMs()\n', 'the away extension: a request that starts while away is held to the away hold', BROKER_TESTS],
  ['away-default-not-600', LIB, 'export const AWAY_HOLD_DEFAULT_S = 600\n', 'export const AWAY_HOLD_DEFAULT_S = 300\n', 'COS_PERMISSION_BROKER_AWAY_HOLD_S: default 600', BROKER_TESTS],
  ['away-off-words', LIB, "  if (raw === '0' || raw === 'off' || raw === 'false') return 0\n  const parsed", "  if (raw === '0') return 0\n  const parsed", 'COS_PERMISSION_BROKER_AWAY_HOLD_S: default 600', BROKER_TESTS],
  ['away-not-clamped-to-600', LIB, '  return Math.round(Math.min(AWAY_HOLD_MAX_S, Math.max(AWAY_HOLD_MIN_S, seconds)) * 1000)', '  return Math.round(Math.max(AWAY_HOLD_MIN_S, seconds) * 1000)', 'COS_PERMISSION_BROKER_AWAY_HOLD_S: default 600', BROKER_TESTS],
  // The desk-return handover, and the desk at arrival
  ['desk-return-skipped-when-no-client', LIB, "      this.settleAll('no_client', item => !item.awayHold)\n      if (this.pendingCount() === 0) return\n", "      this.settleAll('no_client', item => !item.awayHold)\n      return\n", 'the desk-return handover: desk activity hands an away-held item to the Mac within one tick, with no client', BROKER_TESTS],
  ['desk-active-at-arrival-held', LIB, "    if (idle < this.deskIdleThreshold()) return this.noteFastPath('desk_active')", "    if (false) return this.noteFastPath('desk_active')", 'at the desk when it arrives', BROKER_TESTS],
  // The installed-timeout clamp: the earlier 130 s hook never held past its 125 s
  ['clamp-not-applied', LIB, '    return { holdMs: Math.min(wanted, ceilingS * 1000), awayHoldMs, installedHookTimeoutS, ceilingS }', '    return { holdMs: wanted, awayHoldMs, installedHookTimeoutS, ceilingS }', 'the installed-timeout clamp: an earlier hook (130 s, no stamp) is held at most 120 s', BROKER_TESTS],
  ['ceiling-ignores-installed', LIB, '  return Math.max(0, Math.min(installedHookTimeoutS, stamped) - HOOK_REPLY_MARGIN_S)', '  return Math.max(0, stamped - HOOK_REPLY_MARGIN_S)', "holdCeilingS: the installed timeout and this request's stamp", BROKER_TESTS],
  ['ceiling-trusts-missing-stamp', LIB, ' && hookWaitS > 0 ? hookWaitS : LEGACY_HOOK_WAIT_S\n', ' && hookWaitS > 0 ? hookWaitS : installedHookTimeoutS\n', 'the installed-timeout clamp: an earlier hook (130 s, no stamp) is held at most 120 s', BROKER_TESTS],
  ['ceiling-margin-5-reaches-curl', LIB, 'export const HOOK_REPLY_MARGIN_S = 10\n', 'export const HOOK_REPLY_MARGIN_S = 5\n', 'the installed-timeout clamp: an earlier hook (130 s, no stamp) is held at most 120 s', BROKER_TESTS],
  ['stamp-range-unchecked', LIB, ' && wait > 0 && wait <= HOOK_WAIT_STAMP_MAX_S ? wait : null', ' && wait > 0 ? wait : null', "reads the hook's wait stamp only as a whole number", BROKER_TESTS],
  ['installer-wait-130', INSTALLER, 'export const PERMISSION_HOOK_TIMEOUT_S = 630\n', 'export const PERMISSION_HOOK_TIMEOUT_S = 130\n', 'appends one canonical block per subscribed event', INSTALLER_TESTS],
  ['installer-no-wait-argument', INSTALLER, "  const command = hookCommand(scriptPath, sub.event, paths, sub.passTimeout ? sub.timeout : undefined)\n", '  const command = hookCommand(scriptPath, sub.event, paths)\n', 'appends one canonical block per subscribed event', INSTALLER_TESTS],
  // no_client while away
  ['no-client-gate-ignores-away', LIB, "    if (!clientLive && hold.awayHoldMs === 0) return this.noteFastPath('no_client')\n", "    if (!clientLive) return this.noteFastPath('no_client')\n", 'no_client while away: parked with no client polling', BROKER_TESTS],
  ['quiet-client-settles-away', LIB, "      this.settleAll('no_client', item => !item.awayHold)\n", "      this.settleAll('no_client')\n", 'no_client while away: parked with no client polling', BROKER_TESTS],
  ['away-flag-never-set', LIB, '    const awayHold = hold.awayHoldMs > 0\n', '    const awayHold = false\n', 'no_client while away: parked with no client polling', BROKER_TESTS],
  // The fallback on an unreadable settings file
  ['fallback-null-not-old-clamp', LIB, '  if (installedHookTimeoutS === null || !Number.isFinite(installedHookTimeoutS) || installedHookTimeoutS <= 0) return BROKER_TIMEOUT_MAX_S\n', '  if (installedHookTimeoutS === null) return AWAY_HOLD_MAX_S\n', 'an unreadable settings file falls back to the old clamp', BROKER_TESTS],
  ['fallback-throw-unguarded', LIB, '    try { value = this.deps.installedHookTimeoutS?.() ?? null } catch { value = null }\n', '    value = this.deps.installedHookTimeoutS?.() ?? null\n', 'an unreadable settings file falls back to the old clamp', BROKER_TESTS],
  ['fallback-junk-kept', LIB, "    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null\n", '    return value\n', 'an unreadable settings file falls back to the old clamp', BROKER_TESTS],
  ['installer-unreadable-reads-a-timeout', INSTALLER, 'priorWait: [], priorWaitOnly: false, permissionHookTimeoutS: null, tokenPresent }', 'priorWait: [], priorWaitOnly: false, permissionHookTimeoutS: 630, tokenPresent }', 'an unreadable or unparseable settings file reads no timeout', INSTALLER_TESTS],
  ['installer-timeout-any-type', INSTALLER, "      if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) return null\n", "      if (typeof timeout !== 'number') return null\n", 'reads our timeout only, the least of ours', INSTALLER_TESTS],
  ['installer-reads-foreign-timeout', INSTALLER, '      if (!hookIsOurs(h)) continue\n', '', 'reads our timeout only, the least of ours', INSTALLER_TESTS],
  // The prior wait: an update never turns cancel from the lens off
  ['prior-wait-not-halt-ready', INSTALLER, "  if (status.state === 'drift' && status.priorWaitOnly === true) {\n    return priorScript", "  if (false) {\n    return priorScript", 'an install from before 6.60.0 reads drift with priorWaitOnly, stays halt-ready', INSTALLER_TESTS],
  ['prior-wait-only-any-drift', INSTALLER, '\n    && events.drifted.every(event => events.priorWait.includes(event))', '', 'any other drift is not priorWaitOnly and not halt-ready', INSTALLER_TESTS],
  ['prior-wait-any-block', INSTALLER, '    if (prior && ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(prior)) priorWait.push(sub.event)', '    if (prior) priorWait.push(sub.event)', 'any other drift is not priorWaitOnly and not halt-ready', INSTALLER_TESTS],
  // The hook script's wait
  ['script-curl-not-from-wait', SCRIPT, '--max-time $((WAIT - 5))', '--max-time $((WAIT - 10))', 'curl gives up 5 s before the wait it was passed', SCRIPT_TESTS],
  ['script-no-stamp', SCRIPT, 'WAIT=$2; STAMP_WAIT=",\\"hookWaitS\\":$2"', "WAIT=$2; STAMP_WAIT=''", 'stamps the wait on the request as hookWaitS', SCRIPT_TESTS],
  ['script-leading-zero-taken', SCRIPT, "  case \"${2:-}\" in ''|0*|*[!0-9]*) ;; *)", "  case \"${2:-}\" in ''|*[!0-9]*) ;; *)", 'stamps the wait on the request as hookWaitS', SCRIPT_TESTS],
  // waitingAtMac
  ['waiting-at-mac-when-not-written', LIB, '      item.waitingAtMac = written && MAC_DIALOG_RESOLUTIONS.has(resolution)\n', '      item.waitingAtMac = MAC_DIALOG_RESOLUTIONS.has(resolution)\n', 'a hand-back whose {} could not be written', BROKER_TESTS],
  ['waiting-at-mac-never-clears', LIB, '        item.waitingAtMac = false\n        continue\n', '        continue\n', 'waitingAtMac clears when the session moves past the request', BROKER_TESTS],
  ['waiting-at-mac-ten-minutes', LIB, '      const keep = item.waitingAtMac ? MAC_WAIT_RETENTION_MS : SETTLED_RETENTION_MS\n', '      const keep = SETTLED_RETENTION_MS\n', 'the settled listing', BROKER_TESTS],
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const chosen = args.length ? mutations.filter(([name]) => args.includes(name)) : mutations
if (args.length && chosen.length !== args.length) throw new Error(`Unknown mutation name in: ${args.join(' ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'away-hold-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'bin'), join(scratch, 'bin'), { recursive: true })
  cpSync(join(root, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
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
  console.log(`${killed} of ${chosen.length} away-hold mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
