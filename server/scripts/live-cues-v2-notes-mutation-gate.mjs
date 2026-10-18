#!/usr/bin/env node
// Live cues v2 6.76.2 mutation gate: the runtime switch, the notes fallback and the decision provider. Mutations run only
// in a disposable copy of the checkout; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/live-cues-v2-notes-mutation-gate.mjs [--list] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CUES = ['server/lib/live-cues-v2.test.ts', 'server/lib/live-cues-v2-notes.test.ts', 'server/lib/live-cues-v2-notes-bridge.test.ts',
  'server/lib/live-cues-v2-settings.test.ts', 'server/routes/live-cues-v2-settings-route.test.ts', 'server/routes/live-cues-v2-route.test.ts']
const HEALTH = [...CUES, 'server/routes/health.test.ts']
const ENGINE = 'server/lib/live-cues-v2.ts', NOTES = 'server/lib/live-cues-v2-notes.ts', SETTINGS = 'server/lib/live-cues-v2-settings.ts'
const ROUTE = 'server/routes/live-cues.ts', DECISION = 'server/lib/decision-provider.ts'
const m = (name, file, edits, tests = CUES) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Runtime switch ──
  m('env-forces-only-exact-1', SETTINGS, ["return env.COS_LIVE_CUES_V2 === '1'", 'return !!env.COS_LIVE_CUES_V2']),
  m('env-forced-wins-over-setting', SETTINGS, ["if (liveCuesV2EnvForced(env)) return { enabled: true, source: 'env' }", 'if (false) return { enabled: true, source: \'env\' }']),
  m('saved-setting-read', SETTINGS, ["if (stored !== null) return { enabled: stored, source: 'setting' }", "if (stored === true) return { enabled: stored, source: 'setting' }"]),
  m('malformed-setting-is-none', SETTINGS, ["typeof (raw as { enabled?: unknown }).enabled === 'boolean'", '(raw as { enabled?: unknown }).enabled !== undefined']),
  m('cache-follows-write', SETTINGS, ['    this.cache = { value: enabled }\n', '']),
  m('failed-write-keeps-memory', SETTINGS, [
    ['    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })\n', '    this.cache = { value: enabled }\n    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })\n'],
    ["{ mode: 0o600 })\n    this.cache = { value: enabled }\n", '{ mode: 0o600 })\n']]),
  m('settings-file-private', SETTINGS, ["+ '\\n', { mode: 0o600 })", "+ '\\n', { mode: 0o644 })"]),
  m('engine-reads-setting', ENGINE, ['private enabled(): boolean { return liveCuesV2Enabled(this.deps.env, this.deps.settings) }', 'private enabled(): boolean { return liveCuesV2Enabled(this.deps.env, null) }']),
  m('feed-stops-while-off', ENGINE, ['    if (!this.enabled()) return\n    if (this.deps.store.isEnded(sessionId)) return', '    if (this.deps.store.isEnded(sessionId)) return']),
  m('last-check-before-emit', ENGINE, ['|| this.deps.store.isPaused(s.sessionId) || !this.enabled()) {', '|| this.deps.store.isPaused(s.sessionId)) {']),
  m('suspend-aborts-in-flight', ENGINE, ['if (s.inFlight) { s.inFlight.abort(V2_OFF); aborted += 1 }', 'if (s.inFlight) { aborted += 1 }']),
  m('cancel-reason-traced', ENGINE, ["      if (trace.outcome === 'cancelled' && abort.signal.reason === V2_OFF) trace.cancelReason = V2_OFF\n", '']),
  m('env-forced-off-refused', ENGINE, ["if (!enabled && liveCuesV2EnvForced(env)) return { ok: false, error: 'env_forced' }", "if (false) return { ok: false, error: 'env_forced' }"]),
  m('turning-off-suspends', ENGINE, ['const aborted = engine?.suspend() ?? 0', 'const aborted = 0']),
  m('suspend-only-on-transition', ENGINE, ['if (wasOn && !liveCuesV2Enabled(env)) {', 'if (!liveCuesV2Enabled(env)) {']),
  m('saved-meeting-ends-known-session', ENGINE, ['(liveCuesV2Enabled() || engine?.knows(sid))', 'liveCuesV2Enabled()']),
  m('knows-armed-sessions', ENGINE, ['knows(sessionId: string): boolean { return this.sessions.has(sessionId) }', 'knows(sessionId: string): boolean { return false }']),
  m('route-v2-owns-known-meeting', ROUTE, ['return liveCuesV2Enabled() || (peekLiveCuesV2()?.knows(sessionId) ?? false)', 'return liveCuesV2Enabled()']),
  m('route-boolean-enabled-only', ROUTE, ["typeof body.enabled !== 'boolean'", 'body.enabled === undefined']),
  m('route-409-body', ROUTE, ['if (!result.ok) return res.status(409).json({ error: result.error })', 'if (!result.ok) return res.status(200).json(liveCuesV2SettingsView())']),
  m('advertised-follows-setting', ENGINE, ['return liveCuesV2Enabled(env) ? liveCuesV2Capability() : undefined', "return env.COS_LIVE_CUES_V2 === '1' ? liveCuesV2Capability() : undefined"], HEALTH),
  // ── Notes fallback (engine) ──
  m('fallback-runs-on-failure', ENGINE, ['if (cueMemoryFailed(mem) && !abort.signal.aborted) {', 'if (false) {']),
  m('cue-memory-preferred', ENGINE, ['if (cueMemoryFailed(mem) && !abort.signal.aborted) {', 'if (!abort.signal.aborted) {']),
  m('failure-codes-only', ENGINE, ['return !!mem.denseError && CUE_MEMORY_FAILURES.has(mem.denseError)', 'return !!mem.denseError']),
  m('timeout-is-a-failure', ENGINE, ["'no_cue_memory_script', 'memory_timeout', 'spawn_failed'", "'no_cue_memory_script', 'spawn_failed'"]),
  m('notes-candidates-to-judge', ENGINE, ['        mem = { notes: found.notes }\n', '        mem = { notes: [] }\n']),
  m('notes-get-session-and-bound', ENGINE, ['this.deps.notes(window, before, abort.signal, s.sessionId)', "this.deps.notes(window, before, abort.signal, '')"]),
  m('source-none-when-empty', ENGINE, ["cueMemorySource: mem.notes.length ? source : 'none'", 'cueMemorySource: source']),
  m('capability-memory-source', ENGINE, [": notesAvailable() ? 'notes' : 'none'", ": 'none'"]),
  // ── Notes fallback (search) ──
  m('notes-date-bound', NOTES, ['      if (c.date && c.date >= before) return\n', '']),
  m('notes-local-day', NOTES, ["return Number.isFinite(ms) ? new Date(ms).toLocaleDateString('en-CA') : ''", "return Number.isFinite(ms) ? v.slice(0, 10) : ''"]),
  m('notes-drop-live-meeting', NOTES, ['hits.filter(h => !(opts.sessionId && h.sessionId === opts.sessionId))', 'hits']),
  m('notes-budget-race', NOTES, ['new Promise<boolean>(r => { timer = setTimeout(() => r(true), budgetMs) })', 'new Promise<boolean>(() => {})']),
  m('notes-bridge-timeout', NOTES, ['searchers.bridge(local.signal, budgetMs)', 'searchers.bridge(local.signal, 30_000)']),
  m('notes-abort-at-budget', NOTES, ['  clearTimeout(timer)\n  local.abort()\n', '  clearTimeout(timer)\n']),
  m('notes-aborted-gets-nothing', NOTES, ['  if (signal.aborted) return { notes: [] }\n', '']),
  m('notes-no-terms-no-search', NOTES, ["  if (!terms.length) return { notes: [], error: 'notes_no_terms' }\n", '']),
  m('notes-queries-short', NOTES, ['terms.slice(0, 4).join', 'terms.join']),
  m('notes-stopwords', NOTES, ['if (term.length < 3 || STOP.has(term) ||', 'if (term.length < 3 ||']),
  m('notes-rank-fusion', NOTES, ['score: (prev?.score ?? 0) + 1 / (RRF_K + rank)', 'score: 1 / (RRF_K + rank)']),
  m('notes-top-four', NOTES, ['.sort((a, b) => b.score - a.score).slice(0, top)', '.sort((a, b) => b.score - a.score)']),
  m('notes-bridge-scored', NOTES, ['    .filter(x => x.score > 0).sort(', '    .sort(']),
  m('notes-bridge-needs-content', NOTES, ['if (!id || !content.trim()) continue', 'if (!id) continue']),
  m('notes-bridge-searched', NOTES, ['    for (const q of queries) add(rankBridgeMemories(rows, q).map(bridgeCandidate))\n', '']),
  m('notes-real-memories-keyword-only', NOTES, ['(await searchMemories({ query, limit: 10, semantic: false, signal })).hits', '[]']),
  m('notes-real-meetings-keyword-only', NOTES, ['(await searchMeetingLibrary({ query, limit: 10, semantic: false, signal })).hits', '[]']),
  // ── Decision provider ──
  m('cue-override-read', ENGINE, ['  if (raw !== undefined) {\n', '  if (false) {\n']),
  m('cue-override-validated', ENGINE, ["    if (v !== 'jev' && v !== 'subq') throw new DecisionProviderError('decision_invalid_provider')\n", '']),
  m('only-key-subq', ENGINE, ["  if (!keys.jev() && keys.subq()) return { provider: 'subq', source: 'only_key' }\n", '']),
  m('only-key-needs-no-jev', ENGINE, ['if (!keys.jev() && keys.subq()) return', 'if (keys.subq()) return']),
  m('global-env-ignored', ENGINE, ['  const raw = env.COS_DECISION_PROVIDER_CUES\n', "  const raw = env.COS_DECISION_PROVIDER_CUES ?? env.COS_DECISION_PROVIDER\n"]),
  m('global-setting-ignored', ENGINE, [
    ["import type { DecisionProvider } from './decision-settings.js'", "import { readDecisionSettings, type DecisionProvider } from './decision-settings.js'"],
    ['  const raw = env.COS_DECISION_PROVIDER_CUES\n', '  const raw = env.COS_DECISION_PROVIDER_CUES ?? readDecisionSettings().provider\n']]),
  m('judge-uses-evaluation-provider', ENGINE, ['abort.signal, provider)\n        Object.assign(trace, { judgeMs', 'abort.signal, this.deps.decisionProvider())\n        Object.assign(trace, { judgeMs']),
  m('gate-uses-provider', ENGINE, ['await this.deps.gate(s.title, window, abort.signal, provider)', "await this.deps.gate(s.title, window, abort.signal, 'jev')"]),
  m('real-deps-route-subq', ENGINE, ["cueDecisionCalls(provider === 'subq' ? subq : jev)", 'cueDecisionCalls(jev)']),
  m('capability-key-check', ENGINE, ["      if (!st.configured) return off(provider === 'jev' && this.deps.decisionState('subq').configured ? 'jev_not_configured' : 'decision_not_configured')\n", '']),
  m('jev-alias-only-with-subq-key', ENGINE, ["provider === 'jev' && this.deps.decisionState('subq').configured ? 'jev_not_configured'", "provider === 'jev' ? 'jev_not_configured'"]),
  m('decision-not-configured-reason', ENGINE, ["this.deps.decisionState('subq').configured ? 'jev_not_configured' : 'decision_not_configured'", "this.deps.decisionState('subq').configured ? 'jev_not_configured' : 'jev_not_configured'"]),
  m('capability-selected-provider-state', ENGINE, ['      const st = this.deps.decisionState(provider)\n', "      const st = this.deps.decisionState('jev')\n"]),
  m('subq-cap-reason', ENGINE, ["off(provider === 'jev' ? 'jev_cap_reached' : 'decision_cap_reached')", "off('jev_cap_reached')"]),
  m('subq-breaker-reason', ENGINE, ["off(provider === 'jev' ? 'jev_breaker_open' : 'decision_breaker_open')", "off('jev_breaker_open')"]),
  m('capability-names-provider', ENGINE, ['...(provider ? { decisionProvider: provider } : {})', '...({})']),
  m('quiet-decision-stops', ENGINE, ["'decision_cap_reached', 'decision_breaker_open', 'decision_not_configured', 'decision_invalid_provider'])", "'decision_breaker_open', 'decision_not_configured', 'decision_invalid_provider'])"]),
  m('quiet-sees-decision-errors', ENGINE, ['if ((error instanceof JevError || error instanceof DecisionProviderError) && QUIET_DECISION_STOPS.has(error.code)) {', 'if (error instanceof JevError && QUIET_DECISION_STOPS.has(error.code)) {']),
  m('decision-error-code-traced', ENGINE, ["trace.error = error instanceof JevError || error instanceof DecisionProviderError ? error.code :", "trace.error = error instanceof JevError ? error.code :"]),
  m('subq-cue-cap-env', ENGINE, ['Number(process.env.COS_LIVE_CUES_SUBQ_DAILY_TOKENS)', 'Number(process.env.COS_SUBQ_DAILY_TOKENS)']),
  m('subq-cue-ledger', ENGINE, ["dataPath('subq-cues-usage.json')", "dataPath('subq-usage.json')"]),
  m('subq-configured-honest', ENGINE, ['return { configured: st.configured, breakerOpen: st.breakerOpenUntil !== null', 'return { configured: true, breakerOpen: st.breakerOpenUntil !== null']),
  m('subq-status-unreadable-is-spent', DECISION, ['    let usedToday = dailyCap\n', '    let usedToday = 0\n']),
  m('subq-tracked-for-new-key', DECISION, ['{ configuredSubqClients.add(client); return client }', '{ return client }']),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')

const scratch = mkdtempSync(join(tmpdir(), 'cues-notes-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  for (const dir of ['shared', 'work-task-runtime', 'bin', 'docs']) cpSync(join(root, dir), join(scratch, dir), { recursive: true })
  for (const file of ['vitest.config.ts', 'package.json', 'managed-runtime-contract.json']) cpSync(join(root, file), join(scratch, file))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: process.env.TMPDIR, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json') },
    encoding: 'utf8', timeout: 300000,
  })
  const baseline = run(HEALTH)
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  const totals = /Tests\s+(\d+) passed/.exec(baseline.stdout)
  console.log(`baseline PASS (${totals ? totals[1] : '?'} tests in ${HEALTH.length} files)`)
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
  console.log(`${killed} of ${selected.length} live cues 6.76.2 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
