// X1, 7.0.34 (Miles 2026-11-13 15:02, "I want the 8 hour question hold ON. please keep it on by default."): the
// question hold's three states. What this file pins, each case at every layer it touches:
//   - UNSET with old hooks (the one 630 block, any earlier script) is 7.0.33 with the switch OFF, byte for byte:
//     the same hook block, script status and status words (no banner), hold times, questions route shape, words
//     to browsers and web door. Only the additive `questionWait` field is new.
//   - UNSET with reinstalled hooks (the 28,800 s question block) is the full hold.
//   - Explicit 0 (env or setting) is off in both cases; explicit 1 is today's on.
//   - The environment beats the setting; the setting route refuses browsers and what it cannot apply.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_HOLD_MIN_STAMP_S, FULL_HOLD_QUESTION_WAIT_S, defaultHoldTakesStamp, fullHoldSwitches, questionHoldMode, type FullHoldSwitches } from './full-hold.js'
import { hookStatus, installClaudeHooks, permissionHookPlan, questionWaitStatus } from './claude-hooks-installer.js'
import { questionHoldSettingPath, readQuestionHoldSetting, writeQuestionHoldSetting } from './question-hold-setting.js'
import { HOOK_REPLY_MARGIN_S, PermissionBroker, type PermissionBrokerDeps } from './permission-broker.js'
import { ASK_INPUT, permissionEnvelope } from './__fixtures__/permission-broker.js'
import { API_AUTH_BY_LOCAL } from './api-auth.js'
import { invalidateHookStatus } from './session-hooks-runtime.js'
import { createSessionHooksRouter } from '../routes/session-hooks.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, '../../bin/hooks/cos-session-hook')
const FIXTURE_7031 = resolve(HERE, '__fixtures__/cos-session-hook-7.0.31')
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const UNSPLIT = { split: false, questionWaitS: 630, otherWaitS: 630 }

const roots: string[] = []
const temp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d }
const ENV_KEYS = ['COS_QUESTION_FULL_HOLD', 'COS_APPROVAL_FULL_HOLD', 'COS_GLASSES_HOME', 'CLAUDE_CONFIG_DIR'] as const
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]])) as Record<string, string | undefined>
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })
afterAll(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

function setQ(q: string | undefined) { if (q === undefined) delete process.env.COS_QUESTION_FULL_HOLD; else process.env.COS_QUESTION_FULL_HOLD = q }

function box() {
  const dir = temp('x1-qhd-')
  process.env.COS_GLASSES_HOME = join(dir, 'home')
  delete process.env.COS_APPROVAL_FULL_HOLD
  return {
    dir,
    settingsPath: join(dir, 'settings.json'),
    scriptPath: join(dir, 'home', 'bin', 'cos-session-hook'),
    hookPaths: { home: join(dir, 'home'), spoolDir: join(dir, 'home', 'data', 'hook-spool') },
  }
}
/** What 7.0.31 to 7.0.33 left on a Mac that never turned the hold on: the one 630 block and the 7.0.31 script. */
function oldHooks(b: ReturnType<typeof box>) {
  installClaudeHooks({ ...b, port: 3999, plan: UNSPLIT })
  copyFileSync(FIXTURE_7031, b.scriptPath)
}

describe('the switch: three states, the environment first', () => {
  it('unset is the default; 0 and 1 (any spelling) are the environment; anything else falls through', () => {
    expect(questionHoldMode({})).toEqual({ mode: 'default', source: 'default' })
    for (const on of ['1', 'true', 'on', ' ON ']) expect(questionHoldMode({ COS_QUESTION_FULL_HOLD: on })).toEqual({ mode: 'on', source: 'env' })
    for (const off of ['0', 'false', 'off', 'OFF ']) expect(questionHoldMode({ COS_QUESTION_FULL_HOLD: off })).toEqual({ mode: 'off', source: 'env' })
    for (const junk of ['', 'yes', '2', 'banana']) expect(questionHoldMode({ COS_QUESTION_FULL_HOLD: junk })).toEqual({ mode: 'default', source: 'default' })
  })
  it('the setting applies only when the environment says nothing; the environment beats it both ways', () => {
    expect(questionHoldMode({}, 'off')).toEqual({ mode: 'off', source: 'setting' })
    expect(questionHoldMode({}, 'on')).toEqual({ mode: 'on', source: 'setting' })
    expect(questionHoldMode({ COS_QUESTION_FULL_HOLD: '1' }, 'off')).toEqual({ mode: 'on', source: 'env' })
    expect(questionHoldMode({ COS_QUESTION_FULL_HOLD: '0' }, 'on')).toEqual({ mode: 'off', source: 'env' })
    expect(questionHoldMode({ COS_QUESTION_FULL_HOLD: 'banana' }, 'off')).toEqual({ mode: 'off', source: 'setting' })
  })
  it('the broker switches: default is neither on nor off', () => {
    expect(fullHoldSwitches({})).toEqual({ questions: false, approvals: false, questionsByDefault: true })
    expect(fullHoldSwitches({}, 'off')).toEqual({ questions: false, approvals: false, questionsByDefault: false })
    expect(fullHoldSwitches({}, 'on')).toEqual({ questions: true, approvals: false, questionsByDefault: false })
  })
  it('only a stamp longer than the 7.0.16 to 7.0.31 question block takes the default', () => {
    expect(DEFAULT_HOLD_MIN_STAMP_S).toBe(3600)
    for (const s of [null, undefined, 0, 130, 630, 3600]) expect(defaultHoldTakesStamp(s)).toBe(false)
    for (const s of [3601, FULL_HOLD_QUESTION_WAIT_S]) expect(defaultHoldTakesStamp(s)).toBe(true)
  })
  it('the setting file: on and off round-trip, default removes it, junk reads as none', () => {
    const home = temp('x1-qhd-set-')
    const p = questionHoldSettingPath(home)
    expect(readQuestionHoldSetting(p)).toBeNull()
    writeQuestionHoldSetting('off', p); expect(readQuestionHoldSetting(p)).toBe('off')
    writeQuestionHoldSetting('on', p); expect(readQuestionHoldSetting(p)).toBe('on')
    writeQuestionHoldSetting('default', p); expect(existsSync(p)).toBe(false)
    writeFileSync(p, '{"mode":"maybe"}'); expect(readQuestionHoldSetting(p)).toBeNull()
    writeFileSync(p, 'not json'); expect(readQuestionHoldSetting(p)).toBeNull()
  })
})

describe('hooks and status', () => {
  it('UNSET + old hooks = 7.0.33 off: same block, installed with the 7.0.31 script, no banner, only questionWait added', () => {
    const b = box()
    oldHooks(b)
    const bytes = readFileSync(b.settingsPath, 'utf-8')
    setQ(undefined)
    const unset = hookStatus(b)
    setQ('0')
    const off = hookStatus(b)
    expect(unset.state).toBe('installed')
    expect(unset.scriptSha).toBe(sha(FIXTURE_7031))
    const { questionWait: qUnset, ...restUnset } = unset
    const { questionWait: qOff, ...restOff } = off
    expect(restUnset).toEqual(restOff)
    expect('permissionHookTimeouts' in unset).toBe(false)
    expect(qUnset).toEqual({ mode: 'default', source: 'default', installedWaitS: 630, waitS: FULL_HOLD_QUESTION_WAIT_S, active: false, offered: true })
    expect(qOff).toEqual({ mode: 'off', source: 'env', installedWaitS: 630, waitS: FULL_HOLD_QUESTION_WAIT_S, active: false, offered: false })
    expect(readFileSync(b.settingsPath, 'utf-8')).toBe(bytes)
    // The status plan for unset + old hooks is the one block, so the merge it would compare against is 7.0.33's.
    setQ(undefined)
    expect(permissionHookPlan(process.env, { setting: null, installedQuestionWaitS: 630 })).toEqual(UNSPLIT)
  })

  it('UNSET + Reinstall hooks = the long question block and this script; status installed, active', () => {
    const b = box()
    oldHooks(b)
    setQ(undefined)
    const r = installClaudeHooks({ ...b, port: 3999 })
    expect(r.ok).toBe(true)
    expect(sha(b.scriptPath)).toBe(sha(SCRIPT))
    const written = JSON.parse(readFileSync(b.settingsPath, 'utf-8')).hooks.PermissionRequest as Array<{ matcher?: string; hooks: Array<{ timeout: number }> }>
    expect(written.map(x => [x.matcher, x.hooks[0]!.timeout])).toEqual([['AskUserQuestion', FULL_HOLD_QUESTION_WAIT_S], ['^(?!AskUserQuestion$).*', 630]])
    const status = hookStatus(b)
    expect(status.state).toBe('installed')
    expect(status.permissionHookTimeouts).toEqual({ question: FULL_HOLD_QUESTION_WAIT_S, approval: 630 })
    expect(status.questionWait).toMatchObject({ mode: 'default', active: true, offered: false, installedWaitS: FULL_HOLD_QUESTION_WAIT_S })
  })

  it('explicit 0 after a Reinstall under the default: drift (put it back), and Reinstall restores the 7.0.33 bytes', () => {
    const b = box()
    setQ('0')
    installClaudeHooks({ ...b, port: 3999 })
    const offBytes = readFileSync(b.settingsPath, 'utf-8')
    setQ(undefined)
    installClaudeHooks({ ...b, port: 3999 })
    setQ('0')
    const s = hookStatus(b)
    expect([s.state, s.priorWaitOnly]).toEqual(['drift', true])
    expect(s.questionWait).toMatchObject({ mode: 'off', active: false, offered: false })
    installClaudeHooks({ ...b, port: 3999 })
    expect(readFileSync(b.settingsPath, 'utf-8')).toBe(offBytes)
  })

  it('the setting file decides when the environment is silent, read from the hooks\' own COS home', () => {
    const b = box()
    oldHooks(b)
    setQ(undefined)
    writeQuestionHoldSetting('off', questionHoldSettingPath(b.hookPaths.home))
    expect(hookStatus(b).questionWait).toMatchObject({ mode: 'off', source: 'setting', offered: false })
    // Reinstall under a setting of off writes the one block (nothing changes).
    const before = readFileSync(b.settingsPath, 'utf-8')
    installClaudeHooks({ ...b, port: 3999 })
    expect(readFileSync(b.settingsPath, 'utf-8')).toBe(before)
    // The environment beats it.
    setQ('1')
    expect(hookStatus(b).questionWait).toMatchObject({ mode: 'on', source: 'env' })
    expect(hookStatus(b).state).toBe('drift')
  })

  it('explicit 1 is today\'s on: old hooks read drift until Reinstall writes the long block', () => {
    const b = box()
    oldHooks(b)
    setQ('1')
    expect(hookStatus(b).state).toBe('drift')
    installClaudeHooks({ ...b, port: 3999 })
    expect(hookStatus(b).permissionHookTimeouts).toEqual({ question: FULL_HOLD_QUESTION_WAIT_S, approval: 630 })
  })

  it('questionWaitStatus: active needs the long block and not off; offered only under the default', () => {
    expect(questionWaitStatus({}, null, 630)).toMatchObject({ active: false, offered: true })
    expect(questionWaitStatus({}, null, FULL_HOLD_QUESTION_WAIT_S)).toMatchObject({ active: true, offered: false })
    expect(questionWaitStatus({ COS_QUESTION_FULL_HOLD: '0' }, null, FULL_HOLD_QUESTION_WAIT_S)).toMatchObject({ active: false, offered: false })
    expect(questionWaitStatus({ COS_QUESTION_FULL_HOLD: '1' }, null, 630)).toMatchObject({ active: false, offered: false })
  })
})

// The broker, through the same harness shape as permission-broker-full-hold.test.ts.
const OFF: FullHoldSwitches = { questions: false, approvals: false, questionsByDefault: false }
const DEFAULT: FullHoldSwitches = { questions: false, approvals: false, questionsByDefault: true }
const ON: FullHoldSwitches = { questions: true, approvals: false, questionsByDefault: false }

function harness(switches: FullHoldSwitches, questionBlockS: number, opts: { holdClient?: boolean } = {}) {
  const s = { now: 1_000_000, switches, engineReads: 0, questionBlockS }
  let seq = 0
  const deps: PermissionBrokerDeps = {
    now: () => s.now, mode: () => 'all', admissionsOpen: () => true,
    lastQuestionsPollAt: () => (opts.holdClient ? s.now : null), lastLegacyPollAt: () => null,
    lastHoldPollAt: () => (opts.holdClient ? s.now : null), presenceAgeMs: () => (opts.holdClient ? 1_000 : null),
    readDeskIdleSeconds: async () => 0, deskIdleSeconds: () => 90,
    timeoutMs: () => 110_000, awayHoldMs: () => 600_000, installedHookTimeoutS: () => Math.min(s.questionBlockS, 630),
    installedHookTimeoutForKindS: kind => (kind === 'question' ? s.questionBlockS : 630),
    fullHold: () => s.switches,
    engineFor: () => { s.engineReads++; return { entrypoint: 'cli', version: '2.1.322', host: 'terminal' } },
    pollMs: 60_000, newId: () => `pq_${String(++seq).padStart(24, '0')}`,
  }
  const b = new PermissionBroker(deps)
  live.push(b)
  return { s, b }
}
const live: PermissionBroker[] = []
afterEach(() => { for (const b of live.splice(0)) b.stop() })
const ask = (hookWaitS: number) => ({ ...permissionEnvelope('AskUserQuestion', ASK_INPUT, { tool_use_id: 'toolu_q1' }, 1_000_000), hookWaitS, askHold: 1 })

/** Everything the broker exposes about one question, for an off-vs-default comparison. */
async function outcome(switches: FullHoldSwitches, block: number, stamp: number, holdClient: boolean) {
  const h = harness(switches, block, { holdClient })
  const r = await h.b.admit(ask(stamp))
  return {
    ok: r.ok,
    reason: r.ok ? null : r.reason,
    fullHold: r.ok ? r.request.fullHold ?? false : null,
    deadlineAt: r.ok ? r.request.deadlineAt : null,
    lensVisible: r.ok ? r.request.lensVisible : null,
    extended: h.b.extendedQuestionsView(),
    web: h.b.webAnswerRules(),
    waiting: h.b.waitingList().length,
    engineReads: h.s.engineReads,
  }
}

describe('the broker', () => {
  it('UNSET + old hooks (stamp 630) = OFF exactly: hold, lens, words to browsers, web door, no registry read', async () => {
    for (const holdClient of [false, true]) {
      const off = await outcome(OFF, 630, 630, holdClient)
      const dflt = await outcome(DEFAULT, 630, 630, holdClient)
      expect(dflt).toEqual(off)
      expect(dflt.fullHold === true).toBe(false)
      expect(dflt.extended).toBe(false)
      expect(dflt.engineReads).toBe(0)
    }
  })

  it('UNSET + the 7.0.16 to 7.0.31 question block (stamp 3600) is still off: only the 8 h block opts in', async () => {
    expect(await outcome(DEFAULT, 3600, 3600, true)).toEqual(await outcome(OFF, 3600, 3600, true))
  })

  it('UNSET + reinstalled hooks (stamp 28,800) = the full hold: 8 h less the margin, at once, the extended view and web door', async () => {
    const o = await outcome(DEFAULT, FULL_HOLD_QUESTION_WAIT_S, FULL_HOLD_QUESTION_WAIT_S, false)
    expect(o.ok).toBe(true)
    expect(o.fullHold).toBe(true)
    expect(o.deadlineAt).toBe(1_000_000 + (FULL_HOLD_QUESTION_WAIT_S - HOOK_REPLY_MARGIN_S) * 1000)
    expect(o.lensVisible).toBe(true)
    expect(o.extended).toBe(true)
    expect(o.web.touchRequired).toBe(true)
  })

  it('UNSET on a reinstalled Mac, from a session still on its old hooks (stamp 630): that question is not held', async () => {
    const o = await outcome(DEFAULT, FULL_HOLD_QUESTION_WAIT_S, 630, false)
    expect(o.fullHold === true).toBe(false)
  })

  it('explicit OFF with the long block and a long stamp: not held, no extended view', async () => {
    const o = await outcome(OFF, FULL_HOLD_QUESTION_WAIT_S, FULL_HOLD_QUESTION_WAIT_S, false)
    expect(o.fullHold === true).toBe(false)
    expect(o.extended).toBe(false)
  })

  it('explicit ON is today\'s on: even the one 630 block is held its whole wait', async () => {
    const o = await outcome(ON, 630, 630, false)
    expect(o.fullHold).toBe(true)
    expect(o.deadlineAt).toBe(1_000_000 + (630 - HOOK_REPLY_MARGIN_S) * 1000)
  })

  it('a question held under the default stays held on a tick; turning the hold off hands it back to the Mac', async () => {
    const h = harness(DEFAULT, FULL_HOLD_QUESTION_WAIT_S)
    const r = await h.b.admit(ask(FULL_HOLD_QUESTION_WAIT_S))
    if (!r.ok) throw Error(r.reason)
    const sent: Record<string, unknown>[] = []
    h.b.park(r.request, { writable: () => true, reply: body => { sent.push(body); return true } })
    h.s.now += 1_000
    await h.b.tick()
    expect(sent).toEqual([])
    h.s.switches = OFF
    await h.b.tick()
    expect(sent.length).toBe(1)
  })
})

describe('PUT /api/session-hooks/question-hold', () => {
  const servers: Server[] = []
  afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))) })
  async function start() {
    const b = box()
    process.env.CLAUDE_CONFIG_DIR = b.dir
    // The route reads the status with the server's own default paths, so the hooks are installed with them too.
    installClaudeHooks({ settingsPath: b.settingsPath, scriptPath: b.scriptPath, port: 3999, plan: UNSPLIT })
    copyFileSync(FIXTURE_7031, b.scriptPath)
    invalidateHookStatus()
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => { if (req.get('x-test-auth') === 'token') res.locals[API_AUTH_BY_LOCAL] = 'token'; next() })
    app.use('/api', createSessionHooksRouter({ port: 3999 }))
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    servers.push(server)
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const put = (body: unknown, auth = 'token') => fetch(`${base}/api/session-hooks/question-hold`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-test-auth': auth }, body: JSON.stringify(body) })
    return { b, put, file: questionHoldSettingPath(b.hookPaths.home) }
  }

  it('the Mac app writes it, and the status answers with the new state', async () => {
    setQ(undefined)
    const h = await start()
    const res = await h.put({ mode: 'off' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, questionWait: { mode: 'off', source: 'setting' }, state: 'installed' })
    expect(readQuestionHoldSetting(h.file)).toBe('off')
    const back = await h.put({ mode: 'default' })
    expect(await back.json()).toMatchObject({ ok: true, questionWait: { mode: 'default', offered: true } })
    expect(existsSync(h.file)).toBe(false)
  })

  it('a browser session is refused; a bad mode is refused; nothing is written', async () => {
    setQ(undefined)
    const h = await start()
    expect((await h.put({ mode: 'off' }, 'cookie')).status).toBe(403)
    expect((await h.put({ mode: 'maybe' })).status).toBe(400)
    expect(existsSync(h.file)).toBe(false)
  })

  it('while the environment decides, nothing is written and the answer says so', async () => {
    setQ('0')
    const h = await start()
    const res = await h.put({ mode: 'on' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ ok: false, reason: 'set_by_env', questionWait: { mode: 'off', source: 'env' } })
    expect(existsSync(h.file)).toBe(false)
  })
})

