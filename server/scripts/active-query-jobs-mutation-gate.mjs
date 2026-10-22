// Mutation gate for GET /api/query-jobs/active (6.84.1, docs/active-query-jobs.md). Not packaged.
// Usage: node server/scripts/active-query-jobs-mutation-gate.mjs [repo]
// Green baseline first (it refuses on any failure), then each mutant applied exactly once (a
// target that does not appear exactly once counts as a survivor), the two test files run, and
// the original restored byte for byte. Exit 1 when any mutant survives.
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const repo = process.argv[2] || process.cwd()
const tests = ['server/routes/query-jobs-active.test.ts', 'server/routes/health-query-jobs.test.ts', 'server/routes/welcome-context-calendar.test.ts']
const W = 'server/routes/welcome-context.ts'
const A = 'server/lib/query-job-active.ts', S = 'server/lib/query-job-store.ts', R = 'server/routes/query-jobs.ts', H = 'server/routes/health.ts', C = 'server/lib/query-job-coordinator.ts'
const mutants = [
  ['exclusion: drop the terminal-status skip', S, '      if (isTerminalQueryJobStatus(identity.status)) continue\n      const hydrated = this.jobs.get(identity.jobId)', '      const hydrated = this.jobs.get(identity.jobId)'],
  ['exclusion: invert the terminal-status skip', S, '      if (isTerminalQueryJobStatus(identity.status)) continue\n      const hydrated = this.jobs.get(identity.jobId)', '      if (!isTerminalQueryJobStatus(identity.status)) continue\n      const hydrated = this.jobs.get(identity.jobId)'],
  ['exclusion: unhydrated live job not counted', S, '        unlisted++\n', ''],
  ['count: drop unlisted from count', C, 'count: items.length + unlisted', 'count: items.length'],
  ['truncation: <= becomes <', A, '  if (chars.length <= max) return text', '  if (chars.length < max) return text'],
  ['truncation: no length check', A, '  if (chars.length <= max) return text\n', ''],
  ['truncation: keep max not max-1', A, '  const cut = chars.slice(0, max - 1)', '  const cut = chars.slice(0, max)'],
  ['truncation: no word break', A, '  const kept = (space >= (max - 1) / 2 ? cut.slice(0, space) : cut).join', '  const kept = cut.join'],
  ['truncation: no ellipsis', A, '  return `${kept}${ELLIPSIS}`', '  return kept'],
  ['truncation: code units not graphemes', A, '  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), part => part.segment) : Array.from(text)', '  return text.split(\'\')'],
  ['title: full prompt instead of first line', A, '    title: named || activeQueryJobTitle(request.query),', '    title: named || request.query,'],
  ['title: first line even when blank', A, '.find(candidate => candidate.trim().length > 0) ?? \'\'', '[0] ?? \'\''],
  ['title: no scan window', A, '  const head = query.slice(0, TITLE_SCAN_CHARS)', '  const head = query'],
  ['title: no redaction', A, '  return truncateActiveTitle(flattenDisplayText(redactQueryJobText(line)))', '  return truncateActiveTitle(flattenDisplayText(line))'],
  ['title: no flatten', A, '  return truncateActiveTitle(flattenDisplayText(redactQueryJobText(line)))', '  return truncateActiveTitle(redactQueryJobText(line))'],
  ['origin: person without a message number', A, "  if (typeof request.globalMsgNum === 'number' && request.globalMsgNum > 0) return { origin: 'person' }\n  return { origin: 'other' }", "  return { origin: 'person' }"],
  ['state: accepted reads running', A, "  if (status === 'accepted') return 'queued'\n", ''],
  ['route: list cap removed', R, '        items: items.slice(0, ACTIVE_QUERY_JOBS_LIST_MAX),', '        items,'],
  ['route: not registered', R, "  router.get('/query-jobs/active', (_req, res) => {", "  router.get('/query-jobs/active-disabled', (_req, res) => {"],
  ['sort: no oldest-first order', C, '    items.sort(compareActiveQueryJobs)\n', '    items.reverse()\n'],
  ['capability: not advertised', H, '    activeQueryJobs: true,\n', ''],
  // QA follow-up (6.84.1): the gaps the Activity home QA named.
  ['origin: no routine branch', A, "  if (request.origin?.kind === 'routine') return { origin: 'routine', originId: request.origin.id }\n", ''],
  ['origin: routine without originId', A, "return { origin: 'routine', originId: request.origin.id }", "return { origin: 'routine' }"],
  ['origin: no task branch', A, "  if (request.origin?.kind === 'task') return { origin: 'task', originId: request.origin.id }\n", ''],
  ['origin: task without originId', A, "return { origin: 'task', originId: request.origin.id }", "return { origin: 'task' }"],
  ['title: session name ignored', A, '    title: named || activeQueryJobTitle(request.query),', '    title: activeQueryJobTitle(request.query),'],
  ['title: session name not truncated', A, '  const named = request.sessionName ? truncateActiveTitle(flattenDisplayText(redactQueryJobText(request.sessionName))) : \'\'', '  const named = request.sessionName ?? \'\''],
  ['state: answer_ready reads running', A, "  if (status === 'answer_ready') return 'finishing'\n", ''],
  ['elapsed: no clamp at zero', A, 'Math.max(0, Math.round(nowMs - acceptedMs))', 'Math.round(nowMs - acceptedMs)'],
  ['elapsed: no finite guard', A, 'Number.isFinite(acceptedMs) ? Math.max(0, Math.round(nowMs - acceptedMs)) : 0', 'Math.max(0, Math.round(nowMs - acceptedMs))'],
  // welcome-context `calendarRead`.
  ['calendarRead: no bridge check', W, '  if (!bridgeReady) return false\n', ''],
  ['calendarRead: error answer counts as read', W, "  return !('error' in answer)", '  return true'],
  ['calendarRead: non-object answer counts as read', W, "  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false\n", ''],
  ['calendarRead: a thrown read counts as read', W, '    return { event: cachedNextEvent, read: false }', '    return { event: cachedNextEvent, read: true }'],
  ['calendarRead: cache hit always true', W, '    return { event: cachedNextEvent, read: cachedCalendarRead }', '    return { event: cachedNextEvent, read: true }'],
  ['calendarRead: cache keeps no flag', W, '    cachedCalendarRead = read\n', ''],
  ['calendarRead: not in the answer', W, '    calendarRead: calendar.read,\n', ''],
]

function run() {
  const r = spawnSync('npx', ['vitest', 'run', ...tests, '--reporter=json', '--outputFile=' + join(process.env.TMPDIR || '/tmp', 'active-gate.json')], { cwd: repo, encoding: 'utf8' })
  let summary = null
  try { summary = JSON.parse(readFileSync(join(process.env.TMPDIR || '/tmp', 'active-gate.json'), 'utf8')) } catch {}
  const failedNames = summary ? summary.testResults.flatMap(f => f.assertionResults.filter(a => a.status === 'failed').map(a => a.fullName)) : []
  return { code: r.status, total: summary?.numTotalTests ?? 0, failed: summary?.numFailedTests ?? -1, files: summary?.numTotalTestSuites, failedNames }
}

const base = run()
console.log(`baseline: exit ${base.code}, ${base.total} tests, ${base.failed} failed`)
if (base.code !== 0 || base.failed !== 0 || base.total === 0) { console.log('REFUSING: baseline not green'); process.exit(2) }
let killed = 0, survived = 0
for (const [name, file, from, to] of mutants) {
  const path = join(repo, file)
  const original = readFileSync(path, 'utf8')
  const hits = original.split(from).length - 1
  if (hits !== 1) { console.log(`BAD TARGET (${hits} hits): ${name}`); survived++; continue }
  writeFileSync(path, original.replace(from, to))
  try {
    if (readFileSync(path, 'utf8') === original) throw new Error('mutation did not land')
    const r = run()
    if (r.code !== 0 && r.failed > 0) { killed++; console.log(`killed   ${name}  <- ${r.failedNames.slice(0, 2).join(' | ')}`) }
    else if (r.code !== 0) { killed++; console.log(`killed?  ${name} (exit ${r.code}, failed ${r.failed}: compile or collect error)`) }
    else { survived++; console.log(`SURVIVED ${name}`) }
  } finally {
    writeFileSync(path, original)
  }
}
console.log(`mutants: ${mutants.length}, killed ${killed}, survived ${survived}`)
const after = run()
console.log(`post-restore: exit ${after.code}, ${after.total} tests, ${after.failed} failed`)
if (survived > 0 || after.code !== 0) process.exit(1)
