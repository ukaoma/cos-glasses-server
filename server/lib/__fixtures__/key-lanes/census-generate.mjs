#!/usr/bin/env node
// K0-C census generator (plan v4 sections 5.2, 5.3, 6.1, 6.2, 8.2, 14.1).
//
// Every list is produced by `git grep` / `git show` at a PINNED sha, never from a working
// tree, so another session editing a checkout cannot change the result. Output is sorted
// and carries no timestamp, so two runs at the same shas are byte-identical (the K0
// determinism rule). Run it twice and diff to prove that.
//
// usage:
//   node census-generate.mjs --server <repo> --app <repo> --mu <repo> \
//        --out <census.json> --mu-out <child_env_census.json>
//
// The classification tables below are the review: a grep hit with no entry fails the run
// ("unclassified"), and an entry with no grep hit fails it too ("stale"), so the lists can
// neither grow nor shrink unreviewed.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const SHAS = {
  server: '6237057',
  app: 'f02fab64',
  mu: 'd91957856',
}

// Counts the plan states (section 14.1). Recorded next to the real count, with the reason
// for any difference, rather than forced to match.
const PLAN_COUNTS = {
  serverPreferenceCalls: 25,
  familyGuardCalls: 27,
  appPreferenceSites: 27,
  resolveProviderBinarySites: 21,
  serverSpawnShapedLines: 82,
  muSubprocessSites: 197,
  claudeSettingsHooks: 15,
  codexHooks: 12,
}

function arg(name) {
  const i = process.argv.indexOf(name)
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing ${name}`)
  return process.argv[i + 1]
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

/** `git grep -n -o -P` at a sha. One row per MATCH (so two calls on one line are two rows). */
function grepMatches(repo, sha, pattern, paths) {
  let out = ''
  try {
    out = git(repo, ['grep', '-n', '-o', '-P', pattern, sha, '--', ...paths])
  } catch (error) {
    if (error.status === 1) return []
    throw error
  }
  return out.split('\n').filter(Boolean).map(line => {
    const rest = line.slice(sha.length + 1)
    const m = rest.match(/^(.*?):(\d+):(.*)$/)
    return { file: m[1], line: Number(m[2]), match: m[3] }
  })
}

/** `git grep -n -P` at a sha. One row per LINE, with the line text. */
function grepLines(repo, sha, pattern, paths) {
  let out = ''
  try {
    out = git(repo, ['grep', '-n', '-P', pattern, sha, '--', ...paths])
  } catch (error) {
    if (error.status === 1) return []
    throw error
  }
  return out.split('\n').filter(Boolean).map(line => {
    const rest = line.slice(sha.length + 1)
    const m = rest.match(/^(.*?):(\d+):(.*)$/)
    return { file: m[1], line: Number(m[2]), text: m[3] }
  })
}

const fileCache = new Map()
function fileAt(repo, sha, path) {
  const key = `${repo}\0${sha}\0${path}`
  if (!fileCache.has(key)) fileCache.set(key, git(repo, ['show', `${sha}:${path}`]).split('\n'))
  return fileCache.get(key)
}

const isTest = file => /\.test\.(ts|mts|mjs|js)$/.test(file)
const isCommentLine = text => /^\s*(\/\/|\*|\/\*)/.test(text)
const byLoc = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)
const loc = r => `${r.file}:${r.line}`

/** Apply a classification table; fail on unclassified hits and on stale entries. */
function classify(rows, table, label) {
  const problems = []
  const seen = new Set()
  const result = rows.map(row => {
    const key = loc(row)
    const entry = table[key]
    if (!entry) problems.push(`${label}: unclassified ${key}`)
    seen.add(key)
    return { ...row, ...(entry ?? { class: 'UNCLASSIFIED' }) }
  })
  for (const key of Object.keys(table)) if (!seen.has(key)) problems.push(`${label}: stale entry ${key}`)
  return { result, problems }
}

// ---------------------------------------------------------------------------------------
// 5.2 server preference sites
// ---------------------------------------------------------------------------------------
const SERVER_PREF_RULE = {
  'server/routes/query.ts:96': 'accept',
  'server/lib/query-job-runtime.ts:170': 'accept',
  'server/lib/query-job-runtime.ts:181': 'accept',
  'server/lib/query-job-runtime.ts:207': 'accept',
  'server/lib/model-router.ts:79': 'accept',
  'server/lib/conversation.ts:163': 'accept_by_syntax',
  'server/lib/conversation.ts:168': 'accept_by_syntax',
  'server/lib/conversation.ts:490': 'accept_by_syntax',
  'server/lib/conversation.ts:628': 'accept_by_syntax',
  'server/lib/conversation.ts:722': 'accept_by_syntax',
  'server/lib/claude-steer.ts:251': 'closed_with_profile_session_guard',
  'server/lib/morning-brief-config.ts:412': 'reject',
  'server/lib/morning-brief-config.ts:449': 'reject',
  'server/lib/model-router.ts:78': 'closed_env_default',
  'server/routes/openai-compat.ts:118': 'closed_env_default',
  'server/lib/control2-draft.ts:90': 'closed_env_default',
  'server/routes/work-handoff-requests.ts:21': 'closed_env_default',
  'server/routes/openai-compat.ts:103': 'closed',
  'server/lib/work-handoff-requests.ts:138': 'reject',
  'server/lib/work-activity.ts:364': 'reject',
  'server/lib/handoff-store.ts:190': 'closed',
  'server/lib/codex-engine-sessions.ts:50': 'closed',
  'server/lib/cursor-engine-sessions.ts:54': 'closed',
  'server/routes/cli-debug.ts:33': 'closed',
}

function serverPreferenceSites(repo) {
  const sha = SHAS.server
  const hits = grepMatches(repo, sha, '(?<![\\w.])(normalizeModelPreference|isModelPreference)\\(', ['server', 'shared'])
    .filter(r => !isTest(r.file))
  const defs = grepLines(repo, sha, 'function (normalizeModelPreference|isModelPreference)\\(', ['server', 'shared'])
  const defLocs = new Set(defs.map(loc))
  const calls = []
  const definitions = []
  const internal = []
  for (const r of hits.sort(byLoc)) {
    const text = fileAt(repo, sha, r.file)[r.line - 1]
    const row = { file: r.file, line: r.line, fn: r.match.replace(/\($/, ''), text: text.trim() }
    if (defLocs.has(loc(r))) definitions.push(row)
    else if (r.file === 'shared/model-preference.ts') internal.push(row)
    else calls.push(row)
  }
  const problems = []
  const classified = calls.map(row => {
    const rule = SERVER_PREF_RULE[loc(row)]
    if (!rule) problems.push(`5.2: unclassified ${loc(row)}`)
    return { ...row, rule: rule ?? 'UNCLASSIFIED' }
  })
  for (const key of Object.keys(SERVER_PREF_RULE)) {
    if (!calls.some(row => loc(row) === key)) problems.push(`5.2: stale rule ${key}`)
  }
  return {
    pattern: '(?<![\\w.])(normalizeModelPreference|isModelPreference)\\( in server/ and shared/, non-test, one row per call',
    calls: classified,
    callCount: classified.length,
    callFiles: [...new Set(classified.map(r => r.file))].sort(),
    definitions,
    internalCallsInsideShared: internal,
    problems,
  }
}

function familyGuardSites(repo) {
  const sha = SHAS.server
  const hits = grepMatches(repo, sha, '(?<![\\w.])(isClaudeModel|isCodexModel|isCursorModel|isOllamaModel)\\(', ['server', 'shared'])
    .filter(r => !isTest(r.file))
  const defs = new Set(grepLines(repo, sha, 'function (isClaudeModel|isCodexModel|isCursorModel|isOllamaModel)\\(', ['server', 'shared']).map(loc))
  const calls = []
  const definitions = []
  for (const r of hits.sort(byLoc)) {
    const row = { file: r.file, line: r.line, fn: r.match.replace(/\($/, ''), text: fileAt(repo, sha, r.file)[r.line - 1].trim() }
    if (defs.has(loc(r))) definitions.push(row)
    else calls.push(row)
  }
  const inServer = calls.filter(r => r.file.startsWith('server/'))
  const inShared = calls.filter(r => r.file.startsWith('shared/'))
  return {
    pattern: '(?<![\\w.])(isClaudeModel|isCodexModel|isCursorModel|isOllamaModel)\\( in server/ and shared/, non-test, one row per call',
    calls,
    callCount: calls.length,
    serverCallCount: inServer.length,
    sharedInternalCallCount: inShared.length,
    distinctServerLines: new Set(inServer.map(loc)).size,
    definitions,
    rule: 'Each guard call is Closed in K1 unless its 5.2 caller is Accept; the plan names claude-bridge.ts:175, :443, query-job-runtime.ts:122-124, :360, routes/query.ts:230',
  }
}

// ---------------------------------------------------------------------------------------
// 5.3 app preference sites
// ---------------------------------------------------------------------------------------
function appPreferenceSites(repo) {
  const sha = SHAS.app
  const hits = grepMatches(repo, sha, '(?<![\\w.])(normalizeModelPreference|isModelPreference)\\(', ['shared', 'src'])
    .filter(r => !isTest(r.file))
  const defs = new Set(grepLines(repo, sha, 'function (normalizeModelPreference|isModelPreference)\\(', ['shared', 'src']).map(loc))
  const rows = hits.sort(byLoc).map(r => {
    const text = fileAt(repo, sha, r.file)[r.line - 1].trim()
    const kind = defs.has(loc(r)) ? 'definition' : r.file === 'shared/model-preference.ts' ? 'internal_call' : 'call'
    return { file: r.file, line: r.line, fn: r.match.replace(/\($/, ''), kind, text: text.slice(0, 200) }
  })
  const fallbacks = grepLines(repo, sha, '\\?\\?\\s*state\\.modelPreference', ['shared', 'src'])
    .filter(r => !isTest(r.file))
    .sort(byLoc)
    .map(r => ({ file: r.file, line: r.line, text: r.text.trim().slice(0, 200) }))
  const labelDefaults = grepLines(repo, sha, "'Opus'", ['shared/model-preference.ts'])
    .sort(byLoc).map(r => ({ file: r.file, line: r.line, text: r.text.trim() }))
  return {
    pattern: '(?<![\\w.])(normalizeModelPreference|isModelPreference)\\( in shared/ and src/, non-test; fallbacks: \\?\\?\\s*state\\.modelPreference',
    sites: rows,
    siteCountIncludingDefinitions: rows.filter(r => r.kind !== 'internal_call').length,
    callCount: rows.filter(r => r.kind === 'call').length,
    definitionCount: rows.filter(r => r.kind === 'definition').length,
    internalCallCount: rows.filter(r => r.kind === 'internal_call').length,
    stateModelPreferenceFallbacks: fallbacks,
    fallbackCount: fallbacks.length,
    labelOpusDefaults: labelDefaults,
  }
}

// ---------------------------------------------------------------------------------------
// 6.1 server spawn census
// ---------------------------------------------------------------------------------------
const NP = (binary, note) => ({ class: 'non_provider', binary, ...(note ? { note } : {}) })
const SPAWN_TABLE = {
  'server/lib/__fixtures__/attached-fake-provider.cjs:23': NP('/bin/sh', 'test fixture, not shipped behavior'),
  'server/lib/__fixtures__/attached-fake-provider.cjs:37': NP('node (process.execPath)', 'test fixture'),
  'server/lib/__fixtures__/attached-fake-provider.cjs:48': NP('node (process.execPath)', 'test fixture'),
  'server/lib/__fixtures__/permission-broker-6.71.5.ts:275': NP('/usr/sbin/ioreg', 'test fixture (frozen 6.71.5 copy)'),
  'server/lib/adaptive-playback-audio.ts:203': NP('ffmpeg'),
  'server/lib/archive.ts:196': { class: 'background_lane_a', binary: 'claude', planned: true },
  'server/lib/attached-provider-adapter.ts:1553': NP('/bin/ps'),
  'server/lib/attached-provider-adapter.ts:1573': NP('/bin/ps'),
  'server/lib/audio-enhance.ts:44': NP('ffmpeg'),
  'server/lib/claude-bridge.ts:231': { class: 'background_lane_a', binary: 'claude', planned: true, note: 'prewarm' },
  'server/lib/claude-bridge.ts:659': { class: 'lane_b_capable', binary: 'claude', planned: true, note: 'turn' },
  'server/lib/claude-cli-support.ts:17': { class: 'probe_catalog', binary: 'claude', planned: false, note: 'claude --help; NOT in plan 6.1 table' },
  'server/lib/claude-cli-support.ts:48': { class: 'probe_catalog', binary: 'claude', planned: false, note: 'claude --help; NOT in plan 6.1 table' },
  'server/lib/codex-bridge.ts:163': { class: 'probe_catalog', binary: 'codex', planned: true, note: 'exec --help; plan names the resolve at :156' },
  'server/lib/codex-bridge.ts:492': { class: 'lane_b_capable', binary: 'codex', planned: true, note: 'turn' },
  'server/lib/codex-hooks-installer.ts:408': { class: 'probe_catalog', binary: 'codex', planned: true, note: 'app-server; plan names the resolve at :494' },
  'server/lib/codex-live-queue-deps.ts:41': { class: 'probe_catalog', binary: 'codex', planned: true, note: 'live queue app-server; plan names the resolve at :114' },
  'server/lib/codex-model-catalog.ts:290': { class: 'probe_catalog', binary: 'codex', planned: true, note: 'app-server catalog; plan names :282' },
  'server/lib/codex-queue-control.ts:24': { class: 'probe_catalog', binary: 'codex', planned: true, note: 'app-server queue; plan names :19' },
  'server/lib/context-library-search.ts:282': NP('python (PYTHON_BIN)'),
  'server/lib/control2-draft.ts:44': { class: 'background_lane_a', binary: 'claude', planned: true },
  'server/lib/control2-sandbox.ts:105': NP('/usr/bin/sandbox-exec', 'runs input.executable under a sandbox profile with a minimal env {PATH,HOME,TMPDIR,LANG,LC_ALL}'),
  'server/lib/control2-sandbox.ts:166': NP('/bin/bash', 'sandbox self-test'),
  'server/lib/cursor-bridge.ts:368': { class: 'cursor_turn_no_key_lane', binary: 'agent', planned: false, note: 'Cursor turn; plan: Cursor has no key lane; NOT in plan 6.1 table' },
  'server/lib/cursor-model-catalog.ts:268': { class: 'probe_catalog', binary: 'agent', planned: true, note: 'agent models; plan names the resolve at :129' },
  'server/lib/cursor-session-model.ts:137': NP('sqlite3'),
  'server/lib/diarizer-backend.ts:66': NP('which'),
  'server/lib/dictation-benchmark.ts:71': NP('/bin/ps'),
  'server/lib/dictation-clean.ts:85': { class: 'background_lane_a', binary: 'claude|agent', planned: true, note: 'plan names the resolve at :38' },
  'server/lib/g2-enrichment-runner.ts:105': NP('python (options.pythonBin)'),
  'server/lib/health-static-probes.ts:86': { class: 'probe_catalog', binary: 'python|claude|codex --version', planned: true, note: 'plan names the resolves at :128, :142' },
  'server/lib/image-safety.ts:197': NP('ffmpeg'),
  'server/lib/image-safety.ts:226': NP('ffmpeg'),
  'server/lib/image-safety.ts:258': NP('ffprobe'),
  'server/lib/lens-gist-engines.ts:140': { class: 'background_lane_a', binary: 'claude|codex|agent', planned: true, note: 'plan names the resolve at :182' },
  'server/lib/live-cues-cursor.ts:78': { class: 'background_lane_a', binary: 'agent', planned: false, note: 'Cursor live cues; NOT in plan 6.1 table' },
  'server/lib/live-cues-memory.ts:82': NP('python'),
  'server/lib/live-cues-memory.ts:151': NP('python'),
  'server/lib/live-cues-v2.ts:473': NP('python'),
  'server/lib/live-cues-v2.ts:490': NP('python'),
  'server/lib/managed-restart.ts:29': NP('launchctl'),
  'server/lib/meeting-actions.ts:1543': NP('injected pipeline runner (python)'),
  'server/lib/meeting-actions.ts:2258': NP('injected pipeline runner (python)'),
  'server/lib/meeting-ask-runner.ts:58': { class: 'background_lane_a', binary: 'claude|codex', planned: true, note: 'plan names the resolve at :50' },
  'server/lib/meeting-ask-search-process.ts:9': NP('python (file param, from context/meeting library search)'),
  'server/lib/meeting-image-ocr.ts:50': NP('/usr/bin/osascript'),
  'server/lib/meeting-library-search.ts:517': NP('python (PYTHON_BIN)'),
  'server/lib/meeting-summary.ts:371': { class: 'background_lane_a', binary: 'claude (spawnClaudeText, prompt-edit.ts:72)', planned: false, note: 'injected; default is spawnClaudeText, which spawns at prompt-edit.ts:94; NOT separately in plan 6.1 table' },
  'server/lib/meeting-sync-lock.ts:14': NP('python'),
  'server/lib/nemotron-cli.ts:94': NP('/bin/ps'),
  'server/lib/occupancy-probes.ts:158': NP('lsof/pgrep-style probe (bin param)'),
  'server/lib/occupancy-probes.ts:597': NP('lsof/pgrep-style probe (bin param)'),
  'server/lib/parakeet-cli-trust.ts:54': NP('parakeet cli (command param)'),
  'server/lib/parakeet.ts:541': NP('/usr/bin/getconf'),
  'server/lib/permission-broker.ts:283': NP('/usr/sbin/ioreg'),
  'server/lib/pipeline-runner.ts:120': NP('python (options.pythonBin)'),
  'server/lib/prompt-edit.ts:94': { class: 'background_lane_a', binary: 'claude', planned: true },
  'server/lib/provider-proof.ts:62': { class: 'probe_catalog', binary: 'claude|codex|agent (command param)', planned: false, note: 'provider proof spawnPiped; NOT in plan 6.1 table' },
  'server/lib/python-bridge.ts:292': NP('python (PYTHON_BIN)'),
  'server/lib/rich-media-safety.ts:207': NP('ffmpeg/ffprobe (command param)'),
  'server/lib/rich-media-safety.ts:306': NP('ffmpeg (command param)'),
  'server/lib/rich-media-safety.ts:392': NP('ffprobe'),
  'server/lib/session-continue-facts-real.ts:33': NP('git'),
  'server/lib/session-continue-facts-real.ts:40': NP('git'),
  'server/lib/session-halt.ts:136': { class: 'wrapper', binary: 'caller-supplied spawn (attach/fork)', planned: false, note: 'pass-through wrapper; the provider is decided by the attach/fork caller' },
  'server/lib/session-hooks-runtime.ts:56': NP('/bin/ps'),
  'server/lib/speaker-embeddings.ts:163': NP('node (process.execPath)'),
  'server/lib/task-bridge.ts:42': NP('python'),
  'server/lib/task-bridge.ts:77': NP('python'),
  'server/lib/task-dates.ts:77': NP('git'),
  'server/lib/tts-local.ts:101': NP('python'),
  'server/lib/tts-local.ts:147': NP('/bin/bash'),
  'server/lib/tts-local.ts:332': NP('python'),
  'server/lib/video-compression.ts:141': NP('ffmpeg'),
  'server/lib/whisper-local.ts:359': NP('whisper/ffmpeg (file param)'),
  'server/lib/whisper-local.ts:698': NP('whisper-server'),
  'server/lib/whisper-local.ts:1083': NP('whisper-cli or /usr/sbin/taskpolicy'),
  'server/lib/whisper-local.ts:1326': NP('whisper-cli'),
  'server/lib/whisper-preview.ts:156': NP('whisper (file param)'),
  'server/lib/whisper-preview.ts:385': NP('whisper-server'),
  'server/routes/tts.ts:343': NP('osascript'),
}

const RESOLVE_TABLE = {
  'server/lib/attached-provider-adapter.ts:1862': 'attach_fork',
  'server/lib/fork-thread.ts:1063': 'attach_fork',
  'server/lib/codex-bridge.ts:156': 'probe_catalog',
  'server/lib/codex-bridge.ts:477': 'lane_b_capable',
  'server/lib/codex-hooks-installer.ts:115': 'probe_catalog',
  'server/lib/codex-hooks-installer.ts:494': 'probe_catalog',
  'server/lib/codex-live-queue-deps.ts:114': 'probe_catalog',
  'server/lib/codex-model-catalog.ts:282': 'probe_catalog',
  'server/lib/codex-queue-control.ts:19': 'probe_catalog',
  'server/lib/cursor-model-catalog.ts:129': 'probe_catalog',
  'server/lib/dictation-clean.ts:38': 'background_lane_a',
  'server/lib/health-static-probes.ts:128': 'probe_catalog',
  'server/lib/health-static-probes.ts:142': 'probe_catalog',
  'server/lib/lens-gist-engines.ts:182': 'background_lane_a',
  'server/lib/lens-gist.ts:274': 'background_lane_a',
  'server/lib/lens-gist.ts:278': 'background_lane_a',
  'server/lib/lens-gist.ts:937': 'background_lane_a',
  'server/lib/lens-gist.ts:960': 'background_lane_a',
  'server/lib/live-cues-v2.ts:564': 'background_lane_a',
  'server/lib/meeting-ask-runner.ts:50': 'background_lane_a',
  // Plan v4 says meeting-ask-web.ts:330 "is now" meeting-ask-runner.ts:50. Both exist at
  // 6237057: :330 is the web-search capability check (claude:haiku), :50 the runner.
  'server/lib/meeting-ask-web.ts:330': 'background_lane_a',
  'server/lib/transcript-cleanup.ts:200': 'background_lane_a',
}

function serverSpawnCensus(repo) {
  const sha = SHAS.server
  const paths = ['server/lib', 'server/routes', 'shared']
  const all = grepLines(repo, sha, '(?<![\\w.])(spawn|execFile|spawnSync|execFileSync)\\(', paths)
    .filter(r => !isTest(r.file)).sort(byLoc)
  const comments = all.filter(r => isCommentLine(r.text)).map(r => ({ file: r.file, line: r.line, text: r.text.trim() }))
  const calls = all.filter(r => !isCommentLine(r.text)).map(r => ({ file: r.file, line: r.line, text: r.text.trim().slice(0, 200) }))
  const { result: spawnRows, problems: p1 } = classify(calls, SPAWN_TABLE, '6.1 spawn')

  const resolves = grepLines(repo, sha, '(?<![\\w.])resolveProviderBinary\\(', paths)
    .filter(r => !isTest(r.file) && !isCommentLine(r.text) && !/export function resolveProviderBinary/.test(r.text))
    .sort(byLoc)
    .map(r => ({ file: r.file, line: r.line, text: r.text.trim().slice(0, 200) }))
  const problems = [...p1]
  const resolveRows = resolves.map(r => {
    const cls = RESOLVE_TABLE[loc(r)]
    if (!cls) problems.push(`6.1 resolve: unclassified ${loc(r)}`)
    return { ...r, class: cls ?? 'UNCLASSIFIED' }
  })
  for (const key of Object.keys(RESOLVE_TABLE)) if (!resolves.some(r => loc(r) === key)) problems.push(`6.1 resolve: stale ${key}`)

  const countBy = rows => rows.reduce((acc, r) => ({ ...acc, [r.class]: (acc[r.class] ?? 0) + 1 }), {})
  return {
    spawnPattern: '(?<![\\w.])(spawn|execFile|spawnSync|execFileSync)\\( in server/lib, server/routes, shared; non-test; one row per LINE',
    spawnShapedLinesIncludingComments: all.length,
    commentLines: comments,
    spawnCallLines: spawnRows,
    spawnCallLineCount: spawnRows.length,
    spawnClassCounts: countBy(spawnRows),
    providerSpawnLinesNotInPlanTable: spawnRows.filter(r => r.planned === false).map(loc),
    resolvePattern: '(?<![\\w.])resolveProviderBinary\\( in server/lib, server/routes, shared; non-test, non-comment, definition excluded',
    resolveProviderBinarySites: resolveRows,
    resolveProviderBinaryCount: resolveRows.length,
    resolveClassCounts: countBy(resolveRows),
    problems,
  }
}

// ---------------------------------------------------------------------------------------
// 8.2 codex home readers
// ---------------------------------------------------------------------------------------
const PLAN_READERS = [
  ['session_store', 'server/lib/agent-session-store.ts', [76]],
  ['native_head', 'server/lib/native-head.ts', [197]],
  ['stream_events', 'server/lib/session-stream-events.ts', [644]],
  ['queue_control_sqlite', 'server/lib/codex-queue-control.ts', [92]],
  ['continue_facts', 'server/lib/session-continue-facts-real.ts', [44]],
  ['lens_gist', 'server/lib/lens-gist.ts', [918]],
  ['lens_gist_engines', 'server/lib/lens-gist-engines.ts', [265]],
  ['hook_events', 'server/lib/session-hook-events.ts', [73]],
  ['occupancy_locks', 'server/lib/occupancy-probes.ts', [68, 76]],
  ['thread_occupancy', 'server/lib/thread-occupancy.ts', [549]],
  ['posture', 'server/lib/codex-session-posture.ts', [226, 228]],
  ['morning_brief_runtime', 'server/lib/morning-brief-runtime.ts', [174]],
  ['catalog', 'server/lib/codex-model-catalog.ts', [62]],
]

function codexHomeReaders(repo) {
  const sha = SHAS.server
  const readers = PLAN_READERS.map(([name, file, lines]) => ({
    name,
    file,
    lines: lines.map(line => ({ line, text: (fileAt(repo, sha, file)[line - 1] ?? '').trim().slice(0, 200) })),
  }))
  const refs = grepLines(repo, sha, "CODEX_HOME|'\\.codex'|\\.codex/", ['server/lib', 'server/routes', 'shared'])
    .filter(r => !isTest(r.file)).sort(byLoc)
    .map(r => ({ file: r.file, line: r.line, comment: isCommentLine(r.text), text: r.text.trim().slice(0, 200) }))
  const planned = new Set(PLAN_READERS.flatMap(([, file, lines]) => lines.map(l => `${file}:${l}`)))
  const plannedFiles = new Set(PLAN_READERS.map(([, file]) => file))
  const unlisted = refs.filter(r => !r.comment && !planned.has(loc(r)) && !plannedFiles.has(r.file)).map(loc)
  return {
    planReaders: readers,
    planReaderCount: readers.length,
    grepPattern: "CODEX_HOME|'\\.codex'|\\.codex/ in server/lib, server/routes, shared; non-test",
    codexHomeReferences: refs,
    codexHomeReferenceCount: refs.length,
    nonCommentReferencesInFilesThePlanDoesNotList: unlisted,
  }
}

// ---------------------------------------------------------------------------------------
// 6.2 MU subprocess sites and hooks
// ---------------------------------------------------------------------------------------
const MU_PLAN_CALLERS = {
  'operations/scripts/transcript_summary_hook.py': [1289, 1336, 1553],
  'operations/scripts/precompact_hook.py': [171, 197],
  'operations/scripts/llm_client.py': [442, 520],
  'operations/scripts/session_startup_hook.py': [235, 250, 281, 303, 1264, 1324, 1339, 1346, 1615, 1864],
  'operations/scripts/session_stop_hook.py': [121],
  'operations/scripts/canvas_todo_sync_hook.py': [44],
  'operations/scripts/skill_sync_hook.py': [61],
}
const MU_PLAN_FILES = [
  'operations/scripts/claude_executor.py',
  'operations/scripts/open_design_bridge.py',
  'operations/scripts/session_summarizer.py',
  'operations/scripts/learning_bridge.py',
  'operations/scripts/learning_events.py',
  'operations/scripts/llm_backend.py',
  'operations/scripts/memory_applied.py',
  'operations/scripts/slack_bridge/claude_proxy.py',
]
const PROVIDER_SIGNAL = /\bclaude\b|\bcodex\b|cursor-agent|CLAUDE_BIN|CODEX_BIN|claude_bin|codex_bin|\bllm\b|anthropic|openai|ollama/i

function muCensus(repo) {
  const sha = SHAS.mu
  const pattern = 'subprocess\\.(run|Popen|call|check_output|check_call)\\('
  const raw = grepLines(repo, sha, pattern, ['operations/scripts'])
  const inTests = raw.filter(r => r.file.includes('/tests/') || /\/test_[^/]*\.py$/.test(r.file))
  const nonTest = raw.filter(r => !inTests.includes(r))
  const nonPy = nonTest.filter(r => !r.file.endsWith('.py'))
  // Calls the plan's pattern cannot see: `import subprocess as _sp` aliases and the
  // process_supervisor.run_supervised wrapper (whose own Popen is one of the 197).
  const extraPatterns = [
    ['alias', '(?<![\\w.])_sp\\.(run|Popen|call|check_output|check_call)\\('],
    ['wrapper', '(?<![\\w.])run_supervised\\('],
  ]
  const extra = extraPatterns.flatMap(([source, p]) => grepLines(repo, sha, p, ['operations/scripts'])
    .filter(r => r.file.endsWith('.py') && !r.file.includes('/tests/') && !/\/test_[^/]*\.py$/.test(r.file))
    .filter(r => !/^\s*(#|def )/.test(r.text))
    .map(r => ({ ...r, source })))
  const tagged = [
    ...nonTest.filter(r => r.file.endsWith('.py')).map(r => ({ ...r, source: 'plan_pattern' })),
    ...extra,
  ]
  const sites = tagged.sort(byLoc).map(r => {
    const lines = fileAt(repo, sha, r.file)
    const window = lines.slice(Math.max(0, r.line - 4), r.line + 12).join('\n')
    const plannedLines = MU_PLAN_CALLERS[r.file]
    const named = plannedLines ? (plannedLines.includes(r.line) ? 'plan_line' : 'plan_file_other_line') : MU_PLAN_FILES.includes(r.file) ? 'plan_file' : 'not_named'
    return {
      file: r.file,
      line: r.line,
      source: r.source,
      call: (r.text.match(/(?:subprocess|_sp)\.(\w+)\(|(run_supervised)\(/) ?? []).slice(1).find(Boolean),
      comment: /^\s*#/.test(r.text),
      namedInPlan: named,
      providerSignalInWindow: PROVIDER_SIGNAL.test(window),
      envKwargInWindow: /\benv\s*=/.test(window),
      text: r.text.trim().slice(0, 200),
    }
  })
  const missingPlanLines = []
  for (const [file, lines] of Object.entries(MU_PLAN_CALLERS)) {
    // The plan cites some sites by their `env=` line, a few lines into the call.
    for (const line of lines) if (!sites.some(s => s.file === file && s.line <= line && line - s.line <= 12)) missingPlanLines.push(`${file}:${line}`)
  }

  function hooksOf(path) {
    const json = JSON.parse(git(repo, ['show', `${sha}:${path}`]))
    const rows = []
    for (const [event, groups] of Object.entries(json.hooks ?? {})) {
      for (const group of groups) {
        for (const hook of group.hooks ?? []) {
          const script = (String(hook.command ?? '').match(/([\w.-]+\.py)'?\s*$/) ?? [])[1] ?? null
          rows.push({ event, matcher: group.matcher ?? '', type: hook.type, script, ...(hook.timeout ? { timeout: hook.timeout } : {}) })
        }
      }
    }
    return rows
  }
  const claudeHooks = hooksOf('.claude/settings.json')
  const codexHooks = hooksOf('.codex/hooks.json')

  return {
    sha,
    pattern: `${pattern} in operations/scripts at ${sha}; tests (tests/ and test_*.py) excluded`,
    grepHitsIncludingTests: raw.length,
    grepHitsExcludingTests: nonTest.length,
    excludedNonPythonHits: nonPy.map(r => ({ file: r.file, line: r.line })),
    sites,
    siteCount: sites.filter(s => s.source === 'plan_pattern').length,
    siteFileCount: new Set(sites.filter(s => s.source === 'plan_pattern').map(s => s.file)).size,
    extraSiteCount: sites.filter(s => s.source !== 'plan_pattern').length,
    allSiteCount: sites.length,
    fileCountIncludingNonPython: new Set(nonTest.map(r => r.file)).size,
    sitesWithProviderSignal: sites.filter(s => s.providerSignalInWindow).length,
    planNamedLinesMissingFromGrep: missingPlanLines,
    classificationNote: 'providerSignalInWindow is a grep heuristic over lines [l-3, l+12] (claude|codex|cursor-agent|*_BIN|llm|anthropic|openai|ollama). It is a review queue for P7, not a verdict; P7 classifies each site as reaches_provider yes/no in test_child_env_census.py.',
    hooks: {
      claudeSettings: { path: '.claude/settings.json', count: claudeHooks.length, hooks: claudeHooks, scripts: [...new Set(claudeHooks.map(h => h.script))].sort() },
      codexHooks: { path: '.codex/hooks.json', count: codexHooks.length, hooks: codexHooks, scripts: [...new Set(codexHooks.map(h => h.script))].sort() },
    },
  }
}

// ---------------------------------------------------------------------------------------
const serverRepo = arg('--server')
const appRepo = arg('--app')
const muRepo = arg('--mu')
const out = arg('--out')
const muOut = arg('--mu-out')

for (const [name, repo] of [['server', serverRepo], ['app', appRepo], ['mu', muRepo]]) {
  git(repo, ['cat-file', '-e', `${SHAS[name]}^{commit}`])
}

const prefs = serverPreferenceSites(serverRepo)
const family = familyGuardSites(serverRepo)
const app = appPreferenceSites(appRepo)
const spawns = serverSpawnCensus(serverRepo)
const readers = codexHomeReaders(serverRepo)
const mu = muCensus(muRepo)

const counts = {
  serverPreferenceCalls: { plan: PLAN_COUNTS.serverPreferenceCalls, real: prefs.callCount, files: prefs.callFiles.length },
  familyGuardCalls: { plan: PLAN_COUNTS.familyGuardCalls, real: family.callCount, server: family.serverCallCount, sharedInternal: family.sharedInternalCallCount, distinctServerLines: family.distinctServerLines },
  appPreferenceSites: { plan: PLAN_COUNTS.appPreferenceSites, realIncludingDefinitions: app.siteCountIncludingDefinitions, calls: app.callCount, definitions: app.definitionCount, internal: app.internalCallCount, fallbacks: app.fallbackCount },
  resolveProviderBinarySites: { plan: PLAN_COUNTS.resolveProviderBinarySites, real: spawns.resolveProviderBinaryCount },
  serverSpawnShapedLines: { plan: PLAN_COUNTS.serverSpawnShapedLines, realIncludingComments: spawns.spawnShapedLinesIncludingComments, realCalls: spawns.spawnCallLineCount, nonProvider: spawns.spawnClassCounts.non_provider ?? 0 },
  muSubprocessSites: { plan: PLAN_COUNTS.muSubprocessSites, real: mu.siteCount, files: mu.siteFileCount, filesIncludingNonPython: mu.fileCountIncludingNonPython, aliasAndWrapperSites: mu.extraSiteCount, allSites: mu.allSiteCount },
  claudeSettingsHooks: { plan: PLAN_COUNTS.claudeSettingsHooks, real: mu.hooks.claudeSettings.count },
  codexHooks: { plan: PLAN_COUNTS.codexHooks, real: mu.hooks.codexHooks.count },
  codexHomePlanReaders: { plan: 13, real: readers.planReaderCount },
}

const problems = [...prefs.problems, ...spawns.problems]
if (mu.planNamedLinesMissingFromGrep.length) problems.push(...mu.planNamedLinesMissingFromGrep.map(x => `6.2: plan line not a grep hit ${x}`))

const census = {
  schema: 'key-lanes-census/1',
  generator: 'server/lib/__fixtures__/key-lanes/census-generate.mjs',
  shas: SHAS,
  counts,
  problems,
  serverPreference: prefs,
  familyGuards: family,
  appPreference: app,
  serverSpawn: spawns,
  codexHomes: readers,
  mu: { see: 'operations/scripts/tests/fixtures/child_env_census.json (MU repo)', siteCount: mu.siteCount, hookCounts: { claude: mu.hooks.claudeSettings.count, codex: mu.hooks.codexHooks.count } },
}
const muCensusDoc = { schema: 'key-lanes-child-env-census/1', generator: 'cos-glasses-server server/lib/__fixtures__/key-lanes/census-generate.mjs', counts: { muSubprocessSites: counts.muSubprocessSites, claudeSettingsHooks: counts.claudeSettingsHooks, codexHooks: counts.codexHooks }, ...mu }

writeFileSync(out, `${JSON.stringify(census, null, 2)}\n`)
writeFileSync(muOut, `${JSON.stringify(muCensusDoc, null, 2)}\n`)
console.log(JSON.stringify({ counts, problems }, null, 2))
if (problems.length) process.exitCode = 3
