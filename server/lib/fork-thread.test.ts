// Behavioural tests for fork.
//
// WHAT THESE ASSERT ON. The outcomes a caller acts on: does a NEW thread exist,
// what is its id, is it different from the source, and was the source left alone.
// Nothing below asserts on source text and nothing compares two literals from the
// module to each other.
//
// FIXTURE REALISM, AND WHY IT IS LOAD-BEARING HERE. Every id in this file was
// produced by a real provider on this machine on 2026-08-16, not invented:
//
//   claude  source 6d12ff82-… -> fork d92ad220-…
//   codex   source 01a00ab4-7350-74a3-… -> fork 01a00ab4-b9fd-7680-…
//
// The codex pair is the reason a made-up fixture would have been worthless. Codex
// mints UUIDv7, so a thread and its fork created seconds apart SHARE THEIR ENTIRE
// FIRST BLOCK. Two randomly-typed UUIDs would have passed a prefix comparison, a
// display-form (8-char) comparison and a full comparison identically, and the
// suite would have been structurally incapable of catching the bug that matters
// most in this module. `distinguishes ids that share a UUIDv7 prefix` below is the
// test that only works because the fixtures are real.
//
// NO REAL PROVIDER IS EVER SPAWNED. `spawn` is injected in every case, and so is
// `terminate`, so nothing here can signal a real process group on the developer's
// machine with a fabricated pid.

import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  buildClaudeForkArgs,
  buildCodexForkArgs,
  compareWatermarks,
  forkOrphanPossible,
  forkThread,
  selectForkedId,
  type ForkDeps,
  type ForkResult,
} from './fork-thread.js'
import type { AttachedChildProcess } from './attached-provider-adapter.js'

afterEach(() => {
  delete process.env.COS_CODEX_EXTRA_ARGS
})

// --- real, measured values ---------------------------------------------------

const CLAUDE_SOURCE = '6d12ff82-51fa-48b0-9e83-f4091a4f4c98'
const CLAUDE_FORK = 'd92ad220-34b4-4f67-b2d8-1d1dd00a2dce'
/** Same first block as its fork. UUIDv7. This is not a typo. */
const CODEX_SOURCE = '01a00ab4-7350-74a3-bfac-743d1f129630'
const CODEX_FORK = '01a00ab4-b9fd-7680-904a-21e49cc9af2c'

const CWD = '/Users/ukaoma/Documents/GitHub/cos-glasses-server'
const CLAUDE_BIN = '/opt/homebrew/bin/claude'
const CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex'
const PID = 7872
/** Kernel-measured start, truncated to the second, as `ps lstart` reports it. */
const MEASURED_START = Date.UTC(2026, 7, 16, 2, 3, 5)
const PROMPT = 'Reply with the single word FORKED.'

/** Real claude stream-json shape: session_id on every event, one distinct value. */
const claudeStdout = (sessionId: string): string[] => [
  `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, cwd: CWD, model: 'claude-opus-5', permissionMode: 'plan' })}\n`,
  `${JSON.stringify({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'FORKED' }] } })}\n`,
  `${JSON.stringify({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, num_turns: 1 })}\n`,
]

/** Real codex --json shape: the id arrives once, on thread.started. */
const codexStdout = (threadId: string): string[] => [
  `${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`,
  `${JSON.stringify({ type: 'turn.started' })}\n`,
  `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'FORKED' } })}\n`,
  `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 3 } })}\n`,
]

// --- the fake child ----------------------------------------------------------

interface FakeOptions {
  pid?: number | undefined
  stdout?: string[]
  stderr?: string
  exitCode?: number | null
  emitError?: boolean
  noStdin?: boolean
  noStdout?: boolean
  writeThrows?: boolean
  /** Runs forever unless terminated. */
  neverExits?: boolean
}

interface Fake {
  child: AttachedChildProcess
  written: () => string
  stdinEnded: () => boolean
  /** Emit the configured output and exit. */
  finish: () => void
}

function fakeChild(opts: FakeOptions = {}): Fake {
  const listeners: Record<string, ((arg?: any) => void)[]> = {}
  const add = (ev: string, fn: (arg?: any) => void) => { (listeners[ev] ??= []).push(fn) }
  const emit = (ev: string, arg?: any) => { for (const fn of (listeners[ev] ?? []).slice()) fn(arg) }

  let written = ''
  let ended = false
  let done = false

  const finish = () => {
    if (done) return
    done = true
    if (opts.stderr !== undefined) emit('stderr', opts.stderr)
    for (const chunk of opts.stdout ?? []) emit('stdout', chunk)
    if (opts.emitError === true) { emit('error', new Error('spawn ENOENT')); return }
    const code = opts.exitCode === undefined ? 0 : opts.exitCode
    emit('exit', code)
    emit('close', code)
  }

  const child = {
    pid: 'pid' in opts ? opts.pid : PID,
    stdout: opts.noStdout === true ? null : { on: (ev: string, fn: any) => add(ev === 'data' ? 'stdout' : 'stdout_error', fn) },
    stderr: { on: (ev: string, fn: any) => add(ev === 'data' ? 'stderr' : 'stderr_error', fn) },
    stdin: opts.noStdin === true ? null : {
      write: (chunk: string) => {
        if (opts.writeThrows === true) throw new Error('EPIPE')
        written += chunk
        return true
      },
      end: () => {
        ended = true
        if (opts.neverExits !== true) queueMicrotask(finish)
      },
      on: () => undefined,
    },
    on: (ev: string, fn: any) => add(ev, fn),
  } as unknown as AttachedChildProcess

  return { child, written: () => written, stdinEnded: () => ended, finish }
}

// --- the dependency set ------------------------------------------------------

interface Harness {
  deps: ForkDeps
  spawns: { binaryPath: string; args: readonly string[]; cwd: string }[]
  recorded: [number, number][]
  released: number[]
  signals: NodeJS.Signals[]
  fake: Fake
}

function harness(over: Partial<ForkDeps> = {}, fakeOpts: FakeOptions = {}, binary = CLAUDE_BIN): Harness {
  const spawns: Harness['spawns'] = []
  const recorded: [number, number][] = []
  const released: number[] = []
  const signals: NodeJS.Signals[] = []
  const fake = fakeChild(fakeOpts)

  const deps: ForkDeps = {
    now: () => 1_786_000_000_000,
    resolveBinary: () => ({ ok: true, path: binary, source: 'absolute' }),
    spawn: request => {
      spawns.push({ binaryPath: request.binaryPath, args: request.args, cwd: request.cwd })
      return fake.child
    },
    processStartMs: () => MEASURED_START,
    recordSpawn: (pid, startMs) => { recorded.push([pid, startMs]); return 'recorded' },
    releaseSpawn: pid => { released.push(pid); return true },
    terminate: (_child, signal) => { signals.push(signal) },
    ...over,
  }
  return { deps, spawns, recorded, released, signals, fake }
}

function run(h: Harness, over: Partial<Parameters<typeof forkThread>[0]> = {}): Promise<ForkResult> {
  return forkThread({
    provider: 'claude',
    nativeThreadId: CLAUDE_SOURCE,
    prompt: PROMPT,
    cwd: CWD,
    policy: 'read_only',
    deps: h.deps,
    ...over,
  })
}

/** The happy claude path, so each test below only states what it changes. */
function claudeRun(over: Partial<ForkDeps> = {}) {
  return harness(over, { stdout: claudeStdout(CLAUDE_FORK) })
}

function codexRun(over: Partial<ForkDeps> = {}) {
  return harness(over, { stdout: codexStdout(CODEX_FORK) }, CODEX_BIN)
}

// =============================================================================

describe('the property that makes fork safe to offer', () => {
  it('returns a new thread id that differs from the source', async () => {
    const h = claudeRun()
    const result = await run(h)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.newNativeThreadId).toBe(CLAUDE_FORK)
    expect(result.newNativeThreadId).not.toBe(CLAUDE_SOURCE)
    expect(result.sourceNativeThreadId).toBe(CLAUDE_SOURCE)
  })

  it('is a terminal failure when the provider hands back the SOURCE id', async () => {
    // The single most important branch in the module. A provider that returns the
    // id we asked it to fork FROM did not fork — it appended to the user's real
    // conversation, using the path we offer as the safe alternative to appending.
    const h = harness({}, { stdout: claudeStdout(CLAUDE_SOURCE) })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('fork_returned_source_id')
  })

  it('never reports the source id as a bind target after that failure', async () => {
    // The separate, worse bug: refusing correctly but still filling in a field
    // named `newNativeThreadId` with the user's own live thread, which is exactly
    // the value a caller would go on to bind a COS chat to.
    const h = harness({}, { stdout: claudeStdout(CLAUDE_SOURCE) })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.newNativeThreadId).toBeNull()
  })

  it('distinguishes ids that share a UUIDv7 prefix', async () => {
    // Real codex values. Both begin `01a00ab4-`. A prefix or display-form (8 char)
    // comparison reads this legitimate fork as a write into the source and refuses
    // every codex fork forever; the inverse branch would accept a real append.
    expect(CODEX_FORK.slice(0, 8)).toBe(CODEX_SOURCE.slice(0, 8))
    const h = codexRun()
    const result = await run(h, { provider: 'codex', nativeThreadId: CODEX_SOURCE })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.newNativeThreadId).toBe(CODEX_FORK)
  })

  it('refuses when the provider prints two candidate ids', async () => {
    // Both live canaries printed exactly one. Two means this build no longer reads
    // the provider's output, and binding to the wrong one of two candidates is
    // worse than one retry. Never "pick the one that is not the source".
    const h = harness({}, {
      stdout: [
        `${JSON.stringify({ type: 'system', subtype: 'init', session_id: CLAUDE_FORK })}\n`,
        `${JSON.stringify({ type: 'result', session_id: '11111111-2222-4333-8444-555555555555' })}\n`,
      ],
    })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('ambiguous_native_id')
    expect(result.newNativeThreadId).toBeNull()
  })

  it('refuses a clean exit that named no thread at all', async () => {
    const h = harness({}, { stdout: [`${JSON.stringify({ type: 'turn.completed' })}\n`], exitCode: 0 })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('no_native_id_returned')
  })

  it('does not mistake a UUID the model typed in its answer for a thread id', async () => {
    // Ids come from known top-level fields of parsed JSON only. Prose lives inside
    // a string field, so a model quoting a UUID cannot manufacture a second
    // candidate and turn a good fork into `ambiguous_native_id`.
    const h = harness({}, {
      stdout: [
        `${JSON.stringify({ type: 'system', subtype: 'init', session_id: CLAUDE_FORK })}\n`,
        `${JSON.stringify({ type: 'assistant', session_id: CLAUDE_FORK, message: { content: [{ type: 'text', text: `the old thread was ${CLAUDE_SOURCE} I think` }] } })}\n`,
      ],
    })
    const result = await run(h)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.newNativeThreadId).toBe(CLAUDE_FORK)
  })

  it('still finds the id when the provider omits a trailing newline', async () => {
    const h = harness({}, { stdout: [JSON.stringify({ type: 'thread.started', thread_id: CODEX_FORK })] })
    const result = await run(h, { provider: 'codex', nativeThreadId: CODEX_SOURCE })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.newNativeThreadId).toBe(CODEX_FORK)
  })
})

describe('selectForkedId', () => {
  it('accepts exactly one id that differs from the source', () => {
    expect(selectForkedId([CLAUDE_FORK], CLAUDE_SOURCE)).toEqual({ ok: true, newNativeThreadId: CLAUDE_FORK })
  })

  it('treats a repeated single id as one id', () => {
    // claude prints session_id on every event, so the raw scan legitimately sees
    // the same value many times. Collapsing must happen before the count check or
    // every real claude fork lands in `ambiguous_native_id`.
    const verdict = selectForkedId([CLAUDE_FORK, CLAUDE_FORK, CLAUDE_FORK], CLAUDE_SOURCE)
    expect(verdict).toEqual({ ok: true, newNativeThreadId: CLAUDE_FORK })
  })

  it('rejects the source id even when it is the only one', () => {
    const verdict = selectForkedId([CLAUDE_SOURCE], CLAUDE_SOURCE)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.reason).toBe('fork_returned_source_id')
  })

  it('refuses to judge against a source id that is not a valid thread id', () => {
    // Reached only through a caller that skipped validation. With no comparable
    // source there is no fork/append distinction to draw, so there is no verdict.
    const verdict = selectForkedId([CLAUDE_FORK], '6d12ff82')
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.reason).toBe('ambiguous_native_id')
  })

  it('drops values that are not thread ids rather than counting them', () => {
    const verdict = selectForkedId(['', 'not-a-uuid', CLAUDE_FORK], CLAUDE_SOURCE)
    expect(verdict).toEqual({ ok: true, newNativeThreadId: CLAUDE_FORK })
  })

  it('refuses a non-array input instead of reading it as empty', () => {
    const verdict = selectForkedId(null as unknown as string[], CLAUDE_SOURCE)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    // Not `no_native_id_returned`: a wiring bug means "we cannot tell", not
    // "the provider produced nothing".
    expect(verdict.reason).toBe('ambiguous_native_id')
  })
})

describe('the source thread is left alone', () => {
  it('reports verified_unchanged when the watermark matches on both sides', async () => {
    const h = claudeRun({ sourceWatermark: () => 'nh1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    const result = await run(h)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sourceIntegrity).toBe('verified_unchanged')
  })

  it('turns a successful run into a failure when the source moved', async () => {
    // The run itself was clean and produced a usable new id. It is still a failure,
    // because the one thing fork promises is that the original is untouched.
    let calls = 0
    const h = claudeRun({ sourceWatermark: () => (++calls === 1 ? 'nh1:before' : 'nh1:after') })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('source_thread_mutated')
    expect(result.sourceIntegrity).toBe('mutated')
  })

  it('still names the forked thread when the source moved', async () => {
    // So an operator can find both halves of the mess. The caller must not present
    // it as a clean fork, but losing the id would leave an unfindable orphan.
    let calls = 0
    const h = claudeRun({ sourceWatermark: () => (++calls === 1 ? 'nh1:before' : 'nh1:after') })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.newNativeThreadId).toBe(CLAUDE_FORK)
  })

  it('reports unverified, never verified, when no watermark is wired', async () => {
    const h = claudeRun()
    const result = await run(h)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sourceIntegrity).toBe('unverified')
  })

  it('reports unverified when the watermark reader throws', async () => {
    const h = claudeRun({ sourceWatermark: () => { throw new Error('EACCES') } })
    const result = await run(h)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sourceIntegrity).toBe('unverified')
  })

  it('reports unverified when only the BEFORE reading succeeded', async () => {
    // "I could not read it twice" is not "it did not change". This is the exact
    // substitution the feature's own history warns about.
    let calls = 0
    const h = claudeRun({ sourceWatermark: () => (++calls === 1 ? 'nh1:before' : null) })
    const result = await run(h)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sourceIntegrity).toBe('unverified')
  })

  it('reads the baseline before the child is ever spawned', async () => {
    // A watermark taken after the spawn cannot prove anything about the run.
    const order: string[] = []
    const h = harness(
      { sourceWatermark: () => { order.push('watermark'); return 'nh1:x' } },
      { stdout: claudeStdout(CLAUDE_FORK) },
    )
    const spawn = h.deps.spawn
    h.deps.spawn = req => { order.push('spawn'); return spawn(req) }
    await run(h)
    expect(order[0]).toBe('watermark')
    expect(order).toContain('spawn')
  })

  it('compareWatermarks never upgrades a missing reading to verified', () => {
    expect(compareWatermarks(null, 'nh1:a')).toBe('unverified')
    expect(compareWatermarks('nh1:a', null)).toBe('unverified')
    expect(compareWatermarks(null, null)).toBe('unverified')
    expect(compareWatermarks('nh1:a', 'nh1:a')).toBe('verified_unchanged')
    expect(compareWatermarks('nh1:a', 'nh1:b')).toBe('mutated')
  })
})

describe('fork does not consult occupancy', () => {
  it('completes without reading any dependency the module does not declare', async () => {
    // The entire reason fork is the fallback: a live desktop owner of the source
    // must NOT block it. Occupancy cannot be consulted without a dependency to
    // consult it through, so a future gate would have to add one — and reading an
    // undeclared key here throws.
    const declared = new Set([
      'now', 'resolveBinary', 'spawn', 'processStartMs',
      'recordSpawn', 'releaseSpawn', 'terminate', 'sourceWatermark', 'buildArgs',
    ])
    const h = claudeRun()
    const guarded = new Proxy(h.deps, {
      get(target, prop) {
        if (typeof prop === 'string' && !declared.has(prop)) {
          throw new Error(`fork read an undeclared dependency: ${prop}`)
        }
        return (target as any)[prop]
      },
    })
    const result = await forkThread({
      provider: 'claude', nativeThreadId: CLAUDE_SOURCE, prompt: PROMPT,
      cwd: CWD, policy: 'read_only', deps: guarded,
    })
    expect(result.ok).toBe(true)
  })
})

describe('what reaches the operating system', () => {
  it('asks claude to fork rather than to resume in place', async () => {
    const h = claudeRun()
    await run(h)
    const args = h.spawns[0]!.args
    expect(args).toContain('--fork-session')
    expect(args[args.indexOf('--resume') + 1]).toBe(CLAUDE_SOURCE)
  })

  it('orders the codex argv so exec options precede the fork subcommand', async () => {
    // `--sandbox` and `--cd` belong to `exec`; placing either after `fork` makes
    // the CLI reject the invocation. Verified against codex-cli 0.148.0-alpha.9.
    const h = codexRun()
    await run(h, { provider: 'codex', nativeThreadId: CODEX_SOURCE })
    const args = [...h.spawns[0]!.args]
    expect(args.indexOf('--sandbox')).toBeLessThan(args.indexOf('fork'))
    expect(args.indexOf('--cd')).toBeLessThan(args.indexOf('fork'))
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
    expect(args[args.length - 1]).toBe('-')
    expect(args[args.length - 2]).toBe(CODEX_SOURCE)
  })

  it('keeps the prompt out of argv for both providers', async () => {
    // argv is world-readable through `ps`; the prompt is the user's private text.
    for (const [provider, source, h] of [
      ['claude', CLAUDE_SOURCE, claudeRun()],
      ['codex', CODEX_SOURCE, codexRun()],
    ] as const) {
      await run(h, { provider, nativeThreadId: source })
      expect(h.spawns[0]!.args.join(' ')).not.toContain(PROMPT)
    }
  })

  it('hands the prompt to stdin byte for byte and closes the pipe', async () => {
    // Closing matters on its own: the codex CLI reads stdin whether or not a prompt
    // argument was supplied, so an unclosed pipe hangs the child until the timeout.
    const h = claudeRun()
    await run(h)
    expect(h.fake.written()).toBe(PROMPT)
    expect(h.fake.stdinEnded()).toBe(true)
  })

  it('spawns in the resolved binary and the caller cwd', async () => {
    const h = codexRun()
    await run(h, { provider: 'codex', nativeThreadId: CODEX_SOURCE })
    expect(h.spawns[0]!.binaryPath).toBe(CODEX_BIN)
    expect(h.spawns[0]!.cwd).toBe(CWD)
  })

  it('strips the COS token from the child environment', async () => {
    // A fork drives a model against the user's workspace. The server's own API
    // token should not be one prompt away from being readable.
    process.env.COS_API_TOKEN = 'secret-token-value'
    try {
      const captured: NodeJS.ProcessEnv[] = []
      const h = claudeRun()
      const spawn = h.deps.spawn
      h.deps.spawn = req => { captured.push(req.env); return spawn(req) }
      await run(h)
      expect(captured[0]!.COS_API_TOKEN).toBeUndefined()
    } finally {
      delete process.env.COS_API_TOKEN
    }
  })

  it('refuses an argv carrying a banned permission flag, with zero spawns', async () => {
    const h = claudeRun({
      buildArgs: () => ['-p', '--resume', CLAUDE_SOURCE, '--fork-session', '--dangerously-skip-permissions'],
    })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unsupported_policy')
    expect(h.spawns).toHaveLength(0)
  })

  it('refuses a banned flag that arrives fused to its value', async () => {
    // Substring, not equality: `--permission-mode=bypassPermissions` is one argv
    // element, and an equality check waves it through while looking correct.
    const h = claudeRun({
      buildArgs: () => ['-p', '--resume', CLAUDE_SOURCE, '--permission-mode=bypassPermissions'],
    })
    const result = await run(h)
    expect(result.ok).toBe(false)
    expect(h.spawns).toHaveLength(0)
  })

  it('claude fork argv carries no --tools flag', () => {
    // Regression, verified live 2026-08-26: `--tools ''` on a fork-resume makes
    // the current CLI attempt a context compaction that fails (too_few_groups)
    // and then report a synthetic 400 "Prompt is too long" with zero input
    // tokens -- every claude fork refused orphan_possible while the transcript
    // copy existed. Single-flag bisection isolated it; plan + empty
    // allowedTools alone complete normally and keep the read-only stance.
    expect(buildClaudeForkArgs(CLAUDE_SOURCE)).not.toContain('--tools')
  })

  it('emits no banned flag from the real builders', () => {
    const both = [...buildClaudeForkArgs(CLAUDE_SOURCE), ...buildCodexForkArgs(CODEX_SOURCE, CWD)].join(' ')
    for (const banned of ['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--full-auto', '--yolo', 'danger-full-access', 'bypassPermissions']) {
      expect(both).not.toContain(banned)
    }
  })

  it('ignores COS_CODEX_EXTRA_ARGS on fork argv', () => {
    process.env.COS_CODEX_EXTRA_ARGS = '--oss --local-provider ollama --model qwen2.5-coder'
    expect(buildCodexForkArgs(CODEX_SOURCE, CWD)).toEqual([
      'exec',
      '--sandbox', 'read-only',
      '--cd', CWD,
      'fork',
      '--json',
      '--skip-git-repo-check',
      CODEX_SOURCE,
      '-',
    ])
  })
})

describe('the self-ownership claim', () => {
  it('records the child before any queued microtask can observe the ledger', async () => {
    // `claude --resume <id> --fork-session` still RESUMES before it forks, so while
    // it runs there is a live process associated with the SOURCE thread. A single
    // await between spawn and record lets an occupancy scan read our own child as a
    // foreign desktop owner, and the source becomes permanently un-continuable — a
    // fork that silently breaks Continue for the thread it forked from.
    let ledgerSeenByMicrotask: number | null = null
    const h = claudeRun()
    const spawn = h.deps.spawn
    h.deps.spawn = req => {
      const child = spawn(req)
      queueMicrotask(() => { ledgerSeenByMicrotask = h.recorded.length })
      return child
    }
    await run(h)
    expect(ledgerSeenByMicrotask).toBe(1)
  })

  it('records the MEASURED kernel start, not the wall clock', async () => {
    // The kernel value is truncated to the second, so `Date.now()` at the spawn
    // call is off by up to 992ms against a 1500ms tolerance. A near miss disables
    // self-identification silently rather than failing loudly.
    const h = claudeRun()
    await run(h)
    expect(h.recorded).toEqual([[PID, MEASURED_START]])
    expect(h.recorded[0]![1]).not.toBe(h.deps.now())
  })

  it('kills the child and sends nothing when the ledger refuses the claim', async () => {
    const h = claudeRun({ recordSpawn: () => 'rejected_start_not_recent' })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('ownership_record_failed')
    expect(result.detail).toBe('rejected_start_not_recent')
    expect(h.fake.written()).toBe('')
    expect(h.signals).toContain('SIGKILL')
  })

  it('reports no orphan when the claim failed before the prompt', async () => {
    // Nothing was sent, so nothing was forked. Telling the user to go hunt for a
    // stray thread would be a false alarm.
    const h = claudeRun({ recordSpawn: () => 'rejected_pid' })
    const result = await run(h)
    expect(forkOrphanPossible(result)).toBe(false)
  })

  it('refuses when the process start cannot be measured', async () => {
    const h = claudeRun({ processStartMs: () => null })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('ownership_record_failed')
    expect(result.detail).toBe('start_unavailable')
  })

  it('releases the ledger entry on success', async () => {
    const h = claudeRun()
    await run(h)
    expect(h.released).toEqual([PID])
  })

  it('releases the ledger entry when the provider exits non-zero', async () => {
    const h = harness({}, { stdout: [], exitCode: 3 })
    const result = await run(h)
    expect(result.ok).toBe(false)
    expect(h.released).toEqual([PID])
  })

  it('releases the ledger entry when the returned id is unusable', async () => {
    // A leaked entry outlives the process and lets a RECYCLED pid inherit our
    // self-ownership claim — the one input that can turn a live foreign owner into
    // `attachable`.
    const h = harness({}, { stdout: claudeStdout(CLAUDE_SOURCE) })
    await run(h)
    expect(h.released).toEqual([PID])
  })

  it('releases the ledger entry when the child throws mid-run', async () => {
    const h = claudeRun()
    const original = h.deps.spawn
    h.deps.spawn = req => {
      const child = original(req)
      ;(child as any).stdout = { on: () => { throw new Error('stream wiring blew up') } }
      return child
    }
    await run(h)
    expect(h.released).toEqual([PID])
  })

  it('does not release a pid it never claimed', async () => {
    const h = claudeRun({ resolveBinary: () => ({ ok: false, binary: 'claude', detail: 'not_found' }) })
    await run(h)
    expect(h.released).toEqual([])
  })
})

describe('the bounded budget', () => {
  it('signals the child and reports a timeout', async () => {
    const h = harness({}, { neverExits: true })
    // The child dies on SIGTERM, which is the ordinary case.
    h.deps.terminate = (_c, signal) => {
      h.signals.push(signal)
      if (signal === 'SIGTERM') h.fake.finish()
    }
    const result = await run(h, { timeoutMs: 20 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('timeout')
    expect(h.signals[0]).toBe('SIGTERM')
  })

  it('warns about a possible orphan after a timeout', async () => {
    // The prompt was written, so a thread may exist on the user's Mac whose id we
    // never saw. Harmless but findable-only if we say so.
    const h = harness({}, { neverExits: true })
    h.deps.terminate = (_c, signal) => { h.signals.push(signal); if (signal === 'SIGTERM') h.fake.finish() }
    const result = await run(h, { timeoutMs: 20 })
    expect(forkOrphanPossible(result)).toBe(true)
  })

  it('escalates to SIGKILL and settles even against an unkillable child', async () => {
    // Blocking forever would wedge the caller and any COS Control drain behind it.
    vi.useFakeTimers()
    try {
      const h = harness({}, { neverExits: true })
      const pending = run(h, { timeoutMs: 20 })
      await vi.advanceTimersByTimeAsync(20 + 2_000 + 2_000 + 10)
      const result = await pending
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('timeout')
      expect(result.detail).toBe('unreaped')
      expect(h.signals).toEqual(['SIGTERM', 'SIGKILL'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a timeout beyond the reservation lifecycle', async () => {
    const h = claudeRun()
    const result = await run(h, { timeoutMs: 31 * 60_000 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid_timeout')
    expect(h.spawns).toHaveLength(0)
  })

  it('refuses a non-positive timeout rather than spawning with no budget', async () => {
    const h = claudeRun()
    const result = await run(h, { timeoutMs: 0 })
    expect(result.ok).toBe(false)
    expect(h.spawns).toHaveLength(0)
  })
})

describe('binary resolution', () => {
  it('refuses without spawning when no binary can be resolved', async () => {
    const h = claudeRun({ resolveBinary: () => ({ ok: false, binary: 'codex', detail: 'not_found' }) })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('binary_not_found')
    expect(result.detail).toBe('codex:not_found')
    expect(h.spawns).toHaveLength(0)
  })

  it('refuses a resolver that hands back a bare name', async () => {
    // A bare name is a silent PATH lookup, and a launchd-spawned server has no
    // login PATH. There is no fallback to the other provider and no bare-name spawn.
    const h = claudeRun({ resolveBinary: () => ({ ok: true, path: 'claude', source: 'path' }) })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('binary_not_found')
    expect(h.spawns).toHaveLength(0)
  })

  it('refuses when the resolver throws', async () => {
    const h = claudeRun({ resolveBinary: () => { throw new Error('homedir failed') } })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('binary_not_found')
  })
})

describe('every unknown resolves to a refusal', () => {
  const cases: [string, Partial<Parameters<typeof forkThread>[0]>, string][] = [
    ['an unsupported provider', { provider: 'cursor' }, 'invalid_provider'],
    ['a truncated thread id', { nativeThreadId: '6d12ff82' }, 'invalid_thread_id'],
    ['a path-shaped thread id', { nativeThreadId: '../../etc/passwd' }, 'invalid_thread_id'],
    ['a non-string thread id', { nativeThreadId: 42 }, 'invalid_thread_id'],
    ['an omitted policy', { policy: undefined }, 'unsupported_policy'],
    ['an agent policy this build does not gate', { policy: 'agent' }, 'unsupported_policy'],
    ['an empty prompt', { prompt: '' }, 'invalid_prompt'],
    ['a non-string prompt', { prompt: { text: 'hi' } }, 'invalid_prompt'],
    ['a relative cwd', { cwd: 'server/lib' }, 'invalid_cwd'],
    ['a cwd carrying a NUL byte', { cwd: '/tmp/evil\0/etc' }, 'invalid_cwd'],
  ]

  for (const [label, over, reason] of cases) {
    it(`refuses ${label} without spawning`, async () => {
      const h = claudeRun()
      const result = await run(h, over)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe(reason)
      expect(h.spawns).toHaveLength(0)
      expect(forkOrphanPossible(result)).toBe(false)
    })
  }

  it('refuses a prompt beyond the ceiling', async () => {
    const h = claudeRun()
    const result = await run(h, { prompt: 'x'.repeat(200_001) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toBe('too_long')
    expect(h.spawns).toHaveLength(0)
  })

  it('refuses a missing dependency instead of defaulting it', async () => {
    // A default is how a fail-open ships: an omitted ledger that silently no-ops
    // leaves our own child looking foreign forever.
    const h = claudeRun()
    delete (h.deps as any).recordSpawn
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('fork_internal_error')
    expect(result.detail).toBe('dep_missing:recordSpawn')
    expect(h.spawns).toHaveLength(0)
  })

  it('resolves rather than rejects when the clock throws', async () => {
    const h = claudeRun({ now: () => { throw new Error('no clock') } })
    await expect(run(h)).resolves.toMatchObject({ ok: false, reason: 'fork_internal_error' })
  })

  it('resolves rather than rejects when spawn throws', async () => {
    const h = claudeRun({ spawn: () => { throw new Error('ENOENT') } })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('spawn_failed')
    // No process exists, so no thread can have been created.
    expect(forkOrphanPossible(result)).toBe(false)
  })

  it('refuses a child with no usable pid', async () => {
    // Node leaves `pid` undefined when the spawn itself failed. A process we cannot
    // record, release or kill must not be run blind.
    const h = harness({}, { pid: undefined, stdout: claudeStdout(CLAUDE_FORK) })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('spawn_failed')
    expect(result.detail).toBe('no_pid')
  })

  it('refuses when the child has no stdin to send the prompt on', async () => {
    const h = harness({}, { noStdin: true, stdout: claudeStdout(CLAUDE_FORK) })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('child_stdio_unavailable')
    expect(forkOrphanPossible(result)).toBe(false)
  })

  it('refuses when the child has no stdout to prove the fork on', async () => {
    // Without stdout there is no id, so the property that makes fork safe is
    // unprovable. Refused before the prompt rather than run blind.
    const h = harness({}, { noStdout: true })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('child_stdio_unavailable')
    expect(result.detail).toBe('stdout_missing')
    expect(h.fake.written()).toBe('')
  })

  it('stays orphan-possible when the stdin write throws', async () => {
    // A synchronous throw means the pipe rejected the write, not that no byte was
    // queued. Fail closed.
    const h = harness({}, { writeThrows: true })
    const result = await run(h)
    expect(result.ok).toBe(false)
    expect(forkOrphanPossible(result)).toBe(true)
  })

  it('reports a child that errors after spawn as a spawn failure', async () => {
    const h = harness({}, { emitError: true })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('spawn_failed')
    expect(result.detail).toBe('child_error')
  })
})

describe('nothing the provider said travels in the result', () => {
  it('classifies stderr instead of carrying it', async () => {
    // Shaped like a real claude failure, and deliberately loaded with both things
    // that must not travel: the user's prompt echoed back, and a transcript path.
    const leak = `No conversation found with session ID ${CLAUDE_SOURCE}`
      + ` (prompt was: ${PROMPT}) at /Users/ukaoma/.claude/projects/x/${CLAUDE_SOURCE}.jsonl`
    const h = harness({}, { stderr: leak, exitCode: 1 })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(PROMPT)
    expect(serialized).not.toContain('.jsonl')
    expect(serialized).not.toContain('/')
    expect(result.stderrClass).toBe('thread_not_found')
  })

  it('classifies an auth failure without echoing the message', async () => {
    const h = harness({}, { stderr: 'Error: not logged in. Run `claude login`.', exitCode: 1 })
    const result = await run(h)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('provider_exit_nonzero')
    expect(result.stderrClass).toBe('auth')
    expect(JSON.stringify(result)).not.toContain('logged in')
  })

  it('keeps no transcript text from stdout', async () => {
    const secret = 'the quarterly numbers are confidential'
    const h = harness({}, {
      stdout: [
        `${JSON.stringify({ type: 'assistant', session_id: CLAUDE_FORK, message: { content: [{ type: 'text', text: secret }] } })}\n`,
      ],
    })
    const result = await run(h)
    expect(JSON.stringify(result)).not.toContain(secret)
  })
})

describe('forkOrphanPossible is total', () => {
  it('is false for a success, which names its thread', async () => {
    const h = claudeRun()
    expect(forkOrphanPossible(await run(h))).toBe(false)
  })

  it('treats an unrecognised fork state as possibly-orphaned', () => {
    // Written as "possible unless proven otherwise", so a state added later
    // defaults to warning the user rather than staying silent.
    const invented = { ok: false, forkState: 'something_new' } as unknown as ForkResult
    expect(forkOrphanPossible(invented)).toBe(true)
  })
})
