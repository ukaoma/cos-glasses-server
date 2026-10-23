#!/usr/bin/env node
// 6.87.0 mutation gate: the per-chunk level (level 0 to 1, Silero speech seconds) on the active-session record for COS
// Control's level strip, its bound, its restore after a restart, and the capability that advertises it. Mutations run
// only in a disposable copy of the checkout; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/live-meeting-6870-mutation-gate.mjs [--list] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LIB_T = ['server/lib/chunk-levels.test.ts']
const ROUTE_T = ['server/routes/transcribe-stream-chunk-levels.test.ts']
const CAP_T = ['server/routes/health-live-meeting.test.ts', 'server/routes/transcribe-stream-provisional.test.ts']
const ALL = [...LIB_T, ...ROUTE_T, ...CAP_T]
const LIB = 'server/lib/chunk-levels.ts', STREAM = 'server/routes/transcribe-stream.ts', PROV = 'server/lib/live-provisional.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── The stream: every chunk leaves its level, persisted, restored ──
  m('stream-records-level', STREAM, ['  session.chunkLevels = withChunkLevel(session.chunkLevels, chunkLevel(chunkIndex, rms, quiet.speechSec))\n', ''], ROUTE_T),
  m('stream-level-from-rms', STREAM, ['chunkLevel(chunkIndex, rms, quiet.speechSec)', 'chunkLevel(chunkIndex, 32768, quiet.speechSec)'], ROUTE_T),
  m('stream-level-speech', STREAM, ['chunkLevel(chunkIndex, rms, quiet.speechSec)', 'chunkLevel(chunkIndex, rms, null)'], ROUTE_T),
  m('persist-writes-levels', STREAM, ['      chunkLevels: session.chunkLevels ?? [],\n', ''], ROUTE_T),
  m('recovery-restores-levels', STREAM, ['              chunkLevels: restoreChunkLevels(data.chunkLevels),\n', ''], ROUTE_T),
  m('recovery-validates-levels', STREAM, ['restoreChunkLevels(data.chunkLevels)', 'data.chunkLevels'], ROUTE_T),
  // ── The lib: scale, rounding, order, replacement, bound, restore validation ──
  m('level-non-finite-zero', LIB, ['  if (!Number.isFinite(rms) || rms <= 0) return 0\n', ''], LIB_T),
  m('level-clamped', LIB, ['Math.min(1, Math.max(0, level))', 'level'], LIB_T),
  m('level-floor', LIB, ['export const LEVEL_FLOOR_DBFS = -60', 'export const LEVEL_FLOOR_DBFS = -90'], LIB_T),
  m('level-ceiling', LIB, ['export const LEVEL_CEILING_DBFS = -10', 'export const LEVEL_CEILING_DBFS = 0'], LIB_T),
  m('level-rounded', LIB, ['Math.round(Math.min(1, Math.max(0, level)) * 1000) / 1000', 'Math.min(1, Math.max(0, level))'], LIB_T),
  m('speech-null-kept', LIB, ['const speech = speechSec !== null && Number.isFinite(speechSec) ? Math.round(Math.max(0, speechSec) * 100) / 100 : null', 'const speech = Math.round(Math.max(0, speechSec ?? 0) * 100) / 100'], LIB_T),
  m('speech-non-negative', LIB, ['Math.round(Math.max(0, speechSec) * 100) / 100', 'Math.round(speechSec * 100) / 100'], LIB_T),
  m('replace-same-index', LIB, ['  const next = (levels ?? []).filter(l => l.i !== entry.i)\n', '  const next = [...(levels ?? [])]\n'], LIB_T),
  m('index-order', LIB, ['  next.sort((a, b) => a.i - b.i)\n', ''], LIB_T),
  m('bound-applied', LIB, ['next.length > CHUNK_LEVELS_LIMIT ? next.slice', 'false ? next.slice'], LIB_T),
  m('bound-keeps-newest', LIB, ['next.slice(next.length - CHUNK_LEVELS_LIMIT)', 'next.slice(0, CHUNK_LEVELS_LIMIT)'], LIB_T),
  m('bound-inclusive', LIB, ['next.length > CHUNK_LEVELS_LIMIT ?', 'next.length >= CHUNK_LEVELS_LIMIT - 1 ?'], LIB_T),
  m('restore-array-only', LIB, ['  if (!Array.isArray(value)) return []\n', ''], LIB_T),
  m('restore-object-only', LIB, ["    if (!raw || typeof raw !== 'object') continue\n", ''], LIB_T),
  m('restore-index-checked', LIB, ['    if (!Number.isInteger(i) || (i as number) < 0) continue\n', ''], LIB_T),
  m('restore-level-range', LIB, ["    if (typeof level !== 'number' || !Number.isFinite(level) || level < 0 || level > 1) continue\n", ''], LIB_T),
  m('restore-speech-checked', LIB, ["    if (speechSec !== null && (typeof speechSec !== 'number' || !Number.isFinite(speechSec) || speechSec < 0)) continue\n", ''], LIB_T),
  m('restore-bounded', LIB, ['    levels = withChunkLevel(levels, { i: i as number, level, speechSec: speechSec as number | null })', '    levels.push({ i: i as number, level, speechSec: speechSec as number | null })'], LIB_T),
  // ── The capability ──
  m('capability-chunk-levels', PROV, ['ttlMs: LIVE_PROVISIONAL_LIMITS.ttlMs }, chunkLevels: true }', 'ttlMs: LIVE_PROVISIONAL_LIMITS.ttlMs } }'], CAP_T),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')

const scratch = mkdtempSync(join(tmpdir(), 'live-meeting-6870-mutations-'))
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
  console.log(`${killed} of ${selected.length} live meeting 6.87.0 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
