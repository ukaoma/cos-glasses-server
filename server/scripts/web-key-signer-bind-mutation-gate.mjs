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
const BT = ['server/lib/web-key-signer-bind.test.ts']
const RT = ['server/routes/web-key-status-signer-bind.test.ts']
const ALL = [...BT, ...RT]
const BIND = 'server/lib/web-key-signer-bind.ts', WKR = 'server/routes/web-key.ts', IDX = 'server/index.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })
const drop = (name, file, line, tests) => m(name, file, [line, ''], tests)

const mutations = [
  // ── Which interface is Tailscale's (review S1, fix round 1) ──
  drop('iface-name-not-required', BIND, '  if (!MAC_TUNNEL.test(name)) return false\n', BT),
  m('iface-utun-unanchored', BIND, ['const MAC_TUNNEL = /^utun\\d+$/', 'const MAC_TUNNEL = /utun/'], BT),
  m('iface-v4-sibling-dropped', BIND, ['  return hasV4 && hasV6\n', '  return hasV6\n'], BT),
  m('iface-v6-sibling-dropped', BIND, ['  return hasV4 && hasV6\n', '  return hasV4\n'], BT),
  drop('iface-check-skipped', BIND, '    if (!isTailscaleInterface(name, infos)) continue\n', BT),
  m('iface-internal-counts', BIND, ['  if (!MAC_TUNNEL.test(name)) return false\n  const list = (infos ?? []).filter(info => info && !info.internal)', '  if (!MAC_TUNNEL.test(name)) return false\n  const list = (infos ?? []).filter(info => info)'], BT),
  m('iface-v4-range', BIND, ["if (family === 'IPv4' && isTailscaleIpv4(addr))", "if (family === 'IPv4')"], BT),
  m('iface-v6-range', BIND, ["else if (family === 'IPv6' && isTailscaleIpv6(addr))", "else if (family === 'IPv6')"], BT),
  m('normalize-mapped', BIND, [".replace(/^::ffff:(?=\\d+\\.\\d+\\.\\d+\\.\\d+$)/, '')", ''], BT),
  // ── The bind plan ──
  drop('plan-https-unavailable', BIND, "  if (!opts.httpsAvailable) return { scope: 'none', addresses: [], reason: 'https_unavailable' }\n", BT),
  drop('plan-bindhost-not-tailnet', BIND, "    if (!isTailnetAddress(host)) return { scope: 'none', addresses: [], reason: 'bind_host_not_tailnet' }\n", BT),
  drop('plan-bindhost-not-present', BIND, "    if (!found.includes(host)) return { scope: 'none', addresses: [], reason: 'no_tailnet_address' }\n", BT),
  m('plan-no-address-wildcard', BIND, ["  if (found.length === 0) return { scope: 'none', addresses: [], reason: 'no_tailnet_address' }", "  if (found.length === 0) return { scope: 'tailnet', addresses: ['0.0.0.0'], reason: null }"], BT),
  // ── Per-connection refusal (review S2, fix round 1) ──
  m('conn-local-range-dropped', BIND, ['  if (!isTailnetAddress(local) || !bound.includes(local)) return false', '  if (!bound.includes(local)) return false'], BT),
  m('conn-local-bound-dropped', BIND, ['  if (!isTailnetAddress(local) || !bound.includes(local)) return false', '  if (!isTailnetAddress(local)) return false'], BT),
  drop('conn-remote-range-dropped', BIND, '  if (!isTailnetAddress(remote)) return false\n', BT),
  drop('conn-onlink-dropped', BIND, "  if (onLink && onLink.check(remote, remote.includes(':') ? 'ipv6' : 'ipv4')) return false\n", BT),
  m('subnets-include-tailscale', BIND, ['    if (isTailscaleInterface(name, infos)) continue\n    for (const info of infos ?? []) {', '    for (const info of infos ?? []) {'], BT),
  m('guard-remote-not-passed', BIND, ['allowed(socket.localAddress, socket.remoteAddress) === true', 'allowed(socket.localAddress, socket.localAddress) === true'], BT),
  drop('guard-no-destroy', BIND, '    socket.destroy()\n', BT),
  m('guard-throw-allows', BIND, ['try { ok = allowed(socket.localAddress, socket.remoteAddress) === true } catch { ok = false }', 'try { ok = allowed(socket.localAddress, socket.remoteAddress) === true } catch { ok = true }'], BT),
  // ── Status shape ──
  m('status-listening-any-plan', BIND, ["listening: plan.scope === 'tailnet' && listening", 'listening'], BT),
  m('status-addresses-shared', BIND, ['addresses: [...plan.addresses], reason: plan.reason', 'addresses: plan.addresses, reason: plan.reason'], BT),
  // ── The keeper (review S4, fix round 1) ──
  m('keeper-ignores-set-change', BIND, ['if (curTailnet && sameAddresses(cur.addresses, bound.addresses) && alive)', 'if (curTailnet && alive)'], BT),
  m('keeper-ignores-dead-listener', BIND, ['if (curTailnet && sameAddresses(cur.addresses, bound.addresses) && alive)', 'if (curTailnet && sameAddresses(cur.addresses, bound.addresses))'], BT),
  m('keeper-same-ignores-length', BIND, ['a.length === b.length && a.every(x => b.includes(x))', 'a.every(x => b.includes(x))'], BT),
  drop('keeper-no-close', BIND, '        try { await opts.close() } catch { /* the servers are dropped either way */ }\n', BT),
  drop('keeper-no-address-lost', BIND, "        shown = none('address_lost')\n", BT),
  m('keeper-lost-not-sticky', BIND, ['      } else if (!lost) {\n        shown = cur\n', '      } else {\n        shown = cur\n'], BT),
  drop('keeper-no-listen-failed', BIND, "          shown = none('listen_failed')\n", BT),
  m('keeper-opens-any-plan', BIND, ["const curTailnet = cur.scope === 'tailnet' && cur.addresses.length > 0", 'const curTailnet = cur.addresses.length > 0'], BT),
  drop('keeper-no-rescan', BIND, '    if (!stopped) timer = schedule(() => { void tick() }, interval)\n', BT),
  // ── Certificate disclosure ──
  m('cert-any-name', BIND, ['issued = publicName ? leaf.checkHost(publicName) !== undefined :', 'issued = publicName ? true :'], BT),
  m('cert-size-uncapped', BIND, ['st.size <= STORED_CERT_MAX_BYTES', 'true'], BT),
  // ── The status route ──
  m('route-off-door-no-token', WKR, ["if (deps.authority.mode() === 'off' && !(deps.signerFacts && hasToken(req)))", "if (deps.authority.mode() === 'off' && !deps.signerFacts)"], RT),
  m('route-off-door-no-facts', WKR, ["if (deps.authority.mode() === 'off' && !(deps.signerFacts && hasToken(req)))", "if (deps.authority.mode() === 'off' && !hasToken(req))"], RT),
  m('route-off-body-no-facts', WKR, ["mode: 'off', ...signerFactsField() })", "mode: 'off' })"], RT),
  m('route-bootstrap-no-facts', WKR, ['        epoch: registry.epoch(),\n        ...signerFactsField(),\n', '        epoch: registry.epoch(),\n'], RT),
  m('route-authority-no-facts', WKR, ['      ...signerTlsField(),\n      ...signerFactsField(),\n', '      ...signerTlsField(),\n'], RT),
  m('route-facts-throw-escapes', WKR, ['try { facts = deps.signerFacts?.() ?? null } catch { facts = null }', 'facts = deps.signerFacts?.() ?? null'], RT),
  // ── index.ts wiring (source pins) ──
  m('index-signer-binds-bind-host', IDX, ['    return { server, port: entry.port, host: address, label: entry.label }', '    return { server, port: entry.port, host: BIND_HOST, label: entry.label }'], BT),
  drop('index-signer-unguarded', IDX, '    guardSignerConnections(server, plan.addresses, { nets: signerNets, log: line => console.warn(line) })\n', BT),
  drop('index-status-unwired', IDX, '  signerFacts: webKeySignerFacts,\n', BT),
  drop('index-keeper-not-stopped', IDX, '  webKeySignerKeeper?.stop()\n', BT),
  m('index-close-keeps-servers', IDX, ['    const closing = webKeySignerServers.splice(0, webKeySignerServers.length)\n', '    const closing = [...webKeySignerServers]\n'], BT),
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

const scratch = mkdtempSync(join(tmpdir(), 'web-key-signer-bind-mutations-'))
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
  console.log(`${killed} of ${selected.length} SR-15 signer bind mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
