#!/usr/bin/env node
// Key lanes K1 combined mutation gate (plan v4 14.2 row P11, 14.3 "Mutation gates serial").
//
// Runs, one after another, every package gate (P1 to P8) and then the P11 integration mutants
// below (the wiring between the packages: seams, runners, the direct relay adapter, the meter's
// per-turn spend and saved cap, the route wiring, answer fields, the Codex resume slot, the keyed
// 409, and the nonce revoke on a steer abort). Each package gate keeps its own rules; the P11 table
// follows the same ones:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Mutations run only in a disposable copy of the checkout; the live checkout is never rewritten.
//
// Usage: node server/scripts/key-lanes-mutation-gate.mjs [--check | --list | --p11-only | --packages-only] [p11 mutant name…]
//   --check          every package gate's --check, then this table's anchors. Runs no tests.
//   --p11-only       only the integration table (optionally only the named mutants).
//   --packages-only  only the package gates.
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PACKAGE_GATES = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p8'].map(p => `server/scripts/key-lanes-${p}-mutation-gate.mjs`)

const WIRE_T = ['server/lib/key-lanes-wiring.test.ts']
const ROUTE_T = ['server/routes/key-lanes-p11.test.ts']
const FIELDS_T = ['server/lib/key-lanes-p11-answer-fields.test.ts']
const CLAUDE_T = ['server/lib/claude-bridge-key-lanes.test.ts']
const CODEX_T = ['server/lib/codex-bridge-key-lanes.test.ts']
const BIND_T = ['server/routes/agent-session-bindings.test.ts']
const ALL = [...WIRE_T, ...ROUTE_T, ...FIELDS_T, ...CLAUDE_T, ...CODEX_T, ...BIND_T]

const WIRING = 'server/lib/key-lanes-wiring.ts', METER = 'server/lib/key-relay-meter.ts', ROUTES = 'server/routes/key-lanes.ts'
const CLAUDE = 'server/lib/claude-bridge.ts', CODEX = 'server/lib/codex-bridge.ts', CES = 'server/lib/codex-engine-sessions.ts'
const BIND = 'server/routes/agent-session-bindings.ts', NOTICES = 'server/lib/key-notices.ts', PHOME = 'server/lib/codex-profile-home.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Boot wiring (key-lanes-wiring.ts, index.ts) ──
  m('wire-relay-seams-not-gated', WIRING, ['  if (keyLanesEnabled()) installKeyRelaySeams()', '  installKeyRelaySeams()'], WIRE_T),
  m('wire-claude-engine-missing', WIRING, ["  registerKeyProfileEngine('claude', runClaudeKeyProfileTurn)\n", ''], WIRE_T),
  m('wire-codex-engine-missing', WIRING, ["  registerKeyProfileEngine('codex', runCodexKeyTurn)\n", ''], WIRE_T),
  m('wire-direct-engine-missing', WIRING, ["  registerKeyProfileEngine('direct', runDirectKeyTurn)\n", ''], WIRE_T),
  m('wire-laneb-relay-missing', WIRING, ['  registerLaneBRelay(() => sharedKeyRelay())\n', ''], WIRE_T),
  m('wire-codex-relay-missing', WIRING, ['  registerCodexKeyRelay(() => sharedKeyRelay())\n', ''], WIRE_T),
  m('wire-codex-thread-recorder-missing', WIRING, ["  registerCodexKeyedThreadRecorder(thread => recordKeyedSession({ id: thread.id, engine: 'codex', profileId: thread.profileId, cosSessionId: thread.cosSessionId }))\n", ''], WIRE_T),
  m('wire-claude-runner-wrong-tier', WIRING, ['callClaudeStreaming(query, sessionId, callbacks, turn.profile.timeoutTier, images', "callClaudeStreaming(query, sessionId, callbacks, 'opus', images"], WIRE_T),
  m('wire-claude-runner-drops-profile', WIRING, ['globalMsgNum, { ...options, keyProfile: turn.profile })', 'globalMsgNum, { ...options })'], WIRE_T),
  m('boot-wiring-removed', 'server/index.ts', ['\nwireKeyLanes()\n', '\n'], WIRE_T),
  // ── The direct relay adapter ──
  m('direct-model-not-forced', WIRING, ['JSON.stringify({ ...body, model: binding.model })', 'JSON.stringify(body)'], WIRE_T),
  m('direct-reserve-refusal-ignored', WIRING, ["          if (!reserved.ok) return { refused: 'cap_refused' }\n", ''], WIRE_T),
  m('direct-lanes-check-removed', WIRING, ["    if (!isActive()) return 'lanes_inactive'\n", ''], WIRE_T),
  m('direct-error-body-not-redacted', WIRING, ["const text = redactSecrets(await response.text().catch(() => ''), [secret])", "const text = await response.text().catch(() => '')"], WIRE_T),
  m('direct-breaker-not-recorded', WIRING, ["            if (countsTowardBreaker(kind)) br.record(breakerScopeFor(kind), breakerScopeFor(kind) === 'key' ? binding.keyRef : binding.profileId, kind, false)\n", ''], WIRE_T),
  m('direct-network-error-keeps-reservation', WIRING, ['            meter().settle({ reservationId: reserved.reservationId, usd: 0, tokens: { input: 0, output: 0 } })\n', ''], WIRE_T),
  m('direct-cut-stream-settled-free', WIRING, ['if (usage === null) { meter().settleReserved(reserved.reservationId); return }', 'if (usage === null) { meter().settle({ reservationId: reserved.reservationId, usd: 0, tokens: { input: 0, output: 0 } }); return }'], WIRE_T),
  // ── Meter: per-turn spend, Control's saved cap ──
  m('meter-file-cap-wins', METER, ['    return saved\n  }\n\n  /** P11: the key-lanes routes', '    return cap\n  }\n\n  /** P11: the key-lanes routes'], [...WIRE_T, ...ROUTE_T]),
  m('meter-turn-spend-not-added', METER, ['    this.addTurnSpend(r.turnId, usd)\n', ''], [...WIRE_T, ...CLAUDE_T, ...CODEX_T]),
  // ── P1 routes wiring ──
  m('route-cap-change-not-noted', ROUTES, ['      getSharedKeyMeter().noteSavedCap(updated.ref, updated.capUsd)\n', ''], ROUTE_T),
  m('route-key-save-not-noted', ROUTES, ['    getSharedKeyMeter().noteSavedCap(saved.ref, saved.capUsd)\n', ''], ROUTE_T),
  m('route-enable-no-seams', ROUTES, ['    installKeyRelaySeams()\n', ''], ROUTE_T),
  m('route-status-no-reset-time', ROUTES, ['    resetsAt: keyCapResetsAt(now),\n', ''], ROUTE_T),
  m('route-catalog-not-shared', ROUTES, ["  if (snapshot.from !== 'openrouter') throw new Error('catalog unavailable')\n  return snapshot.models", '  return []'], ROUTE_T),
  // ── Answer fields and cost (P9 app half) ──
  m('claude-done-no-usd', CLAUDE, ['      ...(keyLane ? { keyLane, ...keyUsdFields } : {}),', '      ...(keyLane ? { keyLane } : {}),'], CLAUDE_T),
  m('codex-done-no-key-lane', CODEX, ['        ...(keyLane ? { keyLane, ...keyUsdFields } : {}),\n', ''], CODEX_T),
  m('sse-done-no-key-fields', 'server/routes/query.ts', ['              ...keyAnswerDoneFields(runMetadata),\n', ''], FIELDS_T),
  m('runtime-done-no-key-fields', 'server/lib/query-job-runtime.ts', ['            ...keyAnswerDoneFields(runMetadata),\n', ''], FIELDS_T),
  m('answer-fields-no-profile', 'server/lib/key-answer-fields.ts', ['  return { lane: keyLane.lane, credential: keyLane.credential, profile: keyLane.credential.profileId }', '  return { lane: keyLane.lane, credential: keyLane.credential }'], FIELDS_T),
  // ── Nonce revoke on steer abort (P3 asked for this mutant) ──
  m('steer-abort-keeps-nonce', CLAUDE, ["    keyTurn?.revoke('steer_abort')\n", ''], CLAUDE_T),
  // ── Codex resume slot by profile ──
  m('codex-slot-shared-with-subscription', CES, ['  return profileId ? `${cosSessionId}:${model}:profile:${profileId}` : `${cosSessionId}:${model}`', '  return `${cosSessionId}:${model}`'], [...WIRE_T, ...CODEX_T]),
  m('codex-bridge-get-ignores-slot', CODEX, ['      engineFingerprint: extraFingerprint,\n      ...(keyProfile ? { profileId: keyProfile.id } : {}),\n    })\n    : null', '      engineFingerprint: extraFingerprint,\n    })\n    : null'], CODEX_T),
  m('codex-clear-ignores-lane', CES, ['    if (model && (session.profileId ?? undefined) !== slotProfile(profileId)) continue\n', ''], WIRE_T),
  // ── The keyed 409 on Continue and Fork ──
  m('bindings-keyed-turn-generic', BIND, ["      if (adapterEvidence.adapterReason === 'keyed_session') {", "      if (false) {"], BIND_T),
  m('bindings-keyed-fork-generic', BIND, ["(raw as { reason?: unknown }).reason === 'keyed_session') {", "(raw as { reason?: unknown }).reason === 'never') {"], BIND_T),
  // ── One source of copy, one stripped-name list ──
  m('refusal-copy-em-dash', NOTICES, ["  relayUnavailable: 'Your key could not start this turn. Your plan was not used.',", "  relayUnavailable: 'Your key could not start this turn — your plan was not used.',"], WIRE_T),
  m('codex-strip-drops-p3-list', PHOME, ["  return name === 'CODEX_HOME' || isLaneBStrippedName(name)", "  return name === 'CODEX_HOME'"], CODEX_T),
]

const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const names = args.filter(a => !a.startsWith('--'))
if (flags.has('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')
const selected = names.length ? mutations.filter(({ name }) => names.includes(name)) : mutations
if (names.length && selected.length !== names.length) throw new Error('Unknown mutation name in: ' + names.join(' '))

function checkOwnAnchors() {
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
  console.log(`P11: ${mutations.length - bad} of ${mutations.length} targets match exactly once`)
  return bad === 0
}

function runPackageGate(gate, extra) {
  const r = spawnSync(process.execPath, [join(root, gate), ...extra], { cwd: root, encoding: 'utf8', timeout: 3 * 60 * 60 * 1000, env: process.env })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const last = out.trim().split('\n').filter(Boolean).at(-1) ?? '(no output)'
  return { ok: r.status === 0 && !r.error, last, out }
}

if (flags.has('--check')) {
  let ok = true
  for (const gate of PACKAGE_GATES) {
    const r = runPackageGate(gate, ['--check'])
    console.log(`${basename(gate)} --check: ${r.last}`)
    if (!r.ok) ok = false
  }
  if (!checkOwnAnchors()) ok = false
  process.exit(ok ? 0 : 1)
}

const summary = []
if (!flags.has('--p11-only')) {
  for (const gate of PACKAGE_GATES) {
    const started = Date.now()
    const r = runPackageGate(gate, [])
    console.log(`${basename(gate)}: ${r.last} (${Math.round((Date.now() - started) / 1000)} s)`)
    summary.push(`${basename(gate)}: ${r.last}`)
    if (!r.ok) { console.log(r.out.slice(-4000)); process.exitCode = 1 }
  }
}

if (!flags.has('--packages-only')) {
  if (!checkOwnAnchors()) throw new Error('P11 anchors do not match exactly once')
  const scratch = mkdtempSync(join(tmpdir(), 'key-lanes-p11-mutations-'))
  try {
    const skip = new Set(['data', 'models', 'certs', 'node_modules'])
    cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
    for (const dir of ['shared', 'work-task-runtime', 'bin', 'docs', 'memory-runtime']) cpSync(join(root, dir), join(scratch, dir), { recursive: true })
    for (const file of ['vitest.config.ts', 'package.json', 'managed-runtime-contract.json']) cpSync(join(root, file), join(scratch, file))
    symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
    const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
      cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: process.env.TMPDIR, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json') },
      encoding: 'utf8', timeout: 600000,
    })
    const baseline = run(ALL)
    if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
    const totals = /Tests\s+(\d+) passed/.exec(baseline.stdout)
    console.log(`P11 baseline PASS (${totals ? totals[1] : '?'} tests in ${ALL.length} files)`)
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
    const line = `${killed} of ${selected.length} key lanes P11 integration mutations killed`
    console.log(line)
    summary.push(line)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
if (summary.length) console.log(`\nSUMMARY\n${summary.join('\n')}`)
