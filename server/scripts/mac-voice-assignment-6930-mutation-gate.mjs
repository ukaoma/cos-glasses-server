#!/usr/bin/env node
// 6.93.0 mutation gate: assigning a Mac recording `Voice N` to an existing voice profile (lib/mac-voice-assignment.ts and
// its hook in the relabel route of routes/meeting.ts). Engine copied unchanged from mac-window-voices-6930-mutation-gate.mjs;
// mutations run only in a disposable copy of the checkout.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/mac-voice-assignment-6930-mutation-gate.mjs [--list] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LIB_T = ['server/lib/mac-voice-assignment.test.ts']
const ROUTE_T = ['server/routes/meeting-mac-assign-route.test.ts']
const G2_T = ['server/routes/meeting-relabel-route.test.ts']
const ALL = [...LIB_T, ...ROUTE_T, ...G2_T]
const A = 'server/lib/mac-voice-assignment.ts', M = 'server/routes/meeting.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Library guards: each refusal stands on its own, not only behind the route's ──
  m('guard-not-mac', A, ["  if (!isMacCaptureSidecar(sidecar, sessionId)) return none('not_mac_capture')\n", ''], [...LIB_T, ...ROUTE_T]),
  m('guard-voice-label', A, ["  if (!isVoiceLabel(from)) return none('not_a_voice_label')\n", ''], [...LIB_T, ...ROUTE_T]),
  m('guard-placeholder-target', A, ["  if (isPlaceholderLabel(to)) return none('unknown_profile')\n", ''], [...LIB_T, ...ROUTE_T]),
  m('guard-unknown-profile', A, ["  if (!profile) return none('unknown_profile')\n", ''], [...LIB_T, ...ROUTE_T]),
  m('profile-name-case-insensitive', A, ['.find(p => p.name === to) } catch', '.find(p => p.name.toLowerCase() === to.toLowerCase()) } catch'], [...LIB_T, ...ROUTE_T]),
  m('guard-embeddings-switch', A, ["  if (!chunkEmbeddingsEnabled()) return none('disabled')\n", ''], LIB_T),
  m('guard-model-present', A, ["  if (!isEmbeddingAvailable()) return none('store_unavailable')\n", ''], [...LIB_T, ...ROUTE_T]),
  m('guard-index-mapping', A, ["  if (!rawIndices) return none('no_index_mapping')\n", ''], LIB_T),
  // ── Which audio ──
  m('mixed-chunk-used-whole', A, ['if (turns.length === 0 || turns.every(t => t.speaker === from)) {', 'if (true) {'], ROUTE_T),
  m('other-voices-turns-sliced', A, ['const usable = turns.filter(t => t.speaker === from\n', 'const usable = turns.filter(t => true\n'], ROUTE_T),
  m('slice-min-ignored', A, ['>= MAC_ASSIGN_MIN_SLICE_SEC)', '>= 0)'], ROUTE_T),
  m('slice-min-off-by-one', A, ['export const MAC_ASSIGN_MIN_SLICE_SEC = 3.0', 'export const MAC_ASSIGN_MIN_SLICE_SEC = 2.0'], ROUTE_T),
  m('slice-inset-removed', A, ['export const MAC_ASSIGN_SLICE_INSET_SEC = 0.15', 'export const MAC_ASSIGN_SLICE_INSET_SEC = 0'], ROUTE_T),
  m('slice-start-inset-removed', A, ['slice: { startSec: (t.startSec as number) + MAC_ASSIGN_SLICE_INSET_SEC,', 'slice: { startSec: (t.startSec as number),'], ROUTE_T),
  m('slice-end-inset-removed', A, ['endSec: (t.endSec as number) - MAC_ASSIGN_SLICE_INSET_SEC }', 'endSec: (t.endSec as number) }'], ROUTE_T),
  m('final-segments-ignored', A, ['const list = Array.isArray(final) && final.length > 0 ? final : Array.isArray(live) ? live : []', 'const list = Array.isArray(live) ? live : []'], ROUTE_T),
  m('short-chunk-not-skipped', A, ['    if ((audio.length - 44) / (SAMPLE_RATE * 2) < VOICEPRINT_MIN_AUDIO_SEC) { report.shortSkipped += 1; continue }\n', ''], ROUTE_T),
  m('unit-cap-ignored', A, ['for (const unit of spread(units, MAC_ASSIGN_MAX_UNITS)) {', 'for (const unit of units) {'], ROUTE_T),
  m('spread-takes-the-first', A, ['out.push(items[Math.floor((k * items.length) / max)])', 'out.push(items[k])'], ROUTE_T),
  m('missing-audio-not-counted', A, ['    if (!path) { report.missingAudio += 1; continue }\n', '    if (!path) continue\n'], [...LIB_T, ...ROUTE_T]),
  m('audio-gone-reads-as-unusable', A, ["report.skipped = units.length === 0 ? 'no_usable_audio' : 'audio_not_retained'", "report.skipped = 'no_usable_audio'"], [...LIB_T, ...ROUTE_T]),
  m('wrong-sample-rate-accepted', A, ['    if (!pcm || pcm.sampleRate !== SAMPLE_RATE) continue\n', '    if (!pcm) continue\n'], ROUTE_T),
  // ── The same gates a glasses rename uses ──
  m('coherence-gate-skipped', A, ['const selected = greedyDiversitySelect(cluster.members.map(m => embeddings[m]), MAX_ENROL_PER_CORRECTION)', 'const selected = greedyDiversitySelect(embeddings, MAX_ENROL_PER_CORRECTION)'], ROUTE_T),
  m('coherence-skips-not-reported', A, ['report.clusterSkipped = embeddings.length - cluster.members.length', 'report.clusterSkipped = 0'], ROUTE_T),
  m('no-cluster-still-enrols', A, ["  if (cluster.members.length === 0) { report.skipped = 'no_usable_audio'; return { report, selected: [] } }\n", ''], ROUTE_T),
  m('diversity-cap-ignored', A, ['greedyDiversitySelect(cluster.members.map(m => embeddings[m]), MAX_ENROL_PER_CORRECTION)', 'cluster.members.map(m => embeddings[m])'], ROUTE_T),
  // ── Similarity is reported, not hidden ──
  m('below-floor-never-flagged', A, ['report.belowFloor = report.similarity < MERGE_SIMILARITY_FLOOR', 'report.belowFloor = false'], ROUTE_T),
  m('below-floor-wrong-way', A, ['report.belowFloor = report.similarity < MERGE_SIMILARITY_FLOOR', 'report.belowFloor = report.similarity > MERGE_SIMILARITY_FLOOR'], ROUTE_T),
  m('similarity-not-reported', A, ['report.similarity = Math.round(rawCosineSimilarity(voice, stored) * 1000) / 1000', 'report.similarity = null'], ROUTE_T),
  m('floor-not-the-merge-floor', A, ['belowFloor: false, floor: MERGE_SIMILARITY_FLOOR, skipped,', 'belowFloor: false, floor: 0.5, skipped,'], ROUTE_T),
  // ── Commit ──
  m('commit-ignores-refusal', A, ["  if (plan.report.skipped !== null || plan.selected.length === 0) return { ...plan.report, enrolled: 0 }\n", ''], LIB_T),
  m('commit-source-tag', A, ['const source = `correction:${sessionId}`', 'const source = `mac:${sessionId}`'], ROUTE_T),
  m('commit-store-failure-swallowed', A, ["    return { ...plan.report, enrolled, skipped: 'store_unavailable' }", '    return { ...plan.report, enrolled }'], ROUTE_T),
  m('commit-counts-failures', A, ['if (enrollEmbedding(plan.report.person, embedding, source).success) enrolled += 1', 'enrollEmbedding(plan.report.person, embedding, source); enrolled += 1'], ROUTE_T),
  m('plan-creates-profile-flag', A, ['person, enrolled: 0, attempted: 0, created: false,', 'person, enrolled: 0, attempted: 0, created: true as unknown as false,'], ROUTE_T),
  // ── The relabel route ──
  m('route-flag-always-on', M, ['    if (req.body?.assignVoiceProfile === true) {', '    if (true) {'], [...ROUTE_T, ...G2_T]),
  m('route-flag-ignored', M, ['    if (req.body?.assignVoiceProfile === true) {', '    if (false) {'], ROUTE_T),
  m('route-mac-only', M, ['      if (!isMacCaptureSidecar(parsedForAssign, sessionId)) {\n', '      if (false) {\n'], ROUTE_T),
  m('route-voice-label-only', M, ['      if (!isVoiceLabel(from)) {\n        res.status(400).json({ error: \'Only an unnamed Voice N', '      if (false) {\n        res.status(400).json({ error: \'Only an unnamed Voice N'], ROUTE_T),
  m('route-unknown-profile-404', M, ["      if (macAssign.report.skipped === 'unknown_profile') {", '      if (false) {'], ROUTE_T),
  m('route-nothing-to-enrol-refusal', M, ['    if (macAssign && macAssign.report.skipped !== null) {', '    if (false) {'], ROUTE_T),
  m('route-preview-hides-enrolment', M, ['        ...(macAssign ? { enrolment: macAssign.report } : {}),\n', ''], ROUTE_T),
  m('route-preview-message', M, ['              ? `, and adding up to ${macAssign.report.enrolled} voice sample(s) to ${to}\'s profile`', '              ? ``'], ROUTE_T),
  m('route-apply-uses-glasses-path', M, ['    const enrolment = macAssign\n      ? commitMacVoiceAssignment(sessionId, macAssign)\n      : enrolNamedVoice(', '    const enrolment = false\n      ? commitMacVoiceAssignment(sessionId, macAssign!)\n      : enrolNamedVoice('], ROUTE_T),
  m('route-plan-uses-renamed-sidecar', M, ['macAssign = planMacVoiceAssignment({ sessionId, from, to, changed: plan.value.changed, sidecar: parsedForAssign })', 'macAssign = planMacVoiceAssignment({ sessionId, from, to, changed: [], sidecar: parsedForAssign })'], ROUTE_T),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')

// Record exactly which code this run proved (QA R-N1): the commit, and whether the tree matched it.
const rev = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
const modified = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).length
console.log(`commit ${rev || 'unknown'} (${modified ? `${modified} modified files: NOT the committed code` : 'clean tree'})`)
const scratch = mkdtempSync(join(tmpdir(), "mac-voice-assignment-6930-mutations-"))
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
  console.log(`${killed} of ${selected.length} Mac window replay 6.93.0 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
