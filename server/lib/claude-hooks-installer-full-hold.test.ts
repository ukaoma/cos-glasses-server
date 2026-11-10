// X1 (2026-11-09): the installer under the full hold. With COS_QUESTION_FULL_HOLD and
// COS_APPROVAL_FULL_HOLD both off it writes 7.0.13's bytes (the two hashes below were taken from
// 97402b4's own installer on these inputs); with either on, Reinstall hooks splits PermissionRequest
// by matcher (canary C9, both engines) and an unsplit install reads drift that stays halt-ready.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hookHaltReady, hookStatus, installClaudeHooks, mergeHookSettings, permissionHookPlan, permissionHookTimeoutForToolS,
  permissionHookTimeoutS, subscribedEvents, type HookPaths,
} from './claude-hooks-installer.js'
import { FULL_HOLD_HOOK_WAIT_S, NON_QUESTION_MATCHER, QUESTION_MATCHER } from './full-hold.js'

const SCRIPT = '/Users/example/.cos-glasses/bin/cos-session-hook'
const PATHS: HookPaths = { home: '/Users/example/.cos-glasses', spoolDir: '/Users/example/.cos-glasses/data/hook-spool' }
const FOREIGN = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/claude-active.sh stop' }] }], PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo foreign' }] }] } }
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const saved = { q: process.env.COS_QUESTION_FULL_HOLD, a: process.env.COS_APPROVAL_FULL_HOLD, home: process.env.COS_GLASSES_HOME }
afterEach(() => {
  for (const [key, value] of [['COS_QUESTION_FULL_HOLD', saved.q], ['COS_APPROVAL_FULL_HOLD', saved.a], ['COS_GLASSES_HOME', saved.home]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
function setFlags(q: string | undefined, a: string | undefined) {
  if (q === undefined) delete process.env.COS_QUESTION_FULL_HOLD
  else process.env.COS_QUESTION_FULL_HOLD = q
  if (a === undefined) delete process.env.COS_APPROVAL_FULL_HOLD
  else process.env.COS_APPROVAL_FULL_HOLD = a
}

describe('with both switches off: 7.0.13 byte for byte', () => {
  it.each([[undefined, undefined], ['0', '0'], ['off', 'false'], ['', 'banana']])('merge output is 97402b4\'s (q=%s a=%s)', (q, a) => {
    setFlags(q, a)
    expect(permissionHookPlan()).toEqual({ split: false, questionWaitS: 630, otherWaitS: 630 })
    expect(sha(mergeHookSettings({}, SCRIPT, PATHS))).toBe('91b7e61dfa0a32a1427fe8143273e4ce0b6ed332793c27e657bc76795db00647')
    expect(sha(mergeHookSettings(FOREIGN, SCRIPT, PATHS))).toBe('b32fd8a91a364d2a0d64d36d8a782a78220844916422e909ab2cb86e8510458c')
  })

  it('an unsplit install reads installed and its per-kind timeouts are not reported', () => {
    setFlags(undefined, undefined)
    const merged = mergeHookSettings({}, SCRIPT, PATHS)
    if (!merged.ok) throw Error('merge')
    expect(subscribedEvents(merged.settings, SCRIPT, PATHS)).toMatchObject({ drifted: [], missing: [] })
    expect(permissionHookTimeoutForToolS(merged.settings, 'AskUserQuestion')).toBe(630)
    expect(permissionHookTimeoutForToolS(merged.settings, 'Bash')).toBe(630)
  })
})

describe('with a switch on: the split block', () => {
  it.each([
    ['1', undefined, FULL_HOLD_HOOK_WAIT_S, 630],
    [undefined, 'on', 630, FULL_HOLD_HOOK_WAIT_S],
    ['true', 'yes-but-not-a-switch-value', FULL_HOLD_HOOK_WAIT_S, 630],
    ['1', '1', FULL_HOLD_HOOK_WAIT_S, FULL_HOLD_HOOK_WAIT_S],
  ])('q=%s a=%s writes AskUserQuestion at %d and everything else at %d, each passing its own wait', (q, a, qWait, otherWait) => {
    setFlags(q, a)
    const merged = mergeHookSettings(FOREIGN, SCRIPT, PATHS)
    if (!merged.ok) throw Error('merge')
    const blocks = (merged.settings.hooks as Record<string, unknown[]>).PermissionRequest
    // The foreign block first and untouched, then ours: the question block, then the rest.
    expect(blocks).toEqual([
      FOREIGN.hooks.PermissionRequest[0],
      { matcher: QUESTION_MATCHER, hooks: [{ type: 'command', command: `COS_GLASSES_HOME=${PATHS.home} COS_HOOK_SPOOL=${PATHS.spoolDir} ${SCRIPT} PermissionRequest ${qWait}`, timeout: qWait }] },
      { matcher: NON_QUESTION_MATCHER, hooks: [{ type: 'command', command: `COS_GLASSES_HOME=${PATHS.home} COS_HOOK_SPOOL=${PATHS.spoolDir} ${SCRIPT} PermissionRequest ${otherWait}`, timeout: otherWait }] },
    ])
    expect(permissionHookTimeoutForToolS(merged.settings, 'AskUserQuestion')).toBe(qWait)
    expect(permissionHookTimeoutForToolS(merged.settings, 'Bash')).toBe(otherWait)
    // The legacy reader still bounds by the least of ours.
    expect(permissionHookTimeoutS(merged.settings)).toBe(Math.min(qWait, otherWait))
    // Every other event is exactly as with the switches off.
    setFlags(undefined, undefined)
    const plain = mergeHookSettings(FOREIGN, SCRIPT, PATHS)
    if (!plain.ok) throw Error('merge')
    const strip = (s: Record<string, unknown>) => ({ ...(s.hooks as Record<string, unknown>), PermissionRequest: null })
    expect(strip(merged.settings)).toEqual(strip(plain.settings))
  })

  it('the negative matcher selects every tool but AskUserQuestion', () => {
    const re = new RegExp(`^(?:${NON_QUESTION_MATCHER})$`)
    expect(re.test('AskUserQuestion')).toBe(false)
    for (const tool of ['Bash', 'Write', 'AskUserQuestionX', 'XAskUserQuestion', 'mcp__x__y', 'ExitPlanMode']) expect(re.test(tool)).toBe(true)
  })
})

describe('Reinstall hooks applies it, and status stays halt-ready in between', () => {
  function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), 'x1-hooks-'))
    process.env.COS_GLASSES_HOME = join(dir, 'home')
    const settingsPath = join(dir, 'settings.json')
    const scriptPath = join(dir, 'home', 'bin', 'cos-session-hook')
    const hookPaths = { home: join(dir, 'home'), spoolDir: join(dir, 'home', 'data', 'hook-spool') }
    return { settingsPath, scriptPath, hookPaths }
  }

  it('unsplit install, then a switch on: drift with priorWaitOnly and halt-ready; Reinstall writes the split; switch off: drift, halt-ready, Reinstall restores 7.0.13', () => {
    const box = sandbox()
    setFlags(undefined, undefined)
    const first = installClaudeHooks({ ...box, port: 3999 })
    expect(first.status.state).toBe('installed')
    // Unsplit with the switches off: no per-kind field, so the status reads as 7.0.13's.
    expect('permissionHookTimeouts' in first.status).toBe(false)
    const beforeBytes = readFileSync(box.settingsPath, 'utf-8')
    setFlags('1', undefined)
    let status = hookStatus(box)
    expect([status.state, status.priorWaitOnly, status.drifted]).toEqual(['drift', true, ['PermissionRequest']])
    expect(hookHaltReady(status)).toBe(true)
    const split = installClaudeHooks({ ...box, port: 3999 })
    expect(split.status.state).toBe('installed')
    expect(split.status.permissionHookTimeouts).toEqual({ question: 3600, approval: 630 })
    setFlags(undefined, undefined)
    status = hookStatus(box)
    expect([status.state, status.priorWaitOnly]).toEqual(['drift', true])
    expect(hookHaltReady(status)).toBe(true)
    expect(installClaudeHooks({ ...box, port: 3999 }).status.state).toBe('installed')
    expect(readFileSync(box.settingsPath, 'utf-8')).toBe(beforeBytes)
  })

  it('a hand-edited PermissionRequest of ours is drift that is NOT prior-wait-only', () => {
    const box = sandbox()
    setFlags('1', undefined)
    installClaudeHooks({ ...box, port: 3999 })
    const settings = JSON.parse(readFileSync(box.settingsPath, 'utf-8'))
    settings.hooks.PermissionRequest[0].matcher = 'Ask.*'
    writeFileSync(box.settingsPath, JSON.stringify(settings))
    const status = hookStatus(box)
    expect([status.state, status.priorWaitOnly]).toEqual(['drift', false])
  })
})
