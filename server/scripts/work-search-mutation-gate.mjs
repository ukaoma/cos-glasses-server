#!/usr/bin/env node
// Work search and task dates mutation gate (6.65.0). Mutations run only in a disposable copy of server/ and shared/;
// the live checkout (which a candidate may be running) is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/work-search-mutation-gate.mjs [--list] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = ['server/lib/work-search.test.ts', 'server/routes/work-search.test.ts', 'server/lib/task-dates.test.ts',
  'server/routes/tasks-dates.test.ts', 'server/routes/work-board.test.ts', 'server/lib/jev.test.ts', 'server/routes/jev.test.ts']
const SEARCH = 'server/lib/work-search.ts', ROUTE = 'server/routes/work-search.ts', JEV = 'server/lib/jev.ts', JEV_ROUTE = 'server/routes/jev.ts'
const DATES = 'server/lib/task-dates.ts', STORE = 'server/lib/task-store.ts', TASKS = 'server/routes/tasks.ts', BOARD = 'server/routes/work-board.ts'
const mutations = [
  // Cost controls: the cap, the switch, the breaker.
  ['search-own-cap', SEARCH, 'return new JevClient(fetchImpl, now, usageFile, workSearchDailyCap)', 'return new JevClient(fetchImpl, now, usageFile)'],
  ['search-own-ledger', SEARCH, "export const WORK_SEARCH_USAGE_FILE = dataPath('jev-search-usage.json')", "export const WORK_SEARCH_USAGE_FILE = dataPath('jev-usage.json')"],
  ['cap-checked-before-send', JEV, "if (this.usedToday() + estimate > this.cap()) this.fail('jev_cap_reached', false)", ''],
  ['switch-off-refuses', ROUTE, "    if (!deps.enabled()) return res.json(unavailable('search_off'))\n", ''],
  ['switch-zero-is-off', SEARCH, "!['0', 'false', 'no', 'off'].includes(", "!['false', 'no', 'off'].includes("],
  ['breaker-checked', JEV, "if (this.breakerUntil > this.now().getTime()) throw new JevError('jev_breaker_open')", ''],
  ['breaker-reason-kept', SEARCH, " || e.code === 'jev_breaker_open') return unavailable(e.code)", ') return unavailable(e.code)'],
  ['new-key-clears-search-breaker', JEV_ROUTE, '    deps.searchJev.resetForNewKey()\n', ''],
  // At most 254 cards, refused rather than cut.
  ['too-many-ids-refused', ROUTE, "if (ids && ids.length > WORK_SEARCH_LIMITS.maxCandidates) return res.json(unavailable('too_many_candidates'))", ''],
  ['too-many-cards-refused', SEARCH, 'return picked.length > WORK_SEARCH_LIMITS.maxCandidates ? null : picked', 'return picked'],
  ['searcher-refuses-too-many', SEARCH, "if (candidates.length > WORK_SEARCH_LIMITS.maxCandidates) return unavailable('too_many_candidates')", ''],
  // Ranking.
  ['p-floor', SEARCH, 'if (p >= WORK_SEARCH_LIMITS.minP) results.push', 'if (true) results.push'],
  ['twenty-hits', SEARCH, 'results.slice(0, WORK_SEARCH_LIMITS.maxResults)', 'results'],
  ['most-likely-first', SEARCH, '  results.sort((a, b) => b.p - a.p)\n', ''],
  ['probabilities-required', SEARCH, "if (!probabilities || typeof probabilities !== 'object') throw new JevError('jev_bad_answer', 'Jev returned no probabilities')", ''],
  ['probability-in-range', SEARCH, 'if (Number.isNaN(p) || p < 0 || p > 1) throw', 'if (false) throw'],
  ['search-failure-is-advice', ROUTE, "      return res.json(unavailable('jev_unavailable'))", "      return res.status(500).json(unavailable('jev_unavailable'))"],
  ['offered-cards-only', SEARCH, "if (index < 0 || index >= ids.length) throw new JevError('jev_bad_answer', 'Jev chose a card that was not offered')", ''],
  // What Jev reads, and which cards.
  ['work-details-stripped', SEARCH, ".replace(/\\[Work details\\]\\([^)]*\\)/gi, ' ')", ''],
  ['option-300-chars', SEARCH, '.slice(0, WORK_SEARCH_LIMITS.optionChars)', ''],
  ['completed-scope', SEARCH, 'picked = rows.filter(row => row.checked && inDomain(row))', 'picked = rows.filter(row => inDomain(row))'],
  ['all-work-open-only', SEARCH, '    picked = rows.filter(row => !row.checked)\n', '    picked = rows.slice()\n'],
  ['ids-match-identity', SEARCH, 'wanted.has(row.id) || (!!row.workIdentity && wanted.has(row.workIdentity))', 'wanted.has(row.id)'],
  ['no-client-text', ROUTE, 'Object.keys(body).some(k => !BODY_KEYS.has(k))', 'false'],
  ['query-minimum', ROUTE, 'query.length < WORK_SEARCH_LIMITS.queryMin || ', ''],
  // Cache.
  ['cache-ten-minutes', SEARCH, 'if (hit && this.now() - hit.at < WORK_SEARCH_LIMITS.cacheMs) {', 'if (hit) {'],
  ['cache-keyed-by-cards', SEARCH, "normalizeQuery(query) + '\\0' + set", 'normalizeQuery(query)'],
  ['cache-200-entries', SEARCH, 'if (this.cache.size >= WORK_SEARCH_LIMITS.cacheEntries) this.cache.delete(this.cache.keys().next().value!)', ''],
  // Dates.
  ['source-date-first', DATES, '      if (fromSource) continue\n', ''],
  ['uncommitted-line-null', DATES, "const committed = !/^0+$/.test(current.sha) && current.time !== null", 'const committed = current.time !== null'],
  ['label-not-link-target', DATES, "const label = source.replace(/\\[([^\\]]*)\\]\\([^)]*\\)/g, '$1')", 'const label = source'],
  ['real-calendar-day', DATES, 'if (isCalendarDay(match[0])) return match[0]', 'return match[0]'],
  ['no-repo-no-git', DATES, '    if (!this.findRepo(dir)) return null\n', ''],
  ['untracked-no-git', DATES, 'return lines ? { file, dir, head, lines } : null', 'return { file, dir, head, lines: lines ?? new Map() }'],
  ['line-still-holds-task', DATES, 'if (line && lineHolds(line.content, row.description)) fields.lineChangedAt = line.at', 'if (line) fields.lineChangedAt = line.at'],
  ['blame-cached', DATES, 'if (!entry || entry.key !== key) {', 'if (true) {'],
  ['blame-key-file-state', DATES, '`${head}|${stat.mtimeMs}|${stat.size}`', '`${head}`'],
  ['absent-retried-after-head-moves', DATES, "return entry.h === head ? null : undefined", 'return null'],
  ['absent-not-retried-at-same-head', DATES, "return entry.h === head ? null : undefined", 'return undefined'],
  ['first-appearance', DATES, "['log', '--reverse', '--format=%ad'", "['log', '--format=%ad'"],
  ['budget-stops-new-lookups', DATES, 'while (next < jobs.length && this.now() < deadline)', 'while (next < jobs.length)'],
  ['budget-answers-on-time', DATES, 'try { await Promise.race([all, budget]) }', 'try { await all }'],
  ['disk-cache-read', DATES, "if (typeof entry?.d === 'string' && isCalendarDay(entry.d)) this.created.set(key, { d: entry.d })", 'if (false) this.created.set(key, { d: entry.d! })'],
  ['route-serves-dates', TASKS, 'const rows = await listBoardWithDates(column)', 'const rows = await listBoard(column)'],
  ['dating-never-fails-board', STORE, "  try { dates = await resolver.resolve(pairs.map(pair => pair.source), taskOperationsRoot()) } catch (e) {\n    console.warn('[tasks] dates unavailable:', e instanceof Error ? e.message : e)\n  }",
    '  dates = await resolver.resolve(pairs.map(pair => pair.source), taskOperationsRoot())'],
  ['null-fields-present', STORE, '?? NO_TASK_DATES) }))', '?? {}) }))'],
  ['work-board-defaults-to-dated', BOARD, 'const listForBoard = overrides.listDated ?? (overrides.list ? deps.list : () => listBoardWithDates())', 'const listForBoard = deps.list'],
  ['work-board-reads-dated', BOARD, 'await Promise.all([listForBoard(), deps.capabilities()])', 'await Promise.all([deps.list(), deps.capabilities()])'],
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const selected = args.length ? mutations.filter(([name]) => args.includes(name)) : mutations
if (args.length && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))

const scratch = mkdtempSync(join(tmpdir(), 'work-search-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'work-task-runtime'), join(scratch, 'work-task-runtime'), { recursive: true })
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
  console.log(`${selected.length} of ${selected.length} work-search mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
