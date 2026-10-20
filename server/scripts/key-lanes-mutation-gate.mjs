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
const JOB_T = ['server/lib/key-lanes-p11-job-record.test.ts']
const READ_T = ['server/lib/codex-homes-readers.test.ts']
const SESS_T = ['server/routes/agent-sessions-keyed.test.ts']
// QA fix pass
const GUARD_T = ['server/lib/key-secrets-guard.test.ts', 'server/lib/key-secrets-cli.test.ts']
const CENSUS_T = ['server/lib/key-lanes-spawn-census.test.ts']
const RELAY_T = ['server/lib/key-relay.test.ts']
const LEDGER_T = ['server/lib/key-ledger.test.ts']
const LANEB_T = ['server/lib/lane-b-env.test.ts']
const HOME_T = ['server/lib/codex-profile-home.test.ts']
const PREF_T = ['server/lib/key-lanes-p6-preference.test.ts']
// Real-canary fix pass
const AT_T = ['server/lib/key-lanes-agent-teams-cli.test.ts']
const ALL = [...WIRE_T, ...ROUTE_T, ...FIELDS_T, ...CLAUDE_T, ...CODEX_T, ...BIND_T, ...JOB_T, ...READ_T, ...SESS_T, ...GUARD_T, ...CENSUS_T, ...RELAY_T, ...LEDGER_T, ...LANEB_T, ...HOME_T, ...PREF_T, 'server/lib/hazard-invariants.test.ts', ...AT_T]

const WIRING = 'server/lib/key-lanes-wiring.ts', METER = 'server/lib/key-relay-meter.ts', ROUTES = 'server/routes/key-lanes.ts'
const CLAUDE = 'server/lib/claude-bridge.ts', CODEX = 'server/lib/codex-bridge.ts', CES = 'server/lib/codex-engine-sessions.ts'
const STORE = 'server/lib/agent-session-store.ts'
const BIND = 'server/routes/agent-session-bindings.ts', NOTICES = 'server/lib/key-notices.ts', PHOME = 'server/lib/codex-profile-home.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── Boot wiring (key-lanes-wiring.ts, index.ts) ──
  m('wire-relay-seams-not-gated', WIRING, ['  if (keyLanesEnabled()) installKeyRelaySeams()', '  installKeyRelaySeams()'], WIRE_T),
  m('wire-claude-engine-missing', WIRING, ["  registerKeyProfileEngine('claude', runClaudeKeyProfileTurn)\n", ''], WIRE_T),
  m('wire-codex-engine-missing', WIRING, ["  registerKeyProfileEngine('codex', runCodexKeyTurn)\n", ''], WIRE_T),
  m('wire-direct-engine-missing', WIRING, ["  registerKeyProfileEngine('direct', runDirectKeyTurn)\n", ''], WIRE_T),
  m('wire-laneb-relay-missing', WIRING, ['  registerLaneBRelay(() => laneBRelayView())\n', ''], WIRE_T),
  m('wire-codex-relay-missing', WIRING, ['  registerCodexKeyRelay(() => laneBRelayView())\n', ''], WIRE_T),
  m('wire-codex-thread-recorder-missing', WIRING, ["  registerCodexKeyedThreadRecorder(thread => recordKeyedSession({ id: thread.id, engine: 'codex', profileId: thread.profileId, cosSessionId: thread.cosSessionId }))\n", ''], WIRE_T),
  m('wire-claude-runner-wrong-tier', WIRING, ['withKeyFailureLines(callbacks, turnId, turn.profile), turn.profile.timeoutTier, images', "withKeyFailureLines(callbacks, turnId, turn.profile), 'opus', images"], WIRE_T),
  m('wire-claude-runner-drops-profile', WIRING, ['globalMsgNum, { ...options, turnId, keyProfile: turn.profile })', 'globalMsgNum, { ...options, turnId })'], WIRE_T),
  // ── Relay turn failures read as the key-notices line (second pass) ──
  m('turn-failure-not-reported', WIRING, ['    onTurnFailure: recordKeyTurnFailure,\n', ''], WIRE_T),
  m('turn-failure-line-ignored', WIRING, ['    onError: error => callbacks.onError(keyTurnFailureLine(turnId, profile) ?? error),', '    onError: error => callbacks.onError(error),'], WIRE_T),
  m('breaker-pause-not-read', WIRING, ["  const paused = f.scope && f.id && f.kind !== 'breaker_open' && sharedKeyRelay().breakers.isOpen(f.scope, f.id)", '  const paused = false'], WIRE_T),
  m('pre-spawn-refusal-not-remembered', WIRING, ['        if (id) rememberFailure(binding.turnId, { kind: id, keyRef: binding.keyRef, ends: true })\n', ''], WIRE_T),
  m('claude-runner-no-turn-id', WIRING, ['globalMsgNum, { ...options, turnId, keyProfile: turn.profile })', 'globalMsgNum, { ...options, keyProfile: turn.profile })'], WIRE_T),
  m('codex-runner-raw-errors', WIRING, ['runCodexKeyProfileTurn(query, sessionId, withKeyFailureLines(callbacks, turnId, turn.profile), turn', 'runCodexKeyProfileTurn(query, sessionId, callbacks, turn'], WIRE_T),
  m('done-keeps-stale-failure', WIRING, ['    onDone: (...args) => { turnFailures.delete(turnId); return callbacks.onDone(...args) },', '    onDone: (...args) => callbacks.onDone(...args),'], WIRE_T),
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
  // ── Durable job records of keyed answers (second pass) ──
  m('job-record-no-key-fields', 'server/lib/query-job-store.ts', ['      ...(outputImageStats ? { outputImageStats } : {}),\n      ...keyAnswer,\n    }, {', '      ...(outputImageStats ? { outputImageStats } : {}),\n    }, {'], JOB_T),
  m('job-replay-drops-key-fields', 'server/lib/query-job-store.ts', ['      Object.assign(snapshot, keyAnswerJobFields(patch))\n', ''], JOB_T),
  m('runtime-completion-no-key-fields', 'server/lib/query-job-runtime.ts', ['            ...keyAnswerCompletionFields(metadata),\n', ''], FIELDS_T),
  m('job-fields-profile-mismatch-kept', 'server/lib/key-answer-fields.ts', ['  if (x.profile !== c.profileId) return {}\n', ''], JOB_T),
  m('job-fields-bad-ref-kept', 'server/lib/key-answer-fields.ts', ['typeof c.ref !== \'string\' || !KEY_REF_RE.test(c.ref)', 'typeof c.ref !== \'string\''], JOB_T),
  // ── Agent sessions read every Codex home (second pass) ──
  m('names-server-home-only', STORE, ['  for (const root of profiles) {\n    for (const [id, name] of await loadCodexThreadNames(root)) if (!names.has(id)) names.set(id, name)\n  }\n', ''], [...READ_T, ...SESS_T]),
  m('names-profile-wins-clash', STORE, ['if (!names.has(id)) names.set(id, name)', 'names.set(id, name)'], READ_T),
  m('pinned-server-home-only', STORE, ['  for (const root of profiles) for (const id of await loadCodexPinnedIds(root)) pinned.add(id)\n', ''], READ_T),
  m('search-server-home-only', 'server/lib/agent-session-search.ts', ['codexSessionRootsOf(roots).map(root => listCodexJsonlFiles(root))', '[roots.codexSessions].map(root => listCodexJsonlFiles(root))'], READ_T),
  m('subagents-not-routed-to-home', 'server/lib/codex-subagent-activity.ts', ['    const root = own && sessionsRoots.includes(own) ? own : server', '    const root = server'], [...READ_T, ...SESS_T]),
  m('list-subagents-server-home-only', 'server/routes/agent-sessions.ts', ['codexRoots, now, codexRoots.length > 1 ? keyedCodexRootOf() : undefined)', 'codexRoots, now, undefined)'], SESS_T),
  m('detail-subagents-server-home-only', 'server/routes/agent-sessions.ts', ['detailRoots, undefined, detailRoots.length > 1 ? keyedCodexRootOf() : undefined)', 'detailRoots, undefined, undefined)'], SESS_T),
  m('detail-name-server-home-only', 'server/routes/agent-sessions.ts', ['      const names = await loadCodexThreadNamesAll(agentSessionRoots())', '      const names = new Map<string, string>()'], SESS_T),
  // ── QA fix pass: B1 secrets deny layer ──
  m('secrets-deny-layer-dropped', 'server/lib/key-secrets-guard.ts', ['    permissions: { deny: keySecretsDenyRules() },\n', ''], [...GUARD_T, ...CLAUDE_T]),
  m('secrets-deny-ignores-lanes-off', 'server/lib/key-secrets-guard.ts', ['  if (!keyLanesEnabled()) return []\n', ''], GUARD_T),
  m('secrets-deny-no-bash-rule', 'server/lib/key-secrets-guard.ts', ['  rules.push(`Bash(*${KEY_SECRETS_DIR}*)`, `Bash(*${KEY_STORE_FILE}*)`)\n', ''], GUARD_T),
  m('archive-spawn-without-deny-layer', 'server/lib/archive.ts', ["'sonnet', ...claudeKeySecretsGuardArgs(), instruction]", "'sonnet', instruction]"], CENSUS_T),
  m('prompt-edit-spawn-without-deny-layer', 'server/lib/prompt-edit.ts', ['    args.push(...claudeKeySecretsGuardArgs())\n', ''], CENSUS_T),
  // ── W2 cap overshoot, W3 open reserves ──
  m('reserve-ignores-headroom-floor', METER, ['  if (headroom < floorUsd) return null\n', ''], RELAY_T),
  m('stream-not-cut-at-cap', 'server/lib/key-relay.ts', ['            if (reservationId && this.streamPastCap(b.keyRef, reservationId, parser.usage, price, body.length)) {', '            if (false) {'], RELAY_T),
  m('ledger-open-blocks-on-a-fifo', 'server/lib/key-ledger.ts', [' | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK, 0o600)', ' | fsConstants.O_NOFOLLOW, 0o600)'], ['server/lib/hazard-invariants.test.ts']),
  m('open-reserves-not-counted', 'server/lib/key-ledger.ts', ['  for (const left of open.values()) for (const usd of left) sum += usd\n', ''], LEDGER_T),
  // ── W4 / G7 settings and env guards ──
  m('settings-guard-skips-managed', 'server/lib/claude-settings-guard.ts', ['    ...(input.managed ?? CLAUDE_MANAGED_SETTINGS_FILES),\n', ''], LANEB_T),
  m('settings-guard-skips-config-dir', 'server/lib/claude-settings-guard.ts', ["    ...(configDir ? [join(configDir, 'settings.json')] : []),\n", ''], LANEB_T),
  m('oauth-token-not-stripped', 'server/lib/lane-b-env.ts', ["  'CLAUDE_CODE_OAUTH_TOKEN',\n", ''], LANEB_T),
  m('codex-project-config-ignored', PHOME, ['  if (project) return { ok: false, message: KEY_LANE_REFUSAL_COPY.codexProjectConfig(project.name) }\n', ''], HOME_T),
  // ── W5, U6 routes ──
  m('profile-off-keeps-turns', ROUTES, ['      if (!p.enabled || before.keyRef !== p.keyRef || before.model !== p.model || before.engine !== p.engine) relay?.revokeProfile(p.id)\n', ''], ROUTE_T),
  m('model-change-keeps-breaker', ROUTES, ["      if (before.keyRef !== p.keyRef || before.model !== p.model) relay?.resetBreaker('profile', p.id)\n", ''], ROUTE_T),
  m('breaker-reset-route-noop', ROUTES, ["    relay?.resetBreaker('key', ref)\n", ''], ROUTE_T),
  // ── N3, N5, N6, N10 / U2 ──
  m('redaction-misses-escaped-forms', 'server/lib/key-relay-errors.ts', ['    const forms = new Set([s, JSON.stringify(s).slice(1, -1), encodeURIComponent(s)])', '    const forms = new Set([s])'], RELAY_T),
  m('remote-http-endpoint-allowed', 'server/lib/key-store.ts', ["    if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) return null\n", ''], WIRE_T),
  m('rewrite-log-unsanitized', 'server/lib/key-relay.ts', [".slice(0, 64).replace(/[^A-Za-z0-9._:/@\\[\\]-]/g, '?')}", '.slice(0, 64)}'], RELAY_T),
  m('ended-nonce-not-reported', 'server/lib/key-relay.ts', ["        if (ended) this.fail({ binding: ended.binding }, ended.reason === 'expired' ? 'nonce_expired' : 'nonce_revoked', 401)\n", ''], RELAY_T),
  m('refused-4xx-not-reported', 'server/lib/key-relay.ts', ["        this.fail(entry, kind ?? 'upstream_refused', upstream.status)", '        if (kind) this.fail(entry, kind, upstream.status)'], RELAY_T),
  m('network-error-not-reported', 'server/lib/key-relay.ts', ["        this.fail(entry, 'network_error', 502)\n", ''], RELAY_T),
  m('turn-ending-failure-overwritten', WIRING, ['  if (turnFailures.get(turnId)?.ends && !failure.ends) return\n', ''], WIRE_T),
  // ── U9, C11, C2 test upstream, same-Mac copy ──
  m('one-turn-binds-the-session', 'server/lib/model-router.ts', ['    if (!options?.keyTurnOnly) setSessionModel(sid, resolved.turn.binding)', '    setSessionModel(sid, resolved.turn.binding)'], PREF_T),
  m('key-turn-only-on-any-model', 'server/lib/query-job-types.ts', ['input.keyTurnOnly === true && isProfilePreference(model) ? { keyTurnOnly: true as const }', 'input.keyTurnOnly === true ? { keyTurnOnly: true as const }'], JOB_T),
  m('gone-slug-not-refused', WIRING, ['  if (models.some(m => m.id === turn.profile.model)) return null', '  return null'], WIRE_T),
  m('test-upstream-accepts-any-host', WIRING, ["    if (u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port) return u.origin", '    if (u.port) return u.origin'], WIRE_T),
  m('same-mac-copy-drift', NOTICES, ["Apps and agents that run on this Mac as you can read it.", "Apps on this Mac can read it."], WIRE_T),
  // ── Real-canary fix pass (R12 agent teams, parallel subagents, R14 Codex, R9 cut pricing, R7 hook marker) ──
  m('agent-teams-layer-dropped', 'server/lib/key-secrets-guard.ts', ['    ...(opts.laneB ? { env: { ...LANE_B_FORCED_SETTINGS_ENV } } : {}),\n', ''], [...CLAUDE_T, ...AT_T]),
  m('keyed-turn-without-agent-teams-layer', CLAUDE, ['claudeKeySecretsGuardArgs(keyProfile ? { laneB: true } : {})', 'claudeKeySecretsGuardArgs()'], CLAUDE_T),
  m('agent-teams-setting-not-watched', 'server/lib/claude-settings-guard.ts', ['    for (const name of CLAUDE_SETTINGS_WATCHED_ENV) if (Object.prototype.hasOwnProperty.call(env, name)) out.push({ file, name })\n', ''], LANEB_T),
  m('in-flight-no-queue', 'server/lib/key-relay.ts', ['        const got = await this.waitForSlot(entry)', '        const got = false'], RELAY_T),
  m('in-flight-slot-not-handed-over', 'server/lib/key-relay.ts', ['        if (next) next(true)\n        else entry.inFlight -= 1', '        entry.inFlight -= 1'], RELAY_T),
  m('relay-busy-not-reported', 'server/lib/key-relay.ts', ["          if (this.turns.has(entry.hash)) this.fail(entry, 'relay_busy', 429)\n", ''], RELAY_T),
  m('hello-probe-not-answered', 'server/lib/key-relay.ts', ["      if (req.method === 'HEAD' && path === `${RELAY_BASE_PATHS.claude}/api/hello`) {", '      if (false) {'], RELAY_T),
  m('cache-read-priced-at-full', 'server/lib/key-relay.ts', ['read * price.inUsdPerM * CACHE_READ_PRICE_FACTOR', 'read * price.inUsdPerM'], RELAY_T),
  m('cut-not-reconciled', 'server/lib/key-relay.ts', ["        if (cutGeneration && entry.keyKind === 'openrouter') this.scheduleReconcile(entry, cutGeneration, streamed.usd)\n", ''], RELAY_T),
  m('cut-decision-ignores-cache-pricing', 'server/lib/key-relay.ts', ['  const cached = usage.input > 0 ? { cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } : {}', '  const cached = {}'], RELAY_T),
  m('codex-stream-retries-multiply', PHOME, ['export const CODEX_RELAY_STREAM_RETRIES = 0', 'export const CODEX_RELAY_STREAM_RETRIES = 2'], HOME_T),
  m('codex-done-keeps-nonce', CODEX, ["    keyTurn?.revoke('child_close')\n", ''], CODEX_T),
  m('codex-error-keeps-nonce', CODEX, ["    // Canary R14: a Codex child keeps retrying after the bridge ends the turn; its nonce dies now.\n    keyTurn?.revoke('cancel')\n", ''], CODEX_T),
  m('hook-profile-not-from-record', 'server/lib/session-hook-events.ts', ['  const recorded = keyedSessionProfile(sessionId)', '  const recorded = undefined'], READ_T),
  m('hook-profile-looked-up-with-lanes-off', 'server/lib/session-hook-events.ts', ['  if (!sessionId || !keyLanesEnabled()) return undefined', '  if (!sessionId) return undefined'], READ_T),
  // ── Canary rerun on 8cf5ca7: R8 Codex hook rows, the cap overshoot copy ──
  m('hook-ledger-drops-key-profile', 'server/lib/session-hook-ledger.ts', ['        ...(env.keyProfile && keyLanesEnabled() ? { keyProfile: env.keyProfile } : {}),\n', ''], READ_T),
  m('hook-ledger-key-profile-with-lanes-off', 'server/lib/session-hook-ledger.ts', ['env.keyProfile && keyLanesEnabled() ?', 'env.keyProfile ?'], READ_T),
  m('hook-ledger-replay-drops-key-profile', 'server/lib/session-hook-ledger.ts', ['        ...(isKeyProfileId(r.keyProfile) ? { keyProfile: r.keyProfile } : {}),\n', ''], READ_T),
  m('cap-overshoot-copy-drift', NOTICES, ["The cap can be exceeded by the last reply in progress. Your provider limit is the hard stop.", "The cap is a hard stop."], WIRE_T),
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
