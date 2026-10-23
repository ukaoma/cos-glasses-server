#!/usr/bin/env node
// 6.88.0 mutation gate: transfer integrity against the phone's final index, and the origin-wipe recovery save that
// waits for chunks a phone window still holds (lib/transfer-integrity.ts, wired in routes/meeting.ts performSave).
// Engine copied unchanged from live-meeting-6870-mutation-gate.mjs. Mutations run only in a disposable copy of the
// checkout; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/integrity-6880-mutation-gate.mjs [--list] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LIB_T = ['server/lib/transfer-integrity.test.ts']
const ROUTE_T = ['server/routes/meeting-save-integrity.test.ts']
const ALL = [...LIB_T, ...ROUTE_T]
const LIB = 'server/lib/transfer-integrity.ts', MT = 'server/routes/meeting.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── The lib ──
  m('final-never-counted', LIB, ['  if (!report || phoneFinal === null || phoneFinal <= report.maxIndex) return report\n', '  return report\n'], LIB_T),
  m('tail-off-by-one', LIB, ['  for (let index = report.maxIndex + 1; index <= final; index++) missingIndices.push(index)', '  for (let index = report.maxIndex + 1; index < final; index++) missingIndices.push(index)'], LIB_T),
  m('expected-unchanged', LIB, ['  const expected = final + 1\n', '  const expected = report.expected\n'], LIB_T),
  m('cap-removed', LIB, ['  const final = Math.min(phoneFinal, Math.max(report.maxIndex, 0) + PHONE_FINAL_INDEX_MAX_AHEAD)', '  const final = phoneFinal'], LIB_T),
  m('parse-accepts-anything', LIB, ["  return typeof value === 'number' && Number.isInteger(value) && value >= -1 && value <= PHONE_FINAL_INDEX_LIMIT ? value : null", '  return Number(value)'], LIB_T),
  m('final-min', LIB, ['  return known.length > 0 ? Math.max(...known) : null', '  return known.length > 0 ? Math.min(...known) : null'], LIB_T),
  m('outstanding-counts-past-final', LIB, ['  return counted.missingIndices.filter(index => index <= phoneFinal).length', '  return counted.missingIndices.length'], LIB_T),
  // ── The route ──
  m('route-integrity-unchanged', MT, ['      const integrity = withPhoneFinalIndex(sessions.getIntegrity(sessionId), phoneFinal)', '      const integrity = sessions.getIntegrity(sessionId)'], ROUTE_T),
  m('route-stop-intent-ignored', MT, ['phoneFinalChunkIndex(stopIntents.get(sessionId)?.finalChunkIndex, parsePhoneFinalChunkIndex(body?.finalChunkIndex))', 'phoneFinalChunkIndex(parsePhoneFinalChunkIndex(body?.finalChunkIndex))'], ROUTE_T),
  m('route-body-final-ignored', MT, ['phoneFinalChunkIndex(stopIntents.get(sessionId)?.finalChunkIndex, parsePhoneFinalChunkIndex(body?.finalChunkIndex))', 'phoneFinalChunkIndex(stopIntents.get(sessionId)?.finalChunkIndex)'], ROUTE_T),
  m('route-body-final-unparsed', MT, ['parsePhoneFinalChunkIndex(body?.finalChunkIndex))', 'body?.finalChunkIndex as number)'], ROUTE_T),
  m('route-guard-removed', MT, ["      if (body?.recovery === 'origin_wipe' && body?.acceptMissing !== true) {", '      if (false) {'], ROUTE_T),
  m('route-guard-every-save', MT, ["      if (body?.recovery === 'origin_wipe' && body?.acceptMissing !== true) {", '      if (body?.acceptMissing !== true) {'], ROUTE_T),
  m('route-accept-missing-ignored', MT, ["      if (body?.recovery === 'origin_wipe' && body?.acceptMissing !== true) {", "      if (body?.recovery === 'origin_wipe') {"], ROUTE_T),
  m('route-refusal-saves-anyway', MT, ["            finalChunkIndex: phoneFinal,\n          })\n          return null\n", "            finalChunkIndex: phoneFinal,\n          })\n"], ROUTE_T),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')

const scratch = mkdtempSync(join(tmpdir(), 'integrity-6880-mutations-'))
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
    const killers = [...new Set([...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(x => x[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { console.log(`${name} SURVIVED or harness failed\n${output.slice(-3000)}`); process.exitCode = 1; continue }
    killed += 1
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${killed} of ${selected.length} transfer integrity 6.88.0 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
