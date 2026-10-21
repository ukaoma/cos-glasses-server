// Canary C7 (6.82.0, plan PLAN_work_orchestrator_glasses_work_routines_2026-10-20): more routines are safe.
// Pass line: two routines run ON SCHEDULE in a scratch data dir on a scratch port; a forced failure
// trips the breaker and stops it.
//
// Isolation, before any server module loads (importing them RUNS them):
//   HOME, COS_DATA_DIR, COS_PROFILE_PATH, COS_MAINTENANCE_GATE_PATH, COS_WORKDIR all point into one scratch
//   folder; COS_SCRIPTS_DIR and COS_OPERATIONS_DIR are removed, so the token audit lands in the scratch
//   ~/.cos-glasses/token-audit.jsonl. PATH starts with a scratch `claude` stub: a prompt naming
//   /canary-fail exits 1 (the forced failure); any other prompt answers. No real provider is spawned,
//   nothing reaches ~/.cos-glasses or ports 3141/3143, and the HTTP port is an ephemeral one.
//
// Usage: npx tsx server/scripts/routines-canary.ts <absolute scratch dir>   (not packaged)

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import type { AddressInfo } from 'node:net'

const scratch = process.argv[2]
if (!scratch || !isAbsolute(scratch)) throw new Error('usage: routines-canary.ts <absolute scratch dir>')
mkdirSync(scratch, { recursive: true })
const home = join(scratch, 'home'), data = join(scratch, 'data'), work = join(scratch, 'workspace'), bin = join(scratch, 'bin')
// The audit appends into ~/.cos-glasses, which a real install always has; the scratch home needs it made.
for (const dir of [home, join(home, '.cos-glasses'), data, bin, join(work, '.claude', 'skills', 'canary-ok'), join(work, '.claude', 'skills', 'canary-fail')]) mkdirSync(dir, { recursive: true })
writeFileSync(join(work, 'CLAUDE.md'), '# Canary C7 scratch COS workspace\n')
writeFileSync(join(work, '.claude', 'skills', 'canary-ok', 'SKILL.md'), '---\nname: canary-ok\ndescription: Answers.\n---\nSay ok.\n')
writeFileSync(join(work, '.claude', 'skills', 'canary-fail', 'SKILL.md'), '---\nname: canary-fail\ndescription: Always fails.\n---\nFail.\n')
const stub = join(bin, 'claude')
writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(join(scratch, 'claude-stub-calls.jsonl'))}, JSON.stringify({ args: args.slice(0, 12), at: new Date().toISOString() }) + '\\n')
if (args.includes('--version')) { console.log('2.1.999 (Claude Code canary stub)'); process.exit(0) }
if (args.includes('--help')) { console.log('canary stub'); process.exit(0) }
let input = ''
process.stdin.on('data', c => { input += c })
process.stdin.on('end', () => {
  if (input.includes('/canary-fail')) { process.stderr.write('forced failure for canary C7\\n'); process.exit(1) }
  const sid = '11111111-2222-4333-8444-' + String(Date.now()).slice(-12).padStart(12, '0')
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-canary' }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Canary routine ran.' }] } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'Canary routine ran.', session_id: sid }) + '\\n')
  process.exit(0)
})
`)
chmodSync(stub, 0o755)

process.env.HOME = home
process.env.COS_DATA_DIR = data
process.env.COS_PROFILE_PATH = join(data, '.cos-profile.json')
process.env.COS_MAINTENANCE_GATE_PATH = join(scratch, 'gate', 'maintenance-gate.json')
process.env.COS_WORKDIR = work
process.env.PATH = `${bin}:${process.env.PATH}`
process.env.COS_DIARIZER = 'embedding'
for (const key of ['COS_SCRIPTS_DIR', 'COS_OPERATIONS_DIR', 'COS_MEETINGS_ROOT', 'COS_LAUNCH_DIR', 'COS_ROUTINES', 'COS_DURABLE_QUERY_JOBS', 'COS_KEY_LANES']) delete process.env[key]

const log = (line: string) => console.log(`[C7] ${line}`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const express = (await import('express')).default
const { initQueryJobRuntime, shutdownQueryJobRuntime } = await import('../lib/query-job-runtime.js')
const { getRoutineRegistry, getRoutineScheduler, routineSkillCatalog, startRoutineScheduler, stopRoutineScheduler } = await import('../lib/routines-runtime.js')
const { createRoutinesRouter } = await import('../routes/routines.js')
const { dataPath } = await import('../lib/data-dir.js')

if (!dataPath('x').startsWith(data)) throw new Error(`data path escaped the scratch dir: ${dataPath('x')}`)
const health = await initQueryJobRuntime()
log(`durable store ${health.store.state}`)

const app = express()
app.use(express.json())
app.use('/api', createRoutinesRouter(getRoutineRegistry, routineSkillCatalog))
const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const port = (server.address() as AddressInfo).port
if (port === 3141 || port === 3143) throw new Error('refusing a production port')
const base = `http://127.0.0.1:${port}/api`
log(`scratch server on 127.0.0.1:${port}, data ${data}`)
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

// The slot: the next whole minute at least 40 s away, in the server zone, every day.
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
const slotAt = Math.ceil((Date.now() + 40_000) / 60_000) * 60_000
const hhmm = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(slotAt))
const days = [0, 1, 2, 3, 4, 5, 6]
const okR = await call('POST', '/routines', { skill: 'canary-ok', name: 'Canary OK', time: hhmm, days, timezone: zone, dailyCap: 3 })
const failR = await call('POST', '/routines', { skill: 'canary-fail', name: 'Canary forced failure', time: hhmm, days, timezone: zone, dailyCap: 5, breaker: { failures: 2, cooldownMinutes: 60 } })
if (okR.status !== 201 || failR.status !== 201) throw new Error(`create failed: ${JSON.stringify([okR.json, failR.json])}`)
const okId = okR.json.routine.id as string, failId = failR.json.routine.id as string
log(`created ${okId} (/canary-ok) and ${failId} (/canary-fail) for ${hhmm} ${zone}; next ${okR.json.routine.nextRunAt}`)

// The production singleton, its production 30 s tick. Nothing is fired by hand before the slot.
startRoutineScheduler()
const before = await call('GET', `/routines/${okId}/runs`)
if (before.json.runs.length !== 0) throw new Error('a run existed before the slot')

const deadline = slotAt + 150_000
let okRun: any = null, failRun: any = null
while (Date.now() < deadline) {
  await sleep(5_000)
  okRun = (await call('GET', `/routines/${okId}/runs`)).json.runs[0] ?? null
  failRun = (await call('GET', `/routines/${failId}/runs`)).json.runs[0] ?? null
  if (okRun?.status === 'completed' && failRun && ['failed', 'interrupted'].includes(failRun.status)) break
}
log(`scheduled: ok ${okRun?.status} (fired ${okRun?.firedAt}, trigger ${okRun?.trigger}); fail ${failRun?.status} (fired ${failRun?.firedAt}, trigger ${failRun?.trigger})`)
await getRoutineScheduler().tick() // count the failed run now rather than at the next 30 s tick
const afterOne = (await call('GET', `/routines/${failId}`)).json.routine.breakerState
log(`breaker after the scheduled failure: ${JSON.stringify(afterOne)}`)

// Second failure (Run now) reaches failures: 2 and trips it.
const second = await call('POST', `/routines/${failId}/run`)
log(`Run now on the failing routine: ${second.status}`)
for (let i = 0; i < 24; i++) {
  await sleep(2_500)
  const latest = (await call('GET', `/routines/${failId}/runs`)).json.runs[0]
  if (latest && latest.trigger === 'manual' && ['failed', 'interrupted'].includes(latest.status)) break
}
await getRoutineScheduler().tick()
const tripped = (await call('GET', `/routines/${failId}`)).json.routine
log(`breaker after the second failure: ${JSON.stringify(tripped.breakerState)} gate ${tripped.gate} next ${tripped.nextRunAt}`)
const refused = await call('POST', `/routines/${failId}/run`)
const tick = await getRoutineScheduler().tick()
log(`Run now while open: ${refused.status} ${refused.json?.error?.code}; next tick skipped it as ${tick.skipped[failId]}`)
const okAfter = (await call('GET', `/routines/${okId}`)).json.routine
const list = (await call('GET', '/routines')).json

const auditFile = join(home, '.cos-glasses', 'token-audit.jsonl')
const audit = existsSync(auditFile) ? readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const auditCallers = audit.map(row => `${row.caller} (${row.model})`)
const stubCalls = existsSync(join(scratch, 'claude-stub-calls.jsonl')) ? readFileSync(join(scratch, 'claude-stub-calls.jsonl'), 'utf8').trim().split('\n').length : 0

const checks = {
  okRanOnSchedule: okRun?.trigger === 'scheduled' && okRun?.status === 'completed' && Date.parse(okRun.firedAt) >= slotAt - 1_000,
  failRanOnSchedule: failRun?.trigger === 'scheduled' && ['failed', 'interrupted'].includes(failRun?.status) && Date.parse(failRun.firedAt) >= slotAt - 1_000,
  breakerCountedFirst: afterOne?.consecutiveFailures === 1 && afterOne?.state === 'closed',
  breakerTripped: tripped.breakerState?.state === 'open' && tripped.gate === 'breaker_open' && tripped.nextRunAt === null,
  runNowRefused: refused.status === 423 && refused.json?.error?.code === 'breaker_open',
  tickStopsIt: tick.skipped[failId] === 'breaker_open',
  otherRoutineUnaffected: okAfter.breakerState?.state === 'closed' && okAfter.gate === 'ready',
  briefStillRoutineOne: list.routines[0]?.id === 'morning-brief' && list.routines.length === 3,
  auditByCaller: audit.some(row => row.caller === `routine:${okId}`) && audit.every(row => row.model === 'sonnet'),
  noProductionPath: !JSON.stringify(list).includes('/.cos-glasses/'),
}
const pass = Object.values(checks).every(Boolean)
const report = { pass, checks, port, zone, slot: hhmm, okId, failId, okRun, failRun, breaker: tripped.breakerState, refused: refused.json, tickSkipped: tick.skipped, auditCallers, stubCalls, routines: list.routines.map((r: any) => ({ id: r.id, kind: r.kind, gate: r.gate, enabled: r.enabled, time: r.time })) }
writeFileSync(join(scratch, 'c7-report.json'), JSON.stringify(report, null, 2))
log(`checks ${JSON.stringify(checks)}`)
log(pass ? 'PASS' : 'FAIL')

stopRoutineScheduler()
await shutdownQueryJobRuntime('canary_done').catch(() => undefined)
await new Promise(r => server.close(r))
process.exit(pass ? 0 : 1)

export {}
