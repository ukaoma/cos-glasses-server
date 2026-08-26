// Behavioral tests for the attached execution path.
//
// GROUND RULES, because this module's whole job is refusing when it is not
// certain and a test suite can quietly delete that property:
//
//  * No source-shape assertions. Nothing here reads the module's text.
//  * Every assertion is an OUTCOME a caller depends on — the ledger a detector
//    will read, the bytes a provider receives, the argv a process is launched
//    with — not an intermediate the implementation happens to compute.
//  * The spawn ledger is the REAL `CosSpawnLedger`, not a spy. A spy proves
//    `recordSpawn` was called; the real ledger proves the detector will see the
//    right thing, which is the property that matters, and it enforces its own
//    validation (a stale or malformed start is REJECTED, so a test cannot pass
//    by recording garbage).
//  * The self-ownership assertion goes through `isSelfOwned` — the real
//    predicate the occupancy detector uses — so recording a start time that is
//    merely present but wrong fails here instead of in the field.
//  * No real provider CLI is ever spawned. Every child is a fake.
//
// FIXTURE REALISM. Ids are the real ones observed on this machine on
// 2026-08-15 (`a4b2b4dd-…` was a live desktop Claude session, `019fc80a-…`
// names a real Codex writer lock). Binary-resolution fixtures put the
// executable under a DOT directory (`<tmp>/.local/bin/claude`), mirroring
// `~/.local/bin` and `~/.codex/bin` — a bare `mkdtemp` root cannot contain a
// dot component, and that exact gap has already shipped a bug in this repo.

import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BANNED_PERMISSION_ARGS,
  findBannedPermissionArg,
  buildClaudeAttachedArgs,
  buildCodexAttachedArgs,
  buildCursorAttachedArgs,
  DEFAULT_ATTACHED_TIMEOUT_MS,
  KILL_GRACE_MS,
  FORCE_SETTLE_MS,
  MAX_ATTACHED_TIMEOUT_MS,
  MAX_PROMPT_CHARS,
  attachedDeliveryAmbiguous,
  buildAttachedEnv,
  classifyStderr,
  deliverAttachedTurn,
  extractNativeIdsFromLine,
  isKnownStaleShimPath,
  providerBinarySpec,
  resolveBinaryFromSpec,
  resolveProviderBinary,
  type AttachedChildProcess,
  type AttachedSpawnRequest,
  type AttachedTurnDeps,
  type AttachedTurnResult,
  type BinaryResolution,
} from './attached-provider-adapter'
import { CosSpawnLedger } from './agent-session-ownership-store'
import { isSelfOwned } from './thread-occupancy'

// Real values, observed on this machine 2026-08-15.
const TARGET = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
const FORKED = '019fc80a-cc79-7921-8541-298e71695afd'
const CWD = '/Users/ukaoma/Documents/GitHub/cos-glasses-server'
const PID = 98602
const CLAUDE_BIN = '/opt/homebrew/bin/claude'
const PROMPT = 'summarise where we left off'

const NOW = Date.UTC(2026, 7, 16, 2, 3, 5)
/**
 * 2000ms before `now`, which is DELIBERATELY outside `PROC_START_TOLERANCE_MS`
 * (1500). Recording `Date.now()` instead of the measured kernel start would
 * still land inside the ledger's acceptance window, so only a gap wider than
 * the tolerance turns that substitution into a failing `isSelfOwned`.
 */
const MEASURED_START = NOW - 2_000

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeStream extends EventEmitter {}

class FakeStdin extends EventEmitter {
  written: string[] = []
  ended = false
  throwOnWrite = false

  write(chunk: string): boolean {
    if (this.throwOnWrite) throw new Error('EPIPE')
    this.written.push(chunk)
    return true
  }

  end(): void {
    this.ended = true
  }
}

class FakeChild extends EventEmitter {
  pid: number | undefined = PID
  stdin: FakeStdin | null = new FakeStdin()
  stdout: FakeStream | null = new FakeStream()
  stderr: FakeStream | null = new FakeStream()

  emitStdout(text: string): void {
    this.stdout?.emit('data', text)
  }

  emitStderr(text: string): void {
    this.stderr?.emit('data', text)
  }

  close(code: number | null): void {
    this.emit('exit', code)
    this.emit('close', code)
  }
}

/** A Claude stream-json line: the session id is always top-level. */
function claudeLine(sessionId: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type: 'assistant', session_id: sessionId, ...extra })}\n`
}

interface HarnessOptions {
  /** Runs as a microtask after spawn returns, i.e. once listeners are wired. */
  script?: (child: FakeChild, ctx: HarnessContext) => void
  resolveBinary?: (provider: 'claude' | 'codex' | 'cursor') => BinaryResolution
  processStartMs?: (pid: number) => number | null
  preflight?: () => any
  spawn?: (request: AttachedSpawnRequest) => AttachedChildProcess
  mutateChild?: (child: FakeChild) => void
}

interface HarnessContext {
  ledger: CosSpawnLedger
  /** Ledger contents captured from a microtask scheduled DURING the spawn call. */
  ledgerDuringSpawn: Map<number, number> | null
  calls: string[]
  spawns: AttachedSpawnRequest[]
  children: FakeChild[]
  terminations: Array<{ signal: string; pid: number | undefined }>
  releases: number[]
  deps: AttachedTurnDeps
}

function harness(options: HarnessOptions = {}): HarnessContext {
  const ledger = new CosSpawnLedger({ now: () => NOW })
  const ctx: HarnessContext = {
    ledger,
    ledgerDuringSpawn: null,
    calls: [],
    spawns: [],
    children: [],
    terminations: [],
    releases: [],
    deps: null as unknown as AttachedTurnDeps,
  }

  ctx.deps = {
    now: () => NOW,
    preflight: () => {
      ctx.calls.push('preflight')
      return options.preflight ? options.preflight() : { attachable: true, reason: null }
    },
    resolveBinary: (provider) => {
      ctx.calls.push('resolveBinary')
      return options.resolveBinary
        ? options.resolveBinary(provider)
        : { ok: true, path: CLAUDE_BIN, source: 'absolute' }
    },
    spawn: (request) => {
      ctx.calls.push('spawn')
      ctx.spawns.push(request)
      if (options.spawn) return options.spawn(request)
      const child = new FakeChild()
      options.mutateChild?.(child)
      ctx.children.push(child)
      // Scheduled from INSIDE spawn. If any `await` were introduced between the
      // spawn and the ownership record, this microtask would run first and see
      // an empty ledger — which is exactly the self-recursion bug.
      queueMicrotask(() => {
        ctx.ledgerDuringSpawn = new Map(ctx.ledger.snapshot())
        options.script?.(child, ctx)
      })
      return child as unknown as AttachedChildProcess
    },
    processStartMs: (pid) => {
      ctx.calls.push('processStartMs')
      return options.processStartMs ? options.processStartMs(pid) : MEASURED_START
    },
    recordSpawn: (pid, startMs) => {
      ctx.calls.push('recordSpawn')
      return ledger.record(pid, startMs)
    },
    releaseSpawn: (pid) => {
      ctx.calls.push('releaseSpawn')
      ctx.releases.push(pid)
      return ledger.release(pid)
    },
    terminate: (child, signal) => {
      ctx.terminations.push({ signal, pid: child.pid })
    },
  }

  return ctx
}

function deliver(
  ctx: HarnessContext,
  over: Record<string, unknown> = {},
): Promise<AttachedTurnResult> {
  return deliverAttachedTurn({
    provider: 'claude',
    nativeThreadId: TARGET,
    prompt: PROMPT,
    cwd: CWD,
    policy: 'read_only',
    deps: ctx.deps,
    ...over,
  } as any)
}

/** Success script: echo the target id back, then exit 0. */
function succeedWith(sessionId: string, exitCode = 0) {
  return (child: FakeChild) => {
    child.emitStdout(claudeLine(sessionId))
    child.close(exitCode)
  }
}

function expectFailure(result: AttachedTurnResult) {
  if (result.ok) throw new Error(`expected a refusal, got ok:true (${JSON.stringify(result)})`)
  return result
}

// ---------------------------------------------------------------------------

describe('deliverAttachedTurn — the delivered path', () => {
  it('reports success only when the provider echoes the exact target id and exits 0', async () => {
    const ctx = harness({ script: succeedWith(TARGET) })
    const result = await deliver(ctx)

    expect(result.ok).toBe(true)
    expect(result).toMatchObject({
      provider: 'claude',
      nativeThreadId: TARGET,
      returnedNativeId: TARGET,
      delivery: 'delivered',
      exitCode: 0,
    })
    expect(attachedDeliveryAmbiguous(result)).toBe(false)
  })

  it('sends the prompt bytes and nothing else, on stdin', async () => {
    const ctx = harness({ script: succeedWith(TARGET) })
    await deliver(ctx)

    const child = ctx.children[0]!
    // Byte-for-byte. This is the assertion that "bypasses COS history
    // formatting and system-prompt construction" is actually true on the wire:
    // any preamble, capability block, or history prefix breaks it.
    expect(child.stdin!.written.join('')).toBe(PROMPT)
    expect(child.stdin!.ended).toBe(true)
  })

  it('keeps the prompt out of argv, where ps would expose it', async () => {
    const ctx = harness({ script: succeedWith(TARGET) })
    await deliver(ctx)

    const request = ctx.spawns[0]!
    expect(request.args.some(arg => arg.includes(PROMPT))).toBe(false)
    expect(request.args).toContain('--resume')
    expect(request.args).toContain(TARGET)
    expect(request.cwd).toBe(CWD)
    expect(request.binaryPath).toBe(CLAUDE_BIN)
  })

  it('launches Codex through exec resume with the id and prompt positionals last', async () => {
    const ctx = harness({
      resolveBinary: () => ({ ok: true, path: '/Applications/ChatGPT.app/Contents/Resources/codex', source: 'absolute' }),
      script: (child) => {
        child.emitStdout(`${JSON.stringify({ type: 'thread.started', thread_id: TARGET })}\n`)
        child.close(0)
      },
    })
    const result = await deliver(ctx, { provider: 'codex' })

    expect(result.ok).toBe(true)
    const args = ctx.spawns[0]!.args
    // Verified against codex-cli 0.148.0-alpha.9: `exec` options precede the
    // `resume` subcommand, and nothing may follow the positionals.
    expect(args.indexOf('--sandbox')).toBeLessThan(args.indexOf('resume'))
    expect(args.indexOf('--cd')).toBeLessThan(args.indexOf('resume'))
    expect(args.indexOf('--json')).toBeGreaterThan(args.indexOf('resume'))
    expect(args.slice(-2)).toEqual([TARGET, '-'])
    expect(args).toContain('read-only')
  })

  it.each(['claude', 'codex'] as const)(
    'never passes a permission-bypass flag to %s',
    async (provider) => {
      const ctx = harness({
        resolveBinary: () => ({ ok: true, path: CLAUDE_BIN, source: 'absolute' }),
        script: succeedWith(TARGET),
      })
      await deliver(ctx, { provider })

      const args = ctx.spawns[0]!.args
      for (const banned of BANNED_PERMISSION_ARGS) {
        expect(args).not.toContain(banned)
      }
    },
  )

  it('strips COS_API_TOKEN and CLAUDECODE from the child environment', async () => {
    vi.stubEnv('COS_API_TOKEN', 'cos-secret-value')
    vi.stubEnv('CLAUDECODE', '1')
    try {
      const ctx = harness({ script: succeedWith(TARGET) })
      const result = await deliver(ctx)

      const env = ctx.spawns[0]!.env
      expect(env.COS_API_TOKEN).toBeUndefined()
      expect(env.CLAUDECODE).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain('cos-secret-value')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('keeps provider credentials, which are how the CLI authenticates', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-provider')
    try {
      expect(buildAttachedEnv().ANTHROPIC_API_KEY).toBe('sk-provider')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('self-recursion ordering (plan 4.4)', () => {
  it('records the child before any queued microtask can observe the ledger', async () => {
    const ctx = harness({ script: succeedWith(TARGET) })
    await deliver(ctx)

    // Captured from a microtask scheduled inside spawn(). An `await` between
    // the spawn and the record would let this run first and see nothing, after
    // which the next occupancy scan reads our own child as a foreign desktop
    // owner and the thread refuses forever.
    expect(ctx.ledgerDuringSpawn).not.toBeNull()
    expect(ctx.ledgerDuringSpawn!.has(PID)).toBe(true)
  })

  it('records the MEASURED kernel start, so the detector recognises the child as ours', async () => {
    const ctx = harness({ script: succeedWith(TARGET) })
    await deliver(ctx)

    // The real predicate the occupancy detector uses. Recording `Date.now()`
    // instead of `processStartMs(pid)` stores a value 2000ms off the kernel
    // reading — inside the ledger's acceptance window but OUTSIDE
    // PROC_START_TOLERANCE_MS, so self-identification silently stops working.
    expect(isSelfOwned(PID, MEASURED_START, ctx.ledgerDuringSpawn!)).toBe(true)
  })

  it('re-checks occupancy before spawning, and records after', async () => {
    const ctx = harness({ script: succeedWith(TARGET) })
    await deliver(ctx)

    const order = ctx.calls.filter(c => c === 'preflight' || c === 'spawn' || c === 'recordSpawn')
    expect(order).toEqual(['preflight', 'spawn', 'recordSpawn'])
  })

  it('refuses without spawning when a live owner appeared between attach and start', async () => {
    const ctx = harness({ preflight: () => ({ attachable: false, reason: 'live_desktop_process' }) })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('native_owner_appeared')
    expect(result.delivery).toBe('not_attempted')
    expect(result.detail).toBe('live_desktop_process')
    expect(ctx.calls).not.toContain('spawn')
  })

  it('refuses when the preflight throws', async () => {
    const ctx = harness({ preflight: () => { throw new Error('probe blew up') } })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('preflight_failed')
    expect(ctx.calls).not.toContain('spawn')
  })

  it.each([
    // A promise is malformed WIRING, not an occupied thread — reporting it as
    // "a live owner appeared" would send a diagnosis chasing the wrong thing.
    ['a thenable', () => Promise.resolve({ attachable: true, reason: null }), 'preflight_failed'],
    // The dangerous shape: it says attachable AND it is a promise. Without the
    // thenable check this spawns, because the property is right there.
    ['an attachable-shaped thenable', () => ({ attachable: true, reason: null, then: (r: any) => r({ attachable: true }) }), 'preflight_failed'],
    ['null', () => null, 'preflight_failed'],
    ['a bare truthy value', () => 'yes', 'preflight_failed'],
    ['a truthy-but-not-true attachable', () => ({ attachable: 1, reason: null }), 'native_owner_appeared'],
  ])('refuses when the preflight returns %s', async (_label, preflight, reason) => {
    const ctx = harness({ preflight: preflight as () => any })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe(reason)
    expect(result.delivery).toBe('not_attempted')
    expect(ctx.calls).not.toContain('spawn')
  })

  it('refuses a preflight reason that is not a bounded token, rather than echoing it', async () => {
    const ctx = harness({
      preflight: () => ({ attachable: false, reason: 'Desktop thread /Users/miles/private is open' }),
    })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('native_owner_appeared')
    // A free-text reason could carry a path or transcript fragment into a log.
    expect(result.detail).toBe('unspecified')
  })
})

describe('the returned id must be the target', () => {
  it('fails when the provider forked to a different id', async () => {
    const ctx = harness({ script: succeedWith(FORKED) })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('native_id_mismatch')
    expect(result.returnedNativeId).toBe(FORKED)
    expect(result.detail).toBe('different_id')
    // The prompt was written, so we cannot claim it landed nowhere.
    expect(attachedDeliveryAmbiguous(result)).toBe(true)
  })

  it('fails when two ids appear, even though one of them is the target', async () => {
    // A fork can emit the old id alongside the new one. Matching "any observed
    // id" would call this a success and project a Message into a thread that
    // never received the turn.
    const ctx = harness({
      script: (child) => {
        child.emitStdout(claudeLine(TARGET))
        child.emitStdout(claudeLine(FORKED))
        child.close(0)
      },
    })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('native_id_mismatch')
    expect(result.detail).toBe('multiple_ids')
    expect(result.returnedNativeId).toBeNull()
  })

  it('fails when the provider exits 0 without ever naming a thread', async () => {
    const ctx = harness({
      script: (child) => {
        child.emitStdout(`${JSON.stringify({ type: 'assistant', message: { content: 'done' } })}\n`)
        child.close(0)
      },
    })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('no_native_id_returned')
    expect(attachedDeliveryAmbiguous(result)).toBe(true)
  })

  it('does not accept a target id that only appears in the assistant text', async () => {
    // A model can print a UUID. Only known id FIELDS count.
    const ctx = harness({
      script: (child) => {
        child.emitStdout(`${JSON.stringify({ type: 'assistant', text: `resuming ${TARGET} now` })}\n`)
        child.close(0)
      },
    })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('no_native_id_returned')
  })

  it('fails on a non-zero exit even when the id matched', async () => {
    const ctx = harness({ script: succeedWith(TARGET, 3) })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('provider_exit_nonzero')
    expect(result.exitCode).toBe(3)
    expect(attachedDeliveryAmbiguous(result)).toBe(true)
  })

  it('reads an id split across two stdout chunks', async () => {
    const line = claudeLine(TARGET)
    const ctx = harness({
      script: (child) => {
        child.emitStdout(line.slice(0, 20))
        child.emitStdout(line.slice(20))
        child.close(0)
      },
    })
    expect((await deliver(ctx)).ok).toBe(true)
  })

  it('reads an id from a final line that never got a newline', async () => {
    const ctx = harness({
      script: (child) => {
        child.emitStdout(claudeLine(TARGET).trimEnd())
        child.close(0)
      },
    })
    expect((await deliver(ctx)).ok).toBe(true)
  })
})

describe('provider start failures', () => {
  it('refuses when the binary cannot be resolved, and does not try another provider', async () => {
    const ctx = harness({ resolveBinary: () => ({ ok: false, binary: 'codex', detail: 'not_found' }) })
    const result = expectFailure(await deliver(ctx, { provider: 'codex' }))

    expect(result.reason).toBe('binary_not_found')
    expect(result.delivery).toBe('not_attempted')
    // Names WHICH binary was missing.
    expect(result.detail).toBe('codex:not_found')
    // No fallback to another provider, no bare-name retry (plan 4.2).
    expect(ctx.spawns).toHaveLength(0)
  })

  it('refuses rather than falling through when an env override is unusable', async () => {
    const ctx = harness({ resolveBinary: () => ({ ok: false, binary: 'claude', detail: 'env_override_unusable' }) })
    const result = expectFailure(await deliver(ctx))

    expect(result.detail).toBe('claude:env_override_unusable')
    expect(ctx.spawns).toHaveLength(0)
  })

  it('refuses a resolver that returns a relative path', async () => {
    const ctx = harness({ resolveBinary: () => ({ ok: true, path: 'claude', source: 'path' } as BinaryResolution) })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('binary_not_found')
    expect(result.detail).toBe('claude:not_absolute')
    expect(ctx.spawns).toHaveLength(0)
  })

  it('treats a throwing spawn (ENOENT) as never attempted', async () => {
    const ctx = harness({ spawn: () => { throw new Error('ENOENT') } })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('spawn_failed')
    expect(result.delivery).toBe('not_attempted')
    expect(attachedDeliveryAmbiguous(result)).toBe(false)
  })

  it('kills the child and writes nothing when the pid is unavailable', async () => {
    const ctx = harness({
      mutateChild: (child) => { child.pid = undefined },
      script: succeedWith(TARGET),
    })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('spawn_failed')
    expect(result.detail).toBe('no_pid')
    // A process we cannot name is one we cannot record, release, or kill on
    // timeout. Nothing may be sent to it.
    expect(ctx.children[0]!.stdin!.written).toEqual([])
    expect(ctx.terminations.map(t => t.signal)).toContain('SIGKILL')
    expect(attachedDeliveryAmbiguous(result)).toBe(false)
  })

  it('kills the child and writes nothing when the process start cannot be measured', async () => {
    const ctx = harness({ processStartMs: () => null, script: succeedWith(TARGET) })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('ownership_record_failed')
    expect(result.detail).toBe('start_unavailable')
    // An unrecorded child is a live process the detector will read as a foreign
    // owner of this exact thread — permanently, if it outlives us.
    expect(result.delivery).toBe('aborted')
    expect(ctx.children[0]!.stdin!.written).toEqual([])
    expect(ctx.terminations.map(t => t.signal)).toContain('SIGKILL')
  })

  it('kills the child when the ledger refuses the claim', async () => {
    // A start time an hour old describes a process that was already running —
    // the shape of the user's desktop app — so the real ledger rejects it.
    const ctx = harness({ processStartMs: () => NOW - 3_600_000, script: succeedWith(TARGET) })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('ownership_record_failed')
    expect(result.detail).toBe('rejected_start_not_recent')
    expect(result.delivery).toBe('aborted')
    expect(ctx.children[0]!.stdin!.written).toEqual([])
  })

  it('aborts when the child has no stdin to deliver through', async () => {
    const ctx = harness({ mutateChild: (child) => { child.stdin = null } })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('child_stdio_unavailable')
    expect(result.detail).toBe('stdin_missing')
    expect(result.delivery).toBe('aborted')
    expect(ctx.terminations.map(t => t.signal)).toContain('SIGKILL')
  })

  it('aborts when the child has no stdout, because the id could never be verified', async () => {
    const ctx = harness({ mutateChild: (child) => { child.stdout = null } })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('child_stdio_unavailable')
    expect(result.detail).toBe('stdout_missing')
    expect(result.delivery).toBe('aborted')
    expect(ctx.children[0]!.stdin!.written).toEqual([])
  })

  it('stays ambiguous when the write throws after the prompt was handed over', async () => {
    const ctx = harness({ mutateChild: (child) => { child.stdin!.throwOnWrite = true } })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('child_stdio_unavailable')
    expect(result.detail).toBe('write_failed')
    // A rejected write does not prove no byte was queued.
    expect(attachedDeliveryAmbiguous(result)).toBe(true)
  })

  it('stays ambiguous when the child errors after delivery', async () => {
    const ctx = harness({
      script: (child) => { child.emit('error', new Error('broken pipe')) },
    })
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('spawn_failed')
    expect(result.detail).toBe('child_error')
    expect(attachedDeliveryAmbiguous(result)).toBe(true)
  })
})

describe('bounded budget', () => {
  afterEach(() => { vi.useRealTimers() })

  it('escalates SIGTERM then SIGKILL and reports a distinct timeout outcome', async () => {
    vi.useFakeTimers()
    const ctx = harness({ script: () => { /* child never responds */ } })
    const pending = deliver(ctx, { timeoutMs: 1_000 })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(ctx.terminations.map(t => t.signal)).toEqual(['SIGTERM'])

    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS)
    expect(ctx.terminations.map(t => t.signal)).toEqual(['SIGTERM', 'SIGKILL'])

    await vi.advanceTimersByTimeAsync(FORCE_SETTLE_MS)
    const result = expectFailure(await pending)

    expect(result.reason).toBe('timeout')
    // The prompt was delivered before the hang; a caller must fence, not retry.
    expect(attachedDeliveryAmbiguous(result)).toBe(true)
    // A child that survives SIGKILL must not wedge the coordinator forever.
    expect(ctx.ledger.snapshot().size).toBe(0)
  })

  it('settles on a late close during the kill grace rather than waiting out the force timer', async () => {
    vi.useFakeTimers()
    const ctx = harness({ script: () => {} })
    const pending = deliver(ctx, { timeoutMs: 1_000 })

    await vi.advanceTimersByTimeAsync(1_000)
    ctx.children[0]!.close(143)
    const result = expectFailure(await pending)

    expect(result.reason).toBe('timeout')
    expect(ctx.ledger.snapshot().size).toBe(0)
  })

  it.each([0, -1, Number.NaN, MAX_ATTACHED_TIMEOUT_MS + 1, '60000'])(
    'refuses an unusable timeout (%s) instead of substituting a default',
    async (timeoutMs) => {
      const ctx = harness({ script: succeedWith(TARGET) })
      const result = expectFailure(await deliver(ctx, { timeoutMs }))

      expect(result.reason).toBe('invalid_timeout')
      expect(ctx.spawns).toHaveLength(0)
    },
  )

  it('uses the default budget when none is supplied', async () => {
    vi.useFakeTimers()
    const ctx = harness({ script: () => {} })
    const pending = deliver(ctx)

    await vi.advanceTimersByTimeAsync(DEFAULT_ATTACHED_TIMEOUT_MS - 1)
    expect(ctx.terminations).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1 + KILL_GRACE_MS + FORCE_SETTLE_MS)
    expect(expectFailure(await pending).reason).toBe('timeout')
  })
})

describe('request validation — every refusal happens before a process exists', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['an unknown provider', { provider: 'gemini' }, 'invalid_provider'],
    ['a missing provider', { provider: undefined }, 'invalid_provider'],
    // The 8-character display form is exactly what `ClaudePeer.id` holds, and
    // it is what sailed through an earlier occupancy detector.
    ['the truncated 8-char display id', { nativeThreadId: TARGET.slice(0, 8) }, 'invalid_thread_id'],
    ['a path-traversal id', { nativeThreadId: '../../etc/passwd' }, 'invalid_thread_id'],
    ['an uppercase uuid', { nativeThreadId: TARGET.toUpperCase() }, 'invalid_thread_id'],
    ['a non-string id', { nativeThreadId: 42 }, 'invalid_thread_id'],
    ['an empty prompt', { prompt: '' }, 'invalid_prompt'],
    ['a non-string prompt', { prompt: { text: 'hi' } }, 'invalid_prompt'],
    ['an oversized prompt', { prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }, 'invalid_prompt'],
    ['a relative cwd', { cwd: 'relative/workspace' }, 'invalid_cwd'],
    ['an empty cwd', { cwd: '' }, 'invalid_cwd'],
    ['a NUL-bearing cwd', { cwd: '/tmp/a\0b' }, 'invalid_cwd'],
    ['a missing policy', { policy: undefined }, 'unsupported_policy'],
    ['agent mode, which is not certified', { policy: 'agent' }, 'unsupported_policy'],
    ['a bypass policy', { policy: 'bypassPermissions' }, 'unsupported_policy'],
  ]

  it.each(cases)('refuses %s', async (_label, over, reason) => {
    const ctx = harness({ script: succeedWith(TARGET) })
    const result = expectFailure(await deliver(ctx, over))

    expect(result.reason).toBe(reason)
    expect(result.delivery).toBe('not_attempted')
    expect(ctx.spawns).toHaveLength(0)
    expect(ctx.ledger.snapshot().size).toBe(0)
  })

  it.each(['now', 'preflight', 'resolveBinary', 'spawn', 'processStartMs', 'recordSpawn', 'releaseSpawn', 'terminate'])(
    'refuses when the %s dependency is missing rather than defaulting to one',
    async (missing) => {
      const ctx = harness({ script: succeedWith(TARGET) })
      const deps = { ...ctx.deps } as any
      delete deps[missing]
      const result = expectFailure(await deliver({ ...ctx, deps } as HarnessContext))

      expect(result.reason).toBe('adapter_internal_error')
      expect(result.detail).toBe(`dep_missing:${missing}`)
      expect(ctx.spawns).toHaveLength(0)
    },
  )

  it('refuses a missing deps object without throwing', async () => {
    const result = expectFailure(await deliverAttachedTurn({
      provider: 'claude',
      nativeThreadId: TARGET,
      prompt: PROMPT,
      cwd: CWD,
      policy: 'read_only',
      deps: undefined as any,
    }))
    expect(result.reason).toBe('adapter_internal_error')
    expect(result.detail).toBe('deps_missing')
  })
})

describe('the ownership ledger is released on every terminal path', () => {
  // Enumerated as one table so a newly added failure path cannot skip the
  // check. A leaked entry outlives the process and lets a RECYCLED pid inherit
  // our self-ownership claim, which is the single input that can turn a live
  // foreign owner into `attachable`.
  const paths: Array<[string, HarnessOptions, Record<string, unknown>]> = [
    ['success', { script: succeedWith(TARGET) }, {}],
    ['a different returned id', { script: succeedWith(FORKED) }, {}],
    ['a non-zero exit', { script: succeedWith(TARGET, 1) }, {}],
    ['no id at all', { script: (c) => c.close(0) }, {}],
    ['a child error', { script: (c) => c.emit('error', new Error('x')) }, {}],
    ['a failed write', { mutateChild: (c) => { c.stdin!.throwOnWrite = true } }, {}],
    ['missing stdin', { mutateChild: (c) => { c.stdin = null } }, {}],
    ['an unmeasurable process start', { processStartMs: () => null, script: succeedWith(TARGET) }, {}],
    ['a rejected ledger claim', { processStartMs: () => NOW - 3_600_000, script: succeedWith(TARGET) }, {}],
  ]

  it.each(paths)('releases after %s', async (_label, options, over) => {
    const ctx = harness(options)
    await deliver(ctx, over)

    expect(ctx.ledger.snapshot().size).toBe(0)
    expect(ctx.releases).toContain(PID)
  })

  it('still returns a terminal result when the release itself throws', async () => {
    const ctx = harness({ script: succeedWith(TARGET) })
    ctx.deps.releaseSpawn = () => { throw new Error('ledger exploded') }
    const result = await deliver(ctx)

    expect(result.ok).toBe(true)
  })

  it('still returns a terminal result when terminate throws', async () => {
    const ctx = harness({ mutateChild: (c) => { c.stdin = null } })
    ctx.deps.terminate = () => { throw new Error('kill failed') }
    const result = expectFailure(await deliver(ctx))

    expect(result.reason).toBe('child_stdio_unavailable')
    expect(ctx.ledger.snapshot().size).toBe(0)
  })
})

describe('nothing from the conversation leaves this module', () => {
  it('keeps prompt and transcript text out of the result on every outcome', async () => {
    const secretPrompt = 'PROMPT-SECRET-8f21'
    const secretOutput = 'TRANSCRIPT-SECRET-4b90'
    const secretStderr = 'STDERR-SECRET-1c73'

    const ctx = harness({
      script: (child) => {
        child.emitStdout(claudeLine(FORKED, { text: secretOutput }))
        // Shaped like a real provider error, which is precisely the value that
        // is tempting to forward verbatim and can carry the prompt back.
        child.emitStderr(`No conversation found with session ID; input was: ${secretStderr}`)
        child.close(1)
      },
    })
    const result = expectFailure(await deliver(ctx, { prompt: secretPrompt }))

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(secretPrompt)
    expect(serialized).not.toContain(secretOutput)
    expect(serialized).not.toContain(secretStderr)
    // What a caller gets instead: a bounded classification authored here.
    expect(result.stderrClass).toBe('thread_not_found')
  })
})

describe('attachedDeliveryAmbiguous', () => {
  it('treats an unrecognised delivery state as ambiguous', () => {
    // Adding a state later must default to fenced, never to replayable.
    const future = { ok: false, delivery: 'some_future_state' } as unknown as AttachedTurnResult
    expect(attachedDeliveryAmbiguous(future)).toBe(true)
  })

  it.each([
    ['not_attempted', false],
    ['aborted', false],
    ['ambiguous', true],
  ] as const)('maps %s to ambiguous=%s', (delivery, expected) => {
    const result = { ok: false, delivery } as unknown as AttachedTurnResult
    expect(attachedDeliveryAmbiguous(result)).toBe(expected)
  })
})

describe('extractNativeIdsFromLine', () => {
  it('reads a Claude top-level session_id', () => {
    expect(extractNativeIdsFromLine(claudeLine(TARGET))).toEqual([TARGET])
  })

  it('reads a Codex thread_id', () => {
    expect(extractNativeIdsFromLine(JSON.stringify({ type: 'thread.started', thread_id: FORKED })))
      .toEqual([FORKED])
  })

  it('reads a nested thread.id on a lifecycle event', () => {
    expect(extractNativeIdsFromLine(JSON.stringify({ type: 'thread.started', thread: { id: FORKED } })))
      .toEqual([FORKED])
  })

  it('ignores a uuid that only appears in assistant prose', () => {
    expect(extractNativeIdsFromLine(JSON.stringify({ type: 'assistant', text: `see ${TARGET}` })))
      .toEqual([])
  })

  it('ignores a uuid nested inside a message body', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: JSON.stringify({ session_id: FORKED }) }] },
    })
    expect(extractNativeIdsFromLine(line)).toEqual([])
  })

  it('reads a bare `id` only on a thread or session lifecycle event', () => {
    expect(extractNativeIdsFromLine(JSON.stringify({ type: 'session.created', id: TARGET }))).toEqual([TARGET])
    // On an item event, `id` names the item, not the thread.
    expect(extractNativeIdsFromLine(JSON.stringify({ type: 'item.completed', id: TARGET }))).toEqual([])
  })

  it('ignores values that are not full native thread ids', () => {
    expect(extractNativeIdsFromLine(JSON.stringify({ session_id: TARGET.slice(0, 8) }))).toEqual([])
    expect(extractNativeIdsFromLine(JSON.stringify({ session_id: TARGET.toUpperCase() }))).toEqual([])
    expect(extractNativeIdsFromLine(JSON.stringify({ session_id: 12345 }))).toEqual([])
  })

  it.each(['', 'not json', '[1,2,3]', 'null', '{"broken":'])('ignores unparseable line %s', (line) => {
    expect(extractNativeIdsFromLine(line)).toEqual([])
  })

  it('returns both ids when a line carries two, so a fork cannot hide', () => {
    const line = JSON.stringify({ type: 'thread.started', session_id: TARGET, thread_id: FORKED })
    expect(extractNativeIdsFromLine(line).sort()).toEqual([TARGET, FORKED].sort())
  })
})

describe('classifyStderr', () => {
  it.each([
    ['', 'none'],
    ['No conversation found with session ID', 'thread_not_found'],
    ['Invalid API key · Please run /login', 'auth'],
    ['429 Too Many Requests', 'rate_limit'],
    ['EACCES: permission denied', 'permission'],
    ['segmentation fault', 'unclassified'],
  ] as const)('classifies %s', (input, expected) => {
    expect(classifyStderr(input)).toBe(expected)
  })
})

describe('resolveProviderBinary', () => {
  let root: string | null = null

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = null
  })

  function fixture(): { root: string; binDir: string } {
    // A DOT directory, matching `~/.local/bin` and `~/.codex/bin`. A bare
    // mktemp root cannot contain a dot component, and a fixture that cannot
    // express the production value cannot catch the production bug.
    const base = mkdtempSync(join(tmpdir(), 'cos-attached-bin-'))
    const binDir = join(base, '.local', 'bin')
    mkdirSync(binDir, { recursive: true })
    root = base
    return { root: base, binDir }
  }

  function executable(dir: string, name: string): string {
    const path = join(dir, name)
    writeFileSync(path, '#!/bin/sh\nexit 0\n')
    chmodSync(path, 0o755)
    return path
  }

  it('accepts an absolute, executable env override', () => {
    const { binDir } = fixture()
    const path = executable(binDir, 'claude')
    expect(resolveProviderBinary('claude', { COS_ATTACHED_CLAUDE_BIN: path }))
      .toEqual({ ok: true, path, source: 'env' })
  })

  it('refuses — rather than silently falling through — when the env override is unusable', () => {
    const { binDir } = fixture()
    const path = join(binDir, 'claude')
    writeFileSync(path, 'not executable')
    chmodSync(path, 0o644)
    // A real claude exists at /opt/homebrew/bin on this machine, so a
    // fall-through would return `ok:true` and hide the operator's mistake.
    const result = resolveProviderBinary('claude', { COS_ATTACHED_CLAUDE_BIN: path, PATH: '/opt/homebrew/bin' })
    expect(result).toEqual({ ok: false, binary: 'claude', detail: 'env_override_unusable' })
  })

  it('refuses a relative env override', () => {
    expect(resolveProviderBinary('claude', { COS_ATTACHED_CLAUDE_BIN: './claude' }))
      .toEqual({ ok: false, binary: 'claude', detail: 'env_override_unusable' })
  })

  it('refuses a directory that happens to carry the binary name', () => {
    const { binDir } = fixture()
    const dir = join(binDir, 'codex')
    mkdirSync(dir)
    expect(resolveProviderBinary('codex', { COS_ATTACHED_CODEX_BIN: dir }))
      .toEqual({ ok: false, binary: 'codex', detail: 'env_override_unusable' })
  })

  // The PATH-scan and not-found branches are unreachable through
  // `resolveProviderBinary` on any machine that HAS a provider installed —
  // /opt/homebrew/bin/claude and ChatGPT.app's codex both exist here — so they
  // are driven through the real algorithm with a fixture spec. Skipping them
  // would leave the launchd-only failure path untested, which is the one that
  // actually bites (COS Control hit it twice).
  const specFor = (name: string, absolutes: string[] = []) => ({
    name,
    envKeys: ['COS_TEST_BIN'],
    absolutes,
  })

  it('finds a binary through an explicit PATH scan and returns an absolute path', () => {
    const { binDir } = fixture()
    const path = executable(binDir, 'codex')
    expect(resolveBinaryFromSpec(specFor('codex'), { PATH: binDir }))
      .toEqual({ ok: true, path, source: 'path' })
  })

  it('prefers an absolute candidate over anything reachable through PATH', () => {
    const { binDir } = fixture()
    const preferred = executable(binDir, 'real-codex')
    const shimDir = join(binDir, 'shim')
    mkdirSync(shimDir)
    executable(shimDir, 'codex')
    const result = resolveBinaryFromSpec(specFor('codex', [preferred]), { PATH: shimDir })
    expect(result).toEqual({ ok: true, path: preferred, source: 'absolute' })
  })

  it('skips relative PATH entries, which resolve against the server cwd', () => {
    const { root, binDir } = fixture()
    const path = executable(binDir, 'codex')
    const original = process.cwd()
    try {
      // Without the chdir this branch is unreachable: no relative candidate
      // resolves to a real executable from the repo root, so the guard is never
      // exercised and a mutation removing it passes. Vitest forks per file, so
      // the cwd change is contained to this process.
      process.chdir(root)
      expect(resolveBinaryFromSpec(specFor('codex'), { PATH: '.local/bin' }))
        .toEqual({ ok: false, binary: 'codex', detail: 'not_found' })
      expect(resolveBinaryFromSpec(specFor('codex'), { PATH: '.' }))
        .toEqual({ ok: false, binary: 'codex', detail: 'not_found' })
      // Control: the SAME file, reached absolutely, resolves. So the refusals
      // above came from the entry being relative, not from the file missing.
      expect(resolveBinaryFromSpec(specFor('codex'), { PATH: binDir }))
        .toEqual({ ok: true, path, source: 'path' })
    } finally {
      process.chdir(original)
    }
  })

  it('reports not_found with no PATH at all, as under launchd', () => {
    expect(resolveBinaryFromSpec(specFor('codex'), {}))
      .toEqual({ ok: false, binary: 'codex', detail: 'not_found' })
  })

  it('never selects a non-executable file found on PATH', () => {
    const { binDir } = fixture()
    writeFileSync(join(binDir, 'codex'), 'text')
    chmodSync(join(binDir, 'codex'), 0o644)
    expect(resolveBinaryFromSpec(specFor('codex'), { PATH: binDir }))
      .toEqual({ ok: false, binary: 'codex', detail: 'not_found' })
  })

  it('never returns the stale Codex.app shim, from any source', () => {
    // `codex` here resolves to a shim naming /Applications/Codex.app, which no
    // longer exists; the real binary lives inside ChatGPT.app.
    const shim = '/Applications/Codex.app/Contents/Resources/codex'
    expect(isKnownStaleShimPath(shim)).toBe(true)
    expect(isKnownStaleShimPath('/Applications/ChatGPT.app/Contents/Resources/codex')).toBe(false)
    expect(resolveProviderBinary('codex', { COS_ATTACHED_CODEX_BIN: shim }))
      .toEqual({ ok: false, binary: 'codex', detail: 'env_override_unusable' })
    expect(resolveBinaryFromSpec(specFor('codex', [shim]), {}))
      .toEqual({ ok: false, binary: 'codex', detail: 'not_found' })
  })

  it('refuses an excluded path even when the file really exists and is executable', () => {
    // The production exclusion covers /Applications/Codex.app, which no fixture
    // can write to — so today's dangling shim is refused by the existence check
    // and the exclusion itself never runs. A reinstalled Codex.app puts a real
    // executable back on that path, and this is the only test that proves the
    // exclusion, not existence, is what refuses it.
    const { binDir } = fixture()
    const real = executable(binDir, 'codex')
    expect(resolveBinaryFromSpec({ ...specFor('codex', [real]), excludePrefixes: [binDir] }, {}))
      .toEqual({ ok: false, binary: 'codex', detail: 'not_found' })
    expect(resolveBinaryFromSpec({ ...specFor('codex'), excludePrefixes: [binDir] }, { PATH: binDir }))
      .toEqual({ ok: false, binary: 'codex', detail: 'not_found' })
    expect(resolveBinaryFromSpec(
      { ...specFor('codex'), excludePrefixes: [binDir] },
      { COS_TEST_BIN: real },
    )).toEqual({ ok: false, binary: 'codex', detail: 'env_override_unusable' })
    // Same file, no exclusion: proves the refusals above came from the guard.
    expect(resolveBinaryFromSpec(specFor('codex', [real]), {}))
      .toEqual({ ok: true, path: real, source: 'absolute' })
  })

  it('tries ChatGPT.app before anything else for codex, and never lists Codex.app', () => {
    const spec = providerBinarySpec('codex')
    expect(spec).not.toBeNull()
    expect(spec!.absolutes[0]).toBe('/Applications/ChatGPT.app/Contents/Resources/codex')
    expect(spec!.absolutes.some(p => isKnownStaleShimPath(p))).toBe(false)
    // `.some(isKnownStaleShimPath)` passes the index as the second argument;
    // an unusable prefixes argument must still exclude the known shim.
    expect(isKnownStaleShimPath('/Applications/Codex.app/x', 1 as any)).toBe(true)
    expect(spec!.name).toBe('codex')
  })

  it('resolves cursor to agent, never to the Codex fallthrough', () => {
    const spec = providerBinarySpec('cursor')
    expect(spec).not.toBeNull()
    expect(spec!.name).toBe('agent')
    expect(spec!.envKeys).toEqual(['COS_ATTACHED_CURSOR_AGENT_BIN', 'COS_CURSOR_AGENT_BIN'])
    expect(providerBinarySpec('gemini')).toBeNull()
    expect(resolveProviderBinary('gemini')).toEqual({
      ok: false, binary: 'gemini', detail: 'unknown_provider',
    })
  })
})

describe('plan 4.7 is enforced at runtime, not only asserted in a test', () => {
  it('REFUSES the turn and never spawns when the argv carries a banned flag', async () => {
    // The behavioural test the guard was missing. Before the injectable builder
    // existed, no test could make the argv banned, the check was unreachable, and
    // a mutation deleting it passed — which is exactly how BANNED_PERMISSION_ARGS
    // ended up exported, asserted, and enforced nowhere.
    const ctx = harness()
    const result = expectFailure(await deliver(ctx, {
      deps: { ...ctx.deps, buildArgs: () => ['--resume', TARGET, '--dangerously-skip-permissions'] },
    }))
    expect(result.reason).toBe('unsupported_policy')
    expect(result.delivery).toBe('not_attempted')
    expect(ctx.calls).not.toContain('spawn')
    expect(ctx.spawns).toHaveLength(0)
  })

  it('refuses a banned token ATTACHED to its value, not just standing alone', async () => {
    const ctx = harness()
    const result = expectFailure(await deliver(ctx, {
      deps: { ...ctx.deps, buildArgs: () => ['--permission-mode=bypassPermissions'] },
    }))
    expect(result.reason).toBe('unsupported_policy')
    expect(ctx.spawns).toHaveLength(0)
  })

  it('refuses when the argv builder itself throws', async () => {
    const ctx = harness()
    const result = expectFailure(await deliver(ctx, {
      deps: { ...ctx.deps, buildArgs: () => { throw new Error('boom') } },
    }))
    expect(result.delivery).toBe('not_attempted')
    expect(ctx.spawns).toHaveLength(0)
  })

  it('still spawns for a clean injected argv, so the guard is not refusing everything', async () => {
    // Paired with the refusal cases above: without this, making the guard reject
    // EVERY argv would leave all of them green.
    const ctx = harness({ script: succeedWith(TARGET) })
    await deliver(ctx, { deps: { ...ctx.deps, buildArgs: () => ['--resume', TARGET, '-p'] } })
    expect(ctx.spawns).toHaveLength(1)
  })

  it('catches a banned flag standing alone', () => {
    for (const banned of BANNED_PERMISSION_ARGS) {
      expect(findBannedPermissionArg(['--resume', 'x', banned])).toBe(banned)
    }
  })

  it('catches a banned token ATTACHED to its value', () => {
    // The case an equality check waves through while looking correct.
    expect(findBannedPermissionArg(['--permission-mode=bypassPermissions'])).toBe('bypassPermissions')
    expect(findBannedPermissionArg(['--sandbox=danger-full-access'])).toBe('danger-full-access')
  })

  it('passes a clean argv', () => {
    expect(findBannedPermissionArg(['--resume', 'abc', '-p', '--permission-mode', 'plan'])).toBeNull()
    expect(findBannedPermissionArg([])).toBeNull()
  })

  it('the argv this build actually produces is clean, for all three providers', () => {
    const id = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
    expect(findBannedPermissionArg(buildClaudeAttachedArgs(id))).toBeNull()
    expect(findBannedPermissionArg(buildCodexAttachedArgs(id, '/tmp'))).toBeNull()
    expect(findBannedPermissionArg(buildCodexAttachedArgs(id, '/tmp/path-with--force-in-it'))).toBeNull()
    expect(findBannedPermissionArg(buildCursorAttachedArgs(id, '/tmp/path-with--force-in-it'))).toBeNull()
    const cursorArgs = buildCursorAttachedArgs(id, '/tmp')
    expect(cursorArgs).toContain('--mode')
    expect(cursorArgs).toContain('ask')
    expect(cursorArgs).toContain('--resume')
    expect(cursorArgs).not.toContain('--force')
  })

  it('does not treat a --workspace value containing --force as a banned flag', () => {
    expect(findBannedPermissionArg([
      '-p', '--mode', 'ask', '--workspace', '/tmp/repo--force-clone', '--resume', 'x',
    ])).toBeNull()
  })

  it('ignores COS_CODEX_EXTRA_ARGS on attached continue argv', () => {
    process.env.COS_CODEX_EXTRA_ARGS = '--oss --local-provider ollama --model qwen2.5-coder'
    const id = 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d'
    expect(buildCodexAttachedArgs(id, '/tmp/workspace')).toEqual([
      'exec',
      '--sandbox', 'read-only',
      '--cd', '/tmp/workspace',
      'resume',
      '--json',
      '--skip-git-repo-check',
      id,
      '-',
    ])
    delete process.env.COS_CODEX_EXTRA_ARGS
  })
})

describe('a continued turn inherits the session posture, and the bypass ban survives it', () => {
  // COST OF NOT HAVING THIS: the previous read-only posture (--permission-mode
  // plan plus an empty --tools/--allowedTools pair) was documented at length as a
  // safety property and had NO test asserting it was present. The only assertion
  // touching this argv checked the bypass ban. It could have been deleted silently
  // at any point, and when it was deliberately removed nothing went red.
  it('resumes without forcing a stricter posture than the session has', () => {
    // Miles, 2026-08-16, explicit: a continued turn should run with the normal
    // permissions of the session. A forced read-only turn could talk into a thread
    // and do nothing in it.
    const args = buildClaudeAttachedArgs('a4b2b4dd-e40c-4b08-8a11-c89a018c197d')
    expect(args).toContain('--resume')
    expect(args).not.toContain('--permission-mode')
    expect(args).not.toContain('--allowedTools')
    expect(args).not.toContain('--tools')
  })

  it('still refuses every real bypass, which is a different thing', () => {
    // Dropping a lockdown is not adding a bypass. This guard is what keeps that
    // true, and it runs at the spawn boundary.
    for (const bypass of [
      '--dangerously-skip-permissions',
      '--dangerously-bypass-approvals-and-sandbox',
      '--yolo',
      '--full-auto',
      'danger-full-access',
      'bypassPermissions',
    ]) {
      expect(findBannedPermissionArg(['-p', bypass]), bypass).not.toBeNull()
    }
  })

  it('keeps the prompt out of argv, which ps exposes to every local user', () => {
    const args = buildClaudeAttachedArgs('a4b2b4dd-e40c-4b08-8a11-c89a018c197d')
    expect(args.join(' ')).not.toContain('stdin')
    expect(args.some(a => a.length > 100)).toBe(false)
  })

  it('the clean argv passes its own ban check', () => {
    expect(findBannedPermissionArg(buildClaudeAttachedArgs('a4b2b4dd-e40c-4b08-8a11-c89a018c197d'))).toBeNull()
  })
})

describe('reaping is reported, never derived', () => {
  // A signal-killed child reports `code === null`, and the handlers only assign
  // `exitCode` for a numeric code. So a consumer deriving "was it reaped" from
  // `exitCode` reports NEVER REAPED for the dominant timeout shape — the exact
  // case a reader most needs to identify. The adapter therefore says so itself.

  it('reports reaped on a signal death, where exitCode stays null', async () => {
    const ctx = harness({
      script: (child) => {
        child.emitStdout(claudeLine(FORKED))
        child.close(null)          // SIGTERM/SIGKILL: no numeric code
      },
    })
    const result = expectFailure(await deliver(ctx, {}))
    expect(result.exitCode).toBeNull()
    // Derived-from-exitCode would be false here. That is the regression.
    expect(result.reaped).toBe(true)
  })

  it('reports reaped on an ordinary non-zero exit', async () => {
    const ctx = harness({ script: (child) => { child.close(3) } })
    const result = expectFailure(await deliver(ctx, {}))
    expect(result.exitCode).toBe(3)
    expect(result.reaped).toBe(true)
  })
})
