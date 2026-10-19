#!/usr/bin/env node
// Key lanes K1 P5 mutation gate (plan v4 14.2 row P5): Lane C1 direct answers on the Mac. The tool
// id mapping, D7 tools-off for a remote endpoint, the 5-post cap, the retry discipline, metering
// settles, the SSE fragment accumulator, the 24 h public catalog, and the Ollama run-ledger rows
// that must stay byte for byte. Mutations run only in a disposable copy of the checkout; the live
// checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/key-lanes-p5-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BRIDGE_T = ['server/lib/direct-bridge.test.ts']
const SSE_T = ['server/lib/direct-sse.test.ts']
const CATALOG_T = ['server/lib/key-catalog.test.ts']
const LEDGER_T = ['server/lib/ollama-run-ledger.test.ts']
const ALL = [...BRIDGE_T, ...SSE_T, ...CATALOG_T, ...LEDGER_T]
const BRIDGE = 'server/lib/direct-bridge.ts', SSE = 'server/lib/direct-sse.ts'
const CATALOG = 'server/lib/key-catalog.ts', LEDGER = 'server/lib/ollama-run-ledger.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── The four the plan names (14.2 row P5, and the P5 brief) ──
  m('tool-id-mapped-to-tool-name', BRIDGE, ["  return { role: 'tool', tool_call_id: call.id, content: result }", "  return { role: 'tool', tool_name: call.function.name, content: result } as never"], BRIDGE_T),
  m('tools-on-for-remote-by-default', BRIDGE, ['  if (profile.directTools === true) return true\n  return isLoopbackEndpoint(endpoint)', '  return true'], BRIDGE_T),
  m('post-cap-removed', BRIDGE, ['      if (postCount >= DIRECT_MAX_POSTS) {', '      if (false) {'], BRIDGE_T),
  m('ollama-ledger-row-gains-lane', LEDGER, ['    model: OLLAMA_MODEL,\n    ollamaModel: input.ollamaModel,', "    model: OLLAMA_MODEL,\n    lane: 'direct',\n    ollamaModel: input.ollamaModel,"], LEDGER_T),
  // ── Ledger separation ──
  m('ollama-finish-row-to-direct-file', LEDGER, ['  finishRun(getOllamaLedgerPath(), classifyOllamaError, runId, input)', '  finishRun(getDirectRunLedgerPath(), classifyOllamaError, runId, input)'], LEDGER_T),
  m('direct-rows-into-ollama-ledger', LEDGER, ['  appendEvent({ runId: run.runId, ts: now, patch: run }, getDirectRunLedgerPath())', '  appendEvent({ runId: run.runId, ts: now, patch: run })'], BRIDGE_T),
  // ── D7 and tool gating ──
  m('unoffered-tool-call-executed', BRIDGE, ['      if (toolDefs.length === 0 || !sendTools) {', '      if (false) {'], BRIDGE_T),
  m('tools-sent-to-model-without-tools', BRIDGE, ['    && keyModelSupportsTools(profile.model, catalogModels) !== false\n', '\n'], BRIDGE_T),
  m('tools-400-retry-removed', BRIDGE, ['        if (response.status === 400 && body.tools && !toolsRetried && postCount === 1 && /tool/i.test(detail)) {', '        if (false) {'], BRIDGE_T),
  // ── Refusals before any work ──
  m('lanes-active-forced-true', BRIDGE, ['  const active = keyLanesActive()', '  const active = true'], BRIDGE_T),
  m('engine-check-removed', BRIDGE, ["  if (profile.engine !== 'direct') return refuse(DIRECT_COPY.wrongEngine)\n", ''], BRIDGE_T),
  // ── Retries (plan 4.6) ──
  m('retry-cap-raised', BRIDGE, ['export const DIRECT_MAX_RETRIES = 2', 'export const DIRECT_MAX_RETRIES = 5'], BRIDGE_T),
  m('long-retry-after-waited', BRIDGE, ['          if (retryAfter !== null && retryAfter > DIRECT_RETRY_AFTER_MAX_MS) {', '          if (false) {'], BRIDGE_T),
  m('out-of-credit-retried', BRIDGE, ["new Set(['rate_limited', 'upstream_error', 'network_error'])", "new Set(['rate_limited', 'upstream_error', 'network_error', 'out_of_credit'])"], BRIDGE_T),
  m('model-gone-not-classified', BRIDGE, ["  if (status === 400 && MODEL_GONE_RE.test(bodyText)) return 'model_gone'\n", ''], BRIDGE_T),
  // ── Metering ──
  m('usage-not-marked-measured', BRIDGE, ['      usageTotals.measured = true\n', ''], BRIDGE_T),
  m('cut-stream-settled-as-free', BRIDGE, ['    } else {\n      settle(null)\n    }', '    } else {\n      settle({ input: 0, output: 0 })\n    }'], BRIDGE_T),
  m('failed-status-billed-in-full', BRIDGE, ['        settle({ input: 0, output: 0 })', '        settle(null)'], BRIDGE_T),
  // ── SSE fragments ──
  m('sse-arguments-overwritten', SSE, ["    if (typeof args === 'string') slot.args += args", "    if (typeof args === 'string') slot.args = args"], [...SSE_T, ...BRIDGE_T]),
  m('sse-later-id-wins', SSE, ['    if (id && !slot.id) slot.id = id', '    if (id) slot.id = id'], SSE_T),
  m('sse-no-synthesized-id', SSE, ['        id: s.id || `${this.idPrefix}_${s.index}`,', '        id: s.id,'], SSE_T),
  m('sse-call-cap-removed', SSE, ['    if (this.slots.length >= DIRECT_SSE_LIMITS.callsPerResponse) {', '    if (false) {'], SSE_T),
  m('sse-repeated-name-doubled', SSE, ['      else if (name !== slot.name) slot.name += name', '      else slot.name += name'], SSE_T),
  // ── Catalog ──
  m('catalog-ttl-ignored', CATALOG, ['    if (!this.cached || this.now() - this.cached.at >= this.ttlMs) return null', '    if (!this.cached) return null'], CATALOG_T),
  m('catalog-sends-authorization', CATALOG, ["          headers: { accept: 'application/json' },", "          headers: { accept: 'application/json', authorization: 'Bearer cos' },"], CATALOG_T),
  m('catalog-follows-redirects', CATALOG, ["          redirect: 'error',", "          redirect: 'follow',"], CATALOG_T),
  m('downselect-row-cap-removed', CATALOG, ['  const limit = Math.max(0, Math.min(KEY_CATALOG_MAX_ROWS, Math.floor(options.limit ?? KEY_CATALOG_MAX_ROWS)))', '  const limit = Math.max(0, Math.floor(options.limit ?? 1000))'], CATALOG_T),
  m('downselect-unsafe-glyphs-kept', CATALOG, ["  const clean = text.replace(LENS_UNSAFE, ' ').replace(/\\s+/g, ' ').trim()", "  const clean = text.replace(/\\s+/g, ' ').trim()"], CATALOG_T),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length && !args.includes('--check') ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && !args.includes('--check') && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')
// --check: every target matches exactly once and changes its file. Runs no tests.
if (args.includes('--check')) {
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
  console.log(`${mutations.length - bad} of ${mutations.length} targets match exactly once`)
  process.exit(bad ? 1 : 0)
}

const scratch = mkdtempSync(join(tmpdir(), 'key-lanes-p5-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  for (const dir of ['shared', 'work-task-runtime', 'bin', 'docs', 'memory-runtime']) cpSync(join(root, dir), join(scratch, dir), { recursive: true })
  for (const file of ['vitest.config.ts', 'package.json', 'managed-runtime-contract.json']) cpSync(join(root, file), join(scratch, file))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: process.env.TMPDIR, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json') },
    encoding: 'utf8', timeout: 300000,
  })
  const baseline = run(ALL)
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  const totals = /Tests\s+(\d+) passed/.exec(baseline.stdout)
  console.log(`baseline PASS (${totals ? totals[1] : '?'} tests in ${ALL.length} files)`)
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
  console.log(`${killed} of ${selected.length} key lanes P5 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
