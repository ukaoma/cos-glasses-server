#!/usr/bin/env node
// Key lanes K1 P3 mutation gate (plan v4 14.2 row P3): Lane B Claude. The keyed session key and
// its skip, the pre-warm handoff, the settings-layer guard, the keyed refusals (handoff, attach,
// fork), the credential strip, the relay env, the nonce lifecycle, the preflight refusals and the
// no-profile golden. Mutations run only in a disposable copy of the checkout; the live checkout
// is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/key-lanes-p3-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BRIDGE_T = ['server/lib/claude-bridge-key-lanes.test.ts']
const GOLDEN_T = ['server/lib/claude-bridge-key-lanes-off-identity.test.ts']
const UNIT_T = ['server/lib/lane-b-env.test.ts']
const KEYED_T = ['server/lib/keyed-sessions.test.ts']
const HANDOFF_T = ['server/routes/handoffs-keyed.test.ts']
const ALL = [...BRIDGE_T, ...GOLDEN_T, ...UNIT_T, ...KEYED_T, ...HANDOFF_T]
const BRIDGE = 'server/lib/claude-bridge.ts', LANEB = 'server/lib/lane-b-env.ts', GUARD = 'server/lib/claude-settings-guard.ts'
const KEYED = 'server/lib/keyed-sessions.ts', HANDOFF = 'server/routes/handoffs.ts'
const ADAPTER = 'server/lib/attached-provider-adapter.ts', FORK = 'server/lib/fork-thread.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Session map (plan 7.1) ──
  m('p-skip-removed', BRIDGE, ["      if (key.includes(':p:', cosSessionId.length)) continue\n", ''], BRIDGE_T),
  m('keyed-key-same-as-subscription', BRIDGE, ['keyProfile ? keyedCliSessionKey(sid, resolvedModel, keyProfile.id) : cliSessionKey(sid, resolvedModel)', 'cliSessionKey(sid, resolvedModel)'], BRIDGE_T),
  m('prewarm-not-profile-removed', BRIDGE, [' && resolvedModel === DEFAULT_MODEL && !keyProfile) {', ' && resolvedModel === DEFAULT_MODEL) {'], BRIDGE_T),
  // ── Settings-layer guard (plan 7.2, W17) ──
  m('settings-guard-removed', LANEB, ['  if (settings) return { ok: false, message: settings.message }\n', ''], BRIDGE_T),
  m('settings-guard-ignores-api-key-helper', GUARD, ["    if (settings.apiKeyHelper !== undefined && settings.apiKeyHelper !== null && settings.apiKeyHelper !== '') {", '    if (false) {'], BRIDGE_T),
  m('settings-guard-skips-local-file', GUARD, ["    join(input.cwd, '.claude', 'settings.local.json'),\n", ''], [...BRIDGE_T, ...UNIT_T]),
  // ── Keyed refusals (plan 7.3) ──
  m('keyed-refusal-removed-handoff-create', HANDOFF, ["    if (keyedHandoff(body, (input.runtime as any)?.claude?.cliSessionId)) return res.status(409).json(KEYED_SESSION_REFUSAL)\n", ''], HANDOFF_T),
  m('keyed-refusal-removed-handoff-claim', HANDOFF, ['    if (anyKeyedSessions() && keyedHandoff((await getHandoff(code)) as Record<string, any> | null)) {', '    if (false) {'], HANDOFF_T),
  m('keyed-refusal-removed-attach', ADAPTER, ['  if (anyKeyedSessions() && isKeyedSession(nativeThreadId)) {', '  if (false) {'], KEYED_T),
  m('keyed-refusal-removed-fork', FORK, ['  if (anyKeyedSessions() && isKeyedSession(sourceNativeThreadId)) {', '  if (false) {'], KEYED_T),
  m('keyed-not-recorded-at-init', BRIDGE, ["          if (keyProfile) recordKeyedSession({ id: event.session_id, engine: 'claude', profileId: keyProfile.id, cosSessionId: sid })\n          updateClaudeRun", '          updateClaudeRun'], BRIDGE_T),
  m('keyed-store-forgets-file', KEYED, ['  return fileRecords().some(r => r.id === id)', '  return false'], [...KEYED_T, ...HANDOFF_T]),
  // ── Child env (plan 7.2, 4.4) ──
  m('credential-strip-widened-to-all-env', LANEB, ['  return LANE_B_STRIPPED_NAMES.includes(name) || LANE_B_STRIPPED_PATTERN.test(name)', '  return true'], [...BRIDGE_T, ...UNIT_T]),
  m('credential-strip-misses-default-models', LANEB, ['  return LANE_B_STRIPPED_NAMES.includes(name) || LANE_B_STRIPPED_PATTERN.test(name)', '  return LANE_B_STRIPPED_NAMES.includes(name)'], [...BRIDGE_T, ...UNIT_T]),
  m('agent-teams-not-stripped', LANEB, ["  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',\n", ''], [...BRIDGE_T, ...UNIT_T]),
  m('relay-env-not-applied', BRIDGE, ['      applyLaneBClaudeEnv(env, { origin: keyTurn.origin, nonce: keyTurn.nonce, slug: keyProfile.model, profileId: keyProfile.id })\n', ''], BRIDGE_T),
  m('retries-zero', LANEB, ["export const LANE_B_CLAUDE_MAX_RETRIES = '2'", "export const LANE_B_CLAUDE_MAX_RETRIES = '0'"], [...BRIDGE_T, ...UNIT_T]),
  m('model-env-anthropic-model-set', LANEB, ['  for (const name of LANE_B_CLAUDE_MODEL_NAMES) env[name] = spec.slug\n', '  for (const name of LANE_B_CLAUDE_MODEL_NAMES) env[name] = spec.slug\n  env.ANTHROPIC_MODEL = spec.slug\n'], [...BRIDGE_T, ...UNIT_T]),
  m('loopback-origin-unchecked', LANEB, ["  if (!LOOPBACK_ORIGIN_RE.test(spec.origin)) throw new Error('lane-b-env: the relay origin is not loopback')\n", ''], UNIT_T),
  m('process-env-write-allowed', LANEB, ["  if (env === process.env) throw new Error('lane-b-env: refusing to write process.env')\n", ''], UNIT_T),
  m('slug-not-on-model-flag', BRIDGE, ['  if (keyProfile) args[2] = keyProfile.model\n', ''], BRIDGE_T),
  m('timeouts-not-from-tier', BRIDGE, ['keyProfile ? keyProfile.timeoutTier : (model', '(model'], BRIDGE_T),
  // ── Preflight: refuse, never fall back (plan 7.1) ──
  m('preflight-ignores-lanes-inactive', LANEB, ['  if (!keyLanesActive()) return { ok: false, message: LANE_B_COPY.lanesOff }\n', ''], BRIDGE_T),
  m('preflight-allows-disabled-profile', LANEB, ['  if (!profile.enabled) return { ok: false, message: LANE_B_COPY.profileOff(profile.label) }\n', ''], BRIDGE_T),
  m('preflight-allows-dispatch', LANEB, ['  if (input.dispatch) return { ok: false, message: LANE_B_COPY.scheduled }\n', ''], BRIDGE_T),
  m('preflight-allows-missing-relay', LANEB, ['  if (!laneBRelayRegistered()) return { ok: false, message: LANE_B_COPY.relayUnavailable }\n', ''], BRIDGE_T),
  m('relay-failure-falls-through-to-spawn', BRIDGE, ['      await callbacks.onError(LANE_B_COPY.relayUnavailable)\n      return sid\n', ''], BRIDGE_T),
  // ── Nonce lifecycle (plan 4.3) ──
  m('nonce-not-closed-with-child', BRIDGE, ['    keyTurn?.childClosed()\n', ''], BRIDGE_T),
  m('nonce-not-revoked-on-cancel', BRIDGE, ["    keyTurn?.revoke('cancel')\n    void terminateForTerminal", '    void terminateForTerminal'], BRIDGE_T),
  // ── Answer, history and audit fields ──
  m('exchange-stamped-with-tier', BRIDGE, ['const exchangeModel = keyProfile ? profilePreference(keyProfile.id) as unknown as ModelPreference : resolvedModel', 'const exchangeModel = resolvedModel'], BRIDGE_T),
  m('audit-key-fields-dropped', BRIDGE, ['      ...keyAuditFields,\n', ''], BRIDGE_T),
  // P11: the done line now also carries the turn's usd (anchor re-pinned at integration).
  m('done-key-lane-dropped', BRIDGE, ['      ...(keyLane ? { keyLane, ...keyUsdFields } : {}),\n    })\n    if (terminalOwned === false) return', '    })\n    if (terminalOwned === false) return'], BRIDGE_T),
  // ── No profile: the b7c620e spawn (G-off) can fail ──
  m('golden-lane-a-credential-stripped', BRIDGE, ['  delete env.CLAUDECODE\n  if (outputImagePublisher) Object.assign(env, outputImagePublisher.env)', '  delete env.CLAUDECODE\n  delete env.OPENROUTER_API_KEY\n  if (outputImagePublisher) Object.assign(env, outputImagePublisher.env)'], GOLDEN_T),
  m('golden-subscription-map-skipped', BRIDGE, ["      if (key.includes(':p:', cosSessionId.length)) continue\n", '      continue\n'], GOLDEN_T),
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

const scratch = mkdtempSync(join(tmpdir(), 'key-lanes-p3-mutations-'))
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
  console.log(`${killed} of ${selected.length} key lanes P3 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
