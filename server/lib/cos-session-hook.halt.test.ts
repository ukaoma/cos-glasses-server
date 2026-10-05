// The 6.53.0 halt check at the head of the shipped hook script, EXECUTED as Claude runs it
// (`sh <script> <Event>`, the payload on stdin, only the baked environment).
//
// A FILE OF ITS OWN ON PURPOSE. cos-session-hook.script.test.ts pins the script's sha256, so
// any edit to the script fails that file whatever the edit does. A mutation gate case run
// against it would therefore read "killed" for an inert change. These cases carry no pin, so
// a mutant of the halt branch is killed here only by a test that watches the behaviour.
// macOS-only (BSD head); skipped elsewhere, like the script suite.

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { parseHookEnvelope } from './session-hook-events.js'
import { CODEX_HOOK_SUBSCRIPTIONS, codexHookCommand } from './codex-hooks-installer.js'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hooks', 'cos-session-hook')
const SESSION = 'a1b2c3d4-0000-4000-8000-00000000abcd'
const payload = (extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: SESSION, hook_event_name: 'Stop', cwd: '/Users/example/project', ...extra })

// 6.53.3 (review A12): every temp root this file makes is removed when it ends. Until
// 6.53.2 none were, and the hook suites had left ~7,000 `cos-hook*` folders (~2 GB) behind.
const roots: string[] = []
function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
afterAll(() => {
  for (const root of roots.splice(0)) {
    try { chmodSync(join(root, '.cos-glasses', 'data', 'session-halt'), 0o700) } catch { /* not there */ }
    rmSync(root, { recursive: true, force: true })
  }
})

function home(): { home: string; spool: string } {
  const root = tmpRoot('cos-hook-halt-')
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
    const tmp = tmpRoot('cos-hook-tmp-')
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
    const bare = { ...home(), halt: '', tmp: tmpRoot('cos-hook-tmp-') }
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
    // 6.53.3: the FIRST "tool_name" is the payload's own. A Bash call whose input names
    // AskUserQuestion is not spooled; an AskUserQuestion whose input names Bash is.
    expect(runIn('PreToolUse', tool('Bash', { tool_input: { tool_name: 'AskUserQuestion' } }), p).status).toBe(0)
    expect(spooled(p.spool)).toHaveLength(2)
    expect(runIn('PreToolUse', tool('AskUserQuestion', { tool_input: { tool_name: 'Bash', questions: [] } }), p).status).toBe(0)
    expect(spooled(p.spool)).toHaveLength(3)
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
    // 6.53.3: an id whose string never closes is not a JSON value, and never stops a run
    // (the 6.53.0 script's grep required the closing quote; the rewrite keeps that).
    for (const stdin of ['not json', '', `{"session_id":"${SESSION}"`, `{"session_id":"${SESSION}`, `{"session_id":"${SESSION.slice(0, 8)}"}`]) {
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

  // 25 sequential spawns: 0.9 s idle, 1.6 s under CPU oversubscription, against vitest's 5 s
  // default. 6.53.3 (review A12): its own timeout, so a loaded machine is not a failure.
  it('never exits 2, on any event or input (exit 2 would block the tool)', { timeout: 30_000 }, () => {
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

// 6.53.3: the single-entry rewrite (review A, option a; A9; A10). Every path still exits 0,
// prints nothing but the deny, and now drains its stdin, so Claude Code's writer never sees
// EPIPE, whatever the payload's size.
describe.skipIf(!onMac)('bin/hooks/cos-session-hook: one read, and a drained stdin (6.53.3)', () => {
  const DENY = '{"continue":false,"stopReason":"Cancelled from COS","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Cancelled from COS"}}'
  function paths(markers: string[] = []) {
    const p = home()
    const halt = join(dirname(p.spool), 'session-halt')
    mkdirSync(halt, { recursive: true })
    for (const id of markers) writeFileSync(join(halt, id), JSON.stringify({ at: Date.now(), clientCancelId: 'cc-test-1' }))
    return { ...p, halt }
  }
  const env = (p: { home: string; spool: string }) => ({ HOME: dirname(p.home), COS_GLASSES_HOME: p.home, COS_HOOK_SPOOL: p.spool, PATH: '/usr/bin:/bin' })

  /** Claude Code's side: write the payload (in pieces, if asked), and report an EPIPE. */
  function stream(event: string, pieces: string[], p: { home: string; spool: string }, gapMs = 0): Promise<{ status: number | null; stdout: string; writerError: string | null }> {
    return new Promise(resolvePromise => {
      const child = spawn('/bin/sh', [SCRIPT, event], { env: env(p) })
      let stdout = ''
      let writerError: string | null = null
      child.stdout.on('data', c => { stdout += c })
      child.stdin.on('error', e => { writerError = (e as NodeJS.ErrnoException).code ?? e.message })
      child.on('close', status => resolvePromise({ status, stdout, writerError }))
      const send = (i: number) => {
        if (i >= pieces.length) { child.stdin.end(); return }
        child.stdin.write(pieces[i]!)
        if (gapMs > 0 && i + 1 < pieces.length) setTimeout(() => send(i + 1), gapMs)
        else send(i + 1)
      }
      send(0)
    })
  }
  const big = (extra: Record<string, unknown>) => payload({ ...extra, tool_input: { command: 'x', pad: 'y'.repeat(2_500_000) } })

  it('a 2.5 MB payload: exit 0 and no EPIPE on every front path (plain tool, deny, spooled tool, prompt)', { timeout: 30_000 }, async () => {
    const p = paths()
    const plain = await stream('PreToolUse', [big({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })], p)
    expect(plain).toEqual({ status: 0, stdout: '', writerError: null })

    const q = paths([SESSION])
    const denied = await stream('PreToolUse', [big({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })], q)
    expect(denied).toEqual({ status: 0, stdout: DENY, writerError: null })

    const r = paths()
    for (const [event, extra] of [
      ['PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }],
      ['UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt: 'p' }],
    ] as const) {
      const res = await stream(event, [big(extra)], r)
      expect(res, event).toEqual({ status: 0, stdout: '', writerError: null })
    }
    // Both spooled, each capped at 1 MiB plus the envelope.
    const names = spooled(r.spool)
    expect(names).toHaveLength(2)
    for (const name of names) expect(statSync(join(r.spool, name)).size).toBeLessThan(1_048_576 + 256)
  })

  it('a spooled payload past the first read is byte-exact (head would have eaten 4 to 16 KiB of it)', async () => {
    const p = paths()
    const options = Array.from({ length: 40 }, (_, i) => ({ label: `option ${i} ${'z'.repeat(600)}`, description: 'd'.repeat(300) }))
    const ask = payload({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Pick one', options }] } })
    expect(ask.length).toBeGreaterThan(20_000)
    const prompt = 'w'.repeat(9_000)
    const submit = payload({ hook_event_name: 'UserPromptSubmit', prompt })
    expect((await stream('PreToolUse', [ask], p)).status).toBe(0)
    expect((await stream('UserPromptSubmit', [submit], p)).status).toBe(0)
    const envelopes = spooled(p.spool).map(n => parseHookEnvelope(readFileSync(join(p.spool, n), 'utf-8')))
    expect(envelopes.every(e => e.ok)).toBe(true)
    const byEvent = Object.fromEntries(envelopes.map(e => e.ok ? [e.envelope.event, e.envelope.payload] : ['x', null]))
    expect(byEvent.PreToolUse).toEqual(JSON.parse(ask))
    expect(byEvent.UserPromptSubmit).toEqual(JSON.parse(submit))
  })

  it('a payload that arrives in pieces is still read: the stop lands, and the question is still spooled', async () => {
    const q = paths([SESSION])
    const tool = payload({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(await stream('PreToolUse', [tool.slice(0, 20), tool.slice(20)], q, 80)).toEqual({ status: 0, stdout: DENY, writerError: null })
    const r = paths()
    const ask = payload({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] } })
    expect((await stream('PreToolUse', [ask.slice(0, 30), ask.slice(30)], r, 80)).status).toBe(0)
    const names = spooled(r.spool)
    expect(names).toHaveLength(1)
    const parsed = parseHookEnvelope(readFileSync(join(r.spool, names[0]!), 'utf-8'))
    expect(parsed.ok && parsed.envelope.payload).toEqual(JSON.parse(ask))
    // A prompt whose id arrives in a second piece still clears this session's marker.
    const s = paths([SESSION])
    const submit = payload({ hook_event_name: 'UserPromptSubmit', prompt: 'next' })
    expect((await stream('UserPromptSubmit', [submit.slice(0, 16), submit.slice(16)], s, 80)).status).toBe(0)
    expect(existsSync(join(s.halt, SESSION))).toBe(false)
  })

  // A10: the 6.53.0 script needed a temp file before it could read the id, and when mktemp
  // failed a new prompt was spooled WITHOUT clearing the marker, so every tool call of the
  // next run was denied. Measured against 6.53.0 with this sandbox: marker left, fails.
  it('UserPromptSubmit clears the marker even where no temp file can be created', () => {
    const p = paths([SESSION])
    const profile = '(version 1)(allow default)(deny file-write* (regex #"/cos-hook\\.[^/]*$"))'
    const r = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', SCRIPT, 'UserPromptSubmit'], {
      input: payload({ hook_event_name: 'UserPromptSubmit', prompt: 'next' }),
      env: env(p),
      timeout: 10_000,
    })
    expect(r.status).toBe(0)
    expect(r.stdout.toString()).toBe('')
    expect(existsSync(join(p.halt, SESSION))).toBe(false)
    expect(spooled(p.spool)).toHaveLength(1)
  })

  // 6.53.3 /qa (Skeptic N5): the front drained, but every other event (PermissionRequest,
  // Stop, PostToolUse, SessionStart, SessionEnd) still read with `head -c 1048576` and left
  // the rest of stdin unread, and the B8 guard / a failed mkdir exited before reading at all.
  it('a 2.5 MB payload on every other event: exit 0, no EPIPE, spooled at the 1 MiB cap', { timeout: 60_000 }, async () => {
    const p = paths()
    const events = ['Stop', 'PostToolUse', 'PermissionRequest', 'SessionEnd'] as const
    for (const event of events) {
      const res = await stream(event, [big({ hook_event_name: event, tool_name: 'Bash' })], p)
      expect(res, event).toEqual({ status: 0, stdout: '', writerError: null })
    }
    const names = spooled(p.spool)
    expect(names).toHaveLength(events.length)
    for (const name of names) expect(statSync(join(p.spool, name)).size).toBeLessThan(1_048_576 + 256)
    // Nothing left behind but the published files (the permission request's copy is removed).
    expect(readdirSync(p.spool).filter(n => n.startsWith('.tmp.'))).toEqual([])
  })

  it('the B8 guard and a failed spool drain every other event\'s stdin too', { timeout: 60_000 }, async () => {
    const p = paths()
    for (let i = 0; i < 2000; i++) writeFileSync(join(p.spool, `${1700000000000 + i}-1-Stop.json`), '{}\n')
    for (const event of ['Stop', 'PostToolUse']) {
      expect(await stream(event, [big({ hook_event_name: event })], p), event).toEqual({ status: 0, stdout: '', writerError: null })
    }
    expect(spooled(p.spool)).toHaveLength(2000)
    const q = paths()
    const blocked = { home: q.home, spool: join(q.home, 'not-a-dir', 'hook-spool') }
    writeFileSync(join(q.home, 'not-a-dir'), 'x')
    for (const event of ['Stop', 'PermissionRequest']) {
      expect(await stream(event, [big({ hook_event_name: event })], blocked), event).toEqual({ status: 0, stdout: '', writerError: null })
    }
  })

  it('a failed spool (no folder) or the B8 guard still drains a spooled event\'s stdin', async () => {
    const p = paths()
    for (let i = 0; i < 2000; i++) writeFileSync(join(p.spool, `${1700000000000 + i}-1-Stop.json`), '{}\n')
    const ask = big({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' })
    expect(await stream('PreToolUse', [ask], p)).toEqual({ status: 0, stdout: '', writerError: null })
    expect(spooled(p.spool)).toHaveLength(2000)
    // A spool path that cannot be created: a FILE where the folder's parent should be.
    const q = paths()
    const blocked = { home: q.home, spool: join(q.home, 'not-a-dir', 'hook-spool') }
    writeFileSync(join(q.home, 'not-a-dir'), 'x')
    expect(await stream('UserPromptSubmit', [big({ hook_event_name: 'UserPromptSubmit', prompt: 'p' })], blocked)).toEqual({ status: 0, stdout: '', writerError: null })
  })
})

// 6.62.0 provider parity (plan 2.2). Codex runs this same script from ~/.codex/hooks.json with
// COS_HOOK_PROVIDER=codex baked into its command; Cursor runs it from ~/.claude/settings.json.
describe.skipIf(!onMac)('bin/hooks/cos-session-hook: Codex and Cursor (6.62.0)', () => {
  /** The three halt replies, byte for byte. Claude and Cursor keep the 6.53 bytes (C10). */
  const CLAUDE_DENY = '{"continue":false,"stopReason":"Cancelled from COS","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Cancelled from COS"}}'
  const CURSOR_DENY = CLAUDE_DENY
  /** Codex rejects `continue:false` here and then RUNS the tool (C10); deny alone blocks it (C12). */
  const CODEX_DENY = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Cancelled from COS. Stop and do not work around this."}}'
  const CODEX = '01a10c4b-0000-7000-8000-00000000c0de'
  const CURSOR = '8c149bba-82b6-4b73-9f2f-eb26e72a72a9'
  const OTHER = 'b2c3d4e5-0000-4000-8000-00000000beef'

  function halted(sessionIds: string[] = []) {
    const paths = home()
    const halt = join(dirname(paths.spool), 'session-halt')
    mkdirSync(halt, { recursive: true })
    for (const id of sessionIds) writeFileSync(join(halt, id), JSON.stringify({ at: Date.now(), clientCancelId: 'cc-test-1' }))
    return { ...paths, halt, tmp: tmpRoot('cos-hook-tmp-') }
  }
  function runAs(event: string, stdin: string, p: ReturnType<typeof halted>, extra: Record<string, string> = {}) {
    return spawnSync('/bin/sh', [SCRIPT, event], {
      input: stdin,
      env: { HOME: dirname(p.home), COS_GLASSES_HOME: p.home, COS_HOOK_SPOOL: p.spool, PATH: '/usr/bin:/bin', TMPDIR: p.tmp, ...extra },
      timeout: 10_000,
    })
  }
  /** A Codex PreToolUse as codex-cli 0.160.0 writes it (C1): session_id first, the rollout second. */
  const codexTool = (id = CODEX) => JSON.stringify({
    session_id: id, transcript_path: `/Users/example/.codex/sessions/2026/10/05/rollout-x-${id}.jsonl`, cwd: '/Users/example/Ukaoma Chief Of Staff',
    hook_event_name: 'PreToolUse', model: 'gpt-6.1-sol', permission_mode: 'bypassPermissions', turn_id: 't1', tool_name: 'Bash', tool_input: { command: 'touch x' }, tool_use_id: 'call_1',
  })
  /** A Cursor Claude-compatible PreToolUse in the recorded key order (W7): conversation_id at byte 1, session_id behind tool_input. */
  const cursorTool = (input: Record<string, unknown>) => JSON.stringify({
    conversation_id: CURSOR, generation_id: CURSOR, model: 'composer-2.5', tool_name: 'Shell', tool_input: input, tool_use_id: 'u1',
    cwd: '/Users/example/Ukaoma Chief Of Staff', session_id: CURSOR, hook_event_name: 'preToolUse', cursor_version: '2026.10.01-e373342',
    workspace_roots: ['/Users/example/Ukaoma Chief Of Staff'], user_email: 'x@example.com', transcript_path: null,
  })

  it('the three halt replies, byte for byte: Claude and Cursor unchanged, Codex deny-only', () => {
    expect(JSON.parse(CODEX_DENY)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Cancelled from COS. Stop and do not work around this.' } })
    expect(CODEX_DENY).not.toContain('continue')
    const claude = halted(['a1b2c3d4-0000-4000-8000-00000000abcd'])
    expect(runAs('PreToolUse', JSON.stringify({ session_id: 'a1b2c3d4-0000-4000-8000-00000000abcd', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), claude).stdout.toString()).toBe(CLAUDE_DENY)
    const cursor = halted([CURSOR])
    expect(runAs('PreToolUse', cursorTool({ command: 'touch x' }), cursor, { CURSOR_VERSION: '2026.10.01' }).stdout.toString()).toBe(CURSOR_DENY)
    const codex = halted([CODEX])
    const r = runAs('PreToolUse', codexTool(), codex, { COS_HOOK_PROVIDER: 'codex' })
    expect(r.status).toBe(0)
    expect(r.stdout.toString()).toBe(CODEX_DENY)
    expect(r.stderr.toString()).toBe('')
    // Nothing spooled for a plain tool call, marker kept for the next one.
    expect(spooled(codex.spool)).toEqual([])
    expect(existsSync(join(codex.halt, CODEX))).toBe(true)
    // An unknown COS_HOOK_PROVIDER is no provider: a Claude payload gets the Claude bytes, and
    // (QA W13) a Codex payload is still recognised as Codex from its rollout path.
    const claudeId = 'a1b2c3d4-0000-4000-8000-00000000abcd'
    const claudeHome = halted([claudeId])
    expect(runAs('PreToolUse', JSON.stringify({ session_id: claudeId, transcript_path: '/Users/example/.claude/projects/p/x.jsonl', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), claudeHome, { COS_HOOK_PROVIDER: 'gemini' }).stdout.toString()).toBe(CLAUDE_DENY)
    expect(runAs('PreToolUse', codexTool(), codex, { COS_HOOK_PROVIDER: 'gemini' }).stdout.toString()).toBe(CODEX_DENY)
    // No marker for this Codex thread: nothing at all.
    const quiet = halted([OTHER])
    expect(runAs('PreToolUse', codexTool(), quiet, { COS_HOOK_PROVIDER: 'codex' }).stdout.toString()).toBe('')
  })

  it('Cursor: conversation_id decides, even behind a 10 KiB tool input that names another session (W7)', () => {
    // The input names another session EARLY (inside the first read) and is 10 KiB long.
    const big = { session_id: OTHER, command: 'apply', content: 'q'.repeat(10 * 1024) }
    const payload = cursorTool(big)
    expect(payload.indexOf('"conversation_id"')).toBe(1)
    // The payload's own session_id sits past the 8 KiB the halt check reads at most.
    expect(payload.indexOf(`"session_id":"${CURSOR}"`)).toBeGreaterThan(10 * 1024)
    expect(payload.indexOf(`"session_id":"${OTHER}"`)).toBeLessThan(payload.indexOf(`"session_id":"${CURSOR}"`))
    // This composer is halted: it stops.
    const p = halted([CURSOR])
    expect(runAs('PreToolUse', payload, p, { CURSOR_VERSION: '2026.10.01' }).stdout.toString()).toBe(CURSOR_DENY)
    // Only the session named inside tool_input is halted: nothing stops (6.61.7 stopped the wrong run here).
    const q = halted([OTHER])
    expect(runAs('PreToolUse', payload, q, { CURSOR_VERSION: '2026.10.01' }).stdout.toString()).toBe('')
    // A new Cursor prompt clears its OWN marker by conversation_id.
    const s = halted([CURSOR, OTHER])
    const prompt = JSON.stringify({ conversation_id: CURSOR, generation_id: CURSOR, prompt: `about ${OTHER}`, session_id: CURSOR, hook_event_name: 'beforeSubmitPrompt', cursor_version: '2026.10.01' })
    expect(runAs('UserPromptSubmit', prompt, s).status).toBe(0)
    expect(existsSync(join(s.halt, CURSOR))).toBe(false)
    expect(existsSync(join(s.halt, OTHER))).toBe(true)
  })

  it('Claude: a conversation_id inside tool_input never wins over the payload\'s own first session_id', () => {
    const own = 'a1b2c3d4-0000-4000-8000-00000000abcd'
    const p = halted([OTHER])
    const claude = JSON.stringify({ session_id: own, hook_event_name: 'PreToolUse', tool_name: 'mcp__x__y', tool_input: { conversation_id: OTHER } })
    expect(runAs('PreToolUse', claude, p).stdout.toString()).toBe('')
    const q = halted([own])
    expect(runAs('PreToolUse', claude, q).stdout.toString()).toBe(CLAUDE_DENY)
  })

  it('Codex events are spooled with "provider":"codex", Interrupt included, and parse as Codex', () => {
    const p = halted()
    const env = { COS_HOOK_PROVIDER: 'codex' }
    const base = { session_id: CODEX, transcript_path: null, cwd: '/x', model: 'gpt-6.1-sol', permission_mode: 'bypassPermissions' }
    expect(runAs('SessionStart', JSON.stringify({ ...base, hook_event_name: 'SessionStart', source: 'startup' }), p, env).status).toBe(0)
    expect(runAs('UserPromptSubmit', JSON.stringify({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 't1' }), p, env).status).toBe(0)
    expect(runAs('Interrupt', JSON.stringify({ ...base, hook_event_name: 'Interrupt', turn_id: 't1' }), p, env).status).toBe(0)
    const parsed = spooled(p.spool).sort().map(n => {
      const text = readFileSync(join(p.spool, n), 'utf-8')
      expect(text).toContain('"provider":"codex"')
      const e = parseHookEnvelope(text)
      if (!e.ok) throw new Error(e.reason)
      return e.envelope
    })
    expect(parsed.map(e => e.event).sort()).toEqual(['Interrupt', 'SessionStart', 'UserPromptSubmit'])
    expect(parsed.every(e => e.provider === 'codex' && e.sessionId === CODEX)).toBe(true)
    expect(parsed.find(e => e.event === 'SessionStart')?.payload.model).toBe('gpt-6.1-sol')
    // Only a known provider is stamped: a junk value (or one that would break the JSON) is no
    // stamp at all, and the envelope still parses.
    for (const junk of ['gemini', 'codex","event":"Stop', '']) {
      const r = halted()
      expect(runAs('Stop', JSON.stringify({ ...base, hook_event_name: 'Stop', turn_id: 't1' }), r, { COS_HOOK_PROVIDER: junk }).status).toBe(0)
      const text = readFileSync(join(r.spool, spooled(r.spool)[0]!), 'utf-8')
      expect(text, junk).not.toContain('"provider"')
      const e = parseHookEnvelope(text)
      expect(e.ok, junk).toBe(true)
    }
    // The Claude command stamps nothing: the server infers from the payload.
    const q = halted()
    expect(runAs('Stop', JSON.stringify({ session_id: 'a1b2c3d4-0000-4000-8000-00000000abcd', hook_event_name: 'Stop' }), q).status).toBe(0)
    expect(readFileSync(join(q.spool, spooled(q.spool)[0]!), 'utf-8')).not.toContain('"provider"')
  })

  it('a Codex Stop never asks for a Cursor follow-up, whatever its environment says', async () => {
    // A listener in THIS process stands in for the server's stop-followup route.
    const hits: string[] = []
    const listener = createServer((req, res) => { hits.push(String(req.url)); res.end('{}') })
    await new Promise<void>(r => listener.listen(0, '127.0.0.1', () => r()))
    try {
      const p = halted()
      writeFileSync(join(p.home, 'hook-token'), 'tok')
      writeFileSync(join(p.home, 'hook-port'), String((listener.address() as AddressInfo).port))
      const stop = JSON.stringify({ session_id: CODEX, transcript_path: null, cwd: '/x', hook_event_name: 'Stop', turn_id: 't1', cursor_version: 'forged', last_assistant_message: 'done' })
      const run = (extra: Record<string, string>) => new Promise<{ status: number | null; stdout: string }>(resolveRun => {
        const child = spawn('/bin/sh', [SCRIPT, 'Stop'], { env: { HOME: dirname(p.home), COS_GLASSES_HOME: p.home, COS_HOOK_SPOOL: p.spool, PATH: '/usr/bin:/bin', TMPDIR: p.tmp, CURSOR_VERSION: 'forged', ...extra } })
        let stdout = ''
        child.stdout.on('data', c => { stdout += c })
        child.on('close', status => resolveRun({ status, stdout }))
        child.stdin.end(stop)
      })
      expect(await run({ COS_HOOK_PROVIDER: 'codex' })).toEqual({ status: 0, stdout: '' })
      expect(hits).toEqual([])
      expect(spooled(p.spool)).toHaveLength(1)
      // The control: the same payload through the Claude command does ask, so the listener
      // above would have seen a Codex request had one been made.
      expect((await run({})).status).toBe(0)
      expect(hits).toEqual(['/hooks/cursor/stop-followup'])
    } finally {
      await new Promise<void>(r => listener.close(() => r()))
    }
  })
})

// 6.62.0 /qa (W13): a COS block Codex imported from the Claude settings runs WITHOUT
// COS_HOOK_PROVIDER. The script recognises a Codex payload itself (its rollout as the second
// key), so the halt reply is still the deny-only one Codex honours, and the spool is stamped.
describe.skipIf(!onMac)('bin/hooks/cos-session-hook: a Codex payload with no provider in the command (6.62.0 QA W13)', () => {
  const CODEX = '01a10c4b-0000-7000-8000-00000000c0de'
  const CLAUDE = 'a1b2c3d4-0000-4000-8000-00000000abcd'
  const CODEX_DENY = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Cancelled from COS. Stop and do not work around this."}}'
  const CLAUDE_DENY = '{"continue":false,"stopReason":"Cancelled from COS","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Cancelled from COS"}}'
  function halted(ids: string[] = []) {
    const paths = home()
    const halt = join(dirname(paths.spool), 'session-halt')
    mkdirSync(halt, { recursive: true })
    for (const id of ids) writeFileSync(join(halt, id), '{}')
    return { ...paths, halt, tmp: tmpRoot('cos-hook-tmp-') }
  }
  const run = (event: string, stdin: string, p: ReturnType<typeof halted>, env: Record<string, string> = {}) => spawnSync('/bin/sh', [SCRIPT, event], {
    input: stdin, env: { HOME: dirname(p.home), COS_GLASSES_HOME: p.home, COS_HOOK_SPOOL: p.spool, PATH: '/usr/bin:/bin', TMPDIR: p.tmp, ...env }, timeout: 10_000,
  })
  const codexPayload = (event: string, extra: Record<string, unknown> = {}) => JSON.stringify({
    session_id: CODEX, transcript_path: `/Users/me/.codex/sessions/2026/10/05/rollout-2026-10-05T09-00-00-${CODEX}.jsonl`, cwd: '/Users/me/Ukaoma Chief Of Staff', hook_event_name: event, model: 'gpt-6.1-sol', permission_mode: 'bypassPermissions', turn_id: 't1', ...extra,
  })

  it('halted: the deny-only reply, from the payload alone', () => {
    const p = halted([CODEX])
    const r = run('PreToolUse', codexPayload('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'touch x' } }), p)
    expect(r.status).toBe(0)
    expect(r.stdout.toString()).toBe(CODEX_DENY)
  })

  it('a Codex prompt is stamped codex; a plain Codex tool call with no marker still writes and prints nothing', () => {
    const p = halted()
    expect(run('UserPromptSubmit', codexPayload('UserPromptSubmit', { prompt: 'go' }), p).status).toBe(0)
    const names = spooled(p.spool)
    expect(names).toHaveLength(1)
    const parsed = parseHookEnvelope(readFileSync(join(p.spool, names[0]!), 'utf-8'))
    expect(parsed.ok && parsed.envelope).toMatchObject({ provider: 'codex', stamped: true, sessionId: CODEX })
    const r = run('PreToolUse', codexPayload('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), p)
    expect(r.stdout.toString()).toBe('')
    expect(spooled(p.spool)).toHaveLength(1)
  })

  it('never from a rollout path that is not the payload\'s own: Claude reading a rollout, or Cursor', () => {
    const p = halted([CLAUDE])
    // Claude's own transcript is its second key; a rollout path further in is a tool's input.
    const claude = JSON.stringify({ session_id: CLAUDE, transcript_path: '/Users/me/.claude/projects/p/x.jsonl', cwd: '/x', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/Users/me/.codex/sessions/2026/10/05/rollout-y.jsonl', transcript_path: '/Users/me/.codex/sessions/z.jsonl' } })
    expect(run('PreToolUse', claude, p).stdout.toString()).toBe(CLAUDE_DENY)
    const q = halted()
    expect(run('UserPromptSubmit', JSON.stringify({ session_id: CLAUDE, transcript_path: '/Users/me/.claude/projects/p/x.jsonl', prompt: 'read /Users/me/.codex/sessions/r.jsonl', hook_event_name: 'UserPromptSubmit' }), q).status).toBe(0)
    expect(readFileSync(join(q.spool, spooled(q.spool)[0]!), 'utf-8')).not.toContain('"provider"')
    // Cursor writes transcript_path last, far behind its session_id: never read as Codex.
    const cursor = '8c149bba-82b6-4b73-9f2f-eb26e72a72a9'
    const c = halted([cursor])
    const cursorTool = JSON.stringify({ conversation_id: cursor, model: 'composer-2.5', tool_name: 'Shell', tool_input: { command: 'ls' }, session_id: cursor, hook_event_name: 'preToolUse', cursor_version: '2026.10.01', workspace_roots: ['/x'], transcript_path: '/Users/me/.codex/sessions/odd.jsonl' })
    expect(run('PreToolUse', cursorTool, c).stdout.toString()).toBe(CLAUDE_DENY)
  })

  it('the GENERATED Codex command, run through sh as Codex runs it, prints the deny-only reply (QA N5)', () => {
    const p = halted([CODEX])
    const sub = CODEX_HOOK_SUBSCRIPTIONS.find(s => s.event === 'PreToolUse')!
    const command = codexHookCommand(SCRIPT, sub, { home: p.home, spoolDir: p.spool })
    const r = spawnSync('/bin/sh', ['-c', command], {
      input: JSON.stringify({ session_id: CODEX, transcript_path: null, cwd: '/x', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'touch x' } }),
      env: { HOME: dirname(p.home), PATH: '/usr/bin:/bin', TMPDIR: p.tmp }, timeout: 10_000,
    })
    expect(r.status).toBe(0)
    expect(r.stdout.toString()).toBe(CODEX_DENY)
  })
})
