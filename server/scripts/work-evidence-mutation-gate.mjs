#!/usr/bin/env node
// Work evidence check mutation gate (6.66.0): the SSRF guard, tag scoping, only-fact-counts, skip-on-unchanged, the
// cap, the switch and the request contract; since the 2026-10-07 QA also gap walking, the capability, the refusals
// before reading, supporting items and evidence times. Mutations run only in a disposable copy of server/ and shared/; the live
// checkout (which a candidate may be running) is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Unlike the search gate it runs every mutant and reports each as KILLED or SURVIVED, then exits 1 if any survived.
// Usage: node server/scripts/work-evidence-mutation-gate.mjs [--list] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = ['server/lib/safe-fetch.test.ts', 'server/lib/work-evidence.test.ts', 'server/routes/work-evidence.test.ts',
  'server/routes/work-board.test.ts', 'server/lib/work-search.test.ts', 'server/routes/jev.test.ts']
const SF = 'server/lib/safe-fetch.ts', EV = 'server/lib/work-evidence.ts', JR = 'server/routes/jev.ts', WS = 'server/lib/work-search.ts', WB = 'server/routes/work-board.ts', PK = 'package.json'
const mutations = [
  // SSRF: the URL.
  ['https-only', SF, "  if (url.protocol !== 'https:') throw new SafeFetchError('not_https')\n", ''],
  ['default-port-only', SF, "  if (url.port !== '') throw new SafeFetchError('port_not_default')\n", ''],
  ['no-credentials', SF, "  if (url.username || url.password) throw new SafeFetchError('credentials_in_url')\n", ''],
  ['no-ip-literal', SF, "  if (!host || host.startsWith('[') || isIP(host)) throw new SafeFetchError('ip_literal_host')\n", ''],
  ['no-single-label', SF, "  if (!host.includes('.')) throw new SafeFetchError('single_label_host')\n", ''],
  ['no-private-suffix', SF, "  if (host === 'localhost' || PRIVATE_SUFFIXES.some(suffix => host.endsWith(suffix))) throw new SafeFetchError('private_host')\n", ''],
  ['no-preview-host', SF, "  if (PREVIEW_HOSTS.some(re => re.test(host))) throw new SafeFetchError('preview_host')\n", ''],
  // SSRF: the addresses.
  ['every-address-checked', SF, "for (const row of rows) if (!row || typeof row.address !== 'string' || isBlockedAddress(row.address)) throw", "if (isBlockedAddress(rows[0].address)) throw"],
  ['no-address-is-refused', SF, "if (!Array.isArray(rows) || rows.length === 0) throw new SafeFetchError('dns_failed')", "if (!Array.isArray(rows)) throw new SafeFetchError('dns_failed')"],
  ['loopback-v4', SF, "['127.0.0.0', 8], ", ''],
  ['rfc1918-10', SF, "['10.0.0.0', 8], ", ''],
  ['rfc1918-172', SF, "['172.16.0.0', 12],", ''],
  ['rfc1918-192', SF, "['192.168.0.0', 16], ", ''],
  ['link-local-v4', SF, "['169.254.0.0', 16], ", ''],
  ['cgnat-tailscale', SF, "['100.64.0.0', 10], ", ''],
  ['unspecified-v4', SF, "['0.0.0.0', 8], ", ''],
  ['ula', SF, "['fc00::', 7], ", ''],
  ['ipv4-mapped', SF, "['::ffff:0:0', 96], ", ''],
  ['v6-loopback-unspecified', SF, "  ['::', 96], ", '  '],
  ['link-local-v6', SF, "['fe80::', 10], ", ''],
  ['two-blocklists', SF, "if (family === 6) return BLOCKED_V6.check(clean, 'ipv6')", "if (family === 6) return BLOCKED_V4.check(clean, 'ipv6')"],
  ['unparseable-blocked', SF, "  if (family === 6) return BLOCKED_V6.check(clean, 'ipv6')\n  return true\n", "  if (family === 6) return BLOCKED_V6.check(clean, 'ipv6')\n  return false\n"],
  // SSRF: rebinding and redirects.
  ['pinned-lookup-own-host', SF, "if (name.toLowerCase().replace(/\\.$/, '') !== host || !addresses.length) {", 'if (!addresses.length) {'],
  ['transport-uses-pinned-lookup', SF, 'lookup: req.lookup as never, ', ''],
  ['resolve-every-hop', SF, '    for (let hop = 0; ; hop++) {\n      const addresses = await Promise.race([resolveVetted(current.hostname, deps.resolve), expired])',
    '    let cached = null\n    for (let hop = 0; ; hop++) {\n      const addresses = cached ??= await Promise.race([resolveVetted(current.hostname, deps.resolve), expired])'],
  ['redirect-revetted', SF, '        next = vetUrl(next)\n', ''],
  ['redirect-same-host', SF, "        if (next.hostname.toLowerCase() !== host) throw new SafeFetchError('redirect_other_host')\n", ''],
  ['redirect-limit', SF, "if (hop >= deps.maxRedirects) throw new SafeFetchError('redirect_limit')", "if (false) throw new SafeFetchError('redirect_limit')"],
  // SSRF: time, size, identity.
  ['timeout-aborts', SF, 'const timer = setTimeout(() => controller.abort(), deps.timeoutMs)', 'const timer = setTimeout(() => {}, deps.timeoutMs)'],
  ['transport-stops-at-cap', SF, '        if (total >= req.maxBytes) { finish(); client.destroy(); res.destroy() }\n', ''],
  ['body-read-capped', SF, 'const html = res.body.subarray(0, deps.maxBytes).toString', 'const html = res.body.toString'],
  ['cap-256k', SF, 'maxBytes: 256 * 1024,', 'maxBytes: 1024 * 1024,'],
  ['browser-user-agent', SF, "headers: { 'User-Agent': SAFE_FETCH_USER_AGENT,", "headers: { 'User-Agent': 'node',"],
  ['soft-404', SF, '  if (SOFT_404.test(title)) return false\n', ''],
  ['marker-only-on-200', SF, 'markerFound: res.status === 200 && markersFound(html, markers)', 'markerFound: markersFound(html, markers)'],
  // Tag scoping.
  ['untagged-needs-single-follow', EV, 'if (!single || !read.anchored) return', 'if (!read.anchored) return'],
  ['untagged-needs-anchor', EV, 'if (!single || !read.anchored) return', 'if (!single) return'],
  ['other-cards-only-excluded', EV, "        } else if (others.length) {\n          return  // it reports on other cards only\n        } else {", '        } else {'],
  ['own-lines-only-when-mixed', EV, "text = single && !others.length ? reply.text : mine.map(l => l.line).join('\\n')", 'text = reply.text'],
  ['anchor-slices', EV, 'records = anchored ? records.slice(anchorAt + 1) : records', 'records = records'],
  ['untouched-since-is-empty', EV, '} else if (anchorMode && mtimeMs < sinceMs) {', '} else if (false) {'],
  // Only a fact counts; a URL is necessary; deterministic means a passing URL.
  ['only-fact-counts', EV, "if (kind !== 'fact') reason = 'not_fact'", "if (false) reason = 'not_fact'"],
  ['met-needs-picked-item', EV, "else if (!item) reason = 'no_evidence'", "else if (false) reason = 'no_evidence'"],
  ['url-necessary', EV, "else if ((item.source === 'url' && !item.urlPass) || ownUrls.some(u => !items.some(it => it.source === 'url' && it.ref === u && it.urlPass))) reason = 'url_not_passed'",
    "else if (false) reason = 'url_not_passed'"],
  ['url-necessary-own-url', EV, " || ownUrls.some(u => !items.some(it => it.source === 'url' && it.ref === u && it.urlPass))) reason", ') reason'],
  ['url-pass-needs-200', EV, 'pass = r.status === 200 && sameUrl(r.finalUrl, url) && r.markerFound', 'pass = sameUrl(r.finalUrl, url) && r.markerFound'],
  ['url-pass-needs-same-url', EV, 'pass = r.status === 200 && sameUrl(r.finalUrl, url) && r.markerFound', 'pass = r.status === 200 && r.markerFound'],
  ['url-pass-needs-marker', EV, 'pass = r.status === 200 && sameUrl(r.finalUrl, url) && r.markerFound', 'pass = r.status === 200 && sameUrl(r.finalUrl, url)'],
  ['deterministic-only-passing-url', EV, "deterministic: !!item && item.source === 'url' && item.urlPass === true", "deterministic: !!item && item.source === 'url'"],
  ['url-limit', EV, 'if (wanted.length < EVIDENCE_LIMITS.urls && ', 'if ('],
  // Skip when nothing is new.
  ['skip-on-unchanged', EV, 'if (prior && prior.judge === judge && keys.every(k => prior.keys.has(k))) {', 'if (false) {'],
  ['skip-needs-same-clauses', EV, 'if (prior && prior.judge === judge && keys.every', 'if (prior && keys.every'],
  ['skip-needs-no-new-item', EV, 'keys.every(k => prior.keys.has(k))', 'true'],
  ['url-check-time-not-evidence', EV, "item.source === 'url' ? '' : item.at ?? ''", "item.at ?? ''"],
  // Cost: own cap, own ledger, default, switch, honest reasons.
  ['own-cap', EV, 'return new JevClient(fetchImpl, now, usageFile, () => workEvidenceDailyCap())', 'return new JevClient(fetchImpl, now, usageFile)'],
  ['own-ledger', EV, "dataPath('jev-work-evidence-usage.json')", "dataPath('jev-usage.json')"],
  ['default-cap-300k', EV, 'defaultDailyTokens: 300_000,', 'defaultDailyTokens: 1_000_000,'],
  ['switch-off', EV, "    if (!this.deps.enabled()) return { provider: 'none', reason: 'evidence_disabled' }\n", ''],
  ['switch-zero-is-off', EV, "!['0', 'false', 'no', 'off'].includes(", "!['false', 'no', 'off'].includes("],
  ['route-switch-before-board', JR, "    if (!deps.evidence.enabled()) return res.json({ provider: 'none', reason: 'evidence_disabled' })\n", ''],
  ['cap-and-breaker-reasons', EV, "{ jev_cap_reached: 'jev_cap', jev_breaker_open: 'jev_breaker' }", '{}'],
  ['new-key-clears-evidence-breaker', JR, '    deps.evidenceJev.resetForNewKey()\n', ''],
  // What leaves for TypeSafe, and how much.
  ['redaction', EV, 'return redactSecrets(redactSecretText(boundForRedaction(text, EVIDENCE_LIMITS.scanChars).head))', 'return text'],
  ['eight-per-follow', EV, 'kept >= EVIDENCE_LIMITS.sessionItemsPerFollow || ', ''],
  ['session-chars-cap', EV, ' || chars + c.excerpt.length > EVIDENCE_LIMITS.sessionChars', ''],
  ['tagged-first', EV, "c.score === Number.MAX_SAFE_INTEGER ? 2 : c.score > 0 ? 1 : 0", 'c.score > 0 ? 1 : 0'],
  // Cursors and truncation.
  ['cursor-prefix-checked', EV, 'const fits = !!cursor && cursor.o <= size && await prefixHash(path, cursor.o) === cursor.p', 'const fits = !!cursor && cursor.o <= size'],
  ['foreign-cursor-ignored', EV, 'cursor = decoded && decoded.id === id ? decoded : null', 'cursor = decoded'],
  // QA 2026-10-07: a truncated read walks forward through the gap, never an end-of-file cursor.
  ['truncated-when-more-unread', EV, '  const truncated = to < size\n', '  const truncated = false\n'],
  ['gap-cursor-not-eof', EV, 'return { records, end: truncated && end <= from ? to : end, truncated }', 'return { records, end: truncated ? size : end, truncated }'],
  ['giant-line-stepped-over', EV, 'return { records, end: truncated && end <= from ? to : end, truncated }', 'return { records, end, truncated }'],
  ['cursor-reads-forward', EV, ';({ records, end, truncated } = await readForward(path, cursor!.o, size, largest))',
    ';({ records, end, truncated } = await readForward(path, Math.max(cursor!.o, size - largest), size, largest))'],
  ['since-found-by-bisection', EV, 'const from = await seekBeforeTime(path, floorMs!, start, size, largest)', 'const from = start'],
  ['since-gap-read', EV, '    } else if (start > 0 && !records.some(reachesFloor)) {', '    } else if (false) {'],
  ['bisection-needs-older', EV, '    if (t !== null && t < floorMs) lo = mid', '    if (t !== null) lo = mid'],
  ['cursor-handoff-walk-from-top', EV, '      if (!anchored && start > 0) {', '      if (false) {'],
  ['anchor-pending-flag', EV, '...(anchorPending ? { a: 1 as const } : {})', '...({})'],
  ['anchor-pending-honoured', EV, '    if (cursor!.a) { afterAnchor(); anchorPending = !anchored }', '    if (false) { afterAnchor(); anchorPending = !anchored }'],
  ['anchor-flag-validated', EV, ' || (body.a !== undefined && body.a !== 1)) return null', ') return null'],
  ['prefix-4k', EV, 'prefixBytes: 4096,', 'prefixBytes: 64,'],
  ['since-floor', EV, '      if (at !== null && (exclusive ? at <= floorMs : at < floorMs)) continue\n', ''],
  ['partial-line-waits', EV, 'return { records, end: readFrom + lastNewline + 1 }', 'return { records, end: size }'],
  // Sources.
  ['meeting-identity', EV, 'if (!m || m.recordId !== ref.recordId) continue', 'if (!m) continue'],
  ['slack-needs-available', EV, "body.available !== true || ", ''],
  // The request contract, the lease and the capability.
  ['request-exact-keys', EV, "  if (Object.keys(b).sort().join(',') !== REQUEST_KEYS.join(',')) return null\n", ''],
  ['follow-exact-keys', EV, "    if (Object.keys(r).sort().join(',') !== FOLLOW_KEYS.join(',')) return null\n", ''],
  ['four-follows', EV, 'b.follows.length > EVIDENCE_LIMITS.follows', 'false'],
  ['six-clauses', EV, 'b.clauses.length > EVIDENCE_LIMITS.clauses', 'false'],
  ['clause-300', EV, "c.length > EVIDENCE_LIMITS.clauseChars || ", ''],
  ['safe-session-id', EV, " || !isSafeSessionId(r.sessionId)) return null", ') return null'],
  ['no-duplicate-follows', EV, '    if (seen.has(key)) return null\n', ''],
  ['cursor-syntax', EV, '    if (!isWellFormedCursor(r.cursor)) return null\n', ''],
  ['outside-mutation-lease', WS, "new Set(['/work/search', '/work-board/evidence-check'])", "new Set(['/work/search'])"],
  ['capability-flag', WB, 'capabilities: { ...capabilities, evidenceCheck: deps.evidenceCheck() }', 'capabilities: { ...capabilities, evidenceCheck: true }'],
  ['capability-default-wired', WB, 'evidenceCheck: () => workEvidenceAvailable() }', 'evidenceCheck: () => true }'],
  ['capability-needs-switch', EV, '  return workEvidenceEnabled(env) && hasKey()\n', '  return hasKey()\n'],
  ['capability-needs-key', EV, '  return workEvidenceEnabled(env) && hasKey()\n', '  return workEvidenceEnabled(env)\n'],
  // QA 2026-10-07: refuse before reading when Jev certainly cannot answer, and say when to ask again.
  ['preflight-wired', EV, '    const refused = this.preflight()\n    if (refused) return refused\n', ''],
  ['preflight-no-key', EV, "    if (!status.configured) return { provider: 'none', reason: EVIDENCE_REFUSALS.notConfigured }\n", ''],
  ['preflight-breaker', EV, "    if (status.breakerOpenUntil) return { provider: 'none', reason: EVIDENCE_REFUSALS.breaker, retryAt: status.breakerOpenUntil }\n", ''],
  ['preflight-cap', EV, "    if (status.usedToday >= status.dailyCap) return { provider: 'none', reason: EVIDENCE_REFUSALS.cap, retryAt: nextUtcDay(this.deps.now()) }\n", ''],
  ['breaker-retry-at', EV, 'const retryAt = reason === EVIDENCE_REFUSALS.breaker ? this.deps.jev.status?.().breakerOpenUntil ?? undefined', 'const retryAt = reason === EVIDENCE_REFUSALS.breaker ? undefined'],
  ['cap-retry-at', EV, '      : reason === EVIDENCE_REFUSALS.cap ? nextUtcDay(this.deps.now()) : undefined', '      : undefined'],
  // QA 2026-10-07: supporting items and evidence times.
  ['support-question-asked', EV, "      questions[`s${i}`] = { type: 'choice', instructions: SUPPORT_TEXT.replaceAll('{i}', String(i)), criteria: { ...supportOptions, none: 'No item reports it as already true.' } }\n", ''],
  ['support-answer-validated', EV, '  if (rows.some(([k, v]) => !allowed.includes(k)', '  if (false && rows.some(([k, v]) => !allowed.includes(k)'],
  ['supporting-only-met', EV, "  if (verdict === 'met' && item) {", '  if (item) {'],
  ['supporting-min-p', EV, "k !== 'none' && p >= EVIDENCE_LIMITS.supportMinP", "k !== 'none' && p >= 0"],
  ['supporting-min-p-value', EV, 'supportMinP: 0.15,', 'supportMinP: 0.1,'],
  ['supporting-distinct', EV, 'if (other && !chosen.includes(other)) chosen.push(other)', 'if (other) chosen.push(other)'],
  ['supporting-cap-4', EV, '      if (supporting.length >= EVIDENCE_LIMITS.supporting) break\n', ''],
  ['supporting-no-failed-url', EV, "      if (it.source === 'url' && it.urlPass !== true) continue  // a page check that did not pass supports nothing\n", ''],
  ['supporting-at-fallback', EV, 'supporting.push({ source: it.source, ref: it.ref, at: it.at ?? observedAt })', 'supporting.push({ source: it.source, ref: it.ref, at: it.at })'],
  ['evidence-at-fallback', EV, 'excerpt: clip(item.excerpt, EVIDENCE_LIMITS.excerptChars), at: item.at ?? observedAt }', 'excerpt: clip(item.excerpt, EVIDENCE_LIMITS.excerptChars), at: item.at }'],
  // QA 2026-10-07: one set of limits, UTF-16 clause length, the 400 carries them, the gate stays out of the package.
  ['request-limits-pinned', EV, 'follows: 4, clauses: 6, clauseChars: 300,', 'follows: 4, clauses: 6, clauseChars: 301,'],
  ['clause-utf16', EV, "typeof c !== 'string' || c.length > EVIDENCE_LIMITS.clauseChars", "typeof c !== 'string' || [...c].length > EVIDENCE_LIMITS.clauseChars"],
  ['route-400-limits', JR, '        limits: L } })', '      } })'],
  ['npm-excludes-this-gate', PK, '    "!server/scripts/work-evidence-mutation-gate.mjs",\n', ''],
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const selected = args.length ? mutations.filter(([name]) => args.includes(name)) : mutations
if (args.length && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))

const scratch = mkdtempSync(join(tmpdir(), 'work-evidence-mutations-'))
const killed = [], survived = []
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
    if (result.status === 0 || result.error || !killers.length) {
      survived.push(name)
      console.log(`${name} SURVIVED${result.error ? ` (harness: ${result.error.message})` : ''}`)
    } else {
      killed.push(name)
      console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
    }
  }
  console.log(`${killed.length} of ${selected.length} work-evidence mutations killed${survived.length ? `; SURVIVED: ${survived.join(', ')}` : ''}`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
process.exit(survived.length ? 1 : 0)
