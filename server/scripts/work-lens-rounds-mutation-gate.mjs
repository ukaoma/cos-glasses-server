#!/usr/bin/env node
// Lens plans mutation gate (6.83.0: lens rounds in Work chat history, Send this plan). Mutations run only in a disposable copy of server/ and shared/; the live
// checkout is never rewritten. Same proof as the autonomous-save gate:
//   0. The target suites are GREEN unmutated (a gate over a red suite proves nothing).
//   1. Each target string appears EXACTLY ONCE in its file.  2. The mutated file differs.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or harness failure is not a kill.
//   4. The file is restored byte for byte before the next mutant.
// Usage: node server/scripts/work-lens-rounds-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tests = [
  'server/routes/work-lens-rounds.test.ts',
  'server/routes/work-chat.test.ts',
]
const LR = 'server/lib/work-lens-rounds.ts', RR = 'server/routes/work-lens-rounds.ts', WR = 'server/routes/work-chat.ts'
const EXPECTED_SURVIVORS = new Set([])
const mutations = [
  // The record body.
  ['lr-v-gate', LR, "  if (v.v !== 1) throw invalid('v')\n", ''],
  ['lr-workid', LR, "  if (!str(v.workID, 256) || !WORK_ID.test(v.workID)) throw invalid('workID')\n", ''],
  ['lr-question-bound', LR, "  if (!str(v.question, LENS_QUESTION_CHARS) || !v.question.trim()) throw invalid('question')\n", ''],
  ['lr-answer-bound', LR, "if (!str(v.answer, LENS_ANSWER_CHARS)) throw invalid('answer')", "if (typeof v.answer !== 'string') throw invalid('answer')"],
  ['lr-source-lens', LR, "  if (v.source !== 'lens') throw invalid('source')\n", ''],
  ['lr-ids-in-order', LR, "a.id !== `a${i + 1}`", "typeof a.id !== 'string'"],
  ['lr-continue-needs-session', LR, "  if (mode !== 'newSession' && !(str(a.sessionID, 64) && SID.test(a.sessionID))) throw invalid('assignments.sessionID')\n", ''],
  ['lr-new-session-provider', LR, "mode === 'newSession' ? !['claude', 'codex'].includes(a.provider)", "mode === 'newSession' ? false"],
  ['lr-prompt-bound', LR, "!str(a.prompt, LENS_PROMPT_CHARS)", "typeof a.prompt !== 'string'"],
  ['lr-assignment-cap', LR, "!Array.isArray(v.assignments) || v.assignments.length > WORK_CHAT_MAX_ASSIGNMENTS) throw invalid('assignments')", "!Array.isArray(v.assignments)) throw invalid('assignments')"],
  // Plan stale.
  ['lr-stale-size', LR, "return after.length !== before.size || after.some(s => !before.has(s))", "return after.some(s => !before.has(s))"],
  ['lr-stale-members', LR, "return after.length !== before.size || after.some(s => !before.has(s))", "return after.length !== before.size"],
  ['lr-stale-own-excluded', LR, "  const after = now.filter(s => !own.has(s))\n", "  const after = now\n"],
  ['lr-stale-unknown', LR, "  if (!round.cardSessions || !now) return false\n", ''],
  ['lr-card-fork-source', LR, "if (r.sessionID && !(r.mode === 'fork' && r.sessionID === r.sourceSessionID)) out.add(r.sessionID)", "if (r.sessionID) out.add(r.sessionID)"],
  ['lr-card-fork-child', LR, "    if (r.forkChildID) out.add(r.forkChildID)\n", ''],
  // Outcomes, expiry and bounds.
  ['lr-outcome-partly', LR, "  if (sent > 0) return 'partly_sent'\n", ''],
  ['lr-outcome-stopped', LR, "  if (states.every(s => s === 'stopped')) return 'stopped'\n", ''],
  ['lr-outcome-failed', LR, "return states.every(s => s === 'refused' || s === 'stopped') ? 'refused' : 'failed'", "return 'refused'"],
  // COS Control's own Send on the Mac (QA 6.10.651 blocker: a later lens send must never deliver twice).
  ['lr-already-held', LR, "const ALREADY: readonly AssignmentState[] = ['sent', 'delivered', 'held']", "const ALREADY: readonly AssignmentState[] = ['sent', 'delivered']"],
  ['lr-already-lists-ids', LR, "{ assignmentIds: r.assignments.map(a => a.id).filter(sentAlready) }", "{}"],
  ['lr-mac-records', LR, "    r.mac = { at: now, ids: [...new Set([...(r.mac?.ids ?? []), ...results.map(x => x.id)])] }\n", ''],
  ['lr-mac-view', LR, "  if (r.mac && (!send || r.mac.at >= send.requestedAt)) {", "  if (false) {"],
  ['lr-mac-partial', LR, "    if (state === 'sent' && r.mac.ids.length < r.assignments.length) state = 'partly_sent'\n", ''],
  ['rr-local-mac', RR, "    local(req)\n    const round = deps.store.reportMac", "    const round = deps.store.reportMac"],
  ['lr-settle-terminal', LR, "if (states.every(s => TERMINAL.includes(s)))", "if (true)"],
  ['lr-pickup-expiry', LR, "now - send.requestedAt > LENS_SEND_PICKUP_MS", "false"],
  ['lr-report-timeout', LR, "now - send.pickedUpAt > LENS_SEND_REPORT_MS", "false"],
  ['lr-ttl', LR, "const kept = this.file.rounds.filter(r => now - r.recordedAt <= LENS_ROUND_TTL_MS)", "const kept = this.file.rounds"],
  ['lr-cap-200', LR, "    while (this.file.rounds.length > LENS_ROUNDS_MAX) {", "    while (false) {"],
  ['lr-cap-keeps-active', LR, "this.file.rounds.splice(idle >= 0 ? idle : 0, 1)", "this.file.rounds.splice(0, 1)"],
  ['lr-idempotent', LR, "    if (existing) return { round: existing, created: false }\n", ''],
  ['lr-unreadable-aside', LR, "      try { renameSync(path, aside) } catch { /* nothing to move */ }\n", ''],
  ['lr-test-store-in-memory', LR, "process.env.VITEST || process.env.NODE_ENV === 'test' ? null : ", ''],
  // Send rules.
  ['lr-in-progress', LR, "    if (this.active(r)) throw new LensRoundError('send_in_progress', 409, 'This plan is already being sent.')\n", ''],
  ['lr-already-sent', LR, "if (!ids.length || ids.some(sentAlready))", "if (!ids.length)"],
  ['lr-whole-plan-skips-sent', LR, ".map(a => a.id).filter(id => !sentAlready(id))", ".map(a => a.id)"],
  ['lr-confirm-required', LR, "if (body.confirm !== 'two-step' && !r.autoSendCard)", "if (false)"],
  ['lr-auto-send-card', LR, "if (body.confirm !== 'two-step' && !r.autoSendCard)", "if (body.confirm !== 'two-step')"],
  ['lr-control-required', LR, "    if (!checks.controlConnected) throw new LensRoundError('control_not_connected', 423,", "    if (false) throw new LensRoundError('control_not_connected', 423,"],
  ['lr-stop-control-required', LR, "    if (!controlConnected) throw new LensRoundError('control_not_connected', 423, 'COS Control is not connected. Stop it from the Mac.')\n", ''],
  ['lr-fresh-60s', LR, "connected: age <= LENS_CONTROL_FRESH_MS", "connected: true"],
  // The inbox.
  ['lr-pickup-once', LR, "s.state === 'send_requested') { s.state = 'sending';", "(s.state === 'send_requested' || s.state === 'sending')) { s.state = 'sending';"],
  ['lr-stop-once', LR, "if (room > 0 && s.pickedUpAt === null)", "if (room > 0)"],
  ['lr-inbox-cap', LR, "let room = LENS_INBOX_MAX, changed = false", "let room = Infinity, changed = false"],
  ['lr-inbox-since', LR, "!r.inHistory && r.seq > since", "!r.inHistory"],
  ['lr-inbox-history', LR, "!r.inHistory && r.seq > since", "r.seq > since"],
  ['lr-report-picked-up', LR, "    if (send.state === 'send_requested' || send.state === 'expired') throw new LensRoundError('send_not_picked_up'", "    if (false) throw new LensRoundError('send_not_picked_up'"],
  ['lr-view-hides-prompts', LR, "assignments: r.assignments.map(a => ({ id: a.id, state: a.state,", "assignments: r.assignments.map(a => ({ id: a.id, prompt: a.prompt, state: a.state,"],
  // Routes.
  ['rr-known-work', RR, "      if (!known) throw new LensRoundError('unknown_work', 404,", "      if (false) throw new LensRoundError('unknown_work', 404,"],
  ['rr-known-snapshot-first', RR, "    if (s && (s.links.some(l => l.workID === workID) || s.receipts.some(r => r.workID === workID))) return true\n", ''],
  ['rr-body-cap', RR, "> LENS_ROUND_BODY_BYTES) {", "> Infinity) {"],
  ['rr-201-vs-200', RR, "res.status(created ? 201 : 200)", "res.status(201)"],
  ['rr-admissions', RR, "    if (!deps.admissions()) return res.status(503).json(MAINTENANCE)\n", ''],
  ['rr-lease-maintenance', RR, "    try { lease = deps.lease() } catch { return res.status(503).json(MAINTENANCE) }", "    lease = deps.lease()"],
  ['rr-lease-released', RR, ".finally(() => lease.release())", ""],
  ['rr-local-inbox', RR, "      local(req)\n      const { since, autoSend } = req.query", "      const { since, autoSend } = req.query"],
  ['rr-local-history', RR, "    local(req)\n    const roundId = roundIdOf(req)\n    const b = req.body", "    const roundId = roundIdOf(req)\n    const b = req.body"],
  ['rr-local-result', RR, "    local(req)\n    const id = String(req.params.sendRequestId", "    const id = String(req.params.sendRequestId"],
  ['rr-card-sessions-at-send', RR, "cardSessions: cardSessionsOf(deps.snapshot(), round.workID), controlConnected", "cardSessions: null, controlConnected"],
  ['rr-card-sessions-at-record', RR, "deps.store.record(input, cardSessionsOf(deps.snapshot(), input.workID))", "deps.store.record(input, null)"],
  ['rr-history-autosend', RR, "    const round = deps.store.markInHistory(roundId, b.autoSendCard)", "    const round = deps.store.markInHistory(roundId, undefined)"],
  ['rr-inbox-autosend', RR, "deps.store.inbox(since === undefined ? 0 : Number(since), autoSend === '1')", "deps.store.inbox(since === undefined ? 0 : Number(since), false)"],
  // The capability.
  ['wr-lens-plans-capability', WR, ",\n    lensPlans:1,lensPlansControl:deps.lensPlansControl()}))", "}))"],
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
const scratch = mkdtempSync(join(tmpdir(), 'work-lens-rounds-mutations-'))
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
  console.log(`${selected.length - survived.length - expectedCount} of ${selected.length} lens-plans mutations killed by a named test; ${expectedCount} expected survivors`)
  if (survived.length) { console.log('SURVIVED: ' + survived.join(', ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
