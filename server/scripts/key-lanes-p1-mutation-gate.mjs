#!/usr/bin/env node
// Key lanes K1 P1 mutation gate (plan v4 14.2 row P1): the two predicates, the exposure-list fields,
// the enable door, Mac-only writes, the key store's redaction, Remove all keys and the token-audit
// spreads. Mutations run only in a disposable copy of the checkout; the live checkout is never
// rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/key-lanes-p1-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LIB_T = ['server/lib/key-lanes.test.ts']
const ROUTE_T = ['server/routes/key-lanes.test.ts']
const EXPO_T = ['server/routes/key-lanes-exposure.test.ts']
const AUDIT_T = ['server/lib/token-audit-key-fields.test.ts']
const PREF_T = ['shared/key-preference.test.ts']
const ALL = [...LIB_T, ...ROUTE_T, ...EXPO_T, ...AUDIT_T, ...PREF_T]
const LANES = 'server/lib/key-lanes.ts', STORE = 'server/lib/key-store.ts', PROFILES = 'server/lib/key-profiles.ts'
const ROUTE = 'server/routes/key-lanes.ts', HEALTH = 'server/routes/health.ts', AUDIT = 'server/lib/token-audit.ts'
const PREF = 'shared/key-preference.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Predicates ──
  m('predicate-enabled-forced-true', LANES, ["  if (sw === 'off') return false\n  if (sw === 'on') return true\n", '  return true\n'], [...LIB_T, ...ROUTE_T]),
  m('predicate-active-forced-true', LANES, ['  return enabledProfileCount() > 0', '  return true'], [...LIB_T, ...EXPO_T]),
  m('env-off-does-not-win', LANES, ["  if (sw === 'off') return false\n", ''], [...LIB_T, ...ROUTE_T]),
  m('env-on-any-value', LANES, ["  if (raw === '1') return 'on'", "  if (raw) return 'on'"], LIB_T),
  m('state-file-not-cached', LANES, ['  if (fileEnabled === undefined) fileEnabled = readStateFileEnabled()', '  fileEnabled = readStateFileEnabled()'], LIB_T),
  m('file-created-while-disabled', LANES, ['  if (!existsSync(file)) return null', '  if (!existsSync(file)) { setKeyLanesEnabled(false); return null }'], [...LIB_T, ...ROUTE_T, ...EXPO_T]),
  m('torn-file-reads-on', LANES, ['    // A torn or foreign file reads as off. It is never repaired or rewritten from a read.\n    return false', '    return true'], LIB_T),
  // ── Exposure fields: omitted, never null ──
  m('health-omit-vs-null', LANES, ['  if (!keyLanesEnabled(env)) return {}', '  if (!keyLanesEnabled(env)) return { details: null } as never'], [...LIB_T, ...EXPO_T]),
  m('models-omit-vs-null', LANES, ['  if (!keyLanesActive(env)) return {}', '  if (!keyLanesActive(env)) return { keyProfiles: null } as never'], [...LIB_T, ...EXPO_T]),
  m('models-lists-disabled-profiles', LANES, ['    if (!p.enabled || !keyKind) continue', '    if (!keyKind) continue'], LIB_T),
  m('health-field-not-wired', HEALTH, ['    ...keyLanesHealthFields(),\n', ''], EXPO_T),
  m('models-field-not-wired', HEALTH, ['    ...keyProfilesModelsField(),\n', ''], EXPO_T),
  // ── Token audit: a Lane A row stays byte-identical ──
  m('audit-lane-null-not-omitted', AUDIT, ['    ...(entry.lane ? { lane: entry.lane } : {}),', '    lane: entry.lane ?? null,'], AUDIT_T),
  m('audit-profile-null-not-omitted', AUDIT, ['    ...(entry.profile ? { profile: entry.profile } : {}),', '    profile: entry.profile ?? null,'], AUDIT_T),
  m('audit-usd-zero-dropped', AUDIT, ["    ...(typeof entry.usd === 'number' && Number.isFinite(entry.usd) ? { usd: entry.usd } : {}),", '    ...(entry.usd ? { usd: entry.usd } : {}),'], AUDIT_T),
  // ── The enable door (the one off-state difference) ──
  m('door-unauthenticated', ROUTE, ["    && timingSafeTokenEqual(req.headers['x-cos-token'], apiToken())\n", ''], ROUTE_T),
  m('door-ignores-env-off', ROUTE, ["    && keyLanesEnvSwitch() !== 'off'\n", ''], ROUTE_T),
  m('door-any-path', ROUTE, ['    && requestPath(req) === KEY_LANES_ENABLE_PATH\n', ''], ROUTE_T),
  m('enable-from-g2-allowed', ROUTE, ["  if (!isLoopbackSocket(req)) return 'not_loopback'\n", ''], ROUTE_T),
  m('enable-from-browser-allowed', ROUTE, ["  if (req.headers.origin !== undefined) return 'browser'", "  if (false) return 'browser'"], ROUTE_T),
  m('router-off-falls-into-routes', ROUTE, ["    return next('router')", '    return next()'], ROUTE_T),
  m('parser-parses-when-off', ROUTE, ['    if (!admitted(req, apiToken)) return next()\n    parse(req, res, next)', '    parse(req, res, next)'], ROUTE_T),
  m('bad-json-echoed', ROUTE, ["    res.status(400).json({ error: 'bad_json', message: 'The request body is not valid JSON.' })", "    res.status(400).json({ error: 'bad_json', message: String((_err as Error).message) })"], ROUTE_T),
  // ── Writes are Mac only ──
  m('writes-not-mac-only', ROUTE, ['    if (!refusal) return next()\n    return res.status(403)', '    if (true) return next()\n    return res.status(403)'], ROUTE_T),
  // ── No secret leaves the store ──
  m('key-in-public-record', STORE, ['    last4: k.last4,\n', '    last4: k.last4,\n    secret: k.secret,\n'], [...LIB_T, ...ROUTE_T]),
  m('key-in-route-body', ROUTE, ['    return res.json({\n      key: saved,', '    return res.json({\n      key: { ...saved, secret },'], ROUTE_T),
  m('key-in-validation-url', ROUTE, ["  const target = kind === 'openrouter' ? 'https://openrouter.ai/api/v1/key'", "  const target = kind === 'openrouter' ? `https://openrouter.ai/api/v1/key?k=${secret}`"], ROUTE_T),
  m('store-mode-not-private', STORE, ["  durableAtomicWriteFileSync(file, JSON.stringify(value, null, 2) + '\\n', { mode: 0o600 })", "  durableAtomicWriteFileSync(file, JSON.stringify(value, null, 2) + '\\n', { mode: 0o644 })"], [...LIB_T, ...ROUTE_T]),
  m('state-mode-not-private', LANES, ["  durableAtomicWriteFileSync(keyLanesStatePath(), JSON.stringify(body, null, 2) + '\\n', { mode: 0o600 })", "  durableAtomicWriteFileSync(keyLanesStatePath(), JSON.stringify(body, null, 2) + '\\n', { mode: 0o644 })"], [...LIB_T, ...ROUTE_T]),
  m('corrupt-store-rewritten', STORE, ['  try { return JSON.parse(readFileSync(file, \'utf8\')) } catch { return undefined }', "  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { writePrivateJsonFile(file, {}); return undefined }"], LIB_T),
  m('validation-skipped', ROUTE, ['    if (!check.ok) return res.status(422)', '    if (false) return res.status(422)'], ROUTE_T),
  m('openrouter-no-limit-accepted', ROUTE, ['  if (data.limit === null || data.limit === undefined) {', '  if (false) {'], ROUTE_T),
  // ── Profiles ──
  m('profile-model-policy-off', PROFILES, ["    if (keyKind === 'openrouter' && model.startsWith('anthropic/')) return null", "    return null"], [...LIB_T, ...ROUTE_T]),
  m('profile-direct-tools-default-on', PROFILES, ['      directTools: input.directTools === true,', '      directTools: input.directTools !== false,'], LIB_T),
  m('profile-unknown-key-accepted', PROFILES, ['  const keyKind = keyKindOf(input.keyRef)\n', "  const keyKind = keyKindOf(input.keyRef) ?? 'openrouter'\n"], [...LIB_T, ...ROUTE_T]),
  m('inactive-hooks-not-run', ROUTE, ['    if (wasActive && !keyLanesActive()) await runKeyLanesInactiveHooks(reason)', '    void wasActive; void reason'], ROUTE_T),
  // ── Remove one key (plan 17 item 3) ──
  m('delete-key-answers-when-off', ROUTE, ["  return req.method === 'POST'\n    && requestPath(req) === KEY_LANES_ENABLE_PATH\n", "  return (req.method === 'POST' && requestPath(req) === KEY_LANES_ENABLE_PATH || req.method === 'DELETE')\n"], ROUTE_T),
  m('delete-key-in-use-without-force', ROUTE, ['    if (users.length && !force) {', '    if (false) {'], ROUTE_T),
  m('delete-key-force-keeps-profiles-on', ROUTE, ['    for (const p of users) upsertProfile({ ...p, enabled: false, updatedAt: now().toISOString() })\n', ''], ROUTE_T),
  m('delete-key-echoes-secret', ROUTE, [
    ['    deleteKey(ref)\n', "    const gone = (await import('../lib/key-store.js')).readKeySecretForRelay(ref)\n    deleteKey(ref)\n"],
    ['return res.json({ removed: true, disabledProfiles', 'return res.json({ removed: true, secret: gone, disabledProfiles']], ROUTE_T),
  m('delete-key-store-untouched', STORE, ['  writeStore(next)\n  return true', '  return true'], ROUTE_T),
  // ── Remove all keys ──
  m('remove-all-keeps-keys', ROUTE, ["    if (deleteKeyStore()) removed.push('keys')", "    removed.push('keys')"], ROUTE_T),
  m('remove-all-keeps-codex-homes', ROUTE, ["    if (existsSync(homes)) { rmSync(homes, { recursive: true, force: true }); removed.push('codexHomes') }", "    if (existsSync(homes)) removed.push('codexHomes')"], ROUTE_T),
  m('remove-all-stays-enabled', ROUTE, ['    setKeyLanesEnabled(false, now)\n    return res.json({\n      removed,', '    return res.json({\n      removed,'], ROUTE_T),
  m('remove-all-no-hooks', ROUTE, ["    const hookFailures = await runKeyLanesInactiveHooks('remove_all')", '    const hookFailures: string[] = []'], ROUTE_T),
  m('export-failure-continues', ROUTE, ["        return res.status(500).json({ error: 'export_failed'", "        void res; ({ error: 'export_failed'"], ROUTE_T),
  // ── parsePreference ──
  m('pref-bare-id-accepted', PREF, ["  if (typeof value !== 'string' || !value.startsWith(KEY_PROFILE_PREFERENCE_PREFIX)) return undefined\n  const id = value.slice(KEY_PROFILE_PREFERENCE_PREFIX.length)", "  if (typeof value !== 'string') return undefined\n  const id = value.replace(KEY_PROFILE_PREFERENCE_PREFIX, '')"], PREF_T),
  m('pref-model-not-normalized', PREF, ['  const model = normalizeModelPreference(value)', "  const model = value === 'codex-high' ? undefined : normalizeModelPreference(value)"], PREF_T),
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

const scratch = mkdtempSync(join(tmpdir(), 'key-lanes-p1-mutations-'))
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
  console.log(`${killed} of ${selected.length} key lanes P1 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
