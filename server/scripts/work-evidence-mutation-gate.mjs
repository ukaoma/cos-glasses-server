#!/usr/bin/env node
// Work evidence check mutation gate (6.66.0): the SSRF guard, tag scoping, only-fact-counts, skip-on-unchanged, the
// cap, the switch and the request contract. Mutations run only in a disposable copy of server/ and shared/; the live
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
const SF = 'server/lib/safe-fetch.ts', EV = 'server/lib/work-evidence.ts', JR = 'server/routes/jev.ts', WS = 'server/lib/work-search.ts', WB = 'server/routes/work-board.ts'
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
  ['truncated-past-cursor', EV, 'truncated = from > cursor!.o', 'truncated = false'],
  ['truncated-before-since', EV, 'truncated = start > 0 && !records.some(reachesFloor)', 'truncated = false'],
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
  ['capability-flag', WB, 'capabilities: { ...capabilities, evidenceCheck: true }', 'capabilities'],
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
