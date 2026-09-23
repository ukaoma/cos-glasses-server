// 6.51.0: Codex Continue through the Codex app's own queue. Every verdict rule is
// executed here, and `runCodexQueueCli` is executed against a real child process.

import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, afterAll } from 'vitest'
import {
  CODEX_QUEUE_TIMEOUT_MS,
  buildCodexQueueArgs,
  classifyCodexQueueRun,
  codexLiveQueueEnabled,
  deliverOverCodexQueue,
  parseCodexQueueConfirmation,
  type CodexLiveDeps,
  type CodexQueueRun,
} from './codex-live-queue.js'
import { __resetCodexLiveStatsForTests, codexLiveStats, makeCodexLiveDeliverer, runCodexQueueCli } from './codex-live-queue-deps.js'

// Every temp root this file makes is removed when the file ends (6.53.3 /qa W3: the suites
// had left ~150,000 `cos-*` folders in $TMPDIR). Tracked at the mkdtemp call, so a new test
// cannot forget it.
const trackedTempRoots: string[] = []
function trackedTemp<T extends string>(root: T): T {
  trackedTempRoots.push(root)
  return root
}
afterAll(() => {
  for (const root of trackedTempRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* a chmod'ed tree: best effort */ }
  }
})

const THREAD = '01a00da5-8026-7bf3-a9cb-47e61f06ab29'
const QUEUED = '01a0b9d6-5dcb-7453-b0b3-54180516fa4f'
// The exact line codex-cli 0.155.0-alpha.9.2 printed in the 2026-09-19 canary.
const CONFIRM = `Queued message ${QUEUED} for thread ${THREAD}.\n`
const ok = (over: Partial<CodexQueueRun> = {}): CodexQueueRun => ({ code: 0, stdout: CONFIRM, stderr: '', timedOut: false, spawnError: null, ...over })

describe('buildCodexQueueArgs', () => {
  it('uses the --flag=value form so a prompt that starts with a dash stays text', () => {
    expect(buildCodexQueueArgs(THREAD, '-h')).toEqual(['queue', `--thread=${THREAD}`, '--message=-h'])
    expect(buildCodexQueueArgs(THREAD, 'two\nlines')).toEqual(['queue', `--thread=${THREAD}`, '--message=two\nlines'])
  })
  it('refuses an id that is not a native thread id, an empty prompt, and a NUL', () => {
    expect(() => buildCodexQueueArgs('../x', 'hi')).toThrow()
    expect(() => buildCodexQueueArgs(`${THREAD}.lock`, 'hi')).toThrow()
    expect(() => buildCodexQueueArgs(THREAD, '   ')).toThrow()
    expect(() => buildCodexQueueArgs(THREAD, 'a\0b')).toThrow()
  })
})

describe('parseCodexQueueConfirmation', () => {
  it('returns the queued id only when the line names OUR thread', () => {
    expect(parseCodexQueueConfirmation(CONFIRM, THREAD)).toBe(QUEUED)
    expect(parseCodexQueueConfirmation(CONFIRM, THREAD.toUpperCase())).toBe(QUEUED)
    expect(parseCodexQueueConfirmation(CONFIRM.replace(THREAD, '01a0b9c5-0271-7bd0-9072-3e29e33bd6d4'), THREAD)).toBeNull()
    expect(parseCodexQueueConfirmation('', THREAD)).toBeNull()
    expect(parseCodexQueueConfirmation(`warming up\n${CONFIRM}`, THREAD)).toBe(QUEUED)
  })
})

describe('classifyCodexQueueRun', () => {
  it('delivered needs exit 0 AND the confirmation', () => {
    expect(classifyCodexQueueRun(ok(), THREAD)).toEqual({ reason: 'delivered', queuedId: QUEUED })
    expect(classifyCodexQueueRun(ok({ stdout: '' }), THREAD).reason).toBe('unverified')
  })
  it('a spawn error is nothing sent; a timeout or a kill might have inserted', () => {
    expect(classifyCodexQueueRun(ok({ code: null, stdout: '', spawnError: 'ENOENT' }), THREAD).reason).toBe('spawn_failed')
    expect(classifyCodexQueueRun(ok({ code: null, stdout: '', timedOut: true }), THREAD).reason).toBe('unverified')
    expect(classifyCodexQueueRun(ok({ code: null, stdout: '' }), THREAD).reason).toBe('unverified')
  })
  it('only the CLI\'s own "failed to queue" is a refusal; any other nonzero exit is unverified', () => {
    const refusal = 'Error: failed to queue session message: thread/queue/add failed: failed to read thread: invalid thread-store request: no rollout found for thread id x (code -32603)'
    expect(classifyCodexQueueRun(ok({ code: 1, stdout: '', stderr: refusal }), THREAD).reason).toBe('refused')
    expect(classifyCodexQueueRun(ok({ code: 1, stdout: '', stderr: 'panicked at somewhere' }), THREAD).reason).toBe('unverified')
    expect(classifyCodexQueueRun(ok({ code: 2, stdout: CONFIRM, stderr: '' }), THREAD).reason).toBe('unverified')
  })
  it('a clap usage error (exit 2) queued nothing: a codex without `queue`, or a renamed flag', () => {
    const noQueue = "error: unrecognized subcommand 'queue'\n\nUsage: codex [OPTIONS] [PROMPT]\n"
    expect(classifyCodexQueueRun(ok({ code: 2, stdout: '', stderr: noQueue }), THREAD).reason).toBe('refused')
    expect(classifyCodexQueueRun(ok({ code: 2, stdout: '', stderr: "error: unexpected argument '--message' found\n" }), THREAD).reason).toBe('refused')
    // The same words on another exit code are not clap's refusal.
    expect(classifyCodexQueueRun(ok({ code: 1, stdout: '', stderr: noQueue }), THREAD).reason).toBe('unverified')
  })
})

describe('deliverOverCodexQueue', () => {
  const deps = (over: Partial<CodexLiveDeps> = {}): CodexLiveDeps & { calls: Array<{ binary: string; args: readonly string[]; timeoutMs: number }> } => {
    const calls: Array<{ binary: string; args: readonly string[]; timeoutMs: number }> = []
    return {
      calls,
      resolveBinary: () => '/Applications/ChatGPT.app/Contents/Resources/codex',
      run: async (binary, args, timeoutMs) => { calls.push({ binary, args, timeoutMs }); return ok() },
      now: () => 1000,
      ...over,
    }
  }
  const request = { provider: 'codex', sessionId: THREAD, prompt: 'keep going', enabled: true, foreignHolder: true }

  it('queues through the resolved binary with the built argv and the default ceiling', async () => {
    const d = deps()
    const r = await deliverOverCodexQueue(request, d)
    expect(r).toMatchObject({ ok: true, reason: 'delivered', verifiedBy: 'codex-queue', queuedId: QUEUED, pid: null })
    expect(d.calls).toEqual([{ binary: '/Applications/ChatGPT.app/Contents/Resources/codex', args: buildCodexQueueArgs(THREAD, 'keep going'), timeoutMs: CODEX_QUEUE_TIMEOUT_MS }])
  })
  it('runs nothing when disabled, for another provider, or without a foreign holder', async () => {
    for (const [over, reason] of [
      [{ enabled: false }, 'disabled'],
      [{ provider: 'claude' }, 'no_holder'],
      [{ foreignHolder: false }, 'no_holder'],
    ] as const) {
      const d = deps()
      const r = await deliverOverCodexQueue({ ...request, ...over }, d)
      expect(r, reason).toMatchObject({ ok: false, reason })
      expect(d.calls, reason).toEqual([])
    }
  })
  it('an unusable request or a missing binary sends nothing', async () => {
    const d = deps()
    expect((await deliverOverCodexQueue({ ...request, sessionId: 'nope' }, d)).reason).toBe('invalid_request')
    expect((await deliverOverCodexQueue(request, deps({ resolveBinary: () => null }))).reason).toBe('binary_not_found')
    expect((await deliverOverCodexQueue(request, deps({ resolveBinary: () => { throw new Error('x') } }))).reason).toBe('binary_not_found')
    expect(d.calls).toEqual([])
  })
  it('a run that rejects is unverified, never "nothing sent"', async () => {
    const r = await deliverOverCodexQueue(request, deps({ run: async () => { throw new Error('boom') } }))
    expect(r).toMatchObject({ ok: false, reason: 'unverified', verifiedBy: null })
  })
  it('never logs the prompt', async () => {
    const lines: string[] = []
    await deliverOverCodexQueue({ ...request, prompt: 'SECRET-PROMPT-TEXT' }, deps({ log: (_l, e, d) => lines.push(e + JSON.stringify(d)) }))
    await deliverOverCodexQueue({ ...request, prompt: 'SECRET-PROMPT-TEXT' }, deps({ run: async () => ok({ code: 1, stdout: '', stderr: 'other' }), log: (_l, e, d) => lines.push(e + JSON.stringify(d)) }))
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line).not.toContain('SECRET-PROMPT-TEXT')
  })
})

describe('codexLiveQueueEnabled', () => {
  it('is on unless set to exactly "0"', () => {
    expect(codexLiveQueueEnabled({})).toBe(true)
    expect(codexLiveQueueEnabled({ COS_CODEX_LIVE_QUEUE: '1' })).toBe(true)
    expect(codexLiveQueueEnabled({ COS_CODEX_LIVE_QUEUE: '' })).toBe(true)
    expect(codexLiveQueueEnabled({ COS_CODEX_LIVE_QUEUE: '0' })).toBe(false)
  })
})

describe('runCodexQueueCli, executed against a real child', () => {
  const dir = trackedTemp(mkdtempSync(join(tmpdir(), 'cos codex cli '))) // a space, like "Application Support"
  const script = (name: string, body: string) => {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  it('passes argv without a shell and captures stdout, stderr and the exit code', async () => {
    const echo = script('echo-args', 'printf "%s|" "$@"; printf "err" >&2; exit 3')
    const run = await runCodexQueueCli(echo, ['queue', `--thread=${THREAD}`, '--message=$(touch /tmp/x) ; rm -rf ~'], 5_000)
    expect(run).toMatchObject({ code: 3, stderr: 'err', timedOut: false, spawnError: null })
    // The metacharacters arrived as one literal argument: no shell ever saw them.
    expect(run.stdout).toBe(`queue|--thread=${THREAD}|--message=$(touch /tmp/x) ; rm -rf ~|`)
  })

  it('kills and reports a CLI that hangs past the ceiling', async () => {
    const hang = script('hang', 'sleep 30')
    const started = Date.now()
    const run = await runCodexQueueCli(hang, [], 300)
    expect(run).toMatchObject({ code: null, timedOut: true, spawnError: null })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('answers at the ceiling even when a grandchild escaped the group and holds stdout open', async () => {
    // A daemonising grandchild (its own session) survives the group kill and keeps the pipe
    // open, so 'close' would not fire until it exits. The runner must not wait for it.
    const pidFile = join(dir, 'escaped.pid')
    const escape = script('escape', `perl -MPOSIX -e 'POSIX::setsid(); open(my $f, ">", $ARGV[0]); print $f $$; close $f; sleep 30' '${pidFile}' &\nsleep 30`)
    const started = Date.now()
    try {
      const run = await runCodexQueueCli(escape, [], 400)
      expect(run).toMatchObject({ code: null, timedOut: true, spawnError: null })
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      try {
        const { readFileSync } = await import('node:fs')
        process.kill(Number(readFileSync(pidFile, 'utf-8').trim()), 'SIGKILL')
      } catch { /* never started, or already gone */ }
    }
  })

  it('reports a binary that cannot start as a spawn error', async () => {
    const run = await runCodexQueueCli(join(dir, 'does-not-exist'), [], 1_000)
    expect(run.spawnError).not.toBeNull()
    expect(run.code).toBeNull()
  })

  it('end to end through the real runner: a CLI printing the confirmation is delivered', async () => {
    const fake = script('codex', `printf 'Queued message ${QUEUED} for thread %s.\\n' "$(printf '%s' "$2" | sed 's/^--thread=//')"`)
    const r = await deliverOverCodexQueue(
      { provider: 'codex', sessionId: THREAD, prompt: 'hello', enabled: true, foreignHolder: true },
      { resolveBinary: () => fake, run: runCodexQueueCli, now: () => Date.now() },
    )
    expect(r).toMatchObject({ ok: true, reason: 'delivered', queuedId: QUEUED })
  })
})

describe('makeCodexLiveDeliverer health counters', () => {
  beforeEach(() => __resetCodexLiveStatsForTests())

  it('counts attempts, deliveries and fallbacks, but not "disabled" or "no_holder"', async () => {
    const deliver = makeCodexLiveDeliverer({ resolveBinary: () => '/x/codex', run: async () => ok(), enabled: () => true })
    const req = { provider: 'codex', sessionId: THREAD, prompt: 'p' }
    await deliver({ ...req, foreignHolder: true })
    await deliver({ ...req, foreignHolder: false })
    const failing = makeCodexLiveDeliverer({ resolveBinary: () => '/x/codex', run: async () => ok({ code: 1, stdout: '', stderr: 'failed to queue session message: x' }), enabled: () => true })
    await failing({ ...req, foreignHolder: true })
    const off = makeCodexLiveDeliverer({ resolveBinary: () => '/x/codex', run: async () => ok(), enabled: () => false })
    await off({ ...req, foreignHolder: true })
    const stats = codexLiveStats()
    expect(stats).toMatchObject({ attempts: 2, delivered: 1, fallbacks: { refused: 1 }, lastReason: 'refused' })
  })
})
