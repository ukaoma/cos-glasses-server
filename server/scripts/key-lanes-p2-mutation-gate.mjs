#!/usr/bin/env node
// Key lanes K1 P2 mutation gate (plan v4 14.2 row P2): the loopback metering relay. Nonce expiry and
// revocation, the 127.0.0.1 bind, model policy, the per-key cap and reservations, usage_daily, the
// UTC day, streaming abort, status mapping, the breaker, the pre-spawn key check, redaction and the
// ledger. Mutations run only in a disposable copy of the checkout; the live checkout is never
// rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated (including the real Claude CLI test). A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/key-lanes-p2-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const RELAY_T = ['server/lib/key-relay.test.ts']
const METER_T = ['server/lib/key-relay-meter.test.ts']
const ERR_T = ['server/lib/key-relay-errors.test.ts']
const CLI_T = ['server/lib/key-relay-cli.test.ts']
const ALL = [...RELAY_T, ...METER_T, ...ERR_T, ...CLI_T]
const RELAY = 'server/lib/key-relay.ts', METER = 'server/lib/key-relay-meter.ts', ERR = 'server/lib/key-relay-errors.ts', LEDGER = 'server/lib/key-ledger.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Nonce (plan 4.3) ──
  m('nonce-expiry-skipped', RELAY, ['    if (!entry || !this.turns.has(entry.hash) || this.now() >= entry.expiresAt || entry.binding.engine !== route.engine) {', '    if (!entry || !this.turns.has(entry.hash) || entry.binding.engine !== route.engine) {'], RELAY_T),
  m('nonce-child-close-grace-ignored', RELAY, ['        e.expiresAt = Math.min(e.expiresAt, this.now() + RELAY_LIMITS.childCloseGraceMs)\n', ''], RELAY_T),
  m('nonce-wall-max-ignored', RELAY, ['      expiresAt: this.now() + wallMaxMs + RELAY_LIMITS.wallMaxGraceMs,', '      expiresAt: Number.MAX_SAFE_INTEGER,'], RELAY_T),
  m('nonce-revoke-noop', RELAY, ['    this.turns.delete(hash)\n', ''], RELAY_T),
  m('nonce-engine-cross-allowed', RELAY, ['    if (!entry || !this.turns.has(entry.hash) || this.now() >= entry.expiresAt || entry.binding.engine !== route.engine) {', '    if (!entry || !this.turns.has(entry.hash) || this.now() >= entry.expiresAt) {'], RELAY_T),
  m('nonce-survives-lanes-inactive', RELAY, ["      if (entry && !this.isActive()) this.revokeAll('lanes_inactive')\n", ''], RELAY_T),
  m('issue-while-inactive', RELAY, ["    if (!this.isActive()) throw new KeyRelayRefusal('lanes_inactive'", "    if (false) throw new KeyRelayRefusal('lanes_inactive'"], RELAY_T),
  m('in-flight-cap-removed', RELAY, ['      if (entry.inFlight >= RELAY_LIMITS.inFlightPerNonce) {', '      if (false) {'], RELAY_T),
  m('browser-origin-allowed', RELAY, ['      if (req.headers.origin !== undefined) {', '      if (false) {'], RELAY_T),
  // ── Bind and zero impact (plan 3, 4.1) ──
  m('listener-at-construction', RELAY, ['    this.breakers = new RelayBreakers(this.now, (scope, id) => this.onBreakerOpen(scope, id))\n  }', '    this.breakers = new RelayBreakers(this.now, (scope, id) => this.onBreakerOpen(scope, id))\n    void this.ensureListening()\n  }'], RELAY_T),
  m('bind-0.0.0.0', RELAY, ['      server.listen(0, RELAY_HOST, () => {', "      server.listen(0, '0.0.0.0', () => {"], RELAY_T),
  // ── Model policy (plan 4.4) ──
  m('model-rewrite-pass-through', RELAY, ['      json.model = b.allowedModel\n      body = Buffer.from(JSON.stringify(json))\n', ''], [...RELAY_T, ...CLI_T]),
  m('model-reject-forwarded', RELAY, ["    if (decision.action === 'reject') {", '    if (false) {'], RELAY_T),
  m('model-any-claude-rewritten', RELAY, ["    return { action: 'reject', model: requested, requested }\n  }\n  if (!requested.includes('/')", "    return { action: 'rewrite', model: allowedModel, requested }\n  }\n  if (!requested.includes('/')"], RELAY_T),
  m('lane-c-slug-on-lane-b', RELAY, ['    if (!laneBModelAllowed(binding.engine, kind, binding.allowedModel)) {', '    if (false) {'], RELAY_T),
  // ── Meter and cap (plan 4.5) ──
  m('cap-check-removed', METER, ['    if (cap === null || spent + estimate > cap) {', '    if (cap === null) {'], [...METER_T, ...RELAY_T]),
  m('usage-daily-ignored', METER, ['    return Math.max(d.settledUsd, d.usageDailyUsd ?? 0) + this.openReservationsUsd(keyRef)', '    return d.settledUsd + this.openReservationsUsd(keyRef)'], [...METER_T, ...RELAY_T]),
  m('open-reservations-ignored', METER, ['    return Math.max(d.settledUsd, d.usageDailyUsd ?? 0) + this.openReservationsUsd(keyRef)', '    return Math.max(d.settledUsd, d.usageDailyUsd ?? 0)'], [...METER_T, ...RELAY_T]),
  m('utc-day-never-rolls', METER, ['    if (!d || d.day !== day) {', '    if (!d) {'], METER_T),
  m('stream-usage-not-settled', RELAY, ['      if (usage) this.meter.settle({ reservationId, usd: usage.usd,', '      if (false) this.meter.settle({ reservationId, usd: usage.usd,'], RELAY_T),
  m('upstream-error-billed', RELAY, ['        if (reservationId) this.meter.settle({ reservationId, usd: 0, tokens: { input: 0, output: 0 } })\n        if (kind && countsTowardBreaker(kind)) {', '        if (reservationId) this.meter.settleReserved(reservationId)\n        if (kind && countsTowardBreaker(kind)) {'], RELAY_T),
  // ── Streaming (plan 4.6) ──
  m('child-disconnect-not-aborted', RELAY, ['      if (!res.writableFinished) { childGone = true; controller.abort() }', '      if (!res.writableFinished) { childGone = true }'], RELAY_T),
  m('set-cookie-passed', RELAY, ["  'set-cookie', 'set-cookie2', 'content-encoding',", "  'set-cookie2', 'content-encoding',"], RELAY_T),
  // ── Status mapping and breaker (plan 4.6) ──
  m('breaker-counts-429', ERR, ["  return kind === 'key_rejected' || kind === 'out_of_credit' || kind === 'model_gone'", "  return kind === 'key_rejected' || kind === 'out_of_credit' || kind === 'model_gone' || kind === 'rate_limited'"], [...ERR_T, ...RELAY_T]),
  m('model-404-not-model-gone', ERR, ["  if (status === 404) return 'model_gone'\n", ''], [...ERR_T, ...RELAY_T]),
  m('breaker-success-not-reset', ERR, ['      if (e && e.openedAtMs === undefined) this.entries.delete(k)\n', ''], [...ERR_T, ...RELAY_T]),
  m('breaker-key-change-not-reset', RELAY, ['    if (before !== undefined && before !== s) {', '    if (false) {'], RELAY_T),
  // ── Pre-spawn key check (plan 7.2) ──
  m('preflight-401-ignored', RELAY, ['    if (r.status === 401 || r.status === 403) {', '    if (false) {'], RELAY_T),
  m('preflight-no-limit-accepted', RELAY, ['    if (data.limit === null || data.limit === undefined) {', '    if (false) {'], RELAY_T),
  // ── The key never leaves the process ──
  m('secret-echoed-in-error-body', RELAY, ['        res.end(redactSecrets(text, [secret]))', '        res.end(text)'], RELAY_T),
  m('secret-echoed-in-header', RELAY, ['outHeaders[name] = redactSecrets(value, [secret])', 'outHeaders[name] = value'], RELAY_T),
  m('child-token-forwarded-upstream', RELAY, ['    else h.authorization = `Bearer ${secret}`', '    else h.authorization = String(req.headers.authorization)'], [...RELAY_T, ...CLI_T]),
  // ── Ledger (plan 4.5) ──
  m('ledger-extra-fields-kept', LEDGER, ['  const line = JSON.stringify(toLedgerRow(row)) + ', '  const line = JSON.stringify({ ...row, ...toLedgerRow(row) }) + '], METER_T),
  m('ledger-through-symlink', LEDGER, ["  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('refusing to write the key ledger through a symlink')\n", ''], METER_T),
  m('ledger-mode-not-private', LEDGER, ["  appendFileSync(file, line, { encoding: 'utf8', mode: 0o600, flag: 'a' })\n  chmodSync(file, 0o600)", "  appendFileSync(file, line, { encoding: 'utf8', mode: 0o644, flag: 'a' })\n  chmodSync(file, 0o644)"], METER_T),
  // ── Lifecycle (plan 4.1) ──
  m('inactive-hook-keeps-listener', RELAY, ['    await relay.close()\n  })', '  })'], RELAY_T),
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

const scratch = mkdtempSync(join(tmpdir(), 'key-lanes-p2-mutations-'))
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
  // The real-CLI test skips itself without a `claude` binary; a gate that silently skipped it proves less than it says.
  if (/\d+ skipped/.test(baseline.stdout)) throw new Error('Baseline skipped tests (is the claude CLI on PATH?):\n' + baseline.stdout.slice(-2000))
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
  console.log(`${killed} of ${selected.length} key lanes P2 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
