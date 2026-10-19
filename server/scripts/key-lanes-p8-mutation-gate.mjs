#!/usr/bin/env node
// Key lanes K1 P8 mutation gate (plan v4 14.2 row P8): the notice catalog in server/lib/key-notices.ts.
// Seen-state, the re-arm fingerprint, blank glyphs, the lens line and status-row budgets, the field
// cutting that holds them for any input, the plan-limit offer, the estimate label and the house
// rules. Mutations run only in a disposable copy of the checkout; the live checkout is never
// rewritten. Same harness as key-lanes-p1-mutation-gate.mjs.
//
// What it proves, in order:
//   0. The target suite is GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/key-lanes-p8-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const T = ['server/lib/key-notices.test.ts']
const ALL = [...T]
const N = 'server/lib/key-notices.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Seen-state: first-time long form vs compact label ──
  m('seen-state-ignored', N, ["  if (keyNoticeSeen(seen, fingerprint)) return { form: 'compact', fingerprint, label }", "  if (false) return { form: 'compact', fingerprint, label }"], T),
  m('seen-any-object', N, ["  return !!seen && typeof seen === 'object' && Object.prototype.hasOwnProperty.call(seen, fingerprint)", "  return !!seen && typeof seen === 'object'"], T),
  m('seen-inherited-name', N, ["  return !!seen && typeof seen === 'object' && Object.prototype.hasOwnProperty.call(seen, fingerprint)", "  return !!seen && typeof seen === 'object' && fingerprint in seen"], T),
  m('mark-mutates-input', N, ["  return { ...(seen ?? {}), [fingerprint]: at.toISOString() }", "  return Object.assign((seen ?? {}) as Record<string, string>, { [fingerprint]: at.toISOString() })"], T),
  // ── Re-arm: tools and egress (the variant) and the cap are part of the identity ──
  m('fingerprint-ignores-cap', N, ['  return `key-notice:v1:${ctx.profileId}:${ctx.keyKind}:${ctx.variant}:cap${cents}`', '  return `key-notice:v1:${ctx.profileId}:${ctx.keyKind}:${ctx.variant}`'], T),
  m('fingerprint-ignores-variant', N, ['  return `key-notice:v1:${ctx.profileId}:${ctx.keyKind}:${ctx.variant}:cap${cents}`', '  return `key-notice:v1:${ctx.profileId}:${ctx.keyKind}:cap${cents}`'], T),
  // ── Blank glyphs ──
  m('blank-glyph-label-mark', N, ["export const KEY_LABEL_MARK = '◈'", "export const KEY_LABEL_MARK = '⬡'"], T),
  m('blank-glyph-in-copy', N, ["  toolsPhone: 'No Mac tools. No meetings, no tasks.',", "  toolsPhone: 'No Mac tools. ✓ No meetings, no tasks.',"], T),
  m('blank-glyph-from-user-field', N, ['    else out += BLANK_TO_DRAWN[ch] ?? ch', '    else out += ch'], T),
  // ── Budgets: 6 body lines, one row per line, the 568 px status row ──
  m('over-budget-body-line', N, ["  meetingsToolMayRead: 'Meetings stay on the Mac unless a tool reads one.',", "  meetingsToolMayRead: 'Meetings stay on the Mac unless a tool reads one, and then its text goes too.',"], T),
  m('over-budget-chrome-footer', N, ["  footer: 'Tap: got it  Hold: settings',", "  footer: 'Tap: got it, never show this again  Hold: open the key settings in COS Control',"], T),
  m('over-budget-error-line', N, ["  keyed_session: () => 'This session ran on your key. Continue it from COS.',", "  keyed_session: () => 'This session ran on your key, so it can only be continued from inside COS itself.',"], T),
  m('field-cut-disabled', N, ['  if (fits(text)) return text\n', '  return text\n'], T),
  m('field-budget-ignores-rest', N, ['  return before + fitField(field, maxPx - restPx, maxColumns - restCols) + after', '  return before + fitField(field, maxPx, maxColumns) + after'], T),
  m('width-bound-drops-kern', N, ["    if (next !== undefined && (px === undefined || knownPx(next) === undefined || KERN_WIDENS.has(g))) width += 1", "    if (next !== undefined && (px === undefined || knownPx(next) === undefined)) width += 1"], T),
  // ── Plan-limit offer (D14), labels, house rules ──
  m('offer-without-profile', N, ['input.enabledKeyProfiles > 0 ? KEY_NOTICE_COPY.planLimitOffer', 'input.enabledKeyProfiles >= 0 ? KEY_NOTICE_COPY.planLimitOffer'], T),
  m('near-cap-threshold-moved', N, ['spent >= ctx.capUsd * KEY_NEAR_CAP_SHARE', 'spent > ctx.capUsd * KEY_NEAR_CAP_SHARE'], T),
  m('estimate-label-dropped', N, ["  const tilde = providerCopy(ctx.keyKind).estimate ? '~' : ''", "  const tilde = ''"], T),
  m('sign-in-copy', N, ["'Your {f} was rejected. Fix it in COS Control.'", "'Your {f} was rejected. Sign in again in COS Control.'"], T),
  m('em-dash-copy', N, ["'Key profile {f} is off. Pick a model.'", "'Key profile {f} is off — pick a model.'"], T),
  m('clock-from-format', N, ['  return { hour: get(\'hour\'), minute: get(\'minute\'), dayPeriod: get(\'dayPeriod\').toUpperCase() }', "  const [hm = '', dp = ''] = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).format(at).split(' ')\n  const [h = '', mi = ''] = hm.split(':')\n  return { hour: h, minute: mi, dayPeriod: dp }"], T),
  // ── Zero impact: pure module ──
  m('import-side-effect', N, ["import { BREAKER_LIMITS } from './key-relay-contract.js'\n", "import { BREAKER_LIMITS } from './key-relay-contract.js'\nimport { mkdirSync } from 'node:fs'\nmkdirSync(String(process.env.COS_DATA_DIR) + '/key-notices-probe', { recursive: true })\n"], T),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length && !args.includes('--check') ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && !args.includes('--check') && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')
// --check: every target matches exactly once and changes its file. Runs no tests.
if (args.includes('--check')) {
  let bad = 0
  for (const { name, file, edits } of mutations) {
    let text = readFileSync(join(root, file), 'utf8')
    const original = text
    for (const [find, replacement] of edits) {
      const n = text.split(find).length - 1
      if (n !== 1) { console.log(`${name}: matches ${n} times in ${file}: ${find.slice(0, 90)}`); bad++ }
      else text = text.replace(find, () => replacement)
    }
    if (text === original) { console.log(`${name}: no change`); bad++ }
  }
  console.log(`${mutations.length - bad} of ${mutations.length} targets match exactly once`)
  process.exit(bad ? 1 : 0)
}

const scratch = mkdtempSync(join(tmpdir(), 'key-lanes-p8-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  for (const dir of ['shared', 'work-task-runtime', 'bin', 'docs', 'memory-runtime']) cpSync(join(root, dir), join(scratch, dir), { recursive: true })
  for (const file of ['vitest.config.ts', 'package.json', 'managed-runtime-contract.json']) cpSync(join(root, file), join(scratch, file))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: process.env.TMPDIR, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json') },
    encoding: 'utf8', timeout: 300000,
  })
  const baseline = run(ALL)
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  const totals = /Tests\s+(\d+) passed/.exec(baseline.stdout)
  console.log(`baseline PASS (${totals ? totals[1] : '?'} tests in ${ALL.length} files)`)
  let killed = 0
  for (const { name, file, edits, tests } of selected) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    let mutated = original
    for (const [find, replacement] of edits) {
      if (mutated.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}: ${find.slice(0, 80)}`)
      mutated = mutated.replace(find, () => replacement)
    }
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    let result
    try { result = run(tests) } finally { writeFileSync(target, original) }
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    const output = result.stdout + '\n' + result.stderr
    const killers = [...new Set([...output.matchAll(/FAIL\s+((?:server|shared)\/\S+\.test\.ts > [^\n]+)/g)].map(x => x[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { console.log(`${name} SURVIVED or harness failed\n${output.slice(-3000)}`); process.exitCode = 1; continue }
    killed += 1
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${killed} of ${selected.length} key lanes P8 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
