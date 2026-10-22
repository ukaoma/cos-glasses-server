#!/usr/bin/env node
// 6.86.0 mutation gate: cue kinds opt-in per meeting, live cues on Mac recordings (arm, resume, kill switch), the newest
// provisional line for COS Control, and the capabilities that advertise them. Mutations run only in a disposable copy of
// the checkout; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/live-meeting-6860-mutation-gate.mjs [--list] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const KINDS_T = ['server/lib/live-cues-v2-kinds.test.ts']
const MAC_T = ['server/routes/mac-recording-live-cues.test.ts']
const PROV_T = ['server/routes/transcribe-stream-provisional.test.ts']
const HEALTH_T = ['server/routes/health-live-meeting.test.ts']
const ROUTE_T = ['server/routes/live-cues-v2-route.test.ts']
const ALL = [...KINDS_T, ...MAC_T, ...PROV_T, ...HEALTH_T, ...ROUTE_T, 'server/lib/live-cues-v2.test.ts', 'server/lib/live-cue-verdicts.test.ts']
const ENGINE = 'server/lib/live-cues-v2.ts', SHARED = 'shared/live-cues-v2.ts', STREAM = 'server/routes/transcribe-stream.ts'
const PROV = 'server/lib/live-provisional.ts', HEALTH = 'server/routes/health.ts', ROUTE = 'server/routes/live-cues.ts'
const LIB = 'server/lib/live-cue-verdicts.ts', PROMPT = 'server/lib/live-cues-v2-prompts-kinds.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Kinds: the contract ──
  m('contract-new-kinds-valid', SHARED, ['    && isCueKind(v.kind)\n', "    && (v.kind === 'reinforce' || v.kind === 'challenge')\n"], KINDS_T),
  m('contract-legacy-map', SHARED, ["return kind === 'reinforce' || kind === 'decision' || kind === 'promise' ? 'reinforce' : 'challenge'", "return kind === 'reinforce' ? 'reinforce' : 'challenge'"], KINDS_T),
  m('log-row-new-kinds', LIB, ['&& isCueKind(r.kind)', "&& (r.kind === 'reinforce' || r.kind === 'challenge')"], KINDS_T),
  // ── Kinds: the engine ──
  m('parse-kind-inside-set', ENGINE, ['typeof value.kind === \'string\' && (allowed as readonly string[]).includes(value.kind)', 'typeof value.kind === \'string\' && (CUE_KINDS as readonly string[]).includes(value.kind)'], KINDS_T),
  m('parse-default-legacy', ENGINE, ['  allowed: readonly CueKind[] = LEGACY_CUE_KINDS): ParsedCue | CueRejection {', '  allowed: readonly CueKind[] = CUE_KINDS): ParsedCue | CueRejection {'], KINDS_T),
  m('engine-legacy-set-for-legacy', ENGINE, ["        s.kinds === 'extended' ? CUE_KINDS : LEGACY_CUE_KINDS)", '        CUE_KINDS)'], KINDS_T),
  m('engine-extended-set-for-extended', ENGINE, ["        s.kinds === 'extended' ? CUE_KINDS : LEGACY_CUE_KINDS)", '        LEGACY_CUE_KINDS)'], KINDS_T),
  m('default-mac-extended', ENGINE, ["  return MAC_CAPTURE_ID.test(sessionId) ? 'extended' : 'legacy'", "  return 'legacy'"], KINDS_T),
  m('default-mac-strict-id', ENGINE, ["  return MAC_CAPTURE_ID.test(sessionId) ? 'extended' : 'legacy'", "  return sessionId.startsWith('mac_') ? 'extended' : 'legacy'"], KINDS_T),
  m('arm-honours-kinds', ENGINE, ['    const kinds = opts.kinds ?? defaultCueKindSet(sessionId)', '    const kinds = defaultCueKindSet(sessionId)'], KINDS_T),
  m('arm-keeps-first-kinds', ENGINE, ['      return answer(existing.cues.length, existing.kinds)', '      return answer(existing.cues.length, opts.kinds ?? existing.kinds)'], KINDS_T),
  m('writer-v4-for-extended', ENGINE, ["  if (kinds === 'extended') return { version: 'v4', system: CUE_WRITER_SYSTEM_V4 }\n", ''], KINDS_T),
  m('writer-gets-meeting-kinds', ENGINE, ['liveCuesV2WriterSystem(this.deps.env, s.kinds)', 'liveCuesV2WriterSystem(this.deps.env)'], KINDS_T),
  m('v1-twin-legacy-type', ENGINE, ['type: legacyCueKind(cue.kind), priority: 2, cueId: cue.cueId', 'type: cue.kind, priority: 2, cueId: cue.cueId'], KINDS_T),
  m('stop-nudges-legacy-type', ENGINE, ['type: legacyCueKind(c.kind), priority: 2, timestamp', 'type: c.kind, priority: 2, timestamp'], KINDS_T),
  m('trace-kind-set', ENGINE, ["      if (s.kinds === 'extended') trace.kindSet = 'extended'\n", ''], KINDS_T),
  m('mac-title', ENGINE, ["const title = `${mac ? 'Mac' : 'G2'} Recording", 'const title = `G2 Recording'], KINDS_T),
  m('v4-schema-kinds', PROMPT, ["export const V4_SCHEMA_KIND = '\"kind\":\"reinforce|challenge|decision|promise|followUp\"'", "export const V4_SCHEMA_KIND = '\"kind\":\"reinforce|challenge\"'"], KINDS_T),
  m('v4-rule-3', PROMPT, ["'3. Five kinds. reinforce:", "'3. Two kinds. reinforce:"], KINDS_T),
  // ── Mac recordings ──
  m('mac-kill-switch-arm', ENGINE, ["    if (mac && !liveCuesV2MacAllowed(this.deps.env)) throw new LiveCuesV2ArmError('mac_cues_off'", "    if (false) throw new LiveCuesV2ArmError('mac_cues_off'"], KINDS_T),
  m('mac-kill-switch-trim', ENGINE, ["return (env.COS_LIVE_CUES_V2_MAC ?? '').trim() !== '0'", "return (env.COS_LIVE_CUES_V2_MAC ?? '') !== '0'"], KINDS_T),
  m('armmac-off-never-builds', ENGINE, ["  if (!liveCuesV2Enabled(env)) return { armed: false, reason: 'master_flag_off' }\n", ''], KINDS_T),
  m('armmac-kill-never-builds', ENGINE, ["  if (!liveCuesV2MacAllowed(env)) return { armed: false, reason: 'mac_cues_off' }\n", ''], KINDS_T),
  m('armmac-resume', ENGINE, ['    const a = liveCuesV2().arm(sessionId, { resume: true })', '    const a = liveCuesV2().arm(sessionId)'], KINDS_T),
  m('armmac-refusal-is-answer', ENGINE, ["    return { armed: false, reason: error instanceof LiveCuesV2ArmError ? error.code : 'unavailable' }", '    throw error'], KINDS_T),
  m('contract-mac-flag', 'managed-runtime-contract.json', ['    "COS_LIVE_CUES_V2_MAC",\n', ''], KINDS_T),
  // ── Resume ──
  m('resume-feed-rearms', ENGINE, ["      if (this.deps.env.COS_LIVE_CUES_AUTO !== '1' && !resume) return", "      if (this.deps.env.COS_LIVE_CUES_AUTO !== '1') return"], KINDS_T),
  m('resume-feed-kinds', ENGINE, ['      try { this.arm(sessionId, resume ? { kinds: resume } : {}) } catch { return }', '      try { this.arm(sessionId, {}) } catch { return }'], KINDS_T),
  m('resume-trace', ENGINE, ["      if (resume) this.deps.trace({ kind: 'resume',", "      if (false) this.deps.trace({ kind: 'resume',"], KINDS_T),
  m('resume-set-on-arm', ENGINE, ['    if (opts.resume) this.deps.store.setResume(sessionId, kinds)\n', ''], KINDS_T),
  m('resume-set-on-rearm', ENGINE, ['      if (opts.resume) this.deps.store.setResume(sessionId, existing.kinds)\n', ''], KINDS_T),
  m('resume-cleared-at-end', ENGINE, ['delete s.paused[sessionId]; delete s.resume[sessionId]; this.write(s) }', 'delete s.paused[sessionId]; this.write(s) }'], KINDS_T),
  m('resume-ttl', ENGINE, ['        && r.at >= nowMs - LIVE_CUES_V2_LIMITS.counterTtlMs && (r.kinds', '        && (r.kinds'], KINDS_T),
  m('resume-kinds-checked', ENGINE, ["(r.kinds === 'legacy' || r.kinds === 'extended'))", 'true)'], KINDS_T),
  m('resume-persisted', ENGINE, ['ended, paused, pauseSeq, meetings, day, today, resume }', 'ended, paused, pauseSeq, meetings, day, today, resume: {} }'], KINDS_T),
  m('resume-never-for-ended', ENGINE, ['    if (sessionId in s.ended || s.resume[sessionId]?.kinds === kinds) return', '    if (s.resume[sessionId]?.kinds === kinds) return'], KINDS_T),
  // ── Mac start route ──
  m('start-flag-checked', STREAM, ["    if (req.body.liveCues !== undefined && typeof req.body.liveCues !== 'boolean') throw macError(400, 'invalid_live_cues'", "    if (false) throw macError(400, 'invalid_live_cues'"], MAC_T),
  m('start-arms-only-on-true', STREAM, ['    if (req.body.liveCues === true) {', '    if (req.body.liveCues !== undefined) {'], MAC_T),
  m('start-arm-cannot-fail-start', STREAM, ["      try { liveCues = armMacLiveCues(recording.sessionId) } catch { liveCues = { armed: false, reason: 'unavailable' } }", '      liveCues = armMacLiveCues(recording.sessionId)'], MAC_T),
  // ── live cues start route ──
  m('route-kinds-checked', ROUTE, ["  if (kinds !== undefined && kinds !== 'legacy' && kinds !== 'extended') {", '  if (false) {'], ROUTE_T),
  m('route-kinds-passed', ROUTE, ['liveCuesV2().arm(sessionId, kinds ? { kinds } : {})', 'liveCuesV2().arm(sessionId)'], ROUTE_T),
  // ── Provisional ──
  m('prov-noted-from-preview', STREAM, ['      noteLiveProvisional(sessionId, chunkIndex, previewGen, cleaned, result.model)\n', ''], PROV_T),
  m('prov-settled-by-canonical', STREAM, ['  liveProvisional().settle(sessionId, chunkIndex)\n', ''], PROV_T),
  m('prov-cleared-on-close', STREAM, ['  liveProvisional().clear(sessionId)\n', ''], PROV_T),
  m('prov-only-live-session', STREAM, ['  const session = sessions.get(sessionId)\n  if (!session) return\n  const completed', '  const session = sessions.get(sessionId)\n  const completed'], PROV_T),
  m('prov-stale-chunk-refused', STREAM, ['  if (completed.length && chunkIndex <= completed[completed.length - 1]) return\n', ''], PROV_T),
  m('prov-route-live-gate', STREAM, ['  const held = live ? liveProvisional().read(sessionId) : null', '  const held = liveProvisional().read(sessionId)'], PROV_T),
  m('prov-route-id-checked', STREAM, ["  if (!/^[A-Za-z0-9:_-]{3,96}$/.test(sessionId)) return void res.status(400).json({ error: 'invalid sessionId', reason: 'invalid_session_id' })\n  const live", '  const live'], PROV_T),
  m('prov-route-no-store', STREAM, ["transcribeStreamRouter.get('/transcribe-stream/provisional', (req, res) => {\n  res.set('Cache-Control', 'private, no-store')\n", "transcribeStreamRouter.get('/transcribe-stream/provisional', (req, res) => {\n"], PROV_T),
  m('prov-keeps-tail', PROV, ['.slice(-LIVE_PROVISIONAL_LIMITS.maxChars)', '.slice(0, LIVE_PROVISIONAL_LIMITS.maxChars)'], PROV_T),
  m('prov-empty-refused', PROV, ['    if (!text) return false\n', ''], PROV_T),
  m('prov-older-chunk-refused', PROV, ['(entry.chunkIndex < held.chunkIndex || (entry.chunkIndex === held.chunkIndex && entry.previewGen <= held.previewGen))', '(entry.chunkIndex === held.chunkIndex && entry.previewGen <= held.previewGen)'], PROV_T),
  m('prov-same-gen-refused', PROV, ['entry.previewGen <= held.previewGen', 'entry.previewGen < held.previewGen'], PROV_T),
  m('prov-stale-held-no-block', PROV, ['if (held && !this.expired(held) && (entry.chunkIndex', 'if (held && (entry.chunkIndex'], PROV_T),
  m('prov-reinsert-newest', PROV, ['    this.entries.delete(sessionId)                      // re-insert', '    void 0                      // re-insert'], PROV_T),
  m('prov-session-cap', PROV, ['    while (this.entries.size > LIVE_PROVISIONAL_LIMITS.maxSessions) {', '    while (false) {'], PROV_T),
  m('prov-settle-earlier-only', PROV, ['if (held && held.chunkIndex <= chunkIndex) this.entries.delete(sessionId)', 'if (held) this.entries.delete(sessionId)'], PROV_T),
  m('prov-ttl', PROV, ['private expired(e: LiveProvisional): boolean { return this.now() - e.at > LIVE_PROVISIONAL_LIMITS.ttlMs }', 'private expired(e: LiveProvisional): boolean { return false }'], PROV_T),
  m('prov-ttl-inclusive', PROV, ['return this.now() - e.at > LIVE_PROVISIONAL_LIMITS.ttlMs }', 'return this.now() - e.at >= LIVE_PROVISIONAL_LIMITS.ttlMs }'], PROV_T),
  // ── Capabilities ──
  m('health-kinds', HEALTH, ['      liveCues: withCueKinds(liveCues),', '      liveCues,'], HEALTH_T),
  m('models-kinds', HEALTH, ['      liveCues: withCueKinds(liveCuesCapability()),', '      liveCues: liveCuesCapability(),'], HEALTH_T),
  m('health-live-meeting', HEALTH, ['      liveMeeting: liveMeetingCapability(),\n      // 6.77.0', '      // 6.77.0'], HEALTH_T),
  m('models-live-meeting', HEALTH, ['      liveMeeting: liveMeetingCapability(),\n      richMedia: {\n        video:', '      richMedia: {\n        video:'], HEALTH_T),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')

const scratch = mkdtempSync(join(tmpdir(), 'live-meeting-6860-mutations-'))
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
  console.log(`${killed} of ${selected.length} live meeting 6.86.0 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
