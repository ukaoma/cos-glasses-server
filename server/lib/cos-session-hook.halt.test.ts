// The 6.53.0 halt check at the head of the shipped hook script, EXECUTED as Claude runs it
// (`sh <script> <Event>`, the payload on stdin, only the baked environment).
//
// A FILE OF ITS OWN ON PURPOSE. cos-session-hook.script.test.ts pins the script's sha256, so
// any edit to the script fails that file whatever the edit does. A mutation gate case run
// against it would therefore read "killed" for an inert change. These cases carry no pin, so
// a mutant of the halt branch is killed here only by a test that watches the behaviour.
// macOS-only (BSD head); skipped elsewhere, like the script suite.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseHookEnvelope } from './session-hook-events.js'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hooks', 'cos-session-hook')
const SESSION = 'a1b2c3d4-0000-4000-8000-00000000abcd'
const payload = (extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: SESSION, hook_event_name: 'Stop', cwd: '/Users/example/project', ...extra })

function home(): { home: string; spool: string } {
  const root = mkdtempSync(join(tmpdir(), 'cos-hook-halt-'))
  // The production home has a dot component; keep that property.
  const h = join(root, '.cos-glasses')
  const spool = join(h, 'data', 'hook-spool')
  mkdirSync(spool, { recursive: true })
  return { home: h, spool }
}

const spooled = (spool: string) => readdirSync(spool).filter(n => /^\d+-\d+-[A-Za-z]+\.json$/.test(n))
const onMac = process.platform === 'darwin'

// 6.53.0: the halt check. PreToolUse is synchronous with no matcher, so this branch runs
// before every tool call on the Mac; the canaries (plan, 2026-09-21) fixed its reply.
describe.skipIf(!onMac)('bin/hooks/cos-session-hook: the halt check (6.53.0)', () => {
  const DENY = '{"continue":false,"stopReason":"Cancelled from COS","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Cancelled from COS"}}'
  const OTHER = 'b2c3d4e5-0000-4000-8000-00000000beef'
  const tool = (name: string, extra: Record<string, unknown> = {}) =>
    payload({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: { command: 'ls' }, ...extra })

  /** A home plus its own TMPDIR, so a leaked temp file is visible to the assertion. */
  function halted(sessionIds: string[] = []) {
    const paths = home()
    const halt = join(dirname(paths.spool), 'session-halt')
    mkdirSync(halt, { recursive: true })
    for (const id of sessionIds) writeFileSync(join(halt, id), JSON.stringify({ at: Date.now(), clientCancelId: 'cc-test-1' }))
    const tmp = mkdtempSync(join(tmpdir(), 'cos-hook-tmp-'))
    return { ...paths, halt, tmp }
  }
  function runIn(event: string, stdin: string, p: ReturnType<typeof halted>) {
    return spawnSync('/bin/sh', [SCRIPT, event], {
      input: stdin,
      env: { HOME: dirname(p.home), COS_GLASSES_HOME: p.home, COS_HOOK_SPOOL: p.spool, PATH: '/usr/bin:/bin', TMPDIR: p.tmp },
      timeout: 10_000,
    })
  }

  it('a marker for this session: prints exactly the deny that stops the run, spools nothing, leaves no temp file', () => {
    const p = halted([SESSION])
    const r = runIn('PreToolUse', tool('Bash'), p)
    expect(r.status).toBe(0)
    expect(r.stdout.toString()).toBe(DENY)
    expect(r.stderr.toString()).toBe('')
    expect(JSON.parse(r.stdout.toString())).toEqual({
      continue: false,
      stopReason: 'Cancelled from COS',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Cancelled from COS' },
    })
    expect(spooled(p.spool)).toEqual([])
    expect(readdirSync(p.tmp)).toEqual([])
    // The marker is not consumed by the stop: background subagents share the session id
    // (C8), and the next tool call must be stopped too.
    expect(existsSync(join(p.halt, SESSION))).toBe(true)
    expect(runIn('PreToolUse', tool('Read'), p).stdout.toString()).toBe(DENY)
    // It stops the two spooled tools too, before they are spooled.
    expect(runIn('PreToolUse', tool('AskUserQuestion'), p).stdout.toString()).toBe(DENY)
    expect(spooled(p.spool)).toEqual([])
  })

  it('no marker: an ordinary tool call prints nothing, writes no spool file and creates nothing', () => {
    const p = halted([OTHER])
    const r = runIn('PreToolUse', tool('Bash'), p)
    expect(r.status).toBe(0)
    expect(r.stdout.toString()).toBe('')
    expect(r.stderr.toString()).toBe('')
    expect(spooled(p.spool)).toEqual([])
    // Nothing at all under the spool: the branch runs before the mkdir.
    expect(existsSync(join(p.spool, 'rejected'))).toBe(false)
    expect(readdirSync(p.tmp)).toEqual([])
    // With no marker folder at all (the common case on every Mac), the same.
    const bare = { ...home(), halt: '', tmp: mkdtempSync(join(tmpdir(), 'cos-hook-tmp-')) }
    const r2 = runIn('PreToolUse', tool('Bash'), bare)
    expect(r2.status).toBe(0)
    expect(r2.stdout.toString()).toBe('')
    expect(spooled(bare.spool)).toEqual([])
    expect(readdirSync(bare.tmp)).toEqual([])
  })

  it('AskUserQuestion and ExitPlanMode are spooled with their payload, as the 6.48 matcher did', () => {
    const p = halted([OTHER])
    for (const name of ['AskUserQuestion', 'ExitPlanMode']) {
      const r = runIn('PreToolUse', tool(name), p)
      expect(r.status).toBe(0)
      expect(r.stdout.toString()).toBe('')
    }
    const names = spooled(p.spool).sort()
    expect(names).toHaveLength(2)
    const tools = names.map(n => {
      const parsed = parseHookEnvelope(readFileSync(join(p.spool, n), 'utf-8'))
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return null
      expect(parsed.envelope).toMatchObject({ event: 'PreToolUse', sessionId: SESSION })
      expect(parsed.envelope.payload.tool_input).toEqual({ command: 'ls' })
      return parsed.envelope.payload.tool_name
    })
    expect(tools.sort()).toEqual(['AskUserQuestion', 'ExitPlanMode'])
    expect(readdirSync(p.tmp)).toEqual([])
    // A tool whose name merely CONTAINS one of them is not one of them.
    expect(runIn('PreToolUse', tool('NotAskUserQuestion'), p).stdout.toString()).toBe('')
    expect(spooled(p.spool)).toHaveLength(2)
  })

  it('UserPromptSubmit removes this session\'s marker, leaves the others, and is still spooled', () => {
    const p = halted([SESSION, OTHER])
    const r = runIn('UserPromptSubmit', payload({ hook_event_name: 'UserPromptSubmit', prompt: 'next thing' }), p)
    expect(r.status).toBe(0)
    expect(r.stdout.toString()).toBe('')
    expect(existsSync(join(p.halt, SESSION))).toBe(false)
    expect(existsSync(join(p.halt, OTHER))).toBe(true)
    const names = spooled(p.spool)
    expect(names).toHaveLength(1)
    const parsed = parseHookEnvelope(readFileSync(join(p.spool, names[0]!), 'utf-8'))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.envelope).toMatchObject({ event: 'UserPromptSubmit', sessionId: SESSION })
      expect(parsed.envelope.payload.prompt).toBe('next thing')
    }
    expect(readdirSync(p.tmp)).toEqual([])
    // And the next tool call of the new prompt runs.
    expect(runIn('PreToolUse', tool('Bash'), p).stdout.toString()).toBe('')
    // With no marker anywhere the prompt spools exactly as before.
    const q = halted()
    expect(runIn('UserPromptSubmit', payload({ prompt: 'x' }), q).status).toBe(0)
    expect(spooled(q.spool)).toHaveLength(1)
  })

  it('malformed stdin exits 0 with no output and no spool file, even with the marker set', () => {
    const p = halted([SESSION])
    for (const stdin of ['not json', '', `{"session_id":"${SESSION}"`, `{"session_id":"${SESSION.slice(0, 8)}"}`]) {
      const r = runIn('PreToolUse', stdin, p)
      expect(r.status).toBe(0)
      // The truncated-JSON case still names the session in full, and a stop there is
      // correct: the id is the whole key. Every other shape names no session.
      expect(r.stdout.toString()).toBe(stdin.startsWith(`{"session_id":"${SESSION}"`) ? DENY : '')
    }
    expect(spooled(p.spool)).toEqual([])
    expect(readdirSync(p.tmp)).toEqual([])
  })

  it('the FIRST session_id decides: one inside tool_input, after the payload\'s own, does not win', () => {
    // The payload's own session is not halted; the tool's input names one that is.
    const p = halted([SESSION])
    const inner = JSON.stringify({ session_id: OTHER, hook_event_name: 'PreToolUse', tool_name: 'mcp__x__y', tool_input: { session_id: SESSION } })
    expect(runIn('PreToolUse', inner, p).stdout.toString()).toBe('')
    // And the reverse: the payload's own session is halted, the tool's input names another.
    const q = halted([SESSION])
    const reverse = JSON.stringify({ session_id: SESSION, hook_event_name: 'PreToolUse', tool_name: 'mcp__x__y', tool_input: { session_id: OTHER } })
    expect(runIn('PreToolUse', reverse, q).stdout.toString()).toBe(DENY)
  })

  it('reads an upper-case id and spaces after the colons (any JSON writer)', () => {
    const p = halted([SESSION])
    const spaced = tool('Bash', { session_id: SESSION.toUpperCase() }).replace(/":/g, '": ')
    expect(runIn('PreToolUse', spaced, p).stdout.toString()).toBe(DENY)
    const r = runIn('UserPromptSubmit', payload({ session_id: SESSION.toUpperCase() }).replace(/":/g, '": '), p)
    expect(r.status).toBe(0)
    expect(existsSync(join(p.halt, SESSION))).toBe(false)
  })

  it('a full spool or a stale drain stamp never stops a cancel: the check runs before the B8 guard', () => {
    const p = halted([SESSION])
    for (let i = 0; i < 2000; i++) writeFileSync(join(p.spool, `${1700000000000 + i}-1-Stop.json`), '{}\n')
    expect(runIn('PreToolUse', tool('Bash'), p).stdout.toString()).toBe(DENY)
    const q = halted([SESSION])
    const stamp = join(q.spool, '.last-drain')
    writeFileSync(stamp, '')
    const dayAgo = new Date(Date.now() - 25 * 60 * 60_000)
    utimesSync(stamp, dayAgo, dayAgo)
    expect(runIn('PreToolUse', tool('Bash'), q).stdout.toString()).toBe(DENY)
  })

  it('never exits 2, on any event or input (exit 2 would block the tool)', () => {
    const p = halted([SESSION])
    const inputs = ['', 'not json', tool('Bash'), tool('AskUserQuestion'), tool('Bash', { session_id: OTHER }), payload({ prompt: 'p' })]
    for (const event of ['PreToolUse', 'UserPromptSubmit', 'PostToolUse', 'Stop']) {
      for (const stdin of inputs) {
        const r = runIn(event, stdin, p)
        expect(r.status).toBe(0)
      }
    }
    // A marker folder that is not readable is not a stop, and not an exit 2.
    const q = halted([SESSION])
    chmodSync(q.halt, 0o000)
    try {
      const r = runIn('PreToolUse', tool('Bash'), q)
      expect(r.status).toBe(0)
      expect(r.stdout.toString()).toBe('')
    } finally {
      chmodSync(q.halt, 0o700)
    }
    expect(readdirSync(p.tmp)).toEqual([])
  })
})
