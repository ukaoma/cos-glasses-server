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
  'server/lib/work-orchestrator/usage.test.ts',
  'server/lib/work-orchestrator/hooks.test.ts',
  'server/routes/work-orchestrator.test.ts',
  'server/routes/work-chat.test.ts',
  'server/lib/work-chat.test.ts',
  'server/lib/claude-bridge-rate-limit-usage.test.ts',
  'server/lib/query-job-coordinator-usage-limit.test.ts',
]
const O = 'server/lib/work-orchestrator/'
const TG = O + 'tags.ts', RD = O + 'redact.ts', SL = O + 'session-log.ts', PK = O + 'pickup.ts', TI = O + 'tag-index.ts', DI = O + 'discovery.ts'
const IN = O + 'input.ts', SN = O + 'snapshot.ts', US = O + 'usage.ts', RT = O + 'runtime.ts', PL = O + 'plan-log.ts'
const WC = 'server/lib/work-chat.ts', WR = 'server/routes/work-chat.ts', OR = 'server/routes/work-orchestrator.ts'
const CB = 'server/lib/claude-bridge.ts', QC = 'server/lib/query-job-coordinator.ts'
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
  // Usage.
  ['usage-claude-shape-check', US, "    if (!l || typeof l.kind !== 'string' || !num(l.percent) || l.percent < 0 || l.percent > 1000) return null\n", ''],
  ['usage-codex-allowed-gate', US, "  if (e.reading?.allowed === false) return { ...base, state: 'exhausted'", "  if (false) return { ...base, state: 'exhausted'"],
  ['usage-limit-beats-percent', US, '  if (e.limitUntil && e.limitUntil > now) {', '  if (false) {'],
  ['usage-binding-windows', US, "  claude: kind => kind === 'session' || kind === 'weekly_all',", "  claude: () => true,"],
  ['usage-breaker', US, '        if (e.failures >= USAGE_BREAKER_FAILURES) {', '        if (false) {'],
  ['usage-fresh-window', US, 'now - this.entries[p].observedAt! > USAGE_FRESH_MS)', 'now - this.entries[p].observedAt! > -1)'],
  ['usage-poll-switch', US, "    if (this.timer || this.options.pollEnabled === false || process.env.COS_WORK_USAGE_POLL === '0') return\n", "    if (this.timer || this.options.pollEnabled === false) return\n"],
  ['usage-rejected-frame', US, "    if (info.status === 'rejected') {", "    if (false) {"],
  ['usage-codex-read-line', US, "      if (o.id === 1 && !done) { child.write(JSON.stringify({ method: 'initialized' })); child.write(JSON.stringify(CODEX_READ)); return }", "      if (o.id === 1 && !done) { child.write(JSON.stringify({ method: 'initialized' })); child.write(JSON.stringify({ ...CODEX_READ, params: { ...CODEX_READ.params, supportsLunaReserve: true } })); return }"],
  ['usage-probe-timeout-kills', US, "    const timer = setTimeout(() => { child.kill(); finish(new Error('timed out')) }, timeoutMs)\n    child.onLine(o => {\n      if (o.type !== 'control_response'", "    const timer = setTimeout(() => { finish(new Error('timed out')) }, timeoutMs)\n    child.onLine(o => {\n      if (o.type !== 'control_response'"],
  ['usage-limit-hook-key-lane', RT, "    if (code !== 'provider_limit' || lane || isProfilePreference(model)) return\n", "    if (code !== 'provider_limit') return\n"],
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
  ['or-stores-snapshot', OR, '      deps.putSnapshot(snapshot)\n', ''],
  ['or-validates-snapshot', OR, "      try { snapshot = parseSnapshot(body.snapshot, deps.now()) } catch (e) { return res.status(400).json({ error: 'invalid_snapshot', reason: (e as Error).message }) }", "      snapshot = body.snapshot as ControlSnapshot"],
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
