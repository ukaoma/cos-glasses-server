#!/usr/bin/env node
// Speaker merge shadow mode mutation gate (6.95.0). Mutations run only in a disposable copy of
// server/ and shared/; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// A mutant that landed and SURVIVED is a finding: that branch is unreached by the committed tests.
// The private real-meeting parity and real-CLI tests are skipped here on purpose: the committed
// synthetic suites must kill every mutant on their own.
//
// Usage: node server/scripts/speaker-shadow-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const D = 'server/lib/speaker-shadow-decide.ts', N = 'server/lib/speaker-shadow-numeric.ts', W = 'server/lib/speaker-shadow-worker.ts'
const T = 'server/lib/speaker-shadow-timeline.ts', M = 'server/lib/speaker-shadow-models.ts', S = 'server/lib/speaker-shadow.ts'
const tDecide = 'server/lib/speaker-shadow-decide.test.ts', tNum = 'server/lib/speaker-shadow-numeric.test.ts', tWorker = 'server/lib/speaker-shadow-worker.test.ts'
const tTimeline = 'server/lib/speaker-shadow-timeline.test.ts', tRunner = 'server/lib/speaker-shadow.test.ts', tNoWrite = 'server/lib/speaker-shadow-no-write.test.ts'
const tReport = 'server/lib/speaker-shadow-report.test.ts', tRoute = 'server/routes/speaker-shadow.test.ts'
const RP = 'server/lib/speaker-shadow-report.ts', RT = 'server/routes/speaker-shadow.ts'
const all = [tDecide, tNum, tWorker, tTimeline, tRunner, tNoWrite, tReport, tRoute]

// [name, file, find, replacement, tests]
const mutations = [
  // The four gates (hybrid.decide), each by itself.
  ['gate-a-covered', D, 'if (!(r.coveredFraction >= 0.5))', 'if (!(r.coveredFraction >= 0.4))', [tDecide]],
  ['gate-a-majority', D, 'if (!(r.majority >= majority))', 'if (!(r.majority >= 0.6))', [tDecide]],
  ['gate-b-floor-inclusive', D, 'if (!(r.seconds >= nSec))', 'if (!(r.seconds > nSec))', [tDecide]],
  ['gate-b-floor-off', D, 'if (!(r.seconds >= nSec))', 'if (false)', [tDecide]],
  ['gate-c-outlier-pass', D, 'r.outlier = { pass: d <= thr,', 'r.outlier = { pass: true,', [tDecide]],
  ['gate-c-leave-fragment-in', D, 'const members = items.filter(x => x.exportCluster === k && x.voice !== v).map(x => x.vec)', 'const members = items.filter(x => x.exportCluster === k).map(x => x.vec)', [tDecide]],
  ['gate-c-min-fragment', D, 'frag.length < 3 || members.length < 5', 'frag.length < 1 || members.length < 5', [tDecide]],
  ['gate-c-min-members', D, 'frag.length < 3 || members.length < 5', 'frag.length < 3 || members.length < 1', [tDecide]],
  ['named-labels-merge', D, '    if (!isShadowVoiceLabel(label)) continue\n    const list = collected.get(label)', '    const list = collected.get(label)', [tDecide]],
  ['window-half-span', D, 'voice: best !== null && bestN >= 0.5 * (hi - lo) ? best : null', 'voice: best', [tDecide]],
  ['group-anchor-longest', D, 'const ok = longestFirst(vs.filter(v => rows.get(v)!.eligible))', 'const ok = vs.filter(v => rows.get(v)!.eligible)', [tDecide]],
  // Python rounding and order, which the gates compare after.
  ['seconds-unrounded', D, 'seconds: pyRound(dur / SR, 2),', 'seconds: dur / SR,', [tDecide]],
  ['majority-unrounded', D, 'majority: covered ? pyRound(topN / covered, 3) : 0,', 'majority: covered ? topN / covered : 0,', [tDecide]],
  ['sum-uncompensated', N, 'if (compensation !== 0 && Number.isFinite(compensation)) total += compensation', '', [tNum]],
  ['fixed-half-up', N, "if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n", 'if (twice >= den) q += 1n', [tNum]],
  ['round-int-half-up', N, 'return floor % 2 === 0 ? floor : floor + 1', 'return floor + 1', [tNum]],
  ['hint-named-threshold', D, '.filter(([, n]) => n >= SR)', '.filter(([, n]) => n >= 10 * SR)', [tDecide]],
  // The worker's refusals and its sandbox.
  ['worker-labels-changed', W, 'if (job.expectedLabelsHash && labelsHash !== job.expectedLabelsHash)', 'if (false)', [tWorker]],
  ['worker-not-finalized', W, "if (sidecar.finalizationState !== 'complete')", 'if (false)', [tWorker]],
  ['worker-models-unchecked', W, '    if (!models.ok) return skip(models.reason, models.detail)\n', '', [tWorker]],
  ['worker-cli-hash-unchecked', W, 'await sha256File(job.cliPath) !== job.cliSha256', 'false', [tWorker]],
  ['worker-flags-unchecked', W, '    if (missingFlags.length) return skip(', '    if (false) return skip(', [tWorker]],
  ['worker-no-sandbox', W, "child = (deps.spawn ?? (spawn as unknown as SpawnLike))(job.sandboxExec, args,", "child = (deps.spawn ?? (spawn as unknown as SpawnLike))(job.cliPath, args.slice(3),", [tWorker]],
  ['worker-cli-deadline', W, 'const timer = setTimeout(() => { timedOut = true; kill() }, job.cliTimeoutMs)', 'const timer = setTimeout(() => {}, job.cliTimeoutMs)', [tWorker]],
  ['worker-temp-kept', W, "    if (work) { try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort; swept at boot */ } }", '', [tWorker]],
  ['timeline-drift-ignored', T, "if (digest !== want) throw new ShadowInputError('audio_drift'", "if (false) throw new ShadowInputError('audio_drift'", [tTimeline, tWorker]],
  ['timeline-no-trim', T, 'const use = i + 1 < rows.length ? Math.min(x.sampleCount, Math.max(0, rows[i + 1].startSample - x.startSample)) : x.sampleCount', 'const use = x.sampleCount', [tTimeline]],
  // The no-write guarantee: each of these would write into the data home.
  ['nowrite-timeline-into-meeting-audio', W, "const wavPath = join(work, 'timeline.wav')", "const wavPath = join(job.audioDir, 'timeline.wav')", [tRunner]],
  ['nowrite-records-into-recordings', S, '  const path = join(root, SPEAKER_SHADOW_RECORDS)\n', "  const path = join(root, '..', 'recordings', SPEAKER_SHADOW_RECORDS)\n", [tRunner]],
  ['nowrite-marker-into-models', M, 'writeFileSync(join(folder, SHADOW_REVISION_MARKER.path)', 'writeFileSync(join(verifiedDir, SHADOW_REVISION_MARKER.path)', [tTimeline]],
  ['nowrite-new-write-call', W, "    await writeFile(wavPath, wav, { mode: 0o600, flag: 'wx' })\n", "    await writeFile(wavPath, wav, { mode: 0o600, flag: 'wx' })\n    await writeFile(`${wavPath}.copy`, wav)\n", [tNoWrite]],
  ['nowrite-writer-import', S, "import { durableAtomicWriteFileSync } from './atomic-fs.js'\n", "import { durableAtomicWriteFileSync } from './atomic-fs.js'\nimport './meeting-store.js'\n", [tNoWrite]],
  // How it stops.
  ['switch-always-on', S, '  return resolveSpeakerShadowSwitch(env, root).enabled\n', '  return true\n', [tRunner]],
  ['breaker-threshold', S, 'if (next.consecutiveFailures >= SPEAKER_SHADOW_BREAKER_FAILURES)', 'if (next.consecutiveFailures > SPEAKER_SHADOW_BREAKER_FAILURES)', [tRunner]],
  ['breaker-ignored', S, "if (state.breakerUntil && now < state.breakerUntil) { this.schedule(state.breakerUntil - now, 'breaker_open'); return }", '', [tRunner]],
  ['daily-cap', S, 'if (state.runsToday >= limits.dailyRuns)', 'if (state.runsToday > limits.dailyRuns)', [tRunner]],
  ['wall-clock', S, "if (this.deps.now() - started > limits.timeoutMs) { stop(", "if (false) { stop(", [tRunner]],
  ['rss-cap', S, 'if (bytes > limits.rssBytes) stop(', 'if (false) stop(', [tRunner]],
  ['live-mid-run', S, "if (this.deps.captureActive?.() || !this.deps.admissionsOpen()) { stop({ status: 'deferred', reason: 'capture_live' }); return }", '', [tRunner]],
  ['live-at-start', S, "if (this.deps.captureActive() || !this.deps.admissionsOpen()) { this.schedule(DEFER_RETRY_MS, 'live_work'); return }", '', [tRunner]],
  ['no-probe-runs', S, "if (!this.deps.captureActive) { this.schedule(DEFER_RETRY_MS, 'no_live_probe'); return }", "if (!this.deps.captureActive) this.deps.captureActive = () => false", [tRunner]],
  ['once-per-meeting', S, 'if (state.done.includes(input.sessionId) || state.queue.some(q => q.sessionId === input.sessionId)) return', '', [tRunner]],
  ['health-key-when-off', S, '  if (!speakerShadowEnabled(env, root)) return {}\n  return { speaker_shadow: speakerShadowHealth() }', '  return { speaker_shadow: speakerShadowHealth() }', [tRunner]],
  // The per-Mac switch (env pins, else the saved setting, else off).
  ['switch-setting-ignored', S, "  if (stored !== null) return { enabled: stored, source: 'setting' }\n", '', [tRunner]],
  ['switch-default-on', S, "  return { enabled: false, source: 'default' }\n}", "  return { enabled: true, source: 'default' }\n}", [tRunner]],
  ['switch-env-off-ignored', S, 'return ENV_ON.has(raw) ? true : ENV_OFF.has(raw) ? false : null', 'return ENV_ON.has(raw) ? true : null', [tRunner]],
  ['switch-bad-setting-on', S, "typeof raw.enabled === 'boolean' ? raw.enabled : null", '!!raw.enabled', [tRunner]],
  ['switched-off-mid-run', S, "        if (!this.enabled()) { stop({ status: 'deferred', reason: 'switched_off' }); return }\n", '', [tRunner]],
  ['route-env-forced', RT, 'if (pinned !== null && pinned !== body.enabled)', 'if (false)', [tRoute]],
  ['route-strict-body', RT, " || Object.keys(body).some(k => k !== 'enabled')", '', [tRoute]],
  // The readable report.
  ['report-not-written', S, '      durableAtomicWriteFileSync(path, markdown, { mode: 0o600 })\n', '', [tRunner]],
  ['report-hint-dropped', RP, '    if (named.length) {', '    if (false) {', [tReport]],
  ['report-text-dropped', RP, '"${quote(input.chunkText.get(p.chunkIndex))}"', '""', [tReport]],
  ['lease-dictation', S, "'prompt_draft_write', 'prompt_draft_warm', 'prompt_draft_finalize',", "'prompt_draft_write', 'prompt_draft_warm',", [tRunner]],
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const selected = names.length ? mutations.filter(([name]) => names.includes(name)) : mutations
if (names.length && selected.length !== names.length) throw new Error('Unknown mutation name in: ' + args.join(' '))

if (args.includes('--check')) {
  let bad = 0
  for (const [name, file, find, replacement] of mutations) {
    const text = readFileSync(join(root, file), 'utf8'), count = text.split(find).length - 1
    if (count !== 1 || find === replacement) { bad++; console.log(`${name}: ${count} matches in ${file}`) }
  }
  console.log(`${mutations.length - bad} of ${mutations.length} targets unique`); process.exit(bad ? 1 : 0)
}
const scratch = mkdtempSync(join(tmpdir(), 'speaker-shadow-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
  cpSync(join(root, 'tsconfig.json'), join(scratch, 'tsconfig.json'))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = files => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...files], {
    cwd: scratch,
    env: {
      PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json'),
      COS_MAINTENANCE_GATE_PATH: join(scratch, 'gate', 'maintenance-gate.json'), TMPDIR: process.env.TMPDIR,
    },
    // A mutant can turn every wait in the runner suite into a full timeout; a harness timeout
    // is never counted as a kill, so give a slow (or loaded) machine room to finish.
    encoding: 'utf8', timeout: 900000,
  })
  const baseline = run(all)
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  const totals = /Tests\s+(\d+) passed/.exec(baseline.stdout)
  console.log(`baseline PASS (${totals ? totals[1] : '?'} tests in ${all.length} files)`)
  const survived = []
  for (const [name, file, find, replacement, files] of selected) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    if (original.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}`)
    const mutated = original.replace(find, replacement)
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    const result = run(files), output = result.stdout + '\n' + result.stderr
    writeFileSync(target, original)
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    const killers = [...new Set([...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(m => m[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { survived.push(name); console.log(`${name} SURVIVED${result.error ? ' (harness: ' + result.error.message + ')' : ''}`); continue }
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${selected.length - survived.length} of ${selected.length} speaker shadow mutations killed`)
  if (survived.length) { console.log('SURVIVED: ' + survived.join(', ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
