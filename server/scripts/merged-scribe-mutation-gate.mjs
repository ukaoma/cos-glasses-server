#!/usr/bin/env node
// 6.61.2 merged-scribe mutation gate. Mutations run only in a disposable copy of server/, shared/
// and bin/; the live checkout is never rewritten. The unmutated suites must pass first (a gate
// over a red suite proves nothing), each target must match exactly once, and each mutant must
// fail the NAMED test written for it (a transform or compile error fails the file, not a named
// test, so it never counts as a kill).
//
// Covers the 2026-10-02 brief: a merged G2 meeting whose capture sidecar sits in a different
// domain folder resolves to the merged scribe, for every route and caller that builds a recordId
// from the lookup; the adjacent month; a duplicate claim failing closed; iCloud copies (files and
// "2026-09 2" folders) never counting; near-miss ids never matching; the marker cache seeing new,
// edited and deleted scribes while a warm lookup reads nothing; and the record/source check.
//
// Usage: node server/scripts/merged-scribe-mutation-gate.mjs [--list] [name...]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OPS = 'server/lib/cos-operations-meetings.ts'
const MEETING = 'server/routes/meeting.ts'
const HELD = 'server/lib/held-naming-batches.ts'
const LIB_T = ['server/lib/merged-scribe-resolution.test.ts']
const ROUTE_T = ['server/routes/meeting-cross-folder-merged.test.ts']
const HELD_T = ['server/lib/held-naming-batches.test.ts']

const CROSS = "cross-folder: resolves to the merged scribe in another domain"
const LAST_DAY = 'adjacent month: a capture on the last day'
const MONTH_LIST = 'adjacent month: the month list for each case'
const DUPLICATE = 'duplicate claim fails closed'
const LEAVE_CACHE = 'a deleted scribe and a deleted month folder leave the cache'
const REWRITTEN = 'a scribe rewritten between the scan and the final read'
const UNREADABLE = 'an unreadable month folder or scribe in one domain'

// [name, file, exact target, replacement, a substring of the test that must fail, tests]
const mutations = [
  // The fix: every domain, and the record describes the merged scribe
  ['other-domains-not-searched', OPS, 'const merged = resolveMergedScribe(operationsDir, domains, month, sidecarName, sessionId)', 'const merged = resolveMergedScribe(operationsDir, [domain], month, sidecarName, sessionId)', CROSS, LIB_T],
  ['scribe-domain-dropped', OPS, '            resolvedDomain = merged.domain\n', '', CROSS, LIB_T],
  ['scribe-month-dropped', OPS, '            resolvedMonth = merged.month\n', '', LAST_DAY, LIB_T],
  ['scribe-filename-dropped', OPS, '            resolvedFilename = merged.filename\n', '', CROSS, LIB_T],
  ['own-scribe-ignored', OPS, "          content = readFileSync(meetingPath, 'utf-8')\n", "          throw new Error('mutated')\n", 'a capture whose own scribe still exists keeps it', LIB_T],
  // Every caller that builds a recordId from the lookup
  ['route-recordid-retired', OPS, '            resolvedDomain = merged.domain\n', '', 'a relabel sent with the list row recordId is applied to the merged scribe', ROUTE_T],
  ['review-recordid-retired', OPS, 'const merged = resolveMergedScribe(operationsDir, domains, month, sidecarName, sessionId)', 'const merged = resolveMergedScribe(operationsDir, [domain], month, sidecarName, sessionId)', 'the speaker review returns the recordId, title and domain the list row carries', ROUTE_T],
  ['control-path-sidecar-only', OPS, '            meetingPath = merged.path\n', '', 'a relabel sent with the speaker review recordId rewrites the merged scribe', ROUTE_T],
  ['deattribute-retired', OPS, '            resolvedFilename = merged.filename\n', '', 'a deattribution sent with the list row recordId is applied', ROUTE_T],
  ['title-from-capture', OPS, '            content = merged.content\n', '', 'the speaker review returns the recordId, title and domain the list row carries', ROUTE_T],
  ['content-route-reads-capture', OPS, '            meetingPath = merged.path\n', '', 'the content route reads the merged scribe', ROUTE_T],
  ['held-naming-not-cross-folder', OPS, 'const merged = resolveMergedScribe(operationsDir, domains, month, sidecarName, sessionId)', 'const merged = resolveMergedScribe(operationsDir, [domain], month, sidecarName, sessionId)', 'cross-folder: held naming resolves the operations copy', HELD_T],
  ['sides-retired', OPS, '            resolvedDomain = merged.domain\n', '', 'suggestion sides name the merged scribe', LIB_T],
  ['derived-sources-retired', OPS, '            resolvedDomain = merged.domain\n', '', 'a derived record names the merged scribe', LIB_T],
  // Identity is the marker; two claims resolve to neither
  ['near-miss-matches', OPS, '        if (claim.sessions.includes(sessionId)) found.push(', '        if (claim.sessions.some(id => id.includes(sessionId) || sessionId.includes(id))) found.push(', 'a marker with a near-miss id', LIB_T],
  ['ambiguity-picks-first', OPS, '  if (found.length > 1) {\n', '  if (false) {\n', DUPLICATE, LIB_T],
  ['conflict-dropped', OPS, '            mergedScribeConflict = merged.claimants\n', '', DUPLICATE, LIB_T],
  ['ambiguity-not-logged', OPS, '    console.warn(`[meetings] merged_scribe_ambiguous:', '    if (false) console.warn(`[meetings] merged_scribe_ambiguous:', DUPLICATE, LIB_T],
  ['conflict-reason-generic', MEETING, "    ? `no merged meeting chosen: ${conflict.length} meetings declare this session (${conflict.join(', ')})`\n", "    ? 'meeting markdown unreadable'\n", 'two scribes claim one session', ROUTE_T],
  ['held-naming-follows-pointer', HELD, '    if (found.mergedScribeConflict) throw new Error(', '    if (false) throw new Error(', 'two meetings declare the session: held naming refuses', HELD_T],
  ['record-source-check-off', MEETING, "  return requested == null || requested === '' || requested === expected\n", '  return true\n', 'two scribes claim one session', ROUTE_T],
  // iCloud copies are never claims
  ['icloud-scribe-copy-counted', OPS, "        .filter(name => name.endsWith('.md') && !ICLOUD_CONFLICT_COPY.test(name))\n", "        .filter(name => name.endsWith('.md'))\n", 'an iCloud conflict copy of the merged scribe', LIB_T],
  ['icloud-sidecar-copy-counted', OPS, "f.endsWith('.g2-chunks.json') && !ICLOUD_CONFLICT_COPY.test(f)", "f.endsWith('.g2-chunks.json')", 'an iCloud copy of the sidecar is never the capture', LIB_T],
  ['icloud-month-folder-listed', OPS, '      months = readdirSync(meetingsBase).filter(d => MONTH_PATTERN.test(d)).sort().reverse()\n', '      months = readdirSync(meetingsBase).filter(d => /^\\d{4}-\\d{2}/.test(d)).sort().reverse()\n', 'copy of the capture', LIB_T],
  ['month-guard-dropped', OPS, '  if (!MONTH_PATTERN.test(sidecarMonth)) return []\n', '', MONTH_LIST, LIB_T],
  // The adjacent month
  ['next-month-skipped', OPS, '  if (day === lastDay) months.push(shiftMonth(sidecarMonth, 1))\n', '', LAST_DAY, LIB_T],
  ['previous-month-skipped', OPS, '  if (day === 1) months.push(shiftMonth(sidecarMonth, -1))\n', '', 'adjacent month: a capture on the first day', LIB_T],
  ['neighbours-always', OPS, '  if (!date || date[1] !== sidecarMonth) {\n', '  if (true) {\n', 'adjacent month: a mid-month capture does not search', LIB_T],
  ['last-day-fixed', OPS, '  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()\n', '  const lastDay = 31\n', LAST_DAY, LIB_T],
  ['year-not-wrapped', OPS, "  return `${String(Math.floor(index / 12)).padStart(4, '0')}", "  return `${String(year).padStart(4, '0')}", MONTH_LIST, LIB_T],
  // The cache: new, edited and deleted scribes; a warm lookup reads nothing
  ['listing-cache-stale', OPS, '  if (!listing || listing.stamp !== dirStamp) {\n', '  if (!listing) {\n', 'cache invalidates on a new scribe', LIB_T],
  ['claim-cache-stale', OPS, '    if (!entry || entry.stamp !== stamp) {\n', '    if (!entry) {\n', 'cache invalidates on an in-place edit', LIB_T],
  ['claim-cache-off', OPS, '    if (!entry || entry.stamp !== stamp) {\n', '    if (true) {\n', 'a warm lookup reads no scribe again', LIB_T],
  ['deleted-scribe-kept', OPS, '    for (const old of listing?.names ?? []) if (!kept.has(old)) scribeClaimCache.delete(join(monthDir, old))\n', '', LEAVE_CACHE, LIB_T],
  ['deleted-month-kept', OPS, '    monthListingCache.delete(monthDir)\n', '', LEAVE_CACHE, LIB_T],
  ['deleted-month-scribes-kept', OPS, '    for (const name of monthListingCache.get(monthDir)?.names ?? []) scribeClaimCache.delete(join(monthDir, name))\n', '', LEAVE_CACHE, LIB_T],
  // What the lookup refuses to read
  ['final-read-not-rechecked', OPS, "  if (!mergedScribeSessions(content).includes(sessionId)) return { status: 'none' }\n", '', REWRITTEN, LIB_T],
  ['final-read-throws', OPS, "    content = read(path)\n  } catch {\n    return { status: 'none' }\n  }\n", '    content = read(path)\n  } finally { /* mutated */ }\n', REWRITTEN, LIB_T],
  ['unreadable-month-throws', OPS, '        .slice(0, MAX_LIST_CANDIDATES)\n    } catch {\n      return []\n    }\n', '        .slice(0, MAX_LIST_CANDIDATES)\n    } finally { /* mutated */ }\n', UNREADABLE, LIB_T],
  ['unreadable-scribe-throws', OPS, "        content = readFileSync(path, 'utf-8')\n      } catch { continue }\n", "        content = readFileSync(path, 'utf-8')\n      } finally { /* mutated */ }\n", UNREADABLE, LIB_T],
  ['fifo-opened', OPS, '    if (!stat.isFile()) continue\n', '', 'a FIFO named like a scribe is never opened', LIB_T],
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const chosen = args.length ? mutations.filter(([name]) => args.includes(name)) : mutations
if (args.length && chosen.length !== args.length) throw new Error(`Unknown mutation name in: ${args.join(' ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'merged-scribe-mutations-'))
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
  console.log(`${killed} of ${chosen.length} merged-scribe mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
