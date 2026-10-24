#!/usr/bin/env node
// 6.89.0 mutation gate: the Tailscale nudge (lib/tailscale-nudge.ts) and the LAN-first removal (the 6.87.0
// parity of /api/health and /api/models, and the closed /api/route-proof door). Engine copied unchanged from
// integrity-6880-mutation-gate.mjs. Mutations run only in a disposable copy of the checkout; the live checkout
// is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/tailscale-nudge-6890-mutation-gate.mjs [--list] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NUDGE_T = ['server/lib/tailscale-nudge.test.ts']
const PARITY_T = ['server/routes/health-6890-parity.test.ts']
const ALL = [...NUDGE_T, ...PARITY_T]
const N = 'server/lib/tailscale-nudge.ts', AUTH = 'server/lib/api-auth.ts', HEALTH = 'server/routes/health.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Never on absence alone ──
  m('silent-online-ignored', N, ['      if (!peer || !peer.online) continue', '      if (!peer) continue'], NUDGE_T),
  m('silent-missing-peer-nudged', N, ['      const peer = status.peers.find(p => p.ip === ip)\n      if (!peer || !peer.online) continue', '      const peer = status.peers.find(p => p.ip === ip) ?? { ip, online: true, os: \'\', rxBytes: 0, txBytes: 0, lastHandshakeMs: 0 }\n      if (!peer.online) continue'], NUDGE_T),
  m('silent-running-ignored', N, ["    if (!status || status.backendState !== 'Running') return\n    for (const [ip, t] of silent)", '    if (!status) return\n    for (const [ip, t] of silent)'], NUDGE_T),
  m('event-online-ignored', N, ['      .filter(p => p.online && (known(p.ip) || isMobileOs(p.os)))', '      .filter(p => (known(p.ip) || isMobileOs(p.os)))'], NUDGE_T),
  m('event-any-peer', N, ['      .filter(p => p.online && (known(p.ip) || isMobileOs(p.os)))', '      .filter(p => p.online)'], NUDGE_T),
  m('event-running-ignored', N, ["    if (!status || status.backendState !== 'Running') {", '    if (!status) {'], NUDGE_T),
  m('status-never-refreshed', N, ['    if (this.status && at - this.status.at <= TAILSCALE_NUDGE_LIMITS.statusFreshMs) return this.status', '    if (this.status) return this.status'], NUDGE_T),
  // ── Who counts as expected-but-silent ──
  m('silence-threshold-zero', N, ['      if (expected && at - t.lastRequestAt >= L.silenceMs && this.allowed(ip, at))', '      if (expected && at - t.lastRequestAt >= 0 && this.allowed(ip, at))'], NUDGE_T),
  m('active-window-forever', N, ['(t.lastAuthenticatedAt > 0 && at - t.lastAuthenticatedAt <= L.activeWindowMs)', '(t.lastAuthenticatedAt > 0)'], NUDGE_T),
  m('meeting-open-ignored', N, ['|| (meetingOpen && t.lastMeetingChunkAt > 0', '|| (t.lastMeetingChunkAt > 0'], NUDGE_T),
  m('meeting-window-forever', N, ['&& at - t.lastMeetingChunkAt <= L.meetingWindowMs)', ')'], NUDGE_T),
  m('meeting-never-counts', N, ['|| (meetingOpen && t.lastMeetingChunkAt > 0', '|| (false && t.lastMeetingChunkAt > 0'], NUDGE_T),
  m('any-address-tracked', N, ['      if (!isTailscaleIpv4(ip)) return', '      if (!ip) return'], NUDGE_T),
  m('public-request-pairs', N, ['      if (kind.authenticated) track.lastAuthenticatedAt = at', '      track.lastAuthenticatedAt = at'], NUDGE_T),
  m('silent-prefilter-removed', N, ['      if (expected && at - t.lastRequestAt >= L.silenceMs && this.allowed(ip, at))', '      if (expected && at - t.lastRequestAt >= L.silenceMs)'], NUDGE_T),
  // ── Caps and backoff ──
  m('request-keeps-backoff', N, ['      track.consecutive = 0\n      if (kind.authenticated)', '      if (kind.authenticated)'], NUDGE_T),
  m('hour-cap-removed', N, ['    if (this.hourLog.length >= L.maxPerHour) return false\n', ''], NUDGE_T),
  m('min-interval-removed', N, ['    return at - t.lastNudgeAt >= Math.max(L.minIntervalMs, backoffMs(t.consecutive))', '    return at - t.lastNudgeAt >= backoffMs(t.consecutive)'], NUDGE_T),
  m('backoff-flat', N, ['  return Math.min(minIntervalMs * 2 ** (consecutive - 1), maxBackoffMs)', '  return Math.min(minIntervalMs, maxBackoffMs)'], NUDGE_T),
  m('backoff-uncapped', N, ['  return Math.min(minIntervalMs * 2 ** (consecutive - 1), maxBackoffMs)', '  return minIntervalMs * 2 ** (consecutive - 1)'], NUDGE_T),
  m('event-max-peers-removed', N, ['      .slice(0, L.eventMaxPeers)\n', ''], NUDGE_T),
  m('overlap-allowed', N, ['    if (this.busy) return\n', ''], NUDGE_T),
  // ── Kill switch and binary ──
  m('kill-switch-ignored', N, ['    if (!this.enabled()) return\n    if (!this.ensureBin(at)) return', '    if (!this.ensureBin(at)) return'], NUDGE_T),
  m('kill-switch-default-off', N, ['    return readSwitch(this.env().COS_TAILSCALE_NUDGE, true)', '    return readSwitch(this.env().COS_TAILSCALE_NUDGE, false)'], NUDGE_T),
  m('bin-not-fixed', N, ['  for (const candidate of TAILSCALE_BIN_CANDIDATES) if (isExecutable(candidate)) return candidate', "  for (const candidate of TAILSCALE_BIN_CANDIDATES) if (isExecutable(candidate)) return 'tailscale'"], NUDGE_T),
  m('runner-through-shell', N, ['  execFile(bin, [...args], {', "  execFile('/bin/sh', ['-c', [bin, ...args].join(' ')], {"], NUDGE_T),
  m('disco-args-changed', N, ["export const DISCO_PING_ARGS = (ip: string): string[] => ['ping', '-c', '3', '--timeout', '5s', ip]", "export const DISCO_PING_ARGS = (ip: string): string[] => ['ping', ip]"], NUDGE_T),
  // ── Triggers ──
  m('boot-not-delayed', N, ['    this.pending = { trigger: \'boot\', firedAt: at, dueAt: at + TAILSCALE_NUDGE_LIMITS.bootDelayMs }', '    this.pending = { trigger: \'boot\', firedAt: at, dueAt: at }'], NUDGE_T),
  m('wake-never', N, ['(at - this.lastTick.wall) - (mono - this.lastTick.mono) > L.wakeGapMs', 'false'], NUDGE_T),
  m('wake-any-gap', N, ['(at - this.lastTick.wall) - (mono - this.lastTick.mono) > L.wakeGapMs', '(at - this.lastTick.wall) - (mono - this.lastTick.mono) > 0'], NUDGE_T),
  m('network-never', N, ['    if (this.lastFingerprint !== null && fp !== this.lastFingerprint)', '    if (false)'], NUDGE_T),
  m('tailscale-restart-unseen', N, ['  return total(next) < total(prev)', '  return false'], NUDGE_T),
  m('event-nudges-peer-already-back', N, ['      .filter(p => (this.peers.get(p.ip)?.lastRequestAt ?? 0) < pending.firedAt)\n', ''], NUDGE_T),
  m('event-never-expires', N, ['      if (at - pending.firedAt > L.eventExpiryMs) {', '      if (false) {'], NUDGE_T),
  // ── The data-path ping ──
  m('icmp-always', N, ["    if (outcome === 'pong_direct' || outcome === 'pong_relay') {", '    if (true) {'], NUDGE_T),
  m('icmp-never', N, ["    if (outcome === 'pong_direct' || outcome === 'pong_relay') {", '    if (false) {'], NUDGE_T),
  m('recovered-any-time', N, ['at - this.lastNudge.at <= TAILSCALE_NUDGE_LIMITS.recoveredWithinMs', 'true'], NUDGE_T),
  // ── What it says ──
  m('health-leaks-address', N, ['      lastTrigger: this.lastNudge?.trigger ?? null,', '      lastTrigger: (this.lastNudge ? `${this.lastNudge.trigger}:${this.lastNudge.ip}` : null) as any,'], NUDGE_T),
  m('log-leaks-address', N, ['    this.log(`[tailscale-nudge] trigger=${trigger} outcome=', '    this.log(`[tailscale-nudge] peer=${peer.ip} trigger=${trigger} outcome='], NUDGE_T),
  // ── The LAN-first removal (6.87.0 parity) ──
  m('route-proof-public-again', AUTH, ["  if (method === 'GET' && PAIRING_POLL_PATH.test(path)) return true\n", "  if (method === 'GET' && PAIRING_POLL_PATH.test(path)) return true\n  if (method === 'GET' && path === '/route-proof') return true\n"], PARITY_T),
  m('health-capability-added', HEALTH, ['      tasks: {\n        gate: taskBridgeAvailable() ? \'ready\' : \'disabled\',\n      },\n    },\n    // /api/health is intentionally', '      tasks: {\n        gate: taskBridgeAvailable() ? \'ready\' : \'disabled\',\n      },\n      lanRoutes: { protocol: 1 },\n    },\n    // /api/health is intentionally'], PARITY_T),
  m('health-nudge-field-dropped', HEALTH, ['    ...tailscaleNudgeHealthField(),\n', ''], PARITY_T),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')

const scratch = mkdtempSync(join(tmpdir(), 'tailscale-nudge-6890-mutations-'))
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
    const killers = [...new Set([...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(x => x[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { console.log(`${name} SURVIVED or harness failed\n${output.slice(-3000)}`); process.exitCode = 1; continue }
    killed += 1
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${killed} of ${selected.length} Tailscale nudge and LAN-first removal 6.89.0 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
