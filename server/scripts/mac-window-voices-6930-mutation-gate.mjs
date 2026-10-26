#!/usr/bin/env node
// 6.93.0 mutation gate: live Mac window replay (lib/mac-window-voices.ts, lib/mac-window-replay.ts), its hook in
// lib/nemotron-live.ts and the Mac chunk route. Engine copied unchanged from mac-voices-6900-mutation-gate.mjs;
// mutations run only in a disposable copy of the checkout.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/mac-window-voices-6930-mutation-gate.mjs [--list] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const UNIT_T = ['server/lib/mac-window-voices.test.ts']
const REPLAY_T = ['server/lib/mac-window-replay.test.ts']
const LABELS_T = ['server/lib/mac-voice-labels.test.ts']
const LIVE_T = ['server/lib/nemotron-live.test.ts']
const FINAL_T = ['server/lib/nemotron-final-mac-voices.test.ts']
const MAC_T = ['server/routes/mac-recording.test.ts']
const ALL = [...UNIT_T, ...REPLAY_T, ...LABELS_T, ...LIVE_T, ...FINAL_T, ...MAC_T]
const W = 'server/lib/mac-window-voices.ts', RP = 'server/lib/mac-window-replay.ts', L = 'server/lib/nemotron-live.ts', TS = 'server/routes/transcribe-stream.ts'
const VL = 'server/lib/mac-voice-labels.ts', NF = 'server/lib/nemotron-final.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Switch (QA B1: with every switch off a Mac recording is 6.92.0) ──
  m('live-default-anchors', VL, ["return raw === 'anchors' || raw === 'window' ? raw : 'off'", "return raw === 'anchors' || raw === 'window' ? raw : 'anchors'"], [...LABELS_T, ...MAC_T]),
  m('live-default-window', VL, ["return raw === 'anchors' || raw === 'window' ? raw : 'off'", "return raw === 'anchors' || raw === 'window' ? raw : 'window'"], [...LABELS_T, ...UNIT_T, ...MAC_T]),
  m('voice-labels-off-not-master', VL, ["  if (!macVoiceLabelsEnabled(env)) return 'off'\n  const raw", '  const raw'], [...LABELS_T, ...UNIT_T, ...MAC_T]),
  m('explicit-labels-one-enables-anchors', VL, ["return raw === 'anchors' || raw === 'window' ? raw : 'off'", "return raw === 'anchors' || raw === 'window' ? raw : String(env.COS_MAC_VOICE_LABELS ?? '').trim() === '1' ? 'anchors' : 'off'"], [...LABELS_T, ...MAC_T]),
  m('voice-shape-unchecked', VL, ['return Array.isArray(segments) && segments.some(', 'return segments.some('], LABELS_T),
  m('anchors-run-when-off', TS, ["macLiveVoicesMode() === 'anchors' ? {", "macLiveVoicesMode() !== 'window' ? {"], MAC_T),
  m('anchors-run-in-window-mode', TS, ["macLiveVoicesMode() === 'anchors' ? {", "macLiveVoicesMode() !== 'off' ? {"], MAC_T),
  m('projection-when-off', TS, ["labels.diarizer?.engine === 'nemotron' && macLiveVoicesMode() !== 'off'", "labels.diarizer?.engine === 'nemotron'"], MAC_T),
  m('g2-takes-window', TS, ['const macWindowOn = MAC_CAPTURE_ID.test(sessionId) && macWindowVoicesEnabled()', 'const macWindowOn = macWindowVoicesEnabled()'], MAC_T),
  m('final-restricts-without-live-voices', NF, ['const liveMap = liveNumbers.length ? mapChannelsToLiveVoices(timeline.windows, activity) : null', 'const liveMap = mapChannelsToLiveVoices(timeline.windows, activity)'], [...FINAL_T, ...MAC_T]),
  m('final-leaves-unproven-ext', NF, ['channels = found.channels.filter(channel => !liveMap || liveMap.has(channel) || unproven.includes(channel))', 'channels = found.channels.filter(channel => !liveMap || liveMap.has(channel))'], FINAL_T),
  m('final-numbers-contradicted-channel', NF, ['return channels.filter(channel => !claims.has(channel))', 'return channels'], FINAL_T),
  m('final-number-collides-with-live', NF, ['let next = Math.max(...liveNumbers)', 'let next = 0'], FINAL_T),
  // ── Carry across the boundary ──
  m('carry-min-ignored', W, ['if (c.count < MAC_WINDOW_CARRY_MIN_FRAMES || ', 'if ('], UNIT_T),
  m('carry-agreement-ignored', W, [' || c.count / exclusiveInOverlap.get(c.slot)! < MAC_WINDOW_CARRY_AGREEMENT) continue', ') continue'], UNIT_T),
  m('carry-not-one-to-one', W, ['if (slotTrack.has(c.slot) || usedTracks.has(c.track)) continue', 'if (slotTrack.has(c.slot)) continue'], UNIT_T),
  // The denominator counts untracked exclusive frames too (they are why a slot of mixed history is not carried).
  m('untracked-not-in-denominator', W, [
    ['      exclusiveInOverlap.set(slot, (exclusiveInOverlap.get(slot) ?? 0) + 1)\n      const track = codes[i]\n      if (track < 0) continue\n', '      const track = codes[i]\n      if (track < 0) continue\n      exclusiveInOverlap.set(slot, (exclusiveInOverlap.get(slot) ?? 0) + 1)\n'],
  ], UNIT_T),
  // ── The current chunk must agree (QA W1) ──
  m('agreement-skipped', W, ['if (chunkAgreesWithSlot(window, start, length, slot, input.chunkAlone)) continue', 'if (true) continue'], UNIT_T),
  m('agreement-without-a-view', W, ['if (!alone || alone.probs.length !== alone.frames * NEMOTRON_CHANNELS) return false', 'if (!alone) return true\n  if (alone.probs.length !== alone.frames * NEMOTRON_CHANNELS) return false'], UNIT_T),
  m('agreement-coverage-ignored', W, ['if (covered === 0 || covered < own * MAC_WINDOW_AGREE_COVERAGE) return false', 'if (covered === 0) return false'], UNIT_T),
  m('agreement-purity-ignored', W, ['return Math.max(...perChannel.values()) / covered >= MAC_WINDOW_AGREE_PURITY', 'return true'], UNIT_T),
  m('withheld-slot-still-coded-tracked', W, ['slotTrack.delete(slot)\n    withheld++', 'withheld++'], UNIT_T),
  m('silent-carried-slot-counted-as-disagreement', W, ['    if ((exclusiveNew.get(slot) ?? 0) === 0) { slotTrack.delete(slot); continue }\n', ''], UNIT_T),
  m('agreement-view-dropped', RP, ['crossed = cross(outcome.run, solo.ok ? solo.run : null, plan)', 'crossed = cross(outcome.run, null, plan)'], [...REPLAY_T, ...MAC_T]),
  m('agreement-run-unconditional', RP, ['if (crossed.stats.carried > 0) {', 'if (true) {'], REPLAY_T),
  m('agreement-run-failure-allowed', RP, ['crossed = cross(outcome.run, solo.ok ? solo.run : null, plan)', 'crossed = cross(outcome.run, solo.ok ? solo.run : soloOf(outcome.run, plan), plan)\n      function soloOf(run, p) { const before = p.chunks.slice(0, -1).reduce((n, c) => n + c.samples, 0); const f0 = Math.floor(before / 160); const n = run.frames - f0; return { frames: n, probs: run.probs.slice(f0 * 8, (f0 + n) * 8) } }'], REPLAY_T),
  // ── New tracks, eviction, cap ──
  m('new-track-despite-overlap', W, ['if (slotTrack.has(slot) || votes.has(slot) || n < MAC_WINDOW_NEW_TRACK_FRAMES) continue', 'if (slotTrack.has(slot) || n < MAC_WINDOW_NEW_TRACK_FRAMES) continue'], UNIT_T),
  m('new-track-any-length', W, ['if (slotTrack.has(slot) || votes.has(slot) || n < MAC_WINDOW_NEW_TRACK_FRAMES) continue', 'if (slotTrack.has(slot) || votes.has(slot)) continue'], UNIT_T),
  m('track-cap-ignored', W, ['    if (id >= MAC_WINDOW_MAX_TRACKS) { capped++; continue }\n', ''], UNIT_T),
  m('no-eviction', W, ['state.tracks = state.tracks.filter(t => referenced.has(t.id))', 'state.tracks = state.tracks'], UNIT_T),
  m('eviction-drops-referenced', W, ['state.tracks = state.tracks.filter(t => referenced.has(t.id))', 'state.tracks = state.tracks.filter(t => t.voice !== null)'], UNIT_T),
  m('max-voice-ignored', W, ['      if (state.voices >= MAX_VOICE) { t.proofs.pop(); continue }\n', ''], UNIT_T),
  // ── Proof and numbering ──
  m('one-proof-confirms', W, ['    if (t.proofs.length >= MAC_WINDOW_PROOFS) {', '    if (t.proofs.length >= 1) {'], [...UNIT_T, ...MAC_T]),
  m('duplicate-audio-proof', W, ['if (t.proofs.some(p => p.chunk === current.chunk || p.audioSha256 === audioSha256)) continue', 'if (t.proofs.some(p => p.chunk === current.chunk)) continue'], UNIT_T),
  m('proof-purity-ignored', W, ['if (ex < MAC_WINDOW_PROOF_FRAMES || purity < MAC_WINDOW_PROOF_PURITY || t.voice !== null) continue', 'if (ex < MAC_WINDOW_PROOF_FRAMES || t.voice !== null) continue'], UNIT_T),
  m('proof-any-length', W, ['if (ex < MAC_WINDOW_PROOF_FRAMES || purity < MAC_WINDOW_PROOF_PURITY || t.voice !== null) continue', 'if (purity < MAC_WINDOW_PROOF_PURITY || t.voice !== null) continue'], UNIT_T),
  // ── Untrusted input ──
  m('geometry-unchecked', W, ['  if (window.frames !== macWindowFrameCount(sample)) return null\n', ''], UNIT_T),
  m('geometry-tail-fft-wrong', W, ['export const MAC_WINDOW_FFT_SAMPLES = 512', 'export const MAC_WINDOW_FFT_SAMPLES = 500'], UNIT_T),
  m('geometry-tail-window-wrong', W, ['export const MAC_WINDOW_FRAME_SAMPLES = 400', 'export const MAC_WINDOW_FRAME_SAMPLES = 399'], UNIT_T),
  m('geometry-hop-wrong', W, ['Math.round(MAC_AUDIO.sampleRate * NEMOTRON_FRAME_SEC)', 'Math.round(MAC_AUDIO.sampleRate * NEMOTRON_FRAME_SEC) + 1'], UNIT_T),
  m('window-ceiling-wrong', W, ['MAC_AUDIO.sampleRate * (MAC_AUDIO.maxChunkMs / 1000)', 'MAC_AUDIO.sampleRate * (MAC_AUDIO.maxChunkMs / 1000) - 1'], UNIT_T),
  m('values-unchecked', W, ['  for (const v of window.probs) if (!Number.isFinite(v) || v < 0 || v > 1) return null\n', ''], UNIT_T),
  m('invalid-state-accepted', W, ['if (!validMacWindowVoices(input.state) || !SHA.test(audioSha256)', 'if (!SHA.test(audioSha256)'], UNIT_T),
  m('voice-above-highwater', W, ['if (!isIndex(t.voice) || t.voice < 1 || t.voice > s.voices || voices.has(t.voice)', 'if (!isIndex(t.voice) || t.voice < 1 || voices.has(t.voice)'], UNIT_T),
  m('duplicate-voice-accepted', W, ['|| t.voice > s.voices || voices.has(t.voice) ||', '|| t.voice > s.voices ||'], UNIT_T),
  m('unproven-number-accepted', W, ['    } else if (t.proofs.length >= MAC_WINDOW_PROOFS) return false\n', '    }\n'], UNIT_T),
  m('recent-order-unchecked', W, ['if (!r || !isIndex(r.chunk) || r.chunk <= last) return false', 'if (!r || !isIndex(r.chunk)) return false'], UNIT_T),
  m('frame-codes-unchecked', W, ['codes.some(c => c < UNTRACKED || (c >= 0 && !ids.has(c)))', 'codes.some(c => c < UNTRACKED)'], UNIT_T),
  m('frame-length-cap-ignored', W, ['frames.length > 64_000 || ', ''], UNIT_T),
  // ── Plan and bounds ──
  m('plan-bridges-gap', W, ['if (!isIndex(n) || n === 0 || total + n > MAC_WINDOW_MAX_SAMPLES) break', 'if (!isIndex(n) || n === 0 || total + n > MAC_WINDOW_MAX_SAMPLES) continue'], UNIT_T),
  m('plan-sample-cap-ignored', W, ['if (!isIndex(n) || n === 0 || total + n > MAC_WINDOW_MAX_SAMPLES) break', 'if (!isIndex(n) || n === 0) break'], UNIT_T),
  m('recent-unbounded', W, ['    .slice(-(MAC_WINDOW_MAX_CHUNKS - 1))\n', ''], [...UNIT_T, ...MAC_T]),
  // ── Timeouts and fallback (QA W4) ──
  m('window-budget-per-chunk', RP, ['const timeoutMs = liveBudgetForAudioSec(windowSec)', 'const timeoutMs = 1500'], [...REPLAY_T, ...MAC_T]),
  m('timeout-no-fallback', RP, ["return outcome.reason === 'timeout' ? fallback('timeout', outcome.ms) : outcome", 'return outcome'], [...REPLAY_T, ...MAC_T]),
  m('other-failures-fall-back', RP, ["return outcome.reason === 'timeout' ? fallback('timeout', outcome.ms) : outcome", "return fallback('timeout', outcome.ms)"], REPLAY_T),
  m('geometry-no-fallback', RP, ["let crossed = cross(outcome.run, null, plan)\n    if (!crossed) return fallback('geometry', undefined)", "let crossed = cross(outcome.run, null, plan)\n    if (!crossed) return { ok: false, reason: 'bad_output' } as LiveDiarizeOutcome"], REPLAY_T),
  m('window-timeout-trips-breaker', L, ["if (RUN_FAILURES.has(reason) && !(reason === 'timeout' && options.timeoutTripsBreaker === false)) {", 'if (RUN_FAILURES.has(reason)) {'], LIVE_T),
  m('window-exempt-from-all-failures', L, ["if (RUN_FAILURES.has(reason) && !(reason === 'timeout' && options.timeoutTripsBreaker === false)) {", 'if (RUN_FAILURES.has(reason) && options.timeoutTripsBreaker !== false) {'], LIVE_T),
  m('timeout-option-ignored', L, ['timeoutMs: options.timeoutMs ?? this.budget(),', 'timeoutMs: this.budget(),'], LIVE_T),
  m('budget-not-scaled', L, ['Math.max(LIVE_BUDGET_MS, Math.ceil(LIVE_BUDGET_MS * (Number.isFinite(audioSec) ? audioSec : 0) / LIVE_BUDGET_REFERENCE_AUDIO_SEC))', 'LIVE_BUDGET_MS'], LIVE_T),
  m('window-tripping-diarize-call', TS, ['diarizeWindow: (wavPath, timeoutMs) => nemotronLive.diarize(wavPath, { timeoutMs, timeoutTripsBreaker: false }),', 'diarizeWindow: (wavPath, timeoutMs) => nemotronLive.diarize(wavPath, { timeoutMs }),'], MAC_T),
  // ── Telemetry (QA W8) ──
  m('withheld-state-not-noted', TS, ['  if (macWindowWithheld) noteMacWindowWithheld(sessionId, macWindowWithheld)\n', ''], MAC_T),
  m('withheld-noted-every-chunk', RP, ['  if (seenWithheld.has(key)) return\n', ''], REPLAY_T),
  m('window-line-not-logged', RP, ['    log(`[mac-window] chunk #${input.chunkIndex} window ${plan.chunks.length} chunks', '    void (`[mac-window] chunk #${input.chunkIndex} window ${plan.chunks.length} chunks'], REPLAY_T),
  // ── I/O half and route ──
  m('restart-after-voice-labels', RP, ["  return chunks.some(chunkShowsVoiceLabel) ? 'earlier_voice_labels' : null\n", '  return null\n'], [...REPLAY_T, ...MAC_T]),
  m('corrupt-state-accepted', RP, ["return validMacWindowVoices(saved) ? null : 'corrupt_state'", 'return null'], [...REPLAY_T, ...MAC_T]),
  m('corrupt-state-restarted', RP, [
    ['  if (macWindowWithheldReason(saved, chunks)) return null\n', "  if (macWindowWithheldReason(saved, chunks) === 'earlier_voice_labels') return null\n"],
    ['return saved === undefined ? emptyMacWindowVoices() : saved as MacWindowVoiceState', 'return saved === undefined || !validMacWindowVoices(saved) ? emptyMacWindowVoices() : saved as MacWindowVoiceState'],
  ], [...REPLAY_T, ...MAC_T]),
  m('window-wav-kept', RP, ['  let cleaned = false\n  const cleanup = () => {\n    if (cleaned) return\n    cleaned = true\n', '  let cleaned = false\n  const cleanup = () => {\n    if (cleaned || true) return\n    cleaned = true\n'], [...REPLAY_T, ...MAC_T]),
  m('channel-label-dropped', L, ['    if (label && isVoiceLabel(label)) names.set(track.channel, { speaker: label, similarity: 0 })\n  } else if (input.anonymousVoice', '  } else if (input.anonymousVoice'], MAC_T),
  m('voice-overwrites-name', L, ['    if (current && isRealLabel(current.speaker)) continue\n    const label = input.anonymousChannel(track.channel)', '    const label = input.anonymousChannel(track.channel)'], MAC_T),
  m('window-state-not-committed', TS, ['  if (macWindowNext !== undefined) session.macWindowVoices = macWindowNext\n', ''], MAC_T),
  m('window-state-not-persisted', TS, ['      ...(session.macWindowVoices !== undefined ? { macWindowVoices: session.macWindowVoices } : {}),\n', ''], MAC_T),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')

const scratch = mkdtempSync(join(tmpdir(), 'mac-window-voices-6930-mutations-'))
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
