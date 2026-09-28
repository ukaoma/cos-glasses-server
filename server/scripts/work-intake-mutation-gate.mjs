#!/usr/bin/env node
// Work intake mutation gate. Mutations run only in a disposable copy of server/ and shared/; the live checkout
// (which a candidate may be running) is never rewritten. Each mutant must fail a named assertion.
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const scratch = mkdtempSync(join(tmpdir(), 'work-intake-mutations-'))
const tests = ['server/lib/work-intake-store.test.ts', 'server/routes/work-intake.test.ts', 'server/lib/task-store-intake.test.ts',
  'server/lib/jev.test.ts', 'server/lib/session-recommendation.test.ts', 'server/routes/jev.test.ts']
const STORE = 'server/lib/work-intake-store.ts', ROUTE = 'server/routes/work-intake.ts', TASKS = 'server/lib/task-store.ts'
const JEV = 'server/lib/jev.ts', REC = 'server/lib/session-recommendation.ts', JEV_ROUTE = 'server/routes/jev.ts'
const mutations = [
  ['per-item-rejection', STORE, "result.rejected.push({ id, code: e instanceof WorkIntakeError ? e.code : 'invalid_intake_item' })", 'throw e'],
  ['producer-cannot-decide-for-user', STORE, "if (item.resolution?.by === 'user') throw new WorkIntakeError('producer_cannot_record_user_decisions', 400)", ''],
  ['known-reasons-only', STORE, "typeof r.reason === 'string' && REASONS.has(r.reason)", "typeof r.reason === 'string'"],
  ['user-decision-sticky', STORE, "if (prior.resolution?.by === 'user' || (prior.status === 'accepted' && item.status !== 'accepted'))", "if (prior.status === 'accepted' && item.status !== 'accepted')"],
  ['per-item-busy', STORE, "if (this.busy.has(id)) throw new WorkIntakeError('intake_busy', 409)", ''],
  ['retention-window', STORE, 'Date.parse(r.updatedAt) >= cutoff', 'true'],
  ['capability-before-meeting', ROUTE, "if (item.kind === 'ask' && !capabilities.cardCreation) throw new WorkIntakeError('card_creation_unavailable', 409)", ''],
  ['from-owner-on-card', ROUTE, 'if (item.ownerIsMiles || !owner) return text', 'return text'],
  ['open-collision-links', ROUTE, 'if (!out.checked && !out.archived && !out.delegated) return linkRow(meeting.domain, r => r.id === out.id, meeting)', ''],
  ['race-retry-bound', ROUTE, 'attempt < LINK_RACE_RETRIES &&', 'attempt < LINK_RACE_RETRIES + 1 &&'],
  ['meeting-identity', ROUTE, "if (resolved.recordId !== m.recordId) throw new WorkIntakeError('meeting_identity_changed', 409)", ''],
  ['eight-links-cap', ROUTE, "if (refs.length >= MAX_MEETING_REFS) throw new WorkIntakeError('meeting_links_full', 409)", ''],
  ['unexpected-failure-logged', ROUTE, "console.error(`[work-intake] ${where} failed:`, e instanceof Error ? e.message : e)", ''],
  ['capture-capability', TASKS, 'cardCreation: value?.version === 1 && value?.captureWork === 1', 'cardCreation: value?.version === 1'],
  ['capture-answer-shape', TASKS, "typeof out.created !== 'boolean' || ", ''],
  ['bridge-failure-is-not-old-server', ROUTE, "if (capabilities.bridgeUnavailable) throw new WorkIntakeError('task_bridge_unavailable', 503)", ''],
  ['malformed-pull-dropped', STORE, "p && p.kind === 'session' && pid", "p && pid"],
  ['jev-env-key-used', JEV, "if (env) return { key: env, source: 'env' }", ''],
  ['jev-saved-key-wins', JEV, "if (file) return { key: file.key, source: 'config'", "if (file && !process.env.TYPESAFE_API_KEY) return { key: file.key, source: 'config'"],
  ['jev-env-quotes-stripped', JEV, "process.env.TYPESAFE_API_KEY?.trim().replace(/^[\"']|[\"']$/g, '')", 'process.env.TYPESAFE_API_KEY?.trim()'],
  ['jev-reset-clears-breaker', JEV, 'resetForNewKey(): void { this.failures = 0; this.breakerUntil = 0; this.lastError = null }', 'resetForNewKey(): void { this.failures = 0 }'],
  ['jev-new-key-resets-breaker', JEV_ROUTE, '    deps.jev.resetForNewKey()\n', ''],
  ['fork-needs-none', REC, "if (typeof best.none !== 'number' || !Number.isFinite(best.none)) throw new JevError('jev_bad_answer', 'Jev left out none')", ''],
  ['fork-forkable-only', REC, 'p > 0 && FORKABLE.has(sessions[Number(k.slice(1))].provider)', 'p > 0'],
  ['fork-confidence-own', REC, 'confidence: round(forkP)', 'confidence: round(covered)'],
  ['work-identity-first', JEV_ROUTE, 'rows.find(r => r.workIdentity === body.id) ?? rows.find(r => r.id === body.id)', 'rows.find(r => r.id === body.id || r.workIdentity === body.id)'],
  ['jev-cap-before-send', JEV, "if (this.usedToday() + estimate > dailyCap()) this.fail('jev_cap_reached', false)", ''],
  ['jev-breaker-opens', JEV, 'if (countsTowardBreaker && ++this.failures >= JEV_LIMITS.breakerFailures) {', 'if (false) {'],
  ['jev-rejected-not-counted', JEV, "return this.fail('jev_request_rejected', false)", "return this.fail('jev_request_rejected', true)"],
  ['jev-usage-recorded', JEV, '    this.record(used)\n', ''],
  ['jev-pinned-model', JEV, 'model: JEV_MODEL, questions', "model: 'jev-latest', questions"],
  ['continue-threshold', REC, 'exactP >= CONTINUE_AT', 'exactP > CONTINUE_AT'],
  ['fork-threshold', REC, 'covered >= FORK_AT', 'covered > FORK_AT'],
  ['unoffered-session-refused', REC, "if (rows.some(([k]) => !offered.has(k))) throw new JevError('jev_bad_answer', 'Jev chose a session that was not offered')", ''],
  ['recommendation-cache', REC, 'if (hit && this.now() - hit.at < RECOMMENDATION_LIMITS.cacheMs) return { ...hit.value, cached: true }', ''],
  ['key-validated-before-save', JEV_ROUTE, 'if (!check.ok) return res.status(400)', 'if (false) return res.status(400)'],
  ['board-text-not-client-text', JEV_ROUTE, "Object.keys(body).some(k => !['domain', 'id', 'sessions'].includes(k))", 'false'],
]
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = () => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data') }, encoding: 'utf8', timeout: 180000,
  })
  const baseline = run()
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  console.log('baseline PASS')
  for (const [name, file, find, replacement] of mutations) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    if (original.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}`)
    writeFileSync(target, original.replace(find, replacement))
    const result = run(), output = result.stdout + '\n' + result.stderr
    writeFileSync(target, original)
    // A kill must be attributed to a named failing test (an assertion, or an unexpected throw inside a named test).
    // QA 2026-09-28: only a NAMED failing test counts ("FAIL  server/x.test.ts > name"). The old pattern also took
    // "expected", which a transform error prints ("Expected ';'"), so a mutant that broke the build read as killed.
    if (result.status === 0 || result.error || !/FAIL\s+server\/\S+\.test\.ts > /.test(output)) throw new Error(`Mutation survived or harness failed: ${name}\n${output}`)
    console.log(`${name} KILLED`)
  }
  console.log(`${mutations.length} of ${mutations.length} work-intake mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
