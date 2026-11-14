#!/usr/bin/env node
// X1 (iPhone pings): 3143 over https on this Mac's ts.net name (lib/control-tsnet-tls.ts). Same harness as
// answer-never-queued-mutation-gate.mjs: disposable copy, green baseline over every named suite, each target matched
// exactly once, each mutant killed by the test named for it (a kill by another test is WRONG KILLER and fails the
// gate), byte-for-byte restoration. `--check` stops after the exact-once check.
// 7.0.42 adds the boot name miss (11/14 14:51): 3143's name source and the health reason that names the miss.
import { mkdtempSync, cpSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// [name, file, exact target, replacement, a substring of the test that must fail, tests]
const mutations = [
  ["switch-default-on", "server/lib/control-tsnet-tls.ts", "return readSwitch(env.COS_CONTROL_TSNET_HTTPS, false)", "return readSwitch(env.COS_CONTROL_TSNET_HTTPS, true)", "is off by default and on only for 1, true or on", ["server/lib/control-tsnet-tls.test.ts"]],
  ["boot-ignores-switch", "server/lib/control-tsnet-tls.ts", "if (opts.enabled !== true || opts.httpsAvailable !== true) return null", "if (opts.httpsAvailable !== true) return null", "no instance: the switch off, or no mkcert pair", ["server/lib/control-tsnet-tls.test.ts"]],
  ["boot-ignores-https", "server/lib/control-tsnet-tls.ts", "if (opts.enabled !== true || opts.httpsAvailable !== true) return null", "if (opts.enabled !== true) return null", "no instance: the switch off, or no mkcert pair", ["server/lib/control-tsnet-tls.test.ts"]],
  ["options-never-sni", "server/lib/control-tsnet-tls.ts", "return tls ? { ...base, SNICallback: tls.sniCallback } : { ...base }", "return { ...base }", "its own instance: made and started only by start()", ["server/lib/control-tsnet-tls.test.ts"]],
  ["own-made-beside-signer", "server/lib/control-tsnet-tls.ts", "if (this.signer() !== null || this.own !== null) return", "if (this.own !== null) return", "with the phone key signer's instance present", ["server/lib/control-tsnet-tls.test.ts"]],
  ["own-made-twice", "server/lib/control-tsnet-tls.ts", "if (this.signer() !== null || this.own !== null) return", "if (this.signer() !== null) return", "its own instance: made and started only by start()", ["server/lib/control-tsnet-tls.test.ts"]],
  ["active-ignores-signer", "server/lib/control-tsnet-tls.ts", "return this.signer() ?? this.own", "return this.own", "with the phone key signer's instance present", ["server/lib/control-tsnet-tls.test.ts"]],
  ["sni-before-start-throws", "server/lib/control-tsnet-tls.ts", "if (!tls) { cb(null, undefined); return }", "", "its own instance: made and started only by start()", ["server/lib/control-tsnet-tls.test.ts"]],
  ["health-leaks-host", "server/lib/control-tsnet-tls.ts", "renewalError: precise(status.lastError, nameMiss), expiresAt: status.notAfter }", "renewalError: precise(status.lastError, nameMiss), expiresAt: status.notAfter, host: status.host } as never", "the health field carries a state, a reason code and a date", ["server/lib/control-tsnet-tls.test.ts"]],
  ["health-hides-renewal-failure", "server/lib/control-tsnet-tls.ts", "renewalError: precise(status.lastError, nameMiss), expiresAt", "renewalError: null, expiresAt", "a failed renewal keeps serving the valid pair", ["server/lib/control-tsnet-tls.test.ts"]],
  ["health-field-always", "server/lib/control-tsnet-tls.ts", "return registered ? { controlTsnetHttps: registered.health() } : {}", "return { controlTsnetHttps: registered ? registered.health() : controlTsnetHealthFrom(null) }", "3143's options are the mkcert pair alone", ["server/lib/control-tsnet-tls.test.ts"]],
  ["index-sni-every-listener", "server/index.ts", "const mkcertPair = mkcertFiles && entry.label === 'HTTPS' ? controlHttpsOptions(mkcertFiles, controlTsnetTls)", "const mkcertPair = mkcertFiles ? controlHttpsOptions(mkcertFiles, controlTsnetTls)", "index.ts builds it from the switch", ["server/lib/control-tsnet-tls.test.ts"]],
  ["index-never-started", "server/index.ts", "  controlTsnetTls?.start()\n", "", "index.ts builds it from the switch", ["server/lib/control-tsnet-tls.test.ts"]],
  ["index-never-stopped", "server/index.ts", "  controlTsnetTls?.stop()\n", "", "index.ts builds it from the switch", ["server/lib/control-tsnet-tls.test.ts"]],
  ["health-not-spread", "server/routes/health.ts", "    ...controlTsnetHealthField(),\n", "", "/api/health spreads the field", ["server/lib/control-tsnet-tls.test.ts"]],
  // 7.0.42: the boot name miss (11/14 14:51).
  ["name-source-cached", "server/lib/control-tsnet-tls.ts", "return () => self.refreshIfMissing(TAILNET_NAME_CHECK_WAIT_MS)", "return () => (self as never as { refresh: () => Promise<string | null> }).refresh()", "the first check after a boot miss finds the name", ["server/lib/control-tsnet-tls.test.ts"]],
  ["index-name-source-cached", "server/index.ts", "  selfDnsName: controlTsnetSelfDnsName(tailnetSelf),\n", "  selfDnsName: () => tailnetSelf.refresh(),\n", "index.ts builds it from the switch", ["server/lib/control-tsnet-tls.test.ts"]],
  ["index-miss-not-wired", "server/index.ts", "httpsAvailable, nameMiss: () => tailnetSelf.lastMiss?.() ?? null }", "httpsAvailable }", "index.ts builds it from the switch", ["server/lib/control-tsnet-tls.test.ts"]],
  ["miss-reason-dropped", "server/lib/control-tsnet-tls.ts", "return code === 'tailnet_name_unknown' && nameMiss ? TAILNET_NAME_MISS_REASON[nameMiss] : code", "return code", "tailnet_name_unknown is replaced by the miss seen", ["server/lib/control-tsnet-tls.test.ts"]],
  ["miss-replaces-every-reason", "server/lib/control-tsnet-tls.ts", "return code === 'tailnet_name_unknown' && nameMiss ? TAILNET_NAME_MISS_REASON[nameMiss] : code", "return nameMiss ? TAILNET_NAME_MISS_REASON[nameMiss] : code", "tailnet_name_unknown is replaced by the miss seen", ["server/lib/control-tsnet-tls.test.ts"]],
  ["health-miss-not-passed", "server/lib/control-tsnet-tls.ts", "return controlTsnetHealthFrom(status, miss)", "return controlTsnetHealthFrom(status)", "health now says what was wrong", ["server/lib/control-tsnet-tls.test.ts"]],
  ["boot-miss-not-passed", "server/lib/control-tsnet-tls.ts", "return new ControlTsnetTls(signer, deps, make, opts.nameMiss)", "return new ControlTsnetTls(signer, deps, make)", "health now says what was wrong", ["server/lib/control-tsnet-tls.test.ts"]],
  ["renewal-miss-raw", "server/lib/control-tsnet-tls.ts", "renewalError: precise(status.lastError, nameMiss),", "renewalError: status.lastError,", "a restart serves the stored certificate", ["server/lib/control-tsnet-tls.test.ts"]],
  ["restart-stored-not-loaded", "server/lib/web-key-signer-tls.ts", "    this.loadFetchState()\n    this.loadStored()\n", "    this.loadFetchState()\n", "a restart serves the stored certificate", ["server/lib/control-tsnet-tls.test.ts"]],
  ["health-starts-recheck", "server/lib/control-tsnet-tls.ts", "    const status = tls.status()\n", "    const status = tls.statusRead()\n", "a health read never starts a check", ["server/lib/control-tsnet-tls.test.ts"]],
  ["grace-dropped", "server/lib/control-tsnet-tls.ts", "this.startedAt !== null && now - this.startedAt < CONTROL_TSNET_START_GRACE_MS", "false", "the 7.0.41 wiring (refresh) fails on the cached miss", ["server/lib/control-tsnet-tls.test.ts"]],
  ["grace-forever", "server/lib/control-tsnet-tls.ts", "now - this.startedAt < CONTROL_TSNET_START_GRACE_MS", "true", "the 7.0.41 wiring (refresh) fails on the cached miss", ["server/lib/control-tsnet-tls.test.ts"]],
  ["grace-any-reason", "server/lib/control-tsnet-tls.ts", "!status.trusted && status.lastError === 'tailnet_name_unknown' && ", "!status.trusted && ", "the start-up grace covers a name miss only", ["server/lib/control-tsnet-tls.test.ts"]],
  ["grace-while-serving", "server/lib/control-tsnet-tls.ts", "if (!status.trusted && status.lastError", "if (status.lastError", "a restart serves the stored certificate", ["server/lib/control-tsnet-tls.test.ts"]],
  ["self-throw-unlabeled", "server/lib/tailnet-self-name.ts", "        name = null\n        why = 'no_answer'\n", "        name = null\n", "an ENOTFOUND lookup is cached a minute", ["server/lib/tailnet-self-name.test.ts"]],
  ["self-empty-as-not-ts-net", "server/lib/tailnet-self-name.ts", "if (!name) why = names.length ? 'not_ts_net' : 'no_answer'", "if (!name) why = 'not_ts_net'", "lastMiss says no_tailscale_ip, not_ts_net or no_answer", ["server/lib/tailnet-self-name.test.ts"]],
  ["self-no-ip-unlabeled", "server/lib/tailnet-self-name.ts", "          why = 'no_tailscale_ip'\n", "", "lastMiss says no_tailscale_ip, not_ts_net or no_answer", ["server/lib/tailnet-self-name.test.ts"]],
  ["self-miss-kept-after-hit", "server/lib/tailnet-self-name.ts", "lastMiss: () => (currentSelfDnsName() ? null : miss)", "lastMiss: () => miss", "lastMiss says no_tailscale_ip, not_ts_net or no_answer", ["server/lib/tailnet-self-name.test.ts"]],
  ["sni-suffix-match", "server/lib/web-key-signer-tls.ts", "servername.toLowerCase() === pair.host", "pair.host.endsWith(servername.toLowerCase())", "the name must match EXACTLY", ["server/lib/control-tsnet-tls.test.ts"]]
]
const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const chosen = names.length ? mutations.filter(([name]) => names.includes(name)) : mutations
if (names.length && chosen.length !== names.length) throw new Error(`Unknown mutation name in: ${args.join(' ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'control-tsnet-https-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'bin'), join(scratch, 'bin'), { recursive: true })
  // vitest.config.ts names setup files here (the 6.71.7 gate predates them).
  if (existsSync(join(root, 'test-support'))) cpSync(join(root, 'test-support'), join(scratch, 'test-support'), { recursive: true })
  cpSync(join(root, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
  cpSync(join(root, 'managed-runtime-contract.json'), join(scratch, 'managed-runtime-contract.json'))
  // The listing test reads .env.example (the S6 lesson).
  cpSync(join(root, '.env.example'), join(scratch, '.env.example'))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data') }, encoding: 'utf8', timeout: 300_000,
  })
  if (args.includes('--check')) {
    for (const [name, file, find] of chosen) {
      const n = readFileSync(join(scratch, file), 'utf8').split(find).length - 1
      console.log(`${n === 1 ? 'ok  ' : 'BAD '} ${name} (${n})`)
    }
    process.exit(0)
  }
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
  // Every mutant runs; survivors are collected and reported together (Q1: stopping at the first hid the rest).
  const survivors = []
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
    if (result.status === 0 || result.error || !killers.length) { survivors.push(`${name}: SURVIVED or harness failed`); console.log(`${name} SURVIVED\n${output.slice(-1500)}`); continue }
    const killer = killers.find(line => line.includes(killerName))
    if (!killer) { survivors.push(`${name}: WRONG KILLER, expected "${killerName}", killed by: ${killers.join(' | ')}`); console.log(`${name} KILLED BY THE WRONG TEST: ${killers.join(' | ')}`); continue }
    killed++
    console.log(`${name} KILLED by ${killer}`)
  }
  console.log(`${killed} of ${chosen.length} control-tsnet-https mutations killed`)
  if (survivors.length) { console.log('NOT KILLED:\n  ' + survivors.join('\n  ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
