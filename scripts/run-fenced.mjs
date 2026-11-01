#!/usr/bin/env node
// Opt-in fenced test modes. `npm test` is untouched (serial, one worker, shared data home).
//
//   npm run test:fenced-serial     every file, --maxWorkers=1, COS_TEST_FENCE=1 (per-fork scratch area)
//   npm run test:fenced-parallel   TWO vitest invocations, both COS_TEST_FENCE=1:
//                                    1. the parallel set (all files not in test-support/serial-set.txt)
//                                       at --maxWorkers=2 (COS_FENCED_WORKERS overrides, a machine-cap decision)
//                                    2. the serial set at --maxWorkers=1
//
// Two invocations, not one run with projects: in vitest 3.2.7 maxWorkers, fileParallelism and shard are
// NonProjectOptions, and a per-project singleFork would give up per-file process isolation.
//
// Flags (before any `--`): --json-out <prefix> also writes JSON reports (<prefix>.json for serial,
// <prefix>.parallel.json and <prefix>.serial.json for parallel), which qualify-parallel.mjs reads.
// Everything after `--` goes to vitest unchanged.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitSets } from './serial-set.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const VITEST = resolve(ROOT, 'node_modules/.bin/vitest')

const argv = process.argv.slice(2)
const mode = argv.shift()
const dashdash = argv.indexOf('--')
const extra = dashdash >= 0 ? argv.splice(dashdash).slice(1) : []
const jsonAt = argv.indexOf('--json-out')
const jsonOut = jsonAt >= 0 ? resolve(argv[jsonAt + 1]) : null
const workers = Number(process.env.COS_FENCED_WORKERS || 2)

if (mode !== 'serial' && mode !== 'parallel') {
  console.error('usage: run-fenced.mjs serial|parallel [--json-out <prefix>] [-- vitest args]')
  process.exit(2)
}
if (!Number.isInteger(workers) || workers < 1) {
  console.error(`COS_FENCED_WORKERS must be a positive integer, got ${process.env.COS_FENCED_WORKERS}`)
  process.exit(2)
}

function invocation(label, maxWorkers, files, jsonPath) {
  const args = ['run', `--maxWorkers=${maxWorkers}`]
  if (jsonPath) args.push('--reporter=default', '--reporter=json', `--outputFile.json=${jsonPath}`)
  args.push(...extra, ...files)
  console.log(`\n== fenced ${label}: maxWorkers=${maxWorkers}, ${files.length || 'all'} file(s)${jsonPath ? `, json ${jsonPath}` : ''}`)
  const started = Date.now()
  const result = spawnSync(VITEST, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, COS_TEST_FENCE: '1' } })
  const seconds = (Date.now() - started) / 1000
  console.log(`== fenced ${label}: exit ${result.status ?? result.signal}, ${seconds.toFixed(1)}s wall`)
  return { label, status: result.status ?? 1, seconds }
}

const runs = []
if (mode === 'serial') {
  runs.push(invocation('serial', 1, [], jsonOut && `${jsonOut}.json`))
} else {
  const check = spawnSync(process.execPath, ['scripts/serial-set.mjs', '--check'], { cwd: ROOT, stdio: 'inherit' })
  if (check.status !== 0) process.exit(1)
  const { parallel, serial } = splitSets()
  runs.push(invocation('parallel-set', workers, parallel, jsonOut && `${jsonOut}.parallel.json`))
  runs.push(invocation('serial-set', 1, serial, jsonOut && `${jsonOut}.serial.json`))
}
const total = runs.reduce((sum, r) => sum + r.seconds, 0)
console.log(`\nfenced ${mode}: ${runs.map(r => `${r.label} exit ${r.status} ${r.seconds.toFixed(1)}s`).join(', ')}; total ${total.toFixed(1)}s`)
process.exit(runs.every(r => r.status === 0) ? 0 : 1)
