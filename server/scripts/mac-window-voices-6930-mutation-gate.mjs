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
const MAC_T = ['server/routes/mac-recording.test.ts']
const ALL = [...UNIT_T, ...MAC_T]
const W = 'server/lib/mac-window-voices.ts', RP = 'server/lib/mac-window-replay.ts', L = 'server/lib/nemotron-live.ts', TS = 'server/routes/transcribe-stream.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Switch ──
  m('switch-default-on', W, ["=== 'window' && macVoiceLabelsEnabled(env)", "!== 'off' && macVoiceLabelsEnabled(env)"], UNIT_T),
  m('switch-ignores-voice-labels', W, ["=== 'window' && macVoiceLabelsEnabled(env)", "=== 'window'"], [...UNIT_T, ...MAC_T]),
  // ── Carry across the boundary ──
  m('carry-min-ignored', W, ['if (c.count < MAC_WINDOW_CARRY_MIN_FRAMES || ', 'if ('], UNIT_T),
  m('carry-agreement-ignored', W, [' || c.count / exclusiveInOverlap.get(c.slot)! < MAC_WINDOW_CARRY_AGREEMENT) continue', ') continue'], UNIT_T),
  m('carry-not-one-to-one', W, ['if (slotTrack.has(c.slot) || usedTracks.has(c.track)) continue', 'if (slotTrack.has(c.slot)) continue'], UNIT_T),
  // ── New tracks ──
  m('new-track-despite-overlap', W, ['if (slotTrack.has(slot) || votes.has(slot) || n < MAC_WINDOW_NEW_TRACK_FRAMES) continue', 'if (slotTrack.has(slot) || n < MAC_WINDOW_NEW_TRACK_FRAMES) continue'], UNIT_T),
  m('new-track-any-length', W, ['if (slotTrack.has(slot) || votes.has(slot) || n < MAC_WINDOW_NEW_TRACK_FRAMES) continue', 'if (slotTrack.has(slot) || votes.has(slot)) continue'], UNIT_T),
  m('track-cap-ignored', W, ['    if (state.nextTrack >= MAC_WINDOW_MAX_TRACKS) continue\n', ''], UNIT_T),
  // ── Proof and numbering ──
  m('one-proof-confirms', W, ['    if (t.proofs.length >= MAC_WINDOW_PROOFS) {', '    if (t.proofs.length >= 1) {'], [...UNIT_T, ...MAC_T]),
  m('duplicate-audio-proof', W, ['if (t.proofs.some(p => p.chunk === current.chunk || p.audioSha256 === audioSha256)) continue', 'if (t.proofs.some(p => p.chunk === current.chunk)) continue'], UNIT_T),
  m('proof-purity-ignored', W, ['if (ex < MAC_WINDOW_PROOF_FRAMES || purity < MAC_WINDOW_PROOF_PURITY || t.voice !== null) continue', 'if (ex < MAC_WINDOW_PROOF_FRAMES || t.voice !== null) continue'], UNIT_T),
  m('proof-any-length', W, ['if (ex < MAC_WINDOW_PROOF_FRAMES || purity < MAC_WINDOW_PROOF_PURITY || t.voice !== null) continue', 'if (purity < MAC_WINDOW_PROOF_PURITY || t.voice !== null) continue'], UNIT_T),
  // ── Untrusted input ──
  m('geometry-unchecked', W, ['  if (window.frames !== expectedFrames) return null\n', ''], UNIT_T),
  m('values-unchecked', W, ['  for (const v of window.probs) if (!Number.isFinite(v) || v < 0 || v > 1) return null\n', ''], UNIT_T),
  m('invalid-state-accepted', W, ['if (!validMacWindowVoices(input.state) || !SHA.test(audioSha256)', 'if (!SHA.test(audioSha256)'], UNIT_T),
  m('voice-above-highwater', W, ['if (!isIndex(t.voice) || t.voice < 1 || t.voice > s.voices || voices.has(t.voice)', 'if (!isIndex(t.voice) || t.voice < 1 || voices.has(t.voice)'], UNIT_T),
  m('duplicate-voice-accepted', W, ['|| t.voice > s.voices || voices.has(t.voice) ||', '|| t.voice > s.voices ||'], UNIT_T),
  m('unproven-number-accepted', W, ['    } else if (t.proofs.length >= MAC_WINDOW_PROOFS) return false\n', '    }\n'], UNIT_T),
  m('recent-order-unchecked', W, ['if (!r || !isIndex(r.chunk) || r.chunk <= last) return false', 'if (!r || !isIndex(r.chunk)) return false'], UNIT_T),
  m('frame-codes-unchecked', W, ['if (!codes || codes.length === 0 || codes.some(c => c < UNTRACKED || c >= s.nextTrack)) return false', 'if (!codes || codes.length === 0) return false'], UNIT_T),
  // ── Plan and bounds ──
  m('plan-bridges-gap', W, ['if (!isIndex(n) || n === 0 || total + n > MAC_WINDOW_MAX_SAMPLES) break', 'if (!isIndex(n) || n === 0 || total + n > MAC_WINDOW_MAX_SAMPLES) continue'], UNIT_T),
  m('plan-sample-cap-ignored', W, ['if (!isIndex(n) || n === 0 || total + n > MAC_WINDOW_MAX_SAMPLES) break', 'if (!isIndex(n) || n === 0) break'], UNIT_T),
  m('recent-unbounded', W, ['    .slice(-(MAC_WINDOW_MAX_CHUNKS - 1))\n', ''], [...UNIT_T, ...MAC_T]),
  // ── I/O half and route ──
  m('restart-after-voice-labels', RP, ['  if (chunks.some(c => isVoiceLabel(c?.speaker) || c?.segments?.some(s => isVoiceLabel(s?.speaker)))) return null\n', ''], MAC_T),
  m('corrupt-state-restarted', RP, ['return validMacWindowVoices(saved) ? saved : null', 'return validMacWindowVoices(saved) ? saved : emptyMacWindowVoices()'], MAC_T),
  m('window-wav-kept', RP, ['}).finally(cleanup)', '}).finally(() => {})'], MAC_T),
  m('channel-label-dropped', L, ['    if (label && isVoiceLabel(label)) names.set(track.channel, { speaker: label, similarity: 0 })\n  } else if (input.anonymousVoice', '  } else if (input.anonymousVoice'], MAC_T),
  m('voice-overwrites-name', L, ['    if (current && isRealLabel(current.speaker)) continue\n    const label = input.anonymousChannel(track.channel)', '    const label = input.anonymousChannel(track.channel)'], MAC_T),
  m('anchors-also-run', TS, ['macVoiceLabelsEnabled() && !macWindowVoicesEnabled() ? {', 'macVoiceLabelsEnabled() ? {'], MAC_T),
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
