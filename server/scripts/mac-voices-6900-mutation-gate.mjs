#!/usr/bin/env node
// 6.90.0 mutation gate: unnamed Mac recording voices (lib/nemotron-final.ts unnamedVoicePass), Voice N as a
// placeholder everywhere a name is checked, the text-only Mac rename (lib/meeting-relabel-enrolment.ts), shadow
// scoring and the Mac track tag, and the 6.89.0 nudge follow-up line. Engine copied unchanged from
// tailscale-nudge-6890-mutation-gate.mjs; mutations run only in a disposable copy of the checkout.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/mac-voices-6900-mutation-gate.mjs [--list] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FINAL_T = ['server/lib/nemotron-final-mac-voices.test.ts']
const LABEL_T = ['server/lib/mac-voice-labels.test.ts']
const RELABEL_T = ['server/routes/meeting-relabel-route.test.ts']
const STORE_T = ['server/lib/meeting-store.test.ts']
const REVIEW_T = ['server/lib/meeting-speaker-review.test.ts']
const MAC_T = ['server/routes/mac-recording.test.ts']
const NUDGE_T = ['server/lib/tailscale-nudge.test.ts']
const OLD_FINAL_T = ['server/lib/nemotron-final.test.ts']
const ALL = [...FINAL_T, ...LABEL_T, ...RELABEL_T, ...STORE_T, ...REVIEW_T, ...MAC_T, ...NUDGE_T, ...OLD_FINAL_T]
const F = 'server/lib/nemotron-final.ts', V = 'server/lib/mac-voice-labels.ts', E = 'server/lib/meeting-relabel-enrolment.ts'
const R = 'server/lib/meeting-speaker-review.ts', S = 'server/lib/meeting-store.ts', B = 'server/lib/meeting-batch-transcribe.ts'
const L = 'server/lib/nemotron-live.ts', RL = 'server/lib/meeting-relabel.ts', SE = 'server/lib/speaker-embeddings.ts'
const TS = 'server/routes/transcribe-stream.ts', N = 'server/lib/tailscale-nudge.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Eligibility: only a Mac strict capture, switch on, no real name ──
  m('switch-ignored', F, ['  if (!macVoiceLabelsEnabled(env) || !isMacCaptureSidecar(sidecar)) return false', '  if (!isMacCaptureSidecar(sidecar)) return false'], FINAL_T),
  m('any-strict-capture', F, ['  if (!macVoiceLabelsEnabled(env) || !isMacCaptureSidecar(sidecar)) return false', '  if (!macVoiceLabelsEnabled(env)) return false'], FINAL_T),
  m('real-name-overwritten', F, ["spoken.every(chunk => chunk.speakerPolicy === 'high-confidence' && !isName(chunk.speaker))", "spoken.every(chunk => chunk.speakerPolicy === 'high-confidence')"], FINAL_T),
  m('spoken-policy-unchecked', F, ["spoken.every(chunk => chunk.speakerPolicy === 'high-confidence' && !isName(chunk.speaker))", 'spoken.every(chunk => !isName(chunk.speaker))'], FINAL_T),
  m('silent-entries-any-policy', F, ["    .every(entry => entry.chunk?.speakerPolicy === undefined || entry.chunk.speakerPolicy === 'high-confidence')", '    .every(() => true)'], FINAL_T),
  m('silent-entries-must-be-marked', F, ["    .every(entry => entry.chunk?.speakerPolicy === undefined || entry.chunk.speakerPolicy === 'high-confidence')", "    .every(entry => entry.chunk.speakerPolicy === 'high-confidence')"], FINAL_T),
  m('no-spoken-allowed', F, ['  if (!spoken.length) return false\n', ''], FINAL_T),
  m('switch-default-off', V, ["  return !['0', 'false', 'off', 'no'].includes(raw)", "  return raw === '1'"], [...FINAL_T, ...LABEL_T]),
  m('mac-sourcetype-ignored', V, ['  if (sidecar.sourceType === MAC_SOURCE_TYPE) return true\n', ''], [...LABEL_T, ...RELABEL_T]),
  m('mac-id-ignored', V, ["  if (typeof sessionId === 'string' && sessionId.startsWith('mac_')) return true\n", ''], [...LABEL_T, ...RELABEL_T]),
  // ── The pass: crowded, unconfident, numbering, consistency ──
  m('crowded-never', F, ['  const crowded = isCrowded(found.channels.length, channelsUsed)\n  if (crowded) {', '  const crowded = false\n  if (crowded) {'], FINAL_T),
  m('unconfident-proceeds', F, ['  if (!labelled || !channels.length) return {', '  if (false) return {'], FINAL_T),
  m('unconfident-other-reason', F, ["  if (!labelled || !channels.length) return { status: 'skipped', reason: 'voices_unconfident'", "  if (!labelled || !channels.length) return { status: 'skipped', reason: 'no_change'"], FINAL_T),
  m('support-floor-one', F, ['accepted: row.support >= minSupport', 'accepted: row.support >= 1'], FINAL_T),
  m('one-sided-ignored', F, ['    if (counts[dom] / speech < oneSided) continue\n    eligible++', '    eligible++'], FINAL_T),
  m('numbered-by-channel', F, ['.sort((x, y) => x[1].firstSec - y[1].firstSec || x[0] - y[0])', '.sort((x, y) => x[0] - y[0])'], FINAL_T),
  m('orphans-kept', F, ['    if (kept.length === channels.length) { labelled = attempt; break }', '    labelled = attempt; break'], FINAL_T),
  m('chunks-not-labelled', F, ['      chunk.speaker = label\n      if (label !== original) chunk.originalSpeaker = original', '      if (label !== original) chunk.originalSpeaker = original'], FINAL_T),
  m('original-not-kept', F, ['      chunk.speaker = label\n      if (label !== original) chunk.originalSpeaker = original', '      chunk.speaker = label\n      if (false) chunk.originalSpeaker = original'], FINAL_T),
  m('batch-segments-dropped', F, ['    nextSidecar.batchSegments = labelled.batchSegments\n', ''], FINAL_T),
  m('unnamed-label-not-recorded', F, ["    labels: 'unnamed',\n", ''], FINAL_T),
  m('final-segments-dropped', F, ['      if (final) chunk.finalSegments = final.segments\n', ''], FINAL_T),
  // ── Voice N is a placeholder ──
  m('voice-label-any-number', V, ['export const VOICE_LABEL = /^Voice [1-9]\\d?$/', 'export const VOICE_LABEL = /^Voice \\d+$/'], LABEL_T),
  m('unattributed-voice-dropped', R, [' || isVoiceLabel(label)\n}', '\n}'], [...LABEL_T, ...REVIEW_T, ...FINAL_T]),
  m('enrol-placeholder-voice-dropped', E, ['|speaker\\s*\\d+|voice\\s+[1-9]\\d?)$/i', '|speaker\\s*\\d+)$/i'], [...LABEL_T, ...RELABEL_T]),
  m('store-speakers-voice', S, [".filter(speaker => speaker && speaker !== 'Ext' && !isVoiceLabel(speaker)))],", ".filter(speaker => speaker && speaker !== 'Ext'))],"], STORE_T),
  m('batch-speakers-voice', B, ["  return Boolean(speaker) && speaker !== 'Ext' && !isVoiceLabel(speaker)", "  return Boolean(speaker) && speaker !== 'Ext'"], LABEL_T),
  m('real-label-voice', L, ["value !== 'Ext' && !isVoiceLabel(value)", "value !== 'Ext'"], LABEL_T),
  m('relabel-pushes-voice', RL, ['  if (isVoiceLabel(to)) {', '  if (false) {'], LABEL_T),
  // ── Text-only Mac rename ──
  m('mac-enrol-guard-removed', E, ["  if (isMacCaptureSidecar(sidecar, sessionId)) return { ...IDLE, skipped: 'mac_capture' }\n", ''], RELABEL_T),
  // ── Shadow scoring and the Mac track tag ──
  m('shadow-not-passed', TS, ["event: 'mac-system-audio', shadowEvent: MAC_SHADOW_EVENT }", "event: 'mac-system-audio' }"], MAC_T),
  m('shadow-floor-raised', SE, ['export const SHADOW_FLOOR = SEARCH_THRESHOLD', 'export const SHADOW_FLOOR = 0.88'], LABEL_T),
  m('shadow-similarity-zero', SE, ['    return { speaker: found, similarity: (lo + hi) / 2 }', '    return { speaker: found, similarity: 0 }'], LABEL_T),
  m('mac-track-owner-first', TS, ['            ...(mac ? { prioritizeOwner: false } : {}),\n', ''], MAC_T),
  m('mac-track-untagged', TS, ["            event: mac ? MAC_TRACK_EVENT : 'nemotron-track',", "            event: 'nemotron-track',"], MAC_T),
  // ── 6.89.0 follow-up: the already-back line ──
  m('already-back-silent', N, ['    if (eligible.some(backSince)) this.log(`[tailscale-nudge] trigger=${pending.trigger} outcome=already_reconnected`)\n', ''], NUDGE_T),
  m('already-back-always', N, ['    if (eligible.some(backSince)) this.log(', '    if (true) this.log('], NUDGE_T),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')

const scratch = mkdtempSync(join(tmpdir(), 'mac-voices-6900-mutations-'))
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
  console.log(`${killed} of ${selected.length} Mac voice labels 6.90.0 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
