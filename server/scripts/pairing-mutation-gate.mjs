#!/usr/bin/env node
// Glasses pairing mutation gate (6.67.0, docs/pairing-contract.md). Mutations run only in a disposable copy of
// server/ and shared/; the live checkout (which a candidate may be running) is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/pairing-mutation-gate.mjs [--list] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = ['server/lib/glasses-pairing.test.ts', 'server/routes/pairing.test.ts', 'server/lib/api-auth.test.ts', 'server/routes/health.test.ts']
const STATE = 'server/lib/glasses-pairing.ts', ROUTE = 'server/routes/pairing.ts', AUTH = 'server/lib/api-auth.ts', NET = 'server/lib/network-policy.ts'
const HEALTH = 'server/routes/health.ts'
const mutations = [
  // Who may mint, read status and decide: the token AND a loopback socket.
  ['loopback-checked', ROUTE, "if (!isLoopbackSocket(req)) return sendReason(res, 'not_loopback')", "if (false && !isLoopbackSocket(req)) return sendReason(res, 'not_loopback')"],
  ['loopback-reads-socket-not-xff', NET, 'return isLoopbackAddress(req.socket?.remoteAddress)', "return isLoopbackAddress((req as any).headers?.['x-forwarded-for'] ?? req.socket?.remoteAddress)"],
  // The two public doors are exact on method and path.
  ['claim-door-post-only', AUTH, "if (method === 'POST' && path === '/pairing/claim') return true", "if (path === '/pairing/claim') return true"],
  // QA round 1 N6/N7: the public poll path is anchored at both ends.
  ['poll-door-anchored', AUTH, 'new RegExp(`^/pairing/claim/${PAIRING_NONCE_BODY}$`)', 'new RegExp(`/pairing/claim/${PAIRING_NONCE_BODY}`)'],
  ['poll-door-get-only', AUTH, "if (method === 'GET' && PAIRING_POLL_PATH.test(path)) return true", 'if (PAIRING_POLL_PATH.test(path)) return true'],
  // Network: Tailscale always, RFC1918 only while armed, armed for 10 minutes.
  ['claim-network-checked', STATE, 'if (!isTailscaleIpv4(ip) && !(isRfc1918Ipv4(ip) && this.lanArmed(at))) {', 'if (false) {'],
  ['lan-needs-arming', STATE, 'if (!isTailscaleIpv4(ip) && !(isRfc1918Ipv4(ip) && this.lanArmed(at))) {', 'if (!isTailscaleIpv4(ip) && !(isRfc1918Ipv4(ip))) {'],
  ['lan-arm-ten-minutes', STATE, 'this.lanArmedUntil = input.allowLan === true ? at + PAIRING_LAN_ARM_MS : null', 'this.lanArmedUntil = input.allowLan === true ? at + PAIRING_LAN_ARM_MS * 100 : null'],
  ['lan-hosts-only-when-armed', STATE, "} else if (lanArmed && entry.kind === 'lan' && isRfc1918Ipv4(entry.address)) {", "} else if (entry.kind === 'lan' && isRfc1918Ipv4(entry.address)) {"],
  // Code lifetime and single use.
  ['code-expires', STATE, 'if (at >= record.expiresAt) refuse(', 'if (false) refuse('],
  ['single-use-refused', STATE, "    if (record.status === 'used') {\n      if (!matches) refuse('unknown_code')\n      refuse(this.pendingNonce ? 'locked' : 'used')\n    }\n", ''],
  // QA round 1 N2: a used code is not locked, and its attempts are not counted.
  ['used-code-not-counted', STATE, "    if (record.status === 'used') {\n", "    record.attempts++\n    if (record.attempts > PAIRING_CODE_ATTEMPT_LIMIT) record.status = 'locked'\n    if (record.status === 'used') {\n"],
  ['single-use-marked', STATE, "    record.status = 'used'\n    this.claims.set", '    this.claims.set'],
  ['new-code-cancels-pending', STATE, "      if (pending && pending.state === 'pending') {\n        pending.state = 'expired'", "      if (pending && pending.state === 'pending') {\n        void 0"],
  // Pending claims.
  ['one-pending-at-a-time', STATE, "refuse(this.pendingNonce ? 'locked' : 'used')", "refuse('used')"],
  ['pending-expires-60s', STATE, 'at - pending.at >= PAIRING_PENDING_TTL_MS', 'at - pending.at >= PAIRING_PENDING_TTL_MS * 100'],
  // Limits.
  ['per-ip-limit', STATE, 'if (recent.length >= PAIRING_IP_LIMIT_PER_MINUTE) {', 'if (false) {'],
  ['limit-keys-on-socket', ROUTE, "return req.socket?.remoteAddress ?? ''", "return String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '')"],
  ['per-code-limit', STATE, 'if (record.attempts > PAIRING_CODE_ATTEMPT_LIMIT) {', 'if (record.attempts > 1000) {'],
  // The token: once, to the claiming IP, after Allow.
  ['poll-bound-to-claim-ip', STATE, 'if (claim.ip !== ip) {', 'if (false) {'],
  ['token-once', STATE, "      claim.state = 'delivered'\n", '\n'],
  // QA round 1 N7: a delivered read never carries the token.
  ['no-token-when-delivered', STATE, "if (claim.state === 'delivered') return { state: 'delivered', serverName: this.opts.serverName() }", "if (claim.state === 'delivered') return { state: 'delivered', token: this.opts.token(), serverName: this.opts.serverName() }"],
  // QA round 1 N7: an idempotent re-claim is bound to the claiming IP.
  ['idempotent-claim-ip-bound', STATE, "if (!pairingCodesEqual(existing.code, code) || existing.ip !== ip) refuse('locked')", "if (!pairingCodesEqual(existing.code, code)) refuse('locked')"],
  // QA round 1 N5: HEAD can never spend the token.
  ['poll-get-only', ROUTE, "    if (req.method !== 'GET') {\n      res.setHeader('Allow', 'GET')\n      return sendReason(res, 'bad_request', undefined, 405)\n    }\n", ''],
  // Paired signal.
  ['first-auth-after-delivery', STATE, "if (!claim || claim.state !== 'delivered') return", "if (!claim || claim.state === 'pending') return"],
  ['first-auth-from-claim-ip', STATE, "if (normalizeRemoteIp(socketIp ?? '') !== claim.ip) return", 'if (false) return'],
  ['first-auth-hook-called', AUTH, '    if (options.onAuthenticated) {\n      try { options.onAuthenticated(req) } catch { /* observer only */ }\n    }\n    next()', '    next()'],
  // Drain.
  ['drain-refused', ROUTE, "if (options.isDraining()) return sendReason(res, 'draining', 30)", "if (false) return sendReason(res, 'draining', 30)"],
  // QA round 1 W1: the poll is served during a drain.
  ['poll-served-during-drain', ROUTE, "router.get('/pairing/claim/:nonce', (req, res) => {", "router.get('/pairing/claim/:nonce', notDraining, (req, res) => {"],
  // QA round 1: the separator is QR-alphanumeric.
  ['qr-plus-separator', STATE, "export const PAIRING_QR_HOST_SEPARATOR = '+'", "export const PAIRING_QR_HOST_SEPARATOR = ','"],
  // Logs never carry secrets.
  ['mint-log-hashes-code', STATE, "lan=${this.lanArmedUntil ? 'armed' : 'off'} code#=${pairingCodeTag(code)}", "lan=${this.lanArmedUntil ? 'armed' : 'off'} code#=${code}"],
  ['claim-log-no-nonce', STATE, 'this.log(`[pairing] claim ip=${ip} result=pending code#=${tag}`)', 'this.log(`[pairing] claim ip=${ip} result=pending code#=${tag} n=${nonce}`)'],
  // Capability.
  ['health-advertises-pairing', HEALTH, '      pairing: { version: PAIRING_PROTOCOL_VERSION },\n', ''],
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const selected = args.length ? mutations.filter(([name]) => args.includes(name)) : mutations
if (args.length && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))

const scratch = mkdtempSync(join(tmpdir(), 'pairing-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'work-task-runtime'), join(scratch, 'work-task-runtime'), { recursive: true })
  // health.ts reaches bin/whisper-runtime.cjs through lib/whisper-local.ts.
  cpSync(join(root, 'bin'), join(scratch, 'bin'), { recursive: true })
  // The parity fixture test reads docs/pairing-fixture.json.
  cpSync(join(root, 'docs'), join(scratch, 'docs'), { recursive: true })
  cpSync(join(root, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = () => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json') },
    encoding: 'utf8', timeout: 300000,
  })
  const baseline = run()
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  const totals = /Tests\s+(\d+) passed/.exec(baseline.stdout)
  console.log(`baseline PASS (${totals ? totals[1] : '?'} tests in ${tests.length} files)`)
  for (const [name, file, find, replacement] of selected) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    if (original.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}`)
    const mutated = original.replace(find, replacement)
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    const result = run(), output = result.stdout + '\n' + result.stderr
    writeFileSync(target, original)
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    const killers = [...new Set([...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(m => m[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) throw new Error(`Mutation survived or harness failed: ${name}\n${output}`)
    console.log(`${name} KILLED by ${killers.slice(0, 3).join(' | ')}${killers.length > 3 ? ` (+${killers.length - 3} more)` : ''}`)
  }
  console.log(`${selected.length} of ${selected.length} pairing mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
