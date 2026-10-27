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
const EV_T = ['server/lib/embedding-eviction.test.ts', 'server/lib/embedding-eviction-integration.test.ts']
const SE_T = ['server/lib/speaker-embeddings-enroll.test.ts']
const TP_T = ['server/lib/training-audio-provenance.test.ts']
const ALL = [...LIB_T, ...ROUTE_T, ...G2_T, ...EV_T, ...SE_T, ...TP_T]
const A = 'server/lib/mac-voice-assignment.ts', M = 'server/routes/meeting.ts'
const EV = 'server/lib/embedding-eviction.ts', SE = 'server/lib/speaker-embeddings.ts', TP = 'server/lib/training-audio-provenance.ts'
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
  // ── B3: the wearer profile is never a target ──
  m('guard-owner', A, ["  if (input.ownerLabel && sameName(to, input.ownerLabel)) return none('owner_profile')\n", ''], [...LIB_T, ...ROUTE_T]),
  m('owner-match-case-sensitive', A, ["a.normalize('NFKC').trim().toLowerCase() === b.normalize('NFKC').trim().toLowerCase()", "a === b"], [...LIB_T, ...ROUTE_T]),
  m('route-owner-label-not-passed', M, ['sidecar: parsedForAssign, ownerLabel })', 'sidecar: parsedForAssign })'], ROUTE_T),
  m('route-owner-not-409', M, ["      if (macAssign.report.skipped === 'owner_profile') {", '      if (false) {'], ROUTE_T),
  m('guard-no-stored-voice', A, ["  if (!stored) return none('no_stored_voice')\n", ''], LIB_T),
  // ── B2: capacity (a Mac-assigned sample can only use free slots or replace its own kind) ──
  m('guard-profile-full', A, ["  if (capacity <= 0) return none('profile_full')\n", ''], ROUTE_T),
  m('capacity-ignores-replaceable', A, ['Math.max(0, MAX_EMBEDDINGS_PER_SPEAKER - profile.embeddings.length) + macCount)', 'Math.max(0, MAX_EMBEDDINGS_PER_SPEAKER - profile.embeddings.length))'], ROUTE_T),
  m('selection-not-trimmed-to-room', A, ['Math.min(MAX_ENROL_PER_CORRECTION, capacity)).slice(0, capacity)', 'Math.min(MAX_ENROL_PER_CORRECTION, capacity))'], ROUTE_T),
  m('selection-ignores-mac-cap', A, ['Math.min(MAX_ENROL_PER_CORRECTION, capacity)).slice(0, capacity)', 'MAX_ENROL_PER_CORRECTION)'], ROUTE_T),
  // ── Which audio ──
  m('mixed-chunk-used-whole', A, ['if (turns.length === 0 || turns.every(t => t.speaker === from)) {', 'if (true) {'], ROUTE_T),
  m('other-voices-turns-sliced', A, ['const usable = turns.filter(t => t.speaker === from\n', 'const usable = turns.filter(t => true\n'], ROUTE_T),
  m('slice-min-ignored', A, ['>= MAC_ASSIGN_MIN_SLICE_SEC)', '>= 0)'], ROUTE_T),
  m('slice-min-off-by-one', A, ['export const MAC_ASSIGN_MIN_SLICE_SEC = 3.0', 'export const MAC_ASSIGN_MIN_SLICE_SEC = 2.0'], ROUTE_T),
  m('slice-inset-removed', A, ['export const MAC_ASSIGN_SLICE_INSET_SEC = 0.15', 'export const MAC_ASSIGN_SLICE_INSET_SEC = 0'], ROUTE_T),
  m('slice-start-inset-removed', A, ['slice: { startSec: (t.startSec as number) + MAC_ASSIGN_SLICE_INSET_SEC,', 'slice: { startSec: (t.startSec as number),'], ROUTE_T),
  m('slice-end-inset-removed', A, ['endSec: (t.endSec as number) - MAC_ASSIGN_SLICE_INSET_SEC }', 'endSec: (t.endSec as number) }'], ROUTE_T),
  m('final-segments-ignored', A, ['const list = Array.isArray(final) && final.length > 0 ? final : Array.isArray(live) ? live : []', 'const list = Array.isArray(live) ? live : []'], ROUTE_T),
  m('short-chunk-not-skipped', A, ['    if (sec < VOICEPRINT_MIN_AUDIO_SEC) { report.shortSkipped += 1; continue }\n', ''], ROUTE_T),
  m('unit-cap-ignored', A, ['const picked = spread(units, MAC_ASSIGN_MAX_UNITS)', 'const picked = units'], ROUTE_T),
  m('spread-takes-the-first', A, ['out.push(items[Math.floor((k * items.length) / max)])', 'out.push(items[k])'], ROUTE_T),
  m('missing-audio-not-counted', A, ['    if (!path) { report.missingAudio += 1; continue }\n', '    if (!path) continue\n'], [...LIB_T, ...ROUTE_T]),
  m('audio-gone-reads-as-unusable', A, ["report.skipped = units.length === 0 ? 'no_usable_audio' : 'audio_not_retained'", "report.skipped = 'no_usable_audio'"], [...LIB_T, ...ROUTE_T]),
  m('wrong-sample-rate-accepted', A, ['    if (!pcm || pcm.sampleRate !== SAMPLE_RATE) continue\n', '    if (!pcm) continue\n'], ROUTE_T),
  // ── The same gates a glasses rename uses ──
  m('coherence-gate-skipped', A, ['greedyDiversitySelect(cluster.members.map(m => embeddings[m]), Math.min(', 'greedyDiversitySelect(embeddings, Math.min('], ROUTE_T),
  m('coherence-skips-not-reported', A, ['report.clusterSkipped = embeddings.length - cluster.members.length', 'report.clusterSkipped = 0'], ROUTE_T),
  m('no-cluster-still-enrols', A, ["  if (cluster.members.length === 0) { report.skipped = 'no_usable_audio'; return { report, selected: [], stats } }\n", ''], ROUTE_T),
  m('diversity-cap-ignored', A, ['Math.min(MAX_ENROL_PER_CORRECTION, capacity)).slice(0, capacity)', 'Infinity).slice(0, capacity)'], ROUTE_T),
  // ── B1: similarity, counts and the three gates ──
  m('below-floor-never-flagged', A, ['report.belowFloor = report.similarity < MERGE_SIMILARITY_FLOOR', 'report.belowFloor = false'], ROUTE_T),
  m('below-floor-wrong-way', A, ['report.belowFloor = report.similarity < MERGE_SIMILARITY_FLOOR', 'report.belowFloor = report.similarity > MERGE_SIMILARITY_FLOOR'], ROUTE_T),
  m('similarity-not-reported', A, ['report.similarity = Math.round(rawCosineSimilarity(voice, stored) * 1000) / 1000', 'report.similarity = null'], ROUTE_T),
  m('floor-not-the-merge-floor', A, ['belowFloor: false, floor: MERGE_SIMILARITY_FLOOR,', 'belowFloor: false, floor: 0.5,'], ROUTE_T),
  m('gate-below-floor-dropped', A, ["  if (report.belowFloor) report.gates.push('below_floor')\n", ''], [...LIB_T, ...ROUTE_T]),
  m('gate-mixed-dropped', A, ["  if (report.groupSize < embeddings.length * MAC_ASSIGN_MIXED_FRACTION) report.gates.push('mixed_voice')\n", ''], [...LIB_T, ...ROUTE_T]),
  m('gate-mixed-edge-inclusive', A, ['report.groupSize < embeddings.length * MAC_ASSIGN_MIXED_FRACTION', 'report.groupSize <= embeddings.length * MAC_ASSIGN_MIXED_FRACTION'], LIB_T),
  m('gate-mixed-fraction-half', A, ['export const MAC_ASSIGN_MIXED_FRACTION = 2 / 3', 'export const MAC_ASSIGN_MIXED_FRACTION = 1 / 2'], [...LIB_T, ...ROUTE_T]),
  m('gate-too-little-dropped', A, ["  if (report.groupSize < MAC_ASSIGN_MIN_UNITS && report.groupSec < MAC_ASSIGN_MIN_SINGLE_SEC) report.gates.push('too_little_audio')\n", ''], [...LIB_T, ...ROUTE_T]),
  m('gate-too-little-or', A, ['report.groupSize < MAC_ASSIGN_MIN_UNITS && report.groupSec < MAC_ASSIGN_MIN_SINGLE_SEC', 'report.groupSize < MAC_ASSIGN_MIN_UNITS || report.groupSec < MAC_ASSIGN_MIN_SINGLE_SEC'], [...LIB_T, ...ROUTE_T]),
  m('gate-single-seconds-lowered', A, ['export const MAC_ASSIGN_MIN_SINGLE_SEC = 6', 'export const MAC_ASSIGN_MIN_SINGLE_SEC = 5'], LIB_T),
  m('gate-min-units-one', A, ['export const MAC_ASSIGN_MIN_UNITS = 2', 'export const MAC_ASSIGN_MIN_UNITS = 1'], [...LIB_T, ...ROUTE_T]),
  m('group-size-not-reported', A, ['  report.groupSize = cluster.members.length\n', ''], [...LIB_T, ...ROUTE_T]),
  m('group-seconds-wrong', A, ['report.groupSec = Math.round(cluster.members.reduce((sum, m) => sum + secs[m], 0) * 10) / 10', 'report.groupSec = Math.round(secs.reduce((sum, v) => sum + v, 0) * 10) / 10'], LIB_T),
  // ── The route: gates refuse unless forced; force is not wider than that ──
  m('route-gates-never-refuse', M, ['    if (macAssign && macAssign.report.gates.length > 0 && req.body?.force !== true) {', '    if (false) {'], ROUTE_T),
  m('route-force-ignored', M, ['    if (macAssign && macAssign.report.gates.length > 0 && req.body?.force !== true) {', '    if (macAssign && macAssign.report.gates.length > 0) {'], ROUTE_T),
  m('route-gate-reason-not-first', M, ['      const gate = macAssign.report.gates[0]\n', '      const gate = macAssign.report.gates[macAssign.report.gates.length - 1]\n'], ROUTE_T),
  m('route-force-skips-pending-correction', M, ['    if (stalled.length > 0 && (req.body?.force !== true || macAssign)) {', '    if (stalled.length > 0 && req.body?.force !== true) {'], ROUTE_T),
  // ── B4: capture, interleave, deadline, yield, vector reuse ──
  m('route-capture-pre-check-dropped', M, ['      if (captureActive()) {\n        res.status(409).json({ error: \'A meeting is being recorded right now.', '      if (false) {\n        res.status(409).json({ error: \'A meeting is being recorded right now.'], ROUTE_T),
  m('route-capture-post-check-dropped', M, ['    if (macAssign && captureActive()) {', '    if (false) {'], ROUTE_T),
  m('route-capture-ignored-by-default-probe', M, ['(() => getTranscriptionSessionLiveness().live > 0)', '(() => false)'], ROUTE_T),
  m('route-in-flight-not-guarded', M, ['      if (macAssignInFlight.has(sessionId)) {', '      if (false) {'], ROUTE_T),
  m('route-in-flight-never-released', M, ['      } finally {\n        macAssignInFlight.delete(sessionId)\n      }', '      } finally {\n      }'], ROUTE_T),
  m('route-meeting-bytes-not-rechecked', M, ['      if (sidecarAfter !== sidecarRaw || revisionAfter) {', '      if (revisionAfter) {'], ROUTE_T),
  m('route-revision-not-rechecked', M, ['      if (sidecarAfter !== sidecarRaw || revisionAfter) {', '      if (sidecarAfter !== sidecarRaw) {'], ROUTE_T),
  m('plan-does-not-yield', A, ['    await yieldToLoop()\n', ''], [...LIB_T, ...ROUTE_T]),
  m('plan-deadline-ignored', A, ['    if (now() >= deadline) {', '    if (false) {'], LIB_T),
  m('plan-deadline-not-a-refusal', A, ["      report.skipped = 'deadline'\n", ''], LIB_T),
  m('env-deadline-unbounded', A, ['raw >= 1000 && raw <= 25_000', 'raw >= 0'], LIB_T),
  m('vectors-not-reused', A, ['    const hit = cacheGet(key)\n', '    const hit = undefined as ReturnType<typeof cacheGet>\n'], [...LIB_T, ...ROUTE_T]),
  m('vector-key-ignores-file', A, ['|${info.size}|${Math.round(info.mtimeMs)}`', '`'], LIB_T),
  m('vector-key-ignores-slice', A, ["${unit.slice ? `${unit.slice.startSec.toFixed(3)}-${unit.slice.endSec.toFixed(3)}` : 'whole'}", "whole"], ROUTE_T),
  m('apply-writes-per-sample', A, ['const result = enrollEmbeddingsBatch(plan.report.person, plan.selected.map(embedding => ({ embedding, source })))', 'const result = plan.selected.map(embedding => enrollEmbeddingsBatch(plan.report.person, [{ embedding, source }])).reduce((a, r) => ({ enrolled: a.enrolled + r.enrolled, declined: a.declined + r.declined, persisted: a.persisted && r.persisted }), { enrolled: 0, declined: 0, persisted: true })'], LIB_T),
  // ── Commit ──
  m('commit-ignores-refusal', A, ["  if (plan.report.skipped !== null || plan.selected.length === 0) return { ...plan.report, enrolled: 0 }\n", ''], LIB_T),
  m('commit-source-tag', A, ['const source = `${MAC_ASSIGN_SOURCE}:${sessionId}`', 'const source = `correction:${sessionId}`'], [...LIB_T, ...ROUTE_T]),
  m('commit-source-tag-unstamped', A, ['const source = `${MAC_ASSIGN_SOURCE}:${sessionId}`', 'const source = MAC_ASSIGN_SOURCE'], [...LIB_T, ...ROUTE_T]),
  m('commit-store-failure-swallowed', A, ["    if (!result.persisted) return { ...plan.report, enrolled: 0, skipped: 'store_unavailable' }\n", ''], [...LIB_T, ...ROUTE_T]),
  m('commit-counts-everything', A, ['    return { ...plan.report, enrolled: result.enrolled }', '    return { ...plan.report, enrolled: plan.selected.length }'], ROUTE_T),
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
  m('route-preview-hides-refusal-reason', M, ['              : `. Assigning is not possible: ${macAssignSkipText(macAssign.report.skipped)}. Send without assignVoiceProfile for a text-only rename`', '              : \'\''], ROUTE_T),
  m('route-apply-uses-glasses-path', M, ['    const enrolment = macAssign\n      ? commitMacVoiceAssignment(sessionId, macAssign)\n      : enrolNamedVoice(', '    const enrolment = false\n      ? commitMacVoiceAssignment(sessionId, macAssign!)\n      : enrolNamedVoice('], ROUTE_T),
  m('route-plan-uses-renamed-sidecar', M, ['macAssign = await planMacVoiceAssignment({ sessionId, from, to, changed: plan.value.changed, sidecar: parsedForAssign, ownerLabel })', 'macAssign = await planMacVoiceAssignment({ sessionId, from, to, changed: [], sidecar: parsedForAssign, ownerLabel })'], ROUTE_T),
  // ── B2 policy (embedding-eviction.ts) ──
  m('mac-assign-not-assisted', EV, ["    case MAC_ASSIGN_SOURCE:\n", ''], [...EV_T, ...SE_T, ...ROUTE_T]),
  m('mac-assign-vouches', EV, ["return head === 'manual' || head === 'fireflies' || head === 'g2-enrollment'", "return head === 'manual' || head === 'fireflies' || head === 'g2-enrollment' || head === 'mac-assign'"], EV_T),
  m('mac-assign-is-a-correction', EV, ["return String(source ?? '').trim().toLowerCase().startsWith('correction')", "return String(source ?? '').trim().toLowerCase().startsWith('correction') || isMacAssign(source)"], EV_T),
  m('mac-assign-evicts-others', EV, ["    if (macIdx.length > 0) {\n      return {\n        index: macIdx[0],", "    if (false) {\n      return {\n        index: macIdx[0],"], [...EV_T, ...SE_T, ...ROUTE_T]),
  m('mac-assign-refusal-evicts-index-zero', EV, ["return { index: -1, tier: 'assisted', reason: 'profile is full and holds no Mac-assigned sample to replace, refusing the Mac-assigned sample', refuse: true }", "return { index: 0, tier: 'assisted', reason: 'profile is full and holds no Mac-assigned sample to replace, refusing the Mac-assigned sample' }"], [...EV_T, ...SE_T, ...ROUTE_T]),
  m('mac-assign-evicted-after-g2-training', EV, ["const idx = tier === 'assisted' && macIdx.length > 0 ? macIdx[0] : sources.findIndex(s => provenanceTier(s) === tier)", "const idx = sources.findIndex(s => provenanceTier(s) === tier)"], EV_T),
  m('mac-assign-cap-changed', EV, ['export const MAC_ASSIGN_PROFILE_CAP = 10', 'export const MAC_ASSIGN_PROFILE_CAP = 20'], [...EV_T, ...SE_T, ...ROUTE_T]),
  m('mac-assign-not-retractable', TP, ["['auto:', 'correction:', 'g2-training:', 'ext-group:', 'mac-assign:']", "['auto:', 'correction:', 'g2-training:', 'ext-group:']"], [...TP_T, ...ROUTE_T]),
  // ── B2/B4/W8: the real store code ──
  m('batch-writes-per-sample', SE, ['    appendEmbedding(profile, Array.from(item.embedding), item.source)\n    added++\n', '    appendEmbedding(profile, Array.from(item.embedding), item.source)\n    added++\n    writeProfileStore(store)\n'], SE_T),
  m('batch-dedup-dropped', SE, ['    if (profile.embeddings.some(existing => rawCosineSimilarity(item.embedding, new Float32Array(existing)) > 0.95)) { declined++; continue }\n', ''], SE_T),
  m('batch-room-not-made', SE, ['    const room = makeRoomForSample(name, profile, item.source)\n    if (!room.ok) { declined++; continue }\n', ''], SE_T),
  m('batch-write-failure-swallowed', SE, ["    if (!writeProfileStore(store)) throw new Error('the store refused the write')\n  } catch (err: unknown) {\n    restoreProfileFromDisk(name)\n    return { enrolled: 0, declined: items.length", "    writeProfileStore(store)\n  } catch (err: unknown) {\n    restoreProfileFromDisk(name)\n    return { enrolled: 0, declined: items.length"], SE_T),
  m('batch-failure-memory-kept', SE, ["  } catch (err: unknown) {\n    restoreProfileFromDisk(name)\n    return { enrolled: 0, declined: items.length", "  } catch (err: unknown) {\n    return { enrolled: 0, declined: items.length"], SE_T),
  m('batch-failure-counts-enrolled', SE, ["return { enrolled: 0, declined: items.length, persisted: false, error: `Profile store write failed: ${errMsg(err)}` }\n  }\n  rebuildSpeakerInManager", "return { enrolled: added, declined: items.length, persisted: false, error: `Profile store write failed: ${errMsg(err)}` }\n  }\n  rebuildSpeakerInManager"], SE_T),
  m('mac-cap-not-enforced', SE, ['if (profile.embeddings.length < MAX_EMBEDDINGS_PER_SPEAKER && !macAtCap) return { ok: true }', 'if (profile.embeddings.length < MAX_EMBEDDINGS_PER_SPEAKER) return { ok: true }'], SE_T),
  m('refusal-falls-back-to-oldest', SE, ["  if (choice?.refuse) {\n", "  if (false) {\n"], SE_T),
  m('persist-swallows-write-error', SE, ["    restoreProfileFromDisk(name)\n    throw err instanceof Error ? err : new Error(errMsg(err))\n", "    restoreProfileFromDisk(name)\n"], SE_T),
  m('persist-ignores-refused-write', SE, ["    if (!writeProfileStore(store)) throw new Error('the store refused the write')\n  } catch (err: unknown) {\n    console.error('[speaker] Profile persist error:', errMsg(err))", "    writeProfileStore(store)\n  } catch (err: unknown) {\n    console.error('[speaker] Profile persist error:', errMsg(err))"], SE_T),
  m('persist-failure-memory-kept', SE, ["    console.error('[speaker] Profile persist error:', errMsg(err))\n    restoreProfileFromDisk(name)\n", "    console.error('[speaker] Profile persist error:', errMsg(err))\n"], SE_T),
  m('enroll-reports-success-after-failed-write', SE, ["    try {\n      persistProfile(name, embedding, source)\n    } catch (err: unknown) {\n      return { success: false, dim: extractor.dim, error: `Profile store write failed: ${errMsg(err)}` }\n    }\n    const updatedStore", "    try {\n      persistProfile(name, embedding, source)\n    } catch (err: unknown) {\n    }\n    const updatedStore"], SE_T),
  m('enroll-reports-success-after-failed-write-new', SE, ["  // Persist to disk with provenance\n  try {\n    persistProfile(name, embedding, source)\n  } catch (err: unknown) {\n    return { success: false, dim: extractor.dim, error: `Profile store write failed: ${errMsg(err)}` }\n  }", "  // Persist to disk with provenance\n  try {\n    persistProfile(name, embedding, source)\n  } catch (err: unknown) {\n  }"], SE_T),
  m('restore-leaves-phantom-speaker', SE, ["    else if (manager?.contains(name)) manager.remove(name)\n", ''], SE_T),
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
  console.log(`${killed} of ${selected.length} Mac voice assignment 6.93.0 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
