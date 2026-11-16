#!/usr/bin/env node
// SR-15 (review finding 9, fix round 1 for review PA-R S1/S2/S4) mutation gate: the 3144 signer binds only this Mac's tailnet addresses
// (lib/web-key-signer-bind.ts), refuses connections on any other local address, and
// /api/web-key/status reports signerBindFixVersion, signerBind and certDisclosure (routes/web-key.ts).
// Same harness as web-key-signer-mutation-gate.mjs: mutations run only in a disposable copy of the
// checkout; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated (a gate over a red suite reads every mutant as killed).
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// The index.ts mutants are killed by SOURCE pins only (importing index.ts boots the server); they prove
// the wiring text, not runtime behaviour.
// Usage: node server/scripts/web-key-signer-bind-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const AT = ['server/lib/web-key-activation.test.ts', 'server/routes/web-key-activation.test.ts', 'server/lib/web-key-activation-tls.test.ts', 'server/lib/web-key-activation-boot.test.ts']
const ALL = AT
const ACT = 'server/lib/web-key-activation.ts', REG = 'server/lib/web-key-registry.ts', TLS = 'server/lib/web-key-signer-tls.ts', ROUTE = 'server/routes/web-key.ts'
const m = (name, file, find, replacement) => ({ name, file, edits: [[find, replacement]], tests: AT })
const mutations = [
  m("raw-flag-without-grant", ACT, "!this.bootResolved || !this.bootGrant || !webKeyAuthorityEnabled(env) || !this.accepted()", "!this.bootResolved || !this.bootGrant || !webKeyAuthorityEnabled(env)"),
  m("accepted-signature-bypassed", ACT, "&& verifyP1363(anchor.key, parsed.bytes, g.signature)", "&& true"),
  m("accept-signature-bypassed", ACT, " || !verifyP1363(r.anchor()!.key, parsed.bytes, signature)", ""),
  m("pending-challenge-bypassed", ACT, " || state.pending !== statement", ""),
  m("context-match-bypassed", ACT, "    if (!this.matches(parsed.value)) return { ok: false, reason: 'activation_context_changed' }", ""),
  m("device-exact-bypassed", ACT, " && env.COS_WEB_KEY_DEVICES === grant.device", ""),
  m("expiry-bypassed", ACT, "    if (at < parsed.value.iat || at >= parsed.value.exp) return { ok: false, reason: 'activation_expired' }", ""),
  m("challenge-not-consumed", ACT, "{ ...state, pending: null, grant:", "{ ...state, pending: statement as string, grant:"),
  m("activation-epoch-bypassed", ACT, " && s.epoch === r.activationEpoch()", ""),
  m("consumed-proof-bypassed", ACT, " && g.consumedNonce === parsed.value.nonce", ""),
  m("off-not-durable", ACT, "const ok = this.deps.registry.disableActivation()", "const ok = true"),
  m("boot-late-rearm", ACT, "    if (this.bootResolved) return this.enabled()", ""),
  m("off-no-key-epoch", REG, "    this.data.epoch += 1\n    for (const entry of this.data.entries)", "    for (const entry of this.data.entries)"),
  m("tls-cert-after-revocation", TLS, "    if (!this.permitted(name)) { this.deps.onPermitRefused?.(); this.fail('authority_activation_required'); return }\n    const r = await this.runner", "    const r = await this.runner"),
  m("activation-loopback-bypassed", ROUTE, "    if (!isLoopbackAddress(normalizeRemoteIp(req.socket?.remoteAddress ?? '') ?? '') || hasProxyForwardedHeaders(req.headers)) return refuse(res, 403, 'loopback_required')", "    if (false) return refuse(res, 403, 'loopback_required')"),
  m("activation-token-bypassed", ROUTE, "    if (!hasToken(req)) return refuse(res, 401, 'token_required')\n    next()", "    next()"),
  m("health-always-advertises", ACT, "return registeredActivation?.enabled() ? { webKeySigner: 1 } : {}", "return { webKeySigner: 1 }"),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const x of mutations) console.log(x.name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const selected = names.length ? mutations.filter(x => names.includes(x.name)) : mutations
if (!selected.length) { console.error(`No matching mutations. Known: ${mutations.map(x => x.name).join(', ')}`); process.exit(2) }
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')
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

const scratch = mkdtempSync(join(tmpdir(), 'web-key-activation-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  for (const dir of ['shared', 'work-task-runtime', 'bin', 'docs', 'test-support']) cpSync(join(root, dir), join(scratch, dir), { recursive: true })
  for (const file of ['vitest.config.ts', 'package.json', 'managed-runtime-contract.json', '.env.example']) cpSync(join(root, file), join(scratch, file))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: process.env.TMPDIR, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json') },
    encoding: 'utf8', timeout: 300000,
  })
  const baseline = run(ALL)
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout.slice(-4000) + '\n' + baseline.stderr.slice(-4000))
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
    if (result.status === 0 || result.error || !killers.length) { console.log(`${name} SURVIVED or harness failed\n${output.slice(-1500)}`); process.exitCode = 1; continue }
    killed += 1
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${killed} of ${selected.length} signed activation mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
