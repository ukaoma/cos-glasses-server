#!/usr/bin/env node
// Key lanes K1 P4 mutation gate (plan v4 14.2 row P4): Lane B Codex and the per-profile homes.
// The profile branch of the Codex bridge, the generated home (config, hooks, trust, no auth.json),
// the child env, the resume binding, codexHomes() and every reader built on it. Mutations run
// only in a disposable copy of the checkout; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/key-lanes-p4-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BRIDGE_T = ['server/lib/codex-bridge-key-lanes.test.ts']
const OFF_T = ['server/lib/codex-bridge-key-lanes-off-identity.test.ts']
const HOME_T = ['server/lib/codex-profile-home.test.ts']
const READ_T = ['server/lib/codex-homes-readers.test.ts']
const ALL = [...BRIDGE_T, ...OFF_T, ...HOME_T, ...READ_T]
const BRIDGE = 'server/lib/codex-bridge.ts', PHOME = 'server/lib/codex-profile-home.ts', HOMES = 'server/lib/codex-homes.ts'
const STORE = 'server/lib/agent-session-store.ts', HEAD = 'server/lib/native-head.ts', QUEUE = 'server/lib/codex-queue-control.ts'
const OCC = 'server/lib/thread-occupancy.ts', PROBES = 'server/lib/occupancy-probes.ts', HOOKS = 'server/lib/session-hook-events.ts'
const LIVE = 'server/lib/codex-live-queue.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── The four the plan names (14.2 row P4 and the P4 brief) ──
  m('profile-branch-keeps-extra-args', BRIDGE, ["  args.push('-c', `model_provider=\"${CODEX_RELAY_PROVIDER_ID}\"`)\n", "  args.push('-c', `model_provider=\"${CODEX_RELAY_PROVIDER_ID}\"`)\n  args.push(...parseCodexExtraArgs(process.env.COS_CODEX_EXTRA_ARGS))\n"], BRIDGE_T),
  m('iterator-skips-server-home', HOMES, ['  return [serverHome, ...profileCodexHomes(env).map(entry => entry.home)]', '  return [...profileCodexHomes(env).map(entry => entry.home)]'], READ_T),
  m('auth-json-copied', PHOME, ['  try { lstatSync(auth); unlinkSync(auth) } catch { /* none, as it should be */ }', "  try { atomicWriteFileSync(auth, readFileSync(join(serverCodexHome(), 'auth.json'))) } catch { /* mutant */ }"], [...BRIDGE_T, ...HOME_T]),
  m('fingerprint-ignores-profile', BRIDGE, ['  const extraFingerprint = profileHome ? profileHome.engineFingerprint : codexEngineFingerprint(extra)', '  const extraFingerprint = codexEngineFingerprint(extra)'], BRIDGE_T),
  // ── Profile branch of the bridge ──
  m('profile-reads-chatgpt-catalog', BRIDGE, ['  const resolvedCodexModel = keyProfile ? null : resolveCodexModelOption(model)', '  const resolvedCodexModel = resolveCodexModelOption(model)'], BRIDGE_T),
  m('lane-a-loses-extra-args', BRIDGE, ['  if (keyProfile) {\n    extra = []', '  if (true) {\n    extra = []'], OFF_T),
  m('exchange-stamped-with-slot', BRIDGE, ['  const exchangeModel = keyProfile ? profilePreference(keyProfile.id) as unknown as CodexModelPreference : model', '  const exchangeModel = model'], BRIDGE_T),
  m('child-env-not-pointed-at-home', BRIDGE, ['      applyCodexLaneBEnv(env, { home: profileHome.home, nonce: keyTurn.nonce, profileId: keyProfile.id })\n', ''], BRIDGE_T),
  m('home-not-written', BRIDGE, ['      writeCodexProfileHome(profileHome, keyTurn.origin)\n', ''], BRIDGE_T),
  m('audit-without-key-fields', BRIDGE, ['      ...keyAuditFields,\n', ''], BRIDGE_T),
  m('keyed-thread-not-recorded', BRIDGE, ["      if (keyProfile) recordKeyedCodexThread({ id: nextThreadId, engine: 'codex', profileId: keyProfile.id, cosSessionId: sid })\n", ''], BRIDGE_T),
  m('nonce-kept-past-child-close', BRIDGE, ['    keyTurn?.childClosed()\n', ''], BRIDGE_T),
  m('nonce-kept-on-cancel', BRIDGE, ["  function handleAbort() {\n    keyTurn?.revoke('cancel')\n", '  function handleAbort() {\n'], BRIDGE_T),
  m('nonce-kept-on-sync-spawn-throw', BRIDGE, ["  } catch (err) {\n    keyTurn?.revoke('cancel')\n    throw err", '  } catch (err) {\n    throw err'], BRIDGE_T),
  // ── Preflight: fails closed, never a subscription turn ──
  m('preflight-ignores-lanes-off', PHOME, ['  if (!keyLanesActive()) return { ok: false, message: CODEX_LANE_B_COPY.lanesOff }\n', ''], [...BRIDGE_T, ...HOME_T]),
  m('preflight-ignores-missing-relay', PHOME, ['  if (!codexKeyRelayRegistered()) return { ok: false, message: CODEX_LANE_B_COPY.relayUnavailable }\n', ''], [...BRIDGE_T, ...HOME_T]),
  m('preflight-allows-dispatch', PHOME, ['  if (input.dispatch) return { ok: false, message: CODEX_LANE_B_COPY.scheduled }\n', ''], [...BRIDGE_T, ...HOME_T]),
  m('preflight-allows-any-model', PHOME, ["  if (engineModelProblem('codex', profile.model, key.kind)) return", '  if (false) return'], HOME_T),
  // ── Child env ──
  m('env-keeps-credentials', PHOME, ['    if (isCodexLaneBStrippedName(name)) delete env[name]\n', ''], [...BRIDGE_T, ...HOME_T]),
  m('env-codex-home-not-set', PHOME, ['  env.CODEX_HOME = spec.home\n', ''], [...BRIDGE_T, ...HOME_T]),
  // ── Generated home ──
  m('wire-api-chat', PHOME, ["    'wire_api = \"responses\"',", "    'wire_api = \"chat\"',"], [...BRIDGE_T, ...HOME_T]),
  m('copies-top-level-keys', PHOME, ['      if (!path) continue', '      if (!path) { out.push(...section.body); continue }'], HOME_T),
  m('trust-copied-for-any-block', PHOME, ['          if (at === undefined || Number(parsed[3]) !== at) continue', "          if (at === undefined) { out.push(section.header, ...section.body); continue }"], HOME_T),
  m('hooks-mirror-every-event', PHOME, ['  for (const event of subscribed) if (allBlocks[event] !== undefined) hooks[event] = allBlocks[event]', '  for (const event of Object.keys(allBlocks)) hooks[event] = allBlocks[event]'], HOME_T),
  m('multiline-string-splits-table', PHOME, ['    if (inMulti) {', '    if (false) {'], HOME_T),
  m('non-loopback-origin-accepted', PHOME, ["  if (!LOOPBACK_ORIGIN_RE.test(relayOrigin)) throw new Error('codex-profile-home: the relay origin is not loopback')\n", ''], HOME_T),
  // ── codexHomes() ──
  m('homes-listed-with-lanes-off', HOMES, ['  if (!keyLanesEnabled(env)) return []\n', ''], [...READ_T, ...OFF_T]),
  m('profile-path-any-codex-homes-dir', HOMES, [['  if (!path.startsWith(root)) return undefined\n  const id = path.slice(root.length).split(sep)[0]', "  const at = path.indexOf('/codex-homes/')\n  if (at < 0) return undefined\n  const id = path.slice(at + '/codex-homes/'.length).split(sep)[0]"]], READ_T),
  // ── Readers (plan 8.2) ──
  m('store-roots-field-always-present', STORE, ['  return dirs.length ? { codexProfileSessions: dirs } : {}', '  return { codexProfileSessions: dirs }'], READ_T),
  m('store-lists-server-home-only', STORE, ['    ...(await Promise.all(codexSessionRootsOf(roots).map(root => listCodexSessions(root, now, cap, dropped)))).flat(),', '    ...(await Promise.all([roots.codexSessions].map(root => listCodexSessions(root, now, cap, dropped)))).flat(),'], READ_T),
  m('store-finds-server-home-only', STORE, ['    for (const root of codexSessionRootsOf(roots)) {', '    for (const root of [roots.codexSessions]) {'], READ_T),
  m('native-head-profile-dirs-not-wired', HEAD, ['    ...(roots.codexProfileSessions ? { codexProfileSessionsDirs: roots.codexProfileSessions } : {}),\n', ''], READ_T),
  m('queue-keyed-home-nulls-server', QUEUE, ['    if (counts === null) { if (home === homes[0]) return null; continue }', '    if (counts === null) return null'], READ_T),
  m('occupancy-keyed-owners-dropped', OCC, ['    owners.push(...keyed.owners)\n', ''], READ_T),
  m('occupancy-profile-locks-not-wired', PROBES, ['    ...(profileLocks.length ? { codexProfileLocksDirs: profileLocks } : {}),\n', ''], READ_T),
  m('hook-keyed-transcript-read-as-claude', HOOKS, ["  if (profileIdForCodexPath(payload.transcript_path) !== undefined) return 'codex'\n", ''], READ_T),
  m('hook-key-profile-null-not-omitted', HOOKS, ['      ...(keyProfile ? { keyProfile } : {}),', '      keyProfile,'], READ_T),
  m('live-queue-takes-keyed-thread', LIVE, ["  if ((deps.isKeyedThread ?? isProfileCodexThread)(request.sessionId)) return done('keyed_session')\n", ''], READ_T),
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

const scratch = mkdtempSync(join(tmpdir(), 'key-lanes-p4-mutations-'))
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
  console.log(`${killed} of ${selected.length} key lanes P4 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
