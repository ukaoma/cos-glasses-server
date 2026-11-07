#!/usr/bin/env node
// 6.60.0 away hold mutation gate. Mutations run only in a disposable copy of server/, shared/
// and bin/; the live checkout is never rewritten. The unmutated suites must pass first (a gate
// over a red suite proves nothing), each target must match exactly once, and each mutant must
// fail the NAMED test written for it (a transform or compile error fails the file, not a named
// test, so it never counts as a kill).
//
// Covers what the 6.60.0 brief names: the away extension, the desk-return handover, the
// installed-timeout clamp (the earlier 130 s hook), no_client while away, and the fallback on
// an unreadable settings file; plus the hook script's wait, the prior-wait drift and
// waitingAtMac; Miles's 19:54 rule as the contract shared with COS Glasses 6.9.563 (hold=1
// and wearer presence, re-checked every tick, sleep-safe); QA round 1's fixes (the ceiling at
// base, the unreadable-settings stamp, fingerprint-only and ended-row clearing, forgot vs
// moved past, the not-held log, the curl kill) and the Ghost Hunter's two survivors.
// 6.99.26 (QA round 1): COS Control Web's touch (web-*): it admits only what nothing else would,
// never at the desk for a stamped question, goes back to the Mac when the desk is used, never
// counts from the Mac itself, never changes a glasses or phone hold, and has its own switch.
// Twelve earlier targets had drifted (eight with 6.71.7's stamped questions, four with 6.99.26's
// presence refactor); each is re-anchored on today's code with the same mutation and killer.
//
// Usage: node server/scripts/away-hold-mutation-gate.mjs [--list] [name...]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LIB = 'server/lib/permission-broker.ts'
const INSTALLER = 'server/lib/claude-hooks-installer.ts'
const SCRIPT = 'bin/hooks/cos-session-hook'
const LIVENESS = 'server/lib/client-liveness.ts'
const ROUTE = 'server/routes/permission-broker.ts'
const RUNTIME = 'server/lib/session-hooks-runtime.ts'
const BROKER_TESTS = ['server/lib/permission-broker.test.ts', 'server/routes/permission-broker.test.ts']
const INSTALLER_TESTS = ['server/lib/claude-hooks-installer.test.ts', 'server/lib/permission-broker.test.ts']
const SCRIPT_TESTS = ['server/lib/cos-session-hook.script.test.ts']
const RUNTIME_TESTS = ['server/lib/session-hooks-runtime.test.ts']
const WEB_TESTS = ['server/lib/permission-broker-web-hold.test.ts', 'server/routes/session-questions-web.test.ts']
const WEB_DESK = 'at the desk, a web touch admits no stamped question'
const WEB_BACK = 'goes back to the Mac the moment the desk is used'
const WEB_DEVICE = 'the web touch never changes a glasses or phone hold'
const WEB_EVERY = 'for every glasses and phone case, a web touch, recent or stale, changes nothing the device decides'

const EXTENSION = 'the away extension: a lens worn 10 minutes ago, none polling now'
const PRESENCE = 'a lens worn 10 minutes ago gives a hold; 30 minutes is held'
const UNWORN = 'a hold=1 lens polling every 10 s with no presence (nobody wearing it)'
const UNWORN_ROUTE = 'a 6.9.563 lens polling with no presenceAgeMs (nobody wearing it)'
const CEILING = 'holdCeilingS: the installed timeout and this request'
const BEFORE_INSTALL = 'before Install hooks (the ceiling at or below the 6.59.0 clamp) away semantics are off entirely'
const FORGOT = 'forgot vs moved past'
const AGE = 'presence age is the larger of the monotonic and wall ages'

// [name, file, exact target, replacement, a substring of the test that must fail, tests]
const mutations = [
  // The away extension, and never shorter than the base timeout
  ['away-extension-dropped', LIB, '    const wanted = awayHoldMs > 0 ? Math.max(baseMs, awayHoldMs) : baseMs\n', '    const wanted = baseMs\n', EXTENSION, BROKER_TESTS],
  ['away-shorter-than-base', LIB, '    const wanted = awayHoldMs > 0 ? Math.max(baseMs, awayHoldMs) : baseMs\n', '    const wanted = awayHoldMs > 0 ? awayHoldMs : baseMs\n', 'never shorter than the base timeout', BROKER_TESTS],
  ['away-deadline-not-the-hold', LIB, '    const deadlineAt = requestedAt + hold.holdMs\n', '    const deadlineAt = requestedAt + this.deps.timeoutMs()\n', EXTENSION, BROKER_TESTS],
  ['away-flag-never-set', LIB, '    const awayHold = away\n', '    const awayHold = false\n', EXTENSION, BROKER_TESTS],
  ['away-default-not-600', LIB, 'export const AWAY_HOLD_DEFAULT_S = 600\n', 'export const AWAY_HOLD_DEFAULT_S = 300\n', 'COS_PERMISSION_BROKER_AWAY_HOLD_S: default 600', BROKER_TESTS],
  ['away-off-words', LIB, "  if (raw === '0' || raw === 'off' || raw === 'false') return 0\n  const parsed", "  if (raw === '0') return 0\n  const parsed", 'COS_PERMISSION_BROKER_AWAY_HOLD_S: default 600', BROKER_TESTS],
  ['away-not-clamped-to-600', LIB, '  return Math.round(Math.min(AWAY_HOLD_MAX_S, Math.max(AWAY_HOLD_MIN_S, seconds)) * 1000)', '  return Math.round(Math.max(AWAY_HOLD_MIN_S, seconds) * 1000)', 'COS_PERMISSION_BROKER_AWAY_HOLD_S: default 600', BROKER_TESTS],
  // 1. Recency counts only qualifying presence (the contract)
  ['away-needs-no-presence', LIB, '    const deviceAway = switchOn && ceilingAllowsAway && (askHold || presence.recent)\n', '    const deviceAway = switchOn && ceilingAllowsAway\n', 'no client ever (a Remote Control session with no glasses)', BROKER_TESTS],
  ['presence-window-ignored', LIB, '    const recent = ageMs !== null && ageMs <= windowMs\n', '    const recent = ageMs !== null\n', PRESENCE, BROKER_TESTS],
  ['presence-window-exclusive', LIB, '    const recent = ageMs !== null && ageMs <= windowMs\n', '    const recent = ageMs !== null && ageMs < windowMs\n', PRESENCE, BROKER_TESTS],
  ['presence-window-below-live', LIB, '    return Math.max(CLIENT_LIVE_WINDOW_MS, Number.isFinite(ms) && ms > 0 ? ms : 0)\n', '    return Number.isFinite(ms) && ms > 0 ? ms : 0\n', 'COS_PERMISSION_BROKER_AWAY_RECENT_CLIENT_S: default 1800', BROKER_TESTS],
  ['hold-poll-live-without-presence', LIB, 'holdLive: recent && this.polledWithin(holdPollAt, now), windowMs,', 'holdLive: this.polledWithin(holdPollAt, now), windowMs,', UNWORN, BROKER_TESTS],
  ['legacy-liveness-from-any-poll', LIB, '    return this.polledWithin(legacy ? legacy() : this.deps.lastQuestionsPollAt(), now)\n', '    return this.polledWithin(this.deps.lastQuestionsPollAt(), now)\n', UNWORN_ROUTE, BROKER_TESTS],
  ['hold-polls-count-as-legacy', LIVENESS, '  if (poll.hold !== true) {\n    lastLegacyPollAt = newerStamp(lastLegacyPollAt, at)\n    return\n  }\n', '  lastLegacyPollAt = newerStamp(lastLegacyPollAt, at)\n  if (poll.hold !== true) return\n', UNWORN_ROUTE, BROKER_TESTS],
  ['presence-range-unchecked', LIVENESS, "  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= PRESENCE_AGE_MAX_MS\n", "  return typeof value === 'number' && Number.isInteger(value) && value >= 0\n", 'only a hold=1 poll with valid presence records presence', BROKER_TESTS],
  ['presence-without-hold-parsed', ROUTE, '  return { hold, presenceAgeMs: hold && validPresenceAgeMs(parsed) ? parsed : null }\n', '  return { hold: hold || raw !== \'\', presenceAgeMs: validPresenceAgeMs(parsed) ? parsed : null }\n', 'parses the contract strictly', BROKER_TESTS],
  ['presence-parse-loose', ROUTE, '  const parsed = /^\\d{1,8}$/.test(raw) ? Number(raw) : Number.NaN\n', '  const parsed = Number(raw)\n', 'parses the contract strictly', BROKER_TESTS],
  // 2. Recency re-checked every tick
  ['tick-keeps-away-past-presence', LIB, "        : !item.askHold && (!item.awayHold || !presence.recent))\n", "        : !item.askHold && (!item.awayHold))\n", 'recency is re-checked every tick', BROKER_TESTS],
  ['quiet-client-settles-away', LIB, "        : !item.askHold && (!item.awayHold || !presence.recent))\n", "        : !item.askHold)\n", EXTENSION, BROKER_TESTS],
  ['desk-return-skipped-when-no-client', LIB, "        : !item.askHold && (!item.awayHold || !presence.recent))\n      if (this.pendingCount() === 0) return\n", "        : !item.askHold && (!item.awayHold || !presence.recent))\n      return\n", 'the desk-return handover: desk activity hands an away-held item to the Mac within one tick, with no client', BROKER_TESTS],
  ['tick-ignores-worn-client', LIB, '    if (!(this.clientLive(now) || presence.holdLive)) {\n', '    if (!this.clientLive(now)) {\n', 'a hold=1 client polling with recent presence counts as live', BROKER_TESTS],
  ['desk-active-at-arrival-held', LIB, "    if (!askHold && idle! < this.deskIdleThreshold()) return this.noteFastPath('desk_active'", "    if (false) return this.noteFastPath('desk_active'", 'at the desk when it arrives', BROKER_TESTS],
  // 3. Away semantics off when the ceiling is at or below the 6.59.0 clamp
  ['away-ignores-ceiling', LIB, '    const deviceAway = switchOn && ceilingAllowsAway && (askHold || presence.recent)\n', '    const deviceAway = switchOn && (askHold || presence.recent)\n', BEFORE_INSTALL, BROKER_TESTS],
  ['ceiling-floor-inclusive', LIB, 'ceilingAllowsAway: ceilingS > AWAY_MIN_CEILING_S }', 'ceilingAllowsAway: ceilingS >= AWAY_MIN_CEILING_S }', BEFORE_INSTALL, BROKER_TESTS],
  ['away-hold-now-ignores-ceiling', LIB, '    return hold.ceilingAllowsAway ? hold.holdMs : 0\n', '    return hold.holdMs\n', 'awayHoldNowMs and /api/models: 600 s with the 6.60.0 hook, 0 on the earlier hook', BROKER_TESTS],
  // The installed-timeout clamp, and 6. the unreadable-settings stamp fallback
  ['clamp-not-applied', LIB, 'holdMs: Math.min(wanted, ceilingS * 1000), awayHoldMs,', 'holdMs: wanted, awayHoldMs,', 'the installed-timeout clamp: the base hold of an earlier hook ends before its 125 s curl', BROKER_TESTS],
  ['ceiling-ignores-installed', LIB, '  return Math.max(0, Math.min(installedHookTimeoutS, stamped) - HOOK_REPLY_MARGIN_S)', '  return Math.max(0, stamped - HOOK_REPLY_MARGIN_S)', CEILING, BROKER_TESTS],
  ['ceiling-trusts-missing-stamp', LIB, '  const stamped = hasStamp ? hookWaitS! : LEGACY_HOOK_WAIT_S\n', '  const stamped = hasStamp ? hookWaitS! : installedHookTimeoutS\n', CEILING, BROKER_TESTS],
  ['ceiling-margin-5-reaches-curl', LIB, 'export const HOOK_REPLY_MARGIN_S = 10\n', 'export const HOOK_REPLY_MARGIN_S = 5\n', CEILING, BROKER_TESTS],
  ['ceiling-unreadable-ignores-stamp', LIB, '    return hasStamp ? Math.max(0, hookWaitS! - HOOK_REPLY_MARGIN_S) : BROKER_TIMEOUT_MAX_S\n', '    return BROKER_TIMEOUT_MAX_S\n', CEILING, BROKER_TESTS],
  ['ceiling-unreadable-unstamped-uncapped', LIB, '    return hasStamp ? Math.max(0, hookWaitS! - HOOK_REPLY_MARGIN_S) : BROKER_TIMEOUT_MAX_S\n', '    return hasStamp ? Math.max(0, hookWaitS! - HOOK_REPLY_MARGIN_S) : LEGACY_HOOK_WAIT_S\n', CEILING, BROKER_TESTS],
  ['stamp-range-unchecked', LIB, ' && wait > 0 && wait <= HOOK_WAIT_STAMP_MAX_S ? wait : null', ' && wait > 0 ? wait : null', "reads the hook's wait stamp only as a whole number", BROKER_TESTS],
  ['fallback-throw-unguarded', LIB, '    try { value = this.deps.installedHookTimeoutS?.() ?? null } catch { value = null }\n', '    value = this.deps.installedHookTimeoutS?.() ?? null\n', 'unreadable settings: a stamped request is bounded by its own stamp', BROKER_TESTS],
  ['fallback-junk-kept', LIB, "    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null\n", '    return value\n', 'unreadable settings: a stamped request is bounded by its own stamp', BROKER_TESTS],
  ['presence-junk-kept', LIB, "  return typeof ageMs === 'number' && Number.isFinite(ageMs) && ageMs >= 0 ? ageMs : null\n", '  return ageMs\n', 'an unreadable presence age or window is no presence', BROKER_TESTS],
  ['presence-throw-unguarded', LIB, '  try { ageMs = read() } catch { ageMs = null }\n', '  ageMs = read()\n', 'an unreadable presence age or window is no presence', BROKER_TESTS],
  // 5. Waiting at the Mac
  ['waiting-cleared-by-tool-name', LIB, '    if (strict) return fingerprint === item.fingerprint\n', '', 'waitingAtMac clears only by its own request', BROKER_TESTS],
  ['waiting-clear-not-strict', LIB, 'sessionMovedPast(item, env, toolName, fingerprint, true)) {', 'sessionMovedPast(item, env, toolName, fingerprint)) {', 'waitingAtMac clears only by its own request', BROKER_TESTS],
  ['waiting-never-clears', LIB, '        item.waitingAtMac = false\n        continue\n', '        continue\n', 'waitingAtMac clears only by its own request', BROKER_TESTS],
  ['waiting-when-not-written', LIB, '      item.waitingAtMac = written && MAC_DIALOG_RESOLUTIONS.has(resolution)\n', '      item.waitingAtMac = MAC_DIALOG_RESOLUTIONS.has(resolution)\n', 'a hand-back whose {} could not be written', BROKER_TESTS],
  ['dialog-up-set-shrunk', LIB, "new Set(['handed_to_desk', 'expired', 'no_client', 'drained'])", "new Set(['handed_to_desk', 'expired'])", 'no_client and drained also leave the Mac dialog up', BROKER_TESTS],
  ['row-ended-ignored', LIB, '} else if (item.waitingAtMac) { item.waitingAtMac = false; cleared++ }', '} else if (item.waitingAtMac) { cleared++ }', 'a session row that reads ended clears waitingAtMac at once', BROKER_TESTS],
  ['row-ended-not-signalled', RUNTIME, "  if (derived.agent_state === 'ended') {\n", '  if (false) {\n', 'tells its listeners when a row derives ended', RUNTIME_TESTS],
  ['waiting-listed-under-cap', LIB, '    const listed = [...waiting, ...others].sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0))\n', '    const listed = settled.slice(0, SETTLED_LIST_MAX)\n', 'every item the Mac still waits on is listed', BROKER_TESTS],
  ['waiting-kept-ten-minutes', LIB, '    return still ? MAC_WAIT_MAX_RETENTION_MS : MAC_WAIT_RETENTION_MS\n', '    return SETTLED_RETENTION_MS\n', FORGOT, BROKER_TESTS],
  ['still-waiting-ignored', LIB, '    return still ? MAC_WAIT_MAX_RETENTION_MS : MAC_WAIT_RETENTION_MS\n', '    return MAC_WAIT_RETENTION_MS\n', FORGOT, BROKER_TESTS],
  ['horizon-never-moves', LIB, '    if (item.waitingAtMac && item.settledAt !== null && item.settledAt > this.waitingForgottenBefore) this.waitingForgottenBefore = item.settledAt\n', '', FORGOT, BROKER_TESTS],
  ['horizon-moves-on-moved-past', LIB, '    if (item.waitingAtMac && item.settledAt !== null && item.settledAt > this.waitingForgottenBefore) this.waitingForgottenBefore = item.settledAt\n', '    if (item.settledAt !== null && item.settledAt > this.waitingForgottenBefore) this.waitingForgottenBefore = item.settledAt\n', FORGOT, BROKER_TESTS],
  ['route-no-server-started-at', ROUTE, '      serverStartedAt: deps.serverStartedAt ?? SERVER_STARTED_AT,\n', '', 'listed with every field', BROKER_TESTS],
  ['route-no-forgotten-before', ROUTE, '      waitingAtMacForgottenBefore: new Date(deps.broker.waitingAtMacForgottenBeforeMs()).toISOString(),\n', '', 'listed with every field', BROKER_TESTS],
  // 7. A sleep-safe presence age
  ['age-monotonic-only', LIVENESS, '  return Math.max(monoAge, wallAge)\n', '  return monoAge\n', AGE, BROKER_TESTS],
  ['age-wall-only', LIVENESS, '  return Math.max(monoAge, wallAge)\n', '  return Math.max(0, wallAge)\n', AGE, BROKER_TESTS],
  ['presence-moves-back', LIVENESS, '  if (lastPresenceMono === null || presenceMono > lastPresenceMono) lastPresenceMono = presenceMono\n', '  lastPresenceMono = presenceMono\n', AGE, BROKER_TESTS],
  ['restart-keeps-presence', LIVENESS, '  lastPresenceMono = null\n  lastPresenceWall = null\n  lastWebPresenceMono = null', '  lastPresenceWall = null\n  lastWebPresenceMono = null', AGE, BROKER_TESTS],
  // 8. Telemetry
  ['fast-path-not-logged', LIB, "    this.log(`fast path ${reason}", "    if (false) this.log(`fast path ${reason}", 'every fast path logs its reason', BROKER_TESTS],
  ['hold-log-presence-dropped', LIB, '      presenceAgeMs: presence.ageMs === null ? null : Math.round(presence.ageMs),\n', '', EXTENSION, BROKER_TESTS],
  // The hook and its installer
  ['installer-wait-130', INSTALLER, 'export const PERMISSION_HOOK_TIMEOUT_S = 630\n', 'export const PERMISSION_HOOK_TIMEOUT_S = 130\n', 'appends one canonical block per subscribed event', INSTALLER_TESTS],
  ['installer-no-wait-argument', INSTALLER, "  const command = hookCommand(scriptPath, sub.event, paths, sub.passTimeout ? sub.timeout : undefined)\n", '  const command = hookCommand(scriptPath, sub.event, paths)\n', 'appends one canonical block per subscribed event', INSTALLER_TESTS],
  ['installer-unreadable-reads-a-timeout', INSTALLER, 'priorWait: [], priorWaitOnly: false, permissionHookTimeoutS: null, tokenPresent }', 'priorWait: [], priorWaitOnly: false, permissionHookTimeoutS: 630, tokenPresent }', 'an unreadable or unparseable settings file reads no timeout', INSTALLER_TESTS],
  ['installer-timeout-any-type', INSTALLER, "      if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) return null\n", "      if (typeof timeout !== 'number') return null\n", 'reads our timeout only, the least of ours', INSTALLER_TESTS],
  ['installer-reads-foreign-timeout', INSTALLER, '      if (!hookIsOurs(h)) continue\n', '', 'reads our timeout only, the least of ours', INSTALLER_TESTS],
  ['prior-wait-not-halt-ready', INSTALLER, "  if (status.state === 'drift' && (status.priorWaitOnly === true || status.observerOnlyDrift === true)) {\n    return priorScript", "  if (false) {\n    return priorScript", 'an install from before 6.60.0 reads drift with priorWaitOnly, stays halt-ready', INSTALLER_TESTS],
  ['prior-wait-only-any-drift', INSTALLER, '\n    && events.drifted.every(event => events.priorWait.includes(event))', '', 'any other drift is not priorWaitOnly and not halt-ready', INSTALLER_TESTS],
  ['prior-wait-any-block', INSTALLER, '    if (prior && ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(prior)) priorWait.push(sub.event)', '    if (prior) priorWait.push(sub.event)', 'any other drift is not priorWaitOnly and not halt-ready', INSTALLER_TESTS],
  ['script-curl-not-from-wait', SCRIPT, '--max-time $((WAIT - 5))', '--max-time $((WAIT - 10))', 'curl gives up 5 s before the wait it was passed', SCRIPT_TESTS],
  ['script-no-stamp', SCRIPT, 'WAIT=$2; STAMP_WAIT=",\\"hookWaitS\\":$2"', "WAIT=$2; STAMP_WAIT=''", 'stamps the wait on the request as hookWaitS', SCRIPT_TESTS],
  ['script-leading-zero-taken', SCRIPT, "  case \"${2:-}\" in ''|0*|*[!0-9]*) ;; *)", "  case \"${2:-}\" in ''|*[!0-9]*) ;; *)", 'stamps the wait on the request as hookWaitS', SCRIPT_TESTS],
  // 6.99.26 QA round 1: COS Control Web's touch
  ['web-touch-admits-device-requests', LIB, '    const webOnly = !deviceAdmits && switchOn && ceilingAllowsAway && presence.webRecent\n', '    const webOnly = switchOn && ceilingAllowsAway && presence.webRecent\n', WEB_DEVICE, WEB_TESTS],
  ['web-stamped-at-desk-held', LIB, "    if (webOnly && idle! < this.deskIdleThreshold()) return this.noteFastPath('desk_active'", "    if (false) return this.noteFastPath('desk_active'", WEB_DESK, WEB_TESTS],
  ['web-stamped-unreadable-desk-held', LIB, "    if (webOnly && idle === null) return this.noteFastPath('desk_unknown')\n", '', WEB_DESK, WEB_TESTS],
  ['web-stamped-not-handed-back', LIB, "\n    this.settleAll('handed_to_desk', item => !item.askHold || item.webOnly)\n", "\n    this.settleAll('handed_to_desk', item => !item.askHold)\n", WEB_BACK, WEB_TESTS],
  ['web-stamped-desk-not-read', LIB, "(!item.askHold || !item.lensVisible || item.webOnly))) return", "(!item.askHold || !item.lensVisible))) return", WEB_BACK, WEB_TESTS],
  ['web-stamped-unreadable-twice-kept', LIB, "if (this.deskUnreadableStreak >= 2) this.settleAll('handed_to_desk', item => !item.askHold || item.webOnly)", "if (this.deskUnreadableStreak >= 2) this.settleAll('handed_to_desk', item => !item.askHold)", WEB_BACK, WEB_TESTS],
  ['web-extends-device-hold', LIB, "        : !item.askHold && (!item.awayHold || !presence.recent))\n", "        : !item.askHold && (!item.awayHold || !(presence.recent || presence.webRecent)))\n", WEB_DEVICE, WEB_TESTS],
  ['web-only-outlives-touch', LIB, "        ? !(presence.recent || presence.webRecent)\n", "        ? false\n", 'also ends when the touch goes stale with no client', WEB_TESTS],
  ['web-switch-ignored', LIB, '    try { webOn = this.deps.webAwayHold?.() !== false } catch { webOn = false }\n', '    webOn = true\n', 'COS_WEB_AWAY_HOLD=0 turns the web part off alone', WEB_TESTS],
  ['web-switch-word-ignored', LIB, "  return !(raw === '0' || raw === 'false' || raw === 'off')\n", "  return raw !== '0'\n", 'COS_WEB_AWAY_HOLD=0 turns the web part off alone', WEB_TESTS],
  ['web-hold-facts-on-device-holds', LIB, "      ...(webOnly ? { webOnly: true as const, webPresenceAgeMs: Math.round(presence.webAgeMs ?? 0) } : {}),\n", "      ...(presence.webAgeMs === null ? {} : { webOnly: true as const, webPresenceAgeMs: Math.round(presence.webAgeMs) }),\n", WEB_EVERY, WEB_TESTS],
  ['web-from-the-mac-counts', ROUTE, ' && !fromThisMac(req)) noteWeb(', ') noteWeb(', 'Control Web open on the Mac itself', WEB_TESTS],
  ['web-proxy-hop-is-the-mac', ROUTE, '  if (hasProxyForwardedHeaders(req.headers)) return false\n  const remote', '  const remote', 'loopback and the Mac', WEB_TESTS],
  ['web-own-address-not-the-mac', ROUTE, '  return own.includes(ip)\n', '  return false\n', 'loopback and the Mac', WEB_TESTS],
  ['script-term-leaves-curl', SCRIPT, "trap 'kill \"$CURL\" 2>/dev/null; rm -f \"$T.req\" \"$T.out\"; exit 0' TERM INT HUP\n", '', 'a TERM to the script stops its curl', SCRIPT_TESTS],
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const chosen = args.length ? mutations.filter(([name]) => args.includes(name)) : mutations
if (args.length && chosen.length !== args.length) throw new Error(`Unknown mutation name in: ${args.join(' ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'away-hold-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'bin'), join(scratch, 'bin'), { recursive: true })
  cpSync(join(root, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
  cpSync(join(root, 'managed-runtime-contract.json'), join(scratch, 'managed-runtime-contract.json'))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data') }, encoding: 'utf8', timeout: 300_000,
  })
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
    if (result.status === 0 || result.error || !killers.length) throw new Error(`Mutation survived or harness failed: ${name}\n${output.slice(-4000)}`)
    const killer = killers.find(line => line.includes(killerName))
    if (!killer) throw new Error(`Mutation ${name} was killed, but not by the test named for it ("${killerName}"): ${killers.join(' | ')}`)
    killed++
    console.log(`${name} KILLED by ${killer}`)
  }
  console.log(`${killed} of ${chosen.length} away-hold mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
