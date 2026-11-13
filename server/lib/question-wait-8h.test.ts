// X1 (Miles 2026-11-12 17:42): a fully held question waits 8 hours and shows on every surface at once. This file
// pins what keeps that change invisible to a Mac that never turns COS_QUESTION_FULL_HOLD on:
//   - the hook script differs from 7.0.31's in ONE line (the longest wait it stamps), pinned to the constant;
//   - with the question switch off, the 7.0.31 script reads current (no Reinstall banner, Cursor and Codex cancel
//     unchanged); with it on, it reads `script_outdated` until Reinstall hooks;
//   - a turn-end ask asked 6 to 8 h before a restart survives it (the tracker replays to its own age-out) while
//     the signal store still replays only its 6 h.
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FULL_HOLD_HOOK_WAIT_S, FULL_HOLD_QUESTION_WAIT_PRIOR_S, FULL_HOLD_QUESTION_WAIT_S } from './full-hold.js'
import {
  WAIT_CAP_ONLY_PRIOR_SCRIPT_SHAS, cursorDeskHaltReady, hookHaltReady, hookStatus, installClaudeHooks, permissionHookPlan, scriptCurrentForPlan,
} from './claude-hooks-installer.js'
import { codexHookStatus, installCodexHooks } from './codex-hooks-installer.js'
import { HOOK_REPLY_MARGIN_S, HOOK_WAIT_STAMP_MAX_S, holdCeilingS } from './permission-broker.js'
import { LEDGER_REPLAY_WINDOW_MS, __resetSessionHooksForTests, sessionHooksHealthFields, sessionSignalStore, startSessionHooksRuntime, turnAskReplayExtraMs, turnEndAskStats } from './session-hooks-runtime.js'
import { TURN_ASK_MAX_AGE_MS, WRAP_UP_TOOL, __setTurnEndAsksForTests } from './turn-end-ask.js'
import { dataPath } from './data-dir.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, '../../bin/hooks/cos-session-hook')
const FIXTURE_7031 = resolve(HERE, '__fixtures__/cos-session-hook-7.0.31')
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

const roots: string[] = []
afterAll(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d }

describe('one number: 8 hours', () => {
  it('every wait is derived from FULL_HOLD_QUESTION_WAIT_S, with the margin kept', () => {
    expect(FULL_HOLD_QUESTION_WAIT_S).toBe(8 * 60 * 60)
    expect(HOOK_WAIT_STAMP_MAX_S).toBe(FULL_HOLD_QUESTION_WAIT_S)
    // The broker's deadline is 10 s inside the hook's own wait; the script's curl 5 s inside it.
    expect(holdCeilingS(FULL_HOLD_QUESTION_WAIT_S, FULL_HOLD_QUESTION_WAIT_S)).toBe(FULL_HOLD_QUESTION_WAIT_S - HOOK_REPLY_MARGIN_S)
    expect(holdCeilingS(FULL_HOLD_QUESTION_WAIT_S, FULL_HOLD_QUESTION_WAIT_S)).toBeLessThan(FULL_HOLD_QUESTION_WAIT_S - 5)
    // Approvals are not part of this change.
    expect(FULL_HOLD_HOOK_WAIT_S).toBe(3600)
    expect(permissionHookPlan({ COS_APPROVAL_FULL_HOLD: '1' })).toEqual({ split: true, questionWaitS: 630, otherWaitS: FULL_HOLD_HOOK_WAIT_S })
    expect(permissionHookPlan({ COS_QUESTION_FULL_HOLD: '1' })).toEqual({ split: true, questionWaitS: FULL_HOLD_QUESTION_WAIT_S, otherWaitS: 630 })
  })

  it('the hook script accepts exactly up to that wait, in as many digits as it has', () => {
    const text = readFileSync(SCRIPT, 'utf8')
    const line = text.split('\n').find(l => l.includes('STAMP_WAIT=",\\"hookWaitS\\":$2"'))
    expect(line).toBeDefined()
    expect(line).toContain(`[ \${#2} -le ${String(FULL_HOLD_QUESTION_WAIT_S).length} ]`)
    expect(line).toContain(`[ "$2" -le ${FULL_HOLD_QUESTION_WAIT_S} ]`)
  })
})

describe('the 7.0.31 script is the same script but for the wait cap', () => {
  it('differs from this package\'s in exactly one code line: the cap (comments aside)', () => {
    const code = (path: string) => readFileSync(path, 'utf8').split('\n').filter(l => !/^\s*#/.test(l))
    const before = code(FIXTURE_7031), after = code(SCRIPT)
    expect(before.length).toBe(after.length)
    const changed = after.map((l, i) => [before[i], l]).filter(([a, b]) => a !== b)
    expect(changed).toEqual([[
      `    if [ \${#2} -le 4 ] && [ "$2" -ge 20 ] && [ "$2" -le ${FULL_HOLD_QUESTION_WAIT_PRIOR_S} ]; then WAIT=$2; STAMP_WAIT=",\\"hookWaitS\\":$2"; fi ;;`,
      `    if [ \${#2} -le 5 ] && [ "$2" -ge 20 ] && [ "$2" -le ${FULL_HOLD_QUESTION_WAIT_S} ]; then WAIT=$2; STAMP_WAIT=",\\"hookWaitS\\":$2"; fi ;;`,
    ]])
    expect(WAIT_CAP_ONLY_PRIOR_SCRIPT_SHAS).toEqual([sha(FIXTURE_7031)])
    expect(sha(FIXTURE_7031)).not.toBe(sha(SCRIPT))
  })

  it('scriptCurrentForPlan: current with no long question wait, outdated with one; this package\'s is always current', () => {
    const old = sha(FIXTURE_7031), now = sha(SCRIPT)
    expect(scriptCurrentForPlan(old, now, { questionWaitS: 630 })).toBe(true)
    expect(scriptCurrentForPlan(old, now, { questionWaitS: FULL_HOLD_QUESTION_WAIT_PRIOR_S })).toBe(true)
    expect(scriptCurrentForPlan(old, now, { questionWaitS: FULL_HOLD_QUESTION_WAIT_S })).toBe(false)
    expect(scriptCurrentForPlan(now, now, { questionWaitS: FULL_HOLD_QUESTION_WAIT_S })).toBe(true)
    expect(scriptCurrentForPlan('0'.repeat(64), now, { questionWaitS: 630 })).toBe(false)
    expect(scriptCurrentForPlan(null, now, { questionWaitS: 630 })).toBe(false)
  })
})

describe('a Mac that never turns the switch on: nothing changes', () => {
  const saved = { q: process.env.COS_QUESTION_FULL_HOLD, a: process.env.COS_APPROVAL_FULL_HOLD, home: process.env.COS_GLASSES_HOME }
  afterEach(() => {
    for (const [k, v] of [['COS_QUESTION_FULL_HOLD', saved.q], ['COS_APPROVAL_FULL_HOLD', saved.a], ['COS_GLASSES_HOME', saved.home]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  })
  function box() {
    const dir = temp('x1-8h-hooks-')
    process.env.COS_GLASSES_HOME = join(dir, 'home')
    return {
      settingsPath: join(dir, 'settings.json'),
      scriptPath: join(dir, 'home', 'bin', 'cos-session-hook'),
      hookPaths: { home: join(dir, 'home'), spoolDir: join(dir, 'home', 'data', 'hook-spool') },
    }
  }
  /** An install made by 7.0.31: this package's settings, the 7.0.31 script at the stable path. */
  function installedBy7031(b: ReturnType<typeof box>) {
    // 7.0.34: an unset question switch was OFF to 7.0.31 (the one 630 block), but is the default here, whose Reinstall
    // writes the long block. So for unset, write what 7.0.31 wrote: this package's plan with the question hold off.
    const plan = process.env.COS_QUESTION_FULL_HOLD === undefined ? permissionHookPlan({ ...process.env, COS_QUESTION_FULL_HOLD: '0' }, { setting: null, forInstall: true }) : undefined
    installClaudeHooks({ ...b, port: 3999, ...(plan ? { plan } : {}) })
    copyFileSync(FIXTURE_7031, b.scriptPath)
  }

  it('switch unset (the 7.0.34 default, never reinstalled): the 7.0.31 script reads installed, halt-ready and Cursor-ready (no banner)', () => {
    delete process.env.COS_QUESTION_FULL_HOLD; delete process.env.COS_APPROVAL_FULL_HOLD
    const b = box()
    installedBy7031(b)
    const status = hookStatus(b)
    expect(status.state).toBe('installed')
    expect(status.scriptSha).toBe(sha(FIXTURE_7031))
    expect(hookHaltReady(status)).toBe(true)
    expect(cursorDeskHaltReady(status)).toBe(true)
  })

  it('approval switch only (question hold off): still current (no question block passes more than an hour)', () => {
    process.env.COS_QUESTION_FULL_HOLD = '0'; process.env.COS_APPROVAL_FULL_HOLD = '1'
    const b = box()
    installedBy7031(b)
    expect(hookStatus(b).state).toBe('installed')
  })

  it('question switch on: the 7.0.31 script reads script_outdated (still halt-ready) until Reinstall hooks copies this one', () => {
    process.env.COS_QUESTION_FULL_HOLD = '1'; delete process.env.COS_APPROVAL_FULL_HOLD
    const b = box()
    installedBy7031(b)
    const status = hookStatus(b)
    expect(status.state).toBe('script_outdated')
    expect(hookHaltReady(status)).toBe(true)
    expect(installClaudeHooks({ ...b, port: 3999 }).status.state).toBe('installed')
    expect(sha(b.scriptPath)).toBe(sha(SCRIPT))
  })

  it('a split install from 7.0.16 to 7.0.31 (question block 3600) reads an earlier wait, halt-ready, under the 8 h plan', () => {
    process.env.COS_QUESTION_FULL_HOLD = '1'; delete process.env.COS_APPROVAL_FULL_HOLD
    const b = box()
    installClaudeHooks({ ...b, port: 3999, plan: { split: true, questionWaitS: FULL_HOLD_QUESTION_WAIT_PRIOR_S, otherWaitS: 630 } })
    const status = hookStatus(b)
    expect([status.state, status.priorWaitOnly, status.drifted]).toEqual(['drift', true, ['PermissionRequest']])
    expect(hookHaltReady(status)).toBe(true)
    expect(installClaudeHooks({ ...b, port: 3999 }).status.permissionHookTimeouts).toEqual({ question: FULL_HOLD_QUESTION_WAIT_S, approval: 630 })
  })

  it('a script that is neither still reads script_outdated and is not Cursor-ready', () => {
    delete process.env.COS_QUESTION_FULL_HOLD
    const b = box()
    installClaudeHooks({ ...b, port: 3999 })
    writeFileSync(b.scriptPath, '#!/bin/sh\nexit 0\n')
    const status = hookStatus(b)
    expect(status.state).toBe('script_outdated')
    expect(cursorDeskHaltReady(status)).toBe(false)
  })

  it('Codex: its copy of the 7.0.31 script stays current (Codex has no question block)', () => {
    const dir = temp('x1-8h-codex-')
    process.env.COS_GLASSES_HOME = join(dir, 'home')
    const paths = { hooksPath: join(dir, 'codex', 'hooks.json'), scriptPath: join(dir, 'home', 'bin', 'cos-session-hook-codex'), hookPaths: { home: join(dir, 'home'), spoolDir: join(dir, 'home', 'data', 'hook-spool') } }
    mkdirSync(join(dir, 'codex'), { recursive: true })
    const installed = installCodexHooks(paths)
    expect(installed.ok).toBe(true)
    copyFileSync(FIXTURE_7031, paths.scriptPath)
    const status = codexHookStatus(paths)
    expect(status.scriptOk).toBe(true)
    expect(status.state).toBe('installed')
    writeFileSync(paths.scriptPath, '#!/bin/sh\nexit 0\n')
    expect(codexHookStatus(paths).state).toBe('script_outdated')
  })
})

describe('turn-end asks survive a restart for their whole 8 hours', () => {
  const SID = '7a1e0c55-1111-4222-8333-000000008888'
  const keys = ['COS_CLAUDE_SESSIONS_ENABLED', 'COS_SESSION_HOOKS', 'COS_GLASSES_HOME', 'COS_SESSION_HOOKS_SPOOL_DIR', 'COS_CLAUDE_SESSIONS_DIR'] as const
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k]
    process.env.COS_CLAUDE_SESSIONS_ENABLED = '1'
    delete process.env.COS_SESSION_HOOKS
    const home = temp('x1-8h-runtime-')
    process.env.COS_GLASSES_HOME = home
    process.env.COS_SESSION_HOOKS_SPOOL_DIR = join(home, 'spool')
    process.env.COS_CLAUDE_SESSIONS_DIR = join(home, 'sessions')
    mkdirSync(join(home, 'sessions'), { recursive: true })
    __resetSessionHooksForTests()
  })
  afterEach(() => {
    __resetSessionHooksForTests()
    __setTurnEndAsksForTests(null)
    try { rmSync(dataPath('session-hook-events.jsonl'), { force: true }) } catch { /* none */ }
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  })

  function ledgerAskedAgo(ms: number): void {
    const at = Date.now() - ms
    const row = (ts: number, event: string, payload: Record<string, unknown>) => JSON.stringify({ key: `${ts}-1-${event}.json`, ts, ppid: 1, event, session_id: SID, entrypoint: 'claude-desktop', payload: { session_id: SID, ...payload } })
    writeFileSync(dataPath('session-hook-events.jsonl'), [
      row(at - 10_000, 'UserPromptSubmit', { prompt: 'go', prompt_id: 'p1' }),
      row(at - 5_000, 'PostToolUse', { tool_name: WRAP_UP_TOOL, prompt_id: 'p1', turn_ask: { ask: 'Which env?', choices: ['Prod', 'Stage'], blocked: false } }),
      row(at, 'Stop', { prompt_id: 'p1', last_assistant_message: 'done' }),
    ].join('\n') + '\n')
  }

  it('the tracker reads back to its own age-out: 2 h past the store\'s 6 h window', () => {
    expect(turnAskReplayExtraMs()).toBe(TURN_ASK_MAX_AGE_MS - LEDGER_REPLAY_WINDOW_MS)
    expect(LEDGER_REPLAY_WINDOW_MS + turnAskReplayExtraMs()).toBe(TURN_ASK_MAX_AGE_MS)
  })

  it('an ask 7 h old is armed after a restart, and the store does not replay its rows (still 6 h)', () => {
    __setTurnEndAsksForTests(true)
    ledgerAskedAgo(7 * 60 * 60_000)
    const runtime = startSessionHooksRuntime({ port: 3141 })
    try {
      expect(turnEndAskStats()).toMatchObject({ armed: 1, tracked: 1 })
      expect(sessionSignalStore.get(SID)).toBeUndefined()
      // The health count is the store's: rows only the tracker read are not counted as applied.
      expect(sessionHooksHealthFields().sessionHooks.replayed).toEqual({ rows: 3, applied: 0 })
    } finally {
      runtime.stop()
    }
  })

  it('an ask 5 h old is armed from the store\'s own replay, as before', () => {
    __setTurnEndAsksForTests(true)
    ledgerAskedAgo(5 * 60 * 60_000)
    const runtime = startSessionHooksRuntime({ port: 3141 })
    try {
      expect(turnEndAskStats()).toMatchObject({ armed: 1, tracked: 1 })
      expect(sessionSignalStore.get(SID)).toBeDefined()
    } finally {
      runtime.stop()
    }
  })

  it('an ask older than 8 h is not replayed at all', () => {
    __setTurnEndAsksForTests(true)
    ledgerAskedAgo(TURN_ASK_MAX_AGE_MS + 60_000)
    const runtime = startSessionHooksRuntime({ port: 3141 })
    try {
      expect(turnEndAskStats()).toMatchObject({ armed: 0, tracked: 0 })
    } finally {
      runtime.stop()
    }
  })

  it('turn-end asks off: the replay is the 6 h store replay only', () => {
    __setTurnEndAsksForTests(false)
    ledgerAskedAgo(7 * 60 * 60_000)
    const runtime = startSessionHooksRuntime({ port: 3141 })
    try {
      expect(turnEndAskStats()).toBeNull()
      expect(sessionSignalStore.get(SID)).toBeUndefined()
    } finally {
      runtime.stop()
    }
  })
})
