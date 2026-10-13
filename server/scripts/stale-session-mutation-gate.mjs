#!/usr/bin/env node
// Stale live-session mutation gate (6.71.14). Mutations run only in a disposable copy of server/ and shared/;
// the live checkout (which a candidate may be running) is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/stale-session-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = ['server/routes/transcribe-stream-stale-session.test.ts', 'server/lib/stale-active-session-files.test.ts']
const TS = 'server/routes/transcribe-stream.ts', MT = 'server/routes/meeting.ts'
const SF = 'server/lib/stale-active-session-files.ts', UQ = 'server/lib/unsaved-audio-quarantine.ts'
const mutations = [
  // Root cause: boot recovery behind a closed maintenance gate.
  ['deferred-recovery-on-open', TS, "  onMaintenanceAdmissionsOpen(() => runDurableSessionRecovery('admissions_open'))\n", ''],
  ['recovery-runs-once', TS, '  if (durableSessionRecoveryRan) return\n', ''],
  ['recovery-skips-live', TS, "        if (typeof data.sessionId === 'string' && sessions.has(data.sessionId)) continue\n", ''],
  ['boot-sweep-sees-live-map', TS, 'isLive: id => recoveredIds.has(id) || sessions.has(id),', 'isLive: id => recoveredIds.has(id),'],
  ['recovery-diverts-terminal', TS, "if (typeof data.sessionId === 'string' && isTerminalCaptureFile(data.sessionId, data.lastActivityAt, resolve(CHUNK_PERSIST_DIR, file))) {", 'if (false) {'],
  ['recovery-terminal-only-when-decoded', TS, "  if (!disposition || (disposition.kind !== 'no_speech' && disposition.kind !== 'recovered')) return false\n", '  if (!disposition) return false\n'],
  ['terminal-not-newer-than-file', TS, '  if (terminalAt < fileActivity) return false\n', ''],
  ['terminal-no-own-audio', TS, '  return countChunkWavs(resolve(SESSION_AUDIO_DIR, sessionId)) === 0\n', '  return true\n'],
  ['recovery-move-failure-logged', TS, "          else logStaleMoveFailure(data.sessionId, ", '          else void (data.sessionId, '],
  ['interval-waits-for-recovery', TS, '  if (!durableSessionRecoveryRan) return\n', ''],
  // The minute sweep.
  ['interval-runs-stale-sweep', TS, '    sweepStaleActiveSessionFilesNow(Date.now())\n', ''],
  ['interval-stale-sweep-own-try', TS, "  try {\n    sweepStaleActiveSessionFilesNow(Date.now())\n  } catch (error) {\n    console.error(`[cleanup] Stale active-session sweep failed: ${error instanceof Error ? error.message : error}`)\n  }\n", '  sweepStaleActiveSessionFilesNow(Date.now())\n'],
  ['sweep-uses-live-map', TS, '    isLive: id => sessions.has(id),\n    now,', '    isLive: () => false,\n    now,'],
  ['sweep-failure-logged', TS, '      logStaleMoveFailure(move.sessionId, ', '      void (move.sessionId, '],
  ['move-failure-deduped', TS, '  if (staleMoveFailuresLogged.has(sessionId)) return\n', ''],
  ['purge-wired', TS, 'const purged = purgeExpiredStaleActiveSessionFiles(STALE_ACTIVE_SESSION_DIR, now)', 'const purged = 0'],
  ['purge-count-logged', TS, "  if (purged > 0) console.log(`[cleanup] Purged ${purged} stale active-session file(s) past retention`)\n", ''],
  ['sweep-never-live', SF, '    if (opts.isLive(sessionId)) continue\n', ''],
  ['sweep-horizon', SF, '    if (idleMs < opts.idleRetentionMs) continue\n', ''],
  ['sweep-horizon-inclusive', SF, 'if (idleMs < opts.idleRetentionMs) continue', 'if (idleMs <= opts.idleRetentionMs) continue'],
  ['activity-reads-last-activity', SF, 'recorded = data.lastActivityAt', 'recorded = null'],
  ['activity-mtime-bound', SF, '  return Math.min(recorded, mtimeMs)\n', '  return recorded\n'],
  ['reason-before-move', SF, '    const target = resolve(targetDir, `${base}.json`)\n', '    const target = resolve(targetDir, `${base}.json`)\n    renameSync(sourcePath, target)\n'],
  ['rename-failure-removes-reason', SF, "      try { rmSync(reasonPath, { force: true }) } catch { /* the next sweep's own reason supersedes it */ }\n", ''],
  ['same-ms-unique', SF, '      base = `${sessionId}.${now}-${n}`\n', '      break\n'],
  ['purge-by-name-age', SF, '    if (now - Number(match[1]) <= retentionMs) continue\n', ''],
  ['purge-only-dated-names', SF, '    const match = MOVED_FILE_RE.exec(name)\n    if (!match) continue\n', "    const match = MOVED_FILE_RE.exec(name) ?? [name, '0']\n"],
  // Status route: legacy state, additive outcome, recovery_pending.
  ['status-recovery-pending', MT, 'if (!saved && !durableSessionRecoveryHasRun()) {', 'if (false) {'],
  ['status-pending-not-for-saved', MT, 'if (!saved && !durableSessionRecoveryHasRun()) {', 'if (!durableSessionRecoveryHasRun()) {'],
  ['recovery-pending-logged-once', MT, '        recoveryPendingLogged = true\n', ''],
  ['status-reads-disposition', MT, "state === 'saved' || state === 'active' ? null : readCaptureDisposition(sessionId)", 'null'],
  ['status-saved-own-truth', MT, "state === 'saved' || state === 'active' ? null : readCaptureDisposition(sessionId)", "state === 'active' ? null : readCaptureDisposition(sessionId)"],
  ['status-active-own-truth', MT, "state === 'saved' || state === 'active' ? null : readCaptureDisposition(sessionId)", "state === 'saved' ? null : readCaptureDisposition(sessionId)"],
  ['outcome-null-for-saved-and-active', MT, "  if (state === 'saved' || state === 'active' || !disposition) return null\n", '  if (!disposition) return null\n'],
  ['outcome-receipted', MT, "  if (disposition.kind === 'no_speech') return 'receipted'\n", ''],
  ['outcome-recovered', MT, "  if (disposition.kind === 'recovered') return 'recovered'\n", ''],
  // Disposition reader.
  ['disposition-no-speech', UQ, ": receipt.outcome === 'no_speech'", ': false'],
  ['disposition-held-without-receipt', UQ, "  const kind: CaptureDispositionKind = !receipt\n    ? 'quarantined'\n    :", '  const kind: CaptureDispositionKind ='],
  ['disposition-all-dirs', UQ, '  return all.reduce((best, next) => DISPOSITION_RANK[next.kind] < DISPOSITION_RANK[best.kind] ? next : best)\n', '  return all[0]\n'],
  ['disposition-dot-boundary', UQ, '    if (dir !== sessionId && !dir.startsWith(`${sessionId}.`)) continue\n', '    if (!dir.startsWith(sessionId)) continue\n'],
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
    if (count !== 1 || find === replacement) { bad++; console.log(`${name}: ${count} matches in ${file}`) }
  }
  console.log(`${mutations.length - bad} of ${mutations.length} targets unique`); process.exit(bad ? 1 : 0)
}
const scratch = mkdtempSync(join(tmpdir(), 'stale-session-mutations-'))
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
    env: {
      PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json'),
      COS_MAINTENANCE_GATE_PATH: join(scratch, 'gate', 'maintenance-gate.json'),
    },
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
    const mutated = original.replace(find, replacement)
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    const result = run(), output = result.stdout + '\n' + result.stderr
    writeFileSync(target, original)
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    const killers = [...new Set([...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(m => m[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { survived.push(name); console.log(`${name} SURVIVED${result.error ? ' (harness: ' + result.error.message + ')' : ''}`); continue }
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${selected.length - survived.length} of ${selected.length} stale-session mutations killed`)
  if (survived.length) { console.log('SURVIVED: ' + survived.join(', ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
