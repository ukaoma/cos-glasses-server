#!/usr/bin/env node
// Work orchestrator mutation gate (6.83.0). Mutations run only in a disposable copy of server/ and shared/; the live
// checkout is never rewritten. Same proof as the autonomous-save gate:
//   0. The target suites are GREEN unmutated (a gate over a red suite proves nothing).
//   1. Each target string appears EXACTLY ONCE in its file.  2. The mutated file differs.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or harness failure is not a kill.
//   4. The file is restored byte for byte before the next mutant.
// Usage: node server/scripts/work-orchestrator-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = [
  'server/lib/work-orchestrator/orchestrator.test.ts',
  'server/routes/work-orchestrator-snapshot.test.ts',
  'server/lib/work-orchestrator/usage.test.ts',
  'server/lib/work-orchestrator/hooks.test.ts',
  'server/routes/work-orchestrator.test.ts',
  'server/routes/work-chat.test.ts',
  'server/lib/work-chat.test.ts',
  'server/lib/claude-bridge-rate-limit-usage.test.ts',
  'server/lib/query-job-coordinator-usage-limit.test.ts',
  'server/lib/ask-work-plan.test.ts',
  'server/lib/work-orchestrator/plan-pane.test.ts',
  'server/web-control/plan-ruler-web.test.ts',
  'server/lib/work-orchestrator/cursor-plan.test.ts',
  'server/lib/work-orchestrator/usage-feed.test.ts',
]
const O = 'server/lib/work-orchestrator/'
const TG = O + 'tags.ts', RD = O + 'redact.ts', SL = O + 'session-log.ts', PK = O + 'pickup.ts', TI = O + 'tag-index.ts', DI = O + 'discovery.ts'
const IN = O + 'input.ts', SN = O + 'snapshot.ts', US = O + 'usage.ts', RT = O + 'runtime.ts', PL = O + 'plan-log.ts'
const WC = 'server/lib/work-chat.ts', WR = 'server/routes/work-chat.ts', OR = 'server/routes/work-orchestrator.ts'
const CB = 'server/lib/claude-bridge.ts', QC = 'server/lib/query-job-coordinator.ts', AW = 'server/lib/ask-work-plan.ts', UE = O + 'usage-events.ts', PP = O + 'plan-pane.ts', PR = 'server/web-control/panes/plan-ruler.js', APP = 'server/web-control/app.js', CP = O + 'cursor-plan.ts', UF = O + 'usage-feed.ts'
// Defense in depth that no test can reach on purpose, each with the guard that already stops the same outcome.
const EXPECTED_SURVIVORS = new Set([
  'tail-drops-partial-line',     // a row cut by the seek never parses (JSON.parse rejects it), so it is skipped either way
  'wc-modes-only-orchestrator',  // the key check refuses `mode` and `provider` from a non-orchestrator input first
])
const mutations = [
  // Tags.
  ['tag-task-identity', TG, "  if (parts.length === 3 && parts[0] === 'task' && TAG_HEX.test(parts[2]!)) return parts[2]!\n", ''],
  ['status-refuses-template', TG, "    if (evidence.length < 3 || evidence.startsWith('<')) continue\n", ''],
  ['prompt-needs-this-tag', TG, '  if (!TAG_HEX.test(tag)) return false\n  return new RegExp(`COS-WORK\\\\s+${tag}', '  if (!TAG_HEX.test(tag)) return false\n  return new RegExp(`COS-WORK\\\\s+[a-f0-9]{12}'],
  // Redaction.
  ['redact-emails', RD, "  [/\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b/g, '[email]'],\n", ''],
  ['redact-url-paths', RD, "  [/\\b(https?:\\/\\/[A-Za-z0-9.-]+(?::\\d+)?)(?:[/?#][^\\s)\\]\"'<>]*)/g, '$1/[path]'],\n", ''],
  ['redact-money', RD, "'[amount]'],\n", "'$&'],\n"],
  ['redact-secret-assign', RD, "  out = out.replace(SECRET_ASSIGN, '$1=[secret]')\n", ''],
  ['redact-shared-secrets', RD, '  let out = redactSecrets(text)\n', '  let out = text\n'],
  // The log tail and its turns.
  ['tail-seeks-from-end', SL, '  const start = Math.max(0, info.size - maxBytes)\n', '  const start = 0\n'],
  ['tail-drops-partial-line', SL, "    if (start > 0) { const nl = text.indexOf('\\n'); text = nl < 0 ? '' : text.slice(nl + 1) }\n", ''],
  ['turns-own-session-only', SL, "        if (want && typeof o.sessionId === 'string' && o.sessionId.toLowerCase() !== want) continue\n", ''],
  ['codex-guardian-kind', SL, "  if (sub && typeof sub === 'object' && sub.other === 'guardian') return { kind: 'guardian' }\n", ''],
  // Pick-up notes.
  ['pickup-skips-harness', PK, ' && !HARNESS.some(h => t.text.trimStart().startsWith(h)))', ')'],
  ['pickup-busy-overlay', PK, "  if (options.live?.busy) { state = 'running';", "  if (false) { state = 'running';"],
  ['pickup-bounded', PK, '  if (note.length > PICKUP_MAX_CHARS) note = note.slice(0, PICKUP_MAX_CHARS - 1)', '  if (false) note = note.slice(0, PICKUP_MAX_CHARS - 1)'],
  ['pickup-redacts', PK, "  const r = (s: string) => redactNote(s, options.home)\n", "  const r = (s: string) => s\n"],
  ['pickup-mid-turn', PK, "  let state: PickupNote['state'] = iUser > iReply ? 'mid_turn'", "  let state: PickupNote['state'] = false ? 'mid_turn'"],
  // The index.
  ['index-claude-own-session', TI, "  if (provider === 'claude' && typeof o.sessionId === 'string' && UUID.test(o.sessionId)) sid = 'claude:' + o.sessionId.toLowerCase()\n", ''],
  ['index-skips-sidechain', TI, '  if (o.isSidechain === true) return []\n', ''],
  ['index-status-kind', TI, "      if (status.has(tag)) kind = 'status'", "      if (false) kind = 'status'"],
  ['index-quoted-kind', TI, "      else if (b.role === 'user' && b.kind === 'text' && b.text.includes(HANDOFF_TEMPLATE)) kind = 'quoted'\n", ''],
  ['index-skips-guardian', TI, "            if (k.kind === 'guardian' || k.kind === 'other_child') entry.skip = k.kind", "            if (false) entry.skip = k.kind"],
  ['index-incremental', TI, '      if (info.size === entry.size && info.mtimeMs === entry.mtimeMs && entry.offset >= info.size) continue\n', ''],
  ['index-partial-line-carry', TI, '      carryStart += whole.length\n', '      carryStart += data.length\n'],
  ['index-dedupes-across-files', TI, "  hits(): TagHit[] { return mergeHits([], Object.values(this.doc.files).flatMap(e => e.skip ? [] : e.hits), Infinity) }", "  hits(): TagHit[] { return Object.values(this.doc.files).flatMap(e => e.skip ? [] : e.hits) }"],
  // Discovery.
  ['disc-fork-child-not-source', DI, '      const child = r.forkChildID ?? (r.sessionID && r.sessionID !== r.sourceSessionID ? r.sessionID : null)\n', '      const child = r.forkChildID ?? r.sessionID\n'],
  ['disc-status-alone-suggests', DI, "const MEMBER: ReadonlySet<Evidence> = new Set(['link', 'created', 'forked', 'continued', 'prompt'])", "const MEMBER: ReadonlySet<Evidence> = new Set(['link', 'created', 'forked', 'continued', 'prompt', 'status'])"],
  ['disc-newest-decides', DI, '      onAnotherCard: elsewhere !== null && here !== null && elsewhere > here })', '      onAnotherCard: false })'],
  ['disc-meeting-suggestion', DI, "      mine.set(sid, [...(mine.get(sid) ?? []), { kind: 'meeting', at }])\n", ''],
  ['disc-listed-rule', DI, "    for (const tag of tagsIn(row.summary)) add(tag, row.id, 'listed'", "    for (const tag of tagsIn(row.summary)) if (false) add(tag, row.id, 'listed'"],
  // The planner rows.
  ['input-cursor-reason', IN, "    if (provider === 'cursor') reason = 'cursor'\n", "    if (false) reason = 'cursor'\n"],
  ['input-plan-limit-reason', IN, "    else if (exhausted) reason = 'plan_limit'\n", ''],
  ['input-not-in-list-reason', IN, "    else if (!row) reason = 'not_in_session_list'\n", ''],
  ['input-app-owned-reason', IN, "    else if (row.appOwned) reason = 'app_owned'\n", ''],
  ['input-row-cap', IN, '  const kept = candidates.slice(0, ORCHESTRATOR_MAX_ROWS)\n', '  const kept = candidates\n'],
  ['input-members-first', IN, '  candidates.sort((a, b) => Number(b.s.member) - Number(a.s.member) || ', '  candidates.sort((a, b) => '],
  ['input-forkable-needs-log', IN, "      forkable: (provider === 'claude' || provider === 'codex') && !!path && !exhausted,", "      forkable: (provider === 'claude' || provider === 'codex') && !exhausted,"],
  ['input-live-freshness', IN, '  const liveFresh = !!snapshot?.live && now - snapshot.live.checkedAt * 1000 <= LIVE_FRESH_MS\n', '  const liveFresh = !!snapshot?.live\n'],
  ['input-skips-children', IN, "    if (deps.skipped?.has(s.id)) { leftOut.push({ id: s.id, title: '', reason: 'codex child thread (guardian or subagent)' }); continue }\n", ''],
  // The snapshot.
  ['snap-guardian-dropped', SN, "      if (isGuardianRow(id, r.title ?? '', r.summary ?? '')) continue\n", ''],
  ['snap-swift-epoch', SN, '(v < 1.5e9 ? v + 978_307_200 : v > 1e11 ? v / 1000 : v)', '(v > 1e11 ? v / 1000 : v)'],
  ['snap-version-gate', SN, "  if (!obj(v) || v.version !== SNAPSHOT_VERSION || ", "  if (!obj(v) || "],
  ['snap-short-id-skipped', SN, "      if (!id) { droppedLiveRows++; continue }\n", "      if (!id) throw new Error('invalid_live_row')\n"],
  ['snap-bad-text-skipped', SN, "      if (!str(r.title ?? '', 300) || !str(r.status ?? '', 100) || !str(r.summary ?? '', 2000)) { droppedLiveRows++; continue }\n", "      if (!str(r.title ?? '', 300) || !str(r.status ?? '', 100) || !str(r.summary ?? '', 2000)) throw new Error('invalid_live_row')\n"],
  ['snap-short-id-counted', SN, "      if (!id) { droppedLiveRows++; continue }\n", "      if (!id) { continue }\n"],
  ['snap-non-object-row-strict', SN, "      if (!obj(r)) throw new Error('invalid_live_row')\n", "      if (!obj(r)) continue\n"],
  ['snap-links-strict', SN, "    if (!obj(l) || !sid || !str(l.workID, 256) || !WORK_ID.test(l.workID) || at === null) throw new Error('invalid_link')\n", "    if (!obj(l) || !sid || !str(l.workID, 256) || !WORK_ID.test(l.workID) || at === null) continue\n"],
  ['snap-receipts-strict', SN, "      || !str(r.provider, 20) || !str(r.status, 40) || createdAt === null) throw new Error('invalid_receipt')\n", "      || !str(r.provider, 20) || !str(r.status, 40) || createdAt === null) continue\n"],
  // Usage.
  ['usage-claude-shape-check', US, "    if (!l || typeof l.kind !== 'string' || !num(l.percent) || l.percent < 0 || l.percent > 1000) return null\n", ''],
  ['usage-codex-allowed-gate', US, "  if (e.reading?.allowed === false) return { ...base, state: 'exhausted'", "  if (false) return { ...base, state: 'exhausted'"],
  ['usage-limit-beats-percent', US, '  if (e.limitUntil && e.limitUntil > now) {', '  if (false) {'],
  ['usage-binding-windows', US, "  claude: kind => kind === 'session' || kind === 'weekly_all',", "  claude: () => true,"],
  ['usage-breaker', US, '        if (e.failures >= USAGE_BREAKER_FAILURES) e.pausedUntil', '        if (false) e.pausedUntil'],
  ['usage-fresh-window', US, 'now - this.entries[p].observedAt! > maxAgeMs)', 'now - this.entries[p].observedAt! > -1)'],
  // 6.83.0 release: usage is read on demand; the timer is opt-in (COS_WORK_USAGE_POLL=1) and off by default.
  ['usage-poll-opt-in', US, "return env.COS_WORK_USAGE_POLL === '1' }", "return env.COS_WORK_USAGE_POLL !== '0' }"],
  ['usage-poll-gate', US, '    if (this.timer || !(this.options.pollEnabled ?? usagePollOptedIn(env))) return\n', '    if (this.timer) return\n'],
  // 7.0.45: onDemand gained `cursor` (only the plan ruler route reads Cursor); the reads it guards are unchanged.
  ['usage-on-demand-reads', US, 'async onDemand(refresh = false, cursor = false): Promise<UsageView[]> { await this.ensureFresh(refresh ? USAGE_FRESH_MS : USAGE_CACHE_MS, undefined, cursor); return this.views() }', 'async onDemand(refresh = false, cursor = false): Promise<UsageView[]> { return this.views() }'],
  ['usage-on-demand-cache', US, '(refresh ? USAGE_FRESH_MS : USAGE_CACHE_MS, undefined, cursor)', '(USAGE_FRESH_MS, undefined, cursor)'],
  ['usage-on-demand-refresh', US, ' ? USAGE_FRESH_MS : USAGE_CACHE_MS, undefined, cursor)', ' ? USAGE_CACHE_MS : USAGE_CACHE_MS, undefined, cursor)'],
  // 7.0.45: forPlan now also says "not Cursor" (Q1 21:13); the 2-minute age it guards is unchanged.
  ['usage-plan-fresh', US, 'async forPlan(): Promise<UsageView[]> { await this.ensureFresh(USAGE_FRESH_MS, undefined, false);', 'async forPlan(): Promise<UsageView[]> { await this.ensureFresh(USAGE_CACHE_MS, undefined, false);'],
  ['usage-cache-window', US, 'export const USAGE_CACHE_MS = 10 * 60_000\n', 'export const USAGE_CACHE_MS = 60 * 60_000\n'],
  // Target moved by eebd1737 (2026-11-05, Ask's proposals read cached usage): the plan path is now the ternary's live arm.
  ['runtime-input-reads-for-plan', RT, "? monitor.views() : await monitor.forPlan()\n", "? monitor.views() : monitor.views()\n"],
  ['route-usage-on-demand', OR, 'Promise<UsageView[]> => monitor.onDemand(refresh)', 'Promise<UsageView[]> => Promise.resolve(monitor.views())'],
  ['route-usage-refresh-param', OR, "usage: await deps.usage(req.query.refresh === '1')", 'usage: await deps.usage(false)'],
  ['usage-rejected-frame', US, "    if (info.status === 'rejected') {", "    if (false) {"],
  // 7.0.39 (U1): a window past its reset no longer counts; a warning holds only until its window resets.
  ['usage-window-live-rule', US, '  return Number.isNaN(t) || t > now\n', '  return true\n'],
  ['usage-window-boundary', US, '  return Number.isNaN(t) || t > now\n', '  return Number.isNaN(t) || t >= now\n'],
  ['usage-window-unparsable-live', US, '  return Number.isNaN(t) || t > now\n', '  return !Number.isNaN(t) && t > now\n'],
  ['usage-window-expiry-headroom', US, 'BINDING[provider](w.kind) && windowLive(w, now))', 'BINDING[provider](w.kind))'],
  ['usage-window-expiry-view', US, '  const bind = allBind.filter(w => windowLive(w, now))\n', '  const bind = allBind\n'],
  ['usage-window-ended-unknown', US, '  if (e.reading?.available && allBind.length && !bind.length) {', '  if (false) {'],
  ['usage-warning-expiry', US, "  const warned = e.warning && !(typeof e.warningUntil === 'number' && e.warningUntil <= now)\n", '  const warned = e.warning\n'],
  ['usage-warning-until-set', US, 'e.warningUntil = num(info.resetsAt) ? info.resetsAt * 1000 : null', 'e.warningUntil = null'],
  // 7.0.39 (U1): "limits available" with none is its own result, held 10 minutes across probes and restarts, logged once.
  ['usage-no-limits-classify', US, "  if (v && v.rate_limits_available === true && v.rate_limits == null) return { code: 'no_limits' }\n", ''],
  ['usage-no-limits-probe-code', US, "      else if (c.code === 'no_limits') finish(", "      else if (false) finish("],
  ['usage-failure-code', US, "const code: UsageFailureCode = error instanceof UsageProbeError ? error.code : 'error'", "const code: UsageFailureCode = 'error'"],
  ['usage-failure-hold-set', US, '        e.holdUntil = now + USAGE_FAILURE_HOLD_MS\n', ''],
  ['usage-hold-check', US, '    if (e.holdUntil && e.holdUntil > this.now()) return Promise.resolve()\n', ''],
  ['usage-failure-log', US, "        console.warn(`[work-orchestrator] usage probe ${p} failed: ${code}", "        void (`[work-orchestrator] usage probe ${p} failed: ${code}"],
  ['usage-failure-cleared', US, '        e.lastFailure = null; e.lastFailureAt = null; e.holdUntil = null\n', '        e.lastFailureAt = null; e.holdUntil = null\n'],
  ['usage-view-reason', US, 'reason: e.lastFailure ?? null,', 'reason: null,'],
  ['usage-view-last-good', US, 'lastGoodAt: e.observedAt ? new Date(e.observedAt).toISOString() : null', 'lastGoodAt: null'],
  ['usage-failure-text-safe', US, "\\d{1,3}$/.test(text) ? text : 'unexpected error'", '\\d{1,3}$/.test(text) ? text : text'],
  ['usage-failure-text-exited-exact', US, '/^exited (?:-?\\d+|on error) before answering$/', '/^exited /'],
  ['usage-failure-text-window-note', US, '`; last read failed: ${safeFailureText(e.lastError)}`', '`; last read failed: ${e.lastError}`'],
  // 7.0.39 (U1): the provider order Miles set (verified G2 turn 2026-11-14), one mutant per rule.
  ['po-default-first', US, ': [preference, other]\n', ': [other, preference]\n'],
  ['po-unknown-usable', US, "  const usable = (p: UsageProvider) => state(p) !== 'exhausted'\n", "  const usable = (p: UsageProvider) => state(p) === 'ok' || state(p) === 'low'\n"],
  ['po-low-swap', US, "  const lowSwap = usable(preference) && state(preference) === 'low' && state(other) === 'ok'\n", '  const lowSwap = false\n'],
  ['po-cursor-last', US, "{ provider: 'cursor', usable: false,", "{ provider: 'cursor', usable: true,"],
  ['po-answered-words', US, '    if (v?.answeredAt) return', '    if (false) return'],
  ['po-answered-hook', QC, "if (snapshot.status === 'completed') noteJobAnswered(", 'if (false) noteJobAnswered('],
  ['po-key-lane-not-answered', UE, '    if (lane || isProfilePreference(model)) return\n', ''],
  ['po-route-order', 'server/routes/work-chat.ts', 'body={...prompt, providerOrder:providerOrder(merged,deps.now())}', 'body={...prompt}'],
  ['po-route-answered-merge', 'server/routes/work-chat.ts', 'answeredAt:s?.answeredAt ?? null', 'answeredAt:null'],
  ['po-planner-rule', WC, 'a new session goes to the first usable provider in providerOrder that newSessionProviders offers', 'a new session goes to the provider with the most headroom'],
  ['ask-unknown-allowed', AW, "!evidence.usage.some(u => u.provider === provider && u.state === 'exhausted')", "evidence.usage.some(u => u.provider === provider && (u.state === 'ok' || u.state === 'low'))"],
  // 7.0.41 (U1): the plan ruler (plan-pane.ts), one mutant per rule.
  ['pp-failed-no-ruler', PP, "    return { ...base, ...none, state: 'failed',", "    return { ...base, usedPct: 0, gonePct: 0, windowStart: null, resetsAt: null, state: 'failed',"],
  ['pp-cursor-no-ruler', PP, "    return { ...base, ...none, state: 'no_plan',", "    return { ...base, usedPct: 0, gonePct: null, windowStart: null, resetsAt: null, state: 'no_plan',"],
  ['pp-ended-no-ruler', PP, '  const live = found && windowLive(found.w, now) && found.w.resetsAt ? found : null\n', '  const live = found && found.w.resetsAt ? found : null\n'],
  ['pp-limit-beats', PP, '  if (limitUntil) {\n', '  if (false) {\n'],
  ['pp-held-paused', PP, '  if (held > now) {\n', '  if (false) {\n'],
  ['pp-failure-before-reading', PP, '  if (e.lastFailure) {\n', '  if (false) {\n'],
  ['pp-older-25', PP, '  const older = !e.observedAt || now - e.observedAt > USAGE_STALE_MS\n', '  const older = false\n'],
  ['pp-estimate-12h', PP, 'if (elapsed < PLAN_ESTIMATE_MIN_ELAPSED_MS || usedPct <= 0', 'if (usedPct <= 0'],
  ['pp-closest', PP, '.sort((a, b) => b.usedPct! - a.usedPct!)', '.sort((a, b) => a.usedPct! - b.usedPct!)'],
  ['pp-claude-week', PP, "windows.find(x => x.kind === 'weekly_all')", "windows.find(x => x.kind === 'session')"],
  ['pp-failure-words', PP, "    case 'no_limits': return `refused by ${NAME[provider]}`\n", "    case 'no_limits': return 'unexpected error'\n"],
  ['pp-route-refresh', OR, "return res.json(await deps.plan(req.query.refresh === '1'))", 'return res.json(await deps.plan(true))'],
  ['pp-read-no-window', PP, '  if (e.reading && !found) {\n', '  if (false) {\n'],
  ['pp-live-no-reset', PP, '  if (found && windowLive(found.w, now) && !found.w.resetsAt) {\n', '  if (false) {\n'],
  // 7.0.41 (U1): the plan ruler on Control Web (panes/plan-ruler.js), one mutant per rule.
  ['pr-no-ruler-null', PR, "    if (line.usedPct === null || line.usedPct === undefined) return '';\n", ''],
  ['pr-closed-default', PR, "localStorage.getItem(KEY) === '1' : false", "localStorage.getItem(KEY) !== '1' : false"],
  ['pr-reading-hides', PR, "    if (S.loading) lead = '<span class=\"up-quietw\">Reading…</span>';\n", ''],
  // 7.0.54: the rows now pass through current() (an ended pause); what this guards is unchanged.
  ['pr-rows-reading-hidden', PR, '    var lines = p && !S.loading ? p.lines.map(', '    var lines = p ? p.lines.map('],
  ['pr-remember', PR, 'S.open = !S.open; saveOpen(S.open);', 'S.open = !S.open;'],
  ['pr-refresh-param', PR, "api('/api/usage/plan' + (refresh ? '?refresh=1' : '')", "api('/api/usage/plan' + ''"],
  ['pr-mount-top', PR, '    if (box.firstChild !== el) box.insertBefore(el, box.firstChild);\n', ''],
  ['pr-mount-leave', PR, '    if (!visible) { if (el.parentNode) el.parentNode.removeChild(el); return; }', '    if (!visible) { return; }'],
  ['pr-app-mount-after-paint', APP, '    if (wide) uDrawWide();\n    mountPlanRuler();\n', '    if (wide) uDrawWide();\n'],
  // Q1's survivors on e3c3bb9e (production_hardening/qa/q1_u1_e3c3bb9e_mutants.md), each now with its own test.
  ['q1-noreset-never-old', PP, 'const readLongAgo = !e.observedAt || now - e.observedAt > USAGE_STALE_MS', 'const readLongAgo = false'],
  ['q1-noreset-no-clamp', PP, 'const used = Math.max(0, Math.min(100, Math.round(found.w.usedPct)))\n    const readLongAgo', 'const used = Math.round(found.w.usedPct)\n    const readLongAgo'],
  ['q1-cursor-words-back', PP, "state: 'no_plan', windowWords: '',", "state: 'no_plan', windowWords: 'Cursor does not report its plan to COS',"],
  ['q1-open-always-refresh', APP, 'p.open(force === true); mountPlanRuler();', 'p.open(true); mountPlanRuler();'],
  ['q1-inflight-guard', PR, '    if (S.loading) return Promise.resolve();\n', ''],
  ['q1-mount-no-first-paint', PR, '    if (!el.innerHTML) paint();\n', ''],
  ['q1-refresh-not-disabled', PR, "'<button class=\"up-refresh\" type=\"button\"' + (S.loading ? ' disabled' : '') + '>", "'<button class=\"up-refresh\" type=\"button\"' + '>"],
  ['q1-no-focus-restore', PR, 'if (b) b.focus();', 'if (b) void b;'],
  ['q1-ruler-no-clamp', PR, 'Math.max(0, Math.min(100, Number(line.usedPct)))', 'Number(line.usedPct)'],
  ['q1-limit-fill', PR, "var fill = line.state === 'limit' ? 'var(--up-warn)'", "var fill = line.state === 'xlimit' ? 'var(--up-warn)'"],
  ['q1-bad-answer-shown', PR, 'S.pane = d && Array.isArray(d.lines) ? d : null;', 'S.pane = d || null;'],
  ['q1-fresh-while-loading', PR, 'if (p && p.readAt && !S.loading) fresh =', 'if (p && p.readAt) fresh ='],
  ['q1-est-fallback', PR, "if (!est) est = '<p class=\"up-quietw\">No estimate: '", "if (false) est = '<p class=\"up-quietw\">No estimate: '"],
  // Lead 13:00: Miles's open rule, killed by the execution test (real pane, renderUsageView, route and monitor).
  ['lead-pane-refresh-on-open', PR, "api('/api/usage/plan' + (refresh ? '?refresh=1' : '')", "api('/api/usage/plan' + '?refresh=1'"],
  ['lead-repaint-reads', PR, '    if (!el.innerHTML) paint();\n  }', '    if (!el.innerHTML) paint();\n    read(false);\n  }'],
  ['lead-open-reads-at-2-min', US, 'await this.ensureFresh(refresh ? USAGE_FRESH_MS : USAGE_CACHE_MS, undefined, cursor)', 'await this.ensureFresh(USAGE_FRESH_MS, undefined, cursor)'],
  ['lead-refresh-reads-at-10-min', US, 'await this.ensureFresh(refresh ? USAGE_FRESH_MS : USAGE_CACHE_MS, undefined, cursor)', 'await this.ensureFresh(USAGE_CACHE_MS, undefined, cursor)'],
  // 7.0.45 Cursor plan read (U1): each guard of cursor-plan.ts and its switch, proven by a named test.
  ["cur-switch-any-value", CP, "return env.COS_CURSOR_PLAN_USAGE === '1' }", "return !!env.COS_CURSOR_PLAN_USAGE }"],
  ["cur-monitor-refresh-ignores-switch", US, "    if (p === 'cursor' && !this.cursorPlanOn()) return Promise.resolve() // the switch is checked before anything else\n", ""],
  ["cur-view-off-uses-cache", US, "  if (e.provider === 'cursor' && !cursorOn) return", "  if (e.provider === 'cursor' && !e.reading) return"],
  ["cur-pane-off-draws", PP, "  if (e.provider === 'cursor' && !cursorOn) {", "  if (e.provider === 'cursor' && false) {"],
  ["cur-probe-ignores-switch", CP, "  if (!cursorPlanUsageOn(env)) throw new UsageProbeError('error', 'unexpected error') // never reached: the monitor checks first\n", ""],
  ["cur-keychain-env-leaks", CP, "  return { HOME: env.HOME ?? '', PATH: '/usr/bin:/bin' }", "  return { ...env, HOME: env.HOME ?? '', PATH: '/usr/bin:/bin' } as Record<string, string>"],
  ["cur-keychain-cancel-not-refused", CP, "  if (r.code === 51 || r.code === 128) throw", "  if (r.code === 51) throw"],
  ["cur-keychain-locked-unnamed", CP, "  if (r.code === 36) throw new UsageProbeError('keychain_locked', 'Keychain locked')\n", ""],
  ["cur-jwt-never-expires", CP, "claims.exp * 1000 <= nowMs", "claims.exp * 1000 <= 0"],
  ["cur-expired-still-calls", CP, "  if (jwtExpired(token, (deps.now ?? Date.now)())) throw new UsageProbeError('sign_in_expired', 'Cursor sign-in expired')\n", ""],
  ["cur-version-not-required", CP, "  if (!version) throw new UsageProbeError('not_found', 'Cursor CLI not found')\n", ""],
  ["cur-version-any-folder", CP, "return /^\\d{4}\\.\\d{1,2}\\.\\d{1,2}-[0-9a-f]{6,40}$/.test(v) ? v : null", "return v || null"],
  ["cur-allowlist-open", CP, "  if (!(CURSOR_READS as readonly string[]).includes(method)) throw new UsageProbeError('error', 'unexpected error')\n", ""],
  ["cur-redirect-followed", CP, "body: '{}', redirect: 'manual', signal })", "body: '{}', redirect: 'follow' as 'manual', signal })"],
  ["cur-redirect-status-ok", CP, "(reply.status >= 300 && reply.status < 400)", "false"],
  ["cur-403-not-expired", CP, "  if (reply.status === 401 || reply.status === 403) throw", "  if (reply.status === 401) throw"],
  ["cur-percent-over-100", CP, "return n === null || n < 0 || n > 100 ? 'bad' : n", "return n === null || n < 0 ? 'bad' : n"],
  ["cur-display-message-is-bar", CP, "const auto = percent(pu.autoPercentUsed),", "const auto = percent(Number(String(u.displayMessage ?? '').match(/\\d+/)?.[0] ?? pu.autoPercentUsed)),"],
  ["cur-binding-included", US, "  cursor: kind => kind === 'auto' || kind === 'api',", "  cursor: kind => kind === 'included',"],
  ["cur-grok-on-api", CP, "listed.includes(model) || /^grok/i.test(model) ? 'auto' : 'api'", "listed.includes(model) ? 'auto' : 'api'"],
  ["cur-network-text-kept", CP, "    throw new UsageProbeError('error', 'unexpected error') // a network error's own text is never kept\n", "    throw error\n"],
  ["cur-timeout-unnamed", CP, "    if (ctl.signal.aborted) throw new UsageProbeError('timed_out', 'timed out')\n", ""],
  ["cur-extras-required", CP, "    const planInfo = capped ? null : await cursorRead(fetchFn, 'GetPlanInfo', token, version, ctl.signal, cap).catch(() => null)", "    const planInfo = capped ? null : await cursorRead(fetchFn, 'GetPlanInfo', token, version, ctl.signal, cap)"],
  ["cur-pane-no-period-start-guess", PP, "  if (live.mins === 0) {", "  if (false) {"],
  // 7.0.54 Claude usage feed (U1, Miles 2026-11-17): the readers, the two rows, the ended pause, and Control Web.
  ["feed-percent-over-100", UF, "if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw", "if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw"],
  ["feed-file-not-owner-only", UF, "atomicWriteFileSync(feedPath('desktop', dir), JSON.stringify(out), { mode: 0o600 })", "atomicWriteFileSync(feedPath('desktop', dir), JSON.stringify(out), { mode: 0o644 })"],
  ["feed-size-cap-gone", UF, "if (statSync(path).size > MAX_FEED_BYTES) return", "if (statSync(path).size > MAX_FEED_BYTES * 1000) return"],
  ["feed-not-ok-accepted", UF, "  if (plan.status !== 'ok') throw", "  if (plan.status !== 'ok' && plan.status !== 'unavailable') throw"],
  ["feed-cli-older-wins", PP, "  if (!cli?.reading || Date.parse(cli.reading.at) <= (probe.observedAt ?? 0)) return probe", "  if (!cli?.reading) return probe"],
  ["feed-cli-limit-dropped", PP, "limitUntil: probe.limitUntil, limitSource: probe.limitSource,", "limitUntil: null, limitSource: null,"],
  ["feed-desktop-missing-silent", PP, "long: missing ? `No reading from Claude Desktop yet. ${DESKTOP_HOW}`", "long: missing ? 'Not read.'"],
  ["feed-desktop-says-refresh", PP, "long: `${line.long.replace(' Refresh to read it.', ` ${DESKTOP_HOW}`)}", "long: `${line.long}"],
  ["feed-desktop-no-extras", PP, "${extra.length ? ` Also ${extra.join(', ')}.` : ''}", "${''}"],
  ["feed-route-no-feeds", OR, "monitor.cursorPlanOn(), feeds())", "monitor.cursorPlanOn())"],
  ["pause-until-missing", PP, "    return { ...base, ...none, until: new Date(held).toISOString(), state: 'paused',", "    return { ...base, ...none, until: null, state: 'paused',"],
  ["pause-words-no-day", PP, "    const at = whenWords(new Date(held).toISOString(), now, tz).long\n", "    const at = timeOf(new Date(held), tz)\n"],
  ["web-ended-pause-current", PR, "|| Date.parse(line.until) > nowMs) return line;", "|| true) return line;"],
  ["web-read-no-day", PR, "    if (key(d) === key(n)) return clock(iso);\n", "    return clock(iso);\n"],
  ["web-colourless-row", PR, "function colorOf(provider) { return COLOR[provider] || 'var(--sub)'; }", "function colorOf(provider) { return COLOR[provider]; }"],
  ["web-others-stale", PR, "    if (!lines.some(function (l) { return current(l, now) !== l; })) return p.others;\n", "    return p.others;\n"],
  // Q1 07:38: the token-only door, the route's own cap, the time overflow, and its three survivors (U13, U14, U17).
  ["feed-cookie-writes", OR, "    if (res.locals?.[API_AUTH_BY_LOCAL] !== 'token') return res.status(403).json({ error: 'token_required' })\n", ""],
  ["feed-route-no-cap", OR, "    if (Buffer.byteLength(JSON.stringify(req.body ?? null)) > MAX_FEED_BYTES) return res.status(413).json({ error: 'reading_too_large' })\n", ""],
  ["feed-time-overflow", UF, "    if (ms > 8.64e15) throw new FeedError('bad_time')", "    if (false) throw new FeedError('bad_time')"],
  ["pause-limit-until-missing", PP, "    return { ...base, until: new Date(limitUntil).toISOString(), usedPct: 100,", "    return { ...base, until: null, usedPct: 100,"],
  ["web-closed-row-unguarded", PR, "      var top = current(p.closest && p.lines.filter(function (l) { return l.provider === p.closest; })[0], Date.now());", "      var top = p.closest && p.lines.filter(function (l) { return l.provider === p.closest; })[0];"],
  ["web-no-yesterday", PR, "    if (days === 1) return 'yesterday ' + clock(iso);\n", ""],
  ["web-limit-says-pause", PR, "    var what = line.state === 'limit' ? 'limit' : 'pause';", "    var what = 'pause';"],
  // 7.0.54 (lead 08:0x): an unrecognised usage reply logged by its key shape, never its values, capped.
  ["shape-not-logged", US, "${until > now ? `; next read after ${new Date(until).toISOString()}` : ''}${shape}`)", "${until > now ? `; next read after ${new Date(until).toISOString()}` : ''}`)"],
  ["shape-logs-values", US, "    return typeof v\n  }\n  const s = walk(value, 0)", "    return String(v)\n  }\n  const s = walk(value, 0)"],
  ["shape-odd-keys-shown", US, "${/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) ? k : '?'}", "${k}"],
  ["shape-uncapped", US, "return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s", "return s"],
  ["shape-on-every-failure", US, "error instanceof UsageProbeError && code === 'unknown_shape' && error.keyShape ?", "error instanceof UsageProbeError && error.keyShape ?"],
  ["shape-claude-not-attached", US, "'unknown get_usage shape', replyKeyShape(o.response.response))", "'unknown get_usage shape')"],
  ["shape-codex-not-attached", US, "'unknown rateLimits shape', replyKeyShape(o.result))", "'unknown rateLimits shape')"],
  // Q1 08:05: the walk's bounds (its three survivors S7, S8, S9) and the array depth and node budget it asked for.
  ["shape-keys-unbounded", US, "for (const k of keys.slice(0, 20)) {", "for (const k of keys.slice(0, 2000)) {"],
  ["shape-object-depth-unbounded", US, "      if (depth > 4) return '{\u2026}'", "      if (depth > 400) return '{\u2026}'"],
  ["shape-array-depth-unbounded", US, "      if (depth > 4) return '[\u2026]'", "      if (depth > 400) return '[\u2026]'"],
  ["shape-long-keys-shown", US, "/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k)", "/^[A-Za-z_][A-Za-z0-9_]{0,4000}$/.test(k)"],
  ["shape-keeps-reading-past-budget", US, "        if (nodes > max) { parts.push('\u2026'); break }", "        if (false) { parts.push('\u2026'); break }"],
  ["cur-refused-said-generically", PP, "  if (e.provider === 'cursor' && e.lastFailure === 'keychain_refused') {", "  if (false) {"],
  ["cur-refused-message-generic", CP, "throw new UsageProbeError('keychain_refused', \"Cursor's sign-in was not shared with COS\")", "throw new UsageProbeError('keychain_refused', 'Keychain read refused')"],
  ["cur-first-read-says-nothing", PP, "        : e.provider === 'cursor' ? CURSOR_FIRST_READ_WORDS : 'Not read yet. Refresh to read it.',", "        : 'Not read yet. Refresh to read it.',"],
  ["cur-copy-suggests-always", PP, "a \"security wants to use \u2026 cursor-access-token\" prompt and your login password. Refresh to read it.'", "a \"security wants to use \u2026 cursor-access-token\" prompt and your login password; choose Always Allow. Refresh to read it.'"],
  // Q1 21:13 (C1b, C17, C18, C21-C23, TLS, plan path, off state).
  ["cur-log-token-tail", CP, "  const token = await readCursorToken(deps.exec ?? realExec, env)\n", "  const token = await readCursorToken(deps.exec ?? realExec, env)\n  console.warn(`[cursor] ${token.slice(-8)} ${token.length}`)\n"],
  ["cur-cap-not-while-streaming", CP, "      if (total > MAX_REPLY_BYTES) { try { await reader.cancel() } catch { /* gone */ } throw tooBig() }\n", ""],
  ["cur-content-length-ignored", CP, "  if (Number.isFinite(stated) && stated > MAX_REPLY_BYTES) { try { await reply.body?.cancel() } catch { /* gone */ } throw tooBig() }\n", ""],
  ["cur-token-whitespace-ok", CP, "  if (!token || /\\s/.test(token)) throw", "  if (!token) throw"],
  ["cur-display-unbounded", CP, "short(u.displayMessage, 200)", "short(u.displayMessage, 100000)"],
  ["cur-models-unbounded", CP, ".filter((m: unknown): m is string => typeof m === 'string' && m.length <= 100).slice(0, 50)", ".filter((m: unknown): m is string => typeof m === 'string')"],
  ["cur-planname-unbounded", CP, "short(p?.planName, 60) ?? short(obj(p?.planInfo)?.planName, 60)", "short(p?.planName, 1000) ?? short(obj(p?.planInfo)?.planName, 1000)"],
  ["cur-tls-off-ignored", CP, "  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new UsageProbeError('tls_off', 'TLS checks are off on this Mac; Cursor was not read')\n", ""],
  ["cur-cap-no-abort", CP, "  const tooBig = () => { onCap(); return new UsageProbeError('unknown_shape', 'unknown Cursor usage shape') }", "  const tooBig = () => { return new UsageProbeError('unknown_shape', 'unknown Cursor usage shape') }"],
  ["cur-plan-reads-cursor", US, "await this.ensureFresh(USAGE_FRESH_MS, undefined, false)", "await this.ensureFresh(USAGE_FRESH_MS)"],
  ["cur-poll-reads-cursor", US, "    const tick = () => { void this.refresh('claude'); void this.refresh('codex') }", "    const tick = () => { void this.refresh('claude'); void this.refresh('codex'); void this.refresh('cursor') }"],
  ["cur-usage-route-reads-cursor", US, "  async onDemand(refresh = false, cursor = false): Promise<UsageView[]>", "  async onDemand(refresh = false, cursor = true): Promise<UsageView[]>"],
  ["cur-ruler-route-skips-cursor", OR, "  await monitor.onDemand(refresh, true) //", "  await monitor.onDemand(refresh) //"],
  ["cur-off-serves-plan-name", US, "{ ...base, plan: null, reason: null, lastGoodAt: null, ageSec: null, state: 'unknown',", "{ ...base, state: 'unknown',"],
  ['q1-escape-long', PR, "' + esc(l.long) + '</div></div>'", "' + l.long + '</div></div>'"],
  ['usage-codex-read-line', US, "      if (o.id === 1 && !done) { child.write(JSON.stringify({ method: 'initialized' })); child.write(JSON.stringify(CODEX_READ)); return }", "      if (o.id === 1 && !done) { child.write(JSON.stringify({ method: 'initialized' })); child.write(JSON.stringify({ ...CODEX_READ, params: { ...CODEX_READ.params, supportsLunaReserve: true } })); return }"],
  ['usage-probe-timeout-kills', US, "    const timer = setTimeout(() => { child.kill(); finish(new UsageProbeError('timed_out', 'timed out')) }, timeoutMs)\n    child.onLine(o => {\n      if (o.type !== 'control_response'", "    const timer = setTimeout(() => { finish(new UsageProbeError('timed_out', 'timed out')) }, timeoutMs)\n    child.onLine(o => {\n      if (o.type !== 'control_response'"],
  ['usage-limit-hook-key-lane', O + 'usage-events.ts', "    if (code !== 'provider_limit' || lane || isProfilePreference(model)) return\n", "    if (code !== 'provider_limit') return\n"],
  // The plan contract.
  ['wc-orchestrator-keys-gated', WC, "  const topKeys = ['workID','revision','question','context','sessions','history','updates','mode','planner','effort','items','references', ...(orchestrator ? ORCHESTRATOR_KEYS : [])]", "  const topKeys = ['workID','revision','question','context','sessions','history','updates','mode','planner','effort','items','references', ...ORCHESTRATOR_KEYS]"],
  ['wc-row-keys-gated', WC, '...(orchestrator ? ORCHESTRATOR_SESSION_KEYS : [])].includes(k))', '...ORCHESTRATOR_SESSION_KEYS].includes(k))'],
  ['wc-row-validated', WC, " || (orchestrator && !validOrchestratorRow(s))) throw new Error('invalid_session')", ") throw new Error('invalid_session')"],
  ['wc-top-validated', WC, "  if (orchestrator && !validOrchestratorTop(v)) throw new Error('invalid_orchestrator')\n", ''],
  ['wc-new-session-provider', WC, "      if ('sessionID' in a || !(input.newSessionProviders ?? []).includes(a.provider)) throw new Error('invalid_assignment')\n", ''],
  ['wc-fork-needs-forkable', WC, "(mode==='continue' ? !target.automatic : target.forkable!==true)", "(mode==='continue' ? !target.automatic : false)"],
  ['wc-modes-only-orchestrator', WC, "    const mode: WorkChatAssignmentMode=orchestrator && (a.mode==='fork' || a.mode==='newSession') ? a.mode : 'continue'", "    const mode: WorkChatAssignmentMode=(a.mode==='fork' || a.mode==='newSession') ? a.mode : 'continue'"],
  ['wr-rules-only-orchestrator', WR, "      const system=orchestrator ? WORK_CHAT_SYSTEM+'\\n\\n'+WORK_CHAT_ORCHESTRATOR_RULES : WORK_CHAT_SYSTEM", "      const system=WORK_CHAT_SYSTEM+'\\n\\n'+WORK_CHAT_ORCHESTRATOR_RULES"],
  ['wr-budget-only-orchestrator', WR, 'maxOutputTokens:orchestrator ? WORK_CHAT_ORCHESTRATOR_OUTPUT_TOKENS : WORK_CHAT_OUTPUT_TOKENS', 'maxOutputTokens:WORK_CHAT_ORCHESTRATOR_OUTPUT_TOKENS'],
  ['wr-every-plan-logged', WR, '      try { deps.planLog(planLogRow(input,outcome,answer,deps.now()-started)) } catch { /* observation only */ }\n', ''],
  ['wr-invalid-answer-outcome', WR, "      try { answer=parseWorkChatAnswer(out.text,input) } catch (e) { outcome='invalid_answer'; throw e }", "      answer=parseWorkChatAnswer(out.text,input)"],
  ['wr-log-left-out', WR, '    leftOut: (input.leftOut ?? []).map(l => ({ id: l.id, reason: l.reason })),', '    leftOut: [],'],
  // Target moved by 48450029 (2026-11-06, POST /work/orchestrator/snapshot added a second putSnapshot): this mutant was
  // written (4e64ffad, 2026-10-20) for the store inside POST /input, so it is anchored there.
  ['or-stores-snapshot', OR, '      deps.putSnapshot(snapshot)\n    }\n    try {\n      const input', '    }\n    try {\n      const input'],
  ['or-validates-snapshot', OR, "      try { ({ snapshot, droppedLiveRows } = parseSnapshotReport(body.snapshot, deps.now())) } catch (e) { return res.status(400).json({ error: 'invalid_snapshot', reason: (e as Error).message }) }", "      snapshot = body.snapshot as ControlSnapshot"],
  // 7.0.13: a live row Control cannot name is left out and counted; the count reaches both answers.
  ['or-input-reports-dropped', OR, "      return res.json(droppedLiveRows ? { ...input, droppedLiveRows } : input)", "      return res.json(input)"],
  ['or-snapshot-reports-dropped', OR, "        ...(droppedLiveRows ? { droppedLiveRows } : {}) })", " })"],
  // Hooks.
  ['bridge-rate-limit-frame', CB, '          if (!keyProfile) noteClaudeRateLimitFrame(event)\n', ''],
  ['boot-guard-in-tests', RT, "  if (env.VITEST || env.NODE_ENV === 'test') return\n", ''],
  ['coordinator-limit-hook', QC, "      noteJobProviderLimit(snapshot.provider, failure.code, error instanceof Error ? error.message : String((error as any)?.message ?? ''), active.request.model, snapshot.lane)\n", ''],
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const selected = names.length ? mutations.filter(([name]) => names.includes(name)) : mutations
if (names.length && selected.length !== names.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (args.includes('--check')) {
  let bad = 0
  for (const [name, file, find, replacement] of mutations) {
    const text = readFileSync(join(root, file), 'utf8'), count = text.split(find).length - 1
    if (count !== 1 || find === replacement) { bad++; console.log(`${name}: ${count} matches in ${file}${find === replacement ? ' (no change)' : ''}`) }
  }
  console.log(`${mutations.length - bad} of ${mutations.length} targets unique`); process.exit(bad ? 1 : 0)
}
const scratch = mkdtempSync(join(tmpdir(), 'work-orchestrator-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'bin'), join(scratch, 'bin'), { recursive: true })
  // 7.0.13: vitest.config.ts loads test-support/setup-data-home.ts; without it every baseline was red and the gate refused.
  cpSync(join(root, 'test-support'), join(scratch, 'test-support'), { recursive: true })
  cpSync(join(root, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = () => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch,
    env: { PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json'),
      COS_MAINTENANCE_GATE_PATH: join(scratch, 'gate', 'maintenance-gate.json') },
    encoding: 'utf8', timeout: 300000,
  })
  const baseline = run()
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  const totals = /Tests\s+(\d+) passed/.exec(baseline.stdout)
  console.log(`baseline PASS (${totals ? totals[1] : '?'} tests in ${tests.length} files)`)
  const survived = []
  for (const [name, file, find, replacement] of selected) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    if (original.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}`)
    // A function replacement: `$&` and `$1` in a mutant are literal text, never replace() patterns.
    const mutated = original.replace(find, () => replacement)
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    const result = run(), output = result.stdout + '\n' + result.stderr
    writeFileSync(target, original)
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    const killers = [...new Set([...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(m => m[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) {
      const expected = EXPECTED_SURVIVORS.has(name) && result.status === 0
      if (!expected) survived.push(name)
      console.log(`${name} ${expected ? 'SURVIVED (expected, documented)' : 'SURVIVED'}${result.error ? ' (harness: ' + result.error.message + ')' : ''}`); continue
    }
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  const expectedCount = selected.filter(([n]) => EXPECTED_SURVIVORS.has(n)).length
  console.log(`${selected.length - survived.length - expectedCount} of ${selected.length} work-orchestrator mutations killed by a named test; ${expectedCount} expected survivors`)
  if (survived.length) { console.log('SURVIVED: ' + survived.join(', ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
