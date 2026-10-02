#!/usr/bin/env node
// 6.61.0 Nemotron mutation gate. Mutations run only in a disposable copy of server/, shared/
// and bin/; the live checkout is never rewritten. The unmutated suites must pass first (a gate
// over a red suite proves nothing), each target must match exactly once, and each mutant must
// fail the NAMED test written for it (a transform or compile error fails the file, not a named
// test, so it never counts as a kill).
//
// Covers the 2026-10-02 brief: the backend choice and offline models, the CLI run (models flag,
// budget kill, exit codes, frame check), word-to-track mapping and the estimated timing, the
// naming rules (one track, long tracks, short dominant, short other: client or Ext), the
// fallbacks (timeout, failure, missing CLI, warming, busy, bounded warm-up, re-warm), honest
// counts and logs, the chunk response contract and storage, and the final pass (timeline,
// hash check, trim, map floors, one-sided evidence, word preservation, human corrections,
// original labels, idempotency, a failed pass saving as today, and its place before sync).
//
// Usage: node server/scripts/nemotron-mutation-gate.mjs [--list] [name...]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BACKEND = 'server/lib/diarizer-backend.ts'
const CLI = 'server/lib/nemotron-cli.ts'
const SEG = 'server/lib/nemotron-segments.ts'
const LIVE = 'server/lib/nemotron-live.ts'
const FINAL = 'server/lib/nemotron-final.ts'
const STREAM = 'server/routes/transcribe-stream.ts'
const MEETING = 'server/routes/meeting.ts'
const HEALTH = 'server/routes/health.ts'
const FLOOR = 'server/lib/voiceprint-floor.ts'
const BACKEND_T = ['server/lib/diarizer-backend.test.ts']
const CLI_T = ['server/lib/nemotron-cli.test.ts']
const SEG_T = ['server/lib/nemotron-segments.test.ts']
const LIVE_T = ['server/lib/nemotron-live.test.ts']
const FINAL_T = ['server/lib/nemotron-final.test.ts']
const ROUTE_T = ['server/routes/transcribe-stream-nemotron.test.ts']
const MEETING_T = ['server/routes/meeting.test.ts']
const HEALTH_T = ['server/routes/health.test.ts']
const PRIVACY_T = ['server/routes/health-diarizer-privacy.test.ts']
const RELABEL_T = ['server/routes/meeting-relabel-route.test.ts']
const RECOVERY_T = ['server/routes/transcribe-stream-recovery-segments.test.ts']
const ENROL = 'server/lib/meeting-relabel-enrolment.ts'
const PRESSURE = 'QA 6.61.0: the final pass'

const SHORT = 'naming a short track: the dominant takes the chunk voiceprint'
const COLD = 'a cold model: chunks before the warm-up finishes are `warming`, then Nemotron runs'
const CONTRACT = 'adds segments in time order and keeps the legacy fields intact'
const CONSISTENT = 'final relabel with consistent tracks: one map for the whole meeting, original labels kept'
const SHARED = 'a channel two people share stays unmapped, and too little evidence maps nothing'

// [name, file, exact target, replacement, a substring of the test that must fail, tests]
const mutations = [
  // Backend: default, offline models, honest static fallbacks
  ['default-not-nemotron', BACKEND, "(env.COS_DIARIZER ?? 'nemotron')", "(env.COS_DIARIZER ?? 'embedding')", 'defaults to nemotron', BACKEND_T],
  ['cli-check-skipped', BACKEND, "  if (!nemotronCliPath(env, home)) return { requested, active: 'embedding', fallback: 'cli_missing' }\n", '', 'falls back when Nemotron is requested and the CLI is missing', BACKEND_T],
  ['models-check-skipped', BACKEND, "  if (!nemotronModelSource(env, home)) return { requested, active: 'embedding', fallback: 'models_missing' }\n", '', 'falls back when the CLI exists but no local models do', BACKEND_T],
  ['override-falls-through', BACKEND, "    return modelsDirComplete(dir) ? { dir, source: 'env' } : null\n", "    if (modelsDirComplete(dir)) return { dir, source: 'env' }\n", 'an explicit COS_NEMOTRON_MODELS that is incomplete', BACKEND_T],
  ['cache-not-linked', BACKEND, '      symlinkSync(target, link)\n', '', 'links the FluidAudio cache into one directory', BACKEND_T],
  // The CLI run
  ['no-models-flag', CLI, "    '--models', modelsDir,\n", '', 'always passes the local models', CLI_T],
  ['timeout-not-killed', CLI, "      try { child.kill('SIGKILL') } catch { /* already gone */ }\n", '', 'SIGKILL at the budget', CLI_T],
  ['exit-code-ignored', CLI, '      if (code !== 0) {\n', '      if (false) {\n', 'a non-zero exit is cli_failed', CLI_T],
  ['frames-unchecked', CLI, '  if (preds.length !== expected) {\n', '  if (false) {\n', 'preds that do not match the frame count are bad_output', CLI_T],
  // Geometry
  ['threshold-off', SEG, 'export const ACTIVE_THRESHOLD = 0.5\n', 'export const ACTIVE_THRESHOLD = 0.01\n', 'a silent span takes the nearest active channel', SEG_T],
  ['pad-not-applied', SEG, '  return pick(f0 - pad, f1 + pad)\n', '  return null\n', 'a silent span takes the nearest active channel', SEG_T],
  ['min-track-ignored', SEG, '    if (active[c] / FPS >= minTrackSec) tracks.push(', '    if (active[c] > 0) tracks.push(', 'ignores a channel shorter than half a second', SEG_T],
  ['snap-never-moves', SEG, "        if (PUNCT_END.test(tokens[cand - 1] ?? '')) { target = cand; break }\n", '', 'moves a mid-phrase boundary to the phrase end', SEG_T],
  ['flicker-kept', SEG, '    if (i > 0 && j + 1 < out.length && out[i - 1] === out[j + 1] && words <= 1 && span < minSec) {\n', '    if (false) {\n', 'absorbs a one-word flicker', SEG_T],
  ['exclusive-includes-overlap', SEG, '    if (others) continue\n', '', 'cuts only the frames where the track speaks alone', SEG_T],
  ['word-clocks-ignored', LIVE, '  let times: TokenTime[] | null = input.words?.length ? tokenTimesFromWords(tokens, input.words) : null\n', '  let times: TokenTime[] | null = null\n', 'uses whisper word clocks when the ASR gives them', LIVE_T],
  // Naming
  ['single-track-identified', LIVE, '  if (ordered.length === 1) {\n', '  if (false) {\n', 'a one-track chunk takes the whole-chunk voiceprint', LIVE_T],
  ['short-track-identified', LIVE, '      if (track.exclusiveSec >= NAME_TRACK_MIN_SEC && pcm) {\n', '      if (pcm) {\n', SHORT, LIVE_T],
  ['client-guard-counts-dominant', LIVE, '      if (isRealLabel(client) && client !== dominantName) ownerGuard.client_label++\n', '      if (isRealLabel(client)) ownerGuard.client_label++\n', SHORT, LIVE_T],
  ['unknown-is-a-name', LIVE, "  return value.length > 0 && value !== 'Unknown' && value !== 'Ext'\n", '  return value.length > 0\n', SHORT, LIVE_T],
  ['speaker-from-wordless-voice', LIVE, '    if (!names.has(track.channel) || !used.has(track.channel)) continue\n', '    if (!names.has(track.channel)) continue\n', 'the chunk speaker is the voice that carries the words', LIVE_T],
  ['track-name-not-used', LIVE, '        if (named) { names.set(track.channel, ownerSafe(named)); identified++; continue }\n', '', 'two long tracks are each named by the voiceprint', LIVE_T],
  // Fallbacks and the runtime
  ['fallback-reason-dropped', LIVE, "    diarizer: { engine: 'voiceprint', fallback: reason },\n", "    diarizer: { engine: 'voiceprint' },\n", 'fallback on timeout: the voiceprint label, no segments, the reason recorded', LIVE_T],
  ['config-counts-as-fallback', LIVE, "    if (outcome.reason === 'embedding_requested' || STATIC_REASONS.has(outcome.reason)) {\n", "    if (STATIC_REASONS.has(outcome.reason)) {\n", 'the voiceprint chosen by config is not a fallback and records nothing', LIVE_T],
  ['static-reason-stamped', LIVE, "    if (outcome.reason === 'embedding_requested' || STATIC_REASONS.has(outcome.reason)) {\n", "    if (outcome.reason === 'embedding_requested') {\n", 'fallback on a missing CLI or models', LIVE_T],
  ['busy-not-refused', LIVE, "    if (this.inFlight >= this.maxConcurrent()) return 'busy'\n", '', 'caps concurrency', LIVE_T],
  ['warming-not-gated', LIVE, "    if (this.state === 'warming') return 'warming'\n", '', COLD, LIVE_T],
  ['live-not-on-ane', LIVE, "        timeoutMs: this.budget(),\n        computeUnits: 'ane',\n", "        timeoutMs: this.budget(),\n        computeUnits: 'all',\n", COLD, LIVE_T],
  ['snapshot-hides-warming', LIVE, "    else if (this.state === 'warming' || this.state === 'idle') { active = 'warming'; fallback = 'warming' }\n", '', COLD, LIVE_T],
  ['warm-retry-unbounded-or-none', LIVE, '    const attempts = delays.length + 1\n', '    const attempts = 1\n', 'a failing warm-up retries a bounded number of times', LIVE_T],
  ['missing-cli-spawns', LIVE, "      if (!this.cli || !this.modelsDir) {\n", "      if (false) {\n", 'fallback on a missing CLI: warm-up reports cli_missing and never spawns', LIVE_T],
  ['fallback-not-logged', LIVE, "    this.log(`[diarizer] chunk #${chunk.chunkIndex} fallback=${outcome.reason}${outcome.ms", "    if (false) this.log(`[diarizer] chunk #${chunk.chunkIndex} fallback=${outcome.reason}${outcome.ms", 'counts every outcome and logs every fallback with its reason', LIVE_T],
  ['reasons-not-counted', LIVE, '    this.counts.reasons[outcome.reason] = (this.counts.reasons[outcome.reason] ?? 0) + 1\n', '', 'counts every outcome and logs every fallback with its reason', LIVE_T],
  ['embedding-still-warms', LIVE, "    if (requestedDiarizer(this.env()) === 'embedding') return 'embedding_requested'\n", '', 'the voiceprint selected by COS_DIARIZER never warms or runs Nemotron', LIVE_T],
  // The chunk route
  ['response-drops-segments', STREAM, '    ...(existing.segments?.length ? { segments: existing.segments } : {}),\n', '', CONTRACT, ROUTE_T],
  ['chunk-drops-segments', STREAM, '    ...(labels.segments?.length ? { segments: labels.segments } : {}),\n', '', CONTRACT, ROUTE_T],
  ['speaker-stays-voiceprint', STREAM, '  const { speaker, similarity } = labels\n', '  const { speaker, similarity } = voiceprint\n', CONTRACT, ROUTE_T],
  ['outcome-not-recorded', STREAM, '  if (labels.record) nemotronLive.record({ sessionId, chunkIndex }, labels.record)\n', '', CONTRACT, ROUTE_T],
  ['hud-drops-segments', STREAM, '...(chunk.segments ? { segments: chunk.segments } : {})', '', CONTRACT, ROUTE_T],
  ['wrong-wav-path', STREAM, "    resolve(SESSION_AUDIO_DIR, sessionId, `chunk_${String(chunkIndex).padStart(4, '0')}.wav`),\n", "    resolve(SESSION_AUDIO_DIR, sessionId),\n", CONTRACT, ROUTE_T],
  // The final pass
  ['hash-unchecked', FINAL, "    if (expected && createHash('sha256').update(wav).digest('hex') !== expected) { excluded.hashMismatch++; continue }\n", '', 'drops a chunk whose audio hash disagrees', FINAL_T],
  ['follows-symlinked-chunk', FINAL, '    if (!isRegularFile(path)) { excluded.unreadable++; continue }\n', '', 'never reads a chunk file that is not a regular file', FINAL_T],
  ['tail-not-trimmed', FINAL, '    const use = Math.min(item.samples, room)\n', '    const use = item.samples\n', 'trims only the tail that would run into the next chunk', FINAL_T],
  ['crowded-ignored', FINAL, '  const crowded = isCrowded(identities, channelsUsed.size)\n', '  const crowded = false\n', 'gets no meeting-wide map; the live Nemotron turns still apply', FINAL_T],
  ['identities-not-crowded', FINAL, '  return identities > FINAL_MAX_IDENTITIES || channelsUsed >= FINAL_MAX_CHANNELS\n', '  return channelsUsed >= FINAL_MAX_CHANNELS\n', 'is more than four identities or all eight channels', FINAL_T],
  ['channels-not-crowded', FINAL, '  return identities > FINAL_MAX_IDENTITIES || channelsUsed >= FINAL_MAX_CHANNELS\n', '  return identities > FINAL_MAX_IDENTITIES\n', 'is more than four identities or all eight channels', FINAL_T],
  ['live-turns-ignored-in-final', FINAL, '        name = (start && liveSpeakerAt(start.window.chunk, start.inChunk, owner))\n', '        name = null\n', 'gets no meeting-wide map; the live Nemotron turns still apply', FINAL_T],
  ['purity-ignored', FINAL, '    const accepted = top !== null && support >= minSupport && share >= purity\n', '    const accepted = top !== null && support >= minSupport\n', SHARED, FINAL_T],
  ['support-ignored', FINAL, '    const accepted = top !== null && support >= minSupport && share >= purity\n', '    const accepted = top !== null && share >= purity\n', SHARED, FINAL_T],
  ['similarity-floor-ignored', FINAL, '    if (!isName(chunk.speaker) || !(Number(chunk.similarity) >= minSimilarity)) continue\n', '    if (!isName(chunk.speaker)) continue\n', SHARED, FINAL_T],
  ['one-sided-ignored', FINAL, '    if (!sided) continue\n', '', CONSISTENT, FINAL_T],
  ['original-not-kept', FINAL, '      if (name !== original) next.originalSpeaker = original\n', '      if (false) next.originalSpeaker = original\n', CONSISTENT, FINAL_T],
  ['resync-off', FINAL, '        if (anchor.length === ANCHOR) {\n', '        if (false) {\n', 'never loses a word', FINAL_T],
  ['unmatched-word-dropped', FINAL, '      if (speaker === null) speaker = turns.at(-1)?.speaker ?? line.speaker\n', '      if (speaker === null) continue\n', 'never loses a word', FINAL_T],
  ['human-correction-ignored', FINAL, "  if (Number(sidecar.correctionRevision ?? 0) > 0) return { status: 'skipped', reason: 'human_corrected' }\n", '', 'a human correction always wins', FINAL_T],
  ['reruns-when-applied', FINAL, "  if (sidecar.diarization?.status === 'applied' && sidecar.diarization?.outputSha256 === sha(transcript)) {\n", '  if (false) {\n', CONSISTENT, FINAL_T],
  ['final-ignores-config', FINAL, "  if (choice.requested === 'embedding') return { status: 'skipped', reason: 'embedding_requested' }\n", '', 'the voiceprint selected by COS_DIARIZER skips the pass', FINAL_T],
  ['streaming-original-dropped', FINAL, '        if (final.speaker !== original) chunk.originalSpeaker = original\n', '        if (false) chunk.originalSpeaker = original\n', 'a streaming meeting is relabelled per chunk line', FINAL_T],
  ['final-not-on-ane', FINAL, "        timeoutMs: finalPassTimeoutMs(timeline.durationSec),\n        computeUnits: 'ane',\n", "        timeoutMs: finalPassTimeoutMs(timeline.durationSec),\n        computeUnits: 'all',\n", CONSISTENT, FINAL_T],
  // The save path: before the audio goes and before sync; a failure saves as today
  ['final-pass-not-run', MEETING, '  } else if (options.finalDiarize) {\n', '  } else if (false) {\n', 'runs the Nemotron final pass on the saved files', MEETING_T],
  ['final-pass-throw-escapes', MEETING, "    } catch (error) {\n      console.warn(`[diarizer] final pass threw; the saved transcript is unchanged: ${error instanceof Error ? error.message : String(error)}`)\n    }\n", '    } finally { /* mutated */ }\n', 'a failed relabel saves as today', MEETING_T],
  // QA 6.61.0, round 1 (Skeptic and Ghost Hunter)
  ['health-publishes-raw-outcome', FINAL, '    finalCounts[key] = (finalCounts[key] ?? 0) + 1\n    lastFinal = published\n', '    finalCounts[key] = (finalCounts[key] ?? 0) + 1\n    lastFinal = { ...outcome, at: published.at } as never\n', 'unauthenticated /api/health after a final pass', PRIVACY_T],
  ['health-publishes-channel-map', FINAL, '    mappedChannels: outcome.mapped ? Object.keys(outcome.mapped).length : null,\n', '    mappedChannels: (outcome.mapped ?? null) as never,\n', 'unauthenticated /api/health after a final pass', PRIVACY_T],
  ['no-reread-before-write', FINAL, '  if (sidecarNow !== sidecarText || markdownNow !== markdown) {\n', '  if (false) {\n', 'a human relabel written while the CLI runs survives', FINAL_T],
  ['reread-ignores-markdown', FINAL, '  if (sidecarNow !== sidecarText || markdownNow !== markdown) {\n', '  if (sidecarNow !== sidecarText) {\n', 'a summary written into the markdown while the CLI runs survives', FINAL_T],
  ['relabel-not-guarded', MEETING, '    if (!running && !finalizationJobs.get(sessionId)) return null\n', '    return null\n', 'refuses a relabel or deattribution while the meeting is finalizing', MEETING_T],
  ['other-voice-enrolled', ENROL, '  const candidates = found.filter(r => !isAnotherVoice(r.speaker, input.from, to) && !isMultiVoiceChunk(chunksByIndex.get(r.i)))\n', '  const candidates = found.filter(r => !isMultiVoiceChunk(chunksByIndex.get(r.i)))\n', 'cannot enrol the wrong person', RELABEL_T],
  ['two-voice-chunk-enrolled', ENROL, '  const candidates = found.filter(r => !isAnotherVoice(r.speaker, input.from, to) && !isMultiVoiceChunk(chunksByIndex.get(r.i)))\n', '  const candidates = found.filter(r => !isAnotherVoice(r.speaker, input.from, to))\n', 'cannot enrol the wrong person', RELABEL_T],
  ['from-label-refused', ENROL, '  return rowSpeaker !== from && rowSpeaker !== to\n', '  return rowSpeaker !== to\n', 'enrols a NEW name from a wrong existing label', RELABEL_T],
  ['child-gets-full-env', CLI, '        env: nemotronChildEnv(),\n', '        env: process.env,\n', 'no COS token, provider key or API key reaches the child', CLI_T],
  ['kill-skips-children', CLI, "child.kill('SIGKILL'); killed++", 'killed++', 'kills the children in flight and deletes their temp dirs', CLI_T],
  ['exit-hook-missing', CLI, "  process.once('exit', () => { killNemotronChildren() })\n", '', 'an exit in the middle of a pass removes the temp dir', FINAL_T],
  ['final-dir-untracked', FINAL, '  trackNemotronDir(work)\n  let run: NemotronPreds\n', '  let run: NemotronPreds\n', 'an exit in the middle of a pass removes the temp dir', FINAL_T],
  ['sweep-ignores-age', CLI, '        if (!stat.isDirectory() || now - stat.mtimeMs < minAge) continue\n', '        if (!stat.isDirectory()) continue\n', 'the startup sweep removes stale cos-nemotron temp dirs', CLI_T],
  ['sweep-any-prefix', CLI, '      if (!name.startsWith(NEMOTRON_TMP_PREFIX)) continue\n', '', 'the startup sweep removes stale cos-nemotron temp dirs', CLI_T],
  ['breaker-never-opens', LIVE, "        if (this.consecutiveFailures >= BREAKER_FAILURES && this.state === 'ready') {\n", '        if (false) {\n', 'the breaker: three failed runs stop spawning', LIVE_T],
  ['cooling-spawns', LIVE, '      if (this.now() < this.retryAt) return reason\n', '', 'the breaker: three failed runs stop spawning', LIVE_T],
  ['backoff-not-growing', LIVE, '  private backoff(): number { return BREAKER_BACKOFF_MS[Math.min(this.trips, BREAKER_BACKOFF_MS.length - 1)] }\n', '  private backoff(): number { return BREAKER_BACKOFF_MS[0] }\n', 'the breaker: three failed runs stop spawning', LIVE_T],
  ['live-budget-changed', LIVE, 'export const LIVE_BUDGET_MS = 1500\n', 'export const LIVE_BUDGET_MS = 1000\n', 'pins the real defaults', LIVE_T],
  ['warm-temp-reason-lost', LIVE, "        this.warmError = error instanceof NemotronRunError ? error.reason : 'temp_dir'\n", "        this.warmError = error instanceof NemotronRunError ? error.reason : 'error'\n", 'a warm-up whose temp dir cannot be made', LIVE_T],
  ['active-ignores-recent', LIVE, '    } else if (this.recent.length > 0 && recentVoiceprint * 2 > this.recent.length) {\n', '    } else if (false) {\n', 'warm but most recent chunks fell back', LIVE_T],
  ['no-speech-counts-as-failure', LIVE, "    if (outcome.reason !== 'no_speech') this.pushRecent('voiceprint', outcome.reason)\n", "    this.pushRecent('voiceprint', outcome.reason)\n", 'warm but most recent chunks fell back', LIVE_T],
  ['state-reasons-logged-each', LIVE, '      if (this.lastStateLog === outcome.reason) return\n', '', 'counts every outcome and logs every fallback with its reason', LIVE_T],
  ['resplit-trusts-rewrites', LIVE, '    if (found < 0) return undefined\n', '    if (found < 0) { owner.push(owner.at(-1) ?? 0); continue }\n', 'refits turns to a text recovery stripped', LIVE_T],
  ['recovery-keeps-stale-turns', STREAM, '                    const refit = resplitSegments(chunk.segments, stripped)\n', '                    const refit = chunk.segments\n', 'a recovered chunk whose text loses words', RECOVERY_T],
  ['too-long-unchecked', FINAL, '  if (total / SR > (audio / SR) * FINAL_MAX_SPAN_RATIO + FINAL_SPAN_SLACK_SEC) {\n', '  if (false) {\n', 'a timeline far longer than its audio', FINAL_T],
  ['no-change-ignored', FINAL, "  if (next === transcript) return { status: 'skipped', reason: 'no_change', mode, words: stats, excluded, crowded, identities, channels: channelsUsed.size }\n", '', 'no label changes: no_change', FINAL_T],
  ['restore-skipped', FINAL, '      write(options.sidecarPath, sidecarText)\n', '', 'a markdown write that fails puts the sidecar back', FINAL_T],
  ['restore-failure-hidden', FINAL, "        reason: 'sidecar_restore_failed',\n", "        reason: 'markdown_write',\n", 'a markdown write that fails puts the sidecar back', FINAL_T],
  ['word-check-skipped', FINAL, "  if (!sameWords(transcript, next)) return { status: 'skipped', reason: 'word_mismatch', mode, excluded }\n", '', 'the word check is reachable', FINAL_T],
  ['crowd-counts-blips', FINAL, '  const channelsUsed = new Set(tracksIn(activity, 0, activity.frames).map(track => track.channel))\n', '  const channelsUsed = new Set(tracksIn(activity, 0, activity.frames, 0.001).map(track => track.channel))\n', 'a channel counts toward a crowded room only with half a second', FINAL_T],
  ['excluded-not-logged', FINAL, "  if (!e || e.missing + e.hashMismatch + e.unreadable === 0) return ''\n", "  return ''\n", 'logs every outcome: a failed CLI, excluded chunks', FINAL_T],
  ['final-timeout-changed', FINAL, '  return 120_000 + Math.round((durationSec * 1000) / 20)\n', '  return 120_000 + Math.round((durationSec * 1000) / 10)\n', 'pins the timeout formula', FINAL_T],
  ['declined-pass-uncounted', FINAL, '  finalCounts[key] = (finalCounts[key] ?? 0) + 1\n  lastFinal = published\n', '', 'records metadata_not_persisted as a code', FINAL_T],
  // 6.61.1 owner guard (field bug 2026-10-02: Jeremy and Kyle labelled MU)
  ['client-label-names-track', LIVE, "      names.set(track.channel, { speaker: 'Ext', similarity: 0 })\n", "      names.set(track.channel, { speaker: isRealLabel(client) && client !== dominantName ? client : 'Ext', similarity: 0 })\n", 'chunk 150 "Okay."', LIVE_T],
  ['weak-owner-accepted', LIVE, '      if (!owner || named.speaker !== owner || named.similarity >= OWNER_VERIFY_SIMILARITY) return named\n', '      return named\n', 'chunk 132 "Of course. All right." at 0.612', LIVE_T],
  ['owner-threshold-is-search', FLOOR, 'export const OWNER_VERIFY_SIMILARITY = 0.65\n', 'export const OWNER_VERIFY_SIMILARITY = 0.55\n', 'chunk 132 "Of course. All right." at 0.612', LIVE_T],
  ['track-identify-unguarded', LIVE, '        if (named) { names.set(track.channel, ownerSafe(named)); identified++; continue }\n', '        if (named) { names.set(track.channel, named); identified++; continue }\n', 'chunk 132 "Of course. All right." at 0.612', LIVE_T],
  ['dominant-voiceprint-unguarded', LIVE, '      if (track.channel === dominant) { names.set(track.channel, ownerSafe(input.chunkVoiceprint)); continue }\n', '      if (track.channel === dominant) { names.set(track.channel, input.chunkVoiceprint); continue }\n', 'a weak wearer match is refused on either path', LIVE_T],
  ['owner-guard-not-logged', LIVE, '        this.log(`[diarizer] owner-guard chunk', '        if (false) this.log(`[diarizer] owner-guard chunk', 'logs one owner-guard line per chunk', LIVE_T],
  ['owner-not-passed', STREAM, '        owner: ownerLabelOrNull(),\n', '', 'own profile (owner_speaker_label) guards a split chunk', ROUTE_T],
  ['final-owner-unguarded', FINAL, "  return Number(similarity) >= OWNER_VERIFY_SIMILARITY ? name : 'Ext'\n", '  return name\n', 'a split chunk 6.61.0 named MU from the glasses label', FINAL_T],
  ['final-live-turn-unguarded', FINAL, "  return best && typeof best.speaker === 'string' ? guardOwnerName(best.speaker, best.similarity, chunk, owner) : null\n", "  return best && typeof best.speaker === 'string' ? best.speaker : null\n", 'a split chunk 6.61.0 named MU from the glasses label', FINAL_T],
  // Health
  ['health-not-honest', HEALTH, '    diarizer: { ...nemotronLive.snapshot(), final: finalPassSnapshot() },\n', "    diarizer: 'nemotron',\n", 'readiness.diarizer says what labels a chunk now', HEALTH_T],
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const chosen = args.length ? mutations.filter(([name]) => args.includes(name)) : mutations
if (args.length && chosen.length !== args.length) throw new Error(`Unknown mutation name in: ${args.join(' ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'nemotron-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'bin'), join(scratch, 'bin'), { recursive: true })
  cpSync(join(root, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
  cpSync(join(root, 'managed-runtime-contract.json'), join(scratch, 'managed-runtime-contract.json'))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data') }, encoding: 'utf8', timeout: 300_000,
  })
  // Green baseline first, over every suite any mutant names.
  const all = [...new Set(chosen.flatMap(m => m[5]))]
  const baseline = run(all)
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  const summary = /Tests\s+(\d+) passed \((\d+)\)/.exec(baseline.stdout)
  if (!summary || summary[1] !== summary[2]) throw new Error('Baseline did not report every test passing:\n' + baseline.stdout)
  console.log(`baseline PASS (${summary[1]} tests in ${all.length} files)`)
  // Every target exactly once, before any mutant runs.
  for (const [name, file, find] of chosen) {
    const n = readFileSync(join(scratch, file), 'utf8').split(find).length - 1
    if (n !== 1) throw new Error(`Mutation ${name} matches ${n} times in ${file}; it must match exactly once`)
  }
  let killed = 0
  for (const [name, file, find, replacement, killerName, tests] of chosen) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    const mutated = original.replace(find, () => replacement)
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    let result
    try { result = run(tests) } finally { writeFileSync(target, original) }
    if (readFileSync(target, 'utf8') !== original) throw new Error(`${file} was not restored after ${name}`)
    const output = result.stdout + '\n' + result.stderr
    // The intended test must be among the named failures: a kill by some unrelated test proves nothing about the rule.
    const killers = [...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(match => match[1].trim())
    if (result.status === 0 || result.error || !killers.length) throw new Error(`Mutation survived or harness failed: ${name}\n${output.slice(-4000)}`)
    const killer = killers.find(line => line.includes(killerName))
    if (!killer) throw new Error(`Mutation ${name} was killed, but not by the test named for it ("${killerName}"): ${killers.join(' | ')}`)
    killed++
    console.log(`${name} KILLED by ${killer}`)
  }
  console.log(`${killed} of ${chosen.length} nemotron mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
