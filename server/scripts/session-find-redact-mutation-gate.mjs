#!/usr/bin/env node
// Session find redaction mutation gate (Control 0.5.363): the path, attachment, link, surrogate and degrade-log guards.
// Mutations run only in a disposable copy of server/ and shared/; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/session-find-redact-mutation-gate.mjs [--list] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = ['server/lib/session-find-redact.test.ts', 'server/routes/session-find.test.ts']
const REDACT = 'server/lib/session-find-redact.ts', ROUTE = 'server/routes/session-find.ts'
const raw = String.raw
const mutations = [
  ['paths-case-insensitive', REDACT, "'gi')\nexport const PATH_PLACEHOLDER", "'g')\nexport const PATH_PLACEHOLDER"],
  ['quoted-path-masked-by-shape', REDACT, 'HOME_SHAPE_QUOTED.test(inner.trim()) ? PATH_PLACEHOLDER : whole', 'false ? PATH_PLACEHOLDER : whole'],
  ['quoted-needs-a-shape', REDACT, 'HOME_SHAPE_QUOTED.test(inner.trim()) ? PATH_PLACEHOLDER : whole', 'true ? PATH_PLACEHOLDER : whole'],
  ['bare-path-masked', REDACT, '.replace(BARE_HOME_PATH, PATH_PLACEHOLDER)', ''],
  ['quoted-path-masked', REDACT, 'maskQuotedHomePaths(text).replace', 'text.replace'],
  ['volumes-form', REDACT, raw`|\/Volumes\/[^\/\n]+|\/mnt\/[a-z])?\/(?:users|home)\/[^\s`, raw`|\/mnt\/[a-z])?\/(?:users|home)\/[^\s`],
  ['tilde-needs-a-segment', REDACT, raw`~[\w.\-]*\/(?=(?:\\ |[^\s])*[\/.]))`, raw`~[\w.\-]*\/)`],
  ['host-links-masked', REDACT, 'maskHostLinks(maskQuotedHomePaths(text)', '(maskQuotedHomePaths(text)'],
  ['link-no-domains', REDACT, raw`|localhost)(?::`, raw`|localhost|(?:[a-z0-9\-]+\.)+[a-z]{2,24})(?::`],
  ['link-bare-address-stays', REDACT, raw`(?::\d{2,5}(?:\/[^\s]*)?|\/[^\s]*)`+"`, 'gi')", raw`(?::\d{2,5}(?:\/[^\s]*)?|\/[^\s]*)?`+"`, 'gi')"],
  ['cut-attachment-dropped', REDACT, "return cut && UNCLOSED_ATTACHMENT.test(out) ? '' : out", 'return out'],
  ['title-cut-flag', REDACT, 'stripLeadingAttachments(title, titleCut)', 'stripLeadingAttachments(title)'],
  ['prompt-cut-flag', REDACT, 'stripLeadingAttachments(typed, promptCut)', 'stripLeadingAttachments(typed)'],
  ['prompt-cut-at-limit', REDACT, 'typed.length >= UPSTREAM_PROMPT_CUT', 'false'],
  ['attachments-loop', REDACT, 'if (next === out) break', 'break'],
  ['lone-surrogate-removed', REDACT, ".replace(LONE_SURROGATE, '')", ''],
  ['degrade-log-throttled', ROUTE, 'if (last !== undefined && at - last < SESSION_FIND_LOG_EVERY_MS) return', ''],
  ['degrade-log-per-reason', ROUTE, 'lastLogged.get(reason)', "lastLogged.get('any')"],
  ['degrade-log-only-degrades', ROUTE, 'if (!answer.available && answer.reason) logDegrade(answer.reason)', "if (answer.reason) logDegrade(answer.reason); else logDegrade('ok')"],
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const selected = args.length ? mutations.filter(([name]) => args.includes(name)) : mutations
if (args.length && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))

const scratch = mkdtempSync(join(tmpdir(), 'session-find-redact-mutations-'))
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
  console.log(`${selected.length} of ${selected.length} session-find-redact mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
