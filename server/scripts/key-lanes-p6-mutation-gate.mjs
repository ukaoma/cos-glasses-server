#!/usr/bin/env node
// Key lanes K1 P6 mutation gate (plan v4 14.2 row P6): the preference sites. Each Reject turned
// Accept, the steer guard removed, the /v1 auth branch inverted, and every way a profile turn
// could silently fall back to the subscription. Mutations run only in a disposable copy of the
// checkout; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated (the census included). A gate over a red suite reads
//      every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED behaviour test fails ("FAIL  server/x.test.ts > name"). The census test is never in
//      a mutant's list: it fails on any edit to a classified line, which would prove nothing.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/key-lanes-p6-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PREF_T = ['server/lib/key-lanes-p6-preference.test.ts']
const STEER_T = ['server/lib/key-lanes-p6-steer.test.ts']
const REJ_T = ['server/lib/key-lanes-p6-rejects.test.ts']
const V1_T = ['server/routes/key-lanes-p6-v1.test.ts']
const RT_T = ['server/lib/key-lanes-p6-runtime.test.ts']
const CENSUS_T = ['server/lib/key-lanes-p6-census.test.ts']
const ALL = [...PREF_T, ...STEER_T, ...REJ_T, ...V1_T, ...RT_T, ...CENSUS_T]
const ROUTER = 'server/lib/model-router.ts', ROUTING = 'server/lib/key-profile-routing.ts', CONV = 'server/lib/conversation.ts'
const RUNTIME = 'server/lib/query-job-runtime.ts', QUERY = 'server/routes/query.ts', STEER = 'server/lib/claude-steer.ts'
const COMPAT = 'server/routes/openai-compat.ts', BRIEF = 'server/lib/morning-brief-config.ts', TASKS = 'server/lib/task-store.ts'
const WREQ = 'server/lib/work-handoff-requests.ts', WACT = 'server/lib/work-activity.ts', REJECTS = 'server/lib/key-profile-rejects.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })
const ACCEPT = x => `((${x}) ?? (typeof (${x.slice(25, -1)}) === 'string' && String(${x.slice(25, -1)}).startsWith('profile:') ? ${x.slice(25, -1)} : undefined)) as never`

const mutations = [
  // ── Each Reject turned Accept ──
  m('brief-patch-accepts-profile', BRIEF, ['      const model = normalizeModelPreference(patch.model)', `      const model = ${ACCEPT('normalizeModelPreference(patch.model)')}`], REJ_T),
  m('brief-coerce-accepts-profile', BRIEF, ['  const model = normalizeModelPreference(input.model)', `  const model = ${ACCEPT('normalizeModelPreference(input.model)')}`], REJ_T),
  m('task-dispatch-accepts-profile', TASKS, ['  return config.model && isClaudeModel(config.model) ? config.model : DEFAULT_MODEL', "  return config.model && (isClaudeModel(config.model) || String(config.model).startsWith('profile:')) ? config.model : DEFAULT_MODEL"], REJ_T),
  m('work-request-accepts-profile', WREQ, ['    model = normalizeModelPreference(body.model)', `    model = ${ACCEPT('normalizeModelPreference(body.model)')}`], REJ_T),
  m('work-draft-accepts-profile', WACT, ['  const slot = normalizeModelPreference(draft.modelID)', `  const slot = ${ACCEPT('normalizeModelPreference(draft.modelID)')}`], REJ_T),
  m('reject-ignores-lanes-off', REJECTS, ['  const applies = isProfilePreference(value) && keyLanesEnabled()', '  const applies = isProfilePreference(value)'], REJ_T),
  m('env-default-accepts-profile', ROUTING, ['  return normalizeModelPreference(raw)', "  return (isProfilePreference(raw) ? raw : normalizeModelPreference(raw)) as never"], PREF_T),
  m('v1-not-offered-accepted', COMPAT, ['  if (keyProfileId !== undefined && !v1OfferedProfile(keyProfileId)) {', '  if (false) {'], V1_T),
  m('v1-offer-flag-ignored', ROUTING, ['p.enabled && p.offerOnV1 && getPublicKey', 'p.enabled && getPublicKey'], V1_T),
  m('v1-offers-while-inactive', ROUTING, ['  if (!keyLanesActive()) return []\n', ''], V1_T),
  // ── Steer ──
  m('steer-guard-removed', STEER, ["  if (bound?.kind === 'profile') return { kind: 'profile_session', profileId: bound.id }\n", ''], STEER_T),
  m('steer-any-profile-engine', ROUTING, ["  return resolved.ok && resolved.turn.profile.engine === 'claude' ? 'claude' : 'codex'", "  return 'claude'"], STEER_T),
  // ── /v1 auth ──
  m('v1-auth-branch-inverted', COMPAT, ['  if (keyLanesActive() && !validateAuth(req, res)) return', '  if (!keyLanesActive() && !validateAuth(req, res)) return'], V1_T),
  m('v1-auth-never', COMPAT, ['  if (keyLanesActive() && !validateAuth(req, res)) return', '  if (false && !validateAuth(req, res)) return'], V1_T),
  // ── Silent fallback to the subscription restored ──
  m('router-profile-to-subscription', ROUTER, ['  if (profileId !== undefined) return await runKeyProfileRoute(', '  if (false) return await runKeyProfileRoute('], PREF_T),
  m('resolve-runs-with-lanes-off', ROUTING, ['  if (!keyLanesActive()) return off()\n', ''], PREF_T),
  m('no-runner-to-subscription', ROUTER, ['    if (!runner) {\n      console.info(`[key-lanes] refused kind=no_runner engine=${resolved.turn.profile.engine}`)\n      await lockedCallbacks.onError(keyProfileUnavailableLine(resolved.turn.profile.label))', "    if (!runner) {\n      return await callClaudeStreaming(query, sid, lockedCallbacks, DEFAULT_MODEL, images, reference, globalMsgNum, options)"], PREF_T),
  m('profile-dispatch-runs', ROUTER, ['    if (options?.dispatch) {\n', '    if (false) {\n'], PREF_T),
  m('session-model-open', CONV, ['  return closedSessionModel(sessions.get(sessionId)?.modelPreference)', '  return (sessions.get(sessionId)?.modelPreference ?? null) as never'], PREF_T),
  m('load-drops-session-binding', CONV, ['    session.modelPreference = normalizeSessionBinding(session.modelPreference) ?? null', '    session.modelPreference = normalizeModelPreference(session.modelPreference) ?? null'], PREF_T),
  m('load-drops-exchange-stamp', CONV, ['      const exchangeModel = normalizeSessionBinding(exchange.modelPreference)', '      const exchangeModel = normalizeModelPreference(exchange.modelPreference)'], PREF_T),
  m('add-exchange-drops-stamp', CONV, ['  const stampedModel = normalizeSessionBinding(modelPreference)\n  const exchange: Exchange = {', '  const stampedModel = normalizeModelPreference(modelPreference)\n  const exchange: Exchange = {'], PREF_T),
  m('reconcile-drops-stamp', CONV, ['    : currentMessageEra()\n  const stampedModel = normalizeSessionBinding(modelPreference)', '    : currentMessageEra()\n  const stampedModel = normalizeModelPreference(modelPreference)'], PREF_T),
  m('pair-model-drops-profile', CONV, ['  return normalizeSessionBinding(\n    assistant?.modelPreference', '  return normalizeModelPreference(\n    assistant?.modelPreference'], PREF_T),
  m('remove-all-keeps-bindings', CONV, ["  if (reason === 'remove_all') clearProfileBindings()", '  void reason'], PREF_T),
  m('runtime-drops-profile', RUNTIME, ["    requestedBinding?.kind === 'profile' ? requestBinding(request.model) : validModel,", '    validModel,'], RT_T),
  m('runtime-linkage-ignores-binding', RUNTIME, ['  const linkageFor = (model: ModelPreference) => keyTurn\n', '  const linkageFor = (model: ModelPreference) => false && keyTurn\n'], RT_T),
  m('runtime-projection-drops-profile', RUNTIME, ['  return parsed.kind === \'model\' ? parsed.value : profilePreference(parsed.id) as KeyProfileBinding', '  return parsed.kind === \'model\' ? parsed.value : undefined'], RT_T),
  m('query-route-drops-profile', QUERY, ["    }, requestedBinding?.kind === 'profile' ? model as KeyProfileTurn['binding'] : validModel, imageInputs,", '    }, validModel, imageInputs,'], RT_T),
  m('key-turn-callback-leaks-to-bridge', ROUTER, ['  const { onKeyProfileTurn: _onKeyProfileTurn, ...streamCallbacks } = callbacks\n  const lockedCallbacks: StreamCallbacks = {\n    ...streamCallbacks,', '  const lockedCallbacks: StreamCallbacks = {\n    ...callbacks,'], PREF_T),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length && !args.includes('--check') ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && !args.includes('--check') && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')
// --check: every target matches exactly once and changes its file. Runs no tests.
if (args.includes('--check')) {
  let bad = 0
  for (const { name, file, edits } of mutations) {
    let text = readFileSync(join(root, file), 'utf8')
    const original = text
    for (const [find, replacement] of edits) {
      const n = text.split(find).length - 1
      if (n !== 1) { console.log(`${name}: matches ${n} times in ${file}: ${find.slice(0, 90)}`); bad++ }
      else text = text.replace(find, () => replacement)
    }
    if (text === original) { console.log(`${name}: no change`); bad++ }
  }
  console.log(`${mutations.length - bad} of ${mutations.length} targets match exactly once`)
  process.exit(bad ? 1 : 0)
}

const scratch = mkdtempSync(join(tmpdir(), 'key-lanes-p6-mutations-'))
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
    const killers = [...new Set([...output.matchAll(/FAIL\s+((?:server|shared)\/\S+\.test\.ts > [^\n]+)/g)].map(x => x[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { console.log(`${name} SURVIVED or harness failed\n${output.slice(-3000)}`); process.exitCode = 1; continue }
    killed += 1
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${killed} of ${selected.length} key lanes P6 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
