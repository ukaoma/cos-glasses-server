#!/usr/bin/env node
// Qualification harness for the opt-in fenced test modes. It never changes how a mode runs; it runs the
// mode, records what each test did, and checks that the run touched nothing outside its scratch area.
//
//   node scripts/qualify-parallel.mjs run <serial|fenced-serial|fenced-parallel> [--out <dir>]
//                                         [--control-seconds N] [--allow <path-substring>]...
//   node scripts/qualify-parallel.mjs diff <a.ids.json> <b.ids.json>
//
// Known flakes: test-support/known-flakes.txt lists test IDs that fail under machine load. Only this script
// reads it (`npm test` never does). A difference on a listed ID is printed as KNOWN-FLAKE, in full, and is
// not counted as a parity failure. Exit codes: 0 identical, 1 a real difference or failure, 3 only known
// flakes differ or failed.
//   node scripts/qualify-parallel.mjs snapshot --out <file>
//
// run:  1. snapshot live paths, wait --control-seconds (default 60), snapshot again. Whatever changed
//          in that idle window is the live server's own churn ("noisy") and is listed, not counted.
//       2. run the mode with the JSON reporter, timing the wall clock.
//       3. snapshot again. Any path that is new, removed or modified since step 1's second snapshot,
//          and not noisy, not a named live writer (LIVE_WRITERS), not --allow'ed and not the known TTS
//          ledger, is a test write and FAILS the run (exit 1). Every class is printed with its path.
//       4. write <out>/<mode>.ids.json (one status per test ID) and <out>/<mode>.summary.json.
// diff: test IDs and statuses of two runs must match EXACTLY. Every difference is listed, none is
//       tolerated, and nothing is "fixed" by loosening the comparison. Exit 1 on any difference.
//
// Live paths (names, sizes, mtimes; content hash for the small files that are cheap to hash):
//   ~/.cos-glasses/data (recursive) and the top level of ~/.cos-glasses,
//   /tmp/cos-*.json and /tmp/cos-speaker-training,
//   <checkout>/data and <checkout>/server/data.
// Known and allowed: server/data/openai-tts-budget.json. tts.test.ts and tts-policy.test.ts write it by
// design (the ledger resolves relative to the module and is deliberately not moved), so it is reported
// as "allowed" and never as a failure.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
export const KNOWN_FLAKES_FILE = join(ROOT, 'test-support', 'known-flakes.txt')

/** Map of test ID to reason. Lines: ID, TAB, reason; "#" lines are comments. */
export function readKnownFlakes(path = KNOWN_FLAKES_FILE) {
  const flakes = new Map()
  if (!existsSync(path)) return flakes
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    const [id, ...reason] = line.split('\t')
    flakes.set(id.trim(), reason.join('\t').trim())
  }
  return flakes
}

const KNOWN_ALLOWED = ['server/data/openai-tts-budget.json']
// Processes that write to a live path on their own, whatever the tests do. A change matching one is
// reported as "live" with its writer named, and does not fail the run. Anything else under a live
// path, and every change inside the checkout, is a test write and fails it. Found by the first run
// of the unfenced gate; extend only with evidence of who the writer is.
const LIVE_WRITERS = [
  ['.cos_qdrant_health.jsonl', 'qdrant health LaunchAgent (appends every minute)'],
  ['cos-session-activity-', 'Claude Code session hooks (PID-named, rewritten while a session is active)'],
  ['cos-pending-session-summary-', 'Claude Code session hooks'],
  ['home-data:data/hook-spool', 'live server session-hook spool'],
  ['session-hook-events.jsonl', 'live server session-hook log'],
  ['closed-transcript-sessions.json', 'live server'],
  ['home-data:data/work-reviews', 'live server work reviews'],
  ['home-top:cursor-cli', 'live server Cursor spawn dir'],
  ['home-top:data', 'live data home (parent directory mtime)'],
  ['home-data:data/training-audio', 'live server audio retention (age and 30-per-speaker cap prune)'],
  ['home-data:data/chunk-embeddings', 'live server chunk-embedding sweep (server.log: "[chunk-embeddings] Purged 1 expired session file(s), 110 retained")'],
  ['welcome-weather.json', 'live server index.ts weather refresh (no test imports index.ts)'],
]
const HASH_CONTENT_UNDER = 256 * 1024

function walk(dir, visit) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    visit(full, entry)
    if (entry.isDirectory()) walk(full, visit)
  }
}

function record(map, key, full) {
  try {
    const st = lstatSync(full)
    let digest = ''
    if (st.isFile() && st.size <= HASH_CONTENT_UNDER) digest = createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 16)
    map[key] = `${st.isDirectory() ? 'd' : 'f'} ${st.size} ${Math.round(st.mtimeMs)} ${digest}`
  } catch { /* vanished between readdir and lstat: the next snapshot will show it */ }
}

/** One map of "label:relative path" to "kind size mtime hash" over every live path. */
export function snapshot() {
  const map = {}
  const live = join(homedir(), '.cos-glasses')
  walk(join(live, 'data'), (full) => record(map, `home-data:${relative(live, full)}`, full))
  try { for (const name of readdirSync(live)) record(map, `home-top:${name}`, join(live, name)) } catch { /* no live home */ }
  try {
    for (const name of readdirSync('/tmp')) {
      if (/^cos-.*\.json$/.test(name)) record(map, `tmp-json:${name}`, join('/tmp', name))
    }
  } catch { /* no /tmp listing */ }
  // Fence scratch dirs a fenced run failed to remove (a late write recreates one after the file's
  // cleanup). Names only; they are reported, never counted as a live-path violation.
  try {
    for (const name of readdirSync('/tmp')) if (/^cos-v-[A-Za-z0-9]{6}$/.test(name)) record(map, `fence-leftover:${name}`, join('/tmp', name))
  } catch { /* no /tmp listing */ }
  walk('/tmp/cos-speaker-training', (full) => record(map, `tmp-training:${relative('/tmp', full)}`, full))
  for (const dir of ['data', 'server/data']) walk(join(ROOT, dir), (full) => record(map, `checkout:${relative(ROOT, full)}`, full))
  return map
}

export function diffSnapshots(before, after) {
  const changes = []
  for (const key of Object.keys(after)) {
    if (!(key in before)) changes.push({ key, kind: 'added', after: after[key] })
    else if (before[key] !== after[key]) changes.push({ key, kind: 'modified', before: before[key], after: after[key] })
  }
  for (const key of Object.keys(before)) if (!(key in after)) changes.push({ key, kind: 'removed', before: before[key] })
  return changes.sort((a, b) => a.key.localeCompare(b.key))
}

/** vitest JSON reporter output(s) to { tests: {id: status}, files: {...} }. IDs are "file :: full name", repeats get #n. */
export function extractIds(jsonPaths) {
  const tests = {}
  const files = {}
  for (const jsonPath of jsonPaths) {
    const report = JSON.parse(readFileSync(jsonPath, 'utf8'))
    for (const file of report.testResults) {
      const rel = relative(ROOT, file.name)
      const seen = new Map()
      for (const t of file.assertionResults) {
        const base = `${rel} :: ${t.fullName}`
        const n = (seen.get(base) ?? 0) + 1
        seen.set(base, n)
        tests[n === 1 ? base : `${base} #${n}`] = t.status
      }
      // A file that failed to load has no assertions; its own status is the only evidence it ran.
      if (file.assertionResults.length === 0) tests[`${rel} :: <file>`] = file.status
      files[rel] = { status: file.status, tests: file.assertionResults.length, durationMs: Math.round((file.endTime ?? 0) - (file.startTime ?? 0)) }
    }
  }
  return { tests, files }
}

export function diffIds(a, b, flakes = new Map()) {
  const onlyA = Object.keys(a.tests).filter(k => !(k in b.tests))
  const onlyB = Object.keys(b.tests).filter(k => !(k in a.tests))
  const differ = Object.keys(a.tests).filter(k => k in b.tests && a.tests[k] !== b.tests[k]).map(k => ({ id: k, a: a.tests[k], b: b.tests[k] }))
  // A known flake is moved aside, never dropped: it comes back in `flaky` with the reason.
  const flaky = []
  const keep = (id, entry) => (flakes.has(id) ? (flaky.push({ id, ...entry, reason: flakes.get(id) }), false) : true)
  return {
    onlyA: onlyA.filter(id => keep(id, { kind: 'only-a', a: a.tests[id] })),
    onlyB: onlyB.filter(id => keep(id, { kind: 'only-b', b: b.tests[id] })),
    differ: differ.filter(d => keep(d.id, { kind: 'differ', a: d.a, b: d.b })),
    flaky,
  }
}

/**
 * 0 clean; 3 only known flakes failed; 1 anything else: a real failure, a test write, a missing report,
 * or a non-zero exit with no failed test in the report (a crash is never a flake).
 */
export function exitCodeFor({ vitestStatus, clean, realFailures, flakeFailures }) {
  if (clean && vitestStatus === 0) return 0
  return clean && vitestStatus !== 0 && realFailures === 0 && flakeFailures > 0 ? 3 : 1
}

function countStatuses(tests) {
  const counts = {}
  for (const status of Object.values(tests)) counts[status] = (counts[status] ?? 0) + 1
  return counts
}

function arg(name, fallback) {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : fallback
}
function args(name) {
  const out = []
  process.argv.forEach((a, i) => { if (a === name) out.push(process.argv[i + 1]) })
  return out
}

function commandFor(mode, outDir) {
  if (mode === 'serial') return { cmd: 'npm', args: ['test', '--', '--reporter=default', '--reporter=json', `--outputFile.json=${join(outDir, 'serial.json')}`], json: [join(outDir, 'serial.json')] }
  if (mode === 'fenced-serial') return { cmd: process.execPath, args: ['scripts/run-fenced.mjs', 'serial', '--json-out', join(outDir, 'fenced-serial')], json: [join(outDir, 'fenced-serial.json')] }
  if (mode === 'fenced-parallel') return { cmd: process.execPath, args: ['scripts/run-fenced.mjs', 'parallel', '--json-out', join(outDir, 'fenced-parallel')], json: [join(outDir, 'fenced-parallel.parallel.json'), join(outDir, 'fenced-parallel.serial.json')] }
  throw new Error(`unknown mode "${mode}" (serial | fenced-serial | fenced-parallel)`)
}

function sleepSeconds(n) { if (n > 0) spawnSync('sleep', [String(n)]) }

function runMode() {
  const mode = process.argv[3]
  const outDir = resolve(arg('--out', join(ROOT, '.qualify-results')))
  const controlSeconds = Number(arg('--control-seconds', '60'))
  const allow = [...KNOWN_ALLOWED, ...args('--allow')]
  mkdirSync(outDir, { recursive: true })
  const { cmd, args: cmdArgs, json } = commandFor(mode, outDir)
  for (const p of json) if (existsSync(p)) throw new Error(`refusing to overwrite ${p}; use a fresh --out`)

  console.log(`qualify: snapshot, then ${controlSeconds}s idle control window`)
  const first = snapshot()
  sleepSeconds(controlSeconds)
  const before = snapshot()
  const noisy = new Set(diffSnapshots(first, before).map(c => c.key))

  console.log(`qualify: running ${mode}: ${cmd} ${cmdArgs.join(' ')}`)
  const started = Date.now()
  const result = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', env: process.env })
  const wallSeconds = (Date.now() - started) / 1000
  const after = snapshot()

  const changes = diffSnapshots(before, after)
  const writerOf = (key) => LIVE_WRITERS.find(([pattern]) => key.includes(pattern))?.[1]
  const classify = (c) => (c.key.startsWith('fence-leftover:') ? 'leftover' : allow.some(a => c.key.includes(a)) ? 'allowed' : noisy.has(c.key) ? 'noisy' : writerOf(c.key) ? 'live' : 'violation')
  const classified = changes.map(c => ({ ...c, class: classify(c), writer: writerOf(c.key) }))
  const violations = classified.filter(c => c.class === 'violation')

  const missingJson = json.filter(p => !existsSync(p))
  const ids = missingJson.length === 0 ? extractIds(json) : { tests: {}, files: {} }
  const summary = {
    mode, wallSeconds, exitCode: result.status, jsonMissing: missingJson,
    counts: countStatuses(ids.tests), tests: Object.keys(ids.tests).length, files: Object.keys(ids.files).length,
    livePathChanges: { violations: violations.length, allowed: classified.filter(c => c.class === 'allowed').length, live: classified.filter(c => c.class === 'live').length, leftover: classified.filter(c => c.class === 'leftover').length, noisy: classified.filter(c => c.class === 'noisy').length, detail: classified },
  }
  writeFileSync(join(outDir, `${mode}.ids.json`), JSON.stringify({ mode, wallSeconds, ...ids }, null, 1))
  writeFileSync(join(outDir, `${mode}.summary.json`), JSON.stringify(summary, null, 1))

  const flakes = readKnownFlakes()
  const failedIds = Object.entries(ids.tests).filter(([, status]) => status === 'failed').map(([id]) => id)
  const flakeFailures = failedIds.filter(id => flakes.has(id))
  const realFailures = failedIds.filter(id => !flakes.has(id))
  summary.failed = { real: realFailures, knownFlakes: flakeFailures }
  writeFileSync(join(outDir, `${mode}.summary.json`), JSON.stringify(summary, null, 1))
  console.log(`\nqualify ${mode}: exit ${result.status}, ${wallSeconds.toFixed(1)}s wall, ${summary.tests} test IDs in ${summary.files} files, ${JSON.stringify(summary.counts)}`)
  console.log(`qualify live paths: ${violations.length} test write(s), ${summary.livePathChanges.allowed} allowed (known ledger), ${summary.livePathChanges.live} live-process (named writer), ${summary.livePathChanges.leftover} fence leftover dir(s), ${summary.livePathChanges.noisy} noisy (changed in the idle control window too)`)
  for (const c of classified.filter(c => c.class !== 'noisy')) console.log(`  ${(c.class === 'violation' ? 'TEST-WRITE' : c.class.toUpperCase()).padEnd(10)} ${c.kind.padEnd(8)} ${c.key}${c.writer ? `  <- ${c.writer}` : ''}`)
  if (missingJson.length > 0) console.log(`qualify: JSON report missing: ${missingJson.join(', ')}`)
  for (const id of flakeFailures) console.log(`  KNOWN-FLAKE failed: ${id}\n      why: ${flakes.get(id)}`)
  for (const id of realFailures) console.log(`  FAILED: ${id}`)
  process.exit(exitCodeFor({ vitestStatus: result.status, clean: violations.length === 0 && missingJson.length === 0, realFailures: realFailures.length, flakeFailures: flakeFailures.length }))
}

function diffMode() {
  const [pa, pb] = [process.argv[3], process.argv[4]]
  const a = JSON.parse(readFileSync(pa, 'utf8'))
  const b = JSON.parse(readFileSync(pb, 'utf8'))
  const flakes = readKnownFlakes()
  const { onlyA, onlyB, differ, flaky } = diffIds(a, b, flakes)
  console.log(`diff ${a.mode} (${Object.keys(a.tests).length} IDs, ${a.wallSeconds?.toFixed?.(1)}s) vs ${b.mode} (${Object.keys(b.tests).length} IDs, ${b.wallSeconds?.toFixed?.(1)}s)`)
  console.log(`  only in ${a.mode}: ${onlyA.length}\n  only in ${b.mode}: ${onlyB.length}\n  status differs: ${differ.length}\n  known flakes (listed, not counted): ${flaky.length}`)
  for (const id of onlyA) console.log(`  ONLY-A  ${id}  [${a.tests[id]}]`)
  for (const id of onlyB) console.log(`  ONLY-B  ${id}  [${b.tests[id]}]`)
  for (const d of differ) console.log(`  DIFFER  ${d.id}  ${a.mode}=${d.a} ${b.mode}=${d.b}`)
  for (const f of flaky) console.log(`  KNOWN-FLAKE  ${f.id}  ${f.kind} ${a.mode}=${f.a ?? '-'} ${b.mode}=${f.b ?? '-'}\n      why: ${f.reason}`)
  for (const id of flakes.keys()) if (!(id in a.tests) && !(id in b.tests)) console.log(`  WARNING known-flakes.txt entry matches no test in either run: ${id}`)
  const real = onlyA.length + onlyB.length + differ.length
  process.exit(real > 0 ? 1 : flaky.length > 0 ? 3 : 0)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sub = process.argv[2]
  if (sub === 'run') runMode()
  else if (sub === 'diff') diffMode()
  else if (sub === 'snapshot') { writeFileSync(resolve(arg('--out', 'snapshot.json')), JSON.stringify(snapshot(), null, 1)); console.log('snapshot written') }
  else { console.error('usage: qualify-parallel.mjs run <mode> | diff <a> <b> | snapshot --out <file>'); process.exit(2) }
}
